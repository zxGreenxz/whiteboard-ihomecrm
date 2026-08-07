# Supabase runbook

> **Reviewed:** 2026-07-20

## Nguồn sự thật

- Public generated types: [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
- Mô tả schema: [docs/DATABASE_SCHEMA.md](../docs/DATABASE_SCHEMA.md).
- Cổng tài liệu: [docs/README.md](../docs/README.md).
- Migration hoạt động: `supabase/migrations/*.sql`. **Lịch sử legacy KHÔNG replay được** — 631 file hiện có gồm 33 nhóm trùng version (69 file) và bộ legacy `001_`–`033_` còn collision nội bộ; `supabase db push`/`supabase start` chết ở unique constraint của ledger. Repo apply qua Management API (`scripts/apply-sql.mjs`), không dùng `db push`. Số file đếm bằng script, đừng chép tay: `npm run catalog:capture`.

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

Mỗi function nằm trong `supabase/functions/<name>/`. Deploy và secret thuộc môi trường Supabase; kiểm auth ở cả gateway lẫn function. Danh sách, vai trò và runbook hiện hành xem [functions/README.md](functions/README.md).
