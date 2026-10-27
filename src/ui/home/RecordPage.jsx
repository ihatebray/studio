import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HeartBurst, heartAnim, useFavBurst } from './HeartBurst.jsx';
import { api } from '../../lib/format.js';
import { formatTime, formatTotalMs } from '../../lib/mediaUtils.js';
import { spotifyIdOf } from '../../lib/spotifyMediaElement.js';
import { ExplicitBadge, HiResImg, PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { MI, ObjectMenu, PlayingBars, useRowDrag } from './common.jsx';
import { RowPlayButton } from './Library.jsx';
import { BoundedMap } from '../../lib/boundedMap.js';
import ScrollJump from './ScrollJump.jsx';

/* A long tracklist renders only the rows near the screen, with spacers above
   and below standing in for the rest, so the scrollbar and the jump buttons
   still see the whole list. A playlist of thousands of songs used to mount
   every row at once and redo all of them whenever anything on the page
   changed. Short lists (most albums) render in full, as before.

   It finds its own scrolling parent (the page), measures the row pitch from the rows it has, and only re-renders
   when the window moves by a few rows. Rows keep their real index, so
   numbering and drag-to-reorder are unchanged. */
const WINDOW_FROM = 150;
const WINDOW_OVER = 12;
const WINDOW_STEP = 6;
function TrackRows({ count, renderRow, className, empty }) {
  const ref = useRef(null);
  const on = count > WINDOW_FROM;
  const [win, setWin] = useState({ first: 0, last: Math.min(count, 60) });
  const pitchRef = useRef(58);
  useEffect(() => {
    if (!on) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    let sc = el.parentElement;
    while (sc && sc !== document.body) {
      const oy = getComputedStyle(sc).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      sc = sc.parentElement;
    }
    if (!sc) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rows = el.querySelectorAll(':scope > .sth-lrow');
      if (rows.length > 1) pitchRef.current = Math.max(20, rows[1].offsetTop - rows[0].offsetTop) || pitchRef.current;
      else if (rows.length) pitchRef.current = rows[0].offsetHeight || pitchRef.current;
      const pitch = pitchRef.current;
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      const from = -top;
      let first = Math.max(0, Math.floor(from / pitch) - WINDOW_OVER);
      let last = Math.min(count, Math.ceil((from + sc.clientHeight) / pitch) + WINDOW_OVER);
      first = Math.floor(first / WINDOW_STEP) * WINDOW_STEP;
      last = Math.min(count, Math.ceil(last / WINDOW_STEP) * WINDOW_STEP);
      if (last <= first) last = Math.min(count, first + WINDOW_STEP);
      setWin((w) => (w.first === first && w.last === last ? w : { first, last }));
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(measure); };
    kick();
    sc.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(kick) : null;
    ro?.observe(sc);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      sc.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
      ro?.disconnect();
    };
  }, [on, count]);
  if (!count) return <div ref={ref} className={className}>{empty}</div>;
  if (!on) {
    const all = [];
    for (let i = 0; i < count; i += 1) all.push(renderRow(i));
    return <div ref={ref} className={className}>{all}</div>;
  }
  const first = Math.min(win.first, count);
  const last = Math.min(Math.max(win.last, first), count);
  const rows = [];
  for (let i = first; i < last; i += 1) rows.push(renderRow(i));
  const pitch = pitchRef.current;
  return (
    <div ref={ref} className={className}>
      {first ? <div aria-hidden style={{ height: first * pitch }} /> : null}
      {rows}
      {count - last ? <div aria-hidden style={{ height: (count - last) * pitch }} /> : null}
    </div>
  );
}


/* Album and playlist pages: one layout for every record, yours or Spotify's.
   The cover, the title block and the buttons sit at the top over a wash of
   the cover's colour, the songs under them, then more by the artist. What
   changes is only what you can do with it: your album edits and saves the
   songs it's missing, your playlist edits, reorders and deletes, a Spotify
   album or playlist saves. Search's album view (InstantSearch) is the same
   design in a panel.

   Colour: the cover's wash fades down from the top over the record's deep
   shade. Dark mode is the app's black with a faint tint of the cover behind
   the title. Immerse draws its moving field behind the page instead
   (LibraryPage), so the page itself goes clear. */

/** True for a title written in capitals ("BLONDE", "DAMN."), not one that
 *  merely has some ("AVANT NOVA" yes, "marroW" no). */
export function isAllCaps(t) {
  const s = String(t || '');
  return /\p{Lu}.*\p{Lu}/su.test(s) && s === s.toLocaleUpperCase() && s !== s.toLocaleLowerCase();
}

const CSS = `
.rp { position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; overflow: hidden; color: #fff; }
.rp-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: auto; }
.rp-wash { position: absolute; top: 0; left: 0; right: 0; height: 620px; pointer-events: none; }
.rp-back { position: absolute; top: 14px; left: 14px; z-index: 6; width: 34px; height: 34px; border-radius: 50%; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.9);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .15s ease; }
.rp-back:hover { background: rgba(0,0,0,0.55); }
/* The bar that sticks once the title has scrolled away. Takes no room until
   then: the negative margin lays it over the top of the page. */
.rp-topbar { position: sticky; top: 0; z-index: 6; height: 56px; margin-bottom: -56px; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; transition: background 0.2s ease, box-shadow 0.2s ease; }
.rp-topbar.is-stuck { background: rgb(var(--rp-deep)); box-shadow: inset 0 -1px 0 rgba(255,255,255,0.07); }
.rp-scroll.is-stuck::-webkit-scrollbar { background: linear-gradient(to bottom, rgb(var(--rp-deep)) 55px, rgba(255,255,255,0.07) 55px, rgba(255,255,255,0.07) 56px, transparent 56px); }
.rp-topbar .rp-back { position: static; flex-shrink: 0; }
.rp-topbar.is-stuck .rp-back { background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
.rp-topbar.is-stuck .rp-back:hover { background: rgba(255,255,255,0.1); }
.rp-topbar-id, .rp-topbar-acts { display: flex; align-items: center; min-width: 0; opacity: 0; transform: translateY(4px); pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease; }
.rp-topbar-id { gap: 12px; flex: 1; }
.rp-topbar-acts { gap: 6px; flex-shrink: 0; }
.rp-topbar.is-stuck .rp-topbar-id, .rp-topbar.is-stuck .rp-topbar-acts { opacity: 1; transform: none; pointer-events: auto; }
.rp-topbar-art { width: 36px; height: 36px; flex-shrink: 0; border-radius: 6px; background-color: rgba(255,255,255,0.08); background-size: cover; background-position: center; }
.rp-topbar-txt { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.rp-topbar-txt b { font-size: 15px; font-weight: 800; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.01em; }
.rp-topbar-txt span { margin-top: 2px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-topbar-ib { width: 36px; height: 36px; flex-shrink: 0; border: none; border-radius: 50%; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; background: transparent; color: rgba(255,255,255,0.72); transition: color 0.14s ease, background 0.14s ease; }
.rp-topbar-ib:hover, .rp-topbar-ib[aria-expanded="true"] { color: #fff; background: rgba(255,255,255,0.1); }
.rp-topbar-play { height: 36px; padding: 0 16px 0 13px; margin-right: 6px; flex-shrink: 0; border-radius: 999px; border: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px; background: #fff; color: #000; font: inherit; font-size: 13.5px; font-weight: 800; }

.rp-head { position: relative; display: flex; align-items: flex-end; gap: 30px; padding: 62px 36px 26px 40px; }
.rp-cover { position: relative; flex-shrink: 0; overflow: hidden; width: clamp(170px, 18vw, 220px); aspect-ratio: 1; border-radius: 12px;
  background: rgba(255,255,255,0.06); box-shadow: 0 18px 50px rgba(0,0,0,0.38), 0 2px 8px rgba(0,0,0,0.28); }
.rp-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
.rp-mosaic { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; width: 100%; height: 100%; }
.rp-cover.is-edit { cursor: pointer; }
.rp-info { position: relative; min-width: 0; flex: 1; }
.rp-kind { font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.72); }
/* Pulled left a hair: a big title's first letter starts after the font's
   own side room, which at this size is several pixels. */
.rp-title { font-size: clamp(32px, 4.3vw, 60px); font-weight: 900; letter-spacing: -0.02em; line-height: 1.06; margin: 3px 0 calc(10px - 0.16em) -0.06em;
  padding: 0 0 0.16em 0.03em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.rp-caps { font-size: 0.88em; letter-spacing: 0.015em; }
.rp-line { font-size: 14.5px; color: rgba(255,255,255,0.74); }
.rp-by { font-weight: 800; color: #fff; }
.rp-by button { border: none; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; text-underline-offset: 3px; }
.rp-by button:hover { text-decoration: underline; }
.rp-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
.rp-play { height: 44px; padding: 0 24px 0 20px; border-radius: 999px; border: none; cursor: pointer; background: #fff; color: #000;
  display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 800; font-size: 15px; transition: transform .12s ease; flex-shrink: 0; }
.rp-play:hover { transform: scale(1.03); }
.rp-ib { position: relative; width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  color: rgba(255,255,255,0.82); background: transparent; transition: background .15s ease, color .15s ease; }
.rp-ib:hover, .rp-ib[aria-expanded="true"] { background: rgba(255,255,255,0.1); color: #fff; }
.rp-ghost { height: 36px; padding: 0 14px 0 11px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.24); background: transparent; color: #fff; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 13px; font-weight: 700; transition: background .15s ease, border-color .15s ease; }
.rp-ghost:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.4); }
.rp-ghost:disabled { cursor: default; opacity: 0.6; }

.rp-body { position: relative; padding: 0 30px 0 34px; }
.rp-list .sth-lrow { padding: 0 10px; border-radius: 10px; }
.rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(255,255,255,0.07); }
.rp-list .sth-lrow.is-playing { background: rgba(255,255,255,0.1); }
.rp-list .sth-lrow-num, .rp-list .sth-lrow-dim { color: rgba(255,255,255,0.62); }
.rp-cols { display: grid; align-items: center; column-gap: 12px; height: 34px; padding: 0 10px; margin-bottom: 6px;
  font-size: 10.5px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.45);
  box-shadow: inset 0 -1px 0 rgba(255,255,255,0.09); }
.rp-art { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,0.08); }
.rp-empty { padding: 30px 10px; color: rgba(255,255,255,0.6); font-size: 14px; }
.rp-list .sth-lrow.is-missing .rp-ttl { color: rgba(255,255,255,0.5) !important; }
.rp-list .sth-lrow.is-missing .rp-sub, .rp-list .sth-lrow.is-missing .sth-lrow-dim, .rp-list .sth-lrow.is-missing .rp-art { opacity: 0.6; }
.rp-list .sth-lrow.is-missing:hover .rp-ttl { color: rgba(255,255,255,0.85) !important; }
.rp-save { width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: rgba(255,255,255,0.72);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background .15s ease, color .15s ease; }
.rp-save:hover { background: rgba(255,255,255,0.12); color: #fff; }
.rp-save:disabled { cursor: default; opacity: 0.6; }
.rp-sub { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Under the list */
.rp-more { margin-top: 30px; padding-bottom: 30px; }
.rp-more h3 { margin: 0 0 14px 10px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.rp-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 168px)); gap: 12px; }
.rp-tile { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 14px; border: none; background: transparent; color: #fff; cursor: pointer; text-align: left; font: inherit; transition: background .15s ease; min-width: 0; }
.rp-tile:hover { background: rgba(255,255,255,0.08); }
.rp-tile img, .rp-tile .ph { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: rgba(255,255,255,0.08); display: block; }
.rp-tile b { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-tile small { font-size: 12.5px; color: rgba(255,255,255,0.6); margin-top: -4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-foot { height: 24px; }

/* The "…" menu: the song menu's look, with what it's for named on top. */

/* Dark mode: darkening a near-black page does nothing, so hover and the
   playing row lighten instead. */
.rp.is-dark .rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(255,255,255,0.05); }
.rp.is-dark .rp-list .sth-lrow.is-playing { background: rgba(255,255,255,0.08); }
.rp.is-dark .rp-tile:hover { background: rgba(255,255,255,0.05); }
/* Immerse: the field shows through, so the stuck bar keeps a glass of it. */
.rp.is-immerse .rp-topbar.is-stuck { background: rgba(var(--rp-deep), 0.72); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
`;

const ICONS = {
  back: <path d="M15 6l-6 6 6 6" />,
  shuffle: <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  edit: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.8" />,
  save: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};
const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[name]}</svg>
);
/* The menu's icons, the song menu's own. */

/** The most common year among the tracks, if any. */
function yearOf(tracks) {
  const n = new Map();
  for (const t of tracks) { const y = Number(t.year); if (y > 1000) n.set(y, (n.get(y) || 0) + 1); }
  let best = null; let c = 0;
  for (const [y, k] of n) if (k > c) { best = y; c = k; }
  return best;
}

const primaryArtist = (s) => String(s || '').split(/,(?=\s)|feat\.|ft\.|&|\bx\b/i)[0].trim();

/* The whole album, from Spotify, so an album you've saved part of shows
   every song: yours as usual, the rest dimmed, ready to play or save.
   Found by searching for the album and matching its name and main artist,
   then reading its tracklist. Cached per album for the session; an album
   that isn't on Spotify is remembered as such, an error isn't. */
const fullAlbumCache = new BoundedMap(120);
const normTitle = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\s[-–—]\s.*$/, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const normAlbum = (s) => normTitle(s).replace(/\b(deluxe|expanded|edition|version|remaster(ed)?|anniversary)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** The whole album's songs from Spotify, or null when it isn't there.
 *  Cached per album (key) for the session, a miss included; an error isn't. */
export async function fullAlbumRows(key, title, artist) {
  if (fullAlbumCache.has(key)) return fullAlbumCache.get(key);
  const a = api();
  if (!a?.spotifySearchAlbums || !a?.spotifyGetAlbumTracks) return null;
  const who = primaryArtist(artist).toLowerCase();
  const want = normAlbum(title);
  const found = await a.spotifySearchAlbums(`${title} ${primaryArtist(artist)}`);
  const list = (Array.isArray(found) ? found : []).filter((x) => String(x?.artists || '').toLowerCase().includes(who));
  const hit = list.find((x) => normAlbum(x.name) === want)
    || list.find((x) => { const n = normAlbum(x.name); return n && want && (n.startsWith(want) || want.startsWith(n)); });
  const id = hit && (hit.albumId || hit.id);
  let out = null;
  if (id) {
    const r = await a.spotifyGetAlbumTracks(String(id));
    const tracks = (r?.tracks || r?.data?.tracks || []).filter((t) => t?.spotifyId || t?.id).map((t) => ({
      ...t, spotifyId: t.spotifyId || t.id, album: t.album || hit.name, albumArtUrl: t.albumArtUrl || hit.albumArtUrl || '',
    }));
    out = tracks.length ? tracks : null;
  }
  fullAlbumCache.set(key, out);
  return out;
}

export function useFullAlbum(enabled, key, title, artist) {
  const [rows, setRows] = useState(() => (enabled ? fullAlbumCache.get(key) || null : null));
  useEffect(() => {
    if (!enabled) { setRows(null); return undefined; }
    if (fullAlbumCache.has(key)) { setRows(fullAlbumCache.get(key)); return undefined; }
    setRows(null);
    let live = true;
    fullAlbumRows(key, title, artist).then((out) => { if (live) setRows(out); })
      .catch(() => { /* offline or signed out: just your songs */ });
    return () => { live = false; };
  }, [enabled, key, title, artist]);
  return rows;
}

/** The album in Spotify's order (fullRows), each song paired with your copy
 *  when you have it ({ lib, row, key }); songs of yours Spotify doesn't list
 *  stay, at the end. null when nothing is missing. Shared with the Classic
 *  layout (LibraryPage.jsx). */
export function mergeAlbum(fullRows, tracks) {
  if (!fullRows) return null;
  const pool = [...tracks];
  const take = (row) => {
    let i = pool.findIndex((t) => spotifyIdOf(t) === row.spotifyId);
    if (i < 0) i = pool.findIndex((t) => normTitle(t.title) === normTitle(row.title));
    return i < 0 ? null : pool.splice(i, 1)[0];
  };
  const items = fullRows.map((row) => { const lib = take(row); return { lib, row, key: lib ? lib.id : `sp:${row.spotifyId}` }; });
  for (const lib of pool) items.push({ lib, row: null, key: lib.id });
  return items.some((x) => !x.lib) ? items : null;
}

/** A Spotify row as a track the player can stream (nothing is saved). */
export const streamTrack = (row) => ({
  id: `spotify:track:${row.spotifyId}`,
  filePath: `spotify:track:${row.spotifyId}`,
  title: row.title || '',
  artist: row.artists || '',
  album: row.album || '',
  coverArt: row.albumArtUrl || null,
  duration: (Number(row.durationMs) || 0) / 1000,
  explicit: !!row.explicit,
  trackNumber: row.trackNumber || null,
  streamOnly: true,
});

export default function RecordPage({
  data,          // detailData: { kind, title, by, art, customArt, mosaic, tracks }
  tracks,        // after the in-page filter
  wash, deep,
  tint = null,   // the cover's own colour, for Dark mode's faint tint
  accUI,
  dark = false,  // Dark mode: the app's black, a faint tint behind the title
  immerse = false, // Immerse: the field is drawn behind the page (LibraryPage)
  libDetailKey,
  currentTrack, isPlaying,
  onPlayTrack, playFrom = null, onTogglePlay, onToggleFavorite, onRemoveFromPlaylist,
  onMovePlaylistSong = null,   // (trackId, toIndex): a playlist's songs, by drag
  canManage, openRowMenu,
  coverFor, playCountFor, showPlayCounts,
  libAlbums = [], onOpenAlbum, onGoArtist = null, onBack,
  onChangeCover, onEditAlbum, onEditPlaylist, onDeletePlaylist,
  onPlayNext, onAddToQueue, onAddToPlaylist,   // (tracks, name) / (tracks, name) / (trackIds) → the playlist list's props
  moreOpen, setMoreOpen,
  bridge = null,  // saveRow / saveState for Spotify rows (StudioHome's mySpotifyBridge)
  fullAlbum = false, // Settings → Layout → Album Songs: the whole album, not just your songs
}) {
  const isAlbum = data.kind === 'album';
  const songDrag = useRowDrag(isAlbum ? null : onMovePlaylistSong);

  /* A playlist without a cover of its own shows four of the albums inside
     it, so it looks like what's in it rather than like its first song. */
  const mosaic = useMemo(() => {
    if (isAlbum || data.customArt) return null;
    if (data.mosaic) return data.mosaic;
    const seen = [];
    for (const t of data.tracks) {
      const a = coverFor(t);
      if (a && !seen.includes(a)) seen.push(a);
      if (seen.length === 4) break;
    }
    return seen.length === 4 ? seen : null;
  }, [isAlbum, data.customArt, data.mosaic, data.tracks, coverFor]);

  /* Under the list: the artist's other albums in your library. */
  const moreAlbums = useMemo(() => {
    if (!isAlbum) return [];
    const who = primaryArtist(data.by).toLowerCase();
    return libAlbums.filter((a) => a.key !== libDetailKey && primaryArtist(a.artist).toLowerCase() === who).slice(0, 12);
  }, [isAlbum, data.by, libAlbums, libDetailKey]);

  const fullRows = useFullAlbum(isAlbum && !!bridge && fullAlbum, libDetailKey, data.title, data.by);
  /* The album in Spotify's order: each song paired with your copy when you
     have it. Songs of yours Spotify doesn't list stay, at the end. */
  const merged = useMemo(() => mergeAlbum(fullRows, data.tracks), [fullRows, data.tracks]);
  const queue = useMemo(() => (merged ? merged.map((x) => x.lib || streamTrack(x.row)) : null), [merged]);
  const missingCount = merged ? merged.filter((x) => !x.lib).length : 0;
  const total = merged ? merged.length : data.tracks.length;
  const owned = total - missingCount;

  const totalMs = merged
    ? merged.reduce((n, x) => n + (x.lib ? (Number(x.lib.duration) || 0) * 1000 : Number(x.row.durationMs) || 0), 0)
    : data.tracks.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
  const year = isAlbum ? yearOf(data.tracks) : null;
  // What it is, over the title: "Album · 2016", "Playlist".
  const eyebrow = [isAlbum ? 'Album' : 'Playlist', year].filter(Boolean).join(' · ');
  const inLibrary = total && merged && missingCount
    ? (owned === total ? 'All in your library' : owned ? `${owned} of ${total} in your library` : '')
    : '';
  // Nothing in it: no counts to give.
  const meta = !total ? '' : [`${total} ${total === 1 ? 'song' : 'songs'}`, formatTotalMs(totalMs), inLibrary].filter(Boolean).join(' · ');
  const oneArtist = isAlbum && new Set((merged ? merged.map((x) => (x.lib || streamTrack(x.row)).artist) : data.tracks.map((t) => t.artist)).map((a) => String(a || '').toLowerCase())).size <= 1;
  const showAlbumCol = !isAlbum;
  const showPlaysCol = showPlayCounts && isAlbum;
  const cols = ['44px', 'minmax(160px,2.4fr)', showAlbumCol ? 'minmax(110px,1.3fr)' : null, showPlaysCol ? '60px' : null, '60px', '52px'].filter(Boolean).join(' ');
  const rowH = isAlbum && oneArtist ? 50 : 58;

  const goArtist = isAlbum && data.by && onGoArtist ? () => onGoArtist({ name: primaryArtist(data.by) }) : null;
  const byLink = data.by
    ? <span className="rp-by">{goArtist ? <button type="button" onClick={goArtist} title={`Go to ${primaryArtist(data.by)}`}>{data.by}</button> : data.by}</span>
    : null;

  const cover = () => (
    <div className={`rp-cover${!isAlbum && onChangeCover ? ' is-edit sth-plcover' : ''}`}
      onClick={!isAlbum && onChangeCover ? onChangeCover : undefined}
      title={!isAlbum && onChangeCover ? 'Change Cover' : undefined}>
      {mosaic
        ? <div className="rp-mosaic">{mosaic.map((a) => <img key={a} src={a} alt="" draggable={false} />)}</div>
        : data.art ? <HiResImg src={data.art} /> : null}
      {!isAlbum && onChangeCover ? (
        <div className="sth-plcover-veil">
          <Icon name="edit" size={24} />
          <span style={{ fontSize: 11.5, fontWeight: 650, marginTop: 7 }}>Change Cover</span>
        </div>
      ) : null}
    </div>
  );

  // With the whole album known, Play plays all of it (your copies where you have them).
  const playList = queue || data.tracks;
  const order = queue || tracks;
  const playAt = (i, shuffled = false) => {
    if (shuffled) { const sh = [...playList].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh, 'list', playFrom); return; }
    onPlayTrack?.(order[i], order, 'list', playFrom);
  };
  /* Playing from here: Play turns into Pause (and pauses rather than
     starting over), on the page and in the sticking bar. */
  const curSid = spotifyIdOf(currentTrack);
  const playingHere = !!currentTrack && playList.some((t) => t && (t.id === currentTrack.id || (!!curSid && spotifyIdOf(t) === curSid)));
  const showPause = playingHere && isPlaying;
  const playPause = () => (playingHere && onTogglePlay ? onTogglePlay() : playAt(0));
  const shuffle = () => playAt(0, true);

  // Save what's missing: the songs of your album Spotify has and you don't.
  const missingRows = merged ? merged.filter((x) => !x.lib).map((x) => x.row) : [];
  const toSave = bridge ? missingRows.filter((r) => !bridge.saveState(r)) : [];
  const saving = bridge ? missingRows.some((r) => bridge.saveState(r) === 'busy') : false;
  const saveMissing = () => { for (const r of toSave) bridge.saveRow(r); };
  const saveLabel = `Save ${missingCount} Missing`;
  const editAction = isAlbum ? onEditAlbum : onEditPlaylist;

  /* The "…" menu, the song menu's look. The same menu opens from the page's
     button and from the bar once it has stuck. */
  const menuItems = [
    onPlayNext && playList.length ? { label: 'Play Next', icon: MI.next, run: () => onPlayNext(playList, data.title) } : null,
    onAddToQueue && playList.length ? { label: 'Add to Queue', icon: MI.queue, run: () => onAddToQueue(playList, data.title) } : null,
    onAddToPlaylist && data.tracks.length && !missingCount ? { label: 'Add to Playlist', icon: MI.playlist, picker: onAddToPlaylist(data.tracks.map((t) => t.id)) } : null,
    bridge && toSave.length ? { label: 'Save to Library', icon: MI.save, run: saveMissing } : null,
    'sep',
    goArtist ? { label: 'Go to Artist', icon: MI.artist, run: goArtist } : null,
    editAction ? { label: isAlbum ? 'Edit Info' : 'Edit Playlist', icon: MI.edit, run: editAction } : null,
    'sep',
    !isAlbum && onDeletePlaylist ? { label: 'Delete Playlist', icon: MI.trash, run: onDeletePlaylist, danger: true } : null,
  ].filter(Boolean);
  /* The "…" menu closes on a click anywhere else, or Escape, like every
     other menu. Clicks on "…" itself are left to its own toggle. */
  useEffect(() => {
    if (!moreOpen) return undefined;
    const down = (e) => { if (!e.target.closest?.('[data-rowmenu], [data-rp-more]')) setMoreOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    // It's placed against the window, so a scroll underneath it closes it.
    const scroll = (e) => { if (!e.target.closest?.('[data-rowmenu]')) setMoreOpen(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); };
  }, [moreOpen, setMoreOpen]);
  /* Drawn over the whole app, placed against whichever "…" opened it (the
     page's, or the stuck bar's), so nothing on the page can clip it. It
     opens upward when there isn't room below. */
  const moreBtnRef = useRef(null);
  const barMoreRef = useRef(null);
  const [menuAt, setMenuAt] = useState(null);
  const [stuck, setStuck] = useState(false);
  const stuckRef = useRef(false);
  const menuH = menuItems.filter((it) => it !== 'sep').length * 34 + menuItems.filter((it) => it === 'sep').length * 9 + 70;
  useLayoutEffect(() => {
    const btn = stuck ? barMoreRef.current : moreBtnRef.current;
    if (!moreOpen || !btn) { setMenuAt(null); return; }
    const r = btn.getBoundingClientRect();
    const left = stuck ? Math.max(8, r.right - 240) : Math.max(8, Math.min(r.left, window.innerWidth - 248));
    setMenuAt(r.bottom + 6 + menuH <= window.innerHeight - 8
      ? { left, top: r.bottom + 6 }
      : { left, bottom: window.innerHeight - r.top + 6 });
  }, [moreOpen, stuck, menuH]);
  /* The shared menu (ObjectMenu): the song menu's look, header and the
     same playlist list beside Add to Playlist as every other menu. */
  const pageMenu = () => {
    if (!menuAt) return null;
    const at = menuAt.top != null ? { x: menuAt.left, y: menuAt.top } : { x: menuAt.left, y: window.innerHeight - menuAt.bottom, above: true };
    return (
      <ObjectMenu at={at} accentRgb={accUI} onClose={() => setMoreOpen(false)}
        head={{ art: mosaic ? mosaic[0] : data.art, title: data.title, sub: [isAlbum ? 'Album' : 'Playlist', data.by].filter(Boolean).join(' · ') }}
        items={menuItems} />
    );
  };

  const heart = (t) => (onToggleFavorite ? (
    <RowHeart key={`fav:${t.id}`} track={t} color={accUI} onToggle={onToggleFavorite} />
  ) : null);
  const removeBtn = (t) => (!isAlbum && onRemoveFromPlaylist ? (
    <button type="button" className="sth-lrow-more" onClick={() => onRemoveFromPlaylist(libDetailKey, t.id)} title="Remove from Playlist">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  ) : null);
  const titleCell = (t, playing, art) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      {!isAlbum ? (art ? <img className="rp-art" src={art} alt="" decoding="async" draggable={false} /> : <span className="rp-art" />) : null}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span className="rp-ttl" style={{ fontSize: 15, fontWeight: 650, color: playing ? `rgb(${accUI})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.explicit ? <ExplicitBadge /> : null}
        </div>
        {oneArtist ? null : <div className="rp-sub">{t.artist}</div>}
      </div>
    </div>
  );

  const saveBtn = (row) => {
    const st = bridge?.saveState(row);
    return (
      <button type="button" className="rp-save" disabled={st === 'busy'} onClick={() => bridge?.saveRow(row)}
        title={st === 'busy' ? 'Saving…' : 'Save to Library'} aria-label={`Save ${row.title} to your library`}>
        {st === 'busy'
          ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          : <Icon name="save" size={17} />}
      </button>
    );
  };

  const scrollRef = useRef(null);
  const items = merged || tracks.map((t) => ({ lib: t, row: null, key: t.id }));
  const list = (
    <>
      {items.length ? (
        <div className="rp-cols" style={{ gridTemplateColumns: cols }}>
          <span>#</span>
          <span>Title</span>
          {showAlbumCol ? <span>Album</span> : null}
          {showPlaysCol ? <span style={{ textAlign: 'right' }}>Plays</span> : null}
          <span style={{ textAlign: 'right' }}><Icon name="clock" size={13} /></span>
          <span />
        </div>
      ) : null}
      <TrackRows count={items.length} className="rp-list"
        empty={<div className="rp-empty">No songs yet.</div>}
        renderRow={(i) => {
          const it = items[i];
          const t = it.lib || streamTrack(it.row);
          const missing = !it.lib;
          const playing = missing ? curSid === it.row.spotifyId : currentTrack?.id === t.id;
          const plays = missing ? 0 : playCountFor(t.id);
          const num = isAlbum ? (it.row?.trackNumber || t.trackNumber || i + 1) : i + 1;
          const art = it.lib ? coverFor(it.lib) : (it.row.albumArtUrl || null);
          return (
            <div key={it.key}
              className={`sth-lrow${playing ? ' is-playing' : ''}${missing ? ' is-missing' : ''}${missing ? '' : songDrag.cls(i)}`}
              {...(missing ? {} : songDrag.props(i, t.id))}
              style={{ gridTemplateColumns: cols, height: rowH }}
              onDoubleClick={() => playAt(i)}
              /* Every song has the menu; one you don't have yet gets the
                 Spotify version of it (play, save, add to a playlist). */
              onContextMenu={missing ? (e) => openRowMenu(e, null, { row: it.row }) : canManage ? (e) => openRowMenu(e, t) : undefined}>
              <div className="sth-lrow-n">
                {playing
                  ? <span style={{ display: 'inline-flex', justifyContent: 'center' }}><PlayingBars acc={accUI} playing={isPlaying} /></span>
                  : <span className="sth-lrow-num">{num}</span>}
                <RowPlayButton playing={playing} isPlaying={isPlaying} title={t.title}
                  onPlay={() => playAt(i)} onTogglePlay={onTogglePlay} />
              </div>
              {titleCell(t, playing, art)}
              {showAlbumCol ? <div className="sth-lrow-dim sth-lcol-album">{t.album}</div> : null}
              {showPlaysCol ? <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{missing ? '' : plays}</div> : null}
              <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{formatTime(t.duration)}</div>
              <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>{missing ? saveBtn(it.row) : <>{heart(t)}{removeBtn(t)}</>}</div>
            </div>
          );
        }} />
    </>
  );

  const more = moreAlbums.length && !merged ? (
    <section className="rp-more">
      <h3>More by {primaryArtist(data.by)}</h3>
      <div className="rp-shelf">
        {moreAlbums.map((a) => (
          <button key={a.key} type="button" className="rp-tile" onClick={() => onOpenAlbum(a.key)} title={a.name}>
            {a.art ? <img src={a.art} alt="" draggable={false} /> : <span className="ph" />}
            <b>{a.name}</b>
            <small>{[yearOf(a.tracks), `${a.tracks.length} songs`].filter(Boolean).join(' · ')}</small>
          </button>
        ))}
      </div>
    </section>
  ) : null;

  /* The bar sticks once the title has scrolled under it. */
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const check = () => {
      const t = sc.querySelector('.rp-title');
      const now = t ? t.getBoundingClientRect().bottom < sc.getBoundingClientRect().top + 56 : sc.scrollTop > 120;
      if (now !== stuckRef.current) { stuckRef.current = now; setStuck(now); }
    };
    check();
    sc.addEventListener('scroll', check, { passive: true });
    return () => sc.removeEventListener('scroll', check);
  }, [data.title]);
  const thumb = mosaic ? { backgroundImage: `url("${mosaic[0]}")` } : data.art ? { backgroundImage: `url("${data.art}")` } : undefined;
  const topBar = (
    <div className={`rp-topbar${stuck ? ' is-stuck' : ''}`}>
      <button type="button" className="rp-back" onClick={onBack} title="Back" aria-label="Back"><Icon name="back" size={16} /></button>
      <div className="rp-topbar-id" aria-hidden={!stuck}>
        <span className="rp-topbar-art" style={thumb} />
        <span className="rp-topbar-txt"><b>{data.title}</b><span>{[data.by, meta].filter(Boolean).join(' · ')}</span></span>
      </div>
      <div className="rp-topbar-acts" aria-hidden={!stuck}>
        {/* A playlist can run to thousands of songs: top and end are a click
            away, up here where they're always in reach and never over a song. */}
        {!isAlbum ? <ScrollJump scrollRef={scrollRef} watch={items.length} size={36} /> : null}
        <button type="button" className="rp-topbar-play" onClick={playPause} tabIndex={stuck ? 0 : -1} aria-label={`${showPause ? 'Pause' : 'Play'} ${data.title}`}>
          {showPause ? <PauseIcon size={13} /> : <PlayIcon size={13} />}{showPause ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="rp-topbar-ib" tabIndex={stuck ? 0 : -1} title="Shuffle" aria-label={`Shuffle ${data.title}`} onClick={shuffle}><Icon name="shuffle" size={18} /></button>
        {menuItems.length ? (
          <button type="button" ref={barMoreRef} className="rp-topbar-ib" tabIndex={stuck ? 0 : -1} title="More" aria-label="More" data-rp-more="" aria-expanded={stuck && moreOpen} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" size={18} /></button>
        ) : null}
      </div>
    </div>
  );

  /* An all-caps title reads bigger and heavier than the same words in lower
     case: set it a little smaller with a touch of tracking. */
  const title = <h1 className="rp-title">{isAllCaps(data.title) ? <span className="rp-caps">{data.title}</span> : data.title}</h1>;
  const washBg = immerse ? null
    : dark ? (tint ? `linear-gradient(180deg, rgba(${tint},0.16) 0%, rgba(${tint},0.06) 50%, rgba(${tint},0) 100%)` : null)
      : `linear-gradient(180deg, rgba(${wash},0.95) 0%, rgba(${wash},0.62) 38%, rgba(${wash},0.22) 72%, rgba(${wash},0) 100%)`;

  return (
    <div className={`rp${dark ? ' is-dark' : ''}${immerse ? ' is-immerse' : ''}`}
      style={{ '--rp-wash': wash, '--rp-deep': deep, background: immerse ? 'transparent' : `rgb(${deep})` }}>
      <style>{CSS}</style>
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {washBg ? <div className="rp-wash" style={{ background: washBg }} /> : null}
        {topBar}
        <div className="rp-head">
          {cover()}
          <div className="rp-info">
            <div className="rp-kind">{eyebrow}</div>
            {title}
            <div className="rp-line">{byLink}{byLink && meta ? ' · ' : null}{meta}</div>
            <div className="rp-acts">
              <button type="button" className="rp-play" onClick={playPause} aria-label={`${showPause ? 'Pause' : 'Play'} ${data.title}`}>{showPause ? <PauseIcon size={15} /> : <PlayIcon size={15} />}{showPause ? 'Pause' : 'Play'}</button>
              <button type="button" className="rp-ib" title="Shuffle" aria-label="Shuffle" onClick={shuffle}><Icon name="shuffle" /></button>
              {editAction ? (
                <button type="button" className="rp-ib" title={isAlbum ? 'Edit Info' : 'Edit Playlist'} aria-label={isAlbum ? 'Edit Info' : 'Edit Playlist'} onClick={editAction}><Icon name="edit" size={17} /></button>
              ) : null}
              {bridge && (toSave.length || saving) ? (
                <button type="button" className="rp-ghost" disabled={!toSave.length} onClick={saveMissing}>
                  <Icon name="save" size={16} />{toSave.length ? saveLabel : 'Saving…'}
                </button>
              ) : null}
              {menuItems.length ? (
                <button type="button" className="rp-ib" title="More" aria-label="More" data-rp-more="" ref={moreBtnRef} aria-expanded={moreOpen && !stuck} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" /></button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="rp-body">{list}{more}<div className="rp-foot" /></div>
      </div>
      {moreOpen ? pageMenu() : null}
    </div>
  );
}


/** A row's heart, with the favorite animation (HeartBurst.jsx). Its own
 *  component so it can remember the last state and play on the change. */
function RowHeart({ track: t, color, onToggle }) {
  const burst = useFavBurst(t.id, t.isFavorite);
  return (
    <button type="button" className="sth-lrow-more" onClick={() => onToggle(t.id)}
      title={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      style={{ position: 'relative', overflow: 'visible', opacity: t.isFavorite ? 1 : undefined, color: t.isFavorite ? `rgb(${color})` : undefined }}>
      <svg key={burst.key} className={heartAnim(burst)} width="15" height="15" viewBox="0 0 24 24" fill={t.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
      </svg>
      <HeartBurst burst={burst} radius={20} />
    </button>
  );
}
