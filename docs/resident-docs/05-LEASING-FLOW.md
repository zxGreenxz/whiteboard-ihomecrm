# LEASING FLOW
## Quản lý Hợp đồng Thuê (Check-in, Extend, Transfer, Check-out)

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Vòng đời hợp đồng](#vòng-đời-hợp-đồng)
3. [Flow tạo hợp đồng mới (Check-in)](#flow-tạo-hợp-đồng-mới-check-in)
4. [Flow gia hạn hợp đồng (Extend)](#flow-gia-hạn-hợp-đồng-extend)
5. [Flow chuyển phòng (Transfer Room)](#flow-chuyển-phòng-transfer-room)
6. [Flow nhượng hợp đồng (Transfer Contract)](#flow-nhượng-hợp-đồng-transfer-contract)
7. [Flow thanh lý (Check-out/Terminate)](#flow-thanh-lý-check-outterminate)
8. [Quản lý khách thuê (Tenants)](#quản-lý-khách-thuê-tenants)
9. [Component code examples](#component-code-examples)
10. [Business logic calculations](#business-logic-calculations)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Xây dựng hệ thống quản lý hợp đồng thuê linh hoạt hỗ trợ toàn bộ vòng đời từ ký kết đến thanh lý.

### Tính năng chính
- ✅ Tạo hợp đồng mới (Check-in) với thông tin phòng, khách thuê, giá thuê
- ✅ Gia hạn hợp đồng (Extend) tự động cập nhật ngày kết thúc
- ✅ Chuyển phòng (Transfer room) liên kết hợp đồng với phòng mới
- ✅ Nhượng hợp đồng (Transfer contract) cho khách thuê mới
- ✅ Thanh lý (Check-out) tính tiền, hoàn trả tiền cọc
- ✅ Quản lý khách thuê (tạo mới/chọn hiện có)
- ✅ Tính toán dịch vụ, giảm giá, tiền cọc
- ✅ Quản lý chỉ số công tơ (initial/final reading)

### Trạng thái hợp đồng
```
DRAFT → ACTIVE → EXTENDING/TRANSFERRING → TERMINATING → TERMINATED
```

### Tech Stack
- **Supabase**: Database + RLS
- **React Hook Form**: Form handling
- **Zod**: Validation
- **TanStack Query**: State management
- **UI Components**: shadcn/ui

---

## 🔄 VÒNG ĐỜI HỢP ĐỒNG

```
[Tạo mới]
    │
    ├─→ DRAFT (Dự thảo)
    │   ├─ Nhập thông tin
    │   ├─ Validate
    │   └─ Lưu
    │
    ├─→ ACTIVE (Hoạt động)
    │   ├─ Hết hạn?
    │   │  └─ Gia hạn (EXTEND)
    │   │
    │   ├─ Đổi phòng?
    │   │  └─ Chuyển phòng (TRANSFER_ROOM)
    │   │
    │   ├─ Thay khách?
    │   │  └─ Nhượng hợp đồng (TRANSFER_CONTRACT)
    │   │
    │   └─ Kết thúc?
    │      └─ Thanh lý (TERMINATE)
    │
    └─→ TERMINATED (Kết thúc)
        ├─ Hoàn lại tiền cọc
        ├─ Tính phí cuối cùng
        └─ Lưu hóa đơn cuối
```

---

## 📝 FLOW TẠO HỢP ĐỒNG MỚI (CHECK-IN)

### User Journey

```
Vào trang Create Contract
      │
      ├─→ Bước 1: Select Room/Bed
      │   ├─ Chọn Building → Property → Room → Bed
      │   ├─ Kiểm tra trạng thái còn trống
      │   └─ Tiếp tục
      │
      ├─→ Bước 2: Tenant Info
      │   ├─ Tạo khách thuê mới hoặc chọn hiện có
      │   ├─ Nhập: full_name, phone, email, id_type, id_number
      │   └─ Tiếp tục
      │
      ├─→ Bước 3: Contract Dates
      │   ├─ Ngày ký (signed_date)
      │   ├─ Ngày bắt đầu (start_date)
      │   ├─ Ngày kết thúc (end_date)
      │   └─ Tính toán thời hạn
      │
      ├─→ Bước 4: Pricing & Payment
      │   ├─ Giá thuê (rent_price)
      │   ├─ Chu kỳ thanh toán (payment_cycle: MONTHLY/QUARTERLY)
      │   ├─ Chọn dịch vụ (services: điện, nước, internet)
      │   └─ Tính tổng giá
      │
      ├─→ Bước 5: Deposit & Discounts
      │   ├─ Tổng tiền cọc (total_deposit)
      │   ├─ Tiền cọc đã trả (deposit_paid)
      │   ├─ Còn nợ (remaining_deposit)
      │   ├─ Giảm giá (discounts[]: JSONB array)
      │   │  ├─ type: 'FIRST_MONTH' | 'LOYALTY' | 'PROMOTION'
      │   │  ├─ amount: 100000
      │   │  └─ description: 'Giảm tháng đầu'
      │   └─ Tính tổng chỉ phí
      │
      ├─→ Bước 6: Initial Meter Readings
      │   ├─ Chỉ số điện (electric_reading)
      │   ├─ Chỉ số nước (water_reading)
      │   └─ Lưu (cho tính toán thanh lý)
      │
      ├─→ Review & Confirm
      │   └─ Ký hợp đồng
      │
      └─→ Thành công
          └─ Redirect → Contract Detail
```

### Database Schema - contracts Table

```typescript
interface Contract {
  id: string;
  property_id: string;
  room_id: string;
  bed_id?: string;
  tenant_id: string;

  // Dates
  signed_date: Date;
  start_date: Date;
  end_date: Date;

  // Pricing
  rent_price: number;
  payment_cycle: 'MONTHLY' | 'QUARTERLY';
  service_ids: string[]; // References to services

  // Deposit
  total_deposit: number;
  deposit_paid: number;
  remaining_deposit: number;

  // Discounts (JSONB)
  discounts: Array<{
    id: string;
    type: 'FIRST_MONTH' | 'LOYALTY' | 'PROMOTION';
    amount: number;
    description: string;
  }>;

  // Meter readings
  initial_electric_reading: number;
  initial_water_reading: number;

  // Status
  status: 'DRAFT' | 'ACTIVE' | 'EXTENDING' | 'TRANSFERRING' | 'TERMINATING' | 'TERMINATED';
  notes?: string;

  // Audit
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}
```

### Validation Rules

```typescript
const createContractSchema = z.object({
  room_id: z.string().min(1, 'Vui lòng chọn phòng'),
  tenant_id: z.string().min(1, 'Vui lòng chọn/tạo khách thuê'),
  signed_date: z.date(),
  start_date: z.date(),
  end_date: z.date(),
  rent_price: z.number().min(0, 'Giá thuê phải > 0'),
  payment_cycle: z.enum(['MONTHLY', 'QUARTERLY']),
  service_ids: z.array(z.string()),
  total_deposit: z.number().min(0),
  deposit_paid: z.number().min(0),
  discounts: z.array(z.object({
    type: z.enum(['FIRST_MONTH', 'LOYALTY', 'PROMOTION']),
    amount: z.number().min(0),
    description: z.string(),
  })),
}).refine((data) => data.end_date > data.start_date, {
  message: "Ngày kết thúc phải sau ngày bắt đầu",
  path: ["end_date"],
});
```

### Create Contract Handler

```typescript
async function createContract(data: CreateContractInput) {
  // 1. Validate input
  const validated = createContractSchema.parse(data);

  // 2. Check room availability
  const room = await supabase
    .from('rooms')
    .select('status')
    .eq('id', validated.room_id)
    .single();

  if (room.status !== 'VACANT') {
    throw new Error('Phòng không còn trống');
  }

  // 3. Calculate total amount
  const totalAmount = calculateTotalAmount(validated);

  // 4. Create contract
  const { data: contract, error } = await supabase
    .from('contracts')
    .insert({
      ...validated,
      total_amount: totalAmount,
      status: 'ACTIVE',
      created_by: user.id,
    })
    .select()
    .single();

  if (error) throw error;

  // 5. Update room status
  await supabase
    .from('rooms')
    .update({ status: 'OCCUPIED' })
    .eq('id', validated.room_id);

  // 6. Create initial invoice
  await createInitialInvoice(contract);

  return contract;
}
```

---

## 🔄 FLOW GIA HẠN HỢP ĐỒNG (EXTEND)

```
Vào Contract Detail
      │
      ├─→ Click "Gia hạn hợp đồng"
      │
      ├─→ Modal: Nhập ngày kết thúc mới
      │   ├─ Ngày kết thúc cũ: 2025-11-30
      │   ├─ Ngày kết thúc mới: 2026-02-28
      │   └─ Tính kỳ hạn mới
      │
      ├─→ Tính toán
      │   ├─ Ngày gia hạn
      │   ├─ Tạo invoice gia hạn
      │   └─ Cập nhật end_date
      │
      └─→ Thành công
          └─ Refresh contract
```

**Backend Logic**:
```typescript
async function extendContract(contractId: string, newEndDate: Date) {
  const contract = await getContract(contractId);

  // Calculate extension period
  const extensionMonths = calculateMonths(contract.end_date, newEndDate);

  // Create extension invoice
  const extensionAmount = contract.rent_price * extensionMonths;

  // Update contract
  await supabase
    .from('contracts')
    .update({
      end_date: newEndDate,
      updated_by: user.id,
      updated_at: new Date(),
    })
    .eq('id', contractId);

  // Create invoice
  await supabase.from('invoices').insert({
    contract_id: contractId,
    type: 'EXTENSION',
    amount: extensionAmount,
    due_date: contract.end_date,
    status: 'PENDING',
  });
}
```

---

## 🚚 FLOW CHUYỂN PHÒNG (TRANSFER ROOM)

```
Contract Detail → "Chuyển phòng"
      │
      ├─→ Chọn phòng mới
      │
      ├─→ Ngày chuyển
      │
      ├─→ Tính toán
      │   ├─ Hoàn tiền phòng cũ (tính theo ngày)
      │   ├─ Tiền phòng mới
      │   └─ Điều chỉnh tiền cọc (nếu cần)
      │
      └─→ Cập nhật
          ├─ Phòng cũ → VACANT
          └─ Phòng mới → OCCUPIED
```

---

## 👤 FLOW NHƯỢNG HỢP ĐỒNG (TRANSFER CONTRACT)

```
Contract Detail → "Nhượng hợp đồng"
      │
      ├─→ Chọn khách thuê mới
      │   ├─ Tạo mới hoặc từ danh sách
      │   └─ Verify thông tin
      │
      ├─→ Điều chỉnh
      │   ├─ Giá thuê (nếu cần)
      │   ├─ Điều khoản mới
      │   └─ Phí chuyển nhượng (nếu có)
      │
      └─→ Cập nhật
          └─ Hợp đồng → tenant_id mới
```

---

## 🔚 FLOW THANH LÝ (CHECK-OUT/TERMINATE)

### User Journey

```
Contract Detail → "Thanh lý"
      │
      ├─→ Bước 1: Ngày thanh lý
      │   └─ Nhập ngày thanh lý (termination_date)
      │
      ├─→ Bước 2: Chỉ số cuối
      │   ├─ Chỉ số điện cuối (final_electric_reading)
      │   ├─ Chỉ số nước cuối (final_water_reading)
      │   └─ Kiểm tra hành lang/phòng
      │
      ├─→ Bước 3: Tính toán
      │   ├─ Tiền thuê còn lại (remaining_rent)
      │   ├─ Phí dịch vụ chưa thanh toán
      │   ├─ Chi phí điện, nước phát sinh
      │   ├─ Tổng nợ (total_owed)
      │   └─ Tiền hoàn lại (refund)
      │
      ├─→ Bước 4: Xác nhận
      │   ├─ Review tất cả số liệu
      │   └─ Confirm thanh lý
      │
      └─→ Thành công
          ├─ Tạo hóa đơn cuối
          ├─ Cập nhật room → VACANT
          └─ Hợp đồng → TERMINATED
```

### Calculation Logic

```typescript
interface TerminationCalculation {
  contract_id: string;
  termination_date: Date;
  final_electric_reading: number;
  final_water_reading: number;

  // Calculated fields
  days_occupied: number;
  daily_rent: number;
  remaining_rent: number;
  unpaid_service_fees: number;
  electric_charges: number;
  water_charges: number;
  other_charges: number; // Damage, cleaning, etc.
  total_charges: number;
  deposit_refund: number;
  final_payment: number; // Total charges - deposit
}

function calculateTermination(contract, readings): TerminationCalculation {
  const today = readings.termination_date;
  const daysOccupied = daysBetween(contract.start_date, today);
  const dailyRent = contract.rent_price / 30; // Average per day

  // Calculate remaining rent (if terminate early)
  const contractDays = daysBetween(contract.start_date, contract.end_date);
  const remainingDays = Math.max(0, contract.end_date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  const remainingRent = remainingDays > 0 ? dailyRent * remainingDays : 0;

  // Get unpaid invoices
  const unpaidInvoices = await getUnpaidInvoices(contract.id);
  const unpaidAmount = unpaidInvoices.reduce((sum, inv) => sum + inv.amount, 0);

  // Calculate utility charges
  const electricCharge = (readings.final_electric_reading - contract.initial_electric_reading) * ELECTRIC_RATE;
  const waterCharge = (readings.final_water_reading - contract.initial_water_reading) * WATER_RATE;

  // Calculate total
  const totalCharges = remainingRent + unpaidAmount + electricCharge + waterCharge;
  const depositRefund = Math.max(0, contract.total_deposit - totalCharges);
  const finalPayment = Math.max(0, totalCharges - contract.total_deposit);

  return {
    days_occupied: daysOccupied,
    daily_rent: dailyRent,
    remaining_rent: remainingRent,
    unpaid_service_fees: unpaidAmount,
    electric_charges: electricCharge,
    water_charges: waterCharge,
    total_charges: totalCharges,
    deposit_refund: depositRefund,
    final_payment: finalPayment,
  };
}
```

---

## 👥 QUẢN LÝ KHÁCH THUÊ (TENANTS)

### Tenant Schema

```typescript
interface Tenant {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  id_type: 'CCCD' | 'PASSPORT' | 'DRIVER_LICENSE';
  id_number: string;
  date_of_birth?: Date;
  address?: string;
  notes?: string;
  active_contracts: number;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: Date;
}
```

### Create/Select Tenant

```typescript
// Dialog in contract creation
<TenantSelector
  onSelect={(tenant) => {
    setFormData({ ...formData, tenant_id: tenant.id });
  }}
  onCreateNew={(data) => {
    // Create new tenant
    const newTenant = await createTenant(data);
    setFormData({ ...formData, tenant_id: newTenant.id });
  }}
/>
```

---

## 💻 COMPONENT CODE EXAMPLES

### CreateContractWizard Component

```typescript
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CreateContractWizard() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({});

  const totalSteps = 6;

  const handleNext = () => {
    if (step < totalSteps) setStep(step + 1);
  };

  const handlePrev = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    try {
      const result = await createContract(formData);
      toast.success('Tạo hợp đồng thành công!');
      navigate(`/contracts/${result.id}`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Tạo hợp đồng mới</h1>
        <div className="flex items-center gap-2">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-2 flex-1 rounded-full ${
                i + 1 <= step ? 'bg-blue-500' : 'bg-gray-200'
              }`}
            />
          ))}
        </div>
        <p className="text-sm text-gray-600 mt-2">
          Bước {step}/{totalSteps}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {step === 1 && 'Chọn phòng/giường'}
            {step === 2 && 'Thông tin khách thuê'}
            {step === 3 && 'Ngày hợp đồng'}
            {step === 4 && 'Giá thuê & dịch vụ'}
            {step === 5 && 'Tiền cọc & giảm giá'}
            {step === 6 && 'Chỉ số ban đầu'}
          </CardTitle>
          <CardDescription>
            {step === 1 && 'Chọn phòng hoặc giường mà khách sẽ thuê'}
            {step === 2 && 'Nhập thông tin khách thuê'}
            {step === 3 && 'Nhập ngày ký kết, bắt đầu, kết thúc'}
            {step === 4 && 'Nhập giá thuê hàng tháng và dịch vụ'}
            {step === 5 && 'Nhập tiền cọc và giảm giá (nếu có)'}
            {step === 6 && 'Nhập chỉ số điện nước ban đầu'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {step === 1 && <RoomSelector value={formData.room_id} onChange={(id) => setFormData({ ...formData, room_id: id })} />}
          {step === 2 && <TenantForm value={formData.tenant_id} onChange={(id) => setFormData({ ...formData, tenant_id: id })} />}
          {step === 3 && <DateForm data={formData} onChange={setFormData} />}
          {step === 4 && <PricingForm data={formData} onChange={setFormData} />}
          {step === 5 && <DepositForm data={formData} onChange={setFormData} />}
          {step === 6 && <MeterReadingForm data={formData} onChange={setFormData} />}

          <div className="flex justify-between gap-4 pt-6">
            <Button
              variant="outline"
              onClick={handlePrev}
              disabled={step === 1}
            >
              Quay lại
            </Button>
            {step < totalSteps ? (
              <Button onClick={handleNext}>
                Tiếp tục →
              </Button>
            ) : (
              <Button onClick={handleSubmit} className="bg-green-600 hover:bg-green-700">
                Hoàn tất
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

### TerminationModal Component

```typescript
export function TerminationModal({ contract, onClose }) {
  const [loading, setLoading] = useState(false);
  const [calculation, setCalculation] = useState(null);
  const form = useForm({
    resolver: zodResolver(terminationSchema),
  });

  const onSubmit = async (data) => {
    setLoading(true);
    try {
      // Calculate termination
      const calc = await calculateTermination(contract.id, data);
      setCalculation(calc);
    } finally {
      setLoading(false);
    }
  };

  if (calculation) {
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Xác nhận thanh lý hợp đồng</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <TerminationSummary calculation={calculation} />

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="font-bold text-lg text-blue-900">
                {calculation.final_payment > 0
                  ? `Khách còn nợ: ${formatCurrency(calculation.final_payment)}`
                  : `Hoàn lại: ${formatCurrency(calculation.deposit_refund)}`}
              </p>
            </div>

            <div className="flex gap-4">
              <Button variant="outline" onClick={() => setCalculation(null)}>
                Quay lại
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700"
                onClick={() => confirmTermination(contract.id, calculation)}
              >
                Xác nhận thanh lý
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thanh lý hợp đồng</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label>Ngày thanh lý *</Label>
            <Input type="date" {...form.register('termination_date')} />
          </div>

          <div>
            <Label>Chỉ số điện cuối *</Label>
            <Input type="number" {...form.register('final_electric_reading')} />
          </div>

          <div>
            <Label>Chỉ số nước cuối *</Label>
            <Input type="number" {...form.register('final_water_reading')} />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Đang tính toán...' : 'Tính toán'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

---

## 📊 BUSINESS LOGIC CALCULATIONS

### Helper Functions

```typescript
// Calculate months between dates
function calculateMonths(startDate: Date, endDate: Date): number {
  const months = (endDate.getFullYear() - startDate.getFullYear()) * 12
    + (endDate.getMonth() - startDate.getMonth());
  return Math.max(1, months);
}

// Calculate total contract amount
function calculateTotalAmount(contract) {
  const months = calculateMonths(contract.start_date, contract.end_date);
  const rentAmount = contract.rent_price * months;
  const serviceAmount = contract.services.reduce((sum, svc) => sum + svc.price, 0);
  const discountAmount = contract.discounts.reduce((sum, disc) => sum + disc.amount, 0);
  return rentAmount + serviceAmount - discountAmount;
}

// Calculate deposit remaining
function calculateRemainingDeposit(contract) {
  return Math.max(0, contract.total_deposit - contract.deposit_paid);
}

// Days between dates
function daysBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

// Format currency (VND)
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
}

// Calculate invoice due date
function calculateDueDate(contract, invoiceType = 'RENT'): Date {
  if (invoiceType === 'RENT') {
    // Due on start of next month
    return new Date(contract.start_date.getFullYear(), contract.start_date.getMonth() + 1, 1);
  }
  return new Date();
}
```

### Constants

```typescript
export const LEASING_CONSTANTS = {
  ELECTRIC_RATE: 3500, // VND per kWh
  WATER_RATE: 25000, // VND per m³
  PAYMENT_CYCLES: {
    MONTHLY: 'MONTHLY',
    QUARTERLY: 'QUARTERLY',
  },
  CONTRACT_STATUS: {
    DRAFT: 'DRAFT',
    ACTIVE: 'ACTIVE',
    EXTENDING: 'EXTENDING',
    TRANSFERRING: 'TRANSFERRING',
    TERMINATING: 'TERMINATING',
    TERMINATED: 'TERMINATED',
  },
  INVOICE_TYPES: {
    RENT: 'RENT',
    SERVICE: 'SERVICE',
    EXTENSION: 'EXTENSION',
    ADJUSTMENT: 'ADJUSTMENT',
  },
  DISCOUNT_TYPES: {
    FIRST_MONTH: 'FIRST_MONTH',
    LOYALTY: 'LOYALTY',
    PROMOTION: 'PROMOTION',
  },
};
```

---

## 🎯 NEXT STEPS

1. ✅ Define leasing flow and states
2. 📄 Implement database schema
3. 🔜 Build API endpoints
4. 🔜 Create React components
5. 🔜 Add validation and error handling
6. 🔜 Implement financial calculations
7. 🔜 Add invoice generation

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [04-INVOICING-PAYMENTS.md](./04-INVOICING-PAYMENTS.md) | **Next**: [06-MAINTENANCE-REQUESTS.md](./06-MAINTENANCE-REQUESTS.md)
