BEGIN IMMEDIATE;

ALTER TABLE stable_id_mappings ADD COLUMN mapping_state TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (mapping_state IN ('PENDING','CANONICAL_COMMITTED','QUARANTINED'));

UPDATE inbound_events
SET dedupe_key='quarantine:drained:' || local_sequence || ':' || dedupe_key
WHERE ack_state='QUARANTINED' AND dedupe_key NOT LIKE 'quarantine:%';

UPDATE stable_id_mappings
SET mapping_state=CASE
  WHEN EXISTS (
    SELECT 1 FROM inbound_events event
    WHERE event.organization_id=stable_id_mappings.organization_id
      AND event.account_id=stable_id_mappings.account_id
      AND event.ack_state IN ('SPOOLED','SENDING')
      AND (
        (stable_id_mappings.provider_event_id IS NOT NULL
          AND event.provider_event_id=stable_id_mappings.provider_event_id)
        OR (stable_id_mappings.provider_message_id IS NOT NULL
          AND event.provider_message_id=stable_id_mappings.provider_message_id)
      )
  ) THEN 'PENDING'
  WHEN EXISTS (
    SELECT 1 FROM inbound_events event
    WHERE event.organization_id=stable_id_mappings.organization_id
      AND event.account_id=stable_id_mappings.account_id
      AND event.ack_state='QUARANTINED'
      AND (
        (stable_id_mappings.provider_event_id IS NOT NULL
          AND event.provider_event_id=stable_id_mappings.provider_event_id)
        OR (stable_id_mappings.provider_message_id IS NOT NULL
          AND event.provider_message_id=stable_id_mappings.provider_message_id)
      )
  ) THEN 'QUARANTINED'
  ELSE 'CANONICAL_COMMITTED'
END;

COMMIT;
