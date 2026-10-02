/* =========================================================================
 *  studio — what a Spotify song was played from (renderer)
 *
 *  My Spotify's pages note, when they start playback, which album, playlist,
 *  artist or mix each song came from, plus the ids a library row doesn't
 *  carry (artist and album ids). The player reads it back when a play
 *  counts, for Studio's listening history (listening.js), which is what
 *  Home's "Jump back in", "On repeat" and the rest are built from.
 * ========================================================================= */

const bySong = new Map();
const MAX = 2000;

/** rows: Spotify track rows ({ spotifyId, artistIds, albumId, … });
 *  context: { kind, id, name, sub, image } or null. */
export function notePlayContext(rows, context = null) {
  for (const r of rows || []) {
    if (!r?.spotifyId) continue;
    bySong.delete(r.spotifyId);
    bySong.set(r.spotifyId, {
      context: context && context.kind && context.id ? context : null,
      artistIds: Array.isArray(r.artistIds) ? r.artistIds : [],
      albumId: r.albumId || null,
      album: r.album || '',
      artists: r.artists || '',
      albumArtUrl: r.albumArtUrl || null,
    });
  }
  while (bySong.size > MAX) bySong.delete(bySong.keys().next().value);
}

export const playContextFor = (spotifyId) => bySong.get(spotifyId) || null;
