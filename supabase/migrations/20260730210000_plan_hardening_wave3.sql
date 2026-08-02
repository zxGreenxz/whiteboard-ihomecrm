-- =====================================================================
-- SIẾT PLAN — đợt 3: chữa hai lỗi làm Đợt 6 BẤT KHẢ DỤNG, và trả lại hai
-- gạch đầu dòng của plan mà bản Đợt 6 bỏ sót.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. [CHẾT CỬA] Hàm STABLE + authorize_tenant_action_v3 = 25006 qua PostgREST
--
-- PostgREST chạy hàm khai IMMUTABLE/STABLE trong transaction READ ONLY. Mà
-- app_private.authorize_tenant_action_v3 có `SELECT … FOR SHARE` trên
-- organizations (khoá dòng để quyết định phân quyền ổn định). Khoá dòng trong
-- transaction read-only là lỗi cứng:
--     25006 cannot execute SELECT FOR SHARE in a read-only transaction
-- Đã tái hiện thật bằng SET LOCAL transaction_read_only = on.
--
-- ⇒ Mọi hàm ĐỌC có gọi authz phải khai VOLATILE. Đây là lý do chúng "im lặng
--   không chạy" trên trình duyệt trong khi gọi trực tiếp bằng SQL thì tốt.
--
-- Trớ trêu: can_reverse_collection_v1 bản ĐẦU không gọi authz nên vẫn sống;
-- chính bản vá đợt 2 (thêm kiểm thu_tien.undo cho đúng sự thật) đã giết nó.
-- can_flex_cancel_v1 của Đợt 4 thì chết từ đầu, không ai phát hiện vì chưa màn
-- hình nào import.
--
-- VOLATILE không nới lỏng gì về bảo mật — nó chỉ nói với planner "đừng cache",
-- và là khai báo ĐÚNG cho bất cứ hàm nào có lấy khoá dòng.
-- ─────────────────────────────────────────────────────────────────────
DO $vol$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'cashbook_closing_blockers_v1', 'cashbook_close_confirmers_v1',
        'can_reverse_collection_v1', 'can_flex_cancel_v1')
      AND p.provolatile <> 'v'
  LOOP
    EXECUTE format('ALTER FUNCTION %s VOLATILE', r.sig);
    v_n := v_n + 1;
    RAISE NOTICE 'ALTER FUNCTION % VOLATILE (khoá dòng trong hàm STABLE = 25006 qua PostgREST)', r.proname;
  END LOOP;
  RAISE NOTICE 'Đã chuyển % hàm sang VOLATILE', v_n;
END
$vol$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. [CHẾT CỬA] cashbook_balance_as_of_v1 ném 42501 cho MỌI người
--
-- Bản Đợt 6 gọi assert_cashbook_access_v2(v_org, p_cashbook, 'KNOWER', NULL) —
-- truyền p_membership = NULL. Hàm đó KHÔNG tự tra membership khi nhận NULL, nó
-- kết luận luôn 'membership inactive or cross-tenant'. Đã chạy thật bằng chính
-- CUSTODIAN của sổ: 42501.
--
-- Hệ quả: cả hai hộp thoại chốt sổ luôn hiện số dư "—", và chốt chặn "sổ đã
-- trôi kể từ lúc đề nghị" của người ký bị vô hiệu hoá vĩnh viễn — tức là mất
-- đúng hàng rào quan trọng nhất của bước ký.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cashbook_balance_as_of_v1(p_cashbook uuid, p_as_of date DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid;
  v_membership uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id = p_cashbook;
  IF v_org IS NULL THEN RETURN NULL; END IF;

  IF public.is_super_admin() THEN
    RETURN app_private.cashbook_balance_as_of_v1(p_cashbook, COALESCE(p_as_of, CURRENT_DATE));
  END IF;

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
   LIMIT 1;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của sổ quỹ' USING ERRCODE = '42501';
  END IF;

  -- Doctrine lỗ hổng C (Đợt 0): hàm tổng hợp SECURITY DEFINER phải tự giới hạn
  -- phạm vi nhìn. Dùng ĐÚNG helper mà Đợt 0 đã lập cho việc này —
  -- assert_cashbook_access_v2(...,'KNOWER',...) KHÔNG dùng được ở đây vì nó so
  -- possession_kind CHÍNH XÁC, nên người đang GIỮ sổ (CUSTODIAN) lại trượt.
  IF NOT EXISTS (SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v
                  WHERE v.cashbook_id = p_cashbook) THEN
    RAISE EXCEPTION 'Không có quyền xem sổ quỹ này' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.cashbook_balance_as_of_v1(p_cashbook, COALESCE(p_as_of, CURRENT_DATE));
END
$fn$;

REVOKE ALL ON FUNCTION public.cashbook_balance_as_of_v1(uuid, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_balance_as_of_v1(uuid, date) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Ba hàm đọc của Đợt 6 phải giới hạn theo PHẠM VI NHÌN SỔ, không chỉ tổ chức
-- Cùng doctrine lỗ hổng C. cashbook_closing_blockers_v1 phơi số phiếu chờ duyệt
-- / chưa ghi sổ của mọi sổ; list_cashbook_closings_v1 phơi tên sổ, số thực đếm
-- và chênh lệch quỹ; cashbook_close_confirmers_v1 phơi ai được ký khoá kỳ.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.can_see_cashbook_v1(p_org uuid, p_cashbook uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF public.is_super_admin() THEN RETURN true; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                  WHERE m.user_id = auth.uid() AND m.organization_id = p_org
                    AND m.status = 'ACTIVE') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v
                  WHERE v.cashbook_id = p_cashbook);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.can_see_cashbook_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Trả lại hai gạch của plan mà Đợt 6 bỏ sót:
--    "lập phiếu chênh lệch ngoài KQKD" + "assert số dư as-of = số đã đếm"
--
-- Bản cũ ghi biên bản với counted <> system rồi đóng băng luôn — sổ vĩnh viễn
-- mang một con số mà không bút toán nào giải thích, trong một kỳ không ai mở
-- lại được. Nay: chênh bao nhiêu thì lập ĐÚNG một phiếu điều chỉnh ngoài KQKD
-- cho bằng, rồi ASSERT số dư đúng bằng số hai bên đã đếm — sai thì RAISE.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.ensure_cash_diff_type_v1(p_org uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_name text := CASE WHEN p_kind = 'income' THEN 'Thừa quỹ khi chốt sổ' ELSE 'Thiếu quỹ khi chốt sổ' END;
  v_user uuid;
BEGIN
  SELECT t.id INTO v_id FROM public.income_expense_types t
   WHERE t.organization_id = p_org AND lower(t.type) = p_kind
     AND lower(btrim(t.name)) = lower(v_name) LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT m.user_id INTO v_user FROM public.organization_memberships m
   WHERE m.organization_id = p_org AND m.status = 'ACTIVE' LIMIT 1;

  INSERT INTO public.income_expense_types
    (organization_id, user_id, name, type, description, is_default, is_deposit, hide_in_report)
  VALUES (p_org, v_user, v_name, p_kind,
          'Chênh lệch giữa tiền đếm được và sổ khi chốt & bàn giao quỹ', false, false, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.ensure_cash_diff_type_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_cashbook_closing_v1(
  p_request uuid,
  p_counted_balance numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  r app_private.cashbook_closure_requests%ROWTYPE;
  v_membership uuid;
  v_system numeric;
  v_blockers text;
  v_closure bigint;
  v_after numeric;
  v_diff numeric;
  v_type uuid;
  v_bld uuid;
  v_adj uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT * INTO r FROM app_private.cashbook_closure_requests
   WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đề nghị' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Đề nghị này đã % rồi', lower(r.status) USING ERRCODE = '23505';
  END IF;

  IF v_actor = r.proposed_by THEN
    RAISE EXCEPTION 'Người đề nghị không tự xác nhận được — phải là người nhận bàn giao.'
      USING ERRCODE = '42501';
  END IF;
  IF v_actor <> r.confirmer_user_id AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Đề nghị này được gửi cho người khác xác nhận' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id = r.cashbook_id FOR UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(r.organization_id);

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = r.organization_id AND m.status = 'ACTIVE' LIMIT 1;

  IF NOT public.is_super_admin()
     AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
       v_actor, r.organization_id, 'cashbooks.close_confirm', NULL, r.cashbook_id)), false) THEN
    RAISE EXCEPTION 'Không có quyền xác nhận nhận bàn giao' USING ERRCODE = '42501';
  END IF;

  -- Chạy lại blockers, fail cứng. Loại hai mã vô nghĩa ở phía người ký:
  -- CLOSURE_PENDING chính là cái sắp ký; NO_CONFIRMER đếm người KHÁC người đang
  -- hỏi nên người ký duy nhất sẽ tự chặn chính mình.
  SELECT string_agg(b.detail, ' | ') INTO v_blockers
  FROM public.cashbook_closing_blockers_v1(r.cashbook_id) b
  WHERE b.blocking AND b.code NOT IN ('CLOSURE_PENDING', 'NO_CONFIRMER');
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Không xác nhận được, sổ đã đổi kể từ lúc đề nghị: %', v_blockers
      USING ERRCODE = '55000';
  END IF;

  v_system := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_system <> r.system_balance THEN
    RAISE EXCEPTION
      'Số dư hệ thống đã đổi từ % thành % kể từ lúc đề nghị — huỷ đề nghị và đếm lại.',
      r.system_balance, v_system USING ERRCODE = '40001';
  END IF;
  IF p_counted_balance IS NULL OR p_counted_balance = 'NaN'::numeric
     OR round(p_counted_balance, 2) <> r.counted_balance THEN
    RAISE EXCEPTION
      'Số tiền bạn đếm (%) khác số người giao khai (%) — hai bên phải đếm lại cùng nhau.',
      round(COALESCE(p_counted_balance, 0), 2), r.counted_balance USING ERRCODE = '22023';
  END IF;

  -- ── PHIẾU CHÊNH LỆCH (plan Đợt 6) ────────────────────────────────
  -- Đếm được nhiều hơn sổ ⇒ THỪA quỹ ⇒ phiếu THU. Ít hơn ⇒ THIẾU ⇒ phiếu CHI.
  -- Ngoài KQKD để không đụng vào số đã chia cho cổ đông.
  -- Lập TRƯỚC khi ghi biên bản: lúc này kỳ chưa đóng nên trigger khoá cho qua.
  v_diff := round(r.counted_balance - v_system, 2);
  IF v_diff <> 0 THEN
    SELECT a.quick_default_building_id INTO v_bld FROM public.accounts a WHERE a.id = r.cashbook_id;
    IF v_bld IS NULL THEN
      SELECT b.id INTO v_bld FROM public.buildings b
       WHERE b.organization_id = r.organization_id AND b.deleted_at IS NULL
       ORDER BY b.created_at LIMIT 1;
    END IF;
    IF v_bld IS NULL THEN
      RAISE EXCEPTION 'Không tìm được toà để ghi phiếu chênh lệch — không chốt được sổ lệch.'
        USING ERRCODE = '55000';
    END IF;

    v_type := app_private.ensure_cash_diff_type_v1(
      r.organization_id, CASE WHEN v_diff > 0 THEN 'income' ELSE 'expense' END);

    INSERT INTO public.income_expenses
      (user_id, organization_id, type, name, building_id, account_id, voucher_date,
       total_amount, approval_status, approved_by, approved_at,
       business_result_accounting, creator_name, system_source, notes)
    VALUES
      (v_actor, r.organization_id,
       CASE WHEN v_diff > 0 THEN 'INCOME' ELSE 'EXPENSE' END,
       CASE WHEN v_diff > 0 THEN 'Thừa quỹ khi chốt sổ' ELSE 'Thiếu quỹ khi chốt sổ' END,
       v_bld, r.cashbook_id, r.closed_through, abs(v_diff), 'APPROVED', v_actor, clock_timestamp(),
       false, 'Chốt sổ & bàn giao quỹ', 'cashbook.closing.diff',
       'Chênh lệch kiểm quỹ khi chốt & bàn giao (đếm ' || r.counted_balance ||
       ' / sổ ' || v_system || ').')
    RETURNING id INTO v_adj;

    INSERT INTO public.income_expense_items
      (income_expense_id, organization_id, income_expense_type_id, description,
       quantity, unit_price, amount, start_date, end_date)
    VALUES (v_adj, r.organization_id, v_type,
            CASE WHEN v_diff > 0 THEN 'Thừa quỹ khi chốt sổ' ELSE 'Thiếu quỹ khi chốt sổ' END,
            1, abs(v_diff), abs(v_diff), r.closed_through, r.closed_through);
  END IF;

  -- HẬU ĐIỀU KIỆN: số dư as-of PHẢI đúng bằng số hai bên đã đếm và ký.
  v_after := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_after <> r.counted_balance THEN
    RAISE EXCEPTION
      'Sau khi lập phiếu chênh lệch, số dư sổ (%) vẫn khác số đã đếm (%) — DỪNG, không đóng băng con số sai.',
      v_after, r.counted_balance USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.cashbook_closures
    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,
     basis, proposed_by, confirmed_by)
  VALUES
    (r.organization_id, r.cashbook_id, r.closed_through, r.counted_balance, v_system,
     r.basis, r.proposed_by, v_actor)
  RETURNING id INTO v_closure;

  UPDATE app_private.cashbook_closure_requests
     SET status = 'CONFIRMED', confirmed_by = v_actor, confirmed_at = now(),
         closure_id = v_closure
   WHERE id = p_request;

  IF app_private.cashbook_closed_through_v1(r.cashbook_id) IS DISTINCT FROM r.closed_through
     AND app_private.cashbook_closed_through_v1(r.cashbook_id) < r.closed_through THEN
    RAISE EXCEPTION 'Ghi biên bản xong nhưng kỳ chưa đóng — dừng lại' USING ERRCODE = '55000';
  END IF;

  UPDATE public.accounts
     SET lock_date = GREATEST(COALESCE(lock_date, r.closed_through), r.closed_through)
   WHERE id = r.cashbook_id;

  RETURN jsonb_build_object(
    'request_id', p_request,
    'closure_id', v_closure,
    'cashbook_id', r.cashbook_id,
    'closed_through', r.closed_through,
    'counted_balance', r.counted_balance,
    'system_balance', v_system,
    'difference', v_diff,
    'difference_voucher_id', v_adj,
    'basis', r.basis,
    'status', 'CONFIRMED'
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.confirm_cashbook_closing_v1(uuid, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_cashbook_closing_v1(uuid, numeric) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5. propose: chặn số tiền không hữu hạn
-- Bản cũ chỉ kiểm IS NULL. 'NaN'::numeric đi lọt và nằm vĩnh viễn trong biên
-- bản append-only, làm mọi phép so sánh về sau thành false.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text := '  IF p_counted_balance IS NULL THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'propose_cashbook_closing_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có propose_cashbook_closing_v1'; END IF;
  IF position('''NaN''::numeric' IN v_def) > 0 THEN
    RAISE NOTICE 'propose_cashbook_closing_v1 đã chặn NaN — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong propose_cashbook_closing_v1 — DỪNG';
  END IF;
  -- CẨN THẬN: numeric của Postgres KHÁC float — `'NaN'::numeric = 'NaN'::numeric`
  -- trả về TRUE (NaN được coi là bằng chính nó để sort/so sánh được). Nên phép
  -- thử `x = x` KHÔNG bắt được NaN; phải so thẳng với 'NaN'::numeric.
  v_def := replace(v_def, v_anchor,
    '  IF p_counted_balance = ''NaN''::numeric THEN' || chr(10) ||
    '    RAISE EXCEPTION ''Số tiền đếm không hợp lệ'' USING ERRCODE = ''22023'';' || chr(10) ||
    '  END IF;' || chr(10) ||
    v_anchor);
  EXECUTE v_def;
  RAISE NOTICE 'propose_cashbook_closing_v1: đã chặn NaN';
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
