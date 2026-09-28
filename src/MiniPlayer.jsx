import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sampleCoverTheme } from './coverTheme.js';
import { formatTime } from './mediaUtils.js';

/* =========================================================================
 *  MiniPlayer — the view inside the always-on-top mini window.
 *
 *  This renders in a SEPARATE BrowserWindow (see miniWindow.js) loaded from
 *  the same index.html with a `#mini` hash. It owns no playback state: it
 *  paints whatever the main renderer publishes and sends commands back.
 *
 *  Two consequences worth knowing before editing:
 *
 *   1. TIME IS INTERPOLATED. The main renderer publishes roughly once a
 *      second (any more and we'd be spamming IPC at 60fps for a progress
 *      bar). We anchor on `{ position, at }` and advance locally, with a
 *      matching CSS linear transition so the bar glides instead of ticking.
 *
 *   2. THE THEME IS COMPUTED HERE. We deliberately don't ship accent/wash/
 *      mid over IPC — the cover URL is a `studio-cover://` address the
 *      protocol handler serves app-wide, so this window can sample it
 *      itself and stays correct even if StudioShell isn't mounted.
 *
 *  Four styles, and they're real layouts rather than one layout at four
 *  scales: full (art + meta + scrubber + full transport), compact (art +
 *  meta + three buttons), minimal (a single strip), art (the cover, with
 *  everything else living on hover).
 * ========================================================================= */

const FALLBACK_THEME = { accent: '150, 150, 150', wash: '10, 10, 10', mid: '14, 14, 16', deep: '0, 0, 0' };

const DEFAULT_OPTIONS = {
  style: 'compact',
  alwaysOnTop: true,
  opacity: 1,
  clickThrough: false,
  hideMain: false,
  autoHideChrome: true,
  showProgress: true,
};

const STYLE_ORDER = ['full', 'compact', 'minimal', 'art'];
const STYLE_LABELS = { full: 'Full', compact: 'Compact', minimal: 'Minimal', art: 'Art only' };

const FONT = "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif";

/**
 * Gutter between the window edge and the drawn shell.
 *
 * Zero, and it has to stay zero unless the shell's shadow shrinks to match.
 * A CSS drop shadow is clipped at the window bounds, so a 44px blur inside a
 * 6px gutter doesn't fade — it gets sliced off, leaving a flat gray rectangle
 * with a hard outer edge framing the player. Widening the gutter instead is
 * worse: transparent window area still captures clicks, so it would put a
 * dead border around the mini that swallows input meant for the game.
 *
 * So the shell is full-bleed and defines its edge with an inset hairline
 * rather than an outer shadow. The corners outside the radius are genuinely
 * transparent, which is what makes the rounded shape read.
 */
const SHELL_MARGIN = 0;

/** Lift a dark cover average until it's legible as text on near-black. */
function readableAccent(accent, minLum = 168) {
  const parts = String(accent || '').split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return '170, 170, 170';
  let [r, g, b] = parts;
  const lum = () => 0.299 * r + 0.587 * g + 0.114 * b;
  let guard = 0;
  while (lum() < minLum && guard < 24) {
    r += (255 - r) * 0.16; g += (255 - g) * 0.16; b += (255 - b) * 0.16; guard += 1;
  }
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

/** Black or white, whichever reads on top of a solid accent fill. */
function onAccent(accent) {
  const p = String(accent || '').split(',').map((s) => parseInt(s.trim(), 10));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '#fff';
  return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) > 168 ? '#0b0b0c' : '#fff';
}

const api = () => (typeof window !== 'undefined' ? window.electronAPI?.mini : null);

/* ------------------------------------------------------------------ icons */

const I = {
  Play: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <path d="M7.5 4.5a1 1 0 0 1 1.5-.86l10 7a1 1 0 0 1 0 1.72l-10 7A1 1 0 0 1 7.5 18.5v-14z" fill="currentColor" />
    </svg>
  ),
  Pause: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="4.5" width="4" height="15" rx="1.5" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.5" />
    </svg>
  ),
  Prev: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M19 20L9 12l10-8v16z" fill="currentColor" stroke="none" />
      <line x1="6" y1="5" x2="6" y2="19" />
    </svg>
  ),
  Next: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 4l10 8-10 8V4z" fill="currentColor" stroke="none" />
      <line x1="18" y1="5" x2="18" y2="19" />
    </svg>
  ),
  Shuffle: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
    </svg>
  ),
  Repeat: (s = 14, one = false) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
      {one ? <text x="12" y="14.5" textAnchor="middle" fontSize="8" fill="currentColor" stroke="none" fontWeight="700" fontFamily="system-ui, sans-serif">1</text> : null}
    </svg>
  ),
  Volume: (s = 14, muted = false) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
      {muted ? <><line x1="16" y1="9" x2="22" y2="15" /><line x1="22" y1="9" x2="16" y2="15" /></>
        : <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9.5 9.5 0 0 1 0 14" /></>}
    </svg>
  ),
  Pin: (s = 13, on = false) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3h6l-1 6 3.5 3.5H6.5L10 9 9 3z" />
      <line x1="12" y1="12.5" x2="12" y2="21" />
    </svg>
  ),
  Layout: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" /><line x1="3" y1="14" x2="21" y2="14" /><line x1="10" y1="14" x2="10" y2="20" />
    </svg>
  ),
  More: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" />
    </svg>
  ),
  Expand: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M10 20H4v-6" /><path d="M4 20l8-8" />
    </svg>
  ),
  Close: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  ),
  Ghost: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 20V9a7 7 0 0 1 14 0v11l-2.3-2-2.3 2-2.4-2-2.4 2L7.3 18 5 20z" />
      <circle cx="9.5" cy="9.5" r="1" fill="currentColor" /><circle cx="14.5" cy="9.5" r="1" fill="currentColor" />
    </svg>
  ),
};

/* ------------------------------------------------------------- small bits */

function IconBtn({ children, onClick, title, size = 26, active = false, accent, dim = false, style }) {
  const [h, setH] = useState(false);
  const a = readableAccent(accent);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      title={title}
      aria-label={title}
      style={{
        WebkitAppRegion: 'no-drag',
        width: size, height: size, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, borderRadius: 999, cursor: 'pointer',
        border: '1px solid transparent',
        background: h ? 'rgba(255,255,255,0.10)' : 'transparent',
        color: active ? `rgb(${a})` : (h ? 'rgba(255,255,255,0.95)' : `rgba(255,255,255,${dim ? 0.5 : 0.72})`),
        transition: 'background 0.14s ease, color 0.14s ease, transform 0.14s ease',
        transform: h ? 'scale(1.08)' : 'scale(1)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Solid accent play/pause — the one loud element in the shell. */
function PlayBtn({ playing, onClick, size, accent }) {
  const [h, setH] = useState(false);
  const a = readableAccent(accent, 150);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      title={playing ? 'Pause' : 'Play'}
      aria-label={playing ? 'Pause' : 'Play'}
      style={{
        WebkitAppRegion: 'no-drag',
        width: size, height: size, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, borderRadius: 999, cursor: 'pointer', border: 'none',
        background: `rgb(${a})`,
        color: onAccent(a),
        boxShadow: h ? `0 4px 18px rgba(${a},0.45)` : `0 2px 10px rgba(0,0,0,0.35)`,
        transform: h ? 'scale(1.07)' : 'scale(1)',
        transition: 'transform 0.14s cubic-bezier(0.3,0.9,0.3,1), box-shadow 0.16s ease',
      }}
    >
      {playing ? I.Pause(Math.round(size * 0.5)) : (
        <span style={{ transform: `translateX(${Math.round(size * 0.035)}px)`, display: 'inline-flex' }}>
          {I.Play(Math.round(size * 0.5))}
        </span>
      )}
    </button>
  );
}

/**
 * Title that scrolls only when it actually overflows. Measured rather than
 * always-on, because a permanently sliding title in the corner of your screen
 * during a raid is exactly the kind of thing you'd turn the mini player off
 * over.
 */
function Scroller({ text, style, hover }) {
  const boxRef = useRef(null);
  const innerRef = useRef(null);
  const [over, setOver] = useState(0);

  useEffect(() => {
    const box = boxRef.current; const inner = innerRef.current;
    if (!box || !inner) return;
    const diff = inner.scrollWidth - box.clientWidth;
    setOver(diff > 6 ? diff + 12 : 0);
  }, [text, style?.fontSize]);

  const run = over > 0 && hover;
  return (
    <div ref={boxRef} style={{ overflow: 'hidden', width: '100%', maskImage: over ? 'linear-gradient(90deg, #000 0, #000 88%, transparent 100%)' : undefined, WebkitMaskImage: over ? 'linear-gradient(90deg, #000 0, #000 88%, transparent 100%)' : undefined }}>
      <div
        ref={innerRef}
        style={{
          ...style,
          whiteSpace: 'nowrap',
          display: 'inline-block',
          transform: run ? `translateX(-${over}px)` : 'translateX(0)',
          transition: run ? `transform ${Math.max(2.2, over / 26)}s linear` : 'transform 0.5s ease',
        }}
      >
        {text}
      </div>
    </div>
  );
}

/** Scrubber. Thickens on hover; drag to seek, release to commit. */
function Progress({ pos, duration, accent, onSeek, height = 4, bare = false, radius = 999 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState(null);
  const a = readableAccent(accent);
  const shown = drag != null ? drag : pos;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (shown / duration) * 100)) : 0;

  const at = (clientX) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };

  const down = (e) => {
    if (!duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(at(e.clientX));
  };
  const move = (e) => { if (drag != null) setDrag(at(e.clientX)); };
  const up = (e) => {
    if (drag == null) return;
    const v = at(e.clientX);
    setDrag(null);
    onSeek?.(v);
  };

  const thick = hover || drag != null ? height + 2 : height;
  return (
    <div
      ref={ref}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        WebkitAppRegion: 'no-drag',
        width: '100%', height: bare ? thick : Math.max(thick, 12),
        display: 'flex', alignItems: bare ? 'stretch' : 'center',
        cursor: duration ? 'pointer' : 'default', touchAction: 'none',
      }}
    >
      <div style={{
        position: 'relative', width: '100%', height: thick, borderRadius: radius,
        background: 'rgba(255,255,255,0.14)', overflow: 'hidden',
        transition: 'height 0.14s ease',
      }}>
        <div style={{
          position: 'absolute', inset: 0, width: `${pct}%`, borderRadius: radius,
          background: `rgb(${a})`,
          boxShadow: hover ? `0 0 10px rgba(${a},0.55)` : 'none',
          // Matches the publish cadence so the fill glides between updates
          // instead of stepping once a second.
          transition: drag != null ? 'none' : 'width 1s linear, box-shadow 0.16s ease',
        }} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the view */

export default function MiniPlayer() {
  const [state, setState] = useState(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [theme, setTheme] = useState(FALLBACK_THEME);
  const [size, setSize] = useState({ w: 356, h: 98 });
  const [hover, setHover] = useState(false);
  const [panel, setPanel] = useState(false);
  const [pos, setPos] = useState(0);
  const [volOpen, setVolOpen] = useState(false);
  const rootRef = useRef(null);
  const anchorRef = useRef({ position: 0, at: Date.now(), playing: false });

  /* ---------- Transparent page ------------------------------------------ */
  // index.html paints the body solid black for the main window. In a
  // transparent window that would fill the corners back in and square off
  // the radius, so this window opts out.
  useEffect(() => {
    const prevBody = document.body.style.background;
    const prevHtml = document.documentElement.style.background;
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.background = prevHtml;
    };
  }, []);

  /* ---------- Wiring ----------------------------------------------------- */
  useEffect(() => {
    const a = api();
    if (!a) return undefined;
    const offState = a.onState?.((payload) => {
      setState(payload);
      anchorRef.current = {
        position: Number(payload?.position) || 0,
        at: Number(payload?.at) || Date.now(),
        playing: !!payload?.isPlaying,
      };
    });
    const offOpts = a.onOptions?.((o) => setOptions((prev) => ({ ...prev, ...(o || {}) })));
    a.getState?.().then((s) => { if (s?.options) setOptions((p) => ({ ...p, ...s.options })); }).catch(() => {});
    a.requestState?.();
    return () => { offState?.(); offOpts?.(); };
  }, []);

  /* ---------- Interpolated position -------------------------------------- */
  useEffect(() => {
    const tick = () => {
      const { position, at, playing } = anchorRef.current;
      const dur = Number(state?.duration) || 0;
      const next = playing ? position + (Date.now() - at) / 1000 : position;
      setPos(dur ? Math.min(dur, Math.max(0, next)) : Math.max(0, next));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state?.duration, state?.position, state?.at, state?.isPlaying]);

  /* ---------- Cover theme ------------------------------------------------ */
  useEffect(() => {
    const src = state?.coverArt;
    if (!src) { setTheme(FALLBACK_THEME); return undefined; }
    let dead = false;
    sampleCoverTheme(src).then((t) => { if (!dead && t) setTheme(t); });
    return () => { dead = true; };
  }, [state?.coverArt]);

  /* ---------- Size ------------------------------------------------------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- Ghost mode hover-wake -------------------------------------- */
  // With click-through on, Electron still forwards mousemove (forward: true).
  // We use that to temporarily re-enable hit-testing while the pointer is
  // genuinely over the widget, so ghost mode doesn't mean "unusable" — it
  // means "invisible to clicks until you actually reach for it".
  useEffect(() => {
    const a = api();
    if (!a?.setClickThroughLive) return undefined;
    if (!options.clickThrough) { a.setClickThroughLive(false); return undefined; }

    let awake = false;
    let timer = null;
    const sleep = () => { awake = false; a.setClickThroughLive(true); };
    const wake = () => {
      if (!awake) { awake = true; a.setClickThroughLive(false); }
      clearTimeout(timer);
      timer = setTimeout(sleep, 1400);
    };
    a.setClickThroughLive(true);
    window.addEventListener('mousemove', wake);
    return () => {
      window.removeEventListener('mousemove', wake);
      clearTimeout(timer);
      a.setClickThroughLive(false);
    };
  }, [options.clickThrough]);

  /* ---------- Commands --------------------------------------------------- */
  const cmd = useCallback((type, value) => { api()?.command?.({ type, value }); }, []);
  const setOpt = useCallback((patch) => {
    setOptions((p) => ({ ...p, ...patch }));   // optimistic — main echoes back
    api()?.setOptions?.(patch);
  }, []);

  const togglePanel = useCallback(() => {
    setPanel((open) => {
      const next = !open;
      // Deferred: a side effect inside a state updater fires twice under
      // StrictMode, which would grow the window and then immediately try to
      // grow it again from the already-grown bounds.
      queueMicrotask(() => api()?.setPanelOpen?.(next));
      return next;
    });
  }, []);

  /* ---------- Corner resize grip ----------------------------------------- */
  // Transparent frameless windows have unreliable native resize edges on
  // Windows (the hit area falls outside the drawn rounded rect), so we drive
  // resizing ourselves from screen-space pointer deltas. screenX/screenY are
  // CSS px, which equal DIP at zoom 1 — the same unit setBounds() wants.
  const onGrip = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.screenX, y: e.screenY, w: size.w, h: size.h };
    let frame = null;
    let pending = null;
    const flush = () => {
      frame = null;
      if (pending) { api()?.resizeTo?.(pending); pending = null; }
    };
    const move = (ev) => {
      pending = {
        width: start.w + (ev.screenX - start.x),
        height: start.h + (ev.screenY - start.y),
      };
      if (frame == null) frame = requestAnimationFrame(flush);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (frame != null) cancelAnimationFrame(frame);
      flush();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [size.w, size.h]);

  /* ---------- Derived ---------------------------------------------------- */
  const { accent, wash, mid } = theme;
  const a = readableAccent(accent);
  const style = STYLE_ORDER.includes(options.style) ? options.style : 'compact';
  const hasTrack = !!state?.hasTrack;
  const duration = Number(state?.duration) || 0;
  const playing = !!state?.isPlaying;
  const cover = state?.coverArt || null;
  const chromeVisible = panel || hover || !options.autoHideChrome;

  const cycleStyle = () => {
    const i = STYLE_ORDER.indexOf(style);
    setOpt({ style: STYLE_ORDER[(i + 1) % STYLE_ORDER.length] });
  };

  /* ---------- Shell ------------------------------------------------------
   * Full-bleed: the shell IS the window, corners and all.
   *
   * NO outer drop shadow — see SHELL_MARGIN. NO backdrop-filter either: in a
   * transparent BrowserWindow there is no backdrop to sample, so it paints a
   * gray haze, and it forces the shell onto a GPU-composited layer, which is
   * precisely the case where Chromium stops honouring border-radius +
   * overflow:hidden on children. The bottom background layer is fully OPAQUE
   * (rgb, not rgba), so nothing behind the window shows through and there is
   * nothing worth blurring in the first place.
   *
   * Edge definition comes from two inset rings instead: a bright hairline for
   * the outline, and a soft dark one just inside it so the shell still reads
   * as a distinct object against bright game content. Both are inset, so
   * neither can be clipped by the window bounds.
   *
   * The hairline is a box-shadow rather than a real border — border plus
   * border-radius plus overflow:hidden leaves sub-pixel seams at the corners
   * where the clip and the stroke disagree.
   * ---------------------------------------------------------------------- */
  const shellStyle = {
    position: 'relative',
    width: '100%', height: '100%',
    boxSizing: 'border-box',
    borderRadius: 14,
    overflow: 'hidden',
    isolation: 'isolate',
    fontFamily: FONT,
    color: '#fff',
    WebkitAppRegion: 'drag',
    userSelect: 'none',
    boxShadow: [
      'inset 0 0 0 1px rgba(255,255,255,0.14)',
      'inset 0 0 22px rgba(0,0,0,0.55)',
    ].join(', '),
    background: `
      radial-gradient(130% 150% at 10% -10%, rgba(${accent},0.20), transparent 62%),
      linear-gradient(155deg, rgb(${mid}), rgb(${wash}) 48%, rgb(4, 4, 5))
    `,
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', padding: SHELL_MARGIN,
      boxSizing: 'border-box', background: 'transparent',
    }}>
    <div
      ref={rootRef}
      style={shellStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setVolOpen(false); }}
      onDoubleClick={(e) => {
        // Double-clicking the shell reopens studio, but double-tapping
        // play/pause must not — that's a normal thing to do by accident.
        if (e.target.closest?.('button, input')) return;
        cmd('restore');
      }}
    >
      {/* Ambient cover bleed — the same trick the fullscreen stage uses, just
          dialled down so text stays legible at 60px tall.
          The blur is wrapped in its OWN clipping layer: filter:blur() promotes
          an element to a composited layer, and a composited child is the case
          where Chromium can ignore the ancestor's rounded clip. Nesting a
          second overflow:hidden with the same radius forces the clip to hold.
          scale() rather than a negative inset keeps the blur's soft edge
          outside the visible box without relying on overflow to hide it. */}
      {cover && style !== 'art' ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 0,
          borderRadius: 14, overflow: 'hidden', pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url("${cover}")`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            filter: 'blur(30px) saturate(1.5)',
            transform: 'scale(1.45)',
            opacity: 0.30,
          }} />
        </div>
      ) : null}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.28), rgba(0,0,0,0.52))',
      }} />

      {/* Ghost-mode tell: without it, a click-through window that ignores you
          looks broken rather than intentional. */}
      {options.clickThrough ? (
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
          borderRadius: 14, border: `1px dashed rgba(${a},0.35)`,
        }} />
      ) : null}

      <div style={{ position: 'relative', zIndex: 2, width: '100%', height: '100%' }}>
        {style === 'full' ? (
          <FullLayout {...{ state, pos, duration, playing, cover, accent, size, hasTrack, cmd, hover, volOpen, setVolOpen, options }} />
        ) : style === 'compact' ? (
          <CompactLayout {...{ state, pos, duration, playing, cover, accent, size, hasTrack, cmd, hover, options }} />
        ) : style === 'minimal' ? (
          <MinimalLayout {...{ state, pos, duration, playing, cover, accent, size, hasTrack, cmd, hover, options }} />
        ) : (
          <ArtLayout {...{ state, pos, duration, playing, cover, accent, size, hasTrack, cmd, hover, options }} />
        )}
      </div>

      {/* Window chrome. Fades out when idle so a docked mini player is just
          art and a title, but never stops accepting clicks — same rule the
          fullscreen overlay's close button follows. */}
      <div style={{
        position: 'absolute', top: 4, right: 5, zIndex: 6,
        display: 'flex', alignItems: 'center', gap: 1,
        WebkitAppRegion: 'no-drag',
        opacity: chromeVisible ? 1 : 0,
        transform: chromeVisible ? 'translateY(0)' : 'translateY(-3px)',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        pointerEvents: 'auto',
      }}>
        <IconBtn size={22} accent={accent} active={options.alwaysOnTop} dim
          title={options.alwaysOnTop ? 'Pinned on top — click to unpin' : 'Keep on top'}
          onClick={() => setOpt({ alwaysOnTop: !options.alwaysOnTop })}>
          {I.Pin(12, options.alwaysOnTop)}
        </IconBtn>
        <IconBtn size={22} accent={accent} dim title={`Layout: ${STYLE_LABELS[style]} — click to change`} onClick={cycleStyle}>
          {I.Layout(12)}
        </IconBtn>
        <IconBtn size={22} accent={accent} dim active={panel} title="Mini player options" onClick={togglePanel}>
          {I.More(12)}
        </IconBtn>
        <IconBtn size={22} accent={accent} dim title="Back to studio" onClick={() => cmd('restore')}>
          {I.Expand(12)}
        </IconBtn>
        <IconBtn size={22} accent={accent} dim title="Close mini player" onClick={() => api()?.close?.()}>
          {I.Close(12)}
        </IconBtn>
      </div>

      {/* Resize grip */}
      <div
        onPointerDown={onGrip}
        title="Drag to resize"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, zIndex: 6,
          WebkitAppRegion: 'no-drag', cursor: 'nwse-resize',
          opacity: chromeVisible ? 0.5 : 0,
          transition: 'opacity 0.2s ease',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M15 8 L8 15 M15 12 L12 15" stroke="rgba(255,255,255,0.75)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </svg>
      </div>

      {panel ? (
        <OptionsPanel
          accent={accent}
          options={options}
          style={style}
          setOpt={setOpt}
          onClose={togglePanel}
          onSnap={(c) => api()?.snap?.(c)}
          onRestore={() => cmd('restore')}
        />
      ) : null}

      {!hasTrack ? (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5, display: 'flex',
          alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          padding: 14, pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(6,6,8,0.86), rgba(6,6,8,0.94))',
        }}>
          <div style={{ fontSize: Math.max(10, Math.min(12.5, size.h * 0.14)), color: 'rgba(255,255,255,0.55)', lineHeight: 1.45 }}>
            Nothing playing.<br />
            <span style={{ color: `rgba(${a},0.85)` }}>Start a track in studio</span> and it lands here.
          </div>
        </div>
      ) : null}
    </div>
    </div>
  );
}

/* ------------------------------------------------------------- layouts */

/** Art + meta + scrubber + the whole transport. The "desk" layout. */
function FullLayout({ state, pos, duration, playing, cover, accent, size, cmd, hover, volOpen, setVolOpen, options }) {
  const pad = 13;
  const art = Math.max(46, size.h - pad * 2);
  const titleSize = Math.max(12, Math.min(16.5, size.h * 0.105));
  const playSize = Math.max(28, Math.min(40, size.h * 0.23));
  const a = readableAccent(accent);
  const repeat = state?.repeat || 'off';
  const vol = Number(state?.volume ?? 1);

  return (
    <div style={{ display: 'flex', gap: 13, padding: pad, height: '100%', alignItems: 'stretch' }}>
      <Art cover={cover} size={art} accent={accent} radius={11} onClick={() => cmd('restore')} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}>
        <div style={{ minWidth: 0, paddingRight: 92 }}>
          <Scroller
            text={state?.title || 'Unknown title'}
            hover={hover}
            style={{ fontSize: titleSize, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.25 }}
          />
          <Scroller
            text={state?.artist || 'Unknown artist'}
            hover={hover}
            style={{ fontSize: Math.max(10, titleSize * 0.76), fontWeight: 500, color: 'rgba(255,255,255,0.58)', lineHeight: 1.35, marginTop: 1 }}
          />
        </div>

        {options.showProgress ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Time v={pos} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Progress pos={pos} duration={duration} accent={accent} onSeek={(v) => cmd('seek', v)} height={4} />
            </div>
            <Time v={duration} dim />
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconBtn size={26} accent={accent} active={!!state?.shuffleOn} title="Shuffle" onClick={() => cmd('shuffle')}>{I.Shuffle(14)}</IconBtn>
          <IconBtn size={28} accent={accent} title="Previous" onClick={() => cmd('prev')}>{I.Prev(15)}</IconBtn>
          <PlayBtn playing={playing} size={playSize} accent={accent} onClick={() => cmd('toggle')} />
          <IconBtn size={28} accent={accent} title="Next" onClick={() => cmd('next')}>{I.Next(15)}</IconBtn>
          <IconBtn size={26} accent={accent} active={repeat !== 'off'} title={`Repeat: ${repeat}`} onClick={() => cmd('repeat')}>
            {I.Repeat(14, repeat === 'one')}
          </IconBtn>

          <div style={{ flex: 1 }} />

          <div
            onMouseEnter={() => setVolOpen(true)}
            onMouseLeave={() => setVolOpen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, WebkitAppRegion: 'no-drag' }}
          >
            <div style={{
              width: volOpen ? Math.min(78, size.w * 0.2) : 0,
              opacity: volOpen ? 1 : 0,
              transition: 'width 0.2s cubic-bezier(0.3,0.9,0.3,1), opacity 0.16s ease',
              overflow: 'hidden',
            }}>
              <input
                type="range" min={0} max={1} step={0.01} value={vol}
                onChange={(e) => cmd('volume', Number(e.target.value))}
                aria-label="Volume"
                style={{
                  width: '100%', height: 4, appearance: 'none', WebkitAppearance: 'none',
                  borderRadius: 999, outline: 'none', cursor: 'pointer',
                  background: `linear-gradient(90deg, rgb(${a}) ${vol * 100}%, rgba(255,255,255,0.16) ${vol * 100}%)`,
                }}
              />
            </div>
            <IconBtn size={26} accent={accent} dim title="Volume" onClick={() => cmd('volume', vol > 0 ? 0 : 1)}>
              {I.Volume(14, vol <= 0.001)}
            </IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Art + meta + three buttons, hairline progress under the text. The default. */
function CompactLayout({ state, pos, duration, playing, cover, accent, size, cmd, hover, options }) {
  const pad = 10;
  const art = Math.max(40, size.h - pad * 2);
  const titleSize = Math.max(11.5, Math.min(14.5, size.h * 0.15));
  const playSize = Math.max(26, Math.min(34, size.h * 0.36));

  return (
    <div style={{ display: 'flex', gap: 11, padding: pad, height: '100%', alignItems: 'center' }}>
      <Art cover={cover} size={art} accent={accent} radius={9} onClick={() => cmd('restore')} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ minWidth: 0, paddingRight: hover ? 88 : 0, transition: 'padding 0.2s ease' }}>
          <Scroller
            text={state?.title || 'Unknown title'}
            hover={hover}
            style={{ fontSize: titleSize, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.25 }}
          />
          <Scroller
            text={state?.artist || 'Unknown artist'}
            hover={hover}
            style={{ fontSize: Math.max(9.5, titleSize * 0.78), fontWeight: 500, color: 'rgba(255,255,255,0.55)', lineHeight: 1.3 }}
          />
        </div>
        {options.showProgress ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Progress pos={pos} duration={duration} accent={accent} onSeek={(v) => cmd('seek', v)} height={3} />
            <div style={{ flexShrink: 0, fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.42)' }}>
              -{formatTime(Math.max(0, duration - pos))}
            </div>
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        <IconBtn size={26} accent={accent} title="Previous" onClick={() => cmd('prev')}>{I.Prev(14)}</IconBtn>
        <PlayBtn playing={playing} size={playSize} accent={accent} onClick={() => cmd('toggle')} />
        <IconBtn size={26} accent={accent} title="Next" onClick={() => cmd('next')}>{I.Next(14)}</IconBtn>
      </div>
    </div>
  );
}

/** One strip: thumb, title, play, next. Progress is the bottom edge itself. */
function MinimalLayout({ state, pos, duration, playing, cover, accent, size, cmd, hover, options }) {
  const pad = 8;
  const art = Math.max(26, Math.min(38, size.h - pad * 2));
  const titleSize = Math.max(10.5, Math.min(13, size.h * 0.21));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: `0 ${pad}px 0 ${pad}px`, minHeight: 0 }}>
        <Art cover={cover} size={art} accent={accent} radius={7} onClick={() => cmd('restore')} />
        <div style={{ flex: 1, minWidth: 0, paddingRight: hover ? 84 : 0, transition: 'padding 0.2s ease' }}>
          <Scroller
            text={state?.title || 'Unknown title'}
            hover={hover}
            style={{ fontSize: titleSize, fontWeight: 650, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.2 }}
          />
          <Scroller
            text={state?.artist || ''}
            hover={hover}
            style={{ fontSize: Math.max(9, titleSize * 0.76), fontWeight: 500, color: 'rgba(255,255,255,0.5)', lineHeight: 1.25 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0 }}>
          <PlayBtn playing={playing} size={Math.max(22, Math.min(28, size.h * 0.46))} accent={accent} onClick={() => cmd('toggle')} />
          <IconBtn size={24} accent={accent} title="Next" onClick={() => cmd('next')}>{I.Next(13)}</IconBtn>
        </div>
      </div>
      {options.showProgress ? (
        <Progress pos={pos} duration={duration} accent={accent} onSeek={(v) => cmd('seek', v)} height={3} bare radius={0} />
      ) : null}
    </div>
  );
}

/** Just the artwork. Everything else lives under a hover scrim. */
function ArtLayout({ state, pos, duration, playing, cover, accent, size, cmd, hover, options }) {
  const a = readableAccent(accent);
  const playSize = Math.max(30, Math.min(52, size.w * 0.24));
  const [coverViewer, setCoverViewer] = useState(null);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {cover ? (
        <img
          src={cover}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
          onClick={() => cover && setCoverViewer({ url: cover, title: state?.title, artist: state?.artist })}
        />
      ) : (
        <div style={{
          width: '100%', height: '100%',
          background: `linear-gradient(140deg, rgba(${accent},0.28), rgba(8,8,10,0.95))`,
        }} />
      )}

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        padding: 11, gap: 7,
        background: hover
          ? 'linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.12) 34%, rgba(0,0,0,0.82) 100%)'
          : 'linear-gradient(180deg, rgba(0,0,0,0) 60%, rgba(0,0,0,0.35) 100%)',
        opacity: 1,
        transition: 'background 0.25s ease',
      }}>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          opacity: hover ? 1 : 0, transform: hover ? 'scale(1)' : 'scale(0.9)',
          transition: 'opacity 0.2s ease, transform 0.2s cubic-bezier(0.3,0.9,0.3,1)',
          pointerEvents: hover ? 'auto' : 'none',
        }}>
          <IconBtn size={30} accent={accent} title="Previous" onClick={() => cmd('prev')}>{I.Prev(16)}</IconBtn>
          <PlayBtn playing={playing} size={playSize} accent={accent} onClick={() => cmd('toggle')} />
          <IconBtn size={30} accent={accent} title="Next" onClick={() => cmd('next')}>{I.Next(16)}</IconBtn>
        </div>

        <div style={{
          minWidth: 0,
          opacity: hover ? 1 : 0.9,
          transition: 'opacity 0.2s ease',
        }}>
          <Scroller
            text={state?.title || ''}
            hover={hover}
            style={{ fontSize: Math.max(10.5, Math.min(14, size.w * 0.065)), fontWeight: 700, color: '#fff', textShadow: '0 1px 6px rgba(0,0,0,0.8)', lineHeight: 1.25 }}
          />
          <Scroller
            text={state?.artist || ''}
            hover={hover}
            style={{ fontSize: Math.max(9, Math.min(11.5, size.w * 0.052)), fontWeight: 500, color: `rgba(${a},0.9)`, textShadow: '0 1px 6px rgba(0,0,0,0.8)', lineHeight: 1.3 }}
          />
        </div>
        {options.showProgress ? (
          <Progress pos={pos} duration={duration} accent={accent} onSeek={(v) => cmd('seek', v)} height={3} />
        ) : null}
      </div>
      {coverViewer && (
        <div
          className="sth-mini-cover-viewer"
          onClick={() => setCoverViewer(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            animation: 'sthCoverViewerIn 180ms cubic-bezier(0.22,1,0.36,1) both',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '90vw', maxHeight: '85vh',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            }}
          >
            <img
              src={coverViewer.url}
              alt={coverViewer.title || 'Cover art'}
              style={{
                maxWidth: '100%', maxHeight: '75vh',
                borderRadius: 8, boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.6)',
                objectFit: 'contain',
              }}
            />
            <div style={{ display: 'flex', gap: 10, color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center' }}>
              <button
                type="button"
                onClick={async () => {
                  const api = window.electronAPI;
                  if (api?.exportCoverSaveAs) {
                    await api.exportCoverSaveAs(coverViewer.url, `${coverViewer.artist || 'Unknown'} - ${coverViewer.title || 'Unknown'}`);
                  }
                }}
                style={{
                  padding: '8px 16px', borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; }}
              >
                Save Cover Art
              </button>
              <button
                type="button"
                onClick={() => setCoverViewer(null)}
                style={{
                  padding: '8px 16px', borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
              >
                Close
              </button>
            </div>
          </div>
          <style jsx>{`
            @keyframes sthCoverViewerIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- fragments */

function Art({ cover, size, accent, radius = 10, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      title="Open studio"
      style={{
        WebkitAppRegion: 'no-drag',
        width: size, height: size, flexShrink: 0, padding: 0, cursor: 'pointer',
        borderRadius: radius, overflow: 'hidden', position: 'relative',
        border: '1px solid rgba(255,255,255,0.12)',
        background: `linear-gradient(140deg, rgba(${accent},0.30), rgba(10,10,12,0.9))`,
        boxShadow: h ? '0 6px 20px rgba(0,0,0,0.5)' : '0 3px 12px rgba(0,0,0,0.42)',
        transform: h ? 'scale(1.03)' : 'scale(1)',
        transition: 'transform 0.16s cubic-bezier(0.3,0.9,0.3,1), box-shadow 0.16s ease',
      }}
    >
      {cover ? (
        <img src={cover} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : null}
    </button>
  );
}

function Time({ v, dim = false }) {
  return (
    <div style={{
      flexShrink: 0, fontSize: 9.5, fontVariantNumeric: 'tabular-nums',
      color: `rgba(255,255,255,${dim ? 0.38 : 0.55})`, letterSpacing: '0.02em',
    }}>
      {formatTime(Math.max(0, v || 0))}
    </div>
  );
}

/* ---------------------------------------------------------------- panel */

function OptionsPanel({ accent, options, style, setOpt, onClose, onSnap, onRestore }) {
  const a = readableAccent(accent);
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 20,
      WebkitAppRegion: 'no-drag',
      background: 'linear-gradient(160deg, rgb(13, 13, 15), rgb(6, 6, 8))',
      padding: '11px 12px 12px',
      display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'drag' }}>
        <div style={{ flex: 1, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
          Mini player
        </div>
        <IconBtn size={22} accent={accent} dim title="Done" onClick={onClose}>{I.Close(12)}</IconBtn>
      </div>

      <Field label="Layout">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {STYLE_ORDER.map((id) => {
            const on = style === id;
            return (
              <button key={id} type="button" onClick={() => setOpt({ style: id })} style={{
                padding: '7px 8px', borderRadius: 9, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                border: `1px solid ${on ? `rgba(${a},0.5)` : 'rgba(255,255,255,0.1)'}`,
                background: on ? `rgba(${a},0.16)` : 'rgba(255,255,255,0.04)',
                color: on ? `rgb(${a})` : 'rgba(255,255,255,0.65)',
                transition: 'background 0.14s ease, color 0.14s ease, border-color 0.14s ease',
              }}>{STYLE_LABELS[id]}</button>
            );
          })}
        </div>
      </Field>

      <Field label={`Opacity — ${Math.round(options.opacity * 100)}%`}>
        <input
          type="range" min={0.35} max={1} step={0.01} value={options.opacity}
          onChange={(e) => setOpt({ opacity: Number(e.target.value) })}
          aria-label="Opacity"
          style={{
            width: '100%', height: 4, appearance: 'none', WebkitAppearance: 'none',
            borderRadius: 999, outline: 'none', cursor: 'pointer',
            background: `linear-gradient(90deg, rgb(${a}) ${((options.opacity - 0.35) / 0.65) * 100}%, rgba(255,255,255,0.16) ${((options.opacity - 0.35) / 0.65) * 100}%)`,
          }}
        />
      </Field>

      <Field label="Snap to">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
          {[['tl', '↖'], ['tr', '↗'], ['c', '◎'], ['bl', '↙'], ['br', '↘']].map(([id, glyph]) => (
            <button key={id} type="button" onClick={() => onSnap(id)} title={`Snap ${id}`} style={{
              padding: '6px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12,
              border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.7)',
            }}>{glyph}</button>
          ))}
        </div>
      </Field>

      <Toggle label="Keep on top" hint="Floats over other windows, including borderless games." accent={a}
        on={options.alwaysOnTop} onChange={(v) => setOpt({ alwaysOnTop: v })} />
      <Toggle label="Click-through" hint="Clicks pass to the game. Wakes on hover; Ctrl+Alt+G toggles." accent={a}
        on={options.clickThrough} onChange={(v) => setOpt({ clickThrough: v })} />
      <Toggle label="Hide studio window" hint="Tucks the main window away while the mini is up." accent={a}
        on={options.hideMain} onChange={(v) => setOpt({ hideMain: v })} />
      <Toggle label="Hide buttons when idle" hint="Controls fade out until you move the mouse over it." accent={a}
        on={options.autoHideChrome} onChange={(v) => setOpt({ autoHideChrome: v })} />
      <Toggle label="Show progress" hint="The scrubber. Off leaves art and titles only." accent={a}
        on={options.showProgress} onChange={(v) => setOpt({ showProgress: v })} />

      <button type="button" onClick={onRestore} style={{
        marginTop: 2, padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
        fontSize: 11.5, fontWeight: 700,
        border: `1px solid rgba(${a},0.45)`, background: `rgba(${a},0.15)`, color: `rgb(${a})`,
      }}>
        Back to studio
      </button>

      <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5, textAlign: 'center' }}>
        Ctrl+Alt+M opens and closes the mini player from anywhere.
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.38)', marginBottom: 5 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, on, onChange, accent }) {
  return (
    <button type="button" onClick={() => onChange(!on)} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
      padding: '8px 9px', borderRadius: 10, cursor: 'pointer',
      border: `1px solid ${on ? `rgba(${accent},0.4)` : 'rgba(255,255,255,0.08)'}`,
      background: on ? `rgba(${accent},0.12)` : 'rgba(255,255,255,0.035)',
      transition: 'background 0.16s ease, border-color 0.16s ease',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#fff' }}>{label}</div>
        {hint ? <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)', marginTop: 2, lineHeight: 1.4 }}>{hint}</div> : null}
      </div>
      <div aria-hidden style={{
        width: 32, height: 18, borderRadius: 999, flexShrink: 0, position: 'relative',
        background: on ? `rgba(${accent},0.85)` : 'rgba(255,255,255,0.14)',
        border: '1px solid rgba(255,255,255,0.18)', transition: 'background 0.18s ease',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: on ? 15 : 2, width: 12, height: 12, borderRadius: '50%',
          background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          transition: 'left 0.18s cubic-bezier(0.3,0.9,0.3,1)',
        }} />
      </div>
    </button>
  );
}
