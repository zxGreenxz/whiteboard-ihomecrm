---
title: "Báo cáo: Thanh lý / bỏ trả"
description: "Danh sách hợp đồng đã thanh lý (khách rời phòng) hoặc hết hạn trong kỳ, kèm lý do, tiền cọc và tỷ lệ bỏ trả để bạn theo dõi biến động khách thuê."
routes: ["/reports/real-estate/terminations"]
permissions: [{module: reports_real_estate, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Thanh lý / bỏ trả

Báo cáo này liệt kê những **hợp đồng đã kết thúc trong kỳ** — cả khách **rời phòng đúng quy trình** (thanh lý), khách **bỏ ngang** và hợp đồng **hết hạn** — để bạn nhìn nhanh xem *ai đã trả phòng*, *phòng nào vừa trống*, *vì lý do gì* và *đang giữ bao nhiêu tiền cọc* của những hợp đồng đó. Đầu trang có bốn thẻ số tổng hợp, trong đó có **Tỷ lệ bỏ trả** so với tổng số hợp đồng — một chỉ số sức khoẻ để chủ nhà, kế toán và quản lý toà theo dõi mức độ khách rời đi. Đây là **trang chỉ để xem** (view-only): mọi con số ở đây được tổng hợp lại từ hợp đồng và không ghi/sửa gì khi bạn mở.

::: info Điều kiện tiên quyết
- Bạn cần quyền **xem Báo cáo BĐS** (module `reports_real_estate`, action `view`) để mở được trang này trong nhóm **Báo cáo Bất động sản**.
- Báo cáo chỉ hiển thị dữ liệu **trong phạm vi toà nhà bạn được phân công** — chủ nhà thấy toàn hệ thống, nhân viên thấy theo phạm vi được cấp.
- Muốn có số liệu để xem, phải đã có hợp đồng **kết thúc** (đã [thanh lý — khách rời phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/), [khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/) hoặc hợp đồng hết hạn).
:::

## Cách mở

**Bước 1**: Trên menu chính, vào **Báo cáo** => **Bất động sản** (lưới [Báo cáo Bất động sản](/04-bao-cao/hub-bds/)) => bấm thẻ **Bỏ trả / thanh lý**. Trang **Báo cáo Bỏ trả** mở ra với bốn thẻ số ở đầu, hàng bộ lọc (Toà nhà + Khoảng ngày), rồi bảng **Danh sách hợp đồng thanh lý** bên dưới.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

Hàng đầu trang có **hai bộ lọc**, ngay dưới là **bốn thẻ số** và **bảng chi tiết**. Ý nghĩa từng phần:

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Bộ lọc **Toà nhà** | Ô gõ-để-tìm (mặc định **Tất cả toà nhà**). Chọn một toà (ví dụ *Tòa DEMO A*) để chỉ xem hợp đồng đã kết thúc của toà đó. |
| Bộ lọc **Khoảng ngày** | Lọc theo **ngày kết thúc thực tế** của hợp đồng. Mặc định từ **đầu tháng này** đến **hôm nay** — mở rộng khoảng ngày để thấy các hợp đồng đã kết thúc từ trước. |
| Thẻ **HĐ thanh lý** | Tổng số hợp đồng đã kết thúc (thanh lý + hết hạn) rơi vào kỳ đang lọc. |
| Thẻ **Thanh lý sớm** | Số hợp đồng **chấm dứt trước hạn** (trạng thái TERMINATED) — khách rời phòng hoặc bỏ cọc. |
| Thẻ **Hết hạn** | Số hợp đồng **kết thúc đúng hạn** (trạng thái EXPIRED). |
| Thẻ **Tỷ lệ bỏ trả** | Phần trăm số hợp đồng kết thúc trong kỳ **so với tổng số hợp đồng** đã đi vào vận hành (xem *Nguồn số liệu*). Chỉ số theo dõi mức độ khách rời đi. |
| Cột **Mã HĐ** | Số hợp đồng (ví dụ HĐ của phòng A202); nếu chưa có số thì hiển thị mã rút gọn. |
| Cột **Khách hàng** | Tên và số điện thoại khách đứng tên hợp đồng (ví dụ *Nguyễn Văn A*). |
| Cột **Căn hộ** | Tên toà và số phòng (ví dụ *Tòa DEMO A — Căn hộ A202*). |
| Cột **Ngày thanh lý** | Ngày kết thúc thực tế của hợp đồng (lấy ngày chuyển đi thật; nếu không có thì dùng ngày kết thúc theo hợp đồng). |
| Cột **Lý do** | Nhãn màu ghi lý do / loại chấm dứt (khách bỏ cọc, hết hạn…). Xem lưu ý ở *Nguồn số liệu* về những dòng để trống. |
| Cột **Tiền cọc** | Tổng tiền cọc của hợp đồng đó (ví dụ *1.000.000đ*), để đối chiếu khoản đã hoàn / đã cấn khi thanh lý. |

## Nguồn số liệu

Báo cáo **tổng hợp lại từ hợp đồng**, không phải một bảng riêng:

- **Danh sách** lấy từ các hợp đồng có trạng thái **TERMINATED** (thanh lý / chấm dứt) hoặc **EXPIRED** (hết hạn), chưa bị xoá. **Ngày thanh lý** dùng *ngày kết thúc thực tế* nếu có, nếu không thì lấy *ngày kết thúc theo hợp đồng*.
- **Cột Lý do** được ghép thêm từ bảng ghi nhận thanh lý (ghi chú / loại chấm dứt).
- **Tỷ lệ bỏ trả**: tử số = số hợp đồng kết thúc trong kỳ đang lọc; mẫu số = **tổng số hợp đồng đã đi vào vận hành** (chưa xoá, không tính hợp đồng nháp).

::: warning Lưu ý về cột "Lý do" (khoảng trống audit)
Hiện hệ thống mới ghi đầy đủ vết thanh lý cho luồng **Khách bỏ cọc** (FORFEIT). Với luồng **Khách rời phòng** (move-out đúng quy trình), bản ghi lý do có thể **không được tạo** — nên cột **Lý do** của các hợp đồng move-out thường để nhãn chung ("Thanh lý") thay vì lý do chi tiết. Đây là hạn chế đã biết: dòng vẫn có mặt và số liệu tổng vẫn đúng, chỉ riêng *lý do chi tiết của move-out* có thể trống. Muốn phân loại đầy đủ, cần đối chiếu thêm với [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) (phiếu hoàn cọc / Doanh thu thanh lý) hoặc chi tiết từng hợp đồng.
:::

Lưu ý phạm vi: báo cáo đọc hợp đồng theo **quyền của bạn** rồi mới lọc toà; nếu bạn chỉ được cấp một vài toà, các thẻ số và danh sách chỉ phản ánh phần bạn thấy.

## Xuất & mẹo

- Bấm **Xuất** (góc phải trên, khu tiêu đề) để tải bảng ra tệp `bao-cao-bo-tra` với đúng các cột **Mã HĐ**, **Khách hàng**, **Căn hộ**, **Ngày thanh lý**, **Lý do**, **Tiền cọc** — tiện gửi chủ nhà hoặc lưu hồ sơ cuối tháng.
- **Mở rộng Khoảng ngày** (ví dụ cả năm) để rà lại toàn bộ hợp đồng đã kết thúc, không chỉ trong tháng hiện tại.
- Đổi **Toà nhà** để soi tỷ lệ bỏ trả của từng toà riêng — hữu ích khi so sánh sức khoẻ giữa **Tòa DEMO A** và **Tòa DEMO B**.
- Bộ lọc **được giữ nguyên khi bạn F5** (làm mới trang), nên bạn không phải chọn lại toà/khoảng ngày.
- Muốn xem **dòng tiền** phát sinh khi thanh lý (hoàn cọc, Doanh thu thanh lý), đối chiếu sang [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) và [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/).

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/real-estate/terminations" app-label="Mở báo cáo Bỏ trả / thanh lý" view-only>

Bài xem **an toàn** — trang này chỉ để đọc, bạn không ghi/sửa gì:

1. Mở báo cáo **Bỏ trả / thanh lý** (nhóm **Báo cáo BĐS**).
2. Hãy nhìn thấy **bốn thẻ số** ở đầu trang: **HĐ thanh lý**, **Thanh lý sớm**, **Hết hạn** và **Tỷ lệ bỏ trả** — trong dữ liệu demo phần lớn phòng vẫn đang thuê nên các con số này thường nhỏ.
3. Hãy nhìn thấy **hai bộ lọc**: ô **Toà nhà** (đang là *Tất cả toà nhà*, chọn thử *Tòa DEMO A*) và **Khoảng ngày** (đang từ đầu tháng đến hôm nay).
4. **Mở rộng Khoảng ngày** ra vài tháng: nếu lớp học đã thử [thanh lý phòng A202](/03-quan-ly-van-hanh/thanh-ly-move-out/) ở bài trước, hãy nhìn thấy hợp đồng **A202 — Tòa DEMO A** hiện ra trong bảng với cột **Ngày thanh lý**, **Lý do** và **Tiền cọc**. Nếu chưa có hợp đồng nào kết thúc, bảng báo *Không có hợp đồng thanh lý nào trong kỳ này* — đúng thiết kế.
5. Bấm **Xuất** để thấy hệ thống tạo tệp `bao-cao-bo-tra` (không ghi gì vào dữ liệu).

Kết quả mong đợi: bạn đọc được trang báo cáo — hiểu **bốn thẻ số**, ý nghĩa từng **cột**, và cách **khoảng ngày + toà nhà** quyết định những hợp đồng đã kết thúc nào được đưa vào.

</SandboxTry>

## Quy trình liên quan

- [Thanh lý — Khách rời phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/) — luồng tạo ra các dòng trong báo cáo này (khách trả phòng đúng quy trình).
- [Thanh lý — Khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/) — luồng khách bỏ ngang, giữ cọc làm phí phạt; đây là nhóm có lý do được ghi vết đầy đủ.
- [Quy trình thanh lý](/01-bat-dau/quy-trinh-thanh-ly/) — bức tranh tổng quát về hai hình thức thanh lý hợp đồng.
- [Hoàn/bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — theo dõi tiền cọc, hoàn cọc và bỏ cọc theo hợp đồng.
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — nơi xem phiếu hoàn cọc và Doanh thu thanh lý phát sinh khi thanh lý.
- [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) — Doanh thu thanh lý vào KQKD, ảnh hưởng phân bổ lợi nhuận cổ đông.
- [Báo cáo HĐ sắp hết hạn](/04-bao-cao/hd-sap-het-han/) — nhìn trước những hợp đồng sắp kết thúc để chuẩn bị.
- [Báo cáo Gia hạn / chuyển nhượng](/04-bao-cao/gia-han-chuyen-nhuong/) — mặt còn lại: khách ở tiếp thay vì rời đi.
- [Báo cáo Phòng trống](/04-bao-cao/phong-trong/) — những phòng vừa trống sau khi thanh lý xong.
