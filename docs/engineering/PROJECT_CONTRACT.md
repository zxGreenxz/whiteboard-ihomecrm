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
- Supabase PostgreSQL 17.6: 625 migration, ~1000 hàm SECURITY DEFINER, RLS trên mọi bảng public
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

> ⚠ **Trạng thái: việc đổi Vercel Production Branch CHƯA làm** (cần thao tác dashboard —
> xem `tooling/program-status.json`). Cho tới khi xong, `main` **vẫn là** production.
>
> Trong giai đoạn này, thay đổi **chạm runtime** (`src/`, `api/`, `vite.config.ts`, dependencies)
> vẫn được push — cấm push đồng nghĩa với đứng yên vì gần như mọi việc đều là code — nhưng phải qua
> bốn bước:
>
> 1. đủ gate theo loại thay đổi (typecheck + test liên quan + `npm run build`);
> 2. logic có nhánh điều kiện: **kiểm bằng đột biến** — cố tình phá, xác nhận đúng test đỏ, hoàn nguyên.
>    Test xanh chỉ chứng minh test chạy, không chứng minh nó bắt được lỗi;
> 3. **kiểm bundle sau build**, không chỉ tin test: Vitest và production build khác nhau ở khoản nạp
>    asset — một `import.meta.glob` hỏng có thể vẫn xanh trong test rồi rơi về rỗng trên production;
> 4. ưu tiên thay đổi làm hệ thống **nghiêm ngặt hơn** (chặn bớt, gác thêm quyền) trước thay đổi nới lỏng.

Commit: `feat(scope): …` / `fix(scope): …` / `chore(scope): …`, body bullet "what + why".
**Stage đúng file mình sửa, liệt kê tên cụ thể — KHÔNG `git add -A`, KHÔNG `git add .`.**
Cây làm việc repo này thường có file dở dang từ phiên khác; gom nhầm là lỗi nặng.
Push bằng `git push origin HEAD:main` (nhánh local thường không phải `main`, `git push origin main`
sẽ đẩy nhầm nhánh cũ); kiểm trước bằng `git merge-base --is-ancestor origin/main HEAD`.

---

## 4. Ghi vào production database

Đây là ranh giới **khác** với deploy web. Deploy web sai thì rollback được; migration sai thì không.

- Mọi write production qua Management API / apply migration **phải có promotion token nhập tại thời
  điểm chạy**. KHÔNG dùng thẳng PAT sẵn trong `CLAUDE.local.md` cho đường ghi production.
- Preflight bắt buộc: đúng project/org/environment, working tree sạch, reviewed SHA.
- Ghi evidence: statement bytes, normalized digest, catalog fingerprint trước/sau, actor.
- Fail closed khi provenance state / reviewed SHA / precondition catalog lạ.
- **Không rollback tự động destructive** — forward fix riêng.

> ⚠ **PITR đang TẮT** (đo 2026-08-05: `pitr_enabled=false`, chỉ 7 backup vật lý hằng ngày,
> RPO ~24h). Cho tới khi bật PITR: **kéo dump thủ công ngay trước mỗi thao tác schema**.
> `pg_dump` 17.10 có tại `C:\Program Files\PostgreSQL\17\bin`.

---

## 5. Migration

- Migration mới: **timestamp 14 chữ số duy nhất**, đặt trong `supabase/migrations/`, immutable sau
  khi merge. Không sửa file lịch sử đã deploy.
- **Legacy history KHÔNG replay được** — đừng tin `supabase db push` hay `supabase start`:
  625 file có 33 nhóm trùng version (69 file) + bộ legacy `001_`–`033_` còn collision nội bộ
  (`016_` ×4, `017_` ×2); ledger `supabase_migrations.schema_migrations` đã tụt lại sau production.
- `supabase/migrations-archive/` **TUYỆT ĐỐI KHÔNG replay** (1 file superseded + `migrations-bundle/`
  14 file `*_apply_*.sql` hand-apply Apr–May 2026, đã phản ánh trong DB live).
- Repo apply migration qua Management API (`scripts/apply-sql.mjs`, `scripts/apply-accounting-rollout.mjs`),
  **không** dùng `supabase db push`. CI có guard cấm auto-apply.

### Gate bắt buộc theo loại thay đổi

| Thay đổi | Gate |
|---|---|
| VIEW | `node scripts/check-view-invoker.mjs` |
| FUNCTION/RPC | `node scripts/check-stable-fn-locks.mjs` + ACL/owner/search_path |
| RLS/POLICY | harness role thật + cross-tenant |
| Đụng tiền | `node scripts/reconcile-money.mjs [YYYY-MM]` + idempotency + concurrency |
| Bảng mới có `organization_id` | policy `_hide_sandbox_admin` (mục 2) |
| Đổi schema | `npm run gen:types` (mục 6) |

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
CI pin `deno-version: v2.x`; bản đã xác minh 22/22 xanh trên Windows là **v2.9.4**.

**GOTCHA suite Deno này KHÔNG phủ**: `/ingest` với giá trị ngoài miền (`connectionType`/`sessionType`),
hay ép `rpcErrorStatus` nhận `23502`/`23514`/`23503` — đã xác nhận bằng đột biến (vô hiệu hoá logic
đó vẫn 22/22 xanh). Phần đó do test Node phủ
(`scripts/__tests__/network-center-ingest-domains.test.mjs`).

**GOTCHA CRLF phá shebang:** file `.mjs` mở đầu `#!/usr/bin/env node` mà dòng đó kết thúc `\r\n` sẽ
ném "SyntaxError: Invalid or unexpected token" ngay khi một test import nó — trong khi `node --check`
nói file hợp lệ. Lỗi không chỉ vào đâu cả: không số dòng, không stack, chỉ "0 test".
`.gitattributes` đã ép `*.mjs text eol=lf` — đừng gỡ.

**GOTCHA mutation test:** phải chứng minh file **thực sự đổi** và chỉ rõ test nào đỏ; không chỉ tin
exit code; phải hoàn nguyên digest gốc.

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

---

## 10. Quy trình mặc định khi làm xong một thay đổi

1. Type check + test liên quan — xanh trước khi đi tiếp.
2. Test trên web thật (headless, mục 8).
3. Cần seed/cleanup dữ liệu thì tự làm qua Management API trong phạm vi DEMO/TEST, không hỏi user.
4. Sửa lỗi → re-test → lặp đến khi chạy đúng. **Không tuyên bố "đã xong" khi chưa thấy nó hoạt động.**
5. Commit (stage file cụ thể) → push `HEAD:main` → promote nếu gate xanh (mục 3).

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
2. Ghi database production bằng PAT sẵn trong vault, không có promotion token.
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

- **GitNexus** (khi đã pin version trong `tooling/agent-tools.json`): code exploration, impact
  analysis cho TS/JS. **KHÔNG** dùng làm bằng chứng duy nhất cho SQL/RLS/trigger/RPC string/
  runtime permission — graph không chứng minh object nào đang deploy.
- **Understand Anything** (`.ua/`, pin 2.9.4, `outputLanguage: "vi"`): onboarding, domain map.
  **KHÔNG** dùng làm authorization evidence. Graph hiện analyzed 29/07 (field `lastAnalyzedAt`),
  chưa có Network Center/OpenClaw ⇒ coi là **stale** cho đến khi refresh.
- Khoảng trống của cả hai (SQL, deployed state, string boundary) được bù bằng contract manifest +
  SQL harness của repo, không bằng graph.

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
- Hiện có **244 call site RPC**, trong đó **174 (71%) đi qua `any` cast** — ba dạng cần đếm khi đo
  baseline: `.rpc(`, `(supabase as any).rpc(`, `(supabase.rpc as any)(`. Raw-call baseline chỉ được
  **giảm**, không được tăng.
