# UI References - CRM

Tài liệu này chứa các ảnh tham khảo về giao diện người dùng (UI) của hệ thống CRM.

## Mục đích

Các ảnh UI reference này được sử dụng để:
- Tham khảo thiết kế giao diện khi phát triển
- Hiểu rõ cấu trúc menu và navigation của hệ thống
- Đảm bảo tính nhất quán trong thiết kế
- Làm tài liệu cho team phát triển

## Vị trí lưu trữ

### Local (GitHub)
Tất cả ảnh được lưu trong thư mục: `src/assets/ui-references/`

### Supabase Storage
Bucket: `ui-references` (Public bucket)
- **Public Read**: Mọi người có thể xem
- **Authenticated Upload**: Chỉ user đã đăng nhập mới upload được
- **Owner Delete**: Chỉ người upload mới xóa được

## Danh sách ảnh UI Reference

### 1. Main Menu (main-menu.png)
Menu chính của hệ thống với các module:
- Khách hàng
- Tài chính
- Báo cáo
- Danh mục
- Cài đặt

### 2. Khách Hàng Menu (khach-hang-menu.png)
Module quản lý khách hàng bao gồm:
- Khách hàng tiềm năng
- Hợp đồng thuê
- Thanh toán
- Quản lý cư dân

### 3. Tài Chính Menu (tai-chinh-menu.png)
Module quản lý tài chính:
- Thu chi
- Công nợ
- Hóa đơn
- Báo cáo tài chính

### 4. Báo Cáo BĐS Menu (bao-cao-bds-menu.png)
Báo cáo về bất động sản:
- Tình hình phòng
- Doanh thu
- Công suất sử dụng

### 5. Báo Cáo Tài Chính Menu (bao-cao-tai-chinh-menu.png)
Các báo cáo tài chính chi tiết:
- Doanh thu theo kỳ
- Chi phí vận hành
- Lợi nhuận

### 6. Danh Mục Khác Menu (danh-muc-khac-menu.png)
Các danh mục hệ thống:
- Tòa nhà
- Phòng
- Dịch vụ
- Loại phòng

### 7. Mẫu Biểu Menu (mau-bieu-menu.png)
Quản lý mẫu biểu và báo cáo:
- Template hợp đồng
- Biểu mẫu
- Tài liệu

### 8. Nhân Viên Menu (nhan-vien-menu.png)
Quản lý nhân viên:
- Danh sách nhân viên
- Phân quyền
- Chấm công

### 9. Sơ Đồ Căn Hộ (sodocanho.png)
Giao diện sơ đồ tòa nhà và căn hộ:
- Hiển thị theo tầng (Tầng G, Tầng 1, 2, 3...)
- Trạng thái căn hộ (Đang thuê, Đang trống)
- Mã căn hộ (101, 102, 103...)
- Màu sắc phân biệt trạng thái
  - Xanh lá: Đang thuê
  - Đỏ: Đang trống

**Tài liệu chi tiết**: Xem [09-SETTINGS-ADVANCED.md - Section 7: Building Map Visualization](./09-SETTINGS-ADVANCED.md#7-building-map-visualization)

### 10. Mẫu Chữ Ký (mauchuky.png)
Giao diện quản lý mẫu chữ ký:
- Danh sách mẫu chữ ký với tìm kiếm
- Cột Mã (ID chữ ký)
- Cột Thao tác (Edit/Delete buttons)
- Cột Tên chủ ký
- Cột Hình ảnh chữ ký (hiển thị ảnh chữ ký)
- Phân trang với số bản ghi hiển thị

**Tài liệu chi tiết**: Xem [09-SETTINGS-ADVANCED.md - Section 2.5: Signature Templates](./09-SETTINGS-ADVANCED.md#25-mẫu-chữ-ký-signature-templates)

### 11. Biên Bản Bàn Giao (bienbanbangiao1.docx, bienbanbangiao2.docx, bienbanbangiao3.docx)
Mẫu biên bản bàn giao căn hộ (Word documents):
- 3 phiên bản mẫu biên bản bàn giao
- Sử dụng làm template khi tạo biên bản bàn giao căn hộ cho khách thuê

**Tài liệu chi tiết**: Xem [UI-ANALYSIS-ANSWERS.md](./UI-ANALYSIS-ANSWERS.md#3-biên-bản-bàn-giao-handover-documents)

## Cấu trúc Menu Tổng Quan

```
CRM
├── 🏠 Trang chủ (Dashboard)
├── 👥 Khách hàng
│   ├── Khách hàng tiềm năng
│   ├── Hợp đồng thuê
│   ├── Thanh toán
│   └── Quản lý cư dân
├── 💰 Tài chính
│   ├── Thu chi
│   ├── Công nợ
│   ├── Hóa đơn
│   └── Báo cáo tài chính
├── 📊 Báo cáo
│   ├── Báo cáo BĐS
│   └── Báo cáo tài chính
├── 📁 Danh mục
│   ├── Tòa nhà
│   ├── Phòng
│   ├── Dịch vụ
│   └── Mẫu biểu
└── ⚙️ Cài đặt
    ├── Nhân viên
    ├── Phân quyền
    └── Cấu hình hệ thống
```

## Sử dụng trong Code

### Import ảnh local
```typescript
import mainMenu from "@/assets/ui-references/main-menu.png";
import khachHangMenu from "@/assets/ui-references/khach-hang-menu.png";
```

### Upload lên Supabase Storage
```typescript
import { uploadFile, getPublicUrl } from "@/lib/storage";

// Upload file
const file = new File([...], "image.png");
const url = await uploadFile("ui-references", "folder/image.png", file);

// Get public URL
const publicUrl = getPublicUrl("ui-references", "folder/image.png");
```

## Lưu ý

- Ảnh được lưu ở 2 nơi: Local (GitHub) và Supabase Storage
- Local files được commit lên GitHub để làm tài liệu
- Supabase Storage để chia sẻ và truy cập online
- Bucket `ui-references` là public, không chứa thông tin nhạy cảm
