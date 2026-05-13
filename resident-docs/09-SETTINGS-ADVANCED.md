# 09. SETTINGS & ADVANCED FEATURES

## Tổng Quan

Settings & Advanced Features là hệ thống quản lý cấu hình toàn cầu cho hệ thống CRM. Cho phép:

- **Cấu hình doanh nghiệp**: Thông tin công ty, logo, địa chỉ, MST
- **Tùy chỉnh nghiệp vụ**: Hợp đồng, hóa đơn, mẫu biểu
- **Quản lý nhân viên**: Phân quyền, RBAC, phân công công việc
- **Danh mục hệ thống**: Tài chính, tài sản, liên lạc
- **Tự động hóa**: Code generation, notification, integration
- **Trực quan hóa**: Building map, color coding
- **Biểu mẫu**: CT01 form, in ấn

---

## 1. CÀI ĐẶT CHUNG (GENERAL SETTINGS)

### 1.1 Thông Tin Doanh Nghiệp

```
┌─────────────────────────────────────────────────────────┐
│  THÔNG TIN DOANH NGHIỆP                     [Lưu] [Hủy] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Logo Upload]      Tên doanh nghiệp: ________________  │
│  [240x240px]        Tên tiếng Anh:   ________________  │
│                                                         │
│  Địa chỉ:           ________________________________  │
│  Thành phố:         [  Hà Nội        ▼ ]             │
│  Quận/Huyện:        [  Hoàn Kiếm      ▼ ]             │
│  Mã số thuế (MST):  ________________                  │
│                                                         │
│  Số điện thoại:     ________________                  │
│  Email doanh nghiệp:________________                  │
│  Website:           ________________                  │
│                                                         │
│  Giấy phép kinh doanh: _____________ [Tải file]       │
│  Ngày cấp: __/__/20__   Hạn: __/__/20__              │
│                                                         │
│  ☑ Kích hoạt e-Invoice                                │
│  ☑ Kích hoạt hóa đơn điện tử                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Các trường**:
- `company_name` (string): Tên doanh nghiệp
- `company_name_en` (string): Tên tiếng Anh
- `company_address` (string): Địa chỉ
- `company_city` (string): Thành phố
- `company_district` (string): Quận/Huyện
- `tax_id` (string): Mã số thuế
- `phone` (string): Số điện thoại
- `email` (string): Email
- `website` (string): Website
- `logo_url` (string): URL logo
- `business_license_no` (string): Số giấy phép
- `business_license_date` (date): Ngày cấp
- `business_license_expiry` (date): Hạn sử dụng
- `enable_einvoice` (boolean): Bật e-Invoice

### 1.2 Cấu Hình Hợp Đồng (11 Options)

```
┌─────────────────────────────────────────────────────────┐
│  CẤU HÌNH HỢP ĐỒNG                      [Lưu] [Hủy]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ☑ 1. Yêu cầu chứng minh thư cư trú                    │
│  ☑ 2. Yêu cầu CMND/CCCD (2 mặt)                        │
│  ☑ 3. Yêu cầu xác minh nhân thân                       │
│  ☑ 4. Lưu trữ tài liệu hợp đồng gốc                   │
│  ☑ 5. Gửi hợp đồng qua email tự động                  │
│  ☑ 6. In hợp đồng tự động (PDF)                       │
│  ☑ 7. Yêu cầu ký xác nhận điện tử                     │
│  ☑ 8. Hỗ trợ hợp đồng gia hạn nhanh                   │
│  ☑ 9. Hỗ trợ chuyển nhượng phòng                       │
│  ☑ 10. Tính phí hủy hợp đồng sớm                      │
│  ☑ 11. Lưu trữ tự động ở cloud                        │
│                                                         │
│  Cấu hình phí:                                         │
│  Phí chuyển nhượng: __________ ₫ (hoặc ____% tiền cọc) │
│  Phí hủy sớm: __________ ₫/ngày (0 = không tính)      │
│  Tối thiểu kỳ hạn: __________ tháng                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Config fields**:
1. `require_registration_cert` (boolean): Chứng minh thư cư trú
2. `require_id_2_sides` (boolean): CMND/CCCD 2 mặt
3. `require_identity_verification` (boolean): Xác minh nhân thân
4. `archive_contract_original` (boolean): Lưu hợp đồng gốc
5. `auto_send_contract_email` (boolean): Gửi email tự động
6. `auto_generate_pdf` (boolean): Tạo PDF tự động
7. `require_digital_signature` (boolean): Ký số
8. `enable_quick_extension` (boolean): Gia hạn nhanh
9. `enable_transfer` (boolean): Chuyển nhượng
10. `enable_early_termination_fee` (boolean): Phí hủy sớm
11. `auto_cloud_archive` (boolean): Lưu cloud

### 1.3 Cấu Hình Hóa Đơn (9 Options)

```
┌─────────────────────────────────────────────────────────┐
│  CẤU HÌNH HÓA ĐƠN                       [Lưu] [Hủy]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ☑ 1. Tạo hóa đơn tự động hàng tháng                   │
│  ☑ 2. Gửi hóa đơn qua email                            │
│  ☑ 3. In hóa đơn nhiệt (Thermal)                       │
│  ☑ 4. In hóa đơn A4                                    │
│  ☑ 5. Cài đặt kỳ hạn thanh toán tùy chỉnh              │
│  ☑ 6. Thêm chi phí phát sinh tự động                   │
│  ☑ 7. Bảo lưu công nợ quá hạn                          │
│  ☑ 8. Gửi thông báo thanh toán qua SMS                 │
│  ☑ 9. Hỗ trợ thanh toán trực tuyến                     │
│                                                         │
│  Kỳ hạn thanh toán: __________ ngày (từ ngày phát sinh)│
│  Số hóa đơn tự động: [ID]-[YYYY]-[0001] ▼              │
│  Ngày phát sinh tự động: __________ (hàng tháng)       │
│                                                         │
│  Chi phí phát sinh tự động:                            │
│  ☑ Tiền điện/nước    ☑ Internet    ☑ Dịch vụ         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Config fields**:
1. `auto_generate_invoice` (boolean): Tạo tự động
2. `auto_send_invoice_email` (boolean): Gửi email
3. `enable_thermal_printing` (boolean): In thermal
4. `enable_a4_printing` (boolean): In A4
5. `custom_payment_terms` (integer): Kỳ hạn (ngày)
6. `auto_add_charges` (boolean): Thêm chi phí
7. `auto_reserve_overdue` (boolean): Bảo lưu nợ
8. `send_sms_reminder` (boolean): Gửi SMS
9. `enable_online_payment` (boolean): Thanh toán online

### 1.4 Thanh Toán & Thông Báo

```
┌─────────────────────────────────────────────────────────┐
│  THANH TOÁN & THÔNG BÁO                 [Lưu] [Hủy]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  CỔNG THANH TOÁN                                       │
│  ☑ VNPay       ☑ Momo       ☑ Ngân hàng               │
│                                                         │
│  Tài khoản VNPay:  ________________                    │
│  Mật khẩu:         ________________                    │
│  Merchant ID:      ________________                    │
│                                                         │
│  GỬILCS TOÀN                                           │
│  ☑ Email (mặc định)                                    │
│  ☑ SMS (bật: ________ - giá ________)                 │
│  ☑ Zalo OA                                             │
│  ☑ Push notification                                   │
│                                                         │
│  Thời gian gửi thông báo:                              │
│  Hợp đồng sắp hết: ______ ngày trước                  │
│  Hóa đơn quá hạn: ______ ngày sau hạn                 │
│  Sự cố chưa xử lý: ______ giờ sau tạo                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 2. MẪU BIỂU (TEMPLATES)

### 2.1 Mẫu Hợp Đồng (Contract Templates)

```
┌─────────────────────────────────────────────────────────┐
│  MẪU HỢP ĐỒNG                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [+] Thêm mẫu   [Sao chép]   [Xóa]                     │
│                                                         │
│  Mẫu:                           Ngôn ngữ:              │
│  ☑ HD Cho Thuê Nhân (Mặc định)  ☑ Tiếng Việt          │
│  ☐ HD Cho Thuê Dài Hạn          ☐ Tiếng Anh           │
│  ☐ HD Gia Hạn                   ☐ Tiếng Trung        │
│  ☐ HD Chuyển Nhượng                                    │
│                                                         │
│  [Chi tiết]                                            │
│  ├─ Mô tả: ________________________                     │
│  ├─ Phiên bản: 1.0                                     │
│  ├─ Ngôn ngữ: Tiếng Việt                              │
│  ├─ Trạng thái: ☑ Hoạt động  ☐ Nháp  ☐ Lưu trữ      │
│  └─ [Xem trước] [Chỉnh sửa] [Lưu] [Hủy]              │
│                                                         │
│  NƠIDÙNG MẪU:                                          │
│  _____________________________________________          │
│  _____________________________________________          │
│  _____________________________________________          │
│                                                         │
│  BIẾN CÓ SẢN: {tenant_name}, {tenant_id},             │
│  {room_number}, {rent_price}, {contract_id}, ...       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Variables system**:
- `{tenant_name}`: Tên khách
- `{tenant_id}`: Mã khách
- `{tenant_phone}`: Điện thoại
- `{tenant_email}`: Email
- `{room_number}`: Số phòng
- `{room_type}`: Loại phòng
- `{building_name}`: Tên tòa
- `{rent_price}`: Giá thuê
- `{deposit_amount}`: Tiền cọc
- `{contract_id}`: Mã hợp đồng
- `{start_date}`: Ngày bắt đầu
- `{end_date}`: Ngày kết thúc
- `{company_name}`: Tên công ty
- `{created_at}`: Ngày tạo

### 2.2 Mẫu Phiếu Thu Chi (Receipt/Payment Vouchers)

```
┌─────────────────────────────────────────────────────────┐
│  MẪU PHIẾU THU CHI                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [+] Thêm mẫu                                           │
│                                                         │
│  Mẫu:                                                  │
│  ☑ Phiếu Thu (Mặc định)                               │
│  ☐ Phiếu Chi                                           │
│  ☐ Phiếu Hoàn Tiền                                    │
│  ☐ Phiếu Hoàn Cọc                                     │
│                                                         │
│  SỐ HIỆU MẪU: __________________________                │
│  NỘI DUNG:                                             │
│  ┌─────────────────────────────────────────────┐       │
│  │ PHIẾU THU TIỀN                              │       │
│  │ Số phiếu: {receipt_no}                      │       │
│  │ Ngày: {receipt_date}                        │       │
│  │                                             │       │
│  │ Khách hàng: {tenant_name}                   │       │
│  │ Phòng: {room_number}                        │       │
│  │ Số tiền: {amount} ₫                         │       │
│  │ Lý do thu: {reason}                         │       │
│  │ Người thu: {staff_name}                     │       │
│  │ Chữ ký: ______________                      │       │
│  └─────────────────────────────────────────────┘       │
│                                                         │
│  [Xem trước] [Chỉnh sửa]                               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Mẫu Hóa Đơn (Invoice Templates)

#### Mẫu Thermal (80mm)
```
┌──────────────────────┐
│  CÔNG TY TNHH ABC    │
│  Địa chỉ: ...       │
│  Điện thoại: ...    │
├──────────────────────┤
│  HÓA ĐƠN ĐIỆN TỬ    │
│  Số: HĐ-2024-0091  │
│  Ngày: 18/11/2024  │
├──────────────────────┤
│ Phòng: 301          │
│ Khách: Nguyễn Văn A │
│ Kỳ: 11/2024        │
├──────────────────────┤
│ Tiền thuê: 3.5 Tr   │
│ Tiền điện: 450 K    │
│ Tiền nước: 150 K    │
│ Tiền internet: 200K │
├──────────────────────┤
│ CỘNG: 4.3 Tr        │
│ Đã thanh toán: 0    │
│ CÒN PHẢI TRẢ: 4.3Tr │
├──────────────────────┤
│ Hạn thanh toán:     │
│ 08/12/2024          │
├──────────────────────┤
│ [QR Code]           │
│ http://link         │
├──────────────────────┤
│ Cảm ơn quý khách!   │
└──────────────────────┘
```

#### Mẫu A4
```
┌───────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────┐   │
│ │  [Logo]  CÔNG TY TNHH ABC                   │   │
│ │  Địa chỉ: Hà Nội  |  Điện thoại: ...      │   │
│ └─────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────┤
│                  HÓA ĐƠN ĐIỆN TỬ                   │
│  Số HĐ: HĐ-2024-0091            Ngày: 18/11/2024 │
├───────────────────────────────────────────────────┤
│  Bên bán:                    Bên mua:             │
│  CÔNG TY TNHH ABC            Ông/Bà: Nguyễn ...   │
│  Địa chỉ: ...               Địa chỉ: ...         │
│  MST: 0123456789             Điện thoại: ...     │
│                                                   │
│  Căn hộ: Phòng 301 - Tòa A                        │
├───────────────────────────────────────────────────┤
│ Mô tả                      | Đơn vị | Số lượng |  │
├───────────────────────────────────────────────────┤
│ Tiền thuê phòng (11/2024)   | ₫     | 1       |  │
│                             |       | = 3.5Tr |  │
│ Tiền điện (11/2024)         | kWh   | 120     |  │
│                             |       | = 450K  |  │
│ Tiền nước (11/2024)         | m³    | 10      |  │
│                             |       | = 150K  |  │
│ Internet (11/2024)          | ₫     | 1       |  │
│                             |       | = 200K  |  │
├───────────────────────────────────────────────────┤
│                        CỘNG: 4.3 Tr ₫              │
│                   Đã thanh toán: 0 ₫              │
│                   CÒN PHẢI TRẢ: 4.3 Tr ₫          │
├───────────────────────────────────────────────────┤
│  Hạn thanh toán: 08/12/2024                       │
│  Phương thức thanh toán: Chuyển khoản              │
│                                                   │
│  Người lập                      Người đại diện    │
│  _____________                  _____________     │
│  Ngày: __/__/____                Ngày: __/__/____ │
└───────────────────────────────────────────────────┘
```

### 2.4 Template Engine

```typescript
// Template engine implementation
class TemplateEngine {
  // Biến được phép sử dụng
  private variables = {
    tenant: ['tenant_name', 'tenant_id', 'tenant_phone', 'tenant_email'],
    room: ['room_number', 'room_type', 'room_area'],
    building: ['building_name', 'building_address'],
    contract: ['contract_id', 'rent_price', 'deposit', 'start_date', 'end_date'],
    company: ['company_name', 'company_address', 'company_phone', 'company_tax_id'],
    system: ['created_at', 'created_by', 'current_date', 'current_time']
  };

  // Render template với biến
  render(template: string, data: Record<string, any>): string {
    return template.replace(/{(\w+)}/g, (match, key) => {
      return data[key] ?? match;
    });
  }

  // Validate template biến
  validateVariables(template: string): string[] {
    const regex = /{(\w+)}/g;
    const variables = [];
    let match;
    while ((match = regex.exec(template)) !== null) {
      variables.push(match[1]);
    }
    return variables;
  }
}
```

### 2.5 Mẫu Chữ Ký (Signature Templates)

Quản lý mẫu chữ ký điện tử để sử dụng trong hợp đồng, biên bản bàn giao, và các tài liệu khác.

```
┌─────────────────────────────────────────────────────────┐
│  MẪU CHỮ KÝ                       [+] Thêm mẫu mới     │
├──────┬──────────┬────────────────┬──────────────────────┤
│ Code │ Actions  │ Tên mẫu        │ Chữ ký (Preview)     │
├──────┼──────────┼────────────────┼──────────────────────┤
│ CK01 │ [✏️] [🗑️] │ Chữ ký Giám đốc│ [Hình ảnh chữ ký]   │
│ CK02 │ [✏️] [🗑️] │ Chữ ký Kế toán │ [Hình ảnh chữ ký]   │
│ CK03 │ [✏️] [🗑️] │ Chữ ký Quản lý │ [Hình ảnh chữ ký]   │
│ CK04 │ [✏️] [🗑️] │ Chữ ký Nhân viên│ [Hình ảnh chữ ký]   │
└──────┴──────────┴────────────────┴──────────────────────┘
```

**Tính năng chính**:
- Quản lý CRUD (Create, Read, Update, Delete) mẫu chữ ký
- Tạo mẫu chữ ký bằng 3 cách:
  1. **Upload hình ảnh**: Tải lên file PNG/JPG chữ ký viết tay scan
  2. **Vẽ chữ ký**: Dùng canvas vẽ chữ ký điện tử trực tiếp
  3. **Chữ ký text**: Nhập tên, tự động tạo chữ ký từ font chữ đặc biệt
- Mã code tự động generate (CK01, CK02, ...)
- Preview chữ ký trước khi lưu
- Sử dụng trong templates (hợp đồng, biên bản, phiếu thu)

#### Database Schema

```sql
CREATE TABLE signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT NOT NULL, -- CK01, CK02, auto-generated
  name TEXT NOT NULL, -- "Chữ ký Giám đốc"
  signature_type TEXT NOT NULL CHECK (signature_type IN ('UPLOAD', 'DRAW', 'TEXT')),
  signature_url TEXT, -- URL to uploaded image or generated signature
  signature_data JSONB, -- Raw data for canvas-drawn signatures
  text_content TEXT, -- Text for text-based signatures
  font_style TEXT, -- Font for text-based signatures
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, code)
);

CREATE INDEX idx_signature_templates_user_id ON signature_templates(user_id);
CREATE INDEX idx_signature_templates_code ON signature_templates(code);
```

#### User Journey: Tạo Mẫu Chữ Ký

```
Vào Settings → Mẫu Chữ Ký
      │
      ├─→ Click [+ Thêm mẫu mới]
      │
      ├─→ Dialog mở: "Thêm Mẫu Chữ Ký"
      │   ├─ Tên mẫu: "Chữ ký Giám đốc" (*)
      │   ├─ Code: [Auto CK01] hoặc nhập thủ công
      │   │
      │   ├─→ Chọn phương thức tạo chữ ký:
      │   │
      │   │   Option 1: UPLOAD
      │   │   ├─ Click "Tải lên hình ảnh"
      │   │   ├─ Chọn file PNG/JPG
      │   │   ├─ Preview
      │   │   └─ Upload to Supabase Storage
      │   │
      │   │   Option 2: DRAW
      │   │   ├─ Canvas area (400x200px)
      │   │   ├─ Vẽ chữ ký bằng chuột/stylus
      │   │   ├─ [Clear] [Undo]
      │   │   ├─ Preview
      │   │   └─ Convert canvas to base64/PNG
      │   │
      │   │   Option 3: TEXT
      │   │   ├─ Nhập text: "Nguyễn Văn A"
      │   │   ├─ Chọn font: [Dancing Script ▼]
      │   │   ├─ Chọn size: [24px ▼]
      │   │   ├─ Preview
      │   │   └─ Generate image from text
      │
      ├─→ Click [Lưu]
      │   ├─ Validate: Tên không rỗng, Code unique
      │   ├─ Upload signature to storage
      │   ├─ Save to database
      │   └─ Refresh list
      │
      └─→ Hiển thị trong bảng với preview
```

#### API Endpoints

```typescript
// GET /signature-templates
export function useSignatureTemplates() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['signature-templates', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('signature_templates')
        .select('*')
        .eq('user_id', user?.id)
        .eq('is_active', true)
        .order('code');

      if (error) throw error;
      return data;
    },
  });
}

// POST /signature-templates
export function useCreateSignatureTemplate() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateSignatureInput) => {
      // Upload signature image if provided
      let signature_url = null;
      if (data.signature_file) {
        const { data: upload, error: uploadError } = await supabase.storage
          .from('signatures')
          .upload(`${user?.id}/${Date.now()}-${data.signature_file.name}`, data.signature_file);

        if (uploadError) throw uploadError;
        signature_url = supabase.storage.from('signatures').getPublicUrl(upload.path).data.publicUrl;
      }

      const { data: template, error } = await supabase
        .from('signature_templates')
        .insert([{
          user_id: user?.id,
          code: data.code,
          name: data.name,
          signature_type: data.signature_type,
          signature_url,
          signature_data: data.signature_data,
          text_content: data.text_content,
          font_style: data.font_style,
        }])
        .select()
        .single();

      if (error) throw error;
      return template;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signature-templates'] });
    },
  });
}

// DELETE /signature-templates/:id
export function useDeleteSignatureTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('signature_templates')
        .update({ is_active: false })
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signature-templates'] });
    },
  });
}
```

#### Sử dụng trong Templates

Sau khi tạo mẫu chữ ký, có thể sử dụng trong template bằng cách:

```
Trong mẫu hợp đồng:
────────────────────────────
BÊN CHO THUÊ                BÊN THUÊ

{signature:CK01}           {signature:tenant}
_________________          _________________
Nguyễn Văn A               {tenant_name}
Giám đốc                   Khách thuê
```

Template engine sẽ tự động thay thế `{signature:CK01}` bằng hình ảnh chữ ký từ database.

---

## 3. NHÂN VIÊN & PHÂN QUYỀN (STAFF & PERMISSIONS)

### 3.1 Quản Lý Nhân Viên

```
┌─────────────────────────────────────────────────────────┐
│  QUẢN LÝ NHÂN VIÊN                    [+] [⚙️] [🔍]   │
├─────────────────────────────────────────────────────────┤
│  Tìm: ________________  |  Phòng ban: [Tất cả ▼] |  │
│  Trạng thái: [Tất cả ▼]  |  Role: [Tất cả ▼]      │
├─────────────────────────────────────────────────────────┤
│ ID  │ Tên             │ Email          │ Phòng Ban   │  │
├─────┼─────────────────┼────────────────┼─────────────┤  │
│ 001 │ Nguyễn Văn A    │ vana@company.c │ Quản lý     │  │
│     │ [Hoạt động]     │                │ [Sửa][Xóa] │  │
├─────┼─────────────────┼────────────────┼─────────────┤  │
│ 002 │ Trần Thị B      │ thib@company.c │ Kế toán     │  │
│     │ [Hoạt động]     │                │ [Sửa][Xóa] │  │
├─────┼─────────────────┼────────────────┼─────────────┤  │
│ 003 │ Lê Văn C        │ vanc@company.c │ Bảo dưỡng   │  │
│     │ [Không hoạt động│                │ [Sửa][Xóa] │  │
├─────┴─────────────────┴────────────────┴─────────────┤  │
│ Trang: 1 / 3 | [< Trước] [Tiếp >]                    │  │
└─────────────────────────────────────────────────────────┘
```

**Staff Fields**:
- `id` (UUID): ID nhân viên
- `email` (string): Email (login)
- `name` (string): Tên đầy đủ
- `phone` (string): Điện thoại
- `department` (string): Phòng ban
- `position` (string): Chức vụ
- `role` (enum): Role [Admin, Manager, Staff, Accountant, Maintenance, Guest]
- `building_id` (UUID): Tòa nhà được phân công
- `status` (enum): [Active, Inactive, On Leave, Resigned]
- `start_date` (date): Ngày bắt đầu
- `end_date` (date): Ngày kết thúc (nếu resign)
- `password_hash` (string): Hash mật khẩu
- `last_login` (timestamp): Lần đăng nhập cuối
- `is_2fa_enabled` (boolean): 2FA

### 3.2 Role-Based Access Control (RBAC)

```
┌─────────────────────────────────────────────────────────┐
│  QUẢN LÝ PHÂN QUYỀN (RBAC)                              │
├─────────────────────────────────────────────────────────┤
│  Role: [Admin ▼]    |  Tòa nhà: [Tất cả ▼]             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ADMIN - Quyền quản trị toàn bộ hệ thống               │
│  ├─ Quản lý người dùng: ✓                             │
│  ├─ Quản lý tòa nhà: ✓                                │
│  ├─ Quản lý cài đặt: ✓                                │
│  ├─ Xem tất cả báo cáo: ✓                             │
│  └─ Xuất dữ liệu: ✓                                   │
│                                                         │
│  MANAGER - Quản lý tòa nhà                             │
│  ├─ Quản lý khách/phòng: ✓                            │
│  ├─ Quản lý hợp đồng: ✓                               │
│  ├─ Quản lý hóa đơn: ✓                                │
│  ├─ Xem báo cáo tòa nhà: ✓                            │
│  ├─ Quản lý sự cố: ✓                                  │
│  ├─ Quản lý nhân viên (tòa nhà): ✓                    │
│  └─ Xuất báo cáo: ✓                                   │
│                                                         │
│  ACCOUNTANT - Kế toán                                  │
│  ├─ Xem hợp đồng: ✓ (Chỉ xem)                        │
│  ├─ Quản lý hóa đơn: ✓                                │
│  ├─ Quản lý thanh toán: ✓                             │
│  ├─ Xem báo cáo tài chính: ✓                          │
│  └─ Xuất báo cáo tài chính: ✓                         │
│                                                         │
│  MAINTENANCE - Bảo dưỡng                               │
│  ├─ Xem danh sách sự cố: ✓                            │
│  ├─ Cập nhật trạng thái sự cố: ✓                      │
│  ├─ Xem lịch công việc: ✓                             │
│  └─ Báo cáo hoàn tất: ✓                               │
│                                                         │
│  STAFF - Nhân viên                                     │
│  ├─ Xem khách/phòng: ✓                                │
│  ├─ Tạo hóa đơn: ✓                                    │
│  ├─ Quản lý công việc: ✓                              │
│  └─ Báo cáo sự cố: ✓                                  │
│                                                         │
│  GUEST - Khách                                         │
│  ├─ Xem hợp đồng của mình: ✓                          │
│  ├─ Xem hóa đơn của mình: ✓                           │
│  └─ Thanh toán online: ✓                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Permissions Matrix (Chi Tiết)

```
┌──────────────────────────────────────────────────────────────────┐
│  PERMISSION MATRIX - Phân Quyền Chi Tiết                         │
├──────────────────────────────────────────────────────────────────┤
│ Resource    │ View │ Create │ Edit │ Delete │ Approve │ Export  │
├─────────────┼──────┼────────┼──────┼────────┼─────────┼─────────┤
│ Tenant      │  ✓✓✓ │   ✓✓   │  ✓✓  │   ✓    │   -     │   ✓✓✓  │
│ Apartment   │  ✓✓✓ │   ✓    │  ✓✓  │   ✓    │   -     │   ✓✓✓  │
│ Contract    │  ✓✓✓ │   ✓✓   │  ✓✓  │   ✓    │   ✓✓    │   ✓✓✓  │
│ Invoice     │  ✓✓✓ │   ✓✓   │  ✓✓  │   ✓    │   -     │   ✓✓✓  │
│ Payment     │  ✓✓✓ │   ✓✓   │  ✓✓  │   ✓    │   -     │   ✓✓✓  │
│ Incident    │  ✓✓✓ │   ✓✓✓  │  ✓✓  │   ✓    │   ✓✓    │   ✓✓   │
│ Expense     │  ✓✓  │   ✓    │  ✓   │   ✓    │   ✓✓    │   ✓✓✓  │
│ Report      │  ✓✓✓ │   -    │  -   │   -    │   -     │   ✓✓✓  │
│ Settings    │  ✓   │   -    │  ✓   │   -    │   -     │   -     │
│ User        │  ✓✓  │   ✓    │  ✓   │   ✓    │   -     │   -     │
├─────────────┼──────┼────────┼──────┼────────┼─────────┼─────────┤
│ ✓✓✓ = Admin, Manager, Accountant                                │
│ ✓✓  = Admin, Manager                                            │
│ ✓   = Admin, Manager, Staff                                     │
└──────────────────────────────────────────────────────────────────┘
```

### 3.4 Building-Based Assignment

```sql
-- Phân công nhân viên theo tòa nhà
CREATE TABLE staff_building_assignments (
  id UUID PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES staff(id),
  building_id UUID NOT NULL REFERENCES buildings(id),
  role_in_building VARCHAR(50), -- Manager, Staff, Maintenance
  assigned_at TIMESTAMP DEFAULT NOW(),
  assigned_by UUID REFERENCES staff(id),
  status VARCHAR(20) DEFAULT 'active', -- active, inactive
  UNIQUE(staff_id, building_id)
);

-- Query: Lấy danh sách nhân viên theo tòa nhà
SELECT s.*, sb.role_in_building
FROM staff s
JOIN staff_building_assignments sb ON s.id = sb.staff_id
WHERE sb.building_id = $1 AND sb.status = 'active';
```

---

## 4. DANH MỤC KHÁC (OTHER CATEGORIES)

### 4.1 Tài Chính (Finance)

```
┌─────────────────────────────────────────────────────────┐
│  DANH MỤC TÀI CHÍNH                   [+] [⚙️]        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  NGÂN HÀNG (Bank Accounts)                              │
│  ☑ VietinBank - STK 1234567890 (Chính)                │
│  ☑ Agribank - STK 9876543210                           │
│  ☐ VietcomBank - STK 5555555555                        │
│  [+] Thêm tài khoản                                     │
│                                                         │
│  LOẠI GIAO DỊCH (Transaction Types)                     │
│  VÀO: Tiền thuê, Phí phát sinh, Khác vào              │
│  RA: Tiền điện, Tiền nước, Lương, Khác ra             │
│  [+] Thêm loại                                          │
│                                                         │
│  HÓA ĐƠN ĐIỆN TỬ (E-Invoice)                           │
│  Nhà cung cấp: SoftBiz                                  │
│  Tài khoản: ________________                            │
│  Mật khẩu: ________________                             │
│  Trạng thái: ☑ Kích hoạt                              │
│  [Kiểm tra kết nối]                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Tài Sản (Assets)

```
┌─────────────────────────────────────────────────────────┐
│  DANH MỤC TÀI SẢN                     [+] [⚙️]        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  NHÀ CUNG CẤP (Suppliers)                               │
│  [+] Thêm nhà cung cấp                                  │
│  - Công ty Thiết bị điện ABC                           │
│  - Công ty Vật liệu xây dựng XYZ                       │
│                                                         │
│  KHO (Warehouses)                                       │
│  [+] Thêm kho                                           │
│  - Kho chính (Tòa A - Tầng B1)                         │
│  - Kho dự phòng (Tòa B - Tầng B1)                      │
│                                                         │
│  LOẠI HÀNG HÓA (Categories)                             │
│  [+] Thêm loại                                          │
│  - Thiết bị điện tử                                     │
│  - Vật liệu xây dựng                                    │
│  - Đồ nội thất                                          │
│  - Hóa chất vệ sinh                                     │
│                                                         │
│  DANH SÁCH HÀNG HÓA (Inventory)                         │
│  Mã   │ Tên             │ Loại    │ Số lượng │ Kho     │
│  ─────┼─────────────────┼─────────┼──────────┼─────────│
│  001  │ Đèn LED 10W     │ Điện tử │ 50       │ Kho 1   │
│  002  │ Bát gạch trắng  │ Vật liệu│ 200      │ Kho 2   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Liên Lạc (Hotline & Zalo)

```
┌─────────────────────────────────────────────────────────┐
│  HOTLINE MANAGEMENT                   [+] [⚙️]        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  SỐ HOTLINE CHÍNH: 1900.xxxx  [Sửa]                   │
│  ☑ Đang hoạt động                                      │
│  Giờ làm việc: 08:00 - 18:00 (Thứ 2-6), 08:00-12:00  │
│                                                         │
│  ZALO OA INTEGRATION                                    │
│  ☑ Kích hoạt                                           │
│  OA ID: ____________________                           │
│  API Key: ____________________                         │
│  Template IDs:                                         │
│    - Thông báo thanh toán: _____                       │
│    - Nhắc nợ: _____                                    │
│    - Thông báo sự cố: _____                            │
│  [Kiểm tra kết nối] [Gửi tin nhắn test]               │
│                                                         │
│  TELEGRAM BOT (optional)                                │
│  ☐ Kích hoạt                                           │
│  Bot Token: ____________________                       │
│  [Kiểm tra kết nối]                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.4 Loại Công Việc (Job Types)

```
┌─────────────────────────────────────────────────────────┐
│  DANH MỤC LOẠI CÔNG VIỆC               [+] [⚙️]       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Mã   │ Tên                    │ Mô tả          │ Sửa  │
│  ─────┼────────────────────────┼────────────────┼──────│
│  JT01 │ Bảo dưỡng thường xuyên │ Vệ sinh, kiểm │ [✎]  │
│       │                        │ tra định kỳ    │      │
│  ─────┼────────────────────────┼────────────────┼──────│
│  JT02 │ Sửa chữa khẩn cấp      │ Chỉnh sửa bị   │ [✎]  │
│       │                        │ hỏng, gấp     │      │
│  ─────┼────────────────────────┼────────────────┼──────│
│  JT03 │ Vệ sinh phòng          │ Dọn dẹp sau khi│ [✎]  │
│       │                        │ khách chuyển   │      │
│  ─────┼────────────────────────┼────────────────┼──────│
│  JT04 │ Kiểm tra an toàn       │ Kiểm tra điện  │ [✎]  │
│       │                        │ gas...         │      │
│                                                         │
│  [+] Thêm loại                                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 5. CODE GENERATION SYSTEM (Hệ thống tạo mã)

### 5.1 Cấu Hình Tạo Mã

```
┌─────────────────────────────────────────────────────────┐
│  CẤU HÌNH SINH MÃ TỰ ĐỘNG                [Lưu] [Hủy]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  HỢPĐỒNG (Contract ID)                                 │
│  Format: HD[YYYY][0001]                                │
│  Ví dụ: HD2024-0001, HD2024-0002                       │
│  Prefix: HD          Năm: [YYYY ▼]  Số: [0001 ▼]      │
│  ☑ Reset số theo năm                                  │
│  [Xem trước]: _____________________                    │
│  [Lưu]                                                 │
│                                                         │
│  HÓA ĐƠN (Invoice ID)                                  │
│  Format: HĐ[YYYY][0001]                                │
│  Ví dụ: HĐ2024-0001, HĐ2024-0002                       │
│  Prefix: HĐ          Năm: [YYYY ▼]  Số: [0001 ▼]      │
│  ☑ Reset số theo tháng                                │
│  [Xem trước]: _____________________                    │
│  [Lưu]                                                 │
│                                                         │
│  PHIẾU THU (Receipt ID)                                │
│  Format: PT[YYYY][0001]                                │
│  Prefix: PT          Năm: [YYYY ▼]  Số: [0001 ▼]      │
│  ☑ Reset số theo tháng                                │
│  [Lưu]                                                 │
│                                                         │
│  CÔNG VIỆC (Job ID)                                    │
│  Format: JOB[YYYYMMDD][001]                            │
│  Prefix: JOB         Ngày: [Auto]  Số: [001 ▼]        │
│  ☑ Reset số theo ngày                                 │
│  [Lưu]                                                 │
│                                                         │
│  SỰ CỐ (Incident ID)                                   │
│  Format: SC[YYYYMMDD][001]                             │
│  Prefix: SC          Ngày: [Auto]  Số: [001 ▼]        │
│  ☑ Reset số theo ngày                                 │
│  [Lưu]                                                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Implementation với SQL Function

```sql
-- SQL Function to generate code
CREATE OR REPLACE FUNCTION generate_code(
  prefix VARCHAR,
  format_type VARCHAR,
  reset_period VARCHAR
) RETURNS VARCHAR AS $$
DECLARE
  v_current_num INT;
  v_code VARCHAR;
  v_year INT;
  v_month INT;
  v_day INT;
BEGIN
  v_year := EXTRACT(YEAR FROM NOW());
  v_month := EXTRACT(MONTH FROM NOW());
  v_day := EXTRACT(DAY FROM NOW());

  -- Lấy số tiếp theo từ sequence
  SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM POSITION('-' IN code) + 1) AS INT)), 0) + 1
  INTO v_current_num
  FROM generated_codes
  WHERE code_prefix = prefix
    AND (
      (reset_period = 'yearly' AND EXTRACT(YEAR FROM created_at) = v_year)
      OR (reset_period = 'monthly' AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()))
      OR (reset_period = 'daily' AND DATE_TRUNC('day', created_at) = DATE_TRUNC('day', NOW()))
      OR reset_period = 'none'
    );

  -- Tạo mã theo format
  CASE format_type
    WHEN 'YYYY' THEN
      v_code := prefix || v_year || '-' || LPAD(v_current_num::TEXT, 4, '0');
    WHEN 'YYYYMM' THEN
      v_code := prefix || v_year || LPAD(v_month::TEXT, 2, '0') || '-' || LPAD(v_current_num::TEXT, 4, '0');
    WHEN 'YYYYMMDD' THEN
      v_code := prefix || v_year || LPAD(v_month::TEXT, 2, '0') || LPAD(v_day::TEXT, 2, '0') || '-' || LPAD(v_current_num::TEXT, 3, '0');
    ELSE
      v_code := prefix || LPAD(v_current_num::TEXT, 4, '0');
  END CASE;

  -- Lưu vào bảng
  INSERT INTO generated_codes (code_prefix, code, code_type, reset_period, created_at)
  VALUES (prefix, v_code, format_type, reset_period, NOW());

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;

-- Table to track generated codes
CREATE TABLE generated_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_prefix VARCHAR NOT NULL,
  code VARCHAR NOT NULL UNIQUE,
  code_type VARCHAR, -- YYYY, YYYYMM, YYYYMMDD
  reset_period VARCHAR, -- yearly, monthly, daily, none
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 5.3 Usage Example

```typescript
// TypeScript: Sử dụng
async function createContractWithAutoCode() {
  const code = await supabase.rpc('generate_code', {
    prefix: 'HD',
    format_type: 'YYYY',
    reset_period: 'yearly'
  });

  // Result: HD2024-0001, HD2024-0002, ...
  console.log(code); // HD2024-0001
}

async function createInvoiceWithAutoCode() {
  const code = await supabase.rpc('generate_code', {
    prefix: 'HĐ',
    format_type: 'YYYY',
    reset_period: 'monthly'
  });

  // Result: HĐ2024-0001, HĐ2024-0002, ...
  console.log(code); // HĐ2024-0001
}
```

---

## 6. NOTIFICATION SYSTEM (Chi Tiết)

### 6.1 Multi-Channel Notifications

```
┌─────────────────────────────────────────────────────────┐
│  HỆ THỐNG THÔNG BÁO                   [+] [⚙️] [🔍]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  KÊNH THÔNG BÁO                                         │
│  ☑ Email         ☑ SMS         ☑ Zalo       ☑ Push  │
│                                                         │
│  CÀI ĐẶT KÊNH                                          │
│                                                         │
│  EMAIL:                                                 │
│  ☑ Bật email thông báo                                 │
│  Từ: info@company.com                                  │
│  SMTP Server: smtp.gmail.com:587                       │
│  [Kiểm tra kết nối]                                    │
│                                                         │
│  SMS:                                                   │
│  ☑ Bật SMS thông báo                                   │
│  Nhà cung cấp: Twilio / VNPT / Viettel                 │
│  Account ID: ________________                          │
│  API Key: ________________                             │
│  Số điện thoại gửi: 1900.xxxx                          │
│  Giá: 500 ₫/tin (được trừ vào hóa đơn)                │
│  [Kiểm tra kết nối]                                    │
│                                                         │
│  ZALO:                                                  │
│  ☑ Bật Zalo OA notification                            │
│  OA ID: 123456789                                      │
│  API Key: ________________                             │
│  [Kiểm tra kết nối]                                    │
│                                                         │
│  PUSH NOTIFICATION:                                     │
│  ☑ Bật push notification                               │
│  Firebase Project: crm                            │
│  Server Key: ________________                          │
│  [Kiểm tra kết nối]                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Notification Templates

```
┌─────────────────────────────────────────────────────────┐
│  MẪU THÔNG BÁO                        [+] [⚙️]        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  THÔNG BÁO THANH TOÁN                                   │
│  Tiêu đề: Thông báo hóa đơn [{invoice_id}]             │
│  Nội dung:                                              │
│  Khách hàng {tenant_name} ơi,                           │
│  Hóa đơn {invoice_id} của bạn đã được phát sinh         │
│  Phòng: {room_number}                                   │
│  Số tiền: {amount} ₫                                    │
│  Hạn thanh toán: {due_date}                            │
│  [Xem hóa đơn]                                          │
│                                                         │
│  NHẮC NỢ                                                │
│  Tiêu đề: Nhắc thanh toán hóa đơn [{invoice_id}]       │
│  Nội dung:                                              │
│  Khách hàng {tenant_name} ơi,                           │
│  Hóa đơn {invoice_id} của bạn đã quá hạn {days} ngày    │
│  Vui lòng thanh toán trước ngày {new_due_date}         │
│  Số tiền: {amount} ₫                                    │
│  [Thanh toán ngay]                                      │
│                                                         │
│  THÔNG BÁO SỰ CỐ                                       │
│  Tiêu đề: Sự cố phòng {room_number} cần xử lý          │
│  Nội dung:                                              │
│  Sự cố: {issue_description}                            │
│  Phòng: {room_number} - {building_name}                │
│  Mức độ: {priority}                                    │
│  Được báo cáo: {created_at}                            │
│  [Xem chi tiết]                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 6.3 Notification Scheduling & Automation

```typescript
// Notification rules & scheduling
const notificationRules = {
  INVOICE_ISSUED: {
    trigger: 'invoice.created',
    channels: ['email', 'sms', 'zalo'],
    delay: '0h', // Gửi ngay
    template: 'INVOICE_ISSUED'
  },

  INVOICE_OVERDUE_7DAYS: {
    trigger: 'invoice.due_date_passed(7)',
    channels: ['email', 'sms', 'zalo'],
    delay: '0h',
    template: 'INVOICE_OVERDUE_7',
    reciprocal_rule: 'INVOICE_OVERDUE_14DAYS'
  },

  CONTRACT_EXPIRING_30DAYS: {
    trigger: 'contract.end_date_approaching(30)',
    channels: ['email'],
    delay: '8h', // Gửi lúc 8:00 AM
    template: 'CONTRACT_EXPIRING',
    audience: ['manager', 'tenant']
  },

  INCIDENT_CREATED: {
    trigger: 'incident.created',
    channels: ['push', 'zalo'],
    delay: '0h',
    template: 'INCIDENT_CREATED',
    audience: ['maintenance_staff']
  },

  INCIDENT_OVERDUE_24H: {
    trigger: 'incident.status = open AND created_at < NOW() - 24h',
    channels: ['push', 'email'],
    delay: '24h',
    template: 'INCIDENT_PENDING',
    audience: ['manager']
  }
};

// Cron job to process notifications
cron.schedule('0 * * * *', async () => {
  // Check all notification rules every hour
  for (const [ruleName, rule] of Object.entries(notificationRules)) {
    const records = await checkTriggerCondition(rule.trigger);
    for (const record of records) {
      await scheduleNotification({
        rule: ruleName,
        record,
        delay: rule.delay,
        channels: rule.channels
      });
    }
  }
});
```

---

## 7. BUILDING MAP VISUALIZATION

Sơ đồ căn hộ (Building Map) là trang **riêng biệt** (top-level page) cho phép xem trực quan tất cả căn hộ trong tòa nhà theo từng tầng với màu sắc phân biệt trạng thái.

**Vị trí**: Menu chính → Sơ đồ căn hộ (cùng cấp với Tòa nhà, Căn hộ, Hợp đồng)

### 7.1 Layout & Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│  SƠ ĐỒ CĂN HỘ                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Chọn Tòa nhà: [Tòa A ▼]     [Grid View] [List View]              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  LEGEND (Chú thích):                                                │
│  🟢 Đang cho thuê    🔴 Còn trống    🟡 Nợ    🟠 Bảo trì           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ Tầng 3:                                              (5 phòng)│ │
│  │ ┌─────┬─────┬─────┬─────┬─────┐                              │ │
│  │ │ 301 │ 302 │ 303 │ 304 │ 305 │                              │ │
│  │ │ 🟢  │ 🟢  │ 🔴  │ 🟢  │ 🟢  │                              │ │
│  │ └─────┴─────┴─────┴─────┴─────┘                              │ │
│  │                                                               │ │
│  │ Tầng 2:                                              (5 phòng)│ │
│  │ ┌─────┬─────┬─────┬─────┬─────┐                              │ │
│  │ │ 201 │ 202 │ 203 │ 204 │ 205 │                              │ │
│  │ │ 🟢  │ 🔴  │ 🟢  │ 🟢  │ 🟢  │                              │ │
│  │ └─────┴─────┴─────┴─────┴─────┘                              │ │
│  │                                                               │ │
│  │ Tầng 1:                                              (5 phòng)│ │
│  │ ┌─────┬─────┬─────┬─────┬─────┐                              │ │
│  │ │ 101 │ 102 │ 103 │ 104 │ 105 │                              │ │
│  │ │ 🟢  │ 🟢  │ 🟢  │ 🔴  │ 🟢  │                              │ │
│  │ └─────┴─────┴─────┴─────┴─────┘                              │ │
│  │                                                               │ │
│  │ Tầng G (Ground):                                     (5 phòng)│ │
│  │ ┌─────┬─────┬─────┬─────┬─────┐                              │ │
│  │ │ G01 │ G02 │ G03 │ G04 │ G05 │                              │ │
│  │ │ 🟢  │ 🔴  │ 🟢  │ 🟢  │ 🔴  │                              │ │
│  │ └─────┴─────┴─────┴─────┴─────┘                              │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  SUMMARY STATS:                                                     │
│  Tổng phòng: 20    |  Đang cho thuê: 15 (75%)  |  Còn trống: 5   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Đặc điểm cấu trúc**:
- **Layout grid**: 5 phòng/hàng (có thể điều chỉnh: 4, 6, 8 tùy building)
- **Thứ tự tầng**: Từ trên xuống (Cao nhất → Tầng G)
- **Tên tầng**: Tầng G, Tầng 1, Tầng 2, Tầng 3, ...
- **Số phòng**: Format tự động theo tầng (301, 302, ... hoặc 3A, 3B, ...)
- **Click phòng**: Mở dialog chi tiết phòng
- **Hover**: Hiển thị tooltip (Tên khách, Giá thuê, Trạng thái)

### 7.1.1 Implementation với React

```typescript
// BuildingMapPage.tsx
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';

export function BuildingMapPage() {
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(selectedBuilding);

  // Group rooms by floor
  const roomsByFloor = useMemo(() => {
    if (!rooms) return {};

    return rooms.reduce((acc, room) => {
      const floor = room.floor;
      if (!acc[floor]) acc[floor] = [];
      acc[floor].push(room);
      return acc;
    }, {} as Record<number, Room[]>);
  }, [rooms]);

  // Sort floors descending (highest first)
  const floors = Object.keys(roomsByFloor)
    .map(Number)
    .sort((a, b) => b - a);

  return (
    <div className="building-map-page">
      <div className="header">
        <h1>Sơ đồ căn hộ</h1>
        <Select value={selectedBuilding} onValueChange={setSelectedBuilding}>
          {buildings?.map(b => (
            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
          ))}
        </Select>
      </div>

      <div className="legend">
        <span className="legend-item">
          <div className="dot green"></div> Đang cho thuê
        </span>
        <span className="legend-item">
          <div className="dot red"></div> Còn trống
        </span>
        {/* More legend items */}
      </div>

      <div className="floors-container">
        {floors.map(floor => (
          <FloorSection
            key={floor}
            floor={floor}
            rooms={roomsByFloor[floor]}
          />
        ))}
      </div>

      <div className="summary-stats">
        <StatCard label="Tổng phòng" value={rooms?.length ?? 0} />
        <StatCard label="Đang cho thuê" value={occupiedCount} />
        <StatCard label="Còn trống" value={vacantCount} />
      </div>
    </div>
  );
}

// FloorSection.tsx
function FloorSection({ floor, rooms }: { floor: number; rooms: Room[] }) {
  const floorName = floor === 0 ? 'Tầng G' : `Tầng ${floor}`;

  // Layout: 5 rooms per row
  const ROOMS_PER_ROW = 5;
  const rows = chunk(rooms, ROOMS_PER_ROW);

  return (
    <div className="floor-section">
      <h3>{floorName}: <span className="count">({rooms.length} phòng)</span></h3>

      {rows.map((row, idx) => (
        <div key={idx} className="room-row">
          {row.map(room => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      ))}
    </div>
  );
}

// RoomCard.tsx
function RoomCard({ room }: { room: Room }) {
  const [showDialog, setShowDialog] = useState(false);

  // Determine color based on room status
  const getStatusColor = (room: Room) => {
    if (room.status === 'occupied') {
      if (room.has_overdue_invoice) return 'yellow'; // Nợ tiền
      return 'green'; // Đang thuê
    }
    if (room.status === 'maintenance') return 'orange';
    if (room.status === 'available') return 'red'; // Còn trống
    return 'gray';
  };

  const statusColor = getStatusColor(room);

  return (
    <>
      <div
        className={`room-card ${statusColor}`}
        onClick={() => setShowDialog(true)}
      >
        <div className="room-number">{room.room_number}</div>
        <div className={`status-indicator ${statusColor}`}></div>
      </div>

      <RoomDetailDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        room={room}
      />
    </>
  );
}
```

### 7.2 Color Coding (5 Màu Theo Trạng Thái)

```
Color Status Legend:
┌────────┬──────────────────────┬────────────────────┐
│ Color  │ Status               │ Meaning            │
├────────┼──────────────────────┼────────────────────┤
│ 🟢 Xanh│ Occupied - Paid      │ Đang cho thuê,     │
│        │ (Cho thuê, Đã thanh  │ khách đã thanh     │
│        │ toán)                │ toán đầy đủ        │
├────────┼──────────────────────┼────────────────────┤
│ 🟡 Vàng│ Occupied - Overdue   │ Đang cho thuê      │
│        │ (Cho thuê, Nợ)       │ nhưng khách nợ     │
│        │                      │ tiền                │
├────────┼──────────────────────┼────────────────────┤
│ 🔵 Xanh│ Vacant - Available   │ Phòng trống        │
│        │ (Trống, sẵn sàng)    │ sẵn sàng cho       │
│        │                      │ cho thuê            │
├────────┼──────────────────────┼────────────────────┤
│ 🟠 Cam │ Maintenance          │ Phòng đang bảo     │
│        │ (Bảo dưỡng)          │ dưỡng, sửa chữa    │
├────────┼──────────────────────┼────────────────────┤
│ ⚪ Trắng│ Disabled/Inactive    │ Phòng không sử     │
│        │ (Vô hiệu)            │ dụng                │
└────────┴──────────────────────┴────────────────────┘
```

### 7.3 Interactive Features

```typescript
// Building map interactions
interface BuildingMapFeatures {
  // Click room to view details
  onRoomClick: (roomId: UUID) => void;

  // Hover to show tooltip
  onRoomHover: (roomId: UUID) => void;

  // Right-click context menu
  onRoomContextMenu: (roomId: UUID) => void;

  // Drag-drop to assign tenant
  onRoomDragDrop: (roomId: UUID, tenantId: UUID) => void;

  // Filter by status
  filterByStatus: (status: 'occupied' | 'vacant' | 'maintenance') => void;

  // Search specific room
  searchRoom: (roomNumber: string) => void;

  // Zoom in/out
  zoomIn: () => void;
  zoomOut: () => void;

  // Export as image/PDF
  exportAsImage: () => void;
  exportAsPDF: () => void;
}
```

---

## 8. CT01 FORM (Tờ Khai Thay Đổi Cư Trú)

### 8.1 Form Structure

```
┌─────────────────────────────────────────────────────────┐
│  BIỂU MẫU CT01 - Tờ Khai Thay Đổi Cư Trú               │
│  (Công an quận/huyện sẽ cấp)                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  PHẦN I: THÔNG TIN CƠ BẢN                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Họ và tên (đầy đủ): _________________            │   │
│  │ CMND/CCCD/Hộ chiếu: ____ cấp ngày: ____         │   │
│  │                                                 │   │
│  │ Giới tính: ☐ Nam   ☐ Nữ   ☐ Khác               │   │
│  │ Ngày sinh: __/__/____   Nơi sinh: __________    │   │
│  │                                                 │   │
│  │ Quốc tịch: ___________   Dân tộc: __________   │   │
│  │ Tôn giáo: ___________                           │   │
│  │ Nghề nghiệp: ___________                        │   │
│  │                                                 │   │
│  │ Số điện thoại: ____________  SĐT zalo: _______ │   │
│  │ Email: _____________________________           │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  PHẦN II: ĐỊA CHỈ CŨ                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Địa chỉ cũ: _____________________________       │   │
│  │ Thành phố/Tỉnh: _____  Quận/Huyện: _____      │   │
│  │ Phường/Xã: _____  Từ ngày: __/__/____ đến: __ │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  PHẦN III: ĐỊA CHỈ MỚI (SỬ DỤNG CỬ TRỊ)                │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Địa chỉ mới: _____________________________       │   │
│  │ Thành phố/Tỉnh: [Hà Nội ▼]                      │   │
│  │ Quận/Huyện: [Hoàn Kiếm ▼]                      │   │
│  │ Phường/Xã: [Tràng Tiền ▼]                       │   │
│  │ Từ ngày: __/__/____ (Ngày bắt đầu ở)           │   │
│  │                                                 │   │
│  │ ☑ Hộ chủ/Chủ nhân nhà (nếu khác)               │   │
│  │   Họ tên: _____________  SĐT: ____________     │   │
│  │   CMND: _____________ cấp ngày: __/__/__       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  PHẦN IV: THÀNH VIÊN TRONG HỘ                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Số thành viên thay đổi cư trú: _____            │   │
│  │ Ghi tên những thành viên trong hộ thay đổi:    │   │
│  │ 1. ________________     3. ________________      │   │
│  │ 2. ________________     4. ________________      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  PHẦN V: LÝ DO THAY ĐỔI                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ☐ Hết hợp đồng thuê nhà                         │   │
│  │ ☐ Chuyển công tác                              │   │
│  │ ☐ Học tập                                       │   │
│  │ ☐ Làm việc                                      │   │
│  │ ☐ Khác: ___________________                     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [Xem trước PDF] [In] [Gửi email] [Lưu nháp] [Gửi]    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Auto-Fill Mechanism

```typescript
// Auto-fill CT01 form từ hệ thống
interface CT01FormData {
  // Part I: Thông tin cơ bản (lấy từ tenant profile)
  fullName: string;
  idNumber: string;
  idIssuedDate: Date;
  gender: 'M' | 'F' | 'Other';
  dateOfBirth: Date;
  placeOfBirth: string;
  nationality: string;
  ethnicity: string;
  religion: string;
  occupation: string;
  phone: string;
  zaloPhone: string;
  email: string;

  // Part II: Địa chỉ cũ (lấy từ contract cũ)
  oldAddress: string;
  oldCity: string;
  oldDistrict: string;
  oldWard: string;
  moveOutDate: Date;

  // Part III: Địa chỉ mới (lấy từ apartment + contract mới)
  newAddress: string;
  newCity: string;
  newDistrict: string;
  newWard: string;
  moveInDate: Date;
  landlordName: string;
  landlordPhone: string;
  landlordIdNumber: string;

  // Part IV: Thành viên trong hộ
  householdMembers: string[];

  // Part V: Lý do
  reason: string;
}

// Auto-fill function
function autoFillCT01(
  tenant: Tenant,
  oldContract: Contract,
  newContract: Contract,
  apartment: Apartment
): CT01FormData {
  return {
    fullName: tenant.name,
    idNumber: tenant.id_number,
    idIssuedDate: tenant.id_issued_date,
    // ... auto-fill all fields

    oldAddress: `${oldContract.apartment_address}`,
    moveOutDate: oldContract.end_date,

    newAddress: `${apartment.building_name}, ${apartment.room_number}, ${apartment.address}`,
    moveInDate: newContract.start_date,
    landlordName: apartment.building.owner_name,
    landlordPhone: apartment.building.owner_phone,
  };
}
```

### 8.3 PDF Generation

```typescript
// Tạo PDF CT01
import jsPDF from 'jspdf';
import html2pdf from 'html2pdf.js';

async function generateCT01PDF(formData: CT01FormData): Promise<Blob> {
  const htmlContent = `
    <html>
      <body style="font-family: Arial; font-size: 12px;">
        <h2 style="text-align: center;">TỜ KHAI THAY ĐỔI CỬ TRÍ</h2>

        <h3>PHẦN I: THÔNG TIN CƠ BẢN</h3>
        <p>Họ và tên: <strong>${formData.fullName}</strong></p>
        <p>CMND: <strong>${formData.idNumber}</strong></p>
        <!-- ... other fields ... -->

        <h3>PHẦN III: ĐỊA CHỈ MỚI</h3>
        <p>Địa chỉ: <strong>${formData.newAddress}</strong></p>
        <p>Từ ngày: <strong>${formatDate(formData.moveInDate)}</strong></p>

        <p style="margin-top: 40px;">
          Ngày: ___/__/____
          <br/>Chữ ký người khai: ___________
        </p>
      </body>
    </html>
  `;

  return new Promise((resolve) => {
    html2pdf().set({
      margin: 10,
      filename: `CT01-${formData.fullName}-${Date.now()}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
    }).from(htmlContent).output('blob').then(resolve);
  });
}
```

---

## 9. DATABASE SCHEMA (SETTINGS TABLES)

```sql
-- Bảng cấu hình công ty
CREATE TABLE company_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name VARCHAR(255) NOT NULL,
  company_name_en VARCHAR(255),
  company_address TEXT,
  company_city VARCHAR(100),
  company_district VARCHAR(100),
  tax_id VARCHAR(20),
  phone VARCHAR(20),
  email VARCHAR(100),
  website VARCHAR(255),
  logo_url TEXT,
  business_license_no VARCHAR(50),
  business_license_date DATE,
  business_license_expiry DATE,
  enable_einvoice BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng cấu hình hợp đồng
CREATE TABLE contract_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value JSONB,
  description TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng nhân viên
CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  department VARCHAR(100),
  position VARCHAR(100),
  role VARCHAR(50) DEFAULT 'staff', -- admin, manager, accountant, maintenance, staff, guest
  status VARCHAR(20) DEFAULT 'active', -- active, inactive, on_leave, resigned
  building_id UUID REFERENCES buildings(id),
  start_date DATE,
  end_date DATE,
  password_hash VARCHAR(255),
  last_login TIMESTAMP,
  is_2fa_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng mẫu (templates)
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type VARCHAR(50), -- contract, invoice, receipt, ct01
  name VARCHAR(255) NOT NULL,
  description TEXT,
  language VARCHAR(10) DEFAULT 'vi', -- vi, en, zh
  content TEXT NOT NULL,
  version VARCHAR(10) DEFAULT '1.0',
  status VARCHAR(20) DEFAULT 'active', -- active, draft, archived
  created_by UUID REFERENCES staff(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng code generation config
CREATE TABLE code_generation_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_type VARCHAR(50) NOT NULL UNIQUE, -- contract, invoice, receipt, job, incident
  prefix VARCHAR(10) NOT NULL,
  format_type VARCHAR(20), -- YYYY, YYYYMM, YYYYMMDD
  reset_period VARCHAR(20), -- yearly, monthly, daily, none
  current_number INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng notification rules
CREATE TABLE notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name VARCHAR(100) NOT NULL,
  trigger_event VARCHAR(100), -- invoice.created, contract.expiring, etc
  channels JSONB, -- ['email', 'sms', 'zalo', 'push']
  template_id UUID REFERENCES templates(id),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Bảng notification history
CREATE TABLE notification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID,
  recipient_email VARCHAR(100),
  recipient_phone VARCHAR(20),
  channel VARCHAR(20), -- email, sms, zalo, push
  subject VARCHAR(255),
  message TEXT,
  status VARCHAR(20), -- pending, sent, failed
  sent_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bảng permission matrix
CREATE TABLE permission_matrix (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name VARCHAR(50),
  resource_type VARCHAR(50), -- tenant, apartment, contract, invoice, etc
  action VARCHAR(20), -- view, create, edit, delete, approve, export
  allowed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 10. FLOW DIAGRAMS

### 10.1 Settings Configuration Flow

```
┌──────────────┐
│ User Login   │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────┐
│ Check Role & Permission             │
│ - Admin: Full access                │
│ - Manager: Limited access           │
│ - Others: No access                 │
└──────┬──────────────────────────────┘
       │
       ├─ Admin? ──▶ ┌─────────────────────────┐
       │             │ ADMIN SETTINGS PANEL    │
       │             ├─ Company Info          │
       │             ├─ Contract Config       │
       │             ├─ Invoice Config        │
       │             ├─ Staff Management      │
       │             ├─ Permission Matrix     │
       │             ├─ Notification Setup    │
       │             ├─ Code Generation       │
       │             ├─ Template Management   │
       │             └─ Integration           │
       │             └─────────────────────────┘
       │
       └─ Manager? ─▶ ┌──────────────────────────┐
                      │ MANAGER SETTINGS PANEL   │
                      ├─ Building Settings       │
                      ├─ Room Management         │
                      ├─ Staff (Limited)         │
                      ├─ Building Map            │
                      └─ Reports Configuration   │
                      └──────────────────────────┘
```

### 10.2 Notification Flow

```
╔═══════════════════════════════════════════════════════╗
║           NOTIFICATION SYSTEM FLOW                     ║
╚═══════════════════════════════════════════════════════╝

TRIGGER EVENT
     │
     ├─ Invoice created ───────────────┐
     ├─ Invoice overdue ────────────────├─▶ Check Rules
     ├─ Contract expiring ───────────────│
     ├─ Incident created ────────────────┤
     └─ Payment received ───────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ NOTIFICATION     │
                    │ RULE ENGINE      │
                    └────────┬─────────┘
                             │
             ┌───────────────┼───────────────┐
             │               │               │
             ▼               ▼               ▼
         [Email]        [SMS]            [Zalo]
         [Push]         [Webhook]
             │               │               │
             └───────────────┼───────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ CHANNEL          │
                    │ ADAPTER          │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
    [SMTP Server]      [SMS Provider]       [Zalo API]
        │                    │                    │
        ▼                    ▼                    ▼
    [User Email]       [User Phone]        [User Zalo ID]
```

### 10.3 Code Generation Flow

```
Request Generate Code (Contract)
        │
        ▼
┌─────────────────────────────┐
│ Call SQL Function           │
│ generate_code(prefix, type) │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Extract Current Period      │
│ (Year/Month/Day)            │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Query Max Number for Period │
│ FROM generated_codes        │
│ WHERE period = current      │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Calculate Next Number       │
│ next_num = max_num + 1      │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Format Code                 │
│ HD2024-0001                 │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Insert Into Table           │
│ generated_codes             │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Return Code to Application  │
│ HD2024-0001                 │
└─────────────────────────────┘
```

### 10.4 Template Rendering Flow

```
User Creates Document
(Contract/Invoice/CT01)
        │
        ▼
┌──────────────────────────┐
│ Select Template          │
│ - HD Cho Thuê Nhân       │
│ - HD Gia Hạn             │
│ - HD Chuyển Nhượng       │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ Load Template Content    │
│ FROM templates table     │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ Extract Variables        │
│ {tenant_name}            │
│ {room_number}            │
│ {rent_price}             │
│ {contract_id}            │
│ ... etc                  │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ Fetch Data from DB       │
│ - Tenant info            │
│ - Room info              │
│ - Contract info          │
│ - Company info           │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ Replace Variables        │
│ Regex replace {xxx}      │
│ with actual values       │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ Generate Document        │
│ - HTML (preview)         │
│ - PDF (download)         │
│ - Print (printer)        │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│ User Options             │
│ [Preview] [Print] [Send] │
│ [Download] [Save]        │
└──────────────────────────┘
```

---

## 11. TESTING CHECKLIST

### 11.1 Settings Configuration Tests

- [ ] Company settings form submit successfully
- [ ] Logo upload works (max 2MB, PNG/JPG)
- [ ] Tax ID validation (format check)
- [ ] Business license expiry alert (< 3 months)
- [ ] E-Invoice toggle enables/disables correctly
- [ ] Contract settings checkboxes persist
- [ ] Invoice format code preview shows correctly
- [ ] Payment gateway credentials encrypted
- [ ] SMS provider connection test works

### 11.2 Template Management Tests

- [ ] Create new contract template
- [ ] Edit template content
- [ ] Delete template (confirmation dialog)
- [ ] Clone template to create variations
- [ ] Variable syntax highlighting works
- [ ] Template preview renders all variables
- [ ] Template PDF generation works
- [ ] Multiple languages supported
- [ ] Version history tracking
- [ ] Revert to previous version

### 11.3 Staff & Permission Tests

- [ ] Create new staff member
- [ ] Assign role (Admin, Manager, etc)
- [ ] Assign building (Manager can manage that building only)
- [ ] Reset password functionality
- [ ] 2FA setup for sensitive roles
- [ ] Permission matrix applied correctly
- [ ] View/Create/Edit/Delete restrictions work
- [ ] Approval workflow follows permission rules
- [ ] Building-based filtering in UI
- [ ] Audit log tracks staff actions

### 11.4 Code Generation Tests

- [ ] Contract code generates: HD2024-0001
- [ ] Invoice code generates: HĐ2024-11-0001 (with month)
- [ ] Code resets on new period
- [ ] Code is unique (no duplicates)
- [ ] Reset configuration persists
- [ ] Preview shows correct format
- [ ] Custom format configuration works
- [ ] Code retrieval by type
- [ ] Bulk code generation performance

### 11.5 Notification Tests

- [ ] Email notification sent correctly
- [ ] SMS sent to correct number
- [ ] Zalo OA message received
- [ ] Push notification on web/mobile
- [ ] Multiple recipients (email list)
- [ ] Template variables replaced correctly
- [ ] Notification scheduled for correct time
- [ ] Failed notifications logged
- [ ] Retry mechanism works
- [ ] Notification history tracked
- [ ] Unsubscribe link works (email)
- [ ] SMS character limit handling

### 11.6 Building Map Tests

- [ ] Grid view displays all rooms
- [ ] Room color coding correct (5 colors)
- [ ] Floor plan view loads SVG
- [ ] Click room shows details popup
- [ ] Hover shows room info
- [ ] Filter by status works
- [ ] Search room by number
- [ ] Zoom in/out functionality
- [ ] Export as image works
- [ ] Export as PDF works
- [ ] Touch events on mobile

### 11.7 CT01 Form Tests

- [ ] Form auto-fills from tenant data
- [ ] Form auto-fills from contract data
- [ ] Old address populated from previous contract
- [ ] New address populated from current apartment
- [ ] All required fields validation
- [ ] Date format correct (dd/mm/yyyy)
- [ ] PDF generation with all data
- [ ] PDF can be printed correctly
- [ ] Email sending with PDF attachment
- [ ] Save as draft functionality
- [ ] Form language switching (VI/EN/ZH)

### 11.8 Database Tests

- [ ] All settings tables created
- [ ] RLS policies applied correctly
- [ ] Foreign key constraints work
- [ ] Unique constraints enforced
- [ ] Indexes created for performance
- [ ] Default values work
- [ ] Timestamp auto-update works
- [ ] JSON fields validated
- [ ] Enum types enforced
- [ ] Backup/restore data intact

### 11.9 Performance Tests

- [ ] Settings page loads < 1 second
- [ ] Template list renders < 2 seconds (100+ templates)
- [ ] Staff list pagination works (50+ staff)
- [ ] Building map renders < 3 seconds (100+ rooms)
- [ ] Code generation < 100ms
- [ ] Template rendering < 500ms
- [ ] Notification sending async (not blocking UI)
- [ ] Database queries optimized with indexes
- [ ] Memory usage acceptable
- [ ] No memory leaks on page navigation

### 11.10 Security Tests

- [ ] Admin-only pages blocked for non-admin
- [ ] Manager can't access other building settings
- [ ] Staff can't edit settings
- [ ] Passwords hashed (bcrypt/argon2)
- [ ] 2FA codes expire after 5 minutes
- [ ] API keys encrypted in database
- [ ] No sensitive data in logs
- [ ] HTTPS enforced
- [ ] CSRF tokens on forms
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized input)
- [ ] Rate limiting on API endpoints

---

## TÓNG KẾT

Settings & Advanced Features Module cung cấp:

1. **Cấu hình toàn cầu** cho hệ thống
2. **Tự động hóa** thông qua code generation và notifications
3. **Tùy chỉnh cao** mẫu biểu, templates
4. **Quản lý nhân sự** với RBAC chi tiết
5. **Trực quan hóa** bằng building map
6. **Tính pháp lý** thông qua CT01 form

Hệ thống được thiết kế:
- **Flexible**: Dễ tùy chỉnh theo yêu cầu
- **Scalable**: Hỗ trợ nhiều tòa nhà, nhân viên
- **Secure**: RBAC, encryption, audit log
- **User-friendly**: Giao diện trực quan
- **Reliable**: Validation, error handling, logging

---

**Phiên bản**: 1.0
**Ngày cập nhật**: 2024-11-18
**Tác giả**: CRM Team
