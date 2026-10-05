/* =========================================================================
 *  studio — Spotify "partner" client (main process)
 *
 *  The same route Sonora takes, minus librespot: sign in as Spotify's own
 *  desktop client, then read the private Pathfinder GraphQL API the web player
 *  uses. That's where the things the public Web API never exposed live —
 *  per-track play counts, monthly listeners, artist bios, top cities, related
 *  artists — and it isn't subject to Developer Mode's quota or the endpoints
 *  Spotify cut in February 2026.
 *
 *  METADATA ONLY. Nothing here requests, streams, decrypts or stores audio.
 *  That line is deliberate and matches Sonora's own: the audio path in Studio
 *  stays YouTube / Soulseek.
 *
 *  This is an unofficial, undocumented interface. It can change without
 *  notice, and every failure below is surfaced with the step that failed
 *  (sign-in, client token, query hash, query) so a break is diagnosable
 *  rather than a blank page.
 *
 *  Pieces, in the order a request needs them:
 *    1. Access token   PKCE sign-in with Spotify's desktop client ID on a
 *                      loopback redirect (127.0.0.1:8989/login — the one
 *                      Sonora uses). Refreshed with the stored refresh token.
 *    2. Client token   clienttoken.spotify.com, the same call the web player
 *                      makes on load. Cached until it expires.
 *    3. Query hashes   Pathfinder only accepts persisted queries. Hashes are
 *                      read out of the web player's own JavaScript and cached
 *                      for a day; a rejected hash triggers one re-read.
 *                      A user override file wins over both, for when Spotify
 *                      moves faster than this parser.
 *    4. The query      POST api-partner.spotify.com/pathfinder/v2/query.
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import os from 'os';
import { app, BrowserWindow, shell } from 'electron';
import { notice, waitWords } from './notices.js';

const CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
const REDIRECT_PORT = 8989;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/login`;
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  // Playback through the studio-spotify helper, and Save (hearting a track).
  'streaming',
  'user-library-modify',
  'user-follow-read',
  'user-library-read',
  'user-read-email',
  'user-read-private',
  'user-read-recently-played',
  'user-top-read',
].join(' ');

const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query';
const WEB_API = 'https://api.spotify.com/v1';
const APP_PLATFORM = 'WebPlayer';
const FALLBACK_CLIENT_VERSION = '1.2.52.442.g0f2ccf3a';
const HASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* Operations Studio uses. Each maps to its GraphQL kind so the bundle scan
   matches `"name","query","<hash>"` exactly. */
const OPERATIONS = {
  queryArtistOverview: 'query',
  queryArtistDiscographyAll: 'query',
  getAlbum: 'query',
  getTrack: 'query',
  // Search, the way the web player (and Sonora) do it: one request answers
  // songs, albums and artists at once, on the web player's own budget.
  searchDesktop: 'query',
  // My Spotify's Home, as Sonora reads it: Spotify's own home feed and
  // Your Library, both from the web player, not the Web API.
  home: 'query',
  libraryV3: 'query',
  // Browse pages, for Made For You (Daily Mixes, Discover Weekly, Release
  // Radar), which Sonora adds to its home the same way.
  browsePage: 'query',
  // Browse's index of category pages, to find New Releases by name.
  browseAll: 'query',
  // One home shelf by its section uri, for Fresh New Music when the home
  // feed leaves it out.
  homeSection: 'query',
};

/* ------------------------------------------------------------ file store */

const dir = () => app.getPath('userData');
const tokenFile = () => path.join(dir(), 'spotify-partner-token.json');
const hashFile = () => path.join(dir(), 'spotify-pathfinder-hashes.json');
/* Hand-edited escape hatch: { "queryArtistOverview": "<64 hex>" }. */
const overrideFile = () => path.join(dir(), 'spotify-pathfinder-overrides.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.warn('[spotifyPartner] could not write', file, e?.message || e);
  }
}

class StepError extends Error {
  constructor(step, message, extra = {}) {
    super(message);
    this.step = step; // 'signin' | 'clienttoken' | 'hash' | 'query' | 'webapi' | 'ratelimit'
    Object.assign(this, extra);
  }
}

/* Rate limits. Spotify answers 429 with Retry-After in seconds, and on a hot
   account that can be minutes or hours. A short wait is absorbed here (once);
   anything longer is surfaced immediately as a 'ratelimit' error carrying the
   wait, so the page can say how long and fall back — the first version
   waited up to 10s and then retried forever, which on a long limit was a
   page stuck on "loading" with no error at all. */
const RATE_ABSORB_S = 4;
/* A request Spotify never answers must fail, not leave a page loading forever. */
const REQUEST_TIMEOUT_MS = 20_000;
function retryAfterOf(res) {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v : 30;
}
function waitText(sec) {
  if (sec < 90) return `${Math.ceil(sec)} seconds`;
  if (sec < 5400) return `${Math.ceil(sec / 60)} minutes`;
  return `${Math.round(sec / 3600)} hours`;
}
function rateLimited(sec) {
  return new StepError('ratelimit', `Spotify is rate-limiting this account. Try again in about ${waitText(sec)}.`, {
    retryAfter: Math.ceil(sec), retryAt: Date.now() + Math.ceil(sec) * 1000,
  });
}

const changeListeners = new Set();
/** Main-process subscribers to sign-in / sign-out (spotifyPlayer.js). */
export function onPartnerChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

function broadcast(channel, payload) {
  if (channel === 'spotifyPartner:changed') changeListeners.forEach((fn) => { try { fn(payload); } catch { /* ignore */ } });
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch { /* window closing */ }
  }
}

/* ------------------------------------------------------------ 1. sign-in */

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let pending = null;
function teardown() {
  if (!pending) return;
  try { pending.server.close(); } catch { /* ignore */ }
  clearTimeout(pending.timer);
  pending = null;
}

async function exchange(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new StepError('signin', data.error_description || data.error || `token endpoint ${res.status}`);
  }
  return data;
}

function saveTokens(data, prev = {}) {
  const tok = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || prev.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000,
    scope: data.scope || prev.scope || SCOPES,
    displayName: prev.displayName || '',
    userId: prev.userId || '',
    product: prev.product || '',
    savedAt: Date.now(),
  };
  writeJson(tokenFile(), tok);
  return tok;
}

function beginSignIn() {
  teardown();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const page = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>studio</title>
<body style="font-family:system-ui;background:#0d0d10;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="margin:0 0 8px">${msg}</h2><p style="opacity:.6;margin:0">You can close this tab.</p></div></body>`);
      };
      const url = new URL(req.url || '/', REDIRECT_URI);
      if (url.pathname !== '/login') { res.writeHead(404); res.end(); return; }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (err || !code || url.searchParams.get('state') !== state) {
        page(err === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in failed');
        teardown();
        broadcast('spotifyPartner:changed', { connected: false, error: err || 'bad callback' });
        return;
      }
      try {
        const data = await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
        let tok = saveTokens(data);
        try {
          const me = await webApi('/me');
          tok = { ...tok, displayName: me.display_name || me.id || '', userId: me.id || '', product: me.product || '' };
          writeJson(tokenFile(), tok);
        } catch { /* profile is cosmetic */ }
        page('Connected to studio');
        broadcast('spotifyPartner:changed', state_());
      } catch (e) {
        page('Sign-in failed');
        broadcast('spotifyPartner:changed', { connected: false, error: e.message });
      }
      teardown();
    });
    server.on('error', (e) => {
      resolve({ ok: false, error: e.code === 'EADDRINUSE'
        ? `Port ${REDIRECT_PORT} is in use by another program. Close it and try again.`
        : String(e.message || e) });
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const auth = new URL('https://accounts.spotify.com/authorize');
      auth.searchParams.set('client_id', CLIENT_ID);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('redirect_uri', REDIRECT_URI);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('state', state);
      auth.searchParams.set('scope', SCOPES);
      pending = { server, timer: setTimeout(teardown, 5 * 60 * 1000) };
      shell.openExternal(auth.toString());
      resolve({ ok: true });
    });
  });
}

export function signOut() {
  teardown();
  try { fs.unlinkSync(tokenFile()); } catch { /* not there */ }
  clientToken = null;
  broadcast('spotifyPartner:changed', { connected: false });
  return { ok: true };
}

function state_() {
  const t = readJson(tokenFile());
  if (!t?.refreshToken && !t?.accessToken) return { connected: false };
  /* Sign-ins from before playback existed lack the `streaming` scope; the
     helper can't use those tokens, so Settings asks for one more sign-in. */
  const canStream = String(t.scope || '').split(/\s+/).includes('streaming');
  return { connected: true, displayName: t.displayName || '', userId: t.userId || '', product: t.product || '', canStream };
}
export const partnerState = state_;

let refreshing = null;
export async function getAccessToken() { return accessToken(); }
async function accessToken() {
  const t = readJson(tokenFile());
  if (!t) throw new StepError('signin', 'Not signed in');
  if (t.accessToken && Date.now() < (t.expiresAt || 0)) return t.accessToken;
  if (!t.refreshToken) throw new StepError('signin', 'Session expired — sign in again');
  if (!refreshing) {
    refreshing = exchange({ grant_type: 'refresh_token', refresh_token: t.refreshToken })
      .then((data) => saveTokens(data, t))
      .finally(() => { refreshing = null; });
  }
  try {
    return (await refreshing).accessToken;
  } catch (e) {
    /* A refresh token that's been revoked or has aged out won't come back;
       make the UI say so instead of failing every request forever. */
    if (/invalid_grant|revoked|expired/i.test(e.message)) {
      signOut();
      throw new StepError('signin', 'Spotify ended the session — sign in again');
    }
    throw e;
  }
}

/* ------------------------------------------------------- 2. client token */
/* Protobuf, shaped exactly like librespot's request (core/src/spclient.rs).
 *
 * The first version sent the web player's JSON body (`js_sdk_data`) with the
 * desktop client ID, and clienttoken.spotify.com answered 400: the JSON shape
 * belongs to the web player's own client ID. librespot sends the desktop ID
 * with native platform data, which the service grants directly on Windows and
 * macOS and answers with a hash-cash challenge elsewhere. Both paths are here.
 * The version string is librespot's pinned semantic version, the one known to
 * be accepted with this client ID. */

const CLIENT_SEMVER = '1.2.52.442';
/* Sonora's Pathfinder headers: WebPlayer platform with this numeric version. */
const PATHFINDER_APP_VERSION = '896000000';

/* ---- minimal protobuf ---- */
function varint(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const pbKey = (field, wire) => varint((field << 3) | wire);
const pbInt = (field, n) => Buffer.concat([pbKey(field, 0), varint(n)]);
const pbBool = (field, b) => pbInt(field, b ? 1 : 0);
const pbBytes = (field, buf) => Buffer.concat([pbKey(field, 2), varint(buf.length), buf]);
const pbStr = (field, str) => pbBytes(field, Buffer.from(String(str), 'utf8'));
const pbMsg = (field, ...parts) => pbBytes(field, Buffer.concat(parts));

/** Decodes one message level into { field: [values] }. Length-delimited
 *  values stay Buffers; the caller decides what's a string and what's a
 *  nested message. */
function pbDecode(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let shift = 0n; let v = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return v;
  };
  while (i < buf.length) {
    const key = Number(readVarint());
    const field = key >> 3; const wire = key & 7;
    let val;
    if (wire === 0) val = readVarint();
    else if (wire === 2) { const len = Number(readVarint()); val = buf.subarray(i, i + len); i += len; }
    else if (wire === 1) { val = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { val = buf.subarray(i, i + 4); i += 4; }
    else throw new StepError('clienttoken', `unexpected protobuf wire type ${wire}`);
    (out[field] = out[field] || []).push(val);
  }
  return out;
}
const pbFirst = (msg, f) => (msg[f] ? msg[f][0] : undefined);

function platformData() {
  const osmod = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release();
  if (process.platform === 'win32') {
    const build = Number(String(os.release()).split('.')[2]) || 21370;
    const arm = process.arch === 'arm64';
    const x64 = process.arch === 'x64';
    const pe = arm ? 43620 : x64 ? 34404 : 332;
    const image = arm ? 452 : x64 ? 34404 : 332;
    return pbMsg(4,
      pbInt(1, 10), pbInt(3, build), pbInt(4, 2), pbInt(6, 9),
      pbInt(7, image), pbInt(8, pe), pbBool(10, true));
  }
  if (process.platform === 'darwin') {
    return pbMsg(3, pbStr(1, osmod || '14.0'), pbStr(2, 'iMac21,1'), pbStr(3, process.arch === 'arm64' ? 'aarch64' : 'x86_64'));
  }
  return pbMsg(5, pbStr(1, 'Linux'), pbStr(2, os.release()), pbStr(3, os.version ? os.version() : ''), pbStr(4, process.arch));
}

/* Hash cash, as librespot's util::solve_hash_cash: SHA-1 of an empty context
   seeds the counter; find a 16-byte suffix whose SHA-1 with the prefix ends in
   `length` zero bits (read as a big-endian i64 from bytes 12..20). */
function solveHashCash(prefixHex, length) {
  const prefix = Buffer.from(prefixHex, 'hex');
  const md0 = crypto.createHash('sha1').update(Buffer.alloc(0)).digest();
  const target = md0.readBigInt64BE(12);
  const started = Date.now();
  const suffix = Buffer.alloc(16);
  for (let counter = 0n; ; counter += 1n) {
    if (Date.now() - started > 5000) throw new StepError('clienttoken', 'hash cash challenge timed out');
    suffix.writeBigInt64BE(BigInt.asIntN(64, target + counter), 0);
    suffix.writeBigInt64BE(counter, 8);
    const md = crypto.createHash('sha1').update(prefix).update(suffix).digest();
    let v = BigInt.asUintN(64, md.readBigInt64BE(12));
    let tz = 0;
    if (v === 0n) tz = 64; else while (!(v & 1n)) { v >>= 1n; tz += 1; }
    if (tz >= length) return suffix.toString('hex').toUpperCase();
  }
}

async function postClientToken(body) {
  const res = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
    method: 'POST',
    headers: { Accept: 'application/x-protobuf', 'Content-Type': 'application/x-protobuf' },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    /* ClientTokenBadRequest { string message = 1 } */
    let why = '';
    try { why = String(pbFirst(pbDecode(buf), 1) || ''); } catch { /* not protobuf */ }
    throw new StepError('clienttoken', `client token refused (${res.status})${why ? `: ${why}` : ''}`);
  }
  return pbDecode(buf);
}

let clientToken = null; // { token, expiresAt }
let deviceId = null;
async function getClientToken() {
  if (clientToken && Date.now() < clientToken.expiresAt) return clientToken.token;
  if (!deviceId) {
    const saved = readJson(hashFile());
    deviceId = saved?.deviceId || crypto.randomBytes(20).toString('hex');
  }
  const request = Buffer.concat([
    pbInt(1, 1), // REQUEST_CLIENT_DATA_REQUEST
    pbMsg(2,
      pbStr(1, CLIENT_SEMVER),
      pbStr(2, CLIENT_ID),
      pbMsg(3, pbMsg(1, platformData()), pbStr(2, deviceId))),
  ]);

  let res = await postClientToken(request);
  for (let tries = 0; tries < 3; tries += 1) {
    const type = Number(pbFirst(res, 1) || 0);
    if (type === 1) {
      const granted = pbDecode(pbFirst(res, 2));
      const token = String(pbFirst(granted, 1) || '');
      if (!token) break;
      const ttl = Number(pbFirst(granted, 3) || pbFirst(granted, 2) || 1800);
      clientToken = { token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
      return token;
    }
    if (type === 2) {
      const ch = pbDecode(pbFirst(res, 3));
      const state = String(pbFirst(ch, 1) || '');
      const first = pbFirst(ch, 2);
      if (!first) throw new StepError('clienttoken', 'challenge response with no challenge');
      const challenge = pbDecode(first);
      const params = pbFirst(challenge, 4);
      if (!params) throw new StepError('clienttoken', `unsupported challenge type ${pbFirst(challenge, 1)}`);
      const hp = pbDecode(params);
      const suffix = solveHashCash(String(pbFirst(hp, 2) || ''), Number(pbFirst(hp, 1) || 0));
      const answer = Buffer.concat([
        pbInt(1, 2), // REQUEST_CHALLENGE_ANSWERS_REQUEST
        pbMsg(3, pbStr(1, state), pbMsg(2, pbInt(1, 3), pbMsg(4, pbStr(1, suffix)))),
      ]);
      res = await postClientToken(answer);
      continue;
    }
    break;
  }
  throw new StepError('clienttoken', 'client token service returned no token');
}

/* -------------------------------------------------------- 3. query hashes */

const sane = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

async function text(url) {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } });
  if (!res.ok) throw new StepError('hash', `${url} → ${res.status}`);
  return res.text();
}

function hashIn(js, op, kind) {
  const marker = `"${op}","${kind}","`;
  const at = js.indexOf(marker);
  if (at < 0) return null;
  const h = js.slice(at + marker.length, at + marker.length + 64);
  return sane(h) ? h : null;
}

/* The web player splits its code into webpack chunks, and several of the
   queries live in lazily-loaded ones. The runtime builds chunk URLs from two
   object literals — id → name and id → content hash — so both are read out
   of the entry bundle and every chunk URL reconstructed from them. */
function chunkUrls(entryJs, base) {
  const out = new Set();
  const m = /\.u=\w+=>\(?\(?(\{[^{}]*\})\[\w+\]\|\|\w+\)\+"\."\+(\{[^{}]*\})\[\w+\]\+"\.js"/.exec(entryJs);
  if (!m) return [];
  const toMap = (lit) => {
    const map = {};
    for (const [, k, v] of lit.matchAll(/"?([\w-]+)"?:"([^"]*)"/g)) map[k] = v;
    return map;
  };
  const names = toMap(m[1]);
  const hashes = toMap(m[2]);
  for (const [id, h] of Object.entries(hashes)) out.add(`${base}${names[id] || id}.${h}.js`);
  return [...out];
}

let scanning = null;
async function scanWebPlayer() {
  const html = await text('https://open.spotify.com/');
  const entry = /https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[^"]+\.js/.exec(html)?.[0];
  if (!entry) throw new StepError('hash', 'web player bundle not found on open.spotify.com');
  const version = /"clientVersion":"([^"]+)"/.exec(html)?.[1] || FALLBACK_CLIENT_VERSION;
  const base = entry.slice(0, entry.lastIndexOf('/') + 1);
  const js = await text(entry);

  const found = {};
  const collect = (src) => {
    for (const [op, kind] of Object.entries(OPERATIONS)) {
      if (!found[op]) { const h = hashIn(src, op, kind); if (h) found[op] = h; }
    }
  };
  collect(js);
  const missing = () => Object.keys(OPERATIONS).some((op) => !found[op]);
  if (missing()) {
    const urls = chunkUrls(js, base);
    /* Most-likely chunks first; stop as soon as everything is found. */
    urls.sort((a, b) => Number(/artist|album|track|discograph|search/i.test(b)) - Number(/artist|album|track|discograph|search/i.test(a)));
    for (let i = 0; i < urls.length && missing(); i += 6) {
      const batch = await Promise.all(urls.slice(i, i + 6).map((u) => text(u).catch(() => '')));
      batch.forEach(collect);
    }
  }
  const saved = readJson(hashFile()) || {};
  const next = {
    fetchedAt: Date.now(),
    clientVersion: version,
    deviceId: saved.deviceId || deviceId || crypto.randomBytes(16).toString('hex'),
    operations: { ...(saved.operations || {}), ...found },
  };
  deviceId = next.deviceId;
  writeJson(hashFile(), next);
  return next;
}

async function registry(force = false) {
  const saved = readJson(hashFile());
  if (!force && saved?.operations && Date.now() - (saved.fetchedAt || 0) < HASH_MAX_AGE_MS) return saved;
  if (!scanning) scanning = scanWebPlayer().finally(() => { scanning = null; });
  try {
    return await scanning;
  } catch (e) {
    if (saved?.operations) return saved; // stale beats nothing
    throw e;
  }
}

/* Hashes the web player bundle didn't give up (some queries live in chunks
   the scan doesn't reach): the shared registry Sonora reads its hashes from.
   Only hashes, public data, and only for queries the scan couldn't find. */
const HASH_WORKER = 'https://billowing-resonance-da83.johnwatson.workers.dev/hashes';
let workerHashes = { at: 0, operations: {} };
async function workerHash(op, stale = null) {
  if (stale || Date.now() - workerHashes.at > HASH_MAX_AGE_MS) {
    try {
      const url = stale ? `${HASH_WORKER}?stale=${encodeURIComponent(stale)}` : HASH_WORKER;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = res.ok ? await res.json() : null;
      if (body?.operations && typeof body.operations === 'object') workerHashes = { at: Date.now(), operations: body.operations };
      else workerHashes.at = Date.now() - HASH_MAX_AGE_MS + 60 * 60 * 1000; // try again in an hour
    } catch {
      workerHashes.at = Date.now() - HASH_MAX_AGE_MS + 60 * 60 * 1000;
    }
  }
  const h = workerHashes.operations?.[op];
  return sane(h) ? h : null;
}

const rescannedFor = new Map();
const lastWorkerHash = new Map();
async function hashFor(op, force = false) {
  const over = readJson(overrideFile());
  if (sane(over?.[op])) return { hash: over[op], version: (await registry().catch(() => null))?.clientVersion || FALLBACK_CLIENT_VERSION, fixed: true };
  let reg = await registry(force);
  /* A query added to OPERATIONS after the last scan isn't in the saved list
     until the daily rescan. Rescan for it now, once an hour at most. */
  if (!sane(reg.operations?.[op]) && !force && Date.now() - (rescannedFor.get(op) || 0) > 60 * 60 * 1000) {
    rescannedFor.set(op, Date.now());
    reg = await registry(true);
  }
  const hash = reg.operations?.[op];
  if (!sane(hash)) {
    const w = await workerHash(op, force ? (lastWorkerHash.get(op) || null) : null);
    if (w) { lastWorkerHash.set(op, w); return { hash: w, version: reg.clientVersion || FALLBACK_CLIENT_VERSION, fixed: false }; }
    throw new StepError('hash', `no hash found for ${op} in the web player`);
  }
  return { hash, version: reg.clientVersion || FALLBACK_CLIENT_VERSION, fixed: false };
}

/* ------------------------------------------------------------- 4. query */

/* After a 429, Pathfinder isn't asked again until Spotify's wait is over. */
let pathfinderBlockedUntil = 0;

/* Where Pathfinder queries go first. main.js points this at the playback
   helper, which sends them the way Sonora does: librespot's own login5 token
   and client token, through the session's HTTP client and its rate limiter.
   To Spotify that's a Spotify client asking, not a browser token dressed up
   as the web player, which is what this module sends below and what Spotify
   limited so readily. The Node route below is only for when the helper
   can't be used at all (not built, or not signed in for playback). */
let pathfinderSource = null;
export function setPathfinderSource(fn) { pathfinderSource = typeof fn === 'function' ? fn : null; }
const helperUnavailable = (msg) => /isn’t built|isn't built|isn’t signed in|isn't signed in|not signed in|didn’t answer in time|playback isn’t available/i.test(msg);

function pathfinderLimited(wait) {
  pathfinderBlockedUntil = Date.now() + wait * 1000;
  notice({
    key: 'spotify-pathfinder-limit', kind: 'warning', source: 'Spotify',
    title: 'Spotify asked Studio to slow down',
    detail: `Home, artist pages and search details pause for ${waitWords(wait)}. What's already loaded stays on screen, and Studio carries on after the wait.`,
    repeatAfterMs: 60 * 60 * 1000,
  });
  return rateLimited(wait);
}

async function send(op, variables, hash, version) {
  if (pathfinderBlockedUntil > Date.now()) throw rateLimited((pathfinderBlockedUntil - Date.now()) / 1000);
  if (pathfinderSource) {
    try {
      return await pathfinderSource(op, hash, variables);
    } catch (e) {
      const msg = String(e?.message || e);
      const limit = msg.match(/^ratelimit:(\d+)/);
      if (limit) throw pathfinderLimited(Math.max(1, Number(limit[1]) || 60));
      if (msg.startsWith('signin:')) throw new StepError('signin', msg.slice(7).trim());
      if (msg.startsWith('graphql:')) {
        const err = new StepError('query', `${op}: ${msg.slice(8).trim()}`);
        err.stale = /persisted|hash|not found/i.test(msg);
        throw err;
      }
      if (!helperUnavailable(msg)) throw new StepError('query', `${op}: ${msg}`);
      // The helper can't be used at all: the Node route below.
    }
  }
  const [token, ctoken] = await Promise.all([accessToken(), getClientToken()]);
  const res = await fetch(PATHFINDER, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'client-token': ctoken,
      'app-platform': APP_PLATFORM,
      'spotify-app-version': PATHFINDER_APP_VERSION,
      'User-Agent': BROWSER_UA,
    },
    body: JSON.stringify({
      operationName: op,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  });
  if (res.status === 429) throw pathfinderLimited(retryAfterOf(res));
  const body = await res.json().catch(() => null);
  if (res.status === 401) { clientToken = null; throw new StepError('signin', 'Spotify rejected the session (401)'); }
  if (!body || (!res.ok && !body.errors?.length)) throw new StepError('query', `${op} → HTTP ${res.status}`);
  if (body.errors?.length && !body.data) {
    const msg = body.errors.map((e) => e.message).join('; ');
    const err = new StepError('query', `${op}: ${msg}`);
    err.stale = /persisted|hash|not found/i.test(msg);
    throw err;
  }
  return body.data;
}

async function query(op, variables) {
  const first = await hashFor(op);
  try {
    return await send(op, variables, first.hash, first.version);
  } catch (e) {
    /* One retry against a freshly scanned bundle — the usual failure is a
       web player deploy that rotated the hash under us. */
    // Only a hash Spotify no longer knows is worth a rescan; anything else
    // would fail the same way with a fresh one.
    if (first.fixed || !e.stale || e.step === 'signin' || e.step === 'clienttoken' || e.step === 'ratelimit') throw e;
    const again = await hashFor(op, true);
    if (again.hash === first.hash && !e.stale) throw e;
    return send(op, variables, again.hash, again.version);
  }
}

/* --------------------------------------------------- Web API, same token */

/* After a rate limit longer than we'd sit through, every Web API call fails
   at once until the wait Spotify named is over. Asking anyway only earns a
   longer wait, and a page of feeds asks eight things at once. */
let webApiBlockedUntil = 0;
export function webApiRateLimit() {
  return webApiBlockedUntil > Date.now() ? { until: webApiBlockedUntil } : null;
}

async function webApi(p, attempt = 0, method = 'GET') {
  if (webApiBlockedUntil > Date.now()) throw rateLimited((webApiBlockedUntil - Date.now()) / 1000);
  const token = await accessToken();
  const res = await fetch(p.startsWith('http') ? p : `${WEB_API}${p}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 429) {
    const wait = retryAfterOf(res);
    if (wait <= RATE_ABSORB_S && attempt === 0) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return webApi(p, 1, method);
    }
    webApiBlockedUntil = Math.max(webApiBlockedUntil, Date.now() + wait * 1000);
    notice({
      key: 'spotify-webapi-limit', kind: 'warning', source: 'Spotify',
      title: 'Spotify’s Web API is busy',
      detail: `Spotify asked Studio to wait ${waitWords(wait)} before using its Web API again. That limit is shared with every Spotify desktop app, so it can trip without Studio doing much. Studio only uses it as a last resort now; playback, search, Home, New Releases and artist pages go through your own Spotify session instead.`,
      // Once an hour at most: a 59-second wait used to mean a toast a minute.
      repeatAfterMs: 60 * 60 * 1000,
    });
    throw rateLimited(wait);
  }
  if (res.status === 401) throw new StepError('signin', 'Spotify rejected the session (401)');
  if (res.status === 403 && method !== 'GET') throw new StepError('scope', 'Spotify refused the change (403). Sign in again in Settings to allow it.');
  if (!res.ok) throw new StepError('webapi', `Spotify returned HTTP ${res.status}`);
  // Writes (PUT /me/tracks) answer with an empty body.
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

export async function paged(first, cap = 2000) {
  const out = [];
  let next = first;
  while (next && out.length < cap) {
    const page = await webApi(next);
    out.push(...(page.items || []));
    next = page.next || null;
  }
  return out;
}

/* ------------------------------------------------------------- shaping */

const img = (sources, want = 640) => {
  const list = (sources || []).filter((s) => s?.url);
  if (!list.length) return null;
  return [...list].sort((a, b) => Math.abs((a.height || want) - want) - Math.abs((b.height || want) - want))[0].url;
};
const idOf = (uri) => String(uri || '').split(':').pop() || null;
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const artistsOf = (a) => (a?.items || []).map((x) => x?.profile?.name).filter(Boolean).join(', ');

function shapeRelease(r, group) {
  if (!r) return null;
  const d = r.date || {};
  const iso = d.isoString || (d.year ? `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}` : '');
  return {
    albumId: r.id || idOf(r.uri),
    name: r.name || '',
    type: String(r.type || group || '').toLowerCase(),
    group,
    releaseDate: iso.slice(0, 10),
    year: d.year || (iso ? Number(iso.slice(0, 4)) : null),
    albumArtUrl: img(r.coverArt?.sources, 2000),
    totalTracks: r.tracks?.totalCount || null,
    label: r.label || '',
  };
}

function releasesFrom(groups, group) {
  const out = [];
  for (const g of groups?.items || []) {
    for (const r of g?.releases?.items || []) {
      const s = shapeRelease(r, group);
      if (s?.albumId) out.push(s);
    }
  }
  return out;
}

function shapeTrack(t) {
  if (!t) return null;
  const album = t.albumOfTrack || {};
  return {
    spotifyId: t.id || idOf(t.uri),
    title: t.name || '',
    artists: artistsOf(t.artists),
    album: album.name || '',
    albumId: idOf(album.uri),
    albumArtUrl: img(album.coverArt?.sources, 2000),
    durationMs: t.duration?.totalMilliseconds || null,
    explicit: t.contentRating?.label === 'EXPLICIT',
    playcount: num(t.playcount),
  };
}

/* An artist's album on the way: Spotify's pre-release (the album page that
   counts down to release day), and anything in the discography dated after
   today. Read defensively: the pre-release has moved between field names
   (preRelease, preReleaseV2, a list of them), so any key that says
   pre-release is looked at. `releaseAt` is an exact moment when Spotify
   gives one; a date alone (or midnight UTC, which is how a date-only release
   is written) is left as `releaseDate`, so the countdown can aim at local
   midnight, which is when the album appears. */
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function upcomingFrom(a) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  const add = (x) => {
    if (!x?.name || !(x.releaseAt || x.releaseDate)) return;
    const day = (x.releaseDate || x.releaseAt).slice(0, 10);
    if (day < today) return;
    if (out.some((o) => (x.id && o.id === x.id) || normName(o.name) === normName(x.name))) return;
    out.push(x);
  };
  const when = (d) => {
    const iso = String(d?.isoString || '');
    if (iso && d?.precision !== 'DAY' && !/T00:00:00(\.0+)?Z$/.test(iso)) return { releaseAt: iso, releaseDate: '' };
    if (iso) return { releaseAt: '', releaseDate: iso.slice(0, 10) };
    if (d?.year && d?.month && d?.day) return { releaseAt: '', releaseDate: `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` };
    return { releaseAt: '', releaseDate: '' };
  };
  /* The whole overview, walked: a pre-release (preReleaseContent) or any
     album dated today or later, wherever this version of the response puts
     it. Other artists' records (appears on, related) are skipped. */
  const seen = new Set();
  const walk = (o, depth, pre) => {
    if (!o || typeof o !== 'object' || depth > 8 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1, pre); return; }
    const c = o.preReleaseContent && typeof o.preReleaseContent === 'object' ? o.preReleaseContent : null;
    if (c) {
      add({
        id: idOf(c.uri) || idOf(o.uri), name: c.name || '', type: String(c.type || 'album').toLowerCase(),
        coverUrl: img(c.coverArt?.sources, 640), ...when(o.releaseDate || c.releaseDate || c.date), countdown: true,
      });
    } else if (o.name && /^spotify:album:/.test(String(o.uri || '')) && (o.date || o.releaseDate || o.preReleaseEndDateTime)) {
      /* preReleaseV2.data carries its release moment as preReleaseEndDateTime
         (when the countdown ends), e.g. 2026-10-23T04:00:00Z. */
      add({
        id: o.id || idOf(o.uri), name: o.name, type: String(o.type || 'album').toLowerCase(),
        coverUrl: img(o.coverArt?.sources, 640), ...when(o.preReleaseEndDateTime || o.releaseDate || o.date), countdown: pre || !!o.preReleaseEndDateTime,
      });
    }
    for (const [k, v] of Object.entries(o)) {
      if (/^(relatedContent|appearsOn|relatedArtists|related)$/.test(k)) continue;
      walk(v, depth + 1, pre || /pre.?release/i.test(k));
    }
  };
  walk(a, 0, false);
  return out;
}

/* ------------------------------------------------------------ public API */

/* Spotify sends bios as HTML: links as <a> tags, and apostrophes, quotes
   and ampersands as entities (didn&#39;t, &amp;). Tags go, paragraph
   breaks stay, and every entity, named or numeric, becomes its character. */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' };
function htmlText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    // Each break Spotify sends starts a new paragraph, the way its app
    // shows it: normalise any run of them to one blank line.
    .replace(/[ \t]*\r?\n\s*/g, '\n')
    .replace(/\n+/g, '\n\n')
    .trim();
}

async function artistOverview(artistId) {
  const data = await query('queryArtistOverview', {
    uri: `spotify:artist:${artistId}`, locale: '', includePrerelease: true, preReleaseV2: true,
  });
  const a = data?.artistUnion;
  if (!a) throw new StepError('query', 'artist not found');
  const disc = a.discography || {};
  const stats = a.stats || {};
  const related = a.relatedContent || {};
  return {
    id: artistId,
    name: a.profile?.name || '',
    verified: !!a.profile?.verified,
    biography: htmlText(a.profile?.biography?.text) || null,
    avatar: img(a.visuals?.avatarImage?.sources, 640),
    header: img(a.headerImage?.data?.sources || a.visuals?.headerImage?.sources, 1280),
    gallery: (a.visuals?.gallery?.items || []).map((g) => img(g?.sources, 1280)).filter(Boolean).slice(0, 6),
    monthlyListeners: num(stats.monthlyListeners),
    followers: num(stats.followers),
    worldRank: num(stats.worldRank),
    topCities: (stats.topCities?.items || []).map((c) => ({
      city: c.city, country: c.country, listeners: num(c.numberOfListeners),
    })).filter((c) => c.city).slice(0, 5),
    topTracks: (disc.topTracks?.items || []).map((i) => shapeTrack(i?.track)).filter(Boolean),
    latest: shapeRelease(disc.latest, 'latest'),
    upcoming: upcomingFrom(a),
    /* For the log when no countdown is found: the overview's top-level
       fields and anything about pre-releases, as Spotify sent them. */
    preDiag: `fields: ${Object.keys(a).join(', ')} | pre-release: ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => /pre/i.test(k)))).slice(0, 800)}`,
    albums: releasesFrom(disc.albums, 'album'),
    singles: releasesFrom(disc.singles, 'single'),
    compilations: releasesFrom(disc.compilations, 'compilation'),
    appearsOn: (related.appearsOn?.items || []).flatMap((g) => (g?.releases?.items || []).map((r) => shapeRelease(r, 'appears_on'))).filter(Boolean).slice(0, 12),
    related: (related.relatedArtists?.items || []).map((r) => ({
      id: r.id || idOf(r.uri), name: r.profile?.name || '', image: img(r.visuals?.avatarImage?.sources, 300),
    })).filter((r) => r.id && r.name).slice(0, 12),
    fetchedAt: Date.now(),
  };
}

/* The full discography. The overview only carries the handful of releases
   the artist page shows above the fold (Sonora loads the rest separately for
   the same reason), so the complete list comes from the catalogue endpoint,
   with the same signed-in token. Newest first within each group. */
async function artistDiscography(artistId) {
  const out = [];
  let next = `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single,compilation,appears_on&limit=50&market=from_token`;
  while (next && out.length < 400) {
    const page = await webApi(next);
    for (const a of page.items || []) {
      out.push({
        albumId: a.id,
        name: a.name,
        group: a.album_group || a.album_type || 'album',
        type: a.album_type || '',
        releaseDate: a.release_date || '',
        year: a.release_date ? Number(String(a.release_date).slice(0, 4)) : null,
        albumArtUrl: a.images?.[0]?.url || a.images?.[1]?.url || null, // [0] is the largest
        totalTracks: a.total_tracks || null,
        artists: (a.artists || []).map((x) => x.name).join(', '),
      });
    }
    next = page.next || null;
  }
  /* Spotify lists the explicit and clean cut, and every regional reissue, as
     separate releases. Same group + same name + same year is one record. */
  const seen = new Set();
  return out.filter((r) => {
    const k = `${r.group}|${String(r.name).toLowerCase()}|${r.year || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
}

/* A tracklist in the same shape spotifyClient.spotifyGetAlbumTracks returns,
   so main.js can hand it to the search panel unchanged. Through the signed-in
   token it isn't subject to Developer Mode's quota. */
export async function albumTracks(albumId) {
  const a = await webApi(`/albums/${encodeURIComponent(albumId)}?market=from_token`);
  const album = a.name || '';
  const albumArtUrl = a.images?.[0]?.url || a.images?.[1]?.url || '';
  const albumArtists = (a.artists || []).map((x) => x.name).join(', ');
  const tracks = [];
  let page = a.tracks;
  while (page) {
    for (const t of page.items || []) {
      tracks.push({
        spotifyId: t.id, title: t.name,
        artists: (t.artists || []).map((x) => x.name).join(', '),
        album, albumArtUrl, albumArtists,
        durationMs: t.duration_ms || 0, trackNumber: t.track_number || 0, discNumber: t.disc_number || 1,
        spotifyUrl: t.external_urls?.spotify || '', explicit: !!t.explicit,
      });
    }
    page = page.next ? await webApi(page.next) : null;
  }
  tracks.sort((x, y) => (x.discNumber - y.discNumber) || (x.trackNumber - y.trackNumber));
  return { album, artists: albumArtists, albumArtUrl, tracks };
}



/* Catalogue search through the signed-in account, in the exact shapes
   spotifyClient's search functions return, so main.js can use it as a
   fallback between the Client ID route and iTunes without the renderer
   knowing the difference. */
export async function searchCatalogue(kind, q) {
  const query = String(q || '').trim();
  if (!query) return [];
  const type = kind === 'tracks' ? 'track' : kind === 'albums' ? 'album' : 'artist';
  const data = await webApi(`/search?type=${type}&limit=20&market=from_token&q=${encodeURIComponent(query)}`);
  if (type === 'track') {
    return (data?.tracks?.items || []).filter((t) => t?.id).map((t) => ({
      spotifyId: t.id, title: t.name,
      artists: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name || '', albumId: t.album?.id || null,
      albumArtUrl: t.album?.images?.[0]?.url || t.album?.images?.[1]?.url || '',
      durationMs: t.duration_ms || 0, spotifyUrl: t.external_urls?.spotify || '',
      popularity: t.popularity ?? 0, explicit: !!t.explicit,
      trackNumber: t.track_number || null, discNumber: t.disc_number || null,
      releaseDate: t.album?.release_date || '', primaryArtistId: t.artists?.[0]?.id || '',
    }));
  }
  if (type === 'album') {
    return (data?.albums?.items || []).filter((a) => a?.id).map((a) => ({
      albumId: a.id, name: a.name,
      artists: (a.artists || []).map((x) => x.name).join(', '),
      albumArtUrl: a.images?.[0]?.url || a.images?.[1]?.url || '',
      totalTracks: a.total_tracks || 0, releaseDate: a.release_date || '',
      spotifyUrl: a.external_urls?.spotify || '', albumType: a.album_type || '',
    }));
  }
  return (data?.artists?.items || []).filter((a) => a?.id).map((a) => ({
    id: a.id, name: a.name,
    genres: Array.isArray(a.genres) ? a.genres : [],
    followers: Number.isFinite(a.followers?.total) ? a.followers.total : null,
    popularity: Number.isFinite(a.popularity) ? a.popularity : null,
    image: Array.isArray(a.images) && a.images.length ? [...a.images].sort((x, y) => (y.width || 0) - (x.width || 0))[0].url : null,
  }));
}

/* ------------------------------------------ Pathfinder search and artists
 * What InstantSearch uses first when the account is connected. The public
 * Web API search (above) and the Client ID behind it have small budgets:
 * three searches per settled keystroke, a few requests each, used them up in
 * a couple of queries. The web player's search answers songs, albums and
 * artists in ONE request, and the three callers for the same query share it.
 * Shapes match searchCatalogue's, so nothing downstream changes. */

const SEARCH_TTL_MS = 10 * 60 * 1000;
const pfSearches = new Map(); // lowercased query → { at, promise }

const nodesOf = (block) => (block?.items || [])
  .map((it) => it?.item?.data || it?.data || null)
  .filter((d) => d && d.__typename !== 'NotFound' && d.__typename !== 'RestrictedContent');
const nameList = (a) => (a?.items || []).map((x) => x?.profile?.name).filter(Boolean).join(', ');

function shapeSearch(data) {
  const sv = data?.searchV2 || {};
  const tracks = nodesOf(sv.tracksV2).map((t, i) => {
    const id = t.id || idOf(t.uri);
    const album = t.albumOfTrack || {};
    return {
      spotifyId: id, title: t.name || '', artists: nameList(t.artists),
      album: album.name || '', albumId: album.id || idOf(album.uri),
      albumArtUrl: img(album.coverArt?.sources, 640) || '',
      durationMs: t.duration?.totalMilliseconds || 0,
      spotifyUrl: id ? `https://open.spotify.com/track/${id}` : '',
      // No popularity in this response; Spotify's own order stands in for it.
      popularity: Math.max(1, 100 - i * 4),
      explicit: t.contentRating?.label === 'EXPLICIT',
      trackNumber: t.trackNumber || null, discNumber: t.discNumber || null,
      releaseDate: '', primaryArtistId: idOf(t.artists?.items?.[0]?.uri) || '',
    };
  }).filter((t) => t.spotifyId && t.title);
  const albums = nodesOf(sv.albumsV2).map((a) => {
    const id = a.id || idOf(a.uri);
    const type = String(a.type || '').toLowerCase();
    return {
      albumId: id, name: a.name || '', artists: nameList(a.artists),
      albumArtUrl: img(a.coverArt?.sources, 640) || '',
      totalTracks: a.tracks?.totalCount || a.tracksV2?.totalCount || 0,
      releaseDate: String(a.date?.isoString || (a.date?.year ? a.date.year : '')).slice(0, 10),
      spotifyUrl: id ? `https://open.spotify.com/album/${id}` : '',
      albumType: type === 'ep' ? 'single' : type,
    };
  }).filter((a) => a.albumId && a.name);
  const artists = nodesOf(sv.artists).map((a, i) => ({
    id: a.id || idOf(a.uri), name: a.profile?.name || '',
    genres: [],
    /* No follower count either. InstantSearch weighs same-name artists by
       it; Spotify's ranking (the bigger act first) is the stand-in. */
    followers: Math.round(1e6 / (i + 1)),
    popularity: null,
    image: img(a.visuals?.avatarImage?.sources, 640),
  })).filter((a) => a.id && a.name);
  return { tracks, albums, artists };
}

async function searchAll(q) {
  const key = String(q || '').trim().toLowerCase();
  const hit = pfSearches.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.promise;
  const promise = query('searchDesktop', {
    searchTerm: String(q).trim(), offset: 0, limit: 20, numberOfTopResults: 5,
    includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: true,
    includeLocalConcertsField: false, includeAuthors: false,
  }).then(shapeSearch);
  pfSearches.set(key, { at: Date.now(), promise });
  promise.catch(() => pfSearches.delete(key));
  if (pfSearches.size > 300) pfSearches.delete(pfSearches.keys().next().value);
  return promise;
}

/** Songs, albums or artists for `q`, in searchCatalogue's shapes. */
export async function searchFast(kind, q) {
  if (!String(q || '').trim()) return [];
  const r = await searchAll(q);
  return r[kind] || [];
}

/** An artist's popular songs, from the overview the artist page already
 *  loads (Pathfinder, cached an hour), in the Client ID's track shape. */
export async function artistTopTracksFast(artistId) {
  const o = await cachedOverview(artistId);
  return (o.topTracks || []).map((t, i) => ({
    ...t,
    spotifyUrl: t.spotifyId ? `https://open.spotify.com/track/${t.spotifyId}` : '',
    popularity: Math.max(1, 100 - i * 4),
    trackNumber: null, discNumber: null, releaseDate: '', primaryArtistId: artistId,
  }));
}

/** An artist by name in the Client ID's spotifyArtistByName shape: an
 *  artist search (`find`, the helper's by default in main) plus the
 *  overview the artist page loads anyway (cached). */
export async function artistInfoFast(name, find = (n) => searchFast('artists', n)) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const hits = (await find(name)) || [];
  const hit = hits.find((a) => a.name.toLowerCase() === want) || hits[0];
  if (!hit) return null;
  const o = await cachedOverview(hit.id).catch(() => null);
  return {
    id: hit.id, name: o?.name || hit.name, genres: [],
    followers: o?.followers ?? null, popularity: null,
    image: o?.avatar || hit.image || null,
  };
}

/** An artist's albums and singles in the Client ID's shape: Pathfinder's
 *  full discography first (one request), the signed-in Web API second. */
export async function artistAlbumsFast(artistId) {
  const toRow = (r, group) => ({
    albumId: r.albumId, name: r.name, artists: r.artists || '',
    albumArtUrl: r.albumArtUrl || '', totalTracks: r.totalTracks || 0,
    releaseDate: r.releaseDate || '', albumGroup: group || r.group || r.type || 'album',
    spotifyUrl: r.albumId ? `https://open.spotify.com/album/${r.albumId}` : '',
  });
  try {
    const data = await query('queryArtistDiscographyAll', { uri: `spotify:artist:${artistId}`, offset: 0, limit: 100 });
    const items = data?.artistUnion?.discography?.all?.items || [];
    const rows = items.flatMap((g) => (g?.releases?.items || []).map((r) => {
      const s = shapeRelease(r, null);
      return s?.albumId ? toRow(s, s.type === 'ep' ? 'single' : s.type) : null;
    })).filter(Boolean);
    if (rows.length) return rows;
  } catch (e) {
    if (e?.step === 'ratelimit') throw e;
  }
  const all = await artistDiscography(artistId);
  return all.filter((r) => r.group === 'album' || r.group === 'single').map((r) => toRow(r, r.group));
}

/* ------------------------------------------- Home feed and Your Library
 * Parsed the way Sonora reads them (pathfinder/browse.rs, library.rs). Items
 * come out as { kind, id, name, sub, image }, kind being playlist, album,
 * artist or liked. */

function libraryCard(uri, d) {
  if (!d) return null;
  switch (d.__typename) {
    case 'Playlist': return {
      kind: 'playlist', id: idOf(uri || d.uri), name: d.name || '',
      sub: `Playlist${d.ownerV2?.data?.name ? ` · ${d.ownerV2.data.name}` : ''}`,
      image: img(d.images?.items?.[0]?.sources, 300),
      cover: img(d.images?.items?.[0]?.sources, 640),
    };
    case 'Album': {
      const artists = nameList(d.artists);
      return { kind: 'album', id: idOf(uri || d.uri), name: d.name || '', sub: `Album${artists ? ` · ${artists}` : ''}`, image: img(d.coverArt?.sources, 300) };
    }
    case 'Artist': return {
      kind: 'artist', id: idOf(uri || d.uri), name: d.profile?.name || '', sub: 'Artist',
      image: img(d.visuals?.avatarImage?.sources, 300),
    };
    case 'PseudoPlaylist': return /collection(:tracks)?$/.test(uri || d.uri || '') ? {
      kind: 'liked', id: 'liked', name: d.name || 'Liked Songs',
      sub: Number(d.count) > 0 ? `${Number(d.count).toLocaleString()} songs` : 'Your liked songs',
      image: img(d.image?.sources, 300), count: Number(d.count) || null,
    } : null;
    default: return null;
  }
}
const cardOk = (c) => c && c.id && c.name;

/** Spotify's own home feed: `{ recents, shelves: [{ title, items }] }`. */
const FRESH_TITLE = /fresh new music/i;

export async function homeFeed() {
  const data = await query('home', {
    homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    sp_t: '', facet: '', sectionItemsLimit: 12, includeEpisodeContentRatingsV2: false,
  });
  const sections = data?.home?.sectionContainer?.sections?.items || [];
  let recents = [];
  const shelves = [];
  for (const sec of sections) {
    const kind = sec?.data?.__typename;
    const title = sec?.data?.title?.transformedLabel || '';
    const items = (sec?.sectionItems?.items || []).map((it) => libraryCard(it?.uri, it?.content?.data)).filter(cardOk);
    if (kind === 'HomeShortsSectionData' && !recents.length) recents = items;
    // Fresh New Music is kept whatever kind of section it arrives as.
    else if ((kind === 'HomeGenericSectionData' || FRESH_TITLE.test(title)) && items.length) {
      shelves.push({ title, uri: sec?.uri || sec?.data?.uri || null, items });
    }
  }
  if (!recents.length && !shelves.length) throw new StepError('query', 'the home feed had nothing Studio can show');
  return { recents, shelves };
}


/** A browse page's shelves (`spotify:page:<id>`), as home shelves:
 *  [{ title, items }]. Made For You is one: Daily Mixes, Discover Weekly,
 *  Release Radar, On Repeat and the rest of your personal playlists. */
export const MADE_FOR_YOU_PAGE = '0JQ5DAt0tbjZptfcdMSKl3';
export async function browseShelves(pageId) {
  const data = await query('browsePage', {
    uri: `spotify:page:${pageId}`,
    pagePagination: { offset: 0, limit: 20 },
    sectionPagination: { offset: 0, limit: 12 },
    browseEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
    includeEpisodeContentRatingsV2: false,
  });
  const sections = data?.browse?.sections?.items || [];
  return sections.map((sec) => ({
    title: sec?.data?.title?.transformedLabel || '',
    items: (sec?.sectionItems?.items || []).map((it) => libraryCard(it?.uri, it?.content?.data)).filter(cardOk),
  })).filter((sh) => sh.items.length);
}

/** Browse's category pages: [{ id, name }] (`spotify:page:<id>`). */
export async function browseCards() {
  const data = await query('browseAll', {
    pagePagination: { offset: 0, limit: 10 },
    sectionPagination: { offset: 0, limit: 99 },
    browseEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
  });
  const out = [];
  for (const sec of data?.browseStart?.sections?.items || []) {
    for (const it of sec?.sectionItems?.items || []) {
      const d = it?.content?.data;
      const id = String(it?.uri || '').startsWith('spotify:page:') ? it.uri.slice('spotify:page:'.length) : null;
      const name = d?.data?.cardRepresentation?.title?.transformedLabel || '';
      if (d?.__typename === 'BrowseSectionContainer' && id && name) out.push({ id, name });
    }
  }
  return out;
}

/** Your Library, most recently played first: playlists, albums, artists
 *  and Liked Songs, in one request. */
export async function libraryItems() {
  const data = await query('libraryV3', {
    filters: [], order: 'Recents', textFilter: '', features: ['LIKED_SONGS'],
    limit: 100, offset: 0, flatten: false, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: true,
  });
  const page = data?.me?.libraryV3;
  const items = (page?.items || []).map((row) => libraryCard(row?.item?._uri || row?.item?.data?.uri, row?.item?.data)).filter(cardOk);
  return { items, total: page?.totalCount || items.length };
}

/* ------------------------------------------------ Save (stream, no file) */

/** One track in searchCatalogue's shape, for filling in a Save's details. */
export async function trackById(id) {
  const t = await webApi(`/tracks/${encodeURIComponent(id)}?market=from_token`);
  if (!t?.id) return null;
  return {
    spotifyId: t.id, title: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '', albumId: t.album?.id || null,
    albumArtUrl: t.album?.images?.[0]?.url || t.album?.images?.[1]?.url || '',
    durationMs: t.duration_ms || 0, explicit: !!t.explicit,
    trackNumber: t.track_number || null, discNumber: t.disc_number || null,
    releaseDate: t.album?.release_date || '',
  };
}

/**
 * The same track through the web player's own API (Pathfinder getTrack), in
 * trackById's shape. A different endpoint with its own rate limit, so it
 * usually still answers when the Web API is refusing.
 */
export async function trackByIdPathfinder(id) {
  const data = await query('getTrack', { uri: `spotify:track:${id}` });
  const t = data?.trackUnion;
  if (!t?.name) return null;
  const album = t.albumOfTrack || {};
  const names = [...(t.firstArtist?.items || []), ...(t.otherArtists?.items || []), ...(t.artists?.items || [])]
    .map((a) => a?.profile?.name).filter(Boolean);
  const d = album.date || {};
  return {
    spotifyId: id, title: t.name,
    artists: [...new Set(names)].join(', '),
    album: album.name || '', albumId: idOf(album.uri),
    albumArtUrl: img(album.coverArt?.sources, 640) || '',
    durationMs: t.duration?.totalMilliseconds || 0,
    explicit: t.contentRating?.label ? t.contentRating.label === 'EXPLICIT' : undefined,
    trackNumber: num(t.trackNumber), discNumber: num(t.discNumber),
    releaseDate: d.isoString ? String(d.isoString).slice(0, 10) : (d.year ? String(d.year) : ''),
  };
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The Spotify track for a title + artist that came from somewhere else
 * (the iTunes charts, a release list). Field-filtered search first, then a
 * plain one; the pick must share the title and the first artist, and the
 * closest duration wins among those. `search` defaults to the signed-in
 * account; Save passes the Client ID search when that one is rate-limited.
 */
export async function findTrack(title, artists, durationMs = 0, search = (q) => searchCatalogue('tracks', q)) {
  const first = String(artists || '').split(/,(?=\s)|&| feat\.? | ft\.? | x /i)[0].trim();
  const want = fold(title);
  const wantArtist = fold(first);
  for (const q of [`track:${title} artist:${first}`, `${first} ${title}`]) {
    const hits = await search(q);
    const ok = hits.filter((h) => fold(h.title) === want && fold(h.artists).includes(wantArtist));
    if (ok.length) {
      if (!(durationMs > 0)) return ok[0];
      return [...ok].sort((a, b) => Math.abs(a.durationMs - durationMs) - Math.abs(b.durationMs - durationMs))[0];
    }
  }
  return null;
}

/* Popular songs without play counts, for when the overview (Pathfinder) is
   the thing that's rate-limited or broken. Different endpoint, different
   limit bucket — often still answering. */
export async function artistTopTracks(artistId) {
  const data = await webApi(`/artists/${encodeURIComponent(artistId)}/top-tracks?market=from_token`);
  return (data?.tracks || []).map((t) => ({
    spotifyId: t.id, title: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '', albumId: t.album?.id || null,
    albumArtUrl: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
    durationMs: t.duration_ms || null, explicit: !!t.explicit, playcount: null,
  }));
}

export async function findArtist(name) {
  const q = encodeURIComponent(String(name || '').trim());
  if (!q) return null;
  const data = await webApi(`/search?type=artist&limit=5&q=${q}`);
  const want = String(name).trim().toLowerCase();
  const items = data?.artists?.items || [];
  const hit = items.find((a) => String(a.name).toLowerCase() === want) || items[0];
  return hit ? { id: hit.id, name: hit.name, image: hit.images?.[0]?.url || null } : null;
}

/* ---- the signed-in user's own Spotify ---- */



/* Walks every step on a known artist and reports where it stops. Settings
   calls this so "it doesn't work" comes with a reason. */
export async function diagnose() {
  const steps = [];
  const run = async (step, fn) => {
    try { const detail = await fn(); steps.push({ step, ok: true, detail }); return true; } catch (e) {
      steps.push({ step, ok: false, detail: String(e?.message || e) });
      return false;
    }
  };
  if (!(await run('Sign-in', async () => { await accessToken(); return state_().displayName || 'ok'; }))) return steps;
  if (!(await run('Web player scan', async () => {
    const r = await registry(true);
    const ops = Object.keys(OPERATIONS);
    const miss = ops.filter((op) => !sane(r.operations?.[op]));
    if (!sane(r.operations?.queryArtistOverview)) throw new Error(`artist query not found (missing: ${miss.join(', ')})`);
    return `${ops.length - miss.length}/${ops.length} queries found${miss.length ? ` (missing: ${miss.join(', ')})` : ''}`;
  }))) return steps;
  if (!(await run('Client token', async () => { clientToken = null; await getClientToken(); return 'granted'; }))) return steps;
  await run('Artist overview', async () => {
    const hit = await findArtist('Daft Punk'); // any well-populated artist page will do
    if (!hit) throw new Error('artist search returned nothing');
    const o = await artistOverview(hit.id);
    return `${o.name}: ${o.monthlyListeners ? `${o.monthlyListeners.toLocaleString()} monthly listeners` : 'no listener count'}, ${o.topTracks.length} top tracks`;
  });
  return steps;
}

/* ----------------------------------------------------------------- IPC */

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) {
    return { ok: false, step: e?.step || 'query', error: String(e?.message || e), retryAfter: e?.retryAfter || null };
  }
};

/* Artist overviews are the heavy call and change slowly; an hour in memory
   keeps page flips free without serving yesterday's listener count. */
const overviewCache = new Map();
const discogCache = new Map();
async function cachedOverview(id) {
  const hit = overviewCache.get(id);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
  const data = await artistOverview(id);
  overviewCache.set(id, { at: Date.now(), data });
  return data;
}

/** Albums on the way for an artist (see upcomingFrom). */
export async function artistUpcoming(id) {
  return (await cachedOverview(id)).upcoming || [];
}
export async function artistUpcomingDiag(id) {
  return (await cachedOverview(id)).preDiag || '';
}

/* Where artist discographies come from first. main.js points this at the
   playback helper (which imports this module, so it can't be imported back). */
let discographySource = null;
export function setDiscographySource(fn) { discographySource = typeof fn === 'function' ? fn : null; }

export function registerSpotifyPartnerIpc(ipcMain) {
  ipcMain.handle('spotifyPartner:state', () => state_());
  ipcMain.handle('spotifyPartner:signIn', () => beginSignIn());
  ipcMain.handle('spotifyPartner:signOut', () => signOut());
  ipcMain.handle('spotifyPartner:diagnose', wrap(diagnose));
  ipcMain.handle('spotifyPartner:artist', wrap(cachedOverview));
  ipcMain.handle('spotifyPartner:findArtist', wrap(findArtist));
  ipcMain.handle('spotifyPartner:discography', wrap(async (id) => {
    const hit = discogCache.get(id);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
    /* The playback helper's session first: it reads the discography the
       way Spotify's own clients do, with no Web API quota behind it. The
       Web API (one to eight requests per artist, on a client ID shared
       with every Spotify desktop app) is the fallback, and not even that
       while it's already rate-limiting. */
    let data = null;
    if (discographySource) {
      try { data = await discographySource(id); } catch (e) { console.warn('[discography] helper route failed:', e?.message || e); }
    }
    if (!Array.isArray(data)) {
      if (webApiRateLimit()) throw rateLimited((webApiBlockedUntil - Date.now()) / 1000);
      data = await artistDiscography(id);
    }
    discogCache.set(id, { at: Date.now(), data });
    return data;
  }));
}
