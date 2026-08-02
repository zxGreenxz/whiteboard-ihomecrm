# AGENTS.md — Workflow mặc định cho Codex

File này áp dụng cho mọi session Codex làm việc trên repo này.

## Stack ngắn gọn

- React + TypeScript + Vite (deploy Vercel — production: <https://ptcrm.vercel.app>)
- shadcn/ui + Tailwind, react-hook-form + zod
- Supabase (Postgres + Auth + Storage), migrations dưới `supabase/migrations/`
- Test: Vitest + fast-check (property-based) — chạy `npx vitest run <path>`
- Type check thật: `npx tsc --noEmit -p tsconfig.app.json` (root `tsc --noEmit` KHÔNG check gì).
  Repo có baseline lỗi TS pre-existing ghi ở `ts-baseline.txt`; chạy
  `npm run typecheck:baseline` để chặn regress (fail nếu lỗi TĂNG).
- **Regen Supabase types**: sau khi apply migration đổi schema, chạy
  `npm run gen:types > src/integrations/supabase/types.ts` rồi thêm lại dòng
  comment header đầu file. ĐỪNG để `types.ts` trôi sau migration (gây `as any` lan
  rộng). PAT đọc từ `CLAUDE.local.md`.
- **Sau MỌI migration đụng VIEW**: chạy `node scripts/check-view-invoker.mjs`.
  GOTCHA án lệ: `CREATE OR REPLACE VIEW` làm RỚT `security_invoker=true` → view
  chạy dưới quyền owner, lộ dữ liệu tenant khác. Script exit 1 nếu có view hở.
- **Đối chiếu tiền**: `node scripts/reconcile-money.mjs [YYYY-MM]` so SUM SQL thật
  với tổng 1000 dòng đầu — chạy ở mọi thay đổi đụng số tiền để bắt bug cap-1000.

## Quy trình mặc định khi làm xong một thay đổi

1. **Chạy type check và test liên quan** — phải xanh trước khi đi tiếp.
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
3. **Tự động hoàn thiện dữ liệu test nếu cần**: nếu tính năng cần seed/cleanup dữ
   liệu (ví dụ phải có meter trước mới test ghi chỉ số được), dùng Supabase
   Management API với PAT trong `CLAUDE.local.md` để chuẩn bị state đủ test trong
   phạm vi dữ liệu test được phép, không hỏi user.
4. **Sửa lỗi → re-test → lặp lại** đến khi tính năng chạy đúng. Không tuyên bố
   "đã xong" khi chưa thấy nó hoạt động trong browser; nếu không thể test browser,
   phải nói rõ chưa xác minh phần nào.
5. **Commit** với message Việt-Anh trộn theo style hiện có (`feat(scope): mô tả`,
   `fix(scope): mô tả`). Stage file cụ thể, **không** dùng `git add -A` và không
   đưa thay đổi không liên quan của user vào commit.
6. **Push** lên `origin/main` ngay khi commit (repo này deploy thẳng từ main qua
   Vercel), trừ khi user yêu cầu không push hoặc môi trường không cho phép.

## Quy ước commit

Xem `git log --oneline` để theo style. Tóm tắt:

- `feat(scope): ...` — tính năng/UI mới
- `fix(scope): ...` — sửa bug
- `chore(scope): ...` — build/deps/config
- Body (nếu có) viết bullet `- ...` mô tả "what + why"
- Thay đổi do Codex thực hiện dùng trailer:

  ```text
  Co-Authored-By: Codex <noreply@openai.com>
  ```

## Cảnh báo về secrets

- **KHÔNG bao giờ commit** `CLAUDE.local.md`, `.env.local`, hay bất kỳ
  token/password/PAT nào vào repo. Các file secret phải nằm trong `.gitignore`.
- Khi cần Supabase admin access, đọc PAT từ `CLAUDE.local.md` trong runtime —
  không in giá trị secret ra console/log/commit message.

## Cấu trúc nhanh

- `src/pages/` — route entry
- `src/components/<domain>/` — UI theo domain (income-expenses, meter-readings,
  invoices, customers…)
- `src/hooks/` — React Query data hooks
- `src/lib/` — pure utils + zod schemas (`*Validation.ts`)
- `supabase/migrations/` — SQL migrations theo timestamp
