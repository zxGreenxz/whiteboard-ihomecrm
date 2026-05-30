-- =============================================================================
-- terminate_contract_forfeit: cho phép thanh lý bỏ cọc khi tháng đó đã có hoá
-- đơn THU MỘT PHẦN / TOÀN BỘ.
--
-- Trước đây: nếu trong tháng thanh lý tồn tại hoá đơn có paid_amount > 0 (chưa
-- CANCELLED) → RAISE EXCEPTION, chặn thanh lý ("hãy xử lý hoá đơn này trước...").
-- Phần auto-huỷ chỉ huỷ hoá đơn paid_amount = 0. Hệ quả: khách bỏ cọc mà đã đóng
-- một phần tiền phòng (vd 850k/5.2tr) thì KHÔNG thể thanh lý từ UI.
--
-- Quy ước nghiệp vụ (đã chốt với chủ nhà): khách bỏ cọc mất luôn số tiền đã đóng.
-- Vì vậy:
--   * Hoá đơn tháng đó ĐÃ THU một phần/toàn bộ → chuyển CANCELLED nhưng GIỮ
--     NGUYÊN payment + phiếu thu (sổ quỹ): số đã thu được giữ lại làm doanh thu,
--     phần còn nợ bị huỷ. (KHÔNG xoá payment như super-admin force-cancel.)
--   * Hoá đơn CHƯA thu của tháng đó → huỷ tự động (như cũ).
-- Sau đó vẫn lập hoá đơn phạt = tiền cọc và thanh lý hợp đồng như trước.
--
-- "Huỷ phần nợ" được thực hiện ở mức DỮ LIỆU: hạ total_amount của hoá đơn bị huỷ
-- về đúng số đã thu (paid_amount, hoặc 0 nếu chưa thu) → remaining_amount (cột
-- GENERATED = total_amount - paid_amount) thành 0. Nhờ vậy phần nợ đã huỷ KHÔNG
-- còn cộng vào "Phải thu" (get_invoice_statistics_v2 sum remaining_amount của mọi
-- HĐ chưa xoá, kể cả CANCELLED), trong khi paid_amount giữ nguyên nên số đã thu
-- vẫn nằm trong "Đã thu". Bất biến total_amount = paid_amount + remaining_amount
-- vẫn đúng.
--
-- Không còn RAISE EXCEPTION chặn — staff thanh lý bỏ cọc được ngay từ UI.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_kept_paid      numeric(15,2);   -- tổng tiền đã thu được GIỮ LẠI làm doanh thu
  v_paid_cnt       integer;         -- số HĐ đã thu (giữ tiền) bị huỷ
  v_unpaid_cnt     integer;         -- số HĐ chưa thu bị huỷ
  v_cancelled_cnt  integer;         -- tổng HĐ bị huỷ
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

  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- ── Tổng tiền đã thu của tháng đó (sẽ GIỮ LẠI làm doanh thu) ───────────
  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id   = p_contract_id
     AND billing_month = v_billing
     AND deleted_at    IS NULL
     AND status        <> 'CANCELLED'
     AND COALESCE(paid_amount, 0) > 0;

  -- ── Huỷ HĐ ĐÃ THU một phần/toàn bộ — GIỮ payment/phiếu thu làm doanh thu ──
  -- total_amount hạ về paid_amount (huỷ phần nợ) → remaining_amount = 0.
  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY')
                               || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                               || 'đ đã thu làm doanh thu, huỷ phần nợ '
                               || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                        ELSE notes
                             || E'\n[Huỷ — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY')
                             || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                             || 'đ đã thu làm doanh thu, huỷ phần nợ '
                             || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                      END,
         updated_at = NOW()
   WHERE contract_id   = p_contract_id
     AND billing_month = v_billing
     AND deleted_at    IS NULL
     AND status        <> 'CANCELLED'
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  -- ── Huỷ tự động mọi hoá đơn CHƯA thu của tháng đó (total_amount → 0) ────
  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at   = NOW()
   WHERE contract_id   = p_contract_id
     AND billing_month = v_billing
     AND deleted_at    IS NULL
     AND status        <> 'CANCELLED'
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  -- ── Settlement invoice — penalty = forfeited deposit ──────────────────
  IF v_deposit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt
                       || ' hoá đơn của tháng ' || v_billing
                       || CASE WHEN v_kept_paid > 0
                                 THEN '; giữ lại ' || round(v_kept_paid)::bigint
                                      || 'đ đã thu làm doanh thu'
                                 ELSE '' END
                       || ')'
                  ELSE '' END
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

  -- ── Terminate the contract (room/bed freed by trigger) ────────────────
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

  -- ── Audit row ────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — chờ ghi nhận thanh toán để lập phiếu thu.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu của tháng ' || v_billing || ' làm doanh thu.'
                  ELSE '' END
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',        p_contract_id,
    'invoice_id',         v_invoice_id,
    'forfeit_amount',     v_deposit,
    'cancelled_invoices', v_cancelled_cnt,
    'kept_paid_amount',   v_kept_paid
  );
END;
$function$;

-- CREATE OR REPLACE giữ nguyên quyền cũ; signature (uuid,date) không đổi nên
-- PostgREST không cần reload — NOTIFY chỉ để đồng bộ theo convention của repo.
NOTIFY pgrst, 'reload schema';
