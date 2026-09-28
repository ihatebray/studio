import path from 'path';
import fs from 'fs';
import { app } from 'electron';

function binSubdir() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  return 'linux-x64';
}

/**
 * Resolved paths to bundled yt-dlp and ffmpeg.
 *
 * In dev (npm run start) the binaries live at ./bin/<platform>/.
 * In packaged builds, electron-packager's extraResource flattens the
 * leaf segment of the source path into the resources directory — so
 * what was ./bin/win-x64/ in dev becomes ./resources/win-x64/ inside
 * the packaged app, NOT ./resources/bin/win-x64/. We resolve to the
 * correct location based on app.isPackaged.
 */
export function getToolPaths() {
  const sub = binSubdir();
  const devBase = path.join(process.cwd(), 'bin', sub);
  // Packaged: extraResource copied "bin/win-x64" → resources/win-x64
  const prodBase = path.join(process.resourcesPath, sub);
  const base = app.isPackaged ? prodBase : devBase;
  const win = process.platform === 'win32';
  return {
    base,
    ytDlp: path.join(base, win ? 'yt-dlp.exe' : 'yt-dlp'),
    ffmpeg: path.join(base, win ? 'ffmpeg.exe' : 'ffmpeg'),
  };
}

export function toolsInstalled() {
  const { ytDlp, ffmpeg } = getToolPaths();
  return fs.existsSync(ytDlp) && fs.existsSync(ffmpeg);
}
