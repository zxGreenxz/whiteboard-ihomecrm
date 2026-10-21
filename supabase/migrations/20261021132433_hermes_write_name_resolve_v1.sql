-- Đợt 1 nền chung thao tác ghi Hermes (D7, 21/10/2026; docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 7):
-- giải TÊN → ID cho thao tác GHI bằng hàm SQL dùng chung (quy tắc chủ chốt 17/10: công thức dùng ≥ 2 nơi hoặc dính
-- tiền/quyền đặt trong database — ghi tiền vào sai toà là sai tiền). Connector chỉ chuyển đối số và dựng câu hỏi lại;
-- web chuyển sang gọi cùng hàm là việc sau.
--  (1) public.hermes_name_fold_v1(text)  IMMUTABLE: NFC, chữ thường, bỏ dấu tiếng Việt (đ → d), gộp khoảng trắng.
--  (2) public.hermes_room_key_v1(text)   IMMUTABLE: như (1) rồi chỉ giữ chữ + số, bỏ tiền tố "phòng/ph/p" trước chữ số
--      ("P.302", "Phòng 302" ⇒ "302"), đúng khoá phòng của web (src/lib/quickEntry/resolve.ts roomKey).
--  (3) public.hermes_write_name_resolve_v1(org, toà[], names jsonb)  STABLE, SECURITY INVOKER, search_path='', thân
--      SQL-standard (BEGIN ATOMIC): gắn OID của lõi (4) và của helper thành viên app_private.hermes_task_assignee_member_v1
--      ngay lúc tạo, nên lúc chạy KHÔNG cần USAGE trên app_private (authenticated không có quyền đó ở production lẫn TEST,
--      đọc 21/10 23:35; cùng mẫu R2d 20261021063452). Đọc DƯỚI RLS của chính người gọi (buildings, rooms,
--      building_common_names, job_types, profiles). Người: hồ sơ thấy được qua RLS ∩ thành viên ACTIVE theo đúng helper mà
--      hàm tạo việc đang dùng (RLS organization_memberships chỉ cho siêu quản trị đọc, nên không lọc thuần RLS được).
--  (4) app_private.hermes_write_name_resolve_core_v1(org, toà[], names, thành viên[])  plpgsql STABLE, SECURITY INVOKER,
--      search_path='': thân giải tên; chỉ tham chiếu bảng/hàm public (plpgsql tra tên lúc chạy). Từ chối 42501 khi
--      current_user <> 'authenticated'. Client không gọi thẳng được (không USAGE app_private); chỉ tới qua OID của (3).
--      Không có hàm DEFINER mới, không chép policy.
--      names = {"building","room","jobType","person"} (mỗi khoá tuỳ chọn, chuỗi 1–120 ký tự).
--      Toà: tên / mã / từng bí danh trong mã tách dấu phẩy (như web splitAliases) / tên thường gọi, so sau khi bỏ dấu;
--      mã còn so dạng gọn (chỉ chữ + số); thử nguyên chuỗi rồi chuỗi bỏ tiền tố "toà "; khớp BẰNG trước, không có mới
--      khớp CHỨA (≥ 2 ký tự). Phòng: chỉ khớp BẰNG khoá phòng (tên hoặc bí danh mã), trong toà đã giải hoặc trong cả
--      phạm vi. Loại việc: bỏ dấu, bằng rồi chứa, bỏ loại đã tắt. Người: bỏ dấu, bằng rồi chứa.
--      Kết quả: {"status":"resolved","building","room","jobType","person"} (mỗi mục {id,name} hoặc null) hoặc
--      {"status":"unresolved","field","wanted","why","candidates":[{name[,buildingName]}] ≤ 8,"more"} với why:
--        ambiguous      — ≥ 2 ứng viên trong phạm vi được ghi;
--        outside_scope  — người gọi THẤY đối tượng (RLS) nhưng nó nằm ngoài phạm vi toà của khoá ghi;
--        not_visible    — không thấy gì trong phạm vi quyền. Hàm INVOKER không bao giờ biết "không có": RLS có thể ẩn
--                         đối tượng có thật, nên câu cho người dùng là "không thấy trong phạm vi quyền", không phải "không có".
--      Ứng viên chỉ gồm tên mà RLS của người gọi đã cho thấy; không có ID nào ngoài mục đã giải.
-- Không ghi dữ liệu. Idempotent (CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[['public.buildings','name'],['public.buildings','code'],['public.buildings','is_virtual'],
    ['public.buildings','deleted_at'],['public.buildings','organization_id'],['public.rooms','name'],['public.rooms','code'],
    ['public.rooms','deleted_at'],['public.rooms','building_id'],['public.rooms','organization_id'],
    ['public.building_common_names','building_id'],['public.building_common_names','name'],
    ['public.job_types','name'],['public.job_types','is_active'],['public.job_types','organization_id'],['public.profiles','full_name']] LOOP
    IF to_regclass(item[1]) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass(item[1]) AND attname=item[2] AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'hermes_write_name_resolve_dependency_invalid: %.%',item[1],item[2]; END IF;
  END LOOP;
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'hermes_write_name_resolve_dependency_invalid: auth.uid()/hermes_task_assignee_member_v1'; END IF;
END $requires$;

-- 1. Bỏ dấu tiếng Việt (67 chữ có dấu thường, sau lower) + đ → d; gộp khoảng trắng.
CREATE OR REPLACE FUNCTION public.hermes_name_fold_v1(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT btrim(regexp_replace(translate(lower(normalize(COALESCE(p_text,''),NFC)),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'\s+',' ','g'))
$fn$;

-- 2. Khoá phòng: chỉ chữ + số, bỏ tiền tố phòng/ph/p đứng trước chữ số.
CREATE OR REPLACE FUNCTION public.hermes_room_key_v1(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT regexp_replace(regexp_replace(public.hermes_name_fold_v1(p_text),'[^a-z0-9]','','g'),'^(phong|ph|p)(?=[0-9])','')
$fn$;

-- 4. Lõi giải tên cho thao tác ghi, dưới RLS của người gọi. p_member_ids = hồ sơ là thành viên ACTIVE (do (3) tính).
CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_member_ids uuid[])
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
      RETURN jsonb_build_object('status','unresolved','field','building','wanted',v_building,
        'why',CASE WHEN jsonb_array_length(v_in)>1 THEN 'ambiguous' WHEN jsonb_array_length(v_out)>0 THEN 'outside_scope' ELSE 'not_visible' END,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(
          CASE WHEN jsonb_array_length(v_in)>1 THEN v_in ELSE v_out END) WITH ORDINALITY AS x(e,ord) WHERE ord<=8),
        'more',GREATEST(jsonb_array_length(v_in),jsonb_array_length(v_out))>8);
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

-- 3. Vỏ public SQL-standard: OID của lõi và helper thành viên gắn lúc tạo (không cần USAGE app_private lúc chạy). Danh sách
-- thành viên chỉ tính khi có hỏi người: hồ sơ thấy được qua RLS của người gọi ∩ thành viên ACTIVE của công ty.
CREATE OR REPLACE FUNCTION public.hermes_write_name_resolve_v1(p_organization_id uuid,p_building_ids uuid[],p_names jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
BEGIN ATOMIC
  SELECT app_private.hermes_write_name_resolve_core_v1(p_organization_id,p_building_ids,p_names,
    CASE WHEN jsonb_typeof(p_names)='object' AND p_names ? 'person' THEN ARRAY(SELECT p.id FROM public.profiles p
      WHERE p.full_name IS NOT NULL AND app_private.hermes_task_assignee_member_v1(p.id,p_organization_id)) ELSE '{}'::uuid[] END);
END;

ALTER FUNCTION public.hermes_name_fold_v1(text) OWNER TO postgres;
ALTER FUNCTION public.hermes_room_key_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_name_fold_v1(text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_room_key_v1(text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_name_fold_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_room_key_v1(text) TO authenticated;
-- Vỏ chạy dưới vai authenticated nên cần EXECUTE trên lõi (tới qua OID, không qua tên).
GRANT EXECUTE ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb) TO authenticated;

DO $check$
DECLARE fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.hermes_name_fold_v1(text)','public.hermes_room_key_v1(text)',
      'public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)','app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[])']::regprocedure[] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn AND (p.prosecdef OR NOT ('search_path=""'=ANY(COALESCE(p.proconfig,'{}'::text[])))
        OR p.provolatile::text<>CASE WHEN fn IN ('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)'::regprocedure,
          'app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[])'::regprocedure) THEN 's' ELSE 'i' END))
      OR has_function_privilege('anon',fn,'EXECUTE') OR NOT has_function_privilege('authenticated',fn,'EXECUTE') THEN
      RAISE EXCEPTION 'hermes_write_name_resolve_catalog_invalid: %',fn; END IF;
  END LOOP;
  -- Vỏ public phải là thân SQL-standard (OID gắn lúc tạo): thân plpgsql sẽ tra app_private lúc chạy và hỏng ở production.
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)'::regprocedure AND prosqlbody IS NOT NULL) THEN
    RAISE EXCEPTION 'hermes_write_name_resolve_catalog_invalid: wrapper body'; END IF;
END $check$;
COMMIT;
