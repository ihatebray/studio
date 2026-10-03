/* =========================================================================
 *  studio — where Studio keeps its data, and one Studio at a time
 *
 *  Imported first by main.js, so it runs before anything reads the data
 *  folder.
 *
 *  Settings, the "set up already" flag and fonts live in the window's own
 *  storage (localStorage, IndexedDB) inside the data folder, and only one
 *  running copy can open that storage. A second copy, started while the
 *  first was still open, got an empty, throwaway storage instead: it showed
 *  onboarding again and nothing changed in it was kept.
 *
 *  - The development build (npm start) gets its own folder, studio-dev, so
 *    it can run beside the installed app. The first time, it starts as a
 *    copy of the installed app's folder (library, sign-ins, settings),
 *    leaving out caches and downloaded audio, which stays where it is and
 *    still plays (the library stores full paths).
 *  - Opening Studio while it's already running brings the open window to
 *    the front instead of starting a second copy (see main.js).
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/* Big, rebuildable or per-run: not worth copying. Relative to the folder. */
const SKIP = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|blob_storage|Shared Dictionary|streaming-imports|spotify-player[\\/]files)$|(^|[\\/])(LOCK|lockfile|Singleton\w*)$/;

function copyDir(from, to, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (SKIP.test(r)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) copyDir(src, dst, r);
      else if (entry.isFile()) fs.copyFileSync(src, dst);
    } catch (e) {
      // In use by a running Studio, usually: that one file starts fresh.
      console.warn('[studio-dev] couldn’t copy', r, String(e?.code || e?.message || e));
    }
  }
}

if (!app.isPackaged) {
  const installed = app.getPath('userData');
  const dev = path.join(app.getPath('appData'), 'studio-dev');
  if (!fs.existsSync(dev) && fs.existsSync(installed)) {
    console.log('[studio-dev] first run: copying', installed, '→', dev);
    try { copyDir(installed, dev); } catch (e) { console.warn('[studio-dev] copy failed:', String(e?.message || e)); }
  }
  app.setPath('userData', dev);
}

/** False when another Studio already has this data folder open. */
export const isFirstInstance = app.requestSingleInstanceLock();
