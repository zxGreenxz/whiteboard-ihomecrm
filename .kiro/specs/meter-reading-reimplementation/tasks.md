# Kế hoạch Triển khai: Tái triển khai Đồng hồ Công tơ & Ghi chỉ số

## Tổng quan

Tái triển khai hoàn toàn hai module Quản lý Công tơ (Meters) và Ghi chỉ số (Meter Readings) trong hệ thống Resident. Database schema đã có sẵn (migrations 016-018), chỉ cần triển khai lại frontend: hooks, components, pages, validation. Sử dụng React + TypeScript + Supabase + shadcn/ui + React Query + Zod theo pattern hiện có trong dự án.

## Tasks

- [x] 1. Tạo Zod validation schemas và types dùng chung
  - [x] 1.1 Tạo file `src/lib/meterReadingValidation.ts` với các Zod schemas
    - Tạo `meterFormSchema` cho form Thêm/Sửa Công tơ (building_id, room_id, meter_type, code là bắt buộc)
    - Tạo `meterReadingFormSchema` cho form Ghi chỉ số (building_id, room_id, settlement_month, reading_date, readings array)
    - Tạo `excelImportRowSchema` cho dòng import Excel (meter_code, reading_date, current_reading)
    - Tạo hàm `validateReadingValue(currentReading, previousReading)` trả về lỗi nếu chỉ số mới < chỉ số đầu
    - _Yêu cầu: 2.2, 2.5, 2.6, 5.1, 5.7, 6.6_

  - [x] 1.2 Viết property test cho validation từ chối input thiếu trường bắt buộc
    - **Property 3: Validation từ chối input thiếu trường bắt buộc**
    - **Validates: Yêu cầu 2.6**

  - [x] 1.3 Viết property test cho validation chỉ số mới < chỉ số đầu
    - **Property 10: Validation từ chối chỉ số mới < chỉ số đầu**
    - **Validates: Yêu cầu 5.7**

  - [x] 1.4 Viết property test cho số tiêu thụ = chỉ số mới - chỉ số đầu
    - **Property 8: Số tiêu thụ = Chỉ số mới - Chỉ số đầu**
    - **Validates: Yêu cầu 5.5**

- [x] 2. Tái triển khai hook `useMeters.ts` với query nhóm theo phòng
  - [x] 2.1 Mở rộng `src/hooks/useMeters.ts` thêm hook `useMetersGroupedByRoom`
    - Thêm hook `useMetersGroupedByRoom(buildingId?, meterType?)` query meters kèm join buildings + rooms, nhóm kết quả theo room_id
    - Thêm hook `useUnrecordedMeters(buildingId?, roomId?, meterType?, month)` query công tơ chưa chốt trong tháng
    - Giữ nguyên các hook CRUD hiện có (useMeters, useCreateMeter, useUpdateMeter, useDeleteMeter)
    - _Yêu cầu: 1.1, 1.2, 1.3, 1.4, 5.2_

  - [x] 2.2 Viết property test cho nhóm công tơ theo phòng
    - **Property 1: Nhóm công tơ theo phòng đúng**
    - **Validates: Yêu cầu 1.1**

  - [x] 2.3 Viết property test cho bộ lọc công tơ
    - **Property 2: Bộ lọc công tơ chỉ trả về kết quả phù hợp**
    - **Validates: Yêu cầu 1.4**

  - [x] 2.4 Viết property test cho soft-delete ẩn khỏi danh sách
    - **Property 5: Soft-delete đảm bảo ẩn khỏi danh sách**
    - **Validates: Yêu cầu 4.2, 4.4**

- [x] 3. Tạo hook mới `useMeterReadings.ts`
  - [x] 3.1 Tạo file `src/hooks/useMeterReadings.ts` với các query hooks
    - Tạo `useMeterReadingsList(filters, pagination)` query từ view `meter_readings_detailed` với lọc theo building_id, room_id, meter_type, month, status và phân trang
    - Tạo `useMeterReadingStats(buildingId?, month?)` gọi RPC `get_meter_reading_stats`
    - _Yêu cầu: 9.1, 9.2, 9.3, 10.1, 10.2, 10.3_

  - [x] 3.2 Thêm các mutation hooks vào `useMeterReadings.ts`
    - Tạo `useCreateMeterReading()` insert vào bảng meter_readings với status UNAPPROVED
    - Tạo `useBulkCreateMeterReadings()` cho form ghi chỉ số nhiều công tơ cùng lúc
    - Tạo `useImportMeterReadings()` gọi RPC `bulk_create_meter_readings` cho import Excel
    - Tạo `useUpdateMeterReading()` cập nhật chỉ số (chỉ khi UNAPPROVED)
    - Tạo `useDeleteMeterReading()` soft-delete (chỉ khi UNAPPROVED)
    - Tạo `useBulkDeleteMeterReadings()` xoá hàng loạt chỉ số chưa duyệt
    - _Yêu cầu: 5.4, 5.5, 5.6, 6.4, 7.1, 7.2, 7.4_

  - [x] 3.3 Thêm các mutation hooks duyệt/bỏ duyệt vào `useMeterReadings.ts`
    - Tạo `useApproveMeterReading()` gọi RPC `approve_meter_reading(id)` cập nhật status=APPROVED, approved_by, approved_at
    - Tạo `useBulkApproveMeterReadings()` gọi RPC `bulk_approve_meter_readings(ids[])`
    - Tạo `useUnapproveMeterReading()` cập nhật status=UNAPPROVED, xoá approved_by và approved_at
    - _Yêu cầu: 8.1, 8.2, 8.3, 8.4_

  - [x] 3.4 Viết property test cho bản ghi mới luôn có trạng thái UNAPPROVED
    - **Property 11: Bản ghi mới luôn có trạng thái UNAPPROVED**
    - **Validates: Yêu cầu 5.4**

  - [x] 3.5 Viết property test cho quyền sửa/xoá phụ thuộc trạng thái duyệt
    - **Property 12: Quyền sửa/xoá phụ thuộc trạng thái duyệt**
    - **Validates: Yêu cầu 7.1, 7.2, 7.3**

  - [x] 3.6 Viết property test cho duyệt rồi bỏ duyệt là round-trip
    - **Property 13: Duyệt rồi bỏ duyệt là round-trip**
    - **Validates: Yêu cầu 8.2, 8.3, 8.4**

  - [x] 3.7 Viết property test cho xoá hàng loạt chỉ xoá bản ghi chưa duyệt
    - **Property 14: Xoá hàng loạt chỉ xoá bản ghi chưa duyệt**
    - **Validates: Yêu cầu 7.4**

- [x] 4. Checkpoint - Đảm bảo hooks và validation hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 5. Triển khai module Quản lý Công tơ (Meters)
  - [x] 5.1 Tạo component `src/components/meters/MeterList.tsx`
    - Hiển thị bảng công tơ nhóm theo phòng, mỗi nhóm hiển thị tên phòng + tòa nhà
    - Mỗi công tơ hiển thị: Mã, Tên, Loại, Trạng thái, Chỉ số gần nhất
    - Nút Sửa và Xoá cho mỗi công tơ
    - Sử dụng shadcn/ui Table, Badge, Button
    - _Yêu cầu: 1.1, 1.2, 1.3_

  - [x] 5.2 Tạo component `src/components/meters/MeterForm.tsx`
    - Dialog form thêm/sửa công tơ với các trường: Tòa nhà (*), Phòng (*), Loại CT (*), Mã CT (*), chỉ số ban đầu, ngày lắp đặt, ghi chú vị trí, nhà sản xuất, model, số serial, ghi chú
    - Sử dụng `meterFormSchema` từ Zod validation đã tạo ở task 1.1
    - Hiển thị lỗi validation inline cho từng trường bắt buộc
    - Xử lý lỗi mã công tơ trùng (error code 23505)
    - Hỗ trợ cả mode thêm mới (meter=null) và sửa (meter có giá trị, điền sẵn form)
    - _Yêu cầu: 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2_

  - [x] 5.3 Tạo trang `src/pages/settings/MetersPage.tsx` và đăng ký route
    - Trang chính Quản lý Công tơ tại route /settings/meters
    - Bộ lọc theo Tòa nhà và Loại công tơ
    - Nút (+) mở MeterForm để thêm công tơ mới
    - Hộp thoại xác nhận xoá với nội dung "Bạn đang thực hiện thao tác xoá công tơ. Bạn có chắc chắn muốn xoá không?"
    - Kết nối MeterList + MeterForm + useMetersGroupedByRoom + useCreateMeter + useUpdateMeter + useDeleteMeter
    - Đăng ký route trong App.tsx
    - _Yêu cầu: 1.1, 1.4, 1.5, 2.3, 4.1, 4.2, 4.3, 4.4_

  - [x] 5.4 Viết property test cho tên công tơ tự sinh đúng định dạng
    - **Property 4: Tên công tơ tự sinh đúng định dạng**
    - **Validates: Yêu cầu 2.4**

  - [x] 5.5 Viết property test cho cập nhật công tơ round-trip
    - **Property 6: Cập nhật công tơ round-trip**
    - **Validates: Yêu cầu 3.1, 3.2, 3.3**

- [x] 6. Triển khai components Ghi chỉ số - Phần hiển thị
  - [x] 6.1 Tạo component `src/components/meter-readings/MeterReadingStats.tsx`
    - Hiển thị 5 thẻ thống kê: Công tơ chưa chốt, Chỉ số đã duyệt (xanh), Chỉ số chưa duyệt (vàng), Tổng tiêu thụ điện (kWh), Tổng tiêu thụ nước (m³)
    - Sử dụng `useMeterReadingStats` hook, cập nhật khi thay đổi bộ lọc
    - Sử dụng shadcn/ui Card + Lucide icons (Gauge, CheckCircle, Clock, Zap, Droplet)
    - _Yêu cầu: 10.1, 10.2, 10.3_

  - [x] 6.2 Tạo component `src/components/meter-readings/MeterReadingFilters.tsx`
    - Bộ lọc: Tòa nhà, Phòng, Loại công tơ, Tháng chốt (month picker), Trạng thái duyệt
    - Sử dụng shadcn/ui Select, Input (type=month)
    - Gọi onChange callback khi bất kỳ filter nào thay đổi
    - _Yêu cầu: 9.2_

  - [x] 6.3 Tạo component `src/components/meter-readings/MeterReadingList.tsx`
    - Bảng danh sách chỉ số với các cột: Checkbox, Mã (reading_code + badge trạng thái), Thao tác, Công tơ, Chỉ số đầu, Chỉ số cuối, Số tiêu thụ, Ngày chốt, Người chốt
    - Badge trạng thái: xanh = Đã duyệt, vàng = Chưa duyệt
    - Cột Thao tác: Duyệt/Bỏ duyệt, Cập nhật, Xoá - disable Cập nhật và Xoá khi APPROVED
    - Hỗ trợ chọn nhiều dòng bằng checkbox
    - Phân trang sử dụng `usePagination` hook hiện có
    - _Yêu cầu: 9.1, 9.3, 9.4, 9.5, 7.1, 7.2_

  - [x] 6.4 Tạo component `src/components/meter-readings/MeterReadingActions.tsx`
    - Thanh thao tác hàng loạt hiển thị khi có checkbox được chọn
    - Nút: Duyệt (N), Xoá (N), Bỏ chọn
    - Xoá hàng loạt chỉ áp dụng cho chỉ số UNAPPROVED
    - _Yêu cầu: 7.4, 8.3, 9.4_

  - [x] 6.5 Viết property test cho bộ lọc chỉ số trả về kết quả phù hợp
    - **Property 15: Bộ lọc chỉ số trả về kết quả phù hợp**
    - **Validates: Yêu cầu 9.2**

  - [x] 6.6 Viết property test cho phân trang đúng
    - **Property 16: Phân trang đúng**
    - **Validates: Yêu cầu 9.3**

  - [x] 6.7 Viết property test cho thống kê đúng
    - **Property 17: Thống kê đúng**
    - **Validates: Yêu cầu 10.1, 10.2**

- [x] 7. Checkpoint - Đảm bảo module Công tơ và hiển thị Ghi chỉ số hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 8. Triển khai Form ghi chỉ số và Import Excel
  - [x] 8.1 Tạo component `src/components/meter-readings/MeterReadingForm.tsx`
    - Dialog form ghi chỉ số từng phòng
    - Bước 1: Chọn Tòa nhà (*), Phòng (*), Loại CT, Tháng chốt (*), Ngày chốt (*)
    - Bước 2: Hiển thị bảng công tơ tương ứng với cột: Tên công tơ, Chỉ số đầu (auto), Chỉ số mới (input), Ngày chốt, Hình ảnh
    - Chỉ số đầu tự động lấy từ lần ghi gần nhất hoặc initial_reading
    - Validation: chỉ số mới >= chỉ số đầu (sử dụng `validateReadingValue`)
    - Upload hình ảnh công tơ (optional) sử dụng `src/lib/storage.ts`
    - Hỗ trợ cả mode thêm mới và sửa chỉ số
    - _Yêu cầu: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 12.1, 12.2_

  - [x] 8.2 Tạo component `src/components/meter-readings/MeterReadingImportDialog.tsx`
    - Dialog nhập hàng loạt từ Excel
    - Nút "Tải file mẫu tại đây" → download template Excel (sử dụng `src/lib/excelHelpers.ts`)
    - Khu vực kéo thả / chọn file để upload
    - Preview dữ liệu file đã tải lên trong bảng
    - Nút "Nhập dữ liệu" → validate từng dòng bằng `excelImportRowSchema` → gọi RPC `bulk_create_meter_readings`
    - Hiển thị kết quả: số bản ghi thành công, số bản ghi lỗi, chi tiết lỗi từng dòng
    - _Yêu cầu: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 8.3 Viết property test cho chỉ số đầu tự động điền đúng
    - **Property 7: Chỉ số đầu tự động điền đúng**
    - **Validates: Yêu cầu 5.3**

  - [x] 8.4 Viết property test cho mã chỉ số đúng định dạng
    - **Property 9: Mã chỉ số đúng định dạng CSS{YYMM}{sequence}**
    - **Validates: Yêu cầu 5.6**

  - [x] 8.5 Viết property test cho import Excel - tổng bản ghi đúng
    - **Property 20: Import Excel - số bản ghi tạo + số lỗi = tổng dòng**
    - **Validates: Yêu cầu 6.4, 6.6**

- [x] 9. Tích hợp trang MeterReadingsPage và kết nối toàn bộ
  - [x] 9.1 Tái triển khai `src/pages/meter-readings/MeterReadingsPage.tsx`
    - Layout: Header (tiêu đề + nút (+) Thêm chỉ số + nút Import) → MeterReadingStats → MeterReadingFilters → MeterReadingActions → MeterReadingList
    - Quản lý state: filters, selectedIds, isFormOpen, isImportOpen, editingReading
    - Kết nối tất cả components đã tạo với hooks useMeterReadingsList, useMeterReadingStats
    - Xử lý duyệt đơn lẻ, duyệt hàng loạt, bỏ duyệt qua MeterReadingList + MeterReadingActions
    - Xử lý sửa/xoá đơn lẻ và xoá hàng loạt
    - _Yêu cầu: 5.1, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 9.2 Tích hợp chỉ số với hóa đơn
    - Trong module hóa đơn, khi chọn dịch vụ điện/nước, cho phép chọn Chỉ_số đã duyệt (APPROVED) tương ứng với Phòng và Tháng chốt
    - Tự động tính thành tiền = Số tiêu thụ × Đơn giá dịch vụ
    - Hiển thị nút "Chốt công tơ" nếu chưa có chỉ số đã duyệt cho phòng/tháng
    - _Yêu cầu: 11.1, 11.2, 11.3_

  - [x] 9.3 Viết property test cho chỉ chỉ số đã duyệt mới được chọn cho hóa đơn
    - **Property 18: Chỉ chỉ số đã duyệt mới được chọn cho hóa đơn**
    - **Validates: Yêu cầu 11.1**

  - [x] 9.4 Viết property test cho tính tiền hóa đơn
    - **Property 19: Tính tiền hóa đơn = Số tiêu thụ × Đơn giá**
    - **Validates: Yêu cầu 11.2**

  - [x] 9.5 Viết property test cho upload hình ảnh round-trip
    - **Property 21: Upload hình ảnh round-trip**
    - **Validates: Yêu cầu 12.2**

- [x] 10. Checkpoint cuối - Đảm bảo toàn bộ tính năng hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo truy vết
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra tính đúng đắn phổ quát, unit tests kiểm tra ví dụ cụ thể và edge cases
- Database schema đã có sẵn, không cần migration mới
- Sử dụng fast-check cho property-based tests (`npm install -D fast-check`)
