//! studio-spotify — Studio's Spotify playback helper.
//!
//! librespot as a library, the way Sonora uses it: a session signed in with
//! your account and librespot's own player, driven directly. Studio talks to
//! it over stdin/stdout, one JSON object per line.
//!
//! Audio goes from librespot's decoder straight to the sound card through
//! the rodio backend, and nowhere else. The helper takes no option for a
//! different backend, a pipe, or a file: there is no path for the decoded
//! audio to reach Studio or the disk. librespot's own cache is only used for
//! credentials, so no audio is cached either.
//!
//! Commands (stdin):
//!   {"cmd":"auth","token":"<access token>"}   sign in (token optional once cached)
//!   {"cmd":"load","id":"<track id>","play":true,"positionMs":0}
//!   {"cmd":"preload","id":"<track id>"}
//!   {"cmd":"play"} {"cmd":"pause"} {"cmd":"stop"}
//!   {"cmd":"seek","positionMs":12345}
//!   {"cmd":"volume","value":0.8}              0.0 – 1.0
//!   {"cmd":"quit"}
//!
//! Events (stdout):
//!   {"event":"ready"}
//!   {"event":"connected","user":"…","country":"…","account":"premium"}
//!   {"event":"authError","kind":"premium|expired|refused|network","message":"…"}
//!   {"event":"loading|playing|paused|position|seeked","id":"…","positionMs":n}
//!   {"event":"ended","id":"…"}  {"event":"stopped","id":"…"}
//!   {"event":"unavailable","id":"…"}
//!   {"event":"track","id":"…","durationMs":n}   metadata loaded
//!   {"event":"error","message":"…"}

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librespot_core::authentication::Credentials;
use librespot_core::cache::Cache;
use librespot_core::{Session, SessionConfig, SpotifyUri};
use librespot_playback::audio_backend;
use librespot_playback::config::{AudioFormat, Bitrate, PlayerConfig, VolumeCtrl};
use librespot_playback::mixer::softmixer::SoftMixer;
use librespot_playback::mixer::{Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Spotify's desktop client ID — the same one Studio signs in with, so the
/// token Studio already holds is accepted here.
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
/// How long to wait for the account type after connecting before assuming
/// it's fine (it arrives in a separate packet shortly after sign-in).
const ACCOUNT_WAIT: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    Auth { token: Option<String> },
    Load { id: String, #[serde(default = "yes")] play: bool, #[serde(default, rename = "positionMs")] position_ms: u32 },
    Preload { id: String },
    Play,
    Pause,
    Stop,
    Seek { #[serde(rename = "positionMs")] position_ms: u32 },
    Volume { value: f64 },
    Quit,
}

fn yes() -> bool {
    true
}

struct Engine {
    session: Session,
    player: Arc<Player>,
    mixer: Arc<SoftMixer>,
}

#[tokio::main]
async fn main() {
    // stdout carries the protocol only; everything human goes to stderr.
    let cache_dir = std::env::args().nth(1).map(PathBuf::from);
    let send = emit;
    send(json!({ "event": "ready", "version": env!("CARGO_PKG_VERSION") }));

    let mut engine: Option<Engine> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
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
            Command::Auth { token } => {
                if let Some(old) = engine.take() {
                    old.player.stop();
                    old.session.shutdown();
                }
                match connect(cache_dir.clone(), token).await {
                    Ok((session, account)) => {
                        let e = start_player(session.clone());
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
            other => {
                let Some(e) = engine.as_ref() else {
                    send(json!({ "event": "error", "message": "not signed in" }));
                    continue;
                };
                match other {
                    Command::Load { id, play, position_ms } => match track_uri(&id) {
                        Some(uri) => e.player.load(uri, play, position_ms),
                        None => send(json!({ "event": "error", "message": format!("not a track id: {id}") })),
                    },
                    Command::Preload { id } => {
                        if let Some(uri) = track_uri(&id) {
                            e.player.preload(uri);
                        }
                    }
                    Command::Play => e.player.play(),
                    Command::Pause => e.player.pause(),
                    Command::Stop => e.player.stop(),
                    Command::Seek { position_ms } => e.player.seek(position_ms),
                    Command::Volume { value } => {
                        let v = (value.clamp(0.0, 1.0) * f64::from(u16::MAX)).round() as u16;
                        e.mixer.set_volume(v);
                    }
                    Command::Auth { .. } | Command::Quit => unreachable!(),
                }
            }
        }
    }

    if let Some(e) = engine {
        e.player.stop();
        e.session.shutdown();
    }
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

/// Connects with the token Studio passes, or — with no token — the reusable
/// credentials librespot cached last time. Returns the account type.
async fn connect(cache_dir: Option<PathBuf>, token: Option<String>) -> Result<(Session, String), (&'static str, String)> {
    // Credentials only: the audio and volume slots are None, so nothing
    // else is ever written.
    let cache = match &cache_dir {
        Some(dir) => Cache::new(Some(dir.as_path()), None, None, None).ok(),
        None => None,
    };
    let credentials = match token.filter(|t| !t.trim().is_empty()) {
        Some(t) => Credentials::with_access_token(t),
        None => match cache.as_ref().and_then(|c| c.credentials()) {
            Some(c) => c,
            None => return Err(("expired", "No saved sign-in — sign in to Spotify in Settings.".into())),
        },
    };

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

fn start_player(session: Session) -> Engine {
    // Linear: Studio sends the amplitude it wants (its volume slider is
    // already on a perceptual curve), so a second log curve here would make
    // the lower half of the slider near-silent.
    let mixer_config = MixerConfig { volume_ctrl: VolumeCtrl::Linear, ..MixerConfig::default() };
    let mixer = Arc::new(SoftMixer::open(mixer_config).expect("software mixer"));
    let config = PlayerConfig {
        bitrate: Bitrate::Bitrate320,
        gapless: true,
        normalisation: false,
        position_update_interval: Some(Duration::from_millis(500)),
        ..Default::default()
    };
    // The sound card, and only the sound card.
    let backend = audio_backend::find(Some("rodio".to_string())).expect("rodio backend compiled in");
    let player = Player::new(config, session.clone(), mixer.get_soft_volume(), move || {
        backend(None, AudioFormat::default())
    });

    let mut events = player.get_player_event_channel();
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            if let Some(v) = translate(ev) {
                emit(v);
            }
        }
    });

    Engine { session, player, mixer }
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
        PlayerEvent::Unavailable { track_id, .. } => json!({ "event": "unavailable", "id": id(&track_id) }),
        PlayerEvent::TimeToPreloadNextTrack { track_id, .. } => json!({ "event": "preloadNext", "id": id(&track_id) }),
        PlayerEvent::TrackChanged { audio_item } => json!({ "event": "track", "id": id(&audio_item.track_id), "durationMs": audio_item.duration_ms }),
        _ => return None,
    })
}
