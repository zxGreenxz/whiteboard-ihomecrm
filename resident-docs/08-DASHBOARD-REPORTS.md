# 08. DASHBOARD & REPORTING SYSTEM

## Tổng Quan

Dashboard & Reporting System là hệ thống trung tâm cung cấp thông tin tổng hợp, phân tích dữ liệu và báo cáo kinh doanh cho quản lý bất động sản cho thuê. Hệ thống cho phép:

- **Giám sát thời gian thực** (Real-time Monitoring): Cập nhật dữ liệu trực tiếp từ Supabase
- **Phân tích dữ liệu** (Data Analytics): Charts, graphs, metrics
- **Báo cáo chuyên sâu** (Comprehensive Reports): 19 loại báo cáo khác nhau
- **Xuất dữ liệu** (Data Export): Excel, PDF, CSV
- **Lập lịch báo cáo** (Scheduled Reports): Tự động gửi email
- **Cảnh báo thông minh** (Smart Alerts): Hóa đơn quá hạn, hợp đồng sắp hết hạn, sự cố, phòng sắp trống

---

## 1. DASHBOARD (Bảng Tin Điều Hành)

### 1.1 Thiết Kế Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    IHOMECRM - DASHBOARD                                  [🔔 5] [⚙️] [👤]  │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ◄ Dashboard  |  Reports  |  Analytics  |  Settings                                                         │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                             │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐   │
│  │  TỔNG SỐ PHÒNG      │  │   ĐANG CHO THUÊ      │  │  DOANH THU THÁNG NÀY │  │      CÔNG NỢ HT     │   │
│  ├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤   │
│  │                      │  │                      │  │                      │  │                      │   │
│  │       125 căn        │  │       118 căn        │  │   45.500.000 ₫       │  │  5.200.000 ₫ (2.1%)  │   │
│  │      (▲ từ 120)      │  │      (94.4%)         │  │   (▲ 8% so với tháng)│  │  (▼ 15% so với tháng)│   │
│  │                      │  │                      │  │                      │  │                      │   │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘   │
│                                                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  BIỂU ĐỒ DOANH THU 12 THÁNG                │  BIỂU ĐỒ TỶ LỆ LẤP ĐẦY                                        │
│  ┌─────────────────────────────────────┐   │  ┌───────────────────────────────────┐                      │
│  │  Tỉ (triệu ₫)                        │   │  │  Đang thuê: 118 căn (94%)         │                      │
│  │  50 ┤         ╱╲                     │   │  │  Đóng cửa: 5 căn (4%)             │                      │
│  │  45 ┤        ╱  ╲      ╱╲            │   │  │  Bảo dưỡng: 2 căn (2%)            │                      │
│  │  40 ┤       ╱    ╲    ╱  ╲           │   │  │                                   │                      │
│  │  35 ┤      ╱      ╲  ╱    ╲          │   │  │   ░░░░░░░░░░░  94%               │                      │
│  │  30 ┤     ╱        ╲╱      ╲         │   │  │   ▒▒░░░░░░░░░░  4%               │                      │
│  │  25 ┤    ╱                  ╲        │   │  │   ░░░░░░░░░░░░  2%               │                      │
│  │     │───┴──┴──┴──┴──┴──┴──┴──┴──┴───│   │  └───────────────────────────────────┘                      │
│  │     │ 1  2  3  4  5  6  7  8  9  10  │   │                                                             │
│  │     │ 11 12 (Tháng)                  │   │                                                             │
│  └─────────────────────────────────────┘   │                                                             │
│                                            │                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  BIỂU ĐỒ CÔNG NỢ THEO LOẠI                │  BIỂU ĐỒ DÒNG TIỀN (CASH FLOW)                               │
│  ┌─────────────────────────────────────┐   │  ┌───────────────────────────────────┐                      │
│  │  Công nợ kinh doanh: 3.200.000 ₫    │   │  │  Dòng tiền ròng:                  │                      │
│  │  Công nợ khác: 2.000.000 ₫          │   │  │  ┌─────────────────────────────┐  │                      │
│  │  Tạm ứng: 0 ₫                       │   │  │  │ Tháng này: 15.800.000 ₫     │  │                      │
│  │                                     │   │  │  │ Tháng trước: 12.300.000 ₫   │  │                      │
│  │  ▇▇▇▇▇ 61.5%                        │   │  │  │ Trung bình: 14.050.000 ₫    │  │                      │
│  │  ▄▄▄▄ 38.5%                         │   │  │  │ Xu hướng: ▲ Tăng             │  │                      │
│  │                                     │   │  │  └─────────────────────────────┘  │                      │
│  └─────────────────────────────────────┘   │  └───────────────────────────────────┘                      │
│                                                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  CẢNH BÁO & THÔNG BÁO (5 CẢNH BÁO HOẠT ĐỘNG)                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  ⚠️  HÓA ĐƠN QUÁ HẠN (3)                                                                     [Xem tất] │  │
│  │  ├─ [SỰ CỐ] Phòng 301 - Cửa không khóa được (Ngày 15/11)                      [Đánh dấu hoàn tất]  │  │
│  │  ├─ [HÓA ĐƠN QUỐC HẠN] HĐ-2024-0045 từ 45 ngày trước (Khách: Nguyễn Văn A)     [Gửi nhắc nhở]     │  │
│  │  └─ [HÓA ĐƠN QUỐC HẠN] HĐ-2024-0043 từ 32 ngày trước (Khách: Trần Thị B)      [Gửi nhắc nhở]     │  │
│  │                                                                                                     │  │
│  │  ⓘ HỢP ĐỒNG SẮP HẾT HẠN (2)                                                                 [Xem tất] │  │
│  │  ├─ [SẮP HẾT HẠN] HDTL-2024-0023 (Phòng 205) - Hết hạn 28/11/2024 (9 ngày)     [Gia hạn/Chuyển]  │  │
│  │  └─ [SẮP HẾT HẠN] HDTL-2024-0018 (Phòng 102) - Hết hạn 15/12/2024 (26 ngày)    [Gia hạn/Chuyển]  │  │
│  │                                                                                                     │  │
│  │  🔧 SỰ CỐ CHƯA XỬ LÝ (1)                                                                   [Xem tất] │  │
│  │  └─ [VĂN PHÒNG 301] Cửa không khóa được - Mức độ: Cao - Tạo: 15/11 lúc 14:30  [Xem chi tiết]    │  │
│  │                                                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  HOẠT ĐỘNG GẦN ĐÂY                          │  THAO TÁC NHANH                                              │
│  ┌─────────────────────────────────────┐   │  ┌──────────────────────────────────┐                      │
│  │ 14:45 - Khách mới ở Phòng 501       │   │  [+] Tạo Hợp đồng mới             │                      │
│  │         Nguyễn Văn A                │   │  [+] Thêm Khách mới                │                      │
│  │                                     │   │  [+] Tạo Hóa đơn                  │                      │
│  │ 14:20 - Cập nhật Thanh toán         │   │  [📊] Xuất báo cáo                │                      │
│  │         HĐ-2024-0091                │   │  [🔍] Tìm kiếm chuyên sâu        │                      │
│  │                                     │   │  [⚙️] Cài đặt                    │                      │
│  │ 13:55 - Sửa thông tin Khách         │   └──────────────────────────────────┘                      │
│  │         Trần Thị B                  │                                                             │
│  │                                     │                                                             │
│  │ 13:30 - Tạo Sự cố mới               │                                                             │
│  │         Phòng 301                   │                                                             │
│  │                                     │                                                             │
│  │ [Xem tất cả hoạt động...]           │                                                             │
│  └─────────────────────────────────────┘                                                             │
│                                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Overview Cards (4 Thẻ Tổng Quan)

#### Thẻ 1: Tổng số phòng
- **Tiêu đề**: TỔNG SỐ PHÒNG
- **Giá trị chính**: 125 căn
- **Độ biến động**: ▲ từ 120 (Thay đổi +5 căn từ tháng trước)
- **Phần trăm**: Tỷ lệ lấp đầy 94.4%
- **Color**: Blue (#3B82F6)
- **Icon**: 🏢

#### Thẻ 2: Đang cho thuê
- **Tiêu đề**: ĐANG CHO THUÊ
- **Giá trị chính**: 118 căn
- **Phần trăm**: 94.4% (Occupancy Rate)
- **Trend**: ▲ Tăng từ 115 (Tháng trước)
- **Color**: Green (#10B981)
- **Icon**: 🔑

#### Thẻ 3: Doanh thu tháng này
- **Tiêu đề**: DOANH THU THÁNG NÀY
- **Giá trị chính**: 45.500.000 ₫
- **Trend**: ▲ 8% so với tháng trước (39.750.000 ₫)
- **Mục tiêu**: 45.000.000 ₫ (đã vượt 0.5%)
- **Color**: Emerald (#059669)
- **Icon**: 💰

#### Thẻ 4: Công nợ hiện tại
- **Tiêu đề**: CÔNG NỢ HT
- **Giá trị chính**: 5.200.000 ₫
- **Phần trăm**: 2.1% (so với doanh thu tháng này)
- **Trend**: ▼ 15% so với tháng trước (6.117.000 ₦)
- **Color**: Red (#EF4444)
- **Icon**: ⚠️

### 1.3 Charts (4 Biểu Đồ Chính)

#### 1.3.1 Revenue Line Chart - Doanh Thu 12 Tháng
- **Loại**: Line Chart
- **Dữ liệu**: Doanh thu hàng tháng (12 tháng gần nhất)
- **Trục X**: Tháng (1-12)
- **Trục Y**: Doanh thu (triệu ₫)
- **Tính năng**:
  - Tooltip hiển thị giá trị chính xác
  - Zoom & pan
  - Toggle legend
  - So sánh năm trước
- **Query**:
  ```sql
  SELECT DATE_TRUNC('month', created_at) as month, SUM(amount) as revenue
  FROM invoices
  WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '12 months'
  GROUP BY month
  ORDER BY month
  ```

#### 1.3.2 Occupancy Pie Chart - Tỷ Lệ Lấp Đầy
- **Loại**: Pie Chart
- **Dữ liệu**: Phân loại trạng thái phòng
  - Đang thuê (94%)
  - Đóng cửa (4%)
  - Bảo dưỡng (2%)
- **Tính năng**:
  - Hiển thị số lượng và phần trăm
  - Click từng phần để drill down
  - Animated transition
- **Query**:
  ```sql
  SELECT status, COUNT(*) as count
  FROM apartments
  GROUP BY status
  ```

#### 1.3.3 Debt Bar Chart - Công Nợ Theo Loại
- **Loại**: Horizontal Bar Chart
- **Dữ liệu**: Phân loại công nợ
  - Công nợ kinh doanh: 3.200.000 ₫ (61.5%)
  - Công nợ khác: 2.000.000 ₫ (38.5%)
  - Tạm ứng: 0 ₫ (0%)
- **Tính năng**:
  - So sánh kỳ trước
  - Drill down để xem chi tiết
- **Query**:
  ```sql
  SELECT debt_type, SUM(amount) as total
  FROM debts
  WHERE status = 'open'
  GROUP BY debt_type
  ```

#### 1.3.4 Cash Flow Chart - Dòng Tiền
- **Loại**: Bar + Line Combination Chart
- **Dữ liệu**:
  - Dòng tiền vào (Bar - Xanh)
  - Dòng tiền ra (Bar - Đỏ)
  - Dòng tiền ròng (Line - Vàng)
- **Thời gian**: 6 tháng gần nhất
- **Tính năng**:
  - Highlight xu hướng
  - Dự báo (Forecast)
- **Query**:
  ```sql
  SELECT DATE_TRUNC('month', created_at) as month,
         SUM(CASE WHEN type = 'in' THEN amount ELSE 0 END) as inflow,
         SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END) as outflow
  FROM cash_flow
  WHERE created_at >= NOW() - INTERVAL '6 months'
  GROUP BY month
  ORDER BY month
  ```

### 1.4 Alerts & Notifications (4 Loại Cảnh Báo)

#### 1.4.1 Hóa Đơn Quá Hạn
- **Mô tả**: Hiển thị hóa đơn chưa thanh toán quá hạn
- **Điều kiện**: `invoice.status = 'pending' AND invoice.due_date < TODAY`
- **Số lượng**: 3 hóa đơn quá hạn
- **Hiển thị**:
  - Mã hóa đơn
  - Tên khách hàng
  - Số ngày quá hạn
  - Số tiền nợ
- **Hành động**:
  - [Gửi nhắc nhở] - Gửi email/SMS reminder
  - [Thanh toán] - Trực tiếp nhập tiền
  - [Hoãn hạn] - Thay đổi ngày thanh toán
  - [Chi tiết] - Xem hóa đơn đầy đủ
- **Query**:
  ```sql
  SELECT * FROM invoices
  WHERE status = 'pending' AND due_date < CURRENT_DATE
  ORDER BY due_date ASC
  LIMIT 5
  ```

#### 1.4.2 Hợp Đồng Sắp Hết Hạn
- **Mô tả**: Hợp đồng sẽ hết hạn trong 30 ngày tới
- **Điều kiện**: `contract.end_date BETWEEN TODAY AND TODAY + 30 days`
- **Số lượng**: 2 hợp đồng sắp hết hạn
- **Hiển thị**:
  - Mã hợp đồng
  - Phòng / Khách hàng
  - Ngày hết hạn
  - Số ngày còn lại
- **Hành động**:
  - [Gia hạn] - Tạo hợp đồng gia hạn
  - [Chuyển nhượng] - Chuyển phòng
  - [Chi tiết] - Xem hợp đồng
- **Query**:
  ```sql
  SELECT * FROM contracts
  WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
  ORDER BY end_date ASC
  LIMIT 5
  ```

#### 1.4.3 Sự Cố Chưa Xử Lý
- **Mô tả**: Các sự cố được báo cáo nhưng chưa giải quyết
- **Điều kiện**: `incident.status IN ('open', 'in_progress')`
- **Số lượng**: 1 sự cố chưa xử lý
- **Hiển thị**:
  - Phòng / Vị trí
  - Mô tả sự cố
  - Mức độ ưu tiên (Cao/Trung/Thấp)
  - Ngày báo cáo
- **Hành động**:
  - [Giao việc] - Giao cho nhân viên
  - [Cập nhật] - Thay đổi trạng thái
  - [Hoàn tất] - Đánh dấu là đã xử lý
- **Query**:
  ```sql
  SELECT * FROM incidents
  WHERE status IN ('open', 'in_progress')
  ORDER BY priority DESC, created_at ASC
  LIMIT 5
  ```

#### 1.4.4 Phòng Sắp Trống
- **Mô tả**: Phòng sẽ trống (khách sắp di chuyển) trong 7 ngày
- **Điều kiện**: Hợp đồng sắp hết hạn + trạng thái "occupied"
- **Số lượng**: Tính toán từ dữ liệu hợp đồng
- **Hiển thị**:
  - Phòng số
  - Khách hàng hiện tại
  - Ngày trống dự kiến
  - Giá thuê hiện tại
- **Hành động**:
  - [Cho thuê] - Bắt đầu cho thuê
  - [Bảo dưỡng] - Chuyển trạng thái
- **Query**:
  ```sql
  SELECT a.*, c.end_date, t.tenant_name
  FROM apartments a
  JOIN contracts c ON a.id = c.apartment_id
  JOIN tenants t ON c.tenant_id = t.id
  WHERE a.status = 'occupied'
    AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
  ORDER BY c.end_date ASC
  ```

### 1.5 Recent Activities Feed (Hoạt Động Gần Đây)

- **Mục đích**: Hiển thị lịch sử hoạt động gần đây trong hệ thống
- **Hiển thị**: 5-10 hoạt động gần nhất
- **Loại hoạt động**:
  - 🆕 Tạo mới: Hợp đồng, Hóa đơn, Khách, Sự cố
  - ✏️ Cập nhật: Thông tin, Trạng thái, Số tiền
  - ✓ Thanh toán: Hoàn tất thanh toán hóa đơn
  - 🔧 Xử lý: Xử lý sự cố, Gia hạn hợp đồng
- **Thông tin hiển thị**:
  - Thời gian
  - Loại hoạt động
  - Mô tả ngắn
  - Người thực hiện (Admin/Staff/System)
- **Query**:
  ```sql
  SELECT * FROM activity_log
  ORDER BY created_at DESC
  LIMIT 10
  ```

### 1.6 Quick Actions (Thao Tác Nhanh)

- **[+] Tạo Hợp đồng mới**: Chuyển đến trang thêm hợp đồng
- **[+] Thêm Khách mới**: Chuyển đến trang thêm khách hàng
- **[+] Tạo Hóa đơn**: Chuyển đến trang tạo hóa đơn
- **[📊] Xuất báo cáo**: Mở modal chọn loại báo cáo
- **[🔍] Tìm kiếm chuyên sâu**: Mở advanced search
- **[⚙️] Cài đặt**: Chuyển đến Settings

### 1.7 Real-time Updates với Supabase Realtime

```typescript
// Supabase Realtime Subscriptions
const DASHBOARD_CHANNELS = {
  INVOICES: 'public:invoices',
  APARTMENTS: 'public:apartments',
  CONTRACTS: 'public:contracts',
  INCIDENTS: 'public:incidents',
  ACTIVITY_LOG: 'public:activity_log',
  PAYMENTS: 'public:payments'
};

// Subscribe to changes
supabase
  .channel('dashboard-updates')
  .on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'invoices' },
    (payload) => {
      // Update cards: doanh thu, công nợ
      updateDashboardMetrics(payload);
    }
  )
  .on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'incidents' },
    (payload) => {
      // Update alerts section
      updateAlerts(payload);
    }
  )
  .subscribe();

// Auto-refresh mỗi 5 phút
setInterval(() => {
  refetchDashboardData();
}, 5 * 60 * 1000);
```

---

## 2. BÁO CÁO BẤT ĐỘNG SẢN (8 Loại)

### 2.1 Báo Cáo Căn Hộ Trống
- **Tiêu đề**: Danh sách căn hộ trống hiện tại
- **Số lượng**: Ví dụ: 7 căn trống
- **Cột dữ liệu**:
  - Phòng số
  - Diện tích (m²)
  - Giá thuê (₫/tháng)
  - Vị trí (Tầng, Khu)
  - Tiện ích
  - Trạng thái (Sạch/Cần dọn dẹp/Cần sửa chữa)
  - Ngày trống
- **Bộ lọc**: Theo giá, vị trí, tiện ích, trạng thái
- **Export**: Excel, PDF

### 2.2 Báo Cáo Căn Hộ Sắp Trống
- **Tiêu đề**: Danh sách căn hộ sắp trống (7 ngày tới)
- **Số lượng**: Ví dụ: 2 căn sắp trống
- **Cột dữ liệu**:
  - Phòng số
  - Khách hàng hiện tại
  - Ngày dự kiến trống
  - Ngày còn lại (ngày)
  - Giá thuê hiện tại
  - Hành động
- **Bộ lọc**: Theo ngày, giá, vị trí
- **Hành động**: Cho thuê, Bảo dưỡng

### 2.3 Báo Cáo Gia Hạn Hợp Đồng
- **Tiêu đề**: Hợp đồng đã gia hạn (kỳ này)
- **Số lượng**: Ví dụ: 3 hợp đồng gia hạn
- **Cột dữ liệu**:
  - Mã hợp đồng gốc
  - Mã hợp đồng gia hạn
  - Phòng
  - Khách hàng
  - Ngày gia hạn
  - Thời hạn mới
  - Giá thuê
- **Bộ lọc**: Theo ngày gia hạn, phòng, khách hàng
- **Query**:
  ```sql
  SELECT c1.id as original_id, c2.id as extended_id, c2.end_date,
         a.room_number, t.name, c2.rent_amount
  FROM contracts c1
  JOIN contracts c2 ON c1.id = c2.parent_contract_id
  WHERE c2.created_at >= DATE_TRUNC('month', CURRENT_DATE)
  ORDER BY c2.created_at DESC
  ```

### 2.4 Báo Cáo Chuyển Nhượng Phòng
- **Tiêu đề**: Phòng đã chuyển nhượng (kỳ này)
- **Số lượng**: Ví dụ: 1 phòng chuyển nhượng
- **Cột dữ liệu**:
  - Phòng gốc
  - Phòng mới
  - Khách hàng cũ
  - Khách hàng mới
  - Ngày chuyển
  - Lý do chuyển
  - Phí chuyển (nếu có)
- **Bộ lọc**: Theo ngày, khách, phòng

### 2.5 Báo Cáo Tỷ Lệ Lấp Đầy (Occupancy Rate)
- **Tiêu đề**: Tỷ lệ lấp đầy và xu hướng
- **Dữ liệu**:
  - Tổng phòng: 125 căn
  - Phòng cho thuê: 118 căn
  - Phòng trống: 5 căn
  - Phòng bảo dưỡng: 2 căn
  - Tỷ lệ lấp đầy: 94.4%
- **Biểu đồ**:
  - Pie chart phân loại phòng
  - Line chart xu hướng 12 tháng
  - Comparison so với tháng trước (▲ 0.5%)
- **Phân tích**:
  - Top 5 phòng có tỷ lệ lấp đầy cao
  - Phòng thường bị trống
- **Query**:
  ```sql
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN status = 'occupied' THEN 1 END) as occupied,
    COUNT(CASE WHEN status = 'vacant' THEN 1 END) as vacant,
    ROUND(100.0 * COUNT(CASE WHEN status = 'occupied' THEN 1 END) / COUNT(*), 2) as occupancy_rate
  FROM apartments
  ```

### 2.6 Báo Cáo Khuyến Mại / Ưu Đãi
- **Tiêu đề**: Danh sách khuyến mại hiện tại và lịch sử
- **Cột dữ liệu**:
  - Mã khuyến mại
  - Mô tả
  - Loại (% giảm giá, Miễn phí tháng, Giảm giá)
  - Mức giảm
  - Phòng áp dụng
  - Ngày bắt đầu - Ngày kết thúc
  - Trạng thái (Hoạt động/Kết thúc)
  - Số tiền tiết kiệm
- **Bộ lọc**: Theo loại, trạng thái, phòng
- **Phân tích**: Tổng tiền giảm, phòng sử dụng khuyến mại nhiều nhất

### 2.7 Báo Cáo Cho Thuê Mới
- **Tiêu đề**: Hợp đồng cho thuê mới (kỳ này)
- **Số lượng**: Ví dụ: 4 phòng cho thuê mới
- **Cột dữ liệu**:
  - Mã hợp đồng
  - Phòng
  - Khách hàng mới
  - Ngày bắt đầu
  - Thời hạn (tháng)
  - Giá thuê
  - Tổng giá trị hợp đồng (tháng × giá)
  - Cọc + phí
- **Bộ lọc**: Theo ngày, phòng, giá
- **Phân tích**: Doanh thu từ phòng mới, khách hàng mới trung bình

### 2.8 Báo Cáo Bỏ Trả / Hủy Hợp Đồng
- **Tiêu đề**: Phòng bỏ trả / Hợp đồng hủy (kỳ này)
- **Số lượng**: Ví dụ: 1 phòng bỏ trả
- **Cột dữ liệu**:
  - Mã hợp đồng
  - Phòng
  - Khách hàng
  - Ngày bắt đầu - Ngày bỏ trả
  - Thời gian thuê (tháng)
  - Lý do bỏ trả
  - Tiền cọc hoàn lại / Phí hủy
  - Trạng thái thanh toán
- **Bộ lọc**: Theo lý do, ngày, khách
- **Phân tích**: Tỷ lệ bỏ trả, nguyên nhân chính

---

## 3. BÁO CÁO TÀI CHÍNH (8 Loại)

### 3.1 Sổ Quỹ Theo Ngày
- **Tiêu đề**: Sổ quỹ chi tiết theo ngày
- **Tính toán**:
  - Dư đầu kỳ (Beginning Balance)
  - Tiền vào (Inflow): Thuê phòng, Khác
  - Tiền ra (Outflow): Chi phí, Bảo dưỡng, Lương, Khác
  - Dư cuối kỳ (Ending Balance)
- **Bộ lọc**: Theo ngày, khoảng ngày, loại giao dịch
- **Cột dữ liệu**:
  - Ngày
  - Chi tiết giao dịch
  - Loại (Vào/Ra)
  - Số tiền
  - Dư tích lũy
- **Biểu đồ**: Stacked bar chart chi tiết vào/ra hàng ngày

### 3.2 Báo Cáo Dòng Tiền (Cash Flow)
- **Tiêu đề**: Dòng tiền và xu hướng
- **Tính toán**:
  - Tiền vào: Thanh toán thuê, Phí thêm, Khác
  - Tiền ra: Chi phí, Bảo dưỡng, Lương, Cấp tài chính, Khác
  - Dòng tiền ròng (Net Cash Flow): Vào - Ra
- **Biểu đồ**:
  - Combination chart: Bar (Vào/Ra), Line (Ròng)
  - Thời gian: 6-12 tháng
- **Phân tích**:
  - Tháng dòng tiền cao nhất / thấp nhất
  - Xu hướng (Tăng/Giảm)
  - Dự báo 3 tháng tới
- **Query**:
  ```sql
  SELECT DATE_TRUNC('month', created_at) as month,
         SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as inflow,
         SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as outflow
  FROM transactions
  WHERE created_at >= NOW() - INTERVAL '12 months'
  GROUP BY month
  ORDER BY month
  ```

### 3.3 Báo Cáo Phân Bổ Lợi Nhuận
- **Tiêu đề**: Phân tích lợi nhuận và phân bổ
- **Tính toán**:
  - Tổng doanh thu (Total Revenue)
  - Tổng chi phí (Total Expenses)
  - Lợi nhuận ròng (Net Profit)
  - Tỷ lệ lợi nhuận (Margin %)
- **Phân bổ lợi nhuận**:
  - Dự phòng / Quỹ bảo dưỡng
  - Lương quản lý
  - Đầu tư mở rộng
  - Cổ tức / Chia cắt
  - Dự phòng rủi ro
- **Biểu đồ**: Pie chart phân bổ, Waterfall chart tính lợi nhuận
- **Bộ lọc**: Theo tháng, quý, năm

### 3.4 Báo Cáo Công Nợ
- **Tiêu đề**: Công nợ chi tiết và phân loại
- **Dữ liệu**:
  - Tổng công nợ
  - Công nợ kinh doanh
  - Công nợ khách hàng (Overdue invoices)
  - Công nợ cán bộ / Lương
  - Tạm ứng
- **Phân tích theo tuổi nợ** (Aging):
  - Nợ < 30 ngày
  - Nợ 30-60 ngày
  - Nợ 60-90 ngày
  - Nợ > 90 ngày
- **Biểu đồ**: Stacked bar chart phân loại, Pie chart theo tuổi nợ
- **Cột dữ liệu**:
  - Loại nợ
  - Số tiền
  - % của tổng nợ
  - Người nợ
  - Ngày phát sinh
- **Query**:
  ```sql
  SELECT
    debt_type,
    SUM(amount) as total,
    ROUND(100.0 * SUM(amount) / (SELECT SUM(amount) FROM debts WHERE status = 'open'), 2) as percentage,
    COUNT(*) as count
  FROM debts
  WHERE status = 'open'
  GROUP BY debt_type
  ORDER BY total DESC
  ```

### 3.5 Báo Cáo Khách Nợ Tiền
- **Tiêu đề**: Danh sách khách hàng nợ tiền
- **Số lượng**: Ví dụ: 3 khách hàng nợ tiền
- **Cột dữ liệu**:
  - Tên khách hàng
  - Phòng
  - Số tiền nợ (₫)
  - Hóa đơn quá hạn (số lượng)
  - Hóa đơn quá hạn nhất (số ngày)
  - Liên hệ (Điện thoại, Email)
  - Trạng thái liên hệ
  - Hành động cuối cùng
- **Bộ lọc**: Theo số tiền nợ, số ngày quá hạn, phòng
- **Sắp xếp**: Theo số tiền nợ (cao → thấp)
- **Hành động**:
  - [Gửi nhắc nhở] - Email/SMS
  - [Thanh toán] - Nhập tiền
  - [Thương lượng] - Tạo kế hoạch thanh toán
  - [Chi tiết] - Xem tất cả hóa đơn

### 3.6 Báo Cáo Lịch Thanh Toán
- **Tiêu đề**: Lịch thanh toán dự kiến
- **Dữ liệu**:
  - Hóa đơn phát sinh
  - Hóa đơn đến hạn
  - Hóa đơn quá hạn
  - Hóa đơn được thanh toán
- **Biểu đồ**: Waterfall chart hoặc Gantt chart
- **Cột dữ liệu**:
  - Ngày
  - Hóa đơn/Hợp đồng
  - Khách hàng
  - Số tiền
  - Trạng thái
  - Ghi chú
- **Dự báo**: Tiền dự kiến thu trong 7 ngày tới, 30 ngày tới
- **Query**:
  ```sql
  SELECT created_at::date as date, SUM(amount) as total_invoiced
  FROM invoices
  WHERE created_at >= CURRENT_DATE
    AND created_at < CURRENT_DATE + INTERVAL '30 days'
  GROUP BY date
  ORDER BY date
  ```

### 3.7 Báo Cáo Tiền Thừa / Overpayment
- **Tiêu đề**: Danh sách tiền thừa khách hàng
- **Dữ liệu**:
  - Tên khách hàng
  - Phòng
  - Số tiền thừa (₫)
  - Ngày phát sinh
  - Lý do (Thanh toán dư, Giảm giá không sử dụng, Khác)
  - Trạng thái (Chờ xử lý, Hoàn lại, Đã rút)
- **Tính toán**: SUM(payments) - SUM(invoices)
- **Hành động**: Hoàn lại, Chuyển sang tháng sau, Tích vào quỹ khác

### 3.8 Báo Cáo Danh Sách Tiền Cọc
- **Tiêu đề**: Quản lý tiền cọc khách hàng
- **Cột dữ liệu**:
  - Tên khách hàng
  - Phòng
  - Số tiền cọc (₫)
  - Ngày cọc
  - Ngày hết hạn cọc
  - Tình trạng (Đang giữ, Dùng để thanh toán, Hoàn lại, Mất)
  - Ghi chú
- **Phân tích**:
  - Tổng tiền cọc đang giữ
  - Tiền cọc sắp hết hạn
  - Tiền cọc không sử dụng
- **Bộ lọc**: Theo trạng thái, phòng, khách

---

## 4. BÁO CÁO CÔNG VIỆC (3 Loại)

### 4.1 Báo Cáo Công Việc Tổng Quan
- **Tiêu đề**: Tổng quan công việc và nhiệm vụ
- **Dữ liệu**:
  - Tổng số công việc: Ví dụ 25 công việc
  - Công việc hoàn tất: 18 (72%)
  - Công việc đang thực hiện: 4 (16%)
  - Công việc chưa bắt đầu: 3 (12%)
  - Công việc quá hạn: 2 (8%)
- **Biểu đồ**: Pie chart trạng thái, Bar chart xu hướng
- **Cột dữ liệu**:
  - Mã công việc
  - Tiêu đề
  - Gán cho (Nhân viên)
  - Ngày tạo
  - Ngày hết hạn
  - Ưu tiên (Cao/Trung/Thấp)
  - Tiến độ (%)
  - Trạng thái

### 4.2 Báo Cáo Công Việc Theo Nhân Viên
- **Tiêu đề**: Phân bổ công việc cho từng nhân viên
- **Dữ liệu**:
  - Tên nhân viên
  - Tổng công việc gán
  - Hoàn tất / % hoàn tất
  - Đang thực hiện
  - Quá hạn
  - Hiệu suất trung bình (%)
  - Thời gian trung bình hoàn tất (ngày)
- **Biểu đồ**:
  - Horizontal bar chart so sánh công việc theo nhân viên
  - Line chart xu hướng hoàn tất
- **Bộ lọc**: Theo nhân viên, bộ phận, ngày
- **Sắp xếp**: Theo hiệu suất, công việc hoàn tất, công việc quá hạn

### 4.3 Báo Cáo Công Việc Theo Căn Hộ
- **Tiêu đề**: Công việc liên quan đến từng phòng
- **Dữ liệu**:
  - Phòng số
  - Tổng công việc (bảo dưỡng, sửa chữa, dọn dẹp)
  - Công việc hoàn tất
  - Công việc đang thực hiện
  - Công việc quá hạn
  - Tổng chi phí (nếu có)
  - Ghi chú
- **Biểu đồ**: Bar chart số công việc, Pie chart trạng thái
- **Cột dữ liệu**:
  - Phòng
  - Loại công việc
  - Mô tả
  - Gán cho
  - Hạn chót
  - Chi phí dự kiến
  - Trạng thái
- **Bộ lọc**: Theo phòng, loại công việc, trạng thái

---

## 5. EXPORT FORMATS (Xuất Dữ Liệu)

### 5.1 Excel Format (.xlsx)
- **Thư viện**: `xlsx` hoặc `ExcelJS`
- **Tính năng**:
  - Multiple sheets (một sheet cho mỗi báo cáo)
  - Formatted headers (màu, bold, center)
  - Auto-fit column width
  - Số format (Tiền tệ, %)
  - Merged cells cho tiêu đề
  - Formulas cho tính toán (SUM, AVERAGE)
  - Freeze panes
  - Data validation cho filter
- **Ví dụ**:
  ```typescript
  import XLSX from 'xlsx';

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, 'report.xlsx');
  ```

### 5.2 PDF Format (.pdf)
- **Thư viện**: `jsPDF`, `pdfkit`, hoặc `html2pdf`
- **Tính năng**:
  - Header & Footer (Logo, Tên công ty, Ngày)
  - Page break tự động
  - Tables, Charts (as images)
  - Watermark (nếu cần)
  - Password protection (optional)
  - QR code (optional)
- **Ví dụ**:
  ```typescript
  import html2pdf from 'html2pdf.js';

  const element = document.getElementById('report');
  html2pdf().set({
    margin: 10,
    filename: 'report.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
  }).from(element).save();
  ```

### 5.3 CSV Format (.csv)
- **Thư viện**: Built-in JavaScript hoặc `papaparse`
- **Tính năng**:
  - UTF-8 encoding
  - Properly escaped columns (cọc dấu phẩy, dòng mới)
  - Header row
  - Số format (decimal separator)
- **Ví dụ**:
  ```typescript
  function exportToCSV(data, filename) {
    const csv = [
      Object.keys(data[0]),
      ...data.map(row => Object.values(row).map(v => `"${v}"`))
    ].map(row => row.join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  ```

---

## 6. FILTERS & DATE RANGES (Bộ Lọc & Khoảng Ngày)

### 6.1 Date Range Filters
- **Loại bộ lọc ngày**:
  - Quick select: Hôm nay, Hôm qua, Tuần này, Tháng này, Quý này, Năm này
  - Preset: 7 ngày, 30 ngày, 90 ngày, 180 ngày, 365 ngày
  - Custom: Chọn từ ngày đến ngày (Date picker)
- **Thành phần**: From date, To date, Preset buttons
- **Default**: Month to date (Từ ngày 1 đến hôm nay)

### 6.2 Category Filters
- **Căn hộ / Phòng**: Dropdown multi-select, Search by room number
- **Khách hàng**: Dropdown multi-select, Search by name/phone
- **Trạng thái**: Checkboxes (Occupied, Vacant, Maintenance)
- **Loại giao dịch**: Radio buttons (Income, Expense, All)
- **Nhân viên / Bộ phận**: Dropdown multi-select
- **Ưu tiên**: Checkboxes (Cao, Trung, Thấp)

### 6.3 Advanced Filters
- **Số tiền**: Range slider (Min - Max)
- **Tỷ lệ lấp đầy**: Range slider (0% - 100%)
- **Tuổi nợ**: Select (< 30, 30-60, 60-90, > 90 ngày)
- **Loại báo cáo**: Dropdown
- **Sắp xếp**: Column header click hoặc Dropdown

### 6.4 Filter Persistence
- **Lưu bộ lọc**: Checkbox "Save as default"
- **Preset filters**: Danh sách các bộ lọc thường dùng
- **URL params**: Lưu bộ lọc trong URL để share
- **Local storage**: Lưu lựa chọn cuối cùng

---

## 7. SCHEDULED REPORTS (Báo Cáo Lập Lịch)

### 7.1 Scheduled Report Configuration
- **Tên báo cáo**: Tùy chỉnh
- **Loại báo cáo**: Chọn từ danh sách
- **Tần suất** (Frequency):
  - Hàng ngày (Daily - 8:00 AM)
  - Hàng tuần (Weekly - Thứ 2, 9:00 AM)
  - Hàng tháng (Monthly - Ngày 1, 9:00 AM)
  - Hàng quý (Quarterly)
  - Hàng năm (Annually)
  - Custom (Cron expression)
- **Ngày gửi / Giờ**: Tùy chỉnh
- **Người nhận**: Email addresses (Multiple recipients)
- **Format xuất**: Excel, PDF, CSV
- **Bộ lọc**: Áp dụng cùng bộ lọc mỗi lần gửi
- **Trạng thái**: Active / Inactive

### 7.2 Scheduled Report Examples

#### Báo Cáo Hàng Ngày (Daily)
- **Tên**: Daily Cash Summary
- **Giờ gửi**: 8:00 AM
- **Người nhận**: manager@example.com
- **Nội dung**:
  - Doanh thu hôm qua
  - Chi phí hôm qua
  - Dòng tiền ròng
  - Công nợ mới phát sinh
  - Thanh toán nhận được
  - Sự cố mới

#### Báo Cáo Hàng Tuần (Weekly)
- **Tên**: Weekly Occupancy Report
- **Giờ gửi**: Thứ 2 lúc 9:00 AM
- **Người nhận**: manager@example.com, owner@example.com
- **Nội dung**:
  - Tỷ lệ lấp đầy tuần này
  - Phòng bỏ trả / Phòng mới
  - Doanh thu tuần
  - Top customers

#### Báo Cáo Hàng Tháng (Monthly)
- **Tên**: Monthly Financial Report
- **Giờ gửi**: Ngày 1 của tháng lúc 10:00 AM
- **Người nhận**: manager@example.com, owner@example.com, accountant@example.com
- **Nội dung**:
  - Tóm tắt tài chính tháng trước
  - Doanh thu / Chi phí / Lợi nhuận
  - Công nợ
  - Dòng tiền
  - Phân tích so sánh
  - Biểu đồ

### 7.3 Email Template
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .header { background-color: #003d82; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .metric { display: inline-block; width: 23%; margin: 1%; background: #f5f5f5; padding: 10px; }
    .metric-label { font-size: 12px; color: #666; }
    .metric-value { font-size: 24px; font-weight: bold; color: #003d82; }
    .footer { background-color: #f5f5f5; padding: 10px; text-align: center; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background-color: #e0e0e0; padding: 10px; text-align: left; font-weight: bold; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    a { color: #003d82; text-decoration: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1>iHome CRM - Báo Cáo Tháng 11/2024</h1>
  </div>
  <div class="content">
    <h2>Tóm tắt tài chính</h2>
    <div class="metric">
      <div class="metric-label">Doanh Thu</div>
      <div class="metric-value">45.5 Tr</div>
    </div>
    <div class="metric">
      <div class="metric-label">Chi Phí</div>
      <div class="metric-value">12.3 Tr</div>
    </div>
    <div class="metric">
      <div class="metric-label">Lợi Nhuận</div>
      <div class="metric-value">33.2 Tr</div>
    </div>
    <div class="metric">
      <div class="metric-label">Công Nợ</div>
      <div class="metric-value">5.2 Tr</div>
    </div>

    <h2>Chi tiết doanh thu</h2>
    <table>
      <tr>
        <th>Phòng</th>
        <th>Khách hàng</th>
        <th>Doanh thu</th>
        <th>Thanh toán</th>
      </tr>
      <tr>
        <td>301</td>
        <td>Nguyễn Văn A</td>
        <td>3.500.000</td>
        <td>3.500.000</td>
      </tr>
    </table>

    <p><a href="https://ihomecrm.com/dashboard">Xem báo cáo đầy đủ</a></p>
  </div>
  <div class="footer">
    <p>iHome CRM - Hệ thống quản lý bất động sản cho thuê</p>
    <p>© 2024. All rights reserved.</p>
  </div>
</body>
</html>
```

### 7.4 Implementation (Node.js + Cron)
```typescript
import cron from 'node-cron';
import { generateReport } from './reports';
import { sendEmail } from './email';

// Daily report at 8:00 AM
cron.schedule('0 8 * * *', async () => {
  try {
    const report = await generateReport('daily-cash', {
      fromDate: yesterday(),
      toDate: yesterday()
    });
    await sendEmail({
      to: 'manager@example.com',
      subject: 'Daily Cash Summary',
      html: report.html,
      attachments: [{ filename: 'report.pdf', content: report.pdf }]
    });
    console.log('Daily report sent');
  } catch (error) {
    console.error('Error sending report:', error);
  }
});

// Weekly report at Monday 9:00 AM
cron.schedule('0 9 * * 1', async () => {
  // Similar logic for weekly report
});

// Monthly report at 1st day, 10:00 AM
cron.schedule('0 10 1 * *', async () => {
  // Similar logic for monthly report
});
```

---

## 8. DATABASE VIEWS & QUERIES

### 8.1 Dashboard Metrics View
```sql
CREATE OR REPLACE VIEW dashboard_metrics AS
SELECT
  (SELECT COUNT(*) FROM apartments) as total_apartments,
  (SELECT COUNT(*) FROM apartments WHERE status = 'occupied') as occupied_apartments,
  (SELECT COUNT(*) FROM apartments WHERE status = 'vacant') as vacant_apartments,
  (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'occupied') / COUNT(*), 2)
   FROM apartments) as occupancy_rate,
  (SELECT SUM(amount) FROM invoices WHERE status = 'paid' AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()))
    as monthly_revenue,
  (SELECT SUM(amount) FROM debts WHERE status = 'open') as total_debt,
  NOW() as last_updated;
```

### 8.2 Monthly Revenue View
```sql
CREATE OR REPLACE VIEW monthly_revenue AS
SELECT
  DATE_TRUNC('month', created_at)::date as month,
  SUM(amount) as total_revenue,
  COUNT(*) as invoice_count,
  AVG(amount) as avg_invoice
FROM invoices
WHERE status = 'paid'
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month DESC;
```

### 8.3 Overdue Invoices View
```sql
CREATE OR REPLACE VIEW overdue_invoices AS
SELECT
  i.id,
  i.invoice_number,
  i.amount,
  i.due_date,
  (CURRENT_DATE - i.due_date) as days_overdue,
  t.name as tenant_name,
  t.phone,
  t.email,
  a.room_number
FROM invoices i
JOIN tenants t ON i.tenant_id = t.id
JOIN apartments a ON i.apartment_id = a.id
WHERE i.status = 'pending' AND i.due_date < CURRENT_DATE
ORDER BY i.due_date ASC;
```

### 8.4 Cash Flow Analysis View
```sql
CREATE OR REPLACE VIEW cash_flow_analysis AS
SELECT
  DATE_TRUNC('month', transaction_date)::date as month,
  SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as inflow,
  SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as outflow,
  SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) as net_flow
FROM cash_flow_transactions
GROUP BY DATE_TRUNC('month', transaction_date)
ORDER BY month DESC;
```

### 8.5 Tenant Payment History View
```sql
CREATE OR REPLACE VIEW tenant_payment_history AS
SELECT
  t.id,
  t.name,
  t.phone,
  COUNT(i.id) as total_invoices,
  SUM(i.amount) as total_amount_invoiced,
  SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END) as total_paid,
  SUM(CASE WHEN i.status = 'pending' THEN i.amount ELSE 0 END) as total_pending,
  MAX(i.due_date) as last_due_date,
  CASE
    WHEN MAX(CASE WHEN i.status = 'pending' AND i.due_date < CURRENT_DATE THEN 1 ELSE 0 END) = 1 THEN 'Overdue'
    ELSE 'Current'
  END as payment_status
FROM tenants t
LEFT JOIN invoices i ON t.id = i.tenant_id
GROUP BY t.id, t.name, t.phone;
```

---

## 9. CHART LIBRARIES

### 9.1 Recharts (Recommended)
- **Cài đặt**: `npm install recharts`
- **Ưu điểm**:
  - React component-based
  - Responsive
  - Customizable
  - Good documentation
  - Animation support
- **Ví dụ - Revenue Line Chart**:
  ```tsx
  import { LineChart, Line, CartesianGrid, Tooltip, Legend } from 'recharts';

  const data = [
    { month: 'Jan', revenue: 30000000 },
    { month: 'Feb', revenue: 32000000 },
    { month: 'Mar', revenue: 35000000 },
    // ...
  ];

  export function RevenueChart() {
    return (
      <LineChart width={600} height={300} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <Tooltip formatter={(value) => `${value.toLocaleString()} ₫`} />
        <Legend />
        <Line type="monotone" dataKey="revenue" stroke="#3B82F6" />
      </LineChart>
    );
  }
  ```

### 9.2 Chart.js
- **Cài đặt**: `npm install chart.js react-chartjs-2`
- **Ưu điểm**:
  - Lightweight
  - Good for bar/pie charts
  - Large community
  - Many plugins
- **Ví dụ - Occupancy Pie Chart**:
  ```tsx
  import { Pie } from 'react-chartjs-2';

  export function OccupancyChart() {
    const data = {
      labels: ['Occupied', 'Vacant', 'Maintenance'],
      datasets: [{
        data: [118, 5, 2],
        backgroundColor: ['#10B981', '#EF4444', '#F59E0B']
      }]
    };

    return <Pie data={data} />;
  }
  ```

### 9.3 Visx (Visualization Components)
- **Cài đặt**: `npm install @visx/visx`
- **Ưu điểm**:
  - Low-level building blocks
  - Full customization
  - TypeScript support
  - Good for complex charts

### 9.4 ApexCharts
- **Cài đặt**: `npm install apexcharts react-apexcharts`
- **Ưu điểm**:
  - Rich interactive features
  - Built-in themes
  - Good for financial data
  - Time series support

---

## 10. TESTING CHECKLIST

### 10.1 Dashboard Component Tests
- [ ] Overview cards render with correct values
- [ ] Cards update in real-time (Supabase subscription)
- [ ] Cards show correct trend indicators (▲▼)
- [ ] Alerts section displays all 4 alert types
- [ ] Click alert takes to detail page
- [ ] Recent activities feed loads and updates
- [ ] Quick action buttons navigate correctly
- [ ] Real-time updates within 5 seconds

### 10.2 Chart Tests
- [ ] Revenue line chart displays 12 months
- [ ] Line chart tooltip shows correct value on hover
- [ ] Occupancy pie chart shows correct percentages
- [ ] Pie chart segments clickable (drill down)
- [ ] Debt bar chart displays horizontal bars
- [ ] Cash flow chart shows both bars and line
- [ ] Charts responsive on mobile/tablet
- [ ] Charts render without errors on empty data

### 10.3 Filter Tests
- [ ] Date range filters work correctly
- [ ] Quick select buttons (Today, This Month, etc)
- [ ] Custom date picker opens and selects dates
- [ ] Category filters (Apartment, Tenant, Status) work
- [ ] Multi-select filters allow multiple selections
- [ ] Filters persist in URL
- [ ] Export button respects selected filters
- [ ] Clear filters button resets all filters

### 10.4 Export Tests
- [ ] Export to Excel generates valid .xlsx file
- [ ] Excel file contains correct headers and data
- [ ] Excel file has proper formatting (colors, bold)
- [ ] Excel file contains multiple sheets (if applicable)
- [ ] Export to PDF generates valid .pdf file
- [ ] PDF includes header, footer, page numbers
- [ ] PDF renders charts/tables correctly
- [ ] Export to CSV generates valid .csv file
- [ ] CSV file can be opened in Excel/Sheets
- [ ] CSV file handles special characters correctly

### 10.5 Scheduled Reports Tests
- [ ] Create scheduled report with all fields
- [ ] Edit scheduled report
- [ ] Delete scheduled report
- [ ] Toggle scheduled report on/off
- [ ] Schedule test report manually
- [ ] Email received with correct format
- [ ] Email attachment is correct format
- [ ] Test cron job executes at correct time
- [ ] Reports generated with correct data
- [ ] Reports use correct filters

### 10.6 Performance Tests
- [ ] Dashboard loads in < 3 seconds
- [ ] Charts render in < 2 seconds
- [ ] Filters apply in < 1 second
- [ ] Export starts in < 2 seconds
- [ ] Real-time updates don't cause lag
- [ ] No memory leaks on dashboard
- [ ] Handles large datasets (1000+ records)
- [ ] Pagination works for large reports

### 10.7 User Acceptance Tests
- [ ] Dashboard intuitive and easy to use
- [ ] Data accuracy verified
- [ ] All reports include necessary information
- [ ] Export formats match user requirements
- [ ] Scheduled reports sent on time
- [ ] Alerts are actionable
- [ ] Mobile responsiveness acceptable
- [ ] Performance meets expectations

---

## TÓNG KẾT

Dashboard & Reporting System là backbone của hệ thống quản lý. Nó cung cấp:

1. **Real-time visibility** vào hoạt động kinh doanh
2. **19 báo cáo chuyên sâu** cho các quyết định chiến lược
3. **Tự động hóa** thông qua scheduled reports
4. **Dữ liệu có thể xử lý được** thông qua export formats
5. **Cảnh báo thông minh** để quản lý proactive

Hệ thống được thiết kế:
- **Scalable**: Có thể xử lý hàng ngàn phòng, hàng chục ngàn hợp đồng
- **Performant**: Real-time updates với latency < 5 giây
- **User-friendly**: Giao diện trực quan, dễ sử dụng
- **Reliable**: Backup data, error handling, logging
- **Secure**: Role-based access control, data encryption

---

**Phiên bản**: 1.0
**Ngày cập nhật**: 2024-11-18
**Tác giả**: iHome CRM Team
