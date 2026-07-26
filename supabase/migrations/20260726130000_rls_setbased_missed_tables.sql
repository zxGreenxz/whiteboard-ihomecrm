-- =====================================================================
-- RLS PERF: set-based SELECT policies cho các bảng BỊ SÓT khỏi đợt
-- 20260702150000 (audit hiệu năng 2026-07-26: H8, H9, M9)
--
-- Số đo EXPLAIN ANALYZE trên prod 2026-07-26, impersonate staff scoped
-- NATHAN (10 tòa) — TRƯỚC khi sửa:
--   - count(*) customers (504 dòng):              2.610 ms
--   - count(*) meter_readings_detailed (744 dòng): 4.086 ms
--   - select * from jobs (182 dòng):               1.059 ms
-- Nguyên nhân y hệt án lệ 20260702150000: can_access_org_entity() /
-- can_access_building(<cột dòng>) / current_visible_owner_ids() gọi TRẦN
-- trong policy — Postgres KHÔNG hoist STABLE fn, chạy lại TỪNG DÒNG
-- (~5 ms/dòng chỉ cho kiểm quyền).
--
-- Fix đúng mẫu đã verify:
--   - fn không phụ thuộc dòng → bọc (SELECT fn()) → InitPlan 1 lần/statement.
--   - fn trả mảng → user_id IN (SELECT unnest(fn())) → Hashed SubPlan build
--     1 lần (đúng pattern org_boundary sẵn có; KHÔNG dùng = ANY((SELECT fn()))
--     vì Postgres hiểu thành ANY-subquery → lỗi uuid = uuid[]).
--   - can_access_building(building_id) → (SELECT has_full_building_scope())
--     OR building_id IN (SELECT accessible_building_ids())  (≡ theo chứng minh
--     trong 20260702150000; nhánh NULL giữ nguyên ngữ nghĩa).
-- CHỈ sửa SELECT policy *_select_rbac. Policy write + RESTRICTIVE
-- (org_boundary, hide_demo — đã bọc sẵn) giữ nguyên.
-- =====================================================================

BEGIN;

-- ── H8: nhóm org-entity (tenant-guard 20260703100000) ──────────────────
-- Cả 2 vế đều per-row trước đây: can_access_org_entity(...) AND
-- user_id = ANY (current_visible_owner_ids()).

ALTER POLICY customers_select_rbac ON public.customers
  USING ((SELECT public.can_access_org_entity('customers', 'view'))
         AND user_id IN (SELECT unnest(public.current_visible_owner_ids())));

ALTER POLICY tenants_select_rbac ON public.tenants
  USING ((SELECT public.can_access_org_entity('customers', 'view'))
         AND user_id IN (SELECT unnest(public.current_visible_owner_ids())));

ALTER POLICY ct01_declarations_select_rbac ON public.ct01_declarations
  USING ((SELECT public.can_access_org_entity('customers', 'view'))
         AND user_id IN (SELECT unnest(public.current_visible_owner_ids())));

ALTER POLICY suppliers_select_rbac ON public.suppliers
  USING ((SELECT public.can_access_org_entity('suppliers', 'view'))
         AND user_id IN (SELECT unnest(public.current_visible_owner_ids())));

ALTER POLICY hotlines_select_rbac ON public.hotlines
  USING ((SELECT public.can_access_org_entity('hotline', 'view'))
         AND user_id IN (SELECT unnest(public.current_visible_owner_ids())));

-- vehicles: nhánh theo tòa set-based + nhánh org-entity bọc initplan.
ALTER POLICY vehicles_select_rbac ON public.vehicles
  USING ((SELECT public.is_super_admin())
         OR (SELECT public.is_admin())
         OR (building_id IS NOT NULL AND (
               (SELECT public.has_full_building_scope())
               OR building_id IN (SELECT public.accessible_building_ids())
            ))
         OR (building_id IS NULL
             AND (SELECT public.can_access_org_entity('vehicles', 'view'))
             AND user_id IN (SELECT unnest(public.current_visible_owner_ids()))));

-- ── H9: meters + meter_readings (sót khỏi đợt set-based 20260702150000) ─

ALTER POLICY meters_select_rbac ON public.meters
  USING ((SELECT public.has_full_building_scope())
         OR building_id IN (SELECT public.accessible_building_ids()));

ALTER POLICY meter_readings_select_rbac ON public.meter_readings
  USING ((SELECT public.is_super_admin())
         OR (SELECT public.is_admin())
         OR (building_id IS NOT NULL AND (
               (SELECT public.has_full_building_scope())
               OR building_id IN (SELECT public.accessible_building_ids())
            )));

-- ── M9: jobs (WALRUS chạy policy này MỖI event × MỖI subscriber) ────────

ALTER POLICY jobs_select_rbac ON public.jobs
  USING ((SELECT public.is_super_admin())
         OR (SELECT public.is_admin())
         OR (building_id IS NOT NULL AND (
               (SELECT public.has_full_building_scope())
               OR building_id IN (SELECT public.accessible_building_ids())
            ))
         OR (building_id IS NULL
             AND (SELECT public.can_access_org_entity('tasks', 'view'))));

-- ── H9 (phần 2): bỏ ORDER BY trong view meter_readings_detailed ─────────
-- ORDER BY nội view buộc sort TOÀN BỘ trước khi outer query phân trang.
-- Consumer duy nhất (useMeterReadingsList) tự .order() ngoài client —
-- đã bổ sung tiebreaker created_at desc cùng đợt này.
-- GOTCHA án lệ: CREATE OR REPLACE VIEW làm RỚT security_invoker nếu không
-- khai lại — WITH (security_invoker = true) bắt buộc.
CREATE OR REPLACE VIEW public.meter_readings_detailed
WITH (security_invoker = true)
AS
SELECT mr.id,
    mr.user_id,
    mr.reading_code,
    mr.meter_id,
    m.code AS meter_code,
    m.name AS meter_name,
    mr.contract_id,
    mr.service_id,
    s.name AS service_name,
    mr.building_id,
    b.name AS building_name,
    mr.room_id,
    r.name AS room_name,
    mr.meter_type,
    mr.settlement_month,
    mr.reading_date,
    mr.previous_reading,
    mr.current_reading,
    mr.consumption,
    mr.status,
    mr.approved_by,
    approver.email::character varying(255) AS approver_email,
    mr.approved_at,
    mr.recorded_by,
    recorder.email::character varying(255) AS recorder_email,
    mr.notes,
    mr.meter_image_url,
    mr.created_at,
    mr.updated_at
   FROM public.meter_readings mr
     LEFT JOIN public.meters m ON m.id = mr.meter_id
     LEFT JOIN public.buildings b ON b.id = mr.building_id
     LEFT JOIN public.rooms r ON r.id = mr.room_id
     LEFT JOIN public.services s ON s.id = mr.service_id
     LEFT JOIN public.profiles approver ON approver.id = mr.approved_by
     LEFT JOIN public.profiles recorder ON recorder.id = mr.recorded_by
  WHERE mr.deleted_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- ROLLBACK (nguyên văn qual cũ — chạy tay nếu cần):
-- ALTER POLICY customers_select_rbac ON public.customers
--   USING (can_access_org_entity('customers','view')
--          AND user_id = ANY (current_visible_owner_ids()));
-- (tenants/ct01_declarations: 'customers'; suppliers: 'suppliers';
--  hotlines: 'hotline' — cùng dạng.)
-- ALTER POLICY vehicles_select_rbac ON public.vehicles
--   USING (is_super_admin() OR is_admin()
--          OR (building_id IS NOT NULL AND can_access_building(building_id))
--          OR (building_id IS NULL AND can_access_org_entity('vehicles','view')
--              AND user_id = ANY (current_visible_owner_ids())));
-- ALTER POLICY meters_select_rbac ON public.meters
--   USING (can_access_building(building_id));
-- ALTER POLICY meter_readings_select_rbac ON public.meter_readings
--   USING (is_super_admin() OR is_admin()
--          OR (building_id IS NOT NULL AND can_access_building(building_id)));
-- ALTER POLICY jobs_select_rbac ON public.jobs
--   USING (is_super_admin() OR is_admin()
--          OR (building_id IS NOT NULL AND can_access_building(building_id))
--          OR (building_id IS NULL AND can_access_org_entity('tasks','view')));
-- View: thêm lại ORDER BY mr.reading_date DESC, mr.created_at DESC.
-- =====================================================================
