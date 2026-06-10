-- =====================================================================
-- Bàn giao tiền mặt (cash handover) — staff đi thu tiền hộ rồi bàn giao
-- lại cho người khác (chủ/quản lý), xác nhận 2 phía để không lộn tiền.
--
-- Mô hình:
--   * Phiên `cash_handovers`: PENDING (người giao bấm "Xác nhận giao")
--     → CONFIRMED (người nhận bấm "Đã nhận" — LÚC NÀY mới tạo cặp phiếu
--     chuyển nội bộ CHI sổ người giao + THU sổ người nhận, ngoài KQKD)
--     → CANCELLED (hủy cần CẢ 2 BÊN: 1 bên yêu cầu, bên kia xác nhận).
--   * Phiếu thu gốc gắn `income_expenses.handover_id` khi vào phiên —
--     chống bàn giao trùng + trigger guard chặn hoàn tác/xoá/sửa tiền.
--     Chỉ clear khi phiên CANCELLED.
--   * Cặp phiếu chuyển KHÔNG mang handover_id (phiếu THU "Nhận bàn giao"
--     của người nhận có thể được bàn giao tiếp lên cấp trên), tham chiếu
--     qua transfer_expense_id / transfer_income_id trên phiên.
--   * Số tiền bàn giao = Σ total_amount phiếu (số đã vào sổ = tiền mặt
--     thực giữ — tiền thối/làm tròn đã NET theo thiết kế 20260512000001).
--   * Ghi CHỈ qua RPC SECURITY DEFINER — bảng mới không có policy ghi.
-- =====================================================================

BEGIN;

-- ── 1. Bảng phiên bàn giao ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_handovers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text UNIQUE,                  -- BG{YYMM}{seq3}, gen trong RPC
  giver_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  giver_name          text,                         -- snapshot profiles.full_name
  receiver_name       text,
  from_account_id     uuid NOT NULL REFERENCES public.accounts(id),
  to_account_id       uuid REFERENCES public.accounts(id),   -- chốt lúc confirm
  total_amount        numeric(15,2) NOT NULL,       -- snapshot Σ phiếu lúc tạo
  voucher_count       int NOT NULL,
  note                text,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  -- Yêu cầu hủy (overlay, không phải status riêng): 1 bên yêu cầu, bên kia xác nhận
  cancel_requested_by uuid REFERENCES auth.users(id),
  cancel_reason       text,
  cancel_requested_at timestamptz,
  cancelled_by        uuid REFERENCES auth.users(id),
  cancelled_at        timestamptz,
  confirmed_at        timestamptz,
  transfer_expense_id uuid REFERENCES public.income_expenses(id),
  transfer_income_id  uuid REFERENCES public.income_expenses(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (giver_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_handovers_giver    ON public.cash_handovers(giver_id);
CREATE INDEX IF NOT EXISTS idx_cash_handovers_receiver ON public.cash_handovers(receiver_id);
CREATE INDEX IF NOT EXISTS idx_cash_handovers_active   ON public.cash_handovers(status)
  WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS idx_cash_handovers_tr_exp   ON public.cash_handovers(transfer_expense_id)
  WHERE transfer_expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_handovers_tr_inc   ON public.cash_handovers(transfer_income_id)
  WHERE transfer_income_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_cash_handovers_updated_at ON public.cash_handovers;
CREATE TRIGGER trg_cash_handovers_updated_at
  BEFORE UPDATE ON public.cash_handovers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. Snapshot từng phiếu trong phiên ──────────────────────────────
-- Người nhận xem danh sách để ĐẾM TIỀN mà không cần quyền RLS tới phiếu
-- gốc (income_expenses_select_rbac đòi can_access_building toà đó).
CREATE TABLE IF NOT EXISTS public.cash_handover_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id   uuid NOT NULL REFERENCES public.cash_handovers(id) ON DELETE CASCADE,
  voucher_id    uuid NOT NULL REFERENCES public.income_expenses(id),
  amount        numeric(15,2) NOT NULL,
  voucher_code  text,
  voucher_date  date,
  room_name     text,
  building_name text,
  UNIQUE (handover_id, voucher_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_handover_items_handover
  ON public.cash_handover_items(handover_id);

-- ── 3. Cột đánh dấu trên phiếu thu gốc ──────────────────────────────
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS handover_id uuid REFERENCES public.cash_handovers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ie_handover
  ON public.income_expenses(handover_id) WHERE handover_id IS NOT NULL;

COMMENT ON COLUMN public.income_expenses.handover_id IS
  'Phiên bàn giao tiền mặt chứa phiếu này (NULL = chưa bàn giao). Giữ nguyên sau khi phiên CONFIRMED; chỉ clear khi phiên CANCELLED.';

-- ── 4. RLS: chỉ SELECT cho 2 bên + admin; mọi ghi qua RPC ───────────
ALTER TABLE public.cash_handovers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_handover_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_handovers_select ON public.cash_handovers;
CREATE POLICY cash_handovers_select ON public.cash_handovers
  FOR SELECT TO authenticated
  USING (giver_id = auth.uid() OR receiver_id = auth.uid()
         OR public.is_admin() OR public.is_super_admin());

DROP POLICY IF EXISTS cash_handover_items_select ON public.cash_handover_items;
CREATE POLICY cash_handover_items_select ON public.cash_handover_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.cash_handovers h
    WHERE h.id = handover_id
      AND (h.giver_id = auth.uid() OR h.receiver_id = auth.uid()
           OR public.is_admin() OR public.is_super_admin())
  ));

-- ── 5. Trigger guard: khoá phiếu đang nằm trong phiên bàn giao ──────
-- Chặn hoàn tác (/thu-tien soft-delete voucher), xoá, hủy duyệt, đổi sổ/
-- tiền/ngày trên: (a) phiếu gốc thuộc phiên chưa CANCELLED, (b) cặp phiếu
-- chuyển của phiên CONFIRMED. Prefix [HANDOVER_LOCKED] để FE detect.
-- RPC hủy set status='CANCELLED' TRƯỚC rồi mới đụng phiếu → guard tự nhả.
CREATE OR REPLACE FUNCTION public.ie_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
BEGIN
  IF OLD.handover_id IS NOT NULL THEN
    SELECT code INTO v_code FROM cash_handovers
     WHERE id = OLD.handover_id AND status <> 'CANCELLED';
  END IF;
  IF v_code IS NULL THEN
    SELECT code INTO v_code FROM cash_handovers
     WHERE status = 'CONFIRMED'
       AND (transfer_expense_id = OLD.id OR transfer_income_id = OLD.id)
     LIMIT 1;
  END IF;

  IF v_code IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '[HANDOVER_LOCKED] Phiếu thuộc phiên bàn giao % — hủy phiên (2 bên xác nhận) trước khi xoá.', v_code;
    END IF;
    IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
       OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.account_id      IS DISTINCT FROM OLD.account_id
       OR NEW.total_amount    IS DISTINCT FROM OLD.total_amount
       OR NEW.voucher_date    IS DISTINCT FROM OLD.voucher_date
       OR NEW.handover_id     IS DISTINCT FROM OLD.handover_id THEN
      RAISE EXCEPTION '[HANDOVER_LOCKED] Phiếu thuộc phiên bàn giao % — hủy phiên (2 bên xác nhận) trước khi hoàn tác/sửa.', v_code;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ie_handover_guard ON public.income_expenses;
CREATE TRIGGER trg_ie_handover_guard
  BEFORE UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.ie_handover_guard();

-- ── 6. Helper: tòa ảo "Chung" của 1 user (get-or-create) ────────────
-- Cặp phiếu chuyển cần building_id NOT NULL nhưng không thuộc toà thật.
-- Backfill 20260512000001 chỉ chạy 1 lần — user tạo sau có thể chưa có.
CREATE OR REPLACE FUNCTION public._chung_building(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM buildings
   WHERE user_id = p_user_id AND is_virtual = true AND name = 'Chung'
     AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)
  VALUES (p_user_id, 'Chung', 'APARTMENT'::building_type, 'ACTIVE'::building_status, '—', '—', '—', true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._chung_building(uuid) FROM PUBLIC, anon, authenticated;

-- ── 7. RPC: tạo phiên (= người giao bấm "Xác nhận giao") ────────────
CREATE OR REPLACE FUNCTION public.create_cash_handover(
  p_receiver_id uuid,
  p_voucher_ids uuid[],
  p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids        uuid[];
  v_cnt        int;
  v_from_acc   uuid;
  v_acc_owner  uuid;
  v_sum        numeric;
  v_recv_name  text;
  v_recv_active boolean;
  v_giver_name text;
  v_month      text;
  v_seq        int;
  v_code       text;
  v_id         uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = auth.uid() THEN
    RAISE EXCEPTION 'Người nhận không hợp lệ (không thể tự bàn giao cho chính mình)';
  END IF;

  SELECT full_name, is_active INTO v_recv_name, v_recv_active
    FROM profiles WHERE id = p_receiver_id;
  IF NOT FOUND OR v_recv_active IS FALSE THEN
    RAISE EXCEPTION 'Người nhận không tồn tại hoặc đã bị khoá';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT unnest(p_voucher_ids));
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn phiếu thu nào để bàn giao';
  END IF;

  -- Khoá các phiếu chống race 2 phiên cùng lúc
  PERFORM 1 FROM income_expenses WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT count(*) INTO v_cnt
    FROM income_expenses
   WHERE id = ANY(v_ids)
     AND type = 'INCOME' AND approval_status = 'APPROVED'
     AND deleted_at IS NULL AND handover_id IS NULL AND account_id IS NOT NULL;
  IF v_cnt <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / không phải phiếu thu đã duyệt)';
  END IF;

  SELECT count(DISTINCT account_id) INTO v_cnt FROM income_expenses WHERE id = ANY(v_ids);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Các phiếu bàn giao phải cùng MỘT sổ quỹ';
  END IF;
  SELECT account_id, sum(total_amount) INTO v_from_acc, v_sum
    FROM income_expenses WHERE id = ANY(v_ids) GROUP BY account_id;

  SELECT user_id INTO v_acc_owner FROM accounts
   WHERE id = v_from_acc AND deleted_at IS NULL;
  IF v_acc_owner IS NULL OR v_acc_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ bàn giao được phiếu nằm trong sổ quỹ do chính bạn sở hữu';
  END IF;

  SELECT COALESCE(full_name, '') INTO v_giver_name FROM profiles WHERE id = auth.uid();

  -- Mã BG{YYMM}{seq3} — advisory lock chống trùng khi 2 phiên tạo song song
  PERFORM pg_advisory_xact_lock(hashtext('cash_handover_code'));
  v_month := to_char(CURRENT_DATE, 'YYMM');
  SELECT COALESCE(MAX(
           CASE WHEN code ~ ('^BG' || v_month || '\d+$')
                THEN substring(code FROM 7)::int ELSE 0 END
         ), 0) + 1
    INTO v_seq
    FROM cash_handovers WHERE code LIKE 'BG' || v_month || '%';
  v_code := 'BG' || v_month || lpad(v_seq::text, 3, '0');

  INSERT INTO cash_handovers
    (code, giver_id, receiver_id, giver_name, receiver_name,
     from_account_id, total_amount, voucher_count, note)
  VALUES
    (v_code, auth.uid(), p_receiver_id, v_giver_name, v_recv_name,
     v_from_acc, v_sum, array_length(v_ids, 1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  INSERT INTO cash_handover_items
    (handover_id, voucher_id, amount, voucher_code, voucher_date, room_name, building_name)
  SELECT v_id, ie.id, ie.total_amount, ie.code, ie.voucher_date, r.name, b.name
    FROM income_expenses ie
    LEFT JOIN rooms r     ON r.id = ie.room_id
    LEFT JOIN buildings b ON b.id = ie.building_id
   WHERE ie.id = ANY(v_ids);

  UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code,
    'total_amount', v_sum, 'voucher_count', array_length(v_ids, 1));
END;
$$;

-- ── 8. RPC: người nhận xác nhận — tạo cặp phiếu chuyển nội bộ ───────
CREATE OR REPLACE FUNCTION public.confirm_cash_handover(
  p_handover_id   uuid,
  p_to_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h          cash_handovers%ROWTYPE;
  v_to         uuid;
  v_sum        numeric;
  v_cnt        int;
  v_type_exp   uuid;
  v_type_inc   uuid;
  v_bld_giver  uuid;
  v_bld_recv   uuid;
  v_caller     text;
  v_exp        uuid;
  v_inc        uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được xác nhận đã nhận tiền';
  END IF;
  IF v_h.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Phiên % không ở trạng thái chờ nhận', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên vẹn, tổng khớp snapshot
  SELECT COALESCE(sum(ie.total_amount), 0), count(*) INTO v_sum, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_sum <> v_h.total_amount THEN
    RAISE EXCEPTION 'Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung của chủ từng sổ
  v_type_exp := public._termination_ensure_type(v_h.giver_id, 'expense', 'Bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := public._termination_ensure_type(v_h.receiver_id, 'income', 'Nhận bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := public._chung_building(v_h.giver_id);
  v_bld_recv  := public._chung_building(v_h.receiver_id);

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- CHI từ sổ người giao (ngoài KQKD — chỉ là chuyển tiền nội bộ)
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || COALESCE(v_h.receiver_name, '') || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Chuyển tiền mặt đã thu sang sổ người nhận (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu).',
     v_caller)
  RETURNING id INTO v_exp;
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_exp, v_type_exp, 'Bàn giao tiền mặt — ' || v_h.code, 1, v_h.total_amount, CURRENT_DATE, CURRENT_DATE);

  -- THU vào sổ người nhận
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || COALESCE(v_h.giver_name, '') || ' — ' || v_h.code,
     v_bld_recv, v_to, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền mặt bàn giao (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu).',
     v_caller)
  RETURNING id INTO v_inc;
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_inc, v_type_inc, 'Nhận bàn giao tiền mặt — ' || v_h.code, 1, v_h.total_amount, CURRENT_DATE, CURRENT_DATE);

  UPDATE cash_handovers
     SET status = 'CONFIRMED', to_account_id = v_to, confirmed_at = now(),
         transfer_expense_id = v_exp, transfer_income_id = v_inc
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code,
                            'total_amount', v_h.total_amount, 'to_account_id', v_to);
END;
$$;

-- ── 9. RPC: yêu cầu hủy (1 trong 2 bên) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.request_cancel_handover(
  p_handover_id uuid,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h cash_handovers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF auth.uid() NOT IN (v_h.giver_id, v_h.receiver_id) THEN
    RAISE EXCEPTION 'Chỉ người giao hoặc người nhận mới được yêu cầu hủy';
  END IF;
  IF v_h.status NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'Phiên % đã hủy rồi', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Phiên % đã có yêu cầu hủy đang chờ xác nhận', v_h.code;
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do hủy';
  END IF;

  UPDATE cash_handovers
     SET cancel_requested_by = auth.uid(),
         cancel_reason = btrim(p_reason),
         cancel_requested_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code);
END;
$$;

-- ── 10. RPC: BÊN KIA xác nhận hủy → CANCELLED (+ đảo cặp phiếu) ─────
CREATE OR REPLACE FUNCTION public.confirm_cancel_handover(p_handover_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h     cash_handovers%ROWTYPE;
  v_chain text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.cancel_requested_by IS NULL THEN
    RAISE EXCEPTION 'Phiên % chưa có yêu cầu hủy', v_h.code;
  END IF;
  IF auth.uid() NOT IN (v_h.giver_id, v_h.receiver_id) THEN
    RAISE EXCEPTION 'Chỉ người giao hoặc người nhận mới được xác nhận hủy';
  END IF;
  IF auth.uid() = v_h.cancel_requested_by THEN
    RAISE EXCEPTION 'Hủy phiên cần BÊN KIA xác nhận (bạn là người đã yêu cầu hủy)';
  END IF;
  IF v_h.status NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'Phiên % đã hủy rồi', v_h.code;
  END IF;

  -- Chain: tiền nhận từ phiên này đã được bàn giao tiếp ở phiên khác?
  IF v_h.transfer_income_id IS NOT NULL THEN
    SELECT ch.code INTO v_chain
      FROM income_expenses ie
      JOIN cash_handovers ch ON ch.id = ie.handover_id
     WHERE ie.id = v_h.transfer_income_id AND ch.status <> 'CANCELLED';
    IF v_chain IS NOT NULL THEN
      RAISE EXCEPTION 'Tiền của phiên % đã được bàn giao tiếp trong phiên % — hủy phiên đó trước', v_h.code, v_chain;
    END IF;
  END IF;

  -- Set CANCELLED TRƯỚC để trigger guard nhả các phiếu liên quan
  UPDATE cash_handovers
     SET status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now()
   WHERE id = p_handover_id;

  -- Phiên đã CONFIRMED: đảo cặp phiếu chuyển (số dư 2 sổ tự hồi —
  -- accounts_with_balance chỉ tính phiếu APPROVED)
  IF v_h.status = 'CONFIRMED' THEN
    UPDATE income_expenses
       SET approval_status = 'CANCELLED'
     WHERE id IN (v_h.transfer_expense_id, v_h.transfer_income_id);
  END IF;

  -- Nhả phiếu gốc để có thể bàn giao lại / hoàn tác (items giữ làm lịch sử)
  UPDATE income_expenses SET handover_id = NULL WHERE handover_id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code);
END;
$$;

-- ── 11. RPC: từ chối / thu hồi yêu cầu hủy ──────────────────────────
CREATE OR REPLACE FUNCTION public.reject_cancel_handover(p_handover_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h cash_handovers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF auth.uid() NOT IN (v_h.giver_id, v_h.receiver_id) THEN
    RAISE EXCEPTION 'Chỉ người giao hoặc người nhận mới thao tác được';
  END IF;
  IF v_h.cancel_requested_by IS NULL THEN
    RAISE EXCEPTION 'Phiên % không có yêu cầu hủy', v_h.code;
  END IF;
  IF v_h.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiên % đã hủy rồi', v_h.code;
  END IF;

  UPDATE cash_handovers
     SET cancel_requested_by = NULL, cancel_reason = NULL, cancel_requested_at = NULL
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code);
END;
$$;

-- ── 12. Grants ──────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_cash_handover(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_cash_handover(uuid, uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_cash_handover(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cash_handover(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.request_cancel_handover(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_cancel_handover(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_cancel_handover(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cancel_handover(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.reject_cancel_handover(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reject_cancel_handover(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
