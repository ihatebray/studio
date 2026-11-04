import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { app } from 'electron';

/* =========================================================================
 *  Soulseek client wrapper — soulseek-ts backend
 *
 *  This file used to wrap `slsk-client` (callback API, in-memory buffering,
 *  no streaming progress, hardcoded /tmp/slsk path). We've swapped to
 *  `soulseek-ts` (jgchk/soulseek-ts) because every limitation of the old
 *  library was hurting us. soulseek-ts gives us:
 *    - new SlskClient() / await login()           — clean promise API
 *    - search() returns results grouped by user   — enables album view
 *    - download() returns { stream }              — pipe to disk = real
 *                                                    byte-accurate progress
 *                                                    and cancellation
 *
 *  The exports keep the same NAMES as before so main.js's import line
 *  doesn't change, but soulseekSearch now returns { results, albums }
 *  with albums auto-grouped, and soulseekDownload reports throughput.
 *
 *  Filename junk-filtering (clean / edit / karaoke / etc.) is here so it
 *  applies consistently to single tracks and album track lists. It's
 *  conditional: a query word that matches a junk word turns that word
 *  off ("taylor swift clean" doesn't get filtered).
 * ========================================================================= */

function credPath() {
  return path.join(app.getPath('userData'), 'soulseek-credentials.json');
}

function loadSoulseekCredentials() {
  const envUser = (process.env.SOULSEEK_USERNAME || '').trim();
  const envPass = (process.env.SOULSEEK_PASSWORD || '').trim();
  let fileUser = '';
  let filePass = '';
  try {
    const raw = fs.readFileSync(credPath(), 'utf8');
    const j = JSON.parse(raw);
    fileUser = String(j.username || '').trim();
    filePass = String(j.password || '').trim();
  } catch {
    /* no file yet */
  }
  return {
    username: fileUser || envUser,
    password: filePass || envPass,
  };
}

export function saveSoulseekCredentials({ username, password }) {
  fs.mkdirSync(path.dirname(credPath()), { recursive: true });
  const u = String(username || '').trim();
  const p = String(password || '').trim();
  fs.writeFileSync(
    credPath(),
    JSON.stringify({ username: u, password: p }),
    'utf8',
  );
  forceDisconnect();
}

export function soulseekCredentialsConfigured() {
  const c = loadSoulseekCredentials();
  return !!(c.username && c.password);
}

/* ---------- Connection state ---------- */

// Lazy import. soulseek-ts ships as ESM. Vite's main-process build
// transforms `import` statements at build time, but a static top-level
// import of a missing package would break the entire main process. We
// use a runtime dynamic import inside an indirect eval so neither Vite
// nor Node's static-analysis sees the import target until called.
let SlskClientCtor = null;
async function getCtor() {
  if (SlskClientCtor) return SlskClientCtor;
  try {
    // eslint-disable-next-line no-eval
    const mod = await (0, eval)("import('soulseek-ts')");
    const Ctor = mod.SlskClient || mod.default?.SlskClient || mod.default;
    if (typeof Ctor !== 'function') {
      throw new Error('soulseek-ts is installed but does not expose SlskClient.');
    }
    SlskClientCtor = Ctor;
    return Ctor;
  } catch (e) {
    const err = new Error(
      'soulseek-ts is not installed. Run `npm install soulseek-ts` and restart.'
    );
    err.cause = e;
    throw err;
  }
}

let client = null;
let connectingPromise = null;
let lastConnectError = '';
let connState = 'disconnected';

// Track every TCP socket that soulseek-ts's listen server accepts.
// CRITICAL: this is a workaround for a bug in soulseek-ts where its
// `destroy()` method calls `server.close()` on the listening socket
// (which only stops NEW connections being accepted) but never destroys
// the EXISTING incoming peer connections. Those connections keep their
// MessageStream parsers running and continuously consume CPU on every
// chunk of incoming data — that's the persistent lag the user sees
// after searching, even after disconnecting.
//
// We work around it by monkey-patching the listen server's underlying
// Node `net.Server` instance to track every incoming connection. When
// we destroy our client, we manually destroy every tracked socket.
const trackedListenSockets = new Set();

function installListenSocketTracker(slskClient) {
  // The library exposes `client.listen.server`, a raw net.Server. Tap
  // its `connection` event to register every accepted socket and
  // auto-untrack on close. If the internal structure ever changes,
  // this fails open — the leak comes back, but nothing breaks.
  try {
    const netServer = slskClient?.listen?.server;
    if (!netServer || typeof netServer.on !== 'function') return;
    netServer.on('connection', (sock) => {
      trackedListenSockets.add(sock);
      sock.once('close', () => trackedListenSockets.delete(sock));
    });
  } catch {
    /* tracker is best-effort */
  }
}

function destroyTrackedSockets() {
  for (const sock of trackedListenSockets) {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  trackedListenSockets.clear();
}

function forceDisconnect() {
  if (client) {
    try { client.destroy?.(); } catch { /* ignore */ }
  }
  // Always kill tracked sockets, even if client.destroy threw. The bug
  // in soulseek-ts means client.destroy doesn't close these; doing it
  // ourselves is the whole point of this workaround.
  destroyTrackedSockets();
  client = null;
  connectingPromise = null;
  connState = 'disconnected';
}

export function soulseekStatus() {
  return {
    state: connState,
    configured: soulseekCredentialsConfigured(),
    error: lastConnectError,
  };
}

export function soulseekDisconnect() {
  forceDisconnect();
  lastConnectError = '';
  return { ok: true };
}

/**
 * Reject if `promise` doesn't settle within `ms`. The underlying operation
 * keeps running (soulseek-ts gives us no abort handle), so callers that
 * care attach cleanup to the ORIGINAL promise for the late-resolve case.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

async function ensureConnected() {
  if (client && connState === 'connected') return client;
  if (connectingPromise) return connectingPromise;

  const { username, password } = loadSoulseekCredentials();
  if (!username || !password) {
    throw new Error('Soulseek is not configured. Add username and password in Settings.');
  }

  connState = 'connecting';
  lastConnectError = '';
  connectingPromise = (async () => {
    try {
      const Ctor = await getCtor();
      const c = new Ctor();
      // Install the listen-socket tracker BEFORE login so we catch any
      // incoming peer connections from the moment the listen port opens.
      installListenSocketTracker(c);
      // A half-dead network turns login into an indefinite hang without
      // this — the server socket connects but the login reply never comes.
      await withTimeout(
        c.login(username, password), 15_000,
        'Timed out connecting to the Soulseek server (15s). Check your connection and try again.'
      );
      client = c;
      connState = 'connected';
      return c;
    } catch (e) {
      connState = 'failed';
      const raw = String(e?.message || e);
      if (/INVALIDPASS|wrong password|loginrejected|invalid/i.test(raw)) {
        lastConnectError = 'Wrong Soulseek password.';
      } else if (/login.*fail/i.test(raw)) {
        lastConnectError = 'Soulseek login rejected. Check username and password.';
      } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(raw)) {
        lastConnectError = 'Could not reach Soulseek server. Check your internet connection.';
      } else {
        lastConnectError = raw;
      }
      throw new Error(lastConnectError);
    } finally {
      connectingPromise = null;
    }
  })();
  return connectingPromise;
}

export async function soulseekTestConnection() {
  try {
    await ensureConnected();
    return { ok: true, ...soulseekStatus() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ...soulseekStatus() };
  }
}

/* ---------- Filename filter ---------- */

/**
 * Words that mark a file as the wrong version. If any of these appear in
 * the filename AND none of them appear in the query, we drop the result.
 * Conditional: searching "taylor swift clean" disables the "clean" filter
 * for that one query.
 */
const JUNK_WORDS = [
  'clean',
  'edit',
  'edited',
  'radio edit',
  'karaoke',
  'instrumental',
  'sped up',
  'speed up',
  'slowed',
  'slow down',
  'nightcore',
  '8d audio',
  '8d',
  'reverb',
  'remix',
  'cover',
  'live',
  'demo',
  'acapella',
  'acappella',
  'a capella',
  'a cappella',
];

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\\/_\-\.]/g, ' ')
    .replace(/[\(\)\[\]\{\}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsWord(haystack, needle) {
  const n = needle.toLowerCase().split(/\s+/).map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('\\s+');
  const re = new RegExp(`(^|\\s|\\b)${n}(\\s|\\b|$)`, 'i');
  return re.test(haystack);
}

function passesJunkFilter(query, filename, folderPath = '') {
  // Only inspect the FILENAME and its IMMEDIATE parent folder — not the whole
  // path hierarchy. A user's share might sit under ".../Live Sets/..." or
  // ".../Bootlegs/..." or a top folder literally named "Demos"; inspecting
  // the full path would drop perfectly normal studio files just because some
  // ancestor folder contains a junk word. The version markers we care about
  // ("Song (Live).mp3", "Album (Live)/...") live in the file or its own
  // folder, so the immediate level is enough.
  const immediateFolder = soulseekBasename(String(folderPath || '').replace(/\\/g, '/'));
  const haystack = normalizeForCompare(filename) + ' ' + normalizeForCompare(immediateFolder);
  const queryNorm = normalizeForCompare(query);
  for (const word of JUNK_WORDS) {
    if (containsWord(haystack, word)) {
      if (containsWord(queryNorm, word)) continue;
      return false;
    }
  }
  return true;
}

/* ---------- Match scoring ----------
 *
 * The junk filter above is a coarse gate. For auto-import (playlist →
 * Soulseek) we need to actually rank how well each candidate matches the
 * *intended* track, not just how high its bitrate is. Otherwise the top
 * result by quality is often a live cut, a remix, or a different song that
 * merely shares a word with the query.
 *
 * scoreSoulseekMatch returns { score (0..1), reasons[], penalties[] } for a
 * single candidate against a target {title, artist, durationMs}. It blends:
 *   - title token overlap   (how many of the title's words are in the file)
 *   - artist token overlap
 *   - duration proximity     (within a few seconds of the target length)
 *   - variant penalties      (live/remix/cover/etc. that the target didn't ask for)
 */







/* ---------- Album relevance ---------- */

/** Connector/noise words that never count as "extra" content words. */
const ALBUM_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
]);
/** Non-content markers already handled elsewhere — never "extras" either. */
const ALBUM_NOISE_WORDS = new Set([
  'flac', 'wav', 'mp3', '320', '256', '192', 'cbr', 'vbr', 'cd', 'web',
  'vinyl', '24bit', '16bit', 'deluxe', 'anniversary', 'remaster', 'remastered',
  'special', 'expanded', 'reissue', 'bonus', 'extended', 'collectors',
  'limited', 'definitive', 'edition', 'version', 'release', 'explicit', 'lp', 'ep',
]);

function albumTokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 || /^[0-9]$/.test(t));
}

/**
 * Score how well a candidate album folder matches the search query, 0..1.
 * Ranking albums by quality alone works when the server's AND-matching has
 * already narrowed the field — but a self-titled search ("Future FUTURE")
 * degenerates to ONE effective token, so every folder containing "future"
 * anywhere in its path matches and quality-ranking surfaces the biggest
 * FLACs instead of the right album. Three signals fix it:
 *
 *   coverage      — query tokens present in the album folder's OWN name
 *                   count fully; tokens found only in the parent path count
 *                   at 0.4 (kills ".../Future/Digital Media 01" folders).
 *   extras        — content words in the album name that are NOT in the
 *                   query get penalized ("Love in the Future" sinks below
 *                   the bare "FUTURE"). Stopwords / years / format markers
 *                   are not content words.
 *   multiplicity  — a token DUPLICATED in the query (artist == album, the
 *                   self-titled signature) earns a bonus when it appears in
 *                   two different path segments: ".../Future/FUTURE (2017)"
 *                   beats ".../SomeoneElse/The Future".
 */
function scoreAlbumRelevance({ displayName, folder }, queryTokensAll) {
  const uniq = [...new Set(queryTokensAll)];
  if (!uniq.length) return 1;

  const dnTokens = new Set(albumTokenize(displayName));
  const segments = String(folder || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const segTokenSets = segments.map((seg) => new Set(albumTokenize(seg)));
  const pathTokens = new Set();
  for (const s of segTokenSets) for (const t of s) pathTokens.add(t);

  // Coverage
  let cov = 0;
  for (const t of uniq) {
    if (dnTokens.has(t)) cov += 1;
    else if (pathTokens.has(t)) cov += 0.4;
  }
  cov /= uniq.length;

  // Extras — content words in the folder name beyond the query
  let extras = 0;
  for (const t of dnTokens) {
    if (uniq.includes(t)) continue;
    if (ALBUM_STOPWORDS.has(t) || ALBUM_NOISE_WORDS.has(t)) continue;
    if (/^(19|20)\d{2}$/.test(t)) continue; // years
    if (/^\d{1,2}$/.test(t)) continue;       // disc/volume numbers
    extras += 1;
  }
  const extrasPenalty = Math.min(0.4, extras * 0.1);

  // Self-titled multiplicity bonus. Gated on extras === 0: a self-titled
  // album folder is literally named the artist's name and nothing else —
  // "WRLD ON DRUGS" sitting inside /Future/ hits two segments too, but its
  // name is full of other words, so it isn't the self-titled record.
  let multBonus = 0;
  if (extras === 0) {
    const counts = new Map();
    for (const t of queryTokensAll) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of counts) {
      if (n < 2) continue;
      let segHits = 0;
      for (const s of segTokenSets) if (s.has(t)) segHits += 1;
      if (segHits >= 2) { multBonus = 0.2; break; }
    }
  }

  // No upper clamp — rel only drives ranking, and the self-titled bonus
  // must survive on top of full coverage (that's its entire job).
  const rel = cov - extrasPenalty + multBonus;
  return rel < 0 ? 0 : rel;
}

/* ---------- Search ---------- */

const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.opus',
  '.aiff', '.aif', '.alac', '.ape', '.wv',
]);
const LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv']);

function isAudioFile(filename) {
  if (typeof filename !== 'string') return false;
  const ext = path.extname(filename.replace(/\\/g, '/').toLowerCase());
  return AUDIO_EXTS.has(ext);
}

export function soulseekBasename(filePath) {
  if (typeof filePath !== 'string') return '';
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function soulseekParentFolder(filePath) {
  if (typeof filePath !== 'string') return '';
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/**
 * Pull file fields, tolerating naming variants between soulseek-ts
 * versions (bitRate vs bitrate vs bit_rate, etc.).
 */
/* soulseek-ts hands each file's bitrate, length, sample rate and bit depth
   over as an `attrs` Map keyed by the protocol's attribute codes, never as
   named fields. Reading only the named fields left every MP3 at bitrate 0,
   so a 320 rip ranked and badged the same as an unknown one. */
const ATTR_BITRATE = 0;
const ATTR_DURATION = 1;
const ATTR_SAMPLE_RATE = 4;
const ATTR_BIT_DEPTH = 5;

function attrOf(f, code) {
  const a = f?.attrs;
  if (!a) return 0;
  const v = typeof a.get === 'function' ? a.get(code) : a[code];
  return Number(v) || 0;
}

function pickFileFields(f) {
  return {
    filename: String(f.filename ?? f.file ?? f.name ?? ''),
    size: Number(f.size ?? f.fileSize ?? 0) || 0,
    bitrate: Number(f.bitRate ?? f.bitrate ?? f.bit_rate ?? 0) || attrOf(f, ATTR_BITRATE),
    duration: Number(f.duration ?? f.time ?? f.length ?? 0) || attrOf(f, ATTR_DURATION),
    sampleRate: attrOf(f, ATTR_SAMPLE_RATE),
    bitDepth: attrOf(f, ATTR_BIT_DEPTH),
  };
}

function bitrateTier(ext, bitrate) {
  if (LOSSLESS_EXT.has(ext)) return 5;
  if (bitrate >= 320) return 4;
  if (bitrate >= 256) return 3;
  if (bitrate >= 192) return 2;
  if (bitrate > 0) return 1;
  return 0;
}

/**
 * Progressive query fallback. Soulseek's server does literal AND-token
 * matching against peers' file paths, so a Spotify-style query like
 * "Artist Song (feat. Guest) - Remastered 2011" matches almost nothing —
 * nobody's files carry those decorations. Variants, tried in order until
 * one returns results:
 *   1. the query as given (exact intent wins when it works)
 *   2. cleaned: feat-clauses, parentheticals, remaster/deluxe markers,
 *      years, and punctuation stripped ("don't" → "dont" to match common
 *      file naming)
 *   3. aggressive: also drops connector words and dashes — pure
 *      artist+title tokens, the way peers actually name files
 */
function buildSoulseekQueryVariants(q) {
  const variants = [q];
  const cleaned = q
    .replace(/\((feat|ft|featuring|with)[^)]*\)/gi, ' ')
    .replace(/\[(feat|ft|featuring|with)[^\]]*\]/gi, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s+\S+(\s+\S+)?/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(remaster(ed)?|deluxe|anniversary|expanded|edition|version|mono|stereo)\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/['\u2019]/g, '')
    .replace(/["\u201C\u201D!?,.:;]+/g, ' ')
    .replace(/\s[-\u2013\u2014]+(\s|$)/g, ' ') // orphaned dashes left by stripped suffixes
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && cleaned.toLowerCase() !== q.toLowerCase()) variants.push(cleaned);
  const aggressive = (cleaned || q)
    .replace(/[-\u2013\u2014&+/\\]/g, ' ')
    .replace(/\b(the|a|an|and)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (aggressive && aggressive.split(' ').length >= 2
      && aggressive.toLowerCase() !== (cleaned || q).toLowerCase()) {
    variants.push(aggressive);
  }
  return variants;
}

export async function soulseekSearch(query, { filter = true, timeout, debug = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], albums: [] };

  const c = await ensureConnected();

  let raw;
  try {
    // Pass an explicit timeout when given. The library collects peer
    // responses for the whole window then resolves (it does NOT stop early),
    // so a longer window catches slower-responding peers that may be the
    // only ones sharing a rare file.
    //
    // Progressive fallback: if a variant returns nothing, retry with a
    // cleaner one (see buildSoulseekQueryVariants). Stops at the first
    // variant that produces results, so precise queries keep their
    // precision and only genuinely empty searches pay for a retry.
    const variants = buildSoulseekQueryVariants(q);
    for (let i = 0; i < variants.length; i++) {
      raw = await collectSearch(c, variants[i], timeout ? { maxMs: timeout } : undefined);
      if (Array.isArray(raw) && raw.length > 0) {
        if (i > 0) console.log(`[soulseek] "${q}" \u2192 hit on variant ${i}: "${variants[i]}"`);
        break;
      }
    }
  } catch (e) {
    forceDisconnect();
    throw new Error(String(e?.message || e));
  }
  if (!Array.isArray(raw)) raw = [];

  // Diagnostics: count what actually came back vs. what survived filtering,
  // so we can tell whether "no results" means the network returned nothing
  // or the junk filter ate everything.
  let rawPeers = 0;
  let rawAudioFiles = 0;
  let droppedByJunk = 0;
  let droppedNonAudio = 0;

  const flat = [];
  for (const group of raw) {
    if (!group || typeof group !== 'object') continue;
    const user = String(group.username || group.user || '').trim();
    if (!user) continue;
    rawPeers += 1;
    const slots = group.slotsFree != null
      ? !!group.slotsFree
      : (group.hasFreeUploadSlot != null
          ? !!group.hasFreeUploadSlot
          : !!group.slots);
    const speed = Number(
      group.uploadSpeed ?? group.avgSpeed ?? group.speed ?? 0
    ) || 0;
    const filesArr = Array.isArray(group.files) ? group.files : [];
    for (const fRaw of filesArr) {
      const f = pickFileFields(fRaw);
      if (!f.filename) continue;
      if (!isAudioFile(f.filename)) { droppedNonAudio += 1; continue; }
      rawAudioFiles += 1;
      const filename = soulseekBasename(f.filename);
      const folder = soulseekParentFolder(f.filename);
      const ext = path.extname(filename).slice(1).toLowerCase();
      if (filter && !passesJunkFilter(q, filename, folder)) { droppedByJunk += 1; continue; }
      flat.push({
        id: `${user}::${f.filename}`,
        user,
        filePath: f.filename,
        filename,
        folder,
        ext,
        size: f.size,
        bitrate: f.bitrate,
        duration: f.duration,
        sampleRate: f.sampleRate,
        bitDepth: f.bitDepth,
        slots,
        speed,
        queue: Number(group.queueLength) || 0,
      });
    }
  }

  if (debug) {
    console.log(`[slsk-search] "${q}": ${rawPeers} peers responded, ` +
      `${rawAudioFiles} audio files; dropped ${droppedByJunk} by junk-filter, ` +
      `${droppedNonAudio} non-audio; ${flat.length} kept`);
  }

  const seen = new Set();
  const dedup = [];
  for (const r of flat) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    dedup.push(r);
  }

  dedup.sort((a, b) => {
    if (a.slots !== b.slots) return a.slots ? -1 : 1;
    const ta = bitrateTier(a.ext, a.bitrate);
    const tb = bitrateTier(b.ext, b.bitrate);
    if (ta !== tb) return tb - ta;
    if (a.speed !== b.speed) return b.speed - a.speed;
    return b.size - a.size;
  });

  // Album auto-grouping. Same user + same folder + ≥2 audio files.
  // Query tokens WITH duplicates preserved — the duplicate is the
  // self-titled signal scoreAlbumRelevance keys on.
  const albumQueryTokens = albumTokenize(q);
  const albumMap = new Map();
  for (const r of dedup) {
    if (!r.folder) continue;
    const key = `${r.user}::${r.folder}`;
    let alb = albumMap.get(key);
    if (!alb) {
      const folderBase = soulseekBasename(r.folder.replace(/\\/g, '/'));
      alb = {
        id: key,
        user: r.user,
        folder: r.folder,
        displayName: folderBase || r.folder,
        tracks: [],
        totalSize: 0,
        bitrates: new Set(),
        exts: new Set(),
        slots: r.slots,
        speed: r.speed,
      };
      albumMap.set(key, alb);
    }
    alb.tracks.push(r);
    alb.totalSize += r.size || 0;
    if (r.bitrate) alb.bitrates.add(r.bitrate);
    if (r.ext) alb.exts.add(r.ext);
  }

  /* ---------- Album smart-selection ----------
   *
   * Without filtering, popular searches return ~50-100 album entries
   * (same album shared by many users). Showing all of them is useless
   * to the user and forces React to render hundreds of cards. Each peer
   * also opens a TCP connection that lasts until disconnect.
   *
   * Strategy:
   *   1. Build all candidate albums (above).
   *   2. Classify each by quality tier: lossless / 320kbps / other.
   *   3. Group by normalized displayName so we have one entry per
   *      actual album (across all users sharing it).
   *   4. Within each (album, quality) bucket, pick the BEST representative
   *      (free slot > higher bitrate > faster peer > more tracks).
   *   5. Pick up to 10 albums total: up to 3 lossless + up to 3 320 MP3
   *      + up to 4 wildcards (whatever's left, ranked). The wildcards
   *      catch alternate albums and fallbacks when the top picks are
   *      queued.
   */

  function classifyAlbumQuality(alb) {
    if ([...alb.exts].some((e) => LOSSLESS_EXT.has(e))) return 'lossless';
    if (alb.bitrates.has(320)) return 'mp3_320';
    return 'mp3_other';
  }

  // Normalize an album displayName for cross-user grouping. Strips:
  //   - format markers and bitrate tags: [FLAC], (MP3 320), etc.
  //   - year markers: (2001), 2001
  //   - edition markers: deluxe / anniversary / remaster(ed) /
  //     special / expanded / reissue / bonus / extended
  //   - source/release tags: cd / web / vinyl / 24bit
  // So "Lateralus", "Lateralus (2001)", "Lateralus (Deluxe Edition)",
  // and "Lateralus [FLAC 24bit Remastered 2014]" all collapse to the
  // same key. This is the user's preference — they treat all variants
  // of an album as "the same album, pick the best one."
  function normalizeAlbumName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\[(flac|mp3|320|256|192|cd|wav|24bit|vinyl|web)\]/gi, '')
      .replace(/\((19|20)\d{2}\)/g, '')
      .replace(/\b(19|20)\d{2}\b/g, '')
      .replace(/\b(flac|wav|mp3|320|256|192|cbr|vbr|cd|web|vinyl|24bit)\b/gi, '')
      // Edition markers. These are usually parenthesized or bracketed
      // suffixes like "(Deluxe Edition)" / "[Anniversary Edition]" /
      // "(Remastered)" / "(Special Edition)". Strip the keyword and
      // common surrounding words ("edition", "version").
      .replace(/\b(deluxe|anniversary|remaster(ed)?|special|expanded|reissue|bonus|extended|collector'?s?|limited|definitive)\b/gi, '')
      .replace(/\b(edition|version|release)\b/gi, '')
      .replace(/[\(\)\[\]\{\}]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Build raw candidate list (one entry per user×folder, as before).
  const candidates = [];
  for (const alb of albumMap.values()) {
    if (alb.tracks.length < 2) continue;
    alb.tracks.sort((a, b) => a.filename.localeCompare(b.filename));
    candidates.push({
      id: alb.id,
      user: alb.user,
      folder: alb.folder,
      displayName: alb.displayName,
      tracks: alb.tracks,
      totalSize: alb.totalSize,
      mixedBitrates: alb.bitrates.size > 1,
      bitrate: alb.bitrates.size === 1 ? [...alb.bitrates][0] : 0,
      ext: alb.exts.size === 1 ? [...alb.exts][0] : 'mixed',
      exts: alb.exts,
      bitrates: alb.bitrates,
      slots: alb.slots,
      speed: alb.speed,
      trackCount: alb.tracks.length,
      quality: classifyAlbumQuality(alb),
      normName: normalizeAlbumName(alb.displayName),
      rel: scoreAlbumRelevance(
        { displayName: alb.displayName, folder: alb.folder },
        albumQueryTokens,
      ),
    });
  }

  // Group candidates by (normalized name, quality tier), then keep the
  // best one per group. This collapses "50 users sharing the same FLAC
  // of Lateralus" → 1 entry.
  const bestByKey = new Map();
  for (const c of candidates) {
    const key = `${c.normName}::${c.quality}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, c);
      continue;
    }
    // Prefer free slot, then higher bitrate, then faster peer, then
    // more tracks (more complete rips), then larger total size.
    const better = (() => {
      if (existing.slots !== c.slots) return c.slots && !existing.slots ? c : existing;
      if (existing.bitrate !== c.bitrate) return c.bitrate > existing.bitrate ? c : existing;
      if (existing.speed !== c.speed) return c.speed > existing.speed ? c : existing;
      if (existing.trackCount !== c.trackCount) return c.trackCount > existing.trackCount ? c : existing;
      return c.totalSize > existing.totalSize ? c : existing;
    })();
    bestByKey.set(key, better);
  }

  // Pick the final ≤10 albums. Slot quotas:
  //   - Up to 3 lossless (FLAC/WAV)
  //   - Up to 3 MP3 320
  //   - Up to 4 wildcards (anything else, ranked)
  // The dedup-by-normName step above means within each quality tier
  // we're picking *different* albums, not 3 copies of the same FLAC
  // from 3 different users. Slots roll over: if there are only 2
  // lossless results, the 3rd lossless slot is filled by an extra
  // wildcard. This way we always serve up to 10 useful results.
  // Relevance leads (bucketed to 0.1 steps so near-ties fall through to
  // the quality keys), THEN the original slots/quality/speed ordering.
  // Pure-relevance sorting would let a 128kbps rip of the right album
  // outrank a FLAC of the same album — bucketing keeps both behaviors.
  const ranked = [...bestByKey.values()].sort((a, b) => {
    const ra = Math.round(a.rel * 10);
    const rb = Math.round(b.rel * 10);
    if (ra !== rb) return rb - ra;
    if (a.slots !== b.slots) return a.slots ? -1 : 1;
    const qOrder = { lossless: 3, mp3_320: 2, mp3_other: 1 };
    const qa = qOrder[a.quality] || 0;
    const qb = qOrder[b.quality] || 0;
    if (qa !== qb) return qb - qa;
    if (a.speed !== b.speed) return b.speed - a.speed;
    return b.trackCount - a.trackCount;
  });

  const TOTAL_CAP = 10;
  const LOSSLESS_QUOTA = 3;
  const MP3_320_QUOTA = 3;
  const albums = [];
  const seenNorms = new Set();

  const takeUpTo = (n, predicate) => {
    let taken = 0;
    for (const r of ranked) {
      if (taken >= n) break;
      if (seenNorms.has(r.normName)) continue;
      if (!predicate(r)) continue;
      albums.push(r);
      seenNorms.add(r.normName);
      taken++;
    }
    return taken;
  };

  // Pass 1: lossless quota. Prefer entries with free slots first by
  // doing two sub-passes — slots-only, then any.
  let losslessTaken = takeUpTo(LOSSLESS_QUOTA, (r) => r.quality === 'lossless' && r.slots);
  if (losslessTaken < LOSSLESS_QUOTA) {
    losslessTaken += takeUpTo(LOSSLESS_QUOTA - losslessTaken, (r) => r.quality === 'lossless');
  }
  // Pass 2: MP3 320 quota, same slot-first logic.
  let mp3Taken = takeUpTo(MP3_320_QUOTA, (r) => r.quality === 'mp3_320' && r.slots);
  if (mp3Taken < MP3_320_QUOTA) {
    mp3Taken += takeUpTo(MP3_320_QUOTA - mp3Taken, (r) => r.quality === 'mp3_320');
  }
  // Pass 3: fill remaining slots with anything that's left, ranked.
  takeUpTo(TOTAL_CAP - albums.length, () => true);

  // Strip the internal helper fields we added during selection — the
  // renderer doesn't need them and serializing Sets over IPC would
  // crash.
  for (const a of albums) {
    delete a.exts;
    delete a.bitrates;
    delete a.normName;
    delete a.quality;
  }

  /* ---------- Track results: cap at 10 ---------- */
  //
  // Same problem as albums: huge results overwhelm the UI and keep
  // peer connections alive. The top-10 (after the rank sort above)
  // are already the best by slot/bitrate/speed, so capping doesn't
  // hide useful results — it just hides the long tail of low-quality
  // rips from slow peers.
  /* 40, not 10: the Best probe lays these files against a whole album's
     tracklist, and ten files can't cover a twelve track record. */
  const cappedResults = dedup.slice(0, 40);

  return { results: cappedResults, albums };
}

/* ---------- Collecting a search ----------
 *
 * soulseek-ts resolves a search only when its whole window runs out, ten
 * seconds by default, however early the answers stopped arriving. Peers that
 * have the file almost always answer inside the first two or three seconds,
 * so this ends a search once answers have gone quiet, and gives up on an
 * empty one sooner, instead of always sitting out the full window.
 */
function collectSearch(c, query, {
  maxMs = 10_000, minMs = 3_000, quietMs = 2_200, emptyMs = 6_000, onResult, isCancelled,
} = {}) {
  return new Promise((resolve, reject) => {
    const got = [];
    const started = Date.now();
    let last = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(tick);
      resolve(got);
    };
    const tick = setInterval(() => {
      const age = Date.now() - started;
      if (isCancelled?.()) { finish(); return; }
      if (age >= maxMs) { finish(); return; }
      if (!got.length && age >= emptyMs) { finish(); return; }
      if (got.length && age >= minMs && Date.now() - last >= quietMs) finish();
    }, 200);
    let p;
    try {
      p = c.search(query, {
        timeout: maxMs + 500,
        onResult: (r) => {
          if (done) return;
          got.push(r);
          last = Date.now();
          try { onResult?.(r); } catch { /* a bad update must not end the search */ }
        },
      });
    } catch (e) {
      done = true;
      clearInterval(tick);
      reject(e);
      return;
    }
    Promise.resolve(p).then(finish, (e) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      reject(e);
    });
  });
}

/* ---------- Live search (the Soulseek search mode) ----------
 *
 * The palette's Soulseek mode asks the network directly, so it gets
 * everything back rather than the ten best files the Best probe works from:
 *
 *   - Answers stream in. A snapshot goes out every few hundred ms while peers
 *     reply, so the first results show in a second or two.
 *   - Nothing is thrown away. Live takes, remixes and the like are marked
 *     and ranked lower instead of being dropped, since searching Soulseek
 *     directly is how you go looking for exactly those.
 *   - Folders are first class. Every user × folder is one entry, the same
 *     record shared by many people folds into one row with its other copies
 *     listed, and each one can be opened to show its whole contents.
 */

const VARIANT_LABELS = new Map([
  ['live', 'Live'], ['remix', 'Remix'], ['instrumental', 'Instrumental'], ['karaoke', 'Karaoke'],
  ['acapella', 'Acapella'], ['acappella', 'Acapella'], ['a capella', 'Acapella'], ['a cappella', 'Acapella'],
  ['sped up', 'Sped Up'], ['speed up', 'Sped Up'], ['slowed', 'Slowed'], ['slow down', 'Slowed'],
  ['nightcore', 'Nightcore'], ['8d audio', '8D'], ['8d', '8D'], ['reverb', 'Reverb'], ['cover', 'Cover'],
  ['demo', 'Demo'], ['clean', 'Clean'], ['edit', 'Edit'], ['edited', 'Edit'], ['radio edit', 'Radio Edit'],
]);

/** The version marker a name carries that the query didn't ask for, or ''. */
function variantOf(query, ...names) {
  const hay = names.map(normalizeForCompare).join(' ');
  const q = normalizeForCompare(query);
  for (const word of JUNK_WORDS) {
    if (containsWord(hay, word) && !containsWord(q, word)) return VARIANT_LABELS.get(word) || word;
  }
  return '';
}

/** Split a peer path on either separator: peers on Windows use \, others /. */
function pathSegments(p) {
  return String(p || '').split(/[\\/]+/).filter(Boolean);
}

/** The folder part of a peer path, with the peer's own separator kept. */
function rawParent(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i === -1 ? '' : s.slice(0, i);
}

/**
 * Does this path answer the search, and how well? 0..1, or ok: false.
 *
 * The server matches each word ANYWHERE in a peer's path, share roots and
 * all, so "dedication 5" also finds a song called "Dedication" sitting in
 * someone's folder named "5". That's the noise. Here every one of the
 * search's main words has to turn up close to the file: in its own name,
 * its album folder or the artist folder above that. Where it turns up sets
 * the score, nearer counting more.
 *
 * `core` are the words that must be there. `extra` are words that only
 * help when present: the artist's name, once it's known which words are the
 * artist, because many clients hide every file whose path names certain
 * artists, so the album's own words are often all a path can still carry.
 */
function judgePath(core, extra, segsFromLeaf, reach) {
  const levels = segsFromLeaf.slice(0, reach + 1).map((seg) => {
    const toks = albumTokenize(seg);
    return { set: new Set(toks), flat: toks.join('') };
  });
  const levelOf = (t) => {
    for (let i = 0; i < levels.length; i += 1) {
      if (levels[i].set.has(t)) return i;
      if (t.length >= 3 && levels[i].flat.includes(t)) return i;
    }
    return -1;
  };
  const weights = [1, 0.9, 0.78, 0.66];
  let sum = 0;
  const at = new Map();
  for (const t of core) {
    const lv = levelOf(t);
    if (lv < 0 || lv >= reach) return { ok: false, rel: 0 };
    at.set(t, lv);
    sum += weights[lv] ?? 0.6;
  }
  /* A short word ("5", "ii", "op") matches by accident all the time: a folder
     named "5", a track number. It only counts beside another of the words. */
  const long = core.filter((t) => t.length >= 3);
  if (long.length) {
    for (const t of core) {
      if (t.length >= 3) continue;
      if (!long.some((l) => at.get(l) === at.get(t))) return { ok: false, rel: 0 };
    }
  }
  let rel = core.length ? sum / core.length : 1;
  if (extra.length) {
    const hits = extra.filter((t) => levelOf(t) >= 0).length;
    rel += 0.25 * (hits / extra.length);
  }
  // The words in the order typed, together in one name: almost surely it.
  const phrase = core.join('');
  if (core.length > 1 && levels.slice(0, reach).some((l) => l.flat.includes(phrase))) rel += 0.1;
  return { ok: true, rel };
}

/* Words in a folder's name the search didn't ask for: "Dedication Vol. 5
   Choir" for "dedication 5" is some other record. Format tags, years and
   edition words don't count. */
function extraWords(name, core, extra) {
  const known = new Set([...core, ...extra]);
  let n = 0;
  for (const t of albumTokenize(name)) {
    if (known.has(t) || ALBUM_STOPWORDS.has(t) || ALBUM_NOISE_WORDS.has(t)) continue;
    if (/^(19|20)\d{2}$/.test(t) || /^\d{1,3}$/.test(t)) continue;
    if ([...known].some((k) => k.length >= 3 && (t.includes(k) || k.includes(t)))) continue;
    n += 1;
  }
  return n;
}

/** Judge every file not yet judged against the current words. */
function judgeAll(state) {
  for (const f of state.files.values()) {
    if (f.judgedFor === state.judgeKey) continue;
    // A disc folder ("CD1") sits between a song and its album without naming anything.
    const segs = pathSegments(f.filePath).reverse().filter((seg, i) => i === 0 || !DISC_DIR.test(seg.trim()));
    const j = judgePath(state.core, state.extra, segs, 4);
    f.judgedFor = state.judgeKey;
    f.ok = j.ok;
    f.rel = j.rel;
    f.variant = variantOf(state.query, f.filename, soulseekBasename(f.folder));
    f.score = rankFile(f);
  }
}

function speedScore(bps) {
  const kb = (Number(bps) || 0) / 1024;
  return kb > 0 ? Math.min(12, Math.log2(kb + 1)) : 0;
}

function rankFile(f) {
  return Math.round(f.rel * 10) * 100
    - (f.variant ? 600 : 0)
    + (f.slots ? 40 : 0)
    + bitrateTier(f.ext, f.bitrate) * 9
    + speedScore(f.speed)
    - Math.min(18, (f.queue || 0) / 4);
}

function albumKeyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[([{][^)\]}]*(flac|mp3|320|v0|kbps|24|16|bit|khz|web|cd|vinyl)[^)\]}]*[)\]}]/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(flac|wav|mp3|320|256|192|v0|v2|cbr|vbr|kbps|cd|web|vinyl|24bit|16bit|hi ?res|lossless)\b/gi, ' ')
    .replace(/\b(deluxe|anniversary|remaster(ed)?|special|expanded|reissue|bonus|extended|collector'?s?|limited|definitive|edition|version|release)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Which record a folder holds, so copies shared by different people can be
   told apart from different records with the same title. Peers name album
   folders "Artist - Album" or put "Album" inside an "Artist" folder; both
   come out as the same artist and album here. */
function recordKey(displayName, parentName) {
  const m = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(String(displayName || ''));
  const artist = albumKeyName(m ? m[1] : parentName);
  const album = albumKeyName(m ? m[2] : displayName);
  return `${artist}::${album}`;
}

/* "Album/CD1/01.flac": the album is the folder above the disc. */
const DISC_DIR = /^(cd|disc|disk|dvd)\s*[-_.]?\s*\d{1,2}\b|^(cd|disc|disk)\s*(one|two|three|i{1,3})$/i;
function albumFolderOf(folderRaw) {
  const base = pathSegments(folderRaw).pop() || '';
  return DISC_DIR.test(base.trim()) && rawParent(folderRaw) ? rawParent(folderRaw) : folderRaw;
}

function folderQuality(exts, bitrates) {
  if ([...exts].some((e) => LOSSLESS_EXT.has(e))) return 'lossless';
  const br = [...bitrates].filter((b) => b > 0);
  if (br.length && Math.min(...br) >= 320) return 'mp3_320';
  return 'other';
}

const liveSearches = new Map(); // searchId → { cancelled, files: Map<id, file> }
let lastLiveSearchId = '';

/** Stop listening to a live search. Answers still arriving are ignored. */
export function soulseekCancelLiveSearch(searchId) {
  const s = liveSearches.get(String(searchId || ''));
  if (s) s.cancelled = true;
  return { ok: true };
}

function buildLiveSnapshot(state) {
  const { query, core, extra } = state;

  /* Judged once per file, and again only when the words that must match
     change (the search fell back to the album's own words). Anything that
     doesn't answer the search is left out, not just ranked lower. */
  judgeAll(state);
  const all = [];
  for (const f of state.files.values()) if (f.ok) all.push(f);
  all.sort((a, b) => b.score - a.score);

  /* Folders: one per user × folder, and only folders whose own name (or the
     artist folder right above it) answers the search. A song found inside
     some other album still shows, under Songs, with its folder a click away. */
  const byFolder = new Map();
  for (const f of all) {
    if (!f.folderRaw) continue;
    const albumRaw = albumFolderOf(f.folderRaw);
    const key = `${f.user}::${albumRaw}`;
    let g = byFolder.get(key);
    if (!g) {
      const segs = pathSegments(albumRaw);
      g = {
        id: key,
        user: f.user,
        folderRaw: albumRaw,
        folder: albumRaw.replace(/\\/g, '/'),
        displayName: segs[segs.length - 1] || f.folderRaw,
        parentName: segs.length > 1 ? segs[segs.length - 2] : '',
        matched: 0,
        totalSize: 0,
        exts: new Map(),
        bitrates: new Set(),
        slots: f.slots,
        speed: f.speed,
        queue: f.queue || 0,
        ...(() => {
          const j = judgePath(core, extra, [...segs].reverse(), 2);
          const more = extraWords(segs[segs.length - 1] || '', core, extra);
          return { fok: j.ok, rel: Math.max(0, j.rel - Math.min(0.3, more * 0.08)) };
        })(),
        variant: variantOf(query, segs[segs.length - 1] || ''),
      };
      byFolder.set(key, g);
    }
    g.matched += 1;
    g.totalSize += f.size || 0;
    g.exts.set(f.ext, (g.exts.get(f.ext) || 0) + 1);
    if (f.bitrate) g.bitrates.add(f.bitrate);
  }

  const folderRows = [];
  for (const g of byFolder.values()) {
    if (!g.fok) continue;
    const extList = [...g.exts.entries()].sort((a, b) => b[1] - a[1]);
    const ext = extList.length ? extList[0][0] : '';
    const br = [...g.bitrates];
    const quality = folderQuality(new Set(g.exts.keys()), g.bitrates);
    folderRows.push({
      id: g.id,
      user: g.user,
      folderRaw: g.folderRaw,
      folder: g.folder,
      displayName: g.displayName,
      parentName: g.parentName,
      trackCount: g.matched,
      totalSize: g.totalSize,
      ext,
      mixed: extList.length > 1,
      bitrate: br.length ? Math.min(...br) : 0,
      slots: g.slots,
      speed: g.speed,
      queue: g.queue,
      rel: g.rel,
      variant: g.variant,
      quality,
      normName: recordKey(g.displayName, g.parentName),
    });
  }

  /* The same record shared by many people is one row: the best copy leads,
     the rest wait behind it as other copies to pick from. Copies are kept
     apart by quality, so the FLAC and the MP3 of one album are two rows. */
  const better = (a, b) => (
    (Number(b.slots) - Number(a.slots))
    || (Math.min(b.trackCount, 40) - Math.min(a.trackCount, 40))
    || (speedScore(b.speed) - speedScore(a.speed))
    || ((a.queue || 0) - (b.queue || 0))
  );
  const groups = new Map();
  for (const r of folderRows) {
    const key = `${r.normName}::${r.quality}`;
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }
  const qOrder = { lossless: 3, mp3_320: 2, other: 1 };
  const folders = [...groups.values()].map((list) => {
    list.sort(better);
    const [lead, ...rest] = list;
    return {
      ...lead,
      copies: rest.slice(0, 15).map((c) => ({
        id: c.id, user: c.user, folderRaw: c.folderRaw, folder: c.folder, displayName: c.displayName,
        parentName: c.parentName, trackCount: c.trackCount, totalSize: c.totalSize, ext: c.ext,
        mixed: c.mixed, bitrate: c.bitrate, slots: c.slots, speed: c.speed, queue: c.queue,
      })),
      copyCount: rest.length,
    };
  }).sort((a, b) => (
    (Math.round(b.rel * 10) - Math.round(a.rel * 10))
    || (Number(!b.variant) - Number(!a.variant))
    || ((qOrder[b.quality] || 0) - (qOrder[a.quality] || 0))
    || (Number(b.slots) - Number(a.slots))
    || ((b.copyCount || 0) - (a.copyCount || 0))
    || (Math.min(b.trackCount, 40) - Math.min(a.trackCount, 40))
  )).slice(0, 80);
  for (const f of folders) delete f.normName;

  const results = all.slice(0, 200).map((f) => ({
    id: f.id, user: f.user, filePath: f.filePath, filename: f.filename, folder: f.folder, folderRaw: f.folderRaw,
    ext: f.ext, size: f.size, bitrate: f.bitrate, duration: f.duration, sampleRate: f.sampleRate, bitDepth: f.bitDepth,
    slots: f.slots, speed: f.speed, queue: f.queue, variant: f.variant, rel: f.rel,
  }));

  return { results, folders, peers: state.peerSet.size, fileCount: all.length };
}

/**
 * Search Soulseek and stream what comes back. `onUpdate(snapshot)` fires as
 * answers arrive and once more at the end with `done: true`; the promise
 * resolves with that last snapshot.
 */
export async function soulseekSearchLive(query, { searchId = '', onUpdate, maxMs = 14_000, artist = '', rest = '' } = {}) {
  const q = String(query || '').trim();
  const id = String(searchId || `s${Date.now()}`);
  if (!q) {
    const empty = { searchId: id, results: [], folders: [], peers: 0, fileCount: 0, done: true };
    onUpdate?.(empty);
    return empty;
  }

  // A new search ends the one before it: only one list is ever on screen.
  if (lastLiveSearchId && lastLiveSearchId !== id) soulseekCancelLiveSearch(lastLiveSearchId);
  lastLiveSearchId = id;
  /* Which words must match. When the app could tell the artist apart from
     the rest ("lil wayne" + "dedication 5"), only the rest must, and the
     artist's name ranks a result up when it's there. */
  const restQ = String(rest || '').trim();
  const artistQ = String(artist || '').trim();
  const split = !!(restQ && artistQ && albumTokenize(restQ).length);
  const state = {
    cancelled: false, files: new Map(), peerSet: new Set(), query: q,
    core: [...new Set(albumTokenize(split ? restQ : q))],
    extra: split ? [...new Set(albumTokenize(artistQ))] : [],
    judgeKey: 0,
  };
  liveSearches.set(id, state);
  // Keep the last few searches' files for folder fallbacks, drop older ones.
  if (liveSearches.size > 4) liveSearches.delete(liveSearches.keys().next().value);

  const c = await ensureConnected();

  let dirty = false;
  const add = (group) => {
    if (state.cancelled || !group || typeof group !== 'object') return;
    const user = String(group.username || group.user || '').trim();
    if (!user) return;
    state.peerSet.add(user);
    const slots = !!(group.slotsFree ?? group.hasFreeUploadSlot ?? group.slots);
    const speed = Number(group.avgSpeed ?? group.uploadSpeed ?? group.speed ?? 0) || 0;
    const queue = Number(group.queueLength) || 0;
    for (const fRaw of Array.isArray(group.files) ? group.files : []) {
      const f = pickFileFields(fRaw);
      if (!f.filename || !isAudioFile(f.filename)) continue;
      const fileId = `${user}::${f.filename}`;
      if (state.files.has(fileId)) continue;
      const filename = soulseekBasename(f.filename);
      state.files.set(fileId, {
        id: fileId,
        user,
        filePath: f.filename,
        filename,
        folder: soulseekParentFolder(f.filename),
        folderRaw: rawParent(f.filename),
        ext: path.extname(filename).slice(1).toLowerCase(),
        size: f.size,
        bitrate: f.bitrate,
        duration: f.duration,
        sampleRate: f.sampleRate,
        bitDepth: f.bitDepth,
        slots,
        speed,
        queue,
      });
      dirty = true;
    }
  };

  const snap = (done) => ({
    searchId: id,
    query: q,
    ...buildLiveSnapshot(state),
    done,
  });

  const pump = setInterval(() => {
    if (!dirty || state.cancelled) return;
    dirty = false;
    try { onUpdate?.(snap(false)); } catch { /* window gone */ }
  }, 450);

  /* The query as typed first, and with the artist known, the album or song
     words on their own alongside it: many clients won't return any file whose
     path names certain artists, so "lil wayne dedication 5" can come back
     empty while "dedication 5" finds the same folders. If it's still empty
     after a few seconds the cleaner variants join in, feeding the same list. */
  const variants = buildSoulseekQueryVariants(q);
  const isCancelled = () => state.cancelled;
  const okCount = () => { judgeAll(state); let n = 0; for (const f of state.files.values()) if (f.ok) n += 1; return n; };
  const runs = [];
  try {
    runs.push(collectSearch(c, variants[0], { maxMs, onResult: add, isCancelled }));
    if (split) {
      for (const v of buildSoulseekQueryVariants(restQ).slice(0, 1)) {
        if (v.toLowerCase() !== variants[0].toLowerCase()) runs.push(collectSearch(c, v, { maxMs, onResult: add, isCancelled }));
      }
    }
    for (let i = 1; i < variants.length; i += 1) {
      runs.push(new Promise((resolve) => {
        setTimeout(() => {
          if (state.cancelled || state.files.size) { resolve([]); return; }
          collectSearch(c, variants[i], { maxMs: maxMs - 2500 * i, onResult: add, isCancelled })
            .then(resolve, () => resolve([]));
        }, 2500 * i);
      }));
    }
    await Promise.all(runs);

    /* Still almost nothing and the artist wasn't known: drop words from the
       front, where the artist usually is, one at a time, until something
       answers. What was dropped still ranks results up when it's there. */
    const words = q.split(/\s+/).filter(Boolean);
    for (let drop = 1; !split && !state.cancelled && okCount() < 3 && words.length - drop >= 1; drop += 1) {
      const left = words.slice(drop).join(' ');
      const leftToks = albumTokenize(left);
      if (!leftToks.length || (leftToks.length === 1 && leftToks[0].length < 4)) break;
      state.core = [...new Set(leftToks)];
      state.extra = [...new Set(albumTokenize(words.slice(0, drop).join(' ')))];
      state.judgeKey += 1;
      dirty = true;
      await collectSearch(c, left, { maxMs, onResult: add, isCancelled });
    }
  } catch (e) {
    clearInterval(pump);
    forceDisconnect();
    throw new Error(String(e?.message || e));
  }
  clearInterval(pump);
  const last = snap(true);
  if (!state.cancelled) {
    try { onUpdate?.(last); } catch { /* window gone */ }
  }
  return last;
}

/* ---------- Opening a folder ----------
 *
 * A search only returns the files whose paths matched the words, so an
 * album folder found by its name usually shows two or three of its twelve
 * songs. Opening it asks the peer for the folder's whole listing, the way
 * the official client's "browse folder" does (peer message 36, answered by
 * 37). soulseek-ts doesn't speak that pair, so it's written here against
 * the peer connection it already holds. If the peer doesn't answer, the
 * files the search did turn up are the fallback.
 */
function readFolderContents(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const u64 = () => { const v = Number(buf.readBigUInt64LE(p)); p += 8; return v; };
  const u8 = () => { const v = buf.readUInt8(p); p += 1; return v; };
  const str = () => { const n = u32(); const v = buf.toString('utf8', p, p + n); p += n; return v; };

  const token = u32();
  const folder = str();
  const dirs = [];
  const nDirs = u32();
  for (let d = 0; d < nDirs; d += 1) {
    const dir = str();
    const nFiles = u32();
    const files = [];
    for (let i = 0; i < nFiles; i += 1) {
      u8(); // code
      const name = str();
      const size = u64();
      str(); // extension, unreliable, the name carries it
      const nAttrs = u32();
      const attrs = new Map();
      for (let a = 0; a < nAttrs; a += 1) {
        const k = u32();
        attrs.set(k, u32());
      }
      files.push({ name, size, attrs });
    }
    dirs.push({ dir, files });
  }
  return { token, folder, dirs };
}

function filesFromSearches(user, folderRaw) {
  const out = [];
  const seen = new Set();
  for (const s of liveSearches.values()) {
    for (const f of s.files.values()) {
      if (f.user !== user || seen.has(f.id)) continue;
      if (f.folderRaw !== folderRaw && albumFolderOf(f.folderRaw) !== folderRaw) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

export async function soulseekBrowseFolder({ user, folder, timeoutMs = 15_000 } = {}) {
  const who = String(user || '').trim();
  const folderRaw = String(folder || '');
  if (!who || !folderRaw) return { ok: false, error: 'Missing user or folder.' };

  const fallback = (error) => {
    const files = filesFromSearches(who, folderRaw).map((f) => ({ ...f, audio: true }));
    return { ok: files.length > 0, partial: true, error, user: who, folderRaw, dirs: files.length ? [{ path: folderRaw, files }] : [] };
  };

  let c;
  try { c = await ensureConnected(); } catch (e) { return fallback(String(e?.message || e)); }

  let peer;
  try {
    peer = await withTimeout(c.getPeerByUsername(who), 20_000, `Couldn’t reach ${who}.`);
  } catch {
    return fallback(`${who} didn’t answer. They may be offline or behind a firewall.`);
  }
  if (!peer?.conn || !peer?.msgs) return fallback('This peer can’t be browsed.');

  const token = crypto.randomBytes(4).readUInt32LE(0);
  const fb = Buffer.from(folderRaw, 'utf8');
  const body = Buffer.alloc(12 + fb.length);
  body.writeUInt32LE(36, 0);
  body.writeUInt32LE(token, 4);
  body.writeUInt32LE(fb.length, 8);
  fb.copy(body, 12);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);

  let listing;
  try {
    listing = await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        peer.msgs.off('message', onMsg);
        peer.off?.('close', onClose);
      };
      const onClose = () => { cleanup(); reject(new Error('closed')); };
      function onMsg(msg) {
        try {
          const data = msg?.data;
          if (!data || data.length < 8 || data.readUInt32LE(4) !== 37) return;
          const res = readFolderContents(zlib.unzipSync(data.subarray(8)));
          if (res.token !== token && res.folder !== folderRaw) return;
          cleanup();
          resolve(res);
        } catch { /* not ours, or garbled: keep waiting */ }
      }
      timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
      peer.msgs.on('message', onMsg);
      peer.once?.('close', onClose);
      peer.conn.write(Buffer.concat([head, body]));
    });
  } catch {
    return fallback(`${who} didn’t send the folder in time.`);
  }

  const dirs = [];
  for (const d of listing.dirs) {
    const sep = d.dir.includes('\\') ? '\\' : '/';
    const files = d.files.map((f) => {
      // Some clients send whole paths here instead of bare names.
      const filePath = /[\\/]/.test(f.name) ? f.name : `${d.dir}${sep}${f.name}`;
      const name = soulseekBasename(filePath);
      const ext = path.extname(name).slice(1).toLowerCase();
      return {
        id: `${who}::${filePath}`,
        user: who,
        filePath,
        filename: name,
        folder: soulseekParentFolder(filePath),
        folderRaw: d.dir,
        ext,
        size: f.size,
        bitrate: f.attrs.get(ATTR_BITRATE) || 0,
        duration: f.attrs.get(ATTR_DURATION) || 0,
        sampleRate: f.attrs.get(ATTR_SAMPLE_RATE) || 0,
        bitDepth: f.attrs.get(ATTR_BIT_DEPTH) || 0,
        audio: isAudioFile(name),
      };
    }).sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    dirs.push({ path: d.dir, files });
  }
  // The folder itself first, then its subfolders (Disc 1, Disc 2) in order.
  dirs.sort((a, b) => (a.path === folderRaw ? -1 : b.path === folderRaw ? 1 : a.path.localeCompare(b.path, undefined, { numeric: true })));

  if (!dirs.some((d) => d.files.some((f) => f.audio))) {
    const fb2 = fallback('');
    if (fb2.ok) return { ...fb2, error: 'The folder came back without any songs, so these are the files your search found.' };
    return { ok: false, user: who, folderRaw, dirs, error: 'This folder has no songs in it.' };
  }
  return { ok: true, partial: false, user: who, folderRaw, dirs };
}

/* ---------- Download ---------- */

const inflight = new Map();

export function soulseekCancelDownload(id) {
  const stream = inflight.get(String(id || ''));
  if (!stream) return false;
  try { stream.destroy(new Error('Canceled by user.')); } catch { /* ignore */ }
  inflight.delete(String(id || ''));
  return true;
}

/**
 * Download a single file. Resolves with the absolute output path.
 */
/**
 * Failure budget, per phase — the old code had a single 60s idle watchdog
 * that only existed AFTER the peer handshake, so an unreachable peer could
 * hang the download forever with zero feedback:
 *   handshakeTimeoutMs — connect to peer + get a transfer slot granted.
 *     Covers the indirect-connection fallback for firewalled peers; a peer
 *     that hasn't granted a slot in 20s almost never will.
 *   firstByteTimeoutMs — slot granted but no data yet (remotely queued).
 *   idleTimeoutMs      — mid-transfer stall. Most patient: a transfer that
 *     already moved bytes deserves time to recover from a network blip.
 */
export async function soulseekDownload({
  id, user, filePath, size = 0, outDir, onProgress,
  handshakeTimeoutMs = 20_000,
  firstByteTimeoutMs = 20_000,
  idleTimeoutMs = 60_000,
} = {}) {
  const c = await ensureConnected();

  fs.mkdirSync(outDir, { recursive: true });
  const filename = soulseekBasename(filePath);
  const safeName = (filename.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim())
    || `slsk-${Date.now()}.mp3`;
  let outPath = path.join(outDir, safeName);
  if (fs.existsSync(outPath)) {
    const ext = path.extname(safeName);
    const stem = ext ? safeName.slice(0, -ext.length) : safeName;
    outPath = path.join(outDir, `${stem}-${Date.now()}${ext}`);
  }

  let download;
  const dlPromise = c.download(user, filePath);
  dlPromise.catch(() => { /* handled below; avoids unhandled rejection if we time out first */ });
  try {
    download = await withTimeout(
      dlPromise, handshakeTimeoutMs,
      `Couldn't start transfer from "${user}" — peer unreachable or no upload slot after ${Math.round(handshakeTimeoutMs / 1000)}s.`
    );
  } catch (e) {
    // If the library resolves late (after our timeout), destroy the orphan
    // stream so we don't silently hold the peer's slot in the background.
    dlPromise.then((d) => { try { d?.stream?.destroy?.(); } catch { /* ignore */ } }).catch(() => {});
    const msg = String(e?.message || e);
    // Server-level socket death (common after sleep/wake) leaves a zombie
    // client that fails every future call instantly-or-forever. Reset so
    // the next attempt re-logins instead of reusing the corpse.
    if (/ECONNRESET|EPIPE|socket.*(closed|hang)|not connected|write after end/i.test(msg)) {
      forceDisconnect();
    }
    if (/user.*not exist|offline|cannot.*connect|peer.*unreach/i.test(msg)) {
      throw new Error(`User "${user}" is offline. Try another result.`);
    }
    if (/reject|denied/i.test(msg)) {
      throw new Error('Peer rejected the transfer (no slot, banned, or shares closed).');
    }
    throw new Error(msg);
  }

  const stream = download?.stream;
  if (!stream || typeof stream.on !== 'function') {
    throw new Error('Soulseek download did not return a stream.');
  }
  if (id) inflight.set(String(id), stream);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    let settled = false;
    let bytes = 0;
    let lastChunkAt = Date.now();
    let lastSampleAt = Date.now();
    let lastSampleBytes = 0;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (id) inflight.delete(String(id));
      clearInterval(watchdog);
      try { stream.destroy(); } catch { /* ignore */ }
      try { out.end(); } catch { /* ignore */ }
      if (err) {
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(outPath);
      }
    };

    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      if (bytes === 0) {
        // Slot granted but nothing sent — we're sitting in the peer's
        // remote upload queue. Fail fast; the caller can try the next
        // candidate instead of burning the full stall budget here.
        if (now - startedAt > firstByteTimeoutMs) {
          finish(new Error(`Peer accepted but never sent data (queued remotely, waited ${Math.round(firstByteTimeoutMs / 1000)}s).`));
        }
      } else if (now - lastChunkAt > idleTimeoutMs) {
        finish(new Error('Download stalled — peer stopped sending data.'));
      }
    }, 2_500);

    stream.on('data', (chunk) => {
      if (settled || !chunk) return;
      bytes += chunk.length;
      lastChunkAt = Date.now();
      const now = Date.now();
      const sampleAge = now - lastSampleAt;
      let throughputBps = 0;
      if (sampleAge >= 500) {
        throughputBps = Math.round((bytes - lastSampleBytes) * 1000 / sampleAge);
        lastSampleAt = now;
        lastSampleBytes = bytes;
      }
      const total = Number(size) || 0;
      const pct = total > 0 ? Math.min(1, bytes / total) : 0;
      try { onProgress?.({ bytes, totalBytes: total, pct, throughputBps }); } catch { /* ignore */ }
    });

    stream.on('error', (e) => finish(new Error(String(e?.message || e))));
    stream.on('end', () => finish(null));
    out.on('error', (e) => finish(new Error(`Disk write failed: ${e?.message || e}`)));

    stream.pipe(out);
  });
}
