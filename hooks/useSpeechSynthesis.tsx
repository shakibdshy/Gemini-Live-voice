
import { useState, useCallback, useEffect } from 'react';

export const useSpeechSynthesis = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const handleVoicesChanged = () => {
      setVoices(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
    handleVoicesChanged(); // Initial load
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      window.speechSynthesis.cancel();
    };
  }, []);

  const speak = useCallback((text: string) => {
    if (!text || !window.speechSynthesis) return;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // Select a preferred voice
    const preferredVoice = voices.find(voice => voice.name.includes('Google') && voice.lang.startsWith('en'));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    } else if (voices.length > 0) {
        const enVoice = voices.find(voice => voice.lang.startsWith('en'));
        utterance.voice = enVoice || voices[0];
    }
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    
    // Define the interface for the error event to access its properties
    interface SpeechSynthesisErrorEvent extends Event {
        readonly error: string;
    }

    utterance.onerror = (e) => {
      const errorEvent = e as SpeechSynthesisErrorEvent;
      console.error('Speech synthesis error:', errorEvent.error);
      setIsSpeaking(false);
    };

    window.speechSynthesis.speak(utterance);
  }, [voices]);

  const cancel = useCallback(() => {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  return { isSpeaking, speak, cancel, hasSynthesisSupport: typeof window.speechSynthesis !== 'undefined' };
};
