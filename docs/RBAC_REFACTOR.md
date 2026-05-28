# Refactor multi-tenant → pure RBAC

Tài liệu chi tiết về đợt refactor mô hình phân quyền từ "multi-tenant qua
`user_id` mỗi row" sang "single-org RBAC qua roles + building scope".

- **Plan gốc**: `~/.claude/plans/breezy-finding-gem.md`
- **Phạm vi**: 7 phase, ~10 commit, 8 migration SQL, ~5 ngày làm việc tính toán
- **Bug ban đầu**: dashboard tài chính NATHAN báo thiếu **7.899.000 đ TM**
  do 9 invoice "lệch owner" (staff Hiệp/Joey tạo nhưng được gán `user_id =
  staff_id`, RPC `get_invoice_statistics` lọc cứng `user_id = v_owner` nên
  loại chúng ra).

---

## 1. Tóm tắt thay đổi

| Hạng mục | Trước | Sau |
|---|---|---|
| Mô hình phân quyền | Multi-tenant: mỗi row `user_id = owner_id` (RLS chặn theo owner) | Single-org RBAC: access qua `staff_assignments` + `roles.permissions` |
| Cột `user_id` | Tham gia access control (RLS dùng `auth.uid()=user_id`) | Audit-only (set tự động bởi trigger), không tham gia access |
| Helper functions | `is_admin`, `is_super_admin`, `staff_can`, `staff_in_building`, `current_visible_owner_ids` | Thêm `can_access_building`, `can_do_on_building`, `can_access_org_entity`, `building_of_contract/_invoice/_payment` |
| RLS policies | `*_select_own`, `*_staff_select`, `*_admin_all`, `*_super_admin_all` | Bổ sung `*_rbac` (additive, song song chính sách cũ) |
| RPC thống kê | `get_invoice_statistics(p_user_id, …)` lọc theo owner | Thêm `get_invoice_statistics_v2(…)` lọc theo `can_access_building` |
| Trang `/register` | Form đăng ký công khai | Gate page "Đăng ký đã đóng" |

### Đường dẫn dữ liệu thực tế sau refactor

```
user (auth.uid())
    ↓ staff_assignments [staff_id, role_id, building_id]
    ↓ roles.permissions {resource: {action: bool}}
    ↓ can_access_building(building_id) / can_do_on_building(table, action, building_id)
    ↓ buildings ← rooms ← contracts ← invoices ← payments / income_expenses
```

User được "kết nối" với building qua bảng `staff_assignments`. Có 4 lớp
được gộp lại trong helper:
1. `is_super_admin()` — bảng `super_admins`
2. `is_admin()` — role với `permissions.__superadmin: true` hoặc `name='Admin'`
3. Staff full-scope — có `staff_assignments` với `building_id IS NULL`
4. Staff per-building — có `staff_assignments` với `building_id = X` cụ thể

---

## 2. Phase chi tiết

### Phase 0 — Safety net (read-only)

Mục tiêu: baseline để verify từng bước sau.

- `.scratch/baseline_phase0.json` — count + sum của 29 bảng dữ liệu
- `.scratch/baseline_per_area.json` — TM/TK/TT theo area
- `.backups/pre_rbac_<timestamp>/` — 29 file JSON dump full data + `HASHES.txt` SHA256
- `.scratch/verify_baseline.cjs` — script chạy sau mỗi phase để đối chiếu

Tổng dung lượng backup: 3.4 MB. Hash đã ghi nhận.

### Phase 1 — Helper functions (additive, không attach vào policy nào)

File: [supabase/migrations/20260527000003_rbac_helpers.sql](../supabase/migrations/20260527000003_rbac_helpers.sql)

Tạo 5 helper:

| Function | Mục đích |
|---|---|
| `can_access_building(building_id)` | True nếu caller xem được building này (super_admin / admin / staff_assignments phù hợp). Dùng trong RLS `SELECT`. |
| `can_do_on_building(table, action, building_id)` | True nếu caller có quyền `action` trên `table` cho building (kiểm tra `roles.permissions[table][action]`). Dùng trong `INSERT`/`UPDATE`/`DELETE`. |
| `building_of_contract(id)` | FK traversal: contract → room → building |
| `building_of_invoice(id)` | Lấy `invoices.building_id` trực tiếp |
| `building_of_payment(id)` | FK traversal: payment → invoice → building |

Hành vi DB không đổi vì chưa có policy nào gọi vào (additive).

### Phase 2 — invoices / payments / income_expenses

Files:
- [20260527000004_rbac_phase2_policies_invoices_payments_ie.sql](../supabase/migrations/20260527000004_rbac_phase2_policies_invoices_payments_ie.sql) — 24 policy
- [20260527000005_rbac_phase2_rpc_v2.sql](../supabase/migrations/20260527000005_rbac_phase2_rpc_v2.sql) — RPC v2
- [20260527000006_rbac_phase2_trigger_auto_user_id.sql](../supabase/migrations/20260527000006_rbac_phase2_trigger_auto_user_id.sql) — 4 trigger

Bảng: `invoices`, `invoice_items`, `payments`, `income_expenses`,
`income_expense_items`, `excess_amounts`.

Đây là phase quan trọng nhất — bug "lệch owner" được fix ở đây.

**Frontend update**: [src/hooks/useInvoices.ts:768-808](../src/hooks/useInvoices.ts#L768-L808) switch từ `get_invoice_statistics` sang `get_invoice_statistics_v2` (không truyền `p_user_id`).

**Verify**: TM card NATHAN trên dashboard chuyển từ 375.728K → **383.627K** (đúng số mong đợi: bao gồm 7.899K của 2 hoá đơn cross-owner G04/MB).

### Phase 3 — contracts

File: [20260527000007_rbac_phase3_contracts.sql](../supabase/migrations/20260527000007_rbac_phase3_contracts.sql)

32 policy + 5 trigger cho:

| Bảng | Cách traverse |
|---|---|
| `contracts` | room_id → rooms.building_id (inline subquery) |
| `contract_customers` | contract_id → `building_of_contract` |
| `contract_tenants` | contract_id → `building_of_contract` |
| `contract_services` | contract_id → `building_of_contract` |
| `contract_extensions` | contract_id → `building_of_contract` |
| `contract_terminations` | contract_id → `building_of_contract` |
| `contract_transfers` | contract_id → `building_of_contract` |
| `deposits` | contract_id (chính) hoặc room_id (fallback nếu contract_id NULL) |

**Verify**: trang `/contracts` hiển thị 268 contracts (= baseline đầy đủ, trước phase 3 chỉ 258).

### Phase 4 — buildings / rooms / areas / floors / beds

File: [20260527000008_rbac_phase4_buildings_rooms.sql](../supabase/migrations/20260527000008_rbac_phase4_buildings_rooms.sql)

24 policy + 3 trigger.

| Bảng | Quy tắc |
|---|---|
| `areas` | Visible nếu super_admin/admin HOẶC EXISTS staff_assignments với building thuộc area (hoặc full-scope) |
| `buildings` | `can_access_building(id)` |
| `floors` / `rooms` / `building_services` | `can_access_building(building_id)` |
| `beds` | Inline subquery `(SELECT building_id FROM rooms WHERE id = beds.room_id)` |

INSERT cho `areas`/`buildings` yêu cầu **staff full-scope** + permission cụ thể (không cho staff per-building tạo toà mới).

**Verify**: trang `/buildings` hiển thị 16 toà nhà; areas dropdown chỉ NATHAN/JOEY.

### Phase 5 — misc tables

File: [20260527000009_rbac_phase5_misc.sql](../supabase/migrations/20260527000009_rbac_phase5_misc.sql)

Thêm helper `can_access_org_entity(resource, action)` cho entity "global"
(không gắn building/contract). 88 policy + 23 trigger.

Phân nhóm:

| Nhóm | Bảng | Cách áp dụng |
|---|---|---|
| A. `building_id NOT NULL` | `meters` | `can_access_building(building_id)` |
| B. `building_id` nullable | `meter_readings`, `assets`, `asset_warehouses`, `auto_debt_config`, `issues`, `jobs`, `leads`, `vehicles` | NOT NULL → `can_access_building`; NULL → `can_access_org_entity` |
| C. `contract_id NOT NULL` | `asset_handovers` | Traverse contract → building |
| D. notification cá nhân | `notifications` | **Không override** — policy cũ đủ (recipient-based) |
| E. Global org entities | `customers`, `tenants`, `services`, `hotlines`, `document_templates`, `signature_templates`, `asset_categories`, `asset_maintenance`, `asset_movements`, `job_groups`, `job_types`, `lead_activities`, `issue_comments` | `can_access_org_entity(resource, action)` |

**Verify**: trang `/customers` 420 customers, `/meter-readings` load OK, 0 console error.

### Phase 6 (soft) — Annotate cột `user_id` audit-only

File: [20260527000010_rbac_phase6_annotate_user_id.sql](../supabase/migrations/20260527000010_rbac_phase6_annotate_user_id.sql)

**Không rename** cột `user_id` → `created_by` vì frontend tham chiếu ~80
chỗ. Thay vào đó: thêm `COMMENT` cho 36 cột `user_id` ghi rõ:

> "Audit-only: auth.uid() của user đã tạo row (set by trigger). RBAC dùng
> can_access_building(building_id), không dùng cột này."

Rename hẳn sẽ làm ở phase sau sau khi monitoring 2+ tuần production stable.

### Phase 7 — Đóng public sign-up

File: [src/pages/auth/Register.tsx](../src/pages/auth/Register.tsx)

Trang `/register` thay đổi từ form đăng ký thành gate page hiển thị thông
báo "Đăng ký đã đóng. Liên hệ admin để được tạo tài khoản." kèm link quay
lại `/login`.

User mới chỉ tạo được qua Supabase Dashboard (super_admin tay) cho đến khi
có trang `/admin/users` riêng (xem mục Đề xuất còn lại).

---

## 3. Audit cấu trúc sau refactor

### 3.1 Helper functions

```
public.can_access_building(_building_id uuid)               -- RLS SELECT
public.can_do_on_building(_table, _action, _building_id)    -- RLS write
public.can_access_org_entity(_resource, _action)            -- entity global
public.building_of_contract(_id uuid)
public.building_of_invoice(_id uuid)
public.building_of_payment(_id uuid)
public.set_user_id_from_auth()                              -- trigger function
public.is_admin()         (đã có, dùng tiếp)
public.is_super_admin()   (đã có, dùng tiếp)
public.staff_can(_table, _action, _owner)         (legacy, vẫn còn)
public.staff_in_building(_owner, _building_id)    (legacy, vẫn còn)
public.get_invoice_statistics(p_user_id, …)       (legacy v1, vẫn còn để rollback)
public.get_invoice_statistics_v2(…)               (mới, frontend đang dùng)
```

### 3.2 RLS policies — 172 chính sách `*_rbac` qua 43 bảng

| Số bảng | Policy/bảng | Tổng |
|---|---|---|
| 43 | 4 (SELECT/INSERT/UPDATE/DELETE) | 172 |

Phân bố theo phase:

- Phase 2 (6 bảng): invoices, invoice_items, payments, income_expenses, income_expense_items, excess_amounts
- Phase 3 (8 bảng): contracts, contract_customers, contract_tenants, contract_services, contract_extensions, contract_terminations, contract_transfers, deposits
- Phase 4 (6 bảng): areas, buildings, floors, rooms, beds, building_services
- Phase 5 (23 bảng): meters, meter_readings, assets, asset_warehouses, asset_handovers, asset_categories, asset_maintenance, asset_movements, auto_debt_config, customers, tenants, services, hotlines, document_templates, signature_templates, issues, issue_comments, jobs, job_groups, job_types, leads, lead_activities, vehicles

### 3.3 Trigger `set_user_id_audit` — 35 bảng

Mọi bảng có cột `user_id NOT NULL` thuộc 4 phase trên đều có trigger.

### 3.4 Bảng có `user_id` nhưng CHƯA refactor (đề xuất ở mục 5)

Auth/permission tables (không cần refactor):
`account_shared_users`, `accounts`, `accounts_with_balance` (view),
`profiles`, `roles`, `super_admins`, `staff_assignments`, `user_roles`,
`user_subscriptions`, `departments`, `code_sequences`, `meters_with_latest_reading` (view), `meter_readings_detailed` (view)

Personal/audit (intentional):
`ai_conversations`, `ai_memory_embeddings`, `ai_usage_stats`,
`notifications`, `settings`

Config/Template/Category (nên refactor sau):
`ct01_declarations`, `expenses`, `income_expense_batches`,
`income_expense_templates`, `income_expense_types`,
`invoice_generation_settings`, `issue_categories`, `issue_phase_history`,
`issue_status_history`, `notification_templates`, `scheduled_jobs`,
`service_quotas`, `sla_configs`, `suppliers`, `task_flows`, `task_types`

### 3.5 Verify cuối cùng (đo qua FK pure)

```sql
SELECT b.area_id, SUM(p.amount) FILTER (WHERE p.payment_method='TM')
FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN buildings b ON b.id=i.building_id
WHERE i.deleted_at IS NULL GROUP BY b.area_id;
```

Kết quả:
- NATHAN: **383.626.800 đ** (khớp UI dashboard 383.627K)
- JOEY: **149.252.500 đ** (khớp UI 149.252K)

---

## 4. Đảm bảo toàn vẹn dữ liệu

### 4.1 Counts + sums không đổi (29 bảng × 7 lần verify)

Script `.scratch/verify_baseline.cjs` chạy sau mỗi phase, so sánh với
`baseline_phase0.json`. **OK** mọi lần.

### 4.2 Không có thao tác phá huỷ

| Thao tác | Số lần |
|---|---|
| `CREATE FUNCTION` | 7 |
| `CREATE POLICY` | 172 |
| `CREATE TRIGGER` | 35 |
| `CREATE OR REPLACE FUNCTION` (RPC v2) | 1 |
| `COMMENT ON COLUMN` | 36 |
| `UPDATE` data | **0** |
| `DELETE` data | **0** |
| `DROP COLUMN` | **0** |
| `DROP POLICY` (cũ) | **0** (giữ song song) |
| `ALTER TABLE` (rename/structure) | **0** |

### 4.3 Backup có sẵn

`.backups/pre_rbac_20260527_235207/` chứa 29 file JSON với SHA256.
Có thể restore bất kỳ bảng nào về trạng thái trước refactor nếu cần.

---

## 5. Đề xuất còn lại (không khẩn cấp)

### 5.1 Rename `user_id` → `created_by` (HOÃN — đã xem xét)

**Quyết định**: KHÔNG thực hiện trong batch refactor này. Lý do:
- Phase 6 soft (COMMENT annotation 36 cột) đã đủ document audit-only semantics
- Hard rename cần update ~80 chỗ frontend, rủi ro cao mà giá trị thấp (chỉ cosmetic)
- Generated column alias (`created_by GENERATED ALWAYS AS (user_id)`) tăng storage 2x mà không giảm code complexity
- Có thể làm sau khi có refactor lớn khác

**Khi nào nên xem xét lại**:
- App có > 10 chủ trọ thật (cột tên user_id sẽ gây nhầm với owner)
- Có rewrite lớn frontend (nên tận dụng làm chung)
- Vấn đề audit log cần ngữ nghĩa rõ ràng hơn

**Cách làm nếu thực hiện**:
1. `ALTER TABLE ... RENAME COLUMN user_id TO created_by` cho 30+ bảng
2. Rename trigger `*_set_user_id_audit` → `*_set_created_by_audit`
3. Update function `set_user_id_from_auth()` → ref `NEW.created_by`
4. Regenerate `src/integrations/supabase/types.ts`
5. Sửa ~80 chỗ frontend tham chiếu `.user_id` trên data tables → `.created_by`
6. **Không** rename trên các bảng auth (`profiles`, `roles`, `user_roles`,
   `staff_assignments.user_id`, `super_admins.user_id`, `account_shared_users`)

### 5.2 Trang `/admin/users` cho super_admin invite

Hiện tại user mới phải tạo tay qua Supabase Dashboard. Nên có UI cho
super_admin:
- Tạo user mới (email + password tạm)
- Gán role + assign vào buildings
- Reset password
- Vô hiệu hoá user

API: `supabase.auth.admin.createUser()` (yêu cầu service_role key — edge
function recommended).

File mới gợi ý:
- `src/pages/admin/UsersPage.tsx`
- `src/hooks/useAdminUsers.ts`
- `supabase/functions/admin-create-user/index.ts`

### 5.3 Refactor RBAC cho các bảng config còn lại

17 bảng (mục 3.4 nhóm "Config/Template/Category"):
- `ct01_declarations`, `expenses`, `income_expense_batches`,
  `income_expense_templates`, `income_expense_types`,
  `invoice_generation_settings`, `issue_categories`, `issue_phase_history`,
  `issue_status_history`, `notification_templates`, `scheduled_jobs`,
  `service_quotas`, `sla_configs`, `suppliers`, `task_flows`, `task_types`

Hầu hết là setting/category — có thể dùng `can_access_org_entity` tương
ứng với 1 trong các permission đã có (`templates`, `settings`,
`task_types`, ...).

Mức độ ưu tiên: thấp. Hiện policy cũ vẫn cover (Tâm thấy hết vì là owner).

### 5.4 Sổ quỹ (accounts + income_expenses shared_users)

Hiện tại `accounts` có cơ chế `account_shared_users` riêng cho phép owner
chia sẻ 1 sổ quỹ với nhiều người. Không nằm trong scope refactor lần này.

Nếu muốn RBAC thuần:
- Bỏ `account_shared_users`, thay bằng `role.permissions.cashbooks.view/edit`
- Nhưng mất tính năng "chia sẻ 1 sổ cụ thể"

Đánh đổi: cần thảo luận thêm với người dùng cuối.

### 5.5 RPC v2 cho các RPC khác

Hiện chỉ `get_invoice_statistics_v2` đã làm. Các RPC sau vẫn dùng
`p_user_id`:

- `record_invoice_payment(p_user_id, ...)`
- `generate_invoices_for_building(p_user_id, ...)`
- `generate_recurring_vouchers(p_user_id, ...)`
- `renew_contract`, `transfer_room`, `transfer_contract`,
  `terminate_contract_forfeit`, `terminate_contract_move_out`
- `approve_voucher`, `bulk_create_meter_readings`

Tất cả đều hoạt động — RLS mới đã chặn ở tầng row, RPC chỉ lấy `p_user_id`
làm tham số định danh chứ không gây bug. Nhưng nên dần chuyển sang `_v2`
để code consistency.

### 5.6 Dọn 26 chỗ `.eq('user_id', ...)` trong frontend lib/components

`src/lib/contractHelpers.ts`, `src/lib/invoiceHelpers.ts`,
`src/lib/notificationScheduler.ts`, `src/lib/issueHelpers.ts`,
`src/lib/terminationHelpers.ts`,
`src/components/import-export/ExportExcelDialog.tsx`, etc.

Các filter này TRÙNG LẶP với RLS, có thể gỡ. Sau khi gỡ, code gọn hơn và
super_admin sẽ thấy data cross-owner đúng (không bị filter app-level).

Rủi ro: medium — cần test từng helper.

### 5.7 Drop policy cũ (`*_select_own`, `*_staff_select`)

**Khi nào**: sau khi monitoring stable ≥ 2 tuần và confirm không ai dùng đường
cũ. PostgreSQL OR mọi policy match → giữ policy cũ thì không ảnh hưởng,
chỉ "dư".

Lúc drop:
```sql
DROP POLICY invoices_select_own ON invoices;
DROP POLICY invoices_select_staff ON invoices;
-- ... cho tất cả bảng
```

### 5.8 Drop RPC v1 `get_invoice_statistics(p_user_id, ...)`

Sau khi đã confirm 100% frontend dùng v2:
```sql
DROP FUNCTION get_invoice_statistics(uuid, uuid, uuid, invoice_status, date, date, text, text, uuid, uuid);
```

### 5.9 Drop helper cũ `current_visible_owner_ids()`

Helper cũ không còn ai gọi sau khi drop policy `*_staff_select`.

### 5.10 Backfill 9 invoice "lệch owner" (KHÔNG cần)

Trong RBAC mới, `invoices.user_id` của 9 invoice cross-owner = staff_id là
hợp lệ (chỉ là audit "ai tạo"). Không cần backfill. Để nguyên.

---

## 6. Cách rollback từng phase

| Phase | Lệnh rollback |
|---|---|
| 7 | Khôi phục `src/pages/auth/Register.tsx` từ commit `bb8b84e` |
| 6 | `COMMENT ON COLUMN ... IS NULL` (xoá annotation) |
| 5 | `DROP POLICY *_rbac` cho 23 bảng phase 5; `DROP FUNCTION can_access_org_entity` |
| 4 | `DROP POLICY *_rbac` cho areas/buildings/floors/rooms/beds/building_services |
| 3 | `DROP POLICY *_rbac` cho contracts + contract_*/deposits |
| 2 | `DROP POLICY *_rbac` cho invoices/payments/IE/excess_amounts; `DROP FUNCTION get_invoice_statistics_v2`; revert `src/hooks/useInvoices.ts` |
| 1 | `DROP FUNCTION can_access_building, can_do_on_building, building_of_*` |
| 0 | (read-only, không cần rollback) |

Data không bị động → không cần restore từ backup. Backup chỉ dùng trong
trường hợp khẩn cấp ngoài plan.

---

## 7. Tham chiếu nhanh

| Tài liệu | Đường dẫn |
|---|---|
| Plan gốc | `~/.claude/plans/breezy-finding-gem.md` |
| Baseline | `.scratch/baseline_phase0.json` |
| Per-area baseline | `.scratch/baseline_per_area.json` |
| Backup | `.backups/pre_rbac_20260527_235207/` |
| Script verify | `.scratch/verify_baseline.cjs` |
| Helper SQL | `supabase/migrations/20260527000003_rbac_helpers.sql` |
| Phase 2 SQL | `supabase/migrations/20260527000004_*.sql`, `20260527000005_*.sql`, `20260527000006_*.sql` |
| Phase 3 SQL | `supabase/migrations/20260527000007_*.sql` |
| Phase 4 SQL | `supabase/migrations/20260527000008_*.sql` |
| Phase 5 SQL | `supabase/migrations/20260527000009_*.sql` |
| Phase 6 SQL | `supabase/migrations/20260527000010_*.sql` |
| Frontend chính | `src/hooks/useInvoices.ts` (line 768), `src/pages/auth/Register.tsx` |
| Commit history | `git log --oneline --grep=rbac` |

---

*Tài liệu này phản ánh trạng thái DB và code tại thời điểm hoàn thành
refactor. Khi có thay đổi sau (rename, drop legacy), cập nhật lại file này.*
