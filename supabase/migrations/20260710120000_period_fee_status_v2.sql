-- =============================================================================
-- Đóng tiền Tập trung theo Kỳ — STATUS V2 (fix P0 + nền cho loạt tính năng 10/07)
--
-- 1) building_fee_accounts.not_applicable — cờ "tòa KHÔNG áp dụng hạng mục này"
--    (loại khỏi đếm thiếu ở Tổng quan; bật/tắt qua upsert RPC).
-- 2) upsert_building_fee_account: + p_not_applicable (đổi chữ ký → DROP trước).
-- 3) get_period_fee_status v2 (đổi OUT columns → DROP trước):
--    - FIX P0 type-owner: match MỌI type expense qua fee_type_matches, KHÔNG lọc
--      t.user_id = owner nữa (phiếu thật dùng type của NGƯỜI TẠO — T7: tien_nha
--      0/14 type thuộc owner, internet 0/13, rac 0/17 → UI báo thiếu ảo, nguy cơ
--      đóng trùng). An toàn cross-tenant vì vẫn lọc ie.building_id ∈ tòa được phép.
--      GIỮ gate hạng mục hạn chế: type is_restricted chỉ hiện khi can_view_restricted_ie().
--    - Trả cả phiếu NHÁP (UNAPPROVED): paid_amount = Σ APPROVED, draft_amount = Σ NHÁP
--      (nuôi flow "Thanh toán phiếu nháp" của recurring draft-mode).
--    - vouchers jsonb: chi tiết TỪNG phiếu (sửa/hủy/thumbnail per-voucher, popover
--      nhiều phiếu) — hết bug sửa nhầm phiếu / cộng dồn sai / mất ảnh-ghi chú.
--    - expected_amount của quan_ly gate theo can_view_restricted_ie().
-- =============================================================================

BEGIN;

-- ── 1) Cờ "Không áp dụng" ──
ALTER TABLE public.building_fee_accounts
  ADD COLUMN IF NOT EXISTS not_applicable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.building_fee_accounts.not_applicable IS
  'Tòa KHÔNG áp dụng hạng mục này (vd không lắp internet) — loại khỏi đếm "chưa có phiếu" ở trang Đóng tiền tập trung.';

-- ── 2) upsert_building_fee_account v2 (+ not_applicable) ──
DROP FUNCTION IF EXISTS public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid);

CREATE OR REPLACE FUNCTION public.upsert_building_fee_account(
  p_building_id        uuid,
  p_fee_category       text,
  p_provider_code      text    DEFAULT NULL,
  p_account_holder     text    DEFAULT NULL,
  p_default_amount     numeric DEFAULT NULL,
  p_default_account_id uuid    DEFAULT NULL,
  p_not_applicable     boolean DEFAULT NULL   -- NULL = giữ nguyên
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_id    uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category;
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền cấu hình toà này' USING ERRCODE = '42501';
  END IF;

  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, not_applicable, user_id)
  VALUES
    (p_building_id, p_fee_category,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     p_default_amount, p_default_account_id, COALESCE(p_not_applicable, false), v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code      = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder     = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount     = COALESCE(EXCLUDED.default_amount,     building_fee_accounts.default_amount),
    default_account_id = COALESCE(EXCLUDED.default_account_id, building_fee_accounts.default_account_id),
    not_applicable     = COALESCE(p_not_applicable, building_fee_accounts.not_applicable),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean) TO authenticated;

-- ── 3) get_period_fee_status v2 ──
DROP FUNCTION IF EXISTS public.get_period_fee_status(text,text,uuid[],text[]);

CREATE OR REPLACE FUNCTION public.get_period_fee_status(
  p_period_start  text,
  p_period_end    text,
  p_building_ids  uuid[],
  p_category_keys text[]
) RETURNS TABLE(
  building_id      uuid,
  category_key     text,
  paid_amount      numeric,
  draft_amount     numeric,
  covered_start    date,
  covered_end      date,
  voucher_ids      uuid[],
  vouchers         jsonb,
  has_receipt      boolean,
  account_name     text,
  account_is_empty boolean,
  expected_amount  numeric,
  not_applicable   boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start          date;
  v_end            date;
  v_can_restricted boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_can_restricted := public.can_view_restricted_ie();

  RETURN QUERY
  WITH bld AS (
    SELECT b.id
      FROM buildings b
     WHERE b.id = ANY(p_building_ids) AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  cat AS (
    SELECT k FROM unnest(p_category_keys) AS k
     WHERE k IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may')
  ),
  pairs AS (
    SELECT bld.id AS building_id, cat.k AS category_key FROM bld CROSS JOIN cat
  ),
  -- FIX P0: match type theo matcher, KHÔNG theo owner (type thuộc người tạo phiếu)
  typed AS (
    SELECT c.k AS category_key, t.id AS type_id
      FROM cat c
      JOIN income_expense_types t
        ON t.type = 'expense'
       AND public.fee_type_matches(c.k, t.category, t.name)
     WHERE (NOT t.is_restricted OR v_can_restricted)
  ),
  -- 1 dòng / (pair × voucher) — gộp item để lấy khoảng phủ + đếm dòng
  vperv AS (
    SELECT p.building_id, p.category_key,
           ie.id            AS vid,
           ie.total_amount  AS amount,
           ie.approval_status AS st,
           ie.system_source AS source,
           ie.voucher_date  AS vdate,
           ie.account_id    AS acc_id,
           a.name           AS acc_name,
           ie.attachments   AS atts,
           ie.notes         AS vnotes,
           ie.creator_name  AS vcreator,
           -- is_auto: cấu trúc (repeat_parent_id) là nguồn sự thật; name-LIKE chỉ
           -- fallback cho phiếu legacy tạo tay mang hậu tố "(tự động lập)".
           (ie.repeat_parent_id IS NOT NULL
             OR public.nrm_vn(ie.name) LIKE '%tu dong%') AS is_auto,
           EXISTS (SELECT 1 FROM income_expense_batch_items bi WHERE bi.income_expense_id = ie.id) AS in_batch,
           min(it.start_date) AS cstart,
           max(it.end_date)   AS cend,
           count(it.id)       AS item_cnt
      FROM pairs p
      JOIN typed ty ON ty.category_key = p.category_key
      JOIN income_expense_items it ON it.income_expense_type_id = ty.type_id
      JOIN income_expenses ie ON ie.id = it.income_expense_id
                             AND ie.building_id = p.building_id
                             AND ie.type = 'EXPENSE'
                             AND ie.approval_status IN ('APPROVED','UNAPPROVED')
                             AND ie.deleted_at IS NULL
      LEFT JOIN accounts a ON a.id = ie.account_id
     WHERE it.start_date <= v_end AND it.end_date >= v_start
     GROUP BY p.building_id, p.category_key, ie.id, ie.total_amount, ie.approval_status,
              ie.system_source, ie.voucher_date, ie.account_id, a.name, ie.attachments,
              ie.notes, ie.creator_name, ie.name
  )
  SELECT
    p.building_id,
    p.category_key,
    COALESCE(SUM(v.amount) FILTER (WHERE v.st = 'APPROVED'), 0)                    AS paid_amount,
    COALESCE(SUM(v.amount) FILTER (WHERE v.st = 'UNAPPROVED'), 0)                  AS draft_amount,
    MIN(v.cstart) FILTER (WHERE v.st = 'APPROVED')                                 AS covered_start,
    MAX(v.cend)   FILTER (WHERE v.st = 'APPROVED')                                 AS covered_end,
    COALESCE(array_agg(v.vid ORDER BY v.vdate DESC, v.vid) FILTER (WHERE v.vid IS NOT NULL), '{}'::uuid[]) AS voucher_ids,
    COALESCE(jsonb_agg(jsonb_build_object(
        'id', v.vid,
        'amount', v.amount,
        'status', v.st,
        'date', v.vdate,
        'source', v.source,
        'is_auto', v.is_auto,
        'in_batch', v.in_batch,
        'cancellable', NOT v.in_batch,
        'account_id', v.acc_id,
        'account_name', v.acc_name,
        'attachments', COALESCE(v.atts, '[]'::jsonb),
        'notes', v.vnotes,
        'item_count', v.item_cnt,
        'start', v.cstart,
        'end', v.cend,
        'creator_name', v.vcreator
      ) ORDER BY v.vdate DESC, v.vid) FILTER (WHERE v.vid IS NOT NULL), '[]'::jsonb) AS vouchers,
    COALESCE(bool_or(jsonb_typeof(v.atts) = 'array' AND jsonb_array_length(v.atts) > 0), false) AS has_receipt,
    (array_agg(v.acc_name ORDER BY v.vdate DESC) FILTER (WHERE v.st = 'APPROVED' AND v.acc_name IS NOT NULL))[1] AS account_name,
    COALESCE(bool_or(v.st = 'APPROVED' AND v.acc_id IS NULL), false)               AS account_is_empty,
    CASE WHEN p.category_key = 'quan_ly' AND NOT v_can_restricted THEN NULL
         ELSE MAX(fa.default_amount) END                                           AS expected_amount,
    COALESCE(bool_or(fa.not_applicable), false)                                    AS not_applicable
  FROM pairs p
  LEFT JOIN vperv v ON v.building_id = p.building_id AND v.category_key = p.category_key
  LEFT JOIN building_fee_accounts fa ON fa.building_id = p.building_id
                                    AND fa.fee_category = p.category_key
                                    AND fa.deleted_at IS NULL
  GROUP BY p.building_id, p.category_key;
END;
$$;

REVOKE ALL ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
