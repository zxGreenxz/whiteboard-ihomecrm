BEGIN IMMEDIATE;

ALTER TABLE inbound_events ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbound_events ADD COLUMN provider_conversation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN provider_sender_id TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN provider_target TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN provider_event_type TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN source_timestamp TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN callback_received_at TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN source_raw_payload_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE inbound_events ADD COLUMN raw_payload_sha256 TEXT NOT NULL DEFAULT '';

UPDATE inbound_events
SET provider_conversation_id=COALESCE(provider_message_id,provider_event_id,'legacy-unknown'),
    provider_sender_id=COALESCE(provider_message_id,provider_event_id,'legacy-unknown'),
    provider_target=json_object(
      'kind','PEER',
      'providerId',COALESCE(provider_message_id,provider_event_id,'legacy-unknown')
    ),
    provider_event_type=event_kind,
    source_timestamp=strftime('%Y-%m-%dT%H:%M:%fZ',received_at_ms / 1000.0,'unixepoch'),
    callback_received_at=strftime('%Y-%m-%dT%H:%M:%fZ',received_at_ms / 1000.0,'unixepoch');

DROP INDEX stable_id_event_uidx;
DROP INDEX stable_id_message_uidx;
ALTER TABLE stable_id_mappings RENAME TO stable_id_mappings_legacy;

CREATE TABLE stable_id_mappings (
  mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_event_id TEXT,
  provider_message_id TEXT,
  event_kind TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  raw_payload_sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (provider_event_id IS NOT NULL OR provider_message_id IS NOT NULL)
);

INSERT INTO stable_id_mappings (
  organization_id,account_id,provider_event_id,provider_message_id,event_kind,
  payload_sha256,raw_payload_sha256,created_at_ms
)
SELECT organization_id,account_id,provider_event_id,provider_message_id,event_kind,
       payload_sha256,'',created_at_ms
FROM stable_id_mappings_legacy;

DROP TABLE stable_id_mappings_legacy;

CREATE UNIQUE INDEX stable_id_event_uidx
  ON stable_id_mappings (organization_id,account_id,provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX stable_id_message_uidx
  ON stable_id_mappings (organization_id,account_id,provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;
