/* =========================================================================
 *  studio — My Spotify: Home and New Releases
 *
 *  The two pages under "My Spotify" in the sidebar. Everything on them comes
 *  from the signed-in Spotify account (spotifyFeed.js in main) and plays
 *  through the studio-spotify helper, with nothing to download: a row plays
 *  straight away, and Save adds it to the library (and hearts it on Spotify).
 *
 *  Home is about you, and it moves as you listen in Studio: Spotify never
 *  hears about plays here, so Studio keeps its own history (listening.js)
 *  and builds Jump back in, On repeat, Recently played, Rediscover, your
 *  artists and a new mix every day from it, with Spotify's home feed and
 *  Your Library for the shelves, playlists and albums.
 *
 *  New Releases is about them: every album and single from the last two
 *  months by the artists you follow (in Studio, and on Spotify less any
 *  you've hidden), laid out like a library table sorted by date. A row
 *  opens its songs underneath; Following opens the list of who's checked
 *  right under the header.
 *
 *  Collections from Home (an album, a playlist, Liked Songs) open in a
 *  panel that slides over the page's right edge.
 *
 *  StudioHome supplies the bridge (props below): turning rows into playable
 *  tracks, Save and its state, opening an artist page.
 * ========================================================================= */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioFollows, useHiddenArtists, isStudioFollowed, followArtist, unfollowArtist, setArtistHidden,
} from './studioFollows.js';

/* ------------------------------------------------------------------ data */

const feedCache = {};   // key → { data, error }, survives page switches
const autoRetryAt = {}; // key → when the page last retried by itself after a rate limit

function useFeed(key) {
  const [state, setState] = useState(() => feedCache[key] || { data: null, error: null });
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again, and a
  // flag only ever cleared left the page on its skeleton for good.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (force) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const fetcher = {
      home: api?.spotifyFeedHome, releases: api?.spotifyFeedReleases, studio: api?.spotifyFeedStudio,
    }[key];
    if (!fetcher) { setState({ data: null, error: { step: 'unavailable', error: 'Spotify isn’t available in this build.' } }); return; }
    setLoading(true);
    // Paint last session's copy while the fresh one is fetched.
    if (!feedCache[key]?.data && key !== 'studio' && api.spotifyFeedPeek) {
      const old = await api.spotifyFeedPeek(key).catch(() => null);
      if (old && !feedCache[key]?.data) {
        feedCache[key] = { data: old, error: null };
        if (alive.current) setState(feedCache[key]);
      }
    }
    const res = await fetcher(!!force).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    feedCache[key] = res?.ok
      ? { data: res.data, error: null }
      : { data: feedCache[key]?.data || null, error: res || { error: 'Something went wrong.' } };
    if (alive.current) { setState(feedCache[key]); setLoading(false); }
  }, [key]);

  useEffect(() => { load(false); }, [load]);

  /* Rate-limited: come back by ourselves once Spotify's wait is over (if
     that's within half an hour; longer, and it's left to Refresh). */
  const limitedUntil = state.data?.limitedUntil
    || (state.error?.step === 'ratelimit' && state.error.retryAfter ? Date.now() + state.error.retryAfter * 1000 : 0);
  /* Once per 15 minutes per page at most. Retrying the moment each wait
     ended was a loop: Spotify answered "wait 59 seconds" again every time,
     so the page asked every minute for as long as it was open, and the
     limit never got the quiet it needed to lift. */
  useEffect(() => {
    if (!limitedUntil) return undefined;
    const wait = limitedUntil - Date.now();
    if (wait > 30 * 60 * 1000) return undefined;
    if (Date.now() - (autoRetryAt[key] || 0) < 15 * 60 * 1000) return undefined;
    const t = setTimeout(() => { autoRetryAt[key] = Date.now(); load(false); }, Math.max(1500, wait + 1500));
    return () => clearTimeout(t);
  }, [limitedUntil, load, key]);

  return { ...state, loading, refresh: () => load(true), limitedUntil };
}

function waitWords(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** Parts of the page are from an earlier visit because Spotify said wait. */
function LimitBanner({ until }) {
  if (!until || until <= Date.now()) return null;
  const ms = until - Date.now();
  return (
    <div className="msp-banner">
      Spotify is rate-limiting Studio for about {waitWords(ms)}, so parts of this page are from your last visit.
      {ms <= 30 * 60 * 1000 ? ' It updates by itself when the wait is over.' : ' Press refresh after that.'}
    </div>
  );
}

async function loadCollection(item) {
  const api = window.electronAPI;
  const unwrap = (r) => {
    if (r?.ok === false) throw new Error(r.error || 'Couldn’t load this.');
    return r?.data ?? r;
  };
  switch (item.kind) {
    case 'album': {
      const r = await api.spotifyGetAlbumTracks(item.id);
      return (r?.tracks || []).map((t) => ({ ...t, albumId: item.id }));
    }
    case 'playlist': return unwrap(await api.spotifyFeedPlaylist(item.id));
    case 'liked': return unwrap(await api.spotifyFeedLiked());
    // Studio's own mixes (listening.js) come with their songs.
    case 'mix': return item.rows || [];
    // Through main's artist route (the helper's session first).
    case 'artist': return unwrap(await api.spotifyArtistTopTracks(item.id, item.name));
    default: return [];
  }
}

/* --------------------------------------------------------------- helpers */

const cx = (...c) => c.filter(Boolean).join(' ');

function ago(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function daysSince(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00`);
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function releaseDay(dateStr) {
  const d = daysSince(dateStr);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const typeLabel = (r) => (r.type === 'single' ? (r.totalTracks > 3 ? 'EP' : 'Single') : r.type === 'compilation' ? 'Compilation' : 'Album');

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ----------------------------------------------------------------- icons */

const Icon = {
  play: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>,
  pause: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="4" width="4.5" height="16" rx="1.2" /><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" /></svg>,
  shuffle: (s = 15) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>,
  refresh: (s = 15) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg>,
  plus: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  check: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="5 12.5 10 17.5 19 7" /></svg>,
  close: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>,
  spotify: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.09-.5 9.72 1.12.3.18.39.57.2.86zm1.22-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.8-2.13-9.98-1.17a.78.78 0 0 1-.45-1.5c3.64-1.1 8.16-.57 11.25 1.33.37.22.48.7.25 1.08zm.1-2.84C14.7 8.92 9.4 8.74 6.34 9.67a.94.94 0 1 1-.54-1.8c3.51-1.07 9.35-.86 13.04 1.33a.94.94 0 0 1-.96 1.62z" /></svg>,
  spark: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" /></svg>,
  search: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  chevron: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="6 9 12 15 18 9" /></svg>,
  sliders: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  people: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.8 2.8 2.5 3 5.2" /></svg>,
};

function Bars() {
  return <span className="msp-bars" aria-label="Playing"><i /><i /><i /></span>;
}

/* ----------------------------------------------------------------- style */

const CSS = `
.msp-root { position: absolute; inset: 0; overflow: hidden; }
.msp-scroll { position: absolute; inset: 0; overflow-y: auto; scrollbar-width: thin; padding: 30px 32px 48px; }
.msp-wrap { max-width: 1320px; margin: 0 auto; display: flex; flex-direction: column; gap: 34px; }
.msp-wrap.is-tight { gap: 18px; }
.msp-updated { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; }
.msp-sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.msp-sec-h { display: flex; align-items: baseline; gap: 10px; min-height: 28px; }
.msp-sec-h .st-section-title { font-size: 18px; }
.msp-sec-h .st-meta { font-size: 12px; }
.msp-sec-h .msp-more { margin-left: auto; display: flex; gap: 4px; align-self: center; }

/* shared art */
.msp-art { position: relative; flex-shrink: 0; border-radius: var(--r-art); overflow: hidden;
  background: linear-gradient(135deg, rgba(var(--accent-rgb), 0.35), rgba(var(--accent-rgb), 0.08)); }
.msp-art > img { width: 100%; height: 100%; object-fit: cover; display: block; }
.msp-art.is-round { border-radius: 50%; }
.msp-playfab { position: absolute; right: 8px; bottom: 8px; width: 40px; height: 40px; border-radius: 50%; border: none;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--accent); color: var(--accent-ink); box-shadow: 0 8px 22px rgba(0,0,0,0.45);
  opacity: 0; transform: translateY(6px) scale(0.92); transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22,1,0.36,1); }
.msp-tile:hover .msp-playfab, .msp-tile:focus-within .msp-playfab, .msp-playfab.is-on { opacity: 1; transform: none; }

/* playing bars */
.msp-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.msp-bars i { width: 3px; border-radius: 1px; background: var(--accent-line); animation: mspBar 0.9s ease-in-out infinite; }
.msp-bars i:nth-child(2) { animation-delay: -0.3s; } .msp-bars i:nth-child(3) { animation-delay: -0.6s; }
@keyframes mspBar { 0%, 100% { height: 3px; } 50% { height: 12px; } }

/* jump back in */
.msp-jump { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.msp-jumptile { position: relative; display: flex; align-items: center; gap: 12px; height: 64px; padding-right: 12px; border-radius: 12px;
  border: 1px solid var(--border); background: rgba(255,255,255,0.03); cursor: pointer; overflow: hidden; text-align: left; font: inherit; color: inherit;
  transition: background 0.16s ease, border-color 0.16s ease; }
.msp-jumptile:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.12); }
.msp-jumptile .msp-art { width: 64px; height: 64px; border-radius: 0; }
.msp-jumptile .nm { font-size: 13.5px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msp-jumptile .sb { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.msp-jumptile .go { margin-left: auto; width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: var(--accent-ink); opacity: 0; transform: scale(0.85); transition: opacity 0.16s ease, transform 0.2s ease; }
.msp-jumptile:hover .go { opacity: 1; transform: none; }

/* two-up lists */
.msp-duo { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 28px; }
.msp-duo.is-one { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 1100px) { .msp-duo { grid-template-columns: minmax(0, 1fr); } }
.msp-list { display: flex; flex-direction: column; }
.msp-row { display: grid; grid-template-columns: 28px 40px minmax(0, 1fr) auto auto; align-items: center; gap: 12px;
  padding: 6px 8px; border-radius: 10px; cursor: pointer; transition: background 0.14s ease; }
.msp-row:hover { background: rgba(255,255,255,0.05); }
.msp-row.on .t { color: var(--accent-line); }
.msp-row .n { font-size: 12.5px; font-weight: 700; color: var(--text-faint); text-align: center; font-variant-numeric: tabular-nums; }
.msp-row .msp-art { width: 40px; height: 40px; border-radius: 6px; }
.msp-row .t { font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msp-row .a { font-size: 12px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.msp-row .e { display: inline-block; margin-right: 5px; padding: 0 4px; border-radius: 3px; font-size: 9px; font-weight: 800; line-height: 14px;
  background: rgba(255,255,255,0.16); color: var(--text-dim); vertical-align: 1px; }
.msp-row .m { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
.msp-save { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.14); background: transparent; color: var(--text-dim);
  display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity 0.14s ease, background 0.14s ease, color 0.14s ease; }
.msp-row:hover .msp-save, .msp-save.is-saved, .msp-save.is-busy { opacity: 1; }
.msp-save:hover { background: rgba(255,255,255,0.08); color: var(--text); }
.msp-save.is-saved { border-color: transparent; color: var(--success); cursor: default; background: rgba(123,224,176,0.1); }
.msp-save.is-busy { cursor: progress; }

/* cover grids */
.msp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: 20px 18px; }
.msp-grid.is-small { grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); }
/* As many as fit in --rows full rows; the rest are left out rather than
   dangling alone on a last row. Spacing moves into the tiles, since a row
   gap would still be added under the rows that are cut. */
.msp-grid.is-clip { grid-template-rows: repeat(var(--rows, 1), auto); grid-auto-rows: 0; row-gap: 0; overflow: hidden; padding-top: 4px; margin-top: -4px; }
.msp-grid.is-clip > * { padding-bottom: 20px; }
.msp-tile { display: flex; flex-direction: column; gap: 9px; min-width: 0; cursor: pointer; background: none; border: none; padding: 0; text-align: left; font: inherit; color: inherit; }
.msp-tile .msp-art { width: 100%; aspect-ratio: 1; box-shadow: 0 8px 24px rgba(0,0,0,0.35); transition: transform 0.22s cubic-bezier(0.22,1,0.36,1); }
.msp-tile:hover .msp-art { transform: translateY(-3px); }
.msp-tile .nm { font-size: 13.5px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msp-tile .sb { font-size: 12px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.msp-tile.is-artist { align-items: center; text-align: center; }
.msp-tile.is-artist .msp-art { border-radius: 50%; }
.msp-tile.is-artist .nm, .msp-tile.is-artist .sb { text-align: center; }
/* Studio mixes: four covers and the name, like Spotify prints on its own */
.msp-mixart-grid { position: absolute; inset: 0; display: grid; }
.msp-mixart-grid.is-four { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.msp-mixart-grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
.msp-mixart::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.72) 100%); }
.msp-mixart-mark { position: absolute; left: 8px; top: 8px; z-index: 1; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-ink); box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
.msp-jumptile .msp-mixart-mark { display: none; }
.msp-mixart-name { position: absolute; left: 12px; right: 12px; bottom: 10px; z-index: 1; font-size: 19px; font-weight: 800; line-height: 1.05;
  letter-spacing: -0.02em; color: #fff; text-shadow: 0 2px 12px rgba(0,0,0,0.45);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.msp-panel-head .msp-mixart-name { display: none; }
.msp-mixart .msp-playfab { z-index: 2; }
.msp-rank { position: absolute; left: 8px; top: 8px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(6px); }

/* page header: the library's (.sth-libhead): title and meta on one
   baseline, soft-rectangle controls on the row under it */
.msp-lhead { display: flex; flex-direction: column; gap: 16px; padding: 8px 0 16px; box-shadow: inset 0 -1px 0 rgba(var(--st-fg-rgb), 0.08); }
.msp-lhead-tw { display: flex; align-items: baseline; gap: 12px; min-height: 32px; min-width: 0; }
.msp-lhead-t { font-size: 25px; font-weight: 700; letter-spacing: -0.014em; color: var(--st-text, var(--text)); line-height: 1.2; white-space: nowrap; flex-shrink: 0; }
.msp-lhead-m { font-size: 12px; font-weight: 500; color: rgba(var(--st-sub-rgb, var(--st-fg-rgb)), 0.42); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.msp-lhead-r2 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.msp-grow { flex: 1; }
.msp-sep { width: 1px; height: 18px; margin: 0 6px; background: rgba(var(--st-fg-rgb), 0.1); flex-shrink: 0; }
.msp-act { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 8px; border: none; cursor: pointer; flex-shrink: 0;
  background: transparent; color: rgba(var(--st-sub-rgb, var(--st-fg-rgb)), 0.62); font-family: inherit; font-size: 12.5px; font-weight: 600; white-space: nowrap;
  transition: color 0.15s ease, background 0.15s ease; }
.msp-act:hover { color: var(--st-text, var(--text)); background: rgba(var(--st-fg-rgb), 0.07); }
.msp-act.is-on { color: var(--st-text, var(--text)); background: rgba(var(--st-fg-rgb), 0.09); }
.msp-act.is-primary { color: var(--st-text, var(--text)); background: rgba(var(--accent-rgb), 0.16); }
.msp-act.is-primary:hover { background: rgba(var(--accent-rgb), 0.26); }
.msp-act:disabled { opacity: 0.4; cursor: default; background: transparent; }
.msp-act.is-primary:disabled { background: rgba(var(--accent-rgb), 0.1); }
.msp-act.is-sm { height: 28px; padding: 0 10px; font-size: 12px; gap: 6px; }
.msp-act .ct { font-size: 11px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.36); font-variant-numeric: tabular-nums; }
.msp-act.is-on .ct { color: rgba(var(--st-fg-rgb), 0.55); }
@media (max-width: 980px) { .msp-act-label { display: none; } }
.msp-btn-glass { background: rgba(255,255,255,0.12); color: #fff; }
.msp-btn-glass:hover { background: rgba(255,255,255,0.2); }

/* customize home: on/off rows */
.msp-togs { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 8px; }
.msp-tog { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: inherit; font: inherit; text-align: left; transition: background 0.12s ease; }
.msp-tog:hover { background: rgba(var(--st-fg-rgb), 0.05); }
.msp-tog .nm { display: block; font-size: 13px; font-weight: 600; color: rgba(var(--st-fg-rgb), 0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.12s ease; }
.msp-tog.is-on .nm { color: var(--st-text, var(--text)); }
.msp-tog .sb { display: block; font-size: 11px; color: rgba(var(--st-fg-rgb), 0.36); margin-top: 1px; }
.msp-tog .sw { margin-left: auto; flex-shrink: 0; width: 30px; height: 18px; border-radius: 999px; position: relative;
  background: rgba(var(--st-fg-rgb), 0.16); transition: background 0.18s ease; }
.msp-tog .sw i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.35); transition: transform 0.2s cubic-bezier(0.34,1.5,0.5,1); }
.msp-tog.is-on .sw { background: rgb(var(--accent-rgb)); }
.msp-tog.is-on .sw i { transform: translateX(12px); }

/* new releases: a library table sorted by date */
.msp-rtable { container-type: inline-size; display: flex; flex-direction: column; }
.msp-rrow { display: grid; grid-template-columns: 44px minmax(180px, 2.6fr) minmax(80px, 0.8fr) 64px 118px 32px; align-items: center; gap: 12px;
  height: 56px; padding: 0 8px; border-radius: 8px; box-sizing: border-box; cursor: pointer; transition: background 0.14s ease; }
.msp-rrow:not(.msp-rhead):hover { background: rgba(var(--st-fg-rgb), 0.05); }
.msp-rrow.is-open { background: rgba(var(--st-fg-rgb), 0.06); border-radius: 8px 8px 0 0; }
.msp-rrow.is-open:hover { background: rgba(var(--st-fg-rgb), 0.07); }
.msp-rhead { height: 28px; padding-bottom: 8px; cursor: default; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: rgba(var(--st-fg-rgb), 0.32); border-bottom: 1px solid rgba(var(--st-fg-rgb), 0.06); border-radius: 0; }
.msp-rgroup { display: flex; align-items: baseline; gap: 8px; padding: 18px 8px 6px; font-size: 12.5px; font-weight: 700; color: var(--st-text, var(--text)); letter-spacing: -0.005em; }
.msp-rgroup span { font-size: 11.5px; font-weight: 500; color: rgba(var(--st-fg-rgb), 0.34); font-variant-numeric: tabular-nums; }
.msp-rn { position: relative; display: flex; align-items: center; height: 38px; }
.msp-rn .num { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.35); font-variant-numeric: tabular-nums; display: flex; }
.msp-rn .pl { position: absolute; left: -6px; top: 0; bottom: 0; margin: auto 0; width: 28px; height: 28px; border-radius: 50%; border: none; background: transparent;
  color: var(--st-text, #fff); cursor: pointer; display: none; align-items: center; justify-content: center; }
.msp-rn .pl:hover { background: rgba(var(--st-fg-rgb), 0.1); }
.msp-rrow:hover .msp-rn .num { opacity: 0; }
.msp-rrow:hover .msp-rn .pl { display: flex; }
.msp-rtitle { display: flex; align-items: center; gap: 12px; min-width: 0; }
.msp-rtitle .msp-art { width: 40px; height: 40px; border-radius: 6px; }
.msp-rtitle .t { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--st-text, var(--text)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msp-rtitle .a { display: block; font-size: 12.5px; color: rgba(var(--st-fg-rgb), 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.msp-newtag { flex-shrink: 0; }
.msp-link { padding: 0; border: none; background: none; font: inherit; color: inherit; cursor: pointer; }
.msp-link:hover { color: rgba(var(--st-fg-rgb), 0.95); text-decoration: underline; text-underline-offset: 2px; }
.msp-dim { font-size: 13px; color: rgba(var(--st-fg-rgb), 0.5); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.msp-rchev { display: flex; align-items: center; justify-content: center; color: rgba(var(--st-fg-rgb), 0.3); transition: transform 0.24s cubic-bezier(0.22,1,0.36,1), color 0.14s ease; }
.msp-rrow:hover .msp-rchev { color: rgba(var(--st-fg-rgb), 0.7); }
.msp-rrow.is-open .msp-rchev { transform: rotate(180deg); color: var(--st-text, var(--text)); }
@container (max-width: 700px) {
  .msp-rrow { grid-template-columns: 44px minmax(160px, 1fr) minmax(70px, 0.5fr) 104px 32px; }
  .msp-rrow > .c-tracks { display: none; }
}
@container (max-width: 520px) {
  .msp-rrow { grid-template-columns: 44px minmax(140px, 1fr) 96px 32px; }
  .msp-rrow > .c-type { display: none; }
}
/* the songs, opened under their row */
.msp-rexp { padding: 4px 8px 12px 64px; margin-bottom: 6px; border-radius: 0 0 10px 10px; background: rgba(var(--st-fg-rgb), 0.03);
  box-shadow: inset 0 1px 0 rgba(var(--st-fg-rgb), 0.05); animation: mspOpen 0.26s cubic-bezier(0.22,1,0.36,1) both; }
@keyframes mspOpen { from { opacity: 0; transform: translateY(-4px); } }
.msp-rexp-bar { display: flex; align-items: center; gap: 4px; padding: 8px 0 6px; }
.msp-trow { display: grid; grid-template-columns: 28px minmax(0, 1fr) 48px 28px; align-items: center; gap: 10px; height: 38px; padding: 0 6px 0 8px;
  border-radius: 7px; cursor: pointer; transition: background 0.12s ease; }
.msp-trow:hover { background: rgba(var(--st-fg-rgb), 0.05); }
.msp-trow .n { position: relative; display: flex; align-items: center; font-size: 12px; color: rgba(var(--st-fg-rgb), 0.35); font-variant-numeric: tabular-nums; }
.msp-trow .n .pl { display: none; color: var(--st-text, #fff); }
.msp-trow:hover .n .num { display: none; }
.msp-trow:hover .n .pl { display: flex; }
.msp-trow .tt { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.msp-trow .t { font-size: 13.5px; font-weight: 500; color: var(--st-text, var(--text)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; max-width: 70%; }
.msp-trow.on .t { color: var(--accent-line); }
.msp-trow .a { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.42); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.msp-trow .e { display: inline-block; margin-right: 6px; padding: 0 4px; border-radius: 3px; font-size: 9px; font-weight: 800; line-height: 14px;
  background: rgba(var(--st-fg-rgb), 0.16); color: rgba(var(--st-fg-rgb), 0.7); vertical-align: 1px; }
.msp-trow .d { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.42); text-align: right; font-variant-numeric: tabular-nums; }
.msp-trow:hover .msp-save, .msp-trow .msp-save.is-saved { opacity: 1; }

/* following: inline under the header */
.msp-fm { display: flex; flex-direction: column; gap: 16px; padding: 14px 14px 12px; border-radius: 12px;
  background: rgba(var(--st-fg-rgb), 0.025); box-shadow: inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.07);
  animation: mspOpen 0.28s cubic-bezier(0.22,1,0.36,1) both; }
.msp-fm-top { display: flex; align-items: center; gap: 14px; min-width: 0; }
.msp-well { flex: 0 1 380px; min-width: 180px; display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 10px; border-radius: 8px; box-sizing: border-box;
  background: rgba(0,0,0,0.22); box-shadow: inset 0 0 0 1px rgba(var(--st-fg-rgb), 0.08); color: rgba(var(--st-fg-rgb), 0.42); cursor: text; }
.msp-well:focus-within { box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.5); color: rgba(var(--st-fg-rgb), 0.7); }
.msp-well input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; padding: 0; color: var(--st-text, var(--text)); font-family: inherit; font-size: 13px; font-weight: 500; }
.msp-well input::placeholder { color: rgba(var(--st-fg-rgb), 0.3); }
.msp-well-x { width: 17px; height: 17px; flex-shrink: 0; padding: 0; border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
  background: rgba(var(--st-fg-rgb), 0.16); color: rgba(var(--st-fg-rgb), 0.75); }
.msp-fm-note { font-size: 12px; color: rgba(var(--st-fg-rgb), 0.38); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.msp-fm-group { display: flex; flex-direction: column; gap: 6px; }
.msp-fm-h { display: flex; align-items: baseline; gap: 8px; padding: 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: rgba(var(--st-fg-rgb), 0.36); }
.msp-fm-h span { letter-spacing: 0; text-transform: none; font-weight: 500; color: rgba(var(--st-fg-rgb), 0.3); font-variant-numeric: tabular-nums; }
.msp-fm-empty { grid-column: 1 / -1; padding: 6px; font-size: 12.5px; color: rgba(var(--st-fg-rgb), 0.4); }
.msp-chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 8px; max-height: 196px; overflow-y: auto; scrollbar-width: thin; }
.msp-chip { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 6px; border-radius: 8px; min-width: 0; transition: background 0.12s ease; }
.msp-chip:hover { background: rgba(var(--st-fg-rgb), 0.05); }
.msp-chip .who { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; border: none; background: none; padding: 0; cursor: pointer; color: inherit; font: inherit; text-align: left; }
.msp-chip .msp-art { width: 34px; height: 34px; }
.msp-chip .nm { display: block; font-size: 13px; font-weight: 600; color: var(--st-text, var(--text)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msp-chip .tag { display: block; font-size: 11px; color: rgba(var(--st-fg-rgb), 0.38); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.msp-chip.is-hidden .who { opacity: 0.42; }
.msp-chip-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; flex-shrink: 0; border-radius: 6px; border: none; background: transparent; cursor: pointer;
  color: rgba(var(--st-fg-rgb), 0.55); font-family: inherit; font-size: 11.5px; font-weight: 600; opacity: 0; transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease; }
.msp-chip:hover .msp-chip-btn, .msp-chip-btn:focus-visible, .msp-chip-btn.is-on, .msp-chip-btn.is-accent { opacity: 1; }
.msp-chip-btn:hover { background: rgba(var(--st-fg-rgb), 0.08); color: var(--st-text, var(--text)); }
.msp-chip-btn.is-accent { background: rgba(var(--accent-rgb), 0.16); color: var(--st-text, var(--text)); }
.msp-chip-btn.is-accent:hover { background: rgba(var(--accent-rgb), 0.26); }

/* empty / error / skeleton */
.msp-note { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 12px;
  padding: 60px 24px; border-radius: 18px; border: 1px dashed rgba(255,255,255,0.12); color: var(--text-dim); }
.msp-note b { font-size: 16px; color: var(--text); }
.msp-note p { margin: 0; font-size: 13px; max-width: 440px; line-height: 1.55; color: var(--text-faint); }
.msp-note .ic { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: rgba(var(--accent-rgb), 0.16); color: var(--accent-line); }
.msp-banner { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; font-size: 12.5px;
  background: rgba(245,190,80,0.1); color: rgb(245,190,80); border: 1px solid rgba(245,190,80,0.2); }
.msp-sk { border-radius: 10px; background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 100%);
  background-size: 200% 100%; animation: mspSk 1.4s ease-in-out infinite; }
@keyframes mspSk { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* collection panel */
.msp-scrim { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,0.42); animation: mspFade 0.2s ease both; }
@keyframes mspFade { from { opacity: 0; } }
.msp-panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 6; width: min(470px, 100%); display: flex; flex-direction: column;
  background: rgb(var(--st-bg-rgb, 12,12,14)); border-left: 1px solid var(--border); box-shadow: -24px 0 60px rgba(0,0,0,0.45);
  animation: mspSlide 0.34s cubic-bezier(0.22,1,0.36,1) both; }
@keyframes mspSlide { from { transform: translateX(40px); opacity: 0; } }
.msp-panel-head { position: relative; display: flex; gap: 16px; padding: 22px 20px 18px; overflow: hidden; isolation: isolate; }
.msp-panel-head .bg { position: absolute; inset: -40px; z-index: -1; background-size: cover; background-position: center; filter: blur(40px) brightness(0.45) saturate(1.3); }
.msp-panel-head .msp-art { width: 112px; height: 112px; box-shadow: 0 12px 30px rgba(0,0,0,0.45); }
.msp-panel-head .ttl { font-size: 21px; font-weight: 800; color: #fff; letter-spacing: -0.015em; line-height: 1.15;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.msp-panel-head .sub { font-size: 12.5px; color: rgba(255,255,255,0.7); margin-top: 4px; }
.msp-panel-head .x { position: absolute; top: 10px; right: 10px; color: rgba(255,255,255,0.75); }
.msp-panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 18px; }
.msp-panel .msp-row { grid-template-columns: 26px 40px minmax(0, 1fr) auto auto; }
.msp-panel .msp-row.no-art { grid-template-columns: 26px minmax(0, 1fr) auto auto; }
@media (prefers-reduced-motion: reduce) { .msp-panel, .msp-scrim, .msp-bars i, .msp-sk, .msp-rexp, .msp-fm { animation: none !important; } }
`;

/* ---------------------------------------------------------------- pieces */

function Art({ src, round = false, children, style, className }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={cx('msp-art', round && 'is-round', className)} style={style}>
      {src && !broken ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : null}
      {children}
    </span>
  );
}

function SaveButton({ state, onSave }) {
  if (state === 'saved') return <span className="msp-save is-saved" title="In your library">{Icon.check(13)}</span>;
  if (state === 'busy') return <span className="msp-save is-busy" title="Saving…"><svg className="st-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg></span>;
  return (
    <button type="button" className="msp-save" title="Save to your library" aria-label="Save to your library"
      onClick={(e) => { e.stopPropagation(); onSave(); }}>
      {Icon.plus(13)}
    </button>
  );
}

/** One track row. `n` is a rank / position; `meta` the right-hand text. */
function TrackRow({ row, n, meta, list, index, bridge, showArt = true, context = null }) {
  const on = bridge.isCurrent(row);
  return (
    <div className={cx('msp-row', on && 'on', !showArt && 'no-art')} role="button" tabIndex={0}
      onClick={() => bridge.playRows(list, index, { context })}
      onKeyDown={(e) => { if (e.key === 'Enter') bridge.playRows(list, index, { context }); }}
      {...bridge.hoverProps(row)}>
      <span className="n">{on && bridge.isPlaying ? <Bars /> : n}</span>
      {showArt ? <Art src={row.albumArtUrl} /> : null}
      <span style={{ minWidth: 0 }}>
        <span className="t" style={{ display: 'block' }}>{row.title}</span>
        <span className="a" style={{ display: 'block' }}>{row.explicit ? <span className="e">E</span> : null}{row.artists}</span>
      </span>
      <span className="m">{meta}</span>
      <SaveButton state={bridge.saveState(row)} onSave={() => bridge.saveRow(row)} />
    </div>
  );
}

/** Headers read in title case, whatever Spotify sent ("today's biggest
 *  hits" → "Today's Biggest Hits"). Only ever raises a letter; short joining
 *  words stay small unless they start or end the title. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
function titleCase(text) {
  const words = String(text || '').split(' ');
  return words.map((w, i) => (
    i > 0 && i < words.length - 1 && SMALL_WORDS.has(w) ? w : w.replace(/^([^\p{L}]*)(\p{Ll})/u, (_, pre, c) => pre + c.toUpperCase())
  )).join(' ');
}

function SectionHead({ title, meta, children }) {
  return (
    <div className="msp-sec-h">
      <span className="st-section-title">{titleCase(title)}</span>
      {meta ? <span className="st-meta">{meta}</span> : null}
      {children ? <span className="msp-more">{children}</span> : null}
    </div>
  );
}

function Note({ icon, title, body, action }) {
  return (
    <div className="msp-note">
      <span className="ic">{icon}</span>
      <b>{title}</b>
      {body ? <p>{body}</p> : null}
      {action || null}
    </div>
  );
}

function FeedError({ error, onRetry, onConnect }) {
  if (error?.step === 'signin') {
    return (
      <Note icon={Icon.spotify(24)} title="Connect your Spotify"
        body="Sign in to Spotify in Settings to see what you've been playing, your artists, playlists and their new releases here."
        action={<button type="button" className="st-btn st-btn-primary" onClick={onConnect}>Open Connections</button>} />
    );
  }
  const limited = error?.step === 'ratelimit';
  return (
    <Note icon={Icon.refresh(22)} title={limited ? 'Spotify asked Studio to slow down' : 'Couldn’t reach Spotify'}
      body={limited
        ? `Spotify is limiting how often Studio can ask for your data${error.retryAfter ? ` for about ${waitWords(error.retryAfter * 1000)}` : ''}. Playback isn't affected by this.${error.retryAfter && error.retryAfter <= 1800 ? ' This page loads by itself when the wait is over.' : ''}`
        : (error?.error || 'Something went wrong.')}
      action={<button type="button" className="st-btn st-btn-outline" onClick={onRetry}>Try again</button>} />
  );
}

function RefreshButton({ loading, onClick, at, label = 'Updated' }) {
  return (
    <>
      {at ? <span className="msp-updated">{label} {ago(at)}</span> : null}
      <button type="button" className="st-icon-btn" onClick={onClick} disabled={loading} title="Refresh" aria-label="Refresh">
        <span className={loading ? 'st-spin' : ''} style={{ display: 'flex' }}>{Icon.refresh(15)}</span>
      </button>
    </>
  );
}

/* ------------------------------------------------------ collection panel */

function CollectionPanel({ item, bridge, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setRows(null); setErr(null);
    loadCollection(item).then((r) => { if (live) setRows(r || []); }, (e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [item]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = (rows || []).reduce((n, r) => n + (r.durationMs || 0), 0);
  const unsaved = (rows || []).filter((r) => !bridge.saveState(r));
  return (
    <>
      <div className="msp-scrim" onClick={onClose} />
      <aside className="msp-panel" aria-label={item.name}>
        <div className="msp-panel-head">
          <span className="bg" style={{ backgroundImage: item.image ? `url("${item.image}")` : 'none' }} />
          {item.kind === 'liked' ? <LikedArt size={40} /> : item.kind === 'mix' ? <MixArt item={item} /> : <Art src={item.image} round={item.kind === 'artist'} />}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 2 }}>
            <span className="st-eyebrow" style={{ color: 'rgba(255,255,255,0.65)' }}>
              {item.kind === 'artist' ? 'Top songs' : item.kind === 'liked' ? 'Collection' : item.kind === 'mix' ? 'Made in Studio' : item.label || item.kind}
            </span>
            <span className="ttl">{item.name}</span>
            <span className="sub">
              {item.kind === 'liked'
                ? `${item.sub || ''}${rows?.length && item.count > rows.length ? ` · newest ${rows.length} here` : ''}`
                : `${item.sub || ''}${rows?.length ? ` · ${rows.length} songs · ${Math.round(total / 60000)} min` : ''}`}
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={!rows?.length}
                onClick={() => bridge.playRows(rows, 0, { context: item })}>{Icon.play(12)} Play</button>
              <button type="button" className="st-btn st-btn-sm msp-btn-glass" disabled={!rows?.length}
                onClick={() => bridge.playRows(rows, 0, { shuffle: true, context: item })}>{Icon.shuffle(13)} Shuffle</button>
              {unsaved.length > 1 ? (
                <button type="button" className="st-btn st-btn-sm msp-btn-glass" onClick={() => unsaved.forEach((r) => bridge.saveRow(r))}
                  title="Add every song here to your library">{Icon.plus(12)} Save all</button>
              ) : null}
            </div>
          </div>
          <button type="button" className="st-icon-btn is-sm x" onClick={onClose} aria-label="Close">{Icon.close(14)}</button>
        </div>
        <div className="msp-panel-body">
          {err ? <div className="msp-banner" style={{ margin: 10 }}>{err}</div> : null}
          {!rows && !err ? Array.from({ length: 8 }, (_, i) => <div key={i} className="msp-sk" style={{ height: 40, margin: '8px 6px' }} />) : null}
          {(rows || []).map((r, i) => (
            <TrackRow key={`${r.spotifyId}:${i}`} row={r} n={i + 1} list={rows} index={i} bridge={bridge}
              showArt={item.kind !== 'album'} meta={fmtDur(r.durationMs)} context={item} />
          ))}
          {rows && !rows.length ? <div className="st-meta" style={{ padding: 20, textAlign: 'center' }}>Nothing to play here.</div> : null}
        </div>
      </aside>
    </>
  );
}

function usePanel() {
  const [item, setItem] = useState(null);
  const close = useCallback(() => setItem(null), []);
  return [item, setItem, close];
}

/* ------------------------------------------------------------------ Home */

/* Spotify's home shelves Home leaves out: the editorial and mood ones you
   asked to drop (Today's Biggest Hits, Focus, Kick back and relax, bedroom
   rave, your favorite artists), its new-releases shelf (New Releases does that, for artists you
   pick), albums featuring songs you like, and its Jump back in / Recently
   played, which go into Home's own Jump Back In. Everything else stays,
   with Fresh New Music always first. */
// Spotify words it a few ways ("Fresh new music", "Fresh new drops", "Fresh picks").
const FRESH_SHELF = /^fresh (new )?(music|drops|picks|finds)\b|^new music for you/i;
/* Off until you turn them on (Customize): editorial and mood shelves,
   Spotify's own artist/video/concert shelves, and its time-of-day ones. */
const HIDDEN_BY_DEFAULT = /today.?s biggest hits|^focus$|kick back and relax|bedroom rave|your favou?rite artists|uniquely yours|watch what you love|^made for you$|^soundtrack your|^good (morning|afternoon|evening|night)/i;
/* Studio's own sections, in page order, and which start off. */
const STUDIO_SECTIONS = [
  ['st:jump', 'Jump Back In', true],
  ['st:made', 'Made in Studio', true],
  ['st:repeat', 'On Repeat', false],
  ['st:playlists', 'Your Playlists', false],
  ['st:albums', 'Albums in Your Library', true],
  ['st:forever', 'Forever Favourites', false],
];
const STUDIO_DEFAULT = Object.fromEntries(STUDIO_SECTIONS.map(([k, , on]) => [k, on]));

/* Which Home sections show: your choices, over the defaults. Kept on this
   machine; a Spotify shelf is remembered by its title, so one you turn off
   stays off whenever Spotify brings it back. */
const SHELF_PREFS_KEY = 'studio:homeShelves';
function readShelfPrefs() {
  try { return JSON.parse(localStorage.getItem(SHELF_PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function useShelfPrefs() {
  const [prefs, setPrefs] = useState(readShelfPrefs);
  const save = (next) => { setPrefs(next); try { localStorage.setItem(SHELF_PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ } };
  const shown = (key, title = '') => {
    if (key in prefs) return !!prefs[key];
    if (key in STUDIO_DEFAULT) return STUDIO_DEFAULT[key];
    return !HIDDEN_BY_DEFAULT.test(String(title || '').trim());
  };
  return { shown, set: (key, on) => save({ ...prefs, [key]: on }), reset: () => save({}) };
}
const NEVER_SHELVES = /new release|albums? featuring songs you like|jump back in|recently played/i;
/* No podcasts or audiobooks: Studio plays music. (Episodes and shows are
   never turned into tiles, so a podcast shelf is usually empty anyway; this
   catches shelves of podcast playlists too.) */
const PODCAST_SHELVES = /podcast|episode|audiobook|\bshows?\b/i;
const RECENT_SHELVES = /jump back in|recently played/i;

/* Spotify's DJ: an app-only feature that nothing outside Spotify can play. */
const isDj = (it) => it?.id === '37i9dQZF1EYkqdzj48dyYq' || /^dj( x)?$/i.test(String(it?.name || '').trim());


function HomeSkeleton() {
  return (
    <>
      <div className="msp-jump">{Array.from({ length: 6 }, (_, i) => <div key={i} className="msp-sk" style={{ height: 64, borderRadius: 12 }} />)}</div>
      <div className="msp-duo">
        <div>{Array.from({ length: 6 }, (_, i) => <div key={i} className="msp-sk" style={{ height: 44, margin: '6px 0' }} />)}</div>
        <div>{Array.from({ length: 6 }, (_, i) => <div key={i} className="msp-sk" style={{ height: 44, margin: '6px 0' }} />)}</div>
      </div>
    </>
  );
}

function listenTime(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

/** The line under the greeting: how today and this week have gone. */
function pulseLine(p) {
  if (!p || !p.total) return 'Studio keeps track of what you play here, and this page follows along.';
  const bits = [];
  bits.push(p.todaySongs ? `${listenTime(p.todayMs)} today` : 'Nothing yet today');
  if (p.weekSongs) bits.push(`${listenTime(p.weekMs)} this week`);
  if (p.streak >= 2) bits.push(`${p.streak}-day streak`);
  return bits.join(' · ');
}

/** A Studio mix's cover: four of its album covers, with the name on it the
 *  way Spotify prints its own mixes' names. */
function MixArt({ item, children }) {
  const c = item.covers || [];
  const grid = c.length >= 4 ? c.slice(0, 4) : c.slice(0, 1);
  return (
    <Art className="msp-mixart">
      <span className={cx('msp-mixart-grid', grid.length === 4 && 'is-four')}>
        {grid.map((u, i) => <img key={`${u}:${i}`} src={u} alt="" loading="lazy" draggable={false} />)}
      </span>
      <span className="msp-mixart-mark" aria-hidden>{Icon.spark(12)}</span>
      {item.name ? <span className="msp-mixart-name">{item.name}</span> : null}
      {children}
    </Art>
  );
}

function MixTile({ item, onOpen, onPlay }) {
  return (
    <div className="msp-tile" role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item); }}>
      <MixArt item={item}>
        <button type="button" className="msp-playfab" aria-label={`Play ${item.name}`}
          onClick={(e) => { e.stopPropagation(); onPlay(item); }}>{Icon.play(15)}</button>
      </MixArt>
      <span style={{ minWidth: 0 }}>
        <span className="nm" style={{ display: 'block' }}>{item.name}</span>
        <span className="sb" style={{ display: 'block' }}>{item.sub}</span>
      </span>
    </div>
  );
}

/** Customize Home: every section, on or off. Inline under the header, like
 *  New Releases' Following. */
function ShelfCustomizer({ shelves, prefs, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const Row = ({ k, title, sub }) => {
    const on = prefs.shown(k, title);
    return (
      <button type="button" className={cx('msp-tog', on && 'is-on')} role="switch" aria-checked={on} onClick={() => prefs.set(k, !on)}>
        <span style={{ minWidth: 0 }}>
          <span className="nm">{titleCase(title)}</span>
          {sub ? <span className="sb">{sub}</span> : null}
        </span>
        <span className="sw" aria-hidden><i /></span>
      </button>
    );
  };
  return (
    <section className="msp-fm" aria-label="Customize Home">
      <div className="msp-fm-top">
        <span className="msp-fm-note" style={{ whiteSpace: 'normal' }}>
          Choose what Home shows. Spotify changes some of its shelves from day to day; one you turn off stays off whenever it comes back.
        </span>
        <button type="button" className="msp-act is-sm" onClick={prefs.reset} style={{ marginLeft: 'auto' }}>Reset</button>
        <button type="button" className="st-icon-btn is-sm" onClick={onClose} aria-label="Close">{Icon.close(13)}</button>
      </div>
      <div className="msp-fm-group">
        <div className="msp-fm-h">From Studio</div>
        <div className="msp-togs">
          {STUDIO_SECTIONS.map(([k, title]) => <Row key={k} k={k} title={title} />)}
        </div>
      </div>
      <div className="msp-fm-group">
        <div className="msp-fm-h">From Spotify<span>{shelves.length}</span></div>
        <div className="msp-togs">
          {shelves.map((sh) => <Row key={sh.key} k={sh.key} title={sh.title} sub={`${sh.items.length} ${sh.items.length === 1 ? 'item' : 'items'}`} />)}
          {!shelves.length ? <div className="msp-fm-empty">Spotify’s shelves show here once Home has loaded them.</div> : null}
        </div>
      </div>
    </section>
  );
}

export function SpotifyHome({ bridge }) {
  const { data: core, error, loading, refresh, limitedUntil } = useFeed('home');
  // What you've played in Studio (listening.js): local, so always fresh.
  const { data: mine, refresh: refreshMine } = useFeed('studio');
  const [panel, openPanel, closePanel] = usePanel();
  const prefs = useShelfPrefs();
  const [customizing, setCustomizing] = useState(false);

  /* Plays land while the page is open: read Studio's history again every
     minute (it's a local file; nothing goes to Spotify). */
  const refreshMineRef = useRef(refreshMine);
  refreshMineRef.current = refreshMine;
  useEffect(() => {
    const t = setInterval(() => refreshMineRef.current(), 60_000);
    return () => clearInterval(t);
  }, []);

  /* One view of all three. Studio's own listening leads wherever it has
     enough to say; Spotify's home feed and Your Library supply the shelves,
     playlists and albums, and fill in until Studio has history of its own. */
  const data = useMemo(() => {
    if (!core && !mine?.pulse?.total && !mine?.mixes?.length) return null;
    const c = core || {};
    const m = mine || {};
    const uniq = (list, key) => {
      const seen = new Set();
      return list.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    };
    const noDj = (items) => (items || []).filter((it) => !isDj(it));
    const mixes = m.mixes || [];
    const mixById = new Map(mixes.map((x) => [x.id, x]));

    // Spotify titles its personal shelf after your account ("Made For lil bray").
    const retitle = (t) => (/^made for\b/i.test(String(t || '').trim()) ? 'Made for You' : t);
    const feedShelves = (c.shelves || []).map((sh) => ({ ...sh, title: retitle(sh.title), items: noDj(sh.items) })).filter((sh) => sh.items.length);
    /* Made For You goes after the feed, as Sonora adds it. Anything already
       on the page is skipped, so a Daily Mix shows once; a shelf the feed
       already has by that title (Made for You itself, often) gets the rest
       added to it rather than being dropped, so no mix goes missing. */
    const byTitle = new Map(feedShelves.map((sh) => [sh.title, sh]));
    const onPage = new Set(feedShelves.flatMap((sh) => sh.items.map((it) => `${it.kind}:${it.id}`)));
    const madeShelves = [];
    for (const sh of c.madeForYou || []) {
      const title = retitle(sh.title);
      if (!title) continue;
      const items = noDj(sh.items).filter((it) => { const k = `${it.kind}:${it.id}`; if (onPage.has(k)) return false; onPage.add(k); return true; });
      if (!items.length) continue;
      const same = byTitle.get(title);
      if (same) { same.items = [...same.items, ...items]; continue; }
      const shelf = { ...sh, title, items, made: true };
      byTitle.set(title, shelf);
      madeShelves.push(shelf);
    }
    let allShelves = [...feedShelves, ...madeShelves].filter((sh) => !PODCAST_SHELVES.test(sh.title || '') && !NEVER_SHELVES.test(sh.title || ''));

    /* Your Daily Mixes: wherever Spotify put them this time (Made for You,
       Your top mixes, a time-of-day shelf), gathered into one shelf of their
       own with Discover Weekly and Release Radar, so they're always in one
       place and hiding some other shelf can't take them with it. */
    const mixRank = (it) => {
      if (it.kind !== 'playlist') return -1;
      const n = String(it.name || '').trim();
      const d = n.match(/^daily mix (\d+)$/i);
      if (d) return Number(d[1]);
      if (/^discover weekly$/i.test(n)) return 100;
      if (/^release radar$/i.test(n)) return 101;
      return -1;
    };
    const dailyMixes = [];
    const mixSeen = new Set();
    allShelves = allShelves.map((sh) => ({
      ...sh,
      items: sh.items.filter((it) => {
        if (mixRank(it) < 0) return true;
        if (!mixSeen.has(it.id)) { mixSeen.add(it.id); dailyMixes.push(it); }
        return false;
      }),
    })).filter((sh) => sh.items.length);
    dailyMixes.sort((x, y) => mixRank(x) - mixRank(y));

    /* Fresh New Music: the feed's shelf plus Browse's New Releases page,
       built in main so it's there every time. */
    const feedFresh = allShelves.find((sh) => FRESH_SHELF.test(sh.title || ''));
    // Without the mixes already in Your Daily Mixes (Release Radar, often).
    const freshItems = (c.fresh?.items?.length ? noDj(c.fresh.items) : (feedFresh?.items || [])).filter((it) => !mixSeen.has(it.id));
    allShelves = allShelves.filter((sh) => !FRESH_SHELF.test(sh.title || ''));

    const keyOf = (title) => `sp:${String(title || '').trim().toLowerCase()}`;
    const shelves = [
      ...(freshItems.length ? [{ key: 'sp:fresh new music', title: 'Fresh New Music', items: freshItems, fresh: true }] : []),
      ...(dailyMixes.length ? [{ key: 'sp:your daily mixes', title: 'Your Daily Mixes', items: dailyMixes, mixes: true }] : []),
      ...allShelves.map((sh) => ({ ...sh, key: keyOf(sh.title) })),
    ];

    return {
      user: { name: c.user?.name || '', image: null },
      pulse: m.pulse || null,
      /* Studio's own places first, then Spotify's (its recents and its
         Jump back in / Recently played shelves), one tile each. A mix you
         played from shows its current version; a mix that's gone isn't. */
      jumpBackIn: uniq([
        ...(m.recentContexts || []).map((it) => (it.kind === 'mix' ? mixById.get(it.id) && { ...mixById.get(it.id), playedAt: it.playedAt } : it)).filter(Boolean),
        ...noDj(c.recents),
        ...allShelves.filter((sh) => RECENT_SHELVES.test(sh.title || '')).flatMap((sh) => sh.items),
      ], (it) => it?.id && `${it.kind}:${it.id}`),
      mixes,
      todaysMix: m.todaysMix || [],
      // Studio's own listening only: Spotify's versions came from the Web API.
      onRepeat: m.onRepeat || [],
      allTime: m.allTime || [],
      shelves,
      playlists: noDj(c.playlists),
      liked: c.liked || null,
      likedCount: c.liked?.count ?? null,
      savedAlbums: c.albums || [],
      fetchedAt: c.fetchedAt || m.fetchedAt || null,
    };
  }, [core, mine]);

  const name = data?.user?.name ? data.user.name.split(' ')[0] : '';
  const refreshAll = () => { refresh(); refreshMine(); };

  const openItem = (it) => {
    if (it.kind === 'artist' && bridge.onOpenArtist) { bridge.onOpenArtist({ name: it.name, spotifyId: it.id, image: it.image }); return; }
    openPanel(it);
  };
  const playItem = async (it, opts = {}) => {
    try {
      const rows = await loadCollection(it);
      if (rows?.length) bridge.playRows(rows, 0, { ...opts, context: it });
    } catch { openPanel(it); }
  };
  const liked = data?.liked || { kind: 'liked', id: 'liked', name: 'Liked Songs', sub: 'Collection' };
  const today = data?.mixes?.find((x) => x.id === 'today');

  const hasStudio = !!mine?.pulse?.total;
  const nothing = data && !hasStudio && !data.jumpBackIn.length && !data.shelves.length && !data.playlists.length && !data.mixes.length;

  return (
    <div className="msp-root">
      <style>{CSS}</style>
      <div className="msp-scroll">
        <div className="msp-wrap">
          <header className="msp-lhead">
            <div className="msp-lhead-tw">
              <span className="msp-lhead-t">{greeting()}{name ? `, ${name}` : ''}</span>
              <span className="msp-lhead-m">{pulseLine(data?.pulse)}</span>
            </div>
            <div className="msp-lhead-r2">
              <button type="button" className="msp-act is-primary" disabled={!today}
                onClick={() => today && playItem(today)}>{Icon.play(12)} Today’s Mix</button>
              <button type="button" className="msp-act" disabled={!data} onClick={() => playItem(liked, { shuffle: true })}>
                {Icon.shuffle(14)} <span className="msp-act-label">Shuffle Liked Songs</span>
              </button>
              <span className="msp-sep" />
              <button type="button" className={cx('msp-act', customizing && 'is-on')} aria-expanded={customizing} onClick={() => setCustomizing((v) => !v)}>
                {Icon.sliders(14)} <span className="msp-act-label">Customize</span>
              </button>
              <span className="msp-grow" />
              <RefreshButton loading={loading} onClick={refreshAll} at={data?.fetchedAt} />
            </div>
          </header>

          {customizing && data ? <ShelfCustomizer shelves={data.shelves} prefs={prefs} onClose={() => setCustomizing(false)} /> : null}

          {data && limitedUntil ? <LimitBanner until={limitedUntil} /> : null}
          {error && data && error.step !== 'ratelimit' && core ? <div className="msp-banner">Showing what Studio saw last time. {error.error || ''}</div> : null}
          {error && !data ? <FeedError error={error} onRetry={refreshAll} onConnect={bridge.onConnect} /> : null}
          {!data && !error ? <HomeSkeleton /> : null}

          {data ? (
            <>
              {/* ---- Jump back in: Studio's own first, then Spotify's ---- */}
              {prefs.shown('st:jump') && data.jumpBackIn.length ? (
                <section className="msp-sec">
                  <SectionHead title="Jump Back In" meta="Where you left off" />
                  <div className="msp-jump">
                    {data.jumpBackIn.slice(0, 8).map((it) => (
                      <div key={`${it.kind}:${it.id}`} className="msp-jumptile" role="button" tabIndex={0}
                        onClick={() => openItem(it)} onKeyDown={(e) => { if (e.key === 'Enter') openItem(it); }}>
                        {it.kind === 'liked' ? <LikedArt size={24} /> : it.kind === 'mix' ? <MixArt item={{ ...it, name: '' }} /> : <Art src={it.image} round={it.kind === 'artist'} />}
                        <span style={{ minWidth: 0 }}>
                          <span className="nm" style={{ display: 'block' }}>{it.name}</span>
                          <span className="sb" style={{ display: 'block' }}>{it.playedAt ? `${it.kind === 'mix' ? 'Mix' : it.sub || ''}${it.sub || it.kind === 'mix' ? ' · ' : ''}${ago(it.playedAt)}` : it.sub}</span>
                        </span>
                        <button type="button" className="go" aria-label={`Play ${it.name}`} style={{ border: 'none', cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); playItem(it); }}>{Icon.play(13)}</button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---- Studio's own mixes, laid out like Spotify's ---- */}
              {prefs.shown('st:made') && data.mixes.length ? (
                <section className="msp-sec">
                  <SectionHead title="Made in Studio" meta="From what you play here · new every day" />
                  <div className="msp-grid is-clip">
                    {data.mixes.map((x) => <MixTile key={x.id} item={x} onOpen={openItem} onPlay={playItem} />)}
                  </div>
                </section>
              ) : null}

              {/* ---- On repeat ---- */}
              {prefs.shown('st:repeat') && data.onRepeat.length ? (
                <section className="msp-sec">
                  <SectionHead title="On Repeat" meta="Most played this month" />
                  <div className="msp-duo">
                    {[data.onRepeat.slice(0, 5), data.onRepeat.slice(5, 10)].filter((col) => col.length).map((col, c) => (
                      <div key={c} className="msp-list">
                        {col.map((t, i) => (
                          <TrackRow key={t.spotifyId} row={t} n={c * 5 + i + 1} list={data.onRepeat} index={c * 5 + i} bridge={bridge}
                            meta={t.plays ? `${t.plays} plays` : fmtDur(t.durationMs)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---- Spotify's shelves, Fresh New Music first ---- */}
              {data.shelves.filter((sh) => prefs.shown(sh.key, sh.title)).map((sh, n) => (
                <section key={`${sh.title}:${n}`} className="msp-sec">
                  <SectionHead title={sh.title || 'For You'}
                    meta={sh.fresh ? 'From Spotify · new music from everyone, not just who you follow' : sh.mixes ? 'From Spotify · Daily Mixes, Discover Weekly, Release Radar' : 'From Spotify'} />
                  <div className="msp-grid is-clip">
                    {sh.items.map((it) => (it.kind === 'artist' ? (
                      <button key={`${it.kind}:${it.id}`} type="button" className="msp-tile is-artist" onClick={() => openItem(it)}>
                        <Art src={it.image} round />
                        <span style={{ minWidth: 0, width: '100%' }}>
                          <span className="nm" style={{ display: 'block' }}>{it.name}</span>
                          <span className="sb" style={{ display: 'block' }}>Artist</span>
                        </span>
                      </button>
                    ) : <CoverTile key={`${it.kind}:${it.id}`} item={it} onOpen={openItem} onPlay={playItem} liked={it.kind === 'liked'} />))}
                  </div>
                </section>
              ))}

              {/* ---- Playlists ---- */}
              {prefs.shown('st:playlists') && data.playlists.length ? (
                <section className="msp-sec">
                  <SectionHead title="Your Playlists" meta={data.likedCount ? `${data.likedCount.toLocaleString()} liked songs` : null} />
                  <div className="msp-grid is-clip" style={{ '--rows': 3 }}>
                    {data.liked ? <CoverTile item={{ ...data.liked, image: null }} onOpen={openItem} onPlay={playItem} liked /> : null}
                    {data.playlists.map((p) => <CoverTile key={p.id} item={p} onOpen={openItem} onPlay={playItem} />)}
                  </div>
                </section>
              ) : null}

              {/* ---- Saved albums ---- */}
              {prefs.shown('st:albums') && data.savedAlbums.length ? (
                <section className="msp-sec">
                  <SectionHead title="Albums in Your Library" meta="Most recently played first" />
                  <div className="msp-grid is-clip" style={{ '--rows': 2 }}>
                    {data.savedAlbums.map((a) => <CoverTile key={a.id} item={a} onOpen={openItem} onPlay={playItem} />)}
                  </div>
                </section>
              ) : null}

              {/* ---- All time ---- */}
              {prefs.shown('st:forever') && data.allTime.length ? (
                <section className="msp-sec">
                  <SectionHead title="Forever Favourites" meta="Your most played, all time" />
                  <div className="msp-grid is-small is-clip" style={{ '--rows': 2 }}>
                    {data.allTime.slice(0, 20).map((t, i) => (
                      <div key={t.spotifyId} className="msp-tile" role="button" tabIndex={0}
                        onClick={() => bridge.playRows(data.allTime, i)} onKeyDown={(e) => { if (e.key === 'Enter') bridge.playRows(data.allTime, i); }}
                        {...bridge.hoverProps(t)}>
                        <Art src={t.albumArtUrl}>
                          <span className="msp-rank">{i + 1}</span>
                          <span className={cx('msp-playfab', bridge.isCurrent(t) && 'is-on')}>{bridge.isCurrent(t) && bridge.isPlaying ? <Bars /> : Icon.play(14)}</span>
                        </Art>
                        <span style={{ minWidth: 0 }}>
                          <span className="nm" style={{ display: 'block' }}>{t.title}</span>
                          <span className="sb" style={{ display: 'block' }}>{t.plays ? `${t.plays} plays · ` : ''}{t.artists}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {nothing ? (
                <Note icon={Icon.spotify(24)} title="Nothing here yet"
                  body="Play something from Search or an artist’s page. This page fills in with what you play in Studio: where you left off, what’s on repeat, new mixes every day." />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {panel ? <CollectionPanel item={panel} bridge={bridge} onClose={closePanel} /> : null}
    </div>
  );
}

/** Liked Songs' cover: the accent, with a heart. */
function LikedArt({ size = 44, children }) {
  return (
    <Art style={{ background: 'linear-gradient(135deg, rgb(var(--accent-rgb)), rgba(var(--accent-rgb),0.25))' }}>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-ink)' }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2.1 0 3.6 1.2 4.4 2.4C11.8 6.2 13.3 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z" /></svg>
      </span>
      {children}
    </Art>
  );
}

function CoverTile({ item, onOpen, onPlay, liked = false }) {
  return (
    <div className="msp-tile" role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item); }}>
      <Art src={item.image} style={liked ? { background: 'linear-gradient(135deg, rgb(var(--accent-rgb)), rgba(var(--accent-rgb),0.25))' } : null}>
        {liked ? (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-ink)' }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2.1 0 3.6 1.2 4.4 2.4C11.8 6.2 13.3 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z" /></svg>
          </span>
        ) : null}
        <button type="button" className="msp-playfab" aria-label={`Play ${item.name}`}
          onClick={(e) => { e.stopPropagation(); onPlay(item); }}>{Icon.play(15)}</button>
      </Art>
      <span style={{ minWidth: 0 }}>
        <span className="nm" style={{ display: 'block' }}>{item.name}</span>
        <span className="sb" style={{ display: 'block' }}>{item.sub}</span>
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- New Releases */

const FILTERS = [['all', 'All'], ['album', 'Albums'], ['single', 'Singles & EPs']];
const isAlbum = (r) => r.type === 'album' || r.type === 'compilation';

/* Day buckets, newest first: the page reads like a library sorted by date,
   with a label wherever the day changes. */
function bucketOf(dateStr) {
  const d = daysSince(dateStr);
  if (d === 0) return ['today', 'Today'];
  if (d === 1) return ['yesterday', 'Yesterday'];
  if (d < 7) return ['week', 'Earlier this week'];
  if (d < 14) return ['last', 'Last week'];
  if (d < 31) return ['month', 'Earlier this month'];
  return ['older', 'Last month'];
}

function ReleasesSkeleton() {
  return (
    <div className="msp-rtable">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="msp-rrow" style={{ cursor: 'default' }}>
          <span />
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="msp-sk" style={{ width: 40, height: 40, borderRadius: 6, flexShrink: 0 }} />
            <span className="msp-sk" style={{ height: 12, width: `${40 + ((i * 17) % 35)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/* Tracklists opened inline, kept for the session. */
const tracksCache = new Map();

/** A release's songs, opened under its row. */
function ReleaseTracks({ release, bridge, context }) {
  const [rows, setRows] = useState(() => tracksCache.get(release.albumId) || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (tracksCache.has(release.albumId)) return undefined;
    let live = true;
    loadCollection(context).then((r) => {
      tracksCache.set(release.albumId, r || []);
      if (live) setRows(r || []);
    }, (e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [release.albumId, context]);

  const total = (rows || []).reduce((n, r) => n + (r.durationMs || 0), 0);
  const unsaved = (rows || []).filter((r) => !bridge.saveState(r));
  return (
    <div className="msp-rexp">
      <div className="msp-rexp-bar">
        <button type="button" className="msp-act is-primary is-sm" disabled={!rows?.length}
          onClick={() => bridge.playRows(rows, 0, { context })}>{Icon.play(11)} Play</button>
        <button type="button" className="msp-act is-sm" disabled={!rows?.length}
          onClick={() => bridge.playRows(rows, 0, { shuffle: true, context })}>{Icon.shuffle(13)} Shuffle</button>
        {unsaved.length > 1 ? (
          <button type="button" className="msp-act is-sm" onClick={() => unsaved.forEach((r) => bridge.saveRow(r))}>{Icon.plus(12)} Save all</button>
        ) : null}
        <span className="msp-grow" />
        {rows?.length ? <span className="msp-lhead-m">{rows.length} song{rows.length === 1 ? '' : 's'} · {Math.max(1, Math.round(total / 60000))} min</span> : null}
      </div>
      {err ? <div className="msp-banner">{err}</div> : null}
      {!rows && !err ? Array.from({ length: Math.min(6, release.totalTracks || 4) }, (_, i) => <div key={i} className="msp-sk" style={{ height: 30, margin: '6px 0' }} />) : null}
      {(rows || []).map((r, i) => {
        const on = bridge.isCurrent(r);
        return (
          <div key={`${r.spotifyId}:${i}`} className={cx('msp-trow', on && 'on')} role="button" tabIndex={0}
            onClick={() => bridge.playRows(rows, i, { context })}
            onKeyDown={(e) => { if (e.key === 'Enter') bridge.playRows(rows, i, { context }); }}
            {...bridge.hoverProps(r)}>
            <span className="n">{on && bridge.isPlaying ? <Bars /> : <><span className="num">{i + 1}</span><span className="pl">{Icon.play(11)}</span></>}</span>
            <span className="tt">
              <span className="t">{r.explicit ? <span className="e">E</span> : null}{r.title}</span>
              {r.artists && r.artists !== release.artists ? <span className="a">{r.artists}</span> : null}
            </span>
            <span className="d">{fmtDur(r.durationMs)}</span>
            <SaveButton state={bridge.saveState(r)} onSave={() => bridge.saveRow(r)} />
          </div>
        );
      })}
    </div>
  );
}

/* ---- Following: who New Releases checks ------------------------------- */

/** One artist in the Following manager. */
function FollowChip({ a, tag, hidden = false, action, onOpen }) {
  return (
    <div className={cx('msp-chip', hidden && 'is-hidden')}>
      <button type="button" className="who" onClick={onOpen} title={a.name}>
        <Art src={a.image} round />
        <span style={{ minWidth: 0 }}>
          <span className="nm">{a.name}</span>
          {tag ? <span className="tag">{tag}</span> : null}
        </span>
      </button>
      {action}
    </div>
  );
}

/**
 * Inline under the header, not a panel: search to follow in Studio, the
 * artists you follow in Studio (unfollow), and the ones followed on Spotify
 * (hide from this page; Spotify itself isn't changed). The search box also
 * filters both lists.
 */
function FollowingManager({ bridge, follows, spotifyArtists, hidden, onClose }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setHits([]); setBusy(false); return undefined; }
    setBusy(true);
    const t = setTimeout(async () => {
      const rows = await window.electronAPI?.spotifySearchArtists?.(query).catch(() => []);
      setHits((rows || []).filter((a) => /^[0-9A-Za-z]{22}$/.test(a.id || '')).slice(0, 6));
      setBusy(false);
    }, 320);
    return () => clearTimeout(t);
  }, [q]);

  const needle = q.trim().toLowerCase();
  const match = (a) => !needle || String(a.name || '').toLowerCase().includes(needle);
  const hiddenIds = new Set(hidden.map((a) => a.id));
  const inStudio = follows.filter(match);
  const onSpotify = spotifyArtists.filter(match);
  const open = (a) => bridge.onOpenArtist?.({ name: a.name, spotifyId: a.id, image: a.image });

  return (
    <section className="msp-fm" aria-label="Following">
      <div className="msp-fm-top">
        <label className="msp-well">
          {Icon.search(14)}
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an artist to follow"
            onKeyDown={(e) => { if (e.key === 'Escape') { if (q) setQ(''); else onClose(); } }} />
          {q ? <button type="button" className="msp-well-x" onClick={() => setQ('')} aria-label="Clear">{Icon.close(10)}</button> : null}
        </label>
        <span className="msp-fm-note">Following here is Studio’s own. Nothing changes on Spotify.</span>
        <button type="button" className="st-icon-btn is-sm" onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto' }}>{Icon.close(13)}</button>
      </div>

      {needle.length >= 2 ? (
        <div className="msp-fm-group">
          <div className="msp-fm-h">On Spotify{busy ? <span>Searching…</span> : null}</div>
          <div className="msp-chips">
            {!busy && !hits.length ? <div className="msp-fm-empty">No artists match “{q.trim()}”.</div> : null}
            {hits.map((a) => {
              const on = isStudioFollowed(a, follows);
              return (
                <FollowChip key={a.id} a={a} onOpen={() => open(a)}
                  tag={on ? 'Following in Studio' : spotifyArtists.some((x) => x.id === a.id) ? 'Followed on Spotify' : 'Artist'}
                  action={(
                    <button type="button" className={cx('msp-chip-btn', !on && 'is-accent')}
                      onClick={() => (on ? unfollowArtist(a) : followArtist({ id: a.id, name: a.name, image: a.image }))}>
                      {on ? 'Unfollow' : <>{Icon.plus(11)} Follow</>}
                    </button>
                  )} />
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="msp-fm-group">
        <div className="msp-fm-h">In Studio<span>{follows.length}</span></div>
        <div className="msp-chips">
          {inStudio.map((a) => (
            <FollowChip key={a.id} a={a} onOpen={() => open(a)} tag={a.at ? `Since ${new Date(a.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : null}
              action={<button type="button" className="msp-chip-btn" onClick={() => unfollowArtist(a)}>Unfollow</button>} />
          ))}
          {!follows.length ? <div className="msp-fm-empty">No one yet. Search above, or press Follow on any artist’s page.</div> : null}
          {follows.length && !inStudio.length ? <div className="msp-fm-empty">No one here matches.</div> : null}
        </div>
      </div>

      {spotifyArtists.length ? (
        <div className="msp-fm-group">
          <div className="msp-fm-h">
            On Spotify<span>{spotifyArtists.length}{hidden.length ? ` · ${spotifyArtists.filter((a) => hiddenIds.has(a.id)).length} hidden` : ''}</span>
          </div>
          <div className="msp-chips">
            {onSpotify.map((a) => {
              const off = hiddenIds.has(a.id);
              return (
                <FollowChip key={a.id} a={a} hidden={off} onOpen={() => open(a)} tag={off ? 'Hidden here' : null}
                  action={(
                    <button type="button" className={cx('msp-chip-btn', off && 'is-on')}
                      title={off ? 'Show their releases again' : 'Leave their releases out of this page (Spotify isn’t changed)'}
                      onClick={() => setArtistHidden(a, !off)}>
                      {off ? 'Show' : 'Hide'}
                    </button>
                  )} />
              );
            })}
            {!onSpotify.length ? <div className="msp-fm-empty">No one here matches.</div> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SpotifyReleases({ bridge }) {
  const { data, error, loading, refresh, limitedUntil } = useFeed('releases');
  const follows = useStudioFollows();
  const hidden = useHiddenArtists();
  const [manage, setManage] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState(() => { try { return localStorage.getItem('studio:releasesFilter') || 'all'; } catch { return 'all'; } });
  const pickFilter = (f) => { setFilter(f); try { localStorage.setItem('studio:releasesFilter', f); } catch { /* ignore */ } };

  /* Who's checked. The last check lists every artist it looked at; your
     Studio follows and Spotify follows (less the hidden ones) decide which
     of their releases show, so unfollowing or hiding is instant. */
  const followIds = useMemo(() => new Set(follows.map((a) => a.id)), [follows]);
  const hiddenIds = useMemo(() => new Set(hidden.map((a) => a.id)), [hidden]);
  const checked = data?.artists || null;
  const spotifyArtists = useMemo(() => (checked || [])
    .filter((a) => (a.onSpotify ?? a.source === 'spotify') && !followIds.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name)), [checked, followIds]);
  const active = useMemo(() => {
    const ids = new Set(followIds);
    for (const a of spotifyArtists) if (!hiddenIds.has(a.id)) ids.add(a.id);
    return ids;
  }, [followIds, spotifyArtists, hiddenIds]);

  /* Following someone new needs a check for their releases; unfollowing
     doesn't (the list just filters). Once per change, a moment after it. */
  const followKey = follows.map((a) => a.id).join(',');
  const checkedFor = useRef(followKey);
  useEffect(() => {
    if (!data || checkedFor.current === followKey) return undefined;
    const known = new Set((checked || []).map((a) => a.id));
    if (!follows.some((a) => !known.has(a.id))) { checkedFor.current = followKey; return undefined; }
    const t = setTimeout(() => { checkedFor.current = followKey; refresh(); }, 1200);
    return () => clearTimeout(t);
  }, [followKey, data, checked, follows, refresh]);

  const all = useMemo(() => {
    const list = data?.releases || [];
    if (!checked) return list;   // an older check without its artist list
    const byChecked = new Set(checked.map((a) => a.id));
    return list.filter((r) => {
      const ids = r.artistIds || [];
      return ids.some((id) => active.has(id)) || !ids.some((id) => byChecked.has(id));
    });
  }, [data, checked, active]);
  const counts = useMemo(() => ({
    all: all.length, album: all.filter(isAlbum).length, single: all.filter((r) => r.type === 'single').length,
  }), [all]);
  const releases = useMemo(() => all.filter((r) => (filter === 'all' ? true : filter === 'album' ? isAlbum(r) : r.type === 'single')), [all, filter]);
  const groups = useMemo(() => {
    const out = [];
    for (const r of releases) {
      const [k, label] = bucketOf(r.releaseDate);
      let g = out.find((x) => x.key === k);
      if (!g) { g = { key: k, label, items: [] }; out.push(g); }
      g.items.push(r);
    }
    return out;
  }, [releases]);

  const asItem = useCallback((r) => ({ kind: 'album', id: r.albumId, name: r.name, sub: `${typeLabel(r)} · ${r.artists}`, image: r.albumArtUrl || r.thumbUrl, label: typeLabel(r) }), []);
  const play = async (r) => {
    const it = asItem(r);
    try {
      const rows = tracksCache.get(r.albumId) || await loadCollection(it);
      tracksCache.set(r.albumId, rows || []);
      if (rows?.length) bridge.playRows(rows, 0, { context: it });
    } catch { setOpenId(r.albumId); }
  };
  const openArtist = (r, i) => {
    const names = String(r.artists || '').split(', ');
    bridge.onOpenArtist?.({ name: names[i] || names[0], spotifyId: r.artistIds?.[i] || r.artistIds?.[0] });
  };
  const followingCount = checked ? active.size : follows.length;

  let n = 0;
  return (
    <div className="msp-root">
      <style>{CSS}</style>
      <div className="msp-scroll">
        <div className="msp-wrap is-tight">
          <header className="msp-lhead">
            <div className="msp-lhead-tw">
              <span className="msp-lhead-t">New Releases</span>
              <span className="msp-lhead-m">
                {data ? `${all.length} release${all.length === 1 ? '' : 's'} in the last ${data.windowDays} days from ${followingCount} artist${followingCount === 1 ? '' : 's'}` : 'From the artists you follow, in Studio and on Spotify'}
              </span>
            </div>
            <div className="msp-lhead-r2">
              {FILTERS.map(([id, label]) => (
                <button key={id} type="button" className={cx('msp-act', filter === id && 'is-on')} aria-pressed={filter === id} onClick={() => pickFilter(id)}>
                  {label}{data ? <span className="ct">{counts[id]}</span> : null}
                </button>
              ))}
              <span className="msp-sep" />
              <button type="button" className={cx('msp-act', manage && 'is-on')} aria-expanded={manage} onClick={() => setManage((v) => !v)}>
                {Icon.people(14)} <span className="msp-act-label">Following</span><span className="ct">{followingCount}</span>
              </button>
              <span className="msp-grow" />
              <RefreshButton loading={loading} onClick={refresh} at={data?.fetchedAt} label="Checked" />
            </div>
          </header>

          {manage ? (
            <FollowingManager bridge={bridge} follows={follows} spotifyArtists={spotifyArtists} hidden={hidden} onClose={() => setManage(false)} />
          ) : null}

          {data && limitedUntil ? <LimitBanner until={limitedUntil} /> : null}
          {data?.partial && !(limitedUntil > Date.now()) ? <div className="msp-banner">Spotify slowed Studio down part way, so {data.artistsTotal - data.artistsChecked} artists weren’t checked this time. Refresh to fill them in.</div> : null}
          {error && data && error.step !== 'ratelimit' ? <div className="msp-banner">Showing the last check. {error.error || ''}</div> : null}
          {error && !data ? <FeedError error={error} onRetry={refresh} onConnect={bridge.onConnect} /> : null}
          {!data && !error ? <ReleasesSkeleton /> : null}

          {data && !releases.length ? (
            <Note icon={Icon.spark(24)} title={filter === 'all' ? 'Nothing new yet' : 'Nothing of this kind'}
              body={filter === 'all'
                ? `None of the artists you follow has released anything in the last ${data.windowDays} days. Follow more and their new music shows up here.`
                : 'Try another filter.'}
              action={filter === 'all' && !manage ? <button type="button" className="st-btn st-btn-primary" onClick={() => setManage(true)}>Follow artists</button> : null} />
          ) : null}

          {groups.length ? (
            <div className="msp-rtable">
              <div className="msp-rrow msp-rhead">
                <span>#</span><span>Title</span><span className="c-type">Type</span><span className="c-tracks">Songs</span><span className="c-date">Released</span><span />
              </div>
              {groups.map((g) => (
                <React.Fragment key={g.key}>
                  <div className="msp-rgroup">{g.label}<span>{g.items.length}</span></div>
                  {g.items.map((r) => {
                    n += 1;
                    const it = asItem(r);
                    const isOpen = openId === r.albumId;
                    const playing = bridge.isPlaying && (tracksCache.get(r.albumId) || []).some((x) => bridge.isCurrent(x));
                    const artists = String(r.artists || '').split(', ');
                    return (
                      <React.Fragment key={r.albumId}>
                        <div className={cx('msp-rrow', isOpen && 'is-open')} role="button" tabIndex={0} aria-expanded={isOpen}
                          onClick={() => setOpenId(isOpen ? null : r.albumId)}
                          onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(isOpen ? null : r.albumId); }}>
                          <span className="msp-rn">
                            <span className="num">{playing ? <Bars /> : n}</span>
                            <button type="button" className="pl" aria-label={`Play ${r.name}`} onClick={(e) => { e.stopPropagation(); play(r); }}>{Icon.play(13)}</button>
                          </span>
                          <span className="msp-rtitle">
                            <Art src={r.thumbUrl || r.albumArtUrl} />
                            <span style={{ minWidth: 0 }}>
                              <span className="t">
                                {r.name}
                                {daysSince(r.releaseDate) <= 3 ? <span className="st-badge-new msp-newtag">NEW</span> : null}
                              </span>
                              <span className="a">
                                {artists.map((nm, i) => (
                                  <React.Fragment key={`${nm}:${i}`}>
                                    {i ? ', ' : ''}
                                    <button type="button" className="msp-link" onClick={(e) => { e.stopPropagation(); openArtist(r, i); }}>{nm}</button>
                                  </React.Fragment>
                                ))}
                              </span>
                            </span>
                          </span>
                          <span className="msp-dim c-type">{typeLabel(r)}</span>
                          <span className="msp-dim c-tracks">{r.totalTracks || '—'}</span>
                          <span className="msp-dim c-date" title={r.releaseDate}>{releaseDay(r.releaseDate)}</span>
                          <span className="msp-rchev" aria-hidden>{Icon.chevron(14)}</span>
                        </div>
                        {isOpen ? <ReleaseTracks release={r} bridge={bridge} context={it} /> : null}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
