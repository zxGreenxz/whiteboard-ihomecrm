# Sửa thu tiền và điều chỉnh hóa đơn — 12/09/2026

## Nguyên nhân và phạm vi

Commit `c7f7fae9` dùng chung trigger cho `invoices` và `invoice_items` nhưng đọc
trường không tồn tại trên record của bảng kia. Cả hai màn hình thu tiền cùng gọi
V5 nên đều lỗi `42703`. Hotfix `20260912063718_paid_invoice_guard_row_types.sql`
đã áp dụng qua forward lane; bằng chứng backup và kiểm tra hai màn hình nằm ở
`docs/generated/schema-change-evidence/20260912063718_paid_invoice_guard_row_types.json`
và audit payment guard cùng ngày.

Phần điều chỉnh cũ còn làm mất cấu trúc dòng, chưa phiên bản hóa thành phần phân
bổ, chưa khóa trạng thái khi sửa/thu đồng thời, và dùng bộ lọc lịch sử không phản
ánh phiên bản hiện tại. Bản sửa dùng RPC v2 nguyên tử, giữ snapshot trước/sau,
ID dòng và metadata; mỗi lần thu gắn với manifest của đúng phiên bản. Phân bổ
mới trừ phần đã thu đang hiệu lực xuyên các phiên bản, giữ lịch sử cũ nguyên vẹn.
Giảm thấp hơn phần đã phân bổ, làm tròn/cấn trừ đang hiệu lực hoặc nợ đã chuyển
sang hóa đơn sau yêu cầu xử lý bằng luồng hoàn tác/tất toán trước.

Giao diện cho hóa đơn đã phát hành dùng đầy đủ các dòng hiện tại, lý do riêng,
snapshot trạng thái lúc mở và khóa retry ổn định. Có lịch sử chung desktop/mobile,
kiểm tra phiên bản mới nhất, bộ lọc SQL trước phân trang và cập nhật cache liên quan.
Ghi chú nhanh trong Thu tiền cũng chuyển sang điều chỉnh có lịch sử. Nháp vẫn dùng
luồng sửa nháp. Không ghi thử dữ liệu nghiệp vụ tổ chức THẬT.

## Bằng chứng trước triển khai phần điều chỉnh

- Backend reviewed: `38444f4f`, test liveness `3f70fb4b`; bổ sung defaults nullable
  được review độc lập. Digest migration cuối trước apply:
  `a7ae6673c7a7510260bcd4659499973750c32d9cfae19c6ae831d7c7331db2ae`.
- 110 SQL/cohort/guard/V5 tests đạt. Các ca mới chứng minh bỏ notes tương đương
  SQL NULL và replay cùng key; bỏ reason/key/expected state bị từ chối không lưu
  revision; chuỗi rỗng khác NULL. Không sửa generated types bằng tay.
- `test-invoice-adjustment-repair.mjs --repeat-migration`: đạt với migration chạy
  hai lần trong ROLLBACK, các writer/permission/phân bổ/hoàn tác thực trên DEMO.
- 9 đột biến backend ban đầu và thêm đột biến DEFAULT NULL → chuỗi rỗng đều làm
  suite đỏ đúng ca; helper khôi phục đúng digest. Giao diện có 3 đột biến đạt.
- Frontend `f3f5051e`: 96 tests/13 files, build và bundle đạt; follow-up
  `eebfe1d2`: 27 boundary/editor tests đạt. Trước apply, strict/baseline còn 5 lỗi
  do schema v2 chưa có trong generated types. Đây không phải typecheck đã đạt.
- Hai E2E và HTTP concurrency đã được review source, `typecheck:e2e` đạt.
  Chúng chỉ cho ghi đúng fixture DEMO, hoàn tác canonical trước cleanup,
  kiểm net posting và không xóa audit/hash chain. Chưa gọi đây là E2E runtime đạt.

## Phần còn cần xác minh

Forward apply có backup/receipt, native generated types, named-argument HTTP
concurrency và role JWT, E2E giao diện mới, đối chiếu tiền v1/v2, sandbox leak,
catalog/ACL, full gates và review cuối. Chỉ promote sau CI của đúng SHA main đạt.
