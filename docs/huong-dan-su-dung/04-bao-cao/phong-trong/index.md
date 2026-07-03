---
title: "Báo cáo: Phòng trống"
description: "Danh sách phòng đang trống theo toà và tầng, kèm giá thuê và số ngày đã trống — để bạn ưu tiên đẩy cho thuê những phòng ế lâu."
routes: ["/reports/real-estate/vacant-rooms"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Phòng trống

Báo cáo **Phòng trống** (trong ứng dụng hiển thị tên **Báo cáo Căn hộ trống**) cho bạn một danh sách gọn: những phòng **đang trống, sẵn sàng cho thuê ngay**, thuộc toà nào, tầng mấy, giá thuê bao nhiêu và **đã trống bao nhiêu ngày**. Đây là màn hình *chỉ để xem* — bạn không nhập liệu ở đây, mà dùng nó để **ra quyết định**: phòng nào cần ưu tiên đẩy quảng cáo, phòng nào trống lâu cần cân nhắc giảm giá.

Người xem chính là **chủ nhà**, **kế toán** và **quản lý toà** — những người cần biết doanh thu đang "hụt" ở đâu và còn bao nhiêu phòng chưa sinh tiền. Điểm cốt lõi cần nhớ: báo cáo này chỉ đếm **phòng thật sự trống**. Phòng vừa **nhận cọc giữ chỗ** (đã có khách đặt, chờ ký hợp đồng) **không** xuất hiện ở đây — chúng được tách sang nhóm "Đã cọc" để bạn không nhầm là còn trống.

::: info Điều kiện tiên quyết
- Quyền **Xem báo cáo** — báo cáo Phòng trống nằm trong nhóm **Báo cáo => Bất động sản**. Thường là chủ nhà, kế toán hoặc quản lý toà được cấp quyền.
- Đã khai báo **toà nhà, tầng, phòng** trong hệ thống (xem [Tạo tầng & phòng](/01-bat-dau/tao-tang-phong/)). Không có phòng thì báo cáo trống.
- Nếu muốn cột **Số ngày trống** có số liệu, phòng cần từng có ít nhất một hợp đồng đã **thanh lý** hoặc **hết hạn** — hệ thống lấy ngày kết thúc gần nhất để đếm ngược.
:::

## Cách mở

**Bước 1**: Vào menu **Báo cáo** => nhóm **Bất động sản** => **Phòng trống** (Căn hộ trống). Màn hình mở ra với hai ô lọc ở đầu trang, một hàng **4 thẻ thống kê** tóm tắt, và bên dưới là **bảng danh sách** từng phòng trống.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

Báo cáo tính **theo thời gian thực** (tính đến hôm nay), không theo tháng — mở lúc nào là ảnh chụp tình trạng phòng lúc đó.

## Bộ lọc & cách đọc số

Hai ô lọc ở đầu trang và các con số hiển thị có ý nghĩa như sau:

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Ô **Chọn toà nhà** | Lọc danh sách về đúng một toà (mặc định **Tất cả toà nhà**). Đây là bộ lọc chạy **phía máy chủ** — chọn toà rồi hệ thống mới tải phòng của toà đó. |
| Ô **Chọn tầng** | Chỉ bật **sau khi** đã chọn một toà. Lọc tiếp danh sách theo tầng để bạn soi từng tầng một. |
| Thẻ **Tổng số căn hộ trống** | Tổng số phòng đang sẵn sàng cho thuê ngay — chính là số dòng trong bảng bên dưới. |
| Thẻ **Trống dưới 7 ngày** (xanh) | Phòng mới trống gần đây; thường tự lấp nhanh, chưa đáng lo. |
| Thẻ **Trống 7–30 ngày** (vàng) | Phòng cần **ưu tiên cho thuê** — bắt đầu ế. |
| Thẻ **Trống trên 30 ngày** (đỏ) | Phòng trống lâu — nên **xem lại giá** hoặc đẩy quảng cáo mạnh hơn. |
| Cột **Tòa nhà** | Toà chứa phòng (ví dụ Tòa DEMO A, Tòa DEMO B). |
| Cột **Căn hộ** | Mã/tên phòng (ví dụ A201, B103). |
| Cột **Tầng** | Tầng của phòng. |
| Cột **Diện tích** | Diện tích phòng, tính bằng m². |
| Cột **Giá thuê** | Giá thuê niêm yết của phòng, định dạng tiền Việt (ví dụ **1.000.000đ**). |
| Cột **Trạng thái** | Trạng thái kỹ thuật của phòng. Giúp bạn phân biệt phòng thật sự **trống sẵn sàng** với phòng đang **bảo trì / tạm ngưng** (dù chưa có khách, phòng bảo trì chưa cho thuê được). |
| Cột **Số ngày trống** | Số ngày kể từ **ngày kết thúc hợp đồng gần nhất** của phòng đến hôm nay. Tô màu theo ngưỡng: **xanh ≤ 7 ngày**, **vàng 7–30 ngày**, **đỏ > 30 ngày**. Hiện **Chưa xác định** nếu phòng chưa từng cho thuê hoặc không tìm thấy hợp đồng đã kết thúc để tính mốc. |

Bảng được **sắp xếp theo toà rồi đến tên phòng** (các phòng mặt bằng/trệt/lửng lên trước, rồi tới số phòng tăng dần), nên bạn dò theo toà rất nhanh.

## Nguồn số liệu

Báo cáo dựng từ dữ liệu **phòng** và **hợp đồng** đang có trong hệ thống, không phải một bảng nhập tay riêng:

- **Danh sách phòng trống** = mọi phòng (chưa xoá) **trừ đi** hai nhóm: (1) phòng đang có hợp đồng **còn hiệu lực** (đang thuê) và (2) phòng **đã cọc giữ chỗ** (trạng thái *giữ chỗ*). Vì loại nhóm (2), một phòng vừa nhận cọc sẽ **rời khỏi** danh sách này ngay và chuyển sang nhóm "Đã cọc" — đây là chủ ý để "trống" luôn nghĩa là "cho thuê được ngay".
- **Số ngày trống** đo từ **ngày kết thúc hợp đồng gần nhất** của phòng (hợp đồng đã **thanh lý** hoặc **hết hạn**). Hệ thống ưu tiên lấy **ngày dọn đi thực tế**; nếu không có thì lấy **ngày hết hạn** ghi trên hợp đồng. Phòng chưa từng cho thuê sẽ không có mốc này nên hiện **Chưa xác định**.
- **Phạm vi lọc**: chỉ ô **Toà nhà** lọc từ máy chủ; ô **Tầng** lọc sau khi dữ liệu đã tải về. Dữ liệu bạn thấy luôn nằm trong phạm vi toà nhà mà tài khoản của bạn được phép quản lý.
- Chi tiết mạch báo cáo và cách cơ cấu toà — tầng — phòng, xem tài liệu hệ thống *Báo cáo · Dashboard · Thông báo* và *Cơ cấu toà nhà, phòng, dịch vụ*.

## Xuất & mẹo

- **Xuất file**: nút **Xuất** ở góc trên cho tải danh sách ra **Excel / CSV** (tên tệp `bao-cao-can-ho-trong`). Dùng để gửi cho môi giới, dán lên nhóm chat, hay lập kế hoạch lấp phòng theo tuần.
- **Ưu tiên nhóm đỏ**: soi ngay các phòng **trống trên 30 ngày** — đây là phòng đang "chảy máu" doanh thu, cần giảm giá, tân trang hoặc đẩy quảng cáo mạnh. Nhóm **xanh** mới trống thường tự có khách, chưa cần can thiệp.
- **Đọc cột Trạng thái trước khi trách "sao ế"**: nếu một phòng nằm trong danh sách nhưng đang **bảo trì**, nó chưa thật sự cho thuê được — đừng tính nó như phòng ế bình thường.
- **Phòng "biến mất" sau khi nhận cọc là bình thường**: khi bạn ghi một phiếu cọc giữ chỗ, phòng chuyển sang nhóm "Đã cọc" và rời khỏi báo cáo Phòng trống — không phải lỗi.
- **Muốn nhìn phòng SẮP trống** (chưa trống nhưng hợp đồng sắp hết hạn) thì xem báo cáo [Hợp đồng sắp hết hạn](/04-bao-cao/hd-sap-het-han/) — báo cáo Phòng trống chỉ đếm phòng **đã** trống.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/real-estate/vacant-rooms" app-label="Mở báo cáo Phòng trống" fixtures="Tòa DEMO A/B; 8 phòng đang thuê; A301/A302 đang cọc giữ chỗ" view-only>

Bài này **chỉ xem** — mục tiêu là *hãy nhìn thấy* cách hệ thống phân loại "trống thật" so với "đang thuê" và "đã cọc":

1. Mở báo cáo và đọc thẻ **Tổng số căn hộ trống** của Tòa DEMO A/B — đây là những phòng cho thuê được ngay.
2. *Hãy nhìn thấy* rằng các phòng đang có hợp đồng còn hiệu lực **không** nằm trong bảng: ví dụ A103 (sắp hết hạn ~21 ngày), A104 (đã gia hạn) và A105 (có khuyến mãi) đều đang thuê nên **vắng mặt** ở đây.
3. *Hãy nhìn thấy* rằng **A301 và A302** — hai phòng đang **cọc giữ chỗ** — cũng **không** xuất hiện trong danh sách Phòng trống, vì đã tách sang nhóm "Đã cọc".
4. Ở cột **Số ngày trống**, để ý cách tô màu **xanh / vàng / đỏ** theo mốc 7 và 30 ngày; đối chiếu với 4 thẻ thống kê phía trên xem con số có khớp không.
5. Thử ô **Chọn toà nhà** = *Tòa DEMO B* rồi bật ô **Chọn tầng** để thu hẹp danh sách, và bấm **Xuất** thử (không bắt buộc tải về).

Kết quả mong đợi: bạn hiểu "trống" trong báo cáo này = **không có hợp đồng hiệu lực và không phải phòng đã cọc**, biết đọc **số ngày trống** để ưu tiên cho thuê, và không còn nhầm phòng đã cọc là phòng còn trống.

</SandboxTry>

## Quy trình liên quan

- [Hub Báo cáo Bất động sản](/04-bao-cao/hub-bds/) — cửa vào 8 báo cáo vận hành toà nhà, trong đó có Phòng trống.
- [Hợp đồng sắp hết hạn](/04-bao-cao/hd-sap-het-han/) — nhìn trước những phòng **sắp** trống để chuẩn bị khách thay thế.
- [Tỉ lệ lấp đầy](/04-bao-cao/lap-day/) — bức tranh tổng: bao nhiêu phần trăm phòng đang thuê / trống / đã cọc theo toà.
- [Cho thuê mới](/04-bao-cao/cho-thue-moi/) — theo dõi các hợp đồng mới ký giúp phòng trống được lấp.
- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — vì sao phòng nhận cọc giữ chỗ rời khỏi danh sách Phòng trống và nằm ở nhóm "Đã cọc".
- [Căn hộ & phòng](/03-quan-ly-van-hanh/can-ho-phong/) — quản lý trạng thái từng phòng (trống, bảo trì) hiển thị ở cột Trạng thái.
- [Tạo tầng & phòng](/01-bat-dau/tao-tang-phong/) — khai báo toà, tầng, phòng để báo cáo có dữ liệu.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — hành trình từ phòng trống đến khi ký hợp đồng cho thuê.
