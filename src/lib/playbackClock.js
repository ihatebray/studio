/* =========================================================================
 *  studio — the playback position, outside React state
 *
 *  The audio element reports its position about four times a second. Kept
 *  in App's state, every report re-rendered the whole app (the library,
 *  the sidebar, the open page) to move a progress bar. Here it's a tiny
 *  store: only the parts that show the position read it with
 *  usePlaybackTime(), and only they redraw.
 * ========================================================================= */

import { useSyncExternalStore } from 'react';

let time = 0;
const subs = new Set();

export function setPlaybackTime(t) {
  const v = Number.isFinite(t) ? t : 0;
  if (v === time) return;
  time = v;
  subs.forEach((fn) => fn());
}

export function getPlaybackTime() { return time; }

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

/** The current position in seconds; the component redraws as it moves. */
export function usePlaybackTime() {
  return useSyncExternalStore(subscribe, getPlaybackTime);
}
