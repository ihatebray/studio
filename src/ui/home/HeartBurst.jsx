import React, { useEffect, useRef, useState } from 'react';

/* The favorite animation. When a song becomes a favorite its heart pops in
 * with a squash and a wobble, a ring pulses out, and a handful of little
 * hearts and sparkles burst from it and float away. Taking a favorite off
 * gets a small, quiet deflate instead: undoing something shouldn't
 * celebrate.
 *
 * It plays on the change, not on the click, so hearting from the H key or
 * the bar's menu animates the bar's heart too. */

const CSS = `
.st-hb { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; z-index: 2; }
.st-hb-ring { position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid #ff6b95; opacity: 0; animation: stHbRing .55s cubic-bezier(.2,.8,.3,1) forwards; }
@keyframes stHbRing {
  0% { transform: scale(.3); opacity: .95; border-width: 7px; }
  100% { transform: scale(var(--ring, 1.75)); opacity: 0; border-width: .5px; } }
.st-hb-p { position: absolute; width: var(--s); height: var(--s); left: calc(var(--s) / -2); top: calc(var(--s) / -2); opacity: 0;
  animation: stHbFly var(--t, .8s) cubic-bezier(.15,.75,.35,1) var(--d, 0s) forwards; }
.st-hb-p svg { display: block; width: 100%; height: 100%; }
.st-hb-p.is-dot { border-radius: 50%; background: var(--c); }
/* Out along its angle, then drifting up a little as it fades, with a spin. */
@keyframes stHbFly {
  0% { transform: rotate(var(--a)) translateY(-4px) rotate(calc(var(--a) * -1)) scale(.2); opacity: 0; }
  14% { opacity: 1; }
  65% { opacity: 1; }
  100% { transform: rotate(var(--a)) translateY(calc(var(--r) * -1)) rotate(calc(var(--a) * -1)) translateY(-5px) rotate(var(--spin)) scale(.85); opacity: 0; } }
.st-heart-pop { animation: stHeartPop .62s cubic-bezier(.3,1.4,.5,1) both; transform-origin: 50% 55%; }
@keyframes stHeartPop {
  0% { transform: scale(.2); }
  32% { transform: scale(1.38, 1.22) rotate(-10deg); }
  52% { transform: scale(.86, .94) rotate(5deg); }
  72% { transform: scale(1.08) rotate(-2deg); }
  100% { transform: none; } }
.st-heart-off { animation: stHeartOff .32s ease both; transform-origin: 50% 55%; }
@keyframes stHeartOff { 0% { transform: scale(1); } 40% { transform: scale(.72); } 100% { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .st-hb { display: none; }
  .st-heart-pop, .st-heart-off { animation: none; }
}
`;

// Put in once, up front: the heart's own pop and deflate play without a burst on screen.
if (typeof document !== 'undefined' && !document.getElementById('st-heart-css')) {
  const el = document.createElement('style');
  el.id = 'st-heart-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

const COLORS = ['#ff5c8a', '#ff8a5c', '#ffd166', '#c39bff', '#ff7eb6', '#7ee0c3'];
const HEART = 'M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z';

/* Fixed, so every burst looks considered rather than random: little hearts
   at seven angles around the clock with sparkles between them. */
const BITS = [
  { a: -10, heart: true, s: 11, spin: '-14deg' },
  { a: 40, heart: true, s: 9, spin: '18deg', d: '.03s' },
  { a: 95, heart: true, s: 10, spin: '10deg', d: '.05s' },
  { a: 145, heart: true, s: 8, spin: '-20deg', d: '.02s' },
  { a: 200, heart: true, s: 10, spin: '16deg', d: '.04s' },
  { a: 255, heart: true, s: 9, spin: '-12deg' },
  { a: 305, heart: true, s: 11, spin: '22deg', d: '.03s' },
  { a: 18, s: 4, r: 0.62, d: '.08s', t: '.6s' },
  { a: 120, s: 3, r: 0.6, d: '.1s', t: '.6s' },
  { a: 228, s: 4, r: 0.64, d: '.07s', t: '.6s' },
  { a: 330, s: 3, r: 0.58, d: '.09s', t: '.6s' },
];

/**
 * key and on, from the last time this song's favorite changed: { key: 0 }
 * until it does. Only a change for the same song counts, so moving to the
 * next song (already a favorite) doesn't set it off.
 */
export function useFavBurst(id, fav) {
  const prev = useRef({ id, fav: !!fav });
  const [state, setState] = useState({ key: 0, on: false });
  useEffect(() => {
    const p = prev.current;
    if (p.id === id && p.fav !== !!fav) setState((s) => ({ key: s.key + 1, on: !!fav }));
    prev.current = { id, fav: !!fav };
  }, [id, fav]);
  return state;
}

/** The className for the heart's icon while the last change plays. */
export const heartAnim = (b) => (b.key ? (b.on ? 'st-heart-pop' : 'st-heart-off') : undefined);

/** The burst itself, centered on its parent (which needs position: relative). */
export function HeartBurst({ burst, radius = 24 }) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    /* Taking it off clears a burst still playing from putting it on. Left
       mounted, its new key restarted it, so a quick H, H celebrated twice. */
    if (!burst.key || !burst.on) { setLive(false); return undefined; }
    setLive(true);
    const t = setTimeout(() => setLive(false), 950);
    return () => clearTimeout(t);
  }, [burst.key, burst.on]);
  if (!live || !burst.on) return null;
  return (
    <span key={burst.key} className="st-hb" aria-hidden>
      <span className="st-hb-ring" style={{ '--ring': radius / 14 }} />
      {BITS.map((b, i) => (
        <span key={b.a} className={`st-hb-p${b.heart ? '' : ' is-dot'}`}
          style={{
            '--a': `${b.a}deg`, '--r': `${radius * (b.r || 1)}px`, '--s': `${b.s}px`, '--spin': b.spin || '0deg',
            '--d': b.d || '0s', '--t': b.t || '.8s', '--c': COLORS[i % COLORS.length],
          }}>
          {b.heart ? <svg viewBox="0 0 24 24"><path d={HEART} fill={COLORS[i % COLORS.length]} /></svg> : null}
        </span>
      ))}
    </span>
  );
}
