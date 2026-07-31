-- =====================================================================
-- ĐIỆN/NƯỚC: TRẦN CHI · BẢO TRÌ: CHUẨN, TRẦN VÀ GIÃN CÁCH
--
-- Hai họ chi cuối cùng của kế hoạch 31/07. Gộp một file vì chúng dùng CHUNG
-- một khuôn đã chứng minh an toàn ở bảng giá phí cố định:
--   bảng cấu hình ra đời RỖNG ⇒ hành vi hệ thống không đổi một ly;
--   luật chỉ bật cho đúng ô chủ đã công bố.
--
-- ─────────────────────────────────────────────────────────────────────
-- ĐIỆN/NƯỚC — vì sao là TRẦN chứ không phải GIÁ ĐÚNG
--
-- Phí cố định so BẰNG TUYỆT ĐỐI với giá công bố. Điện nước KHÔNG so được như
-- vậy: nó là chi phí theo đồng hồ, đo trên prod thì lệch 9%–59% giữa các tháng.
-- Vì vậy luật ở đây là TRẦN: dưới trần thì bình thường, vượt trần thì phiếu nằm
-- CHỜ DUYỆT kèm lý do. Không có "đúng giá thì tự duyệt" cho họ này.
--
-- Chốt chống trùng theo (công tơ, loại, tháng) đã có từ Đợt −1 — file này KHÔNG
-- đụng vào, chỉ thêm tầng trần.
--
-- ─────────────────────────────────────────────────────────────────────
-- BẢO TRÌ — hai luật, và một hệ quả chủ PHẢI biết trước khi bật
--
-- Luật chủ muốn: máy lạnh tối đa 1 lần / 5 tháng / MỖI PHÒNG; máy giặt 1 lần /
-- 6 tháng / MỖI TOÀ. Kèm giá chuẩn và trần.
--
-- ⚠ HỆ QUẢ ĐO ĐƯỢC, KHÔNG ĐƯỢC GIẤU: bật luật 5 tháng mà TÍNH CẢ LỊCH SỬ sẽ
--   khoá **59/59 phòng đã từng vệ sinh máy lạnh** (69/69 nếu áp cho cả họ bảo
--   trì) trên tổng 275 phòng — phòng mở sớm nhất 15/10/2026, muộn nhất 28/12/2026.
--   Suốt 2,5–5 tháng tới không phòng nào đã làm được phép làm lại.
--
-- ⇒ Vì vậy luật ở đây có cột `counts_history`, MẶC ĐỊNH `false`: chỉ tính từ
--   ngày công bố trở đi. Chủ muốn tính cả lịch sử thì bật tường minh, sau khi
--   đã đọc con số trên. Không tự quyết hộ.
--
-- ⚠ Hai giới hạn dữ liệu, ghi để không ai tưởng luật này đã được kiểm chứng:
--   • Toàn bộ lịch sử bảo trì máy lạnh chỉ trải 74 ngày (15/05→28/07/2026),
--     CHƯA TỪNG tồn tại cặp bảo trì nào cách nhau quá 5 tháng. "5 tháng" là ý
--     chủ, không phải kết luận rút từ số liệu.
--   • Hệ thống KHÔNG biết mỗi phòng có mấy máy lạnh (mọi phiếu ghi số lượng =1).
--     Phòng 2 máy sẽ bị chặn oan lần vệ sinh máy thứ hai. Đây là lý do luật chỉ
--     CẢNH BÁO cho người duyệt, không chặn cứng — xem `enforcement`.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1. DỪNG.';
  END IF;
END
$preflight$;

-- ═════════════════════════════════════════════════════════════════════
-- PHẦN A — TRẦN ĐIỆN/NƯỚC
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_private.utility_ceiling_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id          uuid REFERENCES public.buildings(id) ON DELETE CASCADE,
  utility_type         text NOT NULL CHECK (utility_type IN ('ELECTRIC','WATER')),
  effective_from_month date NOT NULL,
  -- Trần tuyệt đối cho MỘT phiếu của toà × loại × tháng.
  ceiling_amount       numeric(15,2) CHECK (ceiling_amount IS NULL OR ceiling_amount > 0),
  -- Trần theo TỈ LỆ so với tiền đã thu của khách cùng toà × loại × tháng.
  -- vd 1.20 = chi cho nhà cung cấp không quá 120% số đã thu của khách.
  max_ratio_to_billed  numeric(6,3) CHECK (max_ratio_to_billed IS NULL OR max_ratio_to_billed > 0),
  status               text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  CONSTRAINT ucv_has_rule CHECK (ceiling_amount IS NOT NULL OR max_ratio_to_billed IS NOT NULL),
  CONSTRAINT ucv_month_first_day CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
  CONSTRAINT ucv_retire_shape CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ucv_slot
  ON app_private.utility_ceiling_versions
     (organization_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
      utility_type, effective_from_month)
  WHERE status = 'PUBLISHED';

REVOKE ALL ON app_private.utility_ceiling_versions
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.utility_ceiling_versions IS
  'Trần chi điện/nước. RỖNG lúc tạo ⇒ không trần, hành vi như hôm nay. Điện nước '
  'là chi phí theo đồng hồ (đo prod: lệch 9-59% giữa các tháng) nên KHÔNG so bằng '
  'tuyệt đối như phí cố định — chỉ có trần.';

CREATE OR REPLACE FUNCTION app_private.utility_ceiling_check_v1(
  p_org      uuid,
  p_building uuid,
  p_type     text,
  p_month    date,
  p_amount   numeric,
  p_billed_to_tenants numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_r record; v_lim numeric;
BEGIN
  SELECT * INTO v_r FROM app_private.utility_ceiling_versions v
   WHERE v.organization_id = p_org AND v.status = 'PUBLISHED'
     AND v.utility_type = p_type
     AND v.effective_from_month <= date_trunc('month', p_month)::date
     AND (v.building_id = p_building OR v.building_id IS NULL)
   ORDER BY (v.building_id IS NOT NULL) DESC, v.effective_from_month DESC
   LIMIT 1;

  IF v_r.id IS NULL THEN
    RETURN jsonb_build_object('verdict','NO_RULE',
      'reason','Chủ chưa công bố trần cho hạng mục này — giữ nguyên hành vi cũ');
  END IF;

  IF v_r.ceiling_amount IS NOT NULL AND round(COALESCE(p_amount,0)) > round(v_r.ceiling_amount) THEN
    RETURN jsonb_build_object('verdict','OVER_CEILING',
      'ceiling', v_r.ceiling_amount, 'actual', p_amount,
      'reason','Số chi ' || replace(to_char(round(COALESCE(p_amount,0)),'FM999G999G999G999'),',','.')
               || 'đ vượt trần ' || replace(to_char(round(v_r.ceiling_amount),'FM999G999G999G999'),',','.') || 'đ');
  END IF;

  IF v_r.max_ratio_to_billed IS NOT NULL AND COALESCE(p_billed_to_tenants,0) > 0 THEN
    v_lim := round(p_billed_to_tenants * v_r.max_ratio_to_billed);
    IF round(COALESCE(p_amount,0)) > v_lim THEN
      RETURN jsonb_build_object('verdict','OVER_RATIO',
        'limit', v_lim, 'billed', p_billed_to_tenants, 'ratio', v_r.max_ratio_to_billed,
        'reason','Số chi vượt ' || v_r.max_ratio_to_billed || ' lần tiền đã thu của khách ('
                 || replace(to_char(round(p_billed_to_tenants),'FM999G999G999G999'),',','.') || 'đ)');
    END IF;
  END IF;

  -- Mẫu số 0 mà vẫn chi ⇒ đáng ngờ, nhưng không chặn: có toà chưa kịp chốt số khách.
  IF v_r.max_ratio_to_billed IS NOT NULL AND COALESCE(p_billed_to_tenants,0) = 0
     AND COALESCE(p_amount,0) > 0 THEN
    RETURN jsonb_build_object('verdict','WARN_NO_BILLED',
      'reason','Chưa thu đồng nào của khách cho kỳ này mà đã chi nhà cung cấp — nên rà lại');
  END IF;

  RETURN jsonb_build_object('verdict','WITHIN_LIMIT');
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.utility_ceiling_check_v1(uuid,uuid,text,date,numeric,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_utility_ceiling_v1(
  p_utility_type         text,
  p_ceiling_amount       numeric DEFAULT NULL,
  p_max_ratio_to_billed  numeric DEFAULT NULL,
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
DECLARE v_actor uuid := auth.uid(); v_org uuid; v_month date; v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN
    RAISE EXCEPTION 'Loại chỉ nhận ELECTRIC hoặc WATER' USING ERRCODE='22023';
  END IF;
  IF p_ceiling_amount IS NULL AND p_max_ratio_to_billed IS NULL THEN
    RAISE EXCEPTION 'Phải đặt ít nhất một trong hai: trần tiền, hoặc tỉ lệ so với tiền đã thu'
      USING ERRCODE='22023';
  END IF;

  IF p_building_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org FROM public.buildings b
     WHERE b.id = p_building_id AND b.deleted_at IS NULL;
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='P0002'; END IF;
  ELSE
    v_org := COALESCE(p_organization_id,
      (SELECT m.organization_id FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.status='ACTIVE' LIMIT 1));
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không xác định được tổ chức' USING ERRCODE='22023'; END IF;
  END IF;

  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ tổ chức mới đặt được trần chi' USING ERRCODE='42501';
  END IF;

  v_month := CASE WHEN p_effective_from_month IS NULL
    THEN date_trunc('month', public.org_today_v1(v_org))::date
    ELSE to_date(p_effective_from_month || '-01','YYYY-MM-DD') END;

  UPDATE app_private.utility_ceiling_versions
     SET status='RETIRED', retired_at=now()
   WHERE organization_id=v_org AND utility_type=p_utility_type
     AND COALESCE(building_id,'00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(p_building_id,'00000000-0000-0000-0000-000000000000'::uuid)
     AND effective_from_month=v_month AND status='PUBLISHED';

  INSERT INTO app_private.utility_ceiling_versions
    (organization_id, building_id, utility_type, effective_from_month,
     ceiling_amount, max_ratio_to_billed, note, created_by)
  VALUES (v_org, p_building_id, p_utility_type, v_month,
          p_ceiling_amount, p_max_ratio_to_billed,
          NULLIF(btrim(COALESCE(p_note,'')),''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'utilityType', p_utility_type,
    'ceilingAmount', p_ceiling_amount, 'maxRatio', p_max_ratio_to_billed,
    'effectiveFrom', to_char(v_month,'YYYY-MM'),
    'note','Vượt trần thì phiếu vẫn tạo được nhưng nằm chờ duyệt kèm lý do.');
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)
  TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════
-- PHẦN B — BẢO TRÌ: chuẩn, trần, giãn cách
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_private.maintenance_rule_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id          uuid REFERENCES public.buildings(id) ON DELETE CASCADE,
  -- AIR_CONDITIONER tính theo PHÒNG; WASHING_MACHINE tính theo TOÀ.
  service_kind         text NOT NULL CHECK (service_kind IN ('AIR_CONDITIONER','WASHING_MACHINE')),
  effective_from_month date NOT NULL,
  standard_amount      numeric(15,2) CHECK (standard_amount IS NULL OR standard_amount > 0),
  ceiling_amount       numeric(15,2) CHECK (ceiling_amount IS NULL OR ceiling_amount > 0),
  -- Số tháng tối thiểu giữa hai lần. NULL = không áp luật giãn cách.
  min_months_between   int CHECK (min_months_between IS NULL OR min_months_between > 0),
  -- FALSE (mặc định) = chỉ tính các lần bảo trì TỪ NGÀY CÔNG BỐ trở đi.
  -- Bật TRUE là khoá ngay 59/59 phòng đã từng vệ sinh — xem đầu file.
  counts_history       boolean NOT NULL DEFAULT false,
  -- 'WARN' = báo cho người duyệt, vẫn tạo phiếu. 'BLOCK' = chặn hẳn.
  -- Mặc định WARN vì hệ thống KHÔNG biết mỗi phòng có mấy máy lạnh.
  enforcement          text NOT NULL DEFAULT 'WARN' CHECK (enforcement IN ('WARN','BLOCK')),
  status               text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  CONSTRAINT mrv_has_rule CHECK (standard_amount IS NOT NULL OR ceiling_amount IS NOT NULL
                                 OR min_months_between IS NOT NULL),
  CONSTRAINT mrv_ceiling_ge_standard CHECK (
    standard_amount IS NULL OR ceiling_amount IS NULL OR ceiling_amount >= standard_amount),
  CONSTRAINT mrv_month_first_day CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
  CONSTRAINT mrv_retire_shape CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mrv_slot
  ON app_private.maintenance_rule_versions
     (organization_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
      service_kind, effective_from_month)
  WHERE status = 'PUBLISHED';

REVOKE ALL ON app_private.maintenance_rule_versions
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.maintenance_rule_versions IS
  'Chuẩn/trần giá và giãn cách bảo trì. RỖNG lúc tạo ⇒ không luật nào áp. '
  'counts_history mặc định FALSE: bật TRUE là khoá ngay 59/59 phòng đã từng vệ '
  'sinh máy lạnh tới 15/10-28/12/2026. enforcement mặc định WARN vì hệ thống '
  'không biết mỗi phòng có mấy máy lạnh — chặn cứng sẽ chặn oan phòng 2 máy.';

-- ─────────────────────────────────────────────────────────────────────
-- Kiểm một lần bảo trì: giá so chuẩn/trần, và lần gần nhất cách bao lâu
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.maintenance_rule_check_v1(
  p_org      uuid,
  p_building uuid,
  p_room     uuid,
  p_kind     text,
  p_when     date,
  p_amount   numeric
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_r      record;
  v_last   date;
  v_gapm   int;
  v_price  text := 'OK';
  v_cad    text := 'OK';
  v_reason text := NULL;
BEGIN
  SELECT * INTO v_r FROM app_private.maintenance_rule_versions v
   WHERE v.organization_id = p_org AND v.status = 'PUBLISHED'
     AND v.service_kind = p_kind
     AND v.effective_from_month <= date_trunc('month', p_when)::date
     AND (v.building_id = p_building OR v.building_id IS NULL)
   ORDER BY (v.building_id IS NOT NULL) DESC, v.effective_from_month DESC
   LIMIT 1;

  IF v_r.id IS NULL THEN
    RETURN jsonb_build_object('verdict','NO_RULE',
      'reason','Chủ chưa công bố luật bảo trì cho hạng mục này — giữ nguyên hành vi cũ');
  END IF;

  -- ── Giá ──
  IF v_r.ceiling_amount IS NOT NULL AND round(COALESCE(p_amount,0)) > round(v_r.ceiling_amount) THEN
    v_price := 'OVER_CEILING';
    v_reason := 'Giá ' || replace(to_char(round(COALESCE(p_amount,0)),'FM999G999G999G999'),',','.')
             || 'đ vượt trần ' || replace(to_char(round(v_r.ceiling_amount),'FM999G999G999G999'),',','.') || 'đ';
  ELSIF v_r.standard_amount IS NOT NULL AND round(COALESCE(p_amount,0)) > round(v_r.standard_amount) THEN
    v_price := 'OVER_STANDARD';
    v_reason := 'Giá cao hơn mức chuẩn '
             || replace(to_char(round(v_r.standard_amount),'FM999G999G999G999'),',','.') || 'đ';
  END IF;

  -- ── Giãn cách ──
  -- Máy lạnh tính theo PHÒNG; máy giặt theo TOÀ. Không có phòng thì luật theo
  -- phòng KHÔNG áp được — nói thẳng thay vì âm thầm cho qua.
  IF v_r.min_months_between IS NOT NULL THEN
    IF p_kind = 'AIR_CONDITIONER' AND p_room IS NULL THEN
      v_cad := 'NO_ROOM';
      v_reason := COALESCE(v_reason || ' · ', '')
               || 'Phiếu không gắn phòng nên không kiểm được luật giãn cách theo phòng';
    ELSE
      SELECT max(ie.voucher_date) INTO v_last
        FROM public.income_expenses ie
        JOIN public.income_expense_items it ON it.income_expense_id = ie.id
        JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
       WHERE ie.organization_id = p_org
         AND ie.deleted_at IS NULL
         AND ie.approval_status <> 'CANCELLED'
         AND ie.type = 'EXPENSE'
         AND ie.voucher_date < p_when
         AND public.nrm_vn(t.category) LIKE 'bao tri%'
         AND (CASE WHEN p_kind = 'AIR_CONDITIONER'
                   THEN public.nrm_vn(t.category) LIKE '%may lanh%'
                   ELSE public.nrm_vn(t.category) LIKE '%may giat%' END)
         AND (CASE WHEN p_kind = 'AIR_CONDITIONER'
                   THEN ie.room_id = p_room
                   ELSE ie.building_id = p_building END)
         -- Mặc định CHỈ tính các lần từ ngày công bố luật trở đi.
         AND (v_r.counts_history OR ie.voucher_date >= v_r.effective_from_month);

      IF v_last IS NOT NULL THEN
        v_gapm := (EXTRACT(YEAR FROM age(p_when, v_last))*12
                 + EXTRACT(MONTH FROM age(p_when, v_last)))::int;
        IF v_gapm < v_r.min_months_between THEN
          v_cad := 'TOO_SOON';
          v_reason := COALESCE(v_reason || ' · ', '')
                   || 'Lần bảo trì gần nhất là ' || to_char(v_last,'DD/MM/YYYY')
                   || ' (cách ' || v_gapm || ' tháng, luật đòi tối thiểu '
                   || v_r.min_months_between || ' tháng)';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'verdict', CASE WHEN v_price = 'OK' AND v_cad = 'OK' THEN 'OK' ELSE 'FLAGGED' END,
    'price', v_price, 'cadence', v_cad,
    'enforcement', v_r.enforcement,
    'lastServicedAt', v_last,
    'standardAmount', v_r.standard_amount,
    'ceilingAmount', v_r.ceiling_amount,
    'minMonthsBetween', v_r.min_months_between,
    'countsHistory', v_r.counts_history,
    'reason', v_reason);
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.maintenance_rule_check_v1(uuid,uuid,uuid,text,date,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_maintenance_rule_v1(
  p_service_kind         text,
  p_standard_amount      numeric DEFAULT NULL,
  p_ceiling_amount       numeric DEFAULT NULL,
  p_min_months_between   int     DEFAULT NULL,
  p_counts_history       boolean DEFAULT false,
  p_enforcement          text    DEFAULT 'WARN',
  p_building_id          uuid    DEFAULT NULL,
  p_effective_from_month text    DEFAULT NULL,
  p_organization_id      uuid    DEFAULT NULL,
  p_note                 text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_actor uuid := auth.uid(); v_org uuid; v_month date; v_id uuid; v_locked int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_service_kind NOT IN ('AIR_CONDITIONER','WASHING_MACHINE') THEN
    RAISE EXCEPTION 'Hạng mục chỉ nhận AIR_CONDITIONER hoặc WASHING_MACHINE' USING ERRCODE='22023';
  END IF;
  IF p_enforcement NOT IN ('WARN','BLOCK') THEN
    RAISE EXCEPTION 'enforcement chỉ nhận WARN hoặc BLOCK' USING ERRCODE='22023';
  END IF;

  IF p_building_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org FROM public.buildings b
     WHERE b.id = p_building_id AND b.deleted_at IS NULL;
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='P0002'; END IF;
  ELSE
    v_org := COALESCE(p_organization_id,
      (SELECT m.organization_id FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.status='ACTIVE' LIMIT 1));
    IF v_org IS NULL THEN RAISE EXCEPTION 'Không xác định được tổ chức' USING ERRCODE='22023'; END IF;
  END IF;

  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ tổ chức mới đặt được luật bảo trì' USING ERRCODE='42501';
  END IF;

  v_month := CASE WHEN p_effective_from_month IS NULL
    THEN date_trunc('month', public.org_today_v1(v_org))::date
    ELSE to_date(p_effective_from_month || '-01','YYYY-MM-DD') END;

  UPDATE app_private.maintenance_rule_versions
     SET status='RETIRED', retired_at=now()
   WHERE organization_id=v_org AND service_kind=p_service_kind
     AND COALESCE(building_id,'00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(p_building_id,'00000000-0000-0000-0000-000000000000'::uuid)
     AND effective_from_month=v_month AND status='PUBLISHED';

  INSERT INTO app_private.maintenance_rule_versions
    (organization_id, building_id, service_kind, effective_from_month,
     standard_amount, ceiling_amount, min_months_between, counts_history,
     enforcement, note, created_by)
  VALUES (v_org, p_building_id, p_service_kind, v_month,
          p_standard_amount, p_ceiling_amount, p_min_months_between,
          COALESCE(p_counts_history,false), p_enforcement,
          NULLIF(btrim(COALESCE(p_note,'')),''), v_actor)
  RETURNING id INTO v_id;

  -- Nếu chủ bật tính-cả-lịch-sử thì ĐẾM THẬT xem sẽ khoá bao nhiêu phòng/toà
  -- và trả về ngay, để chủ thấy hệ quả bằng con số chứ không phải lời hứa.
  v_locked := 0;
  IF COALESCE(p_counts_history,false) AND p_min_months_between IS NOT NULL THEN
    SELECT count(DISTINCT COALESCE(ie.room_id, ie.building_id)) INTO v_locked
      FROM public.income_expenses ie
      JOIN public.income_expense_items it ON it.income_expense_id = ie.id
      JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
     WHERE ie.organization_id = v_org AND ie.deleted_at IS NULL
       AND ie.approval_status <> 'CANCELLED' AND ie.type='EXPENSE'
       AND public.nrm_vn(t.category) LIKE 'bao tri%'
       AND (CASE WHEN p_service_kind='AIR_CONDITIONER'
                 THEN public.nrm_vn(t.category) LIKE '%may lanh%'
                 ELSE public.nrm_vn(t.category) LIKE '%may giat%' END)
       AND (p_building_id IS NULL OR ie.building_id = p_building_id)
       AND ie.voucher_date > (public.org_today_v1(v_org) - (p_min_months_between * 31));
  END IF;

  RETURN jsonb_build_object('id', v_id, 'serviceKind', p_service_kind,
    'standardAmount', p_standard_amount, 'ceilingAmount', p_ceiling_amount,
    'minMonthsBetween', p_min_months_between, 'countsHistory', COALESCE(p_counts_history,false),
    'enforcement', p_enforcement, 'effectiveFrom', to_char(v_month,'YYYY-MM'),
    'wouldLockNow', v_locked,
    'note', CASE
      WHEN COALESCE(p_counts_history,false) AND v_locked > 0
        THEN 'CẢNH BÁO: tính cả lịch sử ⇒ ' || v_locked
             || ' phòng/toà đã bảo trì gần đây đang bị khoá cho tới khi đủ '
             || p_min_months_between || ' tháng.'
      WHEN p_min_months_between IS NOT NULL
        THEN 'Chỉ tính các lần bảo trì TỪ tháng ' || to_char(v_month,'MM/YYYY')
             || ' trở đi — không khoá phòng nào vì việc đã làm trước đó.'
      ELSE 'Đã đặt mức giá. Chưa áp luật giãn cách.'
    END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_maintenance_rule_v1(text,numeric,numeric,int,boolean,text,uuid,text,uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_maintenance_rule_v1(text,numeric,numeric,int,boolean,text,uuid,text,uuid,text)
  TO authenticated, service_role;

-- Người vận hành xem trước một lần bảo trì có bị gắn cờ không.
CREATE OR REPLACE FUNCTION public.preview_maintenance_rule_v1(
  p_building_id uuid, p_room_id uuid, p_service_kind text, p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='P0002'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;
  RETURN app_private.maintenance_rule_check_v1(
    v_org, p_building_id, p_room_id, p_service_kind,
    public.org_today_v1(v_org), p_amount);
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_maintenance_rule_v1(uuid,uuid,text,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_maintenance_rule_v1(uuid,uuid,text,numeric)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_n int;
BEGIN
  IF to_regclass('app_private.utility_ceiling_versions') IS NULL
     OR to_regclass('app_private.maintenance_rule_versions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng cấu hình. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.utility_ceiling_check_v1(uuid,uuid,text,date,numeric,numeric)') IS NULL
     OR to_regprocedure('app_private.maintenance_rule_check_v1(uuid,uuid,uuid,text,date,numeric)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm kiểm luật. DỪNG.';
  END IF;

  -- Mặc định counts_history phải là FALSE: bật sẵn là khoá 59/59 phòng.
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema='app_private' AND table_name='maintenance_rule_versions'
         AND column_name='counts_history') NOT LIKE '%false%' THEN
    RAISE EXCEPTION 'counts_history mặc định KHÔNG phải false — bật luật là khoá hàng loạt phòng. DỪNG.';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema='app_private' AND table_name='maintenance_rule_versions'
         AND column_name='enforcement') NOT LIKE '%WARN%' THEN
    RAISE EXCEPTION 'enforcement mặc định KHÔNG phải WARN — chặn cứng sẽ chặn oan phòng nhiều máy. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM app_private.utility_ceiling_versions;
  IF v_n > 0 THEN RAISE NOTICE 'Trần điện/nước đã có % dòng.', v_n; END IF;
  SELECT count(*) INTO v_n FROM app_private.maintenance_rule_versions;
  IF v_n > 0 THEN RAISE NOTICE 'Luật bảo trì đã có % dòng.', v_n; END IF;
END
$verify$;

COMMIT;
