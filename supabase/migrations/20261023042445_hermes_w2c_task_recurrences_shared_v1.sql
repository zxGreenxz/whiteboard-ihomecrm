-- Công việc — danh sách việc định kỳ dùng chung CRM (Đợt 2b Mốc 5, 23/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 4, 22):
-- quy tắc chưa xoá của công ty theo toà người gọi truyền tường minh, dưới RLS job_recurrence_rules của người gọi (như jobs: buildings.view).
-- Mỗi hàng: mã DK, nội dung, loại, toà/phòng, người nhận, câu lịch (public.job_recurrence_schedule_text_v1), từ/tới ngày, hạn sau N ngày,
-- trạng thái ACTIVE / PAUSED (+ lý do) / ENDED (đã qua ngày kết thúc), lần sinh kế tiếp (public.job_recurrence_dates_v1, giờ công ty).
-- Lọc: trạng thái, toà, chữ tìm bỏ dấu trên mã + nội dung + tên người nhận. Trả mọi hàng khớp (người gọi tự cắt trang/đếm). INVOKER,
-- search_path rỗng, tự từ chối ngoài vai authenticated; chỉ authenticated được gọi. plpgsql tra bảng/hàm lúc chạy nên không đòi chúng lúc
-- tạo (mọi fixture đợt 2 nạp file của dải gói C). Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.job_recurrences_list_v1(p_organization_id uuid,p_building_ids uuid[],p_status text DEFAULT NULL,
  p_query text DEFAULT NULL,p_building_id uuid DEFAULT NULL)
RETURNS TABLE(organization_id uuid,rule_id uuid,code text,title text,job_type text,building_id uuid,building_name text,room_id uuid,
  room_name text,assignee_id uuid,assignee_name text,schedule_text text,start_date date,end_date date,due_days integer,status text,
  paused_reason text,next_date date,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_today date; v_query text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL OR p_building_ids IS NULL THEN
    RAISE EXCEPTION 'job_recurrences_list_denied' USING ERRCODE='42501'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('ACTIVE','PAUSED','ENDED') THEN
    RAISE EXCEPTION 'job_recurrences_list_invalid' USING ERRCODE='22023'; END IF;
  v_today:=public.org_today_v1(p_organization_id);
  -- Bỏ dấu tiếng Việt (chữ thường) + gộp khoảng trắng, cho cả chữ tìm lẫn mã/nội dung/tên người nhận.
  v_query:=NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(normalize(COALESCE(p_query,''),NFC)),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'\s+',' ','g')),'');
  RETURN QUERY
  WITH x AS (
    SELECT r.*,CASE WHEN r.paused_at IS NOT NULL THEN 'PAUSED' WHEN r.end_date IS NOT NULL AND r.end_date<v_today THEN 'ENDED' ELSE 'ACTIVE' END st
    FROM public.job_recurrence_rules r
    WHERE r.organization_id=p_organization_id AND r.deleted_at IS NULL AND r.building_id=ANY(p_building_ids)
      AND (p_building_id IS NULL OR r.building_id=p_building_id))
  SELECT x.organization_id,x.id,x.code::text,x.title::text,jt.name::text,x.building_id,b.name::text,x.room_id,rm.name::text,x.assignee_id,
    NULLIF(pa.full_name,'')::text,public.job_recurrence_schedule_text_v1(x.frequency,x.every,x.weekdays,x.month_day),x.start_date,x.end_date,
    x.due_days::integer,x.st,x.paused_reason::text,
    CASE WHEN x.st='ACTIVE' THEN (SELECT min(d) FROM public.job_recurrence_dates_v1(x.frequency,x.every,x.weekdays,x.month_day,x.start_date,x.end_date,
      GREATEST(v_today,COALESCE(x.last_generated_date+1,v_today)),GREATEST(v_today,COALESCE(x.last_generated_date+1,v_today))+400) d) END,
    x.created_at
  FROM x
  LEFT JOIN public.buildings b ON b.id=x.building_id
  LEFT JOIN public.rooms rm ON rm.id=x.room_id
  LEFT JOIN public.job_types jt ON jt.id=x.job_type_id
  LEFT JOIN public.profiles pa ON pa.id=x.assignee_id
  WHERE (p_status IS NULL OR x.st=p_status)
    AND (v_query IS NULL OR position(v_query IN pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(
      normalize(COALESCE(x.code,'')||' '||COALESCE(x.title,'')||' '||COALESCE(pa.full_name,''),NFC)),
      'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
      'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'\s+',' ','g')))>0);
END $fn$;

ALTER FUNCTION public.job_recurrences_list_v1(uuid,uuid[],text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.job_recurrences_list_v1(uuid,uuid[],text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.job_recurrences_list_v1(uuid,uuid[],text,text,uuid) TO authenticated;
COMMIT;
