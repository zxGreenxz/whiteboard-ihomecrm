CREATE TABLE IF NOT EXISTS runtime_command_journal (
  runtime_command_id TEXT PRIMARY KEY,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('QR_LOGIN','DISCONNECT')),
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
  claim_token TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  source_session_generation INTEGER NOT NULL CHECK (source_session_generation >= 1),
  target_session_generation INTEGER NOT NULL CHECK (target_session_generation >= 1),
  source_connection_generation INTEGER NOT NULL CHECK (source_connection_generation >= 0),
  target_connection_generation INTEGER NOT NULL CHECK (target_connection_generation >= 0),
  expected_fencing_token INTEGER NOT NULL CHECK (expected_fencing_token >= 1),
  lease_expires_at TEXT NOT NULL,
  effect_deadline_at TEXT,
  payload_json TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'CLAIMED','START_AUTHORIZED','EFFECT_INTENT','PROVIDER_RECORDED',
    'QR_MATERIAL_READY','PUBLISH_PENDING','LOGIN_WAITING','RESULT_PENDING',
    'SERVER_ACCEPTED','AMBIGUOUS','STALE_LOGIN_CLEANUP_PENDING','SEALED'
  )),
  publish_json TEXT,
  result_json TEXT,
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  sealed_reason TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS runtime_command_journal_stage_idx
  ON runtime_command_journal(stage, updated_at_ms, runtime_command_id);

CREATE TABLE IF NOT EXISTS runtime_local_state (
  name TEXT PRIMARY KEY,
  integer_value INTEGER NOT NULL CHECK (integer_value >= 1),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);
