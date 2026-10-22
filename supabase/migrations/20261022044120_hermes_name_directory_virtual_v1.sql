-- Đợt 2 Thu chi — Mốc 3 (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 17): giải TÊN toà nhận TOÀ ẢO cho thu chi.
-- Lỗi đo 22/10: "tháng này kho văn phòng chung chi bao nhiêu" ⇒ read_name_unresolved, vì hai bản _v1 (danh bạ đọc
-- 20261020175803, giải tên ghi 20261021132433) bỏ is_virtual. Toà ảo là nơi web Thu chi ghi chi phí chung (form lấy toà qua
-- ie_form_buildings(), có cả toà ảo) ⇒ đọc/ghi THU CHI phải nhận toà ảo; tool dựa phòng (khách, HĐ, hoá đơn, công việc) vẫn bỏ.
-- Không đổi hàm đã phát hành: thêm bản _v2 có tham số p_include_virtual (bắt buộc, NULL ⇒ 22023); _v1 giữ nguyên cho mọi tool khác.
--  (1) public.hermes_building_directory_v2(org, toà[], include_virtual) — như v1 (INVOKER, RLS người hỏi, {"buildings":[{id,name,code}]},
--      sắp name rồi id), toà ảo chỉ có khi include_virtual. Connector dùng cho khoá income_expenses.view (read-name-resolution.mjs).
--  (2) app_private.hermes_write_name_resolve_core_v2(...) — thân của core v1 (20261021132433) với một khác biệt: toà ảo được tính
--      (cả ở danh sách toà lẫn ở toà của phòng) khi include_virtual. Mọi luật khác (bằng trước chứa sau, tiền tố "toà ", outside_scope
--      không kèm tên, phòng chỉ khớp bằng, người theo helper thành viên) chép nguyên.
--  (3) vỏ hermes_write_name_resolve_v2 (schema public; org, toà[], names, include_virtual) — SQL-standard, gắn OID lõi (2) + helper thành viên
--      lúc tạo (như v1: authenticated không có USAGE trên app_private). Thu chi (expense.*) gọi với include_virtual=true.
-- Không ghi dữ liệu. Idempotent (CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL OR to_regprocedure('public.hermes_room_key_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_virtual_dependency_invalid'; END IF;
END $requires$;

-- 1. Danh bạ toà (đọc), toà ảo theo tham số.
CREATE OR REPLACE FUNCTION public.hermes_building_directory_v2(p_organization_id uuid,p_building_ids uuid[],p_include_virtual boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR array_ndims(p_building_ids) IS DISTINCT FROM 1
    OR cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_position(p_building_ids,NULL) IS NOT NULL
    OR p_include_virtual IS NULL THEN
    RAISE EXCEPTION 'hermes_name_directory_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'code',b.code) ORDER BY b.name,b.id),'[]'::jsonb) INTO v_result
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.id=ANY(p_building_ids) AND b.deleted_at IS NULL AND (p_include_virtual OR NOT b.is_virtual);
  RETURN jsonb_build_object('buildings',v_result);
END $fn$;

-- 2. Lõi giải tên cho thao tác ghi (thân core v1 + p_include_virtual).
CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v2(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_member_ids uuid[],
  p_caller_member boolean,p_include_virtual boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_entry record; v_value text;
  v_building text; v_room text; v_job text; v_person text;
  v_needles text[]; v_needle text; v_attempt int; v_found jsonb; v_in jsonb; v_out jsonb;
  r_building jsonb; r_room jsonb; r_job jsonb; r_person jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'hermes_write_name_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR (cardinality(p_building_ids)>0 AND array_ndims(p_building_ids)<>1)
    OR cardinality(p_building_ids)>256 OR array_position(p_building_ids,NULL) IS NOT NULL
    OR p_names IS NULL OR jsonb_typeof(p_names)<>'object' OR p_include_virtual IS NULL THEN
    RAISE EXCEPTION 'hermes_write_name_invalid' USING ERRCODE='22023'; END IF;
  IF p_caller_member IS NOT TRUE THEN RAISE EXCEPTION 'hermes_write_name_denied' USING ERRCODE='42501'; END IF;
  FOR v_entry IN SELECT e.key, e.value FROM jsonb_each(p_names) e LOOP
    IF v_entry.key NOT IN ('building','room','jobType','person') OR jsonb_typeof(v_entry.value)<>'string' THEN
      RAISE EXCEPTION 'hermes_write_name_invalid' USING ERRCODE='22023'; END IF;
    v_value:=btrim(v_entry.value #>> '{}');
    IF v_value='' OR char_length(v_value)>120 OR v_value ~ '[\x01-\x1f\x7f]' THEN
      RAISE EXCEPTION 'hermes_write_name_invalid' USING ERRCODE='22023'; END IF;
    CASE v_entry.key WHEN 'building' THEN v_building:=v_value; WHEN 'room' THEN v_room:=v_value;
      WHEN 'jobType' THEN v_job:=v_value; ELSE v_person:=v_value; END CASE;
  END LOOP;

  -- Toà: bằng (nguyên chuỗi, rồi bỏ tiền tố "toà ") trước, chứa sau; lần thử đầu có ứng viên thấy được thì quyết.
  IF v_building IS NOT NULL THEN
    v_needles:=ARRAY[public.hermes_name_fold_v1(v_building)];
    IF v_needles[1] LIKE 'toa %' AND char_length(v_needles[1])>4 THEN v_needles:=v_needles||substr(v_needles[1],5); END IF;
    v_found:='[]'::jsonb;
    FOR v_attempt IN 1..4 LOOP
      v_needle:=v_needles[CASE WHEN v_attempt IN (1,3) THEN 1 ELSE 2 END];
      CONTINUE WHEN v_needle IS NULL OR (v_attempt>2 AND char_length(v_needle)<2);
      WITH visible AS (
        SELECT b.id,b.name,b.code,(b.id=ANY(p_building_ids)) AS in_scope FROM public.buildings b
        WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_include_virtual OR NOT COALESCE(b.is_virtual,false))),
      keys AS (
        SELECT v.id,public.hermes_name_fold_v1(v.name) AS k,false AS is_code FROM visible v
        UNION ALL
        SELECT v.id,public.hermes_name_fold_v1(a.alias),true FROM visible v
          CROSS JOIN LATERAL unnest(string_to_array(COALESCE(v.code,''),',')) AS a(alias) WHERE btrim(a.alias)<>''
        UNION ALL
        SELECT c.building_id,public.hermes_name_fold_v1(c.name),false FROM public.building_common_names c JOIN visible v ON v.id=c.building_id),
      hits AS (
        SELECT DISTINCT k.id FROM keys k WHERE k.k<>'' AND CASE WHEN v_attempt<=2 THEN
          k.k=v_needle OR (k.is_code AND regexp_replace(v_needle,'[^a-z0-9]','','g')<>''
            AND regexp_replace(k.k,'[^a-z0-9]','','g')=regexp_replace(v_needle,'[^a-z0-9]','','g'))
          ELSE strpos(k.k,v_needle)>0 END)
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'inScope',v.in_scope) ORDER BY v.name,v.id),'[]'::jsonb)
        INTO v_found FROM visible v JOIN hits h ON h.id=v.id;
      EXIT WHEN jsonb_array_length(v_found)>0;
    END LOOP;
    SELECT COALESCE(jsonb_agg(e ORDER BY ord) FILTER (WHERE (e->>'inScope')::boolean),'[]'::jsonb),
           COALESCE(jsonb_agg(e ORDER BY ord) FILTER (WHERE NOT (e->>'inScope')::boolean),'[]'::jsonb)
      INTO v_in,v_out FROM jsonb_array_elements(v_found) WITH ORDINALITY AS x(e,ord);
    IF jsonb_array_length(v_in)=1 THEN
      r_building:=jsonb_build_object('id',v_in->0->'id','name',v_in->0->'name');
    ELSE
      -- Chỉ nêu tên trong phạm vi được ghi (ambiguous); outside_scope không bao giờ kèm tên.
      RETURN jsonb_build_object('status','unresolved','field','building','wanted',v_building,
        'why',CASE WHEN jsonb_array_length(v_in)>1 THEN 'ambiguous' WHEN jsonb_array_length(v_out)>0 THEN 'outside_scope' ELSE 'not_visible' END,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(v_in)
          WITH ORDINALITY AS x(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_in)>8);
    END IF;
  END IF;

  -- Phòng: chỉ khớp BẰNG khoá phòng, trong toà đã giải (nếu có) hoặc trong cả phạm vi được ghi.
  IF v_room IS NOT NULL THEN
    v_needle:=public.hermes_room_key_v1(v_room);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'buildingId',r.building_id,'buildingName',b.name)
        ORDER BY b.name,b.id,r.name,r.id),'[]'::jsonb) INTO v_found
      FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
      WHERE v_needle<>'' AND r.organization_id=p_organization_id AND r.deleted_at IS NULL
        AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_include_virtual OR NOT COALESCE(b.is_virtual,false))
        AND b.id=ANY(p_building_ids) AND (r_building IS NULL OR b.id=(r_building->>'id')::uuid)
        AND (public.hermes_room_key_v1(r.name)=v_needle OR EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(r.code,''),',')) AS a(alias)
          WHERE btrim(a.alias)<>'' AND public.hermes_room_key_v1(a.alias)=v_needle));
    IF jsonb_array_length(v_found)<>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','room','wanted',v_room,
        'why',CASE WHEN jsonb_array_length(v_found)>1 THEN 'ambiguous' ELSE 'not_visible' END,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name','buildingName',e->'buildingName') ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_found) WITH ORDINALITY AS x(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_found)>8);
    END IF;
    r_room:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name','buildingId',v_found->0->'buildingId');
    -- Chỉ nêu phòng: toà suy ra từ phòng duy nhất khớp.
    IF r_building IS NULL THEN r_building:=jsonb_build_object('id',v_found->0->'buildingId','name',v_found->0->'buildingName'); END IF;
  END IF;

  -- Loại việc: bằng rồi chứa, bỏ dấu; loại đã tắt không nhận.
  IF v_job IS NOT NULL THEN
    v_needle:=public.hermes_name_fold_v1(v_job);
    FOR v_attempt IN 1..2 LOOP
      CONTINUE WHEN v_attempt=2 AND char_length(v_needle)<2;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'name',j.name) ORDER BY j.name,j.id),'[]'::jsonb) INTO v_found
        FROM public.job_types j WHERE j.organization_id=p_organization_id AND COALESCE(j.is_active,true)
          AND CASE WHEN v_attempt=1 THEN public.hermes_name_fold_v1(j.name)=v_needle ELSE strpos(public.hermes_name_fold_v1(j.name),v_needle)>0 END;
      EXIT WHEN jsonb_array_length(v_found)>0;
    END LOOP;
    IF jsonb_array_length(v_found)<>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','jobType','wanted',v_job,
        'why',CASE WHEN jsonb_array_length(v_found)>1 THEN 'ambiguous' ELSE 'not_visible' END,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_found) WITH ORDINALITY AS x(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_found)>8);
    END IF;
    r_job:=v_found->0;
  END IF;

  -- Người: hồ sơ thấy được qua RLS + thành viên ACTIVE (cùng helper của hàm tạo việc); bằng rồi chứa, bỏ dấu.
  IF v_person IS NOT NULL THEN
    v_needle:=public.hermes_name_fold_v1(v_person);
    FOR v_attempt IN 1..2 LOOP
      CONTINUE WHEN v_attempt=2 AND char_length(v_needle)<2;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) ORDER BY p.full_name,p.id),'[]'::jsonb) INTO v_found
        FROM public.profiles p WHERE p.full_name IS NOT NULL AND p.id=ANY(COALESCE(p_member_ids,'{}'::uuid[]))
          AND CASE WHEN v_attempt=1 THEN public.hermes_name_fold_v1(p.full_name)=v_needle ELSE strpos(public.hermes_name_fold_v1(p.full_name),v_needle)>0 END;
      EXIT WHEN jsonb_array_length(v_found)>0;
    END LOOP;
    IF jsonb_array_length(v_found)<>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','person','wanted',v_person,
        'why',CASE WHEN jsonb_array_length(v_found)>1 THEN 'ambiguous' ELSE 'not_visible' END,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_found) WITH ORDINALITY AS x(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_found)>8);
    END IF;
    r_person:=v_found->0;
  END IF;

  RETURN jsonb_build_object('status','resolved','building',r_building,'room',r_room,'jobType',r_job,'person',r_person);
END $fn$;

-- 3. Vỏ public SQL-standard (như v1): OID của lõi (2) và helper thành viên gắn lúc tạo.
CREATE OR REPLACE FUNCTION public.hermes_write_name_resolve_v2(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_include_virtual boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
BEGIN ATOMIC
  WITH caller AS MATERIALIZED (SELECT COALESCE(app_private.hermes_task_assignee_member_v1(auth.uid(),p_organization_id),false) AS member)
  SELECT app_private.hermes_write_name_resolve_core_v2(p_organization_id,p_building_ids,p_names,
    CASE WHEN caller.member AND jsonb_typeof(p_names)='object' AND p_names ? 'person' THEN ARRAY(SELECT p.id FROM public.profiles p
      WHERE p.full_name IS NOT NULL AND app_private.hermes_task_assignee_member_v1(p.id,p_organization_id)) ELSE '{}'::uuid[] END,
    caller.member,p_include_virtual) FROM caller;
END;

ALTER FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) OWNER TO postgres;
ALTER FUNCTION public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) TO authenticated;
-- Vỏ chạy dưới vai authenticated nên cần EXECUTE trên lõi (tới qua OID, không qua tên).
GRANT EXECUTE ON FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean) TO authenticated;
COMMENT ON FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) IS
  'Hermes: danh bạ toà {id,name,code} trong danh sách toà đã cho, dưới RLS người hỏi; bỏ deleted_at, toà ảo chỉ khi p_include_virtual (thu chi).';

DO $check$
DECLARE fn regprocedure; src text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.hermes_building_directory_v2(uuid,uuid[],boolean)','public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)',
      'app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)']::regprocedure[] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn AND NOT p.prosecdef AND p.provolatile='s' AND pg_get_userbyid(p.proowner)='postgres')
      OR has_function_privilege('anon',fn,'EXECUTE') OR has_function_privilege('service_role',fn,'EXECUTE')
      OR NOT has_function_privilege('authenticated',fn,'EXECUTE') THEN
      RAISE EXCEPTION 'hermes_name_directory_virtual_catalog_invalid: %',fn; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)'::regprocedure AND prosqlbody IS NOT NULL
      AND 'search_path=""'=ANY(proconfig))
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)'::regprocedure
      AND 'search_path=""'=ANY(proconfig)) THEN
    RAISE EXCEPTION 'hermes_name_directory_virtual_catalog_invalid: wrapper'; END IF;
  src:=pg_get_functiondef('public.hermes_building_directory_v2(uuid,uuid[],boolean)'::regprocedure);
  IF position('(p_include_virtual OR NOT b.is_virtual)' IN src)=0 OR position('app_private' IN src)>0 THEN
    RAISE EXCEPTION 'hermes_name_directory_virtual_catalog_invalid: directory source'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
