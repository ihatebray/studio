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
  setTrackFavorite: (id, isFavorite) => ipcRenderer.invoke('library:setFavorite', { id, isFavorite }),
  recordTrackPlay: (id, listenedMs = null) => ipcRenderer.invoke('library:recordPlay', { id, listenedMs }),
  /** Refine a play event once the real listening time for it is known. */
  updatePlayEventMs: (eventId, listenedMs) => ipcRenderer.invoke('library:updatePlayEventMs', { eventId, listenedMs }),
  loadPlayEvents: (sinceMs) => ipcRenderer.invoke('library:loadPlayEvents', sinceMs),
  /** How much listening history is attached / recoverable / permanently anonymous. */
  getStatsHealth: () => ipcRenderer.invoke('library:statsHealth'),
  /** Composition of the library — counts, decades, genres, single-track artists. */
  getLibraryOverview: () => ipcRenderer.invoke('library:overview'),
  refetchTrackMetadata: (trackId) => ipcRenderer.invoke('library:refetchTrackMetadata', trackId),
  /** The library changed in the background (missing details filled in). */
  onLibraryChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
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
  spotifyGetCredsState: () => ipcRenderer.invoke('spotify:credsState'),
  spotifySetCredentials: (creds) => ipcRenderer.invoke('spotify:setCreds', creds),
  spotifySearch: (query) => ipcRenderer.invoke('spotify:search', query),
  spotifySearchAlbums: (query) => ipcRenderer.invoke('spotify:searchAlbums', query),
  spotifyGetAlbumTracks: (albumId) => ipcRenderer.invoke('spotify:albumTracks', albumId),
  // Spotify user OAuth (PKCE). Used for reading playlist contents,
  // which client-credentials apps can't do as of Nov 2024.
  spotifyBeginUserAuth: () => ipcRenderer.invoke('spotify:beginUserAuth'),
  spotifyUserAuthState: () => ipcRenderer.invoke('spotify:userAuthState'),
  spotifyGetMyPlaylists: () => ipcRenderer.invoke('spotify:getMyPlaylists'),
  /* Updates from GitHub Releases (updater.js). Status:
     { state, current, version, notes, url, error, checkedAt, canInstall } */
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateGetStatus: () => ipcRenderer.invoke('update:getStatus'),
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  /** Reload what changed (window, Spotify helper) or, with full / a rebuilt
   *  main process, restart the app. Resolves { mode: 'reload' | 'restart' }. */
  appReload: (opts) => ipcRenderer.invoke('app:reload', opts),
  // "What's new" overlay support
  whatsnewGetLastSeen: () => ipcRenderer.invoke('whatsnew:getLastSeen'),
  whatsnewSetLastSeen: (version) => ipcRenderer.invoke('whatsnew:setLastSeen', version),
  /* Behind-the-scenes problems from main (notices.js): rate limits,
     fallbacks, the playback helper. { key, kind, title, detail, source, at } */
  onAppNotice: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('app:notice', listener);
    return () => ipcRenderer.removeListener('app:notice', listener);
  },
  onSpotifyUserAuthChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('spotify:userAuthChanged', listener);
    return () => ipcRenderer.removeListener('spotify:userAuthChanged', listener);
  },
  // Soulseek
  soulseekGetCredsState: () => ipcRenderer.invoke('soulseek:credsState'),
  soulseekSetCredentials: (creds) => ipcRenderer.invoke('soulseek:setCreds', creds),
  soulseekStatus: () => ipcRenderer.invoke('soulseek:status'),
  soulseekTest: () => ipcRenderer.invoke('soulseek:test'),
  soulseekDisconnect: () => ipcRenderer.invoke('soulseek:disconnect'),
  soulseekSearch: (query) => ipcRenderer.invoke('soulseek:search', query),
  soulseekDownload: (params) => ipcRenderer.invoke('soulseek:download', params),
  soulseekDownloadAlbum: (params) => ipcRenderer.invoke('soulseek:downloadAlbum', params),
  soulseekCancelDownload: (id) => ipcRenderer.invoke('soulseek:cancelDownload', id),
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
  /* Get is now Save: every caller that used to download through YouTube
     adds a streamed library row and hearts the track on Spotify instead. */
  importFromYoutubeSearch: (meta) => ipcRenderer.invoke('library:saveSpotify', meta),
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
  spotifyPartnerDiscography: (id) => ipcRenderer.invoke('spotifyPartner:discography', id),
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
  spotifyPlayerBoost: (v) => ipcRenderer.invoke('spotifyPlayer:boost', v),
  onSpotifyPlayerEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('spotifyPlayer:event', listener);
    return () => ipcRenderer.removeListener('spotifyPlayer:event', listener);
  },
  /* My Spotify pages (spotifyFeed.js). Each resolves { ok, data | error }. */
  spotifyFeedPeek: (key) => ipcRenderer.invoke('spotifyFeed:peek', key),
  spotifyFeedHome: (force) => ipcRenderer.invoke('spotifyFeed:home', force),
  spotifyFeedStudio: () => ipcRenderer.invoke('spotifyFeed:studio'),
  /* A Spotify song played past the halfway mark in Studio (listening.js). */
  recordListen: (track) => ipcRenderer.invoke('listening:record', track),
  /* Artists followed in Studio (follows.js), not on Spotify. */
  followsList: () => ipcRenderer.invoke('follows:list'),
  // Albums on the way from artists followed in Studio (countdowns.js).
  countdownsList: (force = false) => ipcRenderer.invoke('countdowns:list', { force }),
  followsAdd: (artist) => ipcRenderer.invoke('follows:add', artist),
  followsRemove: (id) => ipcRenderer.invoke('follows:remove', id),
  onFollowsChanged: (cb) => {
    const listener = (_event, list) => cb(list);
    ipcRenderer.on('follows:changed', listener);
    return () => ipcRenderer.removeListener('follows:changed', listener);
  },
  /* Spotify-followed artists left out of New Releases in Studio. */
  followsHidden: () => ipcRenderer.invoke('follows:hidden'),
  followsSetHidden: (artist, hidden) => ipcRenderer.invoke('follows:setHidden', artist, hidden),
  onFollowsHiddenChanged: (cb) => {
    const listener = (_event, list) => cb(list);
    ipcRenderer.on('follows:hiddenChanged', listener);
    return () => ipcRenderer.removeListener('follows:hiddenChanged', listener);
  },
  spotifyFeedReleases: (force) => ipcRenderer.invoke('spotifyFeed:releases', force),
  spotifyFeedPlaylist: (id, opts) => ipcRenderer.invoke('spotifyFeed:playlist', id, opts),
  spotifyFeedMyPlaylists: () => ipcRenderer.invoke('spotifyFeed:myPlaylists'),
  spotifyFeedPlaylistMeta: (id) => ipcRenderer.invoke('spotifyFeed:playlistMeta', id),
  saveSpotifyMany: (metas) => ipcRenderer.invoke('library:saveSpotifyMany', metas),
  spotifyFeedLiked: (opts) => ipcRenderer.invoke('spotifyFeed:liked', opts),
  /* Spotify links (spotifyLinks.js). fromClipboard: the clipboard's link,
     { kind, id } or null. resolve: a link in some text, looked up as
     { kind, id, name, sub, image, album?, rows? }. */
  spotifyLinkFromClipboard: () => ipcRenderer.invoke('spotifyLink:fromClipboard'),
  spotifyLinkResolve: (text) => ipcRenderer.invoke('spotifyLink:resolve', text),
  spotifyLinkWatch: (on) => ipcRenderer.invoke('spotifyLink:watch', on),
  onSpotifyLinkCopied: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('spotifyLink:copied', listener);
    return () => ipcRenderer.removeListener('spotifyLink:copied', listener);
  },
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
  loadReleaseOverrides: () => ipcRenderer.invoke('releases:loadOverrides'),
  addFollowedArtist: (artistName, itunesArtistId) => ipcRenderer.invoke('releases:addArtist', artistName, itunesArtistId),
  excludeFollowedArtist: (artistName) => ipcRenderer.invoke('releases:excludeArtist', artistName),
  clearFollowedArtistOverride: (artistName) => ipcRenderer.invoke('releases:clearOverride', artistName),
  lookupReleaseAlbumTracks: (collectionId) => ipcRenderer.invoke('releases:lookupAlbumTracks', collectionId),
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
  fullscreen: () => ipcRenderer.send('window:fullscreen'),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximized: (cb) => {
    const listener = (_e, value) => cb(value);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  close: () => ipcRenderer.send('window:close'),
});
