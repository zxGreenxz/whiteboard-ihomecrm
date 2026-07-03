---
title: "Báo cáo: Cho thuê mới"
description: "Xem nhanh các hợp đồng được ký mới trong kỳ — tốc độ cho thuê, khách vào, giá thuê và tiền cọc theo từng tòa."
routes: ["/reports/real-estate/new-leases"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Cho thuê mới

Báo cáo **Cho thuê mới** liệt kê mọi **hợp đồng được ký mới** trong khoảng thời gian bạn chọn — mỗi dòng là một hợp đồng vừa ký, kèm phòng, khách thuê, ngày ký, ngày bắt đầu, giá thuê/tháng và tiền cọc. Đây là màn **chỉ để xem** (không nhập liệu), giúp bạn — chủ nhà, kế toán hoặc quản lý tòa — đo **tốc độ cho thuê** trong kỳ: bao nhiêu căn có khách mới, ở tòa nào, mang về bao nhiêu tiền thuê và cọc. Đặt cạnh báo cáo [Bỏ trả / thanh lý](/04-bao-cao/thanh-ly/), bạn thấy được bức tranh "khách vào − khách ra" của từng tháng.

::: info Điều kiện tiên quyết
- Bạn cần quyền **xem Báo cáo** để mở nhóm **Báo cáo bất động sản**. Cụ thể màn này được kiểm quyền theo **Báo cáo BĐS => Cho thuê mới** (module `reports_real_estate`, tính năng `new_leases`), có **fallback** về quyền **Xem báo cáo** nếu tài khoản dùng ma trận quyền cũ.
- Đã có **hợp đồng ký mới** trong kỳ thì báo cáo mới hiện dòng. Hợp đồng được tạo ở màn [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) (hoặc theo [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/)); hợp đồng ký từ giao diện luôn ở trạng thái **Đang hiệu lực**.
:::

## Cách mở

**Bước 1**: Vào menu **Báo cáo** => nhóm **Bất động sản** => **Cho thuê mới**. Màn mở ra với **bộ chọn khoảng thời gian** và **bộ lọc tòa nhà** ở đầu trang, bên dưới là bảng danh sách hợp đồng ký mới trong kỳ.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

Báo cáo dựa trên **ngày ký hợp đồng** (`signed_date`) — một hợp đồng lọt vào kỳ nào là theo **ngày ký**, không phải ngày bắt đầu thuê. Vì vậy một hợp đồng ký cuối tháng 6 nhưng bắt đầu thuê từ tháng 7 vẫn được tính vào **kỳ tháng 6**.

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Bộ chọn **khoảng thời gian** (từ ngày — đến ngày) | Lọc hợp đồng theo **ngày ký** (`signed_date`) rơi trong khoảng này. Thu hẹp khoảng để xem đúng một tháng. |
| Bộ lọc **Tòa nhà** | Chọn một tòa để chỉ xem hợp đồng của tòa đó; để trống là xem mọi tòa trong phạm vi của bạn. |
| **Số hợp đồng ký mới** (tổng) | Đếm số hợp đồng được ký trong kỳ đã lọc — chỉ tiêu chính đo tốc độ cho thuê. |
| **Mã HĐ** | Mã hợp đồng vừa ký. |
| **Phòng** / **Tòa** | Căn hộ và tòa nhà của hợp đồng. |
| **Khách thuê** | Tên khách đứng tên trên hợp đồng (vd **Nguyễn Văn A**). |
| **Ngày ký** (`signed_date`) | Mốc quyết định hợp đồng thuộc kỳ nào của báo cáo. |
| **Ngày bắt đầu** (`start_date`) | Ngày hợp đồng có hiệu lực thuê; có thể lệch với ngày ký. |
| **Giá thuê/tháng** | Tiền thuê hàng tháng của hợp đồng (vd **1.000.000đ**). |
| **Tiền cọc** | Tổng cọc theo hợp đồng (`total_deposit`). |
| **Trạng thái** | Hợp đồng ký từ giao diện luôn **Đang hiệu lực** (ACTIVE). |

## Nguồn số liệu

- Báo cáo là **READ tổng hợp**, không ghi dữ liệu. Nó đọc thẳng bảng **hợp đồng** (`contracts`), lọc những hợp đồng có **ngày ký** (`signed_date`) trong khoảng thời gian đã chọn và **chưa bị xóa** (bỏ qua hợp đồng đã xóa mềm).
- **Lọc tòa nhà chạy phía trình duyệt**: hệ thống tải danh sách hợp đồng rồi mới lọc theo tòa ngay trên máy bạn (khác với vài báo cáo lọc sẵn ở máy chủ). Do đó khi dữ liệu nhiều, thu hẹp **khoảng thời gian** sẽ nhẹ và nhanh hơn.
- **Dữ liệu này sinh ra từ đâu**: mỗi dòng ứng với một hợp đồng bạn tạo ở màn [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/). Muốn số liệu đúng, hãy nhập **ngày ký** chuẩn khi lập hợp đồng — đây chính là mốc báo cáo dùng để xếp hợp đồng vào kỳ.
- Báo cáo **không cộng tiền đã thu**; các cột tiền (giá thuê, cọc) là **giá trị cam kết trên hợp đồng**, không phải số tiền thực thu. Muốn đối chiếu thu cọc/thu tiền thực, xem [Danh sách cọc](/04-bao-cao/danh-sach-coc/) và [Thu tiền hóa đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/).

## Xuất & mẹo

- **Xuất file**: dùng nút **Xuất** trên trang để tải bảng ra Excel/CSV, tiện gửi báo cáo tháng hoặc lưu đối chiếu.
- **Đo tốc độ cho thuê**: đọc chỉ tiêu **Số hợp đồng ký mới** theo từng tòa để biết tòa nào đang lấp khách nhanh; ghép với [Tỉ lệ lấp đầy](/04-bao-cao/lap-day/) để thấy hiệu quả lấp đầy tổng thể.
- **Khách vào − khách ra**: đặt báo cáo này cạnh [Bỏ trả / thanh lý](/04-bao-cao/thanh-ly/) trong cùng kỳ để tính "biến động khách" ròng của tháng.
- **Nhìn trước áp lực gia hạn**: khách mới hôm nay là khách sắp hết hạn ngày mai — theo dõi tiếp bằng [HĐ sắp hết hạn](/04-bao-cao/hd-sap-het-han/) và [Gia hạn / chuyển nhượng](/04-bao-cao/gia-han-chuyen-nhuong/).
- **Mẹo đọc đúng kỳ**: nếu một hợp đồng "biến mất" khỏi kỳ bạn mong đợi, kiểm tra **ngày ký** — báo cáo xếp theo ngày ký chứ không theo ngày bắt đầu thuê.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/real-estate/new-leases" app-label="Mở báo cáo Cho thuê mới" fixtures="Tòa DEMO A/B; hợp đồng ký mới trong kỳ cho khách Nguyễn Văn A" view-only>

Bài này **chỉ xem** — bạn quan sát và hiểu cách đọc số, không nhập liệu:

1. Chọn **khoảng thời gian** phủ kỳ có hợp đồng ký mới rồi nhìn chỉ tiêu **Số hợp đồng ký mới** ở đầu bảng.
2. Trong bảng, hãy nhìn thấy dòng khách **Nguyễn Văn A** thuê phòng ở **Tòa DEMO A** với **Giá thuê/tháng 1.000.000đ**; đối chiếu **Ngày ký** và **Ngày bắt đầu** để thấy chúng có thể lệch nhau.
3. Đổi **bộ lọc Tòa nhà** sang **Tòa DEMO B** và quan sát bảng chỉ còn hợp đồng của tòa đó (lọc chạy ngay trên trình duyệt).

Kết quả mong đợi: bạn hiểu báo cáo xếp hợp đồng theo **ngày ký**, đọc được số hợp đồng ký mới và các con số **cam kết** (giá thuê, cọc) trên từng dòng, và biết lọc theo từng tòa để so tốc độ cho thuê.

</SandboxTry>

## Quy trình liên quan

- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — nơi lập hợp đồng ký mới; nhập đúng **ngày ký** để báo cáo xếp đúng kỳ.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — bức tranh tổng quát từ khi có khách đến khi ký hợp đồng.
- [Hub Báo cáo bất động sản](/04-bao-cao/hub-bds/) — cổng vào 8 báo cáo vận hành BĐS.
- [Tỉ lệ lấp đầy](/04-bao-cao/lap-day/) — soi hiệu quả lấp đầy tổng thể của từng tòa.
- [Bỏ trả / thanh lý](/04-bao-cao/thanh-ly/) — mặt "khách ra", ghép với báo cáo này để tính biến động khách.
- [HĐ sắp hết hạn](/04-bao-cao/hd-sap-het-han/) — theo dõi khách mới sẽ tới hạn gia hạn.
- [Danh sách cọc](/04-bao-cao/danh-sach-coc/) — đối chiếu tiền cọc thực thu của các hợp đồng mới.
