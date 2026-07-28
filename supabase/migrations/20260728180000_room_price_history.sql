-- =====================================================================
-- LỊCH SỬ GIÁ PHÒNG (room_price_history)
--
-- Bối cảnh
-- ────────
-- Form "Tạo hợp đồng mới" nay load sẵn GIÁ MẶC ĐỊNH của phòng
-- (rooms.rent_price) vào ô "Tiền thuê", và tiền cọc mặc định bám theo tiền
-- thuê. Người dùng có thể mở khoá (nút bút chì) để ký giá khác. Khi đó cần
-- LƯU DẤU lại: giá phòng vốn là bao nhiêu, HĐ ký bao nhiêu, cọc có bị
-- tăng/giảm so với tiền thuê không — để quản lý đối chiếu về sau.
--
-- QUYẾT ĐỊNH (chủ nhà chốt 28/07/2026): ký HĐ giá khác KHÔNG ghi đè
-- rooms.rent_price. Giá phòng vẫn là giá niêm yết cho kênh sale; bảng này
-- chỉ ghi NHẬT KÝ. Vì vậy không có trigger nào UPDATE rooms ở đây.
--
-- Nguồn ghi (source)
-- ──────────────────
--   ROOM_EDIT       — sửa giá/cọc trực tiếp trên phòng (dialog Sửa căn hộ).
--                     before = giá cũ của phòng, after = giá mới.
--   CONTRACT_CREATE — ký HĐ mới với giá lệch mặc định.
--                     rent_before  = rooms.rent_price (giá niêm yết),
--                     rent_after   = contracts.rent_price,
--                     dep_before   = contracts.rent_price (cọc mặc định = thuê),
--                     dep_after    = contracts.total_deposit.
--   CONTRACT_EDIT   — sửa giá thuê / tiền cọc trên HĐ đã có.
--                     before = giá trị cũ của HĐ, after = giá trị mới.
--
-- Chỉ ghi khi CÓ LỆCH — HĐ ký đúng giá niêm yết và cọc = tiền thuê thì
-- không sinh dòng nào (tránh nhiễu).
--
-- Idempotent.
-- =====================================================================

BEGIN;

-- ── 1. Bảng nhật ký ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.room_price_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id            uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  -- Denormalize để RLS dùng đúng mẫu set-based như rooms_select_rbac
  -- (building_id IN (SELECT accessible_building_ids())) — không join rooms.
  building_id        uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  source             text NOT NULL,
  contract_id        uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  rent_price_before  numeric(15, 2),
  rent_price_after   numeric(15, 2),
  deposit_before     numeric(15, 2),
  deposit_after      numeric(15, 2),
  note               text,
  changed_by         uuid,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_price_history_source_check
    CHECK (source IN ('ROOM_EDIT', 'CONTRACT_CREATE', 'CONTRACT_EDIT'))
);

COMMENT ON TABLE public.room_price_history IS
  'Nhật ký thay đổi giá thuê / tiền cọc của phòng — append-only, ghi bằng trigger.';

CREATE INDEX IF NOT EXISTS idx_room_price_history_room
  ON public.room_price_history(room_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_price_history_building
  ON public.room_price_history(building_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_price_history_contract
  ON public.room_price_history(contract_id)
  WHERE contract_id IS NOT NULL;

-- ── 2. RLS — đọc theo phạm vi toà nhà, ghi CHỈ qua trigger ─────────────
ALTER TABLE public.room_price_history ENABLE ROW LEVEL SECURITY;

-- Supabase có ALTER DEFAULT PRIVILEGES cấp ALL cho authenticated trên mọi bảng
-- mới trong schema public → phải REVOKE cả `authenticated`, không chỉ anon,
-- rồi cấp lại đúng SELECT. Bảng append-only: mọi INSERT đi qua trigger DEFINER.
REVOKE ALL ON public.room_price_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.room_price_history TO authenticated;

DROP POLICY IF EXISTS room_price_history_select_rbac ON public.room_price_history;
CREATE POLICY room_price_history_select_rbac ON public.room_price_history
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_full_building_scope())
    OR building_id IN (SELECT public.accessible_building_ids())
  );

-- Ẩn dữ liệu toà DEMO khỏi admin thật — y hệt rooms_hide_demo_admin.
DROP POLICY IF EXISTS room_price_history_hide_demo_admin ON public.room_price_history;
CREATE POLICY room_price_history_hide_demo_admin ON public.room_price_history
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (
    (SELECT public.is_super_admin() OR public.is_admin())
    AND building_id IN (SELECT unnest(public.demo_building_ids()))
  ));

-- ── 3. Trigger: sửa giá TRỰC TIẾP trên phòng ──────────────────────────
-- SECURITY DEFINER: bảng không cấp INSERT cho authenticated (append-only,
-- chỉ trigger được ghi). Hàm này KHÔNG kiểm quyền theo current_user nên
-- không dính án lệ "trigger guard phải SECURITY INVOKER" — quyền sửa phòng
-- đã do rooms_update_rbac chặn trước khi trigger chạy.
CREATE OR REPLACE FUNCTION public.log_room_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rent_changed    boolean;
  v_deposit_changed boolean;
BEGIN
  v_rent_changed :=
    COALESCE(NEW.rent_price, 0) IS DISTINCT FROM COALESCE(OLD.rent_price, 0);
  v_deposit_changed :=
    COALESCE(NEW.deposit_amount, 0) IS DISTINCT FROM COALESCE(OLD.deposit_amount, 0);

  IF NOT v_rent_changed AND NOT v_deposit_changed THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.room_price_history (
    room_id, building_id, source, contract_id,
    rent_price_before, rent_price_after,
    deposit_before, deposit_after,
    note, changed_by
  ) VALUES (
    NEW.id, NEW.building_id, 'ROOM_EDIT', NULL,
    OLD.rent_price, NEW.rent_price,
    OLD.deposit_amount, NEW.deposit_amount,
    CASE
      WHEN v_rent_changed AND v_deposit_changed THEN 'Sửa phòng — đổi giá thuê & tiền cọc mặc định'
      WHEN v_rent_changed THEN 'Sửa phòng — đổi giá thuê mặc định'
      ELSE 'Sửa phòng — đổi tiền cọc mặc định'
    END,
    auth.uid()
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_room_price_history() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_rooms_price_history ON public.rooms;
CREATE TRIGGER trg_rooms_price_history
  AFTER UPDATE OF rent_price, deposit_amount ON public.rooms
  FOR EACH ROW
  EXECUTE FUNCTION public.log_room_price_history();

-- ── 4. Trigger: ký / sửa hợp đồng ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_contract_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_building_id     uuid;
  v_room_rent       numeric;
  v_source          text;
  v_rent_before     numeric;
  v_deposit_before  numeric;
  v_rent_changed    boolean;
  v_deposit_changed boolean;
BEGIN
  -- HĐ theo giường (bed_id) không gắn giá phòng → bỏ qua.
  IF NEW.room_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.building_id, r.rent_price
    INTO v_building_id, v_room_rent
  FROM public.rooms r
  WHERE r.id = NEW.room_id;

  IF v_building_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_source         := 'CONTRACT_CREATE';
    v_rent_before    := v_room_rent;       -- giá niêm yết của phòng
    v_deposit_before := NEW.rent_price;    -- cọc mặc định = tiền thuê HĐ
  ELSE
    v_source         := 'CONTRACT_EDIT';
    v_rent_before    := OLD.rent_price;
    v_deposit_before := OLD.total_deposit;
  END IF;

  v_rent_changed :=
    COALESCE(NEW.rent_price, 0) IS DISTINCT FROM COALESCE(v_rent_before, 0);
  v_deposit_changed :=
    COALESCE(NEW.total_deposit, 0) IS DISTINCT FROM COALESCE(v_deposit_before, 0);

  IF NOT v_rent_changed AND NOT v_deposit_changed THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.room_price_history (
    room_id, building_id, source, contract_id,
    rent_price_before, rent_price_after,
    deposit_before, deposit_after,
    note, changed_by
  ) VALUES (
    NEW.room_id, v_building_id, v_source, NEW.id,
    v_rent_before, NEW.rent_price,
    v_deposit_before, NEW.total_deposit,
    CASE
      WHEN v_source = 'CONTRACT_CREATE' AND v_rent_changed AND v_deposit_changed
        THEN 'Ký HĐ — giá thuê khác giá phòng & điều chỉnh cọc'
      WHEN v_source = 'CONTRACT_CREATE' AND v_rent_changed
        THEN 'Ký HĐ — giá thuê khác giá mặc định của phòng'
      WHEN v_source = 'CONTRACT_CREATE'
        THEN 'Ký HĐ — điều chỉnh tiền cọc so với tiền thuê'
      WHEN v_rent_changed AND v_deposit_changed
        THEN 'Sửa HĐ — đổi giá thuê & tiền cọc'
      WHEN v_rent_changed
        THEN 'Sửa HĐ — đổi giá thuê'
      ELSE 'Sửa HĐ — đổi tiền cọc'
    END,
    auth.uid()
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_contract_price_history() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_contracts_price_history_ins ON public.contracts;
CREATE TRIGGER trg_contracts_price_history_ins
  AFTER INSERT ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.log_contract_price_history();

DROP TRIGGER IF EXISTS trg_contracts_price_history_upd ON public.contracts;
CREATE TRIGGER trg_contracts_price_history_upd
  AFTER UPDATE OF rent_price, total_deposit ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.log_contract_price_history();

COMMIT;

NOTIFY pgrst, 'reload schema';
