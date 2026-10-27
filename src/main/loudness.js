/* =========================================================================
 *  studio — how loud each local file is (main process)
 *
 *  For Even Out Volume (Settings → Playback). Each file's integrated
 *  loudness (EBU R128, LUFS) is measured once with the bundled ffmpeg and
 *  kept in userData, keyed by path and checked against the file's size and
 *  modified time so an edited file is measured again. The renderer turns it
 *  into a gain (App.jsx).
 *
 *  The song about to play is measured at once. The rest of the library is
 *  measured in the background, one file at a time at low priority, so most
 *  songs are known before they're played.
 * ========================================================================= */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { getToolPaths } from './binPaths.js';
import { isPlaybackPathAllowed } from './libraryDb.js';

const file = () => path.join(app.getPath('userData'), 'loudness.json');
/** Gives up on a file that takes longer than this (a broken or huge one). */
const MEASURE_TIMEOUT_MS = 3 * 60_000;
/** Background measuring waits this long after launch, out of startup's way. */
const BACKGROUND_DELAY_MS = 20_000;

/** path (lowercased) → { size, mtime, lufs }; lufs null = couldn't measure. */
let cache = null;
let saveTimer = null;
const inflight = new Map();
let background = [];
let backgroundRunning = false;
let backgroundAllowedAt = 0;
let noFfmpeg = false;

function load() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { cache = {}; }
  return cache;
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(file(), JSON.stringify(cache)); } catch { /* ignore */ }
  }, 2000);
}

async function stamp(filePath) {
  const st = await fs.promises.stat(filePath);
  return { size: st.size, mtime: Math.round(st.mtimeMs) };
}

/** The last "I: … LUFS" ffmpeg prints is the summary's. */
export function parseIntegrated(stderr) {
  const all = [...String(stderr).matchAll(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  if (!all.length) return null;
  const v = Number(all[all.length - 1][1]);
  return Number.isFinite(v) ? v : null;
}

/** Integrated loudness of a file, or null; undefined when ffmpeg is missing. */
function measure(filePath, low, filter = 'ebur128=framelog=quiet') {
  return new Promise((resolve) => {
    const { ffmpeg } = getToolPaths();
    let proc;
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-nostats', '-nostdin', '-threads', '1',
        '-i', filePath, '-map', '0:a:0', '-af', filter, '-f', 'null', '-',
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch { resolve(undefined); return; }
    if (low && proc.pid) {
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch { /* ignore */ }
    }
    // Only the end matters (the summary); older ffmpeg logs every frame.
    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-8192); });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, MEASURE_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); resolve(e?.code === 'ENOENT' ? undefined : null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && /framelog/.test(tail) && filter.includes('framelog')) {
        resolve(measure(filePath, low, 'ebur128'));
        return;
      }
      resolve(parseIntegrated(tail));
    });
  });
}

/** Cached value for a file, measuring it if needed. */
async function lufsOf(filePath, low) {
  const key = filePath.toLowerCase();
  let st;
  try { st = await stamp(filePath); } catch { return null; }
  const hit = load()[key];
  if (hit && hit.size === st.size && hit.mtime === st.mtime) return hit.lufs;
  if (noFfmpeg) return null;
  if (inflight.has(key)) return inflight.get(key);
  const p = measure(filePath, low).then((lufs) => {
    inflight.delete(key);
    if (lufs === undefined) { noFfmpeg = true; return null; }
    cache[key] = { ...st, lufs };
    saveSoon();
    return lufs;
  });
  inflight.set(key, p);
  return p;
}

async function runBackground() {
  if (backgroundRunning) return;
  backgroundRunning = true;
  const wait = backgroundAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  while (background.length && !noFfmpeg) {
    const next = background.shift();
    if (!isPlaybackPathAllowed(next)) continue;
    try { await lufsOf(next, true); } catch { /* next one */ }
  }
  backgroundRunning = false;
}

export function registerLoudnessIpc(ipcMain) {
  backgroundAllowedAt = Date.now() + BACKGROUND_DELAY_MS;
  /* One file, now: the song about to play or the next one up. */
  ipcMain.handle('loudness:get', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !isPlaybackPathAllowed(filePath)) return null;
    return lufsOf(filePath, false);
  });
  /* The library, in the background. Replaces whatever was still waiting. */
  ipcMain.handle('loudness:queue', (_e, paths) => {
    if (!Array.isArray(paths)) return { ok: false };
    const known = load();
    background = paths.filter((p) => typeof p === 'string' && p && !(p.toLowerCase() in known));
    runBackground();
    return { ok: true, waiting: background.length };
  });
}
