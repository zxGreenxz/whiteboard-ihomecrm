# Đợt 2 — bằng chứng SQL và chính sách có thời hạn

Phạm vi đã kiểm là mã ứng viên local ngày 21/10/2026, PostgreSQL 17.10 tại `127.0.0.1:55438/sale_quick_local`, baseline và forward schema đã khôi phục. Dữ liệu tổng hợp riêng; gọi writer bằng role `authenticated` và bộ phân quyền thật. Không apply production, không gửi tin thật. Hồ sơ đợt 1 không được dùng để chứng nhận thay đổi đợt 2.

## Hành vi đã triển khai

- `20261021063721_sale_room_timed_policy_v1.sql` là migration forward mới. Sửa metadata và chính sách trực tiếp bằng `sale_phong.edit OR rooms.edit`, giữ phạm vi tổ chức/tòa. Không có hàng đợi duyệt, không cấp thêm quyền tiền hoặc `rooms.edit`.
- Mặc định `sale_phong.edit` chỉ áp tên vai trò chuẩn đã chốt hoặc `TENANT_OWNER`; có dấu một lần để replay không cấp lại quyền đã xóa. Role DENY, member DENY và phạm vi gán giữ nguyên. Legacy template giữ các quyền khác; không sửa snapshot nhân viên cũ.
- Writer khóa phòng → tổ chức → mã yêu cầu; kiểm quyền live trước replay, CAS phòng khi lưu và version chính sách khi ngưng. Mỗi phòng là một transaction. Có receipt riêng, kiểm fingerprint; lưu/ngưng tăng revision phòng.
- Policy có `title/content/starts_at/ends_at`, hiệu lực `[start,end)`, không chồng lịch còn hiệu lực cùng phòng. Nội dung sửa bằng ngưng hồ sơ cũ và tạo hồ sơ mới. Tiêu đề chỉ dùng quản trị; phần công khai là `content`.
- Inventory trả base note, policy hiện tại, danh sách policy đang/sắp áp dụng, fact key và ghi chú tình trạng raw/active. Public/get_my/worker ghép base note với active content khi đọc, không cần cron. Public không trả audit, tiền thưởng nội bộ hoặc nội dung chương trình chưa bắt đầu.
- Public/get_my có thêm base note và hạn kết thúc active content để client bỏ phần hết hạn khỏi cache. Đồng hồ đơn điệu cộng độ trễ yêu cầu dùng làm biên an toàn khi hết hạn; mạng chậm có thể ẩn ưu đãi sớm trong khoảng độ trễ, không kéo dài ưu đãi. Nội dung tương lai không được tự hiện sớm theo biên trên.

## PostgreSQL thật — 25 tình huống nghiệp vụ đạt

Lệnh: `node --test scripts/test-sale-room-policy-local.mjs` với biến `SALE_QUICK_TEST_DATABASE_URL` trỏ DB local nêu trên. Log: `test-results/sale-quick-local/policy-native-final.log` — 26/26 khi tính thêm test cha, 25 tình huống thực bên dưới.

| ID | Nội dung |
|---|---|
| P01 | Cả năm vai trò có quyền sale riêng; không cấp mới quyền tài chính/rooms.edit |
| P02 | Sale cập nhật metadata và thưởng nội bộ đúng tòa |
| P03 | Sale, Sale Admin, quản lý không vượt tòa; chủ công ty không vượt tổ chức |
| P04 | Xóa quyền và role DENY còn hiệu lực sau replay migration |
| P05 | Status note phải có cặp fact key live; không sửa trạng thái thuê |
| P06 | Hai người sửa cùng revision: đúng một thành công |
| P07 | Sale đăng policy trực tiếp, audit đúng người, room revision đổi |
| P08 | Base note riêng; chỉ content được ghép vào nội dung gửi khách |
| P09 | Policy trùng thời gian bị từ chối |
| P10 | JSON, nội dung, thời gian sai hoặc đã hết hạn bị từ chối |
| P11 | Ngưng cần version/lý do hợp lệ; audit và revision đổi |
| P12 | Retry save cùng request trả đúng receipt, không tạo trùng |
| P13 | Replay sau khi thu hồi quyền bị từ chối |
| P14 | Retry cancel đúng trả receipt; đổi lý do cùng request bị từ chối |
| P15 | Scheduled không hiện sớm; bắt đầu bao gồm, kết thúc loại trừ |
| P16 | Public/get_my/worker cùng nội dung và tự bỏ policy hết hạn; public timing không lộ audit/future policy |
| P17 | Lưu/ngưng ngoài scope bị từ chối |
| P18 | Hai policy writer đồng thời cùng revision: một thành công |
| P19 | Hai session cùng request nhận cùng receipt |
| P20 | API role không ghi/đọc trực tiếp bảng private hoặc gọi helper |
| P21 | Anon không được ghi; public không lộ audit/bonus |
| P22 | Metadata tòa có đủ trường; staff không quản owner settings |
| P23 | Template đúng tên được thêm quyền; giữ quyền khác, không tái cấp sau replay |
| P24 | Member DENY thắng default grant và vẫn thắng sau replay |
| P25 | Hai chương trình nối tiếp xuất hiện riêng; ngưng đúng hồ sơ được chọn |

## Mutation proofs

`scripts/test-sale-room-policy-mutations-local.mjs`: 7/7 mutation bị phát hiện, 8/8 gồm test cha; log `test-results/sale-quick-local/policy-mutations.log`. Mỗi probe chạy control gốc rồi phiên bản cố ý sai trong transaction riêng, rollback toàn bộ DDL/dữ liệu. Chỉ lỗi assertion mới được coi là phát hiện mutation, không coi lỗi cú pháp SQL là đạt.

| ID | Lớp bảo vệ bị cố ý bỏ |
|---|---|
| MP01 | CAS phòng |
| MP02 | Chặn policy chồng lịch |
| MP03 | Điều kiện kết thúc hiệu lực |
| MP04 | Fact key cho status note |
| MP05 | Fingerprint của request đã có receipt |
| MP06 | Quyền sale ở cả trước và sau khóa |
| MP07 | Version khi ngưng policy |

## Client cache và xuất ảnh

`publicSalePolicyExpiry.test.tsx` kiểm C01–C09: xóa riêng nội dung hết hạn ở rooms/floors, giữ base null, thiếu timing thì từ chối payload active, độ trễ mạng không kéo dài chương trình, future chưa được hiện sớm, cache cũ tương thích, timer vẫn bỏ policy khi refetch lỗi, refresh xuất dùng phản hồi mới, hai policy nối tiếp còn chọn riêng và chuyển đúng mốc. Bộ kiểm liên quan có 97 test đạt trước khi thêm kiểm export; lần gộp sau đạt 99/100, một ca mới dùng sai giả định rằng embedded có nút xuất ảnh. Đã sửa fixture thành màn in-app có header xuất ảnh, không sửa product để chiều test.

`PhongTrongPage.policyExport.test.tsx` chạy lại 3/3 đạt tại `test-results/sale-quick-local/policy-export-final.json`: C10 đọc fresh trước vẽ ảnh, C11 không xuất cache khi refresh lỗi, C12 dữ liệu in-app dùng callback xác minh của chính nguồn đó. `policy-expiry-client.json` giữ kết quả lần gộp để đối chiếu, không mô tả file đó là 100/100 xanh. Kiểm canvas/browser thực thuộc gate UI riêng.

## Giới hạn

Đây là bằng chứng local, không thay kiểm JWT HTTP, RLS qua gateway thực, rollout TEST/production hoặc gửi Zalo thật. Hermes FAST cũ chưa đọc policy table mới theo ranh giới phối hợp; không sửa reader đó. Kiểm public/get_my/worker SQL chứng minh nội dung lúc đọc, không tự chứng minh canvas/browser/provider đang mở; client boundary và export được kiểm riêng. Receipt save có trạng thái tại thời điểm ghi và được giữ nguyên khi replay; inventory là nguồn trạng thái hiện tại. Quyền bị thu hồi có thể chặn lấy lại receipt đã ghi, do đó UI phải giữ kết quả trước đó ở trạng thái chưa rõ nếu retry không xác nhận được.
