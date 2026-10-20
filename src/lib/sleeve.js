/* =========================================================================
 *  studio — the sleeve: how an album or playlist opens
 *
 *  Opened from Home or a Spotify link, a record
 *  shows in a window over the page (Sleeve in MySpotify.jsx). Two looks,
 *  picked in Settings → Layout: Classic (the cover, title and buttons in a
 *  band, the songs under it) and Glass (the cover fills the window, the
 *  rest sits on frosted glass).
 *
 *  It also remembers which cover was pressed, so the window can grow out
 *  of it and shrink back into it. A card marks itself with data-sleeve-card
 *  and its art with data-sleeve-cover (or holds a .msp-art or an <img>).
 * ========================================================================= */

import { useSyncExternalStore } from 'react';

const KEY = 'studio:sleeveStyle';
export const SLEEVE_STYLES = [['classic', 'Classic'], ['glass', 'Glass']];
const valid = (v) => SLEEVE_STYLES.some(([id]) => id === v);

let current = (() => { try { const v = localStorage.getItem(KEY); return valid(v) ? v : 'classic'; } catch { return 'classic'; } })();
const listeners = new Set();

export const getSleeveStyle = () => current;

export function setSleeveStyle(v) {
  if (!valid(v) || v === current) return;
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* still applies for this session */ }
  listeners.forEach((fn) => fn());
}

export function useSleeveStyle() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, getSleeveStyle);
}

/* ---- where it opened from --------------------------------------------- */

let pressed = null;   // { el, at }
const coverOf = (card) => card?.querySelector('[data-sleeve-cover]') || card?.querySelector('.msp-art') || card?.querySelector('img') || null;
if (typeof document !== 'undefined') {
  const note = (card) => { const el = coverOf(card); if (el) pressed = { el, at: performance.now() }; };
  document.addEventListener('pointerdown', (e) => note(e.target?.closest?.('[data-sleeve-card]')), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') note(e.target?.closest?.('[data-sleeve-card]'));
  }, true);
}

/** The cover just pressed, if a card was pressed a moment ago. Reading it
 *  doesn't use it up: StrictMode runs a component's first render twice. */
export function takeSleeveOrigin() {
  const p = pressed;
  return p && performance.now() - p.at < 1500 && p.el.isConnected ? p.el : null;
}
