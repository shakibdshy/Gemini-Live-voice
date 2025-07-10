
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AssistantState } from './types';
import { RecordButton } from './components/RecordButton';
import { Waveform } from './components/Waveform';
import { startGeminiLiveSession, closeGeminiLiveSession, sendAudioToGemini } from './services/geminiService';

// Audio constants
const TARGET_SAMPLE_RATE = 16000;
const PLAYER_SAMPLE_RATE = 24000;
// Voice Activity Detection threshold. A higher value requires louder speech to interrupt.
const VAD_THRESHOLD = 0.02;

// Helper to convert Base64 to an ArrayBuffer
const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

export default function App() {
  const [assistantState, setAssistantState] = useState<AssistantState>(AssistantState.IDLE);
  const [userTranscript, setUserTranscript] = useState('');
  const [geminiResponse, setGeminiResponse] = useState(''); // Used for status messages
  const [error, setError] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<any[]>([]);
  const [toolResponses, setToolResponses] = useState<string[]>([]);
  const [isUsingTools, setIsUsingTools] = useState(false);
  const [ledgerData, setLedgerData] = useState<any>(null);

  // Audio recording refs
  const recorderAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);

  // Audio playback refs
  const playerAudioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const currentPlayerSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const geminiResponseContainerRef = useRef<HTMLDivElement>(null);
  
  // Use a ref to access the latest state inside callbacks without re-creating them
  const stateRef = useRef(assistantState);
  useEffect(() => {
    stateRef.current = assistantState;
  }, [assistantState]);


  // Stop playback immediately (for interruption)
  const stopPlayback = useCallback(() => {
    if (currentPlayerSourceRef.current) {
        currentPlayerSourceRef.current.onended = null; // Prevent onended from firing and calling playNextInQueue
        try {
            currentPlayerSourceRef.current.stop(0);
        } catch (e) {
            console.warn("Could not stop audio source", e);
        }
        currentPlayerSourceRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
  }, []);

  // Stop everything and clean up
  const endConversation = useCallback(() => {
    setAssistantState(AssistantState.IDLE);
    setUserTranscript('');
    setGeminiResponse('');
    setError(null);
    setToolCalls([]);
    setToolResponses([]);
    setIsUsingTools(false);
    setLedgerData(null);

    // Stop recording
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    if (recorderAudioContextRef.current && recorderAudioContextRef.current.state !== 'closed') {
        recorderAudioContextRef.current.close();
        recorderAudioContextRef.current = null;
    }
    
    // Stop playback
    stopPlayback();
    if (playerAudioContextRef.current && playerAudioContextRef.current.state !== 'closed') {
        playerAudioContextRef.current.close();
    }
    playerAudioContextRef.current = null;
    
    closeGeminiLiveSession();
  }, [stopPlayback]);

  // Playback Logic: Plays audio chunks from a queue
  const playNextInQueue = useCallback(() => {
    if (audioQueueRef.current.length === 0 || !playerAudioContextRef.current) {
      isPlayingRef.current = false;
      // After Gemini finishes speaking, go back to listening
      if(stateRef.current === AssistantState.SPEAKING) {
        setAssistantState(AssistantState.LISTENING);
        setGeminiResponse('Listening...');
      }
      return;
    }
    
    isPlayingRef.current = true;
    const buffer = audioQueueRef.current.shift()!;
    const source = playerAudioContextRef.current.createBufferSource();
    currentPlayerSourceRef.current = source; // Keep track of the current source
    source.buffer = buffer;
    source.connect(playerAudioContextRef.current.destination);
    
    const playTime = Math.max(playerAudioContextRef.current.currentTime, nextPlayTimeRef.current);
    source.start(playTime);
    nextPlayTimeRef.current = playTime + buffer.duration;
    
    source.onended = () => {
        if (currentPlayerSourceRef.current === source) {
            currentPlayerSourceRef.current = null; // Clear ref only if it's the one that ended
            playNextInQueue();
        }
    };
  }, []);

  // Playback Logic: Decodes and queues an audio chunk
  const addAudioChunkToQueue = useCallback(async (base64Chunk: string) => {
    // Do not queue audio if we are not in a speaking state (e.g., after an interruption)
    if (stateRef.current !== AssistantState.SPEAKING) return;
    if (!playerAudioContextRef.current) return;

    try {
        const arrayBuffer = base64ToArrayBuffer(base64Chunk);
        const pcm16 = new Int16Array(arrayBuffer);
        const pcm32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
            pcm32[i] = pcm16[i] / 32767.0; // Convert Int16 to Float32 range [-1, 1]
        }

        const audioBuffer = playerAudioContextRef.current.createBuffer(1, pcm32.length, PLAYER_SAMPLE_RATE);
        audioBuffer.copyToChannel(pcm32, 0);

        audioQueueRef.current.push(audioBuffer);
        if (!isPlayingRef.current) {
            playNextInQueue();
        }
    } catch (e) {
        console.error("Error processing audio chunk for playback:", e);
    }
  }, [playNextInQueue]);

  // Callback ref for the interrupt handler to avoid stale closures in processAudio
const interruptCallbackRef = useRef<() => void>(() => {});
  
  useEffect(() => {
      // Define the interrupt handler using the latest state setters
      const handleInterrupt = () => {
          if (stateRef.current === AssistantState.SPEAKING) {
              stopPlayback();
              setAssistantState(AssistantState.LISTENING);
              setGeminiResponse('Listening...');
          }
      };
      // Keep the ref updated with the latest handler
      interruptCallbackRef.current = handleInterrupt;
  }, [stopPlayback]);


  // Recording Logic: Processes raw audio, downsamples, and sends to Gemini
  const processAudio = useCallback((e: AudioProcessingEvent) => {
    const inputData = e.inputBuffer.getChannelData(0);
    const inputSampleRate = e.inputBuffer.sampleRate;

    // Downsample to 16kHz
    const sampleRateRatio = inputSampleRate / TARGET_SAMPLE_RATE;
    const newLength = Math.round(inputData.length / sampleRateRatio);
    const downsampled = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < downsampled.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputData.length; i++) {
            accum += inputData[i];
            count++;
        }
        downsampled[offsetResult] = accum / count;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }

    // --- Voice Activity Detection for Interruption ---
    let sumSquares = 0.0;
    for (const sample of downsampled) {
        sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / downsampled.length);

    // If user speaks while assistant is speaking, trigger interrupt
    if (stateRef.current === AssistantState.SPEAKING && rms > VAD_THRESHOLD) {
        console.log("--- INTERRUPT DETECTED (RMS: " + rms.toFixed(4) + ") ---");
        interruptCallbackRef.current?.();
    }
    // --- End VAD ---

    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
        const s = Math.max(-1, Math.min(1, downsampled[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    let binary = '';
    const bytes = new Uint8Array(pcm16.buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    
    sendAudioToGemini(window.btoa(binary));
  }, []);

  const startRecording = useCallback(async () => {
    try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        const context = new (window.AudioContext || window.webkitAudioContext)();
        recorderAudioContextRef.current = context;
        
        const source = context.createMediaStreamSource(streamRef.current);
        // Using a larger buffer size can sometimes reduce choppiness.
        const processor = context.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        
        const analyser = context.createAnalyser();
        analyserNodeRef.current = analyser;
        
        source.connect(analyser);
        analyser.connect(processor);
        // Do NOT connect processor to destination, to avoid hearing your own voice.
        processor.connect(context.destination);
        processor.onaudioprocess = processAudio;

    } catch (err) {
        console.error("Error starting audio recording:", err);
        setError("Microphone access is required. Please grant permission and refresh.");
        endConversation();
    }
  }, [processAudio, endConversation]);


  // Main Conversation Flow
  const startConversation = useCallback(async () => {
    setAssistantState(AssistantState.PROCESSING);
    setError(null);
    setUserTranscript('');
    setGeminiResponse('Connecting...');

    const pAC = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PLAYER_SAMPLE_RATE });
    playerAudioContextRef.current = pAC;
    if (pAC.state === 'suspended') {
        await pAC.resume();
    }
    nextPlayTimeRef.current = 0;

    startGeminiLiveSession({
      onOpen: () => {
        setGeminiResponse('Connected. Listening...')
        setAssistantState(AssistantState.LISTENING);
        startRecording();
      },
      onError: () => {
        setError("A connection error occurred.");
        endConversation();
      },
      onTranscript: (text) => {
        setUserTranscript(text);
        // When user is speaking, clear any status message from Gemini
        if(text.trim()){
            setGeminiResponse('');
        }
      },
      onAudio: (audioData) => {
        // First audio chunk for a new response
        if (stateRef.current === AssistantState.LISTENING) {
            setAssistantState(AssistantState.SPEAKING);
            setGeminiResponse('Speaking...');
        }
        addAudioChunkToQueue(audioData);
      },
      onToolCall: (toolCall) => {
        setIsUsingTools(true);
        setToolCalls(prev => [...prev, toolCall]);
        setGeminiResponse('Using financial tools...');
      },
      onToolResponse: (response) => {
        setToolResponses(prev => [...prev, response]);
        setIsUsingTools(false);
        
        // Parse and extract ledger data if it's a general ledger report
        try {
          const parsedResponse = JSON.parse(response.replace('Tool fetch_general_ledger_report executed: ', ''));
          if (parsedResponse.report_type === 'General Ledger Report' && parsedResponse.entries) {
            setLedgerData(parsedResponse);
          }
        } catch (e) {
          // Not a JSON response or not ledger data, ignore
        }
      },
    }).catch(e => {
        setError("Could not connect to the service.");
        endConversation();
    });

  }, [startRecording, endConversation, addAudioChunkToQueue]);

  const handleToggleConversation = useCallback(() => {
    if (assistantState === AssistantState.IDLE) {
      startConversation();
    } else {
      endConversation();
    }
  }, [assistantState, startConversation, endConversation]);
  
  const isConversationActive = assistantState !== AssistantState.IDLE;
  
  // Effect to auto-scroll the Gemini response
  useEffect(() => {
    if (geminiResponseContainerRef.current) {
        geminiResponseContainerRef.current.scrollTop = geminiResponseContainerRef.current.scrollHeight;
    }
  }, [geminiResponse]);

  return (
    <div className="flex flex-col items-center justify-between min-h-screen w-full bg-gray-900 text-gray-100 p-4 md:p-8">
      <header className="w-full max-w-4xl text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-white">FM & Accounting Assistant</h1>
        <p className="text-lg text-gray-400 mt-2">Your AI-powered Financial Management and Accounting Assistant with advanced calculation tools.</p>
      </header>
      
      <main className="flex flex-col items-center justify-center w-full max-w-4xl flex-grow my-8 space-y-6">
        <div className="w-full h-48 bg-gray-800/50 rounded-lg p-4 overflow-y-auto border border-gray-700 shadow-inner">
            <p className="text-gray-400 italic">You said:</p>
            <p className="text-lg">{userTranscript || '...'}</p>
        </div>
        <div ref={geminiResponseContainerRef} className="w-full h-48 bg-gray-800/50 rounded-lg p-4 overflow-y-auto border border-gray-700 shadow-inner">
            <p className="text-blue-400 italic">Assistant says:</p>
            <p className="text-lg whitespace-pre-wrap">{geminiResponse || '...'}</p>
            {isUsingTools && (
              <div className="mt-2 flex items-center text-yellow-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-400 mr-2"></div>
                <span className="text-sm">Processing with financial tools...</span>
              </div>
            )}
        </div>
        
        {/* General Ledger Report Table */}
        {ledgerData && ledgerData.entries && (
          <div className="w-full bg-blue-900/20 border border-blue-500/30 rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-blue-400 font-semibold flex items-center">
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" clipRule="evenodd" />
                </svg>
                {ledgerData.report_type}
              </h3>
              <button 
                onClick={() => setLedgerData(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
            
            <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="bg-gray-800/50 rounded p-3">
                <p className="text-gray-400">Total Entries</p>
                <p className="text-white font-semibold">{ledgerData.total_entries}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-3">
                <p className="text-gray-400">Date Range</p>
                <p className="text-white font-semibold">{ledgerData.date_range.from} - {ledgerData.date_range.to}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-3">
                <p className="text-gray-400">Account Filter</p>
                <p className="text-white font-semibold">{ledgerData.account_filter}</p>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-600">
                    <th className="text-left py-2 px-3 text-gray-300">Date</th>
                    <th className="text-left py-2 px-3 text-gray-300">Account</th>
                    <th className="text-right py-2 px-3 text-gray-300">Debit</th>
                    <th className="text-right py-2 px-3 text-gray-300">Credit</th>
                    <th className="text-right py-2 px-3 text-gray-300">Balance</th>
                    <th className="text-left py-2 px-3 text-gray-300">Voucher Type</th>
                    <th className="text-left py-2 px-3 text-gray-300">Voucher No</th>
                  </tr>
                </thead>
                <tbody className="max-h-64 overflow-y-auto">
                  {ledgerData.entries.map((entry: any, index: number) => (
                    <tr key={index} className="border-b border-gray-700/50 hover:bg-gray-800/30">
                      <td className="py-2 px-3 text-gray-200">{entry.postingDate}</td>
                      <td className="py-2 px-3 text-gray-200">{entry.account}</td>
                      <td className="py-2 px-3 text-right text-green-400">${entry.debit}</td>
                      <td className="py-2 px-3 text-right text-red-400">${entry.credit}</td>
                      <td className="py-2 px-3 text-right text-blue-400">${entry.balance}</td>
                      <td className="py-2 px-3 text-gray-200">{entry.voucherType}</td>
                      <td className="py-2 px-3 text-gray-200">{entry.voucherNo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {ledgerData.summary && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm border-t border-gray-600 pt-4">
                <div className="bg-green-900/20 border border-green-500/30 rounded p-3">
                  <p className="text-green-400">Total Debits</p>
                  <p className="text-white font-semibold">${ledgerData.summary.total_debits}</p>
                </div>
                <div className="bg-red-900/20 border border-red-500/30 rounded p-3">
                  <p className="text-red-400">Total Credits</p>
                  <p className="text-white font-semibold">${ledgerData.summary.total_credits}</p>
                </div>
                <div className="bg-blue-900/20 border border-blue-500/30 rounded p-3">
                  <p className="text-blue-400">Net Balance</p>
                  <p className="text-white font-semibold">${ledgerData.summary.net_balance}</p>
                </div>
              </div>
            )}
          </div>
        )}
        
        {/* Tool Activity Panel */}
        {(toolCalls.length > 0 || toolResponses.length > 0) && (
          <div className="w-full bg-green-900/20 border border-green-500/30 rounded-lg p-4">
            <h3 className="text-green-400 font-semibold mb-2 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              Financial Tools Activity
            </h3>
            
            {toolCalls.length > 0 && (
              <div className="mb-3">
                <p className="text-sm text-gray-300 mb-1">Tools Used:</p>
                {toolCalls.map((toolCall, index) => (
                  <div key={index} className="text-sm bg-gray-800/50 rounded p-2 mb-1">
                    {toolCall.functionCalls?.map((fc: any, fcIndex: number) => (
                      <div key={fcIndex} className="text-green-300">
                        📊 {fc.name.replace(/_/g, ' ').toUpperCase()}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            
            {toolResponses.length > 0 && !ledgerData && (
              <div>
                <p className="text-sm text-gray-300 mb-1">Latest Calculation:</p>
                <div className="text-xs bg-gray-800/50 rounded p-2 max-h-32 overflow-y-auto">
                  <pre className="text-green-200 whitespace-pre-wrap">{toolResponses[toolResponses.length - 1]}</pre>
                </div>
              </div>
            )}
          </div>
        )}
        
        {error && <div className="bg-red-500/20 border border-red-500 text-red-300 p-3 rounded-lg text-center">{error}</div>}
      </main>

      <footer className="flex flex-col items-center justify-center w-full space-y-4">
        <Waveform analyserNode={analyserNodeRef.current} isActive={assistantState === AssistantState.LISTENING} />
        <RecordButton state={assistantState} isConversationActive={isConversationActive} onClick={handleToggleConversation} />
      </footer>
    </div>
  );
}
