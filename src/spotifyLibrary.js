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

import { partnerState, trackById, findTrack, likeTracks } from './spotifyPartner.js';
import { upsertTracks, idsForFilePaths } from './libraryDb.js';

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

/** Library row for one catalogue track. Caller supplies the display fields it
 *  already has; anything missing comes from Spotify. */
async function rowFor(meta) {
  let id = realId(meta?.spotifyId);
  let info = null;
  if (!id) {
    info = await findTrack(meta?.title, meta?.artists, Number(meta?.durationMs) || 0);
    if (!info) return { error: `Couldn't find "${meta?.title || 'this track'}" on Spotify.` };
    id = info.spotifyId;
  } else if (!meta?.title || !meta?.album || !meta?.albumArtUrl || !(Number(meta?.durationMs) > 0)) {
    info = await trackById(id).catch(() => null);
  }
  const pick = (k) => (meta?.[k] != null && meta[k] !== '' ? meta[k] : info?.[k]);
  const durationMs = Number(pick('durationMs')) || 0;
  const releaseDate = String(pick('releaseDate') || '');
  const year = Number(meta?.year) || Number(releaseDate.slice(0, 4)) || null;
  const art = String(pick('albumArtUrl') || '');
  return {
    id,
    track: {
      filePath: streamedPathFor(id),
      title: String(pick('title') || 'Unknown Title'),
      artist: String(pick('artists') || 'Unknown Artist'),
      album: String(pick('album') || 'Unknown Album'),
      duration: durationMs > 0 ? durationMs / 1000 : 0,
      coverArt: art || null,
      coverArtUrl: art || null,
      trackNumber: pick('trackNumber') ?? null,
      discNumber: pick('discNumber') ?? null,
      year,
      explicit: typeof pick('explicit') === 'boolean' ? pick('explicit') : null,
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
  try { liked = await likeTracks(rows.map((r) => r.id)); } catch (e) { likeError = String(e?.message || e); }
  if (likeError) console.warn('[save] library saved, but hearting on Spotify failed:', likeError);

  return { ok: true, tracks: rows.map((r) => r.track), failed, liked, likeError };
}

/** One track, in the { ok, track, error } shape Get's callers already expect. */
export async function saveSpotifyTrack(meta) {
  const r = await saveSpotifyTracks([meta]);
  if (!r.ok) return { ok: false, error: r.error, noPicker: true };
  return { ok: true, track: r.tracks[0], likeError: r.likeError };
}
