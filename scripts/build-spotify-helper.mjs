/* Builds studio-spotify (the Spotify playback helper) and copies it next to
 * yt-dlp / ffmpeg in bin/<platform>/, where binPaths.js looks for it.
 *
 *   npm run setup:spotify
 *
 * Needs Rust (https://rustup.rs). The first build downloads and compiles
 * librespot and takes a few minutes; later builds are quick.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const crate = path.join(root, 'studio-spotify');
const win = process.platform === 'win32';
const sub = win ? 'win-x64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') : 'linux-x64';
const exe = win ? 'studio-spotify.exe' : 'studio-spotify';

const cargoCheck = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: win });
if (cargoCheck.status !== 0) {
  console.error('\nRust is not installed (cargo not found).');
  console.error('Install it from https://rustup.rs, open a NEW terminal, and run this again.\n');
  process.exit(1);
}
console.log(`Using ${cargoCheck.stdout.trim()}`);
console.log('Building studio-spotify (first build takes a few minutes)...\n');

const build = spawnSync('cargo', ['build', '--release', '--locked'], { cwd: crate, stdio: 'inherit', shell: win });
if (build.status !== 0) {
  console.error('\nBuild failed. The error above says why; send it over if it is not obvious.');
  process.exit(build.status || 1);
}

const src = path.join(crate, 'target', 'release', exe);
const outDir = path.join(root, 'bin', sub);
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, exe));
if (!win) fs.chmodSync(path.join(outDir, exe), 0o755);
console.log(`\nInstalled ${path.join('bin', sub, exe)}. Restart Studio to use it.`);
