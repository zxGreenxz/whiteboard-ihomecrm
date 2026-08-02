-- =====================================================================
-- Đợt 1 — CONTEXT SUBMIT DÙNG CHUNG cho các trang thanh toán đặc biệt
--
-- Plan mô tả: "xác thực tổ chức, timezone, **idempotency LOOKUP trước mọi thứ**,
-- đúng quyền thu_tien.collect CỘNG THÊM hai key legacy mà backend nhóm này thật
-- sự dùng (buildings.view qua can_access_building, income_expenses.all_buildings
-- qua ie_all_buildings_scope), toà, sổ THẬT, chứng từ, feature route (evaluate
-- ĐÚNG MỘT LẦN/transaction), CANARY safety caps".
--
-- VÌ SAO GOM VÀO MỘT CHỖ: năm writer sắp tới đều phải làm y hệt chuỗi kiểm này.
-- Mỗi bản chép là một cơ hội quên một mắt xích — và mắt xích hay bị quên nhất là
-- "sổ THẬT", vì trên prod có **sổ ảo** (243/287 phiếu cọc nằm trên đó). Ghi tiền
-- vào sổ ảo là báo két có tiền không có thật.
--
-- THỨ TỰ CÓ CHỦ Ý (không được đảo):
--   1. Đăng nhập
--   2. **IDEMPOTENCY LOOKUP TRƯỚC MỌI THỨ** — lần gọi lặp phải trả kết quả cũ
--      NGAY, không được ăn lỗi "hết hạn mức canary" hay "kỳ đã khoá" cho một
--      thao tác ĐÃ hoàn tất hợp lệ.
--   3. Org + membership ACTIVE
--   4. Quyền: thu_tien.collect HOẶC can_access_building HOẶC ie_all_buildings_scope
--      HOẶC admin/super. Ba key vì backend nhóm này thật sự đọc cả ba.
--   5. Toà thuộc đúng org
--   6. Sổ quỹ: tồn tại, chưa xoá, và **KHÔNG ảo**
--   7. Feature route: evaluate ĐÚNG MỘT LẦN, trả trong context để writer khỏi gọi lại
--   8. Ngày nghiệp vụ theo múi giờ tổ chức (org_today_v1, không CURRENT_DATE)
--
-- KHÔNG ĐỤNG TIỀN: hàm chỉ ĐỌC và trả context. Không INSERT/UPDATE/DELETE.
-- Việc CLAIM idempotency là của writer (hàm này chỉ LOOKUP).
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.evaluate_feature_route(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu evaluate_feature_route. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1 — chạy 20260731061000 trước. DỪNG.';
  END IF;
  IF to_regclass('app_private.canonical_write_operations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.canonical_write_operations. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION app_private.special_page_submit_context_v1(
  p_operation       text,
  p_organization_id uuid,
  p_building_id     uuid,
  p_account_id      uuid,
  p_idempotency_key text,
  p_subject_scope   text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_scope text;
  v_op    app_private.canonical_write_operations%rowtype;
  v_route text;
  v_today date;
  v_acc   record;
  v_bld   record;
BEGIN
  -- 1. Đăng nhập
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_operation),'') = '' THEN
    RAISE EXCEPTION 'submit_context: thiếu operation' USING ERRCODE = '22023';
  END IF;
  -- Cùng luật với create_cashbook_v1 để hai bên không lệch chuẩn key.
  IF p_idempotency_key IS NULL
     OR char_length(btrim(p_idempotency_key)) < 8
     OR char_length(btrim(p_idempotency_key)) > 200
     OR btrim(p_idempotency_key) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;

  v_org   := p_organization_id;
  v_scope := COALESCE(p_subject_scope, v_org::text);

  -- 2. IDEMPOTENCY LOOKUP TRƯỚC MỌI THỨ.
  -- Thứ tự này là CÓ CHỦ Ý: nếu kiểm quyền/hạn mức/kỳ trước, thì một thao tác ĐÃ
  -- hoàn tất hợp lệ khi gọi lại (mạng chập, người dùng bấm lại) sẽ ăn lỗi mới —
  -- ví dụ "kỳ đã khoá" hoặc "hết hạn mức canary" — dù chẳng có gì cần làm nữa.
  SELECT * INTO v_op FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org AND o.operation = p_operation
     AND o.subject_scope = v_scope AND o.actor_id = v_actor
     AND o.idempotency_key = btrim(p_idempotency_key);
  IF FOUND AND v_op.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'replay', true,
      'operation', p_operation,
      'organizationId', v_org,
      'subjectId', v_op.subject_id,
      'response', v_op.response_payload);
  END IF;

  -- 3. Org + membership ACTIVE
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_context: thiếu organization_id' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bạn không thuộc tổ chức này' USING ERRCODE = '42501';
  END IF;

  -- 5. Toà (kiểm trước quyền vì quyền theo toà cần biết toà có thật không)
  IF p_building_id IS NOT NULL THEN
    SELECT b.id, b.organization_id INTO v_bld
      FROM public.buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
    IF v_bld.id IS NULL THEN
      RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE = '22023';
    END IF;
    IF v_bld.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Toà nhà không thuộc tổ chức này' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Quyền — BA key, vì backend nhóm này thật sự đọc cả ba.
  IF NOT (
        public.is_super_admin() OR public.is_admin()
     OR (p_building_id IS NOT NULL AND public.can_access_building(p_building_id))
     OR (p_building_id IS NOT NULL AND public.ie_all_buildings_scope(p_building_id))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- 6. Sổ quỹ phải THẬT
  IF p_account_id IS NOT NULL THEN
    SELECT a.id, a.organization_id, COALESCE(a.is_virtual,false) AS is_virtual, a.name
      INTO v_acc
      FROM public.accounts a WHERE a.id = p_account_id AND a.deleted_at IS NULL;
    IF v_acc.id IS NULL THEN
      RAISE EXCEPTION 'Không tìm thấy sổ quỹ' USING ERRCODE = '22023';
    END IF;
    IF v_acc.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức này' USING ERRCODE = '42501';
    END IF;
    -- Mắt xích hay bị quên nhất. Trên prod có sổ ẢO (243/287 phiếu cọc nằm trên
    -- đó, ~998tr backfill). Ghi tiền THẬT vào sổ ảo là báo két có tiền không có
    -- thật, và không cách nào phát hiện từ màn hình.
    IF v_acc.is_virtual THEN
      RAISE EXCEPTION
        'Sổ quỹ "%" là SỔ ẢO (chỉ để ghi nhận sổ sách), không nhận được tiền thật. Chọn sổ quỹ thật.',
        v_acc.name USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 7. Feature route — ĐÚNG MỘT LẦN. Trả trong context để writer khỏi gọi lại
  --    (gọi hai lần trong một transaction có thể ra hai kết quả nếu cờ đổi giữa chừng).
  v_route := app_private.evaluate_feature_route(p_operation, v_org);

  -- 8. Ngày nghiệp vụ theo múi giờ TỔ CHỨC, không CURRENT_DATE (server chạy UTC
  --    nên CURRENT_DATE lùi một ngày trong 00:00–07:00 giờ VN).
  v_today := public.org_today_v1(v_org);

  RETURN jsonb_build_object(
    'replay', false,
    'operation', p_operation,
    'organizationId', v_org,
    'actorId', v_actor,
    'buildingId', p_building_id,
    'accountId', p_account_id,
    'accountIsVirtual', COALESCE(v_acc.is_virtual, false),
    'idempotencyKey', btrim(p_idempotency_key),
    'subjectScope', v_scope,
    'featureRoute', v_route,
    'orgToday', v_today,
    'claimExists', (v_op.idempotency_key IS NOT NULL));
END;
$function$;

REVOKE ALL ON FUNCTION app_private.special_page_submit_context_v1(text,uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION app_private.special_page_submit_context_v1(text,uuid,uuid,uuid,text,text) IS
  'Đợt 1: context submit dùng chung cho các trang thanh toán đặc biệt. Thứ tự CÓ '
  'CHỦ Ý: idempotency LOOKUP TRƯỚC MỌI THỨ (lần gọi lặp phải trả kết quả cũ ngay, '
  'không được ăn lỗi "kỳ đã khoá"/"hết hạn mức" cho thao tác đã hoàn tất) → org + '
  'membership → toà → quyền (ba key: admin, can_access_building, '
  'ie_all_buildings_scope) → sổ quỹ phải THẬT (chặn sổ ảo — mắt xích hay quên nhất, '
  'ghi tiền vào sổ ảo là báo két có tiền không có thật) → feature route evaluate '
  'ĐÚNG MỘT LẦN → ngày theo múi giờ tổ chức. CHỈ ĐỌC: việc claim idempotency là của '
  'writer. Lõi nội bộ, không cấp cho client.';

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='special_page_submit_context_v1';

  -- Idempotency LOOKUP phải đứng TRƯỚC kiểm quyền và trước feature route.
  IF position('canonical_write_operations' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Thiếu idempotency lookup. DỪNG.';
  END IF;
  IF position('canonical_write_operations' IN v_code)
     > position('evaluate_feature_route' IN v_code) THEN
    RAISE EXCEPTION 'Idempotency lookup nằm SAU feature route — gọi lặp sẽ ăn lỗi oan. DỪNG.';
  END IF;
  IF position('canonical_write_operations' IN v_code)
     > position('is_super_admin' IN v_code) THEN
    RAISE EXCEPTION 'Idempotency lookup nằm SAU kiểm quyền — gọi lặp sẽ ăn lỗi oan. DỪNG.';
  END IF;
  -- Phải chặn sổ ảo.
  IF position('is_virtual' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không chặn sổ ảo — tiền thật sẽ ghi vào sổ ghi nhận. DỪNG.';
  END IF;
  -- Không được dùng CURRENT_DATE.
  IF v_code ~ 'current_date' THEN
    RAISE EXCEPTION 'Còn dùng CURRENT_DATE — phải dùng org_today_v1. DỪNG.';
  END IF;
  -- KHÔNG được ghi gì (hàm này chỉ đọc).
  IF v_code ~ '\minsert\s+into\m' OR v_code ~ '\mupdate\s+public\.' OR v_code ~ '\mdelete\s+from\m' THEN
    RAISE EXCEPTION 'Context phải CHỈ ĐỌC — phát hiện lệnh ghi. DỪNG.';
  END IF;
  IF has_function_privilege('authenticated',
       'app_private.special_page_submit_context_v1(text,uuid,uuid,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Context đang gọi được từ client — REVOKE. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
