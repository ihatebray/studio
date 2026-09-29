/**
 * Toasts.jsx — Immerse notification system.
 *
 * Exports:
 *   useToastBus()  — creates the toast state (used once in App.jsx)
 *   ToastStack     — renders the docked toast UI
 *   ToastPositionPicker, setToastLayout — where it docks (Settings / StudioHome)
 *   ToastContext    — React context for pushToast
 *   useToast()     — hook for any component to push a toast
 *
 * Usage in any extracted component:
 *   import { useToast } from './Toasts.jsx';
 *   const pushToast = useToast();
 *   pushToast({ message: 'Saved', kind: 'success' });
 */

import React, {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
} from 'react';

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE_TOASTS = 4;

/* ── Context ────────────────────────────────────────────────── */

export const ToastContext = createContext(() => {});

/** Hook for any component to push a toast. */
export function useToast() {
  return useContext(ToastContext);
}

/* ── Notification history ───────────────────────────────────────
 *
 * Toasts go away; this doesn't. Every warning and error (and anything that
 * comes with an explanation) is kept here with its time, for the bell in the
 * top bar (Notifications.jsx). The same notice again within a few minutes
 * bumps the existing entry's time and count rather than adding a row.
 */

const LOG_KEY = 'studio:notifications';
const LOG_MAX = 100;
const LOG_MERGE_MS = 5 * 60 * 1000;

function readLog() {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
    if (v && Array.isArray(v.items)) return { items: v.items.slice(0, LOG_MAX), seenAt: Number(v.seenAt) || 0 };
  } catch { /* ignore */ }
  return { items: [], seenAt: 0 };
}
let log = readLog();
const logSubs = new Set();
function setLog(next) {
  log = next;
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* ignore */ }
  logSubs.forEach((fn) => fn());
}

/** Keep a notice in the history. `title` is what the toast said. */
export function recordNotice({ key, kind = 'info', title, detail = '', source = '', at = Date.now() }) {
  if (!title) return;
  const k = key || `${kind}:${title}`;
  const i = log.items.findIndex((n) => n.key === k && at - n.at < LOG_MERGE_MS);
  let items;
  if (i >= 0) {
    const prev = log.items[i];
    const bumped = { ...prev, title, detail: detail || prev.detail, kind, at, count: (prev.count || 1) + 1 };
    items = [bumped, ...log.items.slice(0, i), ...log.items.slice(i + 1)];
  } else {
    items = [{ id: `${at}-${Math.random().toString(36).slice(2, 7)}`, key: k, kind, title, detail, source, at, count: 1 }, ...log.items];
  }
  setLog({ ...log, items: items.slice(0, LOG_MAX) });
}

export function markNoticesSeen() { if (log.items[0]?.at > log.seenAt) setLog({ ...log, seenAt: Date.now() }); }
export function clearNotices() { setLog({ items: [], seenAt: Date.now() }); }
export function removeNotice(id) { setLog({ ...log, items: log.items.filter((n) => n.id !== id) }); }

/** { items, seenAt, unread } — newest first. */
export function useNotices() {
  const snap = useSyncExternalStore((fn) => { logSubs.add(fn); return () => logSubs.delete(fn); }, () => log);
  return { ...snap, unread: snap.items.filter((n) => n.at > snap.seenAt).length };
}

/** Ask the top bar to open the notifications panel (a toast was clicked). */
export const OPEN_NOTICES_EVENT = 'studio:open-notices';
export function openNotices() {
  try { window.dispatchEvent(new Event(OPEN_NOTICES_EVENT)); } catch { /* ignore */ }
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
    // The why, for the notifications panel; the toast itself stays short.
    const detail = opts.detail ? String(opts.detail) : '';
    if (opts.log !== false && (kind === 'error' || kind === 'warning' || detail || opts.log)) {
      recordNotice({ key: opts.dedupeKey, kind, title: message, detail, source: opts.source || '' });
    }

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
          message, kind, action, durationMs, detail,
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
        message, kind, action, durationMs, detail,
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

/* ── Placement ──────────────────────────────────────────────────
 *
 * Where the deck sits is a setting (Settings → Layout → Notifications). The
 * geometry comes from StudioHome, which knows the shell: how wide the sidebar
 * is, whether the Now Playing bar is up, compact mode's tighter gutters. It
 * reports that through setToastLayout(), and the stack (mounted in App,
 * outside StudioHome) reads both through this little store.
 */

const POS_KEY = 'studio:toastPosition';

export const TOAST_POSITIONS = [
  { id: 'lane', name: 'Own lane', note: 'The page makes room above the player; covers nothing' },
  { id: 'player', name: 'In the player bar', note: 'Over the song info for a moment' },
  { id: 'right', name: 'Bottom right', note: 'Above the player, right corner' },
  { id: 'left', name: 'Bottom left', note: 'Over the foot of the sidebar' },
  { id: 'top-right', name: 'Top right', note: 'Top corner of the page' },
  { id: 'top-center', name: 'Top centre', note: 'Top middle of the page' },
];

const DEFAULT_LAYOUT = {
  gutter: 16, gap: 12, reserve: 16, barLeft: 236, sidebarW: 236, shellTop: 62, barShown: false, barH: 86,
};

function readPosition() {
  try {
    const v = localStorage.getItem(POS_KEY);
    if (TOAST_POSITIONS.some((p) => p.id === v)) return v;
  } catch { /* ignore */ }
  return 'lane';
}

let store = { position: readPosition(), layout: DEFAULT_LAYOUT };
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());
const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const snapshot = () => store;

export function setToastPosition(id) {
  if (!TOAST_POSITIONS.some((p) => p.id === id) || store.position === id) return;
  store = { ...store, position: id };
  try { localStorage.setItem(POS_KEY, id); } catch { /* ignore */ }
  emit();
}

/** StudioHome reports the shell's geometry here (see DEFAULT_LAYOUT). */
export function setToastLayout(next) {
  const cur = store.layout;
  if (Object.keys(next).every((k) => cur[k] === next[k])) return;
  store = { ...store, layout: { ...cur, ...next } };
  emit();
}

export function useToastPlacement() {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Where the deck goes, as a fixed region plus which edge it grows from. */
function regionFor(position, L, deckH) {
  const bottomRow = { bottom: L.reserve, left: L.barLeft, right: L.gutter };
  switch (position) {
    case 'player':
      if (L.barShown) {
        // Centred on the bar's height, over its left column (art + title).
        return {
          style: { bottom: L.gutter + Math.max(0, (L.barH - deckH) / 2), left: L.barLeft + 12, width: 300 },
          justify: 'flex-start', anchor: 'bottom', inBar: true,
        };
      }
      return { style: bottomRow, justify: 'flex-end', anchor: 'bottom' };
    case 'lane':
      return { style: bottomRow, justify: 'center', anchor: 'bottom', lane: true };
    case 'left':
      return {
        style: { bottom: L.reserve, left: L.gutter, width: L.sidebarW ? L.sidebarW - L.gutter - L.gap : 348 },
        justify: 'flex-start', anchor: 'bottom',
      };
    case 'top-right':
      return { style: { top: L.shellTop + 12, left: L.barLeft, right: L.gutter + 12 }, justify: 'flex-end', anchor: 'top' };
    case 'top-center':
      return { style: { top: L.shellTop + 12, left: L.barLeft, right: L.gutter }, justify: 'center', anchor: 'top' };
    default:
      return { style: bottomRow, justify: 'flex-end', anchor: 'bottom' };
  }
}

/* ── Visual stack ────────────────────────────────────────────────
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
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

const KIND_RGB = {
  success: '123, 225, 145',
  error: '243, 114, 114',
  warning: '245, 190, 80',
};

/* Above InstantSearch (scrim 90, panel 91), whose blur used to smear them. */
const CSS = `
@property --st-toast-lane { syntax: '<length>'; inherits: true; initial-value: 0px; }
:root { transition: --st-toast-lane 0.36s ${EASE}; }
.st-toasts { position: fixed; z-index: 95; display: flex; pointer-events: none;
  transition: left 0.36s ${EASE}, right 0.36s ${EASE}, top 0.36s ${EASE}, bottom 0.36s ${EASE}, width 0.36s ${EASE}; }
.st-toast-deck { position: relative; width: min(348px, 100%); pointer-events: auto;
  transition: height 0.34s ${EASE}; }
.st-toast { position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box;
  border-radius: 14px; overflow: hidden; touch-action: pan-y;
  background: rgba(22, 22, 24, 0.97); border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  color: rgba(255, 255, 255, 0.94);
  transform-origin: 50% 100%; will-change: transform, opacity;
  transition: transform 0.42s ${EASE}, opacity 0.3s ease, height 0.34s ${EASE}; }
.st-toasts.is-top .st-toast { top: 0; bottom: auto; transform-origin: 50% 0; }
.st-toasts.is-inbar .st-toast { background: rgba(10, 10, 12, 0.72); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.st-toasts.is-inbar .st-toast-msg { -webkit-line-clamp: 2; }
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
  :root { transition: none; }
  .st-toasts, .st-toast-deck, .st-toast, .st-toast-in { transition-duration: 0.01s !important; }
}
`;

export function ToastStack({ toasts, onDismiss }) {
  const [hovered, setHovered] = useState(false);
  const [heights, setHeights] = useState({});
  const { position, layout } = useToastPlacement();
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
  const collapsedH = !ordered.length ? 0 : frontH + PEEK * Math.min(DEPTH, ordered.length - 1);
  const height = expanded ? Math.max(0, offset - GAP) : collapsedH;
  const region = regionFor(position, layout, collapsedH);

  // Nothing to hold the pointer over any more: forget the hover.
  if (!ordered.length && hovered) setHovered(false);

  /* Own lane: the shell adds this to --np-reserve, so the page's card rises
     to make room and eases back once the last notification goes. In the
     player bar: the song info steps aside while a card sits over it. */
  const lane = region.lane && ordered.length && frontH ? collapsedH + layout.gap : 0;
  const inBar = !!(region.inBar && ordered.length);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--st-toast-lane', `${lane}px`);
  }, [lane]);
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-st-toast-in-bar', inBar);
  }, [inBar]);

  const top = region.anchor === 'top';
  return (
    <>
      <style>{CSS}</style>
      <div
        className={`st-toasts${top ? ' is-top' : ''}${region.inBar ? ' is-inbar' : ''}`}
        role="region"
        aria-label="Notifications"
        style={{ ...region.style, justifyContent: region.justify, alignItems: top ? 'flex-start' : 'flex-end' }}
      >
        <div
          className="st-toast-deck"
          style={{ height, pointerEvents: ordered.length ? 'auto' : 'none' }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {ordered.map((t, i) => (
            <ToastRow
              key={t.id}
              toast={t}
              index={i}
              dir={top ? 1 : -1}
              expanded={expanded}
              offset={offsets[i]}
              frontHeight={frontH}
              paused={hovered}
              onHeight={setHeight}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/* ── Settings control ─────────────────────────────────────────── */

/** A thumbnail of the window with the notification's spot lit. */
const SPOT = {
  lane: [26, 25.5, 20, 4],
  player: [18, 32.5, 15, 4],
  right: [40, 23.5, 17, 4],
  left: [2.5, 23.5, 11, 4],
  'top-right': [40, 7.5, 17, 4],
  'top-center': [28, 7.5, 18, 4],
};
function PlacementMap({ id }) {
  const [x, y, w, h] = SPOT[id] || SPOT.right;
  return (
    <svg width="48" height="32" viewBox="0 0 60 40" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="0.5" y="0.5" width="59" height="39" rx="4" fill="rgba(var(--st-fg-rgb, 255,255,255), 0.05)" stroke="rgba(var(--st-fg-rgb, 255,255,255), 0.16)" />
      <rect x="2.5" y="6" width="11" height={id === 'lane' ? 18 : 23} rx="1.5" fill="rgba(var(--st-fg-rgb, 255,255,255), 0.1)" />
      <rect x="16" y="6" width="41.5" height={id === 'lane' ? 18 : 23} rx="2" fill="rgba(var(--st-fg-rgb, 255,255,255), 0.14)" />
      <rect x="16" y="31" width="41.5" height="6.5" rx="2" fill="rgba(var(--st-fg-rgb, 255,255,255), 0.22)" />
      <rect x={x} y={y} width={w} height={h} rx="1.6" fill="rgb(var(--st-acc-rgb, 200,200,200))" />
    </svg>
  );
}

export function ToastPositionPicker() {
  const { position } = useToastPlacement();
  const pushToast = useToast();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const current = TOAST_POSITIONS.find((p) => p.id === position) || TOAST_POSITIONS[0];

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (id) => {
    setToastPosition(id);
    setOpen(false);
    // Show one there, so the choice is seen rather than imagined.
    pushToast?.({ message: 'Notifications will show here.', kind: 'info', durationMs: 3500, dedupeKey: 'toast-position-preview' });
  };

  return (
    <div ref={wrap} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Notification position: ${current.name}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 12px 0 6px', minWidth: 210,
          borderRadius: 8, border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 600,
          background: 'rgba(var(--st-fg-rgb), 0.08)', color: 'var(--st-text)',
        }}>
        <PlacementMap id={current.id} />
        <span style={{ flex: 1, textAlign: 'left' }}>{current.name}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? (
        <div role="listbox" aria-label="Notification position" className="sth-libsortmenu" style={{ left: 0, right: 'auto', minWidth: 300 }}>
          {TOAST_POSITIONS.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === position}
              className={`sth-libsortitem${p.id === position ? ' is-on' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: 11 }}
              onClick={() => pick(p.id)}>
              <PlacementMap id={p.id} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block' }}>{p.name}</span>
                <span style={{ display: 'block', fontSize: 11.5, fontWeight: 500, color: 'rgba(var(--st-fg-rgb), 0.45)', marginTop: 1 }}>{p.note}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
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

function ToastRow({ toast, index, dir, expanded, offset, frontHeight, paused, onHeight, onDismiss }) {
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

  // dir: -1 grows upward from a bottom edge, 1 downward from a top one.
  let transform;
  let opacity = 1;
  if (!mounted) {
    transform = `translateY(${-dir * 18}px) scale(0.96)`;
    opacity = 0;
  } else if (exiting) {
    transform = `translate(${exiting * 110}%, ${expanded ? dir * offset : 0}px)`;
    opacity = 0;
  } else if (expanded) {
    transform = `translate(${drag}px, ${dir * offset}px)`;
  } else {
    // Scaled from the anchored edge, so shift by what the scale took off the
    // far edge as well: each card behind shows exactly PEEK more than the last.
    const s = 1 - index * 0.045;
    const lift = index * PEEK + (frontHeight || 0) * (1 - s);
    transform = `translate(${drag}px, ${dir * lift}px) scale(${s})`;
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
        ) : toast.detail ? (
          /* The full explanation lives in the notifications panel. */
          <button type="button" className="st-toast-act" onClick={() => { openNotices(); dismiss(); }}>Why?</button>
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
