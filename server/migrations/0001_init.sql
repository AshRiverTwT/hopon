CREATE TABLE users (
    id          BIGINT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL UNIQUE,
    pw_hash     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
    token_hash  BYTEA PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE servers (
    id        BIGINT PRIMARY KEY,
    name      TEXT NOT NULL,
    owner_id  BIGINT NOT NULL REFERENCES users(id)
);

CREATE TABLE members (
    server_id  BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE channels (
    id         BIGINT PRIMARY KEY,
    server_id  BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       SMALLINT NOT NULL  -- 0 text, 1 voice
);
CREATE INDEX channels_server ON channels(server_id);

CREATE TABLE invites (
    code        TEXT PRIMARY KEY,
    server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Hot table. No foreign keys: inserts are batched by the persister and the
-- server already validated channel membership in memory. The primary key is
-- the history index: WHERE channel_id = $1 AND id < $2 ORDER BY id DESC.
CREATE TABLE messages (
    channel_id  BIGINT NOT NULL,
    id          BIGINT NOT NULL,
    author_id   BIGINT NOT NULL,
    content     TEXT NOT NULL,
    edited_at   BIGINT,
    PRIMARY KEY (channel_id, id)
);
