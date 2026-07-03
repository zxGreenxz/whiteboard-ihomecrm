---
title: "Chữ ký"
description: "Quản lý chữ ký điện tử (ảnh chữ ký, con dấu) để chèn vào mẫu biểu khi in hợp đồng và hóa đơn."
routes: ["/settings/signatures"]
permissions: [{module: templates, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Chữ ký

Trang **Chữ ký** là nơi bạn quản lý các mẫu chữ ký điện tử — ảnh chữ ký hoặc con dấu — để chèn vào **mẫu biểu** khi in ra (hợp đồng, hóa đơn). Mỗi chữ ký có thể được tạo theo ba cách: **Tải ảnh** lên, **Vẽ** trực tiếp, hoặc **Nhập text**. Chữ ký được cấu hình ở đây dùng chung cho toàn bộ tài khoản của bạn (không phân theo tòa nhà), giống như kho mẫu biểu — thay vì phải ký tay từng bản in, bạn cấu hình một lần rồi hệ thống chèn sẵn vào tài liệu.

::: info Điều kiện tiên quyết
Bạn cần quyền **Mẫu biểu** (xem) để mở trang này — cùng nhóm quyền với kho **Mẫu biểu**, vì chữ ký được coi là một loại tài liệu mẫu dùng chung cho cả tổ chức (không phân theo tòa nhà bạn được giao). Trang này **không có sẵn trong menu sidebar** — bạn truy cập bằng đường dẫn trực tiếp `/settings/signatures`. Chữ ký cấu hình xong sẽ được dùng khi in hợp đồng và hóa đơn thông qua mẫu biểu tương ứng.
:::

## Hướng dẫn từng bước

**Bước 1**: Mở trang bằng đường dẫn trực tiếp `/settings/signatures` trên trình duyệt (trang này chưa được gắn link trong menu **Cài đặt**, nên bạn cần gõ hoặc dán đường dẫn để vào).

![Màn hình](./images/buoc-01-man-hinh.webp)

**Bước 2**: Xem danh sách các chữ ký đã cấu hình. Mỗi dòng là một mẫu chữ ký với tên gọi và kiểu tạo (ảnh / vẽ tay / text) để bạn nhận diện khi chọn chèn vào tài liệu.

**Bước 3**: Chọn một trong ba cách tạo chữ ký ở đầu trang:
- **Tải ảnh** — tải lên một tệp ảnh chữ ký hoặc con dấu đã có sẵn (ví dụ ảnh scan chữ ký, con dấu tròn của công ty).
- **Vẽ** — vẽ chữ ký trực tiếp bằng chuột hoặc cảm ứng.
- **Nhập text** — gõ tên và chọn kiểu chữ (font) để tạo chữ ký dạng chữ.

**Bước 4**: Sau khi có chữ ký, chữ ký sẽ được chèn vào **bản in hợp đồng và hóa đơn** qua mẫu biểu tương ứng — bạn không cần ký tay lại trên từng bản in. Việc chọn mẫu biểu và in nằm ở kho **Mẫu biểu** cũng như ở màn hình in của từng hợp đồng / hóa đơn.

## Các tính năng khác trên màn hình

| Tính năng | Mô tả |
|-----------|-------|
| **Tải ảnh** | Tạo chữ ký bằng cách tải lên tệp ảnh chữ ký hoặc con dấu có sẵn. |
| **Vẽ** | Tạo chữ ký bằng cách vẽ tay trực tiếp trên màn hình. |
| **Nhập text** | Tạo chữ ký dạng chữ: nhập nội dung và chọn kiểu chữ. |
| Danh sách chữ ký | Liệt kê các mẫu chữ ký đã cấu hình để bạn xem lại và chọn chèn vào mẫu biểu. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|------------|------------|
| Không thấy trang **Chữ ký** trong menu **Cài đặt** | Trang này chưa được gắn link trong sidebar. Bạn truy cập bằng đường dẫn trực tiếp `/settings/signatures`. |
| Không mở được trang, hiện trống hoặc báo lỗi khi thao tác | Tài khoản của bạn chưa có quyền **Mẫu biểu** (xem). Nhờ chủ nhà cấp quyền trong phần phân quyền nhân viên. |
| Bấm **Tải ảnh** / **Vẽ** / **Nhập text** nhưng chưa lưu được chữ ký mới | Phần lưu chữ ký đang được hoàn thiện. Trong lúc chờ, bạn có thể chèn chữ ký/con dấu trực tiếp vào tệp mẫu `.docx` ở kho **Mẫu biểu** trước khi tải mẫu lên. |
| Chữ ký không xuất hiện trên bản in hợp đồng / hóa đơn | Kiểm tra lại mẫu biểu đang dùng để in ở kho **Mẫu biểu** — chữ ký được chèn qua mẫu biểu, nên mẫu phải có sẵn vị trí dành cho chữ ký. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/signatures" view-only>
Mở trang **Chữ ký** và xem các mẫu chữ ký đã cấu hình. Quan sát ba cách tạo chữ ký (**Tải ảnh** / **Vẽ** / **Nhập text**) và hình dung chữ ký này sẽ được chèn vào bản in hợp đồng, hóa đơn thông qua mẫu biểu tương ứng.
</SandboxTry>

## Quy trình liên quan

- [Mẫu biểu](/05-cai-dat/mau-bieu/) — kho mẫu hợp đồng, hóa đơn, biên bản mà chữ ký được chèn vào khi in
- [Cài đặt chung](/05-cai-dat/cai-dat-chung/) — các cấu hình hành vi hệ thống dùng chung
