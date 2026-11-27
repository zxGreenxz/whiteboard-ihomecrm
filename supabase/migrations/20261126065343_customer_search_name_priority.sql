-- Ưu tiên họ tên và tên gọi khớp chính xác trên màn Khách hàng.
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
    SELECT cu.id, cu.created_at, cu.full_name, cu.customer_type, cu.is_foreign
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
    -- Xếp trên toàn bộ tập khớp trước OFFSET/LIMIT. Regex [2] giữ dấu, [1] cho tìm không dấu.
    SELECT k.id, k.created_at,
           CASE
             WHEN p_order <> 'web' OR v_patterns IS NULL THEN NULL
             WHEN normalize(btrim(k.full_name), NFC) ~* ('^' || normalize(v_patterns[2], NFC) || '$') THEN 0
             WHEN normalize(k.full_name, NFC) ~* ('(^|[[:space:]-])' || normalize(v_patterns[2], NFC) || '[[:space:]]*$') THEN 1
             WHEN k.full_name ~* ('(^|[[:space:]-])' || v_patterns[1] || '[[:space:]]*$') THEN 2
             WHEN k.full_name ~* ('(^|[[:space:]-])' || v_patterns[1] || '([[:space:]-]|$)') THEN 3
             ELSE 4
           END AS search_rank
    FROM kinded k
    WHERE p_after_id IS NULL OR k.id>p_after_id
    ORDER BY search_rank, CASE WHEN p_order='web' THEN k.created_at END DESC,CASE WHEN p_order='web' THEN k.id END DESC,k.id
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
             ORDER BY pg.search_rank, CASE WHEN p_order='web' THEN pg.created_at END DESC,CASE WHEN p_order='web' THEN pg.id END DESC,pg.id)
      FROM page pg
      JOIN public.customers cu ON cu.id = pg.id
      LEFT JOIN loc ON loc.customer_id = pg.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

COMMIT;
