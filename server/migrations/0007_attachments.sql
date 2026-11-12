-- Attachments: JSON array on the message row (NULL = none), plus one row per
-- uploaded file so quotas, deletes and the unsent-upload sweep can find them.
ALTER TABLE messages ADD COLUMN attachments TEXT;
CREATE TABLE files (
    id          TEXT PRIMARY KEY,
    uploader    BIGINT NOT NULL,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        BIGINT NOT NULL,
    width       INT NOT NULL DEFAULT 0,
    height      INT NOT NULL DEFAULT 0,
    channel_id  BIGINT,
    message_id  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_message ON files(channel_id, message_id);
CREATE INDEX files_uploader ON files(uploader);
CREATE INDEX files_pending ON files(created_at) WHERE message_id IS NULL;
