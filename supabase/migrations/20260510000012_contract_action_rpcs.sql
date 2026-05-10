-- =============================================================================
-- Contract action RPCs to match the FE in src/hooks/useContractOperations.ts.
--
-- The FE was calling these names but the DB only had the older 2-step
-- "DRAFT → APPROVED" workflow (create_room_transfer / create_new_contract_extension).
-- The list-page dialogs expect the action to take effect immediately, so we
-- expose thin RPCs that:
--   • renew_contract            – update end_date / price / deposit in place
--   • transfer_room             – change room/bed (room/bed status is updated
--                                  by the existing update_room_bed_status_on_contract_change trigger)
--   • transfer_contract         – swap the representative customer
--   • terminate_contract_forfeit  – contract → TERMINATED, deposit recorded as revenue
--   • terminate_contract_move_out – contract → TERMINATED + settlement invoice
--                                    (refund/penalty/excess rent)
-- =============================================================================

-- ── helper: free room/bed when contract leaves ACTIVE ──────────────────────
-- (We rely on the existing update_room_bed_status_on_contract_change trigger
--  to do this automatically when contracts.status flips ACTIVE→TERMINATED.)


-- =============================================================================
-- renew_contract — extend an active contract in place
-- =============================================================================
CREATE OR REPLACE FUNCTION public.renew_contract(
  p_contract_id    uuid,
  p_new_end_date   date,
  p_new_rent_price numeric DEFAULT NULL,
  p_new_deposit    numeric DEFAULT NULL,
  p_notes          text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract RECORD;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ gia hạn được hợp đồng đang hiệu lực (status hiện tại: %)', v_contract.status;
  END IF;

  IF p_new_end_date IS NULL OR p_new_end_date <= v_contract.end_date THEN
    RAISE EXCEPTION 'Ngày kết thúc mới phải sau ngày kết thúc hiện tại (%)', v_contract.end_date;
  END IF;

  UPDATE contracts
     SET end_date     = p_new_end_date,
         rent_price   = COALESCE(p_new_rent_price, rent_price),
         total_deposit= COALESCE(p_new_deposit,    total_deposit),
         status       = 'EXTENDED',
         notes        = CASE
                          WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                          WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                          ELSE notes || E'\n[Gia hạn] ' || p_notes
                        END,
         updated_at   = NOW()
   WHERE id = p_contract_id;

  -- Audit row in contract_extensions (best-effort; ignore if cols differ).
  BEGIN
    INSERT INTO contract_extensions (
      user_id, contract_id, extension_type,
      old_end_date, new_end_date,
      new_rent_price, rent_price_changed,
      new_deposit,   deposit_changed,
      notes, status
    ) VALUES (
      v_contract.user_id, p_contract_id, 'UPDATE_EXISTING',
      v_contract.end_date, p_new_end_date,
      p_new_rent_price, (p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_contract.rent_price),
      p_new_deposit,    (p_new_deposit    IS NOT NULL AND p_new_deposit    <> v_contract.total_deposit),
      p_notes, 'COMPLETED'
    );
  EXCEPTION WHEN OTHERS THEN
    -- audit row is non-critical
    NULL;
  END;

  RETURN p_contract_id;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_contract(uuid,date,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.renew_contract(uuid,date,numeric,numeric,text) TO authenticated;


-- =============================================================================
-- transfer_room — move active contract to a different room/bed
-- =============================================================================
CREATE OR REPLACE FUNCTION public.transfer_room(
  p_contract_id   uuid,
  p_new_room_id   uuid,
  p_new_bed_id    uuid    DEFAULT NULL,
  p_new_rent_price numeric DEFAULT NULL,
  p_transfer_date date    DEFAULT CURRENT_DATE,
  p_notes         text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract  RECORD;
  v_old_room  uuid;
  v_old_bed   uuid;
  v_room_busy boolean;
  v_bed_busy  boolean;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực';
  END IF;

  IF p_new_room_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phòng mới';
  END IF;

  -- Sanity: target room/bed must not be occupied by another active contract.
  SELECT EXISTS (
    SELECT 1 FROM contracts
     WHERE room_id = p_new_room_id
       AND id <> p_contract_id
       AND status IN ('ACTIVE','EXTENDED')
       AND deleted_at IS NULL
  ) INTO v_room_busy;

  IF p_new_bed_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM contracts
       WHERE bed_id = p_new_bed_id
         AND id <> p_contract_id
         AND status IN ('ACTIVE','EXTENDED')
         AND deleted_at IS NULL
    ) INTO v_bed_busy;
  ELSE
    v_bed_busy := false;
  END IF;

  IF v_bed_busy THEN
    RAISE EXCEPTION 'Giường mới đã có hợp đồng đang hiệu lực';
  END IF;
  IF v_room_busy AND p_new_bed_id IS NULL THEN
    RAISE EXCEPTION 'Phòng mới đã có hợp đồng đang hiệu lực';
  END IF;

  v_old_room := v_contract.room_id;
  v_old_bed  := v_contract.bed_id;

  -- Move the contract.
  UPDATE contracts
     SET room_id    = p_new_room_id,
         bed_id     = p_new_bed_id,
         rent_price = COALESCE(p_new_rent_price, rent_price),
         notes      = CASE
                        WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                        WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                        ELSE notes || E'\n[Chuyển phòng ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                      END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- Sync room/bed statuses (the trigger only fires on status change, so
  -- we have to do this by hand for room/bed swaps).
  IF v_old_room IS NOT NULL AND v_old_room <> p_new_room_id THEN
    UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW()
     WHERE id = v_old_room
       AND NOT EXISTS (
         SELECT 1 FROM contracts
          WHERE room_id = v_old_room
            AND id <> p_contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
       );
  END IF;

  IF v_old_bed IS NOT NULL AND v_old_bed IS DISTINCT FROM p_new_bed_id THEN
    UPDATE beds SET status = 'AVAILABLE', updated_at = NOW()
     WHERE id = v_old_bed
       AND NOT EXISTS (
         SELECT 1 FROM contracts
          WHERE bed_id = v_old_bed
            AND id <> p_contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
       );
  END IF;

  UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = p_new_room_id;
  IF p_new_bed_id IS NOT NULL THEN
    UPDATE beds SET status = 'OCCUPIED', updated_at = NOW() WHERE id = p_new_bed_id;
  END IF;

  -- Audit row in contract_transfers.
  BEGIN
    INSERT INTO contract_transfers (
      user_id, contract_id, transfer_type, transfer_date,
      old_room_id, new_room_id, old_bed_id, new_bed_id,
      new_rent_price, move_out_date, move_in_date,
      reason, status, approved_at
    ) VALUES (
      v_contract.user_id, p_contract_id, 'ROOM_CHANGE', p_transfer_date,
      v_old_room, p_new_room_id, v_old_bed, p_new_bed_id,
      p_new_rent_price, p_transfer_date, p_transfer_date,
      p_notes, 'COMPLETED', NOW()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN p_contract_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_room(uuid,uuid,uuid,numeric,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_room(uuid,uuid,uuid,numeric,date,text) TO authenticated;


-- =============================================================================
-- transfer_contract — swap the representative customer on the contract
-- =============================================================================
CREATE OR REPLACE FUNCTION public.transfer_contract(
  p_contract_id    uuid,
  p_new_customer_id uuid,
  p_new_rent_price numeric DEFAULT NULL,
  p_new_deposit    numeric DEFAULT NULL,
  p_transfer_date  date    DEFAULT CURRENT_DATE,
  p_notes          text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract  RECORD;
  v_existing  uuid;
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

  -- Update the legacy single tenant_id for backwards compat + price/deposit.
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

  -- Audit row.
  BEGIN
    INSERT INTO contract_transfers (
      user_id, contract_id, transfer_type, transfer_date,
      old_tenant_id, new_tenant_id,
      new_rent_price, new_deposit,
      reason, status, approved_at
    ) VALUES (
      v_contract.user_id, p_contract_id, 'TENANT_CHANGE', p_transfer_date,
      v_contract.tenant_id, p_new_customer_id,
      p_new_rent_price, p_new_deposit,
      p_notes, 'COMPLETED', NOW()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN p_contract_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_contract(uuid,uuid,numeric,numeric,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_contract(uuid,uuid,numeric,numeric,date,text) TO authenticated;


-- =============================================================================
-- terminate_contract_forfeit — khách bỏ cọc
-- =============================================================================
-- Marks the contract as TERMINATED and creates a settlement invoice that
-- recognises the forfeited deposit as revenue. Invoice is created PAID
-- with a single PENALTY line and prepaid_amount = total_deposit so the
-- ledger balances (no money changes hands now — the deposit was already
-- received when the contract started).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(
  p_contract_id  uuid,
  p_forfeit_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract  RECORD;
  v_building_id uuid;
  v_invoice_id uuid;
  v_deposit   numeric(15,2);
  v_billing   text;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;

  v_deposit := COALESCE(v_contract.total_deposit, 0);
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');

  IF v_contract.room_id IS NOT NULL THEN
    SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  END IF;

  -- Settlement invoice (only if there's actually a deposit to record).
  IF v_deposit > 0 AND v_contract.room_id IS NOT NULL AND v_building_id IS NOT NULL THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, total_amount, prepaid_amount, paid_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_forfeit_date, p_forfeit_date,
      'PAID', v_deposit, v_deposit, v_deposit, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc)',
      v_deposit, 1, 1, v_deposit, 1
    );
  END IF;

  -- Terminate the contract.
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- Audit row in contract_terminations (best-effort).
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — tự động ghi nhận tiền cọc vào doanh thu.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id',  v_invoice_id,
    'forfeit_amount', v_deposit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid,date) TO authenticated;


-- =============================================================================
-- terminate_contract_move_out — khách rời phòng (settlement)
-- =============================================================================
-- The settlement invoice models:
--   subtotal = penalty_fee
--   prepaid_amount = deposit_refund + excess_rent (credits handed back)
--   net = penalty - deposit_refund - excess_rent + outstanding_debt
--
-- We keep outstanding_debt informational (it lives on the original unpaid
-- invoices), so the settlement invoice only carries the new charges and
-- credits introduced by the termination.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(
  p_contract_id     uuid,
  p_move_out_date   date,
  p_deposit_refund  numeric DEFAULT 0,
  p_penalty_fee     numeric DEFAULT 0,
  p_excess_rent     numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes           text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract     RECORD;
  v_building_id  uuid;
  v_invoice_id   uuid;
  v_billing      text;
  v_deposit      numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty      numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess       numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt         numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_subtotal     numeric(15,2);
  v_prepaid      numeric(15,2);
  v_total        numeric(15,2);
  v_status       invoice_status;
  v_sort         integer := 0;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;

  IF v_contract.room_id IS NOT NULL THEN
    SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  END IF;

  v_billing  := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_subtotal := v_penalty;
  v_prepaid  := v_deposit + v_excess;
  v_total    := v_subtotal;

  -- Determine settlement status:
  --   prepaid >= total → PAID (landlord owes the difference / fully balanced)
  --   prepaid <  total → PENDING_APPROVAL (tenant still owes the balance)
  IF v_prepaid >= v_total THEN
    v_status := 'PAID'::invoice_status;
  ELSE
    v_status := 'DRAFT'::invoice_status;
  END IF;

  IF (v_subtotal > 0 OR v_prepaid > 0)
     AND v_contract.room_id IS NOT NULL
     AND v_building_id IS NOT NULL THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, total_amount, prepaid_amount,
      paid_amount, previous_debt, notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_move_out_date, p_move_out_date,
      v_status, v_subtotal, v_total, v_prepaid,
      LEAST(v_prepaid, v_total), v_debt,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY')
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_invoice_id;

    IF v_penalty > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_sort);
    END IF;

    IF v_deposit > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'OTHER', 'Tiền cọc hoàn trả (cấn trừ)', v_deposit, 1, 1, v_deposit, v_sort);
    END IF;

    IF v_excess > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'OTHER', 'Tiền phòng thừa (cấn trừ)', v_excess, 1, 1, v_excess, v_sort);
    END IF;
  END IF;

  -- Terminate the contract.
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_move_out_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                    || COALESCE(E'\n' || p_notes, '')
                             ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                  || COALESCE(E'\n' || p_notes, '')
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- Audit row.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, outstanding_debt,
      early_termination_fee, total_deposit,
      total_deductions, refund_amount,
      status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date,
      'NORMAL', v_debt,
      v_penalty, COALESCE(v_contract.total_deposit, 0),
      v_debt + v_penalty, v_deposit + v_excess - v_debt - v_penalty,
      'COMPLETED', auth.uid(), NOW(), p_notes
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id',  v_invoice_id,
    'subtotal',    v_subtotal,
    'prepaid',     v_prepaid,
    'net_due',     v_total - v_prepaid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) TO authenticated;


-- =============================================================================
-- Storage RLS — let staff read templates owned by anyone in the same tenant.
-- The previous policy only allowed the upload owner to download, so a staff
-- member couldn't print a contract whose template was uploaded by their
-- employer (the print dialog failed with "Không thể tải mẫu").
-- =============================================================================
DROP POLICY IF EXISTS "Users can read own templates"      ON storage.objects;
DROP POLICY IF EXISTS "Tenant can read shared templates"  ON storage.objects;

CREATE POLICY "Tenant can read shared templates"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'document-templates'
    AND (
         (storage.foldername(name))[1] = (auth.uid())::text
      OR ((storage.foldername(name))[1])::uuid = ANY (public.current_visible_owner_ids())
    )
  );
