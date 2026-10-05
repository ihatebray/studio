/**
 * Downloads the yt-dlp and ffmpeg binaries studio needs into ./bin/<platform>/.
 *
 * src/main/binPaths.js resolves binaries from:
 *   dev:      ./bin/win-x64 | ./bin/darwin-arm64 | ./bin/darwin-x64 | ./bin/linux-x64
 *   packaged: resources/<same leaf> (forge.config.cjs extraResource)
 *
 * Run: npm run setup:binaries
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const platform = process.platform;
const arch = process.arch;

function subdir() {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return 'linux-x64';
}

const outDir = path.join(process.cwd(), 'bin', subdir());
fs.mkdirSync(outDir, { recursive: true });

const YTDLP = {
  'win-x64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  'darwin-arm64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'darwin-x64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'linux-x64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
};

// BtbN publishes static ffmpeg builds for win/linux on GitHub releases.
// macOS users: grab a static ffmpeg from https://evermeet.cx/ffmpeg/ and
// drop it in bin/darwin-*/ manually (no stable direct-download URL).
const FFMPEG_ZIP = {
  'win-x64': 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  'linux-x64': 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
};

async function download(url, dest) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  console.log(`  → ${dest}`);
}

function exists(p) { return fs.existsSync(p); }

const win = platform === 'win32';
const ytDlpDest = path.join(outDir, win ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegDest = path.join(outDir, win ? 'ffmpeg.exe' : 'ffmpeg');

// ---- yt-dlp ---------------------------------------------------------------
if (exists(ytDlpDest)) {
  console.log(`✓ yt-dlp already present at ${ytDlpDest}`);
} else {
  await download(YTDLP[subdir()], ytDlpDest);
  if (!win) fs.chmodSync(ytDlpDest, 0o755);
}

// ---- ffmpeg ---------------------------------------------------------------
if (exists(ffmpegDest)) {
  console.log(`✓ ffmpeg already present at ${ffmpegDest}`);
} else if (platform === 'darwin') {
  console.log('! macOS: download a static ffmpeg from https://evermeet.cx/ffmpeg/');
  console.log(`  and place it at ${ffmpegDest} (then: chmod +x)`);
} else {
  const url = FFMPEG_ZIP[subdir()];
  const archive = path.join(outDir, path.basename(new URL(url).pathname));
  await download(url, archive);
  console.log('  extracting ffmpeg…');
  if (win) {
    // Windows ships tar.exe since Win10 1803 — it can extract zips too.
    execFileSync('tar', ['-xf', archive, '-C', outDir]);
  } else {
    execFileSync('tar', ['-xf', archive, '-C', outDir]);
  }
  // Find the ffmpeg binary inside the extracted folder and hoist it.
  const findFfmpeg = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const hit = findFfmpeg(p); if (hit) return hit; }
      else if (entry.name === (win ? 'ffmpeg.exe' : 'ffmpeg')) return p;
    }
    return null;
  };
  const found = findFfmpeg(outDir);
  if (!found) throw new Error('ffmpeg binary not found in the extracted archive');
  if (path.resolve(found) !== path.resolve(ffmpegDest)) fs.copyFileSync(found, ffmpegDest);
  if (!win) fs.chmodSync(ffmpegDest, 0o755);
  // Clean up the archive + extracted tree, keep just the two binaries.
  fs.rmSync(archive, { force: true });
  for (const entry of fs.readdirSync(outDir)) {
    const p = path.join(outDir, entry);
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  }
  console.log(`  → ${ffmpegDest}`);
}

console.log('\nBinaries ready. Run `npm start` to launch studio.');
