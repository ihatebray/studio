/* =========================================================================
 *  studio — updates from GitHub Releases
 *
 *  A release is a GitHub Release on ihatebray/studio, tagged with the
 *  version (v0.0.2) and made by `npm run publish` (see RELEASING.md). Studio
 *  looks at the latest one shortly after launch and then every hour:
 *
 *  - Installed on Windows (studio-Setup.exe): the update downloads in the
 *    background through Squirrel, the installer's own updater, using
 *    update.electronjs.org (Electron's free update service for public
 *    GitHub repos). Once it's down, a notification offers "Restart to
 *    update", which swaps the files and opens the new version.
 *  - Anywhere else (macOS, Linux, the zip build): the notification links to
 *    the release page to download it, since those builds can't replace
 *    themselves.
 *  - Running from source (npm start): never checks.
 *
 *  Status goes to the window on 'update:status':
 *    { state, current, version, notes, url, error, checkedAt, canInstall }
 *  state: idle | checking | none | downloading | ready | available | error
 *    ready      downloaded, "Restart to update" installs it
 *    available  newer release exists, but this build can only open its page
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app, autoUpdater, BrowserWindow, ipcMain, net, shell } from 'electron';

const REPO = 'ihatebray/studio';
const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
/* update.electronjs.org can take a few minutes to see a new release. */
const RETRY_SOON_MS = 10 * 60 * 1000;

let status = {
  state: 'idle', current: app.getVersion(), version: '', notes: '', url: '', error: '', checkedAt: 0, canInstall: false,
};
let squirrelReady = false;
let retryTimer = null;

function emit(patch) {
  status = { ...status, ...patch };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('update:status', status); } catch { /* closing */ }
  }
}

/** Installed by studio-Setup.exe, so Squirrel's Update.exe sits beside the app folder. */
function installedBySquirrel() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  try { return fs.existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe')); } catch { return false; }
}

/** [0, 1, 10] from "v0.1.10"; anything after - or + is ignored. */
function parts(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** The newest published (not draft, not pre-release) release, or null. */
async function latestRelease() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'studio-app' },
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const j = await res.json();
  return {
    version: String(j.tag_name || '').replace(/^v/i, ''),
    notes: String(j.body || ''),
    url: String(j.html_url || `https://github.com/${REPO}/releases/latest`),
  };
}

function setupSquirrel() {
  if (squirrelReady) return;
  squirrelReady = true;
  autoUpdater.setFeedURL({ url: `https://update.electronjs.org/${REPO}/${process.platform}-${process.arch}/${app.getVersion()}` });
  autoUpdater.on('update-downloaded', (_e, releaseNotes, releaseName) => {
    emit({ state: 'ready', canInstall: true, version: status.version || String(releaseName || '').replace(/^v/i, ''), error: '' });
  });
  autoUpdater.on('update-not-available', () => {
    // GitHub has the release but the update service hasn't caught up yet.
    if (status.state === 'downloading') {
      emit({ state: 'none' });
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { check().catch(() => {}); }, RETRY_SOON_MS);
    }
  });
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', String(err?.message || err));
    if (status.state === 'downloading') emit({ state: 'error', error: 'The update couldn’t download. Studio will try again later.' });
  });
}

export async function check() {
  if (!app.isPackaged) { emit({ state: 'none', checkedAt: Date.now() }); return status; }
  // Already have it, or getting it: nothing to look up.
  if (status.state === 'ready' || status.state === 'downloading') return status;
  emit({ state: 'checking', error: '' });
  let latest;
  try {
    latest = await latestRelease();
  } catch (e) {
    emit({ state: 'error', error: 'Couldn’t reach GitHub to check for updates.', checkedAt: Date.now() });
    console.warn('[updater] check failed:', String(e?.message || e));
    return status;
  }
  if (!latest || !isNewer(latest.version, app.getVersion())) {
    emit({ state: 'none', checkedAt: Date.now() });
    return status;
  }
  const info = { version: latest.version, notes: latest.notes, url: latest.url, checkedAt: Date.now() };
  if (installedBySquirrel()) {
    setupSquirrel();
    emit({ ...info, state: 'downloading', canInstall: true });
    try { autoUpdater.checkForUpdates(); } catch (e) {
      emit({ state: 'error', error: 'The update couldn’t download. Studio will try again later.' });
      console.warn('[updater] checkForUpdates threw:', String(e?.message || e));
    }
  } else {
    emit({ ...info, state: 'available', canInstall: false });
  }
  return status;
}

export function initUpdater() {
  ipcMain.handle('update:getStatus', () => status);
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => {
    if (status.state === 'ready') {
      // Squirrel swaps the files and starts the new version.
      setImmediate(() => autoUpdater.quitAndInstall());
      return { ok: true };
    }
    if (status.state === 'available' && status.url) {
      shell.openExternal(status.url);
      return { ok: true };
    }
    return { ok: false, error: 'No update is ready yet.' };
  });

  if (!app.isPackaged) return;
  // The very first launch after installing, Squirrel is still finishing up
  // for a while: hold the first check back further.
  const first = process.argv.includes('--squirrel-firstrun') ? 5 * 60 * 1000 : FIRST_CHECK_MS;
  setTimeout(() => { check().catch(() => {}); }, first);
  setInterval(() => { check().catch(() => {}); }, CHECK_EVERY_MS);
}
