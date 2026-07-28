begin;

-- =====================================================================
-- B8 — Nhượng hợp đồng KHÔNG để lại dấu vết audit nào.
--
-- Nguyên nhân (đo trên prod 28/07/2026):
--   * contract_transfers.old_tenant_id / new_tenant_id FK -> tenants(id),
--     nhưng transfer_contract_impl() truyền customers.id.
--     tenants 9 dòng (100% org DEMO), customers 512 dòng, giao id = 0
--     => mọi INSERT vi phạm FK 23503.
--   * CHECK transfers_tenant_change_requires_tenants đòi old_tenant_id NOT NULL,
--     266/271 HĐ đang hiệu lực có contracts.tenant_id IS NULL => 23514.
--   * Cả hai bị nuốt bởi `EXCEPTION WHEN OTHERS THEN NULL`
--     => 0 dòng TENANT_CHANGE tồn tại từ trước tới nay.
--
-- KHÔNG đụng tới tiền: contract_transfers không có view/hàm nào đọc, không nằm
-- trong fa_* / _profit_close_preview_core_v2, không sinh item kế toán.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) CHECK: chỉ bắt buộc BÊN NHẬN.
--    5 HĐ đang hiệu lực (đúng 5 HĐ DEMO legacy) không có contract_customers
--    => bên nhượng hợp lệ là NULL, không được fail.  Đo trước: 0 dòng vi phạm.
-- ---------------------------------------------------------------------
ALTER TABLE public.contract_transfers
  DROP CONSTRAINT transfers_tenant_change_requires_tenants;

ALTER TABLE public.contract_transfers
  ADD CONSTRAINT transfers_tenant_change_requires_new_party
  CHECK (transfer_type <> 'TENANT_CHANGE' OR new_tenant_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- 2) FK: tenants(id) -> customers(id).
--    Đo trước: 0 dòng có old/new_tenant_id NOT NULL => validate tức thì.
--    ON DELETE RESTRICT = viết rõ ngữ nghĩa NO ACTION hiện tại, KHÔNG đổi hành vi.
--    (KHÔNG dùng SET NULL: new_tenant_id NULL sẽ vi phạm CHECK bước 1, lỗi xoá
--     khách sẽ hiện thành 23514 khó hiểu thay vì 23503.)
-- ---------------------------------------------------------------------
ALTER TABLE public.contract_transfers
  DROP CONSTRAINT contract_transfers_old_tenant_id_fkey;
ALTER TABLE public.contract_transfers
  DROP CONSTRAINT contract_transfers_new_tenant_id_fkey;

ALTER TABLE public.contract_transfers
  ADD CONSTRAINT contract_transfers_old_tenant_id_fkey
  FOREIGN KEY (old_tenant_id) REFERENCES public.customers(id) ON DELETE RESTRICT;

ALTER TABLE public.contract_transfers
  ADD CONSTRAINT contract_transfers_new_tenant_id_fkey
  FOREIGN KEY (new_tenant_id) REFERENCES public.customers(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.contract_transfers.old_tenant_id IS
  'customers(id) của NGƯỜI ĐẠI DIỆN HĐ TRƯỚC khi nhượng (NULL nếu HĐ chưa có contract_customers). Tên cột giữ nguyên vì lịch sử; từ 28/07/2026 FK trỏ public.customers, KHÔNG phải public.tenants.';
COMMENT ON COLUMN public.contract_transfers.new_tenant_id IS
  'customers(id) của NGƯỜI ĐẠI DIỆN HĐ SAU khi nhượng. FK -> public.customers. Bắt buộc NOT NULL khi transfer_type=TENANT_CHANGE.';

-- ---------------------------------------------------------------------
-- 3) transfer_contract_impl — GIỮ NGUYÊN CHỮ KÝ (tránh overload/PGRST203;
--    CREATE OR REPLACE cũng giữ nguyên ACL sẵn có).
--    Đổi 4 điểm:
--      a) chốt đại diện cũ TRƯỚC lệnh hạ toàn bộ is_representative
--      b) ghi customers.id thay vì contracts.tenant_id
--      c) bỏ EXCEPTION WHEN OTHERS THEN NULL -> audit hỏng thì huỷ luôn nhượng
--      d) user_id = người thao tác (auth.uid()), fallback chủ HĐ
--    KHÔNG set old_room_id/new_room_id: realEstateReports lọc transfers theo
--    old_room_id để gắn nhãn "Sang nhượng" cho phòng TRỐNG — nhượng HĐ không
--    làm trống phòng, điền vào sẽ đẻ ra lý do trống phòng ma.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_contract_impl(
  p_contract_id uuid,
  p_new_customer_id uuid,
  p_new_rent_price numeric DEFAULT NULL::numeric,
  p_new_deposit numeric DEFAULT NULL::numeric,
  p_transfer_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_contract     RECORD;
  v_existing     uuid;
  v_old_customer uuid;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE','EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ nhượng được khi hợp đồng đang hiệu lực';
  END IF;

  IF p_new_customer_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu khách hàng mới';
  END IF;

  -- Báo lỗi tiếng Việt thay vì để FK 23503 thô nổ ở cuối hàm.
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_new_customer_id) THEN
    RAISE EXCEPTION 'Khách hàng mới không tồn tại';
  END IF;

  -- (a) CHỐT bên nhượng TRƯỚC khi hạ đại diện. Đọc sau lệnh UPDATE bên dưới
  --     sẽ luôn ra NULL (không còn ai is_representative) hoặc mới->mới.
  SELECT cc.customer_id INTO v_old_customer
    FROM contract_customers cc
   WHERE cc.contract_id = p_contract_id
     AND cc.is_representative
   LIMIT 1;

  -- Demote everyone, promote/insert the new representative.
  UPDATE contract_customers
     SET is_representative = false,
         updated_at = NOW()
   WHERE contract_id = p_contract_id;

  SELECT id INTO v_existing
    FROM contract_customers
   WHERE contract_id = p_contract_id
     AND customer_id = p_new_customer_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE contract_customers
       SET is_representative = true,
           updated_at = NOW()
     WHERE id = v_existing;
  ELSE
    INSERT INTO contract_customers (contract_id, customer_id, is_representative, notes)
    VALUES (p_contract_id, p_new_customer_id, true,
            CASE WHEN p_notes IS NULL OR length(btrim(p_notes))=0 THEN NULL
                 ELSE '[Nhượng HĐ] ' || p_notes
            END);
  END IF;

  -- Giá / cọc / ghi chú trên HĐ (KHÔNG đụng deposit_paid; KHÔNG nêu tên
  -- deposit_remaining vì là cột GENERATED -> 428C9).
  UPDATE contracts
     SET rent_price    = COALESCE(p_new_rent_price, rent_price),
         total_deposit = COALESCE(p_new_deposit,    total_deposit),
         notes         = CASE
                           WHEN p_notes IS NULL OR length(btrim(p_notes))=0 THEN notes
                           WHEN notes  IS NULL OR length(btrim(notes)) = 0 THEN p_notes
                           ELSE notes || E'\n[Nhượng HĐ ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                         END,
         updated_at    = NOW()
   WHERE id = p_contract_id;

  -- (b)(c)(d) Audit row — KHÔNG còn EXCEPTION WHEN OTHERS THEN NULL.
  INSERT INTO contract_transfers (
    user_id, contract_id, transfer_type, transfer_date,
    old_tenant_id, new_tenant_id,
    new_rent_price, new_deposit,
    reason, status, approved_at
  ) VALUES (
    COALESCE(auth.uid(), v_contract.user_id),
    p_contract_id, 'TENANT_CHANGE', p_transfer_date,
    v_old_customer, p_new_customer_id,
    p_new_rent_price, p_new_deposit,
    p_notes, 'COMPLETED', NOW()
  );

  RETURN p_contract_id;
END;
$fn$;

-- ---------------------------------------------------------------------
-- 4) apply_contract_transfer — chặn đường duyệt tay DRAFT->APPROVED cho các
--    loại đổi bên thuê.  BẮT BUỘC nằm trong CÙNG migration:
--    trigger này ghi contracts.tenant_id := NEW.new_tenant_id, mà
--    contracts.tenant_id vẫn FK -> tenants(id). Sau bước 2, new_tenant_id là
--    customers.id => 23503; và trước khi nổ nó còn kịp đẩy HĐ sang
--    status='TRANSFERRED' + parent_contract_id=id.
--    Trigger CHƯA TỪNG chạy trên prod (3/3 dòng insert thẳng COMPLETED,
--    updated_at = created_at, 0 dòng từng bị UPDATE) và không nơi nào trong
--    src/ update contract_transfers => chặn là an toàn tuyệt đối.
--    Dòng `tenant_id = COALESCE(NEW.new_tenant_id, tenant_id)` bị GỠ HẲN:
--    với ROOM_CHANGE new_tenant_id luôn NULL nên là no-op, nhưng nếu ai chèn
--    tay ROOM_CHANGE kèm new_tenant_id thì nó lại nổ 23503.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_contract_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE
  v_contract RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
      RAISE EXCEPTION 'Nhượng hợp đồng phải đi qua RPC transfer_contract(); không duyệt tay contract_transfers (cột new_tenant_id nay là customers.id, không phải tenants.id)'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_contract FROM contracts WHERE id = NEW.contract_id;

    UPDATE contracts
    SET
      room_id            = COALESCE(NEW.new_room_id, room_id),
      rent_price         = COALESCE(NEW.new_rent_price, rent_price),
      total_deposit      = COALESCE(NEW.new_deposit, total_deposit),
      start_date         = COALESCE(NEW.new_start_date, start_date),
      end_date           = COALESCE(NEW.new_end_date, end_date),
      status             = 'TRANSFERRED',
      parent_contract_id = id,
      updated_at         = NOW()
    WHERE id = NEW.contract_id;

    IF NEW.transfer_type IN ('ROOM_CHANGE', 'BOTH_CHANGE') THEN
      IF NEW.old_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'AVAILABLE', updated_at = NOW()
        WHERE id = NEW.old_room_id
          AND NOT EXISTS (
            SELECT 1 FROM contracts
            WHERE room_id = NEW.old_room_id
              AND id != NEW.contract_id
              AND status = 'ACTIVE'
              AND deleted_at IS NULL
          );
      END IF;

      IF NEW.new_room_id IS NOT NULL THEN
        UPDATE rooms
        SET status = 'OCCUPIED', updated_at = NOW()
        WHERE id = NEW.new_room_id;
      END IF;
    END IF;

    IF NEW.new_services IS NOT NULL AND jsonb_array_length(NEW.new_services) > 0 THEN
      DELETE FROM contract_services WHERE contract_id = NEW.contract_id;

      INSERT INTO contract_services (contract_id, service_id, unit_price)
      SELECT
        NEW.contract_id,
        (service->>'service_id')::UUID,
        (service->>'unit_price')::DECIMAL(15,2)
      FROM jsonb_array_elements(NEW.new_services) AS service;
    END IF;

    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------
-- 5) create_tenant_transfer — GỠ BỎ (không port).
--    * proacl = {postgres,service_role} => KHÔNG cấp cho authenticated,
--      trình duyệt không gọi được.
--    * 0 nơi tham chiếu trong src/ (chỉ xuất hiện trong types.ts sinh tự động)
--      và 0 hàm SQL nào gọi (quét pg_proc.prosrc).
--    * 0 dòng TENANT_CHANGE từng tồn tại => nó CHƯA BAO GIỜ chạy thành công.
--    * Nó ghi tenants.id; sau bước 2 mọi lời gọi sẽ nổ 23503, và nó KHÔNG có
--      exception handler.
--    * Nó tạo dòng DRAFT — đúng đường mà bước 4 vừa chặn.
--    => Port lại là vô nghĩa: transfer_contract() đã làm đúng việc đó.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_tenant_transfer(uuid, uuid, date, numeric, text);
notify pgrst, 'reload schema';

commit;
