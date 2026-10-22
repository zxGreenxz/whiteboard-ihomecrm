-- Đợt 2 Thu chi (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 4.2–4.3): hai công thức của "Báo chi nhanh" mà
-- web đang tính bằng TypeScript thành hàm SQL DÙNG CHUNG (quy tắc chủ chốt 17/10: Hermes là nơi dùng thứ hai và công thức dính
-- tiền — sai hạng mục là sai KQKD/cam kết chi). Web chuyển sang gọi ở Mốc 5; Hermes gọi từ lõi giải tên của thao tác expense.*.
--  (1) public.ie_quick_text_v1(text, bare)  IMMUTABLE: đúng accentedText / bareText của src/lib/quickEntry/categoryRules.ts —
--      NFC, chữ thường, mọi ký tự không phải chữ/số/'/' thành khoảng trắng, gộp khoảng trắng, bọc một khoảng trắng hai đầu
--      (so " cụm " theo ranh giới từ); bare: thêm NFD, bỏ dấu U+0300–U+036F, đ → d.
--  (2) public.ie_category_suggest_v1(org, items, type, include_restricted)  STABLE INVOKER: đúng suggestCategory của
--      src/lib/quickEntry/categorySuggest.ts trên danh sách usableExpenseCategories (đúng công ty, đúng chiều thu/chi, bỏ
--      system_only / đã lưu trữ / manual_hidden / quick_entry_hidden; hạng mục hạn chế chỉ khi include_restricted). Bốn đường,
--      đúng thứ tự TS: mã khách hàng phí (provider_code, categoryForFee) → luật chủ đặt rồi cụm "hay nói" (ruleMatch; khoá cứng
--      theo strongFor ⇒ rule, không ⇒ rule_weak) → cụm phí cố định (fee_phrase, FEE_PHRASES) → trùng chữ tên (name_overlap; vào
--      hạng mục dòng tiền thì rule_weak). Không chắc ⇒ null. items = [{text, feeCategory?}] (≤ 100); kết quả cùng thứ tự:
--      {typeId, ruleKey, reason} hoặc null. Đọc income_expense_types DƯỚI RLS người gọi, lọc organization_id tường minh (RLS
--      hạng mục lộ hạng mục của công ty khác — như usableExpenseCategories).
--  (3) public.ie_default_cashbook_v1(org, building, last_used)  STABLE INVOKER: đúng expenseCashbooksForOrg + pickDefaultAccount
--      của src/lib/quickEntry/cashbook.ts — trong sổ người gọi đang giữ (list_cashbooks_for_expense_v2) ∩ sổ của công ty, không ảo:
--      sổ gắn toà (quick_default_building_id) → last_used nếu còn dùng được → sổ mặc định → sổ đầu tiên. Web truyền sổ nhớ ở
--      localStorage (hành vi web không đổi); Hermes truyền sổ của phiếu CHI lập tay gần nhất của chính người dùng.
-- Hằng số (luật chủ đặt, neo khoá cứng, loại trừ, cụm phí, từ dừng) chép đúng từ hai file TS; regex JS ⇒ regex ARE: \p{L} ⇒
-- [[:alpha:]], \b ⇒ \y, còn lại giữ nguyên. Bộ vector VÀNG dùng chung: src/lib/quickEntry/__tests__/fixtures/goi-y-hang-muc-vang.json
-- (TS sinh; vitest khoá TS == vàng; infra/hermes-broker/ie-quick-entry-rules-sql.test.mjs khoá hàm này == vàng trên PostgreSQL 17
-- locale Unicode như production). Đổi luật ⇒ đổi cả hai rồi sinh lại vàng; khi web gọi hàm này (Mốc 5) thì xoá TS.
-- Không ghi dữ liệu. Idempotent (CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[['public.income_expense_types','keywords'],['public.income_expense_types','rule_key'],
    ['public.income_expense_types','fee_category'],['public.income_expense_types','quick_entry_hidden'],['public.income_expense_types','manual_hidden'],
    ['public.income_expense_types','archived_at'],['public.income_expense_types','system_only'],['public.income_expense_types','is_restricted'],
    ['public.income_expense_types','sort_order'],['public.income_expense_types','category'],['public.accounts','quick_default_building_id'],
    ['public.accounts','is_default'],['public.accounts','is_virtual']] LOOP
    IF to_regclass(item[1]) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass(item[1]) AND attname=item[2] AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'ie_quick_entry_rules_dependency_invalid: %.%',item[1],item[2]; END IF;
  END LOOP;
  IF to_regprocedure('public.list_cashbooks_for_expense_v2()') IS NULL THEN
    RAISE EXCEPTION 'ie_quick_entry_rules_dependency_invalid: list_cashbooks_for_expense_v2'; END IF;
END $requires$;

-- 1. accentedText / bareText.
CREATE OR REPLACE FUNCTION public.ie_quick_text_v1(p_text text,p_bare boolean DEFAULT false)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT CASE WHEN COALESCE(p_bare,false)
    THEN replace(regexp_replace(normalize(x.a,NFD),'[̀-ͯ]','','g'),'đ','d') ELSE x.a END
  FROM (SELECT ' '||btrim(regexp_replace(regexp_replace(lower(normalize(COALESCE(p_text,''),NFC)),'[^[:alpha:][:digit:]/ ]+',' ','g'),' +',' ','g'),' ')||' ' AS a) x
$fn$;

-- 2. suggestCategory.
CREATE OR REPLACE FUNCTION public.ie_category_suggest_v1(p_organization_id uuid,p_items jsonb,p_type text DEFAULT 'expense',
  p_include_restricted boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  -- OWNER_RULES: [rule_key, mẫu có dấu, mẫu không dấu, loại trừ]; thứ tự = ưu tiên (dòng tiền trước, vệ sinh sau cùng).
  c_owner CONSTANT jsonb:=jsonb_build_array(
    jsonb_build_array('bo_sung_hoan_coc',' (hoàn|trả|trả lại) cọc | bổ sung hoàn cọc ',' hoan coc | tra lai coc ',
      jsonb_build_array('chủ nhà','thợ','cọc nhà','thuê nhà','thi công','lắp','công tơ','bình','xe','khách sạn','homestay','mặt bằng','kho',
        'khách hàng','đối tác')),
    jsonb_build_array('tra_tien_thua_khach',
      ' thối tiền | khách đóng dư | đóng dư tiền phòng | tiền phòng \d+ ngày | hoàn (lại )?(\d+ ngày )?tiền phòng | tiền phòng thừa ',
      ' thoi tien | khach dong du ',jsonb_build_array('ship','thợ')),
    jsonb_build_array('noi_bo',
      ' kết tiền (resident|sổ|quỹ) | kết sổ | bàn giao (tiền|về sổ|(a|anh|chị|c|em|cô|chú)) | (chuyển|chi|đóng) (tiền \S+ )?(dùm|giùm|hộ) (a|anh|chị|c|em|cô|chú) ',
      ' ket tien (resident|so|quy) | ket so | ban giao (tien|ve so|a|anh|chi) | (chuyen|chi|dong) (tien \S+ )?(dum|gium) (a|anh|chi|c|em|co|chu) ',
      jsonb_build_array('thợ','chủ nhà','căn hộ','hộ khẩu','evn','dọn','sửa','sơn','bảo vệ','lao công','điện lạnh','máy bơm','ship','thầu',
        'xây dựng','công ty','nhà cung cấp','điện lực','cấp nước')),
    jsonb_build_array('camera_wifi_van_tay',' camera | wifi | wi fi | modem | cục phát | vân tay | lưu điện | thẻ từ | thẻ nhớ ',
      ' camera | wifi | modem | van tay | luu dien | the tu ',jsonb_build_array('tiền wifi','tiền mạng','cước')),
    jsonb_build_array('pccc',' pccc | chữa cháy | thoát hiểm ',' pccc ','[]'::jsonb),
    jsonb_build_array('cong_an',' công an | cakv | cap\d+ |^ ca \d{3,4} | tiền ca t\d',' cong an | cakv ',jsonb_build_array('bảo vệ','trực')),
    jsonb_build_array('tam_tru_giay_to',' tạm trú | tiếp dân | người nước ngoài | gpkd ',' tam tru | tiep dan | nguoi nuoc ngoai ','[]'::jsonb),
    jsonb_build_array('don_ve_sinh',' vệ sinh | btaskee | dọn phòng | dọn dẹp | lau hành lang ',' btaskee ',
      jsonb_build_array('máy lạnh','máy giặt','bồn nước','ống nước','ống đồng','giấy vệ sinh','nhà vệ sinh','phòng vệ sinh','vòi xịt','xịt vệ sinh',
        'thiết bị vệ sinh','bồn cầu','toilet')));
  -- PHRASE_NOT (loại trừ riêng của cụm "hay nói"; cộng thêm loại trừ của luật chủ cùng mục — phraseNot).
  c_phrase_not CONSTANT jsonb:=jsonb_build_object('dien',jsonb_build_array('điện lạnh'),
    'tien_nha',jsonb_build_array('hợp đồng thuê nhà','dùm','giùm','cọc','hộ a','hộ anh','hộ chị','hộ c','hộ em','hộ cô','hộ chú'),
    'noi_that_decor',jsonb_build_array('rác'),'dien_lanh',jsonb_build_array('mua máy','mua tủ'),'thang_may',jsonb_build_array('mua'));
  c_distinct CONSTANT text[]:=ARRAY['btaskee','pccc','camera','wifi','modem','decor','internet','evn','fpt','viettel','grab','lalamove','ship',
    'remote','silicon','hhmg','cakv','pql'];
  -- STRONG: hạng mục dòng tiền chỉ KHOÁ CỨNG khi có neo; khớp mà thiếu neo (hoặc dính weakIf) chỉ là gợi ý yếu.
  c_noi_canon CONSTANT text:='^ bàn giao (tiền )?(\S*\d\S* )*(cho )?(a|anh|chị|c|em) [[:alpha:]]+ (\S*\d\S* )*$|^ (chuyển|chi|đóng) tiền nhà (dùm|giùm|hộ) (a|anh|chị|c|em) [[:alpha:]]+ $';
  c_noi_acc CONSTANT text:=' kết tiền (resident|sổ|quỹ) | kết sổ | bàn giao (tiền )?về sổ ';
  c_noi_bare CONSTANT text:=' ket tien (resident|so|quy) | ket so | ban giao (tien )?ve so ';
  c_noi_weak CONSTANT text:=' tiền (điện|nước|rác|internet|mạng|nhà)| điện nước | rác | công an | internet ';
  c_noi_weak_bare CONSTANT text:=' tien (dien|nuoc|rac|internet|mang|nha)| dien nuoc | rac | cong an | internet ';
  c_coc_acc CONSTANT text:=' khách(?! sạn| hàng)| thanh lý (hđ|hợp đồng)| phòng \d{3}| \d{3,4} \d{2,4}[a-zđ]+ ';
  c_coc_bare CONSTANT text:=' khach(?! san| hang)| thanh ly (hd|hop dong)| phong \d{3}| \d{3,4} \d{2,4}[a-z]+ ';
  -- FEE_PHRASES trên chuỗi normalizeLoose, theo thứ tự.
  c_fee CONSTANT jsonb:=jsonb_build_array(
    jsonb_build_array('tien_nha','\y(tien nha|thue nha|tien thue nha)\y'),
    jsonb_build_array('dien','\y(tien dien(?! lanh)|hoa don dien|dien thang|dien ky|evn)\y'),
    jsonb_build_array('nuoc','\y(tien nuoc|hoa don nuoc|nuoc thang|nuoc ky|cap nuoc)\y'),
    jsonb_build_array('internet','\y(internet|wifi|cuoc mang|tien mang)\y'),
    jsonb_build_array('quan_ly','\y(phi quan ly|tien quan ly)\y'),
    jsonb_build_array('ve_sinh','\y(tien ve sinh|ve sinh toa nha)\y'),
    jsonb_build_array('cong_an','\y(tien cong an)\y'),
    jsonb_build_array('rac','\y(tien rac|phi rac|thu gom rac)\y'),
    jsonb_build_array('thang_may','\y(thang may)\y'));
  c_stop CONSTANT text[]:=ARRAY['tien','mua','cho','phong','toa','nha','va','cai','cua','o','bi','lai','moi','cac','nhung','the','nay','do','kia',
    'hom','qua','ngay','thang','nam','k','tr','trieu','nghin','ngan','dong'];
  c_money_flow CONSTANT text[]:=ARRAY['noi_bo','bo_sung_hoan_coc','tra_tien_thua_khach','chia_loi_nhuan'];
  v_rows jsonb; v_phrases jsonb; v_owner_not jsonb; v_phrase_not jsonb; v_fee_map jsonb; v_out jsonb:='[]'::jsonb;
  v_item jsonb; v_text text; v_fee text; a text; b text; noacc boolean; loose text;
  v_ref jsonb; v_best jsonb; v_reason text; v_ids text[]; v_words text[]; v_top int; v_count int; o record; f record;
BEGIN
  IF p_organization_id IS NULL OR p_type IS NULL OR p_type NOT IN ('expense','income') OR p_include_restricted IS NULL
    OR p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>100 THEN
    RAISE EXCEPTION 'ie_category_suggest_invalid' USING ERRCODE='22023'; END IF;
  -- usableExpenseCategories (dưới RLS người gọi). c/n = nrm(category)/nrm(name) cho FIXED_EXPENSE_CATEGORIES; loose = normalizeLoose(name)
  -- cho trùng chữ; fx = khoản phí cố định mà hạng mục khớp theo luật của báo cáo lợi nhuận (fixedExpenseCategories.ts).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',y.id,'rk',y.rule_key,'fee',y.fee_category,'loose',y.loose,'kw',y.kw,
      'fx',to_jsonb(array_remove(ARRAY[
        CASE WHEN y.c='tien nha' OR strpos(y.n,'tien nha')>0 THEN 'tien_nha' END,
        CASE WHEN y.c='dien' OR strpos(y.n,'tien dien')>0 THEN 'dien' END,
        CASE WHEN y.c='nuoc' OR strpos(y.n,'tien nuoc')>0 THEN 'nuoc' END,
        CASE WHEN y.c='internet' OR strpos(y.n,'internet')>0 THEN 'internet' END,
        CASE WHEN strpos(y.n,'quan ly')>0 THEN 'quan_ly' END,
        CASE WHEN (y.c='ve sinh' OR strpos(y.n,'ve sinh toa nha')>0) AND strpos(y.n,'rac')=0 THEN 've_sinh' END,
        CASE WHEN (y.c='ca' OR strpos(y.n,'cong an')>0) AND strpos(y.n,'tam tru')=0 THEN 'cong_an' END,
        CASE WHEN strpos(y.n,'rac')>0 THEN 'rac' END,
        CASE WHEN strpos(y.n,'thang may')>0 THEN 'thang_may' END],NULL))) ORDER BY y.sort_order NULLS LAST,y.name,y.id),'[]'::jsonb) INTO v_rows
    FROM (SELECT t.id,t.rule_key,t.fee_category,t.sort_order,t.name,to_jsonb(COALESCE(t.keywords,'{}'::text[])) kw,
        btrim(replace(lower(regexp_replace(normalize(COALESCE(t.category,''),NFD),'[̀-ͯ]','','g')),'đ','d'),E' \t\n\r') c,
        btrim(replace(lower(regexp_replace(normalize(COALESCE(t.name,''),NFD),'[̀-ͯ]','','g')),'đ','d'),E' \t\n\r') n,
        replace(regexp_replace(normalize(lower(btrim(COALESCE(t.name,''),E' \t\n\r')),NFD),'[̀-ͯ]','','g'),'đ','d') loose
      FROM public.income_expense_types t
      WHERE t.organization_id=p_organization_id AND t.type=p_type AND NOT COALESCE(t.system_only,false) AND t.archived_at IS NULL
        AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
        AND (p_include_restricted OR NOT COALESCE(t.is_restricted,false))) y;
  -- phrasesOf: cụm ≥ 2 chữ (so có dấu; không dấu khi câu gõ không dấu) hoặc từ đơn trong DISTINCT (chỉ so có dấu).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'rk',x.rk,'pa',x.pa,'pb',CASE WHEN x.words>=2 THEN x.pb END)),'[]'::jsonb) INTO v_phrases
    FROM (SELECT r->>'id' id,r->>'rk' rk,public.ie_quick_text_v1(kw,false) pa,public.ie_quick_text_v1(kw,true) pb,
        cardinality(array_remove(string_to_array(btrim(public.ie_quick_text_v1(kw,false)),' '),'')) words
      FROM jsonb_array_elements(v_rows) r CROSS JOIN LATERAL jsonb_array_elements_text(r->'kw') kw) x
    WHERE x.words>=2 OR (x.words=1 AND btrim(x.pb)=ANY(c_distinct));
  -- Loại trừ đã chuẩn hoá [có dấu, không dấu]: của luật chủ (theo rule_key) và phraseNot = PHRASE_NOT ∪ loại trừ luật chủ cùng mục.
  SELECT COALESCE(jsonb_object_agg(e->>0,(SELECT COALESCE(jsonb_agg(jsonb_build_array(public.ie_quick_text_v1(w,false),public.ie_quick_text_v1(w,true))),'[]'::jsonb)
      FROM jsonb_array_elements_text(e->3) w)),'{}'::jsonb) INTO v_owner_not FROM jsonb_array_elements(c_owner) e;
  SELECT COALESCE(jsonb_object_agg(k.rk,(SELECT COALESCE(jsonb_agg(jsonb_build_array(public.ie_quick_text_v1(w,false),public.ie_quick_text_v1(w,true))),'[]'::jsonb)
      FROM (SELECT jsonb_array_elements_text(COALESCE(c_phrase_not->k.rk,'[]'::jsonb)) UNION ALL
            SELECT jsonb_array_elements_text(e->3) FROM jsonb_array_elements(c_owner) e WHERE e->>0=k.rk) q(w))),'{}'::jsonb) INTO v_phrase_not
    FROM (SELECT jsonb_object_keys(c_phrase_not) UNION SELECT e->>0 FROM jsonb_array_elements(c_owner) e) k(rk);
  -- categoryForFee cho mọi khoản phí biết được: đúng MỘT hạng mục gắn fee_category ⇒ nó; ≥ 2 ⇒ không; 0 ⇒ đúng MỘT hạng mục khớp
  -- FIXED_EXPENSE_CATEGORIES ⇒ nó. Khoản phí lạ (không gắn, không có luật) ⇒ không.
  SELECT COALESCE(jsonb_object_agg(k.fee,(SELECT CASE
        WHEN count(*) FILTER (WHERE r->>'fee'=k.fee)=1 THEN (array_agg(r) FILTER (WHERE r->>'fee'=k.fee))[1]
        WHEN count(*) FILTER (WHERE r->>'fee'=k.fee)>1 THEN NULL
        WHEN count(*) FILTER (WHERE (r->'fx') ? k.fee)=1 THEN (array_agg(r) FILTER (WHERE (r->'fx') ? k.fee))[1] END
      FROM jsonb_array_elements(v_rows) r)),'{}'::jsonb) INTO v_fee_map
    FROM (SELECT unnest(ARRAY['tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may'])
          UNION SELECT r->>'fee' FROM jsonb_array_elements(v_rows) r WHERE r->>'fee' IS NOT NULL) k(fee);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR jsonb_typeof(v_item->'text') IS DISTINCT FROM 'string' OR char_length(v_item->>'text')>1000
      OR (v_item ? 'feeCategory' AND jsonb_typeof(v_item->'feeCategory') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'ie_category_suggest_invalid' USING ERRCODE='22023'; END IF;
    v_text:=v_item->>'text'; v_fee:=NULLIF(v_item->>'feeCategory',''); v_ref:=NULL; v_reason:=NULL;
    a:=public.ie_quick_text_v1(v_text,false); b:=public.ie_quick_text_v1(v_text,true); noacc:=a=b;
    loose:=replace(regexp_replace(normalize(lower(btrim(v_text,E' \t\n\r')),NFD),'[̀-ͯ]','','g'),'đ','d');
    -- (1) Mã khách hàng phí.
    IF v_fee IS NOT NULL AND jsonb_typeof(v_fee_map->v_fee)='object' THEN v_ref:=v_fee_map->v_fee; v_reason:='provider_code'; END IF;
    -- (2a) Luật chủ đặt: luật đầu tiên khớp, không dính loại trừ, và có hạng mục dùng được mang rule_key đó.
    IF v_ref IS NULL AND btrim(v_text)<>'' THEN
      FOR o IN SELECT e->>0 rk,e->>1 acc,e->>2 bare FROM jsonb_array_elements(c_owner) WITH ORDINALITY z(e,ord) ORDER BY ord LOOP
        CONTINUE WHEN NOT (a ~ o.acc OR (noacc AND b ~ o.bare));
        CONTINUE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(v_owner_not->o.rk) w WHERE strpos(a,w->>0)>0 OR (noacc AND strpos(b,w->>1)>0));
        SELECT r INTO v_ref FROM jsonb_array_elements(v_rows) r WHERE r->>'rk'=o.rk LIMIT 1;
        IF v_ref IS NOT NULL THEN v_reason:='rule?'; EXIT; END IF;
      END LOOP;
      -- (2b) Cụm "hay nói": chỉ chốt khi đúng MỘT hạng mục khớp.
      IF v_ref IS NULL THEN
        SELECT array_agg(DISTINCT p->>'id') INTO v_ids FROM jsonb_array_elements(v_phrases) p
          WHERE (strpos(a,p->>'pa')>0 OR (noacc AND p->>'pb' IS NOT NULL AND strpos(b,p->>'pb')>0))
            AND NOT (p->>'rk' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_phrase_not->(p->>'rk'),'[]'::jsonb)) w
              WHERE strpos(a,w->>0)>0 OR (noacc AND strpos(b,w->>1)>0)));
        IF cardinality(v_ids)=1 THEN
          SELECT r INTO v_ref FROM jsonb_array_elements(v_rows) r WHERE r->>'id'=v_ids[1];
          v_reason:='rule?';
        END IF;
      END IF;
      -- strongFor: chỉ noi_bo / bo_sung_hoan_coc có neo; mục khác khớp là khoá cứng.
      IF v_reason='rule?' THEN
        v_reason:=CASE WHEN CASE v_ref->>'rk'
            WHEN 'noi_bo' THEN a ~ c_noi_canon OR ((a ~ c_noi_acc OR (noacc AND b ~ c_noi_bare)) AND NOT (a ~ c_noi_weak OR (noacc AND b ~ c_noi_weak_bare)))
            WHEN 'bo_sung_hoan_coc' THEN a ~ c_coc_acc OR (noacc AND b ~ c_coc_bare)
            ELSE true END THEN 'rule' ELSE 'rule_weak' END;
      END IF;
    END IF;
    -- (3) Cụm phí cố định (bỏ qua "cọc" với tiền nhà, và câu dính loại trừ của mục đó — blockedFor).
    IF v_ref IS NULL THEN
      FOR f IN SELECT e->>0 fee,e->>1 re FROM jsonb_array_elements(c_fee) WITH ORDINALITY z(e,ord) ORDER BY ord LOOP
        CONTINUE WHEN NOT loose ~ f.re;
        CONTINUE WHEN f.fee='tien_nha' AND loose ~ '\ycoc\y';
        CONTINUE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_phrase_not->f.fee,'[]'::jsonb)) w
          WHERE strpos(a,w->>0)>0 OR (noacc AND strpos(b,w->>1)>0));
        IF jsonb_typeof(v_fee_map->f.fee)='object' THEN v_ref:=v_fee_map->f.fee; v_reason:='fee_phrase'; EXIT; END IF;
      END LOOP;
    END IF;
    -- (4) Trùng chữ tên: đúng MỘT hạng mục có điểm cao nhất (> 0).
    IF v_ref IS NULL THEN
      SELECT array_agg(DISTINCT w) INTO v_words FROM regexp_split_to_table(loose,'[^a-z0-9]+') w
        WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^\d+$';
      IF cardinality(v_words)>0 THEN
        WITH s AS (SELECT r,(SELECT count(*) FROM regexp_split_to_table(r->>'loose','[^a-z0-9]+') w
            WHERE char_length(w)>=2 AND NOT w=ANY(c_stop) AND w!~'^\d+$' AND w=ANY(v_words))::int score FROM jsonb_array_elements(v_rows) r),
          top AS (SELECT max(score) score FROM s)
        SELECT top.score,(SELECT count(*) FROM s WHERE s.score=top.score)::int,(SELECT s.r FROM s WHERE s.score=top.score LIMIT 1)
          INTO v_top,v_count,v_best FROM top;
        IF v_top>0 AND v_count=1 THEN
          v_ref:=v_best;
          v_reason:=CASE WHEN v_ref->>'rk'=ANY(c_money_flow) THEN 'rule_weak' ELSE 'name_overlap' END;
        END IF;
      END IF;
    END IF;
    v_out:=v_out||jsonb_build_array(CASE WHEN v_ref IS NULL THEN NULL
      ELSE jsonb_build_object('typeId',v_ref->>'id','ruleKey',v_ref->'rk','reason',v_reason) END);
  END LOOP;
  RETURN v_out;
END $fn$;

-- 3. pickDefaultAccount (+ expenseCashbooksForOrg). Thứ tự sổ = thứ tự list_cashbooks_for_expense_v2 (như usableIds của web).
CREATE OR REPLACE FUNCTION public.ie_default_cashbook_v1(p_organization_id uuid,p_building_id uuid DEFAULT NULL,p_last_used uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
  WITH usable AS (
    SELECT a.id,a.quick_default_building_id,COALESCE(a.is_default,false) is_default,c.ord
    FROM public.list_cashbooks_for_expense_v2() WITH ORDINALITY c(id,name,ord)
    JOIN public.accounts a ON a.id=c.id AND a.organization_id=p_organization_id AND NOT COALESCE(a.is_virtual,false)
    WHERE p_organization_id IS NOT NULL)
  SELECT COALESCE(
    (SELECT u.id FROM usable u WHERE p_building_id IS NOT NULL AND u.quick_default_building_id=p_building_id ORDER BY u.ord LIMIT 1),
    (SELECT u.id FROM usable u WHERE u.id=p_last_used),
    (SELECT u.id FROM usable u WHERE u.is_default ORDER BY u.ord LIMIT 1),
    (SELECT u.id FROM usable u ORDER BY u.ord LIMIT 1))
$fn$;

ALTER FUNCTION public.ie_quick_text_v1(text,boolean) OWNER TO postgres;
ALTER FUNCTION public.ie_category_suggest_v1(uuid,jsonb,text,boolean) OWNER TO postgres;
ALTER FUNCTION public.ie_default_cashbook_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ie_quick_text_v1(text,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ie_category_suggest_v1(uuid,jsonb,text,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ie_default_cashbook_v1(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ie_quick_text_v1(text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_category_suggest_v1(uuid,jsonb,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_default_cashbook_v1(uuid,uuid,uuid) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.ie_category_suggest_v1(uuid,jsonb,text,boolean)'::regprocedure AND NOT prosecdef AND provolatile='s')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.ie_default_cashbook_v1(uuid,uuid,uuid)'::regprocedure AND NOT prosecdef AND provolatile='s')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.ie_quick_text_v1(text,boolean)'::regprocedure AND NOT prosecdef AND provolatile='i')
    OR has_function_privilege('anon','public.ie_category_suggest_v1(uuid,jsonb,text,boolean)','EXECUTE')
    OR has_function_privilege('anon','public.ie_default_cashbook_v1(uuid,uuid,uuid)','EXECUTE')
    -- Cùng câu với TS trên một ca neo (lớp luật + bỏ dấu): đổi locale làm hỏng bỏ dấu thì dừng, không áp.
    OR public.ie_quick_text_v1('Đóng TIỀN Điện, T10!',true)<>' dong tien dien t10 ' THEN
    RAISE EXCEPTION 'ie_quick_entry_rules_catalog_invalid'; END IF;
END $check$;
COMMIT;
