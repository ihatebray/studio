/* =========================================================================
 *  studio — playlists popped out of the app into their own windows
 *
 *  A popped-out playlist is the same view as the app's playlist pop-out
 *  (InstantSearch, windowed), in a window of its own that can sit on another
 *  monitor or above everything else. Music still plays from the app's
 *  window, so this module only relays: what the app pushes (the playlist,
 *  the song playing, the theme) goes to the playlist's window, and what the
 *  window asks for (play, skip, edit) goes to the app.
 *
 *  One window per playlist. Each remembers where it was and how big, on
 *  whichever monitor that was, and opens there again while that monitor is
 *  still connected.
 * ========================================================================= */

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import fs from 'fs';

const windows = new Map(); // key → BrowserWindow
const DEFAULT_SIZE = { width: 560, height: 760 };
const MIN_SIZE = { width: 420, height: 460 };
const FOCUS_CMDS = new Set(['openArtist', 'openAlbum']);

const boundsFile = () => path.join(app.getPath('userData'), 'playlist-windows.json');
function readBounds() {
  try {
    const v = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function writeBounds(all) {
  try { fs.writeFileSync(boundsFile(), JSON.stringify(all)); } catch { /* ignore */ }
}

/* Where this playlist's window was, else where the last one was (shifted a
   little so two don't stack exactly), else centred. A position on a monitor
   that's gone is dropped, keeping the size. */
function startBounds(key) {
  const all = readBounds();
  const saved = all[key] || (all.last ? { ...all.last, x: all.last.x + 28, y: all.last.y + 28 } : null);
  if (!saved) return { ...DEFAULT_SIZE };
  const width = Math.max(MIN_SIZE.width, saved.width || DEFAULT_SIZE.width);
  const height = Math.max(MIN_SIZE.height, saved.height || DEFAULT_SIZE.height);
  const onScreen = Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some(({ workArea: a }) => (
    saved.x < a.x + a.width - 80 && saved.x + width > a.x + 80 && saved.y >= a.y - 8 && saved.y < a.y + a.height - 80
  ));
  return onScreen ? { x: saved.x, y: saved.y, width, height } : { width, height };
}

function rememberBounds(key, win) {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  const b = win.getBounds();
  const all = readBounds();
  all[key] = b;
  all.last = b;
  writeBounds(all);
}

/**
 * Wires the IPC. `getMainWindow()` is the app's window; `openWindow(win,
 * query)` loads the renderer into a new window with the given query (the
 * same page the app uses, which renders the playlist view when it sees
 * `plwin`); `windowOptions` are the shared BrowserWindow options (preload,
 * icon).
 */
export function registerPlaylistWindows({ getMainWindow, openWindow, windowOptions }) {
  const toMain = (channel, payload) => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };
  const keyOf = (e) => {
    for (const [key, win] of windows) if (!win.isDestroyed() && win.webContents === e.sender) return key;
    return null;
  };

  ipcMain.handle('plwin:open', (e, { key, title } = {}) => {
    if (!key) return { ok: false };
    const open = windows.get(key);
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return { ok: true };
    }
    const win = new BrowserWindow({
      ...windowOptions(),
      ...startBounds(key),
      title: title ? `${title} · studio` : 'studio',
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      frame: false,
      backgroundColor: '#000000',
      show: false,
    });
    windows.set(key, win);
    win.once('ready-to-show', () => win.show());
    win.on('close', () => rememberBounds(key, win));
    win.on('closed', () => {
      if (windows.get(key) === win) windows.delete(key);
      toMain('plwin:closed', { key });
    });
    // The developer tools, as in the app's window.
    win.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const k = (input.key || '').toLowerCase();
      if (k === 'f12' || ((input.control || input.meta) && input.shift && k === 'i')) {
        win.webContents.toggleDevTools();
        ev.preventDefault();
      }
    });
    openWindow(win, { plwin: key });
    return { ok: true };
  });

  // The app → one playlist's window (key), or every one of them (no key).
  ipcMain.on('plwin:push', (_e, { key = null, data } = {}) => {
    for (const [k, win] of windows) {
      if ((key == null || k === key) && !win.isDestroyed()) win.webContents.send('plwin:state', data);
    }
  });

  /* A playlist's window → the app. Opening something there (an artist, an
     album) brings the app's window forward to show it. */
  ipcMain.on('plwin:cmd', (e, { cmd, args } = {}) => {
    const key = keyOf(e);
    if (!key) return;
    if (FOCUS_CMDS.has(cmd)) focusMain(getMainWindow());
    toMain('plwin:cmd', { key, cmd, args });
  });

  // Keep on top: above every other window, games in a window included.
  ipcMain.handle('plwin:pin', (e, on) => {
    const win = windows.get(keyOf(e));
    if (!win) return false;
    win.setAlwaysOnTop(!!on, 'floating');
    return win.isAlwaysOnTop();
  });

  // Back into the app: the app opens the playlist in its own pop-out.
  ipcMain.on('plwin:return', (e) => {
    const key = keyOf(e);
    const win = key ? windows.get(key) : null;
    focusMain(getMainWindow());
    if (key) toMain('plwin:cmd', { key, cmd: 'return' });
    win?.close();
  });

  // The app's window closing takes its playlists with it: they play from it.
  return function closeAll() {
    for (const win of windows.values()) if (!win.isDestroyed()) win.close();
  };
}

function focusMain(main) {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}
