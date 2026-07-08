-- =============================================================================
-- nrm_vn() + resolve_fixed_expense_type()
--
-- nrm_vn = bản SQL của nrm() trong src/lib/fixedExpenseCategories.ts:
--   normalize NFD → bỏ dấu (combining U+0300..U+036F) → lower → đ→d → trim.
-- Dùng normalize()+regexp (PG13+) để KHỚP CHÍNH XÁC nrm() TS (đừng dùng translate
-- tay dễ lệch). Giữ đồng bộ 3 nơi: feeCategories.ts, fixedExpenseCategories.ts, hàm này.
--
-- resolve_fixed_expense_type(owner, category_key): tái dùng type expense sẵn có của
-- owner khớp matcher (chống đẻ type trùng làm P&L tách 2 dòng), chỉ tạo canonical khi
-- thiếu. CHẠY SERVER-SIDE (definer) theo owner vì RLS chặn staff đọc type của chủ.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.nrm_vn(s text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trim(replace(
    lower(regexp_replace(normalize(coalesce(s, ''), NFD), '[̀-ͯ]', '', 'g')),
    'đ', 'd'
  ))
$$;

-- Matcher dùng chung cho resolve + get_period_fee_status: khớp 1 income_expense_type
-- (đã nrm category/name) với 1 registry GRID key. PORT TỪ FIXED_EXPENSE_CATEGORIES.
CREATE OR REPLACE FUNCTION public.fee_type_matches(p_category_key text, p_cat text, p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_category_key
    WHEN 'internet'  THEN (public.nrm_vn(p_cat) = 'internet' OR public.nrm_vn(p_name) LIKE '%internet%')
    WHEN 'rac'       THEN (public.nrm_vn(p_name) LIKE '%rac%')
    WHEN 'cong_an'   THEN (public.nrm_vn(p_cat) = 'ca' OR public.nrm_vn(p_name) LIKE '%cong an%')
    WHEN 've_sinh'   THEN ((public.nrm_vn(p_cat) = 've sinh' OR public.nrm_vn(p_name) LIKE '%ve sinh toa nha%')
                             AND public.nrm_vn(p_name) NOT LIKE '%rac%')
    WHEN 'thang_may' THEN (public.nrm_vn(p_name) LIKE '%thang may%')
    WHEN 'dien'      THEN (public.nrm_vn(p_cat) = 'dien' OR public.nrm_vn(p_name) LIKE '%tien dien%')
    WHEN 'nuoc'      THEN (public.nrm_vn(p_cat) = 'nuoc' OR public.nrm_vn(p_name) LIKE '%tien nuoc%')
    WHEN 'tien_nha'  THEN (public.nrm_vn(p_cat) = 'tien nha' OR public.nrm_vn(p_name) LIKE '%tien nha%')
    WHEN 'quan_ly'   THEN (public.nrm_vn(p_name) LIKE '%quan ly%')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.resolve_fixed_expense_type(p_owner uuid, p_category_key text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type uuid;
  v_name text;
  v_cat  text;
BEGIN
  IF p_category_key NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key;
  END IF;

  -- 1. Tái dùng type sẵn có của owner khớp matcher (ưu tiên is_default, cũ nhất).
  SELECT t.id INTO v_type
    FROM income_expense_types t
   WHERE t.user_id = p_owner
     AND t.type = 'expense'
     AND public.fee_type_matches(p_category_key, t.category, t.name)
   ORDER BY t.is_default DESC NULLS LAST, t.created_at ASC
   LIMIT 1;
  IF v_type IS NOT NULL THEN RETURN v_type; END IF;

  -- 2. Không có → tạo canonical.
  v_name := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Đóng tiền điện'
    WHEN 'nuoc'      THEN 'Đóng tiền nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà định kỳ'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Tiền rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;
  v_cat := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo Trì Thang Máy'
  END;

  INSERT INTO income_expense_types (name, category, type, is_restricted, is_deposit, user_id)
  VALUES (v_name, v_cat, 'expense', (p_category_key = 'quan_ly'), FALSE, p_owner)
  RETURNING id INTO v_type;

  RETURN v_type;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fixed_expense_type(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fixed_expense_type(uuid,text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
