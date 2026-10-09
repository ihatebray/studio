import React from 'react';
import { pageTone, pageWash, readableAccent, recordDeep, recordWashSource } from '../../lib/coverTheme.js';
import { formatTime, formatTotalMs } from '../../lib/mediaUtils.js';
import ArtistGrid from '../ArtistGrid.jsx';
import ArtistPage from '../ArtistPage.jsx';
import { ExplicitBadge, PauseIcon, PlayIcon } from '../sharedUI.jsx';
import { PlayingBars } from './common.jsx';
import { DetailAction, LibHeader, LibRow, RowPlayButton } from './Library.jsx';
import RecordPage, { isAllCaps, recordLayoutOf } from './RecordPage.jsx';
import { coverLayers } from '../../lib/coverUrl.js';
import ScrollJump from './ScrollJump.jsx';

export default function LibraryPage({
  LIB_OVERSCAN,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
  LIB_ROW_H,
  accent,
  autoRgb,
  canManage,
  compactMode,
  coverFor,
  coverOverride,
  currentTrack,
  detailAlign,
  detailData,
  detailFilter,
  detailGenres,
  detailMore,
  detailTheme,
  detailTracks,
  dlProgress,
  dlState,
  downloadSpotifyRow,
  filteredLibArtists,
  fmtAdded,
  immerse,
  importing,
  isFollowing,
  isPlaying,
  libAlbums,
  libArtists,
  libAzIndex,
  libDetail,
  libFilter,
  libRowSort,
  libRows,
  libRowsRef,
  libScrollElRef,
  libScrollRef,
  libScrollTop,
  libSortField,
  libTitle,
  libView,
  libViewH,
  library,
  mySpotifyBridge,
  npWashTheme,
  onImportFiles,
  onImportFolder,
  onPlayTrack,
  onRemoveFromPlaylist,
  onToggleFavorite,
  onTogglePlay,
  onUpdateAlbumMetadata,
  openAlbumFromRow,
  openArtist,
  openArtistAnywhere,
  openArtistFromRow,
  openPalette,
  openRowMenu,
  ownedTrackFor,
  pickLibRowSort,
  pickSection,
  playCountFor,
  playEvents,
  playFromLibRows,
  setAlbumEditScope,
  setDeletePl,
  setDetailFilter,
  setDetailMore,
  setLibDetail,
  setLibFilter,
  setLibScrollTop,
  setPlCoverFor,
  setRenamePl,
  setSetCat,
  showDateAdded,
  showPlayCounts,
  theme,
  toggleFollow,
}) {
  // The classic playlist view's song list, for its top/end arrows.
  const classicScrollRef = React.useRef(null);
  const view = libView;
  /* The hero shows the LIBRARY, always — not the playing track. The
     Now Playing bar already reports that, and two places saying the
     same thing is what made this feel off. */
  /* Album, playlist AND artist pages all own the whole wrapper: they
     paint their own wash to the corners and supply their own inset.
     Keyed on detailData alone this missed the artist page, which then
     rendered inside the list view's 26px inset with the library's
     now-playing wash bleeding through behind it. */
  const detailPage = !!detailData || !!openArtist;
  /* Colour follows the music; the header doesn't.
     Which colour depends on the chosen extraction — the mean of the
     whole cover, or the most prominent colour actually in it. */
  /* 'fixed' skips sampling entirely — the page is the colour you
     chose, whatever is playing. */
  /* Immerse is the bar and the panel — the chrome around the music.
     The library pages stay black under it: they're a list you read,
     and a moving gradient behind three hundred rows competes with
     the thing it's meant to frame. */
  const pageMode = detailPage || immerse ? 'off' : theme.pageSurface;
  const wrapperFixed = pageMode === 'colour';
  const usesCover = pageMode === 'cover' || pageMode === 'coverFull';
  const npWashOn = currentTrack && usesCover && npWashTheme;
  /* The page follows the chrome, not the other way round.
     On auto these are two views of one sampled colour: the bar gets
     barTone() and sits pinned at 0.24 lightness, the page keeps the
     sleeve's own lightness and lands well above it. That gap is the
     whole effect — the surfaces read as related rather than as one
     flat field.
     A manual pick has no sampled source behind it. The pick IS the
     bar, so the page is derived from it with pageTone(), which lifts
     lightness while leaving hue and saturation alone. Using the pick
     raw here (what it did before) gave the page and the chrome the
     same value and collapsed the gap. */
  const npWashRgb = wrapperFixed
    ? theme.pageColour
    : (coverOverride
      ? pageWash(pageTone(coverOverride))
      : (npWashOn ? pageWash(autoRgb) : null));
  /* Aurora needs several colours at once. Any cover that yielded only
     one falls back to a single bloom rather than an empty layer. */
  const npAurora = (npWashOn && theme.coverColour === 'aurora'
    ? (npWashTheme.palette || []).slice(0, 4).map((c) => pageWash(c))
    : []);
  const rows = libRows;
  /* The docked Queue / Lyrics / Info panel used to force the search
     onto a row of its own, because the old header couldn't fit a
     title, a profile line, a search field and two actions side by
     side. The 52px bar can: it drops the count first, then the
     action labels, and keeps working down to a very narrow column —
     so the second layout is gone rather than maintained. */
  // playFromLibRows reads this so the queue matches what's on screen.
  libRowsRef.current = rows;
  const totalMs = rows.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
  const acc = readableAccent(accent);
  return (
    <div className="sth-libpage" style={{
      display: 'flex', gap: 16, minHeight: 0, height: '100%',
      position: 'relative',
      /* Detail pages paint edge-to-edge (their own wash reaches the
         corners); list views need the inset the wrapper used to
         provide before is-page zeroed it. */
      /* 10px, not 18px. With the header no longer padding itself out
         to 52px, the wrapper's own inset was the remaining source of
         the gap above the title. */
      /* Compact drops the page title (see .is-compact .sth-libhead-tw),
         so the top inset tightens with it and the controls row
         becomes the first thing in the card. */
      padding: detailPage ? 0 : (compactMode ? '14px 24px 16px' : '28px 28px 20px'),
      boxSizing: 'border-box',
    }}>

      {/* ---- Now-playing wash ----
          A SOLID colour gradient, exactly like the album and playlist
          pages — not the blurred artwork. Same pageWash() treatment
          of the same sampled tone, so all three surfaces are the same
          colour system rather than two that resemble each other.
          Fades out by the tracklist since this is a list, not a
          record page that owns its whole background. */}
      {npWashRgb ? (
        <>
          {/* The constant tint. The gradient above it used to stop
              dead at 430px — a line unrelated to anything on screen —
              so the colour now continues underneath at low strength
              and the fade reads as a falloff rather than an edge.
              'full' turns this up and drops the gradient, which is
              how the album and artist pages paint. */}
          <div key={`tint-${npWashRgb}`} aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: wrapperFixed
              ? `rgb(${npWashRgb})`
              /* Full colour is the wash at full strength, not 62% of
                 it. The bar paints the same wash solid, so anything
                 under 1 guaranteed the page sat darker than the bar
                 showing the identical colour — 62% of a colour over
                 black is 62% of its brightness. Fade stays a trace,
                 because that one is meant to read as a hint. */
              : `rgba(${npWashRgb},${pageMode === 'coverFull' ? 1 : 0.16})`,
            animation: 'stFadeIn 0.6s ease both',
          }} />
          {pageMode !== 'coverFull' && !wrapperFixed ? (
            <div key={npWashRgb} aria-hidden style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 430, zIndex: 0, pointerEvents: 'none',
              background: npAurora.length > 1
                ? npAurora.map((c, i) => {
                  const spots = ['12% 0%', '86% 10%', '34% 46%', '96% 62%'];
                  const sizes = ['62% 58%', '54% 52%', '58% 48%', '48% 44%'];
                  return `radial-gradient(${sizes[i]} at ${spots[i]}, rgba(${c},0.80) 0%, rgba(${c},0) 100%)`;
                }).join(', ')
                : `linear-gradient(180deg, rgba(${npWashRgb},0.85) 0%, rgba(${npWashRgb},0.55) 26%, rgba(${npWashRgb},0.30) 58%, rgba(${npWashRgb},0) 100%)`,
              WebkitMaskImage: npAurora.length > 1 ? 'linear-gradient(180deg, #000 0%, #000 46%, transparent 100%)' : 'none',
              maskImage: npAurora.length > 1 ? 'linear-gradient(180deg, #000 0%, #000 46%, transparent 100%)' : 'none',
              animation: 'stFadeIn 0.6s ease both',
            }} />
          ) : null}
        </>
      ) : null}

      {/* ---- Rail ---- */}
      {/* Hairline between the rail and the table — without it the two
          columns read as one loose block of text. */}
      {/* The library's own rail was removed — the persistent
          sidebar on the left of the app replaces it, so the
          content wrapper keeps its full width here. */}

      {/* ---- Content ---- */}
      {openArtist ? (
        /* ---- Artist page ----
           Full-bleed like the album page, and for the same reason:
           it owns the whole content wrapper rather than sharing it
           with a list it came from. */
        <ArtistPage
          artist={openArtist}
          accent={accent}
          theme={theme}
          playEvents={playEvents}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onPlayTrack={onPlayTrack}
          onTogglePlay={onTogglePlay}
          onOpenAlbum={(key) => setLibDetail({ kind: 'album', key })}
          onJumpToFind={openPalette}
          spotifyBridge={mySpotifyBridge}
          onBack={() => setLibDetail(null)}
          following={isFollowing(openArtist)}
          onToggleFollow={() => toggleFollow(openArtist)}
          hasArtist={(n) => libArtists.some((a) => a.key === String(n || '').toLowerCase())}
          onConnectSpotify={() => { pickSection('settings'); setSetCat('connections'); }}
          onOpenRelated={(r) => openArtistAnywhere({ name: r.name, spotifyId: r.id, image: r.image })}
          dlState={dlState}
          dlProgress={dlProgress}
          onGetTrack={downloadSpotifyRow}
          ownedTrackFor={ownedTrackFor}
        />
      ) : detailData ? (
        /* ---- Album / playlist page ----
           FULL-BLEED: the library rail hides while this is open, so
           the page owns the whole content wrapper. It used to be a
           third column beside the rail, which squeezed the tracklist
           and left the artwork no room — that's why it read as
           cramped next to the reference. */
        (() => {
          const dt = detailTheme;
          /* The page's colour comes from the RECORD being viewed, not
             from `accent` — that's sampled from whatever is currently
             playing, so opening an album while a different song ran
             painted the page in the wrong record's colour. */
          /* 'fixed' uses the colour you chose; 'cover' samples the
             artwork. Both go through pageWash so a fixed pick gets
             the same saturation/lightness treatment and can't be set
             to something unreadable. */
          const wash = theme.detailMode === 'fixed'
            ? pageWash(theme.detailColor)
            /* Was `dt.mid || dt.accent` — the PREVIOUS colour
               engine's average, written out inline here while the
               now-playing bar had long since moved to the
               perceptual one. On artwork the average handles badly
               the two disagree completely, which is how a
               near-black sleeve ended up on a muddy blue page.
               recordWashSource takes the current engine's answer
               and is shared with the grid cards. */
            : pageWash(dt ? recordWashSource(dt) : accent);
          /* Derived from the wash source, not from dt.wash. The
             page lays the wash over this at 0.28 alpha by the
             bottom, so `deep` is most of what's visible down there
             — reading it off the old engine's average while the
             wash came from the new one left the lower half of every
             page painted in the wrong colour. */
          const deep = dt ? recordDeep(dt) : '10, 10, 14';
          const pageAcc = dt ? dt.accent : accent;
          const pageAccUI = readableAccent(pageAcc);
          const recordLayout = recordLayoutOf(detailData.kind === 'playlist' ? (theme.playlistLayout ?? theme.recordLayout) : theme.recordLayout);
          if (recordLayout !== 'classic') {
            const isPl = detailData.kind === 'playlist';
            return (
              <RecordPage
                layout={recordLayout}
                data={detailData}
                tracks={detailTracks}
                wash={wash}
                deep={deep}
                accUI={pageAccUI}
                palette={theme.detailMode === 'fixed' ? [] : (dt?.palette || []).slice(0, 4).map((c) => pageWash(c))}
                genres={detailGenres}
                libDetailKey={libDetail.key}
                currentTrack={currentTrack}
                isPlaying={isPlaying}
                onPlayTrack={onPlayTrack}
                onTogglePlay={onTogglePlay}
                onToggleFavorite={onToggleFavorite}
                onRemoveFromPlaylist={onRemoveFromPlaylist}
                canManage={canManage}
                openRowMenu={openRowMenu}
                coverFor={coverFor}
                playCountFor={playCountFor}
                showPlayCounts={showPlayCounts}
                libAlbums={libAlbums}
                libArtists={libArtists}
                onOpenAlbum={(key) => setLibDetail({ kind: 'album', key })}
                onOpenArtist={(key) => setLibDetail({ kind: 'artist', key })}
                onBack={() => setLibDetail(null)}
                onChangeCover={isPl ? () => setPlCoverFor(libDetail.key) : null}
                onEditAlbum={!isPl && onUpdateAlbumMetadata ? () => setAlbumEditScope({
                  key: libDetail.key,
                  album: detailData.title,
                  artist: detailData.by,
                  coverArt: detailData.art,
                  sampleTrack: detailData.tracks[0],
                  trackIds: detailData.tracks.map((t) => t.id),
                  discNumber: null,
                }) : null}
                onEditPlaylist={isPl ? () => setRenamePl({ id: libDetail.key, name: detailData.title }) : null}
                onDeletePlaylist={isPl ? () => setDeletePl({ id: libDetail.key, name: detailData.title }) : null}
                moreOpen={detailMore}
                setMoreOpen={setDetailMore}
                bridge={mySpotifyBridge}
                fullAlbum={theme.albumSongs === 'full'}
                onPlayNext={onPlayNext}
                onAddToQueue={onAddToQueue}
                onAddToPlaylist={onAddToPlaylist}
              />
            );
          }
          /* Same columns for both kinds now. The album name earns a
             column once the artwork is stated once in the header
             instead of repeated on every row. */
          /* Brief, Detail pages: stop repeating what the page already
             said. On an album the ALBUM column goes entirely, and the
             per-row artist goes when every track shares one; the freed
             space becomes a PLAYS column when that setting is on. A
             playlist genuinely needs artist and album, so it keeps both. */
          const oneArtist = detailData.kind === 'album'
            && new Set(detailData.tracks.map((t) => (t.artist || '').toLowerCase())).size <= 1;
          const showAlbumCol = detailData.kind !== 'album';
          const showPlaysCol = showPlayCounts && detailData.kind === 'album';
          const cols = [
            '44px',
            'minmax(200px,2.4fr)',
            showAlbumCol ? 'minmax(140px,1.5fr)' : null,
            showPlaysCol ? '72px' : null,
            '72px',
            '52px',
          ].filter(Boolean).join(' ');
          const totalMs = detailData.tracks.reduce((n, t) => n + (Number(t.duration) || 0) * 1000, 0);
          const tilePal = detailData.mosaic && theme.detailMode !== 'fixed' && (dt?.palette || []).length > 1
            ? [0, 1, 2, 3].map((i) => pageWash(dt.palette[i] || dt.palette[0]))
            : null;
          return (
            <div style={{
              position: 'relative', flex: 1, minWidth: 0, minHeight: 0, height: '100%',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              /* No radius of its own — the wrapper already rounds the
                 corners, and a second one drew a panel inside a panel. */
            }}>
              {/* The wash. Full strength at the top, settling as it
                  descends — the reference is a real colour field, not
                  a tint, so this never resolves to black. */}
              <div aria-hidden style={{
                position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                /* Stronger and no black veil over the top. The veil
                   that used to sit here dragged every colour toward
                   brown-grey, which is why the page never looked like
                   the reference's saturated field. Contrast for the
                   text comes from `deep` at the bottom instead. */
                /* Holds colour the whole way down. It used to land on
                   `deep` at 0.96 by the bottom, which is effectively
                   black — the reference stays a blue field behind the
                   entire tracklist, only settling slightly. */
                background: `linear-gradient(180deg, rgba(${wash},0.85) 0%, rgba(${wash},0.55) 26%, rgba(${wash},0.34) 58%, rgba(${wash},0.28) 100%), rgba(${deep},0.72)`,
              }} />
              {/* A four-cover playlist: each cover's colour from its own
                  corner, over the first cover's wash (it's top left). */}
              {tilePal ? (
                <div aria-hidden style={{
                  position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                  background: [
                    `radial-gradient(60% 60% at 100% 0%, rgba(${tilePal[1]},0.6), rgba(${tilePal[1]},0) 100%)`,
                    `radial-gradient(55% 55% at 0% 100%, rgba(${tilePal[2]},0.45), rgba(${tilePal[2]},0) 100%)`,
                    `radial-gradient(55% 55% at 100% 100%, rgba(${tilePal[3]},0.45), rgba(${tilePal[3]},0) 100%)`,
                  ].join(', '),
                }} />
              ) : null}

              {/* Back sits in the top-LEFT corner, where every other album
                  layout and the artist page keep it. Out of flow; the
                  header starts below it. */}
              <button type="button" onClick={() => setLibDetail(null)} title="Back" aria-label="Back"
                style={{
                  position: 'absolute', top: 14, left: 14, zIndex: 3,
                  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: 'rgba(0,0,0,0.34)', color: 'rgba(var(--st-text-rgb), 0.85)',
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
              </button>

              <div style={{ position: 'relative', zIndex: 1, /* 54px top: clearance for the back arrow in the top-left. */
              display: 'flex', gap: 26, padding: '54px 22px 0', minHeight: 0, flex: 1 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

                  {/* Artwork sits WITH the title. It used to float in a
                      card on the right while every track row repeated
                      the same 42px thumbnail — the art belongs to the
                      record, so it's stated once, here. */}
                  {/* Alignment is a setting while we compare. The text
                      block is shorter than the 150px cover, so the
                      leftover height has to land somewhere: flex-end
                      puts it above (label mid-artwork), flex-start
                      below, centre splits it. */}
                  <div style={{ display: 'flex', alignItems: detailAlign, gap: 24 }}>
                    {/* On a playlist the artwork IS the cover control —
                        clicking it opens the picker. Discoverable
                        where you'd actually reach for it, rather than
                        as one icon among five in the action row. */}
                    <div
                      onClick={detailData.kind === 'playlist' ? () => setPlCoverFor(libDetail.key) : undefined}
                      title={detailData.kind === 'playlist' ? 'Change cover' : undefined}
                      className={detailData.kind === 'playlist' ? 'sth-plcover' : undefined}
                      style={{
                        position: 'relative', width: 190, height: 190, borderRadius: 9, flexShrink: 0, overflow: 'hidden',
                        cursor: detailData.kind === 'playlist' ? 'pointer' : 'default',
                        background: detailData.mosaic
                          ? detailData.mosaic.map((a, i) => `url("${a}") ${['0 0', '100% 0', '0 100%', '100% 100%'][i]}/50% 50% no-repeat`).join(', ')
                          : detailData.art ? coverLayers(detailData.art, ' center/cover') : `linear-gradient(140deg, rgba(${wash},0.7), rgba(${wash},0.25))`,
                        /* The fullscreen stage's artBoxShadow, exactly.
                           I'd used an OFFSET drop shadow last time —
                           the stage uses two centred halos with no
                           offset (tight 5px, then 13px spread 7),
                           which radiates evenly on all sides instead
                           of pooling below. That's the glow, and the
                           zero-blur ring is what stops it banding on
                           a dark background. */
                        /* Softened from the stage's values. There the
                           artwork is the whole screen against a dark
                           backdrop and can carry a heavy halo; here
                           it sits beside text on a coloured wash, so
                           the same opacities read as a dark smear
                           around it. Same geometry, lighter. */
                        /* No white ring or lit top edge. Those help on
                           the fullscreen stage, where the artwork
                           floats alone — but on art that's already
                           light at the edges, or has a white border of
                           its own, they read as a stray outline. The
                           halo alone separates it from the wash. */
                        boxShadow: [
                          '0 0 5px 1px rgba(0,0,0,0.52)',
                          '0 0 14px 6px rgba(0,0,0,0.48)',
                        ].join(', '),
                      }}>
                      {detailData.kind === 'playlist' ? (
                        <div className="sth-plcover-veil">
                          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                          </svg>
                          <span style={{ fontSize: 11.5, fontWeight: 650, marginTop: 7 }}>Change cover</span>
                        </div>
                      ) : null}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(var(--st-sub-rgb), 0.6)' }}>
                        {detailData.kind === 'album' ? 'Album' : 'Playlist'}
                      </div>
                      {/* Scales with the cover: at 35px against 190px
                          artwork the title read as a caption beside a
                          picture rather than the page's subject. */}
                      <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--st-text)', letterSpacing: '-0.025em', lineHeight: 1.05, marginTop: 3, marginLeft: '-0.05em' }}>{isAllCaps(detailData.title) ? <span className="rp-caps" style={{ fontSize: '0.88em', letterSpacing: '0.015em' }}>{detailData.title}</span> : detailData.title}</div>
                      <div style={{ fontSize: 14, color: 'rgba(var(--st-sub-rgb), 0.62)', marginTop: 11 }}>
                        By{' '}
                        {/* The credit is a link, not a caption — an
                            artist name should be a way to their page
                            from wherever it appears. Falls back to
                            plain text for playlists and for credits
                            that don't resolve to a library artist. */}
                        {(() => {
                          const who = detailData.kind === 'album' ? String(detailData.by || '') : '';
                          const hit = who
                            ? libArtists.find((a) => who.toLowerCase().startsWith(a.key))
                            : null;
                          if (!hit) return <span style={{ color: 'var(--st-text)', fontWeight: 600 }}>{detailData.by}</span>;
                          return (
                            <button type="button" onClick={() => setLibDetail({ kind: 'artist', key: hit.key })}
                              title={`Go to ${hit.name}`}
                              style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: 14, fontWeight: 600, color: 'var(--st-text)', cursor: 'pointer', textDecorationColor: 'rgba(var(--st-fg-rgb), 0.4)', textUnderlineOffset: 3 }}
                              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
                              {detailData.by}
                            </button>
                          );
                        })()}
                        {` · ${detailData.tracks.length} songs${formatTotalMs(totalMs) ? ` · ${formatTotalMs(totalMs)}` : ''}`}
                      </div>
                      {detailGenres.length ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>
                          {detailGenres.map((g) => (
                            <span key={g} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 999, background: 'rgba(var(--st-fg-rgb), 0.10)', border: '1px solid rgba(var(--st-fg-rgb), 0.08)', color: 'rgba(var(--st-text-rgb), 0.78)' }}>{g}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '16px 0 14px' }}>
                    {/* The same white Play button as the other album and playlist layouts. */}
                    {/* Playing from here: Pause, which pauses rather than starting over. */}
                    {(() => {
                      const here = !!currentTrack && detailData.tracks.some((t) => t.id === currentTrack.id);
                      const pause = here && isPlaying;
                      return (
                    <button type="button" onClick={() => (here && onTogglePlay ? onTogglePlay() : onPlayTrack?.(detailData.tracks[0], detailData.tracks))}
                      aria-label={`${pause ? 'Pause' : 'Play'} ${detailData.title}`}
                      style={{
                        height: 46, padding: '0 24px 0 20px', borderRadius: 12, border: 'none', cursor: 'pointer', flexShrink: 0,
                        display: 'inline-flex', alignItems: 'center', gap: 9, font: 'inherit', fontWeight: 800, fontSize: 15,
                        background: '#fff', color: '#000', transition: 'transform 0.12s ease',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}>
                      {pause ? <PauseIcon size={15} /> : <PlayIcon size={15} />}{pause ? 'Pause' : 'Play'}
                    </button>
                      );
                    })()}
                    <DetailAction title="Shuffle" onClick={() => { const sh = [...detailData.tracks].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); }}>
                      <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                    </DetailAction>
                    {/* Add-to-playlist and Add-songs removed from this
                        row. Adding is per-track work and now lives in
                        the right-click menu, where you're already
                        pointing at the track you mean. */}
                    {detailData.kind === 'album' && onUpdateAlbumMetadata ? (
                      /* Opens the SAME AlbumMetadataEditor the overlay
                         uses — album name, artist, year, genre, cover,
                         explicit — applied across every track on the
                         record. It was built and only ever wired to
                         the overlay. */
                      <DetailAction title="Edit album details" onClick={() => setAlbumEditScope({
                        key: libDetail.key,
                        album: detailData.title,
                        artist: detailData.by,
                        coverArt: detailData.art,
                        sampleTrack: detailData.tracks[0],
                        trackIds: detailData.tracks.map((t) => t.id),
                        discNumber: null,
                      })}>
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                      </DetailAction>
                    ) : null}
                    {detailData.kind === 'playlist' ? (
                      <>
                        <DetailAction title="Edit playlist" onClick={() => setRenamePl({ id: libDetail.key, name: detailData.title })}>
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                        </DetailAction>
                        {/* Destructive delete moved into the overflow —
                            it used to sit two icons from Play. */}
                        <DetailAction title="More" onClick={() => setDetailMore((v) => !v)}>
                          <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.6" />
                        </DetailAction>
                        {detailMore ? (
                          <span style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', top: 6, left: -60, zIndex: 20, width: 210, padding: 5, borderRadius: 12, background: '#000', border: '1px solid var(--border)', boxShadow: '0 22px 60px rgba(0,0,0,0.7)' }}>
                              <button type="button" className="sth-mi" style={{ color: 'var(--danger)' }}
                                onClick={() => { setDetailMore(false); setDeletePl({ id: libDetail.key, name: detailData.title }); }}>
                                Delete playlist
                              </button>
                            </span>
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  <div className="sth-ltable" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="sth-lrow sth-lrow-head" style={{ gridTemplateColumns: cols }}>
                      <div>#</div>
                      <div>Title</div>
                      {showAlbumCol ? <div className="sth-lcol-album">Album</div> : null}
                      {showPlaysCol ? <div style={{ textAlign: 'right' }}>Plays</div> : null}
                      <div style={{ textAlign: 'right' }}>Time</div>
                      {/* A long playlist's top/end arrows, in the headings rather
                          than over the songs. */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        {detailData.kind === 'playlist' ? <ScrollJump scrollRef={classicScrollRef} watch={detailTracks.length} size={24} /> : null}
                      </div>
                    </div>
                    <div className="sth-libscroll sth-lfade" ref={classicScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                      {detailTracks.map((t, i) => {
                        const playing = currentTrack?.id === t.id;
                        return (
                          <div key={t.id} className={`sth-lrow${playing ? ' is-playing' : ''}`}
                            /* 40px art + 7px padding ≈ 56px rows. I had
                               tightened these to 38px against a much
                               smaller screenshot; measured against the
                               full-size reference and scaled to this
                               window, 57px is the real figure. */
                            style={{ gridTemplateColumns: cols, padding: '7px 8px' }}
                            onDoubleClick={() => onPlayTrack?.(t, detailTracks)}
                            onContextMenu={canManage ? (e) => openRowMenu(e, t) : undefined}>
                            <div className="sth-lrow-n" style={{ height: 42 }}>
                              {playing
                                ? <PlayingBars acc={pageAccUI} playing={isPlaying} />
                                : <span className="sth-lrow-num">{detailData.kind === 'album' ? (t.trackNumber || i + 1) : i + 1}</span>}
                              <RowPlayButton
                                playing={playing} isPlaying={isPlaying} title={t.title}
                                onPlay={() => onPlayTrack?.(t, detailTracks)} onTogglePlay={onTogglePlay}
                              />
                            </div>
                            {/* No per-row artwork: on an album every
                                thumbnail is the same image, and the
                                header states it once at 150px. */}
                            <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                  <span style={{ fontSize: 15, fontWeight: 600, color: playing ? `rgb(${pageAccUI})` : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                                  {t.explicit ? <ExplicitBadge /> : null}
                                </div>
                                {oneArtist ? null : (
                                  <div style={{ fontSize: 13, color: 'rgba(var(--st-sub-rgb), 0.5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.artist}</div>
                                )}
                              </div>
                            </div>
                            {showAlbumCol ? <div className="sth-lrow-dim sth-lcol-album">{t.album}</div> : null}
                            {showPlaysCol ? <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{playCountFor(t.id)}</div> : null}
                            <div className="sth-lrow-dim st-num" style={{ textAlign: 'right' }}>{formatTime(t.duration)}</div>
                            <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                              {onToggleFavorite ? (
                                /* Always visible — a heart you can't see
                                   is a heart whose state you can't read. */
                                <button type="button" className="sth-lrow-more" onClick={() => onToggleFavorite(t.id)}
                                  title={t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                                  style={{ opacity: 1, color: t.isFavorite ? `rgb(${pageAccUI})` : 'rgba(var(--st-fg-rgb), 0.4)' }}>
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill={t.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M20.8 8.6a5 5 0 0 0-8.8-2.6A5 5 0 0 0 3.2 8.6c0 4.2 5.5 7.6 8.8 10.4 3.3-2.8 8.8-6.2 8.8-10.4z" />
                                  </svg>
                                </button>
                              ) : null}
                              {detailData.kind === 'playlist' && onRemoveFromPlaylist ? (
                                <button type="button" className="sth-lrow-more" onClick={() => onRemoveFromPlaylist(libDetail.key, t.id)}
                                  title="Remove from playlist">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ height: 14 }} />
                    </div>
                  </div>
                </div>

              </div>
            </div>
          );
        })()
      ) : view === 'artists' ? (
        /* ---- Artist grid ----
           Portraits of people, in tiles shaped for portraits. See
           ArtistGrid.jsx for why this stopped being album art in
           circles. */
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <LibHeader
            title="Artists"
            meta={`${libArtists.length} in your library`}
            filter={libFilter}
            onFilter={setLibFilter}
            searchPlaceholder="Search artists"
            onImportFiles={onImportFiles}
            onImportFolder={onImportFolder}
            importing={importing}
          />
          <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <ArtistGrid
              artists={filteredLibArtists}
              accent={acc}
              playEvents={playEvents}
              onOpen={(k) => setLibDetail({ kind: 'artist', key: k })}
              onPlay={(a) => { if (a.tracks?.length) onPlayTrack?.(a.tracks[0], a.tracks); }}
              emptyNote={libFilter.trim() ? `No artists match \u201C${libFilter.trim()}\u201D.` : undefined}
            />
            <div style={{ height: 16 }} />
          </div>
        </div>
      ) : view === 'albums' ? (
        /* ---- Album grid ----
           The albums view was a flat track list sorted by album name,
           which made a record's identity invisible. Cards, then drill
           in. */
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <LibHeader
            title="Albums"
            meta={`${libAlbums.length} in your library`}
            filter={libFilter}
            onFilter={setLibFilter}
            searchPlaceholder="Search albums"
            onImportFiles={onImportFiles}
            onImportFolder={onImportFolder}
            importing={importing}
          />
          <div className="sth-libscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {/* auto-fill, so a wider window gains columns rather than
                gaps (brief, Albums). */}
            <div className="sth-alb-grid" style={{ padding: '4px 3px 18px' }}>
              {libAlbums.map((a) => (
                <button key={a.key} type="button" className="sth-alb" style={{ textAlign: 'left' }}
                  onClick={() => setLibDetail({ kind: 'album', key: a.key })}>
                  <div className="sth-albart" style={{ width: '100%', aspectRatio: '1' }}>
                    {a.art ? <div className="sth-albimg" style={{ backgroundImage: coverLayers(a.art) }} /> : null}
                    {/* Fades in over the artwork's lower right. */}
                    <span className="sth-alb-play" title={`Play ${a.name}`} aria-hidden
                      onClick={(e) => { e.stopPropagation(); if (a.tracks?.length) onPlayTrack?.(a.tracks[0], a.tracks); }}>
                      <PlayIcon size={16} />
                    </span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 12, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.artist} · {a.tracks.length} track{a.tracks.length === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ height: 16 }} />
          </div>
        </div>
      ) : (
      <div style={{ flex: 1, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Full width at every window size, like the other library pages.
            It used to stop at 1240px and centre, which left a wide empty
            margin on each side of a maximised window. */}
        {/* One compact bar for every library view — see LibHeader. */}
        <LibHeader
          title={libTitle}
          meta={`${rows.length} song${rows.length === 1 ? '' : 's'}${formatTotalMs(totalMs) ? ` · ${formatTotalMs(totalMs)}` : ''}`}
          filter={libFilter}
          onFilter={setLibFilter}
          searchPlaceholder="Search songs"
          sortValue={libRowSort}
          sortField={libSortField}
          onPickSort={pickLibRowSort}
          onPlayAll={rows.length ? () => onPlayTrack?.(rows[0], rows) : null}
          onShuffle={rows.length ? () => { const sh = [...rows].sort(() => Math.random() - 0.5); onPlayTrack?.(sh[0], sh); } : null}
          onImportFiles={onImportFiles}
          onImportFolder={onImportFolder}
          importing={importing}
        />

        {rows.length ? (
          <div className={`sth-ltable${showDateAdded ? '' : ' no-date'}${libAzIndex ? ' has-az' : ''}`} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="sth-lrow sth-lrow-head">
              <div>#</div>
              <div>Title</div>
              <div>Artist</div>
              <div className="sth-lcol-album">Album</div>
              <div className="sth-lcol-date">Date added</div>
              <div style={{ textAlign: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle' }}>
                  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div />
            </div>
            {(() => {
              /* Clamp the scroll offset to what this list can
                 actually scroll to before slicing.
                 libScrollTop is React state mirroring the element's
                 scrollTop, and the two can disagree for a frame or
                 more: on remount, when the list changes length
                 underneath a reused node, or when a re-render lands
                 before onScroll has reported. An offset larger than
                 the new content means `first` runs past the end,
                 slice() returns nothing, and the table renders as a
                 tall empty spacer — blank until any scroll resyncs
                 the two. Clamping means the worst case is showing
                 the wrong page, never no page. */
              const maxTop = Math.max(0, rows.length * LIB_ROW_H - libViewH);
              const top = Math.min(Math.max(0, libScrollTop), maxTop);
              const first = Math.max(0, Math.floor(top / LIB_ROW_H) - LIB_OVERSCAN);
              const last = Math.min(rows.length, Math.ceil((top + Math.max(libViewH, LIB_ROW_H)) / LIB_ROW_H) + LIB_OVERSCAN);
              const slice = rows.slice(first, last);
              return (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
                <div
                  ref={libScrollRef}
                  className="sth-libscroll sth-lfade"
                  style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
                  onScroll={(e) => setLibScrollTop(e.currentTarget.scrollTop)}
                >
                  {/* Spacers stand in for the rows that aren't mounted,
                      so the scrollbar reflects the whole list. */}
                  <div style={{ height: first * LIB_ROW_H }} />
                  {slice.map((t, i) => (
                    <LibRow
                      key={t.id}
                      t={t}
                      index={first + i}
                      playing={currentTrack?.id === t.id}
                      isPlaying={isPlaying}
                      acc={acc}
                      art={coverFor(t)}
                      added={fmtAdded(t.addedAt)}
                      canManage={canManage}
                      onPlay={playFromLibRows}
                      onTogglePlay={onTogglePlay}
                      onMenu={openRowMenu}
                      onOpenArtist={openArtistFromRow}
                      onOpenAlbum={openAlbumFromRow}
                    />
                  ))}
                  <div style={{ height: Math.max(0, (rows.length - last) * LIB_ROW_H) + 12 }} />
                </div>

            {/* A–Z rail — a flex SIBLING of the scroll area, not an
                overlay on it. Absolute positioning inside .sth-ltable
                meant it spanned the header row as well (so the rail
                started level with "TITLE" instead of the first song)
                and sat on top of the scrollbar. As a sibling it gets
                its own column beside the scrollbar and inherits
                exactly the scrolling area's height, which is the
                range the letters actually address.

                Scrolls by row index rather than scrollIntoView: the
                rows are virtualised, so the target row usually isn't
                mounted to scroll to. */}
            {libAzIndex ? (
              <div className="sth-azrail" role="navigation" aria-label="Jump to letter">
                {['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => {
                  const at = libAzIndex.get(L);
                  const has = at !== undefined;
                  return (
                    <button
                      key={L}
                      type="button"
                      tabIndex={-1}
                      className={has ? 'has' : 'no'}
                      aria-hidden={!has}
                      title={has ? `Jump to ${L}` : undefined}
                      onClick={has ? () => {
                        const el = libScrollElRef.current;
                        if (!el) return;
                        const top = at * LIB_ROW_H;
                        el.scrollTop = top;
                        // onScroll will fire too, but setting it
                        // here means the correct slice renders on
                        // this frame rather than the next one.
                        setLibScrollTop(top);
                      } : undefined}
                    >{L}</button>
                  );
                })}
              </div>
            ) : null}
                </div>
              );
            })()}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'rgba(var(--st-sub-rgb), 0.4)', lineHeight: 1.6, paddingTop: 8 }}>
            {library.length
              ? (view === 'songs' && libFilter.trim()
                ? `No songs match “${libFilter.trim()}”.`
                : 'Nothing here yet.')
              : 'Your library is empty. Import music from Home, or drag files onto the window.'}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
