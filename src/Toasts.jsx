/**
 * Toasts.jsx — Immerse notification system.
 *
 * Exports:
 *   useToastBus()  — creates the toast state (used once in App.jsx)
 *   ToastStack     — renders the docked toast UI
 *   ToastContext    — React context for pushToast
 *   useToast()     — hook for any component to push a toast
 *
 * Usage in any extracted component:
 *   import { useToast } from './Toasts.jsx';
 *   const pushToast = useToast();
 *   pushToast({ message: 'Saved', kind: 'success' });
 */

import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE_TOASTS = 4;

/* ── Context ────────────────────────────────────────────────── */

export const ToastContext = createContext(() => {});

/** Hook for any component to push a toast. */
export function useToast() {
  return useContext(ToastContext);
}

/* ── Bus (state owner — called once in App.jsx) ─────────────── */

export function useToastBus() {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const pushToast = useCallback((opts) => {
    if (!opts || !opts.message) return null;
    const kind = opts.kind || 'info';
    const message = String(opts.message);
    // Collapse spam and let callers evolve one toast over time (e.g. a
    // download going "Downloading…" → "Added"): an explicit dedupeKey groups
    // updates; otherwise identical kind+message collapse onto each other.
    const dedupeKey = opts.dedupeKey || `${kind}:${message}`;
    const durationMs = typeof opts.durationMs === 'number' ? opts.durationMs : DEFAULT_DURATION_MS;
    const action = opts.action || null;

    let resultId = null;
    setToasts((prev) => {
      const idx = prev.findIndex((t) => t.dedupeKey === dedupeKey);
      if (idx !== -1) {
        // Update the existing toast in place and reset its auto-dismiss timer
        // (the revision keys ToastRow's countdown).
        const existing = prev[idx];
        resultId = existing.id;
        const updated = {
          ...existing,
          message, kind, action, durationMs,
          revision: (existing.revision || 0) + 1,
          createdAt: Date.now(),
        };
        const next = prev.slice();
        // Move the refreshed toast to the end so it reads as "most recent".
        next.splice(idx, 1);
        next.push(updated);
        return next;
      }
      counterRef.current += 1;
      resultId = `toast_${Date.now()}_${counterRef.current}`;
      const toast = {
        id: resultId,
        dedupeKey,
        message, kind, action, durationMs,
        revision: 0,
        createdAt: Date.now(),
      };
      const next = [...prev, toast];
      if (next.length > MAX_VISIBLE_TOASTS) {
        return next.slice(next.length - MAX_VISIBLE_TOASTS);
      }
      return next;
    });
    return resultId;
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}

/* ── Visual stack ────────────────────────────────────────────────
 *
 * Docked bottom right, a gap above the Now Playing bar (StudioHome sets
 * --st-toast-bottom / --st-toast-right on :root). Toasts used to drop in at
 * the top centre, which is where every page keeps its title, tabs and search,
 * so each one covered something you were reading.
 *
 * It's a deck, not a column: the newest card sits in front and older ones
 * tuck behind it as thin edges, so four notifications take the room of one.
 * Hovering fans them out and holds every countdown; a card can be swiped
 * sideways to dismiss it.
 */

const GAP = 8;           // between cards when fanned out
const PEEK = 7;          // how much of each card behind shows when stacked
const DEPTH = 3;         // cards visible behind the front one
const EXIT_MS = 240;

const KIND_RGB = {
  success: '123, 225, 145',
  error: '243, 114, 114',
  warning: '245, 190, 80',
};

const CSS = `
.st-toasts { position: fixed; z-index: 60; right: var(--st-toast-right, 16px); bottom: var(--st-toast-bottom, 16px);
  width: min(348px, calc(100vw - 2 * var(--st-toast-right, 16px)));
  transition: height 0.34s cubic-bezier(0.22, 1, 0.36, 1), bottom 0.34s cubic-bezier(0.22, 1, 0.36, 1); }
.st-toast { position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box;
  border-radius: 14px; overflow: hidden; touch-action: pan-y;
  background: rgba(22, 22, 24, 0.97); border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  color: rgba(255, 255, 255, 0.94);
  transform-origin: 50% 100%; will-change: transform, opacity;
  transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, height 0.34s cubic-bezier(0.22, 1, 0.36, 1); }
.st-toast.is-dragging { transition: none; }
.st-toast-in { display: flex; align-items: flex-start; gap: 11px; padding: 11px 10px 12px 12px;
  transition: opacity 0.22s ease; }
.st-toast-icon { width: 22px; height: 22px; flex: 0 0 22px; border-radius: 999px; margin-top: -1px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(var(--tk), 0.16); color: rgb(var(--tk)); }
.st-toast-msg { flex: 1; min-width: 0; padding-top: 2px; font-size: 12.5px; font-weight: 500; line-height: 1.42;
  overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.st-toast-act { flex: 0 0 auto; align-self: center; padding: 5px 10px; border-radius: 8px; cursor: pointer;
  border: none; font: inherit; font-size: 11.5px; font-weight: 700; white-space: nowrap;
  background: rgba(var(--tk), 0.16); color: rgb(var(--tk)); transition: background 0.14s; }
.st-toast-act:hover { background: rgba(var(--tk), 0.26); }
.st-toast-x { flex: 0 0 22px; width: 22px; height: 22px; margin: -1px -2px 0 0; padding: 0; border: none; border-radius: 7px;
  background: transparent; color: rgba(255, 255, 255, 0.42); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: color 0.14s, background 0.14s; }
.st-toast-x:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.st-toast-life { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; transform-origin: 0 50%;
  background: rgba(var(--tk), 0.55); animation-name: stToastLife; animation-timing-function: linear; animation-fill-mode: forwards; }
@keyframes stToastLife { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
  .st-toasts, .st-toast, .st-toast-in { transition-duration: 0.01s !important; }
}
`;

export function ToastStack({ toasts, onDismiss }) {
  const [hovered, setHovered] = useState(false);
  const [heights, setHeights] = useState({});
  const list = toasts || [];

  const setHeight = useCallback((id, h) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  // Newest first: index 0 is the card in front.
  const ordered = list.slice().reverse();
  const frontH = heights[ordered[0]?.id] || 0;
  const expanded = hovered && ordered.length > 1;
  let offset = 0;
  const offsets = ordered.map((t) => {
    const at = offset;
    offset += (heights[t.id] || 0) + GAP;
    return at;
  });
  const height = !ordered.length ? 0
    : expanded ? Math.max(0, offset - GAP)
    : frontH + PEEK * Math.min(DEPTH, ordered.length - 1);

  // Nothing to hold the pointer over any more: forget the hover.
  if (!ordered.length && hovered) setHovered(false);

  return (
    <>
      <style>{CSS}</style>
      <div
        className="st-toasts"
        role="region"
        aria-label="Notifications"
        style={{ height, pointerEvents: ordered.length ? 'auto' : 'none' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {ordered.map((t, i) => (
          <ToastRow
            key={t.id}
            toast={t}
            index={i}
            expanded={expanded}
            offset={offsets[i]}
            frontHeight={frontH}
            paused={hovered}
            onHeight={setHeight}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </>
  );
}

/* ── Individual toast ─────────────────────────────────────────── */

function KindIcon({ kind }) {
  const common = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (kind === 'success') return <svg {...common}><polyline points="5 12.5 10 17.5 19 7" /></svg>;
  if (kind === 'error') return <svg {...common}><line x1="7" y1="7" x2="17" y2="17" /><line x1="17" y1="7" x2="7" y2="17" /></svg>;
  if (kind === 'warning') return <svg {...common}><line x1="12" y1="6" x2="12" y2="13" /><line x1="12" y1="18" x2="12" y2="18.01" /></svg>;
  return <svg {...common}><line x1="12" y1="11" x2="12" y2="18" /><line x1="12" y1="6.5" x2="12" y2="6.51" /></svg>;
}

function ToastRow({ toast, index, expanded, offset, frontHeight, paused, onHeight, onDismiss }) {
  const [mounted, setMounted] = useState(false);
  const [exiting, setExiting] = useState(null);   // null | exit direction (-1 / 1)
  const [drag, setDrag] = useState(0);
  const innerRef = useRef(null);
  const dragRef = useRef(null);
  const exitTimer = useRef(null);

  // Measure the card's natural height (the inner block isn't squeezed when
  // the card is stacked) so the deck can fan out to the right places.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const report = () => onHeight(toast.id, Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [toast.id, onHeight]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(exitTimer.current);
    };
  }, []);

  const dismiss = useCallback((dir = 1) => {
    if (exiting) return;
    setExiting(dir);
    exitTimer.current = setTimeout(() => onDismiss(toast.id), EXIT_MS);
  }, [exiting, onDismiss, toast.id]);

  const handleAction = () => {
    if (!toast.action?.onClick) return;
    try { toast.action.onClick(); } catch (e) { console.error('toast action threw:', e); }
    dismiss();
  };

  /* Swipe sideways to dismiss. */
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    dragRef.current = { x: e.clientX, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
    setDrag(e.clientX - dragRef.current.x);
  };
  const endDrag = (e) => {
    if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
    dragRef.current = null;
    if (Math.abs(drag) > 70) dismiss(Math.sign(drag));
    setDrag(0);
  };

  const natural = frontHeight || undefined;
  const behind = index > 0 && !expanded;
  const hidden = index > DEPTH;

  let transform;
  let opacity = 1;
  if (!mounted) {
    transform = 'translateY(18px) scale(0.96)';
    opacity = 0;
  } else if (exiting) {
    transform = `translate(${exiting * 110}%, ${expanded ? -offset : 0}px)`;
    opacity = 0;
  } else if (expanded) {
    transform = `translate(${drag}px, ${-offset}px)`;
  } else {
    // Scaled from the bottom edge, so lift by what the scale took off the
    // top as well: each card behind shows exactly PEEK more than the last.
    const s = 1 - index * 0.045;
    const lift = index * PEEK + (frontHeight || 0) * (1 - s);
    transform = `translate(${drag}px, ${-lift}px) scale(${s})`;
    if (hidden) opacity = 0;
  }
  if (drag && !exiting) opacity = Math.max(0.2, 1 - Math.abs(drag) / 220);

  const rgb = KIND_RGB[toast.kind] || 'var(--st-acc-rgb, 190, 190, 196)';
  const life = toast.durationMs > 0;

  return (
    <div
      className={`st-toast${drag ? ' is-dragging' : ''}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      style={{
        '--tk': rgb,
        zIndex: 100 - index,
        transform,
        opacity,
        // Stacked cards take the front card's height so only their edge shows.
        height: behind && natural ? natural : undefined,
        pointerEvents: exiting || hidden ? 'none' : 'auto',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div ref={innerRef} className="st-toast-in" style={{ opacity: behind ? 0 : 1 }}>
        <span className="st-toast-icon"><KindIcon kind={toast.kind} /></span>
        <div className="st-toast-msg">{toast.message}</div>
        {toast.action ? (
          <button type="button" className="st-toast-act" onClick={handleAction}>{toast.action.label}</button>
        ) : null}
        <button type="button" className="st-toast-x" onClick={() => dismiss()} title="Dismiss" aria-label="Dismiss">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      {/* The countdown is this bar's animation: it pauses with the hover and
          restarts when the toast is updated (new key). */}
      {life ? (
        <div
          key={toast.revision}
          className="st-toast-life"
          style={{
            animationDuration: `${toast.durationMs}ms`,
            animationPlayState: paused || drag ? 'paused' : 'running',
            opacity: behind ? 0 : 1,
          }}
          onAnimationEnd={() => dismiss()}
        />
      ) : null}
    </div>
  );
}
