import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, titleCase } from '../../lib/format.js';
import { formatTime, formatTotalMs } from '../../lib/mediaUtils.js';
import { spotifyIdOf } from '../../lib/spotifyMediaElement.js';
import { ExplicitBadge, HiResImg, PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { PlayingBars, useRowDrag } from './common.jsx';
import { RowPlayButton } from './Library.jsx';
import { BoundedMap } from '../../lib/boundedMap.js';
import ScrollJump from './ScrollJump.jsx';
import { coverProfile, slicePosition, titleShade } from '../../lib/coverFocus.js';

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

/** The saved layout, or Classic. Side by side was removed; it maps to Poster. */
/** True for a title written in capitals ("BLONDE", "DAMN."), not one that
 *  merely has some ("AVANT NOVA" yes, "marroW" no). */
export function isAllCaps(t) {
  const s = String(t || '');
  return /\p{Lu}.*\p{Lu}/su.test(s) && s === s.toLocaleUpperCase() && s !== s.toLocaleLowerCase();
}

/* Classic and Record sleeve were retired: a page saved on either (or on
   nothing) opens in Full color. */
export function recordLayoutOf(v) {
  if (v === 'side') return 'poster';
  if (v === 'centred') return 'twin'; // the old Centered
  if (v === 'spine') return 'sticky'; // retired: the nearest of what's left
  if (v === 'letterbox') return 'titleart';
  return RECORD_LAYOUTS.some(([id]) => id === v) ? v : 'colour';
}

export const RECORD_LAYOUTS = [
  ['colour', 'Full color'],
  ['header', 'Big header'],
  ['banner', 'Cover banner'],
  ['glass', 'Glass card'],
  ['poster', 'Poster'],
  ['sticky', 'Sticky column'],
  ['titleart', 'Title on art'],
  ['twin', 'Twin buttons'],
  ['overlap', 'Overlap'],
];

/* Layouts whose songs scroll in their own column beside a fixed one: no top bar. */
const SPLIT = new Set(['poster', 'sticky']);

const CSS = `
.rp { position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; overflow: hidden; color: #fff; }
.rp-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; }
.rp-scroll, .rp-col { scrollbar-gutter: auto; }
.rp-back { position: absolute; top: 14px; left: 14px; z-index: 6; width: 34px; height: 34px; border-radius: 50%; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.9);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .15s ease; }
.rp-back:hover { background: rgba(0,0,0,0.55); }
/* The sticking bar (scrolling layouts). Takes no room until it sticks:
   the negative margin lays it over the top of the page, which every layout
   leaves clear. */
.rp-topbar { position: sticky; top: 0; z-index: 6; height: 56px; margin-bottom: -56px; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; transition: background 0.2s ease, box-shadow 0.2s ease; }
/* Solid once stuck: songs scrolling under it used to show through. */
.rp-topbar.is-stuck { background: rgb(var(--rp-deep));
  box-shadow: inset 0 -1px 0 rgba(255,255,255,0.07); }
/* The scrollbar's gutter sits beside the bar, so its top takes the same
   fill and edge: the bar runs to the window's edge instead of stopping short.
   On the scrollbar itself, not its track: the track starts 14px down (its
   margin keeps the thumb off the rounded corner). */
.rp-scroll.is-stuck::-webkit-scrollbar { background: linear-gradient(to bottom, rgb(var(--rp-deep)) 55px, rgba(255,255,255,0.07) 55px, rgba(255,255,255,0.07) 56px, transparent 56px); }
.rp-topbar .rp-back { position: static; flex-shrink: 0; }
/* Stuck, the bar is its own backdrop: back drops its glass circle and sits
   as a plain glyph beside play, like the rest of the bar. */
.rp-topbar.is-stuck .rp-back { background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
.rp-topbar.is-stuck .rp-back:hover { background: rgba(255,255,255,0.1); }
/* Stuck: what you're looking at on the left (cover, name, a line of
   detail), what you can do on the right, ending in Play. Both fade in once
   the title has scrolled away; before that only back shows. */
.rp-topbar-id, .rp-topbar-acts { display: flex; align-items: center; min-width: 0; opacity: 0; transform: translateY(4px); pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease; }
.rp-topbar-id { gap: 12px; flex: 1; }
.rp-topbar-acts { gap: 6px; flex-shrink: 0; }
.rp-topbar.is-stuck .rp-topbar-id, .rp-topbar.is-stuck .rp-topbar-acts { opacity: 1; transform: none; pointer-events: auto; }
.rp-topbar-art { width: 36px; height: 36px; flex-shrink: 0; border-radius: 6px; background-color: rgba(255,255,255,0.08); background-size: cover; background-position: center; }
.rp-topbar-txt { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.rp-topbar-txt b { font-size: 15px; font-weight: 800; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.01em; }
.rp-topbar-txt span { margin-top: 2px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-topbar-ib { width: 36px; height: 36px; flex-shrink: 0; border: none; border-radius: var(--r-ctl-s, 8px); padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; background: transparent; color: rgba(255,255,255,0.72); transition: color 0.14s ease, background 0.14s ease; }
.rp-topbar-ib:hover, .rp-topbar-ib[aria-expanded="true"] { color: #fff; background: rgba(255,255,255,0.1); }
.rp-topbar-play { height: 36px; padding: 0 16px 0 13px; margin-right: 6px; flex-shrink: 0; border-radius: 10px; border: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px; background: #fff; color: #000; font: inherit; font-size: 13.5px; font-weight: 800; }
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
.rp-play { height: 46px; padding: 0 24px 0 20px; border-radius: 12px; border: none; cursor: pointer; background: #fff; color: #000;
  display: inline-flex; align-items: center; gap: 9px; font: inherit; font-weight: 800; font-size: 15px; transition: transform .12s ease; flex-shrink: 0; }
.rp-ib { position: relative; width: 40px; height: 40px; border-radius: var(--r-ctl-s, 8px); border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  color: rgba(255,255,255,0.78); background: transparent; transition: background .15s ease, color .15s ease; }
.rp-ib:hover, .rp-ib[aria-expanded="true"] { background: rgba(255,255,255,0.1); color: #fff; }
.rp-menu { position: absolute; top: 48px; left: 0; z-index: 20; width: 200px; padding: 5px; border-radius: 12px; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 22px 60px rgba(0,0,0,0.7); }

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

/* The frosted song card (Poster). */
.rp-glasscol { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 14px 14px 14px 6px; }
.rp-glass { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; border-radius: 24px; padding: 10px 10px 0;
  background: rgba(12,12,14,0.34); border: 1px solid rgba(255,255,255,0.09);
  backdrop-filter: blur(28px) saturate(1.25); -webkit-backdrop-filter: blur(28px) saturate(1.25); }
.rp-glass .rp-more { padding-left: 4px; }
.rp-col { position: relative; min-width: 0; overflow-y: auto; overflow-x: hidden; }

/* Big header */
.rp-hero { position: relative; padding: 70px 36px 26px; display: flex; align-items: flex-end; gap: 30px; }
.rp-hero-paint { position: absolute; top: 0; left: 0; right: 0; height: 0; pointer-events: none; will-change: transform; }
.rp-hero-bg { position: absolute; inset: -40px -40px 0; background-size: cover; background-position: center; filter: blur(56px) saturate(1.35); opacity: 0.95;
  -webkit-mask-image: linear-gradient(180deg, #000 45%, transparent); mask-image: linear-gradient(180deg, #000 45%, transparent); pointer-events: none; }
.rp-hero-dim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.3)); -webkit-mask-image: linear-gradient(180deg, #000 45%, transparent); mask-image: linear-gradient(180deg, #000 45%, transparent); pointer-events: none; }
.rp-hero .rp-cover { position: relative; width: clamp(170px, 20vw, 230px); aspect-ratio: 1; border-radius: 18px; }
.rp-hero .rp-title { font-size: clamp(34px, 4.6vw, 64px); margin: 8px 0 12px; }
.rp-hero-txt { position: relative; min-width: 0; }
.rp-hero .rp-acts { margin-top: 20px; }
.rp-bar { padding: 0 36px 14px; }
.rp-pad { padding: 0 24px; }

/* The centered layouts: details in the middle, songs in a centered column. */
.rp-ccol { width: min(900px, calc(100% - 48px)); margin: 0 auto; }
.rp-cmid { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 24px; }
.rp-cmid .rp-title { max-width: 820px; }
.rp-cmid .rp-acts { justify-content: center; }

/* Title on art: the artwork across the top, the title centered on it. */
.rp-tart { position: relative; height: clamp(300px, 46vh, 420px); overflow: hidden; }
.rp-tart-fade { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(60% 50% at 50% 55%, rgba(0,0,0,0.35), rgba(0,0,0,0) 70%),
    linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0) 30%, rgba(var(--rp-deep),0.8) 80%, rgb(var(--rp-deep)) 100%); }
.rp-tart-txt { position: absolute; left: 24px; right: 24px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; text-align: center; }
.rp-tart-txt .rp-title { font-size: clamp(40px, 6.4vw, 92px); margin: 8px 0 calc(12px - 0.16em); max-width: 980px; text-wrap: balance; }
.rp-tart-txt .rp-line { color: rgba(255,255,255,0.82); }
.rp-tart + .rp-cmid { margin-top: -30px; padding-bottom: 26px; }

/* Twin buttons: an even stack, Play and Shuffle side by side. */
.rp-twin { padding: 50px 24px 0; }
.rp-twin .rp-cover { width: clamp(180px, 18vw, 220px); aspect-ratio: 1; border-radius: 12px; }
.rp-twin .rp-title { font-size: clamp(28px, 2.8vw, 36px); margin: 22px 0 calc(4px - 0.16em); }
.rp-twin-by { font-size: 19px; font-weight: 700; color: #fff; }
.rp-twin-by button { border: none; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; text-underline-offset: 3px; }
.rp-twin-by button:hover { text-decoration: underline; }
.rp-twin .rp-meta { margin-top: 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
.rp-twin-row { position: relative; display: flex; gap: 12px; margin: 20px 0 30px; }
.rp-twin-btn { width: 170px; height: 46px; border-radius: 12px; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  background: rgba(255,255,255,0.12); color: #fff; font: inherit; font-size: 15px; font-weight: 800; }
/* Play is white like every other layout's; Shuffle is its quiet twin. */
.rp-twin-btn.is-play { background: #fff; color: #000; }
.rp-twin-extra { position: absolute; left: calc(100% + 10px); top: 3px; display: flex; gap: 4px; }
.rp-list.is-hair .sth-lrow:not(.sth-lrow-head) { border-radius: 0; box-shadow: inset 0 -1px 0 rgba(255,255,255,0.08); }
.rp-list.is-hair .sth-lrow.sth-lrow-head { box-shadow: none; }

/* Overlap: one color, the cover centered at the top, everything under it. */
.rp-ovl { padding: 70px 24px 26px; }
.rp-ovl .rp-cover { width: clamp(180px, 17vw, 210px); aspect-ratio: 1; border-radius: 14px; }
.rp-ovl .rp-title { font-size: clamp(32px, 3.4vw, 46px); margin: 22px 0 calc(8px - 0.16em); }
.rp-ovl .rp-acts { margin-top: 18px; }

.rp-info { min-width: 0; flex: 1; }
.rp-colour-head .rp-title { font-size: clamp(32px, 4.2vw, 56px); margin: 8px 0 12px; }
.rp-colour-head .rp-acts { margin-top: 20px; }

/* Full colour */
.rp-colour-head { position: relative; display: flex; align-items: flex-end; gap: 32px; padding: 56px 36px 28px 48px; }
.rp-colour-head .rp-cover { width: clamp(170px, 19vw, 230px); aspect-ratio: 1; border-radius: 14px; }
.rp.is-colour .rp-pill { background: rgba(0,0,0,0.2); }
.rp.is-colour .rp-ib:hover, .rp.is-colour .rp-ib[aria-expanded="true"] { background: rgba(0,0,0,0.2); }
.rp.is-colour .rp-list .sth-lrow { border-radius: 12px; position: relative; }
.rp.is-colour .rp-list .sth-lrow + .sth-lrow::before { content: ''; position: absolute; left: 10px; right: 10px; top: 0; height: 1px; background: rgba(255,255,255,0.1); }
.rp.is-colour .rp-list .sth-lrow:hover::before, .rp.is-colour .rp-list .sth-lrow:hover + .sth-lrow::before,
.rp.is-colour .rp-list .sth-lrow.is-playing::before, .rp.is-colour .rp-list .sth-lrow.is-playing + .sth-lrow::before { opacity: 0; }
.rp.is-colour .rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(0,0,0,0.12); }
.rp.is-colour .rp-list .sth-lrow.is-playing { background: rgba(0,0,0,0.18); }
.rp.is-colour .rp-list .sth-lrow-num, .rp.is-colour .rp-list .sth-lrow-dim { color: rgba(255,255,255,0.72); }
.rp.is-colour .rp-tile:hover { background: rgba(0,0,0,0.12); }
/* Dark mode: darkening a near-black page does nothing, so hover and the
   playing row lighten instead, and buttons sit on a faint white. */
.rp.is-dark .rp-list .sth-lrow:not(.sth-lrow-head):hover { background: rgba(255,255,255,0.05); }
.rp.is-dark .rp-list .sth-lrow.is-playing { background: rgba(255,255,255,0.08); }
.rp.is-dark.is-colour .rp-pill, .rp.is-dark .rp-twin-btn:not(.is-play) { background: rgba(255,255,255,0.08); }
.rp.is-dark.is-colour .rp-ib:hover, .rp.is-dark.is-colour .rp-ib[aria-expanded="true"],
.rp.is-dark .rp-sticky-l .rp-ib:hover, .rp.is-dark .rp-sticky-l .rp-ib[aria-expanded="true"] { background: rgba(255,255,255,0.13); }
.rp.is-dark .rp-tile:hover { background: rgba(255,255,255,0.05); }
.rp.is-dark .rp-sticky-l { background: linear-gradient(180deg, rgb(var(--rp-wash)), rgb(var(--rp-deep))); box-shadow: inset -1px 0 0 rgba(255,255,255,0.06); }
.rp.is-dark .rp-glasshero { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }

/* Poster: the cover, blurred and darkened, is the whole page; the sharp
   poster fades into it on the right rather than stopping at an edge. */
.rp-poster { position: relative; display: grid; grid-template-columns: clamp(300px, 40%, 480px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
.rp-backdrop { position: absolute; inset: -90px; background-size: cover; background-position: center; pointer-events: none;
  filter: blur(80px) saturate(1.45) brightness(0.55); }
.rp-backdrop-dim { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.3)); }
.rp-poster-l { position: relative; }
/* The cover, its blur and its shade, as one layer. It reaches to the song
   card's left edge (6px past the column) and has faded out by exactly
   there, on an eased curve over the last 64px, so none of it shows under
   the card and there's no line where the fade starts. */
.rp-poster-art { position: absolute; top: 0; bottom: 0; left: 0; right: -6px; overflow: hidden; pointer-events: none;
  -webkit-mask-image: linear-gradient(90deg, rgba(0,0,0,1.000) calc(100% - 64.0px), rgba(0,0,0,0.972) calc(100% - 57.6px), rgba(0,0,0,0.896) calc(100% - 51.2px), rgba(0,0,0,0.784) calc(100% - 44.8px), rgba(0,0,0,0.648) calc(100% - 38.4px), rgba(0,0,0,0.500) calc(100% - 32.0px), rgba(0,0,0,0.352) calc(100% - 25.6px), rgba(0,0,0,0.216) calc(100% - 19.2px), rgba(0,0,0,0.104) calc(100% - 12.8px), rgba(0,0,0,0.028) calc(100% - 6.4px), rgba(0,0,0,0.000) 100%); mask-image: linear-gradient(90deg, rgba(0,0,0,1.000) calc(100% - 64.0px), rgba(0,0,0,0.972) calc(100% - 57.6px), rgba(0,0,0,0.896) calc(100% - 51.2px), rgba(0,0,0,0.784) calc(100% - 44.8px), rgba(0,0,0,0.648) calc(100% - 38.4px), rgba(0,0,0,0.500) calc(100% - 32.0px), rgba(0,0,0,0.352) calc(100% - 25.6px), rgba(0,0,0,0.216) calc(100% - 19.2px), rgba(0,0,0,0.104) calc(100% - 12.8px), rgba(0,0,0,0.028) calc(100% - 6.4px), rgba(0,0,0,0.000) 100%); }
.rp-poster-art .rp-cover { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 0; background: transparent; pointer-events: auto; }
/* Readability. Busy art behind the title is blurred into smooth color, so
   the words don't fight the detail; the shade on top is only as dark as the
   cover needs (bright or busy covers more, dark calm ones hardly any). Both
   come in on eased curves, with no visible edge. */
.rp-poster-blur { position: absolute; inset: 0; pointer-events: none;
  -webkit-backdrop-filter: blur(18px) saturate(1.1); backdrop-filter: blur(18px) saturate(1.1);
  -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.000) 50.0%, rgba(0,0,0,0.020) 52.8%, rgba(0,0,0,0.074) 55.7%, rgba(0,0,0,0.156) 58.5%, rgba(0,0,0,0.259) 61.3%, rgba(0,0,0,0.376) 64.2%, rgba(0,0,0,0.500) 67.0%, rgba(0,0,0,0.624) 69.8%, rgba(0,0,0,0.741) 72.7%, rgba(0,0,0,0.844) 75.5%, rgba(0,0,0,0.926) 78.3%, rgba(0,0,0,0.980) 81.2%, rgba(0,0,0,1.000) 84.0%); mask-image: linear-gradient(180deg, rgba(0,0,0,0.000) 50.0%, rgba(0,0,0,0.020) 52.8%, rgba(0,0,0,0.074) 55.7%, rgba(0,0,0,0.156) 58.5%, rgba(0,0,0,0.259) 61.3%, rgba(0,0,0,0.376) 64.2%, rgba(0,0,0,0.500) 67.0%, rgba(0,0,0,0.624) 69.8%, rgba(0,0,0,0.741) 72.7%, rgba(0,0,0,0.844) 75.5%, rgba(0,0,0,0.926) 78.3%, rgba(0,0,0,0.980) 81.2%, rgba(0,0,0,1.000) 84.0%); }
.rp-poster-shade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.000)) 44.0%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.020)) 48.7%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.074)) 53.3%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.156)) 58.0%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.259)) 62.7%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.376)) 67.3%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.500)) 72.0%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.624)) 76.7%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.741)) 81.3%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.844)) 86.0%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.926)) 90.7%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 0.980)) 95.3%, rgba(var(--rp-deep), calc(var(--shade, 0.4) * 1.000)) 100.0%); }
.rp-poster-l .rp-cover.is-drag { cursor: grab; }
.rp-poster-l.is-dragging, .rp-poster-l.is-dragging .rp-cover { cursor: grabbing; }
.rp-poster-txt { position: absolute; left: 28px; right: 36px; bottom: 28px; text-shadow: 0 1px 12px rgba(0,0,0,0.4), 0 0 2px rgba(0,0,0,0.25); }
.rp-poster-txt .rp-title { font-size: clamp(30px, 3.4vw, 46px); margin: 8px 0 10px; text-shadow: 0 1px 14px rgba(0,0,0,0.28), 0 0 2px rgba(0,0,0,0.22); text-wrap: balance; }
/* Big titles start a hair right of the small text above and below them:
   a font leaves room before its first letter, and at 40-60px that room is
   several pixels. Pulling the title left by a fraction of its size lines
   the letters up with "ALBUM" and the artist. The padding keeps the start
   of a letter with no such room inside the line clamp's clipping box. */
.rp-hero .rp-title, .rp-colour-head .rp-title, .rp-poster-txt .rp-title { margin-left: -0.09em; padding-left: 0.04em; }
/* A small, fixed gap under "ALBUM". Classic sets the same gap in
   LibraryPage.jsx (marginTop on the title). */
.rp-hero .rp-title, .rp-colour-head .rp-title, .rp-poster-txt .rp-title { margin-top: 3px; }
.rp-caps { font-size: 0.88em; letter-spacing: 0.015em; }
/* The two-line clamp clips at the line box, and at line-height 1.06 that
   cuts the tails off p, g, y and j. Room below the last line, taken back
   out of the gap under the title so the spacing doesn't change. */
.rp-title { padding-bottom: 0.16em; }
.rp-hero .rp-title, .rp-colour-head .rp-title { margin-bottom: calc(12px - 0.16em); }
.rp-poster-txt .rp-title { margin-bottom: calc(10px - 0.16em); }
.rp-poster-txt .rp-acts { margin-top: 18px; }
.rp-poster-txt .rp-ib:hover, .rp-poster-txt .rp-ib[aria-expanded="true"] { background: rgba(255,255,255,0.16); }

/* Cover banner: the artwork itself, wide and sharp across the top, fading
   into the page. The banner is the cover, so there's no separate tile. */
.rp-banner { position: relative; height: clamp(300px, 46vh, 440px); overflow: hidden; }
.rp-banner-art { position: absolute; inset: 0; }
.rp-banner-art img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center 38%; }
.rp-banner-art.is-mosaic { display: grid; grid-template-columns: repeat(4, 1fr); }
.rp-banner-fade { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0) 30%, rgba(var(--rp-deep),0.75) 76%, rgb(var(--rp-deep)) 100%); }
.rp-banner-txt { position: absolute; left: 36px; right: 36px; bottom: 22px; }
.rp-banner-txt .rp-title { font-size: clamp(36px, 5.2vw, 76px); }
.rp-banner-txt .rp-line { color: rgba(255,255,255,0.82); }
.rp-banner + .rp-bar { padding-top: 6px; }

/* Glass card: the cover blurred behind the top of the page, and a frosted
   card on it holding the cover, title and buttons. */
.rp-glow { position: absolute; top: 0; left: 0; right: 0; height: 0; pointer-events: none; will-change: transform; overflow: hidden; }
.rp-glow-bg { position: absolute; inset: -60px; background-size: cover; background-position: center; filter: blur(60px) saturate(1.4); opacity: 0.85; }
.rp-glow-dim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.05), rgba(0,0,0,0.4) 55%, rgb(var(--rp-deep)) 100%); }
.rp-glasshero { position: relative; margin: 62px 36px 24px; padding: 22px; border-radius: 20px; display: flex; align-items: center; gap: 26px;
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
  backdrop-filter: blur(20px) saturate(1.2); -webkit-backdrop-filter: blur(20px) saturate(1.2); }
.rp-glasshero .rp-cover { width: clamp(140px, 15vw, 180px); aspect-ratio: 1; border-radius: 12px; }
.rp-glasshero .rp-title { font-size: clamp(32px, 4vw, 58px); margin: 3px 0 calc(10px - 0.16em); }
.rp-glasshero .rp-acts { margin-top: 16px; }
.rp-glasshero .rp-ib:hover, .rp-glasshero .rp-ib[aria-expanded="true"] { background: rgba(255,255,255,0.18); }

/* Sticky column: a panel in the cover's color holds the cover, details
   and buttons and stays put; the songs scroll beside it. */
.rp-sticky { position: relative; display: grid; grid-template-columns: clamp(300px, 30%, 360px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
.rp-sticky-l { position: relative; overflow-y: auto; overflow-x: hidden; padding: 64px 26px 28px; scrollbar-width: none;
  background: linear-gradient(180deg, rgb(var(--rp-wash)), rgb(var(--rp-deep))); }
.rp-sticky-l::-webkit-scrollbar { display: none; }
.rp-sticky-l .rp-cover { width: 100%; aspect-ratio: 1; border-radius: 12px; }
.rp-sticky-l .rp-kind { margin-top: 20px; }
.rp-sticky-l .rp-title { font-size: clamp(26px, 2.6vw, 38px); margin: 3px 0 calc(8px - 0.16em); }
.rp-sticky-l .rp-meta { margin-top: 3px; }
.rp-sticky-l .rp-acts { margin-top: 18px; gap: 6px; flex-wrap: nowrap; }
.rp-sticky-l .rp-ib:hover, .rp-sticky-l .rp-ib[aria-expanded="true"] { background: rgba(0,0,0,0.25); }
.rp-sticky-r { position: relative; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 20px 24px 0; }

/* Soft rows (Poster): rounder, numbers in circles, play counts. */
.rp-list.is-soft { display: flex; flex-direction: column; gap: 2px; }
.rp-list.is-soft .sth-lrow { height: 58px; border-radius: 16px; padding: 0 12px 0 8px; }
.rp-list.is-soft .sth-lrow-n { height: 34px; }
.rp-list.is-soft .sth-lrow-num { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.08); font-size: 12.5px; font-weight: 700; color: rgba(255,255,255,0.78); }
.rp-list.is-soft .sth-lrow-play { left: 0; width: 32px; height: 32px; background: transparent; color: #fff; transition: background 0.14s ease; }
.rp-list.is-soft .rp-art { width: 44px; height: 44px; border-radius: 12px; }
.rp-list .sth-lrow.is-missing .rp-ttl { color: rgba(255,255,255,0.5) !important; }
.rp-list .sth-lrow.is-missing .rp-sub, .rp-list .sth-lrow.is-missing .sth-lrow-dim { opacity: 0.7; }
.rp-list .sth-lrow.is-missing:hover .rp-ttl { color: rgba(255,255,255,0.85) !important; }
.rp-save { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3); background: transparent; color: rgba(255,255,255,0.85);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background .15s ease, border-color .15s ease; }
.rp-save:hover { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.6); }
.rp-save:disabled { cursor: default; opacity: 0.6; }
.rp-sub { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-plays { font-size: 12px; color: rgba(255,255,255,0.55); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
`;

const ICONS = {
  back: <path d="M15 6l-6 6 6 6" />,
  shuffle: <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  edit: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.8" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
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

export function useFullAlbum(enabled, key, title, artist) {
  const [rows, setRows] = useState(() => (enabled ? fullAlbumCache.get(key) || null : null));
  useEffect(() => {
    if (!enabled) { setRows(null); return undefined; }
    if (fullAlbumCache.has(key)) { setRows(fullAlbumCache.get(key)); return undefined; }
    setRows(null);
    const a = api();
    if (!a?.spotifySearchAlbums || !a?.spotifyGetAlbumTracks) return undefined;
    let live = true;
    (async () => {
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
      if (live) setRows(out);
    })().catch(() => { /* offline or signed out: just your songs */ });
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

/* How far Poster's cover reaches past its column, to the song card's edge
   (matches .rp-poster-art in the CSS). */
const POSTER_EXT = 6;

/* Poster cover positions you've set by dragging: cover → object-position x.
   Keyed by the cover's address, or a short fingerprint of a long one (an
   embedded cover can be a whole image written out as text). */
const POSTER_POS_KEY = 'studio:posterPositions';
function posterKey(url) {
  if (!url || url.length <= 200) return url;
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `h:${url.length}:${(h >>> 0).toString(36)}`;
}
function loadPosterPositions() {
  try { return JSON.parse(localStorage.getItem(POSTER_POS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePosterPositions(map) {
  try {
    const keys = Object.keys(map);
    // Keep the newest few hundred.
    const trimmed = keys.length > 400 ? Object.fromEntries(keys.slice(-400).map((k) => [k, map[k]])) : map;
    localStorage.setItem(POSTER_POS_KEY, JSON.stringify(trimmed));
  } catch { /* storage full or off: the position just isn't kept */ }
}

/* "Artists in this playlist" under a playlist's songs. Off for now; set to
   true to bring the shelf back. */
const SHOW_PLAYLIST_ARTISTS = false;

export default function RecordPage({
  layout,
  data,          // detailData: { kind, title, by, art, customArt, tracks }
  tracks,        // after the in-page filter
  wash, deep, accUI, palette = [],
  exact = false, // the page colour is one you picked: paint it as is, no shading
  dark = false,  // Dark mode: neutral surfaces, no glow or blur taken from the art
  genres = [],
  libDetailKey,
  currentTrack, isPlaying,
  onPlayTrack, onTogglePlay, onToggleFavorite, onRemoveFromPlaylist,
  onMovePlaylistSong = null,   // (trackId, toIndex): a playlist's songs, by drag
  canManage, openRowMenu,
  coverFor, playCountFor, showPlayCounts,
  libAlbums = [], libArtists = [], onOpenAlbum, onOpenArtist, onBack,
  onChangeCover, onEditAlbum, onEditPlaylist, onDeletePlaylist,
  onPlayNext, onAddToQueue, onAddToPlaylist,   // (tracks, name) / (tracks, name) / (trackIds)
  moreOpen, setMoreOpen,
  bridge = null,  // saveRow / saveState for Spotify rows (StudioHome's mySpotifyBridge)
  fullAlbum = false, // Settings → Layout → Album Songs: the whole album, not just your songs
}) {
  const isAlbum = data.kind === 'album';
  const kindLabel = isAlbum ? 'Album' : 'Playlist';
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

  /* Under the list: the artist's other albums, or who's in the playlist. */
  const [moreTitle, moreAlbums] = useMemo(() => {
    if (!isAlbum) return ['', []];
    const who = primaryArtist(data.by).toLowerCase();
    const others = libAlbums.filter((a) => a.key !== libDetailKey);
    const mine = others.filter((a) => primaryArtist(a.artist).toLowerCase() === who);
    return [`More by ${primaryArtist(data.by)}`, mine.slice(0, 12)];
  }, [isAlbum, data.by, libAlbums, libDetailKey]);
  const plArtists = useMemo(() => {
    if (isAlbum || !SHOW_PLAYLIST_ARTISTS) return [];
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

  /* Poster shows a narrow slice of a square cover: the slice is moved to
     where the cover's subject is (coverFocus), worked out from the column's
     shape, so it follows the window as it resizes. The cover fades in once
     its slice is known, rather than appearing centered and then sliding. */
  const posterRef = useRef(null);
  const [posterBox, setPosterBox] = useState(null);
  const [focus, setFocus] = useState({ src: null, profile: null });
  const posterArt = layout === 'poster' && !mosaic ? data.art : null;
  useLayoutEffect(() => {
    const el = posterRef.current;
    if (!el || !posterArt) return undefined;
    const measure = () => setPosterBox((b) => {
      const w = el.clientWidth; const h = el.clientHeight;
      return b && b.w === w && b.h === h ? b : { w, h };
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [posterArt]);
  useEffect(() => {
    if (!posterArt) return undefined;
    let live = true;
    coverProfile(posterArt).then((profile) => { if (live) setFocus({ src: posterArt, profile }); });
    return () => { live = false; };
  }, [posterArt]);
  const focusReady = focus.src === posterArt;
  /* The cover box is the column plus POSTER_EXT (out to the song card's
     edge). The subject is fitted into the column, then that slice is
     expressed as a position in the slightly wider box. */
  const boxW = posterBox ? posterBox.w + POSTER_EXT : 0;
  const boxSlack = posterBox ? 1 - boxW / posterBox.h : 0; // share of the cover cut off
  const autoX = (() => {
    if (!focusReady || !posterBox || posterBox.h <= 0 || boxSlack <= 0) return 50;
    const clear = posterBox.w / posterBox.h;
    const start = (slicePosition(focus.profile, clear) / 100) * Math.max(0, 1 - clear);
    return Math.max(0, Math.min(100, (start / boxSlack) * 100));
  })();
  /* Or where you put it: drag the cover sideways to move it, double-click to
     go back to the automatic spot. Saved per cover. */
  const [savedX, setSavedX] = useState(loadPosterPositions);
  const [dragX, setDragX] = useState(null);
  const dragRef = useRef(null);
  const justDragged = useRef(false);
  const posKey = posterKey(posterArt);
  const manualX = posKey ? savedX[posKey] : undefined;
  const posterX = dragX ?? manualX ?? autoX;
  // How far the cover can slide, in px: it's as wide as the column is tall.
  const posterSlack = posterBox ? posterBox.h - boxW : 0;
  const canDrag = !!posterArt && posterSlack > 2;
  const savePosterX = (x) => setSavedX((m) => {
    const next = { ...m };
    if (x == null) delete next[posKey]; else next[posKey] = Math.round(x * 10) / 10;
    savePosterPositions(next);
    return next;
  });
  const shade = (() => {
    if (!focusReady || !posterBox || !posterBox.h) return null;
    const w = Math.max(boxW, posterBox.h); // the cover's drawn width
    const left = boxSlack > 0 ? (posterX / 100) * (w - boxW) : 0;
    return titleShade(focus.profile, (left + 28) / w, (left + posterBox.w - 36) / w);
  })();
  const posterDrag = canDrag ? {
    onPointerDown: (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, .rp-poster-txt, .rp-menu')) return;
      dragRef.current = { x: e.clientX, from: posterX, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 4) return;
      d.moved = true;
      d.cur = Math.max(0, Math.min(100, d.from - (dx / posterSlack) * 100));
      setDragX(d.cur);
    },
    onPointerUp: () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.moved) return;
      justDragged.current = true;
      savePosterX(d.cur);
      setDragX(null);
    },
    onPointerCancel: () => { dragRef.current = null; setDragX(null); },
    // A drag that ends over the cover isn't a click (a playlist's cover opens "Change cover").
    onClickCapture: (e) => { if (justDragged.current) { justDragged.current = false; e.stopPropagation(); e.preventDefault(); } },
    onDoubleClick: (e) => { if (!e.target.closest('button, a, input, .rp-poster-txt, .rp-menu')) savePosterX(null); },
  } : null;

  const fullRows = useFullAlbum(isAlbum && !!bridge && fullAlbum, libDetailKey, data.title, data.by);
  /* The album in Spotify's order: each song paired with your copy when you
     have it. Songs of yours Spotify doesn't list stay, at the end. Only
     used when something is actually missing. */
  const merged = useMemo(() => mergeAlbum(fullRows, data.tracks), [fullRows, data.tracks]);
  const queue = useMemo(() => (merged ? merged.map((x) => x.lib || streamTrack(x.row)) : null), [merged]);
  const missingCount = merged ? merged.filter((x) => !x.lib).length : 0;

  const totalMs = data.tracks.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
  const year = isAlbum ? yearOf(data.tracks) : null;
  const fullMs = merged ? merged.reduce((n, x) => n + (x.lib ? (Number(x.lib.duration) || 0) * 1000 : Number(x.row.durationMs) || 0), 0) : totalMs;
  const meta = merged
    ? [year, `${merged.length} songs`, `${merged.length - missingCount} saved`, formatTotalMs(fullMs)].filter(Boolean).join(' · ')
    : [year, `${data.tracks.length} ${data.tracks.length === 1 ? 'song' : 'songs'}`, formatTotalMs(totalMs)].filter(Boolean).join(' · ');
  const oneArtist = isAlbum && new Set(data.tracks.map((t) => (t.artist || '').toLowerCase())).size <= 1;
  /* Sticky column's songs share the page with the column: when that leaves
     them little room, the album column goes. */
  const [splitW, setSplitW] = useState(0);
  const showAlbumCol = !isAlbum && !(layout === 'sticky' && splitW && splitW < 640);
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
    <div className={`rp-cover${opts.shadow === false ? '' : ' is-shadow'}${!isAlbum && onChangeCover ? ' is-edit sth-plcover' : ''}${opts.drag ? ' is-drag' : ''}`}
      onClick={!isAlbum && onChangeCover ? onChangeCover : undefined}
      title={opts.drag ? 'Drag to move the cover · double-click to reset' : (!isAlbum && onChangeCover ? 'Change cover' : undefined)}>
      {mosaic
        ? <div className="rp-mosaic">{mosaic.map((a) => <img key={a} src={a} alt="" draggable={false} />)}</div>
        : data.art ? <HiResImg src={data.art} style={opts.imgStyle} /> : null}
      {!isAlbum && onChangeCover && !opts.noVeil ? (
        <div className="sth-plcover-veil">
          <Icon name="edit" size={24} />
          <span style={{ fontSize: 11.5, fontWeight: 650, marginTop: 7 }}>Change cover</span>
        </div>
      ) : null}
    </div>
  );

  // With the whole album known, Play plays all of it (your copies where you have them).
  const playList = queue || data.tracks;
  const playAll = () => onPlayTrack?.(playList[0], playList);
  /* Playing from here: Play turns into Pause (and pauses rather than
     starting over), on the page and in the sticking bar. */
  const curSid = spotifyIdOf(currentTrack);
  const playingHere = !!currentTrack && playList.some((t) => t && (t.id === currentTrack.id || (!!curSid && spotifyIdOf(t) === curSid)));
  const showPause = playingHere && isPlaying;
  const playPause = () => (playingHere && onTogglePlay ? onTogglePlay() : playAll());
  const shuffle = () => { const sh = [...playList].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); };
  /* The "…" menu, for albums and playlists alike: queue it, add it to a
     playlist, and (a playlist's own) rename, cover and delete. The same menu
     opens from the page's buttons and from the bar once it has stuck. */
  const menuItems = [
    onPlayNext && playList.length ? { label: 'Play next', run: () => onPlayNext(playList, data.title) } : null,
    onAddToQueue && playList.length ? { label: 'Add to queue', run: () => onAddToQueue(playList, data.title) } : null,
    onAddToPlaylist && data.tracks.length ? { label: 'Add to playlist…', run: () => onAddToPlaylist(data.tracks.map((t) => t.id)) } : null,
    !isAlbum && onEditPlaylist ? { label: 'Rename playlist', run: onEditPlaylist, gap: true } : null,
    !isAlbum && onChangeCover ? { label: 'Change cover', run: onChangeCover } : null,
    !isAlbum && onDeletePlaylist ? { label: 'Delete playlist', run: onDeletePlaylist, danger: true } : null,
  ].filter(Boolean);
  /* The "…" menu closes on a click anywhere else, or Escape, like every
     other menu. Clicks on "…" itself are left to its own toggle. */
  useEffect(() => {
    if (!moreOpen) return undefined;
    const down = (e) => { if (!e.target.closest?.('.rp-menu, [data-rp-more]')) setMoreOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    // It's placed against the window, so a scroll underneath it closes it.
    const scroll = (e) => { if (!stuckRef.current && !e.target.closest?.('.rp-menu')) setMoreOpen(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); };
  }, [moreOpen, setMoreOpen]);
  const pageMenu = () => {
    if (!menuAt || !moreBtnRef.current) return null;
    const host = moreBtnRef.current.closest('.sth-root') || document.body;
    return createPortal(moreMenu({ position: 'fixed', right: 'auto', top: 'auto', zIndex: 200, ...menuAt }), host);
  };
  const moreMenu = (style) => (
    <span className="rp-menu" role="menu" style={style}>
      {menuItems.map((it) => (
        <button key={it.label} type="button" role="menuitem" className="sth-mi"
          style={{ ...(it.danger ? { color: 'var(--danger)' } : null), ...(it.gap ? { marginTop: 4, boxShadow: '0 -1px 0 rgba(255,255,255,0.08)', borderRadius: '0 0 8px 8px' } : null) }}
          onClick={() => { setMoreOpen(false); it.run(); }}>{it.label}</button>
      ))}
    </span>
  );
  const actions = (opts = {}) => (
    <div className="rp-acts">
      {opts.shuffleFirst ? <button type="button" className="rp-ib" title="Shuffle" aria-label="Shuffle" onClick={shuffle}><Icon name="shuffle" /></button> : null}
      <button type="button" className="rp-play" onClick={playPause} aria-label={`${showPause ? 'Pause' : 'Play'} ${data.title}`}>{showPause ? <PauseIcon size={15} /> : <PlayIcon size={15} />}{showPause ? 'Pause' : 'Play'}</button>
      {opts.shuffleFirst ? null : <button type="button" className="rp-ib" title="Shuffle" aria-label="Shuffle" onClick={shuffle}><Icon name="shuffle" /></button>}
      {isAlbum && onEditAlbum ? <button type="button" className="rp-ib" title="Edit album details" aria-label="Edit album details" onClick={onEditAlbum}><Icon name="edit" size={16} /></button> : null}
      {menuItems.length ? (
        <span style={{ position: 'relative' }}>
          <button type="button" className="rp-ib" title="More" aria-label="More" data-rp-more="" ref={moreBtnRef} aria-expanded={moreOpen && !stuck} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" /></button>
          {moreOpen && !stuck ? pageMenu() : null}
        </span>
      ) : null}
      {opts.genres && genres.length ? genres.map((g) => <span key={g} className="rp-pill">{g}</span>) : null}
      {/* Poster and Sticky column have no top bar: their list's arrows go with the other actions. */}
      {SPLIT.has(layout) && !isAlbum ? <ScrollJump scrollRef={glassRef} watch={tracks.length} size={34} /> : null}
    </div>
  );

  const heart = (t) => (onToggleFavorite ? (
    <button type="button" className="sth-lrow-more" onClick={() => onToggleFavorite(t.id)}
      title={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
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
  const titleCell = (t, playing, sub) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      {!isAlbum ? (coverFor(t) ? <img className="rp-art" src={coverFor(t)} alt="" draggable={false} /> : <span className="rp-art" />) : null}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span className="rp-ttl" style={{ fontSize: 15, fontWeight: 650, color: playing ? `rgb(${accUI})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.explicit ? <ExplicitBadge /> : null}
        </div>
        {sub === 'soft'
          ? ((!isAlbum || !oneArtist) ? <div className="rp-sub">{isAlbum ? t.artist : [t.artist, t.album].filter(Boolean).join(' · ')}</div> : null)
          : (oneArtist ? null : <div className="rp-sub">{t.artist}</div>)}
      </div>
    </div>
  );

  const totalPlays = useMemo(() => data.tracks.reduce((n, t) => n + playCountFor(t.id), 0), [data.tracks, playCountFor]);

  const saveBtn = (row) => {
    const st = bridge?.saveState(row);
    if (st === 'saved') return <span className="rp-save" title="In your library" style={{ borderColor: 'transparent' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12.5 10 17.5 19 7" /></svg></span>;
    return (
      <button type="button" className="rp-save" disabled={st === 'busy'} onClick={() => bridge?.saveRow(row)}
        title={st === 'busy' ? 'Saving…' : 'Add to your library'} aria-label={`Add ${row.title} to your library`}>
        {st === 'busy'
          ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>}
      </button>
    );
  };

  const renderList = (soft) => {
    const softCols = `44px minmax(0,1fr) auto 48px ${!isAlbum && onRemoveFromPlaylist ? '64px' : '36px'}`;
    /* Per-song plays in the Poster list: on albums only with Settings →
       Library → Play counts in lists, like the other layouts' plays column. */
    const softPlays = !isAlbum || showPlayCounts;
    const items = merged || tracks.map((t) => ({ lib: t, row: null, key: t.id }));
    const order = queue || tracks;
    return (
      <div className={`rp-list${soft ? ' is-soft' : ''}${layout === 'twin' ? ' is-hair' : ''}`}>
        {items.length ? items.map((it, i) => {
          const t = it.lib || streamTrack(it.row);
          const missing = !it.lib;
          const playing = missing ? spotifyIdOf(currentTrack) === it.row.spotifyId : currentTrack?.id === t.id;
          const plays = missing ? 0 : playCountFor(t.id);
          const num = isAlbum ? (it.row?.trackNumber || t.trackNumber || i + 1) : i + 1;
          return (
            <div key={it.key} className={`sth-lrow${playing ? ' is-playing' : ''}${missing ? ' is-missing' : ''}${missing ? '' : songDrag.cls(i)}`}
              {...(missing ? {} : songDrag.props(i, t.id))}
              style={soft ? { gridTemplateColumns: softCols } : { gridTemplateColumns: cols, height: rowH }}
              onDoubleClick={() => onPlayTrack?.(order[i], order)}
              /* Every song has the menu; one you don't have yet gets the
                 Spotify version of it (play, save, add to a playlist). */
              onContextMenu={missing ? (e) => openRowMenu(e, null, { row: it.row }) : canManage ? (e) => openRowMenu(e, t) : undefined}>
              <div className="sth-lrow-n">
                {playing
                  ? <span style={{ display: 'inline-flex', width: soft ? 32 : 'auto', justifyContent: 'center' }}><PlayingBars acc={accUI} playing={isPlaying} /></span>
                  : <span className="sth-lrow-num">{num}</span>}
                <RowPlayButton playing={playing} isPlaying={isPlaying} title={t.title}
                  onPlay={() => onPlayTrack?.(order[i], order)} onTogglePlay={onTogglePlay} />
              </div>
              {titleCell(t, playing, soft ? 'soft' : 'plain')}
              {soft ? <div className="rp-plays">{plays && softPlays ? `${plays} ${plays === 1 ? 'play' : 'plays'}` : ''}</div> : null}
              {!soft && showAlbumCol ? <div className="sth-lrow-dim sth-lcol-album">{t.album}</div> : null}
              {!soft && showPlaysCol ? <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{missing ? '' : plays}</div> : null}
              <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{formatTime(t.duration)}</div>
              <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>{missing ? saveBtn(it.row) : <>{heart(t)}{removeBtn(t)}</>}</div>
            </div>
          );
        }) : <div className="rp-empty">No songs yet.</div>}
      </div>
    );
  };
  const list = renderList(false);

  const more = moreAlbums.length && !merged ? (
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
  /* An all-caps title reads bigger and heavier than the same words in lower
     case, and crowds the lines around it: set it a little smaller with a
     touch of tracking, the way capitals are set by hand. */
  const allCaps = isAllCaps(data.title);
  const title = <h1 className="rp-title">{allCaps ? <span className="rp-caps">{data.title}</span> : data.title}</h1>;
  /* Who made it, on albums. A playlist is always yours, so it skips the
     name and goes straight to the details. */
  const showBy = isAlbum && !!data.by;
  const byLine = <div className="rp-line">{showBy ? <><span className="rp-by">{artistLink}</span> · </> : null}{meta}</div>;
  /* What the blurred layers are made of: the cover, or for a four-cover
     playlist all four in their places, so the glow has every colour the
     cover does rather than only the first album's. */
  const blurStyle = mosaic ? {
    backgroundImage: mosaic.map((a) => `url("${a}")`).join(', '),
    backgroundSize: '50% 50%',
    backgroundPosition: '0 0, 100% 0, 0 100%, 100% 100%',
    backgroundRepeat: 'no-repeat',
  } : data.art ? { backgroundImage: `url("${data.art}")` } : null;
  /* The blurred backdrops. Dark mode keeps the artwork itself (covers,
     banners) but drops the colored haze around it. */
  const glow = dark ? null : blurStyle;

  /* Big header: the glow layer is as tall as the hero and moves with the
     scroll, set straight on the element so scrolling doesn't re-render. */
  const scrollRef = useRef(null);
  const glassRef = useRef(null); // the poster and sticky lists, which scroll on their own
  const heroRef = useRef(null);
  useLayoutEffect(() => {
    const el = glassRef.current;
    if (layout !== 'sticky' || !el) return undefined;
    const ro = new ResizeObserver(() => setSplitW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  const heroPaintRef = useRef(null);
  useLayoutEffect(() => {
    const sc = scrollRef.current; const hero = heroRef.current; const paint = heroPaintRef.current;
    if ((layout !== 'header' && layout !== 'glass') || !sc || !hero || !paint) return undefined;
    const sync = () => {
      paint.style.height = `${hero.offsetHeight}px`;
      paint.style.transform = `translate3d(0, ${-sc.scrollTop}px, 0)`;
    };
    sync();
    sc.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(hero);
    return () => { sc.removeEventListener('scroll', sync); ro.disconnect(); };
  }, [layout]);

  /* A bar that sticks to the top of the scrolling layouts, like the artist
     page's: the back button lives in it (so songs and covers no longer slide
     under a floating one), and once the title has scrolled away it fills
     in and carries a small cover, the name and play. */
  const [stuck, setStuck] = useState(false);
  const stuckRef = useRef(false);
  /* The page's own "…" menu is drawn over the whole app, placed against its
     button: inside the page it was cut off by whatever clipped the button
     (Poster's cover column cut it in half). It opens upward when there isn't
     room below. Drawn into the app's root, so it keeps the theme's colors. */
  const moreBtnRef = useRef(null);
  const [menuAt, setMenuAt] = useState(null);
  useLayoutEffect(() => {
    const btn = moreBtnRef.current;
    if (!moreOpen || stuck || !btn) { setMenuAt(null); return; }
    const r = btn.getBoundingClientRect();
    const h = menuItems.length * 34 + 16;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 208));
    setMenuAt(r.bottom + 6 + h <= window.innerHeight - 8
      ? { left, top: r.bottom + 6 }
      : { left, bottom: window.innerHeight - r.top + 6 });
  }, [moreOpen, stuck, menuItems.length]);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || SPLIT.has(layout)) { stuckRef.current = false; setStuck(false); return undefined; }
    const check = () => {
      const t = sc.querySelector('.rp-title');
      const now = t ? t.getBoundingClientRect().bottom < sc.getBoundingClientRect().top + 56 : sc.scrollTop > 120;
      if (now !== stuckRef.current) { stuckRef.current = now; setStuck(now); }
    };
    check();
    sc.addEventListener('scroll', check, { passive: true });
    return () => sc.removeEventListener('scroll', check);
  }, [layout, data.title]);
  const detail = isAlbum
    ? [data.by, year, `${(merged || data.tracks).length} songs`].filter(Boolean).join(' · ')
    : [`${data.tracks.length} ${data.tracks.length === 1 ? 'song' : 'songs'}`, formatTotalMs(totalMs)].filter(Boolean).join(' · ');
  const topBar = (
    <div className={`rp-topbar${stuck ? ' is-stuck' : ''}`}>
      <button type="button" className="rp-back" onClick={onBack} title="Back" aria-label="Back"><Icon name="back" size={16} /></button>
      <div className="rp-topbar-id" aria-hidden={!stuck}>
        <span className="rp-topbar-art" style={blurStyle || undefined} />
        <span className="rp-topbar-txt"><b>{data.title}</b>{detail ? <span>{detail}</span> : null}</span>
      </div>
      <div className="rp-topbar-acts" aria-hidden={!stuck}>
        {/* A playlist can run to thousands of songs: top and end are a click
            away, up here where they're always in reach and never over a song. */}
        {!isAlbum ? <ScrollJump scrollRef={scrollRef} watch={`${layout}:${tracks.length}`} size={36} /> : null}
        <button type="button" className="rp-topbar-play" onClick={playPause} tabIndex={stuck ? 0 : -1} aria-label={`${showPause ? 'Pause' : 'Play'} ${data.title}`}>
          {showPause ? <PauseIcon size={13} /> : <PlayIcon size={13} />}{showPause ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="rp-topbar-ib" tabIndex={stuck ? 0 : -1} title="Shuffle" aria-label={`Shuffle ${data.title}`} onClick={shuffle}><Icon name="shuffle" size={18} /></button>
        {isAlbum && onEditAlbum ? (
          <button type="button" className="rp-topbar-ib" tabIndex={stuck ? 0 : -1} title="Edit album details" aria-label="Edit album details" onClick={onEditAlbum}><Icon name="edit" size={16} /></button>
        ) : null}
        {menuItems.length ? (
          <span style={{ position: 'relative' }}>
            <button type="button" className="rp-topbar-ib" tabIndex={stuck ? 0 : -1} title="More" aria-label="More" data-rp-more="" aria-expanded={stuck && moreOpen} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" size={18} /></button>
            {stuck && moreOpen ? moreMenu({ left: 'auto', right: 0, top: 42 }) : null}
          </span>
        ) : null}
      </div>
    </div>
  );

  /* Each layout's colour, painted on the page (which doesn't scroll). */
  const base = '12, 12, 13';
  const pal = [0, 1, 2, 3].map((i) => palette[i] || palette[0] || wash);
  /* A four-cover playlist's palette is one colour per cover, so the page can
     carry each where its cover sits: the first is the wash itself (top
     left), the others glow from the other three corners. */
  const tileGlows = (a) => (mosaic && palette.length > 1 ? [
    `radial-gradient(65% 60% at 100% 0%, rgba(${pal[1]},${a}), rgba(${pal[1]},0) 100%)`,
    `radial-gradient(60% 55% at 0% 100%, rgba(${pal[2]},${a * 0.8}), rgba(${pal[2]},0) 100%)`,
    `radial-gradient(60% 55% at 100% 100%, rgba(${pal[3]},${a * 0.8}), rgba(${pal[3]},0) 100%)`,
  ] : []);
  const fullColour = exact ? `rgb(${wash})` : [
    'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.3) 100%)',
    ...tileGlows(0.75),
    `rgb(${wash})`,
  ].join(', ');
  let background = {
    poster: `rgb(${base})`,
    sticky: `rgb(${base})`,
    banner: `rgb(${deep})`,
    glass: `rgb(${deep})`,
    colour: fullColour,
    overlap: `rgb(${wash})`, // one flat color, top to bottom
    header: [...tileGlows(0.3), `linear-gradient(180deg, rgba(${wash},0.3) 0%, rgba(${wash},0.14) 55%, rgba(${wash},0.08) 100%)`, `rgb(${base})`].join(', '),
    titleart: `rgb(${deep})`,
    twin: `linear-gradient(180deg, rgba(${wash},0.6) 0, rgba(${wash},0) 480px), rgb(${deep})`,
  }[layout] || `rgb(${base})`;
  if (dark) background = `rgb(${deep})`;

  let body;
  if (layout === 'header') {
    body = (
      <>
      {/* The hero's glow sits under the scroller, not in it, so it spans the
          scrollbar strip too; it follows the scroll (see heroPaintRef). */}
      <div className="rp-hero-paint" ref={heroPaintRef}>
        {glow ? <div className="rp-hero-bg" style={glow} /> : null}
        <div className="rp-hero-dim" />
      </div>
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {topBar}
        <div className="rp-hero" ref={heroRef}>
          {cover()}
          <div className="rp-hero-txt">{kind}{title}{byLine}{actions({ genres: true })}</div>
        </div>
        <div className="rp-pad">{list}{more}</div>
      </div>
      </>
    );
  } else if (layout === 'banner') {
    body = (
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {topBar}
        <div className="rp-banner">
          <div className={`rp-banner-art${mosaic ? ' is-mosaic' : ''}`}>
            {mosaic ? mosaic.map((a) => <img key={a} src={a} alt="" draggable={false} />) : data.art ? <HiResImg src={data.art} /> : null}
          </div>
          <div className="rp-banner-fade" />
          <div className="rp-banner-txt">{kind}{title}{byLine}</div>
        </div>
        <div className="rp-bar">{actions({ genres: true })}</div>
        <div className="rp-pad">{list}{more}</div>
      </div>
    );
  } else if (layout === 'glass') {
    body = (
      <>
      <div className="rp-glow" ref={heroPaintRef}>
        {glow ? <div className="rp-glow-bg" style={glow} /> : null}
        <div className="rp-glow-dim" />
      </div>
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {topBar}
        <div ref={heroRef} style={{ paddingTop: 1 }}>
          <div className="rp-glasshero">
            {cover()}
            <div className="rp-info">{kind}{title}{byLine}{actions()}</div>
          </div>
        </div>
        <div className="rp-pad">{list}{more}</div>
      </div>
      </>
    );
  } else if (layout === 'sticky') {
    body = (
      <div className="rp-sticky">
        <div className="rp-sticky-l">
          {back}
          {cover()}
          {kind}{title}
          {showBy ? <div className="rp-by">{artistLink}</div> : null}
          <div className="rp-meta">{meta}</div>
          {actions()}
        </div>
        <div className="rp-sticky-r sth-libscroll" ref={glassRef}>{list}{more}</div>
      </div>
    );
  } else if (layout === 'titleart' || layout === 'twin' || layout === 'overlap') {
    const artImgs = mosaic ? mosaic.map((a) => <img key={a} src={a} alt="" draggable={false} />) : data.art ? <HiResImg src={data.art} /> : null;
    let head;
    if (layout === 'titleart') {
      head = (
        <>
          <div className="rp-tart">
            <div className={`rp-banner-art${mosaic ? ' is-mosaic' : ''}`}>{artImgs}</div>
            <div className="rp-tart-fade" />
            <div className="rp-tart-txt">{kind}{title}{byLine}</div>
          </div>
          <div className="rp-cmid">{actions()}</div>
        </>
      );
    } else if (layout === 'twin') {
      head = (
        <div className="rp-cmid rp-twin">
          {cover()}
          {title}
          {showBy ? <div className="rp-twin-by">{artistLink}</div> : null}
          <div className="rp-meta">{[isAlbum ? genres[0] : null, meta].filter(Boolean).join(' · ')}</div>
          <div className="rp-twin-row">
            <button type="button" className="rp-twin-btn is-play" onClick={playPause} aria-label={`${showPause ? 'Pause' : 'Play'} ${data.title}`}>
              {showPause ? <PauseIcon size={15} /> : <PlayIcon size={15} />}{showPause ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="rp-twin-btn" onClick={shuffle} aria-label={`Shuffle ${data.title}`}><Icon name="shuffle" />Shuffle</button>
            {/* Off to the side, so Play and Shuffle stay centered. */}
            <div className="rp-twin-extra">
              {isAlbum && onEditAlbum ? <button type="button" className="rp-ib" title="Edit album details" aria-label="Edit album details" onClick={onEditAlbum}><Icon name="edit" size={16} /></button> : null}
              {menuItems.length ? (
                <span style={{ position: 'relative' }}>
                  <button type="button" className="rp-ib" title="More" aria-label="More" data-rp-more="" ref={moreBtnRef} aria-expanded={moreOpen && !stuck} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" /></button>
                  {moreOpen && !stuck ? pageMenu() : null}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      );
    } else {
      head = <div className="rp-cmid rp-ovl">{cover()}{title}{byLine}{actions()}</div>;
    }
    body = (
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {topBar}
        {head}
        {layout === 'twin'
          ? <div className="rp-pad" style={{ padding: '0 36px' }}>{list}{more}</div>
          : <div className="rp-ccol">{list}{more}</div>}
      </div>
    );
  } else if (layout === 'colour') {
    body = (
      <div className={`rp-scroll sth-libscroll${stuck ? ' is-stuck' : ''}`} ref={scrollRef}>
        {topBar}
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
        {glow ? <div className="rp-backdrop" style={glow} /> : null}
        <div className="rp-backdrop-dim" />
        <div className={`rp-poster-l${dragX != null ? ' is-dragging' : ''}`} ref={posterRef} {...posterDrag}>
          <div className="rp-poster-art">
            {cover({
              shadow: false, noVeil: true, drag: canDrag,
              imgStyle: {
                objectPosition: `${posterX}% 50%`,
                opacity: focusReady || manualX != null ? 1 : 0,
                transition: dragX != null ? 'opacity 0.35s ease' : 'opacity 0.35s ease, object-position 0.5s cubic-bezier(0.22,1,0.36,1)',
              },
            })}
            <div className="rp-poster-blur" />
            <div className="rp-poster-shade" style={shade == null ? undefined : { '--shade': shade.toFixed(3) }} />
          </div>
          {back}
          <div className="rp-poster-txt">
            {kind}{title}
            <div className="rp-line">{showBy ? <><span className="rp-by">{artistLink}</span> · </> : null}{meta}{totalPlays ? ` · ${totalPlays} ${totalPlays === 1 ? 'play' : 'plays'}` : ''}</div>
            {actions()}
          </div>
        </div>
        <div className="rp-glasscol"><div className="rp-glass sth-libscroll" ref={glassRef}>{renderList(true)}{more}</div></div>
      </div>
    );
  }

  return (
    <div className={`rp${layout === 'colour' || layout === 'overlap' ? ' is-colour' : ''}${dark ? ' is-dark' : ''}`} style={{ '--rp-wash': wash, '--rp-deep': deep, background }}>
      <style>{CSS}</style>
      {body}
    </div>
  );
}

/* Settings → Layout: a small drawing of each layout. */
const SKETCH = {
  header: <><rect x="0" y="0" width="96" height="28" className="w" /><rect x="8" y="6" width="18" height="18" rx="3" className="a" /><rect x="30" y="14" width="34" height="7" rx="3" className="t" /><rect x="8" y="33" width="10" height="5" rx="2.5" className="p" /><rect x="8" y="43" width="80" height="3" rx="1.5" /><rect x="8" y="50" width="80" height="3" rx="1.5" /></>,
  titleart: <><rect x="0" y="0" width="96" height="34" className="img" /><rect x="28" y="13" width="40" height="7" rx="3.5" className="p" /><rect x="43" y="30" width="10" height="5" rx="2.5" className="p" /><rect x="20" y="42" width="56" height="3" rx="1.5" /><rect x="20" y="50" width="56" height="3" rx="1.5" /></>,
  twin: <><rect x="0" y="0" width="96" height="30" className="w" /><rect x="38" y="5" width="20" height="20" rx="3" className="a" /><rect x="34" y="28" width="28" height="4" rx="2" className="t" /><rect x="29" y="35" width="18" height="5" rx="2.5" className="t" /><rect x="49" y="35" width="18" height="5" rx="2.5" className="t" /><rect x="8" y="45" width="80" height="1" /><rect x="8" y="52" width="80" height="1" /></>,
  overlap: <><rect x="0" y="0" width="96" height="60" className="w full" /><rect x="38" y="5" width="20" height="20" rx="3" className="a" /><rect x="33" y="29" width="30" height="4" rx="2" className="t" /><rect x="43" y="36" width="10" height="5" rx="2.5" className="p" /><rect x="20" y="46" width="56" height="1" /><rect x="20" y="53" width="56" height="1" /></>,
  colour: <><rect x="0" y="0" width="96" height="60" className="w full" /><rect x="8" y="7" width="20" height="20" rx="3" className="a" /><rect x="32" y="12" width="32" height="5" rx="2.5" className="t" /><rect x="32" y="20" width="12" height="5" rx="2.5" className="p" /><rect x="8" y="36" width="80" height="1" /><rect x="8" y="44" width="80" height="1" /><rect x="8" y="52" width="80" height="1" /></>,
  banner: <><rect x="0" y="0" width="96" height="30" className="img" /><rect x="8" y="18" width="34" height="6" rx="3" className="p" /><rect x="8" y="34" width="10" height="5" rx="2.5" className="p" /><rect x="8" y="44" width="80" height="3" rx="1.5" /><rect x="8" y="51" width="80" height="3" rx="1.5" /></>,
  glass: <><rect x="0" y="0" width="96" height="36" className="w" /><rect x="7" y="6" width="82" height="24" rx="4" className="c" /><rect x="11" y="9" width="17" height="17" rx="2.5" className="a" /><rect x="32" y="12" width="30" height="5" rx="2.5" className="t" /><rect x="32" y="20" width="10" height="4" rx="2" className="p" /><rect x="8" y="42" width="80" height="3" rx="1.5" /><rect x="8" y="50" width="80" height="3" rx="1.5" /></>,
  sticky: <><rect x="0" y="0" width="34" height="60" className="w full" /><rect x="5" y="6" width="24" height="24" rx="3" className="a" /><rect x="5" y="35" width="20" height="4" rx="2" className="t" /><rect x="5" y="43" width="10" height="5" rx="2.5" className="p" /><rect x="40" y="8" width="50" height="3" rx="1.5" /><rect x="40" y="16" width="50" height="3" rx="1.5" /><rect x="40" y="24" width="50" height="3" rx="1.5" /><rect x="40" y="32" width="50" height="3" rx="1.5" /><rect x="40" y="40" width="50" height="3" rx="1.5" /></>,
  poster: <><rect x="0" y="0" width="38" height="60" className="a" /><rect x="5" y="44" width="24" height="4" rx="2" className="t" /><rect x="5" y="51" width="11" height="5" rx="2.5" className="p" /><rect x="44" y="8" width="46" height="3" rx="1.5" /><rect x="44" y="16" width="46" height="3" rx="1.5" /><rect x="44" y="24" width="46" height="3" rx="1.5" /><rect x="44" y="32" width="46" height="3" rx="1.5" /><rect x="44" y="40" width="46" height="3" rx="1.5" /></>,
};
/* The layouts by family, and a line on each, for the chooser in Settings. */
export const LAYOUT_FAMILIES = [
  ['Header', ['colour', 'header', 'banner', 'glass']],
  ['Side', ['poster', 'sticky']],
  ['Centered', ['titleart', 'twin', 'overlap']],
];
const LAYOUT_NOTES = {
  colour: 'The whole page in one color, with the cover and title side by side.',
  header: 'A big title beside the cover, with the cover’s colors glowing behind it.',
  banner: 'The artwork itself across the top, with the title over it.',
  glass: 'A frosted card with the cover, title and buttons, over a blur of the art.',
  poster: 'The cover fills the left side, and the songs scroll on a glass card beside it.',
  sticky: 'A panel with the cover and details stays put while the songs scroll beside it.',
  titleart: 'The artwork across the top, with the title centered on it.',
  twin: 'The cover, title and two even buttons, Play and Shuffle, all centered.',
  overlap: 'One solid color, with the cover, title and songs centered.',
};
const layoutName = (id) => titleCase((RECORD_LAYOUTS.find(([x]) => x === id) || [id, id])[1]);
const familyOf = (id) => (LAYOUT_FAMILIES.find(([, ids]) => ids.includes(id)) || ['Header'])[0];

const PICKER_CSS = `
.rls svg, .rlc svg { display: block; width: 100%; height: auto; border-radius: 7px; background: #111113; }
.rls svg rect, .rls svg circle, .rls svg ellipse, .rlc svg rect, .rlc svg circle, .rlc svg ellipse { fill: rgba(255,255,255,0.22); }
.rls svg .a, .rlc svg .a { fill: rgba(255,255,255,0.75); }
.rls svg .t, .rlc svg .t { fill: rgba(255,255,255,0.6); }
.rls svg .p, .rlc svg .p { fill: #fff; }
.rls svg .w, .rlc svg .w { fill: rgba(120,150,125,0.45); }
.rls svg .w.full, .rlc svg .w.full { fill: rgba(110,140,115,0.85); }
.rls svg .c, .rlc svg .c { fill: rgba(255,255,255,0.08); }
.rls svg .img, .rlc svg .img { fill: rgba(255,255,255,0.4); }

/* In the settings row: what you have, and Change. */
.rlc { display: flex; align-items: center; gap: 12px; width: 100%; }
.rlc .th { width: 64px; flex-shrink: 0; }
.rlc .nm { display: flex; flex-direction: column; min-width: 0; font-size: 13.5px; font-weight: 700; color: #fff; line-height: 1.25; }
.rlc .nm small { font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,0.5); }
.rlc .go { margin-left: auto; height: 34px; padding: 0 14px; border-radius: 9px; border: none; cursor: pointer; flex-shrink: 0;
  background: rgba(255,255,255,0.09); color: #fff; font: inherit; font-size: 12.5px; font-weight: 700; transition: background .14s ease; }
.rlc .go:hover { background: rgba(255,255,255,0.15); }

/* The sheet. */
.rls-bg { position: fixed; inset: 0; z-index: 900; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 24px;
  animation: rls-in .16s ease; }
@keyframes rls-in { from { opacity: 0; } }
.rls { position: relative; width: min(900px, 100%); max-height: calc(100vh - 48px); overflow: auto; border-radius: 18px; padding: 22px 24px 24px;
  background: var(--surface); border: 1px solid var(--border); box-shadow: 0 30px 80px rgba(0,0,0,0.7); color: #fff;
  display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 26px; }
.rls h3 { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.rls .sub { margin: 4px 0 4px; font-size: 12.5px; color: rgba(255,255,255,0.55); }
.rls .fam { margin: 16px 0 8px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.4); }
.rls .gal { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.rls .gal button { display: flex; flex-direction: column; gap: 6px; padding: 0; border: none; background: none; cursor: pointer; text-align: left;
  font: inherit; font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.68); }
.rls .gal button svg { outline: 2px solid transparent; outline-offset: 2px; transition: outline-color .12s ease; }
.rls .gal button:hover svg { outline-color: rgba(255,255,255,0.3); }
.rls .gal button:hover, .rls .gal button.on { color: #fff; }
.rls .gal button.on svg { outline-color: #fff; }
.rls .gal button:focus-visible { outline: none; }
.rls .gal button:focus-visible svg { outline-color: rgba(255,255,255,0.6); }
.rls .pv { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); align-self: start; margin-top: 40px; }
.rls .pv b { font-size: 16px; font-weight: 800; }
.rls .pv small { display: block; margin-top: 2px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.4); }
.rls .pv p { margin: 0; font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.68); }
.rls .x { position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; border-radius: 50%; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.8); }
.rls .x:hover { background: rgba(255,255,255,0.14); color: #fff; }
@media (max-width: 760px) { .rls { grid-template-columns: 1fr; } .rls .pv { display: none; } .rls .gal { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
`;

/** Settings → Layout: the layout you have, with Change to open the sheet. */
export function LayoutChoice({ value, onPick, title = 'Album layout' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rlc">
      <style>{PICKER_CSS}</style>
      <span className="th"><svg viewBox="0 0 96 60" aria-hidden>{SKETCH[value]}</svg></span>
      <span className="nm">{layoutName(value)}<small>{familyOf(value)}</small></span>
      <button type="button" className="go" onClick={() => setOpen(true)} aria-haspopup="dialog">Change</button>
      {open ? <LayoutSheet title={title} value={value} onPick={(v) => { onPick(v); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** Every layout, by family, with a larger drawing and a line about the one
 *  under the pointer. Click to choose; Escape or the backdrop closes. */
function LayoutSheet({ title, value, onPick, onClose }) {
  const [hover, setHover] = useState(null);
  const shown = hover || value;
  const firstRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    firstRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const sheet = (
    <div className="rls-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{PICKER_CSS}</style>
      <div className="rls" role="dialog" aria-modal="true" aria-label={titleCase(title)}>
        <button type="button" className="x" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        <div>
          <h3>{titleCase(title)}</h3>
          <p className="sub">Point at one to read about it, click to use it.</p>
          {LAYOUT_FAMILIES.map(([fam, ids]) => (
            <div key={fam} role="radiogroup" aria-label={fam}>
              <div className="fam">{fam}</div>
              <div className="gal">
                {ids.map((id) => (
                  <button key={id} ref={id === value ? firstRef : undefined} type="button" role="radio" aria-checked={id === value}
                    className={id === value ? 'on' : ''} onClick={() => onPick(id)}
                    onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(id)} onBlur={() => setHover(null)}>
                    <svg viewBox="0 0 96 60" aria-hidden>{SKETCH[id]}</svg>
                    {layoutName(id)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="pv" aria-live="polite">
          <svg viewBox="0 0 96 60" aria-hidden>{SKETCH[shown]}</svg>
          <div><b>{layoutName(shown)}</b><small>{familyOf(shown)}{shown === value ? ' · In use' : ''}</small></div>
          <p>{LAYOUT_NOTES[shown]}</p>
        </div>
      </div>
    </div>
  );
  const host = typeof document !== 'undefined' ? (document.querySelector('.sth-root') || document.body) : null;
  return host ? createPortal(sheet, host) : sheet;
}
