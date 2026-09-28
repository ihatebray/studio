# studio — redesign pass against the implementation brief

Worked in the brief's order. Files touched: `accentTokens.js` (new),
`HomeReleases.jsx` (new), `StudioHome.jsx`, `StudioOnboarding.jsx`,
`StudioShell.jsx`, `App.jsx`, `ArtistGrid.jsx`, `StatsPage.jsx`,
`InstantSearch.jsx`.

## 1. Tokens and primitives — `accentTokens.js`

The accent follows the music. `deriveAccent()` takes the colour the page tint
already uses (`sampleCoverTheme` → `barSource`, or the most-saturated swatch),
raises lightness until it clears 4.5:1 on `#0A0A0B`, and caps saturation.
It returns a `fill` for filled controls, a lighter `line` for text, icons,
rings and thin bars, and a computed `ink` (near-black or near-white) for
labels on the fill.

- `applyAccent()` cross-fades the CSS variables over ~400ms on track change,
  by tweening `:root` custom properties rather than re-rendering. Respects
  `prefers-reduced-motion`.
- Idle holds the last track's accent (`studio:lastAccent`); a cold start falls
  back to a soft coral, so the UI is never colourless at first launch.
- Colour intensity governs the accent: `off` drains it to grey, `full` uses
  full strength.
- Fixed roles never follow artwork: success `#7BE0B0`, danger `#FF8B8B`,
  and the surface scale.
- `TOKENS_CSS` carries the surface tokens, the radius scale, buttons, inputs,
  toggle, segmented control, progress bar, badges, and a visible
  `:focus-visible` ring on every focusable element. It is mounted by
  `StudioMotionStyles`, so onboarding and the app share one sheet.
- The old `const accent = '255, 255, 255'` and the stock-green toggle constant
  are gone.

## 2. The container-height bug

The content card only reserves the Now Playing bar's space when the bar is
mounted (`--np-reserve`: 16px gutter, or 16 + 86 bar + 12 gap). The card, the
sidebar and the bar now share one geometry, so the black band, the sliced
rows and the clipped "Show all 8 songs" button all come from one rule.

## 3. App shell

Wordmark at the top left, Home and Stats as 38px tabs with a filled chip when
active, settings gear pushed right. Sidebar is 236px with a LIBRARY eyebrow
above Songs/Albums/Artists and a PLAYLISTS eyebrow with its add button and
playlist rows. The Active tab marker setting (chip, bar, underline, dot) drives
the sidebar.

## 4. Now Playing bar

Detached 86px card, 16px radius, aligned to the content card with a 12px gap.
Three zones: 282px artwork/title/artist, a flexible centre with the transport
and the scrubber directly beneath it at 420px, and 282px of three clusters —
track actions, context, then volume with a click-to-mute speaker. Copy link,
Immerse, the expanded player and the per-record colour tray moved into the
overflow menu. The "Hey! Don't like this color?" toast and its handle are gone.
Every icon button has an `aria-label` and a tooltip.

## 5. Shared song table and detail pages

Album pages drop the ALBUM column and, when every track shares an artist, the
per-row artist; the freed space becomes a PLAYS column when Settings → Library
→ Play counts is on. Playlists keep both columns. The duration header reads
TIME, right-aligned with tabular numerals. Row height comes from
Settings → Layout → List density. "Add" is now "Import", and only Play all
carries the accent fill. The detail action row has a 48px/12px play button,
a labelled "Find in album" field, and destructive delete in the overflow.

## 6. Home — `HomeReleases.jsx`

Two columns, no greeting and no page title. Left: New Releases with a live
downloading count, a "Checked …" timestamp, a refresh button that spins while
polling, an All / Not downloaded filter with counts, and Manage follows. Rows
are 74px under THIS WEEK / EARLIER THIS MONTH headings, and each carries its
download state — Not downloaded → Download, "4 of 10 downloaded" → Finish
download in the accent, "All 16 downloaded" in success green → Play. Clicking
a row expands it in place: per-track state (In library, a live percentage,
Queued, or Download), truncated to seven with "Show all n tracks". Right rail:
a compact Shuffle everything, a 2×3 Jump back in grid scoped to the last seven
days, and On repeat this week ranked by plays. Nothing scrolls sideways.

## 7. Settings

Every row is a description plus a fixed 320px right-aligned control column,
segmented controls filling it at equal widths. Naked rows with hairline
dividers; cards only for the danger zone and the connection blocks. Playback
and Discord merged into one System page with PLAYBACK and DISCORD
sub-headings — the nav is now Appearance (Color, Layout, Library) and System
(System, Connections). Color gains an Accent row (Follow artwork / Fixed, with
four swatches). Library gains Play counts in lists. Connections caps the
credential fields at 420px, adds Connected / Not connected pills, fills the
Save buttons with the accent, and renames "Replay setup" to "Run setup again"
with the DEV badge dropped.

## 8. Artists, Albums

Artists is a tile grid matching Albums: circular 148px artwork (a portrait,
not a control), the name, and one line reading "9 songs · 108 plays". The
mini-bars are gone and sorting defaults to most played. Albums uses
`auto-fill, minmax(180px, 1fr)`, captions read "Artist · 7 tracks", the page
subtitle reads "12 in your library", and a play button fades in over the
artwork's lower right on hover.

## 9. Stats

A 192px streak ring replaces the flame and its linear bar, with the count at
56px in its centre, a DAY STREAK eyebrow, and "10 days to 100" under the card.
The four summary figures are a 2×2 tile grid. Top Artists gains the same bar
as Top Songs and Top Genres, so one ranked-row pattern is used three times;
bars take the accent and the top-three colour ramp is gone. Tier copy reads
"60 days" and "100 days" rather than "Two months" and "Hundred days".

## 10. Search palette

Enter now acts on the highlighted row (plays an owned track, opens an album or
artist); filtering the library moved to Tab, and the footer hints say so.
Shift+Tab still accepts an artist as a scope. The band shows eight rows instead
of three, the "1–3 of 6" counter and its prev/next chevrons are gone in favour
of a plain count, the green per-row Play buttons became one accent PLAY chip on
the highlighted row, and the scrim is 60% black with a light blur. The
Fast / Best toggle is labelled "Quality".

## 11. Onboarding

The four feature cards are a 2×2 grid of equal-height cards with icon tiles in
the accent family. The glow on the wordmark and the Let's go button is halved.
The Spotify step's primary button takes the full accent when the fields
validate and a genuinely dim state when they do not; the five-step instructions
collapse by default; the step indicator sits next to the card; the corner
"Skip setup" is gone and the inline "Skip for now" is the one escape hatch.

## 12. Defects

- Elapsed 0:00 on a paused, loaded track: `App.jsx` now reads the audio
  element's real position on pause, seek and metadata load.
- Blue text-selection highlight: `user-select: none` on every list row.
- No focus ring anywhere: a `:focus-visible` ring in the accent, with white as
  the fallback on tinted pages (`.st-tinted`).
- Album name repeated on its own album page: context-aware columns, above.
- Content card / clipped rows / clipped button: the height fix, above.
- Colour toast overlapping the window corner: removed.

## Behaviour changes flagged in the brief

All three are implemented as the brief describes. Say the word if you want any
of them reverted:

1. Enter plays the highlighted row in the search palette; Tab filters.
2. Playback and Discord are one System page.
3. Download actions replace Play on releases you do not own.

## Still open

- **Discord "Hide when paused"** is implemented for real (`App.jsx` clears the
  activity while paused). **"Resume where you left off"** from the System
  mockup is *not* built — the app has no saved-position feature, and I did not
  want to add a switch that does nothing.
- The artist page (`ArtistPage.jsx`) got the shared token and radius work but
  not its own pass: "Edit header" is still in the action row rather than the
  overflow, the header/body gradient seam is unchanged, and the Albums column
  on the right is not added.
- The header tint ramp (fade to the base surface over ~360px) is unchanged on
  album and playlist pages.
- Nothing here has been run. I had no way to launch Electron, so this is
  reviewed by reading and parse-checked only — expect to shake out layout
  details on the first run, particularly the Home two-column page and the
  Settings control column.
