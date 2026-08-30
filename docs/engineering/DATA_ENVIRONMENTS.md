---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - scripts/clone-org/lib.mjs
  - scripts/clone-org/snapshot.mjs
  - scripts/clone-org/create-users.mjs
  - scripts/clone-org/verify.mjs
  - scripts/clone-org/rollback.mjs
  - scripts/clone-org/README.md
  - scripts/reconcile-money.mjs
  - scripts/docs-demo/seed-p0.mjs
  - supabase/migrations/20260713100000_sprint1_organization_foundation.sql
  - supabase/migrations/20260703110000_hide_demo_from_real_admins.sql
  - supabase/migrations/20260801020000_sandbox_org_hide_from_super_admin.sql
  - supabase/migrations/20260801040000_fix_sandbox_hide_null_org.sql
  - supabase/migrations/20260801050000_sandbox_org_building_scope.sql
  - supabase/migrations/20260801080000_org_isolation_reports_and_gaps.sql
  - supabase/migrations/20260725190000_authz_read_rpcs.sql
  - supabase/migrations/20260726010000_authz_admin_write_rpcs.sql
  - supabase/migrations/20260726020000_authz_admin_read_rpcs.sql
  - supabase/migrations/20260728180000_room_price_history.sql
  - supabase/migrations/20260731070000_lucky_draw_events.sql
  - supabase/config.toml
  - scripts/check-agent-contract.mjs
  - docs/engineering/PROJECT_CONTRACT.md
  - tooling/local-credential-contract.json
  - package.json
  - worker/index.js
  - .e2e-fleet/playwright.config.ts
  - .e2e-fleet/specs/auth.ts
copilot_ingest: false
risk: security
---

# Các môi trường dữ liệu

**Không có môi trường staging.** Ba "môi trường" của hệ này là **ba tổ chức nằm chung một
database Supabase** (`project_id = "tryymsxyyckgbrmmvozx"` — `supabase/config.toml:1`). Nghĩa là
ranh giới giữa dữ liệu thật và dữ liệu tập dượt **không phải** là ranh giới hạ tầng, mà là một
tập policy RLS + hàm SECURITY DEFINER. Ranh giới kiểu đó **im lặng khi hỏng**: không có kết nối
nào đứt, không có 500 nào, chỉ có con số trên màn hình chủ nhà lớn lên gấp đôi.

Luật quyền ghi (THẬT **chỉ-đọc**; DEMO và TEST đều đọc + ghi) nằm ở
[`PROJECT_CONTRACT.md` §2](PROJECT_CONTRACT.md) — trang này không chép lại, chỉ giải thích
**cơ chế nào cưỡng chế nó** và **những chỗ cơ chế đó không với tới**.

---

## 1. Ba tổ chức

| Org | ID | Sinh ra ở đâu | Dữ liệu |
|---|---|---|---|
| **THẬT** | `aaaa0000-0000-4000-8000-000000000001` (slug `ihome-prod`) | `supabase/migrations/20260713100000_sprint1_organization_foundation.sql:136` | Sổ sách tiền thật của công ty đang vận hành |
| **DEMO** | `dddd0000-0000-4000-8000-000000000001` (slug `ihome-demo`) | cùng migration, cùng câu INSERT | Seed **tay**, 2 toà `DEMOA`/`DEMOB` — `scripts/docs-demo/seed-p0.mjs:6` |
| **TEST** | `cccc0000-0000-4000-8000-000000000001` (slug `ihome-test`, tên "iHome CRM (Test)") | `scripts/clone-org/create-users.mjs:30-34`, hằng số ở `scripts/clone-org/lib.mjs:42-44` | **Bản sao 1:1 dữ liệu công ty thật** |

Khác biệt quan trọng nhất giữa DEMO và TEST — và là chỗ hay bị nhầm: **DEMO là dữ liệu bịa,
TEST là dữ liệu thật đã nhân bản.** Migration `20260801080000_org_isolation_reports_and_gaps.sql:25`
ghi số đo thời điểm đó: hợp đồng 321/321, phiếu thu chi 2301/2301, hoá đơn 1101/1101 — bản sao
khớp từng dòng với org thật. Vì thế mọi rò rỉ từ TEST sang mắt người thật đều biểu hiện đúng một
kiểu: **số liệu nhân đôi**, chứ không phải "xuất hiện dòng lạ dễ nhận ra".

Tài khoản đăng nhập của từng org:

- DEMO: `demo.chunha@` / `demo.ketoan@` / `demo.quanly@` (`.e2e-fleet/specs/auth.ts:13-16`)
- TEST: `test.nguyentamca165@` (OWNER), `test.nathan`, `test.joey`, `test.bosshuy`
  (`scripts/clone-org/lib.mjs:50-55`)
- Mật khẩu **không nằm trong repo** — đọc từ biến môi trường `FLEET_PASS_*` / `TEST_PW`
  (`.e2e-fleet/specs/auth.ts:23-29`, `scripts/clone-org/create-users.mjs:20-21`); giá trị thật ở
  `CLAUDE.local.md` (gitignore).

---

## 2. Cờ `is_demo` trên bảng `organizations` — nó KHÔNG phải cơ chế cách ly

Cột: `supabase/migrations/20260713100000_sprint1_organization_foundation.sql:36`
(`is_demo boolean NOT NULL DEFAULT false`). Cả DEMO lẫn TEST đều mang `is_demo = true`
(`create-users.mjs:32` đặt `true` cho org TEST).

Comment ngay tại chỗ đặt cờ nói rõ phạm vi của nó (`create-users.mjs:28-29`):

> `is_demo = true`: chỉ dùng cho badge "Bản demo" ở màn Cấu hình > Tổ chức và thứ tự sắp xếp của
> `current_admin_org_v1()`. **Cách ly thật nằm ở `sandbox_org_ids()`.**

Chỗ dùng đã kiểm chứng:

- **Sắp thứ tự** `order by coalesce(…is_demo, false), …` để org thật luôn đứng trước khi hàm chọn
  "org đang xem" — **6 chỗ** (đếm bằng `grep -rn "order by coalesce" supabase/migrations/*.sql |
  grep is_demo`): `20260725190000_authz_read_rpcs.sql:75` và `:159`,
  `20260726010000_authz_admin_write_rpcs.sql:410` và `:536`,
  `20260726020000_authz_admin_read_rpcs.sql:35`, `20260731070000_lucky_draw_events.sql:138`.
  Bản thân `app_private.current_admin_org_v1()` định nghĩa ở
  `20260726020000_authz_admin_read_rpcs.sql:21`.
- **Danh sách trắng của cửa chặn đối chiếu tiền**: `scripts/reconcile-money.mjs:145` neo phạm vi
  bằng `organization_id IN (SELECT id FROM public.organizations WHERE is_demo = false)`.

Vì sao chỗ thứ hai đáng nhớ — **án lệ, commit `67e25625`**: bản trước loại dữ liệu tập dượt bằng
một **danh sách đen** (`NOT (user_id = ANY(demo_user_ids()))`) viết từ thời chỉ có org DEMO. Org
TEST ra đời sau, không nằm trong danh sách, nên NGUỒN A thừa **709 phiếu / 3,52 tỷ** so với B và C
(`scripts/reconcile-money.mjs:135-138`). Chỗ lệch đó ngủ yên vì cửa chặn luôn thoát 3 trước khi kịp
so. Bài học được ghi thẳng vào comment: danh sách trắng suy từ dữ liệu thì org tập dượt mới sinh ra
**tự nằm ngoài**; ai quên đánh cờ thì gate **đỏ** — hướng hỏng đúng.

---

## 3. Vì sao phải giấu org tập dượt khỏi admin thật

Ba sự thật cộng lại tạo ra vấn đề (`supabase/migrations/20260801020000_…:5-8`,
`scripts/clone-org/README.md:39-42`):

1. App **không có nút chuyển công ty**.
2. `my_org_ids()` trả về **mảng**, và policy biên giới là `organization_id IN my_org_ids()` ⇒ user
   thuộc 2 org thấy **hợp nhất** cả hai trên mọi màn hình.
3. `is_super_admin()` có mặt trong **hầu hết policy SELECT** ⇒ super admin thấy MỌI org dù không
   là thành viên.

Án lệ đã cắn trước khi có org TEST: **ProfitDistributionReport** — org DEMO lọt vào engine tính
toán làm lệch **−17,3 triệu** (`20260801020000_…:18-19`). Ghi chú tại chỗ nói đúng bản chất:
"Rò rỉ kiểu này im lặng, chỉ lộ ra khi có người đối chiếu tay."

---

## 4. Hai họ policy: `*_hide_demo_admin` và `*_hide_sandbox_admin`

Hai họ **không thay thế nhau** — chúng nhận diện sandbox theo hai trục khác nhau.

### `*_hide_demo_admin` — nhận diện theo **user**

`supabase/migrations/20260703110000_hide_demo_from_real_admins.sql`

- Helper `public.demo_user_ids()` (dòng 23-31): `SELECT … FROM auth.users WHERE email LIKE
  'demo.%@username.ihomecrm.local'`. Kèm `demo_building_ids()` cho bảng không có `user_id`.
- Vị ngữ: `NOT ((is_super_admin() OR is_admin()) AND user_id IN (SELECT unnest(demo_user_ids())))`
  — chặn cả `is_admin()`, không chỉ super admin.
- Phủ **32 bảng** trong vòng lặp (dòng 56-63), cộng `rooms`, `building_services`, `profiles` dựng
  riêng vì không có cột `user_id` (dòng 79-102). Sau này thêm rải rác:
  `room_price_history` (`20260728180000:85`), `income_expense_items` và `contract_terminations`
  (`20260801080000:54,69`). *Đừng tin con số trong header migration:*
  `20260801020000_…:10-12` viết "33 policy / 33 bảng có cột user_id", đếm thật ra
  **32 bảng trong vòng lặp + 3 bảng dựng riêng = 35 policy**.
- Hạn chế cấu trúc: **chỉ phủ được bảng có `user_id`**. `20260801020000_…:12-16` ghi thẳng lý do
  phải sinh ra họ thứ hai — bản sao TEST mang đủ dữ liệu nghiệp vụ (`invoice_items`,
  `income_expense_items`, `finance_*`, `profit_*`) và những bảng đó **không có `user_id`**.

### `*_hide_sandbox_admin` — nhận diện theo **organization_id**

`supabase/migrations/20260801020000_sandbox_org_hide_from_super_admin.sql`

- Helper `public.sandbox_org_ids()` (dòng 27-35) hiện trả về **đúng một phần tử**:
  `ARRAY['cccc0000-0000-4000-8000-000000000001'::uuid]`. Org DEMO **không** nằm trong đây — nó
  vẫn được che bằng họ `*_hide_demo_admin`.
- Policy sinh **tự động bằng vòng lặp catalog** cho mọi bảng `public` có cột `organization_id` và
  đã bật RLS (dòng 44-73), RESTRICTIVE FOR SELECT TO `authenticated`.
- Vì sinh tự động nên **bảng mới không tự có policy** — đó chính là lý do Contract §2 bắt buộc
  thêm `<bảng>_hide_sandbox_admin` cho mọi bảng mới có `organization_id`, và
  `scripts/check-agent-contract.mjs:199` ghim chuỗi `hide_sandbox_admin` để invariant này không
  bị rút mất khỏi Contract.

### Bẫy `NULL = ANY(...)` — đã cắn thật, đo được

`supabase/migrations/20260801040000_fix_sandbox_hide_null_org.sql` sửa gấp: vị ngữ ban đầu không
bọc `COALESCE`, nên với dòng `organization_id IS NULL` thì `NULL = ANY(...)` ra NULL, `NOT NULL`
vẫn NULL, và RLS coi NULL là **không đạt ⇒ giấu luôn dòng đó**. Số đo trên chính công ty thật
(đếm qua JWT của chủ tài khoản, dòng 10-14 của migration):

| Bảng | Trước | Sau |
|---|---|---|
| `inspection_photos` | 477 | 254 |
| `building_fee_accounts` | 133 | 109 |
| `salary_attendance_day` | 58 | 37 |
| `material_usages` | 47 | 33 |
| `settings` | 8 | 6 |

Toàn bộ là dòng **của công ty thật** còn sót `organization_id` NULL. Vị ngữ hiện tại
(`:33-34`): `NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false))`.

### RLS không với tới hàm SECURITY DEFINER

`supabase/migrations/20260801050000_sandbox_org_building_scope.sql:4-11`: sau khi có org TEST,
`fa_occupancy_monthly` trả **432 dòng thay vì 228** — thừa đúng 12 toà của org TEST — vì
`can_access_building()` có nhánh tắt `is_super_admin() OR …`. Policy RESTRICTIVE không cứu được
hàm SECURITY DEFINER. Cách sửa: bịt trong chính hàm, và mọi báo cáo lọc toà phải đi qua
`can_access_building()` / `accessible_building_ids()` thay vì tự viết nhánh đặc quyền.

---

## 5. Cửa chặn rò rỉ: `scripts/clone-org/snapshot.mjs`

Chạy `node scripts/clone-org/snapshot.mjs before` trước khi chép và `after` sau khi chép.

**Đo qua PostgREST bằng JWT của tài khoản thật, không phải bằng SQL** (`snapshot.mjs:5-6`): role
`postgres` có `bypassrls` nên chạy SQL sẽ không đi qua policy nào — tức không thể phát hiện rò rỉ.
Credential lấy từ `CLAUDE.local.md` (`snapshot.mjs:24-42` — `getAnonKey()` còn có lối thoát
`process.env.SUPABASE_PAT`, nhưng `realCreds()` thì **không**, nó đọc thẳng file). Vì vậy gate này
**chỉ chạy được trên máy có vault**: nó là `npm run gate:sandbox-leak` (`package.json:22`) và
**không** xuất hiện trong `.github/workflows/` — `grep -rn "sandbox-leak" .github/` ra 0 dòng.
`tooling/local-credential-contract.json:41,48` khai đúng `snapshot.mjs` là script cần credential local.

Phép đo chính (`snapshot.mjs:96-115`) hỏi thẳng một câu: *tài khoản thật có nhìn thấy dòng nào mang
`organization_id` của org TEST không?* — miễn nhiễm với việc dữ liệu thật tự thay đổi giữa hai lần
chụp (cron 16:55 UTC `finance_month_snapshot` sinh vài trăm bút toán mỗi đêm).

### Ba rổ kết quả — và vì sao 42501 phải tách riêng

| Rổ | Nghĩa | Mã thoát |
|---|---|---|
| `leaks` | Truy vấn **thành công** và trả về ≥ 1 dòng org TEST ⇒ rò rỉ thật | `1` |
| `khoaCong` | HTTP lỗi với `code === '42501'` (permission denied): role `authenticated` **không có GRANT SELECT** | không đỏ, chỉ báo |
| `khongKiemDuoc` | Mọi lỗi còn lại — token hết hạn, rate-limit, lỗi cột… | `3` |

Cộng thêm **sàn chống-xanh-rỗng**: `tables.length < 100` ⇒ exit `3` (`snapshot.mjs:122-124`), vì
nếu `cloneTables()` trả danh sách rỗng thì vòng lặp chạy 0 lần và "0 rò rỉ trên 0 bảng" là câu vô
nghĩa.

**Vì sao 42501 ≠ "không kiểm được"** (`snapshot.mjs:86-94`, commit `c228404f`): PostgREST từ chối ở
**tầng quyền, TRƯỚC khi xét đến dòng nào**. Qua kênh này tài khoản thật không đọc nổi *một* dòng —
rò rỉ là **bất khả**, không phải "chưa biết". Đây là nhóm khoá chặt nhất hệ thống.

Án lệ: bản trước gộp chung hai rổ. Kết quả là **73 bảng** 42501 bị đếm vào "có thể rò rỉ", gate
exit 1 và in đúng câu `✗ Có rò rỉ` **trong khi rổ `leaks` RỖNG**. Thêm 2 bảng nữa (`area_buildings`,
`income_expense_batch_items` — bảng nối khoá phức, không có cột `id`) rơi vào rổ sai chỉ vì probe
hard-code `select=id`; đổi projection sang `organization_id` (chính cột đang lọc, nên tồn tại theo
định nghĩa) là cả hai trả 200 / count 0. Lý do phải sửa, chép từ commit message: *"Một cửa chặn kêu
sai kiểu này sẽ được người vận hành học cách bỏ qua, rồi lần nó kêu ĐÚNG cũng chịu chung số phận."*

### Con số trong Contract đã trôi

`PROJECT_CONTRACT.md:48` viết gate "phải ra `0/158 bảng rò rỉ`" (nhắc lại ở `:506`), và
`scripts/check-agent-contract.mjs:205` ghim đúng chuỗi `0/158` để nó không bị xoá khỏi Contract.
Nhưng `snapshot.mjs:137` in `0/${daKiem}` — **mẫu số là biến**. Lần đo gần nhất có bằng chứng
(commit `c228404f`, 07/08/2026): **169 bảng hỏi được · 0 rò rỉ · 68 bảng khoá cổng · tổng 237**.
Đọc `0/158` như một hằng số nghiệm thu là sai; thứ phải xanh là **`leaks` rỗng + không có rổ
`khongKiemDuoc`**.

### Phần CHƯA CHE — ghi thẳng trong output gate

`snapshot.mjs:141-142`: một **RPC SECURITY DEFINER vẫn có thể đọc hộ** 68 bảng thuộc rổ khoá cổng.
Kênh đó nằm ngoài phép đo này và **luôn** nằm ngoài, kể cả trước bản vá. Nói cách khác: gate xanh
chứng minh "không rò qua PostgREST bằng quyền của tài khoản thật", **không** chứng minh "không rò".

---

## 6. Bẫy vận hành khi đụng vào org tập dượt

- **Tiền tố tài khoản TEST không được là `demo.`** (`scripts/clone-org/lib.mjs:8-10`):
  `public.demo_reset()` xoá dữ liệu của MỌI user khớp `demo.%@username.ihomecrm.local`. Đặt tên
  `demo.` cho công ty test = bị xoá trắng ở lần bấm "reset demo" kế tiếp.
- **Tuyệt đối không đưa user tập dượt vào `super_admins`** — role admin bypass **xuyên tenant**,
  coi như phá bỏ toàn bộ cách ly (`create-users.mjs:12-13`, tripwire kiểm ngay tại `:100-105`,
  và `verify.mjs:110-111` kiểm lại lần nữa). Đây là án lệ từ `seed-p0`, cùng luật với
  `scripts/docs-demo/seed-p0.mjs:9-11` ("theo biên bản hội đồng 2026-07-03").
- **Không tạo `staff_assignments` full-scope** (`building_id` và `area_id` đều NULL = thấy MỌI
  toà) — `verify.mjs:116-118` đếm và bắt đỏ.
- **45 bảng không được nhân bản** (`lib.mjs:84-106`), nhóm nguy hiểm nhất là kênh gửi ra ngoài:
  `worker/index.js` quét `zalo_send_queue` **không lọc org** ⇒ chép là **nhắn trúng khách thật**.
- **Fixture E2E phải tự chặn org đích tại từng lần ghi**, không phải một lần lúc khởi động:
  `assertDemoOrganization()` (helper của các spec admin trong `.e2e-fleet/specs/`) từ chối org
  production theo danh tính và từ chối mọi org không phải DEMO. Lý do ghi tại chỗ: một kịch bản
  suy org id từ page state có thể mang id production vào lệnh ghi, còn check lúc khởi động thì đã
  pass từ lâu.

---

## 7. Lệnh hay dùng

```bash
node scripts/clone-org/clone.mjs            # đồng bộ lại org TEST từ dữ liệu thật
node scripts/clone-org/verify.mjs           # rò rỉ ngược · đủ dòng · khớp tiền · cách ly tài khoản
node scripts/clone-org/snapshot.mjs after   # cửa chặn rò rỉ (cần CLAUDE.local.md)
node scripts/clone-org/rollback.mjs --data  # xoá dữ liệu bản sao; --all xoá cả user/org/policy
```

Trong app: *Cài đặt → Tổ chức → thẻ "iHome CRM (Test)" → Đồng bộ dữ liệu mới nhất* (chỉ super admin
thấy). Nút này **không** chạy trực tiếp mà đi qua hàng đợi `clone_org.sync_request` + job pg_cron —
lý do và các ràng buộc còn lại của bộ chép: `scripts/clone-org/README.md:65-101`.

**CHƯA KIỂM CHỨNG:** trang này không chạy lệnh nào chạm database production. Mọi con số trạng thái
(169/237 bảng, 32 policy `hide_demo_admin` trong vòng lặp, số dòng trước/sau bẫy NULL) là con số
**đã ghi lại trong repo tại thời điểm đo**, không phải kết quả đo lúc viết trang. Muốn số hiện tại
thì phải chạy `snapshot.mjs` và `verify.mjs` thật.

Những thứ **đã** kiểm được và đã kiểm: mọi số dòng file, tên hàm/bảng/policy, mã commit và chuỗi
được gate ghim — đọc thẳng từ cây làm việc tại `7965c6a6`. Một lỗi đã sửa ở vòng soi lại: mục §2
từng ghi "5 chỗ" sắp thứ tự theo `is_demo`, đếm lại ra **6**.
