/* Starts the palette worker (coverTheme.worker.js) and hands it covers.
 * Registered with coverTheme.js by the app's entry point, so the worker file
 * itself can import coverTheme.js without importing itself. If a worker
 * can't be started, analyze() rejects and coverTheme.js does the work on
 * the page's thread as before, just a moment later. */
import PaletteWorker from './coverTheme.worker.js?worker&inline';

let worker = null;
let broken = false;
let nextId = 1;
const pending = new Map(); // id → { resolve, reject }

function start() {
  if (worker || broken) return worker;
  try {
    worker = new PaletteWorker();
    worker.onmessage = (e) => {
      const { id, theme, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (theme) p.resolve(theme); else p.reject(new Error(error || 'palette failed'));
    };
    worker.onerror = (e) => {
      // A worker that can't run: everything waiting goes back to the page thread.
      broken = true;
      worker = null;
      for (const p of pending.values()) p.reject(new Error(e?.message || 'palette worker failed'));
      pending.clear();
    };
  } catch {
    broken = true;
    worker = null;
  }
  return worker;
}

/** Analyze RGB triplets (Uint8Array, r,g,b,r,g,b…) off the page's thread. */
export function analyzeOffThread(rgb) {
  const w = start();
  if (!w) return Promise.reject(new Error('no palette worker'));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, rgb }, [rgb.buffer]);
  });
}
