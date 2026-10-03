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

/** CSS background layers: the large cover over the original. If the large
 *  one fails to load, the original underneath shows through. `place` (e.g.
 *  ' center/cover') is repeated on each layer for the `background` shorthand. */
export function coverLayers(url, place = '') {
  const big = hiResCover(url);
  return big && big !== url ? `url("${big}")${place}, url("${url}")${place}` : `url("${url}")${place}`;
}
