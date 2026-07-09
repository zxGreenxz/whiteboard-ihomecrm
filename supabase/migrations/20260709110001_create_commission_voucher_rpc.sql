-- =============================================================================
-- create_commission_voucher — đường TẠO DUY NHẤT cho phiếu HH môi giới/thưởng Sale
-- (thay client-side insert trong useCommissionVoucher.ts).
--
-- - Atomic: voucher + item cùng transaction (hết phiếu mồ côi khi item fail).
-- - Advisory xact lock theo (contract, kind) → chống race double-click/2 tab.
-- - Check tồn tại phiếu sống cùng (contract, kind) — kể cả phiếu legacy_dup —
--   → RAISE tiếng Việt rõ ràng. Unique index uq_ie_commission_per_contract
--   (20260709110000) là hàng rào cuối.
-- - Resolve income_expense_type theo OWNER của tòa (trước đây hook tra theo
--   user đang bấm → staff thiếu type seed sẽ fail). Thiếu type → seed lại
--   qua seed_commission_expense_types() có sẵn (20260510000021).
-- - Luôn tạo UNAPPROVED (quyết định chủ 09/07: bỏ auto-duyệt, mọi phiếu HH
--   qua bước duyệt thủ công có audit approved_by/approved_at).
-- - Kiểm quyền như get_period_commissions; revoke anon (pattern repo).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.create_commission_voucher(
  p_contract_id uuid,
  p_kind text,
  p_amount numeric,
  p_voucher_date date,
  p_account_id uuid DEFAULT NULL,
  p_payer_name text DEFAULT NULL,
  p_recipient_name text DEFAULT NULL,
  p_recipient_bank text DEFAULT NULL,
  p_recipient_account text DEFAULT NULL,
  p_item_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_contract  record;
  v_existing  record;
  v_type_id   uuid;
  v_type_name text;
  v_kind_label text;
  v_creator   text;
  v_name      text;
  v_id        uuid;
  v_code      text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broker','sale') THEN
    RAISE EXCEPTION 'Loại hoa hồng không hợp lệ: %', COALESCE(p_kind, 'null');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền hoa hồng phải lớn hơn 0';
  END IF;
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chi';
  END IF;

  SELECT c.id, c.contract_number,
         r.id AS room_id, b.id AS building_id, b.user_id AS owner_id
    INTO v_contract
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id
    JOIN buildings b ON b.id = r.building_id
   WHERE c.id = p_contract_id AND c.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng';
  END IF;

  IF NOT (public.can_access_building(v_contract.building_id)
          OR public.ie_all_buildings_scope(v_contract.building_id)
          OR v_contract.owner_id = v_uid
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền chi hoa hồng cho tòa nhà này' USING ERRCODE = '42501';
  END IF;

  v_kind_label := CASE p_kind WHEN 'broker' THEN 'hoa hồng môi giới' ELSE 'thưởng nóng Sale' END;

  -- Chống race: khóa theo (contract, kind) đến hết transaction
  PERFORM pg_advisory_xact_lock(hashtext('commission:' || p_contract_id::text || ':' || p_kind));

  SELECT ie.code INTO v_existing
    FROM income_expenses ie
   WHERE ie.contract_id = p_contract_id
     AND ie.commission_kind = p_kind
     AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
   ORDER BY ie.created_at DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'HĐ % đã có phiếu % (mã %). Mỗi hợp đồng chỉ chi 1 lần — không thể tạo thêm. Nếu phiếu cũ sai, hãy hủy phiếu đó trước.',
      COALESCE(v_contract.contract_number, ''), v_kind_label, v_existing.code
      USING ERRCODE = 'P0001';
  END IF;

  -- Resolve type theo OWNER của tòa; thiếu thì seed lại (idempotent)
  v_type_name := CASE p_kind WHEN 'broker' THEN 'Hoa hồng môi giới' ELSE 'Thưởng nóng Sale' END;
  SELECT t.id INTO v_type_id
    FROM income_expense_types t
   WHERE t.user_id = v_contract.owner_id AND t.type = 'expense'
     AND public.nrm_vn(t.name) = public.nrm_vn(v_type_name)
   ORDER BY t.is_default DESC NULLS LAST, t.created_at ASC
   LIMIT 1;
  IF v_type_id IS NULL THEN
    PERFORM public.seed_commission_expense_types(v_contract.owner_id);
    SELECT t.id INTO v_type_id
      FROM income_expense_types t
     WHERE t.user_id = v_contract.owner_id AND t.type = 'expense'
       AND public.nrm_vn(t.name) = public.nrm_vn(v_type_name)
     ORDER BY t.is_default DESC NULLS LAST, t.created_at ASC
     LIMIT 1;
  END IF;
  IF v_type_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy hạng mục "%" của chủ tòa nhà', v_type_name;
  END IF;

  SELECT COALESCE(NULLIF(p.full_name, ''), NULLIF(p.email, ''), u.email, 'Người dùng')
    INTO v_creator
    FROM auth.users u
    LEFT JOIN profiles p ON p.id = u.id
   WHERE u.id = v_uid;

  v_name := trim(
    (CASE p_kind WHEN 'broker' THEN 'Hoa hồng môi giới HĐ ' ELSE 'Thưởng nóng Sale HĐ ' END)
    || COALESCE(v_contract.contract_number, ''));

  INSERT INTO income_expenses (
    user_id, creator_name, type, approval_status, name,
    building_id, room_id, tenant_id, contract_id,
    voucher_date, account_id, payer_name,
    receive_bank_name, receive_bank_account, notes,
    attachments, business_result_accounting,
    repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    commission_kind, system_source
  ) VALUES (
    v_uid, v_creator, 'EXPENSE', 'UNAPPROVED', v_name,
    v_contract.building_id, v_contract.room_id, NULL, p_contract_id,
    p_voucher_date, p_account_id, p_payer_name,
    p_recipient_bank, p_recipient_account,
    CASE WHEN COALESCE(p_recipient_name, '') <> '' THEN 'Người nhận: ' || p_recipient_name ELSE NULL END,
    '[]'::jsonb, NULL,
    'NONE', false, 0, 0,
    p_kind, 'contract.commission'
  ) RETURNING id, code INTO v_id, v_code;

  INSERT INTO income_expense_items (
    income_expense_id, income_expense_type_id, description,
    quantity, unit_price, start_date, end_date
  ) VALUES (
    v_id, v_type_id, COALESCE(NULLIF(p_item_description, ''), v_name),
    1, p_amount, p_voucher_date, p_voucher_date
  );

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text) TO authenticated;

-- =============================================================================
-- get_period_commissions — dedup theo commission_kind='broker' thay vì dò tên
-- type LIKE (bản cũ 20260708130400 nhận nhầm phiếu Thưởng nóng Sale là "đã chi
-- HH môi giới", và không bỏ qua phiếu CANCELLED).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_period_commissions(
  p_period_month text,
  p_building_ids uuid[] DEFAULT NULL
) RETURNS TABLE(
  contract_id      uuid,
  contract_number  text,
  building_id      uuid,
  building_name    text,
  room_id          uuid,
  room_name        text,
  tenant_name      text,
  signed_date      date,
  months           int,
  tier_percent     numeric,
  expected_amount  numeric,
  voucher_id       uuid,
  account_is_empty boolean,
  status           text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start date;
  v_end   date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', v_start) + interval '1 month - 1 day')::date;

  RETURN QUERY
  WITH bld AS (
    SELECT b.id, b.name, b.commission_tiers
      FROM buildings b
     WHERE (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
       AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  ct AS (
    SELECT c.id, c.contract_number, c.signed_date, c.rent_price,
           r.id AS room_id, r.name AS room_name,
           bld.id AS building_id, bld.name AS building_name, bld.commission_tiers,
           GREATEST(
             (EXTRACT(YEAR FROM age(c.end_date, c.start_date)) * 12
              + EXTRACT(MONTH FROM age(c.end_date, c.start_date)))::int, 0) AS months
      FROM contracts c
      JOIN rooms r ON r.id = c.room_id
      JOIN bld ON bld.id = r.building_id
     WHERE c.deleted_at IS NULL
       AND c.signed_date >= v_start AND c.signed_date <= v_end
  )
  SELECT
    ct.id, ct.contract_number, ct.building_id, ct.building_name,
    ct.room_id, ct.room_name,
    COALESCE(rep.full_name, ''),
    ct.signed_date, ct.months,
    tier.rate,
    ROUND(ct.rent_price * COALESCE(tier.rate, 0) / 100.0)::numeric,
    v.voucher_id,
    COALESCE(v.acc_empty, false),
    CASE WHEN v.voucher_id IS NOT NULL THEN 'paid' ELSE 'unpaid' END
  FROM ct
  LEFT JOIN LATERAL (
    SELECT cust.full_name
      FROM contract_customers cc
      JOIN customers cust ON cust.id = cc.customer_id
     WHERE cc.contract_id = ct.id
     ORDER BY cc.is_representative DESC NULLS LAST
     LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      (SELECT (t->>'rate_percent')::numeric
         FROM jsonb_array_elements(COALESCE(ct.commission_tiers, '[]'::jsonb)) t
        WHERE ct.months >= (t->>'min_months')::int AND ct.months <= (t->>'max_months')::int
        ORDER BY (t->>'min_months')::int LIMIT 1),
      (SELECT (t->>'rate_percent')::numeric
         FROM jsonb_array_elements(COALESCE(ct.commission_tiers, '[]'::jsonb)) t
        WHERE ct.months > (t->>'max_months')::int
        ORDER BY (t->>'max_months')::int DESC LIMIT 1)
    ) AS rate
  ) tier ON true
  LEFT JOIN LATERAL (
    SELECT ie.id AS voucher_id, (ie.account_id IS NULL) AS acc_empty
      FROM income_expenses ie
     WHERE ie.contract_id = ct.id
       AND ie.type = 'EXPENSE'
       AND ie.deleted_at IS NULL
       AND ie.approval_status <> 'CANCELLED'
       AND ie.commission_kind = 'broker'
     ORDER BY ie.created_at DESC LIMIT 1
  ) v ON true
  ORDER BY ct.signed_date DESC, ct.contract_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_period_commissions(text,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_commissions(text,uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
