---
title: "Quản trị người dùng (super admin)"
description: "Trang cấp nền tảng để super admin tạo tài khoản đăng nhập; việc đưa người dùng vào tổ chức và phân quyền thực hiện ở Thành viên và Mẫu vai trò."
routes: ["/admin/users"]
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Quản trị người dùng (super admin)

`/admin/users` là trang **Quản lý tài khoản** cấp **nền tảng**, chỉ dành cho **super admin** của hệ thống. Trang này tạo tài khoản đăng nhập (Auth) kèm hồ sơ cơ bản; nó **không** đưa người đó vào một tổ chức và **không** cấp vai trò, quyền hay phạm vi dữ liệu.

::: warning Chỉ super admin nền tảng
Route được chặn bằng kiểm tra super admin riêng (RPC `is_admin`, nay chỉ đúng với tài khoản nằm trong danh sách super admin), không dùng quyền `users.view` và không có mục trong menu bên trái. Tài khoản không phải super admin mở đường dẫn này sẽ bị chuyển về trang chủ `/`. Ngay cả vai trò **Chủ công ty** cũng không vào được.
:::

::: info Trang này không có ảnh chụp
Tài khoản DEMO không phải super admin nên không mở được trang (đã thử với `demo.chunha` ngày 07/10/2026: bị chuyển về `/`). Nội dung dưới đây được đối chiếu với mã nguồn tại commit ghi ở đầu trang.
:::

## Màn hình Quản lý tài khoản

Tiêu đề trang là **Quản lý tài khoản**, dòng mô tả: *"Tạo và quản lý tài khoản người dùng trong hệ thống. Chỉ super_admin có quyền truy cập."*

Thẻ **Danh sách tài khoản (N)** liệt kê mọi hồ sơ người dùng mà super admin đọc được, mới tạo xếp trước, gồm các cột:

| Cột | Ý nghĩa |
|---|---|
| **Họ tên** | Tên trong hồ sơ, `-` nếu trống |
| **Email** | Email trong hồ sơ |
| **SĐT** | Số điện thoại trong hồ sơ |
| **Vai trò** | **Super admin** (tài khoản nằm trong danh sách super admin), **Staff** (có bản ghi phân công kiểu cũ) hoặc **Chưa gán** |
| **Toà nhà được giao** | Số bản ghi phân công kiểu cũ (`staff_assignments`) của tài khoản |
| **Tạo lúc** | Ngày tạo hồ sơ |

::: tip Đừng đọc cột Vai trò như quyền thật
Nhãn **Staff / Chưa gán** và cột **Toà nhà được giao** đếm theo bảng phân công cũ, không còn quyết định quyền từ khi chuyển sang mô hình tổ chức (vai trò + phạm vi). Muốn biết một người thực sự làm được gì trong một công ty, xem thẻ của họ ở [Thành viên](/05-cai-dat/nhan-vien-doi-ngu/) và tab **Quyền hiệu lực**.
:::

## Tạo tài khoản nền tảng

1. Mở `/admin/users`, bấm **Tạo tài khoản**. Hộp thoại **Tạo tài khoản mới** mở ra.
2. Nhập **Email \*** (đúng định dạng, ví dụ `ten@congty.vn`) và **Mật khẩu \*** (ít nhất 6 ký tự).
3. Có thể nhập thêm **Họ tên** và **Số điện thoại**.
4. Bấm **Tạo**. Tài khoản được kích hoạt ngay; hệ thống báo *"Đã tạo tài khoản mới"* và danh sách tự nạp lại. Bấm **Huỷ** để đóng mà không tạo.

Mô tả trong hộp thoại còn nhắc "phân role + assign building qua trang Phân quyền nhân viên" — đó là tên trang cũ; nay việc này làm ở **Thành viên** và **Mẫu vai trò** như mục dưới.

## Đưa người dùng vào tổ chức

Tạo tài khoản ở đây chưa đủ để người đó làm việc trong một công ty. Quy trình chính là mời từ `/settings/members`:

1. Bấm **Mời thành viên**, nhập email thật của người nhận.
2. Chọn **Loại thành viên**; có thể chọn **Vai trò khi vào (tuỳ chọn)** và phạm vi áp dụng.
3. Bấm **Tạo lời mời**, sao chép đường dẫn mời (chỉ hiện một lần) và gửi thủ công cho người nhận.
4. Người nhận đăng nhập bằng đúng email được mời rồi mở `/invite/:token`.

Sau khi vào tổ chức, quản lý vai trò tại `/settings/roles` và vai trò/phạm vi/ngoại lệ của từng người tại `/settings/members`. Route cũ `/settings/staff` chỉ chuyển hướng đến `/settings/members`.

::: info Tài khoản Auth khác thành viên tổ chức
Một tài khoản có thể tồn tại ở tầng đăng nhập nhưng chưa là thành viên tổ chức nào. Chỉ khi có membership cùng vai trò gắn phạm vi (hoặc ngoại lệ phù hợp) thì người đó mới có quyền hiệu lực trong tổ chức.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/admin/users" app-label="Mở trang Quản lý tài khoản" view-only>

Tài khoản demo không phải super admin nền tảng nên sẽ bị chuyển về trang chủ. Đây là hành vi bảo vệ đúng của route.

</SandboxTry>

## Quy trình liên quan

- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/)
- [Thành viên tổ chức](/05-cai-dat/nhan-vien-doi-ngu/)
- [Mẫu vai trò và quyền](/05-cai-dat/phan-quyen/)
