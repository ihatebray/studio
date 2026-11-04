/* =========================================================================
 *  studio — the playback position, outside React state
 *
 *  The audio element reports its position about four times a second. Kept
 *  in App's state, every report re-rendered the whole app (the library,
 *  the sidebar, the open page) to move a progress bar. Here it's a tiny
 *  store: only the parts that show the position read it with
 *  usePlaybackTime(), and only they redraw.
 * ========================================================================= */

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

let time = 0;
let at = 0; // performance.now() when `time` was reported
const subs = new Set();

export function setPlaybackTime(t) {
  const v = Number.isFinite(t) ? t : 0;
  at = performance.now();
  if (v === time) return;
  time = v;
  subs.forEach((fn) => fn());
}

export function getPlaybackTime() { return time; }

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Calls `fn(seconds)` as the position moves, outside React; returns the
 *  unsubscribe. (A playlist's own window is told the position this way.) */
export function onPlaybackTime(fn) { return subscribe(() => fn(time)); }

/** The current position in seconds; the component redraws as it moves. */
export function usePlaybackTime() {
  return useSyncExternalStore(subscribe, getPlaybackTime);
}

/** Keeps a progress bar's fill (`ref`, sized by its width) at the playing
 *  position. The position is reported about four times a second, which drew
 *  the bar in small steps; while playing, this moves it every frame from the
 *  last report, straight on the element, with no React render. `held` (0 to
 *  1) shows a dragged position instead. A report that lands a hair behind
 *  where the bar already is holds it there, so it never steps back. */
export function useProgressFill(ref, duration, playing, held = null) {
  const heldRef = useRef(held);
  heldRef.current = held;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let raf = 0;
    let shown = -1;
    const draw = () => {
      const h = heldRef.current;
      let f;
      if (h != null) f = h;
      else if (!(duration > 0)) f = 0;
      else {
        const age = (performance.now() - at) / 1000;
        f = (time + (playing && age < 1 ? age : 0)) / duration;
      }
      f = Math.min(1, Math.max(0, f));
      if (playing && h == null && f < shown && (shown - f) * duration < 0.3) return;
      if (f !== shown) { shown = f; el.style.width = `${f * 100}%`; }
    };
    draw();
    const off = subscribe(draw);
    if (playing) {
      const loop = () => { draw(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => { off(); cancelAnimationFrame(raf); };
  }, [ref, duration, playing, held]);
}
