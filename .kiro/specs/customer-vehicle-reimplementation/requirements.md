# Tài liệu Yêu cầu - Tái triển khai Module Khách hàng & Phương tiện

## Giới thiệu

Tính năng này tái triển khai hoàn toàn module Khách hàng (Customer) và Phương tiện (Vehicle) trong hệ thống quản lý bất động sản Resident. Module Khách hàng nằm tại Quản lý & Vận hành → Khách hàng → Khách hàng, module Phương tiện nằm tại Quản lý & Vận hành → Khách hàng → Phương tiện. Module Khách hàng bao gồm: (1) Danh sách khách hàng với tabs trạng thái (Đang thuê, Đã chuyển đi, Khách vãng lai), (2) Thống kê theo loại (Tất cả, Cá nhân, Doanh nghiệp, Khách nước ngoài), (3) Bộ lọc theo khu vực/toà nhà/phòng/giường, (4) Thêm/Sửa khách hàng (Cá nhân hoặc Tổ chức) với đầy đủ thông tin cá nhân, địa chỉ, tài chính, liên lạc, và phương tiện inline, (5) Xem chi tiết khách hàng dạng modal, (6) Tờ khai CT01 (Tờ khai thay đổi thông tin cư trú), (7) Import/Export Excel, (8) In danh sách. Module Phương tiện bao gồm: (1) Danh sách phương tiện với tìm kiếm, (2) Thêm/Sửa phương tiện với upload ảnh, (3) Import từ file Excel mẫu, (4) Export/In danh sách. Hệ thống hiện có database schema cơ bản (bảng `customers` trong migration 016, bảng `vehicles` trong migration 003 liên kết với `tenants`) và frontend components nhưng chưa khớp 100% với tài liệu. Cần tái triển khai lại toàn bộ: database schema (vehicles liên kết với customers thay vì tenants), giao diện React, hooks, validation, và tích hợp đúng với các module liên quan. Hệ thống sử dụng Supabase (Postgres), React/TypeScript, shadcn/ui, TanStack React Query, React Hook Form + Zod.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Khách_hàng**: Bản ghi thông tin khách hàng (cá nhân hoặc tổ chức), lưu trong bảng `customers`
- **Phương_tiện**: Bản ghi thông tin phương tiện gắn với Khách_hàng, lưu trong bảng `vehicles`
- **Toà_nhà**: Căn hộ/toà nhà trong hệ thống, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Toà_nhà, lưu trong bảng `rooms`
- **Giường**: Đơn vị cho thuê nhỏ hơn thuộc Phòng, lưu trong bảng `beds`
- **Hợp_đồng**: Hợp đồng thuê giữa chủ nhà và khách thuê, lưu trong bảng `contracts`
- **Mã_KH**: Mã tự sinh cho mỗi Khách_hàng, dùng để định danh duy nhất
- **Mã_PT**: Mã tự sinh cho mỗi Phương_tiện, dùng để định danh duy nhất
- **Loại_khách_hàng**: Phân loại Khách_hàng gồm: INDIVIDUAL (Cá nhân), ORGANIZATION (Tổ chức/Doanh nghiệp)
- **Trạng_thái_khách_hàng**: Trạng thái thuê gồm: RENTING (Đang thuê), MOVED_OUT (Đã chuyển đi), WALK_IN (Khách vãng lai)
- **Loại_phương_tiện**: Phân loại phương tiện gồm: MOTORBIKE (Xe máy), CAR (Ô tô), BICYCLE (Xe đạp), ELECTRIC_BIKE (Xe điện), OTHER (Khác)
- **CT01**: Mẫu tờ khai thay đổi thông tin cư trú theo quy định nhà nước Việt Nam
- **Màn_khách_hàng**: Màn hình chính của module Khách hàng tại Quản lý & Vận hành → Khách hàng → Khách hàng
- **Màn_phương_tiện**: Màn hình chính của module Phương tiện tại Quản lý & Vận hành → Khách hàng → Phương tiện
- **Nhóm_khách_hàng**: Phân nhóm khách hàng do Người_dùng tự định nghĩa (VIP, Thường, v.v.)

## Yêu cầu

### Yêu cầu 1: Danh sách khách hàng và thống kê

**User Story:** Là một Người_dùng, tôi muốn xem danh sách khách hàng với tabs trạng thái và thống kê theo loại, để theo dõi và quản lý toàn bộ khách hàng trong hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Màn_khách_hàng, THE Hệ_thống SHALL hiển thị 3 tabs trạng thái: "Đang thuê" (RENTING), "Đã chuyển đi" (MOVED_OUT), "Khách vãng lai" (WALK_IN), với tab "Đang thuê" được chọn mặc định
2. THE Hệ_thống SHALL hiển thị 4 thẻ thống kê phía trên danh sách: Tất cả (tổng số Khách_hàng trong tab hiện tại), Cá nhân (số Khách_hàng có Loại_khách_hàng là INDIVIDUAL), Doanh nghiệp (số Khách_hàng có Loại_khách_hàng là ORGANIZATION), Khách nước ngoài (số Khách_hàng có is_foreign là true)
3. WHEN Người_dùng chọn một thẻ thống kê, THE Hệ_thống SHALL lọc danh sách Khách_hàng theo loại tương ứng
4. THE Hệ_thống SHALL hiển thị bộ lọc với các trường: Chọn khu vực, Chọn toà nhà, Chọn phòng, Chọn giường
5. WHEN Người_dùng thay đổi bộ lọc, THE Hệ_thống SHALL cập nhật danh sách Khách_hàng và số liệu thống kê tương ứng
6. THE Hệ_thống SHALL hiển thị ô tìm kiếm cho phép tìm Khách_hàng theo tên, số điện thoại, email, hoặc CMND/CCCD
7. THE Hệ_thống SHALL hiển thị bảng danh sách Khách_hàng với các cột: Mã KH, Thao tác, Khách hàng (tên + ảnh đại diện), Căn hộ đang ở, CMND/CCCD/Hộ chiếu, Ngày sinh, Địa chỉ
8. THE Hệ_thống SHALL hiển thị thanh công cụ với các nút: Thêm khách hàng (+), Xuất Excel (export), Nhập dữ liệu (import), In danh sách, Chuyển đổi dạng xem (Grid/List)
9. WHEN Người_dùng chuyển tab trạng thái, THE Hệ_thống SHALL cập nhật danh sách Khách_hàng và số liệu thống kê theo Trạng_thái_khách_hàng tương ứng

### Yêu cầu 2: Thêm khách hàng cá nhân

**User Story:** Là một Người_dùng, tôi muốn thêm khách hàng cá nhân với đầy đủ thông tin cá nhân, địa chỉ, tài chính, liên lạc và phương tiện, để ghi nhận thông tin khách thuê vào hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Màn_khách_hàng, THE Hệ_thống SHALL hiển thị màn hình Thêm khách hàng với toggle chọn Loại_khách_hàng: Cá nhân hoặc Tổ chức, mặc định chọn Cá nhân
2. THE Hệ_thống SHALL hiển thị phần upload ảnh gồm 4 vùng: Ảnh đại diện, CCCD mặt trước, CCCD mặt sau, Hộ chiếu
3. THE Hệ_thống SHALL hiển thị phần Thông tin chung với các trường: Họ tên khách (*), Số điện thoại (*), Email, CMND/CCCD, Ngày cấp, Nơi cấp, Ngày sinh, Giới tính (Nam/Nữ/Khác)
4. THE Hệ_thống SHALL hiển thị toggle Khách nước ngoài, khi bật sẽ hiển thị thêm các trường thông tin dành cho khách nước ngoài
5. THE Hệ_thống SHALL hiển thị phần Địa chỉ với các trường: Tỉnh/Thành Phố (dropdown), Quận/Huyện (dropdown), Xã/Phường (dropdown), Địa chỉ chi tiết, Chỗ ở hiện tại, Địa chỉ thường trú
6. THE Hệ_thống SHALL hiển thị phần Tài chính & Liên lạc với các trường: Số tài khoản, Ngân hàng, Nghề Nghiệp, Nơi làm việc, Người tư vấn, SĐT người tư vấn, Người liên lạc, SĐT người liên lạc, Mã vân tay cửa ra vào
7. THE Hệ_thống SHALL hiển thị dropdown Nhóm khách hàng
8. THE Hệ_thống SHALL hiển thị trường Ghi chú dạng textarea
9. THE Hệ_thống SHALL hiển thị phần Thông tin xe cho phép thêm nhiều phương tiện inline với các trường: Loại phương tiện (dropdown), Tên dòng xe, Biển số xe
10. WHEN Người_dùng điền đầy đủ các trường bắt buộc (Họ tên, Số điện thoại) và ấn nút Lưu, THE Hệ_thống SHALL tạo Khách_hàng mới và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
11. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường
12. IF số điện thoại hoặc CMND/CCCD đã tồn tại trong hệ thống, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Số điện thoại hoặc CCCD đã tồn tại"

### Yêu cầu 3: Thêm khách hàng tổ chức

**User Story:** Là một Người_dùng, tôi muốn thêm khách hàng là tổ chức/doanh nghiệp, để ghi nhận thông tin doanh nghiệp thuê phòng vào hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng chọn toggle Tổ chức tại màn hình Thêm khách hàng, THE Hệ_thống SHALL hiển thị form với các trường phù hợp cho tổ chức: Ảnh đại diện, Đăng ký kinh doanh, Tên Công ty/tổ chức (*), Số điện thoại (*), Email, Mã số thuế, Người đại diện, Địa chỉ trụ sở
2. WHEN Người_dùng điền đầy đủ các trường bắt buộc (Tên Công ty/tổ chức, Số điện thoại) và ấn nút Lưu, THE Hệ_thống SHALL tạo Khách_hàng mới với Loại_khách_hàng là ORGANIZATION và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
3. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường

### Yêu cầu 4: Xem chi tiết khách hàng

**User Story:** Là một Người_dùng, tôi muốn xem chi tiết thông tin khách hàng trong một modal/dialog, để kiểm tra nhanh thông tin mà không cần rời khỏi danh sách.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click vào tên Khách_hàng hoặc nút Xem chi tiết trong cột Thao tác, THE Hệ_thống SHALL hiển thị modal chi tiết Khách_hàng
2. THE Hệ_thống SHALL hiển thị thông tin cá nhân trong modal: Họ tên, Số điện thoại, Ngày sinh, Giới tính, CMND/CCCD kèm ngày cấp và nơi cấp, ảnh CCCD mặt trước và mặt sau
3. THE Hệ_thống SHALL hiển thị thông tin địa chỉ của Khách_hàng
4. THE Hệ_thống SHALL hiển thị bảng thông tin phương tiện với các cột: Loại phương tiện, Tên dòng xe, Biển số xe
5. THE Hệ_thống SHALL hiển thị link "Bản khai nhân khẩu / Mẫu CT01 - Tờ khai thay đổi thông tin cư trú" để mở form CT01
6. THE Hệ_thống SHALL hiển thị các nút hành động: Sao chép thông tin, Sửa, Xoá
7. WHEN Người_dùng ấn nút Sao chép, THE Hệ_thống SHALL sao chép thông tin Khách_hàng vào clipboard
8. WHEN Người_dùng ấn nút Sửa, THE Hệ_thống SHALL mở màn hình chỉnh sửa Khách_hàng với thông tin hiện tại
9. WHEN Người_dùng ấn nút Xoá, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá

### Yêu cầu 5: Sửa và Xoá khách hàng

**User Story:** Là một Người_dùng, tôi muốn sửa hoặc xoá thông tin khách hàng, để cập nhật thông tin chính xác hoặc loại bỏ khách hàng không cần thiết.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Sửa tại cột Thao tác hoặc trong modal chi tiết, THE Hệ_thống SHALL hiển thị màn hình chỉnh sửa Khách_hàng với đầy đủ thông tin hiện tại
2. WHEN Người_dùng chỉnh sửa thông tin và ấn nút Lưu, THE Hệ_thống SHALL cập nhật Khách_hàng và hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
3. WHEN Người_dùng ấn nút Xoá tại cột Thao tác hoặc trong modal chi tiết, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
4. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Khách_hàng (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
5. IF Khách_hàng đang có Hợp_đồng hiệu lực, THEN THE Hệ_thống SHALL hiển thị cảnh báo trước khi cho phép xoá

### Yêu cầu 6: Tờ khai CT01 (Tờ khai thay đổi thông tin cư trú)

**User Story:** Là một Người_dùng, tôi muốn điền và in tờ khai thay đổi thông tin cư trú CT01 cho khách hàng, để nộp cho cơ quan nhà nước có thẩm quyền.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn link "Bản khai nhân khẩu" tại modal chi tiết Khách_hàng hoặc tại danh sách, THE Hệ_thống SHALL hiển thị form CT01 với các trường thông tin theo mẫu quy định
2. THE Hệ_thống SHALL hiển thị form CT01 với các trường: Cơ quan đăng ký cư trú (*), Họ chữ đệm và tên (*), Ngày tháng năm sinh (*), Giới tính (*), Số định danh cá nhân/CMND (*), Số điện thoại liên hệ, Email, Nơi thường trú, Nơi tạm trú, Nơi ở hiện tại, Nghề nghiệp nơi làm việc, Họ chữ đệm và tên chủ hộ, Quan hệ với chủ hộ, Số định danh cá nhân/CMND của chủ hộ, Nội dung đề nghị
3. THE Hệ_thống SHALL tự động điền sẵn các trường từ thông tin Khách_hàng đã lưu (họ tên, ngày sinh, giới tính, CMND/CCCD, số điện thoại, email, địa chỉ, nghề nghiệp)
4. THE Hệ_thống SHALL hiển thị bảng "Những thành viên trong hộ gia đình cùng thay đổi" với các cột: STT, Họ chữ đệm và tên, Ngày tháng năm sinh, Giới tính, Số định danh cá nhân/CMND, Nghề nghiệp nơi làm việc, Quan hệ với người có thay đổi, Quan hệ với chủ hộ
5. WHEN Người_dùng điền đầy đủ thông tin và ấn nút Lưu, THE Hệ_thống SHALL lưu dữ liệu CT01 và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
6. WHEN lưu thành công, THE Hệ_thống SHALL mở hộp thoại in của trình duyệt để Người_dùng in tờ khai CT01
7. THE Hệ_thống SHALL render tờ khai CT01 theo đúng mẫu quy định nhà nước với layout phù hợp cho in ấn khổ A4

### Yêu cầu 7: Import/Export khách hàng

**User Story:** Là một Người_dùng, tôi muốn nhập và xuất danh sách khách hàng từ/ra file Excel, để quản lý dữ liệu hàng loạt nhanh chóng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xuất Excel tại Màn_khách_hàng, THE Hệ_thống SHALL tạo và tải xuống file Excel chứa danh sách Khách_hàng theo bộ lọc hiện tại
2. WHEN Người_dùng ấn nút Nhập dữ liệu tại Màn_khách_hàng, THE Hệ_thống SHALL hiển thị dialog nhập dữ liệu với link tải file mẫu và vùng upload file
3. WHEN Người_dùng ấn "Tải file mẫu tại đây", THE Hệ_thống SHALL tải xuống file Excel mẫu với các cột tương ứng các trường thông tin Khách_hàng, đánh dấu cột bắt buộc bằng ký hiệu (*)
4. WHEN Người_dùng upload file Excel đã điền và ấn nút Nhập dữ liệu, THE Hệ_thống SHALL đọc dữ liệu, validate từng dòng, và tạo Khách_hàng cho mỗi dòng hợp lệ
5. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và cập nhật danh sách
6. IF file Excel chứa dữ liệu không hợp lệ, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi chi tiết cho từng dòng sai

### Yêu cầu 8: Danh sách phương tiện

**User Story:** Là một Người_dùng, tôi muốn xem danh sách phương tiện của tất cả khách hàng, để theo dõi và quản lý phương tiện trong khu vực quản lý.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Màn_phương_tiện, THE Hệ_thống SHALL hiển thị breadcrumb "Khách hàng > Phương tiện"
2. THE Hệ_thống SHALL hiển thị ô tìm kiếm cho phép tìm Phương_tiện theo biển số xe, tên dòng xe, tên khách hàng
3. THE Hệ_thống SHALL hiển thị bảng danh sách Phương_tiện với các cột: Mã PT, Thao tác, Thông tin xe (loại xe + tên dòng xe + biển số + màu xe), Khách hàng (tên + SĐT), Vị trí (toà nhà + phòng)
4. THE Hệ_thống SHALL hiển thị thanh công cụ với các nút: Thêm phương tiện (+), Xuất Excel (export), Nhập dữ liệu (import), In danh sách, Chuyển đổi dạng xem (Grid/List)
5. THE Hệ_thống SHALL hỗ trợ phân trang cho danh sách Phương_tiện khi số lượng lớn

### Yêu cầu 9: Thêm và Sửa phương tiện

**User Story:** Là một Người_dùng, tôi muốn thêm và sửa thông tin phương tiện cho khách hàng, để ghi nhận chính xác phương tiện đang gửi tại khu vực quản lý.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Màn_phương_tiện, THE Hệ_thống SHALL hiển thị dialog Thêm phương tiện
2. THE Hệ_thống SHALL hiển thị vùng upload ảnh phương tiện (chấp nhận PNG, JPG, JPEG, tối đa 10MB)
3. THE Hệ_thống SHALL hiển thị form với các trường: Loại phương tiện (*) (dropdown: Xe máy, Ô tô, Xe đạp, Xe điện, Khác), Tên dòng xe (*), Màu xe (*), Biển số xe (*), Tên chủ xe theo đăng ký xe (*), Số vé xe, Toà nhà (dropdown), Phòng (dropdown lọc theo Toà nhà đã chọn), Khách hàng (dropdown)
4. WHEN Người_dùng chọn Toà nhà, THE Hệ_thống SHALL lọc danh sách Phòng thuộc Toà nhà đã chọn
5. WHEN Người_dùng điền đầy đủ các trường bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Phương_tiện mới liên kết với Khách_hàng đã chọn và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
6. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường
7. WHEN Người_dùng ấn nút Sửa tại cột Thao tác của một Phương_tiện, THE Hệ_thống SHALL hiển thị dialog chỉnh sửa với thông tin hiện tại
8. WHEN Người_dùng chỉnh sửa và ấn nút Lưu, THE Hệ_thống SHALL cập nhật Phương_tiện và hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"

### Yêu cầu 10: Import phương tiện từ file Excel

**User Story:** Là một Người_dùng, tôi muốn nhập danh sách phương tiện hàng loạt từ file Excel mẫu, để tiết kiệm thời gian khi có nhiều phương tiện cần đăng ký.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Nhập dữ liệu (icon mũi tên đi lên) tại Màn_phương_tiện, THE Hệ_thống SHALL hiển thị dialog nhập dữ liệu với link tải file mẫu và vùng upload file
2. WHEN Người_dùng ấn "Tải file mẫu tại đây", THE Hệ_thống SHALL tải xuống file Excel mẫu với các cột: Loại phương tiện (*), Tên dòng xe (*), Màu xe (*), Biển số xe (*), Tên chủ xe (*), Số vé xe, Toà nhà, Phòng, Khách hàng, kèm ví dụ mẫu
3. WHEN Người_dùng upload file Excel đã điền và ấn nút Nhập dữ liệu, THE Hệ_thống SHALL đọc dữ liệu, validate từng dòng, và tạo Phương_tiện cho mỗi dòng hợp lệ
4. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và cập nhật danh sách Phương_tiện
5. IF file Excel chứa dữ liệu không hợp lệ (thiếu trường bắt buộc, loại phương tiện không hợp lệ), THEN THE Hệ_thống SHALL hiển thị thông báo lỗi chi tiết cho từng dòng sai

### Yêu cầu 11: Database Schema cho Khách hàng và Phương tiện

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn cho module Khách hàng và Phương tiện, để đảm bảo dữ liệu chính xác, toàn vẹn và bảo mật.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL có bảng `customers` với đầy đủ các cột: id, user_id, customer_type (customer_type enum), full_name, phone, email, date_of_birth, gender, id_number, id_issue_date, id_issue_place, province, district, ward, detailed_address, current_residence, permanent_address, bank_account_number, bank_name, occupation, workplace, contact_person, contact_person_phone, advisor, advisor_phone, fingerprint_code, customer_group, is_foreign, status (customer_status enum với giá trị RENTING, MOVED_OUT, WALK_IN), notes, avatar_url, id_images (JSONB), created_at, updated_at, deleted_at
2. THE Hệ_thống SHALL có bảng `vehicles` được cập nhật với cột customer_id (FK tới customers) thay vì tenant_id, và bổ sung các cột: vehicle_name (tên dòng xe), owner_name (tên chủ xe theo đăng ký), ticket_number (số vé xe), building_id (FK tới buildings), room_id (FK tới rooms), image_url (ảnh phương tiện)
3. THE Hệ_thống SHALL có bảng `ct01_declarations` lưu dữ liệu tờ khai CT01 với các cột: id, user_id, customer_id, registration_authority, full_name, date_of_birth, gender, id_number, phone, email, permanent_address, temporary_address, current_address, occupation_workplace, household_head_name, household_head_relationship, household_head_id_number, request_content, family_members (JSONB), created_at, updated_at
4. THE Hệ_thống SHALL có RLS policies trên tất cả các bảng đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (user_id = auth.uid())
5. THE Hệ_thống SHALL có indexes tối ưu cho tìm kiếm full-text trên customers (full_name, phone, email, id_number) và vehicles (license_plate, vehicle_name, owner_name)
6. THE Hệ_thống SHALL có trigger tự động cập nhật updated_at khi dữ liệu thay đổi
7. THE Hệ_thống SHALL có constraint đảm bảo full_name không rỗng và phone có định dạng 10-11 chữ số

### Yêu cầu 12: Xoá phương tiện

**User Story:** Là một Người_dùng, tôi muốn xoá phương tiện không còn sử dụng, để giữ danh sách phương tiện gọn gàng và chính xác.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xoá tại cột Thao tác của một Phương_tiện, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Phương_tiện (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. THE Hệ_thống SHALL cập nhật danh sách Phương_tiện sau khi xoá thành công

### Yêu cầu 13: Validation dữ liệu khách hàng và phương tiện

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate dữ liệu đầu vào chính xác, để đảm bảo tính toàn vẹn dữ liệu và tránh lỗi.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate Họ tên khách không rỗng khi tạo hoặc cập nhật Khách_hàng
2. THE Hệ_thống SHALL validate Số điện thoại có định dạng 10-11 chữ số khi tạo hoặc cập nhật Khách_hàng
3. THE Hệ_thống SHALL validate Email có định dạng hợp lệ (nếu được nhập) khi tạo hoặc cập nhật Khách_hàng
4. THE Hệ_thống SHALL validate Biển số xe không rỗng khi tạo hoặc cập nhật Phương_tiện
5. THE Hệ_thống SHALL validate Tên dòng xe không rỗng khi tạo hoặc cập nhật Phương_tiện
6. THE Hệ_thống SHALL validate Màu xe không rỗng khi tạo hoặc cập nhật Phương_tiện
7. THE Hệ_thống SHALL validate Tên chủ xe không rỗng khi tạo hoặc cập nhật Phương_tiện
8. THE Hệ_thống SHALL validate ảnh upload có định dạng PNG, JPG, hoặc JPEG và kích thước tối đa 10MB
9. FOR ALL Khách_hàng hợp lệ, việc tạo rồi đọc lại SHALL cho kết quả khớp với dữ liệu gốc (round-trip property)
10. FOR ALL Phương_tiện hợp lệ, việc tạo rồi đọc lại SHALL cho kết quả khớp với dữ liệu gốc (round-trip property)
