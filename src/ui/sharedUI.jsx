import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { hiResCover } from '../lib/coverUrl.js';




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
        const above = r.bottom > window.innerHeight * 0.7;
        setTip({ text, x: r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above, below: r.bottom + 6 });
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

  /* Kept wholly on screen. The anchor is centred over the element, but the
     tip can be up to 280px wide, so near an edge it's measured and slid
     back in (8px margin); one with no room above drops below instead. */
  const boxRef = useRef(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !tip) return;
    el.style.transform = 'none';
    const w = el.offsetWidth; const h = el.offsetHeight;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const left = Math.min(Math.max(tip.x - w / 2, 8), vw - w - 8);
    let top = tip.above ? tip.y - h : tip.y;
    if (top < 8) top = tip.below;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={boxRef} role="tooltip" style={{
      visibility: 'hidden',
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

export { ExplicitBadge, ImmerseTooltipLayer, useDownloadProgress, VideoPicker };

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

/** A cover <img> at the largest size its CDN offers, falling back to the
 *  given URL if that size doesn't load (see lib/coverUrl.js). */
export function HiResImg({ src, alt = '', ...rest }) {
  const big = hiResCover(src);
  const [failed, setFailed] = React.useState(null);
  const use = failed === src || big === src ? src : big;
  return <img src={use} alt={alt} decoding="async" draggable={false} onError={() => { if (use !== src) setFailed(src); }} {...rest} />;
}
