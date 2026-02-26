# Requirements Document — Quản lý Hợp đồng thuê (Lease Contract Management)

## Introduction

Module Quản lý Hợp đồng thuê (Lease Contract Management) là phần cốt lõi trong hệ thống quản lý vận hành căn hộ/phòng trọ. Module cho phép chủ nhà tạo, theo dõi, gia hạn, chuyển phòng, nhượng, đăng ký ngày chuyển đi, thanh lý hợp đồng và quản lý toàn bộ vòng đời hợp đồng thuê. Giao diện bao gồm trang danh sách hợp đồng với thẻ thống kê, bộ lọc nâng cao, bảng dữ liệu và các dialog thao tác. Hệ thống sử dụng Supabase (PostgreSQL), React + TypeScript, TanStack Query, React Hook Form + Zod, shadcn/ui, Tailwind CSS.

## Glossary

- **Contract_System**: Hệ thống quản lý hợp đồng thuê, bao gồm trang danh sách, form tạo/sửa, và các dialog thao tác
- **Contract**: Bản ghi hợp đồng thuê giữa chủ nhà và khách thuê, lưu trong bảng `contracts`
- **Contract_List_Page**: Trang hiển thị danh sách hợp đồng với thẻ thống kê, bộ lọc, bảng dữ liệu
- **Stats_Cards**: Bốn thẻ thống kê ở đầu trang: Tất cả, Sắp hết hạn, Quá hạn, Đã thanh lý
- **Filter_Bar**: Thanh bộ lọc gồm: Khu vực, Toà nhà, Phòng, Giường, Dạng thuê, Tháng
- **Contract_Table**: Bảng hiển thị danh sách hợp đồng với các cột dữ liệu và cột thao tác
- **Action_Buttons**: Các nút thao tác trong cột Thao tác: Cập nhật, Gia hạn, Chuyển phòng, Đăng ký chuyển đi, Nhượng HĐ, Thanh lý, Xóa
- **Create_Contract_Form**: Form tạo hợp đồng mới gồm 4 phần: Thông tin chung, Khách hàng, Tiền thuê & Tiền cọc, Tiền phí dịch vụ
- **Renew_Dialog**: Dialog gia hạn hợp đồng
- **Transfer_Room_Dialog**: Dialog chuyển phòng/giường
- **Move_Out_Dialog**: Dialog đăng ký ngày chuyển đi
- **Transfer_Contract_Dialog**: Dialog nhượng hợp đồng cho khách thuê mới
- **Terminate_Dialog**: Dialog thanh lý hợp đồng (2 trường hợp: Khách bỏ cọc, Khách rời phòng)
- **Import_Dialog**: Dialog nhập hợp đồng từ file Excel
- **Building**: Toà nhà trong hệ thống
- **Room**: Phòng/Căn hộ thuộc toà nhà
- **Bed**: Giường thuộc phòng (mô hình KTX/homestay)
- **Customer**: Khách hàng/khách thuê
- **Service**: Dịch vụ đi kèm hợp đồng (điện, nước, internet, v.v.)
- **Deposit**: Tiền đặt cọc
- **Payment_Cycle**: Chu kỳ thanh toán (1 tháng, 3 tháng, 6 tháng, 12 tháng)
- **Contract_Status**: Trạng thái hợp đồng: Còn hạn (ACTIVE), Sắp hết hạn, Quá hạn (EXPIRED), Sắp chuyển đi, Đã thanh lý (TERMINATED)

## Requirements

### Requirement 1: Hiển thị trang danh sách hợp đồng

**User Story:** As a chủ nhà, I want to xem danh sách hợp đồng thuê với thống kê tổng quan, so that I can nắm bắt tình trạng hợp đồng nhanh chóng.

#### Acceptance Criteria

1. WHEN the user navigates to the Contract_List_Page, THE Contract_System SHALL display four Stats_Cards showing counts for: "Tất cả" (total contracts), "Sắp hết hạn" (contracts expiring within 30 days), "Quá hạn" (expired contracts), "Đã thanh lý" (terminated contracts).
2. WHEN the user clicks on a Stats_Card, THE Contract_System SHALL filter the Contract_Table to show only contracts matching the selected status category.
3. THE Contract_List_Page SHALL display the Filter_Bar with dropdown selectors for: Khu vực (Area), Toà nhà (Building), Phòng (Room), Giường (Bed), Dạng thuê (Rental type), and Tháng (Month).
4. WHEN the user selects a filter value in the Filter_Bar, THE Contract_System SHALL reload the Contract_Table showing only contracts matching all selected filter criteria.
5. WHEN the user selects a Toà nhà filter, THE Contract_System SHALL update the Phòng dropdown to show only rooms belonging to the selected building.
6. WHEN the user selects a Phòng filter, THE Contract_System SHALL update the Giường dropdown to show only beds belonging to the selected room.
7. THE Contract_List_Page SHALL display a search bar that filters contracts by contract code, customer name, phone number, or room name.
8. THE Contract_Table SHALL display columns: checkbox, Mã hợp đồng, Trạng thái, Thao tác, Vị trí (Toà nhà - Phòng - Giường), Khách hàng, Giá thuê, Tiền cọc, Ngày bắt đầu, Ngày kết thúc, Người tạo.
9. THE Contract_Table SHALL support pagination with configurable page sizes (10, 20, 50, 100).
10. THE Contract_List_Page SHALL display action buttons in the header: Add (+), Import data (upload icon), Export (download icon), and Filter toggle.

### Requirement 2: Tạo hợp đồng mới

**User Story:** As a chủ nhà, I want to tạo hợp đồng thuê mới cho khách, so that I can ghi nhận thông tin thuê phòng chính thức.

#### Acceptance Criteria

1. WHEN the user clicks the Add (+) button, THE Contract_System SHALL open the Create_Contract_Form as a full-page dialog or dedicated page.
2. THE Create_Contract_Form SHALL display section "Thông tin chung" with fields: Toà nhà (required, dropdown), Phòng (required, dropdown filtered by building), Giường (optional, dropdown filtered by room), Ngày ký, Ngày bắt đầu (required), Hạn hợp đồng (required, date picker for end date), Mẫu hợp đồng thuê (optional, dropdown), Mẫu in hoá đơn (optional, dropdown), Ghi chú (optional, textarea).
3. WHEN the user selects a Toà nhà in the Create_Contract_Form, THE Contract_System SHALL load and display only rooms belonging to that building in the Phòng dropdown.
4. THE Create_Contract_Form SHALL display section "Khách hàng" with an "Add Customer" button that opens a customer selection dialog showing existing customers with search and option to create new customer.
5. WHEN the user selects a customer from the selection dialog, THE Contract_System SHALL display the selected customer information (name, phone, ID number) in the Khách hàng section.
6. THE Create_Contract_Form SHALL support selecting multiple customers (tenants) for a single contract, with one designated as the representative.
7. THE Create_Contract_Form SHALL display section "Tiền thuê & Tiền cọc" with fields: Tiền thuê (rent amount), Chu kỳ thanh toán (payment cycle: 1/3/6/12 months), Ngày bắt đầu tính tiền (billing start date), Tiền cọc (deposit amount), Đã đặt cọc (auto-populated from existing deposit records), Tiền cọc phải đóng (calculated: Tiền cọc - Đã đặt cọc), Số tháng giảm (discount months), Số tiền giảm mỗi tháng (discount amount per month).
8. WHEN the user enters Tiền cọc and the system has existing deposit records for the selected customer and room, THE Contract_System SHALL auto-populate the "Đã đặt cọc" field and calculate "Tiền cọc phải đóng" as the difference.
9. THE Create_Contract_Form SHALL display section "Tiền phí dịch vụ" with an "Add Service" button that opens a service selection dialog showing available services.
10. WHEN the user selects services, THE Contract_System SHALL display each service with fields for: meter selection (for metered services), initial reading (chỉ số đầu), quantity, and unit price.
11. WHEN the user clicks "Lưu" (Save) with all required fields filled, THE Contract_System SHALL create the contract record, associate selected customers, associate selected services, and display a success toast "Dữ liệu đã được TẠO thành công".
12. IF the user clicks "Lưu" with missing required fields, THEN THE Contract_System SHALL highlight the missing fields and display validation error messages.
13. WHEN a contract is created successfully, THE Contract_System SHALL auto-generate a contract number based on the configured format in settings.

### Requirement 3: Cập nhật hợp đồng

**User Story:** As a chủ nhà, I want to cập nhật thông tin hợp đồng, so that I can sửa đổi thông tin khi cần thiết.

#### Acceptance Criteria

1. WHEN the user clicks the "Cập nhật" (Edit) button in the Action_Buttons column, THE Contract_System SHALL open the Create_Contract_Form pre-populated with the existing contract data.
2. THE Contract_System SHALL allow editing all fields of the contract except the contract number and creation date.
3. WHEN the user saves the updated contract, THE Contract_System SHALL update the contract record and display a success toast "Dữ liệu đã được CẬP NHẬT thành công".
4. IF the contract status is TERMINATED, THEN THE Contract_System SHALL disable the "Cập nhật" button for that contract.

### Requirement 4: Gia hạn hợp đồng

**User Story:** As a chủ nhà, I want to gia hạn hợp đồng cho khách thuê tiếp, so that I can kéo dài thời hạn thuê mà không cần tạo hợp đồng mới.

#### Acceptance Criteria

1. WHEN the user clicks "Gia hạn hợp đồng" in the Action_Buttons, THE Contract_System SHALL open the Renew_Dialog displaying current contract end date and fields for: Ngày kết thúc mới (new end date, required), Giá thuê mới (new rent amount, optional, defaults to current), Tiền cọc mới (new deposit, optional, defaults to current), Ghi chú (notes, optional).
2. WHEN the user saves the renewal, THE Contract_System SHALL update the contract end_date to the new date, update rent_price if changed, update total_deposit if changed, and record the extension in contract_extensions table.
3. WHEN the renewal is saved successfully, THE Contract_System SHALL display a success toast and refresh the contract list.
4. THE Renew_Dialog SHALL only be available for contracts with status ACTIVE or EXPIRED.

### Requirement 5: Chuyển phòng/giường

**User Story:** As a chủ nhà, I want to chuyển khách thuê sang phòng/giường khác, so that I can đáp ứng nhu cầu thay đổi chỗ ở của khách.

#### Acceptance Criteria

1. WHEN the user clicks "Chuyển phòng" in the Action_Buttons, THE Contract_System SHALL open the Transfer_Room_Dialog displaying current contract info (building, room, bed, customer) and fields for: Toà nhà mới, Phòng mới (required), Giường mới (optional), Giá thuê mới (optional), Ngày chuyển, Ghi chú.
2. WHEN the user saves the room transfer, THE Contract_System SHALL terminate the current contract (set status to TERMINATED), create a new contract with the new room/bed and transferred information, and link the new contract to the old one via parent_contract_id.
3. WHEN the room transfer is saved successfully, THE Contract_System SHALL update the old room status to AVAILABLE and the new room status to OCCUPIED.
4. THE Transfer_Room_Dialog SHALL only show rooms with status AVAILABLE in the new room dropdown.
5. THE Transfer_Room_Dialog SHALL only be available for contracts with status ACTIVE.

### Requirement 6: Đăng ký ngày chuyển đi

**User Story:** As a chủ nhà, I want to đăng ký ngày khách dự kiến chuyển đi, so that I can lên kế hoạch tìm khách thuê mới.

#### Acceptance Criteria

1. WHEN the user clicks "Đăng ký ngày chuyển đi" in the Action_Buttons, THE Contract_System SHALL open the Move_Out_Dialog with fields: Ngày sẽ chuyển đi (required, date picker), Ghi chú (optional, textarea).
2. WHEN the user saves the move-out registration, THE Contract_System SHALL update the contract's expected_move_out_date field with the selected date.
3. WHEN the expected_move_out_date is set on a contract, THE Contract_Table SHALL display the status as "Sắp chuyển đi" with an orange badge for that contract.
4. THE Move_Out_Dialog SHALL only be available for contracts with status ACTIVE.
5. WHEN the user registers a move-out date, THE Contract_System SHALL display a success toast confirming the registration.

### Requirement 7: Nhượng hợp đồng

**User Story:** As a chủ nhà, I want to nhượng hợp đồng từ khách cũ sang khách mới, so that I can xử lý trường hợp khách thuê chuyển nhượng quyền thuê.

#### Acceptance Criteria

1. WHEN the user clicks "Nhượng hợp đồng" in the Action_Buttons, THE Contract_System SHALL open the Transfer_Contract_Dialog displaying current contract info and fields for: Khách hàng mới (required, customer selection), Giá thuê mới (optional), Tiền cọc mới (optional), Ngày nhượng, Ghi chú.
2. WHEN the user saves the contract transfer, THE Contract_System SHALL terminate the current contract (set status to TRANSFERRED), create a new contract with the new customer keeping the same room/bed, and link the new contract to the old one via parent_contract_id.
3. WHEN the contract transfer is saved successfully, THE Contract_System SHALL display a success toast and refresh the contract list showing both the terminated old contract and the new active contract.
4. THE Transfer_Contract_Dialog SHALL only be available for contracts with status ACTIVE.

### Requirement 8: Thanh lý hợp đồng — Khách bỏ cọc

**User Story:** As a chủ nhà, I want to thanh lý hợp đồng khi khách bỏ cọc, so that I can ghi nhận tiền cọc vào doanh thu và giải phóng phòng.

#### Acceptance Criteria

1. WHEN the user clicks "Thanh lý hợp đồng" in the Action_Buttons, THE Contract_System SHALL open the Terminate_Dialog with two options: "Khách bỏ cọc" and "Khách rời phòng".
2. WHEN the user selects "Khách bỏ cọc", THE Terminate_Dialog SHALL display fields: Ngày khách bỏ cọc (required, date picker).
3. WHEN the user confirms "Lập hoá đơn & thanh lý" for deposit forfeiture, THE Contract_System SHALL set the contract status to TERMINATED, record the deposit amount as revenue in the cash book, create a termination record with type FORFEIT, and update the room/bed status to AVAILABLE.
4. WHEN the deposit forfeiture termination is completed, THE Contract_System SHALL display a success toast and refresh the contract list.

### Requirement 9: Thanh lý hợp đồng — Khách rời phòng

**User Story:** As a chủ nhà, I want to thanh lý hợp đồng khi khách rời phòng, so that I can tính toán hoàn cọc, công nợ và hoàn tất thủ tục.

#### Acceptance Criteria

1. WHEN the user selects "Khách rời phòng" in the Terminate_Dialog, THE Contract_System SHALL display four sections: Thông tin hợp đồng, Công nợ khách hàng, Hoàn cọc và tiền thừa, Tổng hợp.
2. THE "Thông tin hợp đồng" section SHALL display: contract number, customer name, room, start date, end date, and a required field "Ngày chuyển đi" (move-out date).
3. THE "Công nợ khách hàng" section SHALL display a list of all unpaid invoices for the contract with invoice number, period, total amount, paid amount, and remaining amount.
4. THE "Hoàn cọc và tiền thừa" section SHALL display fields: Tiền cọc hoàn trả (deposit refund amount), Phí phạt (penalty fee, optional), Tiền phòng thừa (excess rent, optional).
5. THE "Tổng hợp" section SHALL calculate and display: total outstanding debt, total deposit, total deductions (debt + penalties + fees), and final settlement amount (positive = landlord pays tenant, negative = tenant pays landlord).
6. WHEN the user confirms "Lập hoá đơn & Thanh lý", THE Contract_System SHALL set the contract status to TERMINATED, create a termination record with all calculated amounts, create a cash book entry for the refund or collection, update the room/bed status to AVAILABLE, and display a success toast.
7. THE Contract_System SHALL recalculate the Tổng hợp section in real-time as the user modifies penalty fees, deposit refund, or excess rent values.

### Requirement 10: Xóa hợp đồng

**User Story:** As a chủ nhà, I want to xóa hợp đồng không cần thiết, so that I can dọn dẹp dữ liệu.

#### Acceptance Criteria

1. WHEN the user clicks "Xóa" in the Action_Buttons, THE Contract_System SHALL display a confirmation dialog asking "Bạn có chắc chắn muốn xóa hợp đồng này?".
2. WHEN the user confirms deletion, THE Contract_System SHALL delete the contract record and display a success toast "Hợp đồng đã được xóa thành công".
3. IF the contract has associated invoices or termination records, THEN THE Contract_System SHALL display a warning message and prevent deletion.
4. THE delete action SHALL only be available for contracts with status DRAFT or contracts that have no associated financial records.

### Requirement 11: Nhập hợp đồng từ file Excel

**User Story:** As a chủ nhà, I want to nhập hàng loạt hợp đồng từ file Excel, so that I can tạo dữ liệu nhanh khi có số lượng khách thuê lớn.

#### Acceptance Criteria

1. WHEN the user clicks the Import button, THE Contract_System SHALL open the Import_Dialog with a building selector dropdown and a "Tải file mẫu tại đây" download link.
2. WHEN the user clicks "Tải file mẫu tại đây", THE Contract_System SHALL download an Excel template file with columns matching the contract creation fields: Phòng, Giường, Tên khách hàng, SĐT, CCCD, Ngày ký, Ngày bắt đầu, Ngày kết thúc, Tiền thuê, Chu kỳ thanh toán, Tiền cọc, Ghi chú.
3. THE Import_Dialog SHALL provide a file upload area supporting drag-and-drop and click-to-select for .xlsx and .xls files.
4. WHEN the user uploads a valid Excel file and clicks "Nhập dữ liệu", THE Contract_System SHALL parse each row, validate required fields, create contracts for valid rows, and report results showing success count and failure details.
5. IF a row in the Excel file has missing required fields or invalid data, THEN THE Contract_System SHALL skip that row and include the error details in the import result report.
6. WHEN the import completes, THE Contract_System SHALL display a result dialog showing the number of successfully imported contracts and a list of failed rows with error reasons.

### Requirement 12: Xuất dữ liệu hợp đồng

**User Story:** As a chủ nhà, I want to xuất danh sách hợp đồng ra file Excel, so that I can lưu trữ hoặc báo cáo offline.

#### Acceptance Criteria

1. WHEN the user clicks the Export button, THE Contract_System SHALL generate and download an Excel file containing all contracts matching the current filter criteria.
2. THE exported Excel file SHALL include columns: Mã hợp đồng, Trạng thái, Vị trí (Toà nhà - Phòng - Giường), Khách hàng, SĐT, Giá thuê, Tiền cọc, Ngày bắt đầu, Ngày kết thúc, Chu kỳ thanh toán, Ghi chú.

### Requirement 13: Quản lý trạng thái hợp đồng

**User Story:** As a chủ nhà, I want to hệ thống tự động cập nhật trạng thái hợp đồng, so that I can biết hợp đồng nào sắp hết hạn hoặc đã quá hạn.

#### Acceptance Criteria

1. THE Contract_System SHALL display contract status with color-coded badges: "Còn hạn" (ACTIVE, green), "Sắp hết hạn" (expiring within 30 days, orange/yellow), "Quá hạn" (EXPIRED, red), "Sắp chuyển đi" (has expected_move_out_date, orange), "Đã thanh lý" (TERMINATED, gray/red).
2. WHEN a contract's end_date is within 30 days from the current date and the contract status is ACTIVE, THE Contract_System SHALL display the status as "Sắp hết hạn" in the Stats_Cards count and Contract_Table badge.
3. WHEN a contract's end_date has passed and the contract status is ACTIVE, THE Contract_System SHALL display the status as "Quá hạn" in the Stats_Cards count and Contract_Table badge.
4. WHEN a contract has an expected_move_out_date set, THE Contract_System SHALL display the status as "Sắp chuyển đi" regardless of the end_date proximity.

### Requirement 14: Thao tác hàng loạt trên bảng hợp đồng

**User Story:** As a chủ nhà, I want to chọn nhiều hợp đồng cùng lúc, so that I can thực hiện thao tác hàng loạt.

#### Acceptance Criteria

1. THE Contract_Table SHALL display a checkbox column as the first column for each row.
2. THE Contract_Table SHALL display a "select all" checkbox in the header that toggles selection of all visible contracts.
3. WHEN one or more contracts are selected via checkboxes, THE Contract_System SHALL display a bulk action bar with available actions (e.g., bulk export, bulk delete for DRAFT contracts).

### Requirement 15: Bộ lọc nâng cao theo dạng thuê và tháng

**User Story:** As a chủ nhà, I want to lọc hợp đồng theo dạng thuê và tháng, so that I can xem hợp đồng theo tiêu chí cụ thể.

#### Acceptance Criteria

1. THE Filter_Bar SHALL include a "Dạng thuê" dropdown with options matching building types: Chung cư mini, Nhà trọ, Căn hộ dịch vụ, Ký túc xá, Homestay, etc.
2. THE Filter_Bar SHALL include a "Chọn tháng" date picker that filters contracts by their active period (start_date to end_date) overlapping with the selected month.
3. WHEN the user selects a "Dạng thuê" filter, THE Contract_System SHALL filter contracts to show only those associated with buildings of the selected type.
4. WHEN the user clears all filters, THE Contract_System SHALL reset the Contract_Table to show all contracts.
