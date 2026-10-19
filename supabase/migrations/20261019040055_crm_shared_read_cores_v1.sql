-- Single canonical INVOKER query per list; old web signatures retain their
-- exact ordering/offset semantics. Hermes uses the same filters and RLS with
-- explicit UUID keyset order, never a second copied business reader.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.customer_list_core_v1(
  p_organization_id uuid,
  p_status text DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_room_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_include_location boolean DEFAULT true,
  p_order text DEFAULT 'web',p_after_id uuid DEFAULT NULL,p_location_building_ids uuid[] DEFAULT NULL)
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
  IF p_order IS NULL OR p_order NOT IN ('web','id_asc') OR (p_order='web' AND p_after_id IS NOT NULL) THEN RAISE EXCEPTION 'shared_read_order_invalid' USING ERRCODE='22023'; END IF;
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'customer_list_v1 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  -- Không đặt trần p_limit: "Xem thêm" trên mobile tăng trang 30 một và picker HĐ đọc cả
  -- danh sách (p_limit NULL); tập dòng vốn đã giới hạn bởi RLS + công ty.
  -- p_building_ids: NULL = toàn phạm vi RLS (KHÔNG lọc toà); '{}' = rỗng (0 dòng). Caller
  -- muốn thu hẹp theo tập toà của mình phải truyền COALESCE(ids, '{}'), không được để NULL.
  IF p_organization_id IS NULL OR p_offset IS NULL OR p_offset < 0 OR p_include_location IS NULL
     OR p_limit < 0 OR char_length(p_search) > 200
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
    -- Chỉ cột cần để lọc/đếm/sắp; dòng đầy đủ chỉ đọc lại cho trang (cùng RLS, cùng snapshot).
    SELECT cu.id, cu.created_at, cu.customer_type, cu.is_foreign
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
    SELECT k.id, k.created_at
    FROM kinded k
    WHERE p_after_id IS NULL OR k.id>p_after_id
    ORDER BY CASE WHEN p_order='web' THEN k.created_at END DESC,CASE WHEN p_order='web' THEN k.id END DESC,k.id
    OFFSET p_offset
    LIMIT p_limit
  ), loc AS MATERIALIZED (
    -- Toà/phòng hiện tại: HĐ status ACTIVE CÒN SỐNG thấy được qua RLS, bỏ liên kết không có
    -- toà lẫn tên phòng; nhiều HĐ thì lấy HĐ bắt đầu muộn nhất. (Chuỗi nhúng cũ không bỏ HĐ đã
    -- xoá mềm — đổi có chủ đích theo review PR #196.)
    SELECT DISTINCT ON (cc.customer_id)
      cc.customer_id,c.id AS hermes_contract_id,r.id AS hermes_room_id,b.id AS building_id,b.name AS building_name,r.name AS room_name
    FROM page pg
    JOIN public.contract_customers cc ON cc.customer_id = pg.id
    JOIN public.contracts c ON c.id = cc.contract_id
    LEFT JOIN public.rooms r ON r.id = c.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
    WHERE p_include_location
      AND (p_location_building_ids IS NULL OR r.building_id=ANY(p_location_building_ids))
      AND c.status::text = 'ACTIVE'
      AND c.deleted_at IS NULL
      AND (b.id IS NOT NULL OR COALESCE(r.name, '') <> '')
    ORDER BY cc.customer_id, c.start_date DESC NULLS LAST, cc.created_at DESC NULLS LAST, c.id DESC
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
      SELECT jsonb_agg(CASE WHEN p_include_location THEN to_jsonb(cu) || jsonb_build_object(
                 'current_building_id', loc.building_id,
                 'current_building_name', NULLIF(loc.building_name, ''),
                 'current_room_name', NULLIF(loc.room_name, '')) || CASE WHEN p_order='id_asc' THEN jsonb_build_object('hermes_contract_id',loc.hermes_contract_id,'hermes_room_id',loc.hermes_room_id) ELSE '{}'::jsonb END
               ELSE to_jsonb(cu) END
             ORDER BY CASE WHEN p_order='web' THEN pg.created_at END DESC,CASE WHEN p_order='web' THEN pg.id END DESC,pg.id)
      FROM page pg
      JOIN public.customers cu ON cu.id = pg.id
      LEFT JOIN loc ON loc.customer_id = pg.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

-- A pure projection helper is shared by the INVOKER row adapter. It cannot
-- read data or select an actor, organization or permission.
CREATE OR REPLACE FUNCTION public.hermes_read_text_v1(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT left(regexp_replace(translate(p_text,chr(8232)||chr(8233),'  '),'[[:cntrl:]]','','g'),200)
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
BEGIN
 RETURN public.customer_list_core_v1(p_organization_id,p_status,p_kind,p_search,p_building_ids,p_room_id,p_limit,p_offset,p_include_location);
END
$fn$;

CREATE OR REPLACE FUNCTION public.contract_list_core_v1(
  p_search text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_room_name text DEFAULT NULL,
  p_lifecycle text DEFAULT 'ALL',
  p_stat text DEFAULT 'ALL',
  p_month text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_with_customers boolean DEFAULT true
,
  p_order text DEFAULT 'web',p_after_id uuid DEFAULT NULL,p_exact_status text DEFAULT NULL,p_customer_building_ids uuid[] DEFAULT NULL,p_organization_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_lifecycle text := COALESCE(p_lifecycle, 'ALL');
  v_stat text := COALESCE(p_stat, 'ALL');
  v_limit integer := COALESCE(p_limit, 1000);
  v_offset integer := COALESCE(p_offset, 0);
  v_customers boolean := p_with_customers IS TRUE;
  v_month_start date;
  v_month_end date;
  v_safe text;
  v_pattern text;
  v_today date;
  v_result jsonb;
BEGIN
  IF p_order IS NULL OR p_order NOT IN ('web','id_asc') OR (p_order='web' AND p_after_id IS NOT NULL) THEN RAISE EXCEPTION 'shared_read_order_invalid' USING ERRCODE='22023'; END IF;
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'contract_list_v1 chỉ chạy bằng JWT người dùng (vai authenticated).' USING ERRCODE = '42501';
  END IF;

  IF v_lifecycle NOT IN ('ALL', 'ACTIVE', 'TERMINATED') THEN
    RAISE EXCEPTION 'Bộ lọc vòng đời hợp đồng không hợp lệ: %', v_lifecycle USING ERRCODE = '22023';
  END IF;
  IF v_stat NOT IN ('ALL', 'EXPIRING', 'EXPIRED', 'TERMINATED') THEN
    RAISE EXCEPTION 'Bộ lọc trạng thái hợp đồng không hợp lệ: %', v_stat USING ERRCODE = '22023';
  END IF;
  IF v_limit < 1 OR v_limit > 1000 OR v_offset < 0 THEN
    RAISE EXCEPTION 'Phân trang không hợp lệ (1–1000 dòng, vị trí ≥ 0).' USING ERRCODE = '22023';
  END IF;
  IF array_position(p_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Danh sách toà có phần tử rỗng.' USING ERRCODE = '22023';
  END IF;
  -- '' = không lọc tháng (web gửi month: '' → undefined).
  IF NULLIF(p_month, '') IS NOT NULL THEN
    IF p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'Tháng phải có dạng YYYY-MM: %', p_month USING ERRCODE = '22023';
    END IF;
    v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
    v_month_end := (v_month_start + interval '1 month' - interval '1 day')::date;
  END IF;

  -- sanitizeSearchTerm của web: , ( ) " ' \ % thành khoảng trắng, gộp khoảng trắng (đúng tập \s
  -- của JavaScript), bỏ hai đầu. Rỗng sau khi làm sạch = không tìm.
  v_safe := btrim(regexp_replace(
    regexp_replace(COALESCE(p_search, ''), '[,()"''\\%]', ' ', 'g'),
    '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
  v_pattern := CASE WHEN v_safe = '' THEN NULL ELSE '%' || replace(v_safe, '*', '%') || '%' END;

  v_today := public.org_today_v1(NULL);

  -- Mỗi lần tham chiếu bảng là thêm một lượt policy RLS với InitPlan riêng (accessible_*_ids ≈ 35 ms
  -- đo trên TEST 18/10/2026) ⇒ mỗi bảng chỉ CHẠY một lần trong câu. Liên kết HĐ–khách chỉ gom
  -- toàn bộ khi đang tìm theo khách (links_search, dùng lại cho cột của trang); còn lại chỉ đọc
  -- cho các HĐ của trang hiện tại (links_page). Hai nhánh loại trừ nhau bằng điều kiện hằng
  -- (One-Time Filter) nên nhánh không dùng không quét và không chạy policy.
  WITH links_search AS MATERIALIZED (
    SELECT cc.id, cc.contract_id, cc.customer_id, cc.is_representative, cc.created_at,
           cu.id AS cu_id, cu.full_name, cu.phone
      FROM public.contract_customers cc
      LEFT JOIN public.customers cu ON cu.id = cc.customer_id
     WHERE v_pattern IS NOT NULL AND v_customers
  ),
  hits AS MATERIALIZED (
    SELECT c AS crow, c.id, c.created_at, r.id AS room_id, r.name AS room_name,
           r.building_id, d.display_status
      FROM public.contracts c
      LEFT JOIN public.rooms r ON r.id = c.room_id
     CROSS JOIN LATERAL (
       SELECT public.contract_display_status_v1(c.status::text, c.expected_move_out_date, c.end_date, v_today)
         AS display_status
     ) d
     WHERE c.deleted_at IS NULL
       AND (p_organization_id IS NULL OR c.organization_id=p_organization_id)
       AND (p_exact_status IS NULL OR c.status::text=p_exact_status)
       -- rooms!inner của web: phòng phải thấy được (RLS) và khớp bộ lọc.
       AND (p_building_ids IS NULL OR r.building_id = ANY (p_building_ids))
       AND (p_room_name IS NULL OR r.name = p_room_name)
       AND (v_lifecycle = 'ALL'
            OR (v_lifecycle = 'ACTIVE' AND c.status::text <> 'TERMINATED')
            OR (v_lifecycle = 'TERMINATED' AND c.status::text = 'TERMINATED'))
       AND (v_stat = 'ALL' OR d.display_status = v_stat)
       AND (v_month_start IS NULL OR (c.start_date <= v_month_end AND c.end_date >= v_month_start))
       AND (v_pattern IS NULL
            OR c.contract_number ILIKE v_pattern
            OR r.name ILIKE v_pattern
            OR (v_customers AND (p_customer_building_ids IS NULL OR r.building_id=ANY(p_customer_building_ids)) AND EXISTS (
                  SELECT 1
                    FROM links_search l
                   WHERE l.contract_id = c.id
                     AND l.cu_id IS NOT NULL
                     AND (l.full_name ILIKE v_pattern OR l.phone ILIKE v_pattern))))
  ),
  page AS MATERIALIZED (
    SELECT h.*
      FROM hits h
     WHERE p_after_id IS NULL OR h.id>p_after_id
     ORDER BY CASE WHEN p_order='web' THEN h.created_at END DESC,h.id
     LIMIT v_limit OFFSET v_offset
  ),
  links_page AS MATERIALIZED (
    SELECT cc.id, cc.contract_id, cc.customer_id, cc.is_representative, cc.created_at,
           cu.id AS cu_id, cu.full_name, cu.phone
      FROM public.contract_customers cc
      LEFT JOIN public.customers cu ON cu.id = cc.customer_id
     WHERE NOT (v_pattern IS NOT NULL AND v_customers)
       AND cc.contract_id IN (SELECT p.id FROM page p)
  ),
  people AS MATERIALIZED (
    -- Đại diện đứng đầu; khách không thấy được (RLS) hoặc bị ẩn thêm ⇒ customer = null như embed web.
    SELECT l.contract_id,
           jsonb_agg(jsonb_build_object(
             'id', l.id,
             'contract_id', l.contract_id,
             'customer_id', l.customer_id,
             'is_representative', l.is_representative,
             'customer', CASE WHEN v_customers AND l.cu_id IS NOT NULL
               THEN jsonb_build_object('id', l.cu_id, 'full_name', l.full_name, 'phone', l.phone) END)
             ORDER BY COALESCE(l.is_representative, false) DESC, l.created_at, l.id) AS items
      FROM (SELECT * FROM links_search s WHERE s.contract_id IN (SELECT p.id FROM page p)
            UNION ALL
            SELECT * FROM links_page) l
     GROUP BY l.contract_id
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM hits),
    'today', v_today,
    'rows', COALESCE((
      SELECT jsonb_agg(
               to_jsonb(p.crow) || jsonb_build_object(
                 'display_status', p.display_status,
                 'display_label', public.contract_display_label_v1(p.display_status),
                 'room', CASE WHEN p.room_id IS NOT NULL THEN jsonb_build_object(
                           'id', p.room_id,
                           'name', p.room_name,
                           'building_id', p.building_id,
                           'building', CASE WHEN b.id IS NOT NULL
                             THEN jsonb_build_object('id', b.id, 'name', b.name) END) END,
                 'contract_customers', COALESCE(pe.items, '[]'::jsonb))
               ORDER BY CASE WHEN p_order='web' THEN p.created_at END DESC,p.id)
        FROM page p
        LEFT JOIN public.buildings b ON b.id = p.building_id
        LEFT JOIN people pe ON pe.contract_id = p.id
    ), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.contract_list_v1(
  p_search text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_room_name text DEFAULT NULL,
  p_lifecycle text DEFAULT 'ALL',
  p_stat text DEFAULT 'ALL',
  p_month text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_with_customers boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
 RETURN public.contract_list_core_v1(p_search,p_building_ids,p_room_name,p_lifecycle,p_stat,p_month,p_limit,p_offset,p_with_customers);
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_list_core_v1(
  p_billing_month text DEFAULT NULL,
  p_view_status text DEFAULT 'active',
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_amount_target numeric DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_adjustment_review_status text DEFAULT NULL,
  p_payment_method public.payment_method DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_order text DEFAULT 'web',p_after_id uuid DEFAULT NULL,p_customer_building_ids uuid[] DEFAULT NULL,p_organization_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
  v_method_ids uuid[];
  v_pattern text;
  v_q text;
  v_result jsonb;
BEGIN
  IF p_order IS NULL OR p_order NOT IN ('web','id_asc') OR (p_order='web' AND p_after_id IS NOT NULL) THEN RAISE EXCEPTION 'shared_read_order_invalid' USING ERRCODE='22023'; END IF;
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_list_v1 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF (p_view_status IS NOT NULL AND p_view_status NOT IN ('active', 'cancelled', 'all'))
     OR (p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid'))
     OR (p_adjustment_review_status IS NOT NULL AND p_adjustment_review_status NOT IN ('pending', 'checked'))
     OR (p_limit IS NOT NULL AND p_limit < 1) OR (p_offset IS NOT NULL AND p_offset < 0) THEN
    RAISE EXCEPTION 'Tham số danh sách hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;

  v_scope := public.invoice_scope_building_ids_v1();
  IF p_payment_method IS NOT NULL THEN
    -- Chỉ gom phiếu thu đúng phương thức đang bấm, không gom toàn lịch sử mọi phương thức.
    SELECT coalesce((SELECT m.invoice_ids FROM public.invoice_receipt_methods_v1(NULL, p_payment_method) m), '{}'::uuid[])
      INTO v_method_ids;
  END IF;
  -- Ô tìm kiếm như web cũ: , ( ) → khoảng trắng, gộp khoảng trắng (kể cả khoảng trắng Unicode
  -- mà \s của JavaScript nhận), cắt hai đầu; '*' là '%' như PostgREST. Rỗng ⇒ không lọc.
  v_q := btrim(regexp_replace(regexp_replace(coalesce(p_search, ''), '[,()]', ' ', 'g'),
           '[\s' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233)
             || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', ' ', 'g'));
  IF v_q <> '' THEN
    v_pattern := '%' || replace(v_q, '*', '%') || '%';
  END IF;

  WITH search_hits AS MATERIALIZED (
    -- Hợp đồng có khách khớp tên — khách và liên kết đọc qua RLS (customers.view…) như web.
    SELECT DISTINCT cc.contract_id
      FROM public.customers cu
      JOIN public.contract_customers cc ON cc.customer_id = cu.id
     WHERE v_pattern IS NOT NULL AND cu.full_name ILIKE v_pattern AND cc.contract_id IS NOT NULL
  ),
  matched AS MATERIALIZED (
    SELECT i.id, i.billing_month, i.created_at, vb.name_sort AS building_sort, vr.name_sort AS room_sort
      FROM public.invoices i
      -- Như ORDER BY building(name_sort)/room(name_sort) của PostgREST: toà/phòng đọc qua RLS.
      LEFT JOIN public.buildings vb ON vb.id = i.building_id
      LEFT JOIN public.rooms vr ON vr.id = i.room_id
     WHERE i.deleted_at IS NULL
       AND (p_organization_id IS NULL OR i.organization_id=p_organization_id)
       AND (p_order='web' OR vr.id IS NOT NULL)
       AND i.building_id = ANY (v_scope)
       AND (p_building_ids IS NULL OR i.building_id = ANY (p_building_ids))
       AND (p_filter_building_ids IS NULL OR i.building_id = ANY (p_filter_building_ids))
       AND (p_room_ids IS NULL OR i.room_id = ANY (p_room_ids))
       AND (p_contract_id IS NULL OR i.contract_id = p_contract_id)
       AND (p_status IS NULL OR i.status = p_status)
       AND (p_payment_status IS NULL
            OR (p_payment_status = 'paid' AND i.status = 'PAID')
            OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
            -- Chưa thu đồng nào: loại cả PAID lẫn PARTIAL_PAID.
            OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID', 'PARTIAL_PAID')))
       -- Vòng đời: mặc định 'active' ẩn hoá đơn huỷ, trừ khi đã chọn đích danh một trạng thái.
       AND CASE coalesce(p_view_status, 'active')
             WHEN 'active' THEN p_status IS NOT NULL OR i.status <> 'CANCELLED'
             WHEN 'cancelled' THEN i.status = 'CANCELLED'
             ELSE true
           END
       AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
       AND (p_issue_date_from IS NULL OR i.issue_date >= p_issue_date_from)
       AND (p_issue_date_to IS NULL OR i.issue_date <= p_issue_date_to)
       -- Gõ số vào ô tìm: tổng tiền ± 5.000đ (AMOUNT_SEARCH_TOLERANCE của web).
       AND (p_amount_target IS NULL
            OR i.total_amount BETWEEN p_amount_target - 5000 AND p_amount_target + 5000)
       AND (p_adjustment_review_status IS NULL
            OR i.adjustment_review_status = CASE p_adjustment_review_status WHEN 'pending' THEN 'PENDING' ELSE 'CHECKED' END)
       -- Bấm thẻ TM/TK/TT/CT: hoá đơn có ít nhất một phiếu thu còn hiệu lực đúng phương thức.
       AND (p_payment_method IS NULL OR i.id = ANY (v_method_ids))
       AND (v_pattern IS NULL
            OR i.invoice_number ILIKE v_pattern
            OR (p_customer_building_ids IS NULL OR i.building_id=ANY(p_customer_building_ids)) AND i.contract_id IN (SELECT h.contract_id FROM search_hits h))
  ),
  -- Kỳ mới nhất trước; trong kỳ: toà A→Z → phòng (name_sort) → mới tạo trước; id chốt thứ tự.
  page AS MATERIALIZED (
    SELECT m.*
      FROM matched m
     WHERE p_after_id IS NULL OR m.id>p_after_id
     ORDER BY CASE WHEN p_order='web' THEN m.billing_month END DESC,CASE WHEN p_order='web' THEN m.building_sort END ASC NULLS LAST,CASE WHEN p_order='web' THEN m.room_sort END ASC NULLS LAST,
              CASE WHEN p_order='web' THEN m.created_at END DESC,m.id
     LIMIT least(coalesce(p_limit, 20), 1000) OFFSET coalesce(p_offset, 0)
  ),
  page_methods AS MATERIALIZED (
    SELECT u.invoice_id, jsonb_agg(m.payment_method ORDER BY m.payment_method) AS methods
      -- coalesce: trang rỗng phải là '{}' (không phải NULL = mọi hoá đơn trong phạm vi).
      FROM public.invoice_receipt_methods_v1((SELECT coalesce(array_agg(p.id), '{}'::uuid[]) FROM page p), NULL) m
     CROSS JOIN LATERAL unnest(m.invoice_ids) AS u(invoice_id)
     WHERE p_order='web'
     GROUP BY u.invoice_id
  )
  SELECT jsonb_build_object(
    'total_count', (SELECT count(*) FROM matched),
    'rows', coalesce((
      SELECT jsonb_agg(
        to_jsonb(i) || CASE WHEN p_order='web' THEN jsonb_build_object(
          'contract', (
            SELECT jsonb_build_object(
              'id', c.id, 'contract_number', c.contract_number, 'status', c.status,
              'public_code', c.public_code, 'start_billing_date', c.start_billing_date,
              'contract_customers', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', cc.id, 'is_representative', cc.is_representative,
                  'customer', (SELECT jsonb_build_object('id', cu.id, 'full_name', cu.full_name, 'phone', cu.phone)
                                 FROM public.customers cu WHERE cu.id = cc.customer_id))
                  ORDER BY cc.created_at, cc.id)
                  FROM public.contract_customers cc
                 WHERE cc.contract_id = c.id), '[]'::jsonb))
              FROM public.contracts c
             WHERE c.id = i.contract_id),
          'building', CASE WHEN vb.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', vb.id, 'name', vb.name, 'name_sort', vb.name_sort,
            'default_account_id_tt', vb.default_account_id_tt, 'default_account_id_tk', vb.default_account_id_tk) END,
          'room', CASE WHEN vr.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', vr.id, 'name', vr.name, 'name_sort', vr.name_sort) END,
          'invoice_items', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', ii.id, 'type', ii.type, 'accounting_class', ii.accounting_class,
              'description', ii.description, 'unit_price', ii.unit_price, 'quantity', ii.quantity,
              'coefficient', ii.coefficient, 'amount', ii.amount, 'service_id', ii.service_id,
              'previous_reading', ii.previous_reading, 'current_reading', ii.current_reading,
              'from_date', ii.from_date, 'to_date', ii.to_date, 'sort_order', ii.sort_order)
              ORDER BY ii.sort_order, ii.id)
              FROM public.invoice_items ii
             WHERE ii.invoice_id = i.id), '[]'::jsonb),
          -- Chỉ phiếu thu chưa đảo (web cũ lọc reversed_at ở trình duyệt).
          'payments', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', pm.id, 'amount', pm.amount, 'payment_date', pm.payment_date,
              'payment_method', pm.payment_method, 'notes', pm.notes,
              'receipt_image_url', pm.receipt_image_url, 'collection_id', pm.collection_id,
              'reversed_at', pm.reversed_at)
              ORDER BY pm.payment_date, pm.id)
              FROM public.payments pm
             WHERE pm.invoice_id = i.id AND pm.reversed_at IS NULL), '[]'::jsonb),
          'invoice_adjustments', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'id', ad.id, 'organization_id', ad.organization_id, 'invoice_id', ad.invoice_id,
              'revision', ad.revision, 'idempotency_key', ad.idempotency_key, 'reason', ad.reason,
              'before_snapshot', ad.before_snapshot, 'after_snapshot', ad.after_snapshot,
              'before_total', ad.before_total, 'after_total', ad.after_total, 'delta', ad.delta,
              'adjusted_by', ad.adjusted_by, 'adjusted_at', ad.adjusted_at,
              'review_status', ad.review_status, 'checked_by', ad.checked_by, 'checked_at', ad.checked_at)
              ORDER BY ad.revision, ad.id)
              FROM public.invoice_adjustments ad
             WHERE ad.invoice_id = i.id), '[]'::jsonb),
          -- Phương thức của các phiếu thu còn hiệu lực (tô màu thẻ TM/TK/TT/CT trên dòng).
          'active_payment_methods', coalesce(pmx.methods, '[]'::jsonb)) ELSE '{}'::jsonb END
        ORDER BY CASE WHEN p_order='web' THEN p.billing_month END DESC,CASE WHEN p_order='web' THEN p.building_sort END ASC NULLS LAST,CASE WHEN p_order='web' THEN p.room_sort END ASC NULLS LAST,
                 CASE WHEN p_order='web' THEN p.created_at END DESC,p.id)
        FROM page p
        JOIN public.invoices i ON i.id = p.id
        LEFT JOIN public.buildings vb ON vb.id = i.building_id
        LEFT JOIN public.rooms vr ON vr.id = i.room_id
        LEFT JOIN page_methods pmx ON pmx.invoice_id = p.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.invoice_list_v1(
  p_billing_month text DEFAULT NULL,
  p_view_status text DEFAULT 'active',
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_amount_target numeric DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_adjustment_review_status text DEFAULT NULL,
  p_payment_method public.payment_method DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
 RETURN public.invoice_list_core_v1(p_billing_month,p_view_status,p_status,p_payment_status,p_filter_building_ids,p_room_ids,p_contract_id,p_issue_date_from,p_issue_date_to,p_amount_target,p_search,p_adjustment_review_status,p_payment_method,p_building_ids,p_limit,p_offset);
END
$fn$;


-- Parsed SQL body binds helper OIDs at creation. Business rows remain INVOKER:
-- never execute this reader from a SECURITY DEFINER broker/adapter.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_read_rows_fast_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
BEGIN ATOMIC
 WITH plan AS MATERIALIZED (
  SELECT p_plan p WHERE current_user='authenticated' AND p_plan->>'userId'=auth.uid()::text
 ), source AS MATERIALIZED (
  SELECT p,CASE p->>'domain'
   WHEN 'customers' THEN public.customer_list_core_v1(
    p_organization_id=>(p->>'organizationId')::uuid,p_search=>p->>'query',
    p_building_ids=>CASE WHEN (p->>'orgWide')::boolean THEN NULL ELSE ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x) END,
    p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_include_location=>jsonb_array_length(p->'contractBuildingIds')>0,
    p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,
    p_location_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'contractBuildingIds') x))
   WHEN 'contracts' THEN public.contract_list_core_v1(
    p_search=>p->>'query',p_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x),
    p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_with_customers=>jsonb_array_length(p->'customerBuildingIds')>0,
    p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,p_exact_status=>p->>'status',
    p_customer_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'customerBuildingIds') x),p_organization_id=>(p->>'organizationId')::uuid)
   WHEN 'invoices' THEN public.invoice_list_core_v1(
    p_view_status=>'all',p_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x),
    p_search=>p->>'query',p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,
    p_customer_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'customerBuildingIds') x),p_organization_id=>(p->>'organizationId')::uuid) END data
  FROM plan
 ), projected AS MATERIALIZED (
  SELECT p,e->>'id' id,CASE p->>'domain'
   WHEN 'customers' THEN jsonb_build_object('id',e->'id','name',public.hermes_read_text_v1(COALESCE(e->>'full_name','')),
    'phone',public.hermes_read_text_v1(e->>'phone'),'contractId',e->'hermes_contract_id','buildingId',e->'current_building_id',
    'roomId',e->'hermes_room_id','roomName',public.hermes_read_text_v1(e->>'current_room_name'))
   WHEN 'contracts' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'contract_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e#>'{room,building_id}','roomId',e->'room_id','startDate',e->'start_date','endDate',e->'end_date')
   WHEN 'invoices' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e->'building_id','roomId',e->'room_id',
    'billingMonth',public.hermes_read_text_v1(e->>'billing_month'),'totalAmount',COALESCE((e->>'total_amount')::numeric,0)::text) END item
  FROM source CROSS JOIN LATERAL jsonb_array_elements(data->'rows') e
  WHERE p->>'domain'='customers' OR p->>'domain'='invoices' AND e->>'room_id' IS NOT NULL OR e#>>'{room,id}' IS NOT NULL
 ), result AS (
  SELECT p,jsonb_build_object('organizationId',p->'organizationId','domain',p->>'domain',
   'items',COALESCE((SELECT jsonb_agg(item ORDER BY id) FROM (SELECT item,id FROM projected ORDER BY id LIMIT (p_plan->>'limit')::integer) page),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM projected)>(p->>'limit')::integer
    THEN (SELECT to_jsonb(id) FROM projected ORDER BY id OFFSET (p_plan->>'limit')::integer-1 LIMIT 1) ELSE 'null'::jsonb END)
   || CASE WHEN p->>'domain'='customers' THEN jsonb_build_object('fetchedAt',p->'fetchedAt') ELSE '{}'::jsonb END value FROM plan
 ) SELECT value FROM result;
END;

DO $acl$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(ARRAY['customer_list_core_v1','contract_list_core_v1','invoice_list_core_v1','hermes_read_text_v1'])
   OR n.nspname='app_private' AND p.proname='hermes_domain_read_rows_fast_v1' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',fn);
 END LOOP;
END $acl$;
NOTIFY pgrst,'reload schema';
COMMIT;
