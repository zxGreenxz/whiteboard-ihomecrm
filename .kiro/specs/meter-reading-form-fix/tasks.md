# Implementation Plan

- [x] 1. Viết exploration test cho bug condition (field mapping + room filter)
  - **Property 1: Fault Condition** - Field Mapping Sai Với RPC Response & Room Filter Bắt Buộc
  - **CRITICAL**: Test này PHẢI FAIL trên code chưa fix — failure xác nhận bug tồn tại
  - **DO NOT** cố fix test hoặc code khi test fail
  - **NOTE**: Test encode expected behavior — sẽ validate fix khi pass sau implementation
  - **GOAL**: Surface counterexamples chứng minh bug tồn tại
  - **Scoped PBT Approach**: Extract pure functions từ `MeterReadingForm.tsx` và test trực tiếp
  - Extract hàm `mapMeterToReading(meter)` từ logic trong `handleLoadMeters` — test với mock RPC data `{ meter_id, meter_name, meter_code, last_reading }`
  - Extract hàm `getPreviousReadingFromList(meterId, metersList)` — test tìm meter bằng `meter_id` và trả về `last_reading`
  - Extract hàm `getMeterNameFromList(meterId, metersList)` — test tìm meter bằng `meter_id` và trả về `meter_name || meter_code`
  - Extract hàm `isLoadEnabled(filters)` — test với `{ buildingId: "b1", month: "2025-01", roomId: "" }` phải trả về `true`
  - Dùng `fast-check` generate random RPC response arrays và verify:
    - `mapMeterToReading(meter).meter_id === meter.meter_id` (không phải `undefined`)
    - `getPreviousReadingFromList(id, list)` trả về `last_reading` (không phải 0 khi meter tồn tại)
    - `getMeterNameFromList(id, list)` trả về `meter_name || meter_code` (không phải empty string khi meter tồn tại)
    - `isLoadEnabled({ buildingId: "x", month: "y", roomId: "" })` trả về `true`
  - Chạy test trên code CHƯA FIX
  - **EXPECTED OUTCOME**: Test FAIL (xác nhận bug tồn tại)
  - Document counterexamples tìm được (e.g., `mapMeterToReading({ meter_id: "abc" }).meter_id === undefined`)
  - Đánh dấu task complete khi test đã viết, chạy, và failure đã document
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Viết preservation property tests (TRƯỚC KHI fix)
  - **Property 2: Preservation** - Chế Độ Editing & Room Filter Không Bị Ảnh Hưởng
  - **IMPORTANT**: Tuân theo observation-first methodology
  - Observe hành vi trên code CHƯA FIX cho non-buggy inputs:
    - `getPreviousReadingFromList` khi `isEditing=true` và `reading` có giá trị → trả về `reading.previous_reading`
    - `getMeterNameFromList` khi `isEditing=true` và `reading` có giá trị → trả về `reading.meter_name || reading.meter_code`
    - `isLoadEnabled` khi có cả `buildingId`, `roomId`, `month` → trả về `true`
  - Viết property-based tests với `fast-check`:
    - For all editing reading data, `getPreviousReadingFromList` trả về `reading.previous_reading ?? 0`
    - For all editing reading data, `getMeterNameFromList` trả về `reading.meter_name || reading.meter_code || ""`
    - For all filter combos có đủ `buildingId` + `roomId` + `month`, `isLoadEnabled` trả về `true`
    - For all filter combos thiếu `buildingId` hoặc `month`, `isLoadEnabled` trả về `false`
  - Chạy tests trên code CHƯA FIX
  - **EXPECTED OUTCOME**: Tests PASS (xác nhận baseline behavior cần preserve)
  - Đánh dấu task complete khi tests đã viết, chạy, và passing trên code chưa fix
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix MeterReadingForm.tsx

  - [x] 3.1 Extract pure functions ra file riêng để test được
    - Tạo `src/components/meter-readings/meterReadingFormUtils.ts`
    - Extract `mapMeterToReading(meter)`: map RPC response meter thành reading data
    - Extract `getPreviousReadingFromList(meterId, metersList)`: tìm meter và trả về last_reading
    - Extract `getMeterNameFromList(meterId, metersList)`: tìm meter và trả về tên hiển thị
    - Extract `isLoadEnabled(filters)`: check điều kiện tối thiểu để load meters
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.2 Fix field mapping trong extracted functions
    - `mapMeterToReading`: dùng `meter.meter_id` thay vì `meter.id`
    - `getPreviousReadingFromList`: tìm bằng `m.meter_id === meterId`, trả về `meter.last_reading ?? 0`
    - `getMeterNameFromList`: tìm bằng `m.meter_id === meterId`, trả về `meter?.meter_name || meter?.meter_code || ""`
    - `isLoadEnabled`: chỉ cần `buildingId` + `month`, bỏ yêu cầu `roomId`
    - _Bug_Condition: isBugCondition(input) where formAccessesField("id", "name", "code", "latest_reading") thay vì ("meter_id", "meter_name", "meter_code", "last_reading")_
    - _Expected_Behavior: mapMeterToReading(meter).meter_id === meter.meter_id, getPreviousReadingFromList trả về meter.last_reading, getMeterNameFromList trả về meter.meter_name || meter.meter_code_
    - _Preservation: Chế độ editing không bị ảnh hưởng vì editing dùng reading prop trực tiếp_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.3 Cập nhật MeterReadingForm.tsx sử dụng extracted functions và thêm auto-load
    - Import và sử dụng các extracted functions thay vì inline logic
    - Đổi label "Phòng *" thành "Phòng"
    - Thêm `useEffect` watch `metersList` — khi có data và không phải editing, tự động gọi logic load
    - Xóa nút "Tải công tơ" thủ công
    - Bỏ `!watchRoomId` khỏi disabled condition (nếu còn button nào)
    - _Bug_Condition: roomRequiredBug AND autoLoadBug from design_
    - _Expected_Behavior: auto-load khi buildingId + month có giá trị, Phòng là tùy chọn_
    - _Preservation: Editing mode, validation, image upload không thay đổi_
    - _Requirements: 2.5, 2.6_

  - [x] 3.4 Verify exploration test (Property 1) now passes
    - **Property 1: Expected Behavior** - Field Mapping Đúng Với RPC Response
    - **IMPORTANT**: Chạy lại CÙNG test từ task 1 — KHÔNG viết test mới
    - Test từ task 1 encode expected behavior
    - Khi test pass, xác nhận expected behavior đã được thỏa mãn
    - Chạy exploration test từ bước 1
    - **EXPECTED OUTCOME**: Test PASS (xác nhận bug đã fix)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Chế Độ Editing & Room Filter Không Bị Ảnh Hưởng
    - **IMPORTANT**: Chạy lại CÙNG tests từ task 2 — KHÔNG viết tests mới
    - Chạy preservation property tests từ bước 2
    - **EXPECTED OUTCOME**: Tests PASS (xác nhận không có regression)
    - Confirm tất cả tests vẫn pass sau fix
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Đảm bảo tất cả tests pass
  - Chạy toàn bộ test suite liên quan
  - Đảm bảo tất cả tests pass, hỏi user nếu có vấn đề
