/* =========================================================================
 *  studio — notices from the main process
 *
 *  Things going wrong behind the scenes (Spotify rate limits, metadata
 *  falling back to Apple Music, the playback helper failing to sign in)
 *  used to show up only in the terminal. notice() sends them to the window,
 *  which shows a short toast and keeps the full explanation, with a time,
 *  in the notifications panel in the top bar.
 *
 *    title   what happened, in a few words (the toast)
 *    detail  why, what it affects and what Studio is doing about it
 *    key     one notice per situation: the same key isn't sent again until
 *            `repeatAfterMs` has passed, so a burst of failures is one notice
 * ========================================================================= */

import { BrowserWindow } from 'electron';

const lastSent = new Map(); // key → time sent

export function notice({ key, kind = 'warning', title, detail = '', source = '', quiet = false, repeatAfterMs = 10 * 60 * 1000 }) {
  if (!title) return;
  const now = Date.now();
  if (key) {
    if (now - (lastSent.get(key) || 0) < repeatAfterMs) return;
    lastSent.set(key, now);
  }
  // quiet: kept in the panel, no toast.
  const payload = { key: key || null, kind, title, detail, source, quiet, at: now };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('app:notice', payload); } catch { /* closing */ }
  }
}


/** "about 3 minutes", "about 2 hours" */
export function waitWords(sec) {
  const s = Math.max(1, Math.round(Number(sec) || 0));
  if (s < 90) return `about ${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}
