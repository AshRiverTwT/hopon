//! File attachments over plain HTTP (never through the chat socket, so a big
//! upload can't delay anyone's messages).
//!
//!   POST /files?name=..&w=..&h=..   Authorization: Bearer <access token>
//!        body = raw bytes, streamed to disk with a size cap → Attachment JSON
//!   GET  /files/{id}                public; ids are 128-bit random
//!
//! An upload is "pending" until a `Send` claims it; unclaimed uploads are
//! swept after a day. Deleting a message, channel or server deletes its files.
//! Limits: per file, per user, and a free-disk floor so uploads can never fill
//! the disk Postgres lives on.

use crate::state::State;
use axum::body::Body;
use axum::extract::{Path, Query, Request, State as AxState};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use hopon_shared::{Attachment, Id};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

#[derive(serde::Deserialize)]
pub struct UploadQuery {
    name: Option<String>,
    w: Option<u32>,
    h: Option<u32>,
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], msg.to_owned()).into_response()
}

/// Content type by magic bytes. Anything unrecognised is served as a download.
pub fn sniff(b: &[u8]) -> &'static str {
    if let Some(m) = hopon_shared::image_mime(b) {
        return m;
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if b.len() > 12 && &b[4..8] == b"ftyp" {
        return "video/mp4";
    }
    if b.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return "video/webm";
    }
    if b.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    "application/octet-stream"
}

/// Shown inline by clients; everything else is offered as a download.
pub fn inline_mime(m: &str) -> bool {
    matches!(m, "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4" | "video/webm")
}

fn clean_name(n: &str) -> String {
    let n: String = n.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | '"')).collect();
    let n = n.trim().trim_matches('.').to_owned();
    let n: String = n.chars().take(120).collect();
    if n.is_empty() { "file".into() } else { n }
}

fn new_id() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Free bytes on the filesystem holding `dir` (unknown → u64::MAX).
fn free_bytes(dir: &std::path::Path) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = match std::ffi::CString::new(dir.as_os_str().as_bytes()) {
            Ok(c) => c,
            Err(_) => return u64::MAX,
        };
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0 {
            return (s.f_bavail as u64).saturating_mul(s.f_frsize as u64);
        }
    }
    let _ = dir;
    u64::MAX
}

pub async fn upload(AxState(st): AxState<Arc<State>>, Query(q): Query<UploadQuery>, headers: HeaderMap, req: Request) -> Response {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let Some((uid, _)) = token.and_then(|t| st.keys.verify(t)) else {
        return err(StatusCode::UNAUTHORIZED, "sign in again");
    };
    let _upload_permit = match st.upload_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            st.metrics.upload_rejected.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return err(StatusCode::TOO_MANY_REQUESTS, "upload capacity is busy; retry shortly");
        }
    };
    let cfg = &st.cfg;
    let max = cfg.max_upload_bytes;
    if let Some(len) = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
        if len > max {
            return err(StatusCode::PAYLOAD_TOO_LARGE, &format!("files can be at most {} MB", max / 1_048_576));
        }
    }
    let used: (Option<i64>,) = match sqlx::query_as("SELECT SUM(size)::BIGINT FROM files WHERE uploader = $1").bind(uid).fetch_one(&st.db).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("upload quota: {e}");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    if used.0.unwrap_or(0) as u64 >= cfg.user_quota_bytes {
        return err(StatusCode::INSUFFICIENT_STORAGE, "you've used your upload space; delete some old files first");
    }
    if free_bytes(&cfg.files_dir) < cfg.min_free_bytes + max {
        tracing::warn!("uploads refused: disk nearly full");
        return err(StatusCode::INSUFFICIENT_STORAGE, "the server is low on disk space");
    }

    let id = new_id();
    let path = cfg.files_dir.join(&id);
    let tmp = cfg.files_dir.join(format!("{id}.part"));
    let mut f = match tokio::fs::File::create(&tmp).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("upload create {}: {e}", tmp.display());
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    let mut size: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(32);
    let mut body = req.into_body().into_data_stream();
    while let Some(chunk) = body.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return err(StatusCode::BAD_REQUEST, "upload interrupted");
            }
        };
        size += chunk.len() as u64;
        if size > max {
            drop(f);
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::PAYLOAD_TOO_LARGE, &format!("files can be at most {} MB", max / 1_048_576));
        }
        if head.len() < 32 {
            head.extend_from_slice(&chunk[..chunk.len().min(32 - head.len())]);
        }
        if f.write_all(&chunk).await.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::INTERNAL_SERVER_ERROR, "could not save the file");
        }
    }
    if size == 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::BAD_REQUEST, "empty file");
    }
    if f.flush().await.is_err() || tokio::fs::rename(&tmp, &path).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not save the file");
    }
    let mime = sniff(&head);
    let name = clean_name(q.name.as_deref().unwrap_or("file"));
    // Pixel size is a layout hint from the uploader; clamp it to sane values.
    let (w, h) = if inline_mime(mime) { (q.w.unwrap_or(0).min(16384), q.h.unwrap_or(0).min(16384)) } else { (0, 0) };
    let r = sqlx::query("INSERT INTO files (id, uploader, name, mime, size, width, height) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(&id).bind(uid).bind(&name).bind(mime).bind(size as i64).bind(w as i32).bind(h as i32)
        .execute(&st.db).await;
    if let Err(e) = r {
        tracing::error!("upload insert: {e}");
        let _ = tokio::fs::remove_file(&path).await;
        return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    let a = Attachment { id, name, mime: mime.into(), size, width: w, height: h, url: String::new(), preview: String::new() };
    ([(header::CONTENT_TYPE, "application/json")], serde_json::to_string(&a).unwrap_or_default()).into_response()
}

pub async fn download(AxState(st): AxState<Arc<State>>, Path(id): Path<String>) -> Response {
    if !valid_id(&id) {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let row: Option<(String, String, i64)> = sqlx::query_as("SELECT name, mime, size FROM files WHERE id = $1")
        .bind(&id).fetch_optional(&st.db).await.ok().flatten();
    let Some((name, mime, size)) = row else {
        return err(StatusCode::NOT_FOUND, "not found");
    };
    let f = match tokio::fs::File::open(st.cfg.files_dir.join(&id)).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::NOT_FOUND, "not found"),
    };
    let inline = inline_mime(&mime);
    let ctype = if inline || mime == "application/pdf" { mime.as_str() } else { "application/octet-stream" };
    let ascii: String = name.chars().map(|c| if c.is_ascii() && c != '"' { c } else { '_' }).collect();
    let disp = format!("{}; filename=\"{ascii}\"", if inline { "inline" } else { "attachment" });
    let mut res = Response::new(Body::from_stream(tokio_util::io::ReaderStream::new(f)));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ctype).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size as u64));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; img-src 'self'; media-src 'self'; sandbox"));
    if let Ok(v) = HeaderValue::from_str(&disp) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

/// Claim pending uploads for a message. Only the uploader's own, unclaimed
/// files count; unknown ids are an error (so the sender learns about it).
pub async fn claim(st: &State, uid: Id, ids: &[String]) -> Result<Vec<Attachment>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    if ids.iter().any(|i| !valid_id(i)) {
        return Err("bad attachment id".into());
    }
    // Reserve atomically (message_id 0) so two sends can't claim one file.
    let rows: Vec<(String, String, String, i64, i32, i32)> = sqlx::query_as(
        "UPDATE files SET message_id = 0 WHERE id = ANY($1) AND uploader = $2 AND message_id IS NULL \
         RETURNING id, name, mime, size, width, height",
    )
    .bind(ids)
    .bind(uid)
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.len() != ids.len() {
        let got: Vec<&String> = rows.iter().map(|r| &r.0).collect();
        release(st, got.into_iter().cloned().collect()).await;
        return Err("an attachment is missing or was already sent; upload it again".into());
    }
    // Keep the sender's order.
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let r = rows.iter().find(|r| &r.0 == id).ok_or("an attachment is missing or was already sent; upload it again")?;
        out.push(Attachment { id: r.0.clone(), name: r.1.clone(), mime: r.2.clone(), size: r.3 as u64, width: r.4 as u32, height: r.5 as u32, url: String::new(), preview: String::new() });
    }
    Ok(out)
}

/// Undo a claim (the send failed before the message existed).
pub async fn release(st: &State, ids: Vec<String>) {
    if !ids.is_empty() {
        let _ = sqlx::query("UPDATE files SET message_id = NULL WHERE id = ANY($1) AND message_id = 0").bind(&ids).execute(&st.db).await;
    }
}

async fn remove(st: &State, ids: Vec<String>) {
    for id in ids {
        let _ = tokio::fs::remove_file(st.cfg.files_dir.join(&id)).await;
    }
}

pub fn purge_message(st: Arc<State>, channel_id: Id, message_id: Id) {
    tokio::spawn(async move {
        let ids: Vec<(String,)> = sqlx::query_as("DELETE FROM files WHERE channel_id = $1 AND message_id = $2 RETURNING id")
            .bind(channel_id).bind(message_id).fetch_all(&st.db).await.unwrap_or_default();
        remove(&st, ids.into_iter().map(|r| r.0).collect()).await;
    });
}

pub fn purge_channels(st: Arc<State>, channels: Vec<Id>) {
    tokio::spawn(async move {
        let ids: Vec<(String,)> = sqlx::query_as("DELETE FROM files WHERE channel_id = ANY($1) RETURNING id")
            .bind(&channels).fetch_all(&st.db).await.unwrap_or_default();
        remove(&st, ids.into_iter().map(|r| r.0).collect()).await;
    });
}

/// Hourly: delete uploads nobody sent within a day, and stray partial files.
pub async fn sweep(st: Arc<State>) {
    let mut iv = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        iv.tick().await;
        let ids: Vec<(String,)> = sqlx::query_as(
            "DELETE FROM files
             WHERE (message_id IS NULL AND created_at < now() - interval '1 day')
                OR (message_id = 0 AND created_at < now() - interval '1 hour')
             RETURNING id",
        )
            .fetch_all(&st.db).await.unwrap_or_default();
        if !ids.is_empty() {
            tracing::info!(count = ids.len(), "swept unsent uploads");
        }
        remove(&st, ids.into_iter().map(|r| r.0).collect()).await;
        if let Ok(mut rd) = tokio::fs::read_dir(&st.cfg.files_dir).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                let old = e.metadata().await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map_or(false, |d| d.as_secs() > 3600);
                if old && e.file_name().to_string_lossy().ends_with(".part") {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffing_and_names() {
        assert_eq!(sniff(b"GIF89a...."), "image/gif");
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]), "image/png");
        assert_eq!(sniff(b"\0\0\0\x18ftypmp42\0\0\0\0"), "video/mp4");
        assert_eq!(sniff(b"<html><script>"), "application/octet-stream");
        assert_eq!(clean_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(clean_name("  "), "file");
        assert_eq!(clean_name("a\"b\\c.txt"), "abc.txt");
        assert!(valid_id(&new_id()));
        assert!(!valid_id("../x"));
    }
}
