---
title: "Báo cáo: Hợp đồng sắp hết hạn"
description: "Danh sách hợp đồng đang hiệu lực sắp hết hạn trong 7/15/30 ngày tới, giúp bạn chủ động gia hạn hoặc tìm khách mới trước khi phòng trống."
routes: ["/reports/real-estate/expiring-contracts"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Hợp đồng sắp hết hạn

Báo cáo này liệt kê những **hợp đồng đang hiệu lực** có ngày kết thúc rơi vào **N ngày tới** (7, 15 hoặc 30 ngày), để bạn nhìn thấy trước những căn sắp phải quyết định: **gia hạn cho khách cũ** hay **chuẩn bị tìm khách mới**. Trong ứng dụng, màn hình này mang tên **Báo cáo Căn hộ sắp trống** — cùng một thứ: hợp đồng sắp hết hạn nghĩa là căn hộ sắp trống nếu không kịp gia hạn. Đây là **trang chỉ để xem và lên kế hoạch** — bạn không ký, không gia hạn ngay tại đây; báo cáo chỉ chỉ ra "cần chú ý căn nào, gấp tới mức nào".

Trang phù hợp cho **chủ nhà**, **quản lý toà** và **kế toán** muốn theo dõi danh mục hợp đồng và tránh để phòng trống ngoài ý muốn.

::: info Điều kiện tiên quyết
- Bạn có quyền xem nhóm **Báo cáo bất động sản** (báo cáo **Căn hộ sắp trống**). Nếu không mở được, liên hệ chủ tài khoản để được cấp quyền.
- Đã có ít nhất một **hợp đồng đang hiệu lực** (trạng thái *Đang thuê*) với ngày kết thúc trong tương lai gần. Nếu chưa có hợp đồng nào sắp hết hạn, bảng sẽ hiển thị thông báo trống — đó là trạng thái bình thường, không phải lỗi.
- Việc **gia hạn** hoặc **thanh lý** hợp đồng được làm ở màn hình hợp đồng, không phải ở đây — xem [Gia hạn & chuyển phòng](/03-quan-ly-van-hanh/gia-han-chuyen-phong/).
:::

## Cách mở

**Bước 1**: Vào **Báo cáo** => **Báo cáo bất động sản** => **Căn hộ sắp trống (HĐ sắp hết hạn)**. Màn hình mở ra gồm 4 thẻ thống kê ở trên, hàng bộ lọc, và bảng danh sách hợp đồng sắp hết hạn (sắp xếp theo ngày hết hạn gần nhất lên đầu).

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

Ba bộ lọc nằm ngay trên bảng. Mọi lựa chọn được **giữ lại khi bạn tải lại trang (F5)**.

| Bộ lọc | Ý nghĩa |
| --- | --- |
| **Tất cả toà nhà** | Giới hạn danh sách theo một toà. Để **Tất cả toà nhà** để xem toàn bộ, hoặc chọn ví dụ **Tòa DEMO A** để chỉ xem hợp đồng của toà đó. |
| **Chọn tầng** | Lọc tiếp theo tầng. Ô này chỉ bật **sau khi** bạn đã chọn một toà cụ thể; mặc định là **Tất cả tầng**. |
| Tab **7 ngày / 15 ngày / 30 ngày** | Khoảng thời gian "sắp hết hạn". Mặc định là **30 ngày** — nhìn xa nhất. Chọn **7 ngày** để lọc ra những căn gấp nhất. |

Bốn thẻ ở đầu trang tóm tắt nhanh mức độ khẩn theo số ngày còn lại. Bảng bên dưới liệt kê từng hợp đồng. Ý nghĩa từng chỉ số và cột như sau:

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Thẻ **Tổng căn hộ sắp trống** | Tổng số hợp đồng sắp hết hạn trong khoảng đang chọn (ví dụ *Trong 30 ngày tới*). |
| Thẻ **Hết hạn trong 7 ngày** | Số hợp đồng còn ≤ 7 ngày — *Cần liên hệ khẩn cấp*. |
| Thẻ **Hết hạn 8-15 ngày** | Số hợp đồng còn 8–15 ngày — *Cần chuẩn bị gia hạn*. |
| Thẻ **Hết hạn 16-30 ngày** | Số hợp đồng còn 16–30 ngày — *Thời gian đàm phán*. Nếu bạn đang ở tab **7 ngày** thì hai thẻ 8–15 và 16–30 sẽ bằng 0 (đã bị lọc ra khỏi bảng). |
| **Mức độ** | Nhãn khẩn cấp theo số ngày còn lại: **Khẩn cấp** (≤ 7 ngày), **Quan trọng** (8–15 ngày), **Bình thường** (> 15 ngày). |
| **Mã HĐ** | Số hợp đồng, ví dụ hợp đồng của phòng **A103**, **Tòa DEMO A**. |
| **Khách hàng** | Khách đại diện của hợp đồng, ví dụ **Nguyễn Văn A**. |
| **Liên hệ** | Số điện thoại và email của khách — để bạn gọi/nhắn chủ động về việc gia hạn. |
| **Tòa nhà** | Toà chứa căn hộ, ví dụ **Tòa DEMO A**. |
| **Căn hộ** | Tên phòng và tầng, ví dụ **Căn hộ A103**. |
| **Ngày hết hạn** | Ngày kết thúc hợp đồng (dd/MM/yyyy). |
| **Còn lại** | Số ngày còn tới ngày hết hạn, tô màu theo mức khẩn: **đỏ** (≤ 7), **vàng** (≤ 15), **xanh** (> 15). Với dữ liệu demo, **A103** còn khoảng **21 ngày** nên hiển thị màu **xanh**, nhãn **Bình thường**. |
| **Giá thuê** | Tiền thuê/tháng của hợp đồng, ví dụ **1.000.000đ**. |

## Nguồn số liệu

Báo cáo đọc trực tiếp từ danh sách **hợp đồng** với đúng ba điều kiện:

1. **Chỉ hợp đồng đang hiệu lực** (trạng thái *Đang thuê*). Hợp đồng đã thanh lý / đã kết thúc không xuất hiện ở đây.
2. **Ngày kết thúc nằm trong khoảng [hôm nay; hôm nay + N ngày]**. Vì phải *lớn hơn hoặc bằng hôm nay*, hợp đồng đã **quá hạn** (ngày kết thúc đã trôi qua mà chưa gia hạn) **không** hiện ở báo cáo này — căn đó sẽ chuyển sang [Báo cáo Căn hộ trống](/04-bao-cao/phong-trong/).
3. **Chưa bị xoá**.

Một điểm dễ nhầm liên quan đến **gia hạn**: khi bạn gia hạn một hợp đồng, hệ thống **không đổi trạng thái** mà **đẩy ngày kết thúc ra xa** (hợp đồng vẫn *Đang thuê*). Vì vậy hợp đồng vừa gia hạn sẽ **tự biến mất** khỏi báo cáo nếu ngày kết thúc mới đã vượt ra ngoài khoảng N ngày. Trong dữ liệu demo, phòng **A104** đã gia hạn nên **không** nằm trong danh sách này, còn **A103** (chưa gia hạn, còn ~21 ngày) thì **có**. Nói cách khác, danh sách rút ngắn lại chính là dấu hiệu bạn đã xử lý xong một căn.

Bộ lọc **toà nhà** và **tầng** được áp sau khi tải dữ liệu, còn ô **N ngày** quyết định phạm vi ngay từ khâu truy vấn. Số liệu làm mới mỗi khi bạn đổi bộ lọc hoặc mở lại trang.

## Xuất & mẹo

- **Xuất báo cáo**: nút **Xuất báo cáo** (góc phải) cho **Excel (.xlsx)** và **CSV (.csv)** — bản xuất kèm thêm cột **Điện thoại**, **Tầng** và **Trạng thái** so với bảng trên màn hình, tiện gửi cho khách hoặc lưu đối chiếu. Lựa chọn **PDF** hiện là chỗ dành sẵn, chưa dùng được.
- **Ưu tiên xử lý**: bắt đầu từ tab **7 ngày** để "dập" các căn **Khẩn cấp** (màu đỏ) trước, rồi mới nới sang **15** và **30 ngày** để lên lịch đàm phán sớm.
- **Danh sách đã tự sắp** theo ngày hết hạn gần nhất lên đầu — cứ đọc từ trên xuống là đúng thứ tự cần gọi khách.
- **Không thấy một hợp đồng bạn nghĩ sắp hết hạn?** Kiểm tra: (a) hợp đồng có còn *Đang thuê* không; (b) ngày kết thúc đã trôi qua chưa (nếu quá hạn thì xem ở báo cáo Căn hộ trống); (c) bộ lọc toà/tầng có đang thu hẹp danh sách không.
- **Kết hợp với cảnh báo tự động**: hệ thống còn tự nhắc hợp đồng sắp hết hạn ở **Bảng tin** và **Thông báo** theo các mốc 30/15/7 ngày. Báo cáo này là góc nhìn tổng, dùng để rà soát cả danh mục; xem [Bảng tin](/02-theo-doi-nhanh/bang-tin/) và [Thông báo](/02-theo-doi-nhanh/thong-bao/).

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/real-estate/expiring-contracts" app-label="Mở báo cáo Căn hộ sắp trống" view-only fixtures="Tòa DEMO A/B, 8 phòng đang thuê; A103 hết hạn sau ~21 ngày (chưa gia hạn); A104 đã gia hạn; A105 có khuyến mãi.">
Mở báo cáo và quan sát:

1. Với tab **30 ngày**, hãy nhìn thấy **A103** (**Tòa DEMO A**, khách **Nguyễn Văn A**, giá thuê **1.000.000đ**) xuất hiện với **Còn lại ~21 ngày** màu **xanh** và nhãn mức độ **Bình thường**.
2. Bấm sang tab **7 ngày** và nhìn thấy **A103 biến mất** khỏi bảng (còn 21 ngày, đã vượt ngưỡng 7 ngày) — đây là cách các tab lọc theo độ khẩn.
3. Xác nhận **A104** (đã gia hạn) **không** nằm trong danh sách ở bất kỳ tab nào: gia hạn đã đẩy ngày kết thúc ra xa nên căn này không còn "sắp hết hạn".
4. Thử lọc **Tòa DEMO B** rồi bỏ chọn để thấy bộ lọc toà thu hẹp / mở rộng danh sách.

Đây là bài **chỉ xem** — bạn không gia hạn hay chỉnh sửa gì. Muốn thực sự gia hạn A103, hãy sang màn hình gia hạn hợp đồng.
</SandboxTry>

## Quy trình liên quan

- [Gia hạn & chuyển phòng](/03-quan-ly-van-hanh/gia-han-chuyen-phong/) — nơi bạn thực sự gia hạn hợp đồng cho căn vừa thấy trong báo cáo.
- [Quản lý hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — mở chi tiết từng hợp đồng để xem điều khoản, khách và lịch sử.
- [Báo cáo Gia hạn / chuyển nhượng](/04-bao-cao/gia-han-chuyen-nhuong/) — theo dõi những hợp đồng đã gia hạn hoặc sang nhượng.
- [Báo cáo Căn hộ trống](/04-bao-cao/phong-trong/) — nơi căn hộ xuất hiện nếu hợp đồng hết hạn mà không kịp gia hạn.
- [Báo cáo Cho thuê mới](/04-bao-cao/cho-thue-moi/) — theo dõi các hợp đồng mới ký để lấp lại phòng trống.
- [Hub Báo cáo bất động sản](/04-bao-cao/hub-bds/) — quay lại danh mục toàn bộ báo cáo vận hành bất động sản.
