import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import MiniPlayer from './MiniPlayer.jsx';

/* The mini player is a second BrowserWindow loading this same bundle with a
 * `#mini` hash (see miniWindow.js). Routing here rather than adding a second
 * Vite entry keeps forge.config.cjs and the Vite renderer config untouched —
 * one bundle, one build, two windows. */
const isMini = typeof window !== 'undefined' && window.location.hash === '#mini';

/* index.html paints the body solid black, which is right for the main window
 * and wrong for a transparent one — it fills the corners back in and squares
 * off the radius. MiniPlayer also clears this in an effect, but effects run
 * AFTER first paint, so doing it here too avoids a black rectangle flashing
 * on screen for a frame every time the mini opens. */
if (isMini) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  document.body.style.overflow = 'hidden';
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isMini ? <MiniPlayer /> : <App />}
  </React.StrictMode>
);
