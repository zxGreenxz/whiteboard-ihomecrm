-- Đợt 2 "đọc đầy đủ như user", Gói C, 18/10/2026 — HÀM DÙNG CHUNG sửa sau review độc lập PR #204 (head 215ac070).
-- Chạy SAU 20261018030300 (bản có cột organization_id). Bản trước đã áp TEST nên sửa bằng file kế tiếp, không sửa tại chỗ.
--  [P1] vehicles_list_v1: tên chủ xe (owner_name) là dữ liệu cá nhân của khách thuê — trước trả và cho tìm KHÔNG điều
--       kiện, thành đường vòng qua rào khách. Nay cùng rào với tên/SĐT/ID khách: chỉ khi hồ sơ khách của xe đọc được dưới
--       RLS customers của người gọi (chủ hồ sơ nằm trong tập được xem + customers.view ở toà) VÀ toà nằm trong
--       p_customer_building_ids (NULL = theo RLS). Không chứng minh được ⇒ không trả, không tìm theo tên chủ xe. Chặt hơn
--       web (/vehicles hiện owner_name của mọi xe đọc được).
--  [P2] materials_usages_v1: thêm cột total_cost_sum = tổng thành tiền của TOÀN BỘ phiếu đã lọc, tính trước LIMIT
--       (lớp gọi cắt trang mà vẫn báo đúng tổng). Đổi kiểu trả về ⇒ DROP rồi CREATE; hàm chưa phát hành production,
--       chưa màn web nào gọi; thân giữ nguyên bản 20261018030300 ngoài phần gom chi phí.
--  [P3] safe_text_v1 / utc_instant_v1 / json_number_v1: thêm guard như mọi hàm public khác (từ chối khi current_user <>
--       'authenticated' hoặc không có người gọi). Ba helper chỉ được hàm đọc của trợ lý gọi trong chuỗi INVOKER (vai
--       authenticated) nên guard không làm vỡ cách dùng hợp lệ. Đọc current_user ⇒ không còn IMMUTABLE: đổi sang
--       plpgsql STABLE (cùng chữ ký, cùng kết quả).
--  [P2] salary_is_admin_v1 giữ SECURITY DEFINER (chấp nhận có điều kiện): chỉ trả boolean về CHÍNH auth.uid(), không nhận
--       người dùng khác làm tham số, search_path='' cố định, không có quyền cho PUBLIC/anon/service_role (20261018030100).
--       Ghi lý do vào COMMENT của hàm.
-- Không ghi dữ liệu nghiệp vụ, không đổi bảng/policy.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- [P3] Helper thuần: guard người gọi, thân giữ nguyên 20261018030100.
-- Chữ dài: giữ \n, bỏ mọi ký tự điều khiển khác và U+2028/2029, cắt theo số ký tự (code point).
CREATE OR REPLACE FUNCTION public.safe_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'safe_text_denied' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
    translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
    '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END;
END $fn$;
-- Thời điểm UTC đến mili giây (khuôn ISO có đuôi Z).
CREATE OR REPLACE FUNCTION public.utc_instant_v1(p_at timestamptz)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'utc_instant_denied' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN p_at IS NULL THEN NULL ELSE to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
END $fn$;
-- Số trong JSON: giữ nguyên nếu là số, còn lại NULL.
CREATE OR REPLACE FUNCTION public.json_number_v1(p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'json_number_denied' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN jsonb_typeof(p_value)='number' THEN p_value ELSE 'null'::jsonb END;
END $fn$;

-- [P1] /vehicles (useVehicles.ts:39-130): như 20261018030300, cộng rào khách cho tên chủ xe. Xe chưa xoá, mới tạo trước;
-- tìm biển số/tên xe, và tên chủ xe/tên khách CHỈ khi hồ sơ khách của xe hiện được (customer_visible). Tự kiểm khoá
-- vehicles.view: xe gắn toà chỉ ở toà can_do_on_building('vehicles','view'), xe không gắn toà chỉ khi
-- can_access_org_entity('vehicles','view'); RLS vehicles vẫn áp. Thu hẹp: p_building_ids (NULL = mọi toà được phép,
-- '{}' = rỗng), p_customer_building_ids (toà mà tên chủ xe/tên/SĐT khách được hiện; NULL = theo RLS),
-- p_include_unassigned (xe không gắn toà).
CREATE OR REPLACE FUNCTION public.vehicles_list_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_customer_building_ids uuid[] DEFAULT NULL,p_include_unassigned boolean DEFAULT true,p_query text DEFAULT NULL,
  p_vehicle_type text DEFAULT NULL,p_room_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,vehicle_type text,vehicle_name text,license_plate text,color text,owner_name text,ticket_number text,parking_fee numeric,
  building_id uuid,building_name text,room_id uuid,room_name text,customer_id uuid,customer_name text,customer_phone text,created_at timestamptz,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_pattern text; v_allowed uuid[]; v_unassigned boolean;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'vehicles_list_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'vehicles_list_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_allowed FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('vehicles','view',b.id);
  v_unassigned:=COALESCE(p_include_unassigned,true) AND public.can_access_org_entity('vehicles','view');
  IF NULLIF(btrim(p_query),'') IS NOT NULL THEN
    v_pattern:='%'||replace(replace(replace(btrim(p_query),'\','\\'),'%','\%'),'_','\_')||'%';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT v.*,b.name AS b_name,r.name AS r_name,
      (cu.id IS NOT NULL AND (p_customer_building_ids IS NULL OR v.building_id=ANY(p_customer_building_ids))) AS customer_visible,
      cu.full_name AS cu_name,cu.phone AS cu_phone
    FROM public.vehicles v
    LEFT JOIN public.buildings b ON b.id=v.building_id AND b.organization_id=p_organization_id
    LEFT JOIN public.rooms r ON r.id=v.room_id AND r.organization_id=p_organization_id
    LEFT JOIN public.customers cu ON cu.id=v.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE v.organization_id=p_organization_id AND v.deleted_at IS NULL
      AND ((v.building_id IS NOT NULL AND v.building_id=ANY(v_allowed)) OR (v.building_id IS NULL AND v_unassigned))
  )
  SELECT x.id,x.vehicle_type::text,x.vehicle_name,x.license_plate,x.color,CASE WHEN x.customer_visible THEN x.owner_name END,x.ticket_number,
    x.parking_fee,x.building_id,x.b_name,x.room_id,x.r_name,
    CASE WHEN x.customer_visible THEN x.customer_id END,CASE WHEN x.customer_visible THEN x.cu_name END,
    CASE WHEN x.customer_visible THEN x.cu_phone END,x.created_at,count(*) OVER (),x.organization_id
  FROM base x
  WHERE (p_vehicle_type IS NULL OR x.vehicle_type::text=p_vehicle_type)
    AND (p_room_id IS NULL OR x.room_id=p_room_id)
    AND (p_customer_id IS NULL OR x.customer_id=p_customer_id AND x.customer_visible)
    AND (v_pattern IS NULL OR x.license_plate ILIKE v_pattern OR x.vehicle_name ILIKE v_pattern
      OR x.customer_visible AND (x.owner_name ILIKE v_pattern OR x.cu_name ILIKE v_pattern))
  ORDER BY x.created_at DESC,x.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- [P2] /materials/usages (useMaterialUsages.ts:18-35): như 20261018030300, cộng total_cost_sum (tổng thành tiền mọi phiếu
-- đã lọc, trước LIMIT). Phiếu xuất mới trước; người tạo theo profiles. Việc (jobs) chịu RLS theo toà; p_job_building_ids
-- thu hẹp thêm (NULL = theo RLS): mã/tên việc chỉ hiện khi việc thuộc công ty và toà nằm trong danh sách. Người tạo theo
-- RLS profiles (như web). Tổng SL/thành tiền như MaterialUsagesContent.tsx:80-84.
DROP FUNCTION IF EXISTS public.materials_usages_v1(uuid,date,date,uuid[],integer,integer);
CREATE OR REPLACE FUNCTION public.materials_usages_v1(p_organization_id uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL,
  p_job_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,code text,usage_date date,job_id uuid,job_code text,job_title text,creator_name text,notes text,item_count integer,
  total_quantity numeric,total_cost numeric,items jsonb,created_at timestamptz,total_count bigint,organization_id uuid,total_cost_sum numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_usages_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'materials_usages_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT u.id AS u_id,u.code AS u_code,u.usage_date AS u_date,j.id AS j_id,j.code AS j_code,j.title AS j_title,
      pr.full_name AS u_creator,u.notes AS u_notes,u.created_at AS u_created,u.organization_id AS u_org,
      (SELECT round(COALESCE(sum(i.quantity*i.unit_cost_at_usage),0),2) FROM public.material_usage_items i WHERE i.usage_id=u.id) AS u_cost
    FROM public.material_usages u
    LEFT JOIN public.jobs j ON j.id=u.job_id AND j.organization_id=p_organization_id
    AND (p_job_building_ids IS NULL OR j.building_id=ANY(p_job_building_ids))
    LEFT JOIN public.profiles pr ON pr.id=u.user_id
    WHERE u.organization_id=p_organization_id AND (p_from IS NULL OR u.usage_date>=p_from) AND (p_to IS NULL OR u.usage_date<=p_to)
  )
  SELECT x.u_id,x.u_code,x.u_date,x.j_id,x.j_code,x.j_title,x.u_creator,x.u_notes,
    (SELECT count(*)::integer FROM public.material_usage_items i WHERE i.usage_id=x.u_id),
    (SELECT COALESCE(sum(i.quantity),0) FROM public.material_usage_items i WHERE i.usage_id=x.u_id),
    x.u_cost,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l.material_id,'materialName',l.m_name,'unit',l.m_unit,
       'quantity',l.quantity,'unitCost',l.unit_cost_at_usage) ORDER BY l.m_name,l.id),'[]'::jsonb)
     FROM (SELECT i.id,i.material_id,i.quantity,i.unit_cost_at_usage,m.name AS m_name,m.unit AS m_unit
       FROM public.material_usage_items i LEFT JOIN public.materials m ON m.id=i.material_id AND m.organization_id=p_organization_id
       WHERE i.usage_id=x.u_id ORDER BY m.name,i.id LIMIT 50) l),
    x.u_created,count(*) OVER (),x.u_org,sum(x.u_cost) OVER ()
  FROM base x
  ORDER BY x.u_date DESC,x.u_created DESC,x.u_id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- [P2] Ngoại lệ DEFINER có chủ đích, ghi lý do ngay trên hàm (catalog).
COMMENT ON FUNCTION public.salary_is_admin_v1(uuid) IS
  'SECURITY DEFINER có chủ đích (review PR #204): chỉ trả boolean "CHÍNH người gọi (auth.uid()) có là admin trang lương của công ty p_organization_id không" (super admin, hoặc salary.lock|salary.manage_salary|salary.distribute toàn công ty — ManagerSalaryPage.tsx:104-107). Không nhận người dùng khác làm tham số, không đọc bảng lương, search_path rỗng cố định, chỉ vai authenticated được EXECUTE. Cần DEFINER vì authorized_scope_v3 nằm ở schema riêng mà vai authenticated không có USAGE.';

ALTER FUNCTION public.safe_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION public.utc_instant_v1(timestamptz) OWNER TO postgres;
ALTER FUNCTION public.json_number_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.materials_usages_v1(uuid,date,date,uuid[],integer,integer) OWNER TO postgres;
-- Chỉ vai authenticated (như 20261018030100). CREATE OR REPLACE giữ ACL; hàm vừa tạo lại thì đặt lại ACL.
REVOKE ALL ON FUNCTION public.safe_text_v1(text,integer),
  public.utc_instant_v1(timestamptz),
  public.json_number_v1(jsonb),
  public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer),
  public.materials_usages_v1(uuid,date,date,uuid[],integer,integer)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.safe_text_v1(text,integer),
  public.utc_instant_v1(timestamptz),
  public.json_number_v1(jsonb),
  public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer),
  public.materials_usages_v1(uuid,date,date,uuid[],integer,integer)
  TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
