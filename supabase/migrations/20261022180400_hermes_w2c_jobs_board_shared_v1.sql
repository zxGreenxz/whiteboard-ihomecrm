-- Công việc — bảng việc dùng chung CRM (Đợt 2b Mốc 4, 23/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 4, 21): việc của
-- công ty theo toà người gọi truyền tường minh, dưới RLS jobs của người gọi (như trang /tasks: người được giao luôn thấy việc của mình —
-- 20261022031600). Lọc: trạng thái (IN_PROGRESS / COMPLETED / OVERDUE = đang làm mà đã quá hạn lúc gọi), trục ngày (deadline / created /
-- completed, theo NGÀY giờ công ty — organization_timezones, mặc định Asia/Ho_Chi_Minh), phòng, người nhận, chữ tìm bỏ dấu trên mã + tiêu
-- đề + TÊN NGƯỜI NHẬN (hồ sơ, rồi tên gõ tay như web). Trả mọi việc khớp (người gọi tự cắt trang/đếm). Tên người theo RLS profiles của
-- người gọi (không xem được ⇒ null). INVOKER, search_path rỗng, tự từ chối ngoài vai authenticated; chỉ authenticated được gọi. Không DROP,
-- không ghi dữ liệu. Idempotent. plpgsql tra bảng lúc chạy nên không đòi bảng lúc tạo (mọi fixture đợt 2 nạp file của dải gói C).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.jobs_board_v1(p_organization_id uuid,p_building_ids uuid[],p_org_wide boolean DEFAULT NULL,
  p_status text DEFAULT NULL,p_kind text DEFAULT NULL,p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_query text DEFAULT NULL,
  p_room_id uuid DEFAULT NULL,p_staff_id uuid DEFAULT NULL)
RETURNS TABLE(organization_id uuid,job_id uuid,code text,title text,job_type text,building_id uuid,building_name text,room_id uuid,
  room_name text,assignee_id uuid,assignee_name text,assigner_name text,status text,deadline timestamptz,deadline_local text,
  overdue boolean,overdue_days integer,progress text,created_on date,completed_on date,completion_time timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_tz text; v_axis text; v_lo timestamptz; v_hi timestamptz; v_query text; v_now timestamptz:=pg_catalog.now();
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL OR p_building_ids IS NULL THEN
    RAISE EXCEPTION 'jobs_board_denied' USING ERRCODE='42501'; END IF;
  IF (p_status IS NOT NULL AND p_status NOT IN ('IN_PROGRESS','COMPLETED','OVERDUE'))
    OR (p_kind IS NOT NULL AND p_kind NOT IN ('deadline','created','completed'))
    OR (p_from IS NOT NULL AND p_to IS NOT NULL AND (p_to<p_from OR p_to-p_from>366)) THEN
    RAISE EXCEPTION 'jobs_board_invalid' USING ERRCODE='22023'; END IF;
  v_tz:=COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=p_organization_id),'Asia/Ho_Chi_Minh');
  -- Trục ngày: kind, hoặc mặc định theo trạng thái (đã xong ⇒ ngày xong, còn lại ⇒ hạn). Chỉ áp khi có fromDate/toDate.
  v_axis:=COALESCE(p_kind,CASE WHEN p_status='COMPLETED' THEN 'completed' ELSE 'deadline' END);
  v_lo:=CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE v_tz END;
  v_hi:=CASE WHEN p_to IS NULL THEN NULL ELSE (p_to+1)::timestamp AT TIME ZONE v_tz END;
  -- Bỏ dấu tiếng Việt (chữ thường) + gộp khoảng trắng, cho cả chữ tìm lẫn mã/tiêu đề/tên người nhận.
  v_query:=NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(normalize(COALESCE(p_query,''),NFC)),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'\s+',' ','g')),'');
  RETURN QUERY
  SELECT j.organization_id,j.id,j.code::text,j.title::text,jt.name::text,j.building_id,b.name::text,j.room_id,r.name::text,j.assignee_id,
    COALESCE(NULLIF(pa.full_name,''),NULLIF(j.assignee_name,''))::text,pc.full_name::text,j.status::text,j.deadline,
    pg_catalog.to_char(j.deadline AT TIME ZONE v_tz,'YYYY-MM-DD HH24:MI'),
    COALESCE(j.status='IN_PROGRESS' AND j.deadline<v_now,false),
    CASE WHEN j.status='IN_PROGRESS' AND j.deadline<v_now THEN pg_catalog.floor(pg_catalog.date_part('epoch',v_now-j.deadline)/86400)::integer END,
    NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(j.completion_description,'')),300),''),
    (j.created_at AT TIME ZONE v_tz)::date,(j.completion_time AT TIME ZONE v_tz)::date,j.completion_time
  FROM public.jobs j
  LEFT JOIN public.buildings b ON b.id=j.building_id
  LEFT JOIN public.rooms r ON r.id=j.room_id
  LEFT JOIN public.job_types jt ON jt.id=j.job_type_id
  LEFT JOIN public.profiles pa ON pa.id=j.assignee_id
  LEFT JOIN public.profiles pc ON pc.id=j.user_id
  WHERE j.organization_id=p_organization_id
    AND (j.building_id=ANY(p_building_ids) OR (j.building_id IS NULL AND COALESCE(p_org_wide,false)))
    AND (p_room_id IS NULL OR j.room_id=p_room_id)
    AND (p_staff_id IS NULL OR j.assignee_id=p_staff_id)
    AND (p_status IS NULL OR (p_status='OVERDUE' AND j.status='IN_PROGRESS' AND j.deadline<v_now) OR (p_status<>'OVERDUE' AND j.status=p_status))
    AND (v_lo IS NULL OR CASE v_axis WHEN 'created' THEN j.created_at WHEN 'completed' THEN j.completion_time ELSE j.deadline END>=v_lo)
    AND (v_hi IS NULL OR CASE v_axis WHEN 'created' THEN j.created_at WHEN 'completed' THEN j.completion_time ELSE j.deadline END<v_hi)
    AND (v_query IS NULL OR position(v_query IN pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(
      normalize(COALESCE(j.code,'')||' '||COALESCE(j.title,'')||' '||COALESCE(NULLIF(pa.full_name,''),j.assignee_name,''),NFC)),
      'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
      'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'\s+',' ','g')))>0);
END $fn$;

ALTER FUNCTION public.jobs_board_v1(uuid,uuid[],boolean,text,text,date,date,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.jobs_board_v1(uuid,uuid[],boolean,text,text,date,date,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.jobs_board_v1(uuid,uuid[],boolean,text,text,date,date,text,uuid,uuid) TO authenticated;
COMMIT;
