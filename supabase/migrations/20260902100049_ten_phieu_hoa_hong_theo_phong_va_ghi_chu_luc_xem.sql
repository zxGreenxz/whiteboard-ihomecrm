-- =============================================================================
-- Tên phiếu hoa hồng theo PHÒNG + facts hợp đồng để dựng ghi chú LÚC XEM
-- (quyết định chủ 02/09/2026).
--
-- VÌ SAO
--   Phiếu "Hoa hồng môi giới HĐ HD-2026-00277" không nói được phòng nào, ký lần
--   thứ mấy trong năm, đã cọc đủ chưa, đã qua 7 ngày chưa, khách là ai. Kế toán
--   phải mở HĐ ra đối chiếu từng phiếu.
--
-- LÀM GÌ
--   1. app_private.commission_contract_facts_v1(contract)  — facts thô của HĐ:
--      phòng/toà, STT HĐ của phòng trong năm, giá, số tháng, cọc phải/đã (theo
--      contract_deposit_paid_derived — nguồn dùng chung), từng phiếu cọc kèm phần
--      cọc / tổng phiếu, mốc 7 ngày (org_today_v1 ≥ start_date+7 — đúng luật tự
--      duyệt), khách đại diện + SĐT, trạng thái. Nội bộ, REVOKE hết.
--   2. app_private.commission_voucher_name_v1(kind, contract) —
--      "Hoa hồng 205/1392QT - 28/07/2026 - 2". NULL khi HĐ không có phòng.
--   3. public.get_commission_voucher_facts_v1(uuid[]) — RPC đọc cho client, gate
--      quyền theo toà y hệt create_commission_voucher, chốt biên giới org.
--   4. create_commission_voucher: chép NGUYÊN KHỐI bản 20260806090000, chỉ đổi
--      cách đặt v_name (fallback tên cũ nếu facts NULL).
--   5. Backfill `name` cho phiếu hoa hồng cũ có HĐ + phòng. Đo prod 02/09/2026:
--      138 phiếu, 0 flow-owned, 0 sổ chốt, 0 bàn giao ⇒ UPDATE cột name đi lọt
--      mọi guard. CHỈ đổi cột name — không đụng tiền/sổ/trạng thái/hạng mục.
--
-- KHÔNG LÀM: không đổi cột notes ("Người nhận: X" — extractRecipientFromNotes
--   đọc nó); không đổi chữ ký create_commission_voucher (không overload).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. FACTS HỢP ĐỒNG (nội bộ)
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.commission_contract_facts_v1(p_contract_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
WITH c AS (
  SELECT ct.id, ct.contract_number,
         -- enum → text trước khi so (án lệ 22P02 ở commission_autopay_check_v1)
         ct.status::text AS status,
         ct.signed_date, ct.start_date, ct.end_date, ct.expected_move_out_date,
         ct.rent_price, ct.total_deposit, ct.created_at, ct.room_id,
         r.name AS room_name, r.building_id, b.name AS building_name,
         COALESCE(ct.organization_id, b.organization_id) AS organization_id,
         EXTRACT(YEAR FROM ct.start_date)::int AS y
    FROM public.contracts ct
    LEFT JOIN public.rooms r ON r.id = ct.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
   WHERE ct.id = p_contract_id AND ct.deleted_at IS NULL
),
-- STT của HĐ trong năm Y (năm bắt đầu): số HĐ KHÁC của cùng phòng (không DRAFT,
-- chưa xoá) còn hiệu lực bất kỳ lúc nào trong năm Y và đứng TRƯỚC theo
-- (start_date, created_at, id), cộng 1. HĐ năm trước kéo sang có start_date nhỏ
-- hơn nên đứng trước ⇒ nó là 1, HĐ ký đầu tiên trong năm là 2 — đúng luật chủ.
-- Đếm "trước + 1" thay vì "đếm ≤ chính nó" để HĐ này luôn có số kể cả khi DRAFT.
seq AS (
  SELECT count(o.id)::int + 1 AS seq_in_year
    FROM c
    LEFT JOIN public.contracts o
      ON o.room_id = c.room_id
     AND o.id <> c.id
     AND o.deleted_at IS NULL
     AND o.status::text <> 'DRAFT'
     AND o.start_date <= make_date(c.y, 12, 31)
     AND o.end_date   >= make_date(c.y, 1, 1)
     AND (o.start_date, o.created_at, o.id) < (c.start_date, c.created_at, c.id)
   WHERE c.room_id IS NOT NULL
),
-- Phiếu cọc: ĐÚNG tập + ĐÚNG công thức của public.contract_deposit_paid_derived
-- (gắn HĐ trực tiếp hoặc qua contract_deposit_links; APPROVED; chưa xoá; item
-- accounting_class = DEPOSIT; THU cộng / CHI trừ; chặn dưới 0). Chép công thức
-- thay vì gọi hàm đó vì hàm đó dùng `contract_id = X OR link` trên LEFT JOIN —
-- planner quét toàn bảng thu chi mỗi lần gọi; backfill gọi ~400 lần thì treo
-- quá 2 phút (đo 02/09/2026). Hai đường UNION dưới đây đều đi index.
-- Liệt kê cả chiều CHI (hoàn cọc) — client phân biệt bằng `type`.
dep_src AS (
  SELECT v.id FROM public.income_expenses v WHERE v.contract_id = p_contract_id
  UNION
  SELECT l.income_expense_id FROM public.contract_deposit_links l WHERE l.contract_id = p_contract_id
),
dep AS (
  SELECT v.id, v.code, v.voucher_date, v.type, v.total_amount, v.created_at,
         d.dep AS deposit_amount
    FROM dep_src s
    JOIN public.income_expenses v ON v.id = s.id
    JOIN LATERAL (
      SELECT SUM(COALESCE(i.amount, i.unit_price * i.quantity))::numeric(15,2) AS dep
        FROM public.income_expense_items i
       WHERE i.income_expense_id = v.id
         AND i.accounting_class = 'DEPOSIT'
    ) d ON d.dep IS NOT NULL
   WHERE v.approval_status = 'APPROVED'
     AND v.deleted_at IS NULL
),
paid AS (
  SELECT GREATEST(COALESCE(SUM(CASE WHEN dep.type = 'EXPENSE' THEN -1 ELSE 1 END * dep.deposit_amount), 0), 0)::numeric(15,2) AS v
    FROM dep
),
rep AS (
  SELECT cu.full_name, cu.phone
    FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id = cc.customer_id
   WHERE cc.contract_id = p_contract_id
   ORDER BY cc.is_representative DESC, cc.created_at, cc.id
   LIMIT 1
)
SELECT jsonb_build_object(
  'contract_id',            c.id,
  'contract_number',        c.contract_number,
  'organization_id',        c.organization_id,
  'building_id',            c.building_id,
  'building_name',          c.building_name,
  'room_id',                c.room_id,
  'room_name',              c.room_name,
  'status',                 c.status,
  'signed_date',            c.signed_date,
  'start_date',             c.start_date,
  'end_date',               c.end_date,
  'expected_move_out_date', c.expected_move_out_date,
  'seq_in_year',            CASE WHEN c.room_id IS NULL THEN NULL
                                 ELSE (SELECT seq_in_year FROM seq) END,
  'rent_price',             c.rent_price,
  -- Cùng công thức với commission_autopay_check_v1 / get_period_commissions.
  'months',                 GREATEST(0, (EXTRACT(YEAR FROM age(c.end_date, c.start_date)) * 12
                                       + EXTRACT(MONTH FROM age(c.end_date, c.start_date)))::int),
  'total_deposit',          c.total_deposit,
  'deposit_paid',           (SELECT v FROM paid),
  'deposit_enough',         (SELECT v FROM paid) >= COALESCE(c.total_deposit, 0),
  'deposit_vouchers',       COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', dep.id, 'code', dep.code, 'voucher_date', dep.voucher_date,
             'type', dep.type, 'deposit_amount', dep.deposit_amount,
             'total_amount', dep.total_amount,
             'is_combined', dep.total_amount > dep.deposit_amount + 0.005)
           ORDER BY dep.voucher_date, dep.created_at, dep.id)
      FROM dep), '[]'::jsonb),
  'today',                  public.org_today_v1(c.organization_id),
  'seven_days_date',        c.start_date + 7,
  -- Khớp autopay: NOT (today < start_date + 7).
  'seven_days_ok',          public.org_today_v1(c.organization_id) >= c.start_date + 7,
  'rep_name',               (SELECT full_name FROM rep),
  'rep_phone',              (SELECT phone FROM rep)
)
FROM c;
$fn$;

REVOKE ALL ON FUNCTION app_private.commission_contract_facts_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.commission_contract_facts_v1(uuid) IS
  'Facts của một HĐ để đặt tên và dựng ghi chú phiếu hoa hồng: phòng/toà, STT HĐ '
  'của phòng trong năm bắt đầu, giá, số tháng (age), cọc phải/đã (theo '
  'contract_deposit_paid_derived) + từng phiếu cọc kèm phần cọc/tổng phiếu, mốc 7 '
  'ngày (org_today_v1 ≥ start_date+7), khách đại diện, trạng thái. NULL khi HĐ '
  'không tồn tại/đã xoá. Nội bộ — KHÔNG cấp cho client.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. TÊN PHIẾU (nội bộ)
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.commission_voucher_name_v1(p_kind text, p_contract_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT CASE
    WHEN p_kind NOT IN ('broker', 'sale') THEN NULL
    WHEN s.f IS NULL
      OR s.f->>'room_name'   IS NULL
      OR s.f->>'seq_in_year' IS NULL
      OR s.f->>'start_date'  IS NULL THEN NULL
    ELSE btrim(
      CASE p_kind WHEN 'broker' THEN 'Hoa hồng ' ELSE 'Thưởng nóng Sale ' END
      || (s.f->>'room_name') || '/' || COALESCE(s.f->>'building_name', '')
      || ' - ' || to_char((s.f->>'start_date')::date, 'DD/MM/YYYY')
      || ' - ' || (s.f->>'seq_in_year'))
  END
  FROM (SELECT app_private.commission_contract_facts_v1(p_contract_id) AS f) s;
$fn$;

REVOKE ALL ON FUNCTION app_private.commission_voucher_name_v1(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.commission_voucher_name_v1(text, uuid) IS
  'Tên phiếu hoa hồng theo phòng: "Hoa hồng <Phòng>/<Tòa> - dd/mm/yyyy - STT" '
  '(sale: "Thưởng nóng Sale …"). NULL khi HĐ không có phòng — caller giữ tên cũ.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. RPC ĐỌC FACTS CHO CLIENT
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_commission_voucher_facts_v1(p_voucher_ids uuid[])
RETURNS TABLE(voucher_id uuid, facts jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_ids  uuid[];
  v_id   uuid;
  r      record;
  f      jsonb;
  v_rate numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher_ids IS NULL THEN
    RETURN;
  END IF;
  IF cardinality(p_voucher_ids) > 200 THEN
    RAISE EXCEPTION 'Tối đa 200 phiếu mỗi lần' USING ERRCODE = '22023';
  END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(p_voucher_ids) AS x WHERE x IS NOT NULL);

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT ie.id, ie.contract_id, ie.commission_kind, ie.total_amount,
           ie.building_id, ie.organization_id, b.user_id AS owner_id
      INTO r
      FROM public.income_expenses ie
      LEFT JOIN public.buildings b ON b.id = ie.building_id
     WHERE ie.id = v_id
       AND ie.deleted_at IS NULL
       AND ie.commission_kind IN ('broker', 'sale')
       AND ie.contract_id IS NOT NULL;
    CONTINUE WHEN NOT FOUND;

    -- Gate quyền y hệt create_commission_voucher. Không đủ quyền ⇒ bỏ qua IM
    -- LẶNG: trả dòng "không quyền" cũng đã xác nhận phiếu tồn tại.
    CONTINUE WHEN NOT (
      (r.building_id IS NOT NULL AND public.can_access_building(r.building_id))
      OR (r.building_id IS NOT NULL AND public.ie_all_buildings_scope(r.building_id))
      OR r.owner_id = v_uid
      OR public.is_admin()
      OR public.is_super_admin()
    );

    f := app_private.commission_contract_facts_v1(r.contract_id);
    CONTINUE WHEN f IS NULL;
    -- Chốt biên giới org: definer đọc xuyên RLS nên phải tự kiểm HĐ cùng org.
    CONTINUE WHEN (f->>'organization_id')::uuid IS DISTINCT FROM r.organization_id;

    v_rate := CASE
      WHEN r.commission_kind = 'broker' AND COALESCE((f->>'rent_price')::numeric, 0) > 0
        THEN round(r.total_amount / (f->>'rent_price')::numeric * 100, 1)
      ELSE NULL
    END;

    voucher_id := r.id;
    facts := f || jsonb_build_object(
      'commission_kind', r.commission_kind,
      'total_amount',    r.total_amount,
      'rate_percent',    v_rate);
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.get_commission_voucher_facts_v1(uuid[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_commission_voucher_facts_v1(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_commission_voucher_facts_v1(uuid[]) IS
  'Facts HĐ của tối đa 200 phiếu hoa hồng (broker/sale, có contract_id) để client '
  'dựng ghi chú lúc xem. Gate quyền theo toà như create_commission_voucher; phiếu '
  'không quyền / khác org bị bỏ qua im lặng. CHỈ ĐỌC.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. create_commission_voucher — chép nguyên khối 20260806090000, chỉ đổi v_name
-- ─────────────────────────────────────────────────────────────────────

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

  -- TÊN THEO PHÒNG (02/09/2026): "Hoa hồng <Phòng>/<Tòa> - dd/mm/yyyy - STT".
  -- Facts NULL (HĐ không có phòng) ⇒ giữ tên cũ để không bao giờ chặn tạo phiếu.
  v_name := COALESCE(
    app_private.commission_voucher_name_v1(p_kind, p_contract_id),
    btrim(
      CASE p_kind
        WHEN 'broker' THEN 'Hoa hồng môi giới HĐ '
        ELSE 'Thưởng nóng Sale HĐ '
      END || COALESCE(v_contract.contract_number, '')
    )
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

-- ─────────────────────────────────────────────────────────────────────
-- 5. BACKFILL TÊN PHIẾU CŨ — chỉ cột name, idempotent (IS DISTINCT FROM)
--
-- Phiếu không có HĐ (thưởng Sale sinh từ phiếu cọc) hoặc HĐ không có phòng ⇒
-- name_v1 NULL ⇒ giữ nguyên. Gồm cả phiếu APPROVED/CANCELLED: tên chỉ là nhãn,
-- không phải cột tài chính. Trên DB rỗng: 0 dòng, vẫn đúng.
-- ─────────────────────────────────────────────────────────────────────
DO $backfill$
DECLARE
  v_truoc int;
  v_sau   int;
BEGIN
  SELECT count(*) INTO v_truoc
    FROM public.income_expenses x
   WHERE x.commission_kind IN ('broker', 'sale')
     AND x.deleted_at IS NULL
     AND x.contract_id IS NOT NULL
     AND x.name IS DISTINCT FROM app_private.commission_voucher_name_v1(x.commission_kind, x.contract_id)
     AND app_private.commission_voucher_name_v1(x.commission_kind, x.contract_id) IS NOT NULL;
  RAISE NOTICE '[hoa-hong] sắp đổi tên % phiếu', v_truoc;

  UPDATE public.income_expenses ie
     SET name = n.ten
    FROM (
      SELECT x.id,
             app_private.commission_voucher_name_v1(x.commission_kind, x.contract_id) AS ten
        FROM public.income_expenses x
       WHERE x.commission_kind IN ('broker', 'sale')
         AND x.deleted_at IS NULL
         AND x.contract_id IS NOT NULL
    ) n
   WHERE n.id = ie.id
     AND n.ten IS NOT NULL
     AND ie.name IS DISTINCT FROM n.ten;
  GET DIAGNOSTICS v_sau = ROW_COUNT;
  RAISE NOTICE '[hoa-hong] đã đổi tên % phiếu', v_sau;

  IF v_sau <> v_truoc THEN
    RAISE EXCEPTION '[hoa-hong] đếm trước (%) ≠ số đã đổi (%) — có trigger chặn im lặng? DỪNG.', v_truoc, v_sau;
  END IF;
END
$backfill$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. SELFCHECK — không phụ thuộc dữ liệu (chạy được trên DB rỗng)
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE
  v_def text;
  v_con_lech int;
BEGIN
  IF to_regprocedure('app_private.commission_contract_facts_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.commission_voucher_name_v1(text,uuid)') IS NULL
     OR to_regprocedure('public.get_commission_voucher_facts_v1(uuid[])') IS NULL
     OR to_regprocedure('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm sau migration. DỪNG.';
  END IF;

  IF app_private.commission_contract_facts_v1(gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'facts của HĐ không tồn tại phải NULL. DỪNG.';
  END IF;
  IF app_private.commission_voucher_name_v1('broker', gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'name_v1 của HĐ không tồn tại phải NULL. DỪNG.';
  END IF;

  -- Thân create_commission_voucher: đã nối tên mới VÀ không rơi khối nào khi chép.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';
  IF position('commission_voucher_name_v1(p_kind, p_contract_id)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher chưa dùng commission_voucher_name_v1. DỪNG.';
  END IF;
  IF position('''Người nhận: '' || p_recipient_name' IN v_def) = 0
     OR position('commission_autopay_check_v1(' IN v_def) = 0
     OR position('sale_bonus_claims' IN v_def) = 0
     OR position('pg_advisory_xact_lock(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher rơi khối khi chép (notes/autopay/claim/lock). DỪNG.';
  END IF;

  -- ACL: RPC public không mở cho anon; hàm nội bộ không mở cho authenticated.
  IF has_function_privilege('anon', 'public.get_commission_voucher_facts_v1(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.commission_contract_facts_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.commission_voucher_name_v1(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_commission_voucher_facts_v1(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL hàm hoa hồng sai. DỪNG.';
  END IF;

  -- Sau backfill: không còn phiếu có HĐ+phòng mà tên lệch name_v1 (DB rỗng ⇒ 0).
  SELECT count(*) INTO v_con_lech
    FROM public.income_expenses x
   WHERE x.commission_kind IN ('broker', 'sale')
     AND x.deleted_at IS NULL
     AND x.contract_id IS NOT NULL
     AND app_private.commission_voucher_name_v1(x.commission_kind, x.contract_id) IS NOT NULL
     AND x.name IS DISTINCT FROM app_private.commission_voucher_name_v1(x.commission_kind, x.contract_id);
  IF v_con_lech > 0 THEN
    RAISE EXCEPTION 'Còn % phiếu hoa hồng tên lệch sau backfill. DỪNG.', v_con_lech;
  END IF;
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
