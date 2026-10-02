/* =========================================================================
 *  studio — the player bar's stand-in <audio> element for Spotify tracks
 *
 *  App.jsx drives playback through an HTMLAudioElement: it sets src, calls
 *  play()/pause(), reads and writes currentTime and volume, and listens for
 *  play / pause / timeupdate / seeked / ended. This class speaks that same
 *  subset but forwards everything to the studio-spotify helper (through
 *  spotifyPlayer.js in main), so a Saved track plays from the same player
 *  bar, queue, and keyboard shortcuts as a local file, without
 *  a second code path through the app.
 *
 *  Audio never passes through here: the helper plays to the sound card. So
 *  there is no Web Audio graph for these tracks: the visualisers idle and
 *  volume boost doesn't apply.
 *
 *  Position: the helper reports every 500 ms; between reports the position
 *  is extrapolated from the last one, the way a real element's currentTime
 *  advances between its own timeupdate events.
 * ========================================================================= */

const SPOTIFY_PREFIX = 'spotify:track:';

/** The Spotify track id of a Saved (streamed) library row, else null. */
export function spotifyIdOf(track) {
  const p = track?.filePath;
  return typeof p === 'string' && p.startsWith(SPOTIFY_PREFIX) ? p.slice(SPOTIFY_PREFIX.length) : null;
}

/* ---- preloading ------------------------------------------------------
 * librespot holds one preloaded track. Loading that track afterwards skips
 * every network round-trip (metadata, key, file, first chunk), so playback
 * starts at once. Studio asks for it the way Sonora does: when the pointer
 * rests on a row for a moment, and for the next track in the queue near the
 * end of the current one. */

let preloaded = null;
let currentId = null;
/* Every preload asks Spotify for a decryption key, and Spotify refuses keys
   "for now" under a burst of them, after which every load fails until it
   eases off. So preloads stand aside while a real load is in flight (it
   needs the key more), and for a while after any refusal. */
let loadInFlight = false;
let quietUntil = 0;
let lastPreloadAt = 0;
const failedPreloads = new Set();   // never asked for again this session
const QUIET_AFTER_THROTTLE_MS = 60_000;
const PRELOAD_GAP_MS = 1500;

/* Load pacing, Sonora's numbers. Skips closer together than SKIP_DEBOUNCE
   load only once the skipping stops, so tapping next five times asks for one
   key, not five; after a load fails the next one waits KEY_COOLDOWN. */
const SKIP_DEBOUNCE_MS = 250;
const KEY_COOLDOWN_MS = 1000;
let lastLoadAt = 0;
let blockedUntil = 0;

/** Ask the helper to fetch a Saved track ahead. No-op for local files, the
 *  playing track, the one already preloaded, or one whose preload failed. */
export function preloadStreamed(track) {
  const id = spotifyIdOf(track) || (typeof track === 'string' ? track : null);
  if (!id || id === preloaded || id === currentId || failedPreloads.has(id)) return;
  const now = Date.now();
  if (loadInFlight || now < quietUntil || now - lastPreloadAt < PRELOAD_GAP_MS) return;
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api?.spotifyPlayerPreload) return;
  preloaded = id;
  lastPreloadAt = now;
  api.spotifyPlayerPreload(id)?.catch?.(() => { if (preloaded === id) preloaded = null; });
}

const HOVER_PRELOAD_MS = 200;

/** onMouseEnter / onMouseLeave for a row's play button / number cell (not
 *  the whole row, as in Sonora): preload after a short rest there, so moving
 *  the pointer around a list doesn't fetch anything. */
let hoverTimer = null;
const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
/* One pointer, one pending hover: the timer lives here rather than per row,
   so a row re-rendering mid-hover can't leave an orphaned timer behind. */
export function hoverPreload(track) {
  if (!spotifyIdOf(track)) return null;
  return {
    onMouseEnter: () => { cancelHover(); hoverTimer = setTimeout(() => preloadStreamed(track), HOVER_PRELOAD_MS); },
    onMouseLeave: cancelHover,
  };
}

const TICK_MS = 250;
/* Retries after a throttled refusal, as Sonora: 2, 4, 8, 16, 30, 30 s, then
   wait for the user to press play. */
const THROTTLE_RETRIES = 6;
const throttleWait = (n) => Math.min(30_000, 2000 * 2 ** (n - 1));

export class SpotifyMediaElement extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.isSpotify = true;
    this.preload = 'auto';
    this.id = null;
    this._duration = NaN;
    this._pos = 0;           // seconds, as of _at
    this._at = 0;            // performance.now() when _pos was sampled
    this._running = false;   // helper says audio is actually coming out
    this._paused = true;     // what the app asked for
    this._pending = null;    // { positionMs } — load not yet sent to the helper
    this._volume = 1;
    this._ended = false;
    this._tick = null;
    this._throttles = 0;     // throttled refusals in a row for this track
    this._retry = null;      // pending retry after one
    this._send = null;       // load held back by the skip debounce / cooldown
    this._off = api?.onSpotifyPlayerEvent?.((ev) => this._onEvent(ev)) || null;
  }

  /* ---- HTMLMediaElement surface ------------------------------------- */

  get src() { return this.id ? `${SPOTIFY_PREFIX}${this.id}` : ''; }
  set src(v) { if (!v) this.unload(); }

  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get duration() { return this._duration; }
  /* 4 = HAVE_ENOUGH_DATA once loaded. Nothing in App preloads a Spotify
     track into the standby element, so this only gates "is anything here". */
  get readyState() { return this.id ? 4 : 0; }

  get currentTime() {
    if (!this._running) return this._pos;
    const t = this._pos + (performance.now() - this._at) / 1000;
    return Number.isFinite(this._duration) && this._duration > 0 ? Math.min(t, this._duration) : t;
  }

  set currentTime(sec) {
    const t = Math.max(0, Number(sec) || 0);
    this._emit('seeking');
    this._setPos(t);
    this._ended = false;
    const ms = Math.round(t * 1000);
    this._seamless = false;
    if (this._pending) this._pending.positionMs = ms;
    else if (this.id) this._call(() => this.api.spotifyPlayerSeek(ms));
    this._emit('timeupdate');
    this._emit('seeked');
  }

  get volume() { return this._volume; }
  set volume(v) {
    const n = Math.max(0, Math.min(1, Number(v) || 0));
    if (n === this._volume) return;
    this._volume = n;
    this.api?.spotifyPlayerVolume?.(n)?.catch?.(() => {});
    this._emit('volumechange');
  }

  /** Stage a track. Nothing is sent until play() so a load + play is one
   *  command to the helper, not two. */
  loadTrack(id, durationSec = 0) {
    /* Straight after the previous track ended, its last half-second is
       still in the helper's output queue: let it play into this one. Any
       other load (a skip, a click) cuts the old audio off at once. */
    this._seamless = this._ended;
    this.id = String(id || '') || null;
    currentId = this.id;
    this._cancelTimers();
    this._throttles = 0;
    // Loading consumes the helper's preload slot either way.
    preloaded = null;
    this._pending = { positionMs: 0 };
    this._running = false;
    this._paused = true;
    this._ended = false;
    this._setPos(0);
    this._duration = durationSec > 0 ? durationSec : NaN;
    this._stopTick();
    if (this._duration > 0) {
      this._emit('durationchange');
      this._emit('loadedmetadata');
    }
    this._emit('timeupdate');
  }

  load() { /* HTMLMediaElement.load(): staging happens in loadTrack */ }

  play() {
    if (!this.id) return Promise.resolve();
    const wasPaused = this._paused;
    this._paused = false;
    this._ended = false;
    if (wasPaused) this._emit('play');
    if (this._pending) {
      const now = Date.now();
      const wait = Math.max(blockedUntil - now, now - lastLoadAt < SKIP_DEBOUNCE_MS ? SKIP_DEBOUNCE_MS : 0);
      lastLoadAt = now;
      clearTimeout(this._send);
      if (wait > 0) {
        // A newer loadTrack/pause/unload cancels this, so a burst of skips
        // sends only the track the user lands on.
        this._send = setTimeout(() => { this._send = null; if (!this._paused) this._sendLoad(); }, wait);
        return Promise.resolve();
      }
      return this._sendLoad();
    }
    return this._call(() => this.api.spotifyPlayerPlay());
  }

  _sendLoad() {
    if (!this.id || !this._pending) return Promise.resolve();
    const { positionMs } = this._pending;
    const cut = !this._seamless;
    this._pending = null;
    this._seamless = false;
    lastLoadAt = Date.now();
    // The helper's mixer starts at 50% and forgets on restart, so every
    // fresh load carries the current volume ahead of it.
    this.api?.spotifyPlayerVolume?.(this._volume)?.catch?.(() => {});
    loadInFlight = true;
    return this._call(() => this.api.spotifyPlayerLoad(this.id, { play: true, positionMs, cut }));
  }

  _cancelTimers() {
    clearTimeout(this._retry);
    clearTimeout(this._send);
    this._retry = null;
    this._send = null;
  }

  pause() {
    this._cancelTimers();
    if (this._paused) return;
    this._freeze();
    this._paused = true;
    this._emit('pause');
    if (!this._pending && this.id) this._call(() => this.api.spotifyPlayerPause());
  }

  /** Stop the helper and forget the track (src = ''). */
  unload() {
    const had = this.id && !this._pending;
    currentId = null;
    loadInFlight = false;
    this._cancelTimers();
    this._freeze();
    this._stopTick();
    this.id = null;
    this._pending = null;
    this._paused = true;
    this._running = false;
    this._duration = NaN;
    if (had) this.api?.spotifyPlayerStop?.()?.catch?.(() => {});
  }

  destroy() {
    this.unload();
    try { this._off?.(); } catch { /* ignore */ }
    this._off = null;
  }

  // Unused parts of the element API that callers probe for.
  addTextTrack() { return null; }
  canPlayType() { return ''; }

  /* ---- helper events -------------------------------------------------- */

  _onEvent(ev) {
    if (!ev || ev.event === 'status') {
      // The helper failed to start or sign in while we're trying to play.
      if (ev?.status === 'error' && this.id && !this._paused) this._fail(ev.error?.message);
      return;
    }
    if (ev.event === 'error') { if (this.id && !this._paused) this._fail(ev.message); return; }
    if (ev.event === 'reconnected') {
      // A fresh session: whatever was preloaded is gone, and the song that
      // was playing (or failing to load) starts again where it was.
      preloaded = null;
      loadInFlight = false;
      if (this.id && !this._paused) {
        clearTimeout(this._retry);
        this._retry = null;
        this._throttles = 0;
        this._pending = { positionMs: Math.round(this._pos * 1000) };
        this.play();
      }
      return;
    }
    if (ev.event === 'unavailable') {
      // Any refusal or server failure, even of a preload, means Spotify
      // wants fewer requests.
      const retryable = ev.throttled || ev.transient;
      if (retryable) quietUntil = Date.now() + QUIET_AFTER_THROTTLE_MS;
      if (ev.id === preloaded) {
        preloaded = null;
        if (!retryable) failedPreloads.add(ev.id);
      }
    }
    if (!this.id || ev.id !== this.id || this._pending) return;
    const pos = typeof ev.positionMs === 'number' ? ev.positionMs / 1000 : null;
    switch (ev.event) {
      case 'track':
        if (ev.durationMs > 0 && !(Math.abs(ev.durationMs / 1000 - this._duration) < 1)) {
          this._duration = ev.durationMs / 1000;
          this._emit('durationchange');
          this._emit('loadedmetadata');
        }
        return;
      case 'loading':
        this._running = false;
        if (pos != null) this._setPos(pos);
        return;
      case 'playing':
        loadInFlight = false;
        this._throttles = 0;
        if (pos != null) this._setPos(pos);
        this._running = true;
        this._startTick();
        if (this._paused) { this._paused = false; this._emit('play'); }
        this._emit('playing');
        this._emit('timeupdate');
        return;
      case 'paused':
        if (pos != null) this._setPos(pos);
        this._running = false;
        this._stopTick();
        if (!this._paused) { this._paused = true; this._emit('pause'); }
        this._emit('timeupdate');
        return;
      case 'position':
      case 'seeked':
        if (pos != null) this._setPos(pos);
        this._emit('timeupdate');
        return;
      case 'ended':
        this._freeze();
        this._stopTick();
        this._running = false;
        this._paused = true;
        this._ended = true;
        if (Number.isFinite(this._duration)) this._pos = this._duration;
        // The helper is done with it; playing again (repeat one) reloads.
        this._pending = { positionMs: 0 };
        this._emit('timeupdate');
        this._emit('ended');
        return;
      case 'stopped':
        // Only surprising stops matter (helper restarted, signed out); ours
        // come from unload() after the id is already cleared.
        this._freeze();
        this._stopTick();
        this._running = false;
        this._pending = { positionMs: Math.round(this._pos * 1000) };
        if (!this._paused) { this._paused = true; this._emit('pause'); }
        return;
      case 'unavailable':
        this._unavailable(ev);
        return;
      default:
    }
  }

  /* A load that failed. Three different things, handled the way Sonora does:
   *   throttled — Spotify refused the decryption key for now (too many loads
   *               close together). Wait and ask for the SAME track again, the
   *               wait doubling each time. Skipping ahead would only ask for
   *               more keys and keep the refusal going — which is what made
   *               every song in the queue fail in turn.
   *   transient — Spotify's servers failed (a 503 from the metadata service,
   *               a timeout). Nothing wrong with the track: same as throttled.
   *   denied    — refused for good this session. Stop and say so.
   *   otherwise — this one track can't play; the app skips it. */
  _unavailable(ev) {
    loadInFlight = false;
    const id = this.id;
    const reason = ev.reason ? ` (${ev.reason})` : '';
    if (ev.denied) {
      this._fail('Spotify refused to play for this account', 'denied',
        `Spotify turned down the decryption key for this track${reason}, and won't hand out more this session. Restart Studio; if it keeps happening, sign in to Spotify again in Settings → Connections.`);
      return;
    }
    if (ev.throttled || ev.transient) {
      this._throttles += 1;
      if (this._throttles > THROTTLE_RETRIES) {
        this._fail(ev.throttled ? 'Spotify paused playback for now' : 'Spotify’s servers aren’t answering', 'throttled',
          ev.throttled
            ? 'Too many songs were loaded close together, so Spotify is refusing to start more for a little while. Studio retried for about a minute and a half. Wait a minute, then press play.'
            : `Spotify's servers kept failing to load the song${reason}. Nothing is wrong with the song or your account. Wait a minute, then press play.`);
        return;
      }
      const wait = throttleWait(this._throttles);
      this._freeze();
      this._stopTick();
      this._running = false;
      this._pending = { positionMs: Math.round(this._pos * 1000) };
      if (this._throttles === 1) {
        this._notice(ev.throttled ? 'Spotify is slowing playback down, retrying…' : 'Spotify’s servers are busy, retrying…', 'retrying',
          ev.throttled
            ? 'Spotify refused the song for a moment because several were loaded close together. Studio waits and tries the same song again (2, 4, 8… seconds), without skipping it.'
            : `Spotify's servers failed to load the song${reason}. Studio waits and tries again (2, 4, 8… seconds), without skipping it.`);
      }
      clearTimeout(this._retry);
      this._retry = setTimeout(() => {
        this._retry = null;
        if (this.id === id && !this._paused && this._pending) this.play();
      }, wait);
      return;
    }
    blockedUntil = Date.now() + KEY_COOLDOWN_MS;
    // librespot's wording is for the terminal, not a toast.
    if (ev.reason) console.warn(`[spotify] ${ev.id} unavailable:`, ev.reason);
    this._fail('Spotify couldn’t play this song, skipped it', 'unavailable',
      `Spotify says this song isn't available to play${reason ? ` (${ev.reason})` : ''}. It may be region-locked, removed, or only playable as another version. Studio moved on to the next song.`);
  }

  /* ---- internals ------------------------------------------------------ */

  /** Tell the app something without stopping (a toast, no skip). */
  _notice(message, code, detail = '') {
    const e = new Event('error');
    e.message = message;
    e.code = code;
    e.detail = detail;
    e.transient = true;
    this.dispatchEvent(e);
  }

  _fail(message, code = 'helper', detail = '') {
    loadInFlight = false;
    this._freeze();
    this._stopTick();
    this._running = false;
    // Pressing play again retries from here with a fresh load.
    if (this.id) this._pending = { positionMs: Math.round(this._pos * 1000) };
    if (!this._paused) { this._paused = true; this._emit('pause'); }
    const e = new Event('error');
    e.message = String(message || 'Spotify playback failed.');
    e.code = code;
    e.detail = detail;
    this.dispatchEvent(e);
  }

  async _call(fn) {
    try {
      const r = await fn();
      if (r && r.ok === false) this._fail(r.error);
    } catch (e) {
      this._fail(e?.message || e);
    }
  }

  _setPos(sec) { this._pos = sec; this._at = performance.now(); }
  _freeze() { this._setPos(this.currentTime); }

  _startTick() {
    if (this._tick) return;
    this._tick = setInterval(() => { if (this._running) this._emit('timeupdate'); }, TICK_MS);
  }

  _stopTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _emit(type) { this.dispatchEvent(new Event(type)); }
}
