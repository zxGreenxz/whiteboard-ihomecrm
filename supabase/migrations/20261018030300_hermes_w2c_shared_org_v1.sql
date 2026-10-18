-- Đợt 2 "đọc đầy đủ như user", Gói C, 18/10/2026 — HÀM DÙNG CHUNG trả thêm cột organization_id (cột nguồn).
-- Chạy SAU 20261018030100 (bản đầu của các hàm này) và 20261018000700 (rào công ty của nền: mọi hàng báo cáo
-- công ty — trừ dữ liệu của chính người hỏi — phải tự nêu công ty lấy từ CỘT nguồn; bước kết thúc so với công ty
-- kết nối, khác ⇒ 42501, rồi gỡ trường này trước khi trả). RLS của super admin / người nhiều công ty phủ cả công ty
-- khác: cột này để lớp gọi kiểm lại được, không thay bộ lọc p_organization_id tường minh trong hàm.
-- Tám hàm đổi kiểu trả về (thêm organization_id ở CUỐI, sau cột cũ) nên phải DROP rồi CREATE: chúng mới có từ
-- 20261018030100, chưa phát hành production, chưa màn web nào gọi; thân hàm chép nguyên bản 20261018030100, chỉ
-- thêm cột. ACL đặt lại như bản đầu (chỉ authenticated). Hàm không đổi: safe_text_v1, utc_instant_v1,
-- json_number_v1, notifications_inbox_v1 và salary_locked_lines_v1 (dữ liệu của chính người gọi), salary_is_admin_v1.
-- Không ghi dữ liệu nghiệp vụ, không đổi bảng/policy.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- /vehicles (useVehicles.ts:39-130): xe chưa xoá, mới tạo trước; tìm biển số/tên xe/chủ xe/tên khách (khách nhìn
-- thấy theo RLS customers). Tự kiểm khoá vehicles.view: xe gắn toà chỉ ở toà can_do_on_building('vehicles','view'),
-- xe không gắn toà chỉ khi can_access_org_entity('vehicles','view'); RLS vehicles vẫn áp. Thu hẹp: p_building_ids
-- (NULL = mọi toà được phép, '{}' = rỗng), p_customer_building_ids (toà mà tên/SĐT khách được hiện; NULL = theo RLS),
-- p_include_unassigned (xe không gắn toà).
DROP FUNCTION IF EXISTS public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer);
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
  SELECT x.id,x.vehicle_type::text,x.vehicle_name,x.license_plate,x.color,x.owner_name,x.ticket_number,x.parking_fee,
    x.building_id,x.b_name,x.room_id,x.r_name,
    CASE WHEN x.customer_visible THEN x.customer_id END,CASE WHEN x.customer_visible THEN x.cu_name END,
    CASE WHEN x.customer_visible THEN x.cu_phone END,x.created_at,count(*) OVER (),x.organization_id
  FROM base x
  WHERE (p_vehicle_type IS NULL OR x.vehicle_type::text=p_vehicle_type)
    AND (p_room_id IS NULL OR x.room_id=p_room_id)
    AND (p_customer_id IS NULL OR x.customer_id=p_customer_id AND x.customer_visible)
    AND (v_pattern IS NULL OR x.license_plate ILIKE v_pattern OR x.vehicle_name ILIKE v_pattern OR x.owner_name ILIKE v_pattern
      OR x.customer_visible AND x.cu_name ILIKE v_pattern)
  ORDER BY x.created_at DESC,x.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- /materials (useMaterials.ts:20-62): vật tư chưa xoá, sắp tên rồi id; tìm tên/mã/mô tả (chứa, không
-- phân biệt hoa thường như toLowerCase().includes); "sắp hết" = on_hand <= reorder_level.
-- low_stock_count = số vật tư sắp hết trong tập đã lọc (badge tab của MaterialsListContent.tsx:78-80).
DROP FUNCTION IF EXISTS public.materials_items_v1(uuid,text,uuid,boolean,integer,integer);
CREATE OR REPLACE FUNCTION public.materials_items_v1(p_organization_id uuid,p_query text DEFAULT NULL,p_category_id uuid DEFAULT NULL,
  p_low_stock boolean DEFAULT false,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,code text,name text,category_id uuid,category_name text,unit text,on_hand numeric,reorder_level numeric,avg_unit_cost numeric,
  low_stock boolean,total_count bigint,low_stock_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_query text:=lower(NULLIF(btrim(p_query),''));
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_items_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'materials_items_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT m.id,m.code,m.name,m.category_id,mc.name,m.unit,m.on_hand,m.reorder_level,m.avg_unit_cost,m.on_hand<=m.reorder_level,
    count(*) OVER (),count(*) FILTER (WHERE m.on_hand<=m.reorder_level) OVER (),m.organization_id
  FROM public.materials m
  LEFT JOIN public.material_categories mc ON mc.id=m.category_id AND mc.organization_id=p_organization_id
  WHERE m.organization_id=p_organization_id AND m.deleted_at IS NULL
    AND (p_category_id IS NULL OR m.category_id=p_category_id)
    AND (v_query IS NULL OR strpos(lower(m.name),v_query)>0 OR strpos(lower(COALESCE(m.code,'')),v_query)>0
      OR strpos(lower(COALESCE(m.description,'')),v_query)>0)
    AND (NOT COALESCE(p_low_stock,false) OR m.on_hand<=m.reorder_level)
  ORDER BY m.name,m.id
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- Danh mục vật tư (useMaterialCategories.ts:12-28): sắp tên; kèm số vật tư đang dùng danh mục.
DROP FUNCTION IF EXISTS public.materials_categories_v1(uuid);
CREATE OR REPLACE FUNCTION public.materials_categories_v1(p_organization_id uuid)
RETURNS TABLE(id uuid,name text,description text,material_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_categories_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'materials_categories_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT mc.id,mc.name,mc.description,(SELECT count(*) FROM public.materials m
    WHERE m.category_id=mc.id AND m.organization_id=p_organization_id AND m.deleted_at IS NULL),mc.organization_id
  FROM public.material_categories mc WHERE mc.organization_id=p_organization_id
  ORDER BY mc.name,mc.id;
END $fn$;

-- /materials/purchases (useMaterialPurchases.ts:24-35): phiếu nhập mới trước (ngày, giờ tạo); lọc ngày.
-- Tên NCC: embed suppliers chịu RLS suppliers.view ∧ chủ hồ sơ; p_show_suppliers=false thu hẹp (không hiện NCC).
-- Lọc theo NCC chỉ khi NCC hiện được.
DROP FUNCTION IF EXISTS public.materials_purchases_v1(uuid,date,date,uuid,boolean,integer,integer);
CREATE OR REPLACE FUNCTION public.materials_purchases_v1(p_organization_id uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL,p_show_suppliers boolean DEFAULT true,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,code text,purchase_date date,supplier_id uuid,supplier_name text,total numeric,notes text,item_count integer,items jsonb,
  created_at timestamptz,total_count bigint,total_amount numeric,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_purchases_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'materials_purchases_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT p.*,s.id AS s_id,s.name AS s_name
    FROM public.material_purchases p
    LEFT JOIN public.suppliers s ON COALESCE(p_show_suppliers,true) AND s.id=p.supplier_id AND s.organization_id=p_organization_id
    WHERE p.organization_id=p_organization_id AND (p_from IS NULL OR p.purchase_date>=p_from) AND (p_to IS NULL OR p.purchase_date<=p_to)
  )
  SELECT x.id,x.code,x.purchase_date,x.s_id,x.s_name,x.total,x.notes,
    (SELECT count(*)::integer FROM public.material_purchase_items i WHERE i.purchase_id=x.id),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l.material_id,'materialName',l.m_name,'unit',l.m_unit,
       'quantity',l.quantity,'unitPrice',l.unit_price,'lineTotal',l.line_total) ORDER BY l.m_name,l.id),'[]'::jsonb)
     FROM (SELECT i.id,i.material_id,i.quantity,i.unit_price,i.line_total,m.name AS m_name,m.unit AS m_unit
       FROM public.material_purchase_items i LEFT JOIN public.materials m ON m.id=i.material_id AND m.organization_id=p_organization_id
       WHERE i.purchase_id=x.id ORDER BY m.name,i.id LIMIT 50) l),
    x.created_at,count(*) OVER (),sum(x.total) OVER (),x.organization_id
  FROM base x
  WHERE p_supplier_id IS NULL OR x.s_id=p_supplier_id
  ORDER BY x.purchase_date DESC,x.created_at DESC,x.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- /materials/usages (useMaterialUsages.ts:18-35): phiếu xuất mới trước; người tạo theo profiles.
-- Việc (jobs) chịu RLS theo toà; p_job_building_ids thu hẹp thêm (NULL = theo RLS): mã/tên việc chỉ hiện khi việc
-- thuộc công ty và toà nằm trong danh sách. Người tạo theo RLS profiles (như web). Tổng SL/thành tiền như MaterialUsagesContent.tsx:80-84.
DROP FUNCTION IF EXISTS public.materials_usages_v1(uuid,date,date,uuid[],integer,integer);
CREATE OR REPLACE FUNCTION public.materials_usages_v1(p_organization_id uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL,
  p_job_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,code text,usage_date date,job_id uuid,job_code text,job_title text,creator_name text,notes text,item_count integer,
  total_quantity numeric,total_cost numeric,items jsonb,created_at timestamptz,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_usages_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'materials_usages_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT u.id,u.code,u.usage_date,j.id,j.code,j.title,pr.full_name,u.notes,
    (SELECT count(*)::integer FROM public.material_usage_items i WHERE i.usage_id=u.id),
    (SELECT COALESCE(sum(i.quantity),0) FROM public.material_usage_items i WHERE i.usage_id=u.id),
    (SELECT round(COALESCE(sum(i.quantity*i.unit_cost_at_usage),0),2) FROM public.material_usage_items i WHERE i.usage_id=u.id),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l.material_id,'materialName',l.m_name,'unit',l.m_unit,
       'quantity',l.quantity,'unitCost',l.unit_cost_at_usage) ORDER BY l.m_name,l.id),'[]'::jsonb)
     FROM (SELECT i.id,i.material_id,i.quantity,i.unit_cost_at_usage,m.name AS m_name,m.unit AS m_unit
       FROM public.material_usage_items i LEFT JOIN public.materials m ON m.id=i.material_id AND m.organization_id=p_organization_id
       WHERE i.usage_id=u.id ORDER BY m.name,i.id LIMIT 50) l),
    u.created_at,count(*) OVER (),u.organization_id
  FROM public.material_usages u
  LEFT JOIN public.jobs j ON j.id=u.job_id AND j.organization_id=p_organization_id
    AND (p_job_building_ids IS NULL OR j.building_id=ANY(p_job_building_ids))
  LEFT JOIN public.profiles pr ON pr.id=u.user_id
  WHERE u.organization_id=p_organization_id AND (p_from IS NULL OR u.usage_date>=p_from) AND (p_to IS NULL OR u.usage_date<=p_to)
  ORDER BY u.usage_date DESC,u.created_at DESC,u.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- /materials/adjustments (useMaterialAdjustments.ts:17-25): phiếu kiểm kê/điều chỉnh mới trước; IN/OUT.
DROP FUNCTION IF EXISTS public.materials_adjustments_v1(uuid,date,date,text,integer,integer);
CREATE OR REPLACE FUNCTION public.materials_adjustments_v1(p_organization_id uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL,
  p_type text DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid,code text,adjustment_date date,type text,reason text,item_count integer,items jsonb,created_at timestamptz,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_adjustments_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 10000 OR COALESCE(p_offset,0)<0
    THEN RAISE EXCEPTION 'materials_adjustments_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT a.id,a.code,a.adjustment_date,a.type,a.reason,
    (SELECT count(*)::integer FROM public.material_adjustment_items i WHERE i.adjustment_id=a.id),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l.material_id,'materialName',l.m_name,'unit',l.m_unit,'quantity',l.quantity)
       ORDER BY l.m_name,l.id),'[]'::jsonb)
     FROM (SELECT i.id,i.material_id,i.quantity,m.name AS m_name,m.unit AS m_unit
       FROM public.material_adjustment_items i LEFT JOIN public.materials m ON m.id=i.material_id AND m.organization_id=p_organization_id
       WHERE i.adjustment_id=a.id ORDER BY m.name,i.id LIMIT 50) l),
    a.created_at,count(*) OVER (),a.organization_id
  FROM public.material_adjustments a
  WHERE a.organization_id=p_organization_id AND (p_from IS NULL OR a.adjustment_date>=p_from) AND (p_to IS NULL OR a.adjustment_date<=p_to)
    AND (p_type IS NULL OR a.type=p_type)
  ORDER BY a.adjustment_date DESC,a.created_at DESC,a.id DESC
  LIMIT p_limit OFFSET COALESCE(p_offset,0);
END $fn$;

-- Kho tài sản (useAssetWarehouses.ts:14-38): sắp tên. Tự kiểm khoá warehouses.view (toà: can_do_on_building; kho
-- không gắn toà: can_access_org_entity); RLS asset_warehouses vẫn áp. Thu hẹp: p_building_ids, p_include_unassigned.
DROP FUNCTION IF EXISTS public.warehouses_list_v1(uuid,uuid[],boolean,text);
CREATE OR REPLACE FUNCTION public.warehouses_list_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_include_unassigned boolean DEFAULT true,p_query text DEFAULT NULL)
RETURNS TABLE(id uuid,name text,location text,building_id uuid,building_name text,total_count bigint,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_query text:=lower(NULLIF(btrim(p_query),'')); v_allowed uuid[]; v_unassigned boolean;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'warehouses_list_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'warehouses_list_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_allowed FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('warehouses','view',b.id);
  v_unassigned:=COALESCE(p_include_unassigned,true) AND public.can_access_org_entity('warehouses','view');
  RETURN QUERY
  SELECT w.id,w.name,w.location,w.building_id,b.name,count(*) OVER (),w.organization_id
  FROM public.asset_warehouses w
  LEFT JOIN public.buildings b ON b.id=w.building_id AND b.organization_id=p_organization_id
  WHERE w.organization_id=p_organization_id
    AND ((w.building_id IS NOT NULL AND w.building_id=ANY(v_allowed)) OR (w.building_id IS NULL AND v_unassigned))
    AND (v_query IS NULL OR strpos(lower(w.name),v_query)>0 OR strpos(lower(COALESCE(w.location,'')),v_query)>0)
  ORDER BY w.name,w.id;
END $fn$;

-- Lương tháng ĐÃ CHỐT (salary_monthly status LOCKED; lock_salary_month_v2 đóng băng số). Quản lý = cấu hình
-- manager_salary_config còn hiệu lực đầu tháng (useManagerSalary.ts:113-125). Đọc dưới RLS lương của người gọi
-- (chủ bảng lương / chính mình / super admin — như trang web); không là admin trang lương thì chỉ dòng của chính
-- mình (thu hẹp như ManagerSalaryPage.tsx:104-107). Số đã chốt đọc nguyên cột (useManagerSalary.ts:567-583);
-- "Đã trả" là cột sống (trigger phiếu chi). Dòng chưa chốt: status DRAFT/NONE, mọi số NULL (không đoán).
-- Khác web (ghi để báo chủ): trang hiện lương cứng/đầu tư/ứng SỐNG kể cả tháng đã chốt; hàm này dùng số
-- đã chốt (base_salary, investment_profit, advances_total) để cộng khớp gross_total.
DROP FUNCTION IF EXISTS public.salary_locked_month_v1(uuid,date,uuid[]);
CREATE OR REPLACE FUNCTION public.salary_locked_month_v1(p_organization_id uuid,p_period_month date,p_staff_ids uuid[] DEFAULT NULL)
RETURNS TABLE(staff_id uuid,staff_name text,role_title text,status text,locked_at timestamptz,base_salary numeric,work_bonus numeric,
  contract_bonus numeric,adjustments_total numeric,bonus_total numeric,investment_profit numeric,commission_total numeric,gross_total numeric,
  advances_total numeric,room_rent numeric,take_home numeric,paid numeric,remaining numeric,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_admin boolean;
BEGIN
  IF current_user<>'authenticated' OR v_uid IS NULL THEN RAISE EXCEPTION 'salary_locked_month_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_period_month IS NULL OR p_period_month<>date_trunc('month',p_period_month)::date
    THEN RAISE EXCEPTION 'salary_invalid' USING ERRCODE='22023'; END IF;
  v_admin:=public.salary_is_admin_v1(p_organization_id);
  RETURN QUERY
  WITH cfg AS (
    SELECT DISTINCT ON (c.staff_id) c.staff_id,c.alias,c.role_title,c.organization_id
    FROM public.manager_salary_config c
    WHERE c.organization_id=p_organization_id AND c.is_active AND c.effective_from<=p_period_month
      AND (c.effective_to IS NULL OR c.effective_to>=p_period_month)
      AND (v_admin OR c.staff_id=v_uid) AND (p_staff_ids IS NULL OR c.staff_id=ANY(p_staff_ids))
    ORDER BY c.staff_id,c.created_at,c.id
  )
  SELECT cfg.staff_id,COALESCE(NULLIF(pr.full_name,''),NULLIF(cfg.alias,''),'Quản lý'),cfg.role_title,
    CASE WHEN sm.id IS NULL THEN 'NONE' ELSE sm.status END,
    CASE WHEN sm.status='LOCKED' THEN sm.locked_at END,
    CASE WHEN sm.status='LOCKED' THEN sm.base_salary END,CASE WHEN sm.status='LOCKED' THEN sm.work_bonus END,
    CASE WHEN sm.status='LOCKED' THEN sm.contract_bonus END,CASE WHEN sm.status='LOCKED' THEN sm.adjustments_total END,
    CASE WHEN sm.status='LOCKED' THEN COALESCE(sm.work_bonus,0)+COALESCE(sm.contract_bonus,0)+COALESCE(sm.adjustments_total,0) END,
    CASE WHEN sm.status='LOCKED' THEN sm.investment_profit END,CASE WHEN sm.status='LOCKED' THEN sm.commission_total END,
    CASE WHEN sm.status='LOCKED' THEN sm.gross_total END,CASE WHEN sm.status='LOCKED' THEN sm.advances_total END,
    CASE WHEN sm.status='LOCKED' THEN sm.room_rent END,CASE WHEN sm.status='LOCKED' THEN sm.take_home END,
    CASE WHEN sm.status='LOCKED' THEN sm.paid END,
    CASE WHEN sm.status='LOCKED' THEN COALESCE(sm.take_home,0)-COALESCE(sm.paid,0) END,cfg.organization_id
  FROM cfg
  LEFT JOIN public.profiles pr ON pr.id=cfg.staff_id
  LEFT JOIN LATERAL (SELECT m.* FROM public.salary_monthly m WHERE m.staff_id=cfg.staff_id AND m.period_month=p_period_month
    AND m.organization_id=p_organization_id ORDER BY (m.status='LOCKED') DESC,m.updated_at DESC,m.id LIMIT 1) sm ON true
  ORDER BY 2,1;
END $fn$;

ALTER FUNCTION public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.materials_items_v1(uuid,text,uuid,boolean,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.materials_categories_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.materials_purchases_v1(uuid,date,date,uuid,boolean,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.materials_usages_v1(uuid,date,date,uuid[],integer,integer) OWNER TO postgres;
ALTER FUNCTION public.materials_adjustments_v1(uuid,date,date,text,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.warehouses_list_v1(uuid,uuid[],boolean,text) OWNER TO postgres;
ALTER FUNCTION public.salary_locked_month_v1(uuid,date,uuid[]) OWNER TO postgres;
-- Chỉ vai authenticated (như 20261018030100). Mọi dòng vẫn qua RLS của người gọi.
REVOKE ALL ON FUNCTION public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer),
  public.materials_items_v1(uuid,text,uuid,boolean,integer,integer),
  public.materials_categories_v1(uuid),
  public.materials_purchases_v1(uuid,date,date,uuid,boolean,integer,integer),
  public.materials_usages_v1(uuid,date,date,uuid[],integer,integer),
  public.materials_adjustments_v1(uuid,date,date,text,integer,integer),
  public.warehouses_list_v1(uuid,uuid[],boolean,text),
  public.salary_locked_month_v1(uuid,date,uuid[])
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.vehicles_list_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer),
  public.materials_items_v1(uuid,text,uuid,boolean,integer,integer),
  public.materials_categories_v1(uuid),
  public.materials_purchases_v1(uuid,date,date,uuid,boolean,integer,integer),
  public.materials_usages_v1(uuid,date,date,uuid[],integer,integer),
  public.materials_adjustments_v1(uuid,date,date,text,integer,integer),
  public.warehouses_list_v1(uuid,uuid[],boolean,text),
  public.salary_locked_month_v1(uuid,date,uuid[])
  TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
