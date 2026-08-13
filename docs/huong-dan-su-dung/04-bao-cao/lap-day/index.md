---
title: "Báo cáo: Tỷ lệ lấp đầy"
description: "Snapshot server-side năm nhóm phòng, tỷ lệ lấp đầy/cam kết, doanh thu bỏ lỡ, trend 12 tháng và phòng sắp trống."
routes: ["/reports/real-estate/occupancy"]
permissions: [{module: reports_real_estate, action: occupancy}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Tỷ lệ lấp đầy

Route cần `reports_real_estate.occupancy`. `/reports/real-estate/occupancy-new` chỉ redirect về route này. Đây là report BĐS có nguồn tổng hợp server-side rõ nhất, dùng ba RPC thay vì tải toàn bộ rooms/contracts về trình duyệt.

![Màn hình báo cáo Tỷ lệ lấp đầy](./images/buoc-01-man-hinh.webp)

## Snapshot theo ngày

`occupancy_snapshot_v2(p_as_of_date, p_building_ids)` trả từng tòa theo ngày snapshot, mặc định hôm nay và không cho chọn tương lai.

| Nhóm | Định nghĩa hiện hành |
| --- | --- |
| Đang thuê | Có HĐ ACTIVE hiệu lực tại ngày snapshot; HĐ quá hạn chưa thanh lý/gia hạn vẫn tính đang ở. |
| Giữ chỗ | Không có HĐ ACTIVE và phòng `RESERVED`. |
| Trống | Không có HĐ ACTIVE và phòng `AVAILABLE`. |
| Bảo trì | Phòng `MAINTENANCE`. |
| Không khai thác | `UNAVAILABLE` và trạng thái bất thường; không tính là trống. |

- Tỷ lệ lấp đầy = Đang thuê / Tổng.
- Tỷ lệ cam kết = (Đang thuê + Giữ chỗ) / Tổng.
- Doanh thu bỏ lỡ/tháng = tổng giá thuê niêm yết của riêng phòng Trống.

## Trend và sắp trống

- `fa_occupancy_monthly` tạo trend 12 tháng và hook gộp các tòa đã chọn thành một đường.
- Trend dùng định nghĩa lịch sử: phòng có HĐ mọi trạng thái trừ DRAFT giao với tháng; vì vậy tháng quá khứ vẫn tính HĐ nay đã thanh lý/hết hạn.
- `occupancy_upcoming_vacancy_v2` trả phòng sắp trống trong 30 hoặc 60 ngày.
- Ngày hết hiệu lực đã áp gia hạn `APPROVED`/`COMPLETED`; một phòng một dòng và có cờ `extension_applied`.

::: info Hai định nghĩa “đang thuê” có chủ ý
Snapshot là trạng thái tại một ngày; trend là lịch sử giao tháng. Không so số từng tháng với snapshot hôm nay như thể chúng dùng cùng một predicate.
:::

## Bộ lọc, lỗi và xuất

- Không chọn tòa = tất cả tòa trong scope; có thể chọn nhiều tòa.
- Snapshot, trend và upcoming vacancy có trạng thái lỗi/refetch riêng, nên một khối có thể lỗi trong khi khối khác vẫn hiển thị.
- File `ty-le-lap-day-<ngày>` gồm từng tòa, ngày snapshot, nhãn bộ lọc và các định nghĩa metric.

## Giới hạn diễn giải

- Doanh thu bỏ lỡ là giá niêm yết của phòng AVAILABLE, không phải dự báo doanh thu thực tế hay P&L.
- Phòng RESERVED tăng tỷ lệ cam kết nhưng không tăng tỷ lệ lấp đầy.
- Dữ liệu chịu RLS và danh sách tòa được truyền vào RPC.

## Quy trình liên quan

- [Phòng trống](/04-bao-cao/phong-trong/)
- [Hợp đồng sắp hết hạn](/04-bao-cao/hd-sap-het-han/)
- [Cho thuê mới](/04-bao-cao/cho-thue-moi/)
- [Thanh lý / bỏ trả](/04-bao-cao/thanh-ly/)
