-- Danh sách Hợp đồng (/contracts) thành MỘT hàm SQL dùng chung (chủ chốt 17/10/2026): web, Hermes
-- và báo cáo cùng gọi public.contract_list_v1, không mỗi nơi tự chép bộ lọc + nhãn trạng thái.
--
-- Chép ĐÚNG đường đọc web trước khi đổi (src/hooks/useContracts.ts — fetchContractsPagedOnce +
-- resolveContractSearchOr; nhãn src/types/contract.ts getContractDisplayStatus):
--   * vòng đời ALL | ACTIVE (mọi trạng thái trừ TERMINATED) | TERMINATED;
--   * ô thống kê ALL | EXPIRING | EXPIRED | TERMINATED — nay lọc bằng CHÍNH nhãn hiển thị;
--   * tháng 'YYYY-MM': [start_date, end_date] giao tháng; toà (p_building_ids); tên phòng đúng tên;
--   * tìm: số HĐ, tên/SĐT khách (chỉ khi người gọi thấy khách), tên phòng — ILIKE '%từ%', bỏ
--     , ( ) " ' \ % như web, gộp khoảng trắng, '*' là ký tự đại diện như PostgREST;
--   * mới tạo trước (created_at DESC), hoà thì theo id; trả tổng dòng cho phân trang.
--
-- QUYỀN — kiểm MỘT lần mỗi lượt (CTE ctx), không theo từng dòng. Hàm SECURITY DEFINER nên RLS
-- KHÔNG chạy; điều kiện trong thân chép nguyên văn các policy SELECT hiện hành (đọc từ
-- pg_policies TEST 17/10/2026) của contracts / rooms / buildings / contract_customers /
-- customers: *_select_rbac + *_super_admin_all (PERMISSIVE) ∧ *_org_boundary +
-- *_hide_demo_admin + *_hide_sandbox_admin (RESTRICTIVE), từng vế bọc IS TRUE như RLS.
-- Vì vậy gọi từ PostgREST (vai authenticated) hay từ hàm DEFINER của Hermes (auth.uid() vẫn là
-- người dùng trong JWT) đều ra CÙNG một kết quả.
--   * p_building_ids CHỈ THU HẸP: hàng luôn phải qua phạm vi thật trước; '{}' = không toà nào.
--   * Khách (tên/SĐT, tìm theo khách): đúng RLS bảng customers của web — can_access_org_entity
--     ('customers','view') (quyền ở BẤT KỲ phạm vi nào) ∧ chủ bản ghi thuộc thành viên công ty
--     (current_visible_owner_ids). Web KHÔNG xét customers.view theo từng toà; hàm giữ nguyên
--     hành vi đó. p_with_customers = false ẩn thêm (Hermes truyền theo khoá Read của kết nối).
--
-- NGÀY: web tính nhãn bằng Math.ceil((Date(end_date) - now)/1 ngày) — end_date đọc như 00:00 UTC
-- nên thực chất so theo NGÀY UTC; còn lọc EXPIRING/EXPIRED dùng ngày máy (giờ VN). Hai mốc lệch
-- nhau 00:00–07:00 giờ VN. Hàm dùng MỘT mốc: org_today_v1() (múi giờ công ty, mặc định
-- Asia/Ho_Chi_Minh) cho cả nhãn lẫn bộ lọc; từ 07:00 đến 24:00 giờ VN kết quả trùng web.
--
-- Khác web (cố ý, ghi rõ):
--   * web cắt tìm khách ở 200 khách / 500 liên kết HĐ–khách, tìm phòng ở 200 phòng (truy vấn
--     phụ không sắp xếp); hàm không cắt;
--   * p_month sai dạng: web lặng lẽ bỏ lọc (YYYY-MM sai tháng thì PostgREST lỗi); hàm báo 22023;
--   * hoà created_at: web không có khoá phụ; hàm thêm id để phân trang ổn định.
-- Không DROP, không đổi hàm cũ, không ghi dữ liệu.

-- Nhãn hiển thị: đúng thứ tự getContractDisplayStatus (src/types/contract.ts).
CREATE OR REPLACE FUNCTION app_private.contract_display_status_v1(
  p_status text,
  p_expected_move_out_date date,
  p_end_date date,
  p_today date
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
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

-- Chữ của nhãn: đúng CONTRACT_STATUS_CONFIG[...].label (src/types/contract.ts).
CREATE OR REPLACE FUNCTION app_private.contract_display_label_v1(p_display_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
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

-- Người gọi + tham số: kiểm đăng nhập và giá trị bộ lọc, báo lỗi thay vì trả rỗng che lỗi.
-- plpgsql chỉ vì cần RAISE; hàm danh sách chính vẫn là LANGUAGE sql.
CREATE OR REPLACE FUNCTION app_private.contract_list_args_v1(
  p_search text,
  p_lifecycle text,
  p_stat text,
  p_month text,
  p_limit integer,
  p_offset integer
) RETURNS TABLE (
  actor_id uuid,
  lifecycle_filter text,
  stat_filter text,
  month_start date,
  month_end date,
  search_pattern text,
  row_limit integer,
  row_offset integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_safe text;
BEGIN
  actor_id := auth.uid();
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập. Hãy đăng nhập lại rồi thử lại.' USING ERRCODE = '42501';
  END IF;

  lifecycle_filter := COALESCE(p_lifecycle, 'ALL');
  IF lifecycle_filter NOT IN ('ALL', 'ACTIVE', 'TERMINATED') THEN
    RAISE EXCEPTION 'Bộ lọc vòng đời hợp đồng không hợp lệ: %', lifecycle_filter USING ERRCODE = '22023';
  END IF;

  stat_filter := COALESCE(p_stat, 'ALL');
  IF stat_filter NOT IN ('ALL', 'EXPIRING', 'EXPIRED', 'TERMINATED') THEN
    RAISE EXCEPTION 'Bộ lọc trạng thái hợp đồng không hợp lệ: %', stat_filter USING ERRCODE = '22023';
  END IF;

  -- '' = không lọc tháng (web gửi month: '' → undefined).
  IF NULLIF(p_month, '') IS NOT NULL THEN
    IF p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'Tháng phải có dạng YYYY-MM: %', p_month USING ERRCODE = '22023';
    END IF;
    month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
    month_end := (month_start + interval '1 month' - interval '1 day')::date;
  END IF;

  row_limit := COALESCE(p_limit, 1000);
  row_offset := COALESCE(p_offset, 0);
  IF row_limit < 1 OR row_limit > 1000 OR row_offset < 0 THEN
    RAISE EXCEPTION 'Phân trang không hợp lệ (1–1000 dòng, vị trí ≥ 0).' USING ERRCODE = '22023';
  END IF;

  -- sanitizeSearchTerm của web: , ( ) " ' \ % thành khoảng trắng, gộp khoảng trắng (đúng tập \s
  -- của JavaScript), bỏ hai đầu. Rỗng sau khi làm sạch = không tìm.
  v_safe := btrim(regexp_replace(
    regexp_replace(COALESCE(p_search, ''), '[,()"''\\%]', ' ', 'g'),
    '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
  search_pattern := CASE WHEN v_safe = '' THEN NULL ELSE '%' || replace(v_safe, '*', '%') || '%' END;

  RETURN NEXT;
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
WITH args AS MATERIALIZED (
  SELECT * FROM app_private.contract_list_args_v1(p_search, p_lifecycle, p_stat, p_month, p_limit, p_offset)
),
-- Phạm vi của auth.uid(), tính MỘT lần. Tên hàm/biểu thức đúng như trong các policy RLS.
ctx AS MATERIALIZED (
  SELECT a.*, s.is_super, s.is_admin, s.full_scope,
         public.my_org_ids() AS my_orgs,
         CASE WHEN s.full_scope THEN NULL
              ELSE COALESCE(ARRAY(SELECT public.accessible_building_ids()), '{}'::uuid[]) END AS buildings,
         public.can_access_org_entity('customers', 'view') AS customers_any_scope,
         public.current_visible_owner_ids() AS owner_ids,
         CASE WHEN s.is_super OR s.is_admin THEN public.demo_user_ids() ELSE '{}'::uuid[] END AS demo_users,
         CASE WHEN s.is_super OR s.is_admin THEN public.demo_building_ids() ELSE '{}'::uuid[] END AS demo_buildings,
         public.sandbox_org_ids() AS sandbox_orgs,
         public.org_today_v1(NULL) AS today,
         (p_with_customers IS TRUE) AS with_customers
    FROM args a
   CROSS JOIN LATERAL (
     SELECT public.is_super_admin() AS is_super, public.is_admin() AS is_admin,
            public.has_full_building_scope() AS full_scope
   ) s
),
hits AS MATERIALIZED (
  SELECT c.id, c.created_at, v.room_ok, v.display_status
    FROM ctx
    JOIN public.contracts c ON c.deleted_at IS NULL
    LEFT JOIN public.rooms r ON r.id = c.room_id
   CROSS JOIN LATERAL (
     SELECT
       -- contracts: super_admin_all ∨ select_rbac, ∧ org_boundary ∧ hide_demo_admin ∧ hide_sandbox_admin
       ((ctx.is_super
         OR ctx.is_admin
         OR (c.room_id IS NOT NULL AND (ctx.full_scope OR r.building_id = ANY (ctx.buildings))))
        AND (c.organization_id IS NULL OR ctx.is_super OR c.organization_id = ANY (ctx.my_orgs))
        AND NOT ((ctx.is_super OR ctx.is_admin) AND c.user_id = ANY (ctx.demo_users))
        AND NOT (ctx.is_super AND COALESCE(c.organization_id = ANY (ctx.sandbox_orgs), false))
       ) IS TRUE AS contract_ok,
       -- rooms (embed room:rooms!contracts_room_id_fkey)
       (r.id IS NOT NULL
        AND ((ctx.is_super OR ctx.full_scope OR r.building_id = ANY (ctx.buildings))
             AND (r.organization_id IS NULL OR ctx.is_super OR r.organization_id = ANY (ctx.my_orgs))
             AND NOT ((ctx.is_super OR ctx.is_admin) AND r.building_id = ANY (ctx.demo_buildings))
             AND NOT (ctx.is_super AND COALESCE(r.organization_id = ANY (ctx.sandbox_orgs), false))
            ) IS TRUE) AS room_ok,
       app_private.contract_display_status_v1(c.status::text, c.expected_move_out_date, c.end_date, ctx.today)
         AS display_status
   ) v
   WHERE v.contract_ok
     AND (p_building_ids IS NULL OR (v.room_ok AND r.building_id = ANY (p_building_ids)))
     AND (p_room_name IS NULL OR (v.room_ok AND r.name = p_room_name))
     AND (ctx.lifecycle_filter = 'ALL'
          OR (ctx.lifecycle_filter = 'ACTIVE' AND c.status::text <> 'TERMINATED')
          OR (ctx.lifecycle_filter = 'TERMINATED' AND c.status::text = 'TERMINATED'))
     AND (ctx.stat_filter = 'ALL' OR v.display_status = ctx.stat_filter)
     AND (ctx.month_start IS NULL OR (c.start_date <= ctx.month_end AND c.end_date >= ctx.month_start))
     AND (ctx.search_pattern IS NULL
          OR c.contract_number ILIKE ctx.search_pattern
          OR (v.room_ok AND r.name ILIKE ctx.search_pattern)
          OR (ctx.with_customers AND EXISTS (
                SELECT 1
                  FROM public.contract_customers cc
                  JOIN public.customers cu ON cu.id = cc.customer_id
                 WHERE cc.contract_id = c.id
                   -- contract_customers: super_admin_all ∨ select_rbac (accessible_contract_ids)
                   AND ((ctx.is_super OR ctx.full_scope OR r.building_id = ANY (ctx.buildings))
                        AND (cc.organization_id IS NULL OR ctx.is_super OR cc.organization_id = ANY (ctx.my_orgs))
                        AND NOT (ctx.is_super AND COALESCE(cc.organization_id = ANY (ctx.sandbox_orgs), false))
                       ) IS TRUE
                   -- customers: super_admin_all ∨ select_rbac (customers.view ∧ chủ bản ghi)
                   AND ((ctx.is_super OR (ctx.customers_any_scope AND cu.user_id = ANY (ctx.owner_ids)))
                        AND (cu.organization_id IS NULL OR ctx.is_super OR cu.organization_id = ANY (ctx.my_orgs))
                        AND NOT ((ctx.is_super OR ctx.is_admin) AND cu.user_id = ANY (ctx.demo_users))
                        AND NOT (ctx.is_super AND COALESCE(cu.organization_id = ANY (ctx.sandbox_orgs), false))
                       ) IS TRUE
                   AND (cu.full_name ILIKE ctx.search_pattern OR cu.phone ILIKE ctx.search_pattern))))
),
page AS (
  SELECT h.*
    FROM hits h
   ORDER BY h.created_at DESC, h.id
   LIMIT (SELECT row_limit FROM ctx)
  OFFSET (SELECT row_offset FROM ctx)
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM hits),
  'today', ctx.today,
  'rows', COALESCE((
    SELECT jsonb_agg(
             to_jsonb(c) || jsonb_build_object(
               'display_status', p.display_status,
               'display_label', app_private.contract_display_label_v1(p.display_status),
               'room', CASE WHEN p.room_ok THEN jsonb_build_object(
                         'id', r.id,
                         'name', r.name,
                         'building_id', r.building_id,
                         'building', CASE WHEN (b.id IS NOT NULL
                           AND ((ctx.is_super OR ctx.full_scope OR b.id = ANY (ctx.buildings))
                                AND (b.organization_id IS NULL OR ctx.is_super OR b.organization_id = ANY (ctx.my_orgs))
                                AND NOT ((ctx.is_super OR ctx.is_admin) AND b.user_id = ANY (ctx.demo_users))
                                AND NOT (ctx.is_super AND COALESCE(b.organization_id = ANY (ctx.sandbox_orgs), false))
                               ) IS TRUE)
                           THEN jsonb_build_object('id', b.id, 'name', b.name) END) END,
               'contract_customers', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', cc.id,
                          'contract_id', cc.contract_id,
                          'customer_id', cc.customer_id,
                          'is_representative', cc.is_representative,
                          'customer', CASE WHEN ctx.with_customers AND cu.id IS NOT NULL
                            AND ((ctx.is_super OR (ctx.customers_any_scope AND cu.user_id = ANY (ctx.owner_ids)))
                                 AND (cu.organization_id IS NULL OR ctx.is_super OR cu.organization_id = ANY (ctx.my_orgs))
                                 AND NOT ((ctx.is_super OR ctx.is_admin) AND cu.user_id = ANY (ctx.demo_users))
                                 AND NOT (ctx.is_super AND COALESCE(cu.organization_id = ANY (ctx.sandbox_orgs), false))
                                ) IS TRUE
                            THEN jsonb_build_object('id', cu.id, 'full_name', cu.full_name, 'phone', cu.phone) END)
                          ORDER BY COALESCE(cc.is_representative, false) DESC, cc.created_at, cc.id)
                   FROM public.contract_customers cc
                   LEFT JOIN public.customers cu ON cu.id = cc.customer_id
                  WHERE cc.contract_id = c.id
                    AND ((ctx.is_super OR ctx.full_scope OR r.building_id = ANY (ctx.buildings))
                         AND (cc.organization_id IS NULL OR ctx.is_super OR cc.organization_id = ANY (ctx.my_orgs))
                         AND NOT (ctx.is_super AND COALESCE(cc.organization_id = ANY (ctx.sandbox_orgs), false))
                        ) IS TRUE), '[]'::jsonb))
             ORDER BY p.created_at DESC, p.id)
      FROM page p
      JOIN public.contracts c ON c.id = p.id
      LEFT JOIN public.rooms r ON r.id = c.room_id
      LEFT JOIN public.buildings b ON b.id = r.building_id
  ), '[]'::jsonb))
FROM ctx
$fn$;

COMMENT ON FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) IS
  'Danh sách Hợp đồng dùng chung (web /contracts, Hermes, báo cáo). Trả {total, today, rows[]}; mỗi hàng = cột contracts + display_status/display_label + room{building} + contract_customers{customer}. Phạm vi = RLS SELECT hiện hành của auth.uid(); p_building_ids chỉ thu hẹp; p_with_customers=false ẩn khách. Migration 20261017115636.';

ALTER FUNCTION app_private.contract_display_status_v1(text, date, date, date) OWNER TO postgres;
ALTER FUNCTION app_private.contract_display_label_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.contract_list_args_v1(text, text, text, text, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION app_private.contract_display_status_v1(text, date, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.contract_display_label_v1(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.contract_list_args_v1(text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
-- Chỉ người dùng đăng nhập (JWT). service_role không có auth.uid() nên không có phạm vi để đọc.
REVOKE ALL ON FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean) TO authenticated;

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract_list_v1 vẫn EXECUTE được bởi anon/service_role';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract_list_v1 thiếu EXECUTE cho authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.contract_list_args_v1(text, text, text, text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract_list_args_v1 không được mở cho authenticated';
  END IF;
END
$assert$;

NOTIFY pgrst, 'reload schema';
