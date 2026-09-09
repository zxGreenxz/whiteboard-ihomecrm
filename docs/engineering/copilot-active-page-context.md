# Ngữ cảnh trang đang mở của Copilot

`useCopilotPageContext` nhận **bộ lọc đã áp** từ component đang mount. Khi gửi câu hỏi,
ChatPanel chụp ngữ cảnh theo pathname, query, khóa lần điều hướng và tổ chức đang chọn.
Rời trang thì hủy; đổi tổ chức không tái sử dụng bản ghi cũ. Không quét storage, DOM,
React Query cache hay nội dung hội thoại. `usePersistedState` vẫn là nguồn state của trang;
adapter chỉ nhận giá trị đang tham gia truy vấn hoặc lọc danh sách.

Danh sách nguồn đã rà theo `COPILOT_PAGE_CONTRACTS`:

| Nhóm canonical | Nguồn đang áp |
|---|---|
| Căn hộ | Rooms desktop/mobile: tòa, tầng, trạng thái, tìm kiếm; sheet mobile |
| Tòa nhà | Buildings desktop: tòa/trạng thái/tìm kiếm; mobile: tìm kiếm và sheet |
| Dịch vụ | Services: tòa và loại phí |
| Tài sản | Assets: loại, tình trạng, tòa, phòng, tìm kiếm |
| Kho vật tư | MaterialsListContent: category/low stock/search; ba tab phiếu nhập/xuất/kiểm kê không có bộ lọc, nhận dòng bung chi tiết khi chỉ có một dòng |
| Phương tiện | Vehicles desktop/mobile: filters thực sự truyền vào useVehicles |
| Khách hẹn | Leads: tìm kiếm và dialog chi tiết |
| Cọc | Deposits desktop/mobile: chế độ công việc/sổ, tòa và bộ lọc đúng tab đang xem |
| Hợp đồng | Contracts desktop/mobile: bộ lọc truy vấn phân trang; dialog desktop |
| Cư dân | Customers desktop/mobile: effectiveFilters/filter; dialog desktop |
| Hóa đơn | Invoices desktop/mobile: effectiveFilters/filter; dialog desktop |
| Thu chi | IncomeExpense desktop/mobile: effectiveFilters, tìm kiếm đã debounce, chế độ phiếu lẻ/tổng và chi tiết phiếu |
| Sổ quỹ | Cashbooks desktop: tìm kiếm đã áp và dialog; mobile không có bộ lọc, nhận sheet chi tiết |
| Chỉ số công tơ | MeterReadings desktop/mobile: đúng projection gửi vào useMeterReadingsList; mobile không đưa room_id vì truy vấn mobile chưa áp nó |
| Thu tiền | ThuTien: tòa, kỳ hóa đơn, cửa sổ ngày đã chuẩn hóa, trạng thái và drawer đang mở |
| Zalo | ChatZaloPage: chip lọc, tài khoản đã chọn, nhãn; không gửi nội dung tìm kiếm hay tin nhắn |
| Công việc | Tasks desktop/mobile: appliedFilters, trạng thái từ thẻ thống kê, tab và tìm kiếm; không gửi filters còn nháp |
| Báo cáo tài chính | Các trang con: sổ quỹ theo ngày (cả alias), dòng tiền, lịch thu, thu thừa, cọc, phân tích tài chính, bàn giao, chu kỳ thu/bàn giao |
| Báo cáo bất động sản | Các trang con: phòng trống và sắp hết hạn (cả alias), gia hạn/chuyển phòng, lấp đầy, khuyến mại, hợp đồng mới, thanh lý, tỷ lệ chi phí |

Hai trang gốc `FinanceReportsPage` / `RealEstateReportsPage` chỉ là danh sách liên kết,
không có bộ lọc hay bản ghi mở nên không cần publisher. Chi tiết theo route dùng `:id`
từ contract, chỉ nhận UUID, vẫn phải qua công cụ có quyền để tra dữ liệu. Các trang ngoài
contract giữ ngữ cảnh tên trang đã lọc quyền như trước; không tự được thêm dữ liệu chi tiết.

## Giới hạn có chủ đích

- Chỉ gửi khóa bộ lọc được cho phép, giá trị có cấu trúc, có trần số khóa và số phần tử.
  Bộ lọc tìm kiếm tự do, tên nhóm tùy ý, giá trị lạ hoặc quá dài được báo là **phạm vi chưa đầy đủ**;
  Copilot không được coi kết quả toàn trang là tập đang hiển thị.
- Ngày từ Date giữ ngày lịch local; không đổi qua UTC. Giá trị số/boolean chỉ có tác dụng
  khi tên khóa cũng được cho phép. Khoảng ngày và chế độ hạch toán là dữ liệu, không phải lệnh.
- Định danh trong modal phải là UUID và bản ghi phải có `organization_id` khớp tổ chức hiện tại.
  DTO không mang trường này (ví dụ conversation Zalo), bản ghi cũ, hoặc ID tổng hợp không đủ
  bằng chứng: chỉ báo chi tiết chưa xác minh, không suy đoán ID/tên từ bộ nhớ.
- Nhiều dòng vật tư bung cùng lúc không đại diện cho một bản ghi duy nhất. Các thẻ việc cọc
  tổng hợp và form tạo/sửa không được giả làm thực thể đọc. Không gửi draft hoặc dữ liệu form.
- Các ô phòng ở OverpaymentReport/PaymentScheduleReport hiện chỉ có “Tất cả phòng” và không
  tham gia lọc dữ liệu; không khai room_id từ state đó. Lịch thu dùng ngày đã lên hóa đơn đến,
  không coi khoảng ngày đó là ngày phát sinh phiếu.

Kiểm thử: `activePageContext`, `mountedPageContext`, `roomsPageContext`, `reportPageContext`;
các bộ kiểm thử `pageContextRich`, `banDoHeThong`, `ChatPanel` giữ hồi quy. Các test DOM dùng
trang/điều khiển thật với I/O dữ liệu giả; chúng không thay thế kiểm chứng web/SQL trực tiếp.
