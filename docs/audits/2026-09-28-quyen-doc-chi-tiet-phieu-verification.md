# Kiểm chứng sửa quyền đọc chi tiết phiếu — 28/09/2026

## Phạm vi được duyệt

Người đọc được phiếu qua sổ quỹ tiếp tục thấy mọi phiếu trong sổ đó, kể cả người
khác tạo. Người này đọc đủ hạng mục và tên tòa gắn trên phiếu; không được mở
dữ liệu khác của tòa. Không mở rộng quyền sửa, duyệt, ghi sổ hoặc bổ sung chứng từ.

Ca gốc: `5af4bc29-6111-4d49-865b-b6894a4d9131`, tên “mua tinh dầu 950NK”,
941.040 đ, sổ TKHIEP. Mã PC2609103 không duy nhất, kiểm bằng UUID.

## Bằng chứng trước phát hành

- JWT NATHAN trên TEST trước sửa: thấy header, không thấy item; không thấy tòa.
- Migration đã dry-run rồi áp dụng trên project TEST riêng; không sửa phiếu gốc.
- PGlite: 21 ca đạt, migration chạy hai lần; 3 đột biến org/parent/append bị bắt.
- Bộ kiểm thử liên quan: 81 ca / 9 file đạt ở lượt 16:37; gồm đọc đủ dữ liệu,
  guard form, giữ phần đang gõ, print, lọc báo cáo và phân trang.
- Mutation frontend bỏ kiểm số item bị bắt; mutation báo cáo bỏ kiểm lỗi đọc
  hoặc bỏ kiểm thay đổi phạm vi bị bắt và khôi phục đúng hash.
- Typecheck app khớp baseline 0 lỗi ở lượt đã chạy. Build đầu đạt; lượt cuối
  và E2E được ghi bên dưới sau khi hoàn tất review.
- Đối chiếu production chỉ đọc: 1.166 phiếu thu của 07–09/2026, SQL/RPC JWT/
  phân trang đều 5.787.624.013 đ. V2: 20 sổ thực khớp; 3.749 posting lines,
  SQL và phân trang đều 2.690.813.004 đ.
- Production forward lane dry-run đạt, transaction rollback. Lượt Node24 gặp
  lỗi libuv lúc thoát; đã chạy lại bằng Node22 và thoát 0. Chưa tính dry-run
  là apply production.

## Review độc lập

Backend được reviewer khác đọc migration, helper cũ, ACL/RLS và tự chạy lại
21 ca PGlite. Không thấy P1/P2. Digest migration được review:
`f72b6653aba7528913d00426fb1e3235d917c3da72a92db81f4d96f7df459e4e`.

Review báo cáo phát hiện snapshot mới có thể bị ghép vào tập phiếu lọc cũ.
Đã kiểm các trường phạm vi và `updated_at`, báo tải lại khi thay đổi; thêm
ca đổi trạng thái, tòa, phòng và hóa đơn. Nhánh lỗi giữ bộ lọc/sheet nhưng
không hiển thị tổng tiền thiếu. Review frontend đã xác nhận nhãn quan hệ qua
RLS trong phiếu tổng, làm mới mobile batch và invalidation sau mutation.
Reviewer chạy độc lập 68 test đạt; không còn P1/P2 cụ thể trong bản sửa.
Gate strict bắt được nullable building và phần tử có thể không tồn tại;
đã sửa và cả hai tầng strict đạt. RPC dùng literal name trong domain wrapper.

## Giới hạn và phát hành

TEST clone không chứa byte ảnh cũ; E2E không chứng minh tải ảnh đính kèm thật.
Test print kiểm dữ liệu đầy đủ và nút in, cùng việc chặn in khi thiếu dữ liệu.
Các cảnh báo Radix Description/React Router và build đã tồn tại vẫn được ghi nhận.

JWT cuối: 33/33 ca đạt; 3.009 phiếu NATHAN không thiếu item/nhãn. Có 12 lượt
đọc đồng thời trong lúc cập nhật nguyên tử header/items của fixture TEST,
không thấy snapshot trộn. p95 1.540,5 ms trên 46 mẫu; fixture đã dọn sạch.

E2E tự nhiên có 4/5 ca đạt; popup kiểm đúng UUID/hạng mục/tiền/tòa nhưng lỗi
console do truy vấn tòa/phòng timeout SQLSTATE 57014. Không bỏ qua lỗi này.
Đối chứng source main `83b600` trên cùng TEST có 7 request timeout/36 request;
bản sửa có 3/43. Không thấy lock blocker; chưa đủ telemetry để kết luận CPU.
Đây là giới hạn kiểm thử tải của TEST. Kiểm thử chức năng với nhịp request
có kiểm soát được ghi riêng, không thay thế kết quả tải tự nhiên.

Lượt `FLEET_REST_CONCURRENCY=2`: 5/5 E2E đạt trong 28 giây, vẫn kiểm console.
Bốn ca dùng dữ liệu TEST thật (desktop, mobile, popup đúng UUID, print); một ca
cố ý làm phản hồi incomplete để kiểm chặn in. Chỉ giới hạn request đang chạy,
không đổi timeout server hoặc bỏ lỗi. Typecheck E2E đạt.

Quét bổ sung `check-definer-body-authz` trả bốn cảnh báo đã tồn tại nguyên trạng
trên base `83b600`: ba hàm hợp đồng gọi helper có kiểm phạm vi mà scanner chưa
nhận biết; `unlock_salary_month_v2` có khả năng mở khóa danh sách nhân viên khác
org khi chỉ kiểm org của phần tử đầu. Reviewer tái hiện trường hợp sau bằng
PGlite với source gốc; chưa xác minh implementation live. Đây là hạng mục lương
riêng cần xử lý, không sửa allowlist để giấu kết quả. Scanner này không nằm trong
CI Gates/gate trước push hiện hành và không phát hiện hồi quy của bản voucher.

## Áp dụng schema production

Forward lane áp dụng thành công lúc 09:54 UTC ngày 28/09/2026, từ source commit
`0487cbacf13a6fb0d4aa1f11ed17e86bff31d003`, đúng digest đã review phía trên.
Lane đã replay hai lần trong transaction rollback và tạo, kiểm backup đầy đủ
565 bảng có dữ liệu trước khi áp dụng. Biên nhận backup `5231916d9295d38c`;
SHA-256 dump `6232ad03d0fbf0f82534e5a9d1526e4dae04768b011b928282a641b3e83fa198`.
Xem [biên nhận schema](../generated/schema-change-evidence/20260928091816_align_voucher_detail_read.json).
Catalog sau apply khớp fingerprint
`4da4eeecc8764920a2205d7d99689dae2873ab04bc6057212f237b916b97541e`.

Smoke production dùng transaction chỉ đọc, vai `authenticated` và JWT claims của
NATHAN: đúng UUID gốc, header 941.040 đ, 1/1 item “Thu chi khác”, tên tòa “950NK”,
`items_complete=true`, không có issue. Truy vấn trực tiếp tòa vẫn trả 0 dòng;
gọi reader với org khác trả 0 dòng. Không ghi dữ liệu nghiệp vụ production.

Build giao diện cuối đạt trong 31,63 giây; kiểm bundle đạt với 561 chunk,
entry 235 KB. PR #88 lưu lịch sử CI và phát hành. Schema đã áp dụng; bản giao diện
chỉ được promote sau khi CI của đúng SHA trên main xanh ở từng bước.

Gate trước push đầy đủ đạt 44/44 trong 247 giây, gồm generated types/surfaces,
hai tầng strict, lint và phép đo ranh giới tổ chức. Kiểm external controls xác nhận
cả hai project Vercel của repo vẫn dùng nhánh `production`. Snapshot được cập nhật
vì thêm tên biến máy chủ `VOICE_LAB_NINEROUTER_API_KEY` (sensitive, preview/production)
đã tồn tại trên Vercel; không đọc giá trị hoặc sửa env. Quyền bảo vệ nhánh GitHub
vẫn là khoảng trống đã đăng ký của gói hiện tại, không được tính thành control đạt.
