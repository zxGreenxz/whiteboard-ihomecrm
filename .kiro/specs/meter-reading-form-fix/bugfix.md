# Bugfix Requirements Document

## Introduction

Công tơ đã tạo thành công trong trang Cài đặt > Đồng hồ Công tơ nhưng không hiển thị trong form "Thêm chỉ số" (Tài chính > Ghi chỉ số). Nguyên nhân gốc gồm 3 lỗi: (1) field mapping sai giữa RPC response và form component, (2) form bắt buộc chọn Phòng trước khi load công tơ trong khi tài liệu gốc không yêu cầu, và (3) danh sách công tơ không tự động load khi thay đổi filter mà phải bấm nút "Tải công tơ" thủ công.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN RPC `get_meters_without_readings` trả về dữ liệu với cột `meter_id`, `meter_code`, `meter_name`, `last_reading` THEN form dùng `meter.id` để map vào `meter_id` field (dòng `meter_id: meter.id`), khiến `meter_id` luôn là `undefined`

1.2 WHEN hàm `getPreviousReading` và `getMeterName` tìm meter bằng `metersList.find((m: any) => m.id === meterId)` THEN không tìm thấy meter nào vì RPC trả về `meter_id` chứ không phải `id`, dẫn đến chỉ số đầu luôn = 0 và tên công tơ hiển thị rỗng

1.3 WHEN hàm `getMeterName` truy cập `meter?.name || meter?.code` THEN không lấy được tên/mã vì RPC trả về `meter_name` và `meter_code` (không phải `name` và `code`)

1.4 WHEN hàm `getPreviousReading` truy cập `meter.latest_reading ?? meter.initial_reading` THEN không lấy được chỉ số trước đó vì RPC trả về `last_reading` (không phải `latest_reading` hay `initial_reading`)

1.5 WHEN người dùng chọn Tòa nhà và Tháng chốt nhưng chưa chọn Phòng THEN nút "Tải công tơ" bị disabled do điều kiện `!watchRoomId`, không thể load danh sách công tơ chưa chốt của toàn bộ tòa nhà

1.6 WHEN người dùng thay đổi bộ lọc (Tòa nhà, Phòng, Loại công tơ, Tháng chốt) THEN danh sách công tơ chưa chốt không tự động hiển thị, phải bấm nút "Tải công tơ" thủ công — sai so với flow trong tài liệu gốc và app.resident.vn

### Expected Behavior (Correct)

2.1 WHEN RPC `get_meters_without_readings` trả về dữ liệu THEN form SHALL dùng `meter.meter_id` để map vào field `meter_id` khi tạo readings data

2.2 WHEN hàm `getPreviousReading` và `getMeterName` tìm meter trong metersList THEN hệ thống SHALL tìm bằng `m.meter_id === meterId` thay vì `m.id === meterId`

2.3 WHEN hàm `getMeterName` hiển thị tên công tơ THEN hệ thống SHALL truy cập `meter?.meter_name || meter?.meter_code` thay vì `meter?.name || meter?.code`

2.4 WHEN hàm `getPreviousReading` lấy chỉ số trước đó THEN hệ thống SHALL truy cập `meter.last_reading` thay vì `meter.latest_reading ?? meter.initial_reading`

2.5 WHEN người dùng đã chọn Tòa nhà và Tháng chốt (chưa chọn Phòng) THEN hệ thống SHALL cho phép load/hiển thị tất cả công tơ chưa chốt của tòa nhà đó — Phòng là filter tùy chọn, không bắt buộc

2.6 WHEN người dùng thay đổi bất kỳ filter nào (Tòa nhà, Phòng, Loại công tơ, Tháng chốt) và đã có đủ điều kiện tối thiểu (Tòa nhà + Tháng chốt) THEN hệ thống SHALL tự động load và hiển thị danh sách công tơ chưa chốt tương ứng, không cần bấm nút thủ công

### Unchanged Behavior (Regression Prevention)

3.1 WHEN người dùng đang ở chế độ sửa (editing) một chỉ số đã có THEN hệ thống SHALL CONTINUE TO hiển thị đúng thông tin chỉ số cũ và cho phép cập nhật bình thường

3.2 WHEN người dùng nhập chỉ số mới và bấm Lưu THEN hệ thống SHALL CONTINUE TO validate chỉ số mới >= chỉ số đầu và tạo/cập nhật meter_readings đúng

3.3 WHEN người dùng upload hình ảnh công tơ THEN hệ thống SHALL CONTINUE TO upload file lên storage và lưu URL vào meter_image_url

3.4 WHEN không có công tơ chưa chốt cho filter đã chọn THEN hệ thống SHALL CONTINUE TO hiển thị thông báo "Không có công tơ chưa chốt" và không cho phép lưu

3.5 WHEN RPC `get_meters_without_readings` được gọi với `p_room_id = NULL` THEN hệ thống SHALL CONTINUE TO trả về tất cả công tơ chưa chốt của building (hành vi RPC hiện tại đã đúng)

3.6 WHEN người dùng chọn cả Phòng cụ thể THEN hệ thống SHALL CONTINUE TO chỉ hiển thị công tơ chưa chốt của phòng đó (filter hoạt động đúng)
