---
title: "Quản trị người dùng (super admin)"
description: "Trang cấp nền tảng để super admin tạo tài khoản Auth; việc đưa người dùng vào tổ chức và phân quyền thực hiện ở Thành viên và Mẫu vai trò."
routes: ["/admin/users"]
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  account: production
status: published
---

# Quản trị người dùng (super admin)

`/admin/users` là trang quản trị **cấp nền tảng**, chỉ dành cho **super admin**. Trang này tạo tài khoản Auth và hồ sơ cơ bản; nó không thay thế quy trình mời thành viên vào một tổ chức và không tự cấp vai trò, quyền hay phạm vi dữ liệu.

::: warning Chỉ super admin nền tảng
Route này được chặn bằng kiểm tra admin riêng, không dùng quyền `users.view`. Tài khoản không phải super admin sẽ bị chuyển về trang chủ.
:::

## Tạo tài khoản nền tảng

1. Mở `/admin/users` và bấm **Tạo tài khoản**.
2. Nhập **Email** và **Mật khẩu** (tối thiểu 6 ký tự).
3. Có thể nhập thêm **Họ tên** và **Số điện thoại**.
4. Bấm **Tạo** để tạo tài khoản Auth/hồ sơ.

Danh sách tài khoản hiển thị email, số điện thoại, trạng thái **Super admin / Staff / Chưa gán**, số lượng phân công và thời điểm tạo. Các nhãn này chỉ giúp super admin quan sát nhanh trạng thái tài khoản; chúng không phải mô hình phân quyền tổ chức hiện hành.

## Đưa người dùng vào tổ chức

Đối với nhân viên thông thường, dùng quy trình chính tại `/settings/members`:

1. Bấm **Mời thành viên** và nhập email thật của người nhận.
2. Chọn loại thành viên; có thể gán trước một vai trò và phạm vi.
3. Sao chép đường dẫn mời xuất hiện sau khi tạo và gửi thủ công cho người nhận.
4. Người nhận đăng nhập bằng đúng email được mời rồi mở `/invite/:token`.

Sau khi thành viên vào tổ chức, quản lý vai trò tại `/settings/roles` và quyền/phạm vi của từng người tại `/settings/members`. Route cũ `/settings/staff` chỉ chuyển hướng đến `/settings/members`.

::: info Tài khoản Auth khác thành viên tổ chức
Một tài khoản có thể tồn tại ở tầng Auth nhưng chưa có bản ghi `organization_memberships`. Chỉ khi có membership cùng vai trò, binding, scope hoặc ngoại lệ phù hợp thì người đó mới có quyền hiệu lực trong tổ chức.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/admin/users" app-label="Mở trang Quản trị người dùng" view-only>

Tài khoản demo không phải super admin nền tảng nên sẽ bị chuyển khỏi trang. Đây là hành vi bảo vệ đúng của route.

</SandboxTry>

## Quy trình liên quan

- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/)
- [Nhân viên và thành viên tổ chức](/05-cai-dat/nhan-vien-doi-ngu/)
- [Mẫu vai trò và quyền](/05-cai-dat/phan-quyen/)
