import React, { useState, useEffect, useRef, useCallback } from 'react';
import { sampleCoverTheme, accentTextColor } from '../lib/coverTheme.js';
import SpotifyImport from './SpotifyImport.jsx';
import { parseLRC } from '../lib/mediaUtils.js';
import StudioOnboarding from './StudioOnboarding.jsx';
import StudioHome from './StudioHome.jsx';

/* =========================================================================
 *  StudioShell — the entire view layer of studio.
 *
 *  Onboarding on first run, StudioHome after that. The playback engine,
 *  library state, queue, analyser, play-event and release plumbing all stay
 *  in App.jsx; this component decides which of the two is on screen and
 *  derives what StudioHome needs from the playing track (cover theme,
 *  lyrics).
 * ========================================================================= */

const ONBOARDED_KEY = 'studio:onboarded';

export default function StudioShell({
  // Library + playback state (owned by App.jsx)
  library = [],
  // Local file import (owned by App.jsx — pickers, tag reading, DB write)
  onClearLibrary,
  playlists = [],
  onCreatePlaylist,
  onDeletePlaylist,
  onAddTracksToPlaylist,
  onRenamePlaylist,
  onUpdatePlaylist,
  onRemoveFromPlaylist,
  onImportFiles,
  onImportFolder,
  onImportSpotify,
  /* The Spotify import panel is mounted HERE, not in App, because the live
     cover accent is derived in this component — App has no colour to give
     it. Its open/close state still lives in App so the panel survives a view
     change: a forty-track download outlasts whatever tab you started it from. */
  spotifyImportOpen = false,
  onCloseSpotifyImport,
  onReloadLibrary,
  importing = false,
  albumCoverOverrides = {},
  currentTrack = null,
  isPlaying = false,
  currentTime = 0,
  duration = 0,
  volume = 1,
  /* Volume boost — the GainNode multiplier in App.jsx's audio graph. Separate
     from volume because the audio element's own .volume is capped at 1.0. */
  gainBoost = 1,
  onSetGainBoost,
  getGainReduction = null,
  shuffleOn = false,
  repeat = 'off',
  // Transport (owned by App.jsx)
  onPlayTrack,
  onTogglePlay,
  onPrev,
  onNext,
  onToggleShuffle,
  onToggleRepeat,
  onSeek,
  onSetVolume,
  // Audio-reactive visuals
  beatReactive = false,
  analyserRef = null,
  onNeedAnalyser,
  ensureAnalyser,
  // Overlay display settings (owned by App.jsx, persisted there)
  // Track transitions (owned by App.jsx — same engine as Immerse). The
  // overlay's Settings tab exposes a gapless toggle when these are wired.
  transitionMode = 'off',
  onSetTransitionMode,
  // Metadata editing (owned by App.jsx). The overlay shows an "Edit track
  // info" entry + pencil dock button when this is wired.
  onUpdateTrackMetadata,
  // Library removal (owned by App.jsx — handles queue/current-track fallout).
  onRemoveFromLibrary,
  // Library row actions (owned by App.jsx)
  onToggleFavorite,
  onPlayNext,
  onAddToQueue,
  // Album-wide metadata editing + album-art pinning (owned by App.jsx).
  onUpdateAlbumMetadata,
  onSetAlbumCover,
  // Discord rich presence settings (state owned by App.jsx — the presence
  // engine itself also lives there; these just feed the Settings page).
  discordPresenceEnabled = false,
  onSetDiscordPresenceEnabled,
  discordAppId = '',
  onSetDiscordAppId,
  discordPresenceDetail = 'full',
  onSetDiscordPresenceDetail,
  discordHideWhenPaused = true,
  onSetDiscordHideWhenPaused,
  imgbbApiKey = '',
  onSetImgbbApiKey,
  uiFontId,
  onSetUiFontId,
  // The live play queue (owned by App.jsx) — the overlay's "Up next" card.
  queue = [],
  queueIndex = -1,
  // Command-center data
  playEvents = [],
  onResetStats,
  // Discover plumbing (owned by App.jsx — same system as Immerse's
  // Releases tab): refresh state + follow-artist management.
  // Import + credentials
  onSpotifyImportDone,
  onSpotifyCredsSaved,
}) {
  /* ---------- Onboarding gate ------------------------------------------- */
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem(ONBOARDED_KEY) === '1'; } catch { return true; }
  });
  const completeOnboarding = useCallback(() => {
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* ignore */ }
    setOnboarded(true);
  }, []);
  /* TEMPORARY — lets Settings re-run the walkthrough. Only clears the
     "seen it" flag; credentials, library and stats are untouched, so
     finishing (or skipping) puts everything back as it was. */
  const replayOnboarding = useCallback(() => {
    try { localStorage.removeItem(ONBOARDED_KEY); } catch { /* ignore */ }
    setOnboarded(false);
  }, []);

  /* "Clear everything" — back to a first-launch app.
     Wipes the library and every play event, then drops the onboarded flag so
     the next paint is the setup screen. Deliberately does NOT clear saved
     Spotify / Soulseek credentials: those live in the main process, are the
     tedious part to set up again, and onboarding shows them as already
     configured — so the user lands on a clean app without re-doing the one
     step that involves a developer dashboard. */
  const clearEverything = useCallback(async ({ deleteFiles = false } = {}) => {
    const res = await onClearLibrary?.({ deleteFiles, clearStats: true });
    if (res && res.ok === false) return res;
    try { await onResetStats?.(); } catch { /* clear already covered it */ }
    try {
      localStorage.removeItem(ONBOARDED_KEY);
      localStorage.removeItem('studio:streakTierSeen');
    } catch { /* ignore */ }
    setOnboarded(false);
    return { ok: true, ...(res || {}) };
  }, [onClearLibrary, onResetStats]);


  /* ---------- Gapless by default ----------------------------------------- */
  // The transition engine lives in App.jsx (same engine as Immerse) and
  // defaults to 'off' (hard cut). studio wants seamless playback out of the
  // box: if the user has NEVER chosen a transition mode (no persisted key),
  // flip the App-owned setting to gapless once. After that the key exists,
  // so whatever the user picks — including turning it off — sticks.
  useEffect(() => {
    if (typeof onSetTransitionMode !== 'function') return;
    try {
      if (window.localStorage.getItem('immerse:transitionMode') == null) {
        onSetTransitionMode('gapless');
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  /* ---------- Cover theme (ported from ImmersiveLibraryPage) ------------- */
  const [themeRgb, setThemeRgb] = useState({
    accent: '48, 48, 48', wash: '10, 10, 10', mid: '12, 12, 12', deep: '0, 0, 0',
  });
  useEffect(() => {
    const src = currentTrack?.coverArt;
    if (!src) {
      setThemeRgb({ accent: '48, 48, 48', wash: '10, 10, 10', mid: '12, 12, 12', deep: '0, 0, 0' });
      return undefined;
    }
    let cancelled = false;
    sampleCoverTheme(src).then((rgb) => {
      if (!cancelled && rgb) setThemeRgb(rgb);
    });
    return () => { cancelled = true; };
  }, [currentTrack?.coverArt, currentTrack?.id]);
  const { accent } = themeRgb;

  /* ---------- Lyrics (ported verbatim from ImmersiveLibraryPage) --------- */
  const [lyricsData, setLyricsData] = useState(null); // { synced, plain, instrumental }
  const [lyricsTrackId, setLyricsTrackId] = useState(null);
  const lyricsCacheRef = useRef(new Map());
  // Monotonic request id — any async result must re-check it before applying
  // so a slow cold fetch can't land on top of a newer track's lyrics.
  const lyricsReqRef = useRef(0);

  useEffect(() => {
    const track = currentTrack;
    if (!track) {
      setLyricsData(null);
      setLyricsTrackId(null);
      return;
    }
    if (track.id === lyricsTrackId) return;

    const reqId = ++lyricsReqRef.current;
    setLyricsData(null);

    const cached = lyricsCacheRef.current.get(track.id);
    if (cached !== undefined) {
      setLyricsData(cached);
      setLyricsTrackId(track.id);
      return;
    }

    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.fetchLyrics) return;

    let cancelled = false;
    const lyricsProvider = (typeof window !== 'undefined' && localStorage.getItem('immerse:lyricsProvider')) || 'lrclib';
    api.fetchLyrics({
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      duration: track.duration || 0,
      provider: lyricsProvider,
    }).then((res) => {
      if (cancelled || lyricsReqRef.current !== reqId) return;
      let data = null;
      if (res?.ok) {
        data = {
          synced: parseLRC(res.syncedLyrics),
          plain: res.plainLyrics || null,
          instrumental: !!res.instrumental,
        };
      }
      lyricsCacheRef.current.set(track.id, data);
      setLyricsData(data);
      setLyricsTrackId(track.id);
    }).catch(() => {
      if (cancelled || lyricsReqRef.current !== reqId) return;
      lyricsCacheRef.current.set(track.id, null);
      setLyricsData(null);
      setLyricsTrackId(track.id);
    });
    return () => { cancelled = true; };
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist]);

  /* ---------- Lyric editing / picking (ported from Immerse) -------------- */
  // The editor (Overlays) saved to the DB itself; this just installs the
  // result in the cache and blocks any in-flight fetch from stomping it.
  const handleLyricsSaved = useCallback((newSynced, newPlain, trackId) => {
    // `trackId` is explicit because NowPlayingPanel renders against a
    // DEBOUNCED track (it lags currentTrack briefly during the crossfade
    // animation). Saving inside that window would otherwise cache the result
    // under the wrong id and lose it. Callers that can't lag omit it.
    const id = trackId || currentTrack?.id;
    if (!id) return;
    lyricsReqRef.current += 1;
    const data = { synced: newSynced || [], plain: newPlain || null, instrumental: false };
    lyricsCacheRef.current.set(id, data);
    // Only repaint the live view if the save was for the track on screen —
    // otherwise a save landing mid-transition would show the old song's
    // lyrics over the new one.
    if (!currentTrack || id === currentTrack.id) {
      setLyricsData(data);
      setLyricsTrackId(id);
    }
  }, [currentTrack]);

  // A candidate picked in the lyrics browser: persist, then apply — with
  // the same ownership dance Immerse does so a slow auto-fetch can't land
  // on top of the user's explicit pick.
  const handlePickLyrics = useCallback(async (candidate) => {
    if (!currentTrack) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    const synced = candidate.syncedLyrics ? parseLRC(candidate.syncedLyrics) : [];
    const plain = candidate.plainLyrics || null;
    const reqId = ++lyricsReqRef.current;
    if (api?.saveLyrics) {
      await api.saveLyrics({
        title: currentTrack.title, artist: currentTrack.artist,
        syncedLyrics: candidate.syncedLyrics, plainLyrics: plain,
      });
    }
    if (lyricsReqRef.current !== reqId) return;
    const data = { synced, plain, instrumental: false, lyricId: candidate.id ?? null };
    lyricsCacheRef.current.set(currentTrack.id, data);
    setLyricsData(data);
    setLyricsTrackId(currentTrack.id);
  }, [currentTrack]);

  /* ---------- Analyser priming (ported) ---------------------------------- */
  useEffect(() => {
    if (!ensureAnalyser || !currentTrack) return;
    if (beatReactive) ensureAnalyser();
  }, [ensureAnalyser, currentTrack, beatReactive]);

  /* ---------- Render ------------------------------------------------------ */
  if (!onboarded) {
    return (
      <StudioOnboarding
        onComplete={completeOnboarding}
        onSpotifyCredsSaved={onSpotifyCredsSaved}
      />
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <StudioHome
        library={library}
        duration={duration}
        analyserRef={analyserRef}
        onNeedAnalyser={onNeedAnalyser}
        onResetStats={onResetStats}
        /* TEMPORARY — surfaces "Replay setup" in Settings → Connections. */
        onReplayOnboarding={replayOnboarding}
        onClearEverything={clearEverything}
        /* Album metadata editing existed on the overlay only; the command
           center needs it on this surface too now. */
        onUpdateAlbumMetadata={onUpdateAlbumMetadata}
        /* Same handler the overlay's editor uses. StudioShell is the single
           owner of lyrics state — its per-track cache has to hear about every
           save or it serves a stale entry the next time you come back. */
        onLyricsSaved={handleLyricsSaved}
        /* Same handler the overlay's picker uses — persists the chosen
           candidate and applies it, with the ownership guard that stops a
           slow auto-fetch landing on top of the user's explicit pick. */
        onPickLyrics={handlePickLyrics}
        onClearLibrary={onClearLibrary}
        playlists={playlists}
        onCreatePlaylist={onCreatePlaylist}
        onDeletePlaylist={onDeletePlaylist}
        onAddTracksToPlaylist={onAddTracksToPlaylist}
        onRenamePlaylist={onRenamePlaylist}
        onUpdatePlaylist={onUpdatePlaylist}
        onSetAlbumCover={onSetAlbumCover}
        onRemoveFromPlaylist={onRemoveFromPlaylist}
        onImportFiles={onImportFiles}
        onImportSpotify={onImportSpotify}
        onImportFolder={onImportFolder}
        importing={importing}
        queue={queue}
        queueIndex={queueIndex}
        albumCoverOverrides={albumCoverOverrides}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        onPlayTrack={onPlayTrack}
        onTrackImported={onSpotifyImportDone}
        onSpotifyCredsSaved={onSpotifyCredsSaved}
        onUpdateTrackMetadata={onUpdateTrackMetadata}
        onRemoveFromLibrary={onRemoveFromLibrary}
        onToggleFavorite={onToggleFavorite}
        onPlayNext={onPlayNext}
        onAddToQueue={onAddToQueue}
        volume={volume}
        onSetVolume={onSetVolume}
        gainBoost={gainBoost}
        onSetGainBoost={onSetGainBoost}
        getGainReduction={getGainReduction}
        onTogglePlay={onTogglePlay}
        onPrev={onPrev}
        onNext={onNext}
        lyricsData={lyricsData}
        currentTime={currentTime}
        onSeek={onSeek}
        shuffleOn={shuffleOn}
        repeat={repeat}
        onToggleShuffle={onToggleShuffle}
        onToggleRepeat={onToggleRepeat}
        playEvents={playEvents}
        transitionMode={transitionMode}
        onSetTransitionMode={onSetTransitionMode}
        discordPresenceEnabled={discordPresenceEnabled}
        onSetDiscordPresenceEnabled={onSetDiscordPresenceEnabled}
        discordAppId={discordAppId}
        onSetDiscordAppId={onSetDiscordAppId}
        discordPresenceDetail={discordPresenceDetail}
        onSetDiscordPresenceDetail={onSetDiscordPresenceDetail}
        discordHideWhenPaused={discordHideWhenPaused}
        onSetDiscordHideWhenPaused={onSetDiscordHideWhenPaused}
        imgbbApiKey={imgbbApiKey}
        onSetImgbbApiKey={onSetImgbbApiKey}
        uiFontId={uiFontId}
        onSetUiFontId={onSetUiFontId}
        themeRgb={themeRgb}
      />


      <SpotifyImport
        open={spotifyImportOpen}
        onClose={onCloseSpotifyImport}
        accent={accent}
        accentInk={accentTextColor(accent)}
        onImported={onReloadLibrary}
        onCreatePlaylist={onCreatePlaylist}
        onAddTracksToPlaylist={onAddTracksToPlaylist}
      />
    </div>
  );
}
