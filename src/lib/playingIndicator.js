/* =========================================================================
 *  studio — the playing indicator's style
 *
 *  What the current song's row shows in every list (PlayingBars in
 *  home/common.jsx): Bars, Beacon or Signal, picked in Settings → Layout.
 *  One value for the whole app, kept here rather than threaded through
 *  props, since lists in every corner of the app draw it.
 * ========================================================================= */

import { useSyncExternalStore } from 'react';

const KEY = 'studio:playingIndicator';
export const INDICATOR_STYLES = [['bars', 'Bars'], ['beacon', 'Beacon'], ['signal', 'Signal']];
const valid = (v) => INDICATOR_STYLES.some(([id]) => id === v);

let current = (() => { try { const v = localStorage.getItem(KEY); return valid(v) ? v : 'bars'; } catch { return 'bars'; } })();
const listeners = new Set();

export const getIndicatorStyle = () => current;

export function setIndicatorStyle(v) {
  if (!valid(v) || v === current) return;
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* still applies for this session */ }
  listeners.forEach((fn) => fn());
}

export function useIndicatorStyle() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, getIndicatorStyle);
}
