# Kết quả đo tải, egress và khôi phục — OpenClaw Zalo

Cập nhật: 2026-08-03. Máy chạy: workstation phát triển (Windows 11, không Docker).

Tài liệu này ghi **cả phần đo được lẫn phần không đo được**. Một trang kết quả chỉ
liệt kê những gì đã chạy sẽ khiến người đọc tưởng phần còn lại đã ổn.

## 1. Kế hoạch truy vấn đường nóng — ĐÃ ĐO

Chạy trên database dùng-một-lần (PGlite, PostgreSQL 18.3) với **10.001 hội thoại**
seed, `ANALYZE` xong mới đo. Bằng chứng: `scripts/__tests__/openclaw-query-plans.test.mjs`.

| Truy vấn | Trước khi sửa | Sau khi sửa |
| --- | --- | --- |
| Trang đầu hộp thư (`openclaw_list_conversations_v1`) | Seq Scan + Sort, chạm **10.001** dòng để trả 50 | Index scan, < 1.000 dòng |
| Trang kế theo con trỏ keyset | Seq Scan + Sort, chạm **10.000** dòng | Index scan, < 1.000 dòng |
| Danh sách có lọc `status` | Index scan, 50 dòng | không đổi |

**Nguyên nhân**: `openclaw_conversations_active_idx` là
`(organization_id, account_id, status, last_received_at desc, id desc)` — cột
`status` nằm giữa cột lọc và cột sắp xếp, trong khi RPC không lọc theo `status`.

**Đã sửa**: thêm `openclaw_conversations_recent_idx`
`(organization_id, account_id, last_received_at desc, id desc)`. Đã tạo trên
production bằng `CREATE INDEX CONCURRENTLY`, `indisvalid = true`.

**Giới hạn của phép đo này**: các khẳng định là về **hình dạng kế hoạch**, không
phải thời gian. PGlite là bản WebAssembly một kết nối; số mili-giây của nó không
đại diện cho Supabase. Planner thì là PostgreSQL thật nên kết luận "có dùng index
hay không" chuyển được sang production.

## 2. So sánh baseline máy chủ chuyên dụng — ĐÃ ĐO (bằng fixture)

Bằng chứng: `scripts/__tests__/openclaw-host-isolation.test.mjs` (17 test) trên
`infra/openclaw-zalo/test/fixtures/host-baseline.redacted.json`.

Code so sánh (`infra/openclaw-zalo/scripts/openclaw-host-baseline-diff.mjs`) từ
chối: container bị tạo lại (Id đổi dù image y hệt), image/network/mount/port lệch,
RestartCount tăng, systemd đổi trạng thái, đĩa gốc hụt quá ngưỡng, thiếu bằng
chứng SLO endpoint mô hình, và **mọi dấu vết credential hoặc host 9Router** trong
baseline.

Đã kiểm bằng 5 phép đột biến — mỗi phép phá đúng một khẳng định và test phải đỏ.
Một phép ban đầu **không** đỏ: nhánh kiểm `exitcode` của curl không gánh gì vì mọi
ca thử đều đã bị nhánh `status` bắt trước. Đã bổ sung ca `status=200` kèm
`exitcode=28` (curl bắt đầu nhận rồi đứt) để nhánh đó gánh thật.

**Giới hạn**: chạy hoàn toàn trên fixture. Không SSH, không mở socket Docker,
không đụng service production — đúng yêu cầu của Task 28 Step 4. Việc so sánh với
máy chủ **thật** thuộc Task 29.

## 3. CHƯA ĐO ĐƯỢC — cần hạ tầng máy này không có

| Hạng mục | Vì sao chưa đo được |
| --- | --- |
| Soak 7 ngày (100 hội thoại, burst 30 tin/phút) | Cần adapter giả + đồng hồ tất định của Task 26 Step 3 |
| Tiêm sự cố: mất tiến trình, Supabase/R2 gián đoạn, đá phiên, hỏng trang spool, ENOSPC 20 GiB | Cần container/namespace dùng-một-lần |
| p95 độ trễ hàng đợi, CPU/RAM/swap, egress DB, đếm request R2 | Cần cell chạy thật |
| Baseline máy chủ chuyên dụng **thật** | Chỉ đọc trên host thật — thuộc Task 29 |

Lý do chung: máy chạy **không có Docker, không Docker Desktop, không WSL distro**,
nên `supabase start` và mọi diễn tập dựa trên container đều không khởi động được.
Đây là giới hạn môi trường, không phải hạng mục bị bỏ qua.

**Không được coi các mục ở mục 3 là đã kiểm.**
