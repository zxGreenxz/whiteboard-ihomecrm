---
title: "Chi tiết, in hoá đơn & QR tra cứu"
description: "Xem toàn bộ một hoá đơn — các khoản thu, lịch sử thanh toán, nợ cũ, lịch sử chỉnh sửa — rồi in theo mẫu có chữ ký và tạo mã QR cho khách tự tra cứu công khai."
routes: ["/invoices/:id", "/invoices/print/:id", "/c/:code"]
permissions: [{module: invoices, action: view}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Chi tiết, in hoá đơn & QR tra cứu

Màn **Chi tiết hoá đơn** cho bạn xem đầy đủ một hoá đơn của phòng trong một kỳ: các khoản thu (tiền phòng, điện, nước, dịch vụ), tóm tắt đã thu — còn lại, lịch sử từng lần thanh toán, nợ cũ kỳ trước, và lịch sử chỉnh sửa. Từ đây bạn cũng **in hoá đơn** theo mẫu có chữ ký để giao khách, và tạo **mã QR hợp đồng** trỏ về một trang công khai để khách tự quét xem hoá đơn mới nhất mà không cần đăng nhập.

::: info Điều kiện tiên quyết
- Quyền **Hoá đơn => Xem** (module `invoices`, action `view`) để mở màn chi tiết.
- Đã có **hoá đơn** trong hệ thống — hoá đơn được tạo ở luồng [Sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/) hoặc màn [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).
- Muốn **in** cần ít nhất một **mẫu in hoá đơn** đã cấu hình; muốn khách quét **QR** thì hợp đồng phải còn hiệu lực (hợp đồng đã thanh lý sẽ không mở được trang công khai).
- Là nhân viên, bạn chỉ xem được hoá đơn của các toà nhà thuộc phạm vi được gán cho mình.
:::

## Hướng dẫn từng bước

**Bước 1**: Mở chi tiết một hoá đơn. Từ màn [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/), ấn vào một dòng hoá đơn (ví dụ **A101 / Tòa DEMO A - 07/2026**) để vào trang chi tiết. Đầu trang là tên khoản lớn nhất của hoá đơn kèm phòng và kỳ (**TIỀN PHÒNG - A101/Tòa DEMO A - 07/2026**), số hoá đơn (**INV-2026-00001**) và một badge trạng thái ở góc phải — **Đã thanh toán** khi hoá đơn đã thu đủ.

![Trang chi tiết hoá đơn A101/Tòa DEMO A kỳ 07/2026: panel Thông tin hoá đơn, Tóm tắt thanh toán, bảng Chi tiết các khoản thu, nút In hoá đơn và QR hợp đồng](./images/buoc-01-chi-tiet.webp)

**Bước 2**: Đọc panel **Thông tin hoá đơn** bên trái. Ở đây có **Số hoá đơn**, **Hợp đồng**, **Khách hàng** và **Số điện thoại**, **Căn hộ** (toà + phòng), **Kỳ thanh toán** (billing month), **Ngày phát hành**, **Hạn thanh toán** và **Ghi chú**. Nếu hoá đơn quá hạn, hạn thanh toán và badge sẽ được tô cảnh báo.

**Bước 3**: Đọc panel **Tóm tắt thanh toán** bên phải để nắm nhanh dòng tiền của hoá đơn:

- **Tổng tiền hoá đơn** = tạm tính các khoản − giảm trừ + nợ cũ kỳ trước, **đã làm tròn** về bội số 1.000đ (phần lẻ nhỏ hơn 1.000đ được làm tròn ngay khi lập, khách không phải trả tiền lẻ).
- **Đã thanh toán net** = số thực đã thu, **đã trừ tiền thối** nếu có. Con số này là số ròng — bạn không cần tự trừ lại tiền thối lần nữa.
- **Còn lại** = Tổng tiền − Đã thanh toán net. Bằng **0đ** nghĩa là đã thu đủ.

::: tip "Net" nghĩa là đã trừ tiền thối
Khi thu tiền mặt có trả lại tiền thối cho khách, hệ thống chỉ ghi tiền thối vào một sổ ghi nhận (ledger) để đối soát, còn **Đã thanh toán net** đã là số ròng thực nhận. Vì vậy tổng thu trên hoá đơn luôn khớp với số tiền thật vào sổ quỹ.
:::

**Bước 4**: Xem bảng **Chi tiết các khoản thu**. Mỗi dòng là một khoản với **Mô tả**, **Số lượng**, **Đơn giá** và **Thành tiền**. Trong dữ liệu demo, hoá đơn A101 gồm: **Tiền nhà tháng 7/2026** (loại *Rent* — tiền phòng), **Tiền điện** (loại *Service*, kèm chỉ số kWh đầu/cuối), **Tiền nước** và **Tiền rác**. Với khoản điện/nước, phần trong ngoặc ở mô tả là **chỉ số công tơ** đầu → cuối kỳ.

::: tip Nợ cũ kỳ trước và tiền cọc gộp trong hoá đơn tháng đầu
Nếu khách còn nợ kỳ trước, phần **Nợ cũ kỳ trước** hiện thành một dòng cộng vào tổng và được truy nguồn từ hoá đơn cũ / cọc thiếu; khi hoá đơn này được thu đủ, hệ thống **tự tất toán** các hoá đơn nợ gốc đó. Riêng hợp đồng mới ký theo cách "đóng đủ", phần **cọc còn thiếu** được gộp thẳng vào hoá đơn tháng đầu dưới một khoản tên **"Tiền cọc"** — đây là khoản phải thu của hoá đơn, không phải phiếu thu lẻ.
:::

**Bước 5**: Xem **lịch sử thanh toán**. Bên dưới các khoản thu là danh sách từng lần thu gắn với hoá đơn: số tiền, ngày thu, **phương thức** (**TM** = tiền mặt, **TK** = chuyển khoản, **TT** = thanh toán — giữ nguyên mã, không dịch), và tổng hợp thu (+) / thối (−) theo từng phiếu. Ảnh chứng từ (nếu có) hiển thị kèm phiếu.

::: warning Khi thu, phần cọc được tách riêng khỏi doanh thu
Với hoá đơn tháng đầu có gộp khoản **"Tiền cọc"**, mỗi lần thu được tách thành hai hạng mục trên **cùng một phiếu thu**: phần doanh thu (tiền phòng, dịch vụ) và phần cọc. Hạng mục cọc được đánh dấu là **tiền cọc** nên **không được tính vào Kết quả kinh doanh (KQKD)** — chỉ phần doanh thu mới vào báo cáo lãi/lỗ. Bạn không cần thao tác gì thêm; hệ thống tự phân bổ theo quy ước "phủ tiền phòng/dịch vụ trước, dư mới tính vào cọc".
:::

**Bước 6**: In hoá đơn. Ấn **In hóa đơn** ở góc phải trên. Hộp thoại in cho bạn **chọn mẫu in** và tuỳ chọn **chữ ký**, rồi bung bản in/PDF để in hoặc lưu giao khách. Nếu residual sau các lần thu nhỏ hơn 10.000đ, hoá đơn đã tự được đánh dấu **Đã thanh toán** (làm tròn tiền thiếu) nên bản in thể hiện đã thu đủ.

**Bước 7**: Tạo QR cho khách tra cứu. Ấn **QR hợp đồng** ở góc phải trên để hiện mã QR. Mã này trỏ tới một **trang công khai** (đường dẫn dạng `/c/<mã>`): khách quét bằng điện thoại là xem được **hoá đơn mới nhất** của hợp đồng — các khoản thu, tổng cộng, trạng thái đã/chưa thanh toán — **mà không cần đăng nhập**. Nút QR sẽ ẩn nếu hợp đồng đã thanh lý.

::: danger Nút "Ghi nhận thanh toán / Hoàn trả khách" là thao tác ghi tiền thật
Ngoài xem và in, trang chi tiết còn có nút **Ghi nhận thanh toán** (hoặc **Hoàn trả khách** với hoá đơn thanh lý số âm). Bấm nút này sẽ **tạo phiếu thu/chi thật vào sổ quỹ** và đổi trạng thái hoá đơn — không phải thao tác chỉ xem. Chỉ dùng khi bạn thực sự đang thu tiền của khách. Hướng dẫn chi tiết luồng thu ở [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/). Trong bài thực hành ở cuối trang, **đừng bấm** nút này (hoá đơn A101 đã thu đủ).
:::

## Các tính năng khác trên màn hình

| Nút / Khu vực | Công dụng |
| --- | --- |
| **In hóa đơn** | Mở hộp thoại in: chọn mẫu in + chữ ký, bung bản in/PDF giao khách. |
| **QR hợp đồng** | Hiện mã QR trỏ trang công khai `/c/:code` để khách tự tra cứu hoá đơn mới nhất. |
| Panel **Thông tin hoá đơn** | Số HĐ, hợp đồng, khách + SĐT, căn hộ, kỳ, ngày phát hành, hạn thanh toán, ghi chú. |
| Panel **Tóm tắt thanh toán** | Tổng tiền hoá đơn, Đã thanh toán net, Còn lại + cảnh báo đã thu đủ / quá hạn. |
| Bảng **Chi tiết các khoản thu** | Từng khoản (tiền phòng, điện, nước, rác/dịch vụ) với số lượng, đơn giá, thành tiền và chỉ số công tơ. |
| Lịch sử thanh toán | Các phiếu thu gắn hoá đơn (số tiền, ngày, phương thức TM/TK/TT), tổng thu/thối. |
| Lịch sử chỉnh sửa (audit) | Nhật ký ai đổi gì, khi nào trên hoá đơn / khoản thu / phiếu thu (mở từ màn danh sách). |
| **Ghi nhận thanh toán / Hoàn trả khách** | Thu tiền hoặc hoàn trả (ghi tiền thật — xem cảnh báo ở trên). |
| Nút quay lại (mũi tên) | Trở về màn danh sách hoá đơn. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| **Khách hàng** / **Số điện thoại** hiện **N/A** | Hợp đồng chưa gắn khách đại diện hoặc thiếu SĐT. Bổ sung ở [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/); hoá đơn vẫn thu và in được bình thường. |
| Nút **QR hợp đồng** không xuất hiện | Hợp đồng đã **thanh lý** (TERMINATED) — trang công khai không mở cho hợp đồng đã kết thúc. |
| Khách quét QR báo **"Mã QR không khả dụng"** hoặc **"Phòng chưa có hoá đơn"** | Mã sai / hợp đồng đã thanh lý / hoá đơn đã xoá, hoặc hợp đồng chưa có hoá đơn nào ngoài bản nháp. Kiểm tra hợp đồng còn hiệu lực và đã có hoá đơn phát hành. |
| **Còn lại** không về 0đ dù đã thu gần đủ | Nếu phần thiếu **nhỏ hơn 10.000đ**, hệ thống vẫn đánh dấu **Đã thanh toán** (làm tròn tiền thiếu) và giữ đúng số thực thu — đây là hành vi thiết kế, không phải lỗi. |
| Không thấy nút **In hóa đơn** ra bản in | Thường do trình duyệt chặn cửa sổ bật lên (pop-up). Cho phép pop-up cho trang rồi bấm lại. |
| Không mở được chi tiết một hoá đơn của toà khác | Nhân viên chỉ xem hoá đơn trong phạm vi toà được gán. Nhờ chủ nhà/quản lý mở phạm vi nếu cần. |
| Tổng tiền lệch vài trăm đồng so với cộng tay các khoản | Tổng hoá đơn được **làm tròn về bội số 1.000đ** khi lập (phần lẻ < 1.000đ), nên có thể lệch tối đa 999đ so với phép cộng thô — đúng thiết kế. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/invoices" app-label="Mở màn Hoá đơn" fixtures="hoá đơn A101 đã thu" view-only>

Thực hành xem chi tiết, in và QR trên một hoá đơn đã thu (chỉ xem — **đừng thu lại** hoá đơn A101):

1. Trong màn **Hoá đơn**, ấn vào dòng hoá đơn phòng **A101 / Tòa DEMO A - 07/2026** để mở trang chi tiết.
2. Ở panel **Tóm tắt thanh toán**, đọc **Tổng tiền hoá đơn** (4.070.000đ), **Đã thanh toán net** và **Còn lại** (0đ vì đã thu đủ). Xuống bảng **Chi tiết các khoản thu** xem các khoản: tiền phòng, điện (kèm chỉ số kWh), nước, rác.
3. Xem **lịch sử thanh toán** bên dưới để thấy lần thu gắn hoá đơn cùng phương thức (**TM/TK/TT**).
4. Ấn **In hóa đơn**, chọn một mẫu in + chữ ký rồi xem trước bản in. Sau đó đóng lại.
5. Ấn **QR hợp đồng** để xem mã QR — hình dung khách quét mã sẽ mở trang công khai xem hoá đơn này.

Kết quả mong đợi: bạn biết cách đọc chi tiết một hoá đơn (các khoản + tóm tắt + lịch sử thanh toán), in bản giao khách theo mẫu, và tạo mã QR để khách tự tra cứu công khai.

</SandboxTry>

## Quy trình liên quan

- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) — danh sách hoá đơn, nơi bạn tìm và mở từng hoá đơn chi tiết.
- [Sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/) — tạo hoá đơn theo kỳ trước khi xem chi tiết ở đây.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — luồng ghi nhận thanh toán (TM/TK/TT, tiền thối, làm tròn tiền thiếu).
- [Thu tiền (mobile)](/03-quan-ly-van-hanh/thu-tien-mobile/) — thu tiền mặt nhanh theo lưới ô phòng trên điện thoại.
- [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — nguồn mã QR công khai (`public_code`) và thông tin khách của hoá đơn.
- [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) — cơ chế cọc còn thiếu gộp vào hoá đơn tháng đầu (khoản "Tiền cọc").
- [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) — theo dõi tiền khách trả thừa (credit) áp vào hoá đơn sau.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) — vị trí bước xem/in hoá đơn trong toàn bộ vòng thu tiền.
