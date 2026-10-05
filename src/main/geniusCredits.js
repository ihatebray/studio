/**
 * geniusCredits.js — song credits lookup (main process).
 *
 * Uses Genius's public JSON API (the same unauthenticated endpoints the
 * lyrics fallback in main.js already scrapes):
 *
 *   1. genius.com/api/search/multi?q=…   → find the song id
 *   2. genius.com/api/songs/{id}         → writer_artists, producer_artists,
 *                                          custom_performances, artists, url
 *
 * The search hit is only accepted when title AND artist fuzzy-match the
 * playing track — Genius happily returns covers, remixes and translations
 * for loose queries, and wrong credits are worse than no credits.
 *
 * Results (hits AND misses) cache in-memory per `artist|title`, so spinning
 * the same song never re-hits the network within a session.
 *
 * Wire-up in main.js:
 *   import { fetchGeniusCredits } from './geniusCredits.js';
 *   ipcMain.handle('genius:credits', async (_e, params) => fetchGeniusCredits(params || {}));
 *
 * And in preload.js:
 *   geniusCredits: (params) => ipcRenderer.invoke('genius:credits', params),
 */

import { BoundedMap } from '../lib/boundedMap.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new BoundedMap(400); // 'artist|title' lowercased → result object (ok or not)

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')                 // (feat. …), [Remastered]
    .replace(/\b(feat|ft|featuring)\.?\s.+$/i, ' ')   // trailing feat. clause
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyEq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Genius HTTP ${res.status}`);
  return res.json();
}

function names(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => String(a?.name || '').trim())
    .filter(Boolean);
}

/** De-dupe while preserving order (Genius repeats artists across roles). */
function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const n of list) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/**
 * Custom-performance roles worth surfacing, in display order. We show only
 * the SIX most important credits, Spotify-style: the core three (Performed
 * by / Written by / Produced by) are handled separately; from Genius's long
 * tail of custom roles we keep at most three, and only the engineering
 * credits that genuinely matter — mixing, mastering, recording — dropping
 * everything else (label, distributor, A&R, art direction, session players,
 * management, marketing…).
 *
 * Matching is fuzzy/substring against the lowercased Genius label, so
 * "Mix Engineer" / "Mixed By", "Mastering Engineer" / "Mastered By", and
 * "Recording Engineer" / "Recorded By" all catch. `rank` orders them.
 */
const KEPT_ROLE_PATTERNS = [
  [10, 'mixing'], [10, 'mix engineer'], [10, 'mixed by'],
  [20, 'master'],
  [30, 'recording'], [30, 'record engineer'], [30, 'recorded by'],
];

function roleRank(label) {
  const l = String(label || '').toLowerCase();
  for (const [rank, needle] of KEPT_ROLE_PATTERNS) {
    if (l.includes(needle)) return rank;
  }
  return null; // not a kept role
}

function filterPerformances(list) {
  const seenRank = new Set();
  return (Array.isArray(list) ? list : [])
    .map((p) => ({ label: String(p?.label || '').trim(), names: uniq(names(p?.artists)), rank: roleRank(p?.label) }))
    .filter((p) => p.rank !== null && p.label && p.names.length)
    .sort((a, b) => a.rank - b.rank)
    // One entry per role kind (collapse "Mix Engineer" + "Mixed By").
    .filter((p) => (seenRank.has(p.rank) ? false : seenRank.add(p.rank)))
    .slice(0, 3)
    .map(({ label, names: n }) => ({ label, names: n }));
}

export async function fetchGeniusCredits({ title, artist } = {}) {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t) return { ok: false, error: 'No title' };

  const key = `${a.toLowerCase()}|${t.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  let result;
  try {
    // --- 1. Search ------------------------------------------------------
    const q = a ? `${t} ${a}` : t;
    const search = await getJson(`https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`);
    const sections = search?.response?.sections || [];
    const songHits = sections
      .filter((s) => s?.type === 'song' || s?.type === 'top_hit')
      .flatMap((s) => s?.hits || [])
      .map((h) => h?.result)
      .filter((r) => r && r._type !== 'article');

    const hit = songHits.find((r) => fuzzyEq(r.title, t)
      && (!a || fuzzyEq(r.primary_artist?.name || r.artist_names, a)));

    if (!hit?.id) {
      result = { ok: false, error: 'not_found' };
    } else {
      // --- 2. Song details ---------------------------------------------
      const detail = await getJson(`https://genius.com/api/songs/${hit.id}`);
      const song = detail?.response?.song;
      if (!song) {
        result = { ok: false, error: 'not_found' };
      } else {
        const performances = filterPerformances(song.custom_performances);
        result = {
          ok: true,
          credits: {
            title: song.title || t,
            primary: uniq([
              ...(song.primary_artists?.length ? names(song.primary_artists) : names([song.primary_artist])),
              ...names(song.featured_artists),
            ]),
            writers: uniq(names(song.writer_artists)),
            producers: uniq(names(song.producer_artists)),
            performances,
            releaseDate: song.release_date_for_display || null,
            url: song.url || null,
          },
        };
      }
    }
  } catch (e) {
    // Network failures are NOT cached — retried on next open.
    return { ok: false, error: String(e?.message || e) };
  }

  cache.set(key, result);
  return result;
}
