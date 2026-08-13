---
title: "Thành viên tổ chức"
description: "Mời thành viên bằng email, gán một hoặc nhiều vai trò theo phạm vi và quản lý ngoại lệ quyền trong mô hình RBAC V3."
routes: ["/settings/organization", "/settings/members", "/settings/roles"]
permissions: [{module: users, action: view}, {module: users, action: create}, {module: users, action: edit}, {module: users, action: delete}, {module: users, action: manage_templates}]
viewport: responsive
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "c6e8e4584b0a43a543ac0dd296f49c53f7e85d6b"
  account: demo.chunha
status: published
---

# Thành viên tổ chức

![Màn Thành viên production của tổ chức DEMO với 7 tài khoản, vai trò, phạm vi và số quyền đang hiệu lực](./images/buoc-01-man-hinh.webp)

::: info Snapshot quyền hiệu lực
Ảnh ngày 13/08/2026 cho thấy `demo.chunha` đang hiển thị **229 quyền hiệu lực**, trong khi thẻ vai trò **Chủ công ty** ở màn Mẫu vai trò có **231 quyền**. Đây là bằng chứng vai trò/catalog và quyền hiệu lực của một thành viên không phải cùng một con số; scope hoặc ngoại lệ có thể làm kết quả cuối khác đi.
:::

Trang chính để quản lý người trong tổ chức là `/settings/members`. Route cũ `/settings/staff` **chỉ chuyển hướng** đến route này. `/settings/organization` quản lý thông tin tổ chức, còn `/settings/roles` quản lý các gói quyền dùng lại.

::: info Điều kiện tiên quyết
- `users.view` để mở các trang tổ chức, thành viên và vai trò.
- `users.create`, `users.edit`, `users.delete` cho các thao tác tương ứng với thành viên.
- `users.manage_templates` để quản lý **Mẫu vai trò**.
- Bạn không thể sửa phân quyền của chính mình.
:::

## Mời thành viên

1. Mở `/settings/members` và bấm **Mời thành viên**.
2. Nhập **email thật** của người nhận và chọn loại thành viên.
3. Có thể chọn một vai trò ban đầu. Nếu chọn vai trò, phải chọn ít nhất một phạm vi áp dụng.
4. Gửi lời mời. Hệ thống hiển thị đường dẫn mời **một lần**; sao chép và gửi thủ công cho người nhận.
5. Người nhận đăng nhập bằng đúng email đã được mời rồi mở `/invite/:token` để vào tổ chức.

Hệ thống hiện không tự gửi email mời. Không tạo nhân viên bằng tên đăng nhập/mật khẩu tại trang này.

## Vai trò và phạm vi

Mỗi thành viên có thể mang nhiều vai trò, mỗi vai trò được gắn qua một `role_binding` và phải có ít nhất một scope:

| Scope | Ý nghĩa |
|---|---|
| `ORGANIZATION` | Toàn tổ chức, gồm cả toà nhà và sổ quỹ tạo trong tương lai; không kết hợp scope khác trong cùng binding |
| `AREA` | Một khu vực và dữ liệu thuộc khu vực đó |
| `BUILDING` | Một toà nhà cụ thể |
| `CASHBOOK` | Một sổ quỹ cụ thể |

Vai trò chỉ chứa gói quyền, **không chứa phạm vi**. Cùng một vai trò có thể gán cho một người ở nhiều scope khác nhau.

## Chỉnh quyền một thành viên

Mở thành viên để dùng ba tab:

- **Vai trò & phạm vi**: thêm/bớt role binding và scope.
- **Ngoại lệ**: thêm `ALLOW` hoặc `DENY` cho riêng người này, có lý do và nhật ký.
- **Quyền hiệu lực**: xem kết quả cuối cùng sau khi cộng quyền từ vai trò, phạm vi và ngoại lệ.

Quyền hiệu lực được tính từ `organization_memberships`, `organization_roles`, `role_permissions`, `role_bindings`, `role_binding_scopes` và `member_permission_overrides`. Khi xung đột, **`DENY` luôn thắng**.

::: warning Sửa vai trò ảnh hưởng ngay nhiều người
Vai trò là gói quyền sống, không phải bản sao chép vào từng thành viên. Chỉnh một vai trò tại `/settings/roles` làm thay đổi quyền hiệu lực của **mọi thành viên đang mang vai trò đó ngay lập tức**.
:::

## Tình huống thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Không gán được vai trò | Chọn ít nhất một scope; mỗi binding bắt buộc có phạm vi |
| Người nhận không vào được tổ chức | Đăng nhập đúng email được mời rồi mở lại link `/invite/:token` |
| Không nhận được email mời | Hệ thống không tự gửi; người mời phải sao chép và gửi link thủ công |
| Có quyền nhưng không thao tác được ở một toà/sổ | Kiểm tra scope của role binding và ngoại lệ `DENY` |
| Muốn sửa quyền của chính mình | Nhờ một quản trị viên đủ quyền khác thực hiện |

## Quy trình liên quan

- [Thêm nhân viên](/01-bat-dau/them-nhan-vien/)
- [Mẫu vai trò và quyền](/05-cai-dat/phan-quyen/)
- [Tạo khu vực và toà nhà](/01-bat-dau/tao-toa-nha/)
