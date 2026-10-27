//! Spotify's own lyrics for a song (licensed from Musixmatch), over the
//! signed-in session, the way Spotify's apps get them. They belong to the
//! exact track, so a clean and an explicit version each get their own words,
//! and most come with line timing.

use librespot_core::{Error, Session, SpotifyId};
use librespot_metadata::lyrics::SyncType;
use librespot_metadata::Lyrics;
use serde_json::{json, Value};

/// `{ synced, lines: [{ t, words }], language, provider }`, or null when
/// Spotify has no lyrics for the song.
pub async fn lyrics(session: &Session, id: &str) -> Result<Value, String> {
    let sid = SpotifyId::from_base62(id).map_err(|e| format!("not a track id: {e}"))?;
    match Lyrics::get(session, &sid).await {
        Ok(l) => Ok(shape(&l)),
        Err(e) if is_missing(&e) => Ok(Value::Null),
        Err(e) => Err(format!("lyrics: {e}")),
    }
}

fn is_missing(e: &Error) -> bool {
    matches!(e.kind, librespot_core::error::ErrorKind::NotFound)
}

fn shape(l: &Lyrics) -> Value {
    let synced = matches!(l.lyrics.sync_type, SyncType::LineSynced);
    let lines: Vec<Value> = l
        .lyrics
        .lines
        .iter()
        .map(|x| json!({ "t": x.start_time_ms.parse::<u64>().unwrap_or(0), "words": x.words }))
        .collect();
    json!({
        "synced": synced,
        "lines": lines,
        "language": l.lyrics.language,
        "provider": l.lyrics.provider_display_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_lyrics_become_timed_lines() {
        let raw = br#"{"lyrics":{"syncType":"LINE_SYNCED","lines":[
            {"startTimeMs":"1200","words":"First line","syllables":[],"endTimeMs":"0"},
            {"startTimeMs":"4310","words":"Second line","syllables":[],"endTimeMs":"0"}],
            "provider":"MusixMatch","providerLyricsId":"1","providerDisplayName":"Musixmatch",
            "syncLyricsUri":"","isDenseTypeface":false,"alternatives":[],"language":"en","isRtlLanguage":false,
            "capStatus":"NONE"},
            "colors":{"background":-1,"text":-16777216,"highlightText":-1},"hasVocalRemoval":false}"#;
        let l = Lyrics::try_from(&bytes::Bytes::from_static(raw)).expect("parses");
        let v = shape(&l);
        assert_eq!(v["synced"], true);
        assert_eq!(v["lines"][1]["t"], 4310);
        assert_eq!(v["lines"][0]["words"], "First line");
        assert_eq!(v["provider"], "Musixmatch");
    }
}
