# Migration, backup và generated types

Chỉ đọc trước khi sửa SQL/RPC/quyền/tiền hoặc thao tác schema. [Contract](PROJECT_CONTRACT.md) sở hữu quyền thao tác và phát hành; runbook này sở hữu kiểm chứng database.

## Chọn đích và quyền ghi

- Kiểm project/org/environment, worktree sạch trong phạm vi đang thao tác, SHA đã review, provenance/digest và catalog trước/sau. Sai/thiếu thì dừng apply.
- Chỉ `npm run migrate:forward -- <file.sql>` (dry-run mặc định), thêm `--apply` khi đủ điều kiện. Không dùng PAT ghi thẳng Management API để bỏ lane.
- Dry-run lấy khoá và chạy transaction ROLLBACK trên đích; thử trước trên database dùng một lần. Không suy rằng dry-run không cần kiểm đích.
- Lane mặc định kiểm idempotency hai lượt, tạo/kiểm backup rồi mới cấp biên nhận apply; không lặp thêm backup thủ công trước lane.
- `--khong-backup "<lý do>"` cần `IHOMECRM_PROMOTION_TOKEN` nhập lúc chạy, không lấy từ vault. Thiếu backup/biên nhận hoặc token đúng chế độ thì dừng.
- Schema/backfill ngoài lane: `node scripts/backup-before-schema.mjs --reason "<thao tác>"` trước khi ghi. Dump/manifest ở `%USERPROFILE%/ihomecrm-backups/`, ngoài Git.
- Dump phải restore được với role/policy Supabase, không chỉ đủ số bảng. Rủi ro PITR lấy từ [known-gaps](../../tooling/known-gaps.yaml), không suy từ snapshot cũ.

## Migration mới

```bash
node scripts/tao-ten-migration.mjs <slug>
git add supabase/migrations/<file>.sql
npm run provenance:generate
npm run gate:migration-provenance
npm run migrate:forward -- supabase/migrations/<file>.sql
```

Timestamp do script cấp; migration mới idempotent và immutable sau merge/deploy. Stage migration trước provenance vì generator đọc index.
[migration-policy.json](../../supabase/migration-policy.json) sở hữu cutoff; [provenance](../../supabase/migration-provenance.json) sở hữu trạng thái/hash.
`ledger-applied` khớp ledger; `catalog-proven` chỉ chứng minh object tồn tại; `superseded` là archive; `unknown` chưa đủ bằng chứng. Không sửa ledger/lịch sử để tạo vẻ sạch.
Sau apply, làm tươi provenance, catalog/surfaces liên quan và types; gọi lại đường RPC thật, kiểm evidence trong `docs/generated/schema-change-evidence/`.

## Kiểm chứng theo thay đổi

| Thay đổi | Kiểm cần giữ |
|---|---|
| VIEW | `node scripts/check-view-invoker.mjs`; giữ `security_invoker=true` khi CREATE OR REPLACE |
| FUNCTION/RPC | `node scripts/check-stable-fn-locks.mjs`, ACL/owner/search_path và gọi qua PostgREST |
| RLS/POLICY | Role + JWT thật, ca được phép và cross-tenant bị từ chối; scope theo [data runbook](DATA_ENVIRONMENTS.md) |
| Tiền | Cả `npm run gate:reconcile-money` và `npm run gate:reconcile-money-v2`; idempotency/concurrency |
| Schema | Catalog/surfaces, provenance và generated types của đúng đích |
| Edge deploy | Project ref/org, cây sạch, SHA đã review và digest bundle trước deploy |

Hàm lấy khoá dòng phải `VOLATILE`: STABLE/IMMUTABLE có thể lỗi `25006` qua PostgREST dù SQL trực tiếp đạt.
Reconcile v1 kiểm đường đọc JWT/RLS; v2 kiểm số dư posting. Giữ cả hai, bắt cap-1000; không tổng hợp chỉ trang đầu.
Đột biến invariant tiền/quyền/org/migration theo [hướng dẫn kiểm](../CODEBASE_STRUCTURE.md#kiểm-thử); không gọi thiếu runner là pass.

## Generated types

```bash
npm run gen:types
npm run types:normalize
npm run types:check
```

Generator ghi atomic vào `src/integrations/supabase/types.ts` và thêm header; không redirect đầu ra hoặc sửa file sinh bằng tay.
Normalizer bỏ partition runtime theo [generated-types-policy](../../supabase/generated-types-policy.json).
Chỉ chạy khi schema/surface scope cần; thiếu credential/mạng phải ghi chưa xác minh, không coi warning là schema đã khớp.

## Dựng lại database

Legacy history **KHÔNG replay được**: có trùng version và file hand-apply. Không dùng `supabase db push` để phát hành, không replay `migrations-archive/` hoặc sửa/đổi tên file đã deploy.
Dùng [baseline](../../supabase/baseline/README.md) và [manifest](../../supabase/baseline/manifest.json): role trước, schema theo thứ tự restore rồi forward lane; baseline schema không thay dump dữ liệu.
[Restore drill](../../.github/workflows/migration-restore-drill.yml) dùng database dùng một lần. Kiểm role/policy/quyền; PostgreSQL có shim chưa chứng minh restore đủ Supabase.
CI validate/replay môi trường thử, không tự apply hoặc commit migration production. `npm run migrations:list-forward` đối chiếu file/sổ; chỉ kết quả apply mới chứng minh đã thực thi.
