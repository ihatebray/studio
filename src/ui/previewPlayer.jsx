/* =========================================================================
 *  studio — track previews
 *
 *  One audio element for the whole app, so starting a preview anywhere
 *  (search results, an album tracklist, an artist's Popular list) stops the
 *  one before it. The audio is the YouTube match a Get would download
 *  (main.js → preview:resolve), streamed, never saved — you hear what you'd
 *  get.
 *
 *  A preview is 30 seconds from a third of the way in, past most intros.
 *  StudioHome registers hooks so the main player pauses while a preview
 *  runs and picks back up after; starting real playback stops the preview.
 * ========================================================================= */

import React, { useEffect, useState } from 'react';

const PREVIEW_S = 30;

const state = { key: null, status: 'idle', pct: 0, error: '' }; // status: idle | loading | playing | error
const listeners = new Set();
let audio = null;
let stopTimer = null;
let token = 0;
let hooks = { onStart: null, onEnd: null };

function emit(patch) {
  Object.assign(state, patch);
  const snap = { ...state };
  listeners.forEach((fn) => fn(snap));
}

function el() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('timeupdate', () => {
    if (state.status !== 'playing' || !audio.__start) return;
    const pct = Math.min(1, Math.max(0, (audio.currentTime - audio.__start) / audio.__len));
    emit({ pct });
  });
  audio.addEventListener('ended', () => stop());
  audio.addEventListener('error', () => {
    if (state.status === 'loading' || state.status === 'playing') {
      emit({ status: 'error', error: 'This preview couldn’t play.' });
      finish();
    }
  });
  return audio;
}

function finish() {
  clearTimeout(stopTimer);
  stopTimer = null;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  hooks.onEnd?.();
}

/** Stop whatever is previewing. */
export function stop() {
  token += 1;
  const was = state.status === 'loading' || state.status === 'playing';
  emit({ key: null, status: 'idle', pct: 0, error: '' });
  if (was) finish();
}

/**
 * Preview a track, or stop it if it's the one already previewing.
 * @param key    anything unique to the row (a Spotify ID works)
 * @param track  { title, artists, durationMs, explicit }
 */
export async function toggle(key, track) {
  if (state.key === key && (state.status === 'loading' || state.status === 'playing')) { stop(); return; }
  const had = state.status === 'loading' || state.status === 'playing';
  token += 1;
  const mine = token;
  clearTimeout(stopTimer);
  if (audio) audio.pause();
  if (!had) hooks.onStart?.();
  emit({ key, status: 'loading', pct: 0, error: '' });

  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api?.previewResolve) { emit({ status: 'error', error: 'Previews need the latest main.js / preload.js.' }); finish(); return; }
  const r = await api.previewResolve(track).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (mine !== token) return; // superseded while resolving
  if (!r?.ok || !r.url) {
    emit({ status: 'error', error: r?.error || 'No preview available.' });
    finish();
    return;
  }

  const a = el();
  a.src = r.url;
  a.volume = 0.85;
  const onMeta = () => {
    a.removeEventListener('loadedmetadata', onMeta);
    if (mine !== token) return;
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (Number(track.durationMs) || 0) / 1000;
    const start = dur > PREVIEW_S * 1.5 ? Math.min(dur / 3, dur - PREVIEW_S) : 0;
    const len = Math.min(PREVIEW_S, Math.max(1, dur - start));
    a.__start = start;
    a.__len = len;
    try { a.currentTime = start; } catch { /* seek before data — plays from 0 */ }
    a.play().then(() => {
      if (mine !== token) return;
      emit({ status: 'playing' });
      stopTimer = setTimeout(() => { if (mine === token) stop(); }, len * 1000 + 250);
    }).catch(() => {
      if (mine !== token) return;
      emit({ status: 'error', error: 'This preview couldn’t play.' });
      finish();
    });
  };
  a.addEventListener('loadedmetadata', onMeta);
  a.load();
}

/** StudioHome wires the main player in here. */
export function setPreviewHooks(next) { hooks = { ...hooks, ...next }; }

export function isPreviewing() { return state.status === 'loading' || state.status === 'playing'; }

function usePreview() {
  const [snap, setSnap] = useState({ ...state });
  useEffect(() => {
    listeners.add(setSnap);
    return () => { listeners.delete(setSnap); };
  }, []);
  return snap;
}

/**
 * The button. A play glyph at rest; a spinner while the match resolves; a
 * stop square inside a ring that fills over the 30 seconds while playing.
 * Clicks never reach the row underneath (which would start a download).
 */
export function PreviewButton({ pkey, track, size = 26, accent = '255,255,255', className = '', style }) {
  const p = usePreview();
  const mine = p.key === pkey;
  const loading = mine && p.status === 'loading';
  const playing = mine && p.status === 'playing';
  const failed = mine && p.status === 'error';
  const r = size / 2 - 2;
  const circ = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggle(pkey, track); }}
      onMouseDown={(e) => e.stopPropagation()}
      title={failed ? (p.error || 'No preview available') : playing || loading ? 'Stop preview' : 'Preview 30 seconds'}
      aria-label={playing || loading ? `Stop preview of ${track.title}` : `Preview ${track.title}`}
      aria-pressed={playing}
      style={{
        position: 'relative', width: size, height: size, flexShrink: 0, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        /* At rest, the now-playing bar's play button: a white glyph and
           nothing behind it. Round only while the ring counts the preview down. */
        borderRadius: playing || loading ? '50%' : 'var(--r-ctl-s, 8px)', border: 'none', cursor: 'pointer',
        background: playing || loading ? `rgba(${accent}, 0.2)` : 'transparent',
        color: failed ? 'rgb(255,150,120)' : playing || loading ? `rgb(${accent})` : '#fff',
        transition: 'background 0.14s ease, color 0.14s ease',
        ...style,
      }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
        {playing ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2"
            strokeDasharray={circ} strokeDashoffset={circ * (1 - p.pct)} strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.25s linear' }} />
        ) : null}
        {loading ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2"
            strokeDasharray={`${circ * 0.28} ${circ}`} strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" from={`0 ${size / 2} ${size / 2}`} to={`360 ${size / 2} ${size / 2}`} dur="0.8s" repeatCount="indefinite" />
          </circle>
        ) : null}
      </svg>
      {playing || loading ? (
        <svg width={size * 0.34} height={size * 0.34} viewBox="0 0 10 10" aria-hidden><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
      ) : failed ? (
        <svg width={size * 0.42} height={size * 0.42} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 7v6M12 17v.5" /></svg>
      ) : (
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" aria-hidden fill="currentColor" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"
          style={{ marginLeft: Math.round(size * 0.06) }}><path d="M8 6.5v11l9.5-5.5z" /></svg>
      )}
    </button>
  );
}
