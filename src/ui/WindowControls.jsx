import React, { useEffect, useState } from 'react';
import { api } from '../lib/format.js';

/* Same hit size as the top-bar bell and settings, so they sit as one row
   of quiet tools rather than a second caption strip.

   Two placements. `inline` sits at the end of the top bar, so it hides and
   peeks with the bar in compact mode. The floating (fixed) set is for
   setup, which has no top bar. StudioHome marks the page data-winctl="bar"
   (or "none" in the fullscreen player, which shows no window buttons),
   which hides the floating set. RESERVE is the room the floating set needs. */
export const WINDOW_CONTROLS_RESERVE = 124;

const CSS = `
.stw-win { -webkit-app-region: no-drag; display: flex; align-items: center; gap: 2px; pointer-events: auto; user-select: none; }
.stw-win.is-fixed { position: fixed; top: 0; right: 0; z-index: 120; height: 62px; padding: 0 10px 0 8px; }
/* In the top bar they move with it (compact mode slides the bar away and
   peeks it back); the floating set only covers screens without the bar. */
.stw-win.is-inline { margin-left: 6px; }
:root[data-winctl="bar"] .stw-win.is-fixed, :root[data-winctl="none"] .stw-win.is-fixed { display: none; }
.stw-win button { width: 34px; height: 34px; border: none; border-radius: 10px; padding: 0;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  background: transparent; color: rgba(var(--st-fg-rgb, 255, 255, 255), 0.42);
  transition: background 0.16s ease, color 0.16s ease; }
.stw-win button:hover { background: rgba(var(--st-fg-rgb, 255, 255, 255), 0.08); color: #fff; }
.stw-win button:active { background: rgba(var(--st-fg-rgb, 255, 255, 255), 0.12); }
.stw-win button.is-close:hover { background: rgba(248, 113, 113, 0.14); color: #fecaca; }
`;

function Glyph({ d, box = '0 0 24 24' }) {
  return (
    <svg width="13" height="13" viewBox={box} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

export default function WindowControls({ inline = false }) {
  const [maxed, setMaxed] = useState(false);
  const bridge = api();

  useEffect(() => {
    if (!bridge?.isMaximized) return undefined;
    let off;
    bridge.isMaximized().then(setMaxed).catch(() => {});
    off = bridge.onMaximized?.((v) => setMaxed(!!v));
    return () => { if (typeof off === 'function') off(); };
  }, [bridge]);

  if (!bridge?.close) return null;

  return (
    <div className={`stw-win ${inline ? 'is-inline' : 'is-fixed'}`} role="group" aria-label="Window">
      <style>{CSS}</style>
      <button type="button" title="Minimize" aria-label="Minimize"
        onClick={() => bridge.minimize?.()}>
        <Glyph d={<path d="M5 12h14" />} />
      </button>
      <button type="button"
        title={maxed ? 'Restore' : 'Maximize'}
        aria-label={maxed ? 'Restore' : 'Maximize'}
        onClick={() => bridge.maximize?.()}>
        {maxed ? (
          <Glyph d={
            <>
              <path d="M9 9h9v9H9z" />
              <path d="M6 15V6h9" />
            </>
          } />
        ) : (
          <Glyph d={<rect x="6" y="6" width="12" height="12" rx="2.2" />} />
        )}
      </button>
      <button type="button" className="is-close" title="Close" aria-label="Close"
        onClick={() => bridge.close()}>
        <Glyph d={<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />} />
      </button>
    </div>
  );
}
