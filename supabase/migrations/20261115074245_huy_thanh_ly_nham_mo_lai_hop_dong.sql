-- =============================================================================
-- Huỷ một lần thanh lý BẤM NHẦM và mở lại đúng hợp đồng cũ (vá dữ liệu dùng một lần).
--
-- VÌ SAO
--   Ngày 28/08/2026 hợp đồng 5556a56f-… (toà c4eb87df-…) bị thanh lý nhầm qua
--   terminate_contract_move_out_with_credit_v1 → terminate_contract_move_out(_impl):
--   khách vẫn ở và đóng tiền bình thường. Chủ công ty xác nhận ngày 15/11/2026 và
--   chọn mở lại hợp đồng cũ thay vì ký hợp đồng mới. Hệ thống chưa có RPC huỷ
--   thanh lý; từ giao diện thì guard_contract_termination_settlement đông cứng hồ
--   sơ đã quyết toán, còn a05_termination_non_cash_payment_guard chặn sửa/xoá
--   payment cấn trừ với MỌI vai trừ writer có năng lực accounting chain. Nên chỉ
--   vá được bằng migration đi lane migrate:forward.
--
-- LẦN THANH LÝ ĐÓ ĐÃ GHI GÌ (đọc thân terminate_contract_move_out_impl + dữ liệu thật)
--   1. Một hoá đơn kind = SETTLEMENT (khoản thu thêm khi trả phòng).
--   2. Một payment 'CT' (received_amount = 0) gạch hoá đơn đó bằng cọc.
--   3. Cặp bút toán nội bộ ở sổ ảo "Cấn trừ thanh lý": termination.offset (chi,
--      hạng mục cọc ⇒ deposit_paid giảm) + termination.revenue (thu, tính KQKD).
--   4. Phiếu chi hoàn khách termination.refund — ĐÃ đảo bút toán và huỷ qua app
--      ngày 15/11/2026. Migration chỉ KIỂM là nó đã huỷ, không đụng.
--   5. contracts → TERMINATED + actual_end_date; trigger trả phòng về AVAILABLE;
--      status_v2 của khách suy ra MOVED_OUT.
--   6. Một dòng contract_terminations COMPLETED (UNIQUE theo contract_id).
--   7. Một dòng app_private.canonical_write_operations (khoá idempotency của lần
--      bấm). Chỉ chính hàm bọc đọc lại dòng đó theo khoá của lần bấm ⇒ để nguyên.
--   Không có contract_exit_cases, termination_refund_obligations,
--   termination_move_out_authorizations, credit, hay vết cư trú TERMINATED nào —
--   phần kiểm trước bên dưới đòi điều đó, có thì dừng.
--
-- LÀM GÌ (một transaction, dưới vai postgres)
--   a. Ghim trạng thái trước: md5 từng dòng đã đông cứng + giá trị của hợp đồng,
--      phòng, phiếu hoàn khách; mọi bảng phụ có thể sinh ra phải rỗng.
--   b. Xoá payment CT (mở năng lực accounting chain như chính writer thanh lý);
--      hoá đơn quyết toán tự tính lại, rồi chuyển CANCELLED.
--   c. Huỷ cặp bút toán nội bộ bằng finance_v2_transition_owned_approval
--      (CANCELLED / NOT_APPLICABLE) — cùng đường reverse_termination_move_out_pair_v2.
--      Huỷ chân offset ⇒ trigger recompute_contract_deposit_paid đưa cọc về đủ.
--   d. Xoá dòng contract_terminations: bảng không có trạng thái huỷ, và để lại thì
--      UNIQUE(contract_id) chặn lần thanh lý THẬT sau này của chính hợp đồng này.
--   e. Hợp đồng → ACTIVE, actual_end_date NULL (trigger đưa phòng về OCCUPIED);
--      làm tươi status_v2 của khách.
--   f. Ghi accounting_repair_audit: ảnh chụp trước/sau từng dòng + lý do; ghi chú
--      lý do vào hợp đồng, hoá đơn và hai phiếu.
--   g. Kiểm hậu điều kiện ngay trong transaction; lệch là RAISE ⇒ ROLLBACK.
--
-- KỲ ĐÃ CHỐT (chủ đã được báo trước khi áp)
--   Tháng 08/2026 đã chốt lợi nhuận (profit_close_runs) và kỳ ghi nhận đã đóng, nhưng
--   toà này không có dòng profit_monthly tháng 08 nên trigger khoá kỳ không chặn.
--   Huỷ phiếu termination.revenue làm số SỐNG tháng 08 của toà lệch bản chốt (bản chốt
--   vốn đã lệch vì phiếu hoàn khách bị huỷ và phiếu thu tháng 08 nhập bù ngày 15/11).
--   Migration KHÔNG mở/chốt lại kỳ: nó ghi một dòng accounting_integrity_exceptions
--   (CLOSED_PROFIT_PERIOD_CHANGED_BY_REPAIR) để người chốt quyết có chốt lại không.
--   Ảnh chụp finance_*_month_snapshots tháng 08–10 vẫn coi phòng là trống — thiết kế
--   không chụp bù kỳ đã qua (20260728010000); tháng đang mở tự chụp lại.
--
-- IDEMPOTENT: đã có dòng audit của repair_code ⇒ chỉ kiểm hồ sơ thanh lý và payment
-- không sống lại, rồi thoát. Database chỉ-schema (restore drill) ⇒ thoát. Database có
-- dữ liệu mà lệch trạng thái ghim ⇒ RAISE (fail closed), không vá mò.
-- Không ghi số tiền production vào repo: số tiền được ghim qua md5 dòng và so chéo
-- giữa các dòng (phiếu offset = phiếu revenue = payment = hoá đơn = phần cọc đã cấn).
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $huy_thanh_ly$
DECLARE
  c_org        constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_code       constant text := 'MISTAKEN_TERMINATION_UNDO_20261115';
  c_reason     constant text := 'Thanh lý nhầm 28/08/2026 — chủ xác nhận 15/11/2026';
  c_contract   constant uuid := '5556a56f-4eff-4ec1-8441-398884e8d9bc';
  c_building   constant uuid := 'c4eb87df-758d-4e16-82dc-040f49e6adfc';
  c_room       constant uuid := 'b8f21413-2419-4506-9b43-7418e15034de';
  c_customer   constant uuid := '037ec8fb-aa52-4ddd-8c75-192eee1b9b4d';
  c_term       constant uuid := 'f6626b93-1f07-47e2-8ab8-4d98835a325f';
  c_invoice    constant uuid := 'd58243b0-8a7e-41a5-b3de-101e7dfb0a68';
  c_payment    constant uuid := 'e0593585-db2b-4e70-accc-d5d81ec2a1a7';
  c_revenue    constant uuid := '38a5e2ea-a4f5-40a6-adf6-a39b736401e0';
  c_offset     constant uuid := '5d31b4a5-e83d-473a-be77-d9a84d03c3f0';
  c_refund     constant uuid := 'f609be4f-e3fe-4760-a305-2ef2864d89b1';
  c_move_out   constant date := DATE '2026-08-28';

  -- md5(to_jsonb(dòng)::text) đo trên production 15/11/2026, các dòng này đã đông
  -- cứng từ 28/08/2026 (updated_at không đổi). Lệch một byte là dừng.
  c_md5_term        constant text := 'd3d8eedcafedfc495491c347cfa4ed23';
  c_md5_payment     constant text := 'e6dbda9786c2d73f7ee25ef19cbf0246';
  c_md5_invoice     constant text := 'fd80f8e2ba7f49e42d46edfd4fe8dba8';
  c_md5_inv_items   constant text := '9c3aaef011eb9e5107c07007ed80a16a';
  c_md5_revenue     constant text := 'e6180f7204909a8ae6c7723a75cce99c';
  c_md5_offset      constant text := '45e19c0fe00c142cbffc3e17cf868297';
  c_md5_ie_items    constant text := 'e437c5d80af99d1882080a29f4260cb8';

  v_contract   public.contracts%ROWTYPE;
  v_room       public.rooms%ROWTYPE;
  v_customer   public.customers%ROWTYPE;
  v_term       public.contract_terminations%ROWTYPE;
  v_invoice    public.invoices%ROWTYPE;
  v_payment    public.payments%ROWTYPE;
  v_revenue    public.income_expenses%ROWTYPE;
  v_offset     public.income_expenses%ROWTYPE;
  v_refund     public.income_expenses%ROWTYPE;
  v_amount     numeric;
  v_rows       integer;
  v_b_contract jsonb;
  v_b_room     jsonb;
  v_b_customer jsonb;
  v_b_invoice  jsonb;
  v_b_inv_items jsonb;
  v_b_revenue  jsonb;
  v_b_offset   jsonb;
  v_b_ie_items jsonb;
  v_details    jsonb;
  v_ghi_chu    text := '[ĐÃ HUỶ — ' || c_reason || ']';
BEGIN
  -- ── Lượt lặp: đã áp thì chỉ kiểm hai dòng đã xoá không sống lại.
  IF EXISTS (
    SELECT 1 FROM public.accounting_repair_audit a
     WHERE a.repair_code = c_code AND a.entity_type = 'contract' AND a.entity_id = c_contract
  ) THEN
    IF EXISTS (SELECT 1 FROM public.contract_terminations WHERE id = c_term)
       OR EXISTS (SELECT 1 FROM public.payments WHERE id = c_payment) THEN
      RAISE EXCEPTION '%: hồ sơ thanh lý hoặc payment cấn trừ đã gỡ lại xuất hiện', c_code;
    END IF;
    RAISE NOTICE '%: đã áp trước đó — không làm gì', c_code;
    RETURN;
  END IF;

  -- ── Database chỉ-schema (restore drill): không có dữ liệu nghiệp vụ nào.
  -- Đây là miễn trừ DUY NHẤT; database có dữ liệu mà thiếu dòng ghim thì dừng.
  IF NOT EXISTS (SELECT 1 FROM public.organizations)
     AND NOT EXISTS (SELECT 1 FROM public.contracts)
     AND NOT EXISTS (SELECT 1 FROM public.invoices)
     AND NOT EXISTS (SELECT 1 FROM public.payments)
     AND NOT EXISTS (SELECT 1 FROM public.income_expenses) THEN
    RAISE NOTICE '%: database chỉ-schema, không có dữ liệu để vá', c_code;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(c_code, 0));

  -- ── Khoá dòng: hợp đồng trước (cùng thứ tự writer thanh lý), rồi các dòng con.
  SELECT * INTO v_contract FROM public.contracts WHERE id = c_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy hợp đồng %', c_code, c_contract; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = c_room FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy phòng %', c_code, c_room; END IF;
  SELECT * INTO v_customer FROM public.customers WHERE id = c_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy khách %', c_code, c_customer; END IF;
  SELECT * INTO v_term FROM public.contract_terminations WHERE id = c_term FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy hồ sơ thanh lý %', c_code, c_term; END IF;
  SELECT * INTO v_invoice FROM public.invoices WHERE id = c_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy hoá đơn quyết toán %', c_code, c_invoice; END IF;
  SELECT * INTO v_payment FROM public.payments WHERE id = c_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy payment cấn trừ %', c_code, c_payment; END IF;
  SELECT * INTO v_revenue FROM public.income_expenses WHERE id = c_revenue FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy phiếu termination.revenue %', c_code, c_revenue; END IF;
  SELECT * INTO v_offset FROM public.income_expenses WHERE id = c_offset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy phiếu termination.offset %', c_code, c_offset; END IF;
  SELECT * INTO v_refund FROM public.income_expenses WHERE id = c_refund FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '%: không thấy phiếu termination.refund %', c_code, c_refund; END IF;

  -- ── Ghim md5 các dòng đã đông cứng từ ngày thanh lý.
  IF md5(to_jsonb(v_term)::text)    IS DISTINCT FROM c_md5_term
     OR md5(to_jsonb(v_payment)::text) IS DISTINCT FROM c_md5_payment
     OR md5(to_jsonb(v_invoice)::text) IS DISTINCT FROM c_md5_invoice
     OR md5(to_jsonb(v_revenue)::text) IS DISTINCT FROM c_md5_revenue
     OR md5(to_jsonb(v_offset)::text)  IS DISTINCT FROM c_md5_offset
     OR (SELECT md5(jsonb_agg(to_jsonb(ii) ORDER BY ii.id)::text)
           FROM public.invoice_items ii WHERE ii.invoice_id = c_invoice) IS DISTINCT FROM c_md5_inv_items
     OR (SELECT md5(jsonb_agg(to_jsonb(it) ORDER BY it.id)::text)
           FROM public.income_expense_items it
          WHERE it.income_expense_id IN (c_revenue, c_offset)) IS DISTINCT FROM c_md5_ie_items THEN
    RAISE EXCEPTION '%: dòng đã ghim lệch md5 so với lúc đo — dừng, đo lại trước khi vá', c_code;
  END IF;

  -- ── Số tiền lấy từ chính các dòng đã ghim, rồi so chéo.
  v_amount := v_offset.total_amount;
  IF (v_amount IS NULL OR v_amount <= 0
     OR v_revenue.total_amount IS DISTINCT FROM v_amount
     OR v_payment.amount IS DISTINCT FROM v_amount
     OR v_invoice.total_amount IS DISTINCT FROM v_amount
     OR v_invoice.paid_amount IS DISTINCT FROM v_amount
     OR v_term.early_termination_fee + v_term.outstanding_debt IS DISTINCT FROM v_amount
     OR v_term.total_deposit IS DISTINCT FROM v_contract.total_deposit
     OR v_contract.total_deposit - v_contract.deposit_paid IS DISTINCT FROM v_amount) IS NOT FALSE THEN
    RAISE EXCEPTION '%: số tiền giữa các dòng của lần thanh lý không khớp nhau', c_code;
  END IF;

  -- ── Danh tính và trạng thái hiện tại. `(…) IS NOT FALSE`: một cột NULL làm cả vế
  -- thành NULL thì cũng dừng, không lặng lẽ cho qua.
  IF (v_contract.organization_id IS DISTINCT FROM c_org
     OR v_contract.deleted_at IS NOT NULL
     OR v_contract.status::text <> 'TERMINATED'
     OR v_contract.actual_end_date IS DISTINCT FROM c_move_out
     OR v_contract.room_id IS DISTINCT FROM c_room
     OR v_contract.end_date < public.org_today_v1(c_org)
     OR v_contract.deposit_paid IS DISTINCT FROM public.contract_deposit_paid_derived(c_contract)
     OR v_room.organization_id IS DISTINCT FROM c_org
     OR v_room.building_id IS DISTINCT FROM c_building
     OR v_room.deleted_at IS NOT NULL
     OR v_room.status::text <> 'AVAILABLE'
     OR v_customer.organization_id IS DISTINCT FROM c_org
     OR v_customer.deleted_at IS NOT NULL
     OR v_term.contract_id IS DISTINCT FROM c_contract
     OR v_term.status <> 'COMPLETED'
     OR v_term.actual_move_out_date IS DISTINCT FROM c_move_out
     OR v_invoice.contract_id IS DISTINCT FROM c_contract
     OR v_invoice.kind::text <> 'SETTLEMENT'
     OR v_invoice.status::text <> 'PAID'
     OR v_invoice.deleted_at IS NOT NULL
     OR v_payment.invoice_id IS DISTINCT FROM c_invoice
     OR v_payment.payment_method::text <> 'CT'
     OR v_payment.received_amount IS DISTINCT FROM 0::numeric
     OR v_payment.collection_id IS NOT NULL
     OR v_payment.reversed_at IS NOT NULL
     OR v_revenue.contract_id IS DISTINCT FROM c_contract
     OR v_revenue.system_source IS DISTINCT FROM 'termination.revenue'
     OR v_revenue.approval_status <> 'APPROVED'
     OR v_revenue.invoice_id IS DISTINCT FROM c_invoice
     OR v_offset.contract_id IS DISTINCT FROM c_contract
     OR v_offset.system_source IS DISTINCT FROM 'termination.offset'
     OR v_offset.approval_status <> 'APPROVED'
     OR v_offset.account_id IS DISTINCT FROM v_revenue.account_id
     OR v_refund.contract_id IS DISTINCT FROM c_contract
     OR v_refund.system_source IS DISTINCT FROM 'termination.refund'
     OR v_refund.approval_status <> 'CANCELLED'
     OR v_refund.posting_status IS DISTINCT FROM 'REVERSED'
     OR v_refund.active_posting_id_v2 IS NOT NULL
     OR v_refund.deleted_at IS NOT NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '%: trạng thái hợp đồng / phòng / khách / chứng từ thanh lý khác trạng thái đã đo', c_code;
  END IF;

  -- Phiếu nội bộ phải ở sổ ẢO (không đụng tiền thật) và chưa có bút toán sổ quỹ.
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = v_offset.account_id AND a.is_virtual)
     OR v_offset.active_posting_id_v2 IS NOT NULL OR v_revenue.active_posting_id_v2 IS NOT NULL
     OR v_offset.posting_status IS DISTINCT FROM 'NOT_APPLICABLE'
     OR v_revenue.posting_status IS DISTINCT FROM 'NOT_APPLICABLE'
     OR v_offset.deleted_at IS NOT NULL OR v_revenue.deleted_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.income_expense_postings p
                 WHERE p.voucher_id IN (c_revenue, c_offset)) THEN
    RAISE EXCEPTION '%: cặp bút toán cấn cọc không còn là bút toán nội bộ chưa hạch toán', c_code;
  END IF;

  -- Đúng MỘT khách đại diện, đúng một hồ sơ thanh lý, không chứng từ thanh lý lạ.
  IF (SELECT count(*) FROM public.contract_customers cc WHERE cc.contract_id = c_contract) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.contract_customers cc
                     WHERE cc.contract_id = c_contract AND cc.customer_id = c_customer)
     OR (SELECT count(*) FROM public.contract_terminations t WHERE t.contract_id = c_contract) <> 1
     OR (SELECT count(*) FROM public.payments p WHERE p.invoice_id = c_invoice) <> 1
     OR (SELECT count(*) FROM public.income_expenses e
          WHERE e.contract_id = c_contract AND e.system_source LIKE 'termination.%') <> 3
     OR EXISTS (SELECT 1 FROM public.income_expenses e
                 WHERE e.invoice_id = c_invoice AND e.id <> c_revenue)
     OR EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.contract_id = c_contract AND i.kind::text = 'SETTLEMENT' AND i.id <> c_invoice)
     OR EXISTS (SELECT 1 FROM public.contracts c
                 WHERE c.room_id = c_room AND c.id <> c_contract AND c.deleted_at IS NULL
                   AND c.status::text IN ('ACTIVE', 'EXTENDED'))
     OR EXISTS (SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id = c_contract)
     OR EXISTS (SELECT 1 FROM public.termination_refund_obligations o WHERE o.contract_id = c_contract)
     OR EXISTS (SELECT 1 FROM public.termination_move_out_authorizations a WHERE a.contract_id = c_contract)
     OR EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations a
                 WHERE a.invoice_id = c_invoice OR a.payment_id = c_payment)
     OR EXISTS (SELECT 1 FROM app_private.payment_reversals r WHERE r.original_payment_id = c_payment)
     OR EXISTS (SELECT 1 FROM public.invoice_payment_tenders t WHERE t.payment_id = c_payment)
     OR EXISTS (SELECT 1 FROM public.excess_amounts x
                 WHERE x.source_payment_id = c_payment OR x.source_invoice_id = c_invoice)
     OR EXISTS (SELECT 1 FROM public.customer_credit_lots l WHERE l.source_payment_id = c_payment)
     OR EXISTS (SELECT 1 FROM public.customer_credit_applications a WHERE a.invoice_id = c_invoice)
     OR EXISTS (SELECT 1 FROM public.invoice_adjustments a WHERE a.invoice_id = c_invoice)
     OR EXISTS (SELECT 1 FROM public.finance_invoice_component_allocations a WHERE a.invoice_id = c_invoice)
     OR EXISTS (SELECT 1 FROM app_private.customer_residence_events e
                 WHERE e.contract_id = c_contract AND e.kind IN ('TERMINATED', 'FORFEIT')) THEN
    RAISE EXCEPTION '%: có chứng từ / liên kết ngoài phạm vi đã đo — dừng, đọc lại trước khi vá', c_code;
  END IF;

  -- ── Ảnh chụp trước.
  v_b_contract  := to_jsonb(v_contract);
  v_b_room      := to_jsonb(v_room);
  v_b_customer  := to_jsonb(v_customer);
  v_b_invoice   := to_jsonb(v_invoice);
  v_b_revenue   := to_jsonb(v_revenue);
  v_b_offset    := to_jsonb(v_offset);
  SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id) INTO v_b_inv_items
    FROM public.invoice_items ii WHERE ii.invoice_id = c_invoice;
  SELECT jsonb_agg(to_jsonb(it) ORDER BY it.id) INTO v_b_ie_items
    FROM public.income_expense_items it WHERE it.income_expense_id IN (c_revenue, c_offset);

  -- ── b. Gỡ payment cấn trừ. Trigger a05 chỉ cho writer có năng lực accounting
  -- chain trong ĐÚNG transaction này (cùng năng lực writer thanh lý đã dùng).
  PERFORM app_private.begin_accounting_chain_write_v1();
  DELETE FROM public.payments WHERE id = c_payment;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM app_private.end_accounting_chain_write_v1();
  IF v_rows <> 1 THEN RAISE EXCEPTION '%: xoá payment cấn trừ ảnh hưởng % dòng', c_code, v_rows; END IF;

  UPDATE public.invoices
     SET status = 'CANCELLED',
         notes = COALESCE(notes || E'\n\n', '') || v_ghi_chu
                 || ' Hoá đơn quyết toán của lần thanh lý nhầm — khách vẫn ở, không thu khoản này.'
   WHERE id = c_invoice;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION '%: huỷ hoá đơn quyết toán ảnh hưởng % dòng', c_code, v_rows; END IF;

  -- ── c. Huỷ cặp bút toán cấn cọc (cùng đường reverse_termination_move_out_pair_v2).
  PERFORM app_private.finance_v2_transition_owned_approval(c_revenue, 'CANCELLED', 'NOT_APPLICABLE');
  PERFORM app_private.finance_v2_transition_owned_approval(c_offset, 'CANCELLED', 'NOT_APPLICABLE');
  UPDATE public.income_expenses
     SET notes = COALESCE(notes || E'\n\n', '') || v_ghi_chu
   WHERE id IN (c_revenue, c_offset);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN RAISE EXCEPTION '%: ghi chú huỷ cặp bút toán ảnh hưởng % dòng', c_code, v_rows; END IF;

  -- ── d. Gỡ hồ sơ thanh lý (ảnh chụp đầy đủ nằm trong accounting_repair_audit).
  DELETE FROM public.contract_terminations WHERE id = c_term;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION '%: xoá hồ sơ thanh lý ảnh hưởng % dòng', c_code, v_rows; END IF;

  -- ── e. Mở lại hợp đồng; trigger update_room_status_on_contract_change đưa phòng
  -- về OCCUPIED. status_v2 của khách suy từ hợp đồng còn hiệu lực.
  UPDATE public.contracts
     SET status = 'ACTIVE',
         actual_end_date = NULL,
         notes = COALESCE(notes || E'\n', '') || '[Huỷ thanh lý 28/08/2026 — ' || c_reason
                 || '. Mở lại hợp đồng; hoá đơn quyết toán, payment cấn trừ, cặp bút toán cấn cọc'
                 || ' và hồ sơ thanh lý đã gỡ (accounting_repair_audit ' || c_code || ').]'
   WHERE id = c_contract;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION '%: mở lại hợp đồng ảnh hưởng % dòng', c_code, v_rows; END IF;

  PERFORM app_private.refresh_residence_customer_v1(c_customer);

  -- ── g. Hậu điều kiện.
  SELECT * INTO v_contract FROM public.contracts WHERE id = c_contract;
  SELECT * INTO v_room FROM public.rooms WHERE id = c_room;
  SELECT * INTO v_customer FROM public.customers WHERE id = c_customer;
  SELECT * INTO v_invoice FROM public.invoices WHERE id = c_invoice;
  SELECT * INTO v_revenue FROM public.income_expenses WHERE id = c_revenue;
  SELECT * INTO v_offset FROM public.income_expenses WHERE id = c_offset;

  IF (v_contract.status::text <> 'ACTIVE'
     OR v_contract.actual_end_date IS NOT NULL
     OR v_contract.deposit_paid IS DISTINCT FROM v_contract.total_deposit
     OR v_contract.deposit_paid IS DISTINCT FROM public.contract_deposit_paid_derived(c_contract)
     OR v_room.status::text <> 'OCCUPIED'
     OR v_customer.status_v2::text <> 'RENTING'
     OR v_invoice.status::text <> 'CANCELLED'
     OR v_invoice.paid_amount IS DISTINCT FROM 0::numeric
     OR v_revenue.approval_status <> 'CANCELLED' OR v_revenue.posting_status IS DISTINCT FROM 'NOT_APPLICABLE'
     OR v_offset.approval_status  <> 'CANCELLED' OR v_offset.posting_status  IS DISTINCT FROM 'NOT_APPLICABLE'
     OR v_revenue.active_posting_id_v2 IS NOT NULL OR v_offset.active_posting_id_v2 IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.income_expense_postings p WHERE p.voucher_id IN (c_revenue, c_offset))
     OR EXISTS (SELECT 1 FROM public.payments WHERE id = c_payment)
     OR EXISTS (SELECT 1 FROM public.contract_terminations WHERE contract_id = c_contract)
     OR EXISTS (SELECT 1 FROM public.income_expenses e
                 WHERE e.contract_id = c_contract AND e.system_source LIKE 'termination.%'
                   AND e.approval_status <> 'CANCELLED')) IS NOT FALSE THEN
    RAISE EXCEPTION '%: hậu điều kiện không đạt (hợp đồng %, cọc %/%, phòng %, khách %, hoá đơn %)',
      c_code, v_contract.status, v_contract.deposit_paid, v_contract.total_deposit,
      v_room.status, v_customer.status_v2, v_invoice.status;
  END IF;

  -- ── f. Vết sửa: một dòng cho mỗi thực thể, kèm ảnh chụp trước/sau.
  v_details := jsonb_build_object(
    'reason', c_reason,
    'migration', '20261115074245_huy_thanh_ly_nham_mo_lai_hop_dong',
    'mistaken_move_out_date', c_move_out,
    'contract_id', c_contract,
    'offset_amount', v_amount,
    'cash_delta', 0,
    'refund_voucher_id', c_refund,
    'refund_voucher_state', 'đã đảo bút toán và huỷ qua app ngày 15/11/2026, migration không đụng');

  INSERT INTO public.accounting_repair_audit
    (organization_id, entity_type, entity_id, repair_code, before_snapshot, after_snapshot, details)
  VALUES
    (c_org, 'contract', c_contract, c_code,
       jsonb_build_object('contract', v_b_contract, 'room', v_b_room, 'customer', v_b_customer),
       jsonb_build_object('contract', to_jsonb(v_contract), 'room', to_jsonb(v_room), 'customer', to_jsonb(v_customer)),
       v_details || jsonb_build_object('action', 'TERMINATED → ACTIVE, actual_end_date → NULL, phòng → OCCUPIED, khách → RENTING')),
    (c_org, 'contract_termination', c_term, c_code,
       to_jsonb(v_term), jsonb_build_object('deleted', true),
       v_details || jsonb_build_object('action', 'DELETE (bảng không có trạng thái huỷ; UNIQUE contract_id)')),
    (c_org, 'invoice', c_invoice, c_code,
       jsonb_build_object('invoice', v_b_invoice, 'items', v_b_inv_items),
       jsonb_build_object('invoice', to_jsonb(v_invoice)),
       v_details || jsonb_build_object('action', 'PAID → CANCELLED sau khi gỡ payment CT')),
    (c_org, 'payment', c_payment, c_code,
       to_jsonb(v_payment), jsonb_build_object('deleted', true),
       v_details || jsonb_build_object('action', 'DELETE payment CT (received_amount 0, không phải tiền thật)')),
    (c_org, 'income_expense', c_revenue, c_code,
       jsonb_build_object('voucher', v_b_revenue, 'items', v_b_ie_items),
       jsonb_build_object('voucher', to_jsonb(v_revenue)),
       v_details || jsonb_build_object('action', 'termination.revenue APPROVED → CANCELLED (không còn tính KQKD)')),
    (c_org, 'income_expense', c_offset, c_code,
       jsonb_build_object('voucher', v_b_offset, 'items', v_b_ie_items),
       jsonb_build_object('voucher', to_jsonb(v_offset)),
       v_details || jsonb_build_object('action', 'termination.offset APPROVED → CANCELLED (trả phần cọc đã cấn)'));

  -- Kỳ ghi nhận đã đóng (đã chốt lợi nhuận): không mở/chốt lại ở đây, chỉ để lại
  -- ngoại lệ mở cho người chốt quyết. Kỳ còn mở thì không có gì phải ghi.
  IF app_private.finance_v2_is_recognition_period_open(c_org, c_move_out) IS DISTINCT FROM true THEN
    INSERT INTO public.accounting_integrity_exceptions
      (organization_id, entity_type, entity_id, exception_code, details)
    VALUES
      (c_org, 'contract', c_contract, 'CLOSED_PROFIT_PERIOD_CHANGED_BY_REPAIR',
       jsonb_build_object(
         'repair_code', c_code,
         'reason', c_reason,
         'building_id', c_building,
         'period_month', date_trunc('month', c_move_out)::date,
         'latest_close_run_id', (
           SELECT r.id FROM public.profit_close_runs r
            WHERE r.organization_id = c_org
              AND r.period_month = date_trunc('month', c_move_out)::date
              AND r.operation = 'CLOSE'
            ORDER BY r.created_at DESC LIMIT 1),
         'cancelled_revenue_voucher_id', c_revenue,
         'cancelled_revenue_amount', v_amount,
         'required_action', 'Số sống tháng của toà đã lệch bản chốt lợi nhuận; người chốt quyết có chốt lại kỳ này không.'));
  END IF;

  RAISE NOTICE '%: đã mở lại hợp đồng % — cọc %/%, phòng %, khách %, hoá đơn quyết toán %',
    c_code, c_contract, v_contract.deposit_paid, v_contract.total_deposit,
    v_room.status, v_customer.status_v2, v_invoice.status;
END;
$huy_thanh_ly$;

COMMIT;
