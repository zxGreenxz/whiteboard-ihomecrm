-- Copilot read surface, part 6: the FOUR SENSITIVE DOMAINS — manager salary/KPI,
-- shareholder profit, Zalo conversations, Network Center status.
--
-- These four are not "four more reports". Each one answers a question the rest of
-- the product deliberately does not answer for everybody: what a colleague earns,
-- what an owner takes home, what a tenant said in a private chat, and what the
-- building's infrastructure is doing. So every function below is gated on the
-- SAME permission key its own screen is gated on, and nothing wider.
--
-- WHAT `authorized_scope_v3` ACTUALLY RETURNS FOR THESE FOUR KEYS
--   Measured against production on 02/09/2026 (`permission_definitions`), because
--   the shape of the answer decides the shape of the predicate:
--
--     salary.view              scope_kinds {ORGANIZATION}                required_dimensions {}
--     shareholder_profit.view  scope_kinds {ORGANIZATION}                required_dimensions {}
--     chat_zalo.view           scope_kinds {ORGANIZATION}                required_dimensions {}
--     network_center.view      scope_kinds {ORGANIZATION,AREA,BUILDING}  required_dimensions {BUILDING}
--
--   Two consequences, and both are load-bearing:
--
--   (a) The first three can only ever be granted ORGANIZATION-wide, so for them
--       `authorized_scope_v3(...).org_wide` IS the grant, and
--       `copilot_org_scope_buildings_v1` returns either every building of the
--       company or nothing at all. The building array is therefore NOT the
--       authorization for those three — `org_wide` is — and the code says so out
--       loud instead of letting a reader infer a boundary that is not there.
--
--   (b) `network_center.view` declares `required_dimensions = {BUILDING}`, and
--       `authorized_scope_v3` answers `org_wide = false` for ANY permission that
--       does (see its `resolved` CTE: `when r.needs_building ... then false`).
--       Reading `org_wide` for the network status would therefore deny everyone,
--       always. Its boundary is the BUILDING ARRAY, exactly like the report RPCs.
--
-- WHY NOT REUSE `network_center_list_fleet_v1`
--   Because of the one thing it does that a Copilot tool must not do: it resolves
--   its scope with `public.can_do_on_building('network_center','view', b.id)` over
--   EVERY building the caller can see, with no organization parameter at all. On
--   the screen that is right — the screen is a fleet view. Called from a tool whose
--   whole contract is "answer for the organization the user selected", it silently
--   mixes another company's routers into the answer. Identical reasoning to the
--   `my_org_ids()` problem that forced `copilot_report_daily_cashbook_v1`
--   (20260902213111) to rebuild `cashflow_by_day_v2`. Everything else about the
--   fleet row — the MIKROTIK router, `network_device_current`, the open-incident
--   count, the active-client count — is reproduced here line for line.
--
--   NOTHING here calls `network_center_execute_action_v1`, `..._ack_incident_v1`,
--   `..._create_maintenance_v1`, `..._cancel_maintenance_v1`,
--   `..._request_snapshot_v1` or `..._update_settings_v1`. Read only, and the
--   acceptance block at the bottom proves all four new functions are STABLE.
--
-- SALARY: `staff_id`, NOT `user_id`
--   `salary_monthly` carries BOTH. `user_id` is the OWNER of the row (the account
--   that created the payroll), `staff_id` is the manager the money belongs to —
--   see the DDL in 20260628000001 and the two RLS policies next to it:
--   `sm_owner_all` keys on `user_id`, `sm_self_select` keys on `staff_id`.
--   "Only your own row" therefore means `staff_id = auth.uid()`. Written the other
--   way round it would be exactly backwards: an owner would match EVERY row they
--   created (the leak this branch exists to prevent) and an employee would match
--   none of their own.
--
-- ZALO: THE ROOM LINK IS EMPTY TODAY, AND THE PREDICATE STAYS ANYWAY
--   Measured 02/09/2026: 0 of 1957 `zalo_conversations` rows carry a `room_id`, so
--   in practice every conversation is decided by the org-wide branch below. The
--   room -> building -> scope predicate is still written, for the same reason
--   `copilot_report_deposits_v1` writes it: the day a conversation IS linked to a
--   room, the boundary has to already be there. It also tests the source column
--   (`c.room_id IS NULL`) rather than the LEFT JOIN result, so a conversation
--   attached to a room OUTSIDE the scope cannot pass itself off as "not attached".
--
-- LIMITS AND TOTALS
--   Every function clamps `p_limit` to 1..50, echoes the clamped value, and
--   computes its totals over the WHOLE scoped set in a separate aggregate — never
--   by re-adding the list that was just truncated.
--
-- TODAY IS THE ORGANIZATION'S TODAY
--   `public.org_today_v1(p_organization_id)`, never a bare `CURRENT_DATE`: the
--   server runs UTC and the data lives at UTC+7, so between 00:00 and 07:00 in
--   Vietnam `CURRENT_DATE` is still yesterday and a default period would land in
--   the wrong month for seven hours a day.
--
-- ACCEPTANCE IS CATALOG-ONLY
--   The closing block reads `pg_proc`/ACL only, so this migration also runs on an
--   empty database (Restore Drill replays it onto a schema-only baseline).
BEGIN;
SET LOCAL lock_timeout = '15s';

-- The accent-folding helper is NOT redefined here: 20260902193151 chose it once,
-- from the catalog, and two places deciding the same thing eventually disagree.

-- 1. Manager salary / KPI (bang luong quan ly) --------------------------------
CREATE OR REPLACE FUNCTION public.copilot_salary_summary_v1(
  p_organization_id uuid,
  p_ky text DEFAULT NULL,
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
  v_org_wide boolean;
  v_today date;
  v_ky date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_ky IS NOT NULL AND p_ky !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted
  -- input. The RETURN VALUE is deliberately not kept: `salary_monthly` has no
  -- `building_id` column at all (20260628000001), so there is no building
  -- predicate for it to bind to, and holding a building array that nothing reads
  -- would read like a boundary that does not exist. The boundary here is the pair
  -- below: the company column, and `org_wide`.
  PERFORM public.copilot_org_scope_buildings_v1('salary.view', p_organization_id);
  SELECT s.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('salary.view', p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false);
  v_today := public.org_today_v1(p_organization_id);

  -- Default period: the newest payroll month that actually exists inside the
  -- scope, else this month. Defaulting blindly to "this month" answers "no data"
  -- to a question that has an answer, because a payroll row is created when the
  -- month is computed, not when the month starts.
  IF p_ky IS NOT NULL THEN
    v_ky := to_date(p_ky || '-01', 'YYYY-MM-DD');
  ELSE
    SELECT max(sm.period_month) INTO v_ky
      FROM public.salary_monthly sm
     WHERE sm.organization_id = p_organization_id
       AND (v_org_wide OR sm.staff_id = v_actor);
    v_ky := COALESCE(v_ky, date_trunc('month', v_today)::date);
  END IF;

  WITH luong AS (
    SELECT
      sm.id,
      sm.staff_id,
      sm.status,
      sm.base_salary,
      sm.work_bonus,
      sm.contract_bonus,
      sm.commission_total,
      sm.investment_profit,
      sm.adjustments_total,
      sm.advances_total,
      sm.room_rent,
      sm.gross_total,
      sm.take_home,
      sm.paid,
      sm.locked_at,
      -- Name lookup on a PRIMARY KEY, so it can neither add nor remove a row.
      -- It carries NO `pr.organization_id = p_organization_id` filter on purpose:
      -- `profiles.organization_id` is the person's HOME company and a manager may
      -- be a member of several, so filtering it would blank the name of exactly
      -- the people this answer is about.
      pr.full_name AS staff_name
    FROM public.salary_monthly sm
    LEFT JOIN public.profiles pr ON pr.id = sm.staff_id
    WHERE sm.organization_id = p_organization_id
      AND sm.period_month = v_ky
      -- Without an organization-wide grant this returns the caller's OWN row and
      -- nothing else. `staff_id`, not `user_id` — see the header.
      AND (v_org_wide OR sm.staff_id = v_actor)
  )
  SELECT
    jsonb_build_object(
      'so_nhan_vien', count(*),
      'tong_gross', COALESCE(sum(l.gross_total), 0),
      'tong_thuc_nhan', COALESCE(sum(l.take_home), 0),
      'tong_thuong', COALESCE(sum(l.work_bonus + l.contract_bonus + l.commission_total), 0),
      'tong_khau_tru', COALESCE(sum(l.advances_total + l.room_rent), 0),
      'tong_da_tra', COALESCE(sum(l.paid), 0),
      'so_ky_da_chot', count(*) FILTER (WHERE l.status = 'LOCKED')
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'nhan_vien_id', s.staff_id,
                 'nhan_vien', s.staff_name,
                 'trang_thai', s.status,
                 'luong_co_ban', s.base_salary,
                 'thuong_viec', s.work_bonus,
                 'thuong_hop_dong', s.contract_bonus,
                 'hoa_hong', s.commission_total,
                 'loi_nhuan_dau_tu', s.investment_profit,
                 'dieu_chinh', s.adjustments_total,
                 'ung_luong', s.advances_total,
                 'tien_phong', s.room_rent,
                 'tong_gross', s.gross_total,
                 'thuc_nhan', s.take_home,
                 'da_tra', s.paid,
                 'chot_luc', s.locked_at
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          l2.*,
          row_number() OVER (ORDER BY l2.take_home DESC, l2.staff_name NULLS LAST, l2.id) AS rn
        FROM luong l2
        ORDER BY l2.take_home DESC, l2.staff_name NULLS LAST, l2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM luong l;

  RETURN jsonb_build_object(
    'ky', to_char(v_ky, 'YYYY-MM'),
    -- The answer says which of the two branches produced it, so a reply built
    -- from it can never present one person's row as the whole payroll.
    'pham_vi', CASE WHEN v_org_wide THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_nhan_vien', 0, 'tong_gross', 0, 'tong_thuc_nhan', 0, 'tong_thuong', 0,
      'tong_khau_tru', 0, 'tong_da_tra', 0, 'so_ky_da_chot', 0)),
    'bang_luong', v_rows
  );
END
$fn$;

-- 2. Shareholder profit (loi nhuan co dong) -----------------------------------
CREATE OR REPLACE FUNCTION public.copilot_shareholder_profit_v1(
  p_organization_id uuid,
  p_ky text DEFAULT NULL,
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
  v_org_wide boolean;
  v_quan_ly boolean;
  v_co_dong_id uuid;
  v_quan_ly_ln_id uuid;
  v_today date;
  v_ky date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
  v_co_dong jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_ky IS NOT NULL AND p_ky !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('shareholder_profit.view', p_organization_id);
  SELECT s.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('shareholder_profit.view', p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false);

  -- shareholder_profit.view ALONE DOES NOT MEAN "MAY SEE EVERYONE'S SHARE".
  --
  -- 20260713110400 (ledger-applied) inserts a member_permission_overrides row
  -- granting exactly shareholder_profit.view ALLOW to every ACTIVE membership
  -- whose user is a shareholders.auth_user_id or a profit_managers.auth_user_id
  -- — four such memberships exist on production as of 02/09/2026. The key is
  -- ORGANIZATION-only, so authorized_scope_v3 resolves org_wide = true for those
  -- people and v_buildings becomes every building of the company.
  --
  -- On the SCREEN that grant is harmless, because RLS narrows it again:
  --   profit_alloc_self_select     shareholder_id = current_shareholder_id()
  --   profit_monthly_self_select   EXISTS(an allocation of mine on this month)
  --   profit_monthly_self_manager  EXISTS(a manager allocation of mine)
  --   pma_self_select              manager_id = current_profit_manager_id()
  -- A shareholder therefore sees their OWN payout and nothing else.
  --
  -- This function is SECURITY DEFINER, so none of those policies run. Without
  -- the branch below, a shareholder asking Copilot would receive every
  -- co-shareholder NAME and AMOUNT — strictly wider than their own screen, and
  -- produced by the very permission that screen gives them.
  --
  -- The discriminator is a management key of the SAME page that the override
  -- does NOT confer: shareholder_profit.lock (close the month) and
  -- .manage_shareholders (own the shareholder register). Both are active in
  -- permission_definitions, both are ORGANIZATION-only, and no migration grants
  -- either of them to a shareholder.
  SELECT COALESCE(l.org_wide, false) OR COALESCE(m.org_wide, false)
    INTO v_quan_ly
    FROM app_private.authorized_scope_v3('shareholder_profit.lock', p_organization_id) l
    CROSS JOIN app_private.authorized_scope_v3('shareholder_profit.manage_shareholders', p_organization_id) m;
  v_quan_ly := COALESCE(v_quan_ly, false);

  IF NOT v_quan_ly THEN
    -- The same two helpers the RLS policies use, so "mine" means the same thing
    -- in both places. Either may be NULL (a plain member is neither), and NULL
    -- never equals a row, so the restriction below fails closed.
    v_co_dong_id := public.current_shareholder_id();
    v_quan_ly_ln_id := public.current_profit_manager_id();
  END IF;

  v_today := public.org_today_v1(p_organization_id);

  -- Same default rule as the payroll: the newest month that exists in scope. A
  -- profit month only exists once the close run has produced it.
  IF p_ky IS NOT NULL THEN
    v_ky := to_date(p_ky || '-01', 'YYYY-MM-DD');
  ELSE
    SELECT max(pm.period_month) INTO v_ky
      FROM public.profit_monthly pm
      JOIN public.buildings b
        ON b.id = pm.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
     WHERE pm.organization_id = p_organization_id
       -- The DEFAULT period is chosen by a real query against this table, so it
       -- carries the same restriction as the answer. Without it, the newest
       -- month of SOMEBODY ELSE decides which month a shareholder is shown.
       AND (
         v_quan_ly
         OR EXISTS (
           SELECT 1
           FROM public.profit_allocations pa0
           WHERE pa0.profit_monthly_id = pm.id
             AND pa0.organization_id = p_organization_id
             AND pa0.shareholder_id = v_co_dong_id
         )
         OR EXISTS (
           SELECT 1
           FROM public.profit_manager_allocations pma0
           WHERE pma0.profit_monthly_id = pm.id
             AND pma0.organization_id = p_organization_id
             AND pma0.manager_id = v_quan_ly_ln_id
         )
       );
    v_ky := COALESCE(v_ky, date_trunc('month', v_today)::date);
  END IF;

  WITH ky AS (
    SELECT
      pm.id,
      pm.building_id,
      b.name AS building_name,
      pm.status,
      pm.computed_profit,
      pm.adjusted_profit,
      pm.management_salary,
      pm.shareholder_percent_total,
      pm.shareholder_allocated_amount,
      pm.unallocated_profit,
      pm.unallocated_disposition,
      pm.is_stale,
      pm.locked_at
    FROM public.profit_monthly pm
    JOIN public.buildings b
      ON b.id = pm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = v_ky
      -- Mirrors profit_monthly_self_select + profit_monthly_self_manager.
      AND (
        v_quan_ly
        OR EXISTS (
          SELECT 1
          FROM public.profit_allocations pa1
          WHERE pa1.profit_monthly_id = pm.id
            AND pa1.organization_id = p_organization_id
            AND pa1.shareholder_id = v_co_dong_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.profit_manager_allocations pma1
          WHERE pma1.profit_monthly_id = pm.id
            AND pma1.organization_id = p_organization_id
            AND pma1.manager_id = v_quan_ly_ln_id
        )
      )
  )
  SELECT
    jsonb_build_object(
      'so_toa', count(*),
      'loi_nhuan_tinh', COALESCE(sum(k.computed_profit), 0),
      'loi_nhuan_sau_dieu_chinh', COALESCE(sum(k.adjusted_profit), 0),
      'luong_quan_ly', COALESCE(sum(k.management_salary), 0),
      'da_chia_co_dong', COALESCE(sum(k.shareholder_allocated_amount), 0),
      'chua_chia', COALESCE(sum(k.unallocated_profit), 0),
      'so_toa_da_chot', count(*) FILTER (WHERE k.status = 'LOCKED'),
      'so_toa_can_tinh_lai', count(*) FILTER (WHERE k.is_stale)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'toa_nha_id', s.building_id,
                 'toa_nha', s.building_name,
                 'trang_thai', s.status,
                 'loi_nhuan_tinh', s.computed_profit,
                 'loi_nhuan_sau_dieu_chinh', s.adjusted_profit,
                 'luong_quan_ly', s.management_salary,
                 'ty_le_co_dong', s.shareholder_percent_total,
                 'da_chia_co_dong', s.shareholder_allocated_amount,
                 'chua_chia', s.unallocated_profit,
                 'xu_ly_phan_chua_chia', s.unallocated_disposition,
                 'can_tinh_lai', s.is_stale,
                 'chot_luc', s.locked_at
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          k2.*,
          row_number() OVER (ORDER BY k2.adjusted_profit DESC, k2.building_name, k2.id) AS rn
        FROM ky k2
        ORDER BY k2.adjusted_profit DESC, k2.building_name, k2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM ky k;

  -- Per-shareholder rollup over the SAME scoped month set. The allocation rows
  -- reach the tenant boundary only through `ky`, which is already bound to the
  -- company and to the building scope; the company column is asserted on both the
  -- allocation and the shareholder anyway, because "it is implied by the join" is
  -- how a boundary quietly stops being one.
  WITH ky AS (
    SELECT pm.id
    FROM public.profit_monthly pm
    JOIN public.buildings b
      ON b.id = pm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = v_ky
      -- Same restriction as the CTE above; the two must not drift apart.
      AND (
        v_quan_ly
        OR EXISTS (
          SELECT 1
          FROM public.profit_allocations pa1
          WHERE pa1.profit_monthly_id = pm.id
            AND pa1.organization_id = p_organization_id
            AND pa1.shareholder_id = v_co_dong_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.profit_manager_allocations pma1
          WHERE pma1.profit_monthly_id = pm.id
            AND pma1.organization_id = p_organization_id
            AND pma1.manager_id = v_quan_ly_ln_id
        )
      )
  ), chia AS (
    SELECT
      sh.id AS shareholder_id,
      sh.name AS shareholder_name,
      sum(pa.amount) AS amount,
      sum(pa.percent) AS percent_sum,
      count(*) AS so_toa
    FROM public.profit_allocations pa
    JOIN ky ON ky.id = pa.profit_monthly_id
    JOIN public.shareholders sh
      ON sh.id = pa.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.deleted_at IS NULL
    WHERE pa.organization_id = p_organization_id
      -- Mirrors profit_alloc_self_select. THIS is the line that decides whether
      -- a shareholder sees their co-shareholders' payouts.
      AND (v_quan_ly OR pa.shareholder_id = v_co_dong_id)
    GROUP BY sh.id, sh.name
  )
  SELECT COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'co_dong_id', s.shareholder_id,
               'co_dong', s.shareholder_name,
               'so_tien', s.amount,
               'tong_ty_le', s.percent_sum,
               'so_toa', s.so_toa
             ) ORDER BY s.rn
           )
    FROM (
      SELECT c2.*, row_number() OVER (ORDER BY c2.amount DESC, c2.shareholder_name) AS rn
      FROM chia c2
      ORDER BY c2.amount DESC, c2.shareholder_name
      LIMIT v_limit
    ) s
  ), '[]'::jsonb)
  INTO v_co_dong;

  RETURN jsonb_build_object(
    'ky', to_char(v_ky, 'YYYY-MM'),
    -- Same contract as the payroll: the answer states which branch produced it,
    -- so a reply built from it can never present one shareholder's own payout as
    -- the whole distribution.
    'pham_vi', CASE WHEN v_quan_ly THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_toa', 0, 'loi_nhuan_tinh', 0, 'loi_nhuan_sau_dieu_chinh', 0,
      'luong_quan_ly', 0, 'da_chia_co_dong', 0, 'chua_chia', 0,
      'so_toa_da_chot', 0, 'so_toa_can_tinh_lai', 0)),
    'theo_toa', v_rows,
    'theo_co_dong', v_co_dong
  );
END
$fn$;

-- 3. Zalo conversations (hoi thoai Zalo) --------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_zalo_conversations_v1(
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
  v_org_wide boolean;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('chat_zalo.view', p_organization_id);
  SELECT s.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('chat_zalo.view', p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false);
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  -- The search covers WHO the conversation is with, never WHAT was said. A needle
  -- matched against `last_message_text` would turn a conversation list into a
  -- full-text search over private chat, which is a different product with a
  -- different consent story.
  WITH hoi_thoai AS (
    SELECT
      c.id,
      c.peer_name,
      c.peer_phone,
      c.thread_type,
      c.kind,
      c.unread_count,
      c.marked_unread,
      c.is_pinned,
      c.last_message_at,
      c.last_message_dir,
      c.last_message_text,
      c.sub_label,
      rm.name AS room_name,
      b.name AS building_name
    FROM public.zalo_conversations c
    LEFT JOIN public.rooms rm
      ON rm.id = c.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    LEFT JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE c.organization_id = p_organization_id
      -- Source column, not the join result: a conversation attached to a room
      -- OUTSIDE the scope also yields `b.id IS NULL`, and must not be mistaken for
      -- one attached to no room at all.
      AND (b.id IS NOT NULL OR (c.room_id IS NULL AND v_org_wide))
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(COALESCE(c.peer_name, '')) LIKE v_needle
        OR app_private.copilot_fold_text_v1(COALESCE(c.peer_phone, '')) LIKE v_needle
        OR app_private.copilot_fold_text_v1(COALESCE(c.sub_label, '')) LIKE v_needle
      )
  )
  SELECT
    jsonb_build_object(
      'so_hoi_thoai', count(*),
      'so_chua_doc', count(*) FILTER (WHERE h.unread_count > 0 OR h.marked_unread),
      'tong_tin_chua_doc', COALESCE(sum(h.unread_count), 0),
      'so_ghim', count(*) FILTER (WHERE h.is_pinned)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hoi_thoai_id', s.id,
                 'nguoi_nhan', s.peer_name,
                 'dien_thoai', s.peer_phone,
                 'loai', s.thread_type,
                 'nhom', s.kind,
                 'chua_doc', s.unread_count,
                 'danh_dau_chua_doc', s.marked_unread,
                 'ghim', s.is_pinned,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'nhan', s.sub_label,
                 'tin_cuoi_luc', s.last_message_at,
                 'tin_cuoi_chieu', s.last_message_dir,
                 -- Truncated at the server: a conversation list needs a preview,
                 -- not a transcript, and a cap here is one less thing for the
                 -- client to forget.
                 'tin_cuoi', left(COALESCE(s.last_message_text, ''), 160)
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          h2.*,
          row_number() OVER (ORDER BY h2.last_message_at DESC NULLS LAST, h2.id) AS rn
        FROM hoi_thoai h2
        ORDER BY h2.last_message_at DESC NULLS LAST, h2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM hoi_thoai h;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_hoi_thoai', 0, 'so_chua_doc', 0, 'tong_tin_chua_doc', 0, 'so_ghim', 0)),
    'hoi_thoai', v_rows
  );
END
$fn$;

-- 4. Network Center status (trang thai mang) ----------------------------------
CREATE OR REPLACE FUNCTION public.copilot_network_status_v1(
  p_organization_id uuid,
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted
  -- input. For THIS key the building array is the whole boundary: `org_wide` is
  -- always false for a permission declaring `required_dimensions = {BUILDING}`.
  v_buildings := public.copilot_org_scope_buildings_v1('network_center.view', p_organization_id);
  -- A building outside the caller scope answers like an empty report, never like
  -- "exists but not yours".
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;

  WITH mang AS (
    SELECT
      b.id AS building_id,
      b.name AS building_name,
      rt.id AS router_id,
      rt.display_name AS router_name,
      rt.model AS router_model,
      rt.lifecycle_status,
      cur.reachable,
      cur.health_status,
      cur.last_seen_at,
      cur.routeros_version,
      cur.cpu_pct,
      cur.pppoe_state,
      cur.connection_count,
      (SELECT count(*)
         FROM public.network_incidents ni
        WHERE ni.organization_id = p_organization_id
          AND ni.building_id = b.id
          AND ni.status <> 'RESOLVED') AS open_incidents,
      (SELECT count(*)
         FROM public.network_client_current nc
        WHERE nc.organization_id = p_organization_id
          AND nc.building_id = b.id
          AND nc.expires_at > statement_timestamp()) AS active_clients,
      (SELECT jsonb_build_object(
                'tieu_de', ni2.title,
                'muc_do', ni2.severity,
                'trang_thai', ni2.status,
                'mo_luc', ni2.opened_at)
         FROM public.network_incidents ni2
        WHERE ni2.organization_id = p_organization_id
          AND ni2.building_id = b.id
        ORDER BY ni2.opened_at DESC, ni2.id
        LIMIT 1) AS last_incident
    FROM public.buildings b
    LEFT JOIN public.network_devices rt
      ON rt.organization_id = p_organization_id
     AND rt.building_id = b.id
     AND rt.device_kind = 'MIKROTIK'
     AND rt.is_active
    LEFT JOIN public.network_device_current cur
      ON cur.device_id = rt.id
     AND cur.organization_id = p_organization_id
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
      AND b.id = ANY(v_buildings)
      AND (p_building_id IS NULL OR b.id = p_building_id)
  )
  SELECT
    jsonb_build_object(
      'so_toa', count(*),
      'so_toa_co_router', count(*) FILTER (WHERE m.router_id IS NOT NULL),
      'so_toa_online', count(*) FILTER (WHERE COALESCE(m.reachable, false)),
      'so_toa_offline', count(*) FILTER (WHERE m.router_id IS NOT NULL AND NOT COALESCE(m.reachable, false)),
      'tong_su_co_mo', COALESCE(sum(m.open_incidents), 0),
      'tong_thiet_bi_ket_noi', COALESCE(sum(m.active_clients), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'toa_nha_id', s.building_id,
                 'toa_nha', s.building_name,
                 'router', s.router_name,
                 'model', s.router_model,
                 'vong_doi', s.lifecycle_status,
                 'ket_noi_duoc', COALESCE(s.reachable, false),
                 'suc_khoe', COALESCE(s.health_status, 'UNKNOWN'),
                 'thay_lan_cuoi', s.last_seen_at,
                 'phien_ban', s.routeros_version,
                 'cpu_phan_tram', s.cpu_pct,
                 'pppoe', s.pppoe_state,
                 'so_ket_noi', s.connection_count,
                 'su_co_dang_mo', s.open_incidents,
                 'thiet_bi_dang_ket_noi', s.active_clients,
                 'su_co_gan_nhat', s.last_incident
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          m2.*,
          row_number() OVER (
            ORDER BY m2.open_incidents DESC, COALESCE(m2.reachable, false), m2.building_name
          ) AS rn
        FROM mang m2
        ORDER BY m2.open_incidents DESC, COALESCE(m2.reachable, false), m2.building_name
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM mang m;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_toa', 0, 'so_toa_co_router', 0, 'so_toa_online', 0, 'so_toa_offline', 0,
      'tong_su_co_mo', 0, 'tong_thiet_bi_ket_noi', 0)),
    'toa_nha', v_rows
  );
END
$fn$;

-- ACL ------------------------------------------------------------------------
--
-- REVOKE FROM PUBLIC does NOT cut `anon` on Supabase: `anon` and `authenticated`
-- hold their own grants, so every role is named explicitly. `to_regrole` guards
-- keep the block runnable on a bare cluster where those roles do not exist.
REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) TO authenticated;
  END IF;
END
$acl$;

COMMENT ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) IS
  'Read-only manager payroll for Copilot; an organization-wide grant returns every employee, otherwise ONLY the caller own row (staff_id = auth.uid()).';
COMMENT ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) IS
  'Read-only shareholder profit for Copilot: per building and per shareholder inside the server-derived building scope.';
COMMENT ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) IS
  'Read-only Zalo conversation list for Copilot; searches the counterparty, never the message text, and sends nothing.';
COMMENT ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) IS
  'Read-only Network Center status for Copilot: router health, open incidents, connected clients — bound to the SELECTED organization instead of every building the caller can see.';


-- Rollout flags: THREE OWN SWITCHES, seeded `disabled` -----------------------
--
-- WHY NOT BORROW AN EXISTING PAGE FLAG
--   /finance/salary, /reports/finance/profit-distribution and /network-center are
--   all in COPILOT_PAGE_EXEMPTIONS, so none of them has a rollout contract. The
--   first version of this work pointed the three tools at the nearest canonical
--   page (`reports.finance` twice, `buildings.list` once). That works, and it is
--   wrong for one measurable reason: enabling the finance-REPORT rollout would
--   then also enable the PAYROLL tool. Two unrelated operational decisions on one
--   switch is precisely what removing `rolloutKeys` on 03/09 was meant to stop.
--
--   The other two options were worse: no `rolloutKey` at all makes the tool dead
--   forever (`toolAvailableForRollout` returns false), and `rolloutExempt` makes
--   it live forever with no switch at all.
--
--   So these three get their own contracts. `set_copilot_feature_flag_v2` only
--   UPDATEs rows that already exist — a contract named in the client with no row
--   here is a button in the admin screen that returns `unknown_rollout_contract`
--   and cannot be fixed by whoever pressed it. The row must exist first.
--
--   Zalo is NOT in this list: `/chat-zalo` has a real page contract
--   (`chat-zalo.list`) seeded by 20260902185838, and inventing a second switch
--   for the same page would be two rows deciding one thing.
--
-- NOTHING IS TURNED ON HERE. All three rows are `disabled`; turning one on is an
-- operational act through the RPC with CAS revision + reason + evidence +
-- rollback reference, so the record lands in the audit log instead of inside a
-- migration under the name "migration".

-- The v2 trigger (`copilot_feature_flags_bump_revision`, 20260829030000) rejects
-- any INSERT/UPDATE that does not carry this transaction marker; that is what
-- forces every runtime change through the CAS RPC. A migration seed is the one
-- remaining legitimate path, so it declares the marker itself.
SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
SELECT
  v.scope,
  v.contract_id,
  v.state,
  'seed rollout deny-by-default cho 3 tool mien nhay cam (luong, co dong, mang)',
  'migration:20260902224859_copilot_read_rpc_sensitive_v1',
  'migration:20260902224859_copilot_read_rpc_sensitive_v1'
FROM (VALUES
  ('page', 'copilot.sensitive.salary'            , 'disabled'),  -- Bảng lương quản lý
  ('page', 'copilot.sensitive.shareholder-profit', 'disabled'),  -- Lợi nhuận cổ đông
  ('page', 'copilot.sensitive.network'           , 'disabled')   -- Trung tâm mạng
) AS v(scope, contract_id, state)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- Acceptance: catalog only ---------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
  v_ghi text[] := '{}'::text[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_salary_summary_v1(uuid, text, integer)',
    'public.copilot_shareholder_profit_v1(uuid, text, integer)',
    'public.copilot_zalo_conversations_v1(uuid, text, integer)',
    'public.copilot_network_status_v1(uuid, uuid, integer)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_thieu := v_thieu || v_sig;
    ELSE
      IF to_regrole('anon') IS NOT NULL
         AND has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_sig;
      END IF;
      -- A read tool that is not STABLE is a read tool that could have been
      -- written VOLATILE with nobody noticing.
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        WHERE p.oid = to_regprocedure(v_sig)::oid
          AND p.provolatile = 's'
      ) THEN
        v_ghi := v_ghi || v_sig;
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot sensitive RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot sensitive RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;
  IF cardinality(v_ghi) > 0 THEN
    RAISE EXCEPTION 'copilot sensitive RPC is not STABLE: %', array_to_string(v_ghi, ', ');
  END IF;
  IF to_regprocedure('public.copilot_org_scope_buildings_v1(text, uuid)') IS NULL
     OR to_regprocedure('app_private.authorized_scope_v3(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot scope helpers missing — 20260829090000 must run first';
  END IF;
  IF to_regprocedure('app_private.copilot_fold_text_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'accent-folding helper missing — 20260902193151 must run first';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'org_today_v1 missing — 20260731070000 must run first';
  END IF;
  IF to_regprocedure('public.current_shareholder_id()') IS NULL
     OR to_regprocedure('public.current_profit_manager_id()') IS NULL THEN
    RAISE EXCEPTION 'shareholder identity helpers missing — the profit module must run first';
  END IF;

  -- The only non-catalog read in this block, and it reads the flag table this
  -- migration just seeded — nothing business-shaped. `copilot_feature_flags` is
  -- created by 20260828170000 in the same forward lane, so an empty database
  -- still replays this (same property 20260902185838 relies on).
  SELECT array_agg(k ORDER BY k)
  INTO v_thieu
  FROM unnest(ARRAY[
    'copilot.sensitive.salary',
    'copilot.sensitive.shareholder-profit',
    'copilot.sensitive.network'
  ]) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.copilot_feature_flags f
    WHERE f.scope = 'page' AND f.contract_id = k
  );
  IF v_thieu IS NOT NULL AND cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_contract: %', array_to_string(v_thieu, ', ');
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
