-- Hermes Thu chi — lượt 11 (24/10/2026; nghiệm thu bot thật trên TEST; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 23). Áp SAU
-- 20261023210633_ie_quick_entry_shared_rules_v2 (gợi ý hạng mục có lớp từ vựng). Sửa phía máy chủ:
--  (1) public.hermes_expense_category_pick_v1 MỚI (INVOKER, search_path rỗng): chọn hạng mục cho expense.create / expense.edit. Lỗi nghiệm thu:
--      không nêu hạng mục mà gợi ý không khoá cứng ⇒ hỏi lại với 8 hạng mục ĐẦU BẢNG (tiền nhà, điện, nước, internet…); nêu "Sửa chữa/bảo trì"
--      ⇒ "không thấy … trong phạm vi quyền". Nay: nêu tên ⇒ trùng hẳn / chứa chuỗi / đủ từ trong tên + nhóm; nhiều mà gợi ý theo nội dung rơi
--      vào một ⇒ nhận; không nêu ⇒ nhận gợi ý khoá cứng (không dòng tiền), còn lại hỏi lại why=unspecified với ≤ 5 ứng viên trùng từ, gợi ý đứng
--      đầu; không trùng gì ⇒ không nêu ứng viên.
--  (2) app_private.hermes_expense_resolve_core_v1 (thay thân 20261023013109): mã phiếu khớp ĐÚNG mã đầy đủ trước — mã bị dùng lại giữa các toà
--      (đo production 24/10: 1 788 phiếu chi, 1 059 mã) ⇒ phần còn lại của chuỗi là gợi ý ngày dd/mm[/yyyy] và tên toà (chép lại nhãn ứng viên
--      là đủ); mã ngắn / thiếu ⇒ phiếu có mã kết thúc bằng dãy số đó chỉ là ứng viên, không tự chọn. Hạng mục qua (1). Lô nhiều khoản: kết quả
--      hỏi lại mang số khoản (item).
--  (3) app_private.hermes_expense_write_step_v1 (thay thân 20261023031258): needs_input mang item; khoản cam kết (Q12) có câu cam kết NGAY trong
--      khoản và trong tóm tắt (cam kết kỳ, đã chi/giữ, còn, trong / vượt, phiếu cùng kỳ); sửa phiếu đã huỷ ⇒ web_only, sửa phiếu hết chờ duyệt /
--      huỷ phiếu đã huỷ ⇒ not_pending — kèm link trang phiếu ("mở lại phiếu" không phải thao tác của bot).
-- Toà ngoài phạm vi (nghiệm thu mục 4) giữ nguyên thiết kế: thấy dưới RLS mà ngoài phạm vi khoá ⇒ outside_scope (câu từ chối tĩnh); RLS không
-- cho thấy ⇒ not_visible (hàm INVOKER không phân biệt "không có" với "không có quyền").
-- Ghim md5 thân đang chạy (production 24/10) hoặc thân của chính file ⇒ áp lại được; hermes_expense_create_run_v1 (dữ kiện cam kết) ghim đúng
-- thân 20261022075102. Không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE pin record;
BEGIN
  IF to_regprocedure('public.ie_category_suggest_v1(uuid,jsonb,text,boolean)') IS NULL OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)') IS NULL OR to_regprocedure('public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regclass('public.income_expense_types') IS NULL OR to_regclass('public.income_expenses') IS NULL OR to_regclass('public.buildings') IS NULL
    -- Lớp từ vựng của gợi ý (20261023210633) đã áp: nhận "mua vòi nước" ⇒ không thì hỏi lại với ứng viên rỗng như cũ ⇒ dừng.
    OR position('c_lex CONSTANT' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid='public.ie_category_suggest_v1(uuid,jsonb,text,boolean)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'hermes_expense_acceptance_dependency_invalid'; END IF;
  FOR pin IN SELECT * FROM (VALUES
      ('app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)','9aaa6cfceb6f30f204feb3da256c0eef','dcadc17bcecce3876eb75cbaec235763'),
      ('app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','ea3cd4ac95f6f2271111f45c696dbd02','15183dce50beb631bfb240564c7cd226'),
      ('app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)','b09458a449e47e8cd810341babcdc783','b09458a449e47e8cd810341babcdc783')) v(fn,running,own) LOOP
    IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure(pin.fn)),'') NOT IN (pin.running,pin.own) THEN
      RAISE EXCEPTION 'hermes_expense_acceptance_body_drift: %',pin.fn; END IF;
  END LOOP;
END $requires$;

-- 1. Chọn hạng mục (MỚI).
CREATE OR REPLACE FUNCTION public.hermes_expense_category_pick_v1(p_organization_id uuid,p_category text,p_content text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  -- Hạng mục dòng tiền (= c_money_flow của public.ie_category_suggest_v1; test khoá ba danh sách bằng nhau): gợi ý khoá cứng vào đây không tự nhận.
  c_money_flow CONSTANT text[]:=ARRAY['noi_bo','bo_sung_hoan_coc','tra_tien_thua_khach','chia_loi_nhuan'];
  -- Từ không phân biệt hạng mục (đã bỏ dấu): c_stop của public.ie_category_suggest_v1 + chi / phi / khoan.
  c_stop CONSTANT text[]:=ARRAY['tien','mua','cho','phong','toa','nha','va','cai','cua','o','bi','lai','moi','cac','nhung','the','nay','do','kia',
    'hom','qua','ngay','thang','nam','k','tr','trieu','nghin','ngan','dong','chi','phi','khoan'];
  v_rows jsonb; v_wanted text; v_words text[]; v_hits jsonb; v_suggest jsonb; v_sid text; v_total int;
BEGIN
  IF p_organization_id IS NULL OR (NULLIF(btrim(p_category),'') IS NULL AND NULLIF(btrim(p_content),'') IS NULL)
    OR char_length(COALESCE(p_category,''))>200 OR char_length(COALESCE(p_content,''))>1000 THEN
    RAISE EXCEPTION 'hermes_expense_category_pick_invalid' USING ERRCODE='22023'; END IF;
  -- Tập dùng được của Hermes (như app_private.hermes_expense_category_ok_v1: CHI, đúng công ty, không lưu trữ / system_only / ẩn / hạn chế /
  -- cọc / chuyển nội bộ) dưới RLS người hỏi, lọc công ty tường minh. nt = từ của tên + nhóm; ft = nt + từ của cụm "hay nói" (bỏ dấu, bỏ từ dừng).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',y.id,'name',y.name,'fold',public.hermes_name_fold_v1(y.name),'ord',y.ord,
      'nt',(SELECT COALESCE(jsonb_agg(DISTINCT w),'[]'::jsonb) FROM regexp_split_to_table(public.hermes_name_fold_v1(y.name||' '||COALESCE(y.category,'')),'[^a-z0-9]+') w
        WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^[0-9]+$'),
      'ft',(SELECT COALESCE(jsonb_agg(DISTINCT w),'[]'::jsonb) FROM regexp_split_to_table(public.hermes_name_fold_v1(y.name||' '||COALESCE(y.category,'')||' '
          ||array_to_string(COALESCE(y.keywords,'{}'::text[]),' ')),'[^a-z0-9]+') w WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^[0-9]+$'))
      ORDER BY y.ord),'[]'::jsonb) INTO v_rows
    FROM (SELECT t.id,t.name,t.category,t.keywords,row_number() OVER (ORDER BY t.sort_order NULLS LAST,t.name,t.id) ord FROM public.income_expense_types t
      WHERE t.organization_id=p_organization_id AND t.type='expense' AND t.archived_at IS NULL
        AND NOT COALESCE(t.system_only,false) AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
        AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false)) y;
  -- Gợi ý theo nội dung: hàm dùng chung với web Báo chi nhanh; chỉ tính khi trúng tập dùng được.
  IF NULLIF(btrim(p_content),'') IS NOT NULL THEN
    v_suggest:=public.ie_category_suggest_v1(p_organization_id,jsonb_build_array(jsonb_build_object('text',p_content)),'expense',false)->0;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'id'=v_suggest->>'typeId') THEN v_sid:=v_suggest->>'typeId'; END IF;
  END IF;

  IF NULLIF(btrim(p_category),'') IS NOT NULL THEN
    -- Người dùng nêu hạng mục: (a) trùng hẳn tên; (b) tên chứa chuỗi đã nêu; (c) mọi từ đã nêu có trong tên + nhóm (vd "sửa chữa/bảo trì" ⇒
    -- cả nhóm "Sửa chữa – bảo trì"). Đúng một ⇒ nhận; nhiều mà gợi ý theo nội dung rơi vào một trong số đó ⇒ nhận gợi ý; còn lại hỏi lại.
    v_wanted:=public.hermes_name_fold_v1(p_category);
    SELECT jsonb_agg(r ORDER BY (r->>'ord')::int) INTO v_hits FROM jsonb_array_elements(v_rows) r WHERE r->>'fold'=v_wanted;
    IF jsonb_array_length(COALESCE(v_hits,'[]'))<>1 THEN
      SELECT jsonb_agg(r ORDER BY (r->>'ord')::int) INTO v_hits FROM jsonb_array_elements(v_rows) r
        WHERE char_length(v_wanted)>=2 AND strpos(r->>'fold',v_wanted)>0;
    END IF;
    SELECT array_agg(DISTINCT w) INTO v_words FROM regexp_split_to_table(v_wanted,'[^a-z0-9]+') w
      WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^[0-9]+$';
    IF jsonb_array_length(COALESCE(v_hits,'[]'))=0 AND cardinality(v_words)>0 THEN
      SELECT jsonb_agg(r ORDER BY (r->>'ord')::int) INTO v_hits FROM jsonb_array_elements(v_rows) r
        WHERE NOT EXISTS(SELECT 1 FROM unnest(v_words) w WHERE NOT (r->'nt') ? w);
    END IF;
    IF jsonb_array_length(COALESCE(v_hits,'[]'))=1 THEN
      RETURN jsonb_build_object('status','resolved','typeId',v_hits#>>'{0,id}','typeName',v_hits#>>'{0,name}','auto',false); END IF;
    IF v_sid IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE h->>'id'=v_sid) THEN
      RETURN jsonb_build_object('status','resolved','typeId',v_sid,'typeName',(SELECT r->>'name' FROM jsonb_array_elements(v_rows) r WHERE r->>'id'=v_sid),'auto',true); END IF;
    -- Không khớp trọn: hạng mục trùng ít nhất nửa số từ đã nêu (tên + nhóm + cụm "hay nói"), nhiều từ trùng trước — chỉ để hỏi lại, không tự
    -- chọn. Ngưỡng nửa số từ để một chữ chung ("bảo" của "bảo hiểm" / "bảo trì") không kéo cả nhóm vào.
    IF jsonb_array_length(COALESCE(v_hits,'[]'))=0 AND cardinality(v_words)>0 THEN
      SELECT jsonb_agg(x.r ORDER BY x.score DESC,(x.r->>'ord')::int) INTO v_hits FROM (
        SELECT r,(SELECT count(*) FROM unnest(v_words) w WHERE (r->'ft') ? w) score FROM jsonb_array_elements(v_rows) r) x
        WHERE x.score>0 AND x.score*2>=cardinality(v_words);
    END IF;
    RETURN jsonb_build_object('status','unresolved','field','category','wanted',left(btrim(p_category),200),
      'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>0 THEN 'ambiguous' ELSE 'not_visible' END,
      'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h LIMIT 8) x),
      'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8);
  END IF;

  -- Không nêu hạng mục: nhận gợi ý khi KHOÁ CỨNG (rule / fee_phrase / provider_code), trong tập dùng được, không phải hạng mục dòng tiền.
  IF v_sid IS NOT NULL AND v_suggest->>'reason' IN ('rule','fee_phrase','provider_code') AND NOT (COALESCE(v_suggest->>'ruleKey','')=ANY(c_money_flow)) THEN
    RETURN jsonb_build_object('status','resolved','typeId',v_sid,'typeName',(SELECT r->>'name' FROM jsonb_array_elements(v_rows) r WHERE r->>'id'=v_sid),'auto',true); END IF;
  -- Hỏi lại (why unspecified: người dùng chưa nêu hạng mục): gợi ý đứng đầu, rồi các hạng mục trùng ít nhất nửa số từ của nội dung, nhiều từ
  -- trùng trước, tối đa 5. Không trùng gì ⇒ không nêu ứng viên — không bao giờ đưa danh sách đầu bảng (lỗi nghiệm thu 24/10).
  SELECT array_agg(DISTINCT w) INTO v_words FROM regexp_split_to_table(public.hermes_name_fold_v1(p_content),'[^a-z0-9]+') w
    WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^[0-9]+$';
  SELECT count(*)::int,COALESCE(jsonb_agg(jsonb_build_object('name',x.name) ORDER BY x.first DESC,x.score DESC,x.ord) FILTER (WHERE x.rn<=5),'[]'::jsonb)
    INTO v_total,v_hits FROM (
    SELECT s.*,row_number() OVER (ORDER BY s.first DESC,s.score DESC,s.ord) rn FROM (
      SELECT r->>'name' name,COALESCE(r->>'id'=v_sid,false) first,(r->>'ord')::int ord,
        (SELECT count(*) FROM unnest(COALESCE(v_words,'{}'::text[])) w WHERE (r->'ft') ? w) score FROM jsonb_array_elements(v_rows) r) s
    WHERE s.first OR (s.score>0 AND s.score*2>=cardinality(v_words))) x;
  RETURN jsonb_build_object('status','unresolved','field','category','wanted','','why','unspecified','candidates',v_hits,'more',v_total>5);
END $fn$;

-- 2. Giải tên (thay thân).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_item jsonb; v_out jsonb:='[]'::jsonb; v_name jsonb; v_building uuid; v_type uuid; v_type_name text; v_auto boolean; v_cashbook uuid;
  v_cashbook_name text; v_last uuid; v_date date; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date; v_period_start date; v_period_end date;
  v_wanted text; v_hits jsonb; v_code text; v_voucher record; v_visible int; v_i int:=0; v_extra jsonb; v_cat jsonb; v_list jsonb;
  v_m text[]; v_day int; v_month int; v_year int; v_hint text; v_ids uuid[]; v_narrow uuid[]; v_digits text; v_rest text;
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
    FOR v_wanted IN SELECT value FROM jsonb_array_elements_text(v_list) LOOP
      v_wanted:=btrim(v_wanted);
      IF v_wanted IS NULL OR v_wanted='' THEN RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
      -- Lượt 11 (nghiệm thu): mã phiếu bị dùng lại giữa các toà (dãy theo toà) ⇒ khớp ĐÚNG mã đầy đủ trước (chữ + ≥ 3 số; không có thì chữ +
      -- số; không có nữa thì cả chuỗi như cũ), rồi dùng phần còn lại của chuỗi làm gợi ý: ngày dd/mm[/yyyy] và tên toà (vd chép lại nhãn ứng
      -- viên "PC2609034 · 01/09/2026 · 44TL · 500.000đ"). Gợi ý không khớp phiếu nào thì bỏ qua (vẫn hỏi lại đủ ứng viên).
      v_code:=upper(COALESCE(substring(v_wanted FROM '[A-Za-z]{1,6}[0-9]{3,12}'),substring(v_wanted FROM '[A-Za-z]{1,6}[0-9]{1,12}'),v_wanted));
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
        WHERE ie.organization_id=p_organization_id AND upper(ie.code)=v_code AND ie.deleted_at IS NULL;
      v_narrow:=v_ids;
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
    IF v_cat->>'status'<>'resolved' THEN RETURN v_cat||CASE WHEN jsonb_array_length(p_params->'items')>1 THEN jsonb_build_object('item',v_i) ELSE '{}'::jsonb END; END IF;
    v_type:=(v_cat->>'typeId')::uuid; v_type_name:=v_cat->>'typeName'; v_auto:=(v_cat->>'auto')::boolean;
    -- Sổ quỹ: chỉ sổ đang giữ của công ty (như expenseCashbooksForOrg); sổ thấy mà không giữ ⇒ cashbook_not_held ngay lượt 1.
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
    ELSE
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

-- 3. Bước ghi (thay thân).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_write_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_res jsonb; v_run jsonb; v_basis text; v_begin jsonb; v_outcome jsonb; v_constraint text;
  v_items jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; f jsonb; v_item jsonb; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_total numeric:=0; v_will text; v_why text; v_voucher public.income_expenses; d jsonb; i int;
  v_hint text; v_patch jsonb; v_new_items jsonb; v_changes jsonb; v_out jsonb; v_count int; v_line record; v_shift boolean; v_posted boolean;
  v_cashbook_name text; v_summary text; v_moved boolean; v_err_state text; v_err_msg text;
  v_post boolean; v_plan text; v_note text; v_ev jsonb; v_plans jsonb; v_results jsonb; v_n_post int; v_n_only int; v_n_skip int; v_sum_post numeric;
  v_first_skip text; v_first_item int; v_final text; v_final_item int; v_final_state text; v_final_msg text; v_done int; v_commit text; v_commits text[]:='{}';
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('expense.create','expense.note','expense.edit','expense.cancel','expense.approve') OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  -- Phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web (hermes_expense_scope_v1): lượt 1 và lượt 2 cùng một tập toà.
  ctx:=app_private.hermes_expense_scope_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  IF p_phase='apply' THEN v_resolved:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    -- Lượt 11: lô nhiều khoản ⇒ số khoản (item) của khoản cần hỏi lại (connector nói "Mục #n: …").
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb),
      'item',p_resolution->'item'));
  ELSIF p_resolution->>'status'='rejected' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',p_resolution->>'reason','item',p_resolution->'item'));
  ELSIF p_resolution->>'status'='resolved' THEN v_resolved:=p_resolution->'resolved';
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Phát lại TRƯỚC mọi kiểm phạm vi/hạng mục/sổ (review Mốc 2+3): requestId đã có biên nhận ⇒ trả đúng kết quả đã chốt (hoặc
  -- request_conflict / outcome_unknown), kể cả khi quyền sổ hay phạm vi đổi sau lần ghi. requestId mới vẫn qua đủ kiểm rồi mới mở biên nhận.
  IF p_phase='apply' AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid()
      AND r.request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;

  IF p_action='expense.approve' THEN
    -- Mốc 5: duyệt / duyệt + chi ≤ 10 phiếu CHI lập tay (Q8). Mỗi phiếu một kế hoạch: duyệt + chi (adopt_voucher_attachments_as_evidence_v2
    -- rồi approve_and_post_income_expense_v2), chỉ duyệt (approve_income_expense_v2; chưa có ảnh / không giữ sổ ⇒ hạ xuống, TC4), hoặc không làm
    -- (phiếu hệ thống / phiếu con định kỳ khi cờ TC5 tắt — hermes_expense_manual_v1; hết chờ duyệt; Q25 #263). Bản đã giải từ connector được
    -- kiểm lại: đúng số mã, không trùng, phiếu của công ty, toà trong phạm vi khoá duyệt.
    IF jsonb_typeof(v_resolved->'vouchers') IS DISTINCT FROM 'array' OR jsonb_array_length(v_resolved->'vouchers') NOT BETWEEN 1 AND 10
      OR jsonb_typeof(p_params->'voucherCodes') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_resolved->'vouchers')<>jsonb_array_length(p_params->'voucherCodes')
      OR (SELECT count(DISTINCT x->>'voucherId') FROM jsonb_array_elements(v_resolved->'vouchers') x)<>jsonb_array_length(v_resolved->'vouchers')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved->'vouchers') x LEFT JOIN public.income_expenses ie ON ie.id=(x->>'voucherId')::uuid
        AND ie.organization_id=v_org AND ie.deleted_at IS NULL
        WHERE ie.id IS NULL OR NOT (ie.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    -- Khoá các dòng phiếu NOWAIT trước khi gọi hàm web (như Mốc 4b): guard giữ dòng công ty, còn hàm duyệt web khoá phiếu rồi mới khoá công ty
    -- (authorize_tenant_action_v3) ⇒ chờ phiếu ở đây là vòng 40P01; NOWAIT ⇒ 55P03 ngay (connector: state_changed).
    PERFORM 1 FROM public.income_expenses ie WHERE ie.id IN (SELECT (x->>'voucherId')::uuid FROM jsonb_array_elements(v_resolved->'vouchers') x)
      ORDER BY ie.id FOR UPDATE NOWAIT;
    -- Lượt 8: cùng luật cho các dòng khác mà hàm web sẽ ghi/khoá sau khi guard đã giữ công ty — yêu cầu duyệt của phiếu (hàm duyệt web và
    -- trigger đồng bộ ghi chúng; emergency_approve_financial_v1 / self_approve_within_limit_v1 khoá chúng rồi mới khoá công ty) và sổ của
    -- phiếu sẽ chi (approve_and_post_income_expense_v2 khoá sổ FOR UPDATE; confirm_cashbook_closing_v1, set_cashbook_access_v2,
    -- lock_cashbook_period_v1 … khoá sổ rồi mới khoá công ty). NOWAIT ⇒ 55P03 ⇒ state_changed.
    PERFORM 1 FROM public.approval_requests ar WHERE ar.organization_id=v_org AND ar.subject_type='INCOME_EXPENSE'
      AND ar.subject_id IN (SELECT (x->>'voucherId')::uuid FROM jsonb_array_elements(v_resolved->'vouchers') x) ORDER BY ar.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.accounts a WHERE a.id IN (SELECT ie.account_id FROM public.income_expenses ie
        JOIN jsonb_array_elements(v_resolved->'vouchers') x ON ie.id=(x->>'voucherId')::uuid
        WHERE CASE WHEN p_phase='apply' THEN x->>'plan'='approve_post' ELSE COALESCE((p_params->>'post')::boolean,true) END)
      ORDER BY a.id FOR UPDATE NOWAIT;
    IF p_phase<>'apply' THEN
      v_post:=COALESCE((p_params->>'post')::boolean,true);
      v_plans:='[]'::jsonb; v_n_post:=0; v_n_only:=0; v_n_skip:=0; v_sum_post:=0; i:=0;
      FOR v_res IN SELECT value FROM jsonb_array_elements(v_resolved->'vouchers') LOOP
        i:=i+1;
        SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_res->>'voucherId')::uuid;
        v_cashbook_name:=(SELECT a.name FROM public.accounts a WHERE a.id=v_voucher.account_id);
        v_plan:=NULL; v_note:=NULL;
        v_why:=app_private.hermes_expense_manual_v1(v_voucher.id);
        IF v_why IS NULL AND v_voucher.approval_status IS DISTINCT FROM 'UNAPPROVED' THEN v_why:='not_pending'; END IF;
        -- Q25 (#263, đã lên production): người lập không có quyền duyệt không tự duyệt phiếu chi từ ngưỡng — rào thứ hai, đúng hàm của web.
        IF v_why IS NULL AND app_private.ie_self_approve_over_threshold_blocked_v1(v_voucher.id) THEN v_why:='not_allowed'; END IF;
        IF v_why IS NULL THEN
          v_note:=CASE WHEN NOT v_post THEN 'requested' WHEN v_voucher.posting_mode IS DISTINCT FROM 'CASHBOOK' THEN 'non_cash'
            WHEN v_voucher.account_id IS NULL THEN 'no_cashbook'
            WHEN jsonb_array_length(CASE WHEN jsonb_typeof(v_voucher.attachments)='array' THEN v_voucher.attachments ELSE '[]'::jsonb END)=0 THEN 'no_attachment' END;
          v_plan:=CASE WHEN v_note IS NULL THEN 'approve_post' ELSE 'approve' END;
          IF v_plan='approve_post' THEN
            -- Chạy thử đúng hàm web trong khối con rồi lùi. Không có chứng từ dùng được / không giữ sổ ⇒ hạ "chỉ duyệt" (Q8, TC4).
            BEGIN
              v_ev:=public.adopt_voucher_attachments_as_evidence_v2(v_voucher.id)->'evidence_ids';
              IF jsonb_array_length(COALESCE(v_ev,'[]'::jsonb))=0 THEN v_note:='evidence_unusable';
              ELSE
                PERFORM public.approve_and_post_income_expense_v2(jsonb_build_object('subjectKind','VOUCHER','subjectId',v_voucher.id,
                  'cashbookId',v_voucher.account_id,'postedOn',v_today,'evidenceIds',v_ev,'expectedExecutionRevision',0,
                  'expectedApprovalVersion',v_voucher.approval_version,'expectedPostingVersion',v_voucher.posting_version,
                  'idempotencyKey','hermes-approve-dry:'||p_request_id::text||':'||i));
              END IF;
              RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
            EXCEPTION
              WHEN SQLSTATE 'HD001' THEN NULL;
              WHEN OTHERS THEN
                IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
                GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
                v_why:=app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,''));
                IF v_why IN ('evidence_required','cashbook_not_held') THEN
                  v_note:=CASE WHEN v_why='cashbook_not_held' THEN 'not_custodian' ELSE 'evidence_unusable' END; v_why:=NULL;
                ELSE v_plan:=NULL; END IF;
            END;
            IF v_note IS NOT NULL THEN v_plan:='approve'; END IF;
          END IF;
          IF v_plan='approve' THEN
            BEGIN
              PERFORM public.approve_income_expense_v2(v_voucher.id,v_voucher.approval_version,'hermes-approve-dry:'||p_request_id::text||':'||i);
              RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
            EXCEPTION
              WHEN SQLSTATE 'HD001' THEN NULL;
              WHEN OTHERS THEN
                IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
                GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
                v_why:=app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')); v_plan:=NULL;
            END;
          END IF;
        END IF;
        IF v_plan IS NULL THEN v_n_skip:=v_n_skip+1; v_first_skip:=COALESCE(v_first_skip,v_why); v_first_item:=COALESCE(v_first_item,i);
        ELSIF v_plan='approve_post' THEN v_n_post:=v_n_post+1; v_sum_post:=v_sum_post+v_voucher.total_amount;
        ELSE v_n_only:=v_n_only+1; END IF;
        v_plans:=v_plans||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('voucherId',v_voucher.id,'voucherCode',v_voucher.code,
          'buildingId',v_voucher.building_id,'approvalVersion',v_voucher.approval_version,'postingVersion',v_voucher.posting_version,
          'plan',COALESCE(v_plan,'skip'),'note',v_note,'skip',v_why)));
        v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('stt',i,'code',v_voucher.code,'content',v_voucher.name,
          'building',(SELECT b.name FROM public.buildings b WHERE b.id=v_voucher.building_id),
          'category',(SELECT t.name FROM public.income_expense_items it JOIN public.income_expense_types t ON t.id=it.income_expense_type_id
            WHERE it.income_expense_id=v_voucher.id ORDER BY it.created_at,it.id LIMIT 1),
          'amount',app_private.hermes_vnd_text_v1(v_voucher.total_amount),'maker',v_voucher.creator_name,
          'ageDays',v_today-(v_voucher.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
          'attachments',jsonb_array_length(CASE WHEN jsonb_typeof(v_voucher.attachments)='array' THEN v_voucher.attachments ELSE '[]'::jsonb END),
          'cashbook',v_cashbook_name,
          'plan',CASE v_plan WHEN 'approve_post' THEN format('duyệt + CHI %s khỏi sổ %s',app_private.hermes_vnd_text_v1(v_voucher.total_amount),v_cashbook_name)
            WHEN 'approve' THEN 'chỉ duyệt ('||CASE v_note WHEN 'requested' THEN 'theo yêu cầu, chưa chi' WHEN 'non_cash' THEN 'phiếu không chi qua sổ quỹ'
              WHEN 'no_cashbook' THEN 'phiếu chưa chọn sổ quỹ' WHEN 'no_attachment' THEN 'chưa có ảnh — thêm ảnh ở trang phiếu rồi chi'
              WHEN 'evidence_unusable' THEN 'ảnh trên phiếu chưa dùng làm chứng từ được'
              WHEN 'not_custodian' THEN 'anh/chị không giữ sổ '||COALESCE(v_cashbook_name,'của phiếu') ELSE 'chưa chi' END||')'
            ELSE 'không làm: '||CASE v_why WHEN 'not_pending' THEN 'phiếu không còn chờ duyệt' WHEN 'system_voucher' THEN 'phiếu hệ thống / phiếu tự lập định kỳ — duyệt trên web'
            WHEN 'web_only' THEN 'phiếu THU — duyệt trên web' WHEN 'not_allowed' THEN 'anh/chị không có quyền duyệt phiếu này'
            WHEN 'period_locked' THEN 'kỳ đã chốt' WHEN 'cashbook_not_held' THEN 'anh/chị không giữ sổ của phiếu' WHEN 'not_found' THEN 'không thấy phiếu'
            ELSE 'CRM từ chối — kiểm trên web' END END)));
      END LOOP;
      -- Không còn phiếu nào làm được ⇒ từ chối với lý do của phiếu đầu tiên (lô ≥ 2 nói phiếu số mấy).
      IF v_n_post+v_n_only=0 THEN
        RETURN jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',v_first_skip,'item',CASE WHEN i>1 THEN v_first_item END)); END IF;
      IF v_n_skip>0 THEN v_warnings:=v_warnings||to_jsonb(format('%s phiếu không làm được — xem cột plan của từng phiếu',v_n_skip)); END IF;
      v_resolved:=jsonb_build_object('vouchers',v_plans);
      RETURN jsonb_build_object('kind','preview','basis',md5(v_resolved::text),'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_build_object('summary',format('Duyệt %s phiếu: %s.',v_n_post+v_n_only,concat_ws('; ',
            CASE WHEN v_n_post>0 THEN format('duyệt + CHI %s phiếu, tổng %s',v_n_post,app_private.hermes_vnd_text_v1(v_sum_post)) END,
            CASE WHEN v_n_only>0 THEN format('chỉ duyệt %s phiếu (chưa chi)',v_n_only) END,
            CASE WHEN v_n_skip>0 THEN format('không làm %s phiếu',v_n_skip) END)),'items',v_items));
    END IF;
    -- Lượt 2: từng phiếu một, mỗi phiếu một khối con (plan G4). Phiên bản lệch / phiếu vừa đổi ⇒ phiếu đó state_changed, phiếu khác vẫn chạy.
    -- ≥ 1 phiếu xong ⇒ chốt applied kèm kết quả từng mã; 0 phiếu xong mà có lý do cuối ⇒ chốt rejected (SQLSTATE trong biên nhận); tất cả
    -- state_changed ⇒ không chốt (lùi cả biên nhận), xem trước lại. Bản đã giải là kế hoạch của bản xem trước, gắn bằng basis = md5 của nó.
    IF p_expected_basis IS DISTINCT FROM md5(v_resolved::text)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved->'vouchers') x WHERE x->>'plan' IS NULL OR x->>'plan' NOT IN ('approve_post','approve','skip')) THEN
      RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    BEGIN
      v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
      IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
      IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      v_results:='[]'::jsonb; v_done:=0; v_sum_post:=0; i:=0;
      FOR v_res IN SELECT value FROM jsonb_array_elements(v_resolved->'vouchers') LOOP
        i:=i+1;
        SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_res->>'voucherId')::uuid;
        v_cashbook_name:=(SELECT a.name FROM public.accounts a WHERE a.id=v_voucher.account_id);
        v_why:=NULL;
        IF v_res->>'plan'='skip' THEN v_why:=v_res->>'skip';
        ELSE
          -- Kiểm lại "lập tay" (cờ TC5 có thể vừa đổi) và Q25: lý do cuối của phiếu này.
          v_why:=app_private.hermes_expense_manual_v1(v_voucher.id);
          IF v_why IS NULL AND app_private.ie_self_approve_over_threshold_blocked_v1(v_voucher.id) THEN v_why:='not_allowed'; END IF;
          IF v_why IS NOT NULL AND v_final IS NULL THEN v_final:=v_why; v_final_item:=i; END IF;
          IF v_why IS NULL AND (v_voucher.approval_version IS DISTINCT FROM (v_res->>'approvalVersion')::bigint
              OR v_voucher.posting_version IS DISTINCT FROM (v_res->>'postingVersion')::bigint) THEN v_why:='state_changed'; END IF;
          IF v_why IS NULL THEN
            BEGIN
              IF v_res->>'plan'='approve_post' THEN
                v_ev:=public.adopt_voucher_attachments_as_evidence_v2(v_voucher.id)->'evidence_ids';
                IF jsonb_array_length(COALESCE(v_ev,'[]'::jsonb))=0 THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
                PERFORM public.approve_and_post_income_expense_v2(jsonb_build_object('subjectKind','VOUCHER','subjectId',v_voucher.id,
                  'cashbookId',v_voucher.account_id,'postedOn',v_today,'evidenceIds',v_ev,'expectedExecutionRevision',0,
                  'expectedApprovalVersion',v_voucher.approval_version,'expectedPostingVersion',v_voucher.posting_version,
                  'idempotencyKey','hermes-approve:'||p_request_id::text||':'||i));
              ELSE
                PERFORM public.approve_income_expense_v2(v_voucher.id,v_voucher.approval_version,'hermes-approve:'||p_request_id::text||':'||i);
              END IF;
            EXCEPTION
              WHEN SQLSTATE 'HS001' THEN v_why:='state_changed';
              WHEN OTHERS THEN
                IF SQLSTATE IN ('40P01','55P03') THEN RAISE; END IF;
                GET STACKED DIAGNOSTICS v_err_state=RETURNED_SQLSTATE,v_err_msg=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
                -- Phiên bản đã so ở trên khi đang giữ dòng phiếu ⇒ hàm web không thể thấy lệch phiên bản; lỗi ở đây là lý do thật.
                v_why:=app_private.hermes_expense_reason_v1(v_err_state,v_err_msg,NULLIF(v_constraint,''));
                IF v_why<>'state_changed' AND v_final IS NULL THEN
                  v_final:=v_why; v_final_item:=i; v_final_state:=v_err_state; v_final_msg:=v_err_msg; END IF;
            END;
          END IF;
        END IF;
        IF v_why IS NULL THEN
          v_done:=v_done+1;
          IF v_res->>'plan'='approve_post' THEN v_sum_post:=v_sum_post+v_voucher.total_amount; END IF;
        END IF;
        v_results:=v_results||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('code',v_voucher.code,
          'outcome',CASE WHEN v_why IS NULL THEN CASE WHEN v_res->>'plan'='approve_post' THEN 'approved_posted' ELSE 'approved' END
            WHEN v_why='state_changed' THEN 'state_changed' ELSE 'rejected' END,
          'reason',CASE WHEN v_why<>'state_changed' THEN v_why END,
          'statusText',CASE WHEN v_why IS NULL AND v_res->>'plan'='approve_post' THEN 'Đã duyệt và CHI khỏi sổ '||COALESCE(v_cashbook_name,'quỹ')
            WHEN v_why IS NULL THEN 'Đã duyệt (chưa chi)' WHEN v_why='state_changed' THEN 'Phiếu vừa đổi sau bản xem trước — xem trước lại'
            ELSE 'Không làm: '||CASE v_why WHEN 'not_pending' THEN 'phiếu không còn chờ duyệt' WHEN 'system_voucher' THEN 'phiếu hệ thống / phiếu tự lập định kỳ — duyệt trên web'
            WHEN 'web_only' THEN 'phiếu THU — duyệt trên web' WHEN 'not_allowed' THEN 'anh/chị không có quyền duyệt phiếu này'
            WHEN 'period_locked' THEN 'kỳ đã chốt' WHEN 'cashbook_not_held' THEN 'anh/chị không giữ sổ của phiếu' WHEN 'not_found' THEN 'không thấy phiếu'
            ELSE 'CRM từ chối — kiểm trên web' END END)));
      END LOOP;
      IF v_done=0 AND v_final IS NULL THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
      IF v_done=0 THEN
        RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,
          jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',v_final,'item',CASE WHEN i>1 THEN v_final_item END)),v_final_state,v_final_msg);
      END IF;
      v_outcome:=jsonb_build_object('kind','applied',
        'link',CASE WHEN i=1 THEN '/income-expense/voucher/'||(v_resolved#>>'{vouchers,0,voucherId}') ELSE '/income-expense' END,
        'result',jsonb_build_object('items',v_results,'totalPosted',v_sum_post,'totalPostedText',app_private.hermes_vnd_text_v1(v_sum_post)));
      RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
    EXCEPTION
      WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    END;
  END IF;

  IF p_action IN ('expense.edit','expense.cancel') THEN
    -- Mốc 4: phiếu đã giải phải của công ty, còn sống, ở toà trong phạm vi khoá, và là phiếu CHI lập tay (hermes_expense_manual_v1: THU ⇒
    -- web_only; luồng hệ thống, hoặc phiếu con định kỳ khi cờ TC5 tắt ⇒ system_voucher). Lượt 2 kiểm lại: bản đã giải đến từ connector.
    -- Khoá dòng phiếu NOWAIT TRƯỚC khi gọi hàm web (Mốc 4b, cùng mẫu Hoá đơn #279): guard dùng chung đã giữ dòng CÔNG TY từ đầu giao dịch,
    -- còn hàm web (cancel_income_expense_flex_v1, trigger vòng đời) giữ dòng phiếu rồi mới khoá công ty ⇒ chờ phiếu ở đây là vòng 40P01.
    -- NOWAIT ⇒ 55P03 ngay (connector: state_changed, xem trước lại), Hermes không bao giờ chờ web.
    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ie.deleted_at IS NULL
      FOR UPDATE NOWAIT;
    IF NOT FOUND OR NOT (v_voucher.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_why:=app_private.hermes_expense_manual_v1(v_voucher.id);
    IF v_why IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_why); END IF;
    -- Lượt 11 (nghiệm thu): "mở lại / khôi phục / hoàn tác huỷ" phiếu không phải thao tác của bot. Sửa phiếu đã huỷ ⇒ web_only; sửa phiếu đã
    -- duyệt / đã vào sổ ⇒ not_pending; huỷ phiếu đã huỷ ⇒ not_pending — cả ba kèm link trang phiếu, trước khi khoá hay chạy thử hàm web.
    IF (p_action='expense.edit' AND v_voucher.approval_status IS DISTINCT FROM 'UNAPPROVED') OR (p_action='expense.cancel' AND v_voucher.approval_status='CANCELLED') THEN
      RETURN jsonb_build_object('kind','rejected','reason',CASE WHEN p_action='expense.edit' AND v_voucher.approval_status='CANCELLED' THEN 'web_only' ELSE 'not_pending' END,
        'link','/income-expense/voucher/'||v_voucher.id);
    END IF;
    -- Lượt 8: huỷ / sửa ghi yêu cầu duyệt của phiếu (trigger đóng / đồng bộ yêu cầu) và dòng có khoá ngoại tới sổ (bút toán đảo của phiếu
    -- đã vào sổ trỏ tới sổ của phiếu), sổ / phòng mới (sửa) ⇒ KEY SHARE trên các dòng đó sau khi đã giữ công ty; web khoá ghi yêu cầu duyệt,
    -- sổ, phòng rồi mới khoá công ty. Khoá trước, NOWAIT, đúng mode hàm web cần.
    PERFORM 1 FROM public.approval_requests ar WHERE ar.organization_id=v_org AND ar.subject_type='INCOME_EXPENSE' AND ar.subject_id=v_voucher.id
      ORDER BY ar.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.accounts a WHERE a.id IN (v_voucher.account_id,(v_resolved->>'cashbookId')::uuid) ORDER BY a.id FOR KEY SHARE NOWAIT;
    PERFORM 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid FOR KEY SHARE NOWAIT;
    SELECT count(*)::int INTO v_count FROM public.income_expense_items it WHERE it.income_expense_id=v_voucher.id;
    SELECT it.income_expense_type_id type_id,t.name type_name,it.description,it.quantity,it.unit_price,it.start_date,it.end_date INTO v_line
      FROM public.income_expense_items it LEFT JOIN public.income_expense_types t ON t.id=it.income_expense_type_id
      WHERE it.income_expense_id=v_voucher.id ORDER BY it.created_at,it.id LIMIT 1;

    IF p_action='expense.edit' THEN
      IF NOT (p_params ?| ARRAY['amount','category','content','payee','voucherDate','cashbook','buildingName','roomName']) THEN
        RETURN jsonb_build_object('kind','rejected','reason','invalid_params'); END IF;
      IF (v_resolved ? 'newBuildingId' AND NOT ((v_resolved->>'newBuildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)))
        OR (v_resolved ? 'roomId' AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid AND r.organization_id=v_org
          AND r.deleted_at IS NULL AND r.building_id=COALESCE((v_resolved->>'newBuildingId')::uuid,v_voucher.building_id)))
        OR (v_resolved ? 'typeId' AND NOT app_private.hermes_expense_category_ok_v1(v_org,(v_resolved->>'typeId')::uuid)) THEN
        RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
      IF v_resolved ? 'cashbookId' AND NOT app_private.hermes_expense_cashbook_ok_v1(v_org,auth.uid(),(v_resolved->>'cashbookId')::uuid) THEN
        RETURN jsonb_build_object('kind','rejected','reason','cashbook_not_held'); END IF;
      -- Tiền / hạng mục chỉ sửa qua bot khi phiếu có đúng một dòng hạng mục (phiếu của Báo chi nhanh và của Hermes); nhiều dòng ⇒ web.
      IF (p_params ? 'amount' OR v_resolved ? 'typeId') AND v_count<>1 THEN RETURN jsonb_build_object('kind','rejected','reason','web_only'); END IF;
      -- Patch theo khoá của revise_pending_income_expense_v1. Nêu đúng toà hiện tại ⇒ không đổi toà, giữ phòng (review Mốc 4). Đổi toà thật ⇒
      -- phòng theo toà mới; không nêu phòng ⇒ bỏ phòng, bản xem trước cảnh báo.
      v_moved:=v_resolved ? 'newBuildingId' AND (v_resolved->>'newBuildingId')::uuid IS DISTINCT FROM v_voucher.building_id;
      v_patch:=jsonb_strip_nulls(jsonb_build_object('name',p_params->>'content','payer_name',p_params->>'payee','voucher_date',p_params->>'voucherDate',
        'account_id',v_resolved->>'cashbookId','building_id',CASE WHEN v_moved THEN v_resolved->>'newBuildingId' END));
      IF v_moved OR v_resolved ? 'roomId' THEN v_patch:=v_patch||jsonb_build_object('room_id',v_resolved->'roomId'); END IF;
      -- Dòng hạng mục: đổi tiền (một dòng, số lượng 1) / hạng mục; kỳ một ngày trùng ngày phiếu cũ đi theo ngày phiếu mới (kỳ = ngày phiếu như lúc lập).
      v_shift:=p_params ? 'voucherDate' AND v_count=1 AND v_line.start_date=v_voucher.voucher_date AND v_line.end_date=v_voucher.voucher_date;
      v_new_items:=CASE WHEN p_params ? 'amount' OR v_resolved ? 'typeId' OR v_shift THEN jsonb_build_array(jsonb_build_object(
        'income_expense_type_id',COALESCE(v_resolved->>'typeId',v_line.type_id::text),'description',v_line.description,
        'quantity',CASE WHEN p_params ? 'amount' THEN 1 ELSE v_line.quantity END,'unit_price',COALESCE((p_params->>'amount')::numeric,v_line.unit_price),
        'start_date',CASE WHEN v_shift THEN p_params->>'voucherDate' ELSE v_line.start_date::text END,
        'end_date',CASE WHEN v_shift THEN p_params->>'voucherDate' ELSE v_line.end_date::text END)) END;
      -- Trước → sau cho người dùng (tên, không UUID); trường không đổi thật thì bỏ.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('field',c.f,'before',c.b,'after',c.a) ORDER BY c.n),'[]'::jsonb) INTO v_changes FROM (VALUES
        (1,'số tiền',app_private.hermes_vnd_text_v1(v_voucher.total_amount),app_private.hermes_vnd_text_v1((p_params->>'amount')::numeric)),
        (2,'hạng mục',v_line.type_name,v_resolved->>'typeName'),
        (3,'nội dung',v_voucher.name,p_params->>'content'),
        (4,'người nhận',COALESCE(v_voucher.payer_name,'(trống)'),p_params->>'payee'),
        (5,'ngày phiếu',to_char(v_voucher.voucher_date,'DD/MM/YYYY'),to_char((p_params->>'voucherDate')::date,'DD/MM/YYYY')),
        (6,'sổ quỹ',COALESCE((SELECT a.name FROM public.accounts a WHERE a.id=v_voucher.account_id),'(chưa chọn)'),v_resolved->>'cashbookName'),
        (7,'toà',(SELECT b.name FROM public.buildings b WHERE b.id=v_voucher.building_id),v_resolved->>'newBuildingName'),
        (8,'phòng',COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=v_voucher.room_id),'(không)'),
          CASE WHEN v_moved OR v_resolved ? 'roomId' THEN COALESCE(v_resolved->>'roomName','(không)') END)) c(n,f,b,a)
        WHERE c.a IS NOT NULL AND c.a IS DISTINCT FROM c.b;
      v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.approval_version,v_voucher.posting_version,v_voucher.approval_status,
        v_voucher.posting_status,v_patch,v_new_items,p_params->>'reason')::text);
      IF p_phase<>'apply' THEN
        -- Xem trước = chạy thử revise_pending_income_expense_v1 (đúng hàm web: chỉ phiếu Chờ duyệt, người lập hoặc người có quyền sửa, CAS
        -- phiên bản, lý do khi đổi tiền/hạng mục/sổ/toà, kỳ đã chốt) rồi lùi.
        BEGIN
          v_out:=public.revise_pending_income_expense_v1(v_voucher.id,v_voucher.approval_version,v_patch,v_new_items,p_params->>'reason',
            'hermes-edit-dry:'||p_request_id::text);
          RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
        EXCEPTION
          WHEN SQLSTATE 'HD001' THEN NULL;
          WHEN OTHERS THEN
            IF SQLSTATE IN ('40P01','55P03') THEN RAISE; END IF;
            GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
            RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
        END;
        IF NOT COALESCE((v_out->>'changed')::boolean,false) OR jsonb_array_length(v_changes)=0 THEN
          RETURN jsonb_build_object('kind','rejected','reason','invalid_params'); END IF;
        IF (p_params->>'amount')::numeric>=50000000 THEN v_warnings:=v_warnings||to_jsonb('Số tiền lớn (từ 50 triệu) — đọc lại số cho người dùng'::text); END IF;
        IF mod((p_params->>'amount')::numeric,1000)<>0 THEN v_warnings:=v_warnings||to_jsonb('Số tiền không tròn nghìn — kiểm lại đơn vị (nghìn/triệu)'::text); END IF;
        IF (p_params->>'voucherDate')::date<v_today-7 THEN
          v_warnings:=v_warnings||to_jsonb(format('Ngày phiếu lùi %s ngày so với hôm nay',v_today-(p_params->>'voucherDate')::date)); END IF;
        IF (p_params->>'voucherDate')::date>v_today THEN v_warnings:=v_warnings||to_jsonb('Ngày phiếu ở tương lai'::text); END IF;
        IF v_moved AND v_voucher.room_id IS NOT NULL AND NOT v_resolved ? 'roomId' THEN
          v_warnings:=v_warnings||to_jsonb(left(format('Đổi toà: phiếu BỎ phòng %s (phòng của toà cũ); cần phòng ở toà mới thì nêu roomName',
            COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=v_voucher.room_id),'cũ')),300)); END IF;
        SELECT format('Sửa phiếu %s (chờ duyệt): %s.',v_voucher.code,string_agg(format('%s %s → %s',c->>'field',c->>'before',c->>'after'),'; '))
          ||COALESCE(' Lý do: '||(p_params->>'reason')||'.','') INTO v_summary FROM jsonb_array_elements(v_changes) c;
        RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
          'preview',jsonb_strip_nulls(jsonb_build_object('summary',left(v_summary,600),'code',v_voucher.code,'changes',v_changes,'reason',p_params->>'reason',
            'willBe','Sau khi sửa phiếu vẫn CHỜ DUYỆT; lần sửa ghi vào lịch sử phiếu')));
      END IF;
      -- Lượt 2: biên nhận, so basis (phiên bản phiếu + patch) và ghi trong cùng khối con: lệch ⇒ lùi cả biên nhận, state_changed.
      BEGIN
        v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
        IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
        IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
        IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
        IF p_expected_basis IS DISTINCT FROM v_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
        v_out:=public.revise_pending_income_expense_v1(v_voucher.id,v_voucher.approval_version,v_patch,v_new_items,p_params->>'reason',
          'hermes-edit:'||p_request_id::text);
        IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
        v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,'result',jsonb_build_object('code',v_voucher.code,
          'changed',v_changes,'revisionNo',v_out->'revision_no','statusText','Đã sửa; phiếu vẫn chờ duyệt'));
        RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
      EXCEPTION
        WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40P01','55P03') OR SQLERRM='hermes_action_outcome_unknown' THEN RAISE; END IF;
          -- Mốc 4b (review): chỉ lỗi do dữ liệu vừa đổi (CAS phiên bản PT409/40001 của hàm web) là state_changed, không chốt. Lỗi khác (quyền
          -- 42501, kỳ đã chốt, hết chờ duyệt, lỗi lập trình ⇒ crm_refused) chốt rejected với lý do thật + SQLSTATE/câu lỗi trong biên nhận để có
          -- dấu vết; khối con đã lùi cả biên nhận ⇒ mở lại rồi chốt; gọi lại cùng requestId phát lại đúng kết cục.
          GET STACKED DIAGNOSTICS v_err_state=RETURNED_SQLSTATE,v_err_msg=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
          v_why:=app_private.hermes_expense_reason_v1(v_err_state,v_err_msg,NULLIF(v_constraint,''));
          IF v_why='state_changed' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
          v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
          IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
          RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,jsonb_build_object('kind','rejected','reason',v_why),
            v_err_state,v_err_msg);
      END;
    END IF;

    -- expense.cancel = cancel_income_expense_flex_v1 (đúng hàm web: người lập / chủ / quyền huỷ + giữ sổ; phiếu đã vào sổ ⇒ bút toán đảo).
    SELECT a.name INTO v_cashbook_name FROM public.accounts a WHERE a.id=v_voucher.account_id;
    v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.approval_version,v_voucher.posting_version,v_voucher.approval_status,
      v_voucher.posting_status,p_params->>'reason')::text);
    IF p_phase<>'apply' THEN
      BEGIN
        v_out:=public.cancel_income_expense_flex_v1(v_voucher.id,p_params->>'reason',v_voucher.approval_version,v_voucher.posting_version);
        RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40P01','55P03') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      -- Hàm web trả changed=false khi phiếu đã huỷ trước đó ⇒ không còn gì để huỷ.
      IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_pending'); END IF;
      -- "Đã vào sổ" theo kết cục THẬT của lần chạy thử (hàm web viết bút toán đảo hay không), không theo cột trạng thái (review Mốc 4).
      v_posted:=v_out->>'cancellation_kind'='CANCELLED_AFTER_POSTING';
      IF COALESCE(v_voucher.repeat_cycle,'NONE')<>'NONE' AND v_voucher.repeat_parent_id IS NULL THEN
        v_warnings:=v_warnings||to_jsonb('Phiếu lặp lại theo chu kỳ: huỷ thì các kỳ sau KHÔNG tự lập nữa'::text); END IF;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Huỷ phiếu %s — %s, %s, %s, ngày %s.',v_voucher.code,app_private.hermes_vnd_text_v1(v_voucher.total_amount),
            COALESCE(v_line.type_name,'?')||CASE WHEN v_count>1 THEN format(' và %s hạng mục khác',v_count-1) ELSE '' END,
            (SELECT b.name FROM public.buildings b WHERE b.id=v_voucher.building_id),to_char(v_voucher.voucher_date,'DD/MM/YYYY')),
          'code',v_voucher.code,'reason',p_params->>'reason',
          'willBe',CASE WHEN v_posted THEN format('ĐÃ VÀO SỔ %s ⇒ huỷ sẽ tạo bút toán đảo (cộng lại %s vào sổ), KHÔNG khôi phục được',
              COALESCE(v_cashbook_name,'quỹ'),app_private.hermes_vnd_text_v1(v_voucher.total_amount))
            ELSE 'CHƯA VÀO SỔ ⇒ phiếu chuyển sang Đã huỷ, sổ quỹ không đổi' END)));
    END IF;
    BEGIN
      v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
      IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
      IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      IF p_expected_basis IS DISTINCT FROM v_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
      v_out:=public.cancel_income_expense_flex_v1(v_voucher.id,p_params->>'reason',v_voucher.approval_version,v_voucher.posting_version);
      IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,'result',jsonb_build_object('code',v_voucher.code,
        'amountText',app_private.hermes_vnd_text_v1(v_voucher.total_amount),'cancellationKind',v_out->>'cancellation_kind',
        'statusText',CASE WHEN v_out->>'cancellation_kind'='CANCELLED_AFTER_POSTING' THEN 'Đã huỷ; đã tạo bút toán đảo vào sổ '||COALESCE(v_cashbook_name,'quỹ')
          ELSE 'Đã huỷ (chưa vào sổ nên sổ quỹ không đổi)' END));
      RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
    EXCEPTION
      WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
      WHEN OTHERS THEN
        IF SQLSTATE IN ('40P01','55P03') OR SQLERRM='hermes_action_outcome_unknown' THEN RAISE; END IF;
        -- Như sửa: chỉ CAS phiên bản ⇒ state_changed; lỗi khác chốt lý do thật + SQLSTATE vào biên nhận.
        GET STACKED DIAGNOSTICS v_err_state=RETURNED_SQLSTATE,v_err_msg=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
        v_why:=app_private.hermes_expense_reason_v1(v_err_state,v_err_msg,NULLIF(v_constraint,''));
        IF v_why='state_changed' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
        v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
        IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
        RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,jsonb_build_object('kind','rejected','reason',v_why),
          v_err_state,v_err_msg);
    END;
  END IF;

  IF p_action='expense.note' THEN
    -- Bản đã giải phải là phiếu của công ty, còn sống, ở toà trong phạm vi khoá. Lượt 8: append_income_expense_supplement_v1 khoá dòng phiếu
    -- FOR UPDATE, còn guard đã giữ công ty và hàm web huỷ / duyệt giữ phiếu rồi mới khoá công ty ⇒ khoá phiếu trước, NOWAIT (55P03 ⇒
    -- state_changed), cả lượt xem trước lẫn lượt ghi.
    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ie.deleted_at IS NULL
      FOR UPDATE NOWAIT;
    IF NOT FOUND OR NOT (v_voucher.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.code,p_params->>'note')::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF p_phase<>'apply' AND NOT (p_phase='auto' AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false)) THEN
      -- Xem trước = chạy thử đúng hàm ghi web rồi lùi (như expense.create): xem trước "được" ⇔ ghi được.
      BEGIN
        PERFORM public.append_income_expense_supplement_v1(v_voucher.id,p_params->>'note','[]'::jsonb,'hermes-note-dry:'||p_request_id::text);
        RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings','[]'::jsonb,
        'preview',jsonb_build_object('summary','Ghi chú vào phiếu '||v_voucher.code||': "'||left(p_params->>'note',200)||'"','code',v_voucher.code,'note',p_params->>'note'));
    END IF;
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    BEGIN
      PERFORM public.append_income_expense_supplement_v1(v_voucher.id,p_params->>'note','[]'::jsonb,'hermes-note:'||p_request_id::text);
      v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,
        'result',jsonb_build_object('code',v_voucher.code,'noted',true));
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      v_outcome:=jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome,SQLSTATE,SQLERRM);
    END;
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  END IF;

  -- expense.create: mọi khoản đã giải phải còn trong phạm vi.
  IF jsonb_typeof(v_resolved->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(v_resolved->'items')<>jsonb_array_length(p_params->'items') THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  FOR v_res IN SELECT value FROM jsonb_array_elements(v_resolved->'items') LOOP
    IF v_res->>'buildingId' IS NULL OR NOT ((v_res->>'buildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))
      OR (v_res->>'roomId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_res->>'roomId')::uuid
        AND r.building_id=(v_res->>'buildingId')::uuid AND r.organization_id=v_org AND r.deleted_at IS NULL))
      OR v_res->>'typeId' IS NULL OR NOT app_private.hermes_expense_category_ok_v1(v_org,(v_res->>'typeId')::uuid)
      OR v_res->>'cashbookId' IS NULL OR v_res->>'voucherDate' IS NULL OR v_res->>'periodStart' IS NULL OR v_res->>'periodEnd' IS NULL THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    IF NOT app_private.hermes_expense_cashbook_ok_v1(v_org,auth.uid(),(v_res->>'cashbookId')::uuid) THEN
      RETURN jsonb_build_object('kind','rejected','reason','cashbook_not_held'); END IF;
  END LOOP;
  -- Lượt 8: create_income_expense_v1 khoá FOR SHARE phòng và sổ của từng khoản sau khi guard đã giữ công ty; nhiều hàm web khoá ghi sổ /
  -- phòng rồi mới khoá công ty (confirm_cashbook_closing_v1, set_cashbook_access_v2, lock_cashbook_period_v1, giữ chỗ / bán phòng …) ⇒ khoá
  -- trước, NOWAIT, cùng mode (55P03 ⇒ state_changed). Toà, hạng mục, thành viên cũng bị khoá FOR SHARE nhưng không hàm web nào khoá ghi
  -- chúng trước công ty (quét thân production 23/10) ⇒ không khoá trước. Thứ tự id trong từng bảng.
  PERFORM 1 FROM public.rooms r WHERE r.id IN (SELECT (x->>'roomId')::uuid FROM jsonb_array_elements(v_resolved->'items') x) ORDER BY r.id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.accounts a WHERE a.id IN (SELECT (x->>'cashbookId')::uuid FROM jsonb_array_elements(v_resolved->'items') x) ORDER BY a.id FOR SHARE NOWAIT;

  IF p_phase<>'apply' THEN
    -- Lượt 1: CHẠY THỬ đúng hàm ghi web trong khối con rồi lùi (TC2) — không để lại phiếu, mã, cam kết hay thông báo nào.
    BEGIN
      v_run:=app_private.hermes_expense_create_run_v1(v_org,p_params,v_resolved,'hermes-dry:'||p_request_id::text);
      RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
    EXCEPTION
      WHEN SQLSTATE 'HD001' THEN NULL;
      WHEN OTHERS THEN
        IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
        -- Mốc 4 (review): lô ≥ 2 khoản ⇒ nói khoản số mấy (HINT hermes_item=i của hermes_expense_create_run_v1).
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME,v_hint=PG_EXCEPTION_HINT;
        RETURN jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')),
          'item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN substring(v_hint FROM '^hermes_item=([1-9][0-9]?)$')::int END));
    END;
    i:=0;
    FOR f IN SELECT value FROM jsonb_array_elements(v_run->'facts') LOOP
      i:=i+1; v_item:=p_params->'items'->(i-1); v_res:=v_resolved->'items'->(i-1); v_total:=v_total+(v_item->>'amount')::numeric;
      v_why:=CASE WHEN (f->>'reasonUsed')::boolean THEN CASE f->>'reason'
          WHEN 'UNDER_THRESHOLD' THEN 'dưới ngưỡng tự duyệt '||COALESCE(app_private.hermes_vnd_text_v1((f->>'threshold')::numeric),'')
          WHEN 'SELF_APPROVER' THEN 'người lập có quyền duyệt'
          WHEN 'WITHIN_COMMITMENT' THEN 'trong cam kết chi còn lại'
          WHEN 'UNDER_CEILING' THEN 'dưới trần chi'
          WHEN 'OVER_THRESHOLD' THEN 'từ ngưỡng tự duyệt '||COALESCE(app_private.hermes_vnd_text_v1((f->>'threshold')::numeric),'')||' trở lên'
          WHEN 'FORCE_APPROVAL' THEN 'hạng mục "'||(v_res->>'typeName')||'" bắt buộc duyệt'
          WHEN 'OVER_COMMITMENT' THEN 'vượt cam kết chi còn lại của kỳ'
          WHEN 'NO_COMMITMENT' THEN 'chưa có cam kết chi cho kỳ này'
          WHEN 'NO_CASHBOOK' THEN 'sổ quỹ chưa hợp lệ' WHEN 'NO_CASHBOOK_RIGHT' THEN 'sổ quỹ chưa hợp lệ'
          ELSE NULL END END;
      -- Bộ máy chi không ghi quyết định cho phiếu này (đo TEST 22/10) ⇒ câu "vì …" dựng từ dữ kiện; trạng thái vẫn lấy từ hàm ghi.
      v_why:=COALESCE(v_why,CASE WHEN f->>'approvalStatus'='APPROVED' THEN CASE
          WHEN (f->>'threshold') IS NOT NULL AND (v_item->>'amount')::numeric<(f->>'threshold')::numeric
            THEN 'dưới ngưỡng tự duyệt '||app_private.hermes_vnd_text_v1((f->>'threshold')::numeric)
          ELSE 'người lập có quyền duyệt' END
        WHEN (f->>'force')::boolean THEN 'hạng mục "'||(v_res->>'typeName')||'" bắt buộc duyệt'
        WHEN (f->>'threshold') IS NOT NULL AND (v_item->>'amount')::numeric>=(f->>'threshold')::numeric
          THEN 'từ ngưỡng tự duyệt '||app_private.hermes_vnd_text_v1((f->>'threshold')::numeric)||' trở lên'
        ELSE 'theo thang duyệt CRM' END);
      v_will:=CASE WHEN f->>'approvalStatus'='APPROVED' AND f->>'postingStatus'='POSTED'
          THEN 'VÀO SỔ NGAY khi ghi ('||v_why||') — trừ sổ '||(v_res->>'cashbookName')
        WHEN f->>'approvalStatus'='APPROVED' THEN 'ĐÃ DUYỆT khi ghi ('||v_why||'), chưa vào sổ'
        ELSE 'CHỜ DUYỆT: '||v_why||'; muốn chi được thì thêm ảnh chứng từ ở trang phiếu' END;
      -- Lượt 11 (Q12, nghiệm thu): khoản cam kết ⇒ câu cam kết NGAY TRONG khoản (và trong tóm tắt), không chỉ ở cảnh báo: cam kết của kỳ, đã chi /
      -- giữ, còn trước khoản này, khoản này trong hay vượt phần còn lại, và phiếu cùng kỳ đã có.
      v_commit:=CASE WHEN f->>'fee' IS NULL THEN NULL
        WHEN f->>'commitment' IS NULL THEN format('Chưa có cam kết chi "%s" tháng %s ở toà này',v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'))
        ELSE format('Cam kết "%s" tháng %s: %s; đã chi/giữ %s; còn %s trước khoản này — %s',v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'),
          app_private.hermes_vnd_text_v1((f->>'commitment')::numeric),
          app_private.hermes_vnd_text_v1((f->>'commitment')::numeric-(f->>'remaining')::numeric),app_private.hermes_vnd_text_v1((f->>'remaining')::numeric),
          CASE WHEN (v_item->>'amount')::numeric>(f->>'remaining')::numeric
            THEN 'khoản này VƯỢT phần còn lại '||app_private.hermes_vnd_text_v1((v_item->>'amount')::numeric-(f->>'remaining')::numeric)
            ELSE 'sau khoản này còn '||app_private.hermes_vnd_text_v1((f->>'remaining')::numeric-(v_item->>'amount')::numeric) END) END;
      IF v_commit IS NOT NULL THEN
        v_commit:=left(v_commit||COALESCE('; kỳ này đã có phiếu '||(SELECT string_agg(x.dup->>'code',', ') FROM (SELECT dup FROM jsonb_array_elements(f->'dups') dup
          WHERE NOT (dup->>'inBatch')::boolean LIMIT 3) x),''),300);
        v_commits:=v_commits||format('Khoản %s: %s.',i,v_commit);
      END IF;
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('stt',i,'building',v_res->>'buildingName','room',v_res->>'roomName',
        'category',v_res->>'typeName','categoryAuto',CASE WHEN (v_res->>'typeAuto')::boolean THEN 'tự chọn theo nội dung — sửa nếu sai' END,
        'content',v_item->>'content','amount',app_private.hermes_vnd_text_v1((v_item->>'amount')::numeric),'payee',v_item->>'payee',
        'voucherDate',app_private.hermes_vn_date_text_v1((v_res->>'voucherDate')::date,v_today),
        'period',CASE WHEN v_item ? 'period' THEN 'tháng '||to_char((v_res->>'periodStart')::date,'MM/YYYY') END,
        'cashbook',v_res->>'cashbookName','willBe',v_will,'commitment',v_commit)));
      -- Cảnh báo (≤ 10, mỗi câu ≤ 300 ký tự).
      FOR d IN SELECT value FROM jsonb_array_elements(f->'dups') LIMIT 2 LOOP
        v_warnings:=v_warnings||to_jsonb(left(CASE WHEN (d->>'inBatch')::boolean
          THEN format('Khoản %s: trùng toà, hạng mục, kỳ với một khoản khác trong lần ghi này%s',i,
            CASE WHEN (d->>'sameAmount')::boolean THEN ' — CÙNG SỐ TIỀN, có thể ghi trùng' ELSE '' END)
          ELSE format('Khoản %s: đã có phiếu %s ngày %s cùng toà, cùng hạng mục, %s%s',i,d->>'code',
            to_char((d->>'date')::date,'DD/MM'),app_private.hermes_vnd_text_v1((d->>'amount')::numeric),
            CASE WHEN (d->>'sameAmount')::boolean THEN ' — CÙNG SỐ TIỀN, có thể ghi trùng' ELSE '' END) END,300));
      END LOOP;
      IF f->>'fee' IS NOT NULL THEN
        v_warnings:=v_warnings||to_jsonb(left(CASE WHEN f->>'commitment' IS NULL
          THEN format('Khoản %s: chưa có cam kết chi "%s" cho tháng %s ở toà này',i,v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'))
          ELSE format('Khoản %s: cam kết "%s" tháng %s là %s, còn %s trước khoản này%s',i,v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'),
            app_private.hermes_vnd_text_v1((f->>'commitment')::numeric),app_private.hermes_vnd_text_v1((f->>'remaining')::numeric),
            CASE WHEN (v_item->>'amount')::numeric>(f->>'remaining')::numeric THEN ' — khoản này VƯỢT phần còn lại' ELSE '' END) END,300));
      END IF;
      IF (v_res->>'voucherDate')::date<v_today-7 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: ngày phiếu lùi %s ngày so với hôm nay',i,v_today-(v_res->>'voucherDate')::date)); END IF;
      IF (v_res->>'voucherDate')::date>v_today THEN v_warnings:=v_warnings||to_jsonb(format('Khoản %s: ngày phiếu ở tương lai',i)); END IF;
      IF (v_item->>'amount')::numeric>=50000000 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: số tiền lớn (từ 50 triệu) — đọc lại số cho người dùng',i)); END IF;
      IF mod((v_item->>'amount')::numeric,1000)<>0 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: số tiền không tròn nghìn — kiểm lại đơn vị (nghìn/triệu)',i)); END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(w),'[]'::jsonb) INTO v_warnings FROM (SELECT w FROM jsonb_array_elements(v_warnings) w LIMIT 10) x;
    RETURN jsonb_build_object('kind','preview','basis',v_run->>'basis','resolved',v_resolved,'confirm','required','warnings',v_warnings,
      'preview',jsonb_build_object('summary',left(format('Ghi %s phiếu chi, tổng %s.',jsonb_array_length(v_items),app_private.hermes_vnd_text_v1(v_total))
          ||COALESCE(' '||NULLIF(array_to_string(v_commits,' '),''),''),1000),
        'items',v_items,'note','Chưa nhận ảnh qua Zalo: sau khi ghi, thêm ảnh ở trang phiếu.'));
  END IF;

  -- Lượt 2: ghi cả lô hoặc không gì (TC3). Biên nhận mở trong cùng khối con: lệch bản đã xem hay một khoản lỗi ⇒ lùi cả lô lẫn
  -- biên nhận (không chốt) ⇒ state_changed, người dùng xem trước lại.
  BEGIN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    v_run:=app_private.hermes_expense_create_run_v1(v_org,p_params,v_resolved,'hermes-expense:'||p_request_id::text);
    IF v_run->>'basis' IS DISTINCT FROM p_expected_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
    i:=0;
    FOR f IN SELECT value FROM jsonb_array_elements(v_run->'facts') LOOP
      i:=i+1; v_res:=v_resolved->'items'->(i-1); v_item:=p_params->'items'->(i-1);
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('code',f->>'code','building',v_res->>'buildingName','room',v_res->>'roomName',
        'category',v_res->>'typeName','amount',(v_item->>'amount'),'amountText',app_private.hermes_vnd_text_v1((v_item->>'amount')::numeric),
        'cashbook',v_res->>'cashbookName','voucherDate',v_res->>'voucherDate','approvalStatus',f->>'approvalStatus','postingStatus',f->>'postingStatus',
        'statusText',CASE WHEN f->>'approvalStatus'='APPROVED' AND f->>'postingStatus'='POSTED' THEN 'Đã duyệt và CHI khỏi sổ '||(v_res->>'cashbookName')
          WHEN f->>'approvalStatus'='APPROVED' THEN 'Đã duyệt, chưa vào sổ' ELSE 'Chờ duyệt; thêm ảnh chứng từ ở trang phiếu để chi được' END)));
    END LOOP;
    v_outcome:=jsonb_build_object('kind','applied','result',jsonb_build_object('vouchers',v_items),
      'link',CASE WHEN jsonb_array_length(v_run->'facts')=1 THEN '/income-expense/voucher/'||(v_run#>>'{facts,0,id}') ELSE '/income-expense' END);
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      -- Lượt 1 đã chạy thử cùng hàm ghi mà qua: lỗi ở đây nghĩa là dữ liệu đã đổi sau bản xem trước ⇒ không ghi gì, xem trước lại.
      RETURN jsonb_build_object('kind','rejected','reason','state_changed');
  END;
END $fn$;

ALTER FUNCTION public.hermes_expense_category_pick_v1(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_expense_category_pick_v1(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_expense_category_pick_v1(uuid,text,text) TO authenticated;
COMMENT ON FUNCTION public.hermes_expense_category_pick_v1(uuid,text,text) IS
  'Hermes Thu chi (lượt 11): chọn hạng mục CHI cho expense.create / expense.edit dưới RLS người hỏi — nêu tên ⇒ trùng / chứa / đủ từ; không nêu ⇒ gợi ý khoá cứng của ie_category_suggest_v1, còn lại hỏi lại với ứng viên trùng từ.';

DO $check$
DECLARE v_fn pg_catalog.pg_proc;
BEGIN
  SELECT * INTO v_fn FROM pg_catalog.pg_proc WHERE oid='public.hermes_expense_category_pick_v1(uuid,text,text)'::regprocedure;
  IF md5(replace(v_fn.prosrc,chr(13),''))<>'2e897b60eaa3e431d0780d2b08751f25' OR v_fn.prosecdef OR v_fn.provolatile<>'s'
    OR replace(COALESCE(array_to_string(v_fn.proconfig,','),''),'"','')<>'search_path='
    OR NOT has_function_privilege('authenticated','public.hermes_expense_category_pick_v1(uuid,text,text)','EXECUTE') OR has_function_privilege('anon','public.hermes_expense_category_pick_v1(uuid,text,text)','EXECUTE')
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)'::regprocedure)<>'dcadc17bcecce3876eb75cbaec235763'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)<>'15183dce50beb631bfb240564c7cd226'
    OR NOT has_function_privilege('authenticated','public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_expense_acceptance_catalog_invalid'; END IF;
END $check$;
COMMIT;
