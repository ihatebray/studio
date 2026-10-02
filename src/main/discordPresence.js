/**
 * Discord rich presence — main-process module that connects to the
 * local Discord client over its IPC socket and broadcasts the
 * currently-playing track to the user's Discord status.
 *
 * Uses the `@ryuziii/discord-rpc` package.
 *
 * Lifecycle:
 *   - connect(appId)          → opens the IPC connection and waits for
 *                                Discord's READY ack. Idempotent;
 *                                reconnects if the appId changes.
 *   - setActivity(payload)    → updates the displayed activity.
 *                                payload null clears it.
 *   - disconnect()            → tears down the connection.
 *
 * Failure modes (all silent — Discord unavailable should never break
 * the music player):
 *   - Discord client not running → connect() fails; setActivity is
 *     queued so the next successful connect picks it up.
 *   - IPC socket disconnects mid-session → next setActivity attempts
 *     to reconnect.
 *   - Invalid app ID → Discord throws on first setActivity; we mark
 *     the ID as bad and stop trying until the user changes it.
 *
 * Throttling: Discord rate-limits SET_ACTIVITY to 5 updates per 20s on
 * its end. The `@ryuziii/discord-rpc` library ALSO has a client-side
 * 1500ms gate that **silently drops** any update sent during the
 * cooldown — without throwing, without queueing, without any signal.
 * That breaks rapid track-skip: the first skip lands, every subsequent
 * one within 1.5s vanishes. We disable the client-side gate
 * (setActivityRateLimit(0)) and replace it with our own 100ms coalescing
 * window: if multiple updates arrive in a burst, only the last one is
 * sent. Combined with the renderer only pushing on track / play-state
 * changes, this stays well under Discord's actual 5/20s limit even
 * during heavy skipping.
 *
 * Activity shape note: although the @ryuziii/discord-rpc README shows
 * flat keys like `largeImageKey`, the library does NOT transform them —
 * its `setActivity` forwards the object verbatim to Discord's IPC. The
 * Discord RPC protocol expects the nested form: `assets.large_image`,
 * `assets.small_image`, `timestamps.start`, etc. So we send the nested
 * form. Unknown top-level fields (like flat keys) are silently ignored
 * by Discord, which is why the README example "works" — it just doesn't
 * actually populate any image.
 *
 * Cover-art URL note: Discord's media proxy fetches `assets.large_image`
 * URLs server-side, so any public http(s) URL works (Spotify CDN,
 * iTunes, Imgur, etc.). It cannot fetch `data:` URIs (embedded ID3 art),
 * `file://` paths, or custom protocols like `studio-cover://`. For local
 * tracks with only embedded art, we fall back to the registered asset
 * key `immerse_logo` — that key MUST exist under Rich Presence → Art
 * Assets in your Discord developer portal, otherwise the large image
 * will be blank. Same for the `play` and `pause` small-icon keys.
 */

let RPC = null;

async function loadRpcModule() {
  if (RPC) return RPC;
  try {
    // Loaded lazily so the app still boots if the dependency is missing.
    // This MUST NOT be top-level await because Forge/Vite emits CJS for the main bundle.
    const mod = await import('@ryuziii/discord-rpc');
    RPC = mod.default || mod;
    return RPC;
  } catch (e) {
    // Preserve the real error for the UI to display (missing module vs bad import vs other failure).
    lastError = String(e?.message || e);
    RPC = null;
    return null;
  }
}

let client = null;          // active RPC.Client instance, or null
let currentAppId = null;    // appId of the active client
let isReady = false;        // true once Discord has acknowledged the handshake
let pendingActivity = null; // latest activity stashed for next ready/connect (coalesced)
let lastError = null;       // last reported error, for the renderer to query
let invalidAppIdMarker = null; // appId we've confirmed is invalid

// Coalescing window — collapse rapid setActivity bursts into one send.
// 100ms is short enough to feel instant on track skip, long enough to
// absorb React effect re-runs (e.g. a track change firing one effect for
// the new id and another for the play-state).
const COALESCE_MS = 100;
let coalesceTimer = null;
let coalescedActivity = null;

function buildClient(Rpc, appId) {
  // @ryuziii/discord-rpc API
  if (typeof Rpc?.DiscordRPCClient === 'function') {
    const c = new Rpc.DiscordRPCClient({ clientId: appId, transport: 'ipc' });
    // The library defaults to a 1500ms internal rate limit that SILENTLY
    // drops any update inside the window. That breaks rapid track skip —
    // the second skip vanishes with no error. Disable it; we coalesce
    // ourselves and Discord's actual server-side limit is 5/20s.
    if (typeof c.setActivityRateLimit === 'function') {
      c.setActivityRateLimit(0);
    }
    return c;
  }
  // Back-compat with legacy discord-rpc API
  if (typeof Rpc?.Client === 'function') {
    return new Rpc.Client({ transport: 'ipc' });
  }
  throw new Error('Unsupported Discord RPC module API');
}

async function connect(appId) {
  const Rpc = await loadRpcModule();
  if (!Rpc) {
    lastError = lastError || 'Discord RPC module unavailable';
    return { ok: false, error: lastError };
  }
  if (!appId || typeof appId !== 'string') {
    lastError = 'no app id';
    return { ok: false, error: lastError };
  }
  // Already connected with the same appId — nothing to do.
  if (client && currentAppId === appId && isReady) {
    return { ok: true };
  }
  // Different appId or stale connection — tear down and rebuild.
  await disconnect();
  // If the user already proved this appId was invalid, don't re-try
  // until they change it (avoids spam-logging on every track change).
  if (invalidAppIdMarker && invalidAppIdMarker === appId) {
    return { ok: false, error: 'invalid app id' };
  }
  try {
    client = buildClient(Rpc, appId);
    currentAppId = appId;

    // Wait for Discord to actually ACK the handshake before considering
    // the connection usable. The library sets `client.connected = true`
    // as soon as the socket opens (BEFORE Discord processes the v1/
    // client_id handshake), so sending an activity right after
    // `client.connect()` resolves can race the handshake and get
    // silently dropped on Discord's side. The `'ready'` event fires
    // after Discord has sent back the READY frame.
    const readyPromise = new Promise((resolve, reject) => {
      const onReady = () => {
        client.off?.('error', onError);
        resolve();
      };
      const onError = (err) => {
        client.off?.('ready', onReady);
        reject(err);
      };
      client.once?.('ready', onReady);
      client.once?.('error', onError);
      // Hard timeout so a hung Discord IPC doesn't block forever.
      const t = setTimeout(() => {
        client?.off?.('ready', onReady);
        client?.off?.('error', onError);
        reject(new Error('Discord handshake timed out'));
      }, 10000);
      t.unref?.();
    });

    if (typeof client.on === 'function') {
      client.on('ready', () => {
        isReady = true;
        lastError = null;
      });
      client.on('disconnected', () => {
        console.log('[discord] disconnected');
        isReady = false;
        lastError = 'discord disconnected';
      });
      client.on('error', (e) => {
        const msg = String(e?.message || e);
        console.log('[discord] socket error:', msg);
        lastError = msg;
      });
      // Discord IPC echoes every SET_ACTIVITY back with the activity AS
      // IT WAS STORED. For external image URLs, Discord rewrites the
      // large_image to a `mp:external/<token>/https/<host>/<path>` form;
      // if the rewritten value is missing, Discord couldn't fetch the
      // URL (host blocked, bad cert, 404, etc) and the cover will be
      // blank. Logging the echo makes silent failures visible without
      // having to dig into IPC traffic.
      client.on('activityUpdate', (data) => {
        const stored = data?.data?.assets?.large_image;
        if (stored) {
          const preview = String(stored).length > 80
            ? `${String(stored).slice(0, 77)}...`
            : String(stored);
          console.log(`[discord] activity stored: large_image=${preview}`);
        } else if (data?.evt === 'ERROR') {
          console.log('[discord] activity REJECTED:', JSON.stringify(data));
        }
      });
    }

    // The library's `connect()` resolves on socket open + handshake
    // write, NOT on the READY frame. Kick it off, then wait for ready.
    if (typeof client.login === 'function') {
      await client.login({ clientId: appId });
    } else if (typeof client.connect === 'function') {
      await client.connect();
    } else {
      throw new Error('RPC client has no connect/login method');
    }

    await readyPromise;

    isReady = true;
    lastError = null;
    invalidAppIdMarker = null;

    // Flush any activity that was queued while we were disconnected.
    // We only keep the LATEST one — older ones are stale by definition.
    const flush = pendingActivity;
    pendingActivity = null;
    if (flush) {
      await applyActivity(flush);
    }
    return { ok: true };
  } catch (e) {
    lastError = String(e?.message || e);
    if (/invalid client id/i.test(lastError) || /unknown application/i.test(lastError)) {
      invalidAppIdMarker = appId;
    }
    // Tear down anything half-built.
    try { client?.disconnect?.(); } catch { /* ignore */ }
    client = null;
    currentAppId = null;
    isReady = false;
    return { ok: false, error: lastError };
  }
}

async function disconnect() {
  // Cancel any pending coalesced send so we don't try to write to a
  // disconnected socket.
  if (coalesceTimer) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
    coalescedActivity = null;
  }
  if (!client) {
    isReady = false;
    return { ok: true };
  }
  try {
    if (typeof client.destroy === 'function') await client.destroy();
    else if (typeof client.disconnect === 'function') client.disconnect();
  } catch { /* ignore */ }
  client = null;
  currentAppId = null;
  isReady = false;
  pendingActivity = null;
  lastError = null;
  return { ok: true };
}

async function applyActivity(activity) {
  if (!client || !isReady) return { ok: false, error: 'not connected' };
  try {
    // Diagnostic: log the cover URL we're sending so the user can see in
    // dev tools / terminal exactly what was attempted. This makes it
    // easy to spot URL truncation, bad characters, or stale-fallback
    // issues without instrumenting the renderer.
    if (activity && activity.assets?.large_image) {
      const li = String(activity.assets.large_image);
      const preview = li.length > 80 ? `${li.slice(0, 77)}...` : li;
      console.log(`[discord] sending activity: large_image=${preview} (${li.length} chars), details="${activity.details}"`);
    }
    if (activity === null) await client.clearActivity();
    else await client.setActivity(activity);
    return { ok: true };
  } catch (e) {
    lastError = String(e?.message || e);
    console.log('[discord] setActivity error:', lastError);
    // If the socket dropped, mark not-ready so the next call queues
    // instead of throwing.
    if (/not connected|epipe|econnreset|socket/i.test(lastError)) {
      isReady = false;
    }
    return { ok: false, error: lastError };
  }
}

/** Send an activity, coalescing rapid bursts into one Discord IPC write. */
function scheduleSend(activity) {
  coalescedActivity = activity;
  if (coalesceTimer) return;
  const t = setTimeout(() => {
    coalesceTimer = null;
    const a = coalescedActivity;
    coalescedActivity = null;
    if (a == null) return;
    if (!client || !isReady) {
      pendingActivity = a;
      return;
    }
    applyActivity(a).catch(() => { /* lastError already set */ });
  }, COALESCE_MS);
  // Coalescer must not keep the event loop alive on quit.
  t.unref?.();
  coalesceTimer = t;
}

/**
 * Set the displayed activity from a high-level music payload.
 *
 * Payload shape:
 *   {
 *     title:      string         the track title (becomes "details")
 *     artist:     string         the artist (becomes "state")
 *     album:      string         used for the large-image hover text
 *     coverArtUrl: string         optional public https:// URL for the
 *                                  album art. data:/file:/custom-protocol
 *                                  URLs are dropped — Discord fetches the
 *                                  URL from its own servers and only
 *                                  accepts public http(s).
 *     isPlaying:  boolean        controls play/pause icon + timestamps
 *     duration:   number         seconds — used for end-time bar
 *     startedAtMs: number        wall-clock ms the track started at,
 *                                used for elapsed-time progress
 *   }
 *
 * Pass null to clear the activity entirely.
 */
async function setActivity(payload) {
  if (payload === null) {
    // Cancel any in-flight coalesced send and clear immediately.
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
      coalescedActivity = null;
    }
    pendingActivity = null;
    if (client && isReady) {
      return await applyActivity(null);
    }
    return { ok: true };
  }

  // Discord limits "details" and "state" to 128 chars and requires
  // each to be at least 2 chars. Truncate + pad.
  const truncate = (s, max = 128) => {
    const t = String(s || '').trim();
    if (t.length === 0) return null;
    if (t.length > max) return t.slice(0, max - 1) + '…';
    return t.length < 2 ? `${t} ` : t;
  };

  const detailsStr = truncate(payload.title) || 'Unknown track';
  const artistBase = String(payload.artist || '').trim();
  const albumBase = String(payload.album || '').trim();
  const stateStr = truncate(artistBase || 'Unknown artist');
  // large_text drives the third line of the card (and cover-art hover). Only
  // include it when showing the album; in basic mode we omit it entirely so
  // there is no third line at all.
  const largeText = (payload.showAlbum && albumBase) ? truncate(albumBase) : null;

  // Discord's media proxy can fetch any public http(s) URL for
  // large_image; for anything else we fall back to the registered asset
  // key. The asset key MUST be uploaded in the Discord developer portal
  // for this app under Rich Presence → Art Assets, otherwise the image
  // is blank.
  //
  // Discord caps the large_image field at 256 chars total. Past that
  // length the whole field is rejected and the cover renders blank, so
  // we trim and reject overly long URLs explicitly (falling back to
  // the asset key) rather than letting them silently fail.
  let largeImage = 'immerse_logo';
  const coverUrl = typeof payload.coverArtUrl === 'string' ? payload.coverArtUrl.trim() : '';
  if (/^https?:\/\/[^\s]+$/i.test(coverUrl)) {
    if (coverUrl.length <= 256) {
      largeImage = coverUrl;
    } else {
      console.log(`[discord] cover URL too long for Discord (${coverUrl.length} > 256), falling back to asset key:`, coverUrl.slice(0, 60) + '...');
    }
  }
  const smallImage = payload.isPlaying ? 'play' : 'pause';
  const smallText = payload.isPlaying ? 'Playing' : 'Paused';

  const assets = {
    large_image: largeImage,
    small_image: smallImage,
    small_text: smallText,
  };
  if (largeText) assets.large_text = largeText;

  // Discord RPC SET_ACTIVITY protocol shape — nested snake_case. The
  // @ryuziii/discord-rpc library passes this object through verbatim.
  const activity = {
    type: 2,                  // 2 = Listening (works for unverified apps as of 2024)
    status_display_type: 1,   // 1 = use `details` as the user's status text
    name: '  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
    details: detailsStr,
    state: stateStr,
    instance: false,
    assets,
  };

  if (payload.isPlaying && payload.duration > 0 && Number.isFinite(payload.startedAtMs)) {
    activity.timestamps = {
      start: Math.floor(payload.startedAtMs / 1000),
      end: Math.floor((payload.startedAtMs + payload.duration * 1000) / 1000),
    };
  }

  // If we're not connected yet, stash the latest activity (coalesced)
  // for the connect handshake to flush.
  if (!client || !isReady) {
    pendingActivity = activity;
    return { ok: false, error: 'not connected', queued: true };
  }

  // Connected — coalesce a burst of updates into one send.
  scheduleSend(activity);
  return { ok: true, queued: true };
}

function status() {
  return {
    connected: !!(client && isReady),
    appId: currentAppId,
    lastError,
  };
}

export { connect, disconnect, setActivity, status };
