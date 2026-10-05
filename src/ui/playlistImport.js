/* =========================================================================
 *  studio — bring one Spotify playlist into Studio
 *
 *  Used by setup's playlist step and by Import from Spotify. Reads the
 *  playlist through the signed-in Spotify account (the helper), adds its
 *  songs to the library as streamed tracks (nothing is downloaded), and
 *  makes a Studio playlist with the same name and cover.
 *
 *  item: { id, kind: 'playlist' | 'liked', name, cover?, image? }
 *  say(text, kind): progress for the row ('' | 'ok' | 'bad')
 *  Returns the number of songs added, or 0 when nothing could be.
 * ========================================================================= */

export function playlistIdFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{16,}$/.test(s) ? s : '';
}

export async function importSpotifyPlaylist(a, item, { onCreatePlaylist, onAddTracksToPlaylist, say = () => {} }) {
  say('Reading…');
  // Every song, not the first 300 the My Spotify page shows.
  const r = item.kind === 'liked' ? await a.spotifyFeedLiked({ all: true }) : await a.spotifyFeedPlaylist(item.id, { all: true });
  const songs = ((r?.ok ? r.data : []) || []).filter((x) => x?.spotifyId);
  if (!songs.length) { say(r?.ok ? 'Empty' : 'Couldn’t read', 'bad'); return 0; }
  const ids = [];
  for (let i = 0; i < songs.length; i += 100) {
    say(`${Math.min(i, songs.length)} / ${songs.length}`);
    const res = await a.saveSpotifyMany(songs.slice(i, i + 100));
    for (const t of res?.tracks || []) if (t?.id != null) ids.push(t.id);
  }
  if (!ids.length) { say('Couldn’t save', 'bad'); return 0; }
  const pl = await onCreatePlaylist?.({ name: item.name || 'Spotify playlist', coverArt: item.cover || item.image || null });
  if (!pl?.ok || pl.id == null) { say('Couldn’t create', 'bad'); return 0; }
  await onAddTracksToPlaylist?.(pl.id, ids);
  say(`${ids.length} songs ✓`, 'ok');
  return ids.length;
}
