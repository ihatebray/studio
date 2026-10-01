/* =========================================================================
 *  studio — Save: a Spotify track into the library, streamed, no file
 *
 *  Replaces Get's YouTube download. A saved track is an ordinary library row
 *  whose file_path is `spotify:track:<id>` instead of a path on disk, so it
 *  shows up in every library view, playlist and stat like any other track;
 *  the player sees the prefix and plays it through the studio-spotify helper.
 *  Saving also hearts the track on Spotify (Liked Songs).
 *
 *  Rows from elsewhere (iTunes charts and releases) carry no Spotify ID, so
 *  they're matched on the signed-in account first.
 * ========================================================================= */

import { partnerState, trackById, trackByIdPathfinder, findTrack, likeTracks } from './spotifyPartner.js';
import { spotifyCredentialsConfigured, spotifyGetTrack, spotifySearchTracks } from './spotifyClient.js';
import { itunesCrossCheck } from './itunesClient.js';
import { helperTracks, helperLike } from './spotifyPlayer.js';
import { upsertTracks, idsForFilePaths, loadAllTracks } from './libraryDb.js';

export const SPOTIFY_PATH_PREFIX = 'spotify:track:';

export const isStreamedPath = (p) => typeof p === 'string' && p.startsWith(SPOTIFY_PATH_PREFIX);
export const streamedPathFor = (id) => `${SPOTIFY_PATH_PREFIX}${id}`;

const realId = (id) => {
  const s = String(id || '').trim();
  // Chart / release rows use synthetic ids like "itunes:12345".
  return /^[0-9A-Za-z]{22}$/.test(s) ? s : '';
};

function notReady() {
  const st = partnerState();
  if (!st.connected) return 'Sign in to Spotify in Settings → Connections to save tracks.';
  if (st.canStream === false) return 'Sign in to Spotify once more in Settings → Connections to allow playback and saving.';
  return null;
}

/* ---- metadata, with fallbacks ------------------------------------------
 * A Save used to get its album, cover and length from one place: the row it
 * was saved from, else Spotify's Web API. When the Web API was rate-limiting
 * (which it does, in bursts), that lookup failed quietly and the track went
 * in as "Unknown Album" with no cover. Now each missing field is taken from
 * the first source that has it:
 *
 *   1. the row the Save came from (search, artist page, album, chart…)
 *   1b. the playback helper's session (librespot metadata): no Web API quota
 *   2. Spotify Web API, through the signed-in account
 *   3. Spotify's web-player API (Pathfinder): separate rate limit
 *   4. Spotify Web API through the Client ID in Settings, if one is set:
 *      a separate quota again
 *   5. iTunes, matched on title + artist + length: no Spotify at all
 *
 * and a Save that still ends up short is repaired later (repairStreamedRows).
 */

const FIELDS = ['title', 'artists', 'album', 'albumArtUrl', 'durationMs', 'trackNumber', 'discNumber', 'releaseDate', 'explicit', 'genre'];
const blank = (v) => v == null || v === '' || v === 'Unknown Album' || v === 'Unknown Artist' || v === 'Unknown Title'
  || (typeof v === 'number' && !(v > 0));
const complete = (m) => !blank(m.album) && !blank(m.albumArtUrl) && !blank(m.durationMs);

/* iTunes names singles and EPs "Title - Single"; Spotify doesn't. */
const itunesAlbum = (name) => String(name || '').replace(/\s+-\s+(Single|EP)$/i, '');

/* `hints`: what identifies the song, used only if Spotify has told us
   nothing by the time iTunes is asked (a match needs a title and artist). */
async function describe(id, meta, hints = null) {
  const merged = {};
  const take = (src) => {
    if (!src) return;
    for (const k of FIELDS) if (blank(merged[k]) && !blank(src[k])) merged[k] = src[k];
  };
  take(meta);
  const sources = [
    // The helper's session first: no Web API quota behind it.
    ['helper', async () => (await helperTracks([id]))?.[0] || null],
    // The web player's query (through the helper's session) before the Web
    // API, whose quota is shared with every Spotify desktop app.
    ['web player', () => trackByIdPathfinder(id)],
    ['web api', () => trackById(id)],
    ['client id', () => (spotifyCredentialsConfigured() ? spotifyGetTrack(id) : null)],
    ['itunes', async () => {
      take(hints);
      if (blank(merged.title)) return null;
      const m = await itunesCrossCheck({
        title: merged.title, artist: merged.artists,
        album: blank(merged.album) ? '' : merged.album,
        durationMs: Number(merged.durationMs) || 0,
      });
      return m && { ...m, album: itunesAlbum(m.album), spotifyId: undefined };
    }],
  ];
  let albumFrom = blank(merged.album) ? null : 'row';
  for (const [name, fetchIt] of sources) {
    if (complete(merged)) break;
    try {
      take(await fetchIt());
      if (!albumFrom && !blank(merged.album)) albumFrom = name;
    } catch (e) {
      console.warn(`[save] ${name} lookup failed for ${id}:`, String(e?.message || e));
    }
  }
  // Where the album came from, for the Save's notice; not a stored field.
  Object.defineProperty(merged, 'albumFrom', { value: albumFrom, enumerable: false });
  return merged;
}

/** Find the Spotify id for a row that has none (iTunes charts, releases):
 *  the signed-in search first, then the Client ID's if that's refused. */
async function resolveId(meta) {
  const args = [meta?.title, meta?.artists, Number(meta?.durationMs) || 0];
  try {
    const hit = await findTrack(...args);
    if (hit) return hit;
  } catch (e) {
    if (!spotifyCredentialsConfigured()) throw e;
  }
  if (!spotifyCredentialsConfigured()) return null;
  return findTrack(...args, (q) => spotifySearchTracks(q));
}

/** Library row for one catalogue track. */
async function rowFor(meta) {
  let id = realId(meta?.spotifyId);
  let found = null;
  if (!id) {
    found = await resolveId(meta);
    if (!found) return { error: `Couldn't find "${meta?.title || 'this track'}" on Spotify.` };
    id = found.spotifyId;
  }
  const m = await describe(id, { ...found, ...Object.fromEntries(Object.entries(meta || {}).filter(([, v]) => !blank(v))) });
  const durationMs = Number(m.durationMs) || 0;
  const year = Number(meta?.year) || Number(String(m.releaseDate || '').slice(0, 4)) || null;
  const art = String(m.albumArtUrl || '');
  return {
    id,
    albumFrom: m.albumFrom,
    track: {
      filePath: streamedPathFor(id),
      title: String(m.title || 'Unknown Title'),
      artist: String(m.artists || 'Unknown Artist'),
      album: String(m.album || 'Unknown Album'),
      duration: durationMs > 0 ? durationMs / 1000 : 0,
      coverArt: art || null,
      coverArtUrl: art || null,
      trackNumber: m.trackNumber ?? null,
      discNumber: m.discNumber ?? null,
      year,
      genre: m.genre || '',
      explicit: typeof m.explicit === 'boolean' ? m.explicit : null,
    },
  };
}

/**
 * Save catalogue tracks to the library and heart them on Spotify.
 * Returns { ok, tracks, failed: [{ meta, error }], liked }.
 *
 * Library first, heart second: the library row is what the user asked for,
 * so a Spotify refusal (rate limit, an old sign-in without the permission)
 * still leaves the track saved, and is reported as `likeError`.
 */
export async function saveSpotifyTracks(metas) {
  const why = notReady();
  if (why) return { ok: false, error: why, tracks: [], failed: [] };

  const rows = [];
  const failed = [];
  for (const meta of metas || []) {
    try {
      const r = await rowFor(meta);
      if (r.error) failed.push({ meta, error: r.error });
      else rows.push(r);
    } catch (e) {
      failed.push({ meta, error: String(e?.message || e) });
    }
  }
  if (!rows.length) return { ok: false, error: failed[0]?.error || 'Nothing to save.', tracks: [], failed };

  const res = await upsertTracks(rows.map((r) => r.track));
  if (!res.ok) return { ok: false, error: res.error || 'Could not save to library.', tracks: [], failed };

  const ids = await idsForFilePaths(rows.map((r) => r.track.filePath));
  for (const r of rows) r.track.id = ids.get(r.track.filePath) || r.track.id;

  let liked = 0;
  let likeError = null;
  /* Hearted the way Spotify's clients do it (the helper, through the
     collection service), else through the Web API, whose quota is the one
     that keeps running out. */
  const trackIds = rows.map((r) => r.id);
  try {
    liked = (await helperLike(trackIds))?.count || trackIds.length;
  } catch (viaHelper) {
    try { liked = await likeTracks(trackIds); } catch (e) { likeError = String(e?.message || e); }
    if (likeError) console.warn('[save] helper couldn’t heart it either:', String(viaHelper?.message || viaHelper));
  }
  if (likeError) console.warn('[save] library saved, but hearting on Spotify failed:', likeError);

  return {
    ok: true, tracks: rows.map((r) => r.track), failed, liked, likeError,
    // Saved with Apple Music's album and cover because Spotify wouldn't say.
    fromItunes: rows.filter((r) => r.albumFrom === 'itunes').map((r) => r.track.title),
  };
}

/** One track, in the { ok, track, error } shape Get's callers already expect. */
export async function saveSpotifyTrack(meta) {
  const r = await saveSpotifyTracks([meta]);
  if (!r.ok) return { ok: false, error: r.error, noPicker: true };
  return { ok: true, track: r.tracks[0], likeError: r.likeError, fromItunes: r.fromItunes.length > 0 };
}

/* ---- repair --------------------------------------------------------------
 * Saved rows still missing an album, cover or length (saved while every
 * source was refusing, or before these fallbacks existed) are looked up again
 * in the background: a few at a time, spaced out, so the repair can't be the
 * burst that gets the account rate-limited. What the user set by hand
 * (title, artist, genre, year) is kept; only the blanks are filled. */

const REPAIR_BATCH = 20;
const REPAIR_SPACING_MS = 2500;
let repairing = false;
/* Each row is tried once per session; one no source can fill waits for the
   next launch instead of costing lookups on every pass. */
const tried = new Set();

const needsRepair = (t) => isStreamedPath(t.filePath)
  && (blank(t.album) || !t.coverArt || !(t.duration > 0));

/** Returns how many rows were fixed. `onFixed` runs once if any were. */
export async function repairStreamedRows({ onFixed } = {}) {
  if (repairing || notReady()) return 0;
  repairing = true;
  let fixed = 0;
  try {
    const todo = (await loadAllTracks()).filter((t) => needsRepair(t) && !tried.has(t.id)).slice(0, REPAIR_BATCH);
    for (const t of todo) {
      tried.add(t.id);
      const id = t.filePath.slice(SPOTIFY_PATH_PREFIX.length);
      const m = await describe(id, {
        title: t.title, artists: t.artist, album: t.album,
        albumArtUrl: t.coverArt, durationMs: t.duration > 0 ? Math.round(t.duration * 1000) : 0,
        trackNumber: t.trackNumber, discNumber: t.discNumber, genre: t.genre, explicit: t.explicit == null ? undefined : !!t.explicit,
      });
      const better = (!blank(m.album) && blank(t.album)) || (m.albumArtUrl && !t.coverArt) || (m.durationMs > 0 && !(t.duration > 0));
      if (better) {
        const art = m.albumArtUrl || t.coverArt || null;
        const res = await upsertTracks([{
          id: t.id, filePath: t.filePath,
          title: t.title, artist: t.artist,
          album: blank(t.album) ? String(m.album || 'Unknown Album') : t.album,
          duration: t.duration > 0 ? t.duration : (Number(m.durationMs) || 0) / 1000,
          coverArt: art, coverArtUrl: art,
          trackNumber: t.trackNumber ?? m.trackNumber ?? null,
          discNumber: t.discNumber ?? m.discNumber ?? null,
          year: t.year ?? (Number(String(m.releaseDate || '').slice(0, 4)) || null),
          genre: t.genre || m.genre || '',
          explicit: t.explicit == null ? (typeof m.explicit === 'boolean' ? m.explicit : null) : !!t.explicit,
        }]);
        if (res.ok) fixed += 1;
      }
      await new Promise((r) => setTimeout(r, REPAIR_SPACING_MS));
    }
  } catch (e) {
    console.warn('[save] repair pass stopped:', String(e?.message || e));
  } finally {
    repairing = false;
  }
  if (fixed) {
    console.log(`[save] filled in details for ${fixed} saved track(s)`);
    try { onFixed?.(fixed); } catch { /* ignore */ }
  }
  return fixed;
}

/**
 * Fresh details for one library track, for the metadata editor's Refetch
 * button (it shows them as pending edits; nothing is written here). A Saved
 * track goes through the whole chain above by its Spotify id; a local file
 * is matched on iTunes by title, artist and length.
 */
export async function refetchMetadata(track) {
  if (!track) return { ok: false, error: 'Track not found.' };
  let m;
  if (isStreamedPath(track.filePath)) {
    // Everything fresh; the track's own title/artist/length only as hints
    // for the iTunes match if Spotify refuses.
    m = await describe(track.filePath.slice(SPOTIFY_PATH_PREFIX.length), {}, {
      title: track.title, artists: track.artist,
      durationMs: track.duration > 0 ? Math.round(track.duration * 1000) : 0,
    });
  } else {
    const hit = await itunesCrossCheck({
      title: track.title, artist: track.artist, album: track.album,
      durationMs: track.duration > 0 ? Math.round(track.duration * 1000) : 0,
    }).catch(() => null);
    m = hit ? { ...hit, album: itunesAlbum(hit.album) } : {};
  }
  if (blank(m.title) && blank(m.album)) return { ok: false, error: 'No catalogue match found for this track.' };
  const year = Number(String(m.releaseDate || '').slice(0, 4)) || null;
  return {
    ok: true,
    match: {
      title: m.title || '', artist: m.artists || '', album: blank(m.album) ? '' : m.album,
      year: year ? String(year) : '', genre: m.genre || '',
      trackNumber: m.trackNumber ? String(m.trackNumber) : '', discNumber: m.discNumber ? String(m.discNumber) : '',
      explicit: typeof m.explicit === 'boolean' ? m.explicit : undefined,
      coverArt: m.albumArtUrl || '',
    },
  };
}
