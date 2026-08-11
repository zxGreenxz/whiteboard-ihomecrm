---
status: current
last_verified_commit: 7965c6a6
source_paths:
  - .github/workflows/ci-gates.yml
  - .github/workflows/supabase-migrate.yml
  - .github/workflows/network-center-validation.yml
  - vercel.json
  - api/salary-v5-cron.js
  - contracts/surfaces/edge-function-surface.json
  - scripts/generate-edge-surface.mjs
  - scripts/check-edge-surface.mjs
  - scripts/deploy-edge-fn.mjs
  - scripts/deploy-openclaw-edge-fn.mjs
  - scripts/apply-reviewed-migration.mjs
  - scripts/check-external-controls.mjs
  - scripts/check-no-auto-apply.mjs
  - supabase/functions/README.md
  - supabase/migration-policy.json
  - supabase/migrations/20260729139000_network_center_watchdog.sql
  - docs/generated/external-controls.json
  - tooling/program-status.json
risk: infrastructure
---

# Phát hành nền tảng (platform delivery)

> **Reviewed:** 2026-08-07. Đường đi của một thay đổi từ commit tới người dùng. Điểm cốt lõi: **không
> có MỘT đường** — có **bốn đường độc lập**, mỗi đường dùng credential khác nhau, và ba trong bốn
> đường **không** được kích hoạt bởi `git push`. Luật chung về release nằm ở
> [PROJECT_CONTRACT §3–§5](../engineering/PROJECT_CONTRACT.md); trang này mô tả cơ chế cụ thể và các
> bẫy đã trả giá.

## 1. Bốn đường lên production

```text
                    ┌─ (1) WEB  ── push main → Vercel PREVIEW
git commit ─────────┤              promote: git push origin origin/main:production → PRODUCTION
                    │
                    ├─ (2) SCHEMA ── npm run migrate:forward <file.sql> --apply
                    │                (Management API + promotion token — KHÔNG do CI chạy)
                    │
                    ├─ (3) EDGE ──── node scripts/deploy-*-edge-fn.mjs / supabase functions deploy
                    │                (KHÔNG gắn với git push, KHÔNG có trong workflow nào)
                    │
                    └─ (4) WORKER/VPS ── rollout manifest riêng (Network Center, OpenClaw)
```

Hệ quả phải nhớ: **merge vào `main` không thay đổi gì trên production.** Và ngược lại — một Edge
function hay một migration có thể đang chạy trên dữ liệu thật mà commit tương ứng chưa bao giờ được
promote.

## 2. Đường web: `main` là preview, `production` là phát hành

Vercel project `ihomecrm` (domain `chillhome.io.vn` + `ptcrm.vercel.app`) đã đổi Branch Tracking từ
`main` sang `production` ngày 06/08/2026 (`tooling/program-status.json`, mục "ĐÃ FLIP Vercel
Production Branch"). Từ đó `push main` chỉ tạo Preview.

- Promote: `git push origin origin/main:production`.
- Rollback: promote lại deployment cũ trên Vercel, hoặc đẩy `production` về SHA trước.
- Đo 07/08/2026 — `git rev-list --left-right --count origin/production...origin/main` trả `0 96`:
  production **đi sau `main` 96 commit** và không đi trước commit nào. Nghĩa là phần lớn thứ trong
  `main` **chưa** tới người dùng. Đây là trạng thái bình thường của mô hình này, không phải sự cố.

**Không có script nào thực hiện việc promote.** Tìm khắp repo (`grep -ri "origin/main:production"`)
chỉ ra tài liệu (`PROJECT_CONTRACT.md:75`, `ADR-0003:62`, `README.md:124`), không ra công cụ. Nghĩa là
việc *bấm nút* promote vẫn do **con người / agent** làm — Vercel chỉ chặn được việc *push main tự
thành production*, không chặn được việc promote một SHA đang đỏ.

> ⚠ **Đang đổi, chưa commit (đo 07/08/2026).** Cây làm việc có `scripts/check-production-promotion.mjs`
> + job `production-promotion` + script npm `gate:production-promotion`. Nó **không promote**; nó kiểm
> `rev-list main..production` rỗng, tức mọi commit đang phát hành đều đã qua `main`. Đây là cửa chặn
> **kêu SAU khi push** (header của script tự nhận thế), vì branch protection không bật được ở GitHub
> Free. Nên sau khi đợt này merge, câu "hoàn toàn không có máy nào canh" hết đúng — nhưng "máy chặn
> được TRƯỚC khi mã tới người dùng" thì vẫn chưa đúng.

Kiểm soát này còn **chưa tự xác minh được**: `docs/generated/external-controls.json` (chụp
2026-08-06) ghi `vercelProductionBranch: "unverified"` vì máy chạy không có `VERCEL_TOKEN`.
`unverified` **không phải pass** — án lệ nằm trong `scripts/check-external-controls.mjs`: bản đầu
chấm ✅ cho mọi phản hồi HTTP 200 rồi in `ihomecrm → production branch: main` như thể bình thường,
tức thế giới nơi control **bị tắt** lại cho báo cáo sạch hơn thế giới thật.

`vercel.json` khai `build.env.VITE_NETWORK_CENTER_MODE = "production"` **không tách theo môi
trường** — preview và production build cùng nhận giá trị này.

## 3. CI gates: cái gì thật sự chạy trên PR

`.github/workflows/ci-gates.yml` có **14 job** tại commit `7965c6a6` (frontmatter). Ba nhóm:

> ⚠ **Cây làm việc lúc soi (07/08/2026) ĐÃ vượt qua con số này** — có thay đổi chưa commit thêm
> **2 job** nữa (`secret-scan` dòng 713, `production-promotion` dòng 752) ⇒ **16**, đồng thời thêm
> `production` vào `on.push.branches`. Mọi số dòng trong mục này đo ở HEAD; trong cây làm việc chúng
> đã **dịch +4**. Nếu bạn đọc trang này sau khi đợt đó merge, hãy đo lại — đừng tin con số ở đây.
> Đáng chú ý nhất: `secret-scan` **không có `needs` lẫn `if`**, nên câu "`quality-gates` là job duy
> nhất như vậy" ở bảng dưới chỉ còn đúng tại `7965c6a6`.

| Nhóm | Job | Chạy khi nào |
|---|---|---|
| Bắt buộc, không cần secret | `quality-gates` | mọi PR và push `main`/`release/*` — job DUY NHẤT không có `needs` lẫn `if` |
| Nối sau quality-gates (trực tiếp hoặc bắc cầu) | `openclaw-edge-gates`, `openclaw-sql-gates`, `openclaw-package-gates`, `openclaw-session-crypto-gate`, `openclaw-vendor-gate`, `generated-types-local-drift` có `needs: quality-gates`; `openclaw-docker-builds` needs `openclaw-package-gates`; `openclaw-cell-image-contract` needs `openclaw-session-crypto-gate` + `openclaw-vendor-gate` | cũng chạy trên PR — không job nào trong nhóm có `if:` |
| Cần secret + chỉ `refs/heads/main` | `preflight`, `security-gates`, `generated-types-drift`, `reconcile-money`, `cross-tenant-isolation` | push/`workflow_dispatch` trên `main`, và chỉ khi secret đã cấu hình |

Điều này quan trọng hơn vẻ ngoài: **mọi gate đối chiếu với database thật — ACL definer, view invoker,
catalog quyền, realtime publication, và cả ba bề mặt RPC/Edge/realtime — KHÔNG chạy trên PR.** Chúng
chỉ chạy sau khi code đã vào `main`. Cửa "đúng/sai so với production" nằm **sau** cửa merge, không
phải trước.

Vài chi tiết trong `quality-gates` đáng biết vì chúng trông như thừa:

- `fetch-depth: 0` (dòng 80–86) là **bắt buộc**: `check-graph-hygiene.mjs` phải duyệt lịch sử commit
  đụng `.ua/`, còn `check-graph-freshness.mjs` đo độ lệch từ `baseCommit`. Với checkout nông mặc
  định (1 commit) cả hai thoát 3 — "không kiểm được ≠ đạt" — tức gate không bao giờ thật sự chạy.
- Bước graph freshness **cố ý không chặn** (dòng 132–139): graph 4 MB nằm trong repo, refresh là cả
  một PR; đỏ CI mỗi khi nó cũ sẽ khiến người ta tắt gate đi. Nó chỉ đỏ khi artifact hỏng.
- `npm run gate:timezone` chạy lại test ngày/tiền dưới 4 múi giờ (UTC-11 → UTC+14) vì runner chạy
  UTC còn người dùng ở UTC+7. Ngay lần đầu nó bắt `useOccupancyTrend12m` đẩy chuỗi chỉ-có-ngày qua
  `new Date()` — biểu đồ lệch một tháng ở mọi múi giờ âm, trong khi toàn bộ test vẫn xanh ở UTC lẫn
  UTC+7 (dòng 187–198).
- 22 file `scripts/__tests__/network-center-*.test.mjs` bị `--exclude` khỏi Vitest vì dùng API
  `node:test`; chúng chạy bằng `node --test` trong `network-center-validation.yml`.
- Required check của GitHub bám **tên JOB**, không phải tên step (dòng 145–147).

`network-center-validation.yml` là workflow riêng, lọc theo `paths`, và **live apply bị chặn cứng
trong CI**: `scripts/apply-network-center-rollout.mjs:21` ném lỗi khi `GITHUB_ACTIONS=true` và không
phải dry-run.

## 4. Đường schema: forward-only lane, CI không bao giờ apply

`.github/workflows/supabase-migrate.yml` có **44 dòng và không apply gì cả** — header của nó ghi rõ
lý do: ledger `supabase_migrations.schema_migrations` được quản trị ngoài băng, một lần auto-apply sẽ
**replay lại bộ đã apply inline** và làm hỏng nó. Workflow chỉ chạy validation tĩnh + guard.

Guard là `scripts/check-no-auto-apply.mjs`, thay cho **hai** guard `grep` cũ hỏng theo hai kiểu khác
nhau: bản trong `supabase-migrate.yml` chỉ soi một dòng `run:` nên bỏ lọt block scalar (`run: |` rồi
xuống dòng); bản trong `network-center-validation.yml` so chuỗi trần nên nổ cả khi cụm từ nằm trong
comment — tức **cấm luôn việc viết ra rằng điều đó bị cấm**. Bản mới parse theo khối `run:`, quét cả
`.github/actions/`.

Đường apply thật: `npm run migrate:forward <file.sql> [--apply]` — dry-run là mặc định, và `--apply`
đi qua ba lớp chặn (`scripts/apply-reviewed-migration.mjs`): version phải lớn hơn cutoff
`20260805120000` (`supabase/migration-policy.json`), sha256 phải khớp
`supabase/migration-provenance.json`, và `IHOMECRM_PROMOTION_TOKEN` phải được nhập **tại thời điểm
chạy** (dòng 140) — cố ý không lưu vào vault, vì PAT trong `CLAUDE.local.md` cho phép ghi production
bất cứ lúc nào. Backup trước mỗi thao tác schema là bắt buộc (PITR đang TẮT); chi tiết ở Contract §4.

## 5. Đường Edge Function: **thư mục trong repo ≠ hàm đang chạy**

Đây là chỗ dễ sai nhất, và là lý do tồn tại của
[`contracts/surfaces/edge-function-surface.json`](../../contracts/surfaces/edge-function-surface.json).
Manifest đó sinh từ **ba nguồn**: thư mục `supabase/functions/*`, Management API (trạng thái đang
chạy), và call site `functions.invoke()`. Số đo ghi trong manifest (07/08/2026):

| | Số |
|---|---|
| Thư mục có mã nguồn (không tính `_shared`) | **13** |
| Bản ACTIVE trên server | **11** |
| Được mã client `functions.invoke()` gọi | **2** (`admin-create-user`, `send-push`) |
| `verify_jwt = false` — bất kỳ ai trên Internet cũng gọi được | **5** (`demo-reset`, `network-center-worker`, `openclaw-runtime`, `openclaw-runtime-token`, `salary-v5-jobs`) |

**Có mã nhưng CHƯA deploy: `network-watchdog` và `openclaw-watchdog`.** Không có gì trong repo tự nói
ra điều đó — đó chính là lý do manifest phải hỏi Management API.

Với `network-watchdog`, việc chưa deploy là **hợp lệ và có chủ đích**: migration
`supabase/migrations/20260729139000_network_center_watchdog.sql` (dòng ~763–790) khai hai phương án —
Option A chạy pg_cron **trong database**, không cần Edge và không cần secret ở đâu cả; Option B mới
là Edge `network-watchdog` cho scheduler bên ngoài. Doc [22](22-network-center.md) mô tả lịch
`*/2 * * * *` và `17 * * * *` chính là Option A. Cũng chính migration đó **cố ý không tự chạy**
`cron.schedule` — bật lịch là thao tác của người vận hành.
**CHƯA KIỂM CHỨNG:** không đọc được `cron.job` từ repo, nên không xác nhận được hai job này đã thật
sự được đăng ký trên production hay chưa.

Gate `scripts/check-edge-surface.mjs` **chỉ đỏ ở ba trường hợp**: (1) client gọi slug không đang
chạy — 404 lúc chạy, không gì bắt được lúc biên dịch; (2) có bản ACTIVE mà repo không còn mã nguồn;
(3) manifest trôi khỏi thực tế. "Có mã mà chưa deploy" chỉ **báo**, không đỏ — bắt đỏ sẽ ép người ta
deploy thứ chưa sẵn sàng hoặc xoá mã đang viết dở.

### Deploy bằng công cụ nào

| Slug | Công cụ |
|---|---|
| `network-center-worker` | `node scripts/deploy-edge-fn.mjs network-center-worker --no-verify-jwt --revision <sha 40 ký tự>` — allowlist đúng 4 file (`deno.json`, `deno.lock`, `index.ts`, `workerAuth.ts`), có manifest SHA + biên nhận |
| 5 slug OpenClaw: `openclaw-control`, `openclaw-qr`, `openclaw-object-tickets`, `openclaw-runtime-token`, `openclaw-runtime` | `node scripts/deploy-openclaw-edge-fn.mjs <slug> [--include-shared openclaw]` — đúng 5 khoá này nằm trong hằng `OPENCLAW_EDGE_FUNCTIONS` (`:19-24`); `verifyJwt` ghim sẵn từng slug, từ chối cờ CLI mâu thuẫn |
| `admin-create-user`, `demo-reset`, `llm-proxy`, `salary-v5-jobs`, `send-push` | `supabase functions deploy <name>` bằng tay — [supabase/functions/README.md](../../supabase/functions/README.md) (dòng 22) |
| `network-watchdog`, `openclaw-watchdog` | **Không công cụ nào trong repo nhận hai slug này.** Đây cũng chính là hai thư mục chưa deploy ở trên — xem `sourceWithoutDeployment` trong manifest |

1 + 5 + 5 + 2 = **13**, khớp số thư mục mã nguồn. Đừng đọc bảng này như "danh sách hàm đang chạy":
hai dòng cuối cùng là mã chưa lên server.

## 6. Cron: ba scheduler khác nhau

**(a) Vercel Cron** — `vercel.json` khai đúng **2 job**, cả hai trỏ về `api/salary-v5-cron.js`:
`?job=nightly` lúc `45 23 * * *` và `?job=digest` lúc `0 0 * * *` (UTC ⇒ 06:45 và 07:00 giờ VN, xem
[17](17-luong-thuong.md)). Đây là **2/2 slot của gói Vercel Hobby** — không còn slot thứ ba. Vì vậy
lượt drain push được **ghép vào lượt `digest`**, và việc ghép cố ý đặt **bên trong Edge function
`salary-v5-jobs`** chứ không ở route: nếu Vercel cắt request giữa chừng, edge function vẫn chạy nốt
phần drain; ghép ở route thì drain không bao giờ khởi động. Khối trong `api/salary-v5-cron.js` chỉ là
lưới đỡ cho trường hợp bản edge đang deploy còn cũ.

Route này **tự gắn** `x-cron-secret` khi forward, nên nó phải xác thực caller trước — so khớp
constant-time header `Authorization: Bearer <CRON_SECRET>` mà Vercel Cron gửi. Không ép POST-only vì
Vercel Cron gọi bằng **GET**; ép POST sẽ làm hỏng cron thật.

**(b) pg_cron trong database** — đăng ký thẳng bằng migration, ví dụ `recurring_vouchers_daily`
(`0 18 * * *` UTC = 01:00 VN) và `clone_org_sync_worker` (`15 seconds`). pg_cron dùng **UTC**.

**(c) Scheduler ngoài** — watchdog OpenClaw chạy trên Cloudflare, ngoài VPS ([23](23-openclaw-zalo.md)).

## 7. Những điều dễ hiểu sai

1. **CI xanh không có nghĩa là đã phát hành, và cũng không có nghĩa là đã kiểm với production.** Trên
   PR, toàn bộ nhóm gate cần `SUPABASE_PAT` bị bỏ qua. Xanh trên PR = "biên dịch, lint, test cục bộ
   và build đều ổn", không hơn.
2. **Deploy Edge có kiểm soát YẾU HƠN ghi database, dù cả hai đều là production.** Migration đòi
   `IHOMECRM_PROMOTION_TOKEN` nhập tại chỗ; còn `scripts/deploy-openclaw-edge-fn.mjs` đọc thẳng PAT
   `sbp_…` từ `CLAUDE.local.md` (hàm `loadDeploymentInputs`) và deploy được ngay. Plan kiến trúc đã
   gọi tên đúng vấn đề này (mục R5: "đường lên production thứ hai, không qua Vercel, không qua
   forward lane") — nhưng plan ghi "14 function dir đang chạy", còn số đo thật là **13 thư mục / 11
   đang chạy**. Đừng lấy con số từ plan.
3. **`supabase/functions/README.md` đang chỉ sai lệnh deploy OpenClaw.** Nó viết
   `node scripts/deploy-edge-fn.mjs <slug> --include-shared openclaw`, nhưng script đó chỉ nhận
   `--revision` và `--no-verify-jwt` (`scripts/deploy-edge-fn.mjs:145` ném `Unknown argument`), và
   allowlist file của nó chỉ có `network-center-worker`. Công cụ đúng là
   `scripts/deploy-openclaw-edge-fn.mjs` — mà chính chuỗi usage của file này (dòng 48) vẫn in tên cũ
   `deploy-edge-fn.mjs`, di sản lúc tách hai công cụ. Hai file có **cùng tên hàm**
   `deployEdgeFunction` (`deploy-edge-fn.mjs:69`, `deploy-openclaw-edge-fn.mjs:180`) nhưng là hai
   công cụ khác nhau.
   Cùng chỗ đó README còn sai lần thứ hai, độc lập với lần thứ nhất: dòng 117–118 ghi thứ tự deploy
   **sáu** slug, kết thúc bằng `openclaw-watchdog`. Nhưng `OPENCLAW_EDGE_FUNCTIONS` chỉ có **năm**
   khoá, nên `parseDeployArgs(['openclaw-watchdog','--include-shared','openclaw'])` ném
   `Slug is not an OpenClaw entrypoint.` (đo bằng cách import thẳng hàm export, 07/08/2026). Sửa mỗi
   tên script vẫn chưa deploy được `openclaw-watchdog` — và điều đó **nhất quán** với manifest: nó là
   một trong hai hàm chưa từng lên server.
4. **`verify_jwt = false` không phải lỗi, nhưng phải nhìn thấy được.** Đó là lựa chọn thiết kế cho
   webhook/cron; nó nghĩa là xác thực **nằm hoàn toàn trong thân function** (cron secret, worker
   secret digest, runtime token, envelope Ed25519). Sửa một trong 5 hàm đó mà làm hỏng nhánh xác thực
   nội bộ là mở cửa cho cả Internet.
5. **Không có gì tự làm tươi manifest bề mặt Edge — CI chỉ phát hiện nó đã cũ.** `check-edge-surface.mjs`
   không chứa lệnh ghi file nào (grep `writeFileSync` → rỗng); nó chỉ đối chiếu manifest với catalog
   live rồi đỏ. Việc ghi lại là `npm run surface:edge` (`generate-edge-surface.mjs`) do người chạy
   tay. Nên chuỗi phụ thuộc là: người quên chạy `surface:edge` **và** gate không chạy ⇒ manifest cũ
   mà không ai biết. Mà gate thì nằm trong `security-gates`: cần `SUPABASE_PAT`, chỉ chạy trên push
   `main`. **CHƯA KIỂM CHỨNG:** không đọc được danh sách secret của GitHub từ máy này, nên không xác
   nhận được `SUPABASE_PAT` hiện đã cấu hình hay chưa — nếu chưa, job bị skip và cả hai lớp cùng im.
6. **Gate bề mặt có sàn chống rỗng.** `check-edge-surface.mjs` khai `TOI_THIEU_THU_MUC = 8` và
   `TOI_THIEU_DEPLOY = 5`: nếu `readdirSync` trỏ sai chỗ hoặc Management API trả mảng rỗng thì mọi
   phép so đều thoả và gate in dấu tick — đúng lớp lỗi mà `check-external-controls.mjs` đã dính với
   "0 project".
7. **Rollback của bốn đường không giống nhau.** Web rollback được bằng một lệnh promote. Migration
   thì **không** — Contract §4 cấm rollback tự động destructive, chỉ có forward fix. Edge rollback là
   deploy lại bản trước. Đừng suy "đã có rollback" từ đường web sang ba đường còn lại.

## 8. Kiểm chứng

```bash
npm run check:external-controls            # branch tracking Vercel + nhánh production (cần VERCEL_TOKEN mới 'checked')
npm run gate:no-auto-apply                 # không workflow nào tự apply migration
npm run gate:migration-provenance          # file sau cutoff phải có entry + digest khớp
npm run surface:edge                       # sinh lại manifest bề mặt Edge (cần SUPABASE_PAT, CHỈ ĐỌC)
npm run gate:edge-surface                  # đối chiếu manifest với catalog live
npm run gate:known-gaps                    # khoảng trống đã biết còn hạn không
git rev-list --left-right --count origin/production...origin/main   # production đang sau main bao nhiêu
```

Lệnh `npm run gate:production-promotion` (mọi commit trên `production` đều đã qua `main`) tồn tại
trong cây làm việc lúc soi nhưng **chưa commit** ở `7965c6a6` — kiểm `package.json` trước khi dùng.

Đếm lại số job CI, vì con số ở mục 3 sẽ cũ:

```bash
grep -cE "^  [a-z][a-zA-Z0-9_-]*:$" .github/workflows/ci-gates.yml   # trừ đi 3 khoá dưới `on:`
```
