//! Argon2id password hashing (off the async runtime), short-lived HS256 access
//! tokens, and rotating opaque refresh tokens stored as SHA-256 hashes.

use anyhow::Result;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::Engine;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ACCESS_TTL_S: i64 = 15 * 60;
pub const REFRESH_TTL_S: i64 = 30 * 24 * 3600;

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: i64,
    name: String,
    iat: i64,
    exp: i64,
}

pub struct Keys {
    enc: EncodingKey,
    dec: DecodingKey,
    validation: Validation,
}

impl Keys {
    pub fn new(secret: &[u8]) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 5;
        Self { enc: EncodingKey::from_secret(secret), dec: DecodingKey::from_secret(secret), validation }
    }

    pub fn access_token(&self, user_id: i64, name: &str) -> String {
        let now = hopon_shared::time::now_us() / 1_000_000;
        let c = Claims { sub: user_id, name: name.to_owned(), iat: now, exp: now + ACCESS_TTL_S };
        encode(&Header::new(Algorithm::HS256), &c, &self.enc).expect("jwt encode")
    }

    /// Returns `(user_id, name)` for a valid, unexpired token.
    pub fn verify(&self, token: &str) -> Option<(i64, String)> {
        decode::<Claims>(token, &self.dec, &self.validation).ok().map(|d| (d.claims.sub, d.claims.name))
    }
}

pub async fn hash_password(pw: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(pw.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("hash: {e}"))
    })
    .await?
}

pub async fn verify_password(pw: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// New opaque refresh token and the hash to store.
pub fn new_refresh() -> (String, Vec<u8>) {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    let tok = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let h = hash_refresh(&tok);
    (tok, h)
}

pub fn hash_refresh(tok: &str) -> Vec<u8> {
    Sha256::digest(tok.as_bytes()).to_vec()
}

pub fn valid_username(u: &str) -> bool {
    (2..=32).contains(&u.chars().count())
        && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub fn valid_password(p: &str) -> bool {
    (8..=256).contains(&p.len())
}

/// Random base62 code for invite links.
pub fn invite_code() -> String {
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut r = rand::thread_rng();
    (0..10).map(|_| A[(r.next_u32() as usize) % A.len()] as char).collect()
}
