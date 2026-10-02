/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const fs = require('fs');

/* =========================================================================
 *  studio — Electron Forge build config
 * ========================================================================= */

/** Windows Add/Remove Programs needs a REMOTE .ico URL — see setupIcon note. */
const ICON_URL = 'https://raw.githubusercontent.com/ihatebray/studio/main/src/assets/icon.ico';

/* ---------- Which platform are we actually building for? ----------------
 * `electron-forge make` targets the host platform unless --platform says
 * otherwise. The old config bundled EVERY folder under ./bin, so a Windows
 * installer built on a machine that had also run the mac setup shipped mac
 * binaries too — dead weight in the download, and confusing in resources/.
 */
function argValue(flag) {
  const argv = process.argv;
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i === -1) return null;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1] || null;
}

const targetPlatform = argValue('--platform') || process.platform;
const targetArch = argValue('--arch') || process.arch;

/** Must stay identical to binSubdir() in src/main/binPaths.js. */
function binSubdir(platform, arch) {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return 'linux-x64';
}

/* ---------- yt-dlp + ffmpeg, bundled or the build fails -----------------
 * These are what make search, download and transcode work. `bin/` is
 * gitignored and filled by `npm run setup:binaries`, so a fresh clone that
 * goes straight to `npm run make` used to produce an installer that looked
 * perfect and could not download a single track — the failure only showed up
 * on someone else's machine. Better to refuse to build.
 */
function resolveBinDir() {
  const sub = binSubdir(targetPlatform, targetArch);
  const dir = path.join(__dirname, 'bin', sub);
  const exe = targetPlatform === 'win32' ? '.exe' : '';
  const required = [`yt-dlp${exe}`, `ffmpeg${exe}`];

  // Only enforce this when we are actually producing a build. `npm start`
  // should still run so the rest of the app can be worked on.
  const building = process.argv.some((a) => a === 'make' || a === 'package' || a === 'publish');
  if (!building) return fs.existsSync(dir) ? [dir] : [];

  const missing = fs.existsSync(dir)
    ? required.filter((f) => !fs.existsSync(path.join(dir, f)))
    : required;

  if (missing.length) {
    throw new Error(
      `\n\n  Cannot package studio: ${missing.join(' and ')} missing from bin/${sub}/\n\n`
      + '  These ship INSIDE the installer so users never download anything.\n'
      + '  Fix:  npm run setup:binaries\n'
      + `  Then check bin/${sub}/ contains ${required.join(' and ')}.\n`,
    );
  }
  return [dir];
}

/* ---------- What actually gets copied into the app ----------------------
 * The Forge Vite plugin sets this automatically, to:
 *
 *     ignore: (file) => !file.startsWith('/.vite')
 *
 * i.e. package ONLY the Vite output and drop node_modules. That is correct
 * when everything is bundled — but vite.main.config.mjs marks eight modules
 * `external`, which means "do not bundle, require from node_modules at
 * runtime". The two settings contradict each other, and the result is an
 * installer that dies on launch with:
 *
 *     Cannot find module 'electron-squirrel-startup'
 *
 * That is simply the first external main.js touches (line 28). sql.js,
 * music-metadata, node-id3, soulseek-ts and discord-rpc would all have
 * followed. Several of them cannot be bundled — sql.js's asm build is UMD
 * and breaks when inlined — so the externals are right and the ignore rule
 * is what has to change.
 *
 * The plugin only applies its own rule when none is set, so defining one
 * here takes precedence. Providing a FUNCTION also avoids the plugin's
 * "your app may be larger than expected" warning.
 *
 * electron-packager still prunes devDependencies, so this ships production
 * dependencies only.
 */
function packageFilter(file) {
  if (!file) return false;                          // the root itself
  if (file.startsWith('/.vite')) return false;      // built main/preload/renderer
  if (file.startsWith('/node_modules')) return false; // the externals above
  if (file === '/package.json') return false;       // Electron reads "main" from it
  return true;                                      // src/, bin/, out/, docs, git…
}

module.exports = {
  packagerConfig: {
    ignore: packageFilter,
    name: 'studio',
    executableName: 'studio',
    /* Resolves icon.ico on Windows, icon.icns on macOS, icon.png on Linux.
       WITHOUT src/assets/icon.ico present, Windows silently falls back to the
       default Electron icon — the app is named studio everywhere and still
       looks like a stock Electron build in the taskbar. */
    icon: path.join(__dirname, 'src', 'assets', 'icon'),
    extraResource: resolveBinDir(),
    asar: true,
    appCopyright: `Copyright © ${new Date().getFullYear()} bray`,
    /* Properties Windows shows in the .exe's Details tab, Task Manager and
       the SmartScreen prompt. Left unset these read "Electron". */
    win32metadata: {
      CompanyName: 'bray',
      ProductName: 'studio',
      FileDescription: 'studio',
      InternalName: 'studio',
      OriginalFilename: 'studio.exe',
    },
  },

  rebuildConfig: {},

  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'studio',              // NuGet package id — no spaces
        exe: 'studio.exe',
        setupExe: 'studio-Setup.exe', // stable filename, no version in it
        /* The icon on Setup.exe itself and in Squirrel's install animation. */
        setupIcon: path.join(__dirname, 'src', 'assets', 'icon.ico'),
        /* Add/Remove Programs reads this over the network — it must be a
           real reachable URL, not a local path. If the repo is private or
           the file is not there, drop this line and Windows shows a generic
           icon rather than a broken one. */
        iconUrl: ICON_URL,
        authors: 'bray',
        description: 'studio — a personal music library and player',
      },
    },
    /* Portable fallback: unzip and run, no installer, no Add/Remove entry.
       Handy for a friend who just wants to try it. */
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] },
    { name: '@electron-forge/maker-deb', config: {} },
    { name: '@electron-forge/maker-rpm', config: {} },
  ],

  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/main.js', config: 'vite.main.config.mjs' },
          { entry: 'src/main/preload.js', config: 'vite.preload.config.mjs' },
        ],
        renderer: [
          { name: 'main_window', config: 'vite.renderer.config.mjs' },
        ],
      },
    },
  ],

  hooks: {
    /* Last line of defence. extraResource is resolved when this file loads;
       this confirms the binaries actually landed in the packaged output,
       which is the thing that matters. */
    postPackage: async (_forgeConfig, options) => {
      const sub = binSubdir(options.platform, options.arch);
      const exe = options.platform === 'win32' ? '.exe' : '';
      for (const dir of options.outputPaths) {
        const resources = options.platform === 'darwin'
          ? path.join(dir, 'studio.app', 'Contents', 'Resources')
          : path.join(dir, 'resources');
        const ytDlp = path.join(resources, sub, `yt-dlp${exe}`);
        const ffmpeg = path.join(resources, sub, `ffmpeg${exe}`);
        const ok = fs.existsSync(ytDlp) && fs.existsSync(ffmpeg);
        console.log(
          ok
            ? `[studio] bundled yt-dlp + ffmpeg → resources/${sub}/`
            : `[studio] WARNING: binaries missing from ${resources}/${sub}/ — downloads will fail`,
        );
      }
    },
  },
};
