# studio

A personal music player: your local library and your Spotify account in one
window, with synced lyrics, new releases from the artists you follow, and
search across Spotify and Soulseek.

Spotify plays through `studio-spotify`, a small Rust helper built on
librespot. It plays straight to the sound card; the app only ever receives
metadata from it, never audio.

## Setup

```bash
npm install            # deps (postinstall just checks for binaries)
npm run setup:binaries # downloads yt-dlp + ffmpeg into ./bin/<platform>/
npm run setup:spotify  # builds the Spotify helper (needs Rust: https://rustup.rs)
npm start              # launch
```

macOS note: the script fetches yt-dlp automatically but ffmpeg has no stable
direct-download URL for mac. Grab a static build from evermeet.cx/ffmpeg,
drop it at `bin/darwin-arm64/ffmpeg` (or `darwin-x64`), then `chmod +x` it.

First launch walks you through signing in to Spotify and, optionally,
Soulseek. Both can be changed later under Settings → Connections, which can
also replay the walkthrough.

## Packaging

```bash
npm run make
```

`forge.config.cjs` bundles whatever platform folders exist under `./bin` as
extra resources, matching what `src/main/binPaths.js` expects at runtime.
The auto-updater is off (`initAutoUpdater` in `src/main/main.js`) until
studio has releases of its own.

## Layout

- `src/main/`: the Electron main process (`main.js`), the preload bridge
  (`preload.js`), and everything only they use: the library database,
  Spotify (`spotifyPartner.js`, `spotifyPlayer.js`, `spotifyFeed.js`),
  Soulseek, yt-dlp imports, Discord presence, lyrics and credits.
- `src/ui/`: the React app. `App.jsx` is the playback engine (queue,
  crossfade, the Web Audio graph and its boost limiter); `StudioShell.jsx`
  chooses between onboarding and `StudioHome.jsx`, the main window.
  `ui/home/` holds StudioHome's pages and pieces: `LibraryPage`,
  `SettingsPage`, `NowPlaying` (bar, panel, full view), and its styles.
- `src/lib/`: plain modules: cover colour and theming (used by both
  processes), search scoring, formatting helpers.
- `studio-spotify/`: the Rust playback helper.
- `forge.config.cjs`, `vite.*.config.mjs`, `scripts/`: the build.
