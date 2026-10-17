-- Hermes đọc đầy đủ — ĐỢT 2, Gói D: tài sản, danh mục, toà/phòng, báo cáo BĐS (18/10/2026).
-- Chạy SAU 20261018000000_hermes_w2_foundation_v1 (nền Gói 0). Chủ chốt 17/10: theo ĐÚNG quyền user trên
-- web, giao với overlay và phạm vi toà của kết nối; đủ 7 báo cáo BĐS; chỗ web hở thì Hermes chặt hơn.
--
-- Mô hình (quyết định kiến trúc 18/10 sau hai review độc lập): INVOKER + RLS.
--  * Màn web có RPC ⇒ gọi thẳng (get_room_cash_lifecycle_v1). Màn web đọc bảng thẳng ⇒ hàm SQL DÙNG CHUNG
--    public.<miền>_<báo cáo>_v1: SECURITY INVOKER, search_path='', từ chối khi current_user <> authenticated
--    hoặc auth.uid() NULL; đọc bảng gốc DƯỚI RLS CỦA NGƯỜI GỌI (không chép policy) theo đúng bộ lọc màn web;
--    p_building_ids chỉ THU HẸP (NULL = toàn phạm vi RLS, '{}' = rỗng). Báo cáo web không phân trang (cắt
--    1000 dòng) thì tổng hợp trong SQL. Đủ chuẩn để web gọi sau; KHÔNG trang web nào bị chuyển đợt này.
--  * Phần phải vượt RLS: một helper DEFINER nhỏ public.areas_in_scope_v1 (RLS areas_select_rbac còn đọc
--    staff_assignments cũ ⇒ web có thể mất tên khu): chỉ trả khu có toà thuộc phạm vi toà thật của người gọi.
--  * Hàm gói app_private.hermes_w2d_* là INVOKER (cổng Gói 0 dựng ctx đã kiểm quyền): thu hẹp thêm theo
--    toà của khoá báo cáo ∩ overlay kết nối và che trường theo khoá phụ của kết nối (customers.view,
--    suppliers.view, contracts.view, categories.view, income_expenses.restricted_view, tasks.view).
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

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2_gate_v1(jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_w2d_read_v1(text,jsonb,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_w2d_catalog_v1()') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2d_requires_w2_foundation';
  END IF;
END $requires$;

-- ============================================================================================
-- A. HÀM DÙNG CHUNG (public, SECURITY INVOKER + RLS của người gọi).
-- ============================================================================================

-- A1. Phòng trống (useVacantRoomsReport, realEstateReports.ts:24-116): phòng chưa xoá, không có HĐ ACTIVE,
-- trạng thái khác RESERVED; số ngày trống = hôm nay − ngày kết thúc muộn nhất của HĐ TERMINATED/EXPIRED
-- (actual_end_date, không có thì end_date). Lọc tầng = rooms.floor. Web không phân trang (cắt 1000).
CREATE OR REPLACE FUNCTION public.real_estate_vacant_rooms_v1(p_organization_id uuid,p_building_ids uuid[],
  p_floor integer DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(room_id uuid,room_name text,building_id uuid,building_name text,floor integer,area numeric,rent_price numeric,
  status text,last_end_date date,days_vacant integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT r.id,r.name,r.building_id,b.name,r.floor,r.area,r.rent_price,r.status::text,ended.last_end,(v_today-ended.last_end)::integer
  FROM public.rooms r
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT max(COALESCE(c.actual_end_date,c.end_date)) last_end FROM public.contracts c
    WHERE c.room_id=r.id AND c.deleted_at IS NULL AND c.status::text IN ('TERMINATED','EXPIRED')) ended ON true
  WHERE (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids)) AND r.deleted_at IS NULL AND r.status::text<>'RESERVED'
    AND (p_floor IS NULL OR r.floor=p_floor)
    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.deleted_at IS NULL AND c.status::text='ACTIVE')
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
  customer_email text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.start_date,c.end_date,(c.end_date-v_today)::integer,c.rent_price,
    r.id,r.name,r.floor,b.id,b.name,rep.id,rep.full_name,rep.phone,rep.email
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone,cu.email FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.deleted_at IS NULL AND c.status::text='ACTIVE'
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
  building_id uuid,building_name text,customer_id uuid,customer_name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_tz text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  v_tz:=COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=p_organization_id),'Asia/Ho_Chi_Minh');
  RETURN QUERY
  SELECT x.kind,x.event_id,x.contract_id,x.contract_number,x.event_date,x.rent_price,x.room_id,x.room_name,x.building_id,x.building_name,
    x.customer_id,x.customer_name FROM (
    SELECT 'RENEWAL'::text kind,e.id event_id,c.id contract_id,c.contract_number,e.extension_date event_date,
      COALESCE(e.new_rent_price,c.rent_price) rent_price,r.id room_id,r.name room_name,b.id building_id,b.name building_name,
      rep.id customer_id,rep.full_name customer_name
    FROM public.contract_extensions e
    JOIN public.contracts c ON c.id=e.contract_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    LEFT JOIN LATERAL (SELECT cu.id,cu.full_name FROM public.contract_customers cc
      JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
      WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
    WHERE e.status IN ('APPROVED','COMPLETED') AND (p_from IS NULL OR e.extension_date>=p_from) AND (p_to IS NULL OR e.extension_date<=p_to)
    UNION ALL
    SELECT 'TRANSFER'::text,c.id,c.id,c.contract_number,(c.updated_at AT TIME ZONE v_tz)::date,c.rent_price,r.id,r.name,b.id,b.name,rep.id,rep.full_name
    FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    LEFT JOIN LATERAL (SELECT cu.id,cu.full_name FROM public.contract_customers cc
      JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
      WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
    WHERE c.deleted_at IS NULL AND c.status::text='TRANSFERRED'
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
  amount_per_month numeric,room_id uuid,room_name text,building_id uuid,building_name text,customer_id uuid,customer_name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.signed_date,c.start_date,c.end_date,c.rent_price,d.dtype,d.amount,s.savings,
    GREATEST(c.rent_price-s.savings,0),d.pname,d.months,d.per_month,r.id,r.name,b.id,b.name,rep.id,rep.full_name
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
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.deleted_at IS NULL AND c.discounts IS NOT NULL
    AND (p_from IS NULL OR c.signed_date>=p_from) AND (p_to IS NULL OR c.signed_date<=p_to)
  ORDER BY c.signed_date DESC,c.contract_number,c.id;
END $fn$;

-- A5. HĐ mới (useNewLeasesReport, realEstateReports.ts:771-832): HĐ chưa xoá (mọi trạng thái) theo
-- signed_date; thời hạn = max(1, làm tròn(số ngày end−start / 30)); tổng giá trị = giá thuê × thời hạn.
CREATE OR REPLACE FUNCTION public.real_estate_new_leases_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,signed_date date,start_date date,end_date date,rent_price numeric,
  total_deposit numeric,payment_cycle text,duration_months integer,total_value numeric,room_id uuid,room_name text,building_id uuid,
  building_name text,customer_id uuid,customer_name text,customer_phone text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.signed_date,c.start_date,c.end_date,c.rent_price,c.total_deposit,c.payment_cycle::text,
    m.months,c.rent_price*m.months,r.id,r.name,b.id,b.name,rep.id,rep.full_name,rep.phone
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  CROSS JOIN LATERAL (SELECT GREATEST(1,round((c.end_date-c.start_date)/30.0))::integer months) m
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.deleted_at IS NULL AND (p_from IS NULL OR c.signed_date>=p_from) AND (p_to IS NULL OR c.signed_date<=p_to)
  ORDER BY c.signed_date DESC,c.contract_number,c.id;
END $fn$;

-- A6. Thanh lý (useTerminationsReport, realEstateReports.ts:837-929): HĐ TERMINATED/EXPIRED chưa xoá có ngày
-- kết thúc hiệu lực (actual_end_date, không có thì end_date) trong kỳ; loại/ghi chú từ contract_terminations
-- (bản mới nhất). Sắp actual_end_date giảm dần (trống xuống cuối) như web.
CREATE OR REPLACE FUNCTION public.real_estate_terminations_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,start_date date,end_date date,actual_end_date date,effective_end_date date,
  duration_days integer,rent_price numeric,total_deposit numeric,termination_type text,termination_note text,room_id uuid,room_name text,
  building_id uuid,building_name text,customer_id uuid,customer_name text,customer_phone text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.start_date,c.end_date,c.actual_end_date,COALESCE(c.actual_end_date,c.end_date),
    (COALESCE(c.actual_end_date,c.end_date)-c.start_date)::integer,c.rent_price,c.total_deposit,t.termination_type,t.notes,
    r.id,r.name,b.id,b.name,rep.id,rep.full_name,rep.phone
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT ct.termination_type,ct.notes FROM public.contract_terminations ct
    WHERE ct.contract_id=c.id ORDER BY ct.created_at DESC,ct.id DESC LIMIT 1) t ON true
  LEFT JOIN LATERAL (SELECT cu.id,cu.full_name,cu.phone FROM public.contract_customers cc
    JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  WHERE c.deleted_at IS NULL AND c.status::text IN ('TERMINATED','EXPIRED') AND COALESCE(c.actual_end_date,c.end_date) IS NOT NULL
    AND (p_from IS NULL OR COALESCE(c.actual_end_date,c.end_date)>=p_from)
    AND (p_to IS NULL OR COALESCE(c.actual_end_date,c.end_date)<=p_to)
  ORDER BY c.actual_end_date DESC NULLS LAST,c.id;
END $fn$;

-- A7. Mẫu số tỉ lệ thanh lý (realEstateReports.ts:897-904): HĐ chưa xoá, khác DRAFT.
CREATE OR REPLACE FUNCTION public.real_estate_contract_count_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN (SELECT count(*) FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
    WHERE c.deleted_at IS NULL AND c.status::text<>'DRAFT');
END $fn$;

-- A8. Tỷ lệ chi phí / doanh thu (useExpenseRatioReport, realEstateReports.ts:514-692): theo THÁNG trong
-- [đầu tháng from, cuối tháng to] (mặc định 6 tháng tới tháng hiện tại). Doanh thu = tổng total_amount phiếu
-- INCOME đã duyệt; chi = tổng dòng (≠0) phiếu EXPENSE đã duyệt có loại type='expense' (loại không thấy
-- được qua RLS ⇒ bỏ qua như web), nhóm theo category ("(Chưa phân nhóm)") và tên loại ("(Không tên)").
-- Phiếu có hạng mục hạn chế: RLS của web quyết; p_restricted_building_ids (chỉ thu hẹp) = NULL giữ nguyên,
-- mảng ⇒ phiếu hạn chế chỉ tính ở các toà đó. Trả hàng thô để web/Hermes tự gộp.
CREATE OR REPLACE FUNCTION public.real_estate_expense_ratio_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_category text DEFAULT NULL,p_restricted_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(row_kind text,month text,category text,type_name text,amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_to date; v_from date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  v_to:=(date_trunc('month',COALESCE(p_to,public.org_today_v1(p_organization_id)))+interval '1 month'-interval '1 day')::date;
  v_from:=date_trunc('month',COALESCE(p_from,date_trunc('month',v_to)-interval '5 months'))::date;
  RETURN QUERY
  WITH visible AS (
    SELECT ie.id,ie.type,ie.voucher_date,ie.total_amount FROM public.income_expenses ie
    WHERE ie.organization_id=p_organization_id AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids))
      AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL AND ie.voucher_date BETWEEN v_from AND v_to
      AND (p_restricted_building_ids IS NULL OR NOT COALESCE(ie.has_restricted_item,true) OR ie.building_id=ANY(p_restricted_building_ids))),
  expense AS (
    SELECT to_char(v.voucher_date,'YYYY-MM') AS month,COALESCE(NULLIF(btrim(t.category),''),'(Chưa phân nhóm)') category,
      COALESCE(NULLIF(btrim(t.name),''),'(Không tên)') type_name,i.amount
    FROM visible v JOIN public.income_expense_items i ON i.income_expense_id=v.id
    JOIN public.income_expense_types t ON t.id=i.income_expense_type_id AND t.type='expense'
    WHERE v.type='EXPENSE' AND COALESCE(i.amount,0)<>0)
  SELECT y.row_kind,y.month,y.category,y.type_name,y.amount FROM (
    SELECT 'revenue'::text row_kind,to_char(v.voucher_date,'YYYY-MM') AS month,NULL::text category,NULL::text type_name,sum(v.total_amount) amount
    FROM visible v WHERE v.type='INCOME' GROUP BY 2
    UNION ALL
    SELECT 'expense',e.month,e.category,e.type_name,sum(e.amount) FROM expense e
    WHERE p_category IS NULL OR e.category=p_category GROUP BY e.month,e.category,e.type_name) y
  ORDER BY y.row_kind DESC,y.month,y.category,y.type_name;
END $fn$;

-- A9. Tài sản (useAssets, useAssets.ts:146-199 + filterAssets :110-121): chưa xoá; tài sản chưa gắn toà theo RLS
-- (khi thu hẹp theo toà thì chỉ kèm khi p_include_unassigned). Giá trị = (giá mua||0) × (số lượng||1).
CREATE OR REPLACE FUNCTION public.assets_list_v1(p_organization_id uuid,p_building_ids uuid[],p_include_unassigned boolean DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,p_condition text DEFAULT NULL,p_room_id uuid DEFAULT NULL)
RETURNS TABLE(asset_id uuid,code text,name text,category_id uuid,category_name text,quantity integer,total_value numeric,condition text,
  building_id uuid,building_name text,room_id uuid,room_name text,supplier_id uuid,supplier_name text,purchase_date date,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.category_id,cat.name,COALESCE(NULLIF(a.quantity,0),1),COALESCE(a.purchase_price,0)*COALESCE(NULLIF(a.quantity,0),1),
    a.condition::text,a.building_id,b.name,a.room_id,r.name,a.supplier_id,s.name,a.purchase_date,a.created_at
  FROM public.assets a
  LEFT JOIN public.buildings b ON b.id=a.building_id
  LEFT JOIN public.rooms r ON r.id=a.room_id
  LEFT JOIN public.asset_categories cat ON cat.id=a.category_id
  LEFT JOIN public.suppliers s ON s.id=a.supplier_id
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
RETURNS TABLE(service_id uuid,code text,name text,fee_type text,pricing_type text,unit text,unit_price numeric,is_default boolean,building_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT s.id,s.code,s.name,s.fee_type::text,s.pricing_type::text,s.unit,s.unit_price,s.is_default,
    ARRAY(SELECT DISTINCT bs.building_id FROM public.building_services bs WHERE bs.service_id=s.id AND bs.is_active
      AND (p_building_ids IS NULL OR bs.building_id=ANY(p_building_ids)) ORDER BY bs.building_id)
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
RETURNS TABLE(quota_id uuid,name text,description text,tier_count integer,tiers jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT q.id,q.name,q.description,(SELECT count(*) FROM public.service_quota_tiers t WHERE t.quota_id=q.id)::integer,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('tierNumber',t.tier_number,'fromValue',t.from_value,'toValue',t.to_value,'unitPrice',t.unit_price)
      ORDER BY t.tier_number,t.id) FROM public.service_quota_tiers t WHERE t.quota_id=q.id),'[]'::jsonb)
  FROM public.service_quotas q WHERE q.organization_id=p_organization_id AND q.deleted_at IS NULL
  ORDER BY q.name,q.id;
END $fn$;

-- A12. Nhà cung cấp: cả app chỉ hiện id + tên (CreateAssetDialog.tsx:69, MaterialPurchaseFormDialog.tsx:46).
CREATE OR REPLACE FUNCTION public.suppliers_list_v1(p_organization_id uuid)
RETURNS TABLE(supplier_id uuid,name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT s.id,s.name FROM public.suppliers s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL ORDER BY s.name,s.id;
END $fn$;

-- A13. Công tơ (useMeters, useMeters.ts:216-240 + view meters_with_latest_reading): chưa xoá; chỉ số chốt gần
-- nhất = meter_readings chưa xoá mới nhất theo reading_date, created_at. Lọc toà/loại/phòng.
CREATE OR REPLACE FUNCTION public.meters_list_v1(p_organization_id uuid,p_building_ids uuid[],p_meter_type text DEFAULT NULL,
  p_room_id uuid DEFAULT NULL)
RETURNS TABLE(meter_id uuid,code text,name text,meter_type text,status text,building_id uuid,building_name text,room_id uuid,room_name text,
  initial_reading numeric,latest_reading numeric,latest_reading_date date)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT m.id,m.code,m.name,m.meter_type::text,m.status,m.building_id,b.name,m.room_id,r.name,m.initial_reading,lr.current_reading,lr.reading_date
  FROM public.meters m
  JOIN public.buildings b ON b.id=m.building_id AND b.organization_id=p_organization_id
  LEFT JOIN public.rooms r ON r.id=m.room_id
  LEFT JOIN LATERAL (SELECT mr.current_reading,mr.reading_date FROM public.meter_readings mr WHERE mr.meter_id=m.id AND mr.deleted_at IS NULL
    ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1) lr ON true
  WHERE m.deleted_at IS NULL AND (p_building_ids IS NULL OR m.building_id=ANY(p_building_ids))
    AND (p_meter_type IS NULL OR m.meter_type::text=p_meter_type) AND (p_room_id IS NULL OR m.room_id=p_room_id)
  ORDER BY b.name,r.name NULLS FIRST,m.code,m.id;
END $fn$;

-- A14. Khu trong phạm vi toà THẬT của người gọi (helper DEFINER nhỏ). RLS areas_select_rbac còn đọc
-- staff_assignments cũ (cutover 25/07 đã cắt đồng bộ) nên web có thể mất tên khu dù thấy toà; helper chỉ trả
-- khu (mã/tên/trạng thái) có ít nhất một toà mà người gọi thấy theo đúng RLS buildings (has_full_building_scope
-- hoặc accessible_building_ids); khu chưa có toà chỉ khi người gọi có toàn phạm vi toà. Tự kiểm auth.uid() và
-- thành viên công ty.
CREATE OR REPLACE FUNCTION public.areas_in_scope_v1(p_organization_id uuid)
RETURNS TABLE(area_id uuid,code text,name text,status text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_full boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT (p_organization_id=ANY(COALESCE(public.my_org_ids(),'{}'::uuid[])))
    THEN RAISE EXCEPTION 'w2d_areas_denied' USING ERRCODE='42501'; END IF;
  v_full:=COALESCE(public.has_full_building_scope(),false);
  RETURN QUERY
  SELECT a.id,a.code,a.name,a.status,a.created_at FROM public.areas a
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
  rooms_maintenance integer,rooms_unavailable integer,area_ids uuid[],area_names text[],created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  WITH areas AS MATERIALIZED (SELECT x.area_id,x.name FROM public.areas_in_scope_v1(p_organization_id) x)
  SELECT b.id,b.code,b.name,b.type::text,b.status::text,b.is_virtual,b.total_floors,b.street_address,b.ward,b.district,b.province,b.description,
    rc.total,rc.available,rc.occupied,rc.reserved,rc.maintenance,rc.unavailable,
    ARRAY(SELECT a.area_id FROM public.area_buildings ab JOIN areas a ON a.area_id=ab.area_id WHERE ab.building_id=b.id ORDER BY a.name,a.area_id),
    ARRAY(SELECT a.name FROM public.area_buildings ab JOIN areas a ON a.area_id=ab.area_id WHERE ab.building_id=b.id ORDER BY a.name,a.area_id),
    b.created_at,b.updated_at
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
RETURNS TABLE(area_id uuid,code text,name text,status text,building_ids uuid[],created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT y.area_id,y.code,y.name,y.status,y.building_ids,y.created_at FROM (
    SELECT a.area_id,a.code,a.name,a.status,a.created_at,
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
  max_occupants integer,status text,display_status text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT r.id,r.name,r.code,r.building_id,b.name,r.floor,r.area,r.rent_price,r.deposit_amount,r.max_occupants,r.status::text,
    CASE WHEN ac.id IS NOT NULL THEN CASE WHEN ac.end_date-v_today BETWEEN 1 AND 30 THEN 'EXPIRING_SOON' ELSE 'OCCUPIED' END
      WHEN r.status::text='MAINTENANCE' THEN 'MAINTENANCE' WHEN r.status::text='RESERVED' THEN 'RESERVED' ELSE 'AVAILABLE' END
  FROM public.rooms r
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (SELECT c.id,c.end_date FROM public.contracts c WHERE c.room_id=r.id AND c.deleted_at IS NULL AND c.status::text='ACTIVE'
    ORDER BY c.start_date DESC,c.id LIMIT 1) ac ON true
  WHERE r.deleted_at IS NULL AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  ORDER BY b.name,r.name,r.id;
END $fn$;

-- A18. Người đang thuê một phòng (RoomDetailPage: HĐ hiện tại + "Khách hiện tại"): HĐ ACTIVE chưa xoá của
-- phòng, mỗi hàng một khách (khách đại diện trước).
CREATE OR REPLACE FUNCTION public.room_tenancy_v1(p_organization_id uuid,p_building_ids uuid[],p_room_id uuid)
RETURNS TABLE(contract_id uuid,contract_number text,start_date date,end_date date,rent_price numeric,customer_id uuid,customer_name text,
  customer_phone text,is_representative boolean)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT c.id,c.contract_number,c.start_date,c.end_date,c.rent_price,cu.id,cu.full_name,cu.phone,cc.is_representative
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND r.id=p_room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids)) AND r.deleted_at IS NULL
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN public.contract_customers cc ON cc.contract_id=c.id
  LEFT JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
  WHERE c.deleted_at IS NULL AND c.status::text='ACTIVE'
  ORDER BY c.start_date DESC,c.id,cc.is_representative DESC NULLS LAST,cu.full_name,cu.id;
END $fn$;

-- A19. Tầng (useFloors, useFloors.ts:14-35): theo toà, sắp floor_number.
CREATE OR REPLACE FUNCTION public.floors_list_v1(p_organization_id uuid,p_building_ids uuid[])
RETURNS TABLE(floor_id uuid,building_id uuid,building_name text,floor_number integer,name text,description text,status text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT f.id,f.building_id,b.name,f.floor_number,f.name,f.description,f.status
  FROM public.floors f JOIN public.buildings b ON b.id=f.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
  WHERE p_building_ids IS NULL OR f.building_id=ANY(p_building_ids)
  ORDER BY f.floor_number,b.name,f.id;
END $fn$;

-- A20. Loại thu chi (useIncomeExpenseTypes, useIncomeExpenseTypes.ts:82-176): loại của công ty (hoặc dùng chung),
-- khử trùng theo (type, lower(trim(name))) ưu tiên dòng của chính người gọi rồi dòng cũ nhất như web; trả
-- is_restricted/rule_key để lớp gọi tự ẩn khi cần.
CREATE OR REPLACE FUNCTION public.income_expense_types_list_v1(p_organization_id uuid,p_type text DEFAULT NULL)
RETURNS TABLE(type_id uuid,type text,name text,category text,description text,is_default boolean,system_only boolean,manual_hidden boolean,
  quick_entry_hidden boolean,archived boolean,sort_order integer,is_restricted boolean,rule_key text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT x.id,x.type,x.name,x.category,x.description,x.is_default,x.system_only,x.manual_hidden,x.quick_entry_hidden,x.archived,x.sort_order,
    x.is_restricted,x.rule_key
  FROM (SELECT DISTINCT ON (t.type,lower(btrim(t.name))) t.id,t.type,t.name,t.category,t.description,t.is_default,t.system_only,t.manual_hidden,
      t.quick_entry_hidden,t.archived_at IS NOT NULL archived,t.sort_order,t.is_restricted,t.rule_key
    FROM public.income_expense_types t
    WHERE (t.organization_id IS NULL OR t.organization_id=p_organization_id) AND (p_type IS NULL OR t.type=p_type)
    ORDER BY t.type,lower(btrim(t.name)),(t.user_id=auth.uid()) DESC,t.created_at,t.id) x
  ORDER BY x.archived,x.type='income',x.category NULLS LAST,x.sort_order NULLS LAST,x.name,x.id;
END $fn$;

-- A21. Loại việc (useJobTypes, useJobTypes.ts:9-25 + TaskTypeTable.tsx:59-99): KHÔNG trả bonus_amount,
-- counts_for_salary. Bộ phận/nhóm việc theo RLS của bảng đó (như embed của web).
CREATE OR REPLACE FUNCTION public.job_types_list_v1(p_organization_id uuid)
RETURNS TABLE(job_type_id uuid,name text,department_name text,job_group_id uuid,job_group_name text,customer_contact_deadline integer,
  acceptance_deadline integer,completion_deadline integer,business_hours_only boolean,is_active boolean,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT jt.id,jt.name,d.name,g.id,g.name,jt.customer_contact_deadline,jt.acceptance_deadline,jt.completion_deadline,jt.business_hours_only,
    jt.is_active,jt.created_at
  FROM public.job_types jt
  LEFT JOIN public.departments d ON d.id=jt.default_department_id
  LEFT JOIN public.job_groups g ON g.id=jt.job_group_id
  WHERE jt.organization_id=p_organization_id
  ORDER BY jt.created_at DESC,jt.id;
END $fn$;

-- A22. Hotline (useHotlines, useHotlines.ts:14-30).
CREATE OR REPLACE FUNCTION public.hotlines_list_v1(p_organization_id uuid)
RETURNS TABLE(hotline_id uuid,name text,phone_number text,description text,is_active boolean,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT h.id,h.name,h.phone_number,h.description,h.is_active,h.created_at FROM public.hotlines h
  WHERE h.organization_id=p_organization_id ORDER BY h.created_at DESC,h.id;
END $fn$;

-- ============================================================================================
-- B. GÓI D (app_private.hermes_w2d_*). Cổng Gói 0 kiểm quyền rồi gọi hermes_w2d_read_v1 với ctx
--    {organizationId,userId,report,permission,scope,buildings,requestedBuildingId,overlayOrg,orgWide,isSuperadmin,
--    today,scopes{khoá phụ: [toà]|null}}. Các hàm đọc là INVOKER: dữ liệu luôn dưới RLS của người hỏi.
-- ============================================================================================

-- B1. Bảng báo cáo (khớp W2D_REPORTS, test so từng trường).
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT jsonb_build_object(
  're_vacant_rooms',jsonb_build_object('permission','reports_real_estate.vacant_rooms','source','crm.real_estate_vacant_rooms_v1','scope','rows',
    'params',jsonb_build_array('buildingId','floor'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  're_expiring',jsonb_build_object('permission','reports_real_estate.expiring','source','crm.real_estate_expiring_contracts_v1','scope','rows',
    'params',jsonb_build_array('buildingId','floor','days'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('customers.view')),
  're_renewals_transfers',jsonb_build_object('permission','reports_real_estate.renewals_transfers','source','crm.real_estate_renewals_transfers_v1',
    'scope','rows','params',jsonb_build_array('buildingId','fromDate','toDate'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,
    'scopeKeys',jsonb_build_array('customers.view')),
  're_promotions',jsonb_build_object('permission','reports_real_estate.promotions','source','crm.real_estate_promotions_v1','scope','rows',
    'params',jsonb_build_array('buildingId','fromDate','toDate'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('customers.view')),
  're_new_leases',jsonb_build_object('permission','reports_real_estate.new_leases','source','crm.real_estate_new_leases_v1','scope','rows',
    'params',jsonb_build_array('buildingId','fromDate','toDate'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('customers.view')),
  're_terminations',jsonb_build_object('permission','reports_real_estate.terminations','source','crm.real_estate_terminations_v1','scope','rows',
    'params',jsonb_build_array('buildingId','fromDate','toDate'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('customers.view')),
  're_expense_ratio',jsonb_build_object('permission','reports_real_estate.expense_ratio','source','crm.real_estate_expense_ratio_v1','scope','buildings',
    'params',jsonb_build_array('buildingId','fromDate','toDate','query','kind'),'required','[]'::jsonb,'statuses',NULL,
    'kinds',jsonb_build_array('month','category','type'),'scopeKeys',jsonb_build_array('categories.view','income_expenses.restricted_view')),
  'assets',jsonb_build_object('permission','assets.view','source','crm.assets_list_v1','scope','rows',
    'params',jsonb_build_array('buildingId','roomId','categoryId','status','query'),'required','[]'::jsonb,
    'statuses',jsonb_build_array('NEW','GOOD','FAIR','POOR','BROKEN'),'kinds',NULL,'scopeKeys',jsonb_build_array('suppliers.view')),
  'services',jsonb_build_object('permission','services.view','source','crm.services_list_v1','scope','buildings',
    'params',jsonb_build_array('buildingId','kind'),'required','[]'::jsonb,'statuses',NULL,
    'kinds',jsonb_build_array('TIEN_PHI_DICH_VU','TIEN_DIEN','TIEN_NUOC','TIEN_PHI_KHAC','TIEN_VE_SINH'),'scopeKeys','[]'::jsonb),
  'service_quotas',jsonb_build_object('permission','service_quotas.view','source','crm.service_quotas_list_v1','scope','organization',
    'params','[]'::jsonb,'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'suppliers',jsonb_build_object('permission','suppliers.view','source','crm.suppliers_list_v1','scope','organization',
    'params','[]'::jsonb,'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'meters',jsonb_build_object('permission','meters.view','source','crm.meters_list_v1','scope','rows',
    'params',jsonb_build_array('buildingId','roomId','kind'),'required','[]'::jsonb,'statuses',NULL,
    'kinds',jsonb_build_array('ELECTRICITY','WATER','GAS','OTHER'),'scopeKeys','[]'::jsonb),
  'buildings',jsonb_build_object('permission','buildings.view','source','crm.buildings_list_v1','scope','rows',
    'params',jsonb_build_array('query','status','areaId'),'required','[]'::jsonb,'statuses',jsonb_build_array('ACTIVE','INACTIVE','MAINTENANCE'),
    'kinds',NULL,'scopeKeys','[]'::jsonb),
  'areas',jsonb_build_object('permission','buildings.view','source','crm.areas_list_v1','scope','buildings',
    'params','[]'::jsonb,'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'building_detail',jsonb_build_object('permission','buildings.view','source','crm.buildings_list_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'rooms',jsonb_build_object('permission','rooms.view','source','crm.rooms_list_v1','scope','rows',
    'params',jsonb_build_array('buildingId','floor','status','query'),'required','[]'::jsonb,'statuses',jsonb_build_array('ACTIVE','INACTIVE','RESERVED'),
    'kinds',NULL,'scopeKeys','[]'::jsonb),
  'room_detail',jsonb_build_object('permission','rooms.view','source','crm.room_tenancy_v1','scope','rows',
    'params',jsonb_build_array('roomId'),'required',jsonb_build_array('roomId'),'statuses',NULL,'kinds',NULL,
    'scopeKeys',jsonb_build_array('contracts.view','customers.view')),
  'room_cash_lifecycle',jsonb_build_object('permission','thu_tien.view','source','crm.get_room_cash_lifecycle_v1','scope','rows',
    'params',jsonb_build_array('roomId','fromDate','toDate'),'required',jsonb_build_array('roomId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'floors',jsonb_build_object('permission','buildings.view','source','crm.floors_list_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'ie_types',jsonb_build_object('permission','categories.view','source','crm.income_expense_types_list_v1','scope','organization',
    'params',jsonb_build_array('kind'),'required','[]'::jsonb,'statuses',NULL,'kinds',jsonb_build_array('income','expense'),'scopeKeys','[]'::jsonb),
  'task_types',jsonb_build_object('permission','task_types.view','source','crm.job_types_list_v1','scope','organization',
    'params',jsonb_build_array('query'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('tasks.view')),
  'hotlines',jsonb_build_object('permission','hotline.view','source','crm.hotlines_list_v1','scope','organization',
    'params','[]'::jsonb,'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb))
$fn$;

-- B2. Chữ an toàn cho đầu ra (cùng luật app_private.hermes_full_text_v1 của đợt 1; bản riêng vì hàm đó chỉ
-- DEFINER gọi được): giữ xuống dòng, bỏ ký tự điều khiển khác, cắt theo ký tự.
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(btrim(regexp_replace(
   translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
   '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0)) END
$fn$;

-- B3. Toà của ngữ cảnh (cổng đã tính: grant CRM của khoá báo cáo ∩ overlay ∩ buildingId) giao với toà chưa xoá
-- của công ty mà người hỏi thấy qua RLS buildings (hàng rào thứ hai, không tin mảng truyền vào).
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_buildings_v1(p_ctx jsonb)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
  WHERE b.organization_id=(p_ctx->>'organizationId')::uuid AND b.deleted_at IS NULL
    AND jsonb_typeof(p_ctx->'buildings')='array' AND p_ctx->'buildings' ? b.id::text
$fn$;

-- B4. Khoá phụ (ctx.scopes, cổng tính như khoá chính ∩ overlay): NULL = không được cấp/không có trong Read của
-- kết nối; mảng = toà được cấp.
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_scope_v1(p_ctx jsonb,p_key text)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT CASE WHEN jsonb_typeof(p_ctx#>ARRAY['scopes',p_key])='array'
    THEN ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_ctx#>ARRAY['scopes',p_key]) value ORDER BY 1) END
$fn$;

-- B5. Bảy báo cáo BĐS (src/hooks/reports/realEstateReports.ts). Hàng ≤2000 (sourceCapped khi hơn); tổng hợp (thẻ
-- số của trang web) tính trên TOÀN BỘ kết quả. Tên/SĐT khách: RLS customers của web + customers.view của kết nối
-- phủ đúng toà của hàng.
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_real_estate_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_org uuid:=(p_ctx->>'organizationId')::uuid; v_today date:=(p_ctx->>'today')::date;
  v_buildings uuid[]:=app_private.hermes_w2d_buildings_v1(p_ctx);
  v_customers uuid[]:=COALESCE(app_private.hermes_w2d_scope_v1(p_ctx,'customers.view'),'{}'::uuid[]);
  v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false;
  v_floor integer; v_days integer; v_from date; v_to date; v_query text:=NULLIF(btrim(COALESCE(p_params->>'query','')),''); v_kind text;
  v_from_m date; v_to_m date; v_cat_visible boolean; v_restricted uuid[]; v_total bigint;
BEGIN
  IF jsonb_typeof(p_params->'floor')='number' THEN v_floor:=(p_params->>'floor')::integer; END IF;
  IF jsonb_typeof(p_params->'days')='number' THEN v_days:=(p_params->>'days')::integer; END IF;
  IF jsonb_typeof(p_params->'fromDate')='string' THEN v_from:=(p_params->>'fromDate')::date; END IF;
  IF jsonb_typeof(p_params->'toDate')='string' THEN v_to:=(p_params->>'toDate')::date; END IF;
  v_kind:=COALESCE(p_params->>'kind','month');
  IF p_report='re_vacant_rooms' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'vacantUpTo7Days',count(*) FILTER (WHERE x.days<=7),
        'vacant8To30Days',count(*) FILTER (WHERE x.days>7 AND x.days<=30),'vacantOver30Days',count(*) FILTER (WHERE x.days>30),
        'unknownSince',count(*) FILTER (WHERE x.days IS NULL))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.building_name,v.room_name,v.room_id) ord,v.days_vacant days,
        jsonb_build_object('roomId',v.room_id,'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),'buildingId',v.building_id,
          'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),'floor',v.floor,'area',round(v.area,2)::text,
          'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'status',v.status,'lastEndDate',v.last_end_date,'daysVacant',v.days_vacant) item
        FROM public.real_estate_vacant_rooms_v1(v_org,v_buildings,v_floor,v_today) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_expiring' THEN
    v_days:=COALESCE(v_days,30);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('days',v_days,'total',count(*),'within7Days',count(*) FILTER (WHERE x.days<=7),
        'within8To15Days',count(*) FILTER (WHERE x.days>7 AND x.days<=15),'within16To30Days',count(*) FILTER (WHERE x.days>15 AND x.days<=30))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.end_date,v.building_name,v.room_name,v.contract_id) ord,v.days_left days,
        jsonb_build_object('contractId',v.contract_id,'contractNumber',app_private.hermes_w2d_text_v1(v.contract_number,100),'status',v.status,
          'startDate',v.start_date,'endDate',v.end_date,'daysLeft',v.days_left,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'roomId',v.room_id,'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),'floor',v.floor,'buildingId',v.building_id,
          'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_phone,40) END,
          'customerEmail',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_email,200) END) item
        FROM public.real_estate_expiring_contracts_v1(v_org,v_buildings,v_days,v_floor,v_today) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_renewals_transfers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'renewals',count(*) FILTER (WHERE x.kind='RENEWAL'),'transfers',count(*) FILTER (WHERE x.kind='TRANSFER'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.event_date DESC,v.kind,v.contract_number,v.event_id) ord,v.kind,
        jsonb_build_object('kind',v.kind,'eventId',v.event_id,'contractId',v.contract_id,
          'contractNumber',app_private.hermes_w2d_text_v1(v.contract_number,100),'eventDate',v.event_date,
          'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'roomId',v.room_id,'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),
          'buildingId',v.building_id,'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),
          'customerName',CASE WHEN v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers)
            THEN app_private.hermes_w2d_text_v1(v.customer_name,200) END) item
        FROM public.real_estate_renewals_transfers_v1(v_org,v_buildings,v_from,v_to) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_promotions' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE x.status='ACTIVE'),'totalSavings',round(COALESCE(sum(x.savings),0),2)::text,
        'avgSavings',round(CASE WHEN count(*)>0 THEN COALESCE(sum(x.savings),0)/count(*) ELSE 0 END,2)::text,
        'withDiscountTerms',count(*) FILTER (WHERE x.has_terms))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.signed_date DESC,v.contract_number,v.contract_id) ord,v.status,v.savings,
        (v.discount_amount<>0 OR COALESCE(v.amount_per_month,0)<>0) has_terms,
        jsonb_build_object('contractId',v.contract_id,'contractNumber',app_private.hermes_w2d_text_v1(v.contract_number,100),'status',v.status,
          'signedDate',v.signed_date,'startDate',v.start_date,'endDate',v.end_date,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'discountType',v.discount_type,'discountAmount',round(v.discount_amount,2)::text,'savings',round(v.savings,2)::text,
          'effectiveRent',round(v.effective_rent,2)::text,'promotionName',app_private.hermes_w2d_text_v1(v.promotion_name,200),
          'discountMonths',v.discount_months,'amountPerMonth',round(v.amount_per_month,2)::text,'roomId',v.room_id,
          'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),'buildingId',v.building_id,
          'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),
          'customerName',CASE WHEN v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers)
            THEN app_private.hermes_w2d_text_v1(v.customer_name,200) END) item
        FROM public.real_estate_promotions_v1(v_org,v_buildings,v_from,v_to) v WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_new_leases' THEN
    -- Mặc định của web: tháng hiện tại (NewLeasesReport.tsx:22-25).
    IF v_from IS NULL AND v_to IS NULL THEN
      v_from:=date_trunc('month',v_today)::date; v_to:=(date_trunc('month',v_today)+interval '1 month'-interval '1 day')::date;
    END IF;
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('fromDate',v_from,'toDate',v_to,'total',count(*),'totalValue',round(COALESCE(sum(x.total_value),0),2)::text,
        'avgRent',round(CASE WHEN count(*)>0 THEN COALESCE(sum(x.rent),0)/count(*) ELSE 0 END,2)::text,
        'avgDurationMonths',CASE WHEN count(*)>0 THEN round(sum(x.months)::numeric/count(*))::integer ELSE 0 END)
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.signed_date DESC,v.contract_number,v.contract_id) ord,v.total_value,v.rent_price rent,
        v.duration_months months,
        jsonb_build_object('contractId',v.contract_id,'contractNumber',app_private.hermes_w2d_text_v1(v.contract_number,100),'status',v.status,
          'signedDate',v.signed_date,'startDate',v.start_date,'endDate',v.end_date,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,
          'totalDeposit',round(COALESCE(v.total_deposit,0),2)::text,'paymentCycle',v.payment_cycle,'durationMonths',v.duration_months,
          'totalValue',round(COALESCE(v.total_value,0),2)::text,'roomId',v.room_id,'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),
          'buildingId',v.building_id,'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_phone,40) END) item
        FROM public.real_estate_new_leases_v1(v_org,v_buildings,v_from,v_to) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_terminations' THEN
    -- Mặc định của web: đầu tháng tới hôm nay (TerminationsReport.tsx:22-25).
    IF v_from IS NULL AND v_to IS NULL THEN v_from:=date_trunc('month',v_today)::date; v_to:=v_today; END IF;
    v_total:=public.real_estate_contract_count_v1(v_org,v_buildings);
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('fromDate',v_from,'toDate',v_to,'total',count(*),'terminated',count(*) FILTER (WHERE x.status='TERMINATED'),
        'expired',count(*) FILTER (WHERE x.status='EXPIRED'),'totalContracts',v_total,
        'terminationRatePct',round(CASE WHEN v_total>0 THEN count(*)*100.0/v_total ELSE 0 END,1)::text)
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY v.actual_end_date DESC NULLS LAST,v.contract_id) ord,v.status,
        jsonb_build_object('contractId',v.contract_id,'contractNumber',app_private.hermes_w2d_text_v1(v.contract_number,100),'status',v.status,
          'startDate',v.start_date,'endDate',v.end_date,'actualEndDate',v.actual_end_date,'effectiveEndDate',v.effective_end_date,
          'durationDays',v.duration_days,'rentPrice',round(COALESCE(v.rent_price,0),2)::text,'totalDeposit',round(COALESCE(v.total_deposit,0),2)::text,
          'terminationType',app_private.hermes_w2d_text_v1(v.termination_type,40),'note',app_private.hermes_w2d_text_v1(v.termination_note,300),
          'roomId',v.room_id,'roomName',app_private.hermes_w2d_text_v1(v.room_name,100),'buildingId',v.building_id,
          'buildingName',app_private.hermes_w2d_text_v1(v.building_name,200),
          'customerName',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_name,200) END,
          'customerPhone',CASE WHEN pii.ok THEN app_private.hermes_w2d_text_v1(v.customer_phone,40) END) item
        FROM public.real_estate_terminations_v1(v_org,v_buildings,v_from,v_to) v
        CROSS JOIN LATERAL (SELECT v.customer_id IS NOT NULL AND v.building_id=ANY(v_customers) ok) pii
        WHERE v.building_id=ANY(v_buildings)) x;
  ELSIF p_report='re_expense_ratio' THEN
    -- Kỳ theo tháng như web (realEstateReports.ts:531-538): mặc định 6 tháng tới tháng hiện tại.
    v_to_m:=date_trunc('month',COALESCE(v_to,v_today))::date;
    v_from_m:=date_trunc('month',COALESCE(v_from,v_to_m-interval '5 months'))::date;
    -- Web nhúng income_expense_types qua RLS categories.view: Hermes còn đòi khoá đó có trong Read của kết nối.
    v_cat_visible:=app_private.hermes_w2d_scope_v1(p_ctx,'categories.view') IS NOT NULL;
    -- Phiếu hạng mục hạn chế chỉ tính ở toà mà kết nối giữ income_expenses.restricted_view (trên nền RLS web).
    v_restricted:=COALESCE(app_private.hermes_w2d_scope_v1(p_ctx,'income_expenses.restricted_view'),'{}'::uuid[]);
    WITH raw AS MATERIALIZED (SELECT r.row_kind,r.month,r.category,r.type_name,r.amount
      FROM public.real_estate_expense_ratio_v1(v_org,v_buildings,v_from_m,v_to_m,v_query,v_restricted) r
      WHERE r.row_kind='revenue' OR v_cat_visible),
    months AS (SELECT to_char(m,'YYYY-MM') AS month FROM generate_series(v_from_m,v_to_m,interval '1 month') m),
    by_month AS (SELECT mo.month,COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='revenue' AND t.month=mo.month),0) revenue,
        COALESCE((SELECT sum(t.amount) FROM raw t WHERE t.row_kind='expense' AND t.month=mo.month),0) expense FROM months mo),
    ratios AS (SELECT b.*,CASE WHEN b.revenue>0 THEN b.expense/b.revenue*100 END ratio FROM by_month b),
    peak AS (SELECT r.month,r.ratio FROM ratios r WHERE r.ratio IS NOT NULL ORDER BY r.ratio DESC,r.month LIMIT 1)
    SELECT jsonb_build_object('fromMonth',to_char(v_from_m,'YYYY-MM'),'toMonth',to_char(v_to_m,'YYYY-MM'),
        'totalRevenue',round((SELECT COALESCE(sum(revenue),0) FROM ratios),2)::text,'totalExpense',round((SELECT COALESCE(sum(expense),0) FROM ratios),2)::text,
        'avgRatioPct',round(COALESCE((SELECT avg(ratio) FROM ratios WHERE ratio IS NOT NULL),0),2)::text,
        'peakMonth',(SELECT month FROM peak),'peakRatioPct',(SELECT round(ratio,2)::text FROM peak),
        'categories',COALESCE((SELECT jsonb_agg(app_private.hermes_w2d_text_v1(c,200) ORDER BY c) FROM (SELECT DISTINCT t.category c FROM raw t
          WHERE t.row_kind='expense' ORDER BY 1 LIMIT 100) cats),'[]'::jsonb),
        'expenseTypesVisible',v_cat_visible,'category',app_private.hermes_w2d_text_v1(v_query,200)),
      CASE v_kind
        WHEN 'category' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('month',g.month,'category',app_private.hermes_w2d_text_v1(g.category,200),
            'typeName',NULL,'revenue',NULL,'expense',round(g.amount,2)::text,'ratioPct',NULL) ORDER BY g.month,g.category),'[]'::jsonb)
          FROM (SELECT t.month,t.category,sum(t.amount) amount FROM raw t WHERE t.row_kind='expense' GROUP BY 1,2) g)
        WHEN 'type' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('month',NULL,'category',app_private.hermes_w2d_text_v1(g.category,200),
            'typeName',app_private.hermes_w2d_text_v1(g.type_name,200),'revenue',NULL,'expense',round(g.amount,2)::text,'ratioPct',NULL)
            ORDER BY g.amount DESC,g.category,g.type_name),'[]'::jsonb)
          FROM (SELECT t.category,t.type_name,sum(t.amount) amount FROM raw t WHERE t.row_kind='expense' GROUP BY 1,2) g)
        ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_object('month',r.month,'category',NULL,'typeName',NULL,'revenue',round(r.revenue,2)::text,
            'expense',round(r.expense,2)::text,'ratioPct',round(r.ratio,2)::text) ORDER BY r.month),'[]'::jsonb) FROM ratios r) END
      INTO v_summary,v_rows;
    IF jsonb_array_length(v_rows)>2000 THEN
      v_capped:=true; v_rows:=(SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,o) WHERE o<=2000);
    END IF;
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B6. Danh mục, tài sản, toà/phòng (D1, D3–D10, D12–D14).
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_items_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_org uuid:=(p_ctx->>'organizationId')::uuid; v_today date:=(p_ctx->>'today')::date;
  v_buildings uuid[]:=app_private.hermes_w2d_buildings_v1(p_ctx);
  v_org_wide boolean:=COALESCE((p_ctx->>'orgWide')::boolean,false) AND COALESCE(p_ctx->'requestedBuildingId','null'::jsonb)='null'::jsonb;
  v_rows jsonb:='[]'::jsonb; v_summary jsonb; v_capped boolean:=false; v_query text:=lower(NULLIF(btrim(COALESCE(p_params->>'query','')),''));
  v_status text:=p_params->>'status'; v_kind text:=p_params->>'kind'; v_floor integer; v_room uuid; v_category uuid; v_area uuid;
  v_room_building uuid; v_lifecycle jsonb; v_contracts uuid[]; v_customers uuid[]; v_suppliers boolean; v_groups boolean; v_tz text;
BEGIN
  IF jsonb_typeof(p_params->'floor')='number' THEN v_floor:=(p_params->>'floor')::integer; END IF;
  IF jsonb_typeof(p_params->'roomId')='string' THEN v_room:=(p_params->>'roomId')::uuid; END IF;
  IF jsonb_typeof(p_params->'categoryId')='string' THEN v_category:=(p_params->>'categoryId')::uuid; END IF;
  IF jsonb_typeof(p_params->'areaId')='string' THEN v_area:=(p_params->>'areaId')::uuid; END IF;
  -- Phòng phải thuộc toà đã giao và người hỏi thấy được qua RLS (cổng đã giải; đây là hàng rào thứ hai).
  IF v_room IS NOT NULL THEN
    SELECT r.building_id INTO v_room_building FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=v_org
      WHERE r.id=v_room AND r.deleted_at IS NULL;
    IF v_room_building IS NULL OR NOT(v_room_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  END IF;
  IF p_report='assets' THEN
    -- Nhà cung cấp chỉ khi kết nối giữ suppliers.view (web: embed supplier theo RLS suppliers).
    v_suppliers:=app_private.hermes_w2d_scope_v1(p_ctx,'suppliers.view') IS NOT NULL;
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'totalValue',round(COALESCE(sum(x.value),0),2)::text,
        'goodOrNew',count(*) FILTER (WHERE COALESCE(x.condition,'GOOD') IN ('GOOD','NEW')),
        'poorOrBroken',count(*) FILTER (WHERE x.condition IN ('POOR','BROKEN')))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY a.created_at DESC,a.asset_id) ord,a.total_value value,a.condition,
        jsonb_build_object('id',a.asset_id,'code',app_private.hermes_w2d_text_v1(a.code,100),'name',app_private.hermes_w2d_text_v1(a.name,200),
          'categoryName',app_private.hermes_w2d_text_v1(a.category_name,200),'quantity',a.quantity,'totalValue',round(a.total_value,2)::text,
          'condition',a.condition,'buildingId',a.building_id,'buildingName',app_private.hermes_w2d_text_v1(a.building_name,200),
          'roomId',a.room_id,'roomName',app_private.hermes_w2d_text_v1(a.room_name,100),
          'supplierName',CASE WHEN v_suppliers THEN app_private.hermes_w2d_text_v1(a.supplier_name,200) END,'purchaseDate',a.purchase_date) item
        FROM public.assets_list_v1(v_org,v_buildings,v_org_wide AND v_room IS NULL,v_category,v_status,v_room) a
        WHERE (a.building_id=ANY(v_buildings) OR a.building_id IS NULL AND v_org_wide)
          AND (v_query IS NULL OR position(v_query IN lower(COALESCE(a.name,'')))>0 OR position(v_query IN lower(COALESCE(a.code,'')))>0
            OR position(v_query IN lower(COALESCE(a.category_name,'')))>0)) x;
  ELSIF p_report='services' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY s.name,s.service_id) ord,
        jsonb_build_object('id',s.service_id,'code',app_private.hermes_w2d_text_v1(s.code,100),'name',app_private.hermes_w2d_text_v1(s.name,200),
          'feeType',s.fee_type,'pricingType',s.pricing_type,'unit',app_private.hermes_w2d_text_v1(s.unit,40),
          'unitPrice',round(COALESCE(s.unit_price,0),2)::text,'isDefault',COALESCE(s.is_default,false),
          'buildingIds',to_jsonb(ARRAY(SELECT u FROM unnest(s.building_ids) u WHERE u=ANY(v_buildings) ORDER BY u))) item
        FROM public.services_list_v1(v_org,v_buildings,v_org_wide,v_kind) s) x;
  ELSIF p_report='service_quotas' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY q.name,q.quota_id) ord,
        jsonb_build_object('id',q.quota_id,'name',app_private.hermes_w2d_text_v1(q.name,200),
          'description',app_private.hermes_w2d_text_v1(q.description,500),'tierCount',q.tier_count,
          'tiers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('tierNumber',(t->>'tierNumber')::integer,
              'fromValue',round((t->>'fromValue')::numeric,2)::text,'toValue',round((t->>'toValue')::numeric,2)::text,
              'unitPrice',round((t->>'unitPrice')::numeric,2)::text) ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(q.tiers) WITH ORDINALITY e(t,o) WHERE o<=50)) item
        FROM public.service_quotas_list_v1(v_org) q) x;
  ELSIF p_report='suppliers' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY s.name,s.supplier_id) ord,
        jsonb_build_object('id',s.supplier_id,'name',app_private.hermes_w2d_text_v1(s.name,200)) item FROM public.suppliers_list_v1(v_org) s) x;
  ELSIF p_report='meters' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY m.building_name,m.room_name NULLS FIRST,m.code,m.meter_id) ord,
        jsonb_build_object('id',m.meter_id,'code',app_private.hermes_w2d_text_v1(m.code,100),'name',app_private.hermes_w2d_text_v1(m.name,200),
          'meterType',m.meter_type,'status',app_private.hermes_w2d_text_v1(m.status,40),'buildingId',m.building_id,
          'buildingName',app_private.hermes_w2d_text_v1(m.building_name,200),'roomId',m.room_id,'roomName',app_private.hermes_w2d_text_v1(m.room_name,100),
          'initialReading',round(m.initial_reading,2)::text,'latestReading',round(m.latest_reading,2)::text,'latestReadingDate',m.latest_reading_date) item
        FROM public.meters_list_v1(v_org,v_buildings,v_kind,v_room) m WHERE m.building_id=ANY(v_buildings)) x;
  ELSIF p_report IN ('buildings','building_detail') THEN
    -- Danh sách: ẩn toà ảo (useBuildings mặc định .eq is_virtual false); chi tiết: useBuilding không lọc ảo.
    v_tz:=COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=v_org),'Asia/Ho_Chi_Minh');
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000 AND x.shown),'[]'::jsonb),count(*) FILTER (WHERE x.shown)>2000,
      jsonb_build_object('total',count(*),'active',count(*) FILTER (WHERE x.status='ACTIVE'),
        'inactive',count(*) FILTER (WHERE x.status='INACTIVE'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY b.created_at DESC,b.building_id) ord,b.status,(v_status IS NULL OR b.status=v_status) shown,
        jsonb_build_object('buildingId',b.building_id,'code',app_private.hermes_w2d_text_v1(b.code,100),'name',app_private.hermes_w2d_text_v1(b.name,200),
          'type',b.type,'status',b.status,'totalFloors',b.total_floors,
          'address',app_private.hermes_w2d_text_v1(NULLIF(concat_ws(', ',NULLIF(btrim(b.street_address),''),NULLIF(btrim(b.ward),''),
            NULLIF(btrim(b.district),''),NULLIF(btrim(b.province),'')),''),500),
          'description',CASE WHEN p_report='building_detail' THEN app_private.hermes_w2d_text_v1(b.description,1000) END,
          'areaNames',to_jsonb(ARRAY(SELECT app_private.hermes_w2d_text_v1(n,200) FROM unnest(b.area_names) n LIMIT 20)),
          'roomsTotal',b.rooms_count,'roomsAvailable',b.rooms_available,'roomsOccupied',b.rooms_occupied,'roomsReserved',b.rooms_reserved,
          'roomsMaintenance',b.rooms_maintenance,'roomsUnavailable',b.rooms_unavailable,
          'updatedOn',(COALESCE(b.updated_at,b.created_at) AT TIME ZONE v_tz)::date) item
        FROM public.buildings_list_v1(v_org,v_buildings) b
        WHERE b.building_id=ANY(v_buildings) AND (p_report='building_detail' OR NOT COALESCE(b.is_virtual,false))
          AND (v_area IS NULL OR v_area=ANY(b.area_ids))
          AND (v_query IS NULL OR position(v_query IN lower(concat_ws(' ',b.name,b.code,b.street_address)))>0)) x;
  ELSIF p_report='areas' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY a.created_at DESC,a.area_id) ord,
        jsonb_build_object('id',a.area_id,'code',app_private.hermes_w2d_text_v1(a.code,100),'name',app_private.hermes_w2d_text_v1(a.name,200),
          'status',app_private.hermes_w2d_text_v1(a.status,40),'buildingIds',to_jsonb(ARRAY(SELECT u FROM unnest(a.building_ids) u WHERE u=ANY(v_buildings))),
          'buildingCount',cardinality(ARRAY(SELECT u FROM unnest(a.building_ids) u WHERE u=ANY(v_buildings)))) item
        FROM public.areas_list_v1(v_org,v_buildings,v_org_wide) a) x;
  ELSIF p_report='rooms' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,
      jsonb_build_object('total',count(*),'available',count(*) FILTER (WHERE x.display='AVAILABLE'),
        'expiringSoon',count(*) FILTER (WHERE x.display='EXPIRING_SOON'),'reserved',count(*) FILTER (WHERE x.display='RESERVED'))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY r.building_name,r.name,r.room_id) ord,r.display_status display,
        jsonb_build_object('roomId',r.room_id,'name',app_private.hermes_w2d_text_v1(r.name,100),'code',app_private.hermes_w2d_text_v1(r.code,100),
          'buildingId',r.building_id,'buildingName',app_private.hermes_w2d_text_v1(r.building_name,200),'floor',r.floor,'area',round(r.area,2)::text,
          'rentPrice',round(COALESCE(r.rent_price,0),2)::text,'depositAmount',round(COALESCE(r.deposit_amount,0),2)::text,'maxOccupants',r.max_occupants,
          'status',r.status,'displayStatus',r.display_status) item
        FROM public.rooms_list_v1(v_org,v_buildings,v_today) r
        WHERE r.building_id=ANY(v_buildings) AND (v_floor IS NULL OR r.floor=v_floor)
          AND (v_status IS NULL OR r.status=CASE v_status WHEN 'ACTIVE' THEN 'AVAILABLE' WHEN 'INACTIVE' THEN 'UNAVAILABLE' ELSE 'RESERVED' END)
          AND (v_query IS NULL OR position(v_query IN lower(COALESCE(r.name,'')))>0 OR position(v_query IN lower(COALESCE(r.code,'')))>0)) x;
  ELSIF p_report='room_detail' THEN
    -- Hợp đồng: contracts.view của kết nối phủ toà (như crm_read_contract_detail đợt 1); người ở: customers.view.
    v_contracts:=app_private.hermes_w2d_scope_v1(p_ctx,'contracts.view');
    v_customers:=app_private.hermes_w2d_scope_v1(p_ctx,'customers.view');
    SELECT COALESCE(jsonb_agg(jsonb_build_object('roomId',r.room_id,'name',app_private.hermes_w2d_text_v1(r.name,100),
        'code',app_private.hermes_w2d_text_v1(r.code,100),'buildingId',r.building_id,'buildingName',app_private.hermes_w2d_text_v1(r.building_name,200),
        'floor',r.floor,'area',round(r.area,2)::text,'rentPrice',round(COALESCE(r.rent_price,0),2)::text,
        'depositAmount',round(COALESCE(r.deposit_amount,0),2)::text,'maxOccupants',r.max_occupants,'status',r.status,'displayStatus',r.display_status,
        'contractVisible',COALESCE(r.building_id=ANY(v_contracts),false),
        'contract',CASE WHEN r.building_id=ANY(v_contracts) THEN (SELECT jsonb_build_object('contractId',t.contract_id,
            'contractNumber',app_private.hermes_w2d_text_v1(t.contract_number,100),'startDate',t.start_date,'endDate',t.end_date,
            'rentPrice',round(COALESCE(t.rent_price,0),2)::text)
          FROM public.room_tenancy_v1(v_org,v_buildings,r.room_id) t LIMIT 1) END,
        'tenantsVisible',COALESCE(r.building_id=ANY(v_customers),false),
        'tenants',CASE WHEN r.building_id=ANY(v_customers) THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name',app_private.hermes_w2d_text_v1(t.customer_name,200),'phone',app_private.hermes_w2d_text_v1(t.customer_phone,40),
            'isRepresentative',COALESCE(t.is_representative,false)) ORDER BY t.is_representative DESC NULLS LAST,t.customer_name,t.customer_id),'[]'::jsonb)
          FROM (SELECT * FROM public.room_tenancy_v1(v_org,v_buildings,r.room_id) t WHERE t.customer_id IS NOT NULL
            ORDER BY t.is_representative DESC NULLS LAST,t.customer_name,t.customer_id LIMIT 20) t) ELSE '[]'::jsonb END)),'[]'::jsonb),
      NULL
      INTO v_rows,v_summary
      FROM public.rooms_list_v1(v_org,ARRAY[v_room_building],v_today) r WHERE r.room_id=v_room AND r.building_id=ANY(v_buildings);
  ELSIF p_report='room_cash_lifecycle' THEN
    -- RPC web (RoomLifecycleSheet trên /thu-tien, khoá thu_tien.view). RPC tự kiểm can_access_building nhưng KHÔNG
    -- kiểm khoá module ⇒ Hermes chỉ gọi khi đã có đúng khoá web và toà ∈ phạm vi. Bỏ meta, tên khách (bảng
    -- tenants cũ), segments chẩn đoán.
    v_lifecycle:=public.get_room_cash_lifecycle_v1(v_room,CASE WHEN jsonb_typeof(p_params->'fromDate')='string' THEN (p_params->>'fromDate')::date END,
      CASE WHEN jsonb_typeof(p_params->'toDate')='string' THEN (p_params->>'toDate')::date END);
    IF v_lifecycle#>>'{room,buildingId}' IS DISTINCT FROM v_room_building::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('type',e->>'type','date',e->>'date','contractId',e->>'contractId',
        'amount',CASE WHEN jsonb_typeof(e->'amount')='number' THEN round((e->>'amount')::numeric,2)::text END,'trusted',COALESCE((e->>'trusted')::boolean,false))
        ORDER BY o) FILTER (WHERE o<=2000),'[]'::jsonb),count(*)>2000
      INTO v_rows,v_capped FROM jsonb_array_elements(COALESCE(v_lifecycle->'events','[]'::jsonb)) WITH ORDINALITY ev(e,o);
    v_summary:=jsonb_build_object('roomId',v_room,'roomName',app_private.hermes_w2d_text_v1(v_lifecycle#>>'{room,name}',100),
      'buildingId',v_room_building,'buildingName',app_private.hermes_w2d_text_v1(v_lifecycle#>>'{room,buildingName}',200),
      'contracts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c->>'id','number',app_private.hermes_w2d_text_v1(c->>'number',100),
          'status',c->>'status','startDate',c->>'startDate','endDate',c->>'endDate','actualEndDate',c->>'actualEndDate',
          'rentPrice',round(COALESCE((c->>'rentPrice')::numeric,0),2)::text,'totalDeposit',round(COALESCE((c->>'totalDeposit')::numeric,0),2)::text)
          ORDER BY o),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(v_lifecycle->'contracts','[]'::jsonb)) WITH ORDINALITY ce(c,o) WHERE o<=50),
      'vacancies',(SELECT COALESCE(jsonb_agg(jsonb_build_object('fromDate',v->>'fromDate','toDate',v->>'toDate',
          'days',CASE WHEN jsonb_typeof(v->'days')='number' THEN (v->>'days')::integer END) ORDER BY o),'[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(v_lifecycle->'vacancies','[]'::jsonb)) WITH ORDINALITY va(v,o) WHERE o<=100));
  ELSIF p_report='floors' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY f.floor_number,f.building_name,f.floor_id) ord,
        jsonb_build_object('id',f.floor_id,'buildingId',f.building_id,'buildingName',app_private.hermes_w2d_text_v1(f.building_name,200),
          'floorNumber',f.floor_number,'name',app_private.hermes_w2d_text_v1(f.name,100),'description',app_private.hermes_w2d_text_v1(f.description,500),
          'status',app_private.hermes_w2d_text_v1(f.status,40)) item
        FROM public.floors_list_v1(v_org,v_buildings) f WHERE f.building_id=ANY(v_buildings)) x;
  ELSIF p_report='ie_types' THEN
    -- Ẩn hạng mục hạn chế, lương, cổ đông (như crm_read_income_expenses đợt 1) — chặt hơn web cho người có
    -- income_expenses.restricted_view.
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY t.archived,t.type='income',t.category NULLS LAST,t.sort_order NULLS LAST,t.name,t.type_id) ord,
        jsonb_build_object('id',t.type_id,'type',t.type,'name',app_private.hermes_w2d_text_v1(t.name,200),
          'category',app_private.hermes_w2d_text_v1(t.category,200),'description',app_private.hermes_w2d_text_v1(t.description,500),
          'isDefault',COALESCE(t.is_default,false),'systemOnly',COALESCE(t.system_only,false),'manualHidden',COALESCE(t.manual_hidden,false),
          'quickEntryHidden',COALESCE(t.quick_entry_hidden,false),'archived',t.archived) item
        FROM public.income_expense_types_list_v1(v_org,v_kind) t
        WHERE NOT COALESCE(t.is_restricted,true)
          AND COALESCE(t.rule_key,'') NOT IN ('luong_dieu_hanh','luong_quan_ly','ung_luong','chia_loi_nhuan')) x;
  ELSIF p_report='task_types' THEN
    -- Nhóm việc: RLS job_groups (tasks.view) của web + khoá tasks.view có trong Read của kết nối.
    v_groups:=app_private.hermes_w2d_scope_v1(p_ctx,'tasks.view') IS NOT NULL;
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY j.created_at DESC,j.job_type_id) ord,
        jsonb_build_object('id',j.job_type_id,'name',app_private.hermes_w2d_text_v1(j.name,200),
          'departmentName',app_private.hermes_w2d_text_v1(j.department_name,200),
          'jobGroupName',CASE WHEN v_groups THEN app_private.hermes_w2d_text_v1(j.job_group_name,200) END,
          'customerContactDeadlineMinutes',j.customer_contact_deadline,'acceptanceDeadlineMinutes',j.acceptance_deadline,
          'completionDeadlineMinutes',j.completion_deadline,'businessHoursOnly',j.business_hours_only,'isActive',j.is_active) item
        FROM public.job_types_list_v1(v_org) j WHERE v_query IS NULL OR position(v_query IN lower(COALESCE(j.name,'')))>0) x;
  ELSIF p_report='hotlines' THEN
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord) FILTER (WHERE x.ord<=2000),'[]'::jsonb),count(*)>2000,jsonb_build_object('total',count(*))
      INTO v_rows,v_capped,v_summary
      FROM (SELECT row_number() OVER (ORDER BY h.created_at DESC,h.hotline_id) ord,
        jsonb_build_object('id',h.hotline_id,'name',app_private.hermes_w2d_text_v1(h.name,200),'phoneNumber',app_private.hermes_w2d_text_v1(h.phone_number,40),
          'description',app_private.hermes_w2d_text_v1(h.description,500),'isActive',h.is_active) item FROM public.hotlines_list_v1(v_org) h) x;
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_capped,'unavailable',NULL);
END $fn$;

-- B7. Điểm vào của gói (cổng Gói 0 gọi sau khi kiểm quyền/phạm vi). INVOKER: đọc dưới RLS của người hỏi.
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF p_report IS NULL OR p_ctx->>'report' IS DISTINCT FROM p_report OR NOT(app_private.hermes_w2d_catalog_v1() ? p_report)
    OR p_ctx->>'permission' IS DISTINCT FROM app_private.hermes_w2d_catalog_v1()->p_report->>'permission'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_report LIKE 're\_%' THEN RETURN app_private.hermes_w2d_real_estate_v1(p_report,p_params,p_ctx); END IF;
  RETURN app_private.hermes_w2d_items_v1(p_report,p_params,p_ctx);
END $fn$;

-- ============================================================================================
-- C. Chủ sở hữu, quyền và tự kiểm.
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
ALTER FUNCTION public.areas_in_scope_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.buildings_list_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.areas_list_v1(uuid,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION public.rooms_list_v1(uuid,uuid[],date) OWNER TO postgres;
ALTER FUNCTION public.room_tenancy_v1(uuid,uuid[],uuid) OWNER TO postgres;
ALTER FUNCTION public.floors_list_v1(uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.income_expense_types_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.job_types_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hotlines_list_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_buildings_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_scope_v1(jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_real_estate_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_items_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_read_v1(text,jsonb,jsonb) OWNER TO postgres;
-- Hàm dùng chung + helper khu: chỉ người đăng nhập (INVOKER ⇒ RLS của họ); không anon/PUBLIC/service_role.
REVOKE ALL ON FUNCTION public.real_estate_vacant_rooms_v1(uuid,uuid[],integer,date),
  public.real_estate_expiring_contracts_v1(uuid,uuid[],integer,integer,date),public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date),
  public.real_estate_promotions_v1(uuid,uuid[],date,date),public.real_estate_new_leases_v1(uuid,uuid[],date,date),
  public.real_estate_terminations_v1(uuid,uuid[],date,date),public.real_estate_contract_count_v1(uuid,uuid[]),
  public.real_estate_expense_ratio_v1(uuid,uuid[],date,date,text,uuid[]),public.assets_list_v1(uuid,uuid[],boolean,uuid,text,uuid),
  public.services_list_v1(uuid,uuid[],boolean,text),public.service_quotas_list_v1(uuid),public.suppliers_list_v1(uuid),
  public.meters_list_v1(uuid,uuid[],text,uuid),public.areas_in_scope_v1(uuid),public.buildings_list_v1(uuid,uuid[]),
  public.areas_list_v1(uuid,uuid[],boolean),public.rooms_list_v1(uuid,uuid[],date),public.room_tenancy_v1(uuid,uuid[],uuid),
  public.floors_list_v1(uuid,uuid[]),public.income_expense_types_list_v1(uuid,text),public.job_types_list_v1(uuid),public.hotlines_list_v1(uuid)
  FROM PUBLIC,anon,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.real_estate_vacant_rooms_v1(uuid,uuid[],integer,date),
  public.real_estate_expiring_contracts_v1(uuid,uuid[],integer,integer,date),public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date),
  public.real_estate_promotions_v1(uuid,uuid[],date,date),public.real_estate_new_leases_v1(uuid,uuid[],date,date),
  public.real_estate_terminations_v1(uuid,uuid[],date,date),public.real_estate_contract_count_v1(uuid,uuid[]),
  public.real_estate_expense_ratio_v1(uuid,uuid[],date,date,text,uuid[]),public.assets_list_v1(uuid,uuid[],boolean,uuid,text,uuid),
  public.services_list_v1(uuid,uuid[],boolean,text),public.service_quotas_list_v1(uuid),public.suppliers_list_v1(uuid),
  public.meters_list_v1(uuid,uuid[],text,uuid),public.areas_in_scope_v1(uuid),public.buildings_list_v1(uuid,uuid[]),
  public.areas_list_v1(uuid,uuid[],boolean),public.rooms_list_v1(uuid,uuid[],date),public.room_tenancy_v1(uuid,uuid[],uuid),
  public.floors_list_v1(uuid,uuid[]),public.income_expense_types_list_v1(uuid,text),public.job_types_list_v1(uuid),public.hotlines_list_v1(uuid)
  TO authenticated;
-- Hàm phụ của gói (INVOKER, chạy trong chuỗi gọi của người hỏi). ACL của hermes_w2d_read_v1/catalog_v1 do nền Gói 0
-- quyết (CREATE OR REPLACE giữ nguyên quyền của khung).
REVOKE ALL ON FUNCTION app_private.hermes_w2d_text_v1(text,integer),app_private.hermes_w2d_buildings_v1(jsonb),
  app_private.hermes_w2d_scope_v1(jsonb,text),app_private.hermes_w2d_real_estate_v1(text,jsonb,jsonb),app_private.hermes_w2d_items_v1(text,jsonb,jsonb)
  FROM PUBLIC,anon,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_w2d_text_v1(text,integer),app_private.hermes_w2d_buildings_v1(jsonb),
  app_private.hermes_w2d_scope_v1(jsonb,text),app_private.hermes_w2d_real_estate_v1(text,jsonb,jsonb),app_private.hermes_w2d_items_v1(text,jsonb,jsonb)
  TO authenticated;

-- Tự kiểm (database đủ bảng: production/TEST, fixture gói D): gọi thử MỌI hàm dùng chung dưới vai authenticated với
-- một người dùng không thuộc công ty nào ⇒ 0 hàng, chỉ buộc Postgres phân tích/lập kế hoạch từng câu (lỗi thân hàm
-- là dừng apply). Thiếu bảng (fixture nền PGlite của Gói 0) thì bỏ qua.
DO $selfcheck$
DECLARE v_claims text:=current_setting('request.jwt.claims',true); v_sub text:=current_setting('request.jwt.claim.sub',true);
  v_nobody constant text:='00000000-0000-4000-8000-00000000d0d0';
BEGIN
  IF (SELECT bool_and(to_regclass(t) IS NOT NULL) FROM unnest(ARRAY['public.contracts','public.rooms','public.buildings','public.customers',
      'public.contract_customers','public.contract_extensions','public.contract_terminations','public.organization_timezones','public.income_expenses',
      'public.income_expense_items','public.income_expense_types','public.assets','public.asset_categories','public.suppliers','public.services',
      'public.building_services','public.service_quotas','public.service_quota_tiers','public.meters','public.meter_readings','public.areas',
      'public.area_buildings','public.floors','public.job_types','public.job_groups','public.departments','public.hotlines']) t) THEN
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_nobody,'role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.sub',v_nobody,true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM count(*) FROM public.real_estate_vacant_rooms_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_expiring_contracts_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_renewals_transfers_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_promotions_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_new_leases_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_terminations_v1(NULL,'{}'::uuid[]);
    PERFORM public.real_estate_contract_count_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.real_estate_expense_ratio_v1(NULL,'{}'::uuid[],DATE '2000-01-01',DATE '2000-01-31',NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.assets_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.services_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.service_quotas_list_v1(NULL);
    PERFORM count(*) FROM public.suppliers_list_v1(NULL);
    PERFORM count(*) FROM public.meters_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.buildings_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.rooms_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.room_tenancy_v1(NULL,'{}'::uuid[],NULL);
    PERFORM count(*) FROM public.floors_list_v1(NULL,'{}'::uuid[]);
    PERFORM count(*) FROM public.income_expense_types_list_v1(NULL);
    PERFORM count(*) FROM public.job_types_list_v1(NULL);
    PERFORM count(*) FROM public.hotlines_list_v1(NULL);
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims',COALESCE(v_claims,''),true);
    PERFORM set_config('request.jwt.claim.sub',COALESCE(v_sub,''),true);
  END IF;
END $selfcheck$;
COMMIT;
NOTIFY pgrst,'reload schema';
