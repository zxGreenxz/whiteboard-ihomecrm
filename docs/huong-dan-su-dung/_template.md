---
# ===== TEMPLATE TRANG HƯỚNG DẪN — copy file này, KHÔNG sửa trực tiếp =====
# File bắt đầu bằng "_" bị loại khỏi build (srcExclude).
title: "Tên nghiệp vụ (KHÔNG phải tên route)"
description: "Một câu mô tả trang này giúp làm gì."
routes:
  - /duong-dan-route          # route SPA màn hình này
permissions:
  - module: ten_module        # khớp src/lib/permissionPages.ts
    action: ten_action
viewport: desktop             # desktop (1440x900) | mobile (390x844)
captured:
  date: null                  # YYYY-MM-DD ngày chụp bộ ảnh hiện tại
  commit: null                # HEAD của app lúc chụp
  account: null               # account demo dùng khi chụp (vd demo-quanly)
  manifest: null              # manifests/<nhom>/<trang>.yml
audience: []                  # vd [chu-nha, quan-ly-toa, ke-toan]
status: draft                 # draft | published | stale
---

# Tên nghiệp vụ

Đoạn mở đầu 2–4 câu: màn hình này dùng để làm gì, khi nào dùng, dùng thay cho
màn hình nào trong tình huống nào. Không đặt heading "Mục đích".

::: info Điều kiện tiên quyết
- Tài khoản có quyền **Tên quyền** (module `ten_module`).
- Dữ liệu cần có trước: … (link sang trang hướng dẫn tạo dữ liệu đó).
:::

## Hướng dẫn từng bước

**Bước 1**: Tại màn hình chính, ấn chọn **Nhãn menu** => **Nhãn trang**.

![Bước 1 - Mô tả ngắn](./images/buoc-01-slug.webp)

**Bước 2**: Ấn nút **Nhãn nút**. Kết quả nhìn thấy sau thao tác (câu này = wait_for trong manifest).

![Bước 2 - Mô tả ngắn](./images/buoc-02-slug.webp)

<!-- ::: danger BẮT BUỘC cho mọi hành động ghi tiền vào sổ -->
<!-- ::: warning cho hành động khó hoàn tác (xoá, duyệt, import hàng loạt) -->
<!-- ::: tip cho mẹo làm nhanh -->

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| **Nhãn nút** | … |

## Tình huống & lỗi thường gặp

| Tình huống | Nguyên nhân & cách xử lý |
|---|---|
| … | … |

## Quy trình liên quan

- [Tên trang liên quan](../nhom/trang.md)
