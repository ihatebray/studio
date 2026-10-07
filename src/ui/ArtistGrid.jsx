import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sampleImageTheme, isFallbackTheme, recordWashSource } from '../lib/coverTheme.js';
import { PlayIcon } from './sharedUI.jsx';
import { api } from '../lib/format.js';
import { BoundedMap } from '../lib/boundedMap.js';

/* =========================================================================
 *  studio — Artists, the browse view
 *
 *  Dense rows, two columns wide.
 *
 *  This was a grid of washed cards, and the cards were doing something real:
 *  each carried the colour of that artist's own photo, so the tab read as a
 *  set of places. What they cost was density. A card is ~206px wide and
 *  ~200px tall for one name and two numbers, so a library of a hundred
 *  artists became a wall you scroll past rather than a list you scan — and
 *  scanning is what this view is FOR. You come here knowing the name.
 *
 *  The photo colour survives the change: it's no longer a gradient the row
 *  sits on (at row height that reads as stripes, not surfaces) but the tint
 *  the row takes on hover, so pointing at an artist still lights them in
 *  their own colour.
 * ========================================================================= */


/* One in-flight request per set of names. The grid mounts, remounts on filter
   changes, and re-renders on hover — without this, each of those would fire a
   fresh batch for names already being fetched. */
const inflight = new Map();

/* Sampling a photo costs a canvas read, and an artist's photo doesn't change
   between mounts. Keyed by URL, so two artists sharing art sample once. */
const themeCache = new BoundedMap(600);

function fetchPortraits(names) {
  const key = names.join('\u0000');
  if (inflight.has(key)) return inflight.get(key);
  const a = api();
  if (!a?.artistImages) return Promise.resolve({});
  const p = a.artistImages(names)
    .then((res) => res?.images || {})
    .catch(() => ({}))
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/**
 * Photos the artist page already fetched and cached.
 *
 * Opening an artist looks up their profile and header art and keeps it in
 * localStorage. The grid was ignoring that and starting from nothing, so an
 * artist whose page you'd visited five minutes earlier still drew as initials
 * until a fresh round trip came back. Same pictures, already on disk.
 */
function seedFromArtistPageCache() {
  try {
    const all = JSON.parse(localStorage.getItem('studio:artistProfiles:v2') || '{}') || {};
    const out = {};
    for (const [key, rec] of Object.entries(all)) {
      const img = rec?.data?.image || rec?.data?.header;
      if (img) out[key] = img;
    }
    return out;
  } catch {
    return {};
  }
}

/** Initials for an artist with no portrait — up to two words, like a contact. */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Brief, Library pages → Artists: a tile grid matching Albums. Circular
   artwork at 148px (artwork stays circular because it's a portrait, not a
   control), the name, and one metadata line: "9 songs · 108 plays". The
   mini-bars are gone — they were too small to encode anything, and several
   looked identical despite counts of 42 and 153. */
function ArtistTile({ artist, portrait, theme, plays, onOpen, onPlay }) {
  const wash = theme ? recordWashSource(theme) : null;
  const n = artist.tracks.length;
  return (
    <div className="stag-tile">
      <button type="button" className="stag-art" onClick={onOpen} aria-label={`Open ${artist.name}`}>
        {portrait ? (
          <img src={portrait} alt="" loading="lazy" />
        ) : (
          <span className="stag-mono" style={{ background: wash ? `linear-gradient(150deg, rgb(${wash}), rgba(${wash},0.45))` : undefined }}>
            {initials(artist.name)}
          </span>
        )}
        <span className="stag-play" aria-hidden onClick={(e) => { e.stopPropagation(); onPlay?.(); }}>
          <PlayIcon size={16} />
        </span>
      </button>
      <button type="button" className="stag-name" onClick={onOpen}>{artist.name}</button>
      <div className="stag-meta st-num">{n} song{n === 1 ? '' : 's'} · {plays} play{plays === 1 ? '' : 's'}</div>
    </div>
  );
}

export default function ArtistGrid({
  /* `reading` is gone. It chose between the now-playing bar's vibrant /
     average / dominant readings, and record surfaces no longer consult it —
     they take recordWashSource, which a card and its page now share. The
     prop stayed accepted-and-ignored, which is worse than absent: it looks
     like the colour is configurable here when it isn't. */
  artists = [], playEvents = [], onOpen, onPlay, emptyNote,
}) {
  const [portraits, setPortraits] = useState(() => seedFromArtistPageCache());
  const [overrides, setOverrides] = useState({});
  const [themes, setThemes] = useState({});
  const askedRef = useRef(new Set());

  /* A picture the user chose for an artist's header is that artist's picture,
     full stop — it should be their face here too, without a round trip. */
  useEffect(() => {
    let dead = false;
    const a = api();
    if (!a?.loadArtistHeaders) return undefined;
    a.loadArtistHeaders()
      .then((res) => { if (!dead) setOverrides(res?.headers || {}); })
      .catch(() => {});
    return () => { dead = true; };
  }, [artists.length]);

  /* Ask only for names not already asked for this session. Re-renders from
     hover, filtering and sorting all pass through here. */
  const names = useMemo(() => artists.map((a) => a.name), [artists]);
  useEffect(() => {
    const fresh = names.filter((n) => !askedRef.current.has(n.toLowerCase()));
    if (!fresh.length) return undefined;
    fresh.forEach((n) => askedRef.current.add(n.toLowerCase()));
    let dead = false;
    fetchPortraits(fresh).then((map) => {
      if (dead || !map || !Object.keys(map).length) return;
      setPortraits((cur) => ({ ...cur, ...map }));
    });
    return () => { dead = true; };
  }, [names]);

  /** The picture actually shown for an artist, override first. */
  const portraitFor = useCallback((a) => (
    overrides[a.key]?.image || portraits[a.name.toLowerCase()] || portraits[a.key] || null
  ), [overrides, portraits]);

  /* Sample each portrait for its card's wash. Cached by URL, so this runs once
     per photo however often the grid remounts. */
  useEffect(() => {
    let dead = false;
    const pending = [];
    const seeded = {};
    for (const a of artists) {
      const src = portraitFor(a);
      if (!src) continue;
      if (themeCache.has(src)) { seeded[a.key] = themeCache.get(src); continue; }
      pending.push([a.key, src]);
    }
    if (Object.keys(seeded).length) setThemes((cur) => ({ ...cur, ...seeded }));
    if (!pending.length) return undefined;
    Promise.all(pending.map(([key, src]) => sampleImageTheme(src)
      .then((t) => {
        /* A failed read resolves to a neutral theme that looks real. Caching
           it would make one bad moment permanent for that photo, and applying
           it would turn a coloured card black — so a failure is remembered as
           "nothing", and the card keeps whatever it had. */
        const ok = isFallbackTheme(t) ? null : t;
        if (ok) themeCache.set(src, ok);
        return [key, ok];
      })
      .catch(() => [key, null])))
      .then((pairs) => {
        if (dead) return;
        const next = {};
        for (const [key, t] of pairs) if (t) next[key] = t;
        if (Object.keys(next).length) setThemes((cur) => ({ ...cur, ...next }));
      });
    return () => { dead = true; };
  }, [artists, portraitFor]);

  /* Play totals per artist, so a card can say what it's actually worth to you. */
  const playsFor = useMemo(() => {
    const counts = new Map();
    for (const e of playEvents || []) {
      if (e?.id) counts.set(e.id, (counts.get(e.id) || 0) + 1);
    }
    const out = {};
    for (const a of artists) {
      let n = 0;
      for (const t of a.tracks) n += counts.get(t.id) || 0;
      out[a.key] = n;
    }
    return out;
  }, [artists, playEvents]);


  if (!artists.length) {
    return (
      <div style={{
        padding: '40px 6px', textAlign: 'center', fontSize: 12.5, fontWeight: 600,
        color: 'rgba(var(--st-sub-rgb), 0.4)',
      }}>
        {emptyNote || 'No artists yet \u2014 import some music to fill this in.'}
      </div>
    );
  }

  return (
    <>
      <style>{`
        .stag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 28px 20px; padding: 4px 0 24px; align-content: start; }
        .stag-tile { min-width: 0; text-align: center; }
        .stag-art { position: relative; display: block; width: 100%; aspect-ratio: 1; max-width: 148px; margin: 0 auto; padding: 0; border: none; border-radius: 50%;
          overflow: hidden; background: rgba(255,255,255,0.05); cursor: pointer; }
        .stag-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .stag-mono { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
          font-size: 34px; font-weight: 800; color: rgba(255,255,255,0.75); background: linear-gradient(150deg, #23232a, #131317); }
        .stag-play { position: absolute; right: 10%; bottom: 8%; width: 38px; height: 38px; border-radius: var(--r-ctl-m, 10px);
          display: flex; align-items: center; justify-content: center; color: #fff;
          background: rgba(12,12,14,0.58); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
          opacity: 0; transform: translateY(4px); transition: opacity 140ms ease, transform 140ms ease, background 140ms ease; }
        .stag-tile:hover .stag-play, .stag-art:focus-visible .stag-play { opacity: 1; transform: translateY(0); }
        .stag-name { display: block; width: 100%; margin-top: 14px; padding: 0; border: none; background: none; cursor: pointer;
          font: inherit; font-size: 14.5px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stag-meta { font-size: 12.5px; color: var(--text-faint); margin-top: 4px; }
        @media (prefers-reduced-motion: reduce) { .stag-play { transition: none; } }
      `}</style>
      <div className="stag-grid">
        {artists.map((a) => (
          <ArtistTile
            key={a.key}
            artist={a}
            portrait={portraitFor(a)}
            theme={themes[a.key] || null}
            plays={playsFor[a.key] || 0}
            onOpen={() => onOpen?.(a.key)}
            onPlay={() => onPlay?.(a)}
          />
        ))}
      </div>
    </>
  );
}
