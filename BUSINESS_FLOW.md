# CRM - Hướng Dẫn Nghiệp Vụ Toàn Diện

## Mục Lục

1. [Tổng Quan Hệ Thống](#1-tổng-quan-hệ-thống)
2. [Luồng Nghiệp Vụ Chính](#2-luồng-nghiệp-vụ-chính)
3. [Module Chi Tiết](#3-module-chi-tiết)
4. [Quy Trình Hàng Ngày](#4-quy-trình-hàng-ngày)
5. [Báo Cáo & Phân Tích](#5-báo-cáo--phân-tích)

---

## 1. Tổng Quan Hệ Thống

### 1.1. Giới Thiệu
**CRM** là hệ thống quản lý bất động sản cho thuê toàn diện, hỗ trợ quản lý:
- Cơ sở vật chất (Tòa nhà, Phòng, Giường)
- Khách hàng (Leads, Khách thuê)
- Hợp đồng cho thuê
- Tài chính (Hóa đơn, Thanh toán, Công nợ)
- Tài sản & Sự cố
- Báo cáo phân tích

### 1.2. Cấu Trúc Phân Cấp Bất Động Sản

```
Khu vực (Area)
    └── Tòa nhà (Building)
            └── Phòng (Room)
                    └── Giường (Bed) [Tùy chọn - cho KTX/Homestay]
```

### 1.3. Các Vai Trò Người Dùng
| Vai trò | Mô tả | Quyền hạn |
|---------|-------|-----------|
| Admin | Quản trị viên hệ thống | Toàn quyền |
| Manager | Quản lý tòa nhà | Quản lý tất cả nghiệp vụ |
| Staff | Nhân viên | Xử lý công việc hàng ngày |
| Accountant | Kế toán | Quản lý tài chính |

---

## 2. Luồng Nghiệp Vụ Chính

### 2.1. Luồng Tiếp Nhận Khách Hàng (Lead to Tenant)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   TIẾP NHẬN     │────▶│    ĐẶT CỌC      │────▶│   HỢP ĐỒNG      │
│   LEAD          │     │   DEPOSIT       │     │   CONTRACT      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                        │
         ▼                      ▼                        ▼
   - Nguồn lead           - Xác nhận phòng         - Tạo hợp đồng
   - Thông tin KH         - Thu tiền cọc           - Đăng ký dịch vụ
   - Chấm điểm lead       - Chuyển đổi             - Cập nhật trạng thái
   - Lên lịch hẹn         - Hoặc hoàn cọc          - Khách thuê chính thức
```

#### Bước 1: Tiếp Nhận Lead
**Đường dẫn:** `/leads`

1. **Tạo Lead mới:**
   - Điền thông tin khách hàng tiềm năng
   - Chọn nguồn lead (Facebook, Zalo, Website, Giới thiệu...)
   - Hệ thống tự động chấm điểm lead

2. **Quản lý Lead theo Kanban:**
   - `MỚI` → `ĐANG LIÊN HỆ` → `ĐÃ HẸN XEM` → `QUAN TÂM` → `ĐÃ ĐẶT CỌC`

3. **Theo dõi hoạt động:**
   - Ghi nhận cuộc gọi, tin nhắn
   - Lên lịch hẹn xem phòng
   - Ghi chú thông tin quan trọng

#### Bước 2: Đặt Cọc
**Đường dẫn:** `/deposits`

1. **Tạo phiếu đặt cọc:**
   - Liên kết với Lead
   - Chọn phòng/giường muốn cọc
   - Nhập số tiền cọc
   - Ngày dự kiến vào ở

2. **Trạng thái đặt cọc:**
   - `CHỜ XÁC NHẬN` → `ĐÃ XÁC NHẬN` → `ĐÃ CHUYỂN ĐỔI` hoặc `ĐÃ HOÀN TRẢ`

#### Bước 3: Tạo Hợp Đồng
**Đường dẫn:** `/contracts`

1. **Chuyển đổi từ đặt cọc:**
   - Click "Chuyển đổi thành hợp đồng" từ phiếu cọc
   - Hệ thống tự động điền thông tin

2. **Hoặc tạo hợp đồng mới:**
   - Chọn khách thuê (hoặc tạo mới)
   - Chọn phòng/giường
   - Thiết lập thời gian thuê
   - Đăng ký dịch vụ (điện, nước, internet...)
   - Nhập giá thuê và chu kỳ thanh toán

3. **Kích hoạt hợp đồng:**
   - Hệ thống tự động:
     - Cập nhật trạng thái phòng → `ĐÃ CHO THUÊ`
     - Tạo thông báo cho khách
     - Tạo hóa đơn đầu tiên (nếu cấu hình)

---

### 2.2. Luồng Quản Lý Tài Chính

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GHI CHỈ SỐ    │────▶│   TẠO HÓA ĐƠN   │────▶│   THU TIỀN      │
│   CÔNG TƠ       │     │   INVOICE       │     │   PAYMENT       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                        │
         ▼                      ▼                        ▼
   - Điện, Nước           - Tự động tính tiền       - Ghi nhận thanh toán
   - Theo kỳ              - Phí dịch vụ             - Cập nhật công nợ
   - Theo phòng           - Nợ cũ, phí phạt         - In biên lai
```

#### Bước 1: Ghi Chỉ Số Công Tơ
**Đường dẫn:** `/meter-readings`

1. **Ghi chỉ số hàng tháng:**
   - Chọn phòng
   - Nhập chỉ số điện mới
   - Nhập chỉ số nước mới
   - Hệ thống tự động tính số tiêu thụ

2. **Lưu ý:**
   - Ghi chỉ số TRƯỚC khi tạo hóa đơn
   - Có thể nhập hàng loạt theo tòa nhà

#### Bước 2: Tạo Hóa Đơn
**Đường dẫn:** `/invoices`

1. **Tạo hóa đơn tự động:**
   - Chọn kỳ thanh toán
   - Chọn tòa nhà hoặc tất cả
   - Hệ thống tự động tính:
     - Tiền thuê phòng
     - Tiền điện (chỉ số mới - cũ × đơn giá)
     - Tiền nước
     - Phí dịch vụ đã đăng ký
     - Nợ cũ (nếu có)
     - Phí phạt trễ hạn (nếu có)

2. **Duyệt hóa đơn:**
   - Kiểm tra chi tiết
   - Duyệt đơn lẻ hoặc hàng loạt
   - Gửi thông báo cho khách

3. **Trạng thái hóa đơn:**
   - `NHÁP` → `CHỜ THANH TOÁN` → `ĐÃ THANH TOÁN PHẦN` → `ĐÃ THANH TOÁN`
   - `QUÁ HẠN` (tự động khi quá hạn)

#### Bước 3: Thu Tiền
**Đường dẫn:** `/payments` hoặc từ chi tiết hóa đơn

1. **Ghi nhận thanh toán:**
   - Chọn hóa đơn
   - Nhập số tiền thu
   - Chọn phương thức (Tiền mặt, Chuyển khoản...)
   - Upload ảnh biên lai (nếu có)

2. **Hệ thống tự động:**
   - Cập nhật số tiền đã thanh toán
   - Cập nhật trạng thái hóa đơn
   - Ghi sổ quỹ
   - Gửi thông báo xác nhận

---

### 2.3. Luồng Quản Lý Hợp Đồng

```
                    ┌─────────────────┐
                    │   HỢP ĐỒNG      │
                    │   ĐANG HOẠT     │
                    │   ĐỘNG          │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  GIA HẠN     │     │  CHUYỂN      │     │  THANH LÝ    │
│  EXTEND      │     │  TRANSFER    │     │  TERMINATE   │
└──────────────┘     └──────────────┘     └──────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
   - Kéo dài thời gian  - Chuyển phòng      - Kết thúc sớm
   - Điều chỉnh giá     - Chuyển khách      - Tính phí phạt
   - Hợp đồng mới       - Giữ nguyên giá    - Hoàn tiền cọc
```

#### 2.3.1. Gia Hạn Hợp Đồng
**Điều kiện:** Hợp đồng đang `ACTIVE`

1. **Từ danh sách hợp đồng:** Chọn menu → "Gia hạn hợp đồng"
2. **Nhập thông tin:**
   - Ngày kết thúc mới
   - Giá thuê mới (nếu thay đổi)
3. **Xác nhận:** Hợp đồng được cập nhật

#### 2.3.2. Chuyển Phòng/Giường
**Điều kiện:** Hợp đồng đang `ACTIVE`, có phòng trống

1. **Chọn "Chuyển Phòng/Giường"**
2. **Chọn phòng/giường đích**
3. **Xác nhận:**
   - Phòng cũ → `TRỐNG`
   - Phòng mới → `ĐÃ CHO THUÊ`
   - Lịch sử được ghi nhận

#### 2.3.3. Chuyển Nhượng Hợp Đồng
**Điều kiện:** Hợp đồng đang `ACTIVE`

1. **Chọn "Nhượng hợp đồng"**
2. **Chọn khách thuê mới**
3. **Xác nhận:**
   - Khách cũ hết liên kết
   - Khách mới tiếp nhận hợp đồng

#### 2.3.4. Thanh Lý Hợp Đồng
**Trường hợp:** Khách muốn chuyển đi

1. **Đăng ký ngày chuyển đi:** (Tùy chọn)
   - Báo trước ngày dự kiến ra
   - Hợp đồng đánh dấu "Sắp chuyển đi"

2. **Thanh lý chính thức:**
   - Hệ thống tính toán:
     - Tiền thuê còn lại (tính theo ngày)
     - Tiền điện/nước chưa thanh toán
     - Phí phạt chuyển sớm (nếu có)
     - Phí dọn dẹp, sửa chữa
     - Tiền cọc được hoàn
   - Hiển thị số tiền cần thanh toán/hoàn trả
   - Xác nhận thanh lý

3. **Kết quả:**
   - Hợp đồng → `ĐÃ THANH LÝ`
   - Phòng → `TRỐNG`
   - Ghi sổ quỹ

---

### 2.4. Luồng Quản Lý Sự Cố

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   BÁO SỰ CỐ    │────▶│   XỬ LÝ         │────▶│   HOÀN TẤT      │
│   CREATE       │     │   PROCESS       │     │   RESOLVE       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                        │
         ▼                      ▼                        ▼
   - Mô tả vấn đề         - Phân công NV          - Đánh giá
   - Chọn mức độ          - Theo dõi tiến độ      - Đóng sự cố
   - Đính kèm ảnh         - Thêm bình luận        - Thống kê
```

**Đường dẫn:** `/issues`

1. **Tạo sự cố:**
   - Chọn phòng
   - Mô tả vấn đề
   - Chọn loại và mức độ ưu tiên
   - Đính kèm hình ảnh

2. **Xử lý:**
   - Phân công nhân viên
   - Cập nhật trạng thái
   - Thêm bình luận/ghi chú

3. **Hoàn tất:**
   - Đánh dấu đã giải quyết
   - Khách đánh giá (tùy chọn)

---

## 3. Module Chi Tiết

### 3.1. Quản Lý Cơ Sở Vật Chất

#### Khu Vực (Areas)
**Đường dẫn:** `/areas`
- Phân nhóm tòa nhà theo khu vực địa lý
- Thông tin: Tên, Địa chỉ, Mô tả

#### Tòa Nhà (Buildings)
**Đường dẫn:** `/buildings`
- Thông tin cơ bản: Tên, Địa chỉ, Mã số
- Liên kết với Khu vực
- Thống kê: Số phòng, Tỷ lệ lấp đầy

#### Phòng (Rooms)
**Đường dẫn:** `/rooms`
- Thông tin: Tên, Tầng, Diện tích, Loại phòng
- Giá thuê cơ bản
- Trạng thái: `TRỐNG`, `ĐÃ CHO THUÊ`, `BẢO TRÌ`
- Tiện ích: Điều hòa, Nóng lạnh, Ban công...

#### Giường (Beds)
**Đường dẫn:** `/beds`
- Dành cho phòng KTX/Homestay
- Liên kết với Phòng
- Quản lý riêng biệt từng giường

### 3.2. Quản Lý Dịch Vụ

**Đường dẫn:** `/services`

| Loại | Ví dụ | Cách tính |
|------|-------|-----------|
| Cố định | Internet, Phí quản lý | Số tiền cố định/tháng |
| Theo công tơ | Điện, Nước | Chỉ số × Đơn giá |
| Theo người | Rác thải | Số người × Đơn giá |

### 3.3. Quản Lý Tài Sản

**Đường dẫn:** `/assets`

1. **Danh mục tài sản:**
   - Điều hòa, Bình nóng lạnh, Tủ lạnh...
   - Theo dõi theo phòng

2. **Bàn giao tài sản:**
   - Khi khách nhận phòng
   - Khi khách trả phòng
   - Ghi nhận tình trạng

3. **Bảo trì:**
   - Lịch sử sửa chữa
   - Chi phí bảo trì

---

## 4. Quy Trình Hàng Ngày

### 4.1. Đầu Ngày
1. Kiểm tra Dashboard → Xem thông báo và cảnh báo
2. Xử lý leads mới
3. Theo dõi hợp đồng sắp hết hạn

### 4.2. Hàng Tháng
```
Ngày 1-5    : Ghi chỉ số điện nước
Ngày 5-10   : Tạo và duyệt hóa đơn
Ngày 10-15  : Gửi hóa đơn cho khách
Ngày 15-25  : Thu tiền, nhắc nợ
Ngày 25-30  : Báo cáo tổng hợp
```

### 4.3. Xử Lý Thanh Toán Trễ

1. **Ngày 16:** Hệ thống đánh dấu "Quá hạn"
2. **Ngày 20:** Gửi nhắc nhở lần 1
3. **Ngày 25:** Gửi nhắc nhở lần 2
4. **Tháng sau:** Tính phí phạt trễ hạn

---

## 5. Báo Cáo & Phân Tích

### 5.1. Báo Cáo Bất Động Sản
**Đường dẫn:** `/reports/real-estate`

| Báo cáo | Mục đích |
|---------|----------|
| Phòng trống | Danh sách phòng chưa có khách |
| Hợp đồng sắp hết hạn | Chuẩn bị gia hạn |
| Tỷ lệ lấp đầy | Đánh giá hiệu suất |
| Hợp đồng mới | Theo dõi tăng trưởng |
| Thanh lý | Phân tích lý do ra đi |
| Lịch sử giá | Theo dõi biến động giá |
| Thay đổi hợp đồng | Audit trail |
| Khuyến mại | Hiệu quả chương trình |

### 5.2. Báo Cáo Tài Chính
**Đường dẫn:** `/reports/finance`

| Báo cáo | Mục đích |
|---------|----------|
| Sổ quỹ | Thu chi hàng ngày |
| Dòng tiền | Phân tích cash flow |
| Công nợ | Tổng hợp nợ phải thu |
| Công nợ theo khách | Chi tiết từng khách |
| Lịch thanh toán | Dự kiến thu |
| Thanh toán thừa | Tiền dư |
| Tiền cọc | Tổng hợp đặt cọc |
| Phân bổ lợi nhuận | Phân tích lãi/lỗ |

### 5.3. Báo Cáo Công Việc
**Đường dẫn:** `/reports/tasks`

| Báo cáo | Mục đích |
|---------|----------|
| Tổng quan | Dashboard sự cố |
| Theo nhân viên | Hiệu suất NV |
| Theo phòng | Phòng có vấn đề |

---

## Phụ Lục

### A. Trạng Thái Hợp Đồng
| Trạng thái | Tiếng Việt | Mô tả |
|------------|------------|-------|
| DRAFT | Nháp | Mới tạo, chưa kích hoạt |
| ACTIVE | Đang hoạt động | Hợp đồng có hiệu lực |
| EXTENDED | Đã gia hạn | Đã được gia hạn |
| TRANSFERRED | Đã chuyển nhượng | Đã chuyển sang người khác |
| TERMINATED | Đã thanh lý | Kết thúc trước hạn |
| EXPIRED | Hết hạn | Hết thời hạn tự nhiên |

### B. Trạng Thái Hóa Đơn
| Trạng thái | Tiếng Việt | Mô tả |
|------------|------------|-------|
| DRAFT | Nháp | Chưa gửi khách |
| PENDING | Chờ thanh toán | Đã gửi, chờ thu |
| PARTIAL | Thanh toán phần | Thu được một phần |
| PAID | Đã thanh toán | Đã thu đủ |
| OVERDUE | Quá hạn | Quá hạn thanh toán |

### C. Trạng Thái Phòng
| Trạng thái | Tiếng Việt | Mô tả |
|------------|------------|-------|
| AVAILABLE | Trống | Sẵn sàng cho thuê |
| OCCUPIED | Đã cho thuê | Có khách ở |
| MAINTENANCE | Bảo trì | Đang sửa chữa |

### D. Phím Tắt & Mẹo
- **Dashboard:** Nhấn `/` để tìm kiếm nhanh
- **Bảng dữ liệu:** Dùng filter và search để lọc
- **Hóa đơn:** Duyệt hàng loạt để tiết kiệm thời gian
- **Thông báo:** Bật chuông để nhận cảnh báo

---

*Tài liệu này được cập nhật lần cuối: Tháng 1/2026*
*Phiên bản: 1.0*
