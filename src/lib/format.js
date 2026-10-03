/* Small helpers shared across the UI. */

/** The preload bridge, or null outside Electron (tests, a plain browser tab). */
export const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

/** Class names, skipping falsy ones. */
export const cx = (...c) => c.filter(Boolean).join(' ');

/** Seconds → "3:07"; empty for none. */
export function fmtSec(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Milliseconds → "3:07"; empty for none. */
export const fmtMs = (ms) => fmtSec((Number(ms) || 0) / 1000);

/** "just now", "5 min ago", "yesterday", "3 days ago", then a date.
 *  Takes a timestamp or an ISO string. */
export function ago(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* Title Case for labels: "Album and playlist pages" → "Album and Playlist
 * Pages". Small words stay lower case after the first word; words that
 * already have capitals ("API", "Spotify") and names written lower case on
 * purpose ("studio", "imgbb") are left alone. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with']);
const KEEP_LOWER = new Set(['studio', 'imgbb']);
export function titleCase(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[A-Za-z][A-Za-z'’]*/g, (w, at) => {
    if (KEEP_LOWER.has(w) || w !== w.toLowerCase()) return w;
    if (at > 0 && SMALL_WORDS.has(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  });
}
