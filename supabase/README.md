# Supabase runbook — chọn đúng thao tác

- Sửa SQL/RPC/RLS/tiền, backup hoặc apply: đọc [migration runbook](../docs/engineering/MIGRATION_STRATEGY.md) trước thao tác.
- Thử dữ liệu, role hoặc scope org: [data environments](../docs/engineering/DATA_ENVIRONMENTS.md).
- Kiểm object/types hiện hành: catalog/evidence, [generated types](../src/integrations/supabase/types.ts) và [schema reference](../docs/DATABASE_SCHEMA.md).
- Edge deploy và auth: [functions](functions/README.md).

Legacy history **KHÔNG replay được**, có trùng version/hand-apply; không dùng `supabase db push` để phát hành hoặc replay `migrations-archive/`.
Chỉ forward lane có backup và evidence; không sửa lịch sử đã deploy. Chi tiết thao tác và điều kiện dừng có một chủ sở hữu là migration runbook.
`gen:types` cần đúng project, credential và mạng; không in token/service-role/database URL vào tài liệu hay log.
