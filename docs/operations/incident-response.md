---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - scripts/backup-before-schema.mjs
  - scripts/check-backup-freshness.mjs
  - scripts/dang-ky-backup-dinh-ky.mjs
  - scripts/backup-hang-tuan.cmd
  - scripts/apply-reviewed-migration.mjs
  - scripts/capture-schema-baseline.mjs
  - scripts/dien-tap-khoi-phuc-baseline.mjs
  - scripts/clone-org/README.md
  - scripts/clone-org/snapshot.mjs
  - scripts/clone-org/rollback.mjs
  - scripts/vercel-ignore-app.sh
  - supabase/baseline/README.md
  - supabase/baseline/manifest.json
  - tooling/known-gaps.yaml
  - tooling/program-status.json
  - .github/workflows/ci-gates.yml
  - .github/workflows/supabase-migrate.yml
  - vercel.json
  - docs/engineering/PROJECT_CONTRACT.md
copilot_ingest: false
risk: infrastructure
---

# Sổ tay xử lý sự cố

Luật phát hành và luật ghi production nằm ở
[`docs/engineering/PROJECT_CONTRACT.md`](../engineering/PROJECT_CONTRACT.md) §3 và §4 — **đọc trước**.
Trang này chỉ nói phần Contract không nói: lúc đã hỏng rồi thì làm gì, theo thứ tự nào, và **cái gì
đã được diễn tập thật, cái gì chưa**.
(`copilot_ingest: false` vì Copilot chỉ đọc allowlist `docs/he-thong/manifest.json` —
`scripts/check-copilot-docs-manifest.mjs`; file này nằm ngoài, khai `true` là lời khai sai.)

---

## 0. Sự thật phải nuốt trước khi mở phần nào khác

**PITR đang TẮT, và đó là quyết định, không phải thiếu sót.** Chủ dự án bỏ hẳn 06/08/2026 vì add-on
tính phí riêng — ghi ở `tooling/known-gaps.yaml` mục `pitr-disabled-accepted-risk` (hết hạn rà lại
2027-02-06) và `tooling/program-status.json` mảng `hoanCoChuY`. Hệ quả: **RPO tối đa ~24 giờ trên dữ
liệu tiền thật.**

Chỗ dễ tự lừa mình nhất, và cả ba nguồn trong repo đều nói thẳng ra
(`scripts/backup-before-schema.mjs:7-10`, `known-gaps.yaml` mục trên, Contract §4):

> Bản dump thủ công **chỉ che thao tác CÓ KẾ HOẠCH** (migration, backfill, apply rollout).
> Sự cố đến từ **code chạy hằng ngày** — trigger sai, RPC xoá nhầm, job cron — thì dump không giúp
> gì; đường lùi vẫn là 24 giờ. Đây là rủi ro **ĐƯỢC CHẤP NHẬN**, không phải đã giải quyết.

**Trạng thái đo được lúc viết trang này** (`node scripts/check-backup-freshness.mjs`, 07/08/2026):

| Đo được | Giá trị |
|---|---|
| Bản dump mới nhất | `ihomecrm-full-2026-08-07T00-20-46-495Z.dump` — 0.3 ngày tuổi, 20.9 MB, **562 mục TABLE DATA**, đọc lại được |
| Số bản dump đang giữ | **2** (trần giữ 5 — `GIU_TOI_DA`, `backup-before-schema.mjs:111`) |
| `reason` của bản mới nhất | `"kiem chung ban sua: keepalive + bo bang phu du + kiem toan ven"` — tức bản **kiểm chứng công cụ**, không phải backup trước một thao tác thật |
| `excludedTableData` của bản mới nhất | 1 bảng: `cron.job_run_details` — **bản mới nhất KHÔNG đầy đủ dữ liệu** (cấu trúc vẫn có). (Hai bảng openclaw_* từng trong danh sách đã bị DROP 30/08/2026.) |
| Lịch backup tuần | Đã đăng ký (`ihomecrm-backup-tuan`, CN 09:00), nhưng `Last Run Time = 11/30/1999`, `Last Result = 267011` ⇒ **CHƯA CHẠY LẦN NÀO** |

Đừng suy từ bản mới nhất ra mọi bản: việc bỏ dữ liệu phù du là **tuỳ chọn, mặc định TẮT** — phải tự
bật `--bo-phu-du` (`backup-before-schema.mjs:45,154,240`), và `scripts/backup-hang-tuan.cmd` **không**
truyền cờ đó, nên bản chạy theo lịch sẽ đầy đủ. Luật vẫn là: **đọc manifest của đúng bản mình định
dùng**, đừng suy diễn.

Nói cách khác: cơ chế backup đã được sửa và đã chứng minh chạy được **bằng tay**; đường **tự động**
thì chưa từng tự chạy. Đừng dựa vào nó cho tới khi thấy dòng đầu tiên trong
`%USERPROFILE%\ihomecrm-backups\nhat-ky.log` — kiểm 07/08/2026: **file đó chưa tồn tại**.

---

## 1. Nghi MẤT DỮ LIỆU

**Đừng restore trước.** Restore là bước tốn kém nhất và phá bằng chứng. Đi theo thứ tự này.

**B1 — Dữ liệu có thật sự mất không, hay chỉ bị đánh dấu xoá?** Baseline có **50 chỗ khai cột
`deleted_at timestamp`** (`grep -c "deleted_at timestamp" supabase/baseline/schema.sql` = 50), trong
đó có cả `invoices` và `income_expenses`; và FE lọc mềm ở **150 chỗ / 61 file** trong `src/`
(`is('deleted_at', null)`). Hỏi thẳng database trước khi kết luận là mất.

**B2 — Dò dấu vết ai làm gì.** Bảng audit có sẵn (cả 5 đều có `CREATE TABLE` trong
`supabase/baseline/schema.sql`): `invoice_audit_log` (47 MB — **bảng lớn nhất database**, đo
07/08/2026, `backup-before-schema.mjs:222-223`), `income_expense_audit_log`,
`authorization_audit_events`, `accounting_repair_audit`, `ai_write_audit`. Hai hàm kiểm chuỗi băm
`app_private.verify_authz_audit_chain_v1` (`schema.sql:40045`) và
`app_private.*` (ví dụ các helper audit-chain) nằm ngoài schema public, và baseline
**không có `GRANT` nào** cho chúng, cũng **không có `GRANT USAGE ON SCHEMA app_private`** ⇒ role client
không gọi được, phải đi đường quản trị.
CHƯA KIỂM CHỨNG: tôi đọc chúng ra từ baseline + migration
(`20260725180000_authz_audit_append_helper.sql`),
**không gọi thử**. Lưu ý ngược lại: chỉ hàm `authz` có mặt trong
`supabase/migration-provenance.json`; không phải hàm nào cũng vậy — nên đừng dùng provenance làm danh
sách đủ.

**B3 — Nếu nghi về TIỀN chứ không phải về dòng dữ liệu:** `npm run gate:reconcile-money` — đối chiếu
ba nguồn độc lập (SQL SUM / RPC qua RLS / phân trang FE). Án lệ 07/08/2026 (`67e25625`): cửa chặn này
**chưa từng kết luận được lần nào** vì chỉ xét một kỳ, và chính điều đó giấu một chỗ lệch
**3.515.715.498 đ** — đúng bằng org nhân bản `ihome-test` lọt vào phạm vi nguồn A. Một cửa chặn luôn
thoát 3 thì không canh gì cả.

**B4 — Xác định mốc lùi được.** Hai đường lùi, cùng nằm dưới trần 24 giờ:

- **Backup vật lý hằng ngày của Supabase** — mốc ~03:53 sáng (`dang-ky-backup-dinh-ky.mjs:52`; lịch
  backup tuần cố ý đặt CN 09:00 để hai đường lùi không cùng chết vì một sự cố mạng).
  CHƯA KIỂM CHỨNG: tôi không gọi API/dashboard Supabase để xác nhận lịch và tuổi bản backup đó.
- **Bản dump thủ công** trong `%USERPROFILE%\ihomecrm-backups` — ngoài repo, cố ý, để một bản sao sổ
  sách tiền thật không bao giờ lọt vào git. Mỗi bản kèm manifest `.json` có `sha256`, `reason`,
  `tablesWithData`, `excludedTableData`, `restoreHint`, `expectedRestoreErrors`. **Đọc manifest
  trước khi tin bản dump là đầy đủ** — xem lại bảng ở §0.

**B5 — Restore. Không bao giờ đè lên production.** Dựng target mới, restore vào đó, đối chiếu, rồi
forward-fix production. Contract §4: *không rollback tự động destructive*.

> **Bẫy đã cắn thật, biết trước để khỏi hoảng:** restore bản dump đầy đủ vào **Postgres cài trần**
> báo **~4200 lỗi**, gần hết là `role "authenticated" does not exist` (644 lần). **Đây là bình
> thường** — bảng/hàm/dữ liệu vẫn vào đủ (đo 06/08/2026: 399 bảng, 1408 hàm, `invoices` 2290 dòng,
> `income_expenses` 5374 dòng). Nhưng **RLS policy KHÔNG vào hết: 323/1231**.
> ⇒ Muốn khôi phục đầy đủ **kể cả hàng rào RLS**, target phải là một **Supabase project**, không phải
> Postgres trần. (`backup-before-schema.mjs:333-342`, Contract §4.)

**B6 — Nếu cái mất là SCHEMA chứ không phải dữ liệu:** dùng `supabase/baseline/` theo đúng quy trình
**ba bước** ở `supabase/baseline/README.md` — `roles.sql` **trước**, rồi `schema.sql` chạy **hai
lượt**. Bỏ `roles.sql` thì diễn tập 07/08 cho ra 249 lỗi `role ... does not exist` và **policy chỉ
dựng được 922/1193** — database trông như đã khôi phục nhưng dữ liệu hở.

> ⚠ **`supabase/baseline/manifest.json` ĐANG LẠC HẬU — nguồn đúng là `supabase/baseline/README.md`.**
> Manifest vẫn ghi `status: "TESTED trên Postgres trần — chờ xác minh trên Supabase project"` và
> `knownIssues: ["Chưa restore thử trên Supabase project thật"]`, trong khi việc đó **đã xong
> 07/08/2026**. Bằng chứng: `git log -- supabase/baseline/manifest.json` dừng ở `ae1cbebb` (diễn tập
> 06/08), còn README.md cập nhật ở `17bb0090`.
> Tệ hơn, `restoreDrill.interpretation` còn chứa đúng **suy luận đã bị chứng minh là SAI** — "trên
> một Supabase project mới, những thứ đó có sẵn": các role thiếu là role của **chính ứng dụng**
> (`ie_canonical_writer`…), Supabase **không** tạo sẵn
> (`tooling/known-gaps.yaml:146-150`).
> Và `status` / `knownIssues` / `restoreDrill` / `tablesBySchema` **không nằm trong** object manifest
> mà `scripts/capture-schema-baseline.mjs:268-283` sinh ra ⇒ được thêm tay, và **sẽ bị xoá trắng** nếu
> ai chạy lại script chụp baseline.

Chạy lại diễn tập bất cứ lúc nào:
`node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "<connection-string>"` — script từ chối chạy nếu
chuỗi kết nối trỏ vào project production.

---

## 2. Nghi RÒ RỈ DỮ LIỆU GIỮA CÁC TỔ CHỨC

Bối cảnh bắt buộc: **`scripts/clone-org/README.md`**. Cùng một project Supabase chứa ba org — THẬT
(`aaaa…`), DEMO (`dddd…`), TEST (`cccc…`, bản sao **mang đúng dữ liệu nghiệp vụ công ty thật**). App
**không có nút chuyển công ty**: policy biên giới là `organization_id IN my_org_ids()`, và
`is_super_admin()` có mặt trong hầu hết policy SELECT ⇒ một lỗi ở đây không chỉ là rò rỉ, nó làm
**mọi báo cáo bị nhân đôi**.

**B1 — ĐO, đừng đoán.** `npm run gate:sandbox-leak` (= `node scripts/clone-org/snapshot.mjs after`).
Phép đo chạy **qua PostgREST bằng JWT của tài khoản thật**, không chạy bằng SQL — vì SQL đi role
`postgres` (bypassrls) thì không bao giờ thấy rò rỉ.

Đọc **đúng mã thoát**, đây là chỗ đã cắn:

| Mã thoát | Nghĩa |
|---|---|
| `0` | Đã hỏi được N bảng, **0 bảng rò rỉ**. Kèm ghi chú số bảng `42501` (role `authenticated` không có `GRANT SELECT` ⇒ rò rỉ **bất khả** qua kênh này). |
| `1` | **CÓ RÒ RỈ** thật — tài khoản thật nhìn thấy dòng mang `organization_id` của org TEST. |
| `3` | **KHÔNG KẾT LUẬN ĐƯỢC** — có bảng không hỏi được, hoặc liệt kê được < 100 bảng. **Không phải PASS, cũng không phải rò rỉ.** |

> **Án lệ 07/08/2026 (commit `c228404f`):** gate exit 1 và in "✗ Có rò rỉ" trong khi rổ rò rỉ **RỖNG**
> — 73 bảng bị `42501` (nhóm **khoá chặt nhất** hệ thống) bị đếm vào "có thể rò rỉ", cộng 2 bảng nối
> khoá phức chỉ vì probe hard-code `select=id`. Một cửa chặn kêu sai như vậy sẽ được người vận hành
> học cách bỏ qua, và lần nó kêu đúng cũng chịu chung số phận.

**B2 — Ba lớp lỗi đã xảy ra thật, kiểm đúng ba chỗ đó trước** (`clone-org/README.md` §2):

- **`NULL = ANY(...)` ra NULL** ⇒ policy RESTRICTIVE giấu luôn dòng `organization_id IS NULL` của
  **công ty thật** (`inspection_photos` 477→254, `building_fee_accounts` 133→109, `settings` 8→6).
  Đây là rò rỉ *ngược*: dữ liệu thật biến mất. `snapshot.mjs` có phép kiểm ngược riêng cho ca này.
- **RPC `SECURITY DEFINER` không lọc org** — RLS **không** với tới hàm SECURITY DEFINER.
  Bằng chứng sống: `fa_occupancy_monthly` trả **432 dòng thay vì 228**, thừa 12 toà của org TEST, do
  `can_access_building()` có nhánh tắt `is_super_admin() OR …`.
- **Đo bằng số đếm trước/sau là SAI** — cron 16:55 UTC (`finance_month_snapshot`) sinh vài trăm bút
  toán mỗi đêm, và phân trang PostgREST không `order` thì hai lần chụp ra hai tập dòng khác nhau.

**B3 — Cửa chặn bổ trợ** (chạy được không cần credential production trừ nơi ghi rõ):
`npm run gate:view-invoker` (view `security_invoker` — chống lộ xuyên tenant qua view),
`node scripts/check-definer-acl.mjs` (SECURITY DEFINER anon-executable),
`node scripts/test-cross-tenant.mjs` (ma trận âm bản, **cần `SUPABASE_PAT`**, mọi write giới hạn trong
org DEMO và kết bằng `ROLLBACK`).

**B4 — Nếu rò rỉ đến từ bản sao sandbox:** gỡ bằng
`node scripts/clone-org/rollback.mjs --data` (chỉ dữ liệu) hoặc `--all` (kèm user/org/policy). Script
có tripwire `TEST_ORG === REAL_ORG` và predicate xoá là hằng số.

**CHƯA DIỄN TẬP:** không có runbook nào trong repo cho bước "đã xác nhận rò rỉ ra ngoài sandbox thì
cắt đường đọc thế nào" (revoke/vô hiệu policy/khoá tài khoản), và tôi không tìm thấy bằng chứng việc
đó từng được tập. Coi đây là khoảng trống, không phải là bước đã có.

---

## 3. Rollback DEPLOY WEB

Quy tắc phát hành đầy đủ ở Contract §3. Phần cơ học đã kiểm được:

- Từ 06/08/2026 Vercel project theo dõi nhánh **`production`** ⇒ **push `main` chỉ tạo Preview**.
  Nhánh `production` tồn tại thật trên remote (`git branch -r` có `origin/production`).
- Rollback theo Contract §3: **promote lại deployment trước trên Vercel**, hoặc đẩy `production` về
  SHA cũ. CHƯA KIỂM CHỨNG: Contract ghi "một lệnh, đã diễn tập" nhưng tôi **không tìm thấy artefact
  bằng chứng nào trong repo** (không có log/evidence của lần rollback nào). Đừng gặp sự cố lần đầu
  mới đọc tài liệu Vercel.
- **Bẫy:** `scripts/vercel-ignore-app.sh` cho **exit 0 = SKIP build** khi commit chỉ đụng `docs/`
  hoặc `docs-site/`. Một commit rollback mà chỉ chạm tài liệu sẽ **không rebuild app** — trông như đã
  rollback mà thật ra chưa.
- **Rollback web KHÔNG rollback được database.** Contract §4 nói thẳng: deploy web sai thì rollback
  được, migration sai thì không → **forward fix riêng**.
- **Rollback web KHÔNG hoàn tác cron đã chạy.** `vercel.json` khai 2 cron
  (`/api/salary-v5-cron?job=nightly` `45 23 * * *`, `?job=digest` `0 0 * * *`) — chúng đã ghi gì thì
  vẫn còn đó.
- **Không bao giờ để CI apply lại migration.** `.github/workflows/supabase-migrate.yml` cố ý chỉ
  validate tĩnh: sổ migration được quản lý out-of-band, một lần auto-apply sẽ **replay bundle
  2026-07-20/21 lên production và làm hỏng sổ**. Gate `node scripts/check-no-auto-apply.mjs` canh điều
  đó (`ci-gates.yml:114`). Đường ghi production cho migration **sau cutoff** là
  `npm run migrate:forward` (`scripts/apply-reviewed-migration.mjs`) với **ba** lớp chặn: cutoff,
  provenance sha256, và `IHOMECRM_PROMOTION_TOKEN` nhập tại thời điểm chạy
  (`apply-reviewed-migration.mjs:6-20,72-100,140`). Đừng lẫn với bundle kế toán cũ, vốn đi
  `scripts/apply-accounting-rollout.mjs` (`supabase-migrate.yml:6`).
  Cảnh báo lệch nguồn: `tooling/program-status.json` ghi "**4 lớp chặn**". Chính script nói "BA LỚP
  CHẶN" và chỉ hiện thực ba — tin script.

---

## 4. Tìm bằng chứng ở đâu

| Thứ cần | Chỗ tìm |
|---|---|
| Bản dump + manifest | `%USERPROFILE%\ihomecrm-backups` (ngoài repo — cố ý) |
| Nhật ký backup tự động | `%USERPROFILE%\ihomecrm-backups\nhat-ky.log` (`scripts/backup-hang-tuan.cmd`) |
| Baseline schema + quy trình khôi phục | `supabase/baseline/README.md` (**không** phải `manifest.json`) |
| Evidence apply schema lên production | `docs/generated/schema-change-evidence/` (`apply-reviewed-migration.mjs:34`) — thư mục **CHƯA TỒN TẠI**; `docs/generated/` chỉ có `database-inventory.json` + `external-controls.json` (khớp `program-status.json`: chưa apply migration thật nào) |
| Ảnh chụp phép đo rò rỉ | `.clone-org-snapshots/` (gitignore dòng 112) |
| Khoảng trống đã biết, có hạn | `tooling/known-gaps.yaml` — `npm run gate:known-gaps` |
| Credential | Nằm ngoài repo, trong file local đã gitignore. **Không ghi ở đây, và không echo ra terminal.** |

---

## 5. Đã diễn tập THẬT / CHƯA diễn tập

Phần quan trọng nhất của trang này. "Có script" ≠ "đã chạy được".

**ĐÃ diễn tập, có số đo:**

| Việc | Ngày | Kết quả |
|---|---|---|
| Khôi phục **baseline schema** lên Supabase project trắng (PG 17.6) | 07/08/2026 | 439/439 bảng · 14/14 view · 1193/1193 policy · 493/493 trigger. Lần chạy **đầu thất bại** (922/1193 policy) — đó mới là giá trị của diễn tập |
| Khôi phục **bản dump đầy đủ** lên Postgres trần (PG 17.10) | 06/08/2026 | Dữ liệu vào đủ; RLS chỉ 323/1231. ~4200 lỗi role — bình thường |
| Chạy backup + **đọc lại** bằng `pg_restore --list` | 07/08/2026 | 405 giây, 20.9 MB, 562 mục TABLE DATA (sàn 450) |
| Đo rò rỉ sandbox qua JWT tài khoản thật | 07/08/2026 | Gate đã ĐỎ SAI rồi được sửa (`c228404f`) — nay phân biệt rõ rò rỉ / không hỏi được / khoá cứng |
| Đối chiếu tiền ba nguồn | 07/08/2026 | A=B=C=5.860.620.718 đ, cửa sổ 2026-05→2026-08, 1268 dòng |

**CHƯA diễn tập — nói thẳng:**

- **Khôi phục DỮ LIỆU (bản dump đầy đủ) lên một Supabase project thật.** Mới chỉ thử trên Postgres
  trần, nơi RLS không vào hết. Đúng kịch bản khẩn cấp thật thì đây là bước chưa ai đi qua.
- **Cắt đường đọc khi đã xác nhận rò rỉ** (xem §2, B4 ghi chú).
- **Rollback deploy Vercel** — Contract khẳng định đã diễn tập; không có artefact trong repo để xác
  nhận (§3).
- **Lịch backup tự động chưa chạy lần nào** (`Last Result = 267011`, xem §0).
- **Khôi phục file Storage** (ảnh/biên lai — `clone-org/README.md` ghi 2.832 object / 1,3 GB). Tôi
  **không tìm thấy script backup Storage nào**: `clone-org/copy-files.mjs` chép sang org TEST (không
  phải backup), `scripts/migrate-bucket-to-r2.mjs` là di trú sang R2 và giữ nguyên bản Supabase. Mất
  bucket thì hiện chưa có đường lùi nào được viết ra.
- **Apply migration thật lên production** — chủ dự án hoãn 07/08/2026 ("không gấp"); đường apply đã
  dry-run thật trên production với `ROLLBACK` nhưng chưa chạy `--apply` lần nào
  (`tooling/program-status.json`, và thư mục evidence chưa tồn tại).
