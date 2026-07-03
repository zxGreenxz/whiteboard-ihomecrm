---
title: "Báo cáo tài chính (tổng quan)"
description: "Trung tâm 12 báo cáo dòng tiền và công nợ: phân tích tài chính, sổ quỹ theo ngày, dòng tiền, công nợ HĐ mới, khách nợ tiền, lịch thanh toán, tiền thừa, danh sách cọc, bàn giao & đối soát, chu kỳ thu→bàn giao."
routes: ["/reports/finance"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo tài chính (tổng quan)

Trang này là **hub** — cửa vào chung của toàn bộ báo cáo tài chính. Bạn không đọc số ngay tại đây; hub chỉ là **lưới thẻ điều hướng** dẫn tới **12 báo cáo** về dòng tiền và công nợ: từ *Phân tích tài chính*, *Sổ quỹ theo ngày*, *Dòng tiền*, *Phân bổ lợi nhuận* cho tới *Công nợ HĐ mới*, *Khách nợ tiền*, *Lịch thanh toán*, *Tiền thừa*, *Danh sách cọc*, *Bàn giao & đối soát sổ* và *Chu kỳ Thu → Bàn giao*. Bấm một thẻ để mở đúng báo cáo bạn cần.

Toàn bộ nhóm này là **chỉ để xem** (view-only): báo cáo tổng hợp lại số liệu đã ghi ở các màn vận hành (thu chi, hoá đơn, cọc, bàn giao) chứ **không** sửa dữ liệu. Người xem thường là **chủ nhà, kế toán, quản lý toà** — ai theo dõi tiền vào/ra, ai còn nợ, đã bàn giao được bao nhiêu và lợi nhuận từng toà ra sao.

Một nguyên tắc quan trọng để đọc số cho đúng: **sổ quỹ, dòng tiền, phân bổ lợi nhuận và phân tích tài chính đều lấy chung một nguồn duy nhất là các phiếu thu chi đã DUYỆT** (không cộng thêm bảng thanh toán/chi phí nào khác để tránh đếm trùng). Còn nhóm công nợ/lịch thu/tiền thừa lấy từ **hoá đơn**. Vì vậy con số "doanh thu" trên báo cáo dòng tiền (tiền thực thu) có thể khác con số "công nợ" (tiền còn phải thu trên hoá đơn) — đó là chủ ý, không phải lỗi.

::: info Điều kiện tiên quyết
- Quyền xem **Báo cáo tài chính** (`reports_finance.view`) — thường là chủ nhà hoặc kế toán. Mỗi thẻ báo cáo còn có quyền riêng của nó (ví dụ Phân tích tài chính, Sổ quỹ theo ngày, Bàn giao & đối soát…); nếu thiếu quyền một báo cáo cụ thể, thẻ đó sẽ không mở được dù bạn vào được hub.
- Riêng **Chu kỳ Thu → Bàn giao** mở được cả với người **được giao thu tiền** (quyền `invoices.record_payment`) — họ tự xem chu kỳ của **chính mình** kể cả khi chưa được bật các báo cáo tài chính khác.
- Đã có dữ liệu để tổng hợp: vài phiếu thu chi đã duyệt, hoá đơn đã phát hành, và (nếu xem cọc/bàn giao) phiếu cọc, phiên bàn giao. Trong bản demo đã có sẵn: 8 phòng đang thuê ở **DEMO A/B**, hoá đơn **A102** còn nợ **2.570.000đ**, hoá đơn **A105** quá hạn **6.070.000đ**, hai phòng cọc giữ chỗ **A301/A302** và cơ cấu **2 cổ đông 60/40**.
:::

## Cách mở

**Bước 1**: Vào **Báo cáo** => **Tài chính**. Hệ thống mở hub **Báo cáo tài chính** — một lưới 12 thẻ, mỗi thẻ là một báo cáo với tên và mô tả ngắn. Đây là trang điều hướng thuần tuý: chưa có số liệu, bạn chỉ chọn báo cáo muốn xem.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

**Bước 2**: Bấm vào thẻ báo cáo cần xem. Hệ thống chuyển sang đúng trang báo cáo đó; tại trang con, bạn mới chọn **bộ lọc** (tháng, toà nhà, tài khoản…) và đọc bảng số/biểu đồ. Muốn xem báo cáo khác, quay lại hub bằng menu **Báo cáo** => **Tài chính**.

## Bộ lọc & cách đọc số

Bản thân hub **không có bộ lọc** — mọi bộ lọc nằm bên trong từng báo cáo con. Điểm chung của các bộ lọc đó (đã đồng bộ toàn app):

- **Ô lọc toà** là combobox **đơn-chọn phẳng** (gõ để tìm), để trống = **tất cả toà**. Vài báo cáo (Sổ quỹ theo ngày, Dòng tiền, Phân bổ lợi nhuận) còn có thêm toà ảo **Chung** cho khoản dùng chung của cổ đông.
- **Bộ lọc được giữ qua F5**: chọn tháng/toà/toggle xong tải lại trang vẫn còn nguyên (lưu theo phiên trình duyệt).
- Một số báo cáo (Sổ quỹ theo ngày) có thêm ô lọc **tài khoản** (sổ quỹ); nhóm công nợ hoá đơn lọc theo toà ngay trên danh sách.

Bảng dưới đây là **12 thẻ trên hub** — đọc cột "Cho bạn biết gì" để chọn đúng báo cáo:

| Thẻ báo cáo (chỉ số) | Cho bạn biết gì & khi nào mở |
| --- | --- |
| **Phân tích tài chính** | Bức tranh tổng: 5 tab (Tổng quan · Doanh thu · Chi phí · Lợi nhuận · Vận hành) với KPI, xu hướng 13 tháng để so cùng kỳ năm trước, và các "insight" gợi ý. Mở khi cần nhìn toàn cảnh sức khoẻ tài chính. Xem [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/). |
| **Sổ quỹ theo ngày** | Số dư đầu ngày → cuối ngày của từng sổ quỹ, lọc theo toà và tài khoản. Mở khi cần đối chiếu tồn quỹ theo mốc ngày. Xem [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/). |
| **Dòng tiền** | Thu − chi gom theo **12 tháng và 4 quý** của một năm. Mở khi cần nhìn xu hướng tiền vào/ra theo tháng. Xem [Dòng tiền](/04-bao-cao/dong-tien/). |
| **Phân bổ lợi nhuận** | Lãi/lỗ từng toà theo hạng mục; mặc định **phân bổ theo kỳ áp dụng** (khoản trải nhiều tháng được chia đều) và chỉ tính phần **kết quả kinh doanh** (tiền cọc không tính là doanh thu). Mở khi chốt lãi lỗ và chia cho cổ đông. Xem [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/). |
| **Chia LN cổ đông** | Cùng vào trang Phân bổ lợi nhuận (đã gộp): phần chia lãi theo tỉ lệ góp vốn — bản demo là **2 cổ đông 60/40**. Xem [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/). |
| **Công nợ HĐ mới** | Tổng tiền còn phải thu trên hoá đơn, tách theo **tuổi nợ** 0-30 / 31-60 / 61-90 / trên 90 ngày. Mở khi cần thấy nợ đang già đi tới đâu. Xem [Công nợ HĐ mới](/04-bao-cao/cong-no-hd-moi/). |
| **Khách nợ tiền** | Gom nợ **theo từng khách**: mỗi khách một dòng với tổng còn thiếu. Mở khi cần biết *ai* đang nợ để nhắc thu. Xem [Khách nợ tiền](/04-bao-cao/khach-no-tien/). |
| **Lịch thanh toán** | Gom **theo phòng**: mỗi phòng đã được lên hoá đơn tới ngày nào, giúp thấy phòng nào sắp/đang tới hạn. Xem [Lịch thanh toán](/04-bao-cao/lich-thanh-toan/). |
| **Tiền thừa** | Các hoá đơn khách đã trả **nhiều hơn** số phải trả (trả dư/trả trước) — ứng viên cần hoàn hoặc bù sang kỳ sau. |
| **Danh sách cọc** | Toàn bộ khoản cọc: đang giữ, đã vào hợp đồng, đã hoàn/đã bỏ. Bản demo có hai cọc giữ chỗ **A301/A302**. Xem [Danh sách cọc](/04-bao-cao/danh-sach-coc/). |
| **Bàn giao & đối soát sổ** | Theo từng sổ: thu/chi thực trong kỳ, đã bàn giao cho chủ bao nhiêu, và **số dư hiện tại = còn phải nộp**; kèm chức năng chốt số (đối soát). Xem [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/). |
| **Chu kỳ Thu → Bàn giao** | Với người thu tiền: mỗi mốc bàn giao chốt lại số **chưa thu tại thời điểm đó** trên các toà phụ trách. Mở khi đối soát vòng thu → nộp. Xem [Chu kỳ Thu → Bàn giao](/04-bao-cao/thu-ban-giao/). |

::: tip Đọc "công nợ" và "dòng tiền" là hai lăng kính khác nhau
**Công nợ / Khách nợ / Lịch thu / Tiền thừa** đọc từ **hoá đơn** — trả lời "khách còn phải trả bao nhiêu". **Sổ quỹ / Dòng tiền / Phân bổ lợi nhuận / Phân tích tài chính** đọc từ **phiếu thu chi đã duyệt** — trả lời "thực tế đã có/đã tiêu bao nhiêu tiền". Đừng kỳ vọng hai bên khớp từng đồng: một hoá đơn chưa thu thì có trong công nợ nhưng chưa vào dòng tiền.
:::

## Nguồn số liệu

- **Nhóm phiếu thu chi** (Sổ quỹ theo ngày, Dòng tiền, Phân bổ lợi nhuận, Phân tích tài chính) tổng hợp từ **các phiếu thu/chi đã DUYỆT** (một nguồn duy nhất, đã loại phiếu nháp/đã xoá và phiếu chuyển nội bộ). Vì lấy chung nguồn nên các báo cáo này nhất quán với màn [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) và [Thu chi](/03-quan-ly-van-hanh/thu-chi/).
- **Nhóm hoá đơn** (Công nợ HĐ mới, Khách nợ tiền, Lịch thanh toán, Tiền thừa) lấy từ **hoá đơn** đã phát hành: phần còn thiếu = tổng hoá đơn − đã thu; tiền thừa = đã thu vượt tổng.
- **Danh sách cọc** lấy từ dữ liệu **cọc**; **Bàn giao & đối soát** lấy từ số dư **sổ quỹ** + các **phiên bàn giao** đã xác nhận; **Chu kỳ Thu → Bàn giao** ghép tiền đã thu vào các mốc bàn giao theo phạm vi toà bạn phụ trách.
- Các báo cáo tính bằng máy chủ (Phân tích tài chính, Sổ quỹ, Bàn giao, Chu kỳ) **tính đủ cả phiếu do nhân viên tạo** — chúng gom theo **toà bạn được phép xem** chứ không lọc theo người tạo, nên số không bị hụt khi nhân viên là người ghi phiếu.

::: warning Vài báo cáo có "điểm mù" đã biết — đọc con số kèm bối cảnh
- **Lịch thanh toán** và **Tiền thừa** hiện **chưa loại** hoá đơn nháp/huỷ/đã xoá mềm khi quét, nên một dòng "tiền thừa cần hoàn" có thể đến từ hoá đơn đã huỷ. Hãy đối chiếu lại hoá đơn gốc trước khi hành động (hoàn tiền, xoá nợ).
- **Danh sách cọc** phân loại theo trạng thái lưu trên bản ghi cọc; con số này có thể lệch nhẹ so với trang [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) vốn tính theo cọc còn lại thực tế. Khi cần chốt cọc từng hợp đồng, tin theo màn Đặt cọc.
:::

## Xuất & mẹo

- **Chọn báo cáo trước, lọc sau**: hub chỉ để điều hướng; vào trang con rồi mới đặt tháng/toà/tài khoản. Bộ lọc được nhớ qua lần tải lại nên bạn không phải chọn lại mỗi lần vào.
- **Xuất dữ liệu**: các báo cáo dạng bảng có nút xuất/ tải về ngay trên trang con (ví dụ Phân tích tài chính, Công nợ, Danh sách cọc). Nếu cần số liệu cho bảng tính, mở đúng báo cáo rồi xuất tại đó — hub không có nút xuất chung.
- **Đối chiếu chéo cho nhanh**: thấy một khách nợ ở *Khách nợ tiền* → mở *Công nợ HĐ mới* để xem nợ đó già bao lâu → sang [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) để thu.
- **Cuối tháng**: bộ ba *Dòng tiền* + *Bàn giao & đối soát* + *Phân bổ lợi nhuận* là mạch chốt sổ và chia lãi; xem thứ tự việc ở [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/).
- **"Chốt số" ở Bàn giao là đối soát, không chuyển tiền**: thao tác chốt chỉ ghi nhận đã đối chiếu số dư sổ, không làm dịch chuyển tiền thật.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/finance" app-label="Mở hub Báo cáo tài chính" view-only>

1. Ở hub **Báo cáo tài chính**, hãy nhìn thấy **lưới 12 thẻ** báo cáo: Phân tích tài chính, Sổ quỹ theo ngày, Dòng tiền, Phân bổ lợi nhuận, Công nợ HĐ mới, Khách nợ tiền, Lịch thanh toán, Tiền thừa, Danh sách cọc, Bàn giao & đối soát, Chu kỳ Thu → Bàn giao…
2. Bấm thẻ **Khách nợ tiền**: hãy nhìn thấy khách **Nguyễn Văn A** với khoản còn thiếu — tương ứng hoá đơn **A102 nợ 2.570.000đ** và **A105 quá hạn 6.070.000đ** trong dữ liệu demo.
3. Quay lại hub, bấm **Công nợ HĐ mới**: hãy nhìn thấy hai khoản nợ trên được xếp vào các cột **tuổi nợ** (khoản A105 quá hạn nằm ở nhóm nợ già hơn).
4. Quay lại hub, bấm **Danh sách cọc**: hãy nhìn thấy hai cọc giữ chỗ **A301** và **A302** ở nhóm "đang giữ".

Kết quả mong đợi: bạn hiểu hub chỉ là **cửa điều hướng** — mỗi thẻ mở một báo cáo chuyên biệt, và cùng một khoản nợ demo (A102/A105) hiện lên đúng ở cả *Khách nợ tiền* lẫn *Công nợ HĐ mới* dưới hai lăng kính khác nhau.

</SandboxTry>

## Quy trình liên quan

- [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/) — bức tranh tổng KPI, doanh thu, chi phí, lợi nhuận, vận hành.
- [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/) và [Dòng tiền](/04-bao-cao/dong-tien/) — tồn quỹ theo mốc ngày và xu hướng thu/chi theo tháng, quý.
- [Công nợ HĐ mới](/04-bao-cao/cong-no-hd-moi/), [Khách nợ tiền](/04-bao-cao/khach-no-tien/), [Lịch thanh toán](/04-bao-cao/lich-thanh-toan/) — ba lăng kính về tiền còn phải thu.
- [Danh sách cọc](/04-bao-cao/danh-sach-coc/) — theo dõi mọi khoản cọc; [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) là màn vận hành cọc.
- [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) và [Chu kỳ Thu → Bàn giao](/04-bao-cao/thu-ban-giao/) — chốt số sổ và vòng thu → nộp.
- [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) — phân bổ lãi lỗ từng toà và chia cho cổ đông.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/), [Quy trình bàn giao](/01-bat-dau/quy-trinh-ban-giao/), [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/) — các mạch nghiệp vụ tạo ra số liệu cho báo cáo.
- [Báo cáo bất động sản (tổng quan)](/04-bao-cao/hub-bds/) — hub báo cáo vận hành phòng/hợp đồng, song song với hub tài chính.
