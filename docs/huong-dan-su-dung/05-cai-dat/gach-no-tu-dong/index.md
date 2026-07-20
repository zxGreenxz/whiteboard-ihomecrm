---
title: "Gạch nợ tự động"
description: "Cấu hình quy tắc tự động cấn trừ tiền chuyển khoản ngân hàng vào công nợ hoá đơn cũ."
routes: ["/settings/categories/auto-debt"]
permissions: [{module: auto_debt, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Gạch nợ tự động

Màn hình này để bạn khai báo **tài khoản ngân hàng dùng đối soát** và bật quy tắc gạch nợ. Khi đã bật, hệ thống tự nhận diện tiền chuyển khoản đổ về tài khoản đó rồi **cấn trừ vào công nợ hoá đơn cũ** của khách — bạn không phải mở từng hoá đơn để thu tay. Trang này **chỉ lưu cấu hình**; việc đối soát và tạo phiếu thu thực tế chạy ở một pipeline nền riêng, không diễn ra ngay trên màn hình này.

::: info Điều kiện tiên quyết
- Tài khoản có quyền xem/quản lý **Gạch nợ tự động** (module `auto_debt`) và vào được **Cài đặt** => **Danh mục khác**.
- Bạn cần biết **số tài khoản ngân hàng** thật dùng để nhận tiền khách (đúng số TK đang đối soát ở sổ quỹ ngân hàng).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Danh mục khác** => **Gạch nợ tự động** để mở màn hình cấu hình.

**Bước 2**: Ở góc trên bên phải, ấn nút **Thêm mới**. Hộp thoại **Thêm mới** hiện ra.

**Bước 3**: Nhập **Tài khoản ngân hàng** — số tài khoản mà hệ thống sẽ theo dõi để nhận diện tiền khách chuyển vào (ô bắt buộc, có dấu `*`).

::: danger Bật gạch nợ = cho phép hệ thống tự ghi nhận tiền
Khi bạn tích **Kích hoạt** (**Bật gạch nợ tự động**), mọi khoản chuyển khoản khớp luật sẽ được **tự động cấn vào công nợ và đánh dấu hoá đơn đã thanh toán** mà không cần thao tác thu tay. Chỉ bật khi số tài khoản đã đúng và bạn muốn hệ thống tự chạy.
:::

**Bước 4**: Tích ô **Kích hoạt** (nhãn **Bật gạch nợ tự động**) nếu muốn quy tắc chạy ngay; bỏ trống nếu chỉ muốn lưu để dùng sau.

**Bước 5**: Ấn **Thêm mới** để lưu. Xuất hiện thông báo *"Cấu hình gạch nợ tự động đã được tạo thành công"* và dòng mới hiện trong bảng, cột **Trạng thái** hiển thị **Đang bật** hoặc **Đã tắt**.

::: warning Sửa / tắt / xoá đều có hiệu lực ngay
Dùng biểu tượng **bút chì** để mở **Cập nhật** (đổi số TK hoặc bật/tắt), biểu tượng **thùng rác** để mở **Xác nhận xóa**. Tắt hoặc xoá một cấu hình sẽ ngừng gạch nợ cho tài khoản đó; các phiếu thu đã sinh trước đó không bị gỡ theo.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| **Thêm mới** | Mở hộp thoại tạo một cấu hình gạch nợ mới. |
| Ô **Tài khoản ngân hàng** | Số tài khoản hệ thống theo dõi để nhận diện tiền chuyển vào (bắt buộc). |
| Ô tích **Kích hoạt** (**Bật gạch nợ tự động**) | Bật/tắt quy tắc cho riêng tài khoản đó. |
| Cột **Trạng thái** (**Đang bật** / **Đã tắt**) | Cho biết cấu hình đang chạy hay đang tạm dừng. |
| Biểu tượng **bút chì** | Mở **Cập nhật** để sửa số TK hoặc trạng thái. |
| Biểu tượng **thùng rác** | Mở **Xác nhận xóa** để gỡ cấu hình. |
| **Quay lại Danh mục khác** | Trở về trang **Danh mục khác** trong Cài đặt. |

## Tình huống & lỗi thường gặp

| Tình huống | Nguyên nhân & cách xử lý |
|---|---|
| Đã lưu nhưng hoá đơn chưa tự gạch nợ | Việc đối soát chạy ở pipeline nền riêng, không tức thời trên trang này. Kiểm tra **Trạng thái** phải là **Đang bật** và số tài khoản khớp đúng TK nhận tiền thực. |
| Trạng thái vẫn hiện **Đã tắt** | Chưa tích **Kích hoạt** khi lưu. Bấm **bút chì** => tích **Bật gạch nợ tự động** => **Cập nhật**. |
| Không lưu được, báo thiếu thông tin | Ô **Tài khoản ngân hàng** bắt buộc — không được để trống. |
| Thông báo *"Không thể tạo cấu hình gạch nợ tự động"* | Thiếu quyền hoặc mất kết nối. Kiểm tra quyền module `auto_debt`, đăng nhập lại rồi thử lại. |
| Gạch nợ nhầm sang tài khoản khác | Mỗi số TK chỉ nên có **một** dòng cấu hình; xoá dòng trùng để tránh khớp hai lần. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/settings/categories/auto-debt" view-only>

**Bài xem**

Xem quy tắc gạch nợ tự động: mở danh sách cấu hình, quan sát cột **Tài khoản ngân hàng** và cột **Trạng thái** (**Đang bật** / **Đã tắt**). Bấm biểu tượng **bút chì** một dòng để xem hộp thoại **Cập nhật** với ô **Tài khoản ngân hàng** và ô tích **Bật gạch nợ tự động** — chỉ xem, không cần lưu.

</SandboxTry>

## Quy trình liên quan

- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
