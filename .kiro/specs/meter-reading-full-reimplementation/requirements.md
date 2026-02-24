# Tài liệu Yêu cầu - Tái hiện thực toàn bộ Ghi chỉ số (Meter Reading)

## Giới thiệu

Tái hiện thực toàn bộ module Ghi chỉ số (Meter Reading) trong hệ thống quản lý bất động sản Resident, đảm bảo 100% khớp với tài liệu hướng dẫn chính thức (`resident-docs/quan-ly-and-van-hanh/tai-chinh/ghi-chi-so.md`). Phạm vi bao gồm: ghi chỉ số từng phòng, ghi chỉ số hàng loạt bằng file mẫu, quy trình duyệt/bỏ duyệt, sửa/xoá chỉ số, thống kê, quản lý công tơ (meters), database functions/triggers, và tích hợp với hóa đơn. Hệ thống hiện tại có code cơ bản nhưng còn lỗi logic, cần tái hiện thực lại toàn bộ code, logic, và database functions.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + TypeScript + Supabase)
- **Công_tơ**: Đồng hồ đo lường tiện ích (điện, nước, gas) được gắn vào phòng, lưu trong bảng `meters`
- **Chỉ_số**: Bản ghi ghi nhận chỉ số đầu và chỉ số mới của một Công_tơ tại một thời điểm, lưu trong bảng `meter_readings`
- **Tháng_chốt**: Tháng mà Chỉ_số được ghi nhận, định dạng YYYY-MM, lưu trong cột `settlement_month`
- **Trạng_thái_duyệt**: Trạng thái phê duyệt của Chỉ_số: UNAPPROVED (Chưa duyệt) hoặc APPROVED (Đã duyệt)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Tòa_nhà**: Đơn vị quản lý cấp cao chứa nhiều Phòng, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Tòa_nhà, lưu trong bảng `rooms`
- **Loại_công_tơ**: Phân loại Công_tơ theo tiện ích: ELECTRICITY (Điện), WATER (Nước), GAS (Gas)
- **Mã_công_tơ**: Mã định danh duy nhất của Công_tơ (VD: CTD-201, CTN-201), lưu trong cột `meters.code`
- **Mã_chỉ_số**: Mã tự sinh cho mỗi bản ghi Chỉ_số, định dạng CSS{YYMM}{sequence}, lưu trong cột `reading_code`
- **Số_tiêu_thụ**: Hiệu số giữa chỉ số mới và chỉ số đầu, tự động tính bởi database (generated column `consumption`)
- **Màn_ghi_chỉ_số**: Màn hình chính của module Ghi chỉ số tại đường dẫn Tài chính → Ghi chỉ số
- **Danh_sách_công_tơ**: Màn hình quản lý Công_tơ tại Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ
- **File_mẫu**: File Excel template dùng để nhập chỉ số hàng loạt
- **Soft_delete**: Cơ chế xoá mềm bằng cách cập nhật trường `deleted_at` thay vì xoá dữ liệu thật

## Yêu cầu

### Yêu cầu 1: Quản lý Công tơ (Meters CRUD)

**User Story:** Là một Người_dùng, tôi muốn quản lý danh sách Công_tơ theo phòng, để tôi có thể theo dõi các đồng hồ đo tiện ích thực tế tại căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ, THE Hệ_thống SHALL hiển thị Danh_sách_công_tơ với các cột: Mã_công_tơ, tên Công_tơ, Loại_công_tơ, Phòng, Tòa_nhà, trạng thái, chỉ số gần nhất
2. WHEN Người_dùng ấn nút dấu (+), THE Hệ_thống SHALL hiển thị form Thêm công tơ với các trường bắt buộc đánh dấu (*): Tòa_nhà (*), Phòng (*), Loại_công_tơ (*), Mã_công_tơ (*), và các trường không bắt buộc: chỉ số ban đầu, ngày lắp đặt, ghi chú vị trí
3. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn Lưu, THE Hệ_thống SHALL tạo Công_tơ mới với trạng thái ACTIVE, tự động sinh tên từ Phòng và Loại_công_tơ, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
4. IF Người_dùng nhập Mã_công_tơ đã tồn tại, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Mã công tơ đã tồn tại"
5. WHEN Người_dùng ấn nút Sửa trên một Công_tơ, THE Hệ_thống SHALL hiển thị form với thông tin đã điền sẵn, cho phép cập nhật và lưu thay đổi
6. WHEN Người_dùng ấn nút Xoá trên một Công_tơ, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận, và khi xác nhận SHALL thực hiện Soft_delete và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
7. THE Hệ_thống SHALL chỉ hiển thị Công_tơ chưa bị Soft_delete và thuộc quyền sở hữu của Người_dùng đang đăng nhập (RLS policy)
8. WHEN Người_dùng chọn Tòa_nhà trong form, THE Hệ_thống SHALL cập nhật danh sách Phòng tương ứng với Tòa_nhà đã chọn

### Yêu cầu 2: Ghi chỉ số từng phòng

**User Story:** Là một Người_dùng, tôi muốn ghi chỉ số công tơ điện nước cho từng phòng, để tôi có thể chốt chỉ số hàng tháng phục vụ lập hóa đơn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Tài chính → Ghi chỉ số và ấn nút dấu (+), THE Hệ_thống SHALL hiển thị form Thêm chỉ số với các trường: Tòa_nhà (*), Phòng (*), Loại_công_tơ (*), Tháng_chốt (*), Ngày chốt (*), checkbox "Công tơ chưa chốt trong tháng"
2. WHEN Người_dùng chọn Tòa_nhà và Tháng_chốt (tối thiểu), THE Hệ_thống SHALL gọi database function `get_meters_without_readings` để hiển thị bảng các Công_tơ tương ứng với các cột: Tên công tơ, Chỉ số đầu (tự động), Chỉ số mới (nhập), Ngày chốt, Hình ảnh công tơ
3. THE Hệ_thống SHALL tự động điền Chỉ số đầu bằng trường `last_reading` từ kết quả RPC `get_meters_without_readings`, là chỉ số mới của lần ghi gần nhất hoặc chỉ số ban đầu của Công_tơ nếu chưa có lần ghi nào
4. WHEN Người_dùng điền Chỉ số mới và ấn nút Lưu, THE Hệ_thống SHALL tạo bản ghi Chỉ_số mới với trạng thái UNAPPROVED và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. THE Hệ_thống SHALL tự động tính Số_tiêu_thụ bằng database generated column: current_reading - previous_reading
6. THE Hệ_thống SHALL tự động sinh Mã_chỉ_số theo định dạng CSS{YYMM}{sequence} thông qua database trigger `auto_generate_reading_code`
7. IF Người_dùng nhập Chỉ số mới nhỏ hơn Chỉ số đầu, THEN THE Hệ_thống SHALL hiển thị lỗi validation "Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu"
8. THE Hệ_thống SHALL sử dụng trường `meter_id` từ bảng `meters` để liên kết Chỉ_số với Công_tơ, và database trigger `auto_populate_meter_reading_fields` SHALL tự động điền building_id, room_id, meter_type, service_id, settlement_month từ meter_id

### Yêu cầu 3: Ghi chỉ số hàng loạt bằng file mẫu

**User Story:** Là một Người_dùng, tôi muốn nhập chỉ số hàng loạt từ file Excel, để tôi có thể ghi chỉ số nhanh cho nhiều phòng cùng lúc.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thêm dữ liệu (icon Import) tại Màn_ghi_chỉ_số, THE Hệ_thống SHALL hiển thị dialog nhập dữ liệu với link "Tải file mẫu tại đây"
2. WHEN Người_dùng ấn "Tải file mẫu tại đây", THE Hệ_thống SHALL tải xuống File_mẫu Excel chứa các cột: Mã_công_tơ (*), Ngày chốt (*), Chỉ số mới (*), Ghi chú
3. WHEN Người_dùng tải file dữ liệu lên bằng cách ấn "Chọn file" hoặc kéo thả file, THE Hệ_thống SHALL hiển thị nội dung file để xem trước
4. WHEN Người_dùng ấn nút "Nhập dữ liệu", THE Hệ_thống SHALL gọi database function `bulk_create_meter_readings` để xử lý file và tạo các bản ghi Chỉ_số tương ứng
5. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và hiển thị kết quả: số bản ghi thành công, số bản ghi lỗi
6. IF file chứa dữ liệu không hợp lệ (Mã_công_tơ không tồn tại, chỉ số mới nhỏ hơn chỉ số đầu, thiếu trường bắt buộc), THEN THE Hệ_thống SHALL báo lỗi chi tiết cho từng dòng bị lỗi kèm thông tin: số dòng, Mã_công_tơ, nội dung lỗi

### Yêu cầu 4: Duyệt và Bỏ duyệt chỉ số

**User Story:** Là một Người_dùng, tôi muốn duyệt các chỉ số đã chốt, để xác nhận thông tin chuẩn trước khi lên hóa đơn gửi khách hàng.

#### Tiêu chí chấp nhận

1. WHEN Chỉ_số được tạo thành công với trạng thái UNAPPROVED, THE Hệ_thống SHALL hiển thị nút "Duyệt" (màu xanh) tại cột Thao tác → Duyệt
2. WHEN Người_dùng ấn nút Duyệt trên một Chỉ_số, THE Hệ_thống SHALL gọi database function `approve_meter_reading` để cập nhật Trạng_thái_duyệt thành APPROVED, ghi nhận approved_by và approved_at
3. WHEN Người_dùng tích chọn nhiều Chỉ_số và ấn nút Duyệt hàng loạt, THE Hệ_thống SHALL gọi database function `bulk_approve_meter_readings` để duyệt tất cả Chỉ_số đã chọn
4. WHEN Người_dùng ấn Thao tác → Bỏ duyệt trên Chỉ_số đã duyệt, THE Hệ_thống SHALL cập nhật Trạng_thái_duyệt thành UNAPPROVED và xoá thông tin approved_by, approved_at
5. THE Hệ_thống SHALL hiển thị badge trạng thái trên Mã_chỉ_số: badge màu xanh "Đã duyệt" cho APPROVED, badge màu vàng "Chưa duyệt" cho UNAPPROVED

### Yêu cầu 5: Sửa và Xoá chỉ số

**User Story:** Là một Người_dùng, tôi muốn sửa hoặc xoá chỉ số đã chốt khi phát hiện sai sót, để đảm bảo dữ liệu chính xác trước khi duyệt.

#### Tiêu chí chấp nhận

1. WHILE Chỉ_số có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL cho phép Người_dùng sửa Chỉ_số thông qua Thao tác → Cập nhật, hiển thị form với thông tin đã điền sẵn
2. WHILE Chỉ_số có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL cho phép Người_dùng xoá Chỉ_số thông qua Thao tác → Xoá, với hộp thoại xác nhận
3. WHILE Chỉ_số có Trạng_thái_duyệt là APPROVED, THE Hệ_thống SHALL vô hiệu hoá (disabled) các nút Cập nhật và Xoá cho Chỉ_số đó
4. WHEN Người_dùng muốn sửa hoặc xoá Chỉ_số đã duyệt, THE Hệ_thống SHALL yêu cầu thực hiện Bỏ duyệt trước (Yêu cầu 4, tiêu chí 4)
5. WHEN Người_dùng tích chọn nhiều Chỉ_số và ấn nút icon Xoá, THE Hệ_thống SHALL xoá hàng loạt chỉ các Chỉ_số có trạng thái UNAPPROVED, bỏ qua các Chỉ_số đã duyệt, và hiển thị thông báo kết quả

### Yêu cầu 6: Hiển thị danh sách chỉ số

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả chỉ số đã chốt với đầy đủ thông tin, để tôi có thể theo dõi và quản lý chỉ số hàng tháng.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị bảng danh sách Chỉ_số từ view `meter_readings_detailed` với các cột: checkbox chọn, Mã (Mã_chỉ_số + badge trạng thái), Thao tác (dropdown menu), Công tơ (Mã_công_tơ + tên), Chỉ số đầu, Chỉ số cuối, Số tiêu thụ, Ngày chốt, Người chốt
2. THE Hệ_thống SHALL hỗ trợ lọc danh sách theo: Tòa_nhà, Phòng, Loại_công_tơ, Tháng_chốt (input type month), Trạng_thái_duyệt (Đã duyệt/Chưa duyệt)
3. THE Hệ_thống SHALL hỗ trợ phân trang cho danh sách Chỉ_số với tuỳ chọn số dòng mỗi trang
4. THE Hệ_thống SHALL hỗ trợ chọn nhiều dòng bằng checkbox (chọn từng dòng hoặc chọn tất cả) để thực hiện thao tác hàng loạt: duyệt, xoá
5. WHEN Người_dùng thay đổi bộ lọc, THE Hệ_thống SHALL reset trang về trang 1 và xoá các lựa chọn checkbox hiện tại
6. WHEN không có Chỉ_số nào phù hợp bộ lọc, THE Hệ_thống SHALL hiển thị trạng thái trống với thông báo "Chưa có chỉ số nào"

### Yêu cầu 7: Thống kê chỉ số công tơ

**User Story:** Là một Người_dùng, tôi muốn xem thống kê tổng quan về chỉ số công tơ, để tôi có thể nắm bắt nhanh tình trạng chốt chỉ số trong tháng.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị các thẻ thống kê tại đầu Màn_ghi_chỉ_số bằng cách gọi database function `get_meter_reading_stats`, gồm: Công tơ chưa chốt (số lượng Công_tơ chưa có Chỉ_số trong tháng), Chỉ số đã duyệt (số lượng APPROVED trong tháng), Chỉ số chưa duyệt (số lượng UNAPPROVED trong tháng)
2. THE Hệ_thống SHALL hiển thị tổng khối lượng tiêu thụ theo từng Loại_công_tơ: Tổng tiêu thụ điện (kWh), Tổng tiêu thụ nước (m³)
3. WHEN Người_dùng thay đổi bộ lọc Tòa_nhà hoặc Tháng_chốt, THE Hệ_thống SHALL cập nhật lại các con số thống kê tương ứng

### Yêu cầu 8: Database Functions và Triggers

**User Story:** Là một lập trình viên, tôi muốn database functions và triggers hoạt động chính xác, để đảm bảo tính toàn vẹn dữ liệu và logic nghiệp vụ.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL sử dụng trigger `auto_populate_meter_reading_fields` để tự động điền building_id, room_id, meter_type, service_id, settlement_month, recorded_by khi tạo Chỉ_số mới từ meter_id
2. THE Hệ_thống SHALL sử dụng trigger `auto_populate_previous_reading` để tự động lấy chỉ số đầu từ lần ghi gần nhất theo meter_id, hoặc từ initial_reading của Công_tơ nếu chưa có lần ghi nào
3. THE Hệ_thống SHALL sử dụng trigger `auto_generate_reading_code` để tự động sinh Mã_chỉ_số theo định dạng CSS{YYMM}{sequence}
4. THE Hệ_thống SHALL sử dụng trigger `auto_generate_meter_name` để tự động sinh tên Công_tơ từ tên Phòng và Loại_công_tơ khi tạo Công_tơ mới
5. THE Hệ_thống SHALL sử dụng function `approve_meter_reading` để duyệt đơn lẻ, cập nhật status, approved_by, approved_at, và raise exception nếu Chỉ_số không tồn tại hoặc đã duyệt
6. THE Hệ_thống SHALL sử dụng function `bulk_approve_meter_readings` để duyệt hàng loạt và trả về số lượng đã duyệt thành công
7. THE Hệ_thống SHALL sử dụng function `get_meter_reading_stats` để trả về thống kê: total_readings, unapproved_count, approved_count, electricity_consumption, water_consumption, gas_consumption
8. THE Hệ_thống SHALL sử dụng function `get_meters_without_readings` để trả về danh sách Công_tơ chưa có Chỉ_số trong tháng, kèm last_reading và last_reading_date
9. THE Hệ_thống SHALL sử dụng function `bulk_create_meter_readings` để nhập hàng loạt từ JSONB array, trả về kết quả cho từng dòng (reading_id, reading_code, success, error_message)
10. FOR ALL Chỉ_số hợp lệ, tạo rồi đọc lại SHALL trả về dữ liệu tương đương với dữ liệu đã tạo (round-trip property cho database operations)

### Yêu cầu 9: Tích hợp chỉ số với hóa đơn

**User Story:** Là một Người_dùng, tôi muốn chỉ số đã duyệt được liên kết với hóa đơn, để tôi có thể tính tiền dịch vụ điện nước chính xác.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng lập hóa đơn và chọn dịch vụ điện/nước (service_type = METER_READING), THE Hệ_thống SHALL hiển thị component MeterReadingSelector cho phép chọn Chỉ_số đã duyệt (APPROVED) tương ứng với Phòng và Tháng_chốt
2. WHEN Chỉ_số được chọn cho hóa đơn, THE Hệ_thống SHALL tự động tính thành tiền bằng Số_tiêu_thụ nhân đơn giá dịch vụ (consumption × unit_price)
3. IF chưa có Chỉ_số đã duyệt cho Phòng và Tháng_chốt, THEN THE Hệ_thống SHALL hiển thị cảnh báo và nút "Chốt công tơ" để Người_dùng chuyển sang Màn_ghi_chỉ_số

### Yêu cầu 10: Hình ảnh công tơ

**User Story:** Là một Người_dùng, tôi muốn đính kèm hình ảnh chụp công tơ khi ghi chỉ số, để có bằng chứng xác minh chỉ số.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ghi chỉ số (form thêm hoặc sửa), THE Hệ_thống SHALL cung cấp trường tải lên hình ảnh công tơ (không bắt buộc) cho mỗi Công_tơ trong bảng
2. WHEN Người_dùng tải lên hình ảnh, THE Hệ_thống SHALL lưu trữ hình ảnh vào Supabase Storage và liên kết URL với bản ghi Chỉ_số qua trường meter_image_url

### Yêu cầu 11: Validation và Xử lý lỗi

**User Story:** Là một Người_dùng, tôi muốn hệ thống kiểm tra dữ liệu đầu vào chính xác, để tránh nhập sai chỉ số.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate phía client (Zod schema) trước khi gửi dữ liệu lên server: Tòa_nhà bắt buộc, Tháng_chốt bắt buộc (format YYYY-MM), Ngày chốt bắt buộc, Chỉ số mới >= 0
2. IF Người_dùng nhập Chỉ số mới nhỏ hơn Chỉ số đầu, THEN THE Hệ_thống SHALL hiển thị lỗi validation trên trường tương ứng
3. THE Hệ_thống SHALL sử dụng database constraint `meter_readings_current_gte_previous` để đảm bảo current_reading >= previous_reading ở tầng database
4. IF database trả về lỗi (constraint violation, RPC error), THEN THE Hệ_thống SHALL hiển thị thông báo lỗi thân thiện bằng tiếng Việt cho Người_dùng
5. FOR ALL dữ liệu đầu vào hợp lệ, validate rồi serialize rồi deserialize SHALL trả về kết quả validation tương đương (round-trip property cho validation logic)

### Yêu cầu 12: RLS và Bảo mật dữ liệu

**User Story:** Là một Người_dùng, tôi muốn chỉ xem và quản lý dữ liệu của mình, để đảm bảo bảo mật thông tin.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL áp dụng RLS policy trên bảng `meter_readings`: Người_dùng chỉ xem/sửa/xoá Chỉ_số có user_id = auth.uid()
2. THE Hệ_thống SHALL áp dụng RLS policy trên bảng `meters`: Người_dùng chỉ xem Công_tơ có user_id = auth.uid() và deleted_at IS NULL
3. THE Hệ_thống SHALL sử dụng SECURITY DEFINER cho các functions cần quyền cao: approve_meter_reading, bulk_approve_meter_readings, bulk_create_meter_readings
4. THE Hệ_thống SHALL truyền user_id từ auth.uid() khi tạo Chỉ_số và Công_tơ mới
