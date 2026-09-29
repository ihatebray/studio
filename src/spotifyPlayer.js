/* =========================================================================
 *  studio — Spotify playback (main process)
 *
 *  Runs the studio-spotify helper (Rust, librespot) and relays between it
 *  and the renderer. The helper plays straight to the sound card; this file
 *  only ever sees JSON control messages, never audio.
 *
 *    renderer ──ipc──▶ here ──stdin──▶ studio-spotify ──▶ speakers
 *    renderer ◀─ipc─── here ◀─stdout── (events: playing, position, ended…)
 *
 *  Lifecycle: started in the background a few seconds after launch when
 *  you're signed in (so the first play doesn't wait for it to connect), or
 *  on first use otherwise; signed in with the same token the Spotify account
 *  in Settings holds, restarted with backoff if it dies, stopped on quit.
 *  Commands sent while it's starting or signing in are queued and sent once
 *  it's connected.
 * ========================================================================= */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { getSpotifyHelperPath, spotifyHelperInstalled } from './binPaths.js';
import { getAccessToken, partnerState, onPartnerChange } from './spotifyPartner.js';

let proc = null;
let status = 'stopped'; // stopped | starting | signingIn | ready | error
let lastError = null;   // { kind, message }
let account = null;     // { user, country, account }
let queue = [];         // commands waiting for 'ready'
let restarts = 0;
let restartTimer = null;
let quitting = false;
let intentionalStop = false;
let spawnedFrom = 0;    // the helper binary's mtime when it was started
let last = { id: null, state: 'idle', positionMs: 0 }; // for late subscribers

function broadcast(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('spotifyPlayer:event', payload); } catch { /* closing */ }
  }
}

function setStatus(next) {
  status = next;
  broadcast({ event: 'status', ...snapshot() });
}

export function snapshot() {
  return {
    status,
    installed: spotifyHelperInstalled(),
    error: lastError,
    account,
    playback: last,
  };
}

function write(cmd) {
  if (!proc?.stdin?.writable) return false;
  try { proc.stdin.write(`${JSON.stringify(cmd)}\n`); return true; } catch { return false; }
}

function onLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  switch (ev.event) {
    case 'ready':
      signIn();
      return;
    case 'connected':
      restarts = 0;
      lastError = null;
      account = { user: ev.user, country: ev.country, account: ev.account };
      setStatus('ready');
      for (const c of queue.splice(0)) write(c);
      return;
    case 'authError':
      lastError = { kind: ev.kind, message: ev.message };
      queue = [];
      setStatus('error');
      return;
    case 'loading': case 'playing': case 'paused': case 'position': case 'seeked':
      last = { id: ev.id, state: ev.event === 'position' || ev.event === 'seeked' ? last.state : ev.event, positionMs: ev.positionMs || 0 };
      broadcast(ev);
      return;
    case 'ended': case 'stopped': case 'unavailable':
      last = { id: ev.id, state: ev.event, positionMs: last.positionMs };
      broadcast(ev);
      return;
    default:
      broadcast(ev);
  }
}

/* Sign-ins. Like Sonora: a fresh token only when the Settings sign-in just
   changed (it may be another account); every other start reconnects with the
   reusable sign-in librespot saved, and falls back to the token if Spotify
   refuses that. */
let freshSignIn = false;

async function signIn() {
  setStatus('signingIn');
  const st = partnerState();
  if (!st.connected) {
    lastError = { kind: 'expired', message: 'Sign in to Spotify in Settings → Connections first.' };
    setStatus('error');
    return;
  }
  if (st.canStream === false) {
    lastError = { kind: 'scope', message: 'Sign in to Spotify once more in Settings to allow playback.' };
    setStatus('error');
    return;
  }
  let token = null;
  try { token = await getAccessToken(); } catch { /* fall back to the helper's cached credentials */ }
  write({ cmd: 'auth', token, preferCached: !freshSignIn });
  freshSignIn = false;
}

function start() {
  if (proc || quitting) return;
  if (!spotifyHelperInstalled()) {
    lastError = { kind: 'missing', message: 'The Spotify helper isn’t built yet. Run: npm run setup:spotify' };
    setStatus('error');
    return;
  }
  lastError = null;
  setStatus('starting');
  const cacheDir = path.join(app.getPath('userData'), 'spotify-player');
  spawnedFrom = helperMtime();
  proc = spawn(getSpotifyHelperPath(), [cacheDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString('utf8').trim();
    if (s) console.log('[studio-spotify]', s.slice(0, 500));
  });
  proc.on('error', (e) => {
    lastError = { kind: 'crash', message: `Couldn’t start the Spotify helper: ${e.message}` };
    proc = null;
    setStatus('error');
  });
  proc.on('exit', (code) => {
    proc = null;
    if (quitting) return;
    if (intentionalStop) { intentionalStop = false; setStatus('stopped'); return; }
    broadcast({ event: 'stopped', id: last.id });
    last = { ...last, state: 'stopped' };
    /* Restart with backoff: 1s, 2s, 4s… capped at 30s, and give up after
       six tries in a row so a helper that can't run doesn't loop forever. */
    if (restarts >= 6) {
      lastError = { kind: 'crash', message: `The Spotify helper keeps exiting (code ${code}).` };
      setStatus('error');
      return;
    }
    const wait = Math.min(30_000, 1000 * 2 ** restarts);
    restarts += 1;
    setStatus('starting');
    clearTimeout(restartTimer);
    restartTimer = setTimeout(start, wait);
  });
}

const WARM_START_DELAY_MS = 3000;

/** Start the helper ahead of the first play, if it could sign in now. */
function warmUp() {
  if (proc || quitting || !spotifyHelperInstalled()) return;
  const st = partnerState();
  if (!st.connected || st.canStream === false) return;
  restarts = 0;
  start();
}

/** Queue or send a command; starts the helper if it isn't running. */
function command(cmd) {
  if (status === 'ready' && proc) { write(cmd); return { ok: true }; }
  if (status === 'error' && lastError?.kind !== 'crash') {
    return { ok: false, error: lastError?.message || 'Spotify playback isn’t available.' };
  }
  // Only the latest load matters; transport commands before it are moot.
  if (cmd.cmd === 'load') queue = queue.filter((c) => c.cmd === 'volume');
  queue.push(cmd);
  if (!proc) { restarts = 0; start(); }
  return { ok: true, queued: true };
}

function helperMtime() {
  try { return fs.statSync(getSpotifyHelperPath()).mtimeMs; } catch { return 0; }
}

/** The window is about to reload (the in-app reload button). The page that
 *  was driving playback is going away, so stop the sound; and if the helper
 *  binary has been rebuilt since it started, restart it so the new build is
 *  what plays next. Returns true when the helper is being restarted. */
export function prepareForReload() {
  if (!proc) return false;
  queue = [];
  if (helperMtime() > spawnedFrom) {
    intentionalStop = true;
    write({ cmd: 'quit' });
    const p = proc;
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
    setTimeout(() => { restarts = 0; warmUp(); }, WARM_START_DELAY_MS);
    return true;
  }
  write({ cmd: 'stop' });
  return false;
}

export function stopHelper() {
  quitting = true;
  clearTimeout(restartTimer);
  if (proc) {
    write({ cmd: 'quit' });
    const p = proc;
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
  }
}

export function registerSpotifyPlayerIpc(ipcMain) {
  ipcMain.handle('spotifyPlayer:state', () => snapshot());
  ipcMain.handle('spotifyPlayer:connect', () => {
    // Re-sign-in (after the Settings sign-in changes) or first start.
    lastError = null;
    restarts = 0;
    if (proc) signIn(); else start();
    return snapshot();
  });
  ipcMain.handle('spotifyPlayer:load', (_e, id, opts = {}) => command({
    cmd: 'load', id: String(id || ''), play: opts.play !== false, positionMs: Math.max(0, Math.round(opts.positionMs || 0)),
    // false only for a natural advance, so the old track's tail isn't cut.
    cut: opts.cut !== false,
  }));
  ipcMain.handle('spotifyPlayer:preload', (_e, id) => command({ cmd: 'preload', id: String(id || '') }));
  ipcMain.handle('spotifyPlayer:play', () => command({ cmd: 'play' }));
  ipcMain.handle('spotifyPlayer:pause', () => command({ cmd: 'pause' }));
  ipcMain.handle('spotifyPlayer:stop', () => command({ cmd: 'stop' }));
  ipcMain.handle('spotifyPlayer:seek', (_e, ms) => command({ cmd: 'seek', positionMs: Math.max(0, Math.round(ms || 0)) }));
  ipcMain.handle('spotifyPlayer:volume', (_e, v) => command({ cmd: 'volume', value: Math.min(1, Math.max(0, Number(v) || 0)) }));

  app.on('before-quit', stopHelper);

  /* Warm start. Launching the helper, connecting to Spotify and signing in
     takes a second or more, which used to land on the first press of play.
     A few seconds after launch, when the window has had its turn, it starts
     in the background instead, so the first play is as quick as the rest. */
  app.whenReady().then(() => {
    const t = setTimeout(warmUp, WARM_START_DELAY_MS);
    if (typeof t.unref === 'function') t.unref();
  });

  /* Follow the Settings sign-in: a new sign-in re-authenticates a running
     helper; signing out stops playback and the helper with it. */
  onPartnerChange(() => {
    // The stored sign-in, not the event: a cancelled or failed sign-in
    // reports connected:false while the previous sign-in is still there.
    const st = partnerState();
    if (st?.connected) {
      lastError = null;
      freshSignIn = true;
      if (proc) signIn();
      else {
        if (status === 'error') setStatus('stopped');
        warmUp();
      }
    } else if (proc) {
      intentionalStop = true;
      write({ cmd: 'stop' });
      write({ cmd: 'quit' });
      account = null;
    }
  });
}
