import React, { useEffect, useState } from 'react';

/* Two small arrows for a long list: back to the top, and down to the end.
   They sit in a bar that stays put (a sticky top bar, the column headings),
   never over the songs, where they crowded each row's hover buttons. The
   now-playing bar's buttons: a glyph on nothing, a faint square on hover.
   Only there when the list is long enough to need them; each is dimmed
   while it has nowhere to go. `scrollRef` is the element that scrolls. */

const CSS = `
.stj { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.stj-btn { width: var(--stj-size, 28px); height: var(--stj-size, 28px); padding: 0; border: none; border-radius: var(--r-ctl-s, 8px); cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: transparent; color: rgba(255, 255, 255, 0.78);
  transition: background 0.14s ease, color 0.14s ease, opacity 0.14s ease; }
.stj-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); color: #fff; }
.stj-btn:disabled { cursor: default; opacity: 0.3; }
`;

export default function ScrollJump({ scrollRef, watch, size = 28 }) {
  const [at, setAt] = useState({ long: false, up: false, down: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const check = () => {
      const room = el.clientHeight * 0.8;
      const long = el.scrollHeight - el.clientHeight > room;
      const up = el.scrollTop > 4;
      const down = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
      setAt((s) => (s.long === long && s.up === up && s.down === down ? s : { long, up, down }));
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    // The list growing (songs loading in) changes what's below.
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => { el.removeEventListener('scroll', check); ro.disconnect(); };
  }, [scrollRef, watch]);

  if (!at.long) return null;
  const go = (top) => scrollRef.current?.scrollTo({ top, behavior: 'smooth' });
  const glyph = Math.round(size * 0.5);
  return (
    <span className="stj" style={{ '--stj-size': `${size}px` }}>
      <style>{CSS}</style>
      <button type="button" className="stj-btn" onClick={() => go(0)} disabled={!at.up}
        title="Back to top" aria-label="Back to top">
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
      </button>
      <button type="button" className="stj-btn" onClick={() => go(scrollRef.current?.scrollHeight || 0)} disabled={!at.down}
        title="Jump to the end" aria-label="Jump to the end">
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </span>
  );
}
