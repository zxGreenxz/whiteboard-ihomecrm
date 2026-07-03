---
title: "Hồ sơ cư dân & khai báo cư trú CT01"
description: "Mở hồ sơ một cư dân, lập tờ khai thay đổi thông tin cư trú (mẫu CT01) và in ra nộp công an phường."
routes: ["/customers/:id", "/customers/:id/ct01"]
permissions: [{module: customers, action: print}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Hồ sơ cư dân & khai báo cư trú CT01

Trang chi tiết cư dân gom toàn bộ thông tin nhân thân của một khách: họ tên, giấy tờ tuỳ thân, ngày sinh, giới tính, địa chỉ, phương tiện và các hợp đồng đang đứng tên. Từ đây bạn mở được **Mẫu CT01** — tờ khai thay đổi thông tin cư trú theo mẫu của công an — để lập nhanh cho khách rồi in ra nộp công an phường. Dùng màn này mỗi khi cần khai báo tạm trú/thay đổi cư trú cho một người thuê, kể cả khách nước ngoài.

CT01 lấy sẵn phần lớn dữ liệu từ hồ sơ khách (họ tên, ngày sinh, số CCCD, địa chỉ), bạn chỉ cần bổ sung phần khai riêng của tờ khai: **cơ quan đăng ký cư trú**, **chủ hộ**, **thành viên cùng thay đổi** và **nội dung đề nghị**. Vì vậy hồ sơ khách càng đầy đủ thì lập CT01 càng nhanh.

::: info Điều kiện tiên quyết
- Quyền **Cư dân => In** (module `customers`, action `print`) để mở và in được tờ khai CT01.
- Đã có **hồ sơ khách** cần khai báo trong hệ thống. Nếu chưa, tạo trước ở màn [Cư dân](/03-quan-ly-van-hanh/cu-dan/).
- Hồ sơ khách nên điền đủ **họ tên**, **ngày sinh**, **giới tính**, **số CCCD/hộ chiếu** và **địa chỉ** — vì CT01 sẽ đổ sẵn các trường này. Khách nước ngoài cần bật cờ **Khách nước ngoài** (`is_foreign`) trong hồ sơ.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, ấn chọn **Cư dân**. Màn hiện danh sách cư dân kèm các tab trạng thái, thẻ thống kê và ô tìm kiếm. Gõ tên hoặc số điện thoại khách vào ô tìm kiếm để lọc nhanh.

![Màn Cư dân: danh sách khách để mở hồ sơ và lập tờ khai CT01](./images/buoc-01-danh-sach.webp)

**Bước 2**: Ấn vào tên khách cần khai báo để mở **hồ sơ chi tiết**. Tại đây bạn xem được thông tin nhân thân, ảnh giấy tờ, địa chỉ, phương tiện và danh sách hợp đồng của khách. Kiểm tra lại các thông tin cơ bản (họ tên, ngày sinh, số CCCD, địa chỉ) đã đúng trước khi lập tờ khai.

**Bước 3**: Trên trang chi tiết khách, ấn nút **Mẫu CT01**. Hệ thống mở form tờ khai và **tự điền sẵn** phần thông tin người khai từ hồ sơ khách (họ tên, ngày sinh, giới tính, số CCCD, địa chỉ, số điện thoại).

**Bước 4**: Điền phần khai riêng của tờ khai:
- **Cơ quan đăng ký cư trú** — bắt buộc; ghi đúng tên công an phường/xã nơi nộp.
- **Chủ hộ**: họ tên chủ hộ, quan hệ với chủ hộ và số CCCD của chủ hộ.
- **Nội dung đề nghị** — nội dung thay đổi thông tin cư trú cần khai báo.
- Kiểm tra lại các trường bắt buộc đã đổ sẵn: **họ tên**, **ngày sinh**, **giới tính**, **số CCCD** phải có giá trị.

**Bước 5**: Nếu khai cùng nhiều người (cả hộ), thêm từng người vào mục **Thành viên cùng thay đổi**. Danh sách thành viên được lưu kèm trong tờ khai và in ra cùng một trang.

**Bước 6**: Ấn **Lưu & In**. Hệ thống lưu tờ khai vào hồ sơ khách rồi tự mở hộp thoại in với bản CT01 đã định dạng sẵn. Chọn máy in (hoặc "Lưu thành PDF") để in/nộp.

::: tip CT01 kế thừa hồ sơ khách
Vì tờ khai đổ sẵn dữ liệu từ hồ sơ, hãy hoàn thiện hồ sơ khách trước (đặc biệt là **số CCCD/hộ chiếu**, **ngày sinh** và **địa chỉ thường trú**). Với **khách nước ngoài**, bật cờ **Khách nước ngoài** và nhập số hộ chiếu ở hồ sơ để tờ khai hiển thị đúng loại giấy tờ.
:::

::: warning Tờ khai không có màn lịch sử — hãy in ngay
Mỗi lần ấn **Lưu & In**, hệ thống tạo **một bản ghi tờ khai mới**. Hiện chưa có màn "lịch sử tờ khai" để xem/in lại tờ đã lưu: bạn chỉ in lại được **trong phiên đang mở** bằng nút **Chỉ in**. Nếu đóng trang rồi cần in lại, bạn phải lập một tờ khai mới. Vì vậy hãy in (hoặc lưu PDF) ngay khi lập xong, đừng đóng tab trước khi in.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô tìm kiếm (màn Cư dân) | Tìm khách theo họ tên, số điện thoại, email hoặc số CCCD. |
| Tab trạng thái / thẻ thống kê | Lọc nhanh danh sách cư dân theo trạng thái và loại khách (cá nhân / tổ chức / nước ngoài). |
| **Mẫu CT01** (trang chi tiết khách) | Mở form tờ khai thay đổi thông tin cư trú, đổ sẵn dữ liệu người khai từ hồ sơ. |
| **Sửa** (trang chi tiết khách) | Mở form chỉnh hồ sơ khách; sửa xong dữ liệu mới sẽ đổ đúng vào CT01 lần lập kế tiếp. |
| **Thành viên cùng thay đổi** | Thêm/bớt các thành viên cùng khai trong một tờ CT01. |
| **Lưu & In** | Lưu tờ khai vào hồ sơ khách rồi mở hộp thoại in bản CT01. |
| **Chỉ in** | In lại bản CT01 hiện tại **không** tạo thêm bản ghi (chỉ dùng được trong phiên đang mở). |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Mở CT01 báo **"Không tìm thấy khách hàng"** | Hồ sơ khách không tồn tại hoặc đã bị xoá. Quay lại màn [Cư dân](/03-quan-ly-van-hanh/cu-dan/), mở đúng khách rồi ấn lại **Mẫu CT01**. |
| Không lưu được — báo thiếu trường | Tờ khai bắt buộc **Cơ quan đăng ký cư trú**, **họ tên**, **ngày sinh**, **giới tính** và **số CCCD**. Điền đủ các ô này rồi lưu lại. Nếu số CCCD/ngày sinh trống, hãy bổ sung ở hồ sơ khách trước. |
| Hộp thoại in không tự mở | Trình duyệt có thể chặn cửa sổ in. Cho phép in cho trang, hoặc ấn **Chỉ in** để mở lại hộp thoại in bản vừa lập. |
| Lưu xong nhưng không tìm thấy tờ khai cũ để in lại | Đúng hiện trạng: chưa có màn lịch sử tờ khai. Trong phiên đang mở, dùng **Chỉ in** để in lại; nếu đã đóng trang, lập một tờ CT01 mới. |
| Khách nước ngoài in ra sai loại giấy tờ | Bật cờ **Khách nước ngoài** (`is_foreign`) và nhập **số hộ chiếu** trong hồ sơ khách, sau đó mở lại **Mẫu CT01** để dữ liệu đổ đúng. |
| Thông tin trên tờ khai bị sai/cũ | CT01 đổ theo hồ sơ khách tại thời điểm mở form. Ấn **Sửa** hồ sơ khách, cập nhật đúng rồi lập lại tờ khai. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/customers" app-label="Mở màn Cư dân" fixtures="khách Nguyễn Văn An có sẵn CT01">

**Bài tập thực hành**

1. Tại màn **Cư dân**, tìm và ấn vào khách **Nguyễn Văn An** để mở hồ sơ chi tiết.
2. Trên trang chi tiết, ấn nút **Mẫu CT01** để mở tờ khai cư trú.
3. Kiểm tra phần người khai đã đổ sẵn từ hồ sơ; điền **Cơ quan đăng ký cư trú** và thông tin **chủ hộ**.
4. Ấn **Lưu & In** để tạo tờ khai và mở bản in (hoặc lưu PDF).

**Kết quả mong đợi**

- Bạn mở được hồ sơ khách An và biết đường vào mục khai báo cư trú **CT01**.
- Bạn lập và in được một tờ CT01 hoàn chỉnh cho khách — nắm được quy trình khai báo cư trú cho một cư dân.

</SandboxTry>

## Quy trình liên quan

- [Cư dân](/03-quan-ly-van-hanh/cu-dan/) — danh sách cư dân, nơi mở hồ sơ khách và vào Mẫu CT01.
- [Phương tiện](/03-quan-ly-van-hanh/phuong-tien/) — quản lý xe gắn với khách/phòng, cùng thuộc hồ sơ cư dân.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — hợp đồng mà cư dân đứng tên đại diện.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vòng đời từ khách tiềm năng tới người thuê chính thức.
