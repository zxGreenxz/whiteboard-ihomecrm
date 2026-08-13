---
title: "Làm quen giao diện"
description: "Bố cục desktop/mobile, nhóm điều hướng, bộ lọc và quan hệ giữa menu, capability và phạm vi dữ liệu."
routes: ["/", "/dashboard"]
permissions: []
viewport: desktop
audience: [tat-ca]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Làm quen giao diện

Sau đăng nhập, máy tính mở **Bảng tin** tại `/`; điện thoại mở **HomeLauncher** tại `/`, còn Bảng tin mobile nằm ở `/dashboard`. Giao diện chỉ hiện menu/ô chức năng khớp capability, trong khi dữ liệu bên trong tiếp tục được lọc độc lập theo phạm vi và RLS.

::: info Điều kiện tiên quyết
- Có tài khoản đăng nhập tại <https://ptcrm.vercel.app>.
- Được cấp capability để menu/ô chức năng xuất hiện.
- Được gán phạm vi để trang có dữ liệu toà, khu hoặc sổ quỹ tương ứng.
:::

## Giao diện máy tính

**Bước 1**: Sau khi đăng nhập, nhìn sidebar ở mép trái.

![Giao diện desktop với thanh điều hướng bên trái chia theo nhóm](./images/buoc-01-desktop.webp)

**Bước 2**: Các nhóm hiện hành gồm:

- **THEO DÕI NHANH** — Bảng tin, Sơ đồ toà nhà.
- **QUẢN LÝ & VẬN HÀNH** — danh mục và nghiệp vụ hằng ngày; **Thông báo** hiện nằm trong nhóm này.
- **BÁO CÁO** — các báo cáo bất động sản và tài chính mà tài khoản có quyền.
- **CÀI ĐẶT HỆ THỐNG** — công tơ, định mức, danh mục, biểu mẫu, thành viên và vai trò.
- **TÀI KHOẢN** — thông tin/cài đặt của người đang đăng nhập.

**Bước 3**: Menu được lọc theo capability chính xác, ví dụ `buildings.view`, `rooms.view`, `cashbooks.view`. Tên vai trò không phải gate trực tiếp và việc thấy menu không đồng nghĩa được tạo/sửa/xoá.

**Bước 4**: Trên các trang danh sách, dùng bộ lọc toà/khu/trạng thái theo đúng UI của trang. Không có một quy tắc “mọi trang chỉ chọn một toà”: trang Phòng và nhiều danh sách hỗ trợ nhiều toà/khu; một số trang như Sơ đồ chỉ chọn một toà.

**Bước 5**: Nhấn chuông ở góc trên để xem nhanh thông báo chưa đọc. Trang đầy đủ là `/notifications` và cần `notifications.view`.

## Giao diện điện thoại

![Màn hình chính trên điện thoại dạng lưới biểu tượng](./images/buoc-02-mobile-home.webp)

Trang `/` trên điện thoại là lưới biểu tượng. Mỗi ô được lọc bằng đúng `module.action`; vì vậy hai người cùng tên vai trò nhưng khác ngoại lệ quyền có thể thấy lưới khác nhau. Các màn như **Việc của tôi** (`/my-day`) và nhiều luồng thu tiền có giao diện mobile riêng.

## Quyền menu và quyền dữ liệu

| Lớp | Quyết định |
|---|---|
| Capability | Trang/nút có được mở hay không. |
| Phạm vi | Toà, khu, tổ chức hoặc sổ quỹ nào nằm trong quyền hiệu lực. |
| RLS/hook dữ liệu | Các dòng thực tế được trả về cho user hiện tại. |
| Possession nghiệp vụ | Ví dụ ai đang giữ sổ mới được ghi/chốt tiền dù đã có capability. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Không thấy mục menu | Kiểm tra capability `.view` của đúng module trong **Quyền hiệu lực**. |
| Thấy trang nhưng danh sách trống | Kiểm tra phạm vi toà/khu/sổ quỹ và dữ liệu thật trong phạm vi đó. |
| Không thấy nút Thêm/Sửa/Xoá | Quyền xem trang không tự bao gồm `.create/.edit/.delete`. |
| Không thấy Thông báo trong Theo dõi nhanh | Đúng bố cục hiện tại: mục này nằm dưới Quản lý & Vận hành. |
| Trên mobile không thấy sidebar | Đúng thiết kế; dùng HomeLauncher và các tab mobile. |
| Bộ lọc khác trang đồng nghiệp | Mỗi trang có hook/bộ lọc riêng; một số cho nhiều toà, một số chỉ một toà. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/" view-only>

So sánh desktop và mobile, rồi so `demo.quanly` với `demo.ketoan`. Bạn sẽ thấy menu/ô chức năng khác theo capability; dữ liệu của `demo.quanly` chỉ thuộc DEMO Toà A+B, trong khi tài khoản kế toán có phạm vi tổ chức nhưng vẫn chỉ mở các nghiệp vụ được cấp.

</SandboxTry>

## Quy trình liên quan

- [Đăng nhập](/01-bat-dau/dang-nhap/)
- [Sandbox — Môi trường thực hành](/01-bat-dau/sandbox/)
- [Bảng tin](/02-theo-doi-nhanh/bang-tin/)
- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/)
