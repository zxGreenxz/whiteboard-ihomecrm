# Đặc tả: Trang Đóng tiền Tập trung theo Kỳ (Centralized Period Payment)

> **Bản chất tài liệu**: Đây là **tài liệu đặc tả (spec)** để bàn giao cho agent AI chuyên làm UI/UX. Tài liệu KHÔNG thiết kế UI — chỉ mô tả **chức năng, mục đích, ý nghĩa, codebase liên quan, logic, database, flow**. Người thực hiện UI/UX nhận file này + toàn bộ code dự án hiện tại, rồi dựng UI và ghép vào các hook/RPC mô tả bên dưới.
>
> **Phạm vi**: spec-only. Việc code (migrations + RPC + hook data + UI) do agent tiếp theo thực hiện. Xem §13.

---

## 1. Bối cảnh, Mục đích, Ý nghĩa

### 1.1 Bối cảnh
Trang **"Đóng tiền Điện nước"** (`/thu-tien`, panel/sheet) hiện chỉ xử lý **2 loại phí**: Điện (EVN) và Nước (Cấp nước). Với mỗi tòa × loại, người dùng nhập số tiền chủ nhà đã chi cho NCC trong kỳ, chọn sổ quỹ ghi chi, đính ảnh phiếu → hệ thống tạo 1 phiếu **CHI** (`income_expenses`) gắn vào tòa, kỳ đó.

Trong khi đó, báo cáo **"Báo cáo Lợi Nhuận" / Phân bổ lợi nhuận** (`/reports/finance/profit-distribution`) liệt kê ở cột **Khoản chi** một loạt **phí cố định hằng tháng** theo tòa: Tiền nhà, Điện, Nước, Internet, Quản Lý, Vệ sinh tòa nhà định kỳ, Công an, Rác, Bảo trì thang máy, Hoa hồng, Bảo trì máy lạnh/máy giặt. Nhiều khoản hiển thị nhãn **"(chưa có phiếu)"** (nền vàng) để nhắc user còn thiếu phiếu chi của hạng mục đó trong kỳ.

### 1.2 Mục đích
Biến trang này thành **trang đóng tiền TẬP TRUNG của một kỳ** — nơi user (chủ nhà / quản lý) đóng **tất cả các loại phí cố định** của kỳ ở một chỗ, thay vì tạo từng phiếu chi rời rạc qua form Thu chi. Thêm **ô chọn loại phí (category selector)** để chuyển giữa các hạng mục.

### 1.3 Ý nghĩa nghiệp vụ
- **Đóng khớp với báo cáo**: Các khoản "(chưa có phiếu)" trong Báo cáo Lợi Nhuận chính là các hạng mục cần đóng ở trang này. Đóng xong → dòng "(chưa có phiếu)" biến mất, P&L tòa đủ chi phí.
- **Trả trước nhiều kỳ**: Một số phí (Internet, Rác, Công An, Thang máy) thường trả trước nhiều kỳ (VD Internet đóng theo quý/năm). Cần cho phép **phân bổ chi phí trải đều qua nhiều kỳ** (accrual) từ MỘT lần chi.
- **Thanh toán gộp cho NCC dịch vụ**: Bảo trì máy lạnh/máy giặt thường được trả **1 phiếu chi tổng** cho 1 nhà cung cấp bao nhiều khoản ở nhiều tòa cùng lúc. Trang phải **lấy phiếu tổng nếu có** (kể cả phiếu đã tạo bên Thu chi) thay vì bắt tạo lại từng phiếu lẻ.
- **Hoa hồng theo hợp đồng**: HH môi giới phát sinh theo HĐ ký trong kỳ; trang liệt kê HĐ, tính HH dự kiến, đánh dấu đã/chưa chi.
- **Lấy & SỬA phiếu đã có (áp dụng MỌI hạng mục)**: Nếu kỳ đó đã có phiếu chi của hạng mục (kể cả phiếu **"(tự động lập)"** do định kỳ sinh ra, hoặc phiếu tạo tay bên Thu chi), trang phải **lấy phiếu đó về hiển thị** thay vì bắt tạo mới, và cho **sửa ngay tại trang**:
  - **Admin**: sửa **toàn bộ** như phiếu Thu chi (số tiền, kỳ áp dụng, tòa, sổ quỹ, ảnh, ghi chú, hạng mục…).
  - **Quản lý (manager)**: sửa **giới hạn** — **thêm ảnh phiếu** và **gán sổ quỹ khi sổ đang trống** (nhiều phiếu "(tự động lập)" được sinh KHÔNG kèm `account_id` → cần gán sổ để vào đúng số dư).

---

## 2. Hiện trạng (những gì đã có — để agent UI đọc & tái dùng)

### 2.1 Các file UI hiện tại (điểm khởi đầu để mở rộng)
| File | Vai trò |
|---|---|
| `src/pages/ThuTien.tsx` | Host. Mở panel desktop / sheet mobile. Gate quyền `canUse(perms,'thu_tien','collect')`. Kỳ persist `usePersistedState('flt:thu-tien:month', currentMonth)`. |
| `src/components/thu-tien/UtilityDesktopPanel.tsx` | Panel desktop (`.tt-udesk`): header, `<input type="month">`, 3 tab (Đóng tiền/Báo cáo/Biểu đồ), 2 thẻ tổng, `<table class="ud-table">`. |
| `src/components/thu-tien/UtilityBillSheet.tsx` | Sheet mobile (`.sheet.full`): cùng 3 tab, layout thẻ theo tòa (`.ubc`). |
| `src/hooks/useUtilityPayState.ts` | **Hook state/hành động DÙNG CHUNG** cho 2 surface (đảm bảo hành xử y hệt). Nhập mã/chủ hộ inline autosave, nhập tiền, chọn sổ, đính ảnh, đóng tiền, hủy phiếu. |
| `src/hooks/useUtilityBills.ts` | **Data layer**: các React Query hook + RPC mutation. |
| `src/components/thu-tien/UtilityBookMenu.tsx` | Chip + dropdown chọn "Sổ quỹ ghi chi". |
| `src/components/thu-tien/UtilityCancelModal.tsx` | Modal "Hủy phiếu?". Export `CancelTarget`. |
| `src/components/thu-tien/UtilityReceiptThumb.tsx` | Thumbnail ảnh phiếu (dùng `StorageImage` + lightbox). |
| `src/components/thu-tien/UtilityChart.tsx` | Biểu đồ cột "Chi qua các tháng". |
| `src/pages/thu-tien.css` | CSS tự chứa, prefix `.tt-udesk`/`.tt-page`/`.tt-stage`. Design token (màu, radius, shadow) khai báo trên `.tt-stage`. |

### 2.2 RPC hiện tại (nền tảng để tổng quát hóa)
- **`pay_utility_bill(p_building_id, p_utility_type 'ELECTRIC|WATER', p_amount, p_period_month 'YYYY-MM', p_voucher_date, p_provider_code, p_account_holder, p_account_id, p_attachments)`** — `SECURITY DEFINER`. File `supabase/migrations/20260708100000_pay_utility_bill_account_attachments.sql`. Luồng: validate → lấy `v_owner` từ `buildings` → kiểm quyền (`can_access_building` OR `ie_all_buildings_scope` OR owner OR admin) → chọn sổ (p_account_id của caller/admin, else auto sổ `…Thu`) → **resolve type qua tên**: `_termination_ensure_type(v_owner,'expense','Đóng tiền điện'|'Đóng tiền nước')` → INSERT 1 `income_expenses` (EXPENSE, APPROVED, `business_result_accounting=TRUE`, `system_source='utility.bill'`, `attachments`) + 1 `income_expense_items` (`start_date`/`end_date` = đầu/cuối tháng kỳ) → upsert `building_utility_accounts`.
- **`cancel_utility_bill(p_voucher_id)`** — soft-delete, chỉ phiếu `system_source='utility.bill'`.
- **`upsert_building_utility_account(p_building_id, p_utility_type, p_provider_code, p_account_holder)`**.
- Bảng **`building_utility_accounts`**: `(building_id, utility_type CHECK IN ('ELECTRIC','WATER'), provider_code, account_holder, user_id=owner, deleted_at)`, unique `(building_id, utility_type) WHERE deleted_at IS NULL`. RLS SELECT-only; mọi ghi qua RPC definer.

### 2.3 Hệ thống loại thu chi & phiếu (tái dùng)
- **`income_expense_types`** (per-user, RLS `user_id=auth.uid()`): `id, name, type ('income'|'expense' — CHỮ THƯỜNG), category (TEXT tự do, không enum/seed), is_default, is_deposit, is_restricted, hide_in_report, user_id`.
- **`income_expenses`** (phiếu): `id, user_id (owner/RLS), code, type ('INCOME'|'EXPENSE'), name, voucher_date, total_amount (trigger tự tính từ items), building_id (NOT NULL), room_id, contract_id, account_id (sổ quỹ), invoice_id, attachments jsonb, approval_status ('UNAPPROVED'|'APPROVED'|'CANCELLED'), business_result_accounting (NULLABLE: NULL=auto, TRUE/FALSE=override), counts_in_business_result (derived), kqkd_amount (derived, item-level), has_restricted_item (derived), system_source (nguồn tự sinh; NULL=nhập tay), repeat_* (định kỳ), deleted_at`.
- **`income_expense_items`** (hạng mục con — **nơi DUY NHẤT phiếu gắn với type**): `income_expense_id, income_expense_type_id, description, quantity, unit_price, amount (trigger), start_date, end_date (KỲ ÁP DỤNG accrual)`.
- **Khớp hạng mục cố định**: `src/lib/fixedExpenseCategories.ts` — hàm `nrm()` (bỏ dấu + thường hóa + đ→d), `FIXED_EXPENSE_CATEGORIES[]` (9 hạng mục, khớp theo `category` rồi fallback `name`), `expenseRankOf()`. **Không** khớp theo `type_id`. Đây là **nguồn sự thật DUY NHẤT** để nhận diện hạng mục → phải tái dùng.
- **Tạo phiếu thường**: `useCreateIncomeExpense` (`src/hooks/useIncomeExpenses.ts`) = INSERT `income_expenses` + N `income_expense_items` (không qua RPC). Validation `src/lib/incomeExpenseValidation.ts`.

### 2.4 Accrual (phân bổ theo kỳ áp dụng) — CƠ CHẾ ĐÃ CÓ, tái dùng nguyên
- **Kỳ áp dụng lưu trên `income_expense_items.start_date` / `end_date`** (DATE). Quy ước: `start_date`=ngày đầu tháng bắt đầu, `end_date`=ngày cuối tháng kết thúc. **Số kỳ KHÔNG lưu** — suy ra `n = monthIndex(end) − monthIndex(start) + 1`.
- **Chia đều tại thời điểm BÁO CÁO, không phải lúc ghi**: 1 phiếu + 1 item trải nhiều tháng; engine chia `portion[i]=round(amt*(i+1)/n)−round(amt*i/n)`.
  - TS: `src/lib/accrualAllocation.ts` (`allocateAmountByMonth`) + `src/hooks/useAccrualReport.ts` (`useAccrualMonthReport`).
  - SQL: `fa_accrual_allocations` / `fa_monthly_pnl_accrual` (`supabase/migrations/20260626000000_fa_accrual_pnl.sql`).
- **Ưu tiên gán tháng**: có `invoice_id` → dồn `invoices.billing_month`; else item có `[start,end]` → chia đều; else → dồn tháng `voucher_date`.
- ⇒ **Tính năng "phân bổ kỳ thanh toán" của user KHÔNG cần code accrual mới** — chỉ cần đặt `start_date`/`end_date` đúng khoảng khi tạo phiếu.

### 2.5 Phiếu tổng (batch) — tái dùng cho Bảo trì
- **`income_expense_batches`** (metadata đợt) + **`income_expense_batch_items`** (junction batch↔voucher) — `supabase/migrations/20260510000004_income_expense_batches.sql`. RLS `user_id=auth.uid()` (batch thuộc **caller**). Comment gốc mô tả **đúng use case**: *"1 lần trả thợ vệ sinh máy lạnh ở 4 nhà + sửa máy giặt 1 nhà"*.
- **`useCreateIncomeExpenseBatch`** (`src/hooks/useIncomeExpenses.ts:1586`): INSERT 1 batch + **N phiếu con** (mỗi phiếu có `building_id`/`room_id` RIÊNG) + N items + N junction. ⇒ P&L quy chi phí ĐÚNG theo từng tòa. Đọc/chi tiết: `useIncomeExpenseBatches`, `IncomeExpenseBatchList(.tsx/Mobile)`, `IncomeExpenseBatchDetailDialog(.tsx/Mobile)`, `IncomeExpenseBatchForm.tsx`.

### 2.6 Hoa hồng — tái dùng
- **`useCommissionVoucher.ts`**: `calcContractMonths()`, `findMatchingTier()` (khớp `buildings.commission_tiers` JSON theo số tháng HĐ), `useCommissionPrefill(contractId)` (prefill từ contract), `useCreateCommissionVoucher()` (tạo phiếu chi HH, mặc định `UNAPPROVED`, type khớp tên `"Hoa hồng môi giới"`/`"Thưởng nóng Sale"` của **caller**, gắn `contract_id`, `system_source` liên quan `contract.commission`).
- Type HH được seed sẵn per-user: `20260510000021_seed_commission_expense_types.sql`.

### 2.7 Tiện ích chung
- `useIncomeExpenseFormBuildings()` (`ie_form_buildings` RPC, scope-aware, trả `is_virtual`) → lọc `!is_virtual`.
- `useAccounts()` (sổ quỹ). Chọn sổ mặc định = sổ `…Thu` của user (ưu tiên `is_default`).
- `src/lib/receiptUpload.ts`: `validateReceiptFile` (image ≤5MB), `uploadReceiptToStorage` (bucket private `payment-receipts`, fallback `documents`). Xem ảnh: `StorageImage` / `AttachmentLightbox`.
- `src/lib/monthPeriod.ts`: `monthToStartDate`/`monthToEndDate`.

---

## 3. Registry hạng mục phí (TRÁI TIM của tính năng)

Tạo module mới **`src/lib/feeCategories.ts`** — nguồn sự thật cho toàn trang. Mỗi hạng mục khai báo hành vi; UI chỉ đọc registry, không hardcode.

### 3.1 Ba "họ" flow (family)
- **`GRID`** — lưới theo tòa: mỗi tòa 1 dòng, nhập tiền → 1 phiếu chi/tòa/kỳ. Có biến thể **đơn kỳ** (start=end) và **đa kỳ** (chọn khoảng → accrual). Đây là tổng quát hóa của luồng Điện/Nước hiện tại.
- **`COMMISSION`** — lưới theo **HĐ** ký trong kỳ: tính HH dự kiến, tạo phiếu chi HH.
- **`MAINTENANCE_BATCH`** — phiếu tổng theo NCC: gom N dòng (tòa × loại máy) thành 1 batch; đồng thời **lấy phiếu bảo trì đã có** bên Thu chi.

### 3.2 Bảng registry (11 hạng mục)
| key | label | family | multiPeriod | providerConfig | restricted | elevatorGated | canonical type name / category (fallback) |
|---|---|---|---|---|---|---|---|
| `tien_nha` | Tiền nhà | GRID | ✗ (mặc định; bật dễ) | ✓ | ✗ | ✗ | "Tiền nhà" / "Tiền nhà" |
| `dien` | Điện | GRID | ✗ | ✓ (mã PE) | ✗ | ✗ | "Đóng tiền điện" / "Điện" |
| `nuoc` | Nước | GRID | ✗ | ✓ (số danh bạ) | ✗ | ✗ | "Đóng tiền nước" / "Nước" |
| `internet` | Internet | GRID | **✓** | ✓ | ✗ | ✗ | "Internet" / "Internet" |
| `quan_ly` | Quản Lý | GRID | ✗ | tùy | **✓** | ✗ | "Quản Lý" / "Quản Lý" (is_restricted=true) |
| `ve_sinh` | Vệ sinh tòa nhà định kỳ | GRID | ✗ | tùy | ✗ | ✗ | "Vệ sinh tòa nhà định kỳ" / "Vệ sinh" |
| `cong_an` | Công An | GRID | **✓** | ✓ | ✗ | ✗ | "Công an" / "Công an" |
| `rac` | Rác | GRID | **✓** | ✓ | ✗ | ✗ | "Tiền rác" / "Rác" |
| `thang_may` | Thang máy | GRID | **✓** | ✓ | ✗ | **✓** | "Bảo trì thang máy" / "Bảo Trì Thang Máy" |
| `hoa_hong` | Hoa hồng | COMMISSION | – | ✗ | ✗ | ✗ | (dùng "Hoa hồng môi giới" sẵn có) |
| `bao_tri_ml_mg` | Bảo trì máy lạnh/máy giặt | MAINTENANCE_BATCH | – | ✗ | ✗ | ✗ | 2 subtype: "Bảo trì máy lạnh", "Bảo trì máy giặt" |

**Ghi chú**:
- `multiPeriod=✓` cho ĐÚNG 4 hạng mục user yêu cầu (Internet, Công An, Rác, Thang máy). `tien_nha` để cờ tắt nhưng có thể bật (trả trước tiền nhà là thực tế) — chỉ đổi 1 flag.
- `elevatorGated=✓` (thang_may): chỉ hiện/cảnh báo tòa có `buildings.has_elevator=true` (khớp `requiresElevator` trong `fixedExpenseCategories.ts`).
- Các canonical name được chọn để **matcher trong `fixedExpenseCategories.ts` nhận diện đúng nhóm** trong Báo cáo Lợi Nhuận (đã đối chiếu: "đóng tiền điện"⊃"tien dien", "Tiền rác"⊃"rac", "Vệ sinh…" khớp category "ve sinh" và loại "rac", v.v.).

### 3.3 Cấu trúc mỗi entry (đề xuất)
```ts
export type FeeFamily = 'GRID' | 'COMMISSION' | 'MAINTENANCE_BATCH';
export interface FeeCategory {
  key: string;                 // 'internet', ...
  label: string;               // nhãn hiển thị
  family: FeeFamily;
  multiPeriod: boolean;        // GRID: cho chọn khoảng kỳ (accrual)
  providerConfig: boolean;     // có ô mã NCC + số tiền mặc định theo tòa
  restricted: boolean;         // quan_ly: hạng mục hạn chế
  elevatorGated: boolean;      // chỉ tòa có thang máy
  canonicalTypeName: string;   // tên type fallback khi tạo mới
  canonicalCategory: string;   // category fallback
  subtypes?: { key: string; label: string; canonicalTypeName: string; canonicalCategory: string }[]; // MAINTENANCE
}
```
> **CAVEAT bảo trì đồng bộ**: predicate nhận diện hạng mục PHẢI khớp `fixedExpenseCategories.ts` (và bản port SQL ở §5.3). Khi đổi 1 nơi, đổi cả 3: `feeCategories.ts`, `fixedExpenseCategories.ts`, hàm SQL `resolve_fixed_expense_type`.

---

## 4. Tổng quan kiến trúc đích

```
                         ┌───────────────────────────────────────────────┐
   Ô chọn LOẠI PHÍ  ───▶  │  feeCategories.ts (registry)  →  quyết family   │
   (category selector)    └───────────────────────────────────────────────┘
                               │ GRID              │ COMMISSION        │ MAINTENANCE_BATCH
                               ▼                   ▼                   ▼
   Lưới theo TÒA         Lưới theo HĐ ký kỳ    Phiếu tổng theo NCC
   (đơn/đa kỳ)           (tính HH dự kiến)      (+ lấy phiếu bảo trì đã có)
        │                      │                        │
        ▼                      ▼                        ▼
   RPC pay_period_fee    useCreateCommission     useCreateIncomeExpenseBatch
   (1 phiếu chi/tòa)     Voucher (1 phiếu/HĐ)    (1 batch + N phiếu con)
        │                      │                        │
        └──────────────┬───────┴────────────┬───────────┘
                       ▼                     ▼
             income_expenses + items   (kỳ áp dụng = start/end_date)
                       │
                       ▼
        get_period_fee_status (SECURITY DEFINER) → trạng thái đã/chưa đóng, số tiền, kỳ phủ
```

---

## 5. Thay đổi Database

### 5.1 Bảng cấu hình tổng quát `building_fee_accounts` (mở rộng `building_utility_accounts`)
Tổng quát hóa: lưu mã NCC + **số tiền mặc định** + sổ mặc định theo **tòa × hạng mục**.

```sql
CREATE TABLE building_fee_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id        uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  fee_category       text NOT NULL,          -- registry key: 'dien','nuoc','internet','rac','cong_an','thang_may','ve_sinh','quan_ly','tien_nha'
  provider_code      text,                   -- mã NCC (mã PE điện / số danh bạ nước / mã KH internet / …)
  account_holder     text,                   -- tên chủ hộ / tên đăng ký NCC
  default_amount     numeric(15,2),          -- số tiền dự kiến (pre-fill + so 'phải đóng' vs 'đã đóng')
  default_account_id uuid REFERENCES accounts(id),  -- sổ ghi chi mặc định (optional)
  user_id            uuid NOT NULL,          -- = buildings.user_id (owner)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX uq_bfa_building_category
  ON building_fee_accounts(building_id, fee_category) WHERE deleted_at IS NULL;
-- RLS: SELECT (owner OR can_access_building OR admin). Mọi ghi qua RPC definer.
```
**Migrate dữ liệu cũ**: copy `building_utility_accounts` → `building_fee_accounts` với `fee_category = CASE utility_type WHEN 'ELECTRIC' THEN 'dien' WHEN 'WATER' THEN 'nuoc' END`. Sau đó cập nhật RPC/hook dùng bảng mới. Có thể giữ `building_utility_accounts` một thời gian (đọc song song) rồi drop, HOẶC drop ngay trong cùng migration vì deploy FE+DB đồng thời (repo deploy thẳng từ main). **Đề xuất**: tạo mới + copy + đổi RPC, drop bảng cũ ở migration sau khi FE mới lên.

**RPC ghi cấu hình**: `upsert_building_fee_account(p_building_id, p_fee_category, p_provider_code, p_account_holder, p_default_amount, p_default_account_id)` — mirror `upsert_building_utility_account`, cùng permission gate.

### 5.2 RPC thanh toán tổng quát `pay_period_fee` (tổng quát hóa `pay_utility_bill`)
Thay `p_utility_type` bằng `p_category_key`; thay `p_period_month` đơn bằng khoảng `p_period_start`/`p_period_end`.

```sql
CREATE OR REPLACE FUNCTION pay_period_fee(
  p_building_id    uuid,
  p_category_key   text,        -- registry GRID key
  p_amount         numeric,
  p_period_start   text,        -- 'YYYY-MM' kỳ bắt đầu phủ
  p_period_end     text,        -- 'YYYY-MM' kỳ kết thúc phủ (= start nếu đơn kỳ)
  p_voucher_date   date  DEFAULT NULL,
  p_provider_code  text  DEFAULT NULL,
  p_account_holder text  DEFAULT NULL,
  p_account_id     uuid  DEFAULT NULL,
  p_attachments    jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- LUỒNG (mở rộng pay_utility_bill hiện tại):
--  1. Validate: auth, amount>0, p_period_start/end khớp ^\d{4}-\d{2}$, start<=end,
--     p_category_key ∈ tập GRID hợp lệ.
--  2. v_owner từ buildings; permission gate GIỐNG pay_utility_bill
--     (can_access_building OR ie_all_buildings_scope OR owner OR admin/super).
--     NẾU category restricted (quan_ly): thêm kiểm quyền restricted_create
--     (income_expenses.restricted_create trên tòa) — nếu không → RAISE 42501.
--  3. Chọn sổ: p_account_id (của caller/admin) else auto sổ '…Thu' (như cũ).
--  4. v_type := resolve_fixed_expense_type(v_owner, p_category_key);  -- §5.3
--     UPDATE is_deposit=FALSE cho v_type (an toàn).
--  5. v_p_start = ngày đầu tháng p_period_start; v_p_end = ngày cuối tháng p_period_end;
--     v_vdate = COALESCE(p_voucher_date, CURRENT_DATE).
--  6. INSERT income_expenses:
--       type='EXPENSE', APPROVED,
--       business_result_accounting = TRUE (KQKD; restricted vẫn TRUE — chỉ ẩn theo RLS),
--       building_id, account_id, voucher_date=v_vdate, total_amount=p_amount,
--       system_source='fixed_fee',            -- nhận diện để Hủy phiếu (kèm 'utility.bill' legacy)
--       attachments=COALESCE(p_attachments,'[]'), creator_name, name/notes theo label + kỳ.
--  7. INSERT 1 income_expense_items: type_id=v_type, quantity=1, unit_price=p_amount,
--       start_date=v_p_start, end_date=v_p_end.   ← ĐA KỲ → accrual tự chia
--  8. Upsert building_fee_accounts (provider_code/holder + default_amount=p_amount nếu muốn pre-fill kỳ sau).
--  9. RETURN {voucher_id, code, total_amount, account_id}.
$$;
-- REVOKE PUBLIC/anon; GRANT authenticated.
```
**Tương thích ngược**: giữ `pay_utility_bill` như **wrapper mỏng** gọi `pay_period_fee(p_building_id, CASE 'ELECTRIC'→'dien','WATER'→'nuoc', …, p_period_month, p_period_month, …)` để không vỡ mã cũ; hoặc FE mới gọi thẳng `pay_period_fee` cho mọi hạng mục kể cả điện/nước. `cancel_utility_bill` mở rộng chấp nhận `system_source IN ('utility.bill','fixed_fee')` (đổi tên khái niệm thành `cancel_period_fee` nếu muốn, giữ alias cũ).

### 5.3 Helper resolve type theo hạng mục (server-side, cần cho đa-owner)
Vì `income_expense_types` RLS theo `user_id` → **staff KHÔNG đọc được type của chủ** ⇒ resolve phải chạy server-side (definer) theo `v_owner`, KHÔNG resolve ở FE.

```sql
CREATE OR REPLACE FUNCTION resolve_fixed_expense_type(p_owner uuid, p_category_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
-- 1. Tìm type expense của p_owner khớp p_category_key theo LOGIC PORT TỪ
--    fixedExpenseCategories.ts (dùng hàm nrm_vn() bỏ dấu + đ→d + lower):
--      internet  : nrm(category)='internet' OR nrm(name) ~ 'internet'
--      rac       : nrm(name) ~ 'rac'
--      cong_an   : nrm(category)='ca' OR nrm(name) ~ 'cong an'
--      ve_sinh   : (nrm(category)='ve sinh' OR nrm(name) ~ 've sinh toa nha') AND nrm(name) !~ 'rac'
--      thang_may : nrm(name) ~ 'thang may'
--      dien      : nrm(category)='dien' OR nrm(name) ~ 'tien dien'
--      nuoc      : nrm(category)='nuoc' OR nrm(name) ~ 'tien nuoc'
--      tien_nha  : nrm(category)='tien nha' OR nrm(name) ~ 'tien nha'
--      quan_ly   : nrm(name) ~ 'quan ly'
--    Ưu tiên is_default DESC, created_at ASC. Nếu tìm được → RETURN id.
-- 2. Không có → INSERT canonical (name=canonicalTypeName, category=canonicalCategory,
--    type='expense', is_restricted = (p_category_key='quan_ly'), user_id=p_owner) → RETURN id.
$$;
```
- Cần hàm phụ **`nrm_vn(text)`** (IMMUTABLE): `lower()` → thay đ/Đ → d → `translate()` bỏ dấu nguyên âm tiếng Việt (à/á/ả/ã/ạ/â/ầ… → a; è/é… → e; …). Đây là bản SQL của `nrm()` trong `fixedExpenseCategories.ts` — **giữ đồng bộ**. (Nếu extension `unaccent` đã bật, có thể dùng `lower(unaccent())` + xử lý đ; nhưng `translate()` an toàn/tất định hơn.)
- Giải quyết luôn nỗi lo **trùng type**: helper ưu tiên **tái dùng type có sẵn của owner** (kể cả tên do owner tự đặt), chỉ tạo canonical khi thật sự thiếu ⇒ báo cáo P&L không sinh dòng trùng.

### 5.4 RPC trạng thái đóng tiền `get_period_fee_status` (đọc, definer, gộp tất cả tòa)
Cấp dữ liệu "đã/chưa đóng" cho lưới GRID của MỌI tòa trong 1 lần gọi (thay cho query FE dễ vỡ đa-owner). Nhận diện phiếu qua khoảng kỳ **giao nhau** (như query hiện tại: `it.start_date <= p_end AND it.end_date >= p_start`).

```sql
CREATE OR REPLACE FUNCTION get_period_fee_status(
  p_period_start text,            -- 'YYYY-MM'
  p_period_end   text,            -- 'YYYY-MM' (thường = start; lưới xem 1 kỳ)
  p_building_ids uuid[],
  p_category_keys text[]          -- các GRID key đang hiển thị
) RETURNS TABLE(
  building_id uuid, category_key text,
  paid_amount numeric, covered_start date, covered_end date,
  voucher_ids uuid[], has_receipt boolean, account_name text,
  account_is_empty boolean,       -- có phiếu nhưng account_id NULL → nhắc gán sổ (§5.7)
  expected_amount numeric         -- từ building_fee_accounts.default_amount
) SECURITY DEFINER SET search_path=public AS $$
-- Với mỗi (tòa ∈ p_building_ids ∩ can_access_building) × (category ∈ p_category_keys):
--   • resolve tập type_id của category theo OWNER tòa (dùng logic §5.3, KHÔNG tạo mới ở đây).
--   • JOIN income_expenses(EXPENSE,APPROVED,deleted_at NULL) + income_expense_items(type ∈ tập)
--     lọc giao kỳ [đầu p_period_start .. cuối p_period_end].
--   • Cộng total_amount, gộp voucher_ids, lấy covered range MIN(start)/MAX(end), account name.
--   • account_is_empty = bool_or(account_id IS NULL).
--   • expected_amount = building_fee_accounts.default_amount.
--   • RESPECT RLS hạn chế: nếu category restricted và caller thiếu restricted_view → BỎ QUA dòng.
$$;
```
- **Lý do dùng RPC thay query FE thuần**: (1) đa-owner (type của chủ), (2) hạng mục hạn chế (quan_ly), (3) gộp 1 request thay N. FE hiện tại (`useUtilityPayments`) query trực tiếp — chấp nhận được cho 1 owner nhưng KHÔNG đúng đa-owner; RPC này chuẩn hóa lại. (Có thể giữ đường FE cho điện/nước như fallback.)

### 5.5 Hoa hồng — nguồn dữ liệu theo HĐ (không cần bảng mới)
Không tạo bảng. Dùng dữ liệu sẵn có:
- Nguồn HĐ trong kỳ: `contracts` có `signed_date` (hoặc `start_date`) rơi vào kỳ; join `rooms`→`buildings.commission_tiers`; join `contract_customers`→`customers` (đại diện).
- Tính HH dự kiến: `calcContractMonths(start,end)` + `findMatchingTier(months, tiers)` (đã có trong `useCommissionVoucher.ts`). Số tiền = theo `matched_tier` (% × tiền phòng × …) — theo đúng công thức prefill hiện có.
- Đã/chưa chi: tồn tại phiếu `income_expenses` EXPENSE gắn `contract_id` với type "Hoa hồng môi giới" (hoặc `system_source` HH) → coi là đã có phiếu.
- **RPC gợi ý** (đa-owner + gộp): `get_period_commissions(p_period_month, p_building_ids[])` SECURITY DEFINER trả `{contract_id, contract_number, building_id, room_id/name, tenant_name, signed_date, months, tier_percent, expected_amount, voucher_id (nếu có), account_is_empty, status}`. (Nếu chỉ 1 owner, có thể làm hook FE thuần tái dùng `useCommissionPrefill` logic.)
- Tạo phiếu: **`useCreateCommissionVoucher`** (đã có). Lưu ý phiếu tạo mặc định `UNAPPROVED` (nháp). Trên trang thanh toán, cho phép **tạo + duyệt ngay** (gọi thêm `approve_voucher`) hoặc **lưu nháp** — do agent UI đặt nút; spec khuyến nghị mặc định tạo APPROVED khi bấm "Chi", có tùy chọn "Lưu nháp".

### 5.6 Bảo trì máy lạnh/máy giặt — phiếu tổng + "lấy phiếu đã có"
Không tạo bảng mới. Hai chiều:

**(a) Hiển thị / lấy phiếu đã có bên Thu chi** — RPC/hook `get_period_maintenance(p_period_month, p_building_ids[])`:
- Tìm phiếu `income_expenses` EXPENSE APPROVED có item thuộc type "Bảo trì máy lạnh"/"Bảo trì máy giặt" (nhận diện bằng `nrm(name/category) ~ 'bao tri may lanh'|'bao tri may giat'`), giao kỳ.
- Với mỗi phiếu, tra `income_expense_batch_items` → nếu thuộc batch, gom hiển thị theo **batch (phiếu tổng)**; phiếu con là breakdown theo tòa. Nếu phiếu **đứng lẻ** (tạo tay bên Thu chi, không batch) → hiển thị như dòng độc lập (và có thể đề xuất gộp).
- ⇒ Thỏa yêu cầu *"lấy phiếu tổng nếu có thay cho phiếu lẻ; nếu có sẵn phiếu bên thu chi thì lấy qua"*: trang **phản ánh phiếu thực tế**, không bắt nhập lại.

**(b) Tạo phiếu tổng mới** — `useCreateIncomeExpenseBatch` (đã có):
- Form gom N dòng: mỗi dòng = `building_id` + subtype (máy lạnh/máy giặt) → `income_expense_type_id` = `resolve_fixed_expense_type(owner, subtypeKey)` (hoặc tra type theo tên) + `unit_price` + `start_date`/`end_date` (kỳ).
- 1 batch (payer_name = NCC, attachments = ảnh phiếu tổng) + N phiếu con theo tòa. `voucher_date` chung. business_result_accounting=null (chi phí thật vào P&L).
- ⇒ P&L quy chi phí bảo trì **đúng theo từng tòa** (đáp án "Tách theo từng tòa").
- **(Tùy chọn nâng cao)** bổ sung `bao_tri_may_lanh`/`bao_tri_may_giat` vào `FIXED_EXPENSE_CATEGORIES` để P&L cũng cảnh báo "(chưa có phiếu)" theo tòa — user KHÔNG yêu cầu, để mục §12.

### 5.7 Lấy & SỬA phiếu đã có — cho MỌI hạng mục (2 tầng quyền)
Yêu cầu: mọi hạng mục, nếu **đã có phiếu chi** trong kỳ thì **lấy về** (KHÔNG bắt tạo mới) và **cho sửa tại chỗ** như phiếu Thu chi. Không cần schema mới — tái dùng đường sửa phiếu sẵn có:

- **Nhận diện phiếu đã có**: dùng chính `get_period_fee_status` (GRID) / `get_period_commissions` (HH) / `get_period_maintenance` (bảo trì) — các RPC này trả `voucher_ids` (kèm cờ `account_is_empty`, `has_receipt`). Khi 1 tòa×hạng mục đã có phiếu → lưới hiển thị chế độ "đã có phiếu" (số tiền + kỳ phủ + sổ/ảnh) với **nút Sửa**, thay vì ô nhập trống.
- **Admin — sửa TOÀN BỘ (như phiếu Thu chi)**: tái dùng **`useUpdateIncomeExpense`** (`src/hooks/useIncomeExpenses.ts`) = update voucher + xóa toàn bộ items + insert lại items. Mở form sửa (tái dùng `IncomeExpenseForm` / dialog chi tiết phiếu, hoặc form rút gọn cùng field). Sửa được: `total_amount`/items (số tiền), `start_date`/`end_date` (kỳ áp dụng), `building_id`, `account_id` (sổ quỹ), `attachments`, `notes`, `income_expense_type_id`.
- **Manager — sửa GIỚI HẠN (thêm ảnh + gán sổ trống)**: tái dùng RPC **`update_income_expense_quick`** (đã có; chỉ đụng `account_id`/`attachments`/`notes`). Chỉ cho phép:
  - **Thêm ảnh phiếu** (append vào `attachments`).
  - **Gán/đổi sổ quỹ khi `account_id` đang NULL** (phiếu "(tự động lập)" thường thiếu sổ). Nếu muốn siết đúng "chỉ khi trống", RPC `update_income_expense_quick` (hoặc bản mở rộng `update_income_expense_fee_quick`) chỉ set `account_id` khi giá trị hiện tại IS NULL (RAISE nếu đã có sổ mà manager cố đổi — trừ admin). *(Cần xác nhận nghiệp vụ: manager có được đổi sổ ĐÃ có không, hay chỉ điền sổ trống — spec mặc định "chỉ điền khi trống" theo câu chữ user.)*
- **Phân tầng quyền**: xác định "admin" vs "manager" theo hệ quyền hiện có (`is_admin()`/`is_super_admin()` cho full; quyền `income_expenses.update`/`approve` trên tòa cho manager quick-edit). Gate NÚT sửa ở FE bằng `canUse` + gate THẬT ở RPC (definer tự kiểm). Không tin FE.
- **Áp dụng đồng nhất**: GRID (điện/nước/internet/…), Hoa hồng, và phiếu con của batch Bảo trì đều đi qua cùng 2 đường sửa này (chúng đều là `income_expenses`). Batch metadata (payer/ảnh chung) sửa qua đường batch detail sẵn có.

---

## 6. Data contract Frontend (logic — KHÔNG UI)

Agent UI xây UI trên các hook sau (đặt cạnh các hook cũ, cùng phong cách React Query):

| Hook / module (mới) | Vai trò | Query key / RPC |
|---|---|---|
| `src/lib/feeCategories.ts` | Registry §3 | (pure) |
| `useFeeCategories()` (optional) | Lọc registry theo quyền + `has_elevator` của tòa | – |
| `usePeriodFeeStatus(period, categoryKeys, buildingIds)` | Trạng thái GRID mọi tòa/hạng mục | `['period-fee-status', period, keys]` → RPC `get_period_fee_status` |
| `usePayPeriodFee()` (mutation) | Đóng 1 phí GRID | RPC `pay_period_fee`; invalidate `['period-fee-status']`, `['income-expenses']`, `['accounts-with-balance']`, `['fee-accounts']` |
| `useCancelPeriodFee(period)` (mutation) | Hủy phiếu | RPC `cancel_period_fee`/`cancel_utility_bill` |
| `useFeeAccounts()` | mã NCC + số tiền mặc định theo tòa×hạng mục | `['fee-accounts']` (bảng `building_fee_accounts`) |
| `useUpsertFeeAccount()` (mutation) | Lưu cấu hình tòa×hạng mục | RPC `upsert_building_fee_account` |
| `usePeriodCommissions(period, buildingIds)` | HĐ ký kỳ + HH dự kiến + trạng thái | `['period-commissions', period]` → RPC `get_period_commissions` (tái dùng `calcContractMonths`/`findMatchingTier`) |
| `usePeriodMaintenance(period, buildingIds)` | Phiếu/batch bảo trì đã có trong kỳ | `['period-maintenance', period]` → RPC `get_period_maintenance` |
| (tái dùng) `useCreateCommissionVoucher`, `useCreateIncomeExpenseBatch`, `useIncomeExpenseBatches` | Tạo phiếu HH / phiếu tổng bảo trì | (đã có) |
| (tái dùng) `useUpdateIncomeExpense` | **Admin sửa TOÀN BỘ phiếu đã có** (mọi hạng mục) | (đã có) — invalidate thêm `['period-fee-status']`/`['period-commissions']`/`['period-maintenance']` |
| (tái dùng) `update_income_expense_quick` (bọc hook) | **Manager thêm ảnh + gán sổ trống** | RPC `update_income_expense_quick` (account/attachments/notes) |
| (tái dùng) `useVoucherDetail` | Mở chi tiết phiếu đã có để sửa | (đã có) |

**Tổng quát hóa hook state dùng chung**: đổi `useUtilityPayState` → `usePeriodPayState(period, category, buildings)` — mở rộng `key(bId, category)` (đang là `bId:type`), thêm state khoảng kỳ (`periodRange[key]`) cho multiPeriod, dùng `usePayPeriodFee`. Giữ nguyên phần đính ảnh / chọn sổ / autosave mã NCC (đổi sang `useUpsertFeeAccount`). Hai surface (desktop panel + mobile sheet) tiếp tục share hook này.

**Kiểu dữ liệu chính** (đề xuất trong `useUtilityBills.ts`/module mới):
```ts
type FeeCategoryKey = string;               // registry key
interface PeriodFeeStatus {                 // 1 dòng lưới GRID
  buildingId: string; categoryKey: FeeCategoryKey;
  paidAmount: number; coveredStart: string|null; coveredEnd: string|null;
  voucherIds: string[]; hasReceipt: boolean; accountName: string|null;
  accountIsEmpty: boolean;                  // có phiếu nhưng chưa gán sổ
  expectedAmount: number|null;              // từ default_amount
}
interface PeriodCommissionRow { contractId; contractNumber; buildingId; roomName; tenantName; signedDate; months; tierPercent; expectedAmount; voucherId: string|null; status: 'paid'|'unpaid'; }
interface MaintenanceGroup { batchId: string|null; payerName: string|null; total: number; lines: { voucherId; buildingId; buildingName; subtype: 'ml'|'mg'; amount; }[]; hasReceipt: boolean; }
```

---

## 7. Flow chi tiết theo family

### 7.1 GRID — đóng phí theo tòa (đơn/đa kỳ)
1. User chọn kỳ (`<input type=month>`) + chọn hạng mục ở **ô chọn loại phí** (VD "Internet").
2. Trang load: `useIncomeExpenseFormBuildings()` → lọc `!is_virtual` (và lọc `has_elevator` nếu `elevatorGated`); `usePeriodFeeStatus(period,[key],buildingIds)` → trạng thái mỗi tòa; `useFeeAccounts()` → mã NCC + `default_amount` (pre-fill ô tiền).
3. Mỗi tòa, 2 trạng thái:
   - **Chưa có phiếu** → ô nhập tiền + (nếu `multiPeriod`) chọn **khoảng kỳ** (từ kỳ → đến kỳ / số kỳ) + chọn sổ + đính ảnh + mã NCC/chủ hộ (autosave, pre-fill `default_amount`).
   - **Đã có phiếu** (kể cả "(tự động lập)") → hiển thị "đã đóng {paidAmount} (kỳ phủ {coveredStart–coveredEnd})" + sổ/ảnh, kèm **nút Sửa** (§5.7): admin sửa toàn bộ (`useUpdateIncomeExpense`), manager thêm ảnh / gán sổ khi trống (`update_income_expense_quick`). Nếu `accountIsEmpty` → nổi bật nhắc "chưa có sổ quỹ" để gán.
4. Bấm "Chi" → `usePayPeriodFee.mutate({buildingId, categoryKey, amount, periodStart, periodEnd, accountId, attachments, providerCode, holder})` → RPC `pay_period_fee`.
5. Đa kỳ: `periodStart≠periodEnd` → item `start_date`/`end_date` trải khoảng → **accrual tự chia đều** trong Báo cáo Lợi Nhuận (không code thêm). Ô "đã đóng" của MỌI kỳ trong khoảng sẽ hiện phủ (nhờ giao kỳ ở §5.4).
6. Hủy: `useCancelPeriodFee` (soft-delete). Refetch qua invalidate.

### 7.2 COMMISSION — Hoa hồng theo HĐ
1. Chọn hạng mục "Hoa hồng". `usePeriodCommissions(period, buildingIds)` → danh sách HĐ ký trong kỳ + HH dự kiến (`tierPercent`, `expectedAmount`) + trạng thái (đã có phiếu HH gắn `contract_id` chưa).
2. Mỗi HĐ chưa chi: hiển thị dự kiến, cho sửa số tiền/người nhận/bank → bấm "Chi HH" → `useCreateCommissionVoucher(...)` (mặc định tạo APPROVED khi thực chi; có "Lưu nháp" = UNAPPROVED). Đã chi: hiển thị phiếu (link mở chi tiết, sửa theo §5.7).
3. P&L: phiếu HH gắn `room_id` → hiện dòng "thanh toán hoa hồng" theo phòng (như ảnh báo cáo).

### 7.3 MAINTENANCE_BATCH — Bảo trì máy lạnh/máy giặt
1. Chọn hạng mục "Bảo trì máy lạnh/máy giặt". `usePeriodMaintenance(period, buildingIds)` → **các phiếu tổng/phiếu bảo trì ĐÃ CÓ** trong kỳ (gom theo batch; phiếu lẻ đứng riêng). Đây là phần "lấy phiếu đã có bên Thu chi".
2. Tạo mới: mở form gom N dòng (tòa × loại máy × tiền × kỳ) + NCC + ảnh → `useCreateIncomeExpenseBatch` → 1 batch (phiếu tổng) + N phiếu con theo tòa.
3. P&L: mỗi phiếu con quy chi phí đúng theo `building_id` của nó.

---

## 8. Edge cases, bất biến, gotcha

- **Đa-owner (staff đóng hộ chủ)**: type & config phải resolve theo **owner của TÒA**, chạy server-side (definer). KHÔNG resolve type ở FE (RLS chặn staff đọc type chủ). Đây là lý do `pay_period_fee`/`get_period_fee_status`/`resolve_fixed_expense_type` đều definer + tự kiểm quyền.
- **Chống trùng type**: `resolve_fixed_expense_type` **ưu tiên tái dùng** type sẵn có của owner (khớp matcher) trước khi tạo canonical → tránh đẻ type trùng làm P&L tách 2 dòng cùng nhóm.
- **Giao kỳ (không phải "đúng tháng")**: "đã đóng" xét theo **giao khoảng** `it.start_date ≤ cuối kỳ AND it.end_date ≥ đầu kỳ` (giống query utility hiện tại) → phí trả trước nhiều kỳ hiện "đã phủ" ở mọi kỳ trong khoảng.
- **Accrual vs tiền mặt**: đa kỳ = 1 phiếu, tiền mặt dồn tháng `voucher_date`; P&L "Phân bổ theo kỳ áp dụng" mới chia đều. Chốt số/khóa sổ (`create_opening_adjustment`) không đổi.
- **Quản Lý (restricted)**: `is_restricted=true` → RLS RESTRICTIVE ẩn phiếu với user thiếu quyền. `pay_period_fee` phải kiểm `restricted_create`; `get_period_fee_status` phải bỏ dòng restricted nếu caller thiếu `restricted_view`. (Xem `project_ie_restricted_categories`.)
- **KQKD**: phí cố định là chi phí thật → `business_result_accounting=TRUE` (hoặc null cho HH), `counts_in_business_result`/`kqkd_amount` do trigger tính. KHÔNG đặt is_deposit.
- **Sổ quỹ**: mặc định sổ `…Thu` của caller (ưu tiên `is_default`) — giữ logic hiện tại; cho chọn sổ khác của chính user/admin. `default_account_id` trong config là gợi ý pre-fill.
- **Batch thuộc caller**: `income_expense_batches` RLS `user_id=auth.uid()` → staff tạo batch thì batch thuộc staff (phiếu con `user_id=caller`). Nhất quán với utility (voucher `user_id=caller`). Lưu ý gap quy chủ chia LN nếu phiếu do staff tạo (xem `project_staff_userid_attribution_profit_gap`) — KHÔNG phát sinh mới bởi tính năng này.
- **Hủy phiếu**: chỉ phiếu `system_source IN ('utility.bill','fixed_fee')` mới hủy qua RPC utility; phiếu HH (draft) và phiếu con batch dùng đường hủy/xóa của Thu chi thường.
- **has_elevator**: chỉ tòa `buildings.has_elevator=true` hiện hạng mục Thang máy (khớp `requiresElevator`).
- **Tiền nhà (rent)**: là chi phí business trả CHỦ TÒA (không phải thu của khách). Đơn kỳ theo mặc định; bật `multiPeriod` nếu cần trả trước.

---

## 9. Phân quyền / RLS (điểm cần agent UI + backend lưu ý)
- **Gate trang & hành động**: các hạng mục mới là **CHI (expense)**, KHÁC "thu_tien.collect". Nên gate theo quyền `income_expenses` (create/approve) trên tòa, không dùng chung `thu_tien.collect`. Đề xuất: hiện ô chọn loại phí theo quyền; nút "Chi" mỗi hạng mục gate bằng quyền tương ứng (`canUse(perms,'income_expenses','create')` + building scope). **Cần chốt permission key với hệ `permissionPages.ts`** (xem `project_permission_page_catalog`).
- **2 tầng SỬA phiếu đã có** (§5.7):
  - *Admin* (`is_admin()`/`is_super_admin()`) → sửa toàn bộ (`useUpdateIncomeExpense`).
  - *Manager* (quyền `income_expenses.update` trên tòa) → chỉ **thêm ảnh** + **gán sổ quỹ khi trống** (`update_income_expense_quick`; ràng buộc set `account_id` chỉ khi đang NULL trừ admin). Gate FE bằng `canUse` + gate THẬT trong RPC definer.
- Mọi RPC ghi: `REVOKE PUBLIC/anon; GRANT authenticated`, SECURITY DEFINER + tự kiểm quyền + `search_path=public` (theo `project_code_generator_secdef_rls`, `project_contract_rpc_authz`).

---

## 10. Danh sách migration (thứ tự)
Áp qua Management API (UTF-8, tránh hỏng tiếng Việt — xem `project_migration_apply_via_api`):
1. `..._building_fee_accounts.sql` — bảng cấu hình tổng quát + copy từ `building_utility_accounts` + RLS + `upsert_building_fee_account`.
2. `..._nrm_vn_and_resolve_fixed_expense_type.sql` — `nrm_vn()` + `resolve_fixed_expense_type()`.
3. `..._pay_period_fee.sql` — RPC thanh toán tổng quát + wrapper `pay_utility_bill` (compat) + mở rộng `cancel_*`.
4. `..._get_period_fee_status.sql` — RPC trạng thái GRID.
5. `..._get_period_commissions.sql` — RPC HH theo HĐ.
6. `..._get_period_maintenance.sql` — RPC bảo trì đã có + gom batch.
7. (sau khi FE lên) `..._drop_building_utility_accounts.sql` — dọn bảng cũ (tùy chọn).

Mỗi migration kết bằng `NOTIFY pgrst, 'reload schema';`.

---

## 11. Kiểm thử end-to-end (bắt buộc trước khi tuyên bố xong)
Theo `CLAUDE.md`: type check + test → test trên web bằng Playwright MCP → seed/cleanup qua Supabase Management API (PAT trong `CLAUDE.local.md`).
1. `npx tsc -p tsconfig.app.json --noEmit` (không tăng lỗi mới); test `src/lib/fixedExpenseCategories.test.ts` + test mới cho `feeCategories.ts` và parity `nrm_vn` ↔ `nrm`.
2. **GRID đơn kỳ** (Vệ sinh/Điện): đóng 1 tòa → phiếu CHI hiện đúng kỳ; Báo cáo Lợi Nhuận tòa đó mất dòng "(chưa có phiếu)" tương ứng.
3. **GRID đa kỳ** (Internet trả trước 6 kỳ): đóng 1 lần khoảng 6 tháng → xem P&L "Phân bổ theo kỳ áp dụng" chia đều mỗi tháng; các kỳ trong khoảng đều hiện "đã phủ".
4. **Đa-owner**: đăng nhập staff (tài khoản test), đóng phí cho tòa của chủ → type resolve theo owner, phiếu tạo được, không lỗi RLS.
5. **Quản Lý (restricted)**: user thiếu quyền không thấy/không đóng được; user có quyền đóng được, phiếu ẩn đúng theo RLS.
6. **Hoa hồng**: tạo HĐ test ký trong kỳ → hiện ở tab HH với HH dự kiến khớp `commission_tiers`; chi HH → phiếu gắn `contract_id`, P&L hiện dòng "thanh toán hoa hồng" theo phòng.
7. **Bảo trì**: (a) tạo phiếu bảo trì lẻ bên Thu chi trước → trang "lấy qua" hiển thị; (b) tạo phiếu tổng N tòa → P&L từng tòa có chi phí bảo trì; kiểm batch detail.
8. **Lấy & sửa phiếu đã có** (§5.7): (a) chạy `generate_recurring_vouchers` để có phiếu "(tự động lập)" thiếu sổ → trang hiện "chưa có sổ quỹ"; đăng nhập **manager** → thêm ảnh + gán sổ trống, số dư sổ cập nhật; thử đổi sổ ĐÃ có → bị chặn. (b) Đăng nhập **admin** → mở phiếu đã có, sửa số tiền/kỳ/sổ/ảnh toàn bộ → P&L & lưới cập nhật đúng.
9. Quan sát `mcp__playwright__browser_console_messages` — không lỗi.
10. Cleanup dữ liệu seed sau test.

---

## 12. Hạng mục để lại (future / tùy chọn)
- Thêm `bao_tri_may_lanh`/`bao_tri_may_giat` vào `FIXED_EXPENSE_CATEGORIES` để P&L cảnh báo "(chưa có phiếu)" theo tòa.
- "Nhắc còn thiếu": tổng hợp các tòa×hạng mục chưa đóng của kỳ (dựa `get_period_fee_status` + `default_amount`) như một dashboard nhỏ.
- Bật `multiPeriod` cho `tien_nha` khi có nhu cầu trả trước tiền nhà.
- Đồng bộ tài liệu hệ thống `docs/he-thong/` (thêm mô tả trang đóng tiền tập trung).

---

## 13. Phạm vi bàn giao & bước tiếp theo
- Tài liệu này là **spec-only** để agent UI/UX dựng giao diện + ghép vào các hook/RPC ở trên.
- **Backend (migrations §10 + RPC §5 + hook data §6)** và **UI (§7)** có thể làm chung một phiên hoặc tách phiên. Đề xuất thứ tự: (1) migrations + RPC + hook data (kèm test §11 mục 1–8 qua Management API), rồi (2) UI/UX ghép lên hook đã sẵn.
- Khi bắt đầu code: đọc kỹ §2 (tái dùng tối đa code hiện có), tuân §8/§9 (đa-owner, RLS, restricted), và chạy đủ §11 trước khi tuyên bố xong.
