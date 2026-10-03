import React, { useMemo } from 'react';
import { formatTime, formatTotalMs } from '../../lib/mediaUtils.js';
import { hoverPreload } from '../../lib/spotifyMediaElement.js';
import { ExplicitBadge, PlayIcon } from '../sharedUI.jsx';
import { PlayingBars } from './common.jsx';
import { RowPlayButton } from './Library.jsx';

/* Album and playlist pages, in the layouts picked under Settings → Layout.
   (Classic is the original page and still lives in LibraryPage.) Every
   layout uses the same pieces: the cover, the title block, the buttons, the
   song list and, under it, more by the artist (albums) or the artists in it
   (playlists). They differ only in where those go.

   Colour: each layout takes its colour from the cover in its own way (a
   tinted column, blurred artwork, a glow of the cover's colours, a full
   colour page). Whatever doesn't scroll is painted on an element that
   doesn't scroll (the page, or a column), so it reaches every edge, the
   scrollbar strip included, and stays put as the list moves. Panels on top
   are tinted glass, never grey. */

export const RECORD_LAYOUTS = [
  ['classic', 'Classic'],
  ['side', 'Side by side'],
  ['header', 'Big header'],
  ['centred', 'Centred'],
  ['sleeve', 'Record sleeve'],
  ['colour', 'Full colour'],
  ['poster', 'Poster'],
];

const CSS = `
.rp { position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; overflow: hidden; color: #fff; }
.rp-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; }
.rp-scroll, .rp-col { scrollbar-gutter: auto; }
.rp-back { position: absolute; top: 14px; left: 14px; z-index: 6; width: 34px; height: 34px; border-radius: 50%; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.9);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .15s ease; }
.rp-back:hover { background: rgba(0,0,0,0.55); }
.rp-cover { position: relative; flex-shrink: 0; overflow: hidden; background: rgba(255,255,255,0.06); }
.rp-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
.rp-cover.is-shadow { box-shadow: 0 18px 50px rgba(0,0,0,0.38), 0 2px 8px rgba(0,0,0,0.28); }
.rp-mosaic { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; width: 100%; height: 100%; }
.rp-cover.is-edit { cursor: pointer; }
.rp-kind { font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.72); }
.rp-title { font-weight: 900; letter-spacing: -0.02em; line-height: 1.06; margin: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.rp-by { font-size: 16px; font-weight: 700; color: #fff; }
.rp-by button { border: none; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; text-underline-offset: 3px; }
.rp-by button:hover { text-decoration: underline; }
.rp-meta { font-size: 14px; color: rgba(255,255,255,0.7); }
.rp-line { font-size: 15px; color: rgba(255,255,255,0.74); }
.rp-line .rp-by { font-size: inherit; display: inline; }
.rp-genres { display: flex; flex-wrap: wrap; gap: 6px; }
.rp-pill { display: inline-flex; align-items: center; height: 28px; padding: 0 13px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 12.5px; font-weight: 600; color: rgba(255,255,255,0.88); }
.rp-acts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rp-acts .rp-gap { flex: 1; min-width: 0; }
.rp-play { height: 46px; padding: 0 24px 0 20px; border-radius: 999px; border: none; cursor: pointer; background: #fff; color: #000;
  display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 800; font-size: 15px; transition: transform .12s ease; flex-shrink: 0; }
.rp-play:hover { transform: scale(1.03); }
.rp-ib { position: relative; width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.12); transition: background .15s ease, color .15s ease; }
.rp-ib:hover { background: rgba(255,255,255,0.2); color: #fff; }
.rp-menu { position: absolute; top: 48px; left: 0; z-index: 20; width: 200px; padding: 5px; border-radius: 12px; background: #0d0d0e; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 22px 60px rgba(0,0,0,0.7); }

.rp-list .sth-lrow { padding: 0 10px; }
.rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(255,255,255,0.07); }
.rp-list .sth-lrow.is-playing { background: rgba(255,255,255,0.1); }
.rp-list .sth-lrow-num, .rp-list .sth-lrow-dim { color: rgba(255,255,255,0.62); }
.rp-art { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,0.08); }
.rp-empty { padding: 30px 10px; color: rgba(255,255,255,0.6); font-size: 14px; }

/* Under the list */
.rp-more { margin-top: 30px; padding-bottom: 30px; }
.rp-more h3 { margin: 0 0 14px 10px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.rp-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 168px)); gap: 12px; }
.rp-tile { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 14px; border: none; background: transparent; color: #fff; cursor: pointer; text-align: left; font: inherit; transition: background .15s ease; min-width: 0; }
.rp-tile:hover { background: rgba(255,255,255,0.08); }
.rp-tile img, .rp-tile .ph { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: rgba(255,255,255,0.08); display: block; }
.rp-tile.is-round img, .rp-tile.is-round .ph { border-radius: 50%; }
.rp-tile b { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-tile small { font-size: 12.5px; color: rgba(255,255,255,0.6); margin-top: -4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-tile.is-round { align-items: center; text-align: center; }

/* Side by side: the cover's colours glow across the whole page from the
   left (painted on the page, so there's no seam between the columns), and
   the songs sit in a frosted card. */
.rp-side { display: grid; grid-template-columns: clamp(260px, 31%, 340px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
.rp-col { position: relative; min-width: 0; overflow-y: auto; overflow-x: hidden; }
.rp-side-l { padding: 26px 20px 26px 28px; }
.rp-side-l .rp-cover { width: 100%; aspect-ratio: 1; border-radius: 22px; box-shadow: 0 26px 70px rgba(var(--rp-wash), 0.6), 0 8px 22px rgba(0,0,0,0.35); }
.rp-side-l .rp-title { font-size: 30px; margin-top: 22px; }
.rp-side-l .rp-by { margin-top: 6px; }
.rp-side-l .rp-meta { margin-top: 6px; }
.rp-side-l .rp-genres { margin-top: 14px; }
.rp-side-l .rp-acts { margin-top: 20px; }
.rp-coverwrap { position: relative; }
.rp-coverwrap .rp-back { top: 12px; left: 12px; }
.rp-glasscol { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 14px 14px 14px 6px; }
.rp-glass { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; border-radius: 24px; padding: 10px 10px 0;
  background: rgba(12,12,14,0.34); border: 1px solid rgba(255,255,255,0.09);
  backdrop-filter: blur(28px) saturate(1.25); -webkit-backdrop-filter: blur(28px) saturate(1.25); }
.rp-glass .rp-more { padding-left: 4px; }

/* Big header */
.rp-hero { position: relative; padding: 70px 36px 26px; display: flex; align-items: flex-end; gap: 30px; }
.rp-hero-bg { position: absolute; inset: -40px -40px 0; background-size: cover; background-position: center; filter: blur(56px) saturate(1.35); opacity: 0.95;
  -webkit-mask-image: linear-gradient(180deg, #000 45%, transparent); mask-image: linear-gradient(180deg, #000 45%, transparent); pointer-events: none; }
.rp-hero-dim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.3)); -webkit-mask-image: linear-gradient(180deg, #000 45%, transparent); mask-image: linear-gradient(180deg, #000 45%, transparent); pointer-events: none; }
.rp-hero .rp-cover { position: relative; width: clamp(170px, 20vw, 230px); aspect-ratio: 1; border-radius: 18px; }
.rp-hero .rp-title { font-size: clamp(34px, 4.6vw, 64px); margin: 8px 0 12px; }
.rp-hero-txt { position: relative; min-width: 0; }
.rp-bar { padding: 0 36px 14px; }
.rp-pad { padding: 0 24px; }

/* Centred */
.rp-centre { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 30px 24px 0; }
.rp-centre .rp-cover { width: clamp(170px, 19vw, 230px); aspect-ratio: 1; border-radius: 22px; }
.rp-centre .rp-title { font-size: clamp(28px, 3vw, 38px); margin-top: 20px; max-width: 760px; }
.rp-centre .rp-by { margin-top: 6px; }
.rp-centre .rp-meta { margin-top: 5px; }
.rp-centre .rp-genres { margin-top: 12px; justify-content: center; }
.rp-centre .rp-acts { margin-top: 18px; justify-content: center; }
.rp-card { position: relative; width: min(860px, calc(100% - 40px)); margin: 24px auto 0; padding: 8px; border-radius: 20px;
  background: rgba(10,10,12,0.32); border: 1px solid rgba(255,255,255,0.09);
  backdrop-filter: blur(24px) saturate(1.2); -webkit-backdrop-filter: blur(24px) saturate(1.2); }
.rp-centre-more { width: min(860px, calc(100% - 40px)); margin: 0 auto; }

/* Record sleeve */
.rp-sleeve-head { position: relative; display: flex; align-items: center; padding: 48px 36px 26px 48px; }
.rp-sleeve { position: relative; width: clamp(180px, 19vw, 236px); aspect-ratio: 1; flex-shrink: 0; margin-right: 36px; }
.rp-sleeve.has-disc { margin-right: clamp(110px, 12vw, 146px); }
.rp-sleeve .rp-cover { position: relative; z-index: 2; width: 100%; height: 100%; border-radius: 10px; }
.rp-disc { position: absolute; top: 3%; left: 45%; width: 94%; height: 94%; border-radius: 50%; z-index: 1;
  background: repeating-radial-gradient(circle, #111 0 2px, #1c1c1c 2px 4px); box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; transition: transform .5s cubic-bezier(.2,.7,.2,1); }
.rp-sleeve:hover .rp-disc { transform: translateX(12%) rotate(40deg); }
.rp-disc-label { width: 36%; height: 36%; border-radius: 50%; background-size: cover; background-position: center; box-shadow: 0 0 0 3px #0b0b0b; position: relative; }
.rp-disc-label::after { content: ''; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: #0b0b0b; }
.rp-info { min-width: 0; flex: 1; }
.rp-sleeve-head .rp-title, .rp-colour-head .rp-title { font-size: clamp(32px, 4.2vw, 56px); margin: 8px 0 12px; }
.rp-sleeve-head .rp-acts, .rp-colour-head .rp-acts { margin-top: 20px; }

/* Full colour */
.rp-colour-head { position: relative; display: flex; align-items: flex-end; gap: 32px; padding: 56px 36px 28px 48px; }
.rp-colour-head .rp-cover { width: clamp(170px, 19vw, 230px); aspect-ratio: 1; border-radius: 14px; }
.rp.is-colour .rp-ib, .rp.is-colour .rp-pill { background: rgba(0,0,0,0.2); }
.rp.is-colour .rp-list .sth-lrow { border-radius: 12px; position: relative; }
.rp.is-colour .rp-list .sth-lrow + .sth-lrow::before { content: ''; position: absolute; left: 10px; right: 10px; top: 0; height: 1px; background: rgba(255,255,255,0.1); }
.rp.is-colour .rp-list .sth-lrow:hover::before, .rp.is-colour .rp-list .sth-lrow:hover + .sth-lrow::before,
.rp.is-colour .rp-list .sth-lrow.is-playing::before, .rp.is-colour .rp-list .sth-lrow.is-playing + .sth-lrow::before { opacity: 0; }
.rp.is-colour .rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(0,0,0,0.12); }
.rp.is-colour .rp-list .sth-lrow.is-playing { background: rgba(0,0,0,0.18); }
.rp.is-colour .rp-list .sth-lrow-num, .rp.is-colour .rp-list .sth-lrow-dim { color: rgba(255,255,255,0.72); }
.rp.is-colour .rp-tile:hover { background: rgba(0,0,0,0.12); }

/* Poster: the cover, blurred and darkened, is the whole page; the sharp
   poster fades into it on the right rather than stopping at an edge. */
.rp-poster { position: relative; display: grid; grid-template-columns: clamp(300px, 40%, 480px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
.rp-backdrop { position: absolute; inset: -90px; background-size: cover; background-position: center; pointer-events: none;
  filter: blur(80px) saturate(1.45) brightness(0.55); }
.rp-backdrop-dim { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.3)); }
.rp-poster-l { position: relative; overflow: hidden; }
.rp-poster-l .rp-cover { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 0; background: transparent;
  -webkit-mask-image: linear-gradient(90deg, #000 58%, transparent 100%); mask-image: linear-gradient(90deg, #000 58%, transparent 100%); }
.rp-poster-fade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.42) 66%, rgba(0,0,0,0.78));
  -webkit-mask-image: linear-gradient(90deg, #000 58%, transparent 100%); mask-image: linear-gradient(90deg, #000 58%, transparent 100%); }
.rp-poster-txt { position: absolute; left: 28px; right: 36px; bottom: 28px; }
.rp-poster-txt .rp-title { font-size: clamp(30px, 3.4vw, 46px); margin: 8px 0 10px; text-shadow: 0 2px 24px rgba(0,0,0,0.35); }
.rp-poster-txt .rp-acts { margin-top: 18px; }
.rp-poster-txt .rp-ib { background: rgba(255,255,255,0.16); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }

/* Soft rows (Side by side, Poster): rounder, numbers in circles, play
   counts, and a tag on your most played song. */
.rp-list.is-soft { display: flex; flex-direction: column; gap: 2px; }
.rp-list.is-soft .sth-lrow { height: 58px; border-radius: 16px; padding: 0 12px 0 8px; }
.rp-list.is-soft .sth-lrow-n { height: 34px; }
.rp-list.is-soft .sth-lrow-num { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.08); font-size: 12.5px; font-weight: 700; color: rgba(255,255,255,0.78); }
.rp-list.is-soft .sth-lrow-play { left: 0; width: 32px; height: 32px; background: #fff; color: #000; border-radius: 50% !important; }
.rp-list.is-soft .rp-art { width: 44px; height: 44px; border-radius: 12px; }
.rp-sub { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-plays { font-size: 12px; color: rgba(255,255,255,0.55); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.rp-top { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; flex-shrink: 0;
  background: rgba(var(--rp-wash), 0.55); color: #fff; font-size: 10.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
`;

const ICONS = {
  back: <path d="M15 6l-6 6 6 6" />,
  shuffle: <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  edit: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.8" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
};
const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[name]}</svg>
);

/** The most common year among the tracks, if any. */
function yearOf(tracks) {
  const n = new Map();
  for (const t of tracks) { const y = Number(t.year); if (y > 1000) n.set(y, (n.get(y) || 0) + 1); }
  let best = null; let c = 0;
  for (const [y, k] of n) if (k > c) { best = y; c = k; }
  return best;
}

const primaryArtist = (s) => String(s || '').split(/,|feat\.|ft\.|&|\bx\b/i)[0].trim();

export default function RecordPage({
  layout,
  data,          // detailData: { kind, title, by, art, customArt, tracks }
  tracks,        // after the in-page filter
  wash, deep, accUI, palette = [],
  genres = [],
  libDetailKey,
  currentTrack, isPlaying,
  onPlayTrack, onTogglePlay, onToggleFavorite, onRemoveFromPlaylist,
  canManage, openRowMenu,
  coverFor, playCountFor, showPlayCounts,
  libAlbums = [], libArtists = [], onOpenAlbum, onOpenArtist, onBack,
  onChangeCover, onEditAlbum, onEditPlaylist, onDeletePlaylist,
  moreOpen, setMoreOpen,
}) {
  const isAlbum = data.kind === 'album';
  const kindLabel = isAlbum ? 'Album' : 'Playlist';

  /* A playlist without a cover of its own shows four of the albums inside
     it, so it looks like what's in it rather than like its first song. */
  const mosaic = useMemo(() => {
    if (isAlbum || data.customArt) return null;
    const seen = [];
    for (const t of data.tracks) {
      const a = coverFor(t);
      if (a && !seen.includes(a)) seen.push(a);
      if (seen.length === 4) break;
    }
    return seen.length === 4 ? seen : null;
  }, [isAlbum, data.customArt, data.tracks, coverFor]);

  /* Under the list: the artist's other albums, or who's in the playlist. */
  const [moreTitle, moreAlbums] = useMemo(() => {
    if (!isAlbum) return ['', []];
    const who = primaryArtist(data.by).toLowerCase();
    const others = libAlbums.filter((a) => a.key !== libDetailKey);
    const mine = others.filter((a) => primaryArtist(a.artist).toLowerCase() === who);
    if (mine.length) return [`More by ${primaryArtist(data.by)}`, mine.slice(0, 12)];
    // Nothing else by them: the newest records in the library instead.
    return ['More in your library', [...others].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8)];
  }, [isAlbum, data.by, libAlbums, libDetailKey]);
  const plArtists = useMemo(() => {
    if (isAlbum) return [];
    const m = new Map();
    for (const t of data.tracks) {
      const name = primaryArtist(t.artist);
      if (!name) continue;
      const k = name.toLowerCase();
      const cur = m.get(k) || { key: k, name, n: 0, art: null };
      cur.n += 1;
      if (!cur.art) cur.art = coverFor(t);
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((a) => {
      const lib = libArtists.find((x) => x.key === a.key);
      return { ...a, art: lib?.art || a.art, inLibrary: !!lib };
    });
  }, [isAlbum, data.tracks, coverFor, libArtists]);

  const totalMs = data.tracks.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
  const year = isAlbum ? yearOf(data.tracks) : null;
  const meta = [year, `${data.tracks.length} ${data.tracks.length === 1 ? 'song' : 'songs'}`, formatTotalMs(totalMs)].filter(Boolean).join(' · ');
  const oneArtist = isAlbum && new Set(data.tracks.map((t) => (t.artist || '').toLowerCase())).size <= 1;
  const showAlbumCol = !isAlbum;
  const showPlaysCol = showPlayCounts && isAlbum;
  const cols = ['44px', 'minmax(160px,2.4fr)', showAlbumCol ? 'minmax(110px,1.3fr)' : null, showPlaysCol ? '60px' : null, '60px', '52px'].filter(Boolean).join(' ');
  const rowH = isAlbum && oneArtist ? 50 : 58;

  const artistLink = (() => {
    const who = isAlbum ? String(data.by || '') : '';
    const hit = who ? libArtists.find((a) => who.toLowerCase().startsWith(a.key)) : null;
    return hit
      ? <button type="button" onClick={() => onOpenArtist(hit.key)} title={`Go to ${hit.name}`}>{data.by}</button>
      : <span>{data.by}</span>;
  })();

  const cover = (opts = {}) => (
    <div className={`rp-cover${opts.shadow === false ? '' : ' is-shadow'}${!isAlbum && onChangeCover ? ' is-edit sth-plcover' : ''}`}
      onClick={!isAlbum && onChangeCover ? onChangeCover : undefined} title={!isAlbum && onChangeCover ? 'Change cover' : undefined}>
      {mosaic
        ? <div className="rp-mosaic">{mosaic.map((a) => <img key={a} src={a} alt="" draggable={false} />)}</div>
        : data.art ? <img src={data.art} alt="" draggable={false} /> : null}
      {!isAlbum && onChangeCover && !opts.noVeil ? (
        <div className="sth-plcover-veil">
          <Icon name="edit" size={24} />
          <span style={{ fontSize: 11.5, fontWeight: 650, marginTop: 7 }}>Change cover</span>
        </div>
      ) : null}
    </div>
  );

  const playAll = () => onPlayTrack?.(data.tracks[0], data.tracks);
  const shuffle = () => { const sh = [...data.tracks].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); };
  const actions = (opts = {}) => (
    <div className="rp-acts">
      {opts.shuffleFirst ? <button type="button" className="rp-ib" title="Shuffle" aria-label="Shuffle" onClick={shuffle}><Icon name="shuffle" /></button> : null}
      <button type="button" className="rp-play" onClick={playAll} aria-label={`Play ${data.title}`}><PlayIcon size={15} />Play</button>
      {opts.shuffleFirst ? null : <button type="button" className="rp-ib" title="Shuffle" aria-label="Shuffle" onClick={shuffle}><Icon name="shuffle" /></button>}
      {isAlbum && onEditAlbum ? <button type="button" className="rp-ib" title="Edit album details" aria-label="Edit album details" onClick={onEditAlbum}><Icon name="edit" size={16} /></button> : null}
      {!isAlbum && (onEditPlaylist || onDeletePlaylist) ? (
        <span style={{ position: 'relative' }}>
          <button type="button" className="rp-ib" title="More" aria-label="More" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" /></button>
          {moreOpen ? (
            <span className="rp-menu">
              {onEditPlaylist ? <button type="button" className="sth-mi" onClick={() => { setMoreOpen(false); onEditPlaylist(); }}>Rename playlist</button> : null}
              {onChangeCover ? <button type="button" className="sth-mi" onClick={() => { setMoreOpen(false); onChangeCover(); }}>Change cover</button> : null}
              {onDeletePlaylist ? <button type="button" className="sth-mi" style={{ color: 'var(--danger)' }} onClick={() => { setMoreOpen(false); onDeletePlaylist(); }}>Delete playlist</button> : null}
            </span>
          ) : null}
        </span>
      ) : null}
      {opts.genres && genres.length ? genres.map((g) => <span key={g} className="rp-pill">{g}</span>) : null}
    </div>
  );

  /* Your most played song here, when you've played any of them. */
  const topId = useMemo(() => {
    if (data.tracks.length < 2) return null;
    let best = null; let n = 0;
    for (const t of data.tracks) { const c = playCountFor(t.id); if (c > n) { n = c; best = t.id; } }
    return best;
  }, [data.tracks, playCountFor]);

  const heart = (t) => (onToggleFavorite ? (
    <button type="button" className="sth-lrow-more" onClick={() => onToggleFavorite(t.id)}
      title={t.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
      style={{ opacity: t.isFavorite ? 1 : undefined, color: t.isFavorite ? `rgb(${accUI})` : undefined }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill={t.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
      </svg>
    </button>
  ) : null);
  const removeBtn = (t) => (!isAlbum && onRemoveFromPlaylist ? (
    <button type="button" className="sth-lrow-more" onClick={() => onRemoveFromPlaylist(libDetailKey, t.id)} title="Remove from playlist">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  ) : null);
  const numCell = (t, i, playing) => (
    <div className="sth-lrow-n" {...hoverPreload(t)}>
      {playing
        ? <span style={{ display: 'inline-flex', width: 32, justifyContent: 'center' }}><PlayingBars acc={accUI} playing={isPlaying} /></span>
        : <span className="sth-lrow-num">{isAlbum ? (t.trackNumber || i + 1) : i + 1}</span>}
      <RowPlayButton playing={playing} isPlaying={isPlaying} title={t.title}
        onPlay={() => onPlayTrack?.(t, tracks)} onTogglePlay={onTogglePlay} />
    </div>
  );
  const titleCell = (t, playing, sub) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      {!isAlbum ? (coverFor(t) ? <img className="rp-art" src={coverFor(t)} alt="" draggable={false} /> : <span className="rp-art" />) : null}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: playing ? `rgb(${accUI})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.explicit ? <ExplicitBadge /> : null}
          {sub === 'soft' && t.id === topId ? <span className="rp-top">Most played</span> : null}
        </div>
        {sub === 'soft'
          ? ((!isAlbum || !oneArtist) ? <div className="rp-sub">{isAlbum ? t.artist : [t.artist, t.album].filter(Boolean).join(' · ')}</div> : null)
          : (oneArtist ? null : <div className="rp-sub">{t.artist}</div>)}
      </div>
    </div>
  );

  const renderList = (soft) => {
    const softCols = `44px minmax(0,1fr) auto 48px ${!isAlbum && onRemoveFromPlaylist ? '64px' : '36px'}`;
    return (
      <div className={`rp-list${soft ? ' is-soft' : ''}`}>
        {tracks.length ? tracks.map((t, i) => {
          const playing = currentTrack?.id === t.id;
          const plays = playCountFor(t.id);
          return (
            <div key={t.id} className={`sth-lrow${playing ? ' is-playing' : ''}`}
              style={soft ? { gridTemplateColumns: softCols } : { gridTemplateColumns: cols, height: rowH }}
              onDoubleClick={() => onPlayTrack?.(t, tracks)}
              onContextMenu={canManage ? (e) => openRowMenu(e, t) : undefined}>
              {numCell(t, i, playing)}
              {titleCell(t, playing, soft ? 'soft' : 'plain')}
              {soft ? <div className="rp-plays">{plays ? `${plays} ${plays === 1 ? 'play' : 'plays'}` : ''}</div> : null}
              {!soft && showAlbumCol ? <div className="sth-lrow-dim sth-lcol-album">{t.album}</div> : null}
              {!soft && showPlaysCol ? <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{plays}</div> : null}
              <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{formatTime(t.duration)}</div>
              <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>{heart(t)}{removeBtn(t)}</div>
            </div>
          );
        }) : <div className="rp-empty">No songs yet.</div>}
      </div>
    );
  };
  const list = renderList(false);

  const more = moreAlbums.length ? (
    <section className="rp-more">
      <h3>{moreTitle}</h3>
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
  ) : plArtists.length ? (
    <section className="rp-more">
      <h3>Artists in this playlist</h3>
      <div className="rp-shelf">
        {plArtists.map((a) => (
          <button key={a.key} type="button" className="rp-tile is-round" disabled={!a.inLibrary}
            onClick={a.inLibrary ? () => onOpenArtist(a.key) : undefined} style={a.inLibrary ? undefined : { cursor: 'default' }}>
            {a.art ? <img src={a.art} alt="" draggable={false} /> : <span className="ph" />}
            <b>{a.name}</b>
            <small>{a.n} {a.n === 1 ? 'song' : 'songs'}</small>
          </button>
        ))}
      </div>
    </section>
  ) : null;

  const back = <button type="button" className="rp-back" onClick={onBack} title="Back" aria-label="Back"><Icon name="back" size={16} /></button>;
  const kind = <div className="rp-kind">{kindLabel}</div>;
  const title = <h1 className="rp-title">{data.title}</h1>;
  const byLine = <div className="rp-line"><span className="rp-by">{artistLink}</span> · {meta}</div>;
  const blurArt = mosaic ? mosaic[0] : data.art;

  /* Each layout's colour, painted on the page (which doesn't scroll). */
  const base = '12, 12, 13';
  const pal = [0, 1, 2, 3].map((i) => palette[i] || palette[0] || wash);
  const background = {
    side: [
      `radial-gradient(60% 70% at 8% 18%, rgba(${pal[0]},0.8), rgba(${pal[0]},0) 100%)`,
      `radial-gradient(50% 60% at 18% 92%, rgba(${pal[1]},0.5), rgba(${pal[1]},0) 100%)`,
      `radial-gradient(55% 55% at 78% 4%, rgba(${pal[2]},0.38), rgba(${pal[2]},0) 100%)`,
      `radial-gradient(50% 60% at 96% 96%, rgba(${pal[3]},0.25), rgba(${pal[3]},0) 100%)`,
      `rgb(${base})`,
    ].join(', '),
    poster: `rgb(${base})`,
    colour: `linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.3) 100%), rgb(${wash})`,
    header: `linear-gradient(180deg, rgba(${wash},0.3) 0%, rgba(${wash},0.14) 55%, rgba(${wash},0.08) 100%), rgb(${base})`,
    sleeve: `linear-gradient(180deg, rgba(${wash},0.62) 0%, rgba(${wash},0.24) 42%, rgba(${wash},0.1) 75%, rgba(${wash},0.06) 100%), rgb(${base})`,
    /* The cover's own colours, glowing behind it: the main one above the
       cover, two more to either side, and a faint one at the bottom so the
       page doesn't end in flat black. */
    centred: [
      `radial-gradient(58% 46% at 50% 4%, rgba(${pal[0]},0.85), rgba(${pal[0]},0) 100%)`,
      `radial-gradient(42% 40% at 12% 22%, rgba(${pal[1]},0.55), rgba(${pal[1]},0) 100%)`,
      `radial-gradient(42% 40% at 88% 26%, rgba(${pal[2]},0.55), rgba(${pal[2]},0) 100%)`,
      `radial-gradient(70% 50% at 50% 100%, rgba(${pal[3]},0.3), rgba(${pal[3]},0) 100%)`,
      `rgb(${base})`,
    ].join(', '),
  }[layout] || `rgb(${base})`;

  let body;
  if (layout === 'side') {
    body = (
      <div className="rp-side">
        <div className="rp-col rp-side-l sth-libscroll">
          <div className="rp-coverwrap">{cover()}{back}</div>
          {title}
          <div className="rp-by">{artistLink}</div>
          <div className="rp-meta">{meta}</div>
          {genres.length ? <div className="rp-genres">{genres.map((g) => <span key={g} className="rp-pill">{g}</span>)}</div> : null}
          {actions()}
        </div>
        <div className="rp-glasscol"><div className="rp-glass sth-libscroll">{renderList(true)}{more}</div></div>
      </div>
    );
  } else if (layout === 'header') {
    body = (
      <div className="rp-scroll sth-libscroll">
        <div className="rp-hero">
          {blurArt ? <div className="rp-hero-bg" style={{ backgroundImage: `url("${blurArt}")` }} /> : null}
          <div className="rp-hero-dim" />
          {cover()}
          <div className="rp-hero-txt">{kind}{title}{byLine}</div>
        </div>
        <div className="rp-bar">{actions({ genres: true })}</div>
        <div className="rp-pad">{list}{more}</div>
      </div>
    );
  } else if (layout === 'centred') {
    body = (
      <div className="rp-scroll sth-libscroll">
        <div className="rp-centre">
          {cover()}
          {title}
          <div className="rp-by">{artistLink}</div>
          <div className="rp-meta">{meta}</div>
          {genres.length ? <div className="rp-genres">{genres.map((g) => <span key={g} className="rp-pill">{g}</span>)}</div> : null}
          {actions({ shuffleFirst: true })}
        </div>
        <div className="rp-card">{list}</div>
        <div className="rp-centre-more">{more || <div style={{ height: 30 }} />}</div>
      </div>
    );
  } else if (layout === 'sleeve') {
    const disc = isAlbum && data.art;
    body = (
      <div className="rp-scroll sth-libscroll">
        <div className="rp-sleeve-head">
          <div className={`rp-sleeve${disc ? ' has-disc' : ''}`}>
            {cover()}
            {disc ? <div className="rp-disc"><div className="rp-disc-label" style={{ backgroundImage: `url("${data.art}")` }} /></div> : null}
          </div>
          <div className="rp-info">{kind}{title}{byLine}{actions({ genres: true })}</div>
        </div>
        <div className="rp-pad">{list}{more}</div>
      </div>
    );
  } else if (layout === 'colour') {
    body = (
      <div className="rp-scroll sth-libscroll">
        <div className="rp-colour-head">
          {cover()}
          <div className="rp-info">{kind}{title}{byLine}{actions({ genres: true })}</div>
        </div>
        <div className="rp-pad" style={{ padding: '0 34px' }}>{list}{more}</div>
      </div>
    );
  } else {
    body = (
      <div className="rp-poster">
        {blurArt ? <div className="rp-backdrop" style={{ backgroundImage: `url("${blurArt}")` }} /> : null}
        <div className="rp-backdrop-dim" />
        <div className="rp-poster-l">
          {cover({ shadow: false, noVeil: true })}
          <div className="rp-poster-fade" />
          {back}
          <div className="rp-poster-txt">
            {kind}{title}{byLine}
            {actions()}
          </div>
        </div>
        <div className="rp-glasscol"><div className="rp-glass sth-libscroll">{renderList(true)}{more}</div></div>
      </div>
    );
  }

  return (
    <div className={`rp${layout === 'colour' ? ' is-colour' : ''}`} style={{ '--rp-wash': wash, '--rp-deep': deep, background }}>
      <style>{CSS}</style>
      {body}
      {layout === 'header' || layout === 'centred' || layout === 'sleeve' || layout === 'colour' ? back : null}
    </div>
  );
}

/* Settings → Layout: a small drawing of each layout. */
const SKETCH = {
  classic: <><rect x="8" y="8" width="18" height="18" rx="3" className="a" /><rect x="30" y="12" width="30" height="5" rx="2.5" className="t" /><rect x="30" y="20" width="18" height="3" rx="1.5" /><rect x="8" y="32" width="80" height="3" rx="1.5" /><rect x="8" y="39" width="80" height="3" rx="1.5" /><rect x="8" y="46" width="80" height="3" rx="1.5" /></>,
  side: <><rect x="0" y="0" width="34" height="60" className="w" /><rect x="6" y="6" width="22" height="22" rx="3" className="a" /><rect x="6" y="32" width="18" height="4" rx="2" className="t" /><rect x="6" y="40" width="12" height="5" rx="2.5" className="p" /><rect x="40" y="8" width="50" height="3" rx="1.5" /><rect x="40" y="16" width="50" height="3" rx="1.5" /><rect x="40" y="24" width="50" height="3" rx="1.5" /><rect x="40" y="32" width="50" height="3" rx="1.5" /><rect x="40" y="40" width="50" height="3" rx="1.5" /></>,
  header: <><rect x="0" y="0" width="96" height="28" className="w" /><rect x="8" y="6" width="18" height="18" rx="3" className="a" /><rect x="30" y="14" width="34" height="7" rx="3" className="t" /><rect x="8" y="33" width="10" height="5" rx="2.5" className="p" /><rect x="8" y="43" width="80" height="3" rx="1.5" /><rect x="8" y="50" width="80" height="3" rx="1.5" /></>,
  centred: <><ellipse cx="48" cy="6" rx="40" ry="20" className="w" /><rect x="38" y="5" width="20" height="20" rx="4" className="a" /><rect x="33" y="29" width="30" height="4" rx="2" className="t" /><rect x="42" y="36" width="12" height="5" rx="2.5" className="p" /><rect x="22" y="45" width="52" height="15" rx="4" className="c" /></>,
  sleeve: <><circle cx="34" cy="18" r="12" className="d" /><rect x="8" y="7" width="22" height="22" rx="2" className="a" /><rect x="52" y="12" width="32" height="5" rx="2.5" className="t" /><rect x="52" y="20" width="14" height="5" rx="2.5" className="p" /><rect x="8" y="38" width="80" height="3" rx="1.5" /><rect x="8" y="45" width="80" height="3" rx="1.5" /><rect x="8" y="52" width="80" height="3" rx="1.5" /></>,
  colour: <><rect x="0" y="0" width="96" height="60" className="w full" /><rect x="8" y="7" width="20" height="20" rx="3" className="a" /><rect x="32" y="12" width="32" height="5" rx="2.5" className="t" /><rect x="32" y="20" width="12" height="5" rx="2.5" className="p" /><rect x="8" y="36" width="80" height="1" /><rect x="8" y="44" width="80" height="1" /><rect x="8" y="52" width="80" height="1" /></>,
  poster: <><rect x="0" y="0" width="38" height="60" className="a" /><rect x="5" y="44" width="24" height="4" rx="2" className="t" /><rect x="5" y="51" width="11" height="5" rx="2.5" className="p" /><rect x="44" y="8" width="46" height="3" rx="1.5" /><rect x="44" y="16" width="46" height="3" rx="1.5" /><rect x="44" y="24" width="46" height="3" rx="1.5" /><rect x="44" y="32" width="46" height="3" rx="1.5" /><rect x="44" y="40" width="46" height="3" rx="1.5" /></>,
};
const PICKER_CSS = `
.rlp { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; width: 100%; }
.rlp button { display: flex; flex-direction: column; align-items: stretch; gap: 7px; padding: 8px 8px 9px; border-radius: 12px; cursor: pointer;
  border: 1px solid rgba(var(--st-fg-rgb), 0.08); background: rgba(var(--st-fg-rgb), 0.03); color: rgba(var(--st-fg-rgb), 0.7);
  font: inherit; font-size: 12.5px; font-weight: 600; text-align: left; transition: background .14s ease, border-color .14s ease, color .14s ease; }
.rlp button:hover { background: rgba(var(--st-fg-rgb), 0.07); color: #fff; }
.rlp button.on { border-color: rgba(var(--accent-rgb, 255,255,255), 0.85); background: rgba(var(--accent-rgb, 255,255,255), 0.08); color: #fff; }
.rlp svg { width: 100%; height: auto; border-radius: 7px; background: #111113; display: block; }
.rlp svg rect, .rlp svg circle, .rlp svg ellipse { fill: rgba(255,255,255,0.22); }
.rlp svg .a { fill: rgba(255,255,255,0.75); }
.rlp svg .t { fill: rgba(255,255,255,0.6); }
.rlp svg .p { fill: #fff; }
.rlp svg .w { fill: rgba(120,150,125,0.45); }
.rlp svg .w.full { fill: rgba(110,140,115,0.85); }
.rlp svg .c { fill: rgba(255,255,255,0.08); }
.rlp svg .d { fill: #050505; stroke: rgba(255,255,255,0.25); stroke-width: 1; }
`;

export function RecordLayoutPicker({ value, onPick }) {
  return (
    <div className="rlp" role="radiogroup" aria-label="Album and playlist layout">
      <style>{PICKER_CSS}</style>
      {RECORD_LAYOUTS.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onPick(id)}>
          <svg viewBox="0 0 96 60" aria-hidden>{SKETCH[id]}</svg>
          {label}
        </button>
      ))}
    </div>
  );
}
