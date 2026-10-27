/* =========================================================================
 *  studio — files Studio can't play, converted on import (main process)
 *
 *  Studio plays through Chromium, which can't decode WMA (any kind) or
 *  Apple Lossless (ALAC, in .m4a). Those used to import fine and then never
 *  play. Now they're converted to FLAC as they're imported: lossless, so
 *  nothing is lost on top of what the file already had. The FLAC goes in
 *  userData/Converted and the original is left where it was.
 * ========================================================================= */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { getToolPaths } from './binPaths.js';

const CONVERT_TIMEOUT_MS = 10 * 60_000;

function runFfmpeg(args) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(getToolPaths().ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch { resolve({ code: -1, err: '' }); return; }
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-16384); });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, CONVERT_TIMEOUT_MS);
    proc.on('error', () => { clearTimeout(timer); resolve({ code: -1, err }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

/** Whether Chromium can't play this file. */
async function needsConverting(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wma') return true;
  if (ext !== '.m4a') return false;
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { skipCovers: true, duration: false });
    return /^alac$/i.test(meta.format?.codec || '');
  } catch { return false; }
}

/**
 * The path to import for `filePath`: itself when Studio can play it, else a
 * FLAC copy (made once; importing the same file again reuses it). Throws
 * when it can't be converted, so the import skips it rather than adding a
 * song that won't play. `replace`: the file is Studio's own download, so
 * the original is removed once converted.
 */
export async function playablePath(filePath, { replace = false } = {}) {
  if (!(await needsConverting(filePath))) return filePath;
  const st = await fs.promises.stat(filePath);
  const id = crypto.createHash('sha1').update(`${filePath.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 10);
  const dir = path.join(app.getPath('userData'), 'Converted');
  const out = path.join(dir, `${path.basename(filePath, path.extname(filePath))} (${id}).flac`);
  if (fs.existsSync(out)) return out;
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${out}.part`;
  // Tags carried over; the cover is kept from the original by the import.
  const { code, err } = await runFfmpeg(['-y', '-i', filePath, '-map', '0:a:0', '-map_metadata', '0', '-c:a', 'flac', '-f', 'flac', tmp]);
  if (code !== 0) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`Couldn’t convert ${path.basename(filePath)}: ${err.trim().split('\n').pop() || 'ffmpeg failed'}`);
  }
  await fs.promises.rename(tmp, out);
  if (replace) fs.promises.rm(filePath, { force: true }).catch(() => {});
  return out;
}
