# Mini player

A second always-on-top window that floats over whatever you're doing. Four
layouts, freely resizable, remembers where you left it.

## New files → `src/`

| File | Runs in | What it is |
|---|---|---|
| `miniWindow.js` | main | Window lifecycle, options persistence, IPC relay, global shortcuts |
| `MiniPlayer.jsx` | mini renderer | The four layouts + the in-window options panel |
| `useMiniPlayerBridge.js` | main renderer | Publishes now-playing state, applies commands back |
| `MiniPlayerSettings.jsx` | main renderer | The Settings-page card |

## Replaced files → `src/`

`preload.js` and `renderer.jsx` are drop-in replacements — the only changes
are the new `mini` block on `electronAPI` and the `#mini` route.

## Four patches

### 1. `main.js` — import

After the other local imports (near line 121, below `geniusCredits.js`):

```js
import { initMiniWindow } from './miniWindow.js';
```

### 2. `main.js` — init

Inside `app.whenReady().then(...)`, immediately after `createWindow();`:

```js
  initMiniWindow({
    getMainWindow: () => mainWindow,
    preloadPath: resolvePreloadPath(),
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    rendererIndexPath: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  });
```

### 3. `App.jsx` — import + hook

Add to the imports at the top:

```js
import { useMiniPlayerBridge } from './useMiniPlayerBridge.js';
```

Then find this line (~3163, just above `return (`):

```js
  const inElectron = typeof window !== 'undefined' && !!window.electronAPI;
```

and insert directly **above** it:

```js
  // Feeds the always-on-top mini window and applies its transport commands.
  // Every callback below is the same one StudioShell gets — the mini is a
  // remote for this engine, not a second one.
  useMiniPlayerBridge({
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    shuffleOn,
    repeat,
    onTogglePlay: togglePlay,
    onPrev: handlePrev,
    onNext: handleNext,
    onSeek: seekTo,
    onSetVolume: setVolume,
    onToggleShuffle: toggleShuffle,
    onToggleRepeat: () => setRepeat((p) => (p === 'off' ? 'all' : p === 'all' ? 'one' : 'off')),
    onToggleFavorite: toggleFavorite,
  });
```

### 4. `StudioHome.jsx` — settings card

Add to the imports:

```js
import MiniPlayerSettings from './MiniPlayerSettings.jsx';
```

In the settings section, after the Appearance block's "Active tab style"
buttons close (`</div>` before the `{onSetTransitionMode ? (` line, ~2962):

```jsx
                <MiniPlayerSettings accent={accent} />
```

That's it — no `forge.config.cjs` or Vite config changes. The mini window
loads the same bundle with a `#mini` hash, which `renderer.jsx` routes.

## How it works

Audio never leaves the main renderer. Two windows would mean two `<audio>`
graphs, two Discord presences and two sets of play events. So:

```
main renderer --('mini:publish')--> main process --('mini:state')--> mini
mini renderer --('mini:command')--> main process --('mini:command')--> main
```

The main process caches the last snapshot, so a mini window that opens
mid-song paints instantly instead of flashing an empty shell.

**Progress is interpolated.** Publishing on every `timeupdate` would be 4–5
IPC round trips a second to move a 4px bar. Instead the bridge throttles on
`Math.round(currentTime)` — about one publish a second, carrying
`{ position, at }` — and the mini advances locally between them with a
matching `1s linear` CSS transition. Seeks land within a second and the bar
glides rather than ticking.

**The theme is sampled in the mini, not shipped over IPC.** `studio-cover://`
is registered `corsEnabled`, so the mini window can run `sampleCoverTheme` on
the same URL and stay correctly tinted even when `StudioShell` isn't mounted.

## Layouts

| Style | Default | Minimum | What it shows |
|---|---|---|---|
| Full | 416×184 | 332×150 | Art, scrubber with times, shuffle/prev/play/next/repeat, volume |
| Compact | 368×110 | 270×90 | Art, title, time remaining, three buttons |
| Minimal | 298×72 | 198×58 | A strip. Progress *is* the bottom edge |
| Art only | 220×220 | 140×140 | The cover, square-locked. Controls fade in on hover |

Sizes scale with the window rather than snapping between breakpoints — art
size, type scale and button size are all derived from measured height, so
dragging the corner genuinely rescales the layout. Each style remembers its
own bounds, so switching back and forth doesn't lose your placement.

Resize from the corner grip or the window edges. The grip drives resizing
from screen-space pointer deltas because transparent frameless windows have
unreliable native resize edges on Windows.

## Options

Live in `userData/miniplayer.json`, editable from the Settings card or the
`⋯` button in the mini itself (which grows the window to fit the panel and
snaps back exactly when you close it).

- **Keep on top** — pinned at the `screen-saver` z-level with
  `visibleOnFullScreen`, which is what gets it over borderless and windowed
  games. Exclusive-fullscreen games will still cover it; nothing can fix that
  short of an overlay injector.
- **Click-through** — clicks pass to the game. `forward: true` keeps mousemove
  flowing, so the mini wakes itself when you actually reach for it and goes
  back to sleep 1.4s later.
- **Opacity** — 35–100%.
- **Hide the studio window** — main window tucks away, so only the mini is in
  your taskbar. It comes back when you close the mini.
- **Hide buttons when idle** and **Show progress**.

## Shortcuts

- `Ctrl` `Alt` `M` — open/close the mini player from anywhere
- `Ctrl` `Alt` `G` — toggle click-through

These are global on purpose. In a fullscreen game you can't click the app to
get the mini back, and click-through makes the mini itself unclickable by
design — `Ctrl+Alt+G` is the guaranteed way out.

## Things worth knowing

- Closing the main window destroys the mini, so the app can still quit.
- `backgroundThrottling: false` keeps the progress bar moving while the mini
  is unfocused, which is the entire point of it.
- The mini has no lyrics, queue or library. It's a transport, not a second
  copy of the app — if you want those, `Back to studio` (or double-clicking
  the shell) shows the main window and closes the mini.
