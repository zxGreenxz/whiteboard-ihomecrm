-- =====================================================================
-- Đồng bộ tiền cọc giữa Thu chi ↔ Hợp đồng ↔ Stats Hoá đơn
--
-- Nguồn duy nhất cho cọc = phiếu thu trong income_expenses có item
-- thuộc loại đánh dấu is_deposit=TRUE. contracts.deposit_paid =
-- SUM(phiếu cọc APPROVED đã link contract).
--
-- Hỗ trợ "cọc trước hợp đồng": IE tạo với room_id (contract_id=NULL),
-- khi contract được INSERT cho cùng room (+tenant nếu có) → trigger
-- tự link và recompute deposit_paid.
-- =====================================================================

-- 1.1. Cờ phân biệt loại "Tiền cọc" --------------------------------------
ALTER TABLE income_expense_types
  ADD COLUMN IF NOT EXISTS is_deposit BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE income_expense_types
SET is_deposit = TRUE
WHERE LOWER(TRIM(name)) IN ('tiền cọc', 'cọc giữ phòng', 'tien coc')
   OR LOWER(TRIM(name)) LIKE '%cọc giữ phòng%';

-- Index hỗ trợ trigger lookup theo type
CREATE INDEX IF NOT EXISTS idx_ie_types_is_deposit
  ON income_expense_types (is_deposit) WHERE is_deposit = TRUE;

CREATE INDEX IF NOT EXISTS idx_ie_contract_id
  ON income_expenses (contract_id) WHERE contract_id IS NOT NULL;


-- 1.2. Function recompute deposit_paid cho 1 contract --------------------
-- LƯU Ý: chỉ ghi đè deposit_paid khi có ít nhất 1 IE cọc APPROVED đã link.
-- Nếu chưa có IE cọc nào thì để nguyên (bảo toàn giá trị từ flow cũ
-- CreateDepositDialog → trigger auto_calculate_deposit_paid lúc tạo HĐ).
CREATE OR REPLACE FUNCTION recompute_contract_deposit_paid(p_contract_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC(15,2) := 0;
  v_count INT := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(ie.total_amount), 0), COUNT(*)
  INTO v_total, v_count
  FROM income_expenses ie
  WHERE ie.contract_id = p_contract_id
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id
        AND t.is_deposit = TRUE
    );

  -- Chỉ ghi đè khi có IE cọc thực sự → tránh đè 0 lên giá trị từ deposits.
  IF v_count > 0 THEN
    UPDATE contracts
    SET deposit_paid = v_total,
        updated_at = NOW()
    WHERE id = p_contract_id
      AND deleted_at IS NULL;
  END IF;
END;
$$;


-- Helper: kiểm tra 1 IE có chứa item is_deposit hay không
CREATE OR REPLACE FUNCTION ie_has_deposit_item(p_ie_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id = p_ie_id
      AND t.is_deposit = TRUE
  );
$$;


-- 1.3. Trigger trên income_expenses: recompute khi IE cọc thay đổi --------
-- Chạy AFTER (cần thấy items đã insert/update). Đối với DELETE chỉ cần
-- recompute contract cũ.
CREATE OR REPLACE FUNCTION trg_ie_recompute_contract_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.contract_id IS NOT NULL AND ie_has_deposit_item(OLD.id) THEN
      PERFORM recompute_contract_deposit_paid(OLD.contract_id);
    END IF;
    RETURN NULL;
  END IF;

  -- INSERT / UPDATE: recompute contract mới (nếu có item cọc)
  IF NEW.contract_id IS NOT NULL AND ie_has_deposit_item(NEW.id) THEN
    PERFORM recompute_contract_deposit_paid(NEW.contract_id);
  END IF;

  -- UPDATE đổi contract_id → cũng recompute contract cũ
  IF TG_OP = 'UPDATE'
     AND OLD.contract_id IS DISTINCT FROM NEW.contract_id
     AND OLD.contract_id IS NOT NULL
     AND ie_has_deposit_item(OLD.id) THEN
    PERFORM recompute_contract_deposit_paid(OLD.contract_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ie_recompute_contract_deposit_ins ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_recompute_contract_deposit_upd ON income_expenses;
DROP TRIGGER IF EXISTS trg_ie_recompute_contract_deposit_del ON income_expenses;

CREATE TRIGGER trg_ie_recompute_contract_deposit_ins
  AFTER INSERT ON income_expenses
  FOR EACH ROW
  EXECUTE FUNCTION trg_ie_recompute_contract_deposit();

CREATE TRIGGER trg_ie_recompute_contract_deposit_upd
  AFTER UPDATE OF contract_id, approval_status, deleted_at, type, total_amount
  ON income_expenses
  FOR EACH ROW
  EXECUTE FUNCTION trg_ie_recompute_contract_deposit();

CREATE TRIGGER trg_ie_recompute_contract_deposit_del
  AFTER DELETE ON income_expenses
  FOR EACH ROW
  EXECUTE FUNCTION trg_ie_recompute_contract_deposit();


-- Trigger trên income_expense_items: khi items thay đổi → recompute contract
-- (giả sử IE và items được insert trong cùng transaction; trigger items
-- chạy sau trigger IE nhưng đảm bảo nếu user thêm/xoá item sau cũng đúng)
CREATE OR REPLACE FUNCTION trg_ie_items_recompute_contract_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT contract_id INTO v_contract_id
    FROM income_expenses
    WHERE id = OLD.income_expense_id;
  ELSE
    SELECT contract_id INTO v_contract_id
    FROM income_expenses
    WHERE id = NEW.income_expense_id;
  END IF;

  IF v_contract_id IS NOT NULL THEN
    PERFORM recompute_contract_deposit_paid(v_contract_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ie_items_recompute_deposit ON income_expense_items;

CREATE TRIGGER trg_ie_items_recompute_deposit
  AFTER INSERT OR UPDATE OR DELETE ON income_expense_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_ie_items_recompute_contract_deposit();


-- 1.4. Giữ auto_calculate_deposit_paid để flow cũ (CreateDepositDialog
-- → bảng `deposits`) vẫn hoạt động. Khi user dùng flow này, deposit_paid
-- vẫn được set từ deposits lúc INSERT HĐ. Nếu sau đó có IE cọc link, recompute
-- sẽ override theo IE (xem 1.2 — chỉ override khi v_count > 0).
-- Function gốc ở migration 012_auto_deposit_calculation.sql vẫn còn nguyên.


-- 1.5. Auto-link orphan IE cọc khi tạo HĐ ------------------------------
CREATE OR REPLACE FUNCTION trg_contract_link_orphan_deposits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.room_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Match: cùng room, voucher_date <= ngày bắt đầu HĐ, tenant tương thích
  -- (NULL tenant ở IE coi như match mọi tenant — flow cọc trước HĐ thường
  -- chưa biết tenant cụ thể).
  UPDATE income_expenses ie
  SET contract_id = NEW.id,
      updated_at = NOW()
  WHERE ie.contract_id IS NULL
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.room_id = NEW.room_id
    AND (NEW.tenant_id IS NULL OR ie.tenant_id IS NULL OR ie.tenant_id = NEW.tenant_id)
    AND ie.voucher_date <= NEW.start_date + INTERVAL '7 days'
    AND ie_has_deposit_item(ie.id);

  -- Recompute deposit_paid sau khi đã link
  PERFORM recompute_contract_deposit_paid(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contract_link_orphan_deposits ON contracts;

CREATE TRIGGER trg_contract_link_orphan_deposits
  AFTER INSERT ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION trg_contract_link_orphan_deposits();


-- 1.6.b. Mở rộng get_invoice_statistics_v2 thêm deposit_collected -----
-- v2 là RPC FE thực sự gọi (xem src/hooks/useInvoices.ts:768).
CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(
  p_building_id    UUID DEFAULT NULL,
  p_room_id        UUID DEFAULT NULL,
  p_status         invoice_status DEFAULT NULL,
  p_start_date     DATE DEFAULT NULL,
  p_end_date       DATE DEFAULT NULL,
  p_billing_month  TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL,
  p_area_id        UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT         := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
BEGIN
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    LEFT JOIN public.buildings b ON b.id = i.building_id
    WHERE i.deleted_at IS NULL
      AND public.can_access_building(i.building_id)
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO v_total_amount, v_total_paid, v_total_remaining, v_total_refunded, v_total_count
  FROM filtered_invoices;

  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO v_rent_amount, v_electric_amount, v_water_amount, v_pdv_amount
  FROM public.invoices i
  LEFT JOIN public.buildings b ON b.id = i.building_id
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM public.income_expenses ie
  JOIN public.invoices i ON i.id = ie.invoice_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- Cọc đã thu (mới) — filter theo ie.building_id/room_id/voucher_date.
  SELECT COALESCE(SUM(ie.total_amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id = ie.building_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND public.can_access_building(ie.building_id)
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id        = p_area_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
    AND EXISTS (
      SELECT 1
      FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
    );

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$$;


-- 1.6. Mở rộng get_invoice_statistics thêm deposit_collected -----------
-- Định nghĩa lại RPC, giữ nguyên signature + logic cũ, chỉ thêm trường
-- deposit_collected từ income_expenses (item is_deposit=true).
CREATE OR REPLACE FUNCTION public.get_invoice_statistics(
  p_user_id        UUID,
  p_building_id    UUID DEFAULT NULL,
  p_room_id        UUID DEFAULT NULL,
  p_status         invoice_status DEFAULT NULL,
  p_start_date     DATE DEFAULT NULL,
  p_end_date       DATE DEFAULT NULL,
  p_billing_month  TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL,
  p_bed_id         UUID DEFAULT NULL,
  p_area_id        UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller            UUID := auth.uid();
  v_is_super          BOOLEAN := FALSE;
  v_owner             UUID;
  v_staff_buildings   UUID[];
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
BEGIN
  -- 1) Determine effective owner & staff building scope.
  IF v_caller IS NULL THEN
    v_owner := p_user_id;
    v_staff_buildings := NULL;
  ELSE
    SELECT EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = v_caller)
      INTO v_is_super;

    IF v_is_super THEN
      v_owner := COALESCE(p_user_id, v_caller);
      v_staff_buildings := NULL;
    ELSE
      SELECT sa.user_id INTO v_owner
      FROM staff_assignments sa
      WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
      LIMIT 1;

      IF v_owner IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NULL
        ) THEN
          v_staff_buildings := NULL;
        ELSE
          SELECT array_agg(building_id) INTO v_staff_buildings
          FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NOT NULL;
        END IF;
      ELSE
        v_owner := v_caller;
        v_staff_buildings := NULL;
      END IF;
    END IF;
  END IF;

  -- 2) Aggregates trên bảng invoices
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM invoices i
    LEFT JOIN buildings b ON b.id = i.building_id
    WHERE i.user_id = v_owner
      AND i.deleted_at IS NULL
      AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
      AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO
    v_total_amount,
    v_total_paid,
    v_total_remaining,
    v_total_refunded,
    v_total_count
  FROM filtered_invoices;

  -- 3) Breakdown Điện/Nước/PDV
  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO
    v_rent_amount,
    v_electric_amount,
    v_water_amount,
    v_pdv_amount
  FROM invoices i
  LEFT JOIN buildings b ON b.id = i.building_id
  JOIN invoice_items ii ON ii.invoice_id = i.id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 4) Tổng tiền thu + chia theo phương thức (payments của HĐ)
  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0)
  INTO
    v_total_collected,
    v_payment_tm,
    v_payment_tk,
    v_payment_tt
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 5) Tiền Thối
  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM income_expenses ie
  JOIN invoices i ON i.id = ie.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE ie.user_id = v_owner
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- 6) Cọc đã thu — phiếu IE INCOME APPROVED có item is_deposit=true
  --    Filter theo area/building/room dựa trên ie.building_id, ie.room_id
  --    (không qua invoice vì cọc trước HĐ chưa có invoice).
  --    Filter thời gian: voucher_date trong khoảng start/end hoặc
  --    billing_month (YYYY-MM của voucher_date).
  SELECT COALESCE(SUM(ie.total_amount), 0)
  INTO v_deposit_collected
  FROM income_expenses ie
  LEFT JOIN buildings b ON b.id = ie.building_id
  WHERE ie.user_id = v_owner
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_staff_buildings IS NULL OR ie.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id        = p_area_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
    AND EXISTS (
      SELECT 1
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
    );

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$$;


-- 1.7. Backfill dữ liệu hiện hữu --------------------------------------
-- Pha 1: link orphan IE cọc với contracts đã tồn tại. Rule an toàn:
--   • chỉ link với HĐ status ACTIVE/EXTENDED
--   • chỉ link nếu HĐ hiện chưa có cọc nào (deposit_paid IS NULL hoặc = 0)
--     → tránh double-count khi đã có cọc khác link
--   • voucher_date trong cửa sổ [start_date-90d, end_date OR voucher_date+1y]
--   • mỗi orphan IE chỉ ghép tối đa 1 contract (LATERAL LIMIT 1, ưu tiên
--     contract mới nhất theo start_date).
DO $$
DECLARE
  v_linked_count INT := 0;
BEGIN
  WITH candidates AS (
    SELECT ie.id AS ie_id, c.id AS contract_id
    FROM income_expenses ie
    LEFT JOIN LATERAL (
      SELECT c.* FROM contracts c
      WHERE c.room_id = ie.room_id
        AND c.deleted_at IS NULL
        AND c.status IN ('ACTIVE','EXTENDED')
        AND (c.deposit_paid IS NULL OR c.deposit_paid = 0)
        AND (c.tenant_id IS NULL OR ie.tenant_id IS NULL OR ie.tenant_id = c.tenant_id)
        AND ie.voucher_date BETWEEN c.start_date - INTERVAL '90 days'
                                AND COALESCE(c.end_date, ie.voucher_date + INTERVAL '1 year')
      ORDER BY c.start_date DESC
      LIMIT 1
    ) c ON TRUE
    WHERE ie.contract_id IS NULL
      AND ie.deleted_at IS NULL
      AND ie.type = 'INCOME'
      AND ie.room_id IS NOT NULL
      AND ie.approval_status = 'APPROVED'
      AND ie_has_deposit_item(ie.id)
      AND c.id IS NOT NULL
  ),
  linked AS (
    UPDATE income_expenses ie
    SET contract_id = candidates.contract_id,
        updated_at  = NOW()
    FROM candidates
    WHERE ie.id = candidates.ie_id
    RETURNING ie.id
  )
  SELECT COUNT(*) INTO v_linked_count FROM linked;

  RAISE NOTICE 'deposit_unify backfill: linked % orphan IE rows', v_linked_count;
END;
$$;

-- Pha 2: recompute deposit_paid cho mọi contract đã có IE cọc link
DO $$
DECLARE
  v_contract RECORD;
  v_recomputed INT := 0;
BEGIN
  FOR v_contract IN
    SELECT DISTINCT ie.contract_id AS id
    FROM income_expenses ie
    WHERE ie.contract_id IS NOT NULL
      AND ie.deleted_at IS NULL
      AND ie.type = 'INCOME'
      AND ie.approval_status = 'APPROVED'
      AND ie_has_deposit_item(ie.id)
  LOOP
    PERFORM recompute_contract_deposit_paid(v_contract.id);
    v_recomputed := v_recomputed + 1;
  END LOOP;

  RAISE NOTICE 'deposit_unify backfill: recomputed % contracts', v_recomputed;
END;
$$;
