import React, { useCallback, useEffect, useRef, useState } from 'react';

/* =========================================================================
 *  ImportDropZone — drop audio files or folders anywhere on the window.
 *
 *  Listening on `window` rather than a specific element is deliberate: the
 *  app has three top-level states (onboarding, home, fullscreen overlay) and
 *  dropping an album should work in all of them without each one wiring its
 *  own handler.
 *
 *  Two things here are load-bearing and easy to break:
 *
 *  1. preventDefault() on BOTH dragover and drop, unconditionally. Without
 *     it Chromium's default action navigates the window to the dropped file
 *     — in Electron that replaces your entire app with a bare audio player
 *     and the only way back is a restart.
 *
 *  2. The enter/leave DEPTH COUNTER. dragenter/dragleave fire for every
 *     descendant the cursor crosses, so tracking a simple boolean makes the
 *     overlay strobe as you move across the UI. Counting nested enters and
 *     only clearing at zero keeps it steady.
 * ========================================================================= */

/** Real files, not a text/HTML drag from within the app. */
function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

/**
 * Pull filesystem paths off a drop.
 *
 * Electron 28 still populates the non-standard `File.path`. Newer Electron
 * (32+) removed it in favour of `webUtils.getPathForFile`, so we check for a
 * preload-exposed version first and fall back — that way this keeps working
 * through an Electron upgrade instead of silently dropping every file.
 */
function pathsFromDrop(e) {
  const files = Array.from(e.dataTransfer?.files || []);
  const getPath = window.electronAPI?.getPathForFile;
  return files
    .map((f) => {
      if (typeof getPath === 'function') {
        try { return getPath(f) || f.path; } catch { return f.path; }
      }
      return f.path;
    })
    .filter((p) => typeof p === 'string' && p.length > 0);
}

/**
 * @param {(paths: string[]) => void} onPaths  receives absolute paths; may be
 *        files or directories, so resolve them in main before importing.
 * @returns {boolean} whether a file drag is currently over the window.
 */
export function useFileDrop({ onPaths, enabled = true } = {}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onPaths);
  cb.current = onPaths;

  useEffect(() => {
    if (!enabled) return undefined;

    const onEnter = (e) => {
      e.preventDefault();
      if (!isFileDrag(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (e) => {
      // Unconditional: this is the one that stops Chromium navigating.
      e.preventDefault();
      if (isFileDrag(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e) => {
      e.preventDefault();
      if (!isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!isFileDrag(e)) return;
      const paths = pathsFromDrop(e);
      if (paths.length) cb.current?.(paths);
    };
    // A drag that ends outside the window never fires drop, and on some
    // platforms not even dragleave — without this the overlay can stick.
    const onEnd = () => { depth.current = 0; setDragging(false); };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('blur', onEnd);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('blur', onEnd);
    };
  }, [enabled]);

  return dragging;
}

/** Full-window drop indicator. Renders nothing unless a drag is in flight. */
export function DropOverlay({ active, accent = '150, 150, 150', importing = false }) {
  if (!active && !importing) return null;
  const a = readable(accent);
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        background: 'rgba(4, 4, 6, 0.72)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        animation: 'studioDropIn 0.16s ease-out',
      }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        padding: '38px 52px', borderRadius: 20,
        border: `2px dashed rgba(${a}, ${importing ? 0.3 : 0.55})`,
        background: `rgba(${a}, 0.07)`,
      }}>
        {importing ? (
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            border: '3px solid rgba(255,255,255,0.14)',
            borderTopColor: `rgb(${a})`,
            animation: 'studioDropSpin 0.8s linear infinite',
          }} />
        ) : (
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={`rgb(${a})`} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em' }}>
            {importing ? 'Importing…' : 'Drop to import'}
          </div>
          <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 5 }}>
            {importing ? 'Reading tags and artwork' : 'Audio files or whole folders'}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes studioDropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes studioDropSpin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function readable(accent, minLum = 168) {
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

export default useFileDrop;
