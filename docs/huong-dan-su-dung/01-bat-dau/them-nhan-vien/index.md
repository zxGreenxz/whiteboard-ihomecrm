---
title: "Bước 6: Thêm nhân viên & phân quyền"
description: "Tạo tài khoản nhân viên, gán mẫu quyền và phạm vi toà nhà trên màn Phân quyền nhân viên."
routes: ["/settings/staff"]
permissions: [{module: users, action: view}]
viewport: desktop
audience: [chu-nha]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bước 6: Thêm nhân viên & phân quyền

Màn hình **Phân quyền nhân viên** là nơi bạn tạo tài khoản cho từng người trong đội, quyết định họ **làm được gì** (mẫu quyền) và **thấy được toà nào** (phạm vi). Đây là bước cuối của phần khởi tạo: khi đã có khu vực, toà, phòng, dịch vụ và sổ quỹ, bạn mở quyền cho nhân viên để họ bắt đầu vận hành. Dùng màn này mỗi khi tuyển người mới, đổi vai trò, hoặc thu hồi quyền của người nghỉ việc.

::: info Điều kiện tiên quyết
- Bạn đăng nhập bằng tài khoản **chủ nhà** hoặc tài khoản có quyền **Phân quyền nhân viên** (module `users`).
- Đã tạo trước ít nhất một [khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — cần có toà thì mới gán được phạm vi cho nhân viên quản lý theo toà.
- Chuẩn bị sẵn **tên đăng nhập** và **mật khẩu** cho từng nhân viên (họ sẽ đăng nhập bằng tên đăng nhập, không phải email).
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, mở **Cài đặt** => **Phân quyền nhân viên** (đường dẫn `/settings/staff`). Màn hình mở ra với 3 tab **Nhân viên**, **Đội ngũ**, **Mẫu phân quyền**; tab **Nhân viên** liệt kê những người đang có, mỗi thẻ hiện mẫu quyền, phạm vi toà và trạng thái quyền.

![Màn Phân quyền nhân viên với 3 tab và danh sách nhân viên demo](./images/buoc-01-danh-sach.webp)

**Bước 2**: Ở tab **Nhân viên**, ấn chọn **Thêm nhân viên**. Một bảng nhập trượt ra bên phải, gồm 4 phần điền lần lượt từ trên xuống.

**Bước 3**: Điền phần **Thông tin nhân viên**: **Tên đăng nhập**, **Mật khẩu** (tối thiểu 6 ký tự) và ô xác nhận mật khẩu, rồi **Họ tên**, **Số điện thoại**, **Email**, **Chức danh**. Nhân viên đăng nhập bằng đúng **tên đăng nhập** này; hệ thống tự sinh một email nội bộ để lưu, bạn không cần nhập email thật.

**Bước 4**: Ở phần **Cài đặt nhanh**, chọn **một mẫu phân quyền** làm điểm khởi đầu. Có 4 mẫu hệ thống: **Super Admin** (toàn quyền), **Quản Lý Tòa** (vận hành đầy đủ 1 hoặc nhiều toà), **Partner** (cộng tác viên, xem bất động sản + quản khách hẹn/cọc), **Viewer** (chỉ xem). Khi chọn mẫu, toàn bộ quyền của mẫu được **sao chép** vào nhân viên này — chỉnh sửa sau đó chỉ ảnh hưởng riêng người này, không đụng đến mẫu gốc hay nhân viên khác.

**Bước 5**: Ở phần **Phạm vi toà**, chọn nhân viên được thấy những toà nào. Có 3 cách:

- **Tất cả toà nhà** — tích ô này để nhân viên quản lý **mọi toà** hiện có và cả toà tạo sau này.
- **Theo khu vực (tự cập nhật)** — chọn một hoặc nhiều khu; nhân viên có quyền trên **mọi toà thuộc khu đó ngay tại thời điểm làm việc**. Sau này bạn thêm toà mới vào khu, toà đó **tự động** nằm trong phạm vi của nhân viên, không cần gán lại.
- **Toà lẻ bổ sung (cố định)** — tích từng toà cụ thể (ví dụ **Tòa DEMO A**, **Tòa DEMO B**). Phạm vi này cố định, chỉ đúng những toà bạn đã tích.

Bạn có thể trộn khu vực và toà lẻ. Phạm vi toà **độc lập** với quyền: một nhân viên có quyền sửa hợp đồng vẫn chỉ sửa được hợp đồng ở các toà mình được giao.

::: tip Theo-toà hay mọi-toà
Chọn **theo khu vực** hoặc **toà lẻ** khi bạn muốn nhân viên chỉ nhìn thấy phần việc của họ (giúp giao diện gọn và bảo mật dữ liệu toà khác). Chỉ mở **Tất cả toà nhà** cho kế toán tổng, quản lý cấp cao hay chính bạn.
:::

**Bước 6**: (Tuỳ chọn) Mở phần **Tinh chỉnh từng quyền** để bật/tắt quyền theo **từng trang** của hệ thống. Cột trái liệt kê các trang theo nhóm; chọn một trang, khung bên phải hiện từng chức năng của trang đó kèm mô tả. Chức năng có nhãn **Nhạy cảm** là thao tác cần cân nhắc. Nếu mẫu đã đủ dùng, bỏ qua bước này.

**Bước 7**: Ấn **Lưu**. Hệ thống tạo tài khoản, gắn mẫu quyền và phạm vi bạn vừa chọn; nhân viên mới xuất hiện thành một thẻ trong danh sách và có thể đăng nhập ngay bằng tên đăng nhập + mật khẩu đã đặt.

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| **Sửa** / **Sửa quyền** (trên thẻ nhân viên) | Mở lại bảng 4 phần để đổi thông tin, mẫu quyền, phạm vi toà hoặc tinh chỉnh từng quyền của nhân viên đó |
| **Xoá** (trên thẻ nhân viên) | Xoá hẳn tài khoản nhân viên và dữ liệu do người đó tạo (cascade) — xem cảnh báo bên dưới |
| Tab **Đội ngũ** | Gom nhân viên thành đội để họ **thấy tên nhau** và chỉ bàn giao tiền mặt được cho người **cùng đội** (hoặc cho chủ nhà). Đội này không thấy đội kia |
| Tab **Mẫu phân quyền** | Xem 4 mẫu hệ thống, **Tạo bản sao** để tự chỉnh, sửa/xoá các mẫu tự tạo (không xoá được mẫu đang có người dùng) |
| Badge phạm vi trên thẻ ("Tất cả toà" / "N toà") | Cho biết nhanh nhân viên đang quản lý bao nhiêu toà |
| Badge trạng thái quyền ("Khớp mẫu" / "N thay đổi so với mẫu" / "Bypass toàn quyền") | Cho biết quyền hiện tại có còn giống mẫu gốc hay đã được tinh chỉnh riêng |

::: warning Xoá nhân viên là thao tác khó hoàn tác
Nút **Xoá** xoá luôn tài khoản đăng nhập và dữ liệu người đó sở hữu (dây chuyền), không khôi phục được. Chỉ **chủ trực tiếp** đã gán nhân viên mới xoá được — nếu bạn là quản trị phụ, nút vẫn hiện nhưng thao tác sẽ bị từ chối. Nếu chỉ muốn ngừng cho đăng nhập tạm thời, cân nhắc tắt trạng thái hoạt động thay vì xoá.
:::

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Báo **"Nhân viên đã được gán cho toà nhà này"** | Nhân viên đó đã có phạm vi ở toà bạn vừa chọn. Bỏ tích toà trùng, hoặc mở **Sửa** để chỉnh phạm vi thay vì thêm mới |
| Tạo lại báo **tên đăng nhập đã được sử dụng** | Lần tạo trước có thể lỗi giữa chừng để lại tài khoản treo chiếm tên. Dùng **Xoá** để dọn tài khoản treo rồi tạo lại, hoặc chọn tên đăng nhập khác |
| Ấn **Xoá** nhưng không xoá được (bị từ chối) | Bạn không phải chủ trực tiếp đã gán nhân viên này. Nhờ chủ nhà thực hiện |
| Thẻ vẫn hiện **"N thay đổi so với mẫu"** dù bạn đã chỉnh quyền về đúng mẫu | Đây là điểm cần lưu ý của hệ thống: chỉnh quyền về khớp mẫu rồi lưu có thể không xoá hết dấu vết tinh chỉnh cũ. Nếu muốn nhân viên "sạch" theo mẫu, đổi sang mẫu khác rồi đổi lại, hoặc tạo lại theo mẫu |
| Nhân viên đăng nhập được nhưng **không thấy toà nào** | Phạm vi chưa được gán hoặc gán sai. Mở **Sửa** => **Phạm vi toà**, kiểm tra đã tích **Tất cả toà**, một **khu vực**, hoặc ít nhất một **toà lẻ** |
| Khi bàn giao tiền, nhân viên **không thấy tên đồng nghiệp** để chọn người nhận | Hai người chưa cùng đội. Vào tab **Đội ngũ**, tạo đội và thêm cả hai vào |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/staff" app-label="Mở màn Phân quyền nhân viên" fixtures="6 nhân viên demo" view-only>

**Quan sát trên sandbox**

1. Mở tab **Nhân viên** và nhìn danh sách 6 nhân viên demo — mỗi thẻ đều gắn **một mẫu quyền** kèm **badge phạm vi toà**.
2. Trên một nhân viên bất kỳ, ấn **Sửa quyền** và xem phần **Tinh chỉnh từng quyền**: chú ý cách quyền được liệt kê theo **từng trang** của hệ thống.
3. Chuyển sang tab **Mẫu phân quyền** và xem 4 mẫu hệ thống **Super Admin / Quản Lý Tòa / Partner / Viewer**.

**Bạn sẽ nhận ra**

- Mỗi nhân viên = **1 mẫu quyền** (làm được gì) **+ phạm vi toà** (thấy toà nào), và hai chiều này độc lập nhau.
- Tài khoản `demo.chunha` chỉ thao tác trong phạm vi **2 toà DEMO**, nên khi thử gán phạm vi bạn chỉ thấy **Tòa DEMO A** và **Tòa DEMO B**.

</SandboxTry>

## Quy trình liên quan

- [Bước 2: Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — cần có toà trước để gán phạm vi cho nhân viên.
- [Đăng nhập](/01-bat-dau/dang-nhap/) — cách nhân viên đăng nhập bằng tên đăng nhập vừa tạo.
- [Sandbox — Môi trường thực hành](/01-bat-dau/sandbox/) — danh sách tài khoản demo và cách reset dữ liệu.
