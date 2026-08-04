-- =====================================================================
-- THƯỞNG NÓNG SALE — tạo được ngay từ PHIẾU CỌC, và không chi trùng
--
-- Yêu cầu của chủ 31/07/2026, nguyên văn:
--   "Thưởng Sale được tạo ngay khi tạo phiếu cọc phòng. Luồng tạo phiếu thưởng
--    sale sau khi ký HĐ: nếu chưa có phiếu thưởng nào cho HĐ (phiếu cọc gắn vào
--    HĐ này) thì vẫn cho tạo phiếu thưởng kèm hợp đồng; nếu có thì phần điền
--    phiếu thưởng sẽ tô xám và báo rõ đã thưởng sale bao nhiêu, khi nào."
--
-- ─────────────────────────────────────────────────────────────────────
-- VÌ SAO PHẢI CÓ SỔ RIÊNG, KHÔNG DÙNG LẠI KHOÁ CŨ
--
-- `create_commission_voucher` đã có chốt chống trùng, nhưng nó khoá theo
-- `(contract_id, commission_kind)` — cả pre-check `P0001`, advisory lock, lẫn
-- unique index `uq_ie_commission_per_contract` đều cần `contract_id NOT NULL`.
-- Phiếu thưởng sinh từ PHIẾU CỌC thì lúc đó **chưa có hợp đồng nào** ⇒ nó
-- `contract_id = NULL` ⇒ **vô hình với cả ba lớp khoá**. Đến khi hợp đồng được
-- ký, hệ thống không thấy phiếu cũ và cho chi lần hai cho cùng một thương vụ.
--
-- Đây không phải lo xa: prod đã có ca chi trùng thật — hợp đồng HD-2026-00253
-- (toà 102LVT) nhận BA phiếu thưởng 500.000đ trong 29 giây sáng 12/05/2026,
-- cùng một người tạo, phải huỷ tay cả ba. Đó là lúc khoá còn nguyên vẹn.
--
-- ⇒ Mở luồng mới mà không vá khoá cùng lúc là mở toang. Sổ `sale_bonus_claims`
--   dưới đây nối phiếu thưởng với PHIẾU CỌC, và câu hỏi "hợp đồng này thưởng
--   chưa" được trả lời qua HAI đường: gắn thẳng hợp đồng, HOẶC gắn phiếu cọc mà
--   phiếu cọc đó nay đã thuộc hợp đồng.
--
-- ─────────────────────────────────────────────────────────────────────
-- TRẦN THƯỞNG: ra đời RỖNG, y như bảng giá phí cố định
--
-- Hôm nay hệ thống KHÔNG có trần nào cho thưởng Sale — gõ bao nhiêu cũng qua,
-- miễn lớn hơn 0. Bảng trần dưới đây rỗng lúc tạo ⇒ **hành vi không đổi một ly**;
-- trần chỉ có hiệu lực khi chủ công bố. Không có "ngày X mọi thứ đổi".
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.create_commission_voucher(uuid,text,numeric,date,text,text,text,uuid,jsonb,text)') IS NULL
     AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher') = 0 THEN
    RAISE EXCEPTION 'Thiếu create_commission_voucher. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 0bis. MỞ MỘT CỬA HẸP CHO PHIẾU THƯỞNG NEO VÀO PHIẾU CỌC
--
-- `trigger_ie_commission_guard` (BEFORE INSERT OR UPDATE) cấm mọi phiếu CHI
-- mang `commission_kind` mà `contract_id IS NULL`. Luật đó đúng và phải giữ:
-- nó chặn việc mượn hạng mục "Hoa hồng/Thưởng Sale" để chi cho người ngoài.
--
-- Nhưng phiếu thưởng sinh từ PHIẾU CỌC thì lúc đó chưa có hợp đồng — nó KHÔNG
-- trôi nổi, nó neo vào phiếu cọc. Vì vậy mở đúng một cửa, theo khuôn `LINK_CONTRACT`
-- mà repo đã lập ở `20260731130000`: chỉ writer SECURITY DEFINER mới mở được
-- scope, và cửa đóng ngay sau lệnh INSERT.
--
-- KHÔNG nới trigger theo kiểu "cho phép contract_id NULL nếu commission_kind =
-- 'sale'" — như thế là mở toang đúng cái lỗ mà trigger sinh ra để bịt.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE app_private.ie_flex_writer_xids
  DROP CONSTRAINT IF EXISTS ie_flex_writer_xids_scope_chk;
ALTER TABLE app_private.ie_flex_writer_xids
  ADD CONSTRAINT ie_flex_writer_xids_scope_chk
  CHECK (scope = ANY (ARRAY['ANNOTATE','FLEX_EDIT','LINK_CONTRACT','SALE_BONUS_DEPOSIT']));

DO $patch_guard$
DECLARE
  v_def text; v_new text;
  v_mark text := 'SALE_BONUS_DEPOSIT_ANCHOR';
  v_anchor text := '  IF NOT v_new_violates THEN RETURN NEW; END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_ie_commission_guard';

  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy trg_ie_commission_guard. DỪNG.'; END IF;
  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'trg_ie_commission_guard đã có cửa phiếu cọc — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'trg_ie_commission_guard: mất neo — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor,
    v_anchor || chr(10) ||
    chr(10) ||
    '  -- ' || v_mark || ': phiếu thưởng Sale neo vào PHIẾU CỌC (hợp đồng chưa' || chr(10) ||
    '  -- tồn tại lúc thưởng). Không trôi nổi — quan hệ nằm ở app_private.sale_bonus_claims.' || chr(10) ||
    '  -- Cửa chỉ mở trong đúng transaction + đúng backend của writer definer, và' || chr(10) ||
    '  -- writer đóng lại ngay sau lệnh INSERT.' || chr(10) ||
    '  IF EXISTS (' || chr(10) ||
    '    SELECT 1 FROM app_private.ie_flex_writer_xids w' || chr(10) ||
    '     WHERE w.income_expense_id = NEW.id' || chr(10) ||
    '       AND w.transaction_id = pg_current_xact_id()' || chr(10) ||
    '       AND w.backend_pid = pg_backend_pid()' || chr(10) ||
    '       AND w.scope = ''SALE_BONUS_DEPOSIT''' || chr(10) ||
    '  ) THEN' || chr(10) ||
    '    RETURN NEW;' || chr(10) ||
    '  END IF;');

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ trg_ie_commission_guard (cửa hẹp cho phiếu thưởng neo phiếu cọc)';
END
$patch_guard$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. SỔ NỐI phiếu thưởng ↔ phiếu cọc / hợp đồng
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.sale_bonus_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Một trong hai phải có. Tạo từ phiếu cọc ⇒ deposit; tạo kèm hợp đồng ⇒ contract.
  deposit_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE SET NULL,
  contract_id        uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  bonus_voucher_id   uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE,
  amount             numeric(15,2) NOT NULL CHECK (amount > 0),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sbc_has_anchor CHECK (deposit_voucher_id IS NOT NULL OR contract_id IS NOT NULL)
);

-- Một phiếu cọc chỉ thưởng MỘT lần.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sbc_deposit
  ON app_private.sale_bonus_claims (deposit_voucher_id)
  WHERE deposit_voucher_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sbc_contract
  ON app_private.sale_bonus_claims (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sbc_bonus
  ON app_private.sale_bonus_claims (bonus_voucher_id);

REVOKE ALL ON app_private.sale_bonus_claims FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.sale_bonus_claims IS
  'Nối phiếu thưởng Sale với PHIẾU CỌC (khi thưởng lúc chưa có hợp đồng) hoặc với '
  'hợp đồng. Tồn tại vì khoá chống trùng cũ khoá theo contract_id, mà phiếu thưởng '
  'sinh từ phiếu cọc thì contract_id NULL ⇒ vô hình với khoá đó.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. TRẦN THƯỞNG — có phiên bản theo tháng, ra đời RỖNG
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.sale_bonus_cap_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- NULL = áp cho MỌI toà. Có giá trị = trần riêng của toà đó (thắng trần chung).
  building_id          uuid REFERENCES public.buildings(id) ON DELETE CASCADE,
  effective_from_month date NOT NULL,
  cap_amount           numeric(15,2) NOT NULL CHECK (cap_amount > 0),
  status               text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  CONSTRAINT sbcv_month_first_day CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
  CONSTRAINT sbcv_retire_shape CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sbcv_slot
  ON app_private.sale_bonus_cap_versions
     (organization_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from_month)
  WHERE status = 'PUBLISHED';

REVOKE ALL ON app_private.sale_bonus_cap_versions FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.sale_bonus_cap_versions IS
  'Trần thưởng nóng Sale. RỖNG lúc tạo ⇒ không trần, đúng hành vi hôm nay. '
  'building_id NULL = trần chung cho cả tổ chức; có giá trị = trần riêng của toà, thắng trần chung.';

CREATE OR REPLACE FUNCTION app_private.sale_bonus_cap_for_v1(
  p_org uuid, p_building uuid, p_month date
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT v.cap_amount
    FROM app_private.sale_bonus_cap_versions v
   WHERE v.organization_id = p_org
     AND v.status = 'PUBLISHED'
     AND v.effective_from_month <= date_trunc('month', p_month)::date
     AND (v.building_id = p_building OR v.building_id IS NULL)
   -- Trần riêng của toà thắng trần chung; cùng mức thì lấy bản mới nhất.
   ORDER BY (v.building_id IS NOT NULL) DESC, v.effective_from_month DESC
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION app_private.sale_bonus_cap_for_v1(uuid,uuid,date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3. "HỢP ĐỒNG NÀY THƯỞNG SALE CHƯA?" — trả lời qua CẢ HAI đường
--
-- Đây là hàm mà giao diện dùng để quyết định tô xám ô nhập thưởng.
-- ─────────────────────────────────────────────────────────────────────
-- Định dạng tiền kiểu Việt: to_char theo lc_numeric máy chủ ra dấu phẩy ngăn
-- nghìn, người Việt đọc dấu phẩy là dấu thập phân ⇒ phải đổi sang dấu chấm.
CREATE OR REPLACE FUNCTION public.sale_bonus_status_v1(p_contract_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_org uuid; v_bld uuid; v_row record; v_cap numeric; v_money text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT c.organization_id, r.building_id INTO v_org, v_bld
    FROM public.contracts c
    LEFT JOIN public.rooms r ON r.id = c.room_id
   WHERE c.id = p_contract_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem hợp đồng của toà này' USING ERRCODE = '42501';
  END IF;

  v_cap := app_private.sale_bonus_cap_for_v1(v_org, v_bld, public.org_today_v1(v_org));

  SELECT ie.id, ie.code, ie.total_amount, ie.voucher_date, ie.approval_status,
         ie.created_at, 'CONTRACT'::text AS via
    INTO v_row
    FROM public.income_expenses ie
   WHERE ie.contract_id = p_contract_id AND ie.commission_kind = 'sale'
     AND ie.deleted_at IS NULL AND ie.approval_status <> 'CANCELLED'
     AND NOT COALESCE(ie.commission_legacy_dup, false)
   ORDER BY ie.created_at LIMIT 1;

  IF v_row.id IS NULL THEN
    SELECT bon.id, bon.code, bon.total_amount, bon.voucher_date, bon.approval_status,
           bon.created_at, 'DEPOSIT'::text AS via
      INTO v_row
      FROM app_private.sale_bonus_claims sbc
      JOIN public.income_expenses dep ON dep.id = sbc.deposit_voucher_id
      JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
     WHERE dep.contract_id = p_contract_id
       AND bon.deleted_at IS NULL AND bon.approval_status <> 'CANCELLED'
     ORDER BY bon.created_at LIMIT 1;
  END IF;

  v_money := CASE WHEN v_row.id IS NULL THEN NULL
    ELSE replace(to_char(round(v_row.total_amount), 'FM999G999G999G999'), ',', '.') END;

  RETURN jsonb_build_object(
    'contractId',  p_contract_id,
    'alreadyPaid', (v_row.id IS NOT NULL),
    'voucherId',   v_row.id,
    'code',        v_row.code,
    'amount',      v_row.total_amount,
    'voucherDate', v_row.voucher_date,
    'createdAt',   v_row.created_at,
    'status',      v_row.approval_status,
    'via',         v_row.via,
    'capAmount',   v_cap,
    'note', CASE
      WHEN v_row.id IS NULL THEN 'Hợp đồng này chưa được thưởng Sale.'
      ELSE 'Đã thưởng ' || v_money || 'đ ngày ' || to_char(v_row.voucher_date, 'DD/MM/YYYY')
           || ' (phiếu ' || COALESCE(v_row.code, '—') || ')'
           || CASE WHEN v_row.via = 'DEPOSIT' THEN ' — thưởng từ phiếu cọc.' ELSE '.' END
    END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.sale_bonus_status_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_bonus_status_v1(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.sale_bonus_status_v1(uuid) IS
  'Hợp đồng này đã được thưởng Sale chưa, bao nhiêu, khi nào. Kiểm CẢ HAI đường: '
  'phiếu thưởng gắn thẳng hợp đồng, và phiếu thưởng gắn phiếu cọc mà phiếu cọc đó '
  'nay đã thuộc hợp đồng. Giao diện dùng để tô xám ô nhập thưởng.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. TẠO PHIẾU THƯỞNG TỪ PHIẾU CỌC
--
-- Phiếu ra CHỜ DUYỆT, giống hệt đường thưởng kèm hợp đồng hôm nay
-- (`create_commission_voucher` luôn tạo `UNAPPROVED` — quyết định của chủ 23/07).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(
  p_deposit_voucher_id uuid,
  p_amount             numeric,
  p_recipient          text DEFAULT NULL,
  p_account_number     text DEFAULT NULL,
  p_bank               text DEFAULT NULL,
  p_voucher_date       date DEFAULT NULL
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
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền thưởng phải lớn hơn 0' USING ERRCODE = '22023';
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
     voucher_date, total_amount, approval_status, commission_kind, system_source, notes)
  VALUES
    (v_ie, v_actor, v_org, 'EXPENSE',
     'Thưởng nóng Sale' || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), ''),
     v_bld, v_room,
     -- Cố ý GIỮ NGUYÊN contract_id của phiếu cọc (thường là NULL lúc này).
     -- Không tự bịa hợp đồng: quan hệ nằm ở sổ claim bên dưới.
     v_dep.contract_id,
     COALESCE(p_voucher_date, public.org_today_v1(v_org)),
     p_amount, 'UNAPPROVED', 'sale', 'contract.commission',
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

REVOKE ALL ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date) IS
  'Tạo phiếu thưởng nóng Sale từ PHIẾU CỌC, lúc chưa có hợp đồng. Phiếu ra CHỜ DUYỆT. '
  'Chặn chi trùng hai hướng: phiếu cọc đã thưởng, và hợp đồng của phiếu cọc đã thưởng.';

-- ─────────────────────────────────────────────────────────────────────
-- 5. VÁ create_commission_voucher — nhánh 'sale' phải THẤY phiếu thưởng
--    sinh từ phiếu cọc, không thì mở luồng mới là mở toang khoá cũ
-- ─────────────────────────────────────────────────────────────────────
DO $patch_ccv$
DECLARE
  v_def text; v_new text;
  v_mark text := 'SALE_BONUS_SEES_DEPOSIT_CLAIM';
  v_anchor text :=
    '  v_type_name := CASE p_kind';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';

  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy create_commission_voucher. DỪNG.'; END IF;
  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'create_commission_voucher đã thấy claim phiếu cọc — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher: mất neo — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor,
    '  -- ' || v_mark || ': phiếu thưởng Sale có thể đã sinh từ PHIẾU CỌC lúc' || chr(10) ||
    '  -- hợp đồng chưa tồn tại. Phiếu đó contract_id NULL nên VÔ HÌNH với cả' || chr(10) ||
    '  -- advisory lock, pre-check P0001 lẫn unique index ở trên. Không có chốt' || chr(10) ||
    '  -- này thì mở luồng "thưởng từ phiếu cọc" là mở toang khoá chống chi trùng.' || chr(10) ||
    '  IF p_kind = ''sale'' THEN' || chr(10) ||
    '    DECLARE v_prev uuid; v_prev_code text;' || chr(10) ||
    '    BEGIN' || chr(10) ||
    '      SELECT bon.id, bon.code INTO v_prev, v_prev_code' || chr(10) ||
    '        FROM app_private.sale_bonus_claims sbc' || chr(10) ||
    '        JOIN public.income_expenses dep ON dep.id = sbc.deposit_voucher_id' || chr(10) ||
    '        JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id' || chr(10) ||
    '       WHERE dep.contract_id = p_contract_id' || chr(10) ||
    '         AND bon.deleted_at IS NULL' || chr(10) ||
    '         AND bon.approval_status <> ''CANCELLED''' || chr(10) ||
    '       LIMIT 1;' || chr(10) ||
    '      IF v_prev IS NOT NULL THEN' || chr(10) ||
    '        RAISE EXCEPTION ''Hợp đồng này đã được thưởng Sale từ phiếu cọc rồi (phiếu %)'',' || chr(10) ||
    '          COALESCE(v_prev_code, v_prev::text) USING ERRCODE = ''P0001'';' || chr(10) ||
    '      END IF;' || chr(10) ||
    '    END;' || chr(10) ||
    '  END IF;' || chr(10) ||
    chr(10) ||
    v_anchor);

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ create_commission_voucher (nhánh sale thấy claim phiếu cọc)';
END
$patch_ccv$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. CHỦ CÔNG BỐ TRẦN THƯỞNG
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_sale_bonus_cap_v1(
  p_cap_amount           numeric,
  p_building_id          uuid DEFAULT NULL,     -- NULL = trần chung cả tổ chức
  p_effective_from_month text DEFAULT NULL,     -- 'YYYY-MM'; NULL = tháng này
  p_organization_id      uuid DEFAULT NULL,
  p_note                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_month date;
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_cap_amount IS NULL OR p_cap_amount <= 0 THEN
    RAISE EXCEPTION 'Trần thưởng phải lớn hơn 0' USING ERRCODE = '22023';
  END IF;

  IF p_building_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org FROM public.buildings b
     WHERE b.id = p_building_id AND b.deleted_at IS NULL;
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE = 'P0002'; END IF;
  ELSE
    v_org := p_organization_id;
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.status = 'ACTIVE' LIMIT 1;
    END IF;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'Không xác định được tổ chức' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION
      'Chỉ chủ tổ chức mới đặt được trần thưởng Sale — con số này chặn tiền ra két.'
      USING ERRCODE = '42501';
  END IF;

  IF p_effective_from_month IS NULL THEN
    v_month := date_trunc('month', public.org_today_v1(v_org))::date;
  ELSE
    IF p_effective_from_month !~ '^\d{4}-\d{2}$' THEN
      RAISE EXCEPTION 'Tháng hiệu lực phải dạng YYYY-MM' USING ERRCODE = '22023';
    END IF;
    v_month := to_date(p_effective_from_month || '-01', 'YYYY-MM-DD');
  END IF;

  UPDATE app_private.sale_bonus_cap_versions
     SET status = 'RETIRED', retired_at = now()
   WHERE organization_id = v_org
     AND COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(p_building_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND effective_from_month = v_month
     AND status = 'PUBLISHED';

  INSERT INTO app_private.sale_bonus_cap_versions
    (organization_id, building_id, effective_from_month, cap_amount, note, created_by)
  VALUES (v_org, p_building_id, v_month, round(p_cap_amount, 2),
          NULLIF(btrim(COALESCE(p_note,'')), ''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'capAmount', round(p_cap_amount, 2),
    'buildingId', p_building_id,
    'effectiveFrom', to_char(v_month, 'YYYY-MM'),
    'note', CASE WHEN p_building_id IS NULL
      THEN 'Trần chung cho cả tổ chức, áp dụng từ tháng ' || to_char(v_month, 'MM/YYYY') || '.'
      ELSE 'Trần riêng của toà này, áp dụng từ tháng ' || to_char(v_month, 'MM/YYYY') || '. Trần riêng thắng trần chung.'
    END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_src text;
BEGIN
  IF to_regclass('app_private.sale_bonus_claims') IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ claim. DỪNG.';
  END IF;
  IF to_regclass('app_private.sale_bonus_cap_versions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng trần. DỪNG.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';
  IF position('SALE_BONUS_SEES_DEPOSIT_CLAIM' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher KHÔNG thấy claim phiếu cọc — mở luồng mới là mở toang khoá. DỪNG.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_sale_bonus_from_deposit_v1';
  IF position('sale_bonus_claims' IN v_src) = 0 OR position('sale_bonus_cap_for_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Hàm tạo thưởng thiếu sổ claim hoặc chốt trần. DỪNG.';
  END IF;
  IF position('''UNAPPROVED''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Phiếu thưởng phải ra CHỜ DUYỆT. DỪNG.';
  END IF;

  -- Bảng trần phải RỖNG lúc ra đời: có dòng nào tức là ai đó gieo số bịa.
  IF (SELECT count(*) FROM app_private.sale_bonus_cap_versions) > 0 THEN
    RAISE NOTICE 'Bảng trần đã có % dòng (chủ đã công bố).',
      (SELECT count(*) FROM app_private.sale_bonus_cap_versions);
  END IF;
END
$verify$;

COMMIT;
