# Hiểu rõ 2 trang Resident: `Thu chi` & `Tài khoản (Cashbooks)`

> Tổng hợp từ:
> - Crawl thực tế (HTML/text/screenshot/API JSON) trong [crawl-resident/data/](crawl-resident/data/) và [crawl-resident/data-deep/](crawl-resident/data-deep/)
> - Tài liệu chính thức: [thu-chi-va-tai-khoan.md](thu-chi-va-tai-khoan.md)
>
> Mục đích: làm chuẩn để build/tinh chỉnh 2 trang tương ứng tại `crm`:
> - `/income-expense` (Thu chi) — đã có, cần bổ sung
> - `/setting/finance/cashbooks` (Tài khoản) — chưa có, cần dựng mới

---

## 1. Trang Thu chi — `https://app.resident.vn/income-expenses`

### 1.1. Bố cục trang

```
┌─────────────────────────────────────────────────────────────┐
│ Sidebar    │  Breadcrumb: Tài chính → Thu chi               │
│            │                                                 │
│            │  ┌──────────────────────────────────────────┐  │
│            │  │ STAT CARDS  (3 ô)                        │  │
│            │  │  Thu: 17,156,343,026                     │  │
│            │  │  Chi:  5,032,980,352                     │  │
│            │  │  Thu - Chi: 12,123,362,674               │  │
│            │  └──────────────────────────────────────────┘  │
│            │                                                 │
│            │  Toolbar (filter inline + actions)             │
│            │  [Khoảng tg] [Khu vực] [Tòa] [Phòng] [Giường] │
│            │  [Tài khoản]                       [+ Thêm]    │
│            │                                                 │
│            │  Bảng danh sách phiếu                          │
│            │  ┌─┬──┬──────┬───┬──────┬────┬─────┬──┬────┐  │
│            │  │ │Mã│Thaotác│Tên│Sốtiền│Tòa│Ngày │Ng│TK  │  │
│            │  ├─┼──┼──────┼───┼──────┼────┼─────┼──┼────┤  │
│            │  │ │…│…     │ … │…     │…   │…    │…│…   │  │
│            │  └─┴──┴──────┴───┴──────┴────┴─────┴──┴────┘  │
│            │  Số bản ghi 10 │ 1 - 10 / 5602 │  ◀ 1 2 3 ▶  │
│            │                                                 │
│            │  Câu hỏi thường gặp (FAQ accordion)            │
└─────────────────────────────────────────────────────────────┘
```

### 1.2. 3 thẻ thống kê (top cards)

API: `GET /v1/income-expense/analytics?searchTerm=&filter={}` → `data`:
```json
{
  "totalIncome": 17156343026,  "totalIncomeText": "17,156,343,026",
  "totalExpense": 5032980352,  "totalExpenseText": "5,032,980,352",
  "delta": 12123362674,        "deltaText": "12,123,362,674",
  "items": [
    { "title": "Thu", "value": ..., "color": "#5356FF" },
    { "title": "Chi", "value": ..., "color": "..." }
  ]
}
```

Hiển thị 3 ô lớn (giá trị to, label nhỏ ở dưới): **Thu / Chi / Thu - Chi**. Cập nhật theo bộ lọc.

### 1.3. Thanh lọc (inline)

Theo crawl, các filter được hiển thị **inline** trên toolbar (không phải drawer):

| Filter | Kiểu | API filter key (suy đoán) |
|---|---|---|
| Khoảng thời gian | DateRange | `issueDate` (from/to) |
| Khu vực | Select | `areaId` |
| Tòa nhà | Select (cascade từ Khu vực) | `apartmentId` |
| Phòng | Select (cascade từ Tòa) | `roomId` |
| Giường | Select (cascade từ Phòng) | `bedId` |
| Tài khoản (Sổ quỹ) | Select | `cashbookId` |
| (Loại phiếu — Thu / Chi) | Tab/Toggle | `isIncome` |
| (Trạng thái duyệt) | Select | `approve` |

Tài liệu Resident còn liệt kê: **Loại phiếu**, **Trạng thái duyệt**, **Khách hàng**, **Hạng mục** — có thể nằm trong popup "Lọc nâng cao".

Search box (chuỗi text) → query `?searchTerm=...`.

### 1.4. Cột bảng phiếu thu chi

| # | Cột | Chi tiết |
|--|--|--|
| 1 | Checkbox | bulk action |
| 2 | **Mã** | `TC962620` (prefix `TC`), kèm **Badge trạng thái duyệt** ("Đã duyệt"/"Chưa duyệt") |
| 3 | **Thao tác** | 3 icon: ✅ Duyệt/Bỏ duyệt · ✏️ Sửa · 🗑 Xoá |
| 4 | **Tên** | Tên phiếu + dòng phụ là Ghi chú/Loại tài khoản (vd. `Tiền mặt`, `-`, `Phiếu chi lập tự động theo chu kỳ ...`) |
| 5 | **Số tiền** | Hiển thị có dấu: `+2,970,000 đ` xanh / `-31,000 đ` đỏ |
| 6 | **Tòa nhà** | Tên tòa, dòng dưới là phòng (`80ĐS3` / `403`) |
| 7 | **Ngày thu/chi** | `dd-MM-yyyy` |
| 8 | **Người nhận/trả** | `payer` (chi) / `receiver` (thu) |
| 9 | **Tài khoản** | Tên cashbook (vd. `Hiệp chi`, `Quỹ CTY`, `158-417`) |

Phân trang dưới: page size 10, hiển thị **Số bản ghi · A - B trên tổng N · ◀ 1 2 3 4 5 ... ▶**.

### 1.5. Form Thêm phiếu (popup `[role=dialog]`)

Tiêu đề: **PHIẾU THU/CHI**. Có **2 tab lớn ở đầu**: `Phiếu thu` | `Phiếu chi`.

```
─── 1. Thông tin chung ────────────────────────────
  Tòa nhà            [Chọn tòa nhà]
  Phòng              [Chọn phòng]
  Giường             [Chọn giường]
  Hợp đồng           [Chọn]
  Tên phiếu thu/Lý do thu *      [text]
  Tên người nộp *                [text]
  Tài khoản *        [Chọn]
  Ngày thực thu *    [25-04-2026]
  Ghi chú            [textarea]

─── 2. Hạng mục ──────────────────────────────────
  ☐  Hạch toán kết quả kinh doanh?
  ┌──────────────────────────────────────────┐
  │ Hạng mục *      [Chọn]                   │
  │ Số tiền *       [number]                 │
  │ Ngày bắt đầu *  [date]                   │
  │ Ngày kết thúc * [date]                   │
  │                                  [🗑]    │
  └──────────────────────────────────────────┘
  [+ Thêm hạng mục]

─── 3. Đính kèm ──────────────────────────────────
  Tệp đính kèm  [drag-drop/upload]

         [Hủy bỏ]   [Lưu]
```

**Quy tắc:**
- Trường có dấu `*` là bắt buộc.
- Tòa → Phòng → Giường: dropdown cascade.
- "Hạch toán kết quả kinh doanh?" là switch (boolean) → ảnh hưởng báo cáo P&L.
- Hạng mục là mảng N dòng (mỗi dòng 1 type + amount + start/end date cho phân bổ doanh thu/chi phí theo kỳ).

### 1.6. Quy tắc trạng thái

| Trạng thái | Sửa | Xoá |
|---|---|---|
| `Bỏ duyệt` (UNAPPROVED) | ✅ | ✅ |
| `Đã duyệt` (APPROVED) | ❌ | ❌ |

Phiếu nằm trong **Tài khoản đã khoá sổ** + ngày phát sinh ≤ ngày khoá sổ → bị **chặn** mọi thao tác sửa/xoá/tạo mới.

### 1.7. Import nhiều phiếu

Toolbar có nút **Thêm dữ liệu** (icon mũi tên lên) → Dialog:
1. Link tải file Excel mẫu
2. Drag-drop / Chọn file
3. Nút **Nhập dữ liệu**

Khi xong: toast `"Dữ liệu đã được TẠO thành công"`.

### 1.8. FAQ

Resident render 4 câu hỏi gấp ở cuối trang:
- Có các khoản chi định kỳ, làm sao để tự động tạo?
- Một số khoản chi chung cho công ty/tổ chức thì có tạo được không?
- Tôi muốn tạo xong biên lai sẽ tự động duyệt luôn?
- Đối với biên lai khách chuyển tiền gạch nợ nhưng sửa nội dung thì làm sao?

### 1.9. API endpoints liên quan

| Endpoint | Mô tả |
|---|---|
| `GET /v1/income-expense?page=&perPage=&searchTerm=&filter=` | List có phân trang + filter (json-encoded) |
| `GET /v1/income-expense/analytics?...` | 3 thẻ thống kê |
| `GET /v1/income-expense/:id` | Detail (kèm `items`, `attachments`, `creator`, `cashbook`) |
| `POST /v1/income-expense` | Tạo |
| `PUT /v1/income-expense/:id` | Sửa |
| `DELETE /v1/income-expense/:id` | Xoá (chỉ khi `approve=false`) |
| `POST /v1/income-expense/:id/approve` | Duyệt |
| `POST /v1/income-expense/:id/unapprove` | Bỏ duyệt |
| `POST /v1/income-expense/import` | Import Excel |
| `GET /v1/income-expense-type?perPage=1000` | Danh mục hạng mục để chọn trong form |
| `GET /v1/cashbook/select` | Danh mục tài khoản để chọn trong form |

### 1.10. Schema 1 phiếu (rút gọn từ JSON crawl)

```ts
type IncomeExpense = {
  id: number;
  code: string;                   // "TC962620"
  name: string;                   // "Ship camera"
  amount: number;                 // 31000
  issueDate: string;              // ISO
  payer: string;                  // người nộp (thu) / "" (chi)
  receiver: string;               // người nhận (chi)
  note: string | null;
  isIncome: boolean;              // true=thu, false=chi
  approve: boolean;               // đã duyệt?
  allocation: boolean;            // hạch toán P&L?
  allocationStartDate: string|null;
  allocationEndDate: string|null;
  repeatCycle: "0"|"week"|"month"|...;  // chu kỳ lặp
  repeatInfinity: boolean;
  repeatCount: number;
  apartmentId, roomId, bedId, tenantId, contractId, reservationId,
  cashbookId: number;             // FK tài khoản
  invoiceId: number | null;       // nếu sinh từ hoá đơn
  refId: number | null;           // ref tới phiếu cha (khi auto-generate)
  apartment: { id, name } | null;
  room: { id, name } | null;
  cashbook: { id, name };
  items: IncomeExpenseItem[];     // 1+ hạng mục
  attachments: { id, location: url }[];
  creator: { id, user: { name, phone } };
};

type IncomeExpenseItem = {
  id, name, amount,
  issueDate, startDate, endDate,
  apartmentId, roomId, bedId, tenantId, contractId,
  cashbookId, incomeExpenseTypeId, invoiceId,
  incomeExpenseType: {
    id, code, name, identity: "rent"|"electric"|"water"|"other"|...,
    identityObject: { value, title }
  }
}
```

---

## 2. Trang Tài khoản (Cashbooks) — `https://app.resident.vn/setting/finance/cashbooks`

### 2.1. Bố cục

```
Cài đặt → Danh mục khác → Tài chính → Tài khoản

Toolbar:  [+ Thêm]                         [🔍 search] [⋮]

┌──┬───────┬───────┬──────────────┬─────────────────────┬─────────────┬─────────────┬────────┐
│☐ │  Mã   │ Thao  │ Tên tài khoản│   Loại tài khoản    │ Số dư đầu kỳ│   Tồn quỹ   │ Ghi chú│
│  │       │ tác   │              │                     │             │             │        │
├──┼───────┼───────┼──────────────┼─────────────────────┼─────────────┼─────────────┼────────┤
│☐ │TK025170│ … … …│ 102          │ Tiền mặt            │           0 │ 173,227,200 │        │
│☐ │TK016966│ … … …│ 44TRUNGLANG  │ Tài khoản ngân hàng │           0 │ 655,891,364 │        │
│☐ │TK015260│       │ Trung lang  │ Tài khoản ngân hàng │           0 │ -11,958,000 │        │
│ ...                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
Số bản ghi 10 │ 1 - 10 trên tổng số 20 bản ghi │ ◀ 1 2 ▶
```

### 2.2. Cột bảng

| # | Cột | Mô tả |
|---|---|---|
| 1 | ☐ | bulk select |
| 2 | **Mã** | `TKxxxxxx` — auto-generate, không edit |
| 3 | **Thao tác** | 3 icon: 🔒 Khoá sổ · ✏️ Sửa · 🗑 Xoá |
| 4 | **Tên tài khoản** | name |
| 5 | **Loại tài khoản** | "Tiền mặt" / "Tài khoản ngân hàng" / "Ví điện tử" |
| 6 | **Số dư đầu kỳ** | `initialAmount`, format `vi-VN` (ví dụ `0`) |
| 7 | **Tồn quỹ** | `currentAmount` (tính = đầu kỳ + Σ Thu − Σ Chi đã duyệt). Có thể **âm**, in màu đỏ |
| 8 | **Ghi chú** | `note` |

### 2.3. Schema 1 cashbook (từ API `GET /v1/cashbook?...`)

```ts
type Cashbook = {
  id: number;
  code: string;                  // "TK025170"  (auto, prefix TK + 6 chữ số)
  name: string;                  // "102", "44TRUNGLANG", "Quỹ CTY"
  type: "cash" | "bank" | "ewallet";
  typeName: string;              // "Tiền mặt" | "Tài khoản ngân hàng" | "Ví điện tử"
  bankAccountNumber: string|null;
  bankAccountHolder: string|null;
  bankName: string | null;
  bankAddress: string | null;
  note: string | null;
  default: boolean;              // mặc định
  initialAmount: number;         // số dư đầu kỳ (nhập tay)
  initialDate: string;           // ngày chốt đầu kỳ (ISO)
  currentAmount: number;         // tồn quỹ (computed)
  lockDate: string | null;       // ngày khoá sổ (nếu đã khoá)
  ownerId, bankId, created_at, updated_at, deleted_at
};
```

### 2.4. Dialog **Thêm tài khoản**

Tiêu đề: **THÊM TÀI KHOẢN NGÂN HÀNG/TIỀN MẶT**.

```
Loại tài khoản *        [○ Tiền mặt]  [○ Ngân hàng]  [○ Ví điện tử]
Tên tài khoản *         [text]
Số dư đầu kỳ            [number]   (default 0)
Ngày chốt số dư đầu kỳ  [date]     (default hôm nay)
Mô tả                   [textarea]

(Khi chọn Ngân hàng / Ví điện tử thì hiện thêm:)
   Ngân hàng / Nhà cung cấp ví   [select / text]
   Số tài khoản                  [text]
   Tên chủ tài khoản             [text]
   Chi nhánh                     [text]

                         [Hủy bỏ]  [Lưu]
```

Toast khi thành công: `"Thông tin đã được cập nhật lưu trữ thành công"`.

### 2.5. Sửa / Xoá

- **Sửa**: cùng dialog, prefill data.
- **Xoá**: confirm "Bạn đang thực hiện thao tác xoá tài khoản ngân hàng/tiền mặt. Bạn có chắc chắn muốn xoá không?". Cảnh báo: ảnh hưởng tới phiếu thu/chi đang gắn vào tài khoản này.

### 2.6. Khoá sổ

- Icon 🔒 trên hàng → dialog "Khoá sổ":
  - Chọn **Ngày khoá sổ**.
  - Nhấn **Lưu** → set `lockDate`.
- Sau khi khoá: mọi phiếu thu/chi của cashbook này có `issueDate ≤ lockDate` đều **chặn** sửa/xoá/tạo mới.
- Có thể "Mở lại sổ" (set `lockDate = null`) — nếu hệ thống cho phép.

### 2.7. API endpoints

| Endpoint | Mô tả |
|---|---|
| `GET /v1/cashbook?page=&perPage=&searchTerm=&filter=` | List cashbook |
| `GET /v1/cashbook/select` | Dropdown lite (id+name) cho form thu chi & filter |
| `POST /v1/cashbook` | Thêm |
| `PUT /v1/cashbook/:id` | Sửa |
| `DELETE /v1/cashbook/:id` | Xoá |
| `POST /v1/cashbook/:id/lock` | Khoá sổ (set lockDate) |
| `POST /v1/cashbook/:id/unlock` | Mở lại sổ |

---

## 3. So sánh với code hiện tại của crm

### 3.1. Trang `/income-expense` — đã có `IncomeExpensePage.tsx`

| Yếu tố Resident | crm hiện tại | Ghi chú |
|---|---|---|
| 3 thẻ stats Thu/Chi/Thu-Chi | ✅ `IncomeExpenseStats` | OK |
| Inline filter bar | ✅ `IncomeExpenseFiltersBar` | OK (có khu vực, tòa, phòng, giường, tài khoản…) |
| Search box | ✅ | OK |
| Bảng cột Mã/Thao tác/Tên/SốTiền/Tòa/Ngày/NgườiNT/TK | ✅ `IncomeExpenseList` | OK – có badge "Đã duyệt/Chưa duyệt", icon Duyệt/Sửa/Xoá |
| Dialog Phiếu thu/Phiếu chi (Tab) + 3 mục Thông tin/Hạng mục/Đính kèm | ✅ `IncomeExpenseForm` | OK – đã có cascade Tòa→Phòng→Giường, hạng mục N dòng, attachments |
| Trạng thái duyệt (approve/unapprove RPC) | ✅ | OK |
| Import Excel | ✅ `IncomeExpenseImportDialog` | OK |
| Filter "Trạng thái duyệt" | ✅ trong types `IncomeExpenseFilters` | Cần kiểm tra UI có expose chưa |
| Filter "Loại phiếu" (Thu/Chi) | ✅ trong types | UI có thể chưa hiển thị toggle |
| Hạch toán KQKD (`business_result_accounting`) | ✅ | OK |
| Allocation start/end date item | ✅ | OK |

Trang Thu chi **về cơ bản đã đầy đủ**. Chỉ cần soi lại UI có expose đủ filter "Loại phiếu" và "Trạng thái duyệt" hay không.

### 3.2. Trang `/setting/finance/cashbooks` — **CHƯA CÓ**

Hiện có:
- Bảng `accounts` đã được tạo trong migration `20251120000001_thu_chi_ui_alignment.sql` với fields:
  - `id, user_id, name, type ('bank'|'cash'), bank_name, account_number, is_default, created_at, updated_at, deleted_at`
- Hook `useAccounts.ts` chỉ select-list, **không có** mutation create/update/delete.

**Thiếu so với Resident:**

| Field Resident | crm `accounts` | Cần làm |
|---|---|---|
| `code` (TKxxxxxx) | ❌ | Thêm cột + auto-generate trigger |
| `type = 'ewallet'` | ❌ chỉ `bank/cash` | Mở rộng CHECK constraint |
| `bank_account_holder` | ❌ | Thêm cột |
| `bank_address` | ❌ | (optional) thêm cột |
| `note` / `description` | ❌ | Thêm `description TEXT` |
| `initial_amount` (số dư đầu kỳ) | ❌ | Thêm cột `NUMERIC NOT NULL DEFAULT 0` |
| `initial_date` (ngày chốt đầu kỳ) | ❌ | Thêm `DATE NOT NULL DEFAULT CURRENT_DATE` |
| `current_amount` (tồn quỹ) | ❌ | View hoặc cột generated/computed từ income_expenses |
| `lock_date` (ngày khoá sổ) | ❌ | Thêm `DATE NULL` |

Trang Cashbooks UI: **chưa có file**. Cần tạo:
- `src/pages/settings/finance/CashbooksPage.tsx`
- `src/components/cashbooks/CashbookList.tsx` (table)
- `src/components/cashbooks/CashbookForm.tsx` (dialog Thêm/Sửa)
- `src/components/cashbooks/CashbookLockDialog.tsx` (dialog khoá sổ)
- Mở rộng `useAccounts.ts` thành đầy đủ CRUD + lock/unlock + tính `currentAmount`.
- Route `/setting/finance/cashbooks` trong `App.tsx`.

Trên trang Thu chi, validation cũng cần cập nhật: nếu cashbook đã khoá và `voucher_date <= lock_date` → reject create/update/delete.

---

## 4. Kế hoạch thực thi (theo thứ tự)

1. **DB migration mới** mở rộng bảng `accounts`:
   - `code TEXT UNIQUE` (auto-gen `TK` + sequence)
   - `description TEXT`
   - `bank_account_holder TEXT`
   - `initial_amount NUMERIC NOT NULL DEFAULT 0`
   - `initial_date DATE NOT NULL DEFAULT CURRENT_DATE`
   - `lock_date DATE`
   - Mở rộng CHECK `type IN ('cash','bank','ewallet')`
   - View `accounts_with_balance` (hoặc function) trả `current_amount`
   - Trigger validate khoá sổ trên `income_expenses`
2. **Hook `useAccounts.ts`**: thêm `useAccountsWithBalance`, `useCreateAccount`, `useUpdateAccount`, `useDeleteAccount`, `useLockAccount`, `useUnlockAccount`.
3. **UI Cashbooks**:
   - Page với toolbar `[+ Thêm]` + search + table 8 cột.
   - Form dialog 3 loại (cash/bank/ewallet) với fields tương ứng.
   - Dialog khoá sổ.
   - Routing: thêm `/setting/finance/cashbooks` (và `/settings/finance/cashbooks` redirect tương tự pattern hiện tại).
4. **Bổ sung trang Thu chi**:
   - Soi lại `IncomeExpenseFiltersBar` có expose toggle "Phiếu thu/Phiếu chi" + "Trạng thái duyệt" chưa, thêm nếu thiếu.
   - Validation client-side khi `account.lock_date && voucher_date <= lock_date`.
5. **QA**: chạy `vercel dev` / `npm run dev`, mở 2 tab so sánh side-by-side crm vs Resident.

---

## 5. Mapping hiển thị → DB (cheat-sheet)

| Resident UI | API field | crm DB |
|---|---|---|
| Mã `TC962620` | `code` | `income_expenses.code` |
| Mã `TK025170` | `code` | `accounts.code` (cần thêm) |
| Tên phiếu | `name` | `income_expenses.name` |
| Số tiền | `amount` | `income_expenses.total_amount` |
| Ngày thu/chi | `issueDate` | `income_expenses.voucher_date` |
| Người nhận/trả | `payer` / `receiver` | `income_expenses.payer_name` |
| Tài khoản | `cashbook.name` | `accounts.name` |
| Đã duyệt | `approve: true` | `approval_status='APPROVED'` |
| Tồn quỹ | `currentAmount` | computed = `initial_amount + Σ INCOME − Σ EXPENSE` (chỉ phiếu APPROVED) |
| Số dư đầu kỳ | `initialAmount` | `accounts.initial_amount` (cần thêm) |
| Ngày khoá sổ | `lockDate` | `accounts.lock_date` (cần thêm) |
