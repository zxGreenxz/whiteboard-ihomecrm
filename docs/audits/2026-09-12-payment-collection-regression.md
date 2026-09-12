# Thu tiền lỗi sau commit điều chỉnh hóa đơn — 12/09/2026

## Nguyên nhân và phạm vi

Ảnh sự cố ở `/invoices` và `/thu-tien` cùng cho thấy
`record_invoice_collection_v5` trả HTTP 400. Commit
`c7f7fae9ea1fcb1fe54a2e2206802c091360fed0` thêm migration
`20260911093834_invoice_adjustment_review.sql`; biên nhận đã có trong repo ghi
apply lúc `2026-09-11T14:22:58.244Z`.

Hàm trigger `guard_paid_invoice_direct_adjustment()` gắn vào hai bảng có kiểu
record khác nhau. Điều kiện `AND TG_TABLE_NAME=...` nằm cùng một biểu thức SQL
với tham chiếu cột không tồn tại trên bảng còn lại. PostgreSQL phân giải field
trước khi đánh giá điều kiện:

- UPDATE `invoices`: `42703 record "new" has no field "invoice_id"`.
- DML `invoice_items`: `42703 record "old" has no field "paid_amount"`.

`record_invoice_collection_v5` gọi `recompute_invoice_for_id`, hàm này UPDATE
`invoices` nên đụng trigger. Đây là lỗi chung ở database, không phụ thuộc việc
hóa đơn đã từng có adjustment hay chưa. Hoàn tác thu, cập nhật ghi chú, đánh dấu
quá hạn và sửa dòng hóa đơn cũng có thể bị ảnh hưởng.

Lỗi đã tái hiện bằng PostgreSQL WASM/PGlite và database live (fixture DEMO,
ROLLBACK). Catalog live đã xác nhận đúng định nghĩa lỗi này.

## Hotfix

Migration mới `20260912063718_paid_invoice_guard_row_types.sql` thay đúng hàm
trigger, tách nhánh role, table và operation thành các statement PL/pgSQL riêng.
Giữ SECURITY INVOKER, ghim search_path và giữ quyền ghi của RPC owner. Không
chỉnh migration cũ, không thay các writer tiền hoặc dữ liệu nghiệp vụ.

Với thao tác chuyển dòng hóa đơn, kiểm cả OLD.invoice_id và NEW.invoice_id để
không chuyển dòng khỏi hoặc vào hóa đơn đã thu tiền. Đây là kiểm tra tuần tự;
chưa bổ sung khóa để xử lý race sửa dòng đồng thời với thu tiền.

## Bằng chứng kiểm thử

- Trước sửa: 13/17 case SQL thất bại, đúng lỗi field/SQLSTATE `42703`.
- Sau sửa: 17/17 case SQL đạt; suite đọc định nghĩa cuối cùng trong migration
  history, áp thân hàm hai lần, chạy DML thật dưới owner/authenticated/anon.
- Nhóm 6 file kiểm thử payment/collection: 84/84 đạt. Phủ validation V5,
  chống gọi fallback, tiền thối, UI/hook Thu tiền và guard SQL mới.
- Reviewer độc lập không thấy blocker mới trong phạm vi hotfix `42703`.
  Test owner UPDATE là kiểm đoạn trigger ở cuối writer; không thay thế việc
  gọi toàn bộ RPC V5 qua PostgREST.
- Ba phép đột biến bằng `scripts/dot-bien.mjs` đều bị suite bắt đúng, khôi phục
  hash `15b0475ef08a`: tái đưa lỗi rowtype (`5f67ad6c48a6`), đổi sang SECURITY
  DEFINER (`5763775c7b4c`), bỏ kiểm OLD parent khi UPDATE (`6da637842686`).
- Typecheck baseline: 0 fingerprint, không thêm lỗi.
- Lane dry-run và hai lượt migration trong ROLLBACK: đạt.
- Live DEMO với flags hiện hành: thu 3.239.000, thu tiếp 2.000.000, replay cùng
  key và hoàn tác lần thu sau: đạt, toàn bộ ROLLBACK. Trước hotfix fixture thất
  bại đúng `42703`; sau hotfix paid_amount lần lượt 5.239.000 và 3.239.000.
- Harness rounding-change với hotfix áp hai lần trong transaction: đạt các
  biên refund, mixed tenders, retry/payload mismatch, stale paid, reversal,
  report sums/paging và phạm vi filter; toàn bộ ROLLBACK.
- Reconcile v1: 1.104 phiếu, A=B=C=5.478.589.013 VND; v2: 20 sổ thật đều khớp,
  3.507 posting lines, SQL=phân trang=3.072.106.007 VND.
- Stable function lock gate: không có hàm đọc chạm khóa dòng.

## Triển khai hotfix và kiểm tra hậu triển khai

Hotfix đã apply qua forward lane lúc `2026-09-12T06:54:57.090Z`, đúng commit
đã review `69af57a62b69023a203bc811380f3d73a28c8bc3` và SHA256 migration
`15b0475ef08ae03e1681aee23a82acb9e4d3ab1469e1dea9f61eb094d322b1ee`.
Biên nhận: `docs/generated/schema-change-evidence/20260912063718_paid_invoice_guard_row_types.json`.
Backup đầy đủ đã xác minh 527 bảng trước apply; SHA256 dump
`c582b05e5547589a602f7458cae05710eab384b8ffc0a59b7f499b62c179c366`.

Sau apply, `node scripts/test-invoice-rounding-http-concurrency.mjs --execute`
đạt cả hai nhóm request PostgREST độc lập: cùng key trả cùng collection;
khác key chỉ một request thắng. Mỗi nhóm đúng một collection/payment,
8.000 tiền làm tròn, một dòng báo cáo; hoàn tác trung hòa toàn bộ posting.
Fixture DEMO và possession binding theo marker đã dọn sạch.

`gate:truoc-push` đạt đủ 42 gate. Sandbox gate chạy tại checkout chính với
vault: 0 bảng rò dữ liệu trong 148 bảng có quyền SELECT (18 bảng không cấp
SELECT), snapshot THẬT trước/sau không đổi. GitHub CI run `34679215202` đã
thành công sau khi đồng bộ secret SUPABASE_PAT đã được người dùng cập nhật;
các job phụ thuộc phạm vi PR được workflow đánh dấu skipped, không tính là
kiểm thử đã chạy. Quality, realtime, timezone, strict islands và secret scan
đạt; restore drill cũng đã đạt ở attempt trước.

Harness cũ `test-invoice-collection-v5.mjs` không chạy được bước kích hoạt
CANARY vì database có một integrity exception đang OPEN. Không hạ guard hoặc
đổi exception; các probe ở trên dùng flags hiện hành (collection/reverse/credit
đang ON). Đây là khác biệt setup harness, không phải một scenario đạt.

Spec UI cũ `invoice-collection-v5.spec.ts` dừng tại preflight vì không có
phòng/khách/sổ DEMO phù hợp để tạo hợp đồng mới. Spec hồi quy riêng dùng
hóa đơn mới gắn hợp đồng DEMO đang hoạt động, nên không phụ thuộc phòng trống.
Kết quả UI được ghi riêng sau khi chạy; không dùng preflight failure làm PASS.

`npx playwright test specs/payment-collection-regression.spec.ts --workers=1 --reporter=list`
chạy headless trên production: PASS. Desktop `/invoices/:id` thu 3.239.000,
mobile `/thu-tien` keypad thu đúng 2.000.000 còn lại; hai request V5 thành công,
paid_amount=5.239.000, remaining=0, status=PAID, đúng hai collection ACTIVE,
không lỗi console/page. Teardown hoàn tác cả hai khoản thu trước khi dọn fixture.
DEMO thiếu sổ cá nhân tên kết thúc “Thu” nên test tạo sổ zero-balance tạm theo
marker và dọn sạch, không đổi cấu hình sổ quỹ hiện hữu.

E2E phát hiện helper dọn fixture cũ bỏ sót finalized finance snapshots và
posting ledger do session_replication_role=replica cũng tắt FK cascades.
Helper nay dọn các con theo invoice/voucher marker trước khi xóa cha. Các
fixture của lượt kiểm này tạo trước lúc sửa helper cũng đã được xác định từ
canonical response marker, kiểm tiền net=0 và dọn; không đụng dữ liệu THẬT.

## Rủi ro khác của chức năng adjustment chưa được hotfix xử lý

Review source commit mới phát hiện các điểm cần xử lý tiếp trước khi coi toàn
bộ chức năng điều chỉnh hóa đơn đã thu tiền là an toàn:

1. `adjust_invoice_v1` giảm tổng dưới paid_amount tạo `excess_amounts` không có
   canonical `credit_lot_id`. Các RPC credit hiện chặn legacy credit chưa đối
   soát; có thể làm khóa credit của hợp đồng.
2. Adjustment chỉ cập nhật header/snapshot, còn V5 đọc DEPOSIT/NON_PNL từ
   `invoice_items` gốc. Thay đổi cọc/NON_PNL có thể khiến lần thu tiếp phân bổ
   sai hoặc bị guard semantic từ chối.
3. Guard dòng hóa đơn chưa khóa parent để tuần tự hóa với lần thu đầu tiên;
   chưa chứng minh an toàn trong race item edit/payment.

Catalog live tại thời điểm điều tra có 0 invoice_adjustments. Các rủi ro này
đang được sửa trong nhánh `codex/invoice-adjustment-repair-20260912` theo yêu cầu
mở rộng của người dùng. Không tự backfill hoặc sửa dữ liệu nghiệp vụ org THẬT.
