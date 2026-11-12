-- Persist the client send key so an outbox retry remains idempotent after a
-- server restart or when a retry reaches another server instance.
ALTER TABLE messages ADD COLUMN client_nonce BIGINT;
CREATE UNIQUE INDEX messages_author_nonce
    ON messages (author_id, client_nonce)
    WHERE client_nonce IS NOT NULL AND client_nonce <> 0;
