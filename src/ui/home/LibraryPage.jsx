import React from 'react';
import { barTone, pageFromBar, pageWash, readableAccent, recordDeep, recordWashSource } from '../../lib/coverTheme.js';
import { formatTotalMs } from '../../lib/mediaUtils.js';
import ArtistGrid from '../ArtistGrid.jsx';
import ArtistPage from '../ArtistPage.jsx';
import { PlayIcon } from '../sharedUI.jsx';
import { LibHeader, LibRow } from './Library.jsx';
import RecordPage from './RecordPage.jsx';
import { EmptyState, MI } from './common.jsx';
import { coverLayers } from '../../lib/coverUrl.js';
import { DARK } from './constants.js';
import { AnimatedGradientBg, FadeLayer, FadeSwap } from '../VisualEffects.jsx';

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
  detailData,
  detailFilter,
  detailMore,
  detailTheme,
  detailTracks,
  dlProgress,
  dlState,
  downloadSpotifyRow,
  filteredLibArtists,
  fmtAdded,
  immerse,
  immersePalette = null,
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
  onMovePlaylistSong,    // (trackId, toIndex) on a playlist's page, or null
  onToggleFavorite,
  onTogglePlay,
  onUpdateAlbumMetadata,
  openAlbumFromRow,
  openAlbumMenu,         // (event, album): its menu, on right-click
  openArtistMenu,        // (event, artist, portrait)
  openLibAlbum,          // (key) → your album, in search's album view
  openArtist,
  openArtistAnywhere,
  openArtistFromRow,
  openPalette,
  openRowMenu,
  ownedTrackFor,
  pickerFor,             // (trackIds, { exclude }) → Add to Playlist's list
  pickLibRowSort,
  pickSection,
  playCountFor,
  playEvents,
  playFromLibRows,
  setAlbumEditScope,
  deletePlaylist,
  setDetailFilter,
  setDetailMore,
  setLibDetail,
  setLibFilter,
  setLibScrollTop,
  setRenamePl,
  setSetCat,
  showDateAdded,
  showPlayCounts,
  theme,
  toggleFollow,
}) {
  const view = libView;
  /* The Albums grid follows its search box. */
  const albumsShown = React.useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    return q ? libAlbums.filter((a) => a.name.toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q)) : libAlbums;
  }, [libAlbums, libFilter]);
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
  /* Immerse takes over the library pages' colour: they show the same
     moving field as the bar and the panel (see immerseField below), so the
     page's own wash stands down. Album, playlist and artist pages keep their
     own colours. */
  const pageMode = detailPage || immerse ? 'off' : theme.pageSurface;
  const immerseField = immerse && !detailPage && currentTrack;
  /* An album or playlist page under Immerse: the same moving field, made
     from the record's own cover, so the page is still that record's. */
  const recordImmerse = immerse && !!detailData && !openArtist;
  const recordWash = detailData && detailTheme ? pageWash(recordWashSource(detailTheme)) : null;
  // The song the field was last drawn for, so it can still draw while it
  // fades out after the track goes away.
  const lastImmerseTrackRef = React.useRef(null);
  if (currentTrack) lastImmerseTrackRef.current = currentTrack;
  const lastImmerseTrack = currentTrack || lastImmerseTrackRef.current;
  const wrapperFixed = pageMode === 'colour';
  const usesCover = pageMode === 'cover' || pageMode === 'coverFull';
  const npWashOn = currentTrack && usesCover && npWashTheme;
  /* The page follows the bar. pageFromBar keeps the bar's hue and darkens it
     only as far as the page's faint text needs, so a dark bar gives a page
     of exactly the same color and a bright one (blue, yellow, pink, tan) a
     deeper shade of it. It never comes out lighter than the bar. */
  /* A record's own color stands in for the cover's, so it only applies
     where the cover's would: with Library pages on Cover art or Full
     color. Off, Color and Dark mode leave the page alone. */
  const npWashRgb = wrapperFixed
    ? theme.pageColour
    /* Made from the bar's own color (pageFromBar), so the page and the bar
       share a hue. Darkening the raw cover color separately turned an
       orange bar's page olive, and a cover read that came back grey left
       a grey page under a coloured bar. */
    : (coverOverride && currentTrack && usesCover
      ? pageFromBar(coverOverride)
      : (npWashOn ? pageFromBar(barTone(autoRgb)) : null));
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
      /* 18px on top at full size: the header is one bar now, and 28px
         there left a band of nothing over every tab. */
      padding: detailPage ? 0 : (compactMode ? '14px 24px 16px' : '18px 28px 20px'),
      boxSizing: 'border-box',
    }}>

      {/* ---- Now-playing wash ----
          A SOLID colour gradient, exactly like the album and playlist
          pages — not the blurred artwork. Same pageWash() treatment
          of the same sampled tone, so all three surfaces are the same
          colour system rather than two that resemble each other.
          Fades out by the tracklist since this is a list, not a
          record page that owns its whole background. */}
      {/* ---- Immerse ----
          The page's slice of the one field the bar and the panel show (see
          VisualEffects, "One sky"), so the colour runs on from them. A list
          is read, not looked at, so a scrim sits over it: lightest at the
          top, settling darker where the rows are, and the field moves slowly
          enough that it never pulls the eye off a title. */}
      <FadeLayer show={!!immerseField} style={{ zIndex: 0, overflow: 'hidden', borderRadius: 'inherit' }}>
        {lastImmerseTrack ? (
          <AnimatedGradientBg field
            accent={immersePalette?.accent || accent}
            mid={immersePalette?.mid || accent.split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ')}
            wash={immersePalette?.wash || accent.split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ')}
            coverUrl={coverFor(lastImmerseTrack)} isPlaying={isPlaying} vignette={false} brightness={1} />
        ) : null}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.24) 0%, rgba(0,0,0,0.44) 34%, rgba(0,0,0,0.56) 100%)' }} />
      </FadeLayer>
      {/* Cross-faded: switching between Off, Color, Cover Art and Full Color,
          or to the next song's colour, fades rather than cuts. */}
      <FadeLayer show={recordImmerse} style={{ zIndex: 0, overflow: 'hidden', borderRadius: 'inherit' }}>
        {recordImmerse ? (
          <AnimatedGradientBg field
            accent={recordWash || accent}
            mid={(recordWash || accent).split(',').map((n) => Math.round(Number(n) * 0.82)).join(', ')}
            wash={detailTheme ? recordDeep(detailTheme) : (recordWash || accent).split(',').map((n) => Math.round(Number(n) * 0.45)).join(', ')}
            coverUrl={detailData.art} isPlaying={isPlaying} vignette={false} brightness={1} />
        ) : null}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.38) 40%, rgba(0,0,0,0.55) 100%)' }} />
      </FadeLayer>
      <FadeSwap swapKey={npWashRgb ? `${pageMode}:${npWashRgb}` : 'none'} style={{ zIndex: 0 }}>
        {npWashRgb ? (
        <>
          {/* The constant tint. The gradient above it used to stop
              dead at 430px — a line unrelated to anything on screen —
              so the colour now continues underneath at low strength
              and the fade reads as a falloff rather than an edge.
              'full' turns this up and drops the gradient, which is
              how the album and artist pages paint. */}
          <div aria-hidden style={{
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
          }} />
          {pageMode !== 'coverFull' && !wrapperFixed ? (
            <div aria-hidden style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 430, zIndex: 0, pointerEvents: 'none',
              background: `linear-gradient(180deg, rgba(${npWashRgb},0.85) 0%, rgba(${npWashRgb},0.55) 26%, rgba(${npWashRgb},0.30) 58%, rgba(${npWashRgb},0) 100%)`,
            }} />
          ) : null}
        </>
        ) : null}
      </FadeSwap>

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
          onOpenAlbum={(key, group) => openLibAlbum(group || key)}
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
          /* 'fixed' is the colour you chose, exactly: no lightening or
             saturation treatment (black stays black). 'cover' samples
             the artwork and goes through pageWash so text stays
             readable on any sleeve. */
          const fixedPage = theme.detailMode === 'fixed';
          /* Dark mode: the app's own dark, with a lighter shade for the
             parts of a layout that need to stand apart (Sticky
             column's panel). */
          const darkPage = theme.detailMode === 'dark';
          const wash = darkPage ? DARK.raised : fixedPage
            ? (theme.detailColor || '70, 84, 190')
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
          const deep = darkPage ? DARK.page : fixedPage ? (theme.detailColor || '70, 84, 190') : dt ? recordDeep(dt) : '10, 10, 14';
          const isPl = detailData.kind === 'playlist';
          /* The color that marks the playing song is your accent, as it is
             everywhere else: white when Accent is White, the playing song's
             color when it follows the artwork, your pick when Fixed. The
             page's cover never overrides it. */
          const pageAccUI = readableAccent(accent);
          return (
            <RecordPage
              /* Its own page per record: a new one opens at the top, not
                 where the last one was scrolled to. */
              key={libDetail.key}
              data={detailData}
              tracks={detailTracks}
              wash={wash}
              deep={deep}
              tint={darkPage ? recordWash : null}
              dark={darkPage}
              immerse={recordImmerse}
              accUI={pageAccUI}
              libDetailKey={libDetail.key}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayTrack={onPlayTrack}
              onTogglePlay={onTogglePlay}
              onToggleFavorite={onToggleFavorite}
              onRemoveFromPlaylist={onRemoveFromPlaylist}
              onMovePlaylistSong={onMovePlaylistSong}
              canManage={canManage}
              openRowMenu={openRowMenu}
              coverFor={coverFor}
              playCountFor={playCountFor}
              showPlayCounts={showPlayCounts}
              libAlbums={libAlbums}
              onOpenAlbum={(key) => openLibAlbum(key)}
              onGoArtist={openArtistAnywhere}
              onBack={() => setLibDetail(null)}
              onChangeCover={isPl ? () => setRenamePl({ id: libDetail.key, name: detailData.title }) : null}
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
              onDeletePlaylist={isPl ? () => deletePlaylist(libDetail.key) : null}
              moreOpen={detailMore}
              setMoreOpen={setDetailMore}
              bridge={mySpotifyBridge}
              fullAlbum={theme.albumSongs === 'full'}
              onPlayNext={onPlayNext}
              onAddToQueue={onAddToQueue}
              onAddToPlaylist={onAddToPlaylist}
            />
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
              onMenu={openArtistMenu}
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
            {!albumsShown.length ? (
              libFilter.trim()
                ? <EmptyState icon={MI.album} title="No Matches" text={`No albums match “${libFilter.trim()}”.`} />
                : <EmptyState icon={MI.album} title="No Albums Yet" text="Albums with two or more of your songs show up here." />
            ) : null}
            <div className="sth-alb-grid" style={{ padding: '4px 3px 18px' }}>
              {albumsShown.map((a) => (
                <button key={a.key} type="button" className="sth-alb" style={{ textAlign: 'left' }}
                  onClick={() => openLibAlbum(a.key)} onContextMenu={(e) => openAlbumMenu?.(e, a)}>
                  <div className="sth-albart" style={{ width: '100%', aspectRatio: '1' }}>
                    {a.art ? <div className="sth-albimg" style={{ backgroundImage: coverLayers(a.art, '', 640) }} /> : null}
                    {/* Fades in over the artwork's lower right. */}
                    <span className="sth-alb-play" title={`Play ${a.name}`} aria-hidden
                      onClick={(e) => { e.stopPropagation(); if (a.tracks?.length) onPlayTrack?.(a.tracks[0], a.tracks); }}>
                      <PlayIcon size={16} />
                    </span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 12, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {/* Every card's line: type · artist · year, as needed. Here
                        the type is the page's own. */}
                    {[a.artist, a.tracks.find((t) => Number(t.year) > 1000)?.year].filter(Boolean).join(' · ')}
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
              <div className="sth-lcol-date">Date Added</div>
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
                  /* Reported in steps of four rows, not every pixel: each
                     report re-renders the whole home view, and the ten rows
                     of overscan either side already cover the gap. */
                  onScroll={(e) => {
                    const step = LIB_ROW_H * 4;
                    setLibScrollTop(Math.floor(e.currentTarget.scrollTop / step) * step);
                  }}
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
          library.length && libFilter.trim()
            ? <EmptyState icon={MI.album} title="No Matches" text={`No songs match “${libFilter.trim()}”.`} />
            : <EmptyState icon={MI.album} title={library.length ? 'Nothing Here Yet' : 'Your Library Is Empty'}
              text={library.length ? null : 'Import music with Import above, or drag files onto the window.'} />
        )}
      </div>
      )}
    </div>
  );
}
