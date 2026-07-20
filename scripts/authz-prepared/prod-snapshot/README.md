# prod-snapshot — Snapshot định nghĩa PROD phục vụ khôi phục thảm hoạ (DR)

> **Snapshot chụp tại thời điểm 2026-07-19** (dự án `tryymsxyyckgbrmmvozx`, PostgreSQL 17.6),
> ngay sau khi authorization go-live 15/15 feature flag canonical ON + áp t5_26.
> **Sinh lại khi prod đổi schema** (thêm/sửa hàm, bảng, policy, grant). Các file dưới đây
> được **sinh tự động từ catalog PROD** (`pg_get_functiondef` / `pg_get_constraintdef` /
> `pg_get_indexdef` / `pg_attribute` / `pg_class.relacl` / `pg_proc.proacl` / `pg_policies`) —
> **KHÔNG SỬA TAY**. Muốn đổi hành vi: sửa trên DB bằng migration rồi sinh lại file.

Đây **KHÔNG** phải nguồn chính (source of truth) trên `main`: nhiều hàm/bảng ở đây không có
file migration nào tạo ra chúng, nên nếu mất DB mà không có snapshot này thì lớp
authorization + writer tiền sẽ **mất trắng**. Giữ file cho kịch bản dựng lại từ DB trắng.

## Danh sách file

| File | Nhóm | Bảng | Constraint | Index | Hàm | Trigger | RLS | Policy |
|------|------|:----:|:----:|:----:|:----:|:----:|:----:|:----:|
| `PS01_engine_approval_v2.sql` | Engine duyệt v2 (`public.approval_*` + engine `app_private`) | 10 | 57 | 3 | 22 | 4 | 8 | 8 |
| `PS02_payment_invoice_writers.sql` | Payment v4 + invoice writers (+ role `ie_canonical_writer`) | 2 | 9 | 1 | 17 | 3 | 0 | 0 |
| `PS03_storage_shield.sql` | Lá chắn storage (org-isolation bucket PII) | 1 | 1 | 1 | 6 | 1 | 0 | 36 |
| `PS04_rbac_org_meter_threshold.sql` | RBAC chuẩn hoá + org integrity + meter + ngưỡng tự duyệt + freeze/ownership IE | 14 | 57 | 16 | 27 | 46 | 10 | 10 |
| `PS05_misc_remaining.sql` | Phần CÒN THIẾU: rollout/feature-flag, audit-chain, self-approve/emergency/possession, RPC engine t5_26 + authz core, money writer `_vN`, reporting `_vN` | 8 | 28 | 2 | 62 | 13 | 0 | 0 |

`PS05` do lượt **completeness-critic** đối chiếu lại toàn bộ catalog PROD (mọi hàm `app_private`,
mọi bảng `app_private`, mọi hàm `public *_v[1-4]` liên quan tiền/quyền, mọi policy
`storage.objects`) với 4 file PS01–PS04 và bổ sung những gì thiếu. Sau khi có PS05, độ phủ:

- Hàm `app_private`: **57/57**
- Bảng `app_private`: **16/16**
- Hàm `public *_v[1-4]`: **63/63**
- Policy `storage.objects`: **36/36**

Bao gồm các **lỗ hổng DR** từng bị bỏ sót: `list_my_pending_approvals_v1`,
`decide_financial_request_v2`, `withdraw_financial_request_v1`, `submit_financial_voucher`,
`_eval_approval_rule`, `nrm_vn` (đều nằm ở `PS05`).

## Thứ tự chạy lại từ DB trắng

Mỗi file idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP … IF EXISTS` /
DO-block cho constraint & role), chạy với `-v ON_ERROR_STOP=1`.

0. **Base/business schema (KHÔNG thuộc bộ này)** — phải có TRƯỚC: `public.organizations`,
   `organization_memberships`, `staff_assignments`, `buildings`, `areas`, `rooms`, `accounts`,
   `contracts`, `customers`, `invoices`, `income_expenses`, `income_expense_items`, `payments`,
   `meters`, `meter_readings`, `cashbooks`, `income_expense_audit_log`, `invoice_audit_log`,
   các enum (`invoice_status`, `payment_method`) … cùng role Supabase `anon` / `authenticated` /
   `service_role`.
1. `PS04_rbac_org_meter_threshold.sql` — dựng RBAC + tạo role `ie_canonical_writer` +
   bảng nền `app_private` (ownership/threshold) + `is_super_admin` / `authorize_tenant_action_v3`.
2. `PS01_engine_approval_v2.sql` — engine duyệt + bảng `public.approval_*`.
3. `PS02_payment_invoice_writers.sql` — payment/invoice writers.
4. `PS03_storage_shield.sql` — lá chắn storage.
5. `PS05_misc_remaining.sql` — **chạy SAU CÙNG**: rollout/feature-flag, audit-chain,
   self-approve/emergency, RPC engine t5_26 + authz core, money writer + reporting `_vN`.

```bash
for f in PS04 PS01 PS02 PS03 PS05; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"*.sql
done
```

## Ghi chú kỹ thuật / hạn chế đã biết

- **`PS05` đặt `SET check_function_bodies = off`** (giống `pg_dump`): cho phép tạo các hàm
  SQL-language (`list_my_pending_approvals_v1`, `effective_perms_v2`, `_eval_approval_rule`,
  `get_*_breakdown_v2`, `occupancy_*_v2`) mà không phụ thuộc thứ tự resolve. `PS01–PS04`
  dựa vào thứ tự chạy nêu trên.
- **Trigger cross-table**: một số trigger trong `PS01` (a75 trên `income_expenses`) và `PS05`
  (audit-log / `organization_memberships` / `staff_assignments` / `income_expenses`) gắn lên
  bảng nghiệp vụ **ngoài** file — được bọc `to_regclass(...) IS NOT NULL`, bảng chưa tồn tại
  thì **bỏ qua kèm `RAISE NOTICE`**, không làm vỡ restore.
- **Trùng lặp vô hại giữa các file**: vài hàm dùng chung (`authorize_tenant_action_v3`,
  `is_income_expense_flow_owned`, `lock_org_for_decision_v1`, `raise_malformed_override`)
  xuất hiện ở nhiều file do dò đệ quy — đều `CREATE OR REPLACE` lấy cùng nguồn PROD nên chạy
  lại không lệch. Khi re-dump nên chốt file chủ sở hữu để tránh lệch phiên bản.
- **Không dump dữ liệu**: chỉ định nghĩa. Dữ liệu rule-set, feature-flag, ownership,
  audit-chain, `storage_object_links` (2.447 dòng) … **không** nằm trong snapshot.
- **`app_private.ie_cancel_close_request_v1`** (`PS01`) giữ nguyên `proacl IS NULL`
  (PUBLIC EXECUTE) đúng như prod — nếu muốn siết thì làm bằng migration mới rồi sinh lại.
- **`public._autofill_org()`** (`PS04`) hard-code hằng org pilot `aaaa0000-…-0001` — đây là
  một phần **nguyên văn** của định nghĩa hàm trên prod (không phải secret), giữ để byte-faithful.
- **Bảo mật**: đã quét toàn bộ 5 file — **không** chứa token/PAT/password/connection-string.

## Sinh lại snapshot

Khi prod đổi schema, sinh lại các file (bộ sinh hiện đặt ở scratchpad của phiên tạo, chưa đưa
vào repo). Việc nên làm tiếp: thêm `scripts/regen-prod-snapshot.mjs` để tái sinh toàn bộ `PS0*`
bằng một lệnh, đảm bảo header ghi lại đúng ngày chụp mới.
