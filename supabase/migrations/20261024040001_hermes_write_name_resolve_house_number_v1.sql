-- Hermes trang Hợp đồng, lượt 11 — sửa theo nghiệm thu bot thật trên TEST (24/10): giải TÊN TOÀ không khớp hai dạng viết gần nhau
-- "45 Hoa Mai" / "45/3 Hoa Mai" (người dùng gõ thiếu "/3" ⇒ not_visible). Lõi giải tên dùng chung của thao tác GHI (nền chung
-- 20261021132433 và bản nhận toà ảo của Thu chi 20261022044120) — mọi trang ghi (Hợp đồng, Hoá đơn, Công việc, Thu chi) cùng dùng.
-- Một thay đổi ở khối TOÀ, chép y hệt vào cả hai lõi: sau bốn bậc cũ (bằng nguyên chuỗi, bằng sau khi bỏ "toà ", chứa nguyên chuỗi,
-- chứa sau khi bỏ "toà ") thêm bậc 5–6 khớp TOKEN: "/" và mọi dấu câu là khoảng trắng mềm; bằng sau khi làm mềm, hoặc (chuỗi có số nhà
-- + chữ, ≥ 2 token) tập token của tên/mã/tên thường gọi chứa MỌI token đã gõ. Bậc mới chỉ chạy khi bốn bậc cũ KHÔNG thấy toà nào (kể cả
-- toà ngoài phạm vi) ⇒ mọi ca đang ra resolved / ambiguous / outside_scope giữ nguyên; chỉ ca not_visible có thể đổi. Nhiều toà cùng
-- khớp ⇒ ambiguous (ứng viên trong phạm vi được ghi) — không tự chọn. Phòng, loại việc, người: không đổi.
-- Connector (đọc): infra/hermes-broker/read-name-resolution.mjs matchBuildings thêm cùng bậc (cùng phát hành, không phụ thuộc thứ tự).
-- Lượt 11b: core_v1 dựng từ thân của 20261023185114 (#304 Công việc lượt 11: danh xưng người + loại việc trùng tên toà; md5
-- 081243f1965abdde1431607e762be438) — file đó áp TRƯỚC file này (cùng đợt tích hợp C1, thứ tự tên); core_v2 dựng từ thân production 20261022044120 (md5
-- 10982efd43b237a096213dbe8f4e1bc1, đọc 24/10 bằng db:query).
-- Vỏ public.hermes_write_name_resolve_v1 / _v2 gắn OID lõi lúc tạo; CREATE OR REPLACE giữ OID ⇒ vỏ không đổi. Không DROP, không ghi dữ liệu.
-- THỨ TỰ: 20261023185114 → file này. $requires$ chỉ nhận thân của 185114 (hoặc thân của chính file này khi chạy lại) ⇒ áp trước 185114
-- thì dừng, không xoá bản sửa danh xưng; sau khi áp file này, chạy lại 185114 sẽ dừng ở $requires$ của nó (cần ngoại lệ pinned).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)') IS NULL
    -- Thân 185114 gọi hàm dùng chung loại việc trùng tên toà của chính file đó.
    OR to_regprocedure('public.job_type_building_like_v1(uuid,text)') IS NULL
    -- core_v1 phải đúng thân 185114, core_v2 đúng thân production (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)'::regprocedure) NOT IN ('081243f1965abdde1431607e762be438','4d1fa5e0274db7e22fff70a08d7143fa')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)'::regprocedure) NOT IN ('10982efd43b237a096213dbe8f4e1bc1','6deb5d8e8c56882bc0201a062788aee1') THEN
    RAISE EXCEPTION 'hermes_write_name_house_number_dependency_invalid'; END IF;
END $requires$;

-- 1. Lõi giải tên cho thao tác ghi (thân 20261023185114 + bậc token ở khối toà).
CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_member_ids uuid[],
  p_caller_member boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_entry record; v_value text;
  v_building text; v_room text; v_job text; v_person text;
  v_needles text[]; v_needle text; v_attempt int; v_found jsonb; v_in jsonb; v_out jsonb; v_honor boolean:=false;
  v_soft text; v_tokens text[]; v_loose boolean;
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
    -- Lượt 11 (nghiệm thu 24/10): bậc 5–6 SAU bằng / chứa — khớp TOKEN (số nhà + tên đường), "/" và dấu câu là khoảng trắng mềm:
    -- "45 Hoa Mai" ⇒ "45/3 Hoa Mai". Chỉ chạy khi bốn bậc cũ không thấy toà nào (kể cả ngoài phạm vi) ⇒ mọi ca cũ
    -- giữ nguyên kết quả; nhiều toà cùng khớp ⇒ ambiguous (hỏi lại), không tự chọn.
    FOR v_attempt IN 1..6 LOOP
      v_needle:=v_needles[CASE WHEN v_attempt IN (1,3,5) THEN 1 ELSE 2 END];
      CONTINUE WHEN v_needle IS NULL OR (v_attempt>2 AND char_length(v_needle)<2);
      v_soft:=btrim(regexp_replace(v_needle,'[^a-z0-9]+',' ','g')); v_tokens:=string_to_array(v_soft,' ');
      -- Khớp lỏng (token của tên chứa MỌI token đã gõ, không kể thứ tự) chỉ khi chuỗi có ≥ 2 token, có chữ và có một token toàn số
      -- (số nhà); còn lại chỉ khớp bằng sau khi làm mềm ("45 3 hoa mai" = "45/3 Hoa Mai").
      v_loose:=v_soft ~ '[a-z]' AND cardinality(v_tokens)>=2 AND EXISTS(SELECT 1 FROM unnest(v_tokens) t(x) WHERE t.x ~ '^[0-9]+$');
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
          WHEN v_attempt<=4 THEN strpos(k.k,v_needle)>0
          ELSE v_soft<>'' AND (btrim(regexp_replace(k.k,'[^a-z0-9]+',' ','g'))=v_soft
            OR (v_loose AND string_to_array(btrim(regexp_replace(k.k,'[^a-z0-9]+',' ','g')),' ') @> v_tokens)) END)
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
  -- ("anh Huy", "chị Lan", "e Hoa"; review lượt 11b): (1) bằng NGUYÊN chuỗi (tên thật mở đầu bằng "Anh" như "Anh Tú"), (2) bằng tên đã
  -- bỏ danh xưng, (3) tên đã bỏ danh xưng là TRỌN TỪ trong tên (bỏ dấu câu: "B.Huy" = "b huy"). Không bao giờ "chứa" nguyên chuỗi có
  -- danh xưng: "anh huy" nằm trong "thanh huy", "e hoa" nằm trong "le hoa" — khớp nhầm. Danh xưng đứng một mình ("anh", "em") không
  -- phải tên: đi luật cũ (bằng rồi chứa) như mọi chuỗi không có danh xưng.
  IF v_person IS NOT NULL THEN
    v_needles:=ARRAY[public.hermes_name_fold_v1(v_person)];
    v_honor:=v_needles[1] ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|a|c|e) +[a-z0-9]';
    IF v_honor THEN
      v_needles:=v_needles||btrim(regexp_replace(regexp_replace(v_needles[1],'^[a-z]+ +',''),'[^a-z0-9]+',' ','g'));
    END IF;
    v_found:='[]'::jsonb;
    FOR v_attempt IN 1..3 LOOP
      CONTINUE WHEN v_attempt=3 AND NOT v_honor;
      CONTINUE WHEN v_attempt=2 AND NOT v_honor AND char_length(v_needles[1])<2;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) ORDER BY p.full_name,p.id),'[]'::jsonb) INTO v_found
        FROM public.profiles p WHERE p.full_name IS NOT NULL AND p.id=ANY(COALESCE(p_member_ids,'{}'::uuid[]))
          AND CASE
            WHEN v_attempt=1 THEN public.hermes_name_fold_v1(p.full_name)=v_needles[1]
            -- Không danh xưng: chứa như cũ (ba trang ghi cùng dùng).
            WHEN NOT v_honor THEN strpos(public.hermes_name_fold_v1(p.full_name),v_needles[1])>0
            WHEN v_attempt=2 THEN btrim(regexp_replace(public.hermes_name_fold_v1(p.full_name),'[^a-z0-9]+',' ','g'))=v_needles[2]
            ELSE position(' '||v_needles[2]||' ' IN ' '||btrim(regexp_replace(public.hermes_name_fold_v1(p.full_name),'[^a-z0-9]+',' ','g'))||' ')>0 END;
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

-- 2. Lõi giải tên nhận toà ảo của Thu chi (thân 20261022044120 + cùng bậc token).
CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v2(p_organization_id uuid,p_building_ids uuid[],p_names jsonb,p_member_ids uuid[],
  p_caller_member boolean,p_include_virtual boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_entry record; v_value text;
  v_building text; v_room text; v_job text; v_person text;
  v_needles text[]; v_needle text; v_attempt int; v_found jsonb; v_in jsonb; v_out jsonb;
  v_soft text; v_tokens text[]; v_loose boolean;
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
    -- Lượt 11 (nghiệm thu 24/10): bậc 5–6 SAU bằng / chứa — khớp TOKEN (số nhà + tên đường), "/" và dấu câu là khoảng trắng mềm:
    -- "45 Hoa Mai" ⇒ "45/3 Hoa Mai". Chỉ chạy khi bốn bậc cũ không thấy toà nào (kể cả ngoài phạm vi) ⇒ mọi ca cũ
    -- giữ nguyên kết quả; nhiều toà cùng khớp ⇒ ambiguous (hỏi lại), không tự chọn.
    FOR v_attempt IN 1..6 LOOP
      v_needle:=v_needles[CASE WHEN v_attempt IN (1,3,5) THEN 1 ELSE 2 END];
      CONTINUE WHEN v_needle IS NULL OR (v_attempt>2 AND char_length(v_needle)<2);
      v_soft:=btrim(regexp_replace(v_needle,'[^a-z0-9]+',' ','g')); v_tokens:=string_to_array(v_soft,' ');
      -- Khớp lỏng (token của tên chứa MỌI token đã gõ, không kể thứ tự) chỉ khi chuỗi có ≥ 2 token, có chữ và có một token toàn số
      -- (số nhà); còn lại chỉ khớp bằng sau khi làm mềm ("45 3 hoa mai" = "45/3 Hoa Mai").
      v_loose:=v_soft ~ '[a-z]' AND cardinality(v_tokens)>=2 AND EXISTS(SELECT 1 FROM unnest(v_tokens) t(x) WHERE t.x ~ '^[0-9]+$');
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
          WHEN v_attempt<=4 THEN strpos(k.k,v_needle)>0
          ELSE v_soft<>'' AND (btrim(regexp_replace(k.k,'[^a-z0-9]+',' ','g'))=v_soft
            OR (v_loose AND string_to_array(btrim(regexp_replace(k.k,'[^a-z0-9]+',' ','g')),' ') @> v_tokens)) END)
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

ALTER FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ chạy dưới vai authenticated nên cần EXECUTE trên lõi (tới qua OID, không qua tên).
GRANT EXECUTE ON FUNCTION app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean) TO authenticated;

DO $check$
DECLARE fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)','app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)']::regprocedure[] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn AND NOT p.prosecdef AND p.provolatile='s' AND pg_get_userbyid(p.proowner)='postgres'
        AND 'search_path=""'=ANY(COALESCE(p.proconfig,'{}'::text[])))
      OR has_function_privilege('anon',fn,'EXECUTE') OR has_function_privilege('service_role',fn,'EXECUTE')
      OR NOT has_function_privilege('authenticated',fn,'EXECUTE') THEN
      RAISE EXCEPTION 'hermes_write_name_house_number_catalog_invalid: %',fn; END IF;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)'::regprocedure)<>'4d1fa5e0274db7e22fff70a08d7143fa'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)'::regprocedure)<>'6deb5d8e8c56882bc0201a062788aee1'
    -- Vỏ vẫn là thân SQL-standard gắn OID lõi (không tra app_private lúc chạy).
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)'::regprocedure AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)'::regprocedure AND prosqlbody IS NOT NULL) THEN
    RAISE EXCEPTION 'hermes_write_name_house_number_catalog_invalid: body'; END IF;
END $check$;
COMMIT;
