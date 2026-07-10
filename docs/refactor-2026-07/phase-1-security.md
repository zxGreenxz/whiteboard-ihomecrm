# Phase 1 — Vá bảo mật xuyên-tenant (DB-only)

**Commit:** `5e9c3cf` · **Loại:** DB-only (không đụng FE) · **Migration:**
`20260710130000_security_cross_tenant_hotfix.sql`, `20260710130500_revoke_internal_definer_grants.sql`

## Vì sao

Audit phát hiện lỗ hổng đọc/ghi xuyên-tenant — nghiêm trọng vì hệ thống đã có
người ngoài dùng và định hướng SaaS đa-chủ-nhà.

## 3 lỗ hổng chính đã vá

### 1. `get_income_expense_history(uuid)` — IDOR đọc nhật ký phiếu thu/chi

- **Trước:** `SECURITY DEFINER` + `GRANT authenticated`, thân hàm là
  `SELECT ... FROM income_expense_audit_log WHERE income_expense_id = p_id` **KHÔNG
  guard**. Bất kỳ user đăng nhập nào truyền id phiếu của tenant khác → đọc được
  nhật ký (ai thao tác, ghi chú, lịch sử trạng thái).
- **Sau:** chuyển `SECURITY INVOKER`. Quyền đọc giao cho RLS của
  `income_expense_audit_log` qua policy mới `income_expense_audit_log_select_parent_visible`:
  `EXISTS (SELECT 1 FROM income_expenses ie WHERE ie.id = income_expense_id)` — subquery
  này chịu RLS của `income_expenses` theo CHÍNH caller → ai thấy phiếu cha mới thấy
  nhật ký. Kế thừa nguyên bộ 27 policy của `income_expenses` (kể cả RESTRICTIVE ẩn
  phiếu hạn chế) mà không chép lại. Policy cũ `income_expense_audit_log_select_owner`
  (chỉ so `user_id = auth.uid()`) đã DROP.

### 2. `salary_staff_months()` — lộ config thưởng tenant đầu tiên

- **Trước:** `SECURITY DEFINER` đọc `salary_bonus_rules LIMIT 1` **không lọc
  user_id** → trả config thưởng của tenant "đầu tiên trong bảng" cho MỌI user.
- **Sau:** thêm filter `WHERE user_id = <owner của caller>`, owner resolve từ
  `auth.uid()` theo pattern mirror `monthly_building_profit`: super_admin→self,
  chủ toà→self, staff→owner qua `staff_assignments`, fallback `auth.uid()` (KHÔNG
  fallback xuyên-tenant như bản cũ).

### 3. `generate_invoices_for_building` (v1 legacy) — có thể PUBLIC gọi

- **Trước:** `SECURITY DEFINER` nhận `p_user_id` tuỳ ý, không guard, chưa từng
  REVOKE → mặc định PUBLIC execute → sinh hoá đơn cho toà tenant khác.
- **Sau:** `REVOKE ALL FROM PUBLIC, anon, authenticated`. Wrapper `_v2` (đã guard
  `can_do_on_building('invoices','create')`) vẫn gọi được v1 vì chạy `SECURITY
  DEFINER` dưới owner của function. FE chỉ dùng `_v2` (đã grep xác nhận).

## Sweep bổ sung (migration thứ 2)

Query live liệt kê mọi `SECURITY DEFINER` reachable bởi authenticated/anon mà thân
hàm không có token guard. Sau khi loại false-positive (helper nội bộ, recompute
trigger-called, `fa_*_accrual` guard bắc cầu, `get_public_*` anon-by-design), còn
lại vá thêm:

| Hàm | Vấn đề | Xử lý |
|-----|--------|-------|
| `generate_recurring_vouchers(uuid)` | anon ghi phiếu recurring cho user_id bất kỳ | REVOKE PUBLIC/anon/authenticated (cron gọi qua parent DEFINER) |
| `seed_commission_expense_types(uuid)` | anon chèn loại chi vào tenant bất kỳ | REVOKE (RPC hoa hồng gọi qua parent DEFINER) |
| `is_user_super_admin(uuid)` | anon đọc | REVOKE PUBLIC/anon, GRANT authenticated |
| `v5_building_reqs`, `v5_checklist_for_building` | anon đọc config+phòng (v5 FLAGS OFF) | REVOKE PUBLIC/anon, GRANT authenticated |

**GOTCHA đã gặp:** các hàm này được GRANT cho `PUBLIC` → `has_function_privilege('anon',...)`
vẫn true dù đã `REVOKE ... FROM anon` (anon kế thừa PUBLIC). Phải `REVOKE ALL FROM
PUBLIC` rồi `GRANT ... TO authenticated` mới chặn được anon.

## Verify đã làm

- Query `pg_proc` grants sau vá: `get_income_expense_history` (INVOKER, auth✓,
  anon✗), `salary_staff_months` (auth✓, anon✗), `generate_invoices_for_building`
  (auth✗, anon✗), 5 hàm sweep (auth✓, anon✗). **Khớp mong đợi.**
- Playwright login owner: `/finance/my-salary` (load OK, owner không cấu hình lương
  = bình thường), `/income-expense` (1537 phiếu, tổng thu 4.286.508.529đ / chi
  4.152.089.871đ đúng), mở chi tiết 1 phiếu — 0 lỗi console.

## Reviewer cần soi

1. **Policy `income_expense_audit_log_select_parent_visible`**: xác nhận subquery
   `EXISTS (... FROM income_expenses ie WHERE ie.id = income_expense_id)` THỰC SỰ
   chịu RLS của caller (không phải bypass). Test: đăng nhập tenant B, gọi
   `get_income_expense_history` với id phiếu của tenant A → phải rỗng.
2. **`salary_staff_months` owner-resolve**: fallback cuối cùng `auth.uid()` — với
   user KHÔNG phải super_admin/chủ toà/staff (vd tài khoản lạ), trả config của
   chính họ (thường rỗng). Xác nhận không rò tenant khác.
3. **REVOKE có phá cron không?** `generate_recurring_vouchers` do
   `run_recurring_vouchers_job` (service_role) gọi — service_role bypass grant. Và
   `_v2` FE dùng vẫn còn quyền. Xác nhận job recurring vẫn chạy (test: chờ cron kỳ
   sau hoặc gọi thủ công qua service_role).
4. **Còn DEFINER hở nào chưa quét?** Sweep chỉ xét hàm reachable authenticated/anon.
   Nên chạy lại sweep định kỳ khi thêm RPC mới.
