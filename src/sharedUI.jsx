import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tooltip — wraps any child element and shows a styled glass tooltip on
 * hover after a short delay. Replaces the native browser `title=""`
 * tooltip everywhere it was visually jarring (transport buttons, dock
 * bar buttons, etc.). Native `title=""` still works fine for things like
 * truncated track row text where free OS tooltips are appropriate.
 *
 * Behavior:
 *   - 400ms hover delay before appearing (matches OS tooltip timing so
 *     the user doesn't get spammed with tooltips while skimming)
 *   - 120ms fade-in
 *   - Disappears immediately on mouse-leave (no exit fade — feels snappier)
 *   - Auto-flips above the target if the target is in the bottom 30% of
 *     the viewport (avoids the tooltip getting clipped at the screen edge)
 *   - Only one tooltip visible at a time; the wrapper component is
 *     stateful per-instance, but mouse-leave cancels pending appearances
 *
 * Usage:
 *   <Tooltip label="Shuffle"><button>...</button></Tooltip>
 *
 * Or for components that already accept a `title` prop, integrate the
 * Tooltip rendering inside the component itself (see BottomDockBtn).
 */
function Tooltip({ label, children, side = 'auto', delay = 400 }) {
  const wrapRef = useRef(null);
  const timerRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: '100%', bottom: 'auto', marginTop: 6, marginBottom: 0 });

  const show = () => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      // At the moment of appearance, decide above-or-below based on
      // viewport position. If the target is in the bottom third, flip up.
      if (wrapRef.current && side === 'auto') {
        const rect = wrapRef.current.getBoundingClientRect();
        const viewportH = window.innerHeight || document.documentElement.clientHeight;
        if (rect.bottom > viewportH * 0.7) {
          setPosition({ top: 'auto', bottom: '100%', marginTop: 0, marginBottom: 6 });
        } else {
          setPosition({ top: '100%', bottom: 'auto', marginTop: 6, marginBottom: 0 });
        }
      } else if (side === 'top') {
        setPosition({ top: 'auto', bottom: '100%', marginTop: 0, marginBottom: 6 });
      }
      setVisible(true);
      timerRef.current = null;
    }, delay);
  };

  const hide = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setVisible(false);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!label) return children;

  return (
    <span
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      {children}
      {visible ? (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: position.top, bottom: position.bottom,
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: position.marginTop, marginBottom: position.marginBottom,
            padding: '5px 9px',
            borderRadius: 7,
            background: 'rgba(18, 18, 20, 0.94)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 8px 22px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)',
            color: '#fff',
            fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 100,
            animation: 'imm-tt-in 120ms ease-out',
            WebkitFontSmoothing: 'antialiased',
            backfaceVisibility: 'hidden',
          }}
        >
          <style>{`
            @keyframes imm-tt-in {
              from { opacity: 0; transform: translateX(-50%) translateY(${position.bottom === 'auto' ? '-3px' : '3px'}); }
              to   { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
          `}</style>
          {label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * HeartSlider — the seek bar / volume slider with a heart-shaped thumb.
 *
 * Click-to-jump and drag-to-scrub both supported. While dragging, the
 * value is reported live so the underlying audio (or volume) updates in
 * real time. The heart thumb is an inline SVG positioned by left%, scaling
 * up slightly on hover/drag so the user knows it's grabbable.
 *
 * Props:
 *   value      — current value (0..max)
 *   max        — upper bound. If 0 / falsy, the slider becomes inert.
 *   onChange   — fn(newValue) called continuously during drag and on click.
 *                Called as the user drags so audio/volume tracks the cursor.
 *   accent     — RGB string used to tint the filled portion + thumb.
 *   ariaLabel  — accessibility label
 *   thumbSize  — thumb width/height in px (default 12)
 *   thumbShape — either 'heart' or 'circle'; the heart is the default.
 */
/**
 * Optional niceties:
 *   formatHoverLabel — fn(value) => string. When provided, hovering the
 *     track shows a small bubble with the value under the cursor (the seek
 *     bar passes formatTime, so you see WHERE you'll land before clicking).
 *   wheelStep — fraction of max per wheel notch. When provided, scrolling
 *     over the slider nudges the value (volume passes 0.05).
 */
function HeartSlider({ value = 0, max = 0, onChange, accent = '255, 255, 255', ariaLabel = 'Slider', thumbSize = 12, thumbShape = 'heart', formatHoverLabel = null, wheelStep = 0 }) {
  const trackRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 0..1 position of the cursor along the track — drives the hover bubble.
  const [hoverRatio, setHoverRatio] = useState(0);

  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const inert = !max;

  // Convert pointer X to a value within [0, max]. Clamped so dragging
  // outside the track bounds still produces in-range values.
  const valueFromEvent = useCallback((clientX) => {
    if (!trackRef.current || !max) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * max;
  }, [max]);

  const handlePointerDown = (e) => {
    if (inert) return;
    e.preventDefault();
    // Use pointer capture so we keep getting move/up events even if the
    // pointer leaves the track. setPointerCapture on the track element.
    try { trackRef.current?.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    setDragging(true);
    onChange?.(valueFromEvent(e.clientX));
  };

  const handlePointerMove = (e) => {
    if (!dragging) return;
    onChange?.(valueFromEvent(e.clientX));
  };

  const handlePointerUp = (e) => {
    if (!dragging) return;
    setDragging(false);
    try { trackRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  };

  const handleKey = (e) => {
    if (inert) return;
    const step = max / 100; // 1% steps for keyboard
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange?.(Math.min(max, value + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange?.(Math.max(0, value - step));
    } else if (e.key === 'Home') {
      e.preventDefault(); onChange?.(0);
    } else if (e.key === 'End') {
      e.preventDefault(); onChange?.(max);
    }
  };

  const handleMouseMove = (e) => {
    if (!formatHoverLabel || inert || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    setHoverRatio(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  const handleWheel = (e) => {
    if (!wheelStep || inert) return;
    const dir = e.deltaY < 0 ? 1 : -1;
    onChange?.(Math.max(0, Math.min(max, value + dir * wheelStep * safeMax)));
  };

  // Thumb visible when hovered or dragging — keeps the bar visually
  // minimal at rest (Spotify-style) and reveals the heart on intent.
  const thumbVisible = hovered || dragging;
  const thumbScale = dragging ? 1.25 : (hovered ? 1.1 : 1);

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={inert ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max || 1}
      aria-valuenow={value}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onKeyDown={handleKey}
      style={{
        flex: 1, height: 16, position: 'relative', display: 'flex', alignItems: 'center',
        cursor: inert ? 'default' : 'pointer',
        // Prevent text-selection / image-drag mid-drag
        userSelect: 'none', WebkitUserSelect: 'none',
        outline: 'none',
        // Subtle focus ring via box-shadow on hover only — full focus
        // would clash with the cover canvas.
        touchAction: 'none',
      }}
    >
      {/* Track (background) */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 2, top: '50%', marginTop: -1,
        background: 'rgba(255,255,255,0.14)', borderRadius: 2,
        transition: 'height 0.15s',
      }} />
      {/* Hover timestamp bubble — shows the value under the cursor while
          hovering, and rides the thumb while dragging so a scrub always
          reads out where it will land. */}
      {formatHoverLabel && (hovered || dragging) && !inert ? (
        <div style={{
          position: 'absolute',
          left: `${(dragging ? pct / 100 : hoverRatio) * 100}%`,
          bottom: 'calc(100% + 2px)',
          transform: 'translateX(-50%)',
          padding: '2px 6px', borderRadius: 5,
          background: 'rgba(20,20,22,0.95)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: 'rgba(255,255,255,0.9)',
          fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap', pointerEvents: 'none',
          boxShadow: '0 3px 10px rgba(0,0,0,0.4)',
        }}>
          {formatHoverLabel(dragging ? value : hoverRatio * safeMax)}
        </div>
      ) : null}
      {/* Filled portion */}
      <div style={{
        position: 'absolute', left: 0, width: `${pct}%`, height: 2, top: '50%', marginTop: -1,
        background: thumbVisible ? `rgba(${accent}, 1)` : 'rgba(255,255,255,0.95)',
        borderRadius: 2, maxWidth: '100%',
        // Smoothly interpolate the fill between the (coarse) time updates so
        // the playhead glides instead of stepping. Disabled while dragging so
        // a manual seek tracks the pointer with zero lag.
        transition: dragging ? 'background 0.18s' : 'width 0.18s linear, background 0.18s',
        // Slight glow when grabbing so the bar feels alive
        boxShadow: dragging ? `0 0 8px rgba(${accent}, 0.45)` : 'none',
      }} />
      {/* Heart thumb. Positioned by left% with translate to center. SVG
          is filled with the accent color when active, white otherwise.
          Scale animation gives it a "pop" on grab. */}
      <div style={{
        position: 'absolute',
        left: `${pct}%`,
        top: '50%',
        transform: `translate(-50%, -50%) scale(${thumbScale})`,
        opacity: thumbVisible ? 1 : 0,
        transition: dragging
          ? 'opacity 0.18s ease, transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)'
          : 'opacity 0.18s ease, transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), left 0.18s linear',
        pointerEvents: 'none',
        // Tiny drop-shadow so the heart reads against any cover-art color
        filter: dragging
          ? `drop-shadow(0 2px 4px rgba(0,0,0,0.5)) drop-shadow(0 0 6px rgba(${accent}, 0.6))`
          : 'drop-shadow(0 1px 3px rgba(0,0,0,0.45))',
      }}>
        <svg
          width={thumbSize} height={thumbSize}
          viewBox="0 0 24 24"
          fill={dragging ? `rgb(${accent})` : '#fff'}
          stroke={thumbShape === 'circle' ? 'rgba(255,255,255,0.7)' : 'none'}
          strokeWidth={thumbShape === 'circle' ? 1.5 : 0}
          aria-hidden
          style={{ display: 'block' }}
        >
          {thumbShape === 'circle' ? (
            <circle cx="12" cy="12" r="8" />
          ) : (
            <path d="M12 21s-7-4.35-9.5-8.5C.92 9.4 2.18 5 6 5c2.04 0 3.4 1.13 4.5 2.5C11.6 6.13 12.96 5 15 5c3.82 0 5.08 4.4 3.5 7.5C19 16.65 12 21 12 21z" />
          )}
        </svg>
      </div>
    </div>
  );
}


/**
 * ExplicitBadge — small "E" indicator that appears next to a track title when
 * the streaming service flagged the song as explicit. Inline-block, ~14px
 * square, white text on a translucent dark plate. Only shown when
 * `track.explicit === 1`; we deliberately don't show a "clean" badge for
 * `=== 0` because the absence of the E is itself the signal.
 */
function ExplicitBadge() {
  return (
    <span
      title="Explicit"
      aria-label="Explicit lyrics"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: 3,
        background: 'rgba(255, 255, 255, 0.18)',
        color: 'rgba(255, 255, 255, 0.85)',
        fontSize: 8.5, fontWeight: 700, letterSpacing: '-0.02em',
        flexShrink: 0,
        lineHeight: 1, paddingTop: 1,
        userSelect: 'none',
      }}
    >E</span>
  );
}


function GhostBtn({ children, onClick, title, active, size = 36 }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: size, height: size, borderRadius: '50%', border: 'none', background: 'transparent',
        color: active ? '#fff' : hov ? '#fff' : 'rgba(255,255,255,0.65)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative', padding: 0, transition: 'color 0.16s',
      }}
    >
      {active ? (
        <span
          aria-hidden
          style={{
            position: 'absolute', bottom: 2, width: 3, height: 3, borderRadius: '50%', background: '#fff',
          }}
        />
      ) : null}
      {children}
    </button>
  );
}

/** Skip button (prev/next) — thin line icon, just brightens on hover. */
function MediaSkipBtn({ children, onClick, title }) {
  const [hov, setHov] = useState(false);
  return (
    <Tooltip label={title} side="top">
      <button type="button" onClick={onClick} aria-label={title}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'transparent',
          color: hov ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.75)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, transition: 'color 0.2s, transform 0.15s',
          transform: hov ? 'scale(1.08)' : 'scale(1)',
        }}>
        {children}
      </button>
    </Tooltip>
  );
}

/** Play/pause button — no circle, just the rounded-triangle outline (larger than skip buttons). */
function MediaPlayPauseBtn({ onClick, isPlaying }) {
  const [hov, setHov] = useState(false);
  const label = isPlaying ? 'Pause' : 'Play';
  return (
    <Tooltip label={label} side="top">
      <button type="button" onClick={onClick} aria-label={label}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          width: 56, height: 56, borderRadius: '50%',
          border: 'none', background: 'transparent',
          color: hov ? '#fff' : 'rgba(255,255,255,0.85)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
          transition: 'color 0.2s, transform 0.15s',
          transform: hov ? 'scale(1.08)' : 'scale(1)',
          flexShrink: 0,
        }}>
        {isPlaying ? (
          /* Pause — filled rounded pills */
          <svg width="38" height="38" viewBox="0 0 32 32" fill="currentColor">
            <rect x="10.5" y="7" width="4" height="18" rx="2" />
            <rect x="17.5" y="7" width="4" height="18" rx="2" />
          </svg>
        ) : (
          /* Play — filled rounded triangle (no circle behind, matches v2 reference) */
          <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 2 }}>
            <path d="M8 5.6c-1.4-1-3.5 0-3.5 1.7v9.4c0 1.75 2.1 2.75 3.5 1.7l8-5c1.4-.85 1.4-2.65 0-3.5l-8-4.3z" />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}

/** Toggle button (shuffle/repeat) — bare icon with active dot under it. */
function MediaToggleBtn({ children, onClick, title, active }) {
  const [hov, setHov] = useState(false);
  return (
    <Tooltip label={title} side="top">
      <button type="button" onClick={onClick} aria-label={title}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          width: 32, height: 40, border: 'none', background: 'transparent',
          color: active ? '#fff' : hov ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
          cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.2s',
          position: 'relative',
        }}>
        {children}
        {/* Active dot indicator below icon */}
        {active ? (
          <span aria-hidden style={{
            position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)',
            width: 3, height: 3, borderRadius: '50%',
            background: '#fff',
          }} />
        ) : null}
      </button>
    </Tooltip>
  );
}

/**
 * ImmerseTooltipLayer — a single app-wide layer that replaces EVERY native
 * browser `title=""` tooltip with the Immerse glass style, without touching
 * any call site. Mount it once near the app root.
 *
 * How it works: it listens (capture phase) for hover on any element carrying
 * a `title`. On hover it stashes the title in `data-imm-title` and removes the
 * `title` attribute (so the OS tooltip never appears), waits the usual delay,
 * then renders a styled tooltip positioned over the element via a portal. On
 * mouse-leave / scroll / mousedown it restores the `title` and hides.
 *
 * The explicit <Tooltip> wrapper (used for the dock / transport buttons) sets
 * no native `title`, so the two never collide — both render the same look.
 */
function ImmerseTooltipLayer() {
  const [tip, setTip] = useState(null);
  const timerRef = useRef(null);
  const elRef = useRef(null);

  useEffect(() => {
    const DELAY = 400;
    const clear = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
    const findTitled = (node) => {
      let el = node;
      while (el && el.nodeType === 1 && el !== document.body) {
        if (el.getAttribute && el.getAttribute('title')) return el;
        el = el.parentElement;
      }
      return null;
    };
    const restore = (el) => {
      if (el && el.dataset && el.dataset.immTitle != null) {
        el.setAttribute('title', el.dataset.immTitle);
        delete el.dataset.immTitle;
      }
    };
    const hide = () => {
      clear();
      if (elRef.current) { restore(elRef.current); elRef.current = null; }
      setTip(null);
    };
    const onOver = (e) => {
      const el = findTitled(e.target);
      if (!el || el === elRef.current) return;
      hide();
      const text = el.getAttribute('title');
      if (!text) return;
      el.dataset.immTitle = text;        // stash + suppress native tooltip
      el.removeAttribute('title');
      elRef.current = el;
      clear();
      timerRef.current = setTimeout(() => {
        if (elRef.current !== el || !el.isConnected) { hide(); return; }
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const above = r.bottom > vh * 0.7;
        const x = Math.min(Math.max(r.left + r.width / 2, 60), vw - 60);
        setTip({ text, x, y: above ? r.top - 6 : r.bottom + 6, above });
        timerRef.current = null;
      }, DELAY);
    };
    const onOut = (e) => {
      if (!elRef.current) return;
      const to = e.relatedTarget;
      if (to && elRef.current.contains && elRef.current.contains(to)) return;
      hide();
    };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      clear();
      if (elRef.current) restore(elRef.current);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div role="tooltip" style={{
      position: 'fixed', left: tip.x, top: tip.y,
      transform: `translateX(-50%)${tip.above ? ' translateY(-100%)' : ''}`,
      padding: '5px 9px', borderRadius: 7,
      background: 'rgba(18, 18, 20, 0.94)',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 8px 22px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)',
      color: '#fff', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em',
      maxWidth: 280, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.35,
      pointerEvents: 'none', zIndex: 100000,
      animation: 'imm-tt-in 120ms ease-out',
      WebkitFontSmoothing: 'antialiased',
    }}>
      <style>{`@keyframes imm-tt-in{from{opacity:0}to{opacity:1}}`}</style>
      {tip.text}
    </div>,
    document.body
  );
}

/**
 * DownloadProgressBar — a thin progress bar used by the Find/Download UIs
 * (both the homepage tabs and the fullscreen command center).
 *
 *   pct  — 0..1 for a determinate bar; null/undefined → indeterminate
 *          (an animated sweeping stripe), used while a download is running
 *          but hasn't reported a percentage yet (e.g. yt-dlp is still
 *          resolving a source, or the source doesn't report progress).
 *   accent — "r, g, b" string; the fill colour.
 *   label  — optional caption under the bar (e.g. "45%" or "3 / 12").
 */
let _dlpbKeyframesInjected = false;
function ensureDlpbKeyframes() {
  if (_dlpbKeyframesInjected || typeof document === 'undefined') return;
  _dlpbKeyframesInjected = true;
  const s = document.createElement('style');
  s.textContent = '@keyframes sharedDlIndet { 0% { transform: translateX(-120%); } 100% { transform: translateX(360%); } }';
  document.head.appendChild(s);
}

function DownloadProgressBar({ pct = null, accent = '128, 128, 128', label = null, height = 4 }) {
  ensureDlpbKeyframes();
  const determinate = typeof pct === 'number' && Number.isFinite(pct);
  const clamped = determinate ? Math.max(0, Math.min(1, pct)) : 0;
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div style={{ position: 'relative', height, borderRadius: 999, overflow: 'hidden', background: 'rgba(255,255,255,0.12)' }}>
        {determinate ? (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(clamped * 100).toFixed(1)}%`, background: `rgb(${accent})`, borderRadius: 999, transition: 'width 0.2s ease' }} />
        ) : (
          <div style={{ position: 'absolute', top: 0, bottom: 0, width: '38%', background: `rgb(${accent})`, borderRadius: 999, animation: 'sharedDlIndet 1.1s ease-in-out infinite' }} />
        )}
      </div>
      {label ? (
        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)', marginTop: 3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      ) : null}
    </div>
  );
}

/**
 * useDownloadProgress — subscribes to the three main-process progress
 * streams and returns a map keyed the way the Find/Download UIs key their
 * rows, so a row can read its own live progress with `dlProgress[dlKey]`.
 *
 *   import:progress          → keyed by the caller's `progressId` (== the row's
 *                              own dl key), for yt-dlp (Spotify song/album).
 *   soulseek:downloadProgress → keyed by track id → `t:<id>`.
 *   soulseek:albumProgress    → keyed by album id → `ssa:<id>`.
 *
 * Each entry is { pct?: 0..1, phase, throughputBps?, currentFile? }. Rows
 * should only render a bar while their dlState is 'busy'; stale entries are
 * harmless because the render gates on busy state.
 */
function useDownloadProgress() {
  const [dlProgress, setDlProgress] = useState({});
  const set = useCallback((key, patch) => {
    if (!key) return;
    setDlProgress((m) => ({ ...m, [key]: { ...(m[key] || {}), ...patch } }));
  }, []);
  const clear = useCallback((key) => {
    if (!key) return;
    setDlProgress((m) => {
      if (!(key in m)) return m;
      const n = { ...m }; delete n[key]; return n;
    });
  }, []);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api) return undefined;
    const offs = [];

    offs.push(api.onImportProgress?.((p) => {
      if (!p?.id) return;
      if (p.state === 'done' || p.state === 'failed') { clear(p.id); return; }
      set(p.id, { pct: typeof p.pct === 'number' ? p.pct : null, phase: p.state || 'downloading' });
    }));

    offs.push(api.onSoulseekDownloadProgress?.((p) => {
      if (!p?.id) return;
      const key = `t:${p.id}`;
      if (p.state === 'done' || p.state === 'failed') { clear(key); return; }
      set(key, { pct: typeof p.pct === 'number' ? p.pct : null, phase: 'downloading', throughputBps: p.throughputBps });
    }));

    offs.push(api.onSoulseekAlbumProgress?.((p) => {
      if (!p?.albumId) return;
      const key = `ssa:${p.albumId}`;
      if (p.state === 'done' || p.state === 'failed') { clear(key); return; }
      const pct = p.total ? Math.min(p.completed ?? 0, p.total) / p.total : null;
      set(key, { pct, phase: 'downloading', currentFile: p.currentFile, completed: p.completed, total: p.total });
    }));

    return () => { offs.forEach((o) => { try { o?.(); } catch { /* ignore */ } }); };
  }, [set, clear]);

  return { dlProgress, clearDlProgress: clear };
}

/**
 * VideoPicker — manual YouTube video chooser for imports that fail automatic
 * tier-matching (or that the user simply wants to override). Given the track
 * meta (title/artists/album art/duration/etc.), it lists YouTube candidates
 * and lets the user pick the right one; the chosen video is imported by ID
 * with the original metadata preserved. Portaled to <body> so it renders above
 * everything, including the fullscreen command-center overlay.
 *
 * Props:
 *   open        — whether the modal is shown
 *   meta        — import metadata (same shape passed to importFromYoutubeSearch)
 *   seed        — optional candidate list to show immediately (e.g. the
 *                 `candidates` array returned with a 'no-tier-match' failure)
 *   accent      — "r, g, b" accent string
 *   onClose     — called when dismissed
 *   onImported  — (track) → called after a successful pick+import
 *   pushToast   — optional toast function for success/error feedback
 */
function VideoPicker({ open, meta, seed = null, accent = '150,150,150', onClose, onImported, pushToast }) {
  const [cands, setCands] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);
  const reqRef = useRef(0);

  const runSearch = useCallback(async (customQuery) => {
    const apiEl = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!apiEl?.searchYoutubeCandidates) { setErr('Video search isn’t available in this build.'); setLoading(false); return; }
    const rid = reqRef.current + 1;
    reqRef.current = rid;
    setLoading(true); setErr('');
    try {
      const res = await apiEl.searchYoutubeCandidates({
        artists: meta?.artists || '',
        title: meta?.title || '',
        customQuery: customQuery || '',
        durationMs: meta?.durationMs || 0,
      });
      if (rid !== reqRef.current) return; // a newer search superseded this one
      if (res?.ok && Array.isArray(res.candidates) && res.candidates.length) { setCands(res.candidates); setErr(''); }
      else { setCands([]); setErr(res?.error || 'No videos found — try refining the search.'); }
    } catch (e) {
      if (rid !== reqRef.current) return;
      setCands([]); setErr(String(e?.message || e));
    } finally {
      if (rid === reqRef.current) setLoading(false);
    }
  }, [meta?.artists, meta?.title, meta?.durationMs]);

  // On open (or when the target track changes): seed instantly if we were
  // handed candidates, otherwise kick off a fresh search.
  useEffect(() => {
    if (!open) return;
    setQ(''); setErr(''); setBusyId(null);
    if (Array.isArray(seed) && seed.length) { setCands(seed); setLoading(false); }
    else { setCands([]); runSearch(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meta?.spotifyId, meta?.title]);

  // Esc closes (unless an import is in flight).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !busyId) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busyId, onClose]);

  const pick = useCallback(async (c) => {
    if (busyId) return;
    const apiEl = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!apiEl?.importFromYoutubeId) { pushToast?.({ message: 'Import isn’t available in this build.', kind: 'error', durationMs: 6000 }); return; }
    setBusyId(c.id);
    try {
      const res = await apiEl.importFromYoutubeId({ videoId: c.id, meta });
      if (res?.ok && res.track) {
        onImported?.(res.track);
        pushToast?.({ message: `Added “${res.track.title}” to your library.`, kind: 'success', durationMs: 4000 });
        onClose?.();
      } else {
        pushToast?.({ message: res?.error || 'That video couldn’t be imported.', kind: 'error', durationMs: 6000 });
        setBusyId(null);
      }
    } catch (e) {
      pushToast?.({ message: String(e?.message || e), kind: 'error', durationMs: 6000 });
      setBusyId(null);
    }
  }, [busyId, meta, onImported, onClose, pushToast]);

  if (!open || typeof document === 'undefined') return null;

  const acc = accent || '150,150,150';
  const targetSec = Number(meta?.durationMs) > 0 ? Number(meta.durationMs) / 1000 : 0;
  const mmss = (s) => { const n = Math.round(s || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  const views = (n) => { const v = Number(n) || 0; if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`; if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`; return `${v}`; };

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busyId) onClose?.(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', animation: 'vpFade 0.18s ease both' }}
    >
      <div style={{ width: 'min(680px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', borderRadius: 18, background: 'rgba(19,19,21,0.97)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 30px 90px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '18px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ width: 52, height: 52, borderRadius: 10, flexShrink: 0, background: meta?.albumArtUrl ? `url("${meta.albumArtUrl}") center/cover` : 'rgba(255,255,255,0.08)', boxShadow: '0 0 0 1px rgba(255,255,255,0.1)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: `rgb(${acc})` }}>Pick a video</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta?.title || 'Unknown title'}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {meta?.artists || 'Unknown artist'}{targetSec ? ` · ${mmss(targetSec)}` : ''}
            </div>
          </div>
          <button type="button" onClick={() => { if (!busyId) onClose?.(); }} aria-label="Close" style={{ border: 'none', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: busyId ? 'default' : 'pointer', width: 30, height: 30, borderRadius: 8, flexShrink: 0, fontSize: 14, opacity: busyId ? 0.4 : 1 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(q.trim()); }}
            placeholder={`${meta?.artists || ''} ${meta?.title || ''}`.trim() || 'Search YouTube…'}
            style={{ flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 12.5, outline: 'none' }}
          />
          <button type="button" onClick={() => runSearch(q.trim())} disabled={loading} style={{ padding: '0 16px', borderRadius: 9, border: 'none', cursor: loading ? 'default' : 'pointer', background: `rgb(${acc})`, color: '#0b0b0c', fontSize: 12.5, fontWeight: 700, opacity: loading ? 0.6 : 1 }}>Search</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 14px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '46px 0', color: 'rgba(255,255,255,0.5)', fontSize: 12.5 }}>
              <span className="vp-spin" style={{ display: 'inline-block', width: 15, height: 15, borderRadius: '50%', border: `2px solid rgba(${acc},0.35)`, borderTopColor: `rgb(${acc})` }} />
              Searching YouTube…
            </div>
          ) : err ? (
            <div style={{ padding: '32px 18px', textAlign: 'center' }}>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>{err}</div>
              <button type="button" onClick={() => runSearch(q.trim())} style={{ marginTop: 14, padding: '8px 16px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Try again</button>
            </div>
          ) : cands.length === 0 ? (
            <div style={{ padding: '46px 0', textAlign: 'center', color: 'rgba(255,255,255,0.45)', fontSize: 12.5 }}>No videos found. Refine the search above.</div>
          ) : cands.map((c) => {
            const importing = busyId === c.id;
            const dim = busyId && !importing;
            const dsec = Number(c.duration) || 0;
            const delta = targetSec && dsec ? Math.abs(dsec - targetSec) : null;
            const closeMatch = delta != null && delta <= 3;
            return (
              <button
                key={c.id}
                type="button"
                disabled={!!busyId}
                onClick={() => pick(c)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: 8, borderRadius: 11, border: '1px solid transparent', background: 'transparent', cursor: busyId ? 'default' : 'pointer', opacity: dim ? 0.4 : 1, transition: 'background 0.15s ease' }}
                onMouseEnter={(e) => { if (!busyId) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ position: 'relative', width: 104, height: 58, borderRadius: 8, flexShrink: 0, background: c.thumbnailUrl ? `url("${c.thumbnailUrl}") center/cover` : 'rgba(255,255,255,0.08)', boxShadow: '0 0 0 1px rgba(255,255,255,0.08)' }}>
                  {dsec ? <span style={{ position: 'absolute', right: 4, bottom: 4, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,0.82)', color: '#fff', fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{mmss(dsec)}</span> : null}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#fff', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{c.channel || 'Unknown'}</span>
                    {c.viewCount ? <span style={{ flexShrink: 0 }}>· {views(c.viewCount)} views</span> : null}
                    {closeMatch ? <span style={{ flexShrink: 0, color: `rgb(${acc})`, fontWeight: 600 }}>· duration match</span> : null}
                  </div>
                </div>
                <div style={{ flexShrink: 0, paddingRight: 4, width: 34, textAlign: 'center' }}>
                  {importing
                    ? <span className="vp-spin" style={{ display: 'inline-block', width: 16, height: 16, borderRadius: '50%', border: `2px solid rgba(${acc},0.35)`, borderTopColor: `rgb(${acc})` }} />
                    : <span style={{ fontSize: 11.5, fontWeight: 700, color: `rgb(${acc})` }}>Use</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <style>{'@keyframes vpFade{from{opacity:0}to{opacity:1}}@keyframes vpspin{to{transform:rotate(360deg)}}.vp-spin{animation:vpspin 0.7s linear infinite}'}</style>
    </div>,
    document.body,
  );
}

export { Tooltip, HeartSlider, ExplicitBadge, GhostBtn, MediaSkipBtn, MediaPlayPauseBtn, MediaToggleBtn, ImmerseTooltipLayer, DownloadProgressBar, useDownloadProgress, VideoPicker };

/**
 * The play triangle, with the corners rounded.
 *
 * A <path> polygon has hard points. Stroking the same path with a round
 * linejoin AND filling it grows the shape by half the stroke on every side,
 * which rounds all three corners evenly — this is how the Now Playing bar has
 * always drawn it. Every other play button in the app was drawing the sharp
 * version at whatever size it needed, so the same control looked like several
 * different controls depending where you found it.
 *
 * The optical nudge right is deliberate: a triangle centred by its bounding
 * box reads as sitting left, because its visual mass is toward the flat edge.
 */
export function PlayIcon({ size = 13, nudge = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
      strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"
      style={nudge ? { marginLeft: Math.round(size * 0.12) } : undefined}>
      <path d="M8 6.5v11l9.5-5.5z" />
    </svg>
  );
}

/** The matching pause glyph, so the pair always agree. */
export function PauseIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1.4" />
      <rect x="14" y="4" width="4" height="16" rx="1.4" />
    </svg>
  );
}
