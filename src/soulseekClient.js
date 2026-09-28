import fs from 'fs';
import path from 'path';
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

export function loadSoulseekCredentials() {
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

export function passesJunkFilter(query, filename, folderPath = '') {
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

// Variant markers that usually indicate the WRONG version of a track when
// the user imported a normal studio track. Separate from JUNK_WORDS so we
// can weight them and report which one tripped.
const VARIANT_MARKERS = [
  'live', 'remix', 'cover', 'instrumental', 'karaoke', 'acoustic',
  'sped up', 'speed up', 'slowed', 'nightcore', 'demo', 'remaster',
  'remastered', 're recorded', 're-recorded', 'rerecorded', 'edit',
  'radio edit', 'extended', 'reverb', '8d', 'mashup', 'bootleg',
  'session', 'unplugged', 'rehearsal',
];

// Words too generic to count as meaningful title/artist evidence.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'feat', 'ft',
  'featuring', 'with', 'pt', 'part', 'vol',
]);

function tokenize(s) {
  return normalizeForCompare(s)
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

// Fraction of `needleTokens` present in `hayTokens` (0..1).
function tokenOverlap(needleTokens, hayTokens) {
  if (needleTokens.length === 0) return 1; // nothing to match → not penalised
  const hay = new Set(hayTokens);
  let hit = 0;
  for (const t of needleTokens) if (hay.has(t)) hit += 1;
  return hit / needleTokens.length;
}

/**
 * Score one candidate against the intended track.
 * @param {object} cand   one soulseekSearch result (has filename, folder, duration)
 * @param {object} target { title, artist, durationMs }
 * @returns {{score:number, reasons:string[], penalties:string[]}}
 */
export function scoreSoulseekMatch(cand, target) {
  const reasons = [];
  const penalties = [];

  const fileText = `${normalizeForCompare(cand.filename || '')} ${normalizeForCompare(cand.folder || '')}`;
  const fileTokens = fileText.split(/\s+/).filter(Boolean);

  const titleTokens = tokenize(target?.title || '');
  const artistTokens = tokenize(target?.artist || '');

  const titleScore = tokenOverlap(titleTokens, fileTokens);   // 0..1
  const artistScore = tokenOverlap(artistTokens, fileTokens); // 0..1

  // Duration proximity. Soulseek file durations are in seconds; Spotify
  // gives ms. If either is missing we neither reward nor punish.
  let durScore = 0.5; // neutral when unknown
  const targetSec = target?.durationMs ? target.durationMs / 1000 : 0;
  const candSec = Number(cand.duration) || 0;
  if (targetSec > 0 && candSec > 0) {
    const diff = Math.abs(candSec - targetSec);
    if (diff <= 2) { durScore = 1; reasons.push('duration matches'); }
    else if (diff <= 5) durScore = 0.85;
    else if (diff <= 12) durScore = 0.55;
    else if (diff <= 30) durScore = 0.25;
    else { durScore = 0; penalties.push(`duration off by ${Math.round(diff)}s`); }
  }

  // Variant penalty: a marker in the file that is NOT in the requested
  // title/artist strongly suggests the wrong version.
  const targetText = `${normalizeForCompare(target?.title || '')} ${normalizeForCompare(target?.artist || '')}`;
  let variantPenalty = 0;
  for (const marker of VARIANT_MARKERS) {
    if (containsWord(fileText, marker) && !containsWord(targetText, marker)) {
      variantPenalty += 0.5;
      penalties.push(`"${marker}" version`);
    }
  }
  if (variantPenalty > 1) variantPenalty = 1;

  if (titleScore >= 0.99) reasons.push('title matches');
  else if (titleScore >= 0.6) reasons.push('title mostly matches');
  if (artistScore >= 0.99) reasons.push('artist matches');

  // Weighted blend. Title and artist dominate; duration and variant adjust.
  // Title 0.45, artist 0.30, duration 0.25, then subtract variant penalty.
  let score = (titleScore * 0.45) + (artistScore * 0.30) + (durScore * 0.25);
  score -= variantPenalty * 0.55;
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { score, reasons, penalties, titleScore, artistScore, durScore, variantPenalty };
}

/**
 * Pick the best-matching result from a list for the intended track.
 * Returns { best, scored, confident } where:
 *   - scored   : every candidate with its score, sorted best-first
 *   - best     : the top candidate (or null if list empty)
 *   - confident: true if `best` cleared the acceptance threshold
 *
 * Among candidates of similar match score we still prefer higher quality,
 * so we add a small quality nudge (bitrate tier / slots) as a tiebreaker.
 */
export function pickBestMatch(results, target, { threshold = 0.62 } = {}) {
  const list = Array.isArray(results) ? results : [];
  const scored = list.map((r) => {
    const m = scoreSoulseekMatch(r, target);
    // Small quality tiebreaker (max +0.04) so a clean studio FLAC edges out
    // a clean studio 192kbps mp3 without overriding match quality.
    const tier = bitrateTier(r.ext, r.bitrate); // 0..5
    const quality = (tier / 5) * 0.03 + (r.slots ? 0.01 : 0);
    return { ...r, _match: m, _rank: m.score + quality };
  });
  scored.sort((a, b) => b._rank - a._rank);
  const best = scored[0] || null;
  const confident = !!best && best._match.score >= threshold;
  return { best, scored, confident };
}

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
]);

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

export function soulseekParentFolder(filePath) {
  if (typeof filePath !== 'string') return '';
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/**
 * Pull file fields, tolerating naming variants between soulseek-ts
 * versions (bitRate vs bitrate vs bit_rate, etc.).
 */
function pickFileFields(f) {
  return {
    filename: String(f.filename ?? f.file ?? f.name ?? ''),
    size: Number(f.size ?? f.fileSize ?? 0) || 0,
    bitrate: Number(f.bitRate ?? f.bitrate ?? f.bit_rate ?? 0) || 0,
    duration: Number(f.duration ?? f.time ?? f.length ?? 0) || 0,
  };
}

function bitrateTier(ext, bitrate) {
  if (ext === 'flac' || ext === 'wav') return 5;
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
      raw = await c.search(variants[i], timeout ? { timeout } : undefined);
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
        slots,
        speed,
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
    if (alb.exts.has('flac') || alb.exts.has('wav')) return 'lossless';
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
  const cappedResults = dedup.slice(0, 10);

  return { results: cappedResults, albums };
}

/* ---------- Download ---------- */

const inflight = new Map();

export function soulseekCancelDownload(id) {
  const stream = inflight.get(String(id || ''));
  if (!stream) return false;
  try { stream.destroy(new Error('Cancelled by user.')); } catch { /* ignore */ }
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
