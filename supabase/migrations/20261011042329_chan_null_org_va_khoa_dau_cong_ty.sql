-- =============================================================================
-- Chặn organization_id NULL ở 35 bảng ghi từ client + khoá dấu công ty
-- (plan 2026-10-07 mục 0.1: N-A6-11 P0, kèm N-A2-06 / N-A4-03 / N-A6-12;
--  rà soát 11/10/2026: S1 F2 + F3 + F11, E-05 + E-06)
--
-- VẤN ĐỀ ĐÃ CHỨNG MINH BẰNG GỌI THẬT TRÊN TEST (11/10/2026)
--   (1) Chủ công ty INSERT REST thẳng vào materials / hotlines /
--       income_expense_templates / job_groups KHÔNG gửi organization_id ⇒ dòng
--       mang organization_id NULL. Policy RESTRICTIVE <bảng>_org_boundary có
--       nhánh `organization_id IS NULL` (cả USING lẫn WITH CHECK) nên dòng NULL
--       qua ranh giới của MỌI công ty: materials và job_groups đọc được bằng tài
--       khoản quản lý của công ty KHÁC.
--   (2) Quản lý toà PATCH rooms.organization_id = null trên phòng của chính mình
--       ⇒ 200, dòng thành NULL ("gỡ dấu công ty"). Không có trigger nào canh
--       UPDATE cột organization_id; autofill_org_strict chỉ chạy BEFORE INSERT.
--
-- ĐO PRODUCTION TRƯỚC KHI SỬA (CHỈ ĐỌC, npm run db:query, 11/10/2026)
--   • 259 bảng public (không tính phân mảnh con) có cột organization_id:
--     136 NOT NULL, 123 cho NULL; 122/123 bảng cho NULL có policy ranh giới với
--     nhánh IS NULL (ngoại lệ personal_transactions — sổ miễn trừ, org là siêu
--     dữ liệu lịch sử).
--   • 35 bảng ở danh sách dưới: 0 dòng organization_id NULL (từng bảng).
--     Dòng NULL hiện có chỉ ở bảng hệ thống KHÔNG đụng tới: cron_runs,
--     personal_transactions, ai_providers, ai_copilot_settings.
--   • Hàm SQL ghi vào 35 bảng: lock_salary_month_v1 (ghi
--     salary_work_ledger_snapshot, có gửi organization_id); recompute tồn /
--     tổng tiền vật tư và set_salary_v5_config / v5_close_period chỉ UPDATE.
--     handle_new_user INSERT profiles KHÔNG có org (người mới chưa thuộc công
--     ty nào) ⇒ profiles KHÔNG vào danh sách NOT NULL / trigger điền org.
--   • Khoá ngoại thật của 7 cột cha mới (trên mọi bảng đang dùng
--     autofill_org_strict cộng 32 bảng mới gắn): mỗi tên cột trỏ ĐÚNG MỘT bảng
--     cha — purchase_id→material_purchases, adjustment_id→material_adjustments,
--     quota_id→service_quotas (service_quota_tiers, services),
--     asset_id→assets (asset_movements, asset_maintenance), lead_id→leads,
--     manager_id→profit_managers, salary_monthly_id→salary_monthly. 15 cột cũ
--     cũng không cột nào cùng tên mà khác cha trên tập bảng mới.
--
-- LÀM GÌ
--   1. app_private.autofill_org_strict(): thêm 7 cột cha ở CUỐI mảng (giữ
--      nguyên thứ tự 15 cột cũ ⇒ mọi bảng đang dùng suy ra đúng như trước).
--   2. 35 bảng: gắn trg_autofill_org_strict (BEFORE INSERT, fail-closed 23502)
--      nếu chưa có; SET NOT NULL organization_id; bỏ nhánh
--      `organization_id IS NULL` khỏi USING và WITH CHECK của <bảng>_org_boundary.
--      Client (cùng commit) gửi organization_id của công ty đang chọn qua withOrg.
--   3. Khoá dấu công ty: trigger zz_khoa_organization_id BEFORE UPDATE OF
--      organization_id, hàm app_private.khoa_organization_id_v1() SECURITY
--      INVOKER, gắn cho MỌI bảng public có cột organization_id (trừ bảng trong sổ
--      miễn trừ app_private.org_boundary_exemptions — hiện chỉ
--      personal_transactions) — 258 bảng trên production 11/10/2026, gồm mọi bảng
--      tiền/PII lõi. Đổi giá trị (kể cả thành NULL) bị chặn 42501 trừ
--      khi current_user là postgres / service_role / supabase_admin.
--      • INVOKER + current_user (không session_user): bên trong hàm SECURITY
--        DEFINER current_user là chủ hàm (postgres) ⇒ mã máy chủ đi như cũ;
--        PostgREST SET ROLE theo JWT nên client không đổi được current_user.
--      • Tên zz_… để chạy SAU các trigger BEFORE UPDATE khác (thấy giá trị cuối).
--      • Chế độ 'giu' cho 3 bảng cấu hình THEO NGƯỜI có upsert theo khoá không
--        chứa org (settings: user_id,key; push_subscriptions: endpoint;
--        invoice_generation_settings: user_id): client gửi công ty đang chọn, nếu
--        dòng đã có thì ON CONFLICT DO UPDATE sẽ ghi đè org (đúng cái bẫy đã ghi ở
--        20261010142330). Ở đây trigger GIỮ org cũ thay vì ném lỗi ⇒ người thuộc
--        hai công ty vẫn lưu được, dòng không đổi công ty.
--
-- LUỒNG ĐỔI ORG HỢP LỆ ĐÃ RÀ (11/10/2026) — tất cả chạy dưới current_user được phép
--   • Hàm SECURITY DEFINER đặt organization_id trong UPDATE: _termination_ensure_type
--     (income_expense_types), lifecycle_reminder_sweep_v1 (notifications) — chủ
--     hàm postgres. Đo catalog: 1.382 hàm DEFINER của public/app_private thuộc
--     postgres, 2 thuộc ie_detail_reader (hàm đọc, không UPDATE org).
--   • demo_reset (edge function demo-reset gọi RPC DEFINER), script vận hành qua
--     pooler (postgres), edge function bằng service_role.
--   • Không có RPC/UI "chuyển toà sang công ty khác"; src/ không có .update() nào
--     gửi organization_id; upsert phía client: residence_registrations (khoá
--     xung đột có organization_id), area_buildings (ignoreDuplicates),
--     public_room_settings (không gửi org, trigger điền BIU), 3 bảng chế độ 'giu'.
--
-- KHÔNG ĐỤNG: event trigger org_boundary_tu_dong (bảng MỚI vẫn sinh policy có
-- nhánh IS NULL — để việc riêng); profiles; bảng hệ thống có NULL hợp lệ.
-- Idempotent: hàm CREATE OR REPLACE; trigger/NOT NULL/policy chỉ tạo/sửa khi
-- chưa đúng (lượt hai không lấy lại khoá bảng); khối nghiệm thu chỉ đọc.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Hàm suy tổ chức FAIL-CLOSED — thêm 7 cột cha ở cuối mảng.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.autofill_org_strict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
DECLARE
  j     jsonb := to_jsonb(NEW);
  v_org uuid;
  v_n   int;
  v_val text;
  -- [cột khoá ngoại, bảng cha] — thứ tự là độ tin cậy giảm dần. 15 dòng đầu giữ
  -- nguyên bản 20260915144656; 7 dòng cuối thêm 11/10/2026 cho bảng con vật tư,
  -- định mức, tài sản, khách hẹn, lương quản lý (khoá ngoại đã đối chiếu
  -- production: mỗi tên cột trỏ đúng một bảng cha).
  cha   text[][] := ARRAY[
    ARRAY['building_id',       'buildings'],
    ARRAY['room_id',           'rooms'],
    ARRAY['contract_id',       'contracts'],
    ARRAY['invoice_id',        'invoices'],
    ARRAY['income_expense_id', 'income_expenses'],
    ARRAY['account_id',        'accounts'],
    ARRAY['customer_id',       'customers'],
    ARRAY['session_id',        'inspection_sessions'],
    ARRAY['usage_id',          'material_usages'],
    ARRAY['handover_id',       'cash_handovers'],
    ARRAY['batch_id',          'income_expense_batches'],
    ARRAY['meter_id',          'meters'],
    ARRAY['deposit_id',        'deposits'],
    ARRAY['job_id',            'jobs'],
    ARRAY['tenant_id',         'tenants'],
    ARRAY['purchase_id',       'material_purchases'],
    ARRAY['adjustment_id',     'material_adjustments'],
    ARRAY['quota_id',          'service_quotas'],
    ARRAY['asset_id',          'assets'],
    ARRAY['lead_id',           'leads'],
    ARRAY['manager_id',        'profit_managers'],
    ARRAY['salary_monthly_id', 'salary_monthly']
  ];
  nguoi text[] := ARRAY['user_id', 'owner_id', 'giver_id', 'staff_id'];
  i     int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- (1) Suy qua bảng CHA.
  FOR i IN 1 .. array_length(cha, 1) LOOP
    CONTINUE WHEN NOT (j ? cha[i][1]);
    v_val := j->>cha[i][1];
    -- Cột trùng tên mà không phải uuid (public_room_events.session_id là id
    -- phiên trình duyệt, kiểu text) thì BỎ QUA, không ép kiểu rồi nổ 22P02.
    CONTINUE WHEN v_val IS NULL OR v_val !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', cha[i][2])
      INTO v_org USING v_val::uuid;
    EXIT WHEN v_org IS NOT NULL;
  END LOOP;

  -- (2) Suy qua NGƯỜI, CHỈ khi người đó thuộc đúng MỘT tổ chức ACTIVE.
  IF v_org IS NULL THEN
    FOR i IN 1 .. array_length(nguoi, 1) LOOP
      CONTINUE WHEN NOT (j ? nguoi[i]) OR (j->>nguoi[i]) IS NULL;
      SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id)
        INTO v_org, v_n
        FROM public.organization_memberships m
       WHERE m.user_id = (j->>nguoi[i])::uuid AND m.status = 'ACTIVE';
      IF v_n IS DISTINCT FROM 1 THEN v_org := NULL; END IF;
      EXIT WHEN v_org IS NOT NULL;
    END LOOP;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION '% : không suy được organization_id cho dòng này. Đường ghi phải tự khai organization_id, hoặc dòng phải có cha/người thuộc đúng một tổ chức.',
      TG_TABLE_NAME USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END;
$f$;

COMMENT ON FUNCTION app_private.autofill_org_strict() IS
  'Suy organization_id tu bang cha (22 cot, co chot dung-dang-uuid) roi toi nguoi (chi khi nguoi thuoc dung mot to chuc ACTIVE). FAIL-CLOSED: khong suy duoc thi NO 23502. 11/10/2026: them 7 cot cha (purchase_id, adjustment_id, quota_id, asset_id, lead_id, manager_id, salary_monthly_id) va gan cho 32 bang moi.';

REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM anon;
REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hàm khoá dấu công ty — SECURITY INVOKER, canh theo current_user.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.khoa_organization_id_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $f$
BEGIN
  IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  -- Mã máy chủ: hàm SECURITY DEFINER (current_user = chủ hàm postgres), edge
  -- function/worker bằng service_role, script vận hành qua pooler. Client qua
  -- PostgREST luôn là authenticated/anon và không tự đổi được current_user.
  -- KHÔNG dùng session_user: SET ROLE không đổi nó.
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Bảng cấu hình theo người (upsert theo khoá không chứa org): giữ công ty cũ
  -- của dòng, cho phần còn lại của lệnh đi tiếp.
  IF TG_NARGS > 0 AND TG_ARGV[0] = 'giu' THEN
    NEW.organization_id := OLD.organization_id;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% : không được đổi organization_id của dòng đã có (gỡ hoặc chuyển dấu công ty). Chỉ hàm máy chủ đổi được.',
    TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Tạo dòng mới ở đúng công ty thay vì chuyển dòng cũ.';
END;
$f$;

COMMENT ON FUNCTION app_private.khoa_organization_id_v1() IS
  'Trigger BEFORE UPDATE OF organization_id (zz_khoa_organization_id): chan doi organization_id cua dong da co (ke ca thanh NULL) khi current_user khong phai postgres/service_role/supabase_admin. SECURITY INVOKER de ham DEFINER cua he thong (current_user = chu ham) di nhu cu. Tham so giu = giu org cu thay vi nem loi (bang cau hinh theo nguoi co upsert). 11/10/2026.';

REVOKE ALL ON FUNCTION app_private.khoa_organization_id_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.khoa_organization_id_v1() FROM anon;
REVOKE ALL ON FUNCTION app_private.khoa_organization_id_v1() FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. 35 bảng ghi từ client: trigger điền org + NOT NULL + ranh giới không NULL.
--    Nhóm theo S1 mục 3 (11/10/2026):
--      N1 quyền chỉ theo can_access_org_entity (lộ chéo khi NULL) — 13 bảng
--      N2 quyền theo toà / building_id — 6 bảng
--      N3 quyền theo user_id / chủ dòng — 13 bảng (không có profiles)
--      N4 đã có trg_autofill_org_strict, plan 0.1 nêu tên — 3 bảng
-- ---------------------------------------------------------------------------
DO $bang$
DECLARE
  ds text[] := ARRAY[
    -- N1
    'materials', 'material_categories', 'material_purchases', 'material_purchase_items',
    'material_adjustments', 'material_adjustment_items', 'income_expense_templates',
    'job_groups', 'lead_activities', 'hotlines', 'ct01_declarations',
    'service_quotas', 'service_quota_tiers',
    -- N2
    'asset_handovers', 'asset_movements', 'asset_maintenance', 'asset_warehouses',
    'auto_debt_config', 'area_buildings',
    -- N3
    'areas', 'shareholders', 'building_shareholders', 'profit_managers',
    'profit_manager_salaries', 'profit_manager_salary_buildings', 'manager_salary_config',
    'salary_bonus_rules', 'salary_holidays', 'salary_work_ledger_snapshot',
    'user_subscriptions', 'push_subscriptions', 'invoice_generation_settings',
    -- N4
    'material_usages', 'material_usage_items', 'settings'
  ];
  b       text;
  v_oid   oid;
  v_null  bigint;
  v_pol   record;
  v_strict regprocedure := 'app_private.autofill_org_strict()'::regprocedure;
  v_bien  text := '(SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids()))';
  v_gan   int := 0;
  v_nn    int := 0;
  v_sua   int := 0;
BEGIN
  IF array_length(ds, 1) <> 35 THEN
    RAISE EXCEPTION 'Danh sách bảng phải đúng 35 (đang %). DỪNG.', array_length(ds, 1);
  END IF;

  FOREACH b IN ARRAY ds LOOP
    v_oid := to_regclass(format('public.%I', b));
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Thiếu bảng public.%. DỪNG.', b;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = v_oid AND attname = 'organization_id' AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'public.% không có cột organization_id. DỪNG.', b;
    END IF;

    -- Dừng thay vì đoán: production đo 11/10/2026 là 0 dòng ở cả 35 bảng.
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', b) INTO v_null;
    IF v_null > 0 THEN
      RAISE EXCEPTION 'public.% còn % dòng organization_id NULL — phải gán công ty có kiểm chứng trước khi đặt NOT NULL. DỪNG.', b, v_null
        USING ERRCODE = '23502';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = v_oid AND tgfoid = v_strict AND NOT tgisinternal) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()', b);
      v_gan := v_gan + 1;
    END IF;

    IF NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = v_oid AND attname = 'organization_id') THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', b);
      v_nn := v_nn + 1;
    END IF;

    -- Đọc policy SAU ALTER TABLE: event trigger org_boundary_tu_dong có thể vừa
    -- sinh policy (có nhánh IS NULL) nếu bảng chưa có — sửa luôn ở dưới.
    SELECT pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
      INTO v_pol
      FROM pg_policy p
     WHERE p.polrelid = v_oid AND p.polname = b || '_org_boundary';
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
        b || '_org_boundary', b, v_bien, v_bien);
      v_sua := v_sua + 1;
    ELSIF v_pol.w IS NULL
       OR coalesce(v_pol.q, '') ~* 'organization_id\s+IS\s+NULL'
       OR coalesce(v_pol.w, '') ~* 'organization_id\s+IS\s+NULL' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)',
        b || '_org_boundary', b, v_bien, v_bien);
      v_sua := v_sua + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'chan_null_org: gắn % trigger điền org, đặt NOT NULL % bảng, sửa % policy ranh giới.', v_gan, v_nn, v_sua;
END
$bang$;

-- ---------------------------------------------------------------------------
-- 4. Khoá dấu công ty trên MỌI bảng public có cột organization_id
--    (trừ sổ miễn trừ ranh giới). Bảng 'giu' = cấu hình theo người có upsert.
-- ---------------------------------------------------------------------------
DO $khoa$
DECLARE
  r      record;
  giu    text[] := ARRAY['settings', 'push_subscriptions', 'invoice_generation_settings'];
  v_mien text[] := ARRAY[]::text[];
  v_mode text;
  v_n    int := 0;
  v_tong int := 0;
BEGIN
  IF to_regclass('app_private.org_boundary_exemptions') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(table_name::text), ARRAY[]::text[]) FROM app_private.org_boundary_exemptions'
      INTO v_mien;
  END IF;

  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND NOT (c.relname = ANY (v_mien))
     ORDER BY c.relname
  LOOP
    v_tong := v_tong + 1;
    v_mode := CASE WHEN r.relname = ANY (giu) THEN 'giu' ELSE 'chan' END;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = r.oid AND t.tgname = 'zz_khoa_organization_id' AND NOT t.tgisinternal
         AND t.tgfoid = 'app_private.khoa_organization_id_v1()'::regprocedure
         AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF organization_id ON%'
         AND pg_get_triggerdef(t.oid) LIKE '%FOR EACH ROW%'
         AND pg_get_triggerdef(t.oid) LIKE '%khoa_organization_id_v1(''' || v_mode || ''')');
    -- Chỉ DROP khi trigger cùng tên tồn tại mà sai định nghĩa: DROP TRIGGER (kể cả
    -- IF EXISTS) lấy ACCESS EXCLUSIVE trên bảng — không khoá 350 bảng vô cớ.
    IF EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = r.oid AND t.tgname = 'zz_khoa_organization_id' AND NOT t.tgisinternal) THEN
      EXECUTE format('DROP TRIGGER zz_khoa_organization_id ON public.%I', r.relname);
    END IF;
    EXECUTE format(
      'CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE OF organization_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1(%L)', r.relname, v_mode);
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'khoa_organization_id: % bảng có cột organization_id ngoài sổ miễn trừ, gắn mới/sửa % trigger.', v_tong, v_n;
END
$khoa$;

-- ---------------------------------------------------------------------------
-- 5. NGHIỆM THU — chỉ đọc catalog và đếm dòng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ds text[] := ARRAY[
    'materials', 'material_categories', 'material_purchases', 'material_purchase_items',
    'material_adjustments', 'material_adjustment_items', 'income_expense_templates',
    'job_groups', 'lead_activities', 'hotlines', 'ct01_declarations',
    'service_quotas', 'service_quota_tiers',
    'asset_handovers', 'asset_movements', 'asset_maintenance', 'asset_warehouses',
    'auto_debt_config', 'area_buildings',
    'areas', 'shareholders', 'building_shareholders', 'profit_managers',
    'profit_manager_salaries', 'profit_manager_salary_buildings', 'manager_salary_config',
    'salary_bonus_rules', 'salary_holidays', 'salary_work_ledger_snapshot',
    'user_subscriptions', 'push_subscriptions', 'invoice_generation_settings',
    'material_usages', 'material_usage_items', 'settings'
  ];
  loi_cot  text[] := ARRAY['rooms', 'buildings', 'customers', 'contracts', 'invoices',
                           'payments', 'income_expenses', 'accounts'];
  giu      text[] := ARRAY['settings', 'push_subscriptions', 'invoice_generation_settings'];
  cot_moi  text[] := ARRAY['purchase_id', 'adjustment_id', 'quota_id', 'asset_id', 'lead_id',
                           'manager_id', 'salary_monthly_id', 'income_expense_id', 'batch_id'];
  b        text;
  v_oid    oid;
  v_null   bigint;
  v_src    text;
  v_mien   text[] := ARRAY[]::text[];
  v_can    int;
  v_co     int;
  v_bad    text[] := ARRAY[]::text[];
  v_guard  regprocedure := 'app_private.khoa_organization_id_v1()'::regprocedure;
  v_strict regprocedure := 'app_private.autofill_org_strict()'::regprocedure;
BEGIN
  -- (a) Hàm suy org: đủ cột cha, vẫn fail-closed, vẫn DEFINER.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_strict;
  FOREACH b IN ARRAY cot_moi LOOP
    IF position(quote_literal(b) IN v_src) = 0 THEN
      v_bad := v_bad || format('autofill_org_strict thiếu cột cha %s', b);
    END IF;
  END LOOP;
  IF position('23502' IN v_src) = 0 THEN
    v_bad := v_bad || 'autofill_org_strict mất nhánh 23502'::text;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_strict) THEN
    v_bad := v_bad || 'autofill_org_strict phải SECURITY DEFINER'::text;
  END IF;

  -- (b) 35 bảng: NOT NULL, trigger điền org, ranh giới RESTRICTIVE không nhánh NULL, 0 dòng NULL.
  FOREACH b IN ARRAY ds LOOP
    v_oid := to_regclass(format('public.%I', b));
    IF v_oid IS NULL THEN
      v_bad := v_bad || format('%s: không có bảng', b);
      CONTINUE;
    END IF;
    IF NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = v_oid AND attname = 'organization_id') THEN
      v_bad := v_bad || format('%s: organization_id chưa NOT NULL', b);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_oid AND tgfoid = v_strict AND NOT tgisinternal) THEN
      v_bad := v_bad || format('%s: thiếu trigger autofill_org_strict', b);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = v_oid AND p.polname = b || '_org_boundary'
                      AND NOT p.polpermissive AND p.polcmd = '*'
                      AND p.polwithcheck IS NOT NULL) THEN
      v_bad := v_bad || format('%s: thiếu policy %s_org_boundary RESTRICTIVE FOR ALL có WITH CHECK', b, b);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = v_oid AND p.polname = b || '_org_boundary'
                  AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~* 'IS\s+NULL'
                    OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'IS\s+NULL')) THEN
      v_bad := v_bad || format('%s: policy ranh giới còn nhánh IS NULL', b);
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', b) INTO v_null;
    IF v_null > 0 THEN
      v_bad := v_bad || format('%s: còn %s dòng organization_id NULL', b, v_null);
    END IF;
  END LOOP;

  -- (c) Khoá dấu công ty: đủ trên mọi bảng có cột org ngoài sổ miễn trừ.
  IF to_regclass('app_private.org_boundary_exemptions') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(table_name::text), ARRAY[]::text[]) FROM app_private.org_boundary_exemptions'
      INTO v_mien;
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM pg_trigger t
            WHERE t.tgrelid = c.oid AND t.tgname = 'zz_khoa_organization_id' AND NOT t.tgisinternal
              AND t.tgfoid = v_guard
              AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF organization_id ON%'
              AND pg_get_triggerdef(t.oid) LIKE '%FOR EACH ROW%'
              AND pg_get_triggerdef(t.oid) LIKE
                  '%khoa_organization_id_v1(''' || CASE WHEN c.relname = ANY (giu) THEN 'giu' ELSE 'chan' END || ''')'))
    INTO v_can, v_co
    FROM pg_class c
    JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND NOT (c.relname = ANY (v_mien));
  IF v_can = 0 OR v_co <> v_can THEN
    v_bad := v_bad || format('khoá dấu công ty: %s/%s bảng có trigger đúng', v_co, v_can);
  END IF;
  FOREACH b IN ARRAY loi_cot || ds LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = to_regclass(format('public.%I', b))
                      AND t.tgname = 'zz_khoa_organization_id' AND t.tgfoid = v_guard AND NOT t.tgisinternal) THEN
      v_bad := v_bad || format('%s: thiếu trigger khoá dấu công ty', b);
    END IF;
  END LOOP;

  -- (d) Hàm khoá là INVOKER; cả hai hàm không gọi trực tiếp được từ client.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_guard) THEN
    v_bad := v_bad || 'khoa_organization_id_v1 phải SECURITY INVOKER (DEFINER làm current_user luôn là chủ hàm)'::text;
  END IF;
  IF has_function_privilege('anon', v_guard, 'EXECUTE') OR has_function_privilege('authenticated', v_guard, 'EXECUTE')
     OR has_function_privilege('anon', v_strict, 'EXECUTE') OR has_function_privilege('authenticated', v_strict, 'EXECUTE') THEN
    v_bad := v_bad || 'hàm trigger còn EXECUTE cho anon/authenticated'::text;
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'Nghiệm thu chặn NULL org / khoá dấu công ty KHÔNG ĐẠT: %', array_to_string(v_bad, '; ');
  END IF;
  RAISE NOTICE 'OK: 35 bảng NOT NULL + trigger điền org + ranh giới không nhánh NULL; khoá dấu công ty trên %/% bảng.', v_co, v_can;
END
$nghiem_thu$;

-- =============================================================================
-- ROLLBACK (thủ công, theo thứ tự; không có đường lùi tự động):
--   1. Gỡ khoá dấu: với mọi bảng public có trigger zz_khoa_organization_id:
--        DROP TRIGGER zz_khoa_organization_id ON public.<bảng>;
--      rồi DROP FUNCTION app_private.khoa_organization_id_v1();
--   2. Ranh giới: ALTER POLICY <bảng>_org_boundary ON public.<bảng>
--        USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
--        WITH CHECK (cùng biểu thức) — chỉ khi buộc phải mở lại; nhánh NULL là lỗ F2.
--   3. ALTER TABLE public.<bảng> ALTER COLUMN organization_id DROP NOT NULL cho 35 bảng
--      (không mất dữ liệu).
--   4. DROP TRIGGER trg_autofill_org_strict ON public.<bảng> cho 32 bảng mới gắn
--      (KHÔNG gỡ ở material_usages, material_usage_items, settings — có từ trước).
--   5. CREATE OR REPLACE app_private.autofill_org_strict() bằng thân của
--      20260915144656 (15 cột cha). Migration không ghi dữ liệu nghiệp vụ nào.
-- =============================================================================
