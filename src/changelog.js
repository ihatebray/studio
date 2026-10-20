/* What changed in each version, newest first. Shown in Settings → System →
   Changelog, and as What's new the first time an update opens. Add an entry
   here with every release.

   An entry has either `notes` (a plain list) or `sections`: headed groups
   (New, Changed, Fixed) whose items are a string, or { lead, text, sub }
   where `lead` is set in bold before the text and `sub` is an indented list. */

export const CHANGELOG = [
  {
    version: '0.1.0',
    date: '2026-10-20',
    sections: [
      {
        heading: 'Important Note',
        items: [
          { lead: 'What’s Next', text: 'For the next couple of updates, they will heavily focus on bug fixes, UI polish and smaller refinements to make Studio more consistent and reliable. Bigger features will follow once these foundations are in a great place.' },
        ],
      },
      {
        heading: 'New',
        items: [
          { lead: 'One Album View', text: 'Every album opens in the same view as search, yours or Spotify’s. That includes the Albums tab, Home, Spotify links, countdowns and Go to Album. Choose Dark, Color, Full Color or Immerse right in the view. Auto follows your settings. Album & Playlist layouts have been removed.' },
          { lead: 'Playing From', text: 'The playlist or album you’re playing (through Search or the Home Page) appears beside the artist in the Now Playing bar. Click it to reopen the source with the current song selected. It’s also available from the … menu. This is a work in progress and will be improved over time to work in other areas.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Undo', text: 'Deleting a playlist, removing a song from a playlist or removing a song from the queue now happens immediately without needing confirmation, with Undo available to restore it. Only Clear Library and Delete Everything require confirmation.' },
          { lead: 'Empty Lists', text: 'Empty lists and searches with no matches now share a consistent layout.' },
          { lead: 'Fullscreen', text: 'The tabs now follow the same order as the side panel: Queue, Lyrics, Info.' },
          { lead: 'New Releases', text: 'One-song releases can be played from their row and saved with the button at the end without needing to open them first.' },
          { lead: 'Settings', text: 'Spotify Links and Link Card are now under the Connections tab.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed a playlist song’s menu offering to remove its whole album from your library.',
          'Fixed searching on the Albums page not filtering the albums.',
          'Fixed monthly listeners showing twice on artist pages.',
          'Fixed A LOT more UI inconsistencies and bugs across the entire app, including but not limited to: page views, layouts, buttons, text, menus and more.',
          'Removed unused code in multiple areas.',
        ],
      },
    ],
  },
  {
    version: '0.0.9',
    date: '2026-10-18',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Record Colors', text: 'Studio colors the Now Playing bar, side panel and library pages to match the cover of the song playing. Now you can choose that color yourself, one record at a time.', sub: [
            'Hover the song in the Now Playing bar to see six colors from its cover.',
            'Pick one or choose any color you like with the color wheel.',
            'Your pick is saved for that record and used every time it plays.',
            'Auto goes back to the color Studio picks.',
            'Also in the bar’s … menu. Turn off the hover in Settings → Color.',
          ] },
          { lead: 'Keyboard Shortcuts', text: 'Control playback and the Now Playing bar from your keyboard.', sub: [
            'Press ? to see every shortcut.',
            'Also in Settings → System and next to each item in the … menu.',
          ] },
          { lead: 'Clear Queue', text: 'Empty everything up next in one click from the queue panel. Undo puts the songs back.' },
          { lead: 'Favorites', text: 'Hearting a song plays a little burst of hearts.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Settings', text: 'Clearer and shorter descriptions. Immerse now sits below Dark mode.' },
          { lead: 'Search', text: 'A cleaner start screen. Songs now show up once instead of once per release. Recent searches are hidden for now and will return in a later update.' },
          { lead: 'Dark Mode', text: 'Search, menus and windows now use the same color as the rest of the app.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed local songs skipping to the next song partway through.',
          'Fixed library page colors not matching the Now Playing bar.',
          'Fixed some covers turning the app gray.',
          'Fixed Auto picking yellow, gray or skin tones over a cover’s real color.',
          'Fixed search showing a song from a compilation instead of the artist’s own release.',
          'Fixed the side panel showing two shades when set to Match bar.',
        ],
      },
    ],
  },
  {
    version: '0.0.8',
    date: '2026-10-17',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Blocked Songs', text: 'Keep songs off your stream. Block a song or every song by an artist and chat can’t request it.', sub: [
            'Clean, remix and remastered versions of a blocked song are blocked too.',
            'Manage them in Settings → Connections → Twitch.',
          ] },
          { lead: 'Media Keys', text: 'Play, pause and skip with your keyboard’s media keys. Added Windows media support as well.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Song Requests', text: 'Requests now play in the order they came in.', sub: [
            'Your own Play next still goes first.',
            'Requests stay in line when you play another album or turn on shuffle.',
            'A song that’s already playing or waiting can’t be requested again.',
          ] },
          { lead: 'Performance', text: 'Studio is faster and lighter across the board.', sub: [
            'Immerse is much easier on your graphics card, especially with a game open.',
            'Big libraries and long playlists scroll smoothly.',
            'Covers and artist photos load faster while using less memory.',
            'Search keeps up as you type, even in big libraries.',
            'Local songs start playing sooner.',
          ] },
          { lead: 'Smoother Colors', text: 'Changing the background of the Now Playing bar, side panel or library pages now fades instead of cutting.' },
          { lead: 'Search', text: 'Improved Dark Mode UI.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed Auto colors changing after a restart and songs from the same album getting different colors.',
        ],
      },
    ],
  },
  {
    version: '0.0.7',
    date: '2026-10-15',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Streamer Mode', text: 'Let your Twitch chat pick the music! Viewers type !sr with a song name or a Spotify link, and it plays next.', sub: [
            'Each request pops up as a card showing the song and who asked for it.',
            'Choose who can request and how long viewers wait between requests.',
            'Turn it on in Settings → Connections → Twitch. No Twitch sign-in needed.',
          ] },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Discord Covers', text: 'Covers of saved Spotify songs now reach Discord faster and no longer need an imgbb key.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed Discord showing the original cover after you changed a song’s cover.',
        ],
      },
    ],
  },
  {
    version: '0.0.6',
    date: '2026-10-13',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Dark Mode', text: 'We heard you like dark mode... Try it out by clicking the "Moon" icon in the top bar!' },
          { lead: 'Immerse', text: 'Now also flows behind the Songs, Albums and Artists pages as one gradient across the whole window. It also moves more smoothly and fades in and out instead of cutting to the next.' },
          { lead: 'Poster Layout', text: 'Rebuilt so covers look their best.', sub: [
            'Covers from Spotify are now saved in HD, so they stay sharp at any size.',
            'The cover is placed to keep its subject in view. Drag it to move it, double-click to reset.',
            'Titles stay readable on bright or busy covers.',
          ] },
          { lead: 'Lyric Highlight', text: 'Color the playing line with your accent color. Turn it on from the Lyrics tab.' },
          { lead: 'Playlist Layout', text: 'Playlists can have their own layout, separate from albums. Find it in Settings → Layout.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Smoother', text: 'Starting a song, opening the side panel and switching to compact mode are now animated and no longer stutter.' },
          { lead: 'Layouts', text: 'Cleaned up inconsistencies and removed some layouts.' },
          { lead: 'Discord', text: 'Covers reach Discord faster and arrive together with the song.' },
          { lead: 'Window Moving', text: 'Grab any empty space in the top bar to move the window.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed lyrics bouncing as the line changed.',
          'Fixed the … menu getting cut off and not closing when clicking elsewhere.',
          'Fixed faint bands behind the cover in fullscreen.',
          'Fixed the visualizer flickering when opening search.',
          'Fixed many more UI inconsistencies.',
        ],
      },
    ],
  },
  {
    version: '0.0.5',
    date: '2026-10-12',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Playing Indicator', text: 'Choose how the playing song is marked in every list: Bars, Beacon or Signal. Find it in Settings → Layout.' },
          { lead: 'Discord Setup', text: 'Setup now walks you through connecting Discord, step by step.' },
          { lead: 'Artist Links', text: 'Click an artist’s name in the Now Playing bar or on Home to open their page.' },
          { lead: 'Scrolling Titles', text: 'Long song titles scroll in the Now Playing bar.' },
        ],
      },
      {
        heading: 'Changed',
        items: [
          { lead: 'Page Headers', text: 'Every tab now shares one clean header, with less empty space above it.' },
          { lead: 'Spotify Links', text: 'Copied links now show up in Studio almost instantly.' },
          { lead: 'Discord Settings', text: 'Moved to Settings → Connections.' },
        ],
      },
      {
        heading: 'Fixed',
        items: [
          'Fixed the playing song not being marked in My Spotify, on artist pages and in search.',
          'Fixed extra space between the controls and Popular on artist pages.',
        ],
      },
    ],
  },
  {
    version: '0.0.4',
    date: '2026-10-09',
    sections: [
      {
        heading: 'New',
        items: [
          { lead: 'Playback', text: 'Songs on artist pages and in search can now be played without being saved to your library.' },
          { lead: 'Unreleased Songs', text: 'Songs that aren’t out yet are shown but locked. They can’t be played or saved until their release date.' },
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
