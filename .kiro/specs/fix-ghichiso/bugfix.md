# Tài liệu Yêu cầu Sửa lỗi

## Giới thiệu

Người dùng đã tạo đồng hồ công tơ (CTĐ 01, Điện, cho phòng 111 — 162/11 NVK) trong trang Quản lý Công tơ (Settings > Đồng hồ Công tơ). Tuy nhiên khi mở form "Thêm chỉ số" tại trang Ghi chỉ số (Tài chính > Ghi chỉ số), chọn tòa nhà nhưng công tơ không hiển thị. Nguyên nhân gốc gồm 3 lỗi:

1. **Lỗi mapping dữ liệu từ RPC**: Code trong `MeterReadingForm.tsx` sử dụng sai tên trường so với kết quả trả về từ RPC `get_meters_without_readings` (dùng `meter.id` thay vì `meter.meter_id`, `meter.name` thay vì `meter.meter_name`, v.v.)
2. **Lỗi logic bộ lọc**: Nút "Tải công tơ" yêu cầu chọn cả Tòa nhà lẫn Phòng (`!watchBuildingId || !watchRoomId`), trong khi theo tài liệu chỉ cần chọn Tòa nhà là đủ.
3. **Lỗi UX không đúng tài liệu**: Theo tài liệu, khi chọn Tòa nhà + Tháng chốt, hệ thống tự động hiển thị bảng "Công tơ chưa chốt trong tháng". Hiện tại phải bấm nút "Tải công tơ" riêng.

## Phân tích Bug

### Hành vi hiện tại (Lỗi)

1.1 KHI RPC `get_meters_without_readings` trả về danh sách công tơ với các trường `meter_id`, `meter_code`, `meter_name`, `last_reading` THÌ hệ thống truy cập sai tên trường (`meter.id`, `meter.name`, `meter.code`, `meter.latest_reading`, `meter.initial_reading`) dẫn đến tất cả giá trị đều là `undefined`

1.2 KHI người dùng đã chọn Tòa nhà và Tháng chốt nhưng chưa chọn Phòng THÌ nút "Tải công tơ" bị disabled do điều kiện `!watchBuildingId || !watchRoomId` yêu cầu cả hai trường

1.3 KHI người dùng thay đổi bộ lọc (Tòa nhà, Phòng, Loại công tơ, Tháng chốt) THÌ hệ thống không tự động hiển thị danh sách công tơ chưa chốt mà yêu cầu bấm nút "Tải công tơ" riêng

1.4 KHI danh sách công tơ được load vào bảng THÌ cột "Tên công tơ" hiển thị trống và cột "Chỉ số đầu" hiển thị 0.00 do truy cập sai trường `meter.name`/`meter.code` và `meter.latest_reading`/`meter.initial_reading`

1.5 KHI thống kê "Công tơ chưa chốt" hiển thị trên trang Ghi chỉ số THÌ giá trị hiển thị là 0 mặc dù có công tơ chưa chốt trong hệ thống (do card "Công tơ chưa chốt" đang dùng `stats?.total_readings` thay vì trường đúng cho số lượng công tơ chưa chốt)

### Hành vi mong đợi (Đúng)

2.1 KHI RPC `get_meters_without_readings` trả về danh sách công tơ THÌ hệ thống PHẢI truy cập đúng tên trường: `meter.meter_id` cho ID, `meter.meter_name || meter.meter_code` cho tên hiển thị, `meter.last_reading` cho chỉ số đầu

2.2 KHI người dùng đã chọn Tòa nhà và Tháng chốt (Phòng là optional) THÌ hệ thống PHẢI cho phép load danh sách công tơ chưa chốt mà không yêu cầu chọn Phòng

2.3 KHI người dùng thay đổi bộ lọc (Tòa nhà, Phòng, Loại công tơ, Tháng chốt) THÌ hệ thống PHẢI tự động hiển thị bảng "Công tơ chưa chốt trong tháng" mà không cần bấm nút riêng

2.4 KHI danh sách công tơ hiển thị trong bảng THÌ cột "Tên công tơ" PHẢI hiển thị đúng tên (`meter_name` hoặc `meter_code`) và cột "Chỉ số đầu" PHẢI hiển thị đúng giá trị `last_reading`

2.5 KHI lưu chỉ số thành công THÌ hệ thống PHẢI hiển thị toast message "Dữ liệu đã được TẠO thành công"

2.6 KHI thống kê "Công tơ chưa chốt" hiển thị trên trang Ghi chỉ số THÌ giá trị PHẢI phản ánh đúng số lượng công tơ chưa chốt trong tháng đã chọn

### Hành vi không thay đổi (Phòng chống Regression)

3.1 KHI người dùng chỉnh sửa chỉ số đã tồn tại (mode editing) THÌ hệ thống PHẢI TIẾP TỤC hiển thị đúng thông tin công tơ và cho phép cập nhật chỉ số

3.2 KHI người dùng upload hình ảnh công tơ THÌ hệ thống PHẢI TIẾP TỤC upload thành công và hiển thị preview hình ảnh

3.3 KHI người dùng nhập chỉ số mới nhỏ hơn chỉ số đầu THÌ hệ thống PHẢI TIẾP TỤC hiển thị lỗi validation

3.4 KHI người dùng lưu nhiều chỉ số cùng lúc (bulk create) THÌ hệ thống PHẢI TIẾP TỤC tạo tất cả các bản ghi meter_reading thành công

3.5 KHI người dùng chọn lọc theo Loại công tơ (Điện/Nước/Gas) THÌ hệ thống PHẢI TIẾP TỤC lọc đúng danh sách công tơ theo loại đã chọn

3.6 KHI trang Ghi chỉ số hiển thị danh sách chỉ số đã ghi (MeterReadingList) THÌ hệ thống PHẢI TIẾP TỤC hiển thị đúng dữ liệu với phân trang, lọc, và các thao tác duyệt/xoá


---

## Suy luận Bug Condition

### Bug Condition Function

```pascal
FUNCTION isBugCondition_Mapping(X)
  INPUT: X of type MeterFromRPC
  OUTPUT: boolean
  
  // Bug xảy ra khi code truy cập trường sai tên từ kết quả RPC
  // RPC trả về: meter_id, meter_code, meter_name, last_reading
  // Code truy cập: id, name, code, latest_reading, initial_reading
  RETURN X has fields {meter_id, meter_code, meter_name, last_reading}
    AND code accesses {X.id, X.name, X.code, X.latest_reading}
END FUNCTION

FUNCTION isBugCondition_Filter(X)
  INPUT: X of type FormState
  OUTPUT: boolean
  
  // Bug xảy ra khi có Tòa nhà nhưng không có Phòng
  RETURN X.building_id IS NOT NULL 
    AND X.room_id IS NULL
    AND X.month IS NOT NULL
END FUNCTION

FUNCTION isBugCondition_AutoLoad(X)
  INPUT: X of type FilterChangeEvent
  OUTPUT: boolean
  
  // Bug xảy ra khi bộ lọc thay đổi nhưng bảng không tự cập nhật
  RETURN X.building_id IS NOT NULL
    AND X.month IS NOT NULL
    AND user has NOT clicked "Tải công tơ" button
END FUNCTION
```

### Property Specification

```pascal
// Property: Fix Checking - Mapping dữ liệu RPC
FOR ALL X WHERE isBugCondition_Mapping(X) DO
  result ← getMeterName'(X)
  previousReading ← getPreviousReading'(X)
  ASSERT result = (X.meter_name OR X.meter_code)
  ASSERT previousReading = X.last_reading
END FOR

// Property: Fix Checking - Bộ lọc không yêu cầu Phòng
FOR ALL X WHERE isBugCondition_Filter(X) DO
  result ← canLoadMeters'(X)
  ASSERT result = true
END FOR

// Property: Fix Checking - Tự động load công tơ
FOR ALL X WHERE isBugCondition_AutoLoad(X) DO
  result ← metersTableVisible'(X)
  ASSERT result = true AND metersData is loaded automatically
END FOR
```

### Preservation Goal

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_Mapping(X) 
  AND NOT isBugCondition_Filter(X)
  AND NOT isBugCondition_AutoLoad(X) DO
  ASSERT F(X) = F'(X)
  // Editing mode, image upload, validation, bulk create, 
  // filter by meter type, reading list đều hoạt động như cũ
END FOR
```
