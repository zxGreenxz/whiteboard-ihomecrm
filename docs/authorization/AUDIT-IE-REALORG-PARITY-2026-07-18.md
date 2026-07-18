# Audit parity quyền IE org THẬT (2026-07-18) + hành động đã áp

Nguồn: agent audit đọc prod read-only, cửa sổ 90 ngày. Org `aaaa0000-...-000000000001`.

## Kiến trúc gate thật (verified)

- `create`/`restricted_create` → `authorize_income_expense_on_building` (permission-graph; KHÔNG hiểu `__superadmin`, KHÔNG honor super_admins, chỉ nhận đúng 2 action này — action khác trả false vô điều kiện nhưng không writer nào gọi).
- `approve` (approve_income_expense_v1) → gate LEGACY (owner OR is_super_admin OR can_do_on_building) — **đã parity đầy đủ, 3 approver 90 ngày đều pass, không cần vá**.

## Gap tìm thấy & xử lý

| Gap | Chi tiết | Xử lý |
|---|---|---|
| **nguyentamca165 (super-admin, 669 phiếu/18 toà, toàn bộ phiếu hạng mục hạn chế)** | staff_assignments.permissions = `{"__superadmin":true}` → canonical DENY 100% create/restricted_create | **ĐÃ VÁ (SQL A, cùng ngày)**: bổ sung `income_expenses.{create,restricted_create,all_buildings}=true` vào 18 assignment. Verify sau vá: create=**t**, restricted_create=**t** ✓ |
| bosshuy 1 phiếu trên toà Kho VP Chung | Thiếu staff_assignment cho toà đó (scope không phủ) | **ĐỂ LẠI (tùy chọn B)** — chờ owner xác nhận nghiệp vụ; fallback legacy vẫn phủ |
| joey (500) + nathan (787) | Full parity sẵn | Không cần gì |

## Trạng thái sau vá

- Org thật **ĐÃ ĐỦ ĐIỀU KIỆN** bật canary IE create (đại diện thật sự — super-admin không còn fallback ép buộc).
- Còn thiếu để bật: (1) INSERT org thật vào `server_feature_flag_canary_orgs` cho `income_expense.create_draft.v1`; (2) CAS cửa sổ/cap mới cho sản xuất (cửa sổ hiện tại 6h/30 ops là config test, hết hạn 12:08Z). Đây là quyết định activation — thực hiện ở window có chủ đích.
- Client-fallback đã bảo hiểm 2 chiều từ trước: create 42501→fallback legacy (không vỡ UI); approve legacy-gate đã phủ hết.
