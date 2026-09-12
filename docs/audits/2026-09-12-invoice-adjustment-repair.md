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

## Triển khai v2 và lỗi xung đột HTTP phát hiện khi tích hợp

V2 đã áp dụng lúc `2026-09-12T09:07:25.191Z` từ SHA `0466a686`, backup đầy đủ
527 bảng; receipt `20260912065909_invoice_adjustment_atomic_revisions.json`.
Native generated types đã sinh lại; baseline 0 lỗi, build/bundle đạt (521 chunks,
entry 221 kB, tổng 8.12 MB). Đã gỡ hồ sơ chưa-apply sau receipt thật.

HTTP ban đầu thiếu Content-Profile public (PGRST202); đã sửa harness. Sau đó,
same-key replay/mismatch/quyền đều đạt nhưng hai lượt different-key bị timeout:
mã nghiệp vụ 40001 kích hoạt retry liên tục của PostgREST 14. Tất cả fixture
đã hoàn tác và dọn, audit được giữ. Nguồn:
https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b

Forward migration mới `20260912091403_invoice_domain_conflicts_http409.sql`
(digest `5bf29e7853abf7435a7ede47be3e27d7b60b28899bada858059400c3a1b2844c`)
chỉ đổi 4 mã lỗi nghiệp vụ sang PT409 trong adjust/review/pin/V5 collect.
Preconditions khóa đúng hash định nghĩa trước/sau, không thay đổi logic tiền.
Review độc lập xác nhận tương đương cả 4 body. 112 tests liên quan và live rollback
hai migration lặp hai lần đạt; hai mutations mã lỗi/guard catalog đều bị bắt.
Frontend `abb1571c` nhận PT409 không retry và giữ native40001 tương thích;
review độc lập + 83 tests đạt. Chờ apply migration bổ sung và HTTP/E2E cuối.

E2E thu tiền đơn thuần trên build mới đã đạt 15.2 giây: thu tại invoice 3.239.000,
Thu tiền mobile 2.000.000, đủ 5.239.000, không lỗi console và cleanup đầy đủ.
E2E chỉnh sửa còn đang kiểm tra; một assertion kiểu numeric của Management API
đã sửa bằng cast bigint cho các số tiền nguyên của fixture.
