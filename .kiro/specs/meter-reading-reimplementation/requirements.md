# Tài liệu Yêu cầu - Tái triển khai Đồng hồ Công tơ & Ghi chỉ số

> **Lifecycle:** historical Kiro spec. Nguồn hiện hành: `docs/he-thong/06-cong-to-chi-so.md` và `docs/huong-dan-su-dung/03-quan-ly-van-hanh/ghi-chi-so/`.

## Giới thiệu

Tài liệu này ghi lại yêu cầu tái triển khai theo cây Resident docs cũ. Mọi hạng mục chưa hoàn tất phải tái kiểm chứng với tài liệu và code hiện hành trước khi thực hiện.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Công_tơ**: Đồng hồ đo lường tiện ích (điện, nước, gas) được gắn vào phòng, lưu trong bảng `meters`
- **Chỉ_số**: Bản ghi ghi nhận chỉ số đầu và chỉ số mới của một Công_tơ tại một thời điểm, lưu trong bảng `meter_readings`
- **Tháng_chốt**: Tháng mà Chỉ_số được ghi nhận, định dạng YYYY-MM
- **Trạng_thái_duyệt**: Trạng thái phê duyệt của Chỉ_số, gồm UNAPPROVED (Chưa duyệt) và APPROVED (Đã duyệt)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Tòa_nhà**: Đơn vị quản lý cấp cao chứa nhiều Phòng, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Tòa_nhà, lưu trong bảng `rooms`
- **Loại_công_tơ**: Phân loại Công_tơ theo tiện ích: ELECTRICITY (Điện), WATER (Nước), GAS (Gas)
- **Mã_công_tơ**: Mã định danh duy nhất của Công_tơ (VD: CTD-201, CTN-201)
- **Mã_chỉ_số**: Mã tự sinh cho mỗi bản ghi Chỉ_số, định dạng CSS{YYMM}{sequence}
- **Số_tiêu_thụ**: Hiệu số giữa chỉ số mới và chỉ số đầu của một lần ghi
- **Danh_sách_công_tơ**: Màn hình hiển thị tất cả Công_tơ được gán theo Phòng
- **Màn_ghi_chỉ_số**: Màn hình chính của module Ghi chỉ số tại Tài chính → Ghi chỉ số

## Yêu cầu

### Yêu cầu 1: Hiển thị danh sách Công tơ theo phòng

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả Công_tơ được gán theo Phòng, để tôi có thể quản lý thông tin công tơ thực tế tại căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập vào mục Đồng hồ Công tơ từ Cài đặt hệ thống → Danh mục khác → Tài chính, THE Hệ_thống SHALL hiển thị Danh_sách_công_tơ được nhóm theo Phòng
2. THE Hệ_thống SHALL hiển thị mặc định 2 Loại_công_tơ cho mỗi Phòng: Công tơ điện (ELECTRICITY) và Công tơ nước (WATER)
3. THE Hệ_thống SHALL hiển thị các thông tin sau cho mỗi Công_tơ: Mã_công_tơ, tên Công_tơ, Loại_công_tơ, Phòng, Tòa_nhà, trạng thái, và chỉ số gần nhất
4. WHEN Người_dùng lọc theo Tòa_nhà hoặc Loại_công_tơ, THE Hệ_thống SHALL chỉ hiển thị các Công_tơ phù hợp với bộ lọc
5. THE Hệ_thống SHALL chỉ hiển thị Công_tơ thuộc quyền sở hữu của Người_dùng đang đăng nhập (theo RLS policy)

### Yêu cầu 2: Thêm Công tơ mới

**User Story:** Là một Người_dùng, tôi muốn thêm Công_tơ mới cho Phòng, để tôi có thể theo dõi chỉ số tiện ích theo đúng thực tế tại căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị form Thêm công tơ với các trường: Tòa_nhà (*), Phòng (*), Loại_công_tơ (*), Mã_công_tơ (*), chỉ số ban đầu, ngày lắp đặt, ghi chú vị trí, nhà sản xuất, model, số serial, và ghi chú
2. THE Hệ_thống SHALL đánh dấu các trường bắt buộc bằng ký hiệu (*)
3. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Công_tơ mới và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
4. WHEN Hệ_thống tạo Công_tơ mới, THE Hệ_thống SHALL tự động sinh tên Công_tơ từ tên Phòng và Loại_công_tơ (VD: "Phòng 201 - Điện")
5. IF Người_dùng nhập Mã_công_tơ đã tồn tại, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Mã công tơ đã tồn tại"
6. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường

### Yêu cầu 3: Sửa thông tin Công tơ

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin Công_tơ đã có, để tôi có thể cập nhật thông tin theo đúng thực tế.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Sửa trên một Công_tơ tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị màn hình Chi tiết công tơ với thông tin đã được điền sẵn
2. WHEN Người_dùng cập nhật thông tin và ấn nút Lưu, THE Hệ_thống SHALL lưu thay đổi và hiển thị thông báo cập nhật thành công
3. THE Hệ_thống SHALL tự động cập nhật trường updated_at khi Công_tơ được sửa

### Yêu cầu 4: Xoá Công tơ

**User Story:** Là một Người_dùng, tôi muốn xoá Công_tơ không còn sử dụng, để danh sách công tơ phản ánh đúng thực tế.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xoá trên một Công_tơ tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận với nội dung "Bạn đang thực hiện thao tác xoá công tơ. Bạn có chắc chắn muốn xoá không?"
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. WHEN Người_dùng huỷ thao tác xoá, THE Hệ_thống SHALL đóng hộp thoại và giữ nguyên Công_tơ
4. THE Hệ_thống SHALL không hiển thị Công_tơ đã bị soft-delete trong Danh_sách_công_tơ

### Yêu cầu 5: Ghi chỉ số từng phòng

**User Story:** Là một Người_dùng, tôi muốn ghi chỉ số công tơ điện nước cho từng phòng, để tôi có thể chốt chỉ số hàng tháng phục vụ lập hóa đơn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Tài chính → Ghi chỉ số và ấn nút dấu (+), THE Hệ_thống SHALL hiển thị form Thêm chỉ số với các trường: Tòa_nhà (*), Phòng (*), Loại_công_tơ (*), Tháng_chốt (*), Ngày chốt (*), danh sách Công_tơ chưa chốt trong tháng
2. WHEN Người_dùng chọn Tòa_nhà, Phòng, và Loại_công_tơ, THE Hệ_thống SHALL hiển thị bảng các Công_tơ tương ứng với các cột: Tên công tơ, Chỉ số đầu (tự động lấy từ lần ghi gần nhất), Chỉ số mới (nhập), Ngày chốt, Hình ảnh công tơ
3. THE Hệ_thống SHALL tự động điền Chỉ số đầu bằng chỉ số mới của lần ghi gần nhất, hoặc chỉ số ban đầu của Công_tơ nếu chưa có lần ghi nào
4. WHEN Người_dùng điền Chỉ số mới và ấn nút Lưu, THE Hệ_thống SHALL tạo bản ghi Chỉ_số mới với trạng thái UNAPPROVED và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. THE Hệ_thống SHALL tự động tính Số_tiêu_thụ bằng công thức: Chỉ số mới - Chỉ số đầu
6. THE Hệ_thống SHALL tự động sinh Mã_chỉ_số theo định dạng CSS{YYMM}{sequence}
7. IF Người_dùng nhập Chỉ số mới nhỏ hơn Chỉ số đầu, THEN THE Hệ_thống SHALL hiển thị lỗi validation "Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu"

### Yêu cầu 6: Ghi chỉ số hàng loạt bằng file mẫu

**User Story:** Là một Người_dùng, tôi muốn nhập chỉ số hàng loạt từ file Excel, để tôi có thể ghi chỉ số nhanh cho nhiều phòng cùng lúc.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thêm dữ liệu (hình mũi tên đi lên) tại Màn_ghi_chỉ_số, THE Hệ_thống SHALL hiển thị màn nhập dữ liệu với nút "Tải file mẫu tại đây"
2. WHEN Người_dùng ấn "Tải file mẫu tại đây", THE Hệ_thống SHALL tải xuống file Excel mẫu chứa các cột: Mã_công_tơ, Ngày chốt, Chỉ số mới, Ghi chú
3. WHEN Người_dùng tải file dữ liệu lên bằng cách ấn "Chọn file" hoặc kéo thả file, THE Hệ_thống SHALL hiển thị nội dung file để xem trước
4. WHEN Người_dùng ấn nút Nhập dữ liệu, THE Hệ_thống SHALL xử lý file và tạo các bản ghi Chỉ_số tương ứng
5. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và hiển thị kết quả (số bản ghi thành công, số bản ghi lỗi)
6. IF file chứa dữ liệu không hợp lệ (Mã_công_tơ không tồn tại, chỉ số mới nhỏ hơn chỉ số đầu), THEN THE Hệ_thống SHALL báo lỗi chi tiết cho từng dòng bị lỗi

### Yêu cầu 7: Sửa và Xoá chỉ số đã chốt

**User Story:** Là một Người_dùng, tôi muốn sửa hoặc xoá chỉ số đã chốt khi phát hiện sai sót, để đảm bảo dữ liệu chính xác trước khi duyệt.

#### Tiêu chí chấp nhận

1. WHILE Chỉ_số có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL cho phép Người_dùng sửa hoặc xoá Chỉ_số đó thông qua nút Thao tác → Cập nhật hoặc Xoá
2. WHILE Chỉ_số có Trạng_thái_duyệt là APPROVED, THE Hệ_thống SHALL vô hiệu hoá các nút Cập nhật và Xoá cho Chỉ_số đó
3. WHEN Người_dùng muốn sửa hoặc xoá Chỉ_số đã duyệt, THE Hệ_thống SHALL yêu cầu Người_dùng thực hiện Bỏ duyệt trước
4. WHEN Người_dùng tích chọn nhiều Chỉ_số và ấn nút icon Xoá, THE Hệ_thống SHALL xoá hàng loạt các Chỉ_số đã chọn (chỉ áp dụng cho Chỉ_số chưa duyệt)

### Yêu cầu 8: Duyệt chỉ số công tơ

**User Story:** Là một Người_dùng, tôi muốn duyệt các chỉ số đã chốt, để xác nhận thông tin chuẩn trước khi lên hóa đơn gửi khách hàng.

#### Tiêu chí chấp nhận

1. WHEN Chỉ_số được tạo thành công, THE Hệ_thống SHALL hiển thị nút Duyệt (màu xanh) tại cột Thao tác → Duyệt
2. WHEN Người_dùng ấn nút Duyệt trên một Chỉ_số, THE Hệ_thống SHALL cập nhật Trạng_thái_duyệt thành APPROVED, ghi nhận approved_by và approved_at
3. WHEN Người_dùng tích chọn nhiều Chỉ_số và ấn nút Duyệt, THE Hệ_thống SHALL duyệt hàng loạt tất cả Chỉ_số đã chọn
4. WHEN Người_dùng ấn Thao tác → Bỏ duyệt trên Chỉ_số đã duyệt, THE Hệ_thống SHALL cập nhật Trạng_thái_duyệt thành UNAPPROVED và xoá thông tin approved_by, approved_at

### Yêu cầu 9: Hiển thị danh sách và bảng chỉ số

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả chỉ số đã chốt với đầy đủ thông tin, để tôi có thể theo dõi và quản lý chỉ số hàng tháng.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị bảng danh sách Chỉ_số với các cột: Mã (Mã_chỉ_số), Thao tác, Công tơ (Mã_công_tơ/tên), Chỉ số đầu, Chỉ số cuối, Số tiêu thụ, Ngày chốt, Người chốt
2. THE Hệ_thống SHALL hỗ trợ lọc danh sách theo: Tòa_nhà, Phòng, Loại_công_tơ, Tháng_chốt, Trạng_thái_duyệt
3. THE Hệ_thống SHALL hỗ trợ phân trang cho danh sách Chỉ_số
4. THE Hệ_thống SHALL hỗ trợ chọn nhiều dòng bằng checkbox để thực hiện thao tác hàng loạt (duyệt, xoá)
5. THE Hệ_thống SHALL hiển thị badge trạng thái (màu xanh cho Đã duyệt, màu vàng cho Chưa duyệt) trên Mã_chỉ_số

### Yêu cầu 10: Thống kê chỉ số công tơ

**User Story:** Là một Người_dùng, tôi muốn xem thống kê tổng quan về chỉ số công tơ, để tôi có thể nắm bắt nhanh tình trạng chốt chỉ số trong tháng.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị các thẻ thống kê tại đầu Màn_ghi_chỉ_số gồm: số lượng Công_tơ chưa chốt trong tháng, số lượng Chỉ_số đã duyệt trong tháng, số lượng Chỉ_số chưa duyệt trong tháng
2. THE Hệ_thống SHALL hiển thị tổng khối lượng tiêu thụ theo từng Loại_công_tơ (điện kWh, nước m³)
3. WHEN Người_dùng thay đổi bộ lọc (Tòa_nhà, Tháng_chốt), THE Hệ_thống SHALL cập nhật lại các con số thống kê tương ứng

### Yêu cầu 11: Tích hợp chỉ số với hóa đơn

**User Story:** Là một Người_dùng, tôi muốn chỉ số đã duyệt được liên kết với hóa đơn, để tôi có thể tính tiền dịch vụ điện nước chính xác.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng lập hóa đơn và chọn dịch vụ điện/nước, THE Hệ_thống SHALL cho phép chọn Chỉ_số đã duyệt tương ứng với Phòng và Tháng_chốt
2. WHEN Chỉ_số được chọn cho hóa đơn, THE Hệ_thống SHALL tự động tính thành tiền bằng Số_tiêu_thụ nhân đơn giá dịch vụ
3. IF chưa có Chỉ_số đã duyệt cho Phòng và Tháng_chốt, THEN THE Hệ_thống SHALL hiển thị nút "Chốt công tơ" để Người_dùng chuyển sang ghi chỉ số

### Yêu cầu 12: Hình ảnh công tơ

**User Story:** Là một Người_dùng, tôi muốn đính kèm hình ảnh chụp công tơ khi ghi chỉ số, để có bằng chứng xác minh chỉ số.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ghi chỉ số, THE Hệ_thống SHALL cung cấp trường tải lên hình ảnh công tơ (không bắt buộc)
2. WHEN Người_dùng tải lên hình ảnh, THE Hệ_thống SHALL lưu trữ hình ảnh và liên kết với bản ghi Chỉ_số tương ứng qua trường meter_image_url
3. WHEN Người_dùng xem chi tiết Chỉ_số, THE Hệ_thống SHALL hiển thị hình ảnh công tơ đã đính kèm (nếu có)
