---
title: "Phương tiện"
description: "Quản lý xe của khách thuê: thêm/sửa/xoá xe theo loại, gắn xe với cư dân và phòng, ghi biển số, số vé và phí giữ xe."
routes: ["/vehicles"]
permissions: [{module: vehicles, action: view}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Phương tiện

Màn **Phương tiện** là nơi bạn quản lý xe của khách đang thuê: mỗi xe được gắn với một **cư dân** và một **phòng**, kèm **biển số**, **số vé xe** và **phí giữ xe**. Dùng màn này khi cần cấp vé gửi xe cho khách mới, tra nhanh "xe biển số này của phòng nào", hoặc cập nhật lại danh sách xe khi khách đổi phương tiện.

Xe được phân theo **loại** (xe máy, ô tô, xe đạp, xe điện, loại khác). Phí giữ xe ghi trên từng xe chính là phần **phí dịch vụ giữ xe** hiển thị lại trong hồ sơ cư dân — nhờ vậy bạn nắm được mỗi phòng đang gửi mấy xe và thu phí giữ xe bao nhiêu.

::: info Điều kiện tiên quyết
- Quyền **Phương tiện => Xem** (module `vehicles`, action `view`) để mở màn danh sách.
- Quyền **Thêm** / **Sửa** trên module `vehicles` nếu muốn thêm, sửa hoặc xoá xe.
- Đã có **cư dân** (khách thuê) và **phòng** trong hệ thống để gắn xe vào. Nếu chưa, tạo trước ở trang [Cư dân](/03-quan-ly-van-hanh/cu-dan/) và [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/).
- Là nhân viên, bạn chỉ thấy và quản lý được xe thuộc các **toà được gán phạm vi** cho mình; xe chưa gắn toà thì chỉ người quản lý toàn hệ thống mới sửa/xoá được.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, ấn chọn **Phương tiện**. Màn hiện danh sách xe kèm ô tìm kiếm; mỗi dòng cho biết **loại xe**, **dòng xe**, **màu**, **biển số**, **chủ xe / cư dân**, **phòng – toà** và **số vé xe**.

![Màn Phương tiện: danh sách xe với xe máy phòng A101 và ô tô phòng B101](./images/buoc-01-danh-sach.webp)

**Bước 2**: Dùng ô **tìm kiếm** ở đầu trang để tra nhanh theo **biển số**, **dòng xe**, **tên chủ xe** hoặc **tên cư dân**. Kết quả áp ngay vào danh sách. Ô tìm kiếm và các bộ lọc được giữ lại khi bạn tải lại trang (F5).

**Bước 3**: Muốn thêm xe, ấn **Thêm** để mở form. Điền các trường:
- **Loại xe** — chọn Xe máy / Ô tô / Xe đạp / Xe điện / Khác.
- **Dòng xe** (ví dụ "Honda Vision"), **Màu**, **Biển số**.
- **Chủ xe** — tên người đứng tên xe (có thể khác cư dân).
- **Số vé xe** — mã vé gửi xe bạn cấp cho khách.
- **Cư dân**, **Toà nhà**, **Phòng** — chọn để gắn xe vào đúng khách và đúng phòng.

Điền xong ấn **Lưu**. Xe mới xuất hiện ngay trong danh sách và trong tab **Phương tiện** ở trang chi tiết của cư dân.

**Bước 4**: Cần chỉnh, ấn **Sửa** trên dòng xe, đổi thông tin rồi ấn **Lưu**. Muốn bỏ một xe (khách trả xe, nhập nhầm…), ấn **Xoá** — xe được ẩn khỏi danh sách.

::: tip Phí giữ xe hiển thị ở hồ sơ cư dân
Mỗi xe có một **phí giữ xe** (`parking_fee`) — chính là phí dịch vụ giữ xe của xe đó. Con số này hiển thị trong tab **Phương tiện** ở trang chi tiết cư dân, giúp bạn biết mỗi khách đang gửi mấy xe và tổng phí giữ xe. Lưu ý ở bản hiện tại **ô phí giữ xe chưa nhập trực tiếp được từ form thêm/sửa xe** (form chỉ nhận loại xe, dòng xe, màu, biển số, chủ xe, số vé, cư dân/toà/phòng và ảnh). Nếu cần đặt/điều chỉnh phí giữ xe, xử lý qua dịch vụ giữ xe của phòng thay vì trông chờ nhập ở đây.
:::

::: warning Xoá xe khó khôi phục từ giao diện
Nút **Xoá** ẩn xe khỏi mọi danh sách (xoá mềm). Bản ghi vẫn còn trong hệ thống nhưng **giao diện không có nút khôi phục** — muốn có lại, bạn phải thêm mới thủ công. Trước khi xoá, hãy chắc chắn đúng xe cần bỏ; nếu chỉ đổi thông tin, dùng **Sửa** thay vì Xoá.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô tìm kiếm | Tìm xe theo **biển số**, **dòng xe**, **tên chủ xe** hoặc **tên cư dân**; áp ngay vào danh sách. |
| Bộ lọc **Toà nhà** | Lọc xe theo toà đang gửi. |
| Bộ lọc **Phòng** | Lọc xe theo phòng (gộp theo tên phòng; nhiều toà cùng số phòng sẽ gom chung một mục). |
| Bộ lọc **Dòng xe** / **Màu** | Lọc theo dòng xe hoặc màu; danh sách gợi ý lấy từ chính các xe đang có. |
| **Thêm** | Mở form tạo xe mới (chỉ hiện khi bạn có phạm vi quản lý và quyền thêm). |
| **Sửa** | Mở form chỉnh thông tin xe (hiện theo phạm vi toà của từng xe). |
| **Xoá** | Ẩn xe khỏi danh sách (xoá mềm). |

::: tip Lọc đủ loại xe trên bản điện thoại
Bản desktop tập trung quản lý **xe máy** và ẩn ô lọc theo loại xe. Nếu bạn cần lọc và xem đầy đủ các loại (ô tô, xe đạp, xe điện), hãy mở màn **Phương tiện** trên **bản điện thoại** — ở đó có đủ bộ lọc loại xe cùng toà và phòng.
:::

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy nút **Thêm** / **Nhập** | Bạn chưa được gán phạm vi toà nào hoặc thiếu quyền thêm xe. Nhờ quản trị gán phạm vi/quyền `vehicles` cho tài khoản. |
| Thấy xe nhưng không sửa/xoá được | Sửa/Xoá mở theo **toà của từng xe** — bạn chỉ thao tác được với xe thuộc toà mình phụ trách. Xe chưa gắn toà chỉ người quản lý toàn hệ thống mới sửa được. |
| Danh sách trống dù chắc chắn có xe | Kiểm tra ô tìm kiếm và bộ lọc còn dính giá trị cũ (bộ lọc giữ qua F5); hoặc do phạm vi toà: nhân viên chỉ thấy xe thuộc toà được gán. |
| Không lọc được đủ loại (ô tô/xe đạp/xe điện) | Bản desktop ẩn ô lọc loại xe và ưu tiên xe máy. Mở bản điện thoại để lọc đủ các loại xe. |
| Không nhập được **phí giữ xe** trong form | Đúng hiện trạng: form thêm/sửa xe chưa mở ô phí giữ xe. Phí giữ xe hiển thị ở hồ sơ cư dân; đặt/điều chỉnh qua dịch vụ giữ xe của phòng. |
| Nút **Xuất Excel** / **Nhập Excel** bấm không thấy gì | Hai nút này hiện chưa hoạt động (đang là bản dựng). Cứ thêm/sửa xe thủ công trong màn. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/vehicles" app-label="Mở màn Phương tiện" fixtures="xe máy phòng A101, ô tô phòng B101">

Thực hành quản lý xe và phí giữ xe:

1. Mở màn **Phương tiện** và xem 2 xe mẫu đang có: **xe máy** gắn phòng **A101** và **ô tô** gắn phòng **B101**. Để ý biển số, chủ xe và phòng – toà của từng xe.
2. Ấn **Thêm** để mở form. Chọn **Loại xe = Xe máy**, điền **Dòng xe** (ví dụ "Honda Wave"), **Biển số** giả (ví dụ "59X1-999.99"), rồi gắn **Phòng = A102** và cư dân của phòng đó.
3. Ấn **Lưu** và kiểm tra xe mới xuất hiện trong danh sách.
4. Mở trang chi tiết của cư dân phòng **A102** (mục Cư dân), vào tab **Phương tiện** và kiểm tra xe vừa thêm hiển thị ở đó kèm ô **phí giữ xe**.

Kết quả mong đợi: bạn quen với việc thêm/sửa xe, gắn xe với đúng cư dân và phòng, và biết phí giữ xe của mỗi xe được thể hiện lại trong hồ sơ cư dân.

</SandboxTry>

## Quy trình liên quan

- [Cư dân](/03-quan-ly-van-hanh/cu-dan/) — hồ sơ khách thuê; xe được gắn vào cư dân và hiện lại trong tab Phương tiện của hồ sơ.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — quản lý phòng, nơi gắn xe khi khách gửi xe.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — hợp đồng thuê của khách đứng tên xe.
