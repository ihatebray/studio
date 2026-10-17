/* The large version of a cover, for places that show it big (record pages,
 * the full view). Covers saved earlier were often fetched small: Spotify at
 * 300 or 640px, iTunes at 600px. Both CDNs serve the same image at other
 * sizes from the same address with one part changed:
 *   Spotify  i.scdn.co/image/ab67616d<size code><id>  (82c1 is the largest)
 *   iTunes   .../600x600bb.jpg  →  .../1200x1200bb.jpg
 * Anything else (local files, data URLs) is returned unchanged. Use with
 * <HiResImg>, which falls back to the original if the large one fails.
 */
const SPOTIFY = /^(https:\/\/i\.scdn\.co\/image\/ab67616d)(0000b273|00001e02|00004851)([0-9a-f]+)$/i;
const ITUNES = /\/(\d+)x(\d+)bb\.(jpg|png|webp)$/i;

export function hiResCover(url) {
  if (typeof url !== 'string' || !url) return url;
  const s = url.match(SPOTIFY);
  if (s) return `${s[1]}000082c1${s[3]}`;
  const i = url.match(ITUNES);
  if (i && Number(i[1]) < 1200) return url.replace(ITUNES, '/1200x1200bb.$3');
  return url;
}

/** A cover at about the size it's shown: `px` is the largest side it will be
 *  drawn at, in device pixels. Thumbnails in long lists were loading the
 *  largest size the CDN has (around 2000px) for a 40px square, hundreds of
 *  times over; this picks 300, 640 or the largest. Same addresses as above;
 *  anything else is returned unchanged. */
export function coverAt(url, px = 640) {
  if (typeof url !== 'string' || !url) return url;
  const s = url.match(SPOTIFY);
  if (s) return `${s[1]}${px <= 300 ? '00001e02' : px <= 640 ? '0000b273' : '000082c1'}${s[3]}`;
  const i = url.match(ITUNES);
  if (i) { const n = px <= 300 ? 300 : px <= 600 ? 600 : 1200; return url.replace(ITUNES, `/${n}x${n}bb.$3`); }
  return url;
}

/** The one copy of a Spotify or iTunes cover that its colors are read from:
 *  Spotify's 640px, iTunes' 600px. The renderer and the main process both
 *  use it, so a song reads the same pixels whether it holds the web address
 *  or a saved copy (coverArtStore.colorFilePath). Null for anything else. */
const SPOTIFY_ANY = /^https:\/\/(?:i\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com)\/image\/ab67616d(?:0000b273|00001e02|00004851|000082c1)([0-9a-f]+)$/i;
export function colorCover(url) {
  if (typeof url !== 'string' || !url) return null;
  // Spotify serves one cover from several hosts and sizes; all of them read as i.scdn.co's 640px.
  const s = url.match(SPOTIFY_ANY);
  if (s) return `https://i.scdn.co/image/ab67616d0000b273${s[1]}`;
  if (ITUNES.test(url)) return url.replace(ITUNES, '/600x600bb.$3');
  return null;
}

/** CSS background layers: the large cover over the original. If the large
 *  one fails to load, the original underneath shows through. `place` (e.g.
 *  ' center/cover') is repeated on each layer for the `background` shorthand. */
export function coverLayers(url, place = '', px = 0) {
  // `px`: the size it's drawn at (device pixels), for a tile that doesn't need the largest cover.
  const big = px ? coverAt(url, px) : hiResCover(url);
  return big && big !== url ? `url("${big}")${place}, url("${url}")${place}` : `url("${url}")${place}`;
}
