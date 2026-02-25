# Tài liệu Yêu cầu - Tái triển khai Module Toà nhà & Căn hộ

## Giới thiệu

Tính năng này tái triển khai hoàn toàn module Toà nhà (Building) và Căn hộ (Room/Apartment) trong hệ thống quản lý bất động sản Resident, thuộc mục Danh mục dữ liệu. Module Toà nhà nằm tại Danh mục dữ liệu → Toà nhà, module Căn hộ nằm tại Danh mục dữ liệu → Căn hộ. Module Toà nhà bao gồm: (1) Danh sách toà nhà với thẻ thống kê (Tất cả, Đang hoạt động, Ngừng hoạt động), (2) Bộ lọc tìm kiếm, trạng thái hoạt động, khu vực, (3) Bảng danh sách với cột Mã, Thao tác, Tên toà nhà, Địa chỉ, Số căn hộ (link "Xem"), Ngày TT, Hoạt động (toggle switch), (4) Thêm/Sửa toà nhà với form gồm thông tin cơ bản, địa chỉ cascading dropdown, toggle Hoạt động, và phần Dịch vụ toà nhà (bảng toggle sử dụng + đơn giá), (5) Xoá toà nhà. Module Căn hộ bao gồm: (1) Danh sách căn hộ, (2) Thêm/Sửa căn hộ với form gồm Toà nhà (dropdown có "Thêm toà nhà"), Tầng (dropdown có "Thêm tầng"), Tên phòng, Tiền thuê, Tiền cọc, Diện tích, Số khách tối đa, toggle Hoạt động, Mẫu hoá đơn, Mẫu hợp đồng thuê, (3) Xoá căn hộ. Hệ thống hiện có database schema cơ bản (bảng `buildings` và `rooms` trong migration 002) và frontend components nhưng chưa khớp 100% với tài liệu Resident. Cần tái triển khai: database schema (thêm bảng `building_services` junction), giao diện React, hooks, validation, và UI layout đúng với screenshots. Hệ thống sử dụng Supabase (Postgres), React 18/TypeScript, shadcn/ui, TanStack React Query, React Hook Form + Zod, Tailwind CSS.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Toà_nhà**: Bản ghi thông tin toà nhà/bất động sản cho thuê, lưu trong bảng `buildings`
- **Căn_hộ**: Bản ghi thông tin phòng/căn hộ thuộc Toà_nhà, lưu trong bảng `rooms`
- **Khu_vực**: Nhóm quản lý toà nhà theo vùng, lưu trong bảng `areas`
- **Dịch_vụ**: Định nghĩa dịch vụ (điện, nước, wifi, v.v.), lưu trong bảng `services`
- **Dịch_vụ_toà_nhà**: Bản ghi liên kết giữa Toà_nhà và Dịch_vụ, lưu trong bảng `building_services`, bao gồm toggle sử dụng và đơn giá riêng
- **Tầng**: Bản ghi tầng thuộc Toà_nhà, lưu trong bảng `floors`
- **Mẫu_tài_liệu**: Mẫu hoá đơn hoặc hợp đồng thuê, lưu trong bảng `document_templates`
- **Màn_toà_nhà**: Màn hình chính của module Toà nhà tại Danh mục dữ liệu → Toà nhà
- **Màn_căn_hộ**: Màn hình chính của module Căn hộ tại Danh mục dữ liệu → Căn hộ
- **Trạng_thái_hoạt_động**: Trạng thái hoạt động của Toà_nhà hoặc Căn_hộ, gồm: Đang hoạt động (ACTIVE) và Ngừng hoạt động (INACTIVE)

## Yêu cầu

### Yêu cầu 1: Danh sách toà nhà và thống kê

**User Story:** Là một Người_dùng, tôi muốn xem danh sách toà nhà với thẻ thống kê và bộ lọc, để theo dõi và quản lý toàn bộ toà nhà trong hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Màn_toà_nhà, THE Hệ_thống SHALL hiển thị breadcrumb "Danh mục dữ liệu > Toà nhà"
2. THE Hệ_thống SHALL hiển thị 3 thẻ thống kê phía trên danh sách: "Tất cả toà nhà" (tổng số Toà_nhà chưa bị xoá), "Đang hoạt động" (số Toà_nhà có status ACTIVE, hiển thị màu xanh), "Ngừng hoạt động" (số Toà_nhà có status INACTIVE, hiển thị màu đỏ)
3. THE Hệ_thống SHALL hiển thị bộ lọc với các trường: Tìm kiếm (ô search theo tên, mã, địa chỉ), Trạng thái hoạt động (dropdown: Tất cả, Đang hoạt động, Ngừng hoạt động), Khu vực (dropdown danh sách Khu_vực)
4. WHEN Người_dùng thay đổi bộ lọc, THE Hệ_thống SHALL cập nhật danh sách Toà_nhà và số liệu thống kê tương ứng
5. THE Hệ_thống SHALL hiển thị thanh công cụ với các nút: Thêm toà nhà (+), Tìm kiếm (search icon), Làm mới (refresh icon), Chuyển đổi dạng xem (grid/list toggle)
6. THE Hệ_thống SHALL hiển thị bảng danh sách Toà_nhà với các cột: Mã (code), Thao tác (nút sửa màu xanh, nút xoá màu đỏ, nút in), Tên toà nhà, Địa chỉ, Số căn hộ (hiển thị số lượng kèm link "Xem" dẫn đến Màn_căn_hộ lọc theo toà nhà), Ngày TT (ngày tạo/cập nhật), Hoạt động (toggle switch bật/tắt)
7. WHEN Người_dùng bật/tắt toggle Hoạt động trong bảng, THE Hệ_thống SHALL cập nhật Trạng_thái_hoạt_động của Toà_nhà tương ứng và hiển thị thông báo cập nhật thành công

### Yêu cầu 2: Thêm toà nhà

**User Story:** Là một Người_dùng, tôi muốn thêm toà nhà mới với đầy đủ thông tin và dịch vụ, để ghi nhận bất động sản vào hệ thống quản lý.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Màn_toà_nhà, THE Hệ_thống SHALL hiển thị form Thêm toà nhà
2. THE Hệ_thống SHALL hiển thị các trường thông tin cơ bản: Tên toà nhà (*bắt buộc), Tên viết tắt/Mã toà (không bắt buộc)
3. THE Hệ_thống SHALL hiển thị các trường địa chỉ dạng cascading dropdown: Tỉnh/Thành phố (*bắt buộc, dropdown), Quận/Huyện (*bắt buộc, dropdown lọc theo Tỉnh/Thành phố đã chọn), Xã/Phường (*bắt buộc, dropdown lọc theo Quận/Huyện đã chọn), Khu vực (dropdown danh sách Khu_vực), Địa chỉ chi tiết (*bắt buộc, text input)
4. THE Hệ_thống SHALL hiển thị toggle Hoạt động với giá trị mặc định là BẬT (màu xanh)
5. THE Hệ_thống SHALL hiển thị phần "DỊCH VỤ TOÀ NHÀ" với bảng gồm các cột: Sử dụng (toggle bật/tắt), Tên dịch vụ, Đơn giá
6. THE Hệ_thống SHALL tải danh sách Dịch_vụ hiện có của Người_dùng vào bảng Dịch vụ toà nhà, cho phép bật/tắt từng dịch vụ và chỉnh sửa đơn giá riêng cho toà nhà
7. THE Hệ_thống SHALL hiển thị nút (+) trong phần Dịch vụ toà nhà cho phép thêm dịch vụ mới nhanh
8. THE Hệ_thống SHALL hiển thị nút Lưu và nút Huỷ bỏ
9. WHEN Người_dùng điền đầy đủ các trường bắt buộc (Tên toà nhà, Tỉnh/Thành phố, Quận/Huyện, Xã/Phường, Địa chỉ chi tiết) và ấn nút Lưu, THE Hệ_thống SHALL tạo Toà_nhà mới cùng các Dịch_vụ_toà_nhà đã bật và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
10. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường
11. WHEN Người_dùng ấn nút Huỷ bỏ, THE Hệ_thống SHALL đóng form và quay lại Màn_toà_nhà mà không lưu dữ liệu

### Yêu cầu 3: Sửa toà nhà

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin toà nhà đã tạo, để cập nhật thông tin chính xác khi có thay đổi.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Cập nhật (sửa) tại cột Thao tác hoặc chọn "Cập nhật" từ dropdown Thao tác, THE Hệ_thống SHALL hiển thị form chỉnh sửa Toà_nhà với đầy đủ thông tin hiện tại bao gồm thông tin cơ bản, địa chỉ, toggle hoạt động, và bảng Dịch vụ toà nhà
2. WHEN Người_dùng chỉnh sửa thông tin và ấn nút Lưu, THE Hệ_thống SHALL cập nhật Toà_nhà và các Dịch_vụ_toà_nhà tương ứng, hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
3. IF Người_dùng xoá trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng

### Yêu cầu 4: Xoá toà nhà

**User Story:** Là một Người_dùng, tôi muốn xoá toà nhà không còn sử dụng, để giữ danh sách gọn gàng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xoá tại cột Thao tác hoặc chọn "Xóa" từ dropdown Thao tác, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Toà_nhà (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. IF Toà_nhà đang có Căn_hộ chưa bị xoá, THEN THE Hệ_thống SHALL hiển thị cảnh báo "Không thể xóa tòa nhà đang có N căn hộ" và từ chối xoá

### Yêu cầu 5: Danh sách căn hộ

**User Story:** Là một Người_dùng, tôi muốn xem danh sách căn hộ với bộ lọc theo toà nhà và tầng, để quản lý các đơn vị cho thuê.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Màn_căn_hộ, THE Hệ_thống SHALL hiển thị breadcrumb "Danh mục dữ liệu > Căn hộ"
2. THE Hệ_thống SHALL hiển thị bộ lọc với các trường: Tìm kiếm (ô search theo tên phòng, mã), Toà nhà (dropdown), Tầng (dropdown lọc theo Toà nhà đã chọn), Trạng thái hoạt động (dropdown)
3. THE Hệ_thống SHALL hiển thị thanh công cụ với các nút: Thêm căn hộ (+), Tìm kiếm, Làm mới, Chuyển đổi dạng xem
4. THE Hệ_thống SHALL hiển thị bảng danh sách Căn_hộ với các cột: Tên phòng, Toà nhà, Tầng, Diện tích, Giá thuê, Tiền cọc, Số khách tối đa, Hoạt động (toggle switch)
5. WHEN Người_dùng click link "Xem" tại cột Số căn hộ trong Màn_toà_nhà, THE Hệ_thống SHALL chuyển đến Màn_căn_hộ với bộ lọc Toà nhà đã được chọn sẵn

### Yêu cầu 6: Thêm căn hộ

**User Story:** Là một Người_dùng, tôi muốn thêm căn hộ mới vào toà nhà, để ghi nhận đơn vị cho thuê vào hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Màn_căn_hộ, THE Hệ_thống SHALL hiển thị form Thêm căn hộ
2. THE Hệ_thống SHALL hiển thị dropdown Toà nhà (*bắt buộc) với danh sách Toà_nhà đang hoạt động, kèm tuỳ chọn "Thêm toà nhà" cho phép tạo nhanh Toà_nhà mới mà không rời form
3. THE Hệ_thống SHALL hiển thị dropdown Tầng (*bắt buộc) lọc theo Toà nhà đã chọn, kèm tuỳ chọn "Thêm tầng" cho phép tạo nhanh Tầng mới mà không rời form
4. THE Hệ_thống SHALL hiển thị các trường: Tên phòng (*bắt buộc), Tiền thuê (*bắt buộc, số), Tiền cọc (*bắt buộc, số), Diện tích (số, không bắt buộc), Số khách tối đa (số, không bắt buộc)
5. THE Hệ_thống SHALL hiển thị toggle Hoạt động với giá trị mặc định là BẬT
6. THE Hệ_thống SHALL hiển thị dropdown Mẫu hoá đơn (danh sách Mẫu_tài_liệu loại invoice)
7. THE Hệ_thống SHALL hiển thị dropdown Mẫu hợp đồng thuê (danh sách Mẫu_tài_liệu loại lease_contract)
8. WHEN Người_dùng điền đầy đủ các trường bắt buộc (Toà nhà, Tầng, Tên phòng, Tiền thuê, Tiền cọc) và ấn nút Lưu, THE Hệ_thống SHALL tạo Căn_hộ mới và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
9. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường
10. IF tên phòng đã tồn tại trong cùng Toà_nhà, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Tên phòng đã tồn tại trong toà nhà này"

### Yêu cầu 7: Sửa căn hộ

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin căn hộ đã tạo, để cập nhật thông tin chính xác khi có thay đổi.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Cập nhật (sửa) tại cột Thao tác của một Căn_hộ, THE Hệ_thống SHALL hiển thị form chỉnh sửa Căn_hộ với đầy đủ thông tin hiện tại bao gồm Toà nhà, Tầng, Tên phòng, Tiền thuê, Tiền cọc, Diện tích, Số khách tối đa, toggle Hoạt động, Mẫu hoá đơn, Mẫu hợp đồng thuê
2. WHEN Người_dùng chỉnh sửa thông tin và ấn nút Lưu, THE Hệ_thống SHALL cập nhật Căn_hộ và hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
3. IF Người_dùng xoá trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng

### Yêu cầu 8: Xoá căn hộ

**User Story:** Là một Người_dùng, tôi muốn xoá căn hộ không còn sử dụng, để giữ danh sách gọn gàng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xoá tại cột Thao tác của một Căn_hộ, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Căn_hộ (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. THE Hệ_thống SHALL cập nhật số lượng căn hộ của Toà_nhà tương ứng sau khi xoá thành công

### Yêu cầu 9: Database Schema cho Toà nhà, Căn hộ và Dịch vụ toà nhà

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn cho module Toà nhà và Căn hộ, để đảm bảo dữ liệu chính xác, toàn vẹn và bảo mật.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL có bảng `buildings` với các cột hiện tại (id, user_id, area_id, name, code, type, status, province, district, ward, street_address, total_floors, total_rooms, description, images, amenities, created_at, updated_at, deleted_at) và status sử dụng giá trị ACTIVE/INACTIVE thay vì ACTIVE/INACTIVE/MAINTENANCE
2. THE Hệ_thống SHALL có bảng `building_services` (junction table) với các cột: id (UUID PK), building_id (FK tới buildings), service_id (FK tới services), is_active (BOOLEAN default true, toggle sử dụng), unit_price_override (DECIMAL, đơn giá riêng cho toà nhà, nullable - nếu null thì dùng đơn giá mặc định từ services), created_at, updated_at
3. THE Hệ_thống SHALL có bảng `rooms` với các cột hiện tại (id, building_id, name, code, floor, status, area, max_occupants, rent_price, deposit_amount, description, images, amenities, created_at, updated_at, deleted_at) và bổ sung cột invoice_template_id (FK tới document_templates, nullable) và lease_template_id (FK tới document_templates, nullable)
4. THE Hệ_thống SHALL có RLS policies trên bảng `building_services` đảm bảo Người_dùng chỉ truy cập dữ liệu liên kết với Toà_nhà của chính mình
5. THE Hệ_thống SHALL có unique constraint trên `building_services(building_id, service_id)` để tránh trùng lặp
6. THE Hệ_thống SHALL có trigger tự động cập nhật updated_at khi dữ liệu thay đổi trên bảng `building_services`
7. THE Hệ_thống SHALL có indexes tối ưu cho tìm kiếm trên buildings (name, code, street_address) và rooms (name, code)

### Yêu cầu 10: Tạo nhanh toà nhà và tầng từ form căn hộ

**User Story:** Là một Người_dùng, tôi muốn tạo nhanh toà nhà hoặc tầng ngay trong form thêm căn hộ, để không phải rời form khi thiếu dữ liệu liên quan.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng chọn "Thêm toà nhà" trong dropdown Toà nhà tại form Thêm/Sửa căn hộ, THE Hệ_thống SHALL hiển thị dialog nhỏ cho phép nhập tên toà nhà và các thông tin cơ bản
2. WHEN Người_dùng lưu toà nhà mới từ dialog, THE Hệ_thống SHALL tạo Toà_nhà mới, tự động chọn toà nhà vừa tạo trong dropdown, và đóng dialog
3. WHEN Người_dùng chọn "Thêm tầng" trong dropdown Tầng tại form Thêm/Sửa căn hộ, THE Hệ_thống SHALL hiển thị dialog nhỏ cho phép nhập số tầng và tên tầng
4. WHEN Người_dùng lưu tầng mới từ dialog, THE Hệ_thống SHALL tạo Tầng mới thuộc Toà_nhà đã chọn, tự động chọn tầng vừa tạo trong dropdown, và đóng dialog
5. IF Người_dùng chưa chọn Toà nhà khi ấn "Thêm tầng", THEN THE Hệ_thống SHALL hiển thị thông báo yêu cầu chọn Toà nhà trước

### Yêu cầu 11: Toggle hoạt động toà nhà và căn hộ

**User Story:** Là một Người_dùng, tôi muốn bật/tắt trạng thái hoạt động của toà nhà và căn hộ trực tiếp từ danh sách, để quản lý nhanh trạng thái mà không cần mở form chỉnh sửa.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng bật toggle Hoạt động của một Toà_nhà trong bảng danh sách, THE Hệ_thống SHALL cập nhật status của Toà_nhà thành ACTIVE
2. WHEN Người_dùng tắt toggle Hoạt động của một Toà_nhà trong bảng danh sách, THE Hệ_thống SHALL cập nhật status của Toà_nhà thành INACTIVE
3. WHEN Người_dùng bật/tắt toggle Hoạt động của một Căn_hộ trong bảng danh sách, THE Hệ_thống SHALL cập nhật status của Căn_hộ tương ứng (AVAILABLE cho bật, UNAVAILABLE cho tắt)
4. THE Hệ_thống SHALL cập nhật số liệu thống kê (thẻ Đang hoạt động, Ngừng hoạt động) ngay sau khi toggle thay đổi

### Yêu cầu 12: Validation dữ liệu toà nhà và căn hộ

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate dữ liệu đầu vào chính xác, để đảm bảo tính toàn vẹn dữ liệu và tránh lỗi.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate Tên toà nhà không rỗng khi tạo hoặc cập nhật Toà_nhà
2. THE Hệ_thống SHALL validate Tỉnh/Thành phố, Quận/Huyện, Xã/Phường, Địa chỉ chi tiết không rỗng khi tạo hoặc cập nhật Toà_nhà
3. THE Hệ_thống SHALL validate Tên phòng không rỗng khi tạo hoặc cập nhật Căn_hộ
4. THE Hệ_thống SHALL validate Tiền thuê là số không âm khi tạo hoặc cập nhật Căn_hộ
5. THE Hệ_thống SHALL validate Tiền cọc là số không âm khi tạo hoặc cập nhật Căn_hộ
6. THE Hệ_thống SHALL validate Diện tích là số dương (nếu được nhập) khi tạo hoặc cập nhật Căn_hộ
7. THE Hệ_thống SHALL validate Số khách tối đa là số nguyên dương (nếu được nhập) khi tạo hoặc cập nhật Căn_hộ
8. THE Hệ_thống SHALL validate Đơn giá dịch vụ toà nhà là số không âm khi chỉnh sửa trong bảng Dịch vụ toà nhà
9. FOR ALL Toà_nhà hợp lệ, việc tạo rồi đọc lại SHALL cho kết quả khớp với dữ liệu gốc (round-trip property)
10. FOR ALL Căn_hộ hợp lệ, việc tạo rồi đọc lại SHALL cho kết quả khớp với dữ liệu gốc (round-trip property)

### Yêu cầu 13: Địa chỉ cascading dropdown cho toà nhà

**User Story:** Là một Người_dùng, tôi muốn chọn địa chỉ toà nhà qua dropdown liên tầng (Tỉnh → Quận → Phường), để nhập địa chỉ nhanh và chính xác.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị dropdown Tỉnh/Thành phố với danh sách tỉnh thành Việt Nam
2. WHEN Người_dùng chọn Tỉnh/Thành phố, THE Hệ_thống SHALL tải và hiển thị danh sách Quận/Huyện thuộc tỉnh đã chọn trong dropdown Quận/Huyện
3. WHEN Người_dùng chọn Quận/Huyện, THE Hệ_thống SHALL tải và hiển thị danh sách Xã/Phường thuộc quận đã chọn trong dropdown Xã/Phường
4. WHEN Người_dùng thay đổi Tỉnh/Thành phố, THE Hệ_thống SHALL reset giá trị Quận/Huyện và Xã/Phường về trống
5. WHEN Người_dùng thay đổi Quận/Huyện, THE Hệ_thống SHALL reset giá trị Xã/Phường về trống
