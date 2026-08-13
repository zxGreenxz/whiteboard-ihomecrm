---
title: "Thông báo"
description: "Trung tâm thông báo cá nhân: lọc loại, đánh dấu đọc, điều hướng an toàn và xoá theo quyền."
routes: ["/notifications"]
permissions: [{module: notifications, action: view}, {module: notifications, action: delete}]
viewport: desktop
audience: [tat-ca]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Thông báo

Route `/notifications` yêu cầu đăng nhập và `notifications.view`. Query chỉ lấy tối đa 200 thông báo IN_APP của chính user hiện tại; nhân viên không “xem thông báo của chủ nhà”. Chuông và trang đầy đủ cập nhật theo Realtime của từng user.

::: info Điều kiện tiên quyết
- `notifications.view` để mở trang.
- Đánh dấu đọc áp dụng cho thông báo của chính bạn. Xoá cần capability/policy tương ứng; catalog khai báo `notifications.delete`.
- Web Push cần trình duyệt hỗ trợ và người dùng cho phép; trên iPhone thường cần cài web app vào màn hình chính.
:::

## Hướng dẫn

**Bước 1**: Mở **Quản lý & Vận hành** => **Thông báo**, hoặc nhấn chuông rồi **Xem tất cả**.

![Màn Thông báo với danh sách các thông báo hệ thống](./images/buoc-01-danh-sach.webp)

**Bước 2**: Chọn tab **Tất cả** / **Chưa đọc**, sau đó chọn chip loại. Chip không có dòng dữ liệu sẽ tự ẩn; khi loại đó xuất hiện, chip tự hiện lại.

Các loại hiện được UI hỗ trợ gồm: **Chờ tôi xử lý**, **Kết quả duyệt**, **Nhắc thanh toán**, **Quá hạn**, **Hợp đồng hết hạn**, **Thiếu cọc**, **Thưởng/Lương**, **Hoá đơn mới**, **Công việc**, **Thông báo chung** và **Thông báo tuỳ chỉnh**.

**Bước 3**: Nhấn một thông báo để đánh dấu đã đọc và mở đích liên quan. `metadata.url` được kiểm tra capability trước; nếu đích không mở được, router hạ về trang an toàn. Route cũ `/issues/:id` đã bị loại bỏ.

**Bước 4**: Dùng **Đánh dấu đã đọc** để chuyển toàn bộ thông báo chưa đọc của bạn sang READ.

**Bước 5**: Dùng nút X hoặc **Xoá đã đọc** khi có quyền. Xoá là vĩnh viễn và chỉ tác động dòng của chính user.

## Bộ sinh nhắc định kỳ

Hook định kỳ chạy cho **user đang đăng nhập**, không giới hạn chủ nhà. Nó thử chạy khi app mount, dùng localStorage để chặn thực thi dày hơn khoảng **20 giờ**, đồng thời giữ interval 6 giờ làm lưới an toàn cho tab mở qua ngày. Vì vậy không nên kỳ vọng cứ 6 giờ chắc chắn tạo một thông báo mới; từng loại nhắc còn có logic chống trùng riêng.

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Không thấy chip một loại thông báo | Chip có số lượng 0 được ẩn; chuyển về **Tất cả** và chờ dữ liệu loại đó phát sinh. |
| Không thấy chip **Thiếu cọc** | UI hiện đã có chip riêng; nếu không thấy nghĩa là chưa có dòng thiếu cọc hoặc bộ lọc đang lưu giá trị khác. |
| Nhấn thông báo nhưng về `/my-day` | Đích metadata không được phép hoặc không còn route; hệ thống fallback an toàn. |
| Xoá bị từ chối | Kiểm tra `notifications.delete` và policy dữ liệu; `notifications.view` không tự bao gồm quyền xoá. |
| Không thấy nhắc mới ngay | Bộ scheduler tối đa khoảng một lần/ngày/user và có chống trùng; kiểm tra điều kiện hợp đồng/hoá đơn thực tế. |
| Chuông không cập nhật | Realtime có thể mất kết nối; tải lại trang. Web Push và chuông trong app là hai kênh khác nhau. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/notifications" app-label="Mở Thông báo" view-only>

Quan sát danh sách của chính `demo.quanly`, chuyển giữa Tất cả/Chưa đọc và các chip đang có dữ liệu. Không xoá hàng loạt trong bài quan sát vì sandbox dùng chung.

</SandboxTry>

## Quy trình liên quan

- [Bảng tin](/02-theo-doi-nhanh/bang-tin/)
- [Việc của tôi](/02-theo-doi-nhanh/viec-cua-toi/)
- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/)
