CREATE TABLE IF NOT EXISTS inbound_media_checkpoints (
  local_sequence   INTEGER NOT NULL REFERENCES inbound_events(local_sequence) ON DELETE CASCADE,
  manifest_index   INTEGER NOT NULL CHECK (manifest_index >= 0),
  media_id         TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','TICKET_ISSUED','RECEIPT_STORED','AVAILABLE','SKIPPED','FAILED')),
  ticket_jti       TEXT,
  signed_ticket    TEXT,
  gateway_receipt  TEXT,
  receipt_hash     TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  terminal_reason  TEXT,
  updated_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (local_sequence, manifest_index),
  UNIQUE (media_id),
  CHECK ((ticket_jti IS NULL) = (signed_ticket IS NULL)),
  CHECK ((gateway_receipt IS NULL) = (receipt_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS inbound_media_checkpoints_state_idx
  ON inbound_media_checkpoints (state, local_sequence, manifest_index);
