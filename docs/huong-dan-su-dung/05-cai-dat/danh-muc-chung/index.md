---
title: "Danh mục chung"
description: "Khu vực tập hợp các danh mục dùng chung khác của hệ thống, truy cập từ trang Danh mục khác."
routes: ["/settings/categories/general"]
permissions: [{module: categories, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Danh mục chung

Trang **Danh mục chung** là nơi hệ thống gom các danh mục dùng chung khác — những danh mục phụ trợ không gắn riêng một tòa nhà mà áp dụng chung cho toàn bộ tài khoản của bạn (ví dụ tầng, loại công việc, hotline, nhà cung cấp). Bạn mở trang này từ trang tổng hợp **Danh mục khác** để có cái nhìn tổng quan về các danh mục dùng chung. Việc thêm/sửa từng danh mục cụ thể được thực hiện ngay trên trang quản lý riêng của danh mục đó.

::: info Điều kiện tiên quyết
Bạn cần quyền **Danh mục** (xem) để mở trang này. Trang nằm trong nhóm **Cài đặt hệ thống**, truy cập qua **Cài đặt** => **Danh mục khác**. Nếu là nhân viên được phân quyền, các danh mục dùng chung ở đây là dữ liệu chung của chủ tài khoản (không phân theo tòa nhà bạn được giao).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Danh mục khác** để mở trang tổng hợp danh mục.

**Bước 2**: Ở nhóm **Khác**, chọn **Danh mục chung**. Trang mở ra tại đường dẫn `/settings/categories/general`.

**Bước 3**: Xem các danh mục dùng chung được gom tại đây. Đây là khu vực tập hợp các danh mục phụ trợ dùng chung cho mọi tòa nhà — các danh mục này phẳng theo tài khoản, không có ô lọc theo tòa nhà hay khu vực.

**Bước 4**: Để chỉnh sửa một danh mục cụ thể, quay lại **Danh mục khác** và chọn đúng mục cần sửa — mỗi danh mục dùng chung (Danh sách tầng, Loại công việc, Quản lý Hotline, Nhà cung cấp...) có một trang quản lý riêng với đầy đủ nút Thêm / Sửa / Xóa.

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
