# studio

A personal fullscreen now-playing app. Forked from Immerse, reshaped so the
fullscreen cover overlay is the entire experience — but with the whole engine
intact underneath: Spotify search, Soulseek, yt-dlp + ffmpeg imports, synced
lyrics, stats, and new releases all still work.

## How it differs from Immerse

- **Its own identity and data.** The app name is `studio`, which gives it its
  own OS userData folder — so it has its own fresh `library.db`, cover cache,
  and settings. Nothing it does touches your Immerse install.
- **The overlay is the app — the old views are gone.** Immerse's page, docks,
  tabs, and editors (17 files) are deleted. studio has exactly three views,
  all in `src/StudioShell.jsx`: an animated first-run onboarding
  (`StudioOnboarding.jsx`) that walks through Spotify + Soulseek setup, a
  search-first home screen (`StudioHome.jsx`) with library tiles and a
  now-playing pill, and the fullscreen overlay itself (unchanged from
  Immerse — transport, synced lyrics, and the command center with
  library/find/stats/releases all live inside it). `Esc` steps out to home
  while music keeps playing; `F` or the pill returns to the stage; a new
  track re-engages fullscreen automatically.
- **No auto-updater.** The updater in Immerse points at the Immerse GitHub
  repo; left enabled it would eventually replace studio with an Immerse
  build, so it's disabled in `src/main.js` (`initAutoUpdater`). Re-enable it
  there if studio ever gets its own repo + releases.

## Setup

```bash
npm install            # deps (postinstall just checks for binaries)
npm run setup:binaries # downloads yt-dlp + ffmpeg into ./bin/<platform>/
npm start              # launch
```

macOS note: the script fetches yt-dlp automatically but ffmpeg has no stable
direct-download URL for mac — grab a static build from evermeet.cx/ffmpeg and
drop it at `bin/darwin-arm64/ffmpeg` (or `darwin-x64`), then `chmod +x` it.

First launch walks you through Spotify (and optionally Soulseek) setup with
the onboarding flow. Credentials can be changed any time via the gear on the
home screen. To re-run onboarding, clear the `studio:onboarded` key from
localStorage (DevTools → Application).

## Packaging

```bash
npm run make
```

`forge.config.cjs` bundles whatever platform folders exist under `./bin` as
extra resources, matching what `src/binPaths.js` expects at runtime.

## Refining it over time

The view layer is fully studio's now; what remains shared with Immerse is
the engine: `src/App.jsx` keeps the playback core (dual-audio crossfade,
analyser, queue/shuffle, play events, releases) and `src/main.js` keeps all
IPC (Spotify, Soulseek, yt-dlp/ffmpeg, lyrics, library DB). App.jsx still
contains engine state for features whose UI was removed (playlists, sleep
timer, ambient) — dead but harmless; prune those as you go. The derived
state the overlay needs (cover theme sampling, lyrics fetching) was ported
verbatim into StudioShell so behaviour is identical to Immerse.

Key files for studio-specific behavior:

- `src/StudioShell.jsx` — view gating, lyrics + cover-theme plumbing
- `src/StudioOnboarding.jsx` — onboarding flow + shared credential panels
- `src/StudioHome.jsx` — home screen, search/download, settings sheet
- `src/main.js` — search "STUDIO" for the disabled updater
- `forge.config.cjs`, `vite.*.config.mjs`, `scripts/` — build system
"# studio" 
