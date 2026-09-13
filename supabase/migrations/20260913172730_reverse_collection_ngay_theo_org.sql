-- =============================================================================
-- reverse_invoice_collection_v5: cận trên "ngày hoàn tác không được ở tương lai"
-- phải đo theo NGÀY CỦA ORG, không theo CURRENT_DATE của phiên Postgres.
--
-- VÌ SAO (đo 14/09/2026 lúc 00:05 giờ VN = 13/09 17:05 UTC)
--   Phiên DB chạy TimeZone = UTC nên CURRENT_DATE = 13/09, trong khi app ghi
--   collection_date theo giờ VN (public.org_today_v1 / vn_local_date) = 14/09.
--   Hoàn tác với ngày 14/09 bị từ chối "không được ở tương lai (hôm nay là
--   13/09/2026)", còn ngày 13/09 thì nhỏ hơn collection_date nên cận dưới từ
--   chối. Hệ quả: từ 00:00 đến 07:00 giờ VN mỗi ngày, KHÔNG hoàn tác được bất
--   kỳ khoản thu nào ghi trong ngày. Khoảng trống đã ghi ở tooling/known-gaps.yaml
--   (reverse-collection-so-ngay-theo-utc); migration này là điều kiện đóng.
--
-- SỬA GÌ
--   Chỉ đổi phép so cận trên sang public.org_today_v1(v_collection.organization_id)
--   (STABLE SECURITY DEFINER, đã tồn tại, là nguồn "hôm nay" mà app dùng). Toàn
--   bộ phần còn lại chép NGUYÊN từ định nghĩa đang chạy trên production
--   (pg_get_functiondef lấy 14/09/2026, md5 bản gốc 96d62e8fa7624e2655f6ad8760ae6836).
--   Cận dưới (không sớm hơn collection_date) giữ nguyên.
--
-- IDEMPOTENT: CREATE OR REPLACE cùng chữ ký, chạy hai lần cho cùng kết quả.
-- ACL/owner được giữ khi REPLACE; vẫn khẳng định lại để không phụ thuộc trạng
-- thái trước (anon không được gọi; authenticated + service_role gọi được).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reverse_invoice_collection_v5(p_collection_id uuid, p_reversal_date date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_collection public.invoice_payment_collections%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_tender public.invoice_payment_tenders%ROWTYPE;
  v_allocation record;
  v_reversal_voucher_id uuid;
  v_reversal_item_id uuid;
  v_expense_type_id uuid;
  v_credit_lot public.customer_credit_lots%ROWTYPE;
  v_response jsonb;
  v_reversal_vouchers jsonb := '[]'::jsonb;
  -- Đợt 5
  v_in_place boolean := false;
  v_membership uuid;
  v_block text;
  v_rev_posting uuid;
  v_mode text;
  -- WP2_UNDO_VISIBLE_BOOK: chủ tổ chức / super admin đi thẳng, người còn
  -- lại phải có ÍT NHẤT quan hệ "được nhìn sổ" với từng sổ quỹ nguồn.
  v_book_bypass boolean := false;
  v_tender_building uuid;
  v_book_name text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_reversal_date IS NULL OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Ngày hoàn tác hoặc lý do 8-1000 ký tự không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_collection
  FROM public.invoice_payment_collections
  WHERE id = p_collection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy collection' USING ERRCODE = '42501';
  END IF;
  IF p_reversal_date < v_collection.collection_date THEN
    RAISE EXCEPTION 'Reversal date cannot be earlier than collection date'
      USING ERRCODE = '22023';
  END IF;
  -- Cận TRÊN: ngày hoàn tác nằm ở tương lai sẽ đóng băng một con số chưa
  -- xảy ra vào invoice_payment_collections.reversal_date và làm mọi báo cáo
  -- theo kỳ đọc sai. 2099-12-31 từng được nhận.
  --
  -- "Hôm nay" đo theo NGÀY CỦA ORG (public.org_today_v1), KHÔNG theo
  -- CURRENT_DATE: phiên Postgres chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ
  -- VN, CURRENT_DATE vẫn là hôm qua và mọi khoản thu ghi "hôm nay" theo giờ VN
  -- bị coi là tương lai — không hoàn tác được (đo 14/09/2026 00:05 VN).
  IF p_reversal_date > public.org_today_v1(v_collection.organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn tác không được ở tương lai (hôm nay là %)',
      to_char(public.org_today_v1(v_collection.organization_id), 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = v_collection.invoice_id
  FOR UPDATE;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL
     OR v_invoice.organization_id <> v_org
     OR v_collection.organization_id <> v_org THEN
    RAISE EXCEPTION 'Collection không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);

  -- ĐỢT A (vá sau audit): gate 'thu_tien.undo' bị bỏ kéo theo việc mất luôn
  -- cửa kiểm THÀNH VIÊN, vì authorize_tenant_action_v3 vốn từ chối bằng
  -- MEMBERSHIP_INACTIVE_OR_MISSING. Hệ quả: nhân viên đã bị gỡ khỏi tổ chức
  -- vẫn khớp nhánh "chính người đã thu" (user_id trên phiếu cũ không đổi) và
  -- hoàn tác được khoản thu cũ — JWT Supabase không bị thu hồi khi gỡ
  -- membership. Khôi phục ĐÚNG điều kiện "còn là người của tổ chức", không
  -- khôi phục gate quyền (giữ quyết định #8).
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m0
     WHERE m0.user_id = v_actor AND m0.organization_id = v_org
       AND m0.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không còn thuộc tổ chức này nên không hoàn tác được khoản thu.'
      USING ERRCODE = '42501';
  END IF;
  -- ĐỢT A: luật huỷ thống nhất (quyết định #8 của chủ 01/08/2026) — huỷ
  -- khoản thu KHÔNG còn hỏi quyền 'thu_tien.undo'. Điều kiện duy nhất là
  -- CHÍNH NGƯỜI ĐÃ THU (hoặc chủ tổ chức / super admin), kiểm ở vòng tender
  -- bên dưới. Cùng một luật cho cả trang Thu tiền lẫn trang Thu chi.

  v_hash := md5(jsonb_build_object(
    'collection_id', p_collection_id,
    'reversal_date', p_reversal_date,
    'reason', v_reason
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.reverse.v5',
    p_collection_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.reverse.v5'
    AND operation_row.subject_scope = p_collection_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.reverse.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 chưa bật'
      USING ERRCODE = '55000';
  END IF;

  IF v_collection.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Collection đã được hoàn tác' USING ERRCODE = '23505';
  END IF;

  -- Allocation is revenue-first then deposit. Reversing an older collection
  -- would leave newer allocation rows attached to the wrong accounting class.
  IF abs(
    COALESCE(v_invoice.paid_amount, 0)
    - (v_collection.expected_paid_amount + v_collection.applied_amount)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Phải hoàn tác khoản thu mới hơn trước (thứ tự LIFO)'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_credit_lot
  FROM public.customer_credit_lots lot
  WHERE lot.source_collection_id = p_collection_id
  FOR UPDATE;
  IF FOUND AND v_credit_lot.remaining_amount <> v_credit_lot.amount THEN
    RAISE EXCEPTION 'Credit của collection đã được sử dụng; phải unwind trước khi hoàn tác'
      USING ERRCODE = '55000';
  END IF;

  -- ══ ĐỢT 5: chọn đường ═════════════════════════════════════════════
  -- Chế độ linh hoạt → huỷ tại chỗ. Nhưng kỳ đã đóng thì DỪNG HẲN, không
  -- lặng lẽ rơi về đường sinh phiếu đối ứng: một khoản tiền rời khỏi tháng đã
  -- chia lợi nhuận cho cổ đông phải là quyết định có người ký.
  v_in_place := true;  -- ĐỢT A: phiếu thu luôn huỷ tại chỗ (quyết định #3)

  -- KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ: kỳ đã đóng thì KHÔNG đường nào được đụng,
  -- kể cả đường sinh phiếu đối ứng của chế độ Chuẩn kế toán.
  SELECT m.id INTO v_membership FROM public.organization_memberships m
     WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
     LIMIT 1;
  v_book_bypass := public.is_super_admin()
                   OR app_private.is_org_owner_v1(v_org, v_actor);

    FOR v_tender IN
      SELECT * FROM public.invoice_payment_tenders
      WHERE collection_id = p_collection_id
      ORDER BY line_index
    LOOP
      CONTINUE WHEN v_tender.voucher_id IS NULL;
      v_block := app_private.period_block_code_v1(v_tender.voucher_id);
      IF v_block IS NOT NULL THEN
        RAISE EXCEPTION '%',
          CASE v_block
            WHEN 'PROFIT_LOCKED' THEN
              '[PROFIT_LOCKED] Lợi nhuận của tháng chứa khoản thu này đã chốt và đã chia cho cổ đông — hệ thống không tự huỷ khoản thu của tháng đó. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'CASHBOOK_CLOSED' THEN
              '[CASHBOOK_CLOSED] Sổ quỹ chứa khoản thu này đã chốt & bàn giao — kỳ đó khoá vĩnh viễn. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'HANDOVER_LOCKED' THEN
              '[HANDOVER_LOCKED] Phiếu thu này nằm trong một phiên bàn giao đã xác nhận — phải huỷ phiên đó trước (cần cả hai bên đồng ý).'
            ELSE
              '[PERIOD_CLOSED] Kỳ kế toán của khoản thu này đã đóng nên không huỷ được. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
          END
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

  -- Đường CŨ cần hạng mục "Hoàn tác thu tiền"; đường huỷ tại chỗ thì không,
  -- và cố ý KHÔNG tạo hạng mục rác cho tổ chức chưa từng dùng nó.
  IF NOT v_in_place THEN
    SELECT type_row.id INTO v_expense_type_id
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_collection.organization_id
      AND lower(type_row.type) = 'expense'
      AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
    LIMIT 1 FOR SHARE;
    IF v_expense_type_id IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description, is_default, is_deposit
      ) VALUES (
        v_collection.organization_id, v_invoice.user_id,
        'Hoàn tác thu tiền', 'expense',
        'Bút toán đối ứng cho collection đã hoàn tác', false, false
      ) RETURNING id INTO v_expense_type_id;
    END IF;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();

  FOR v_tender IN
    SELECT * FROM public.invoice_payment_tenders
    WHERE collection_id = p_collection_id
    ORDER BY line_index
    FOR UPDATE
  LOOP
    IF v_tender.voucher_id IS NULL THEN
      CONTINUE;
    END IF;

    -- B: toà của CHÍNH tender này (phiếu thu của tender), không phải toà
    -- của hoá đơn. Một collection nhiều tender có thể bắc qua nhiều toà.
    SELECT tender_voucher.building_id INTO v_tender_building
    FROM public.income_expenses tender_voucher WHERE tender_voucher.id = v_tender.voucher_id;
    v_tender_building := COALESCE(v_tender_building, v_invoice.building_id);

    -- ĐỢT A: bỏ gate quyền theo sổ quỹ nguồn (quyết định #8).

    -- A (WP2_UNDO_VISIBLE_BOOK): quyền thôi chưa đủ. Một override cấp
    -- ORGANIZATION phủ MỌI sổ, kể cả sổ người này không giữ, không biết,
    -- không được chia sẻ. Chủ chốt "với việc thu chỉ cần biết sổ là được".
    -- ĐỢT A: bỏ gate "sổ được nhìn" (quyết định #8) — danh tính người thu
    -- đã là điều kiện đủ; không bắt thêm quan hệ với sổ quỹ.

    -- Chỉ CHÍNH NGƯỜI ĐÃ THU được hoàn tác khoản thu đó (yêu cầu của chủ
    -- 30/07). Chủ tổ chức / super admin giữ cửa phụ, nếu không thì khoản
    -- thu của nhân viên đã nghỉ là bất khả hoàn tác vĩnh viễn.
    IF NOT public.is_super_admin()
       AND NOT app_private.is_org_owner_v1(v_collection.organization_id, v_actor)
       AND NOT EXISTS (SELECT 1 FROM public.income_expenses src
                        WHERE src.id = v_tender.voucher_id AND src.user_id = v_actor) THEN
      RAISE EXCEPTION 'Chỉ người đã thu khoản này mới hoàn tác được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
        USING ERRCODE = '42501';
    END IF;

    IF v_in_place THEN
      -- ── HUỶ TẠI CHỖ: không sinh phiếu nào ──────────────────────────
      v_rev_posting := app_private.cancel_collection_voucher_in_place_v1(
        v_tender.voucher_id, v_reason, v_actor, v_membership);
      v_reversal_voucher_id := v_tender.voucher_id;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', NULL,
        'reversal_posting_id', v_rev_posting,
        'mode', 'IN_PLACE_CANCEL',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    ELSE
      -- ── ĐƯỜNG CŨ: sinh phiếu chi đối ứng (chế độ Chuẩn kế toán) ────
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_collection_id, reversal_of_income_expense_id,
        voucher_date, total_amount, approval_status, approved_by, approved_at,
        notes, business_result_accounting, creator_name, system_source,
        idempotency_key, change_amount, change_account_id,
        rounding_amount, rounding_account_id
      ) VALUES (
        v_invoice.user_id, v_collection.organization_id, 'EXPENSE',
        'Hoàn tác thu tiền ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_tender.account_id, NULL, p_collection_id, v_tender.voucher_id,
        p_reversal_date, v_tender.retained_amount, 'APPROVED', v_actor,
        clock_timestamp(), v_reason, NULL, 'Invoice Collection V5',
        'invoice.collection.reverse.v5', v_key || ':tender:' || v_tender.line_index,
        -v_tender.change_amount, v_tender.change_account_id,
        -v_tender.rounding_amount, v_tender.rounding_account_id
      ) RETURNING id INTO v_reversal_voucher_id;

      FOR v_allocation IN
        SELECT allocation.accounting_class, allocation.amount
        FROM public.invoice_payment_allocations allocation
        WHERE allocation.tender_id = v_tender.id
        ORDER BY allocation.id
      LOOP
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_reversal_voucher_id, v_collection.organization_id, v_expense_type_id,
          CASE v_allocation.accounting_class
            WHEN 'PNL' THEN 'Hoàn tác doanh thu hóa đơn'
            WHEN 'DEPOSIT' THEN 'Hoàn tác tiền cọc'
            WHEN 'CUSTOMER_CREDIT' THEN 'Hoàn tác credit khách hàng'
            ELSE 'Hoàn tác khoản ngoài KQKD'
          END,
          1, v_allocation.amount, v_allocation.amount,
          p_reversal_date, p_reversal_date, v_allocation.accounting_class
        ) RETURNING id INTO v_reversal_item_id;
      END LOOP;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_reversal_voucher_id, v_collection.organization_id,
        'INVOICE_COLLECTION_REVERSAL_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.reverse.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, p_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', v_reversal_voucher_id,
        'mode', 'COUNTER_VOUCHER',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    END IF;

    -- Hai lệnh dưới đây gánh TIỀN THẬT và phải chạy ở CẢ HAI đường:
    -- recompute_invoice_for_id đọc public.payments (reversed_at IS NULL) chứ
    -- không đọc approval_status của phiếu.
    IF v_tender.payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET reversed_at = clock_timestamp(),
             reversed_by_collection_id = p_collection_id,
             updated_at = now()
       WHERE id = v_tender.payment_id;

      INSERT INTO app_private.payment_reversals (
        original_payment_id, reversal_voucher_id, organization_id, actor_id, reason,
        reversal_kind
      ) VALUES (
        v_tender.payment_id, v_reversal_voucher_id,
        v_collection.organization_id, v_actor, v_reason,
        CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END
      ) ON CONFLICT (original_payment_id) DO NOTHING;
    END IF;
  END LOOP;

  IF v_credit_lot.id IS NOT NULL THEN
    UPDATE public.customer_credit_lots
       SET remaining_amount = 0, status = 'REVERSED', reversed_at = clock_timestamp()
     WHERE id = v_credit_lot.id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_collection.organization_id, v_invoice.user_id, v_collection.contract_id,
      -v_credit_lot.amount, 'Hoàn tác credit collection',
      v_invoice.id, v_credit_lot.source_payment_id, v_credit_lot.id
    );
  END IF;

  UPDATE public.invoice_payment_collections
     SET status = 'REVERSED', reversed_at = clock_timestamp(), reversed_by = v_actor,
         reversal_date = p_reversal_date, reversal_reason = v_reason,
         reversal_idempotency_key = v_key
   WHERE id = p_collection_id;

  PERFORM public.recompute_invoice_for_id(v_invoice.id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  v_mode := CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END;

  SELECT jsonb_build_object(
    'collection_id', p_collection_id,
    'status', 'REVERSED',
    'reversal_mode', v_mode,
    'reversal_date', p_reversal_date,
    'reversal_vouchers', v_reversal_vouchers,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice.id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = p_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_collection.organization_id
     AND operation = 'invoice.collection.reverse.v5'
     AND subject_scope = p_collection_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text) TO authenticated, service_role;
