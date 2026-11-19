-- Thu chi lượt 14 (24/10/2026; nghiệm thu vòng 1 bot thật trên TEST — docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 25): hàm DÙNG CHUNG
-- public.ie_category_suggest_v1 (web "Báo chi nhanh" + bộ chọn hạng mục expense.* của Hermes), áp SAU 20261023210633 (v2). Lỗi nghiệm thu: "mua
-- nệm cho phòng 202" ghi vào "Chi khác (ghi rõ)" — hàm không ra gợi ý nào (nệm, giường, tủ … không có trong cụm "hay nói"), bộ chọn của bot chỉ
-- nêu "Bỏ rác phát sinh" (cụm "đổ nệm cũ"). Đo 90 ngày production (683 phiếu CHI lập tay, chỉ đọc): nệm, giường, tinh dầu, ấm đun, cơm, khay lăn
-- sơn … người lập chọn "Chi khác" hoặc không ra gợi ý; "chi phí …", "ghi chú …" từng ra "Chi khác" do trùng chữ tên.
--   (3b) từ vựng thêm: bo_rac (bỏ / đổ nệm, đồ cũ, rác bổ sung), dien_may (quạt, máy lạnh, tủ lạnh, ấm đun, bếp, lò vi sóng, tivi, bàn là …;
--        sửa / vệ sinh / bơm gas / kiểm tra bảo hành thuộc Điện lạnh), noi_that_decor (giường, nệm, tủ, kệ, bàn ghế, sofa, rèm, gương, thảm,
--        gối, chăn, cây cảnh, tinh dầu, decor …; bỏ / đổ / dọn / giặt / sửa / chở thì không), an_uong_phuc_loi (cơm, pizza, trà sữa, cà phê, ăn
--        trưa / tối, liên hoan …); mở rộng dung_cu (khay / cọ / con lăn sơn, giấy nhám, bao tay, tua vít, thang xếp) và vat_tu_dien_nuoc (bóng
--        đèn / đèn led / âm trần, nút nhấn / bộ xả bồn cầu, phễu chống hôi, silicon; bỏ khi có "thang máy").
--   (4) trùng chữ tên: hạng mục "khác" (Chi khác (ghi rõ)) thắng ⇒ không gợi ý (hoà điểm giữ như cũ).
-- Bộ vàng đổi đúng 32 / 647 ca (đều từ không ra gì / trùng chữ sai ⇒ khoá cứng đúng hạng mục, hoặc "Chi khác" ⇒ không gợi ý) — infra/hermes-broker/
-- ie-quick-entry-rules-sql.test.mjs khoá danh sách đó. Web gọi đúng hàm này nên Báo chi nhanh đổi cùng lúc (không phát hành web). Chỉ thay thân;
-- ghim md5 thân đang chạy (20261023210633) hoặc thân của chính file ⇒ áp lại được. Không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.ie_quick_text_v1(text,boolean)') IS NULL OR to_regclass('public.income_expense_types') IS NULL THEN
    RAISE EXCEPTION 'ie_quick_entry_rules_v3_dependency_invalid'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('public.ie_category_suggest_v1(uuid,jsonb,text,boolean)')),'') NOT IN ('14517a5e12a85128d171940774fc968b','3a8638094d6233170d3d1d75a5d62a9c') THEN
    RAISE EXCEPTION 'ie_quick_entry_rules_v3_body_drift'; END IF;
END $requires$;

-- suggestCategory + lớp (3b) mở rộng + (4) bỏ "Chi khác" (thay thân; chữ ký, độ biến động, INVOKER, search_path rỗng và ACL giữ nguyên).
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
  -- Lượt 11 (nghiệm thu 24/10) + lượt 14 (nội thất, điện máy, ăn uống): từ vựng vật tư / sửa chữa / văn phòng phẩm — chỉ chạy khi luật chủ, cụm "hay nói" và cụm phí không ra gì, TRƯỚC
  -- trùng chữ tên. [rule_key, mẫu có dấu, mẫu không dấu, cần thêm (có dấu, không dấu) | NULL, loại trừ]; khớp ⇒ khoá cứng (rule).
  c_lex CONSTANT jsonb:=jsonb_build_array(
    jsonb_build_array('sua_dien',' (điện|ổ cắm|ổ điện|công tắc|cầu dao|aptomat|át tô mát|cầu chì|đèn|bóng đèn|dây điện|đường điện|quạt|chập điện|chập) ',
      ' (o cam|o dien|cau dao|aptomat|cau chi|bong den|day dien|duong dien|chap dien) ',' (sửa|sửa chữa|thợ|tiền công|nhân công|công thợ|gọi thợ|thuê thợ) ',' (sua chua|tien cong|nhan cong|cong tho|goi tho|thue tho|tho) ',
      jsonb_build_array('mua','điện lạnh','máy lạnh','máy giặt','tủ lạnh','máy bơm','camera','vân tay','thang máy','tiền điện','hoá đơn điện','điện thoại','gel')),
    jsonb_build_array('sua_nuoc_may_bom',' (nước|ống nước|ống|vòi|vòi nước|vòi sen|vòi xịt|sen tắm|bồn cầu|bồn rửa|lavabo|cống|máy bơm|bồn nước|xi phông|phao|bể nước) ',
      ' (ong nuoc|voi nuoc|voi sen|voi xit|sen tam|bon cau|bon rua|lavabo|may bom|bon nuoc|xi phong) ',' (sửa|sửa chữa|thợ|tiền công|nhân công|công thợ|gọi thợ|thuê thợ|thông|rò|rỉ|bể|vỡ|nghẹt) ',' (sua chua|tien cong|nhan cong|cong tho|goi tho|thue tho|thong|nghet) ',
      jsonb_build_array('mua','máy lạnh','máy giặt','tiền nước','hoá đơn nước','nước uống','điện lạnh','ống đồng','rò điện','rò rỉ điện','gel')),
    jsonb_build_array('vat_tu_dien_nuoc',' (vòi|vòi nước|vòi sen|vòi xịt|sen tắm|ốc vít|ốc|vít|vít nở|tắc kê|bu lông|đinh vít|ổ cắm|ổ điện|phích cắm|công tắc|cầu dao|aptomat|át tô mát|cầu chì|dây điện|dây cáp điện|ống nước|ống nhựa|co nối|cút nối|măng sông|van nước|van khoá|xi phông|ruột gà|đui đèn|máng đèn|lavabo|bồn rửa|bóng đèn|bóng âm trần|đèn led|đèn âm trần|nút nhấn|nút xả|bộ xả|bộ nhấn xả|phễu thoát sàn|phễu chống hôi|keo silicon|silicon|băng keo điện) ',
      ' (voi nuoc|voi sen|voi xit|sen tam|oc vit|vit no|tac ke|bu long|dinh vit|o cam|o dien|phich cam|cau dao|aptomat|cau chi|day dien|ong nuoc|ong nhua|co noi|cut noi|mang song|van nuoc|xi phong|ruot ga|dui den|mang den|lavabo|bon rua|bong den|bong am tran|den led|den am tran|nut nhan|nut xa|bo nhan xa|pheu thoat san|pheu chong hoi|keo silicon|silicon|bang keo dien) ',NULL,NULL,
      jsonb_build_array('thợ','tiền công','nhân công','công thợ','camera','vân tay','khoá cửa','ổ khoá','máy lạnh','máy giặt','thang máy')),
    jsonb_build_array('dung_cu',' (búa|kìm|máy khoan|mũi khoan|thước|cưa|máy cắt|thang nhôm|thang gấp|thang xếp|mỏ lết|cờ lê|bay trát|đồ nghề|khay lăn sơn|con lăn sơn|cọ sơn|giấy nhám|bao tay|găng tay|tua vít|máy bắn vít) ',
      ' (may khoan|mui khoan|may cat|thang nhom|thang gap|thang xep|mo let|co le|bay trat|do nghe|khay lan son|con lan son|co son|giay nham|bao tay|gang tay|tua vit|may ban vit) ',NULL,NULL,
      jsonb_build_array('thang máy')),
    jsonb_build_array('van_phong',' (văn phòng phẩm|giấy in|giấy a4|giấy a 4|bút|bút bi|mực in|mực máy in|ghim bấm|kẹp giấy|bìa hồ sơ|sổ ghi chép|file hồ sơ|máy in) ',
      ' (van phong pham|giay in|giay a4|giay a 4|but bi|muc in|muc may in|ghim bam|kep giay|bia ho so|so ghi chep|file ho so|may in) ',NULL,NULL,
      jsonb_build_array()),
    jsonb_build_array('sua_xay_dung',' (xi măng|gạch ốp|gạch lát|viên gạch|bột trét|keo dán gạch|vữa|sơn tường|sơn nước|sơn chống thấm|thùng sơn|mua sơn) ',
      ' (xi mang|gach op|gach lat|vien gach|bot tret|keo dan gach|son tuong|son nuoc|son chong tham|thung son|mua son) ',NULL,NULL,
      jsonb_build_array()),
    -- Lượt 14 (nghiệm thu vòng 1, 24/10): "mua nệm" vào "Chi khác"; đo 90 ngày production: nệm, giường, tinh dầu, ấm đun, cơm … người lập
    -- chọn "Chi khác" hoặc không ra gợi ý nào.
    jsonb_build_array('bo_rac',' (bỏ nệm|đổ nệm|vứt nệm|bỏ giường|đổ giường|bỏ đồ cũ|đổ đồ cũ|xà bần|đổ rác thêm|đổ rác bổ sung|rác bổ sung|rác phát sinh) ',
      ' (bo nem|do nem|vut nem|bo giuong|do giuong|bo do cu|do do cu|xa ban|do rac them|do rac bo sung|rac bo sung|rac phat sinh) ',NULL,NULL,
      jsonb_build_array('tiền rác','phí rác tháng','thu gom rác')),
    jsonb_build_array('dien_may',' (quạt|quạt trần|quạt treo|quạt đứng|quạt hút|máy lạnh|điều hoà|điều hòa|máy giặt|máy sấy|tủ lạnh|tủ đông|tủ mát|ấm siêu tốc|ấm đun|ấm đun siêu tốc|bình đun|bếp điện|bếp từ|bếp hồng ngoại|lò vi sóng|nồi cơm|nồi cơm điện|tivi|ti vi|bình nóng lạnh|máy nước nóng|bàn là|bàn ủi) ',
      ' (quat tran|quat treo|quat dung|quat hut|may lanh|dieu hoa|may giat|may say|tu lanh|tu dong|tu mat|am sieu toc|am dun|binh dun|bep dien|bep tu|lo vi song|noi com|tivi|binh nong lanh|may nuoc nong|ban ui) ',NULL,NULL,
      jsonb_build_array('sửa','sửa chữa','thợ','tiền công','nhân công','công thợ','gọi thợ','thuê thợ','vệ sinh','bảo trì','bảo dưỡng','bơm gas','nạp gas','gas','tháo','tháo lắp','lắp đặt','xả','ống đồng','remote','điện lạnh','tiền điện','hoá đơn','kiểm tra','bảo hành','kệ tivi')),
    jsonb_build_array('noi_that_decor',' (giường|nệm|đệm|tấm bảo vệ nệm|ga giường|ga trải giường|drap|chăn|mền|gối|tủ|tủ quần áo|tủ áo|tủ giày|tủ đầu giường|kệ|kệ giày|kệ sách|kệ tivi|giá sách|giá treo|móc treo|bàn|bàn ghế|bàn ăn|bàn học|bàn làm việc|ghế|sofa|sô pha|rèm|rèm cửa|màn cửa|gương|thảm|tranh treo|bức tranh|cây cảnh|chậu cây|đèn trang trí|đèn ngủ|tinh dầu|nến thơm|đồ thơm|sáp thơm|decor) ',
      ' (giuong|tam bao ve nem|ga giuong|drap|tu quan ao|tu ao|tu giay|tu dau giuong|ke giay|ke sach|ke tivi|gia sach|gia treo|moc treo|ban ghe|ban an|ban hoc|ban lam viec|sofa|so pha|rem cua|man cua|cay canh|chau cay|den trang tri|den ngu|tinh dau|nen thom|decor) ',NULL,NULL,
      jsonb_build_array('sửa','sửa chữa','thợ','tiền công','nhân công','công thợ','gọi thợ','thuê thợ','tủ lạnh','tủ đông','tủ mát','tủ điện','bàn chải','bàn là','bàn ủi','bàn phím','đổ','bỏ','vứt','rác','dọn','giặt','vệ sinh','vận chuyển','ship','chở','thanh lý','cây lau nhà','camera','vân tay','bản lề')),
    jsonb_build_array('an_uong_phuc_loi',' (cơm|cơm trưa|cơm tối|pizza|trà sữa|cà phê|cafe|bánh mì|bún|phở|lẩu|nước ngọt|ăn trưa|ăn tối|ăn sáng|ăn uống|liên hoan|tiệc|highland|highlands|starbucks|phúc long) ',
      ' (com trua|com toi|pizza|tra sua|ca phe|cafe|banh mi|nuoc ngot|an trua|an toi|an sang|an uong|lien hoan|highland|highlands|starbucks|phuc long) ',NULL,NULL,
      jsonb_build_array('nồi cơm','khách','bảo vệ','xe')));
  c_lex_not CONSTANT text[]:=ARRAY['cọc','hoàn','ứng','tạm ứng','thối','bàn giao','trả lại','chuyển khoản cho'];
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
    -- (3b) Từ vựng (Lượt 11): mục đầu tiên khớp mẫu (và mẫu cần thêm nếu có), không dính loại trừ, có hạng mục dùng được mang rule_key đó.
    -- Câu dòng tiền (c_lex_not) bỏ qua cả lớp này.
    IF v_ref IS NULL AND btrim(v_text)<>'' AND NOT EXISTS(SELECT 1 FROM unnest(c_lex_not) w
        WHERE strpos(a,public.ie_quick_text_v1(w,false))>0 OR (noacc AND strpos(b,public.ie_quick_text_v1(w,true))>0)) THEN
      FOR o IN SELECT e->>0 rk,e->>1 acc,e->>2 bare,e->>3 nacc,e->>4 nbare,e->5 excl FROM jsonb_array_elements(c_lex) WITH ORDINALITY z(e,ord) ORDER BY ord LOOP
        CONTINUE WHEN NOT (a ~ o.acc OR (noacc AND b ~ o.bare));
        CONTINUE WHEN o.nacc IS NOT NULL AND NOT (a ~ o.nacc OR (noacc AND b ~ o.nbare));
        CONTINUE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.excl) w
          WHERE strpos(a,public.ie_quick_text_v1(w,false))>0 OR (noacc AND strpos(b,public.ie_quick_text_v1(w,true))>0));
        SELECT r INTO v_ref FROM jsonb_array_elements(v_rows) r WHERE r->>'rk'=o.rk LIMIT 1;
        IF v_ref IS NOT NULL THEN v_reason:='rule'; EXIT; END IF;
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
        -- Lượt 14: hạng mục "khác" (Chi khác (ghi rõ)) thắng trùng chữ ⇒ không gợi ý ("chi phí …", "ghi chú …" từng ra "Chi khác").
        IF v_top>0 AND v_count=1 AND COALESCE(v_best->>'rk','')<>'chi_khac' AND v_best->>'loose' !~ '^(chi )?khac( |$)' THEN
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

DO $check$
DECLARE v_fn pg_catalog.pg_proc;
BEGIN
  SELECT * INTO v_fn FROM pg_catalog.pg_proc WHERE oid='public.ie_category_suggest_v1(uuid,jsonb,text,boolean)'::regprocedure;
  IF md5(replace(v_fn.prosrc,chr(13),''))<>'3a8638094d6233170d3d1d75a5d62a9c' OR v_fn.prosecdef OR v_fn.provolatile<>'s'
    OR replace(COALESCE(array_to_string(v_fn.proconfig,','),''),'"','')<>'search_path='
    OR NOT has_function_privilege('authenticated','public.ie_category_suggest_v1(uuid,jsonb,text,boolean)','EXECUTE') OR has_function_privilege('anon','public.ie_category_suggest_v1(uuid,jsonb,text,boolean)','EXECUTE')
    OR position('noi_that_decor'',''' IN v_fn.prosrc)=0 OR position('v_best->>''rk'',''''' IN v_fn.prosrc)=0 THEN
    RAISE EXCEPTION 'ie_quick_entry_rules_v3_catalog_invalid'; END IF;
END $check$;
COMMIT;
