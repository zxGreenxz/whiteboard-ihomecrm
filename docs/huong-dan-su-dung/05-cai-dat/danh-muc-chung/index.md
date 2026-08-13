---
title: "Danh mục chung"
description: "Trang giữ chỗ Danh mục chung; chưa có danh sách hoặc thao tác CRUD runtime."
routes: ["/settings/categories/general"]
permissions: [{module: categories, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Danh mục chung

Trang **Danh mục chung** tại `/settings/categories/general` hiện là trang giữ chỗ với thông báo tính năng đang phát triển. Nó chưa hiển thị danh sách con và chưa có thao tác thêm, sửa hoặc xoá.

::: info Điều kiện tiên quyết
Bạn cần quyền **Danh mục** (xem) để mở trang này. Trang nằm trong nhóm **Cài đặt hệ thống**, truy cập qua **Cài đặt** => **Danh mục khác**. Nếu là nhân viên được phân quyền, các danh mục dùng chung ở đây là dữ liệu chung của chủ tài khoản (không phân theo tòa nhà bạn được giao).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Danh mục khác** để mở trang tổng hợp danh mục.

**Bước 2**: Ở nhóm **Khác**, chọn **Danh mục chung**. Trang mở ra tại đường dẫn `/settings/categories/general`.

**Bước 3**: Đọc trạng thái placeholder. Không dùng trang này để suy ra danh mục nào đang áp dụng toàn tổ chức hay theo phạm vi.

**Bước 4**: Quay lại **Danh mục khác** và chọn đúng trang đích. Lưu ý **Nhà cung cấp** và **Loại tài sản** cũng đang là placeholder; chỉ các trang có form runtime mới cho phép CRUD.

## Các tính năng khác trên màn hình

| Tính năng | Mô tả |
|-----------|-------|
| **Danh mục khác** (trang cha) | Trang tổng hợp gom link tới mọi danh mục con của hệ thống (Tài chính, Tài sản, Khác); là "bản đồ" điều hướng sang các trang quản lý danh mục. |
| **Danh sách tầng** | Danh mục tầng dùng chung cho mọi tòa nhà; thêm/sửa/xóa tại trang riêng. |
| **Loại công việc** | Danh mục loại công việc / sự cố dùng cho module Công việc. |
| **Quản lý Hotline** | Danh bạ số hotline hiển thị cho cư dân và kênh Phòng trống công khai. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|------------|------------|
| Trang hiển thị trống, chưa thấy danh mục nào để sửa | Đây là khu vực tổng hợp danh mục dùng chung. Từng danh mục cụ thể được quản lý ở trang riêng — quay lại **Danh mục khác** rồi chọn đúng mục (Danh sách tầng, Loại công việc, Quản lý Hotline...). |
| Không thấy mục **Danh mục khác** trong menu **Cài đặt** | Tài khoản của bạn chưa có quyền **Danh mục** (xem). Nhờ chủ nhà cấp quyền trong phần phân quyền nhân viên. |
| Sửa một danh mục dùng chung nhưng thấy đổi ở mọi tòa nhà | Đúng như thiết kế: các danh mục ở đây phẳng theo tài khoản và dùng chung cho mọi tòa. Đổi một chỗ sẽ áp dụng cho tất cả tòa nhà. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/categories/general" view-only>
Xem các danh mục chung.
</SandboxTry>

## Quy trình liên quan

- [Danh mục khác](/05-cai-dat/danh-muc-khac/) — trang tổng hợp điều hướng sang mọi danh mục con
- [Danh sách tầng](/05-cai-dat/danh-sach-tang/)
- [Loại công việc](/05-cai-dat/loai-cong-viec/)
- [Cài đặt chung](/05-cai-dat/cai-dat-chung/)
