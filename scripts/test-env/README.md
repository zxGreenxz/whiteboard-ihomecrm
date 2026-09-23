# Môi trường TEST — bản sao production trên project Supabase riêng

Dùng để thử tính năng mới trên **đúng dữ liệu, tài khoản và vai trò** của production
trước khi phát hành, mà không đụng sổ sách thật.

| | |
|---|---|
| Project Supabase | `ihomecrm-test` (ref, mật khẩu DB, key, PAT trong vault `CLAUDE.local.md`) |
| Web | Preview của nhánh `test-env`: <https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app> |
| Đăng nhập | Tên tài khoản như production, **mật khẩu TEST riêng** (dòng `TEST_PASS <email> <mật khẩu>` trong vault). Mật khẩu TẤT ĐỊNH = HMAC(`TEST_ENV_PASSWORD_SEED`, email), nên chạy tại máy hay trên CI đều ra cùng giá trị; mật khẩu thật không đăng nhập được TEST. Tài khoản fixture `demo.*` giữ mật khẩu production để bộ E2E chạy được |
| Không có | Byte ảnh/file (chủ chốt 23/09/2026: chỉ chép dữ liệu chữ). Mở ảnh cũ sẽ báo không tìm thấy |

## Dùng như thế nào

**Đồng bộ dữ liệu mới nhất** (xoá sạch TEST rồi chép lại từ production):

- Trong app TEST: *Cài đặt → Tổ chức → Đồng bộ dữ liệu mới nhất* (mở workflow
  [`test-env-sync.yml`](../../.github/workflows/test-env-sync.yml) → *Run workflow*).
- Dòng lệnh: `npm run test-env:sync` (thêm `-- --giu-dump` để giữ file dump).

**Đưa bản web cần thử lên TEST**: đẩy commit vào nhánh `test-env`
(`git push origin <sha>:test-env`, thêm `--force` khi lùi về commit cũ hơn). Vercel tự build với biến
môi trường riêng của nhánh này (URL/key TEST + `VITE_APP_ENV=test` ⇒ nhãn "MÔI TRƯỜNG TEST").

**Thử migration trước production**: `npm run test-env:thu-sql -- supabase/migrations/<file>.sql`
(mặc định ROLLBACK; `--ghi` để COMMIT vào TEST). Đổi schema production vẫn chỉ đi
`npm run migrate:forward` (Contract §4). Lần đồng bộ sau ghi đè mọi thay đổi chưa lên production.

## Đồng bộ làm gì, và vì sao đáng tin

1. **Xuất** production trong MỘT snapshot: một phiên psql giữ transaction REPEATABLE READ READ ONLY,
   hai tiến trình `pg_dump --snapshot` dùng chung snapshot đó, và phiên psql đo vân tay + băm từng bảng
   cũng trong snapshot đó. Production chỉ bị đọc.
2. **Xoá sạch** schema ứng dụng TEST theo lô (DROP một phát vượt `max_locks_per_transaction`).
3. **Nạp** `auth.users`/`auth.identities` (kiểm đủ số tài khoản) và **đặt ngay mật khẩu TEST** — trước
   mọi bước dễ lỗi, để lượt đứt giữa chừng cũng không để lại hash mật khẩu thật trên TEST. Dựng
   bucket, chép **dòng** `storage.objects` với đúng id (khoá ngoại `app_private.ie_supplement_objects`).
4. **Trung hoà default privileges** của `postgres` rồi `pg_restore` GIỮ ACL — Supabase mặc định cấp
   quyền anon trên object mới, còn pg_dump chỉ ghi ACL dưới dạng chênh lệch so với mặc định; bỏ bước
   này thì mọi hàm production đã REVOKE khỏi anon sẽ mở lại trên TEST. Hai lượt: hàm trước (cột sinh
   `rooms.name_sort` inline `room_sort_key` → `natural_sort_key`), rồi phần còn lại. Câu lỗi vì
   deadlock của `-j 4` được phát lại tuần tự; khoá ngoại vấp dòng mồ côi dựng `NOT VALID`.
5. **Tái lập** phần cắm vào nền tảng mà `pg_dump -n` không mang theo: 50 policy + 2 trigger trên
   `storage.objects`, trigger `on_auth_user_created`, event trigger `org_boundary_tu_dong`, bảng trong
   publication realtime, `statement_timeout` của anon/authenticated, default privileges.
6. **Kiểm**: ~8.000 object (thân hàm, ACL bỏ grantor, policy, trigger, index, constraint, cột, kiểu,
   default ACL, event trigger, publication) và mã băm NỘI DUNG của ~490 bảng phải khớp production
   tuyệt đối. Lệch một chỗ ⇒ exit 1, kết quả ghi `kiem.json` trong thư mục làm việc. Hai loại khác
   biệt được báo nhưng không tính lệch: CHECK chỉ khác ngoặc (pg_dump in `(a AND b) AND c`, restore làm
   phẳng) và khoá ngoại dựng `NOT VALID`.
7. **Hậu kỳ**: thay ref production trong thân hàm (chỉ `append_income_expense_supplement_v1` ghim
   host storage), xoá `push_subscriptions` (thiết bị thật), dựng lại cron (trừ
   `clone_org_sync_worker` và hai watchdog Network Center — không worker nào báo nhịp về TEST),
   cấu hình Auth (tắt đăng ký tự do) và Data API giống production, chờ Data API nạp xong schema
   cache (ngay sau khôi phục trả 503 PGRST002 vài chục giây), ghi `test_env.lich_su`.

## Chốt an toàn

`batBuocDichTest()` chạy trước mọi lệnh ghi, ba lớp độc lập: ref khác production; tên project qua
Management API phải là `ihomecrm-test`; bảng `test_env.danh_dau` trong database đích phải chứa đúng
ref TEST (chỉ được tạo khi database còn trống). Trỏ nhầm chuỗi kết nối sang production vẫn dừng.
Advisory lock trên TEST: hai lượt đồng bộ không chạy chồng nhau.

Bản dump chứa dữ liệu cá nhân thật: ghi ở `%USERPROFILE%/ihomecrm-backups/test-env/` (ngoài repo)
và xoá khi xong, kể cả khi bị ngắt (SIGINT/SIGTERM). Không có kênh gửi ra ngoài nào nối vào TEST: worker Zalo và Network Center chỉ
trỏ production, edge function TEST không có khoá VAPID/Zalo.

## Giới hạn đã biết

- Project TEST ở tổ chức Supabase gói Free: database tối đa 500 MB, tự tạm dừng sau 7 ngày không dùng
  (vào dashboard bấm Restore rồi đồng bộ lại).
- Upload ảnh phòng lên R2 (`room-sale-images`) xác thực bằng project production ⇒ báo lỗi trên TEST.
- Extension tạm trú chỉ nhận tin từ `ptcrm.vercel.app`.
- **Dòng mồ côi trên production**: 16 khoá ngoại (vd `income_expense_flow_ownership`,
  `termination_forfeit_authorizations`, `payment_reversals`) mang cờ "đã kiểm" nhưng có dòng trỏ tới
  bản ghi đã xoá — tàn dư lần xoá org TEST/DEMO 08/08 chạy `session_replication_role=replica`. Mọi lần
  khôi phục thảm hoạ bằng pg_dump cũng sẽ vấp đúng chỗ này; TEST dựng chúng `NOT VALID`.
- Trên CI, workflow không mang PAT của TEST (PAT đó là của tài khoản chủ, thấy cả production) ⇒ bỏ
  lớp chốt "tên project qua API" và bước cấu hình Auth/Data API (đã áp một lần từ máy); lớp dấu trong
  database vẫn chặn. Secret đặt ở cấp repo như các secret production sẵn có.
- Mỗi lượt giữ một transaction REPEATABLE READ trên production ~2–3 phút và băm toàn bộ dòng —
  nên chạy ngoài giờ cao điểm.

## File

| File | Việc |
|---|---|
| `lib.mjs` | credential, chốt an toàn, kết nối, psql |
| `van-tay.mjs` | vân tay catalog + băm nội dung bảng, hàm so |
| `xuat.mjs` | xuất production trong một snapshot |
| `khoi-phuc.mjs` | xoá sạch, nạp auth, trung hoà quyền, pg_restore, tái lập nền tảng |
| `tep.mjs` | bucket + dòng `storage.objects` (không byte) |
| `hau-ky.mjs` | thay ref, push, mật khẩu TEST, cron, lịch sử |
| `cau-hinh.mjs` | Auth + Data API qua Management API |
| `sync.mjs` | điều phối |
| `thu-sql.mjs` | chạy thử một file SQL lên TEST |
