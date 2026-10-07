/* =========================================================================
 *  studio — Spotify links
 *
 *  Two ways a Spotify link gets into Studio:
 *  - Ctrl+V in Studio (or pasting one into search): the window asks for the
 *    clipboard's link and opens it.
 *  - Copying one anywhere else while Studio runs: the clipboard is checked
 *    once a second, and a newly copied Spotify link is sent to the window,
 *    which offers to open it. Only the clipboard's text is read, only a
 *    Spotify link in it is kept, and nothing leaves the computer except the
 *    lookup of that one link. Off in Settings → Library stops the checking.
 *
 *  resolve() turns a link into what the window shows:
 *    { kind, id, name, sub, image, date?, album?, rows? }
 *  rows: a song's own row (to play it) or an album's tracklist.
 * ========================================================================= */

import { BrowserWindow, clipboard, net } from 'electron';
import { parseSpotifyLink } from '../lib/spotifyLink.js';
import { helperAlbum, helperArtists, helperTracks } from './spotifyPlayer.js';

const CHECK_MS = 1000;
const LONGEST = 4000;

const readClipboard = () => {
  try { return String(clipboard.readText() || '').slice(0, LONGEST); } catch { return ''; }
};

/** A spotify.link share link, followed to the open.spotify.com one. */
async function followShort(url) {
  const res = await net.fetch(url, { redirect: 'follow' });
  const direct = parseSpotifyLink(res.url);
  if (direct && direct.kind !== 'short') return direct;
  // Some answer with a page that links on instead of redirecting.
  const body = await res.text().catch(() => '');
  const inPage = parseSpotifyLink(body);
  return inPage && inPage.kind !== 'short' ? inPage : null;
}

/** Name and cover from Spotify's public link preview: works signed out. */
async function preview(kind, id) {
  const page = `https://open.spotify.com/${kind}/${id}`;
  const res = await net.fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`);
  if (!res.ok) throw new Error(`preview ${res.status}`);
  const j = await res.json();
  return { name: String(j.title || ''), image: String(j.thumbnail_url || '') };
}

export async function resolve(link) {
  let l = link;
  if (l?.kind === 'short') l = await followShort(l.url).catch(() => null);
  if (!l?.id) return null;
  const { kind, id } = l;
  const out = { kind, id, name: '', sub: '', image: '' };
  try {
    if (kind === 'track') {
      const row = (await helperTracks([id]))?.[0];
      if (row) {
        Object.assign(out, { name: row.title, sub: row.artists, image: row.albumArtUrl, date: row.releaseDate || '', rows: [row] });
        if (row.albumId) out.album = { id: row.albumId, name: row.album, image: row.albumArtUrl };
      }
    } else if (kind === 'album') {
      const a = await helperAlbum(id);
      if (a) Object.assign(out, { name: a.album || a.name || '', sub: a.artists || '', image: a.albumArtUrl || '', date: a.releaseDate || '', rows: a.tracks || null });
    } else if (kind === 'artist') {
      const a = (await helperArtists([id]))?.[0];
      if (a) Object.assign(out, { name: a.name || '', image: a.image || '' });
    }
  } catch { /* not signed in for playback, or the helper is busy: the preview below */ }
  if (!out.name) {
    const p = await preview(kind, id).catch(() => null);
    if (p) Object.assign(out, { name: p.name, image: out.image || p.image });
  }
  return out;
}

/* ---------------------------------------------------- clipboard watching */

let timer = null;
let last = '';

function check() {
  const now = readClipboard();
  if (now === last) return;
  last = now;
  // Copied inside Studio: Ctrl+V there opens it already.
  if (BrowserWindow.getFocusedWindow()) return;
  const link = parseSpotifyLink(now);
  if (!link) return;
  resolve(link).then((info) => {
    if (!info) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('spotifyLink:copied', info); } catch { /* closing */ }
    }
  }, () => {});
}

export function setWatching(on) {
  clearInterval(timer);
  timer = null;
  if (!on) return;
  // Whatever was copied before is old news.
  last = readClipboard();
  timer = setInterval(check, CHECK_MS);
}

export function registerSpotifyLinkIpc(ipcMain) {
  ipcMain.handle('spotifyLink:watch', (_e, on) => { setWatching(!!on); return { ok: true }; });
  /** The clipboard's Spotify link ({ kind, id } or { kind: 'short', url }),
   *  not looked up yet; null when it holds none. */
  ipcMain.handle('spotifyLink:fromClipboard', () => parseSpotifyLink(readClipboard()));
  ipcMain.handle('spotifyLink:resolve', async (_e, text) => {
    const link = parseSpotifyLink(text);
    return link ? resolve(link).catch(() => null) : null;
  });
}
