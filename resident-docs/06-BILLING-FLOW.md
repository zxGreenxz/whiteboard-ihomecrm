# BILLING & FINANCIAL MANAGEMENT FLOW
## Quản lý tài chính, Hóa đơn, Thu tiền & Sổ quỹ

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Flow ghi chỉ số (Meter Reading)](#flow-ghi-chỉ-số-meter-reading)
3. [Flow lập hóa đơn (Create Invoice)](#flow-lập-hóa-đơn-create-invoice)
4. [Flow duyệt hóa đơn (Approve Invoice)](#flow-duyệt-hóa-đơn-approve-invoice)
5. [Flow thu tiền (Payment Collection)](#flow-thu-tiền-payment-collection)
6. [Hóa đơn & PDF Generation](#hóa-đơn--pdf-generation)
7. [Sổ quỹ (Cash Book)](#sổ-quỹ-cash-book)
8. [Reports & Analytics](#reports--analytics)
9. [Database Schema](#database-schema)
10. [Component Code Examples](#component-code-examples)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Xây dựng hệ thống quản lý tài chính hoàn chỉnh với các quy trình lập hóa đơn, duyệt, thu tiền và báo cáo tài chính

### Quy trình hàng tháng
```
Đầu kỳ (1-5 hàng tháng)
    │
    ├─→ 1. Ghi chỉ số điện/nước
    │   └─ Record readings → Auto calculate consumption
    │
    ├─→ 2. Lập hóa đơn (Auto/Manual)
    │   └─ Generate invoices for residents
    │
    ├─→ 3. Duyệt hóa đơn
    │   └─ Approve → Send notifications (Zalo/SMS)
    │
    ├─→ 4. Thu tiền (5-20 hàng tháng)
    │   ├─ Record payments
    │   ├─ Update invoice status
    │   └─ Cập nhật sổ quỹ
    │
    └─→ 5. Báo cáo (Cuối kỳ)
        ├─ Revenue report
        ├─ Debt aging
        └─ Cash flow statement
```

### Tech Stack
- **Supabase**: Database & RLS
- **React Hook Form + Zod**: Forms & validation
- **TanStack Query**: Data fetching
- **jsPDF/html2pdf**: PDF generation
- **Recharts**: Charts & analytics
- **date-fns**: Date handling

---

## 📍 FLOW GHI CHỈ SỐ (METER READING)

### User Journey

```
Vào danh sách phòng
    │
    ├─→ Chọn phòng (hoặc quét mã QR)
    │
    ├─→ Form ghi chỉ số:
    │   ├─ Loại: Điện/Nước/Gas (*)
    │   ├─ Chỉ số cũ (hiển thị auto)
    │   ├─ Chỉ số mới (*)
    │   ├─ Ngày ghi (default: hôm nay)
    │   └─ Ghi chú (optional)
    │
    ├─→ Auto calculate
    │   └─ Consumption = New - Old
    │
    ├─→ Validate
    │   ├─ Chỉ số mới > chỉ số cũ
    │   └─ Không lập lịch sử
    │
    ├─→ Lưu & xác nhận
    │   └─ Toast success
    │
    └─→ Danh sách readings → Sẵn sàng tính tiền
```

### API Flow

```typescript
// 1. GET readings for room in current month
GET /api/meter-readings?room_id=xxx&month=2025-11

// 2. POST new reading
POST /api/meter-readings {
  room_id: string
  utility_type: 'electricity' | 'water' | 'gas'
  reading_value: number
  reading_date: date
  notes?: string
  recorded_by: user_id
}

// 3. Auto calculate consumption
// Database trigger:
// consumption = reading_value - previous_reading_value
// price = consumption × unit_price

// 4. GET all readings for invoicing
GET /api/meter-readings/by-month?month=2025-11
```

### Database Tables

```sql
-- Meter readings
CREATE TABLE meter_readings (
  id uuid PRIMARY KEY,
  room_id uuid REFERENCES rooms,
  building_id uuid REFERENCES buildings,
  utility_type VARCHAR(20), -- electricity, water, gas
  previous_value DECIMAL,
  reading_value DECIMAL NOT NULL,
  consumption DECIMAL,
  reading_date DATE NOT NULL,
  recorded_by uuid REFERENCES auth.users,
  notes TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Create index for quick lookup
CREATE INDEX idx_meter_readings_room_month
ON meter_readings(room_id, DATE_TRUNC('month', reading_date));
```

---

## 📄 FLOW LẬP HÓA ĐƠN (CREATE INVOICE)

### User Journey - Auto Generate

```
Lịch biểu lập hóa đơn (cron job)
    │
    ├─→ Ngày lập: 1-5 hàng tháng
    │
    ├─→ Lệnh auto generate
    │   ├─ SELECT all active leases for month
    │   ├─ Fetch meter readings
    │   └─ Get pricing rules
    │
    ├─→ Tính toán từng phòng
    │   ├─ Rent amount (từ lease)
    │   ├─ Services:
    │   │  ├─ Electricity: consumption × price/unit
    │   │  ├─ Water: consumption × price/unit
    │   │  └─ Garbage/Internet: fixed
    │   ├─ Previous debt (nếu có)
    │   ├─ Discounts (nếu có)
    │   └─ Tax: (subtotal) × 10% (optional)
    │
    ├─→ Total = Rent + Services + Debt - Discount + Tax
    │
    ├─→ Set due_date = issue_date + 5 days
    │
    └─→ Tạo hóa đơn (status: DRAFT)
        └─ Sẵn sàng duyệt
```

### User Journey - Manual Create

```
Vào trang Invoices
    │
    ├─→ Click "Create Invoice"
    │
    ├─→ Form:
    │   ├─ Chọn phòng (*)
    │   ├─ Kỳ hóa đơn: từ - đến (*)
    │   ├─ Rent: auto-fill từ lease
    │   └─ Services:
    │      ├─ Electricity: reading × price (*)
    │      ├─ Water: reading × price (*)
    │      ├─ Garbage: fixed amount
    │      └─ Internet: fixed amount
    │   ├─ Previous debt (auto-fill)
    │   ├─ Discount amount & reason
    │   ├─ Tax rate (default 0%)
    │   └─ Due date (default +5 days)
    │
    ├─→ Preview total
    │
    └─→ Submit → Draft invoice
```

### Calculation Example

```
Invoice Item Calculation:
────────────────────────────
Rent (theo lease)              1,000,000 VND
Services:
  - Electricity: 100 kWh × 3,000 = 300,000 VND
  - Water: 20 m³ × 15,000      = 300,000 VND
  - Garbage (fixed)            = 50,000 VND
  - Internet (fixed)           = 200,000 VND
                    Subtotal   = 1,850,000 VND
Previous debt                  = 500,000 VND
Discount                       = 0 VND
Tax (10%)                      = (1,850,000) × 10% = 185,000 VND
────────────────────────────
TOTAL                          = 2,535,000 VND
Due date: 2025-12-05
```

### API & Database

```typescript
// 1. POST /api/invoices
POST /api/invoices {
  room_id: string
  building_id: string
  billing_period_from: date
  billing_period_to: date
  invoice_items: {
    item_type: string // rent, electricity, water, etc
    description: string
    quantity: number
    unit_price: number
    amount: number
  }[]
  previous_debt: number
  discount_amount: number
  discount_reason: string
  tax_rate: number // 0-100
  due_date: date
  issued_date: date
  notes?: string
}

// 2. Generate invoice (trigger or endpoint)
POST /api/invoices/generate-bulk {
  billing_period_from: date
  billing_period_to: date
  building_id?: string // null = all buildings
}

// 3. Database
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  invoice_number VARCHAR(50) UNIQUE,
  room_id uuid REFERENCES rooms,
  building_id uuid REFERENCES buildings,
  billing_period_from DATE,
  billing_period_to DATE,
  subtotal DECIMAL,
  previous_debt DECIMAL DEFAULT 0,
  discount_amount DECIMAL DEFAULT 0,
  discount_reason TEXT,
  tax_rate DECIMAL DEFAULT 0,
  tax_amount DECIMAL DEFAULT 0,
  total_amount DECIMAL,
  paid_amount DECIMAL DEFAULT 0,
  status VARCHAR(20), -- DRAFT, APPROVED, SENT, PAID, PARTIAL_PAID, OVERDUE
  issued_date DATE,
  due_date DATE,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY,
  invoice_id uuid REFERENCES invoices ON DELETE CASCADE,
  item_type VARCHAR(30), -- rent, electricity, water, etc
  description TEXT,
  quantity DECIMAL,
  unit_price DECIMAL,
  amount DECIMAL,
  created_at TIMESTAMP
);
```

---

## ✅ FLOW DUYỆT HÓA ĐƠN (APPROVE INVOICE)

### User Journey

```
Danh sách hóa đơn (DRAFT)
    │
    ├─→ Preview hóa đơn
    │   ├─ Hiển thị chi tiết items
    │   ├─ Tổng tiền
    │   └─ Thông tin phòng/cư dân
    │
    ├─→ Single Approve
    │   ├─ Click "Approve"
    │   ├─ Confirm dialog
    │   ├─ Update status: APPROVED
    │   ├─ Set approved_date & approved_by
    │   └─ Queue notification (Zalo/SMS - Phase 2)
    │
    ├─→ Bulk Approve
    │   ├─ Checkbox select (hoặc select all)
    │   ├─ Click "Approve Selected"
    │   ├─ Confirm dialog with count
    │   ├─ Batch update
    │   └─ Queue notifications
    │
    └─→ Status: APPROVED → Ready to send
```

### API Flow

```typescript
// 1. Single approve
POST /api/invoices/{id}/approve {
  approved_by: user_id
  approved_date: date (default: today)
}

// 2. Bulk approve
POST /api/invoices/approve-bulk {
  invoice_ids: string[]
  approved_by: user_id
}

// 3. Send notifications (Phase 2)
POST /api/notifications/send-invoices {
  invoice_ids: string[]
  notification_type: 'zalo' | 'sms' | 'both'
}
// Will call external services: Zalo ZNS, SMS Brandname
```

---

## 💰 FLOW THU TIỀN (PAYMENT COLLECTION)

### User Journey

```
Danh sách hóa đơn (APPROVED)
    │
    ├─→ Filter by status: PAID, PARTIAL_PAID, OVERDUE
    │
    ├─→ Click hóa đơn → Ghi nhận thanh toán
    │
    ├─→ Form ghi nhận tiền:
    │   ├─ Hóa đơn: (auto-fill)
    │   ├─ Tổng công nợ: (auto-fill)
    │   ├─ Số tiền thanh toán: (*)
    │   ├─ Phương thức: Tiền mặt / Chuyển khoản / Thẻ
    │   ├─ Ngân hàng/Tài khoản (nếu chuyển khoản)
    │   ├─ Mã giao dịch (nếu chuyển khoản)
    │   ├─ Ngày thanh toán: (default: today)
    │   └─ Ghi chú: (optional)
    │
    ├─→ Validate
    │   ├─ Số tiền > 0
    │   ├─ Số tiền ≤ tổng công nợ
    │   └─ Kiểm tra trùng mã giao dịch
    │
    ├─→ Tính toán:
    │   ├─ paid_amount += payment_amount
    │   ├─ remaining = total - paid_amount
    │   ├─ Status:
    │   │  ├─ remaining = 0 → PAID
    │   │  ├─ remaining > 0 → PARTIAL_PAID
    │   │  └─ overdue_days > 0 → OVERDUE
    │   └─ Update invoice status
    │
    ├─→ Record payment
    │   ├─ Create payment record
    │   ├─ Update cash book (receipts)
    │   └─ Auto reconciliation
    │
    └─→ Success → Báo cáo thanh toán
```

### Database Tables

```sql
CREATE TABLE payments (
  id uuid PRIMARY KEY,
  invoice_id uuid REFERENCES invoices,
  room_id uuid REFERENCES rooms,
  payment_amount DECIMAL NOT NULL,
  payment_method VARCHAR(30), -- cash, transfer, card
  payment_date DATE NOT NULL,
  bank_account VARCHAR(255),
  transaction_code VARCHAR(100) UNIQUE,
  received_by uuid REFERENCES auth.users,
  notes TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Update invoice when payment recorded
CREATE TRIGGER update_invoice_on_payment
AFTER INSERT ON payments
FOR EACH ROW
EXECUTE FUNCTION update_invoice_payment_status();

-- Cash book integration (receipts)
CREATE TABLE cash_book (
  id uuid PRIMARY KEY,
  building_id uuid REFERENCES buildings,
  transaction_date DATE NOT NULL,
  transaction_type VARCHAR(10), -- IN (receipts) or OUT (expenses)
  amount DECIMAL NOT NULL,
  description TEXT,
  related_invoice_id uuid REFERENCES invoices,
  related_payment_id uuid REFERENCES payments,
  payment_method VARCHAR(30),
  recorded_by uuid REFERENCES auth.users,
  created_at TIMESTAMP
);

CREATE INDEX idx_cash_book_date ON cash_book(transaction_date);
CREATE INDEX idx_cash_book_type ON cash_book(transaction_type);
```

---

## 📋 HÓA ĐƠN & PDF GENERATION

### Invoice Template

```html
┌─────────────────────────────────────────┐
│         CRM            │
│             HÓA ĐƠN DỊCH VỤ             │
├─────────────────────────────────────────┤
│ Invoice #: INV-2025-11-0001              │
│ Issued: 2025-11-15 | Due: 2025-11-20    │
├─────────────────────────────────────────┤
│ RESIDENT INFORMATION                    │
│ Name: Nguyễn Văn A                      │
│ Room: 101, Building A                   │
│ Phone: 0901234567                       │
├─────────────────────────────────────────┤
│ BILLING PERIOD: Nov 1 - Nov 30, 2025    │
├─────────────────────────────────────────┤
│ DESCRIPTION              QTY    AMOUNT   │
│ Rent (Month 11)          1   1,000,000  │
│ Electricity 100kWh      100    300,000  │
│ Water 20m³               20    300,000  │
│ Garbage Service          1     50,000   │
│ Internet                 1    200,000   │
│                      Subtotal 1,850,000 │
│ Previous Debt                  500,000 │
│ Discount                    (0)         │
│ Tax (10%)                    185,000    │
│                      TOTAL:   2,535,000 │
│                   PAID:           0     │
│                   DUE:       2,535,000  │
├─────────────────────────────────────────┤
│ PAYMENT INFO                            │
│ Bank: Vietcombank                       │
│ Account: 1020123456                     │
│ Swift: BFTVVNVX                         │
│                                         │
│ Contact: support@example.com           │
└─────────────────────────────────────────┘
```

### PDF Generation (React)

```typescript
// File: src/utils/pdf-generator.ts
import html2pdf from 'html2pdf.js';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

export async function generateInvoicePDF(invoice: Invoice, element: HTMLElement) {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
  });

  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const imgWidth = 210;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
  pdf.save(`Invoice-${invoice.invoice_number}.pdf`);
}

// Or use html2pdf for simpler approach
export function generateInvoicePDFSimple(element: HTMLElement, filename: string) {
  const options = {
    margin: 10,
    filename: `${filename}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' },
  };

  html2pdf().set(options).from(element).save();
}
```

---

## 📊 SỔ QUỸ (CASH BOOK)

### Cash Flow Management

```
Sổ Quỹ (Thu/Chi) hàng ngày:

┌──────────────────────────────────────────────────────┐
│ DATE   | TYPE | AMOUNT      | DESCRIPTION | BALANCE  │
├──────────────────────────────────────────────────────┤
│ 11/01  | IN   | 5,000,000   | Rent (10 rooms) | +5M   │
│ 11/01  | IN   | 2,000,000   | Electricity     | +7M   │
│ 11/02  | OUT  | 1,500,000   | Maintenance     | +5.5M │
│ 11/05  | IN   | 3,000,000   | Partial payment | +8.5M │
│ 11/10  | OUT  | 500,000     | Staff salary    | +8M   │
│ ...    | ...  | ...         | ...             | ...   │
├──────────────────────────────────────────────────────┤
│ TOTAL INFLOWS                    | 25,000,000       │
│ TOTAL OUTFLOWS                   | 5,000,000        │
│ NET CASH FLOW (Month)            | 20,000,000       │
│ CLOSING BALANCE                  | 20,000,000       │
└──────────────────────────────────────────────────────┘
```

### API & Database

```typescript
// POST /api/cash-book
POST /api/cash-book {
  building_id: string
  transaction_date: date
  transaction_type: 'IN' | 'OUT'
  amount: number
  description: string
  payment_method: string // cash, transfer, etc
  related_invoice_id?: string
  related_payment_id?: string
  recorded_by: user_id
}

// GET /api/cash-book/balance?building_id=xxx&date=2025-11-30
GET /api/cash-book/report {
  building_id: string
  from_date: date
  to_date: date
}

// Response:
{
  total_inflows: number
  total_outflows: number
  net_cash_flow: number
  opening_balance: number
  closing_balance: number
  transactions: CashBookTransaction[]
}
```

---

## 📈 REPORTS & ANALYTICS

### Available Reports

```
1. REVENUE REPORT (Doanh thu)
   ├─ Total rent collected
   ├─ Utilities collected (electricity, water, etc)
   ├─ By building / by period
   └─ Trend chart (month-over-month)

2. DEBT AGING REPORT (Công nợ quá hạn)
   ├─ Current month overdue
   ├─ 30-60 days overdue
   ├─ 60-90 days overdue
   ├─ 90+ days overdue
   └─ List of residents with debt

3. CASH FLOW STATEMENT
   ├─ Opening balance
   ├─ Inflows by source
   ├─ Outflows by category
   ├─ Net cash flow
   └─ Closing balance

4. PAYMENT STATUS REPORT
   ├─ PAID (collected)
   ├─ PARTIAL_PAID
   ├─ PENDING
   ├─ OVERDUE
   └─ Collection rate %

5. OCCUPANCY & COLLECTION RATE
   ├─ Total units / occupied units
   ├─ Occupancy rate %
   ├─ Collection rate %
   └─ Average payment days
```

---

## 💾 DATABASE SCHEMA

### Key Tables

```sql
-- Invoices
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id),
  building_id uuid NOT NULL REFERENCES buildings(id),
  billing_period_from DATE NOT NULL,
  billing_period_to DATE NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  previous_debt DECIMAL(10,2) DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  discount_reason TEXT,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  total_amount DECIMAL(10,2) NOT NULL,
  paid_amount DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  issued_date DATE,
  due_date DATE,
  approved_date DATE,
  approved_by uuid REFERENCES auth.users,
  created_by uuid NOT NULL REFERENCES auth.users,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'PAID', 'PARTIAL_PAID', 'OVERDUE'))
);

-- Invoice items
CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_type VARCHAR(30) NOT NULL,
  description TEXT,
  quantity DECIMAL(10,2),
  unit_price DECIMAL(10,2),
  amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Meter readings
CREATE TABLE meter_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id),
  building_id uuid NOT NULL REFERENCES buildings(id),
  utility_type VARCHAR(20) NOT NULL,
  previous_value DECIMAL(10,2),
  reading_value DECIMAL(10,2) NOT NULL,
  consumption DECIMAL(10,2),
  reading_date DATE NOT NULL,
  recorded_by uuid NOT NULL REFERENCES auth.users,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payments
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  room_id uuid NOT NULL REFERENCES rooms(id),
  payment_amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(30),
  payment_date DATE NOT NULL,
  bank_account VARCHAR(255),
  transaction_code VARCHAR(100),
  received_by uuid NOT NULL REFERENCES auth.users,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Cash book
CREATE TABLE cash_book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES buildings(id),
  transaction_date DATE NOT NULL,
  transaction_type VARCHAR(10) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  description TEXT,
  related_invoice_id uuid REFERENCES invoices(id),
  related_payment_id uuid REFERENCES payments(id),
  payment_method VARCHAR(30),
  recorded_by uuid NOT NULL REFERENCES auth.users,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_date_type (transaction_date, transaction_type),
  CONSTRAINT valid_type CHECK (transaction_type IN ('IN', 'OUT'))
);

-- Pricing rules
CREATE TABLE utility_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES buildings(id),
  utility_type VARCHAR(20) NOT NULL,
  unit VARCHAR(20),
  price_per_unit DECIMAL(10,2) NOT NULL,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(building_id, utility_type, effective_from)
);
```

---

## 💻 COMPONENT CODE EXAMPLES

### InvoiceForm Component

```typescript
// src/components/billing/InvoiceForm.tsx
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const invoiceSchema = z.object({
  room_id: z.string().min(1, 'Vui lòng chọn phòng'),
  billing_period_from: z.string().min(1),
  billing_period_to: z.string().min(1),
  items: z.array(z.object({
    item_type: z.string(),
    description: z.string(),
    quantity: z.number().positive(),
    unit_price: z.number().positive(),
    amount: z.number().positive(),
  })).min(1),
  previous_debt: z.number().default(0),
  discount_amount: z.number().default(0),
  tax_rate: z.number().default(0),
  due_date: z.string().min(1),
});

type InvoiceFormData = z.infer<typeof invoiceSchema>;

export function InvoiceForm() {
  const { register, control, watch, handleSubmit, formState: { errors } } = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      items: [{ item_type: 'rent', description: '', quantity: 1, unit_price: 0 }],
      previous_debt: 0,
      discount_amount: 0,
      tax_rate: 0,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'items',
  });

  const items = watch('items');
  const subtotal = items.reduce((sum, item) => sum + (item.amount || 0), 0);
  const previousDebt = watch('previous_debt');
  const discount = watch('discount_amount');
  const taxRate = watch('tax_rate');
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + previousDebt - discount + taxAmount;

  const onSubmit = async (data: InvoiceFormData) => {
    // API call to create invoice
    console.log('Creating invoice:', data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="room_id">Phòng *</Label>
          <select id="room_id" {...register('room_id')} className="w-full border rounded px-3 py-2">
            <option value="">-- Chọn phòng --</option>
            <option value="101">101 - Nguyễn Văn A</option>
            <option value="102">102 - Trần Thị B</option>
          </select>
          {errors.room_id && <p className="text-sm text-red-500">{errors.room_id.message}</p>}
        </div>

        <div>
          <Label htmlFor="due_date">Ngày hết hạn</Label>
          <Input id="due_date" type="date" {...register('due_date')} />
        </div>
      </div>

      <div className="border-t pt-4">
        <h3 className="font-semibold mb-4">Hạng mục hóa đơn</h3>
        {fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-5 gap-2 mb-2">
            <Input placeholder="Item type" {...register(`items.${index}.item_type`)} />
            <Input placeholder="Description" {...register(`items.${index}.description`)} />
            <Input type="number" placeholder="Qty" {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
            <Input type="number" placeholder="Price" {...register(`items.${index}.unit_price`, { valueAsNumber: true })} />
            <Button type="button" variant="destructive" onClick={() => remove(index)}>Xóa</Button>
          </div>
        ))}
        <Button type="button" variant="outline" onClick={() => append({ item_type: '', description: '', quantity: 1, unit_price: 0 })}>
          Thêm hạng mục
        </Button>
      </div>

      <div className="bg-gray-50 p-4 rounded space-y-2">
        <div className="flex justify-between">
          <span>Subtotal:</span>
          <span>{subtotal.toLocaleString()} VND</span>
        </div>
        <div className="flex justify-between">
          <span>Công nợ trước:</span>
          <span>{previousDebt.toLocaleString()} VND</span>
        </div>
        <div className="flex justify-between">
          <span>Giảm giá:</span>
          <span>-{discount.toLocaleString()} VND</span>
        </div>
        <div className="flex justify-between">
          <span>Thuế ({taxRate}%):</span>
          <span>{taxAmount.toLocaleString()} VND</span>
        </div>
        <div className="border-t pt-2 flex justify-between font-bold text-lg">
          <span>Tổng cộng:</span>
          <span>{total.toLocaleString()} VND</span>
        </div>
      </div>

      <Button type="submit" className="w-full">Lập hóa đơn</Button>
    </form>
  );
}
```

### PaymentForm Component

```typescript
// src/components/billing/PaymentForm.tsx
const paymentSchema = z.object({
  payment_amount: z.number().positive('Số tiền phải lớn hơn 0'),
  payment_method: z.enum(['cash', 'transfer', 'card']),
  payment_date: z.string().min(1),
  transaction_code: z.string().optional(),
  notes: z.string().optional(),
});

export function PaymentForm({ invoiceId, totalDue }: { invoiceId: string; totalDue: number }) {
  const { register, watch, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(paymentSchema),
  });

  const paymentAmount = watch('payment_amount');
  const remaining = totalDue - (paymentAmount || 0);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <Label>Tổng công nợ: {totalDue.toLocaleString()} VND</Label>
      </div>

      <div>
        <Label htmlFor="payment_amount">Số tiền thanh toán *</Label>
        <Input id="payment_amount" type="number" {...register('payment_amount', { valueAsNumber: true })} />
        {errors.payment_amount && <p className="text-sm text-red-500">{errors.payment_amount.message}</p>}
      </div>

      <div className="bg-blue-50 p-3 rounded">
        <p>Còn lại: {remaining.toLocaleString()} VND</p>
      </div>

      <div>
        <Label htmlFor="payment_method">Phương thức thanh toán</Label>
        <select id="payment_method" {...register('payment_method')} className="w-full border rounded px-3 py-2">
          <option value="cash">Tiền mặt</option>
          <option value="transfer">Chuyển khoản</option>
          <option value="card">Thẻ</option>
        </select>
      </div>

      <Button type="submit" className="w-full">Ghi nhận thanh toán</Button>
    </form>
  );
}
```

---

## 🔌 API INTEGRATION

### Endpoints Summary

```
METER READINGS:
POST   /api/meter-readings              Create reading
GET    /api/meter-readings              List readings (with filters)
GET    /api/meter-readings/{id}         Get detail
PUT    /api/meter-readings/{id}         Update reading
DELETE /api/meter-readings/{id}         Delete reading

INVOICES:
POST   /api/invoices                    Create invoice
POST   /api/invoices/generate-bulk      Auto generate
GET    /api/invoices                    List invoices (with filters)
GET    /api/invoices/{id}               Get detail
PUT    /api/invoices/{id}               Update invoice
POST   /api/invoices/{id}/approve       Approve single
POST   /api/invoices/approve-bulk       Approve multiple
GET    /api/invoices/{id}/pdf           Download PDF

PAYMENTS:
POST   /api/payments                    Record payment
GET    /api/payments                    List payments
GET    /api/payments/{id}               Get detail

CASH BOOK:
POST   /api/cash-book                   Record transaction
GET    /api/cash-book                   List transactions
GET    /api/cash-book/balance           Get balance
GET    /api/cash-book/report            Generate report

REPORTS:
GET    /api/reports/revenue             Revenue report
GET    /api/reports/debt-aging          Debt aging report
GET    /api/reports/cash-flow           Cash flow statement
GET    /api/reports/collection-rate     Collection rate
```

---

## 📝 NOTES

### Business Rules
1. Invoice number: auto-generated (prefix + year-month + sequence)
2. Default due date: issue_date + 5 days (configurable)
3. Overdue status: when due_date is past
4. Previous debt carries over until fully paid
5. Tax is optional, configurable per building
6. Discounts require reason/approval

### Validation Rules
- Reading value must be > previous reading
- Payment cannot exceed remaining balance
- Invoice must be APPROVED before recording payment
- Invoices must have at least one item

### Phase 2 Features
- Automatic Zalo ZNS/SMS notifications
- Email invoice delivery
- Automatic dunning (reminder messages)
- Payment plan/installment support
- Late fee calculation

---

## 🎯 NEXT STEPS

1. ✅ Complete billing module implementation
2. ✅ Setup database triggers for auto-calculations
3. 📄 Continue to [07-RESIDENT-MANAGEMENT.md](./07-RESIDENT-MANAGEMENT.md)
4. 🔜 Implement PDF generation & email delivery
5. 🔜 Add Zalo/SMS notifications (Phase 2)
6. 🔜 Create dashboard with charts & analytics

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [05-LEASE-MANAGEMENT.md](./05-LEASE-MANAGEMENT.md) | **Next**: [07-RESIDENT-MANAGEMENT.md](./07-RESIDENT-MANAGEMENT.md)
