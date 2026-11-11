CREATE TABLE channel_reads (
    user_id     BIGINT NOT NULL,
    channel_id  BIGINT NOT NULL,
    last_read   BIGINT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX channel_reads_channel ON channel_reads(channel_id);
