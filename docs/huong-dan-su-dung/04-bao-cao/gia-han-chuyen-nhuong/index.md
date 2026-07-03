---
title: "Báo cáo: Gia hạn & chuyển nhượng"
description: "Liệt kê các hợp đồng đã gia hạn hoặc chuyển nhượng trong kỳ theo toà và khoảng ngày — để theo dõi nhịp giữ khách và biến động hợp đồng."
routes: ["/reports/real-estate/renewals-transfers"]
permissions: [{module: reports_real_estate, action: renewals_transfers}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Gia hạn & chuyển nhượng

Báo cáo này cho bạn nhìn nhanh trong một khoảng thời gian đã có **bao nhiêu hợp đồng được gia hạn** (ký tiếp, giữ nguyên khách và phòng) và **bao nhiêu hợp đồng đã chuyển nhượng** (sang tên / đổi khách đại diện). Đây là một trang **chỉ để xem** — nó tổng hợp lại các nghiệp vụ đã phát sinh chứ không tạo ra gì. Chủ nhà, kế toán và quản lý toà dùng trang này để theo dõi nhịp giữ khách (tỷ lệ ký tiếp) và nắm các biến động về chủ thể hợp đồng.

Một điểm cần nhớ khi đọc số: **hợp đồng gia hạn vẫn giữ nguyên trạng thái ACTIVE** (hệ thống đã bỏ trạng thái "EXTENDED" cũ). Dấu "đã gia hạn" được **suy ra từ các bản ghi gia hạn** (`contract_extensions`), không phải từ trạng thái hợp đồng. Vì vậy báo cáo đếm theo **số lần gia hạn**: một hợp đồng gia hạn hai lần sẽ xuất hiện thành hai dòng.

::: info Điều kiện tiên quyết
- Bạn cần quyền **Báo cáo Bất động sản → Gia hạn / chuyển nhượng** (`reports_real_estate.renewals_transfers`). Không có quyền này thì thẻ báo cáo và đường dẫn đều bị chặn.
- Phải đã có nghiệp vụ gia hạn hoặc chuyển nhượng phát sinh thì bảng mới có dữ liệu — báo cáo chỉ liệt kê, không tạo. Thao tác tạo ở [Gia hạn & chuyển phòng](/03-quan-ly-van-hanh/gia-han-chuyen-phong/).
:::

## Cách mở

**Bước 1**: Vào **Báo cáo** => **Bất động sản** => bấm thẻ **Gia hạn / chuyển nhượng**. Màn **Báo cáo Gia hạn & Chuyển nhượng** mở ra với ba thẻ tổng ở trên, một hàng bộ lọc, và bảng **Danh sách hợp đồng** bên dưới.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Bộ lọc **Chọn toà nhà** | Thu hẹp báo cáo về một toà; mặc định **Tất cả toà nhà**. Lọc theo toà của phòng trên hợp đồng. |
| Bộ lọc **Từ ngày** / **Đến ngày** | Giới hạn khoảng thời gian. Với **gia hạn**, lọc theo *ngày gia hạn*; với **chuyển nhượng**, lọc theo *ngày bắt đầu* hợp đồng. Để trống cả hai = xem toàn bộ lịch sử. |
| Thẻ **Tổng gia hạn** | Số dòng loại **Gia hạn** trong kỳ đang lọc (số lần gia hạn, không phải số hợp đồng khác nhau). |
| Thẻ **Tổng chuyển nhượng** | Số dòng loại **Chuyển nhượng** trong kỳ. |
| Thẻ **Tổng trong kỳ** | Tổng cả gia hạn và chuyển nhượng — tổng số giao dịch trong khoảng thời gian. |
| Cột **Mã HĐ** | Số hiệu hợp đồng liên quan. |
| Cột **Khách hàng** | Khách **đại diện** của hợp đồng (nếu không có đại diện thì lấy khách đầu tiên). |
| Cột **Toà nhà** / **Căn hộ** | Vị trí phòng của hợp đồng. |
| Cột **Loại** | Badge **Gia hạn** (xanh) hoặc **Chuyển nhượng** (xám) để phân biệt hai loại giao dịch. |
| Cột **Ngày** | Gia hạn = *ngày gia hạn* (mốc ký tiếp); chuyển nhượng = *ngày hợp đồng chuyển sang trạng thái chuyển nhượng*. Bảng xếp **mới nhất lên trên**. |
| Cột **Giá thuê mới** | Giá thuê sau gia hạn; nếu bản ghi gia hạn không ghi giá mới thì lấy giá thuê hiện tại của hợp đồng. Với chuyển nhượng là giá thuê của hợp đồng đã chuyển. |

## Nguồn số liệu

- **Phần "Gia hạn"** lấy từ bảng bản ghi gia hạn (`contract_extensions`) có trạng thái **APPROVED** hoặc **COMPLETED**, và chỉ tính các hợp đồng **chưa bị xoá**. Vì hợp đồng gia hạn giữ nguyên **ACTIVE**, đây mới là nguồn sự thật cho dấu "đã gia hạn" — báo cáo và chip "đã gia hạn" trên trang hợp đồng dùng chung nguồn này.
- **Phần "Chuyển nhượng"** lấy từ các hợp đồng có trạng thái **TRANSFERRED** (sang tên / đổi khách đại diện). Lưu ý: thao tác **chuyển phòng** đời mới (chuyển khách sang phòng khác) **giữ nguyên trạng thái ACTIVE** nên **không** hiện ở cột Chuyển nhượng — chỉ những hợp đồng thực sự chuyển sang trạng thái TRANSFERRED mới xuất hiện.
- Báo cáo **đọc trực tiếp** từ dữ liệu hiện tại (không phải ảnh chụp cố định): mỗi lần bạn đổi toà hoặc đổi khoảng ngày là hệ thống truy vấn lại. Bộ lọc toà được áp sau khi gộp cả hai danh sách; khoảng ngày áp trực tiếp lên từng nguồn.

## Xuất & mẹo

- Nút **Xuất** ở góc phải trên cùng cho phép tải cả danh sách (đủ bảy cột: Mã HĐ, Khách hàng, Toà nhà, Căn hộ, Loại, Ngày, Giá thuê mới) ra file, tên gợi ý `bao-cao-gia-han-chuyen-nhuong`.
- **Bộ lọc giữ qua F5**: toà và khoảng ngày bạn chọn được nhớ lại khi mở lại trang trong cùng phiên — không phải chọn lại từ đầu.
- Muốn xem **toàn bộ lịch sử**, để trống cả **Từ ngày** và **Đến ngày**. Muốn đối chiếu nhịp giữ khách từng tháng, đặt **Từ ngày / Đến ngày** theo mốc đầu và cuối tháng.
- Đọc trang này cùng [HĐ sắp hết hạn](/04-bao-cao/hd-sap-het-han/) để thấy trọn vòng giữ khách: hợp đồng **sắp hết hạn** → nhắc khách → **gia hạn** → xuất hiện tại đây.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/real-estate/renewals-transfers" app-label="Mở báo cáo Gia hạn & Chuyển nhượng" fixtures="Tòa DEMO A/B; hợp đồng căn A104 của Nguyễn Văn A đã gia hạn, giá thuê mới 1.000.000đ" view-only>

Mở báo cáo và để trống khoảng ngày để thấy toàn bộ lịch sử. Trong dữ liệu demo, bạn sẽ **nhìn thấy** thẻ **Tổng gia hạn** hiện **1** và một dòng loại **Gia hạn** trong bảng: hợp đồng của **Nguyễn Văn A**, **Tòa DEMO A**, căn **A104**, badge xanh **Gia hạn**, cột **Giá thuê mới 1.000.000đ**. Thẻ **Tổng chuyển nhượng** hiện **0** (chưa có hợp đồng nào ở trạng thái chuyển nhượng). Thử chọn **Tòa DEMO B** ở ô toà nhà để thấy bảng trống lại — vì bản ghi gia hạn A104 thuộc Tòa DEMO A.

</SandboxTry>

## Quy trình liên quan

- [Gia hạn & chuyển phòng](/03-quan-ly-van-hanh/gia-han-chuyen-phong/) — thao tác thực tế tạo ra bản ghi gia hạn / chuyển nhượng mà báo cáo này liệt kê.
- [HĐ sắp hết hạn](/04-bao-cao/hd-sap-het-han/) — bước trước trong vòng giữ khách: xem hợp đồng nào sắp đến hạn để nhắc gia hạn.
- [Trang chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — mở đúng một hợp đồng để xem lịch sử gia hạn / chuyển nhượng chi tiết.
- [Hợp đồng — danh sách & ký mới](/03-quan-ly-van-hanh/hop-dong/) — nơi tra cứu hợp đồng và đọc dấu "đã gia hạn".
- [Báo cáo Bất động sản (hub)](/04-bao-cao/hub-bds/) — quay lại lưới các báo cáo bất động sản.
