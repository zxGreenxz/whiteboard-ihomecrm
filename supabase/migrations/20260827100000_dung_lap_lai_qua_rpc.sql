BEGIN;
-- ============================================================
-- Nút "Dừng lặp lại" (trang Thu chi) — mở đường ghi hợp lệ
--
-- TRIỆU CHỨNG (người dùng báo 27/08/2026): bấm biểu tượng lịch "Dừng lặp lại"
-- trên phiếu gốc thì hiện "permission denied for table income_expenses".
-- Console: PATCH /rest/v1/income_expenses?id=eq.b6c57397-… → 403.
--
-- GỐC RỄ — KHÔNG phải RLS, mà là GRANT.
--   Thông báo "permission denied for table X" là SQLSTATE 42501 ở tầng quyền
--   bảng. RLS chặn thì câu chữ khác hẳn ("new row violates row-level security
--   policy") hoặc lặng lẽ trả 0 dòng. Đo trên prod 27/08:
--     role_table_grants(public.income_expenses, authenticated) = {SELECT,
--     REFERENCES, TRIGGER} — KHÔNG có UPDATE.
--   Đó là chủ ý: migration 20260723070000 (Finance V2 Stage-7 caller drain)
--   REVOKE INSERT/UPDATE/DELETE để mọi đường ghi đi qua RPC SECURITY DEFINER,
--   và header của nó tự liệt kê các caller phải dọn. `useStopRecurring` trong
--   src/hooks/income-expenses/recurring.ts BỊ BỎ SÓT khỏi danh sách đó, nên nó
--   là caller direct-DML duy nhất còn sống của lát Thu chi — im lặng suốt 35
--   ngày vì lỗi chỉ nổ lúc người dùng bấm, không nổ lúc build hay lúc test.
--
-- VÌ SAO KHÔNG DÙNG ie_compat_update_pending_v2 CHO XONG
--   Đã cân nhắc và đo: bản ĐANG CHẠY trên prod xếp repeat_cycle / repeat_count
--   / repeat_infinity / repeat_auto_approve vào `v_money_keys` (không phải
--   v_meta_keys như file 20260723190000 — hàm đã bị vá sau đó). Chạm khoá trục
--   tiền ⇒ hàm đòi phiếu phải UNAPPROVED và chưa POSTED. Phiếu lặp thật thì
--   gần như luôn APPROVED + POSTED (phiếu đang khảo sát: APPROVED/POSTED), nên
--   đường đó trả 55000 chứ không chạy. Nó cũng KHÔNG ghi được repeat_remaining
--   / repeat_next_date (không nằm trong whitelist) — mà repeat_next_date CÓ
--   hiển thị cho người dùng ("kỳ kế tiếp …" ở hộp thoại chi tiết), nên bỏ sót
--   là để lại một câu SAI trên màn hình sau khi đã dừng.
--
-- VÌ SAO PHẢI MỞ CỬA QUA HAI TRIGGER KHOÁ KỲ
--   Mọi UPDATE lên income_expenses đều đi qua income_expenses_check_lock (sổ
--   quỹ đã chốt) và income_expenses_check_profit_lock (tháng đã chốt lợi
--   nhuận). Hai trigger đó chặn theo (sổ, ngày) và (toà, tháng) của phiếu —
--   KHÔNG theo cột nào đổi. Đo trên phiếu đang hỏng: sổ quỹ chưa chốt, nhưng
--   tháng 05/2026 của toà ĐÃ khoá lợi nhuận (locked_at 20/07/2026). Hệ quả đo
--   được, mô phỏng theo từng tài khoản thật:
--     nguyentamca165 (tài khoản hệ thống)  is_org_owner_v1 = true  → lọt
--     nguyentam      (Chủ công ty)          is_org_owner_v1 = FALSE → bị chặn
--   Tức nếu chỉ thêm RPC mà không mở cửa, nút vẫn hỏng cho đúng người hay dùng
--   nó nhất, chỉ đổi câu báo lỗi.
--
--   Mở cửa ở đây là ĐÚNG NGHĨA chứ không phải nới tay: dừng lặp lại KHÔNG sửa
--   một con số nào của kỳ đã khoá — nó chỉ tắt việc SINH PHIẾU TƯƠNG LAI.
--   Cửa được siết ba lớp: (1) chỉ mở trong đúng transaction + backend_pid của
--   writer definer, (2) trigger TỰ KIỂM delta chứ không tin lời writer — chỉ
--   các cột repeat_* được phép đổi, (3) MỘT CHIỀU: chỉ chấp nhận khi
--   NEW.repeat_cycle = 'NONE', nên không ai mượn cửa này để BẬT hay kéo dài
--   lặp lại trong một kỳ đã khoá.
--
-- KHÔNG đụng guard_income_expense_owned_payload. Phiếu lặp gốc không bao giờ
-- là phiếu canonical: isCanonicalCreateEligible (mutations.ts) loại mọi phiếu
-- có repeat_cycle <> 'NONE' khỏi create_income_expense_v1, và writer canonical
-- cũng không nhận tham số repeat_*. Đo prod: 80/80 phiếu lặp gốc đều
-- flow_owned = false ⇒ guard early-return, không cần cửa. RPC vẫn từ chối
-- tường minh nếu gặp phiếu flow-owned thay vì để nó chết bằng 55000 khó hiểu.
--
-- Cầu a85_finance_v2_auto_posting_bridge KHÔNG bị đụng: nó chỉ nghe UPDATE OF
-- approval_status / account_id / total_amount / deleted_at.
--
-- Idempotent: chạy lại vô hại (constraint dựng lại theo danh sách tường minh,
-- hai bản vá trigger tự bỏ qua khi đã có cửa, RPC là CREATE OR REPLACE).
-- ============================================================

-- ---------- 1. Phạm vi ghi mới: STOP_RECURRING ----------
DO $scope$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'app_private.ie_flex_writer_xids'::regclass
    AND conname = 'ie_flex_writer_xids_scope_chk';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Thiếu ie_flex_writer_xids_scope_chk — kiểm tra 20260730120000 đã chạy chưa.';
  END IF;

  IF position('STOP_RECURRING' IN v_def) > 0 THEN
    RETURN; -- đã vá
  END IF;

  -- Preflight: chỉ dựng lại constraint khi danh sách hiện tại ĐÚNG bản đã đối
  -- chiếu. Prod thêm scope mới mà migration này chưa biết thì DROP + ADD sẽ
  -- đánh rơi nó — thà dừng ở đây còn hơn im lặng thu hẹp.
  IF position('ANNOTATE' IN v_def) = 0
     OR position('FLEX_EDIT' IN v_def) = 0
     OR position('LINK_CONTRACT' IN v_def) = 0
     OR position('SALE_BONUS_DEPOSIT' IN v_def) = 0
     OR position('CASHBOOK_MOVE' IN v_def) = 0
     OR position('HANDOVER' IN v_def) = 0
     OR (length(v_def) - length(replace(v_def, '::text', ''))) / 6 <> 6 THEN
    RAISE EXCEPTION 'ie_flex_writer_xids_scope_chk khác bản đã đối chiếu (%) — dừng lại, đối chiếu tay trước khi dựng lại.', v_def;
  END IF;

  ALTER TABLE app_private.ie_flex_writer_xids
    DROP CONSTRAINT ie_flex_writer_xids_scope_chk;
  ALTER TABLE app_private.ie_flex_writer_xids
    ADD CONSTRAINT ie_flex_writer_xids_scope_chk
    CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT', 'SALE_BONUS_DEPOSIT',
                     'CASHBOOK_MOVE', 'HANDOVER', 'STOP_RECURRING'));
END
$scope$;

-- ---------- 2. Cửa STOP_RECURRING trong hai trigger khoá kỳ ----------
-- VÁ TẠI CHỖ, không CREATE OR REPLACE từ file: hai hàm này đã qua nhiều đợt vá
-- và bản trong bất kỳ file migration nào cũng có thể đã lạc hậu — viết đè từ
-- một bản cũ là cách chắc chắn nhất để đánh rơi một luật khoá kỳ.
DO $cua$
DECLARE
  v_ten text;
  v_def text;
  v_neo text := '(to_jsonb(NEW) - ARRAY[''attachments'',''notes'',''updated_at'']) THEN
    RETURN NEW;
  END IF;';
  v_cua text := '

  -- Cửa DỪNG LẶP LẠI: chỉ tắt việc SINH PHIẾU TƯƠNG LAI, không đụng một con số
  -- nào của kỳ đã khoá. Trigger TỰ KIỂM delta chứ không tin lời writer, và chỉ
  -- nhận chiều TẮT (NEW.repeat_cycle = ''NONE'').
  IF TG_OP = ''UPDATE'' AND EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = ''STOP_RECURRING''
  ) THEN
    DECLARE
      v_tudo text[] := ARRAY[''repeat_cycle'',''repeat_infinity'',''repeat_count'',
                             ''repeat_remaining'',''repeat_next_date'',''updated_at''];
    BEGIN
      -- a001_ie_lifecycle_normalize chạy TRƯỚC và ĐIỀN ba cột này khi chúng
      -- đang NULL, ở MỌI update. Chỉ miễn ĐÚNG chiều NULL -> giá trị.
      IF OLD.posting_mode   IS NULL THEN v_tudo := v_tudo || ''posting_mode''; END IF;
      IF OLD.posting_status IS NULL THEN v_tudo := v_tudo || ''posting_status''; END IF;
      IF OLD.review_state   IS NULL THEN v_tudo := v_tudo || ''review_state''; END IF;

      IF (to_jsonb(OLD) - v_tudo) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_tudo)
         AND COALESCE(NEW.repeat_cycle, ''NONE'') = ''NONE'' THEN
        RETURN NEW;
      END IF;
    END;
  END IF;';
BEGIN
  FOREACH v_ten IN ARRAY ARRAY['income_expenses_check_lock', 'income_expenses_check_profit_lock'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    WHERE p.proname = v_ten AND p.pronamespace = 'public'::regnamespace;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'Không tìm thấy public.% — dừng lại.', v_ten;
    END IF;

    CONTINUE WHEN position('STOP_RECURRING' IN v_def) > 0; -- đã vá

    IF position(v_neo IN v_def) = 0 THEN
      RAISE EXCEPTION 'public.% không còn khối cửa ANNOTATE mà bản vá này neo vào — đối chiếu pg_get_functiondef trước khi sửa.', v_ten;
    END IF;

    v_def := replace(v_def, v_neo, v_neo || v_cua);
    EXECUTE v_def;
  END LOOP;
END
$cua$;

-- ---------- 3. RPC dừng lặp lại ----------
CREATE OR REPLACE FUNCTION public.ie_stop_recurring_v1(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.income_expenses
   WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  v_is_super := public.is_super_admin();

  SELECT m.id INTO v_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_row.organization_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Dừng lặp lại là hành vi SỬA phiếu, không phải chú thích ⇒ đòi quyền sửa
  -- thật trên toà (cùng cửa với trục tiền), hoặc chủ tổ chức / super admin.
  IF NOT (
       v_is_super
    OR app_private.is_org_owner_v1(v_row.organization_id, v_actor)
    OR app_private.ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id)
  ) THEN
    RAISE EXCEPTION 'Không có quyền dừng lặp lại phiếu trên toà nhà này' USING ERRCODE = '42501';
  END IF;

  -- RPC là SECURITY DEFINER nên KHÔNG hưởng policy RESTRICTIVE hạng mục hạn chế.
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền' USING ERRCODE = '42501';
  END IF;

  IF v_row.repeat_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'Đây là phiếu con do lặp lại sinh ra — hãy dừng ở phiếu gốc'
      USING ERRCODE = '55000';
  END IF;

  -- Phiếu canonical không đi được đường này (allowlist lifecycle của
  -- guard_income_expense_owned_payload không có cột repeat_*). Hôm nay không
  -- tồn tại phiếu lặp gốc canonical; nếu mai kia có, báo thẳng thay vì để nó
  -- chết bằng một câu 55000 không ai đọc ra.
  IF app_private.is_income_expense_flow_owned(p_id) THEN
    RAISE EXCEPTION 'Phiếu canonical chưa hỗ trợ dừng lặp lại — báo kỹ thuật'
      USING ERRCODE = '0A000';
  END IF;

  IF COALESCE(v_row.repeat_cycle, 'NONE') = 'NONE' THEN
    RETURN jsonb_build_object('id', p_id, 'changed', false);
  END IF;

  PERFORM app_private.begin_ie_flex_write_v1(p_id, 'STOP_RECURRING');
  UPDATE public.income_expenses
     SET repeat_cycle     = 'NONE',
         repeat_infinity  = false,
         repeat_count     = 0,
         repeat_remaining = 0,
         repeat_next_date = NULL
   WHERE id = p_id;
  PERFORM app_private.end_ie_flex_write_v1(p_id);

  PERFORM app_private.append_income_expense_event_v1(
    v_row.organization_id,
    p_id,
    'MANUAL_LOG',
    v_actor,
    NULL,
    v_row.approval_status,
    v_row.approval_status,
    'Dừng lặp lại (giữ phiếu + các phiếu đã sinh)'
  );

  RETURN jsonb_build_object('id', p_id, 'changed', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.ie_stop_recurring_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ie_stop_recurring_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.ie_stop_recurring_v1(uuid) IS
  'Dừng lặp lại cho MỘT phiếu gốc: giữ nguyên phiếu và các phiếu con đã sinh, chỉ tắt việc sinh phiếu tương lai. Đi được cả khi kỳ đã chốt sổ / khoá lợi nhuận vì không đụng con số nào của kỳ đó (cửa STOP_RECURRING, một chiều, trigger tự kiểm delta).';

-- ---------- 4. Smoke ----------
DO $smoke$
DECLARE
  v_ten text;
  v_def text;
  v_thieu text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY['income_expenses_check_lock', 'income_expenses_check_profit_lock'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = v_ten AND p.pronamespace = 'public'::regnamespace;
    IF position('STOP_RECURRING' IN COALESCE(v_def, '')) = 0 THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF array_length(v_thieu, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Cửa STOP_RECURRING chưa vào: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('public.ie_stop_recurring_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ie_stop_recurring_v1 chưa tồn tại';
  END IF;

  -- Cửa phải nhận được scope mới (CHECK constraint đã nới).
  INSERT INTO app_private.ie_flex_writer_xids
    (transaction_id, backend_pid, income_expense_id, scope)
  VALUES (pg_current_xact_id(), pg_backend_pid(),
          '00000000-0000-4000-8000-000000000000'::uuid, 'STOP_RECURRING');
  DELETE FROM app_private.ie_flex_writer_xids
   WHERE income_expense_id = '00000000-0000-4000-8000-000000000000'::uuid
     AND transaction_id = pg_current_xact_id();

  -- Gọi thật với id không tồn tại: ép nạp toàn thân hàm, mọi lỗi 42703 (tên
  -- cột) / 42883 (tên hàm phụ trợ) nổ NGAY LÚC APPLY thay vì lúc người bấm.
  BEGIN
    PERFORM public.ie_stop_recurring_v1('00000000-0000-4000-8000-000000000000'::uuid);
    RAISE EXCEPTION 'Smoke sai: hàm phải raise với id không tồn tại';
  EXCEPTION
    WHEN sqlstate 'P0002' THEN NULL;   -- đúng: phiếu không tồn tại
    WHEN sqlstate '42501' THEN NULL;   -- đúng: lane apply không có auth.uid()
  END;
END
$smoke$;

COMMIT;
