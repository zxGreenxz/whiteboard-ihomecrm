-- =============================================================================
-- create_commission_voucher + p_attachments — phiếu HH môi giới / thưởng nóng
-- Sale nhận ảnh chứng từ riêng cho từng phiếu (modal sau tạo HĐ giờ có ô upload
-- ảnh riêng cho mục Hoa hồng MG và mục Thưởng nóng Sale).
--
-- GỐC THÂN HÀM: bản ĐANG CHẠY TRÊN PROD (dump pg_get_functiondef 06/08/2026) —
-- KHÔNG phải bản migration 20260709110001. Prod đã được nâng cấp ngoài repo:
-- organization_id đa tổ chức, chốt SALE_BONUS_SEES_DEPOSIT_CLAIM, khối
-- COMMISSION_AUTOPAY_V1, ensure_income_expense_type_v1. Án lệ "vá guard nuốt
-- cửa": thay hàm phải chép nguyên khối bản hiện hành rồi mới thêm thay đổi.
-- Diff so với prod: +p_attachments (validate mảng) → cột attachments.
--
-- Thêm tham số DEFAULT vào hàm sẵn có tạo OVERLOAD (10 vs 11 args) → PostgREST
-- named args dính "function is not unique" ⇒ DROP signature cũ, re-grant.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.create_commission_voucher(
  uuid, text, numeric, date, uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.create_commission_voucher(
  p_contract_id uuid,
  p_kind text,
  p_amount numeric,
  p_voucher_date date,
  p_account_id uuid DEFAULT NULL::uuid,
  p_payer_name text DEFAULT NULL::text,
  p_recipient_name text DEFAULT NULL::text,
  p_recipient_bank text DEFAULT NULL::text,
  p_recipient_account text DEFAULT NULL::text,
  p_item_description text DEFAULT NULL::text,
  p_attachments jsonb DEFAULT '[]'::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_contract record;
  v_existing record;
  v_type_id uuid;
  v_type_name text;
  v_kind_label text;
  v_creator text;
  v_name text;
  v_id uuid;
  v_code text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broker', 'sale') THEN
    RAISE EXCEPTION 'Loại hoa hồng không hợp lệ: %', COALESCE(p_kind, 'null')
      USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền hoa hồng phải lớn hơn 0'
      USING ERRCODE = '23514';
  END IF;
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chi' USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    contract_row.id,
    contract_row.contract_number,
    room_row.id AS room_id,
    building_row.id AS building_id,
    building_row.user_id AS owner_id,
    COALESCE(contract_row.organization_id, building_row.organization_id)
      AS organization_id
  INTO v_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE = 'P0002';
  END IF;
  IF v_contract.organization_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa thuộc tổ chức'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    public.can_access_building(v_contract.building_id)
    OR public.ie_all_buildings_scope(v_contract.building_id)
    OR v_contract.owner_id = v_uid
    OR public.is_admin()
    OR public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền chi hoa hồng cho tòa nhà này'
      USING ERRCODE = '42501';
  END IF;

  v_kind_label := CASE p_kind
    WHEN 'broker' THEN 'hoa hồng môi giới'
    ELSE 'thưởng nóng Sale'
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext('commission:' || p_contract_id::text || ':' || p_kind)
  );

  SELECT voucher.code
    INTO v_existing
  FROM public.income_expenses voucher
  WHERE voucher.contract_id = p_contract_id
    AND voucher.commission_kind = p_kind
    AND voucher.deleted_at IS NULL
    AND voucher.approval_status <> 'CANCELLED'
  ORDER BY voucher.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HĐ % đã có phiếu % (mã %). Mỗi hợp đồng chỉ chi 1 lần — không thể tạo thêm. Nếu phiếu cũ sai, hãy hủy phiếu đó trước.',
      COALESCE(v_contract.contract_number, ''),
      v_kind_label,
      v_existing.code
      USING ERRCODE = 'P0001';
  END IF;

  -- SALE_BONUS_SEES_DEPOSIT_CLAIM: phiếu thưởng Sale có thể đã sinh từ PHIẾU CỌC lúc
  -- hợp đồng chưa tồn tại. Phiếu đó contract_id NULL nên VÔ HÌNH với cả
  -- advisory lock, pre-check P0001 lẫn unique index ở trên. Không có chốt
  -- này thì mở luồng "thưởng từ phiếu cọc" là mở toang khoá chống chi trùng.
  IF p_kind = 'sale' THEN
    DECLARE v_prev uuid; v_prev_code text;
    BEGIN
      SELECT bon.id, bon.code INTO v_prev, v_prev_code
        FROM app_private.sale_bonus_claims sbc
        JOIN public.income_expenses dep ON dep.id = sbc.deposit_voucher_id
        JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
       WHERE dep.contract_id = p_contract_id
         AND bon.deleted_at IS NULL
         AND bon.approval_status <> 'CANCELLED'
       LIMIT 1;
      IF v_prev IS NOT NULL THEN
        RAISE EXCEPTION 'Hợp đồng này đã được thưởng Sale từ phiếu cọc rồi (phiếu %)',
          COALESCE(v_prev_code, v_prev::text) USING ERRCODE = 'P0001';
      END IF;
    END;
  END IF;

  v_type_name := CASE p_kind
    WHEN 'broker' THEN 'Hoa hồng môi giới'
    ELSE 'Thưởng nóng Sale'
  END;

  SELECT t.id
    INTO v_type_id
  FROM public.income_expense_types AS t
  WHERE t.organization_id = v_contract.organization_id
    AND lower(btrim(t.type)) = 'expense'
    AND public.normalize_income_expense_type_name(t.name) =
        public.normalize_income_expense_type_name(v_type_name)
  ORDER BY COALESCE(t.is_default, false) DESC, t.created_at, t.id
  LIMIT 1;

  IF v_type_id IS NULL THEN
    v_type_id := app_private.ensure_income_expense_type_v1(
      p_organization_id => v_contract.organization_id,
      p_user_id => v_contract.owner_id,
      p_name => v_type_name,
      p_type => 'expense',
      p_description => CASE p_kind
        WHEN 'broker' THEN 'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.'
        ELSE 'Thưởng cho Sale khi tạo hợp đồng — số tiền do người dùng nhập.'
      END,
      p_force_approval => true,
      p_system_only => true
    );
  END IF;

  SELECT COALESCE(
           NULLIF(profile.full_name, ''),
           NULLIF(profile.email, ''),
           auth_user.email,
           'Người dùng'
         )
    INTO v_creator
  FROM auth.users auth_user
  LEFT JOIN public.profiles profile ON profile.id = auth_user.id
  WHERE auth_user.id = v_uid;

  v_name := btrim(
    CASE p_kind
      WHEN 'broker' THEN 'Hoa hồng môi giới HĐ '
      ELSE 'Thưởng nóng Sale HĐ '
    END || COALESCE(v_contract.contract_number, '')
  );

  INSERT INTO public.income_expenses (
    user_id,
    organization_id,
    creator_name,
    type,
    approval_status,
    name,
    building_id,
    room_id,
    tenant_id,
    contract_id,
    voucher_date,
    account_id,
    payer_name,
    receive_bank_name,
    receive_bank_account,
    notes,
    attachments,
    business_result_accounting,
    repeat_cycle,
    repeat_infinity,
    repeat_count,
    repeat_remaining,
    commission_kind,
    system_source
  ) VALUES (
    v_uid,
    v_contract.organization_id,
    v_creator,
    'EXPENSE',
    'UNAPPROVED',
    v_name,
    v_contract.building_id,
    v_contract.room_id,
    NULL,
    p_contract_id,
    p_voucher_date,
    p_account_id,
    p_payer_name,
    p_recipient_bank,
    p_recipient_account,
    CASE
      WHEN COALESCE(p_recipient_name, '') <> ''
        THEN 'Người nhận: ' || p_recipient_name
      ELSE NULL
    END,
    v_attachments,
    NULL,
    'NONE',
    false,
    0,
    0,
    p_kind,
    'contract.commission'
  )
  RETURNING id, code INTO v_id, v_code;

  INSERT INTO public.income_expense_items (
    income_expense_id,
    income_expense_type_id,
    organization_id,
    description,
    quantity,
    unit_price,
    start_date,
    end_date
  ) VALUES (
    v_id,
    v_type_id,
    v_contract.organization_id,
    COALESCE(NULLIF(p_item_description, ''), v_name),
    1,
    p_amount,
    p_voucher_date,
    p_voucher_date
  );

  -- COMMISSION_AUTOPAY_V1: hoa hồng môi giới đủ bốn điều kiện chủ chốt 31/07 thì
  -- máy duyệt hộ và ghi sổ luôn. Thiếu một điều ⇒ để nguyên chờ duyệt (hành
  -- vi cũ). Bảng bậc rỗng ⇒ luôn rơi vào NO_TIER ⇒ không phiếu nào tự duyệt.
  IF p_kind = 'broker' AND v_id IS NOT NULL THEN
    DECLARE v_chk jsonb; v_acc_ok boolean;
    BEGIN
      v_chk := app_private.commission_autopay_check_v1(p_contract_id, p_amount);
      SELECT (a.id IS NOT NULL AND NOT COALESCE(a.is_virtual,false)) INTO v_acc_ok
        FROM public.accounts a
       WHERE a.id = (SELECT account_id FROM public.income_expenses WHERE id = v_id);
      IF (v_chk->>'verdict') = 'VALID' AND COALESCE(v_acc_ok,false) THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_id, 'BROKER_COMMISSION');
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END
$function$;

REVOKE ALL ON FUNCTION public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
