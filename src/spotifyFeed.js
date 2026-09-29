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
import { webApi, webApiRateLimit, paged, partnerState, homeFeed, libraryItems } from './spotifyPartner.js';
import { helperReleases, helperPlaylist, helperLiked, helperArtists } from './spotifyPlayer.js';
import { listeningSummary } from './listening.js';
import { listFollows, onFollowsChange } from './follows.js';

const HOME_TTL_MS = 10 * 60 * 1000;
const EXTRAS_TTL_MS = 30 * 60 * 1000;
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

/* A refused part of a feed keeps the last good copy of that part, so a rate
   limit greys nothing out that was there before. */
const refusedBy = (results) => results.find((r) => !r.ok && r.e?.step === 'ratelimit')?.e || null;

/* Home, from where Sonora gets it: Spotify's own home feed (the web
   player's "recents" and its shelves, Made For You and the rest) and Your
   Library, both through Pathfinder. Neither touches the Web API, whose
   quota is shared by every app signing in as Spotify's desktop client. */
const FRESH_SHELF = /fresh new music/i;

async function buildHome(prev) {
  const st = requireSignIn();
  const [feed, lib] = await Promise.all([settle(homeFeed()), settle(libraryItems())]);
  if (!feed.ok && !lib.ok) throw refusedBy([feed, lib]) || feed.e;
  const old = prev || {};
  const items = lib.ok ? lib.v.items : null;
  const of = (kind) => (items ? items.filter((i) => i.kind === kind) : null);
  const liked = items?.find((i) => i.kind === 'liked') || null;
  /* Fresh New Music comes and goes from Spotify's home feed. Home always
     shows it, so keep the last one seen for the visits it's missing from. */
  const freshNow = feed.ok ? feed.v.shelves.find((sh) => FRESH_SHELF.test(sh.title || '') && sh.items?.length) : null;
  return {
    fresh: freshNow ? { ...freshNow, seenAt: Date.now() } : old.fresh || null,
    user: { name: st.displayName || old.user?.name || '', image: old.user?.image || null },
    recents: feed.ok ? feed.v.recents : old.recents || [],
    shelves: feed.ok ? feed.v.shelves : old.shelves || [],
    playlists: of('playlist') || old.playlists || [],
    albums: of('album') || old.albums || [],
    artists: of('artist') || old.artists || [],
    liked: liked || old.liked || null,
    fetchedAt: Date.now(),
    limitedUntil: refusedBy([feed, lib])?.retryAt || null,
  };
}

/* The parts only the Web API has (what you've had on repeat, recently
   played songs, all-time favourites, your top artists, your name and
   picture). Optional: Home shows them when they come, and goes without
   while that API is rate-limited. */
async function buildExtras(prev) {
  const st = requireSignIn();
  const [me, recent, topShort, topLong, topArtists] = await Promise.all([
    settle(webApi('/me')),
    settle(webApi('/me/player/recently-played?limit=50')),
    settle(webApi('/me/top/tracks?limit=20&time_range=short_term')),
    settle(webApi('/me/top/tracks?limit=20&time_range=long_term')),
    settle(webApi('/me/top/artists?limit=12&time_range=short_term')),
  ]);
  const all = [me, recent, topShort, topLong, topArtists];
  if (all.every((r) => !r.ok)) throw refusedBy(all) || all[0].e;
  const recentTracks = [];
  const seen = new Set();
  for (const it of recent.ok ? recent.v.items || [] : []) {
    const t = shapeTrack(it.track, { playedAt: it.played_at });
    if (!t || seen.has(t.spotifyId)) continue;
    seen.add(t.spotifyId);
    recentTracks.push(t);
  }
  const old = prev || {};
  return {
    user: {
      name: (me.ok && me.v.display_name) || old.user?.name || st.displayName || '',
      image: me.ok ? pickImg(me.v.images, 160) : old.user?.image || null,
    },
    recentTracks: recent.ok ? recentTracks.slice(0, 24) : old.recentTracks || [],
    onRepeat: topShort.ok ? (topShort.v.items || []).map((t) => shapeTrack(t)).filter(Boolean) : old.onRepeat || [],
    allTime: topLong.ok ? (topLong.v.items || []).map((t) => shapeTrack(t)).filter(Boolean) : old.allTime || [],
    topArtists: topArtists.ok ? (topArtists.v.items || []).map(shapeArtist).filter(Boolean) : old.topArtists || [],
    fetchedAt: Date.now(),
    limitedUntil: refusedBy(all)?.retryAt || null,
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
  // Artists followed in Studio are checked first.
  for (const a of listFollows()) if (!byId.has(a.id)) byId.set(a.id, { id: a.id, name: a.name, image: a.image, genres: [], why: 'follow', followed: true });
  add(short.ok ? short.v.items : [], 'top');
  add(medium.ok ? medium.v.items : [], 'top');
  add(followed.ok ? followed.v : [], 'follow');
  // Followed artists you also play are "top"; mark them followed too.
  if (followed.ok) for (const a of followed.v) if (byId.has(a.id)) byId.get(a.id).followed = true;
  return [...byId.values()].slice(0, RELEASE_ARTIST_CAP);
}

/* New Releases the way Sonora would: over the playback helper's session
   (studio-spotify/src/library.rs): followed artists from the collection
   service, their release lists and the recent releases' details in two
   metadata batches. The Web API version below is the fallback for when the
   helper isn't available. */
async function buildReleases(prev) {
  requireSignIn();
  // Artists followed in Studio go first, then the ones followed on Spotify.
  const studio = listFollows();
  const studioIds = new Set(studio.map((a) => a.id));
  try {
    const r = await helperReleases(RELEASE_WINDOW_DAYS, studio.map((a) => a.id), true);
    return {
      releases: (r.releases || []).map((x) => ({ ...x, inStudio: (x.artistIds || []).some((id) => studioIds.has(id)) })),
      artistsChecked: r.artistsChecked || 0, artistsTotal: r.artistsTotal || 0, studioFollows: studio.length,
      artists: r.artists || [],
      partial: false, windowDays: RELEASE_WINDOW_DAYS, fetchedAt: Date.now(), limitedUntil: null, source: 'session',
    };
  } catch (e) {
    console.warn('[releases] helper route failed, using the Web API:', e?.message || e);
  }
  return buildReleasesWebApi(prev);
}

async function buildReleasesWebApi(prev) {
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
async function cached(key, ttl, build, force, usesWebApi = false) {
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
  const limited = usesWebApi && webApiRateLimit();
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

/* ------------------------------------------------ your Studio listening */

/* Liked Songs (for the daily mix) and artist portraits change slowly; keep
   them a while so the Studio sections cost nothing to redraw. */
let likedCache = { at: 0, rows: [] };
const portraitCache = new Map(); // artist id → image | null

async function studioHome() {
  if (Date.now() - likedCache.at > 6 * 60 * 60 * 1000) {
    try { likedCache = { at: Date.now(), rows: await helperLiked() }; } catch { likedCache.at = Date.now() - 5 * 60 * 60 * 1000; }
  }
  const s = listeningSummary({ liked: likedCache.rows });
  const want = s.topArtists.map((a) => a.id).filter((id) => id && !portraitCache.has(id));
  if (want.length) {
    try {
      for (const a of await helperArtists(want)) portraitCache.set(a.id, a.image || null);
    } catch { /* portraits are a nicety; album art stands in */ }
  }
  s.topArtists = s.topArtists.map((a) => ({ ...a, image: (a.id && portraitCache.get(a.id)) || null }));
  return s;
}

/* ------------------------------------------------------------ collections */

async function playlistTracks(id) {
  try { return await helperPlaylist(id); } catch (e) { console.warn('[playlist] helper route failed:', e?.message || e); }
  const rows = await paged(`/playlists/${encodeURIComponent(id)}/tracks?limit=100&market=from_token`, 300);
  return rows.map((r) => shapeTrack(r?.track, { addedAt: r?.added_at })).filter(Boolean);
}

async function likedTracks() {
  try { return await helperLiked(); } catch (e) { console.warn('[liked] helper route failed:', e?.message || e); }
  const rows = await paged('/me/tracks?limit=50&market=from_token', 300);
  return rows.map((r) => shapeTrack(r?.track, { addedAt: r?.added_at })).filter(Boolean);
}

/* ------------------------------------------------------------------- IPC */

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) {
    return { ok: false, step: e?.step || 'webapi', error: String(e?.message || e), retryAfter: e?.retryAfter || null };
  }
};

/* Following or unfollowing in Studio changes what New Releases should hold:
   the next visit rebuilds it rather than serving the old copy. */
onFollowsChange(() => {
  const c = loadCache();
  if (c.releases) { c.releases.at = 0; saveCache(); }
});

export function registerSpotifyFeedIpc(ipcMain) {
  ipcMain.handle('spotifyFeed:peek', (_e, key) => (['home', 'releases', 'extras'].includes(key) ? peek(key) : null));
  ipcMain.handle('spotifyFeed:home', wrap((force) => cached('home', HOME_TTL_MS, buildHome, !!force)));
  ipcMain.handle('spotifyFeed:studio', wrap(() => studioHome()));
  ipcMain.handle('spotifyFeed:extras', wrap((force) => cached('extras', EXTRAS_TTL_MS, buildExtras, !!force, true)));
  ipcMain.handle('spotifyFeed:releases', wrap((force) => cached('releases', RELEASES_TTL_MS, buildReleases, !!force)));
  ipcMain.handle('spotifyFeed:playlist', wrap((id) => playlistTracks(String(id || ''))));
  ipcMain.handle('spotifyFeed:liked', wrap(() => likedTracks()));
}
