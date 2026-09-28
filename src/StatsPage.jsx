import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { parseGenres } from './mediaUtils.js';

/* =========================================================================
 *  StatsPage — option 3b ("Streak ring"), per STATS_PAGE_SPEC.md.
 *
 *  The whole page is ONE panel: a fixed-height flex column that never
 *  scrolls. A 330px left rail (title, streak ring, four summary metrics)
 *  sits beside a flex column holding three ranked lists. Sections are
 *  separated by 1px rules — never by nested cards, fills or extra radii.
 *
 *  Self-contained by design. It takes the raw play log and the library and
 *  derives everything itself, so StudioHome no longer carries a stats memo,
 *  a heat memo or the streak state that used to feed the old page.
 *
 *  ── Two notes where the spec and the app disagree ──────────────────────
 *
 *  Colour: the spec fixes the palette (#101010 panel, #ff9d4d accent, a
 *  fixed ring gradient) and says the accent is "not data-driven". The rest
 *  of the app tints to the cover-derived accent via --st-* CSS variables.
 *  The spec wins here because it is explicit about it, but every value
 *  lives in T below — swapping `T.accent` for the app accent is a one-line
 *  change if that turns out to be the wrong call.
 *
 *  Type: the spec asks for Geist and Geist Mono. Neither is bundled, and
 *  the UI face is a user preference (Settings → font). So the UI type
 *  inherits whatever the user picked, and only the numerics pin to a mono
 *  stack that prefers Geist Mono when it happens to be installed.
 * ========================================================================= */

/* ---------- Tokens (spec §6) --------------------------------------------- */

const T = {
  panel: '#101010',
  control: '#171717',
  controlEdge: '#262626',
  barTrack: '#1a1a1a',
  ringTrack: '#1b1b1b',

  rule: '#1c1c1c',        // structural dividers
  ruleRow: '#191919',     // row separators

  text: '#f2f2f2',        // primary
  sub: '#a8a8a8',         // secondary
  muted: '#7d7d7d',       // muted
  faint: '#4d4d4d',       // faint

  /* The page is monochrome. Orange used to tint the rank numerals, the focus
     ring and the first genre bar, which read as a second brand colour next to
     studio's cover-derived accent. The ONLY colour left in Stats is the streak
     flame, where it carries meaning: the hue tells you which tier you're on. */
  rankTop: '#e8e8e8',     // ranks 1-3 numerals
  focus: '#8a8a8a',

  barTop: '#e8e8e8',      // song bar, ranks 1–3
  barRest: '#4a4a4a',     // song bar, ranks 4–5
  timeSong: '#9a9a9a',
  timeSmall: '#8a8a8a',

  hover: '#141414',
};

const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/** Genre bars keep their own ramp (spec §5). */
const GENRE_COLORS = ['#f2f2f2', '#c8c8c8', '#9a9a9a', '#6d6d6d', '#4a4a4a'];

/** Missing artwork (spec §8). */
const HATCH = 'repeating-linear-gradient(135deg,#242424 0 4px,#1b1b1b 4px 8px)';

/* ---------- Streak tiers ------------------------------------------------
 * Eleven rungs to a year. The gaps matter as much as the colours: the old
 * ramp jumped 30 -> 100, ten weeks with nothing changing, which is exactly
 * the stretch where a streak stops feeling like it is going anywhere.
 *
 * `in` is the inner flame — always the hotter, brighter shade of the SAME
 * hue, so the flame-inside-flame reading survives at every tier (a fixed
 * yellow core would fight the violet and cyan rungs badly).
 *
 * Only 365 is prismatic. Every other tier is one hue you read at a glance,
 * so the year cannot be mistaken for anything below it.
 */
const STREAK_TIERS = [
  { min: 0,   rgb: '150,150,158', in: '202,202,210', label: '—' },
  { min: 1,   rgb: '232,176,112', in: '255,224,176', label: 'Started' },
  { min: 3,   rgb: '245,176,70',  in: '255,224,130', label: 'Warming up' },
  { min: 7,   rgb: '250,140,66',  in: '255,201,102', label: 'A week straight' },
  { min: 14,  rgb: '244,106,74',  in: '255,176,104', label: '14 days' },
  { min: 30,  rgb: '236,84,92',   in: '255,150,120', label: 'A month straight' },
  { min: 60,  rgb: '232,72,138',  in: '255,152,196', label: '60 days' },
  { min: 100, rgb: '186,132,255', in: '223,192,255', label: '100 days' },
  { min: 180, rgb: '124,140,255', in: '186,196,255', label: 'Half a year' },
  { min: 270, rgb: '80,208,224',  in: '168,240,246', label: 'Three quarters' },
  { min: 365, rgb: '255,196,90',  in: '255,238,190', label: 'A full year', prism: true },
];
function streakTier(days) {
  const n = Number(days) || 0;
  let t = STREAK_TIERS[0];
  for (const x of STREAK_TIERS) if (n >= x.min) t = x;
  return t;
}
const nextTierFor = (days) => STREAK_TIERS.find((t) => t.min > (Number(days) || 0)) || null;

/* Outer flame: hooked tip, bulge right, a small tongue lower-left, round base.
   Inner: the same silhouette at ~45%, centred on the flame's own axis — no
   tongue of its own, or it reads as a second fire inside the first. */
const FLAME_OUTER = 'M54 6c0 20 18 32 26 46 7 12 8 26 4 38-6 18-19 30-34 30S18 108 14 90c-3-14 0-28 8-38 2 8 6 13 12 15C28 48 34 28 46 16c4-4 7-7 8-10z';
const FLAME_INNER = 'M52 58c0 12 10 19 14 27 4 8 4 16 0 22-4 7-10 11-16 11s-13-4-16-11c-3-7-2-14 2-20 1.5 4.5 4 7 7 8-3-10 0-20 6-27 2-2 3-4 3-10z';

/**
 * Dither noise for the glow.
 *
 * WHITE pixels with a RANDOM ALPHA channel, composited normally — not
 * grayscale-over-`overlay`, which is what VisualEffects.jsx uses and what I
 * reached for first. That was wrong here, and the reason is the blend mode:
 * `overlay` computes `2 x base x noise` for dark bases, so its amplitude is
 * PROPORTIONAL to the background. Over the bright colour field it sits on in
 * VisualEffects that is fine. Over a #101010 panel it collapses to a swing of
 * about 1.3 levels at 7% opacity — and a banding step IS one level, so it was
 * dithering nothing exactly where the bands are.
 *
 * Normal compositing gives constant amplitude regardless of how dark the
 * backdrop is: each pixel adds between 0 and `opacity` of white, so the swing
 * is a flat ~5 levels everywhere. That is enough to scatter pixels across the
 * boundary between two quantisation levels, which is what stops the eye
 * joining them into a ring.
 *
 * feColorMatrix forces RGB to white while PRESERVING feTurbulence's naturally
 * random alpha — the opposite of the `feFuncA` trick, which pins alpha to 1
 * to make an opaque tile. Here the randomness needs to live in alpha.
 *
 * Static background-image: no per-frame cost.
 */
const DITHER_TILE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='d' x='0' y='0'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23d)'/%3E%3C/svg%3E\")";

/** Unlocks the tier preview. Type it on the DAY STREAK label. */
const STREAK_CODE = '999';

const LIST_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- Width tiers --------------------------------------------------
 * The spec's geometry assumes the panel owns the whole content area. It
 * doesn't: opening the queue / lyrics dock reserves NP_PANEL_W + 12 = 372px,
 * which leaves ~794px at a 1400px window and ~674px at 1280 — against fixed
 * columns that want 1031px on their own. Everything overflowed.
 *
 * So the fixed widths become fixed-per-tier. The invariant that actually
 * matters in spec §5 is that every row in a list shares ONE track width, so
 * bar lengths stay comparable down the column — that holds at every tier,
 * because the tier is a property of the panel, not of the row.
 *
 * The widest tier is the spec verbatim: 330 rail, 200 ring, 250 title block
 * with a flex spacer, 180 bar. Below it the title block flexes instead of
 * being pinned at 250 (which is what the spacer was absorbing anyway) and
 * the ring and bars step down.
 */
const TIERS = {
  wide:  { key: 'wide',  rail: 330, ring: 200, ringNum: 62, titleW: 250,  songBar: 180, genreBar: 60, art: 38, pad: 24, gap: 18, rowGap: 12, showPlays: true },
  mid:   { key: 'mid',   rail: 296, ring: 176, ringNum: 52, titleW: null, songBar: 120, genreBar: 48, art: 36, pad: 20, gap: 16, rowGap: 11, showPlays: true },
  tight: { key: 'tight', rail: 236, ring: 150, ringNum: 42, titleW: null, songBar: 52,  genreBar: 34, art: 32, pad: 16, gap: 14, rowGap: 10, showPlays: true },
  /* The window minimum is 1000px wide. With the dock open that leaves the
     panel ~394px, which no amount of shrinking makes room for five columns.
     Below the floor the row SHEDS columns instead of crushing them: artwork,
     both bars and the play count go, leaving rank + title + time. Squeezing
     all five to 40px each would keep the shape and lose the information. */
  min:   { key: 'min',   rail: 190, ring: 118, ringNum: 34, titleW: null, songBar: 0,   genreBar: 0,  art: 0,  pad: 12, gap: 12, rowGap: 8,  showPlays: false },
};

/**
 * Measure the PANEL, not the viewport — the viewport doesn't change when the
 * dock opens, which is the whole failure mode this exists to fix.
 */
function tierFor(width) {
  if (width >= 1040) return TIERS.wide;
  if (width >= 860) return TIERS.mid;
  if (width >= 700) return TIERS.tight;
  return TIERS.min;
}

function useTier(ref) {
  const [tier, setTier] = useState(TIERS.wide);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;

    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (!w) return;
      /* Two throttles, both load-bearing during the dock's 260ms
         padding-right transition:
         1. rAF-coalesce, so a burst of observations in one frame costs one
            update — and so we never write state synchronously inside the
            observer callback, which is what trips Chromium's "ResizeObserver
            loop completed with undelivered notifications" and the visible
            stutter that comes with it.
         2. Compare the TIER, not the width. The transition emits ~60 width
            changes; only 0-3 of them cross a breakpoint. Storing the raw
            width re-rendered the whole page on every frame of the animation
            for no visual difference, which is the jitter. */
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = tierFor(w);
        setTier((prev) => (prev.key === next.key ? prev : next));
      });
    });

    ro.observe(el);
    return () => { if (frame) cancelAnimationFrame(frame); ro.disconnect(); };
  }, [ref]);

  return tier;
}

/* ---------- Formatting (spec §3) ----------------------------------------- */

/**
 * `49h 33m` / `1h 20m` / `59m`. Never zero-padded, never seconds.
 * Minutes are kept even at a whole hour so the column keeps one shape.
 */
function fmtDur(ms) {
  const mins = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* ---------- Range presets (spec §7) -------------------------------------- */

/**
 * `This week` / `This month` / `This year` are calendar-relative — they
 * start at the boundary, not a rolling window back from now, because
 * "this month" on the 3rd should read as three days and not thirty.
 * `Last 6 months` is rolling, as its label says.
 */
const RANGES = [
  ['week', 'This week'],
  ['month', 'This month'],
  ['6months', 'Last 6 months'],
  ['year', 'This year'],
  ['all', 'All time'],
];

function rangeStart(key, earliestMs) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  switch (key) {
    case 'week': {
      // Monday-start, matching the rest of the app's day maths.
      const back = (d.getDay() + 6) % 7;
      return d.getTime() - back * DAY_MS;
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case '6months': {
      const s = new Date(d);
      s.setMonth(s.getMonth() - 6);
      return s.getTime();
    }
    case 'year':
      return new Date(d.getFullYear(), 0, 1).getTime();
    case 'all':
    default:
      return Number.isFinite(earliestMs) ? earliestMs : d.getTime();
  }
}

/** First credited artist, matching StudioHome's primaryArtistOf. */
function primaryArtist(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  return raw.split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b)\s*/i)[0].trim() || raw;
}

/* =========================================================================
 *  Data
 * ========================================================================= */

/**
 * Build the StatsPayload of spec §3 from the play log.
 *
 * Listening time is the played track's duration, which is what the log
 * gives us — an event records that a track was played, not how much of it
 * was heard. Genres follow the app's existing convention: a track tagged
 * with two genres counts toward both, so the genre column deliberately
 * sums to more than total listening time.
 */
function useStatsPayload({ playEvents, library, rangeKey, coverFor }) {
  return useMemo(() => {
    /* ---- Attributing a play to a track ----
     * Track ids are minted fresh on every import, so clearing the library or
     * re-downloading a file gives the same song a NEW id and orphans every
     * historical event pointing at the old one. libraryDb anticipated this:
     * every event carries `path` (exact, but breaks if the file moves) and
     * `key` ("artist::title", survives moves and re-rips). Resolving by id
     * alone silently drops that history — the totals keep counting the plays
     * while the song vanishes out of Top songs and contributes zero time.
     *
     * Preference order matches the migration: id, then path, then key.
     */
    const byId = new Map();
    const byPath = new Map();
    const byKey = new Map();
    for (const t of library) {
      byId.set(t.id, t);
      if (t.filePath && !byPath.has(t.filePath)) byPath.set(t.filePath, t);
      // Must match playTrackKey() in libraryDb.js exactly or the halves miss.
      const k = `${String(t.artist || '').trim().toLowerCase()}::${String(t.title || '').trim().toLowerCase()}`;
      if (k !== '::' && !byKey.has(k)) byKey.set(k, t);
    }
    const resolve = (e) => byId.get(e.id)
      || (e.path ? byPath.get(e.path) : null)
      || (e.key ? byKey.get(e.key) : null)
      || null;

    const events = (playEvents || []).filter((e) => e && Number.isFinite(e.at));

    let earliest = Infinity;
    for (const e of events) if (e.at < earliest) earliest = e.at;

    const from = rangeStart(rangeKey, earliest);
    const to = Date.now();
    const inRange = events.filter((e) => e.at >= from);

    /* Listening time, measured where we have it.
     *
     * `e.ms` is what was actually heard, recorded from playback. Rows written
     * before that existed carry null, and fall back to the track's full
     * duration — the old estimate, which counts a track skipped just past the
     * scrobble threshold as a complete listen. So history is generous and new
     * plays are honest; the two are visibly different only on tracks you skip.
     *
     * The measured value is clamped to a sane multiple of the duration: a
     * stuck timeupdate loop should not be able to award one play eleven hours.
     */
    const msOf = (t, e) => {
      const full = t && Number.isFinite(t.duration) ? t.duration * 1000 : 0;
      const measured = e && Number.isFinite(e.ms) && e.ms > 0 ? e.ms : null;
      if (measured == null) return full;
      return full > 0 ? Math.min(measured, full * 3) : measured;
    };

    let listenedMs = 0;
    const songs = new Map();   // id → { track, listenedMs, plays }
    const artists = new Map(); // lower → { name, listenedMs, plays, cover }
    const genres = new Map();  // lower → { name, listenedMs }
    const days = new Set();

    let unattributed = 0;
    for (const e of inRange) {
      const t = resolve(e);
      if (!t) { unattributed += 1; continue; }
      const ms = msOf(t, e);
      listenedMs += ms;

      /* Keyed by the RESOLVED track, not the event's id — otherwise a song
         re-imported under a new id shows up as two half-height rows. */
      const s = songs.get(t.id) || { id: t.id, track: t, listenedMs: 0, plays: 0 };
      s.listenedMs += ms;
      s.plays += 1;
      songs.set(t.id, s);

      const name = primaryArtist(t?.artist);
      if (name) {
        const k = name.toLowerCase();
        const a = artists.get(k) || { id: k, name, listenedMs: 0, plays: 0, cover: null };
        a.listenedMs += ms;
        a.plays += 1;
        if (!a.cover && t) a.cover = coverFor?.(t) || null;
        artists.set(k, a);
      }

      for (const g of parseGenres(t?.genre)) {
        const gk = g.toLowerCase();
        const gr = genres.get(gk) || { name: g, listenedMs: 0 };
        gr.listenedMs += ms;
        genres.set(gk, gr);
      }

      const d = new Date(e.at);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }

    /* Average day is measured over the days the range has actually covered,
       not the days listened on — otherwise "average day" would rise when you
       skip a day, which is backwards. */
    const elapsedDays = Math.max(1, Math.ceil((to - from) / DAY_MS));

    const byMs = (a, b) => b.listenedMs - a.listenedMs;

    const topSongs = [...songs.values()]
      .sort(byMs)
      .slice(0, LIST_CAP)
      .map((s) => ({
        id: s.id,
        title: s.track?.title || 'Unknown track',
        artist: s.track?.artist || '—',
        artworkUrl: s.track ? (coverFor?.(s.track) || s.track.coverArt || null) : null,
        listenedMs: s.listenedMs,
        plays: s.plays,
        track: s.track,
      }));

    const topArtists = [...artists.values()].sort(byMs).slice(0, LIST_CAP);
    const topGenres = [...genres.values()].sort(byMs).slice(0, LIST_CAP);

    /* Today's listening, range-independent like the streak. It answers the
       one thing the ring cannot: whether today is already banked. */
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    let todayMs = 0;
    for (const e of events) if (e.at >= startOfToday.getTime()) todayMs += msOf(resolve(e), e);

    /* ---- Streak (range-independent, spec §2/§7) ----
       Counted across the whole log so a run crossing a month or a New Year
       survives, and started from yesterday when today is still empty — a
       streak shouldn't look broken at 9am because nothing is on yet. */
    const dayIdx = (ms) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return Math.round(d.getTime() / DAY_MS);
    };
    const played = new Set(events.map((e) => dayIdx(e.at)));
    const todayKey = dayIdx(Date.now());

    /* The run in progress is anchored to today, or to yesterday when today
       is still empty. Every run is collected in one pass so the current run
       and the record fall out of the same walk. */
    const anchor = played.has(todayKey) ? todayKey : todayKey - 1;
    const runs = [];
    if (played.size) {
      let run = 0;
      for (let k = dayIdx(earliest); k <= todayKey; k += 1) {
        if (played.has(k)) run += 1;
        else if (run) { runs.push({ end: k - 1, len: run }); run = 0; }
      }
      if (run) runs.push({ end: todayKey, len: run });
    }

    const currentDays = runs.find((r) => r.end === anchor)?.len || 0;

    /* The record is the best COMPLETED run — the run in progress is excluded.
       Counting the current run as its own record would peg the arc at 100%
       for anyone whose best streak is the one they're on, which is most
       people early on, and would make `new best` unreachable. */
    const recordDays = runs
      .filter((r) => r.end !== anchor)
      .reduce((max, r) => Math.max(max, r.len), 0);

    return {
      range: { label: RANGES.find(([k]) => k === rangeKey)?.[1] || '', from, to },
      totals: {
        listenedMs,
        /* Attributable plays only, so the four metrics reconcile with the
           lists below them. An event whose track is gone for good has no
           duration to add, so counting it here would make Listened and
           Average day disagree with Plays with no way to explain the gap. */
        plays: inRange.length - unattributed,
        artistCount: artists.size,
        avgPerDayMs: listenedMs / elapsedDays,
      },
      unattributed,
      measuredShare: (() => {
        let m = 0;
        for (const e of inRange) if (Number.isFinite(e.ms) && e.ms > 0) m += 1;
        return inRange.length ? m / inRange.length : 0;
      })(),
      streak: { currentDays, recordDays, todayMs, hasHistory: played.size > 0 },
      topSongs,
      topArtists,
      topGenres,
      hasData: inRange.length > 0,
    };
  }, [playEvents, library, rangeKey, coverFor]);
}

/* =========================================================================
 *  Pieces
 * ========================================================================= */

/** Date-range chip + dropdown (spec §6/§7). */
function RangeChip({ value, onPick }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const label = RANGES.find(([k]) => k === value)?.[1] || '';

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={wrap} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          background: T.control, border: `1px solid ${T.controlEdge}`, borderRadius: 9,
          padding: '7px 12px', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, color: T.text, whiteSpace: 'nowrap',
          font: 'inherit', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{ color: T.muted, fontSize: 11, lineHeight: 1 }}>▾</span>
      </button>

      {open ? (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40,
            minWidth: 160, padding: 4,
            background: T.control, border: `1px solid ${T.controlEdge}`, borderRadius: 10,
            boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
          }}
        >
          {RANGES.map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={k === value}
              onClick={() => { onPick(k); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                background: k === value ? 'rgba(255,255,255,0.06)' : 'transparent',
                color: k === value ? T.text : T.sub,
                fontSize: 13, fontWeight: k === value ? 600 : 500,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = k === value ? 'rgba(255,255,255,0.06)' : 'transparent'; }}
            >
              {l}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The streak flame.
 *
 * Replaces the progress ring. The ring measured `current / record`, which
 * looks like progress through something but actually means "how close to your
 * own best" — it sat at 100% for anyone on their best-ever run and told them
 * nothing. The flame encodes the same thing more honestly: the tier colour is
 * an absolute reading of how deep the streak is.
 */
function StreakFlame({ days, size = 136 }) {
  const t = streakTier(days);
  const uid = `f${t.min}`;
  const h = Math.round(size * 1.28);

  const sparkles = t.prism
    ? [[8, 18, 11], [84, 26, 9], [20, 66, 8], [90, 62, 10], [50, 4, 13], [74, 80, 8]].map(([l, tp, sz], k) => (
      <span key={k} className="st-spark" aria-hidden
        style={{ position: 'absolute', left: `${l}%`, top: `${tp}%`, animationDelay: `${k * 0.4}s`, pointerEvents: 'none' }}>
        <svg width={sz} height={sz} viewBox="0 0 24 24">
          <path fill="#fff" d="M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6z" />
        </svg>
      </span>
    ))
    : null;

  return (
    <div
      className={t.prism ? 'st-prism' : undefined}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >

      {sparkles}

      {/* Dither over the glow's falloff. Masked to a soft radial so the noise
          patch has no edge of its own, and sized to the widest shadow so it
          covers every banded pixel and no more. Grayscale, so the 365
          hue-rotate on the wrapper leaves it alone. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: `-${Math.round(size * 0.2)}px`,
          backgroundImage: DITHER_TILE,
          backgroundRepeat: 'repeat',
          /* ~5 levels of swing. Below about 0.015 it stops biting; above
             0.03 the texture becomes visible on the flame body itself. */
          opacity: 0.022,
          pointerEvents: 'none',
          WebkitMaskImage: 'radial-gradient(closest-side, #000 45%, transparent 100%)',
          maskImage: 'radial-gradient(closest-side, #000 45%, transparent 100%)',
        }}
      />
      {/* The glow is a drop-shadow on the flame itself, not a disc behind it.
          A radial gradient is a CIRCLE — a hard-edged round pool of light
          sitting behind an irregular shape, which is why it read as a
          separate object rather than as light coming off the fire. Stacked
          drop-shadows are computed from the rendered silhouette, so the glow
          is flame-shaped and has no edge of its own.

          It also animates for free: the shadows are recomputed from the
          transformed paths every frame, so the glow flickers exactly with the
          flame instead of needing its own breathing keyframe on a separate
          clock (which is what put the old halo out of phase).

          Two passes: a tight bright core and a wide soft ambient. The filter
          lives on the <svg> while the 365 hue-rotate lives on the wrapper —
          both are the `filter` property, so stacking them on one element
          would have the animation overwrite the glow. Nested, the hue-rotate
          composites over the shadows too, so on 365 the glow cycles colour
          with the fire. */}
      <svg
        width={size} height={h} viewBox="0 0 100 128"
        style={{
          overflow: 'visible', display: 'block',
          /* Three tight passes rather than one wide faint one.
             Banding is what you get when alpha changes SLOWLY across many
             pixels: an 8-bit channel only has 256 steps, so a soft glow
             spread over 25px on a near-black panel quantises into visible
             rings. The old second pass (0.19 x size, alpha 0.34) was the
             worst possible shape for it — very wide, very faint.
             Stacking shorter, stronger falloffs sums to a similar amount of
             light while keeping every individual gradient steep enough that
             consecutive pixels land on different 8-bit levels, so there is
             no flat step to see. Also cheaper: the widest blur radius drops
             from 0.19 to 0.11 of the flame size. */
          filter: `drop-shadow(0 0 ${(size * 0.022).toFixed(1)}px rgba(${t.rgb},${t.prism ? 0.95 : 0.88}))`
            + ` drop-shadow(0 0 ${(size * 0.048).toFixed(1)}px rgba(${t.rgb},${t.prism ? 0.66 : 0.55}))`
            + ` drop-shadow(0 0 ${(size * 0.085).toFixed(1)}px rgba(${t.rgb},${t.prism ? 0.38 : 0.28}))`,
        }}
        role="img"
        aria-label={`${days} day streak${t.label !== '—' ? ` — ${t.label}` : ''}`}
      >
        <defs>
          <linearGradient id={`o${uid}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={`rgba(${t.rgb},0.72)`} />
            <stop offset="45%" stopColor={`rgb(${t.rgb})`} />
            <stop offset="100%" stopColor={`rgb(${t.in})`} />
          </linearGradient>
          <linearGradient id={`i${uid}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={`rgb(${t.in})`} />
            <stop offset="100%" stopColor="#fff8ec" />
          </linearGradient>
        </defs>
        <path className="st-flame-o" fill={`url(#o${uid})`} d={FLAME_OUTER} />
        <path className="st-flame-i" fill={`url(#i${uid})`} d={FLAME_INNER} />
      </svg>
    </div>
  );
}

/**
 * How far to the next rung.
 *
 * Without this the ladder is invisible: you cannot aim at a tier you do not
 * know exists, and 365 is just a number nobody ever thinks about.
 */
function NextTier({ days }) {
  const t = streakTier(days);
  const next = nextTierFor(days);
  if (!next) {
    return (
      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <span className="st-crown" style={{
          display: 'inline-block', padding: '4px 11px', borderRadius: 999,
          fontSize: 9.5, fontWeight: 800, letterSpacing: '0.16em',
          textTransform: 'uppercase', color: '#120d18',
        }}>{t.label}</span>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round(((days - t.min) / (next.min - t.min)) * 100)));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ height: 3, borderRadius: 3, background: '#1e1e1e', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 3, transformOrigin: 'left',
          background: `linear-gradient(90deg, rgba(${t.rgb},0.55), rgb(${next.in}))`,
          animation: 'stFillBar 0.9s cubic-bezier(0.22,1,0.36,1) both',
        }} />
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginTop: 6,
        fontSize: 10.5, color: T.faint, fontWeight: 600, letterSpacing: '0.04em',
      }}>
        <span>{t.label === '—' ? 'No streak yet' : t.label}</span>
        <span>{next.min - days} days to {next.label.replace(' days', '')}</span>
      </div>
    </div>
  );
}

/**
 * Every tier, side by side, inside the app.
 *
 * The upper rungs are months of real listening away, so without this there is
 * no way to see whether 180 or 365 actually looks right — and no way to know
 * the ladder exists at all. Behind the code because it is a development view,
 * not a feature: showing a user tiers they have not earned turns a reward
 * into a checklist.
 *
 * Picking a tier previews it in the rail. Nothing here writes: no streak, no
 * play event, nothing on disk.
 */
function TierGallery({ current, preview, onPick, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 60,
        background: 'rgba(4,4,5,0.86)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 22, overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(880px, 100%)', margin: 'auto',
          background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 16,
          padding: '20px 22px 22px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', color: T.text }}>
              Streak tiers
            </div>
            <div style={{ fontSize: 11.5, color: T.muted, marginTop: 3 }}>
              Pick one to preview it in the rail. Nothing is saved.
            </div>
          </div>
          <button type="button" onClick={onClose} style={{
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
            background: '#171717', border: '1px solid #262626', color: T.sub,
            fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
          }}>Close</button>
        </div>

        <div style={{
          display: 'grid', gap: 10, marginTop: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        }}>
          {STREAK_TIERS.slice(1).map((t) => {
            const live = current >= t.min;
            const on = preview === t.min;
            return (
              <button
                key={t.min}
                type="button"
                onClick={() => onPick(on ? null : t.min)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '14px 10px 12px', borderRadius: 13, cursor: 'pointer',
                  background: t.prism ? 'linear-gradient(#141019,#0d0b11)' : '#0c0c0c',
                  border: `1px solid ${on ? `rgb(${t.rgb})` : (t.prism ? '#33244a' : T.rule)}`,
                  fontFamily: 'inherit', textAlign: 'center',
                  /* Tiers you have not reached are dimmed, not hidden — the
                     point is seeing what is ahead of you. */
                  opacity: live || on ? 1 : 0.62,
                }}
              >
                <StreakFlame days={t.min} size={62} />
                <div style={{
                  marginTop: 8, fontSize: 22, fontWeight: 600, letterSpacing: '-0.04em',
                  color: t.prism ? '#ffd98a' : `rgb(${t.rgb})`,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {t.min}{t.prism ? '+' : ''}
                </div>
                <div style={{
                  marginTop: 4, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: T.muted, lineHeight: 1.35,
                }}>
                  {t.label}
                </div>
                {live ? (
                  <div style={{ marginTop: 6, fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5fd3b4' }}>
                    Reached
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Uppercase section label (spec §6). */
function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
      color: T.muted, textTransform: 'uppercase', flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

/** Shared reset for the clickable rows. */
const ROW_BASE = {
  display: 'flex', alignItems: 'center', width: '100%',
  background: 'transparent', border: 'none', borderRadius: 7,
  cursor: 'pointer', textAlign: 'left', color: 'inherit',
  font: 'inherit', fontFamily: 'inherit',
  transition: 'background 0.13s ease',
  /* These rows are real buttons, so they take keyboard focus. Without an
     explicit ring the focused row is invisible, since `outline: none` is
     inherited from the app's reset. */
  outline: 'none',
};

/* Focus ring + the hover fill, as a stylesheet rather than inline handlers:
   :focus-visible has no inline equivalent, and a keyboard user tabbing the
   list needs to see where they are. */
const ROW_CSS = `
.st-row:focus-visible { outline: 2px solid ${T.focus}; outline-offset: -2px; }

/* Flame motion. ONE 3.4s clock for everything.
   The inner flame starts 0.3s late and moves about half as far, so it lags
   the outer like a real inner cone. Running it on its own faster cycle makes
   the two drift apart permanently — they never re-sync, and the core visibly
   leans the wrong way every few seconds. */
@keyframes stFlameO { 0%,100%{transform:scale(1,1) skewX(0)} 28%{transform:scale(.972,1.05) skewX(-2deg)}
  56%{transform:scale(1.038,.972) skewX(1.5deg)} 82%{transform:scale(.993,1.016) skewX(-.7deg)} }
@keyframes stFlameI { 0%,100%{transform:scale(1,1) skewX(0)} 28%{transform:scale(.985,1.028) skewX(-1.1deg)}
  56%{transform:scale(1.022,.985) skewX(.8deg)} 82%{transform:scale(.997,1.009) skewX(-.4deg)} }
@keyframes stHue { to { filter: hue-rotate(360deg); } }
@keyframes stTwinkle { 0%,100%{opacity:0;transform:scale(.4) rotate(0)} 45%{opacity:1;transform:scale(1) rotate(45deg)} }
@keyframes stSlideBg { to { background-position: 300% 0; } }
@keyframes stFillBar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.st-flame-o { animation: stFlameO 3.4s ease-in-out infinite; transform-origin: 50% 96%; }
.st-flame-i { animation: stFlameI 3.4s ease-in-out -0.3s infinite; transform-origin: 50% 96%; }
.st-prism { animation: stHue 4.5s linear infinite; }
.st-spark { animation: stTwinkle 2.4s ease-in-out infinite; }
.st-crown { background: linear-gradient(90deg,#ffd36b,#ff8fd0,#9b7bff,#5ad2ff,#ffd36b);
  background-size: 300% 100%; animation: stSlideBg 4s linear infinite; }

/* Motion here is decorative; the tier colour and the number carry the meaning. */
@media (prefers-reduced-motion: reduce) {
  .st-row { transition: none; }
  .st-flame-o, .st-flame-i, .st-prism, .st-spark, .st-crown {
    animation: none !important;
  }
}
`;

function hoverOn(e) { e.currentTarget.style.background = T.hover; }
function hoverOff(e) { e.currentTarget.style.background = 'transparent'; }

/**
 * Top-songs row (spec §5).
 *
 * The bar track and both trailing numerics are FIXED widths. A flex:1
 * track beside auto-width numbers gives every row a different track
 * length, and bar length then stops being comparable between rows —
 * which is the entire job of the bar.
 */
const SongRow = React.memo(function SongRow({ item, rank, maxMs, onPlay, tier }) {
  const top3 = rank <= 3;
  const pct = maxMs > 0 ? (item.listenedMs / maxMs) * 100 : 0;

  return (
    <button
      type="button"
      className="st-row"
      onClick={() => onPlay?.(item)}
      onMouseEnter={hoverOn}
      onMouseLeave={hoverOff}
      style={{ ...ROW_BASE, gap: tier.rowGap, height: 49, padding: '0 10px' }}
    >
      <span style={{
        width: 14, flexShrink: 0, fontFamily: MONO, fontSize: 13,
        color: top3 ? T.rankTop : T.faint, fontVariantNumeric: 'tabular-nums',
      }}>
        {rank}
      </span>

      {tier.art ? (
        <span style={{
          width: tier.art, height: tier.art, flexShrink: 0, borderRadius: 5, overflow: 'hidden',
          background: item.artworkUrl ? '#1b1b1b' : HATCH,
        }}>
          {item.artworkUrl ? (
            <img
              src={item.artworkUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : null}
        </span>
      ) : null}

      <span style={tier.titleW
        ? { width: tier.titleW, flexShrink: 0, minWidth: 0 }
        : { flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 15, fontWeight: 600,
          color: top3 ? T.text : T.sub,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {item.title}
        </span>
        <span style={{
          display: 'block', fontSize: 12.5, color: T.muted, marginTop: 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {item.artist}
        </span>
      </span>

      {/* The spacer only exists to absorb slack next to the fixed 250px
          title block. Below the widest tier the title block flexes instead,
          so a second flex child here would fight it for the same space. */}
      {tier.titleW ? <span style={{ flex: 1, minWidth: 8 }} /> : null}

      {tier.songBar ? (
        <span style={{
          width: tier.songBar, height: 5, flexShrink: 0, borderRadius: 3,
          background: T.barTrack, overflow: 'hidden',
        }}>
          <span style={{
            display: 'block', height: '100%', width: `${pct}%`, borderRadius: 3,
            background: 'var(--accent-line)',
          }} />
        </span>
      ) : null}

      <span style={{
        width: 56, flexShrink: 0, textAlign: 'right',
        fontFamily: MONO, fontSize: 13, color: T.timeSong, fontVariantNumeric: 'tabular-nums',
      }}>
        {fmtDur(item.listenedMs)}
      </span>

      {tier.showPlays ? (
        <span style={{
          width: 34, flexShrink: 0, textAlign: 'right',
          fontFamily: MONO, fontSize: 13, color: top3 ? T.sub : T.faint,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {item.plays}
        </span>
      ) : null}
    </button>
  );
});

/** Top-artists row (spec §5). */
const ArtistRow = React.memo(function ArtistRow({ item, rank, onOpen, maxMs = 0 }) {
  const top3 = rank <= 3;
  const pct = maxMs > 0 ? (item.listenedMs / maxMs) * 100 : 0;
  return (
    <button
      type="button"
      className="st-row"
      onClick={() => onOpen?.(item)}
      onMouseEnter={hoverOn}
      onMouseLeave={hoverOff}
      style={{ ...ROW_BASE, gap: 12, padding: '7px 10px' }}
    >
      <span style={{
        width: 14, flexShrink: 0, fontFamily: MONO, fontSize: 13,
        color: top3 ? T.rankTop : T.faint, fontVariantNumeric: 'tabular-nums',
      }}>
        {rank}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500,
        color: top3 ? T.text : T.sub,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {item.name}
      </span>
      {/* Same bar as Top songs and Top genres — one ranked-row pattern used
          three times, scaled from zero to the top value so the fifth bar is
          visibly shorter than the first (brief, Stats). */}
      <span style={{ width: 74, height: 5, flexShrink: 0, borderRadius: 3, background: T.barTrack, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, borderRadius: 3, background: 'var(--accent-line)' }} />
      </span>
      <span style={{
        flexShrink: 0, textAlign: 'right', minWidth: 58,
        fontFamily: MONO, fontSize: 12.5, color: T.timeSmall, fontVariantNumeric: 'tabular-nums',
      }}>
        {fmtDur(item.listenedMs)}
      </span>
    </button>
  );
});

/** Top-genres row (spec §5). */
const GenreRow = React.memo(function GenreRow({ item, rank, maxMs, onOpen, tier }) {
  const top3 = rank <= 3;
  const pct = maxMs > 0 ? (item.listenedMs / maxMs) * 100 : 0;
  return (
    <button
      type="button"
      className="st-row"
      onClick={() => onOpen?.(item)}
      onMouseEnter={hoverOn}
      onMouseLeave={hoverOff}
      style={{ ...ROW_BASE, gap: 12, padding: '7px 10px' }}
    >
      <span style={{
        width: 14, flexShrink: 0, fontFamily: MONO, fontSize: 13,
        color: top3 ? T.rankTop : T.faint, fontVariantNumeric: 'tabular-nums',
      }}>
        {rank}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500,
        color: top3 ? T.text : T.sub,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {item.name}
      </span>
      {tier.genreBar ? (
        <span style={{
          width: tier.genreBar, height: 5, flexShrink: 0, borderRadius: 3,
          background: T.barTrack, overflow: 'hidden',
        }}>
          <span style={{
            display: 'block', height: '100%', width: `${pct}%`, borderRadius: 3,
            background: GENRE_COLORS[Math.min(rank - 1, GENRE_COLORS.length - 1)],
          }} />
        </span>
      ) : null}
      <span style={{
        width: 56, flexShrink: 0, textAlign: 'right',
        fontFamily: MONO, fontSize: 12.5, color: T.timeSmall, fontVariantNumeric: 'tabular-nums',
      }}>
        {fmtDur(item.listenedMs)}
      </span>
    </button>
  );
});

/** A list that fills its slot and spreads its rows (spec §1/§8). */
function RankedList({ children, empty, isEmpty }) {
  if (isEmpty) {
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', alignItems: 'center',
        padding: '0 10px', fontSize: 12.5, color: T.muted, lineHeight: 1.5,
      }}>
        {empty}
      </div>
    );
  }
  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      justifyContent: 'space-around',
    }}>
      {children}
    </div>
  );
}

/* =========================================================================
 *  Page
 * ========================================================================= */

export default function StatsPage({
  library = [],
  playEvents = [],
  coverFor,
  onPlaySong,    // (track) → play
  onOpenArtist,  // (name) → artist page
  onOpenGenre,   // (name) → filtered song list
}) {
  const [rangeKey, setRangeKey] = useState('all');
  const rootRef = useRef(null);
  const tier = useTier(rootRef);

  /* Tier preview. `preview` overrides only what is DRAWN — the real streak,
     the play log and everything on disk are untouched. Unlock persists so it
     survives a reload while you are working on the ladder. */
  const [unlocked, setUnlocked] = useState(() => {
    try { return localStorage.getItem('studio:streakUnlocked') === '1'; } catch { return false; }
  });
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeBad, setCodeBad] = useState(false);
  const [preview, setPreview] = useState(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const clicksRef = useRef({ n: 0, at: 0 });

  /* Three quick clicks on the label reveals the box — enough that it is never
     hit by accident, and no visible affordance cluttering the rail. */
  const onLabelClick = useCallback(() => {
    if (unlocked) return;
    const now = Date.now();
    const c = clicksRef.current;
    c.n = now - c.at < 700 ? c.n + 1 : 1;
    c.at = now;
    if (c.n >= 3) { setCodeOpen(true); c.n = 0; }
  }, [unlocked]);

  /* Full exit: drop the preview, close the gallery, and clear the unlock so
     the rail goes back to exactly what a normal user sees. Triple-click plus
     the code gets it back. */
  const lockPreview = useCallback(() => {
    setPreview(null);
    setGalleryOpen(false);
    setCodeOpen(false);
    setCode('');
    setUnlocked(false);
    try { localStorage.removeItem('studio:streakUnlocked'); } catch { /* ignore */ }
  }, []);

  /* Escape always steps back one level: gallery -> preview -> code box.
     Whatever state you are in, the key you would reach for gets you out. */
  useEffect(() => {
    if (!unlocked && !codeOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (galleryOpen) { setGalleryOpen(false); return; }
      if (preview != null) { setPreview(null); return; }
      if (codeOpen) { setCodeOpen(false); setCode(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [unlocked, codeOpen, galleryOpen, preview]);

  const tryCode = useCallback(() => {
    if (code.trim() === STREAK_CODE) {
      setUnlocked(true);
      setCodeOpen(false);
      setCode('');
      setCodeBad(false);
      try { localStorage.setItem('studio:streakUnlocked', '1'); } catch { /* ignore */ }
    } else {
      setCodeBad(true);
      setTimeout(() => setCodeBad(false), 900);
    }
  }, [code]);

  /* Stable identities, or React.memo on the rows buys nothing — a fresh
     arrow function every render is a changed prop every render. */
  const handlePlay = useCallback((row) => { if (row.track) onPlaySong?.(row.track); }, [onPlaySong]);
  const handleArtist = useCallback((a) => onOpenArtist?.(a.name), [onOpenArtist]);
  const handleGenre = useCallback((g) => onOpenGenre?.(g.name), [onOpenGenre]);
  const s = useStatsPayload({ playEvents, library, rangeKey, coverFor });

  const shownDays = preview != null ? preview : s.streak.currentDays;
  const shownTier = streakTier(shownDays);

  const songMax = s.topSongs[0]?.listenedMs || 0;
  const genreMax = s.topGenres[0]?.listenedMs || 0;
  const artistMax = s.topArtists[0]?.listenedMs || 0;

  /* The line under the ring.
     `best run N days` was static trivia — it changes a few times a year and
     tells you nothing you can act on. Today's listening earns the slot
     instead: it moves every session, and it is the one thing the ring
     cannot show, since the ring counts days and says nothing about whether
     today is already banked. At zero it doubles as the "the run is still
     open" signal without nagging about it.

     The record itself still sets the arc's scale (spec §4) — it just lives
     in the ring's tooltip now rather than taking a line. */
  const todayLine = (() => {
    if (!s.streak.hasHistory) return null;
    if (s.streak.todayMs <= 0) return <>nothing played yet today</>;
    return (
      <>
        <span style={{ color: T.text, fontWeight: 600 }}>{fmtDur(s.streak.todayMs)}</span> today
      </>
    );
  })();

  /* Listening time is measured for plays recorded since that landed, and
     estimated from track duration for everything older. Rather than hide the
     mix, the figure says which it is on hover — an estimate that presents
     itself as a measurement is the thing worth avoiding. */
  const listenedHint = (() => {
    const pct = Math.round((s.measuredShare || 0) * 100);
    if (pct >= 99) return 'Measured from actual playback';
    if (pct <= 1) return 'Estimated from track length x play count';
    return `${pct}% measured from actual playback, the rest estimated from track length`;
  })();

  const metrics = [
    ['Listened', fmtDur(s.totals.listenedMs), listenedHint],
    ['Plays', s.totals.plays.toLocaleString(), 'Plays that could be matched to a track in your library'],
    ['Artists', String(s.totals.artistCount), null],
    ['Average day', fmtDur(s.totals.avgPerDayMs), 'Total listening divided by the days this range covers'],
  ];

  return (
    <div
      ref={rootRef}
      className="sth-statspage"
      data-tier={tier.key}
      style={{
        position: 'absolute', inset: 0,
        background: T.panel,
        display: 'flex', overflow: 'hidden',
        /* The dock animates padding-right on an ancestor, so this subtree is
           re-laid-out every frame of the transition. Containment scopes that
           work to the panel instead of letting it invalidate the whole
           shell, which is most of the cost. */
        contain: 'layout paint style',
      }}
    >
      <style>{ROW_CSS}</style>
      <style>{`
        .st-streakcard { position: relative; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
          padding: 20px 0 6px; }
        .st-streaknum { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .st-streaknum .n { font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; color: #F4F4F5; font-variant-numeric: tabular-nums; }
        .st-streaknum .l { margin-top: 8px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #6F6F78; }
        .st-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 20px; flex-shrink: 0; }
        .st-tile { padding: 14px; border-radius: 12px; background: #0E0E11; border: 1px solid #191919; min-width: 0; }
        .st-tile .l { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #6F6F78; }
        .st-tile .v { display: block; margin-top: 6px; font-size: 20px; font-weight: 800; color: #F4F4F5; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      `}</style>

      {galleryOpen ? (
        <TierGallery
          current={s.streak.currentDays}
          preview={preview}
          onPick={(d) => { setPreview(d); setGalleryOpen(false); }}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null}

      {/* ---------------- Left rail (330px) ---------------- */}
      <div style={{
        width: tier.rail, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        padding: `22px ${tier.pad}px ${tier.pad}px`,
      }}>
        {/* 1. Title row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.02em', color: T.text }}>Stats</div>
            <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>Your listening history</div>
          </div>
          <RangeChip value={rangeKey} onPick={setRangeKey} />
        </div>

        {/* 2. Streak ring. Replaces the flame and its linear bar (brief):
            a 192px ring showing progress to the next milestone, the count at
            56px in its centre, a DAY STREAK eyebrow beneath, and the distance
            to the next rung under the card. */}
        <div className="st-streakcard">
          {(() => {
            const t = streakTier(shownDays);
            const next = nextTierFor(shownDays);
            const pct = next ? Math.max(0, Math.min(1, (shownDays - t.min) / (next.min - t.min))) : 1;
            const R = 84; const C = 2 * Math.PI * R;
            return (
              <>
                <svg width="192" height="192" viewBox="0 0 192 192" role="img"
                  aria-label={`${shownDays} day streak${next ? `, ${next.min - shownDays} days to ${next.label}` : ''}`}>
                  <circle cx="96" cy="96" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" />
                  <circle cx="96" cy="96" r={R} fill="none" stroke="var(--accent-line)" strokeWidth="9" strokeLinecap="round"
                    strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 96 96)" />
                </svg>
                <div className="st-streaknum">
                  <div className="n" onClick={onLabelClick}>{shownDays}</div>
                  <div className="l">Day streak</div>
                </div>
              </>
            );
          })()}
        </div>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: T.muted, marginTop: 12, flexShrink: 0 }}>
          {(() => {
            const next = nextTierFor(shownDays);
            return next ? `${next.min - shownDays} days to ${next.label.replace(' days', '')}` : streakTier(shownDays).label;
          })()}
        </div>

        {codeOpen && !unlocked ? (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 10, flexShrink: 0 }}>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') tryCode(); if (e.key === 'Escape') setCodeOpen(false); }}
              placeholder="code"
              style={{
                width: 78, padding: '5px 9px', borderRadius: 8, textAlign: 'center',
                background: '#171717', border: `1px solid ${codeBad ? '#7a3a3a' : '#262626'}`,
                color: T.text, fontSize: 12, fontFamily: MONO, outline: 'none',
              }}
            />
            <button type="button" onClick={tryCode} style={{
              padding: '5px 11px', borderRadius: 8, cursor: 'pointer',
              background: '#1d1d1d', border: '1px solid #2a2a2a', color: T.sub,
              fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
            }}>Go</button>
            {/* Escape worked, but nothing said so. */}
            <button type="button" onClick={() => { setCodeOpen(false); setCode(''); }} style={{
              padding: '5px 9px', borderRadius: 8, cursor: 'pointer',
              background: 'transparent', border: '1px solid #242424', color: T.faint,
              fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
            }}>Cancel</button>
          </div>
        ) : null}

        {unlocked ? (
          <div style={{ marginTop: 11, flexShrink: 0, textAlign: 'center' }}>
            <button
              type="button"
              onClick={() => setGalleryOpen(true)}
              style={{
                padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                background: '#171717', border: '1px solid #262626', color: T.sub,
                fontSize: 10.5, fontWeight: 800, letterSpacing: '0.1em',
                textTransform: 'uppercase', fontFamily: 'inherit',
              }}
            >
              View all tiers
            </button>
            {preview != null ? (
              <button
                type="button"
                onClick={() => setPreview(null)}
                style={{
                  marginLeft: 6, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                  background: 'transparent', border: '1px solid #242424', color: T.faint,
                  fontSize: 10.5, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                Back to real
              </button>
            ) : null}
            {/* The way OUT. Without this the unlock was one-way: the flag
                persists, so the dev controls sat in the rail forever and the
                normal Stats page could not be reached again without editing
                localStorage by hand. */}
            <button
              type="button"
              onClick={lockPreview}
              title="Hide the tier preview and restore the normal page"
              style={{
                marginLeft: 6, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                background: 'transparent', border: '1px solid #242424', color: T.faint,
                fontSize: 10.5, fontWeight: 700, fontFamily: 'inherit',
              }}
            >
              Exit
            </button>
          </div>
        ) : null}

        {/* 4. The four summary figures, as a 2x2 grid of tiles. The old
            layout gave each about 110px of height with a hairline rule and
            put the label a column away from its value. */}
        <div className="st-tiles">
          {metrics.map(([label, value, hint]) => (
            <div className="st-tile" key={label} title={hint || undefined}>
              <span className="l">{label}</span>
              <span className="v">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- Divider ---------------- */}
      <div style={{ width: 1, background: T.rule, margin: `${tier.pad}px 0`, flexShrink: 0 }} />

      {/* ---------------- Right column ---------------- */}
      <div style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: tier.gap,
        padding: `22px ${tier.pad}px ${tier.pad}px`,
      }}>
        {/* Top songs */}
        <div style={{ flex: 1.3, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <SectionLabel>Top songs</SectionLabel>
          <RankedList
            isEmpty={!s.topSongs.length}
            empty={s.hasData ? 'No songs in this range yet.' : 'Nothing played in this range. Play something and it shows up here.'}
          >
            {s.topSongs.map((item, i) => (
              <SongRow
                key={item.id}
                item={item}
                rank={i + 1}
                maxMs={songMax}
                tier={tier}
                onPlay={handlePlay}
              />
            ))}
          </RankedList>
        </div>

        {/* Top artists | Top genres */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingRight: tier.gap }}>
            <SectionLabel>Top artists</SectionLabel>
            <RankedList
              isEmpty={!s.topArtists.length}
              empty="No artists in this range yet."
            >
              {s.topArtists.map((item, i) => (
                <ArtistRow key={item.id} item={item} rank={i + 1} maxMs={artistMax} onOpen={handleArtist} />
              ))}
            </RankedList>
          </div>

          <div style={{ width: 1, background: T.rule, flexShrink: 0 }} />

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: tier.gap }}>
            <SectionLabel>Top genres</SectionLabel>
            <RankedList
              isEmpty={!s.topGenres.length}
              empty="No genre tags on these tracks yet — genres come from Spotify or file tags at import."
            >
              {s.topGenres.map((item, i) => (
                <GenreRow
                  key={item.name}
                  item={item}
                  rank={i + 1}
                  maxMs={genreMax}
                  tier={tier}
                  onOpen={handleGenre}
                />
              ))}
            </RankedList>
          </div>
        </div>
      </div>
    </div>
  );
}
