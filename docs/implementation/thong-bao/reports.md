# I01, I11–I12 — bảng tin và báo cáo bất động sản

| Mã | Trước | Sau | Bằng chứng |
|---|---|---|---|
| I01 | Số0/biểu đồ rỗng khi thiếu nguồn | useDashboard throw nguồn lỗi/null; kiểm17 trường số bắt buộc. Mỗi widget QueryRegion, không tính số0 từ lỗi | useDashboard.feedback 7 ca + moneyViews; dashboard DOM2 |
| I11 | Empty và export từ bộ dữ liệu thiếu | 7 báo cáo realEstateReports + danh mục lọc truyền queries vào ReportLayout; QueryRegion giữ lọc/retry, export bị chặn khi source lỗi | realEstateFeedback3; ReportLayout DOM; không có dữ liệu hợp lệ vẫn là empty |
| I12 | Snapshot/trend/raw errors/nullsố0 | Nhãn Ngày xem số liệu/Xu hướng lấp đầy; occupancy snapshot/trend/count validate nguồn theo SQL COALESCE; export chỉ khi dữ liệu đã xác nhận | useOccupancyDashboard6 ca; chưa E2E từng báo cáo trên điện thoại |

I03/I07/I09/I10/I11/I12 đã đối chiếu các caller trong plan-root-status.json và inventory: RoomDetail, RefundLog, tiền dư/cọc/sổ, RoomCashLifecycle, SettlementReport, ReportLayout. Lỗi nguồn bắt buộc chặn tổng/xuất, giữ bộ lọc và tải lại. E2E từng báo cáo và từng vai chưa được kiểm hết.

I01 mobile đã tách tám vùng query (tòa, thống kê, doanh thu, lấp đầy, khách hẹn, cọc, cảnh báo, hoạt động), giữ các khối còn tải được. RED 8/9 → GREEN 21/21 gồm DOM mobile 11, caller thống kê 3 và QueryRegion 7; root chạy độc lập cùng ba suite đạt 21/21. Retry theo nguồn vùng đó, lấp đầy cần cả nguồn tổng phòng và phân bố. Không thay công thức hoặc bộ lọc.
