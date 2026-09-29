/* =========================================================================
 *  studio — My Spotify: Home and New Releases
 *
 *  The two pages under "My Spotify" in the sidebar. Everything on them comes
 *  from the signed-in Spotify account (spotifyFeed.js in main) and plays
 *  through the studio-spotify helper, with nothing to download: a row plays
 *  straight away, and Save adds it to the library (and hearts it on Spotify).
 *
 *  Home is about you: a greeting, what's in rotation this month, where you
 *  left off, what you've played lately, your artists, playlists and albums.
 *  New Releases is about them: a spotlight on the newest record from the
 *  artists you follow and play, then a timeline of everything from the last
 *  two months, week by week.
 *
 *  Any collection (an album, a playlist, Liked Songs, an artist's top songs)
 *  opens in a panel that slides over the page's right edge, so you never
 *  lose your place in the feed.
 *
 *  StudioHome supplies the bridge (props below): turning rows into playable
 *  tracks, Save and its state, opening an artist page.
 * ========================================================================= */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudioFollows, isStudioFollowed, followArtist, unfollowArtist } from './studioFollows.js';

/* ------------------------------------------------------------------ data */

const feedCache = {};   // key → { data, error }, survives page switches

function useFeed(key) {
  const [state, setState] = useState(() => feedCache[key] || { data: null, error: null });
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again, and a
  // flag only ever cleared left the page on its skeleton for good.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (force) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const fetcher = { home: api?.spotifyFeedHome, releases: api?.spotifyFeedReleases, extras: api?.spotifyFeedExtras }[key];
    if (!fetcher) { setState({ data: null, error: { step: 'unavailable', error: 'Spotify isn’t available in this build.' } }); return; }
    setLoading(true);
    // Paint last session's copy while the fresh one is fetched.
    if (!feedCache[key]?.data && api.spotifyFeedPeek) {
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
  useEffect(() => {
    if (!limitedUntil) return undefined;
    const wait = limitedUntil - Date.now();
    if (wait > 30 * 60 * 1000) return undefined;
    const t = setTimeout(() => load(false), Math.max(1500, wait + 1500));
    return () => clearTimeout(t);
  }, [limitedUntil, load]);

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
};

function Bars() {
  return <span className="msp-bars" aria-label="Playing"><i /><i /><i /></span>;
}

/* ----------------------------------------------------------------- style */

const CSS = `
.msp-root { position: absolute; inset: 0; overflow: hidden; }
.msp-scroll { position: absolute; inset: 0; overflow-y: auto; scrollbar-width: thin; padding: 30px 32px 48px; }
.msp-wrap { max-width: 1320px; margin: 0 auto; display: flex; flex-direction: column; gap: 34px; }
.msp-head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.msp-head h1 { margin: 4px 0 0; }
.msp-head-side { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.msp-updated { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; }
.msp-sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.msp-sec-h { display: flex; align-items: baseline; gap: 10px; }
.msp-sec-h .st-section-title { font-size: 18px; }
.msp-sec-h .st-meta { font-size: 12px; }
.msp-sec-h .msp-more { margin-left: auto; }

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

/* hero (Home) */
.msp-hero { position: relative; border-radius: 20px; overflow: hidden; min-height: 236px; display: flex; align-items: center;
  gap: 34px; padding: 30px 34px; border: 1px solid var(--border); isolation: isolate; }
.msp-hero-bg { position: absolute; inset: -40px; z-index: -2; background-size: cover; background-position: center;
  filter: blur(46px) saturate(1.4) brightness(0.55); transform: scale(1.1); }
.msp-hero::after { content: ''; position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(90deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.7) 100%); }
.msp-fan { position: relative; width: 200px; height: 176px; flex-shrink: 0; }
.msp-fan .msp-art { position: absolute; width: 140px; height: 140px; top: 18px; box-shadow: 0 16px 40px rgba(0,0,0,0.5);
  transform: translateX(0) rotate(var(--r, 0deg)); transition: transform 0.45s cubic-bezier(0.22,1,0.36,1); }
/* The fan opens on hover. */
.msp-hero:hover .msp-fan .msp-art { transform: translateX(var(--dx, 0px)) rotate(calc(var(--r, 0deg) * 2.2)); }
.msp-hero-copy { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.msp-hero-copy .st-eyebrow { color: rgba(255,255,255,0.72); }
.msp-hero-title { font-size: 34px; font-weight: 800; letter-spacing: -0.025em; color: #fff; line-height: 1.05; }
.msp-hero-sub { font-size: 13.5px; color: rgba(255,255,255,0.72); line-height: 1.5; max-width: 560px; }
.msp-hero-actions { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.msp-hero-stats { margin-left: auto; align-self: stretch; display: flex; flex-direction: column; justify-content: center; gap: 14px;
  padding-left: 28px; border-left: 1px solid rgba(255,255,255,0.14); }
.msp-stat b { display: block; font-size: 22px; font-weight: 800; color: #fff; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.msp-stat span { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 0.08em; }
.msp-btn-glass { background: rgba(255,255,255,0.12); color: #fff; }
.msp-btn-glass:hover { background: rgba(255,255,255,0.2); }

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
@media (max-width: 1100px) { .msp-duo { grid-template-columns: minmax(0, 1fr); } .msp-hero-stats { display: none; } }
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
.msp-rank { position: absolute; left: 8px; top: 8px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(6px); }

/* new releases */
.msp-spot { position: relative; display: flex; gap: 30px; padding: 28px; border-radius: 22px; overflow: hidden; isolation: isolate;
  border: 1px solid var(--border); align-items: center; }
.msp-spot-bg { position: absolute; inset: -60px; z-index: -2; background-size: cover; background-position: center;
  filter: blur(60px) saturate(1.5) brightness(0.5); }
.msp-spot::after { content: ''; position: absolute; inset: 0; z-index: -1; background: radial-gradient(120% 140% at 0% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 70%); }
.msp-spot .msp-art { width: 232px; height: 232px; border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,0.55); cursor: pointer; }
.msp-spot-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.msp-spot-title { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.02; color: #fff;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.msp-spot-artist { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.88); background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; text-align: left; }
.msp-spot-artist:hover { text-decoration: underline; text-underline-offset: 3px; }
.msp-spot-meta { font-size: 12.5px; color: rgba(255,255,255,0.62); }
.msp-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; width: fit-content;
  font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; background: rgba(255,255,255,0.14); color: #fff; }
.msp-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-line); box-shadow: 0 0 10px var(--accent-line); }
.msp-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.msp-controls .st-segs { width: auto; }
.msp-controls .st-segs button { padding: 0 14px; }
.msp-timeline { display: flex; flex-direction: column; gap: 30px; }
.msp-week { display: grid; grid-template-columns: 124px minmax(0, 1fr); gap: 22px; }
.msp-week-label { position: sticky; top: 0; align-self: start; padding-top: 2px; }
.msp-week-label b { display: block; font-size: 15px; font-weight: 800; color: var(--text); letter-spacing: -0.01em; }
.msp-week-label span { font-size: 11.5px; color: var(--text-faint); }
.msp-week-label::before { content: ''; display: block; width: 22px; height: 3px; border-radius: 2px; background: var(--accent-line); margin-bottom: 10px; }
@media (max-width: 900px) { .msp-week { grid-template-columns: minmax(0, 1fr); } .msp-week-label { position: static; } .msp-spot .msp-art { width: 160px; height: 160px; } .msp-spot-title { font-size: 28px; } }
.msp-new { position: absolute; left: 8px; top: 8px; }
.msp-fhead { display: flex; gap: 12px; align-items: flex-start; padding: 20px 16px 12px 20px; }
.msp-fhead .ttl { display: block; font-size: 21px; font-weight: 800; color: var(--text); letter-spacing: -0.015em; }
.msp-fhead .sub { display: block; font-size: 12.5px; color: var(--text-faint); line-height: 1.5; margin-top: 4px; }
.msp-fsearch { padding: 0 20px 8px; }
.msp-fsearch .st-input { box-sizing: border-box; }
.msp-fsec { display: flex; flex-direction: column; gap: 2px; padding-bottom: 8px; }
.msp-frow { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 10px; }
.msp-frow:hover { background: rgba(255,255,255,0.04); }
.msp-frow-who { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; background: none; border: none; padding: 0; cursor: pointer; font: inherit; color: inherit; text-align: left; }
.msp-frow-who .nm { font-size: 13.5px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
.msp-panel .msp-row { grid-template-columns: 26px minmax(0, 1fr) auto auto; }
@media (prefers-reduced-motion: reduce) { .msp-panel, .msp-scrim, .msp-bars i, .msp-sk { animation: none !important; } }
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
function TrackRow({ row, n, meta, list, index, bridge, showArt = true }) {
  const on = bridge.isCurrent(row);
  return (
    <div className={cx('msp-row', on && 'on')} role="button" tabIndex={0}
      onClick={() => bridge.playRows(list, index)}
      onKeyDown={(e) => { if (e.key === 'Enter') bridge.playRows(list, index); }}
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

function SectionHead({ title, meta, children }) {
  return (
    <div className="msp-sec-h">
      <span className="st-section-title">{title}</span>
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
          {item.kind === 'liked' ? <LikedArt size={40} /> : <Art src={item.image} round={item.kind === 'artist'} />}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 2 }}>
            <span className="st-eyebrow" style={{ color: 'rgba(255,255,255,0.65)' }}>
              {item.kind === 'artist' ? 'Top songs' : item.kind === 'liked' ? 'Collection' : item.label || item.kind}
            </span>
            <span className="ttl">{item.name}</span>
            <span className="sub">
              {item.kind === 'liked'
                ? `${item.sub || ''}${rows?.length && item.count > rows.length ? ` · newest ${rows.length} here` : ''}`
                : `${item.sub || ''}${rows?.length ? ` · ${rows.length} songs · ${Math.round(total / 60000)} min` : ''}`}
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={!rows?.length}
                onClick={() => bridge.playRows(rows, 0)}>{Icon.play(12)} Play</button>
              <button type="button" className="st-btn st-btn-sm msp-btn-glass" disabled={!rows?.length}
                onClick={() => bridge.playRows(rows, 0, { shuffle: true })}>{Icon.shuffle(13)} Shuffle</button>
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
              showArt={false} meta={fmtDur(r.durationMs)} />
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

/* Spotify home shelves Studio leaves out: its new-releases shelf (hit and
   miss about which artists it shows; New Releases does that job) and the
   albums-featuring-songs-you-like one. */
const HIDDEN_SHELVES = /new release|albums? featuring songs you like/i;

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

export function SpotifyHome({ bridge }) {
  const { data: core, error, loading, refresh, limitedUntil } = useFeed('home');
  // What only the Web API has: optional, shown when it comes.
  const { data: extra, refresh: refreshExtras } = useFeed('extras');
  const [panel, openPanel, closePanel] = usePanel();

  /* One view of both. The core (Spotify's home feed and Your Library) is
     the page; the extras (on repeat, recently played, all time, top
     artists) slot in when the Web API isn't rate-limiting. */
  const data = core ? {
    ...core,
    user: { name: extra?.user?.name || core.user?.name || '', image: extra?.user?.image || null },
    onRepeat: extra?.onRepeat || [],
    recentTracks: extra?.recentTracks || [],
    allTime: extra?.allTime || [],
    topArtists: extra?.topArtists?.length ? extra.topArtists : (core.artists || []).map((a) => ({ id: a.id, name: a.name, image: a.image, genres: [] })),
    jumpBackIn: core.recents || [],
    savedAlbums: core.albums || [],
    likedCount: core.liked?.count ?? null,
  } : null;

  const name = data?.user?.name ? data.user.name.split(' ')[0] : '';
  const refreshAll = () => { refresh(); refreshExtras(); };

  const openItem = (it) => {
    if (it.kind === 'artist' && bridge.onOpenArtist) { bridge.onOpenArtist({ name: it.name, spotifyId: it.id, image: it.image }); return; }
    openPanel(it);
  };
  const playItem = async (it) => {
    try { const rows = await loadCollection(it); if (rows?.length) bridge.playRows(rows, 0); } catch { openPanel(it); }
  };

  return (
    <div className="msp-root">
      <style>{CSS}</style>
      <div className="msp-scroll">
        <div className="msp-wrap">
          <header className="msp-head">
            <div>
              <span className="st-eyebrow">My Spotify</span>
              <h1 className="st-page-title">{greeting()}{name ? `, ${name}` : ''}</h1>
            </div>
            <div className="msp-head-side">
              <RefreshButton loading={loading} onClick={refreshAll} at={data?.fetchedAt} />
              {data?.user?.image ? <Art src={data.user.image} round style={{ width: 34, height: 34 }} /> : null}
            </div>
          </header>

          {data && limitedUntil ? <LimitBanner until={limitedUntil} /> : null}
          {error && data && error.step !== 'ratelimit' ? <div className="msp-banner">Showing what Studio saw last time. {error.error || ''}</div> : null}
          {error && !data ? <FeedError error={error} onRetry={refresh} onConnect={bridge.onConnect} /> : null}
          {!data && !error ? <HomeSkeleton /> : null}

          {data ? (
            <>
              {/* ---- Jump back in ---- */}
              {data.jumpBackIn?.length ? (
                <section className="msp-sec">
                  <SectionHead title="Jump back in" meta="Where you left off" />
                  <div className="msp-jump">
                    {data.jumpBackIn.slice(0, 8).map((it) => (
                      <div key={`${it.kind}:${it.id}`} className="msp-jumptile" role="button" tabIndex={0}
                        onClick={() => openItem(it)} onKeyDown={(e) => { if (e.key === 'Enter') openItem(it); }}>
                        {it.kind === 'liked' ? <LikedArt size={24} /> : <Art src={it.image} />}
                        <span style={{ minWidth: 0 }}>
                          <span className="nm" style={{ display: 'block' }}>{it.name}</span>
                          <span className="sb" style={{ display: 'block' }}>{it.sub}</span>
                        </span>
                        <button type="button" className="go" aria-label={`Play ${it.name}`} style={{ border: 'none', cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); playItem(it); }}>{Icon.play(13)}</button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---- On repeat / Recently played ---- */}
              {data.onRepeat?.length || data.recentTracks?.length ? (
                <div className="msp-duo">
                  <section className="msp-sec">
                    <SectionHead title="On repeat" meta="Last four weeks" />
                    <div className="msp-list">
                      {data.onRepeat.slice(0, 10).map((t, i) => (
                        <TrackRow key={t.spotifyId} row={t} n={i + 1} list={data.onRepeat} index={i} bridge={bridge} meta={fmtDur(t.durationMs)} />
                      ))}
                    </div>
                  </section>
                  <section className="msp-sec">
                    <SectionHead title="Recently played" />
                    <div className="msp-list">
                      {data.recentTracks.slice(0, 10).map((t, i) => (
                        <TrackRow key={`${t.spotifyId}:${t.playedAt}`} row={t} n={<span style={{ fontSize: 10 }}>•</span>} list={data.recentTracks} index={i} bridge={bridge} meta={ago(t.playedAt)} />
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}

              {/* ---- Spotify's own shelves (Made For You, mixes…) ---- */}
              {(data.shelves || []).filter((sh) => !HIDDEN_SHELVES.test(sh.title || '')).map((sh, n) => (
                <section key={`${sh.title}:${n}`} className="msp-sec">
                  <SectionHead title={sh.title || 'For you'} />
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

              {/* ---- Artists ---- */}
              {data.topArtists?.length ? (
                <section className="msp-sec">
                  <SectionHead title={extra?.topArtists?.length ? 'Your artists right now' : 'Artists you follow'} />
                  <div className="msp-grid is-small is-clip">
                    {data.topArtists.map((a) => (
                      <button key={a.id} type="button" className="msp-tile is-artist"
                        onClick={() => bridge.onOpenArtist?.({ name: a.name, spotifyId: a.id, image: a.image })}>
                        <Art src={a.image} round />
                        <span style={{ minWidth: 0, width: '100%' }}>
                          <span className="nm" style={{ display: 'block' }}>{a.name}</span>
                          <span className="sb" style={{ display: 'block' }}>{a.genres?.[0] || 'Artist'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---- Playlists ---- */}
              {data.playlists?.length ? (
                <section className="msp-sec">
                  <SectionHead title="Your playlists" meta={data.likedCount ? `${data.likedCount.toLocaleString()} liked songs` : null} />
                  <div className="msp-grid is-clip" style={{ '--rows': 3 }}>
                    {data.liked ? (
                      <CoverTile item={{ ...data.liked, image: null }} onOpen={openItem} onPlay={playItem} liked />
                    ) : null}
                    {data.playlists.map((p) => <CoverTile key={p.id} item={p} onOpen={openItem} onPlay={playItem} />)}
                  </div>
                </section>
              ) : null}

              {/* ---- Saved albums ---- */}
              {data.savedAlbums?.length ? (
                <section className="msp-sec">
                  <SectionHead title="Albums in your library" meta="Most recently played first" />
                  <div className="msp-grid is-clip" style={{ '--rows': 2 }}>
                    {data.savedAlbums.map((a) => (
                      <CoverTile key={a.id} item={a} onOpen={openItem} onPlay={playItem} />
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---- All time ---- */}
              {data.allTime?.length ? (
                <section className="msp-sec">
                  <SectionHead title="Forever favourites" meta="Your most played, all time" />
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
                          <span className="sb" style={{ display: 'block' }}>{t.artists}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {!data.onRepeat?.length && !data.jumpBackIn?.length && !data.shelves?.length && !data.playlists?.length ? (
                <Note icon={Icon.spotify(24)} title="Nothing here yet"
                  body="Play some music on Spotify (here or anywhere) and this page fills in with your rotation, artists and playlists." />
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

function bucketOf(dateStr) {
  const d = daysSince(dateStr);
  if (d < 7) return ['week', 'This week'];
  if (d < 14) return ['last', 'Last week'];
  if (d < 31) return ['month', 'Earlier this month'];
  return ['older', 'Last two months'];
}

function ReleasesSkeleton() {
  return (
    <>
      <div className="msp-sk" style={{ height: 290, borderRadius: 22 }} />
      <div className="msp-grid">{Array.from({ length: 10 }, (_, i) => <div key={i}><div className="msp-sk" style={{ aspectRatio: '1', borderRadius: 8 }} /><div className="msp-sk" style={{ height: 12, marginTop: 10, width: '70%' }} /></div>)}</div>
    </>
  );
}

/* ---- Following: artists followed in Studio (studioFollows.js) ---- */

function FollowPanel({ bridge, onClose }) {
  const follows = useStudioFollows();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setHits([]); return undefined; }
    const t = setTimeout(async () => {
      setBusy(true);
      const rows = await window.electronAPI?.spotifySearchArtists?.(query).catch(() => []);
      setHits((rows || []).filter((a) => /^[0-9A-Za-z]{22}$/.test(a.id || '')).slice(0, 8));
      setBusy(false);
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const toggle = async (a) => {
    if (isStudioFollowed(a, follows)) await unfollowArtist(a);
    else await followArtist({ id: a.id, name: a.name, image: a.image });
  };
  const Row = ({ a }) => {
    const on = isStudioFollowed(a, follows);
    return (
      <div className="msp-frow">
        <button type="button" className="msp-frow-who" onClick={() => bridge.onOpenArtist?.({ name: a.name, spotifyId: a.id, image: a.image })}>
          <Art src={a.image} round style={{ width: 40, height: 40 }} />
          <span className="nm">{a.name}</span>
        </button>
        <button type="button" className={cx('st-btn st-btn-sm', on ? 'st-btn-outline' : 'st-btn-primary')} onClick={() => toggle(a)}>
          {on ? 'Following' : 'Follow'}
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="msp-scrim" onClick={onClose} />
      <aside className="msp-panel" aria-label="Following">
        <div className="msp-fhead">
          <div>
            <span className="ttl">Following</span>
            <span className="sub">Artists you follow here are Studio’s own; nothing changes on Spotify. Their new albums and singles show up in New Releases, along with the artists you follow on Spotify.</span>
          </div>
          <button type="button" className="st-icon-btn is-sm" onClick={onClose} aria-label="Close">{Icon.close(14)}</button>
        </div>
        <div className="msp-fsearch">
          <input ref={inputRef} className="st-input" placeholder="Search for an artist to follow" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="msp-panel-body">
          {q.trim().length >= 2 ? (
            <div className="msp-fsec">
              {busy && !hits.length ? <div className="st-meta" style={{ padding: '8px 10px' }}>Searching…</div> : null}
              {!busy && !hits.length ? <div className="st-meta" style={{ padding: '8px 10px' }}>No artists match “{q.trim()}”.</div> : null}
              {hits.map((a) => <Row key={a.id} a={a} />)}
            </div>
          ) : null}
          <div className="msp-fsec">
            <span className="st-eyebrow" style={{ padding: '10px 10px 4px', display: 'block' }}>Following in Studio{follows.length ? ` · ${follows.length}` : ''}</span>
            {follows.length
              ? follows.map((a) => <Row key={a.id} a={a} />)
              : <div className="st-meta" style={{ padding: '4px 10px 10px', lineHeight: 1.5 }}>No one yet. Search above, or use Follow on any artist’s page.</div>}
          </div>
        </div>
      </aside>
    </>
  );
}

export function SpotifyReleases({ bridge }) {
  const { data, error, loading, refresh, limitedUntil } = useFeed('releases');
  const [panel, openPanel, closePanel] = usePanel();
  const follows = useStudioFollows();
  const [following, setFollowing] = useState(false);
  const followKey = follows.map((a) => a.id).join(',');
  const lastFollowKey = useRef(followKey);
  // Closing the Following panel after a change checks again (main has
  // already dropped the old copy).
  const closeFollowing = useCallback(() => {
    setFollowing(false);
    if (lastFollowKey.current !== followKey) { lastFollowKey.current = followKey; refresh(); }
  }, [followKey, refresh]);
  const [filter, setFilter] = useState(() => { try { return localStorage.getItem('studio:releasesFilter') || 'all'; } catch { return 'all'; } });
  const pickFilter = (f) => { setFilter(f); try { localStorage.setItem('studio:releasesFilter', f); } catch { /* ignore */ } };

  const releases = useMemo(() => (data?.releases || []).filter((r) => (filter === 'all' ? true : filter === 'album' ? r.type === 'album' || r.type === 'compilation' : r.type === 'single')), [data, filter]);
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

  const asItem = (r) => ({ kind: 'album', id: r.albumId, name: r.name, sub: `${r.artists} · ${releaseDay(r.releaseDate)}`, image: r.albumArtUrl, label: typeLabel(r) });
  const play = async (r) => {
    try { const rows = await loadCollection(asItem(r)); if (rows?.length) bridge.playRows(rows, 0); } catch { openPanel(asItem(r)); }
  };

  const onSpotify = data ? Math.max(0, (data.artistsTotal || 0) - (data.studioFollows || 0)) : 0;
  return (
    <div className="msp-root">
      <style>{CSS}</style>
      <div className="msp-scroll">
        <div className="msp-wrap">
          <header className="msp-head">
            <div>
              <span className="st-eyebrow">My Spotify</span>
              <h1 className="st-page-title">New Releases</h1>
              <div className="st-meta" style={{ marginTop: 6 }}>
                {data
                  ? `The last ${data.windowDays} days from ${follows.length} artist${follows.length === 1 ? '' : 's'} you follow in Studio${onSpotify ? ` and ${onSpotify} on Spotify` : ''}.`
                  : 'From the artists you follow in Studio and on Spotify.'}
              </div>
            </div>
            <div className="msp-head-side msp-controls">
              <div className="st-segs" role="tablist" aria-label="Release type">
                {FILTERS.map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => pickFilter(id)}>{label}</button>
                ))}
              </div>
              <button type="button" className="st-btn st-btn-outline" onClick={() => setFollowing(true)}>
                Following{follows.length ? ` · ${follows.length}` : ''}
              </button>
              <RefreshButton loading={loading} onClick={refresh} at={data?.fetchedAt} label="Checked" />
            </div>
          </header>

          {data && limitedUntil ? <LimitBanner until={limitedUntil} /> : null}
          {data?.partial && !(limitedUntil > Date.now()) ? <div className="msp-banner">Spotify slowed Studio down part way, so {data.artistsTotal - data.artistsChecked} artists weren’t checked this time. Refresh to fill them in.</div> : null}
          {error && data && error.step !== 'ratelimit' ? <div className="msp-banner">Showing the last check. {error.error || ''}</div> : null}
          {error && !data ? <FeedError error={error} onRetry={refresh} onConnect={bridge.onConnect} /> : null}
          {!data && !error ? <ReleasesSkeleton /> : null}

          {data && !releases.length ? (
            <Note icon={Icon.spark(24)} title={filter === 'all' ? 'Nothing new yet' : 'Nothing of this kind'}
              body={filter === 'all'
                ? `None of the artists you follow has released anything in the last ${data.windowDays} days. Follow more with the Following button (or Follow on any artist's page), and their new music shows up here.`
                : 'Try another filter.'}
              action={filter === 'all' ? <button type="button" className="st-btn st-btn-primary" onClick={() => setFollowing(true)}>Follow artists</button> : null} />
          ) : null}

          {groups.length ? (
            <div className="msp-timeline">
              {groups.map((g) => (
                <section key={g.key} className="msp-week">
                  <div className="msp-week-label"><b>{g.label}</b><span>{g.items.length} release{g.items.length === 1 ? '' : 's'}</span></div>
                  <div className="msp-grid">
                    {g.items.map((r) => (
                      <div key={r.albumId} className="msp-tile" role="button" tabIndex={0}
                        onClick={() => openPanel(asItem(r))} onKeyDown={(e) => { if (e.key === 'Enter') openPanel(asItem(r)); }}>
                        <Art src={r.thumbUrl || r.albumArtUrl}>
                          {daysSince(r.releaseDate) <= 3 ? <span className="st-badge-new msp-new">NEW</span> : null}
                          <button type="button" className="msp-playfab" aria-label={`Play ${r.name}`}
                            onClick={(e) => { e.stopPropagation(); play(r); }}>{Icon.play(15)}</button>
                        </Art>
                        <span style={{ minWidth: 0 }}>
                          <span className="nm" style={{ display: 'block' }}>{r.name}</span>
                          <span className="sb" style={{ display: 'block' }}>{r.artists}</span>
                          <span className="sb" style={{ display: 'block', fontSize: 11 }}>{typeLabel(r)} · {releaseDay(r.releaseDate)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {panel ? <CollectionPanel item={panel} bridge={bridge} onClose={closePanel} /> : null}
      {following ? <FollowPanel bridge={bridge} onClose={closeFollowing} /> : null}
    </div>
  );
}
