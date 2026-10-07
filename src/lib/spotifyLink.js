/* =========================================================================
 *  studio — reading Spotify links
 *
 *  Pulls the first Spotify link out of some text: a web link
 *  (open.spotify.com/track/…, with or without /intl-xx/ or ?si=…), an app
 *  link (spotify:album:…), or a short share link (spotify.link/…), which
 *  main follows to the real one.
 *
 *  Returns { kind: 'track' | 'album' | 'artist' | 'playlist', id },
 *  { kind: 'short', url }, or null.
 * ========================================================================= */

const WEB = /(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|artist|playlist)\/([0-9A-Za-z]{22})/i;
const APP = /spotify:(track|album|artist|playlist):([0-9A-Za-z]{22})/i;
const SHORT = /https?:\/\/spotify\.link\/[0-9A-Za-z]+/i;

export function parseSpotifyLink(text) {
  const s = String(text || '');
  if (!s || s.length > 4000) return null;
  const m = s.match(WEB) || s.match(APP);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  const short = s.match(SHORT);
  return short ? { kind: 'short', url: short[0] } : null;
}
