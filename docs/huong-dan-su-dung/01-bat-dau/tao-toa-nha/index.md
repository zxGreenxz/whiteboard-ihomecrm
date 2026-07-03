---
title: "Bước 1: Tạo khu vực & toà nhà"
description: "Tạo khu vực để nhóm toà và thêm toà nhà mới với tên, mã, địa chỉ và cấu hình mặc định."
routes: ["/buildings"]
permissions: [{module: buildings, action: create}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bước 1: Tạo khu vực & toà nhà

Toà nhà là đơn vị trung tâm của cả hệ thống: mọi hợp đồng, hoá đơn, công tơ, sổ quỹ và báo cáo sau này đều gắn với một toà. Đây là việc đầu tiên bạn làm khi khởi tạo dữ liệu — tạo **khu vực** (nhãn nhóm các toà theo địa bàn) rồi **thêm từng toà nhà**. Bạn quay lại màn hình này mỗi khi tiếp nhận thêm một toà mới để vận hành.

::: info Điều kiện tiên quyết
- Tài khoản có quyền **Tạo toà nhà** (module `buildings`) — thực tế chỉ chủ nhà / người có phạm vi toàn hệ thống mới tạo được khu vực và toà.
- Chưa cần dữ liệu nào khác: đây là bước khởi tạo đầu tiên, tầng/phòng và dịch vụ sẽ thêm ở các bước sau.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại thanh menu bên trái, ấn chọn **Danh mục** => **Toà nhà** để mở màn hình danh sách toà. Bạn thấy 3 thẻ thống kê (**Tất cả** / **Đang hoạt động** / **Ngừng**), ô tìm kiếm, và bảng liệt kê các toà hiện có.

![Màn hình danh sách Toà nhà với thẻ thống kê, ô tìm kiếm và các nút Thêm, Quản lý khu vực](./images/buoc-01-danh-sach.webp)

**Bước 2**: Ấn nút **Quản lý khu vực** trên thanh công cụ. Trong hộp thoại vừa mở, điền tên vào ô **Tên khu vực mới** (ví dụ "Khu Trung Tâm") rồi ấn **Thêm**. Khu vực mới hiện thành một thẻ trong danh sách; mỗi khu chỉ cần một cái tên, không có ô mã hay mô tả.

::: tip Khu vực là nhãn nhóm, không bắt buộc
Một toà có thể thuộc **nhiều khu vực** cùng lúc (ví dụ vừa "Nhà cũ" vừa "Thang bộ"). Khu vực chỉ dùng để nhóm và lọc cho gọn — bạn có thể tạo toà trước, gán vào khu sau. Việc gán/bỏ toà khỏi khu cũng làm ngay trong hộp thoại **Quản lý khu vực** này.
:::

**Bước 3**: Đóng hộp thoại khu vực, quay lại danh sách và ấn nút **Thêm** để mở form tạo toà. Hộp thoại **Toà nhà** hiện ra với các khối: thông tin cơ bản và địa chỉ, **Dịch vụ toà nhà**, **Cấu hình**, và **Hoa hồng môi giới**.

![Form Toà nhà với các khối Thông tin địa chỉ, Dịch vụ toà nhà, Cấu hình và Hoa hồng môi giới](./images/buoc-02-form-toa.webp)

**Bước 4**: Điền thông tin toà. Các trường bắt buộc gồm **tên toà**, **tỉnh/thành**, **quận/huyện** và **phường/xã**; **mã toà** và **địa chỉ chi tiết** là tuỳ chọn. Bạn có thể nhập nhiều mã cách nhau bởi dấu phẩy để khớp khi tạo công việc nhanh sau này. Ô **Tổng số phòng** hệ thống tự đếm — không nhập tay.

**Bước 5**: (Tuỳ chọn) Mở khối **Dịch vụ toà nhà** để bật các dịch vụ áp cho toà; khối **Cấu hình** để chọn mẫu hoá đơn / hợp đồng và **sổ quỹ mặc định**; khối **Hoa hồng môi giới** để đặt bậc hoa hồng theo số tháng hợp đồng. Xong thì ấn **Lưu**. Toà mới xuất hiện ngay đầu bảng danh sách.

::: tip Sổ quỹ mặc định (TT / TK) — chỉ chủ nhà thấy
Hai ô sổ quỹ mặc định trong khối **Cấu hình** quyết định tiền sẽ vào sổ nào khi khách thanh toán hoá đơn phòng bằng tiền mặt/thanh toán (**TT**) hay chuyển khoản (**TK**). Chọn đúng ngay từ đầu để các phiếu thu sau này ghi vào đúng sổ. Hai ô này chỉ chủ nhà nhìn thấy và sửa được; nếu bạn để trống lúc này, có thể bổ sung sau bằng nút **Sửa**.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| **Sửa** (biểu tượng bút chì trên dòng toà) | Mở lại form **Toà nhà** để chỉnh tên, địa chỉ, dịch vụ, cấu hình sổ quỹ, hoa hồng. |
| **Xoá** (biểu tượng thùng rác) | Xoá toà (xoá mềm — toà biến khỏi danh sách nhưng dữ liệu lịch sử vẫn giữ). |
| **In** | In danh sách toà nhà đang hiển thị. |
| Chuyển **Dạng lưới / Dạng danh sách** | Đổi cách hiển thị giữa lưới thẻ và bảng danh sách cho dễ nhìn. |
| Ô tìm kiếm | Tìm nhanh theo **tên**, **mã** hoặc **địa chỉ** toà. |
| Bộ lọc **trạng thái** | Lọc theo Đang hoạt động / Ngừng (gõ để tìm trong danh sách chọn). |
| Bộ lọc **toà nhà** | Chọn xem đúng **1 toà** hoặc **Tất cả toà nhà**; danh sách xếp phẳng A→Z. |
| Cột **sổ quỹ mặc định (TT / TK)** | Hiển thị sổ quỹ gắn cho từng toà — chỉ chủ nhà thấy cột này. |
| Toggle trạng thái trên dòng | Bật/tắt nhanh Đang hoạt động ↔ Ngừng ngay tại bảng, không cần mở form. |

::: warning Xoá toà là hành động khó hoàn tác
Nút **Xoá** ẩn toà khỏi danh sách. Chỉ xoá khi chắc chắn toà không còn được dùng. Nếu toà đang là phạm vi làm việc của nhân viên hoặc còn phòng/hợp đồng hoạt động, hãy xử lý các dữ liệu đó trước.
:::

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Không thấy nút **Thêm** hoặc **Quản lý khu vực** | Tài khoản của bạn có phạm vi theo-toà nên không được tạo mới. Cần chủ nhà (phạm vi toàn hệ thống) tạo toà, sau đó gán bạn vào toà đó. |
| Bấm **Lưu** báo "Mã tòa nhà đã tồn tại" | Đây chỉ là nhắc nhở của giao diện — mã toà **không bắt buộc duy nhất**, nếu muốn bạn vẫn có thể đổi mã cho rõ ràng rồi lưu lại. |
| Không lưu được, báo thiếu địa chỉ | **Tỉnh/thành, quận/huyện, phường/xã** là bắt buộc — điền đủ cả ba mới lưu được. |
| Danh sách trống dù đã tạo toà | Kiểm tra bộ lọc **toà nhà** hoặc **trạng thái** còn đang lọc; hoặc tài khoản không có quyền xem toà đó (màn hình hiện "Chưa có dữ liệu" thay vì báo lỗi quyền). |
| **Tổng số phòng** hiển thị 0 | Bình thường với toà mới — số này tự tăng khi bạn thêm phòng ở bước sau, không nhập tay. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/buildings" app-label="Mở màn hình Toà nhà" fixtures="Tòa DEMO A, Tòa DEMO B">

**Bài tập thực hành**

1. Ấn nút **Quản lý khu vực** và tìm khu **KV DEMO** trong danh sách — xem những toà nào đang thuộc khu này.
2. Đóng hộp thoại, ấn nút **Thêm** để mở form tạo toà. Xem qua các trường: tên toà, mã, tỉnh/quận/phường, địa chỉ (không cần lưu).

**Kết quả mong đợi**

- Bạn nhận ra khu **KV DEMO** đang nhóm **Tòa DEMO A** và **Tòa DEMO B**.
- Bạn nắm được các trường **bắt buộc** khi tạo một toà: tên toà và bộ ba địa chỉ tỉnh/quận/phường.

::: tip Sandbox demo không lưu được toà mới
Tài khoản `demo.chunha` có phạm vi theo-toà nên **không tạo được toà mới** — bài tập này chỉ để bạn xem form và làm quen các trường, không cần bấm **Lưu**.
:::

</SandboxTry>

## Quy trình liên quan

- [Tạo tầng & phòng](/01-bat-dau/tao-tang-phong/) — bước tiếp theo: thêm phòng cho toà vừa tạo.
- [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/) — thiết lập dịch vụ để bật cho từng toà trong khối **Dịch vụ toà nhà**.
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — tạo sổ quỹ trước để gán làm sổ mặc định (TT/TK) cho toà.
- [Toà nhà](/03-quan-ly-van-hanh/toa-nha/) — quản lý và tra cứu toà trong vận hành hằng ngày.
