# PROJECT CONTRACT — luật chung cho mọi agent làm việc trên repo này

> **Status:** current · **Reviewed:** 2026-08-05 · **Áp dụng cho:** Claude Code, Codex, và mọi
> agent/người khác đụng vào repo.
>
> `CLAUDE.md` và `AGENTS.md` là **adapter mỏng** (cách gọi tool của từng agent). File này là
> **nguồn duy nhất** cho invariant. Khi hai bên mâu thuẫn, file này thắng.
>
> Bối cảnh và lộ trình: `docs/whiteboard-ihomecrm-architecture-agent-plan-2026-08-05 (1).md`.
> Trạng thái chương trình đang chạy tới đâu: `tooling/program-status.json`.

---

## 1. Hệ thống này là gì (để hiểu vì sao luật khắt khe)

Không phải một app React/Supabase đơn giản. Đây là platform đa runtime chạy **sổ sách tiền thật
của công ty đang vận hành**:

- React/Vite frontend trên Vercel (production: <https://ptcrm.vercel.app>)
- Supabase PostgreSQL 17.6: 684 migration, ~1000 hàm SECURITY DEFINER, RLS trên mọi bảng public
- Edge Functions (14 thư mục), worker Node, OpenClaw Zalo (bridge/cell/maintenance/media gateway),
  Network Center (worker + Docker + WireGuard + RouterOS), Cloudflare R2/Worker
- VitePress user docs + AI Copilot đọc thẳng tài liệu hệ thống

Hệ quả: **một thay đổi đúng ở harness vẫn có thể sai trên production.** Rất nhiều lỗi trong lịch sử
repo chỉ lộ ra khi đo bằng role thật, HTTP thật, hoặc schema production thật.

---

## 2. Ba tổ chức trong cùng một database

| Org | ID | Là gì | Quyền của agent |
|---|---|---|---|
| **THẬT** | `aaaa0000-0000-4000-8000-000000000001` | sổ sách thật | **CHỈ ĐỌC** |
| **DEMO** | `dddd0000-0000-4000-8000-000000000001` | seed tay 2 toà, có nút reset | đọc + ghi (fixture phải tự dọn) |
| **TEST** | `cccc0000-0000-4000-8000-000000000001` | bản sao dữ liệu công ty thật | đọc + ghi — chỗ thử tính năng mới |

Hai luật không được quên khi viết migration/RPC mới:

1. **Bảng mới có `organization_id` + bật RLS ⇒ PHẢI thêm policy `<bảng>_hide_sandbox_admin`**
   (khuôn: `supabase/migrations/20260801040000_fix_sandbox_hide_null_org.sql`). Thiếu nó, dữ liệu
   org TEST lọt vào màn hình chủ nhà và **nhân đôi mọi con số**. Nhớ bọc `COALESCE(…, false)` —
   `NULL = ANY(...)` trả NULL sẽ giấu nhầm cả dòng `organization_id IS NULL` của công ty thật.
2. **Hàm SECURITY DEFINER không bị RLS chặn.** Báo cáo lọc toà phải lọc qua
   `public.can_access_building()` / `accessible_building_ids()` (đã chặn sandbox sẵn). Đừng tự viết
   `is_super_admin() OR …` — đó chính là lỗ đã làm `fa_occupancy_monthly` trả thừa 12 toà org TEST.

Cửa chặn: `node scripts/clone-org/snapshot.mjs after` phải ra "0/158 bảng rò rỉ".
Đồng bộ lại org TEST: *Cài đặt → Tổ chức → Đồng bộ dữ liệu mới nhất*, hoặc `node scripts/clone-org/clone.mjs`.
Chi tiết + bẫy đã cắn: `scripts/clone-org/README.md`.

---

## 3. Phát hành: `main` KHÔNG phải production

```text
push main  →  Vercel PREVIEW  →  chạy gate suite
                 gate xanh hết  →  promote branch `production` + ghi evidence (SHA, gate, fingerprint)
                 gate đỏ bất kỳ →  DỪNG; production giữ nguyên SHA cũ
rollback   →  promote lại SHA trước (một lệnh, đã diễn tập)
```

Vì repo là **private trên GitHub Free**, branch protection không enforce được — ranh giới deploy của
Vercel là kiểm soát cứng duy nhất. Vì chủ dự án chọn **tự động hoàn toàn**, điểm dừng là **máy**,
không phải người:

- Agent **được** tự commit, push `main`, và tự promote khi gate xanh. Không cần hỏi.
- Gate `continue-on-error` **không bao giờ** được tính là xanh khi quyết định promote.
- Không bao giờ để `push main` trực tiếp thành production deploy.

> ✅ **Đã flip 2026-08-06, và XÁC MINH BẰNG API 2026-08-08.** Vercel project `ihomecrm` (domain
> `chillhome.io.vn` + `ptcrm.vercel.app`) có Branch Tracking = **`production`**. Với project đó,
> push `main` chỉ tạo Preview; production chỉ đổi khi có commit lên nhánh `production`.
> Bằng chứng máy đọc: [`docs/generated/external-controls.json`](../generated/external-controls.json)
> — trước 08/08 trường này là `unverified` vì chưa ai nạp `VERCEL_TOKEN`.
>
> ⚠ **Nhưng repo này có HAI project Vercel, không phải một.** Cùng lần đo trên:
>
> | Project | Deploy từ | |
> |---|---|---|
> | `ihomecrm` (app) | `production` | ✅ đúng hợp đồng |
> | `ptcrm-docs` (VitePress, `docs-site/`) | **`main`** | ⚠ mỗi push `main` là một lần phát hành docs |
>
> Nên câu "push `main` chỉ tạo Preview" **đúng với app, KHÔNG đúng với docs**. Bản trước của mục này
> viết như thể chỉ có một project — sai vì thiếu, và không có gì làm nó sai ra tiếng cho tới khi gọi
> API thật. `gate:external-controls` hiện **đỏ** vì đúng lý do đó, và nó nên đỏ cho tới khi có người
> quyết: hoặc đổi `ptcrm-docs` sang `production`, hoặc khai đây là ngoại lệ có chủ đích.
>
> Promote: `git push origin origin/main:production` **sau khi** gate xanh.
> Rollback: promote lại deployment trước trên Vercel, hoặc đẩy `production` về SHA cũ.
>
> **Neo governance này KHÔNG đặt được vào `vercel.json`, và đừng thử.** Plan liệt kê `vercel.json`
> là chỗ neo deploy/cron/env; đo 08/08/2026 thì không làm được vì hai lý do độc lập: (a) JSON thuần
> không có comment, (b) Vercel **không** nhận production branch như một khoá của `vercel.json` —
> đó là setting trên dashboard. Nhét khoá lạ vào file đó là đánh cược cấu hình deploy để đổi lấy
> một dòng chú thích. Neo thật nằm ở đây, và trạng thái kiểm chứng nằm ở
> [`docs/generated/external-controls.json`](../generated/external-controls.json) →
> `controls.vercelProductionBranch` (hiện `unverified` vì chưa nạp `VERCEL_TOKEN` — đó là kiểm soát
> cứng DUY NHẤT của repo này, nên "unverified" là một khoảng trống có thật, không phải chi tiết nhỏ).
>
> Vẫn giữ bốn bước dưới đây cho thay đổi **chạm runtime** (`src/`, `api/`, `vite.config.ts`,
> dependencies) — chúng rẻ và bắt được lỗi mà preview không bắt:
>
> 1. đủ gate theo loại thay đổi (typecheck + test liên quan + `npm run build`);
> 2. logic có nhánh điều kiện: **kiểm bằng đột biến** — cố tình phá, xác nhận đúng test đỏ, hoàn nguyên.
>    Test xanh chỉ chứng minh test chạy, không chứng minh nó bắt được lỗi;
> 3. **kiểm bundle sau build**, không chỉ tin test: Vitest và production build khác nhau ở khoản nạp
>    asset — một `import.meta.glob` hỏng có thể vẫn xanh trong test rồi rơi về rỗng trên production;
> 4. ưu tiên thay đổi làm hệ thống **nghiêm ngặt hơn** (chặn bớt, gác thêm quyền) trước thay đổi nới lỏng.

### Kiểm soát ngoài repo

```bash
npm run check:external-controls          # in trạng thái
node scripts/check-external-controls.mjs --write   # ghi docs/generated/external-controls.json
```

Ảnh chụp màn hình chứng minh "lúc đó đã bật", **không** chứng minh "bây giờ vẫn bật" — mà chỉ điều thứ
hai mới giữ production an toàn. Vì vậy bằng chứng phải chạy lại được. `unverified` **không phải pass**:
thiếu credential nghĩa là chưa nhìn thấy, và chưa nhìn thấy thì coi như chưa an toàn.

Script cố tình **không** exit 1 khi thiếu token — biến nó thành gate đỏ sẽ khiến người ta tắt đi, và khi
ấy mất luôn khả năng nhìn.

### Runtime

Repo có **6 ràng buộc Node khác nhau** trên 8 manifest (+2 package chưa khai), nên
`engines: ">=20"` ở root **không** phải sàn thật của mọi thứ — script `test:openclaw:services`
tự chặn nếu không phải Node 24.15–24.x. Tra bảng ở `tooling/runtime-matrix.json`, đừng đoán từ root.

```bash
npm run gate:runtime-matrix   # matrix phải khớp engines + workflow, kiểm CẢ HAI chiều
```

Đáng nhớ: `infra/network-center-worker` cố ý ở `>=20 <23` (chưa test Node 24), nên CI của nó chạy
Node 22 — **đừng "sửa" cho khớp `ci-gates`**. Deno pin `2.9.4` ở cả hai workflow.

#### Quyết định: BA Node version là cố ý, không phải cẩu thả

Ba workflow chạy ba con số khác nhau, và mỗi con số bị **ràng buộc từ hai phía**:

| Workflow | Node | Bị ép bởi |
|---|---|---|
| `ci-gates.yml` | `24.18.0` | **Sàn cao nhất**: `services/openclaw-zalo-bridge` khai `>=24.18.0 <25` |
| `network-center-validation.yml` | `22` | **Trần thấp nhất**: `infra/network-center-worker` khai `>=20 <23` |
| `supabase-migrate.yml` | `20` | Không ràng buộc — chỉ chạy validator tĩnh |

Hai cái đầu **không thể gặp nhau**: `>=24.18` và `<23` là hai khoảng rời nhau. Nên "thống nhất một
version cho gọn" là việc **không làm được**, không phải việc chưa ai làm.

> **Bẫy đã sập thật (08/08/2026).** Một agent đọc thấy ba con số khác nhau, kết luận là thiếu nhất
> quán, và hạ tất cả về `22.20.0`. Thay đổi đó sẽ làm **vỡ `ci-gates`** — `zalouser-bridge` và
> `openclaw-zalo-bridge` từ chối chạy dưới 24.18, và script `test:openclaw:services` có chốt chặn
> `process.version` tự thoát 1 nếu không phải Node 24.15–24.x. `gate:runtime-matrix` bắt được ngay,
> nên thiệt hại dừng ở đó.
>
> Bài học ghi lại: **con số ở đây là kết quả của ràng buộc, không phải sở thích.** Muốn đổi thì phải
> đổi `engines` của package bị ràng buộc trước, và chứng minh nó chạy được — không đổi ở workflow.

`engines` ở root là `>=20` và **không** phải sàn thật của mọi thứ: `tooling/runtime-matrix.json` mới
là bảng có thẩm quyền, mỗi entry kèm lý do. `gate:runtime-matrix` đối chiếu **cả hai chiều**, nên
thêm package mới mà quên khai matrix là đỏ ngay (đã xảy ra với `services/openclaw-media-gateway`).

**Các package con có `node_modules` RIÊNG — phải cài trước khi chạy test của chúng ở máy:**

```bash
npm ci --prefix infra/network-center-worker
```

Bỏ bước này thì triệu chứng đánh lừa rất mạnh: vitest không thấy `node_modules` của package
con nên leo lên `node_modules` ở root và lấy **nhầm phiên bản thư viện**. Cụ thể đã cắn
06/08/2026 — worker khai `zod@^4` còn root là `zod@3.25.76`, nên `src/apiClient.ts` ném
`z.uuid is not a function` (v4 dùng `z.uuid()`, v3 dùng `z.string().uuid()`). Nhìn y hệt một
bug production làm worker không import nổi, thật ra chỉ là thiếu bước cài. CI có bước này sẵn
(`network-center-validation.yml`) nên chỉ máy dev mới gặp.

### Khoảng trống đã biết

`tooling/known-gaps.yaml` — mỗi mục có `expires_at` và `exit_condition`.

```bash
npm run gate:known-gaps            # cảnh báo khi quá hạn
node scripts/check-known-gaps.mjs --strict   # exit 1 khi quá hạn (dùng khi rà định kỳ)
```

Quá hạn thì **đóng nó hoặc gia hạn kèm lý do mới** — xoá dòng cho yên là cách biến một quyết định có
thời hạn thành một khoảng trống vĩnh viễn không ai nhớ.

#### Vì sao CI chỉ cảnh báo, không fail khi quá hạn

Plan gốc đòi bật `--strict` trên CI. **Cố ý không làm**, và lý do phải nằm ở đây chứ không phải chỉ
trong comment của script:

> Một gate đỏ **vì ngày tháng** sẽ bị gia hạn theo nghi thức hoặc bị tắt. Cả hai kết cục đều làm mất
> tín hiệu — và mất theo cách tệ hơn trạng thái ban đầu, vì sau đó không ai nhìn nữa.

Cơ chế chống mục nát thật không phải màu đỏ của CI, mà là **ba điều kiện dưới đây**:

1. **Số đo trong `why` phải đúng lúc đọc.** Một gap ghi "cũ 488 commit / 18 tiểu hệ vắng" trong khi
   thực tế là "25 commit / 1 tiểu hệ" thì không còn là cảnh báo — nó là nhiễu. Cập nhật số đo là một
   phần của việc gia hạn, không phải việc phụ. (Đã xảy ra thật với `ua-graph-stale`, sửa 08/08/2026.)
2. **Gia hạn phải viết lý do MỚI**, không phải dời ngày. Nếu lý do mới trùng lý do cũ thì đó là dấu
   hiệu chưa ai làm gì — hãy ghi thẳng điều đó thay vì dời ngày cho đẹp.
3. **`exit_condition` phải chạy được**, tức là một lệnh có thể gõ và xem exit code, không phải một
   câu mô tả. Điều kiện không kiểm được thì gap không bao giờ đóng.

Rà định kỳ bằng `node scripts/check-known-gaps.mjs --strict` — đó là chỗ màu đỏ có ích, vì lúc đó
người chạy đang CHỦ ĐỘNG rà chứ không bị chặn giữa một PR không liên quan.

### Tier rủi ro

`tooling/risk-map.json` map đường dẫn → tier (`money`, `authorization`, `migration`, `infrastructure`,
`agent-contract`, `product-surface`, `copilot`, `docs`), kèm gate tối thiểu và cờ `crossReview`.
Một file thuộc nhiều tier thì lấy tier **nghiêm nhất**. File này thay cho `CODEOWNERS` — với một owner
duy nhất, CODEOWNERS không tạo được reviewer thứ hai và cũng không enforce được trên GitHub Free.

Commit: `feat(scope): …` / `fix(scope): …` / `chore(scope): …`, body bullet "what + why".
**Stage đúng file mình sửa, liệt kê tên cụ thể — KHÔNG `git add -A`, KHÔNG `git add .`.**
Cây làm việc repo này thường có file dở dang từ phiên khác; gom nhầm là lỗi nặng.
Push bằng `git push origin HEAD:main` (nhánh local thường không phải `main`, `git push origin main`
sẽ đẩy nhầm nhánh cũ); kiểm trước bằng `git merge-base --is-ancestor origin/main HEAD`.

---

## 4. Ghi vào production database

Đây là ranh giới **khác** với deploy web. Deploy web sai thì rollback được; migration sai thì không.

- Mọi write production qua Management API / apply migration **phải có giấy phép**. KHÔNG dùng thẳng
  PAT sẵn trong `CLAUDE.local.md` cho đường ghi production.
  **Đổi 07/08/2026 theo yêu cầu chủ dự án — lane tự chạy được, không cần người gõ token mỗi lần:**
  - *Biên nhận backup* (mặc định): `npm run migrate:forward … --apply` tự chạy backup, tự kiểm bản
    dump đủ tư cách làm đường lùi (không phải chỉ-schema, không bỏ dữ liệu bảng nào, ≥450 bảng có
    dữ liệu), rồi tự phát biên nhận buộc migration vào đúng bản dump đó.
  - *`IHOMECRM_PROMOTION_TOKEN`*: **bắt buộc** khi dùng `--khong-backup`. Đường tự động và đường bỏ
    backup KHÔNG dùng chung được.

  Vì sao đổi được: token cũ gộp "có người dừng lại nhìn" với "có điểm khôi phục nếu hỏng". Với PITR
  TẮT, chỉ thứ hai quyết định thiệt hại — và con người gõ token chưa bao giờ tạo ra bản dump đó.
  Thứ THẬT SỰ mất: không còn ai xem lại **nội dung** migration trước khi nó chạm production; ba lớp
  còn lại kiểm xuất xứ, không kiểm ý định.
- Preflight bắt buộc: đúng project/org/environment, working tree sạch, reviewed SHA.
- Ghi evidence: statement bytes, normalized digest, catalog fingerprint trước/sau, actor.
- Fail closed khi provenance state / reviewed SHA / precondition catalog lạ.
- **Không rollback tự động destructive** — forward fix riêng.

### Backup trước mỗi thao tác schema — BẮT BUỘC

**PITR đang TẮT và sẽ giữ nguyên như vậy** (quyết định 2026-08-06: add-on tính phí riêng, chủ dự án
chọn phương án miễn phí). Chỉ có backup vật lý hằng ngày ⇒ **RPO tối đa ~24 giờ**.

```bash
node scripts/backup-before-schema.mjs --reason "apply migration 2026xxxx_abc"
```

Chạy **trước** mọi migration, backfill, hay apply rollout. Script bắt buộc có `--reason` vì sáu tháng
nữa đó là thứ duy nhất cho biết bản dump thuộc về thao tác nào. Mặc định ghi ra
`%USERPROFILE%/ihomecrm-backups` — **ngoài repo**, để một bản sao sổ sách tiền thật không bao giờ lọt
vào git. Kèm manifest `.json` có sha256, thời lượng và gợi ý restore.

Đã đo 2026-08-06: **21 MB, 306 giây** (database 226 MB).

**Điều phải biết TRƯỚC khi khẩn cấp** — đã diễn tập restore thật:

- Restore vào **Postgres trần** báo ~4200 lỗi, gần như toàn bộ là `role "authenticated" does not exist`
  (644 lần) cùng các role riêng của Supabase/OpenClaw. **Đây là bình thường**, đừng hoảng: bảng, hàm và
  **dữ liệu vẫn vào đủ** (đo được 399 bảng, 1408 hàm, `invoices` 2290 dòng, `income_expenses` 5374 dòng).
- Nhưng **RLS policy KHÔNG vào hết** (323/1231) vì policy tham chiếu role không tồn tại.
  ⇒ Muốn khôi phục **đầy đủ kể cả RLS**, target phải là một **Supabase project** (đã có sẵn role), không
  phải Postgres cài trần.

> ⚠ Dump thủ công chỉ che được thao tác **có kế hoạch**. Sự cố đến từ code chạy hằng ngày vẫn có đường
> lùi tối đa 24 giờ — đó là cái giá của việc không bật PITR, và nó chưa được giải quyết.

---

## 5. Migration

- Migration mới: **timestamp 14 chữ số duy nhất**, đặt trong `supabase/migrations/`, immutable sau
  khi merge. Không sửa file lịch sử đã deploy.
- Luật cutoff và forward-only nằm ở `supabase/migration-policy.json`; trạng thái từng file ở
  `supabase/migration-provenance.json` (sinh bằng máy). Apply qua `npm run migrate:forward` —
  dry-run là mặc định, `--apply` đòi giấy phép (biên nhận backup tự phát, hoặc promotion token khi
  `--khong-backup`). Gate: `npm run gate:migration-provenance`.
- **Legacy history KHÔNG replay được** — đừng tin `supabase db push` hay `supabase start`:
  684 file có 38 nhóm trùng version (81 file) + bộ legacy `001_`–`033_` còn collision nội bộ
  (`016_` ×4, `017_` ×2); ledger `supabase_migrations.schema_migrations` đã tụt lại sau production.
- `supabase/migrations-archive/` **TUYỆT ĐỐI KHÔNG replay** (1 file superseded + `migrations-bundle/`
  14 file `*_apply_*.sql` hand-apply Apr–May 2026, đã phản ánh trong DB live).
- Repo apply migration qua Management API (`scripts/apply-sql.mjs`, `scripts/apply-accounting-rollout.mjs`),
  **không** dùng `supabase db push`. CI có guard cấm auto-apply.

### Listener auth — chỉ code ĐỒNG BỘ

`src/app/providers/AuthCacheSync.tsx` là listener auth duy nhất giữ cache
`['auth','user']` / `['auth','session']` tươi.

**Tuyệt đối không `await supabase.*` trong callback đó** — supabase-js giữ lock nội bộ khi dispatch
sự kiện auth, nên một `await` ở đây gây **deadlock**: app treo im lặng lúc boot, không lỗi nào để lần
theo. Có test cố định điều này (callback phải trả `undefined`, không phải Promise).

Listener đăng ký trong `useEffect` và huỷ khi unmount. Đăng ký muộn không mất `INITIAL_SESSION`:
supabase-js gọi `_emitInitialSession` riêng cho từng subscriber mới.

### Catalog inventory — số đếm sinh bằng máy

```bash
npm run catalog:capture   # chụp catalog production -> docs/generated/database-inventory.json
npm run catalog:check     # exit 1 nếu catalog drift so với file đã commit
```

Chỉ chạy `SELECT` trên `pg_catalog` — an toàn kể cả khi PITR tắt. Ảnh chụp 2026-08-06 (PostgreSQL 17.6):
**316 bảng logic** + 82 phân mảnh runtime, 12 view, 1527 hàm (1057 SECURITY DEFINER), 30 enum,
30 bảng realtime; RLS/security_invoker/search_path đều không có object hở.

**Không chép số này vào tài liệu.** Ba cạm bẫy mà bản cũ của `DATABASE_SCHEMA.md` dính cả ba:
tổng bảng (398) gồm partition sinh theo ngày nên tự tăng; `pg_proc` (1527) đếm cả overload và hàm
nội bộ nên không so được với số RPC; số file migration không chứng minh đã deploy.

Fingerprint cố tình **bỏ qua** child partition — nếu tính vào thì nó đổi mỗi ngày, báo động giả sẽ bị
tắt trong một tuần, và khi ấy thay đổi schema thật cũng không ai thấy.

### Gate bắt buộc theo loại thay đổi

| Thay đổi | Gate |
|---|---|
| VIEW | `node scripts/check-view-invoker.mjs` |
| FUNCTION/RPC | `node scripts/check-stable-fn-locks.mjs` + ACL/owner/search_path |
| RLS/POLICY | harness role thật + cross-tenant |
| Đụng tiền | `node scripts/reconcile-money.mjs [YYYY-MM]` + idempotency + concurrency |
| Bảng mới có `organization_id` | policy `_hide_sandbox_admin` (mục 2) |
| Đổi schema | `npm run gen:types` (mục 6) |
| **Deploy Edge Function** | Preflight project ref + org PHẢI khớp đích định deploy; cây làm việc phải SẠCH |
| **Deploy Edge Function** | Ghi `reviewed SHA` + digest bundle vào evidence store trước khi deploy |

**Vì sao deploy Edge Function cần hai dòng riêng.** Migration đi qua lane forward-only nên có sổ
sách, biên nhận và cửa backup. Edge Function thì **không**: `supabase functions deploy` đẩy thẳng
thư mục trên đĩa lên project đang trỏ tới, không hỏi gì.

Hai hệ quả cụ thể, không phải giả định:

1. **Đích deploy đến từ trạng thái CLI, không từ repo.** `supabase link` gắn project ref vào
   `supabase/.temp/`, một thư mục không commit. Ai link nhầm sang project khác thì deploy trót lọt
   và im lặng — mã của tổ chức này chạy trên database của tổ chức kia. Preflight phải đọc ref+org
   thật và so với đích định deploy TRƯỚC khi đẩy.
2. **Không có gì buộc thứ deploy phải là thứ đã review.** Deploy từ cây làm việc bẩn nghĩa là bản
   đang chạy production không tương ứng commit nào — không diff được, không rollback theo SHA được.
   Nên: cây sạch, và evidence store ghi lại SHA đã review cùng digest của bundle đã đẩy, để sau này
   trả lời được câu "bản đang chạy là bản nào".

**GOTCHA `CREATE OR REPLACE VIEW` làm RỚT `security_invoker=true`** → view chạy dưới quyền owner,
lộ dữ liệu tenant khác. Chạy `check-view-invoker.mjs` sau MỌI migration đụng view.

**GOTCHA hàm STABLE/IMMUTABLE (đã cắn 5 lần):** PostgREST chạy hàm `STABLE`/`IMMUTABLE` trong
transaction **READ ONLY**, nên bất kỳ `SELECT … FOR SHARE` nào trong thân hàm — hoặc trong hàm nó
gọi (`authorize_tenant_action_v3`, `lock_org_for_decision_v1`, `_profit_assert_authorized_v2`…) —
ném `25006`. **Gọi bằng SQL thì XANH, gọi từ trình duyệt thì HỎNG**, nên loại này sống rất lâu mà
không ai thấy (`profit_close_state_v2` hỏng 10 ngày, kéo sập cả tab "Chốt LN tháng").
**Hàm nào lấy khoá dòng thì phải khai `VOLATILE`** — an toàn vì `supabase.rpc()` mặc định POST.

**GOTCHA cap-1000:** `reconcile-money.mjs` so SUM SQL thật với tổng 1000 dòng đầu — chạy ở mọi thay
đổi đụng số tiền.

### `reconcile-money` v1 và v2 — dùng cái nào, khi nào

Hai bản **chạy song song có chủ ý**, không phải một bản cũ bị bỏ quên. Chúng đối chiếu hai mô hình
tiền KHÁC NHAU, nên xanh ở bản này không nói gì về bản kia.

| | `gate:reconcile-money` (v1) | `gate:reconcile-money-v2` |
|---|---|---|
| Mô hình | `APPROVED = cash` — lọc `approval_status` | **Posting-aware**: `initial_amount + SUM(signed_amount)` trên POSTING/REVERSAL, **KHÔNG** lọc `approval_status` |
| Chỉ tiêu | Tổng THU đã duyệt theo tháng `voucher_date` | Số dư từng sổ quỹ (luỹ kế, không theo kỳ) + guard cap-1000 trên posting lines |
| Nguồn đối chiếu | 3 nguồn: SQL thật · RLS+JWT+RPC · FE phân trang | `accounts_with_balance` (legacy) vs `accounts_with_balance_v2`, chỉ sổ THỰC (`is_virtual = false`) |
| Bắt được gì mà bản kia không bắt | Lệch **quyền**: A≠B ⇒ RLS/RPC scope sai | Lệch **hạch toán**: legacy≠v2 ⇒ posting lines không dựng lại đúng số dư |

**Chạy cái nào:** đụng tiền thì chạy **cả hai**. v1 canh đường đọc cũ mà UI vẫn dùng; v2 canh nguồn
số dư mới của Finance V2. Bỏ v1 quá sớm là mất phép kiểm RLS duy nhất đi qua JWT thật.

**Cutover:** chỉ bỏ v1 khi mọi đường đọc số dư trong UI đã chuyển sang `*_v2` và v2 chạy xanh liên
tục qua một kỳ chốt sổ đầy đủ. Chưa đạt điều kiện đó thì **giữ cả hai** — Finance V2 hiện vẫn đang
dual-run (roadmap §4c: "thêm v2, KHÔNG sửa bản cũ").

---

## 6. Generated types

```bash
npm run gen:types     # KHÔNG redirect, KHÔNG thêm header tay
```

`scripts/gen-supabase-types.mjs` **ghi thẳng (atomic)** vào `src/integrations/supabase/types.ts` và
**tự chèn header**; stdout chỉ có banner npm.

**GOTCHA phá file:** `npm run gen:types > src/integrations/supabase/types.ts` — shell cắt trắng file
*trước khi* generator chạy; generator lỗi thì `types.ts` chỉ còn một dòng banner. CI có test chống
đúng lớp lỗi này.

Xem drift mà không đụng repo:
```bash
cp src/integrations/supabase/types.ts /tmp/before.ts && npm run gen:types && diff /tmp/before.ts src/integrations/supabase/types.ts
```

### Canonical vs raw: partition ngày

Network Center sinh child partition **theo ngày** (`network_{device,interface}_samples_YYYYMMDD`).
Raw typegen thấy chúng; **canonical `types.ts` thì không** — child partition không phải API mà
frontend cần import type, và để chúng trong file thì mỗi ngày thêm ~96 dòng và job drift đỏ dù
logical schema không đổi.

```bash
npm run gen:types        # lấy raw từ live
npm run types:normalize  # bỏ partition ngày -> canonical
npm run types:check      # gate: fail nếu canonical còn partition
```

Luật nằm ở `supabase/generated-types-policy.json` (pattern + parent bắt buộc còn), không hard-code
trong script. Normalizer chỉ biến đổi văn bản, không cần credential.

Đã chuẩn hoá lần đầu 2026-08-06: bỏ 80 partition (32 407 → 28 567 dòng); typecheck, test generator
và build đều xanh; không có code nào từng tham chiếu partition type.

PAT đọc từ `CLAUDE.local.md`.

---

## 7. TypeScript

- Type check thật: `npx tsc --noEmit -p tsconfig.app.json`. **Root `tsc --noEmit` KHÔNG check gì**
  (root `tsconfig.json` là `files: []` + `references`; non-build mode không đi theo references).
- Ratchet: `npm run typecheck:baseline` → so **tập fingerprint** trong `ts-baseline.json`
  (hiện **30**). Fail khi có fingerprint MỚI; tổng số không còn ý nghĩa.
- `ts-baseline.txt` (chuỗi `74`) là **artifact chết** — không script/CI nào đọc. Đừng trích số đó.
- `tsconfig.app.json` hiện `strict: false`, `noImplicitAny: false`. Bước strict đi theo **island**
  (`strictNullChecks` trước), không flip toàn repo một lần. **Module mới phải viết strict-clean.**

---

## 8. Test

| Loại | Cách chạy |
|---|---|
| Unit/property (Vitest + fast-check) | `npx vitest run <path>` |
| Edge Function Deno (`supabase/functions/*/index.test.ts` — **chỉ 2 file**) | Deno v2.9.4 portable, xem dưới |
| Còn lại trong `supabase/functions/` (13 file `*.test.ts`) | **Vitest** qua script root, KHÔNG phải Deno |
| E2E | `.e2e-fleet/` Playwright headless |
| Money | `node scripts/reconcile-money.mjs` |

Deno portable (không cài hệ thống, không đụng PATH):
```bash
curl -sL -o deno.zip https://github.com/denoland/deno/releases/download/v2.9.4/deno-x86_64-pc-windows-msvc.zip
unzip -o deno.zip
./deno.exe test --config supabase/functions/network-center-worker/deno.json \
  supabase/functions/network-center-worker/index.test.ts --allow-env
```

Mỗi thư mục function có `deno.json` + **`deno.lock` riêng** khoá version các npm specifier
(`@supabase/supabase-js`, `zod`). Đừng xoá `deno.lock` để "cho gọn": không có nó thì mỗi lần chạy
Deno tự phân giải lại version mới nhất, và một edge function đang chạy production sẽ đổi dependency
mà không ai commit gì. CI (`network-center-validation.yml`) pin `deno-version: v2.x` qua
`denoland/setup-deno@v2` — không khoá patch, nên `deno.lock` mới là thứ giữ cho bản chạy được lặp lại.
CI pin `deno-version: v2.x`; bản đã xác minh 22/22 xanh trên Windows là **v2.9.4**.

**GOTCHA suite Deno này KHÔNG phủ**: `/ingest` với giá trị ngoài miền (`connectionType`/`sessionType`),
hay ép `rpcErrorStatus` nhận `23502`/`23514`/`23503` — đã xác nhận bằng đột biến (vô hiệu hoá logic
đó vẫn 22/22 xanh). Phần đó do test Node phủ
(`scripts/__tests__/network-center-ingest-domains.test.mjs`).

**GOTCHA CRLF phá shebang:** file `.mjs` mở đầu `#!/usr/bin/env node` mà dòng đó kết thúc `\r\n` sẽ
ném "SyntaxError: Invalid or unexpected token" ngay khi một test import nó — trong khi `node --check`
nói file hợp lệ. Lỗi không chỉ vào đâu cả: không số dòng, không stack, chỉ "0 test".
`.gitattributes` đã ép `*.mjs text eol=lf` — đừng gỡ.

### Kiểm bằng đột biến — sáu luật

Dùng helper chung, **đừng viết shell riêng cho mỗi gate**:

```bash
node scripts/dot-bien.mjs --file <path> --tim "<neo>" --thay "<thay thế>" \
  --suite "<lệnh chạy gate/test>" --mong-doi-chua "<chuỗi phải có trong output đỏ>"
```

**1. Chứng minh file ĐÃ ĐỔI trước khi chạy suite — bằng sha256, không bằng niềm tin vào neo.**
Đây là luật quan trọng nhất và là luật hay bị bỏ nhất. Neo không khớp ⇒ file không đổi ⇒ suite vẫn
xanh ⇒ người chạy đọc thành *"gate không bắt được"* rồi đi sửa gate. **Gate không sai; phép thử
sai.** Đã dính 6 lần trong một phiên (07–08/08/2026): neo sai, `$` trong chuỗi thay thế bị
`String.replace` hiểu là escape, CRLF làm neo kết thúc bằng `\n` không khớp, file đã nằm sẵn trong
baseline, regex khớp tiếng Việt thất bại. Lần gần nhất suýt dẫn tới kết luận "bản vá vừa rồi làm gate
mù" — sai hoàn toàn.

**2. Ba lối thoát, đừng gộp hai cái đầu.** `3` = không kiểm được (neo hỏng, không khôi phục được) ·
`1` = **gate mù** (file đổi thật mà suite vẫn xanh) · `0` = đạt. "Không kiểm được" và "kiểm rồi thấy
hỏng" là hai tin khác nhau; gộp lại là mất đúng thông tin cần nhất.

**3. Đỏ chưa đủ — phải đỏ ĐÚNG LÝ DO.** Dùng `--mong-doi-chua` để đòi output chứa thông điệp của
chính phép kiểm đó. Một suite đỏ vì lỗi cú pháp không chứng minh gì về invariant đang xét.

**4. Khôi phục là bắt buộc, và chạy trong `finally`.** Helper xác nhận sha256 quay về đúng bản gốc.
Một phép thử làm bẩn cây làm việc rồi thoát giữa chừng còn tệ hơn không thử.

**5. Chỉ bắt buộc cho invariant HIGH-RISK**, không phải đại trà: tiền, phân quyền, ranh giới tổ chức,
lịch sử migration, và mọi gate có thể "xanh rỗng". Bắt đột biến cho mọi thay đổi sẽ biến nó thành
nghi thức, và nghi thức thì người ta làm cho xong.

**6. Ghi bằng chứng vào commit message**: neo, digest trước/sau, exit code kỳ vọng và thực tế. Một
câu "đã chạy đột biến" không kèm số đo thì không kiểm lại được.

### Gate đọc MÃ, không đọc văn kể lại về mã

Gate nào quét văn bản để tìm một mẫu thì phải **bỏ chú thích trước** — dùng
`scripts/lib/bo-chu-thich.mjs`, đừng viết lại luật ở từng chỗ.

Đây không phải cẩn thận thừa. Bốn gate đã dính, và hướng gây hại của chúng khác nhau:

| Gate | Chuyện đã xảy ra | Hướng |
|---|---|---|
| `check-copilot-docs-manifest` | `registry.includes('manifest.json')` xanh dù xoá sạch code lọc, vì ba dòng comment có sẵn chữ đó | **báo THIẾU** — gate không kiểm gì mà vẫn xanh |
| `check-realtime-query-keys` | bắt phải key nằm trong chú thích giải thích rằng key đó đã chết | báo thừa |
| `check-known-gaps` | bắt phải `::warning::` trong chú thích nói rằng ở đây KHÔNG dùng `::warning::` | báo thừa |
| `check-workflow-paths` | đếm script trong shell comment `# node …` rồi đòi khai nó vào `paths:` | báo thừa |

Ba ca sau chỉ phiền. Ca đầu mới là loại phải sợ: một gate xanh trong khi không kiểm gì trông y hệt
một gate đang làm việc. Nếu bạn viết gate mới có quét văn bản, ca đột biến bắt buộc là **"đặt đúng
chuỗi cần tìm vào một dòng chú thích"** — gate phải KHÔNG đổi màu.

### E2E — mặc định chạy ẨN (headless)

```bash
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
```

- Tăng `FLEET_WORKERS` (8 → 30) khi cần quét rộng. Mỗi worker là một browser context riêng.
- Mật khẩu **KHÔNG** trong repo — truyền qua `FLEET_PASS_CHUNHA` / `FLEET_PASS_KETOAN` /
  `FLEET_PASS_QUANLY` (giá trị ở `CLAUDE.local.md`).
- **Chỉ ghi vào org DEMO**; org THẬT chỉ đọc. Fixture phải tự dọn.
- Luôn kiểm console errors (`trackConsoleErrors` đã lọc nhiễu mạng).
- **CHỈ mở trình duyệt hiện hình khi user YÊU CẦU TƯỜNG MINH**:
  `FLEET_HEADED=1 FLEET_WORKERS=2`.
- Không có công cụ browser nào ⇒ ghi rõ khoảng trống xác minh trong báo cáo, **không** tuyên bố đã test.

---

## 8b. AI Copilot đọc tài liệu gì

Copilot **không** đọc mù `docs/he-thong/`. Allowlist nằm ở `docs/he-thong/manifest.json`:

- `copilotIngest: false` phải kèm `why` (hiện loại 3 file: mục lục README, writeup hiệu năng,
  bản đồ realtime kỹ thuật);
- `requiredPermission` cho tài liệu nhạy cảm (lương, lợi nhuận cổ đông, SOP tiền, phê duyệt tài
  chính) — tài liệu bị loại khỏi **cả** kết quả tra cứu **lẫn** danh sách gợi ý khi không tìm thấy;
- `perms` chưa load ⇒ chỉ trả tài liệu không gắn quyền (fail closed).

**Quyền sở hữu trường — manifest sở hữu `copilotIngest` và `reviewed`.** Frontmatter YAML của
`docs/he-thong/*.md` **không được lặp lại hai khoá đó**; gate làm đỏ nếu có. Nó vẫn được mang
`status`, `source_paths`, `last_verified_commit`, `risk` — bốn thứ manifest KHÔNG có, nên chúng
không tạo nguồn thứ hai.

Chốt như vậy vì đo 11/08/2026: đúng 1/29 tài liệu có frontmatter, và nó khai `reviewed: 2026-08-07`
trong khi manifest — thứ gate thật sự đọc — không có ngày nào cho file đó. Hai nguồn, và chúng đã
lệch ngay khi mới có hai. Chọn manifest vì nó máy đọc được trong một lần mở file; `reviewed` rải
trong 29 file thì mọi phép đếm đều phải quét cả thư mục và không ai kiểm được nó khớp gì.

```bash
npm run gate:copilot-docs   # file .md mới BẮT BUỘC khai trong manifest, không mặc định lọt vào
```

Gate bắt cả hai chiều: file trên đĩa thiếu entry, và entry trỏ file không tồn tại. Nó cũng kiểm
`registry.ts` còn tham chiếu manifest — chặn việc lỡ tay quay lại glob mù. Quá hạn review là
**cảnh báo**, không fail (nếu fail thì người ta sẽ bump ngày theo nghi thức và phá luôn tín hiệu).

---

## 9. Secret

- **KHÔNG BAO GIỜ commit** `CLAUDE.local.md`, `.env`, `.env.local`, hay bất kỳ token/PAT nào.
- `CLAUDE.local.md` là **local credential vault bắt buộc** — nguồn duy nhất cho tài khoản test,
  Supabase PAT/project ref, `FLEET_PASS_*`, key dịch vụ. Agent **được đọc lúc runtime** khi task cần,
  không phải hỏi lại.
- Secret chỉ tồn tại trong process memory/env của lệnh cần dùng: không echo cả file, không log token,
  không đưa vào command output/commit message/PR/chat.
- Không tạo `CODEX.local.md`, `.env.agent`, hay bản sao thứ hai. Hai agent dùng **cùng một** file.
- Thiếu/hết hạn credential ⇒ **fail closed**, báo đúng tên capability bị chặn; không bịa secret giả,
  không lưu tạm vào file tracked.

**Bản có thẩm quyền là máy đọc được, không phải đoạn văn trên.**
[`tooling/local-credential-contract.json`](../../tooling/local-credential-contract.json) khai **7
điều** cùng danh sách credential bắt buộc; `npm run gate:local-credentials` kiểm trước khi chạy việc
cần secret.

```bash
npm run gate:local-credentials    # đủ credential chưa — CHỈ in TÊN field thiếu, không in giá trị
```

Đoạn văn trên là bản tóm cho người đọc và **cố ý không chép đủ 7 điều** — chép ra hai nơi là cách
chúng lệch nhau. Hai điều dễ quên nhất, đều nằm trong file JSON:

- **Ghi production luôn cần promotion token NHẬP LÚC CHẠY**, không lấy từ kho. Kho là để *đọc* dữ
  liệu và chạy việc thường; nó cố ý **không** đủ quyền để một lần chạy nhầm ghi được vào production.
- **Thêm credential mới thì thêm entry vào file JSON CÙNG LÚC.** Không có entry thì lần sau không ai
  biết nó phải có, và preflight sẽ báo "đủ" trong khi thiếu — xanh rỗng.

---

## 10. Quy trình mặc định khi làm xong một thay đổi

1. Type check + test liên quan — xanh trước khi đi tiếp.
2. Test trên web thật (headless, mục 8).
3. Cần seed/cleanup dữ liệu thì tự làm qua Management API trong phạm vi DEMO/TEST, không hỏi user.
4. Sửa lỗi → re-test → lặp đến khi chạy đúng. **Không tuyên bố "đã xong" khi chưa thấy nó hoạt động.**
5. `npm run gate:truoc-push` — máy tự sinh số tài liệu (kiểm kê repo, docs views, số đếm) rồi
   chạy hết nhóm gate tĩnh hay vấp **không dừng ở lỗi đầu tiên**; generator có sửa file thì stage
   kèm. Đừng tự đếm số cho tài liệu — đó là việc của generator, con người đếm là con số sẽ trôi.
6. Commit (stage file cụ thể) → push `HEAD:main` → promote nếu gate xanh (mục 3).

### Definition of Done

**Code thường:** scope/risk xác định; test đúng runner xanh; `typecheck:baseline` không thêm
fingerprint; E2E headless nếu đụng UX; docs cập nhật nếu behavior đổi.

**Database:** đủ gate theo mục 5; provenance/digest/evidence; canonical types không drift vì partition;
reconciliation nếu đụng tiền.

**Infrastructure:** không secret trong log/artifact; pin exact image/action/runtime; preflight đúng
project/org; evidence có digest/actor/SHA; rollback test bằng artifact thật; không wide bind, không
hidden retry cho thao tác không idempotent.

---

## 11. Những gì agent KHÔNG được tự làm

1. Promote production khi còn gate đỏ (kể cả gate `continue-on-error` bị nhận nhầm là xanh).
2. Ghi database production bằng PAT sẵn trong vault, KHÔNG đi qua `npm run migrate:forward` — tức
   không có backup làm đường lùi và không có gì ghi lại lần ghi đó dựa trên cái gì.
3. `git add -A` / `git add .`.
4. Sửa hay đổi tên migration đã deploy; replay `migrations-archive/`.
5. Redirect `npm run gen:types >` vào bất kỳ file nào.
6. Backfill/giả mạo `supabase_migrations.schema_migrations` cho lịch sử trông sạch.
7. Ghi dữ liệu vào org THẬT.
8. Commit/di chuyển/in toàn bộ credential từ `CLAUDE.local.md`.
9. Flip TypeScript strict toàn repo trong một PR; move toàn bộ `src/` theo feature trong một mega PR.
10. Tự mở trình duyệt hiện hình khi user không yêu cầu.

---

## 12. Công cụ tri thức

Hai graph, hai vai trò khác nhau:

- **GitNexus** (`.gitnexus/`, pin trong `tooling/agent-tools.json`, gọi qua
  `scripts/run-pinned-gitnexus.mjs`): code exploration, impact analysis cho TS/JS. Chỉ mục là
  **local-only** — không bao giờ commit.
- **Understand Anything** (`.ua/`, hộ chiếu ở `tooling/graph-manifests/ua.json`): onboarding,
  domain map, tài liệu. Graph được commit.

**Cả hai KHÔNG** dùng làm bằng chứng duy nhất cho SQL/RLS/trigger/RPC string/runtime permission —
graph không chứng minh object nào đang deploy.

### Sáu luật

1. **GitNexus freshness là cửa chặn cứng** cho task medium/high-risk.
2. **UA freshness mặc định chỉ CẢNH BÁO**; là cửa chặn cứng CHỈ với: onboarding,
   architecture review, domain review, generated docs.
3. Mỗi graph phải ghi **baseCommit, analyzedAt, scope, tool version, config digest**.
4. **Agent KHÔNG được nạp graph khi chưa có verdict còn hiệu lực** — chạy
   `npm run gate:graph-freshness -- --nhiem-vu <nhiệm vụ>` TRƯỚC khi đọc `.ua/` hoặc `.gitnexus/`.
   Verdict hết hiệu lực ngay khi `HEAD` đổi.
5. **Contract manifest + SQL harness LUÔN ưu tiên hơn mọi graph.** Khi graph mâu thuẫn với
   manifest hoặc kết quả harness, graph sai — không phải ngược lại.
6. **Không auto-commit graph.** Refresh đi PR riêng, hoặc commit riêng trong architecture PR
   liên quan.

#### Cái gì đáng commit, cái gì không

Không phải mọi thứ graph sinh ra đều là artifact. Đo 08/08/2026:

| | Kích thước | Tracked | Loại |
|---|---:|---:|---|
| `.gitnexus/` | **508 MB** | **0 file** | trạng thái chạy — `graph:analyze` dựng lại toàn bộ |
| `.ua/` | 53 MB trên đĩa | **5 file** | phần còn lại là `intermediate/`, `tmp/`, `.trash-*` — đã gitignore |

**`fingerprints.json` là trường hợp ranh giới, và câu trả lời quan trọng:** nó **được commit nhưng
KHÔNG di động giữa hệ điều hành**. Đo trên 197 file đang là CRLF: **127 file có `contentHash` khớp
bytes thô kể cả `\r\n`**. Nghĩa là cùng một commit cho fingerprints khác nhau giữa Windows và Linux.

Hệ quả phải nhớ: **đừng so fingerprints dựng trên máy khác OS với bản đã commit rồi kết luận mã đã
đổi** — nó sẽ báo gần như mọi file đều đổi. Muốn biết mã đổi gì thì dùng `git`, không dùng file này.
Vẫn giữ commit vì `gate:graph-hygiene` đối chiếu `baseCommit` qua cả ba nguồn và cần nó.

Chi tiết và cách sửa tận gốc: `tooling/graph-manifests/ua.json → artifactVsRuntimeState`.

**Trước khi commit graph mới, bắt buộc:**

```bash
npm run gate:graph-secrets    # secret + PII trên artifact (cần binary gitleaks)
```

Gate này đã nối vào job `secret-scan` của `ci-gates.yml`, nên PR refresh không merge được nếu artifact
mang secret hay PII. Chạy tay vẫn nên, nhưng cưỡng chế nằm ở CI — *nhớ chạy* không phải một phép kiểm.

### Hỏi bán kính ảnh hưởng trước khi sửa (plan §16)

GitNexus đăng ký sẵn làm MCP server ở `.mcp.json` — theo **dự án**, không theo máy, nên ai clone
repo là có. Lệnh đi qua `scripts/run-pinned-gitnexus.mjs` nên MCP cũng bị ghim version.

Trước khi sửa bất cứ thứ gì ngoài một dòng, hỏi graph **bán kính ảnh hưởng** bằng `impact` /
`context` / `route_map`, và đọc kết quả cùng bảy thứ dưới đây — đây là bảy chỗ mà một thay đổi
lan ra ngoài file bạn đang mở:

1. **migration SQL** — trigger, RLS, view phụ thuộc bảng bạn đổi
2. **chuỗi tên RPC** trong `supabase.rpc('…')` — không trình biên dịch nào kiểm nó
3. **slug Edge Function** trong `functions.invoke('…')` — và hàm đó có đang deploy không
4. **bảng / view / hàm** mà đường bạn sửa đọc hoặc ghi
5. **tên bảng realtime** — đổi tên bảng làm subscribe thành câm, không báo lỗi
6. **feature flag** gác đường đó
7. **quyền** (`module.action`) mà route và RPC đòi — hai chỗ này lệch nhau là người dùng thấy lối
   vào rồi bị đá về

Sau khi sửa: `detect_changes` để đối chiếu thứ thực sự đổi với thứ bạn định đổi.

Graph trả lời được (1)–(7) ở mức **mã nguồn**. Nó KHÔNG trả lời được "object nào đang deploy" —
phần đó xem `contracts/surfaces/*.json` và `docs/generated/database-inventory.json`, và luật #5
vẫn áp dụng: khi mâu thuẫn, manifest thắng.

Ngưỡng và ánh xạ nhiệm-vụ→cửa-chặn nằm ở `tooling/graph-policy.json`. Hai gate cưỡng chế:
`check-graph-hygiene.mjs` (luật #3, #6 — chạy trong CI) và `check-graph-freshness.mjs`
(luật #1, #2, #4 — chạy local).

Khoảng trống của cả hai graph (SQL, deployed state, string boundary) được bù bằng contract
manifest + SQL harness của repo, không bằng graph.

---

## 13. Checklist mapping — rule cũ đi về đâu

> Bảng này tồn tại để việc rút `CLAUDE.md`/`AGENTS.md`/`AI_RULES.md` thành adapter **không làm rơi
> mất tri thức**. Không được xoá dòng nào ở file cũ khi cột "Chỗ mới" còn trống.

| Rule cũ | Nguồn | Chỗ mới |
|---|---|---|
| Stack, deploy Vercel | CLAUDE/AGENTS | §1 |
| Test Edge = Deno portable v2.9.4 + gotcha coverage | CLAUDE/AGENTS | §8 |
| `tsc --noEmit -p tsconfig.app.json`, root không check gì | CLAUDE/AGENTS | §7 |
| `ts-baseline` ratchet | CLAUDE/AGENTS | §7 (sửa: 30 fingerprint, `.txt` đã chết) |
| `npm run gen:types` ghi thẳng, không redirect | CLAUDE | §6 |
| Drift 92 quan hệ / partition ngày | CLAUDE | §6 (sửa: ~80 partition đã commit) |
| `check-view-invoker` sau migration đụng VIEW | CLAUDE/AGENTS | §5 |
| `check-stable-fn-locks` + gotcha 25006 | CLAUDE | §5 |
| `reconcile-money` cap-1000 | CLAUDE/AGENTS | §5, §8 |
| Quy trình 6 bước khi làm xong thay đổi | CLAUDE/AGENTS | §10 |
| E2E fleet headless, `FLEET_PASS_*`, chỉ ghi DEMO | CLAUDE/AGENTS | §8 |
| Chỉ mở browser headed khi user yêu cầu | CLAUDE | §8, §11.10 |
| Tự seed/cleanup qua Management API | CLAUDE/AGENTS | §10.3 |
| Commit convention + cấm `git add -A` | CLAUDE/AGENTS | §3, §11.3 |
| Push `HEAD:main` + gotcha nhánh local | CLAUDE | §3 (sửa: main ≠ production) |
| Cảnh báo secrets, `CLAUDE.local.md` | CLAUDE/AGENTS | §9 |
| Ba org THẬT/DEMO/TEST + 2 luật RLS | CLAUDE | §2 |
| `clone-org/snapshot.mjs after` = 0/158 rò rỉ | CLAUDE | §2 |
| Cấu trúc thư mục `src/` | CLAUDE/AGENTS/AI_RULES | §14 |
| shadcn/ui làm nền, không tự viết UI trùng | AI_RULES | §14 |
| React Hook Form + Zod cho mọi form | AI_RULES | §14 |
| Data qua hook `use*`, không fetch trong component | AI_RULES | §14 |
| Sonner cho toast, error boundary, không lộ lỗi kỹ thuật | AI_RULES | §14 |
| Lazy load route/component nặng | AI_RULES | §14 |
| Lucide icons, không trộn thư viện icon | AI_RULES | §14 |
| ~~"TypeScript strict mode enabled"~~ | AI_RULES | **BỎ — sai**: `strict: false`. Thay bằng §7 |
| ~~"STORE files in Supabase Storage"~~ | AI_RULES | **BỎ — sai**: hệ thống dùng Cloudflare R2 (`VITE_R2_PUBLIC_BASE`, `src/lib/storage/r2Config.ts`) |
| ~~"KEEP all routes in src/App.tsx"~~ | AI_RULES | **BỎ — đi ngược Đợt 4** (tách route groups + Capability Registry) |
| ~~"NEVER write custom CSS"~~ | AI_RULES | **NỚI**: có page CSS cô lập có chủ đích (`networkCenter.css`) |
| ~~"khớp 100% SUMMARY.md"~~ | `Sidebar.tsx:112` | **BỎ — `SUMMARY.md` đã bị xoá**; nav truth sẽ là Capability Registry |

---

## 14. Quy ước code (giữ từ `AI_RULES.md`, phần còn đúng)

- **UI:** shadcn/ui là nền; chỉ dùng Radix primitive khi mở rộng shadcn; ưu tiên composition.
- **Form:** React Hook Form + Zod schema (`src/lib/*Validation.ts`); không dùng input không kiểm soát.
- **Data:** mọi thao tác dữ liệu qua hook `use*.ts` trong `src/hooks/`; không fetch thẳng trong
  component; có loading/error state.
- **Style:** Tailwind là mặc định. CSS riêng chỉ khi cô lập có chủ đích và có lý do ghi trong file.
- **Icon:** Lucide, không trộn thư viện khác.
- **Feedback:** Sonner cho toast; error boundary; **không** hiện chi tiết lỗi kỹ thuật cho người dùng.
  Wrapper không được biến lỗi thành `[]`, `{}` hay toast chung — phải phân biệt permission,
  validation, concurrency, conflict, internal invariant.
- **Perf:** lazy load route và component nặng; memo hoá chỗ đắt; theo dõi bundle size.
- **Cấu trúc:**
  - `src/pages/` — route entry
  - `src/components/<domain>/` — UI theo domain
  - `src/hooks/` — React Query data hooks
  - `src/lib/` — pure utils + zod schemas
  - `supabase/migrations/` — SQL migration theo timestamp

### RPC/Edge boundary

- **Không gọi `supabase.rpc('string')` trực tiếp trong component.**
- High-risk (tiền, authz) phải qua wrapper typed do domain sở hữu. Prior art để kế thừa:
  - `src/hooks/openclaw-zalo/openClawRpc.ts` — facade "one hole"
  - `src/lib/network-center/{contracts,dto,supabaseRepository,demoRepository}.ts` — boundary đầy đủ nhất repo
- Hiện có **244 call site RPC**, trong đó **176 đi qua `any` cast** trên 67 file (đo 2026-08-06),
  dày nhất ở nhóm tiền: `useInvoices` 15, `income-expenses/statusMutations` 12, `usePeriodFees` 9.

```bash
npm run gate:rpc-cast    # ratchet: con số CHỈ ĐƯỢC GIẢM
```

Hai dạng `(supabase as any).rpc(...)` và `(supabase.rpc as any)(...)` tắt hoàn toàn kiểm tra kiểu ở
đúng chỗ nguy hiểm nhất: **tên RPC gõ sai hay tham số sai tên vẫn biên dịch sạch**, chỉ lộ ra khi chạy
thật. Đó chính là cơ chế đã làm contract media-resolve ship hỏng.

Sửa hết trong một đợt là refactor xuyên hệ thống trên code sổ sách tiền thật — rủi ro cao hơn lợi ích.
Vì vậy luật là **chặn tăng**: file mới không được có cast, file cũ không được thêm. Khi giảm được thì
chạy `--write` để chốt mức mới. Mẫu để noi theo: `src/hooks/openclaw-zalo/openClawRpc.ts` — gom cast
vào **đúng một lỗ**, tên RPC là union được compiler kiểm, kết quả cố ý để `unknown` để buộc validate
bằng Zod thay vì tin generated type.
