-- T2 — Forward migration seed 4 permission key cho approval contract v2 (T3).
-- Theo AUTHORIZATION-PLAN §16.4 (T2 sở hữu permission registry) — KHÔNG sửa
-- migration 20260713110100 đã APPLIED. T3 chỉ consume các key này.
-- Additive thuần: chưa role/binding nào tham chiếu ⇒ không đổi hành vi runtime.
BEGIN;

INSERT INTO public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active)
VALUES
  ('income_expenses.self_approve_within_limit', 'income_expenses', 'self_approve_within_limit',
   'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING','CASHBOOK']::text[], true),
  ('income_expenses.reverse', 'income_expenses', 'reverse',
   'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING','CASHBOOK']::text[], true),
  ('cashbooks.post', 'cashbooks', 'post',
   'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','CASHBOOK']::text[], true),
  ('approvals.emergency_override', 'approvals', 'emergency_override',
   'ELEVATED', 'TENANT', ARRAY['ORGANIZATION']::text[], true)
ON CONFLICT (key) DO NOTHING;

COMMIT;
