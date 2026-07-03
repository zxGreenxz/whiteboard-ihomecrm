---
title: "Hoàn cọc, bỏ cọc & Nhật ký hoàn cọc"
description: "Hiểu và tra soát hai cách tất toán tiền cọc khi khách rời đi — hoàn cọc (trả lại khách) và bỏ cọc (cọc thành doanh thu) — qua Nhật ký hoàn cọc và tab Hoàn / Bỏ cọc."
routes: ["/finance/refund-log", "/deposits"]
permissions: [{module: deposits, action: view}]
viewport: desktop
audience: [ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Hoàn cọc, bỏ cọc & Nhật ký hoàn cọc

Khi một khách rời đi, phần tiền cọc phải được tất toán theo một trong hai cách: **hoàn cọc** (trả lại khách phần còn dư sau khấu trừ) hoặc **bỏ cọc** (khách mất cọc, cọc chuyển thành doanh thu). Trang này giúp bạn **hiểu bản chất** hai cách đó, **tra soát** từng khoản đã tất toán qua **Nhật ký hoàn cọc** và đối chiếu với dữ liệu cọc ở màn Đặt cọc. Bản thân màn Nhật ký chỉ để **xem và đối chiếu** — thao tác hoàn/bỏ cọc thực sự phát sinh khi bạn **thanh lý hợp đồng**.

::: info Điều kiện tiên quyết
- Quyền **Đặt cọc => Xem** (module `deposits`, action `view`) để mở Nhật ký hoàn cọc và tab **Hoàn / Bỏ cọc**.
- Đã có ít nhất một **hợp đồng đã thanh lý** (hoàn hoặc bỏ cọc) để nhật ký có dữ liệu, và **sổ quỹ** nơi tiền cọc chảy vào (xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/)).
- Là nhân viên, bạn chỉ thấy các khoản hoàn/bỏ cọc thuộc **những toà được gán phạm vi** cho mình.
:::

## Hướng dẫn từng bước

**Bước 1**: Nắm rõ hai cách tất toán cọc trước khi tra soát. Cả hai đều **phát sinh khi thanh lý hợp đồng**, không phải thao tác riêng trên trang này:

- **Hoàn cọc**: khách không thuê tiếp / huỷ giữ chỗ / thanh lý bình thường và còn cọc phải trả lại. Số hoàn = **Cọc gốc − Tổng nợ tất toán**, có thể xuống **âm** khi khách nợ nhiều hơn cọc (khi đó hiển thị "Khách nợ …").
- **Bỏ cọc** (forfeit): khách mất cọc, cọc **chuyển thành doanh thu**. Hệ thống chỉ chuyển thành doanh thu **phần cọc khách đã thực đóng** (không tính phần khách còn nợ), và huỷ mọi hoá đơn còn nợ của hợp đồng.

::: danger Hoàn cọc và bỏ cọc là thao tác ghi tiền vào sổ
Khi thanh lý hợp đồng, **hoàn cọc** chi tiền thật ra khỏi sổ quỹ để trả khách, còn **bỏ cọc** tạo phiếu chuyển phần cọc đã thu thành **doanh thu** (qua cặp phiếu chờ duyệt, tất toán bằng phương thức **Cấn trừ**). Đây là tiền thật đi vào/ra sổ và **rất khó hoàn tác** sau khi duyệt — hãy chỉ thực hiện trong luồng thanh lý hợp đồng, sau khi đã đối chiếu kỹ số cọc.
:::

**Bước 2**: Mở **Nhật ký hoàn cọc**. Từ khu **Tài chính => Sổ quỹ**, mở chi tiết một sổ quỹ liên quan rồi chọn **Xem giao dịch** — với sổ ghi nhận hoàn/bỏ cọc, hệ thống đưa bạn tới màn Nhật ký (đường dẫn `/finance/refund-log`). Đây là **nhật ký chỉ-đọc** liệt kê các phiếu của sổ theo thời gian, kèm ba thẻ thống kê nhanh: **tổng số tiền**, **số phiếu** và **trung bình mỗi phiếu**.

![Màn Nhật ký hoàn cọc với thẻ thống kê tổng tiền, số phiếu và bảng phiếu chỉ-đọc](./images/buoc-01-nhat-ky.webp)

**Bước 3**: Đọc một dòng trong nhật ký. Mỗi dòng gồm **Mã phiếu**, **Ngày**, **Hóa đơn** (ấn vào để mở hoá đơn liên quan), **Tòa nhà**, **Phòng**, **Số tiền** và **Ghi chú**. Dùng ô **Kỳ** ở đầu trang để đổi khoảng thời gian: **Tháng này**, **Tháng trước**, **Năm nay** hoặc **Tùy chỉnh** (chọn **Từ ngày** / **Đến ngày**). Nút **Quay lại sổ quỹ** đưa bạn trở về danh sách sổ.

**Bước 4**: Đối chiếu với tab **Hoàn / Bỏ cọc** ở màn **Đặt cọc**. Vào **Đặt cọc** => tab **Hoàn / Bỏ cọc** để xem bảng tổng hợp theo từng lần thanh lý: cột **Ngày**, **Toà / Phòng / Khách** (ấn vào mở hợp đồng), **Loại** (badge đỏ **Bỏ cọc** hay xám **Hoàn cọc**), **Cọc gốc**, **Tổng nợ tất toán** và **Còn nợ / Hoàn lại**. Đây là góc nhìn nghiệp vụ đầy đủ nhất của một khoản hoàn/bỏ cọc.

::: warning "Tổng nợ tất toán" KHÔNG bị trừ vào cọc
Cột **Tổng nợ tất toán** là **tổng khoản khách còn nợ** khi thanh lý (tiền phòng, phí phạt, thu thêm…), hiển thị để bạn hình dung bức tranh nợ — nó **không tự động trừ vào cọc**. Việc cấn nợ vào cọc được xử lý riêng trong luồng thanh lý hợp đồng. Đừng cộng/trừ thủ công hai con số này.
:::

**Bước 5**: Đối chiếu tổng số ở tab **Tổng quan**. Vẫn trong màn **Đặt cọc**, tab **Tổng quan** có hai thẻ **Đã hoàn cọc** (tổng số đã trả lại khách và số lần) và **Đã bỏ cọc** (tổng cọc đã chuyển thành doanh thu và số lần). Con số này khớp với các dòng bạn thấy trong tab Hoàn / Bỏ cọc, giúp bạn kiểm tra nhanh không sót khoản nào.

::: tip Nguồn sự thật là bản ghi thanh lý, không phải trạng thái phiếu cọc
Danh sách hoàn/bỏ cọc được đọc từ **các lần thanh lý hợp đồng** (bản ghi tất toán), **không** dựa vào trạng thái của phiếu đặt cọc. Vì vậy một phiếu cọc giữ chỗ cũ đổi trạng thái sẽ **không** làm sai bảng này; ngược lại, muốn thấy đầy đủ hoàn/bỏ cọc thì phải nhìn vào lịch sử thanh lý, không nhìn vào phiếu cọc.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô **Kỳ** (Nhật ký hoàn cọc) | Chọn khoảng thời gian: **Tháng này** / **Tháng trước** / **Năm nay** / **Tùy chỉnh**. |
| **Từ ngày** / **Đến ngày** | Hiện khi chọn **Tùy chỉnh** — giới hạn nhật ký theo khoảng ngày bạn nhập. |
| Thẻ thống kê (3 thẻ) | Tổng số tiền trong kỳ, tổng số phiếu và trung bình mỗi phiếu. |
| Cột **Hóa đơn** trong bảng | Ấn vào mã hoá đơn để mở chi tiết hoá đơn liên quan. |
| **Quay lại sổ quỹ** | Trở về danh sách sổ quỹ. |
| Tab **Hoàn / Bỏ cọc** (màn Đặt cọc) | Bảng nghiệp vụ đầy đủ: Cọc gốc, Tổng nợ tất toán, Còn nợ / Hoàn lại, loại **Hoàn cọc / Bỏ cọc**. |
| Thẻ **Đã hoàn cọc / Đã bỏ cọc** (tab Tổng quan) | Tổng số và số lần, để đối chiếu nhanh. |
| Ô lọc toà nhà (màn Đặt cọc) | Lọc theo **1 toà** hoặc **Tất cả toà nhà**; áp cho các tab. |

Bộ lọc **Kỳ** và khoảng ngày được **giữ lại khi bạn tải lại trang (F5)**.

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Nhật ký hoàn cọc **trống** | Kỳ đang chọn chưa có phiếu, hoặc bạn mở màn mà chưa chọn sổ quỹ cụ thể. Đổi **Kỳ** sang **Năm nay** và mở nhật ký từ đúng chi tiết một sổ quỹ. |
| Cột **Còn nợ / Hoàn lại** hiện **"Khách nợ …"** ở dòng Bỏ cọc | Đúng: khi tổng nợ tất toán lớn hơn cọc gốc, số hoàn xuống âm → khách vẫn còn nợ sau khi mất cọc. Cần thu thêm phần này qua hoá đơn/nợ, không phải lỗi. |
| Bỏ cọc nhưng **cọc thành doanh thu ít hơn** số cọc theo hợp đồng | Đúng thiết kế: bỏ cọc chỉ chuyển thành doanh thu **phần khách đã thực đóng**, không tính phần khách còn nợ cọc. |
| Số ở **Nhật ký hoàn cọc** không khớp thẻ **Đã hoàn cọc** | Hai nơi khác góc nhìn: nhật ký là **các phiếu trong một sổ quỹ theo kỳ**; thẻ tổng là **theo lần thanh lý** trên toàn phạm vi toà của bạn. Đối chiếu theo từng hợp đồng ở tab **Hoàn / Bỏ cọc** để tìm chênh. |
| Không thấy khoản hoàn/bỏ cọc của một toà | Thường do phạm vi toà: nhân viên chỉ thấy dữ liệu của toà được gán. Kiểm tra ô lọc toà (giữ qua F5) và phân quyền. |
| Muốn **thực hiện** hoàn/bỏ cọc nhưng không thấy nút trên trang này | Đúng: trang này chỉ **xem/đối chiếu**. Hoàn/bỏ cọc phát sinh khi **thanh lý hợp đồng** trong [Hợp đồng chi tiết](/03-quan-ly-van-hanh/hop-dong-chi-tiet/). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/finance/refund-log" app-label="Mở Nhật ký hoàn cọc" fixtures="A301, A302 (cọc giữ chỗ)" view-only>

Bài quan sát (không ghi dữ liệu):

1. Ở **Nhật ký hoàn cọc**, đổi ô **Kỳ** sang **Năm nay** và đọc bố cục: ba thẻ thống kê (tổng tiền / số phiếu / trung bình) và bảng phiếu chỉ-đọc với cột Mã phiếu, Ngày, Hóa đơn, Tòa nhà, Phòng, Số tiền, Ghi chú.
2. Mở màn [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) => tab **Hoàn / Bỏ cọc** và đọc một dòng: phân biệt badge **Hoàn cọc** (xám) với **Bỏ cọc** (đỏ), và ý nghĩa các cột **Cọc gốc**, **Tổng nợ tất toán**, **Còn nợ / Hoàn lại**.
3. Sang tab **Phiếu giữ chỗ** của màn Đặt cọc, để ý hai cọc giữ chỗ demo **A301** (đủ) và **A302** (quá hạn) — đây là cọc **chưa** thanh lý nên **không** xuất hiện trong nhật ký hoàn/bỏ cọc.

Kết quả mong đợi: bạn phân biệt được **hoàn cọc** với **bỏ cọc**, biết nhật ký chỉ ghi lại các khoản đã **thanh lý**, và đối chiếu được cùng một khoản giữa Nhật ký hoàn cọc và tab Hoàn / Bỏ cọc.

</SandboxTry>

## Quy trình liên quan

- [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) — trung tâm quản lý cọc; tab **Hoàn / Bỏ cọc** và **Tổng quan** là góc nhìn nghiệp vụ đầy đủ.
- [Hợp đồng chi tiết](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — nơi **thanh lý hợp đồng** sinh ra khoản hoàn/bỏ cọc.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — danh sách hợp đồng, badge trạng thái cọc.
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — sổ quỹ nơi mở Nhật ký và nơi doanh thu bỏ cọc được ghi nhận.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vị trí bước tất toán cọc trong toàn bộ vòng đời khách thuê.
