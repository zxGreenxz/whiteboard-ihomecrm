# Tổ chức, nhân sự và phân quyền

> **Reviewed:** 2026-07-20  
> Đây là mô hình production hiện tại, không phải mô hình RBAC owner-keyed cũ.

## Công thức quyền

```text
membership đang hoạt động
  + organization role / role binding
  + scope (organization, area, building, cashbook)
  + override ALLOW/DENY
  -> authorize_v2
  -> RPC/RLS quyết định cuối
```

`DENY` thắng `ALLOW`; tài khoản bị suspend/off-board phải fail closed ở cả đường canonical và legacy guard.

## Bảng cốt lõi

- `organizations`, `organization_memberships`, `organization_roles`.
- `role_bindings`, `role_binding_scopes`, `authorization_scopes`.
- `member_permission_overrides`, `member_override_scopes`.
- `authorization_audit_events`.
- `staff_assignments` và `roles` còn phục vụ compatibility/UI trong giai đoạn chuyển đổi; không dùng riêng chúng để kết luận tenant boundary mới.

## Trách nhiệm các lớp

| Lớp | Trách nhiệm |
|---|---|
| UI catalog | Hiển thị trang/nút theo [permissionPages.ts](../../src/lib/permissionPages.ts); không phải security boundary. |
| `authorize_v2`/helper | Hợp nhất actor, org, action, resource và scope; fail closed khi thiếu membership/binding. |
| RPC writer | Kiểm quyền, organization, idempotency, invariant và audit trong transaction. |
| RLS | Ngăn đọc/ghi row ngoài organization/scope, kể cả khi client gọi Supabase trực tiếp. |
| Approval engine | Tách maker/checker cho giao dịch cần duyệt; snapshot rule/approver tại request. |

## Canonical writers

15/15 feature route canonical đã ON ngày 19/07. Các family chính gồm thu chi, thanh toán/hoàn tác hóa đơn, invoice, cashbook, contract/deposit, salary và shareholder-profit. Client không được tự chọn route bằng cách gửi cờ; backend đánh giá route theo organization.

Fallback legacy vẫn tồn tại có chủ đích ở một số màn chưa đủ parity hoặc chưa qua T7 drain. Vì vậy khi review một write path phải kiểm cả adapter frontend, RPC canonical và điều kiện fallback.

## Approval và possession

- Hạng mục `force_approval` luôn cần duyệt; phiếu chi thường từ ngưỡng owner cấu hình trở lên sinh nháp chờ duyệt.
- Maker không tự duyệt request engine. Owner emergency approve cần re-auth, reason đủ dài và audit.
- Sổ quỹ có possession/binding; quyền `cashbooks.post` có thể yêu cầu CUSTODIAN của đúng sổ, không chỉ permission chung.
- Off-boarding đóng binding và tăng authorization version để quyền cũ không sống tiếp.

## Quy trình quản trị

1. Tạo/cấp tài khoản qua luồng admin, không dựa vào public signup.
2. Gắn membership/role và scope tối thiểu cần thiết.
3. Chỉ dùng override cho ngoại lệ; ghi lý do và rà lại định kỳ.
4. Test cả allow, deny, cross-org và suspended-user.
5. Khi thu hồi nhân sự, dùng off-boarding mềm; không xóa thô làm mất audit.

## Tài liệu liên quan

- [Phê duyệt tài chính](20-phe-duyet-tai-chinh.md)
- [Authorization current status](../authorization/README.md)
- [Hướng dẫn phân quyền](../huong-dan-su-dung/05-cai-dat/phan-quyen/)
