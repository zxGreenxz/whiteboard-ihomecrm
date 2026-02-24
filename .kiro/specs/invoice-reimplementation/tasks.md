# Kế hoạch Triển khai: Tái triển khai Module Hoá đơn (Invoice)

## Tổng quan

Triển khai lại toàn bộ module Hoá đơn theo kiến trúc mới: database migration (4 bảng + 3 RPC + triggers + RLS), Template Engine, Excel import/export, React hooks (TanStack Query), và giao diện shadcn/ui. Mỗi task xây dựng dần trên các task trước, kết thúc bằng việc kết nối tất cả thành phần.

## Tasks

- [x] 1. Tạo database migration và schema cơ sở
  - [x] 1.1 Tạo file migration `supabase/migrations/20250601000001_invoice_reimplementation.sql` với enum types (`invoice_status`, `invoice_item_type`, `payment_method`) và 4 bảng: `invoices`, `invoice_items`, `payments`, `excess_amounts` theo đúng schema trong design
    - Bao gồm generated column `remaining_amount`, constraints (UNIQUE contract_id+billing_month WHERE deleted_at IS NULL, total_amount >= 0, issue_date <= due_date)
    - Bao gồm indexes cho các cột thường query: user_id, building_id, contract_id, billing_month, status, deleted_at
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 1.2 Thêm RLS policies cho cả 4 bảng đảm bảo `user_id = auth.uid()` trên tất cả operations (SELECT, INSERT, UPDATE, DELETE)
    - _Requirements: 11.5_

  - [x] 1.3 Tạo trigger tự động cập nhật `updated_at` khi UPDATE trên bảng `invoices` và `payments`
    - _Requirements: 11.9_

- [x] 2. Tạo RPC functions trong migration
  - [x] 2.1 Tạo RPC function `generate_invoices_for_building(p_user_id, p_building_id, p_billing_month, p_invoice_type)` trong file migration
    - Loop qua tất cả hợp đồng hiệu lực trong toà nhà, skip nếu đã tồn tại hoá đơn cho cùng contract_id + billing_month
    - Tạo invoice + invoice_items theo invoice_type (rent_only, service_only, both)
    - Trả về số hoá đơn đã tạo và danh sách hợp đồng bị skip
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 11.6_

  - [x] 2.2 Tạo RPC function `record_invoice_payment(p_user_id, p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url)` trong file migration
    - INSERT payment, UPDATE invoice.paid_amount, tự động tính excess nếu paid > remaining
    - INSERT excess_amounts nếu có tiền thừa, cập nhật status (PARTIAL_PAID hoặc PAID), set paid_date khi PAID
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 11.7_

  - [x] 2.3 Tạo RPC function `get_invoice_statistics(p_user_id, p_building_id, p_room_id, p_status, p_start_date, p_end_date)` trong file migration
    - Trả về tổng paid_amount, tổng remaining_amount, tổng số hoá đơn theo bộ lọc
    - _Requirements: 10.1, 11.8_

- [x] 3. Checkpoint - Kiểm tra migration
  - Ensure migration SQL hợp lệ, không có lỗi cú pháp. Hỏi người dùng nếu có thắc mắc.

- [x] 4. Tạo TypeScript types và utility functions
  - [x] 4.1 Tạo file `src/types/invoice.ts` với đầy đủ TypeScript interfaces/types: `Invoice`, `InvoiceItem`, `Payment`, `ExcessAmount`, `InvoiceStatus`, `InvoiceItemType`, `PaymentMethod`, `InvoiceFilters`, `InvoiceTotals`, `InvoiceFormData`
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 4.2 Tạo file `src/lib/invoiceUtils.ts` (thay thế file cũ) với các hàm: `generateInvoiceNumber`, `calculateInvoiceTotals(items, discount, taxPercent, prepaid)`, `canEditInvoice(status)`, `canDeleteInvoice(status)`, `canApproveInvoice(status)`, `getStatusColor(status)`, `isOverdue(dueDate, status)`
    - `calculateInvoiceTotals`: subtotal = Σ(unit_price × quantity × coefficient), tax_amount = subtotal × tax_percent / 100, total = subtotal - discount + tax_amount, remaining = total - prepaid
    - _Requirements: 1.10, 3.6, 4.4, 13.6_

  - [x]* 4.3 Viết property tests cho tính toán hoá đơn trong `src/lib/__tests__/invoiceCalculations.property.test.ts`
    - **Property 1: Tính toán tổng hoá đơn chính xác**
    - **Validates: Requirements 1.10**

  - [x]* 4.4 Viết property tests cho quyền sửa/xoá theo trạng thái trong `src/lib/__tests__/invoiceStatus.property.test.ts`
    - **Property 6: Quyền sửa/xoá phụ thuộc trạng thái**
    - **Validates: Requirements 3.6, 4.4**

- [x] 5. Tạo Zod validation schemas
  - [x] 5.1 Tạo file `src/lib/invoiceValidation.ts` với Zod schemas: `invoiceFormSchema` (validate form tạo/sửa hoá đơn), `paymentFormSchema` (validate form thu tiền), `autoGenerateSchema` (validate form sinh hoá đơn), `prepaidValidation(prepaid, excessBalance, totalAmount)`
    - Trường bắt buộc: building_id, room_id, contract_id, billing_month, issue_date, due_date, items (non-empty)
    - Validation tiền trả trước: prepaid <= excess_balance AND prepaid <= total_amount
    - _Requirements: 1.11, 1.13, 8.4_

  - [x]* 5.2 Viết property tests cho validation trong `src/lib/__tests__/invoiceValidation.property.test.ts`
    - **Property 2: Validation từ chối input thiếu trường bắt buộc**
    - **Validates: Requirements 1.13**

  - [x]* 5.3 Viết property test cho validation tiền trả trước
    - **Property 3: Validation tiền trả trước**
    - **Validates: Requirements 1.11, 8.4**

- [x] 6. Tạo Template Engine
  - [x] 6.1 Tạo file `src/lib/invoiceTemplateEngine.ts` với các hàm: `renderInvoiceTemplate(template, data)`, `formatCurrencyVND(amount)`, `numberToVietnameseWords(amount)`
    - Thay thế tất cả placeholder đơn `{PLACEHOLDER_NAME}` bằng giá trị từ data
    - Xử lý block lặp `{#FEES}...{/FEES}`: lặp qua danh sách FEES, thay thế `{index}`, `{name}`, `{price}`, `{quantity}`, `{coefficient}`, `{total}`
    - Thay thế `+++IMAGE LOGO()+++` bằng thẻ `<img>` với URL logo
    - Placeholder không có trong data → thay bằng chuỗi rỗng
    - Format số tiền VNĐ: dấu chấm phân cách hàng nghìn
    - Chuyển đổi số thành chữ tiếng Việt
    - _Requirements: 9.2, 9.3, 9.4, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x]* 6.2 Viết property tests cho template engine trong `src/lib/__tests__/invoiceTemplate.property.test.ts`
    - **Property 16: Template engine thay thế tất cả placeholder**
    - **Validates: Requirements 9.2, 12.1, 12.2, 12.7**

  - [x]* 6.3 Viết property test cho FEES loop
    - **Property 17: Template engine render FEES loop chính xác**
    - **Validates: Requirements 9.3, 12.3**

  - [x]* 6.4 Viết property test cho format tiền VNĐ
    - **Property 18: Format tiền VNĐ chính xác**
    - **Validates: Requirements 12.4**

  - [x]* 6.5 Viết property test cho chuyển đổi số thành chữ
    - **Property 19: Chuyển đổi số tiền thành chữ tiếng Việt**
    - **Validates: Requirements 12.5**

  - [x]* 6.6 Viết property test cho template render round-trip
    - **Property 20: Template render round-trip**
    - **Validates: Requirements 12.6**

- [x] 7. Tạo Excel import/export helpers
  - [x] 7.1 Tạo file `src/lib/invoiceExcelHelpers.ts` với các hàm: `generateInvoiceTemplate(building, rooms, services)`, `parseInvoiceExcel(file, buildingId, billingMonth)`, `validateParsedRows(rows)`
    - Tạo file Excel mẫu với danh sách phòng/giường, cột bắt buộc đánh dấu (*), ô màu vàng cho dịch vụ đang dùng, ô trắng N/A cho dịch vụ không dùng
    - Parse file Excel → mảng ParsedInvoiceRow, validate từng dòng, trả về lỗi chi tiết cho dòng sai
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 7.2 Viết property test cho Excel parsing validation
    - **Property 22: Excel parsing validation**
    - **Validates: Requirements 2.4, 2.6**

- [x] 8. Checkpoint - Kiểm tra logic layer
  - Ensure tất cả tests pass (nếu đã viết), kiểm tra types và utility functions không có lỗi TypeScript. Hỏi người dùng nếu có thắc mắc.

- [x] 9. Tạo React hooks cho module hoá đơn
  - [x] 9.1 Tạo file `src/hooks/useInvoices.ts` (thay thế file cũ) với các hooks sử dụng TanStack Query:
    - `useInvoices(filters, pagination)`: query danh sách hoá đơn có phân trang, lọc theo building, room, bed, contract, date range, status; filter `deleted_at IS NULL`
    - `useInvoice(id)`: query chi tiết 1 hoá đơn với relations (invoice_items, building, room, contract)
    - `useCreateInvoice()`: mutation tạo hoá đơn mới (INSERT invoices + invoice_items), set status = DRAFT
    - `useUpdateInvoice()`: mutation cập nhật hoá đơn (check canEditInvoice trước)
    - `useDeleteInvoice()`: mutation soft-delete (UPDATE deleted_at)
    - `useBulkDeleteInvoices()`: mutation soft-delete nhiều hoá đơn
    - Invalidate queries sau mỗi mutation
    - _Requirements: 1.12, 3.1, 3.2, 3.4, 3.5, 10.2, 10.4, 10.5, 13.7_

  - [x] 9.2 Thêm hooks duyệt và thống kê vào `src/hooks/useInvoices.ts`:
    - `useApproveInvoice()`: mutation DRAFT → APPROVED (set approved_at, approved_by)
    - `useUnapproveInvoice()`: mutation APPROVED → DRAFT (clear approved_at, approved_by)
    - `useBulkApproveInvoices()`: mutation duyệt hàng loạt
    - `useInvoiceStatistics(filters)`: query gọi RPC `get_invoice_statistics`
    - `useExcessAmount(contractId)`: query SUM(amount) từ excess_amounts theo contract_id
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 8.2, 10.1_

  - [x] 9.3 Tạo file `src/hooks/useInvoicePayments.ts` với hooks:
    - `useRecordPayment()`: mutation gọi RPC `record_invoice_payment`, invalidate invoice queries
    - `useAutoGenerateInvoices()`: mutation gọi RPC `generate_invoices_for_building`, invalidate queries
    - `useImportInvoicesFromExcel()`: mutation parse Excel → tạo nhiều hoá đơn, trả về kết quả (thành công/lỗi)
    - _Requirements: 2.4, 6.3, 7.1, 7.2_

  - [x]* 9.4 Viết property tests cho trạng thái hoá đơn mới
    - **Property 4: Hoá đơn mới luôn có trạng thái DRAFT**
    - **Validates: Requirements 1.12**

  - [x]* 9.5 Viết property test cho duyệt/bỏ duyệt round-trip
    - **Property 7: Duyệt/Bỏ duyệt là round-trip**
    - **Validates: Requirements 4.2, 4.3, 4.5**

  - [x]* 9.6 Viết property test cho soft-delete
    - **Property 8: Soft-delete đặt deleted_at**
    - **Validates: Requirements 3.4, 3.5**

- [x] 10. Tạo giao diện danh sách hoá đơn
  - [x] 10.1 Tạo component `src/components/invoices/InvoiceStatusBadge.tsx` hiển thị badge màu theo trạng thái: DRAFT (xám), APPROVED (xanh dương), PARTIAL_PAID (vàng), PAID (xanh lá), OVERDUE (đỏ), CANCELLED (đen)
    - _Requirements: 13.6_

  - [x] 10.2 Tạo component `src/components/invoices/InvoiceStatsSummary.tsx` hiển thị 3 thẻ thống kê: Tổng đã thu, Tổng phải thu, Tổng số hoá đơn (sử dụng hook `useInvoiceStatistics`)
    - _Requirements: 10.1_

  - [x] 10.3 Tạo component `src/components/invoices/InvoiceListFilters.tsx` với bộ lọc: Toà nhà (Select), Phòng (Select, lọc theo toà nhà), Giường (Select, lọc theo phòng), Hợp đồng (Select), Khoảng thời gian (DateRangePicker), Trạng thái (Select multi)
    - _Requirements: 10.2, 10.3_

  - [x] 10.4 Tạo component `src/components/invoices/InvoiceActionMenu.tsx` với dropdown menu Thao tác: Cập nhật, Xoá, Thu tiền, Bỏ duyệt (ẩn/hiện theo trạng thái dùng `canEditInvoice`, `canDeleteInvoice`)
    - _Requirements: 3.1, 3.3, 3.6, 4.5, 7.1, 13.3_

  - [x] 10.5 Tạo component `src/components/invoices/InvoiceListTable.tsx` với bảng shadcn/ui DataTable: checkbox chọn nhiều, các cột (Mã HD, Toà nhà, Phòng, Khách thuê, Kỳ TT, Ngày lập, Hạn TT, Tổng tiền, Đã trả, Còn nợ, Trạng thái, Thao tác), hỗ trợ sort và pagination
    - Hiển thị nút Duyệt inline cho hoá đơn DRAFT
    - _Requirements: 10.4, 10.5, 13.3, 13.4, 13.5, 13.7_

  - [x] 10.6 Tạo component `src/components/invoices/InvoiceListToolbar.tsx` với thanh công cụ: nút Thêm (+), Nhập dữ liệu (import), Sinh hoá đơn, Tải hàng loạt ảnh, Tải hàng loạt PDF, Duyệt hàng loạt, Xoá hàng loạt
    - _Requirements: 13.1_

  - [x] 10.7 Tạo/cập nhật trang `src/pages/invoices/InvoicesPage.tsx` (hoặc file tương ứng) kết nối tất cả components: InvoiceStatsSummary + InvoiceListFilters + InvoiceListToolbar + InvoiceListTable
    - _Requirements: 10.3, 13.1, 13.2, 13.3_

- [x] 11. Tạo form tạo/sửa hoá đơn
  - [x] 11.1 Tạo component `src/components/invoices/InvoiceItemsTable.tsx` hiển thị bảng dịch vụ & phí: cột Dịch vụ, Đơn giá, Chỉ số (cho METER_READING), Số lượng, Hệ số, Từ ngày, Đến ngày; nút (+) thêm dòng dịch vụ mới; nút xoá dòng
    - _Requirements: 1.7, 1.8_

  - [x] 11.2 Cập nhật component `src/components/invoices/MeterReadingSelector.tsx` cho phép chọn hoặc tạo chỉ số công tơ, tự động tính quantity = current_reading - previous_reading
    - _Requirements: 1.9_

  - [x]* 11.3 Viết property test cho tính toán số lượng từ chỉ số công tơ
    - **Property 5: Tính toán số lượng từ chỉ số công tơ**
    - **Validates: Requirements 1.9**

  - [x] 11.4 Tạo component `src/components/invoices/InvoiceSummarySection.tsx` hiển thị phần tổng kết: Tạm tính, Giảm giá (input), Thuế % (input), Thành tiền (computed), Trả trước (input, hiển thị tiền thừa hiện có từ `useExcessAmount`), Còn lại (computed)
    - _Requirements: 1.10, 1.11, 8.2, 8.3_

  - [x] 11.5 Tạo component `src/components/invoices/InvoiceForm.tsx` kết hợp: phần Thông tin chung (Toà nhà → Phòng → Giường → Hợp đồng cascade selects, Kỳ TT, Ngày lập, Hạn TT, Mẫu in), InvoiceItemsTable, InvoiceSummarySection
    - Sử dụng react-hook-form + Zod validation schema
    - Khi chọn Toà nhà → lọc Phòng, chọn Phòng → lọc Giường + hiển thị Hợp đồng hiệu lực
    - Khi chọn Hợp đồng → tự động load dịch vụ đang sử dụng vào InvoiceItemsTable
    - Ngày lập mặc định = today, Hạn TT mặc định = today + 5 ngày (hoặc theo cài đặt)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12, 1.13_

  - [x] 11.6 Cập nhật `src/components/invoices/EditInvoiceDialog.tsx` sử dụng InvoiceForm trong chế độ edit, load dữ liệu hoá đơn hiện tại
    - _Requirements: 3.1, 3.2_

- [x] 12. Tạo các dialog chức năng
  - [x] 12.1 Tạo component `src/components/invoices/ApproveConfirmDialog.tsx` với hộp thoại xác nhận duyệt: message "Bạn đang thực hiện thao tác DUYỆT hoá đơn...", nút Huỷ và Duyệt
    - _Requirements: 4.1, 4.2_

  - [x] 12.2 Cập nhật `src/components/invoices/RecordPaymentDialog.tsx` với form thu tiền: Số tiền thu (*), Phương thức thanh toán (*), Ngày thu (*), Ghi chú, Upload ảnh biên lai; sử dụng hook `useRecordPayment`
    - _Requirements: 7.1, 7.2, 7.6_

  - [x] 12.3 Cập nhật `src/components/invoices/AutoGenerateInvoicesDialog.tsx` với form sinh hoá đơn: Kỳ thanh toán (*), Toà nhà (*), Hình thức (3 radio: Chỉ tiền nhà, Chỉ tiền dịch vụ, Tiền nhà & Dịch vụ); sử dụng hook `useAutoGenerateInvoices`
    - _Requirements: 6.1, 6.2_

  - [x] 12.4 Tạo component `src/components/invoices/ImportExcelDialog.tsx` (thay thế dialog cũ nếu có) với: chọn tháng, chọn toà nhà, link tải file mẫu, vùng upload file; sử dụng hooks `useImportInvoicesFromExcel` và `invoiceExcelHelpers`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 12.5 Viết property tests cho thanh toán và tiền thừa trong `src/lib/__tests__/invoicePayment.property.test.ts`
    - **Property 11: Thanh toán cập nhật paid_amount chính xác**
    - **Validates: Requirements 7.2**

  - [x]* 12.6 Viết property test cho trạng thái thanh toán
    - **Property 12: Trạng thái hoá đơn phản ánh đúng tình trạng thanh toán**
    - **Validates: Requirements 7.3, 7.4, 7.7**

  - [x]* 12.7 Viết property test cho thanh toán vượt mức
    - **Property 13: Thanh toán vượt mức tạo tiền thừa**
    - **Validates: Requirements 7.5, 8.1**

  - [x]* 12.8 Viết property test cho số dư tiền thừa
    - **Property 14: Số dư tiền thừa chính xác**
    - **Validates: Requirements 8.2**

  - [x]* 12.9 Viết property test cho remaining_amount
    - **Property 15: remaining_amount luôn nhất quán**
    - **Validates: Requirements 7.6, 11.9**

- [x] 13. Checkpoint - Kiểm tra giao diện cơ bản
  - Ensure tất cả components render không lỗi, TypeScript không có lỗi. Hỏi người dùng nếu có thắc mắc.

- [x] 14. Tạo trang chi tiết hoá đơn và chức năng in/tải/gửi
  - [x] 14.1 Tạo component `src/components/invoices/InvoiceDetailPage.tsx` hiển thị chi tiết hoá đơn: thông tin chung, bảng dịch vụ & phí, tổng kết, lịch sử thanh toán; các nút hành động: Gửi hoá đơn, Tải hoá đơn, In hoá đơn
    - _Requirements: 5.1_

  - [x] 14.2 Tạo component `src/components/invoices/InvoiceSendActions.tsx` với các phương thức gửi: Sao chép liên kết (copy URL to clipboard), Thông báo qua App, Zalo OA, Zalo Bot, Email
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 14.3 Cập nhật `src/components/invoices/PrintInvoiceDialog.tsx` sử dụng Template Engine để render hoá đơn từ mẫu, mở hộp thoại in trình duyệt; hỗ trợ tải xuống ảnh và PDF
    - Sử dụng `renderInvoiceTemplate` từ invoiceTemplateEngine.ts
    - Hỗ trợ tải hàng loạt (ảnh/PDF) cho nhiều hoá đơn đã chọn
    - _Requirements: 5.8, 5.9, 5.10, 9.1, 9.2, 9.3, 9.4_

- [x] 15. Tạo RPC functions cho sinh hoá đơn và thống kê (property tests)
  - [x]* 15.1 Viết property tests cho sinh hoá đơn trong `src/lib/__tests__/invoiceGeneration.property.test.ts`
    - **Property 9: Loại hình thức sinh hoá đơn quyết định loại dòng dịch vụ**
    - **Validates: Requirements 6.4, 6.5, 6.6**

  - [x]* 15.2 Viết property test cho idempotence sinh hoá đơn
    - **Property 10: Sinh hoá đơn không tạo trùng lặp (Idempotence)**
    - **Validates: Requirements 6.7**

  - [x]* 15.3 Viết property test cho thống kê hoá đơn trong `src/lib/__tests__/invoiceStatistics.property.test.ts`
    - **Property 21: Thống kê hoá đơn chính xác**
    - **Validates: Requirements 10.1**

- [x] 16. Kết nối routing và tích hợp cuối cùng
  - [x] 16.1 Cập nhật routing trong `src/App.tsx` (hoặc router config) để kết nối các trang mới: danh sách hoá đơn, chi tiết hoá đơn, tạo hoá đơn mới
    - _Requirements: 1.1, 5.1, 13.1_

  - [x] 16.2 Đảm bảo tích hợp đúng với các module hiện có: buildings (useBuildings), rooms (useRooms), beds (useBeds), contracts (useContracts), services (useServices), meter_readings (useMeterReadings), document_templates (useDocumentTemplates), settings (useSettings cho hạn thanh toán mặc định)
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.9_

  - [x] 16.3 Xử lý trạng thái OVERDUE: thêm logic kiểm tra và cập nhật hoá đơn quá hạn khi load danh sách (client-side check hoặc scheduled function)
    - _Requirements: 7.7, 11.10_

- [x] 17. Final checkpoint - Kiểm tra toàn bộ
  - Ensure tất cả tests pass, không có lỗi TypeScript, tất cả components kết nối đúng. Hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional, có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến requirements cụ thể để đảm bảo traceability
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra tính đúng đắn tổng quát, unit tests kiểm tra ví dụ cụ thể và edge cases
- Ngôn ngữ triển khai: TypeScript (React frontend + Supabase/PostgreSQL backend)
