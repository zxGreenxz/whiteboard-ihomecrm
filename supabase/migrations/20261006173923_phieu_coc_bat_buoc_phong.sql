-- ============================================================
-- Phiếu có hạng mục cọc phải gắn phòng (chủ duyệt 07/10/2026).
--
-- VÌ SAO
--   Cọc chỉ vào được hợp đồng theo PHÒNG: form tạo HĐ (useOrphanDepositVouchers) và
--   trigger trg_contract_link_orphan_deposits đều lọc room_id. Phiếu cọc chỉ chọn toà
--   treo mãi, không HĐ nào nhận. Ca thật: PT2609155 (cọc G03/1392QT, 29/09) chỉ có toà
--   ⇒ người lập nhập lại thành PT2610026 có phòng ⇒ sổ TKHIEP thừa 1.000.000đ (chủ đã
--   huỷ PT2609155 ngày 07/10).
--   Đo production 07/10: 4 phiếu cọc từng thiếu phòng, cả 4 lập tay qua form, cả 4 đã
--   huỷ; chưa luồng hệ thống nào sinh phiếu cọc thiếu phòng.
--
-- LÀM GÌ
--   Constraint trigger DEFERRABLE INITIALLY DEFERRED trên income_expense_items (thêm/đổi
--   hạng mục) và income_expenses (bỏ phòng / khôi phục phiếu đã xoá): lúc COMMIT, phiếu
--   chưa huỷ, chưa xoá mà có hạng mục is_deposit thì phải có room_id — không thì 23514.
--   Chặn mọi đường ghi (form phiếu lẻ, phiếu tổng, Báo chi nhanh, hàm hệ thống).
--   Kiểm lúc COMMIT để thứ tự ghi phiếu/hạng mục trong cùng transaction (sửa phiếu đổi
--   phòng và hạng mục một lượt) không bị chặn nhầm ở trạng thái giữa chừng.
--   Câu lỗi trùng DEPOSIT_ROOM_REQUIRED_MESSAGE (src/lib/depositRoomRule.ts): client dẫn
--   lỗi về ô Phòng và báo đúng nguyên nhân.
--   Lưu ý: lỗi nổ lúc COMMIT nên khối EXCEPTION bọc từng dòng trong một hàm (vd vòng lặp
--   của generate_recurring_vouchers) KHÔNG bắt được — cả lượt chạy bị huỷ, không chỉ
--   dòng hỏng. Hôm nay không có nguồn sinh ca đó: bước kiểm dữ liệu dưới đây bảo đảm
--   không còn phiếu cọc sống thiếu phòng để làm phiếu cha, và không hợp đồng sống nào
--   thiếu phòng để thanh lý chép room_id NULL sang phiếu hoàn/cấn cọc.
--
-- KHÔNG ĐỔI
--   Không sửa phiếu cũ (4 phiếu thiếu phòng đều CANCELLED — không bị canh). Không đổi
--   RPC, RLS, quyền, sổ.
--
-- ĐƯỜNG LÙI
--   DROP TRIGGER zz_ie_item_deposit_requires_room ON public.income_expense_items;
--   DROP TRIGGER zz_ie_deposit_requires_room ON public.income_expenses;
-- ============================================================

-- 1. Hàm kiểm (chạy lúc COMMIT). DEFINER để RLS không che dòng khi chính client ghi.
CREATE OR REPLACE FUNCTION app_private.guard_deposit_voucher_room_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_id   uuid;
  v_code text;
BEGIN
  IF TG_TABLE_NAME = 'income_expense_items' THEN
    v_id := NEW.income_expense_id;
  ELSE
    v_id := NEW.id;
  END IF;

  -- Đọc trạng thái CUỐI của phiếu (không dùng NEW): phiếu đã bị xoá/huỷ trong cùng
  -- transaction thì thôi.
  SELECT ie.code
    INTO v_code
    FROM public.income_expenses ie
   WHERE ie.id = v_id
     AND ie.room_id IS NULL
     AND ie.deleted_at IS NULL
     AND ie.approval_status IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1
                   FROM public.income_expense_items i
                   JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
                  WHERE i.income_expense_id = ie.id
                    AND t.is_deposit);
  IF FOUND THEN
    RAISE EXCEPTION 'Phiếu có hạng mục Tiền cọc phải chọn phòng.'
      USING ERRCODE = '23514',
            DETAIL = format('Phiếu %s chưa gắn phòng. Cọc chỉ vào được hợp đồng theo phòng — phiếu cọc không có phòng sẽ không hợp đồng nào nhận.',
                            coalesce(v_code, v_id::text)),
            HINT = 'Chọn phòng của khách đặt cọc rồi lưu lại.';
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_deposit_voucher_room_v1() IS
  'Constraint trigger (DEFERRABLE INITIALLY DEFERRED): phiếu chưa huỷ, chưa xoá có hạng mục is_deposit phải có room_id — cọc chỉ vào hợp đồng theo phòng. 23514. 07/10/2026.';

REVOKE ALL ON FUNCTION app_private.guard_deposit_voucher_room_v1() FROM PUBLIC, anon, authenticated;

-- 2. Trigger. Thêm/đổi hạng mục: mọi đường tạo phiếu đều chèn hạng mục.
DROP TRIGGER IF EXISTS zz_ie_item_deposit_requires_room ON public.income_expense_items;
CREATE CONSTRAINT TRIGGER zz_ie_item_deposit_requires_room
  AFTER INSERT OR UPDATE OF income_expense_type_id, income_expense_id ON public.income_expense_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_deposit_voucher_room_v1();

-- Phiếu bỏ phòng, hoặc phiếu đã xoá được khôi phục.
DROP TRIGGER IF EXISTS zz_ie_deposit_requires_room ON public.income_expenses;
CREATE CONSTRAINT TRIGGER zz_ie_deposit_requires_room
  AFTER UPDATE OF room_id, deleted_at ON public.income_expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.room_id IS NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION app_private.guard_deposit_voucher_room_v1();

-- 3. Không bật chặn khi dữ liệu đang có sẵn ca vi phạm. Đặt SAU lệnh tạo trigger: hai
--    bảng đã bị khoá (SHARE ROW EXCLUSIVE) tới hết transaction nên không ai chen ghi được
--    giữa lúc đếm và lúc trigger có hiệu lực. Bảng rỗng (dựng lại từ baseline) thì qua.
DO $du_lieu$
DECLARE
  v_ma text;
  v_hd int;
BEGIN
  -- Phiếu cọc sống thiếu phòng: sẽ không sửa được nữa.
  SELECT string_agg(coalesce(ie.code, ie.id::text), ', ' ORDER BY ie.code)
    INTO v_ma
    FROM public.income_expenses ie
   WHERE ie.room_id IS NULL
     AND ie.deleted_at IS NULL
     AND ie.approval_status IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1
                   FROM public.income_expense_items i
                   JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
                  WHERE i.income_expense_id = ie.id
                    AND t.is_deposit);
  IF v_ma IS NOT NULL THEN
    RAISE EXCEPTION 'Còn phiếu cọc chưa huỷ mà thiếu phòng: % — gắn phòng hoặc huỷ trước khi bật chặn', v_ma
      USING ERRCODE = '55000';
  END IF;

  -- Hợp đồng sống thiếu phòng: thanh lý chép room_id của hợp đồng sang phiếu hoàn/cấn cọc
  -- (approve_contract_termination_v1, terminate_contract_move_out_impl,
  -- create_termination_refund_voucher_v1) ⇒ sẽ bị chặn với câu "chọn phòng" mà người
  -- dùng không làm theo được. Đo production 07/10/2026: 0 / 444 hợp đồng.
  SELECT count(*) INTO v_hd
    FROM public.contracts c
   WHERE c.room_id IS NULL
     AND c.deleted_at IS NULL;
  IF v_hd > 0 THEN
    RAISE EXCEPTION 'Còn % hợp đồng chưa xoá mà thiếu phòng — gắn phòng trước khi bật chặn phiếu cọc thiếu phòng', v_hd
      USING ERRCODE = '55000';
  END IF;
END
$du_lieu$;

-- 4. Tự kiểm (chỉ catalog — chạy được trên database rỗng).
DO $sau$
DECLARE
  v_n int;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.guard_deposit_voucher_room_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'guard_deposit_voucher_room_v1 phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgdeferrable AND tginitdeferred AND tgenabled = 'O'
     AND tgfoid = 'app_private.guard_deposit_voucher_room_v1()'::regprocedure
     AND ((tgrelid = 'public.income_expense_items'::regclass AND tgname = 'zz_ie_item_deposit_requires_room')
       OR (tgrelid = 'public.income_expenses'::regclass AND tgname = 'zz_ie_deposit_requires_room'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Thiếu trigger chặn phiếu cọc thiếu phòng (% / 2, phải DEFERRABLE INITIALLY DEFERRED)', v_n
      USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'app_private.guard_deposit_voucher_room_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_deposit_voucher_room_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated còn EXECUTE trên guard_deposit_voucher_room_v1' USING ERRCODE = '55000';
  END IF;
END
$sau$;
