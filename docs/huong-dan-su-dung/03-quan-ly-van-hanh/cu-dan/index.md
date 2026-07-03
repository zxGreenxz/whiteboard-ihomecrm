---
title: "Cư dân — danh sách & hồ sơ"
description: "Tra cứu, tạo và quản lý hồ sơ cư dân/khách hàng: loại khách, trạng thái, CCCD, liên hệ, phương tiện và nhập hàng loạt từ Excel."
routes: ["/customers", "/customers/new"]
permissions: [{module: customers, action: view}]
viewport: desktop
audience: [quan-ly-toa, sale]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Cư dân — danh sách & hồ sơ

Màn **Cư dân** là nơi bạn lưu và tra cứu hồ sơ đầy đủ của khách hàng đứng tên hợp đồng: thông tin cá nhân hoặc tổ chức, giấy tờ tuỳ thân (CCCD/CMND/Hộ chiếu), địa chỉ, liên hệ và phương tiện. Đây là **nguồn danh tính** của cả hệ thống — mọi hợp đồng, cọc và hoá đơn đều quy về một hồ sơ ở màn này. Dùng màn này khi cần thêm khách mới trước lúc ký hợp đồng, tìm nhanh một hồ sơ, cập nhật giấy tờ hoặc nhập một loạt khách từ file Excel.

::: info Điều kiện tiên quyết
- Quyền **Cư dân => Xem** (module `customers`, action `view`) để mở màn danh sách.
- Cần quyền **Thêm** để tạo hồ sơ mới, **Nhập** để nhập từ Excel, **Xuất/In** cho các thao tác tương ứng.
- Nếu bạn là nhân viên, cần được gán ít nhất một toà (phạm vi) thì nút **Thêm** và **Nhập Excel** mới hiện.
- Muốn quét QR CCCD tự điền hồ sơ thì cần ảnh mã QR mặt sau thẻ CCCD gắn chip (chỉ áp dụng cho khách **Cá nhân**).
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, ấn chọn **Cư dân**. Màn hiện danh sách khách kèm các thẻ thống kê ở đầu trang (**Tổng** / **Cá nhân** / **Tổ chức** / **Nước ngoài**), hàng tab trạng thái, ô tìm kiếm, bộ lọc vị trí và các nút thao tác.

![Màn Cư dân: danh sách khách demo kèm thẻ thống kê, tab trạng thái và ô tìm kiếm](./images/buoc-01-danh-sach.webp)

**Bước 2**: Chọn tab trạng thái nếu cần — **Đang thuê** / **Đã chuyển đi** / **Khách vãng lai**. Mặc định khách tạo mới nằm ở **Đang thuê**. Muốn lọc theo loại khách, ấn vào một thẻ thống kê (**Cá nhân**, **Tổ chức** hoặc **Nước ngoài**) để chỉ hiện nhóm đó.

**Bước 3**: Tại ô tìm kiếm, gõ **tên**, **số điện thoại**, **email** hoặc **số CCCD** để lọc nhanh. Muốn thu hẹp theo vị trí, dùng ô lọc **Toà nhà** (danh sách phẳng A→Z, chọn 1 toà hoặc tất cả); chọn xong một toà thì ô **Phòng** mới bật lên. Các bộ lọc và ô tìm kiếm được giữ lại khi bạn tải lại trang (F5).

**Bước 4**: Muốn thêm khách mới, ấn nút **Thêm**. Hệ thống mở form tạo hồ sơ tại **/customers/new**. Ở đầu form, chọn **Loại khách hàng**: **Cá nhân** (điền **Họ và tên**) hoặc **Tổ chức** (điền **Tên công ty** và **Người đại diện**).

**Bước 5**: Điền các thông tin còn lại. Với khách **Cá nhân**, bạn có thể quét **QR CCCD** (kéo-thả ảnh QR, chọn file, dán Ctrl+V hoặc dùng camera) để hệ thống tự điền **Họ và tên**, **Số CCCD**, **Ngày sinh**, **Giới tính**, **ngày/nơi cấp** và **địa chỉ thường trú**. Số điện thoại là bắt buộc và phải là **10–11 chữ số**.

::: warning Không nhập dữ liệu thật
Trên bản demo/sandbox, **đừng nhập CCCD, số điện thoại hay ảnh giấy tờ thật** của khách. Hãy dùng dữ liệu giả (ví dụ SĐT `0900 000 098`, số CCCD bịa) để tránh lộ thông tin cá nhân.
:::

**Bước 6**: Tải ảnh giấy tờ ở khu **Ảnh giấy tờ** (kéo-thả hoặc dán clipboard, mỗi ảnh ≤ 10MB). Khách **Cá nhân** có 3 ô: **CCCD mặt trước**, **CCCD mặt sau**, **Hộ chiếu**. Khách **Tổ chức** dùng ô đầu làm **Đăng ký kinh doanh**. Ảnh được lưu vào kho riêng tư, chỉ hiển thị qua đường dẫn có chữ ký nên an toàn.

**Bước 7**: Kiểm tra lại toàn bộ rồi ấn **Lưu**. Hệ thống quay về danh sách **Cư dân**, hồ sơ mới nằm ở tab **Đang thuê**. Muốn mở lại hồ sơ, ấn nút **Xem** trên dòng khách để mở trang chi tiết (thông tin cá nhân, ảnh CCCD, địa chỉ, phương tiện, danh sách hợp đồng, liên hệ khẩn cấp).

::: tip Người ở cùng & người đại diện
Một hợp đồng có thể gắn **nhiều cư dân** (người ở cùng), trong đó **một người là đại diện** đứng tên. Việc gắn nhiều khách và chọn ai đại diện được thực hiện **khi ký hợp đồng** (xem [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/)), không phải trên màn Cư dân. Ở trang chi tiết khách, cờ **Đại diện** cho biết khách đó có phải người đứng tên hợp đồng hay không.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Tab **Đang thuê / Đã chuyển đi / Khách vãng lai** | Lọc theo trạng thái sử dụng. Mặc định khách mới vào **Đang thuê**; hai tab còn lại hiện chưa được hệ thống tự gán nên thường rỗng. |
| Thẻ **Tổng / Cá nhân / Tổ chức / Nước ngoài** | Thống kê nhanh theo phạm vi đang lọc; ấn vào một thẻ để lọc theo loại khách. |
| Ô tìm kiếm | Lọc theo **tên / SĐT / email / số CCCD**. |
| Ô lọc **Toà nhà** | Chọn đúng **1 toà** hoặc **Tất cả** (danh sách phẳng A→Z). Lọc theo toà của hợp đồng còn hiệu lực. |
| Ô lọc **Phòng** | Combobox gõ-để-tìm, chỉ bật khi đã chọn đúng 1 toà. |
| Nút **Thêm** | Mở form tạo hồ sơ mới tại **/customers/new** (chỉ hiện khi có phạm vi + quyền **Thêm**). |
| Nút **Nhập Excel** | Nhập hàng loạt khách từ file Excel; đọc thêm được cả ảnh CCCD từ đường dẫn trong file. |
| Nút **Xuất Excel** | Xuất danh sách khách đang lọc ra file. |
| Nút **Xem** / **Sửa** / **Xoá** trên mỗi dòng | Mở chi tiết, sửa hồ sơ (**/customers/:id/edit**), hoặc xoá mềm hồ sơ. |
| **Mẫu CT01** (trong trang chi tiết) | Lập và in tờ khai thay đổi thông tin cư trú từ hồ sơ khách (xem [Hồ sơ CT01](/03-quan-ly-van-hanh/ho-so-ct01/)). |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy nút **Thêm** / **Nhập Excel** | Bạn chưa được gán toà (phạm vi) hoặc thiếu quyền **Thêm/Nhập**. Nhờ quản lý gán toà và cấp quyền. |
| Lưu báo **"SĐT hoặc CCCD đã tồn tại"** | Trùng số điện thoại hoặc số CCCD với một hồ sơ khác. Tìm lại khách đó thay vì tạo trùng, hoặc kiểm tra số nhập vào. |
| Không lưu được vì lỗi số điện thoại | SĐT phải là **10–11 chữ số**, không dấu cách/ký tự. Nhập lại cho đúng định dạng. |
| Chọn **Phòng** ở bộ lọc nhưng ra 0 khách | Bộ lọc theo phòng hiện chưa có tác dụng lọc khách; hãy lọc bằng ô **Toà nhà** và ô tìm kiếm theo tên/SĐT. |
| Danh sách trống dù chắc chắn có khách | Kiểm tra tab trạng thái và ô tìm kiếm còn dính từ khoá cũ (bộ lọc giữ qua F5). Nếu vẫn trống, có thể do quyền — nhờ quản lý kiểm tra lại. |
| Tab **Đã chuyển đi** / **Khách vãng lai** luôn rỗng | Đúng hiện trạng: hệ thống chưa tự chuyển khách sang hai trạng thái này; hầu hết khách nằm ở **Đang thuê**. |
| Nút **Sửa/Xoá** không hiện trên một dòng | Khách đang thuê ở toà ngoài phạm vi bạn quản. Bạn chỉ sửa/xoá được khách trong toà được giao (hoặc khách chưa gắn toà nào). |
| Quét QR CCCD không ra kết quả | QR phải là mã ở **mặt sau CCCD gắn chip**; ảnh mờ/nghiêng có thể đọc lỗi. Chụp lại rõ hoặc điền tay. |

::: warning Xoá khách là xoá mềm
Ấn **Xoá** chỉ ẩn hồ sơ khỏi danh sách chứ **không xoá hẳn** khỏi hệ thống — mọi liên kết hợp đồng, cọc và hoá đơn vẫn được giữ nguyên để không hỏng dữ liệu cũ. Tuy vậy giao diện không có nút khôi phục, nên hãy cân nhắc trước khi xoá.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/customers" app-label="Mở màn Cư dân" fixtures="7 khách DEMO">

Thực hành CRUD hồ sơ cư dân trên dữ liệu demo (7 khách: Nguyễn Văn An, Trần Thị Bình, Lê Văn Cường, Phạm Thị Dung, Hoàng Văn Em, Võ Thị Phương, Đặng Văn Giang):

1. Ấn **Thêm**, chọn loại **Cá nhân**, điền tên giả (ví dụ **Nguyễn Văn Test**), SĐT **0900 000 098**, số CCCD bịa rồi ấn **Lưu**. Kiểm tra khách mới xuất hiện ở tab **Đang thuê**.
2. Tại ô tìm kiếm, gõ **Bình** và kiểm tra danh sách chỉ còn **Trần Thị Bình**.
3. Ấn **Xem** trên một khách (ví dụ **Nguyễn Văn An**) để mở trang chi tiết: xem thông tin cá nhân, hợp đồng và phương tiện gắn với khách.

::: warning Chỉ dùng dữ liệu giả
Không nhập CCCD, SĐT hay ảnh giấy tờ thật vào sandbox.
:::

Kết quả mong đợi: bạn tạo, tìm và mở hồ sơ khách thành thạo, quen quy trình quản lý cư dân từ đầu đến cuối.

</SandboxTry>

## Quy trình liên quan

- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vòng đời từ khách tiềm năng đến khi ký hợp đồng.
- [Khách hẹn](/03-quan-ly-van-hanh/khach-hen/) — theo dõi khách tiềm năng (lead) trước khi thành cư dân.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — gắn cư dân vào hợp đồng và chọn người đại diện.
- [Hồ sơ CT01](/03-quan-ly-van-hanh/ho-so-ct01/) — lập tờ khai thay đổi thông tin cư trú từ hồ sơ khách.
- [Phương tiện](/03-quan-ly-van-hanh/phuong-tien/) — quản lý xe của cư dân (biển số, phí gửi xe).
