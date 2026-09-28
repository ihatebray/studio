/**
 * mediaUtils.js — shared pure helpers used across the library UI.
 *
 * These were previously defined at the top of ImmersiveLibraryPage.jsx. They're
 * pulled out so that components extracted into their own files (MetadataEditor,
 * StatsTab, etc.) can import them rather than depending on the monolith. All
 * functions here are pure (no React, no DOM) and safe to import anywhere.
 */

/** Locale-aware, case-insensitive, numeric-aware collator for sorting titles. */
export const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Display labels for the sort menu — also defines the menu's order. */
export const SORT_LABELS = {
  aToZ: 'Title (A–Z)',
  zToA: 'Title (Z–A)',
  recentlyAdded: 'Recently added',
  oldestFirst: 'Oldest first',
  recentlyPlayed: 'Recently played',
  mostPlayed: 'Most played',
  longest: 'Longest',
  shortest: 'Shortest',
  year: 'Year (newest)',
  favorites: 'Favorites first',
};

/** Format a duration given in SECONDS as m:ss. */
export function formatTime(s) {
  if (!s || Number.isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

/** Format a duration given in MILLISECONDS as m:ss (— when unknown). */
export function formatDurationMs(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Friendly file-format label from a file path (or any filename).
 * Returns the extension upper-cased and lightly normalized so users see
 * "FLAC" / "MP3" / "M4A" rather than ".flac" or "x-aac".
 *
 * Returns empty string if there's no path or no extension, so callers
 * can conditionally hide the row when format is unknown.
 */
export function getFileFormatLabel(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const cleaned = filePath.split(/[?#]/)[0];
  const dot = cleaned.lastIndexOf('.');
  if (dot < 0 || dot === cleaned.length - 1) return '';
  const ext = cleaned.slice(dot + 1).toLowerCase();
  if (ext.length > 6 || /[^a-z0-9]/i.test(ext)) return '';
  const aliases = {
    aac: 'M4A',
    mp4: 'M4A',
    aiff: 'AIFF',
    aif: 'AIFF',
    oga: 'OGG',
  };
  return aliases[ext] || ext.toUpperCase();
}

/**
 * Parse an LRC-format synced lyrics string into a sorted array of
 * { time, text } records. Handles multi-timestamp lines and the [offset:] tag.
 */
export function parseLRC(lrc) {
  if (!lrc) return [];
  const lines = [];
  let offsetSec = 0;
  const tsRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const offsetRegex = /^\[offset:\s*([+-]?\d+)\s*\]/i;

  for (const raw of lrc.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const om = trimmed.match(offsetRegex);
    if (om) {
      offsetSec = -Number(om[1]) / 1000;
      continue;
    }

    const timestamps = [];
    let m;
    tsRegex.lastIndex = 0;
    while ((m = tsRegex.exec(trimmed)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      timestamps.push(min * 60 + sec + frac + offsetSec);
    }
    if (timestamps.length === 0) continue;
    let textStart = 0;
    tsRegex.lastIndex = 0;
    while ((m = tsRegex.exec(trimmed)) !== null) {
      textStart = m.index + m[0].length;
    }
    const text = trimmed.slice(textStart).trim();
    if (!text) continue;
    for (const t of timestamps) {
      lines.push({ time: t, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** Find the index of the active line for the given playback time. */
export function activeLyricIndex(lines, time) {
  if (!lines.length) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time + 0.15) idx = i;
    else break;
  }
  return idx;
}

/**
 * Sort a stamped-lines array for the tap-to-sync editor.
 * Stamped lines (time !== null) float to the top, sorted by time ascending.
 * Unstamped lines stay at the bottom in their original order.
 */
export function sortStampedLines(lines) {
  const stamped = lines.filter((l) => l.time !== null).sort((a, b) => a.time - b.time);
  const unstamped = lines.filter((l) => l.time === null);
  return [...stamped, ...unstamped];
}

/* ---------------------------------------------------------------------------
 *  Genres — stored as one delimited string, handled as a list
 *
 *  Tracks keep a single `genre` TEXT column and files keep a single ID3 TCON
 *  frame, because those have to survive round-tripping through the file: a
 *  library rebuilt from disk has to come back with the same genres, and a
 *  normalised join table in SQLite would be silently dropped the moment a
 *  track was re-imported.
 *
 *  So the list lives in the string. "; " is the canonical separator on write —
 *  it's what MusicBee, foobar2000 and Plex all treat as multi-value — while
 *  reads accept everything taggers actually emit in the wild, including the
 *  null byte ID3v2.4 uses for genuine multi-value frames.
 * ------------------------------------------------------------------------- */

export const GENRE_SEPARATOR = '; ';

/** "Emo Rap; Hyperpop" → ["Emo Rap", "Hyperpop"]. Always an array. */
export function parseGenres(value) {
  if (Array.isArray(value)) value = value.join(GENRE_SEPARATOR);
  if (typeof value !== 'string' || !value.trim()) return [];
  const out = [];
  const seen = new Set();
  /* Slash is deliberately NOT a separator. Too many real genres contain one
     ("Rap/Hip-Hop", "Pop/Rock" as iTunes writes it) and splitting them makes
     more mess than it cleans up. Semicolons, null bytes and pipes are
     unambiguous; commas are the judgement call, and they're included because
     "Hip Hop, R&B" is overwhelmingly two genres rather than one. */
  for (const part of value.split(/[;\u0000|,]+/)) {
    const g = part.trim().replace(/\s+/g, ' ');
    if (!g) continue;
    const k = g.toLowerCase();
    if (seen.has(k)) continue;      // "Pop; pop" is one genre
    seen.add(k);
    out.push(g);
  }
  return out;
}

/** ["Emo Rap", "Hyperpop"] → "Emo Rap; Hyperpop". Safe on a string too. */
export function formatGenres(list) {
  return parseGenres(Array.isArray(list) ? list.join(GENRE_SEPARATOR) : list).join(GENRE_SEPARATOR);
}

/** Case-insensitive membership, so chip UIs can't add a duplicate. */
export function hasGenre(list, genre) {
  const k = String(genre || '').trim().toLowerCase();
  if (!k) return false;
  return parseGenres(list).some((g) => g.toLowerCase() === k);
}

/**
 * "1 hr 24 min" from a millisecond total — the runtime line on record pages.
 *
 * Moved out of StudioHome.jsx so the artist page can state a catalogue's
 * length the same way an album states its own.
 */
export function formatTotalMs(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h >= 1) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (total >= 60) return `${Math.max(1, Math.round(total / 60))} min`;
  return `${total} sec`;
}
