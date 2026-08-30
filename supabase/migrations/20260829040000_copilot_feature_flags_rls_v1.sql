-- Close the direct-table exposure discovered after the rollout migrations.
-- No browser role receives a table policy; availability remains RPC-only.
BEGIN;
SET LOCAL lock_timeout = '15s';

ALTER TABLE public.copilot_feature_flags
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.copilot_feature_flag_audit
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.copilot_feature_flags FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.copilot_feature_flag_audit FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.copilot_feature_flags IS
  'Server-owned Copilot rollout state; direct browser table access is deny-by-default and availability is exposed only through RPC.';

COMMENT ON TABLE public.copilot_feature_flag_audit IS
  'Append-only server audit for Copilot rollout transitions; direct browser table access is deny-by-default.';

COMMIT;
