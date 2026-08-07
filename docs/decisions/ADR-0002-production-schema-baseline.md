---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - supabase/baseline/README.md
  - supabase/baseline/manifest.json
  - supabase/baseline/roles.sql
  - supabase/baseline/schema.sql
  - scripts/capture-schema-baseline.mjs
  - scripts/dien-tap-khoi-phuc-baseline.mjs
  - scripts/apply-reviewed-migration.mjs
  - supabase/migration-policy.json
  - supabase/migration-provenance.json
  - package.json
  - tooling/known-gaps.yaml
  - tooling/program-status.json
copilot_ingest: true
risk: infrastructure
---

# ADR-0002 — Production schema baseline + forward-only lane

**Trạng thái:** đã áp dụng (commit `ae1de8bc` → `17bb0090`, 06–07/08/2026).
Luật migration chung ở [`docs/engineering/PROJECT_CONTRACT.md`](../engineering/PROJECT_CONTRACT.md) §5;
trang này chỉ giải thích VÌ SAO có baseline và những cái bẫy đã trả giá để biết.

## Bối cảnh

Repo có **629 file** `supabase/migrations/*.sql` + **15 file** trong `supabase/migrations-archive/`
(đo `ls | wc -l` tại `7965c6a6`; `supabase/migration-provenance.json` có đúng 644 entry — khớp tổng).
Lịch sử này **không replay được** và chưa bao giờ replay được: version trùng, migration cũ đọc cột
không migration nào tạo, ledger `supabase_migrations.schema_migrations` tụt lại sau production.
Chi tiết ở `scripts/capture-schema-baseline.mjs:5-9` và Contract §5.

Hệ quả: trước 06/08/2026 **không tồn tại đường dựng lại môi trường từ đầu**. Không có staging dựng
được, không có đường khôi phục cấu trúc, và PITR thì đang **TẮT** (`tooling/known-gaps.yaml:72-84`,
rủi ro được chấp nhận có chủ đích, hết hạn rà lại 2027-02-06).

> Lưu ý khi trích số: chuỗi "640 file" xuất hiện trong `supabase/migration-policy.json` và trong
> header `capture-schema-baseline.mjs`, Contract §5 lại ghi "625". Cả hai là con số của thời điểm
> viết. Số đo được hôm nay là 629 + 15. Đừng chép lại 640/625.

## Quyết định

1. **Chụp một baseline schema-only từ production** (`scripts/capture-schema-baseline.mjs`), commit vào
   `supabase/baseline/`. Dựng môi trường mới = baseline + forward migration, **không** diễn lại lịch sử.
2. **Baseline không chứa dữ liệu.** `assertNoData()` (`capture-schema-baseline.mjs:133-139`) từ chối ghi
   nếu thấy `COPY … FROM stdin` hay `INSERT INTO`. Baseline **không thay thế backup** —
   `scripts/backup-before-schema.mjs` mới là đường lùi khi mất sổ sách.
3. **Mọi thay đổi schema production đi qua forward-only lane**: `npm run migrate:forward`
   (`scripts/apply-reviewed-migration.mjs`). Cutoff `20260805120000`; file cũ hơn là legacy-frozen.
4. **Baseline phải được DIỄN TẬP KHÔI PHỤC**, không chỉ được chụp
   (`scripts/dien-tap-khoi-phuc-baseline.mjs`).

Số đo hiện tại (`supabase/baseline/manifest.json`): 439 bảng · 14 view · 1193 policy · 493 trigger ·
1197 hàm · 986 index. Đã verify hai chiều lúc soi lại trang này: sha256 của `schema.sql` tính bằng
`node -e` ra đúng `349d9ec7…` như manifest, và chạy lại chính bộ regex của capture script trên
`schema.sql` cho ra đúng 6 con số trên. File `schema.sql` 179.164 dòng (`wc -l`).

Baseline trải trên 4 schema `public`/`app_private`/`demo_snapshot`/`clone_org` — điều này verify được
bằng CODE (`dien-tap-khoi-phuc-baseline.mjs:30`, hằng `SCHEMA_BASELINE`). Còn phân rã 316/65/51/7 trong
`manifest.tablesBySchema` thì **do người thêm tay**, không phải script sinh (xem "Chưa được che").

## Án lệ — những cái đã hỏng thật

### 1. `pg_dump --schema-only` KHÔNG dump role ⇒ mất 271 policy

Diễn tập đầu tiên **trên Supabase project thật** (07/08/2026, project trắng) **thất bại**:

| | bảng | view | policy | trigger |
|---|---|---|---|---|
| lần 1 | 380/439 | 11/14 | **922/1193** | 493/493 |

Kèm **249/333 lỗi** là `role "…" does not exist` (commit `b4919f02`, thân commit ghi cả 4 dòng số).
(Có một diễn tập sớm hơn ngày 06/08 nhưng trên **Postgres trần** — xem cuối trang, nó không kết luận
được gì về role.) Nguyên nhân: role thuộc cấp **cluster**,
chỉ `pg_dumpall --roles-only` mới lấy. Baseline tham chiếu 7 role riêng của ứng dụng
(`openclaw_function_owner`, `ie_canonical_writer`, …) mà có **đúng 0 lệnh `CREATE ROLE`**.

Mất 271 policy nghĩa là **mất phần lớn hàng rào RLS**: database trông như đã khôi phục, nhưng dữ liệu hở.

Sửa: `supabase/baseline/roles.sql` (7 `DO $$ … CREATE ROLE … NOLOGIN … EXCEPTION WHEN duplicate_object`),
sinh bởi capture script, **chạy TRƯỚC** `schema.sql`. Tất cả NOLOGIN nên tái tạo không mang mật khẩu và
không mở đường đăng nhập nào.

Danh sách role **chép tay có chủ đích** (`capture-schema-baseline.mjs:26-48`): đọc `pg_roles` lúc chụp sẽ
kéo theo role tạm của Supabase CLI (TTL 300 giây) và mỗi lần chụp ra một baseline khác. Thêm role mới ⇒
phải tự thêm vào danh sách; diễn tập sẽ bắt được nếu quên — **nhưng chỉ khi có người chạy diễn tập**
(xem "Chưa được che").

### 2. Manifest luôn "đầy đủ" vì nó đếm trên FILE, không đếm trên KẾT QUẢ khôi phục

Đây là lý do lỗi trên sống sót cho tới khi có người dựng thử thật. `manifest.counts` sinh bằng regex đếm
`CREATE TABLE` / `CREATE POLICY` … trong chính `schema.sql` (`capture-schema-baseline.mjs:220-227`). Trên giấy baseline
lúc nào cũng 439/1193. Không con số nào trong manifest nói gì về việc **restore có ra được 439/1193 hay
không**.

Tệ hơn: ghi chú cũ trong `known-gaps.yaml` đã quan sát ĐÚNG rằng lỗi restore lên Postgres trần "đều do
target thiếu role", nhưng **suy luận tiếp thì SAI** — "trên Supabase thật sẽ có sẵn". Các role thiếu là
role của **chính ứng dụng**, Supabase không tạo hộ. Chỉ diễn tập thật mới phân biệt được hai điều đó
(`tooling/known-gaps.yaml:134-159`).

Bài học đã đóng thành cơ chế: `dien-tap-khoi-phuc-baseline.mjs:112-127` đếm bằng **`pg_class` / `pg_policies`
/ `pg_trigger` trên đích sau restore** rồi mới đối chiếu manifest — hai nguồn số độc lập.

Đừng đọc "sống sót lâu" thành một con số to: đo bằng `git log`, manifest ghi lần cuối lúc `ae1cbebb`
(06/08 09:08), lỗi role lộ ra ở `b4919f02` (07/08 07:54) — **~23 giờ**. Nhỏ chỉ vì baseline mới 2 ngày
tuổi. Cơ chế đếm-trên-file thì vẫn nguyên đó và vẫn im lặng như cũ.

### 3. Phải chạy `schema.sql` HAI LƯỢT

Lần chạy thứ hai (đã có `roles.sql`) vẫn thiếu 1 bảng + 3 view. Bảng rơi là `public.rooms`, kéo theo
3 view phụ thuộc (`building_coverage`, `meter_readings_detailed`, `meters_with_latest_reading` — có
thật trong `schema.sql` tại dòng 104568 / 109064 / 109127).

| | bảng | view | policy |
|---|---|---|---|
| lượt 1 | 438/439 | 11/14 | 1170/1193 |
| lượt 2 | **439/439** | **14/14** | **1193/1193** |

**Đính chính một câu chữ đang lan khắp repo.** `supabase/baseline/README.md:38-40`, thân commit
`17bb0090` và `tooling/known-gaps.yaml` đều giải thích là `public.rooms` tham chiếu tiến tới
`public.room_sort_key` "định nghĩa SAU nó trong file". Đọc thẳng `schema.sql` thì **không đúng theo
thứ tự đó**:

- `CREATE FUNCTION public.room_sort_key` — dòng **67838**
- `CREATE TABLE public.rooms` (cột `name_sort text GENERATED ALWAYS AS (public.room_sort_key(name)) STORED`) — dòng **67859** / **67881**

Hàm đứng TRƯỚC bảng 21 dòng. Chuỗi tham chiếu tiến thật sự nằm sâu hơn một bậc và cũng đo được:
thân `room_sort_key` gọi `public.natural_sort_key`, mà hàm đó tới dòng **71919** mới được định nghĩa —
sau ~4.000 dòng. Đầu file dump có `SET check_function_bodies = false;` (`schema.sql:17`), nên
`CREATE FUNCTION room_sort_key` ở lượt 1 **chạy lọt mà không kêu gì**, dù thứ nó gọi chưa tồn tại.

**CHƯA KIỂM CHỨNG:** chính xác câu nào làm `public.rooms` rơi ở lượt 1. Muốn biết phải chạy lại diễn
tập và đọc stderr — script hiện chỉ **đếm** số dòng có chữ `ERROR`
(`dien-tap-khoi-phuc-baseline.mjs:108`), không giữ lại nội dung lỗi, nên bằng chứng đó đã mất. Điều
CHẮC CHẮN đúng và đủ để hành động: chạy `schema.sql` một lượt là **không đủ**, đo được ở bảng trên.
Đừng chép lại lời giải thích "hàm định nghĩa sau bảng" — nó sai.

`ON_ERROR_STOP=0` ở **cả hai lượt** là cố ý: lượt 1 chắc chắn lỗi, dừng ở lỗi đầu thì không bao giờ tới
được lượt 2 (`dien-tap-khoi-phuc-baseline.mjs:99-110`). Lỗi `already exists` ở lượt 2 và
`Non-superuser owned event trigger` là **bình thường** — xem `supabase/baseline/README.md:54-58`.

### 4. Ba sai sót trong chính phép đo (commit `17bb0090`)

Ghi lại vì chúng sẽ tái diễn với người đo tiếp theo:

- Truy vấn đối chiếu chỉ đếm `public` + `app_private` ⇒ báo "thiếu 59 bảng" trong khi chúng nằm nguyên ở
  `clone_org` và `demo_snapshot`. Baseline phủ **BỐN** schema (`dien-tap-khoi-phuc-baseline.mjs:27-30`).
- `DROP SCHEMA CASCADE` một phát trên ~440 bảng + ~1500 hàm vượt `max_locks_per_transaction`
  ("out of shared memory") trên project free ⇒ phải xoá **theo lô**, mỗi lô một transaction.
- `DROP TABLE` gọi lên view thì lỗi — mỗi `relkind` cần đúng lệnh DROP của nó.

### 5. Partition runtime và cái bẫy tên bị cắt 63 ký tự

Partition theo NGÀY (`network_device_samples_YYYYMMDD`) phải bị loại, nếu không baseline đóng băng một
"chân trời phân mảnh" phụ thuộc ngày chụp và mỗi lần chụp ra một file khác dù schema không đổi. Ba lần
sai liên tiếp, đều còn comment tại chỗ trong `scripts/capture-schema-baseline.mjs`:

- Neo `$` ngay sau 8 chữ số ⇒ bỏ sót 84 câu `ALTER INDEX … ATTACH PARTITION` (dòng 64-68).
- Không chuẩn hoá `\r\n` trước khi tách theo `\n\n` ⇒ cả file gộp thành MỘT khối, bị loại sạch, baseline
  còn 1 dòng (dòng 92-96).
- PostgreSQL cắt identifier ở 63 ký tự nên index của partition **mất một phần chữ số ngày**
  (`…_samples_202607_<cột>_idx1`). Luật đúng không đếm chữ số mà bắt theo `Type: INDEX ATTACH`
  (dòng 110-118). Trước khi sửa còn sót 168 chỗ.

Manifest hiện ghi `removedRuntimePartitions: 168`. Sau restore phải chạy `ensure_raw_partitions` của
Network Center để tạo lại partition ngày — baseline **cố ý** không chứa chúng.

## Forward-only lane (mặt còn lại của quyết định)

Baseline chỉ là ĐIỂM BẮT ĐẦU; phần sau cutoff đi qua `scripts/apply-reviewed-migration.mjs`. Bốn cửa
chặn, theo thứ tự (dòng 12-23, 72-105, 139-188). Lưu ý khi đọc code: **header của chính script vẫn ghi
"BA LỚP CHẶN"** (dòng 12) vì cửa backup được thêm sau và không ai sửa lại header;
`tooling/program-status.json` thì ghi "BỐN lớp chặn". Bốn là con số đúng — đếm trên code, không đếm
trên comment.

1. version > `provisionalCutoff.version` = `20260805120000`. File cũ hơn là **legacy-frozen, chỉ đọc**.
2. có entry trong `migration-provenance.json` **và sha256 khớp** (bytes đổi sau review ⇒ chặn).
3. `--apply` đòi `IHOMECRM_PROMOTION_TOKEN` nhập **tại thời điểm chạy**, KHÔNG lưu vault. Đây là chỗ
   duy nhất biến "chỉ con người mới phát hành" thành cơ chế — PAT trong `CLAUDE.local.md` cho phép ghi
   production bất cứ lúc nào mà không ai hay.
4. **backup là cửa chặn, không phải lời nhắc**: backup fail ⇒ không apply. Trước đây chỗ này chỉ in câu
   hỏi "đã backup chưa?" rồi chạy tiếp bất kể trả lời — vô nghĩa khi thứ hay chạy lệnh này là agent.
   Thoát hiểm `--khong-backup "<lý do>"` còn đó nhưng bắt buộc kèm lý do và lý do bị IN RA.

Cutoff được **tuyên bố NGAY** thay vì chờ phân loại xong lịch sử cũ: treo cutoff để đợi forensics quá
khứ thì mọi migration mới bị giữ làm con tin và chương trình chết ở bước đó
(`supabase/migration-policy.json`, khối `provisionalCutoff.why`).

Ledger `supabase_migrations.schema_migrations` **KHÔNG được backfill** khi apply qua lane này; nguồn sự
thật là manifest provenance + file evidence ghi vào `docs/generated/schema-change-evidence/`
(`apply-reviewed-migration.mjs:34` định nghĩa đường dẫn, `:214-228` ghi file).

> Thư mục đó **hiện KHÔNG tồn tại** (`ls docs/generated/` chỉ có `database-inventory.json` và
> `external-controls.json`). Nó được `mkdirSync` lúc apply thật, nên trạng thái này nói đúng một điều:
> **lane chưa từng chạy `--apply` lần nào**. Khớp với `tooling/program-status.json` — "không có
> migration nào đang chờ apply… đã dry-run thật trên production (ROLLBACK)". Nghĩa là nhánh
> `if (doApply)` (dòng 139-229, gồm cả cửa backup và bước ghi evidence) **chưa bao giờ chạy thật trên
> production**; nó được kiểm bằng đột biến chứ không bằng một lần apply thật.

Án lệ vận hành đã xảy ra: có phiên POST thẳng SQL qua Management API `/database/query` rồi mới phát hiện
lane chính thức — đi vòng cả 4 cửa trên. Dấu vết còn đọc được trong repo:
`supabase/migrations/20260807140000_ie_guard_handover_scope.sql` tồn tại nhưng **không có file evidence
nào** (thư mục evidence còn chưa được tạo). Đừng coi PAT là giấy phép ghi schema.

## Chưa được che (kiểm tại `7965c6a6`)

- **Không có gate CI nào cho baseline.** `grep -rln baseline .github/workflows/` chỉ ra `typecheck:baseline`
  (chuyện TypeScript, không liên quan) và một baseline network. Không có bước nào kiểm baseline còn khớp
  production, cũng không có npm alias cho `capture-schema-baseline.mjs` / `dien-tap-khoi-phuc-baseline.mjs`
  (`grep` trong `package.json` không ra — trong khi `migrate:forward` thì CÓ, dòng 33). Baseline **trôi
  khỏi production theo từng migration** và không có gì kêu. CI đã tự nhận ra kiểu hỏng này ở chỗ khác:
  comment `.github/workflows/ci-gates.yml:706` gọi tên đúng nó — "backup đứt âm thầm, baseline chưa từng
  restore thật" — rồi dựng cửa chặn cho secret-scan, nhưng KHÔNG dựng cho baseline.
- **`manifest.json` đang LẠC HẬU.** `git log -- supabase/baseline/manifest.json` chỉ ra 2 commit, mới nhất
  là `ae1cbebb` (06/08) — TRƯỚC cả `b4919f02` lẫn `17bb0090`. Nó vẫn ghi
  `"status": "TESTED trên Postgres trần — chờ xác minh trên Supabase project để lên verified"` và
  `"knownIssues": ["Chưa restore thử trên Supabase project thật — xem whyNotVerifiedYet."]` — **sai so với
  thực tế đã đo ngày 07/08**.
- **BỐN trường trong manifest không do script sinh ra**, không phải ba: `tablesBySchema`, `status`,
  `knownIssues`, `restoreDrill`. Object mà `capture-schema-baseline.mjs:268-283` dựng chỉ có 9 trường
  (`$comment`, `capturedAt`, `sourceProject`, `containsData`, `sha256`, `counts`,
  `removedRuntimePartitions`, `excludedSchemas`, `restoreNotes`); file thật có 13. Tức chúng được thêm tay
  bất chấp dòng `$comment: "không sửa tay"`, và **chạy lại `--write` sẽ xoá sạch cả bốn** — kể cả biên bản
  `restoreDrill`. Hệ quả cụ thể: con số 316/65/51/7 ở phần "Quyết định" là số chép tay, không có gì kiểm
  nó. `counts` và `sha256` thì vẫn đúng (verify lại lúc soi trang này: sha256 file khớp manifest, và regex
  của script chạy lại trên `schema.sql` cho đúng cả 6 con số).
- **Diễn tập không kiểm hàm và index.** `dien-tap-khoi-phuc-baseline.mjs:122` chỉ lặp qua
  `tables/views/policies/triggers`. `functions: 1197` và `indexes: 986` trong manifest **chưa từng được đối
  chiếu với kết quả khôi phục** — đúng cái bẫy §2 ở trên, chỉ là ở phạm vi hẹp hơn.
- **Ngưỡng là ≥99%, không phải bằng đúng** — và còn lỏng hơn con số đó.
  `dien-tap-khoi-phuc-baseline.mjs:124-125` là `Math.round((thuc/ky)*100)` rồi so `>= 99`, nên
  `Math.round` kéo 98,5% lên 99%. Giải ngược ra:
  **1176/1193 policy vẫn qua — tức thiếu 17 policy vẫn báo ✅**. Với hàng rào RLS, 17 policy không phải
  sai số làm tròn.
- Capture script đọc password pooler bằng regex trên **văn xuôi** của `CLAUDE.local.md`
  (`capture-schema-baseline.mjs:70-73`, khớp chuỗi `verify pooler login)…`). Sửa lời văn file đó là script
  hỏng, không có thông báo nào giải thích tại sao.
- CHƯA KIỂM CHỨNG: baseline commit ngày 06/08 có còn khớp production hôm nay hay không. Muốn biết thì chạy
  lại capture (chế độ xem trước, không `--write`) và so `sha256`/`counts` — trang này không chạy vì lệnh
  đó cần credential production.

## Cách dùng

```bash
# Khôi phục vào một Supabase project MỚI — ĐÚNG thứ tự, đừng bỏ bước
psql "<conn>" -v ON_ERROR_STOP=1 -f supabase/baseline/roles.sql
psql "<conn>" -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql   # lượt 1
psql "<conn>" -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql   # lượt 2

# Diễn tập lại (từ chối chạy nếu chuỗi kết nối chứa project ref production)
node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "<conn>"

# Chụp lại baseline: xem trước, rồi mới --write
node scripts/capture-schema-baseline.mjs
```

Đích phải là **Supabase project**, không phải Postgres cài trần: bản trần thiếu schema `auth`/`extensions`
nên RLS không vào đủ (đo 06/08: 803/1193 policy).
