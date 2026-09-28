/**
 * Post-install hook. Intentionally never fails the install — it just checks
 * whether the yt-dlp/ffmpeg binaries are in place and prints a reminder if
 * not. Downloading is an explicit step (`npm run setup:binaries`) so a plain
 * `npm install` stays fast and offline-friendly.
 */
import fs from 'node:fs';
import path from 'node:path';

function subdir() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return 'linux-x64';
}

const win = process.platform === 'win32';
const base = path.join(process.cwd(), 'bin', subdir());
const ok = fs.existsSync(path.join(base, win ? 'yt-dlp.exe' : 'yt-dlp'))
  && fs.existsSync(path.join(base, win ? 'ffmpeg.exe' : 'ffmpeg'));

if (!ok) {
  console.log('\n[studio] yt-dlp/ffmpeg not found in ./bin — run: npm run setup:binaries\n');
}
