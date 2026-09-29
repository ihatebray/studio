/* =========================================================================
 *  studio — artists followed in Studio (renderer side of follows.js)
 *
 *  One list for the artist pages' Follow button and New Releases' Following
 *  panel. Nothing here touches Spotify: following is Studio's own.
 * ========================================================================= */

import { useSyncExternalStore } from 'react';

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

let list = [];
let started = false;
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());
const set = (next) => { list = Array.isArray(next) ? next : []; emit(); };

function start() {
  if (started) return;
  started = true;
  const a = api();
  a?.followsList?.().then(set).catch(() => {});
  a?.onFollowsChanged?.(set);
}

/** Artists followed in Studio, newest first: [{ id, name, image, at }]. */
export function useStudioFollows() {
  start();
  return useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => list);
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Followed in Studio? By Spotify id when known, else by name. */
export function isStudioFollowed(artist, follows = list) {
  const id = artist?.spotifyId || artist?.id;
  if (id && follows.some((a) => a.id === id)) return true;
  return !!artist?.name && follows.some((a) => norm(a.name) === norm(artist.name));
}

/** Follow in Studio. An artist known only by name (from your library) is
 *  looked up on Spotify first, for the id New Releases needs. */
export async function followArtist({ id, spotifyId, name, image } = {}) {
  const a = api();
  if (!a?.followsAdd) return { ok: false, error: 'Following isn’t available in this build.' };
  let sid = /^[0-9A-Za-z]{22}$/.test(String(spotifyId || id || '')) ? (spotifyId || id) : null;
  let img = image || null;
  if (!sid && name && a.spotifySearchArtists) {
    const hits = await a.spotifySearchArtists(name).catch(() => []);
    const hit = (hits || []).find((h) => norm(h.name) === norm(name) && /^[0-9A-Za-z]{22}$/.test(h.id || ''));
    if (hit) { sid = hit.id; img = img || hit.image || null; }
  }
  if (!sid) return { ok: false, error: `Couldn’t find “${name}” on Spotify to follow.` };
  return a.followsAdd({ id: sid, name, image: img });
}

export async function unfollowArtist(artist) {
  const a = api();
  const id = artist?.spotifyId || artist?.id;
  const hit = list.find((f) => (id && f.id === id) || norm(f.name) === norm(artist?.name));
  if (!hit || !a?.followsRemove) return { ok: false };
  return a.followsRemove(hit.id);
}
