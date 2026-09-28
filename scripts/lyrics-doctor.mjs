#!/usr/bin/env node
/**
 * lyrics-doctor — reproduce studio's lyrics lookup OUTSIDE Electron.
 *
 * Why: the in-app logging tells you what Electron's `net.fetch` did. This
 * tells you what plain Node's fetch does against the same endpoints with the
 * same scoring. Comparing the two isolates the fault:
 *
 *   doctor OK  + app fails  → Electron net.fetch / session / proxy problem
 *   doctor fails + app fails → LRClib genuinely has no match, or the
 *                              title/artist being sent are wrong, or the
 *                              network/UA is blocked
 *
 * Usage:
 *   node scripts/lyrics-doctor.mjs "Song Title" "Artist Name" [durationSeconds]
 *
 * Env:
 *   LRCLIB_BASE   override the API base (used by the test harness)
 */

const BASE = process.env.LRCLIB_BASE || 'https://lrclib.net';
const [, , argTitle, argArtist, argDuration] = process.argv;

if (!argTitle) {
  console.error('usage: node scripts/lyrics-doctor.mjs "Title" "Artist" [durationSeconds]');
  process.exit(1);
}

const PLACEHOLDER_META = /^(unknown artist|unknown album|unknown|various artists|va|untitled)$/i;
let title = argTitle;
let artist = argArtist || '';
const duration = Number(argDuration) || 0;

const log = (...a) => console.log('[doctor]', ...a);

if (PLACEHOLDER_META.test(artist.trim())) {
  log(`artist "${artist}" is a placeholder → treating as absent`);
  artist = '';
}

const headers = { 'User-Agent': 'studio v0.1.0 (https://github.com/bray/studio)' };

const normalizeStr = (s) => (s || '')
  .toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\s+-\s+(official|lyric|lyrics|audio|video|visualizer|hd|hq|mv|music video|full song|explicit).*$/i, ' ')
  .replace(/feat\.?|featuring|ft\.?/gi, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

let lastReject = '';
function scoreMatch(r) {
  lastReject = '';
  if (!r) { lastReject = 'null'; return 0; }
  const rTitle = normalizeStr(r.trackName || r.name || '');
  const rArtist = normalizeStr(r.artistName || r.artist || '');
  const qTitle = normalizeStr(title);
  const qArtist = normalizeStr(artist);
  if (!rTitle || !qTitle) { lastReject = 'empty title'; return 0; }

  let titleScore = 0;
  if (rTitle === qTitle) titleScore = 10;
  else {
    const rWords = new Set(rTitle.split(' ').filter((w) => w.length > 2));
    const qWords = new Set(qTitle.split(' ').filter((w) => w.length > 2));
    if (qWords.size === 0 || rWords.size === 0) { lastReject = 'no words >2 chars'; return 0; }
    let overlap = 0;
    for (const w of qWords) if (rWords.has(w)) overlap += 1;
    const ratio = overlap / Math.max(qWords.size, rWords.size);
    if (ratio < 0.7) { lastReject = `title overlap ${ratio.toFixed(2)} < 0.70 ("${qTitle}" vs "${rTitle}")`; return 0; }
    titleScore = Math.round(ratio * 8);
  }

  let artistScore = 0;
  if (qArtist) {
    const rArtistWords = new Set(rArtist.split(' ').filter((w) => w.length >= 3));
    const qArtistWords = qArtist.split(' ').filter((w) => w.length >= 3);
    if (!qArtistWords.some((w) => rArtistWords.has(w))) {
      lastReject = `artist mismatch ("${qArtist}" vs "${rArtist}")`;
      return 0;
    }
    artistScore = 3;
  }

  let durationScore = 0;
  const rDur = Number(r.duration) || 0;
  if (duration > 0 && rDur > 0) {
    const diff = Math.abs(rDur - duration);
    if (diff <= 5) durationScore = 3;
    else if (diff <= 15) durationScore = 1;
    else if (diff > 30) durationScore = -2;
  }

  return titleScore + artistScore + durationScore + (r.syncedLyrics ? 8 : 0);
}

async function timed(url) {
  const started = Date.now();
  log('  HTTP →', url);
  try {
    const res = await fetch(url, { headers });
    log(`  HTTP ← ${res.status} ${res.statusText} (${Date.now() - started}ms)`);
    return res;
  } catch (e) {
    log(`  HTTP ✗ ${e?.name}: ${e?.message} (${Date.now() - started}ms)`);
    throw e;
  }
}

async function main() {
  log('─'.repeat(60));
  log('query', JSON.stringify({ title, artist, duration, base: BASE }));

  // Stage 1 — exact
  log('STAGE /api/get');
  const p = new URLSearchParams();
  p.set('track_name', title);
  if (artist) p.set('artist_name', artist);
  if (duration > 0) p.set('duration', String(Math.round(duration)));
  log('  params:', p.toString());
  try {
    const res = await timed(`${BASE}/api/get?${p}`);
    if (res.ok) {
      const data = await res.json();
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        log(`  → HIT (${data.syncedLyrics ? 'synced' : 'plain'})`);
        log('RESULT: found via /api/get');
        return;
      }
      log('  → row found, no lyrics', JSON.stringify({ instrumental: data?.instrumental }));
    } else {
      log('  → no exact match');
    }
  } catch { /* logged above */ }

  // Stage 2 — search
  const q = `${artist} ${title}`.trim();
  log('STAGE /api/search q=', JSON.stringify(q));
  try {
    const res = await timed(`${BASE}/api/search?${new URLSearchParams({ q })}`);
    if (!res.ok) { log('  → status not ok'); log('RESULT: NOTHING FOUND'); return; }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      log('  → 0 results from LRClib');
      log('RESULT: NOTHING FOUND — LRClib has no entry for this query');
      return;
    }
    log(`  → ${data.length} results, scoring (threshold 8):`);
    const scored = data.map((r) => {
      const score = scoreMatch(r);
      return { r, score, why: lastReject };
    }).sort((a, b) => b.score - a.score);

    for (const s of scored.slice(0, 8)) {
      log(`    ${String(s.score).padStart(3)} ${s.score >= 8 ? 'PASS  ' : 'REJECT'} `
        + `"${s.r.trackName}" — "${s.r.artistName}" [${s.r.duration}s]`
        + `${s.r.syncedLyrics ? ' +synced' : s.r.plainLyrics ? ' +plain' : ' (no lyrics)'}`
        + `${s.why ? '  ← ' + s.why : ''}`);
    }
    const best = scored[0];
    if (!best || best.score < 8) {
      log(`RESULT: NOTHING FOUND — best score ${best?.score ?? 'n/a'} < threshold 8`);
      log('        (LRClib HAS candidates; the scorer rejected them. The');
      log('         reason above tells you which gate failed.)');
      return;
    }
    log(`RESULT: would pick "${best.r.trackName}" — "${best.r.artistName}" (score ${best.score})`);
  } catch {
    log('RESULT: NETWORK FAILURE — see the HTTP error above');
  }
}

main();
