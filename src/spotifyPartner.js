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

export function beginSignIn() {
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
export function varint(n) {
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
export const pbInt = (field, n) => Buffer.concat([pbKey(field, 0), varint(n)]);
const pbBool = (field, b) => pbInt(field, b ? 1 : 0);
const pbBytes = (field, buf) => Buffer.concat([pbKey(field, 2), varint(buf.length), buf]);
export const pbStr = (field, str) => pbBytes(field, Buffer.from(String(str), 'utf8'));
export const pbMsg = (field, ...parts) => pbBytes(field, Buffer.concat(parts));

/** Decodes one message level into { field: [values] }. Length-delimited
 *  values stay Buffers; the caller decides what's a string and what's a
 *  nested message. */
export function pbDecode(buf) {
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

export function platformData() {
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
export function solveHashCash(prefixHex, length) {
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

export function hashIn(js, op, kind) {
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
export function chunkUrls(entryJs, base) {
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
    urls.sort((a, b) => Number(/artist|album|track|discograph/i.test(b)) - Number(/artist|album|track|discograph/i.test(a)));
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

async function hashFor(op, force = false) {
  const over = readJson(overrideFile());
  if (sane(over?.[op])) return { hash: over[op], version: (await registry().catch(() => null))?.clientVersion || FALLBACK_CLIENT_VERSION, fixed: true };
  const reg = await registry(force);
  const hash = reg.operations?.[op];
  if (!sane(hash)) throw new StepError('hash', `no hash found for ${op} in the web player`);
  return { hash, version: reg.clientVersion || FALLBACK_CLIENT_VERSION, fixed: false };
}

/* ------------------------------------------------------------- 4. query */

async function send(op, variables, hash, version) {
  const [token, ctoken] = await Promise.all([accessToken(), getClientToken()]);
  const res = await fetch(PATHFINDER, {
    method: 'POST',
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
  if (res.status === 429) throw rateLimited(retryAfterOf(res));
  const body = await res.json().catch(() => null);
  if (res.status === 401) { clientToken = null; throw new StepError('signin', 'Spotify rejected the session (401)'); }
  if (!res.ok || !body) throw new StepError('query', `${op} → HTTP ${res.status}`);
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
    if (first.fixed || e.step === 'signin' || e.step === 'clienttoken' || e.step === 'ratelimit') throw e;
    const again = await hashFor(op, true);
    if (again.hash === first.hash && !e.stale) throw e;
    return send(op, variables, again.hash, again.version);
  }
}

/* --------------------------------------------------- Web API, same token */

async function webApi(p, attempt = 0) {
  const token = await accessToken();
  const res = await fetch(p.startsWith('http') ? p : `${WEB_API}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    const wait = retryAfterOf(res);
    if (wait <= RATE_ABSORB_S && attempt === 0) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return webApi(p, 1);
    }
    throw rateLimited(wait);
  }
  if (res.status === 401) throw new StepError('signin', 'Spotify rejected the session (401)');
  if (!res.ok) throw new StepError('webapi', `Spotify returned HTTP ${res.status}`);
  return res.json();
}

async function paged(first, cap = 2000) {
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
    albumArtUrl: img(r.coverArt?.sources, 300),
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
    albumArtUrl: img(album.coverArt?.sources, 300),
    durationMs: t.duration?.totalMilliseconds || null,
    explicit: t.contentRating?.label === 'EXPLICIT',
    playcount: num(t.playcount),
  };
}

/* ------------------------------------------------------------ public API */

export async function artistOverview(artistId) {
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
    biography: String(a.profile?.biography?.text || '').replace(/<[^>]+>/g, '').trim() || null,
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
export async function artistDiscography(artistId) {
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
        albumArtUrl: a.images?.[1]?.url || a.images?.[0]?.url || null,
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

export async function albumPlaycounts(albumId) {
  const out = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const data = await query('getAlbum', { uri: `spotify:album:${albumId}`, locale: '', offset, limit: 50 });
    const a = data?.albumUnion;
    const items = a?.tracksV2?.items || a?.tracks?.items || [];
    for (const it of items) {
      const t = it?.track;
      if (t) out.push({ spotifyId: idOf(t.uri), title: t.name, trackNumber: t.trackNumber, playcount: num(t.playcount) });
    }
    const total = a?.tracksV2?.totalCount || a?.tracks?.totalCount || 0;
    if (!items.length || offset + items.length >= total) break;
  }
  return out;
}

export async function trackPlaycount(trackId) {
  const data = await query('getTrack', { uri: `spotify:track:${trackId}` });
  return num(data?.trackUnion?.playcount);
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

const libTrack = (t, addedAt) => (t ? {
  spotifyId: t.id,
  title: t.name,
  artists: (t.artists || []).map((a) => a.name).join(', '),
  artistIds: (t.artists || []).map((a) => a.id),
  album: t.album?.name || '',
  albumId: t.album?.id || null,
  albumArtUrl: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
  durationMs: t.duration_ms,
  explicit: !!t.explicit,
  addedAt: addedAt || null,
} : null);

export async function myLibrary(kind) {
  switch (kind) {
    case 'liked': {
      const rows = await paged('/me/tracks?limit=50');
      return rows.map((r) => libTrack(r.track, r.added_at)).filter(Boolean);
    }
    case 'albums': {
      const rows = await paged('/me/albums?limit=50', 1000);
      return rows.map((r) => r.album && ({
        albumId: r.album.id, name: r.album.name,
        artists: (r.album.artists || []).map((a) => a.name).join(', '),
        albumArtUrl: r.album.images?.[1]?.url || r.album.images?.[0]?.url || null,
        releaseDate: r.album.release_date, totalTracks: r.album.total_tracks, addedAt: r.added_at,
      })).filter(Boolean);
    }
    case 'artists': {
      const out = [];
      let next = '/me/following?type=artist&limit=50';
      while (next && out.length < 1000) {
        const p = await webApi(next);
        out.push(...(p.artists?.items || []));
        next = p.artists?.next || null;
      }
      return out.map((a) => ({ id: a.id, name: a.name, image: a.images?.[1]?.url || a.images?.[0]?.url || null, genres: a.genres || [] }));
    }
    case 'top': {
      const [artists, tracks] = await Promise.all([
        webApi('/me/top/artists?limit=20&time_range=short_term'),
        webApi('/me/top/tracks?limit=20&time_range=short_term'),
      ]);
      return {
        artists: (artists.items || []).map((a) => ({ id: a.id, name: a.name, image: a.images?.[1]?.url || a.images?.[0]?.url || null })),
        tracks: (tracks.items || []).map((t) => libTrack(t)).filter(Boolean),
      };
    }
    case 'recent': {
      const p = await webApi('/me/player/recently-played?limit=50');
      return (p.items || []).map((r) => ({ ...libTrack(r.track), playedAt: r.played_at })).filter((x) => x.spotifyId);
    }
    default:
      throw new StepError('webapi', `unknown library kind ${kind}`);
  }
}

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

export function registerSpotifyPartnerIpc(ipcMain) {
  ipcMain.handle('spotifyPartner:state', () => state_());
  ipcMain.handle('spotifyPartner:signIn', () => beginSignIn());
  ipcMain.handle('spotifyPartner:signOut', () => signOut());
  ipcMain.handle('spotifyPartner:diagnose', wrap(diagnose));
  ipcMain.handle('spotifyPartner:artist', wrap(cachedOverview));
  ipcMain.handle('spotifyPartner:findArtist', wrap(findArtist));
  ipcMain.handle('spotifyPartner:albumPlays', wrap(albumPlaycounts));
  ipcMain.handle('spotifyPartner:discography', wrap(async (id) => {
    const hit = discogCache.get(id);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
    const data = await artistDiscography(id);
    discogCache.set(id, { at: Date.now(), data });
    return data;
  }));
  ipcMain.handle('spotifyPartner:trackPlays', wrap(trackPlaycount));
  ipcMain.handle('spotifyPartner:topTracks', wrap(artistTopTracks));
  ipcMain.handle('spotifyPartner:library', wrap(myLibrary));
}
