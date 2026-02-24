# Kế hoạch Triển khai: Tái hiện thực toàn bộ Ghi chỉ số (Meter Reading)

## Tổng quan

Tái hiện thực toàn bộ module Ghi chỉ số bao gồm: database migrations (bảng, view, functions, triggers), validation schemas (Zod), pure helper functions, React Query hooks, UI components (Meters + Meter Readings), tích hợp hóa đơn, và Supabase Storage cho hình ảnh công tơ. Thứ tự triển khai theo dependency: database → validation → helpers → hooks → UI → integration.

## Tasks

- [x] 1. Database migrations: Bảng, Views, Functions, Triggers
  - [x] 1.1 Tạo migration cho bảng `meters` và `meter_readings`
    - Tạo file `supabase/migrations/xxx_meter_reading_full_reimplementation.sql`
    - Tạo bảng `meters` với đầy đủ cột: id, user_id, code, building_id, room_id, service_id, meter_type, name, initial_reading, status, installation_date, location_note, manufacturer, model, serial_number, notes, created_at, updated_at, deleted_at
    - Tạo bảng `meter_readings` với đầy đủ cột: id, user_id, meter_id, reading_code, contract_id, service_id, building_id, room_id, meter_type, settlement_month, reading_date, previous_reading, current_reading, consumption (GENERATED), status, approved_by, approved_at, recorded_by, notes, meter_image_url, created_at, updated_at, deleted_at
    - Tạo constraint `meter_readings_current_gte_previous CHECK (current_reading >= previous_reading)`
    - Tạo UNIQUE constraint `(user_id, code)` trên bảng `meters`
    - Tạo RLS policies cho cả 2 bảng: user_id = auth.uid(), meters filter deleted_at IS NULL
    - Sử dụng `CREATE TABLE IF NOT EXISTS` hoặc `DROP/CREATE` tuỳ theo schema hiện tại
    - _Yêu cầu: 8.10, 11.3, 12.1, 12.2, 12.4_

  - [x] 1.2 Tạo migration cho views `meter_readings_detailed` và `meters_with_latest_reading`
    - Tạo view `meter_readings_detailed`: JOIN meter_readings với meters, buildings, rooms, services, auth.users (approver + recorder), filter deleted_at IS NULL
    - Cung cấp các cột: meter_code, meter_name, building_name, room_name, service_name, approver_email, recorder_email
    - Tạo view `meters_with_latest_reading`: JOIN meters với buildings, rooms, services, subquery lấy latest_reading, latest_reading_date, total_readings từ meter_readings, filter deleted_at IS NULL
    - _Yêu cầu: 6.1, 1.1_

  - [x] 1.3 Tạo migration cho 4 triggers: auto_populate_meter_reading_fields, auto_populate_previous_reading, auto_generate_reading_code, auto_generate_meter_name
    - `auto_populate_meter_reading_fields`: BEFORE INSERT trên meter_readings, từ meter_id → điền building_id, room_id, meter_type, service_id, settlement_month (từ reading_date), recorded_by (từ auth.uid())
    - `auto_populate_previous_reading`: BEFORE INSERT trên meter_readings, lấy previous_reading từ lần ghi gần nhất theo meter_id (ORDER BY reading_date DESC LIMIT 1), hoặc initial_reading của meter nếu chưa có lần ghi
    - `auto_generate_reading_code`: BEFORE INSERT trên meter_readings, sinh reading_code format CSS{YYMM}{5-digit-seq} (VD: CSS2507000001)
    - `auto_generate_meter_name`: BEFORE INSERT trên meters, sinh name từ room_name + meter_type label (Điện/Nước/Gas)
    - _Yêu cầu: 8.1, 8.2, 8.3, 8.4, 2.5, 2.6, 2.8_

  - [x] 1.4 Tạo migration cho 5 RPC functions: approve_meter_reading, bulk_approve_meter_readings, get_meter_reading_stats, get_meters_without_readings, bulk_create_meter_readings
    - `approve_meter_reading(p_reading_id UUID)`: SECURITY DEFINER, cập nhật status→APPROVED, ghi approved_by/approved_at, RAISE EXCEPTION nếu không tìm thấy hoặc đã duyệt
    - `bulk_approve_meter_readings(p_reading_ids UUID[])`: SECURITY DEFINER, duyệt hàng loạt, trả về số lượng đã duyệt
    - `get_meter_reading_stats(p_building_id UUID, p_month TEXT)`: trả về total_readings, unapproved_count, approved_count, electricity_consumption, water_consumption, gas_consumption
    - `get_meters_without_readings(p_user_id UUID, p_building_id UUID, p_room_id UUID, p_meter_type TEXT, p_month TEXT)`: trả về danh sách công tơ chưa chốt trong tháng, kèm last_reading, last_reading_date
    - `bulk_create_meter_readings(p_readings JSONB)`: SECURITY DEFINER, nhập hàng loạt từ JSONB array, trả về kết quả từng dòng (reading_id, reading_code, success, error_message)
    - _Yêu cầu: 8.5, 8.6, 8.7, 8.8, 8.9, 12.3_

- [x] 2. Checkpoint - Kiểm tra database migrations
  - Đảm bảo tất cả migrations chạy thành công, hỏi người dùng nếu có thắc mắc.

- [x] 3. Validation schemas và pure helper functions
  - [x] 3.1 Tạo file `src/lib/meterReadingValidation.ts` với Zod schemas và validation functions
    - Implement `meterFormSchema`: building_id, room_id, meter_type, code (bắt buộc), initial_reading, installation_date, location_note (tuỳ chọn)
    - Implement `meterReadingFormSchema`: building_id, room_id, meter_type (nullable), settlement_month (regex YYYY-MM), reading_date, readings array (min 1)
    - Implement `excelImportRowSchema`: meter_code, reading_date, current_reading (min 0), notes (optional)
    - Implement `validateReadingValue(currentReading, previousReading)`: trả về lỗi nếu current < previous, null nếu hợp lệ
    - Implement `calculateConsumption(currentReading, previousReading)`: trả về currentReading - previousReading
    - Implement `generateReadingCode(yearMonth, sequence)` và `isValidReadingCode(code)`: sinh và validate mã CSS{YYMM}{5-digit-seq}
    - Implement `validateImportRows(rows)`: trả về { validRows, errors } với partition invariant
    - _Yêu cầu: 11.1, 11.2, 2.5, 2.6, 2.7, 3.6_

  - [x] 3.2 Viết property tests cho validation schemas (Property 8, 9, 10, 12, 21)
    - **Property 8: Consumption calculation** - Với mọi currentReading >= previousReading >= 0, calculateConsumption trả về currentReading - previousReading
    - **Validates: Yêu cầu 2.5**
    - **Property 9: Reading code generation and validation** - Với mọi yearMonth hợp lệ và sequence 1-99999, generateReadingCode tạo code pass isValidReadingCode
    - **Validates: Yêu cầu 2.6, 8.3**
    - **Property 10: Validation rejects current < previous** - Với mọi cặp số current < previous, validateReadingValue trả về lỗi; ngược lại trả về null
    - **Validates: Yêu cầu 2.7, 11.2**
    - **Property 12: Import row validation partition invariant** - Với mọi array rows, validRows.length + errors.length === rows.length
    - **Validates: Yêu cầu 3.5, 3.6**
    - **Property 21: Validation schema round-trip** - Với mọi valid MeterReadingFormValues, serialize→deserialize→parse trả về kết quả tương đương
    - **Validates: Yêu cầu 11.1, 11.5**
    - File: `src/lib/__tests__/meterReadingValidation.property.test.ts`

  - [x] 3.3 Tạo file `src/components/meter-readings/meterReadingFormUtils.ts` với pure helper functions
    - Implement `mapMeterToReading(meter: UnrecordedMeter)`: trả về ReadingFormEntry với meter_id, current_reading=0, notes='', meter_image_url=''
    - Implement `getPreviousReadingFromList(meterId, list)`: trả về last_reading của meter tương ứng, hoặc 0
    - Implement `getMeterNameFromList(meterId, list)`: trả về meter_name (hoặc meter_code nếu name rỗng), hoặc ''
    - Implement `isLoadEnabled(filters)`: trả về true khi cả buildingId và month đều non-empty
    - Implement `createMeterReadingPayload(input)`: tạo payload với status='UNAPPROVED'
    - _Yêu cầu: 2.2, 2.3, 2.4, 2.8_

  - [x] 3.4 Viết property tests cho meterReadingFormUtils (Property 4, 5, 6, 11, 22)
    - **Property 4: Load enabled requires building and month** - isLoadEnabled trả về true iff cả buildingId và month non-empty
    - **Validates: Yêu cầu 2.2**
    - **Property 5: Map meter to reading uses correct field** - mapMeterToReading tạo entry đúng field mapping
    - **Validates: Yêu cầu 2.8, 8.1**
    - **Property 6: Previous reading from list** - getPreviousReadingFromList trả về last_reading hoặc 0
    - **Validates: Yêu cầu 2.3**
    - **Property 11: New reading payload always UNAPPROVED** - createMeterReadingPayload luôn có status='UNAPPROVED'
    - **Validates: Yêu cầu 2.4, 8.10**
    - **Property 22: Meter name from list** - getMeterNameFromList trả về meter_name/meter_code hoặc ''
    - **Validates: Yêu cầu 2.3**
    - File: `src/components/meter-readings/__tests__/meterReadingFormUtils.property.test.ts`

  - [x] 3.5 Tạo file `src/hooks/useMeterReadingsHelpers.ts` với pure helper functions
    - Implement `generateMeterName(roomName, meterType)`: trả về "{roomName} - {typeLabel}" (Điện/Nước/Gas)
    - Implement `filterActiveMeters(meters)`: lọc meters có deleted_at === null
    - Implement `filterMeters(meters, filters)`: lọc theo building_id và meter_type
    - Implement `getPreviousReading(initialReading, entries)`: trả về current_reading của entry đầu tiên hoặc initialReading
    - Implement `applyApproval(reading, approverId, approvedAt)` và `applyUnapproval(reading)`: transform trạng thái duyệt
    - Implement `canEditReading(status)` và `canDeleteReading(status)`: trả về true khi UNAPPROVED
    - Implement `bulkDeleteUnapprovedOnly(readings, ids)`: lọc chỉ xoá UNAPPROVED
    - Implement `applyMeterReadingFilters(readings, filters)`: lọc theo building_id, room_id, meter_type, month, status
    - Implement `paginateList(items, page, pageSize)`: trả về { data, totalCount }
    - Implement `computeStats(readings)`: tính total, approved, unapproved, consumption theo loại
    - Implement `getApprovedReadingsForInvoice(readings, roomId, month)`: lọc APPROVED + roomId + month
    - Implement `calculateInvoiceAmount(consumption, unitPrice)`: trả về consumption * unitPrice
    - _Yêu cầu: 1.3, 1.6, 1.7, 4.2, 4.4, 5.1, 5.2, 5.3, 5.5, 6.2, 6.3, 7.1, 7.2, 8.4, 9.1, 9.2_

  - [x] 3.6 Viết property tests cho useMeterReadingsHelpers (Property 1, 2, 3, 7, 13, 14, 15, 16, 17, 18, 19, 20)
    - **Property 1: Meter name generation follows pattern** - generateMeterName trả về "{roomName} - {typeLabel}"
    - **Validates: Yêu cầu 1.3, 8.4**
    - **Property 2: Active meters filter excludes soft-deleted** - filterActiveMeters chỉ trả về meters có deleted_at === null
    - **Validates: Yêu cầu 1.6, 1.7**
    - **Property 3: Meter filter by building and type** - filterMeters trả về meters khớp tất cả filter criteria
    - **Validates: Yêu cầu 1.7**
    - **Property 7: Previous reading from history** - getPreviousReading trả về current_reading của entry đầu tiên hoặc initialReading
    - **Validates: Yêu cầu 8.2**
    - **Property 13: Approval round-trip** - applyApproval rồi applyUnapproval trả về UNAPPROVED, approved_by=null, approved_at=null
    - **Validates: Yêu cầu 4.2, 4.4**
    - **Property 14: Permission based on approval status** - canEditReading/canDeleteReading trả về true khi UNAPPROVED, false khi APPROVED
    - **Validates: Yêu cầu 5.1, 5.2, 5.3**
    - **Property 15: Bulk delete only removes unapproved** - bulkDeleteUnapprovedOnly chỉ xoá UNAPPROVED, giữ APPROVED
    - **Validates: Yêu cầu 5.5**
    - **Property 16: Filter readings by criteria** - applyMeterReadingFilters trả về readings khớp tất cả filter
    - **Validates: Yêu cầu 6.2**
    - **Property 17: Pagination correctness** - paginateList trả về đúng slice và totalCount
    - **Validates: Yêu cầu 6.3**
    - **Property 18: Stats computation** - computeStats tính đúng total = approved + unapproved, consumption theo loại
    - **Validates: Yêu cầu 7.1, 7.2, 8.7**
    - **Property 19: Approved readings for invoice filter** - getApprovedReadingsForInvoice chỉ trả về APPROVED + roomId + month
    - **Validates: Yêu cầu 9.1**
    - **Property 20: Invoice amount calculation** - calculateInvoiceAmount = consumption * unitPrice
    - **Validates: Yêu cầu 9.2**
    - File: `src/hooks/__tests__/useMeterReadings.property.test.ts`

- [x] 4. Checkpoint - Kiểm tra validation và helpers
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 5. Hooks: useMeters.ts
  - [x] 5.1 Tạo file `src/hooks/useMeters.ts` với React Query hooks cho bảng meters
    - Implement `useMeters(roomId?, meterType?)`: query danh sách công tơ từ bảng meters, filter deleted_at IS NULL, hỗ trợ filter theo roomId và meterType
    - Implement `useMetersWithLatestReading()`: query từ view meters_with_latest_reading
    - Implement `useUnrecordedMeters(buildingId, roomId?, meterType?, month)`: gọi RPC get_meters_without_readings, trả về UnrecordedMeter[]
    - Implement `useCreateMeter()`: mutation INSERT vào meters với user_id = auth.uid(), invalidate queries on success, toast "Dữ liệu đã được TẠO thành công"
    - Implement `useUpdateMeter()`: mutation UPDATE meters, invalidate queries on success, toast "Dữ liệu đã được CẬP NHẬT thành công"
    - Implement `useDeleteMeter()`: mutation soft-delete (UPDATE deleted_at = NOW()), invalidate queries on success, toast "Dữ liệu đã được XOÁ thành công"
    - _Yêu cầu: 1.1, 1.3, 1.5, 1.6, 1.7, 2.2, 2.3_

  - [x] 5.2 Viết property tests cho useMeters pure helpers (Property 2, 3)
    - **Property 2: Active meters filter excludes soft-deleted** - Nếu chưa test ở 3.6
    - **Property 3: Meter filter by building and type** - Nếu chưa test ở 3.6
    - File: `src/hooks/__tests__/useMeters.property.test.ts`
    - **Validates: Yêu cầu 1.6, 1.7**

- [x] 6. Hooks: useMeterReadings.ts
  - [x] 6.1 Tạo file `src/hooks/useMeterReadings.ts` với React Query hooks cho meter_readings
    - Implement `useMeterReadingsList(filters, pagination)`: query từ view meter_readings_detailed với filter building_id, room_id, meter_type, settlement_month, status, hỗ trợ phân trang, trả về { data, totalCount }
    - Implement `useMeterReadingStats(buildingId?, month?)`: gọi RPC get_meter_reading_stats
    - Implement `useCreateMeterReading()`: mutation INSERT vào meter_readings với user_id = auth.uid(), status='UNAPPROVED', invalidate queries, toast thành công
    - Implement `useBulkCreateMeterReadings()`: mutation INSERT nhiều rows, invalidate queries, toast thành công
    - Implement `useImportMeterReadings()`: mutation gọi RPC bulk_create_meter_readings với JSONB payload, invalidate queries, toast kết quả (số thành công/lỗi)
    - Implement `useUpdateMeterReading()`: mutation UPDATE meter_readings (chỉ UNAPPROVED), invalidate queries, toast thành công
    - Implement `useDeleteMeterReading()`: mutation soft-delete (UPDATE deleted_at), invalidate queries, toast thành công
    - Implement `useBulkDeleteMeterReadings()`: mutation soft-delete nhiều rows (chỉ UNAPPROVED), invalidate queries, toast kết quả
    - Implement `useApproveMeterReading()`: mutation gọi RPC approve_meter_reading, invalidate queries, toast thành công
    - Implement `useBulkApproveMeterReadings()`: mutation gọi RPC bulk_approve_meter_readings, invalidate queries, toast kết quả
    - Implement `useUnapproveMeterReading()`: mutation UPDATE status→UNAPPROVED, xoá approved_by/approved_at, invalidate queries, toast thành công
    - _Yêu cầu: 2.4, 3.4, 4.2, 4.3, 4.4, 5.1, 5.2, 5.5, 6.1, 6.2, 6.3, 7.1, 8.5, 8.6, 8.9_

- [x] 7. Checkpoint - Kiểm tra hooks
  - Đảm bảo tất cả hooks compile thành công và tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 8. UI Components - Quản lý Công tơ (Meters)
  - [x] 8.1 Tạo file `src/components/meters/MeterForm.tsx`
    - Dialog thêm/sửa công tơ sử dụng react-hook-form + zodResolver(meterFormSchema)
    - Các trường: Tòa nhà (*) (Select), Phòng (*) (Select, phụ thuộc Tòa nhà), Loại công tơ (*) (Select: Điện/Nước/Gas), Mã công tơ (*) (Input), Chỉ số ban đầu (Input number), Ngày lắp đặt (DatePicker), Ghi chú vị trí (Textarea)
    - Khi chọn Tòa nhà → cập nhật danh sách Phòng tương ứng (useRooms hook)
    - Khi sửa: điền sẵn thông tin từ meter data
    - Gọi useCreateMeter hoặc useUpdateMeter khi submit
    - Xử lý lỗi mã công tơ trùng (PostgreSQL error 23505) → hiển thị "Mã công tơ đã tồn tại"
    - _Yêu cầu: 1.2, 1.3, 1.4, 1.5, 1.8_

  - [x] 8.2 Tạo file `src/components/meters/MeterList.tsx`
    - Bảng danh sách công tơ sử dụng shadcn/ui Table
    - Các cột: Mã công tơ, Tên công tơ, Loại công tơ (badge), Phòng, Tòa nhà, Trạng thái (badge), Chỉ số gần nhất
    - Nút Sửa và Xoá cho mỗi dòng
    - Xoá: hiển thị AlertDialog xác nhận, gọi useDeleteMeter (soft-delete)
    - Sử dụng data từ useMetersWithLatestReading hoặc useMeters
    - _Yêu cầu: 1.1, 1.5, 1.6, 1.7_

  - [x] 8.3 Tạo file `src/pages/settings/MetersPage.tsx`
    - Trang quản lý Công tơ tại Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ
    - Nút dấu (+) mở MeterForm dialog (mode thêm mới)
    - Render MeterList
    - Quản lý state: isFormOpen, editingMeter, deleteTarget
    - _Yêu cầu: 1.1, 1.2_

- [x] 9. UI Components - Ghi chỉ số (Meter Readings)
  - [x] 9.1 Tạo file `src/components/meter-readings/MeterReadingFilters.tsx`
    - Thanh lọc với các trường: Tòa nhà (Select), Phòng (Select, phụ thuộc Tòa nhà), Loại công tơ (Select), Tháng chốt (input type="month"), Trạng thái (Select: Đã duyệt/Chưa duyệt)
    - Khi thay đổi filter → callback onFilterChange, reset trang về 1, xoá checkbox selections
    - _Yêu cầu: 6.2, 6.5_

  - [x] 9.2 Tạo file `src/components/meter-readings/MeterReadingStats.tsx`
    - Hiển thị các thẻ thống kê từ useMeterReadingStats: Công tơ chưa chốt, Chỉ số đã duyệt, Chỉ số chưa duyệt, Tổng tiêu thụ điện (kWh), Tổng tiêu thụ nước (m³)
    - Cập nhật khi filter Tòa nhà hoặc Tháng chốt thay đổi
    - _Yêu cầu: 7.1, 7.2, 7.3_

  - [x] 9.3 Tạo file `src/components/meter-readings/MeterReadingActions.tsx`
    - Thanh thao tác hàng loạt: hiển thị khi có checkbox được chọn
    - Nút Duyệt hàng loạt: gọi useBulkApproveMeterReadings
    - Nút Xoá hàng loạt: hiển thị AlertDialog xác nhận, gọi useBulkDeleteMeterReadings (chỉ UNAPPROVED)
    - Hiển thị số lượng đã chọn
    - _Yêu cầu: 4.3, 5.5, 6.4_

  - [x] 9.4 Tạo file `src/components/meter-readings/MeterReadingList.tsx`
    - Bảng danh sách chỉ số từ useMeterReadingsList (view meter_readings_detailed)
    - Các cột: checkbox, Mã (reading_code + badge trạng thái: xanh "Đã duyệt" / vàng "Chưa duyệt"), Thao tác (DropdownMenu), Công tơ (meter_code + meter_name), Chỉ số đầu, Chỉ số cuối, Số tiêu thụ, Ngày chốt, Người chốt
    - DropdownMenu Thao tác: Duyệt (chỉ UNAPPROVED), Bỏ duyệt (chỉ APPROVED), Cập nhật (disabled khi APPROVED), Xoá (disabled khi APPROVED)
    - Checkbox chọn từng dòng và chọn tất cả
    - Phân trang với tuỳ chọn số dòng mỗi trang
    - Trạng thái trống: "Chưa có chỉ số nào"
    - _Yêu cầu: 4.1, 4.5, 5.1, 5.2, 5.3, 6.1, 6.3, 6.4, 6.6_

  - [x] 9.5 Tạo file `src/components/meter-readings/MeterReadingForm.tsx`
    - Dialog thêm/sửa chỉ số sử dụng react-hook-form + zodResolver(meterReadingFormSchema)
    - Mode thêm: Các trường filter: Tòa nhà (*), Phòng, Loại công tơ, Tháng chốt (*), Ngày chốt (*), checkbox "Công tơ chưa chốt trong tháng"
    - Khi chọn Tòa nhà + Tháng chốt → gọi useUnrecordedMeters → hiển thị bảng công tơ với cột: Tên công tơ, Chỉ số đầu (auto từ last_reading), Chỉ số mới (input), Ngày chốt, Hình ảnh (upload)
    - Sử dụng mapMeterToReading, getPreviousReadingFromList từ meterReadingFormUtils
    - Validation: validateReadingValue cho mỗi dòng (chỉ số mới >= chỉ số đầu)
    - Upload hình ảnh: sử dụng uploadFile() từ src/lib/storage.ts → Supabase Storage bucket "meter-images"
    - Mode sửa: điền sẵn thông tin, cho phép sửa current_reading, notes, meter_image_url
    - Gọi useBulkCreateMeterReadings (thêm) hoặc useUpdateMeterReading (sửa)
    - _Yêu cầu: 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 10.1, 10.2, 11.1, 11.2_

  - [x] 9.6 Tạo file `src/components/meter-readings/MeterReadingImportDialog.tsx`
    - Dialog nhập chỉ số từ file Excel
    - Link "Tải file mẫu tại đây": tải xuống file Excel template với cột Mã công tơ, Ngày chốt, Chỉ số mới, Ghi chú
    - Khu vực upload: "Chọn file" hoặc kéo thả, chấp nhận .xlsx/.xls
    - Đọc file Excel (sử dụng xlsx library), hiển thị preview bảng dữ liệu
    - Validate từng dòng bằng excelImportRowSchema + validateImportRows
    - Nút "Nhập dữ liệu": gọi useImportMeterReadings (RPC bulk_create_meter_readings)
    - Hiển thị kết quả: số bản ghi thành công, số bản ghi lỗi, chi tiết lỗi từng dòng
    - _Yêu cầu: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 9.7 Tạo file `src/pages/meter-readings/MeterReadingsPage.tsx`
    - Trang chính Ghi chỉ số tại Tài chính → Ghi chỉ số
    - Layout: MeterReadingStats → MeterReadingFilters → MeterReadingActions → MeterReadingList
    - Nút dấu (+) mở MeterReadingForm dialog (mode thêm)
    - Nút Import mở MeterReadingImportDialog
    - Quản lý state: filters, selectedIds, isFormOpen, isImportOpen, editingReading, deleteTarget, isBulkDeleteOpen
    - AlertDialog cho xoá đơn lẻ và xoá hàng loạt
    - Khi thay đổi filter → reset selectedIds, reset page về 1
    - _Yêu cầu: 2.1, 3.1, 4.1, 4.3, 5.5, 6.1, 6.2, 6.4, 6.5, 7.1_

- [x] 10. Checkpoint - Kiểm tra UI Components
  - Đảm bảo tất cả components compile thành công, hỏi người dùng nếu có thắc mắc.

- [x] 11. Tích hợp hóa đơn và hoàn thiện
  - [x] 11.1 Tạo file `src/components/invoices/MeterReadingSelector.tsx`
    - Component chọn chỉ số đã duyệt cho hóa đơn
    - Props: roomId, month, meterType, unitPrice, selectedReadingId?, onSelect callback
    - Query chỉ số APPROVED theo roomId + month + meterType từ useMeterReadingsList
    - Hiển thị danh sách chỉ số đã duyệt: reading_code, previous_reading, current_reading, consumption
    - Khi chọn: gọi onSelect với { readingId, consumption, amount: consumption * unitPrice, description }
    - Nếu không có chỉ số đã duyệt: hiển thị cảnh báo + nút "Chốt công tơ" (link đến MeterReadingsPage)
    - _Yêu cầu: 9.1, 9.2, 9.3_

  - [x] 11.2 Tích hợp Supabase Storage cho hình ảnh công tơ
    - Đảm bảo bucket "meter-images" tồn tại (tạo migration hoặc kiểm tra)
    - Sử dụng uploadFile() từ src/lib/storage.ts với path pattern: `readings/{timestamp}_{filename}`
    - Liên kết URL trả về với meter_readings.meter_image_url
    - Xử lý lỗi upload: toast "Không thể tải lên hình ảnh"
    - _Yêu cầu: 10.1, 10.2_

- [x] 12. Checkpoint cuối - Đảm bảo toàn bộ module hoạt động
  - Đảm bảo tất cả tests pass, tất cả components compile thành công, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là tuỳ chọn và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo truy xuất nguồn gốc
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi nhóm task
- Property tests kiểm tra tính đúng đắn phổ quát, unit tests kiểm tra ví dụ cụ thể và edge cases
- Thứ tự triển khai: Database → Validation → Helpers → Hooks → UI → Integration
