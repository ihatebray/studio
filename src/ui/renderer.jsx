import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import '../lib/autoHideScrollbars.js';
import { setThemeAnalyzer } from '../lib/coverTheme.js';
import { analyzeOffThread } from '../lib/coverThemeWorker.js';

// Cover palettes are worked out on their own thread (coverTheme.worker.js).
setThemeAnalyzer(analyzeOffThread);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
