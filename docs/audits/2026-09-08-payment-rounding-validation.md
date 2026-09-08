# Tiền thối thực tế và thống kê khoản bỏ qua — kiểm chứng

Ngày kiểm: 08/09/2026. Nhánh `codex/payment-rounding-20260908`.

## Hành vi

Hoá đơn đơn lẻ, thu hàng loạt và hai giao diện Thu tiền dùng số khách đưa trừ
tiền thối thực tế. Khoản thiếu `0 < x < 10000` được lưu rounding và tính đóng đủ;
đúng 10000 trở lên vẫn còn nợ. Không bỏ qua tiền cọc. Credit giữ đúng phần dư.
Báo cáo Khoản bỏ qua lọc kỳ hoá đơn/người thu/toà, tổng hợp ở SQL, phân trang chi tiết.

## Bằng chứng

- 119 test / 9 suite Vitest liên quan: settlement, collectPlan, paymentRecordRpc,
  report parser/dialog, hook single/bulk/quick, reverse sources, mobile form/keypad.
- `scripts/test-invoice-rounding-change.mjs <migration> --repeat-migration`:
  PASS trên DEMO; migration áp hai lần trong transaction rồi rollback toàn bộ.
  Bao gồm ranh giới 0/1/9999/10000, cọc, mixed TM/TK/TT, tiền thối vượt/thiếu,
  retry cùng/khác payload, số đã thu cũ, phân quyền, hai sổ làm tròn khác nhau,
  hoàn tác cả dòng TM thối hết, báo cáo tổng/phân trang/legacy không cộng trùng.
- Mutation `<10000` thành `<=10000` bị test bắt ở JS và SQL. Mutation bỏ số thối
  thực tế bị suite JS bắt. Mutation bỏ kiểm hai chữ số thập phân bị parser test bắt.
- `.e2e-fleet/payment-rounding-components.mjs`: Chromium headless 375×812 và
  1280×900, actual components, không gọi backend. Kiểm 8k/3k bỏ qua, đúng 10k
  còn nợ, số thối ban đầu 0, cọc, reset số khách đưa, credit và payload.
  Không lỗi JavaScript/overflow. Đây là component fixture, không phải live E2E.
- `gate:reconcile-money`: 1.034 phiếu tháng 07–09/2026; SQL = RPC qua JWT/RLS =
  client phân trang = 5.055.848.013đ.
- `gate:reconcile-money-v2`: 20 sổ thật khớp; 3.342 posting lines, SQL = client
  phân trang = 2.956.386.007đ. Cả hai đối chiếu chỉ đọc dữ liệu hiện hành.
- TypeScript baseline: 0 fingerprint. ESLint ratchet: 0 lỗi mới (1.146 lỗi cũ,
  baseline 1.152). Các gate tĩnh khác được chạy qua `gate:truoc-push`.
  Lượt cuối `gate:truoc-push -- --khong-dao-strict`: 41/41 gate xanh; strict chạy riêng.
- Strict và noUncheckedIndexedAccess: 0 lỗi; đã chốt baseline bằng generator.
  Build sản xuất đạt; báo cáo lazy chunk 11.416 byte, nút mở 1.362 byte.
- Review độc lập SQL/frontend đã sửa các lỗi tìm được: legacy cộng trùng,
  chọn sổ cuối khi dời rounding, số thối 0 bị ẩn, reset phương thức/credit,
  bảo vệ cọc và parser tiền thập phân.

## Triển khai và khoảng trống

Migration đã apply production qua `migrate:forward` với bản dump đầy đủ 519 TABLE DATA
entries. Evidence `docs/generated/schema-change-evidence/20260908041231_invoice_actual_change_rounding_report.json`.
Live writer hash và report ACL khớp bản review; canonical types có RPC mới.

HTTP bằng JWT DEMO: cùng key trả hai kết quả giống nhau nhưng chỉ một collection;
khác key chỉ một yêu cầu thắng. Mỗi ca đúng một payment, thực thu3m/thối200k/bỏ qua8k,
đúng một dòng báo cáo. Đảo qua HTTP loại dòng báo cáo và đưa ledger về0; fixture dọn sạch.
Harness cần Content-Profile/Accept-Profile public để khớp Supabase client.

Browser headless dùng frontend tích hợp và backend thật: khách đưa5m/thối200k trên
hoá đơn4.805m → RPC200, paid_amount4.8m, rounding5k, statusPAID. Không lỗi console.
Đảo qua canonical RPC; invoice fixture dọn sạch, sổ fixture archive theo lifecycle và
ledger net0. Đây là app UI + backend thật trên DEMO, bổ sung cho component fixture ở trên.
Việc phát hành frontend được xác minh riêng bằng CI/main và build-sha trên domain production.

Graph freshness high-risk: GitNexus trong ngưỡng; UA cũ được cảnh báo. Graph
detect-changes trả rỗng trên chỉ mục trước các file mới, không được coi là chứng
minh không ảnh hưởng. Việc truy luồng dùng thêm code, SQL harness và review.

Catalog đã đối chiếu sau rebase: `117dd95134ed49b8…` khớp inventory trên main
và evidence `20260908033918_copilot_action_room_pass_active_v1.json`. Drift so với
base cũ `96470e534ddf41f8…` đến từ rollout đó; không phải migration của nhánh này.
Kiểm catalog an toàn độc lập: không object hở RLS/search_path, 12/12 view
security_invoker, không hàm đọc chạm khoá dòng.

Restore-drill PR phát hiện ACL rộng từ baseline `--no-acl`. Bổ sung thu hồi ACL
của `record_invoice_collection_v5` đúng hợp đồng cũ (chỉ authenticated);
harness `--repeat-migration --simulate-restore-acl` đỏ trước sửa, xanh sau sửa,
tất cả trong transaction DEMO rollback.

Sau cả ba migration, đối chiếu chỉ đọc tiếp tục xanh:1.035 phiếu, SQL=JWT/RLS=phân trang
5.058.848.013đ;20 sổ thực khớp,3.362 posting lines khớp2.959.174.007đ. Đây là số đo
tại thời điểm kiểm, không khẳng định sổ sách đang vận hành đứng yên. Riêng bốn phiếu
điều chỉnh giữ nguyên23.560.000đ theo từng snapshot trước/sau.
