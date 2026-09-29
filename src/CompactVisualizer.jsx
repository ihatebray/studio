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
import { LevelSource, shapeFor, SHAPE_SLOTS } from './vizLevels.js';
import { VIZ_STYLES, drawViz, stillMoving, demoSource } from './compactVizStyles.js';
import { spotifyIdOf } from './spotifyMediaElement.js';

export const CompactVizContext = createContext(null);
export const COMPACT_VIZ_KEY = 'studio:compactViz';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* Every style fades out on all four sides, so nothing ever meets a hard edge. */
const MASK = 'linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent), linear-gradient(180deg, transparent, #000 20%, #000 80%, transparent)';
const canvasStyle = {
  width: '100%', height: '100%', display: 'block',
  WebkitMaskImage: MASK, WebkitMaskComposite: 'source-in', maskImage: MASK, maskComposite: 'intersect',
};

/** Cover colours as [r,g,b], lifted towards white so they read on the
 *  accent-tinted bar. Falls back to the accent, then to white. */
export function vizPalette(palette, accent) {
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
}) {
  const canvasRef = useRef(null);
  const [tip, setTip] = useState(null);       // { x (0–1), text }
  const pal = useMemo(() => vizPalette(palette, accent), [palette, accent]);

  /* The loop reads the latest props through a ref, so a React render never
     restarts it. `clockAt` lets progress run smoothly between the ~4 Hz
     currentTime updates. */
  const live = useRef({});
  const lastTime = useRef({ value: currentTime, at: performance.now() });
  if (lastTime.current.value !== currentTime) lastTime.current = { value: currentTime, at: performance.now() };
  live.current = { style, isPlaying, currentTrack, duration, pal, onNeedAnalyser, analyserRef };

  const coverSrc = currentTrack?.coverArt || null;
  const cover = useMemo(() => {
    if (!coverSrc) return null;
    const img = new Image();
    img.decoding = 'async';
    img.src = coverSrc;
    return img;
  }, [coverSrc]);
  live.current.cover = cover;

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
      t: e.t, dt, playing: !!L.isPlaying, palette: L.pal, cover: L.cover,
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
      const settled = !L.isPlaying && e.pausedFor > 1.5 && e.src.loud < 0.005 && !stillMoving(L.style, e.s);
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
  useEffect(() => {
    if (!cover) return undefined;
    const onLoad = () => kick();
    cover.addEventListener('load', onLoad);
    return () => cover.removeEventListener('load', onLoad);
  }, [cover, kick]);

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
    style: { ...canvasStyle, cursor: 'pointer' },
  } : { 'aria-hidden': true, style: canvasStyle };

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

/* ---- Settings: one tile per style, each with a small live preview ---- */

function TilePreview({ style, animate, palette }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const src = demoSource();
    const s = {};
    let t = 0;
    const frameOf = (dt) => {
      src.update(dt);
      t += dt;
      drawViz(style, { ctx: canvas.getContext('2d'), w, h, dpr, src, t, dt, playing: true, palette, cover: null, progress: (t / 90) % 1, hover: null, shape: null, s });
    };
    // Warm the demo up so a still tile shows the style mid-song, not at rest.
    for (let i = 0; i < 90; i++) frameOf(1 / 60);
    if (!animate || reduceMotion()) return undefined;
    let raf = 0;
    let last = performance.now();
    const loop = (now) => { frameOf(Math.min(0.05, Math.max(0, (now - last) / 1000))); last = now; raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [style, animate, palette]);
  return <canvas ref={ref} aria-hidden style={{ ...canvasStyle, height: 34 }} />;
}

export function CompactVizPicker({ value, onPick, palette, accent }) {
  const [hot, setHot] = useState(null);
  const pal = useMemo(() => vizPalette(palette, accent), [palette, accent]);
  const tiles = [{ id: 'off', name: 'Off', note: 'Leave the space empty' }, ...VIZ_STYLES];
  return (
    <div role="radiogroup" aria-label="Compact bar visualizer"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 8, width: '100%' }}>
      {tiles.map((t) => {
        const on = value === t.id;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => onPick(t.id)}
            onMouseEnter={() => setHot(t.id)} onMouseLeave={() => setHot((h) => (h === t.id ? null : h))}
            onFocus={() => setHot(t.id)} onBlur={() => setHot((h) => (h === t.id ? null : h))}
            style={{
              display: 'grid', gap: 6, padding: 8, borderRadius: 10, cursor: 'pointer', textAlign: 'left', font: 'inherit',
              border: `1px solid ${on ? 'rgba(var(--st-fg-rgb), 0.55)' : 'rgba(var(--st-fg-rgb), 0.08)'}`,
              background: on ? 'rgba(var(--st-fg-rgb), 0.08)' : 'transparent', color: 'var(--st-text)',
            }}>
            <span style={{ display: 'block', height: 34, borderRadius: 7, background: 'rgba(var(--st-acc-rgb), 0.32)', overflow: 'hidden' }}>
              {t.id === 'off' ? null : <TilePreview style={t.id} animate={on || hot === t.id} palette={pal} />}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 650 }}>{t.name}</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.35, color: 'rgba(var(--st-sub-rgb), 0.6)' }}>{t.note}</span>
          </button>
        );
      })}
    </div>
  );
}
