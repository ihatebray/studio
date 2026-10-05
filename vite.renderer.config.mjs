import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build — plain React SPA served by the forge vite plugin in dev
// and emitted to .vite/renderer/main_window in packaged builds.
export default defineConfig({
  plugins: [react()],
  // Electron 28 ships Chromium 120: build for exactly that, rather than
  // down-levelling modern syntax for browsers the app never runs in.
  build: { target: 'chrome120' },
});
