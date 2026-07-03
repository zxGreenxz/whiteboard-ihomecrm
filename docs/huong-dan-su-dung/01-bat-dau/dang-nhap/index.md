---
title: "Đăng nhập & khôi phục mật khẩu"
description: "Cách đăng nhập ptcrm bằng tên đăng nhập, số điện thoại hoặc email, dùng nút hiện/ẩn mật khẩu, ghi nhớ đăng nhập và khôi phục mật khẩu qua email."
routes: ["/login", "/forgot-password", "/reset-password", "/register"]
permissions: []
viewport: desktop
audience: [tat-ca]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Đăng nhập & khôi phục mật khẩu

Đây là cửa vào phần mềm ptcrm. Bạn dùng trang này mỗi khi bắt đầu phiên làm việc, hoặc khi cần đặt lại mật khẩu đã quên. Điểm cần nhớ: tài khoản **nhân viên** đăng nhập bằng **tên đăng nhập** (username) do quản lý cấp — không phải email — nên đừng bối rối nếu bạn không có email công ty.

::: info Điều kiện tiên quyết
- Một tài khoản đã được quản lý tạo sẵn (**tên đăng nhập** + **mật khẩu**). Đăng ký công khai đã đóng — bạn không tự tạo tài khoản được, hãy liên hệ quản lý.
- Để khôi phục mật khẩu qua email, tài khoản của bạn phải có **email thật** đã khai trong hồ sơ (không phải tên đăng nhập).
- Không cần quyền đặc biệt: trang đăng nhập mở cho tất cả.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại trang **Đăng nhập**, điền định danh của bạn vào ô **Tài Khoản**. Ô này nhận **3 kiểu**: tên đăng nhập (vd `nguyenvana`), số điện thoại (vd `0900 000 001`) hoặc email — nhập kiểu nào cũng vào đúng tài khoản đó.

![Màn hình đăng nhập với ô Tài Khoản, Mật khẩu, nút Đăng nhập và liên kết Quên mật khẩu](./images/buoc-01-man-hinh.webp)

**Bước 2**: Điền mật khẩu vào ô **Mật khẩu**. Ấn biểu tượng **con mắt** ở cuối ô để hiện/ẩn mật khẩu, giúp bạn kiểm tra đã gõ đúng chưa trước khi đăng nhập.

**Bước 3**: Nếu đây là máy cá nhân, tích **Ghi nhớ đăng nhập** để lần sau không phải nhập lại. Trên máy dùng chung, bỏ trống ô này.

**Bước 4**: Ấn **Đăng nhập**. Đăng nhập đúng sẽ đưa bạn vào **Bảng tin** (trang chủ), và giao diện tự hiển thị đúng những mục bạn được cấp quyền.

::: tip Nhân viên nhập tên đăng nhập, không phải email
Tài khoản nhân viên thường không gắn email công ty. Hệ thống tự nhận diện: nhập số 10–11 chữ số sẽ hiểu là số điện thoại, có ký tự `@` thì hiểu là email, còn lại hiểu là tên đăng nhập. Vì vậy chỉ cần nhập đúng thứ quản lý cấp cho bạn.
:::

### Khôi phục mật khẩu qua email

Chỉ dùng được khi tài khoản có email thật trong hồ sơ. Nếu bạn đăng nhập bằng tên đăng nhập và không nhớ email, hãy nhờ quản lý đặt lại giúp.

**Bước 1**: Ở trang đăng nhập, ấn liên kết **Quên mật khẩu?**.

**Bước 2**: Điền địa chỉ email của bạn rồi gửi. Hệ thống gửi một email chứa liên kết đặt lại mật khẩu.

**Bước 3**: Mở email, ấn liên kết trong đó — bạn được đưa tới trang **Đặt lại mật khẩu**.

**Bước 4**: Nhập mật khẩu mới (tối thiểu **8 ký tự**, có **chữ hoa, chữ thường và số**; thanh đo hiển thị độ mạnh), xác nhận lại rồi lưu. Sau đó quay về trang đăng nhập và vào bằng mật khẩu mới.

::: warning Liên kết đặt lại có hạn dùng
Liên kết trong email chỉ hiệu lực trong thời gian ngắn. Nếu trang **Đặt lại mật khẩu** báo "Link không hợp lệ", hãy quay lại bước **Quên mật khẩu?** để xin liên kết mới thay vì dùng lại liên kết cũ.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| Ô **Tài Khoản** | Nhập một trong ba: tên đăng nhập, số điện thoại (10–11 số) hoặc email. |
| Biểu tượng **con mắt** (trong ô Mật khẩu) | Bật/tắt hiển thị mật khẩu để kiểm tra ký tự đã gõ. |
| **Ghi nhớ đăng nhập** | Giữ phiên đăng nhập cho lần sau trên máy tin cậy. |
| **Đăng nhập** | Xác thực và vào Bảng tin. |
| **Quên mật khẩu?** | Mở luồng gửi email đặt lại mật khẩu. |
| **Đăng ký ngay** | Đăng ký công khai đã đóng — liên kết chỉ dẫn tới trang thông báo liên hệ quản lý. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Báo sai tài khoản hoặc mật khẩu | Kiểm tra lại đúng kiểu định danh (tên đăng nhập / SĐT / email) và mật khẩu; ấn con mắt để xem mật khẩu đã gõ. Thông báo lỗi gộp cả ba kiểu định danh nên không chỉ rõ sai ở đâu. |
| Nhân viên cố đăng nhập bằng email nhưng không được | Tài khoản nhân viên đăng nhập bằng **tên đăng nhập** quản lý cấp, không phải email cá nhân. Dùng đúng tên đăng nhập. |
| Không nhận được email đặt lại mật khẩu | Kiểm tra hộp thư rác; xác nhận tài khoản có email thật trong hồ sơ. Nếu tài khoản chỉ có tên đăng nhập, nhờ quản lý đặt lại giúp. |
| Trang **Đặt lại mật khẩu** báo "Link không hợp lệ" | Liên kết đã hết hạn hoặc đã dùng — xin liên kết mới ở **Quên mật khẩu?**. |
| Mật khẩu mới bị từ chối | Đặt tối thiểu 8 ký tự, có đủ chữ hoa, chữ thường và số. |
| Muốn có tài khoản mới nhưng chỉ thấy trang liên hệ | Đăng ký công khai đã đóng; tài khoản do quản lý tạo trong mục Thêm nhân viên. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/login" app-label="Mở trang Đăng nhập" view-only>

Đăng nhập thử bằng một tài khoản demo bất kỳ ở trang Sandbox, rồi quan sát giao diện đổi theo quyền:

- Bạn sẽ **nhìn thấy** ô **Tài Khoản**, ô **Mật khẩu** kèm nút con mắt hiện/ẩn, ô **Ghi nhớ đăng nhập** và nút **Đăng nhập**.
- Sau khi vào, để ý menu và các mục hiển thị **khác nhau** giữa tài khoản Quản lý và tài khoản nhân viên — đúng nguyên tắc "ai được cấp quyền gì thì thấy nấy".

</SandboxTry>

## Quy trình liên quan

- [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/) — hiểu tổng quan trước khi đăng nhập.
- [Làm quen giao diện](/01-bat-dau/lam-quen-giao-dien/) — điều bạn thấy ngay sau khi đăng nhập.
- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/) — nơi quản lý tạo tên đăng nhập và mật khẩu cho nhân viên.
- [Bảng tin](/02-theo-doi-nhanh/bang-tin/) — trang chủ mở ra sau khi đăng nhập thành công.
