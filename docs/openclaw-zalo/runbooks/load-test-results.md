# Kết quả đo tải, egress và khôi phục — OpenClaw Zalo

Cập nhật: 2026-08-05. Máy chạy: workstation phát triển (Windows 11 + WSL2 + Docker Desktop 4.85).

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

### 1b. Đo lại trên PostgreSQL 17.6 thật — ĐÃ ĐO 05/08/2026

Giới hạn ngay trên đã được gỡ. Đo lại trên container
`supabase/postgres:17.6.1.156` nạp schema production bằng `pg_dump --schema-only`
(xem `scripts/openclaw-local-stack.mjs`) — **cùng phiên bản với production**, nên
lần này thời gian có nghĩa. 10.001 hội thoại, `ANALYZE` xong mới đo.

| Truy vấn | Kế hoạch | Buffers | Execution |
| --- | --- | --- | --- |
| Trang đầu hộp thư | Index Scan `openclaw_conversations_recent_idx` | 3 shared hit | 0,026 ms |
| Trang kế theo con trỏ keyset | Index Scan `openclaw_conversations_recent_idx` | 5 shared hit | 0,037 ms |
| Danh sách lọc `status` | Index Scan `recent_idx` + Filter | 3 shared hit | 0,060 ms |

Không Seq Scan, không Sort ở cả ba. Buffers 3–5 trên bảng 10.001 dòng là O(trang)
chứ không O(bảng), và trang kế đắt ngang trang đầu — đúng thứ keyset sinh ra để
làm.

**Một khác biệt so với bản đo PGlite, ghi lại để không ai tưởng là hồi quy**:
truy vấn lọc `status` nay chạy `recent_idx` kèm `Filter: (status = 'OPEN')` chứ
không phải `active_idx`. Planner của PG 17.6 thấy `recent_idx` rẻ hơn vì nó dẫn
thẳng theo thứ tự sắp xếp; `active_idx` vẫn đúng, chỉ là không được chọn. Kết
luận "phục vụ từ index" vẫn giữ.

**Vẫn còn giới hạn**: đây là schema-only, không có dữ liệu production, và chạy
trên máy phát triển chứ không phải cấu hình instance của Supabase. Con số tuyệt
đối không chuyển thẳng sang production; thứ chuyển được là hình dạng kế hoạch và
bậc độ phức tạp.

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

| Hạng mục | Vì sao chưa đo được | Trạng thái 05/08/2026 |
| --- | --- | --- |
| Soak 7 ngày (100 hội thoại, burst 30 tin/phút) | Cần adapter giả + đồng hồ tất định của Task 26 Step 3 | **Vẫn chặn** — và chặn sâu hơn tưởng, xem dưới |
| Tiêm sự cố: mất tiến trình, Supabase/R2 gián đoạn, đá phiên, hỏng trang spool, ENOSPC 20 GiB | Cần container/namespace dùng-một-lần | **Đã mở khoá** — Docker Desktop 4.85 / Engine 29.6.2 + WSL2 đã cài |
| p95 độ trễ hàng đợi, CPU/RAM/swap, egress DB, đếm request R2 | Cần cell chạy thật | Vẫn chặn |
| Baseline máy chủ chuyên dụng **thật** | Chỉ đọc trên host thật — thuộc Task 29 | Vẫn thuộc Task 29 |

Lý do chung **trước 05/08/2026**: máy chạy không có Docker, không WSL distro, nên
`supabase start` và mọi diễn tập dựa trên container đều không khởi động được.

**Cập nhật 05/08/2026.** Docker Desktop 4.85 (Engine 29.6.2) và WSL2 đã cài, và
`supabase start` vẫn **không** dùng được — nhưng vì lý do khác hẳn: repo có 35 cặp
file migration trùng số version (cặp `016` có từ 21/11/2025, cả 35 đều trên
`origin/main`), nên CLI chết ở UNIQUE của `schema_migrations`; và replay theo tên
file cũng hỏng ở tầng SQL vì `016_meter_readings_enhancements.sql` đọc
`contracts.building_id`, cột **không migration nào tạo ra** — điều repo đã tự ghi
ở `scripts/network-center-disposable-db.mjs:958-972`.

Thay vào đó, stack cục bộ được dựng tay từ `pg_dump --schema-only` của
production: `scripts/openclaw-local-stack.mjs` (Postgres 17.6 + PostgREST +
GoTrue + gateway) và `scripts/openclaw-local-seed.mjs`. Mục 1b ở trên là kết quả
đầu tiên đo được nhờ nó.

**Vì sao soak vẫn chặn, và đừng cố lách**: soak cần một tài khoản ở trạng thái
`CONNECTED`, mà `app_private.openclaw_guard_activation_v1()` từ chối mọi lần
kích hoạt nếu chưa có dòng `public.openclaw_rollout_runs` hợp lệ — status
RUNNING/COMPLETE, `migration_manifest_sha256` 64-hex, `artifact_digests` khớp
`cellImageDigest`/`cellConfigDigest`/`cellReviewedCommitSha`, **và `project_ref`
ghim cứng `tryymsxyyckgbrmmvozx`**. Nói cách khác **Task 28 (và ba kịch bản cuối
của Task 26) phụ thuộc artifact của Task 29**, một ràng buộc thứ tự mà bản kế
hoạch không xếp. Chế một dòng rollout giả để soak chạy được chính là phá cơ chế
ngăn OpenClaw bật lên khi chưa qua rollout được duyệt.

**Không được coi các mục còn "Vẫn chặn" là đã kiểm.**
