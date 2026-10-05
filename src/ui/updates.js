/* =========================================================================
 *  studio — update status in the window
 *
 *  The main process checks GitHub Releases (src/main/updater.js) and sends
 *  its status here. One subscription for the whole window; useUpdate() reads
 *  it anywhere (the notifications panel, the toast in App, Settings).
 *
 *    { state, current, version, notes, url, error, checkedAt, canInstall }
 *    state: idle | checking | none | downloading | ready | available | error
 * ========================================================================= */

import { useSyncExternalStore } from 'react';

const SEEN_KEY = 'studio:updateSeen';
const bridge = () => (typeof window !== 'undefined' ? window.electronAPI : null);

let status = { state: 'idle', current: '', version: '', notes: '', url: '', error: '', checkedAt: 0, canInstall: false };
let seen = '';
try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch { /* ignore */ }
let snap = { status, seen };
const subs = new Set();
let started = false;

function set(next) {
  snap = { ...snap, ...next };
  subs.forEach((fn) => fn());
}

function start() {
  if (started) return;
  started = true;
  const a = bridge();
  a?.onUpdateStatus?.((s) => { if (s) set({ status: s }); });
  a?.updateGetStatus?.().then((s) => { if (s) set({ status: s }); }).catch(() => {});
}

/** { status, seen, offer } — `offer` is true when there's something to install or download. */
export function useUpdate() {
  start();
  const s = useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => snap);
  const offer = s.status.state === 'ready' || s.status.state === 'available';
  return { ...s, offer, unseen: offer && s.status.version !== s.seen };
}

/** The bell was opened: this version's notice is read. */
export function markUpdateSeen() {
  const v = snap.status.version;
  if (!v || v === snap.seen) return;
  try { localStorage.setItem(SEEN_KEY, v); } catch { /* ignore */ }
  set({ seen: v });
}

export const checkForUpdate = () => bridge()?.updateCheck?.();
/** Restart into the downloaded update, or open the release page where it can't install itself. */
export const installUpdate = () => bridge()?.updateInstall?.();
