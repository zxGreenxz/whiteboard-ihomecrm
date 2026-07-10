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
- **Regen Supabase types**: sau khi apply migration đổi schema, chạy
  `npm run gen:types > src/integrations/supabase/types.ts` rồi thêm lại dòng
  comment header đầu file. ĐỪNG để types.ts trôi sau migration (gây `as any` lan
  rộng). PAT đọc từ `CLAUDE.local.md`.

## Quy trình mặc định khi làm xong một thay đổi

1. **Chạy type check & test liên quan** — phải xanh trước khi đi tiếp.
2. **Test trực tiếp trên web** bằng Playwright MCP (`mcp__playwright__browser_*`):
   - Mở <https://ptcrm.vercel.app> (hoặc dev server nếu chạy local)
   - Đăng nhập bằng tài khoản test (xem `CLAUDE.local.md`)
   - Đi tới đúng tính năng vừa sửa và thử nghiệm cả happy path lẫn edge case
   - Quan sát console errors qua `mcp__playwright__browser_console_messages`
3. **Tự động hoàn thiện dữ liệu nếu cần**: nếu tính năng cần seed/cleanup dữ liệu (vd phải có meter trước mới test ghi chỉ số được), dùng Supabase Management API với PAT trong `CLAUDE.local.md` để chuẩn bị state đủ test, không hỏi user.
4. **Sửa lỗi → re-test → lặp lại** đến khi tính năng chạy đúng. Không tuyên bố "đã xong" khi chưa thấy nó hoạt động trong browser.
5. **Commit** với message Việt-Anh trộn theo style hiện có (`feat(scope): mô tả`, `fix(scope): mô tả`). Stage file cụ thể, **không** dùng `git add -A`.
6. **Push** lên `origin/main` ngay khi commit (repo này deploy thẳng từ main qua Vercel).

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
