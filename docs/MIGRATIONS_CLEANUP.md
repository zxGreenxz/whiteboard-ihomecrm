# Migrations cleanup log

> Audit + cleanup folder `supabase/migrations/` và `supabase/migrations-bundle/`
> ngày 2026-05-28.

## Bối cảnh

Tổng số file `.sql` trước cleanup: **157 trong `migrations/`** + **14 trong `migrations-bundle/`**.

Vấn đề phát hiện:
1. **14 nhóm prefix trùng** (cùng timestamp prefix nhưng nội dung khác nhau) — gây ambiguous apply order.
2. **2 nhóm legacy** `016_*` và `017_*` cũng trùng — không thể rename vì nhiều file phụ thuộc thứ tự nội bộ.
3. **Supabase migration tracker** chỉ ghi nhận 16 file (qua CLI `supabase db push`). 141 file còn lại được apply qua Studio SQL Editor hoặc Management API — không có tracking → an toàn để rename.

## Thay đổi đã thực hiện

### 1. Rename 13 file để tránh trùng timestamp prefix

Chiến lược: giữ file đầu tiên (sort alphabet) nguyên gốc, file sau shift về second-slot +50/+60 trong cùng ngày để bảo toàn apply order.

| File cũ | File mới | Lý do |
|---|---|---|
| `20260510000003_service_buildings_admin_policies.sql` | `20260510000053_service_buildings_admin_policies.sql` | Conflict với `20260510000003_invoice_default_approved.sql` |
| `20260510000004_unify_service_building_links.sql` | `20260510000054_unify_service_building_links.sql` | Conflict với `20260510000004_income_expense_batches.sql` |
| `20260510000005_payment_method_three_values.sql` | `20260510000055_payment_method_three_values.sql` | Conflict với `20260510000005_drop_service_buildings.sql` |
| `20260510000006_staff_write_rls.sql` | `20260510000056_staff_write_rls.sql` | Conflict với `20260510000006_refund_cashbooks_and_type.sql` |
| `20260514000001_drop_accounts_type.sql` | `20260514000051_drop_accounts_type.sql` | Conflict với `20260514000001_customer_images_storage_rls.sql` |
| `20260516000003_jobs_simplify_status.sql` | `20260516000053_jobs_simplify_status.sql` | Conflict với `20260516000003_jobs_assignee_name.sql` |
| `20260518000001_staff_building_scope_writes.sql` | `20260518000051_staff_building_scope_writes.sql` | Conflict với `20260518000001_cleanup_bulk_refund_expense_vouchers.sql` |
| `20260518000002_open_buildings_view_for_staff.sql` | `20260518000052_open_buildings_view_for_staff.sql` | Conflict với `20260518000002_invoice_discount_notes.sql` |
| `20260527000001_invoice_previous_debt.sql` | `20260527000051_invoice_previous_debt.sql` | Conflict với `20260527000001_fix_generate_job_code_rls.sql` |
| `20260527000001_rounding_under_10k.sql` | `20260527000061_rounding_under_10k.sql` | Conflict với `20260527000001_fix_generate_job_code_rls.sql` (file thứ 3 trong group) |
| `20260527000003_rbac_helpers.sql` | `20260527000053_rbac_helpers.sql` | Conflict với `20260527000003_backfill_rounding_audit.sql` |
| `20260527000004_rbac_phase2_policies_invoices_payments_ie.sql` | `20260527000054_rbac_phase2_policies_invoices_payments_ie.sql` | Conflict với `20260527000004_accounts_balance_include_rounding.sql` |
| `20260527000005_rbac_phase2_rpc_v2.sql` | `20260527000055_rbac_phase2_rpc_v2.sql` | Conflict với `20260527000005_income_expense_quick_edit.sql` |

**Tổng: 13 rename**. Không xóa file nào, không sửa nội dung SQL.

### 2. KHÔNG đụng nhóm legacy `016_*` và `017_*`

| Prefix | Files (giữ nguyên) | Lý do |
|---|---|---|
| `016` | `016_customers_table.sql`, `016_document_templates.sql`, `016_job_workflow_tables.sql`, `016_meter_readings_enhancements.sql` | Rename sẽ phá thứ tự apply (vd `016_job_workflow_tables` tạo bảng, `017_job_workflow_seed` seed vào bảng đó — nếu shift một bên thì broken). |
| `017` | `017_job_workflow_seed.sql`, `017_meters_table.sql` | Tương tự — phụ thuộc thứ tự. |

Khi run `supabase db reset` từ scratch, các file cùng prefix sẽ apply theo alphabet sort (xác định, nhưng cần cẩn thận khi thêm migration mới ở prefix `016`/`017`).

### 3. KHÔNG đụng folder `migrations-bundle/`

14 file `.sql` trong `migrations-bundle/` là **batch apply scripts** dùng để chạy nhiều migration cùng lúc qua Supabase Studio SQL Editor (idempotent). Đây là tài liệu lịch sử về cách prod được setup, giữ nguyên.

### 4. KHÔNG xóa file nào

Tất cả 157 file `.sql` trong `migrations/` đều có SQL hợp lệ (kể cả `20250101000005_meters_table_already_exists.sql` thêm cột `current_reading`). Không có "no-op file" thực sự.

## Quy ước cho migration mới

1. **Timestamp đầy đủ 14 chữ số**: `YYYYMMDDhhmmss_<mô_tả>.sql`
2. **Đảm bảo unique** bằng cách dùng `date +%Y%m%d%H%M%S` trên Linux/Mac hoặc `Get-Date -Format yyyyMMddHHmmss` trên PowerShell.
3. **Tên mô tả ngắn** (≤50 ký tự), snake_case, tiếng Anh hoặc Việt không dấu.
4. **Phân loại bằng prefix mô tả** nếu liên quan refactor RBAC:
   - `rbac_helpers_*`
   - `rbac_phase{N}_*`
   - `rbac_batch_{letter}_*`
5. **Apply qua Management API** trong session interactive (không qua CLI) → KHÔNG cần update `supabase_migrations.schema_migrations` tracker tay.

## Verification sau cleanup

```bash
$ ls supabase/migrations/*.sql | wc -l
157   # vẫn 157 file (không xóa, chỉ rename 13)

$ ls supabase/migrations/*.sql | awk -F'_' '{print $1}' | sort | uniq -d
016
017
# Chỉ còn 2 legacy nhóm trùng — đã giữ lại có chủ đích.

$ node .scratch/verify_baseline.cjs
OK — all 29 tables match baseline.
# DB state không thay đổi.
```

## Tham chiếu

- **[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)** — schema chi tiết hiện tại (sinh tự động từ DB)
- **[RBAC_REFACTOR.md](RBAC_REFACTOR.md)** — lịch sử refactor multi-tenant → RBAC
- Log JSON: `.scratch/audit/migration_renames.json`
