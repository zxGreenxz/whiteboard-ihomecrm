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
  commit: null                # SHA deployment production đang phục vụ lúc chụp; để null nếu chưa truy nguyên được
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

<!-- Với phiếu tài chính, luôn tách approval_status / review_state / posting_mode / posting_status. -->
<!-- Không viết "Đã duyệt = tiền thật": chỉ posting_status=POSTED mới là Đã Thu/Đã Chi. -->
<!-- Route phải dùng đường canonical hiện tại; nếu nhắc route cũ, ghi rõ đó là redirect. -->
<!-- Trang thuộc 08-ke-hoach-phat-trien phải có lifecycle: proposal và banner "không phải runtime". -->

<!-- ===== KHỐI THỬ TRỰC TIẾP — ưu tiên view-only; chỉ cho phép ghi khi bài có fixture tự dọn rõ ràng ===== -->
## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/duong-dan-route" app-label="Mở màn hình cần kiểm tra" fixtures="Mô tả snapshot đã xác minh theo ngày chụp" view-only>

**Bài tập chỉ xem**

1. Mở đúng màn hình và đối chiếu các nhãn, cột, số liệu hoặc trạng thái được mô tả trong bài.
2. Nếu cần kiểm tra form/dialog, chỉ mở để xem trường rồi **Đóng/Huỷ**; không bấm **Lưu**, **Duyệt**, **Thu tiền** hoặc thao tác ghi khác.

**Kết quả mong đợi**

- Giao diện và snapshot hiện tại khớp nội dung hướng dẫn.
- Không có dữ liệu DEMO nào bị tạo, sửa, xoá hoặc post vào sổ.

</SandboxTry>

<!-- Chỉ bỏ view-only khi bài ghi có fixture cô lập + cơ chế tự dọn đã được kiểm chứng và nêu rõ ngay trong block. -->

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
