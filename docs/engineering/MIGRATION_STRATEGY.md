---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - supabase/migrations/
  - supabase/migrations-archive/README.md
  - supabase/migration-policy.json
  - supabase/migration-provenance.json
  - supabase/migration-unknown-review.json
  - supabase/baseline/README.md
  - supabase/baseline/manifest.json
  - scripts/apply-reviewed-migration.mjs
  - scripts/check-migration-provenance.mjs
  - scripts/generate-migration-provenance.mjs
  - scripts/network-center-disposable-db.mjs
  - scripts/backup-before-schema.mjs
  - scripts/check-backup-freshness.mjs
  - scripts/check-doc-counts.mjs
  - scripts/check-no-auto-apply.mjs
  - .github/workflows/supabase-migrate.yml
  - .github/workflows/ci-gates.yml
  - .github/workflows/network-center-validation.yml
  - tooling/known-gaps.yaml
  - tooling/program-status.json
copilot_ingest: false
risk: infrastructure
---

# Chiến lược migration

Luật chung (timestamp 14 chữ số, immutable sau merge, backup bắt buộc, cấm auto-apply) nằm ở
[`PROJECT_CONTRACT.md` §4 và §5](./PROJECT_CONTRACT.md). Trang này giải thích **vì sao** chiến lược
lại có hình dạng như vậy và **cơ chế nào** đang cưỡng chế nó.

(`copilot_ingest: false` vì `scripts/check-copilot-docs-manifest.mjs` chỉ quét `docs/he-thong/`.)

## Số liệu — đo lúc nào, đo bằng gì

Đo lại toàn bộ tại commit `7965c6a6` ngày 07/08/2026 (bản đầu đo ở `43a5564e`; `git diff --stat`
giữa hai commit chỉ đụng `package.json`, `scripts/check-local-agent-credentials.mjs`,
`tooling/local-credential-contract.json` — không chạm bề mặt migration, và mọi số dưới đây đã được
chạy lại ở `7965c6a6`):

**Trang này KHÔNG chép con số nữa** (dọn 26/08/2026). Bản trước mang một bảng 7 con số "đo
07/08/2026" (629 file, 644 entry, 40 version trùng…) — tất cả đã chết chỉ sau ba tuần (thực tế đã
687/702/42). Số sống nằm ở hai chỗ, cả hai đều có máy canh:

- **`supabase/migration-provenance.json`** — manifest sinh bằng máy (`npm run provenance:generate`);
  chạy `node scripts/check-migration-provenance.mjs` để in bảng độ phủ hiện hành.
- Các con số được phép xuất hiện trong văn (README supabase, DATABASE_SCHEMA, CODEBASE_STRUCTURE,
  PROJECT_CONTRACT §1/§5, migration-policy.json) đều có neo trong `CLAIMS` của
  `scripts/check-doc-counts.mjs` và được `gate:truoc-push` tự dán lại (`--fix`).

Bài học giữ nguyên: **đừng chép số đi nơi khác** — án lệ "371 migration" lặp ở 3 file khi thực tế đã
625, CI xanh suốt (xem đầu `check-doc-counts.mjs`). Khoảng trống "PROJECT_CONTRACT không ai canh số"
mà bản trước mô tả đã BỊT từ 13/08: `CLAIMS` nay có 4 entry cho chính file Contract.

## Vì sao lịch sử KHÔNG replay được

Đây là tiền đề của mọi thứ còn lại. Không phải "chưa ai thử" mà là **đã đo và hỏng**.

Nguồn: khối comment `scripts/network-center-disposable-db.mjs:958-994`, tiêu đề
`WHY A SECOND MODE EXISTS` ở `:961`.
Đo trên PostgreSQL 17, apply 361 file trước mốc `DR_SNAPSHOT_BOUNDARY = 20260720000000` theo thứ tự
của harness: **25 file lỗi**, và 4 lỗi đầu là **nguyên nhân độc lập**, không phải hiệu ứng dây chuyền:

1. **Cột không ai tạo.** `016_meter_readings_enhancements.sql:45` đọc `contracts.building_id`
   (`SET building_id = c.building_id … FROM contracts c`), nhưng `004_contract_tables.sql:12` tạo bảng
   `contracts` không có cột đó, và trong toàn repo chỉ đúng một file chứa `ADD COLUMN building_id` —
   chính `016_`, và nó ALTER `meter_readings` chứ không phải `contracts` (đã kiểm lại 07/08/2026 bằng
   `grep -rln "ADD COLUMN building_id" supabase/migrations`).
2. **Phụ thuộc ngược chiều.** `017_meters_table.sql` đọc `meter_readings.meter_id`, cột chỉ được `018_`
   thêm vào.
3. **Lỗi cú pháp cứng.** `025_create_contract_files_bucket.sql` kết thúc bằng
   `COMMENT ON CONSTRAINT "contract-files bucket policies" IS '…'` — thiếu mệnh đề `ON <table>`.
   File này chưa bao giờ parse được.
4. **Va chạm tên do thứ tự lexicographic.** `029_missing_features.sql:498` và
   `20250101000008_create_roles_and_staff_assignments.sql:8` cùng tạo bảng `roles`; file thứ hai dùng
   `CREATE TABLE roles (` trần, không `IF NOT EXISTS`. Hai quy ước đặt tên (số thứ tự và timestamp)
   xen kẽ nhau rất tệ khi sắp theo chuỗi.

Cộng thêm hai lý do ở cấp hệ thống:

5. **Version trùng.** 40 version dùng cho 90 file ⇒ ledger có unique constraint sẽ chết; khoá định danh
   thật là `(version, name, sha256)`, không phải `version` (`supabase/migration-policy.json`, mục
   `knownLimits`).
6. **Ledger đã tụt lại.** Ledger dừng ở `20260727095000` trong khi production có thay đổi muộn hơn
   (`ledgerRows: 372` / `ledgerMaxVersion` trong manifest). **Đừng dùng `max(version)` của ledger làm
   trạng thái schema.**

Production **không** bị ảnh hưởng: các file đó được apply tuần tự theo thời gian thật, lên một database
đang nhận cả thay đổi ngoài luồng. Sửa chúng bây giờ sẽ làm lệch ledger — nên chúng là **legacy-frozen,
chỉ đọc**.

Khoảng trống này đã đăng ký: `tooling/known-gaps.yaml` id `supabase-cli-replay-broken`, hết hạn
30/11/2026. Bước "Measure the historical Supabase replay" trong
`.github/workflows/network-center-validation.yml:290` để `continue-on-error: true` — nó là **phép đo**,
không phải gate.

## Thay cho replay: baseline schema

`supabase/baseline/` là đường dựng lại môi trường. Chứa **schema, không chứa dữ liệu**
(`manifest.json`: `containsData: false`). Manifest đếm: 439 bảng · 1197 hàm · 14 view · 1193 policy ·
986 index · 493 trigger; 168 partition runtime bị loại có chủ đích.

Quy trình 3 bước, **đúng thứ tự** — chi tiết ở `supabase/baseline/README.md`:

1. `roles.sql` **trước**. `pg_dump --schema-only` không bao giờ dump role (role thuộc cấp cluster).
   Bỏ bước này, diễn tập 07/08/2026 cho ra 249 lỗi `role … does not exist` và **policy chỉ dựng
   922/1193 — mất 271 hàng rào RLS**. Database trông như đã khôi phục, nhưng dữ liệu hở.
2. `schema.sql` **lượt 1** với `ON_ERROR_STOP=0`.
3. `schema.sql` **lượt 2**. Không thừa: `public.rooms` có cột sinh
   `name_sort GENERATED ALWAYS AS (public.room_sort_key(name))` tham chiếu *tiến*, lượt 1 rơi và kéo
   theo 3 view — lượt 2 vá được phần rơi vì phụ thuộc đã tồn tại.

**ĐÍNH CHÍNH 26/08/2026 — đoạn này của bản trước nói NGƯỢC sự thật, và sai theo hướng nguy hiểm
nhất có thể với tài liệu khôi phục.** Bản trước trích "439/439 · 14/14 · 1193/1193, diễn tập thật
trên Supabase project trắng" rồi kết luận *"Tin README + commit; manifest đang lạc hậu"*. Nhưng
`supabase/baseline/README.md` đã tự đính chính từ **11/08/2026**: bốn con số đó là số **ĐÃ CHỤP từ
production** (`manifest.counts`) bị chép nhầm vào chỗ mô tả kết quả restore — **không có bản ghi nào
của lần diễn tập 07/08 để đối chiếu**. Nguồn đúng là **`supabase/baseline/manifest.json →
restoreDrill`**: diễn tập có bản ghi duy nhất chạy trên PostgreSQL TRẦN + platform-shim (303 bảng
restore, 817 lỗi phân loại được, `whyNotVerifiedYet` còn nguyên) — **CHƯA lần nào restore vào một
Supabase project thật**. Thứ tự tin cậy: **manifest > README > mọi trang kể lại** (trang này đứng
cuối hàng). Gate `check-baseline-doc` cưỡng chế README khớp manifest từng trường; khoảng trống còn
lại nằm ở known-gap `baseline-schema-khong-trong-repo`.

Baseline **không thay thế backup**: nó dựng lại *cấu trúc*, không dựng lại *sổ sách*.

## Provenance: file nào đã chạy?

`supabase/migration-provenance.json` sinh bằng `npm run provenance:generate`
(`scripts/generate-migration-provenance.mjs`, CHỈ ĐỌC database — `:14` ghi "Không CREATE/ALTER/DROP").
Bốn trạng thái, gán theo **đúng thứ tự kiểm dưới đây trong `classify()`**
(`scripts/generate-migration-provenance.mjs:194-261`), dừng ở cái đầu tiên khớp:

1. `ledger-applied` — khớp chính xác `(version, name)` một dòng trong ledger (`:197-199`).
2. `superseded` — nằm trong `migrations-archive/` (`:201-206`). **Kiểm TRƯỚC catalog**, nên một file
   archive dù mọi object của nó đang có trên production vẫn ra `superseded`, không bao giờ ra
   `catalog-proven`. Đừng đọc bốn trạng thái này như một thang điểm mạnh-yếu tuyến tính: thứ tự KIỂM
   và thứ tự SỨC MẠNH BẰNG CHỨNG là hai chuyện khác nhau (`superseded` là một nhãn phân loại, không
   phải một mức bằng chứng).
3. `catalog-proven` — mọi object nó CREATE đều tồn tại trong catalog production (`:211-229`).
4. `unknown` — **không được suy ra "đã chạy" từ timestamp hay từ việc nó nằm trong repo**.
   File chỉ ALTER/DML rơi thẳng vào đây, cố ý (`:234`, `:261`).

Ba giới hạn phải nhớ (`migration-policy.json` → `knownLimits` có 5 mục; hai mục còn lại — version trùng
và ledger tụt lại — đã nằm ở §"Vì sao lịch sử KHÔNG replay được" bên trên):

- `catalog-proven` **yếu hơn** `ledger-applied`: nó chứng minh object TỒN TẠI, không chứng minh chính
  file này tạo ra nó.
- 55/65 file `unknown` chỉ ALTER/DML nên không thể chứng minh tự động. Bảng bị ALTER có tồn tại **không**
  chứng minh file này đã chạy.
- 10 file `unknown` còn lại là **bằng chứng ngược** (có CREATE nhưng object vắng mặt). Hồ sơ rà soát thủ
  công ở `supabase/migration-unknown-review.json` giải thích được 10/10 — nhưng chính file đó ghi rõ:
  nó chứng minh *sự vắng mặt đã được giải thích*, **không** chứng minh file đã chạy. Đừng nâng cấp
  trạng thái chúng.

Review theo **quy tắc + mẫu kiểm**, không ký từng file: 640 chữ ký × 2-3 phút = 25-30 giờ, và với khối
lượng đó chữ ký sẽ thành nghi thức, trường `reviewedBy` mất hết ý nghĩa
(`migration-policy.json` → `reviewModel`). *Con số "640" là số của policy/known-gaps lúc viết chúng;
đo 07/08/2026 manifest đã 644 — lập luận không đổi, nhưng đừng chép "640" đi đâu như một số đếm.* Bắt buộc review đầy đủ: mọi file `unknown`, mọi file đụng tiền,
mọi file đụng RLS/`SECURITY DEFINER`.

## Cutoff và đường forward-only

**Mốc cutoff hiện tại: `20260805120000`** (`supabase/migration-policy.json` →
`provisionalCutoff.version`, tuyên bố 06/08/2026).

- version **≤ cutoff** → legacy-frozen: chỉ đọc, không sửa, không đổi tên, không di chuyển.
- version **> cutoff** → forward-only: bắt buộc timestamp 14 chữ số **duy nhất**, có sha256, có entry
  provenance ngay từ khi merge.

Cutoff được tuyên bố **ngay** thay vì chờ phân loại xong 640 file cũ — vì treo cutoff để đợi forensics
quá khứ sẽ giữ mọi migration mới làm con tin và chương trình chết ở bước đó.

Đường đi:

```bash
node scripts/backup-before-schema.mjs --reason "apply <tên file>"   # xem §"Backup" bên dưới
npm run migrate:forward -- supabase/migrations/<file>.sql            # DRY-RUN (mặc định)
IHOMECRM_PROMOTION_TOKEN=… npm run migrate:forward -- supabase/migrations/<file>.sql --apply
npm run provenance:generate && npm run catalog:capture
```

Dry-run **chạy thật**: migration được bọc `BEGIN … ROLLBACK` rồi gửi lên chính production, nên cú pháp và
quyền được kiểm bằng database đích chứ không bằng phỏng đoán (`buildTransaction()`,
`scripts/apply-reviewed-migration.mjs:59-70`; xác nhận trong commit `6c94b226`).

## Bốn lớp chặn của `apply-reviewed-migration.mjs`

| # | Lớp | Vị trí |
|---|---|---|
| 1 | tên file **không phải timestamp 14 chữ số** ⇒ từ chối; version **≤ cutoff** ⇒ từ chối (legacy-frozen) | `scripts/apply-reviewed-migration.mjs:75-85` |
| 2 | thiếu entry provenance, hoặc **sha256 lệch manifest** ⇒ từ chối (file bị sửa sau review) | `:88-102` |
| 3 | `--apply` đòi `IHOMECRM_PROMOTION_TOKEN` nhập **tại thời điểm chạy**, không lấy từ vault | `:140-150` |
| 4 | **backup chạy trước và phải thành công**, backup lỗi ⇒ KHÔNG apply | `:152-188` |

Lớp 3 là lớp đáng kể nhất: PAT trong `CLAUDE.local.md` cho phép ghi production bất cứ lúc nào mà không ai
hay, nên câu "chỉ con người mới được phát hành" trước đó chỉ là lời văn. Token riêng, không lưu vào vault,
là chỗ duy nhất biến câu đó thành cơ chế (commit `6c94b226`).

Lớp 4 từng chỉ là **lời nhắc** — in "Đã chạy backup chưa?" rồi chạy tiếp bất kể câu trả lời. Commit
`f4672f23` (07/08/2026) biến nó thành cửa chặn thật. Vẫn còn cửa thoát `--khong-backup "<lý do>"`: bỏ qua
được, nhưng lý do bị **in ra**, không im lặng.

> **Bẫy tài liệu ngay trong code:** header của `scripts/apply-reviewed-migration.mjs:6` và `:12` vẫn ghi
> "ba lớp chặn" trong khi thân file đã có bốn (lớp backup thêm sau, ở commit `f4672f23` ngày 07/08).
> Tin **code**, đừng tin header.
>
> Tiêu đề commit gốc `6c94b226` (06/08) đã ghi "bốn lớp chặn" — nhưng đọc file **tại chính commit đó**
> (`git show 6c94b226:scripts/apply-reviewed-migration.mjs`) thì lớp thứ tư mới chỉ là một dòng
> `console.log("  Đã chạy backup chưa? …")` ở `:150`, không chặn gì. Nghĩa là tiêu đề commit lúc ấy
> **đếm một lời nhắc thành một lớp chặn**; nó chỉ trở thành đúng sau `f4672f23`. Cả header lẫn tiêu đề
> commit đều đã từng sai — chỉ có thân file là kiểm được.

Sau khi apply thật, tool ghi evidence (file, sha256, thời điểm, lock, statement timeout) vào
`docs/generated/schema-change-evidence/` và **KHÔNG backfill ledger** `supabase_migrations` — nguồn sự thật
là manifest provenance + file evidence, không phải một ledger đã tụt lại từ lâu.

**Đo 07/08/2026: thư mục `docs/generated/schema-change-evidence/` chưa tồn tại** ⇒ đường forward-only chưa
từng apply thật lần nào. Khớp với `tooling/program-status.json`: "Không có migration nào đang chờ apply…
Chạy apply lúc này chỉ để diễn tập" (`tooling/program-status.json:16` — dòng đó cũng ghi "đã dry-run
thật trên production (ROLLBACK)", khớp với việc chưa có evidence apply).

Đồng thời cả 3 file sau cutoff đều mang state `catalog-proven`, tức chúng **đã có mặt trên production
qua đường khác**. Mỗi file vào repo bằng một commit riêng, không phải cùng một commit:

| File sau cutoff | Commit đưa vào repo |
|---|---|
| `20260806090000_commission_voucher_attachments.sql` | `5638cf1c` |
| `20260807140000_ie_guard_handover_scope.sql` | `7ab9d955` — thân commit ghi "Đã apply prod + smoke rollback" |
| `20260807160000_chung_building_org_scope.sql` | `5a91d687` |

**CHƯA KIỂM CHỨNG:** chính xác script nào đã apply 3 file đó. Chỉ `7ab9d955` nói rõ đã apply prod;
hai commit còn lại không có câu tương đương trong thân commit, và không có file evidence nào để đối
chiếu. `supabase/migrations-archive/README.md` và `PROJECT_CONTRACT.md` §5 đều ghi repo apply qua
`scripts/apply-sql.mjs` / `scripts/apply-accounting-rollout.mjs` — đó là **suy đoán hợp lý, không phải
bằng chứng**.

## Backup trước khi apply — không thương lượng

PITR **TẮT** và giữ nguyên như vậy (`tooling/known-gaps.yaml` id `pitr-disabled-accepted-risk`, hết hạn
06/02/2027): add-on tính phí riêng, chủ dự án chọn phương án miễn phí ⇒ **RPO tối đa ~24 giờ trên dữ liệu
tiền thật**. Bản dump chụp ngay trước apply là **điểm khôi phục duy nhất** cho thao tác có kế hoạch.

`scripts/backup-before-schema.mjs` ghi ra `%USERPROFILE%/ihomecrm-backups` — **ngoài repo**, để một bản sao
sổ sách tiền thật không lọt vào git; password chỉ đi qua `PGPASSFILE` tạm, không bao giờ nằm trên command
line. Bắt buộc `--reason`.

Án lệ 07/08/2026 (commit `f4672f23`): cơ chế backup **đang hỏng mà không ai biết** — bản dump đứt ở giây
344 vì thiếu TCP keepalive qua pooler. Bằng chứng cũ "đã chạy thật 306 giây" chứng minh nó **từng** chạy,
không chứng minh nó **còn** chạy. Vá: `keepalives=1&keepalives_idle=30`, cộng gate
`scripts/check-backup-freshness.mjs` đọc **lại** bản mới nhất bằng `pg_restore --list` và đếm `TABLE DATA`
với sàn 450 bảng, hạn 7 ngày (`:34-35`). Một file 20 MB đúng tên đúng ngày vẫn có thể là bản cụt.

Giả thuyết "bỏ bảng phù du 48 MB cho dump nhanh hơn" đã bị **bác bỏ bằng đo**: 405s (bỏ) vs 332s (đầy đủ);
dump chỉ-schema vẫn mất 175s ⇒ nút thắt là độ trễ theo từng object, không phải số byte. Cờ này đã đảo thành
opt-in `--bo-phu-du` (`scripts/backup-before-schema.mjs:45-51`; chuỗi keepalive ở `:228-230`).

## Gate trong CI

Các gate migration nằm trong job `quality-gates` của `.github/workflows/ci-gates.yml`, chia theo
**ba step có tên** — tìm bằng chuỗi tên step, ĐỪNG tìm bằng số dòng (số dòng trôi theo mỗi lần sửa
file; bản trước của trang này ghi ":106-124" và chết chỉ sau vài commit):

- step **`schema-gates`**: `check-migration-provenance`, `normalize-supabase-types --check`,
  `check-no-auto-apply`, `check-management-api-writes`, `check-promote-readiness`,
  `check-migration-test-liveness`.
- step **`contract-gates`**: `check-unknown-review` cùng ~18 gate tĩnh khác (danh sách sống trong
  chính step đó).
- step **`docs-freshness`**: `check-doc-counts` (neo con số tài liệu vào số đếm thật) và họ hàng.

Cùng tập gate tĩnh đó chạy được ở máy dev bằng **`npm run gate:truoc-push`** — kèm bước tự-chữa nên
đây là đường chính, CI chỉ là lưới sau. Toàn bộ là biến đổi văn bản thuần, không cần credential.

- `check-migration-provenance.mjs` — **file sau cutoff thiếu entry ⇒ FAIL**; file trước cutoff đổi bytes
  ⇒ FAIL; số `unknown` chỉ là **metric**, không fail (đo 07/08/2026: gate in "⚠ 65 file chưa có bằng
  chứng máy" nhưng **exit 0**). Lý do tách hai chế độ: bắt toàn bộ lịch sử legacy phải hết `unknown`
  mới cho merge thì mọi PR đụng migration sẽ đỏ vì nợ quá khứ, người ta sẽ bypass, và gate mất uy tín
  vĩnh viễn.
- `check-no-auto-apply.mjs` — cấm `supabase db push` / `supabase migration up --linked` trong mọi workflow
  **và** trong `.github/actions/`. `.github/workflows/supabase-migrate.yml:3-13` nói rõ vì sao: auto-apply
  ở đó sẽ **replay** bộ 2026-07-20/21 lên production và làm hỏng nó.
- `check-forward-migration-idempotent.mjs` (job `security-gates`, cần PAT) — mỗi migration sau cutoff
  phải chạy lại được lần hai; sổ `tooling/idempotent-verified.json` khoá theo sha256 nên file bất biến
  đã đo đạt không bị đo lại (migration mới: `npm run gate:migration-idempotent:ghi-so` đi cùng commit).

**Ba** án lệ đã sửa trong chính gate provenance (commit `616b3f9d`, đo 07/08/2026 — thân commit ghi
"đem đột biến ra thử thì 5/6 cách né đi thẳng qua"):

- Gate cũ bị **vô hiệu chỉ bằng cách đặt tên file khác đi**: đặt `018_x.sql` hay `29990101_x.sql` thì
  `version` thành `null`, `isAfterCutoff` thành `false`, rơi thẳng vào `continue` — cả hai cách đều đi qua.
- Gate cũ chỉ duyệt một chiều đĩa → manifest, nên **xoá hoặc đổi tên** một file legacy không để lại dấu vết
  nào; chuyển file ra khỏi thư mục ⇒ gate vẫn xanh. Nay có vòng ngược lại
  (`scripts/check-migration-provenance.mjs:136-142`).
- Cùng lớp lỗi, cùng ngày: bộ quét chỉ bắt `.sql` thường mà bỏ `.SQL`
  (`quetFileSql()` nay dùng `/\.sql$/i` và `readdirSync(..., { recursive: true })`).

## Việc TUYỆT ĐỐI không làm

- Replay `supabase/migrations-archive/` — 1 file superseded + 14 file `apply_*` hand-apply (Apr–May 2026,
  áp thủ công một lần, không theo timestamp ordering, đã phản ánh trong DB live).
- Sửa / đổi tên / di chuyển bất kỳ file nào có version ≤ `20260805120000`.
- Backfill hay "làm đẹp" `supabase_migrations.schema_migrations`.
- `supabase db push`, `supabase start` với lịch sử này (`PROJECT_CONTRACT.md` **§5**, dòng
  "Legacy history KHÔNG replay được"). Ba gạch đầu dòng trên tương ứng §11 mục 4 và mục 6.
