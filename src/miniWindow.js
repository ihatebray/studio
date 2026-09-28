import path from 'path';
import fs from 'fs';
import { app, BrowserWindow, ipcMain, screen, globalShortcut } from 'electron';

/* =========================================================================
 *  miniWindow — the always-on-top mini player.
 *
 *  A SECOND BrowserWindow, not a mode of the main one. That's the only way
 *  to float over a borderless-windowed game: the main window is 1000×600
 *  minimum and lives in the taskbar; this one is frameless, transparent,
 *  skipTaskbar, and pinned at the 'screen-saver' z-level.
 *
 *  It does NOT play audio. The <audio> element (and the whole crossfade /
 *  gapless engine) stays in the main renderer — two windows would mean two
 *  audio graphs and two Discord presences. Instead:
 *
 *      main renderer  --('mini:publish')-->  here  --('mini:state')-->  mini
 *      mini renderer  --('mini:command')-->  here  --('mini:command')--> main
 *
 *  We cache the last published state so a freshly-opened mini window paints
 *  immediately instead of showing an empty shell for a beat.
 *
 *  Everything is driven through initMiniWindow() rather than module-level
 *  globals so main.js keeps ownership of the preload path and the Vite
 *  dev-server URL (which is a build-time define, not something we can
 *  reach from a sibling module reliably).
 * ========================================================================= */

/* ---------- Style presets ------------------------------------------------
 * Each style is a genuinely different layout, not the same one scaled, so
 * each gets its own size envelope. minHeight matters more than minWidth —
 * these layouts break vertically first.
 * ---------------------------------------------------------------------- */
// These are WINDOW sizes, and with a full-bleed shell they're also the drawn
// sizes — MiniPlayer.jsx renders edge to edge (SHELL_MARGIN is 0, because a
// CSS drop shadow gets clipped at the window bounds and leaves a gray band).
export const MINI_STYLES = {
  full: {
    label: 'Full',
    width: 416, height: 184, minWidth: 332, minHeight: 150, maxWidth: 900, maxHeight: 360,
  },
  compact: {
    label: 'Compact',
    width: 368, height: 110, minWidth: 270, minHeight: 90, maxWidth: 820, maxHeight: 200,
  },
  minimal: {
    label: 'Minimal',
    width: 298, height: 72, minWidth: 198, minHeight: 58, maxWidth: 700, maxHeight: 116,
  },
  art: {
    label: 'Art only',
    width: 220, height: 220, minWidth: 140, minHeight: 140, maxWidth: 572, maxHeight: 572,
    square: true,
  },
};

const DEFAULT_OPTIONS = {
  style: 'compact',
  alwaysOnTop: true,
  opacity: 1,          // 0.35 – 1
  clickThrough: false, // "ghost" — mouse passes through to the game
  hideMain: false,     // tuck the main window away while the mini is up
  autoHideChrome: true,
  showProgress: true,
};

let deps = null;              // { getMainWindow, preloadPath, devServerUrl, rendererIndexPath }
let miniWindow = null;
let options = { ...DEFAULT_OPTIONS };
let savedBounds = {};         // { [style]: { x, y, width, height } }
let lastState = null;         // last payload from the main renderer
let panelRestoreBounds = null;// bounds to return to when the options panel closes
let wired = false;

/* ---------- Persistence -------------------------------------------------- */

function storePath() {
  return path.join(app.getPath('userData'), 'miniplayer.json');
}

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      options = { ...DEFAULT_OPTIONS, ...(j.options || {}) };
      if (!MINI_STYLES[options.style]) options.style = DEFAULT_OPTIONS.style;
      options.opacity = clamp(Number(options.opacity) || 1, 0.35, 1);
      savedBounds = (j.bounds && typeof j.bounds === 'object') ? j.bounds : {};
    }
  } catch {
    // First run, or the file was hand-edited into nonsense. Defaults are fine.
  }
}

let writeTimer = null;
function writeStoreSoon() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(storePath()), { recursive: true });
      fs.writeFileSync(storePath(), JSON.stringify({ options, bounds: savedBounds }), 'utf8');
    } catch { /* non-fatal — worst case the mini forgets where it sat */ }
  }, 250);
}

/* ---------- Helpers ------------------------------------------------------ */

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function preset(style) { return MINI_STYLES[style] || MINI_STYLES.compact; }

function sendMain(channel, payload) {
  const w = deps?.getMainWindow?.();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function sendMini(channel, payload) {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send(channel, payload);
}

function broadcastOptions() {
  sendMini('mini:options', options);
  sendMain('mini:options', options);
}

function broadcastOpen(open) {
  sendMain('mini:openChanged', open);
}

/** Remember where this style's window sat, so switching back restores it. */
function rememberBounds() {
  if (!miniWindow || miniWindow.isDestroyed() || panelRestoreBounds) return;
  try {
    savedBounds[options.style] = miniWindow.getBounds();
    writeStoreSoon();
  } catch { /* ignore */ }
}

/**
 * Where a fresh window of this style should open: its remembered spot if we
 * have one and it's still on a connected display, otherwise tucked into the
 * bottom-right of the primary work area — the corner least likely to cover
 * a game's HUD.
 */
function initialBounds(style) {
  const p = preset(style);
  const remembered = savedBounds[style];
  if (remembered && Number.isFinite(remembered.x) && Number.isFinite(remembered.y)) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return remembered.x < a.x + a.width && remembered.x + remembered.width > a.x
        && remembered.y < a.y + a.height && remembered.y + remembered.height > a.y;
    });
    if (onScreen) {
      return {
        x: Math.round(remembered.x),
        y: Math.round(remembered.y),
        width: clamp(Math.round(remembered.width), p.minWidth, p.maxWidth),
        height: clamp(Math.round(remembered.height), p.minHeight, p.maxHeight),
      };
    }
  }
  const area = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  return {
    x: Math.round(area.x + area.width - p.width - margin),
    y: Math.round(area.y + area.height - p.height - margin),
    width: p.width,
    height: p.height,
  };
}

/** Apply alwaysOnTop / opacity / click-through to the live window. */
function applyOptions() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  try {
    // 'screen-saver' is the highest level that still behaves; plain `true`
    // sits below fullscreen-ish windows on Windows and gets covered by games.
    miniWindow.setAlwaysOnTop(!!options.alwaysOnTop, 'screen-saver');
    miniWindow.setVisibleOnAllWorkspaces(!!options.alwaysOnTop, { visibleOnFullScreen: true });
    miniWindow.setOpacity(clamp(Number(options.opacity) || 1, 0.35, 1));
    // forward:true keeps mousemove flowing to the renderer even while clicks
    // pass through, which is what lets the mini wake itself on hover.
    miniWindow.setIgnoreMouseEvents(!!options.clickThrough, { forward: true });
  } catch { /* ignore */ }
}

/**
 * Switch the live window to a style's size envelope. A style you've resized
 * before comes back exactly as you left it, position included; a style you
 * haven't gets its preset size at the current position.
 */
function applyStyleGeometry(style) {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  const p = preset(style);
  const current = miniWindow.getBounds();
  const target = savedBounds[style];

  miniWindow.setMinimumSize(p.minWidth, p.minHeight);
  miniWindow.setMaximumSize(p.maxWidth, p.maxHeight);
  // Art mode is square by definition — let the OS enforce it mid-drag instead
  // of snapping the window back after the user lets go.
  try { miniWindow.setAspectRatio(p.square ? 1 : 0); } catch { /* ignore */ }

  miniWindow.setBounds({
    x: Math.round(target?.x ?? current.x),
    y: Math.round(target?.y ?? current.y),
    width: clamp(Math.round(target?.width ?? p.width), p.minWidth, p.maxWidth),
    height: clamp(Math.round(target?.height ?? p.height), p.minHeight, p.maxHeight),
  });
}

/* ---------- Window lifecycle --------------------------------------------- */

function createMini() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.showInactive();
    return miniWindow;
  }
  const p = preset(options.style);
  const b = initialBounds(options.style);

  miniWindow = new BrowserWindow({
    ...b,
    minWidth: p.minWidth,
    minHeight: p.minHeight,
    maxWidth: p.maxWidth,
    maxHeight: p.maxHeight,
    title: 'studio — mini',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,        // we draw our own; the OS shadow squares off the radius
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Don't steal focus from the game when it appears.
    show: false,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the progress bar moving when unfocused
    },
  });

  if (p.square) { try { miniWindow.setAspectRatio(1); } catch { /* ignore */ } }

  if (deps.devServerUrl) {
    miniWindow.loadURL(`${deps.devServerUrl}#mini`);
  } else {
    miniWindow.loadFile(deps.rendererIndexPath, { hash: 'mini' });
  }

  // Showing is gated on ready-to-show so the window never flashes an unpainted
  // frame over a game. That event is reliable in practice but has no natural
  // fallback: if the renderer throws during first paint, or the event simply
  // doesn't fire on a transparent window, you'd get a permanently hidden
  // window and no error anywhere. The timeout guarantees it appears.
  let shown = false;
  const reveal = (why) => {
    if (shown || !miniWindow || miniWindow.isDestroyed()) return;
    shown = true;
    applyOptions();
    miniWindow.showInactive();
    if (why !== 'ready-to-show') {
      console.warn('[mini] shown via fallback:', why);
    }
  };
  miniWindow.once('ready-to-show', () => reveal('ready-to-show'));
  setTimeout(() => reveal('timeout'), 1500);

  miniWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[mini] load failed', code, desc, url);
  });
  miniWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[mini] renderer gone', details);
  });

  // F12 / Ctrl+Shift+I in the mini window too — same safety net as main.
  miniWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (k === 'f12' || (mod && input.shift && k === 'i')) {
      miniWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  miniWindow.on('resize', rememberBounds);
  miniWindow.on('move', rememberBounds);

  miniWindow.on('closed', () => {
    miniWindow = null;
    panelRestoreBounds = null;
    broadcastOpen(false);
    if (options.hideMain) {
      const w = deps?.getMainWindow?.();
      if (w && !w.isDestroyed()) { w.show(); w.focus(); }
    }
  });

  // If the main window goes away the mini is orphaned — it can't be fed state
  // and it would keep the app alive with no way back. Take it down with it.
  const mainWin = deps?.getMainWindow?.();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.once('closed', () => {
      if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy();
    });
  }

  broadcastOpen(true);
  return miniWindow;
}

function openMini() {
  createMini();
  if (options.hideMain) {
    const w = deps?.getMainWindow?.();
    if (w && !w.isDestroyed()) w.hide();
  }
  // Nudge the renderer for a fresh snapshot — the cached one may be stale if
  // the mini was closed across a track change.
  sendMain('mini:needState', true);
  return { ok: true, open: true };
}

function closeMini() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  return { ok: true, open: false };
}

function isOpen() {
  return !!(miniWindow && !miniWindow.isDestroyed());
}

/* ---------- IPC ---------------------------------------------------------- */

function wireIpc() {
  if (wired) return;
  wired = true;

  ipcMain.handle('mini:open', () => openMini());
  ipcMain.handle('mini:close', () => closeMini());
  ipcMain.handle('mini:toggle', () => (isOpen() ? closeMini() : openMini()));
  ipcMain.handle('mini:getState', () => ({
    open: isOpen(),
    options,
    styles: Object.fromEntries(Object.entries(MINI_STYLES).map(([k, v]) => [k, { label: v.label }])),
  }));

  ipcMain.handle('mini:setOptions', (_e, patch = {}) => {
    const prevStyle = options.style;
    if (isOpen() && patch.style && patch.style !== prevStyle) rememberBounds();

    const next = { ...options };
    if (typeof patch.style === 'string' && MINI_STYLES[patch.style]) next.style = patch.style;
    if (typeof patch.alwaysOnTop === 'boolean') next.alwaysOnTop = patch.alwaysOnTop;
    if (typeof patch.clickThrough === 'boolean') next.clickThrough = patch.clickThrough;
    if (typeof patch.hideMain === 'boolean') next.hideMain = patch.hideMain;
    if (typeof patch.autoHideChrome === 'boolean') next.autoHideChrome = patch.autoHideChrome;
    if (typeof patch.showProgress === 'boolean') next.showProgress = patch.showProgress;
    if (patch.opacity != null) next.opacity = clamp(Number(patch.opacity) || 1, 0.35, 1);
    options = next;
    writeStoreSoon();

    if (isOpen()) {
      if (options.style !== prevStyle) {
        if (panelRestoreBounds) {
          // The panel is expanded over the shell, so we can't resize now —
          // retarget what "close the panel" restores to instead, or the user
          // picks Minimal and gets dropped back into a Compact-sized window.
          const p = preset(options.style);
          const remembered = savedBounds[options.style];
          panelRestoreBounds = {
            x: Math.round(remembered?.x ?? panelRestoreBounds.x),
            y: Math.round(remembered?.y ?? panelRestoreBounds.y),
            width: clamp(Math.round(remembered?.width ?? p.width), p.minWidth, p.maxWidth),
            height: clamp(Math.round(remembered?.height ?? p.height), p.minHeight, p.maxHeight),
          };
        } else {
          applyStyleGeometry(options.style);
        }
      }
      applyOptions();
      // hideMain is only acted on live when the mini is actually up.
      const w = deps?.getMainWindow?.();
      if (w && !w.isDestroyed()) {
        if (options.hideMain && w.isVisible()) w.hide();
        else if (!options.hideMain && !w.isVisible()) w.show();
      }
    }
    broadcastOptions();
    return { ok: true, options };
  });

  /** Renderer-driven resize — the custom corner grip. Screen-space deltas. */
  ipcMain.handle('mini:resizeTo', (_e, { width, height } = {}) => {
    if (!isOpen()) return { ok: false };
    const p = preset(options.style);
    const b = miniWindow.getBounds();
    let w = clamp(Math.round(Number(width) || b.width), p.minWidth, p.maxWidth);
    let h = clamp(Math.round(Number(height) || b.height), p.minHeight, p.maxHeight);
    if (p.square) { const s = Math.max(w, h); w = s; h = s; }
    miniWindow.setBounds({ x: b.x, y: b.y, width: w, height: h });
    return { ok: true, width: w, height: h };
  });

  /** Snap into a corner (or centre) of the display the mini currently sits on. */
  ipcMain.handle('mini:snap', (_e, corner = 'br') => {
    if (!isOpen()) return { ok: false };
    const b = miniWindow.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const m = 24;
    const x = corner.includes('l') ? area.x + m : area.x + area.width - b.width - m;
    const y = corner.startsWith('t') ? area.y + m : area.y + area.height - b.height - m;
    const cx = Math.round(area.x + (area.width - b.width) / 2);
    const cy = Math.round(area.y + (area.height - b.height) / 2);
    miniWindow.setBounds({
      ...b,
      x: corner === 'c' ? cx : Math.round(x),
      y: corner === 'c' ? cy : Math.round(y),
    });
    rememberBounds();
    return { ok: true };
  });

  /**
   * The in-mini options panel needs more room than a 60px-tall minimal shell
   * has. Grow to fit while it's open, then snap back exactly — the user never
   * has to re-place the window because they opened a menu.
   */
  ipcMain.handle('mini:setPanelOpen', (_e, open) => {
    if (!isOpen()) return { ok: false };
    if (open) {
      if (!panelRestoreBounds) {
        panelRestoreBounds = miniWindow.getBounds();
        const b = panelRestoreBounds;
        const area = screen.getDisplayMatching(b).workArea;
        const w = Math.max(b.width, 306);
        const h = Math.max(b.height, 274);
        // Grow up-and-left when we're near the bottom-right corner, which is
        // where this thing lives 90% of the time.
        const x = clamp(b.x - Math.max(0, w - b.width), area.x, area.x + area.width - w);
        const y = clamp(b.y - Math.max(0, h - b.height), area.y, area.y + area.height - h);
        try { miniWindow.setAspectRatio(0); } catch { /* ignore */ }
        miniWindow.setMinimumSize(Math.min(306, w), Math.min(274, h));
        miniWindow.setMaximumSize(2000, 2000);
        miniWindow.setBounds({ x, y, width: w, height: h });
      }
    } else if (panelRestoreBounds) {
      const restore = panelRestoreBounds;
      panelRestoreBounds = null;
      const p = preset(options.style);
      miniWindow.setMinimumSize(p.minWidth, p.minHeight);
      miniWindow.setMaximumSize(p.maxWidth, p.maxHeight);
      miniWindow.setBounds(restore);
      try { miniWindow.setAspectRatio(p.square ? 1 : 0); } catch { /* ignore */ }
    }
    return { ok: true };
  });

  /** Hover-wake for ghost mode — see MiniPlayer.jsx. */
  ipcMain.on('mini:setClickThroughLive', (_e, on) => {
    if (!isOpen()) return;
    try { miniWindow.setIgnoreMouseEvents(!!on, { forward: true }); } catch { /* ignore */ }
  });

  /** Main renderer → cache → mini. */
  ipcMain.on('mini:publish', (_e, payload) => {
    lastState = payload;
    sendMini('mini:state', payload);
  });

  /** Mini asks for a snapshot on mount (and after a reload). */
  ipcMain.on('mini:requestState', () => {
    if (lastState) sendMini('mini:state', lastState);
    sendMini('mini:options', options);
    sendMain('mini:needState', true);
  });

  /** Mini → main renderer. `restore` is handled here since it's window work. */
  ipcMain.on('mini:command', (_e, cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'restore') {
      const w = deps?.getMainWindow?.();
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      }
      if (cmd.closeMini !== false) closeMini();
      return;
    }
    sendMain('mini:command', cmd);
  });
}

/* ---------- Public entry point ------------------------------------------- */

/**
 * Call once from app.whenReady(), after createWindow().
 *
 * @param {object} d
 * @param {() => BrowserWindow} d.getMainWindow
 * @param {string} d.preloadPath
 * @param {string|undefined} d.devServerUrl     MAIN_WINDOW_VITE_DEV_SERVER_URL
 * @param {string} d.rendererIndexPath          packaged index.html
 */
export function initMiniWindow(d) {
  deps = d;
  readStore();
  wireIpc();
  console.log('[mini] ready — Ctrl+Alt+M to open');

  // Global shortcuts. These matter more than usual here: if you're in a
  // fullscreen game you can't click the app to get the mini back, and ghost
  // mode makes the mini itself unclickable by design. Ctrl+Alt+G is the
  // escape hatch that guarantees you're never locked out of your own widget.
  try {
    globalShortcut.register('CommandOrControl+Alt+M', () => {
      if (isOpen()) closeMini(); else openMini();
    });
    globalShortcut.register('CommandOrControl+Alt+G', () => {
      if (!isOpen()) return;
      options = { ...options, clickThrough: !options.clickThrough };
      writeStoreSoon();
      applyOptions();
      broadcastOptions();
    });
  } catch { /* a shortcut already taken by another app — not fatal */ }

  app.on('before-quit', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy();
  });
  app.on('will-quit', () => {
    try { globalShortcut.unregister('CommandOrControl+Alt+M'); } catch { /* ignore */ }
    try { globalShortcut.unregister('CommandOrControl+Alt+G'); } catch { /* ignore */ }
  });
}

export function miniPlayerIsOpen() { return isOpen(); }
