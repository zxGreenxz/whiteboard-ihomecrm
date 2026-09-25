-- =============================================================================
-- dong_duong_cu_sua_phieu — đóng các đường sửa cũ sau khi giao diện mới lên
-- Ngày 25/09/2026 · đợt 1 "sửa phiếu thu chi" · ÁP SAU KHI WEB MỚI LÊN (web cũ còn
-- gọi các hàm bị gỡ ở đây). Chủ chốt: "các phần nào không sử dụng nữa thì xóa triệt
-- để"; "toàn bộ thao tác sửa chữa sẽ ghi chú lại chính xác rõ ràng".
-- =============================================================================
-- LÀM GÌ
--   1. record_invoice_collection_v5: thêm ĐÚNG MỘT chốt sau chốt possession — sổ
--      nhận tiền phải nằm trong danh sách của (toà hoá đơn, hình thức, người thu)
--      (app_private.assert_receiving_cashbook_v1). Thân còn lại y bản production
--      (md5 f57ad822…); hình thức ngoài TM/TK/TT không bị xét.
--   2. ie_compat_update_pending_v2: chỉ còn tên / ghi chú / ảnh của phiếu ĐÃ DUYỆT
--      (ảnh chỉ nối thêm). Phiếu Chờ duyệt, trục tiền, hạng mục ⇒ 0A000: sửa bằng
--      revise_pending_income_expense_v1 (có lưu vết).
--   3. Gỡ hàm không còn ai gọi (giao diện mới đã chuyển; không hàm SQL nào gọi —
--      khối kiểm bên dưới chặn nếu có):
--        update_invoice_payment_method_v1 (đổi phương thức kiểu cũ, chết từ 28/07),
--        move_income_voucher_cashbook_v1 (không nút nào gọi; lõi ở
--          app_private.move_posted_income_cashbook_v1),
--        update_income_expense_quick (hộp Duyệt chuyển sang sửa phiếu có lưu vết),
--        lock_profit_month_v1 / unlock_profit_month_v1 (màn Chốt lợi nhuận dùng bộ V2;
--          mở khoá dùng profit_unlock_v2 có lý do).
--   4. Thu quyền gọi thẳng record_invoice_payment_v4 của authenticated (giao diện không
--      dùng; record_invoice_payment_v3 vẫn gọi được vì chạy quyền chủ hàm).
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu đang có. Không đụng hàm/trigger đã ghim.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE lại record_invoice_collection_v5 / ie_compat_update_pending_v2 từ
--   bản trước (md5 ở preflight, thân trong schema-change evidence/backup); các hàm đã gỡ
--   tạo lại từ backup; GRANT EXECUTE record_invoice_payment_v4 TO authenticated.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Bản đang chạy phải đúng bản đã rà; không hàm nào còn gọi các hàm sắp gỡ.
DO $truoc$
DECLARE
  v_ham record;
  v_goi text;
BEGIN
  FOR v_ham IN
    SELECT * FROM (VALUES
      ('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)',
       ARRAY['f57ad822ca8def8a86ab5a5d5d06199b', '3889ab4d9e3b3f48f8f5c928b6ea314d']),
      ('public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)',
       ARRAY['c6ed1d47823837349c92e8769932053a', 'ef1cf9abb7ae08a026b6bdf53b7840cf'])
    ) AS t(chu_ky, md5_hop_le)
  LOOP
    IF to_regprocedure(v_ham.chu_ky) IS NOT NULL
       AND md5(pg_get_functiondef(to_regprocedure(v_ham.chu_ky))) <> ALL (v_ham.md5_hop_le) THEN
      RAISE EXCEPTION '% đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại', v_ham.chu_ky
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF to_regprocedure('app_private.receiving_cashbook_ids_v1(uuid,uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.receiving_cashbook_ids_v1 — chạy migration so_nhan_tien trước'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_goi
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prokind = 'f'
     AND n.nspname IN ('public', 'app_private')
     AND p.proname NOT IN ('update_invoice_payment_method_v1', 'move_income_voucher_cashbook_v1',
                           'update_income_expense_quick', 'lock_profit_month_v1', 'unlock_profit_month_v1')
     AND pg_get_functiondef(p.oid) ~ '(update_invoice_payment_method_v1|move_income_voucher_cashbook_v1|update_income_expense_quick|lock_profit_month_v1|unlock_profit_month_v1)\(';
  IF v_goi IS NOT NULL THEN
    RAISE EXCEPTION 'Còn hàm gọi tới hàm sắp gỡ: %', v_goi USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Chốt danh sách sổ nhận tiền lúc thu.
CREATE OR REPLACE FUNCTION app_private.assert_receiving_cashbook_v1(
  p_org uuid, p_building uuid, p_method text, p_membership uuid, p_account uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_allowed uuid[];
  v_toa text;
  v_so text;
  v_ht text;
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('TM', 'TK', 'TT') THEN
    RETURN;
  END IF;
  v_allowed := app_private.receiving_cashbook_ids_v1(p_org, p_building, p_method, p_membership);
  IF p_account = ANY (v_allowed) THEN
    RETURN;
  END IF;

  v_ht := CASE p_method WHEN 'TM' THEN 'Tiền mặt' WHEN 'TK' THEN 'Chuyển khoản' ELSE 'Thanh toán' END;
  SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = p_building;
  IF p_method = 'TM' AND cardinality(v_allowed) = 0 THEN
    RAISE EXCEPTION 'Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.'
      USING ERRCODE = '42501';
  END IF;
  IF p_method = 'TM' THEN
    SELECT a.name INTO v_so FROM public.accounts a WHERE a.id = v_allowed[1];
    RAISE EXCEPTION 'Thu tiền mặt phải vào sổ tiền mặt riêng của người thu ("%").', COALESCE(v_so, '(không rõ)')
      USING ERRCODE = '42501';
  END IF;
  IF p_method <> 'TM'
     AND cardinality(app_private.receiving_cashbook_ids_v1(p_org, p_building, p_method, NULL)) = 0 THEN
    RAISE EXCEPTION 'Toà % chưa cài sổ nhận tiền cho hình thức %.', COALESCE(v_toa, '(không rõ)'), v_ht
      USING ERRCODE = '42501';
  END IF;
  SELECT a.name INTO v_so FROM public.accounts a WHERE a.id = p_account;
  RAISE EXCEPTION 'Sổ "%" không nằm trong danh sách sổ nhận tiền % của toà %.',
    COALESCE(v_so, '(không rõ)'), v_ht, COALESCE(v_toa, '(không rõ)')
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.assert_receiving_cashbook_v1(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Thân dưới đây là pg_get_functiondef production (md5 f57ad822…) + đúng một khối chèn
-- ngay sau chốt possession trong vòng kiểm từng dòng thu.
CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5(p_invoice_id uuid, p_collection_date date, p_tenders jsonb, p_overpay_action text, p_allow_rounding boolean, p_notes text, p_receipt_image_url text, p_expected_paid_amount numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_collector_membership uuid;
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_collection_id uuid;
  v_tender jsonb;
  v_tender_id uuid;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_item_id uuid;
  v_credit_lot_id uuid;
  v_credit_tender_count integer;
  v_excess_id uuid;
  v_account_id uuid;
  v_change_account_id uuid;
  v_rounding_account_id uuid;
  v_method public.payment_method;
  v_gross numeric;
  v_gross_total numeric := 0;
  v_tm_total numeric := 0;
  v_explicit_change boolean;
  v_requested_change numeric;
  v_requested_change_total numeric := 0;
  v_rounding_line_idx integer;
  v_fallback_rounding_account uuid;
  v_refund_audit_posting uuid;
  v_refund_audit_evidence uuid;
  v_remaining numeric;
  v_applied_total numeric;
  v_change_total numeric := 0;
  v_credit_total numeric := 0;
  v_rounding_total numeric := 0;
  v_retained_total numeric;
  v_remaining_apply numeric;
  v_change_left numeric;
  v_credit_left numeric;
  v_line_left numeric;
  v_line_change numeric;
  v_line_credit numeric;
  v_line_retained numeric;
  v_line_applied numeric;
  v_line_revenue numeric;
  v_line_internal numeric;
  v_line_deposit numeric;
  v_later_tm_total numeric;
  v_later_gross_total numeric;
  v_revenue_due numeric;
  v_internal_due numeric := 0;
  v_deposit_due numeric := 0;
  v_revenue_covered numeric := 0;
  v_internal_covered numeric := 0;
  v_deposit_covered numeric := 0;
  v_projected_revenue numeric;
  v_projected_internal numeric;
  v_projected_deposit numeric;
  v_projection_left numeric;
  v_idx integer := 0;
  v_last_tm_idx integer := -1;
  v_last_line_idx integer;
  v_revenue_type_id uuid;
  v_deposit_type_id uuid;
  v_credit_type_id uuid;
  v_response jsonb;
  v_tender_results jsonb := '[]'::jsonb;
  v_creator_name text;
  v_rounding_target_account uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF p_collection_date IS NULL OR jsonb_typeof(p_tenders) <> 'array'
     OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'Ngày thu hoặc danh sách phương thức không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id, v_invoice.user_id
    INTO v_org, v_owner
  FROM public.buildings building_row
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, org_row;
  IF v_org IS NULL OR v_invoice.organization_id <> v_org THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  -- H1.4 (rà soát 15/09): ngày thu ở TƯƠNG LAI đóng băng một con số chưa xảy ra
  -- vào invoice_payment_collections.collection_date, payments.payment_date và
  -- ngày phiếu thu — mọi báo cáo theo kỳ đọc sai từ đó trở đi, và khoản thu còn
  -- không hoàn tác được (reverse đòi ngày hoàn tác ≥ ngày thu nhưng ≤ hôm nay).
  -- reverse_invoice_collection_v5 đã chặn cận trên từ 13/09; đường GHI thì chưa.
  -- "Hôm nay" đo theo NGÀY CỦA ORG, không theo CURRENT_DATE: phiên Postgres chạy
  -- TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN, CURRENT_DATE vẫn là hôm qua và
  -- mọi khoản thu ghi "hôm nay" theo giờ VN sẽ bị từ chối oan.
  IF p_collection_date > public.org_today_v1(v_org) THEN
    RAISE EXCEPTION 'Ngày thu không được ở tương lai (hôm nay là %)',
      to_char(public.org_today_v1(v_org), 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;

  -- Membership của người thu — dùng cho chốt possession trên sổ nhận tiền.
  SELECT m.id INTO v_collector_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
  LIMIT 1;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'collection_date', p_collection_date,
    'tenders', p_tenders,
    'overpay_action', upper(COALESCE(p_overpay_action, 'REJECT')),
    'allow_rounding', COALESCE(p_allow_rounding, false),
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.v5', p_invoice_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.v5'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.canonical_write_operations compat_operation
    WHERE compat_operation.organization_id = v_org
      AND compat_operation.operation = 'invoice.collection.compat.v4'
      AND compat_operation.subject_scope = p_invoice_id::text
      AND compat_operation.actor_id = v_actor
      AND compat_operation.idempotency_key = v_key
      AND compat_operation.completed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.income_expenses legacy_voucher
    WHERE legacy_voucher.organization_id = v_org
      AND legacy_voucher.idempotency_key = v_key
      AND legacy_voucher.payment_collection_id IS NULL
      AND legacy_voucher.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'idempotency_key đã hoàn tất ở đường payment tương thích'
      USING ERRCODE = '23505';
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF v_invoice.status NOT IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE') THEN
    RAISE EXCEPTION 'Trạng thái hóa đơn không cho phép thu tiền: %', v_invoice.status
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_paid_amount IS NULL
     OR p_expected_paid_amount = 'NaN'::numeric
     OR abs(COALESCE(v_invoice.paid_amount, 0) - p_expected_paid_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t
    WHERE t ? 'requested_change_amount') INTO v_explicit_change;
  IF v_explicit_change AND upper(COALESCE(p_overpay_action, 'REJECT')) <> 'REFUND' THEN
    RAISE EXCEPTION 'Tiền thối tùy chỉnh chỉ dùng khi chọn thối lại'
      USING ERRCODE = '22023';
  END IF;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_gross := COALESCE((v_tender->>'gross_amount')::numeric, 0);
    IF v_gross IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
       OR v_gross <= 0 OR round(v_gross, 2) <> v_gross THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ'
        USING ERRCODE = '22023';
    END IF;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    IF v_explicit_change THEN
      IF v_method = 'TM' THEN
        IF jsonb_typeof(v_tender->'requested_change_amount') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'Phải nhập tiền thối bằng số cho tất cả dòng tiền mặt'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change := (v_tender->>'requested_change_amount')::numeric;
        IF v_requested_change IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_requested_change < 0 OR v_requested_change > v_gross
           OR round(v_requested_change, 2) <> v_requested_change THEN
          RAISE EXCEPTION 'Tiền thối phải không âm, tối đa 2 số lẻ và không vượt tiền mặt của dòng'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change_total := v_requested_change_total + v_requested_change;
      ELSIF v_tender ? 'requested_change_amount' THEN
        RAISE EXCEPTION 'Chỉ được thối từ dòng tiền mặt TM' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_account_id := NULLIF(v_tender->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải có sổ quỹ' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
        USING ERRCODE = '42501';
    END IF;
    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi vào một sổ quỹ đã chọn' USING ERRCODE = '42501';
    END IF;

    -- CHỐT POSSESSION TRÊN SỔ NHẬN TIỀN (02/08/2026).
    -- 'thu_tien.collect' khai requires_cashbook_possession = false và
    -- required_dimensions = [], nên tham số p_cashbook_id ở trên bị BỎ QUA: đo
    -- trên prod, một người thu được ở toà là server cho ghi vào CẢ 16/16 sổ của
    -- tổ chức, kể cả sổ chưa từng được cấp quyền gì. Trước đây chỉ có danh sách
    -- trên giao diện vô tình gác cổng; gọi thẳng API thì không còn gì chặn.
    --
    -- KHÔNG bật requires_cashbook_possession cho 'thu_tien.collect' để vá:
    -- authorize_tenant_action_v3 khi đó đòi cạnh ALLOW phải là scope CASHBOOK,
    -- mà vai trò "Quản Lý Tòa" chỉ có binding scope BUILDING (18 binding/org)
    -- ⇒ bật lên là chặn sạch mọi người thu. Vì vậy kiểm possession TRỰC TIẾP.
    --
    -- CUSTODIAN hoặc KNOWER đều hợp lệ (helper đã khai đúng vậy): người thu chỉ
    -- đạo tiền vào tài khoản ngân hàng của chủ thì là "người biết sổ", không
    -- phải người giữ tiền. Đo lịch sử 120 ngày: 0/31 lần thu bị chốt này chặn.
    IF v_collector_membership IS NULL
       OR NOT app_private.ie_has_cashbook_possession_v1(v_org, v_account_id, v_collector_membership) THEN
      RAISE EXCEPTION 'Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.'
        USING ERRCODE = '42501';
    END IF;

    -- Đợt 1 sửa phiếu (25/09/2026): sổ phải nằm trong danh sách sổ nhận tiền của
    -- (toà hoá đơn, hình thức, người thu) — luật gắn sổ theo hình thức nay ở máy chủ.
    PERFORM app_private.assert_receiving_cashbook_v1(
      v_org, v_invoice.building_id, v_method::text, v_collector_membership, v_account_id);

    v_gross_total := v_gross_total + v_gross;
    IF v_method = 'TM' THEN
      v_tm_total := v_tm_total + v_gross;
      v_last_tm_idx := v_idx;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  v_last_line_idx := v_idx - 1;
  v_remaining := GREATEST(v_invoice.total_amount - COALESCE(v_invoice.paid_amount, 0), 0);
  v_applied_total := LEAST(v_gross_total, v_remaining);

  IF v_gross_total > v_remaining THEN
    CASE upper(COALESCE(p_overpay_action, 'REJECT'))
      WHEN 'REFUND' THEN v_change_total := v_gross_total - v_remaining;
      WHEN 'CREDIT' THEN
        IF v_invoice.contract_id IS NULL THEN
          RAISE EXCEPTION 'Không thể giữ credit cho hóa đơn không có hợp đồng'
            USING ERRCODE = '22023';
        END IF;
        v_credit_total := v_gross_total - v_remaining;
      ELSE
        RAISE EXCEPTION 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit'
          USING ERRCODE = '22023';
    END CASE;
    IF v_change_total > 0
       AND (v_last_tm_idx < 0 OR v_tm_total < v_change_total) THEN
      RAISE EXCEPTION 'Phần hoàn tiền phải nằm trong dòng tiền mặt TM của lần thu hiện tại'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_explicit_change THEN
    IF v_requested_change_total < GREATEST(v_gross_total - v_remaining, 0) THEN
      RAISE EXCEPTION 'Tiền thối không được nhỏ hơn phần dư; chọn giữ credit nếu cần giữ tiền'
        USING ERRCODE = '22023';
    END IF;
    IF v_gross_total - v_requested_change_total <= 0 THEN
      RAISE EXCEPTION 'Số tiền thực thu sau khi thối phải lớn hơn 0' USING ERRCODE = '22023';
    END IF;
    v_change_total := v_requested_change_total;
    v_applied_total := LEAST(v_gross_total - v_change_total, v_remaining);
  END IF;

  IF v_applied_total <= 0 THEN
    RAISE EXCEPTION 'Hóa đơn không còn số tiền có thể thu' USING ERRCODE = '55000';
  END IF;

  IF COALESCE(p_allow_rounding, false)
     AND v_remaining - v_applied_total > 0
     AND v_remaining - v_applied_total < 10000 THEN
    v_rounding_total := v_remaining - v_applied_total;
  END IF;

  v_retained_total := v_gross_total - v_change_total;

  SELECT COALESCE(sum(item.amount), 0)
    INTO v_deposit_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'DEPOSIT';

  SELECT v_deposit_due + COALESCE(sum((source_row->>'amount')::numeric), 0)
    INTO v_deposit_due
  FROM jsonb_array_elements(COALESCE(v_invoice.previous_debt_sources, '[]'::jsonb)) source_row
  WHERE source_row->>'type' = 'deposit';
  v_deposit_due := COALESCE(v_deposit_due, 0);
  SELECT COALESCE(sum(item.amount), 0)
    INTO v_internal_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'NON_PNL';

  v_internal_due := COALESCE(v_internal_due, 0);
  v_revenue_due := GREATEST(
    v_invoice.total_amount - v_deposit_due - v_internal_due,
    0
  );
  IF v_deposit_due = 'NaN'::numeric
     OR v_internal_due = 'NaN'::numeric
     OR v_invoice.total_amount = 'NaN'::numeric
     OR v_deposit_due + v_internal_due - v_invoice.total_amount >= 0.01 THEN
    RAISE EXCEPTION 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'INTERNAL'), 0)
  INTO v_revenue_covered, v_deposit_covered, v_internal_covered
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  LEFT JOIN public.invoice_payment_collections source_collection
    ON source_collection.id = voucher.payment_collection_id
  LEFT JOIN public.payments source_payment
    ON source_payment.id = voucher.payment_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND (
      voucher.payment_collection_id IS NULL
      OR source_collection.status = 'ACTIVE'
    )
    AND (voucher.payment_id IS NULL OR source_payment.reversed_at IS NULL);

  IF v_revenue_covered - v_revenue_due >= 0.01
     OR v_deposit_covered - v_deposit_due >= 0.01
     OR v_internal_covered - v_internal_due >= 0.01 THEN
    RAISE EXCEPTION 'Bút toán đã ghi vượt semantic của hóa đơn; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;
  IF abs(
    v_revenue_covered + v_deposit_covered + v_internal_covered
    - COALESCE(v_invoice.paid_amount, 0)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu không khớp bút toán semantic; cần đối soát trước'
      USING ERRCODE = '55000';
  END IF;
  v_revenue_covered := GREATEST(LEAST(v_revenue_covered, v_revenue_due), 0);
  v_deposit_covered := GREATEST(LEAST(v_deposit_covered, v_deposit_due), 0);
  v_internal_covered := GREATEST(LEAST(v_internal_covered, v_internal_due), 0);

  v_projection_left := v_applied_total;
  v_projected_revenue := v_revenue_covered + LEAST(
    v_projection_left,
    GREATEST(v_revenue_due - v_revenue_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_revenue - v_revenue_covered);
  v_projected_deposit := v_deposit_covered + LEAST(
    v_projection_left,
    GREATEST(v_deposit_due - v_deposit_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_deposit - v_deposit_covered);
  v_projected_internal := v_internal_covered + LEAST(
    v_projection_left,
    GREATEST(v_internal_due - v_internal_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_internal - v_internal_covered);
  IF abs(v_projection_left) >= 0.01 THEN
    RAISE EXCEPTION 'Không thể phân bổ số thu vào semantic hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  IF v_rounding_total > 0 AND (
    v_deposit_due - v_projected_deposit >= 0.01
    OR v_internal_due - v_projected_internal >= 0.01
  ) THEN
    RAISE EXCEPTION 'Không được làm tròn bỏ qua cọc hoặc khoản NON_PNL còn thiếu'
      USING ERRCODE = '22023';
  END IF;

  SELECT type_row.id INTO v_revenue_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC,
           CASE WHEN lower(btrim(type_row.name)) IN ('thu tiền hoá đơn', 'thu tiền hóa đơn') THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_credit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND lower(btrim(type_row.name)) = 'tiền khách trả thừa'
  LIMIT 1 FOR SHARE;

  IF v_revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu hóa đơn' USING ERRCODE = '55000';
  END IF;
  IF v_deposit_due > 0 AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc' USING ERRCODE = '55000';
  END IF;
  IF v_credit_total > 0 AND v_credit_type_id IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description, is_default, is_deposit
    ) VALUES (
      v_org, v_owner, 'Tiền khách trả thừa', 'income',
      'Khoản khách trả dư giữ lại để cấn kỳ sau; ngoài KQKD', false, false
    ) RETURNING id INTO v_credit_type_id;
  END IF;

  v_creator_name := COALESCE(
    auth.jwt()->'user_metadata'->>'full_name',
    auth.jwt()->'user_metadata'->>'name',
    auth.jwt()->>'email',
    'Người dùng'
  );

  PERFORM app_private.claim_feature_operation_v1(
    'invoice.collection.v5',
    v_org,
    p_invoice_id::text,
    v_actor,
    v_key,
    v_retained_total
  );

  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.invoice_payment_collections (
    organization_id, invoice_id, contract_id, status, collection_date,
    actor_id, idempotency_key, payload_hash, expected_paid_amount,
    gross_amount, retained_amount, applied_amount, change_amount,
    credit_amount, rounding_amount, notes, receipt_image_url
  ) VALUES (
    v_org, p_invoice_id, v_invoice.contract_id, 'ACTIVE', p_collection_date,
    v_actor, v_key, v_hash, p_expected_paid_amount,
    v_gross_total, v_retained_total, v_applied_total, v_change_total,
    v_credit_total, v_rounding_total, NULLIF(btrim(p_notes), ''), p_receipt_image_url
  ) RETURNING id INTO v_collection_id;

  -- A fully refunded final TM tender has no payment. Keep rounding on the
  -- last tender with real applied money so recompute/reversal see it exactly once.
  v_rounding_line_idx := v_last_line_idx;
  IF v_explicit_change AND v_rounding_total > 0 THEN
    SELECT max(ord - 1)::integer INTO v_rounding_line_idx
    FROM jsonb_array_elements(p_tenders) WITH ORDINALITY t(value, ord)
    WHERE (value->>'gross_amount')::numeric
      - COALESCE((value->>'requested_change_amount')::numeric, 0) > 0;
  END IF;
  v_fallback_rounding_account := NULLIF(p_tenders->v_last_line_idx->>'rounding_account_id', '')::uuid;

  v_remaining_apply := v_applied_total;
  v_change_left := v_change_total;
  v_credit_left := v_credit_total;
  v_idx := 0;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_payment_id := NULL;
    v_voucher_id := NULL;
    v_gross := (v_tender->>'gross_amount')::numeric;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    v_account_id := (v_tender->>'account_id')::uuid;
    v_change_account_id := NULLIF(v_tender->>'change_account_id', '')::uuid;
    v_rounding_account_id := NULLIF(v_tender->>'rounding_account_id', '')::uuid;
    IF v_explicit_change AND v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      -- The original final line owns the rounding account, matching old payloads.
      v_rounding_account_id := v_fallback_rounding_account;
    END IF;
    v_line_change := 0;
    v_line_credit := 0;
    v_line_revenue := 0;
    v_line_deposit := 0;
    v_line_internal := 0;

    IF v_explicit_change AND v_method = 'TM' THEN
      v_line_change := (v_tender->>'requested_change_amount')::numeric;
      v_change_left := v_change_left - v_line_change;
    ELSIF v_method = 'TM' AND v_change_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_tm_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx
        AND later.value->>'payment_method' = 'TM';

      v_line_change := LEAST(
        v_gross,
        GREATEST(v_change_total - v_later_tm_total, 0)
      );
      v_change_left := v_change_left - v_line_change;
    END IF;

    IF v_credit_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_gross_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx;

      v_line_credit := LEAST(
        v_gross - v_line_change,
        GREATEST(v_credit_total - v_later_gross_total, 0)
      );
      v_credit_left := v_credit_left - v_line_credit;
    END IF;

    IF v_line_change > 0 THEN
      IF v_change_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ tiền thối' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_change_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ tiền thối phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_change_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền ghi tiền thối vào sổ đã chọn'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_line_retained := v_gross - v_line_change;
    v_line_applied := LEAST(v_line_retained - v_line_credit, v_remaining_apply);
    v_remaining_apply := v_remaining_apply - v_line_applied;

    v_line_left := v_line_applied;
    v_line_revenue := LEAST(
      v_line_left,
      GREATEST(v_revenue_due - v_revenue_covered, 0)
    );
    v_revenue_covered := v_revenue_covered + v_line_revenue;
    v_line_left := v_line_left - v_line_revenue;

    v_line_deposit := LEAST(
      v_line_left,
      GREATEST(v_deposit_due - v_deposit_covered, 0)
    );
    v_deposit_covered := v_deposit_covered + v_line_deposit;
    v_line_left := v_line_left - v_line_deposit;

    v_line_internal := LEAST(
      v_line_left,
      GREATEST(v_internal_due - v_internal_covered, 0)
    );
    v_internal_covered := v_internal_covered + v_line_internal;
    v_line_left := v_line_left - v_line_internal;
    IF abs(v_line_left) >= 0.01 THEN
      RAISE EXCEPTION 'Dòng thanh toán không phân bổ hết vào semantic hóa đơn'
        USING ERRCODE = '55000';
    END IF;

    IF v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      IF v_rounding_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ làm tròn' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_rounding_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ làm tròn phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_rounding_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền dùng sổ làm tròn đã chọn'
          USING ERRCODE = '42501';
      END IF;
      v_rounding_target_account := v_rounding_account_id;
    END IF;

    INSERT INTO public.invoice_payment_tenders (
      organization_id, collection_id, line_index, payment_method, account_id,
      change_account_id, rounding_account_id, gross_amount, retained_amount,
      applied_amount, change_amount, credit_amount, rounding_amount, receipt_number
    ) VALUES (
      v_org, v_collection_id, v_idx, v_method, v_account_id,
      v_change_account_id, v_rounding_account_id, v_gross, v_line_retained,
      v_line_applied, v_line_change, v_line_credit,
      CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
      NULLIF(v_tender->>'receipt_number', '')
    ) RETURNING id INTO v_tender_id;

    IF v_line_applied > 0 THEN
      INSERT INTO public.payments (
        organization_id, user_id, invoice_id, receipt_number, amount,
        received_amount, credit_amount, change_amount, rounding_amount,
        payment_method, payment_date, notes, receipt_image_url,
        collection_id, tender_id
      ) VALUES (
        v_org, v_owner, p_invoice_id, NULLIF(v_tender->>'receipt_number', ''),
        v_line_applied, v_line_retained, v_line_credit, v_line_change,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        v_method, p_collection_date, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 THEN p_receipt_image_url END,
        v_collection_id, v_tender_id
      ) RETURNING id INTO v_payment_id;
    ELSE
      v_payment_id := NULL;
    END IF;

    IF v_line_retained > 0
       OR v_line_change > 0
       OR (v_idx = v_rounding_line_idx AND v_rounding_total > 0) THEN
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_id, payment_collection_id, voucher_date,
        payer_name, notes, attachments, total_amount, approval_status,
        approved_by, approved_at, business_result_accounting, creator_name,
        change_amount, change_account_id, rounding_amount, rounding_account_id,
        system_source, idempotency_key
      ) VALUES (
        v_owner, v_org, 'INCOME', 'Thu tiền theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_account_id, p_invoice_id, v_payment_id, v_collection_id, p_collection_date,
        NULL, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 AND p_receipt_image_url IS NOT NULL
          THEN jsonb_build_array(p_receipt_image_url) ELSE '[]'::jsonb END,
        v_line_retained, 'APPROVED', v_actor, clock_timestamp(), NULL,
        v_creator_name, v_line_change, v_change_account_id,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_account_id END,
        'invoice.collection.v5', v_key || ':tender:' || v_idx
      ) RETURNING id INTO v_voucher_id;

      IF v_line_revenue > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Thanh toán HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_revenue, v_line_revenue, p_collection_date, p_collection_date, 'PNL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'PNL', v_line_revenue
        );
      END IF;

      IF v_line_deposit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_deposit_type_id,
          'Tiền cọc theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_deposit, v_line_deposit, p_collection_date, p_collection_date, 'DEPOSIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'DEPOSIT', v_line_deposit
        );
      END IF;

      IF v_line_internal > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Khoản ngoài KQKD theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_internal, v_line_internal,
          p_collection_date, p_collection_date, 'INTERNAL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'INTERNAL', v_line_internal
        );
      END IF;

      IF v_line_credit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_credit_type_id,
          'Tiền khách trả thừa từ HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_credit, v_line_credit, p_collection_date, p_collection_date,
          'CUSTOMER_CREDIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'CUSTOMER_CREDIT', v_line_credit
        );
      END IF;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_voucher_id, v_org, 'INVOICE_COLLECTION_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, v_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;
    END IF;

    UPDATE public.invoice_payment_tenders
       SET payment_id = v_payment_id, voucher_id = v_voucher_id
     WHERE id = v_tender_id;

    -- A fully returned tender has no real cash movement. The generic bridge
    -- skips zero-value vouchers, so emit ONLY its virtual change audit line.
    -- A real MAIN line here would fabricate income. Keep a posting lineage so
    -- the existing collection reversal can mirror/cancel this audit as usual.
    IF v_explicit_change AND v_line_retained = 0 AND v_line_change > 0 THEN
      IF app_private.evaluate_feature_route('income_expense.posting.v2', v_org) <> 'CANONICAL' THEN
        RAISE EXCEPTION 'Ghi sổ tiền thối chưa bật hoặc đang bị đóng băng' USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.income_expense_postings (
        organization_id, voucher_id, posting_subject_kind, posting_subject_id,
        direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
        net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
        approval_version, event_kind, idempotency_key, source_kind,
        external_source_kind, external_source_id, external_source_line_id, posting_generation
      ) VALUES (
        v_org, v_voucher_id, 'VOUCHER', v_voucher_id,
        'INCOME', v_account_id, v_gross, 0, 'EXTERNAL_TENDER_GROSS',
        v_line_change, p_collection_date, v_collector_membership, v_actor,
        1, 'POSTING', 'v5:refund-audit:' || v_tender_id::text, 'COLLECTION_V5_ADAPTER',
        'COLLECTION_V5', v_collection_id, v_tender_id, 1
      ) RETURNING id INTO v_refund_audit_posting;
      INSERT INTO public.income_expense_posting_lines
        (organization_id, posting_id, account_id, line_kind, signed_amount)
      VALUES (v_org, v_refund_audit_posting, v_change_account_id, 'CHANGE', v_line_change);
      v_refund_audit_evidence := app_private.register_system_evidence_v2(
        v_org, 'INVOICE_COLLECTION_V5', v_collection_id, v_tender_id, NULL,
        md5(v_gross::text || ':0:' || v_tender_id::text));
      INSERT INTO public.income_expense_posting_evidence
        (organization_id, posting_id, evidence_id, relation_kind)
      VALUES (v_org, v_refund_audit_posting, v_refund_audit_evidence, 'ORIGINAL');
      INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      VALUES (v_voucher_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
      ON CONFLICT (income_expense_id) DO UPDATE SET xid=excluded.xid, purpose=excluded.purpose;
      UPDATE public.income_expenses
        SET active_posting_id_v2 = v_refund_audit_posting, posting_status = 'POSTED',
            posting_id = v_refund_audit_posting, posted_at_v2 = now()
      WHERE id = v_voucher_id;
      DELETE FROM app_private.ie_transition_authorization
      WHERE income_expense_id = v_voucher_id AND xid = pg_current_xact_id();
    END IF;

    v_tender_results := v_tender_results || jsonb_build_array(jsonb_build_object(
      'tender_id', v_tender_id,
      'payment_id', v_payment_id,
      'voucher_id', v_voucher_id,
      'applied_amount', v_line_applied,
      'revenue_amount', v_line_revenue,
      'internal_amount', v_line_internal,
      'deposit_amount', v_line_deposit,
      'credit_amount', v_line_credit,
      'change_amount', v_line_change
    ));
    v_idx := v_idx + 1;
  END LOOP;

  IF v_remaining_apply <> 0 OR v_change_left <> 0 OR v_credit_left <> 0 THEN
    RAISE EXCEPTION 'Phân bổ collection không cân bằng' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_payment_tenders tender
    LEFT JOIN public.invoice_payment_allocations allocation
      ON allocation.tender_id = tender.id
    WHERE tender.collection_id = v_collection_id
    GROUP BY tender.id, tender.retained_amount
    HAVING abs(
      tender.retained_amount - COALESCE(sum(allocation.amount), 0)
    ) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Tổng allocation không khớp số tiền giữ lại của tender'
      USING ERRCODE = '55000';
  END IF;

  IF v_credit_total > 0 THEN
    SELECT count(*) INTO v_credit_tender_count
    FROM public.invoice_payment_tenders
    WHERE collection_id = v_collection_id AND credit_amount > 0;
    IF v_credit_tender_count = 1 THEN
      SELECT id, payment_id INTO v_tender_id, v_payment_id
      FROM public.invoice_payment_tenders
      WHERE collection_id = v_collection_id AND credit_amount > 0;
    ELSE
      v_tender_id := NULL;
      v_payment_id := NULL;
    END IF;

    INSERT INTO public.customer_credit_lots (
      organization_id, contract_id, source_collection_id, source_tender_id,
      source_payment_id, amount, remaining_amount, status
    ) VALUES (
      v_org, v_invoice.contract_id, v_collection_id, v_tender_id,
      v_payment_id, v_credit_total, v_credit_total, 'ACTIVE'
    ) RETURNING id INTO v_credit_lot_id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, v_invoice.contract_id, v_credit_total,
      'Tiền thừa từ hóa đơn ' || COALESCE(v_invoice.invoice_number, ''),
      p_invoice_id, v_payment_id, v_credit_lot_id
    ) RETURNING id INTO v_excess_id;

    UPDATE public.customer_credit_lots
       SET source_excess_amount_id = v_excess_id
     WHERE id = v_credit_lot_id;
  END IF;

  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  SELECT jsonb_build_object(
    'collection_id', v_collection_id,
    'invoice_id', p_invoice_id,
    'gross_amount', v_gross_total,
    'applied_amount', v_applied_total,
    'change_amount', v_change_total,
    'credit_amount', v_credit_total,
    'rounding_amount', v_rounding_total,
    'credit_lot_id', v_credit_lot_id,
    'tenders', v_tender_results,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'invoice.collection.v5'
     AND subject_scope = p_invoice_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Kênh sửa cũ chỉ còn tên / ghi chú / ảnh của phiếu đã duyệt.
CREATE OR REPLACE FUNCTION public.ie_compat_update_pending_v2(p_id uuid, p_patch jsonb, p_items jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_org uuid;
  v_actor record;
  v_meta_keys text[] := ARRAY['name','notes','attachments'];
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_ok_meta boolean;
BEGIN
  -- Đợt 1 sửa phiếu (25/09/2026): phiếu Chờ duyệt, trục tiền và hạng mục sửa bằng
  -- revise_pending_income_expense_v1 (có lưu vết cho người duyệt).
  IF p_items IS NOT NULL THEN
    RAISE EXCEPTION 'Sửa hạng mục dùng "Sửa phiếu" (có lưu vết) — tải lại trang để dùng bản mới.'
      USING ERRCODE = '0A000';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_patch, '{}'::jsonb)) LOOP
    IF v_key = ANY (v_meta_keys) THEN
      v_clean := v_clean || jsonb_build_object(v_key, p_patch->v_key);
    ELSE
      RAISE EXCEPTION 'Trường "%" sửa bằng "Sửa phiếu" (có lưu vết) — tải lại trang để dùng bản mới.', v_key
        USING ERRCODE = '0A000';
    END IF;
  END LOOP;

  -- Pre-read org → khoá org → đọc lại FOR UPDATE.
  SELECT organization_id INTO v_org FROM public.income_expenses WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_row.organization_id);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
  END IF;
  IF v_row.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã hủy — không sửa' USING ERRCODE='55000';
  END IF;
  IF v_row.approval_status = 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Phiếu chờ duyệt sửa bằng "Sửa phiếu" (có lưu vết) — tải lại trang để dùng bản mới.'
      USING ERRCODE = '0A000';
  END IF;

  -- Hạng mục hạn chế: RPC là SECURITY DEFINER nên KHÔNG được hưởng
  -- policy RESTRICTIVE income_expenses_restricted_* — phải tự kiểm.
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM auth.uid()
     AND NOT public.can_view_restricted_ie()
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền sửa' USING ERRCODE='42501';
  END IF;

  IF NOT public.is_super_admin() THEN
    SELECT allowed INTO v_ok_meta FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_row.organization_id, 'income_expenses.edit', v_row.building_id, NULL);
  ELSE
    v_ok_meta := true;
  END IF;
  IF NOT (
       v_row.user_id = auth.uid()
    OR COALESCE(v_ok_meta, false)
    OR app_private.ie_has_cashbook_possession_v1(
         v_row.organization_id, v_row.account_id, v_actor.membership_id)
  ) THEN
    RAISE EXCEPTION 'Không có quyền sửa thông tin phiếu này' USING ERRCODE='42501';
  END IF;

  -- Cấm thêm/gỡ dấu hiệu tiền trong ghi chú, ở MỌI trạng thái.
  IF v_clean ? 'notes' THEN
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_clean->>'notes');
  END IF;

  IF v_clean <> '{}'::jsonb THEN
    UPDATE public.income_expenses ie SET
      name        = CASE WHEN v_clean ? 'name' THEN COALESCE(NULLIF(v_clean->>'name',''), ie.name) ELSE ie.name END,
      notes       = CASE WHEN v_clean ? 'notes' THEN v_clean->>'notes' ELSE ie.notes END,
      -- Phiếu đã duyệt: ảnh CHỈ NỐI THÊM — bằng chứng đã hạch toán không được biến mất.
      attachments = CASE
                      WHEN NOT (v_clean ? 'attachments') THEN ie.attachments
                      ELSE app_private.ie_attachments_union_v1(ie.attachments, v_clean->'attachments')
                    END
    WHERE ie.id = p_id;
  END IF;

  INSERT INTO app_private.finance_v2_semantic_event_log (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES (v_row.organization_id, 'COMPAT_UPDATE', 'income_expenses', p_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());
  RETURN jsonb_build_object('id', p_id);
END
$function$;

-- ---------------------------------------------------------------------------
-- 3. Gỡ hàm không còn ai gọi.
DROP FUNCTION IF EXISTS public.update_invoice_payment_method_v1(uuid, public.payment_method);
DROP FUNCTION IF EXISTS public.move_income_voucher_cashbook_v1(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.update_income_expense_quick(uuid, uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.lock_profit_month_v1(text, jsonb);
DROP FUNCTION IF EXISTS public.unlock_profit_month_v1(text, uuid[]);

-- ---------------------------------------------------------------------------
-- 4. Thu quyền gọi thẳng record_invoice_payment_v4.
DO $v4$
BEGIN
  IF to_regprocedure('public.record_invoice_payment_v4(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.record_invoice_payment_v4(uuid, numeric, public.payment_method, date, text, uuid, text, text, jsonb, jsonb, text, uuid)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END
$v4$;

-- ---------------------------------------------------------------------------
-- 5. Nghiệm thu.
DO $nghiem_thu$
DECLARE
  v_def text;
  v_ham text;
BEGIN
  v_def := pg_get_functiondef('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'app_private.assert_receiving_cashbook_v1(', ''))) / length('app_private.assert_receiving_cashbook_v1(') <> 1 THEN
    RAISE EXCEPTION 'nghiem_thu: record_invoice_collection_v5 phai goi assert_receiving_cashbook_v1 dung mot lan';
  END IF;

  v_def := pg_get_functiondef('public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)'::regprocedure);
  IF v_def ~ 'v_money_keys' OR v_def !~ '0A000' THEN
    RAISE EXCEPTION 'nghiem_thu: ie_compat_update_pending_v2 chua dong truc tien';
  END IF;

  FOREACH v_ham IN ARRAY ARRAY[
    'public.update_invoice_payment_method_v1(uuid,public.payment_method)',
    'public.move_income_voucher_cashbook_v1(uuid,uuid,text)',
    'public.update_income_expense_quick(uuid,uuid,jsonb,text)',
    'public.lock_profit_month_v1(text,jsonb)',
    'public.unlock_profit_month_v1(text,uuid[])']
  LOOP
    IF to_regprocedure(v_ham) IS NOT NULL THEN
      RAISE EXCEPTION 'nghiem_thu: % van con', v_ham;
    END IF;
  END LOOP;

  IF to_regprocedure('public.record_invoice_payment_v4(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)') IS NOT NULL
     AND has_function_privilege('authenticated',
       'public.record_invoice_payment_v4(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: authenticated van goi thang duoc record_invoice_payment_v4';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.assert_receiving_cashbook_v1(uuid,uuid,text,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: assert_receiving_cashbook_v1 dang mo cho authenticated';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
