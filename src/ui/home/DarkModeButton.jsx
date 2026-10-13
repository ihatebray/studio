import React, { useState } from 'react';

/* The top bar's dark mode switch: a chubby moon with soft rounded tips, and
   three small sparkles that only show while dark mode is on. Turning it on,
   the moon gives a springy pop and the sparkles twinkle in one by one; after
   that they shimmer slowly for as long as it stays on. Off, it's just the
   outlined moon, in the same weight as the bell and Settings beside it. */

const MOON = 'M20.57 12.87A8.6 8.6 0 1 1 11.33 3.63A6.6 6.6 0 0 0 20.57 12.87Z';
// [path, stroke width]: big, small, tiny, each a four-point sparkle
const SPARKLES = [
  ['M19.70 3.60Q20.34 5.26 22.00 5.90Q20.34 6.54 19.70 8.20Q19.06 6.54 17.40 5.90Q19.06 5.26 19.70 3.60Z', 0.74],
  ['M23.80 0.60Q24.19 1.61 25.20 2.00Q24.19 2.39 23.80 3.40Q23.41 2.39 22.40 2.00Q23.41 1.61 23.80 0.60Z', 0.45],
  ['M16.00 -1.10Q16.31 -0.31 17.10 0.00Q16.31 0.31 16.00 1.10Q15.69 0.31 14.90 0.00Q15.69 -0.31 16.00 -1.10Z', 0.35],
];

const CSS = `
.dmb { width: 34px; height: 34px; border-radius: 10px; border: none; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;
  background: transparent; color: rgba(var(--st-fg-rgb), 0.5); transition: background 0.16s ease, color 0.16s ease; }
.dmb:hover { color: rgba(var(--st-fg-rgb), 0.8); }
.dmb.is-on { background: rgba(var(--st-fg-rgb), 0.09); color: #fff; }
.dmb svg { width: 17px; height: 17px; overflow: visible; }
.dmb svg * { transform-box: fill-box; transform-origin: center; }
.dmb .mo, .dmb .sp { fill: transparent; stroke: currentColor; stroke-linejoin: round; stroke-linecap: round; }
.dmb .mo { stroke-width: 1.9; transition: fill 0.3s ease; }
.dmb .sp { opacity: 0; }
.dmb.is-on .mo, .dmb.is-on .sp { fill: currentColor; }
/* On already (say at launch): the sparkles are simply there, shimmering. */
.dmb.is-on .sp { opacity: 1; animation: dmb-rest 3.2s ease-in-out infinite; }
.dmb.is-on .sp:nth-of-type(2) { animation-delay: 1s; }
.dmb.is-on .sp:nth-of-type(3) { animation-delay: 1.6s; }
.dmb.is-on .sp:nth-of-type(4) { animation-delay: 2.2s; }
/* Just turned on: the moon pops and the sparkles twinkle in first. */
.dmb.is-new .mo { animation: dmb-pop 0.5s cubic-bezier(.34,1.56,.64,1); }
.dmb.is-new .sp { animation: dmb-in 0.55s ease-out both, dmb-rest 3.2s ease-in-out infinite; }
.dmb.is-new .sp:nth-of-type(2) { animation-delay: 0.1s, 1s; }
.dmb.is-new .sp:nth-of-type(3) { animation-delay: 0.25s, 1.6s; }
.dmb.is-new .sp:nth-of-type(4) { animation-delay: 0.4s, 2.2s; }
@keyframes dmb-pop { 0% { transform: scale(.8) rotate(-12deg); } 100% { transform: scale(1) rotate(0); } }
@keyframes dmb-in { 0% { opacity: 0; transform: scale(0); } 55% { opacity: 1; transform: scale(1.35); } 100% { opacity: 1; transform: scale(1); } }
@keyframes dmb-rest { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
@media (prefers-reduced-motion: reduce) { .dmb .mo, .dmb .sp { animation: none !important; transition: none !important; } }
`;

export default function DarkModeButton({ on, onToggle }) {
  // Only a click plays the entrance; being on at launch doesn't.
  const [fresh, setFresh] = useState(false);
  return (
    <button type="button" className={`dmb${on ? ' is-on' : ''}${on && fresh ? ' is-new' : ''}`}
      onClick={() => { setFresh(!on); onToggle(); }}
      title={on ? 'Dark mode: on' : 'Dark mode: off'} aria-label="Dark mode" aria-pressed={on}>
      <style>{CSS}</style>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path className="mo" d={MOON} />
        {SPARKLES.map(([d, w]) => <path key={d} className="sp" d={d} style={{ strokeWidth: w }} />)}
      </svg>
    </button>
  );
}
