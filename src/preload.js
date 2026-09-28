const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Escape hatch if named helpers are missing on an older preload bundle. */
  invokeIpc: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  /** Drag-and-drop: turn dropped paths (files and/or folders) into audio files. */
  resolveDroppedPaths: (paths) => ipcRenderer.invoke('import:resolvePaths', paths),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  discordConnect: (appId) => ipcRenderer.invoke('discord:connect', appId),
  discordDisconnect: () => ipcRenderer.invoke('discord:disconnect'),
  discordSetActivity: (payload) => ipcRenderer.invoke('discord:setActivity', payload),
  discordStatus: () => ipcRenderer.invoke('discord:status'),

  // Stream overlay (OBS browser source)
  twitchOverlayStart: () => ipcRenderer.invoke('twitch:start'),
  twitchOverlayStop: () => ipcRenderer.invoke('twitch:stop'),
  twitchOverlayStatus: () => ipcRenderer.invoke('twitch:status'),
  twitchSetOptions: (opts) => ipcRenderer.invoke('twitch:setOptions', opts),
  twitchSetNowPlaying: (payload) => ipcRenderer.invoke('twitch:setNowPlaying', payload),
  discordLookupArtwork: (query) => ipcRenderer.invoke('discord:lookupArtwork', query),
  discordResolveCoverUrl: (args) => ipcRenderer.invoke('discord:resolveCoverUrl', args),
  getMetadata: (filePath) => ipcRenderer.invoke('file:getMetadata', filePath),
  getPlaybackUrl: (filePath) =>
    `studio-media://studio/play?path=${encodeURIComponent(filePath)}`,
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  addLibraryTracks: (tracks) => ipcRenderer.invoke('library:addTracks', tracks),
  removeLibraryTracks: (ids) => ipcRenderer.invoke('library:removeTracks', ids),
  clearLibrary: (opts) => ipcRenderer.invoke('library:clear', opts),
  updateLibraryTrack: (id, fields) => ipcRenderer.invoke('library:updateTrack', { id, fields }),
  updateLibraryAlbum: (trackIds, fields) => ipcRenderer.invoke('library:updateAlbum', { trackIds, fields }),
  loadAlbumCovers: () => ipcRenderer.invoke('albumCovers:load'),
  setAlbumCoverUrl: (albumKey, url) => ipcRenderer.invoke('albumCovers:set', { albumKey, url }),
  setAlbumCoversBulk: (entries) => ipcRenderer.invoke('albumCovers:setBulk', { entries }),
  clearAlbumCover: (albumKey) => ipcRenderer.invoke('albumCovers:clear', { albumKey }),
  setTrackFavorite: (id, isFavorite) => ipcRenderer.invoke('library:setFavorite', { id, isFavorite }),
  recordTrackPlay: (id, listenedMs = null) => ipcRenderer.invoke('library:recordPlay', { id, listenedMs }),
  /** Refine a play event once the real listening time for it is known. */
  updatePlayEventMs: (eventId, listenedMs) => ipcRenderer.invoke('library:updatePlayEventMs', { eventId, listenedMs }),
  loadPlayEvents: (sinceMs) => ipcRenderer.invoke('library:loadPlayEvents', sinceMs),
  /** How much listening history is attached / recoverable / permanently anonymous. */
  getStatsHealth: () => ipcRenderer.invoke('library:statsHealth'),
  /** Composition of the library — counts, decades, genres, single-track artists. */
  getLibraryOverview: () => ipcRenderer.invoke('library:overview'),
  resetStats: () => ipcRenderer.invoke('library:resetStats'),
  rescanMetadata: () => ipcRenderer.invoke('library:rescanMetadata'),
  refetchTrackMetadata: (trackId) => ipcRenderer.invoke('library:refetchTrackMetadata', trackId),
  onRescanProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('library:rescanProgress', listener);
    return () => ipcRenderer.removeListener('library:rescanProgress', listener);
  },
  loadPlaylists: () => ipcRenderer.invoke('playlists:load'),
  loadPlaylistTrackIds: (playlistId) => ipcRenderer.invoke('playlists:loadTrackIds', playlistId),
  createPlaylist: (fields) => ipcRenderer.invoke('playlists:create', fields),
  updatePlaylist: (id, fields) => ipcRenderer.invoke('playlists:update', { id, fields }),
  deletePlaylist: (id) => ipcRenderer.invoke('playlists:delete', id),
  addTracksToPlaylist: (playlistId, trackIds) => ipcRenderer.invoke('playlists:addTracks', { playlistId, trackIds }),
  renamePlaylist: (id, name) => ipcRenderer.invoke('playlists:rename', { id, name }),
  removeTrackFromPlaylist: (playlistId, trackId) => ipcRenderer.invoke('playlists:removeTrack', { playlistId, trackId }),
  removeTracksFromPlaylist: (playlistId, trackIds) => ipcRenderer.invoke('playlists:removeTracks', { playlistId, trackIds }),
  toolsGetState: () => ipcRenderer.invoke('tools:getState'),
  spotifyGetCredsState: () => ipcRenderer.invoke('spotify:credsState'),
  spotifyGetCredentials: () => ipcRenderer.invoke('spotify:getCreds'),
  spotifySetCredentials: (creds) => ipcRenderer.invoke('spotify:setCreds', creds),
  spotifySearch: (query) => ipcRenderer.invoke('spotify:search', query),
  spotifySearchAlbums: (query) => ipcRenderer.invoke('spotify:searchAlbums', query),
  spotifyGetAlbumTracks: (albumId) => ipcRenderer.invoke('spotify:albumTracks', albumId),
  albumResolveMissing: (params) => ipcRenderer.invoke('album:resolveMissing', params),
  albumConfirmLink: (params) => ipcRenderer.invoke('album:confirmLink', params),
  // Spotify user OAuth (PKCE). Used for reading playlist contents,
  // which client-credentials apps can't do as of Nov 2024.
  spotifyBeginUserAuth: () => ipcRenderer.invoke('spotify:beginUserAuth'),
  spotifyUserAuthState: () => ipcRenderer.invoke('spotify:userAuthState'),
  spotifyDisconnectUser: () => ipcRenderer.invoke('spotify:disconnectUser'),
  spotifyGetMyPlaylists: () => ipcRenderer.invoke('spotify:getMyPlaylists'),
  // Auto-updater
  updateCheckNow: () => ipcRenderer.invoke('update:checkNow'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateGetStatus: () => ipcRenderer.invoke('update:getStatus'),
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  // "What's new" overlay support
  whatsnewGetLastSeen: () => ipcRenderer.invoke('whatsnew:getLastSeen'),
  whatsnewSetLastSeen: (version) => ipcRenderer.invoke('whatsnew:setLastSeen', version),
  whatsnewFetchReleaseNotes: (version) => ipcRenderer.invoke('whatsnew:fetchReleaseNotes', version),
  whatsnewFetchAllReleases: () => ipcRenderer.invoke('whatsnew:fetchAllReleases'),
  // Metadata provider switch notice (Spotify → iTunes fallback)
  onMetadataProviderSwitched: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('metadata:providerSwitched', listener);
    return () => ipcRenderer.removeListener('metadata:providerSwitched', listener);
  },
  // First-run tutorial flag
  tutorialGetSeen: () => ipcRenderer.invoke('tutorial:getSeen'),
  tutorialSetSeen: (seen) => ipcRenderer.invoke('tutorial:setSeen', seen),
  onSpotifyUserAuthChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('spotify:userAuthChanged', listener);
    return () => ipcRenderer.removeListener('spotify:userAuthChanged', listener);
  },
  // Soulseek
  soulseekGetCredsState: () => ipcRenderer.invoke('soulseek:credsState'),
  soulseekGetCredentials: () => ipcRenderer.invoke('soulseek:getCreds'),
  soulseekSetCredentials: (creds) => ipcRenderer.invoke('soulseek:setCreds', creds),
  soulseekStatus: () => ipcRenderer.invoke('soulseek:status'),
  soulseekTest: () => ipcRenderer.invoke('soulseek:test'),
  soulseekDisconnect: () => ipcRenderer.invoke('soulseek:disconnect'),
  soulseekSearch: (query) => ipcRenderer.invoke('soulseek:search', query),
  soulseekDownload: (params) => ipcRenderer.invoke('soulseek:download', params),
  soulseekDownloadAlbum: (params) => ipcRenderer.invoke('soulseek:downloadAlbum', params),
  soulseekCancelDownload: (id) => ipcRenderer.invoke('soulseek:cancelDownload', id),
  soulseekFetchAlbumArt: (queries) => ipcRenderer.invoke('soulseek:fetchAlbumArt', queries),
  // Playlist import
  spotifyFetchPlaylist: (input) => ipcRenderer.invoke('spotify:fetchPlaylist', input),
  playlistDetectConflicts: (tracks) => ipcRenderer.invoke('playlist:detectConflicts', tracks),
  playlistImportBatch: (params) => ipcRenderer.invoke('playlist:importBatch', params),
  onPlaylistImportProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('playlist:importProgress', listener);
    return () => ipcRenderer.removeListener('playlist:importProgress', listener);
  },
  onSoulseekDownloadProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('soulseek:downloadProgress', listener);
    return () => ipcRenderer.removeListener('soulseek:downloadProgress', listener);
  },
  onSoulseekAlbumProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('soulseek:albumProgress', listener);
    return () => ipcRenderer.removeListener('soulseek:albumProgress', listener);
  },
  onImportProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },
  importFromYoutubeSearch: (meta) => ipcRenderer.invoke('import:fromSpotifyYoutube', meta),
  importFromYoutubeId: ({ videoId, meta }) => ipcRenderer.invoke('import:fromYoutubeId', { videoId, meta }),
  searchYoutubeCandidates: (params) => ipcRenderer.invoke('youtube:searchCandidates', params),
  geniusCredits: (params) => ipcRenderer.invoke('genius:credits', params),
  /** Artist profile by name: image, followers, genres. NOT monthly listeners
      or a bio — Spotify's Web API doesn't expose either. */
  spotifyArtistInfo: (name) => ipcRenderer.invoke('spotify:artistInfo', name),
  spotifySearchArtists: (q) => ipcRenderer.invoke('spotify:searchArtists', q),
  spotifyArtistTopTracks: (id, name) => ipcRenderer.invoke('spotify:artistTopTracks', id, name),
  spotifyArtistAlbums: (id) => ipcRenderer.invoke('spotify:artistAlbums', id),
  /* Full Spotify account — see spotifyPartner.js. Every data call resolves to
     { ok, data } or { ok: false, step, error }; nothing throws across IPC. */
  spotifyPartnerState: () => ipcRenderer.invoke('spotifyPartner:state'),
  spotifyPartnerSignIn: () => ipcRenderer.invoke('spotifyPartner:signIn'),
  spotifyPartnerSignOut: () => ipcRenderer.invoke('spotifyPartner:signOut'),
  spotifyPartnerDiagnose: () => ipcRenderer.invoke('spotifyPartner:diagnose'),
  spotifyPartnerArtist: (id) => ipcRenderer.invoke('spotifyPartner:artist', id),
  spotifyPartnerFindArtist: (name) => ipcRenderer.invoke('spotifyPartner:findArtist', name),
  spotifyPartnerAlbumPlays: (id) => ipcRenderer.invoke('spotifyPartner:albumPlays', id),
  spotifyPartnerDiscography: (id) => ipcRenderer.invoke('spotifyPartner:discography', id),
  spotifyPartnerTopTracks: (id) => ipcRenderer.invoke('spotifyPartner:topTracks', id),
  previewResolve: (track) => ipcRenderer.invoke('preview:resolve', track),
  /* Spotify playback (studio-spotify helper). Control only — audio never
     comes through here; the helper plays to the sound card itself. */
  spotifyPlayerState: () => ipcRenderer.invoke('spotifyPlayer:state'),
  spotifyPlayerConnect: () => ipcRenderer.invoke('spotifyPlayer:connect'),
  spotifyPlayerLoad: (id, opts) => ipcRenderer.invoke('spotifyPlayer:load', id, opts),
  spotifyPlayerPreload: (id) => ipcRenderer.invoke('spotifyPlayer:preload', id),
  spotifyPlayerPlay: () => ipcRenderer.invoke('spotifyPlayer:play'),
  spotifyPlayerPause: () => ipcRenderer.invoke('spotifyPlayer:pause'),
  spotifyPlayerStop: () => ipcRenderer.invoke('spotifyPlayer:stop'),
  spotifyPlayerSeek: (ms) => ipcRenderer.invoke('spotifyPlayer:seek', ms),
  spotifyPlayerVolume: (v) => ipcRenderer.invoke('spotifyPlayer:volume', v),
  onSpotifyPlayerEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('spotifyPlayer:event', listener);
    return () => ipcRenderer.removeListener('spotifyPlayer:event', listener);
  },
  spotifyPartnerTrackPlays: (id) => ipcRenderer.invoke('spotifyPartner:trackPlays', id),
  spotifyPartnerLibrary: (kind) => ipcRenderer.invoke('spotifyPartner:library', kind),
  onSpotifyPartnerChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('spotifyPartner:changed', listener);
    return () => ipcRenderer.removeListener('spotifyPartner:changed', listener);
  },
  fetchLyrics: (params) => ipcRenderer.invoke('lyrics:fetch', params),
  saveLyrics: (params) => ipcRenderer.invoke('lyrics:save', params),
  searchAllLyrics: (params) => ipcRenderer.invoke('lyrics:searchAll', params),
  loadCachedReleases: () => ipcRenderer.invoke('releases:loadCached'),
  refreshReleases: (artistNames, mode) => ipcRenderer.invoke('releases:refresh', { artistNames, mode }),
  getReleasesDebug: () => ipcRenderer.invoke('releases:getDebug'),
  loadReleaseOverrides: () => ipcRenderer.invoke('releases:loadOverrides'),
  addFollowedArtist: (artistName, itunesArtistId) => ipcRenderer.invoke('releases:addArtist', artistName, itunesArtistId),
  excludeFollowedArtist: (artistName) => ipcRenderer.invoke('releases:excludeArtist', artistName),
  clearFollowedArtistOverride: (artistName) => ipcRenderer.invoke('releases:clearOverride', artistName),
  lookupReleaseAlbumTracks: (collectionId) => ipcRenderer.invoke('releases:lookupAlbumTracks', collectionId),
  // Apple charts (home) + follow-artist picker search
  fetchCharts: () => ipcRenderer.invoke('charts:fetch'),
  lookupChartSong: (id) => ipcRenderer.invoke('charts:lookupSong', id),
  searchArtistCandidates: (q) => ipcRenderer.invoke('artists:searchCandidates', q),
  /** Wide, landscape header art for an artist page. Spotify's API only has
      the square avatar, so this comes from TheAudioDB. Resolves to null when
      the artist isn't covered — callers fall back to the avatar. */
  artistPortrait: (artistId, name, viewUrl) => ipcRenderer.invoke('artists:portrait', artistId, name, viewUrl),
  /* artistId is optional but strongly preferred: it lets the handler confirm
     the photo belongs to THIS artist and not a namesake, and keys the cache by
     identity rather than by a name two acts might share. */
  artistHeaderImage: (name, artistId) => ipcRenderer.invoke('artists:headerImage', name, artistId),
  /** Real artist portraits for a batch of names. Cached and throttled in the
      main process — safe to call with every artist on screen. */
  artistImages: (names) => ipcRenderer.invoke('artists:images', names),
  /** Per-cover colour overrides — one click beats a better algorithm. */
  /** Where the sampled cover lives, so the tuning lab can load the same file. */
  resolveCoverPath: (url) => ipcRenderer.invoke('covers:resolvePath', url),
  /** Write the exact sampled bytes to Downloads (or a custom dir), embedded artwork included. */
  exportCover: (url, name, dir) => ipcRenderer.invoke('covers:export', { url, name, dir }),
  /** Open a Save As dialog to pick where to export the cover art. */
  exportCoverSaveAs: (url, name) => ipcRenderer.invoke('covers:export', { url, name, saveAs: true }),
  loadCoverColours: () => ipcRenderer.invoke('coverColours:load'),
  setCoverColour: (albumKey, rgb) => ipcRenderer.invoke('coverColours:set', { albumKey, rgb }),
  /** Sample a wash/accent theme from an image, decoded in the main process so
      remote photos aren't at the mercy of the renderer's CORS cache. */
  sampleImageTheme: (url) => ipcRenderer.invoke('images:sampleTheme', url),
  /** Per-artist header overrides: a chosen image and how it's framed. */
  loadArtistHeaders: () => ipcRenderer.invoke('artistHeaders:load'),
  setArtistHeader: (artistKey, fields) => ipcRenderer.invoke('artistHeaders:set', { artistKey, ...fields }),
  clearArtistHeader: (artistKey) => ipcRenderer.invoke('artistHeaders:clear', { artistKey }),
  getArtistInfo: (artists) => ipcRenderer.invoke('artists:info', artists),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  fullscreen: () => ipcRenderer.send('window:fullscreen'),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  onFullscreenChanged: (cb) => {
    // Returns an unsubscribe function so the React effect can clean up
    // on unmount without leaking ipcRenderer listeners.
    const handler = (_evt, isFs) => cb(!!isFs);
    ipcRenderer.on('window:fullscreenChanged', handler);
    return () => ipcRenderer.removeListener('window:fullscreenChanged', handler);
  },
  close: () => ipcRenderer.send('window:close'),

  /* ---------------------------------------------------------------------
   * Mini player.
   *
   * Grouped rather than flattened because BOTH renderers use this object:
   * the main window (publish + onCommand + open/close) and the mini window
   * itself (onState + setOptions + resizeTo). Same preload, same bundle,
   * different halves — keeping them under one key makes it obvious which
   * calls belong to which side when you're reading MiniPlayer.jsx.
   * ------------------------------------------------------------------- */
  mini: {
    // --- main window side ---
    open: () => ipcRenderer.invoke('mini:open'),
    close: () => ipcRenderer.invoke('mini:close'),
    toggle: () => ipcRenderer.invoke('mini:toggle'),
    publish: (payload) => ipcRenderer.send('mini:publish', payload),
    onCommand: (cb) => {
      const l = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:command', l);
      return () => ipcRenderer.removeListener('mini:command', l);
    },
    onOpenChanged: (cb) => {
      const l = (_e, open) => cb(!!open);
      ipcRenderer.on('mini:openChanged', l);
      return () => ipcRenderer.removeListener('mini:openChanged', l);
    },
    onNeedState: (cb) => {
      const l = () => cb();
      ipcRenderer.on('mini:needState', l);
      return () => ipcRenderer.removeListener('mini:needState', l);
    },

    // --- mini window side ---
    command: (cmd) => ipcRenderer.send('mini:command', cmd),
    requestState: () => ipcRenderer.send('mini:requestState'),
    resizeTo: (size) => ipcRenderer.invoke('mini:resizeTo', size),
    snap: (corner) => ipcRenderer.invoke('mini:snap', corner),
    setPanelOpen: (open) => ipcRenderer.invoke('mini:setPanelOpen', !!open),
    setClickThroughLive: (on) => ipcRenderer.send('mini:setClickThroughLive', !!on),
    onState: (cb) => {
      const l = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:state', l);
      return () => ipcRenderer.removeListener('mini:state', l);
    },

    // --- both ---
    getState: () => ipcRenderer.invoke('mini:getState'),
    setOptions: (patch) => ipcRenderer.invoke('mini:setOptions', patch),
    onOptions: (cb) => {
      const l = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:options', l);
      return () => ipcRenderer.removeListener('mini:options', l);
    },
  },
});
