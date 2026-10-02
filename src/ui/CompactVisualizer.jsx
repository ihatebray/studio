/* =========================================================================
 *  studio — the compact-bar visualizer
 *
 *  In compact mode the library bar has an empty stretch between Shuffle and
 *  search. With a style picked in Settings → Appearance, this fills it.
 *
 *    CompactVizContext   what StudioHome shares with every library header
 *    CompactVizSlot      goes where the header's spacer was
 *    CompactVizPicker    the Settings control, with a live preview per style
 *
 *  Drawing is in compactVizStyles.js, listening in vizLevels.js.
 *
 *  Cost: one canvas, and a frame loop only while there is something to draw.
 *  The loop stops a moment after pausing (once sparks and rings have faded),
 *  while the window is hidden, and whenever compact mode or the setting is
 *  off, because then nothing here is mounted at all.
 * ========================================================================= */

import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { LevelSource, shapeFor, SHAPE_SLOTS } from '../lib/vizLevels.js';
import { VIZ_STYLES, SOFT_EDGE, drawViz, stillMoving, demoSource } from '../lib/compactVizStyles.js';
import { spotifyIdOf } from '../lib/spotifyMediaElement.js';

export const CompactVizContext = createContext(null);
export const COMPACT_VIZ_KEY = 'studio:compactViz';
/** '0' draws every style in white instead of the cover's colours. */
export const COMPACT_VIZ_COVER_KEY = 'studio:compactVizCover';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* Every style fades out on all four sides, so nothing ever meets a hard edge. */
const maskFor = (top) => `linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent), linear-gradient(180deg, transparent, #000 ${top}%, #000 ${100 - top}%, transparent)`;
/* The equalizer styles stay inside their space by construction, so they keep
   the side fades but only a slight one top and bottom, and use the height. */
const canvasStyleFor = (style) => {
  const mask = maskFor(SOFT_EDGE.has(style) ? 6 : 20);
  return {
    width: '100%', height: '100%', display: 'block',
    WebkitMaskImage: mask, WebkitMaskComposite: 'source-in', maskImage: mask, maskComposite: 'intersect',
  };
};

/** Cover colours as [r,g,b], lifted towards white so they read on the
 *  accent-tinted bar. Falls back to the accent, then to white. */
const WHITE = [[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]];

/* With `useCover` off, plain white: it reads on any album's bar colour. */
function vizPalette(palette, accent, useCover = true) {
  if (!useCover) return WHITE;
  const parse = (c) => String(c || '').split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
  let cols = (palette || []).map(parse).filter((c) => c.length === 3);
  if (!cols.length && accent) cols = [parse(accent)].filter((c) => c.length === 3);
  if (!cols.length) cols = [[255, 255, 255]];
  const lift = (c) => {
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const k = lum < 0.55 ? 0.55 - lum * 0.5 : 0.1;
    return c.map((v) => Math.round(v + (255 - v) * k));
  };
  const out = cols.slice(0, 4).map(lift);
  while (out.length < 4) out.push(out[out.length % Math.max(1, out.length)] || [255, 255, 255]);
  return out;
}

export function CompactVizSlot() {
  const ctx = useContext(CompactVizContext);
  if (!ctx?.enabled || !ctx.style || ctx.style === 'off') return <span style={{ flex: 1, minWidth: 8 }} />;
  return <CompactVisualizer {...ctx} />;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function CompactVisualizer({
  style, analyserRef, onNeedAnalyser, currentTrack, isPlaying, currentTime = 0, duration = 0, onSeek, palette, accent,
  coverColours = true,
}) {
  const canvasRef = useRef(null);
  const [tip, setTip] = useState(null);       // { x (0–1), text }
  const pal = useMemo(() => vizPalette(palette, accent, coverColours), [palette, accent, coverColours]);

  /* The loop reads the latest props through a ref, so a React render never
     restarts it. `clockAt` lets progress run smoothly between the ~4 Hz
     currentTime updates. */
  const live = useRef({});
  const lastTime = useRef({ value: currentTime, at: performance.now() });
  if (lastTime.current.value !== currentTime) lastTime.current = { value: currentTime, at: performance.now() };
  live.current = { style, isPlaying, currentTrack, duration, pal, onNeedAnalyser, analyserRef };


  const engine = useRef(null);
  if (!engine.current) {
    engine.current = { src: new LevelSource(), s: {}, t: 0, running: false, raf: 0, last: 0, pausedFor: 0, hover: null, w: 0, h: 0, dpr: 1 };
  }

  const progressNow = () => {
    const L = live.current;
    if (!(L.duration > 0)) return 0;
    const { value, at } = lastTime.current;
    const t = value + (L.isPlaying ? (performance.now() - at) / 1000 : 0);
    return Math.min(1, Math.max(0, t / L.duration));
  };

  const draw = useCallback((dt) => {
    const e = engine.current;
    const L = live.current;
    const canvas = canvasRef.current;
    if (!canvas || !e.w) return;
    const streamed = !!spotifyIdOf(L.currentTrack);
    const analyser = L.analyserRef?.current || null;
    if (!streamed && L.isPlaying && !analyser) L.onNeedAnalyser?.();
    e.src.update(dt, { playing: !!L.isPlaying, streamed, analyser });
    if (L.isPlaying) e.t += dt;
    const progress = progressNow();
    // The ribbon learns the song's shape as it plays (vizLevels.shapeFor).
    const shape = shapeFor(L.currentTrack?.id);
    if (shape && L.isPlaying && e.src.loud > 0.01) {
      const i = Math.min(SHAPE_SLOTS - 1, Math.floor(progress * SHAPE_SLOTS));
      shape[i] = shape[i] < 0 ? e.src.loud : shape[i] * 0.85 + e.src.loud * 0.15;
    }
    drawViz(L.style, {
      ctx: canvas.getContext('2d'), w: e.w, h: e.h, dpr: e.dpr, src: e.src,
      t: e.t, dt, playing: !!L.isPlaying, palette: L.pal,
      progress, hover: e.hover, shape, s: e.s,
    });
  }, []);

  const kick = useCallback(() => {
    const e = engine.current;
    if (e.running || reduceMotion()) { if (!e.running) draw(0.016); return; }
    if (typeof document !== 'undefined' && document.hidden) return;
    e.running = true;
    e.last = performance.now();
    e.pausedFor = 0;
    const frame = (now) => {
      // rAF's timestamp can sit a hair before `last`; never step backwards.
      const dt = Math.min(0.05, Math.max(0, (now - e.last) / 1000));
      e.last = now;
      draw(dt);
      const L = live.current;
      e.pausedFor = L.isPlaying ? 0 : e.pausedFor + dt;
      const settled = !L.isPlaying && e.pausedFor > 1.5 && e.src.loud < 0.005 && !stillMoving();
      if (settled || document.hidden) { e.running = false; return; }
      e.raf = requestAnimationFrame(frame);
    };
    e.raf = requestAnimationFrame(frame);
  }, [draw]);

  // Size the canvas to its box, at the screen's pixel density.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const e = engine.current;
      e.dpr = Math.min(2, window.devicePixelRatio || 1);
      e.w = Math.max(1, Math.round(r.width));
      e.h = Math.max(1, Math.round(r.height));
      canvas.width = e.w * e.dpr;
      canvas.height = e.h * e.dpr;
      kick();
      if (!engine.current.running) draw(0.016);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    fit();
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      cancelAnimationFrame(engine.current.raf);
      engine.current.running = false;
    };
  }, [kick, draw]);

  // Anything that changes the picture restarts the loop if it had settled.
  useEffect(() => { engine.current.s = {}; kick(); }, [style, kick]);
  useEffect(() => { kick(); }, [isPlaying, currentTrack?.id, pal, currentTime, kick]);

  /* Progress ribbon: hover shows the time, click or arrow keys seek. */
  const scrub = style === 'ribbon' && duration > 0 && onSeek;
  const at = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const scrubProps = scrub ? {
    role: 'slider',
    tabIndex: 0,
    'aria-label': 'Song position',
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(duration),
    'aria-valuenow': Math.round(currentTime),
    'aria-valuetext': `${fmt(currentTime)} of ${fmt(duration)}`,
    onPointerMove: (e) => { const x = at(e); engine.current.hover = x; setTip({ x, text: fmt(x * duration) }); kick(); },
    onPointerLeave: () => { engine.current.hover = null; setTip(null); kick(); },
    onClick: (e) => onSeek(at(e) * duration),
    onKeyDown: (e) => {
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      onSeek(Math.min(duration, Math.max(0, currentTime + step)));
    },
    style: { ...canvasStyleFor(style), cursor: 'pointer' },
  } : { 'aria-hidden': true, style: canvasStyleFor(style) };

  return (
    <span className="sth-cviz" style={{ flex: 1, minWidth: 60, alignSelf: 'stretch', margin: '0 14px', position: 'relative', display: 'flex', alignItems: 'center' }}>
      {/* The box is the buttons' height, so the bar doesn't grow; the canvas
          reaches a few px past it, into space its own fade covers anyway. */}
      <span style={{ position: 'relative', width: '100%', height: 34 }}>
        <span style={{ position: 'absolute', left: 0, right: 0, top: -5, bottom: -5 }}>
          <canvas ref={canvasRef} {...scrubProps} />
        </span>
        {tip ? (
          <span style={{
            position: 'absolute', top: 'calc(100% + 8px)', left: `${tip.x * 100}%`, transform: 'translateX(-50%)',
            padding: '3px 8px', borderRadius: 6, background: 'rgba(8,10,16,0.92)', color: '#fff',
            fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 5,
          }}>{tip.text}</span>
        ) : null}
      </span>
    </span>
  );
}

/* ---- Settings: a dropdown and one live preview ----
 * One canvas and one stand-in song, not one per style: a grid of animated
 * tiles each running its own analysis made Settings lag. The preview shows
 * the chosen style, or the one under the pointer while the list is open, and
 * only animates while it's on screen. */

function Preview({ style, palette }) {
  const ref = useRef(null);
  const demo = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || style === 'off') return undefined;
    if (!demo.current) {
      demo.current = demoSource();
      // a few seconds in, so the preview starts mid-song rather than at rest
      for (let i = 0; i < 150; i++) demo.current.update(1 / 60);
    }
    const src = demo.current;
    const s = {};
    let t = 0;
    let raf = 0;
    let visible = true;
    let size = { w: 1, h: 1, dpr: 1 };
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size = { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)), dpr };
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    };
    const paint = (dt) => {
      src.update(dt);
      t += dt;
      drawViz(style, { ctx: canvas.getContext('2d'), ...size, src, t, dt, playing: true, palette, progress: (t / 90) % 1, hover: null, shape: null, s });
    };
    let last = performance.now();
    const loop = (now) => {
      raf = 0;
      paint(Math.min(0.05, Math.max(0, (now - last) / 1000)));
      last = now;
      if (visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!raf && visible && !document.hidden && !reduceMotion()) { last = performance.now(); raf = requestAnimationFrame(loop); } };
    fit();
    paint(1 / 60);
    const ro = new ResizeObserver(() => { fit(); paint(1 / 60); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); });
    io.observe(canvas);
    document.addEventListener('visibilitychange', kick);
    kick();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', kick);
    };
  }, [style, palette]);
  if (style === 'off') {
    return <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(var(--st-sub-rgb), 0.55)' }}>The space stays empty</span>;
  }
  return <canvas ref={ref} aria-hidden style={{ ...canvasStyleFor(style), height: 34 }} />;
}

export function CompactVizPicker({ value, onPick, palette, accent, coverColours = true }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(null);
  const wrap = useRef(null);
  const pal = useMemo(() => vizPalette(palette, accent, coverColours), [palette, accent, coverColours]);
  const options = useMemo(() => [{ id: 'off', name: 'Off', note: 'Leave the space empty' }, ...VIZ_STYLES], []);
  const current = options.find((o) => o.id === value) || options[0];
  const shown = open && hover ? hover : current.id;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!open) setHover(null); }, [open]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', flexWrap: 'wrap' }}>
      <div ref={wrap} style={{ position: 'relative', flexShrink: 0 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
          aria-label={`Compact bar visualizer: ${current.name}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 12px', minWidth: 180,
            borderRadius: 8, border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 600,
            background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'var(--st-text)',
          }}>
          <span style={{ flex: 1, textAlign: 'left' }}>{current.name}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {open ? (
          <div role="listbox" aria-label="Compact bar visualizer" className="sth-libsortmenu"
            style={{ left: 0, right: 'auto', minWidth: 250 }} onMouseLeave={() => setHover(null)}>
            {options.map((o) => (
              <button key={o.id} type="button" role="option" aria-selected={o.id === value}
                className={`sth-libsortitem${o.id === value ? ' is-on' : ''}`}
                onMouseEnter={() => setHover(o.id)} onFocus={() => setHover(o.id)}
                onClick={() => { onPick(o.id); setOpen(false); }}>
                <span style={{ display: 'block' }}>{o.name}</span>
                <span style={{ display: 'block', fontSize: 11.5, fontWeight: 500, color: 'rgba(var(--st-fg-rgb), 0.45)', marginTop: 1 }}>{o.note}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span style={{
        flex: 1, minWidth: 200, height: 34, borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(var(--st-acc-rgb), 0.32)',
      }}>
        <Preview style={shown} palette={pal} />
      </span>
    </div>
  );
}
