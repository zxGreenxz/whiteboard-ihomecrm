-- ============================================================
-- Danh mục chi chuẩn — phần DỮ LIỆU (chủ duyệt 03/10/2026).
-- Chạy SAU …_danh_muc_chi_cau_truc.sql (dùng các cột mới ở đó).
--
-- Dựng danh mục CHI mới cho org iHome (aaaa…0001) và org DEMO (dddd…0001):
--   - mỗi hạng mục mới có `rule_key` cố định; lần chạy lại tìm theo rule_key
--     ⇒ idempotent;
--   - hạng mục mới lấy MỘT hàng cũ làm "gốc" (đổi tên/nhóm/mô tả) để phiếu cũ
--     của hàng đó tự mang tên mới; org không có hàng gốc thì chèn hàng mới;
--   - các hàng cũ còn lại: archived_at + merged_into_id ⇒ ẩn khỏi ô chọn, báo
--     cáo cộng vào mục mới. KHÔNG chuyển dòng phiếu cũ, KHÔNG đổi nhãn KQKD của
--     phiếu cũ (chủ chọn phương án b);
--   - "vệ sinh máy lạnh" / "Vệ sinh máy giặt" GIỮ TÊN, chỉ ẩn khỏi ô chọn tay và
--     trỏ báo cáo về "Điện lạnh": công cụ phí bảo trì ở /thanh-toan
--     (useMaintenanceBatch, get_period_maintenance) nhận diện chúng theo tên;
--   - nhóm "HOA HỒNG" của Hoa hồng môi giới / Thưởng nóng Sale / HHMG GIỮ
--     NGUYÊN: ie_has_commission_item_v1 và isCommissionType nhận phiếu hoa hồng
--     tính lương theo nhóm này (Thưởng nóng Sale chỉ khớp nhờ nhóm);
--   - KHÔNG đổi tên mọi hạng mục mà máy chủ/trang tìm theo tên (Tiền nhà, Đóng
--     tiền điện/nước, Hoa hồng môi giới, Lương quản lý, Chia lợi nhuận cổ đông,
--     Bàn giao tiền mặt, các mục thanh lý/giữ chỗ/bỏ cọc, Tiền thối…);
--   - hạng mục máy tự lập: manual_hidden (ẩn khỏi ô chọn tay), giữ nguyên tên.
-- Đổi nhóm của các mục cố định không làm lệch báo cáo Phân bổ lợi nhuận:
-- fixedExpenseCategories.ts khớp dự phòng theo tên, và tên các mục đó giữ nguyên.
-- ============================================================

DO $$
DECLARE
  -- k: rule_key · g: nhóm (NULL = giữ nhóm cũ) · n: tên mới · d: "dùng cho"
  -- kw: cụm từ hay nói · a: hàng gốc ưu tiên theo thứ tự · m: hàng cũ gộp vào
  -- mh: hàng cũ trỏ báo cáo về nhưng VẪN DÙNG cho công cụ riêng (ẩn ô chọn tay)
  -- hid: manual_hidden · qeh: quick_entry_hidden · it: internal_transfer
  v_spec jsonb := $spec$[
   {"k":"tien_nha","g":"Cố định hằng tháng","n":"Tiền nhà","a":["Tiền nhà"],
    "d":"CHỈ tiền thuê nhà trả cho CHỦ NHÀ hằng tháng, kể cả chuyển khoản hoặc nhờ người khác mang tiền đưa chủ nhà. Không dùng cho tiền phòng trả lại khách",
    "kw":["tiền nhà","thuê nhà","trả chủ nhà","tiền thuê nhà"]},
   {"k":"dien","g":"Cố định hằng tháng","n":"Đóng tiền điện","a":["Đóng tiền điện"],
    "d":"hoá đơn tiền điện của toà (EVN)","kw":["tiền điện","hoá đơn điện","EVN"]},
   {"k":"nuoc","g":"Cố định hằng tháng","n":"Đóng tiền nước","a":["Đóng tiền nước"],
    "d":"hoá đơn tiền nước của toà","kw":["tiền nước","hoá đơn nước","nước máy giặt"]},
   {"k":"internet","g":"Cố định hằng tháng","n":"Đóng tiền internet","a":["Đóng tiền internet"],"m":["Internet"],
    "d":"cước internet, wifi hằng tháng. Mua, lắp, sửa thiết bị wifi thì vào \"Camera, wifi, cửa vân tay\"",
    "kw":["internet","tiền mạng","tiền wifi","FPT","Viettel"]},
   {"k":"rac","g":"Cố định hằng tháng","n":"Tiền rác","a":["Tiền rác"],"m":["Rác"],
    "d":"phí thu gom rác hằng tháng","kw":["tiền rác","phí rác tháng"]},
   {"k":"ve_sinh_dinh_ky","g":"Cố định hằng tháng","n":"Vệ sinh tòa nhà định kỳ","a":["Vệ sinh tòa nhà định kỳ"],"qeh":true,
    "d":"CHỈ khoản khoán cố định hằng tháng theo hợp đồng, lập ở trang Thu chi. Lượt dọn lẻ, bTaskee ⇒ \"Dọn vệ sinh theo lượt\"",
    "kw":["vệ sinh tòa nhà định kỳ","tạp vụ tháng"]},
   {"k":"thang_may","g":"Cố định hằng tháng","n":"Bảo Trì Thang Máy","a":["Bảo Trì Thang Máy"],
    "d":"phí bảo trì thang máy hằng tháng","kw":["bảo trì thang máy"]},
   {"k":"cong_an","g":"Cố định hằng tháng","n":"Tiền công an","a":["Tiền công an"],
    "d":"tiền công an khu vực định kỳ. Làm tạm trú, tiếp dân ⇒ \"Tạm trú, giấy tờ\"","kw":["tiền công an","công an khu vực","CAKV"]},
   {"k":"quan_ly","g":"Cố định hằng tháng","n":"Quản Lý","a":["Quản Lý"],"qeh":true,
    "d":"phí quản lý toà hằng tháng","kw":["phí quản lý","PQL"]},

   {"k":"dien_lanh","g":"Sửa chữa – bảo trì","n":"Điện lạnh","a":[],
    "m":["Sửa Máy Lạnh","Kiểm tra máy lạnh","Tháo Lắp Máy Lạnh","Lắp đặt máy lạnh","Bơm Gas","bảo trì đường ống đồng","bắn foam đường ống đồng","Vệ sinh máy lạnh - Xả Giàn","Sửa máy giặt","Sửa tủ lạnh","thanh toán tiền điện lạnh","Lắp Máy Giặt"],
    "mh":["vệ sinh máy lạnh","Vệ sinh máy giặt"],
    "d":"máy lạnh, máy giặt, tủ lạnh: vệ sinh, sửa, kiểm tra, tháo lắp, bơm gas, ống đồng",
    "kw":["vệ sinh máy lạnh","sửa máy lạnh","bơm gas","xả giàn","tháo lắp máy lạnh","sửa máy giặt","sửa tủ lạnh","thợ điện lạnh"]},
   {"k":"sua_dien","g":"Sửa chữa – bảo trì","n":"Sửa điện","a":["sửa điện"],"m":["thi công điện","Kiểm tra rò rỉ điện"],
    "d":"tiền trả cho THỢ ĐIỆN: sửa điện, đi dây, nẹp dây, gắn/thay bóng đèn và cảm biến, làm lại định mức điện; kể cả tiền cà phê, bồi dưỡng thợ. Quản lý tự mua bóng/ổ điện về thay ⇒ \"Mua đồ điện nước\"",
    "kw":["sửa điện","thợ điện","rò điện","đi dây điện","thay cảm biến"]},
   {"k":"sua_nuoc_may_bom","g":"Sửa chữa – bảo trì","n":"Sửa nước, máy bơm","a":["sửa máy bơm"],
    "m":["thay phao bơm","thông cống","Xử lý Bồn Cầu","vệ sinh bồn nước","Thay lõi lọc nước","khoan giếng"],
    "d":"máy bơm, phao, thông cống, bồn cầu, bồn nước, lõi lọc, giếng",
    "kw":["sửa máy bơm","thay phao","thông cống","nghẹt","bồn cầu rò","vệ sinh bồn nước","lõi lọc"]},
   {"k":"khoa_chia","g":"Sửa chữa – bảo trì","n":"Khoá cơ, chìa khoá","a":["Đánh chìa khóa"],"m":["mở khóa ổ khóa hư","ổ khoá","mua phụ kiện cửa"],
    "d":"đánh chìa, mở/thay ổ khoá, tay nắm cửa thường. Cửa vân tay ⇒ \"Camera, wifi, cửa vân tay\"",
    "kw":["đánh chìa","chìa khoá","mở khoá","thay ổ khoá","tay nắm cửa"]},
   {"k":"sua_xay_dung","g":"Sửa chữa – bảo trì","n":"Sửa chữa xây dựng","a":["Sửa chữa"],"m":["Sơn Trét Tường"],
    "d":"công thợ: sơn, chống thấm, thợ hồ, cửa, kính, bản lề, bồn rửa",
    "kw":["chống thấm","thợ hồ","sửa cửa","trét tường","nhân công"]},
   {"k":"camera_wifi_van_tay","g":"Sửa chữa – bảo trì","n":"Camera, wifi, cửa vân tay","a":[],
    "d":"cả mua mới, lắp đặt và sửa: camera, thẻ nhớ, đầu ghi; modem, cục phát wifi, dây mạng; cửa vân tay, pin/acquy, hộp lưu điện, thẻ từ. Cước internet tháng ⇒ \"Đóng tiền internet\"",
    "kw":["camera","thẻ nhớ camera","cục phát wifi","modem","cửa vân tay","acquy cửa vân tay","hộp lưu điện","thẻ từ"]},

   {"k":"vat_tu_dien_nuoc","g":"Mua sắm","n":"Mua đồ điện nước","a":["Mua đồ điện nước"],
    "d":"quản lý TỰ MUA vật tư lặt vặt, không có công thợ: bóng đèn, ổ điện, dây sen, ống nước, nắp bồn cầu, remote, keo, băng keo, silicon, nam châm cửa; \"mua vật tư\" ghi chung chung cũng vào đây",
    "kw":["bóng đèn","đèn led","ổ điện","dây sen","củ sen","ống cấp nước","nắp bồn cầu","remote","silicon"]},
   {"k":"dien_may","g":"Mua sắm","n":"Mua đồ điện máy","a":["Mua máy lạnh"],"m":["mua máy giặt","Mua tủ lạnh"],
    "d":"máy lạnh, máy giặt, tủ lạnh, quạt các loại (quạt treo, quạt hút), ấm siêu tốc, bếp điện",
    "kw":["mua máy lạnh","mua máy giặt","mua tủ lạnh","quạt treo tường","ấm siêu tốc"]},
   {"k":"noi_that_decor","g":"Mua sắm","n":"Nội thất, decor","a":["Nội Thất"],"m":["đồ decor"],
    "d":"bàn ghế, tủ, giường, nệm, rèm, cây, đồ trang trí, tinh dầu, đồ thơm, túi/kệ đựng đồ decor",
    "kw":["nội thất","bàn ghế","rèm","decor","cây cảnh"]},
   {"k":"dung_cu","g":"Mua sắm","n":"Dụng cụ, đồ nghề","a":[],
    "d":"thang, máy khoan/bắn vít, tua vít, khay lăn sơn, cọ, giấy nhám, bao tay",
    "kw":["thang xếp","máy bắn vít","tua vít","dụng cụ","bao tay"]},

   {"k":"don_ve_sinh","g":"Vệ sinh phát sinh","n":"Dọn vệ sinh theo lượt","a":["BTaskee"],"m":["Vệ Sinh Phòng"],
    "d":"MỌI khoản vệ sinh, dọn dẹp: bTaskee, người dọn theo giờ, dọn phòng trống/trả phòng, dọn toà nhà, lau hành lang, giặt rèm",
    "kw":["bTaskee","dọn phòng","vệ sinh phòng","lau hành lang","giặt rèm"]},
   {"k":"bo_rac","g":"Vệ sinh phát sinh","n":"Bỏ rác phát sinh","a":["Bỏ rác"],"m":["Rửa thùng rác"],
    "d":"xà bần, nệm cũ, đổ rác thêm, rửa thùng rác","kw":["bỏ rác","đổ rác thêm","xà bần","đổ nệm cũ"]},
   {"k":"diet_con_trung","g":"Vệ sinh phát sinh","n":"Diệt côn trùng, hoá chất","a":[],
    "d":"xịt/thuốc gián, chặn côn trùng, gel thông cống","kw":["xịt gián","thuốc diệt gián","côn trùng","gel thông cống"]},

   {"k":"tam_tru_giay_to","g":"Hành chính – pháp lý","n":"Tạm trú, giấy tờ","a":["Làm tạm trú"],"m":["Tạm trú"],
    "d":"đăng ký tạm trú, tiếp dân, người nước ngoài, giấy phép kinh doanh",
    "kw":["tạm trú","tiếp dân","người nước ngoài","giấy phép kinh doanh"]},
   {"k":"pccc","g":"Hành chính – pháp lý","n":"PCCC","a":["PCCC"],"m":["Mua dụng cụ PCCC"],
    "d":"thiết bị, hồ sơ, kiểm tra, bảo hiểm cháy nổ, thang thoát hiểm",
    "kw":["PCCC","bình chữa cháy","dây thoát hiểm","thang thoát hiểm","bảo hiểm cháy nổ"]},
   {"k":"in_an_decal","g":"Hành chính – pháp lý","n":"In ấn, decal","a":["in decal","photocopy","Dán decal"],
    "d":"in decal, photo, in bảng/biển","kw":["in decal","photo","in bảng"]},
   {"k":"van_chuyen","g":"Hành chính – pháp lý","n":"Vận chuyển, giao hàng","a":["Giao Hàng","Phí Vận Chuyển"],
    "d":"ship, giao hàng, Lalamove, Grab, xe chở đồ","kw":["ship","giao hàng","Lalamove","Grab","vận chuyển"]},
   {"k":"van_phong","g":"Hành chính – pháp lý","n":"Văn phòng, phần mềm","a":["văn phòng"],
    "d":"nước uống văn phòng, văn phòng phẩm, Zalo/phần mềm","kw":["văn phòng","nước uống","Zalo Business","phần mềm"]},

   {"k":"bo_sung_hoan_coc","g":"Trả lại khách","n":"Bổ sung hoàn cọc","a":["Bổ sung hoàn cọc"],
    "d":"hoàn thêm tiền cọc cho khách ngoài phiếu thanh lý","kw":["hoàn cọc","trả cọc","bổ sung hoàn cọc"]},
   {"k":"tra_tien_thua_khach","g":"Trả lại khách","n":"Trả lại tiền thừa cho khách","a":["thối tiền","hoàn lại tiền thừa khách đóng dư"],
    "d":"trả lại tiền cho KHÁCH THUÊ: thối tiền, khách đóng dư, hoàn tiền phòng những ngày không ở (vd \"tiền phòng 5 ngày\"). Trả cọc ⇒ \"Bổ sung hoàn cọc\"",
    "kw":["thối tiền","khách đóng dư","trả lại tiền thừa","hoàn tiền phòng"]},

   {"k":"hoa_hong_moi_gioi","g":null,"n":"Hoa hồng môi giới","a":["Hoa hồng môi giới"],"hid":true,"qeh":true,
    "d":"tạo từ hợp đồng (popup sau ký, nút \"Tạo phiếu hoa hồng\", \"Tạo lại\"); không lập tay","kw":[]},
   {"k":"hhmg","g":null,"n":"HHMG","a":["HHMG"],"qeh":true,
    "d":"hoa hồng môi giới ngoài luồng hợp đồng — chỉ chủ công ty","kw":[]},
   {"k":"thuong_nong_sale","g":null,"n":"Thưởng nóng Sale","a":["Thưởng nóng Sale"],"hid":true,"qeh":true,
    "d":"tạo từ form cọc hoặc hợp đồng; không lập tay","kw":[]},
   {"k":"luong_quan_ly","g":"Nhân sự – sale","n":"Lương quản lý","a":["Lương quản lý"],"m":["Tiền Lương"],"qeh":true,
    "d":"lương quản lý, chi qua bảng lương","kw":[]},
   {"k":"ung_luong","g":"Nhân sự – sale","n":"Ứng lương quản lý","a":["Ứng lương quản lý"],"qeh":true,"d":"tạm ứng lương","kw":[]},
   {"k":"luong_dieu_hanh","g":"Nhân sự – sale","n":"Lương điều hành","a":["Lương điều hành"],"qeh":true,"d":"lương điều hành","kw":[]},
   {"k":"chia_loi_nhuan","g":"Nhân sự – sale","n":"Chia lợi nhuận cổ đông","a":["Chia lợi nhuận cổ đông"],"qeh":true,"it":true,
    "d":"chia lợi nhuận cho cổ đông — tiền nội bộ, không tính KQKD","kw":[]},
   {"k":"an_uong_phuc_loi","g":"Nhân sự – sale","n":"Ăn uống, phúc lợi","a":["Ăn Uống"],"m":["Tiền tour","Khách sạn","Tiền xe đi chơi","đi chơi"],
    "d":"cơm, nước, cà phê, trà sữa, liên hoan mua cho người trong team; du lịch công ty: vé xe, khách sạn, tour, vé tham quan, ăn uống, mua sắm siêu thị trong chuyến đi",
    "kw":["ăn trưa","liên hoan","du lịch","khách sạn","pizza"]},

   {"k":"noi_bo","g":"Tiền nội bộ","n":"Chuyển tiền nội bộ","a":["bàn giao tiền anh Tâm","bàn giao tiền anh Huy"],
    "m":["Kết tiền chi resident","Chuyen tien A.Giang"],"it":true,
    "d":"tiền nội bộ, không phải chi phí: chủ/sếp lấy tiền, bàn giao tiền, ứng tiền cho người trong công ty, chi dùm khoản riêng của người khác, kết sổ quỹ. Đóng tiền nhà cho chủ nhà KHÔNG thuộc mục này",
    "kw":["bàn giao tiền","ứng tiền cho","chi hộ","kết sổ quỹ"]},
   {"k":"chi_khac","g":"Khác","n":"Chi khác (ghi rõ)","a":["Thu chi khác"],
    "d":"chỉ dùng khi không mục nào hợp; bắt buộc ghi rõ nội dung","kw":[]}
  ]$spec$;
  -- Hạng mục máy tự lập: giữ tên, ẩn khỏi ô chọn tay.
  v_he_thong text[] := ARRAY['Cấn cọc chuyển doanh thu','Hoàn cọc thanh lý','Hoàn tiền phòng thanh lý',
    'Hoàn tiền thừa thanh lý','Hoàn cọc giữ chỗ','Cấn công nợ vào cọc','Hoàn trả thanh lý',
    'Hoàn cọc / tiền thừa khi thanh lý','Hoàn tác thu tiền','Tiền thối','Bàn giao tiền mặt',
    'Cấn cọc giữ chỗ chuyển doanh thu','Hoàn tiền cọc'];
  v_orgs uuid[] := ARRAY['aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001']::uuid[];
  v_org uuid;
  v_e jsonb;
  v_i int;
  v_id uuid;
  v_user uuid;
  v_ten text;
  v_tens text[];
BEGIN
  FOREACH v_org IN ARRAY v_orgs LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org);
    -- user_id (NOT NULL, chỉ để audit): người đã tạo hạng mục chi lâu nhất của org.
    SELECT t.user_id INTO v_user FROM public.income_expense_types t
     WHERE t.organization_id = v_org ORDER BY t.created_at, t.id LIMIT 1;
    CONTINUE WHEN v_user IS NULL;

    FOR v_i IN 0 .. jsonb_array_length(v_spec) - 1 LOOP
      v_e := v_spec -> v_i;
      v_id := NULL;

      -- (1) đã chạy rồi: tìm theo rule_key
      SELECT t.id INTO v_id FROM public.income_expense_types t
       WHERE t.organization_id = v_org AND t.rule_key = v_e ->> 'k';

      -- (2) hàng gốc theo thứ tự ưu tiên (chưa gắn rule_key khác)
      IF v_id IS NULL THEN
        FOR v_ten IN SELECT jsonb_array_elements_text(coalesce(v_e -> 'a', '[]'::jsonb)) LOOP
          SELECT t.id INTO v_id FROM public.income_expense_types t
           WHERE t.organization_id = v_org AND lower(btrim(t.type)) = 'expense'
             AND t.rule_key IS NULL
             AND public.normalize_income_expense_type_name(btrim(t.name))
               = public.normalize_income_expense_type_name(btrim(v_ten))
           ORDER BY t.created_at, t.id LIMIT 1;
          EXIT WHEN v_id IS NOT NULL;
        END LOOP;
      END IF;

      -- (3) org chưa có ⇒ dùng hàng trùng tên mới (nếu có) hoặc chèn hàng mới
      IF v_id IS NULL THEN
        SELECT t.id INTO v_id FROM public.income_expense_types t
         WHERE t.organization_id = v_org AND lower(btrim(t.type)) = 'expense' AND t.rule_key IS NULL
           AND public.normalize_income_expense_type_name(btrim(t.name))
             = public.normalize_income_expense_type_name(v_e ->> 'n')
         LIMIT 1;
      END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.income_expense_types (name, type, category, description, user_id, organization_id)
        VALUES (v_e ->> 'n', 'expense', v_e ->> 'g', v_e ->> 'd', v_user, v_org)
        RETURNING id INTO v_id;
      END IF;

      -- (4) gắn thông tin mục mới. Đổi tên chỉ khi không đụng tên hàng khác.
      UPDATE public.income_expense_types t SET
        name = CASE WHEN NOT EXISTS (
                   SELECT 1 FROM public.income_expense_types x
                    WHERE x.organization_id = v_org AND x.id <> t.id
                      AND lower(btrim(x.type)) = lower(btrim(t.type))
                      AND public.normalize_income_expense_type_name(btrim(x.name))
                        = public.normalize_income_expense_type_name(v_e ->> 'n'))
                 THEN v_e ->> 'n' ELSE t.name END,
        category           = CASE WHEN jsonb_typeof(v_e -> 'g') = 'string' THEN v_e ->> 'g' ELSE t.category END,
        description        = v_e ->> 'd',
        keywords           = ARRAY(SELECT jsonb_array_elements_text(coalesce(v_e -> 'kw', '[]'::jsonb))),
        sort_order         = (v_i + 1) * 10,
        rule_key           = v_e ->> 'k',
        manual_hidden      = coalesce((v_e ->> 'hid')::boolean, false),
        quick_entry_hidden = coalesce((v_e ->> 'qeh')::boolean, false),
        internal_transfer  = coalesce((v_e ->> 'it')::boolean, false),
        archived_at        = NULL,
        merged_into_id     = NULL,
        updated_at         = now()
      WHERE t.id = v_id;

      -- (5) hàng cũ gộp vào: lưu trữ + trỏ báo cáo (gồm các hàng gốc không được chọn)
      v_tens := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_e -> 'a', '[]'::jsonb)))
             || ARRAY(SELECT jsonb_array_elements_text(coalesce(v_e -> 'm', '[]'::jsonb)));
      UPDATE public.income_expense_types t SET
        archived_at    = coalesce(t.archived_at, now()),
        merged_into_id = v_id,
        updated_at     = now()
      WHERE t.organization_id = v_org AND t.id <> v_id AND lower(btrim(t.type)) = 'expense'
        AND t.rule_key IS NULL AND t.system_only IS NOT TRUE
        AND public.normalize_income_expense_type_name(btrim(t.name)) IN (
              SELECT public.normalize_income_expense_type_name(btrim(x)) FROM unnest(v_tens) x);

      -- (6) hàng cũ vẫn dùng cho công cụ riêng: ẩn ô chọn tay + trỏ báo cáo, KHÔNG lưu trữ
      UPDATE public.income_expense_types t SET
        manual_hidden  = true,
        merged_into_id = v_id,
        updated_at     = now()
      WHERE t.organization_id = v_org AND t.id <> v_id AND lower(btrim(t.type)) = 'expense'
        AND t.rule_key IS NULL
        AND public.normalize_income_expense_type_name(btrim(t.name)) IN (
              SELECT public.normalize_income_expense_type_name(btrim(x))
                FROM jsonb_array_elements_text(coalesce(v_e -> 'mh', '[]'::jsonb)) x);
    END LOOP;

    -- (7) hạng mục máy tự lập: ẩn khỏi ô chọn tay
    UPDATE public.income_expense_types t SET manual_hidden = true, updated_at = now()
     WHERE t.organization_id = v_org AND lower(btrim(t.type)) = 'expense'
       AND t.manual_hidden IS NOT TRUE
       AND (t.system_only
            OR public.normalize_income_expense_type_name(btrim(t.name)) IN (
                 SELECT public.normalize_income_expense_type_name(x) FROM unnest(v_he_thong) x));
  END LOOP;
END $$;

-- ---------- Kiểm (chạy được trên DB rỗng: chỉ kiểm khi org iHome tồn tại) ----------
DO $$
DECLARE
  v_org constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_so int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.income_expense_types WHERE organization_id = v_org) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_so FROM public.income_expense_types
   WHERE organization_id = v_org AND rule_key IS NOT NULL;
  IF v_so <> 39 THEN
    RAISE EXCEPTION 'danh_muc_chi_du_lieu: org iHome có % hạng mục mang rule_key, cần 39', v_so;
  END IF;
  -- Ô chọn tay của quản lý: đúng 31 mục (không lưu trữ, không ẩn, không hạn chế, không hệ thống).
  SELECT count(*) INTO v_so FROM public.income_expense_types
   WHERE organization_id = v_org AND lower(btrim(type)) = 'expense'
     AND archived_at IS NULL AND NOT manual_hidden AND NOT system_only AND NOT is_restricted;
  IF v_so <> 31 THEN
    RAISE EXCEPTION 'danh_muc_chi_du_lieu: ô chọn của quản lý có % hạng mục chi, cần 31', v_so;
  END IF;
  -- Tên máy chủ tìm theo tên vẫn còn nguyên.
  IF (SELECT count(*) FROM public.income_expense_types
       WHERE organization_id = v_org AND lower(btrim(type)) = 'expense'
         AND name IN ('Tiền nhà','Đóng tiền điện','Đóng tiền nước','Hoa hồng môi giới','Thưởng nóng Sale',
                      'Lương quản lý','Chia lợi nhuận cổ đông','Bàn giao tiền mặt','vệ sinh máy lạnh')) <> 9 THEN
    RAISE EXCEPTION 'danh_muc_chi_du_lieu: mất tên hạng mục mà máy chủ tìm theo tên';
  END IF;
  -- Nhóm HOA HỒNG giữ nguyên (nhận diện phiếu hoa hồng tính lương).
  IF EXISTS (SELECT 1 FROM public.income_expense_types
              WHERE organization_id = v_org AND name IN ('Hoa hồng môi giới','Thưởng nóng Sale','HHMG')
                AND upper(coalesce(category, '')) <> 'HOA HỒNG') THEN
    RAISE EXCEPTION 'danh_muc_chi_du_lieu: nhóm HOA HỒNG bị đổi';
  END IF;
END $$;
