-- T6a phase 2 — Backfill organization_id đang NULL bằng suy diễn authoritative từ
-- parent FK / membership đúng-1-org. KHÔNG blind-default PROD (org demo có dữ liệu
-- thật: 2 buildings/2 income_expenses/6 members). Row không suy được → vào exception
-- queue, giữ NULL (fail-closed), không đoán.
-- Additive: chỉ set organization_id cho row đang NULL; không đụng row đã có org,
-- không đụng cột tiền/nghiệp vụ khác. Idempotent (WHERE organization_id IS NULL).
-- Thứ tự parent-first: parent (sessions, usages, handovers) trước child (photos,
-- items) để child resolve được ở cùng transaction.
BEGIN;

-- ===== Tầng 1: bảng suy trực tiếp từ parent nghiệp vụ đã có org =====

UPDATE public.income_expense_audit_log x
SET organization_id = ie.organization_id
FROM public.income_expenses ie
WHERE x.organization_id IS NULL AND ie.id = x.income_expense_id
  AND ie.organization_id IS NOT NULL;

UPDATE public.invoice_audit_log x
SET organization_id = inv.organization_id
FROM public.invoices inv
WHERE x.organization_id IS NULL AND inv.id = x.invoice_id
  AND inv.organization_id IS NOT NULL;

UPDATE public.inspection_sessions x
SET organization_id = b.organization_id
FROM public.buildings b
WHERE x.organization_id IS NULL AND b.id = x.building_id
  AND b.organization_id IS NOT NULL;

UPDATE public.room_pass_listings x
SET organization_id = b.organization_id
FROM public.buildings b
WHERE x.organization_id IS NULL AND b.id = x.building_id
  AND b.organization_id IS NOT NULL;

UPDATE public.team_members x
SET organization_id = t.organization_id
FROM public.teams t
WHERE x.organization_id IS NULL AND t.id = x.team_id
  AND t.organization_id IS NOT NULL;

UPDATE public.cash_handovers x
SET organization_id = a.organization_id
FROM public.accounts a
WHERE x.organization_id IS NULL AND a.id = x.from_account_id
  AND a.organization_id IS NOT NULL;

-- public_room_events: room trước, fallback building (correlated, deterministic)
UPDATE public.public_room_events x
SET organization_id = COALESCE(
      (SELECT r.organization_id FROM public.rooms r WHERE r.id = x.room_id),
      (SELECT b.organization_id FROM public.buildings b WHERE b.id = x.building_id))
WHERE x.organization_id IS NULL
  AND COALESCE(
      (SELECT r.organization_id FROM public.rooms r WHERE r.id = x.room_id),
      (SELECT b.organization_id FROM public.buildings b WHERE b.id = x.building_id)) IS NOT NULL;

-- ===== Tầng 2: bảng suy từ user_id qua membership ĐÚNG-1-org =====

WITH mem AS (
  SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS only_org,
         count(DISTINCT organization_id) AS n
  FROM public.organization_memberships WHERE status = 'ACTIVE' GROUP BY user_id
)
UPDATE public.material_usages x
SET organization_id = m.only_org
FROM mem m
WHERE x.organization_id IS NULL AND m.user_id = x.user_id AND m.n = 1;

WITH mem AS (
  SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS only_org,
         count(DISTINCT organization_id) AS n
  FROM public.organization_memberships WHERE status = 'ACTIVE' GROUP BY user_id
)
UPDATE public.income_expense_types x
SET organization_id = m.only_org
FROM mem m
WHERE x.organization_id IS NULL AND m.user_id = x.user_id AND m.n = 1;

WITH mem AS (
  SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS only_org,
         count(DISTINCT organization_id) AS n
  FROM public.organization_memberships WHERE status = 'ACTIVE' GROUP BY user_id
)
UPDATE public.salary_attendance_day x
SET organization_id = m.only_org
FROM mem m
WHERE x.organization_id IS NULL AND m.user_id = x.user_id AND m.n = 1;

-- notifications: invoice trước, fallback contract (correlated, deterministic)
UPDATE public.notifications x
SET organization_id = COALESCE(
      (SELECT inv.organization_id FROM public.invoices inv WHERE inv.id = x.invoice_id),
      (SELECT c.organization_id FROM public.contracts c WHERE c.id = x.contract_id))
WHERE x.organization_id IS NULL
  AND COALESCE(
      (SELECT inv.organization_id FROM public.invoices inv WHERE inv.id = x.invoice_id),
      (SELECT c.organization_id FROM public.contracts c WHERE c.id = x.contract_id)) IS NOT NULL;

-- ===== Tầng 3: child suy từ parent VỪA backfill ở tầng 1/2 (cùng transaction) =====

UPDATE public.cash_handover_items x
SET organization_id = h.organization_id
FROM public.cash_handovers h
WHERE x.organization_id IS NULL AND h.id = x.handover_id
  AND h.organization_id IS NOT NULL;

UPDATE public.inspection_photos x
SET organization_id = s.organization_id
FROM public.inspection_sessions s
WHERE x.organization_id IS NULL AND s.id = x.session_id
  AND s.organization_id IS NOT NULL;

UPDATE public.material_usage_items x
SET organization_id = mu.organization_id
FROM public.material_usages mu
WHERE x.organization_id IS NULL AND mu.id = x.usage_id
  AND mu.organization_id IS NOT NULL;

-- ===== Ghi exception cho MỌI row còn NULL (fail-closed, không đoán) =====
-- Một dòng exception tổng hợp per-table với số lượng còn lại, để owner classify.
DO $$
DECLARE
  r record;
  remain bigint;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.column_name='organization_id'
      AND c.table_name IN ('cash_handover_items','cash_handovers','cron_runs',
        'income_expense_audit_log','income_expense_types','inspection_photos',
        'inspection_sessions','invoice_audit_log','material_usage_items',
        'material_usages','notifications','public_room_events','room_pass_listings',
        'salary_attendance_day','team_members')
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', r.table_name)
      INTO remain;
    IF remain > 0 THEN
      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)
      VALUES (r.table_name, 'org NULL sau T6a phase-2 backfill (không suy được từ parent/membership)',
              jsonb_build_object('remaining_null', remain, 'source', 'T6a-phase2', 'at', now()))
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;
