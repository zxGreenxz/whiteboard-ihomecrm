# Migration: cách làm và nguồn kiểm chứng

Luật quyền ghi, backup và bất biến migration nằm ở [Project Contract](PROJECT_CONTRACT.md) §4–6.
Trang này chỉ mô tả công cụ thực thi.

## Migration mới

```bash
node scripts/tao-ten-migration.mjs <slug>
git add supabase/migrations/<file>.sql
npm run provenance:generate
npm run gate:migration-provenance
npm run migrate:forward -- supabase/migrations/<file>.sql
```

Lệnh cuối chạy SQL trong transaction ROLLBACK trên database đích; dry-run vẫn cần đúng project
và có thể lấy khoá, nên kiểm trên database dùng một lần trước.

Khi đủ điều kiện phát hành, thêm `--apply`. Lane kiểm idempotency hai lượt trong ROLLBACK,
tạo/kiểm backup, cấp biên nhận rồi apply và ghi evidence.
Đường bỏ backup, token và điều kiện dừng theo Contract §4;
không chạy thêm backup thủ công lặp lại trước lane mặc định.

Sau apply, làm tươi provenance, catalog, surfaces liên quan và canonical types.
Kiểm evidence/digest, gọi lại đường RPC thật; không suy ra thành công từ việc file đã có trong Git.

## Trạng thái và giới hạn bằng chứng

- [migration-policy.json](../../supabase/migration-policy.json) sở hữu cutoff và quy tắc forward-only.
- [migration-provenance.json](../../supabase/migration-provenance.json) sở hữu trạng thái và hash từng file.
  `ledger-applied` khớp ledger; `catalog-proven` chỉ chứng minh object tồn tại;
  `superseded` là file archive; `unknown` chưa có đủ bằng chứng.
- `npm run migrations:list-forward` liệt kê lane và lệch giữa file/sổ.
- `docs/generated/schema-change-evidence/` ghi kết quả apply.
- Không nâng `unknown` thành “đã chạy” bằng suy đoán; không sửa ledger hay migration cũ.

## Dựng lại database

Legacy history không replay được. Dùng [baseline/README](../../supabase/baseline/README.md)
và [manifest](../../supabase/baseline/manifest.json): role trước, schema theo thứ tự restore đã khai,
rồi forward lane. Baseline chỉ có schema, không thay thế dump dữ liệu.

Workflow [migration-restore-drill.yml](../../.github/workflows/migration-restore-drill.yml)
kiểm trên database dùng một lần. Đối chiếu policy/role/quyền, không chỉ số bảng.
`manifest.counts` là số đã chụp; `restoreDrill` là kết quả đã restore — hai loại bằng chứng khác nhau.
Khôi phục PostgreSQL có shim không chứng minh đã khôi phục đủ một Supabase project thật.

CI validate lịch sử và replay môi trường thử; không tự apply production.
Các giới hạn còn mở nằm trong [known-gaps.yaml](../../tooling/known-gaps.yaml), không chép lại tại đây.
