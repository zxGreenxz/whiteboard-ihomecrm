---
title: "Ghi chỉ số điện nước"
description: "Ghi chỉ số công tơ điện/nước từng phòng hoặc import hàng loạt; chỉ số đầu tự lấy từ kỳ trước, số tiêu thụ tự tính, và chỉ số phải được duyệt trước khi lên hoá đơn."
routes: ["/meter-readings"]
permissions: [{module: meter_readings, action: view}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Ghi chỉ số điện nước

Màn **Ghi chỉ số** là nơi mỗi tháng bạn đọc số đồng hồ điện, nước của từng phòng và lưu lại. Hệ thống tự lấy **chỉ số đầu** từ lần ghi trước (hoặc chỉ số ban đầu của công tơ), tự tính **số tiêu thụ = chỉ số mới − chỉ số đầu**, rồi chốt lại (duyệt) để làm dữ liệu đầu vào cho hoá đơn tiền điện, tiền nước. Bạn có thể ghi từng phòng bằng form, hoặc import cả loạt bằng file Excel. Điểm cốt lõi cần nhớ: **chỉ những chỉ số đã ở trạng thái "Đã duyệt" mới được hoá đơn lấy làm chỉ số điện — hãy ghi và chốt chỉ số trước khi lên hoá đơn tháng.**

::: info Điều kiện tiên quyết
- Quyền **Ghi chỉ số => Xem** (module `meter_readings`, action `view`) để mở màn; quyền **Ghi chỉ số => Tạo** để bấm **Thêm chỉ số** và **Import**.
- Đã khai báo **công tơ** cho các phòng — không có công tơ thì không ghi chỉ số được. Xem [Công tơ điện nước](/01-bat-dau/cong-to/).
- Đã có **dịch vụ** Điện/Nước kèm đơn giá để hoá đơn tính tiền theo mức tiêu thụ. Xem [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/).
- Là nhân viên, bạn chỉ ghi và thấy chỉ số của các toà được gán phạm vi cho mình.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại thanh menu, ấn chọn **Tài chính** => **Ghi chỉ số**. Màn mở ra với hàng **thẻ thống kê** ở trên (chỉ số đã duyệt, chưa duyệt, tổng tiêu thụ điện theo kWh, nước theo m³), bên dưới là **danh sách các lần ghi chỉ số** theo tháng. Trong dữ liệu demo bạn thấy chỉ số điện và nước tháng 7 đã ghi cho các phòng **A101–A105** và **B101**.

![Màn Ghi chỉ số với các chỉ số điện/nước tháng 7 đã ghi cho A101–A105 và B101](./images/buoc-01-danh-sach.webp)

**Bước 2**: Đọc một dòng trong danh sách. Mỗi dòng gồm: **mã chỉ số** kèm badge trạng thái (**Đã duyệt** hoặc **Chưa duyệt**), tên **công tơ**, **chỉ số đầu**, **chỉ số cuối**, **số tiêu thụ** (chênh lệch, hệ thống tự tính — không sửa tay), **ngày chốt** và **người chốt**. Dùng ô lọc **Toà nhà**, **Loại công tơ** và **Tháng chốt** ở đầu bảng để thu hẹp danh sách.

**Bước 3**: Ghi chỉ số mới cho một tháng — ấn **Thêm chỉ số**. Trong form, chọn **Tòa nhà** (bắt buộc), **Phòng**, **Loại công tơ** (**Điện** hoặc **Nước**), **Tháng chốt** và **Ngày chốt**. Ngay khi đủ toà và tháng, form **tự nạp bảng các công tơ chưa chốt** của bộ lọc đó — mỗi dòng có sẵn cột **Chỉ số đầu** (lấy từ lần ghi trước hoặc chỉ số ban đầu của công tơ) và ô nhập **Chỉ số mới**.

::: tip Chỉ số đầu tự nối tiếp kỳ trước (carry-forward)
Bạn **không cần nhập chỉ số đầu**. Với lần ghi đầu tiên của một công tơ, hệ thống lấy **chỉ số ban đầu** khai lúc tạo công tơ; từ lần thứ hai trở đi, chỉ số đầu chính là **chỉ số cuối của kỳ liền trước** — chuỗi số luôn liền mạch, không có khoảng hở. Nhờ vậy số tiêu thụ mỗi tháng luôn khớp mức dùng thực tế.
:::

**Bước 4**: Nhập **Chỉ số mới** đọc được trên mặt đồng hồ cho từng dòng công tơ. Hệ thống tự lấy **Chỉ số mới − Chỉ số đầu** ra **số tiêu thụ**. Ấn **Thêm chỉ số** (nút lưu ở cuối form) để lưu. Các dòng bạn bỏ trống (không nhập) sẽ được bỏ qua.

::: warning Chỉ số mới không được nhỏ hơn chỉ số đầu
Nếu bạn nhập **chỉ số mới nhỏ hơn chỉ số đầu**, hệ thống báo lỗi đỏ ngay tại dòng đó và **chặn lưu** — vì số tiêu thụ không thể âm. Kiểm tra lại con số đọc trên đồng hồ; nếu đồng hồ thật sự đã quay vòng hoặc bị thay, hãy xử lý ở màn công tơ trước. Ngoài ra, khi chọn **Tất cả phòng**, form không cho lưu: hãy **chọn đúng một phòng cụ thể** rồi mới nhập và lưu.
:::

**Bước 5**: Kiểm tra trạng thái duyệt. Chỉ số vừa lưu xuất hiện trong danh sách với badge **Đã duyệt** — nghĩa là đã được chốt và **sẵn sàng làm chỉ số điện cho hoá đơn tháng**. Khi lập hoá đơn, hệ thống chỉ nhặt **chỉ số Đã duyệt gần nhất** của phòng làm chỉ số đầu tiền điện; chỉ số **Chưa duyệt** sẽ bị bỏ qua. Vì vậy hãy đảm bảo mọi phòng đã có chỉ số **Đã duyệt** của tháng **trước khi** [sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/).

::: warning Sửa hoặc xoá chỉ số đã lên hoá đơn dễ gây lệch số
Sau khi một chỉ số đã được dùng để tính tiền điện trên hoá đơn, việc **sửa hoặc xoá** nó **không tự cập nhật ngược lại hoá đơn** — hai nơi sẽ lệch nhau, và chuỗi carry-forward sang tháng sau cũng có thể sai. Nếu buộc phải chỉnh, hãy kiểm tra lại hoá đơn liên quan và số đầu kỳ của tháng kế tiếp.
:::

**Bước 6**: Ghi hàng loạt bằng Excel — ấn **Import**. Tải **file mẫu**, điền **mã công tơ**, **ngày chốt** và **chỉ số mới** cho từng dòng, rồi tải file lên. Import **định danh hoàn toàn bằng mã công tơ** (không cần chọn toà/phòng), nên hãy điền đúng mã như đã khai ở màn Công tơ. Hệ thống kiểm từng dòng và báo tổng kết bao nhiêu dòng thành công, bao nhiêu dòng lỗi.

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| Ô lọc **Toà nhà** | Lọc danh sách theo một toà; gõ để tìm nhanh. |
| Ô lọc **Loại công tơ** | Lọc theo **Điện** / **Nước**. |
| Ô lọc **Tháng chốt** | Xem chỉ số theo tháng (`YYYY-MM`). |
| **Thêm chỉ số** | Mở form ghi chỉ số theo toà + tháng, tự nạp danh sách công tơ chưa chốt. |
| **Import** | Nạp chỉ số hàng loạt từ file Excel theo mã công tơ. |
| Badge **Đã duyệt / Chưa duyệt** | Trạng thái chốt của chỉ số; chỉ **Đã duyệt** mới được hoá đơn lấy làm chỉ số điện. |
| Menu **Cập nhật** trên từng dòng | Sửa **chỉ số mới**, ngày chốt, ghi chú, ảnh của một lần ghi (toà/phòng/loại/tháng khoá, không đổi được). |
| Menu **Xoá** trên từng dòng | Gỡ một lần ghi (xoá mềm). |
| **Xoá hàng loạt** | Chọn nhiều dòng rồi gỡ cùng lúc. |

Bộ lọc đang chọn được **giữ lại khi bạn tải lại trang (F5)**.

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Bảng công tơ trong form **rỗng** | Chưa chọn đủ **Toà nhà** và **Tháng chốt**, hoặc mọi công tơ của toà đã chốt tháng đó rồi. Đổi tháng, hoặc kiểm tra công tơ đã khai chưa ở [Công tơ điện nước](/01-bat-dau/cong-to/). |
| Không lưu được, báo **"Vui lòng chọn phòng"** | Bạn đang để **Tất cả phòng**. Chọn đúng **một phòng cụ thể** rồi nhập chỉ số và lưu lại. |
| Lỗi đỏ **chỉ số mới nhỏ hơn chỉ số đầu** | Số tiêu thụ không thể âm. Đọc lại con số trên đồng hồ; nếu đồng hồ đã thay/quay vòng, xử lý ở màn Công tơ trước. |
| Phòng thiếu công tơ nên không hiện để ghi | Sang [Công tơ điện nước](/01-bat-dau/cong-to/) thêm đủ công tơ **Điện/Nước** cho phòng đó rồi quay lại ghi. |
| Chỉ số rơi **nhầm tháng** so với mong đợi | Tháng của lần ghi bám theo **Ngày chốt**, không phải ô Tháng chốt. Chọn ngày chốt nằm đúng trong tháng bạn muốn ghi. |
| Import báo có **dòng lỗi** | Thường do sai **mã công tơ** hoặc chỉ số mới nhỏ hơn chỉ số đầu ở dòng đó. Sửa đúng ô trong file mẫu rồi import lại — các dòng đúng vẫn được ghi. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/meter-readings" app-label="Mở màn Ghi chỉ số" fixtures="chỉ số điện/nước tháng 7 các phòng A">

Thực hành ghi và chốt một chỉ số mới:

1. Xem danh sách sẵn có: chỉ số điện/nước **tháng 7** của các phòng **A101–A105** và **B101** đều có badge **Đã duyệt**.
2. Ấn **Thêm chỉ số**. Chọn **Tòa DEMO B**, chọn một phòng B chưa có chỉ số tháng 7 (ví dụ **B102**), loại **Điện**, **Tháng chốt** = tháng 7 và **Ngày chốt** trong tháng 7.
3. Trong bảng công tơ vừa nạp, nhìn cột **Chỉ số đầu** (tự lấy từ chỉ số ban đầu của công tơ), rồi nhập **Chỉ số mới** một số **lớn hơn chỉ số đầu**. Để ý số tiêu thụ tự hiện ra.
4. Ấn nút lưu **Thêm chỉ số**. Quay lại danh sách, tìm dòng vừa ghi cho phòng B: nó xuất hiện với badge **Đã duyệt** — tức đã chốt và sẵn sàng lên hoá đơn.

Kết quả mong đợi: bạn hiểu quy trình **ghi chỉ số → hệ thống tự tính số tiêu thụ → chỉ số ở trạng thái "Đã duyệt"** chính là điều kiện để hoá đơn lấy làm chỉ số điện. Xong thì **Reset** dữ liệu sandbox để trả về trạng thái ban đầu.

</SandboxTry>

## Quy trình liên quan

- [Công tơ điện nước](/01-bat-dau/cong-to/) — khai báo đồng hồ cho phòng trước khi ghi chỉ số.
- [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/) — đơn giá điện/nước dùng để tính tiền theo số tiêu thụ.
- [Sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/) — lên hoá đơn tháng, tự lấy chỉ số Đã duyệt gần nhất làm chỉ số điện.
- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) — theo dõi và thu tiền các hoá đơn đã sinh.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — danh sách phòng mà công tơ gắn vào.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) — vị trí của bước ghi chỉ số trong vòng đời thu tiền hằng tháng.
