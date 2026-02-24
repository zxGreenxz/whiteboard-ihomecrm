# Tài liệu Yêu cầu - Tái triển khai Module Hoá đơn (Invoice)

## Giới thiệu

Tính năng này tái triển khai hoàn toàn module Hoá đơn (Invoice) trong hệ thống quản lý bất động sản Resident. Module Hoá đơn là phần cốt lõi của mảng Tài chính, nằm tại Quản lý & Vận hành → Tài chính → Hoá đơn. Module bao gồm các chức năng chính: (1) Lập hoá đơn từng Phòng/Giường, (2) Lập hoá đơn hàng loạt từ file Excel, (3) Sửa/Xoá hoá đơn, (4) Duyệt hoá đơn (đơn lẻ và hàng loạt), (5) Gửi hoá đơn qua nhiều kênh (App, Zalo OA, Zalo Bot, Email, sao chép link), (6) Sinh hoá đơn tự động cho toàn bộ khách thuê trong toà nhà, (7) Xác nhận thu tiền với quản lý tiền thừa và gạch nợ tự động, (8) In hoá đơn, (9) Thống kê hoá đơn. Hệ thống hiện tại có database schema cơ bản (bảng `invoices`, `invoice_items`, `payments`) và frontend components nhưng chưa khớp 100% với tài liệu hướng dẫn chính thức. Cần tái triển khai lại toàn bộ database schema, RPC functions, RLS policies, giao diện React, hooks, validation, và tích hợp đúng với các module liên quan (Toà nhà, Phòng, Giường, Hợp đồng, Dịch vụ, Ghi chỉ số, Mẫu hoá đơn, Thu chi, Cài đặt chung). Hệ thống sử dụng Supabase (Postgres), React/TypeScript, shadcn/ui.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Hoá_đơn**: Bản ghi hoá đơn thu tiền phòng và dịch vụ cho khách thuê, lưu trong bảng `invoices`
- **Dòng_dịch_vụ**: Dòng chi tiết dịch vụ/phí trong Hoá_đơn, lưu trong bảng `invoice_items`
- **Thanh_toán**: Bản ghi xác nhận thu tiền cho Hoá_đơn, lưu trong bảng `payments`
- **Toà_nhà**: Căn hộ/toà nhà trong hệ thống, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Toà_nhà, lưu trong bảng `rooms`
- **Giường**: Đơn vị cho thuê nhỏ hơn thuộc Phòng (cho KTX/Sleepbox), lưu trong bảng `beds`
- **Hợp_đồng**: Hợp đồng thuê giữa chủ nhà và khách thuê, lưu trong bảng `contracts`
- **Dịch_vụ**: Các loại dịch vụ gắn với phòng/hợp đồng (điện, nước, wifi, vệ sinh...), lưu trong bảng `services`
- **Chỉ_số_công_tơ**: Chỉ số đồng hồ điện/nước đã chốt, lưu trong bảng `meter_readings`
- **Mẫu_hoá_đơn**: Mẫu in hoá đơn với các mã code placeholder, lưu trong bảng `document_templates`
- **Kỳ_thanh_toán**: Tháng mà hoá đơn được lập (ví dụ: Tháng 5/2025)
- **Mã_hoá_đơn**: Mã tự sinh cho mỗi Hoá_đơn, dùng để định danh duy nhất
- **Trạng_thái_hoá_đơn**: Trạng thái của Hoá_đơn gồm: DRAFT (Nháp), APPROVED (Đã duyệt), PAID (Đã thanh toán đủ), PARTIAL_PAID (Thanh toán một phần), OVERDUE (Quá hạn), CANCELLED (Đã huỷ)
- **Tiền_thừa**: Khoản tiền khách thanh toán vượt quá giá trị hoá đơn, được ghi nhận để trừ dần vào các hoá đơn sau
- **Hệ_số**: Hệ số nhân áp dụng cho dịch vụ trong hoá đơn, mặc định là 1, có thể bật/tắt trong Cài đặt chung
- **Gạch_nợ_tự_động**: Tính năng tự động xác nhận thu tiền khi khách chuyển khoản thành công qua tài khoản ngân hàng đã liên kết
- **Mã_code_hoá_đơn**: Các placeholder trong Mẫu_hoá_đơn được thay thế bằng dữ liệu thực khi xuất/in hoá đơn, bao gồm: {APARTMENT_NAME}, {ROOM_NAME}, {CONTRACT_NAME}, {INVOICE_CODE}, {ISSUE_DATE}, {DUE_DATE}, {SUBTOTAL}, {DISCOUNT_WITH_PROMOTION}, {DEBT}, {TOTAL_WITH_DEBT}, {PAID}, {REMAIN}, {AMOUNT_IN_WORDS_WITH_DEBT}, {NOTE}, và bảng phí {#FEES}{index}, {name}, {price}, {quantity}, {coefficient}, {total}{/FEES}
- **Màn_hoá_đơn**: Màn hình chính của module Hoá đơn tại Quản lý & Vận hành → Tài chính → Hoá đơn

## Yêu cầu

### Yêu cầu 1: Lập hoá đơn từng Phòng/Giường

**User Story:** Là một Người_dùng, tôi muốn lập hoá đơn cho từng Phòng hoặc Giường cụ thể, để ghi nhận các khoản phí thuê phòng và dịch vụ mà khách thuê cần thanh toán trong kỳ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Màn_hoá_đơn và ấn nút dấu (+), THE Hệ_thống SHALL hiển thị màn hình chi tiết lập hoá đơn với đầy đủ các phần: Thông tin chung, Dịch vụ & Phí, và Tổng kết
2. THE Hệ_thống SHALL hiển thị phần Thông tin chung với các trường: Toà nhà (*), Phòng (*), Giường (nếu có), Hợp đồng (*), Kỳ thanh toán (*), Ngày lập (*), Hạn thanh toán (*), Mẫu in hoá đơn
3. WHEN Người_dùng chọn Toà_nhà, THE Hệ_thống SHALL lọc danh sách Phòng thuộc Toà_nhà đã chọn
4. WHEN Người_dùng chọn Phòng, THE Hệ_thống SHALL lọc danh sách Giường thuộc Phòng đã chọn và hiển thị sẵn Hợp_đồng đang hiệu lực với tên khách hàng đại diện
5. THE Hệ_thống SHALL hiển thị mặc định Ngày lập là ngày hiện tại và Hạn thanh toán là sau ngày lập 5 ngày (hoặc theo cài đặt tại Cài đặt chung → Hạn thanh toán hoá đơn)
6. WHEN Người_dùng chọn Hợp_đồng, THE Hệ_thống SHALL hiển thị sẵn các Dịch_vụ mà khách hàng đang sử dụng trong phần Dịch vụ & Phí
7. THE Hệ_thống SHALL hiển thị bảng Dịch vụ & Phí với các cột: Dịch vụ (tên), Đơn giá, Chỉ số (cho dịch vụ công tơ), Số lượng, Hệ số, Từ ngày, Đến ngày
8. WHEN Người_dùng ấn nút (+) tại phần Dịch vụ & Phí, THE Hệ_thống SHALL cho phép thêm Dịch_vụ mới vào hoá đơn
9. WHEN Dịch_vụ có loại METER_READING, THE Hệ_thống SHALL hiển thị nút Chốt công tơ để chọn hoặc tạo Chỉ_số_công_tơ, và tự động tính Số lượng = Chỉ số mới - Chỉ số đầu
10. THE Hệ_thống SHALL hiển thị phần Tổng kết với: Tạm tính (tổng tiền các dòng dịch vụ), Giảm giá (nhập tuỳ chọn), Thuế % (nhập tuỳ chọn), Thành tiền (= Tạm tính - Giảm giá + Thuế), Trả trước (từ Tiền_thừa), Còn lại (= Thành tiền - Trả trước)
11. IF Người_dùng nhập số Trả trước vượt quá số Tiền_thừa đang có hoặc vượt quá tổng giá trị hoá đơn, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation
12. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Hoá_đơn mới với Trạng_thái_hoá_đơn là DRAFT, tự động sinh Mã_hoá_đơn, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
13. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường

### Yêu cầu 2: Lập hoá đơn hàng loạt từ file mẫu

**User Story:** Là một Người_dùng, tôi muốn lập hoá đơn hàng loạt cho nhiều Phòng/Giường cùng lúc bằng cách nhập dữ liệu từ file Excel, để tiết kiệm thời gian khi quản lý nhiều phòng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Nhập dữ liệu (icon mũi tên đi lên) tại Màn_hoá_đơn, THE Hệ_thống SHALL hiển thị màn hình Chi tiết nhập dữ liệu với các trường: Chọn tháng, Chọn toà nhà, link Tải file mẫu, và vùng upload file
2. WHEN Người_dùng chọn tháng và Toà_nhà rồi ấn "Tải file mẫu tại đây", THE Hệ_thống SHALL tạo và tải xuống file Excel mẫu chứa sẵn danh sách Phòng/Giường của Toà_nhà đã chọn, số lượng dịch vụ cố định, và chỉ số đầu điện nước
3. THE Hệ_thống SHALL đánh dấu các cột bắt buộc bằng ký hiệu (*) trong file mẫu, đánh dấu ô màu vàng cho dịch vụ phòng đó sử dụng, và ô màu trắng ghi N/A cho dịch vụ phòng đó không sử dụng
4. WHEN Người_dùng upload file Excel đã điền thông tin và ấn nút Nhập dữ liệu, THE Hệ_thống SHALL đọc dữ liệu từ file, validate từng dòng, và tạo Hoá_đơn cho mỗi Phòng/Giường hợp lệ
5. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và cập nhật danh sách hoá đơn
6. IF file Excel chứa dữ liệu không hợp lệ (thiếu trường bắt buộc, sai định dạng, phòng không tồn tại), THEN THE Hệ_thống SHALL hiển thị thông báo lỗi chi tiết cho từng dòng sai

### Yêu cầu 3: Sửa và Xoá hoá đơn

**User Story:** Là một Người_dùng, tôi muốn sửa hoặc xoá hoá đơn đã tạo, để điều chỉnh thông tin sai sót hoặc loại bỏ hoá đơn không cần thiết.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thao tác → Cập nhật tại một Hoá_đơn trong danh sách, THE Hệ_thống SHALL hiển thị màn hình chỉnh sửa hoá đơn với đầy đủ thông tin hiện tại để Người_dùng thay đổi
2. WHEN Người_dùng chỉnh sửa thông tin và ấn nút Lưu, THE Hệ_thống SHALL cập nhật Hoá_đơn và hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
3. WHEN Người_dùng ấn nút Thao tác → Xoá tại một Hoá_đơn, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
4. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Hoá_đơn (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
5. WHEN Người_dùng tích chọn nhiều Hoá_đơn bằng ô checkbox và ấn nút icon Xoá, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá hàng loạt và thực hiện soft-delete tất cả Hoá_đơn đã chọn
6. WHILE Hoá_đơn có Trạng_thái_hoá_đơn là APPROVED, THE Hệ_thống SHALL ẩn các nút Cập nhật và Xoá, không cho phép sửa hoặc xoá Hoá_đơn đã duyệt


### Yêu cầu 4: Duyệt hoá đơn

**User Story:** Là một Người_dùng, tôi muốn duyệt hoá đơn trước khi gửi cho khách thuê, để kiểm tra và đảm bảo thông tin chính xác, giảm thiểu sai sót ảnh hưởng đến doanh thu và tính chuyên nghiệp.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Duyệt tại một Hoá_đơn chưa duyệt trong danh sách, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận "Bạn đang thực hiện thao tác DUYỆT hoá đơn. Bạn có chắc chắn muốn xác nhận duyệt này không?" với hai nút: Huỷ và Duyệt
2. WHEN Người_dùng ấn nút Duyệt trong hộp thoại xác nhận, THE Hệ_thống SHALL cập nhật Trạng_thái_hoá_đơn thành APPROVED, ẩn nút Duyệt, và hiển thị trạng thái "Đã duyệt"
3. WHEN Người_dùng tích chọn nhiều Hoá_đơn chưa duyệt và ấn nút Duyệt trên thanh công cụ, THE Hệ_thống SHALL duyệt hàng loạt tất cả Hoá_đơn đã chọn và cập nhật trạng thái "Đã duyệt" cho từng hoá đơn
4. WHILE Hoá_đơn có Trạng_thái_hoá_đơn là APPROVED, THE Hệ_thống SHALL không cho phép Người_dùng thao tác Sửa hoặc Xoá Hoá_đơn đó
5. WHEN Người_dùng ấn nút Thao tác → Bỏ duyệt tại một Hoá_đơn đã duyệt, THE Hệ_thống SHALL cập nhật Trạng_thái_hoá_đơn về DRAFT và cho phép Sửa/Xoá trở lại

### Yêu cầu 5: Gửi hoá đơn

**User Story:** Là một Người_dùng, tôi muốn gửi hoá đơn cho khách thuê qua nhiều kênh khác nhau, để khách thuê nhận được thông tin thanh toán kịp thời và thuận tiện.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click vào Mã_hoá_đơn trong danh sách, THE Hệ_thống SHALL hiển thị trang Chi tiết hoá đơn với đầy đủ thông tin và các nút hành động: Gửi hoá đơn, Tải hoá đơn, In hoá đơn
2. WHEN Người_dùng ấn nút Gửi hoá đơn tại trang Chi tiết, THE Hệ_thống SHALL hiển thị các phương thức gửi: Sao chép liên kết, Thông báo qua App Resident, Zalo OA, Zalo Bot, Email
3. WHEN Người_dùng chọn Sao chép liên kết, THE Hệ_thống SHALL sao chép URL hoá đơn vào clipboard và hiển thị thông báo đã sao chép
4. WHEN Người_dùng chọn Thông báo qua App Resident, THE Hệ_thống SHALL gửi push notification/in-app notification đến khách thuê có tài khoản App Resident
5. WHEN Người_dùng chọn Zalo OA, THE Hệ_thống SHALL gửi tin nhắn hoá đơn qua Zalo OA đến số điện thoại khách thuê (nếu có Zalo)
6. WHEN Người_dùng chọn Zalo Bot, THE Hệ_thống SHALL tự động kết bạn và gửi tin nhắn hoá đơn qua Zalo Bot đến số điện thoại khách thuê
7. WHEN Người_dùng chọn Email, THE Hệ_thống SHALL gửi hoá đơn đến địa chỉ email của khách thuê (nếu đã lưu trong hệ thống)
8. WHEN Người_dùng ấn nút Tải hoá đơn, THE Hệ_thống SHALL hiển thị lựa chọn Tải xuống Ảnh hoặc Tải xuống PDF
9. WHEN Người_dùng chọn Tải xuống Ảnh hoặc PDF, THE Hệ_thống SHALL render Hoá_đơn theo Mẫu_hoá_đơn đã chọn, thay thế tất cả Mã_code_hoá_đơn bằng dữ liệu thực, và tải file xuống
10. WHEN Người_dùng tích chọn nhiều Hoá_đơn tại danh sách và ấn nút tải hàng loạt (ảnh hoặc PDF), THE Hệ_thống SHALL tải xuống tất cả Hoá_đơn đã chọn

### Yêu cầu 6: Sinh hoá đơn tự động

**User Story:** Là một Người_dùng, tôi muốn sinh hoá đơn định kỳ tự động cho toàn bộ khách thuê trong một toà nhà, để tạo hoá đơn nhanh chóng và chính xác cho nhiều khách cùng lúc mà không cần lập từng hoá đơn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn biểu tượng Sinh hoá đơn trên thanh công cụ tại Màn_hoá_đơn, THE Hệ_thống SHALL hiển thị màn hình Tạo nhiều hoá đơn với các trường: Kỳ thanh toán (*), Toà nhà (*), Hình thức tạo hoá đơn (*)
2. THE Hệ_thống SHALL hiển thị 3 lựa chọn Hình thức tạo hoá đơn: "Chỉ tiền nhà" (chỉ sinh hoá đơn tiền thuê), "Chỉ tiền dịch vụ" (chỉ sinh hoá đơn tiền dịch vụ), "Tiền nhà & Dịch vụ" (sinh hoá đơn gồm cả tiền thuê và dịch vụ)
3. WHEN Người_dùng điền đầy đủ thông tin và ấn nút Lưu, THE Hệ_thống SHALL tự động tạo Hoá_đơn cho toàn bộ Hợp_đồng đang hiệu lực trong Toà_nhà đã chọn, theo Kỳ_thanh_toán và Hình thức đã chọn
4. WHEN Hình thức là "Chỉ tiền nhà", THE Hệ_thống SHALL chỉ tạo Dòng_dịch_vụ loại RENT trong mỗi Hoá_đơn
5. WHEN Hình thức là "Chỉ tiền dịch vụ", THE Hệ_thống SHALL chỉ tạo các Dòng_dịch_vụ loại SERVICE trong mỗi Hoá_đơn dựa trên Dịch_vụ gắn với Hợp_đồng
6. WHEN Hình thức là "Tiền nhà & Dịch vụ", THE Hệ_thống SHALL tạo cả Dòng_dịch_vụ loại RENT và SERVICE trong mỗi Hoá_đơn
7. IF đã tồn tại Hoá_đơn cho cùng Hợp_đồng và Kỳ_thanh_toán, THEN THE Hệ_thống SHALL bỏ qua Hợp_đồng đó và thông báo cho Người_dùng

### Yêu cầu 7: Xác nhận thu tiền hoá đơn

**User Story:** Là một Người_dùng, tôi muốn xác nhận thu tiền khi khách thuê thanh toán hoá đơn, để ghi nhận chính xác số tiền đã thu và theo dõi công nợ còn lại.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thao tác → Thu tiền tại một Hoá_đơn trong danh sách, THE Hệ_thống SHALL hiển thị màn hình Thanh toán hoá đơn với các trường: Số tiền thu (*), Phương thức thanh toán (*), Ngày thu (*), Ghi chú, Ảnh biên lai
2. WHEN Người_dùng điền đầy đủ thông tin và ấn nút Lưu, THE Hệ_thống SHALL tạo bản ghi Thanh_toán, cập nhật số tiền đã trả (paid_amount) của Hoá_đơn, và hiển thị thông báo thành công
3. WHEN tổng số tiền đã thu bằng tổng giá trị Hoá_đơn, THE Hệ_thống SHALL cập nhật Trạng_thái_hoá_đơn thành PAID
4. WHEN tổng số tiền đã thu lớn hơn 0 nhưng nhỏ hơn tổng giá trị Hoá_đơn, THE Hệ_thống SHALL cập nhật Trạng_thái_hoá_đơn thành PARTIAL_PAID và hiển thị số tiền Còn Nợ
5. WHEN khách thuê thanh toán số tiền nhiều hơn tổng giá trị Hoá_đơn, THE Hệ_thống SHALL ghi nhận đúng số tiền thực thu, cập nhật Trạng_thái_hoá_đơn thành PAID, và tự động ghi nhận số tiền dư vào mục Tiền_thừa của khách thuê
6. THE Hệ_thống SHALL hiển thị cột "Đã trả" và cột "Còn Nợ" trong danh sách hoá đơn, phản ánh chính xác số tiền đã thu và số tiền còn lại
7. WHEN Hoá_đơn quá hạn thanh toán (ngày hiện tại > Hạn thanh toán) và chưa thanh toán đủ, THE Hệ_thống SHALL tự động cập nhật Trạng_thái_hoá_đơn thành OVERDUE

### Yêu cầu 8: Quản lý Tiền thừa

**User Story:** Là một Người_dùng, tôi muốn hệ thống tự động quản lý tiền thừa của khách thuê, để trừ dần vào các hoá đơn sau mà không cần thao tác thủ công.

#### Tiêu chí chấp nhận

1. WHEN khách thuê thanh toán vượt quá giá trị Hoá_đơn, THE Hệ_thống SHALL tự động tính số tiền dư và cộng vào Tiền_thừa của Hợp_đồng tương ứng
2. WHEN Người_dùng lập Hoá_đơn mới, THE Hệ_thống SHALL hiển thị số Tiền_thừa hiện có tại trường Trả trước trong phần Tổng kết
3. WHEN Người_dùng nhập số tiền Trả trước từ Tiền_thừa, THE Hệ_thống SHALL trừ số tiền đó khỏi tổng Hoá_đơn và giảm Tiền_thừa tương ứng
4. IF Người_dùng nhập số tiền Trả trước lớn hơn Tiền_thừa đang có, THEN THE Hệ_thống SHALL hiển thị lỗi validation "Số tiền trả trước không được vượt quá tiền thừa hiện có"
5. WHEN Người_dùng lập Phiếu thu với hạng mục Tiền thừa trong module Thu chi, THE Hệ_thống SHALL ghi nhận khoản tiền vào Tiền_thừa của khách thuê

### Yêu cầu 9: In hoá đơn

**User Story:** Là một Người_dùng, tôi muốn in hoá đơn ra giấy, để giao trực tiếp cho khách thuê hoặc lưu trữ hồ sơ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click vào Mã_hoá_đơn để xem chi tiết và ấn nút In hoá đơn, THE Hệ_thống SHALL render Hoá_đơn theo Mẫu_hoá_đơn đã chọn và mở hộp thoại in của trình duyệt
2. THE Hệ_thống SHALL thay thế tất cả Mã_code_hoá_đơn trong Mẫu_hoá_đơn bằng dữ liệu thực của Hoá_đơn, bao gồm: {APARTMENT_NAME} → tên Toà_nhà, {ROOM_NAME} → tên Phòng, {CONTRACT_NAME} → tên khách thuê, {INVOICE_CODE} → Mã_hoá_đơn, {ISSUE_DATE} → ngày lập, {DUE_DATE} → hạn thanh toán, {SUBTOTAL} → tạm tính, {DISCOUNT_WITH_PROMOTION} → giảm giá, {DEBT} → nợ cũ, {TOTAL_WITH_DEBT} → tổng cộng, {PAID} → đã thanh toán, {REMAIN} → phải thanh toán, {AMOUNT_IN_WORDS_WITH_DEBT} → số tiền bằng chữ, {NOTE} → ghi chú
3. THE Hệ_thống SHALL render bảng phí dịch vụ bằng cách lặp qua template {#FEES}...{/FEES} và thay thế {index}, {name}, {price}, {quantity}, {coefficient}, {total} cho mỗi Dòng_dịch_vụ
4. WHEN Mẫu_hoá_đơn có mã +++IMAGE LOGO()+++ , THE Hệ_thống SHALL thay thế bằng logo thương hiệu của Người_dùng (nếu đã cài đặt trong Cài đặt chung)


### Yêu cầu 10: Thống kê hoá đơn

**User Story:** Là một Người_dùng, tôi muốn xem thống kê tổng hợp hoá đơn theo nhiều tiêu chí lọc, để theo dõi tiến độ thanh toán và lên phương án cho các trường hợp thanh toán chậm.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị phần thống kê phía trên danh sách hoá đơn tại Màn_hoá_đơn, bao gồm: Tổng số tiền đã thu, Tổng số tiền phải thu (chưa thanh toán), Tổng số hoá đơn
2. THE Hệ_thống SHALL cho phép lọc danh sách hoá đơn theo các trường: Toà nhà, Phòng, Giường, Hợp đồng, Thời gian (khoảng ngày), Trạng thái hoá đơn
3. WHEN Người_dùng thay đổi bộ lọc, THE Hệ_thống SHALL cập nhật lại danh sách hoá đơn và số liệu thống kê tương ứng với điều kiện lọc
4. THE Hệ_thống SHALL hiển thị danh sách hoá đơn dạng bảng với các cột: Mã hoá đơn, Toà nhà, Phòng, Khách thuê, Kỳ thanh toán, Ngày lập, Hạn thanh toán, Tổng tiền, Đã trả, Còn nợ, Trạng thái, Thao tác
5. THE Hệ_thống SHALL hỗ trợ phân trang cho danh sách hoá đơn khi số lượng lớn

### Yêu cầu 11: Database Schema và RPC Functions

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn và các RPC functions tối ưu, để đảm bảo dữ liệu chính xác, hiệu suất cao, và bảo mật.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL có bảng `invoices` với đầy đủ các cột: id, user_id, contract_id, building_id, room_id, bed_id, invoice_number, billing_month (kỳ thanh toán dạng YYYY-MM), issue_date, due_date, paid_date, status (invoice_status enum), subtotal, discount_amount, tax_percent, tax_amount, total_amount, prepaid_amount (tiền trả trước từ tiền thừa), paid_amount, remaining_amount (computed), previous_debt, notes, template_id, approved_at, approved_by, created_at, updated_at, deleted_at
2. THE Hệ_thống SHALL có bảng `invoice_items` với đầy đủ các cột: id, invoice_id, service_id, type (invoice_item_type enum), description, unit_price, quantity, coefficient (hệ số, mặc định 1), amount, previous_reading, current_reading, from_date, to_date, sort_order, created_at
3. THE Hệ_thống SHALL có bảng `payments` với đầy đủ các cột: id, user_id, invoice_id, receipt_number, amount, payment_method, payment_date, notes, receipt_image_url, created_at, updated_at
4. THE Hệ_thống SHALL có bảng `excess_amounts` (tiền thừa) với các cột: id, user_id, contract_id, amount, description, source_invoice_id, source_payment_id, created_at
5. THE Hệ_thống SHALL có RLS policies trên tất cả các bảng đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (user_id = auth.uid())
6. THE Hệ_thống SHALL có RPC function `generate_invoices_for_building` nhận tham số (building_id, billing_month, invoice_type) để sinh hoá đơn hàng loạt cho toàn bộ hợp đồng hiệu lực trong toà nhà
7. THE Hệ_thống SHALL có RPC function `record_invoice_payment` nhận tham số (invoice_id, amount, payment_method, payment_date, notes) để ghi nhận thanh toán, cập nhật paid_amount, tự động xử lý tiền thừa, và cập nhật trạng thái hoá đơn
8. THE Hệ_thống SHALL có RPC function `get_invoice_statistics` nhận tham số bộ lọc và trả về tổng tiền đã thu, tổng tiền phải thu, tổng số hoá đơn
9. THE Hệ_thống SHALL có trigger tự động cập nhật remaining_amount khi paid_amount thay đổi
10. THE Hệ_thống SHALL có trigger tự động cập nhật trạng thái OVERDUE cho hoá đơn quá hạn

### Yêu cầu 12: Render hoá đơn từ mẫu (Template Engine)

**User Story:** Là một Người_dùng, tôi muốn hệ thống render hoá đơn chính xác từ mẫu đã cài đặt, để xuất hoá đơn đẹp, chuyên nghiệp với đầy đủ thông tin.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL có module Template Engine nhận đầu vào là Mẫu_hoá_đơn (HTML/template string) và dữ liệu Hoá_đơn, trả về HTML đã render hoàn chỉnh
2. THE Hệ_thống SHALL thay thế tất cả placeholder đơn: {APARTMENT_NAME}, {ROOM_NAME}, {CONTRACT_NAME}, {INVOICE_CODE}, {ISSUE_DATE}, {DUE_DATE}, {SUBTOTAL}, {DISCOUNT_WITH_PROMOTION}, {DEBT}, {TOTAL_WITH_DEBT}, {PAID}, {REMAIN}, {AMOUNT_IN_WORDS_WITH_DEBT}, {NOTE}
3. THE Hệ_thống SHALL xử lý block lặp {#FEES}...{/FEES} bằng cách lặp qua danh sách Dòng_dịch_vụ và thay thế {index}, {name}, {price}, {quantity}, {coefficient}, {total} cho mỗi dòng
4. THE Hệ_thống SHALL format số tiền theo định dạng tiền Việt Nam (dấu chấm phân cách hàng nghìn, đơn vị VNĐ)
5. THE Hệ_thống SHALL chuyển đổi số tiền thành chữ tiếng Việt cho placeholder {AMOUNT_IN_WORDS_WITH_DEBT}
6. FOR ALL Hoá_đơn hợp lệ, việc render rồi parse lại các giá trị từ HTML đã render SHALL cho kết quả khớp với dữ liệu gốc (round-trip property)
7. WHEN Mẫu_hoá_đơn chứa placeholder không có trong dữ liệu, THE Hệ_thống SHALL thay thế bằng chuỗi rỗng thay vì hiển thị mã code

### Yêu cầu 13: Danh sách hoá đơn và giao diện chính

**User Story:** Là một Người_dùng, tôi muốn có giao diện danh sách hoá đơn trực quan và dễ sử dụng, để quản lý hoá đơn hiệu quả.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị Màn_hoá_đơn với thanh công cụ chứa các nút: Thêm hoá đơn (+), Nhập dữ liệu (import), Sinh hoá đơn, Tải hàng loạt ảnh, Tải hàng loạt PDF, Duyệt hàng loạt, Xoá hàng loạt
2. THE Hệ_thống SHALL hiển thị bộ lọc phía trên danh sách với các trường: Toà nhà, Phòng, Giường, Hợp đồng, Khoảng thời gian, Trạng thái
3. THE Hệ_thống SHALL hiển thị bảng danh sách hoá đơn với checkbox chọn nhiều, các cột thông tin, và cột Thao tác với dropdown menu (Cập nhật, Xoá, Thu tiền, Bỏ duyệt)
4. WHEN Hoá_đơn có Trạng_thái_hoá_đơn là DRAFT, THE Hệ_thống SHALL hiển thị nút Duyệt inline tại dòng hoá đơn đó
5. WHEN Hoá_đơn có Trạng_thái_hoá_đơn là APPROVED, THE Hệ_thống SHALL hiển thị badge "Đã duyệt" và ẩn nút Duyệt
6. THE Hệ_thống SHALL hiển thị Trạng_thái_hoá_đơn bằng badge màu sắc phân biệt: DRAFT (xám), APPROVED (xanh dương), PARTIAL_PAID (vàng), PAID (xanh lá), OVERDUE (đỏ), CANCELLED (đen)
7. THE Hệ_thống SHALL hỗ trợ sắp xếp danh sách theo các cột: Ngày lập, Hạn thanh toán, Tổng tiền, Trạng thái
