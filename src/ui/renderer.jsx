import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import PlaylistWindow from './PlaylistWindow.jsx';
import '../lib/autoHideScrollbars.js';
import { setThemeAnalyzer } from '../lib/coverTheme.js';
import { analyzeOffThread } from '../lib/coverThemeWorker.js';

// Cover palettes are worked out on their own thread (coverTheme.worker.js).
setThemeAnalyzer(analyzeOffThread);

/* A playlist popped out into its own window loads this same page with
   ?plwin=<its key> (playlistWindows.js), and shows just that playlist. */
const plwin = new URLSearchParams(window.location.search).get('plwin');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {plwin ? <PlaylistWindow wkey={plwin} /> : <App />}
  </React.StrictMode>
);
