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
CREATE UNIQUE INDEX IF NOT EXISTS messages_author_nonce
    ON messages (author_id, client_nonce)
    WHERE client_nonce IS NOT NULL AND client_nonce <> 0;
