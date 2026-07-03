---
title: "Quản trị người dùng (super admin)"
description: "Trang cấp nền tảng để super admin tạo tài khoản qua Admin API — tài khoản demo không truy cập được, chỉ tham khảo."
routes: ["/admin/users"]
permissions: [{module: users, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Quản trị người dùng (super admin)

Màn hình **Quản lý tài khoản** (đường dẫn `/admin/users`) là trang quản trị **cấp nền tảng**: nơi **super admin** — người vận hành hệ thống ở tầng cao nhất — tạo trực tiếp tài khoản đăng nhập mới bằng **email + mật khẩu** và xem nhanh toàn bộ danh sách người dùng. Đây **không** phải màn quản lý nhân viên hằng ngày của chủ nhà; việc gán mẫu quyền và phạm vi toà cho từng người vẫn làm ở màn **Phân quyền nhân viên**. Trang này chỉ tạo "vỏ" tài khoản, còn quyền hạn thì cấp ở bước sau.

::: warning Trang này bị giới hạn — chỉ để tham khảo
Chỉ tài khoản **super admin** (được cấp ở tầng nền tảng) mới mở được `/admin/users`. **Tài khoản demo và phần lớn tài khoản chủ nhà thông thường KHÔNG có quyền này**: khi bấm vào đường dẫn, hệ thống tự chặn và **chuyển bạn về Bảng tin**. Vì vậy trang này chỉ mang tính tham khảo — để bạn biết super admin làm gì ở đây và khác gì với màn Phân quyền nhân viên mà bạn dùng thường ngày.
:::

::: info Điều kiện tiên quyết
- Tài khoản của bạn phải là **super admin** ở tầng nền tảng (nằm trong danh sách bypass toàn hệ thống). Chủ nhà thường và nhân viên **không** thoả điều kiện này.
- Nếu mục tiêu của bạn chỉ là **thêm nhân viên và phân quyền** cho đội của mình, hãy dùng màn [Phân quyền nhân viên](/01-bat-dau/them-nhan-vien/) (`/settings/staff`) thay cho trang này.
:::

## Hướng dẫn từng bước

> Các bước dưới đây mô tả thao tác của **super admin**. Với tài khoản demo, mở đường dẫn sẽ bị chuyển về Bảng tin nên bạn chỉ đọc để hiểu quy trình.

**Bước 1**: Mở đường dẫn `/admin/users`. Nếu tài khoản đủ quyền, màn **Quản lý tài khoản** hiện ra: phía trên là tiêu đề kèm dòng nhắc "Chỉ super_admin có quyền truy cập", bên phải là nút **Tạo tài khoản**; phía dưới là thẻ **Danh sách tài khoản** liệt kê mọi người dùng trong hệ thống.

**Bước 2**: Ấn nút **Tạo tài khoản**. Một hộp thoại **Tạo tài khoản mới** trượt ra với các ô nhập.

**Bước 3**: Điền thông tin tài khoản:

- **Email** (bắt buộc) — đây là **email thật** dùng để đăng nhập. Khác với màn Phân quyền nhân viên (nơi nhân viên đăng nhập bằng **tên đăng nhập** và hệ thống tự sinh email nội bộ), ở trang này bạn nhập trực tiếp một địa chỉ email.
- **Mật khẩu** (bắt buộc, tối thiểu 6 ký tự).
- **Họ tên** (tuỳ chọn) — tên hiển thị.
- **Số điện thoại** (tuỳ chọn).

**Bước 4**: Ấn **Tạo**. Tài khoản được tạo qua Admin API và **kích hoạt ngay** — người dùng có thể đăng nhập lập tức. Tài khoản mới xuất hiện trong danh sách với vai trò **Chưa gán** (vì chưa có mẫu quyền và phạm vi toà nào).

**Bước 5**: Sang màn [Phân quyền nhân viên](/01-bat-dau/them-nhan-vien/) để **gán mẫu quyền** (Super Admin / Quản Lý Tòa / Partner / Viewer) và **phạm vi toà** cho tài khoản vừa tạo. Chừng nào chưa gán, người dùng đăng nhập được nhưng **không thấy dữ liệu nghiệp vụ nào** — vì quyền và phạm vi mới là thứ quyết định họ thấy gì, sửa được gì.

::: warning Tài khoản tạo ở đây rất "mạnh" và cần phân quyền ngay
Trang này tạo tài khoản đăng nhập ở tầng nền tảng và **không** tự đặt phạm vi toà. Nếu sau đó bạn (hoặc super admin) gán nhầm mẫu **Super Admin**, tài khoản sẽ có toàn quyền, bypass mọi giới hạn toà. Hãy luôn hoàn tất bước gán quyền ở màn Phân quyền nhân viên và chọn đúng mẫu tối thiểu cần thiết.
:::

## Các tính năng khác trên màn hình

| Nút / Thành phần | Công dụng |
|---|---|
| **Tạo tài khoản** | Mở hộp thoại tạo tài khoản mới bằng Email + Mật khẩu (+ Họ tên, SĐT) |
| Thẻ **Danh sách tài khoản (N)** | Bảng liệt kê mọi người dùng: **Họ tên**, **Email**, **SĐT**, **Vai trò**, **Toà nhà được giao**, **Tạo lúc** |
| Cột **Vai trò** — badge **Super admin** | Người dùng nằm trong danh sách bypass toàn hệ thống |
| Cột **Vai trò** — badge **Staff** | Người dùng đã được gán ít nhất một phạm vi làm việc (có bản ghi phân công) |
| Cột **Vai trò** — badge **Chưa gán** | Tài khoản đã tạo nhưng chưa có mẫu quyền / phạm vi toà nào — cần sang Phân quyền nhân viên để cấp |
| Cột **Toà nhà được giao** | Số phạm vi phân công của người đó (0 nghĩa là chưa gán toà) |

## Tình huống & lỗi thường gặp

| Tình huống | Nguyên nhân & cách xử lý |
|---|---|
| Mở `/admin/users` liền bị **chuyển về Bảng tin** | Tài khoản của bạn không phải super admin. Đây là giới hạn cố ý. Nếu chỉ cần thêm nhân viên, dùng màn [Phân quyền nhân viên](/01-bat-dau/them-nhan-vien/) |
| Tạo tài khoản xong nhưng người đó **không thấy dữ liệu gì** | Bình thường: tài khoản mới ở trạng thái **Chưa gán**. Sang Phân quyền nhân viên gán **mẫu quyền** + **phạm vi toà** thì họ mới vận hành được |
| Băn khoăn nên nhập **email** hay **tên đăng nhập** | Ở trang này người dùng đăng nhập bằng **email thật** vừa nhập. Nếu bạn muốn nhân viên đăng nhập bằng **tên đăng nhập**, hãy tạo họ ở màn Phân quyền nhân viên thay vì đây |
| Không thấy nút **Tạo tài khoản** hoặc cả trang trống | Trình duyệt vẫn đang ở tài khoản không đủ quyền. Chỉ super admin mới thấy nội dung trang |
| Muốn **xoá** một tài khoản đã tạo | Việc xoá tài khoản nhân viên thực hiện ở màn [Phân quyền nhân viên](/01-bat-dau/them-nhan-vien/) (nút **Xoá** trên thẻ nhân viên); thao tác này khó hoàn tác vì xoá luôn dữ liệu người đó sở hữu |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/admin/users" app-label="Mở trang Quản trị người dùng" view-only>

**Quan sát trên sandbox**

1. Mở đường dẫn `/admin/users` bằng tài khoản demo.
2. Chú ý điều xảy ra ngay sau đó.

**Bạn sẽ nhận ra**

- Trang này cần quyền **super admin** — tài khoản demo mở sẽ **bị chuyển về Bảng tin**. Đây là giới hạn của sandbox (và cũng đúng như trên hệ thống thật).
- Muốn thực hành tạo tài khoản và phân quyền, hãy dùng màn [Phân quyền nhân viên](/01-bat-dau/them-nhan-vien/) — nơi tài khoản `demo.chunha` thao tác được trong phạm vi **2 toà DEMO**.

</SandboxTry>

## Quy trình liên quan

- [Bước 6: Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/) — màn Phân quyền nhân viên (`/settings/staff`) mà chủ nhà dùng thường ngày để tạo tài khoản, gán mẫu quyền và phạm vi toà.
- [Sandbox — Môi trường thực hành](/01-bat-dau/sandbox/) — danh sách tài khoản demo và cách reset dữ liệu.
