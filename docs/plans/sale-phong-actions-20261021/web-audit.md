# Rà soát giao diện Sale Phòng và kế hoạch hoàn thiện thao tác

Ngày đánh giá: 21/10/2026. Mã nguồn: `c095d427e`. Phạm vi gồm quản trị `/sale-phong`, trang chia sẻ `/r/:token`, đăng và cập nhật phòng, ảnh, thông tin liên hệ, chính sách, phòng pass, sơ đồ và thống kê. Cọc và lock được phân tích riêng trong cùng đợt.

Web đã có phần lớn thao tác cơ bản. Cần làm chắc quyền ghi, xử lý xung đột, giữ bản nháp và trạng thái công bố trước khi mở rộng Hermes. Có một lỗi quyền đã tái hiện bằng PostgreSQL chạy cục bộ với dữ liệu tổng hợp: RPC sửa phòng pass chỉ kiểm quyền phòng đích nhưng có thể ghi đè listing cũ ngoài phạm vi của nhân viên. Thân hàm này đã được đối chiếu khớp catalog production chỉ đọc; chưa thử qua JWT/PostgREST hoặc xác minh toàn bộ helper, trigger và ACL đang triển khai.

## Chức năng đang có

| Nhóm | Hành vi hiện có trong source | Phần cần hoàn thiện |
|---|---|---|
| Link chia sẻ | Tạo ngẫu nhiên, đặt/đổi nhãn, copy, mở, thu hồi, khôi phục, xóa; biên nhận ghi và chặn thử lại khi kết quả không rõ | Chưa có TTL, giới hạn theo tòa/phòng, kênh, đối tượng xem hay chu kỳ phát hành. Quyền UI có thể cấp cho nhân viên nhưng dữ liệu token/settings vẫn theo `auth.uid()` của owner |
| Danh sách public | Lọc quận, tòa, dải giá; tổng hợp/danh sách/sơ đồ; ảnh và chi tiết phòng; lưu yêu thích; gọi/Zalo; copy nội dung; xuất ảnh bảng | Chưa có quy trình nháp → duyệt → công bố; chưa có lịch sử lần xác nhận thông tin phòng. Export hiện chủ ý lấy toàn bộ phòng còn chào, không theo bộ lọc màn hình |
| Tình trạng bán | Reader tính `READY`, `NOTICE`, `NOTICE_OVERDUE`, `PREPARING`, `RENTED`, `PASS`; polling 5 giây khi mở, backoff lỗi; chi tiết đang mở cập nhật theo dữ liệu mới | Cần đồng nhất lời giải thích “sắp trống”, và hiển thị rõ lần cập nhật thành công gần nhất. Không được dùng ghi chú tay để thay sự thật hợp đồng/cọc/lock |
| Bảng chỉnh như Excel | Hotline chung, SĐT tòa, chính sách chung và từng phòng, giá, diện tích/loại phòng, nội thất, ghi chú tình trạng; xem trước ảnh; lỗi từng ô; lưu từng phần có nhận diện ô đã lưu | Ghi nhiều entity chưa atomic. Cần preflight toàn bộ trước ghi, phiên bản dữ liệu, chống ghi đè và kết quả chi tiết từng mục |
| Thông tin sale | Ảnh tòa, SĐT/tên liên hệ, ảnh phòng, nội thất; sắp xếp ảnh, chọn bìa, gỡ ảnh, đồng bộ ảnh cùng mẫu trong một tòa | Chưa có bản nháp bền vững, kiểm xung đột ảnh, lịch sử/nguồn ảnh, quyền theo trường. Upload và lưu metadata cần cùng quy trình rõ ràng |
| Pass | Tạo/sửa, giá riêng, ngày dự kiến, chính sách riêng, chọn khách đang thuê, liên hệ khách hoặc quản lý, ẩn/hiện/xóa; một listing active/phòng | Lỗi quyền ở upsert; chưa ràng listing với kỳ hợp đồng; chưa có trạng thái yêu cầu/duyệt/hoàn tất; cần phân biệt pass và báo trả thực tế |
| Chính sách | `sale_note` cho khách, `sale_bonus_note` chỉ nội bộ, `pass_sale_policy` của khách, `public_room_settings.sale_policy` chung | Đang là văn bản tự do; chưa có hiệu lực theo ngày, phạm vi, thứ tự ưu tiên, điều kiện cộng dồn, duyệt hay snapshot lúc chốt cọc |
| Sơ đồ | Kéo/thay kích thước phòng/hành lang/thang, tự sắp xếp, hoàn tác, lưu theo tòa | Ghi cả JSON từ snapshot, chưa có revision/conflict; thiếu cảnh báo bản nháp, trạng thái lỗi tải và test luồng editor |
| Thống kê | Tổng quan, phòng xem nhiều, thời gian, theo token, phễu, nhóm lỗi; lọc ngày/tòa/token và loại trừ nội bộ | Chưa nối thành phễu nghiệp vụ lead → hẹn xem → giữ chỗ → cọc → hợp đồng; không được suy số hợp đồng từ số click |
| Điện thoại | Màn danh sách nhúng và sáu mục quản trị với các component riêng | Có nhiều logic ghi trùng desktop/mobile; cần service/hook chung để Hermes và hai giao diện cùng dùng một contract |

Nguồn chính: `src/pages/sale-phong/SalePhongPage.tsx`, `SalePhongMobilePage.tsx`, `src/components/sale-phong/*`, `src/pages/phong-trong/*`, `src/hooks/usePublicRoomTokens.ts`, `usePublicRoomSettings.ts`, `usePassListings.ts`, `useSaveRoomListSheet.ts`, `usePublicRoomsAnalytics.ts`.

## Phát hiện cần xử lý

### W1 Quyền sửa phòng pass chưa kiểm listing nguồn

Mức ưu tiên P1, đã tái hiện cục bộ. Hàm hiện hành lấy owner/tòa từ `p_room_id`, kiểm quyền tòa đó, sau đó `UPDATE ... WHERE id = p_id` không kiểm quyền listing cũ và không yêu cầu listing cũ thuộc phòng đích. Nhân viên có quyền tòa A nhưng không có quyền tòa B có thể gửi ID listing B và room A để chuyển/ghi đè listing B.

Nguồn: `supabase/migrations/20260629100000_room_pass_listings_contact_manager.sql:48`, `:59`, `:79`, `:91`; baseline cùng thân hàm tại `supabase/baseline/schema.sql:96019`. Đây không phải suy luận từ màn hình.

Đã chạy `node docs/plans/sale-phong-actions-20261021/proofs/pass-listing-scope.mjs`. Kết quả `BUG_REPRODUCED`; ba đối chứng đều đạt: không đọc được listing B, UPDATE trực tiếp bị RLS chặn, RPC đích B bị từ chối. Gọi RPC với listing B + room A vẫn đổi dòng. Đã nạp đúng thân hàm upsert, `can_manage_pass_listing`, hai trigger org; các primitive danh tính/phạm vi là fixture. Hai tòa cùng org nên khóa đổi `organization_id` không giúp.

Biên bản: [Kết quả tái hiện](proofs/pass-listing-scope-result.json), [chương trình tái hiện](proofs/pass-listing-scope.mjs).

Đối chiếu catalog production đã xác nhận body `upsert_room_pass_listing` khớp chính xác migration sau chuẩn hóa CRLF thành LF, MD5 `1b7a83356e653781972a79c0e585704b`; metadata ghi nhận `SECURITY DEFINER`. Ba hàm cọc/giữ chỗ trong cùng bản đọc catalog cũng khớp migration tương ứng. Xem [đối chiếu bốn thân hàm](evidence/live-function-comparison.md). Đây là xác minh catalog body, không phải thử ghi hoặc thử vượt quyền production.

Tiêu chí sửa: khóa/đọc listing hiện có, kiểm cả nguồn và đích hoặc cấm đổi room trong thao tác sửa; đối chiếu org/tòa/phòng và revision ngay trong transaction. Có ca âm actor tòa A, tòa B, khác org, listing không tồn tại, listing chuyển tòa và hai cập nhật đồng thời. Triển khai bằng migration forward và draft PR theo Contract.

### W2 Lời giải thích sắp trống trái sự thật nghiệp vụ

Mức P2, xác định từ source. `DisplaySettingsTab.tsx:35` nói hợp đồng sắp hết hạn sẽ thành “Sắp trống”, nhưng test `src/lib/__tests__/roomSaleMigration.test.ts:124` và fact hiện hành chủ ý không coi hết hạn hợp đồng là xác nhận phòng trống. Chủ trọ có thể điều chỉnh số ngày rồi kỳ vọng sai.

Cần đổi mô tả theo báo trả/xác nhận và trạng thái chuẩn bị thực tế; thêm ví dụ ngày chưa xác định, quá ngày hẹn trả, đã gia hạn và còn người ở. Không thay logic fact để khớp lời giải thích cũ.

### W3 Công tắc hiển thị phòng đã thuê chưa có tác dụng

Đây là chức năng chưa hoàn thiện, không phải lỗi backend đã chứng minh. `DisplaySettingsTab.tsx:45` nói cấu hình chỉ được lưu cho lần cập nhật sau. Public reader không trả `show_rented` cho adapter; `PhongTrongPage.tsx:51` dùng `showRented=false` cho danh sách, sơ đồ vẫn cần phòng đã thuê để giữ hình tầng.

Cần chốt semantics riêng cho danh sách và sơ đồ. Nếu chưa làm, vô hiệu hóa/ẩn công tắc để chủ trọ không hiểu đã áp dụng. Test ảnh trước/sau trên cùng fixture khi hiện thực.

### W4 Bản nháp ảnh và liên hệ có thể bị dữ liệu đọc mới thay thế

Mức P2, bằng chứng source; chưa chạy tái hiện UI riêng. `SaleImagesTab.tsx:80` cập nhật toàn bộ `amenities/images/similarIds` khi object phòng đổi; guard chỉ giữ bản nháp sau lỗi lưu. `:267` tương tự với liên hệ/ảnh tòa. Mobile lặp lại tại `MobileSaleInfo.tsx:38` và `:54`. Dữ liệu có thể đổi qua invalidation/reconnect hoặc một người khác sửa. Giao diện chưa phân biệt “bản nháp đang sửa” với “dữ liệu mới từ máy chủ”.

Cần dirty tracking theo entity, bản nháp cục bộ, cảnh báo rời phòng/tòa; khi dữ liệu mới về giữ nội dung đang nhập và thông báo cần đối chiếu. Kết quả tải giống hệt không nhất thiết gây lỗi vì query có thể giữ identity; test phải thay một giá trị thật trong row để chứng minh.

### W5 Ghi nhiều mục và sơ đồ chưa chống ghi đè đồng thời

Mức P2 cho vận hành nhiều người, source-level. Ảnh phòng ghi phòng chính rồi nhóm tương tự, không có expected revision (`SaleImagesTab.tsx:137`, `:143`); có thông báo ghi một phần nên không được báo đây là lỗi “luôn thành công giả”. Bảng phòng ghi tuần tự theo tòa/phòng (`useSaveRoomListSheet.ts:60` trở đi). Sơ đồ ghi nguyên `floor_layouts` từ snapshot (`FloorPlanEditorTab.tsx:54`, `:133`) nên A sửa tầng 1 rồi B lưu snapshot cũ tầng 2 có thể làm mất sửa của A.

Cần thao tác theo trường/tầng với expected revision, hoặc transaction có khóa và so version. Đồng bộ ảnh cần preview mục tiêu, chính sách thay/ghép rõ ràng và biên nhận từng phòng; không được retry toàn bộ theo cách ghi đè kết quả mới của người khác.

### W6 Link và cài đặt dùng owner khác với quyền ủy quyền trên UI

Cần quyết định nghiệp vụ trước khi mở rộng cho nhân viên/Hermes. Các tab kiểm `sale_phong.manage_tokens/manage_settings`, nhưng RPC tạo token gán `owner_id=auth.uid()` (`20260607090300_create_public_room_token_rpc.sql:17`), settings cũng upsert actor (`usePublicRoomSettings.ts:21`). Public reader lấy các tòa theo owner token (`20261010022101_public_room_sale_policy.sql:44`, `:86`). Staff được giao tòa của owner không đồng nghĩa sở hữu tòa.

Phải chọn: chức năng này chỉ owner sử dụng, hoặc hỗ trợ đại diện owner với scope rõ ràng. Không tự sửa token sang owner suy đoán theo “staff assignment đầu tiên”. Test actor nhiều tổ chức/nhiều owner là bắt buộc khi chọn cơ chế ủy quyền.

### W7 Đồng ý công khai liên hệ khách chưa là một trạng thái dữ liệu

Đây là khoảng trống sản phẩm/quyền riêng tư. Form tự điền tên/SĐT khách đại diện (`PassListingsTab.tsx:85`) và mặc định `contactManager=false` (`:55`); có công tắc “Liên hệ quản lý” che tên/số tại SQL public. Chưa có trường ghi nhận sự đồng ý công khai, người xác nhận và thời điểm.

Đề xuất mặc định liên hệ quản lý cho yêu cầu mới; muốn công khai số khách phải xác nhận đối tượng/số/nguồn cho phép. Khi thay khách hoặc đổi hợp đồng, không tự tái sử dụng sự đồng ý cũ. Kiểm cả JSON RPC, UI, ảnh export và nội dung copy.

## Ma trận yêu cầu chủ trọ

Các hàng dưới là bộ kịch bản cần chốt và hiện thực, không khẳng định mọi chủ trọ đều cần ngay. Cọc/lock chi tiết được ghép từ nhánh kiểm tiền. Không hệ thống nào có thể liệt kê trước mọi câu nói tự do; coverage cần theo intent, đối tượng, trạng thái, quyền và lỗi.

| Mã | Yêu cầu điển hình | Điều kiện và kết quả phải bảo đảm |
|---|---|---|
| W01 | Đăng phòng trống ngay hôm nay | Có đúng phòng/tòa; fact cho phép; đủ thông tin bắt buộc; xem trước nội dung public |
| W02 | Đăng phòng sắp trả ngày X | Ngày dựa trên báo trả đã ghi nhận; không suy từ ngày hết hạn hợp đồng |
| W03 | Phòng đã trả nhưng đang dọn/sửa | Hiện “đang chuẩn bị”, ngày dự kiến hoặc chưa xác định; không quảng cáo “vào ở ngay” |
| W04 | Dời ngày trống từ X sang Y | Đồng bộ web, Hermes, ảnh xuất và chi tiết đang mở; dữ liệu cũ có thể cache phải có dấu thời gian |
| W05 | Khách hủy trả/gia hạn tiếp | Gỡ chào phù hợp; giữ lịch sử; xử lý hẹn xem/giữ chỗ đã phát sinh |
| W06 | Tạm ẩn phòng dù đang trống | Có lý do/phạm vi/thời hạn; phân biệt ẩn tin với lock phòng và bảo trì |
| W07 | Hiện lại phòng bị ẩn | Kiểm fact mới và quyền, không khôi phục trạng thái cũ bất chấp hợp đồng/cọc mới |
| W08 | Đăng hàng loạt một tầng/tòa | Preview số phòng, loại trừ phòng không hợp lệ, kết quả riêng từng phòng và undo hợp lệ |
| W09 | Đăng tất cả trừ danh sách X | Xác nhận tập mục tiêu cụ thể; không hiểu “tất cả” vượt org/tòa được phép |
| W10 | Thêm phòng chưa có trên hệ thống | Tạo phòng qua quy trình gốc rồi công bố; kiểm trùng tên/mã trong tòa, tầng/diện tích/giá |
| W11 | Hai tòa đều có phòng 101 | Bắt buộc xác định tòa; Hermes hỏi đúng một câu hoặc cho chọn, không tự đoán |
| W12 | Sửa giá từ 4,5 triệu thành 4,7 triệu | Chuẩn hóa tiền; không dùng floating point cho sổ tiền; nói rõ giá niêm yết và giá hợp đồng hiện hữu |
| W13 | Giá mới áp dụng tuần sau | Effective date và timezone tổ chức; lịch sử giá và snapshot cho khách đã chốt |
| W14 | Sửa diện tích/loại phòng/nội thất | Validate đơn vị, số âm/rỗng; chỉ đổi trường yêu cầu; không vô tình xóa trường khác |
| W15 | Đổi phí điện/nước/xe/dịch vụ | Chỉ rõ phí niêm yết hoặc cấu hình thu phí; không dùng sale-note thay quy trình tính tiền |
| W16 | Phòng chỉ cho nhóm khách nhất định | Trường điều kiện ở được cấu trúc, diễn đạt hợp lệ; ảnh/copy/web cùng nội dung |
| W17 | Đổi địa chỉ, bản đồ, thang máy | Sửa nguồn tòa đúng; preview liên kết; xử lý địa chỉ cũ/không tìm thấy |
| W18 | Thêm ảnh phòng mới | Kiểm file, kích thước, đúng phòng; kết quả upload chưa đồng nghĩa metadata đã lưu |
| W19 | Đặt ảnh bìa/đổi thứ tự | Thứ tự giống desktop/mobile/public và export có ảnh; không mất ảnh khi refetch |
| W20 | Xóa ảnh nhầm | Xác nhận gỡ liên kết; không xóa vật lý khi phòng khác còn dùng; lịch sử/khôi phục phù hợp |
| W21 | Dùng ảnh mẫu cho 10 phòng tương tự | Xác định nguồn, danh sách đích, thay hay ghép; phòng đã có ảnh cần quyết định rõ |
| W22 | Upload 8 ảnh, 2 ảnh lỗi | Giữ 6 thành công, retry đúng 2 lỗi, không upload trùng hoặc báo tất cả đã lưu |
| W23 | Ảnh có người/số điện thoại/giấy tờ | Preview và xác nhận ảnh public; không tự đưa tài liệu nội bộ vào bucket sale |
| W24 | Thay ảnh trong lúc người khác sửa | CAS/revision; cho chọn giữ bản nháp hoặc nạp bản mới; không silent overwrite |
| W25 | Khách đang thuê nhờ pass | Tạo overlay đúng hợp đồng/khách; không tự kết thúc hợp đồng hay đổi trạng thái kế toán |
| W26 | Pass giá khác giá niêm yết | Hiển thị rõ override và fallback; giá âm/không hữu hạn bị từ chối ở server |
| W27 | Khách không muốn công khai số | Chỉ liên hệ quản lý; số/name không xuất hiện ở public JSON/ảnh/copy/tracking |
| W28 | Khách muốn công khai số riêng | Ghi nhận sự đồng ý và phạm vi; có thể thu hồi; thay số cần cập nhật lại |
| W29 | Có nhiều người thuê trong phòng | Chọn đúng người đại diện hoặc người ủy quyền; mobile phải có parity lựa chọn |
| W30 | Khách dừng pass hoặc đã tìm được người | Tạm ẩn hoặc đóng listing với lý do; giữ lịch sử; không xóa hợp đồng |
| W31 | Khách chuyển phòng, đổi phòng pass | Không chuyển listing bằng sửa ID lỏng; kiểm quyền nguồn/đích; có lịch sử liên kết |
| W32 | Hai sale cùng tạo pass một phòng | Một active listing; xung đột được giải thích, không âm thầm ghi đè dữ liệu bên kia |
| W33 | Hợp đồng cũ chấm dứt, khách mới vào | Không để thông tin/ưu đãi/đồng ý public của khách cũ tồn tại trên kỳ mới |
| W34 | Giảm khách 500 nghìn tháng đầu | Tách đối tượng hưởng, số tiền, kỳ áp dụng, điều kiện; không tự tạo bút toán |
| W35 | Thưởng sale 500 nghìn | Mặc định nội bộ; không xuất vào link khách/ảnh gửi khách; gắn điều kiện đủ thưởng |
| W36 | Chính sách áp dụng một tòa, vài phòng | Phạm vi rõ; có ưu tiên khi chính sách chung và riêng trùng nhau |
| W37 | Hai chương trình chồng nhau | Quy tắc cộng dồn/chọn một, thời gian bắt đầu/kết thúc, mức trần và ngoại lệ |
| W38 | Hết chương trình nhưng khách đã cọc | Giữ snapshot thỏa thuận đã được duyệt; không thay bằng chính sách mới |
| W39 | Sửa nội dung nhưng chưa muốn công khai | Draft riêng, preview rõ; nút công bố độc lập với lưu bản nháp |
| W40 | Thu hồi toàn bộ link của cộng tác viên | Có nhóm/kênh, scope và audit; link đã thu hồi không đọc được payload mới |
| W41 | Link chỉ cho tòa A hoặc 5 phòng | Public RPC kiểm scope token; không chỉ lọc phía giao diện |
| W42 | Link hết hạn sau chiến dịch | TTL phía server, timezone, trạng thái public dễ hiểu và đường liên hệ hợp lệ |
| W43 | Xem thử với vai khách | Preview public allowlist; không để quyền đăng nhập bổ sung trường nội bộ vào preview |
| W44 | Xuất ảnh chỉ phòng đang lọc | Hiện tại export tất cả; nếu thêm lựa chọn cần nút/phạm vi rõ trước xuất |
| W45 | Gửi danh sách qua Zalo | Dùng cùng fact/policy snapshot; chọn nhóm/đối tượng đúng, preview và biên nhận gửi |
| W46 | Ảnh đã gửi bị cũ sau khi phòng có cọc | Không thể thu hồi ảnh ngoài hệ thống; đóng dấu thời gian và link dữ liệu sống |
| W47 | Sửa sơ đồ một tầng | Chỉ ghi tầng đang sửa, giữ tầng khác; validate tọa độ/kích thước và phòng thuộc tòa |
| W48 | Đổi tòa khi đang sửa sơ đồ | Có lựa chọn lưu/bỏ/giữ nháp; không mất việc âm thầm |
| W49 | Xem sale nào mang khách tốt | Phân biệt view/click/lead/hẹn/cọc/hợp đồng; attribution có nguồn rõ |
| W50 | Nhân viên chỉ quản lý tòa A | Mọi đọc/ghi/public token/media/Hermes đều không mở rộng sang B |
| W51 | Chủ có nhiều công ty và nhiều owner | Target org/owner/tòa rõ; chuyển tổ chức xóa/đổi cache thích hợp; không suy theo dòng đầu |
| W52 | Mạng đứt ngay sau bấm lưu | Trạng thái “chờ đối chiếu”; tra receipt bằng action ID; không retry thao tác mới mù quáng |
| W53 | Người dùng bấm hai lần/nhắn lại | Idempotency key bền vững theo ý định; không tạo trùng listing/link/ảnh/cọc |
| W54 | Quyền bị thu hồi khi form đang mở | Server kiểm lại lúc commit; giữ bản nháp và báo từ chối rõ ràng |
| W55 | Dữ liệu phòng đã bị xóa/chuyển tòa | Báo mục tiêu thay đổi, không tự chuyển thao tác sang phòng có tên giống |
| W56 | Muốn biết ai sửa và hoàn tác | Nhật ký trước/sau, actor/kênh/reason; undo có kiểm revision và tác động downstream |

## Kế hoạch hiện thực riêng phần web

### Giai đoạn một Khóa các rủi ro trước khi mở rộng

1. Sửa W1 qua RPC forward migration, kiểm auth nguồn/đích/org và conflict; không sửa migration lịch sử.
2. Tách rõ contract quyền theo thao tác và trường: metadata public, ảnh, giá, pass, policy, token, sơ đồ, publish. UI và Hermes dùng chung action definition.
3. Chốt model owner/org của settings/token; quyết định hỗ trợ nhân viên được ủy quyền hay owner-only.
4. Sửa W2 và W3 để giao diện phản ánh đúng hành vi hiện tại.
5. Bổ sung test âm về scope cho mọi action mới, gồm mutation proof theo Contract; database TEST thực xác minh JWT/RLS tách riêng.

### Giai đoạn hai Chuẩn hóa lớp thao tác dùng chung

Mỗi yêu cầu ghi có `action_id`, actor/kênh, org/owner, entity IDs, expected revision, payload đã validate và result có trạng thái `applied`, `unchanged`, `conflict`, `rejected`, `unknown`. Trước ghi kiểm fact mới; sau ghi trả giá trị đã xác nhận và trường đã đổi.

Tách direct writes của ảnh và bảng khỏi component vào service/hook typed. Giữ phần đọc Hermes của Claude ổn định; phần action chỉ gọi contract reader/fact đã được thống nhất. React desktop/mobile không tự dựng logic trạng thái riêng. Không đưa quyền quyết định tài chính vào text ghi chú.

Phạm vi một transaction nên theo một intent có thể giải thích: một phòng, một tầng, một chương trình; tác vụ hàng loạt có preview và receipt từng item. Action mơ hồ cần hỏi lại, action ngoài scope phải từ chối.

### Giai đoạn ba Hoàn thiện đăng tin và cập nhật nội dung

Thêm trạng thái công bố độc lập với tình trạng vật lý/pháp lý của phòng: draft, published, hidden, archived. Tình trạng available/notice/preparing/pass vẫn do fact gốc cung cấp. Mỗi tin lưu last verified, người xác nhận, nguồn ảnh/thông tin và version.

Có editor phòng thống nhất cho web/Hermes: giá niêm yết, nội thất, diện tích, loại phòng, ghi chú public, ảnh. Dirty draft không mất khi đọc lại. Save thông tin và publish là hai hành động phân biệt. Chọn đúng scope cho batch và cho ảnh export.

### Giai đoạn bốn Hoàn thiện pass và chính sách

Pass gắn với room và tenancy epoch/contract đang liên quan, có consent liên hệ, lý do đóng và lịch sử. Chuyển sang khách/hợp đồng mới phải có bước đóng overlay cũ. Khi cọc/lock mới làm phòng không còn chào, public phải cùng trạng thái.

Policy có bản ghi cấu trúc theo audience, scope, hiệu lực, điều kiện, ưu tiên/cộng dồn và version. Văn bản là phần hiển thị; snapshot policy lúc báo cọc/chốt hợp đồng không đổi theo policy tương lai. Cho phép policy đơn giản dạng text trong giai đoạn chuyển đổi, nhưng phải đánh dấu phạm vi public/nội bộ.

### Giai đoạn năm Sơ đồ, chia sẻ và đo hiệu quả

Sơ đồ dùng patch theo tầng và CAS; save trong lúc đang chỉnh sửa không làm mất dirty flag của sửa mới. Token có scope/TTL/chiến dịch theo nhu cầu; public đọc scope ở server. Link, copy, export và Zalo dùng cùng projection public. Thống kê phân biệt lượt click và chuyển đổi thật.

## Kiểm thử và điều kiện hoàn tất

Đợt này chương trình tái hiện W1 đã chạy thành công theo nghĩa tái hiện lỗi, **không phải đạt yêu cầu bảo mật**. Root điều phối các suite khác, kết quả tổng nằm trong biên bản kiểm chung; không đánh dấu xanh chỉ vì file test tồn tại.

| Lớp | Test hiện có cần sử dụng | Cần bổ sung khi hiện thực |
|---|---|---|
| UI quản trị | `src/components/sale-phong/__tests__/*`, `src/pages/sale-phong/__tests__/*` | Dirty draft, double submit, permission revoke, lost response, desktop/mobile parity, floor editor |
| Hooks ghi | `publicRoomReceipts.feedback.test.tsx`, `useSaveRoomListSheet.test.tsx`, `passListingsFeedback.test.tsx` | CAS, receipt unknown, partial batch và retry không lặp, delegated owner |
| Public | `src/pages/phong-trong/__tests__/*`, `tracking.test.ts`, `errorTelemetry.test.ts` | Publish/hide/TTL/scope, không lộ PII/bonus, stale snapshot khi cọc/lock đổi |
| SQL fact | `roomSaleMigration.test.ts`, `roomSaleLockMigration.test.ts` và các test liên quan | Scope source/destination pass, tenant epoch, active unique race, policy effective dates |
| Ảnh | `ImageUploadZonePolicy.test.tsx`, `ImageUploadZone.feedback.test.tsx`, `saleImagesFeedback.test.tsx` | Upload pending + save, thay/ghép/copy, tham chiếu dùng chung, conflict và dọn orphan |
| Trình duyệt | `.e2e-fleet/specs/phong-trong-export-image.spec.ts` | Full luồng draft/publish/pass/ảnh/policy/link trên viewport/vai trò thực sự bị ảnh hưởng |
| TEST thật | Runner/fixture theo Contract và data runbook trước khi ghi | JWT/RLS, storage public/private, realtime, atomicity, collision và quyền thu hồi |

Không cần chạy E2E toàn ứng dụng cho một thay đổi giao diện đơn lẻ. Với thay đổi tiền/quyền/schema, phải theo risk-map/test-matrix, kiểm đột biến, review đúng diff cuối và giữ receipts có đầu vào không đổi. Đã đối chiếu bốn thân hàm từ catalog production chỉ đọc; chưa xác minh toàn bộ helper/trigger/ACL, quyền JWT thật, upload R2 thật hoặc gửi Zalo thật trong báo cáo con này.
