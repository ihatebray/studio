//! studio-spotify — Studio's Spotify playback helper.
//!
//! librespot as a library, the way Sonora uses it: a session signed in with
//! your account and librespot's own player, driven directly. Studio talks to
//! it over stdin/stdout, one JSON object per line.
//!
//! Audio goes from librespot's decoder straight to the sound card through
//! output.rs (rodio, like librespot's own backend, but with pause and skip
//! that don't wait for the queue), and nowhere else. The helper takes no option for a
//! different backend, a pipe, or a file: there is no path for the decoded
//! audio to reach Studio or the disk. librespot's own cache is only used for
//! credentials, so no audio is cached either.
//!
//! Commands (stdin):
//!   {"cmd":"auth","token":"<access token>","preferCached":true}
//!                                             sign in (saved sign-in first when preferCached)
//!   {"cmd":"load","id":"<track id>","play":true,"positionMs":0,"cut":true}
//!   {"cmd":"preload","id":"<track id>"}
//!   {"cmd":"play"} {"cmd":"pause"} {"cmd":"stop"}
//!   {"cmd":"seek","positionMs":12345}
//!   {"cmd":"volume","value":0.8}              0.0 – 1.0
//!   {"cmd":"search","req":1,"q":"…"}          catalogue search (search.rs)
//!   {"cmd":"album","req":2,"id":"…"}          an album's tracklist
//!   {"cmd":"artist","req":3,"id":"…"}         an artist's releases and top songs
//!   {"cmd":"releases","req":4,"days":60,"ids":["…"],"spotify":true}
//!                                             new releases from followed artists (library.rs)
//!   {"cmd":"like","req":8,"ids":["…"],"saved":true}   Liked Songs, via the collection service
//!   {"cmd":"artists","req":9,"ids":["…"]}     artist names and portraits
//!   {"cmd":"playlist","req":5,"id":"…"}       a playlist's songs
//!   {"cmd":"liked","req":6}                   Liked Songs
//!   {"cmd":"tracks","req":7,"ids":["…"]}      song details
//!   {"cmd":"quit"}
//!
//! Events (stdout):
//!   {"event":"ready"}
//!   {"event":"connected","user":"…","country":"…","account":"premium"}
//!   {"event":"authError","kind":"premium|expired|refused|network","message":"…"}
//!   {"event":"loading|playing|paused|position|seeked","id":"…","positionMs":n}
//!   {"event":"ended","id":"…"}  {"event":"stopped","id":"…"}
//!   {"event":"unavailable","id":"…","throttled":bool,"denied":bool,"transient":bool,"reason":"…"}
//!   {"event":"track","id":"…","durationMs":n}   metadata loaded
//!   {"event":"levels","v":[24 × 0–100]}         band levels of what's playing, ~30/s
//!   {"event":"answer","req":1,"ok":true,"data":…}   reply to search / album / artist
//!                                             or "ok":false,"error":"…"
//!   {"event":"stale","why":"…"}               the session stopped working and was
//!                                             dropped; sign in again (auth) to go on
//!   {"event":"error","message":"…"}

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librespot_core::authentication::Credentials;
use librespot_core::cache::Cache;
use librespot_core::spclient::RequestStrategy;
use librespot_core::{Session, SessionConfig, SpotifyUri};
use librespot_playback::audio_backend::Sink;
use librespot_playback::config::{Bitrate, PlayerConfig};
use librespot_playback::mixer::NoOpVolume;
use librespot_playback::player::{Player, PlayerEvent};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

mod library;
mod output;
mod search;
mod spectrum;
use output::{Cue, CuedSink, Silence};

/// Spotify's desktop client ID — the same one Studio signs in with, so the
/// token Studio already holds is accepted here.
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
/// How long to wait for the account type after connecting before assuming
/// it's fine (it arrives in a separate packet shortly after sign-in).
const ACCOUNT_WAIT: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    /// `preferCached`: connect with the reusable sign-in librespot saved
    /// last time, as Sonora does after its first login, and use `token` only
    /// if there is none or it's refused. Without it, `token` is used (a fresh
    /// sign-in in Settings, possibly to another account).
    Auth {
        token: Option<String>,
        #[serde(default, rename = "preferCached")]
        prefer_cached: bool,
    },
    /// `cut: false` is a natural advance after "ended": the old track's
    /// tail is still in the output queue and plays out into the new one.
    /// Anything else (a skip, a click) cuts the old audio off at once.
    Load {
        id: String,
        #[serde(default = "yes")]
        play: bool,
        #[serde(default, rename = "positionMs")]
        position_ms: u32,
        #[serde(default = "yes")]
        cut: bool,
    },
    Preload { id: String },
    Play,
    Pause,
    Stop,
    Seek { #[serde(rename = "positionMs")] position_ms: u32 },
    Volume { value: f64 },
    /// Answered with a "search" event carrying the same `req`, from a task of
    /// its own so playback commands aren't held up behind it.
    Search { req: u64, q: String },
    /// An album's tracklist / an artist's releases and top songs, the same way.
    Album { req: u64, id: String },
    Artist { req: u64, id: String },
    /// Your Spotify over the session (library.rs), not the Web API.
    /// `ids`: artists followed in Studio; `spotify`: also the ones followed on Spotify.
    Releases {
        req: u64,
        #[serde(default = "sixty")]
        days: u32,
        #[serde(default)]
        ids: Vec<String>,
        #[serde(default = "yes")]
        spotify: bool,
    },
    Like { req: u64, ids: Vec<String>, #[serde(default = "yes")] saved: bool },
    Artists { req: u64, ids: Vec<String> },
    Playlist { req: u64, id: String },
    Liked { req: u64 },
    Tracks { req: u64, ids: Vec<String> },
    Quit,
}

fn yes() -> bool {
    true
}

fn sixty() -> u32 {
    60
}

struct Engine {
    session: Session,
    player: Arc<Player>,
    cue: Cue,
}

/// librespot reports why a load failed only through `log`. This prints its
/// warnings and errors to stderr (Studio's terminal shows them as
/// `[studio-spotify] …`) and keeps the last error, which the "unavailable"
/// event carries as `reason` so Studio can say what actually went wrong.
struct StderrLog;
static LAST_ERROR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// Set when a load went on without its decryption key (see below): that
/// load fails, and the failure is the session's fault, not the track's.
static KEY_TROUBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The command loop's ear for "this session has stopped working".
static STALE: std::sync::OnceLock<tokio::sync::mpsc::UnboundedSender<String>> = std::sync::OnceLock::new();

fn report_stale(why: &str) {
    if let Some(tx) = STALE.get() {
        let _ = tx.send(why.to_owned());
    }
}

impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Warn
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        // The MP3 demuxer warns once per junk block when it's handed bytes it
        // can't read (thousands of lines for one song); the error that
        // follows says what matters.
        if r.level() == log::Level::Warn && r.target().starts_with("symphonia") {
            return;
        }
        let msg = format!("{}", r.args());
        /* librespot asks the session for each song's decryption key. When
           that request fails without an answer (the session's connection has
           gone stale: after sleep, a network change), librespot decodes the
           still-encrypted file anyway, which only scans the whole file for
           audio that isn't there and times out. Every song does the same
           until the session is renewed, which is what a restart used to do. */
        if r.level() == log::Level::Warn && msg.starts_with("Unable to load key, continuing without decryption") {
            KEY_TROUBLE.store(true, std::sync::atomic::Ordering::SeqCst);
            report_stale("Spotify stopped handing out decryption keys on this connection");
        }
        let line = format!("{} {}: {}", r.level(), r.target(), msg);
        eprintln!("{line}");
        if r.level() == log::Level::Error {
            let mut last = LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner());
            // A failed load logs the cause ("Unable to load audio item: …
            // StatusCode(503)") and then "Skipping to next track … : ()",
            // which says nothing. Keep the cause.
            if !(msg.starts_with("Skipping to next track") && !last.is_empty()) {
                *last = msg;
            }
        }
    }
    fn flush(&self) {}
}

fn last_error() -> String {
    std::mem::take(&mut *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()))
}

/// A load that failed because Spotify's servers didn't answer (a 5xx or 429
/// from the metadata service, a timeout), not because of the track. Worth
/// asking again after a wait, like a throttled key.
fn is_transient(reason: &str) -> bool {
    let r = reason.to_lowercase();
    r.contains("statuscode(5") || r.contains("statuscode(429") || r.contains("deadlineexceeded")
        || r.contains("timed out") || r.contains("connection")
        || r.contains("deadline expired") || r.contains("timeout exceeded")
}

#[tokio::main]
async fn main() {
    let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Warn));
    // stdout carries the protocol only; everything human goes to stderr.
    let cache_dir = std::env::args().nth(1).map(PathBuf::from);
    let send = emit;
    send(json!({ "event": "ready", "version": env!("CARGO_PKG_VERSION") }));

    let mut engine: Option<Engine> = None;
    // Kept across re-sign-ins, so a new engine starts at the current volume.
    let mut volume: f32 = 1.0;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let (stale_tx, mut stale_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let _ = STALE.set(stale_tx);
    // A dropped connection doesn't always announce itself with a failed
    // song; this notices a session librespot has given up on.
    let mut check = tokio::time::interval(Duration::from_secs(5));

    loop {
        let line = tokio::select! {
            read = lines.next_line() => match read {
                Ok(Some(line)) => line,
                _ => break,
            },
            Some(why) = stale_rx.recv() => {
                drop_stale(&mut engine, &why);
                continue;
            }
            _ = check.tick() => {
                if engine.as_ref().is_some_and(|e| e.session.is_invalid()) {
                    drop_stale(&mut engine, "the connection to Spotify dropped");
                }
                continue;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cmd: Command = match serde_json::from_str(line) {
            Ok(c) => c,
            Err(e) => {
                send(json!({ "event": "error", "message": format!("bad command: {e}") }));
                continue;
            }
        };

        match cmd {
            Command::Quit => break,
            Command::Auth { token, prefer_cached } => {
                KEY_TROUBLE.store(false, std::sync::atomic::Ordering::SeqCst);
                if let Some(old) = engine.take() {
                    old.player.stop();
                    old.session.shutdown();
                }
                match connect(cache_dir.clone(), token, prefer_cached).await {
                    Ok((session, account)) => {
                        let e = start_player(session.clone(), volume);
                        send(json!({
                            "event": "connected",
                            "user": session.username(),
                            "country": session.country(),
                            "account": account,
                        }));
                        engine = Some(e);
                    }
                    Err((kind, message)) => {
                        send(json!({ "event": "authError", "kind": kind, "message": message }));
                    }
                }
            }
            Command::Volume { value } => {
                volume = value.clamp(0.0, 1.0) as f32;
                if let Some(e) = engine.as_ref() {
                    e.cue.set_volume(volume);
                }
            }
            other => {
                let Some(e) = engine.as_ref() else {
                    // A request gets its own reply; the player's error event is for playback.
                    match &other {
                        Command::Search { req, .. } | Command::Album { req, .. } | Command::Artist { req, .. }
                        | Command::Releases { req, .. } | Command::Playlist { req, .. } | Command::Liked { req } | Command::Tracks { req, .. }
                        | Command::Like { req, .. } | Command::Artists { req, .. } => {
                            send(json!({ "event": "answer", "req": req, "ok": false, "error": "not signed in" }));
                        }
                        _ => send(json!({ "event": "error", "message": "not signed in" })),
                    }
                    continue;
                };
                match other {
                    Command::Load { id, play, position_ms, cut } => match track_uri(&id) {
                        Some(uri) => {
                            if cut {
                                e.cue.clear(uri.to_id().ok());
                            }
                            e.player.load(uri, play, position_ms);
                        }
                        None => send(json!({ "event": "error", "message": format!("not a track id: {id}") })),
                    },
                    Command::Preload { id } => {
                        if let Some(uri) = track_uri(&id) {
                            e.player.preload(uri);
                        }
                    }
                    Command::Search { req, q } => answer(req, e.session.clone(), move |s| async move { search::search(&s, &q).await }),
                    Command::Album { req, id } => answer(req, e.session.clone(), move |s| async move { search::album(&s, &id).await }),
                    Command::Artist { req, id } => answer(req, e.session.clone(), move |s| async move {
                        let country = s.country();
                        search::artist(&s, &id, &country).await
                    }),
                    Command::Releases { req, days, ids, spotify } => answer(req, e.session.clone(), move |s| async move { library::releases(&s, days, &ids, spotify).await }),
                    Command::Like { req, ids, saved } => answer(req, e.session.clone(), move |s| async move { library::like(&s, &ids, saved).await }),
                    Command::Artists { req, ids } => answer(req, e.session.clone(), move |s| async move { library::artists(&s, &ids).await }),
                    Command::Playlist { req, id } => answer(req, e.session.clone(), move |s| async move { library::playlist(&s, &id).await }),
                    Command::Liked { req } => answer(req, e.session.clone(), move |s| async move { library::liked(&s).await }),
                    Command::Tracks { req, ids } => answer(req, e.session.clone(), move |s| async move { library::tracks(&s, &ids).await }),
                    Command::Play => e.player.play(),
                    Command::Pause => e.player.pause(),
                    Command::Stop => {
                        e.cue.clear(None);
                        e.player.stop();
                    }
                    Command::Seek { position_ms } => {
                        e.cue.clear(None);
                        e.player.seek(position_ms);
                    }
                    Command::Auth { .. } | Command::Volume { .. } | Command::Quit => unreachable!(),
                }
            }
        }
    }

    if let Some(e) = engine {
        e.player.stop();
        e.session.shutdown();
    }
}

/// The session stopped working: stop the player (so a load decoding without
/// its key doesn't run on to the timeout), let the session go, and tell
/// Studio, which signs in again. Only the first report counts; the rest
/// arrive after the engine is already gone.
fn drop_stale(engine: &mut Option<Engine>, why: &str) {
    let Some(old) = engine.take() else { return };
    old.player.stop();
    old.session.shutdown();
    emit(json!({ "event": "stale", "why": why }));
}

/// Run a metadata request in a task of its own, so playback commands aren't
/// held up behind it, and reply with an "answer" event carrying its `req`.
fn answer<F, Fut>(req: u64, session: Session, job: F)
where
    F: FnOnce(Session) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    tokio::spawn(async move {
        emit(match job(session).await {
            Ok(data) => json!({ "event": "answer", "req": req, "ok": true, "data": data }),
            Err(error) => json!({ "event": "answer", "req": req, "ok": false, "error": error }),
        });
    });
}

/// One protocol line to stdout. Written and flushed under the stdout lock so
/// lines from the command loop and the player's event task never interleave,
/// and nothing is lost when the process exits right after.
fn emit(v: Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn track_uri(id: &str) -> Option<SpotifyUri> {
    let id = id.trim();
    let uri = if id.starts_with("spotify:") { id.to_string() } else { format!("spotify:track:{id}") };
    SpotifyUri::from_uri(&uri).ok()
}

/// Connects with the token Studio passes, or the reusable credentials
/// librespot cached last time (first, when `prefer_cached`). Returns the
/// account type.
async fn connect(cache_dir: Option<PathBuf>, token: Option<String>, prefer_cached: bool) -> Result<(Session, String), (&'static str, String)> {
    // Credentials only: the audio and volume slots are None, so nothing
    // else is ever written.
    let open_cache = || match &cache_dir {
        Some(dir) => Cache::new(Some(dir.as_path()), None, None, None).ok(),
        None => None,
    };
    let token = token.filter(|t| !t.trim().is_empty());
    let cached = open_cache().and_then(|c| c.credentials());

    let session = match (prefer_cached, cached, token) {
        (true, Some(saved), token) => match session_with(open_cache(), saved).await {
            Ok(s) => s,
            Err(refused) => match token {
                Some(t) => {
                    eprintln!("studio-spotify: saved sign-in refused ({}), using Studio's token", refused.1);
                    session_with(open_cache(), Credentials::with_access_token(t)).await?
                }
                None => return Err(refused),
            },
        },
        (_, _, Some(t)) => session_with(open_cache(), Credentials::with_access_token(t)).await?,
        (_, Some(saved), None) => session_with(open_cache(), saved).await?,
        (_, None, None) => return Err(("expired", "No saved sign-in — sign in to Spotify in Settings.".into())),
    };

    // Account type arrives just after connecting. Anything but premium can
    // sign in but will never play, so say so up front instead of failing
    // every track.
    let deadline = tokio::time::Instant::now() + ACCOUNT_WAIT;
    loop {
        if let Some(kind) = session.user_data().attributes.get("type").cloned() {
            if kind != "premium" {
                session.shutdown();
                return Err(("premium", format!("This Spotify account is {kind}; playback needs Premium.")));
            }
            return Ok((session, kind));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((session, "unknown".into()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// One connect attempt. librespot saves the reusable credentials Spotify
/// hands back (store = true), which is what `preferCached` uses next time.
async fn session_with(cache: Option<Cache>, credentials: Credentials) -> Result<Session, (&'static str, String)> {
    let config = SessionConfig { client_id: CLIENT_ID.to_string(), ..Default::default() };
    let session = Session::new(config, cache);
    if let Err(e) = session.connect(credentials, true).await {
        let msg = e.to_string();
        let lower = msg.to_lowercase();
        let kind = if lower.contains("bad credentials") || lower.contains("token") || lower.contains("auth") {
            "expired"
        } else if lower.contains("premium") {
            "premium"
        } else if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") {
            "network"
        } else {
            "refused"
        };
        return Err((kind, msg));
    }
    Ok(session)
}

fn start_player(session: Session, volume: f32) -> Engine {
    let config = PlayerConfig {
        bitrate: Bitrate::Bitrate320,
        gapless: true,
        normalisation: false,
        position_update_interval: Some(Duration::from_millis(500)),
        ..Default::default()
    };
    // The sound card, and only the sound card: output.rs, which also makes
    // pause/skip/seek/volume take effect at once. Volume is applied there,
    // so librespot's own volume stage is a no-op.
    let cue = Cue::new(volume);
    let sink_cue = cue.clone();
    // librespot asks the metadata service up to ten times, back to back, when
    // it fails. When the failure is Spotify's servers being overloaded (503),
    // that burst only prolongs it. Three quick tries, then Studio waits and
    // asks again.
    session.spclient().set_strategy(RequestStrategy::TryTimes(3));
    let player = Player::new(config, session.clone(), Box::new(NoOpVolume), move || -> Box<dyn Sink> {
        match CuedSink::open(sink_cue) {
            Ok(sink) => Box::new(sink),
            Err(message) => {
                eprintln!("studio-spotify: {message}");
                emit(json!({ "event": "error", "message": message }));
                Box::new(Silence)
            }
        }
    });

    // Band levels for Studio's visualizer, ~30 a second, and only while a
    // packet is actually playing (nothing is published while paused). The
    // thread ends with the engine: it holds only a weak reference.
    let weak = Arc::downgrade(&cue.levels);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(33));
        let Some(levels) = weak.upgrade() else { break };
        if let Some(v) = levels.take() {
            emit(json!({ "event": "levels", "v": v }));
        }
    });

    let mut events = player.get_player_event_channel();
    let event_cue = cue.clone();
    let event_session = session.clone();
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            // The player announcing the new track or position is what lets
            // audio through the output again after a skip or seek.
            match &ev {
                PlayerEvent::Loading { track_id, .. }
                | PlayerEvent::Playing { track_id, .. }
                | PlayerEvent::Seeked { track_id, .. } => event_cue.announce(&track_id.to_id().unwrap_or_default()),
                PlayerEvent::TrackChanged { audio_item } => event_cue.announce(&audio_item.track_id.to_id().unwrap_or_default()),
                PlayerEvent::PositionChanged { .. } | PlayerEvent::PositionCorrection { .. } => event_cue.position(),
                _ => {}
            }
            if let Some(v) = translate(ev) {
                // A metadata server that keeps failing may be the bad one:
                // the next request resolves a fresh one.
                if v["transient"] == true {
                    event_session.spclient().flush_accesspoint().await;
                }
                emit(v);
            }
        }
    });

    Engine { session, player, cue }
}

fn translate(ev: PlayerEvent) -> Option<Value> {
    let id = |u: &SpotifyUri| u.to_id().unwrap_or_default();
    Some(match ev {
        PlayerEvent::Loading { track_id, position_ms, .. } => json!({ "event": "loading", "id": id(&track_id), "positionMs": position_ms }),
        PlayerEvent::Playing { track_id, position_ms, .. } => json!({ "event": "playing", "id": id(&track_id), "positionMs": position_ms }),
        PlayerEvent::Paused { track_id, position_ms, .. } => json!({ "event": "paused", "id": id(&track_id), "positionMs": position_ms }),
        PlayerEvent::PositionChanged { track_id, position_ms, .. }
        | PlayerEvent::PositionCorrection { track_id, position_ms, .. } => json!({ "event": "position", "id": id(&track_id), "positionMs": position_ms }),
        PlayerEvent::Seeked { track_id, position_ms, .. } => json!({ "event": "seeked", "id": id(&track_id), "positionMs": position_ms }),
        PlayerEvent::EndOfTrack { track_id, .. } => json!({ "event": "ended", "id": id(&track_id) }),
        PlayerEvent::Stopped { track_id, .. } => json!({ "event": "stopped", "id": id(&track_id) }),
        // throttled: Spotify refused the audio key for now (a burst of loads);
        // retry after a wait. denied: refused for good this session.
        // transient: Spotify's servers failed (503, timeout); also retry.
        PlayerEvent::Unavailable { track_id, denied, throttled, .. } => {
            let reason = last_error();
            // Failed for want of a key from a stale session: the song is fine.
            let key_trouble = KEY_TROUBLE.swap(false, std::sync::atomic::Ordering::SeqCst);
            json!({
                "event": "unavailable", "id": id(&track_id), "denied": denied, "throttled": throttled,
                "transient": !denied && !throttled && (key_trouble || is_transient(&reason)), "reason": reason,
            })
        }
        PlayerEvent::TimeToPreloadNextTrack { track_id, .. } => json!({ "event": "preloadNext", "id": id(&track_id) }),
        PlayerEvent::TrackChanged { audio_item } => json!({ "event": "track", "id": id(&audio_item.track_id), "durationMs": audio_item.duration_ms }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::is_transient;

    #[test]
    fn server_failures_are_transient() {
        assert!(is_transient("Unable to load audio item: Error { kind: Unavailable, error: StatusCode(503) }"));
        assert!(is_transient("Unable to load audio item: Error { kind: ResourceExhausted, error: StatusCode(429) }"));
        assert!(is_transient("Unable to load audio item: Error { kind: DeadlineExceeded, error: Elapsed(()) }"));
        assert!(is_transient("Unable to read audio file: Symphonia Decoder Error: Deadline expired before operation could complete { wait timeout exceeded }"));
        assert!(!is_transient("Unable to load audio item: Error { kind: NotFound, error: StatusCode(404) }"));
        assert!(!is_transient(""));
    }
}
