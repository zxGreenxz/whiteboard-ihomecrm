-- =============================================================================
-- create_sale_bonus_from_deposit_v1 + p_account_id + p_attachments
--
-- Hộp thoại "Tạo phiếu cọc giữ chỗ" từ 20/08/2026 cho nhập ảnh chứng từ và chọn
-- sổ quỹ cho CẢ phiếu cọc lẫn phiếu thưởng, và nhập STK/ngân hàng người nhận
-- thưởng. Phiếu cọc đi `create_income_expense_v1` — hàm đó đã nhận sẵn ba thứ
-- này, nên KHÔNG cần đụng. Chỉ đường thưởng-từ-phiếu-cọc là thiếu.
--
-- GỐC THÂN HÀM: bản ĐANG CHẠY TRÊN PROD (`pg_get_functiondef`, đọc 20/08/2026),
-- đã đối chiếu giống hệt `20260801020000`. Án lệ "vá guard nuốt cửa": thay hàm
-- thì chép nguyên khối bản hiện hành rồi mới thêm phần mới.
--
-- Diff so với prod, đúng ba điểm:
--   1. + p_account_id  → cột account_id, KÈM kiểm quyền sổ quỹ (xem dưới).
--   2. + p_attachments → cột attachments (validate mảng chuỗi).
--   3. p_account_number/p_bank vào ĐÚNG CỘT receive_bank_account/receive_bank_name
--      thay vì chỉ nằm trong chuỗi `notes`. Chuỗi `notes` GIỮ NGUYÊN — người dùng
--      đang nhìn thấy nó, đổi là làm rụng thông tin so với phiếu cũ.
--
-- VÌ SAO PHẢI DROP TRƯỚC: thêm tham số DEFAULT vào hàm sẵn có tạo OVERLOAD
-- (6 vs 8 tham số) → PostgREST gọi bằng named args dính "function is not unique".
-- Án lệ 20260806090000 đã trả giá đúng chỗ này.
--
-- KIỂM QUYỀN SỔ QUỸ — vì sao không tin client:
--   Hàm là SECURITY DEFINER, nên nhận `p_account_id` mà không kiểm là cho phép
--   bất kỳ ai ghi phiếu CHI vào sổ quỹ của người khác trong cùng tổ chức. Chốt
--   lại đúng luật §9.2 mà `create_income_expense_v1` đang áp: chủ sổ, hoặc
--   possession còn hiệu lực CUSTODIAN/OPERATOR. KNOWER chỉ được Phiếu THU nên ở
--   đây (phiếu CHI) là KHÔNG.
-- =============================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date)') IS NULL
     AND to_regprocedure('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu create_sale_bonus_from_deposit_v1. DỪNG.';
  END IF;
  IF to_regclass('app_private.sale_bonus_claims') IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ sale_bonus_claims. DỪNG.';
  END IF;
  IF to_regclass('public.cashbook_possession_bindings') IS NULL THEN
    RAISE EXCEPTION 'Thiếu cashbook_possession_bindings — không kiểm được quyền sổ quỹ. DỪNG.';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.create_sale_bonus_from_deposit_v1(
  uuid, numeric, text, text, text, date);

CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(
  p_deposit_voucher_id uuid,
  p_amount             numeric,
  p_recipient          text DEFAULT NULL::text,
  p_account_number     text DEFAULT NULL::text,
  p_bank               text DEFAULT NULL::text,
  p_voucher_date       date DEFAULT NULL::date,
  p_account_id         uuid DEFAULT NULL::uuid,
  p_attachments        jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_dep   public.income_expenses;
  v_org   uuid;
  v_bld   uuid;
  v_room  uuid;
  v_cap   numeric;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_exist uuid;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_acc_org   uuid;
  v_acc_owner uuid;
  v_acc_ok    boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền thưởng phải lớn hơn 0' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_attachments) e
     WHERE jsonb_typeof(e) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (mỗi phần tử phải là URL dạng chuỗi)'
      USING ERRCODE = '23514';
  END IF;

  -- Khoá phiếu cọc: hai người cùng bấm thưởng cho một phiếu cọc phải xếp hàng.
  SELECT * INTO v_dep FROM public.income_expenses
   WHERE id = p_deposit_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;
  IF v_dep.deleted_at IS NOT NULL OR v_dep.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu cọc đã huỷ — không thưởng được' USING ERRCODE = '55000';
  END IF;
  IF v_dep.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu thu cọc' USING ERRCODE = '22023';
  END IF;

  v_org  := v_dep.organization_id;
  v_bld  := v_dep.building_id;
  v_room := v_dep.room_id;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ SỔ QUỸ — tuỳ chọn, nhưng đã chọn thì phải có quyền ════════════
  IF p_account_id IS NOT NULL THEN
    SELECT a.organization_id, a.user_id INTO v_acc_org, v_acc_owner
      FROM public.accounts a
     WHERE a.id = p_account_id AND a.deleted_at IS NULL;
    IF v_acc_org IS NULL OR v_acc_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    -- §9.2: CUSTODIAN/OPERATOR làm mọi loại phiếu; KNOWER chỉ Phiếu thu, mà đây
    -- là phiếu CHI ⇒ KNOWER không đủ.
    v_acc_ok := (v_acc_owner = v_actor) OR EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account_id
         AND b.organization_id = v_org
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND b.possession_kind IN ('CUSTODIAN','OPERATOR')
    );
    IF NOT COALESCE(v_acc_ok, false) THEN
      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ══ CHỐNG CHI TRÙNG — hai hướng ═══════════════════════════════════
  -- (a) Chính phiếu cọc này đã thưởng chưa.
  SELECT sbc.bonus_voucher_id INTO v_exist
    FROM app_private.sale_bonus_claims sbc
    JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
   WHERE sbc.deposit_voucher_id = p_deposit_voucher_id
     AND bon.deleted_at IS NULL AND bon.approval_status <> 'CANCELLED';
  IF v_exist IS NOT NULL THEN
    SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
    RAISE EXCEPTION 'Phiếu cọc này đã được thưởng Sale rồi (phiếu %)', COALESCE(v_code, v_exist::text)
      USING ERRCODE = 'P0001';
  END IF;

  -- (b) Phiếu cọc đã gắn hợp đồng, mà hợp đồng đó đã thưởng qua đường khác.
  IF v_dep.contract_id IS NOT NULL THEN
    SELECT ie.id INTO v_exist FROM public.income_expenses ie
     WHERE ie.contract_id = v_dep.contract_id AND ie.commission_kind = 'sale'
       AND ie.deleted_at IS NULL AND ie.approval_status <> 'CANCELLED'
       AND NOT COALESCE(ie.commission_legacy_dup, false)
     LIMIT 1;
    IF v_exist IS NOT NULL THEN
      SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
      RAISE EXCEPTION 'Hợp đồng của phiếu cọc này đã được thưởng Sale rồi (phiếu %)',
        COALESCE(v_code, v_exist::text) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ══ TRẦN — chỉ áp khi chủ đã công bố ══════════════════════════════
  v_cap := app_private.sale_bonus_cap_for_v1(v_org, v_bld, public.org_today_v1(v_org));
  IF v_cap IS NOT NULL AND p_amount > v_cap THEN
    RAISE EXCEPTION
      'Thưởng % vượt trần % của toà này. Muốn chi cao hơn thì chủ phải nâng trần ở Cài đặt.',
      replace(to_char(round(p_amount), 'FM999G999G999G999'), ',', '.') || 'đ',
      replace(to_char(round(v_cap),   'FM999G999G999G999'), ',', '.') || 'đ'
      USING ERRCODE = '55000';
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_org, v_actor, 'Thưởng nóng Sale', 'expense',
              NULL, NULL, false, false, false, false, false, false);

  -- Cấp phát UUID TRƯỚC để mở được cửa `SALE_BONUS_DEPOSIT` cho đúng phiếu này:
  -- `trigger_ie_commission_guard` chạy BEFORE INSERT nên cửa phải mở trước đó,
  -- mà bảng cửa khoá theo id phiếu. Đóng cửa ngay sau lệnh INSERT.
  v_ie := gen_random_uuid();
  PERFORM app_private.begin_ie_flex_write_v1(v_ie, 'SALE_BONUS_DEPOSIT');

  INSERT INTO public.income_expenses
    (id, user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, commission_kind, system_source,
     account_id, attachments, receive_bank_account, receive_bank_name, notes)
  VALUES
    (v_ie, v_actor, v_org, 'EXPENSE',
     'Thưởng nóng Sale' || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), ''),
     v_bld, v_room,
     -- Cố ý GIỮ NGUYÊN contract_id của phiếu cọc (thường là NULL lúc này).
     -- Không tự bịa hợp đồng: quan hệ nằm ở sổ claim bên dưới.
     v_dep.contract_id,
     COALESCE(p_voucher_date, public.org_today_v1(v_org)),
     p_amount, 'UNAPPROVED', 'sale', 'contract.commission',
     p_account_id,
     v_attachments,
     NULLIF(btrim(p_account_number), ''),
     NULLIF(btrim(p_bank), ''),
     'Thưởng Sale theo phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8))
       || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), '')
       || COALESCE(' — STK ' || NULLIF(btrim(p_account_number), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_bank), ''), ''))
  RETURNING code INTO v_code;

  PERFORM app_private.end_ie_flex_write_v1(v_ie);

  INSERT INTO public.income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  VALUES (v_ie, v_type, 'PNL',
          'Thưởng nóng Sale — phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8)),
          1, p_amount, p_amount);

  INSERT INTO app_private.sale_bonus_claims
    (organization_id, deposit_voucher_id, contract_id, bonus_voucher_id, amount, created_by)
  VALUES (v_org, p_deposit_voucher_id, v_dep.contract_id, v_ie, p_amount, v_actor);

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', p_amount,
    'depositVoucherId', p_deposit_voucher_id,
    'note', 'Phiếu thưởng đã tạo và đang CHỜ DUYỆT. Khi hợp đồng của phiếu cọc này được ký, hệ thống sẽ tự biết là đã thưởng rồi.');
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb) IS
  'Tạo phiếu thưởng nóng Sale từ PHIẾU CỌC, lúc chưa có hợp đồng. Phiếu ra CHỜ DUYỆT. Chặn chi trùng hai hướng: phiếu cọc đã thưởng, và hợp đồng của phiếu cọc đã thưởng. Nhận sổ quỹ (kiểm quyền chủ sổ hoặc CUSTODIAN/OPERATOR) và ảnh chứng từ.';

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $tk$
DECLARE v_src text;
BEGIN
  IF to_regprocedure('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Chữ ký 8 tham số không tồn tại. DỪNG.';
  END IF;
  IF to_regprocedure('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'Chữ ký 6 tham số còn sống ⇒ overload, PostgREST sẽ gãy. DỪNG.';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
    'public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)')::oid) INTO v_src;
  IF position('sale_bonus_claims' IN v_src) = 0 OR position('sale_bonus_cap_for_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Mất sổ claim hoặc chốt trần. DỪNG.';
  END IF;
  IF position('''UNAPPROVED''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Phiếu thưởng phải ra CHỜ DUYỆT. DỪNG.';
  END IF;
  IF position('SALE_BONUS_DEPOSIT' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Mất cửa SALE_BONUS_DEPOSIT ⇒ trigger guard sẽ chặn INSERT. DỪNG.';
  END IF;
  IF position('cashbook_possession_bindings' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Nhận sổ quỹ mà không kiểm quyền ⇒ ghi được vào sổ người khác. DỪNG.';
  END IF;
END
$tk$;

COMMIT;

NOTIFY pgrst, 'reload schema';
