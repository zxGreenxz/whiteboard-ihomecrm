# PHÂN TÍCH UI - PHÁT HIỆN THIẾU VÀ SAI LỆCH
## So sánh UI thực tế vs Tài liệu đã viết

---

## 📸 NGUỒN: UI Screenshots từ Resident Admin

Đã phân tích **8 ảnh UI**:
1. ✅ main-menu.png - Menu chính
2. ✅ khach-hang-menu.png - Menu Khách hàng
3. ✅ tai-chinh-menu.png - Menu Tài chính
4. ✅ bao-cao-bds-menu.png - Menu Báo cáo BĐS
5. ✅ bao-cao-tai-chinh-menu.png - Menu Báo cáo Tài chính
6. ✅ danh-muc-khac-menu.png - Menu Danh mục khác
7. ✅ mau-bieu-menu.png - Menu Mẫu biểu
8. ✅ nhan-vien-menu.png - Menu Nhân viên

---

## 🗂️ CẤU TRÚC MENU THỰC TẾ (Từ UI)

### MAIN NAVIGATION

```
┌─────────────────────────────────────────┐
│ RESIDENT                                 │
├─────────────────────────────────────────┤
│ 📊 Sơ đồ căn hộ                         │
│                                          │
│ VẬN HÀNH                                 │
│ ├─ 📋 Danh mục dữ liệu          ▼       │
│ │  ├─ Khu vực                  ⚠️ MỚI  │
│ │  ├─ Tòa nhà                           │
│ │  ├─ Căn hộ                            │
│ │  ├─ Giường                            │
│ │  ├─ Dịch vụ                           │
│ │  └─ Tài sản                           │
│ │                                        │
│ ├─ 👥 Khách hàng                ▼       │
│ │  ├─ Khách hẹn                         │
│ │  ├─ Đặt cọc                           │
│ │  ├─ Hợp đồng                          │
│ │  ├─ Khách hàng                        │
│ │  └─ Phương tiện                       │
│ │                                        │
│ ├─ 💰 Tài chính                 ▼       │
│ │  ├─ Ghi chỉ số                        │
│ │  ├─ Hóa đơn                           │
│ │  └─ Thu chi                           │
│ │                                        │
│ ├─ 🔔 Thông báo                         │
│ └─ 🛠️ Công việc               [2]       │
│                                          │
│ BÁO CÁO                                  │
│ ├─ 📈 Báo cáo bất động sản      ▼       │
│ │  ├─ Căn hộ trống                      │
│ │  ├─ Căn hộ sắp trống                  │
│ │  ├─ Phòng gia hạn, chuyển nhượng     │
│ │  ├─ Tỷ lệ lấp đầy (cũ)      ⚠️ MỚI  │
│ │  ├─ Tỷ lệ lấp đầy (mới)     ⚠️ MỚI  │
│ │  ├─ Báo cáo khuyến mại                │
│ │  ├─ Báo cáo cho thuê                  │
│ │  └─ Báo cáo bỏ trả                    │
│ │                                        │
│ └─ 💵 Báo cáo tài chính         ▼       │
│    ├─ Sổ quỹ theo ngày                  │
│    ├─ Dòng tiền                          │
│    ├─ Phân bổ lợi nhuận                 │
│    ├─ Công nợ hợp đồng mới              │
│    ├─ Khách nợ tiền                      │
│    ├─ Lịch thanh toán                    │
│    ├─ Tiền thừa                          │
│    └─ Danh sách tiền cọc                │
│                                          │
│ CÀI ĐẶT                                  │
│ ├─ ⚙️ Cài đặt chung                     │
│ ├─ 📑 Danh mục khác             ▼       │
│ │  ├─ Tài chính               ▼         │
│ │  ├─ Tài sản                 ▼         │
│ │  └─ Quản lý hotline                   │
│ │                                        │
│ ├─ 📄 Mẫu biểu                  ▼       │
│ │  ├─ Mẫu chữ ký              ⚠️ MỚI  │
│ │  ├─ Hợp đồng đặt cọc        ⚠️ MỚI  │
│ │  ├─ Hợp đồng thuê                     │
│ │  ├─ Biên bản bàn giao                 │
│ │  ├─ Mẫu hóa đơn                       │
│ │  └─ Mẫu thu chi                       │
│ │                                        │
│ └─ 👤 Nhân viên                 ▼       │
│    ├─ Loại tài khoản          ⚠️ MỚI  │
│    └─ Người dùng                        │
└─────────────────────────────────────────┘

⚠️ = Phát hiện mới, chưa có trong docs
```

---

## ❌ CÁC PHẦN THIẾU HOÀN TOÀN

### 1. **KHU VỰC (Areas/Zones)** - THIẾU 100%

**Phát hiện từ UI:**
```
Danh mục dữ liệu > Khu vực
```

**Vấn đề:**
- Tài liệu hiện tại bắt đầu từ **Building** (Tòa nhà)
- UI thực tế có **Khu vực** cao hơn Building
- Cấu trúc đúng phải là: **Khu vực → Tòa nhà → Phòng → Giường**

**Cần bổ sung:**
```
Hierarchy:
├─ Khu vực (Area/Zone)
│  ├─ Mô tả: Nhóm nhiều tòa nhà (VD: Khu A, Khu B, Quận 1, TP.HCM)
│  ├─ Fields:
│  │  ├─ Tên khu vực *
│  │  ├─ Mã khu vực
│  │  ├─ Mô tả
│  │  └─ Trạng thái (Active/Inactive)
│  │
│  └─ Use cases:
│     ├─ Quản lý nhiều tòa nhà phân tán ở nhiều khu vực
│     ├─ Phân quyền nhân viên theo khu vực
│     ├─ Báo cáo theo khu vực
│     └─ Lọc dữ liệu theo khu vực

Database:
CREATE TABLE areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  status TEXT DEFAULT 'ACTIVE',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Update buildings table
ALTER TABLE buildings ADD COLUMN area_id UUID REFERENCES areas(id);
```

---

### 2. **MẪU CHỮ KÝ (Signature Templates)** - THIẾU

**Phát hiện từ UI:**
```
Mẫu biểu > Mẫu chữ ký
```

**Vấn đề:**
- Tôi chỉ đề cập "Signature Pad" trong Asset Handover
- Không có Template quản lý riêng cho chữ ký

**Cần bổ sung:**
```
Signature Templates:
├─ Upload mẫu chữ ký (Landlord, Tenant, Witness)
├─ Sử dụng trong:
│  ├─ Hợp đồng thuê
│  ├─ Hợp đồng đặt cọc
│  ├─ Biên bản bàn giao
│  └─ Phiếu thu chi
│
└─ Features:
   ├─ Upload signature image (PNG, JPG)
   ├─ Draw signature (Canvas)
   ├─ Type signature (Auto-generated from name)
   └─ Multiple signatures per user (Chính, Phụ)

Database:
CREATE TABLE signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  name TEXT NOT NULL, -- "Chữ ký chính", "Chữ ký phụ"
  type TEXT NOT NULL, -- LANDLORD, TENANT, WITNESS
  signature_image_url TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 3. **HỢP ĐỒNG ĐẶT CỌC (Deposit Contract)** - THIẾU

**Phát hiện từ UI:**
```
Mẫu biểu > Hợp đồng đặt cọc
```

**Vấn đề:**
- Tôi viết về Deposit Management
- Nhưng chưa viết về **Template cho Hợp đồng đặt cọc**
- Đây là document riêng, khác với Hợp đồng thuê

**Cần bổ sung:**
```
Deposit Contract Template:
├─ Mục đích: Giấy tờ cam kết khi khách đặt cọc
├─ Khác với Lease Contract:
│  ├─ Ngắn hơn, đơn giản hơn
│  ├─ Chỉ cam kết giữ phòng, chưa ký thuê
│  └─ Quy định về mất cọc/hoàn cọc
│
├─ Nội dung:
│  ├─ Thông tin khách đặt cọc
│  ├─ Phòng đặt cọc
│  ├─ Số tiền đặt cọc
│  ├─ Ngày đặt cọc
│  ├─ Hạn giữ phòng (hold_until)
│  ├─ Điều kiện hoàn cọc
│  ├─ Điều kiện mất cọc
│  └─ Chữ ký 2 bên
│
└─ Template variables:
   {deposit_amount}, {hold_until}, {room_name},
   {tenant_name}, {deposit_date}, {refund_condition}
```

---

### 4. **LOẠI TÀI KHOẢN (Account Types)** - THIẾU

**Phát hiện từ UI:**
```
Nhân viên > Loại tài khoản
```

**Vấn đề:**
- Tôi viết về **Roles** (Admin, Manager, Staff...)
- Nhưng UI có thêm **Loại tài khoản** riêng
- Cần làm rõ sự khác biệt

**Câu hỏi cần làm rõ:**
```
❓ "Loại tài khoản" vs "Roles" khác nhau như thế nào?

Có thể:
1. Loại tài khoản = Account tier (Free, Basic, Pro, Enterprise)
   - Xác định gói dịch vụ
   - Giới hạn features
   - Giới hạn số lượng (buildings, rooms, users...)

2. Roles = Vai trò trong hệ thống
   - Xác định quyền hạn (Permissions)
   - Admin, Manager, Staff...

Hoặc:
3. Loại tài khoản = User type (Chủ nhà, Nhân viên, Kế toán...)
   - Phân loại người dùng
   - Giao diện khác nhau

🙏 CẦN BẠN XÁC NHẬN!
```

---

### 5. **TỶ LỆ LẤP ĐẦY (Cũ) vs (Mới)** - THIẾU PHÂN BIỆT

**Phát hiện từ UI:**
```
Báo cáo BĐS:
├─ Tỷ lệ lấp đầy (cũ)
└─ Tỷ lệ lấp đầy (mới)
```

**Vấn đề:**
- Tài liệu chỉ viết 1 loại "Occupancy Rate"
- UI có 2 phiên bản: Cũ và Mới
- Không rõ sự khác biệt

**Câu hỏi cần làm rõ:**
```
❓ Sự khác biệt giữa "Tỷ lệ lấp đầy (cũ)" và "(mới)"?

Có thể:
1. Cách tính khác:
   - Cũ: Phòng đang thuê / Tổng phòng
   - Mới: (Phòng thuê + Phòng đặt cọc) / Tổng phòng

2. Giao diện khác:
   - Cũ: Bảng đơn giản
   - Mới: Charts, graphs, drill-down

3. Dữ liệu khác:
   - Cũ: Chỉ hiện tại
   - Mới: Theo thời gian (trend)

🙏 CẦN BẠN XÁC NHẬN!
```

---

## ⚠️ CÁC PHẦN CẦN LÀM RÕ HƠN

### 1. **SƠ ĐỒ CĂN HỘ** - Cần chi tiết hơn

**Hiện tại:**
- Tôi viết "Building Map Visualization" trong 09-SETTINGS-ADVANCED.md
- Nhưng UI có menu riêng "Sơ đồ căn hộ" ở top level

**Cần làm rõ:**
```
❓ "Sơ đồ căn hộ" là trang riêng hay submenu?

Nếu là trang riêng:
- Nên có file docs riêng: 10-BUILDING-MAP.md
- Flow chi tiết hơn
- Interactive features
- Real-time status updates

Nếu là submenu:
- Giữ nguyên trong 09-SETTINGS-ADVANCED.md
- Nhưng cần move lên phần đầu (không phải Settings)

🙏 CẦN BẠN XÁC NHẬN!
```

---

### 2. **BIÊN BẢN BÀN GIAO** - Template cần riêng

**Hiện tại:**
- Tôi viết logic trong 07-ASSET-ISSUES-MANAGEMENT.md
- Nhưng chưa viết Template riêng

**Cần bổ sung:**
```
Handover Document Template:
├─ 2 loại:
│  ├─ Biên bản bàn giao khi nhận phòng (Check-in)
│  └─ Biên bản bàn giao khi trả phòng (Check-out)
│
├─ Nội dung:
│  ├─ Thông tin hợp đồng
│  ├─ Danh sách tài sản (Bảng chi tiết)
│  │  ├─ STT, Tên tài sản, Số lượng, Tình trạng, Ghi chú
│  │  └─ Example: "1 | Giường ngủ | 1 | Tốt | -"
│  ├─ Chỉ số điện/nước đầu/cuối
│  ├─ Ghi chú
│  └─ Chữ ký (Chủ nhà, Khách thuê, Người chứng kiến)
│
└─ Features:
   ├─ Auto-fill từ asset list
   ├─ Photo upload (before/after)
   ├─ Digital signature
   ├─ Print PDF
   └─ Email to tenant
```

---

### 3. **DANH MỤC KHÁC - Submenu chưa rõ**

**Hiện tại:**
- Tôi viết các submenu trong 09-SETTINGS-ADVANCED.md
- Nhưng UI chỉ hiện "Tài chính ▼" và "Tài sản ▼"

**Cần làm rõ:**
```
❓ Trong "Danh mục khác > Tài chính" có gì?
❓ Trong "Danh mục khác > Tài sản" có gì?

Theo docs.resident.vn đã đọc:
Tài chính:
├─ Tài khoản ngân hàng
├─ Tự động ghi nhận công nợ
├─ Hóa đơn điện tử
├─ Loại giao dịch
├─ Tiêu chuẩn dịch vụ
└─ Quản lý công tơ

Tài sản:
├─ Nhà cung cấp
├─ Kho tài sản
├─ Loại tài sản
└─ Lịch sử di chuyển/sửa chữa

Nhưng cần screenshots chi tiết để confirm!
🙏 CẦN SCREENSHOTS SUBMENU!
```

---

## ✅ CÁC PHẦN ĐÃ ĐÚNG

### So sánh UI vs Docs

| Tính năng | UI | Docs | Status |
|-----------|----|----- |--------|
| Tòa nhà | ✅ | ✅ 03-ASSET-MANAGEMENT.md | ✅ Match |
| Căn hộ | ✅ | ✅ 03-ASSET-MANAGEMENT.md | ✅ Match |
| Giường | ✅ | ✅ 03-ASSET-MANAGEMENT.md | ✅ Match |
| Dịch vụ | ✅ | ✅ 03-ASSET-MANAGEMENT.md | ✅ Match |
| Tài sản | ✅ | ✅ 07-ASSET-ISSUES-MANAGEMENT.md | ✅ Match |
| Khách hẹn | ✅ | ✅ 04-LEAD-DEPOSIT-FLOW.md | ✅ Match |
| Đặt cọc | ✅ | ✅ 04-LEAD-DEPOSIT-FLOW.md | ✅ Match |
| Hợp đồng | ✅ | ✅ 05-LEASING-FLOW.md | ✅ Match |
| Khách hàng | ✅ | ✅ 05-LEASING-FLOW.md | ✅ Match |
| Phương tiện | ✅ | ✅ 07-ASSET-ISSUES-MANAGEMENT.md | ✅ Match |
| Ghi chỉ số | ✅ | ✅ 06-BILLING-FLOW.md | ✅ Match |
| Hóa đơn | ✅ | ✅ 06-BILLING-FLOW.md | ✅ Match |
| Thu chi | ✅ | ✅ 06-BILLING-FLOW.md | ✅ Match |
| Thông báo | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |
| Công việc | ✅ | ✅ 07-ASSET-ISSUES-MANAGEMENT.md | ✅ Match |
| 8 Báo cáo BĐS | ✅ | ✅ 08-DASHBOARD-REPORTS.md | ✅ Match |
| 8 Báo cáo TC | ✅ | ✅ 08-DASHBOARD-REPORTS.md | ✅ Match |
| Cài đặt chung | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |
| Hợp đồng thuê | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |
| Mẫu hóa đơn | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |
| Mẫu thu chi | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |
| Người dùng | ✅ | ✅ 09-SETTINGS-ADVANCED.md | ✅ Match |

**Kết quả:** 22/27 tính năng matched (81%)

---

## 📝 TÓM TẮT CẦN BỔ SUNG

### 1. Tính năng thiếu hoàn toàn (5 items)
- ❌ Khu vực (Areas/Zones)
- ❌ Mẫu chữ ký (Signature Templates)
- ❌ Hợp đồng đặt cọc (Deposit Contract Template)
- ❌ Loại tài khoản (Account Types)
- ❌ Tỷ lệ lấp đầy (Cũ) vs (Mới)

### 2. Cần làm rõ hơn (3 items)
- ⚠️ Sơ đồ căn hộ (cấu trúc menu)
- ⚠️ Biên bản bàn giao (template riêng)
- ⚠️ Danh mục khác submenu chi tiết

### 3. Cần screenshots bổ sung
- 📸 Submenu "Tài chính" trong Danh mục khác
- 📸 Submenu "Tài sản" trong Danh mục khác
- 📸 Màn hình "Sơ đồ căn hộ"
- 📸 Form tạo "Khu vực"
- 📸 Mẫu "Hợp đồng đặt cọc"
- 📸 Màn hình "Loại tài khoản"
- 📸 So sánh 2 màn hình "Tỷ lệ lấp đầy"

---

## 🎯 HÀNH ĐỘNG TIẾP THEO

### Bước 1: Xác nhận với bạn
Tôi cần bạn xác nhận/làm rõ:
1. ❓ "Loại tài khoản" khác "Roles" như thế nào?
2. ❓ "Tỷ lệ lấp đầy (cũ)" vs "(mới)" khác nhau gì?
3. ❓ "Sơ đồ căn hộ" là trang riêng hay submenu?
4. ❓ Có thể cung cấp thêm screenshots không?

### Bước 2: Tạo docs bổ sung
Sau khi có câu trả lời, tôi sẽ:
- ✅ Tạo file mới về Khu vực (Areas)
- ✅ Bổ sung Templates section
- ✅ Update 03-ASSET-MANAGEMENT.md (thêm Areas)
- ✅ Update 09-SETTINGS-ADVANCED.md (Templates)
- ✅ Update 08-DASHBOARD-REPORTS.md (2 loại tỷ lệ lấp đầy)
- ✅ Update README.md với cấu trúc menu chính xác

### Bước 3: Cập nhật Database Schema
- ✅ Thêm bảng `areas`
- ✅ Thêm bảng `signature_templates`
- ✅ Thêm bảng `account_types` (nếu cần)
- ✅ Update relationship diagrams

---

**Tạo bởi**: AI Agent
**Ngày**: 2025-11-18
**Mục đích**: Phân tích UI để tìm phần thiếu và sai lệch
**Status**: ⏳ CHỜ XÁC NHẬN TỪ USER
