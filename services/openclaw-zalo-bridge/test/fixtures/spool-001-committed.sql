-- Durable inbound spool. Every inbound provider event becomes a row here, with
-- WAL + FULL durability, before the vendored fork is told the internal listener
-- succeeded. Nothing is deleted until Supabase acknowledges the canonical
-- commit.

CREATE TABLE IF NOT EXISTS inbound_events (
  local_sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id  TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  cell_id          TEXT NOT NULL,
  event_kind       TEXT NOT NULL,

  -- Stable identity. At least one of the two provider identifiers is used when
  -- present; the fingerprint exists only when both are NULL.
  provider_event_id    TEXT,
  provider_message_id  TEXT,
  fallback_fingerprint TEXT,
  dedupe_key           TEXT NOT NULL,

  raw_payload       TEXT NOT NULL,
  normalized_payload TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  media_manifest    TEXT NOT NULL DEFAULT '[]',
  media_byte_state  TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (media_byte_state IN ('PENDING','CACHED','SKIPPED','FAILED')),

  ack_state         TEXT NOT NULL DEFAULT 'SPOOLED'
    CHECK (ack_state IN ('SPOOLED','SENDING','ACKNOWLEDGED','QUARANTINED')),
  retry_count       INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,

  received_at_ms    INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL,

  CHECK (
    (provider_event_id IS NOT NULL OR provider_message_id IS NOT NULL
      OR fallback_fingerprint IS NOT NULL)
  ),
  CHECK (
    (fallback_fingerprint IS NULL)
      OR (provider_event_id IS NULL AND provider_message_id IS NULL)
  )
);

-- Dedupe is per tenant and per account: the same textual provider id in two
-- accounts or organizations is two distinct events.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_events_dedupe_uidx
  ON inbound_events (organization_id, account_id, dedupe_key);

CREATE INDEX IF NOT EXISTS inbound_events_drain_idx
  ON inbound_events (ack_state, local_sequence);

CREATE INDEX IF NOT EXISTS inbound_events_age_idx
  ON inbound_events (received_at_ms);

-- Immutable mapping between the two provider identifiers. Once a pair is seen,
-- a later event may not remap either side.
CREATE TABLE IF NOT EXISTS stable_id_mappings (
  organization_id     TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  provider_event_id   TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  event_kind          TEXT NOT NULL,
  payload_sha256      TEXT NOT NULL,
  created_at_ms       INTEGER NOT NULL,
  PRIMARY KEY (organization_id, account_id, provider_event_id, provider_message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS stable_id_event_uidx
  ON stable_id_mappings (organization_id, account_id, provider_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS stable_id_message_uidx
  ON stable_id_mappings (organization_id, account_id, provider_message_id);

CREATE TABLE IF NOT EXISTS spool_telemetry (
  name        TEXT PRIMARY KEY,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
