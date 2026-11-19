-- Hermes Thu chi — lượt 19 (27/10/2026; nghiệm thu bot Thu chi, ca J06 trượt lặp lại; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 30).
-- Áp SAU 20261024210500_hermes_expense_voucher_building_v1 (thân lõi giải của file đó — md5 4e29591f…, đã áp production 25/10 — là thân dựng từ).
-- Lỗi: quản lý toà chỉ "biết sổ" Chung (thấy sổ, không giữ ⇒ không chi được từ sổ đó) nhắn "Chi 300k sửa khoá cửa phòng 201 toà 80, lấy tiền sổ
-- Chung" ⇒ expense.create (chưa nêu hạng mục) trả name_unresolved field category, KHÔNG nói gì về sổ: lõi giải xét toà/phòng → hạng mục → sổ, nên
-- sổ người dùng nêu chỉ được kiểm khi hạng mục đã rõ ⇒ bot hỏi hạng mục, người dùng chỉ biết sổ Chung không dùng được ở lượt sau.
-- Sửa (chỉ expense.create): sổ NGƯỜI DÙNG NÊU được giải TRƯỚC câu hỏi hạng mục — không giữ ⇒ cashbook_not_held, không thấy / mơ hồ ⇒ hỏi sổ
-- (name_unresolved field cashbook, ứng viên = sổ đang giữ khớp tên như cũ), ngay lượt đầu. Thứ tự mới: toà/phòng → luồng hệ thống / khoản THU
-- (web_only + link, vẫn thắng như cũ: không làm qua bot dù sổ nào) → sổ nêu tên → câu hỏi hạng mục → sổ mặc định. Không nêu sổ ⇒ như cũ (hỏi
-- hạng mục trước, sổ mặc định sau). Mã / khuôn trả về không đổi (cashbook_not_held không kèm tên sổ: khuôn rejected không có ứng viên) ⇒ connector
-- không đổi, không phụ thuộc thứ tự phát hành. expense.edit / approve / note / cancel và mọi dòng khác byte-identical với thân 210500.
-- Ghim md5 thân 210500 hoặc thân của chính file. Ghim chéo: 20261024210500 ghim thân lõi giải ⇒ sau khi áp file này, chạy lại 210500 ngã đúng
-- khối $requires$ (cần ngoại lệ pinned sau áp; 210500 ngoài diff ⇒ CI không đỏ). Không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL OR to_regclass('public.income_expenses') IS NULL OR to_regclass('public.buildings') IS NULL
      OR to_regprocedure('public.hermes_expense_category_pick_v1(uuid,text,text)') IS NULL OR to_regprocedure('public.list_cashbooks_for_expense_v2()') IS NULL
      OR to_regprocedure('public.ie_default_cashbook_v1(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'hermes_expense_cashbook_first_dependency_invalid'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)')),'')
      NOT IN ('4e29591f8df676de4942266a5f6d674d','9636ab61d457dd7a4b3d54194a9d6f63') THEN
    RAISE EXCEPTION 'hermes_expense_cashbook_first_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_item jsonb; v_out jsonb:='[]'::jsonb; v_name jsonb; v_building uuid; v_type uuid; v_type_name text; v_auto boolean; v_cashbook uuid;
  v_cashbook_name text; v_last uuid; v_date date; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date; v_period_start date; v_period_end date;
  v_wanted text; v_hits jsonb; v_code text; v_voucher record; v_visible int; v_i int:=0; v_extra jsonb; v_cat jsonb; v_list jsonb;
  v_m text[]; v_day int; v_month int; v_year int; v_hint text; v_ids uuid[]; v_narrow uuid[]; v_digits text; v_rest text; v_uuid uuid; v_bfilter text; v_bmatch uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_expense_resolve_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR p_action IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
  IF p_action IN ('expense.approve','expense.note','expense.edit','expense.cancel') THEN
    -- Mã phiếu (Mốc 5 / lượt 11): approve ≤ 10 mã, note / edit / cancel một mã; mỗi mã giải dưới RLS người hỏi, trong phạm vi khoá.
    IF p_action='expense.approve' THEN
      IF jsonb_typeof(p_params->'voucherCodes') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'voucherCodes') NOT BETWEEN 1 AND 10 THEN
        RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
      v_list:=p_params->'voucherCodes';
    ELSE
      IF jsonb_typeof(p_params->'voucherCode') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
      v_list:=jsonb_build_array(p_params->'voucherCode');
    END IF;
    -- Lượt 16 (nghiệm thu C3d: "duyệt các phiếu chờ toà 1392QT …" mà PC2609115 có ở cả 1392QT và 950NK ⇒ vẫn hỏi chọn phiếu): buildingName
    -- tuỳ chọn = toà của phiếu (approve: chung cho cả lô; edit: toà nêu đúng toà của phiếu ⇒ không đổi toà như cũ). Chỉ dùng để chọn khi mã trùng.
    v_bfilter:=NULLIF(btrim(regexp_replace(' '||regexp_replace(public.hermes_name_fold_v1(COALESCE(p_params->>'buildingName','')),'[^a-z0-9]+',' ','g')||' ',
      '^ *((toa|nha) +)+',' ')),'');
    FOR v_wanted IN SELECT value FROM jsonb_array_elements_text(v_list) LOOP
      v_wanted:=btrim(v_wanted);
      IF v_wanted IS NULL OR v_wanted='' THEN RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
      -- Lượt 11 (nghiệm thu): mã phiếu bị dùng lại giữa các toà (dãy theo toà) ⇒ khớp ĐÚNG mã đầy đủ trước (chữ + ≥ 3 số; không có thì chữ +
      -- số; không có nữa thì cả chuỗi như cũ), rồi dùng phần còn lại của chuỗi làm gợi ý: ngày dd/mm[/yyyy] và tên toà (vd chép lại nhãn ứng
      -- viên "PC2609034 · 01/09/2026 · 44TL · 500.000đ"). Gợi ý không khớp phiếu nào thì bỏ qua (vẫn hỏi lại đủ ứng viên).
      -- Lượt 14 (nghiệm thu vòng 1): voucherId (UUID) của dòng báo cáo W2 expense_vouchers ⇒ đúng phiếu đó (mã bị dùng lại giữa các toà; trước
      -- đây UUID bị đọc như mã ⇒ không thấy). Vẫn dưới RLS người hỏi, trong phạm vi khoá (ngoài phạm vi ⇒ outside_scope như mã).
      v_uuid:=CASE WHEN v_wanted ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_wanted::uuid END;
      v_code:=CASE WHEN v_uuid IS NULL THEN upper(COALESCE(substring(v_wanted FROM '[A-Za-z]{1,6}[0-9]{3,12}'),substring(v_wanted FROM '[A-Za-z]{1,6}[0-9]{1,12}'),v_wanted)) END;
      v_m:=regexp_match(v_wanted,'(?:^|[^0-9])([0-9]{1,2})[/.-]([0-9]{1,2})(?:[/.-]([0-9]{2,4}))?(?:[^0-9]|$)');
      v_day:=v_m[1]::int; v_month:=v_m[2]::int;
      v_year:=CASE WHEN v_m[3] IS NULL THEN NULL WHEN char_length(v_m[3])=2 THEN 2000+v_m[3]::int ELSE v_m[3]::int END;
      v_rest:=replace(public.hermes_name_fold_v1(v_wanted),lower(v_code),' ');
      v_rest:=regexp_replace(v_rest,'[0-9]{1,2}[/.-][0-9]{1,2}([/.-][0-9]{2,4})?',' ','g');
      v_rest:=regexp_replace(v_rest,'(^|[^a-z0-9])[0-9][0-9.,]*( ?(d|k|vnd|tr))?(?=[^a-z0-9]|$)',' ','g');
      v_rest:=regexp_replace(' '||regexp_replace(v_rest,'[^a-z0-9]+',' ','g')||' ',' (phieu|ma|ngay|toa|o|cua|tai|so) ',' ','g');
      v_hint:=NULLIF(btrim(regexp_replace(v_rest,' +',' ','g')),'');
      SELECT COALESCE(array_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id) FILTER (WHERE ie.building_id=ANY(p_building_ids)),'{}'::uuid[]),count(*)::int
        INTO v_ids,v_visible FROM public.income_expenses ie
        WHERE ie.organization_id=p_organization_id AND CASE WHEN v_uuid IS NOT NULL THEN ie.id=v_uuid ELSE upper(ie.code)=v_code END AND ie.deleted_at IS NULL;
      v_narrow:=v_ids;
      -- Lượt 16: người dùng đã nêu toà ⇒ phiếu cùng mã của toà đó, xét trên MỌI phiếu thấy được (khớp đúng tên trước, rồi chứa chuỗi ≥ 3 ký tự).
      -- Phiếu của toà nêu chỉ nằm ngoài phạm vi khoá ⇒ outside_scope (không lặng lẽ chọn phiếu cùng mã ở toà khác); có trong phạm vi ⇒ chỉ những
      -- phiếu đó; không khớp toà nào ⇒ bỏ qua (như cũ: một phiếu thì chọn, nhiều phiếu thì hỏi lại đủ ứng viên).
      IF v_bfilter IS NOT NULL AND v_visible>0 THEN
        SELECT COALESCE(array_agg(x.id) FILTER (WHERE x.exact),array_agg(x.id)) INTO v_bmatch
          FROM (SELECT ie.id,n.k=v_bfilter exact FROM public.income_expenses ie JOIN public.buildings b ON b.id=ie.building_id,
              LATERAL (SELECT btrim(regexp_replace(' '||regexp_replace(public.hermes_name_fold_v1(b.name),'[^a-z0-9]+',' ','g')||' ','^ *((toa|nha) +)+',' ')) k) n
            WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL AND CASE WHEN v_uuid IS NOT NULL THEN ie.id=v_uuid ELSE upper(ie.code)=v_code END
              AND (n.k=v_bfilter OR (char_length(v_bfilter)>=3 AND strpos(n.k,v_bfilter)>0))) x;
        IF cardinality(v_bmatch)>0 THEN
          IF NOT (v_bmatch && v_ids) THEN RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(v_wanted,200),
            'why','outside_scope','candidates','[]'::jsonb,'more',false); END IF;
          SELECT array_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id) INTO v_narrow FROM public.income_expenses ie WHERE ie.id=ANY(v_bmatch) AND ie.id=ANY(v_ids);
        END IF;
      END IF;
      IF cardinality(v_narrow)>1 AND v_day IS NOT NULL THEN
        SELECT COALESCE(array_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id),v_narrow) INTO v_narrow FROM public.income_expenses ie WHERE ie.id=ANY(v_narrow)
          AND extract(day FROM ie.voucher_date)=v_day AND extract(month FROM ie.voucher_date)=v_month
          AND (v_year IS NULL OR extract(year FROM ie.voucher_date)=v_year);
      END IF;
      IF cardinality(v_narrow)>1 AND v_hint IS NOT NULL THEN
        SELECT COALESCE(array_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id),v_narrow) INTO v_narrow
          FROM public.income_expenses ie JOIN public.buildings b ON b.id=ie.building_id,
            LATERAL (SELECT regexp_replace(public.hermes_name_fold_v1(b.name),'^(toa|nha) +','') k) n
          WHERE ie.id=ANY(v_narrow) AND (n.k=v_hint OR (char_length(v_hint)>=3 AND strpos(n.k,v_hint)>0));
      END IF;
      IF cardinality(v_narrow)=1 THEN
        SELECT ie.id,ie.code,ie.building_id INTO v_voucher FROM public.income_expenses ie WHERE ie.id=v_narrow[1];
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_out) x WHERE x->>'voucherId'=v_voucher.id::text) THEN
          RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
        v_out:=v_out||jsonb_build_array(jsonb_build_object('voucherId',v_voucher.id,'voucherCode',v_voucher.code,'buildingId',v_voucher.building_id));
        CONTINUE;
      END IF;
      IF cardinality(v_narrow)>1 THEN
        RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(v_wanted,200),'why','ambiguous','more',cardinality(v_narrow)>8,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.label) ORDER BY x.voucher_date DESC,x.label),'[]'::jsonb) FROM (
            SELECT ie.voucher_date,ie.code||' · '||to_char(ie.voucher_date,'DD/MM/YYYY')||' · '||COALESCE(b.name,'?')||' · '
              ||replace(to_char(round(ie.total_amount),'FM999,999,999,999,999'),',','.')||'đ' label
            FROM public.income_expenses ie LEFT JOIN public.buildings b ON b.id=ie.building_id
            WHERE ie.id=ANY(v_narrow) ORDER BY ie.voucher_date DESC LIMIT 8) x));
      END IF;
      IF v_visible>0 THEN RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(v_wanted,200),
        'why','outside_scope','candidates','[]'::jsonb,'more',false); END IF;
      -- Mã ngắn / thiếu (vd "PC034"): phiếu trong phạm vi có mã KẾT THÚC bằng dãy số đã nêu, cùng tiền tố chữ — chỉ để hỏi lại, không bao giờ tự
      -- chọn (ghi chú ghi thẳng, không có bản xem trước).
      v_digits:=substring(v_code FROM '([0-9]{3,})$');
      IF v_digits IS NOT NULL THEN
        SELECT COALESCE(array_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id),'{}'::uuid[]) INTO v_narrow FROM public.income_expenses ie
          WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL AND ie.building_id=ANY(p_building_ids)
            AND upper(ie.code) LIKE COALESCE(substring(v_code FROM '^[A-Z]+'),'')||'%'||v_digits;
        IF cardinality(v_narrow)>0 THEN
          RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(v_wanted,200),'why','ambiguous','more',cardinality(v_narrow)>8,
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.label) ORDER BY x.voucher_date DESC,x.label),'[]'::jsonb) FROM (
              SELECT ie.voucher_date,ie.code||' · '||to_char(ie.voucher_date,'DD/MM/YYYY')||' · '||COALESCE(b.name,'?')||' · '
              ||replace(to_char(round(ie.total_amount),'FM999,999,999,999,999'),',','.')||'đ' label
              FROM public.income_expenses ie LEFT JOIN public.buildings b ON b.id=ie.building_id
              WHERE ie.id=ANY(v_narrow) ORDER BY ie.voucher_date DESC LIMIT 8) x));
        END IF;
      END IF;
      RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(v_wanted,200),'why','not_visible','candidates','[]'::jsonb,'more',false);
    END LOOP;
    IF p_action='expense.approve' THEN RETURN jsonb_build_object('status','resolved','resolved',jsonb_build_object('vouchers',v_out)); END IF;
    v_extra:=v_out->0;
    IF p_action='expense.edit' THEN
      -- Mốc 4, expense.edit: tên mới (nếu nêu) giải như expense.create. Toà mới trong phạm vi khoá (nhận toà ảo); chỉ nêu phòng ⇒ phòng
      -- trong toà của phiếu. Hạng mục / sổ chỉ nhận tên người dùng nêu (sửa không tự gợi ý).
      IF NULLIF(btrim(p_params->>'buildingName'),'') IS NOT NULL OR NULLIF(btrim(p_params->>'roomName'),'') IS NOT NULL THEN
        v_name:=public.hermes_write_name_resolve_v2(p_organization_id,
          CASE WHEN NULLIF(btrim(p_params->>'buildingName'),'') IS NULL THEN ARRAY[(v_extra->>'buildingId')::uuid] ELSE p_building_ids END,
          jsonb_strip_nulls(jsonb_build_object('building',NULLIF(btrim(p_params->>'buildingName'),''),'room',NULLIF(btrim(p_params->>'roomName'),''))),true);
        IF v_name->>'status'<>'resolved' THEN RETURN v_name; END IF;
        IF NULLIF(btrim(p_params->>'buildingName'),'') IS NOT NULL THEN
          IF v_name#>>'{building,id}' IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','building','wanted',left(btrim(p_params->>'buildingName'),200),
            'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
          v_extra:=v_extra||jsonb_build_object('newBuildingId',v_name#>>'{building,id}','newBuildingName',v_name#>>'{building,name}');
        END IF;
        IF v_name#>>'{room,id}' IS NOT NULL THEN v_extra:=v_extra||jsonb_build_object('roomId',v_name#>>'{room,id}','roomName',v_name#>>'{room,name}'); END IF;
      END IF;
      IF NULLIF(btrim(p_params->>'category'),'') IS NOT NULL THEN
        -- Lượt 11: chọn hạng mục chung với expense.create (public.hermes_expense_category_pick_v1); sửa không tự gợi ý theo nội dung.
        v_cat:=public.hermes_expense_category_pick_v1(p_organization_id,p_params->>'category',NULL);
        IF v_cat->>'status'<>'resolved' THEN RETURN v_cat; END IF;
        v_extra:=v_extra||jsonb_build_object('typeId',v_cat->>'typeId','typeName',v_cat->>'typeName');
      END IF;
      IF NULLIF(btrim(p_params->>'cashbook'),'') IS NOT NULL THEN
        v_wanted:=public.hermes_name_fold_v1(p_params->>'cashbook');
        SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'exact',public.hermes_name_fold_v1(a.name)=v_wanted,'held',c.id IS NOT NULL) ORDER BY a.name) INTO v_hits
          FROM public.accounts a LEFT JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id
          WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false)
            AND (public.hermes_name_fold_v1(a.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(a.name),v_wanted)>0));
        IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
          v_hits:=(SELECT jsonb_agg(h) FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean);
        END IF;
        IF jsonb_array_length(COALESCE(v_hits,'[]'))<>1 THEN
          RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(p_params->>'cashbook'),200),
            'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8,
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h
              WHERE (h->>'held')::boolean LIMIT 8) x));
        END IF;
        IF NOT (v_hits#>>'{0,held}')::boolean THEN RETURN jsonb_build_object('status','rejected','reason','cashbook_not_held'); END IF;
        v_extra:=v_extra||jsonb_build_object('cashbookId',v_hits#>>'{0,id}','cashbookName',v_hits#>>'{0,name}');
      END IF;
    END IF;
    RETURN jsonb_build_object('status','resolved','resolved',v_extra);
  END IF;
  IF p_action<>'expense.create' OR jsonb_typeof(p_params->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'items') NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
  -- Sổ "dùng lần trước" của Hermes: sổ của phiếu CHI lập tay gần nhất của chính người dùng ở công ty này (web dùng localStorage).
  SELECT ie.account_id INTO v_last FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id AND ie.user_id=auth.uid()
    AND ie.type='EXPENSE' AND ie.system_source IS NULL AND ie.deleted_at IS NULL AND ie.account_id IS NOT NULL ORDER BY ie.created_at DESC LIMIT 1;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_params->'items') LOOP
    v_i:=v_i+1;
    -- Toà / phòng (D7), NHẬN toà ảo: chi phí chung ghi ở toà ảo như web Thu chi (ie_form_buildings).
    v_name:=public.hermes_write_name_resolve_v2(p_organization_id,p_building_ids,
      jsonb_strip_nulls(jsonb_build_object('building',v_item->>'buildingName','room',v_item->>'roomName')),true);
    IF v_name->>'status'<>'resolved' THEN RETURN v_name||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END; END IF;
    v_building:=(v_name#>>'{building,id}')::uuid;
    IF v_building IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','building','wanted',COALESCE(v_item->>'buildingName',''),
      'why','not_visible','candidates','[]'::jsonb,'more',false)||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END; END IF;
    -- Hạng mục (lượt 11): public.hermes_expense_category_pick_v1 — tập dùng được của Hermes (như hermes_expense_category_ok_v1) dưới RLS người
    -- hỏi; nêu tên ⇒ khớp tên / chuỗi / đủ từ; không nêu ⇒ gợi ý dùng chung với Báo chi nhanh, chỉ tự nhận khi KHOÁ CỨNG (không bao giờ tự chọn
    -- "Chi khác" hay hạng mục dòng tiền), còn lại hỏi lại với ứng viên đúng nghĩa. Bước ghi kiểm lại bằng hermes_expense_category_ok_v1.
    v_cat:=public.hermes_expense_category_pick_v1(p_organization_id,NULLIF(btrim(v_item->>'category'),''),v_item->>'content');
    -- Lượt 19: luồng hệ thống / khoản THU (web_only + link) vẫn thắng mọi kiểm sau — không làm qua bot dù người dùng nêu sổ nào.
    IF v_cat->>'status'='rejected' THEN RETURN v_cat||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END; END IF;
    -- Sổ quỹ: chỉ sổ đang giữ của công ty (như expenseCashbooksForOrg); sổ thấy mà không giữ ⇒ cashbook_not_held ngay lượt 1.
    -- Lượt 19 (nghiệm thu J06: "… lấy tiền sổ Chung" của người chỉ biết sổ ⇒ máy chủ hỏi hạng mục, không nói gì về sổ): sổ NGƯỜI DÙNG NÊU giải
    -- TRƯỚC câu hỏi hạng mục (không giữ ⇒ cashbook_not_held, không thấy / mơ hồ ⇒ hỏi sổ). Không nêu sổ ⇒ như cũ: hỏi hạng mục, rồi sổ mặc định.
    v_cashbook:=NULL; v_cashbook_name:=NULL;
    IF NULLIF(btrim(v_item->>'cashbook'),'') IS NOT NULL THEN
      v_wanted:=public.hermes_name_fold_v1(v_item->>'cashbook');
      SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'exact',public.hermes_name_fold_v1(a.name)=v_wanted,'held',c.id IS NOT NULL) ORDER BY a.name) INTO v_hits
        FROM public.accounts a LEFT JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id
        WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false)
          AND (public.hermes_name_fold_v1(a.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(a.name),v_wanted)>0));
      IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
        v_hits:=(SELECT jsonb_agg(h) FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean);
      END IF;
      IF jsonb_array_length(COALESCE(v_hits,'[]'))=1 THEN
        IF NOT (v_hits#>>'{0,held}')::boolean THEN RETURN jsonb_strip_nulls(jsonb_build_object('status','rejected','reason','cashbook_not_held','item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN v_i END)); END IF;
        v_cashbook:=(v_hits#>>'{0,id}')::uuid; v_cashbook_name:=v_hits#>>'{0,name}';
      ELSE
        RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(v_item->>'cashbook'),200),
          'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h
            WHERE (h->>'held')::boolean LIMIT 8) x))||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END;
      END IF;
    END IF;
    IF v_cat->>'status'<>'resolved' THEN RETURN v_cat||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END; END IF;
    v_type:=(v_cat->>'typeId')::uuid; v_type_name:=v_cat->>'typeName'; v_auto:=(v_cat->>'auto')::boolean;
    IF NULLIF(btrim(v_item->>'cashbook'),'') IS NULL THEN
      v_cashbook:=public.ie_default_cashbook_v1(p_organization_id,v_building,v_last);
      IF v_cashbook IS NULL THEN RETURN jsonb_strip_nulls(jsonb_build_object('status','rejected','reason','cashbook_not_held','item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN v_i END)); END IF;
      SELECT a.name INTO v_cashbook_name FROM public.accounts a WHERE a.id=v_cashbook;
    END IF;
    -- Ngày và kỳ (giờ Việt Nam).
    v_date:=COALESCE((v_item->>'voucherDate')::date,v_today);
    IF NULLIF(v_item->>'period','') IS NOT NULL THEN
      v_period_start:=((v_item->>'period')||'-01')::date; v_period_end:=(v_period_start+interval '1 month'-interval '1 day')::date;
    ELSE v_period_start:=v_date; v_period_end:=v_date; END IF;
    v_out:=v_out||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_name#>>'{building,name}',
      'roomId',v_name#>>'{room,id}','roomName',v_name#>>'{room,name}','typeId',v_type,'typeName',v_type_name,'typeAuto',v_auto,
      'cashbookId',v_cashbook,'cashbookName',v_cashbook_name,'voucherDate',v_date,'periodStart',v_period_start,'periodEnd',v_period_end)));
  END LOOP;
  RETURN jsonb_build_object('status','resolved','resolved',jsonb_build_object('items',v_out));
END $fn$;

DO $assert$
DECLARE p pg_catalog.pg_proc;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid='app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)'::regprocedure;
  IF md5(replace(p.prosrc,chr(13),''))<>'9636ab61d457dd7a4b3d54194a9d6f63' OR p.prosecdef OR p.provolatile<>'s'
    OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path='
    OR position('IF v_cat->>''status''=''rejected'' THEN' IN p.prosrc)=0 OR position('v_bfilter' IN p.prosrc)=0 THEN
    RAISE EXCEPTION 'hermes_expense_cashbook_first_contract_violated'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
