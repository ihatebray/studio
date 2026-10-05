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
import { webApiRateLimit, paged, partnerState, homeFeed, libraryItems, browseShelves, browseCards, MADE_FOR_YOU_PAGE } from './spotifyPartner.js';
import { helperReleases, helperPlaylist, helperLiked } from './spotifyPlayer.js';
import { listeningSummary } from './listening.js';
import { listFollows, onFollowsChange } from './follows.js';

/* Two hours. Spotify reshuffles its home feed on every request, so a short
   TTL made Home look different on every visit and cost a request each time;
   Refresh still fetches a new one whenever you ask. */
const HOME_TTL_MS = 2 * 60 * 60 * 1000;
const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_WINDOW_DAYS = 60;

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
// Spotify words it a few ways ("Fresh new music", "Fresh new drops", "Fresh picks").
const FRESH_SHELF = /^fresh (new )?(music|drops|picks|finds)\b|^new music for you/i;

/* Fresh New Music, every time. Spotify's home feed only sometimes carries
   its "Fresh new music" shelf, so the dependable source is Browse's New
   Releases page, which Spotify keeps current (New Music Friday, Release
   Radar, the week's new albums and singles). Which page that is gets looked
   up by name in Browse once a week. */
const NEW_RELEASES_CARD = /^new releases$/i;
async function newReleasesPageId() {
  const c = loadCache();
  const known = c.newReleasesPage;
  if (known?.id && Date.now() - (known.at || 0) < 7 * 24 * 60 * 60 * 1000) return known.id;
  try {
    const cards = await browseCards();
    const card = cards.find((x) => NEW_RELEASES_CARD.test(x.name.trim())) || cards.find((x) => /new releases|new music/i.test(x.name));
    if (card) { c.newReleasesPage = { id: card.id, name: card.name, at: Date.now() }; saveCache(); return card.id; }
    console.info(`[home] no New Releases page in Browse; its cards: ${cards.map((x) => x.name).join(' | ')}`);
  } catch (e) {
    console.info('[home] Browse index:', e?.message || e);
  }
  return known?.id || null;
}

async function freshNewMusic(feedShelf) {
  const out = [];
  const seen = new Set();
  const add = (items) => {
    for (const it of items || []) {
      const k = `${it.kind}:${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  };
  // Spotify's own shelf first, when the feed has it this time.
  add(feedShelf?.items);
  const pageId = await newReleasesPageId();
  if (pageId) {
    // The page's first few shelves are the new music; further down is older.
    for (const sh of (await browseShelves(pageId)).slice(0, 3)) add(sh.items);
  }
  return out.slice(0, 30);
}

async function buildHome(prev) {
  const st = requireSignIn();
  /* Spotify's home feed plus its Made For You page, as Sonora builds its
     home: the feed is what Spotify picks for today, Made For You is your
     Daily Mixes, Discover Weekly, Release Radar and the like, which the
     feed only sometimes carries. */
  const [feed, lib, made] = await Promise.all([settle(homeFeed()), settle(libraryItems()), settle(browseShelves(MADE_FOR_YOU_PAGE))]);
  if (!feed.ok && !lib.ok && !made.ok) throw refusedBy([feed, lib, made]) || feed.e;
  const old = prev || {};
  const items = lib.ok ? lib.v.items : null;
  const of = (kind) => (items ? items.filter((i) => i.kind === kind) : null);
  const liked = items?.find((i) => i.kind === 'liked') || null;
  /* Fresh New Music: the feed's own shelf when it's there, plus Browse's
     New Releases page, so it's on Home every time. The last good copy
     stands in if both are unavailable. */
  const freshNow = feed.ok ? feed.v.shelves.find((sh) => FRESH_SHELF.test(sh.title || '') && sh.items?.length) : null;
  let fresh = old.fresh || null;
  try {
    const items = await freshNewMusic(freshNow);
    if (items.length) fresh = { title: 'Fresh New Music', items, seenAt: Date.now() };
  } catch (e) {
    console.info('[home] Fresh New Music:', e?.message || e);
    if (freshNow) fresh = { ...freshNow, title: 'Fresh New Music', seenAt: Date.now() };
  }
  return {
    fresh,
    user: { name: st.displayName || old.user?.name || '', image: old.user?.image || null },
    recents: feed.ok ? feed.v.recents : old.recents || [],
    shelves: feed.ok ? feed.v.shelves : old.shelves || [],
    // Made For You's shelves, added after the feed's by the page (titles and
    // items already on the page are skipped there).
    madeForYou: made.ok ? made.v : old.madeForYou || [],
    playlists: of('playlist') || old.playlists || [],
    albums: of('album') || old.albums || [],
    artists: of('artist') || old.artists || [],
    liked: liked || old.liked || null,
    fetchedAt: Date.now(),
    limitedUntil: refusedBy([feed, lib, made])?.retryAt || null,
  };
}

/* ---------------------------------------------------------- New Releases */

/* New Releases the way Sonora would: over the playback helper's session
   (studio-spotify/src/library.rs): followed artists from the collection
   service, their release lists and the recent releases' details in two
   metadata batches. */
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
    /* No Web API fallback. It took one request per followed artist (dozens
       at once) on a client ID shared with every Spotify desktop app, which
       tripped the rate limit on the spot and kept it tripped. The page keeps
       showing the last check and says why it couldn't refresh. */
    const err = new Error(/not signed in|helper/i.test(String(e?.message || e))
      ? 'Spotify playback isn’t connected yet, so New Releases can’t check right now.'
      : `Couldn’t check for new releases (${e?.message || e}).`);
    err.step = 'helper';
    throw err;
  }
}

/* ---------------------------------------------------------------- cached */

const inflight = new Map();
/* A local calendar day, for feeds that change daily (Daily Mixes). */
const dayOf = (t) => new Date(t).toDateString();

async function cached(key, ttl, build, force, usesWebApi = false, daily = false) {
  const c = loadCache();
  const hit = c[key];
  const account = partnerState().userId || partnerState().displayName || '';
  const prev = hit && hit.account === account ? hit.data : null;
  /* A copy made while rate-limited is good only until the wait is over, so
     the next visit after that fills in what was missing. */
  const until = prev?.limitedUntil ? Math.min(hit.at + ttl, prev.limitedUntil) : hit?.at + ttl;
  // A daily feed is also stale once the day has changed (new Daily Mixes).
  const fresh = prev && Date.now() < until && (!daily || dayOf(hit.at) === dayOf(Date.now()));
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

/* Liked Songs (for the mixes) change slowly; keep them a while so the
   Studio sections cost nothing to redraw. */
let likedCache = { at: 0, rows: [] };

async function studioHome() {
  if (Date.now() - likedCache.at > 6 * 60 * 60 * 1000) {
    try { likedCache = { at: Date.now(), rows: await helperLiked() }; } catch { likedCache.at = Date.now() - 5 * 60 * 60 * 1000; }
  }
  const s = listeningSummary({ liked: likedCache.rows });
  return s;
}

/* ------------------------------------------------------------ collections */

/* Browsing shows the first 300 songs; an import (`all`) takes every one. */
const PREVIEW_CAP = 300;
const IMPORT_CAP = 20_000;

async function playlistTracks(id, all = false) {
  try { return await helperPlaylist(id, all); } catch (e) { console.warn('[playlist] helper route failed:', e?.message || e); }
  const rows = await paged(`/playlists/${encodeURIComponent(id)}/tracks?limit=100&market=from_token`, all ? IMPORT_CAP : PREVIEW_CAP);
  return rows.map((r) => shapeTrack(r?.track, { addedAt: r?.added_at })).filter(Boolean);
}

async function likedTracks(all = false) {
  try { return await helperLiked(all); } catch (e) { console.warn('[liked] helper route failed:', e?.message || e); }
  const rows = await paged('/me/tracks?limit=50&market=from_token', all ? IMPORT_CAP : PREVIEW_CAP);
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
  ipcMain.handle('spotifyFeed:peek', (_e, key) => (['home', 'releases'].includes(key) ? peek(key) : null));
  ipcMain.handle('spotifyFeed:home', wrap((force) => cached('home', HOME_TTL_MS, buildHome, !!force, false, true)));
  ipcMain.handle('spotifyFeed:studio', wrap(() => studioHome()));
  ipcMain.handle('spotifyFeed:releases', wrap((force) => cached('releases', RELEASES_TTL_MS, buildReleases, !!force)));
  ipcMain.handle('spotifyFeed:playlist', wrap((id, opts) => playlistTracks(String(id || ''), !!opts?.all)));
  /* Your playlists and Liked Songs, for setup's playlist import: just the
     library list, not the whole of Home. */
  ipcMain.handle('spotifyFeed:myPlaylists', wrap(async () => {
    requireSignIn();
    const r = await libraryItems();
    return (r.items || []).filter((i) => i.kind === 'playlist' || i.kind === 'liked');
  }));
  ipcMain.handle('spotifyFeed:liked', wrap((opts) => likedTracks(!!opts?.all)));
  /* Name and cover for a pasted playlist link, from Spotify's public link
     preview (oEmbed): no sign-in, and it works for any public playlist. */
  ipcMain.handle('spotifyFeed:playlistMeta', wrap(async (id) => {
    const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${String(id || '')}`)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`preview ${res.status}`);
    const j = await res.json();
    return { name: String(j.title || ''), cover: String(j.thumbnail_url || '') };
  }));
}
