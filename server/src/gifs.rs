//! GIF search through KLIPY (Tenor's public API closed in June 2026). The key
//! stays on the server; clients only see results. A GIF is sent by id, and the
//! server looks the media URL up in its own cache of results, so clients can
//! never make others load an arbitrary URL.
//!
//! The response format is parsed defensively (several known shapes, missing
//! sizes skipped): a format change degrades to "no results", never a crash.

use crate::state::State;
use hopon_shared::{Attachment, Gif, Id};
use serde_json::Value;
use std::time::{Duration, Instant};

const BASE: &str = "https://api.klipy.com/api/v1";
const PER_PAGE: u32 = 24;
const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);

/// Opaque per-user id for the provider (it never sees names or user ids).
fn customer_id(st: &State, uid: Id) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(&st.cfg.jwt_secret);
    h.update(b"gif-customer");
    h.update(uid.to_le_bytes());
    h.finalize()[..12].iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn search(st: &State, uid: Id, query: &str) -> Option<Vec<Gif>> {
    let key = st.cfg.klipy_key.as_ref()?;
    let q = query.trim().chars().take(100).collect::<String>();
    let url = if q.is_empty() { format!("{BASE}/{key}/gifs/trending") } else { format!("{BASE}/{key}/gifs/search") };
    let mut params = vec![("per_page", PER_PAGE.to_string()), ("customer_id", customer_id(st, uid)), ("content_filter", "medium".into())];
    if !q.is_empty() {
        params.push(("q", q));
    }
    let res = st.http.get(&url).query(&params).timeout(Duration::from_secs(6)).send().await;
    let body: Value = match res {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("gif search: bad json: {e}");
                return Some(vec![]);
            }
        },
        Ok(r) => {
            tracing::warn!("gif search: HTTP {}", r.status());
            return Some(vec![]);
        }
        Err(e) => {
            tracing::warn!("gif search: {e}");
            return Some(vec![]);
        }
    };
    let parsed = parse(&body);
    let now = Instant::now();
    let mut out = Vec::with_capacity(parsed.len());
    for (gif, att) in parsed {
        st.gifs.insert(gif.id.clone(), (att, now));
        out.push(gif);
    }
    Some(out)
}

/// Resolve GIF ids from earlier search results into attachments.
pub fn claim(st: &State, ids: &[String]) -> Result<Vec<Attachment>, String> {
    ids.iter()
        .map(|id| st.gifs.get(id).map(|e| e.0.clone()).ok_or_else(|| "that GIF expired; pick it again".to_string()))
        .collect()
}

pub fn prune(st: &State) {
    st.gifs.retain(|_, (_, t)| t.elapsed() < CACHE_TTL);
}

/// One media rendition: (url, width, height, size).
fn media(v: &Value) -> Option<(String, u32, u32, u64)> {
    let url = v.get("url")?.as_str()?;
    if !url.starts_with("https://") || url.len() > 1024 {
        return None;
    }
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
    Some((url.to_owned(), n("width") as u32, n("height") as u32, n("size")))
}

fn pick(file: &Value, sizes: &[&str], formats: &[&str]) -> Option<(String, u32, u32, u64, &'static str)> {
    for s in sizes {
        for f in formats {
            if let Some(m) = file.get(*s).and_then(|x| x.get(*f)).and_then(media) {
                let mime = match *f {
                    "mp4" => "video/mp4",
                    "webm" => "video/webm",
                    "webp" => "image/webp",
                    _ => "image/gif",
                };
                return Some((m.0, m.1, m.2, m.3, mime));
            }
        }
    }
    None
}

/// Results → (picker entry, attachment to send). Public for tests.
pub fn parse(body: &Value) -> Vec<(Gif, Attachment)> {
    // Seen shapes: {data:{data:[..]}}, {data:[..]}, {results:[..]}.
    let items = body
        .get("data")
        .and_then(|d| d.get("data").or(Some(d)))
        .and_then(|d| d.as_array())
        .or_else(|| body.get("results").and_then(|r| r.as_array()));
    let Some(items) = items else { return vec![] };
    items
        .iter()
        .filter_map(|it| {
            let raw_id = it.get("id").and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string())))
                .or_else(|| it.get("slug").and_then(|v| v.as_str()).map(str::to_owned))?;
            if raw_id.is_empty() || raw_id.len() > 64 {
                return None;
            }
            let file = it.get("file").or_else(|| it.get("files"))?;
            // What's sent: video loops are far cheaper to play than GIFs.
            let send = pick(file, &["md", "hd", "sm"], &["mp4", "webm", "gif", "webp"])?;
            let preview = pick(file, &["sm", "xs", "md"], &["webp", "gif"]).map(|p| p.0).unwrap_or_else(|| send.0.clone());
            let title: String = it.get("title").and_then(|v| v.as_str()).unwrap_or("GIF").chars().take(80).collect();
            let id = format!("klipy:{raw_id}");
            let gif = Gif { id: id.clone(), title: title.clone(), preview: preview.clone(), width: send.1, height: send.2 };
            let att = Attachment {
                id,
                name: if title.is_empty() { "GIF".into() } else { title },
                mime: send.4.into(),
                size: send.3,
                width: send.1,
                height: send.2,
                url: send.0,
                preview,
            };
            Some((gif, att))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::json;

    #[test]
    fn parses_nested_and_flat_shapes() {
        let item = json!({
            "id": 123, "title": "cat dance",
            "file": {
                "hd": {"gif": {"url": "https://static.klipy.com/a/hd.gif", "width": 498, "height": 280, "size": 900000}},
                "md": {"mp4": {"url": "https://static.klipy.com/a/md.mp4", "width": 320, "height": 180, "size": 120000},
                       "gif": {"url": "https://static.klipy.com/a/md.gif", "width": 320, "height": 180}},
                "sm": {"webp": {"url": "https://static.klipy.com/a/sm.webp", "width": 160, "height": 90}},
            }
        });
        let nested = parse(&json!({"result": true, "data": {"data": [item.clone()], "has_next": true}}));
        assert_eq!(nested.len(), 1);
        let (g, a) = &nested[0];
        assert_eq!(g.id, "klipy:123");
        assert_eq!(a.mime, "video/mp4");
        assert_eq!(a.url, "https://static.klipy.com/a/md.mp4");
        assert_eq!((a.width, a.height), (320, 180));
        assert_eq!(g.preview, "https://static.klipy.com/a/sm.webp");
        assert_eq!(parse(&json!({"data": [item]})).len(), 1);
        // gif-only, string sizes, http URL rejected, junk skipped.
        let only_gif = json!({"data": [
            {"id": "x", "file": {"hd": {"gif": {"url": "https://c/x.gif", "width": "200", "height": "100"}}}},
            {"id": "y", "file": {"hd": {"gif": {"url": "http://c/y.gif"}}}},
            {"nope": 1},
        ]});
        let r = parse(&only_gif);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1.mime, "image/gif");
        assert_eq!((r[0].1.width, r[0].1.height), (200, 100));
        assert!(parse(&json!({"error": "bad key"})).is_empty());
    }
}
