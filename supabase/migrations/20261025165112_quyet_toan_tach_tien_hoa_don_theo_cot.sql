-- =============================================================================
-- quyet_toan_tach_tien_hoa_don_theo_cot — tách tiền phiếu thu theo hoá đơn thành Tiền phòng / Điện / Nước /
-- PDV (thiết kế "Quyet toan van hanh v2", chủ chốt 25/10/2026; Báo cáo LN dùng cùng công thức).
-- =============================================================================
-- VÌ SAO
--   Phiếu thu tiền hoá đơn chỉ có MỘT dòng hạng mục ("Thu tiền hoá đơn") ⇒ thẻ Khoản thu và khối "Theo hạng
--   mục" không cho thấy tiền phòng, điện, nước, phí dịch vụ. Phần tách nằm ở dòng hoá đơn (invoice_items).
--   Tổng hoá đơn = làm tròn(subtotal − giảm trừ + nợ cũ) (app_private.round_invoice_total_v1); dòng DISCOUNT chỉ
--   là chi tiết của invoices.discount_amount (không nằm trong subtotal) ⇒ phiếu trả đủ vẫn khác tổng các dòng.
--   Chủ chốt 25/10/2026:
--   · 4 cột = ĐÚNG số trên hoá đơn; giảm trừ / nợ cũ ghi riêng dưới dòng; làm tròn bỏ qua (không hiện ở dòng —
--     chỉ có một dòng nhỏ ở "Theo hạng mục" để tổng hạng mục khớp doanh thu);
--   · phiếu thu một phần (trả hai lần / trả thiếu) ⇒ CHIA THEO TỶ LỆ so với phần doanh thu của hoá đơn;
--   · dòng hoá đơn không phải phòng/điện/nước/phí dịch vụ (chìa khoá, rác, phạt…) ⇒ cột PDV gộp, khối hạng mục
--     tách riêng "Thu khác".
--
-- LÀM GÌ (mọi hàm public mới: search_path rỗng, chỉ authenticated EXECUTE; INVOKER ⇒ đọc theo RLS người gọi)
--   1. public.invoice_item_column_v1(loại, tên dịch vụ, mô tả) — THUẦN, xếp một dòng hoá đơn vào cột:
--        RENT ⇒ RENT; SERVICE có chữ "điện" ⇒ ELECTRIC, "nước" ⇒ WATER, còn lại ⇒ SERVICE; loại khác (OTHER,
--        PENALTY…) ⇒ OTHER. Xét TÊN DỊCH VỤ trước (dòng có dịch vụ thì chỉ theo tên — mô tả "đồng hồ điện tử" của
--        dòng nước không thành điện); dòng không gắn dịch vụ mới xét mô tả. So không dấu (public.nrm_vn);
--        services.type không phân biệt điện/nước (dịch vụ điện giá cố định cũng là FIXED).
--   2. public.invoice_amount_split_v1(số tiền, tổng hoá đơn, dòng không phải doanh thu, giảm trừ, nợ cũ, phòng,
--        điện, nước, PDV, khác) — THUẦN. Phần doanh thu phải thu = tổng hoá đơn − dòng không phải doanh thu
--        (cọc, NON_PNL — thu ở dòng phiếu khác). Số tiền phiếu bằng phần đó (lệch dưới 1 đồng vẫn tính là bằng)
--        ⇒ các cột lấy nguyên số trên hoá đơn, discount = −giảm trừ, debt = nợ cũ, rounding = phần làm tròn.
--        Khác ⇒ mọi phần nhân cùng tỷ lệ (làm tròn tới đồng), phần lẻ dồn vào rounding; partial = true. Cộng
--        mọi phần luôn đúng bằng số tiền phiếu. Phần doanh thu ≤ 0, không có dòng doanh thu dương, hoặc tổng hoá
--        đơn không dựng lại được từ các cột − giảm trừ + nợ cũ (lệch ≥ 1.000đ, vd hoá đơn thanh lý) ⇒ NULL.
--   3. public.invoice_amount_parts_for_v1(hoá đơn, số tiền) — INVOKER, đường DUY NHẤT gom dòng hoá đơn (bỏ dòng
--        DISCOUNT) rồi gọi mục 2. Gói quyết toán và RPC Báo cáo LN cùng gọi.
--   4. public.income_voucher_splittable_v1(phiếu) — INVOKER, điều kiện DUY NHẤT để tách một phiếu: phiếu thu có
--        hoá đơn, tính KQKD, không hạn chế (link chủ nhà không lộ hoá đơn), không do thanh lý sinh (system_source
--        termination.*), dòng lãi lỗ thuộc đúng MỘT hạng mục.
--   5. public.invoice_amount_parts_v1(p_rows jsonb) — RPC MỚI cho Báo cáo LN: INVOKER + RLS, từ chối khi
--        current_user ≠ authenticated. Nhận ≤ 3000 dòng [{key, invoice_id, amount, voucher_ids (≤ 200)}] (một dòng
--        báo cáo có thể gộp nhiều phiếu cùng hoá đơn) — chỉ tách khi MỌI phiếu thuộc đúng hoá đơn đó và qua mục 4; trả [{key, rent,
--        electric, water, service, other, discount, debt, rounding, invoice_amount, partial}].
--   6. app_private.landlord_settlement_compute_v1 (DỰNG TỪ THÂN production md5 4aeced8e…, file
--      20261023142407) — thêm, CHỈ ĐỂ HIỂN THỊ (không vào chuỗi băm, không đổi tổng nào):
--      · mỗi phiếu thu lãi lỗ qua mục 4 có parts = phần KỲ tháng này của phiếu chia theo hoá đơn (mục 3);
--      · categories.income: phiếu đã tách thay dòng hạng mục của nó bằng "Tiền phòng", "Tiền điện", "Tiền
--        nước", "Phí dịch vụ", "Thu khác", "Giảm trừ hoá đơn", "Nợ cũ", "Làm tròn hoá đơn" (tên trùng hạng mục
--        có sẵn thì gộp chung).
--      landlord_strip_public_v1 KHÔNG đổi: phiếu hạn chế không bao giờ có parts (mục 4).
--   Ảnh chốt cũ không có parts ⇒ web hiện kiểu cũ (danh sách). Tháng đã chốt không đổi chuỗi băm.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE app_private.landlord_settlement_compute_v1 bằng thân của 20261023142407; DROP FUNCTION
--   public.invoice_amount_parts_v1(jsonb), public.invoice_amount_parts_for_v1(uuid, numeric),
--   public.income_voucher_splittable_v1(uuid), public.invoice_amount_split_v1(numeric, numeric, numeric, numeric,
--   numeric, numeric, numeric, numeric, numeric, numeric), public.invoice_item_column_v1(text, text, text).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill (không đòi dữ liệu).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Thân đang chạy phải đúng bản đã rà (hoặc đã là bản của file này — lượt hai).
DO $truoc$
DECLARE
  v_sig  text;
  v_md5  text;
  v_ghim text[];
BEGIN
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('app_private.landlord_settlement_compute_v1(uuid,date)',
       ARRAY['4aeced8e78010313db6de24f910b88cd', 'f3e5e427f0a7eca206950b5f20e681ad']),
      -- hàm KHÔNG thay — compute gọi / link chủ nhà dựa vào; đổi thì rà lại trước khi áp
      ('public.nrm_vn(text)',
       ARRAY['01e25fe96aaac1f69d03feadb155c2fd']),
      ('app_private.landlord_strip_public_v1(jsonb)',
       ARRAY['5ba02b4cd662bfdbf24b1e688de4f519'])
    ) AS x(sig, ghim)
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
    v_md5 := md5(pg_get_functiondef(v_sig::regprocedure));
    IF v_md5 <> ALL (v_ghim) THEN
      RAISE EXCEPTION '% KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.', v_sig, v_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  -- hàm mới: lượt hai phải đúng bản của file này
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('public.invoice_item_column_v1(text,text,text)', ARRAY['05ea03aaab1bd1b9da1a32d6c7b93b40']),
      ('public.invoice_amount_split_v1(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)', ARRAY['3cf044d71f29b83be69aef5d6a6459c3']),
      ('public.invoice_amount_parts_for_v1(uuid,numeric)', ARRAY['1b9df4d01a87ad96fa35d2cd9ee1f249']),
      ('public.income_voucher_splittable_v1(uuid)', ARRAY['21cfad2d7e6d07cd371860a68e8618b8']),
      ('public.invoice_amount_parts_v1(jsonb)', ARRAY['c1b0c04c38b95727dca410443bf4a7d1'])
    ) AS x(sig, ghim)
  LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      v_md5 := md5(pg_get_functiondef(v_sig::regprocedure));
      IF v_md5 <> ALL (v_ghim) THEN
        RAISE EXCEPTION '% KHÁC bản của file này (md5 %) — DỪNG.', v_sig, v_md5 USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Cột của một dòng hoá đơn. So KHÔNG DẤU (nrm_vn bỏ dấu + chữ thường ASCII); 'Đ' giữ trong mẫu vì lower()
--    chỉ chắc với chữ ASCII ở mọi locale. Ranh giới chữ để "điện" không khớp giữa một từ khác.
CREATE OR REPLACE FUNCTION public.invoice_item_column_v1(p_type text, p_service_name text, p_description text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO ''
AS $fn$
  SELECT CASE
    WHEN p_type = 'RENT' THEN 'RENT'
    WHEN p_type <> 'SERVICE' OR p_type IS NULL THEN 'OTHER'
    WHEN x.ten ~ '(^|[^a-z])[dĐ]ien([^a-z]|$)' THEN 'ELECTRIC'
    WHEN x.ten ~ '(^|[^a-z])nuoc([^a-z]|$)' THEN 'WATER'
    ELSE 'SERVICE'
  END
    FROM (SELECT public.nrm_vn(COALESCE(NULLIF(pg_catalog.btrim(p_service_name), ''), p_description)) AS ten) x;
$fn$;

COMMENT ON FUNCTION public.invoice_item_column_v1(text, text, text) IS
  'Cột của một dòng hoá đơn khi tách tiền phiếu thu: RENT | ELECTRIC | WATER | SERVICE | OTHER. Xét tên dịch vụ trước, không có dịch vụ mới xét mô tả. Chủ chốt 25/10/2026.';

REVOKE ALL ON FUNCTION public.invoice_item_column_v1(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_item_column_v1(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Chia số tiền phiếu theo hoá đơn (chủ chốt 25/10/2026). Cộng mọi phần luôn đúng bằng p_amount.
CREATE OR REPLACE FUNCTION public.invoice_amount_split_v1(
  p_amount        numeric,
  p_invoice_total numeric,
  p_non_revenue   numeric,
  p_discount      numeric,
  p_debt          numeric,
  p_rent          numeric,
  p_electric      numeric,
  p_water         numeric,
  p_service       numeric,
  p_other         numeric
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO ''
AS $fn$
  WITH b AS (
    SELECT COALESCE(p_rent, 0) AS r, COALESCE(p_electric, 0) AS e, COALESCE(p_water, 0) AS w,
           COALESCE(p_service, 0) AS s, COALESCE(p_other, 0) AS o,
           -COALESCE(p_discount, 0) AS d, COALESCE(p_debt, 0) AS n,
           -- phần DOANH THU phải thu của hoá đơn (cọc / NON_PNL thu ở dòng phiếu khác)
           COALESCE(p_invoice_total, 0) - COALESCE(p_non_revenue, 0) AS phai_thu
  ),
  t AS (
    -- lệch dưới 1 đồng (số lẻ khi cộng phân bổ kỳ) vẫn là trả đủ
    SELECT b.*, pg_catalog.abs(p_amount - b.phai_thu) < 1 AS du
      FROM b
     WHERE p_amount IS NOT NULL AND b.phai_thu > 0 AND b.r + b.e + b.w + b.s + b.o > 0
       -- tổng hoá đơn phải dựng lại được từ các cột − giảm trừ + nợ cũ (chỉ lệch phần làm tròn tới nghìn); lệch
       -- hơn (vd hoá đơn thanh lý có khoản trừ không nằm trong giảm trừ) ⇒ không tách, kẻo "làm tròn" (không hiện
       -- ở dòng) nuốt cả khoản lớn
       AND pg_catalog.abs(b.phai_thu - (b.r + b.e + b.w + b.s + b.o + b.d + b.n)) < 1000
  ),
  -- trả đủ phần doanh thu ⇒ lấy nguyên số trên hoá đơn; khác ⇒ mọi phần nhân cùng tỷ lệ
  c AS (
    SELECT t.du, t.phai_thu,
           CASE WHEN t.du THEN t.r ELSE pg_catalog.round(p_amount * t.r / NULLIF(t.phai_thu, 0)) END AS r,
           CASE WHEN t.du THEN t.e ELSE pg_catalog.round(p_amount * t.e / NULLIF(t.phai_thu, 0)) END AS e,
           CASE WHEN t.du THEN t.w ELSE pg_catalog.round(p_amount * t.w / NULLIF(t.phai_thu, 0)) END AS w,
           CASE WHEN t.du THEN t.s ELSE pg_catalog.round(p_amount * t.s / NULLIF(t.phai_thu, 0)) END AS s,
           CASE WHEN t.du THEN t.o ELSE pg_catalog.round(p_amount * t.o / NULLIF(t.phai_thu, 0)) END AS o,
           CASE WHEN t.du THEN t.d ELSE pg_catalog.round(p_amount * t.d / NULLIF(t.phai_thu, 0)) END AS d,
           CASE WHEN t.du THEN t.n ELSE pg_catalog.round(p_amount * t.n / NULLIF(t.phai_thu, 0)) END AS n
      FROM t
  )
  SELECT pg_catalog.jsonb_build_object(
           'rent', c.r, 'electric', c.e, 'water', c.w, 'service', c.s, 'other', c.o,
           'discount', c.d, 'debt', c.n,
           -- làm tròn của hoá đơn (+ phần lẻ khi chia tỷ lệ): phần còn lại để cộng đúng số tiền phiếu
           'rounding', p_amount - c.r - c.e - c.w - c.s - c.o - c.d - c.n,
           'invoice_amount', c.phai_thu,
           'partial', NOT c.du)
    FROM c;
$fn$;

COMMENT ON FUNCTION public.invoice_amount_split_v1(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) IS
  'Chia số tiền phiếu thu theo hoá đơn: cột phòng / điện / nước / PDV / khác đúng số trên hoá đơn + giảm trừ, nợ cũ, làm tròn; thu khác phần doanh thu của hoá đơn ⇒ nhân cùng tỷ lệ. Chủ chốt 25/10/2026.';

REVOKE ALL ON FUNCTION public.invoice_amount_split_v1(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_amount_split_v1(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tách một số tiền theo MỘT hoá đơn — đường duy nhất gom dòng hoá đơn (gói quyết toán + RPC Báo cáo LN).
--    INVOKER: người gọi chỉ thấy hoá đơn / dòng / dịch vụ RLS cho phép; hàm DEFINER gọi thì đọc như owner.
CREATE OR REPLACE FUNCTION public.invoice_amount_parts_for_v1(p_invoice_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
  SELECT public.invoice_amount_split_v1(p_amount, inv.total_amount,
           sum(d.tien) FILTER (WHERE d.cot IS NULL), inv.discount_amount, inv.previous_debt,
           sum(d.tien) FILTER (WHERE d.cot = 'RENT'),
           sum(d.tien) FILTER (WHERE d.cot = 'ELECTRIC'),
           sum(d.tien) FILTER (WHERE d.cot = 'WATER'),
           sum(d.tien) FILTER (WHERE d.cot = 'SERVICE'),
           sum(d.tien) FILTER (WHERE d.cot = 'OTHER'))
    FROM public.invoices inv
    LEFT JOIN LATERAL (
      -- cot NULL = dòng không phải doanh thu (cọc, NON_PNL). Dòng DISCOUNT chỉ là chi tiết của discount_amount
      -- (không nằm trong subtotal) ⇒ bỏ, kẻo trừ giảm trừ hai lần.
      SELECT CASE WHEN ii.accounting_class = 'REVENUE'
                  THEN public.invoice_item_column_v1(ii.type::text, s.name, ii.description)
             END AS cot,
             COALESCE(ii.amount, 0) AS tien
        FROM public.invoice_items ii
        LEFT JOIN public.services s ON s.id = ii.service_id
       WHERE ii.invoice_id = inv.id
         AND ii.type::text <> 'DISCOUNT'
    ) d ON true
   WHERE inv.id = p_invoice_id
     AND inv.deleted_at IS NULL
   GROUP BY inv.id, inv.total_amount, inv.discount_amount, inv.previous_debt;
$fn$;

COMMENT ON FUNCTION public.invoice_amount_parts_for_v1(uuid, numeric) IS
  'Tách một số tiền thu theo một hoá đơn (gom dòng hoá đơn + invoice_amount_split_v1). INVOKER. Chủ chốt 25/10/2026.';

REVOKE ALL ON FUNCTION public.invoice_amount_parts_for_v1(uuid, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_amount_parts_for_v1(uuid, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Điều kiện tách một phiếu (đường duy nhất). Dòng lãi lỗ = cùng vị ngữ KQKD với landlord_kqkd_lines_v2 (phiếu
--    ép tính KQKD thì mọi dòng; không thì dòng PNL). Phiếu không thấy được (RLS) ⇒ NULL ⇒ không tách.
CREATE OR REPLACE FUNCTION public.income_voucher_splittable_v1(p_voucher_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
  SELECT v.type::text = 'INCOME'
     AND v.invoice_id IS NOT NULL
     AND v.business_result_accounting IS DISTINCT FROM false
     AND NOT COALESCE(v.has_restricted_item, false)
     AND COALESCE(v.system_source, '') NOT LIKE 'termination.%'
     AND (SELECT count(DISTINCT i.income_expense_type_id)
            FROM public.income_expense_items i
           WHERE i.income_expense_id = v.id
             AND (v.business_result_accounting IS TRUE OR i.accounting_class = 'PNL')) = 1
    FROM public.income_expenses v
   WHERE v.id = p_voucher_id
     AND v.deleted_at IS NULL;
$fn$;

COMMENT ON FUNCTION public.income_voucher_splittable_v1(uuid) IS
  'Phiếu thu có được tách theo hoá đơn không: có hoá đơn, không hạn chế, không do thanh lý sinh, dòng lãi lỗ đúng một hạng mục. INVOKER. Chủ chốt 25/10/2026.';

REVOKE ALL ON FUNCTION public.income_voucher_splittable_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.income_voucher_splittable_v1(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC cho Báo cáo LN: INVOKER + RLS — hoá đơn / phiếu người gọi không đọc được ⇒ không có dòng trả về (web
--    hiện kiểu cũ). Nhận tối đa 3000 dòng mỗi lần gọi.
CREATE OR REPLACE FUNCTION public.invoice_amount_parts_v1(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_amount_parts_denied' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) > 3000
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(v)
                 WHERE pg_catalog.jsonb_typeof(e.v->'voucher_ids') IS DISTINCT FROM 'array'
                    OR pg_catalog.jsonb_array_length(e.v->'voucher_ids') > 200) THEN
    RAISE EXCEPTION 'invoice_amount_parts_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', r.k) || x.phan ORDER BY r.ord)
      FROM (
        SELECT e.ord, e.v->>'key' AS k, (e.v->>'invoice_id')::uuid AS hoa_don, (e.v->>'amount')::numeric AS so_tien,
               ARRAY(SELECT p.id::uuid FROM pg_catalog.jsonb_array_elements_text(e.v->'voucher_ids') AS p(id)) AS phieu
          FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY AS e(v, ord)
      ) r
      CROSS JOIN LATERAL (SELECT public.invoice_amount_parts_for_v1(r.hoa_don, r.so_tien) AS phan) x
     WHERE x.phan IS NOT NULL
       AND pg_catalog.cardinality(r.phieu) > 0
       -- mọi phiếu của dòng thuộc đúng hoá đơn này và qua điều kiện tách (như gói quyết toán)
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.unnest(r.phieu) AS p(id)
          WHERE NOT COALESCE(public.income_voucher_splittable_v1(p.id), false)
             OR NOT EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.id = p.id AND v.invoice_id = r.hoa_don))
  ), '[]'::jsonb);
END
$fn$;

COMMENT ON FUNCTION public.invoice_amount_parts_v1(jsonb) IS
  'Báo cáo LN: tách số tiền thu theo hoá đơn. [{key, invoice_id, amount, voucher_ids}] ⇒ [{key, rent, electric, water, service, other, discount, debt, rounding, invoice_amount, partial}]. INVOKER + RLS. Chủ chốt 25/10/2026.';

REVOKE ALL ON FUNCTION public.invoice_amount_parts_v1(jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_amount_parts_v1(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. CÔNG THỨC — thân production (20261023142407, md5 4aeced8e…) + tách tiền phiếu thu theo hoá đơn (chỉ
--    hiển thị). Không kiểm quyền: chỉ các hàm SECURITY DEFINER gọi.
CREATE OR REPLACE FUNCTION app_private.landlord_settlement_compute_v1(
  p_building_id uuid,
  p_month       date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH cfg AS (
    -- điều khoản (% + tiền cố định + sổ chủ nhà) đang áp ở tháng này; người giữ cọc là cài đặt của toà
    SELECT o.building_id, o.organization_id, o.effective_from,
           t.valid_from AS terms_from, t.manager_percent, t.manager_fixed_amount, t.landlord_account_ids,
           o.deposit_holder
      FROM app_private.landlord_operations o
      JOIN LATERAL (
        SELECT t.valid_from, t.manager_percent, t.manager_fixed_amount, t.landlord_account_ids
          FROM app_private.landlord_operation_terms t
         WHERE t.building_id = o.building_id
           AND t.valid_from <= pg_catalog.date_trunc('month', p_month)::date
         ORDER BY t.valid_from DESC
         LIMIT 1) t ON true
     WHERE o.building_id = p_building_id
  ),
  -- sổ chủ nhà (MỌI phiên bản điều khoản) của TOÀ VẬN HÀNH KHÁC cùng công ty chưa xoá (kể cả đang ngừng
  -- áp dụng — sổ đó vẫn là tiền của chủ nhà kia):
  -- phiếu toà này dùng sổ đó thì không biết là chủ nhà hay quản lý giữ tiền ⇒ chặn chốt cho tới khi xử lý
  so_toa_khac AS (
    SELECT DISTINCT x.account_id
      FROM cfg
      JOIN app_private.landlord_operations o2
        ON o2.organization_id = cfg.organization_id AND o2.building_id <> cfg.building_id
      JOIN public.buildings b2 ON b2.id = o2.building_id AND b2.deleted_at IS NULL
      JOIN app_private.landlord_operation_terms t2 ON t2.building_id = o2.building_id
      CROSS JOIN LATERAL pg_catalog.unnest(t2.landlord_account_ids) AS x(account_id)
  ),
  ky AS (
    SELECT pg_catalog.date_trunc('month', p_month)::date AS dau,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date AS sau
  ),
  -- phiếu có NGÀY PHIẾU trong tháng: nguồn của dòng cọc / không tính và tiền thối (dòng tiền thật,
  -- không phải lãi lỗ ⇒ theo ngày tiền đi)
  ngay AS (
    SELECT v.id, v.type::text AS loai, v.business_result_accounting AS kqkd, v.total_amount,
           v.approval_status::text AS approval_status, v.change_account_id, v.change_amount
      FROM cfg
      CROSS JOIN ky
      JOIN public.income_expenses v
        ON v.building_id = cfg.building_id
       AND v.deleted_at IS NULL
       AND v.voucher_date >= ky.dau
       AND v.voucher_date < ky.sau
       AND v.approval_status::text IN ('APPROVED', 'UNAPPROVED')
  ),
  -- dòng lãi lỗ theo kỳ kèm hạng mục (v2 = v1 + type_id; cùng số tiền từng dòng)
  lai_lo AS (
    SELECT l.voucher_id, l.approval_status, l.amount, l.type_id
      FROM app_private.landlord_kqkd_lines_v2(p_building_id, p_month, p_month) AS l
  ),
  dong AS (
    -- MỌI dòng của phiếu đều vào đúng MỘT nhóm — không dòng nào rơi mất im lặng:
    --   KQKD  dòng lãi lỗ, xếp tháng THEO KỲ đúng luật fa_accrual_allocations (khớp Báo cáo LN);
    --   COC   cọc / tiền khách trả thừa — tiền giữ hộ khách, bên giữ cọc chịu trách nhiệm hoàn (theo ngày phiếu);
    --   KHAC  không tính (nội bộ, phiếu tắt KQKD, dòng không có hạng mục…) — vẫn liệt kê (theo ngày phiếu).
    SELECT l.voucher_id AS id, 'KQKD'::text AS nhom, NULL::text AS ly_do, l.amount AS so_tien
      FROM lai_lo AS l
    UNION ALL
    -- phần bù của vị ngữ KQKD canonical: dòng phiếu tắt KQKD, hoặc dòng không phải PNL khi phiếu không ép
    SELECT n.id,
           CASE WHEN i.accounting_class IN ('DEPOSIT', 'CUSTOMER_CREDIT') THEN 'COC' ELSE 'KHAC' END::text,
           CASE WHEN i.accounting_class IN ('DEPOSIT', 'CUSTOMER_CREDIT') THEN NULL
                WHEN n.kqkd IS FALSE THEN 'NOT_KQKD' ELSE 'INTERNAL' END::text,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric
      FROM ngay n
      JOIN public.income_expense_items i ON i.income_expense_id = n.id
     WHERE NOT (n.kqkd IS DISTINCT FROM false AND (n.kqkd IS TRUE OR COALESCE(i.accounting_class, '') = 'PNL'))
    UNION ALL
    -- dòng đúng vị ngữ KQKD nhưng hạng mục không tồn tại: canonical bỏ (không vào lợi nhuận) ⇒ hiện ở
    -- "không tính" để thấy được, không biến mất
    SELECT n.id, 'KHAC'::text, 'NO_CATEGORY'::text, COALESCE(i.amount, i.unit_price * i.quantity)::numeric
      FROM ngay n
      JOIN public.income_expense_items i ON i.income_expense_id = n.id
     WHERE n.kqkd IS DISTINCT FROM false AND (n.kqkd IS TRUE OR i.accounting_class = 'PNL')
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_types t WHERE t.id = i.income_expense_type_id)
    UNION ALL
    -- phiếu tắt KQKD không có dòng hạng mục: lấy cả phiếu (phiếu KQKD không dòng đã nằm trong KQKD)
    SELECT n.id, 'KHAC'::text, 'NOT_KQKD'::text, COALESCE(n.total_amount, 0)::numeric
      FROM ngay n
     WHERE n.kqkd IS FALSE
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = n.id)
  ),
  gop AS (
    SELECT d.id, d.nhom, max(d.ly_do) AS ly_do, sum(d.so_tien) AS so_tien
      FROM dong d
     GROUP BY d.id, d.nhom
  ),
  phieu AS (
    SELECT v.id, v.code, v.voucher_date, v.type::text AS loai, v.name,
           v.account_id, a.name AS so_quy, v.approval_status::text AS approval_status,
           v.business_result_accounting AS kqkd, v.total_amount,
           COALESCE(v.system_source, '') AS nguon,
           COALESCE(v.posting_status, '') AS but_toan,
           COALESCE(v.has_restricted_item, false) AS han_che,
           COALESCE(v.account_id = ANY (cfg.landlord_account_ids), false) AS ben_chu_nha,
           (NOT COALESCE(v.account_id = ANY (cfg.landlord_account_ids), false)
            AND EXISTS (SELECT 1 FROM so_toa_khac s WHERE s.account_id = v.account_id)) AS so_toa_khac,
           v.invoice_id, v.room_id
      FROM (SELECT DISTINCT g.id FROM gop g) x
      CROSS JOIN cfg
      JOIN public.income_expenses v ON v.id = x.id
      LEFT JOIN public.accounts a ON a.id = v.account_id
  ),
  ct AS (
    SELECT p.id, p.code, p.voucher_date, p.loai, p.name, p.account_id, p.so_quy,
           p.approval_status, p.ben_chu_nha, p.nguon, p.kqkd, p.but_toan, p.han_che, p.so_toa_khac,
           p.invoice_id, p.room_id,
           g.nhom, g.ly_do, g.so_tien,
           -- dòng cọc / trả thừa nằm ở bên sổ CÓ TÍNH vào số bàn giao: quản lý giữ cọc ⇒ sổ chủ nhà
           -- (chủ nhà bàn giao); chủ nhà giữ cọc ⇒ sổ quản lý (quản lý bàn giao)
           (g.nhom = 'COC' AND p.ben_chu_nha = (cfg.deposit_holder = 'MANAGER')) AS coc_tinh
      FROM phieu p
      JOIN gop g ON g.id = p.id
      CROSS JOIN cfg
     WHERE g.so_tien <> 0
  ),
  -- hạng mục của dòng lãi lỗ (chỉ để hiển thị — không vào chuỗi băm). Phiếu không có dòng hạng mục ⇒ "Khác".
  lai_lo_hang_muc AS (
    SELECT l.voucher_id AS id, l.approval_status, l.amount,
           COALESCE(t.name, 'Khác') AS ten,
           COALESCE(t.is_restricted, false) AS han_che
      FROM lai_lo l
      LEFT JOIN public.income_expense_types t ON t.id = l.type_id
  ),
  -- TÁCH TIỀN PHIẾU THU THEO HOÁ ĐƠN (chủ chốt 25/10/2026; chỉ hiển thị — không vào chuỗi băm, không đổi tổng):
  -- phần KỲ tháng này của phiếu chia theo hoá đơn — điều kiện tách và phép tách là hai hàm dùng chung với Báo cáo
  -- LN (income_voucher_splittable_v1, invoice_amount_parts_for_v1).
  tach AS (
    SELECT x.id, x.approval_status, x.phan
      FROM (
        SELECT ct.id, ct.approval_status, public.invoice_amount_parts_for_v1(ct.invoice_id, ct.so_tien) AS phan
          FROM ct
         WHERE ct.nhom = 'KQKD'
           AND ct.invoice_id IS NOT NULL
           AND public.income_voucher_splittable_v1(ct.id)
      ) x
     WHERE x.phan IS NOT NULL
  ),
  -- hạng mục để HIỂN THỊ: phiếu đã tách thay dòng hạng mục của nó bằng các cột của hoá đơn
  hang_muc_hien AS (
    SELECT h.id, h.approval_status, h.amount, h.ten, h.han_che
      FROM lai_lo_hang_muc h
     WHERE NOT EXISTS (SELECT 1 FROM tach t WHERE t.id = h.id)
    UNION ALL
    SELECT t.id, t.approval_status, c.so_tien, c.ten, false
      FROM tach t
      CROSS JOIN LATERAL (VALUES
        ('Tiền phòng',  (t.phan->>'rent')::numeric),
        ('Tiền điện',   (t.phan->>'electric')::numeric),
        ('Tiền nước',   (t.phan->>'water')::numeric),
        ('Phí dịch vụ', (t.phan->>'service')::numeric),
        ('Thu khác',    (t.phan->>'other')::numeric),
        ('Giảm trừ hoá đơn', (t.phan->>'discount')::numeric),
        ('Nợ cũ',            (t.phan->>'debt')::numeric),
        ('Làm tròn hoá đơn', (t.phan->>'rounding')::numeric)) AS c(ten, so_tien)
     WHERE c.so_tien <> 0
  ),
  hang_muc AS (
    SELECT p.loai, h.ten, h.han_che,
           sum(h.amount) AS tong,
           COALESCE(sum(h.amount) FILTER (WHERE p.ben_chu_nha), 0) AS chu_nha,
           COALESCE(sum(h.amount) FILTER (WHERE NOT p.ben_chu_nha), 0) AS quan_ly
      FROM hang_muc_hien h
      JOIN phieu p ON p.id = h.id
     WHERE h.approval_status = 'APPROVED'
     GROUP BY p.loai, h.ten, h.han_che
  ),
  -- TÊN HIỂN THỊ (chủ nhắn 23/10/2026: đừng ghi "Thu tiền theo HĐ INV-…", ghi rõ tiền phòng kỳ nào; thanh lý /
  -- bỏ cọc đừng ghi mã). Web dựng tên bằng src/lib/voucherDisplayName.ts — cùng một đường với Thu chi và Báo
  -- cáo LN; link chủ nhà chạy bằng anon nên không đọc được bảng invoices ⇒ trả các PHẦN dựng tên ở đây.
  -- KHÔNG trả notes. Ba cờ CHÉP LUẬT src/lib/invoiceUtils.ts (invoiceTitlePartsOf / isFirstMonthInvoice):
  --   is_liquidation  kind = 'SETTLEMENT' hoặc notes có "thanh lý";
  --   is_extra        notes MỞ ĐẦU "hoá đơn thu thêm";
  --   is_first_month  notes có "tháng đầu" / "đầu tiên", hoặc dòng RENT có kỳ sớm nhất bắt đầu đúng
  --                   contracts.start_billing_date.
  -- Regex viết cả chữ hoa có dấu ([áÁ]…) vì lower() chỉ chắc với chữ ASCII ở mọi locale. Test PGlite so từng
  -- cờ với hàm TS — sửa luật một bên mà quên bên kia thì test đỏ.
  hien_thi AS (
    SELECT x.id,
           COALESCE(vr.name, ir.name) AS ten_phong,
           CASE WHEN inv.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
             'kind', inv.kind,
             'billing_month', inv.billing_month,
             'issue_date', inv.issue_date,
             'has_rent', EXISTS (SELECT 1 FROM public.invoice_items ii
                                  WHERE ii.invoice_id = inv.id AND ii.type::text = 'RENT'),
             'has_service', EXISTS (SELECT 1 FROM public.invoice_items ii
                                     WHERE ii.invoice_id = inv.id AND ii.type::text IN ('SERVICE', 'PENALTY')),
             'is_first_month',
               pg_catalog.lower(COALESCE(inv.notes, '')) ~ 'th[aáÁ]ng[\s_]?[đĐ][ầẦ]u|[đĐ][ầẦ]u\s*ti[êÊ]n'
               OR COALESCE((SELECT min(ii.from_date) FROM public.invoice_items ii
                             WHERE ii.invoice_id = inv.id AND ii.type::text = 'RENT' AND ii.from_date IS NOT NULL)
                           = c.start_billing_date, false),
             'is_liquidation',
               COALESCE(inv.kind = 'SETTLEMENT', false)
               OR pg_catalog.lower(COALESCE(inv.notes, '')) ~ 'thanh\s*l[ýÝ]',
             'is_extra',
               pg_catalog.lower(COALESCE(inv.notes, '')) ~ '^\s*ho[áÁ]\s*[đĐ][ơƠ]n\s*thu\s*th[êÊ]m')
           END AS hoa_don
      FROM (SELECT DISTINCT ct.id, ct.invoice_id, ct.room_id FROM ct) x
      LEFT JOIN public.rooms vr ON vr.id = x.room_id
      LEFT JOIN public.invoices inv ON inv.id = x.invoice_id AND inv.deleted_at IS NULL
      LEFT JOIN public.rooms ir ON ir.id = inv.room_id
      LEFT JOIN public.contracts c ON c.id = inv.contract_id
  ),
  -- phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo (tiền KHÔNG còn ở sổ nào) hoặc chưa ghi sổ
  -- (UNPOSTED: tiền chưa thực vào/ra) ⇒ chặn chốt
  dao AS (
    SELECT count(DISTINCT ct.id) FILTER (WHERE ct.but_toan = 'REVERSED') AS so_phieu_dao,
           count(DISTINCT ct.id) FILTER (WHERE ct.but_toan = 'UNPOSTED') AS so_phieu_chua_ghi
      FROM ct
     WHERE ct.approval_status = 'APPROVED' AND ct.nhom IN ('KQKD', 'COC')
  ),
  du AS (
    -- tiền thối rơi vào sổ chủ nhà (theo ngày phiếu): tiền của khách, chủ nhà giữ hộ. Làm tròn KHÔNG
    -- tính — đó là phần khách trả thiếu được bỏ qua, không phải tiền mặt.
    SELECT COALESCE(sum(CASE WHEN n.change_account_id = ANY (cfg.landlord_account_ids)
                             THEN COALESCE(n.change_amount, 0) ELSE 0 END
                        * CASE WHEN n.loai = 'EXPENSE' THEN -1 ELSE 1 END)
                    FILTER (WHERE n.approval_status = 'APPROVED'), 0) AS du_chu_nha
      FROM ngay n
      CROSS JOIN cfg
  ),
  so AS (
    SELECT
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND ben_chu_nha), 0)     AS chu_nha_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND NOT ben_chu_nha), 0) AS quan_ly_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND ben_chu_nha), 0)     AS chu_nha_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND NOT ben_chu_nha), 0) AS quan_ly_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'), 0)  AS coc_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE'), 0) AS coc_chi,
      -- cọc/tiền trả thừa đi qua SỔ CHỦ NHÀ: chủ nhà đang giữ hộ khoản quản lý phải hoàn cho khách
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND ben_chu_nha), 0) AS coc_chu_nha_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND ben_chu_nha), 0) AS coc_chu_nha_chi,
      -- cọc/tiền trả thừa đi qua SỔ QUẢN LÝ: chủ nhà giữ cọc thì quản lý bàn giao phần này cho chủ nhà
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND NOT ben_chu_nha), 0) AS coc_quan_ly_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND NOT ben_chu_nha), 0) AS coc_quan_ly_chi,
      -- thanh lý hợp đồng, tách theo nguồn phiếu hệ thống sinh
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.revenue'), 0)         AS tl_doanh_thu_tu_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.forfeit_revenue'), 0) AS tl_doanh_thu_bo_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.extra_receipt'), 0)   AS tl_khach_tra_them,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_tra_them_ngoai_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_hoan_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon IN ('termination.offset', 'termination.forfeit_offset')), 0) AS tl_can_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND nguon = 'termination.refund'), 0)        AS tl_cho_duyet,
      -- phiếu chờ duyệt chặn chốt: lãi lỗ + cọc ở bên sổ có tính vào số bàn giao (quản lý giữ cọc: sổ chủ
      -- nhà — đúng luật cũ; chủ nhà giữ cọc: sổ quản lý)
      count(DISTINCT id) FILTER (WHERE approval_status = 'UNAPPROVED'
                                   AND (nhom = 'KQKD' OR coc_tinh)) AS cho_duyet_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'INCOME'), 0)  AS cho_duyet_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'EXPENSE'), 0) AS cho_duyet_chi,
      COALESCE(sum(CASE WHEN loai = 'EXPENSE' THEN -so_tien ELSE so_tien END)
                 FILTER (WHERE nhom = 'COC' AND approval_status = 'UNAPPROVED' AND ben_chu_nha), 0) AS cho_duyet_coc_chu_nha,
      COALESCE(sum(CASE WHEN loai = 'EXPENSE' THEN -so_tien ELSE so_tien END)
                 FILTER (WHERE coc_tinh AND approval_status = 'UNAPPROVED'), 0) AS cho_duyet_coc_tinh,
      count(DISTINCT id) FILTER (WHERE so_toa_khac AND nhom IN ('KQKD', 'COC')) AS so_phieu_so_khac,
      count(DISTINCT id) FILTER (WHERE nhom = 'KHAC') AS khac_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KHAC' AND loai = 'INCOME'), 0)  AS khac_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KHAC' AND loai = 'EXPENSE'), 0) AS khac_chi
      FROM ct
  ),
  kq AS (
    SELECT so.*, du.du_chu_nha, dao.so_phieu_dao, dao.so_phieu_chua_ghi,
           so.chu_nha_thu + so.quan_ly_thu AS doanh_thu,
           so.chu_nha_chi + so.quan_ly_chi AS chi_phi,
           so.chu_nha_thu + so.quan_ly_thu - so.chu_nha_chi - so.quan_ly_chi AS loi_nhuan,
           cfg.manager_percent, cfg.manager_fixed_amount, cfg.terms_from, cfg.deposit_holder,
           -- phần cọc vào số bàn giao (có dấu): quản lý giữ cọc ⇒ + cọc ở sổ chủ nhà (chủ nhà bàn giao cho
           -- quản lý); chủ nhà giữ cọc ⇒ − cọc ở sổ quản lý (quản lý bàn giao cho chủ nhà)
           CASE WHEN cfg.deposit_holder = 'LANDLORD'
                THEN -(so.coc_quan_ly_thu - so.coc_quan_ly_chi)
                ELSE so.coc_chu_nha_thu - so.coc_chu_nha_chi END AS phan_coc
      FROM so CROSS JOIN cfg CROSS JOIN du CROSS JOIN dao
  ),
  -- phần quản lý = tiền cố định (luôn đủ, kể cả tháng lỗ) + % LN tháng (LN ≤ 0 ⇒ 0)
  hai_phan AS (
    SELECT kq.*,
           kq.manager_fixed_amount AS phan_co_dinh,
           CASE WHEN kq.loi_nhuan > 0
                THEN pg_catalog.round(kq.loi_nhuan * kq.manager_percent / 100)
                ELSE 0::numeric END AS phan_phan_tram
      FROM kq
  ),
  chia AS (
    SELECT hp.*, hp.phan_co_dinh + hp.phan_phan_tram AS phan_quan_ly
      FROM hai_phan hp
  ),
  vet AS (
    SELECT pg_catalog.md5(
             -- chỉ dòng làm đổi số: KQKD, và cọc/trả thừa ở bên sổ có tính (quản lý giữ cọc: sổ chủ nhà — y
             -- như trước 23/10/2026). Cọc ở bên sổ kia và dòng "không tính" đổi (vd duyệt cọc giữ chỗ) không
             -- làm tháng đã chốt hoá cũ.
             COALESCE((SELECT pg_catalog.string_agg(
                         pg_catalog.concat_ws('|', ct.id, ct.approval_status, ct.but_toan, ct.account_id,
                                              ct.loai, ct.nhom, ct.so_tien, ct.voucher_date),
                         ';' ORDER BY ct.id, ct.nhom)
                         FROM ct WHERE ct.nhom = 'KQKD' OR ct.coc_tinh), '')
             || '#' || (SELECT du.du_chu_nha::text FROM du)
             -- phiếu TOÀ KHÁC ghi vào sổ chủ nhà trong tháng: nhập muộn sau khi chốt cũng làm tháng "đã đổi"
             || '#' || pg_catalog.md5(COALESCE(
                  app_private.landlord_account_elsewhere_v1(p_building_id, p_month)::text, ''))
             || '#' ||
             -- điều khoản: tiền cố định / người giữ cọc chỉ vào chuỗi khi khác mặc định ⇒ điều khoản mặc định
             -- băm y như trước (tháng đã chốt từ trước không thành "đổi sau khi chốt")
             (SELECT pg_catalog.concat_ws('|', cfg.manager_percent,
                       pg_catalog.array_to_string(
                         ARRAY(SELECT x FROM pg_catalog.unnest(cfg.landlord_account_ids) AS x ORDER BY x), ','))
                     || CASE WHEN cfg.manager_fixed_amount <> 0
                             THEN '|co_dinh:' || cfg.manager_fixed_amount::text ELSE '' END
                     || CASE WHEN cfg.deposit_holder <> 'MANAGER'
                             THEN '|giu_coc:' || cfg.deposit_holder ELSE '' END
                FROM cfg)
           ) AS source_hash
  )
  SELECT pg_catalog.jsonb_build_object(
           'building_id', p_building_id,
           'period_month', (SELECT dau FROM ky),
           'manager_percent', chia.manager_percent,
           'manager_fixed_amount', chia.manager_fixed_amount,
           'terms_from', chia.terms_from,
           'deposit_holder', chia.deposit_holder,
           'totals', pg_catalog.jsonb_build_object(
              'landlord_collected', chia.chu_nha_thu,
              'manager_collected',  chia.quan_ly_thu,
              'revenue',            chia.doanh_thu,
              'landlord_paid',      chia.chu_nha_chi,
              'manager_paid',       chia.quan_ly_chi,
              'expense',            chia.chi_phi,
              'profit',             chia.loi_nhuan,
              'manager_fixed_share',   chia.phan_co_dinh,
              'manager_percent_share', chia.phan_phan_tram,
              'manager_share',      chia.phan_quan_ly,
              'landlord_share',     chia.loi_nhuan - chia.phan_quan_ly,
              -- mỗi sổ đang giữ bao nhiêu từ thu chi lãi lỗ trong tháng (thu − chi; âm = bên đó ứng tiền chi hộ)
              'landlord_net_held',  chia.chu_nha_thu - chia.chu_nha_chi,
              'manager_net_held',   chia.quan_ly_thu - chia.quan_ly_chi,
              'landlord_held_deposits', chia.coc_chu_nha_thu - chia.coc_chu_nha_chi,
              'manager_held_deposits', chia.coc_quan_ly_thu - chia.coc_quan_ly_chi,
              'deposit_adjustment', chia.phan_coc,
              'landlord_extra_cash', chia.du_chu_nha,
              'landlord_owes_manager', chia.phan_quan_ly + chia.quan_ly_chi - chia.quan_ly_thu
                                       + chia.phan_coc + chia.du_chu_nha),
           'reversed_voucher_count', chia.so_phieu_dao,
           'unposted_voucher_count', chia.so_phieu_chua_ghi,
           'foreign_account_voucher_count', chia.so_phieu_so_khac,
           'deposits', pg_catalog.jsonb_build_object(
              'received', chia.coc_thu,
              'paid_out', chia.coc_chi,
              'landlord_received', chia.coc_chu_nha_thu,
              'landlord_paid_out', chia.coc_chu_nha_chi,
              'manager_received', chia.coc_quan_ly_thu,
              'manager_paid_out', chia.coc_quan_ly_chi),
           'termination', pg_catalog.jsonb_build_object(
              'revenue_from_deposit', chia.tl_doanh_thu_tu_coc,
              'forfeit_revenue', chia.tl_doanh_thu_bo_coc,
              'extra_receipt', chia.tl_khach_tra_them,
              'refund_beyond_deposit', chia.tl_tra_them_ngoai_coc,
              'deposit_refunded', chia.tl_hoan_coc,
              'deposit_offset', chia.tl_can_coc,
              'pending_refund', chia.tl_cho_duyet),
           'pending', pg_catalog.jsonb_build_object(
              'voucher_count', chia.cho_duyet_so_phieu,
              'income', chia.cho_duyet_thu,
              'expense', chia.cho_duyet_chi,
              -- cọc/trả thừa chờ duyệt ở sổ chủ nhà (có dấu: vào dương, ra âm)
              'landlord_deposit', chia.cho_duyet_coc_chu_nha,
              -- cọc/trả thừa chờ duyệt ở bên sổ có tính vào số bàn giao (theo người giữ cọc), có dấu
              'deposit', chia.cho_duyet_coc_tinh),
           'excluded', pg_catalog.jsonb_build_object(
              'voucher_count', chia.khac_so_phieu,
              'income', chia.khac_thu,
              'expense', chia.khac_chi),
           -- thu / chi lãi lỗ ĐÃ DUYỆT theo hạng mục (cộng đúng bằng revenue / expense)
           'categories', pg_catalog.jsonb_build_object(
              'income', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'name', h.ten, 'amount', h.tong, 'landlord_amount', h.chu_nha,
                          'manager_amount', h.quan_ly, 'restricted', h.han_che)
                        ORDER BY h.tong DESC, h.ten)
                   FROM hang_muc h WHERE h.loai = 'INCOME' AND h.tong <> 0), '[]'::jsonb),
              'expense', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'name', h.ten, 'amount', h.tong, 'landlord_amount', h.chu_nha,
                          'manager_amount', h.quan_ly, 'restricted', h.han_che)
                        ORDER BY h.tong DESC, h.ten)
                   FROM hang_muc h WHERE h.loai = 'EXPENSE' AND h.tong <> 0), '[]'::jsonb)),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'id', ct.id,
                       'code', ct.code,
                       'voucher_date', ct.voucher_date,
                       'type', ct.loai,
                       'name', ct.name,
                       'account_name', ct.so_quy,
                       'side', CASE WHEN ct.ben_chu_nha THEN 'LANDLORD' ELSE 'MANAGER' END,
                       'group', CASE ct.nhom WHEN 'COC' THEN 'DEPOSIT' WHEN 'KHAC' THEN 'EXCLUDED' ELSE 'PNL' END,
                       'source', CASE
                                   WHEN ct.nguon = 'termination.revenue' THEN 'TERMINATION_REVENUE'
                                   WHEN ct.nguon = 'termination.forfeit_revenue' THEN 'FORFEIT_REVENUE'
                                   WHEN ct.nguon = 'termination.refund' THEN 'TERMINATION_REFUND'
                                   WHEN ct.nguon IN ('termination.offset', 'termination.forfeit_offset') THEN 'DEPOSIT_OFFSET'
                                   WHEN ct.nguon = 'termination.extra_receipt' THEN 'EXTRA_RECEIPT'
                                   WHEN ct.nguon IN ('termination.rent_refund_offset', 'termination.rent_refund_revenue') THEN 'RENT_REFUND_INTERNAL'
                                   ELSE NULL END,
                       'cash_reversed', ct.approval_status = 'APPROVED' AND ct.but_toan = 'REVERSED',
                       'cash_unposted', ct.approval_status = 'APPROVED' AND ct.but_toan = 'UNPOSTED',
                       'foreign_landlord_account', ct.so_toa_khac,
                       'restricted', ct.han_che,
                       'excluded_reason', CASE WHEN ct.nhom <> 'KHAC' THEN NULL
                                               ELSE COALESCE(ct.ly_do, 'INTERNAL') END,
                       'status', ct.approval_status,
                       'amount', ct.so_tien,
                       'room_name', ht.ten_phong,
                       'invoice', ht.hoa_don,
                       -- phần của KỲ tháng này theo hạng mục (chỉ dòng lãi lỗ)
                       'lines', CASE WHEN ct.nhom = 'KQKD' THEN (
                                  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                           'category', d.ten, 'amount', d.so_tien) ORDER BY d.so_tien DESC, d.ten)
                                    FROM (SELECT h.ten, sum(h.amount) AS so_tien
                                            FROM lai_lo_hang_muc h
                                           WHERE h.id = ct.id
                                           GROUP BY h.ten) d
                                   WHERE d.so_tien <> 0) END,
                       -- phần KỲ tháng này chia theo dòng hoá đơn (phiếu thu theo hoá đơn; còn lại NULL)
                       'parts', tc.phan)
                     ORDER BY ct.voucher_date, ct.code, ct.nhom)
                FROM ct
                LEFT JOIN hien_thi ht ON ht.id = ct.id
                LEFT JOIN tach tc ON tc.id = ct.id AND ct.nhom = 'KQKD'), '[]'::jsonb),
           'source_hash', vet.source_hash)
    FROM chia CROSS JOIN vet;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_settlement_compute_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
