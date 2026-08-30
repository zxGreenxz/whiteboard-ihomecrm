-- Revoke browser access to the superseded cashbook wrapper.
-- v1 accepts client-provided building IDs; callers must use v2 instead.
BEGIN;
SET LOCAL lock_timeout = '15s';

REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v1(uuid,date,date,uuid[])
  FROM PUBLIC, anon, authenticated;

COMMIT;
