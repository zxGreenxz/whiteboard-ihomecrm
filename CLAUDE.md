# CLAUDE.md — Workflow mặc định cho dự án

File này áp dụng cho mọi session Claude Code làm việc trên repo này.

> **Nguồn luật chung: [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md)**
> — dùng chung cho Claude Code và Codex. Khi file này mâu thuẫn với Project Contract, **Contract thắng**.
> File này đang trong giai đoạn chuyển tiếp: nội dung vẫn đầy đủ để không rơi mất tri thức, sẽ rút
> thành adapter mỏng sau khi Contract chạy thử qua vài session (xem `tooling/program-status.json`).

## Stack ngắn gọn

- React + TypeScript + Vite (deploy Vercel — production: <https://ptcrm.vercel.app>)
- shadcn/ui + Tailwind, react-hook-form + zod
- Supabase (Postgres + Auth + Storage), migrations dưới `supabase/migrations/`
- Test: Vitest + fast-check (property-based) — chạy `npx vitest run <path>`
- **Test Edge Function (`supabase/functions/*/index.test.ts`)**: chạy bằng **Deno**,
  không phải Vitest/Node. Máy chưa có Deno cài sẵn thì tải bản portable (không cài
  hệ thống, không đụng PATH/profile) rồi gọi thẳng exe:
  ```bash
  curl -sL -o deno.zip https://github.com/denoland/deno/releases/download/v2.9.4/deno-x86_64-pc-windows-msvc.zip
  unzip -o deno.zip   # ra deno.exe trong thư mục hiện tại
  ./deno.exe test --config supabase/functions/network-center-worker/deno.json \
    supabase/functions/network-center-worker/index.test.ts --allow-env
  ```
  CI (`.github/workflows/network-center-validation.yml`) pin `deno-version: v2.x`
  qua `denoland/setup-deno@v2` (không khoá patch); bản đã xác minh chạy 22/22 test
  xanh trên Windows là **v2.9.4** (03/08/2026). Mỗi thư mục function có `deno.json`
  + `deno.lock` riêng khoá version các npm specifier (`@supabase/supabase-js`, `zod`).
  GOTCHA: `index.test.ts` không có test nào gọi `/ingest` với giá trị ngoài miền
  (`connectionType`/`sessionType`…) hay ép `rpcErrorStatus` nhận `23502`/`23514`/`23503`
  — đã xác nhận bằng đột biến (vô hiệu hoá logic đó vẫn 22/22 xanh). Domain validation
  và SQLSTATE remap của `index.ts` được phủ bởi test Node (`scripts/__tests__/network-center-ingest-domains.test.mjs`,
  `scripts/test-network-center-ingest-domains-disposable.mjs`) import thẳng module đó,
  không phải bởi suite Deno này.
- Type check thật: `npx tsc --noEmit -p tsconfig.app.json` (root `tsc --noEmit` KHÔNG check gì).
  Ratchet là **tập fingerprint** trong `ts-baseline.json` (hiện **30**), không phải con số
  trong `ts-baseline.txt` — file `.txt` chỉ chứa chuỗi `74` và **không script/CI nào đọc**
  (artifact chết của cơ chế đếm cũ). Chạy `npm run typecheck:baseline`; fail khi có
  fingerprint MỚI, không quan tâm tổng số.
- **Regen Supabase types**: sau khi apply migration đổi schema, chạy **`npm run gen:types`**
  — KHÔNG redirect, KHÔNG thêm header tay. `scripts/gen-supabase-types.mjs` GHI THẲNG vào
  `src/integrations/supabase/types.ts` (outputPath hardcode ở `:192`) và TỰ chèn header
  (`:9`/`:79`); stdout chỉ có banner npm. Muốn xem drift mà không đụng repo:
  `cp src/integrations/supabase/types.ts /tmp/before.ts && npm run gen:types && diff /tmp/before.ts src/integrations/supabase/types.ts`.
  ĐỪNG để types.ts trôi sau migration (gây `as any` lan rộng). PAT đọc từ `CLAUDE.local.md`.
  **Sau regen luôn chạy `npm run types:normalize`** để bỏ partition ngày
  (`network_{device,interface}_samples_YYYYMMDD`) mà Network Center sinh mỗi ngày —
  chúng không phải API frontend, để lại thì file phình ~96 dòng/ngày và drift job đỏ
  dù logical schema không đổi. `npm run types:check` là gate (fail nếu còn partition).
  Luật ở `supabase/generated-types-policy.json`. Đã chuẩn hoá lần đầu 06/08/2026:
  bỏ 80 partition, 32 407 → 28 567 dòng.
- **Sau MỌI migration đụng VIEW**: chạy `node scripts/check-view-invoker.mjs`.
  GOTCHA án lệ: `CREATE OR REPLACE VIEW` làm RỚT `security_invoker=true` → view
  chạy dưới quyền owner, lộ dữ liệu tenant khác. Script exit 1 nếu có view hở.
- **Sau MỌI migration TẠO/SỬA HÀM**: chạy `node scripts/check-stable-fn-locks.mjs`.
  GOTCHA án lệ (đã cắn 5 lần): PostgREST chạy hàm `STABLE`/`IMMUTABLE` trong
  transaction **READ ONLY**, nên bất kỳ `SELECT … FOR SHARE` nào trong thân hàm —
  hoặc trong hàm nó gọi (`authorize_tenant_action_v3`, `lock_org_for_decision_v1`,
  `_profit_assert_authorized_v2`…) — ném `25006`. Gọi bằng SQL thì **XANH**, gọi từ
  trình duyệt thì **HỎNG**, nên loại này sống rất lâu mà không ai thấy
  (`profit_close_state_v2` hỏng 10 ngày, kéo sập cả tab "Chốt LN tháng").
  **Hàm nào lấy khoá dòng thì phải khai `VOLATILE`** — an toàn vì `supabase.rpc()`
  mặc định POST; chỉ hàm cần gọi qua GET mới buộc non-volatile. Script exit 1 nếu hở.
- **Đối chiếu tiền**: `node scripts/reconcile-money.mjs [YYYY-MM]` so SUM SQL thật
  vs tổng-1000-dòng-đầu — chạy ở mọi thay đổi đụng số tiền để bắt bug cap-1000.

## Quy trình mặc định khi làm xong một thay đổi

1. **Chạy type check & test liên quan** — phải xanh trước khi đi tiếp.
2. **Test trực tiếp trên web** — **MẶC ĐỊNH CHẠY ẨN (headless), KHÔNG mở cửa sổ trình duyệt.**

   Ưu tiên hạm đội headless ở `.e2e-fleet/` (Playwright Test Runner) vì nhanh nhất
   và chạy song song được nhiều luồng:

   ```bash
   cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
   ```

   - Tăng `FLEET_WORKERS` (8 → 30) khi cần quét rộng/nhanh. Mỗi worker là một
     browser context riêng nên nhiều tài khoản đăng nhập song song không đá nhau.
   - Tài khoản test DEMO khai ở `.e2e-fleet/specs/auth.ts`; **mật khẩu KHÔNG nằm
     trong repo** — truyền qua env `FLEET_PASS_CHUNHA` / `FLEET_PASS_KETOAN` /
     `FLEET_PASS_QUANLY` (giá trị lấy từ `CLAUDE.local.md`). Thiếu env thì test
     báo lỗi rõ ràng ngay.
   - Thử cả happy path lẫn edge case, và **luôn kiểm console errors**
     (`trackConsoleErrors` đã lọc sẵn nhiễu mạng).
   - **Chỉ ghi dữ liệu vào org DEMO `dddd0000-…0001`**; org thật `aaaa0000-…0001`
     chỉ đọc. Mọi fixture tạo ra phải tự dọn cuối bài.
   - Playwright MCP (`mcp__playwright__browser_*`) cũng chạy ẩn — dùng khi cần soi
     kỹ MỘT màn hình (chụp ảnh, đọc DOM từng bước), không dùng để quét diện rộng.
   - Nếu session không có công cụ browser nào, ghi rõ khoảng trống xác minh trong
     báo cáo cuối, **không** tuyên bố đã test.

   **CHỈ mở trình duyệt hiện hình (headed) khi user YÊU CẦU TƯỜNG MINH** — kiểu
   "bật web lên để tôi xem/tôi test <X>". Khi đó:

   ```bash
   cd .e2e-fleet && FLEET_HEADED=1 FLEET_WORKERS=2 npx playwright test specs/<file>.spec.ts
   ```

   Giữ `FLEET_WORKERS` nhỏ (1–2) cho user nhìn kịp; config đã bật `slowMo` sẵn ở
   chế độ headed. **Không tự ý mở cửa sổ trình duyệt khi user không yêu cầu.**
3. **Tự động hoàn thiện dữ liệu nếu cần**: nếu tính năng cần seed/cleanup dữ liệu (vd phải có meter trước mới test ghi chỉ số được), dùng Supabase Management API với PAT trong `CLAUDE.local.md` để chuẩn bị state đủ test, không hỏi user.
4. **Sửa lỗi → re-test → lặp lại** đến khi tính năng chạy đúng. Không tuyên bố "đã xong" khi chưa thấy nó hoạt động trong browser.
5. **Commit** với message Việt-Anh trộn theo style hiện có (`feat(scope): mô tả`, `fix(scope): mô tả`).
   Stage **đúng những file mình vừa sửa trong phiên**, liệt kê tên cụ thể —
   **không** `git add -A`, **không** `git add .`. Cây làm việc của repo này
   thường xuyên có hàng chục file dở dang từ phiên khác; gom nhầm chúng vào
   commit của mình là lỗi nặng.
6. **Push lên `origin/main` sau khi commit — tự làm, không hỏi lại user.**
   Nhưng **`main` KHÔNG được coi là production**. Mô hình phát hành (chi tiết ở
   `docs/whiteboard-ihomecrm-architecture-agent-plan-2026-08-05 (1).md` §0.4):

   ```text
   push main  →  Vercel PREVIEW  →  chạy gate suite
                    gate xanh hết  →  promote branch `production` + ghi evidence
                    gate đỏ bất kỳ →  DỪNG; production giữ nguyên SHA cũ
   ```

   ⚠ **Trạng thái hiện tại: Vercel vẫn đang deploy từ `main`** — việc đổi
   Production Branch sang `production` chưa làm (cần thao tác trên dashboard
   Vercel, xem `tooling/program-status.json`). Cho tới khi đổi xong,
   **push `main` = deploy production**, nên áp luật chặt hơn cho mọi thay đổi
   CHẠM RUNTIME (`src/`, `api/`, `vite.config.ts`, `package.json` dependencies):

   1. đủ gate theo loại thay đổi (typecheck + test liên quan + build);
   2. với logic có nhánh điều kiện: **kiểm bằng đột biến** — cố tình phá rồi
      xác nhận đúng test đỏ, sau đó hoàn nguyên. Test xanh không chứng minh test
      có ích;
   3. **kiểm bundle sau `npm run build`**, không chỉ tin test. Vitest và
      production build không giống nhau ở khoản nạp asset: một `import.meta.glob`
      hỏng có thể vẫn xanh trong test rồi rơi về rỗng trên production;
   4. thay đổi làm hệ thống **nghiêm ngặt hơn** (chặn bớt, gác thêm quyền) an
      toàn hơn thay đổi nới lỏng — cân nhắc thứ tự làm theo hướng đó.

   Đây là luật **thực dụng thay cho "đừng push code"**: gần như mọi việc trong
   plan đều là code, nên cấm push đồng nghĩa với đứng yên. Sau khi flip Vercel
   xong thì ràng buộc này biến mất và preview lo phần còn lại.

   GOTCHA: nhánh local thường **không phải** `main` (vd đang ở
   `fix/v5-collection-completion-...`), nên `git push origin main` sẽ fail
   *"tip is behind its remote counterpart"* — đó là đang đẩy nhánh `main` local
   cũ, không phải commit vừa tạo. Luôn push bằng:

   ```bash
   git push origin HEAD:main
   ```

   Kiểm tra trước bằng `git merge-base --is-ancestor origin/main HEAD` để chắc
   là fast-forward; nếu không phải thì fetch + rebase rồi push lại.

7. **Write database production** (Management API, apply migration) luôn cần
   promotion token nhập tại chỗ — KHÔNG dùng thẳng PAT sẵn trong `CLAUDE.local.md`.
   Deploy web sai thì rollback được; migration sai thì không.

## Quy ước commit

Xem `git log --oneline` để theo style. Tóm tắt:

- `feat(scope): ...` — tính năng/UI mới
- `fix(scope): ...` — sửa bug
- `chore(scope): ...` — build/deps/config
- Body (nếu có) viết bullet `- ...` mô tả "what + why"
- Luôn kèm trailer:

  ```text
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Cảnh báo về secrets

- **KHÔNG bao giờ commit** `CLAUDE.local.md`, `.env.local`, hay bất kỳ token/password/PAT nào vào repo. Cả hai đã có trong `.gitignore`.
- Khi cần Supabase admin access, đọc PAT từ `CLAUDE.local.md` trong runtime — không in ra console/log/commit message.

## Ba công ty (org) trong cùng một DB — đọc trước khi động vào RLS/báo cáo

| Org | ID | Là gì |
|---|---|---|
| THẬT | `aaaa0000-0000-4000-8000-000000000001` | sổ sách thật, **chỉ đọc** khi test |
| DEMO | `dddd0000-0000-4000-8000-000000000001` | seed tay 2 toà (`scripts/docs-demo/`), có nút reset |
| **TEST** | `cccc0000-0000-4000-8000-000000000001` | **bản sao dữ liệu công ty thật** — chỗ để thử tính năng mới của mọi plan |

**Muốn thử tính năng mới trên dữ liệu thật thì dùng org TEST**, đăng nhập bằng
`test.nguyentamca165` / `test.nathan` / `test.joey` / `test.bosshuy` (mật khẩu ở
`CLAUDE.local.md`). Đồng bộ lại dữ liệu: *Cài đặt → Tổ chức → Đồng bộ dữ liệu mới nhất*,
hoặc `node scripts/clone-org/clone.mjs`. Chi tiết + các bẫy đã cắn: `scripts/clone-org/README.md`.

Hai điều PHẢI nhớ khi viết migration/RPC mới:

1. **Bảng mới có `organization_id` + bật RLS ⇒ phải thêm policy `<bảng>_hide_sandbox_admin`**
   (khuôn ở `supabase/migrations/20260801040000_fix_sandbox_hide_null_org.sql`), nếu không
   dữ liệu org TEST sẽ lọt vào màn hình của chủ nhà và nhân đôi mọi con số.
   Nhớ bọc `COALESCE(... , false)` — `NULL = ANY(...)` ra NULL sẽ giấu nhầm cả dòng
   `organization_id IS NULL` của công ty thật.
2. **Hàm SECURITY DEFINER không bị RLS chặn.** Báo cáo mới lọc toà thì lọc qua
   `public.can_access_building()` / `accessible_building_ids()` (đã chặn sandbox sẵn),
   đừng tự viết `is_super_admin() OR ...` — đó chính là lỗ đã làm `fa_occupancy_monthly`
   trả thừa 12 toà của org TEST.

Cửa chặn: `node scripts/clone-org/snapshot.mjs after` — phải ra "0/158 bảng rò rỉ".

## Cấu trúc nhanh

- `src/pages/` — route entry
- `src/components/<domain>/` — UI theo domain (income-expenses, meter-readings, invoices, customers…)
- `src/hooks/` — React Query data hooks
- `src/lib/` — pure utils + zod schemas (`*Validation.ts`)
- `supabase/migrations/` — SQL migrations theo timestamp
