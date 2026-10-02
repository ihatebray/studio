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
import { notice } from './notices.js';
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

/** Gain past full volume (1–16), kept here so a restarted helper gets it. */
let boost = 1;

function write(cmd) {
  if (!proc?.stdin?.writable) return false;
  try { proc.stdin.write(`${JSON.stringify(cmd)}\n`); return true; } catch { return false; }
}

function onLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  switch (ev.event) {
    case 'ready':
      // The helper starts at no boost; carry the setting into a restart.
      if (boost !== 1) write({ cmd: 'boost', value: boost });
      signIn();
      return;
    case 'connected':
      restarts = 0;
      lastError = null;
      account = { user: ev.user, country: ev.country, account: ev.account };
      setStatus('ready');
      for (const c of queue.splice(0)) write(c);
      // Back after a stale session: the song that was playing picks up again.
      if (reconnecting) { reconnecting = false; broadcast({ event: 'reconnected' }); }
      return;
    case 'stale': {
      /* The helper's session stopped working (a dropped connection, or
         Spotify no longer handing out decryption keys on it) and it let the
         session go. What a restart used to fix: sign in again. */
      const now = Date.now();
      staleAt = staleAt.filter((t) => now - t < 2 * 60 * 1000);
      staleAt.push(now);
      if (staleAt.length > 3) {
        reconnecting = false;
        lastError = { kind: 'crash', message: 'The connection to Spotify keeps dropping.' };
        setStatus('error');
        notice({
          key: 'helper-stale-loop', kind: 'error', source: 'Playback',
          title: 'Spotify keeps dropping the connection',
          detail: `Studio reconnected to Spotify several times in two minutes and it went stale again each time (${ev.why}). Check your internet connection, then press play; if it keeps happening, restart Studio.`,
        });
        return;
      }
      const active = last.state === 'playing' || last.state === 'loading';
      notice({
        key: 'helper-stale', kind: 'info', source: 'Playback',
        title: 'Reconnected to Spotify',
        detail: `The connection to Spotify went stale (${ev.why}), which makes every song fail to load until it's renewed, usually after sleep or a network change. Studio reconnected by itself${active ? ' and picked the song back up where it was' : ''}.`,
        // Nothing was playing: worth a line in the panel, not a toast.
        quiet: !active,
        repeatAfterMs: 5 * 60 * 1000,
      });
      reconnecting = true;
      signIn();
      return;
    }
    case 'authError':
      lastError = { kind: ev.kind, message: ev.message };
      queue = [];
      setStatus('error');
      notice({
        key: `helper-auth-${ev.kind}`, kind: 'error', source: 'Playback',
        title: ev.kind === 'premium' ? 'Spotify playback needs Premium' : 'Spotify playback couldn’t sign in',
        detail: {
          premium: 'Spotify only lets Premium accounts stream to other apps. Saved Spotify songs won’t play until the account in Settings → Connections is Premium.',
          expired: 'The Spotify sign-in expired. Sign in again in Settings → Connections; saved Spotify songs play again right after.',
          network: `Studio couldn’t reach Spotify (${ev.message}). Check your connection; it tries again when you press play.`,
        }[ev.kind] || `Spotify refused the sign-in (${ev.message}). Try signing in again in Settings → Connections.`,
      });
      return;
    case 'loading': case 'playing': case 'paused': case 'position': case 'seeked':
      last = { id: ev.id, state: ev.event === 'position' || ev.event === 'seeked' ? last.state : ev.event, positionMs: ev.positionMs || 0 };
      broadcast(ev);
      return;
    case 'answer': {
      const p = requests.get(ev.req);
      if (!p) return;
      requests.delete(ev.req);
      clearTimeout(p.timer);
      if (ev.ok) p.resolve(ev.data);
      else p.reject(new Error(ev.error || 'the Spotify helper couldn’t answer'));
      return;
    }
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
let reconnecting = false; // signing in again after a stale session
let staleAt = [];         // when sessions went stale, for the give-up check

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
    notice({
      key: 'helper-missing', kind: 'error', source: 'Playback',
      title: 'The Spotify helper isn’t installed',
      detail: 'Saved Spotify songs and Spotify search need the studio-spotify helper. Build it with npm run setup:spotify in the Studio folder, then restart Studio.',
      repeatAfterMs: 60 * 60 * 1000,
    });
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
      notice({
        key: 'helper-crash', kind: 'error', source: 'Playback',
        title: 'Spotify playback stopped working',
        detail: `The playback helper crashed six times in a row (exit code ${code}), so Studio stopped restarting it. Rebuild it with npm run setup:spotify and restart Studio; the terminal shows the helper's own error lines.`,
      });
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
  if (cmd.cmd === 'load') queue = queue.filter((c) => c.cmd === 'volume' || c.cmd === 'boost');
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

/* ---- metadata requests ------------------------------------------------------
 * Search, album tracklists and artist discographies, answered by the helper
 * over its signed-in librespot session (studio-spotify/src/search.rs), the
 * way Sonora does it: Spotify's client endpoints, not the Web API, so none of
 * the Web API's or the Client ID's rate limits. Starts the helper if it isn't
 * running (the first request then waits for the sign-in). */
const requests = new Map(); // req → { resolve, reject, timer }
let requestSeq = 0;
const REQUEST_TIMEOUT_MS = 12_000;

function helperRequest(cmd, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!spotifyHelperInstalled()) return Promise.reject(new Error('The Spotify helper isn’t built.'));
  const st = partnerState();
  if (!st.connected || st.canStream === false) return Promise.reject(new Error('Spotify isn’t signed in for playback.'));
  return new Promise((resolve, reject) => {
    requestSeq += 1;
    const req = requestSeq;
    const timer = setTimeout(() => {
      requests.delete(req);
      reject(new Error('the Spotify helper didn’t answer in time'));
    }, timeoutMs);
    requests.set(req, { resolve, reject, timer });
    const r = command({ ...cmd, req });
    if (r && r.ok === false) {
      clearTimeout(timer);
      requests.delete(req);
      reject(new Error(r.error));
    }
  });
}

/** `{ tracks, albums, artists }` for a query. */
export function helperSearch(q) {
  const query = String(q || '').trim();
  if (!query) return Promise.resolve({ tracks: [], albums: [], artists: [] });
  return helperRequest({ cmd: 'search', q: query });
}
/** `{ album, artists, albumArtUrl, tracks }`, as spotify:albumTracks returns. */
export const helperAlbum = (id) => helperRequest({ cmd: 'album', id: String(id) });
/** `{ albums, topTracks }` for an artist. */
export const helperArtist = (id) => helperRequest({ cmd: 'artist', id: String(id) });
/** `{ releases, artistsChecked, artistsTotal }`: the followed artists' last `days`. */
export const helperReleases = (days = 60, ids = [], spotify = true) => helperRequest({ cmd: 'releases', days, ids, spotify }, 60_000);
/** Heart (or un-heart) songs through Spotify's collection service. */
export const helperLike = (ids, saved = true) => helperRequest({ cmd: 'like', ids: (ids || []).map(String), saved }, 20_000);
/** A playlist's songs / Liked Songs / songs by id, in the pages' track shape. */
export const helperPlaylist = (id) => helperRequest({ cmd: 'playlist', id: String(id) }, 30_000);
export const helperLiked = () => helperRequest({ cmd: 'liked' }, 30_000);
export const helperTracks = (ids) => helperRequest({ cmd: 'tracks', ids: (ids || []).map(String) });
/** `[{ id, name, image }]` for artist ids. */
export const helperArtists = (ids) => helperRequest({ cmd: 'artists', ids: (ids || []).map(String) });
/** One Pathfinder (web player GraphQL) query, sent by the helper with the
 *  session's own tokens, as Sonora does. Resolves to the query's `data`. */
export const helperPathfinder = (op, hash, variables) => helperRequest({ cmd: 'pathfinder', op, hash, variables: variables || {} }, 25_000);
/** An artist's whole discography from the session (artist pages). */
export const helperDiscography = (id) => helperRequest({ cmd: 'discography', id: String(id || '') }, 30_000);

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
  ipcMain.handle('spotifyPlayer:boost', (_e, v) => {
    boost = Math.min(16, Math.max(1, Number(v) || 1));
    write({ cmd: 'boost', value: boost }); // any time; a helper not up yet gets it on 'ready'
    return { ok: true };
  });
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
