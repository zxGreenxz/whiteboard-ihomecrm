-- Hermes đọc đầy đủ — ĐỢT 2, Gói D: tài sản, danh mục, toà/phòng, báo cáo BĐS (18/10/2026).
-- Chạy SAU nền Gói 0 (20261018000000 + 000500 + 000600 cổng INVOKER + 000700 rào công ty). Chủ chốt 17/10: theo ĐÚNG quyền user trên
-- web, giao với overlay và phạm vi toà của kết nối; đủ 7 báo cáo BĐS; chỗ web hở thì Hermes chặt hơn.
--
-- Mô hình (quyết định kiến trúc 18/10 sau hai review độc lập): INVOKER + RLS.
--  * Màn web có RPC ⇒ gọi thẳng (get_room_cash_lifecycle_v1). Màn web đọc bảng thẳng ⇒ hàm SQL DÙNG CHUNG
--    public.<miền>_<báo cáo>_v1: SECURITY INVOKER, search_path='', từ chối khi current_user <> authenticated
--    hoặc auth.uid() NULL, tự kiểm khoá web của màn (can_access_org_entity, như RequirePermission) khi web gọi
--    thẳng; đọc bảng gốc DƯỚI RLS CỦA NGƯỜI GỌI (không chép policy) theo đúng bộ lọc màn web;
--    p_building_ids chỉ THU HẸP (NULL = toàn phạm vi RLS, '{}' = rỗng). Báo cáo web không phân trang (cắt
--    1000 dòng) thì tổng hợp trong SQL. Đủ chuẩn để web gọi sau; KHÔNG trang web nào bị chuyển đợt này.
--  * Mọi hàm trả bảng có cột organization_id lấy từ CỘT của bảng neo mà hàm lọc p_organization_id tường minh
--    (RLS của super admin / người nhiều công ty phủ cả công ty khác): cổng 000700 so từng hàng với công ty kết nối.
--  * Phần phải vượt RLS: một helper DEFINER nhỏ public.areas_in_scope_v1 (RLS areas_select_rbac còn đọc
--    staff_assignments cũ ⇒ web có thể mất tên khu): chỉ trả khu có toà thuộc phạm vi toà thật của người gọi.
--  * File này CHỈ có hàm dùng chung của miền (RPC web gọi được, GRANT authenticated) + public.report_text_v1 (chữ an
--    toàn cho đầu ra); không hàm Hermes nào. Bảng báo cáo và hàm đọc INVOKER của gói (search_path=pg_catalog,public,
--    không gọi schema nội bộ) ở 20261018040100: thu hẹp theo toà của khoá báo cáo ∩ overlay kết nối (ctx.buildings)
--    và che trường theo khoá phụ của kết nối.
--  * Thân plpgsql không được Postgres kiểm lúc tạo: chứng minh bằng PGlite (fixture có RLS giả lập) và gọi
--    thật dưới vai từng người dùng trên TEST.
--
-- Bảng báo cáo (khớp infra/hermes-broker/wave2-d-contract.mjs): re_vacant_rooms, re_expiring,
-- re_renewals_transfers, re_promotions, re_new_leases, re_terminations, re_expense_ratio
-- (src/hooks/reports/realEstateReports.ts), assets, services, service_quotas, suppliers, meters, buildings,
-- areas, building_detail, rooms, room_detail, room_cash_lifecycle, floors, ie_types, task_types, hotlines.
-- Bỏ: D2 (loại/di chuyển/bảo trì tài sản: ba trang cài đặt là PlaceholderPage, TEST 0 dòng), D11 (danh mục
-- chung / tài khoản ngân hàng: trang giữ chỗ, không bảng).
-- Danh sách trắng cột: toà KHÔNG trả commission_*, default_account_id_*, public_contact_*, toạ độ; nhà cung
-- cấp chỉ id,name; loại việc bỏ bonus_amount, counts_for_salary; loại thu chi ẩn hạng mục hạn chế/lương/cổ
-- đông; tài sản bỏ images/description; công tơ bỏ serial/manufacturer/model.
-- Không DROP, không ALTER TABLE, không ghi dữ liệu, không gọi hàm của trợ lý cũ.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';


-- ============================================================================================
-- A. HÀM DÙNG CHUNG (public, SECURITY INVOKER + RLS của người gọi).
-- ============================================================================================

-- A1. Phòng trống (useVacantRoomsReport, realEstateReports.ts:24-116): phòng chưa xoá, không có HĐ ACTIVE,
-- trạng thái khác RESERVED; số ngày trống = hôm nay − ngày kết thúc muộn nhất của HĐ TERMINATED/EXPIRED
-- (actual_end_date, không có thì end_date). Lọc tầng = rooms.floor. Web không phân trang (cắt 1000).
CREATE OR REPLACE FUNCTION public.real_estate_vacant_rooms_v1(p_organization_id uuid,p_building_ids uuid[],
  p_floor integer DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(room_id uuid,room_name text,building_id uuid,building_name text,floor integer,area numeric,rent_price numeric,
  status text,last_end_date date,days_vacant integer,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=vacant_rooms) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','vacant_rooms'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT r.id,r.name,r.building_id,b.name,r.floor,r.area,r.rent_price,r.status::text,ended.last_end,(v_today-ended.last_end)::integer,b.organization_id
  FROM public.rooms r
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT max(COALESCE(c.actual_end_date,c.end_date)) last_end FROM public.contracts c
    WHERE c.room_id=r.id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text IN ('TERMINATED','EXPIRED')) ended ON true
  WHERE (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids)) AND r.deleted_at IS NULL AND r.status::text<>'RESERVED'
    AND (p_floor IS NULL OR r.floor=p_floor)
    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
      AND c.status::text='ACTIVE')
  ORDER BY b.name,r.name,r.id;
END $fn$;

-- A2. HĐ sắp hết hạn (useExpiringContractsReport, realEstateReports.ts:343-402): HĐ ACTIVE chưa xoá,
-- end_date trong [hôm nay, hôm nay + số ngày]; lọc toà/tầng của phòng; sắp end_date. Khách: đại diện
-- (contract_customers, không có thì khách đầu tiên) như báo cáo Gia hạn — web 4 báo cáo còn nhúng bảng tenants
-- cũ (contracts.tenant_id rỗng ở mọi HĐ trên TEST 18/10 ⇒ web luôn "N/A").
CREATE OR REPLACE FUNCTION public.real_estate_expiring_contracts_v1(p_organization_id uuid,p_building_ids uuid[],
  p_days integer DEFAULT NULL,p_floor integer DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,start_date date,end_date date,days_left integer,rent_price numeric,
  room_id uuid,room_name text,floor integer,building_id uuid,building_name text,customer_id uuid,customer_name text,customer_phone text,
  customer_email text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=expiring) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','expiring'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.start_date,c.end_date,(c.end_date-v_today)::integer,c.rent_price,
    r.id,r.name,r.floor,b.id,b.name,rep.id,rep.full_name,rep.phone,rep.email,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone,cu.email FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='ACTIVE'
    AND c.end_date BETWEEN v_today AND v_today+GREATEST(COALESCE(p_days,30),0)
    AND (p_floor IS NULL OR r.floor=p_floor)
  ORDER BY c.end_date,b.name,r.name,c.id;
END $fn$;

-- A3. Gia hạn & chuyển nhượng (useRenewalsTransfersReport, realEstateReports.ts:415-503): gia hạn =
-- contract_extensions APPROVED/COMPLETED theo extension_date, HĐ chưa xoá, giá = new_rent_price hoặc giá HĐ;
-- chuyển nhượng = HĐ TRANSFERRED chưa xoá theo start_date, ngày hiển thị = updated_at (giờ công ty).
CREATE OR REPLACE FUNCTION public.real_estate_renewals_transfers_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(kind text,event_id uuid,contract_id uuid,contract_number text,event_date date,rent_price numeric,room_id uuid,room_name text,
  building_id uuid,building_name text,customer_id uuid,customer_name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_tz text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=renewals_transfers) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','renewals_transfers'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_tz:=COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=p_organization_id),'Asia/Ho_Chi_Minh');
  RETURN QUERY
  SELECT x.kind,x.event_id,x.contract_id,x.contract_number,x.event_date,x.rent_price,x.room_id,x.room_name,x.building_id,x.building_name,
    x.customer_id,x.customer_name,x.organization_id FROM (
    SELECT 'RENEWAL'::text kind,e.id event_id,c.id contract_id,c.contract_number,e.extension_date event_date,
      COALESCE(e.new_rent_price,c.rent_price) rent_price,r.id room_id,r.name room_name,b.id building_id,b.name building_name,
      rep.id customer_id,rep.full_name customer_name,c.organization_id
    FROM public.contract_extensions e
    JOIN public.contracts c ON c.id=e.contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    LEFT JOIN LATERAL (SELECT cu.id,cu.full_name FROM public.contract_customers cc
      JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
      WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
    WHERE e.status IN ('APPROVED','COMPLETED') AND (p_from IS NULL OR e.extension_date>=p_from) AND (p_to IS NULL OR e.extension_date<=p_to)
    UNION ALL
    SELECT 'TRANSFER'::text,c.id,c.id,c.contract_number,(c.updated_at AT TIME ZONE v_tz)::date,c.rent_price,r.id,r.name,b.id,b.name,rep.id,rep.full_name,
      c.organization_id
    FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    LEFT JOIN LATERAL (SELECT cu.id,cu.full_name FROM public.contract_customers cc
      JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
      WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
    WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='TRANSFERRED'
      AND (p_from IS NULL OR c.start_date>=p_from) AND (p_to IS NULL OR c.start_date<=p_to)) x
  ORDER BY x.event_date DESC,x.kind,x.contract_number,x.event_id;
END $fn$;

-- A4. Khuyến mại (usePromotionsReport, realEstateReports.ts:699-766): HĐ chưa xoá có discounts IS NOT NULL,
-- signed_date trong kỳ; giảm giá tính ĐÚNG như web (amount || value || 0; type 'percent' ⇒ % giá thuê, khác
-- ⇒ cố định; giá sau giảm ≥ 0). Kèm months/amount_per_month của khuôn dữ liệu thật (web đọc amount/value nên
-- với khuôn {months,amount_per_month} web luôn ra 0).
CREATE OR REPLACE FUNCTION public.real_estate_promotions_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,signed_date date,start_date date,end_date date,rent_price numeric,
  discount_type text,discount_amount numeric,savings numeric,effective_rent numeric,promotion_name text,discount_months integer,
  amount_per_month numeric,room_id uuid,room_name text,building_id uuid,building_name text,customer_id uuid,customer_name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=promotions) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','promotions'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.signed_date,c.start_date,c.end_date,c.rent_price,d.dtype,d.amount,s.savings,
    GREATEST(c.rent_price-s.savings,0),d.pname,d.months,d.per_month,r.id,r.name,b.id,b.name,rep.id,rep.full_name,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  CROSS JOIN LATERAL (SELECT
      CASE WHEN jsonb_typeof(c.discounts)='object' AND c.discounts->>'type'='percent' THEN 'percent' ELSE 'fixed' END dtype,
      CASE WHEN jsonb_typeof(c.discounts)<>'object' THEN 0::numeric
        WHEN jsonb_typeof(c.discounts->'amount')='number' AND (c.discounts->>'amount')::numeric<>0 THEN (c.discounts->>'amount')::numeric
        WHEN jsonb_typeof(c.discounts->'value')='number' THEN (c.discounts->>'value')::numeric
        ELSE 0::numeric END amount,
      CASE WHEN jsonb_typeof(c.discounts)='object' THEN COALESCE(NULLIF(c.discounts->>'name',''),NULLIF(c.discounts->>'description','')) END pname,
      CASE WHEN jsonb_typeof(c.discounts->'months')='number' AND (c.discounts->>'months')::numeric BETWEEN 0 AND 1200
        THEN round((c.discounts->>'months')::numeric)::integer END months,
      CASE WHEN jsonb_typeof(c.discounts->'amount_per_month')='number' THEN (c.discounts->>'amount_per_month')::numeric END per_month) d
  CROSS JOIN LATERAL (SELECT CASE WHEN d.dtype='percent' THEN c.rent_price*d.amount/100 ELSE d.amount END savings) s
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.discounts IS NOT NULL
    AND (p_from IS NULL OR c.signed_date>=p_from) AND (p_to IS NULL OR c.signed_date<=p_to)
  ORDER BY c.signed_date DESC,c.contract_number,c.id;
END $fn$;

-- A5. HĐ mới (useNewLeasesReport, realEstateReports.ts:771-832): HĐ chưa xoá (mọi trạng thái) theo
-- signed_date; thời hạn = max(1, làm tròn(số ngày end−start / 30)); tổng giá trị = giá thuê × thời hạn.
CREATE OR REPLACE FUNCTION public.real_estate_new_leases_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,signed_date date,start_date date,end_date date,rent_price numeric,
  total_deposit numeric,payment_cycle text,duration_months integer,total_value numeric,room_id uuid,room_name text,building_id uuid,
  building_name text,customer_id uuid,customer_name text,customer_phone text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=new_leases) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','new_leases'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.signed_date,c.start_date,c.end_date,c.rent_price,c.total_deposit,c.payment_cycle::text,
    m.months,c.rent_price*m.months,r.id,r.name,b.id,b.name,rep.id,rep.full_name,rep.phone,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  CROSS JOIN LATERAL (SELECT GREATEST(1,round((c.end_date-c.start_date)/30.0))::integer months) m
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND (p_from IS NULL OR c.signed_date>=p_from) AND (p_to IS NULL OR c.signed_date<=p_to)
  ORDER BY c.signed_date DESC,c.contract_number,c.id;
END $fn$;

-- A6. Thanh lý (useTerminationsReport, realEstateReports.ts:837-929): HĐ TERMINATED/EXPIRED chưa xoá có ngày
-- kết thúc hiệu lực (actual_end_date, không có thì end_date) trong kỳ; loại/ghi chú từ contract_terminations
-- (bản mới nhất). Sắp actual_end_date giảm dần (trống xuống cuối) như web.
CREATE OR REPLACE FUNCTION public.real_estate_terminations_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,start_date date,end_date date,actual_end_date date,effective_end_date date,
  duration_days integer,rent_price numeric,total_deposit numeric,termination_type text,termination_note text,room_id uuid,room_name text,
  building_id uuid,building_name text,customer_id uuid,customer_name text,customer_phone text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=terminations) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','terminations'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.start_date,c.end_date,c.actual_end_date,COALESCE(c.actual_end_date,c.end_date),
    (COALESCE(c.actual_end_date,c.end_date)-c.start_date)::integer,c.rent_price,c.total_deposit,t.termination_type,t.notes,
    r.id,r.name,b.id,b.name,rep.id,rep.full_name,rep.phone,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT ct.termination_type,ct.notes FROM public.contract_terminations ct
    WHERE ct.contract_id=c.id AND ct.organization_id=p_organization_id ORDER BY ct.created_at DESC,ct.id DESC LIMIT 1) t ON true
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text IN ('TERMINATED','EXPIRED') AND COALESCE(c.actual_end_date,c.end_date) IS NOT NULL
    AND (p_from IS NULL OR COALESCE(c.actual_end_date,c.end_date)>=p_from)
    AND (p_to IS NULL OR COALESCE(c.actual_end_date,c.end_date)<=p_to)
  ORDER BY c.actual_end_date DESC NULLS LAST,c.id;
END $fn$;

-- A7. Mẫu số tỉ lệ thanh lý (realEstateReports.ts:897-904): HĐ chưa xoá, khác DRAFT.
CREATE OR REPLACE FUNCTION public.real_estate_contract_count_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=terminations) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','terminations'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN (SELECT count(*) FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text<>'DRAFT');
END $fn$;

-- A8. Tỷ lệ chi phí / doanh thu (useExpenseRatioReport, realEstateReports.ts:514-692): theo THÁNG trong
-- [đầu tháng from, cuối tháng to] (mặc định 6 tháng tới tháng hiện tại). Doanh thu = tổng total_amount phiếu
-- INCOME đã duyệt; chi = tổng dòng (≠0) phiếu EXPENSE đã duyệt có loại type='expense' (loại không thấy
-- được qua RLS ⇒ bỏ qua như web), nhóm theo category ("(Chưa phân nhóm)") và tên loại ("(Không tên)").
-- Phiếu có hạng mục hạn chế: RLS của web quyết; p_restricted_building_ids (chỉ thu hẹp) = NULL giữ nguyên,
-- mảng ⇒ phiếu hạn chế chỉ tính ở các toà đó. Trả hàng thô THEO TOÀ để web/Hermes tự gộp.
CREATE OR REPLACE FUNCTION public.real_estate_expense_ratio_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_category text DEFAULT NULL,p_restricted_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(row_kind text,building_id uuid,month text,category text,type_name text,amount numeric,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_to date; v_from date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission reports_real_estate action=expense_ratio) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('reports_real_estate','expense_ratio'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_to:=(date_trunc('month',COALESCE(p_to,public.org_today_v1(p_organization_id)))+interval '1 month'-interval '1 day')::date;
  v_from:=date_trunc('month',COALESCE(p_from,date_trunc('month',v_to)-interval '5 months'))::date;
  RETURN QUERY
  WITH visible AS (
    SELECT ie.id,ie.organization_id,ie.type,ie.building_id,ie.voucher_date,ie.total_amount FROM public.income_expenses ie
    WHERE ie.organization_id=p_organization_id AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids))
      AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL AND ie.voucher_date BETWEEN v_from AND v_to
      AND (p_restricted_building_ids IS NULL OR NOT COALESCE(ie.has_restricted_item,true) OR ie.building_id=ANY(p_restricted_building_ids))),
  expense AS (
    SELECT v.organization_id,v.building_id,to_char(v.voucher_date,'YYYY-MM') AS month,COALESCE(NULLIF(btrim(t.category),''),'(Chưa phân nhóm)') category,
      COALESCE(NULLIF(btrim(t.name),''),'(Không tên)') type_name,i.amount
    FROM visible v JOIN public.income_expense_items i ON i.income_expense_id=v.id
    JOIN public.income_expense_types t ON t.id=i.income_expense_type_id AND t.type='expense'
      AND (t.organization_id IS NULL OR t.organization_id=p_organization_id)
    WHERE v.type='EXPENSE' AND COALESCE(i.amount,0)<>0)
  SELECT y.row_kind,y.building_id,y.month,y.category,y.type_name,y.amount,y.organization_id FROM (
    SELECT 'revenue'::text row_kind,v.building_id,to_char(v.voucher_date,'YYYY-MM') AS month,NULL::text category,NULL::text type_name,
      sum(v.total_amount) amount,v.organization_id
    FROM visible v WHERE v.type='INCOME' GROUP BY 2,3,v.organization_id
    UNION ALL
    SELECT 'expense',e.building_id,e.month,e.category,e.type_name,sum(e.amount),e.organization_id FROM expense e
    WHERE p_category IS NULL OR e.category=p_category GROUP BY e.building_id,e.month,e.category,e.type_name,e.organization_id) y
  ORDER BY y.row_kind DESC,y.building_id,y.month,y.category,y.type_name;
END $fn$;

-- A9. Tài sản (useAssets, useAssets.ts:146-199 + filterAssets :110-121): chưa xoá; tài sản chưa gắn toà theo RLS
-- (khi thu hẹp theo toà thì chỉ kèm khi p_include_unassigned). Giá trị = (giá mua||0) × (số lượng||1).
CREATE OR REPLACE FUNCTION public.assets_list_v1(p_organization_id uuid,p_building_ids uuid[],p_include_unassigned boolean DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,p_condition text DEFAULT NULL,p_room_id uuid DEFAULT NULL)
RETURNS TABLE(asset_id uuid,code text,name text,category_id uuid,category_name text,quantity integer,total_value numeric,condition text,
  building_id uuid,building_name text,room_id uuid,room_name text,supplier_id uuid,supplier_name text,purchase_date date,created_at timestamptz,
  organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission assets) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('assets','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.category_id,cat.name,COALESCE(NULLIF(a.quantity,0),1),COALESCE(a.purchase_price,0)*COALESCE(NULLIF(a.quantity,0),1),
    a.condition::text,a.building_id,b.name,a.room_id,r.name,a.supplier_id,s.name,a.purchase_date,a.created_at,a.organization_id
  FROM public.assets a
  LEFT JOIN public.buildings b ON b.id=a.building_id
  LEFT JOIN public.rooms r ON r.id=a.room_id AND r.building_id=a.building_id
  LEFT JOIN public.asset_categories cat ON cat.id=a.category_id AND (cat.organization_id IS NULL OR cat.organization_id=p_organization_id)
  LEFT JOIN public.suppliers s ON s.id=a.supplier_id AND s.organization_id=p_organization_id
  WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL
    AND (p_building_ids IS NULL OR a.building_id=ANY(p_building_ids) OR COALESCE(p_include_unassigned,false) AND a.building_id IS NULL)
    AND (p_category_id IS NULL OR a.category_id=p_category_id) AND (p_condition IS NULL OR a.condition::text=p_condition)
    AND (p_room_id IS NULL OR a.room_id=p_room_id)
  ORDER BY a.created_at DESC,a.id;
END $fn$;

-- A10. Dịch vụ (useServices, useServices.ts:61-100): chưa xoá, lọc fee_type; toà = building_services đang bật.
-- Thu hẹp theo toà: dịch vụ áp dụng ở toà đó; dịch vụ chưa gắn toà nào chỉ khi p_include_unlinked.
CREATE OR REPLACE FUNCTION public.services_list_v1(p_organization_id uuid,p_building_ids uuid[],p_include_unlinked boolean DEFAULT NULL,
  p_fee_type text DEFAULT NULL)
RETURNS TABLE(service_id uuid,code text,name text,fee_type text,pricing_type text,unit text,unit_price numeric,is_default boolean,building_ids uuid[],
  organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission services) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('services','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT s.id,s.code,s.name,s.fee_type::text,s.pricing_type::text,s.unit,s.unit_price,s.is_default,
    ARRAY(SELECT DISTINCT bs.building_id FROM public.building_services bs WHERE bs.service_id=s.id AND bs.is_active
      AND (p_building_ids IS NULL OR bs.building_id=ANY(p_building_ids)) ORDER BY bs.building_id),s.organization_id
  FROM public.services s
  WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL AND (p_fee_type IS NULL OR s.fee_type::text=p_fee_type)
    AND (p_building_ids IS NULL
      OR EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.service_id=s.id AND bs.is_active AND bs.building_id=ANY(p_building_ids))
      OR COALESCE(p_include_unlinked,false) AND NOT EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.service_id=s.id AND bs.is_active))
  ORDER BY s.name,s.id;
END $fn$;

-- A11. Định mức dịch vụ (useServiceQuotas, useServices.ts:174-189): chưa xoá, sắp tên, kèm bậc giá (dialog sửa
-- của cùng quyền hiển thị bậc).
CREATE OR REPLACE FUNCTION public.service_quotas_list_v1(p_organization_id uuid)
RETURNS TABLE(quota_id uuid,name text,description text,tier_count integer,tiers jsonb,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission service_quotas) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('service_quotas','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT q.id,q.name,q.description,(SELECT count(*) FROM public.service_quota_tiers t WHERE t.quota_id=q.id)::integer,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('tierNumber',t.tier_number,'fromValue',t.from_value,'toValue',t.to_value,'unitPrice',t.unit_price)
      ORDER BY t.tier_number,t.id) FROM public.service_quota_tiers t WHERE t.quota_id=q.id),'[]'::jsonb),q.organization_id
  FROM public.service_quotas q WHERE q.organization_id=p_organization_id AND q.deleted_at IS NULL
  ORDER BY q.name,q.id;
END $fn$;

-- A12. Nhà cung cấp: cả app chỉ hiện id + tên (CreateAssetDialog.tsx:69, MaterialPurchaseFormDialog.tsx:46).
CREATE OR REPLACE FUNCTION public.suppliers_list_v1(p_organization_id uuid)
RETURNS TABLE(supplier_id uuid,name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission suppliers) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('suppliers','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT s.id,s.name,s.organization_id FROM public.suppliers s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL ORDER BY s.name,s.id;
END $fn$;

-- A13. Công tơ (useMeters, useMeters.ts:216-240 + view meters_with_latest_reading): chưa xoá; chỉ số chốt gần
-- nhất = meter_readings chưa xoá mới nhất theo reading_date, created_at. Lọc toà/loại/phòng.
CREATE OR REPLACE FUNCTION public.meters_list_v1(p_organization_id uuid,p_building_ids uuid[],p_meter_type text DEFAULT NULL,
  p_room_id uuid DEFAULT NULL)
RETURNS TABLE(meter_id uuid,code text,name text,meter_type text,status text,building_id uuid,building_name text,room_id uuid,room_name text,
  initial_reading numeric,latest_reading numeric,latest_reading_date date,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission meters) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('meters','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT m.id,m.code,m.name,m.meter_type::text,m.status,m.building_id,b.name,m.room_id,r.name,m.initial_reading,lr.current_reading,lr.reading_date,
    b.organization_id
  FROM public.meters m
  JOIN public.buildings b ON b.id=m.building_id AND b.organization_id=p_organization_id
  LEFT JOIN public.rooms r ON r.id=m.room_id AND r.building_id=m.building_id
  LEFT JOIN LATERAL (SELECT mr.current_reading,mr.reading_date FROM public.meter_readings mr WHERE mr.meter_id=m.id AND mr.deleted_at IS NULL
    ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1) lr ON true
  WHERE m.deleted_at IS NULL AND (p_building_ids IS NULL OR m.building_id=ANY(p_building_ids))
    AND (p_meter_type IS NULL OR m.meter_type::text=p_meter_type) AND (p_room_id IS NULL OR m.room_id=p_room_id)
  ORDER BY b.name,r.name NULLS FIRST,m.code,m.id;
END $fn$;

-- A13b. Chữ an toàn cho đầu ra (cùng luật chữ an toàn của đợt 1): giữ xuống dòng, bỏ ký tự điều khiển khác và
-- U+2028/2029, cắt theo ký tự. Thuần (không đọc bảng) nên không cần kiểm vai.
CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
   translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
   '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END
$fn$;

-- A14. Khu trong phạm vi toà THẬT của người gọi (helper DEFINER nhỏ). RLS areas_select_rbac còn đọc
-- staff_assignments cũ (cutover 25/07 đã cắt đồng bộ) nên web có thể mất tên khu dù thấy toà; helper chỉ trả
-- khu (mã/tên/trạng thái) có ít nhất một toà mà người gọi thấy theo đúng RLS buildings (has_full_building_scope
-- hoặc accessible_building_ids); khu chưa có toà chỉ khi người gọi có toàn phạm vi toà. Tự kiểm auth.uid() và
-- thành viên công ty.
CREATE OR REPLACE FUNCTION public.areas_in_scope_v1(p_organization_id uuid)
RETURNS TABLE(area_id uuid,code text,name text,status text,created_at timestamptz,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_full boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT (p_organization_id=ANY(COALESCE(public.my_org_ids(),'{}'::uuid[])))
    THEN RAISE EXCEPTION 'w2d_areas_denied' USING ERRCODE='42501'; END IF;
  IF NOT COALESCE(public.can_access_org_entity('buildings','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_full:=COALESCE(public.has_full_building_scope(),false);
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.status,a.created_at,a.organization_id FROM public.areas a
  WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL
    AND (v_full OR EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.buildings b ON b.id=ab.building_id
      AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
      WHERE ab.area_id=a.id AND ab.building_id IN (SELECT public.accessible_building_ids())));
END $fn$;

-- A15. Toà (useBuildings, useBuildings.ts:23-92): chưa xoá; DANH SÁCH TRẮNG cột; số phòng chưa xoá theo trạng
-- thái; khu đọc từ area_buildings (RLS theo toà) + areas_in_scope_v1.
CREATE OR REPLACE FUNCTION public.buildings_list_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS TABLE(building_id uuid,code text,name text,type text,status text,is_virtual boolean,total_floors integer,street_address text,ward text,
  district text,province text,description text,rooms_count integer,rooms_available integer,rooms_occupied integer,rooms_reserved integer,
  rooms_maintenance integer,rooms_unavailable integer,area_ids uuid[],area_names text[],created_at timestamptz,updated_at timestamptz,
  organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission buildings) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('buildings','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  WITH areas AS MATERIALIZED (SELECT x.area_id,x.name FROM public.areas_in_scope_v1(p_organization_id) x)
  SELECT b.id,b.code,b.name,b.type::text,b.status::text,b.is_virtual,b.total_floors,b.street_address,b.ward,b.district,b.province,b.description,
    rc.total,rc.available,rc.occupied,rc.reserved,rc.maintenance,rc.unavailable,
    ARRAY(SELECT a.area_id FROM public.area_buildings ab JOIN areas a ON a.area_id=ab.area_id WHERE ab.building_id=b.id ORDER BY a.name,a.area_id),
    ARRAY(SELECT a.name FROM public.area_buildings ab JOIN areas a ON a.area_id=ab.area_id WHERE ab.building_id=b.id ORDER BY a.name,a.area_id),
    b.created_at,b.updated_at,b.organization_id
  FROM public.buildings b
  CROSS JOIN LATERAL (SELECT count(*)::integer total,count(*) FILTER (WHERE r.status::text='AVAILABLE')::integer available,
      count(*) FILTER (WHERE r.status::text='OCCUPIED')::integer occupied,count(*) FILTER (WHERE r.status::text='RESERVED')::integer reserved,
      count(*) FILTER (WHERE r.status::text='MAINTENANCE')::integer maintenance,count(*) FILTER (WHERE r.status::text='UNAVAILABLE')::integer unavailable
    FROM public.rooms r WHERE r.building_id=b.id AND r.deleted_at IS NULL) rc
  WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
  ORDER BY b.created_at DESC,b.id;
END $fn$;

-- A16. Khu (useAreas, useAreas.ts:31-50): khu trong phạm vi (areas_in_scope_v1) có ít nhất một toà trong danh sách
-- (khu trống chỉ khi p_include_empty); toà của khu đọc qua area_buildings dưới RLS.
CREATE OR REPLACE FUNCTION public.areas_list_v1(p_organization_id uuid,p_building_ids uuid[],p_include_empty boolean DEFAULT NULL)
RETURNS TABLE(area_id uuid,code text,name text,status text,building_ids uuid[],created_at timestamptz,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission buildings) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('buildings','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT y.area_id,y.code,y.name,y.status,y.building_ids,y.created_at,y.organization_id FROM (
    SELECT a.area_id,a.code,a.name,a.status,a.created_at,a.organization_id,
      ARRAY(SELECT ab.building_id FROM public.area_buildings ab JOIN public.buildings b ON b.id=ab.building_id
        AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
        WHERE ab.area_id=a.area_id AND (p_building_ids IS NULL OR ab.building_id=ANY(p_building_ids)) ORDER BY b.name,b.id) building_ids
    FROM public.areas_in_scope_v1(p_organization_id) a) y
  WHERE cardinality(y.building_ids)>0 OR COALESCE(p_include_empty,false) OR p_building_ids IS NULL
  ORDER BY y.created_at DESC,y.area_id;
END $fn$;

-- A17. Phòng (useRooms + useRoomsWithActiveContracts + getRoomDisplayStatus, roomStatus.ts:23-41): phòng chưa
-- xoá; trạng thái hiển thị: có HĐ ACTIVE ⇒ EXPIRING_SOON khi còn 1..30 ngày, ngược lại OCCUPIED; không HĐ ⇒
-- MAINTENANCE / RESERVED theo rooms.status, còn lại AVAILABLE (kể cả UNAVAILABLE — đúng như web).
CREATE OR REPLACE FUNCTION public.rooms_list_v1(p_organization_id uuid,p_building_ids uuid[],p_as_of date DEFAULT NULL)
RETURNS TABLE(room_id uuid,name text,code text,building_id uuid,building_name text,floor integer,area numeric,rent_price numeric,deposit_amount numeric,
  max_occupants integer,status text,display_status text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission rooms) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('rooms','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT r.id,r.name,r.code,r.building_id,b.name,r.floor,r.area,r.rent_price,r.deposit_amount,r.max_occupants,r.status::text,
    CASE WHEN ac.id IS NOT NULL THEN CASE WHEN ac.end_date-v_today BETWEEN 1 AND 30 THEN 'EXPIRING_SOON' ELSE 'OCCUPIED' END
      WHEN r.status::text='MAINTENANCE' THEN 'MAINTENANCE' WHEN r.status::text='RESERVED' THEN 'RESERVED' ELSE 'AVAILABLE' END,
    b.organization_id
  FROM public.rooms r
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT c.id,c.end_date FROM public.contracts c WHERE c.room_id=r.id AND c.organization_id=p_organization_id
    AND c.deleted_at IS NULL AND c.status::text='ACTIVE'
    ORDER BY c.start_date DESC,c.id LIMIT 1) ac ON true
  WHERE r.deleted_at IS NULL AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  ORDER BY b.name,r.name,r.id;
END $fn$;

-- A18. Người đang thuê một phòng (RoomDetailPage: HĐ hiện tại + "Khách hiện tại"): HĐ ACTIVE chưa xoá của
-- phòng, mỗi hàng một khách (khách đại diện trước).
CREATE OR REPLACE FUNCTION public.room_tenancy_v1(p_organization_id uuid,p_building_ids uuid[],p_room_id uuid)
RETURNS TABLE(contract_id uuid,contract_number text,start_date date,end_date date,rent_price numeric,customer_id uuid,customer_name text,
  customer_phone text,is_representative boolean,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission rooms) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('rooms','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.start_date,c.end_date,c.rent_price,cu.id,cu.full_name,cu.phone,cc.is_representative,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND r.id=p_room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids)) AND r.deleted_at IS NULL
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN public.contract_customers cc ON cc.contract_id=c.id
  LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='ACTIVE'
  ORDER BY c.start_date DESC,c.id,cc.is_representative DESC NULLS LAST,cu.full_name,cu.id;
END $fn$;

-- A19. Tầng (useFloors, useFloors.ts:14-35): theo toà, sắp floor_number.
CREATE OR REPLACE FUNCTION public.floors_list_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS TABLE(floor_id uuid,building_id uuid,building_name text,floor_number integer,name text,description text,status text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission categories) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('categories','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT f.id,f.building_id,b.name,f.floor_number,f.name,f.description,f.status,b.organization_id
  FROM public.floors f JOIN public.buildings b ON b.id=f.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
  WHERE p_building_ids IS NULL OR f.building_id=ANY(p_building_ids)
  ORDER BY f.floor_number,b.name,f.id;
END $fn$;

-- A20. Loại thu chi (useIncomeExpenseTypes, useIncomeExpenseTypes.ts:82-176): loại của công ty (hoặc dùng chung),
-- khử trùng theo (type, lower(trim(name))) ưu tiên dòng của chính người gọi rồi dòng cũ nhất như web; trả
-- is_restricted/rule_key để lớp gọi tự ẩn khi cần.
CREATE OR REPLACE FUNCTION public.income_expense_types_list_v1(p_organization_id uuid,p_type text DEFAULT NULL)
RETURNS TABLE(type_id uuid,type text,name text,category text,description text,is_default boolean,system_only boolean,manual_hidden boolean,
  quick_entry_hidden boolean,archived boolean,sort_order integer,is_restricted boolean,rule_key text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission categories) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('categories','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT x.id,x.type,x.name,x.category,x.description,x.is_default,x.system_only,x.manual_hidden,x.quick_entry_hidden,x.archived,x.sort_order,
    x.is_restricted,x.rule_key,x.organization_id
  FROM (SELECT DISTINCT ON (t.type,lower(btrim(t.name))) t.id,t.type,t.name,t.category,t.description,t.is_default,t.system_only,t.manual_hidden,
      t.quick_entry_hidden,t.archived_at IS NOT NULL archived,t.sort_order,t.is_restricted,t.rule_key,t.organization_id
    FROM public.income_expense_types t
    WHERE (t.organization_id IS NULL OR t.organization_id=p_organization_id) AND (p_type IS NULL OR t.type=p_type)
    ORDER BY t.type,lower(btrim(t.name)),(t.user_id=auth.uid()) DESC,t.created_at,t.id) x
  ORDER BY x.archived,x.type='income',x.category NULLS LAST,x.sort_order NULLS LAST,x.name,x.id;
END $fn$;

-- A21. Loại việc (useJobTypes, useJobTypes.ts:9-25 + TaskTypeTable.tsx:59-99): KHÔNG trả bonus_amount,
-- counts_for_salary. Bộ phận/nhóm việc theo RLS của bảng đó (như embed của web).
CREATE OR REPLACE FUNCTION public.job_types_list_v1(p_organization_id uuid)
RETURNS TABLE(job_type_id uuid,name text,department_name text,job_group_id uuid,job_group_name text,customer_contact_deadline integer,
  acceptance_deadline integer,completion_deadline integer,business_hours_only boolean,is_active boolean,created_at timestamptz,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission task_types) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('task_types','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT jt.id,jt.name,d.name,g.id,g.name,jt.customer_contact_deadline,jt.acceptance_deadline,jt.completion_deadline,jt.business_hours_only,
    jt.is_active,jt.created_at,jt.organization_id
  FROM public.job_types jt
  LEFT JOIN public.departments d ON d.id=jt.default_department_id AND (d.organization_id IS NULL OR d.organization_id=p_organization_id)
  LEFT JOIN public.job_groups g ON g.id=jt.job_group_id AND g.organization_id=p_organization_id
  WHERE jt.organization_id=p_organization_id
  ORDER BY jt.created_at DESC,jt.id;
END $fn$;

-- A22. Hotline (useHotlines, useHotlines.ts:14-30).
CREATE OR REPLACE FUNCTION public.hotlines_list_v1(p_organization_id uuid)
RETURNS TABLE(hotline_id uuid,name text,phone_number text,description text,is_active boolean,created_at timestamptz,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission hotline) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('hotline','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT h.id,h.name,h.phone_number,h.description,h.is_active,h.created_at,h.organization_id FROM public.hotlines h
  WHERE h.organization_id=p_organization_id ORDER BY h.created_at DESC,h.id;
END $fn$;

-- ============================================================================================
-- C. Chủ sở hữu và quyền.
-- ============================================================================================
ALTER FUNCTION public.real_estate_vacant_rooms_v1(uuid,uuid[],integer,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_expiring_contracts_v1(uuid,uuid[],integer,integer,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_promotions_v1(uuid,uuid[],date,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_new_leases_v1(uuid,uuid[],date,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_terminations_v1(uuid,uuid[],date,date) OWNER TO postgres;
ALTER FUNCTION public.real_estate_contract_count_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.real_estate_expense_ratio_v1(uuid,uuid[],date,date,text,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.assets_list_v1(uuid,uuid[],boolean,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.services_list_v1(uuid,uuid[],boolean,text) OWNER TO postgres;
ALTER FUNCTION public.service_quotas_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.suppliers_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.meters_list_v1(uuid,uuid[],text,uuid) OWNER TO postgres;
ALTER FUNCTION public.buildings_list_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.areas_list_v1(uuid,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION public.rooms_list_v1(uuid,uuid[],date) OWNER TO postgres;
ALTER FUNCTION public.room_tenancy_v1(uuid,uuid[],uuid) OWNER TO postgres;
ALTER FUNCTION public.floors_list_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.income_expense_types_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.job_types_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hotlines_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.areas_in_scope_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
-- Hàm dùng chung: chỉ người đăng nhập (INVOKER ⇒ RLS của họ; helper khu DEFINER tự kiểm); không anon/PUBLIC/service_role.
REVOKE ALL ON FUNCTION
  public.real_estate_vacant_rooms_v1(uuid,uuid[],integer,date),public.real_estate_expiring_contracts_v1(uuid,uuid[],integer,integer,date),
  public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date),public.real_estate_promotions_v1(uuid,uuid[],date,date),
  public.real_estate_new_leases_v1(uuid,uuid[],date,date),public.real_estate_terminations_v1(uuid,uuid[],date,date),
  public.real_estate_contract_count_v1(uuid,uuid[]),public.real_estate_expense_ratio_v1(uuid,uuid[],date,date,text,uuid[]),
  public.assets_list_v1(uuid,uuid[],boolean,uuid,text,uuid),public.services_list_v1(uuid,uuid[],boolean,text),
  public.service_quotas_list_v1(uuid),public.suppliers_list_v1(uuid),public.meters_list_v1(uuid,uuid[],text,uuid),
  public.buildings_list_v1(uuid,uuid[]),public.areas_list_v1(uuid,uuid[],boolean),public.rooms_list_v1(uuid,uuid[],date),
  public.room_tenancy_v1(uuid,uuid[],uuid),public.floors_list_v1(uuid,uuid[]),public.income_expense_types_list_v1(uuid,text),
  public.job_types_list_v1(uuid),public.hotlines_list_v1(uuid),public.areas_in_scope_v1(uuid),public.report_text_v1(text,integer)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION
  public.real_estate_vacant_rooms_v1(uuid,uuid[],integer,date),public.real_estate_expiring_contracts_v1(uuid,uuid[],integer,integer,date),
  public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date),public.real_estate_promotions_v1(uuid,uuid[],date,date),
  public.real_estate_new_leases_v1(uuid,uuid[],date,date),public.real_estate_terminations_v1(uuid,uuid[],date,date),
  public.real_estate_contract_count_v1(uuid,uuid[]),public.real_estate_expense_ratio_v1(uuid,uuid[],date,date,text,uuid[]),
  public.assets_list_v1(uuid,uuid[],boolean,uuid,text,uuid),public.services_list_v1(uuid,uuid[],boolean,text),
  public.service_quotas_list_v1(uuid),public.suppliers_list_v1(uuid),public.meters_list_v1(uuid,uuid[],text,uuid),
  public.buildings_list_v1(uuid,uuid[]),public.areas_list_v1(uuid,uuid[],boolean),public.rooms_list_v1(uuid,uuid[],date),
  public.room_tenancy_v1(uuid,uuid[],uuid),public.floors_list_v1(uuid,uuid[]),public.income_expense_types_list_v1(uuid,text),
  public.job_types_list_v1(uuid),public.hotlines_list_v1(uuid),public.areas_in_scope_v1(uuid),public.report_text_v1(text,integer)
  TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
