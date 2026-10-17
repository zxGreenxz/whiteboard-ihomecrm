-- Danh sách Hợp đồng (/contracts) thành hàm SQL dùng chung (chủ chốt 17/10/2026): web, Hermes và
-- báo cáo cùng gọi public.contract_list_v1 + public.contract_stats_v2, không mỗi nơi tự chép bộ
-- lọc + nhãn trạng thái.
--
-- MÔ HÌNH QUYỀN (quyết định chung 18/10/2026, review PR #197 — giống customer_list_v1):
-- SECURITY INVOKER + RLS. Hàm đọc contracts / rooms / buildings / contract_customers / customers
-- BẰNG RLS CỦA NGƯỜI GỌI, nên tập dòng trùng tập web thấy theo cấu trúc, không theo bản chép luật
-- (bản DEFINER trước đó chép policy: policy đổi thì hàm lệch mà không gì báo đỏ). Policy đã bọc
-- InitPlan ⇒ hàm quyền chạy một lần mỗi câu, không theo dòng.
--   * Chỉ chạy bằng JWT người dùng: current_user phải là `authenticated` và auth.uid() có giá trị.
--     Gọi từ thân hàm SECURITY DEFINER sẽ chạy bằng quyền chủ hàm và bỏ qua RLS ⇒ bị chặn 42501.
--     Hermes gọi qua đường INVOKER bằng JWT người dùng.
--   * p_building_ids CHỈ THU HẸP (AND thêm vào RLS): NULL = toàn phạm vi RLS, '{}' = rỗng.
--   * p_with_customers = false ẩn thêm khách (Hermes truyền theo khoá Read của kết nối).
--
-- Chép ĐÚNG đường đọc web trước khi đổi (src/hooks/useContracts.ts — fetchContractsPagedOnce +
-- resolveContractSearchOr; nhãn src/types/contract.ts getContractDisplayStatus):
--   * vòng đời ALL | ACTIVE (mọi trạng thái trừ TERMINATED) | TERMINATED;
--   * ô thống kê ALL | EXPIRING | EXPIRED | TERMINATED — lọc bằng CHÍNH nhãn hiển thị;
--   * tháng 'YYYY-MM': [start_date, end_date] giao tháng; toà (p_building_ids); tên phòng đúng tên;
--   * tìm: số HĐ, tên/SĐT khách (customers thấy được qua RLS), tên phòng — ILIKE '%từ%', bỏ
--     , ( ) " ' \ % như web, gộp khoảng trắng, '*' là ký tự đại diện như PostgREST;
--   * mới tạo trước (created_at DESC), hoà theo id; trả tổng dòng cho phân trang.
-- contract_stats_v2: bốn ô thống kê (tổng / sắp hết hạn / quá hạn / đã thanh lý) cùng RLS, cùng
-- mốc ngày, cùng hàm nhãn với danh sách ⇒ số trên ô khớp số dòng khi bấm ô.
--
-- NGÀY: một mốc org_today_v1() (múi giờ công ty, mặc định Asia/Ho_Chi_Minh) cho nhãn lẫn bộ lọc.
-- Web trước đây tính nhãn theo ngày UTC (end_date đọc như 00:00 UTC) nhưng lọc theo ngày máy ⇒
-- lệch 00:00–07:00 giờ VN; nay JS getContractDisplayStatus cũng tính theo ngày VN.
--
-- Khác web cũ (cố ý): không cắt tìm khách ở 200 khách / 500 liên kết / 200 phòng; hoà created_at
-- xếp theo id; tháng sai dạng báo 22023 (web lọc bỏ trước khi gọi); trang quá cuối trả rỗng + tổng.
-- Không DROP, không đổi hàm cũ, không ghi dữ liệu.

-- Nhãn hiển thị: đúng thứ tự getContractDisplayStatus (src/types/contract.ts). Hàm thuần.
CREATE OR REPLACE FUNCTION public.contract_display_status_v1(
  p_status text,
  p_expected_move_out_date date,
  p_end_date date,
  p_today date
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN p_status = 'TERMINATED' THEN 'TERMINATED'
    WHEN p_status = 'TRANSFERRED' THEN 'TRANSFERRED'
    WHEN p_status = 'DRAFT' THEN 'DRAFT'
    WHEN p_expected_move_out_date IS NOT NULL THEN 'MOVING_OUT'
    WHEN p_end_date < p_today THEN 'EXPIRED'
    WHEN p_end_date <= p_today + 30 THEN 'EXPIRING'
    ELSE 'ACTIVE'
  END
$fn$;

-- Chữ của nhãn: đúng CONTRACT_STATUS_CONFIG[...].label (src/types/contract.ts). Hàm thuần.
CREATE OR REPLACE FUNCTION public.contract_display_label_v1(p_display_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT CASE p_display_status
    WHEN 'ACTIVE' THEN 'Còn hạn'
    WHEN 'EXPIRING' THEN 'Sắp hết hạn'
    WHEN 'EXPIRED' THEN 'Quá hạn'
    WHEN 'MOVING_OUT' THEN 'Sắp chuyển đi'
    WHEN 'TERMINATED' THEN 'Đã thanh lý'
    WHEN 'TRANSFERRED' THEN 'Đã nhượng'
    WHEN 'DRAFT' THEN 'Nháp'
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

  -- Mỗi bảng chỉ được tham chiếu MỘT lần trong câu: mỗi lần tham chiếu là một lượt policy RLS
  -- với các InitPlan riêng (accessible_*_ids ≈ 35 ms/lượt đo trên TEST 18/10/2026).
  WITH links AS MATERIALIZED (
    -- Liên kết HĐ–khách thấy được (RLS contract_customers) + khách thấy được (RLS customers, LEFT
    -- JOIN như embed web): dùng chung cho tìm theo khách và cột contract_customers của trang.
    SELECT cc.id, cc.contract_id, cc.customer_id, cc.is_representative, cc.created_at,
           cu.id AS cu_id, cu.full_name, cu.phone
      FROM public.contract_customers cc
      LEFT JOIN public.customers cu ON cu.id = cc.customer_id
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
            OR (v_customers AND EXISTS (
                  SELECT 1
                    FROM links l
                   WHERE l.contract_id = c.id
                     AND l.cu_id IS NOT NULL
                     AND (l.full_name ILIKE v_pattern OR l.phone ILIKE v_pattern))))
  ),
  page AS MATERIALIZED (
    SELECT h.*
      FROM hits h
     ORDER BY h.created_at DESC, h.id
     LIMIT v_limit OFFSET v_offset
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
      FROM links l
     WHERE l.contract_id IN (SELECT p.id FROM page p)
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
               ORDER BY p.created_at DESC, p.id)
        FROM page p
        LEFT JOIN public.buildings b ON b.id = p.building_id
        LEFT JOIN people pe ON pe.contract_id = p.id
    ), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

-- Bốn ô thống kê: cùng RLS, cùng mốc ngày, cùng hàm nhãn với contract_list_v1.
CREATE OR REPLACE FUNCTION public.contract_stats_v2(p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_today date;
  v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'contract_stats_v2 chỉ chạy bằng JWT người dùng (vai authenticated).' USING ERRCODE = '42501';
  END IF;
  IF array_position(p_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Danh sách toà có phần tử rỗng.' USING ERRCODE = '22023';
  END IF;
  v_today := public.org_today_v1(NULL);

  SELECT jsonb_build_object(
           'total', count(*),
           'expiring', count(*) FILTER (WHERE d.display_status = 'EXPIRING'),
           'expired', count(*) FILTER (WHERE d.display_status = 'EXPIRED'),
           'terminated', count(*) FILTER (WHERE c.status::text = 'TERMINATED'),
           'today', v_today)
    INTO v_result
    FROM public.contracts c
   CROSS JOIN LATERAL (
     SELECT public.contract_display_status_v1(c.status::text, c.expected_move_out_date, c.end_date, v_today)
       AS display_status
   ) d
   WHERE c.deleted_at IS NULL
     -- Như get_contract_stats: chỉ chạm rooms (thêm một lượt RLS) khi thật sự lọc toà.
     AND (p_building_ids IS NULL OR EXISTS (
           SELECT 1 FROM public.rooms r WHERE r.id = c.room_id AND r.building_id = ANY (p_building_ids)));

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) IS
  'Danh sách Hợp đồng dùng chung (web /contracts, Hermes, báo cáo). INVOKER: RLS của người gọi, chỉ gọi bằng JWT người dùng. Trả {total, today, rows[]}; hàng = cột contracts + display_status/display_label + room{building} + contract_customers{customer}. p_building_ids chỉ thu hẹp (NULL = toàn phạm vi RLS, {} = rỗng); p_with_customers=false ẩn khách. Migration 20261017115636.';
COMMENT ON FUNCTION public.contract_stats_v2(uuid[]) IS
  'Bốn ô thống kê màn Hợp đồng (total/expiring/expired/terminated + today). INVOKER: RLS của người gọi; cùng mốc ngày và hàm nhãn với contract_list_v1. Migration 20261017115636.';

ALTER FUNCTION public.contract_display_status_v1(text, date, date, date) OWNER TO postgres;
ALTER FUNCTION public.contract_display_label_v1(text) OWNER TO postgres;
ALTER FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) OWNER TO postgres;
ALTER FUNCTION public.contract_stats_v2(uuid[]) OWNER TO postgres;

-- Chỉ người dùng đăng nhập (JWT). Hai hàm nhãn thuần cũng chỉ mở cho authenticated vì hàm INVOKER
-- gọi chúng bằng vai người dùng.
REVOKE ALL ON FUNCTION public.contract_display_status_v1(text, date, date, date),
  public.contract_display_label_v1(text),
  public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean),
  public.contract_stats_v2(uuid[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.contract_display_status_v1(text, date, date, date),
  public.contract_display_label_v1(text),
  public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean),
  public.contract_stats_v2(uuid[])
  TO authenticated;

DO $assert$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.contract_display_status_v1(text, date, date, date)'::regprocedure,
    'public.contract_display_label_v1(text)'::regprocedure,
    'public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)'::regprocedure,
    'public.contract_stats_v2(uuid[])'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% vẫn EXECUTE được bởi anon/service_role', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% thiếu EXECUTE cho authenticated', v_fn;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (
       'public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)'::regprocedure,
       'public.contract_stats_v2(uuid[])'::regprocedure) AND prosecdef) THEN
    RAISE EXCEPTION 'contract_list_v1/contract_stats_v2 phải là SECURITY INVOKER (đọc bằng RLS người gọi)';
  END IF;
END
$assert$;

NOTIFY pgrst, 'reload schema';
