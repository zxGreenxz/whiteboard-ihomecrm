-- =====================================================================
-- SIẾT LẠI TOÀN PLAN — đợt vá sau khi chạy ma trận phân quyền Đợt 0→6
--
-- Toàn bộ những gì vá ở đây đều do PROBE THẬT trên production bới ra (chạy
-- trong transaction tự cuộn lại), không phải suy đoán từ đọc code.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. [NGHIÊM TRỌNG NHẤT] repeat_* KHÔNG PHẢI METADATA — nó IN RA TIỀN
--
-- `ie_compat_update_pending_v2` xếp repeat_cycle/repeat_count/repeat_infinity/
-- repeat_auto_approve vào v_meta_keys, tức "chữ trang trí", nên nhánh META chỉ
-- đòi: người tạo phiếu HOẶC có income_expenses.edit trên toà. Không đòi giữ sổ,
-- không chặn phiếu đã ghi sổ.
--
-- Nhưng cron `recurring_vouchers_daily` (0 18 * * *) → run_recurring_vouchers_job
-- → public.generate_recurring_vouchers quét mọi phiếu repeat_cycle <> 'NONE' AND
-- approval_status='APPROVED' rồi INSERT phiếu con với account_id = account của
-- phiếu MẸ, approval_status='APPROVED', approved_by = user_id của phiếu mẹ.
--
-- ⇒ Một người chỉ có income_expenses.edit trên toà bật repeat trên phiếu ĐÃ GHI
--   SỔ của người khác, hôm sau cron tự in tiền vào SỔ QUỸ CỦA NẠN NHÂN, ký tên
--   nạn nhân. Đo thật trên prod: sổ "DEMO Ngân Hàng" 20.635.000 → 28.635.000
--   (+8.000.000 từ 4 phiếu con) chỉ bằng một lần PATCH metadata.
--
-- Cùng lý lẽ, ba cột chứng từ sau cũng rời khỏi nhánh META: đổi được
-- receive_bank_account trên phiếu đã hạch toán nghĩa là đổi "tiền chảy vào tài
-- khoản nào" mà không để lại bản ghi trước/sau nào.
--
-- Sau bản vá, chúng đi theo TRỤC TIỀN: chỉ sửa được khi phiếu còn Chờ duyệt, và
-- người sửa phải qua ie_can_edit_money_axis_v1 + kiểm sổ như mọi cột tiền khác.
-- Prod đang có 80 phiếu repeat sống — chúng KHÔNG bị đụng, chỉ đường GHI bị siết.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_old_money text :=
    '  v_money_keys text[] := ARRAY[''account_id'',''change_account_id'',''rounding_account_id'',';
  v_old_meta text :=
    '  v_meta_keys text[] := ARRAY[''name'',''notes'',''attachments'',''payer_name'','
    || chr(10) || '    ''receive_bank_name'',''receive_bank_account'','
    || chr(10) || '    ''repeat_cycle'',''repeat_count'',''repeat_infinity'',''repeat_auto_approve''];';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_update_pending_v2';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có public.ie_compat_update_pending_v2 — DỪNG';
  END IF;

  IF position('''repeat_cycle'',''repeat_count''' IN v_def) = 0
     OR position(v_old_meta IN v_def) = 0 THEN
    RAISE NOTICE 'ie_compat_update_pending_v2 đã vá (repeat_* không còn ở meta) — bỏ qua';
    RETURN;
  END IF;
  IF position(v_old_money IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo v_money_keys — DỪNG, không vá mù';
  END IF;

  -- Chuyển 7 cột từ META sang MONEY.
  v_def := replace(v_def, v_old_meta,
    '  v_meta_keys text[] := ARRAY[''name'',''notes'',''attachments''];');
  v_def := replace(v_def, v_old_money,
    '  v_money_keys text[] := ARRAY[''account_id'',''change_account_id'',''rounding_account_id'','
    || chr(10) ||
    '    ''payer_name'',''receive_bank_name'',''receive_bank_account'','
    || chr(10) ||
    '    ''repeat_cycle'',''repeat_count'',''repeat_infinity'',''repeat_auto_approve'',');

  IF position('''repeat_auto_approve'',' || chr(10) IN v_def) = 0
     AND position('''repeat_auto_approve'','  IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá v_money_keys thất bại';
  END IF;
  IF position('''repeat_cycle'',''repeat_count'',''repeat_infinity'',''repeat_auto_approve''];' IN v_def) > 0 THEN
    RAISE EXCEPTION 'v_meta_keys vẫn còn repeat_* — vá thất bại';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'ie_compat_update_pending_v2: repeat_*/receive_bank_*/payer_name đã chuyển sang trục tiền';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. update_income_expense_quick: p_notes = NULL không được XOÁ TRẮNG ghi chú
-- Hàm đặt notes = p_notes vô điều kiện trong khi mọi cột khác đều có mẫu
-- CASE WHEN ... IS NOT NULL. Client chỉ muốn dán ảnh mà truyền p_notes=NULL là
-- mất sạch nhật ký nghiệp vụ của phiếu đã ghi sổ. Đo thật: '[DEMO-DOCS]' → NULL.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'update_income_expense_quick';
  IF v_def IS NULL THEN RAISE NOTICE 'Không có update_income_expense_quick'; RETURN; END IF;
  IF position('COALESCE(p_notes' IN v_def) > 0 THEN
    RAISE NOTICE 'update_income_expense_quick đã vá notes — bỏ qua'; RETURN;
  END IF;
  IF position('    notes       = p_notes' IN v_def) = 0
     OR position('assert_notes_markers_unchanged_v1(v_before.notes, p_notes)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo notes trong update_income_expense_quick — DỪNG';
  END IF;
  -- Phải vá CẢ HAI chỗ: nếu chỉ đổi phép gán thì với phiếu CÓ dấu tiền,
  -- assert_notes_markers_unchanged_v1 vẫn nhận p_notes = NULL và hiểu là "gỡ
  -- sạch dấu" rồi RAISE — hàm sẽ mâu thuẫn với chính nó.
  v_def := replace(v_def,
    'assert_notes_markers_unchanged_v1(v_before.notes, p_notes)',
    'assert_notes_markers_unchanged_v1(v_before.notes, COALESCE(p_notes, v_before.notes))');
  v_def := replace(v_def, '    notes       = p_notes', '    notes       = COALESCE(p_notes, notes)');
  EXECUTE v_def;
  RAISE NOTICE 'update_income_expense_quick: p_notes NULL giờ giữ nguyên ghi chú cũ';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. is_org_owner_v1 phải tôn trọng CỬA SỔ HIỆU LỰC của binding
-- Hàm chỉ lọc hiệu lực của MEMBERSHIP, không lọc của chính role_binding. Cả
-- repo thu hồi vai trò bằng rb.valid_to = now(), nên người ĐÃ BỊ TƯỚC vai "Chủ
-- sở hữu tổ chức" vẫn là chủ dưới mắt hàm này — mà hàm này là cửa đi thẳng của
-- Đợt 1 (bật/tắt chế độ), Đợt 2 (annotate), Đợt 4 (huỷ phiếu). Chiều ngược lại
-- cũng sai: binding hẹn hiệu lực 30 ngày nữa đã cấp quyền chủ NGAY HÔM NAY.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.is_org_owner_v1(p_org uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.organization_memberships m
      ON m.id = rb.membership_id
     AND m.organization_id = rb.organization_id
     AND m.user_id = p_user
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now())
    JOIN public.organization_roles r
      ON r.id = rb.role_id AND r.name = 'Chủ sở hữu tổ chức'
    WHERE rb.organization_id = p_org
      -- Cửa sổ hiệu lực của CHÍNH binding: đây là cách duy nhất repo thu hồi vai trò.
      AND COALESCE(rb.valid_from, '-infinity'::timestamptz) <= now()
      AND (rb.valid_to IS NULL OR rb.valid_to > now())
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.is_org_owner_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 4. lock_cashbook_period_v1 KHÔNG còn là cửa cho client
-- Nó gác bằng cashbooks.edit — khoá này có requires_cashbook_possession=false,
-- nên người KHÔNG giữ sổ vẫn khoá được sổ người khác bằng MỘT cú gọi, đi vòng
-- qua toàn bộ nghi thức hai bên của Đợt 6. Đo thật: DEMO Kế Toán khoá được sổ
-- đứng tên Chủ Nhà.
-- FE không còn caller nào (Đợt 6 đã xoá useLockAccount/useUnlockAccount).
-- ─────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.lock_cashbook_period_v1(uuid, date, boolean)
  FROM authenticated, anon, service_role;

COMMENT ON FUNCTION public.lock_cashbook_period_v1(uuid, date, boolean) IS
  'DI SẢN. Khoá kỳ giờ đi qua nghi thức hai bên: propose_cashbook_closing_v1 → '
  'confirm_cashbook_closing_v1. Đã REVOKE khỏi authenticated vì cashbooks.edit '
  'không đòi đang-giữ-sổ, nên hàm này từng là cửa sau một-cú-gọi.';

-- ─────────────────────────────────────────────────────────────────────
-- 5. "Kỳ còn mở" phải soi CẢ handover_transfer_id
-- assert_period_open_for_edit_v1 và assert_manual_voucher_v1 chỉ đọc
-- handover_id, trong khi trigger ie_handover_guard đang chạy có hẳn nhánh cho
-- handover_transfer_id. Prod có 16 phiếu handover_transfer_id NOT NULL /
-- handover_id NULL: vị ngữ phán "kỳ còn mở", writer chạy tới tận UPDATE header
-- rồi mới bị trigger chặn bằng thông điệp thô. Reader nói dối, và với phiếu đã
-- ghi sổ thì hàm đã kịp INSERT bút toán đảo trước khi bị chặn.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text := '  IF v_row.handover_id IS NOT NULL THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'assert_period_open_for_edit_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có assert_period_open_for_edit_v1'; END IF;
  IF position('handover_transfer_id' IN v_def) > 0 THEN
    RAISE NOTICE 'assert_period_open_for_edit_v1 đã soi handover_transfer_id — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo handover trong assert_period_open_for_edit_v1 — DỪNG';
  END IF;
  v_def := replace(v_def, v_anchor,
    '  IF v_row.handover_transfer_id IS NOT NULL THEN' || chr(10) ||
    '    SELECT h.code INTO v_handover FROM public.cash_handovers h' || chr(10) ||
    '     WHERE h.id = v_row.handover_transfer_id AND h.status <> ''CANCELLED'';' || chr(10) ||
    '    IF v_handover IS NOT NULL THEN' || chr(10) ||
    '      RAISE EXCEPTION' || chr(10) ||
    '        ''[HANDOVER_LOCKED] Đây là phiếu chuyển của phiên bàn giao % — muốn % thì phải huỷ phiên đó trước (cần cả hai bên đồng ý).'',' || chr(10) ||
    '        v_handover, p_action USING ERRCODE = ''P0001'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    '  END IF;' || chr(10) || chr(10) ||
    v_anchor);
  IF position('handover_transfer_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá assert_period_open_for_edit_v1 thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'assert_period_open_for_edit_v1: đã soi handover_transfer_id';
END
$patch$;

DO $patch$
DECLARE
  v_def text;
  v_anchor text := '  IF v.handover_id IS NOT NULL THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'assert_manual_voucher_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có assert_manual_voucher_v1'; END IF;
  IF position('handover_transfer_id' IN v_def) > 0 THEN
    RAISE NOTICE 'assert_manual_voucher_v1 đã soi handover_transfer_id — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo handover trong assert_manual_voucher_v1 — DỪNG';
  END IF;
  v_def := replace(v_def, v_anchor,
    '  IF v.handover_transfer_id IS NOT NULL THEN' || chr(10) ||
    '    RAISE EXCEPTION ''[HANDOVER_LOCKED] Đây là phiếu chuyển của một phiên bàn giao — huỷ phiên trước.''' || chr(10) ||
    '      USING ERRCODE = ''42501'';' || chr(10) ||
    '  END IF;' || chr(10) ||
    v_anchor);
  EXECUTE v_def;
  RAISE NOTICE 'assert_manual_voucher_v1: đã soi handover_transfer_id';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Chặn ghi TAY vào cột dẫn xuất của hoá đơn
-- `authenticated` vẫn còn UPDATE trên public.invoices (FE có 8 chỗ ghi hợp lệ:
-- status, approved_at, notes, subtotal…). Nhưng paid_amount là cột DẪN XUẤT do
-- recompute_invoice_for_id sở hữu. Đo thật: PATCH thẳng qua PostgREST set 31
-- dòng org DEMO về 0 — hoá đơn đã thu thành chưa thu, không trigger nào tính lại.
--
-- Không REVOKE cả bảng (sẽ gãy 8 đường ghi thật). Dùng đúng mẫu của
-- trg_guard_ie_financial: guard CHỈ nổ khi current_user là authenticated/anon,
-- nên mọi writer SECURITY DEFINER (chạy dưới postgres) đi qua bình thường.
-- SECURITY INVOKER là BẮT BUỘC — trong hàm DEFINER thì current_user luôn là
-- postgres và guard sẽ không chặn được ai (án lệ đã ghi trong repo).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_invoice_derived_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN
    RAISE EXCEPTION
      'invoices.paid_amount là cột dẫn xuất — chỉ recompute_invoice_for_id được ghi. Ghi tay sẽ làm hoá đơn lệch với sổ thu tiền.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a00_invoice_derived_guard ON public.invoices;
CREATE TRIGGER a00_invoice_derived_guard
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_derived_columns();

-- anon không có việc gì với hai bảng tiền lõi. TRUNCATE bỏ qua RLS và hiện chỉ
-- được cứu nhờ hình thái khoá ngoại — không phải nhờ phân quyền.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoices FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payments FROM anon;
REVOKE TRUNCATE ON public.invoices FROM authenticated;
REVOKE TRUNCATE ON public.payments FROM authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
