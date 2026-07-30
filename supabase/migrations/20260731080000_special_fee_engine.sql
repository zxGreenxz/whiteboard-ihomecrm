-- =====================================================================
-- Đợt 3 — CỖ MÁY SINH PHIẾU PHÍ CỐ ĐỊNH THEO KỲ
--
-- Hôm nay chủ phải bấm TỪNG phiếu: vào /thanh-toan, chọn toà, chọn hạng mục, gõ
-- tiền, bấm đóng — lặp lại cho ~47 khoản mỗi tháng. File này cho phép: xem trước
-- một lần, đồng ý một lần, hệ đẻ ra toàn bộ phiếu CHỜ DUYỆT.
--
-- QUYẾT ĐỊNH THIẾT KẾ QUAN TRỌNG — KHÔNG dựng bảng "luật" mới:
--   Plan gốc vẽ `special_fee_rules` + `special_fee_rule_versions`. Nhưng LUẬT ĐÃ
--   TỒN TẠI RỒI: `building_fee_accounts` có 109 dòng / 107 dòng có giá, và chủ
--   đang tự bảo trì nó qua trang /settings/finance/fixed-fees (Đợt −1). Dựng bảng
--   luật thứ hai là tạo HAI nguồn sự thật về giá — chỗ kinh điển để hai màn hình
--   hiện hai số. Nên file này chỉ thêm thứ THẬT SỰ còn thiếu: **sổ CLAIM** để mỗi
--   ô (toà × hạng mục × tháng) chỉ được sinh ĐÚNG MỘT LẦN.
--
-- BA THỨ CHỐNG SINH TRÙNG, xếp chồng:
--   1. UNIQUE (org, building, category, period) trên sổ claim — chốt cứng ở tầng DB
--   2. Preview/writer loại ô ĐÃ CÓ phiếu duyệt (dùng chính khoá ô của pay_period_fee)
--   3. Khoá tư vấn theo (org, kỳ) khi ghi — hai người bấm cùng lúc thì xếp hàng
--
-- PHIẾU SINH RA LÀ **UNAPPROVED + chưa ghi sổ**. Cố ý: máy đề xuất, NGƯỜI duyệt.
-- Không có đường nào để cỗ máy này tự chi tiền.
--
-- ROUTE OFF: writer đòi cờ `special_fee.generate.v1` ở chế độ CANONICAL. Cờ chưa
-- bật ⇒ ném lỗi rõ nghĩa. Preview thì chạy được ngay (chỉ đọc).
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.fee_type_matches(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu fee_type_matches — chạy Đợt −1 trước. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.evaluate_feature_route(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu evaluate_feature_route. DỪNG.';
  END IF;
  IF to_regclass('public.building_fee_accounts') IS NULL THEN
    RAISE EXCEPTION 'Thiếu building_fee_accounts — nguồn giá. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. SỔ CLAIM — mỗi ô sinh đúng một lần
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.special_fee_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  fee_category    text NOT NULL,
  period_month    date NOT NULL,          -- luôn là ngày 1 của tháng
  amount          numeric(15,2) NOT NULL CHECK (amount > 0),
  voucher_id      uuid REFERENCES public.income_expenses(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'GENERATED'
                    CHECK (status IN ('GENERATED','CANCELLED')),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  generated_by    uuid NOT NULL,
  batch_key       text NOT NULL,          -- idempotency của cả lượt sinh
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT special_fee_claims_period_first_day
    CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT special_fee_claims_category_chk
    CHECK (fee_category IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may')),
  CONSTRAINT special_fee_claims_cancel_shape
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

-- Chốt cứng: một ô sống chỉ có MỘT claim. Huỷ rồi thì sinh lại được.
CREATE UNIQUE INDEX IF NOT EXISTS ux_special_fee_claims_slot
  ON public.special_fee_claims (organization_id, building_id, fee_category, period_month)
  WHERE status = 'GENERATED';

CREATE INDEX IF NOT EXISTS idx_special_fee_claims_batch
  ON public.special_fee_claims (organization_id, batch_key);

COMMENT ON TABLE public.special_fee_claims IS
  'Đợt 3: sổ ghi "ô (toà × hạng mục × tháng) này đã được sinh phiếu". Unique index '
  'chỉ áp cho status=GENERATED nên huỷ rồi vẫn sinh lại được. CỐ Ý không có bảng '
  'luật riêng: giá lấy từ building_fee_accounts mà chủ đã bảo trì qua trang Cài đặt '
  '— dựng bảng luật thứ hai là tạo hai nguồn sự thật về giá.';

ALTER TABLE public.special_fee_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS special_fee_claims_read ON public.special_fee_claims;
CREATE POLICY special_fee_claims_read ON public.special_fee_claims
  FOR SELECT TO authenticated
  USING (public.can_access_building(building_id)
      OR public.ie_all_buildings_scope(building_id)
      OR public.is_admin() OR public.is_super_admin());

-- Ghi CHỈ qua RPC (SECURITY DEFINER). Không cấp DML cho client.
REVOKE ALL ON public.special_fee_claims FROM anon, authenticated;
GRANT SELECT ON public.special_fee_claims TO authenticated;
GRANT ALL ON public.special_fee_claims TO service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 2. XEM TRƯỚC — "tháng này phải chi những gì"
--    Chỉ đọc. Chạy được ngay cả khi route OFF.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_special_fees_v1(
  p_period       text,                    -- 'YYYY-MM'
  p_building_ids uuid[] DEFAULT NULL
)
 RETURNS TABLE (
   building_id   uuid,
   building_name text,
   fee_category  text,
   amount        numeric,
   provider_code text,
   status        text,      -- SẼ_SINH | ĐÃ_SINH | ĐÃ_CÓ_PHIẾU | KHÔNG_ÁP_DỤNG | THIẾU_GIÁ
   reason        text,
   existing_code text
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH k(kind) AS (
    VALUES ('tien_nha'),('dien'),('nuoc'),('internet'),('quan_ly'),
           ('ve_sinh'),('cong_an'),('rac'),('thang_may')
  ),
  p AS (SELECT to_date(p_period || '-01','YYYY-MM-DD') AS m0,
               (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD'))
                 + interval '1 month - 1 day')::date AS m1),
  b AS (
    SELECT bb.id, bb.name, bb.organization_id,
           COALESCE(bb.hidden_fixed_expenses,'{}') AS hidden
      FROM buildings bb
     WHERE bb.deleted_at IS NULL
       AND (p_building_ids IS NULL OR bb.id = ANY(p_building_ids))
       AND (public.can_access_building(bb.id) OR public.ie_all_buildings_scope(bb.id)
         OR public.is_admin() OR public.is_super_admin())
  )
  SELECT b.id, b.name, k.kind,
         f.default_amount, f.provider_code,
         CASE
           WHEN k.kind = ANY(b.hidden)                       THEN 'KHÔNG_ÁP_DỤNG'
           WHEN cl.id IS NOT NULL                            THEN 'ĐÃ_SINH'
           WHEN ex.code IS NOT NULL                          THEN 'ĐÃ_CÓ_PHIẾU'
           WHEN COALESCE(f.default_amount,0) <= 0            THEN 'THIẾU_GIÁ'
           ELSE 'SẼ_SINH'
         END,
         CASE
           WHEN k.kind = ANY(b.hidden)            THEN 'Toà này đã tắt hạng mục'
           WHEN cl.id IS NOT NULL                 THEN 'Đã sinh phiếu ở lượt trước'
           WHEN ex.code IS NOT NULL               THEN 'Kỳ này đã có phiếu chi được duyệt'
           WHEN COALESCE(f.default_amount,0) <= 0 THEN 'Chưa khai giá ở Cài đặt → Phí cố định'
           ELSE NULL
         END,
         ex.code
    FROM b CROSS JOIN k CROSS JOIN p
    LEFT JOIN building_fee_accounts f
      ON f.building_id = b.id AND f.fee_category = k.kind AND f.deleted_at IS NULL
    LEFT JOIN special_fee_claims cl
      ON cl.organization_id = b.organization_id AND cl.building_id = b.id
     AND cl.fee_category = k.kind AND cl.period_month = p.m0 AND cl.status = 'GENERATED'
    -- Ô đã có phiếu chi ĐÃ DUYỆT: dùng đúng khoá ô của pay_period_fee.
    LEFT JOIN LATERAL (
      SELECT ie.code
        FROM income_expense_items it
        JOIN income_expense_types t ON t.id = it.income_expense_type_id AND t.type='expense'
                                   AND public.fee_type_matches(k.kind, t.category, t.name)
        JOIN income_expenses ie ON ie.id = it.income_expense_id
                               AND ie.building_id = b.id AND ie.type='EXPENSE'
                               AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
       WHERE it.start_date <= p.m1 AND it.end_date >= p.m0
       LIMIT 1) ex ON true
   ORDER BY b.name, k.kind;
$function$;

REVOKE ALL ON FUNCTION public.preview_special_fees_v1(text,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_special_fees_v1(text,uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_special_fees_v1(text,uuid[]) IS
  'Đợt 3: xem trước lượt sinh phiếu phí cố định của một kỳ. CHỈ ĐỌC, chạy được cả '
  'khi route OFF. Năm trạng thái: SẼ_SINH / ĐÃ_SINH (đã có claim) / ĐÃ_CÓ_PHIẾU '
  '(ô đã có phiếu duyệt) / KHÔNG_ÁP_DỤNG (toà tắt hạng mục) / THIẾU_GIÁ.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. NGƯỜI GHI — sinh phiếu CHỜ DUYỆT hàng loạt
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(
  p_period          text,
  p_building_ids    uuid[],
  p_idempotency_key text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_m0    date;
  v_m1    date;
  v_route text;
  v_key   text := btrim(COALESCE(p_idempotency_key,''));
  r       record;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_n     int := 0;
  v_sum   numeric := 0;
  v_ids   uuid[] := '{}';
  v_label text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)' USING ERRCODE='22023';
  END IF;
  IF char_length(v_key) < 8 OR char_length(v_key) > 200
     OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE='22023';
  END IF;
  IF p_building_ids IS NULL OR array_length(p_building_ids,1) IS NULL THEN
    RAISE EXCEPTION 'Phải chọn ít nhất một toà' USING ERRCODE='22023';
  END IF;

  v_m0 := to_date(p_period || '-01','YYYY-MM-DD');
  v_m1 := (date_trunc('month', v_m0) + interval '1 month - 1 day')::date;

  SELECT b.organization_id INTO v_org FROM buildings b
   WHERE b.id = p_building_ids[1] AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='22023'; END IF;

  -- Mọi toà phải cùng org — không cho một lượt sinh chéo tổ chức.
  IF EXISTS (SELECT 1 FROM buildings b
              WHERE b.id = ANY(p_building_ids)
                AND (b.deleted_at IS NOT NULL OR b.organization_id IS DISTINCT FROM v_org)) THEN
    RAISE EXCEPTION 'Danh sách toà có toà đã xoá hoặc thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;

  -- ROUTE OFF: cỗ máy này tự đẻ phiếu hàng loạt nên phải có công tắc riêng.
  v_route := app_private.evaluate_feature_route('special_fee.generate.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'Tính năng sinh phiếu phí cố định hàng loạt chưa được bật cho tổ chức này (route %). Bật cờ special_fee.generate.v1 rồi thử lại.',
      v_route USING ERRCODE = '55000';
  END IF;

  -- Khoá theo (org, kỳ): hai người bấm cùng lúc thì xếp hàng, không đẻ hai lượt.
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('special_fee:'||v_org::text||':'||p_period, 0));

  FOR r IN
    SELECT * FROM public.preview_special_fees_v1(p_period, p_building_ids)
     WHERE status = 'SẼ_SINH'
  LOOP
    -- Quyền theo từng toà — preview đã lọc, nhưng writer không tin preview.
    IF NOT (public.can_access_building(r.building_id)
         OR public.ie_all_buildings_scope(r.building_id)
         OR public.is_admin() OR public.is_super_admin()) THEN
      CONTINUE;
    END IF;
    IF r.fee_category = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
      CONTINUE;   -- hạng mục hạn chế: bỏ qua thay vì làm hỏng cả lượt
    END IF;

    v_label := CASE r.fee_category
                 WHEN 'tien_nha' THEN 'Tiền nhà'   WHEN 'dien' THEN 'Tiền điện'
                 WHEN 'nuoc' THEN 'Tiền nước'      WHEN 'internet' THEN 'Internet'
                 WHEN 'quan_ly' THEN 'Quản Lý'     WHEN 've_sinh' THEN 'Vệ sinh định kỳ'
                 WHEN 'cong_an' THEN 'Công An'     WHEN 'rac' THEN 'Rác'
                 ELSE 'Thang máy' END;

    v_type := app_private.ensure_income_expense_type_v1(
                v_org, v_actor, v_label, 'expense', NULL, NULL, false, false,
                (r.fee_category = 'quan_ly'), false, false, false);

    INSERT INTO income_expenses
      (user_id, organization_id, type, name, building_id, voucher_date,
       total_amount, approval_status, system_source, notes)
    VALUES
      (v_actor, v_org, 'EXPENSE',
       v_label || ' ' || r.building_name || ' kỳ ' || p_period,
       r.building_id, public.org_today_v1(v_org),
       r.amount, 'UNAPPROVED', 'special_fee.v1',
       'Sinh tự động cho kỳ ' || p_period)
    RETURNING id, code INTO v_ie, v_code;

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, accounting_class,
       description, quantity, unit_price, amount, start_date, end_date)
    VALUES
      (v_ie, v_type, 'PNL', 'Kỳ ' || p_period, 1, r.amount, r.amount, v_m0, v_m1);

    INSERT INTO special_fee_claims
      (organization_id, building_id, fee_category, period_month, amount,
       voucher_id, generated_by, batch_key)
    VALUES (v_org, r.building_id, r.fee_category, v_m0, r.amount, v_ie, v_actor, v_key);

    v_n := v_n + 1; v_sum := v_sum + r.amount; v_ids := v_ids || v_ie;
  END LOOP;

  RETURN jsonb_build_object(
    'period', p_period, 'organizationId', v_org, 'batchKey', v_key,
    'created', v_n, 'totalAmount', v_sum, 'voucherIds', to_jsonb(v_ids),
    'note', 'Phiếu sinh ra ở trạng thái CHỜ DUYỆT — máy đề xuất, người duyệt.');
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_special_fees_v1(text,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_special_fees_v1(text,uuid[],text) TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_special_fees_v1(text,uuid[],text) IS
  'Đợt 3: sinh hàng loạt phiếu phí cố định cho một kỳ, TRẠNG THÁI CHỜ DUYỆT (máy đề '
  'xuất, người duyệt — không có đường nào để nó tự chi tiền). Ba lớp chống trùng: '
  'unique index trên sổ claim, preview loại ô đã có phiếu duyệt, khoá tư vấn theo '
  '(org, kỳ). Đòi cờ special_fee.generate.v1 ở CANONICAL.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. HUỶ CLAIM — sinh nhầm thì gỡ, và sinh lại được
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_special_fee_claim_v1(
  p_claim_id uuid,
  p_reason   text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_c     public.special_fee_claims;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF COALESCE(length(btrim(p_reason)),0) < 8 THEN
    RAISE EXCEPTION 'Lý do huỷ phải ít nhất 8 ký tự' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_c FROM special_fee_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy claim' USING ERRCODE='P0002'; END IF;
  IF v_c.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('claimId', p_claim_id, 'alreadyCancelled', true);
  END IF;

  IF NOT (public.can_access_building(v_c.building_id)
       OR public.ie_all_buildings_scope(v_c.building_id)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền trên toà này' USING ERRCODE='42501';
  END IF;

  -- Phiếu đã duyệt thì KHÔNG cho gỡ claim: gỡ xong lượt sau sẽ sinh phiếu thứ hai
  -- cho cùng một ô, tức tự tạo ra trùng lặp. Muốn bỏ thì huỷ PHIẾU trước.
  IF v_c.voucher_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM income_expenses ie
        WHERE ie.id = v_c.voucher_id AND ie.approval_status = 'APPROVED'
          AND ie.deleted_at IS NULL) THEN
    RAISE EXCEPTION
      'Phiếu của ô này ĐÃ ĐƯỢC DUYỆT — huỷ claim bây giờ sẽ khiến lượt sinh sau đẻ phiếu thứ hai cho cùng một ô. Hãy huỷ PHIẾU trước.'
      USING ERRCODE = '55000';
  END IF;

  UPDATE special_fee_claims
     SET status='CANCELLED', cancelled_at=now(), cancelled_by=v_actor,
         cancel_reason=btrim(p_reason)
   WHERE id = p_claim_id;

  RETURN jsonb_build_object('claimId', p_claim_id, 'cancelled', true,
                            'voucherId', v_c.voucher_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_special_fee_claim_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_special_fee_claim_v1(uuid,text) TO authenticated, service_role;

COMMIT;
