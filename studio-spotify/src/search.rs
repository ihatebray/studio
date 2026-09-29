//! Catalogue search over the librespot session, the way Sonora (and Spotify's
//! own clients) do it: resolve the `spotify:search:<query>` context, then read
//! every track's metadata in one batched extended-metadata request.
//!
//! Studio used to search through the Web API with a Developer Mode Client ID,
//! whose small quota ran out after a couple of searches. This path uses the
//! signed-in session's own client endpoints instead. Metadata only.
//!
//! Albums and artists come from the songs found, as in Sonora; the leading
//! artists' portraits are one more batched request.

use std::collections::HashMap;

use librespot_core::{Session, SpotifyId};
use librespot_protocol::extended_metadata::{BatchedEntityRequest, EntityRequest, ExtensionQuery};
use librespot_protocol::extension_kind::ExtensionKind;
use librespot_protocol::metadata::image::Size as ImageSize;
use librespot_protocol::metadata::album::Type as AlbumType;
use librespot_protocol::metadata::{Album as AlbumMessage, Artist as ArtistMessage, Image, Track as TrackMessage};
use protobuf::{EnumOrUnknown, Message};
use serde_json::{json, Value};

const TRACK_PREFIX: &str = "spotify:track:";
const ARTIST_PREFIX: &str = "spotify:artist:";
const ALBUM_PREFIX: &str = "spotify:album:";
const MAX_RELEASES: usize = 150;
const IMAGE_CDN: &str = "https://i.scdn.co/image/";
const MAX_TRACKS: usize = 30;
const MAX_ARTISTS: usize = 8;

/// `{ tracks, albums, artists }` in the shapes Studio's search panel uses.
pub async fn search(session: &Session, query: &str) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(json!({ "tracks": [], "albums": [], "artists": [] }));
    }
    let context = session
        .spclient()
        .get_context(&format!("spotify:search:{}", escaped(query)))
        .await
        .map_err(|e| format!("search context: {e}"))?;
    let mut uris: Vec<String> = Vec::new();
    for uri in context.pages.iter().flat_map(|p| p.tracks.iter()).filter_map(|t| t.uri.clone()) {
        if uri.starts_with(TRACK_PREFIX) && !uris.contains(&uri) {
            uris.push(uri);
        }
        if uris.len() >= MAX_TRACKS {
            break;
        }
    }
    if uris.is_empty() {
        return Ok(json!({ "tracks": [], "albums": [], "artists": [] }));
    }

    let found: HashMap<String, TrackMessage> = extended(session, &uris, ExtensionKind::TRACK_V4)
        .await?
        .into_iter()
        .filter_map(|(uri, bytes)| Some((uri, TrackMessage::parse_from_bytes(&bytes).ok()?)))
        .collect();

    let mut tracks = Vec::new();
    let mut albums: Vec<Value> = Vec::new();
    let mut album_seen: Vec<String> = Vec::new();
    // Artist id → (name, songs credited first) in order of first appearance.
    let mut artist_order: Vec<String> = Vec::new();
    let mut artist_info: HashMap<String, (String, usize)> = HashMap::new();

    for uri in &uris {
        let Some(t) = found.get(uri) else { continue };
        let Some(id) = uri.strip_prefix(TRACK_PREFIX) else { continue };
        let artists: Vec<(String, String)> = t
            .artist
            .iter()
            .filter_map(|a| Some((base62(a.gid())?, a.name().to_owned())).filter(|(_, n)| !n.is_empty()))
            .collect();
        let names = artists.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ");
        let album = t.album.as_ref();
        let album_id = album.and_then(|a| base62(a.gid())).unwrap_or_default();
        let album_name = album.map(|a| a.name().to_owned()).unwrap_or_default();
        let cover = album.and_then(|a| a.cover_group.as_ref()).and_then(|g| image_url(&g.image, ImageSize::LARGE));

        tracks.push(json!({
            "spotifyId": id,
            "title": t.name(),
            "artists": names,
            "artistIds": artists.iter().map(|(i, _)| i).collect::<Vec<_>>(),
            "album": album_name,
            "albumId": album_id,
            "albumArtUrl": cover.clone().unwrap_or_default(),
            "durationMs": t.duration().max(0),
            "spotifyUrl": format!("https://open.spotify.com/track/{id}"),
            "popularity": t.popularity().clamp(0, 100),
            "explicit": t.explicit(),
            "trackNumber": if t.number() > 0 { json!(t.number()) } else { Value::Null },
            "discNumber": if t.disc_number() > 0 { json!(t.disc_number()) } else { Value::Null },
            "releaseDate": "",
            "primaryArtistId": artists.first().map(|(i, _)| i.clone()).unwrap_or_default(),
        }));

        if !album_id.is_empty() && !album_seen.contains(&album_id) {
            album_seen.push(album_id.clone());
            let album_artists = album
                .map(|a| a.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| names.clone());
            albums.push(json!({
                "albumId": album_id,
                "name": album_name,
                "artists": album_artists,
                "albumArtUrl": cover.unwrap_or_default(),
                "totalTracks": 0,
                "releaseDate": "",
                "spotifyUrl": format!("https://open.spotify.com/album/{album_id}"),
                "albumType": "",
            }));
        }

        if let Some((aid, name)) = artists.first() {
            let entry = artist_info.entry(aid.clone()).or_insert_with(|| {
                artist_order.push(aid.clone());
                (name.clone(), 0)
            });
            entry.1 += 1;
        }
    }

    // Leading artists: most songs among the results first, then order found.
    let mut leading = artist_order.clone();
    leading.sort_by_key(|id| std::cmp::Reverse(artist_info.get(id).map(|(_, n)| *n).unwrap_or(0)));
    leading.truncate(MAX_ARTISTS);
    let artist_uris: Vec<String> = leading.iter().map(|id| format!("{ARTIST_PREFIX}{id}")).collect();
    // Portraits are a nicety: without them the artists still show.
    let portraits: HashMap<String, (Option<String>, i32)> = match extended(session, &artist_uris, ExtensionKind::ARTIST_V4).await {
        Ok(list) => list
            .into_iter()
            .filter_map(|(uri, bytes)| {
                let a = ArtistMessage::parse_from_bytes(&bytes).ok()?;
                let mut images: Vec<Image> = a.portrait_group.iter().flat_map(|g| g.image.iter().cloned()).collect();
                images.extend(a.portrait.iter().cloned());
                Some((uri.strip_prefix(ARTIST_PREFIX)?.to_owned(), (image_url(&images, ImageSize::DEFAULT), a.popularity())))
            })
            .collect(),
        Err(e) => {
            log::warn!("search: artist portraits: {e}");
            HashMap::new()
        }
    };
    let artists: Vec<Value> = leading
        .iter()
        .map(|id| {
            let (name, _) = artist_info.get(id).cloned().unwrap_or_default();
            let (image, popularity) = portraits.get(id).cloned().unwrap_or((None, 0));
            json!({
                "id": id,
                "name": name,
                "genres": [],
                "followers": Value::Null,
                "popularity": if popularity > 0 { json!(popularity) } else { Value::Null },
                "image": image,
            })
        })
        .collect();

    Ok(json!({ "tracks": tracks, "albums": albums, "artists": artists }))
}

/// An album's tracklist, in the shape Studio's `spotify:albumTracks` returns:
/// `{ album, artists, albumArtUrl, tracks }`. Two requests: the album, then
/// all of its tracks at once.
pub async fn album(session: &Session, id: &str) -> Result<Value, String> {
    let uri = format!("{ALBUM_PREFIX}{id}");
    let bytes = extended(session, std::slice::from_ref(&uri), ExtensionKind::ALBUM_V4)
        .await?
        .into_iter()
        .next()
        .map(|(_, b)| b)
        .ok_or("album not found")?;
    let a = AlbumMessage::parse_from_bytes(&bytes).map_err(|e| format!("album: {e}"))?;
    let name = a.name().to_owned();
    let artists = a.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", ");
    let cover = a.cover_group.as_ref().and_then(|g| image_url(&g.image, ImageSize::LARGE)).unwrap_or_default();
    // Disc and position come from the album's own listing.
    let mut order: Vec<(String, i32, i32)> = Vec::new();
    for (d, disc) in a.disc.iter().enumerate() {
        let disc_no = if disc.number() > 0 { disc.number() } else { d as i32 + 1 };
        for (n, t) in disc.track.iter().enumerate() {
            if let Some(tid) = base62(t.gid()) {
                order.push((format!("{TRACK_PREFIX}{tid}"), disc_no, n as i32 + 1));
            }
        }
    }
    let uris: Vec<String> = order.iter().map(|(u, _, _)| u.clone()).collect();
    let found: HashMap<String, TrackMessage> = extended(session, &uris, ExtensionKind::TRACK_V4)
        .await?
        .into_iter()
        .filter_map(|(u, b)| Some((u, TrackMessage::parse_from_bytes(&b).ok()?)))
        .collect();
    let tracks: Vec<Value> = order
        .iter()
        .filter_map(|(u, disc, n)| {
            let t = found.get(u)?;
            let id = u.strip_prefix(TRACK_PREFIX)?;
            let names = t.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", ");
            Some(json!({
                "spotifyId": id, "title": t.name(), "artists": names,
                "album": name, "albumArtUrl": cover, "albumArtists": artists,
                "durationMs": t.duration().max(0),
                "trackNumber": if t.number() > 0 { t.number() } else { *n },
                "discNumber": if t.disc_number() > 0 { t.disc_number() } else { *disc },
                "spotifyUrl": format!("https://open.spotify.com/track/{id}"),
                "explicit": t.explicit(),
            }))
        })
        .collect();
    Ok(json!({ "album": name, "artists": artists, "albumArtUrl": cover, "tracks": tracks, "releaseDate": date_of(&a) }))
}

/// An artist's albums and singles (newest first) and top songs:
/// `{ albums, topTracks }`, in the Client ID's shapes. Three requests: the
/// artist, every release at once, every top song at once.
pub async fn artist(session: &Session, id: &str, country: &str) -> Result<Value, String> {
    let uri = format!("{ARTIST_PREFIX}{id}");
    let bytes = extended(session, std::slice::from_ref(&uri), ExtensionKind::ARTIST_V4)
        .await?
        .into_iter()
        .next()
        .map(|(_, b)| b)
        .ok_or("artist not found")?;
    let a = ArtistMessage::parse_from_bytes(&bytes).map_err(|e| format!("artist: {e}"))?;

    // Each group lists every regional edition of a release; the first is the one.
    let mut releases: Vec<(String, &'static str)> = Vec::new();
    for (groups, group) in [(&a.album_group, "album"), (&a.single_group, "single")] {
        for g in groups.iter() {
            if let Some(gid) = g.album.first().and_then(|x| base62(x.gid())) {
                let u = format!("{ALBUM_PREFIX}{gid}");
                if !releases.iter().any(|(r, _)| *r == u) {
                    releases.push((u, group));
                }
            }
        }
    }
    releases.truncate(MAX_RELEASES);
    let uris: Vec<String> = releases.iter().map(|(u, _)| u.clone()).collect();
    let albums_found: HashMap<String, AlbumMessage> = extended(session, &uris, ExtensionKind::ALBUM_V4)
        .await?
        .into_iter()
        .filter_map(|(u, b)| Some((u, AlbumMessage::parse_from_bytes(&b).ok()?)))
        .collect();
    let mut albums: Vec<Value> = releases
        .iter()
        .filter_map(|(u, group)| {
            let al = albums_found.get(u)?;
            let aid = u.strip_prefix(ALBUM_PREFIX)?;
            let kind = match al.type_.map(|t| t.enum_value_or(AlbumType::ALBUM)) {
                Some(AlbumType::COMPILATION) => "compilation",
                Some(AlbumType::EP) | Some(AlbumType::SINGLE) => "single",
                _ => *group,
            };
            Some(json!({
                "albumId": aid,
                "name": al.name(),
                "artists": al.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "),
                "albumArtUrl": al.cover_group.as_ref().and_then(|g| image_url(&g.image, ImageSize::LARGE)).unwrap_or_default(),
                "totalTracks": al.disc.iter().map(|d| d.track.len()).sum::<usize>(),
                "releaseDate": date_of(al),
                "albumGroup": kind,
                "spotifyUrl": format!("https://open.spotify.com/album/{aid}"),
            }))
        })
        .collect();
    albums.sort_by(|x, y| y["releaseDate"].as_str().unwrap_or("").cmp(x["releaseDate"].as_str().unwrap_or("")));

    let top = a
        .top_track
        .iter()
        .find(|t| t.country().eq_ignore_ascii_case(country))
        .or_else(|| a.top_track.first());
    let top_uris: Vec<String> = top
        .map(|t| t.track.iter().filter_map(|x| base62(x.gid())).map(|g| format!("{TRACK_PREFIX}{g}")).take(10).collect())
        .unwrap_or_default();
    let found: HashMap<String, TrackMessage> = extended(session, &top_uris, ExtensionKind::TRACK_V4)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(u, b)| Some((u, TrackMessage::parse_from_bytes(&b).ok()?)))
        .collect();
    let top_tracks: Vec<Value> = top_uris
        .iter()
        .enumerate()
        .filter_map(|(i, u)| {
            let t = found.get(u)?;
            let tid = u.strip_prefix(TRACK_PREFIX)?;
            let album = t.album.as_ref();
            Some(json!({
                "spotifyId": tid, "title": t.name(),
                "artists": t.artist.iter().map(|x| x.name().to_owned()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "),
                "album": album.map(|x| x.name().to_owned()).unwrap_or_default(),
                "albumId": album.and_then(|x| base62(x.gid())),
                "albumArtUrl": album.and_then(|x| x.cover_group.as_ref()).and_then(|g| image_url(&g.image, ImageSize::LARGE)).unwrap_or_default(),
                "durationMs": t.duration().max(0),
                "spotifyUrl": format!("https://open.spotify.com/track/{tid}"),
                "popularity": if t.popularity() > 0 { t.popularity() } else { 100 - (i as i32) * 4 },
                "explicit": t.explicit(),
                "trackNumber": Value::Null, "discNumber": Value::Null, "releaseDate": "",
                "primaryArtistId": id,
            }))
        })
        .collect();

    Ok(json!({ "albums": albums, "topTracks": top_tracks }))
}

fn date_of(a: &AlbumMessage) -> String {
    let Some(d) = a.date.as_ref() else { return String::new() };
    match (d.year(), d.month(), d.day()) {
        (0, _, _) => String::new(),
        (y, 0, _) => format!("{y:04}"),
        (y, m, 0) => format!("{y:04}-{m:02}"),
        (y, m, day) => format!("{y:04}-{m:02}-{day:02}"),
    }
}

/// Extended metadata for `uris`, as (uri, protobuf bytes), in one request.
async fn extended(session: &Session, uris: &[String], kind: ExtensionKind) -> Result<Vec<(String, Vec<u8>)>, String> {
    if uris.is_empty() {
        return Ok(Vec::new());
    }
    let request = BatchedEntityRequest {
        entity_request: uris
            .iter()
            .map(|uri| EntityRequest {
                entity_uri: uri.clone(),
                query: vec![ExtensionQuery { extension_kind: EnumOrUnknown::new(kind), ..Default::default() }],
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let response = session
        .spclient()
        .get_extended_metadata(request)
        .await
        .map_err(|e| format!("metadata: {e}"))?;
    Ok(response
        .extended_metadata
        .into_iter()
        .flat_map(|array| array.extension_data)
        .filter_map(|entity| {
            let bytes = entity.extension_data.as_ref()?.value.clone();
            Some((entity.entity_uri, bytes))
        })
        .collect())
}

fn base62(gid: &[u8]) -> Option<String> {
    SpotifyId::from_raw(gid).ok()?.to_base62().ok()
}

/// The image closest to `want` (by size class), as an i.scdn.co URL.
fn image_url(images: &[Image], want: ImageSize) -> Option<String> {
    let rank = |s: ImageSize| match s {
        ImageSize::SMALL => 0i32,
        ImageSize::DEFAULT => 1,
        ImageSize::LARGE => 2,
        ImageSize::XLARGE => 3,
    };
    let target = rank(want);
    let best = images
        .iter()
        .filter(|i| i.has_file_id())
        .min_by_key(|i| (rank(i.size()) - target).abs() * 2 + i32::from(rank(i.size()) < target))?;
    let hex: String = best.file_id().iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("{IMAGE_CDN}{hex}"))
}

/// The query as Spotify's search context expects it: spaces as `+`,
/// everything outside the unreserved set percent-encoded.
fn escaped(query: &str) -> String {
    query
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            b' ' => "+".to_owned(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_the_clients() {
        assert_eq!(escaped("queen bohemian"), "queen+bohemian");
        assert_eq!(escaped("sigur rós"), "sigur+r%C3%B3s");
        assert_eq!(escaped("AC/DC"), "AC%2FDC");
    }

    #[test]
    fn picks_the_nearest_image() {
        let img = |size: ImageSize, id: u8| {
            let mut i = Image::new();
            i.set_size(size);
            i.set_file_id(vec![id; 20]);
            i
        };
        let images = vec![img(ImageSize::SMALL, 1), img(ImageSize::LARGE, 3), img(ImageSize::DEFAULT, 2)];
        assert!(image_url(&images, ImageSize::LARGE).unwrap().ends_with(&"03".repeat(20)));
        assert!(image_url(&images, ImageSize::DEFAULT).unwrap().ends_with(&"02".repeat(20)));
        assert!(image_url(&[], ImageSize::LARGE).is_none());
    }
}
