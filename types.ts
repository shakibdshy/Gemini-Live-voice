export enum AssistantState {
  IDLE,
  LISTENING,
  PROCESSING,
  SPEAKING,
}

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}