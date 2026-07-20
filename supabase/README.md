# Supabase runbook

> **Reviewed:** 2026-07-20

## Nguồn sự thật

- Public generated types: [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
- Mô tả schema: [docs/DATABASE_SCHEMA.md](../docs/DATABASE_SCHEMA.md).
- Cổng tài liệu: [docs/README.md](../docs/README.md).
- Migration hoạt động: `supabase/migrations/*.sql`, chạy theo thứ tự tên file. Hiện có 362 file; không dùng hướng dẫn cũ kiểu “chỉ chạy 001–009”.

## Quy tắc migration

- Thêm migration mới, không sửa lịch sử đã deploy trừ khi có quy trình recovery được duyệt.
- Dùng timestamp/tên duy nhất; migration phải idempotent ở chỗ cần thiết và ghi rõ rollback/forward-fix cho thay đổi rủi ro.
- `migrations-archive` chỉ để tra cứu. Không replay file superseded.
- Sau deploy schema: regenerate types, review diff, chạy test caller/RLS/RPC liên quan.

## Kiểm tra thường dùng

```powershell
Get-ChildItem supabase/migrations -Filter *.sql | Measure-Object
rg "object_or_rpc_name" supabase/migrations src
npm run gen:types
```

`gen:types` cần Supabase CLI/quyền project và network. Không đưa token, service-role hoặc database URL vào tài liệu/log.

## Edge Functions

Mỗi function nằm trong `supabase/functions/<name>/`. Deploy và secret thuộc môi trường Supabase; kiểm auth ở cả gateway lẫn function. Các function hiện hành gồm admin-create-user, demo-reset, llm-proxy, salary-v5-jobs và send-push.
