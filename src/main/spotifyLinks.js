/* =========================================================================
 *  studio — Spotify links
 *
 *  Two ways a Spotify link gets into Studio:
 *  - Ctrl+V in Studio (or pasting one into search): the window asks for the
 *    clipboard's link and opens it.
 *  - Copying one anywhere else while Studio runs: the clipboard is checked
 *    four times a second, and a newly copied Spotify link is sent to the window,
 *    which offers to open it. Only the clipboard's text is read, only a
 *    Spotify link in it is kept, and nothing leaves the computer except the
 *    lookup of that one link. Off in Settings → Library stops the checking.
 *
 *  resolve() turns a link into what the window shows:
 *    { kind, id, name, sub, image, date?, album?, rows? }
 *  rows: a song's own row (to play it) or an album's tracklist.
 *
 *  Fast first: the full lookup (through the helper) and Spotify's public
 *  preview start together. If the full answer isn't back within
 *  FIRST_PAINT_MS, the window gets the preview straight away (name and
 *  cover, `loading: true`) and the full one replaces it when it lands.
 *  Answers are kept, so copying the same link again is instant.
 * ========================================================================= */

import { BrowserWindow, clipboard, net } from 'electron';
import { parseSpotifyLink } from '../lib/spotifyLink.js';
import { helperAlbum, helperArtists, helperTracks } from './spotifyPlayer.js';

const CHECK_MS = 250;
const LONGEST = 4000;
const FIRST_PAINT_MS = 300;

/* Looked-up links (id → answer) and followed share links (url → link). */
const known = new Map();
const KNOWN_MAX = 60;
const remember = (map, k, v) => { map.delete(k); map.set(k, v); while (map.size > KNOWN_MAX) map.delete(map.keys().next().value); };
const shortLinks = new Map();

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

/** The link's answer. `onPreview` (optional) gets the quick name-and-cover
 *  version when the full one is slow; it isn't called for a known link. */
export async function resolve(link, onPreview = null) {
  let l = link;
  if (l?.kind === 'short') {
    l = shortLinks.get(l.url) || await followShort(l.url).catch(() => null);
    if (l?.id) remember(shortLinks, link.url, l);
  }
  if (!l?.id) return null;
  const { kind, id } = l;
  const key = `${kind}:${id}`;
  if (known.has(key)) return known.get(key);

  const quick = preview(kind, id).catch(() => null);
  let settled = false;
  if (onPreview) {
    setTimeout(async () => {
      const p = settled ? null : await quick;
      if (p?.name && !settled) onPreview({ kind, id, name: p.name, sub: '', image: p.image, loading: true });
    }, FIRST_PAINT_MS);
  }
  try {
    const out = await full(kind, id, quick);
    // Kept only when it's complete: a preview stand-in (the helper was busy
    // or you're signed out) is looked up again next time.
    if (out.name && (out.complete || kind === 'playlist')) remember(known, key, out);
    return out;
  } finally {
    settled = true;
  }
}

/* Everything the card can show, from the helper; the public preview (already
   on its way) fills in the name and cover when the helper can't. */
async function full(kind, id, quick) {
  const out = { kind, id, name: '', sub: '', image: '' };
  try {
    if (kind === 'track') {
      const row = (await helperTracks([id]))?.[0];
      if (row) {
        Object.assign(out, { name: row.title, sub: row.artists, image: row.albumArtUrl, date: row.releaseDate || '', rows: [row], complete: true });
        if (row.albumId) out.album = { id: row.albumId, name: row.album, image: row.albumArtUrl };
      }
    } else if (kind === 'album') {
      const a = await helperAlbum(id);
      if (a) Object.assign(out, { name: a.album || a.name || '', sub: a.artists || '', image: a.albumArtUrl || '', date: a.releaseDate || '', rows: a.tracks || null, complete: true });
    } else if (kind === 'artist') {
      const a = (await helperArtists([id]))?.[0];
      if (a) Object.assign(out, { name: a.name || '', image: a.image || '', complete: !!a.name });
    }
  } catch { /* not signed in for playback, or the helper is busy: the preview below */ }
  if (!out.name) {
    const p = await quick;
    if (p) Object.assign(out, { name: p.name, image: out.image || p.image });
  }
  return out;
}

/* ---------------------------------------------------- clipboard watching */

let timer = null;
let last = '';
let copies = 0;

function check() {
  const now = readClipboard();
  if (now === last) return;
  last = now;
  // Copied inside Studio: Ctrl+V there opens it already.
  if (BrowserWindow.getFocusedWindow()) return;
  const link = parseSpotifyLink(now);
  if (!link) return;
  // Only the newest copy reaches the window: a slow answer for an older
  // link mustn't replace the card for the one just copied.
  const seq = ++copies;
  const send = (info) => {
    if (!info || seq !== copies) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('spotifyLink:copied', info); } catch { /* closing */ }
    }
  };
  resolve(link, send).then(send, () => {});
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
