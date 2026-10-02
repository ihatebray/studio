import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build — plain React SPA served by the forge vite plugin in dev
// and emitted to .vite/renderer/main_window in packaged builds.
export default defineConfig({
  /* compact: false — StudioHome.jsx is over Babel's 500KB "compact" cutoff,
     which only prints a note and minifies the dev output. Splitting that
     file is the real fix (see the cleanup plan); until then, keep Babel
     quiet and its output readable. */
  plugins: [react({ babel: { compact: false } })],
});
