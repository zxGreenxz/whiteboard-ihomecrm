-- =====================================================================
-- HOA HỒNG MÔI GIỚI — bậc có phiên bản + tự duyệt khi đủ điều kiện
--
-- Quyết định của chủ 31/07/2026: "cho tự duyệt khi đủ điều kiện" (hợp đồng còn
-- hiệu lực, thu đủ cọc, qua start_date + 7 ngày, đúng bậc). Quyết định này THAY
-- quyết định ngày 23/07 vốn bắt duyệt tay mọi phiếu hoa hồng tại /thu-chi.
--
-- ─────────────────────────────────────────────────────────────────────
-- VÌ SAO KHÔNG SUY BẬC TỪ DỮ LIỆU — và vì sao bảng này ra đời RỖNG
--
-- Một đợt kiểm toán 31/07 đã thử suy bậc từ 41 phiếu hoa hồng đã chi. Kết quả:
-- phương pháp bị VÒNG TRÒN. `create_commission_voucher` nhận `p_amount` do client
-- truyền, mà client điền sẵn bằng chính bậc đang cấu hình ⇒ **34/41 phiếu có số
-- tiền bằng đúng số máy tự tính**. Chúng chứng minh "không ai phản đối", không
-- chứng minh "tỉ lệ đó đúng". Còn 8 phiếu do người GÕ TAY — tức 8 quan sát duy
-- nhất mang thông tin thật — thì 7/8 KHÔNG khớp bậc nào (40%, 55,56%, 56,43%,
-- 58,68%, 66,98%…).
--
-- ⇒ Bậc hoa hồng là QUYẾT ĐỊNH KINH DOANH của chủ, không phải bài toán số liệu.
--   Bảng dưới đây rỗng lúc tạo ⇒ **không phiếu nào tự duyệt**, hành vi y như hôm
--   nay. Tự duyệt chỉ bật cho đúng những toà × khoảng tháng chủ đã công bố.
--
-- Rủi ro đã đo, ghi lại để chủ thấy khi công bố: **89 hợp đồng đang sống dài hơn
-- 14 tháng CHƯA từng được chi một đồng hoa hồng nào**, nhưng màn hình vẫn điền
-- sẵn tỉ lệ bậc cao nhất cho từng cái. Nếu ai đó bấm chi hết, đó là 202.770.000đ
-- ra két mà chưa có chính sách nào được duyệt. Công bố bậc là cách đóng lỗ đó.
--
-- ─────────────────────────────────────────────────────────────────────
-- BẢNG BẬC CŨ `buildings.commission_tiers` (jsonb) — KHÔNG ĐỤNG
--
-- Cột đó vẫn nuôi màn hình điền sẵn và `get_period_commissions`. Đây là nguồn
-- THỨ HAI, chỉ dùng để quyết "có được tự duyệt không". Không hợp nhất hai nguồn
-- trong đợt này: hợp nhất là đổi số đang hiển thị của 22 hợp đồng ở mốc 7-9 tháng
-- (từ 50% × tiền thuê xuống 0), tức đổi tiền, phải chủ quyết riêng.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.special_fee_approve_and_post_v1(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu adapter ghi sổ. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu resolve_signed_contract_deposit_basis_v1 — không kiểm được "đã thu đủ cọc". DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. BẬC HOA HỒNG CÓ PHIÊN BẢN
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.commission_tier_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- NULL = áp cho MỌI toà. Có giá trị = bậc riêng của toà, thắng bậc chung.
  building_id          uuid REFERENCES public.buildings(id) ON DELETE CASCADE,
  effective_from_month date NOT NULL,
  min_months           int NOT NULL CHECK (min_months >= 0),
  max_months           int NOT NULL CHECK (max_months >= 0),
  rate_percent         numeric(6,3) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 200),
  status               text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  CONSTRAINT ctv_range CHECK (max_months >= min_months),
  CONSTRAINT ctv_month_first_day CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
  CONSTRAINT ctv_retire_shape CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ctv_slot
  ON app_private.commission_tier_versions
     (organization_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
      effective_from_month, min_months, max_months)
  WHERE status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_ctv_lookup
  ON app_private.commission_tier_versions
     (organization_id, building_id, effective_from_month DESC)
  WHERE status = 'PUBLISHED';

REVOKE ALL ON app_private.commission_tier_versions
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.commission_tier_versions IS
  'Bậc hoa hồng môi giới do CHỦ công bố, có tháng hiệu lực. Quyết định phiếu nào '
  'được TỰ DUYỆT. Rỗng lúc tạo ⇒ không phiếu nào tự duyệt, hành vi như cũ. Cố ý '
  'KHÔNG hợp nhất với buildings.commission_tiers (cột đó nuôi màn hình điền sẵn).';

-- ─────────────────────────────────────────────────────────────────────
-- 2. TRA BẬC — bậc riêng của toà thắng bậc chung; khoảng nào không phủ ⇒ NULL
--
-- Cố ý KHÔNG có fallback "lấy bậc gần nhất". Hợp đồng rơi ngoài mọi bậc đã công
-- bố thì KHÔNG tự duyệt — người duyệt tay quyết. Fallback ngầm chính là thứ đang
-- làm hai màn hình trả hai số khác nhau cho cùng 22 hợp đồng.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.commission_rate_for_v1(
  p_org uuid, p_building uuid, p_months int, p_month date
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT v.rate_percent
    FROM app_private.commission_tier_versions v
   WHERE v.organization_id = p_org
     AND v.status = 'PUBLISHED'
     AND v.effective_from_month <= date_trunc('month', p_month)::date
     AND (v.building_id = p_building OR v.building_id IS NULL)
     AND p_months BETWEEN v.min_months AND v.max_months
   ORDER BY (v.building_id IS NOT NULL) DESC, v.effective_from_month DESC
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION app_private.commission_rate_for_v1(uuid,uuid,int,date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3. "PHIẾU HOA HỒNG NÀY CÓ ĐƯỢC TỰ DUYỆT KHÔNG?"
--
-- Bốn điều kiện của chủ, kiểm đủ cả bốn. Thiếu bất kỳ điều nào ⇒ chờ duyệt.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.commission_autopay_check_v1(
  p_contract_id uuid,
  p_amount      numeric
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_c       public.contracts;
  v_org     uuid;
  v_bld     uuid;
  v_months  int;
  v_rate    numeric;
  v_expect  numeric;
  v_basis   jsonb;
  v_today   date;
BEGIN
  SELECT * INTO v_c FROM public.contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('verdict','NOT_ELIGIBLE','reason','Không tìm thấy hợp đồng');
  END IF;
  v_org := v_c.organization_id;
  SELECT r.building_id INTO v_bld FROM public.rooms r WHERE r.id = v_c.room_id;
  v_today := public.org_today_v1(v_org);

  -- (1) Hợp đồng còn hiệu lực.
  -- `contracts.status` là ENUM, không phải text: COALESCE(x,'') sẽ cố ép ''
  -- vào enum và ném 22P02. Ép sang text trước khi so.
  IF COALESCE(v_c.status::text, '') <> 'ACTIVE' THEN
    RETURN jsonb_build_object('verdict','NOT_ELIGIBLE',
      'reason', 'Hợp đồng đang ở trạng thái ' || COALESCE(v_c.status::text,'(rỗng)') || ', chưa đủ điều kiện tự duyệt');
  END IF;

  -- (2) Đã qua ngày bắt đầu + 7 ngày.
  IF v_c.start_date IS NULL OR v_today < (v_c.start_date + 7) THEN
    RETURN jsonb_build_object('verdict','NOT_ELIGIBLE',
      'reason', 'Chưa qua 7 ngày kể từ ngày bắt đầu hợp đồng ('
                || COALESCE(to_char(v_c.start_date,'DD/MM/YYYY'),'chưa có ngày') || ')');
  END IF;

  -- (3) Đã THỰC THU đủ cọc. Dùng nguồn sự thật dùng chung của Đợt 1 —
  --     KHÔNG dùng contracts.deposit_paid (cột đó gộp cả cọc trên SỔ ẢO).
  BEGIN
    v_basis := app_private.resolve_signed_contract_deposit_basis_v1(v_org, p_contract_id, now());
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('verdict','NOT_ELIGIBLE',
      'reason','Không đọc được tình trạng cọc của hợp đồng');
  END;
  IF COALESCE(v_basis->>'status','') <> 'OK' THEN
    RETURN jsonb_build_object('verdict','NOT_ELIGIBLE',
      'reason', 'Cọc chưa vào két đủ (tình trạng: ' || COALESCE(v_basis->>'status','?') || ')',
      'depositBasis', v_basis);
  END IF;

  -- (4) Đúng bậc chủ đã công bố.
  v_months := GREATEST(0, (EXTRACT(YEAR FROM age(v_c.end_date, v_c.start_date)) * 12
                        +  EXTRACT(MONTH FROM age(v_c.end_date, v_c.start_date)))::int);
  v_rate := app_private.commission_rate_for_v1(v_org, v_bld, v_months, v_today);
  IF v_rate IS NULL THEN
    RETURN jsonb_build_object('verdict','NO_TIER',
      'months', v_months,
      'reason', 'Chủ chưa công bố bậc hoa hồng cho hợp đồng ' || v_months || ' tháng ở toà này');
  END IF;

  v_expect := round(COALESCE(v_c.rent_price,0) * v_rate / 100);
  IF round(COALESCE(p_amount,0)) <> v_expect THEN
    RETURN jsonb_build_object('verdict','AMOUNT_MISMATCH',
      'months', v_months, 'ratePercent', v_rate, 'expected', v_expect,
      'reason', 'Bậc đã công bố là ' || v_rate || '% tiền thuê = '
                || replace(to_char(v_expect,'FM999G999G999G999'), ',', '.') || 'đ, số đang chi là '
                || replace(to_char(round(COALESCE(p_amount,0)),'FM999G999G999G999'), ',', '.') || 'đ');
  END IF;

  RETURN jsonb_build_object('verdict','VALID',
    'months', v_months, 'ratePercent', v_rate, 'expected', v_expect);
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.commission_autopay_check_v1(uuid,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.commission_autopay_check_v1(uuid,numeric) IS
  'Bốn điều kiện chủ chốt 31/07: hợp đồng ACTIVE, qua start_date+7, thực thu đủ '
  'cọc (theo resolve_signed_contract_deposit_basis_v1, KHÔNG theo deposit_paid), '
  'và số tiền khớp bậc đã công bố. Thiếu một điều ⇒ phiếu chờ duyệt như cũ.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. MỞ ADAPTER CHO PHIẾU HOA HỒNG
--
-- Adapter chỉ nhận ba nguồn phí cố định. Thêm 'contract.commission' vào danh
-- sách — nhưng KHÔNG nới sang mọi loại: phiếu hoàn cọc vẫn phải chờ duyệt
-- (quyết định số 6 của chủ), phiếu THU vẫn bị từ chối.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_adapter$
DECLARE
  v_def text; v_new text;
  v_anchor text :=
    '  IF COALESCE(v_ie.system_source, '''') NOT IN (''special_fee.v1'', ''fixed_fee'', ''utility.bill'') THEN';
  v_after text :=
    '  IF COALESCE(v_ie.system_source, '''') NOT IN (''special_fee.v1'', ''fixed_fee'', ''utility.bill'', ''contract.commission'') THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'special_fee_approve_and_post_v1';

  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy adapter. DỪNG.'; END IF;
  IF position('contract.commission' IN v_def) > 0 THEN
    RAISE NOTICE 'Adapter đã nhận phiếu hoa hồng — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Adapter: mất neo danh sách nguồn — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor, v_after);
  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ MỞ adapter cho phiếu hoa hồng';
END
$patch_adapter$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. NỐI VÀO create_commission_voucher — nhánh 'broker' tự duyệt khi VALID
--
-- Vá theo neo, ngay trước câu RETURN. Phiếu vẫn được TẠO ở CHỜ DUYỆT như cũ;
-- adapter mới lật sang đã duyệt + ghi sổ. Thứ tự đó là bắt buộc: tạo thẳng ở
-- APPROVED thì cầu a85b đúc bút toán LEGACY_BRIDGE ngay trong lệnh INSERT và
-- adapter mất chỗ chen vào.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_ccv2$
DECLARE
  v_def text; v_new text; v_anchor text;
  v_mark text := 'COMMISSION_AUTOPAY_V1';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';

  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy create_commission_voucher. DỪNG.'; END IF;
  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'create_commission_voucher đã có tự duyệt — bỏ qua';
    RETURN;
  END IF;

  -- Neo: câu RETURN cuối hàm. Tìm mẫu ổn định nhất còn lại.
  v_anchor := '  RETURN jsonb_build_object(';
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher: mất neo RETURN — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor,
    '  -- ' || v_mark || ': hoa hồng môi giới đủ bốn điều kiện chủ chốt 31/07 thì' || chr(10) ||
    '  -- máy duyệt hộ và ghi sổ luôn. Thiếu một điều ⇒ để nguyên chờ duyệt (hành' || chr(10) ||
    '  -- vi cũ). Bảng bậc rỗng ⇒ luôn rơi vào NO_TIER ⇒ không phiếu nào tự duyệt.' || chr(10) ||
    '  IF p_kind = ''broker'' AND v_voucher_id IS NOT NULL THEN' || chr(10) ||
    '    DECLARE v_chk jsonb; v_acc_ok boolean;' || chr(10) ||
    '    BEGIN' || chr(10) ||
    '      v_chk := app_private.commission_autopay_check_v1(p_contract_id, p_amount);' || chr(10) ||
    '      SELECT (a.id IS NOT NULL AND NOT COALESCE(a.is_virtual,false)) INTO v_acc_ok' || chr(10) ||
    '        FROM public.accounts a' || chr(10) ||
    '       WHERE a.id = (SELECT account_id FROM public.income_expenses WHERE id = v_voucher_id);' || chr(10) ||
    '      IF (v_chk->>''verdict'') = ''VALID'' AND COALESCE(v_acc_ok,false) THEN' || chr(10) ||
    '        PERFORM app_private.special_fee_approve_and_post_v1(v_voucher_id, ''BROKER_COMMISSION'');' || chr(10) ||
    '      END IF;' || chr(10) ||
    '    END;' || chr(10) ||
    '  END IF;' || chr(10) ||
    chr(10) ||
    v_anchor);

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ create_commission_voucher (tự duyệt hoa hồng khi đủ điều kiện)';
END
$patch_ccv2$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. CHỦ CÔNG BỐ BẬC + ĐỌC BẬC
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_commission_tier_v1(
  p_min_months           int,
  p_max_months           int,
  p_rate_percent         numeric,
  p_building_id          uuid DEFAULT NULL,
  p_effective_from_month text DEFAULT NULL,
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
  v_org uuid; v_month date; v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_min_months IS NULL OR p_max_months IS NULL OR p_max_months < p_min_months THEN
    RAISE EXCEPTION 'Khoảng tháng không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF p_rate_percent IS NULL OR p_rate_percent < 0 OR p_rate_percent > 200 THEN
    RAISE EXCEPTION 'Tỉ lệ hoa hồng phải trong khoảng 0-200%%' USING ERRCODE='22023';
  END IF;

  IF p_building_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org FROM public.buildings b
     WHERE b.id = p_building_id AND b.deleted_at IS NULL;
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='P0002'; END IF;
  ELSE
    v_org := p_organization_id;
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.status = 'ACTIVE' LIMIT 1;
    END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không xác định được tổ chức' USING ERRCODE='22023'; END IF;
  END IF;

  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION
      'Chỉ chủ tổ chức mới công bố được bậc hoa hồng — bậc này quyết định phiếu nào tự chi.'
      USING ERRCODE='42501';
  END IF;

  IF p_effective_from_month IS NULL THEN
    v_month := date_trunc('month', public.org_today_v1(v_org))::date;
  ELSE
    IF p_effective_from_month !~ '^\d{4}-\d{2}$' THEN
      RAISE EXCEPTION 'Tháng hiệu lực phải dạng YYYY-MM' USING ERRCODE='22023';
    END IF;
    v_month := to_date(p_effective_from_month || '-01','YYYY-MM-DD');
  END IF;

  UPDATE app_private.commission_tier_versions
     SET status='RETIRED', retired_at=now()
   WHERE organization_id = v_org
     AND COALESCE(building_id,'00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(p_building_id,'00000000-0000-0000-0000-000000000000'::uuid)
     AND effective_from_month = v_month
     AND min_months = p_min_months AND max_months = p_max_months
     AND status='PUBLISHED';

  INSERT INTO app_private.commission_tier_versions
    (organization_id, building_id, effective_from_month, min_months, max_months,
     rate_percent, note, created_by)
  VALUES (v_org, p_building_id, v_month, p_min_months, p_max_months,
          p_rate_percent, NULLIF(btrim(COALESCE(p_note,'')),''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id,
    'minMonths', p_min_months, 'maxMonths', p_max_months, 'ratePercent', p_rate_percent,
    'buildingId', p_building_id, 'effectiveFrom', to_char(v_month,'YYYY-MM'),
    'note', 'Hợp đồng ' || p_min_months || '-' || p_max_months || ' tháng: '
            || p_rate_percent || '% tiền thuê, áp dụng từ tháng ' || to_char(v_month,'MM/YYYY')
            || '. Phiếu đúng mức này sẽ tự duyệt khi hợp đồng còn hiệu lực, đã thu đủ cọc và qua 7 ngày.');
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_commission_tier_v1(int,int,numeric,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_commission_tier_v1(int,int,numeric,uuid,text,uuid,text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_commission_tiers_v1(p_building_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, building_id uuid, building_name text,
  min_months int, max_months int, rate_percent numeric,
  effective_from text, note text, can_edit boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT v.id, v.building_id, b.name,
         v.min_months, v.max_months, v.rate_percent,
         to_char(v.effective_from_month,'YYYY-MM'), v.note,
         (public.is_super_admin() OR app_private.is_org_owner_v1(v.organization_id, v_actor))
    FROM app_private.commission_tier_versions v
    LEFT JOIN public.buildings b ON b.id = v.building_id
   WHERE v.status = 'PUBLISHED'
     AND (p_building_id IS NULL OR v.building_id = p_building_id OR v.building_id IS NULL)
     AND (v.building_id IS NULL
          OR public.can_access_building(v.building_id)
          OR public.ie_all_buildings_scope(v.building_id)
          OR public.is_admin() OR public.is_super_admin())
   ORDER BY b.name NULLS FIRST, v.min_months;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_commission_tiers_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_commission_tiers_v1(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_src text; v_n int;
BEGIN
  IF to_regclass('app_private.commission_tier_versions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng bậc. DỪNG.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='special_fee_approve_and_post_v1';
  IF position('contract.commission' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter chưa nhận phiếu hoa hồng. DỪNG.';
  END IF;
  -- Nới danh sách nguồn KHÔNG được làm mất chốt phiếu hoàn cọc.
  IF position('termination' IN v_src) > 0 THEN
    RAISE EXCEPTION 'Adapter nay nhận cả nguồn termination — trái quyết định số 6 của chủ. DỪNG.';
  END IF;
  IF position('''EXPENSE''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter mất chốt chỉ-nhận-phiếu-CHI. DỪNG.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_commission_voucher';
  IF position('COMMISSION_AUTOPAY_V1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_commission_voucher chưa có nhánh tự duyệt. DỪNG.';
  END IF;
  -- Chốt phiếu cọc của đợt trước phải còn nguyên.
  IF position('SALE_BONUS_SEES_DEPOSIT_CLAIM' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Bản vá làm mất chốt claim phiếu cọc. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM app_private.commission_tier_versions;
  IF v_n > 0 THEN
    RAISE NOTICE 'Bảng bậc đã có % dòng (chủ đã công bố).', v_n;
  END IF;
END
$verify$;

COMMIT;
