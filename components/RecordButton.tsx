import React from 'react';
import { AssistantState } from '../types';

interface RecordButtonProps {
  state: AssistantState;
  isConversationActive: boolean;
  onClick: () => void;
}

const MicIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-8 w-8">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" fill="currentColor"/>
  </svg>
);

const HangUpIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className="h-8 w-8">
        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24c1.12.37 2.33.57 3.57.57c.55 0 1 .45 1 1V20c0 .55-.45 1-1 1c-9.39 0-17-7.61-17-17c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1c0 1.25.2 2.45.57 3.57c.11.35.03.74-.25 1.02l-2.2 2.2z"/>
    </svg>
);


const LoadingSpinner = () => (
    <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

export const RecordButton: React.FC<RecordButtonProps> = ({ state, isConversationActive, onClick }) => {
  const baseClasses = "relative rounded-full h-24 w-24 flex items-center justify-center transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-opacity-50 shadow-lg";
  
  const isProcessing = state === AssistantState.PROCESSING;

  if (!isConversationActive) {
      return (
        <button onClick={onClick} className={`${baseClasses} bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-400`} aria-label="Start conversation">
            <MicIcon />
        </button>
      );
  }

  return (
    <button onClick={onClick} className={`${baseClasses} bg-red-600 hover:bg-red-700 text-white focus:ring-red-400`} disabled={isProcessing} aria-label="End conversation">
      {isProcessing ? <LoadingSpinner /> : <HangUpIcon />}
    </button>
  );
};