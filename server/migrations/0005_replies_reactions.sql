ALTER TABLE messages ADD COLUMN reply_to BIGINT;
CREATE TABLE reactions (
    channel_id  BIGINT NOT NULL,
    message_id  BIGINT NOT NULL,
    emoji       TEXT NOT NULL,
    user_id     BIGINT NOT NULL,
    PRIMARY KEY (channel_id, message_id, emoji, user_id)
);
