import { useCallback, useEffect, useRef, useState } from 'react';

/* =========================================================================
 *  useMiniPlayerBridge — the main renderer's half of the mini player.
 *
 *  The mini window is a remote control, not a second player: audio, the
 *  crossfade/gapless engine, Discord presence and play-event recording all
 *  stay here. This hook does exactly two things:
 *
 *    publish  — push a compact now-playing snapshot whenever it changes
 *    receive  — apply commands the mini sends back
 *
 *  On publishing cadence: we deliberately do NOT include the raw
 *  `currentTime` in the effect deps. It changes on every timeupdate (4–5×
 *  a second) and that would mean an IPC round trip per tick for a progress
 *  bar. Instead we depend on `Math.round(currentTime)`, so we publish about
 *  once a second with a `{ position, at }` timestamp pair, and the mini
 *  interpolates between them. A seek still lands within a second, which is
 *  the same latency the eye reads as instant on a 4px bar.
 *
 *  Returns `{ miniOpen, openMini, closeMini, toggleMini }` so the app can
 *  render a toggle that reflects reality — including when the window was
 *  opened by the Ctrl+Alt+M global shortcut rather than by the UI.
 * ========================================================================= */

export function useMiniPlayerBridge({
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  volume,
  shuffleOn,
  repeat,
  onTogglePlay,
  onPrev,
  onNext,
  onSeek,
  onSetVolume,
  onToggleShuffle,
  onToggleRepeat,
  onToggleFavorite,
} = {}) {
  const [miniOpen, setMiniOpen] = useState(false);

  // Everything the mini needs, refreshed every render. The publish effect and
  // the command handler both read through this so neither has to re-subscribe
  // when an unrelated value changes.
  const live = useRef({});
  live.current = {
    currentTrack, isPlaying, currentTime, duration, volume, shuffleOn, repeat,
    onTogglePlay, onPrev, onNext, onSeek, onSetVolume, onToggleShuffle, onToggleRepeat, onToggleFavorite,
  };

  const buildSnapshot = useCallback(() => {
    const s = live.current;
    const t = s.currentTrack;
    return {
      hasTrack: !!t,
      id: t?.id || null,
      title: t?.title || '',
      artist: t?.artist || '',
      album: t?.album || '',
      coverArt: t?.coverArt || null,
      isFavorite: !!t?.isFavorite,
      isPlaying: !!s.isPlaying,
      position: Number(s.currentTime) || 0,
      duration: Number(s.duration) || Number(t?.duration) || 0,
      volume: Number(s.volume ?? 1),
      shuffleOn: !!s.shuffleOn,
      repeat: s.repeat || 'off',
      at: Date.now(),
    };
  }, []);

  const publish = useCallback(() => {
    window.electronAPI?.mini?.publish?.(buildSnapshot());
  }, [buildSnapshot]);

  /* ---------- Open/close plumbing ---------------------------------------- */
  useEffect(() => {
    const mini = window.electronAPI?.mini;
    if (!mini) return undefined;
    mini.getState?.().then((s) => setMiniOpen(!!s?.open)).catch(() => {});
    const offOpen = mini.onOpenChanged?.((open) => {
      setMiniOpen(!!open);
      if (open) publish();
    });
    // Main asks for a fresh snapshot when a mini window mounts or reloads.
    const offNeed = mini.onNeedState?.(() => publish());
    return () => { offOpen?.(); offNeed?.(); };
  }, [publish]);

  /* ---------- Commands ---------------------------------------------------- */
  useEffect(() => {
    const mini = window.electronAPI?.mini;
    if (!mini?.onCommand) return undefined;
    return mini.onCommand((cmd) => {
      const s = live.current;
      switch (cmd?.type) {
        case 'toggle': s.onTogglePlay?.(); break;
        case 'next': s.onNext?.(); break;
        case 'prev': s.onPrev?.(); break;
        case 'seek': {
          const v = Number(cmd.value);
          if (Number.isFinite(v)) s.onSeek?.(v);
          break;
        }
        case 'volume': {
          const v = Number(cmd.value);
          if (Number.isFinite(v)) s.onSetVolume?.(Math.min(1, Math.max(0, v)));
          break;
        }
        case 'shuffle': s.onToggleShuffle?.(); break;
        case 'repeat': s.onToggleRepeat?.(); break;
        case 'favorite': {
          if (s.currentTrack?.id) s.onToggleFavorite?.(s.currentTrack.id);
          break;
        }
        default: break;
      }
      // Commands change state the mini is showing — echo back immediately
      // rather than making it wait for the next second-boundary publish.
      publish();
    });
  }, [publish]);

  /* ---------- Publish ------------------------------------------------------
   * `Math.round(currentTime)` is the throttle: ~1 publish/second while
   * playing, and an immediate one on any seek that crosses a second, track
   * change, pause, or transport toggle.
   * ---------------------------------------------------------------------- */
  const coarseTime = Math.round(Number(currentTime) || 0);
  useEffect(() => {
    if (!miniOpen) return;
    publish();
  }, [
    miniOpen, publish, coarseTime,
    currentTrack?.id, currentTrack?.coverArt, currentTrack?.title,
    currentTrack?.artist, currentTrack?.isFavorite,
    isPlaying, duration, volume, shuffleOn, repeat,
  ]);

  const openMini = useCallback(() => window.electronAPI?.mini?.open?.(), []);
  const closeMini = useCallback(() => window.electronAPI?.mini?.close?.(), []);
  const toggleMini = useCallback(() => window.electronAPI?.mini?.toggle?.(), []);

  return { miniOpen, openMini, closeMini, toggleMini };
}

export default useMiniPlayerBridge;
