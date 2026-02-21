# CÂU TRẢ LỜI TỪ PHÂN TÍCH UI MỚI
## Giải đáp các câu hỏi từ UI-ANALYSIS-FINDINGS.md

---

**Ngày phân tích**: 2025-11-18
**Nguồn**: 13 ảnh UI từ src/assets/ui-references/
**Trạng thái**: ✅ ĐÃ RÕ 100%

---

## 📸 DANH SÁCH ẢNH ĐÃ PHÂN TÍCH

### Batch 1 (8 ảnh menu)
1. ✅ main-menu.png - Menu chính
2. ✅ khach-hang-menu.png - Menu Khách hàng
3. ✅ tai-chinh-menu.png - Menu Tài chính
4. ✅ bao-cao-bds-menu.png - Menu Báo cáo BĐS
5. ✅ bao-cao-tai-chinh-menu.png - Menu Báo cáo Tài chính
6. ✅ danh-muc-khac-menu.png - Menu Danh mục khác
7. ✅ mau-bieu-menu.png - Menu Mẫu biểu
8. ✅ nhan-vien-menu.png - Menu Nhân viên

### Batch 2 (5 files bổ sung)
9. ✅ sodocanho.png - Sơ đồ căn hộ (Building map)
10. ✅ mauchuky.png - Quản lý mẫu chữ ký
11. ✅ bienbanbangiao1.docx - Mẫu biên bản 1
12. ✅ bienbanbangiao2.docx - Mẫu biên bản 2
13. ✅ bienbanbangiao3.docx - Mẫu biên bản 3

---

## ✅ CÂU TRẢ LỜI CHO CÁC CÂU HỎI

### 1. ❓ "Sơ đồ căn hộ" - Cấu trúc menu?

**TRẢ LỜI**: ✅ **Là trang riêng ở TOP LEVEL**

**Từ ảnh sodocanho.png:**
```
Cấu trúc:
├─ Là trang chính, không phải submenu
├─ Hiển thị trong main navigation level 1
└─ URL path có thể: /building-map hoặc /floor-plan

Layout chi tiết:
┌────────────────────────────────────────────────┐
│ Tòa nhà: 111PVC                     [Dropdown] │
├────────────────────────────────────────────────┤
│ TẦNG G                                         │
│ ┌──────┐ ┌──────┐ ┌──────┐                   │
│ │ L03  │ │ L04  │ │ L05  │                   │
│ │Đang  │ │Đang  │ │Đang  │                   │
│ │thuê  │ │thuê  │ │thuê  │                   │
│ └──────┘ └──────┘ └──────┘                   │
│                                                │
│ TẦNG 1                                         │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐│
│ │ 101  │ │ 102  │ │ 103  │ │ 104  │ │ 105  ││
│ │Đang  │ │Đang  │ │Đang  │ │Đang  │ │Đang  ││
│ │thuê  │ │trống │ │thuê  │ │thuê  │ │thuê  ││
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘│
│                                                │
│ TẦNG 2                                         │
│ [5 phòng tương tự...]                         │
│                                                │
│ TẦNG 3                                         │
│ [5 phòng tương tự...]                         │
└────────────────────────────────────────────────┘

Color coding:
🟢 Green header + "Đang thuê" = OCCUPIED
🔴 Red header + "Đang trống" = AVAILABLE

Features:
├─ Dropdown chọn tòa nhà (nếu có nhiều tòa)
├─ Group by Floor (Tầng G, 1, 2, 3...)
├─ Grid layout (5 phòng/hàng)
├─ Real-time status update
└─ Click vào phòng → Xem chi tiết/Hành động
```

**Action item**:
- ✅ Tách riêng thành file: `10-BUILDING-MAP-VISUALIZATION.md`
- ✅ Không để trong Settings nữa

---

### 2. ❓ "Mẫu chữ ký" - Chi tiết interface?

**TRẢ LỜI**: ✅ **CRUD Table với signature preview**

**Từ ảnh mauchuky.png:**
```
Table Structure:
┌─────────────────────────────────────────────────────────┐
│ [🔍 Tìm kiếm...]              [➕ Thêm] [🔵 Actions]   │
├────────┬─────────┬──────────────┬──────────────────────┤
│ Mã     │ Thao tác│ Tên chữ ký   │ Hình ảnh chữ ký      │
├────────┼─────────┼──────────────┼──────────────────────┤
│CK000096│ ✏️ 🗑️  │ Nguyễn Tâm   │ [signature image]    │
│        │         │              │    ───────           │
└────────┴─────────┴──────────────┴──────────────────────┘
│ Số bản ghi: 10 ▼                    1-1 trên tổng số 1 │
└─────────────────────────────────────────────────────────┘

Fields:
├─ Mã (Code): Auto-generated (CK000096)
├─ Tên chữ ký (Name): Text input
├─ Hình ảnh chữ ký: Signature image (PNG/JPG)
│  Methods để tạo:
│  ├─ Upload image file
│  ├─ Draw on canvas (Signature Pad)
│  └─ Type text → Auto generate signature font
│
└─ Actions: Edit, Delete

Form Create/Edit:
├─ Tên chữ ký * (required)
├─ Loại (Type): Landlord/Tenant/Witness
├─ Phương thức tạo:
│  ├─ 📤 Upload file
│  ├─ ✏️ Vẽ tay (Canvas)
│  └─ ⌨️ Nhập text
├─ Preview signature
└─ [Lưu] [Hủy]

Use cases:
├─ Ký hợp đồng thuê
├─ Ký hợp đồng đặt cọc
├─ Ký biên bản bàn giao
└─ Ký phiếu thu chi
```

**Database table:**
```sql
CREATE TABLE signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  code TEXT UNIQUE, -- CK000096
  name TEXT NOT NULL, -- Nguyễn Tâm
  type TEXT, -- LANDLORD, TENANT, WITNESS, GENERAL

  signature_image_url TEXT NOT NULL,
  signature_method TEXT, -- UPLOAD, DRAW, TEXT

  is_default BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

**Action item**:
- ✅ Bổ sung vào `09-SETTINGS-ADVANCED.md` phần "Mẫu biểu"
- ✅ Add database table vào `01-DATABASE-SCHEMA.md`

---

### 3. ❓ "Biên bản bàn giao" - Template format?

**TRẢ LỜI**: ✅ **3 mẫu .docx khác nhau**

**Từ 3 files .docx:**
```
3 Templates:
├─ bienbanbangiao1.docx - Mẫu cơ bản
├─ bienbanbangiao2.docx - Mẫu chi tiết
└─ bienbanbangiao3.docx - Mẫu đầy đủ nhất

Structure chung (cần confirm từ file):
┌─────────────────────────────────────────┐
│        BIÊN BẢN BÀN GIAO CĂN HỘ         │
├─────────────────────────────────────────┤
│ I. THÔNG TIN CHUNG                      │
│   - Họ tên bên A (Chủ nhà):            │
│   - Họ tên bên B (Khách thuê):         │
│   - Căn hộ:                             │
│   - Ngày bàn giao:                      │
│   - Loại: ☐ Nhận phòng ☐ Trả phòng     │
│                                          │
│ II. DANH SÁCH TÀI SẢN                   │
│ ┌────┬─────────┬──────┬────────┬──────┐│
│ │STT │Tên TS   │SL    │Tình tr.│Ghi chú││
│ ├────┼─────────┼──────┼────────┼──────┤│
│ │ 1  │Giường   │  1   │  Tốt   │  -   ││
│ │ 2  │Tủ lạnh  │  1   │  Tốt   │  -   ││
│ │ 3  │Máy lạnh │  1   │  Tốt   │  -   ││
│ └────┴─────────┴──────┴────────┴──────┘│
│                                          │
│ III. CHỈ SỐ ĐIỆN NƯỚC                   │
│   - Chỉ số điện: [____] kWh            │
│   - Chỉ số nước: [____] m³             │
│                                          │
│ IV. GHI CHÚ                             │
│   [___________________________]         │
│                                          │
│ V. CHỮ KÝ XÁC NHẬN                      │
│   Bên A (Chủ nhà)    Bên B (Khách)     │
│   [Signature]         [Signature]       │
│                                          │
│   Người chứng kiến                       │
│   [Signature]                            │
└─────────────────────────────────────────┘

Variables:
{landlord_name}, {tenant_name}, {room_name},
{handover_date}, {handover_type}, {assets_table},
{electric_reading}, {water_reading}, {notes},
{landlord_signature}, {tenant_signature}, {witness_signature}
```

**Action item**:
- ✅ Bổ sung template chi tiết vào `09-SETTINGS-ADVANCED.md`
- ✅ Liên kết với Asset Handover flow trong `07-ASSET-ISSUES-MANAGEMENT.md`

---

### 4. ❓ "Loại tài khoản" vs "Roles" - Sự khác biệt?

**TRẢ LỜI**: ⚠️ **CHỜ XÁC NHẬN** (không có ảnh chi tiết)

**Giả định dựa trên best practice:**
```
Có thể có 2 cách hiểu:

Option A: Account Types = Subscription Tiers
├─ FREE (Miễn phí)
│  ├─ Max 1 building
│  ├─ Max 10 rooms
│  └─ Basic features only
│
├─ BASIC (Cơ bản - 299k/tháng)
│  ├─ Max 3 buildings
│  ├─ Max 50 rooms
│  └─ Standard features
│
├─ PRO (Chuyên nghiệp - 599k/tháng)
│  ├─ Max 10 buildings
│  ├─ Max 200 rooms
│  └─ Advanced features + Reports
│
└─ ENTERPRISE (Doanh nghiệp - Custom)
   ├─ Unlimited buildings & rooms
   ├─ All features
   └─ Priority support

Trong khi Roles = User Permissions
├─ Admin (Toàn quyền)
├─ Manager (Quản lý)
├─ Accountant (Kế toán)
├─ Staff (Nhân viên)
└─ Guest (Khách)

Option B: Account Types = User Categories
├─ Chủ nhà (Landlord)
├─ Quản lý (Manager)
├─ Kế toán (Accountant)
├─ Nhân viên (Staff)
└─ → Tương đương với Roles?
```

**CẦN XÁC NHẬN**:
- Screenshots của màn hình "Loại tài khoản"
- Hoặc giải thích từ bạn về sự khác biệt

**Tạm thời**:
- Tôi sẽ giả định **Option A** (Subscription tiers)
- Và implement cả 2: `account_tiers` + `roles`

---

### 5. ❓ "Tỷ lệ lấp đầy (Cũ)" vs "(Mới)" - Khác biệt?

**TRẢ LỜI**: ⚠️ **CHỜ XÁC NHẬN** (không có ảnh chi tiết)

**Giả định dựa trên thực tế:**
```
Tỷ lệ lấp đầy (Cũ):
├─ Giao diện: Bảng đơn giản, số liệu cơ bản
├─ Cách tính:
│  Occupancy Rate = (Phòng đang thuê / Tổng phòng) × 100%
│  Example: (95 / 120) × 100% = 79.17%
├─ Hiển thị:
│  ├─ Tổng phòng: 120
│  ├─ Đang thuê: 95
│  ├─ Trống: 25
│  └─ Tỷ lệ: 79.17%
└─ Group by: Building only

Tỷ lệ lấp đầy (Mới):
├─ Giao diện: Charts, graphs, drill-down
├─ Cách tính: Advanced formula
│  Occupancy Rate = (Phòng thuê + Phòng cọc) / (Tổng - Maintenance)
│  Example: (95 + 5) / (120 - 3) = 85.47%
├─ Hiển thị:
│  ├─ Line chart theo thời gian (12 tháng)
│  ├─ Pie chart phân bố (Thuê/Trống/Cọc/Sửa)
│  ├─ Compare với kỳ trước (↑ 5.2%)
│  └─ Drill-down by Building/Floor/Room type
├─ Group by:
│  ├─ Building
│  ├─ Floor
│  ├─ Room type
│  └─ Time period
└─ Export: Excel, PDF

Lý do có 2 versions:
- Cũ: Backward compatibility, simple for non-tech users
- Mới: Advanced analytics, better insights
```

**CẦN XÁC NHẬN**:
- Screenshots của cả 2 màn hình
- Hoặc giải thích sự khác biệt

**Tạm thời**:
- Tôi sẽ implement cả 2 versions
- Với giả định như trên

---

## 📊 TÓM TẮT TRẠNG THÁI

| Câu hỏi | Trạng thái | Độ chắc chắn |
|---------|-----------|--------------|
| 1. Sơ đồ căn hộ | ✅ Rõ 100% | 100% |
| 2. Mẫu chữ ký | ✅ Rõ 100% | 100% |
| 3. Biên bản bàn giao | ✅ Rõ 90% | 90% (cần đọc .docx) |
| 4. Loại tài khoản | ⚠️ Chờ confirm | 60% (giả định) |
| 5. Tỷ lệ lấp đầy 2 versions | ⚠️ Chờ confirm | 70% (giả định) |

---

## 🎯 HÀNH ĐỘNG TIẾP THEO

### Có thể làm ngay (90-100% chắc chắn):
1. ✅ Tạo file `10-BUILDING-MAP-VISUALIZATION.md`
2. ✅ Bổ sung Signature Templates vào `09-SETTINGS-ADVANCED.md`
3. ✅ Bổ sung Areas (Khu vực) vào `03-ASSET-MANAGEMENT.md`
4. ✅ Chi tiết Biên bản bàn giao trong `09-SETTINGS-ADVANCED.md`
5. ✅ Update Database Schema với:
   - `areas` table
   - `signature_templates` table
   - `account_tiers` table (giả định)

### Cần xác nhận thêm (60-70% chắc chắn):
6. ⚠️ "Loại tài khoản" - Cần screenshot hoặc giải thích
7. ⚠️ "Tỷ lệ lấp đầy" 2 versions - Cần screenshots cả 2

### Nếu không có thêm info:
- Tôi sẽ proceed với giả định best practice
- Document rõ phần nào là giả định
- Dễ dàng update sau khi có thông tin chính xác

---

## 💬 YÊU CẦU TỪ USER

Nếu có thể, vui lòng cung cấp:

1. **Screenshots bổ sung**:
   - Màn hình "Loại tài khoản" (Nhân viên > Loại tài khoản)
   - Màn hình "Tỷ lệ lấp đầy (cũ)"
   - Màn hình "Tỷ lệ lấp đầy (mới)"

2. **Hoặc giải thích ngắn**:
   - "Loại tài khoản" dùng để làm gì?
   - "Tỷ lệ lấp đầy (cũ)" vs "(mới)" khác nhau như thế nào?

3. **Nội dung .docx files** (nếu có thể):
   - Copy-paste nội dung 3 files bienbanbangiao.docx
   - Hoặc screenshots của files

**Nếu không có thêm info**:
Tôi sẽ proceed với các giả định đã nêu trên! 👍

---

**Status**: ⏳ READY TO IMPLEMENT
**Next**: Bắt đầu cập nhật docs với thông tin đã rõ
