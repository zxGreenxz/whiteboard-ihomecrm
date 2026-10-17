-- customer_list_v1 — công thức DUY NHẤT của màn Khách hàng (/customers), dùng chung cho
-- web, Hermes và báo cáo (chủ chốt 17/10/2026; cùng nguyên tắc invoice_list_v1/contract_list_v1).
--
-- Trước đây công thức nằm ở src/hooks/useCustomers.ts: PostgREST `customers` (RLS) + bộ lọc
-- trạng thái/loại + tìm không dấu (src/lib/customerSearch.ts, commit 7f0bb373) + lọc toà/phòng
-- qua get_customer_residence_location_ids_v1 (phân trang 500, kiểm residence_scope_v1 TỪNG DÒNG)
-- + order created_at desc + range/count exact + chuỗi nhúng contract_customers→contracts→rooms→
-- buildings cho toà hiện tại; thẻ thống kê đi get_customer_stats (không tìm) hoặc 4 HEAD-count.
--
-- Ba hàm:
--  1. customer_search_patterns_v1(text) IMMUTABLE — dựng đúng hai regex mà customerSearchFilter
--     dựng ở trình duyệt: tên (trim JS → NFC → chữ thường → mỗi chữ Việt thành [biến thể][dấu]*)
--     và chuỗi thô đã escape cho SĐT/email/CCCD. `~*` = `imatch` của PostgREST.
--  2. customer_location_ids_v1(...) SECURITY DEFINER — tập khách theo lưu trú (HĐ đang ở; cộng
--     lịch sử khi tab khác "Đang thuê") y như get_customer_residence_location_ids_v1, nhưng
--     residence_scope_v1 chạy MỘT lần mỗi toà ứng viên thay vì từng dòng HĐ/sự kiện.
--  3. customer_list_v1(...) SECURITY INVOKER — đọc customers và chuỗi toà hiện tại BẰNG RLS CỦA
--     NGƯỜI GỌI (customers_select_rbac 20260726130000:33-35 + org_boundary/hide_demo/sandbox), nên
--     tập dòng trùng tập web thấy theo cấu trúc chứ không phải theo bản sao luật. Policy đã bọc
--     InitPlan ⇒ hàm quyền chạy một lần mỗi câu, không theo dòng.
--
-- Hermes (PR sau) gọi bằng JWT người dùng và truyền p_building_ids để THU HẸP: điều kiện chỉ
-- được AND thêm, không bao giờ mở rộng phạm vi RLS. Cấm gọi customer_list_v1 từ thân hàm
-- SECURITY DEFINER: INVOKER khi đó chạy bằng quyền chủ hàm và bỏ qua RLS ⇒ hàm tự chặn khi
-- current_user không phải `authenticated`.
BEGIN;

CREATE OR REPLACE FUNCTION public.customer_search_patterns_v1(p_search text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  -- Khoảng trắng của String.prototype.trim (WhiteSpace + LineTerminator của ECMAScript).
  WITH trimmed AS (
    SELECT pg_catalog.btrim(p_search,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
      || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
      || chr(8287) || chr(12288) || chr(65279)) AS t
  ), special AS (
    -- Đúng tập escapeRegex của customerSearch.ts: . * + ? ^ $ { } ( ) | [ ] \
    SELECT ARRAY['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', chr(92)] AS chars
  ), letters AS (
    SELECT letter, variants
    FROM unnest(ARRAY['aàáạảãâầấậẩẫăằắặẳẵ', 'eèéẹẻẽêềếệểễ', 'iìíịỉĩ', 'oòóọỏõôồốộổỗơờớợởỡ',
                      'uùúụủũưừứựửữ', 'yỳýỵỷỹ', 'dđ']) AS g(variants),
         regexp_split_to_table(g.variants, '') AS letter
  )
  SELECT CASE WHEN trimmed.t IS NULL OR trimmed.t = '' THEN NULL ELSE ARRAY[
    (SELECT string_agg(CASE
              WHEN l.variants IS NOT NULL THEN '[' || l.variants || '][' || chr(768) || '-' || chr(879) || ']*'
              WHEN ch.c = ANY (special.chars) THEN chr(92) || ch.c
              ELSE ch.c END, '' ORDER BY ch.o)
       -- normalize('NFC').toLowerCase(): database ICU (production/TEST) hạ chữ như JS, kể cả chữ Việt hoa.
       FROM regexp_split_to_table(lower(normalize(trimmed.t, NFC)), '') WITH ORDINALITY AS ch(c, o)
       LEFT JOIN letters l ON l.letter = ch.c),
    (SELECT string_agg(CASE WHEN x.c = ANY (special.chars) THEN chr(92) || x.c ELSE x.c END, '' ORDER BY x.o)
       FROM regexp_split_to_table(trimmed.t, '') WITH ORDINALITY AS x(c, o))
  ] END
  FROM trimmed, special
$fn$;

CREATE OR REPLACE FUNCTION public.customer_location_ids_v1(
  p_organization_id uuid,
  p_building_ids uuid[] DEFAULT NULL,
  p_room_id uuid DEFAULT NULL,
  p_include_history boolean DEFAULT true)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_result uuid[];
BEGIN
  -- Người gọi phải đăng nhập và là thành viên ACTIVE của công ty (assert_residence_reader_v1
  -- nói lại cùng điều kiện, cộng chặn super admin trong org sandbox).
  IF auth.uid() IS NULL OR p_organization_id IS NULL
     OR NOT COALESCE(p_organization_id = ANY (public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Không có quyền xem lịch sử khách hàng' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_residence_reader_v1(p_organization_id, ARRAY[]::uuid[]);
  IF p_include_history IS NULL OR (p_building_ids IS NULL AND p_room_id IS NULL)
     OR array_position(p_building_ids, NULL) IS NOT NULL OR cardinality(p_building_ids) > 500 THEN
    RAISE EXCEPTION 'Invalid location filter' USING ERRCODE = '22023';
  END IF;

  WITH candidate AS MATERIALIZED (
    -- Cùng hai nhánh với get_customer_residence_location_ids_v1 (20261007160000:366-376).
    SELECT cc.customer_id, r.building_id
    FROM public.contract_customers cc
    JOIN public.contracts c ON c.id = cc.contract_id
    JOIN public.rooms r ON r.id = c.room_id
    WHERE c.organization_id = p_organization_id
      AND (p_building_ids IS NULL OR r.building_id = ANY (p_building_ids))
      AND (p_room_id IS NULL OR r.id = p_room_id)
      AND app_private.residence_contract_current_v2(c.id)
    UNION
    SELECT e.customer_id, e.building_id
    FROM app_private.customer_residence_events e
    WHERE p_include_history AND e.organization_id = p_organization_id
      AND (p_building_ids IS NULL OR e.building_id = ANY (p_building_ids))
      AND (p_room_id IS NULL OR e.room_id = p_room_id)
  ), building AS MATERIALIZED (
    -- CTE riêng là hàng rào: viết DISTINCT trong subquery thì planner đẩy điều kiện STABLE
    -- bên dưới xuống trước DISTINCT và lại kiểm theo từng dòng (đo được trong test PGlite).
    SELECT DISTINCT candidate.building_id FROM candidate WHERE candidate.building_id IS NOT NULL
  ), allowed AS MATERIALIZED (
    -- residence_scope_v1 chỉ phụ thuộc (công ty, toà, người gọi) ⇒ kiểm MỘT lần mỗi toà.
    SELECT building.building_id
    FROM building
    WHERE app_private.residence_scope_v1(p_organization_id, building.building_id)
  )
  SELECT COALESCE(array_agg(DISTINCT candidate.customer_id ORDER BY candidate.customer_id), ARRAY[]::uuid[])
  INTO v_result
  FROM candidate
  WHERE candidate.building_id IN (SELECT allowed.building_id FROM allowed);

  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.customer_list_v1(
  p_organization_id uuid,
  p_status text DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_room_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_include_location boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_kind text := NULLIF(p_kind, 'ALL');
  v_patterns text[];
  v_location uuid[];
  v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'customer_list_v1 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  -- Không đặt trần p_limit: "Xem thêm" trên mobile tăng trang 30 một và picker HĐ đọc cả
  -- danh sách (p_limit NULL); tập dòng vốn đã giới hạn bởi RLS + công ty.
  IF p_organization_id IS NULL OR p_offset IS NULL OR p_offset < 0 OR p_include_location IS NULL
     OR p_limit < 0
     OR (p_status IS NOT NULL AND p_status NOT IN ('RENTING', 'MOVED_OUT', 'WALK_IN'))
     OR (p_kind IS NOT NULL AND p_kind NOT IN ('ALL', 'INDIVIDUAL', 'ORGANIZATION', 'FOREIGN'))
     OR array_position(p_building_ids, NULL) IS NOT NULL OR cardinality(p_building_ids) > 500 THEN
    RAISE EXCEPTION 'Tham số danh sách khách hàng không hợp lệ' USING ERRCODE = '22023';
  END IF;

  v_patterns := public.customer_search_patterns_v1(p_search);
  IF p_building_ids IS NOT NULL OR p_room_id IS NOT NULL THEN
    -- Như web: tab "Đang thuê" chỉ xét HĐ đang ở; tab khác (hoặc không lọc tab) cộng lịch sử.
    v_location := public.customer_location_ids_v1(p_organization_id, p_building_ids, p_room_id,
      p_status IS DISTINCT FROM 'RENTING');
  END IF;

  WITH base AS MATERIALIZED (
    SELECT cu.*
    FROM public.customers cu
    WHERE cu.organization_id = p_organization_id
      AND cu.deleted_at IS NULL
      AND (p_status IS NULL OR cu.status_v2::text = p_status)
      AND (v_patterns IS NULL
           OR cu.full_name ~* v_patterns[1]
           OR cu.phone ~* v_patterns[2]
           OR cu.email ~* v_patterns[2]
           OR cu.id_number ~* v_patterns[2])
      AND (v_location IS NULL OR cu.id = ANY (v_location))
  ), kinded AS MATERIALIZED (
    -- Thẻ thống kê đang chọn: chỉ lọc danh sách, không lọc khối stats.
    SELECT b.*
    FROM base b
    WHERE v_kind IS NULL
       OR (v_kind = 'FOREIGN' AND b.is_foreign IS TRUE)
       OR (v_kind IN ('INDIVIDUAL', 'ORGANIZATION') AND b.customer_type::text = v_kind)
  ), page AS MATERIALIZED (
    -- Web sắp created_at desc không khoá phụ; id desc làm thứ tự xác định giữa các dòng trùng giờ.
    SELECT k.*
    FROM kinded k
    ORDER BY k.created_at DESC, k.id DESC
    OFFSET p_offset
    LIMIT p_limit
  ), loc AS MATERIALIZED (
    -- Toà/phòng hiện tại như chuỗi nhúng cũ: HĐ status ACTIVE thấy được qua RLS, bỏ liên kết
    -- không có toà lẫn tên phòng. Nhiều HĐ thì lấy HĐ còn sống, bắt đầu muộn nhất.
    SELECT DISTINCT ON (cc.customer_id)
      cc.customer_id, b.id AS building_id, b.name AS building_name, r.name AS room_name
    FROM page pg
    JOIN public.contract_customers cc ON cc.customer_id = pg.id
    JOIN public.contracts c ON c.id = cc.contract_id
    LEFT JOIN public.rooms r ON r.id = c.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
    WHERE p_include_location
      AND c.status::text = 'ACTIVE'
      AND (b.id IS NOT NULL OR COALESCE(r.name, '') <> '')
    ORDER BY cc.customer_id, (c.deleted_at IS NULL) DESC, c.start_date DESC NULLS LAST,
      cc.created_at DESC NULLS LAST, c.id DESC
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM kinded),
    'stats', (SELECT jsonb_build_object(
                'total', count(*),
                'individual', count(*) FILTER (WHERE b.customer_type::text = 'INDIVIDUAL'),
                'organization', count(*) FILTER (WHERE b.customer_type::text = 'ORGANIZATION'),
                'foreign', count(*) FILTER (WHERE b.is_foreign IS TRUE))
              FROM base b),
    'rows', COALESCE((
      SELECT jsonb_agg(CASE WHEN p_include_location THEN to_jsonb(pg) || jsonb_build_object(
                 'current_building_id', loc.building_id,
                 'current_building_name', NULLIF(loc.building_name, ''),
                 'current_room_name', NULLIF(loc.room_name, ''))
               ELSE to_jsonb(pg) END
             ORDER BY pg.created_at DESC, pg.id DESC)
      FROM page pg
      LEFT JOIN loc ON loc.customer_id = pg.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

ALTER FUNCTION public.customer_search_patterns_v1(text) OWNER TO postgres;
ALTER FUNCTION public.customer_location_ids_v1(uuid, uuid[], uuid, boolean) OWNER TO postgres;
ALTER FUNCTION public.customer_list_v1(uuid, text, text, text, uuid[], uuid, integer, integer, boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.customer_search_patterns_v1(text),
  public.customer_location_ids_v1(uuid, uuid[], uuid, boolean),
  public.customer_list_v1(uuid, text, text, text, uuid[], uuid, integer, integer, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.customer_search_patterns_v1(text),
  public.customer_location_ids_v1(uuid, uuid[], uuid, boolean),
  public.customer_list_v1(uuid, text, text, text, uuid[], uuid, integer, integer, boolean)
  TO authenticated;

COMMENT ON FUNCTION public.customer_list_v1(uuid, text, text, text, uuid[], uuid, integer, integer, boolean) IS
  'Danh sách + tổng + thống kê màn Khách hàng. INVOKER: RLS của người gọi; chỉ gọi bằng JWT người dùng. p_building_ids chỉ thu hẹp.';

COMMIT;
NOTIFY pgrst, 'reload schema';
