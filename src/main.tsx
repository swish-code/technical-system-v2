import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {unlockAudio} from './lib/audio';

console.log("Main.tsx is executing...");

// Unlock the notification-sound AudioContext on the first user interaction.
// Browsers keep it suspended until resumed during a gesture; without this,
// notification/alarm sounds (which fire from WebSocket events, not clicks)
// stay silent. Once unlocked, the listeners remove themselves.
const unlockOnce = () => {
  unlockAudio();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
  window.removeEventListener('touchstart', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
window.addEventListener('touchstart', unlockOnce);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
