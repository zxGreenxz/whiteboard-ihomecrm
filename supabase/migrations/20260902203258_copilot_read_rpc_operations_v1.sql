-- Copilot read surface, part 4: the operational side of the business — leads,
-- metered consumption per settlement period, vehicles, jobs (the "tasks" module)
-- and material stock — plus a row ceiling for the nine older read RPCs.
--
-- WHY THESE FIVE, AND WHY AS RPC
--   Same reason as part 3 (20260902193151): every one of these tables carries its
--   tenant boundary either a join away or not at all, so a PostgREST embed from
--   the browser has to guess the relation. `leads`, `vehicles` and `jobs` carry a
--   NULLABLE `building_id`; `materials` carries no building at all and is scoped
--   purely by organization. Each read below resolves its own scope server-side
--   through `public.copilot_org_scope_buildings_v1`, which validates the selected
--   organization, an ACTIVE non-revoked membership and the permission key before
--   returning the building set the query is constrained by.
--
-- THE NULL-BUILDING ROW, AND WHY IT IS NOT SIMPLY DROPPED
--   A lead with no building yet, a vehicle recorded before the room was known, a
--   job filed against the whole company: these rows exist and the application
--   shows them. Their RLS policies (leads_select_rbac, vehicles_select_rbac,
--   jobs_select_rbac) all read the same way — a row WITH a building needs that
--   building in the caller scope, a row WITHOUT one needs organization-level
--   access to the module. This migration mirrors that exactly: `org_wide` comes
--   from `app_private.authorized_scope_v3`, and a NULL-building row is returned
--   only to a caller whose permission is organization-wide. Dropping such rows
--   silently would have been the easy choice and the wrong one — it turns "you
--   have no leads waiting" into an answer that is false rather than restricted.
--
-- READ-ONLY BY CONSTRUCTION
--   Every function here is STABLE. None writes, approves, posts or cancels
--   anything. Check STATE is reported (a meter reading has been checked or has
--   not) but no decision path is exposed: that stays on the human screens.
--
-- LIMITS
--   The five new RPCs clamp `p_limit` to 1..50 inside the function and echo the
--   clamped value, so a Copilot answer says "showing N" instead of implying
--   completeness. Where a total would be wrong if computed from a truncated list
--   (consumption per meter type, material stock value) the total is aggregated
--   over the WHOLE match set, next to the capped list.
--
-- THE NINE OLDER READ RPCs — SIGNATURES UNCHANGED
--   `copilot_available_rooms_v1`, `copilot_invoice_search_v1`,
--   `copilot_financial_pnl_v1`, `copilot_occupancy_v1`,
--   `copilot_occupancy_upcoming_v1`, `copilot_invoice_stats_v1`,
--   `copilot_deposit_summary_v1` (from 20260828160000) and
--   `copilot_customer_search_v1`, `copilot_expiring_contracts_v1` (from
--   20260829020000) are re-issued below with the SAME argument list, the SAME
--   return type and the same result for every dataset smaller than the ceiling.
--   CREATE OR REPLACE is therefore valid and no caller changes.
--
--   The ceiling is 2000 rows, NOT the 50 used by the new RPCs, and the difference
--   is deliberate. The callers of these nine COUNT and SUM the rows they receive:
--   `tim_hoa_don` prints `data.length` as "Tim thay N hoa don", `ty_le_lap_day`
--   adds up per-building occupancy, `phong_trong` adds up `totalFree`,
--   `doanh_thu_thang` adds up revenue and expense. A 50-row cap there would not
--   shorten an answer — it would turn a complete number into a wrong number with
--   nothing in the payload to say so, which is a worse failure than the unbounded
--   read it was meant to fix. 2000 sits above every measured production maximum
--   (the largest organization today: 1.143 invoices, 335 contracts, 523
--   customers, 18 buildings), so it acts as a runaway guard, not a display limit.
--   Shortening a list honestly is what `p_limit` is for, and it is echoed.
--   `copilot_invoice_stats_v1` returns one aggregate row by construction and is
--   pinned at LIMIT 1; `copilot_customer_search_v1` keeps the LIMIT 10 it already
--   had, because its caller is written against exactly that cap.
--
-- ACCEPTANCE IS CATALOG-ONLY
--   The closing block reads `pg_proc`/ACL only, so this migration also runs on an
--   empty database (Restore Drill replays it onto a schema-only baseline). No
--   fixture row is created and no data is touched.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- The accent-folding helper is NOT redefined here. It was chosen once, from the
-- catalog, by 20260902193151; redefining it would mean two places deciding the
-- same thing and eventually disagreeing.

-- 1. Leads (khach hen) -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_lead_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_trang_thai text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_trang_thai text := NULLIF(btrim(upper(coalesce(p_trang_thai, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_trang_thai IS NOT NULL
     AND v_trang_thai NOT IN ('B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTATION', 'CONVERTED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid_lead_status' USING ERRCODE = '22023';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('leads.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('leads.view', p_organization_id) s;
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'khach_hen_id', s.id,
             'khach_hang', s.customer_name,
             'dien_thoai', s.phone,
             'trang_thai', s.lead_state,
             'nguon', s.lead_source,
             'toa_nha', s.building_name,
             'phong', s.room_name,
             'ngay_hen', s.appointment_date,
             'lien_he_cuoi', s.last_contact_date,
             'hen_lien_he_toi', s.next_follow_up_date,
             'ngan_sach_tu', s.budget_min,
             'ngan_sach_den', s.budget_max,
             'ngay_tao', s.created_at
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        l.id,
        l.customer_name,
        l.phone,
        l.status::text AS lead_state,
        l.source::text AS lead_source,
        b.name AS building_name,
        rm.name AS room_name,
        l.appointment_date,
        l.last_contact_date,
        l.next_follow_up_date,
        l.budget_min,
        l.budget_max,
        l.created_at,
        row_number() OVER (
          ORDER BY COALESCE(l.next_follow_up_date, l.appointment_date) NULLS LAST,
                   l.created_at DESC,
                   l.id
        ) AS rn
      FROM public.leads l
      LEFT JOIN public.buildings b
        ON b.id = l.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = l.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      WHERE l.organization_id = p_organization_id
        AND l.deleted_at IS NULL
        AND (b.id IS NOT NULL OR (l.building_id IS NULL AND v_org_wide))
        AND (v_trang_thai IS NULL OR l.status::text = v_trang_thai)
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(l.customer_name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(l.phone, '')) LIKE v_needle
        )
      ORDER BY COALESCE(l.next_follow_up_date, l.appointment_date) NULLS LAST,
               l.created_at DESC,
               l.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'khach_hen', v_rows
  );
END
$fn$;

-- 2. Meter readings of one settlement period ---------------------------------
CREATE OR REPLACE FUNCTION public.copilot_meter_readings_v1(
  p_organization_id uuid,
  p_ky text,
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_ky text := NULLIF(btrim(coalesce(p_ky, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
  v_tong_hop jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_ky IS NULL OR v_ky !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_settlement_month' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('meter_readings.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('meter_readings.view', p_organization_id) s;

  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    -- Asking about a building outside the caller scope answers like an empty
    -- period, not like a permission error: saying "that building exists but is
    -- not yours" is itself a cross-tenant disclosure.
    RETURN jsonb_build_object(
      'ky', v_ky, 'gioi_han', v_limit, 'so_luong', 0,
      'tong_hop', '[]'::jsonb, 'chi_so', '[]'::jsonb
    );
  END IF;

  -- Totals are computed over the WHOLE period, not over the capped list, so the
  -- consumption figure stays right no matter how short the list is.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'loai', g.meter_kind,
             'so_dong', g.row_count,
             'tong_tieu_thu', g.total_consumption
           ) ORDER BY g.meter_kind
         ), '[]'::jsonb)
    INTO v_tong_hop
    FROM (
      SELECT
        mr.meter_type::text AS meter_kind,
        count(*) AS row_count,
        COALESCE(sum(mr.consumption), 0) AS total_consumption
      FROM public.meter_readings mr
      LEFT JOIN public.buildings b
        ON b.id = mr.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      WHERE mr.organization_id = p_organization_id
        AND mr.deleted_at IS NULL
        AND mr.settlement_month = v_ky
        AND (b.id IS NOT NULL OR (mr.building_id IS NULL AND v_org_wide))
        AND (p_building_id IS NULL OR mr.building_id = p_building_id)
      GROUP BY mr.meter_type::text
    ) g;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'chi_so_id', s.id,
             'ma_phieu', s.reading_code,
             'toa_nha', s.building_name,
             'phong', s.room_name,
             'loai', s.meter_kind,
             'chi_so_dau', s.previous_reading,
             'chi_so_cuoi', s.current_reading,
             'tieu_thu', s.consumption,
             'ngay_ghi', s.reading_date,
             'trang_thai', s.check_state
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        mr.id,
        mr.reading_code,
        b.name AS building_name,
        rm.name AS room_name,
        mr.meter_type::text AS meter_kind,
        mr.previous_reading,
        mr.current_reading,
        mr.consumption,
        mr.reading_date,
        mr.status AS check_state,
        row_number() OVER (
          ORDER BY b.name NULLS LAST, rm.name NULLS LAST, mr.meter_type::text, mr.id
        ) AS rn
      FROM public.meter_readings mr
      LEFT JOIN public.buildings b
        ON b.id = mr.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = mr.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      WHERE mr.organization_id = p_organization_id
        AND mr.deleted_at IS NULL
        AND mr.settlement_month = v_ky
        AND (b.id IS NOT NULL OR (mr.building_id IS NULL AND v_org_wide))
        AND (p_building_id IS NULL OR mr.building_id = p_building_id)
      ORDER BY b.name NULLS LAST, rm.name NULLS LAST, mr.meter_type::text, mr.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'ky', v_ky,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', v_tong_hop,
    'chi_so', v_rows
  );
END
$fn$;

-- 3. Vehicles ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_vehicle_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('vehicles.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('vehicles.view', p_organization_id) s;
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'xe_id', s.id,
             'bien_so', s.license_plate,
             'loai_xe', s.vehicle_kind,
             'mo_ta', s.description,
             'chu_xe', s.owner_label,
             'phong', s.room_name,
             'toa_nha', s.building_name,
             'phi_gui', s.parking_fee,
             'ma_the', s.ticket_number
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        v.id,
        v.license_plate,
        v.vehicle_type::text AS vehicle_kind,
        NULLIF(btrim(concat_ws(' ', NULLIF(v.brand, ''), NULLIF(v.model, ''), NULLIF(v.color, ''))), '') AS description,
        COALESCE(NULLIF(btrim(coalesce(v.owner_name, '')), ''), cst.full_name, NULLIF(v.vehicle_name, '')) AS owner_label,
        rm.name AS room_name,
        b.name AS building_name,
        v.parking_fee,
        v.ticket_number,
        row_number() OVER (
          ORDER BY b.name NULLS LAST, rm.name NULLS LAST, v.license_plate NULLS LAST, v.id
        ) AS rn
      FROM public.vehicles v
      LEFT JOIN public.buildings b
        ON b.id = v.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = v.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      LEFT JOIN public.customers cst
        ON cst.id = v.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE v.organization_id = p_organization_id
        AND v.deleted_at IS NULL
        AND (b.id IS NOT NULL OR (v.building_id IS NULL AND v_org_wide))
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(v.license_plate, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(v.owner_name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(v.ticket_number, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(rm.name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(cst.full_name, '')) LIKE v_needle
        )
      ORDER BY b.name NULLS LAST, rm.name NULLS LAST, v.license_plate NULLS LAST, v.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'xe', v_rows
  );
END
$fn$;

-- 4. Jobs — the "tasks" module -----------------------------------------------
--
-- The permission module is `tasks`, the TABLE is `public.jobs`. There is no
-- `public.tasks` table in this schema and there never was; `task_flows` /
-- `task_phases` belong to the issues workflow, which is a different feature.
CREATE OR REPLACE FUNCTION public.copilot_tasks_v1(
  p_organization_id uuid,
  p_trang_thai text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_trang_thai text := NULLIF(btrim(upper(coalesce(p_trang_thai, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_trang_thai IS NOT NULL AND v_trang_thai NOT IN ('IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'invalid_job_status' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('tasks.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('tasks.view', p_organization_id) s;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'cong_viec_id', s.id,
             'ma', s.code,
             'tieu_de', s.title,
             'trang_thai', s.job_state,
             'muc_do', s.priority,
             'loai', s.job_type_name,
             'nguoi_lam', s.assignee_label,
             'cua_toi', s.mine,
             'han', s.deadline,
             'phong', s.room_name,
             'toa_nha', s.building_name
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        j.id,
        j.code,
        j.title,
        j.status AS job_state,
        j.priority,
        jt.name AS job_type_name,
        j.assignee_name AS assignee_label,
        (j.assignee_id = v_actor) AS mine,
        j.deadline,
        rm.name AS room_name,
        b.name AS building_name,
        row_number() OVER (
          ORDER BY (j.assignee_id = v_actor) DESC NULLS LAST,
                   j.deadline NULLS LAST,
                   j.created_at DESC NULLS LAST,
                   j.id
        ) AS rn
      FROM public.jobs j
      LEFT JOIN public.buildings b
        ON b.id = j.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = j.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      LEFT JOIN public.job_types jt
        ON jt.id = j.job_type_id
       AND jt.organization_id = p_organization_id
      WHERE j.organization_id = p_organization_id
        AND (b.id IS NOT NULL OR (j.building_id IS NULL AND v_org_wide))
        AND (v_trang_thai IS NULL OR j.status = v_trang_thai)
      ORDER BY (j.assignee_id = v_actor) DESC NULLS LAST,
               j.deadline NULLS LAST,
               j.created_at DESC NULLS LAST,
               j.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'cong_viec', v_rows
  );
END
$fn$;

-- 5. Material stock ----------------------------------------------------------
--
-- `public.materials` has NO building column: its RLS policy is
-- `can_access_org_entity('materials','view')`, i.e. the boundary is the company
-- and nothing narrower. So there is no building set to constrain against, and the
-- scope helper is called with PERFORM — for its validation and its denial, which
-- are the whole reason it exists — while the rows are constrained by the company
-- column itself. This mirrors `copilot_pending_requests_v1` from part 3.
CREATE OR REPLACE FUNCTION public.copilot_material_stock_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
  v_tong_hop jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  PERFORM public.copilot_org_scope_buildings_v1('materials.view', p_organization_id);
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  -- Aggregated over the WHOLE match set, so "how many are running out" stays a
  -- true number even when the list below is capped at `v_limit`.
  SELECT jsonb_build_object(
           'so_mat_hang', count(*),
           'so_mat_hang_thieu', count(*) FILTER (WHERE m.on_hand < m.reorder_level),
           'gia_tri_ton', COALESCE(sum(m.on_hand * m.avg_unit_cost), 0)
         )
    INTO v_tong_hop
    FROM public.materials m
    WHERE m.organization_id = p_organization_id
      AND m.deleted_at IS NULL
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(COALESCE(m.name, '')) LIKE v_needle
        OR app_private.copilot_fold_text_v1(COALESCE(m.code, '')) LIKE v_needle
      );

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'vat_tu_id', s.id,
             'ma', s.code,
             'ten', s.name,
             'nhom', s.category_name,
             'don_vi', s.unit,
             'ton_kho', s.on_hand,
             'muc_dat_lai', s.reorder_level,
             'duoi_muc', s.below_reorder,
             'gia_binh_quan', s.avg_unit_cost,
             'gia_tri_ton', s.stock_value
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        m.id,
        m.code,
        m.name,
        mc.name AS category_name,
        m.unit,
        m.on_hand,
        m.reorder_level,
        (m.on_hand < m.reorder_level) AS below_reorder,
        m.avg_unit_cost,
        (m.on_hand * m.avg_unit_cost) AS stock_value,
        row_number() OVER (
          ORDER BY (m.on_hand < m.reorder_level) DESC, m.name, m.id
        ) AS rn
      FROM public.materials m
      LEFT JOIN public.material_categories mc
        ON mc.id = m.category_id
       AND mc.organization_id = p_organization_id
      WHERE m.organization_id = p_organization_id
        AND m.deleted_at IS NULL
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(m.name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(m.code, '')) LIKE v_needle
        )
      ORDER BY (m.on_hand < m.reorder_level) DESC, m.name, m.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_mat_hang', 0, 'so_mat_hang_thieu', 0, 'gia_tri_ton', 0)),
    'vat_tu', v_rows
  );
END
$fn$;

-- ============================================================================
-- Row ceiling for the nine older read RPCs. Signatures unchanged; see the
-- header for why the ceiling here is 2000 and not the 50 used above.
-- ============================================================================

-- 6a. copilot_available_rooms_v1 — three unbounded jsonb_agg arrays -----------
CREATE OR REPLACE FUNCTION public.copilot_available_rooms_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_buildings uuid[]; v_today date;
BEGIN
  v_buildings := public.copilot_org_scope_buildings_v1('rooms.view', p_organization_id);
  IF COALESCE(cardinality(v_buildings), 0) = 0 THEN RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL); END IF;
  v_today := public.org_today_v1(p_organization_id);
  RETURN jsonb_build_object(
    'areas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
      FROM (
        SELECT a0.id, a0.name
        FROM public.areas a0
        WHERE a0.organization_id = p_organization_id
          AND a0.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM public.area_buildings ab WHERE ab.area_id = a0.id AND ab.building_id = ANY(v_buildings))
        ORDER BY a0.name
        LIMIT 2000
      ) a
    ), '[]'::jsonb),
    'buildings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab WHERE ab.building_id = b.id AND ab.organization_id = p_organization_id), '[]'::jsonb),
        'district', b.district, 'ward', b.ward,
        'address', CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address ELSE concat_ws(', ', NULLIF(b.street_address, ''), NULLIF(b.ward, ''), NULLIF(b.district, ''), NULLIF(b.province, '')) END,
        'total_floors', b.total_floors, 'floor_layouts', b.floor_layouts, 'images', COALESCE(b.images,'[]'::jsonb),
        'public_contact_name', b.public_contact_name, 'public_contact_phone', b.public_contact_phone, 'public_map_url', b.public_map_url, 'public_lift_type', b.public_lift_type
      ) ORDER BY b.name)
      FROM (
        SELECT b0.*
        FROM public.buildings b0
        WHERE b0.id = ANY(v_buildings)
          AND b0.organization_id = p_organization_id
          AND b0.deleted_at IS NULL
          AND b0.is_virtual = false
          AND EXISTS (
            SELECT 1
            FROM public.rooms br
            LEFT JOIN public.room_pass_listings bpl ON bpl.room_id = br.id AND bpl.user_id = b0.user_id AND (bpl.organization_id = p_organization_id OR bpl.organization_id IS NULL) AND bpl.active = true
            WHERE br.building_id = b0.id AND br.deleted_at IS NULL
              AND (bpl.id IS NOT NULL OR (NOT public.room_has_holding_deposit(br.id) AND br.status = 'AVAILABLE') OR (NOT public.room_has_holding_deposit(br.id) AND EXISTS (
                SELECT 1 FROM public.contracts bc
                WHERE bc.room_id = br.id AND bc.deleted_at IS NULL AND bc.status IN ('ACTIVE','EXTENDED')
                  AND ((bc.expected_move_out_date IS NOT NULL AND bc.expected_move_out_date BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b0.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
                    OR COALESCE(bc.actual_end_date, bc.end_date) BETWEEN v_today AND v_today + COALESCE((SELECT prs.soon_days FROM public.public_room_settings prs WHERE prs.owner_id = b0.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL) LIMIT 1), 30))
              )))
          )
        ORDER BY b0.name
        LIMIT 2000
      ) b
    ), '[]'::jsonb),
    'rooms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', rs.id, 'building_id', rs.building_id, 'floor', rs.floor, 'name', rs.name, 'code', rs.code,
        'area', rs.area, 'rent_price', rs.rent_price, 'deposit_amount', rs.deposit_amount, 'max_occupants', rs.max_occupants,
        'amenities', COALESCE(rs.amenities,'[]'::jsonb), 'images', COALESCE(rs.images,'[]'::jsonb), 'description', rs.description,
        'sale_note', rs.sale_note, 'room_type', rs.room_type,
        'pass_sale_policy', rs.pass_sale_policy, 'pass_price', rs.pass_price, 'pass_avail_date', rs.pass_avail_date, 'pass_contact_manager', rs.pass_contact_manager,
        'status_public', rs.status_public, 'avail_date', rs.avail_date
      ) ORDER BY rs.floor DESC, rs.name)
      FROM (
        SELECT rs0.*
        FROM (
          SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price, r.deposit_amount, r.max_occupants,
                 r.amenities, r.images, r.description, r.sale_note, r.room_type,
                 pl.sale_policy AS pass_sale_policy,
                 pl.pass_price, pl.avail_date AS pass_avail_date, COALESCE(pl.contact_manager, false) AS pass_contact_manager,
                 CASE
                   WHEN pl.id IS NOT NULL THEN 'pass'
                   WHEN public.room_has_holding_deposit(r.id) THEN 'rented'
                   WHEN EXISTS (
                     SELECT 1 FROM public.contracts c
                     WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                       AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                         OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                   ) THEN 'soon'
                   WHEN EXISTS (SELECT 1 FROM public.contracts c WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')) THEN 'rented'
                   WHEN r.status = 'AVAILABLE' THEN 'free'
                   ELSE 'rented'
                 END AS status_public,
                 CASE
                   WHEN pl.id IS NOT NULL THEN pl.avail_date
                   ELSE (
                     SELECT MIN(CASE WHEN c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30) THEN c.expected_move_out_date ELSE COALESCE(c.actual_end_date, c.end_date) END)
                     FROM public.contracts c
                     WHERE c.room_id = r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
                       AND ((c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                         OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + COALESCE(prs.soon_days, 30))
                   )
                 END AS avail_date
          FROM public.rooms r
          JOIN public.buildings b ON b.id = r.building_id
          LEFT JOIN public.public_room_settings prs ON prs.owner_id = b.user_id AND (prs.organization_id = p_organization_id OR prs.organization_id IS NULL)
          LEFT JOIN public.room_pass_listings pl ON pl.room_id = r.id AND pl.user_id = b.user_id AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL) AND pl.active = true
          WHERE r.building_id = ANY(v_buildings)
            AND b.organization_id = p_organization_id AND b.deleted_at IS NULL AND b.is_virtual = false
            AND r.deleted_at IS NULL
        ) rs0
        WHERE rs0.status_public IN ('free','soon','pass')
        ORDER BY rs0.floor DESC, rs0.name
        LIMIT 2000
      ) rs
    ), '[]'::jsonb),
    'contact', NULL
  );
END
$fn$;

-- 6b. copilot_invoice_search_v1 ----------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_invoice_search_v1(p_organization_id uuid, p_billing_month text DEFAULT NULL, p_payment_status text DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'invoice_number',s.invoice_number,'billing_month',s.billing_month,'total_amount',s.total_amount,'status',s.status,'building_id',s.building_id,'building_name',s.building_name,'room_id',s.room_id,'room_name',s.room_name) ORDER BY s.billing_month DESC, s.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT i.id, i.invoice_number, i.billing_month, i.total_amount, i.status, i.building_id, b.name AS building_name, i.room_id, r.name AS room_name, i.created_at
    FROM public.invoices i
    JOIN public.rooms r ON r.id = i.room_id
    JOIN public.buildings b ON b.id = r.building_id
    WHERE i.organization_id = p_organization_id AND i.deleted_at IS NULL
      AND r.building_id = ANY(public.copilot_org_scope_buildings_v1('invoices.view', p_organization_id))
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (p_payment_status IS NULL OR (p_payment_status = 'paid' AND i.status = 'PAID') OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID') OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
      AND (p_search IS NULL OR i.invoice_number ILIKE '%' || p_search || '%'
        OR EXISTS (SELECT 1 FROM public.contract_customers cc JOIN public.customers c ON c.id = cc.customer_id WHERE cc.contract_id = i.contract_id AND c.full_name ILIKE '%' || p_search || '%'))
    ORDER BY i.billing_month DESC, i.created_at DESC
    LIMIT 2000
  ) s;
$$;

-- 6c. copilot_financial_pnl_v1 -----------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_financial_pnl_v1(p_organization_id uuid, p_start_date date, p_end_date date, p_accrual boolean DEFAULT false)
RETURNS TABLE(month date, building_id uuid, building_name text, is_virtual boolean, revenue numeric, expense numeric, net numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF p_accrual THEN RETURN QUERY SELECT * FROM public.fa_monthly_pnl_accrual(p_start_date, p_end_date, public.copilot_org_scope_buildings_v1('reports_finance.analysis', p_organization_id)) LIMIT 2000;
  ELSE RETURN QUERY SELECT * FROM public.fa_monthly_pnl(p_start_date, p_end_date, public.copilot_org_scope_buildings_v1('reports_finance.analysis', p_organization_id)) LIMIT 2000; END IF;
END
$fn$;

-- 6d. copilot_occupancy_v1 ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_occupancy_v1(p_organization_id uuid, p_as_of_date date, p_window_days integer DEFAULT 30)
RETURNS TABLE(building_id uuid, building_name text, total integer, occupied integer, reserved integer, maintenance integer, unavailable integer, available integer, occupancy_pct numeric, committed_pct numeric, missed_revenue numeric, generated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.occupancy_snapshot_v2(p_as_of_date, public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy', p_organization_id)) LIMIT 2000; $$;

-- 6e. copilot_occupancy_upcoming_v1 ------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_occupancy_upcoming_v1(p_organization_id uuid, p_as_of_date date, p_window_days integer DEFAULT 30)
RETURNS TABLE(contract_id uuid, contract_number text, building_id uuid, building_name text, room_id uuid, room_name text, effective_end_date date, days_remaining integer, rent_price numeric, extension_applied boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.occupancy_upcoming_vacancy_v2(p_as_of_date, p_window_days, public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy', p_organization_id)) LIMIT 2000; $$;

-- 6f. copilot_invoice_stats_v1 — one aggregate row by construction ------------
CREATE OR REPLACE FUNCTION public.copilot_invoice_stats_v1(p_organization_id uuid, p_billing_month text DEFAULT NULL)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT public.get_invoice_statistics_v2(NULL, NULL, NULL, NULL, NULL, p_billing_month, NULL, public.copilot_org_scope_buildings_v1('invoices.view', p_organization_id)) LIMIT 1; $$;

-- 6g. copilot_deposit_summary_v1 ---------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_deposit_summary_v1(p_organization_id uuid)
RETURNS TABLE(building_id uuid, building_name text, contract_count bigint, expected numeric, held numeric, shortfall_all numeric, shortfall_short numeric, full_count bigint, short_count bigint, first_invoice_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private
AS $$ SELECT * FROM public.get_held_deposit_summary(public.copilot_org_scope_buildings_v1('deposits.view', p_organization_id)) LIMIT 2000; $$;

-- 6h. copilot_customer_search_v1 — LIMIT 10 kept, body otherwise untouched ----
--
-- Re-issued unchanged so that all nine caps live in ONE reviewable place. Its
-- caller (`tim_khach_hang`) is written against ten rows; widening it here would
-- be a silent behaviour change dressed up as a safety fix.
CREATE OR REPLACE FUNCTION public.copilot_customer_search_v1(
  p_organization_id uuid,
  p_search text
)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  phone text,
  contract_id uuid,
  contract_number text,
  contract_status text,
  room_id uuid,
  room_name text,
  building_id uuid,
  building_name text,
  is_representative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_query text := NULLIF(btrim(p_search), '');
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- This validates the selected org, active membership, permission and denies.
  v_buildings := public.copilot_org_scope_buildings_v1('customers.view', p_organization_id);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      cst.id AS customer_id,
      cst.full_name AS customer_name,
      cst.phone,
      ct.id AS contract_id,
      ct.contract_number,
      ct.status::text AS contract_status,
      rm.id AS room_id,
      rm.name AS room_name,
      b.id AS building_id,
      b.name AS building_name,
      cc.is_representative,
      row_number() OVER (
        PARTITION BY cst.id
        ORDER BY
          CASE WHEN ct.status IN ('ACTIVE', 'EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(ct.actual_end_date, ct.end_date) DESC NULLS LAST,
          ct.updated_at DESC
      ) AS row_rank
    FROM public.customers cst
    JOIN public.contract_customers cc
      ON cc.customer_id = cst.id
     AND cc.organization_id = p_organization_id
    JOIN public.contracts ct
      ON ct.id = cc.contract_id
     AND ct.organization_id = p_organization_id
     AND ct.deleted_at IS NULL
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE cst.organization_id = p_organization_id
      AND cst.deleted_at IS NULL
      AND (
        v_query IS NULL
        OR cst.full_name ILIKE '%' || v_query || '%'
        OR cst.phone ILIKE '%' || v_query || '%'
      )
  )
  SELECT
    c.customer_id,
    c.customer_name,
    c.phone,
    c.contract_id,
    c.contract_number,
    c.contract_status,
    c.room_id,
    c.room_name,
    c.building_id,
    c.building_name,
    c.is_representative
  FROM candidates c
  WHERE c.row_rank = 1
  ORDER BY c.customer_name, c.customer_id
  LIMIT 10;
END
$fn$;

-- 6i. copilot_expiring_contracts_v1 ------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_expiring_contracts_v1(
  p_organization_id uuid,
  p_as_of_date date,
  p_window_days integer
)
RETURNS TABLE(
  contract_id uuid,
  contract_number text,
  customer_name text,
  end_date date,
  effective_end_date date,
  contract_status text,
  room_id uuid,
  room_name text,
  building_id uuid,
  building_name text,
  is_representative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_until date;
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_as_of_date IS NULL OR p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 365 THEN
    RAISE EXCEPTION 'invalid_expiring_window' USING ERRCODE = '22023';
  END IF;

  -- This validates the selected org, active membership, permission and denies.
  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.expiring', p_organization_id);
  v_until := p_as_of_date + p_window_days;

  RETURN QUERY
  SELECT
    ct.id AS contract_id,
    ct.contract_number,
    rep.customer_name,
    ct.end_date,
    COALESCE(ct.actual_end_date, ct.end_date) AS effective_end_date,
    ct.status::text AS contract_status,
    rm.id AS room_id,
    rm.name AS room_name,
    b.id AS building_id,
    b.name AS building_name,
    rep.is_representative
  FROM public.contracts ct
  JOIN public.rooms rm
    ON rm.id = ct.room_id
   AND rm.organization_id = p_organization_id
   AND rm.deleted_at IS NULL
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = p_organization_id
   AND b.deleted_at IS NULL
   AND b.id = ANY(v_buildings)
  LEFT JOIN LATERAL (
    SELECT
      cst.full_name AS customer_name,
      cc.is_representative
    FROM public.contract_customers cc
    JOIN public.customers cst
      ON cst.id = cc.customer_id
     AND cst.organization_id = p_organization_id
     AND cst.deleted_at IS NULL
    WHERE cc.contract_id = ct.id
      AND cc.organization_id = p_organization_id
    ORDER BY cc.is_representative DESC, cc.created_at
    LIMIT 1
  ) rep ON true
  WHERE ct.organization_id = p_organization_id
    AND ct.deleted_at IS NULL
    AND ct.status IN ('ACTIVE', 'EXTENDED')
    AND COALESCE(ct.actual_end_date, ct.end_date) BETWEEN p_as_of_date AND v_until
  ORDER BY COALESCE(ct.actual_end_date, ct.end_date), ct.contract_number NULLS LAST, ct.id
  LIMIT 2000;
END
$fn$;

-- ACL ------------------------------------------------------------------------
--
-- REVOKE FROM PUBLIC does NOT cut `anon` on Supabase: `anon` and `authenticated`
-- hold their own grants, so every role is named explicitly. `to_regrole` guards
-- keep the block runnable on a bare cluster where those roles do not exist.
-- Only the FIVE new functions are re-granted here; the nine older ones keep the
-- grants their own migrations gave them, which CREATE OR REPLACE preserves.
REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) TO authenticated;
  END IF;
END
$acl$;

COMMENT ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) IS
  'Read-only lead lookup for Copilot; server-derived organization/building scope, LIMIT clamped 1..50.';
COMMENT ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) IS
  'Read-only meter readings of one settlement month for Copilot; totals aggregated over the whole period.';
COMMENT ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) IS
  'Read-only vehicle lookup for Copilot by plate, owner, ticket, room or resident.';
COMMENT ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) IS
  'Read-only job list for Copilot (permission module tasks, table public.jobs); the caller own jobs come first.';
COMMENT ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) IS
  'Read-only material stock for Copilot; organization-scoped, totals aggregated over the whole match set.';

-- Acceptance: catalog only ---------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_lead_search_v1(uuid, text, text, integer)',
    'public.copilot_meter_readings_v1(uuid, text, uuid, integer)',
    'public.copilot_vehicle_search_v1(uuid, text, integer)',
    'public.copilot_tasks_v1(uuid, text, integer)',
    'public.copilot_material_stock_v1(uuid, text, integer)',
    'public.copilot_available_rooms_v1(uuid)',
    'public.copilot_invoice_search_v1(uuid, text, text, text)',
    'public.copilot_financial_pnl_v1(uuid, date, date, boolean)',
    'public.copilot_occupancy_v1(uuid, date, integer)',
    'public.copilot_occupancy_upcoming_v1(uuid, date, integer)',
    'public.copilot_invoice_stats_v1(uuid, text)',
    'public.copilot_deposit_summary_v1(uuid)',
    'public.copilot_customer_search_v1(uuid, text)',
    'public.copilot_expiring_contracts_v1(uuid, date, integer)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_thieu := v_thieu || v_sig;
    ELSIF to_regrole('anon') IS NOT NULL
      AND has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
      v_ho := v_ho || v_sig;
    END IF;
  END LOOP;

  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_fold_text_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'copilot text folding helper missing — 20260902193151 must run first';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
