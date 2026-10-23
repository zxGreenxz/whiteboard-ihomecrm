-- Hermes trang Công việc, lượt 11 — sửa theo nghiệm thu bot thật trên TEST (23–24/10). Lõi giải tên dùng chung (nền chung,
-- 20261021132433) — ba trang ghi cùng dùng, nên chỉ đổi đúng hai chỗ, mọi luật khác giữ nguyên:
--  (1) Loại việc: không nhận loại trùng tên / mã / tên gọi chung của một toà trong công ty. Danh mục production có "162nvk", "950nk"
--      (0 việc, trùng tên toà — dữ liệu nhập nhầm) ⇒ bot từng được gợi ý / khớp các chuỗi đó như loại việc. Hàm dùng chung mới
--      public.job_type_building_like_v1 (INVOKER, dưới RLS người gọi) để lõi task (20261023185116) lọc gợi ý cùng một luật.
--      KHÔNG xoá / tắt dữ liệu: dọn danh mục là việc của chủ (đề xuất trong báo cáo).
--  (2) Người: "anh Huy", "chị Lan", "a Huy"… không ai khớp nguyên chuỗi ⇒ bỏ danh xưng rồi khớp lại. Danh xưng đứng một mình vẫn
--      không phải tên (bẫy "mình" / "anh" / "em" của lõi task giữ nguyên).
-- Dựng từ thân production (md5 dfb062cf84bc9486e64a2e7b493a7233, đọc 24/10 bằng db:query, khớp file 20261021132433); vỏ public.hermes_write_name_resolve_v1
-- gắn OID lõi lúc tạo nên CREATE OR REPLACE giữ nguyên OID ⇒ vỏ không đổi. Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.buildings') IS NULL OR to_regclass('public.job_types') IS NULL OR to_regclass('public.building_common_names') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    -- Thân đang chạy phải đúng thân 20261021132433 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)'::regprocedure) NOT IN ('dfb062cf84bc9486e64a2e7b493a7233','61c730443aa0de267f097f8c0974f0f9') THEN
    RAISE EXCEPTION 'hermes_name_resolve_honorific_dependency_invalid'; END IF;
END $requires$;

-- 1. Hàm dùng chung: tên loại việc trùng (bỏ dấu, chỉ chữ + số) tên / mã (mỗi mã trong danh sách phẩy) / tên gọi chung của một toà
-- chưa xoá trong công ty mà người gọi thấy (RLS). Web dùng lại được khi làm ô chọn loại việc.
CREATE OR REPLACE FUNCTION public.job_type_building_like_v1(p_organization_id uuid,p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
  WITH k AS (SELECT regexp_replace(public.hermes_name_fold_v1(p_name),'[^a-z0-9]','','g') AS v)
  SELECT k.v<>'' AND EXISTS(
    SELECT 1 FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
      AND (regexp_replace(public.hermes_name_fold_v1(b.name),'[^a-z0-9]','','g')=k.v
        OR EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(b.code,''),',')) a(alias)
          WHERE regexp_replace(public.hermes_name_fold_v1(a.alias),'[^a-z0-9]','','g')=k.v)
        OR EXISTS(SELECT 1 FROM public.building_common_names c WHERE c.building_id=b.id
          AND regexp_replace(public.hermes_name_fold_v1(c.name),'[^a-z0-9]','','g')=k.v)))
  FROM k
$fn$;

-- 2. Lõi giải tên (INVOKER, dưới RLS người gọi): thân 20261021132433 + hai chỗ ở đầu file.
CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_member_ids uuid[],
  p_caller_member boolean)
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
    OR p_names IS NULL OR jsonb_typeof(p_names)<>'object' THEN
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
        WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual,false)),
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
        AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual,false)
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

  -- Loại việc: bằng rồi chứa, bỏ dấu; loại đã tắt không nhận; loại trùng tên một toà (nhập nhầm) không nhận.
  IF v_job IS NOT NULL THEN
    v_needle:=public.hermes_name_fold_v1(v_job);
    FOR v_attempt IN 1..2 LOOP
      CONTINUE WHEN v_attempt=2 AND char_length(v_needle)<2;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'name',j.name) ORDER BY j.name,j.id),'[]'::jsonb) INTO v_found
        FROM public.job_types j WHERE j.organization_id=p_organization_id AND COALESCE(j.is_active,true)
          AND NOT public.job_type_building_like_v1(p_organization_id,j.name)
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

  -- Người: hồ sơ thấy được qua RLS + thành viên ACTIVE (cùng helper của hàm tạo việc); bằng rồi chứa, bỏ dấu. Danh xưng + tên
  -- ("anh Huy", "chị Lan", "a Huy"): khớp nguyên chuỗi trước (tên thật có thể mở đầu bằng "Anh"), không ai khớp thì bỏ danh xưng
  -- rồi khớp lại (bằng rồi chứa). Danh xưng đứng một mình ("anh", "em") không phải tên: chỉ khớp nguyên chuỗi như cũ.
  IF v_person IS NOT NULL THEN
    v_needles:=ARRAY[public.hermes_name_fold_v1(v_person)];
    IF v_needles[1] ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|a|c|e) +[a-z0-9]' THEN
      v_needles:=v_needles||regexp_replace(v_needles[1],'^[a-z]+ +','');
    END IF;
    v_found:='[]'::jsonb;
    FOR v_attempt IN 1..4 LOOP
      CONTINUE WHEN v_attempt>2 AND cardinality(v_needles)<2;
      v_needle:=v_needles[CASE WHEN v_attempt<=2 THEN 1 ELSE 2 END];
      CONTINUE WHEN v_attempt IN (2,4) AND char_length(v_needle)<2;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) ORDER BY p.full_name,p.id),'[]'::jsonb) INTO v_found
        FROM public.profiles p WHERE p.full_name IS NOT NULL AND p.id=ANY(COALESCE(p_member_ids,'{}'::uuid[]))
          AND CASE WHEN v_attempt IN (1,3) THEN public.hermes_name_fold_v1(p.full_name)=v_needle
            ELSE strpos(public.hermes_name_fold_v1(p.full_name),v_needle)>0 END;
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

ALTER FUNCTION public.job_type_building_like_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.job_type_building_like_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.job_type_building_like_v1(uuid,text) TO authenticated;
-- Vỏ chạy dưới vai authenticated tới lõi qua OID: giữ EXECUTE như 20261021132433.
GRANT EXECUTE ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) TO authenticated;

DO $check$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)'::regprocedure AND NOT p.prosecdef
      AND 'search_path=""'=ANY(COALESCE(p.proconfig,'{}'::text[]))) IS DISTINCT FROM '61c730443aa0de267f097f8c0974f0f9'
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.job_type_building_like_v1(uuid,text)'::regprocedure AND NOT p.prosecdef AND p.provolatile='s'
      AND 'search_path=""'=ANY(COALESCE(p.proconfig,'{}'::text[])))
    OR has_function_privilege('anon','public.job_type_building_like_v1(uuid,text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.job_type_building_like_v1(uuid,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)','EXECUTE')
    -- Vỏ SQL-standard vẫn gắn đúng lõi (OID không đổi).
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)'::regprocedure AND prosqlbody IS NOT NULL) THEN
    RAISE EXCEPTION 'hermes_name_resolve_honorific_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
