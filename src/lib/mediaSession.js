import { useEffect, useRef } from 'react';

/* Media keys and the system's media controls (the Windows flyout that
 * appears with the volume keys, the lock screen, keyboard play/pause, next
 * and previous), through the Media Session API.
 *
 * Chromium only hands media keys to a page that it can see playing media.
 * Spotify songs play in the helper process, not in this page, so to Chromium
 * nothing was playing and the keys went nowhere. A silent, looping clip plays
 * here while Studio is playing (and pauses with it), which is what makes the
 * page the system's current player whatever is actually making the sound.
 *
 * Volume keys stay the system's: they change Windows' volume, as they do
 * for every player. Studio doesn't take them over. */

/** A second of silence as a WAV blob URL, made once. */
let silentUrl = null;
function silence() {
  if (silentUrl) return silentUrl;
  const rate = 8000; const n = rate; const bytes = n * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

const ACTIONS = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'];

/**
 * track: { title, artist, album, coverArt } | null
 * handlers: { onPlay, onPause, onPrev, onNext, onSeek(seconds) }; read
 * through a ref, so they can change every render.
 * getTime: () => current position in seconds. seekNonce: bumped on every seek.
 */
export function useMediaSession({ track, isPlaying, duration, getTime, handlers, seekNonce = 0 }) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  const live = useRef({});
  live.current = { handlers, getTime, isPlaying, duration };
  const keepRef = useRef(null);

  // Action handlers, once.
  useEffect(() => {
    if (!ms) return undefined;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* not supported here */ } };
    const h = () => live.current.handlers || {};
    set('play', () => h().onPlay?.());
    set('pause', () => h().onPause?.());
    set('stop', () => h().onPause?.());
    set('previoustrack', () => h().onPrev?.());
    set('nexttrack', () => h().onNext?.());
    set('seekto', (d) => { if (Number.isFinite(d?.seekTime)) h().onSeek?.(d.seekTime); });
    set('seekbackward', (d) => { const t = live.current.getTime?.() || 0; h().onSeek?.(Math.max(0, t - (d?.seekOffset || 10))); });
    set('seekforward', (d) => { const t = live.current.getTime?.() || 0; h().onSeek?.(t + (d?.seekOffset || 10)); });
    return () => { for (const a of ACTIONS) set(a, null); };
  }, [ms]);

  // What's playing, for the system flyout.
  const key = track ? `${track.title}\u0000${track.artist}\u0000${track.album}\u0000${track.coverArt || ''}` : '';
  useEffect(() => {
    if (!ms) return;
    if (!track) { ms.metadata = null; return; }
    try {
      const art = track.coverArt ? [{ src: track.coverArt, sizes: '512x512' }] : [];
      ms.metadata = new window.MediaMetadata({
        title: track.title || 'Unknown title',
        artist: track.artist || '',
        album: track.album || '',
        artwork: art,
      });
    } catch { /* MediaMetadata unavailable */ }
  }, [ms, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playing or paused, and the silent clip that keeps Studio the system's player.
  useEffect(() => {
    if (ms) { try { ms.playbackState = track ? (isPlaying ? 'playing' : 'paused') : 'none'; } catch { /* ignore */ } }
    if (!keepRef.current) {
      const a = new Audio(silence());
      a.loop = true;
      a.preload = 'auto';
      keepRef.current = a;
    }
    const a = keepRef.current;
    if (track && isPlaying) a.play().catch(() => {});
    else a.pause();
  }, [ms, track ? 1 : 0, isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // The position, so the system's timeline matches; it runs on by itself between updates.
  useEffect(() => {
    if (!ms?.setPositionState) return;
    const d = Number(duration);
    if (!track || !(d > 0)) { try { ms.setPositionState(); } catch { /* ignore */ } return; }
    const pos = Math.min(d, Math.max(0, Number(getTime?.()) || 0));
    try { ms.setPositionState({ duration: d, position: pos, playbackRate: 1 }); } catch { /* ignore */ }
  }, [ms, key, duration, isPlaying, seekNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { try { keepRef.current?.pause(); } catch { /* ignore */ } }, []);
}
