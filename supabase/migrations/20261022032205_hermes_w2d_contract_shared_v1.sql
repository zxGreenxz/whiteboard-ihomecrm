-- Đợt 2 trang HỢP ĐỒNG — hai hàm dùng chung MỚI của miền (RPC web gọi được; INVOKER + RLS người hỏi, search_path rỗng,
-- tự kiểm khoá web của trang Hợp đồng). File riêng, không chứa hàm của trợ lý (như file hàm dùng chung của gói D).
-- Dùng cho hai báo cáo đọc bù của trang Hợp đồng ở file kế tiếp; web dùng lại về sau. Không DROP, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Hàm dùng chung (đọc bù a): HĐ hiệu lực chưa thanh lý có ngày kết thúc trong [from, to] (mặc định tháng của hôm nay).
CREATE OR REPLACE FUNCTION public.real_estate_contracts_ending_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,start_date date,end_date date,days_left integer,expected_move_out_date date,
  rent_price numeric,room_id uuid,room_name text,floor integer,building_id uuid,building_name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date; v_from date; v_to date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của trang Hợp đồng (RequirePermission module=contracts, xem) khi web gọi thẳng; RLS contracts lọc theo toà.
  IF NOT COALESCE(public.can_access_org_entity('contracts','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  v_from:=COALESCE(p_from,date_trunc('month',v_today)::date);
  v_to:=COALESCE(p_to,(date_trunc('month',v_today)+interval '1 month - 1 day')::date);
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.start_date,c.end_date,(c.end_date-v_today)::integer,c.expected_move_out_date,c.rent_price,
    r.id,r.name,r.floor,b.id,b.name,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='ACTIVE' AND c.actual_end_date IS NULL
    AND c.end_date BETWEEN v_from AND v_to
  ORDER BY c.end_date,b.name,r.name,c.id;
END $fn$;

-- Hàm dùng chung (đọc bù b): HĐ hiệu lực có ngày báo dọn đi; khoảng [from, to] tuỳ chọn (vắng = không chặn phía đó).
CREATE OR REPLACE FUNCTION public.contract_move_out_notices_v1(p_organization_id uuid,p_building_ids uuid[],
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_as_of date DEFAULT NULL)
RETURNS TABLE(contract_id uuid,contract_number text,status text,end_date date,expected_move_out_date date,days_until integer,rent_price numeric,
  room_id uuid,room_name text,building_id uuid,building_name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_today date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  IF NOT COALESCE(public.can_access_org_entity('contracts','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  RETURN QUERY
  SELECT c.id,c.contract_number,c.status::text,c.end_date,c.expected_move_out_date,(c.expected_move_out_date-v_today)::integer,c.rent_price,
    r.id,r.name,b.id,b.name,c.organization_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id=c.room_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='ACTIVE' AND c.actual_end_date IS NULL
    AND c.expected_move_out_date IS NOT NULL AND (p_from IS NULL OR c.expected_move_out_date>=p_from) AND (p_to IS NULL OR c.expected_move_out_date<=p_to)
  ORDER BY c.expected_move_out_date,b.name,r.name,c.id;
END $fn$;


ALTER FUNCTION public.real_estate_contracts_ending_v1(uuid,uuid[],date,date,date) OWNER TO postgres;
ALTER FUNCTION public.contract_move_out_notices_v1(uuid,uuid[],date,date,date) OWNER TO postgres;
-- Chỉ người đăng nhập (INVOKER ⇒ RLS của họ); không anon/PUBLIC/service_role.
REVOKE ALL ON FUNCTION public.real_estate_contracts_ending_v1(uuid,uuid[],date,date,date),public.contract_move_out_notices_v1(uuid,uuid[],date,date,date)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.real_estate_contracts_ending_v1(uuid,uuid[],date,date,date),public.contract_move_out_notices_v1(uuid,uuid[],date,date,date)
  TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
