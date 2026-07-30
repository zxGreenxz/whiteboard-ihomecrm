# CLAUDE.md — Workflow mặc định cho dự án

File này áp dụng cho mọi session Claude Code làm việc trên repo này.

## Stack ngắn gọn

- React + TypeScript + Vite (deploy Vercel — production: <https://ptcrm.vercel.app>)
- shadcn/ui + Tailwind, react-hook-form + zod
- Supabase (Postgres + Auth + Storage), migrations dưới `supabase/migrations/`
- Test: Vitest + fast-check (property-based) — chạy `npx vitest run <path>`
- Type check thật: `npx tsc --noEmit -p tsconfig.app.json` (root `tsc --noEmit` KHÔNG check gì).
  Repo có baseline lỗi TS pre-existing ghi ở `ts-baseline.txt`; chạy
  `npm run typecheck:baseline` để chặn regress (fail nếu lỗi TĂNG).
- **Regen Supabase types**: sau khi apply migration đổi schema, chạy **`npm run gen:types`**
  — KHÔNG redirect, KHÔNG thêm header tay. `scripts/gen-supabase-types.mjs` GHI THẲNG vào
  `src/integrations/supabase/types.ts` (outputPath hardcode ở `:192`) và TỰ chèn header
  (`:9`/`:79`); stdout chỉ có banner npm. Muốn xem drift mà không đụng repo:
  `cp src/integrations/supabase/types.ts /tmp/before.ts && npm run gen:types && diff /tmp/before.ts src/integrations/supabase/types.ts`.
  ĐỪNG để types.ts trôi sau migration (gây `as any` lan rộng). PAT đọc từ `CLAUDE.local.md`.
  ⚠ Hiện có **drift sẵn ~92 quan hệ** (`network_*`, gồm 65 phân mảnh ngày tự sinh mỗi ngày)
  — regen sẽ kéo chúng vào diff. Xử riêng, đừng gộp vào PR tính năng.
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
6. **Push lên `origin/main` NGAY sau khi commit — tự làm, không hỏi lại user.**
   Repo deploy thẳng từ main qua Vercel nên việc chưa push = việc chưa xong.

   GOTCHA: nhánh local thường **không phải** `main` (vd đang ở
   `fix/v5-collection-completion-...`), nên `git push origin main` sẽ fail
   *"tip is behind its remote counterpart"* — đó là đang đẩy nhánh `main` local
   cũ, không phải commit vừa tạo. Luôn push bằng:

   ```bash
   git push origin HEAD:main
   ```

   Kiểm tra trước bằng `git merge-base --is-ancestor origin/main HEAD` để chắc
   là fast-forward; nếu không phải thì fetch + rebase rồi push lại.

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

## Cấu trúc nhanh

- `src/pages/` — route entry
- `src/components/<domain>/` — UI theo domain (income-expenses, meter-readings, invoices, customers…)
- `src/hooks/` — React Query data hooks
- `src/lib/` — pure utils + zod schemas (`*Validation.ts`)
- `supabase/migrations/` — SQL migrations theo timestamp
