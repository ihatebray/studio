/**
 * itunesClient.js — fallback metadata provider using Apple's iTunes
 * Search API.
 *
 * Used when Spotify is unavailable: either the user never configured
 * Spotify credentials, or Spotify returned a rate-limit error (429).
 * The iTunes Search API needs no authentication and has far gentler
 * rate limits (~20 req/min per IP, undocumented but generous), making
 * it a reliable backstop.
 *
 * IMPORTANT — all exported functions return objects shaped IDENTICALLY
 * to the corresponding spotifyClient.js functions, so callers can swap
 * providers without branching on the result shape. The only field that
 * doesn't map is Spotify's track/album IDs (iTunes uses its own
 * numeric IDs, exposed as `itunesId`/`collectionId`).
 *
 * Matching quality is the whole game here. The raw iTunes Search API
 * ranks by popularity, which means compilations ("Now That's What I
 * Call Music"), karaoke versions, and tribute covers frequently
 * outrank the real track. We never just take results[0] — we filter
 * out junk, then score survivors, then return the best (or nothing if
 * nothing is confident enough). See scoreCandidate() for the logic.
 */

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup';

/** Prefix marking iTunes IDs travelling through Spotify-shaped fields. */
export const ITUNES_ID_PREFIX = 'itunes:';

/**
 * The LEAD credit of an artist string — who a record is actually BY, before
 * guests ride along. Mirrors leadCredit() in instantSearch.js on purpose: the
 * renderer and this module have to agree about whose song something is, or the
 * two of them filter features differently and the disagreement shows up as
 * rows that survive one pass and not the other.
 */
function leadCreditOf(s) {
  return String(s || '')
    .split(/\s*(?:,|;|\/|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b)\s*/i)[0]
    .trim();
}

/**
 * Is this credit BY this artist? Mirrors creditMatchesArtist in
 * instantSearch.js — see that function for why the credit is tested against
 * the whole name rather than decomposed. Band names containing "with", "&" or
 * a comma ("Sleeping With Sirens", "Earth, Wind & Fire") fail every
 * decomposition-based check, including checks against their own name.
 */
function creditIsArtist(credit, artist) {
  const a = String(artist || '').trim();
  if (!a) return true;
  const c = String(credit || '').trim();
  // Case/space-insensitive but punctuation-SENSITIVE, so "Slay-R" never
  // passes as "Slayr". Same rule as normStrict in instantSearch.js.
  const strict = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (strict(c) === strict(a)) return true;
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s*${esc}\\s*(?:,|;|/|&|\\+|\\bfeat\\.?\\b|\\bft\\.?\\b|\\bwith\\b|\\bvs\\.?\\b|\\bx\\b|$)`,
    'i',
  ).test(c);
}

/**
 * Normalize a title/artist string for fuzzy comparison: lowercase,
 * strip parentheticals & brackets (so "Song (feat. X)" matches "Song"),
 * drop punctuation, collapse whitespace.
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identity key for collapsing DUPLICATE LISTINGS of one artist.
 *
 * Punctuation is preserved on purpose. The obvious thing is to run the name
 * through normalize(), which strips it — and that is wrong here, because
 * "Slayr" and "Slay-R" are two different acts that normalize to the same
 * string. Collapsing them merged one artist's catalogue into the other's and
 * put both of their songs on one page under one name.
 *
 * What this IS for is the real duplicate: iTunes listing the same artist twice
 * under a byte-identical name, or once with a vendor suffix ("Slayr - Topic").
 * Those match exactly once case and the suffix are dealt with, and nothing
 * looser is safe.
 */
function exactNameKey(s) {
  return String(s || '')
    .replace(/\s*[-–—:|]\s*(vevo|hmv|official|topic|music)\s*$/i, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Loose key — punctuation and case removed. Used only for RANKING, never for
 * merging: it's how a query typed "slayr" still finds "Slay-R" when that's the
 * only candidate, while exactNameKey keeps the two apart when both exist.
 */
function canonicalArtistName(s) {
  return normalize(
    String(s || '').replace(/\s*[-–—:|]\s*(vevo|hmv|official|topic|music)\s*$/i, ''),
  );
}

/**
 * Regex of collection/album names that indicate a compilation,
 * karaoke, tribute, or other not-the-real-release. Matched against
 * iTunes `collectionName`. These are the usual suspects that pollute
 * iTunes Search results.
 */
const JUNK_COLLECTION = /various artists|now that'?s what|karaoke|tribute|made famous|originally performed|in the style of|workout|cover version|covers? of|instrumental versions?|as made popular|hit crew|ringtone/i;

/* ---------------------------------------------------------------------------
 *  Request layer: coalescing, caching, throttling
 *
 *  A single keystroke fans out into three independent searches — tracks,
 *  albums, artists — and each of those independently resolves the artist,
 *  looks up their discography, and expands releases. Nothing knew what the
 *  others were doing, so one search for "justin bieber" issued around sixty
 *  requests, of which roughly forty were byte-identical to one already in
 *  flight beside them. iTunes throttles somewhere near 20/min per IP, so the
 *  surplus didn't just waste time, it pushed the useful requests into the
 *  retry-and-wait band and made the whole panel feel slow.
 *
 *  Three cheap mechanisms, all keyed on the final URL:
 *    INFLIGHT — identical concurrent requests share one promise. This is the
 *               big one; it collapses the duplicate resolveArtist and
 *               discography lookups across the three parallel searches
 *               without any of them having to know the others exist.
 *    CACHE    — short TTL. Catalogue data doesn't move minute to minute, and
 *               a user refining a query re-issues most of the same lookups.
 *    GATE     — a ceiling on concurrency. Firing sixty requests at once earns
 *               throttling; a steady eight finishes sooner in wall-clock terms.
 * ------------------------------------------------------------------------- */

/* Catalogue data barely moves, so the response cache is generous and is
   persisted to disk — a request we never repeat is the cheapest kind of rate
   limiting there is. */
const ITUNES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ITUNES_CACHE_MAX = 3000;
const ITUNES_MAX_CONCURRENT = 6;

/* ---------------------------------------------------------------------------
 *  Staying under the rate limit
 *
 *  iTunes allows roughly 20 requests per minute per IP and answers 403 past
 *  that — not 429, and with no Retry-After, so it reads like a permissions
 *  error rather than a quota one. Callers catch it and return empty, which
 *  surfaces as an artist with no albums or a missing artist page: the failure
 *  is silent and looks like missing data rather than a throttle.
 *
 *  Two mechanisms, because there are two different problems:
 *
 *  BUDGET — a token bucket refilled continuously to a ceiling deliberately set
 *  below Apple's. Requests wait for a token instead of being sent and
 *  rejected. Waiting is slower than failing, but a slow answer is worth more
 *  than a fast blank.
 *
 *  PRIORITY — not every request is worth the same. Core work (the searches
 *  whose results the user is looking at) waits for its token however long that
 *  takes. Discretionary work (verifying releases that have audio, expanding a
 *  discography for deep cuts, fetching a portrait) is SKIPPED when the budget
 *  runs low, and every one of those callers already handles an empty result by
 *  falling back to something reasonable. Under pressure the app gets less
 *  thorough rather than less functional.
 * ------------------------------------------------------------------------- */

const ITUNES_BUDGET_PER_MIN = 15;          // Apple's ceiling is ~20; leave headroom.
const ITUNES_EXTRA_RESERVE = 5;            // Slots core-only work keeps for itself.
const ITUNES_WINDOW_MS = 60000;

/* Timestamps of recent requests — a ROLLING WINDOW, not a token bucket.
 *
 * The distinction matters and I got it wrong first: a bucket that starts full
 * and refills continuously permits its whole capacity as an instant burst AND
 * the refill on top, so a 16/min bucket sends over 30 in the opening minute.
 * Apple counts requests in a trailing 60 seconds, so the limiter has to count
 * the same way to predict it. */
let itunesSends = [];
let itunesPausedUntil = 0;                 // Set when Apple actually 403s us.

function recentSends() {
  const cutoff = Date.now() - ITUNES_WINDOW_MS;
  if (itunesSends.length && itunesSends[0] < cutoff) {
    itunesSends = itunesSends.filter((t) => t >= cutoff);
  }
  return itunesSends.length;
}

/** ms until a slot frees up, or 0 if one is free now. */
function waitForSlot(reserve = 0) {
  if (Date.now() < itunesPausedUntil) return itunesPausedUntil - Date.now();
  const used = recentSends();
  const ceiling = ITUNES_BUDGET_PER_MIN - reserve;
  if (used < ceiling) return 0;
  const oldest = itunesSends[used - ceiling] ?? itunesSends[0];
  return Math.max(50, (oldest + ITUNES_WINDOW_MS) - Date.now());
}

/** True while we're in a cooldown after Apple actually throttled us. */
export function itunesIsThrottled() {
  return Date.now() < itunesPausedUntil;
}

/** Thrown when a discretionary request is skipped to protect the budget. */
class ItunesSkipped extends Error {
  constructor() { super('iTunes request skipped (budget)'); this.skipped = true; }
}

const itunesInflight = new Map();   // url → Promise
const itunesCache = new Map();      // url → { at, data }

let itunesActive = 0;
const itunesQueue = [];

function pump() {
  while (itunesQueue.length && itunesActive < ITUNES_MAX_CONCURRENT) {
    if (waitForSlot() > 0) break;
    itunesSends.push(Date.now());
    const job = itunesQueue.shift();
    itunesActive += 1;
    job().finally(() => { itunesActive -= 1; setTimeout(pump, 0); });
  }
  if (itunesQueue.length) {
    setTimeout(pump, Math.min(Math.max(waitForSlot(), 50), 2000));
  }
}

function itunesGate(run, priority = 'core') {
  if (priority === 'extra') {
    /* Skipped rather than queued. A discretionary request that waits still
       occupies a slot core work may need a moment later, and every caller that
       marks a request 'extra' is built to cope with getting nothing back. */
    if (waitForSlot(ITUNES_EXTRA_RESERVE) > 0) return Promise.reject(new ItunesSkipped());
  }
  return new Promise((resolve, reject) => {
    itunesQueue.push(() => run().then(resolve, reject));
    pump();
  });
}

/** Snapshot/restore so a restart doesn't re-earn requests we already spent. */
export function itunesResponseCacheSnapshot() {
  const out = {};
  for (const [url, v] of itunesCache) out[url] = v;
  return out;
}

export function itunesResponseCacheRestore(obj) {
  if (!obj || typeof obj !== 'object') return;
  const now = Date.now();
  for (const [url, v] of Object.entries(obj)) {
    if (v && Array.isArray(v.data) && now - v.at < ITUNES_CACHE_TTL_MS) itunesCache.set(url, v);
  }
}

/**
 * Raw fetch of the iTunes Search API. Returns the parsed `results`
 * array (possibly empty). Throws on network/HTTP error so callers can
 * distinguish "no results" from "couldn't reach iTunes".
 */
async function itunesGet(params, { priority = 'core', attempt = 0 } = {}) {
  // id-based requests must use the lookup endpoint; term-based requests
  // use search. The search endpoint silently ignores `id` and returns
  // nothing, which is exactly the bug that made iTunes albums show no
  // tracks when expanded.
  const base = params.id ? ITUNES_LOOKUP_URL : ITUNES_SEARCH_URL;
  const url = `${base}?${new URLSearchParams(params).toString()}`;

  const hit = itunesCache.get(url);
  if (hit && Date.now() - hit.at < ITUNES_CACHE_TTL_MS) return hit.data;

  const pending = itunesInflight.get(url);
  if (pending) return pending;

  const p = itunesGate(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 403 || res.status === 429) {
      /* We were throttled despite the budget — clocks drift, other windows of
         the app share the IP. Stop everything briefly rather than spending the
         next requests learning the same thing. */
      const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
      itunesPausedUntil = Date.now() + (retryAfter ? retryAfter * 1000 : 5000 * (attempt + 1));
      /* Assume the window is full — we clearly mispredicted it. */
      const now = Date.now();
      itunesSends = Array.from({ length: ITUNES_BUDGET_PER_MIN }, () => now);
      const err = new Error(`iTunes API (${res.status})`);
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`iTunes API (${res.status})`);
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  }, priority)
    .then((data) => {
      if (itunesCache.size >= ITUNES_CACHE_MAX) {
        // Oldest insertion first — Map preserves insertion order.
        itunesCache.delete(itunesCache.keys().next().value);
      }
      itunesCache.set(url, { at: Date.now(), data });
      return data;
    })
    .finally(() => { itunesInflight.delete(url); });

  itunesInflight.set(url, p);

  /* One retry for core work after a throttle. The pause above means the retry
     lands on the far side of the cooldown rather than immediately. */
  if (priority === 'core' && attempt < 1) {
    return p.catch((e) => {
      if (!e?.rateLimited) throw e;
      return itunesGet(params, { priority, attempt: attempt + 1 });
    });
  }
  return p;
}

/**
 * Map iTunes explicitness string to a boolean.
 *   "explicit"    → true
 *   "cleaned"     → false  (this IS the clean version)
 *   "notExplicit" → false
 * Anything else (missing) → null (unknown).
 */
function mapExplicit(trackExplicitness) {
  if (trackExplicitness === 'explicit') return true;
  if (trackExplicitness === 'cleaned' || trackExplicitness === 'notExplicit') return false;
  return null;
}

/**
 * Upgrade an iTunes artwork URL to a higher resolution. iTunes returns
 * `artworkUrl100` (100×100) by default, but the URL pattern lets you
 * request any size by swapping the dimension token. We bump to 600×600
 * which is comparable to Spotify's max and looks good in the now-
 * playing canvas without being wastefully huge.
 *
 * Pattern: ".../source/100x100bb.jpg" → ".../source/600x600bb.jpg"
 */
function upgradeArtwork(url, size = 600) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/\/\d+x\d+bb\.(jpg|png)/, `/${size}x${size}bb.$1`);
}

/**
 * Key for collapsing the SAME release listed twice — different storefronts,
 * re-uploads, identical titles.
 *
 * Deliberately keeps parentheticals, which `normalize()` throws away. An
 * edition suffix is not cosmetic: "Justice", "Justice (Deluxe)" and "Justice
 * (Triple Chucks Deluxe / Deluxe Video Version)" are three different records
 * with three different tracklists. Normalising them to "justice" collapsed all
 * three into one key, and since the dedupe keeps whichever has the most
 * tracks, the 27-track video edition won and the actual album vanished off the
 * artist page. Duplicate LISTINGS share a title exactly; different editions
 * don't, so exact-title matching is the rule that separates them.
 */
function releaseKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Releases whose contents are music VIDEOS rather than audio.
 *
 * iTunes files these as ordinary collections — same wrapperType, same
 * collectionType "Album" — so nothing on the record itself says "this has no
 * songs in it". But a lookup for their tracks with entity=song comes back
 * empty, which is why clicking one opened a peek with a title, a cover, a
 * track count and no tracks at all. The name is the only tell available
 * before that request, and Apple is consistent about putting it there.
 */
const VIDEO_RELEASE = /\bvideo (?:version|album|collection)\b|\bthe videos?\b|\bvisual(?:iser|izer) album\b|\bmusic videos?\b/i;

/**
 * Score an iTunes track candidate against what we're looking for.
 * Higher is better. Returns -Infinity for candidates that should be
 * rejected outright (compilation, wrong artist, etc.).
 *
 * @param {object} cand     raw iTunes result
 * @param {object} target   { title, artist, album?, durationMs? }
 */
function scoreCandidate(cand, target) {
  // Hard rejections first.
  if (cand.kind && cand.kind !== 'song') return -Infinity;
  if (JUNK_COLLECTION.test(cand.collectionName || '')) return -Infinity;

  const candTitle = normalize(cand.trackName);
  const candArtist = normalize(cand.artistName);
  const wantTitle = normalize(target.title);
  const wantArtist = normalize(target.artist);

  if (!candTitle || !wantTitle) return -Infinity;

  // Title matching. The old logic used naive substring containment in
  // either direction, which is dangerously loose for short titles:
  // "you" is a substring of "you too", "thank you", "all of you", and
  // hundreds of others, so a file titled "You" would match the wrong
  // song (and pull the wrong cover art). We use a stricter scheme:
  //
  //   - Exact normalized match → best.
  //   - Otherwise require strong WORD-LEVEL overlap: every word of the
  //     shorter title must appear as a whole word in the longer one,
  //     AND the shorter title must be a meaningful fraction (≥60%) of
  //     the longer one's word count. This lets "you too" match
  //     "you too (bonus)" but rejects "you" matching "you too".
  const titleExact = candTitle === wantTitle;
  let titleWordMatch = false;
  if (!titleExact) {
    const candWords = candTitle.split(' ').filter(Boolean);
    const wantWords = wantTitle.split(' ').filter(Boolean);
    const [shorter, longer] = wantWords.length <= candWords.length
      ? [wantWords, candWords] : [candWords, wantWords];
    const longerSet = new Set(longer);
    const allPresent = shorter.every((w) => longerSet.has(w));
    const fraction = shorter.length / longer.length;
    titleWordMatch = allPresent && fraction >= 0.6;
  }
  if (!titleExact && !titleWordMatch) return -Infinity;

  // Artist must overlap by at least one significant token (3+ chars).
  // This kills karaoke/tribute results whose artistName is the cover
  // band, not the real artist.
  let artistOverlap = false;
  if (wantArtist) {
    const wantTokens = new Set(wantArtist.split(' ').filter((t) => t.length >= 3));
    const candTokens = new Set(candArtist.split(' ').filter((t) => t.length >= 3));
    for (const t of wantTokens) {
      if (candTokens.has(t)) { artistOverlap = true; break; }
    }
    if (!artistOverlap) return -Infinity;
  }

  // Passed the filters — now score.
  let score = 0;

  // Title exactness
  if (titleExact) score += 10;
  else score += 4;

  // Duration proximity. This is the strongest discriminator since it
  // separates the real track from live versions / remixes / radio edits
  // that share a title. Only applies if we know the file's duration.
  if (target.durationMs && cand.trackTimeMillis) {
    const diffSec = Math.abs(target.durationMs - cand.trackTimeMillis) / 1000;
    if (diffSec <= 2) score += 12;        // basically certain
    else if (diffSec <= 5) score += 6;    // close enough — minor encoding diffs
    else if (diffSec <= 12) score += 1;   // same-ish, weak signal
    else score -= 8;                      // different version — penalize hard
  }

  // Album match (if we have a target album to compare)
  if (target.album) {
    const wantAlbum = normalize(target.album);
    const candAlbum = normalize(cand.collectionName);
    if (wantAlbum && candAlbum && (candAlbum === wantAlbum || candAlbum.includes(wantAlbum) || wantAlbum.includes(candAlbum))) {
      score += 5;
    }
  }

  // Prefer albums over singles (a "single" release often has a slightly
  // different master than the album version the user likely has).
  if (cand.collectionType === 'Album') score += 1;

  // Slight bias toward the explicit version. iTunes often lists both a
  // clean and explicit cut of the same song with near-identical
  // durations, so duration scoring alone can't separate them. Most
  // downloaded files are the explicit version, and the "E" badge is
  // meant to indicate the song HAS explicit content — so when two
  // candidates are otherwise tied, prefer the explicit one. Small
  // weight (2) so it only breaks ties, never overrides a better
  // title/duration/album match.
  if (cand.trackExplicitness === 'explicit') score += 2;

  return score;
}

/**
 * Map a raw iTunes track result into the spotifyClient track shape.
 */
function mapTrack(cand) {
  return {
    // Reuse the spotifyId field as the universal track identifier the
    // renderer keys on. iTunes tracks get an "itunes:"-prefixed ID so
    // they're unique and non-empty (the import paths already understand
    // this prefix — see the New Releases feature). Without this,
    // selecting/importing iTunes album tracks breaks because every row
    // would share an empty spotifyId.
    spotifyId: cand.trackId ? `itunes:${cand.trackId}` : '',
    itunesId: cand.trackId || null,
    collectionId: cand.collectionId || null,
    title: cand.trackName || '',
    name: cand.trackName || '',
    artists: cand.artistName || '',
    artist: cand.artistName || '',
    album: cand.collectionName || '',
    albumArtUrl: upgradeArtwork(cand.artworkUrl100 || cand.artworkUrl60 || ''),
    imageUrl: upgradeArtwork(cand.artworkUrl100 || cand.artworkUrl60 || ''),
    durationMs: cand.trackTimeMillis || 0,
    spotifyUrl: cand.trackViewUrl || '',
    explicit: mapExplicit(cand.trackExplicitness),
    trackNumber: cand.trackNumber || null,
    discNumber: cand.discNumber || null,
    releaseDate: cand.releaseDate || '',
    genre: cand.primaryGenreName || '',
    provider: 'itunes',
  };
}

/**
 * Search iTunes for tracks matching a free-text query. Returns an
 * array shaped like spotifySearchTracks(). Results are NOT confidence-
 * filtered here (that's for the cross-check path) — this is the raw
 * search used by the Find tab, where the user sees and picks results
 * themselves. We do still drop obvious junk (compilations/karaoke) and
 * non-songs so the list isn't polluted.
 *
 * @param {string} q
 * @returns {Promise<Array>}
 */
/**
 * Resolve a free-text query to the most likely iTunes artist record.
 * Tries progressively shorter prefixes of the query as artist-name
 * guesses ("lil uzi vert moon" → "lil uzi vert" → "lil uzi" → "lil").
 * Returns the artist object (with artistId) or null.
 *
 * We match the returned artistName against our guess to avoid picking a
 * wrong artist — iTunes' musicArtist search for "lil" returns "Lil
 * Tjay", "Lil Tecca" etc., so we prefer an artist whose name actually
 * contains (or is contained by) the guess.
 */
async function resolveArtist(words) {
  const guesses = [];
  if (words.length >= 3) guesses.push(words.slice(0, 3).join(' '));
  if (words.length >= 2) guesses.push(words.slice(0, 2).join(' '));
  if (words.length >= 1) guesses.push(words[0]);

  for (const guess of guesses) {
    let hits;
    try {
      hits = await itunesGet({ term: guess, entity: 'musicArtist', media: 'music', limit: 5 });
    } catch {
      continue;
    }
    if (!Array.isArray(hits) || !hits.length) continue;
    const gNorm = normalize(guess);
    // Prefer an artist whose normalized name matches the guess closely.
    const exacts = hits.filter((a) => a.artistId && canonicalArtistName(a.artistName) === gNorm);
    if (exacts.length === 1) return exacts[0];
    if (exacts.length > 1) {
      // Several entities share the name — the one with the real discography is
      // the real artist. Distributor duplicates carry a handful of junk
      // compilations, and picking one of those is how an artist page ends up
      // showing five EPs nobody has heard of instead of the actual catalogue.
      const sizes = await Promise.all(exacts.map((a) => albumsForEntity(a.artistId)));
      let at = 0;
      for (let i = 1; i < sizes.length; i += 1) {
        if (sizes[i].length > sizes[at].length) at = i;
      }
      return exacts[at];
    }
    const contains = hits.find((a) => {
      if (!a.artistId) return false;
      const an = normalize(a.artistName);
      return an.includes(gNorm) || gNorm.includes(an);
    });
    if (contains) return contains;
    // Only fall back to "first result" for multi-word guesses — a
    // single short word like "lil" matches too many wrong artists.
    if (guess.includes(' ') && hits[0]?.artistId) return hits[0];
  }
  return null;
}

/**
 * Given an iTunes artistId, fetch the artist's albums and then every
 * track on those albums. This is the reliable way to enumerate a full
 * discography — far better than the song-entity artist lookup, which
 * caps at ~200 songs (truncating large catalogs like Lil Uzi Vert's,
 * dropping deep cuts).
 *
 * Returns { albums: [...rawAlbumRecords], tracks: [...rawTrackRecords] }.
 * Both are raw iTunes records (not yet mapped), deduped by id.
 *
 * `maxAlbumsForTracks` bounds how many albums we expand into tracks, to
 * keep latency sane for prolific artists. Albums are taken in iTunes'
 * order (roughly recency/popularity). The album LIST itself is always
 * returned in full regardless of this cap.
 */
async function fetchArtistDiscography(artistId, { maxAlbumsForTracks = 25 } = {}) {
  let albumLookup;
  try {
    albumLookup = await itunesGet({ id: String(artistId), entity: 'album', limit: 200 });
  } catch {
    return { albums: [], tracks: [] };
  }
  const albums = (albumLookup || []).filter(
    (r) => r.wrapperType === 'collection' && r.collectionId && !JUNK_COLLECTION.test(r.collectionName || ''),
  );

  // Expand albums into their tracks. The lookup endpoint accepts
  // comma-separated ids, so a batch of six costs one request instead of six —
  // this was thirty separate requests per track search, which on its own was
  // more than the whole rate-limit budget for a minute.
  //
  // Batch size is bounded by `limit`, which caps the TOTAL rows returned
  // across every id in the request. Six albums against a 200-row limit leaves
  // room for a 44-track deluxe without crowding out its neighbours; the
  // truncation guard below catches the case where it doesn't.
  const toExpand = albums.slice(0, maxAlbumsForTracks);
  const trackBatches = await Promise.all(
    chunk(toExpand.map((a) => a.collectionId), 6).map((ids) =>
      lookupSongsForCollections(ids, 'extra').catch(() => [])),
  );

  const tracks = [];
  const seen = new Set();
  for (const batch of trackBatches) {
    for (const t of batch) {
      if (!t.trackId || seen.has(t.trackId)) continue;
      seen.add(t.trackId);
      tracks.push(t);
    }
  }
  return { albums, tracks };
}

/** Split an array into fixed-size chunks. */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Song rows for several collections in one request.
 *
 * `limit` bounds the whole response, not each id, so a batch whose albums are
 * unusually long can be cut off mid-way — and a truncated response is
 * indistinguishable from "these later albums are empty", which is a dangerous
 * thing to conclude when callers use it to decide what to hide. When the
 * response comes back at the ceiling we can't trust the tail, so we re-ask per
 * id and pay the requests we were trying to avoid. That's rare, and being slow
 * occasionally beats deleting real records.
 */
async function lookupSongsForCollections(ids, priority = 'core') {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return [];
  const LIMIT = 200;
  const rows = await itunesGet({ id: list.join(','), entity: 'song', limit: LIMIT }, { priority });
  const songs = (rows || []).filter((r) => (r.wrapperType === 'track' || r.kind === 'song') && r.trackId);

  if (rows.length < LIMIT || list.length === 1) return songs;

  /* The per-id fallback is always discretionary regardless of the caller: it
     only runs on a truncated batch, and spending a request per album to
     recover the tail is exactly the kind of thoroughness worth dropping when
     the budget is tight. */
  const perId = await Promise.all(list.map((id) =>
    itunesGet({ id: String(id), entity: 'song', limit: LIMIT }, { priority: 'extra' })
      .then((rs) => (rs || []).filter((r) => (r.wrapperType === 'track' || r.kind === 'song') && r.trackId))
      .catch(() => [])));
  return perId.flat();
}

/**
 * Score how well a track matches a free-text search query, for
 * client-side re-ranking. iTunes returns results in popularity order,
 * which buries less-popular songs even when the user clearly typed
 * their title — e.g. "chase atlantic you" returns Chase Atlantic's
 * hits, not "YOU TOO." We re-rank by actual relevance to the query.
 *
 * The query is split into tokens. We figure out which tokens match the
 * artist vs the title and reward results that satisfy BOTH the artist
 * part and the title part of the query. Returns a breakdown object:
 * { score, titleHits, artistHits, albumHits, unmatched }.
 */
function scoreSearchRelevance(cand, queryTokens) {
  const candTitleWords = new Set(normalize(cand.trackName).split(' ').filter(Boolean));
  const candArtistWords = new Set(normalize(cand.artistName).split(' ').filter(Boolean));
  const candAlbumWords = new Set(normalize(cand.collectionName).split(' ').filter(Boolean));

  let titleHits = 0;
  let artistHits = 0;
  let albumHits = 0;
  let unmatched = 0;

  for (const tok of queryTokens) {
    const inTitle = candTitleWords.has(tok);
    const inArtist = candArtistWords.has(tok);
    const inAlbum = candAlbumWords.has(tok);
    if (inTitle) titleHits += 1;
    else if (inArtist) artistHits += 1;
    else if (inAlbum) albumHits += 1;
    else unmatched += 1;
  }

  // Every query token that matches something is good. Title matches are
  // weighted highest (that's usually the song the user wants), artist
  // next, album least. Unmatched tokens are penalized so a result that
  // ignores half the query sinks.
  let score = titleHits * 6 + artistHits * 4 + albumHits * 1 - unmatched * 3;

  // Bonus: if the query matched BOTH a title word and an artist word,
  // it's very likely the exact "artist + song" the user meant. This is
  // the key signal that surfaces "YOU TOO." for "chase atlantic you".
  if (titleHits > 0 && artistHits > 0) score += 8;

  return { score, titleHits, artistHits, albumHits, unmatched };
}

/**
 * Search iTunes for tracks matching a free-text query. Returns an
 * array shaped like spotifySearchTracks(), re-ranked by relevance.
 *
 * iTunes' search endpoint does strict-ish AND matching and pads results
 * with duplicate releases (the same song across albums/singles/regions).
 * This means a query like "chase atlantic amy" can return ZERO results
 * (if iTunes doesn't index that exact word combo on the track), while
 * "chase atlantic you" returns 100 rows that are 90% duplicate "Swim"
 * and "Consume" entries — burying the song you actually wanted.
 *
 * Strategy to be resilient to both:
 *   1. Fire SEVERAL queries in parallel:
 *        - the full query as typed
 *        - the query minus the first word (handles "artist song" where
 *          the artist match is over-constraining)
 *        - just the last 1-2 words (the likely song title)
 *      More queries = more chance the target song appears in SOME set.
 *   2. Merge all results, dedupe by trackId.
 *   3. Drop junk (compilations/karaoke) and non-songs.
 *   4. Re-rank everything by relevance to the FULL original query.
 *   5. Return the top 25.
 *
 * @param {string} q
 * @returns {Promise<Array>}
 */
export async function itunesSearchTracks(q) {
  const query = String(q || '').trim();
  if (!query) return [];

  const words = query.split(/\s+/).filter(Boolean);

  // Build a small set of query variants. Using a Set dedupes identical
  // variants (e.g. for a one-word query they all collapse to one).
  const variants = new Set();
  variants.add(query);                              // full query
  if (words.length >= 2) {
    variants.add(words.slice(1).join(' '));         // drop first word (artist)
    variants.add(words.slice(-2).join(' '));        // last two words (likely title)
    variants.add(words[words.length - 1]);          // last word alone
  }

  // Fire all song-search variants in parallel. Each is best-effort.
  const songSearchPromise = Promise.all(
    Array.from(variants).map((term) =>
      itunesGet({ term, entity: 'song', media: 'music', limit: 100 }).catch(() => []),
    ),
  );

  // ALSO pull the artist's discography by expanding their albums into
  // tracks. This finds songs iTunes' text search can't surface and,
  // unlike the song-entity artist lookup (capped at ~200), it scales to
  // large catalogs because we fetch tracks album-by-album. This is what
  // surfaces deep cuts like "Moon Relate" on Eternal Atake.
  //
  // We also keep the resolved artist around: if the query named a real
  // artist, we'll require results to actually be by that artist, so a
  // search like "drake shabang" doesn't return "Shabang" songs by
  // unrelated artists.
  const artistCatalogPromise = (async () => {
    const artist = await resolveArtist(words);
    if (!artist?.artistId) return { artist: null, tracks: [] };
    /* 12, not 30. Thirty releases is five batched lookups deep on the critical
       path of every track search; twelve is two, and still covers roughly a
       hundred and fifty candidate tracks for a result list that shows a couple
       of dozen. The plain song searches above already cover the hits — this
       pass exists to reach deep cuts, and it reaches plenty at twelve. */
    const { tracks } = await fetchArtistDiscography(artist.artistId, { maxAlbumsForTracks: 12 });
    return { artist, tracks };
  })();

  const [songBatches, catalogResult] = await Promise.all([songSearchPromise, artistCatalogPromise]);
  const resolvedArtist = catalogResult.artist;
  const catalog = catalogResult.tracks;

  // Tokens of the resolved artist's name, for artist-match filtering.
  const resolvedArtistTokens = resolvedArtist
    ? new Set(normalize(resolvedArtist.artistName).split(' ').filter((t) => t.length >= 2))
    : null;

  // Merge + dedupe by trackId across all sources.
  const byTrackId = new Map();
  const addAll = (arr) => {
    for (const r of arr) {
      if (!r.trackId) continue;
      if (byTrackId.has(r.trackId)) continue;
      if (r.kind && r.kind !== 'song') continue;
      if (JUNK_COLLECTION.test(r.collectionName || '')) continue;
      byTrackId.set(r.trackId, r);
    }
  };
  for (const batch of songBatches) addAll(batch);
  addAll(catalog);

  const queryTokens = normalize(query).split(' ').filter((t) => t.length >= 2);
  const merged = Array.from(byTrackId.values());

  const scored = merged.map((r, i) => ({
    r, i, ...scoreSearchRelevance(r, queryTokens),
  }));

  // Figure out how many query tokens are "title words" — i.e. not
  // matched by the artist of any candidate. If the query is purely an
  // artist name (e.g. "chase atlantic"), every catalog track is a
  // valid result. But if the query has title words too (e.g. "chase
  // atlantic amy"), we should ONLY show tracks whose title matches one
  // of those words — otherwise pulling in the artist's whole catalog
  // would dump every Chase Atlantic song for an "amy" query.
  const maxArtistHits = scored.reduce((m, s) => Math.max(m, s.artistHits), 0);
  const queryHasTitleWords = queryTokens.length > maxArtistHits;

  let relevant = scored.filter((s) => {
    if (s.score <= 0) return false;
    // When the query includes title words, require a title hit.
    if (queryHasTitleWords && s.titleHits === 0) return false;
    // When the query named a real artist, require the candidate to
    // actually be by that artist. This stops "drake shabang" from
    // returning "Shabang" by unrelated artists — they match the title
    // but not the artist the user clearly specified.
    if (resolvedArtistTokens && resolvedArtistTokens.size > 0) {
      const candArtistWords = new Set(normalize(s.r.artistName).split(' ').filter(Boolean));
      let artistMatch = false;
      for (const tok of resolvedArtistTokens) {
        if (candArtistWords.has(tok)) { artistMatch = true; break; }
      }
      if (!artistMatch) return false;
    }
    return true;
  });

  // Fallback: if requiring the artist wiped everything (e.g. resolve
  // misfired, or the user really did want a title-only search), retry
  // without the artist requirement so the user still sees results.
  if (relevant.length === 0 && resolvedArtistTokens) {
    relevant = scored.filter((s) => {
      if (s.score <= 0) return false;
      if (queryHasTitleWords && s.titleHits === 0) return false;
      return true;
    });
  }

  // Fallback: if the title-required filter wiped everything (e.g. our
  // artist-word detection misfired), fall back to plain score > 0 so
  // the user still sees something.
  if (relevant.length === 0) {
    relevant = scored.filter((s) => s.score > 0);
  }

  relevant.sort((a, b) => (b.score - a.score) || (a.i - b.i));

  return relevant.slice(0, 25).map((s) => mapTrack(s.r));
}

/**
 * Search iTunes for albums. Returns array shaped like
 * spotifySearchAlbums(). Same junk filtering as track search.
 */
export async function itunesSearchAlbums(q) {
  const query = String(q || '').trim();
  if (!query) return [];

  const words = query.split(/\s+/).filter(Boolean);
  const variants = new Set();
  variants.add(query);
  if (words.length >= 2) {
    variants.add(words.slice(1).join(' '));
    variants.add(words.slice(-2).join(' '));
    variants.add(words[words.length - 1]);
  }
  const variantList = Array.from(variants);

  // For each variant, search both album-entity and song-entity (song
  // results carry album info and surface albums the album search drops).
  const fetches = [];
  for (const term of variantList) {
    fetches.push(itunesGet({ term, entity: 'album', media: 'music', limit: 50 }).catch(() => []));
    fetches.push(itunesGet({ term, entity: 'song', media: 'music', limit: 100 }).catch(() => []));
  }
  const batches = await Promise.all(fetches);
  // Even indices are album-entity batches, odd are song-entity.
  const albumRes = batches.filter((_, i) => i % 2 === 0).flat();
  const songRes = batches.filter((_, i) => i % 2 === 1).flat();

  // PRIMARY source: the artist's full album list via artist-ID lookup.
  // This is dramatically more complete than text search — for "lil uzi
  // vert ..." it returns 130+ real albums vs ~8 junk-padded text-search
  // hits. Text/song results above are kept as a supplement for queries
  // where the artist can't be resolved.
  const artist = await resolveArtist(words);
  const artistAlbums = artist?.artistId ? await albumsForEntity(artist.artistId) : [];

  const queryTokens = normalize(query).split(' ').filter((t) => t.length >= 2);
  const byCollection = new Map();

  // Score an album-ish record (album entity OR a song carrying album
  // info) by how well its album name + artist match the query.
  const scoreAlbum = (name, artistName) => {
    const nameWords = new Set(normalize(name).split(' ').filter(Boolean));
    const artistWords = new Set(normalize(artistName).split(' ').filter(Boolean));
    let nameHits = 0; let artistHits = 0; let unmatched = 0;
    for (const tok of queryTokens) {
      if (nameWords.has(tok)) nameHits += 1;
      else if (artistWords.has(tok)) artistHits += 1;
      else unmatched += 1;
    }
    let s = nameHits * 6 + artistHits * 4 - unmatched * 3;
    if (nameHits > 0 && artistHits > 0) s += 8;
    return { score: s, nameHits, artistHits };
  };

  const addAlbum = (a) => {
    if (!a.collectionId || byCollection.has(a.collectionId)) return;
    if (JUNK_COLLECTION.test(a.collectionName || '')) return;
    const sc = scoreAlbum(a.collectionName, a.artistName);
    byCollection.set(a.collectionId, {
      albumId: `itunes:${a.collectionId}`,
      itunesCollectionId: a.collectionId,
      name: a.collectionName || '',
      artists: a.artistName || '',
      albumArtUrl: upgradeArtwork(a.artworkUrl100 || a.artworkUrl60 || ''),
      totalTracks: a.trackCount || 0,
      releaseDate: a.releaseDate || '',
      spotifyUrl: a.collectionViewUrl || '',
      provider: 'itunes',
      _score: sc.score,
      _nameHits: sc.nameHits,
      _artistHits: sc.artistHits,
    });
  };

  // Artist-lookup albums first (most complete + authoritative), then
  // text-search album results, then albums derived from song results.
  for (const a of artistAlbums) addAlbum(a);
  for (const a of albumRes) addAlbum(a);
  for (const s of songRes) {
    if (!s.collectionId || byCollection.has(s.collectionId)) continue;
    if (JUNK_COLLECTION.test(s.collectionName || '')) continue;
    if (s.kind && s.kind !== 'song') continue;
    // song records carry collection fields too
    addAlbum({
      collectionId: s.collectionId,
      collectionName: s.collectionName,
      artistName: s.artistName,
      artworkUrl100: s.artworkUrl100,
      artworkUrl60: s.artworkUrl60,
      trackCount: s.trackCount,
      releaseDate: s.releaseDate,
      collectionViewUrl: s.collectionViewUrl,
    });
  }

  // Filtering: if the query has album-title words beyond the artist
  // name, require a name hit (so "lil uzi vert eternal atake" returns
  // Eternal Atake, not the artist's whole 130-album catalog). If the
  // query is just an artist name, show everything.
  /* Collapse editions before anything is capped. Deluxe, clean, explicit and
     regional pressings all carry distinct collectionIds, so a dedupe keyed on
     id alone lets one record eat five slots — which is how a genuine album
     ends up pushed past the cut on an artist with a big catalogue. Keep the
     fullest pressing of each title. */
  const byTitle = new Map();
  for (const a of byCollection.values()) {
    const key = releaseKey(a.name);
    if (!key) continue;
    const cur = byTitle.get(key);
    if (!cur || (Number(cur.totalTracks) || 0) < (Number(a.totalTracks) || 0)) {
      byTitle.set(key, a);
    }
  }

  const all = Array.from(byTitle.values());
  const maxArtistHits = all.reduce((m, a) => Math.max(m, a._artistHits), 0);
  const queryHasAlbumWords = queryTokens.length > maxArtistHits;

  let filtered = all.filter((a) => {
    if (a._score <= 0) return false;
    if (queryHasAlbumWords && a._nameHits === 0) return false;
    return true;
  });
  // Fallback so we never return empty when there were candidates.
  if (filtered.length === 0) filtered = all.filter((a) => a._score > 0);

  /* Recency breaks score ties. For a bare artist query ("justin bieber") every
     album scores identically on artistHits alone, so the sort was a no-op and
     the slice below simply kept whatever order iTunes handed back — which is
     not recency, and which is why recent releases went missing while the cap
     was blamed. Newest-first makes the truncation predictable. */
  const ranked = filtered
    .sort((a, b) => (b._score - a._score)
      || (new Date(b.releaseDate || 0).getTime() - new Date(a.releaseDate || 0).getTime()))
    .slice(0, 120);

  /* Same audio check the artist page runs. Without it the phantom EPs were
     filtered off the artist view and then walked straight back in through the
     search results, which read from this function instead.
     Only the head of the list is checked: the renderer shows at most fifty
     albums and scores most of these away long before that, so verifying all
     120 spent fifteen requests to clean rows nobody was going to see. The
     tail goes out unverified — if one of them ever surfaces, opening it says
     so, and the answer is cached from then on. */
  /* 24, not 48. Verification is batched six at a time, so 48 is eight
     round-trip-deep requests on the critical path of the albums section —
     spent cleaning rows that sit well below the fold. The renderer shows 50
     and scores most of these away long before that; the tail goes out
     unverified, and if a phantom ever surfaces there, opening it says so and
     the answer is cached from then on. */
  const VERIFY_TOP = 24;
  const head = await withAudioOnly(ranked.slice(0, VERIFY_TOP), (a) => a.itunesCollectionId);
  const real = [...head, ...ranked.slice(VERIFY_TOP)];

  return real.map(({ _score, _nameHits, _artistHits, ...rest }) => rest);
}

/**
 * Get all tracks for an iTunes album (collection) by its collectionId.
 * Uses the iTunes lookup endpoint with entity=song, which returns the
 * collection record first, then one record per track.
 *
 * Returns a shape matching spotifyGetAlbumTracks():
 *   { album, artists, albumArtUrl, tracks: [...] }
 * where each track matches the mapTrack() shape.
 */
export async function itunesGetAlbumTracks(collectionId) {
  const id = String(collectionId || '').trim();
  if (!id) return { album: '', artists: '', albumArtUrl: '', tracks: [] };
  let results;
  try {
    results = await itunesGet({ id, entity: 'song', limit: 200 });
  } catch {
    return { album: '', artists: '', albumArtUrl: '', tracks: [], empty: false };
  }

  const pickTracks = (rows) => (rows || []).filter((r) => (
    (r.wrapperType === 'track' || r.kind === 'song') && r.trackId
  ));

  /* Videos are a FALLBACK, not a second helping.
     Asking for song+musicVideo in one request looked like it would cover both
     cases at once; what it actually does on a normal album is return the audio
     track AND its music video as separate rows, so every single that ever got
     a video appeared twice in the tracklist. Ask for songs; only if a release
     has none — a video album, an Apple-side collection — ask again for the
     videos, which is the only time that answer is the release's real contents. */
  if (!pickTracks(results).length) {
    try {
      const vids = await itunesGet({ id, entity: 'musicVideo', limit: 200 });
      if (pickTracks(vids).length) results = vids;
    } catch { /* keep the empty song result; `empty` below reports it */ }
  }

  // First result is the collection (wrapperType === 'collection'); the
  // rest are tracks (wrapperType === 'track').
  const collection = results.find((r) => r.wrapperType === 'collection') || {};
  const trackRows = pickTracks(results);
  return {
    album: collection.collectionName || '',
    artists: collection.artistName || '',
    albumArtUrl: upgradeArtwork(collection.artworkUrl100 || collection.artworkUrl60 || ''),
    /* "iTunes answered, and this release genuinely has no playable tracks" —
       as opposed to a request that never landed. The peek needs to say
       different things about those two. */
    empty: !!collection.collectionId && trackRows.length === 0,
    tracks: trackRows
      .sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
      .map(mapTrack),
  };
}

/**
 * Confidence-matched cross-check. This is the function the import /
 * download paths use when Spotify can't answer. Given what we know
 * about a track (title, artist, optionally album + the real file
 * duration), it finds the single best iTunes match — or returns null
 * if nothing clears the confidence bar.
 *
 * The duration, when provided, is the strongest signal. Pass the
 * file's actual decoded duration (in ms) whenever you have it.
 *
 * @param {object} target { title, artist, album?, durationMs? }
 * @returns {Promise<object|null>} mapped track or null
 */
export async function itunesCrossCheck(target) {
  const title = String(target?.title || '').trim();
  const artist = String(target?.artist || '').trim();
  if (!title) return null;

  // Gather candidates from two sources, same as the search path:
  //   1. Plain text search (fast, works for popular tracks).
  //   2. The artist's discography via album expansion (reliable for
  //      deep cuts that text search can't surface — this is what makes
  //      the explicit flag work for songs like "Moon Relate").
  const q = artist ? `${artist} ${title}` : title;
  const textPromise = itunesGet({ term: q, entity: 'song', media: 'music', limit: 25 })
    .catch(() => []);

  const catalogPromise = (async () => {
    if (!artist) return [];
    const words = artist.split(/\s+/).filter(Boolean);
    const a = await resolveArtist(words);
    if (!a?.artistId) return [];
    const { tracks } = await fetchArtistDiscography(a.artistId, { maxAlbumsForTracks: 12 });
    return tracks;
  })();

  const [textResults, catalog] = await Promise.all([textPromise, catalogPromise]);

  // Merge + dedupe by trackId.
  const byId = new Map();
  for (const r of [...textResults, ...catalog]) {
    if (!r.trackId || byId.has(r.trackId)) continue;
    byId.set(r.trackId, r);
  }
  const candidates = Array.from(byId.values());
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidate(cand, {
      title, artist, album: target.album, durationMs: target.durationMs,
    });
    if (s > bestScore) { bestScore = s; best = cand; }
  }

  // Confidence floor: require a minimum score so we never apply a
  // shaky guess. A bare title match with no other signal scores ~4-10;
  // we want at least a solid title match. If duration was available
  // and disagreed badly, the candidate is already penalized below this.
  const CONFIDENCE_FLOOR = 8;
  if (!best || bestScore < CONFIDENCE_FLOOR) return null;

  return mapTrack(best);
}

/* =========================================================================
 *  Artist lookups — these back the "new releases" tracker and the
 *  follow-artist picker.
 *
 *  The iTunes Search API is the right tool for this job specifically
 *  because its album records carry a REAL release date
 *  ("2019-03-29T07:00:00Z"), a track count, and a genre. That's what
 *  makes a "released in the last 30 days" window possible at all — a
 *  provider that only knows the year can't answer the question.
 * ========================================================================= */

/**
 * Search iTunes for artists by name.
 *
 * @param {string} q
 * @param {number} [limit]
 * @returns {Promise<Array>} [{ id, artistId, name, artistName, genres, followers, popularity, image, imageUrl, artworkUrl, viewUrl, provider }]
 */
/* Collections we've already asked "does this actually contain audio?".
 * collectionId → boolean. A release's contents don't change, so this is a
 * permanent answer for the life of the process. */
const collectionHasAudio = new Map();

/**
 * The verification cache, as plain data. A release's contents don't change, so
 * these answers are permanent — worth carrying across restarts rather than
 * re-earning the requests on every cold start.
 */
export function itunesAudioCacheSnapshot() {
  return Object.fromEntries(collectionHasAudio);
}

export function itunesAudioCacheRestore(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const id = Number(k);
    if (Number.isFinite(id) && typeof v === 'boolean') collectionHasAudio.set(id, v);
  }
}

/**
 * Which of these collections actually contain songs.
 *
 * The store lists releases that have no audio in them at all — video albums,
 * and whatever the "R&Bieber - EP" / "Hailey's Favs - EP" entries are, which
 * report a five-track count and return nothing when you ask for the tracks.
 * Nothing on the collection record distinguishes them: same wrapperType, same
 * collectionType, a plausible trackCount, real artwork. The only reliable test
 * is to ask for the contents, so that's what this does — for everything, once,
 * in batches, before any of it reaches a list the user reads.
 *
 * The lookup endpoint takes comma-separated ids, so this costs one request per
 * BATCH rather than per album, and the answers are cached, so an artist opened
 * twice pays nothing the second time. Batch size is held low because `limit`
 * caps the TOTAL rows across every id in the request: eight albums of ~14
 * tracks sits comfortably under 200, sixteen would start truncating and
 * truncation here reads as "this album is empty", which would delete real
 * records off the page.
 */
async function verifyCollections(ids) {
  const unknown = [...new Set(ids.map(Number).filter(Boolean))]
    .filter((id) => !collectionHasAudio.has(id));
  if (!unknown.length) return collectionHasAudio;

  await Promise.all(chunk(unknown, 6).map(async (batch) => {
    let songs;
    try {
      songs = await lookupSongsForCollections(batch, 'extra');
    } catch {
      /* A failed check must not delete records. Leaving them unknown means
         they're treated as real, which is the safe direction to be wrong in. */
      return;
    }
    const withAudio = new Set(songs.map((r) => Number(r.collectionId)).filter(Boolean));
    for (const id of batch) collectionHasAudio.set(id, withAudio.has(id));
  }));

  return collectionHasAudio;
}

/** Drop collections proven to contain no audio. Unknown survives. */
async function withAudioOnly(rows, idOf = (r) => r.collectionId) {
  await verifyCollections(rows.map(idOf));
  return rows.filter((r) => collectionHasAudio.get(Number(idOf(r))) !== false);
}

/**
 * Every real collection filed under one iTunes artist entity.
 *
 * `sort=recent` is undocumented but honoured, and it matters: the lookup
 * endpoint caps at 200 rows and its default ordering is NOT recency, so
 * without this the truncation lands arbitrarily and a prolific artist's
 * newest records can fall off the end. With it, the cut takes the oldest.
 */
async function albumsForEntity(artistId) {
  const want = Number(artistId);
  try {
    const rows = await itunesGet({
      id: String(want), entity: 'album', limit: 200, sort: 'recent',
    });
    const cols = (rows || []).filter((r) => (
      r.wrapperType === 'collection'
      && r.collectionId
      && !JUNK_COLLECTION.test(r.collectionName || '')
      && !VIDEO_RELEASE.test(r.collectionName || '')
    ));

    /* THEIRS, not everything they turn up on.
     *
     * A lookup by artistId returns every collection the artist is attached to,
     * including records where they're one guest on someone else's EP — which
     * is how "New School Grime - EP" ended up filed under Slayr's releases.
     * The collection's own artistId says who it's BY, and comparing ids rather
     * than names sidesteps the whole problem of two artists whose names differ
     * only by a hyphen.
     *
     * Rows without an artistId are kept: iTunes usually sets it, and a missing
     * field is not evidence the release isn't theirs. Better an occasional
     * stray than silently emptying a discography. */
    const own = cols.filter((r) => !r.artistId || Number(r.artistId) === want);
    return own.length ? own : cols;
  } catch {
    return [];
  }
}

/* Apple portraits, keyed by artistId. Editorial images change rarely; a long
   in-process cache plus the persisted map below keeps this to one HTML fetch
   per artist, ever. */
const artistPortrait = new Map();   // artistId → url | null

export function itunesPortraitSnapshot() {
  return Object.fromEntries(artistPortrait);
}

export function itunesPortraitRestore(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const id = Number(k);
    if (Number.isFinite(id) && (typeof v === 'string' || v === null)) artistPortrait.set(id, v);
  }
}

/**
 * Turn an mzstatic URL into the square we want.
 *
 * Apple serves images through a thumbnailer whose last path segment is the
 * spec. It comes in two shapes and BOTH have to be handled:
 *   fixed     .../1200x630cw.png     — what og:image carries
 *   templated .../{w}x{h}{c}.{f}     — what the page's embedded JSON carries
 * A templated URL left unsubstituted is a broken image, not a fallback, so it
 * would render as an empty avatar with no error anywhere.
 */
function mzstaticSize(url, w = 600, h = 600, crop = 'bb', fmt = 'jpg') {
  if (!url || !/mzstatic\.com/.test(url)) return url;
  if (/\{w\}|\{h\}|\{f\}|\{c\}/.test(url)) {
    return url
      .replace(/\{w\}/g, String(w))
      .replace(/\{h\}/g, String(h))
      .replace(/\{c\}/g, crop)
      .replace(/\{f\}/g, fmt);
  }
  return url.replace(
    /\/[0-9]+x[0-9]+[a-z-]*\.(?:jpg|png|webp)(?:\?.*)?$/i,
    `/${w}x${h}${crop}.${fmt}`,
  );
}

/** Set STUDIO_DEBUG_PORTRAITS=1 to see why an artist has no photo. */
const PORTRAIT_DEBUG = !!process.env?.STUDIO_DEBUG_PORTRAITS;

/**
 * Pull the artist's hero image out of an Apple Music artist page.
 *
 * Three routes, most-reliable first. og:image leads because it is
 * unambiguously the ARTIST hero — the embedded JSON also contains artwork for
 * every album in their discography carousel, and picking the wrong entry there
 * would hand back a record sleeve while looking like it succeeded, which is
 * the failure that's hardest to notice.
 */
function extractAppleArtwork(html) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return { url: mzstaticSize(og[1]), via: 'og:image' };

  const ld = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (ld) {
    try {
      const data = JSON.parse(ld[1]);
      const img = Array.isArray(data) ? data[0]?.image : data?.image;
      if (typeof img === 'string' && img) return { url: mzstaticSize(img), via: 'ld+json' };
    } catch { /* fall through */ }
  }

  const tpl = html.match(/https:\/\/[a-z0-9-]+\.mzstatic\.com\/image\/thumb\/[^"'\\\s]*\{w\}x\{h\}[^"'\\\s]*/i);
  if (tpl?.[0]) return { url: mzstaticSize(tpl[0]), via: 'embedded-json' };

  return { url: null, via: 'no-match' };
}

async function appleArtistImage(artistId, viewUrl) {
  const id = Number(artistId);
  if (artistPortrait.has(id)) return artistPortrait.get(id);
  if (!viewUrl || !/music\.apple\.com/.test(viewUrl)) {
    if (PORTRAIT_DEBUG) console.log(`[portrait] ${id}: no artistLinkUrl`);
    return null;
  }

  let url = null;
  let why = '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    let html;
    try {
      const res = await otherGate(() => fetch(viewUrl, {
        signal: ctl.signal,
        headers: {
          // A default UA gets a stub page back from Apple.
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const got = extractAppleArtwork(html);
    url = got.url;
    why = got.via;
    if (PORTRAIT_DEBUG) {
      console.log(`[portrait] ${id}: ${url ? `ok via ${why}` : `PARSE FAIL (${html.length} bytes)`} ${url || ''}`);
    }
  } catch (e) {
    why = `fetch failed: ${e?.message || e}`;
    if (PORTRAIT_DEBUG) console.log(`[portrait] ${id}: ${why}`);
    url = null;
  }

  /* A parse failure is cached; a FETCH failure is not. One is a durable fact
     about the page, the other is a transient network condition, and caching
     the second would blank an artist's photo for the rest of the session over
     a dropped connection. */
  if (!why.startsWith('fetch failed')) artistPortrait.set(id, url);
  return url;
}

/**
 * The artist's official photo, from their Apple Music page.
 *
 * WHY NOT a general artist-image API: everything else available — TheAudioDB,
 * fanart.tv, Deezer, MusicBrainz — is looked up BY NAME, and a name is not an
 * identity. That's how a stranger's face lands on an artist row. TheAudioDB
 * has a second problem on top: its images are user-contributed and unmoderated,
 * so even a correctly-matched artist can carry a photo of an actor who happens
 * to share the name. No amount of match-verification fixes a wrong file behind
 * a right record.
 *
 * This route has neither failure mode. `artistLinkUrl` comes off the very
 * iTunes entity we already resolved by id, so there is no name matching
 * anywhere in the path, and the image is Apple's own editorial artwork — the
 * same one their app shows. If Apple doesn't have one, the caller falls back
 * to the artist's newest sleeve, which is at least certainly theirs.
 *
 * It is HTML scraping, so it's written to fail quietly: any parse miss, any
 * timeout, any layout change returns null and costs nothing but a fallback.
 */
/**
 * Fill in the things the musicArtist entity doesn't give us, and settle which
 * entity is the real one.
 *
 * ARTWORK: iTunes artist records carry artistId, artistName, artistLinkUrl and
 * primaryGenreName — and nothing else. There is no artworkUrl on them at all,
 * which is why every artist row rendered with no image. The portrait comes from
 * the artist's Apple Music page (see appleArtistImage), with their newest
 * sleeve as the fallback when Apple has no photo.
 *
 * IDENTITY: iTunes routinely lists several entities under one name — the real
 * one plus aggregator/distributor duplicates carrying a handful of junk
 * compilations. Picking by search order picks those roughly at random, and
 * every downstream lookup then inherits the wrong artistId. Catalogue size is
 * the tiebreak: the entity that actually has the discography is the artist.
 *
 * RELEASECOUNT: doubles as a popularity proxy for the renderer, which used to
 * lean on Spotify's follower count to cull namesakes and had nothing to use
 * once iTunes became the provider.
 */
/**
 * Second portrait source, used only when Apple has no photo.
 *
 * Deezer is searched BY NAME, which is the flaw in every general artist-image
 * API and the reason a stranger's face reached the UI in the first place. So
 * the candidate has to corroborate: we pull their album list and require a
 * title in common with the discography we already know is the right artist's.
 * Two acts sharing a name is common; two acts sharing a name AND a record
 * title is not. No overlap, no photo.
 *
 * Deezer rather than TheAudioDB for the fallback because its images are
 * ingested from distributors along with the audio, so a correctly-matched
 * artist has a correct picture. TheAudioDB's are user-uploaded and unmoderated,
 * which is a failure that verification cannot reach — a right record can
 * simply hold a photo of an actor who shares the name.
 */
async function deezerArtistImage(name, knownTitles) {
  const term = String(name || '').trim();
  if (!term || !knownTitles?.size) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  try {
    const res = await otherGate(() => fetch(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(term)}&limit=5`,
      { headers: { Accept: 'application/json' } },
    ));
    if (!res.ok) return null;
    const j = await res.json();
    const cands = (Array.isArray(j?.data) ? j.data : [])
      .filter((a) => norm(a?.name) === norm(term));

    for (const c of cands) {
      const pic = c.picture_xl || c.picture_big || c.picture_medium || '';
      if (!pic || !c.id) continue;
      // eslint-disable-next-line no-await-in-loop
      const ar = await otherGate(() => fetch(
        `https://api.deezer.com/artist/${c.id}/albums?limit=50`,
        { headers: { Accept: 'application/json' } },
      )).catch(() => null);
      if (!ar?.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      const aj = await ar.json().catch(() => null);
      const theirs = Array.isArray(aj?.data) ? aj.data : [];
      if (theirs.some((al) => knownTitles.has(norm(al?.title)))) {
        if (PORTRAIT_DEBUG) console.log(`[portrait] deezer matched "${term}" via shared release`);
        return pic;
      }
    }
    if (PORTRAIT_DEBUG) console.log(`[portrait] deezer: no corroborated match for "${term}"`);
  } catch { /* no photo is an acceptable outcome */ }
  return null;
}

/**
 * Resolve a portrait WITHOUT holding anyone up.
 *
 * Portrait lookup is the most expensive thing in a search — an Apple Music
 * page is a full HTML document, several times the cost of a JSON call, and
 * Deezer behind it adds two more round trips. Awaiting that inside
 * hydrateArtist put it on the critical path of `itunesSearchArtists`, so
 * nothing about an artist could render until their photo had been found: the
 * whole artist section waited on a decoration.
 *
 * So it runs detached. The search returns immediately with the sleeve, the
 * portrait lands in the cache a moment later, and the renderer asks for it
 * separately once it has rows on screen. In-flight work is tracked so four
 * rows asking about one artist start one fetch rather than four.
 */
const portraitInflight = new Map();   // artistId → Promise<string|null>

function resolvePortrait(artistId, viewUrl, name, titles) {
  const id = Number(artistId);
  if (artistPortrait.has(id)) return Promise.resolve(artistPortrait.get(id));
  const running = portraitInflight.get(id);
  if (running) return running;

  const p = (async () => {
    let url = await appleArtistImage(id, viewUrl).catch(() => null);
    if (!url) url = await deezerArtistImage(name, titles).catch(() => null);
    if (url) artistPortrait.set(id, url);
    return url;
  })().finally(() => { portraitInflight.delete(id); });

  portraitInflight.set(id, p);
  return p;
}

/**
 * The artist's photo, if we have one or can get one.
 * Called by the renderer AFTER rows are on screen, so its cost never shows up
 * as search latency.
 */
export async function itunesGetArtistPortrait(artistId, artistName = '', viewUrl = '') {
  const id = Number(artistId);
  if (!Number.isFinite(id)) return null;
  if (artistPortrait.has(id)) return artistPortrait.get(id);

  let link = viewUrl;
  let titles = new Set();
  try {
    const cols = await albumsForEntity(id);
    titles = new Set(
      cols.map((c) => String(c.collectionName || '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
        .filter(Boolean),
    );
    if (!link) {
      const rows = await itunesGet({ id: String(id), limit: 1 });
      link = String(rows?.[0]?.artistLinkUrl || '');
    }
  } catch { /* a portrait is optional */ }

  return resolvePortrait(id, link, artistName, titles);
}

async function hydrateArtist(row) {
  const candidates = [row, ...(row._alts || [])];
  const sets = await Promise.all(candidates.map((c) => albumsForEntity(c.artistId)));

  let bestAt = 0;
  for (let i = 1; i < sets.length; i += 1) {
    if (sets[i].length > sets[bestAt].length) bestAt = i;
  }
  const winner = candidates[bestAt];
  const cols = sets[bestAt];

  row.artistId = winner.artistId;
  row.id = `${ITUNES_ID_PREFIX}${winner.artistId}`;
  row.viewUrl = winner.viewUrl;
  row.releaseCount = cols.length;

  const newest = [...cols].sort((a, b) => (
    new Date(b.releaseDate || 0).getTime() - new Date(a.releaseDate || 0).getTime()
  ));
  const art = newest.find((c) => c.artworkUrl100)?.artworkUrl100 || '';
  const sleeve = art ? upgradeArtwork(art, 600) : '';

  /* Sleeve NOW, portrait LATER — see resolvePortrait. The search returns with
     a usable image immediately rather than waiting on an HTML fetch for a
     better one; the photo is swapped in by the renderer once it arrives.

     A cached portrait is used straight away, so the second time an artist is
     seen they render with their face on the first frame. */
  const known = artistPortrait.get(winner.artistId);
  const url = known || sleeve;
  row.portrait = known || '';
  row.coverImage = sleeve;
  row.image = url;
  row.imageUrl = url;
  row.artworkUrl = url;

  if (known === undefined) {
    const titles = new Set(
      cols.map((c) => String(c.collectionName || '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
        .filter(Boolean),
    );
    // Detached on purpose: warms the cache for the renderer's follow-up call.
    resolvePortrait(winner.artistId, winner.viewUrl, row.name, titles).catch(() => {});
  }

  delete row._alts;
  return row;
}

export async function itunesSearchArtists(q, limit = 8) {
  const term = String(q || '').trim();
  if (!term) return [];

  let hits;
  try {
    // Over-fetch: duplicate entities are collapsed below, so asking for
    // exactly `limit` rows would leave us short once they merge.
    hits = await itunesGet({
      term, entity: 'musicArtist', media: 'music', limit: Math.max(1, Math.min(50, limit * 3)),
    });
  } catch (e) {
    console.error('[itunesClient] artist search failed:', e?.message || e);
    return [];
  }

  const seenId = new Set();
  const byName = new Map();   // canonical name → row (duplicates ride along as _alts)

  for (const a of hits || []) {
    const id = Number(a?.artistId);
    const name = String(a?.artistName || '').trim();
    if (!Number.isFinite(id) || id <= 0 || !name || seenId.has(id)) continue;
    seenId.add(id);

    // EXACT name equality, punctuation included. The old substring test
    // collapsed genuinely different acts — "Gavin" ate "Dance Gavin Dance" —
    // and a punctuation-blind key collapsed "Slayr" into "Slay-R".
    const key = exactNameKey(name);
    if (!key) continue;

    const row = {
      id: `${ITUNES_ID_PREFIX}${id}`,
      artistId: id,
      name,
      artistName: name,
      genres: a.primaryGenreName ? [String(a.primaryGenreName)] : [],
      followers: null,
      releaseCount: 0,
      popularity: null,
      image: '',
      imageUrl: '',
      artworkUrl: '',
      viewUrl: String(a.artistLinkUrl || a.artistViewUrl || ''),
      provider: 'itunes',
    };

    if (!byName.has(key)) byName.set(key, row);
    else {
      const head = byName.get(key);
      head._alts = [...(head._alts || []), row];
    }
  }

  /* Rank before hydrating — hydration is one request per candidate entity, so
     it should only run on rows we're actually going to return.

     Three tiers, and the top one is what keeps "Slayr" above "Slay-R": a name
     that matches the query character for character beats one that only matches
     once punctuation is thrown away. Both still appear — they're different
     artists and the user may have meant either — but the one they actually
     typed leads, and the renderer's exact-match rule can then pick it. */
  const wantExact = exactNameKey(term);
  const wantLoose = normalize(term);
  const tier = (a) => {
    if (exactNameKey(a.name) === wantExact) return 0;
    if (canonicalArtistName(a.name) === wantLoose) return 1;
    return 2;
  };
  const ranked = [...byName.values()].sort((a, b) => tier(a) - tier(b));

  const out = ranked.slice(0, Math.max(1, limit));

  /* Hydration is a request per artist (more when several entities share a
     name), and it exists to supply an avatar and a catalogue size. Only the
     head of the list can survive the renderer's scoring and its four-row cap,
     so hydrating all eight bought four avatars nobody would see. The rest go
     out with an empty image, which renders as the initial-letter placeholder. */
  const HYDRATE_TOP = 4;
  await Promise.all(out.slice(0, HYDRATE_TOP).map((r) => hydrateArtist(r).catch(() => r)));
  for (const r of out.slice(HYDRATE_TOP)) delete r._alts;
  return out.filter((a) => a.name);
}

/**
 * Resolve a single artist by name. Exact normalized match wins, then
 * containment, then the top hit — but only for multi-word names, because
 * a single short token matches far too many wrong artists to guess on.
 *
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function itunesSearchArtist(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;

  const hits = await itunesSearchArtists(wanted, 8);
  if (!hits.length) return null;

  const want = normalize(wanted);
  const exact = hits.find((a) => normalize(a.artistName) === want);
  if (exact) return exact;

  const contains = hits.find((a) => {
    const an = normalize(a.artistName);
    return an && want && (an.includes(want) || want.includes(an));
  });
  if (contains) return contains;

  return wanted.includes(' ') ? (hits[0] || null) : null;
}

/**
 * Fetch an artist's albums by iTunes artistId, newest first.
 *
 * Uses the LOOKUP endpoint (not search) — the first row of the response
 * is the artist record itself, the rest are collections.
 *
 * @param {number|string} artistId
 * @param {number} [limit]
 * @returns {Promise<Array>} shaped like spotifyArtistAlbums():
 *   [{ albumId, name, artists, albumArtUrl, totalTracks, releaseDate, albumGroup, explicit, provider }]
 */
export async function itunesGetArtistAlbums(artistId, limit = 200) {
  const id = Number(artistId);
  if (!Number.isFinite(id) || id <= 0) return [];

  try {
    /* Pull the whole discography, then sort and slice ourselves — iTunes
       returns collections in its own order, which is not recency.
       albumsForEntity also drops karaoke/tribute/various-artists rows, which
       this path used to let through even though the two other callers of the
       same lookup filtered them. */
    const rows = await albumsForEntity(id);
    const albums = [];
    const seen = new Set();

    for (const r of rows) {
      const cid = r.collectionId;
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);

      // Derive albumGroup from collectionType and trackCount
      // iTunes collectionType: "Album", "Single", "EP", "Compilation"
      const collectionType = String(r.collectionType || '').toLowerCase();
      const trackCount = Number(r.trackCount) || 0;
      const genre = String(r.primaryGenreName || '');
      /* A soundtrack or various-artists record is filed under every artist who
         contributed a track, and iTunes reports it as an ordinary album
         credited to whichever artist you looked up — so "Shang-Chi …: The
         Album" turned up on keshi's page as if it were his record, on the
         strength of one song. The genre is the honest signal here.
         Classified rather than dropped: it IS a release he's on, so it belongs
         under Appears on, just not among his own albums. */
      const isVarious = /various artists/i.test(r.artistName || '')
        || /^soundtrack$/i.test(genre);
      let albumGroup = 'album';
      if (isVarious || collectionType === 'compilation') albumGroup = 'compilation';
      else if (collectionType === 'single' || trackCount === 1) albumGroup = 'single';
      else if (collectionType === 'ep') albumGroup = 'ep';

      albums.push({
        albumId: `${ITUNES_ID_PREFIX}${cid}`,
        itunesCollectionId: Number(cid),
        name: String(r.collectionName || ''),
        artists: String(r.artistName || ''),
        albumArtUrl: upgradeArtwork(r.artworkUrl100 || '', 600),
        totalTracks: trackCount,
        trackCount,
        releaseDate: String(r.releaseDate || '').slice(0, 10), // YYYY-MM-DD
        albumGroup,
        explicit: r.collectionExplicitness === 'explicit',
        genre,
        viewUrl: String(r.collectionViewUrl || ''),
        provider: 'itunes',
      });
    }

    // Deduplicate duplicate LISTINGS of one release (same title, re-uploaded
    // or per-storefront). releaseKey keeps edition suffixes, so "Justice" and
    // "Justice (Deluxe)" stay two records — see releaseKey for why that
    // matters.
    const byName = new Map();
    for (const a of albums) {
      const key = releaseKey(a.name);
      if (!byName.has(key) || (byName.get(key).totalTracks || 0) < a.totalTracks) {
        byName.set(key, a);
      }
    }

    const deduped = [...byName.values()];
    deduped.sort((a, b) => (
      new Date(b.releaseDate || 0).getTime() - new Date(a.releaseDate || 0).getTime()
    ));

    /* Verified AFTER dedupe and sort, so the batched requests only cover
       releases we're actually going to return. */
    const real = await withAudioOnly(
      deduped.slice(0, Math.max(1, limit)),
      (a) => a.itunesCollectionId,
    );
    return real;
  } catch (e) {
    console.error('[itunesClient] artist albums failed:', e?.message || e);
    return [];
  }
}

/**
 * Get an artist's top/popular tracks via iTunes search.
 * iTunes doesn't have a dedicated "top tracks" endpoint, so we search
 * for the artist name and take the most relevant results.
 *
 * @param {string|number} artistId  iTunes artistId
 * @param {string} artistName       artist name for the search
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
/* How many releases to open when assembling top songs.
   Six, matching the batch size in lookupSongsForCollections exactly — seven
   would cost a second round trip for a seventh release we don't need. Six
   releases is on the order of seventy candidate tracks, and the section shows
   ten. */
const TOP_TRACK_RELEASES = 6;

/**
 * The artist's best-known songs — and, failing that, simply their songs.
 *
 * This used to BE the artistTerm search: whatever iTunes returned for the
 * name, filtered to rows carrying the right artistId, capped at ten. That
 * works for artists iTunes ranks well and falls apart for everyone else,
 * because the search is a relevance ranking over the whole store rather than a
 * listing of one artist's catalogue. A small artist gets a handful of rows
 * back, most of them belonging to better-known acts with similar names, and
 * once the id filter removes those the section renders one song, or none —
 * next to a Releases list holding a hundred tracks, which is the part that
 * makes it look broken rather than merely sparse.
 *
 * So the catalogue is the SOURCE and the search is only the ORDER. Every track
 * on the artist's own releases is a candidate; the ones iTunes ranked come
 * first, in its order, and everything else falls in behind by recency. The
 * section fills to `limit` whenever the artist has that many songs at all,
 * which is the behaviour the header implies.
 */
export async function itunesGetArtistTopTracks(artistId, artistName = '', limit = 10) {
  const name = String(artistName || '').trim();
  const wantId = Number(artistId);
  if (!name && !wantId) return [];

  const usable = (r) => (
    r.wrapperType === 'track'
    && r.trackId
    && (!r.kind || r.kind === 'song')
    && !JUNK_COLLECTION.test(r.collectionName || '')
  );

  /* ---- 1+2. Popularity hint and catalogue, CONCURRENTLY ----------------
     These don't depend on each other, and awaiting them in sequence made this
     three round trips deep when it only needs to be two: the search finishes,
     then the album list, then the songs on those albums. Only the last step
     genuinely has to wait for anything. */
  const searchPromise = name
    ? itunesGet({ term: name, entity: 'song', media: 'music', attribute: 'artistTerm', limit: 200 })
      .catch(() => [])
    : Promise.resolve([]);
  const albumsPromise = wantId ? albumsForEntity(wantId).catch(() => []) : Promise.resolve([]);

  const [hits, cols] = await Promise.all([searchPromise, albumsPromise]);

  const rankByTitle = new Map();
  const searched = [];
  for (const r of hits || []) {
    if (!usable(r)) continue;
    /* Identity by ID where we have one: artistTerm matches on the NAME, so
       a search for "Slayr" returns Slay-R's catalogue too, and no string
       comparison separates them — normalising for the hyphen makes them
       identical, not normalising misses tracks credited "SLAYR". */
    const mine = wantId && r.artistId
      ? Number(r.artistId) === wantId
      : creditIsArtist(r.artistName, name);
    if (!mine) continue;
    const k = normalize(r.trackName);
    if (!k) continue;
    if (!rankByTitle.has(k)) rankByTitle.set(k, rankByTitle.size);
    searched.push(r);
  }

  let catalogue = [];
  if (cols.length) {
    try {
      const ids = cols.slice(0, TOP_TRACK_RELEASES).map((c) => c.collectionId);
      /* No per-track credit check here, deliberately. These rows come off
         releases already established as the artist's own, and the credit on an
         individual track is unreliable on exactly the records where it matters
         — a collaborative album lists some tracks as "A & B" and others as
         "B & A", and filtering on lead credit drops half an album the artist
         made. Being on their record is the stronger claim. */
      catalogue = (await lookupSongsForCollections(ids, 'extra')).filter(usable);
    } catch { /* fall back to whatever the search found */ }
  }

  /* ---- 3. One row per song, ranked ------------------------------------- */
  const best = new Map();
  for (const r of [...searched, ...catalogue]) {
    const k = normalize(r.trackName);
    if (k && !best.has(k)) best.set(k, r);
  }

  const rankOf = (r) => {
    const k = rankByTitle.get(normalize(r.trackName));
    return k === undefined ? Number.MAX_SAFE_INTEGER : k;
  };

  return [...best.values()]
    .sort((a, b) => (rankOf(a) - rankOf(b))
      || (new Date(b.releaseDate || 0).getTime() - new Date(a.releaseDate || 0).getTime())
      || ((a.trackNumber || 0) - (b.trackNumber || 0)))
    .slice(0, limit)
    .map(mapTrack);
}
