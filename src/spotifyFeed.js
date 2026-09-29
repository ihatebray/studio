/* =========================================================================
 *  studio — My Spotify feeds (main process)
 *
 *  What the sidebar's My Spotify section shows: Home (what you've been
 *  playing, on repeat, your artists and playlists) and New Releases (recent
 *  records from the artists you follow and play most). Everything comes from
 *  the signed-in account (spotifyPartner.js), through the public Web API's
 *  documented /me endpoints. Metadata only; playback is the helper's.
 *
 *  Both feeds are several requests, so each is assembled here in one call,
 *  cached (memory and disk) and served stale while a refresh runs. New
 *  Releases is the expensive one, one request per artist, so it is paced,
 *  capped, and kept for hours; a rate limit part way through keeps what was
 *  already gathered rather than failing the page.
 * ========================================================================= */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { webApi, webApiRateLimit, paged, partnerState } from './spotifyPartner.js';

const HOME_TTL_MS = 10 * 60 * 1000;
const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_WINDOW_DAYS = 60;
const RELEASE_ARTIST_CAP = 90;
const RELEASE_CONCURRENCY = 3;

const cacheFile = () => path.join(app.getPath('userData'), 'spotify-feed-cache.json');
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------- shaping */

const pickImg = (images, want = 300) => {
  const list = (images || []).filter((i) => i?.url);
  if (!list.length) return null;
  return [...list].sort((a, b) => Math.abs((a.height || want) - want) - Math.abs((b.height || want) - want))[0].url;
};
const idOf = (uri) => String(uri || '').split(':').pop() || null;

/** A track in the shape Save (library:saveSpotify) and the pages use. */
export function shapeTrack(t, extra = {}) {
  if (!t?.id || t.type === 'episode') return null;
  return {
    spotifyId: t.id,
    title: t.name || '',
    artists: (t.artists || []).map((a) => a.name).join(', '),
    artistIds: (t.artists || []).map((a) => a.id),
    album: t.album?.name || '',
    albumId: t.album?.id || null,
    albumArtUrl: pickImg(t.album?.images, 300),
    durationMs: t.duration_ms || 0,
    explicit: !!t.explicit,
    trackNumber: t.track_number || null,
    discNumber: t.disc_number || null,
    ...extra,
  };
}

const shapeArtist = (a) => (a?.id ? { id: a.id, name: a.name || '', image: pickImg(a.images, 320), genres: a.genres || [] } : null);

function shapeAlbum(a) {
  if (!a?.id) return null;
  return {
    albumId: a.id,
    name: a.name || '',
    type: String(a.album_type || a.album_group || 'album').toLowerCase(),
    artists: (a.artists || []).map((x) => x.name).join(', '),
    artistIds: (a.artists || []).map((x) => x.id),
    albumArtUrl: pickImg(a.images, 640),
    thumbUrl: pickImg(a.images, 300),
    releaseDate: a.release_date || '',
    precision: a.release_date_precision || 'day',
    totalTracks: a.total_tracks || null,
  };
}

const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

function requireSignIn() {
  const st = partnerState();
  if (!st.connected) {
    const e = new Error('Sign in to Spotify in Settings → Connections to see your Spotify here.');
    e.step = 'signin';
    throw e;
  }
  return st;
}

/* ------------------------------------------------------------------ Home */

/* Where recent listening happened: an album, a playlist, an artist, Liked
   Songs. The recently-played feed names each only by URI, so playlists and
   artists are looked up (a handful, once per refresh). */
async function recentContexts(items) {
  const seen = new Map();
  for (const it of items) {
    const c = it.context;
    const t = it.track;
    let key; let base;
    if (c?.type === 'playlist') {
      key = c.uri; base = { kind: 'playlist', id: idOf(c.uri) };
    } else if (c?.type === 'artist') {
      key = c.uri; base = { kind: 'artist', id: idOf(c.uri) };
    } else if (c?.type === 'collection' || /:collection$/.test(String(c?.uri || ''))) {
      key = 'liked'; base = { kind: 'liked', id: 'liked', name: 'Liked Songs' };
    } else if (t?.album?.id) {
      // No context (or an album one): the record the track is on.
      key = `spotify:album:${t.album.id}`;
      base = {
        kind: 'album', id: t.album.id, name: t.album.name,
        sub: (t.album.artists || []).map((a) => a.name).join(', '),
        image: pickImg(t.album.images, 300),
      };
    } else continue;
    if (!seen.has(key)) seen.set(key, { ...base, playedAt: it.played_at, fallbackImage: pickImg(t?.album?.images, 300) });
    if (seen.size >= 8) break;
  }
  const list = [...seen.values()];

  const artistIds = list.filter((c) => c.kind === 'artist').map((c) => c.id);
  const artists = artistIds.length
    ? await settle(webApi(`/artists?ids=${artistIds.join(',')}`))
    : { ok: true, v: { artists: [] } };
  const artistById = new Map((artists.ok ? artists.v.artists || [] : []).filter(Boolean).map((a) => [a.id, a]));

  await Promise.all(list.filter((c) => c.kind === 'playlist').map(async (c) => {
    const r = await settle(webApi(`/playlists/${encodeURIComponent(c.id)}?fields=id,name,images,owner(display_name),tracks(total)`));
    if (r.ok) {
      c.name = r.v.name;
      c.image = pickImg(r.v.images, 300);
      c.sub = `Playlist · ${r.v.owner?.display_name || 'Spotify'}`;
    } else c.dead = true;
  }));
  for (const c of list) {
    if (c.kind === 'artist') {
      const a = artistById.get(c.id);
      if (!a) { c.dead = true; continue; }
      c.name = a.name; c.image = pickImg(a.images, 300); c.sub = 'Artist';
    }
    if (c.kind === 'liked') c.sub = 'Your liked songs';
    if (c.kind === 'album') c.sub = `Album · ${c.sub}`;
    if (!c.image) c.image = c.fallbackImage;
    delete c.fallbackImage;
  }
  return list.filter((c) => !c.dead && c.name).slice(0, 6);
}

/* A refused part of a feed keeps the last good copy of that part, so a rate
   limit greys nothing out that was there before. */
const refusedBy = (results) => results.find((r) => !r.ok && r.e?.step === 'ratelimit')?.e || null;

async function buildHome(prev) {
  const st = requireSignIn();
  const [me, recent, topShort, topLong, topArtists, playlists, albums, liked] = await Promise.all([
    settle(webApi('/me')),
    settle(webApi('/me/player/recently-played?limit=50')),
    settle(webApi('/me/top/tracks?limit=20&time_range=short_term')),
    settle(webApi('/me/top/tracks?limit=20&time_range=long_term')),
    settle(webApi('/me/top/artists?limit=12&time_range=short_term')),
    settle(webApi('/me/playlists?limit=24')),
    settle(webApi('/me/albums?limit=12')),
    settle(webApi('/me/tracks?limit=1')),
  ]);
  // Nothing at all answered: say why rather than show an empty page.
  const all = [recent, topShort, topLong, topArtists, playlists, albums, liked];
  if (all.every((r) => !r.ok)) throw all.find((r) => r.e?.step === 'ratelimit')?.e || all[0].e;
  const limit = refusedBy(all);

  const recentItems = recent.ok ? recent.v.items || [] : [];
  const recentTracks = [];
  const seenTrack = new Set();
  for (const it of recentItems) {
    const s = shapeTrack(it.track, { playedAt: it.played_at });
    if (!s || seenTrack.has(s.spotifyId)) continue;
    seenTrack.add(s.spotifyId);
    recentTracks.push(s);
  }

  const old = prev || {};
  return {
    user: {
      name: (me.ok && me.v.display_name) || old.user?.name || st.displayName || '',
      image: me.ok ? pickImg(me.v.images, 160) : old.user?.image || null,
    },
    recentTracks: recent.ok ? recentTracks.slice(0, 24) : old.recentTracks || [],
    jumpBackIn: recent.ok
      ? (recentItems.length ? await recentContexts(recentItems).catch(() => old.jumpBackIn || []) : [])
      : old.jumpBackIn || [],
    onRepeat: topShort.ok ? (topShort.v.items || []).map((t) => shapeTrack(t)).filter(Boolean) : old.onRepeat || [],
    allTime: topLong.ok ? (topLong.v.items || []).map((t) => shapeTrack(t)).filter(Boolean) : old.allTime || [],
    topArtists: topArtists.ok ? (topArtists.v.items || []).map(shapeArtist).filter(Boolean) : old.topArtists || [],
    playlists: playlists.ok ? (playlists.v.items || []).filter(Boolean).map((p) => ({
      kind: 'playlist', id: p.id, name: p.name || '', image: pickImg(p.images, 300),
      sub: `${p.tracks?.total ?? 0} songs · ${p.owner?.display_name || ''}`.replace(/ · $/, ''),
      total: p.tracks?.total ?? 0,
    })) : old.playlists || [],
    savedAlbums: albums.ok ? (albums.v.items || []).map((r) => r?.album && { ...shapeAlbum(r.album), addedAt: r.added_at }).filter(Boolean) : old.savedAlbums || [],
    likedCount: liked.ok ? liked.v.total || 0 : old.likedCount ?? null,
    fetchedAt: Date.now(),
    // Some parts were refused: they're last time's, and this copy only
    // lasts until Spotify's wait is over.
    limitedUntil: limit?.retryAt || null,
  };
}

/* ---------------------------------------------------------- New Releases */

/* Whose releases to check: the artists you listen to most (recent first,
   then over months), then the ones you follow, up to a cap, since each is
   its own request. */
async function releaseArtists() {
  const [short, medium, followed] = await Promise.all([
    settle(webApi('/me/top/artists?limit=30&time_range=short_term')),
    settle(webApi('/me/top/artists?limit=40&time_range=medium_term')),
    settle((async () => {
      const out = [];
      let next = '/me/following?type=artist&limit=50';
      while (next && out.length < 500) {
        const p = await webApi(next);
        out.push(...(p.artists?.items || []));
        next = p.artists?.next || null;
      }
      return out;
    })()),
  ]);
  const byId = new Map();
  const add = (list, why) => {
    for (const a of list || []) {
      const s = shapeArtist(a);
      if (s && !byId.has(s.id)) byId.set(s.id, { ...s, why });
    }
  };
  // Refused outright: say so, rather than report an empty list of artists
  // as "nothing new".
  if (!short.ok && !medium.ok && !followed.ok) throw refusedBy([short, medium, followed]) || short.e;
  add(short.ok ? short.v.items : [], 'top');
  add(medium.ok ? medium.v.items : [], 'top');
  add(followed.ok ? followed.v : [], 'follow');
  // Followed artists you also play are "top"; mark them followed too.
  if (followed.ok) for (const a of followed.v) if (byId.has(a.id)) byId.get(a.id).followed = true;
  return [...byId.values()].slice(0, RELEASE_ARTIST_CAP);
}

async function buildReleases(prev) {
  requireSignIn();
  const artists = await releaseArtists();
  const cutoff = new Date(Date.now() - RELEASE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const byAlbum = new Map();
  let checked = 0;
  let stoppedEarly = false;
  let limit = null;

  let i = 0;
  const worker = async () => {
    while (i < artists.length && !stoppedEarly) {
      const a = artists[i++];
      try {
        const page = await webApi(`/artists/${encodeURIComponent(a.id)}/albums?include_groups=album,single&limit=10&market=from_token`);
        checked += 1;
        for (const raw of page.items || []) {
          const r = shapeAlbum(raw);
          if (!r || r.precision !== 'day' || r.releaseDate < cutoff) continue;
          const prev = byAlbum.get(r.albumId);
          if (prev) { if (!prev.forArtists.includes(a.name)) prev.forArtists.push(a.name); continue; }
          byAlbum.set(r.albumId, { ...r, forArtists: [a.name], artistImage: a.image, followed: !!(a.followed || a.why === 'follow') });
        }
      } catch (e) {
        // A long rate limit: keep what we have; the next refresh continues.
        if (e?.step === 'ratelimit' || e?.step === 'signin') { stoppedEarly = true; limit = e; break; }
      }
    }
  };
  await Promise.all(Array.from({ length: RELEASE_CONCURRENCY }, worker));
  if (stoppedEarly && !checked) throw limit;
  /* Cut short: last check's releases fill in for the artists not reached
     this time (still inside the window). */
  if (stoppedEarly && prev?.releases?.length) {
    for (const r of prev.releases) if (r.releaseDate >= cutoff && !byAlbum.has(r.albumId)) byAlbum.set(r.albumId, r);
  }

  /* The explicit and clean cuts, and regional duplicates, are separate
     albums with the same name, artists and date. */
  const seen = new Set();
  const releases = [...byAlbum.values()]
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || (b.totalTracks || 0) - (a.totalTracks || 0))
    .filter((r) => {
      const k = `${r.name.toLowerCase()}|${r.artists.toLowerCase()}|${r.releaseDate}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return {
    releases,
    artistsChecked: checked,
    artistsTotal: artists.length,
    partial: stoppedEarly,
    windowDays: RELEASE_WINDOW_DAYS,
    fetchedAt: Date.now(),
    limitedUntil: limit?.retryAt || null,
  };
}

/* ---------------------------------------------------------------- cached */

const inflight = new Map();
async function cached(key, ttl, build, force) {
  const c = loadCache();
  const hit = c[key];
  const account = partnerState().userId || partnerState().displayName || '';
  const prev = hit && hit.account === account ? hit.data : null;
  /* A copy made while rate-limited is good only until the wait is over, so
     the next visit after that fills in what was missing. */
  const until = prev?.limitedUntil ? Math.min(hit.at + ttl, prev.limitedUntil) : hit?.at + ttl;
  const fresh = prev && Date.now() < until;
  if (fresh && !force) return { ...prev, stale: false };
  // Still waiting out a rate limit: last copy, without asking Spotify.
  const limited = webApiRateLimit();
  if (limited && prev) return { ...prev, stale: true, limitedUntil: limited.until };
  if (!inflight.has(key)) {
    inflight.set(key, build(prev).then((data) => {
      c[key] = { at: Date.now(), account, data };
      saveCache();
      return data;
    }).finally(() => inflight.delete(key)));
  }
  return { ...(await inflight.get(key)), stale: false };
}

/** Cached feed, even if old, for painting the page before a refresh lands. */
function peek(key) {
  const hit = loadCache()[key];
  const account = partnerState().userId || partnerState().displayName || '';
  return hit && hit.account === account ? { ...hit.data, stale: true } : null;
}

/* ------------------------------------------------------------ collections */

async function playlistTracks(id) {
  const rows = await paged(`/playlists/${encodeURIComponent(id)}/tracks?limit=100&market=from_token`, 300);
  return rows.map((r) => shapeTrack(r?.track, { addedAt: r?.added_at })).filter(Boolean);
}

async function likedTracks() {
  const rows = await paged('/me/tracks?limit=50&market=from_token', 300);
  return rows.map((r) => shapeTrack(r?.track, { addedAt: r?.added_at })).filter(Boolean);
}

/* ------------------------------------------------------------------- IPC */

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) {
    return { ok: false, step: e?.step || 'webapi', error: String(e?.message || e), retryAfter: e?.retryAfter || null };
  }
};

export function registerSpotifyFeedIpc(ipcMain) {
  ipcMain.handle('spotifyFeed:peek', (_e, key) => (key === 'home' || key === 'releases' ? peek(key) : null));
  ipcMain.handle('spotifyFeed:home', wrap((force) => cached('home', HOME_TTL_MS, buildHome, !!force)));
  ipcMain.handle('spotifyFeed:releases', wrap((force) => cached('releases', RELEASES_TTL_MS, buildReleases, !!force)));
  ipcMain.handle('spotifyFeed:playlist', wrap((id) => playlistTracks(String(id || ''))));
  ipcMain.handle('spotifyFeed:liked', wrap(() => likedTracks()));
}
