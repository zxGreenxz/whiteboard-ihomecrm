# Công ty TEST — bản sao dữ liệu công ty thật

Org thứ 3 trong chính project Supabase này, mang **đúng dữ liệu nghiệp vụ của công
ty thật**, dùng để thử tính năng mới / kiểm thử plan mà không đụng sổ sách thật.

| | |
|---|---|
| Org TEST | `cccc0000-0000-4000-8000-000000000001` — slug `ihome-test`, tên "iHome CRM (Test)" |
| Org THẬT | `aaaa0000-0000-4000-8000-000000000001` |
| Org DEMO | `dddd0000-0000-4000-8000-000000000001` (seed tay, 2 toà — **không** phải bản sao) |
| Tài khoản | `test.nguyentamca165` (OWNER), `test.nathan`, `test.joey` (STAFF), `test.bosshuy` (PARTNER) — đăng nhập bằng tên tài khoản, mật khẩu ở `CLAUDE.local.md` |
| Quy mô | ~26.600 dòng / 109 bảng, số tiền khớp 100% với công ty thật |

## Dùng như thế nào

**Đồng bộ lại dữ liệu mới nhất** (xoá sạch bản sao rồi chép lại):

- Trong app: *Cài đặt → Tổ chức → thẻ "iHome CRM (Test)" → Đồng bộ dữ liệu mới nhất*
  (chỉ super admin thấy). Bấm xong chờ ~15 giây job nền nhặt đơn, chạy ~10 giây.
- Dòng lệnh: `node scripts/clone-org/clone.mjs`

**Ảnh/biên lai** không nằm trong DB nên không đi kèm lượt đồng bộ:
`node scripts/clone-org/copy-files.mjs` (2.832 object / 1,3 GB, chạy lại được, bỏ qua file đã có).

**Kiểm chứng** sau mỗi thay đổi lớn:

```bash
node scripts/clone-org/verify.mjs          # rò rỉ ngược, đủ dòng, khớp tiền, cách ly tài khoản
node scripts/clone-org/snapshot.mjs after  # tài khoản THẬT có nhìn thấy dữ liệu org TEST không
```

**Gỡ**: `node scripts/clone-org/rollback.mjs --data` (chỉ xoá dữ liệu) hoặc `--all`
(xoá luôn tài khoản, org và policy).

## Vì sao lại làm theo cách này

### 1. Phải giấu org TEST khỏi super admin, nếu không mọi báo cáo bị nhân đôi

App **không có nút chuyển công ty**: `my_org_ids()` trả về mảng và policy biên giới
là `organization_id IN my_org_ids()`, nên user thuộc 2 org thấy hợp nhất cả hai.
Nặng hơn: `is_super_admin()` có mặt trong hầu hết policy SELECT nên super admin
thấy MỌI org dù không là thành viên.

Hai lớp chặn:

- `*_hide_sandbox_admin` — 220 policy RESTRICTIVE, một cho mỗi bảng public có
  `organization_id` và bật RLS (`20260801020000`, sửa NULL-safe ở `20260801040000`).
- `can_access_building()` — chặn toà thuộc org sandbox với người không có
  membership ở đó (`20260801050000`). RLS **không** với tới hàm SECURITY DEFINER,
  mà gần hết báo cáo tiền/lấp đầy đều lọc toà qua hàm này.

### 2. Ba cái bẫy đã cắn trong lúc dựng (đừng dẫm lại)

- **`NULL = ANY(...)` ra NULL** → policy RESTRICTIVE giấu luôn dòng
  `organization_id IS NULL` của **công ty thật**: inspection_photos 477→254,
  building_fee_accounts 133→109, settings 8→6. Phải bọc `COALESCE(..., false)`.
- **`fa_occupancy_monthly` trả 432 dòng thay vì 228** — thừa 12 toà của org TEST,
  do `can_access_building()` có nhánh tắt `is_super_admin() OR …`. Đây là bằng
  chứng sống cho lớp lỗi "RPC SECURITY DEFINER không lọc org".
- **Đo bằng số đếm trước/sau là sai** — cron 16:55 UTC (`finance_month_snapshot`)
  sinh vài trăm bút toán mỗi đêm, và phân trang PostgREST không `order` thì hai
  lần chụp ra hai tập dòng khác nhau. Phép đo đúng nằm ở `snapshot.mjs`: hỏi
  thẳng "tài khoản thật có thấy dòng nào mang org TEST không" → phải là 0/158.

### 3. Bộ chép nằm trong DB, không nằm trong JS

`clone_org.do_sync()` (`20260801060000` + `20260801070000`) là nguồn sự thật duy
nhất; `clone.mjs` chỉ gọi nó. Các ràng buộc bắt buộc:

- **`session_replication_role='replica'`** — tắt 407 trigger + kiểm tra FK. Không
  tắt thì trigger sinh mã / guard khoá sổ / bút toán băm nát dữ liệu chép. Nhờ tắt
  FK nên không cần sắp thứ tự bảng (DB có 6 cặp FK vòng, 10 self-FK).
- **UNIQUE INDEX vẫn còn hiệu lực** — cố ý: va chạm phải nổ chứ không im lặng.
  11 cột mã unique toàn cục (`invoices.invoice_number`, `accounts.code`,
  `contracts.public_code`…) được thêm hậu tố `-T`.
- **Ánh xạ id theo GIÁ TRỊ mọi cột uuid**, không theo FK — rất nhiều tham chiếu
  thật không có FK (`finance_invoice_components.invoice_id`,
  `income_expenses.posting_id`, `finance_room_month_snapshots.room_id`…).
  `map_text()` đổi cả uuid nhúng trong text/jsonb, nhờ đó URL ảnh của bản sao rơi
  vào thư mục của user test — không dùng chung object nào với công ty thật.
- **2 trigger ENABLE ALWAYS** (`approval_rule_sets`, `approval_rules`) vẫn chạy
  trong replica mode → phải tắt/bật ngay trong cùng transaction.
- **Nút bấm phải đi qua hàng đợi**: Supabase chỉ cho role `postgres` đặt
  `session_replication_role`; `authenticated` và `service_role` đều nhận 42501 kể
  cả trong SECURITY DEFINER. Nên nút chỉ insert 1 dòng vào `clone_org.sync_request`,
  job pg_cron `clone_org_sync_worker` (15 giây/lần, chạy dưới username `postgres`)
  nhặt đơn và chạy.

### 4. Những gì KHÔNG chép

45 bảng trong `clone_org.skip_table` (có ghi lý do từng bảng):

- **Kênh gửi ra ngoài** — `zalo_*`, `notifications`, `push_*`. `worker/index.js`
  quét `zalo_send_queue` **không lọc org**, chép là nhắn trúng khách thật.
- **Nhật ký/audit** — chiếm 2/3 số dòng mà không có giá trị test.
- **Trang công khai** — `public_room_*`, `lucky_*`: chép là sinh link công khai.
- **`super_admins`** — tuyệt đối không, super admin bypass xuyên tenant.

Ngoài ra SĐT/email/zalo của khách bị **làm nhiễu** (tên, số tiền, ngày tháng giữ
nguyên), và `income_expenses.attachments` bị xoá link — đó là chỗ **duy nhất** app
có nút xoá file storage (`AttachmentUpload` → `src/lib/storage.ts:156`).

### 5. Dòng bị bỏ có chủ ý

`verify.mjs` báo 2 bảng thiếu dòng — cả hai là dữ liệu hỏng sẵn của công ty thật:

- `profit_unallocated_decisions` 52→18: 34 dòng trỏ vào `profit_monthly` **đã bị xoá**.
- `building_services` 262→234: 28 dòng nối toà THẬT với dịch vụ của org **DEMO**.

## File

| File | Việc |
|---|---|
| `create-users.mjs` | dựng org + 4 tài khoản `test.*` + `clone_org.user_map` |
| `clone.mjs` | gọi `clone_org.do_sync()` |
| `mask.mjs` | copy 8 file mẫu hợp đồng sang path user test |
| `copy-files.mjs` | copy 2.832 object storage (ảnh, biên lai) |
| `verify.mjs` | 4 phép kiểm sau khi chép |
| `snapshot.mjs` | cửa chặn rò rỉ, đo qua JWT của tài khoản thật |
| `rollback.mjs` | gỡ `--data` / `--all` |
