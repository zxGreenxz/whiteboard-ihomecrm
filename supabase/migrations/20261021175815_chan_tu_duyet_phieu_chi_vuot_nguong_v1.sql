-- ============================================================
-- Câu 25 (chủ chốt 21/10/2026): người lập KHÔNG tự duyệt phiếu chi vượt ngưỡng của chính mình.
--
-- CÂU HỎI VÀ ĐÁP ÁN
--   "Người lập phiếu chi có được tự duyệt phiếu vượt ngưỡng của chính mình?"
--   → a) Không: phiếu vượt ngưỡng phải người có quyền duyệt duyệt.
--   Phiếu dưới ngưỡng (600.000đ ở công ty thật) vẫn vào sổ ngay như cũ.
--
-- LỖ
--   Hai writer duyệt cũ — approve_income_expense_v1 và approve_voucher — cho qua khi
--   `user_id = auth.uid()` (người lập) mà không hỏi quyền income_expenses.approve. Cả hai
--   GRANT authenticated, và là bậc 2/3 của approve_pending_income_expense_checked_v1 (nút
--   Duyệt trên web). Nên người lập KHÔNG có quyền duyệt bấm Duyệt ở hộp chi tiết phiếu, hoặc
--   gọi REST thẳng, là duyệt được phiếu chi của mình kể cả khi phiếu sinh ra ở Chờ duyệt vì
--   tổng >= ngưỡng. Migration 20260915144703 đã cố ý giữ nhánh này chờ chủ quyết.
--
-- ĐO PRODUCTION (chỉ đọc, 22/10/2026; chỉ đếm, không chép tên/ID)
--   * Công ty thật: ngưỡng 600.000đ; 5 thành viên, chỉ 2 tài khoản vai chủ (Super Admin /
--     Chủ công ty) có income_expenses.approve; 3 tài khoản quản lý/vai riêng không có.
--   * 90 ngày: 0 lần người lập KHÔNG có quyền duyệt tự duyệt phiếu chi >= ngưỡng sau lúc lập
--     (01/06–20/07 có 11 phiếu, đa số hoa hồng; ca cuối 20/07). 60 phiếu chi >= ngưỡng do người lập CÓ quyền
--     duyệt tự duyệt (58 approve_and_post_income_expense_v2, 1 approve_income_expense_v2,
--     1 approve_voucher) — giữ nguyên.
--   * Đang chờ duyệt: 49 phiếu chi >= ngưỡng của hai người lập không có quyền duyệt — sau vá
--     họ không tự duyệt được nữa, người có quyền duyệt vẫn duyệt như cũ.
--   * Hai luồng nội bộ đi qua hai writer cũ dưới danh tính người bấm:
--       lock_salary_month_v1 (web lock_salary_month_v2 → rent_support_salary_lock_before_v2):
--         90 ngày 0 lần; cả đời 1 lần (07/2026, tài khoản Super Admin). Người có salary.lock
--         đều có income_expenses.approve phạm vi công ty.
--       pay_draft_fee_voucher (Thanh toán phiếu phí nháp): từ 30/07 (đầu nhật ký thay đổi) 0
--         lần; mọi phiếu định kỳ mẫu do tài khoản Super Admin lập.
--     ⇒ Cả hai vẫn chạy đúng bằng kiểm quyền thường: người chạy có quyền duyệt thì không bị
--       luật này chặn; người chạy KHÔNG có quyền duyệt mà là người lập phiếu >= ngưỡng thì bị
--       chặn (fail-closed, cả lượt ROLLBACK) — không mở ngữ cảnh hệ thống / cửa hậu nào.
--
-- VÁ
--   1. app_private.ie_self_approve_over_threshold_blocked_v1(p_voucher_id) — MỘT hàm luật dùng
--      chung (luật 17/10: quyền + tiền dùng >= 2 nơi đặt trong database). TRUE khi người gọi
--      (auth.uid()) là người lập, phiếu là CHI, tổng >= ngưỡng của công ty (cùng phép so với lúc
--      lập trong create_income_expense_v1), và người gọi KHÔNG có quyền duyệt: không super
--      admin, không income_expenses.approve ở toà của phiếu (phiếu không toà: không có ở phạm
--      vi nào — đúng phép hỏi SELF_APPROVER lúc lập). Chưa đặt ngưỡng ⇒ FALSE. Phiếu của người
--      khác ⇒ FALSE (luật chỉ nói về phiếu của chính mình). DEFINER vì đọc
--      app_private.ie_auto_approve_config; không cấp cho authenticated/anon/service_role.
--   2. approve_income_expense_v1, approve_voucher: hỏi hàm (1) ngay trước kiểm sổ quỹ/quyền,
--      chặn 42501 với câu báo cố định + HINT 'ie_self_approve_over_threshold' (mã máy đọc cho
--      Hermes/Copilot/web, cùng khuôn ie_system_only_manual_blocked). approve_voucher khoá dòng
--      (FOR UPDATE) trước khi hỏi để tổng tiền đọc được là bản câu UPDATE sẽ duyệt. Thân còn
--      lại giữ NGUYÊN từng chữ bản production (md5 10fdb43c… / b8529fc9…); chữ ký, kiểu trả về,
--      ACL không đổi (CREATE OR REPLACE).
--   3. public.ie_self_approve_gate_v1(p_voucher_id) — web hỏi trước để khoá nút Duyệt + giải
--      thích. Gọi đúng hàm (1); chỉ trả lời về phiếu của chính người gọi (phiếu người khác luôn
--      FALSE) nên không thành máy dò. GRANT authenticated.
--
-- ĐI QUA HÀM (1) — CÙNG MỘT LUẬT
--   web (approve_pending_income_expense_checked_v1 → v1 / approve_voucher), REST thẳng hai
--   writer, pay_draft_fee_voucher, lock_salary_month_v1, Copilot copilot_execute_ie_duyet_v1
--   (cổng Copilot vốn đòi income_expenses.approve). Hermes chưa có công cụ duyệt (ghi phiếu
--   chi đã tắt 21/10); công cụ duyệt sau này dùng chung hàm (1)/(3).
--
-- KHÔNG ĐỔI
--   approve_income_expense_v2 / approve_and_post_income_expense_v2 / set_termination_forfeit_
--   status_v1 / decide_financial_request (đã đòi quyền duyệt; engine cấm maker tự duyệt).
--   Người lập CÓ quyền duyệt vẫn tự duyệt (chủ chốt 25/07, giữ ở câu 05). Luật lúc lập (tự
--   duyệt dưới ngưỡng, SELF_APPROVER, bộ máy cam kết/trần, phí cố định, định kỳ tự duyệt, cặp
--   bỏ cọc trong thanh lý) không đổi. Phiếu chờ duyệt DƯỚI ngưỡng (hạng mục bắt buộc duyệt,
--   bộ máy chi, G6) — người lập vẫn tự duyệt được như cũ: ngoài câu 25, chờ chủ quyết riêng.
--   Không sửa dữ liệu.
--
-- ĐƯỜNG LÙI (một forward migration khác, không phá dữ liệu)
--   CREATE OR REPLACE public.approve_income_expense_v1 bằng thân mục 8 của
--   20260925080906_sua_phieu_cho_duyet.sql; CREATE OR REPLACE public.approve_voucher bằng thân
--   trong supabase/baseline/schema.sql; DROP FUNCTION public.ie_self_approve_gate_v1(uuid) và
--   app_private.ie_self_approve_over_threshold_blocked_v1(uuid) (web tự mở nút khi hàm cổng
--   vắng).
-- ============================================================

-- 0. Tiền kiểm — không vá mù lên một định nghĩa lạ.
DO $truoc$
DECLARE
  v_ham record;
  v_def text;
BEGIN
  IF to_regprocedure('public.can_do_on_building(text, text, uuid)') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('app_private.has_any_scope_v3(text)') IS NULL
     OR to_regprocedure('app_private.is_actor_offboarded_v1()') IS NULL
     OR to_regprocedure('app_private.assert_no_engine_request_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu helper quyền (can_do_on_building / is_super_admin / has_any_scope_v3 / is_actor_offboarded_v1 / assert_no_engine_request_v1) — DỪNG.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('app_private.ie_auto_approve_config') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_auto_approve_config — DỪNG.' USING ERRCODE = '55000';
  END IF;

  -- Thân đọc bằng pg_get_functiondef trên production 22/10/2026 (chỉ đọc), không có CR.
  -- PGlite tái lập đúng hai md5 này từ 20260925080906 (v1) và baseline (approve_voucher).
  FOR v_ham IN
    SELECT * FROM (VALUES
      ('public.approve_income_expense_v1(uuid)', '10fdb43c85df855db3ab9c26be7ee6e1'),
      ('public.approve_voucher(uuid)', 'b8529fc96ee1ba71f6af780f8dcc97b3')
    ) AS t(chu_ky, md5_da_ra)
  LOOP
    IF to_regprocedure(v_ham.chu_ky) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_ham.chu_ky USING ERRCODE = '55000';
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(v_ham.chu_ky));
    IF position('ie_self_approve_over_threshold_blocked_v1' IN v_def) > 0 THEN
      RAISE NOTICE '% đã vá câu 25 — replace lại bản y hệt.', v_ham.chu_ky;
    ELSIF md5(replace(v_def, chr(13), '')) <> v_ham.md5_da_ra THEN
      RAISE EXCEPTION '% KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
        v_ham.chu_ky, md5(v_def)
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- 1. Luật dùng chung.
CREATE OR REPLACE FUNCTION app_private.ie_self_approve_over_threshold_blocked_v1(p_voucher_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_ie record;
  v_threshold numeric;
BEGIN
  IF v_actor IS NULL OR p_voucher_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT ie.organization_id, ie.type, ie.user_id, ie.building_id, ie.total_amount
    INTO v_ie
    FROM public.income_expenses ie
   WHERE ie.id = p_voucher_id;
  -- Luật chỉ nói về phiếu CHI do CHÍNH người gọi lập.
  IF NOT FOUND
     OR v_ie.user_id IS DISTINCT FROM v_actor
     OR v_ie.type IS DISTINCT FROM 'EXPENSE' THEN
    RETURN false;
  END IF;

  -- Chưa đặt ngưỡng = mọi phiếu chi thường tự duyệt (t5_23) ⇒ không có "vượt ngưỡng".
  -- Cùng phép so với lúc lập (create_income_expense_v1): tổng >= ngưỡng là vượt.
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c
   WHERE c.organization_id = v_ie.organization_id;
  IF v_threshold IS NULL OR COALESCE(v_ie.total_amount, 0) < v_threshold THEN
    RETURN false;
  END IF;

  -- Người lập CÓ quyền duyệt vẫn tự duyệt (chủ chốt 25/07, giữ ở câu 05).
  IF public.is_super_admin() THEN
    RETURN false;
  END IF;
  IF v_ie.building_id IS NOT NULL THEN
    RETURN NOT COALESCE(public.can_do_on_building('income_expenses', 'approve', v_ie.building_id), false);
  END IF;
  -- Phiếu không gắn toà: income_expenses.approve khai required_dimensions=['BUILDING'],
  -- nên hỏi "có ở bất kỳ phạm vi nào" — đúng phép hỏi SELF_APPROVER lúc lập.
  RETURN NOT (COALESCE(app_private.has_any_scope_v3('income_expenses.approve'), false)
              AND NOT COALESCE(app_private.is_actor_offboarded_v1(), false));
END
$function$;

COMMENT ON FUNCTION app_private.ie_self_approve_over_threshold_blocked_v1(uuid) IS
  'Câu 25 (chủ chốt 21/10/2026): TRUE khi auth.uid() là người lập phiếu CHI có tổng >= ngưỡng tự duyệt của công ty mà không có quyền duyệt (không super admin, không income_expenses.approve ở toà của phiếu; phiếu không toà: ở bất kỳ phạm vi nào). Chưa đặt ngưỡng / phiếu thu / phiếu người khác ⇒ FALSE. Một luật cho mọi writer duyệt và cổng web.';

REVOKE ALL ON FUNCTION app_private.ie_self_approve_over_threshold_blocked_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- 2a. approve_income_expense_v1 — thân production + chặn câu 25 trước kiểm sổ quỹ/quyền.
CREATE OR REPLACE FUNCTION public.approve_income_expense_v1(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  -- Row legacy → tín hiệu fallback (hook chuyển sang approve_voucher legacy).
  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  if v_row.approval_status = 'APPROVED' then
    return; -- idempotent no-op
  end if;

  -- t5_26: phiếu đang chờ engine → chỉ quyết qua màn Chờ duyệt
  perform app_private.assert_no_engine_request_v1(v_row.id);

  if v_row.approval_status = 'CANCELLED' then
    -- Phương án A: phiếu huỷ là terminal — dùng nút "Tạo bản sao".
    raise exception 'Phiếu đã huỷ — không thể duyệt. Hãy dùng "Tạo bản sao" để lập phiếu mới.';
  end if;

  -- Câu 25 (chủ chốt 21/10/2026): phiếu CHI từ ngưỡng tự duyệt trở lên phải do người có
  -- quyền duyệt duyệt — người lập không có quyền duyệt không tự duyệt phiếu của mình.
  if app_private.ie_self_approve_over_threshold_blocked_v1(v_row.id) then
    raise exception 'Phiếu chi từ ngưỡng tự duyệt trở lên cần người có quyền duyệt thu chi duyệt — người lập phiếu không tự duyệt được.'
      using errcode = '42501', hint = 'ie_self_approve_over_threshold';
  end if;

  -- Parity legacy: phải có sổ quỹ trước khi duyệt.
  if v_row.account_id is null then
    raise exception 'Phiếu chưa có sổ quỹ — bấm Sửa phiếu, chọn sổ quỹ rồi mới duyệt được.';
  end if;

  -- Permission parity với public.approve_voucher.
  if not (
    v_row.user_id = v_actor
    or public.is_super_admin()
    or (v_row.building_id is not null
        and public.can_do_on_building('income_expenses', 'approve', v_row.building_id))
  ) then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'APPROVED');

  update public.income_expenses
     set approval_status = 'APPROVED',
         approved_by = v_actor,
         approved_at = now()
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'approve transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'APPROVED', v_actor, v_actor_name,
    v_row.approval_status, 'APPROVED', 'Duyệt qua approve_income_expense_v1');
end;
$function$;

-- 2b. approve_voucher — thân production + khoá dòng + chặn câu 25 trước kiểm sổ quỹ.
CREATE OR REPLACE FUNCTION public.approve_voucher(voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_rows integer;
  v_account uuid;
  v_exists boolean;
BEGIN
  -- t5_26: phiếu thuộc engine → chỉ duyệt qua màn Chờ duyệt
  PERFORM app_private.assert_no_engine_request_v1(voucher_id);

  -- Khoá dòng trước khi hỏi luật câu 25: tổng tiền / người lập đọc ở đây phải là bản mà
  -- câu UPDATE bên dưới duyệt (sửa phiếu chen giữa không lọt). Câu UPDATE vốn khoá đúng
  -- dòng này, nên thứ tự khoá không đổi.
  SELECT ie.account_id, true INTO v_account, v_exists
  FROM income_expenses ie
  WHERE ie.id = voucher_id AND ie.deleted_at IS NULL
  FOR UPDATE;

  -- Câu 25 (chủ chốt 21/10/2026): phiếu CHI từ ngưỡng tự duyệt trở lên phải do người có
  -- quyền duyệt duyệt — người lập không có quyền duyệt không tự duyệt phiếu của mình.
  IF v_exists AND app_private.ie_self_approve_over_threshold_blocked_v1(voucher_id) THEN
    RAISE EXCEPTION 'Phiếu chi từ ngưỡng tự duyệt trở lên cần người có quyền duyệt thu chi duyệt — người lập phiếu không tự duyệt được.'
      USING ERRCODE = '42501', HINT = 'ie_self_approve_over_threshold';
  END IF;

  IF v_exists AND v_account IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa có sổ quỹ — bấm Sửa phiếu, chọn sổ quỹ chi tiền rồi mới duyệt được'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE income_expenses ie
  SET
    approval_status = 'APPROVED',
    approved_by = auth.uid(),
    approved_at = NOW()
  WHERE ie.id = voucher_id
    AND ie.deleted_at IS NULL
    AND (
      ie.user_id = auth.uid()
      OR public.is_super_admin()
      OR (
        ie.building_id IS NOT NULL
        AND public.can_do_on_building('income_expenses', 'approve', ie.building_id)
      )
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- 3. Cổng cho web: khoá nút Duyệt + câu giải thích trước khi người lập bấm.
CREATE OR REPLACE FUNCTION public.ie_self_approve_gate_v1(p_voucher_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_blocked boolean;
  v_threshold numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  -- Hàm luật chỉ trả TRUE cho phiếu do chính auth.uid() lập; phiếu người khác hay phiếu
  -- không tồn tại đều FALSE ⇒ cổng không lộ gì ngoài phiếu của chính người gọi.
  v_blocked := COALESCE(app_private.ie_self_approve_over_threshold_blocked_v1(p_voucher_id), false);
  IF v_blocked THEN
    SELECT c.threshold INTO v_threshold
      FROM public.income_expenses ie
      JOIN app_private.ie_auto_approve_config c ON c.organization_id = ie.organization_id
     WHERE ie.id = p_voucher_id
       AND ie.user_id = auth.uid();
  END IF;

  RETURN jsonb_build_object(
    'voucherId', p_voucher_id,
    'selfApproveBlocked', v_blocked,
    'reason', CASE WHEN v_blocked THEN 'ie_self_approve_over_threshold' END,
    'threshold', v_threshold);
END
$function$;

COMMENT ON FUNCTION public.ie_self_approve_gate_v1(uuid) IS
  'Câu 25 (21/10/2026): web hỏi trước khi hiện nút Duyệt. selfApproveBlocked=true khi người gọi là người lập phiếu chi >= ngưỡng mà không có quyền duyệt (app_private.ie_self_approve_over_threshold_blocked_v1). Phiếu của người khác luôn false. Writer duyệt vẫn tự chặn — cổng chỉ để giải thích sớm.';

REVOKE ALL ON FUNCTION public.ie_self_approve_gate_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ie_self_approve_gate_v1(uuid) TO authenticated;

-- 4. Tự kiểm (chỉ catalog — chạy được trên database rỗng).
DO $sau$
DECLARE
  v_sig text;
  v_n int;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.approve_income_expense_v1(uuid)', 'public.approve_voucher(uuid)'] LOOP
    IF position('ie_self_approve_over_threshold_blocked_v1' IN pg_get_functiondef(v_sig::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% chưa hỏi luật câu 25', v_sig USING ERRCODE = '55000';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION '% phải SECURITY DEFINER', v_sig USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '% mất EXECUTE của authenticated (CREATE OR REPLACE phải giữ ACL)', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'app_private.ie_self_approve_over_threshold_blocked_v1(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'ie_self_approve_over_threshold_blocked_v1 phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'app_private.ie_self_approve_over_threshold_blocked_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.ie_self_approve_over_threshold_blocked_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated còn EXECUTE trên ie_self_approve_over_threshold_blocked_v1' USING ERRCODE = '55000';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.ie_self_approve_gate_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ie_self_approve_gate_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ie_self_approve_gate_v1 phải chỉ mở cho authenticated' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE (n.nspname, p.proname) IN (('public', 'approve_income_expense_v1'), ('public', 'approve_voucher'),
                                    ('public', 'ie_self_approve_gate_v1'),
                                    ('app_private', 'ie_self_approve_over_threshold_blocked_v1'));
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'Sai số overload (% thay vì 4) cho bốn hàm câu 25', v_n USING ERRCODE = '55000';
  END IF;
END
$sau$;
