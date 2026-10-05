# studio

A music player for people who still like having a library.

Studio puts your own music files and your Spotify account in one place, so the
stuff you've collected over the years and the stuff you stream sit side by side
in the same albums, playlists and artist pages. It's built to feel like *your*
library rather than a storefront: no ads, no algorithm pushing things at you,
just your music laid out the way you want it.

## What it does

- **One library.** Import your own files and save songs from Spotify. They show
  up together under Songs, Albums and Artists.
- **Spotify playback.** Sign in with your Spotify account (Premium) and play
  anything from it right inside Studio.
- **Lyrics.** Synced lyrics that follow the song, pulled from LRCLIB and Genius.
  If a song doesn't have synced lyrics you can time them yourself with the
  built-in editor, and share any lines as an image.
- **New releases.** Follow artists and Studio keeps track of what they put out,
  including countdowns for albums that haven't dropped yet.
- **Your playlists.** Bring your Spotify playlists over during setup or any time
  after. Names and covers come with them.
- **Make it look how you want.** Six album layouts, colours that follow the
  artwork, a compact mode, rounded fonts or your own.
- **Discord.** Optionally show what you're listening to on your profile.
- **Updates itself.** When a new version is out you'll get a notification and
  can restart into it.

## Download

Grab the latest `studio-Setup.exe` from the
[releases page](https://github.com/ihatebray/studio/releases) and run it. That's
it. Studio walks you through signing in the first time you open it.

Windows only for now. Playing Spotify songs needs a Premium account; everything
else works without one.

## Building it yourself

You'll need Node 18+ and Rust (for the Spotify helper, https://rustup.rs).

```bash
npm install
npm run setup:binaries   # yt-dlp + ffmpeg into ./bin
npm run setup:spotify    # builds the Spotify helper
npm start
```

`npm run make` builds the installer. See [RELEASING.md](RELEASING.md) for how
releases are published.

A dev copy (`npm start`) keeps its data separate from the installed app, so you
can run both.

## How Spotify works in here

Spotify playback goes through `studio-spotify`, a small helper built on
[librespot](https://github.com/librespot-org/librespot). It plays straight to
your speakers; Studio only ever gets song info from it, never the audio, and
nothing is saved to disk.

Studio isn't made by or affiliated with Spotify.

## Project layout

- `src/main/` – Electron main process: the library database, Spotify, lyrics,
  updates
- `src/ui/` – the React app
- `src/lib/` – shared bits (cover colours, search, formatting)
- `studio-spotify/` – the Rust playback helper
