/* What changed in each version, newest first. Shown in Settings → System →
   Changelog, and as What's new the first time an update opens. Add an entry
   here with every release.

   An entry has either `notes` (a plain list) or `sections`: headed groups
   (New, Changed, Fixed) whose items are a string, or { lead, text, sub }
   where `lead` is set in bold before the text and `sub` is an indented list. */

export const CHANGELOG = [
  {
    version: '0.0.4',
    date: '2026-10-09',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Playback', text: 'Songs on artist pages and in search can now be played without being saved to your library.' },
          { lead: 'Unreleased Songs', text: 'Songs that aren\'t out yet are shown but locked. They can\'t be played or saved until their release date.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Artist Pages and Albums', text: 'Slightly redesigned to match the rest of Studio.' },
          { lead: 'Previews', text: 'Song previews have been removed. Songs now play in full.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed Genius lyrics taking priority over synced lyrics from LRCLIB (i hope).',
          'Fixed slow Discord status updates and custom covers not loading.',
          'Fixed Discord covers that failed to upload never being retried.',
          'Fixed songs pausing for long stretches with a "slowing playback" notice. Studio now reconnects to Spotify right away.',
          'Fixed songs with the same title on different albums, such as live versions, being marked as saved. Search now shows both versions instead of one.',
          'Fixed artist pages stuttering when you start to scroll.',
          'Fixed many more UI inconsistencies.',
        ],
      },
    ],
  },
  {
    version: '0.0.3',
    date: '2026-10-07',
    sections: [
      {
        heading: 'New',
        items: [
          {
            lead: 'Open Spotify links in Studio',
            text: 'You can now COPY a Spotify link from anywhere (Discord, your browser, a message) and a card will pop up in Studio automatically showing the cover, title and artist, with buttons to play it or save it to your library. It works for songs, albums, playlists and artists.',
            sub: [
              'Clicking a link still opens it in your browser or the Spotify app. Studio only picks up links you copy.',
              'You can also paste the link in the search bar for instant results.',
              'Choose how the card looks or turn this off in Settings → Library → Spotify Links.',
            ],
          },
          'Playlists now have buttons to jump to the top and/or bottoms of the playlists.',
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Moved Spotify Imports', text: 'Bringing over your Spotify playlists and Liked Songs now live in the + next to Playlists in the sidebar.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed numerous UI inconsistencies.',
          'Fixed numerous notification bugs.',
        ],
      },
    ],
  },
  {
    version: '0.0.2',
    date: '2026-10-05',
    notes: [
      'Removed Import song cap of 300 for Playlists and Liked Songs',
      'Imports Save Faster',
    ],
  },
  {
    version: '0.0.1',
    date: '2026-10-05',
    title: 'First release',
    notes: [
      'Your own music and your Spotify account in one library',
      'Synced lyrics, with a built-in editor for timing them yourself',
      'New releases and album countdowns for the artists you follow',
      'Bring your Spotify playlists over in a couple of clicks',
      'Lots of ways to make it look how you want: layouts, colors, fonts',
      'Studio now updates itself when a new version is out',
    ],
  },
];

const parts = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
const compare = (a, b) => {
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};

/** The versions What's new shows: newer than `seen`, up to `current`.
 *  Nothing seen yet means just `current`. */
export function changelogSince(seen, current) {
  return CHANGELOG
    .filter((v) => compare(v.version, current) <= 0 && (seen ? compare(v.version, seen) > 0 : compare(v.version, current) === 0))
    .map((v) => v.version);
}
