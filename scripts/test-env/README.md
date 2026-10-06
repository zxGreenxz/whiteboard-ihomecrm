# Môi trường TEST — bản sao production trên project Supabase riêng

Dùng để thử tính năng mới trên **đúng dữ liệu, tài khoản và vai trò** của production
trước khi phát hành, mà không đụng sổ sách thật.

Đây là **dữ liệu thật được sao chép**, cần bảo vệ như production; fixture tạo khi kiểm mới là dữ
liệu giả. Ưu tiên thử tính năng và migration trên TEST. DEMO vẫn chung database production,
phù hợp fixture nhỏ hoặc kiểm tích hợp được chỉ định rõ.

## Một lệnh tại máy local

Chạy tại worktree chứa mã nguồn cần kiểm; cần `npm ci`, Chrome và PostgreSQL client 17+.
Vault ở checkout chính được tìm qua Git common dir; không sao chép vault.

```sh
# Đầu đợt kiểm / dữ liệu cũ / schema lệch: thay toàn bộ TEST rồi kiểm
npm run test-env:check -- --sync

# Các lượt sửa tiếp: dùng lại snapshot, không xoá dữ liệu mỗi lần
npm run test-env:check
```

Quick yêu cầu lượt sync mới nhất đạt, snapshot không quá 24 giờ, catalog và metadata custom role
(thuộc tính, membership, owner/ACL) chưa đổi từ biên nhận sau hậu kỳ. Có thể chọn tuổi bằng
`--max-age-hours <số giờ>`; report ghi tuổi thực.
Sau migration thử, sync lại để về baseline; chưa có chế độ cấp biên nhận cho schema thử.

Runner giữ khoá chung xuyên suốt sync → JWT/RLS → build → Chrome → cleanup. Sync, `thu-sql` và
JWT harness độc lập dùng cùng khoá; lượt khác gặp khoá bận dừng trước khi ghi. Bộ fleet cũ và
thao tác tay không tự tham gia khoá: không dùng TEST đồng thời với lượt kiểm/đồng bộ.

Ngoài advisory lock, `test_env.active_run` giữ token của lượt đang chạy. Mất kết nối giữ khoá
không cho lượt khác tự chen vào. Ctrl+C/SIGTERM dừng việc mới, chờ thao tác đang gửi hoàn tất và
dọn dưới khoá trước khi thoát. Nếu bị kill cưỡng bức hoặc không xác minh được kết quả ghi/cleanup,
marker được giữ để chặn lượt sau. Không tự xoá marker vì đã quá giờ: cần xác minh mọi tiến trình
và request cũ đã dừng, kiểm biên nhận/nhãn fixture, dọn và đối chiếu trạng thái phiếu/số dư;
sau đó mới xoá đúng token của lượt bị bỏ dở trong khi giữ cùng advisory lock.

Chrome headless build chính worktree với public config TEST, serve loopback và kiểm SHA trên
app; không cần đăng nhập Vercel. Nó kiểm đăng nhập vai thật, xem dữ liệu, tạo phiếu thu tự duyệt/
ghi sổ rồi huỷ, xác nhận bút toán đảo và số dư phục hồi. Fixture JWT được xoá trong `finally`;
phiếu tài chính đã huỷ giữ dấu vết kiểm toán và được liệt kê trong report, không coi là xoá sạch.
Request production, lỗi bắt buộc, bộ test rỗng/skip hoặc cleanup lỗi đều làm lượt kiểm thất bại.

Biên nhận tại `%USERPROFILE%/ihomecrm-backups/test-env-checks/<lượt>/` ghi commit, dirty/digest
nguồn, snapshot, thời gian từng bước, console/network và cleanup. Mã nguồn đổi giữa lượt bị từ
chối. Lượt dirty dùng khi phát triển; phát hành cần commit sạch đã review và CI đúng SHA.
Không lưu password/token hoặc browser storage state vào artifact.

Kiểm local chưa chứng nhận deployment Vercel hay Edge. Với Preview bên dưới, xác minh commit
nhánh `test-env` riêng; không suy rằng Preview đang mang mã worktree.

CI tĩnh/unit/build có thể chạy đồng thời với chuẩn bị TEST. **Sync và browser ghi TEST phải
tuần tự.** Lane này chưa tự chạy trong CI, không thay `promote:production -- --sha <sha>` và
không tự phát hành chỉ vì đồng bộ xong. Không đồng bộ mỗi lần sửa UI; dùng quick giữa các lượt.
Thời gian thực nằm trong `seconds`/`stages` của biên nhận, không cam kết số phút cố định.

| | |
|---|---|
| Project Supabase | `ihomecrm-test` (ref, mật khẩu DB, key, PAT trong vault `CLAUDE.local.md`) |
| Web | Preview của nhánh `test-env`: <https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app> |
| Đăng nhập | Tên tài khoản như production, **mật khẩu TEST riêng** (dòng `TEST_PASS <email> <mật khẩu>` trong vault). Mật khẩu TẤT ĐỊNH = HMAC(`TEST_ENV_PASSWORD_SEED`, email), nên chạy tại máy hay trên CI đều ra cùng giá trị; mật khẩu thật không đăng nhập được TEST. Tài khoản fixture `demo.*` giữ mật khẩu production để bộ E2E chạy được |
| Không có | Byte ảnh/file. URL Supabase ảnh cũ khác origin TEST hiện placeholder; đường dẫn đã đổi sang TEST nhưng không có bytes có thể trả 404. File thực upload vào TEST dùng bình thường |

## Dùng như thế nào

**Đồng bộ dữ liệu mới nhất** (xoá sạch TEST rồi chép lại từ production):

- Trong app TEST: *Cài đặt → Tổ chức → Đồng bộ dữ liệu mới nhất* (mở workflow
  [`test-env-sync.yml`](../../.github/workflows/test-env-sync.yml) → *Run workflow*).
- Dòng lệnh: `npm run test-env:sync` (thêm `-- --giu-dump` để giữ file dump).

**Đưa bản web cần thử lên TEST**: đẩy commit vào nhánh `test-env`
(`git push origin <sha>:test-env` khi fast-forward; không force-push bỏ qua công việc khác). Vercel tự build với biến
môi trường riêng của nhánh này (URL/key TEST + `VITE_APP_ENV=test` ⇒ nhãn "MÔI TRƯỜNG TEST").

**Edge function trên TEST**: `npm run test-env:edge` (cần `TEST_SUPABASE_PAT`, chạy tại máy) — deploy
`admin-create-user`, `llm-proxy`, `salary-v5-jobs`, `demo-reset`, `send-push` từ mã repo với đúng cờ
`verify_jwt` của production. Secret: `OPENROUTER_API_KEY` (Copilot), `CRON_SECRET`/`DEMO_RESET_SECRET`
sinh riêng cho TEST; KHÔNG có VAPID nên không đẩy được thông báo tới thiết bị thật. Function sống
ngoài database: đồng bộ không xoá, chỉ chạy lại khi mã function đổi.

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
4. **Tái lập custom roles hạn chế từ snapshot**, trung hoà default privileges của `postgres`
   rồi `pg_restore` GIỮ ACL. Owner/ACL hàm custom được phục hồi trước bước kiểm;
   metadata role quản trị bất thường làm script dừng. Supabase mặc định cấp
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
7. **Hậu kỳ**: thay ref production trong các thân hàm ghim host (danh sách thực do catalog quyết định),
   xoá `push_subscriptions` (thiết bị thật), dựng lại cron (trừ
   `clone_org_sync_worker` và hai watchdog Network Center — không worker nào báo nhịp về TEST),
   cấu hình Auth (tắt đăng ký tự do) và Data API giống production, chờ Data API nạp xong schema
   cache (ngay sau khôi phục trả 503 PGRST002 vài chục giây), ghi `test_env.lich_su`.
8. **`ANALYZE`** cả database (~20 s). `pg_restore` không tự làm: đo 24/09/2026 sau một lượt đồng bộ,
   302/431 bảng chưa từng có thống kê (bảng nhỏ không bao giờ chạm ngưỡng autoanalyze) nên bộ lập
   kế hoạch đoán mò.

## Chốt an toàn

`batBuocDichTest()` chạy trước mọi lệnh ghi, ba lớp độc lập: ref khác production; tên project qua
Management API phải là `ihomecrm-test`; bảng `test_env.danh_dau` trong database đích phải chứa đúng
ref TEST (chỉ được tạo khi database còn trống). Trỏ nhầm chuỗi kết nối sang production vẫn dừng.
Advisory lock trên TEST dùng chung cho đồng bộ, runner kiểm, JWT harness và thử SQL.
Lịch sử RUNNING/FAILED chặn quick dùng lại biên nhận DAT cũ khi đồng bộ bị ngắt.
Lần đồng bộ sau thay toàn bộ thay đổi TEST; không có chiều đồng bộ TEST về production.

Bản dump chứa dữ liệu cá nhân thật: ghi ở `%USERPROFILE%/ihomecrm-backups/test-env/` (ngoài repo)
và xoá khi xong, kể cả khi bị ngắt (SIGINT/SIGTERM). Không có kênh gửi ra ngoài nào nối vào TEST: worker Zalo và Network Center chỉ
trỏ production, edge function TEST không có khoá VAPID/Zalo.

## Giới hạn đã biết

- Project TEST ở tổ chức Supabase gói Free: database tối đa 500 MB, tự tạm dừng sau 7 ngày không dùng
  (vào dashboard bấm Restore rồi đồng bộ lại).
- Upload ảnh phòng lên R2 (`room-sale-images`) xác thực bằng project production ⇒ báo lỗi trên TEST.
- URL R2/CDN ngoài Supabase không tự biến thành fixture. Bộ Chrome này chặn các đích CRM ngoài
  TEST; chưa chứng nhận R2, Zalo, push, extension, Edge hoặc gọi mô hình ngoài. Kiểm file cần fixture TEST riêng.
- Extension tạm trú chỉ nhận tin từ `ptcrm.vercel.app`.
- **Tốc độ** (đo 24/09/2026, cùng truy vấn danh sách Thu chi của chủ công ty): TEST ở máy Nano của gói
  Free, production ở máy Micro. Một người dùng: ngang nhau (~0,6–0,8 s, TEST đôi khi giật tới ~2 s vì
  CPU dùng chung); 3 truy vấn song song: 1,0 s so với 1,2 s; 8 song song: tới 2,8 s so với 5,7 s. Dùng
  tay bình thường không thấy khác. Chỉ E2E mở nhiều trình duyệt cùng lúc (mỗi trang Thu chi bắn ~40
  request) mới chạm `57014 statement timeout` ⇒ chạy E2E trên TEST với `FLEET_WORKERS=1`. Sau khi TEST
  ngủ lâu, lượt đầu có thể gặp 503 PGRST002 hoặc chậm vì cache nguội — tải lại là hết.
- **Dòng mồ côi**: production từng có 16 khoá ngoại vấp dòng mồ côi (tàn dư xoá org TEST/DEMO 08/08
  chạy `session_replication_role=replica`); đã dọn 23/09/2026 (`20260923162145`), lượt đồng bộ sau đó
  dựng 0 khoá `NOT VALID`. Nhánh `NOT VALID` trong `khoi-phuc.mjs` giữ lại phòng khi tái diễn.
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
| `hau-ky.mjs` | thay ref, push, mật khẩu TEST, cron, `ANALYZE`, lịch sử |
| `cau-hinh.mjs` | Auth + Data API qua Management API |
| `sync.mjs` | điều phối |
| `check.mjs`, `receipt.mjs`, `lock.mjs` | luồng kiểm đầy đủ/nhanh, biên nhận và khoá chung |
| `chrome.mjs` | build đúng nguồn, Chrome thật, lifecycle và cleanup |
| `owners.mjs` | snapshot và phục hồi vai hạn chế, owner/ACL |
| `thu-sql.mjs` | chạy thử một file SQL lên TEST |
| `edge.mjs` | deploy edge function + secret lên TEST |
