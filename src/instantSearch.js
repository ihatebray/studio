/* =========================================================================
 *  studio — instant search: query parsing, ranking, and file matching
 *
 *  The palette's brain. Everything here is pure — no React, no IPC — so it
 *  can be reasoned about and tested on its own, and so InstantSearch.jsx
 *  stays a view.
 *
 *  Three jobs:
 *
 *    1. parseQuery      — "artist:keshi drunk" → a scoped query object.
 *                         Narrowing BEFORE the request is the single biggest
 *                         accuracy win available: Soulseek matches on the
 *                         whole phrase, so a scoped query is a different
 *                         (better) search, not the same one filtered.
 *
 *    2. rankResults     — one score across every result type, so an album can
 *                         out-rank a song when the album is the better answer.
 *
 *    3. matchFilesToTracks — the important one. A Soulseek search for an album
 *                         comes back as ~90 rows of filenames. Laid against
 *                         the album's real tracklist, those 90 rows become
 *                         "12 tracks, 9 in FLAC, 1 only in 320, 2 nobody has".
 *                         That transformation is what the album peek renders.
 *
 *  slskQuality / parseSlskName / groupSlskFiles are duplicated from
 *  StudioHome.jsx on purpose for now — see WIRING.md step 6, which replaces
 *  those copies with imports from here so there's one definition again.
 * ========================================================================= */

const LOSSLESS_EXTS = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv']);

/* ---------------------------------------------------------------------------
 *  Normalisation
 *
 *  Two strengths, deliberately. `normLoose` throws away everything that isn't
 *  a letter or digit and is used for "is this the same thing" comparisons.
 *  `normTitle` keeps word boundaries so token overlap can be measured.
 * ------------------------------------------------------------------------- */

/* Suffixes that describe the RELEASE, not the recording.
 *
 * "Drunk" and "Drunk - Bonus Track" are the same audio; one of them just sat
 * at the end of a deluxe edition. Bracketed forms already fall to the paren
 * rule in normTitle — this is for the dash form Spotify favours, which has no
 * brackets to strip.
 *
 * Deliberately a CLOSED vocabulary rather than "everything after a dash".
 * Blanket-stripping would eat the title out of "Artist - Title", which is the
 * shape parseSlskName hands around and half the peer filenames on the network
 * are written in.
 *
 * Version words are deliberately ABSENT — live, remix, acoustic, remaster and
 * friends stay in VERSION_WORDS, because those change what the recording IS.
 * Collapsing them here would make owning a studio take hide the Get button on
 * the live one. */
const RELEASE_QUALIFIERS = /\s+[-–—]\s*(?:bonus(?: track)?|deluxe(?: edition| version)?|explicit(?: version)?|clean(?: version)?|album version|single version|original version|main version|anniversary edition|expanded edition|special edition|standard edition|deluxe edition|japanese edition|international version|uk version|us version)\s*$/i;

export function normTitle(s) {
  let out = String(s || '');
  /* Looped: "Song - Deluxe Edition - Bonus Track" carries two. */
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(RELEASE_QUALIFIERS, '');
    if (next === out) break;
    /* A title that is ONLY a qualifier keeps its original text — better a
       weird title than an empty one that matches everything. */
    if (!next.trim()) break;
    out = next;
  }
  return out
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(feat. X)", "(2019 Remaster)"
    .replace(/\[[^\]]*\]/g, ' ')         // "[Explicit]", "[FLAC]"
    .replace(/\bfeat\.?\b.*$/i, ' ')     // trailing "feat. X" without brackets
    .replace(/\bft\.?\b.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The identity of a RELEASE, for "are these two rows the same record".
 *
 * Not normTitle, and the difference is the whole point: normTitle strips
 * parentheticals because "(feat. X)" and "(2019 Remaster)" don't change what a
 * SONG is. On a release they change everything — "SWAG LIVE FROM COACHELLA
 * (Weekend I)" and "(Weekend II)" are two different concerts, "Justice" and
 * "Justice (Deluxe)" two different tracklists. Keying release dedupe on
 * normTitle silently merged those pairs and kept whichever arrived first, so
 * the artist page showed one Coachella weekend and called it a day.
 *
 * Duplicate LISTINGS of one release share a title exactly, so exact matching
 * still collapses what it's supposed to.
 */
/**
 * Case- and spacing-insensitive, but PUNCTUATION-SENSITIVE name comparison.
 *
 * The counterpart to normLoose, for the one job normLoose can't do: telling
 * apart two artists whose names differ only by a hyphen or an apostrophe.
 * "Slayr" and "Slay-R" are different acts; normLoose says they're the same
 * string, which is right for matching a sloppily-typed query and wrong for
 * deciding whose discography to show.
 */
/**
 * Is this credit string BY this artist?
 *
 * Deliberately not `leadCredit(credit) === artist`. leadCredit splits on ",",
 * "&" and "with", which is right for "Drake & Future" and catastrophic for
 * bands whose names contain those words: "Sleeping With Sirens" decomposes to
 * "Sleeping", "Earth, Wind & Fire" to "Earth". Compared against the full name
 * those never match, so every record by such an artist failed its own credit
 * check — which read as the artist simply having no albums.
 *
 * Asking the question directly avoids the whole problem: rather than take the
 * credit apart and hope the pieces line up, test whether it BEGINS with this
 * artist and ends there or at a real separator. No parsing of the name itself,
 * so a name containing "with" is just a name.
 */
export function creditMatchesArtist(credit, artist) {
  const a = String(artist || '').trim();
  if (!a) return true;
  const c = String(credit || '').trim();
  /* normStrict, not normLoose: punctuation is the only thing separating
     "Slay-R" from "Slayr", and a credit check that can't tell them apart is
     the bug this whole matcher exists to avoid. */
  if (normStrict(c) === normStrict(a)) return true;
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s*${esc}\\s*(?:,|;|/|&|\\+|\\bfeat\\.?\\b|\\bft\\.?\\b|\\bwith\\b|\\bvs\\.?\\b|\\bx\\b|$)`,
    'i',
  ).test(c);
}

/**
 * Is this artist credited ANYWHERE on this record — lead or otherwise?
 *
 * The looser question, for cases where the answer is already known to be one
 * of the artist's own releases and we only want a sanity check. A
 * collaborative album credits some tracks "A & B" and others "B & A", so
 * insisting on lead credit there deletes half of it.
 */
export function creditIncludesArtist(credit, artist) {
  const a = normStrict(artist);
  if (!a) return true;
  return creditMatchesArtist(credit, artist) || normStrict(credit).includes(a);
}

export function normStrict(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function releaseKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normLoose(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* The LEAD credit of an artists string — who the song/album is actually BY,
   before guests ride along. "Drake, Lil Wayne" is a Drake record; "Keshia
   Chanté" merely contains the letters of Keshi. Splitting on the usual
   separators keeps comparisons honest where blind substring matching
   can't tell those two apart. */
export function leadCredit(s) {
  return String(s || '')
    .split(/\s*(?:,|;|\/|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b)\s*/i)[0]
    .trim();
}

/* A version qualifier changes what the recording IS, so it can't be stripped
   like punctuation — "drunk" and "drunk (live)" are different files and
   treating them as the same is how you end up with a live take sitting in the
   middle of a studio album. Detected on the RAW string, before normTitle
   removes the brackets these usually live in. */
const VERSION_WORDS = /\b(live|remix|acoustic|instrumental|karaoke|demo|edit|radio edit|sped ?up|slowed|reverb|nightcore|cover|remaster(?:ed)?|extended|reprise|interlude|a ?cappella|8d|mashup)\b/i;

export function versionTag(raw) {
  const m = VERSION_WORDS.exec(String(raw || ''));
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : '';
}

/* ---------------------------------------------------------------------------
 *  Query parsing
 * ------------------------------------------------------------------------- */

/* Recognised scopes. `year` accepts a bare year or a range; `is` is a state
   filter rather than a field, which is why it's listed apart in the UI. */
export const SCOPES = ['artist', 'album', 'year', 'is'];

const SCOPE_RE = /\b(artist|album|year|is):("[^"]*"|\S*)/gi;

/**
 * "artist:keshi drunk"      → { text: 'drunk', artist: 'keshi', … }
 * 'album:"blue hour" sun'   → { text: 'sun', album: 'blue hour', … }
 * "keshi year:2024"         → { text: 'keshi', year: 2024, … }
 * "drunk is:missing"        → { text: 'drunk', missingOnly: true, … }
 *
 * `raw` is returned untouched so the caller can echo exactly what was typed,
 * and `scopes` is the list of active ones so the UI can render them as chips
 * and let one be removed without re-parsing a string.
 */
export function parseQuery(raw) {
  const input = String(raw || '');
  const out = {
    raw: input,
    text: '',
    artist: '',
    album: '',
    year: null,
    missingOnly: false,
    ownedOnly: false,
    losslessOnly: false,
    scopes: [],
  };

  let rest = input.replace(SCOPE_RE, (whole, key, value) => {
    const v = String(value || '').replace(/^"|"$/g, '').trim();
    if (!v) return ' ';
    const k = key.toLowerCase();
    if (k === 'artist') { out.artist = v; out.scopes.push({ key: 'artist', value: v }); }
    else if (k === 'album') { out.album = v; out.scopes.push({ key: 'album', value: v }); }
    else if (k === 'year') {
      const y = parseInt(v, 10);
      if (Number.isFinite(y) && y > 1900 && y < 2200) { out.year = y; out.scopes.push({ key: 'year', value: String(y) }); }
    } else if (k === 'is') {
      const f = v.toLowerCase();
      if (f === 'missing' || f === 'new') { out.missingOnly = true; out.scopes.push({ key: 'is', value: 'missing' }); }
      /* The explicit "yes, show me things I already have" — for re-downloading
         at better quality, or checking what a record's other pressings look
         like. Off by default: a download list full of rows you can't act on is
         noise, and the badge saying so doesn't make it less noisy. */
      if (f === 'owned' || f === 'mine') { out.ownedOnly = true; out.scopes.push({ key: 'is', value: 'owned' }); }
      if (f === 'lossless') { out.losslessOnly = true; out.scopes.push({ key: 'is', value: 'lossless' }); }
    }
    return ' ';
  });

  out.text = rest.replace(/\s+/g, ' ').trim();

  /* Natural phrasing: "Drake - No Face". The dash form is how every music
     app trained the world to type, so it folds into the same shape an
     explicit artist: scope produces — the left half drives the artist
     search and scope filtering, the right half is what gets scored against
     titles. Only a SPACED dash splits, so "AC/DC" and "A$AP" stay whole,
     and only when no explicit scope already claimed the artist. Deliberately
     not added to `scopes`: there's no "artist:" token in what the user typed
     for a chip to remove. */
  if (!out.artist) {
    const m = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(out.text);
    if (m && m[1].trim() && m[2].trim()) {
      out.artist = m[1].trim();
      out.text = m[2].trim();
    }
  }

  return out;
}

/**
 * The string actually sent to a provider.
 *
 * Scopes are folded back into plain words because neither Spotify's search nor
 * Soulseek understands `artist:` the way this app means it — Spotify has its
 * own `artist:` filter with different semantics, and Soulseek has none at all.
 * The scope's value still does its job: it's in the query, and it's used again
 * on the way back to filter what returned.
 */
export function providerQuery(parsed, provider = 'spotify') {
  const bits = [];
  if (parsed.artist) bits.push(parsed.artist);
  if (parsed.album) bits.push(parsed.album);
  if (parsed.text) bits.push(parsed.text);
  /* Soulseek matches on the whole phrase and gets worse the longer it is, so
     a year is dropped there — it appears in maybe a third of folder names and
     excludes every peer who didn't type it. Spotify indexes it properly. */
  if (parsed.year && provider === 'spotify') bits.push(String(parsed.year));
  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

/** Does a result survive the scopes the user set? */
export function passesScopes(parsed, { artist = '', album = '', year = '', title = '' } = {}) {
  if (parsed.artist) {
    const want = normLoose(parsed.artist);
    const got = normLoose(artist);
    if (want && got && !got.includes(want) && !want.includes(got)) return false;
  }
  if (parsed.album) {
    const want = normLoose(parsed.album);
    const got = normLoose(album);
    if (want && got && !got.includes(want)) return false;
  }
  if (parsed.year) {
    const y = parseInt(String(year).slice(0, 4), 10);
    if (Number.isFinite(y) && y !== parsed.year) return false;
  }
  if (parsed.text) {
    const hay = normTitle(`${title} ${artist} ${album}`);
    const toks = normTitle(parsed.text).split(' ').filter(Boolean);
    if (toks.length && !toks.every((t) => hay.includes(t))) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 *  Scoring
 * ------------------------------------------------------------------------- */

/**
 * How well `candidate` answers `query`, 0..100.
 *
 * Deliberately blunt and explainable — a ranker you can't reason about is
 * worse than a mediocre one you can, because when it puts the wrong thing
 * first you have no idea what to change.
 */
export function textScore(query, candidate) {
  const q = normTitle(query);
  const c = normTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.startsWith(q)) return 88;
  if (c.includes(q)) return 76;

  const qt = q.split(' ').filter(Boolean);
  const ct = new Set(c.split(' ').filter(Boolean));
  if (!qt.length) return 0;
  const hit = qt.filter((t) => ct.has(t)).length;
  if (hit === qt.length) return 70;                       // all words, wrong order
  if (!hit) {
    // Last resort: a prefix match on the first word catches mid-typing.
    return c.split(' ')[0]?.startsWith(qt[0]) ? 30 : 0;
  }
  return Math.round(40 * (hit / qt.length));
}

/**
 * A free-text query is often two fields wearing one string — "drake iceman"
 * is ARTIST plus TITLE, "no face drake" is TITLE plus ARTIST. Scoring that
 * whole string against either field alone caps partial credit near 20–27,
 * below every section cutoff — which is exactly how the right record
 * vanished while whatever compilation happened to contain all the words
 * took its place.
 *
 * Try every split of the query tokens across the two fields, in both
 * orders, and report the strongest assignment. Only assignments where BOTH
 * halves independently clear the all-tokens bar (>= 70) count: a split
 * where one side matches nothing is weaker than not splitting at all, and
 * letting it through would resurface the tribute-compilation problem this
 * exists to fix.
 */
function bestSplitScore(query, titleText, artistText) {
  const qt = normTitle(query).split(' ').filter(Boolean);
  if (qt.length < 2 || qt.length > 8) return 0;
  let best = 0;
  for (let i = 1; i < qt.length; i += 1) {
    const left = qt.slice(0, i).join(' ');
    const right = qt.slice(i).join(' ');
    const pairs = [
      [textScore(left, artistText), textScore(right, titleText)], // "artist title"
      [textScore(left, titleText), textScore(right, artistText)], // "title artist"
    ];
    for (const [aScore, tScore] of pairs) {
      if (aScore >= 70 && tScore >= 70) best = Math.max(best, Math.min(aScore, tScore));
    }
  }
  return best;
}

/**
 * For bare artist rows: does any contiguous chunk of a multi-token query
 * name this artist outright? "drake iceman" shouldn't demote Drake to
 * partial credit just because a song or album rode along in the same
 * string. The whole-query case is handled by the caller and skipped here.
 */
/* EDGES ONLY, which is what the paragraph above always claimed and what the
   code never did. The old version walked every contiguous chunk, so a name
   sitting in the MIDDLE of the query scored a full exact match — searching
   "dance gavin dance" handed GAVIN the same 120 as Dance Gavin Dance, off the
   strength of the middle word. A middle chunk is a coincidence of wording: the
   artist-plus-something shape this exists to serve puts the artist at one end
   or the other, never buried inside. */
function anyChunkExact(query, nameText) {
  const qt = normTitle(query).split(' ').filter(Boolean);
  if (qt.length < 2 || qt.length > 8) return false;
  for (let j = 1; j < qt.length; j += 1) {                       // head: "drake iceman"
    if (textScore(qt.slice(0, j).join(' '), nameText) >= 100) return true;
  }
  for (let i = 1; i < qt.length; i += 1) {                       // tail: "iceman drake"
    if (textScore(qt.slice(i).join(' '), nameText) >= 100) return true;
  }
  return false;
}

/**
 * Score for a whole entity, with type-aware bonuses.
 *
 * `kind` matters: an exact ARTIST name match should beat an exact SONG title
 * match, because someone typing an artist's name wants the artist. That single
 * rule is most of what makes searching "keshi" stop returning forty tracks
 * before it returns keshi.
 */
export function scoreEntity(parsed, kind, fields = {}) {
  const q = parsed.text || parsed.artist || parsed.album || '';
  let score = 0;

  if (kind === 'artist') {
    score = textScore(q, fields.name);
    if (score >= 100) score = 120;                        // exact artist wins outright
    else if (score >= 88) score += 14;
    if (parsed.artist && normLoose(parsed.artist) === normLoose(fields.name)) score = 120;
    /* A two-field free-text query ("drake iceman") keeps its exact hit:
       some contiguous chunk of it IS the artist's whole name. */
    else if (!parsed.artist && !parsed.album && anyChunkExact(q, fields.name)) score = 120;
    if (fields.inLibraryCount) score += Math.min(8, fields.inLibraryCount);
  } else if (kind === 'album') {
    const t = textScore(q, fields.name);
    const a = textScore(q, fields.artists);
    score = Math.max(t, a * 0.82);
    // Both halves of "keshi gabriel" landing on one record is a strong signal.
    if (t >= 70 && a >= 70) score = Math.min(118, score + 22);
    /* Free-text "drake iceman": assign the tokens across artist/title
       halves. Same bonus as above — both halves clearing the bar is the
       same signal, the query just wasn't written with scopes. Without this,
       the real record scores ~20 against a 45 cutoff while anything with
       all the query words in its TITLE sails through at 70. */
    if (!parsed.artist && !parsed.album) {
      const split = bestSplitScore(q, fields.name, fields.artists);
      if (split >= 70) score = Math.max(score, Math.min(118, split + 22));
    }
    if (parsed.album && normLoose(fields.name).includes(normLoose(parsed.album))) score += 16;
  } else if (kind === 'track') {
    const t = textScore(q, fields.title);
    const a = textScore(q, fields.artists);
    score = Math.max(t, a * 0.7);
    if (t >= 70 && a >= 70) score = Math.min(112, score + 18);
    /* Same treatment for "drake no face" typed without the dash — the
       exact song was scoring 27 against a 40 cutoff and vanishing. */
    if (!parsed.artist && !parsed.album) {
      const split = bestSplitScore(q, fields.title, fields.artists);
      if (split >= 70) score = Math.max(score, Math.min(112, split + 18));
    }
    if (fields.popularity) score += Math.min(6, fields.popularity / 16);
  } else if (kind === 'folder') {
    score = textScore(q, fields.name) * 0.9;
    if (fields.lossless) score += 6;
    if (fields.slots) score += 4;
  }

  if (parsed.year && String(fields.releaseDate || '').slice(0, 4) === String(parsed.year)) score += 10;
  return Math.max(0, Math.round(score));
}

/* ---------------------------------------------------------------------------
 *  Soulseek helpers (mirrors of StudioHome's — see header note)
 * ------------------------------------------------------------------------- */

export function slskQuality(ext, bitrate) {
  const e = String(ext || '').toLowerCase();
  if (e === 'mixed') return { label: 'Mixed', tier: 2 };
  if (LOSSLESS_EXTS.has(e)) return { label: e === 'flac' ? 'FLAC' : e.toUpperCase(), tier: 5, lossless: true };
  const br = Number(bitrate) || 0;
  if (br >= 320) return { label: '320', tier: 4 };
  if (br >= 256) return { label: '256', tier: 3 };
  if (br >= 192) return { label: '192', tier: 2 };
  if (br > 0) return { label: String(br), tier: 1 };
  return { label: e ? e.toUpperCase() : '—', tier: 0 };
}

export function parseSlskName(filename) {
  const noExt = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  let s = noExt;
  s = s.replace(/^\s*[[(]\s*\d{1,3}\s*[\])]\s*[-._–]*\s*/, '');
  s = s.replace(/^\s*\d{1,3}\s*[-._–]+\s*/, '');
  s = s.replace(/^\s*\d{1,3}\s+(?=\S)/, '');
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^\d+$/.test(s)) s = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || String(filename || '');
  const parts = s.split(/\s+[-–]\s+/);
  const lead = parts.length >= 2 ? parts[0].trim() : '';
  const rest = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : '';
  return { title: s, lead, rest };
}

/** Leading track number, if the peer put one there. Null when they didn't. */
export function trackNumberFromName(filename) {
  const base = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const m = /^\s*[[(]?\s*(\d{1,3})\s*[\])]?\s*(?:[-._–]|\s)/.exec(base);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  /* A leading number above 99 is far more likely to be a year or a bitrate in
     the filename than a track position. */
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

/** Rank sources the way the client does: format, free slot, speed, bitrate. */
export function rankSources(sources) {
  return [...(sources || [])].sort((a, b) => (
    (b._q.tier - a._q.tier)
    || (Number(!!b.slots) - Number(!!a.slots))
    || ((b.speed || 0) - (a.speed || 0))
    || ((b.bitrate || 0) - (a.bitrate || 0))
  ));
}

/** Flat peer files → one entry per song, sources ranked best-first. */
export function groupSlskFiles(rows) {
  const parsed = (rows || []).filter(Boolean).map((r) => ({ r, n: parseSlskName(r.filename) }));
  const leadCount = new Map();
  for (const { n } of parsed) {
    if (!n.lead) continue;
    const k = n.lead.toLowerCase();
    leadCount.set(k, (leadCount.get(k) || 0) + 1);
  }
  const map = new Map();
  parsed.forEach(({ r, n }, i) => {
    const lead = n.lead.toLowerCase();
    const inFolder = !!n.lead && String(r.folder || r.filePath || '').toLowerCase().includes(lead);
    const split = !!n.lead && !!n.rest && ((leadCount.get(lead) || 0) >= 2 || inFolder);
    const title = split ? n.rest : n.title;
    const artist = split ? n.lead : '';
    const key = normLoose(title);
    if (!key) return;
    const src = { ...r, _q: slskQuality(r.ext, r.bitrate), _title: title, _artist: artist };
    const cur = map.get(key);
    if (cur) {
      cur.sources.push(src);
      if (!cur.artist && artist) cur.artist = artist;
    } else {
      map.set(key, { key, title, artist, order: i, sources: [src] });
    }
  });
  const out = [...map.values()];
  for (const g of out) {
    g.sources = rankSources(g.sources);
    g.best = g.sources[0];
    g.duration = (g.sources.find((x) => Number(x.duration) > 0) || {}).duration || 0;
    g.freeCount = g.sources.filter((x) => x.slots).length;
  }
  return out.sort((a, b) => a.order - b.order);
}

/* ---------------------------------------------------------------------------
 *  File → track matching
 *
 *  This is what the album peek is built on. Given a real tracklist and a pile
 *  of peer files, decide which files are which track.
 *
 *  Every file is assigned to AT MOST ONE track — its best-scoring one — rather
 *  than to every track it passes the threshold against. Without that, a folder
 *  containing "Intro" and "Intro (Reprise)" hands both files to both tracks and
 *  the counts stop meaning anything.
 * ------------------------------------------------------------------------- */

/** Stable identity for a track across renders, whatever the source gave us. */
export function trackKey(track, index = 0) {
  if (track?.spotifyId) return `sp:${track.spotifyId}`;
  const d = track?.discNumber ?? 1;
  const n = track?.trackNumber;
  if (Number.isFinite(n)) return `n:${d}-${n}`;
  return `i:${index}:${normLoose(track?.title)}`;
}

const MATCH_FLOOR = 62;

/**
 * Score one peer file against one catalogue track.
 *
 * Returns 0 for anything below consideration so the caller can treat 0 as
 * "no", and the components of the score are recoverable from the shape of the
 * function rather than logged — deliberately, since this runs per file per
 * track and is hot.
 */
export function scoreFileForTrack(file, track, ctx = {}) {
  const parsed = file._parsed || parseSlskName(file.filename);
  /* Which half of "Artist - Title" is the title depends on the whole result
     set, which groupSlskFiles already worked out; ctx.artistLead carries that
     decision in so it isn't re-litigated per file. */
  const candidateRaw = (ctx.artistLead && parsed.rest) ? parsed.rest : parsed.title;

  const a = normTitle(candidateRaw);
  const b = normTitle(track?.title);
  if (!a || !b) return 0;

  let score = 0;
  if (a === b) score = 100;
  else if (a.startsWith(b) || b.startsWith(a)) score = 84;
  else if (a.includes(b)) score = 76;
  else {
    const at = new Set(a.split(' ').filter(Boolean));
    const bt = b.split(' ').filter(Boolean);
    if (!bt.length) return 0;
    const hit = bt.filter((t) => at.has(t)).length;
    const ratio = hit / bt.length;
    if (ratio < 0.6) return 0;                            // too little in common to bother
    score = Math.round(66 * ratio);
  }

  /* A version qualifier on one side and not the other is disqualifying, not a
     deduction — a live take is not a worse copy of the studio track, it's a
     different recording, and quietly filing it under the album track is the
     single most annoying thing a matcher can do. */
  const vFile = versionTag(candidateRaw);
  const vTrack = versionTag(track?.title);
  if (vFile !== vTrack) return 0;

  // Corroborating signals. Each is weak alone and decisive together.
  const num = trackNumberFromName(file.filename);
  if (num != null && Number.isFinite(track?.trackNumber)) {
    if (num === track.trackNumber) score += 14;
    else score -= 10;                                     // a real, disagreeing number
  }

  const fileSec = Number(file.duration) || 0;
  const trackSec = Number(track?.durationMs) ? track.durationMs / 1000 : 0;
  if (fileSec > 0 && trackSec > 0) {
    const delta = Math.abs(fileSec - trackSec);
    if (delta <= 3) score += 13;
    else if (delta <= 8) score += 6;
    else if (delta > 25) score -= 30;                     // different recording entirely
  }

  if (ctx.albumName) {
    const folder = normLoose(file.folder || file.filePath);
    if (folder && folder.includes(normLoose(ctx.albumName))) score += 8;
  }

  return Math.max(0, Math.min(130, score));
}

/**
 * Lay a pile of peer files against a real tracklist.
 *
 * Returns:
 *   sources    Map<trackKey, rankedSources[]>  — what each track can be had as
 *   unmatched  files that belong to no track   — surfaced in the UI, not hidden
 *   coverage   { have, total, lossless, best } — the album's headline numbers
 */
export function matchFilesToTracks(tracks = [], rows = [], opts = {}) {
  const albumName = opts.albumName || '';
  const artistName = opts.artistName || '';

  /* Decide once whether a leading "X - " across this file set is an artist
     prefix, the same way groupSlskFiles does — if it fronts two or more files,
     or matches the artist we're looking at, it's an artist. */
  const leadCount = new Map();
  const prepared = (rows || []).filter(Boolean).map((r) => {
    const n = parseSlskName(r.filename);
    if (n.lead) {
      const k = n.lead.toLowerCase();
      leadCount.set(k, (leadCount.get(k) || 0) + 1);
    }
    return { ...r, _parsed: n, _q: r._q || slskQuality(r.ext, r.bitrate) };
  });

  const wantArtist = normLoose(artistName);
  const sources = new Map();
  const unmatched = [];

  for (const file of prepared) {
    const lead = file._parsed.lead.toLowerCase();
    const artistLead = !!file._parsed.lead && !!file._parsed.rest && (
      (leadCount.get(lead) || 0) >= 2
      || (wantArtist && normLoose(file._parsed.lead) === wantArtist)
      || String(file.folder || '').toLowerCase().includes(lead)
    );

    let bestKey = null;
    let bestScore = 0;
    tracks.forEach((t, i) => {
      const s = scoreFileForTrack(file, t, { artistLead, albumName });
      if (s > bestScore) { bestScore = s; bestKey = trackKey(t, i); }
    });

    if (bestKey && bestScore >= MATCH_FLOOR) {
      const list = sources.get(bestKey) || [];
      list.push({ ...file, _score: bestScore });
      sources.set(bestKey, list);
    } else {
      unmatched.push(file);
    }
  }

  for (const [k, list] of sources) sources.set(k, rankSources(list));

  let have = 0;
  let lossless = 0;
  let bestTier = 0;
  tracks.forEach((t, i) => {
    const list = sources.get(trackKey(t, i));
    if (!list?.length) return;
    have += 1;
    const tier = list[0]._q.tier;
    if (tier >= 5) lossless += 1;
    if (tier > bestTier) bestTier = tier;
  });

  return {
    sources,
    unmatched,
    coverage: { have, total: tracks.length, lossless, bestTier },
  };
}

/**
 * One line describing what the network has for a record.
 * Written as a sentence because a row of counts doesn't answer the question
 * anyone is actually asking, which is "can I get this properly or not".
 */
export function describeCoverage(coverage, folderCount = 0) {
  const { have, total, lossless } = coverage || {};
  if (!total) return '';
  if (!have) return 'No files found for this release yet.';
  const from = folderCount ? ` from ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}` : '';
  if (have === total && lossless === total) return `All ${total} tracks available in lossless${from}.`;
  if (have === total) {
    const rest = total - lossless;
    return lossless
      ? `All ${total} tracks found${from} — ${lossless} lossless, ${rest} lossy.`
      : `All ${total} tracks found${from}, none in lossless.`;
  }
  return `${have} of ${total} tracks found${from}${lossless ? ` — ${lossless} in lossless` : ''}. ${total - have} missing from the network.`;
}

/* ---------------------------------------------------------------------------
 *  Release grouping
 * ------------------------------------------------------------------------- */

/**
 * Split a discography into the buckets people actually think in.
 *
 * Spotify's album_group is authoritative for album vs single vs appears_on;
 * the EP call is ours, since Spotify has no EP type and files them as singles.
 * Three to six tracks and "EP" in the name is the convention that holds.
 */
/**
 * A one-track "album" is a single, and a single is a song wearing album
 * chrome: opening it yields a tracklist of one row that the Songs section
 * already showed. Callers FILTER on this rather than demoting, because a
 * demotion still costs a slot on a thin result set — which is exactly when
 * a stray single is most annoying.
 *
 * Only an explicit count of 1 qualifies. A missing count is UNKNOWN, not
 * one, and treating 0 as a single would silently eat any provider that
 * doesn't report the field.
 */
export function isLoneSingle(a) {
  return (Number(a?.totalTracks) || 0) === 1;
}
/* Superseded by isSongSizedRelease below for every release-filtering caller.
   Kept exported because it answers a narrower, still-meaningful question:
   "is this EXACTLY one track", which is a different claim from "is this too
   small to be a record". */

/**
 * Too small to be a record — a single track only.
 *
 * One track is a song wearing album chrome: opening it yields a tracklist
 * the Songs section already showed, and an album row for it drills into
 * itself.
 *
 * An UNKNOWN count (0) is explicitly kept. Several providers omit the track
 * count on browse endpoints, and treating "I don't know" as "it's a single"
 * is exactly how a 23-track live album disappeared off an artist page.
 * Unknown means show it; only a count we actually have as 1 can exclude a row.
 */
export function isSongSizedRelease(a) {
  const n = Number(a?.totalTracks) || 0;
  return n === 1;
}

/**
 * Same song, another pressing: base title matches (version qualifiers
 * aside) and the lead credit overlaps. "(Radio Edit)" collapses into the
 * copy you own — so does "(Live)", deliberately: the question was for THAT
 * song, and you have it. A genuinely different recording keeps its own row
 * because its base title differs.
 *
 * Lives here rather than inside the component because two callers need the
 * same rule — duplicate suppression in the songs list, and deciding whether
 * a second library hit makes a "certain" match ambiguous. Two copies of a
 * sameness rule drift, and when they drift the two features disagree about
 * what one song is.
 */
/**
 * The canonical identity of a recording, for "do I already have this".
 *
 * Three decisions, and the asymmetry between them is the whole point:
 *
 *   TITLE  runs through normTitle, so "(feat. X)" and "- Bonus Track" fall
 *          away. Neither changes the audio; both are how a catalogue labels
 *          a row, and a library that cleans them off is not a library that
 *          stopped owning the song.
 *
 *   VERSION is kept and made part of the key. "Drunk" and "Drunk (Live)" are
 *          different recordings, so owning one must NOT hide the Get button
 *          on the other. This is the conservative half, on purpose: a
 *          spurious Get costs a duplicate download, while a missing Get
 *          costs you a song you can no longer reach from the UI. Those two
 *          failures are not the same size.
 *
 *   ARTIST is reduced to the LEAD credit, so a library row cleaned down to
 *          "Keshi" still matches a catalogue row reading "Keshi, Guest" —
 *          and vice versa, for anyone who moves the guests INTO the field.
 */
export function songKey(title, artist) {
  const v = versionTag(title);
  return `${normTitle(title)}${v ? `~${v}` : ''}::${normLoose(leadCredit(artist))}`;
}

export function sameSongFamily(titleA, artistA, titleB, artistB) {
  const ta = normTitle(titleA);
  const tb = normTitle(titleB);
  if (!ta || !tb) return false;
  if (ta !== tb && !ta.startsWith(`${tb} `) && !tb.startsWith(`${ta} `)) return false;
  const la = normLoose(leadCredit(artistA));
  const lb = normLoose(leadCredit(artistB));
  return !!la && !!lb && (la.includes(lb) || lb.includes(la));
}

/**
 * Which bucket a release belongs in, and WHY.
 *
 * The reason is not decoration. Three separate rules can each swallow a
 * record — the group string, the "is it an EP" heuristic, and the track
 * count — and when an album goes missing from an artist page there is
 * otherwise no way to tell which one ate it. Returning the reason means the
 * trace can say "singles: no group, 0 tracks" instead of leaving you to
 * guess between three candidates.
 *
 * Classification:
 *   - appears_on / compilation → appearsOn
 *   - album group → albums
 *   - ep group OR name contains "EP" → eps
 *   - 2+ tracks → albums (EPs merged into albums per user preference)
 *   - 1 track → singles
 *   - 0/unknown tracks → albums (don't hide unknowns)
 */
export function classifyRelease(a) {
  const g = String(a?.albumGroup || '').toLowerCase();
  const n = Number(a?.totalTracks) || 0;
  if (g === 'appears_on' || g === 'compilation') return { bucket: 'appearsOn', reason: `group="${g}"` };
  if (g === 'album') return { bucket: 'albums', reason: 'group="album"' };
  if (g === 'ep') return { bucket: 'eps', reason: 'group="ep"' };
  if (/\bep\b/i.test(a?.name || '')) return { bucket: 'eps', reason: 'name contains "EP"' };
  if (n >= 2) return { bucket: 'albums', reason: `${n} tracks (2+)` };
  if (n === 1) return { bucket: 'singles', reason: '1 track' };
  return { bucket: 'albums', reason: `unknown tracks (${n}), defaulting to album` };
}

export function groupReleases(albums = []) {
  const out = { albums: [], eps: [], singles: [], appearsOn: [] };
  for (const a of albums) out[classifyRelease(a).bucket].push(a);
  return out;
}

/* ---------------------------------------------------------------------------
 *  Formatting
 * ------------------------------------------------------------------------- */

export function fmtMs(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSec(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} kB`;
}

export function fmtSpeed(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(n / 1024)} kB/s`;
}
