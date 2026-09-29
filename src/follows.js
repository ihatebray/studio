/* =========================================================================
 *  studio — artists followed in Studio (main process)
 *
 *  Following an artist here is Studio's own: nothing is sent to Spotify, and
 *  it works whatever Spotify's own follows or home feed say. New Releases
 *  reads these (with the artists you follow on Spotify) through the playback
 *  helper. Kept as a small JSON file: [{ id, name, image, at }], newest first.
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';

const file = () => path.join(app.getPath('userData'), 'studio-follows.json');
const valid = (id) => /^[0-9A-Za-z]{22}$/.test(String(id || ''));

let cache = null;
export function listFollows() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = Array.isArray(v) ? v.filter((a) => valid(a?.id) && a.name) : [];
  } catch { cache = []; }
  return cache;
}

const listeners = new Set();
export function onFollowsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function save(next) {
  cache = next;
  try { fs.writeFileSync(file(), JSON.stringify(next, null, 1)); } catch { /* ignore */ }
  for (const fn of listeners) { try { fn(next); } catch { /* ignore */ } }
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('follows:changed', next); } catch { /* closing */ }
  }
}

export function follow({ id, name, image = null } = {}) {
  if (!valid(id) || !String(name || '').trim()) return { ok: false, error: 'That artist has no Spotify ID to follow.' };
  const rest = listFollows().filter((a) => a.id !== id);
  save([{ id, name: String(name).trim(), image: image || null, at: Date.now() }, ...rest]);
  return { ok: true, follows: cache };
}

export function unfollow(id) {
  save(listFollows().filter((a) => a.id !== id));
  return { ok: true, follows: cache };
}

export function registerFollowsIpc(ipcMain) {
  ipcMain.handle('follows:list', () => listFollows());
  ipcMain.handle('follows:add', (_e, artist) => follow(artist));
  ipcMain.handle('follows:remove', (_e, id) => unfollow(String(id || '')));
}
