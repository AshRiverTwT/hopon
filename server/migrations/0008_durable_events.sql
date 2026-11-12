-- Durable channel events are written in the same transaction as the rows they
-- describe. The sequence provides a stable replay cursor across server nodes.
CREATE TABLE durable_events (
    cursor      BIGSERIAL PRIMARY KEY,
    channel_id  BIGINT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX durable_events_channel_cursor ON durable_events (channel_id, cursor);

-- A high-water mark lets replay detect pruned history without confusing the
-- gaps in the global sequence with missing events for an individual channel.
CREATE TABLE durable_event_state (
    channel_id       BIGINT PRIMARY KEY,
    pruned_through   BIGINT NOT NULL DEFAULT 0
);
