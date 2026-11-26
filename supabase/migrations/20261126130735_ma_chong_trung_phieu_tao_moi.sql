-- Đợt 10a (plan sửa khoá vĩnh viễn sau rớt mạng): mã chống trùng cho hai đường TẠO MỚI còn thiếu.
--
-- VÌ SAO
--   Trình duyệt giữ một «dấu chờ đối chiếu» khi lần ghi chưa rõ kết quả (rớt mạng, mất phản hồi). Hai đường tạo dưới đây
--   chưa nhận mã yêu cầu, nên trình duyệt chỉ tra GẦN ĐÚNG (cùng người, cùng sổ/toà, tạo sau giờ kẹt) hoặc phải dừng ở hộp
--   cảnh báo. Có mã yêu cầu thì gửi lại cùng mã: máy chủ trả lại đúng kết quả đã lưu, không sinh bản ghi thứ hai.
--
-- NỘI DUNG (dựng từ THÂN ĐANG CHẠY trên production, đọc 26/11/2026 bằng pg_get_functiondef, chỉ đọc)
--   1. public.ie_compat_insert_keyed_v1(p_row, p_items, p_request_key) — HÀM MỚI bọc ngoài ie_compat_insert_v2.
--      ie_compat_insert_v2 KHÔNG bị thay (thân giữ nguyên từng byte, md5 prosrc 342adaf7…): trợ lý Hermes, phiếu cọc,
--      phí bảo trì và bundle trình duyệt cũ vẫn gọi đúng hàm đó như trước. Hàm mới: kiểm phiên → suy công ty y như
--      ie_compat_insert_v2 → kiểm thành viên → KHOÁ (công ty, người, mã) → giữ mã ở canonical_write_operations kèm băm nội
--      dung → cùng mã cùng nội dung đã xong thì trả lại kết quả đã lưu; khác nội dung thì 23505; đường chính
--      (create_income_expense_v1) đã ghi xong với đúng mã này cho cùng người, cùng toà thì 23505 kèm mã phiếu → mới gọi
--      ie_compat_insert_v2 → lưu kết quả. Giữ mã, ghi phiếu và lưu kết quả cùng một giao dịch.
--   2. public.get_own_compat_inserts_v1(p_organization_id, p_request_keys[]) — HÀM MỚI chỉ đọc: với từng mã yêu cầu, mã
--      phiếu mà CHÍNH người gọi đã lập qua hàm 1 (như get_own_deposit_income_v1 của phiếu cọc). Trình duyệt dùng để đối
--      chiếu đúng từng dòng nhập Excel / từng phiếu con của phiếu tổng / phiếu của form, không cần quyền đọc phiếu và không
--      phải dựng lại nội dung để gửi lại. Chỉ trả mã phiếu, không trả nội dung.
--   3. public.propose_reconciliation(…, p_request_key DEFAULT NULL) — THAY hàm 5 tham số (md5 prosrc 8fc864e0…) bằng hàm
--      6 tham số. Không truyền mã ⇒ chạy đúng từng câu của thân cũ (chỉ thêm hai phép thử `v_key IS NOT NULL`). Phải
--      DROP rồi CREATE: CREATE OR REPLACE với danh sách tham số khác sẽ để lại hai bản trùng tên và PostgREST không chọn
--      được bản nào. ACL cấp lại đúng như cũ (authenticated, service_role).
--
-- TƯƠNG THÍCH NGƯỢC
--   Bundle cũ gọi propose_reconciliation bằng năm tham số có tên ⇒ khớp bản mới (tham số thứ sáu có DEFAULT). Không đổi
--   kiểu trả về. Không đổi bảng, không xoá dữ liệu, không thêm cột. Phần không lùi được: không có (restore từ bản dump của
--   lane đưa ba hàm về trạng thái trước).
--
-- AN TOÀN CHẠY LẠI: khối $requires$ nhận đúng hai trạng thái cho propose_reconciliation (bản 5 tham số của production, hoặc
-- bản 6 tham số của chính tệp này ở lượt hai); hai hàm mới là CREATE OR REPLACE; DROP dùng IF EXISTS.

DO $requires$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('app_private.canonical_write_operations') IS NULL
     OR to_regprocedure('app_private.ie_compat_actor_v2(uuid)') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.sandbox_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regclass('public.income_expenses') IS NULL
     OR to_regclass('public.accounts') IS NULL
     OR to_regclass('public.cashbook_reconciliations') IS NULL THEN
    RAISE EXCEPTION 'ma_chong_trung_phieu_tao_moi: thiếu nền (bảng giữ mã, hàm thành viên hoặc bảng phiếu)' USING ERRCODE = '55000';
  END IF;

  -- ie_compat_insert_v2 KHÔNG bị thay, nhưng hàm bọc chép cách suy công ty và dựa vào phiếu trả về {id, approval_status}:
  -- thân đổi thì dừng để rà lại hàm bọc.
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.ie_compat_insert_v2(jsonb,jsonb)');
  IF v_md5 IS DISTINCT FROM '342adaf725191f931739db5ef8c54620' THEN
    RAISE EXCEPTION 'ie_compat_insert_v2 KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', v_md5 USING ERRCODE = '55000';
  END IF;

  -- propose_reconciliation: [thân production 5 tham số, thân của chính tệp này 6 tham số (lượt hai)].
  IF to_regprocedure('public.propose_reconciliation(uuid,date,numeric,uuid,text)') IS NOT NULL THEN
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.propose_reconciliation(uuid,date,numeric,uuid,text)');
    IF v_md5 IS DISTINCT FROM '8fc864e0c24e2809cb5ef9fa3b67de66' THEN
      RAISE EXCEPTION 'propose_reconciliation (5 tham số) KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', v_md5 USING ERRCODE = '55000';
    END IF;
    IF to_regprocedure('public.propose_reconciliation(uuid,date,numeric,uuid,text,text)') IS NOT NULL THEN
      RAISE EXCEPTION 'propose_reconciliation đang có cả bản 5 lẫn 6 tham số — DỪNG' USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.propose_reconciliation(uuid,date,numeric,uuid,text,text)');
    IF v_md5 IS DISTINCT FROM 'a264d586a81778bbeaab4ee60bca50c9' THEN
      RAISE EXCEPTION 'propose_reconciliation không ở bản 5 tham số đã rà, cũng không ở bản của tệp này (md5 %) — DỪNG', v_md5 USING ERRCODE = '55000';
    END IF;
  END IF;
END
$requires$;

-- ── 1. Lập phiếu thu chi qua đường compat, có mã chống trùng ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ie_compat_insert_keyed_v1(p_row jsonb, p_items jsonb, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_actor   uuid := auth.uid();
  v_key     text := btrim(p_request_key);
  v_items   jsonb := coalesce(p_items, '[]'::jsonb);
  v_org     uuid;
  v_member  record;
  v_scope   text;
  v_hash    text;
  v_op      app_private.canonical_write_operations%ROWTYPE;
  v_main    app_private.canonical_write_operations%ROWTYPE;
  v_result  jsonb;
  v_id      uuid;
  v_id_org  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key IS NULL OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'p_request_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -' USING ERRCODE = '22023';
  END IF;
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'p_row phải là object' USING ERRCODE = '22023';
  END IF;
  -- Nhánh bản nháp của trợ lý Hermes có dấu dùng một lần riêng, không đi qua hàm này.
  IF nullif(btrim(coalesce(p_row ->> 'copilot_draft_marker', '')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Bản nháp của trợ lý không lập qua mã yêu cầu' USING ERRCODE = '22023';
  END IF;

  -- Suy công ty ĐÚNG như nhánh người gọi thường của ie_compat_insert_v2 (sổ → toà → organization_id → thành viên).
  v_org := COALESCE(
    (SELECT a.organization_id
       FROM public.accounts a
      WHERE a.id = (p_row ->> 'account_id')::uuid),
    (SELECT b.organization_id
       FROM public.buildings b
      WHERE b.id = (p_row ->> 'building_id')::uuid),
    (p_row ->> 'organization_id')::uuid);
  IF v_org IS NULL THEN
    SELECT m.organization_id INTO v_org
      FROM public.organization_memberships m
     WHERE m.user_id = auth.uid()
       AND m.status = 'ACTIVE'
     LIMIT 1;
  END IF;

  SELECT * INTO v_member FROM app_private.ie_compat_actor_v2(v_org);
  IF v_member.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- KHOÁ trước khi đọc mã: lệnh thứ hai cùng mã (tab khác, bấm lại khi lệnh cũ còn treo) chờ lệnh đầu xong.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ie_compat_insert_keyed_v1:' || v_org::text || ':' || v_actor::text || ':' || v_key, 0));

  v_scope := v_org::text;
  v_hash := md5(jsonb_build_object('row', p_row, 'items', v_items)::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, actor_membership_id,
    idempotency_key, payload_hash, transaction_id
  ) VALUES (
    v_org, 'income_expense.compat_insert.v1', v_scope, v_actor, v_member.membership_id,
    v_key, v_hash, pg_current_xact_id()
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;

  SELECT * INTO v_op
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = 'income_expense.compat_insert.v1'
     AND o.subject_scope = v_scope
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không nhận diện được mã yêu cầu vừa giữ' USING ERRCODE = '55000';
  END IF;
  IF v_op.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác'
      USING ERRCODE = '23505', DETAIL = coalesce(v_op.subject_id::text, ''), HINT = 'ie_request_key_payload_mismatch';
  END IF;
  IF v_op.completed_at IS NOT NULL THEN
    RETURN v_op.response_payload || jsonb_build_object('replayed', true);
  END IF;

  -- Mã này đã được đường chính (create_income_expense_v1: thao tác income_expense.create_draft.v1, phạm vi = toà) dùng và
  -- ghi xong cho cùng người: phiếu đã có. Claim của đường chính chỉ còn khi giao dịch của nó đã commit cùng phiếu.
  SELECT * INTO v_main
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = 'income_expense.create_draft.v1'
     AND o.subject_scope = (nullif(p_row ->> 'building_id', ''))::uuid::text
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
     AND o.completed_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'Mã yêu cầu đã được dùng ở đường ghi chính: phiếu đã được lập'
      USING ERRCODE = '23505', DETAIL = v_main.subject_id::text, HINT = 'ie_request_key_used_by_canonical';
  END IF;

  v_result := public.ie_compat_insert_v2(p_row, v_items);
  v_id := nullif(v_result ->> 'id', '')::uuid;
  SELECT ie.organization_id INTO v_id_org FROM public.income_expenses ie WHERE ie.id = v_id;
  IF v_id IS NULL OR v_id_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Phiếu vừa lập không khớp công ty của mã yêu cầu' USING ERRCODE = '55000';
  END IF;

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_id,
         response_payload = v_result,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = 'income_expense.compat_insert.v1'
     AND subject_scope = v_scope
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.ie_compat_insert_keyed_v1(jsonb, jsonb, text) IS
  'ie_compat_insert_v2 with a caller request key: same key and payload replays the stored receipt, a different payload or a completed create_income_expense_v1 claim with the same key raises 23505.';
REVOKE ALL ON FUNCTION public.ie_compat_insert_keyed_v1(jsonb, jsonb, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ie_compat_insert_keyed_v1(jsonb, jsonb, text) TO authenticated;

-- ── 2. Tra phiếu của chính mình theo mã yêu cầu (chỉ đọc) ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_own_compat_inserts_v1(p_organization_id uuid, p_request_keys text[])
 RETURNS TABLE(voucher_id uuid, request_key text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT o.subject_id, o.idempotency_key
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = p_organization_id
     AND o.operation = 'income_expense.compat_insert.v1'
     AND o.subject_scope = p_organization_id::text
     AND o.actor_id = auth.uid()
     AND o.idempotency_key = ANY(p_request_keys)
     AND o.completed_at IS NOT NULL
     AND p_organization_id = ANY(public.my_org_ids())
     AND NOT (public.is_super_admin() AND p_organization_id = ANY(public.sandbox_org_ids()))
$function$;

COMMENT ON FUNCTION public.get_own_compat_inserts_v1(uuid, text[]) IS
  'For each request key: the voucher id created by the calling user through ie_compat_insert_keyed_v1. Keys without a completed voucher are absent.';
REVOKE ALL ON FUNCTION public.get_own_compat_inserts_v1(uuid, text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_own_compat_inserts_v1(uuid, text[]) TO authenticated;

-- ── 3. Đề nghị đối soát sổ nhận mã yêu cầu tuỳ chọn ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.propose_reconciliation(uuid, date, numeric, uuid, text);

CREATE OR REPLACE FUNCTION public.propose_reconciliation(p_account_id uuid, p_as_of date, p_counted_balance numeric, p_counterparty_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_request_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_sys      numeric;
  v_status   text;
  v_cp       uuid;      -- counterparty thực sự lưu
  v_id       uuid;
  v_is_boss  boolean;
  -- Đợt 10a: mã yêu cầu tuỳ chọn. NULL ⇒ đi nguyên đường cũ.
  v_key      text := NULLIF(btrim(p_request_key), '');
  v_org      uuid;
  v_hash     text;
  v_op       app_private.canonical_write_operations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT user_id INTO v_owner FROM accounts WHERE id = p_account_id AND deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ'; END IF;

  -- Quyền đối soát: chủ sổ / super admin / đồng đội của chủ sổ.
  IF NOT (v_owner = auth.uid() OR public.is_super_admin() OR public.same_team(v_owner)) THEN
    RAISE EXCEPTION 'Bạn không có quyền đối soát sổ này';
  END IF;

  -- Đợt 10a: có mã yêu cầu ⇒ khoá theo sổ, giữ mã kèm băm nội dung; cùng mã cùng nội dung đã xong ⇒ trả kết quả đã lưu.
  IF v_key IS NOT NULL THEN
    IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
      RAISE EXCEPTION 'p_request_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -' USING ERRCODE = '22023';
    END IF;
    SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id = p_account_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ chưa gắn công ty' USING ERRCODE = '55000';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'cashbook.reconciliation.propose.v1:' || p_account_id::text, 0));
    v_hash := md5(jsonb_build_object('account', p_account_id, 'as_of', p_as_of, 'counted', p_counted_balance,
      'counterparty', p_counterparty_id, 'note', NULLIF(btrim(p_note), ''))::text);
    INSERT INTO app_private.canonical_write_operations (
      organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, transaction_id
    ) VALUES (
      v_org, 'cashbook.reconciliation.propose.v1', p_account_id::text, auth.uid(), v_key, v_hash, pg_current_xact_id()
    )
    ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;
    SELECT * INTO v_op
      FROM app_private.canonical_write_operations o
     WHERE o.organization_id = v_org
       AND o.operation = 'cashbook.reconciliation.propose.v1'
       AND o.subject_scope = p_account_id::text
       AND o.actor_id = auth.uid()
       AND o.idempotency_key = v_key
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Không nhận diện được mã yêu cầu vừa giữ' USING ERRCODE = '55000';
    END IF;
    IF v_op.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác'
        USING ERRCODE = '23505', DETAIL = coalesce(v_op.subject_id::text, ''), HINT = 'reconciliation_request_key_payload_mismatch';
    END IF;
    IF v_op.completed_at IS NOT NULL THEN
      RETURN v_op.response_payload || jsonb_build_object('replayed', true);
    END IF;
  END IF;

  -- Số dư hệ thống TÍNH ĐẾN NGÀY as_of (khớp nhãn as_of_date). Bằng
  -- current_amount khi as_of = hôm nay. Bao gồm cả điều chỉnh thối/làm tròn.
  SELECT COALESCE(a.initial_amount, 0)
       + COALESCE((SELECT sum(ie.total_amount) FROM income_expenses ie
                    WHERE ie.account_id = a.id AND ie.type = 'INCOME'
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       - COALESCE((SELECT sum(ie.total_amount) FROM income_expenses ie
                    WHERE ie.account_id = a.id AND ie.type = 'EXPENSE'
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       + COALESCE((SELECT sum(ie.change_amount) FROM income_expenses ie
                    WHERE ie.change_account_id = a.id
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
       + COALESCE((SELECT sum(ie.rounding_amount) FROM income_expenses ie
                    WHERE ie.rounding_account_id = a.id
                      AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
                      AND ie.voucher_date <= p_as_of), 0)
    INTO v_sys
    FROM accounts a WHERE a.id = p_account_id;
  v_sys := COALESCE(v_sys, 0);

  v_is_boss := (v_owner = auth.uid() OR public.is_super_admin());

  -- Xác định trạng thái + người xác nhận:
  IF p_counterparty_id IS NOT NULL AND p_counterparty_id <> auth.uid() THEN
    v_status := 'PENDING'; v_cp := p_counterparty_id;              -- có người đối ứng rõ ràng
  ELSIF v_is_boss THEN
    v_status := 'CONFIRMED'; v_cp := NULL;                         -- chủ/super tự chốt
  ELSE
    v_status := 'PENDING'; v_cp := v_owner;                        -- đồng đội đề xuất → CHỦ xác nhận
  END IF;

  INSERT INTO cashbook_reconciliations
    (account_id, as_of_date, system_balance, counted_balance, diff, status, note,
     proposed_by, counterparty_id, confirmed_by, confirmed_at)
  VALUES
    (p_account_id, p_as_of, v_sys, COALESCE(p_counted_balance, v_sys),
     COALESCE(p_counted_balance, v_sys) - v_sys, v_status, NULLIF(btrim(p_note), ''),
     auth.uid(), v_cp,
     CASE WHEN v_status = 'CONFIRMED' THEN auth.uid() END,
     CASE WHEN v_status = 'CONFIRMED' THEN now() END)
  RETURNING id INTO v_id;

  -- Đợt 10a: lưu kết quả cho mã yêu cầu, cùng giao dịch với dòng đối soát.
  IF v_key IS NOT NULL THEN
    UPDATE app_private.canonical_write_operations
       SET subject_id = v_id,
           response_payload = jsonb_build_object('id', v_id, 'status', v_status,
                                                 'system_balance', v_sys,
                                                 'diff', COALESCE(p_counted_balance, v_sys) - v_sys),
           completed_at = clock_timestamp()
     WHERE organization_id = v_org
       AND operation = 'cashbook.reconciliation.propose.v1'
       AND subject_scope = p_account_id::text
       AND actor_id = auth.uid()
       AND idempotency_key = v_key;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'status', v_status,
                            'system_balance', v_sys,
                            'diff', COALESCE(p_counted_balance, v_sys) - v_sys);
END;
$function$;

REVOKE ALL ON FUNCTION public.propose_reconciliation(uuid, date, numeric, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_reconciliation(uuid, date, numeric, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.propose_reconciliation(uuid, date, numeric, uuid, text, text) TO authenticated;

-- ── Hậu kiểm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $hau_kiem$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.ie_compat_insert_keyed_v1(jsonb,jsonb,text)', 'fafe4725225e43f7198f6143558bbedd', false),
      ('public.get_own_compat_inserts_v1(uuid,text[])', '336c87ce66829951e117bd0af50e8cc4', false),
      ('public.propose_reconciliation(uuid,date,numeric,uuid,text,text)', 'a264d586a81778bbeaab4ee60bca50c9', true),
      ('public.ie_compat_insert_v2(jsonb,jsonb)', '342adaf725191f931739db5ef8c54620', false)
    ) AS v(fn, file_md5, service_role_ok) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.file_md5 THEN
      RAISE EXCEPTION 'ma_chong_trung_phieu_tao_moi: % sau áp khác thân của tệp (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn, 'EXECUTE')
       OR has_function_privilege('anon', r.fn, 'EXECUTE')
       OR has_function_privilege('service_role', r.fn, 'EXECUTE') IS DISTINCT FROM r.service_role_ok
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn) AND p.prosecdef) THEN
      RAISE EXCEPTION 'ma_chong_trung_phieu_tao_moi: % sai ACL hoặc không còn SECURITY DEFINER', r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'propose_reconciliation') <> 1 THEN
    RAISE EXCEPTION 'ma_chong_trung_phieu_tao_moi: propose_reconciliation phải còn đúng một bản' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('ie_compat_insert_v2', 'ie_compat_insert_keyed_v1', 'get_own_compat_inserts_v1')) <> 3 THEN
    RAISE EXCEPTION 'ma_chong_trung_phieu_tao_moi: số bản của ba hàm phiếu compat sai' USING ERRCODE = '55000';
  END IF;
END
$hau_kiem$;
