# LEAD & DEPOSIT MANAGEMENT
## Khách hẹn (Lead) và Đặt cọc (Deposit)

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Lead Management Flow](#lead-management-flow)
3. [Deposit Management Flow](#deposit-management-flow)
4. [Database Schema](#database-schema)
5. [Business Logic](#business-logic)
6. [Component Structure](#component-structure)
7. [API Integration](#api-integration)
8. [Testing Checklist](#testing-checklist)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Quản lý toàn bộ quy trình từ Khách hẹn → Đặt cọc → Hợp đồng với tracking chi tiết, tự động hóa và báo cáo

### Quy trình chính: Prospect → Lead → Deposit → Contract

```
┌─────────────────────────────────────────────────────────────────┐
│                     SALES PIPELINE OVERVIEW                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. PROSPECT           2. LEAD              3. DEPOSIT          │
│  Nhập liệu khách      Hẹn xem + Tư vấn     Giữ chỗ            │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │ Tên, SĐT     │────▶│ Lịch hẹn     │────▶│ Tiền cọc     │   │
│  │ Nguồn (Zalo │     │ Trạng thái   │     │ Hợp đồng     │   │
│  │  FB, Phone)  │     │ Nhân viên     │     │ Confirm      │   │
│  └──────────────┘     └──────────────┘     └──────────────┘   │
│         ↓                     ↓                     ↓           │
│    Đang liên hệ        Chờ kết quả         Chuyển đổi         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Tính năng chính
- Quản lý khách hẹn từ nhiều nguồn
- Lịch hẹn xem phòng tự động
- Phân công nhân viên bán hàng
- Tracking conversion rate
- Quản lý tiền cọc & hoàn tiền
- In phiếu thu tiền cọc
- Báo cáo bán hàng tự động

### Tech Stack
- **Supabase**: Database & Real-time
- **React Hook Form**: Form handling
- **Zod**: Validation
- **TanStack Query**: State management
- **Date-fns**: Lịch hẹn
- **Recharts**: Conversion dashboard

---

## 📝 LEAD MANAGEMENT FLOW

### Quy trình từng bước

```
NHẬP LIỆU KHÁCH HẸN (LEAD CREATION)
          │
          ├─ Chọn nguồn (Facebook, Zalo, Phone, Walk-in, Referral)
          │
          ├─ Nhập thông tin:
          │  ├─ Họ tên (*)
          │  ├─ Số điện thoại (*)
          │  ├─ Email
          │  ├─ Dự án quan tâm (*)
          │  ├─ Nhu cầu (Studio, 1PN, 2PN...)
          │  ├─ Ngân sách
          │  └─ Ghi chú
          │
          ├─ HỆN XEM PHÒNG (LEAD SCHEDULING)
          │  ├─ Chọn ngày/giờ
          │  ├─ Phân công nhân viên (Agent)
          │  └─ Trạng thái: PENDING → CONFIRMED
          │
          ├─ TƯ VẤN (LEAD CONSULTATION)
          │  ├─ Agent xem phòng với khách
          │  ├─ Cập nhật feedback
          │  ├─ Ghi kết quả: Quan tâm/Không quan tâm
          │  └─ Trạng thái: CONSULTING → DONE_CONSULTING
          │
          └─ CHUYỂN ĐỔI (LEAD CONVERSION)
             ├─ Khách quan tâm → Chuyển DEPOSIT
             ├─ Khách không quan tâm → LOST
             └─ Trạng thái: CONVERTED (nếu có deposit)
```

### Lead Statuses

```
LEAD WORKFLOW STATES:

┌─────────────┐
│   CREATED   │  Vừa nhập liệu
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  CONTACTED  │  Đã liên hệ, hẹn xem
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  SCHEDULED  │  Đã xác nhận lịch hẹn
└──────┬──────┘
       │
       ▼
┌─────────────┐
│CONSULTING   │  Đang tư vấn/xem phòng
└──────┬──────┘
       │
       ├─────────────┬──────────────┐
       ▼             ▼              ▼
   ┌────────┐   ┌────────┐   ┌──────────┐
   │CONVERTED│  │QUALIFIED│   │LOST/UNFIT│
   │(Có cọc) │  │(Chờ cọc)│   │(Không KT)│
   └────────┘   └────────┘   └──────────┘
```

### Lead Scoring & Conversion Tracking

```
CONVERSION METRICS:

├─ Nguồn khách (Lead Source):
│  ├─ Facebook Ads: Conversion %
│  ├─ Zalo: Conversion %
│  ├─ Phone: Conversion %
│  ├─ Walk-in: Conversion %
│  └─ Referral: Conversion %
│
├─ Agent Performance:
│  ├─ Khách hẹn (Target)
│  ├─ Khách đến (Attendance)
│  ├─ Conversion rate
│  └─ Avg value (tiền cọc trung bình)
│
└─ Lead Quality Score:
   ├─ Nếu ngân sách >= target: +50 điểm
   ├─ Nếu đã có lịch hẹn: +30 điểm
   ├─ Nếu quan tâm dự án premium: +20 điểm
   └─ Score >= 80 → HOT LEAD (ưu tiên)
```

---

## 💰 DEPOSIT MANAGEMENT FLOW

### Quy trình tạo & quản lý cọc

```
KHÁCH QUYẾT ĐỊNH → TẠO DEPOSIT
        │
        ├─ Chọn Unit (căn hộ)
        │
        ├─ Nhập thông tin Deposit:
        │  ├─ Số tiền cọc (*)
        │  ├─ Kỳ hạn cọc (*) [14, 30, 60, 90 ngày]
        │  ├─ Ngày bắt đầu
        │  ├─ Điều khoản (Có thể hoàn, Không hoàn)
        │  └─ Ghi chú
        │
        ├─ CONFIRMED → TẠO HỢP ĐỒNG
        │  ├─ Generate Deposit Agreement
        │  ├─ In phiếu thu tiền cọc
        │  └─ Gửi khách ký
        │
        └─ CONVERTED → CHUYỂN THÀNH LEASE CONTRACT
           ├─ Cọc được tính vào tiền thuê đầu tiên
           └─ Hoặc hoàn tiền nếu không ký hợp đồng
```

### Deposit Statuses

```
DEPOSIT STATE MACHINE:

┌──────────┐
│ PENDING  │  Chờ khách xác nhận
└────┬─────┘
     │
     ├──────────────────┐
     ▼                  ▼
┌──────────┐      ┌──────────┐
│CONFIRMED │      │CANCELLED │  Khách hủy
└────┬─────┘      └──────────┘
     │
     ├────────────────┬────────────────┐
     ▼                ▼                ▼
┌──────────┐    ┌──────────┐     ┌─────────┐
│CONVERTED │    │ REFUNDED │     │FORFEITED│
│(→ Lease) │    │(Hoàn tiền)│     │(Mất cọc)│
└──────────┘    └──────────┘     └─────────┘
```

### Deposit Lifecycle Rules

```
LIFECYCLE LOGIC:

1. PENDING → CONFIRMED
   Condition: Khách xác nhận + Thanh toán đủ
   Action: Lưu số tiền thực tế, tạo agreement
   Email: Gửi xác nhận + phiếu thu

2. CONFIRMED → CONVERTED
   Condition: Khách ký lease contract
   Action: Link deposit_id → lease_id
   Notification: Alert agent, tạo task follow-up

3. CONFIRMED → REFUNDED
   Condition: Hủy cọc + còn trong kỳ hạn
   Action: Ghi nhận ngày hoàn tiền, tạo voucher
   Email: Thông báo hoàn tiền (ngân hàng)

4. CONFIRMED → FORFEITED
   Condition: Quá kỳ hạn + Không convert
   Action: Tính ngày mất cọc, tiền về công ty
   Report: Thêm vào doanh thu
```

---

## 📊 DATABASE SCHEMA

### Leads Table

```sql
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL (FK users),

  -- Basic info
  full_name varchar(255) NOT NULL,
  phone varchar(15) NOT NULL,
  email varchar(255),

  -- Lead source
  source enum: FACEBOOK | ZALO | PHONE | WALKIN | REFERRAL,

  -- Interest
  interested_project uuid (FK projects),
  preferred_unit_type varchar(50),
  budget_min bigint,
  budget_max bigint,

  -- Status & workflow
  status enum: CREATED | CONTACTED | SCHEDULED | CONSULTING | CONVERTED | LOST,
  conversion_date timestamp,

  -- Assignment
  assigned_agent_id uuid (FK agents),
  assigned_at timestamp,

  -- Scheduling
  first_appointment_date timestamp,
  appointment_notes text,

  -- Consultation
  consultation_feedback text,
  visited_date timestamp,

  -- Metadata
  score int DEFAULT 0,
  tags jsonb[],
  notes text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX idx_leads_user_id ON leads(user_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_assigned_agent_id ON leads(assigned_agent_id);
```

### Deposits Table

```sql
CREATE TABLE deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL (FK leads),
  unit_id uuid NOT NULL (FK units),

  -- Amount & Duration
  amount bigint NOT NULL,
  currency varchar(3) DEFAULT 'VND',
  term_days int NOT NULL (14, 30, 60, 90),

  -- Dates
  start_date timestamp NOT NULL,
  expire_date timestamp NOT NULL (start_date + term_days),
  converted_date timestamp,
  refund_date timestamp,

  -- Status
  status enum: PENDING | CONFIRMED | CONVERTED | REFUNDED | FORFEITED,

  -- Contract linkage
  agreement_number varchar(100),
  agreement_file_url text,
  lease_id uuid (FK leases),

  -- Conditions
  is_refundable boolean DEFAULT true,
  cancellation_fee_percent int DEFAULT 0,

  -- Notes
  notes text,
  created_by uuid NOT NULL (FK users),
  updated_by uuid,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX idx_deposits_lead_id ON deposits(lead_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_deposits_unit_id ON deposits(unit_id);
```

### Lead Activity Log

```sql
CREATE TABLE lead_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL (FK leads),

  activity_type enum: CREATED | CONTACTED | SCHEDULED | VISITED | CONVERTED | LOST,
  description text,
  activity_date timestamp DEFAULT now(),

  actor_id uuid (FK users),
  metadata jsonb,

  created_at timestamp DEFAULT now()
);

CREATE INDEX idx_lead_activities_lead_id ON lead_activities(lead_id);
```

---

## 🧮 BUSINESS LOGIC

### Lead Scoring Algorithm

```
SCORING LOGIC:

Base Score = 0

IF budget >= target_budget_min THEN
  score += 50

IF has_scheduled_appointment THEN
  score += 30

IF interested_in_premium_project THEN
  score += 20

IF follow_up_within_24h THEN
  score += 10

IF multiple_contacts THEN
  score += 5

FINAL SCORE CATEGORIES:
- 80+ : HOT LEAD (Priority)
- 50-79: WARM LEAD (Follow up)
- <50 : COLD LEAD (Nurture)
```

### Conversion Rate Calculation

```
METRICS:

1. Source-based conversion:
   = (Leads with status CONVERTED or in active Deposit) / Total Leads in source
   × 100%

2. Agent performance:
   = Converted deposits by agent / Total leads assigned to agent
   × 100%

3. Project conversion:
   = Leads converted to lease in project / Total leads in project
   × 100%

4. Time-based conversion:
   = Leads converted within X days / Total leads in period
   × 100%
```

### Deposit Auto-Status Updates

```
SCHEDULED JOBS:

1. Daily check (9:00 AM):
   IF deposit.status == CONFIRMED
      AND TODAY >= deposit.expire_date
      AND deposit.lease_id IS NULL
   THEN
     deposit.status = FORFEITED
     notify_agent("Cọc đã mất hạn")

2. On lease creation:
   IF lease.deposit_id IS NOT NULL
   THEN
     deposit.status = CONVERTED
     deposit.converted_date = NOW()

3. Manual refund:
   IF user clicks "Refund"
   THEN
     deposit.status = REFUNDED
     deposit.refund_date = NOW()
     create_refund_record()
```

---

## 🎨 COMPONENT STRUCTURE

### Lead Management Components

```typescript
// Lead Creation Form
LeadForm
├─ InputField: full_name, phone, email
├─ SelectField: lead_source, interested_project
├─ NumberField: budget_min, budget_max
├─ TextArea: notes
└─ SubmitButton

// Lead List View
LeadList
├─ DataTable
│  ├─ Columns: name, phone, source, status, agent, created_at
│  ├─ Filters: status, source, agent, date_range
│  ├─ Sorting: by name, date, status
│  └─ Actions: edit, convert_to_deposit, delete
├─ BulkActions: assign_agent, change_status
└─ ExportButton: Export CSV/PDF

// Lead Detail View
LeadDetail
├─ BasicInfo: name, phone, email, source
├─ InterestInfo: project, unit_type, budget
├─ ScheduleCard
│  ├─ appointment_date
│  ├─ assigned_agent
│  └─ ActionButton: schedule, reschedule, cancel
├─ ActivityLog: all activities timeline
├─ ConversionButton: convert_to_deposit
└─ DeleteButton

// Lead Conversion Modal
ConvertToDepositModal
├─ SelectUnit: choose unit to reserve
├─ DepositAmount: amount, currency
├─ DepositTerm: 14/30/60/90 days
├─ RefundableCheckbox
├─ NotesField
└─ ConfirmButton
```

### Deposit Management Components

```typescript
// Deposit Form
DepositForm
├─ SelectField: unit_id, lead_id
├─ NumberField: amount, term_days
├─ DateField: start_date
├─ CheckboxField: is_refundable
├─ TextArea: notes
└─ SubmitButton

// Deposit List View
DepositList
├─ DataTable
│  ├─ Columns: id, unit, lead, amount, status, term, expire_date
│  ├─ Filters: status, lead, date_range
│  └─ Actions: view, refund, convert
├─ StatusBadges: PENDING, CONFIRMED, CONVERTED, REFUNDED, FORFEITED
└─ QuickActions

// Deposit Detail View
DepositDetail
├─ Header: status badge, amount, currency
├─ LeadInfo: lead name, phone, project
├─ UnitInfo: unit code, type, price
├─ DepositInfo:
│  ├─ amount, term_days, start_date, expire_date
│  ├─ is_refundable, agreement_number
│  └─ lease_id (if converted)
├─ ActionButtons:
│  ├─ Confirm (if PENDING)
│  ├─ Convert (if CONFIRMED)
│  ├─ Refund (if CONFIRMED & not expired)
│  └─ Download Agreement
└─ AuditLog: created_by, created_at, updated_at

// Deposit Receipt Component
DepositReceipt (Print Template)
├─ Header: Company name, logo, date
├─ LeadInfo: full_name, phone, email
├─ UnitInfo: unit_code, type, price/month
├─ DepositInfo: amount (VND), term, expire_date
├─ BankInfo: account, transfer details
├─ Signature: agent, lead
└─ Footer: Company contact, terms
```

---

## 🔌 API INTEGRATION

### Lead CRUD Operations

```
POST /api/leads
├─ Body: { full_name, phone, email, source, ... }
├─ Returns: { id, created_at, ... }
└─ Validation: phone (required), source (enum)

GET /api/leads
├─ Query: page, limit, status, source, agent_id, date_range
├─ Returns: { data: Lead[], total, page, limit }
└─ Default: limit=20, page=1

GET /api/leads/:id
├─ Returns: Lead detail with activities
└─ 404 if not found

PATCH /api/leads/:id
├─ Body: { status, assigned_agent_id, notes, ... }
├─ Returns: updated lead
└─ Update updated_at

DELETE /api/leads/:id
├─ Soft delete (set deleted_at)
└─ Returns: 204 No Content
```

### Deposit CRUD Operations

```
POST /api/deposits
├─ Body: { lead_id, unit_id, amount, term_days, ... }
├─ Validations:
│  ├─ amount > 0
│  ├─ term_days in [14, 30, 60, 90]
│  ├─ lead_id exists & status != CONVERTED
│  └─ unit_id exists & not reserved
├─ Auto-fields: expire_date = start_date + term_days
└─ Returns: { id, status: PENDING, created_at, ... }

GET /api/deposits
├─ Query: page, limit, status, lead_id, unit_id, date_range
├─ Returns: { data: Deposit[], total, page, limit }
└─ Default: limit=20

GET /api/deposits/:id
├─ Returns: Full deposit detail
└─ Include: lead, unit, lease (if exists)

PATCH /api/deposits/:id/confirm
├─ Body: empty or { payment_confirmed: true }
├─ Condition: status == PENDING
├─ Action: status = CONFIRMED, generate agreement
└─ Returns: updated deposit with agreement_url

PATCH /api/deposits/:id/refund
├─ Body: { reason, notes }
├─ Condition: status == CONFIRMED
├─ Check: still within refundable period
├─ Action: status = REFUNDED, refund_date = NOW()
└─ Returns: refund confirmation

PATCH /api/deposits/:id/convert
├─ Auto: triggered when lease is created
├─ Body: { lease_id }
├─ Action: status = CONVERTED, converted_date = NOW()
└─ Returns: converted deposit
```

### Analytics APIs

```
GET /api/leads/stats/conversion
├─ Query: date_range, group_by (source|agent|project)
├─ Returns: {
│    total_leads: 100,
│    converted: 25,
│    conversion_rate: 25%,
│    by_source: { FACEBOOK: 15, ZALO: 10, ... }
│  }
└─ Cache: 1 hour

GET /api/deposits/stats/summary
├─ Returns: {
│    total_amount: 5B VND,
│    by_status: { PENDING: 1B, CONFIRMED: 2B, ... },
│    expiring_soon: 5 (next 7 days),
│    forfeited_today: 2
│  }
└─ Real-time

GET /api/agents/:id/performance
├─ Returns: {
│    total_leads: 50,
│    converted: 12,
│    conversion_rate: 24%,
│    avg_deposit_value: 50M VND,
│    total_value: 600M VND
│  }
└─ Period: current month
```

---

## 🧪 TESTING CHECKLIST

### Lead Management Tests

**Creation**:
- [ ] Validate required fields (full_name, phone, source)
- [ ] Validate phone format (10-11 digits)
- [ ] Validate email format (optional)
- [ ] Auto-trim whitespace
- [ ] Generate lead_id & created_at
- [ ] Set status = CREATED
- [ ] Create activity log entry

**Status Transitions**:
- [ ] CREATED → CONTACTED (manual)
- [ ] CONTACTED → SCHEDULED (when appointment set)
- [ ] SCHEDULED → CONSULTING (on visit date)
- [ ] CONSULTING → CONVERTED (when deposit created)
- [ ] Any status → LOST (manual, soft delete)
- [ ] Prevent invalid transitions

**Assignment**:
- [ ] Assign agent to lead
- [ ] Update assigned_at timestamp
- [ ] Notify agent (real-time)
- [ ] Cannot assign to inactive agent
- [ ] Can reassign multiple times

**Appointment Scheduling**:
- [ ] Set appointment_date (future date)
- [ ] Validate date/time not in past
- [ ] Check agent availability
- [ ] Send reminder 24h before
- [ ] Track attendance (no-show)

**Conversion Tracking**:
- [ ] Calculate lead score
- [ ] Track conversion by source
- [ ] Track conversion by agent
- [ ] Auto-update conversion_date when deposit created
- [ ] Generate reports

### Deposit Management Tests

**Creation**:
- [ ] Validate amount > 0
- [ ] Validate term_days in [14, 30, 60, 90]
- [ ] Auto-calculate expire_date = start_date + term_days
- [ ] Link to lead_id (cannot be null)
- [ ] Link to unit_id (cannot be null)
- [ ] Set status = PENDING
- [ ] Create activity log entry
- [ ] Update lead.status = QUALIFIED

**Confirmation**:
- [ ] Only PENDING deposits can confirm
- [ ] Update status = CONFIRMED
- [ ] Generate agreement_number (format: DEP-YYYYMMDD-XXXXX)
- [ ] Create PDF agreement file
- [ ] Store agreement_file_url
- [ ] Update updated_at
- [ ] Send confirmation email to lead
- [ ] Notify agent

**Refund**:
- [ ] Only CONFIRMED deposits can refund
- [ ] Check within refundable period (expire_date > NOW())
- [ ] Update status = REFUNDED
- [ ] Set refund_date = NOW()
- [ ] Update lead.status if needed
- [ ] Create refund record
- [ ] Send email confirmation
- [ ] Generate refund voucher

**Expiry/Forfeiture**:
- [ ] Daily job: check expired deposits
- [ ] If CONFIRMED + expire_date passed + no lease → FORFEITED
- [ ] Update lead.status = LOST
- [ ] Log forfeiture reason
- [ ] Alert admin/manager
- [ ] Include in financial reports

**Conversion**:
- [ ] Trigger when lease contract created with deposit_id
- [ ] Update deposit.status = CONVERTED
- [ ] Set converted_date = NOW()
- [ ] Link lease_id
- [ ] Update lead.status = CONVERTED
- [ ] Create conversion activity log
- [ ] Notify all parties

### Reporting Tests

- [ ] Generate conversion rate by source
- [ ] Generate conversion rate by agent
- [ ] Generate pending deposits report
- [ ] Generate expiring deposits (next 7 days)
- [ ] Generate forfeited deposits report
- [ ] Export to CSV/PDF
- [ ] Filter by date range
- [ ] Real-time dashboard updates

---

## 💾 SUPABASE SETUP

### Enable Real-time

```sql
-- Enable real-time on leads table
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE deposits;
ALTER PUBLICATION supabase_realtime ADD TABLE lead_activities;

-- RLS Policies
CREATE POLICY "Users can view their own leads"
  ON leads FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() IN (
    SELECT id FROM users WHERE role IN ('ADMIN', 'MANAGER')
  ));

CREATE POLICY "Users can update their own leads"
  ON leads FOR UPDATE
  USING (auth.uid() = user_id);
```

### Triggers

```sql
-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER deposits_updated_at BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

## 📝 NOTES

### Key Validations
1. Lead cannot be converted twice (idempotent)
2. Deposit amount cannot be changed after CONFIRMED
3. Lead must exist before creating deposit
4. Unit must be available (not reserved/sold)
5. Expire_date is auto-calculated, not editable

### Performance Considerations
- Index on (user_id, status) for fast filtering
- Index on (assigned_agent_id) for agent dashboards
- Index on (status, expire_date) for auto-jobs
- Cache conversion stats (update hourly)
- Use pagination for large lists (default: 20 items/page)

### Security
- All deposits linked to auth user (created_by)
- Soft-delete leads (set deleted_at)
- Audit all status changes in activity log
- RLS policies ensure users see only their data
- Export limited to authorized users (ADMIN/MANAGER)

---

## 🎯 NEXT STEPS

1. Create database tables (schema.sql)
2. Setup Supabase RLS policies
3. Implement Lead CRUD API endpoints
4. Build Lead management UI components
5. Implement Deposit CRUD API endpoints
6. Build Deposit management UI components
7. Setup real-time subscriptions
8. Create conversion reporting dashboard
9. Implement scheduled jobs (auto-forfeiture)
10. Add batch operations (bulk assign, bulk status change)

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md) | **Next**: [05-LEASING-FLOW.md](./05-LEASING-FLOW.md)
