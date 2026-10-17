/* Streamer Mode's block list: songs and artists chat can't request.
 *
 * An entry is { kind: 'song', spotifyId, title, artist, image } or
 * { kind: 'artist', name }. A song is matched by its Spotify ID first, then
 * by title and artist, so the clean version, a remaster or a re-upload of the
 * same song is caught too. Titles drop anything in brackets and anything
 * after " - ", which is where Spotify puts "Remastered", "Remix" and "feat.". */

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function normTitle(s) {
  return fold(s)
    .replace(/\s+-\s+.*$/, '')
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/\b(feat|ft|with)\.?\s.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const normArtist = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();

/** Every credited artist, from a Spotify row ("A, B") or a library track. */
export function artistsOf(t) {
  const raw = [t?.artists, t?.artist, t?.albumArtist].filter(Boolean).join(', ');
  return raw.split(/\s*(?:,|&|\bfeat\.?\s|\bft\.?\s)\s*/i).map(normArtist).filter(Boolean);
}

const idOf = (t) => t?.spotifyId && !String(t.spotifyId).startsWith('itunes:') ? String(t.spotifyId) : '';

/** The block-list entry that stops this song, or null. */
export function blockedBy(list, t) {
  if (!Array.isArray(list) || !list.length || !t) return null;
  const id = idOf(t);
  const title = normTitle(t.title);
  const artists = artistsOf(t);
  for (const b of list) {
    if (b?.kind === 'artist') {
      const name = normArtist(b.name);
      /* A name with a comma in it ("Tyler, The Creator") gets split like a
         list of artists, so it's looked for as a whole phrase instead. */
      if (artists.includes(name) || (/,/.test(b.name) && ` ${artists.join(' ')} `.includes(` ${name} `))) return b;
    } else if (b) {
      if (id && b.spotifyId && b.spotifyId === id) return b;
      if (title && normTitle(b.title) === title) {
        const theirs = artistsOf({ artist: b.artist });
        if (!theirs.length || theirs.some((a) => artists.includes(a))) return b;
      }
    }
  }
  return null;
}

export function songEntry(t) {
  return {
    kind: 'song',
    spotifyId: idOf(t),
    title: String(t?.title || '').trim(),
    artist: String(t?.artists || t?.artist || '').trim(),
    image: t?.albumArtUrl || (/^https?:/.test(String(t?.coverArt || '')) ? t.coverArt : '') || '',
  };
}

export const artistEntry = (name) => ({ kind: 'artist', name: String(name || '').trim() });

export const sameEntry = (a, b) => a?.kind === b?.kind && (a.kind === 'artist'
  ? normArtist(a.name) === normArtist(b.name)
  : (a.spotifyId && a.spotifyId === b.spotifyId) || (normTitle(a.title) === normTitle(b.title) && normArtist(a.artist) === normArtist(b.artist)));

export const entryLabel = (b) => (b?.kind === 'artist' ? b.name : `${b.title}${b.artist ? ` by ${b.artist}` : ''}`);
