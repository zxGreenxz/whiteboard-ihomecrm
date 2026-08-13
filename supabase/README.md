# Supabase runbook

> **Reviewed:** 2026-07-20

## Nguồn sự thật

- Public generated types: [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
- Mô tả schema: [docs/DATABASE_SCHEMA.md](../docs/DATABASE_SCHEMA.md).
- Cổng tài liệu: [docs/README.md](../docs/README.md).
- Migration hoạt động: `supabase/migrations/*.sql`. **Lịch sử legacy KHÔNG replay được** — 673 file hiện có gồm nhiều nhóm trùng version cộng collision nội bộ trong bộ legacy `001_`–`033_`; `supabase db push`/`supabase start` chết ở unique constraint của ledger. Con số 633 do `gate:doc-counts` canh nên nó không lạc hậu được; **số nhóm trùng thì đọc từ [`migration-provenance.json`](migration-provenance.json)** (`duplicateVersions`, `ledgerRows`, `ledgerMaxVersion`) chứ đừng chép vào đây — bản trước ghi "33 nhóm trùng (69 file)", đo lại 08/08/2026 ra 36 nhóm / 77 file, và không có gì làm nó sai ra tiếng.

## Quy tắc migration

**Đường apply chính thức là forward-only lane**, không phải `apply-sql.mjs` trần:

```bash
npm run migrate:forward -- supabase/migrations/<file>.sql   # dry-run, mặc định KHÔNG ghi
npm run migrate:forward -- supabase/migrations/<file>.sql --apply
```

Lane này có bốn thứ mà gọi thẳng Management API không có, và cả bốn đều đã được thêm vì một sự cố
thật (xem `docs/incidents/`):

1. **Backup bắt buộc trước mọi thao tác schema** — PITR đang tắt (rủi ro đã chấp nhận, ghi ở
   `known-gaps.yaml#pitr-disabled-accepted-risk`), nên bản dump là điểm khôi phục *duy nhất*. Lane tự
   chạy backup và tự cấp "biên nhận" từ bản dump vừa xác minh; `--khong-backup` thì bắt buộc phải có
   `IHOMECRM_PROMOTION_TOKEN` nhập lúc chạy.
2. **Gỡ cặp `BEGIN;/COMMIT;` của chính file trước khi bọc lại.** Postgres không có transaction lồng:
   `COMMIT` bên trong đóng luôn transaction NGOÀI, biến `ROLLBACK` cuối thành no-op — tức **dry-run
   ghi thật**. Đã xảy ra 07/08/2026.
3. **Ghi evidence** vào `docs/generated/schema-change-evidence/`: bytes câu lệnh, digest, actor,
   commit mã nguồn, và catalog trước/sau.
4. **Advisory lock có timeout + statement timeout**, để một lần apply treo không khoá cả database.

Các luật còn lại:

- Thêm migration mới, **không sửa lịch sử đã deploy** trừ khi có quy trình recovery được duyệt.
- Dùng timestamp duy nhất 14 chữ số cho file sau cutoff (`migration-policy.json → provisionalCutoff`);
  migration phải idempotent ở chỗ cần thiết và ghi rõ rollback/forward-fix cho thay đổi rủi ro.
- `migrations-archive` chỉ để tra cứu. Không replay file superseded.
- Sau deploy schema: regenerate types, review diff, chạy test caller/RLS/RPC liên quan.

```bash
npm run migrations:list-forward     # migration sau cutoff + trạng thái apply
npm run gate:migration-provenance   # sau cutoff phải có entry bằng chứng
```

## Kiểm tra thường dùng

```powershell
Get-ChildItem supabase/migrations -Filter *.sql | Measure-Object
rg "object_or_rpc_name" supabase/migrations src
npm run gen:types
```

`gen:types` cần Supabase CLI/quyền project và network. Không đưa token, service-role hoặc database URL vào tài liệu/log.

## Edge Functions

Mỗi function nằm trong `supabase/functions/<name>/`. Deploy và secret thuộc môi trường Supabase; kiểm auth ở cả gateway lẫn function. Danh sách, vai trò và runbook hiện hành xem [functions/README.md](functions/README.md).
