-- =====================================================================
-- ĐỢT 2 phần 2 — NỐI DÂY: nút bấm thật sự tự duyệt khi đúng luật
--
-- File 20260801010000 dựng đồ nghề (bảng giá có phiên bản, máy kiểm rule,
-- adapter ghi sổ). File này nối chúng vào ba chỗ:
--
--   1. Đường ghi giá cho trang Cài đặt — set_special_fee_price_v1.
--      CHỦ / SUPER ADMIN mới khai giá được. Đây KHÔNG phải khắt khe thừa:
--      giá công bố là thứ quyết định "được tự duyệt hay không", nên nếu nhân
--      viên tự khai giá được thì họ chỉ cần khai đúng bằng số mình sắp chi là
--      tự duyệt xong — cái chốt thành đồ trang trí. Cột default_amount của
--      building_fee_accounts vẫn cho sửa như cũ (nó chỉ là gợi ý điền sẵn).
--
--   2. pay_period_fee — nút chi từng ô trên /thanh-toan. Vá theo NEO, không
--      viết đè, vì thân hàm trên prod đã trôi khỏi file migration nhiều lần.
--      Đổi ba chỗ:
--        (a) phiếu sinh ra ở CHỜ DUYỆT thay vì tự APPROVED. Đây là điều kiện
--            tồn tại của cả cơ chế: phiếu sinh ra ở APPROVED thì cầu a85b
--            (AFTER INSERT) đúc bút toán LEGACY_BRIDGE ngay lập tức, adapter
--            không còn chỗ chen vào để ghi đúng xuất xứ + khoá chống ghi lại.
--        (b) sau khi tạo phiếu thì kiểm rule; VALID hoặc CHƯA_KHAI_GIÁ ⇒ gọi
--            adapter (kết quả cuối vẫn là APPROVED + đã vào sổ, y như trước);
--            LỆCH GIÁ ⇒ để nguyên chờ duyệt. Đây là hành vi MỚI duy nhất.
--        (c) THÔI ghi đè building_fee_accounts.default_amount bằng số vừa chi.
--            Đây là bug: chủ khai 500.000đ, ai đó chi 9.507.910đ là giá khai
--            biến mất. Vẫn học provider_code / account_holder / sổ mặc định.
--
--   3. generate_special_fees_v1 — nút sinh hàng loạt. Thêm tham số sổ quỹ;
--      có sổ ⇒ tự duyệt + vào sổ, không có sổ ⇒ giữ nguyên hành vi cũ (chờ
--      duyệt). Bắt buộc phải thêm vì 0/133 dòng cấu hình có sổ mặc định, tức
--      cỗ máy hôm nay KHÔNG biết chi từ sổ nào.
--
-- KHÔNG đụng /thu-chi (quyết định số 2 của chủ). Không sửa một đồng dữ liệu cũ.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.special_fee_approve_and_post_v1(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu adapter special_fee_approve_and_post_v1 — chạy 20260801010000 trước. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.special_fee_rule_check_v1(uuid,uuid,text,date,date,numeric)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu máy kiểm rule. DỪNG.';
  END IF;
  IF to_regclass('app_private.special_fee_price_versions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng giá. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1 — không xác định được ai là chủ. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. KHAI GIÁ — chủ tổ chức / super admin
--
-- Đổi giá KHÔNG sửa dòng cũ: nó cho dòng cũ nghỉ (RETIRED) nếu trùng đúng
-- tháng hiệu lực, rồi thêm dòng mới. Phiếu của các tháng trước vẫn đối chiếu
-- được với giá của CHÍNH tháng đó — đúng luật "không hồi tố" chủ đã chốt.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_special_fee_price_v1(
  p_building_id uuid,
  p_fee_category text,
  p_amount numeric,
  p_effective_from_month text DEFAULT NULL,   -- 'YYYY-MM'; NULL = tháng này
  p_note text DEFAULT NULL
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
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Giá công bố phải lớn hơn 0' USING ERRCODE = '22023';
  END IF;

  SELECT b.organization_id INTO v_org FROM public.buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION
      'Chỉ chủ tổ chức mới công bố được giá phí cố định. Giá này quyết định phiếu nào được tự duyệt, nên không mở cho người khác.'
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

  -- Công bố lại cho CÙNG tháng hiệu lực: cho bản cũ nghỉ, không xoá.
  UPDATE app_private.special_fee_price_versions
     SET status = 'RETIRED', retired_at = now()
   WHERE organization_id = v_org AND building_id = p_building_id
     AND fee_category = p_fee_category AND effective_from_month = v_month
     AND status = 'PUBLISHED';

  INSERT INTO app_private.special_fee_price_versions
    (organization_id, building_id, fee_category, effective_from_month,
     amount, source, note, created_by)
  VALUES (v_org, p_building_id, p_fee_category, v_month,
          round(p_amount, 2), 'OWNER', NULLIF(btrim(COALESCE(p_note,'')), ''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'buildingId', p_building_id, 'feeCategory', p_fee_category,
    'amount', round(p_amount, 2), 'effectiveFrom', to_char(v_month, 'YYYY-MM'),
    'note', 'Giá áp dụng từ tháng ' || to_char(v_month, 'MM/YYYY') || '. Phiếu các tháng trước giữ nguyên giá cũ.');
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_special_fee_price_v1(uuid,text,numeric,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_special_fee_price_v1(uuid,text,numeric,text,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_special_fee_price_v1(uuid,text,numeric,text,text) IS
  'Chủ tổ chức công bố giá phí cố định cho một toà × hạng mục, áp dụng TỪ THÁNG chỉ định. '
  'Đổi giá = thêm bản mới, bản cũ chuyển RETIRED chứ không xoá, nên phiếu tháng trước vẫn '
  'đối chiếu được. Cố ý chỉ mở cho chủ: giá này quyết định phiếu nào được tự duyệt.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. ĐỌC BẢNG GIÁ — cho trang Cài đặt hiện đúng thứ đang có hiệu lực
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_special_fee_prices_v1(
  p_building_ids uuid[] DEFAULT NULL,
  p_month text DEFAULT NULL                    -- 'YYYY-MM'; NULL = tháng này
)
RETURNS TABLE (
  building_id     uuid,
  building_name   text,
  fee_category    text,
  amount          numeric,
  effective_from  text,
  source          text,
  can_edit        boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_month date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    v_month := date_trunc('month', public.org_today_v1(NULL))::date;
  ELSE
    IF p_month !~ '^\d{4}-\d{2}$' THEN
      RAISE EXCEPTION 'Tháng phải dạng YYYY-MM' USING ERRCODE = '22023';
    END IF;
    v_month := to_date(p_month || '-01', 'YYYY-MM-DD');
  END IF;

  RETURN QUERY
  WITH k(kind) AS (
    VALUES ('tien_nha'),('dien'),('nuoc'),('internet'),('quan_ly'),
           ('ve_sinh'),('cong_an'),('rac'),('thang_may')
  ), b AS (
    SELECT bb.id, bb.name, bb.organization_id
      FROM public.buildings bb
     WHERE bb.deleted_at IS NULL
       AND (p_building_ids IS NULL OR bb.id = ANY(p_building_ids))
       AND (public.can_access_building(bb.id) OR public.ie_all_buildings_scope(bb.id)
         OR public.is_admin() OR public.is_super_admin())
  )
  SELECT b.id, b.name, k.kind,
         v.amount,
         to_char(v.effective_from_month, 'YYYY-MM'),
         v.source,
         (public.is_super_admin() OR app_private.is_org_owner_v1(b.organization_id, v_actor))
    FROM b CROSS JOIN k
    LEFT JOIN LATERAL (
      SELECT pv.amount, pv.effective_from_month, pv.source
        FROM app_private.special_fee_price_versions pv
       WHERE pv.organization_id = b.organization_id
         AND pv.building_id = b.id
         AND pv.fee_category = k.kind
         AND pv.status = 'PUBLISHED'
         AND pv.effective_from_month <= v_month
       ORDER BY pv.effective_from_month DESC
       LIMIT 1
    ) v ON true
   ORDER BY b.name, k.kind;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_special_fee_prices_v1(uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_special_fee_prices_v1(uuid[],text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_special_fee_prices_v1(uuid[],text) IS
  'Giá phí cố định đang có hiệu lực cho THÁNG chỉ định, đủ cả ô chưa khai (amount NULL). '
  'can_edit cho giao diện biết có hiện nút sửa hay không. VOLATILE vì chuỗi quyền chạm khoá dòng.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. VÁ pay_period_fee THEO NEO
-- ─────────────────────────────────────────────────────────────────────
DO $patch_ppf$
DECLARE
  v_def text;
  v_new text;
  v_mark text := 'SPECIAL_FEE_AUTOPOST_V1';

  v_a_decl text :=
    '  v_is_super boolean := false;' || chr(10) ||
    '  v_is_owner boolean := false;' || chr(10) ||
    'BEGIN';

  -- (a) Trạng thái lúc tạo phiếu.
  v_a_status text := '     p_amount, ''APPROVED'', TRUE,';

  -- (c) Mệnh đề ghi đè giá đã khai.
  v_a_learn text := '     round(p_amount / GREATEST(v_months, 1)), v_acc, v_owner)';

  -- (b) Chỗ chen phần kiểm rule + gọi adapter: ngay trước câu đọc lại phiếu để trả về.
  v_a_tail text :=
    '  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;';

  -- (d) Chốt chống trùng đang CHỈ đếm phiếu ĐÃ DUYỆT.
  v_a_dup text := '                               AND ie.approval_status = ''APPROVED''';

  v_a_return text :=
    '  RETURN jsonb_build_object(' || chr(10) ||
    '    ''voucher_id'', v_voucher, ''code'', v_code,' || chr(10) ||
    '    ''total_amount'', v_total, ''account_id'', v_acc);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'pay_period_fee' AND p.pronargs = 11;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không thấy public.pay_period_fee/11 — DỪNG';
  END IF;
  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'pay_period_fee đã vá tự duyệt — bỏ qua';
    RETURN;
  END IF;

  IF position(v_a_decl   IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo DECLARE — DỪNG, không vá mù'; END IF;
  IF position(v_a_status IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo trạng thái phiếu — DỪNG, không vá mù'; END IF;
  IF position(v_a_learn  IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo học giá — DỪNG, không vá mù'; END IF;
  IF position(v_a_tail   IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo đuôi — DỪNG, không vá mù'; END IF;
  IF position(v_a_return IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo RETURN — DỪNG, không vá mù'; END IF;
  IF position(v_a_dup    IN v_def) = 0 THEN RAISE EXCEPTION 'pay_period_fee: mất neo chốt trùng — DỪNG, không vá mù'; END IF;

  v_new := v_def;

  -- (d) ĐIỀU KIỆN TỒN TẠI của nhánh "lệch giá thì chờ duyệt".
  -- Chốt chống trùng cũ chỉ đếm phiếu ĐÃ DUYỆT. Từ bản vá này, phiếu lệch giá
  -- nằm lại ở CHỜ DUYỆT ⇒ nó vô hình với chính chốt đó ⇒ bấm lần hai cho cùng
  -- một tháng lại tạo thêm một phiếu nữa, không một lời cảnh báo. Đếm cả phiếu
  -- chờ duyệt thì cảnh báo "ô này đã có phiếu" mới đúng.
  v_new := replace(v_new, v_a_dup,
    '                               AND ie.approval_status <> ''CANCELLED''');

  -- DECLARE: thêm biến của bản vá.
  v_new := replace(v_new, v_a_decl,
    '  v_is_super boolean := false;' || chr(10) ||
    '  v_is_owner boolean := false;' || chr(10) ||
    '  -- ' || v_mark || chr(10) ||
    '  v_rule     jsonb;' || chr(10) ||
    '  v_verdict  text;' || chr(10) ||
    '  v_posting  uuid;' || chr(10) ||
    'BEGIN');

  -- (a) Phiếu ra CHỜ DUYỆT. Adapter sẽ duyệt hộ ngay bên dưới nếu rule cho phép.
  --     Bắt buộc: sinh ra ở APPROVED thì cầu a85b đúc bút toán LEGACY_BRIDGE
  --     ngay trong lệnh INSERT, adapter mất chỗ chen vào.
  v_new := replace(v_new, v_a_status,
    '     p_amount, ''UNAPPROVED'', TRUE,');

  -- (c) Thôi ghi đè giá đã khai. Vẫn học sổ mặc định.
  v_new := replace(v_new, v_a_learn,
    '     NULL, v_acc, v_owner)');

  -- (b) Kiểm rule rồi duyệt hộ.
  v_new := replace(v_new, v_a_tail,
    '  -- ' || v_mark || ': đúng luật thì máy duyệt hộ và ghi sổ luôn.' || chr(10) ||
    '  --   VALID           = số tiền khớp giá chủ đã công bố cho đúng các tháng của kỳ.' || chr(10) ||
    '  --   CONFIG_REQUIRED = chủ chưa công bố giá ô này ⇒ GIỮ NGUYÊN HÀNH VI CŨ (vẫn' || chr(10) ||
    '  --                     tự duyệt). Cố ý không chặn: hôm nay còn rất nhiều ô chưa' || chr(10) ||
    '  --                     khai giá, chặn cứng là cả hệ hết đóng tiền được.' || chr(10) ||
    '  --   AMOUNT_MISMATCH = đã công bố giá mà số đang chi lệch ⇒ để phiếu CHỜ DUYỆT.' || chr(10) ||
    '  v_rule := app_private.special_fee_rule_check_v1(' || chr(10) ||
    '              v_org, p_building_id, p_category_key, v_p_start, v_p_end, p_amount);' || chr(10) ||
    '  v_verdict := v_rule->>''verdict'';' || chr(10) ||
    chr(10) ||
    '  IF v_verdict IN (''VALID'', ''CONFIG_REQUIRED'') THEN' || chr(10) ||
    '    v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, ''SPECIAL_PAGE_FEE'');' || chr(10) ||
    '  END IF;' || chr(10) ||
    chr(10) ||
    v_a_tail);

  -- Trả thêm kết quả kiểm rule để giao diện nói đúng chuyện gì vừa xảy ra.
  v_new := replace(v_new, v_a_return,
    '  RETURN jsonb_build_object(' || chr(10) ||
    '    ''voucher_id'', v_voucher, ''code'', v_code,' || chr(10) ||
    '    ''total_amount'', v_total, ''account_id'', v_acc,' || chr(10) ||
    '    ''rule'', v_rule,' || chr(10) ||
    '    ''auto_approved'', (v_posting IS NOT NULL),' || chr(10) ||
    '    ''posting_id'', v_posting,' || chr(10) ||
    '    ''status_note'', CASE' || chr(10) ||
    '      WHEN v_posting IS NOT NULL AND v_verdict = ''VALID''' || chr(10) ||
    '        THEN ''Đúng giá đã công bố — phiếu đã duyệt và vào sổ.''' || chr(10) ||
    '      WHEN v_posting IS NOT NULL' || chr(10) ||
    '        THEN ''Toà này chưa công bố giá cho hạng mục — phiếu vẫn được duyệt và vào sổ như trước.''' || chr(10) ||
    '      ELSE COALESCE(v_rule->>''reason'', ''Phiếu đang chờ duyệt.'')' || chr(10) ||
    '           || '' Phiếu đã tạo và đang CHỜ DUYỆT.''' || chr(10) ||
    '    END);');

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ pay_period_fee (kiểm rule + tự duyệt + thôi ghi đè giá khai)';
END
$patch_ppf$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. VÁ generate_special_fees_v1 — thêm sổ quỹ để tự ghi sổ được
--
-- Thêm THAM SỐ MỚI có mặc định ⇒ chữ ký cũ 3 tham số vẫn gọi được, client cũ
-- không vỡ. Không có sổ ⇒ y như hôm nay (phiếu chờ duyệt).
-- ─────────────────────────────────────────────────────────────────────
DO $patch_gen$
DECLARE
  v_def text;
  v_new text;
  v_mark text := 'SPECIAL_FEE_AUTOPOST_V1';
  v_a_sig text :=
    'CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(p_period text, p_building_ids uuid[], p_idempotency_key text)';
  v_a_decl text := '  v_label text;' || chr(10) || 'BEGIN';
  v_a_claim text :=
    '    v_n := v_n + 1; v_sum := v_sum + r.amount; v_ids := v_ids || v_ie;';
  v_a_note text :=
    '    ''note'', ''Phiếu sinh ra ở trạng thái CHỜ DUYỆT — máy đề xuất, người duyệt.'');';
BEGIN
  -- Nhận "đã vá" phải soi bản 4 THAM SỐ, không soi bản 3. Sau lần áp đầu tiên,
  -- bản 3 tham số chỉ còn là VỎ chuyển tiếp (không mang dấu vá, không mang neo)
  -- ⇒ soi nhầm vào nó là lần áp thứ hai kêu "mất neo" và migration hết chạy lại
  -- được — đúng thứ cửa kiểm "apply hai lần liên tiếp" bắt.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1'
       AND p.pronargs = 4 AND position(v_mark IN p.prosrc) > 0
  ) THEN
    RAISE NOTICE 'generate_special_fees_v1 đã vá — bỏ qua';
    RETURN;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1' AND p.pronargs = 3;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không thấy public.generate_special_fees_v1/3 — DỪNG';
  END IF;

  IF position(v_a_sig   IN v_def) = 0 THEN RAISE EXCEPTION 'generate_special_fees_v1: mất neo chữ ký — DỪNG'; END IF;
  IF position(v_a_decl  IN v_def) = 0 THEN RAISE EXCEPTION 'generate_special_fees_v1: mất neo DECLARE — DỪNG'; END IF;
  IF position(v_a_claim IN v_def) = 0 THEN RAISE EXCEPTION 'generate_special_fees_v1: mất neo đếm — DỪNG'; END IF;
  IF position(v_a_note  IN v_def) = 0 THEN RAISE EXCEPTION 'generate_special_fees_v1: mất neo ghi chú — DỪNG'; END IF;

  v_new := v_def;

  v_new := replace(v_new, v_a_sig,
    'CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(p_period text, p_building_ids uuid[], p_idempotency_key text, p_account_id uuid DEFAULT NULL)');

  v_new := replace(v_new, v_a_decl,
    '  v_label text;' || chr(10) ||
    '  -- ' || v_mark || chr(10) ||
    '  v_acc      uuid;' || chr(10) ||
    '  v_posted   int := 0;' || chr(10) ||
    '  v_rule     jsonb;' || chr(10) ||
    'BEGIN' || chr(10) ||
    '  -- Sổ quỹ (tuỳ chọn): có thì máy duyệt hộ + ghi sổ; không có thì y như cũ.' || chr(10) ||
    '  IF p_account_id IS NOT NULL THEN' || chr(10) ||
    '    SELECT a.id INTO v_acc FROM public.accounts a' || chr(10) ||
    '     WHERE a.id = p_account_id AND a.deleted_at IS NULL' || chr(10) ||
    '       AND NOT COALESCE(a.is_virtual, false);' || chr(10) ||
    '    IF v_acc IS NULL THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Sổ quỹ không hợp lệ hoặc là SỔ ẢO — phí cố định là tiền thật ra khỏi két''' || chr(10) ||
    '        USING ERRCODE = ''22023'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    '  END IF;');

  -- Gắn sổ vào phiếu vừa tạo rồi duyệt hộ. Đặt account_id TRƯỚC khi adapter
  -- chạy: lõi ghi sổ đòi phiếu đã có sổ quỹ thật.
  v_new := replace(v_new, v_a_claim,
    '    IF v_acc IS NOT NULL THEN' || chr(10) ||
    '      UPDATE income_expenses SET account_id = v_acc WHERE id = v_ie;' || chr(10) ||
    '      v_rule := app_private.special_fee_rule_check_v1(' || chr(10) ||
    '                  v_org, r.building_id, r.fee_category, v_m0, v_m1, r.amount);' || chr(10) ||
    '      IF (v_rule->>''verdict'') IN (''VALID'', ''CONFIG_REQUIRED'') THEN' || chr(10) ||
    '        PERFORM app_private.special_fee_approve_and_post_v1(v_ie, ''SPECIAL_PAGE_FEE'');' || chr(10) ||
    '        v_posted := v_posted + 1;' || chr(10) ||
    '      END IF;' || chr(10) ||
    '    END IF;' || chr(10) ||
    chr(10) ||
    v_a_claim);

  v_new := replace(v_new, v_a_note,
    '    ''posted'', v_posted,' || chr(10) ||
    '    ''note'', CASE WHEN v_acc IS NULL' || chr(10) ||
    '      THEN ''Phiếu sinh ra ở trạng thái CHỜ DUYỆT — máy đề xuất, người duyệt.''' || chr(10) ||
    '      ELSE v_posted || ''/'' || v_n || '' phiếu đã tự duyệt và vào sổ; phần còn lại chờ duyệt vì lệch giá đã công bố.''' || chr(10) ||
    '    END);');

  EXECUTE v_new;

  -- Chữ ký cũ 3 tham số: KHÔNG xoá. Tab người dùng đang mở vẫn gọi bản 3 tham
  -- số cho tới khi họ tải lại trang; xoá là gãy nút ngay giữa ca làm. Thay bằng
  -- một lớp vỏ mỏng chuyển tiếp sang bản 4 tham số với sổ quỹ NULL — tức đúng
  -- hành vi cũ (phiếu ra chờ duyệt).
  EXECUTE $shim$
    CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(
      p_period text, p_building_ids uuid[], p_idempotency_key text)
    RETURNS jsonb
    LANGUAGE sql
    VOLATILE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'app_private'
    AS $shimbody$
      SELECT public.generate_special_fees_v1(p_period, p_building_ids, p_idempotency_key, NULL);
    $shimbody$;
  $shim$;

  RAISE NOTICE 'ĐÃ VÁ generate_special_fees_v1 (thêm sổ quỹ + tự duyệt, giữ vỏ 3 tham số)';
END
$patch_gen$;

REVOKE ALL ON FUNCTION public.generate_special_fees_v1(text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_special_fees_v1(text, uuid[], text)
  TO authenticated, service_role;

-- Cấp quyền cho chữ ký MỚI (DROP bản cũ đã cuốn theo GRANT của nó).
REVOKE ALL ON FUNCTION public.generate_special_fees_v1(text, uuid[], text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_special_fees_v1(text, uuid[], text, uuid)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_ppf text; v_gen text; v_n int;
BEGIN
  SELECT p.prosrc INTO v_ppf FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pay_period_fee' AND p.pronargs = 11;
  SELECT p.prosrc INTO v_gen FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1' AND p.pronargs = 4;

  IF v_ppf IS NULL THEN RAISE EXCEPTION 'Mất pay_period_fee/11 sau khi vá. DỪNG.'; END IF;
  IF v_gen IS NULL THEN RAISE EXCEPTION 'Không thấy generate_special_fees_v1/4 sau khi vá. DỪNG.'; END IF;

  IF position('special_fee_approve_and_post_v1' IN v_ppf) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee không gọi adapter. DỪNG.';
  END IF;
  IF position('''UNAPPROVED''' IN v_ppf) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee vẫn tạo phiếu APPROVED thẳng — cầu a85b sẽ giành mất chỗ. DỪNG.';
  END IF;
  IF position('round(p_amount / GREATEST(v_months, 1))' IN v_ppf) > 0 THEN
    RAISE EXCEPTION 'pay_period_fee VẪN ghi đè giá đã khai. DỪNG.';
  END IF;
  IF position('special_fee_approve_and_post_v1' IN v_gen) = 0 THEN
    RAISE EXCEPTION 'generate_special_fees_v1 không gọi adapter. DỪNG.';
  END IF;

  -- Chốt trùng phải đếm cả phiếu chờ duyệt, không thì nhánh "lệch giá thì chờ
  -- duyệt" tự tạo ra một lỗ đóng tiền hai lần.
  IF position('approval_status <> ''CANCELLED''' IN v_ppf) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: chốt trùng vẫn chỉ đếm phiếu ĐÃ DUYỆT — phiếu chờ duyệt sẽ vô hình. DỪNG.';
  END IF;

  -- Đúng HAI bản generate_special_fees_v1: bản thật 4 tham số + vỏ 3 tham số.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Có % bản generate_special_fees_v1, phải đúng 2 (bản thật + vỏ tương thích). DỪNG.', v_n;
  END IF;
END
$verify$;

COMMIT;
