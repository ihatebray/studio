/**
 * Toasts.jsx — Immerse notification system.
 *
 * Exports:
 *   useToastBus()  — creates the toast state (used once in App.jsx)
 *   ToastStack     — renders the floating toast UI
 *   ToastContext    — React context for pushToast
 *   useToast()     — hook for any component to push a toast
 *
 * Usage in any extracted component:
 *   import { useToast } from './Toasts.jsx';
 *   const pushToast = useToast();
 *   pushToast({ message: 'Saved', kind: 'success' });
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

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
        // (revision bump is wired into ToastRow's timer effect).
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

/* ── Visual stack ────────────────────────────────────────────── */

export function ToastStack({ toasts, onDismiss, accent = '128, 128, 128', topOffset = 24 }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: topOffset,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 10,
        pointerEvents: 'none',
        maxWidth: 'min(440px, calc(100vw - 24px))',
        width: '100%',
        alignItems: 'center',
        perspective: '1200px',
      }}
    >
      {toasts && toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} accent={accent} />
      ))}
    </div>
  );
}

/* ── Individual toast row ────────────────────────────────────── */

function ToastRow({ toast, onDismiss, accent }) {
  const [mounted, setMounted] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const exitTimeoutRef = useRef(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleDismiss = useCallback(() => {
    if (isExiting) return;
    setIsExiting(true);
    exitTimeoutRef.current = setTimeout(() => {
      onDismiss(toast.id);
    }, 320);
  }, [isExiting, onDismiss, toast.id]);

  useEffect(() => {
    if (toast.durationMs <= 0) return undefined;
    const id = setTimeout(() => handleDismiss(), toast.durationMs);
    return () => clearTimeout(id);
  }, [toast.id, toast.durationMs, toast.revision, handleDismiss]);

  useEffect(() => {
    return () => {
      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
    };
  }, []);

  const stripColor =
    toast.kind === 'success' ? '#7be191'
    : toast.kind === 'error' ? '#f37272'
    : toast.kind === 'warning' ? '#ffc107'
    : `rgb(${accent})`;

  const handleAction = () => {
    if (!toast.action?.onClick) return;
    try { toast.action.onClick(); } catch (e) { console.error('toast action threw:', e); }
    handleDismiss();
  };

  /* Unified kinetic states — entrance and exit mirror each other. */
  const states = {
    initial: {
      transform: 'translateY(-40px) scale(0.88, 0.5) rotateX(-45deg)',
      opacity: 0,
      filter: 'blur(12px)',
      maxHeight: '100px',
      padding: '10px 14px 10px 16px',
      gap: 12,
    },
    active: {
      transform: 'translateY(0) scale(1) rotateX(0deg)',
      opacity: 1,
      filter: 'blur(0px)',
      maxHeight: '100px',
      padding: '10px 14px 10px 16px',
      gap: 12,
    },
    exit: {
      transform: 'translateY(-40px) scale(0.88, 0.5) rotateX(-45deg)',
      opacity: 0,
      filter: 'blur(12px)',
      maxHeight: '0px',
      padding: '0px 14px',
      gap: 0,
    },
  };

  const currentStyle = isExiting ? states.exit : (mounted ? states.active : states.initial);

  const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const masterTransition = `
    transform 0.32s ${ease},
    opacity 0.28s linear,
    filter 0.28s ease,
    max-height 0.32s ${ease},
    padding 0.32s ${ease},
    gap 0.32s ${ease}
  `;

  const interiorTransform = isExiting
    ? 'translateY(-6px)'
    : (mounted ? 'translateY(0)' : 'translateY(6px)');

  const interiorTransition = `transform 0.3s ${ease}, opacity 0.25s ease`;

  return (
    <div
      style={{
        pointerEvents: isExiting ? 'none' : 'auto',
        display: 'flex',
        alignItems: 'center',
        borderRadius: 14,
        background: 'rgba(18, 18, 20, 0.62)',
        backdropFilter: 'blur(30px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
        border: isExiting ? '1px solid rgba(255,255,255,0)' : '1px solid rgba(255,255,255,0.1)',
        boxShadow: isExiting
          ? '0 0px 0px rgba(0,0,0,0)'
          : '0 24px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
        color: 'rgba(255,255,255,0.95)',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.4,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        transformOrigin: 'top center',
        transition: masterTransition,
        ...currentStyle,
      }}
    >
      {/* Kind indicator strip */}
      <div style={{
        width: 3, alignSelf: 'stretch', borderRadius: 999,
        background: stripColor, flexShrink: 0, marginTop: 1, marginBottom: 1,
        opacity: mounted && !isExiting ? 1 : 0,
        transform: mounted && !isExiting ? 'scaleY(1)' : 'scaleY(0.1)',
        transition: `transform 0.3s ${ease}, opacity 0.2s ease`,
      }} />

      {/* Message */}
      <div style={{
        flex: 1,
        minWidth: 0,
        opacity: mounted && !isExiting ? 1 : 0,
        transform: interiorTransform,
        transition: interiorTransition,
      }}>
        {toast.message}
      </div>

      {/* Action button */}
      {toast.action ? (
        <button
          type="button"
          onClick={handleAction}
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(255,255,255,0.04)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            opacity: mounted && !isExiting ? 1 : 0,
            transform: interiorTransform,
            transition: `${interiorTransition}, background 0.12s, border-color 0.12s`,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'; }}
        >
          {toast.action.label}
        </button>
      ) : null}

      {/* Dismiss × */}
      <button
        type="button"
        onClick={handleDismiss}
        title="Dismiss"
        style={{
          padding: 0,
          width: 22, height: 22,
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          opacity: mounted && !isExiting ? 1 : 0,
          transform: interiorTransform,
          transition: interiorTransition,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>
  );
}
