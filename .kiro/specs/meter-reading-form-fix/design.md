# Meter Reading Form Bugfix Design

## Overview

Form "Thêm chỉ số" (`MeterReadingForm.tsx`) không hiển thị công tơ do 3 nhóm lỗi: (1) field mapping sai giữa RPC response và form component, (2) form bắt buộc chọn Phòng trước khi load công tơ, và (3) danh sách công tơ không tự động load khi thay đổi filter. Tất cả lỗi nằm trong file `MeterReadingForm.tsx` — hook `useUnrecordedMeters` và RPC `get_meters_without_readings` hoạt động đúng.

## Glossary

- **Bug_Condition (C)**: Điều kiện gây lỗi — khi form truy cập sai field name từ RPC response (`meter.id` thay vì `meter.meter_id`, `meter.name` thay vì `meter.meter_name`, v.v.), hoặc khi form yêu cầu chọn Phòng bắt buộc, hoặc khi form không tự động load meters
- **Property (P)**: Hành vi mong muốn — form hiển thị đúng tên công tơ, chỉ số đầu, cho phép load không cần Phòng, và tự động load khi filter thay đổi
- **Preservation**: Hành vi hiện tại phải giữ nguyên — chế độ sửa, validation, upload hình ảnh, bulk create
- **`handleLoadMeters`**: Hàm trong `MeterReadingForm.tsx` map RPC response thành readings data cho form
- **`getPreviousReading`**: Hàm lấy chỉ số đầu (previous reading) từ metersList
- **`getMeterName`**: Hàm lấy tên hiển thị của công tơ từ metersList
- **`useUnrecordedMeters`**: Hook gọi RPC `get_meters_without_readings`, trả về mảng với các cột `meter_id`, `meter_code`, `meter_name`, `last_reading`, `room_name`, `meter_type_value`, `last_reading_date`

## Bug Details

### Fault Condition

Bug xảy ra khi form component truy cập các field name không khớp với RPC response schema. RPC `get_meters_without_readings` trả về `meter_id`, `meter_code`, `meter_name`, `last_reading` nhưng form dùng `id`, `name`, `code`, `latest_reading`, `initial_reading`. Ngoài ra, form yêu cầu `watchRoomId` trong disabled condition của nút "Tải công tơ" và không có useEffect để auto-load.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { action: string, metersList: Array, filters: { buildingId, roomId, month } }
  OUTPUT: boolean

  // Bug 1: Field mapping sai
  fieldMappingBug := input.action == "LOAD_METERS"
                     AND input.metersList.length > 0
                     AND input.metersList[0].meter_id != undefined
                     AND formAccessesField("id")  // form dùng meter.id thay vì meter.meter_id

  // Bug 2: Tìm meter sai field
  lookupBug := input.action IN ["GET_PREVIOUS_READING", "GET_METER_NAME"]
               AND input.metersList.length > 0
               AND formFindsBy("id")  // form tìm bằng m.id thay vì m.meter_id

  // Bug 3: Truy cập field name/code sai
  displayBug := input.action == "GET_METER_NAME"
                AND formAccessesField("name", "code")  // form dùng meter.name thay vì meter.meter_name

  // Bug 4: Truy cập previous reading sai
  readingBug := input.action == "GET_PREVIOUS_READING"
                AND formAccessesField("latest_reading", "initial_reading")  // form dùng sai field

  // Bug 5: Room bắt buộc
  roomRequiredBug := input.action == "CHECK_LOAD_ENABLED"
                     AND input.filters.buildingId != null
                     AND input.filters.month != null
                     AND input.filters.roomId == null
                     AND buttonIsDisabled()  // nút bị disabled vì thiếu roomId

  // Bug 6: Không auto-load
  autoLoadBug := input.action == "FILTER_CHANGED"
                 AND input.filters.buildingId != null
                 AND input.filters.month != null
                 AND NOT metersAutoLoaded()  // phải bấm nút thủ công

  RETURN fieldMappingBug OR lookupBug OR displayBug OR readingBug OR roomRequiredBug OR autoLoadBug
END FUNCTION
```

### Examples

- **Field mapping**: `handleLoadMeters` tạo `{ meter_id: meter.id }` → `meter.id` là `undefined` vì RPC trả về `meter_id` → readings data có `meter_id: undefined` → không thể lưu
- **Lookup sai**: `getPreviousReading("abc-123")` tìm `metersList.find(m => m.id === "abc-123")` → không tìm thấy vì meter có `meter_id: "abc-123"` chứ không có `id` → trả về 0
- **Tên hiển thị sai**: `getMeterName("abc-123")` truy cập `meter?.name` → `undefined` vì RPC trả về `meter_name` → hiển thị rỗng
- **Chỉ số đầu sai**: `getPreviousReading` truy cập `meter.latest_reading ?? meter.initial_reading` → cả hai đều `undefined` → trả về 0 thay vì giá trị `last_reading` thực
- **Room bắt buộc**: Chọn Tòa nhà A + Tháng 01/2025, chưa chọn Phòng → nút "Tải công tơ" disabled → không thể load công tơ toàn tòa nhà
- **Không auto-load**: Chọn Tòa nhà A + Tháng 01/2025 → không có gì xảy ra, phải bấm "Tải công tơ" → UX kém

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Chế độ sửa (editing) một chỉ số đã có phải tiếp tục hoạt động bình thường — hiển thị đúng thông tin cũ và cho phép cập nhật
- Validation chỉ số mới >= chỉ số đầu phải tiếp tục hoạt động
- Upload hình ảnh công tơ lên storage phải tiếp tục hoạt động
- Hiển thị "Không có công tơ chưa chốt" khi không có dữ liệu
- RPC `get_meters_without_readings` với `p_room_id = NULL` trả về tất cả công tơ của building (hành vi RPC đã đúng)
- Khi chọn Phòng cụ thể, chỉ hiển thị công tơ của phòng đó

**Scope:**
Tất cả input không liên quan đến field mapping, room filter condition, và auto-load logic không bị ảnh hưởng. Bao gồm:
- Chế độ editing (reading !== null)
- Form submission (onSubmit)
- Image upload flow
- Validation logic (validateReadings, validateReadingValue)

## Hypothesized Root Cause

Dựa trên phân tích code, các nguyên nhân gốc:

1. **Field Mapping Sai (Bug 1.1-1.4)**: Developer dùng field name từ `meters` table trực tiếp (`id`, `name`, `code`, `latest_reading`, `initial_reading`) thay vì field name từ RPC response (`meter_id`, `meter_name`, `meter_code`, `last_reading`). RPC `get_meters_without_readings` trả về schema khác với `meters` table.

   - `handleLoadMeters` dòng `meter_id: meter.id` → phải là `meter.meter_id`
   - `getPreviousReading` dòng `m.id === meterId` → phải là `m.meter_id === meterId`
   - `getPreviousReading` dòng `meter.latest_reading ?? meter.initial_reading` → phải là `meter.last_reading`
   - `getMeterName` dòng `m.id === meterId` → phải là `m.meter_id === meterId`
   - `getMeterName` dòng `meter?.name || meter?.code` → phải là `meter?.meter_name || meter?.meter_code`

2. **Room Filter Bắt Buộc (Bug 1.5)**: Disabled condition của nút "Tải công tơ" là `!watchBuildingId || !watchRoomId || !watchMonth` — có `!watchRoomId` khiến nút bị disabled khi chưa chọn Phòng. Theo thiết kế, Phòng là filter tùy chọn.

3. **Thiếu Auto-Load (Bug 1.6)**: Không có `useEffect` để tự động gọi `handleLoadMeters` khi `buildingId` + `month` thay đổi. Hiện tại phải bấm nút "Tải công tơ" thủ công.

## Correctness Properties

Property 1: Fault Condition - Field Mapping Đúng Với RPC Response

_For any_ input từ RPC `get_meters_without_readings` có `meter_id`, `meter_name`, `meter_code`, `last_reading`, hàm `handleLoadMeters` SHALL map đúng `meter.meter_id` vào field `meter_id`, hàm `getPreviousReading` SHALL trả về `meter.last_reading`, và hàm `getMeterName` SHALL trả về `meter.meter_name || meter.meter_code`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Fault Condition - Load Công Tơ Không Cần Phòng

_For any_ trạng thái form có `buildingId` không rỗng và `month` không rỗng nhưng `roomId` rỗng, hệ thống SHALL cho phép load và hiển thị danh sách công tơ chưa chốt.

**Validates: Requirements 2.5**

Property 3: Fault Condition - Auto-Load Khi Filter Thay Đổi

_For any_ thay đổi filter (buildingId, roomId, meterType, month) khi đã có đủ điều kiện tối thiểu (buildingId + month), hệ thống SHALL tự động load và hiển thị danh sách công tơ chưa chốt tương ứng.

**Validates: Requirements 2.6**

Property 4: Preservation - Chế Độ Editing Không Bị Ảnh Hưởng

_For any_ input ở chế độ editing (reading !== null), hệ thống SHALL tiếp tục hiển thị đúng thông tin chỉ số cũ, cho phép cập nhật, validate, và upload hình ảnh bình thường — không bị ảnh hưởng bởi các thay đổi fix.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

Property 5: Preservation - Room Filter Vẫn Hoạt Động Khi Được Chọn

_For any_ input có roomId được chọn cụ thể, hệ thống SHALL chỉ hiển thị công tơ chưa chốt của phòng đó — filter Phòng vẫn hoạt động đúng.

**Validates: Requirements 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/components/meter-readings/MeterReadingForm.tsx`

**Specific Changes**:

1. **Fix `handleLoadMeters` field mapping** (Bug 1.1):
   - Thay `meter_id: meter.id` → `meter_id: meter.meter_id`

2. **Fix `getPreviousReading` lookup và field access** (Bug 1.2, 1.4):
   - Thay `m.id === meterId` → `m.meter_id === meterId`
   - Thay `meter.latest_reading ?? meter.initial_reading ?? 0` → `meter.last_reading ?? 0`

3. **Fix `getMeterName` lookup và field access** (Bug 1.2, 1.3):
   - Thay `m.id === meterId` → `m.meter_id === meterId`
   - Thay `meter?.name || meter?.code` → `meter?.meter_name || meter?.meter_code`

4. **Bỏ yêu cầu Room bắt buộc** (Bug 1.5):
   - Xóa `!watchRoomId` khỏi disabled condition
   - Cũng cập nhật label Phòng từ "Phòng *" thành "Phòng" (không bắt buộc)

5. **Thêm auto-load bằng useEffect** (Bug 1.6):
   - Thêm `useEffect` watch `metersList` (từ `useUnrecordedMeters`) — khi `metersList` thay đổi và có data, tự động gọi logic tương tự `handleLoadMeters`
   - Xóa nút "Tải công tơ" thủ công
   - Khi `metersList` rỗng và đã có đủ filter, hiển thị thông báo "Không có công tơ chưa chốt"

## Testing Strategy

### Validation Approach

Testing strategy gồm 2 phase: (1) surface counterexamples trên code chưa fix để xác nhận root cause, (2) verify fix hoạt động đúng và preserve hành vi cũ.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples chứng minh bug trên code chưa fix. Xác nhận hoặc bác bỏ root cause analysis.

**Test Plan**: Viết unit tests extract các pure functions (`handleLoadMeters` logic, `getPreviousReading`, `getMeterName`) và test với mock RPC response data. Chạy trên code chưa fix để thấy failures.

**Test Cases**:
1. **Field Mapping Test**: Gọi handleLoadMeters logic với mock meter `{ meter_id: "abc", meter_name: "Điện P101" }` → assert `readings[0].meter_id === "abc"` (will fail on unfixed code vì dùng `meter.id`)
2. **Previous Reading Test**: Gọi getPreviousReading với mock meter `{ meter_id: "abc", last_reading: 150 }` → assert result === 150 (will fail vì dùng `m.id` và `meter.latest_reading`)
3. **Meter Name Test**: Gọi getMeterName với mock meter `{ meter_id: "abc", meter_name: "Điện P101", meter_code: "E001" }` → assert result === "Điện P101" (will fail vì dùng `m.id` và `meter.name`)
4. **Room Not Required Test**: Check disabled condition với `buildingId="b1"`, `month="2025-01"`, `roomId=""` → assert button NOT disabled (will fail vì có `!watchRoomId`)

**Expected Counterexamples**:
- `meter_id` trong readings data là `undefined` thay vì UUID thực
- `getPreviousReading` trả về 0 thay vì `last_reading` value
- `getMeterName` trả về empty string thay vì tên công tơ

### Fix Checking

**Goal**: Verify rằng với tất cả input thỏa bug condition, hàm đã fix trả về kết quả đúng.

**Pseudocode:**
```
FOR ALL meter IN rpcResponse WHERE meter.meter_id != undefined DO
  readingsData := handleLoadMeters_fixed(meter)
  ASSERT readingsData.meter_id == meter.meter_id

  previousReading := getPreviousReading_fixed(meter.meter_id, [meter])
  ASSERT previousReading == meter.last_reading

  meterName := getMeterName_fixed(meter.meter_id, [meter])
  ASSERT meterName == (meter.meter_name OR meter.meter_code)
END FOR

FOR ALL filters WHERE filters.buildingId != null AND filters.month != null DO
  ASSERT loadMetersEnabled(filters) == true  // regardless of roomId
END FOR
```

### Preservation Checking

**Goal**: Verify rằng với tất cả input KHÔNG thỏa bug condition, hàm đã fix cho kết quả giống hàm gốc.

**Pseudocode:**
```
FOR ALL input WHERE isEditing(input) DO
  ASSERT getPreviousReading_fixed(input) == getPreviousReading_original(input)
  ASSERT getMeterName_fixed(input) == getMeterName_original(input)
END FOR
```

**Testing Approach**: Property-based testing phù hợp cho preservation checking vì:
- Tự động generate nhiều test cases với random meter data
- Bắt edge cases mà manual tests có thể bỏ sót
- Đảm bảo mạnh rằng editing mode không bị ảnh hưởng

**Test Plan**: Observe hành vi editing mode trên code chưa fix, sau đó viết PBT tests capture hành vi đó.

**Test Cases**:
1. **Editing Mode Preservation**: Verify rằng khi `reading` prop có giá trị, `getPreviousReading` vẫn trả về `reading.previous_reading` — không bị ảnh hưởng bởi field mapping fix
2. **Editing Mode Name Preservation**: Verify rằng khi `reading` prop có giá trị, `getMeterName` vẫn trả về `reading.meter_name || reading.meter_code`
3. **Validation Preservation**: Verify rằng `validateReadings` vẫn hoạt động đúng với readings data mới
4. **Room Filter Preservation**: Verify rằng khi chọn Phòng cụ thể, chỉ công tơ của phòng đó được hiển thị

### Unit Tests

- Test `handleLoadMeters` logic map đúng `meter.meter_id` vào readings data
- Test `getPreviousReading` tìm đúng meter bằng `meter_id` và trả về `last_reading`
- Test `getMeterName` tìm đúng meter bằng `meter_id` và trả về `meter_name || meter_code`
- Test disabled condition không yêu cầu `roomId`
- Test auto-load trigger khi `buildingId` + `month` có giá trị

### Property-Based Tests

- Generate random arrays of RPC response meters và verify `handleLoadMeters` luôn map đúng `meter_id`
- Generate random meter arrays và verify `getPreviousReading` luôn trả về đúng `last_reading` cho meter tìm thấy, 0 cho meter không tìm thấy
- Generate random meter arrays và verify `getMeterName` luôn trả về đúng `meter_name || meter_code`
- Generate random filter combinations và verify load enabled khi có `buildingId` + `month`

### Integration Tests

- Test full flow: chọn Tòa nhà + Tháng → công tơ tự động load → nhập chỉ số → lưu thành công
- Test flow với Phòng: chọn Tòa nhà + Phòng + Tháng → chỉ công tơ của phòng đó hiển thị
- Test editing flow: mở chỉ số đã có → thông tin hiển thị đúng → cập nhật thành công
