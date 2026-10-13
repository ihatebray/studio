import React from 'react';
import { useIndicatorStyle } from '../../lib/playingIndicator.js';
import { createPortal } from 'react-dom';
import { PauseIcon, PlayIcon } from '../sharedUI.jsx';

export function rgbToHex(rgb) {
  const p = String(rgb || '').split(',').map((n) => Math.max(0, Math.min(255, parseInt(n.trim(), 10) || 0)));
  return `#${p.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Flat icon action for the album/playlist header row. */
/**
 * Turn a sampled cover colour into a page wash.
 *
 * sampleCoverTheme's `accent` is a flat average of the artwork, and it force-
 * substitutes pure white when the average is dark (so accent-coloured TEXT
 * stays legible). Both behaviours are wrong for a full-page field: an average
 * is desaturated by definition, and white produces the pale grey wash that
 * made every monochrome cover look identical.
 *
 * So: work in HSL, push saturation up, and pin lightness into a narrow dark
 * band. A cover with any hue at all becomes a deep, saturated field; a
 * genuinely achromatic cover stays near-black rather than mid-grey, which is
 * what it should have been in the first place.
 */
/* pageWash() moved to coverTheme.js, beside the sampler that feeds it. */

/**
 * Render a modal at document.body.
 *
 * These sheets are position:fixed, which normally escapes every ancestor — but
 * NOT one that establishes a containing block, which `transform`, `filter` and
 * a running `animation` all do. `.sth-scroll` animates on mount and its
 * `is-page` variant is overflow:hidden, so a sheet rendered inside the library
 * was clipped to the panel rather than covering the window. It opened; you
 * just couldn't see it. Portalling removes the whole class of problem instead
 * of chasing which ancestor caused it.
 */
export function Modal({ children }) {
  if (typeof document === 'undefined') return null;   // SSR / tests
  return createPortal(children, document.body);
}

/**
 * MenuItem — a row in the track context menu.
 *
 * MODULE SCOPE, deliberately. It used to be declared inside StudioHome's
 * render, which makes a NEW component type on every render — React can't match
 * it to the previous one, so it unmounts and remounts the whole subtree. With
 * playback running, `currentTime` re-renders StudioHome several times a second,
 * so the menu was being rebuilt continuously: inline hover styles were wiped
 * on each pass and the pointer never appeared to be over anything.
 *
 * Hover is CSS now rather than onMouseEnter/onMouseLeave writing to
 * element.style, so it survives a re-render regardless.
 */
export const MenuItem = React.memo(function MenuItem({ icon, label, sub, danger, onClick, trailing, accentRgb }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`sth-mi${danger ? ' is-danger' : ''}`}
      style={{ '--mi-accent': accentRgb }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.85 }}>
        {icon}
      </svg>
      <span style={{ flex: 1, minWidth: 0 }}>
        {label}
        {sub ? <span className="sth-mi-sub">{sub}</span> : null}
      </span>
      {trailing}
    </button>
  );
});

/**
 * LibRow — one row of the library table.
 *
 * React.memo at module scope. The table renders every track in the library
 * (hundreds of rows), and StudioHome re-renders several times a second while
 * something is playing because `currentTime` is a prop. Without memoisation
 * that rebuilt every row's JSX on every tick, which is the scrolling and
 * tab-switching lag.
 *
 * Handlers are passed pre-bound from a useCallback in the parent so the props
 * are referentially stable — otherwise memo compares new function identities
 * each render and never skips anything.
 */
/**
 * PlayingBars — the equaliser that replaces the index on the playing row.
 *
 * Three short bars with a soft glow, matching the fullscreen overlay's badge.
 * The previous version was four full-height bars, which at row scale looked
 * like a chart rather than an indicator.
 *
 * Deliberately NOT audio-driven: a real analyser would mean an animation frame
 * per row, inside a virtualised table where rows mount and unmount as you
 * scroll. Staggered delays are enough to read as "this one is playing".
 */
/**
 * Human-readable total for a whole list.
 *
 * formatDurationMs is mm:ss — right for one track, wrong for a collection:
 * 573 songs came out as "1839:51", which nobody can read as thirty hours. This
 * switches unit with magnitude, the way you'd say it out loud.
 */
/* formatTotalMs() moved to mediaUtils.js — the artist page states a
   catalogue's runtime the same way an album states its own. */

/* Dragging songs within a playlist to reorder them. `onMove(id, toIndex)`;
   null turns it off (a filtered list, an album). Spread props(i, id) on each
   row and add cls(i) to its className: the dragged row dims and a line marks
   where it will land. */
export function useRowDrag(onMove) {
  const [drag, setDrag] = React.useState(null); // { from, over, id }
  if (!onMove) return { props: () => ({}), cls: () => '' };
  const props = (i, id) => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(id)); } catch { /* ignore */ } setDrag({ from: i, over: i, id }); },
    onDragOver: (e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (drag.over !== i) setDrag((d) => (d ? { ...d, over: i } : d)); },
    onDrop: (e) => { e.preventDefault(); if (drag && drag.from !== i) onMove(drag.id, i); setDrag(null); },
    onDragEnd: () => setDrag(null),
  });
  const cls = (i) => (!drag ? '' : i === drag.from ? ' is-dragged' : i === drag.over ? (drag.from < i ? ' is-drop-after' : ' is-drop-before') : '');
  return { props, cls };
}

/* The one playing indicator, used by every list: Bars, Beacon or Signal,
   whichever is picked in Settings → Layout (playingIndicator.js). Paused
   holds it still. `acc` is an "r, g, b" string; `color` any CSS color, for
   lists that keep their accent in a variable. `kind` forces a style (the
   setting's own preview). Styles: .st-ind in accentTokens.js. */
export const PlayingBars = React.memo(function PlayingBars({ acc, color, playing = true, kind = null }) {
  const chosen = useIndicatorStyle();
  const style = kind || chosen;
  return (
    <span className={`st-ind is-${style}${playing ? '' : ' is-paused'}`} role="img"
      aria-label={playing ? 'Now playing' : 'Paused'} title={playing ? 'Now playing' : 'Paused'}
      style={acc ? { color: `rgb(${acc})` } : color ? { color } : undefined}>
      {style === 'signal' ? (
        <svg viewBox="0 0 18 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="4" cy="8" r="2.2" fill="currentColor" stroke="none" />
          <path className="a1" d="M8.5 4.8a4.5 4.5 0 0 1 0 6.4" />
          <path className="a2" d="M11.8 2a8.6 8.6 0 0 1 0 12" />
        </svg>
      ) : <><i /><i /><i /></>}
    </span>
  );
});

/**
 * The first credited artist on a track.
 *
 * Module-level: it reads no state and closes over nothing, so as a useCallback
 * inside the component it only served to make everything declared above it
 * unable to use it. Function declarations hoist, so call order stops mattering.
 */
/* Separators that can't also be part of a name. No bare "with" ("Sleeping
   With Sirens" showed as "Sleeping"), and a comma only counts when a space
   follows it ("nothing,nowhere." showed as "nothing"): credits list artists
   as "A, B". The same rule holds everywhere Studio splits a credit. */
export function primaryArtistOf(t) {
  const raw = String(t?.artist || '').trim();
  if (!raw) return '';
  return raw.split(/\s*(?:,(?=\s)|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i)[0].trim() || raw;
}

/** The (album, primary artist) pair that identifies a record. */
export function albumKeyOf(t) {
  return `${(t.album || '').toLowerCase()}::${primaryArtistOf(t).toLowerCase()}`;
}

/**
 * The play and pause glyphs, defined once.
 *
 * The triangle has rounded corners the way the Now Playing bar draws it: a
 * <polygon> has hard points, so the same path is stroked with a round linejoin
 * AND filled, which grows the shape by half the stroke on every side and
 * rounds all three corners evenly. Row buttons were drawing a sharp triangle
 * with a different stroke width, so the same control looked like two controls
 * depending where you found it.
 */
/* PlayGlyph / PauseGlyph now live in sharedUI.jsx as PlayIcon / PauseIcon, so
   every file draws the same shape rather than each keeping a copy. */
export const PlayGlyph = PlayIcon;
export const PauseGlyph = PauseIcon;
