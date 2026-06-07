-- =============================================
-- Migration: Tự động "Cọc giữ chỗ" → rooms.status = RESERVED.
-- Khi 1 phòng CHƯA có HĐ đang hiệu lực nhưng có cọc giữ chỗ (bảng deposits
-- PENDING/CONFIRMED chưa link HĐ, HOẶC phiếu thu chi loại "tiền cọc" chưa link HĐ)
-- → set rooms.status='RESERVED'. Hết cọc / huỷ / hoàn / chuyển thành HĐ → tự gỡ.
-- Nguồn sự thật DUY NHẤT = recompute_room_reservation(room_id); mọi sự kiện
-- cọc/HĐ/phòng gọi nó qua trigger. CHỈ chuyển AVAILABLE<->RESERVED; KHÔNG đụng
-- OCCUPIED/MAINTENANCE/UNAVAILABLE (HĐ đang hiệu lực vẫn sở hữu OCCUPIED).
-- KHÔNG sửa file migration cũ; KHÔNG đổi RPC public (RESERVED hiện như "Đã thuê").
-- =============================================

-- 1) Hàm reconcile (idempotent, hội tụ).
CREATE OR REPLACE FUNCTION public.recompute_room_reservation(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_has_active  boolean;
  v_has_holding boolean;
BEGIN
  IF p_room_id IS NULL THEN
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM rooms
  WHERE id = p_room_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- HĐ đang hiệu lực sở hữu OCCUPIED → reconcile cọc không can thiệp.
  SELECT EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.room_id = p_room_id
      AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE','EXTENDED')
  ) INTO v_has_active;
  IF v_has_active THEN
    RETURN;
  END IF;

  -- PREDICATE "cọc giữ chỗ đang hiệu lực" — đếm cả phiếu CHƯA DUYỆT (chốt #2),
  -- chỉ loại phiếu đã huỷ (CANCELLED) / đã xoá / đã link HĐ.
  SELECT (
    EXISTS (
      SELECT 1 FROM deposits d
      WHERE d.room_id = p_room_id
        AND d.deleted_at IS NULL
        AND d.contract_id IS NULL
        AND d.status IN ('PENDING','CONFIRMED')
    )
    OR EXISTS (
      SELECT 1 FROM income_expenses ie
      WHERE ie.room_id = p_room_id
        AND ie.deleted_at IS NULL
        AND ie.contract_id IS NULL
        AND ie.type = 'INCOME'
        AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
        AND ie_has_deposit_item(ie.id)
    )
  ) INTO v_has_holding;

  IF v_status = 'AVAILABLE' AND v_has_holding THEN
    UPDATE rooms SET status = 'RESERVED', updated_at = NOW() WHERE id = p_room_id;
  ELSIF v_status = 'RESERVED' AND NOT v_has_holding THEN
    UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW() WHERE id = p_room_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.recompute_room_reservation(uuid) IS
'Đồng bộ cờ "cọc giữ chỗ": AVAILABLE<->RESERVED theo việc phòng có cọc chưa-HĐ hay
không. Bỏ qua nếu phòng đang có HĐ hiệu lực (OCCUPIED do HĐ sở hữu). Không đụng
MAINTENANCE/UNAVAILABLE. Idempotent — gọi lại nhiều lần an toàn.';

-- 2a) Trigger trên deposits.
CREATE OR REPLACE FUNCTION public.trg_deposit_reconcile_room()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_room_reservation(OLD.room_id);
    RETURN NULL;
  END IF;
  PERFORM recompute_room_reservation(NEW.room_id);
  IF TG_OP = 'UPDATE' AND OLD.room_id IS DISTINCT FROM NEW.room_id THEN
    PERFORM recompute_room_reservation(OLD.room_id);
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_deposit_reconcile_room_ins ON public.deposits;
DROP TRIGGER IF EXISTS trg_deposit_reconcile_room_upd ON public.deposits;
DROP TRIGGER IF EXISTS trg_deposit_reconcile_room_del ON public.deposits;
CREATE TRIGGER trg_deposit_reconcile_room_ins AFTER INSERT ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION public.trg_deposit_reconcile_room();
CREATE TRIGGER trg_deposit_reconcile_room_upd
  AFTER UPDATE OF room_id, contract_id, status, deleted_at ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION public.trg_deposit_reconcile_room();
CREATE TRIGGER trg_deposit_reconcile_room_del AFTER DELETE ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION public.trg_deposit_reconcile_room();

-- 2b) Trigger trên income_expenses (phiếu thu chi).
CREATE OR REPLACE FUNCTION public.trg_ie_reconcile_room()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_room_reservation(OLD.room_id);
    RETURN NULL;
  END IF;
  PERFORM recompute_room_reservation(NEW.room_id);
  IF TG_OP = 'UPDATE' AND OLD.room_id IS DISTINCT FROM NEW.room_id THEN
    PERFORM recompute_room_reservation(OLD.room_id);
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_ie_reconcile_room_ins ON public.income_expenses;
DROP TRIGGER IF EXISTS trg_ie_reconcile_room_upd ON public.income_expenses;
DROP TRIGGER IF EXISTS trg_ie_reconcile_room_del ON public.income_expenses;
CREATE TRIGGER trg_ie_reconcile_room_ins AFTER INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_reconcile_room();
CREATE TRIGGER trg_ie_reconcile_room_upd
  AFTER UPDATE OF room_id, contract_id, approval_status, deleted_at, type ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_reconcile_room();
CREATE TRIGGER trg_ie_reconcile_room_del AFTER DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_reconcile_room();

-- 2c) Trigger trên income_expense_items (thêm/bớt item cọc làm ie_has_deposit_item đổi).
CREATE OR REPLACE FUNCTION public.trg_ie_items_reconcile_room()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room_id uuid;
BEGIN
  SELECT room_id INTO v_room_id FROM income_expenses
  WHERE id = CASE WHEN TG_OP='DELETE' THEN OLD.income_expense_id ELSE NEW.income_expense_id END;
  PERFORM recompute_room_reservation(v_room_id);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_ie_items_reconcile_room ON public.income_expense_items;
CREATE TRIGGER trg_ie_items_reconcile_room
  AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_items_reconcile_room();

-- 2d) Trigger trên rooms: mỗi khi phòng được set về AVAILABLE (thanh lý HĐ, RPC
--     transfer/terminate, sửa tay) → reconcile để nếu còn cọc thì thành RESERVED.
--     An toàn đệ quy: WHEN chỉ chạy khi NEW.status='AVAILABLE'; recompute set
--     RESERVED có NEW='RESERVED' (WHEN sai, dừng); set AVAILABLE khi đã AVAILABLE = no-op.
CREATE OR REPLACE FUNCTION public.trg_room_status_reconcile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM recompute_room_reservation(NEW.id);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_room_status_reconcile ON public.rooms;
CREATE TRIGGER trg_room_status_reconcile
  AFTER UPDATE OF status ON public.rooms
  FOR EACH ROW WHEN (NEW.status = 'AVAILABLE')
  EXECUTE FUNCTION public.trg_room_status_reconcile();

-- 3) Backfill: đồng bộ mọi phòng hiện có (set RESERVED nếu có cọc; dọn RESERVED tay cũ không cọc).
DO $$
DECLARE r RECORD; v_n int := 0;
BEGIN
  FOR r IN SELECT id FROM public.rooms WHERE deleted_at IS NULL LOOP
    PERFORM public.recompute_room_reservation(r.id);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'room_reservation backfill: reconciled % rooms', v_n;
END $$;
