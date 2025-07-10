
import { GoogleGenAI, Modality } from "@google/genai";

if (!process.env.API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface GeminiLiveCallbacks {
    onOpen?: () => void;
    onClose?: (e: CloseEvent) => void;
    onError?: (e: Event) => void;
    onTranscript?: (transcript: string, isFinal: boolean) => void;
    onAudio?: (audioData: string) => void; // base64 string
    onTurnComplete?: () => void;
}

let session: any | null = null;

export const startGeminiLiveSession = async (callbacks: GeminiLiveCallbacks): Promise<void> => {
    if (session) {
        console.log("Session already active.");
        return;
    }

    // Native audio output model
    const model = "gemini-2.0-flash-live-001";
    const config = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: "You are a helpful assistant and answer in a friendly tone."
    };

    try {
        session = await ai.live.connect({
            model: model,
            config: config,
            callbacks: {
                onopen: () => {
                    console.debug('Gemini Live session opened.');
                    callbacks.onOpen?.();
                },
                onclose: (e: CloseEvent) => {
                    console.debug('Gemini Live session closed:', e.reason);
                    callbacks.onClose?.(e);
                    session = null;
                },
                onerror: (e: Event) => {
                    console.error('Gemini Live error:', (e as any).message);
                    callbacks.onError?.(e);
                    session = null;
                },
                onmessage: (message: any) => {
                    if (message.serverContent) {
                        if (message.serverContent.speechToTextResult) {
                            callbacks.onTranscript?.(
                                message.serverContent.speechToTextResult.text,
                                message.serverContent.speechToTextResult.isFinal
                            );
                        }
                        if (message.serverContent.turnComplete) {
                            callbacks.onTurnComplete?.();
                        }
                    }
                    if (message.data) {
                        callbacks.onAudio?.(message.data);
                    }
                },
            },
        });
    } catch (error) {
        console.error("Failed to start Gemini Live session:", error);
        throw error;
    }
};

export const sendAudioToGemini = (audioData: string) => {
    if (!session || session.isClosed) {
        // console.warn("Cannot send audio, session is not active.");
        return;
    }
    session.sendRealtimeInput({
        audio: {
            data: audioData,
            mimeType: "audio/pcm;rate=16000"
        }
    });
};

export const closeGeminiLiveSession = () => {
    if (session && !session.isClosed) {
        session.close();
        session = null;
    }
};
