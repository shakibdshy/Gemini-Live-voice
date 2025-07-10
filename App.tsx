
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
        <h1 className="text-4xl md:text-5xl font-bold text-white">Gemini Live</h1>
        <p className="text-lg text-gray-400 mt-2">Click the mic to start a live conversation with Gemini.</p>
      </header>
      
      <main className="flex flex-col items-center justify-center w-full max-w-4xl flex-grow my-8 space-y-6">
        <div className="w-full h-48 bg-gray-800/50 rounded-lg p-4 overflow-y-auto border border-gray-700 shadow-inner">
            <p className="text-gray-400 italic">You said:</p>
            <p className="text-lg">{userTranscript || '...'}</p>
        </div>
        <div ref={geminiResponseContainerRef} className="w-full h-48 bg-gray-800/50 rounded-lg p-4 overflow-y-auto border border-gray-700 shadow-inner">
            <p className="text-blue-400 italic">Gemini says:</p>
            <p className="text-lg whitespace-pre-wrap">{geminiResponse || '...'}</p>
        </div>
        {error && <div className="bg-red-500/20 border border-red-500 text-red-300 p-3 rounded-lg text-center">{error}</div>}
      </main>

      <footer className="flex flex-col items-center justify-center w-full space-y-4">
        <Waveform analyserNode={analyserNodeRef.current} isActive={assistantState === AssistantState.LISTENING} />
        <RecordButton state={assistantState} isConversationActive={isConversationActive} onClick={handleToggleConversation} />
      </footer>
    </div>
  );
}
