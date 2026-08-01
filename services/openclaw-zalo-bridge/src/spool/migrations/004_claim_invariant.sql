CREATE TRIGGER IF NOT EXISTS inbound_events_claim_state_insert_guard
BEFORE INSERT ON inbound_events
WHEN (NEW.ack_state = 'SENDING') != (
  NEW.claim_owner_token IS NOT NULL AND NEW.claim_expires_at_ms IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'inbound claim state invalid');
END;

CREATE TRIGGER IF NOT EXISTS inbound_events_claim_state_update_guard
BEFORE UPDATE OF ack_state, claim_owner_token, claim_expires_at_ms ON inbound_events
WHEN (NEW.ack_state = 'SENDING') != (
  NEW.claim_owner_token IS NOT NULL AND NEW.claim_expires_at_ms IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'inbound claim state invalid');
END;
