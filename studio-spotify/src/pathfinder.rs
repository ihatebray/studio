/* =========================================================================
 *  Pathfinder (the web player's GraphQL), from this session
 *
 *  The way Sonora asks it: librespot's own login5 token and client token,
 *  through the session's HTTP client (and its per-domain request limiter),
 *  so to Spotify it's a Spotify client asking. Studio used to send these from
 *  Node with a separate browser sign-in token presented as the web player,
 *  which Spotify rate-limited far sooner.
 *
 *  Studio resolves the query hash and builds the variables; this sends the
 *  query and hands back `data`, or an error Studio can act on:
 *  "ratelimit:<seconds>", "signin: …", "graphql: …", "http <status>".
 * ========================================================================= */

use bytes::Bytes;
use http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use librespot_core::{spclient::CLIENT_TOKEN, Session};
use serde_json::{json, Value};

const ENDPOINT: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const APP_PLATFORM: &str = "WebPlayer";
const APP_VERSION: &str = "896000000";
/// When Spotify says 429 without saying how long.
const DEFAULT_WAIT_S: u64 = 60;

pub async fn query(session: &Session, op: &str, hash: &str, variables: &Value) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({
        "operationName": op,
        "variables": variables,
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } },
    }))
    .map_err(|e| format!("encode {op}: {e}"))?;
    let token = session.login5().auth_token().await.map_err(|e| format!("signin: no access token ({e})"))?;
    let client_token = session.spclient().client_token().await.map_err(|e| format!("signin: no client token ({e})"))?;
    let request = Request::builder()
        .method(Method::POST)
        .uri(ENDPOINT)
        .header(header::ACCEPT, "application/json")
        .header(header::CONTENT_TYPE, "application/json")
        .header("app-platform", APP_PLATFORM)
        .header("spotify-app-version", APP_VERSION)
        .header(header::AUTHORIZATION, format!("{} {}", token.token_type, token.access_token))
        .header(CLIENT_TOKEN, client_token)
        .body(Bytes::from(body))
        .map_err(|e| format!("build {op}: {e}"))?;

    /* request_fut, not request(): request() sleeps through a 429 itself,
       which would hold the page for however long Spotify asks. The limiter
       still applies; its refusal is reported as a wait. */
    let fut = session.http_client().request_fut(request).map_err(|e| {
        let text = e.to_string();
        let secs = text
            .split_whitespace()
            .find_map(|w| w.parse::<u64>().ok())
            .unwrap_or(DEFAULT_WAIT_S);
        format!("ratelimit:{secs}")
    })?;
    let response = fut.await.map_err(|e| format!("request {op}: {e}"))?;
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let wait = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_WAIT_S);
        return Err(format!("ratelimit:{wait}"));
    }
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("read {op}: {e}"))?
        .to_bytes();
    if status == StatusCode::UNAUTHORIZED {
        return Err("signin: Spotify rejected the session (401)".into());
    }
    if !status.is_success() {
        // A rotated hash can come back as a 4xx with the GraphQL error in
        // the body; that message is what tells Studio to look the hash up again.
        return Err(match decoded(&bytes, op) {
            Err(e) if e.starts_with("graphql:") && !e.contains("no data") => e,
            _ => format!("http {}", status.as_u16()),
        });
    }
    decoded(&bytes, op)
}

fn decoded(bytes: &[u8], op: &str) -> Result<Value, String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|e| format!("decode {op}: {e}"))?;
    let errors: Vec<String> = body["errors"]
        .as_array()
        .map(|list| list.iter().filter_map(|e| e["message"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    match body.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ if !errors.is_empty() => Err(format!("graphql: {}", errors.join("; "))),
        _ => Err(format!("graphql: {op} came back with no data")),
    }
}

#[cfg(test)]
mod tests {
    use super::decoded;

    #[test]
    fn decodes_data() {
        assert_eq!(decoded(br#"{"data":{"value":42}}"#, "t").unwrap()["value"], 42);
    }

    #[test]
    fn reports_graphql_errors() {
        let e = decoded(br#"{"data":null,"errors":[{"message":"PersistedQueryNotFound"}]}"#, "t").unwrap_err();
        assert!(e.starts_with("graphql:") && e.contains("PersistedQueryNotFound"));
    }
}
