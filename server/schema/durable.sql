-- This schema is additive. Keep it out of _sqlx_migrations so a server that
-- ships migrations 1–7 can use the same database after a rollback.
SELECT pg_advisory_xact_lock(72489207683601);

CREATE TABLE IF NOT EXISTS durable_events (
    cursor      BIGSERIAL PRIMARY KEY,
    channel_id  BIGINT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS durable_events_channel_cursor ON durable_events (channel_id, cursor);

CREATE TABLE IF NOT EXISTS durable_event_state (
    channel_id       BIGINT PRIMARY KEY,
    pruned_through   BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_nonce BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS messages_author_nonce
    ON messages (author_id, client_nonce)
    WHERE client_nonce IS NOT NULL AND client_nonce <> 0;

-- 0.6: friends and direct messages. A DM is a hidden two-member server with
-- one text channel; dm_pair ("<smaller id>:<larger id>") marks it and keeps
-- one DM per pair. Additive like the rest of this file, so an older server
-- can still start on this database.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS dm_pair TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS servers_dm_pair ON servers (dm_pair) WHERE dm_pair IS NOT NULL;

CREATE TABLE IF NOT EXISTS friendships (
    user_a        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by  BIGINT NOT NULL,
    accepted      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (user_b);
