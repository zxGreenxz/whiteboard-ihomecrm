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
review độc lập + 83 tests đạt.

E2E thu tiền đơn thuần trên build mới đã đạt 15.2 giây: thu tại invoice 3.239.000,
Thu tiền mobile 2.000.000, đủ 5.239.000, không lỗi console và cleanup đầy đủ.
E2E chỉnh sửa còn đang kiểm tra; một assertion kiểu numeric của Management API
đã sửa bằng cast bigint cho các số tiền nguyên của fixture.

## Kiểm chứng sau áp dụng mã xung đột

Migration PT409 đã áp dụng qua forward lane lúc `2026-09-12T09:29:40.003Z`
từ SHA `9d082d9631bfbc90148c29ceea044f73177f0b08`. Backup đầy đủ 527 bảng,
SHA256 `875100b81ab05bfa98b598ef7d484487c7be1d81669ae88efac3882e53c2f4af`;
receipt `20260912091403_invoice_domain_conflicts_http409.json`.
Catalog fingerprint không đổi vì chỉ thay mã lỗi trong thân hàm; HTTP harness
kiểm MD5 của cả năm định nghĩa live trước khi tạo fixture. Đã sinh lại types
bằng generator chuẩn và normalizer, không có thay đổi schema type.

`node scripts/test-invoice-adjustment-http-concurrency.mjs --execute` đạt toàn bộ:

- Thu một phần với trạng thái cũ trả HTTP409/PT409 trong 123ms, không đổi tiền.
- Hai HTTP cùng key trả cùng revision; khác payload bị 23505; anonymous bị từ chối.
- Hai key cạnh tranh: một revision thắng, yêu cầu cũ trả PT409 trong 302ms.
- Sửa và thu đồng thời cho thứ tự tuần tự hợp lệ; phân bổ đúng thành phần,
  manifest đúng phiên bản, hash lịch sử gốc không đổi.
- Kiểm tra phiên bản cũ trả PT409 trong 153ms; quản lý khác tòa và kế toán thiếu
  quyền bị từ chối; chủ công ty kiểm tra thành công mà không đổi tiền/snapshot.
- Helper thường và invoice ID sai đều bị từ chối; hai collection được hoàn tác
  canonical, net posting bằng 0 và fixture được dọn; audit/hash chain giữ nguyên.

E2E trên build mới: payment regression đạt 16.1s. Adjustment E2E có một lần lỗi
PT409 khi mở editor ngay sau thu một phần; chạy lại cùng build đạt 33.8s, gồm
hai tab cạnh tranh, tải lại rõ ràng, review, lọc phiên bản và sửa sau hoàn tác.
Đây là race giao diện đang được sửa và kiểm thử xác định, chưa tính bản phát hành
đã hoàn tất chỉ vì lượt chạy sau đạt.

Đối chiếu live sau apply: v1 có 1.105 phiếu qua hai trang, SQL = RPC/RLS =
phân trang = 5.478.995.513đ. V2 khớp cả 20 sổ thực; 3.521 posting lines qua
bốn trang khớp SQL 3.071.593.207đ. Số tiền live có thể thay đổi do vận hành.
Sandbox gate tại checkout chính: 0/148 bảng đọc được rò TEST, 18 bảng còn lại
không có SELECT; phép đo này không bao phủ mọi RPC SECURITY DEFINER.
Snapshot before/after có 17 chỉ số thay đổi trong thời gian vận hành, không phải
bằng chứng dữ liệu thật đứng yên. Không chỉnh sửa các dòng THẬT để ép khớp.
12/12 view invoker, stable-function locks và definer ACL đều đạt; catalog không
có object thiếu RLS/search_path. Backend/source harness được review cuối và approved.

## Bản giao diện cuối và gate tích hợp

Commit `53c8153f` xử lý race đã tái hiện: hộp thu tiền đóng trước refetch cache,
form mở ngay chụp paid/revision/fields cũ. Editor nay chỉ mount sau khi đọc đủ
hóa đơn mới; lỗi đọc không fallback cache, đóng/mất quyền bỏ kết quả đến muộn,
form đã mở vẫn giữ snapshot cho đến khi người dùng tải lại rõ ràng.
38 tests/7 files đạt, reviewer chạy độc lập cùng 38 tests và approved.
Baseline TypeScript 0 lỗi; lint 0 lỗi mới (1.141 hiện tại so baseline 1.152).

Build cuối đạt 16.36s, 521 chunks, entry 221kB, tổng 8.12MB, 97 trang lazy;
không tăng ngưỡng bundle. Hai E2E trên build này cùng đạt, tổng 52.0s:
adjustment 38.2s và payment 13.0s. Chạy từ thu một phần tới bốn revision,
thu đủ trên mobile, phân quyền review, hai tab xung đột/tải lại, lọc SQL,
hoàn tác và điều chỉnh giảm sau hoàn tác; không lỗi console/page, cleanup đạt.
`gate:truoc-push` đạt đủ 42 gates trong 124s, gồm strict và generated artifacts.

PR CI ở `9d082d96` đã phát hiện prefer-const (đã sửa trong `53c8153f`) và một
test GitNexus đòi PID con biến mất ngay sau SIGKILL. Source GitNexus không đổi
so với main; Linux có khả năng giữ zombie chờ reap, chưa có dữ liệu đủ để
khẳng định nguyên nhân. Giữ bằng chứng run `34685864366`, không dùng lượt đó
làm CI đạt. Restore drill cùng SHA đạt (`34685864355`).

External controls được đọc lại: cả app/docs dùng production branch; deployment
trước bản sửa là `91897a71`, READY. GitHub private Free thiếu branch protection
là giới hạn đã có; không thay cấu hình để bỏ qua lane phát hành.

## Trạng thái phát hành

Backend và frontend đã được review độc lập. Còn CI của đúng SHA tích hợp main,
promote qua lệnh chuẩn và kiểm tra lại hai luồng trên production sau phát hành.

CI main đầu tiên `a029b290` bắt lỗi `react-hooks/rules-of-hooks` ở component giả
trong test open-snapshot: tên export mặc định là `default`, không phải tên React
component. Local lint trước đó chưa đếm test còn untracked. Đã đặt tên rõ ràng
`MockIssuedInvoiceEditor`; đây là sửa test, không đổi ứng dụng/SQL. Eslint trực
tiếp file và 7 tests đều đạt; không tăng lint baseline. Không promote SHA lỗi này.
