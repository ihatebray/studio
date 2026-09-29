//! Your Spotify, read over the librespot session the way Sonora does, instead
//! of the public Web API (whose quota, keyed to the desktop client ID Studio
//! signs in with, is shared with every other app using it and runs out
//! constantly):
//!
//!   releases   followed artists (the collection service), every artist's
//!              release list in one metadata batch, then the recent releases'
//!              details in one more
//!   playlist   a playlist's songs: its context, then one track batch
//!   liked      Liked Songs: the collection service, then track batches
//!   tracks     details for a list of track ids, in one batch
//!
//! Metadata only.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use http::header::{HeaderValue, ACCEPT, CONTENT_TYPE};
use http::{HeaderMap, Method};
use librespot_core::Session;
use librespot_protocol::extension_kind::ExtensionKind;
use librespot_protocol::metadata::album::Type as AlbumType;
use librespot_protocol::metadata::image::Size as ImageSize;
use librespot_protocol::metadata::{Album as AlbumMessage, Artist as ArtistMessage, Track as TrackMessage};
use protobuf::Message;
use serde_json::{json, Value};

use crate::search::{base62, date_of, extended, image_url};

const TRACK_PREFIX: &str = "spotify:track:";
const ARTIST_PREFIX: &str = "spotify:artist:";
const ALBUM_PREFIX: &str = "spotify:album:";
const BATCH: usize = 200;
const MAX_FOLLOWED: usize = 250;
const MAX_LIKED: usize = 300;
const MAX_PLAYLIST: usize = 300;
// Per artist, the newest few of each (the lists run newest first).
const RECENT_ALBUMS: usize = 3;
const RECENT_SINGLES: usize = 5;

/* ------------------------------------------------ the collection service */

const PAGING: &str = "/collection/v2/paging";
const CONTENT: &str = "application/vnd.collection-v2.spotify.proto";

/// Items of one of your collection sets: "collection" (Liked Songs and saved
/// albums) or "artist" (followed artists), newest first, as (uri, added at).
async fn saved_items(session: &Session, set: &str, prefix: &str, cap: usize) -> Result<Vec<(String, i64)>, String> {
    let username = session.username();
    let mut found = Vec::new();
    let mut token = String::new();
    loop {
        let mut req = Vec::new();
        pb_string(&mut req, 1, &username);
        pb_string(&mut req, 2, set);
        pb_string(&mut req, 3, &token);
        pb_varint_field(&mut req, 4, 300);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(CONTENT));
        headers.insert(ACCEPT, HeaderValue::from_static(CONTENT));
        let raw = session
            .spclient()
            .request(&Method::POST, PAGING, Some(headers), Some(&req))
            .await
            .map_err(|e| format!("collection: {e}"))?;
        let (items, next) = collection_page(&raw).ok_or("collection: unreadable page")?;
        found.extend(items.into_iter().filter(|(u, _)| u.starts_with(prefix)));
        token = next;
        if token.is_empty() || found.len() >= cap * 2 {
            break;
        }
    }
    // The service lists oldest first; newest first is what every caller wants.
    found.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    found.truncate(cap);
    Ok(found)
}

fn collection_page(bytes: &[u8]) -> Option<(Vec<(String, i64)>, String)> {
    let mut items = Vec::new();
    let mut next = String::new();
    for (field, value) in pb_fields(bytes)? {
        match (field, value) {
            (1, Pb::Bytes(item)) => {
                let (mut uri, mut at, mut removed) = (None, 0i64, false);
                for (f, v) in pb_fields(item)? {
                    match (f, v) {
                        (1, Pb::Bytes(b)) => uri = String::from_utf8(b.to_vec()).ok(),
                        (2, Pb::Varint(n)) | (2, Pb::Fixed(n)) => at = n as u32 as i32 as i64,
                        (3, Pb::Varint(n)) => removed = n != 0,
                        _ => {}
                    }
                }
                if let (Some(uri), false) = (uri, removed) {
                    items.push((uri, at));
                }
            }
            (2, Pb::Bytes(b)) => next = String::from_utf8(b.to_vec()).ok()?,
            _ => {}
        }
    }
    Some((items, next))
}

/* ---- a minimal protobuf reader/writer for the paging messages ---- */

enum Pb<'a> {
    Varint(u64),
    Fixed(u64),
    Bytes(&'a [u8]),
}

fn read_varint(b: &[u8], at: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*at)?;
        *at += 1;
        v |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

fn pb_fields(b: &[u8]) -> Option<Vec<(u32, Pb<'_>)>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < b.len() {
        let key = read_varint(b, &mut at)?;
        let field = (key >> 3) as u32;
        let value = match key & 7 {
            0 => Pb::Varint(read_varint(b, &mut at)?),
            1 => {
                let v = u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?);
                at += 8;
                Pb::Fixed(v)
            }
            2 => {
                let len = read_varint(b, &mut at)? as usize;
                let v = b.get(at..at + len)?;
                at += len;
                Pb::Bytes(v)
            }
            5 => {
                let v = u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?);
                at += 4;
                Pb::Fixed(u64::from(v))
            }
            _ => return None,
        };
        out.push((field, value));
    }
    Some(out)
}

fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn pb_string(out: &mut Vec<u8>, field: u32, s: &str) {
    write_varint(out, u64::from(field << 3 | 2));
    write_varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn pb_varint_field(out: &mut Vec<u8>, field: u32, v: u64) {
    write_varint(out, u64::from(field << 3));
    write_varint(out, v);
}

/* --------------------------------------------------------------- tracks */

/// Metadata for `uris`, a batch at a time, keyed by uri.
async fn tracks_by_uri(session: &Session, uris: &[String]) -> Result<HashMap<String, TrackMessage>, String> {
    let mut found = HashMap::new();
    for chunk in uris.chunks(BATCH) {
        for (u, b) in extended(session, chunk, ExtensionKind::TRACK_V4).await? {
            if let Ok(t) = TrackMessage::parse_from_bytes(&b) {
                found.insert(u, t);
            }
        }
    }
    Ok(found)
}

/// One song in the shape Studio's pages and Save use.
fn track_row(uri: &str, t: &TrackMessage, added_at: Option<i64>) -> Option<Value> {
    let id = uri.strip_prefix(TRACK_PREFIX)?;
    let artists: Vec<(String, String)> = t
        .artist
        .iter()
        .filter_map(|a| Some((base62(a.gid())?, a.name().to_owned())).filter(|(_, n)| !n.is_empty()))
        .collect();
    let album = t.album.as_ref();
    Some(json!({
        "spotifyId": id,
        "title": t.name(),
        "artists": artists.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", "),
        "artistIds": artists.iter().map(|(i, _)| i).collect::<Vec<_>>(),
        "album": album.map(|a| a.name().to_owned()).unwrap_or_default(),
        "albumId": album.and_then(|a| base62(a.gid())),
        "albumArtUrl": album.and_then(|a| a.cover_group.as_ref()).and_then(|g| image_url(&g.image, ImageSize::LARGE)).unwrap_or_default(),
        "durationMs": t.duration().max(0),
        "explicit": t.explicit(),
        "trackNumber": if t.number() > 0 { json!(t.number()) } else { Value::Null },
        "discNumber": if t.disc_number() > 0 { json!(t.disc_number()) } else { Value::Null },
        "releaseDate": album.map(date_of).unwrap_or_default(),
        "addedAt": added_at.filter(|a| *a > 0).map(|a| a * 1000),
    }))
}

async fn rows_for(session: &Session, uris: &[(String, Option<i64>)]) -> Result<Vec<Value>, String> {
    let list: Vec<String> = uris.iter().map(|(u, _)| u.clone()).collect();
    let found = tracks_by_uri(session, &list).await?;
    Ok(uris.iter().filter_map(|(u, at)| track_row(u, found.get(u)?, *at)).collect())
}

/// Details for these track ids, in order.
pub async fn tracks(session: &Session, ids: &[String]) -> Result<Value, String> {
    let uris: Vec<(String, Option<i64>)> = ids.iter().map(|id| (format!("{TRACK_PREFIX}{id}"), None)).collect();
    Ok(Value::Array(rows_for(session, &uris).await?))
}

/// Liked Songs, newest first.
pub async fn liked(session: &Session) -> Result<Value, String> {
    let items = saved_items(session, "collection", TRACK_PREFIX, MAX_LIKED).await?;
    let uris: Vec<(String, Option<i64>)> = items.into_iter().map(|(u, at)| (u, Some(at))).collect();
    Ok(Value::Array(rows_for(session, &uris).await?))
}

/// A playlist's songs, from its context (the pages the clients play from).
pub async fn playlist(session: &Session, id: &str) -> Result<Value, String> {
    let context = session
        .spclient()
        .get_context(&format!("spotify:playlist:{id}"))
        .await
        .map_err(|e| format!("playlist: {e}"))?;
    let mut uris: Vec<(String, Option<i64>)> = Vec::new();
    for t in context.pages.iter().flat_map(|p| p.tracks.iter()) {
        if let Some(u) = t.uri.as_ref().filter(|u| u.starts_with(TRACK_PREFIX)) {
            uris.push((u.clone(), None));
        }
        if uris.len() >= MAX_PLAYLIST {
            break;
        }
    }
    Ok(Value::Array(rows_for(session, &uris).await?))
}

/* ------------------------------------------------------------ releases */

/// Releases from the last `days` days by `extra` (artists followed in
/// Studio) and, with `spotify`, the artists followed on Spotify, newest
/// first: `{ releases, artistsChecked, artistsTotal, artists }`.
pub async fn releases(session: &Session, days: u32, extra: &[String], spotify: bool) -> Result<Value, String> {
    let mut artist_uris: Vec<String> = extra.iter().filter(|id| !id.is_empty()).map(|id| format!("{ARTIST_PREFIX}{id}")).collect();
    let studio_count = artist_uris.len();
    let mut on_spotify: std::collections::HashSet<String> = std::collections::HashSet::new();
    if spotify {
        match saved_items(session, "artist", ARTIST_PREFIX, MAX_FOLLOWED).await {
            Ok(followed) => {
                for (u, _) in followed {
                    on_spotify.insert(u.clone());
                    if !artist_uris.contains(&u) {
                        artist_uris.push(u);
                    }
                }
            }
            // Studio's own follows still make a page without Spotify's.
            Err(e) if studio_count > 0 => log::warn!("releases: Spotify follows unavailable: {e}"),
            Err(e) => return Err(e),
        }
    }
    let mut artists: HashMap<String, ArtistMessage> = HashMap::new();
    for chunk in artist_uris.chunks(BATCH) {
        for (u, b) in extended(session, chunk, ExtensionKind::ARTIST_V4).await? {
            if let Ok(a) = ArtistMessage::parse_from_bytes(&b) {
                artists.insert(u, a);
            }
        }
    }

    // Album uri → the followed artists it's by (first found).
    let mut wanted: Vec<String> = Vec::new();
    let mut by: HashMap<String, (String, Option<String>)> = HashMap::new();
    for u in &artist_uris {
        let Some(a) = artists.get(u) else { continue };
        let portrait = {
            let mut images: Vec<_> = a.portrait_group.iter().flat_map(|g| g.image.iter().cloned()).collect();
            images.extend(a.portrait.iter().cloned());
            image_url(&images, ImageSize::DEFAULT)
        };
        for (groups, n) in [(&a.album_group, RECENT_ALBUMS), (&a.single_group, RECENT_SINGLES)] {
            for g in groups.iter().take(n) {
                if let Some(gid) = g.album.first().and_then(|x| base62(x.gid())) {
                    let au = format!("{ALBUM_PREFIX}{gid}");
                    if !by.contains_key(&au) {
                        by.insert(au.clone(), (a.name().to_owned(), portrait.clone()));
                        wanted.push(au);
                    }
                }
            }
        }
    }

    // Who was checked, for Studio's Following list (Spotify's follows included).
    let extra_uris: std::collections::HashSet<String> = extra.iter().map(|id| format!("{ARTIST_PREFIX}{id}")).collect();
    let checked: Vec<Value> = artist_uris
        .iter()
        .filter_map(|u| {
            let a = artists.get(u)?;
            let mut images: Vec<_> = a.portrait_group.iter().flat_map(|g| g.image.iter().cloned()).collect();
            images.extend(a.portrait.iter().cloned());
            Some(json!({
                "id": u.strip_prefix(ARTIST_PREFIX)?,
                "name": a.name(),
                "image": image_url(&images, ImageSize::DEFAULT),
                "source": if extra_uris.contains(u) { "studio" } else { "spotify" },
                "onSpotify": on_spotify.contains(u),
            }))
        })
        .collect();

    let cutoff = date_days_ago(days);
    let mut out: Vec<Value> = Vec::new();
    for chunk in wanted.chunks(BATCH) {
        for (u, b) in extended(session, chunk, ExtensionKind::ALBUM_V4).await? {
            let Ok(al) = AlbumMessage::parse_from_bytes(&b) else { continue };
            let date = date_of(&al);
            // Day-precise dates only: a year alone can't be placed in a week.
            if date.len() != 10 || date < cutoff {
                continue;
            }
            let Some(aid) = u.strip_prefix(ALBUM_PREFIX) else { continue };
            let total: usize = al.disc.iter().map(|d| d.track.len()).sum();
            let kind = match al.type_.map(|t| t.enum_value_or(AlbumType::ALBUM)) {
                Some(AlbumType::COMPILATION) => "compilation",
                Some(AlbumType::EP) | Some(AlbumType::SINGLE) => "single",
                _ => "album",
            };
            let cover = al.cover_group.as_ref();
            let (artist_name, portrait) = by.get(&u).cloned().unwrap_or_default();
            out.push(json!({
                "albumId": aid,
                "name": al.name(),
                "type": kind,
                "artists": al.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "),
                "artistIds": al.artist.iter().filter_map(|x| base62(x.gid())).collect::<Vec<_>>(),
                "albumArtUrl": cover.and_then(|g| image_url(&g.image, ImageSize::XLARGE)).unwrap_or_default(),
                "thumbUrl": cover.and_then(|g| image_url(&g.image, ImageSize::LARGE)).unwrap_or_default(),
                "releaseDate": date,
                "precision": "day",
                "totalTracks": total,
                "forArtists": [artist_name],
                "artistImage": portrait,
                "followed": true,
            }));
        }
    }
    out.sort_by(|x, y| {
        y["releaseDate"].as_str().cmp(&x["releaseDate"].as_str())
            .then(y["totalTracks"].as_u64().cmp(&x["totalTracks"].as_u64()))
    });
    // Clean and explicit cuts, regional duplicates: same name, artists, day.
    let mut seen = std::collections::HashSet::new();
    out.retain(|r| seen.insert(format!("{}|{}|{}", r["name"].as_str().unwrap_or("").to_lowercase(), r["artists"], r["releaseDate"])));

    Ok(json!({
        "releases": out,
        "artistsChecked": artists.len(),
        "artistsTotal": artist_uris.len(),
        "artists": checked,
    }))
}

/// Names and portraits for these artist ids, in one batch: `[{ id, name, image }]`.
pub async fn artists(session: &Session, ids: &[String]) -> Result<Value, String> {
    let uris: Vec<String> = ids.iter().filter(|id| !id.is_empty()).map(|id| format!("{ARTIST_PREFIX}{id}")).collect();
    let mut out = Vec::new();
    for chunk in uris.chunks(BATCH) {
        for (u, b) in extended(session, chunk, ExtensionKind::ARTIST_V4).await? {
            let Ok(a) = ArtistMessage::parse_from_bytes(&b) else { continue };
            let mut images: Vec<_> = a.portrait_group.iter().flat_map(|g| g.image.iter().cloned()).collect();
            images.extend(a.portrait.iter().cloned());
            if let Some(id) = u.strip_prefix(ARTIST_PREFIX) {
                out.push(json!({ "id": id, "name": a.name(), "image": image_url(&images, ImageSize::DEFAULT) }));
            }
        }
    }
    Ok(Value::Array(out))
}

/// Add songs to (or take them out of) Liked Songs, through the collection
/// service as Spotify's clients do, not the Web API.
pub async fn like(session: &Session, ids: &[String], saved: bool) -> Result<Value, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
    let username = session.username();
    let mut done = 0;
    for (n, id) in ids.iter().filter(|id| !id.is_empty()).enumerate() {
        let mut item = Vec::new();
        pb_string(&mut item, 1, &format!("{TRACK_PREFIX}{id}"));
        pb_varint_field(&mut item, 2, if saved { now.as_secs() } else { 0 });
        pb_varint_field(&mut item, 3, u64::from(!saved));
        let mut req = Vec::new();
        pb_string(&mut req, 1, &username);
        pb_string(&mut req, 2, "collection");
        write_varint(&mut req, u64::from(3u32 << 3 | 2));
        write_varint(&mut req, item.len() as u64);
        req.extend_from_slice(&item);
        pb_string(&mut req, 4, &format!("studio-{}-{}-{n}", now.as_secs(), now.subsec_nanos()));
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(CONTENT));
        headers.insert(ACCEPT, HeaderValue::from_static(CONTENT));
        session
            .spclient()
            .request(&Method::POST, "/collection/v2/write", Some(headers), Some(&req))
            .await
            .map_err(|e| format!("liked songs: {e}"))?;
        done += 1;
    }
    Ok(json!({ "count": done }))
}

/// "YYYY-MM-DD" for `days` days before today (UTC).
fn date_days_ago(days: u32) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, m, d) = civil_from_days(now / 86_400 - i64::from(days));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_from_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn reads_a_collection_page() {
        // One live item, one removed, and a next-page token.
        let mut item = Vec::new();
        pb_string(&mut item, 1, "spotify:artist:abc");
        pb_varint_field(&mut item, 2, 1_700_000_000);
        let mut gone = Vec::new();
        pb_string(&mut gone, 1, "spotify:artist:old");
        pb_varint_field(&mut gone, 3, 1);
        let mut page = Vec::new();
        for it in [&item, &gone] {
            write_varint(&mut page, u64::from(1u32 << 3 | 2));
            write_varint(&mut page, it.len() as u64);
            page.extend_from_slice(it);
        }
        pb_string(&mut page, 2, "next-token");
        let (items, next) = collection_page(&page).unwrap();
        assert_eq!(items, vec![("spotify:artist:abc".to_owned(), 1_700_000_000)]);
        assert_eq!(next, "next-token");
    }
}
