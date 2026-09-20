# Thiết kế — Khu "Hợp đồng & Quyết toán" trên `/thanh-toan`

> **Trạng thái:** CHƯA THI HÀNH. Chờ audit độc lập rồi mới viết mã.
> **Ngày:** 2026-09-20 · **Nguồn:** bản thiết kế `Thanh toan - Hop dong & quyet toan.dc.html`
> (claude.ai/design project `3990b67f-b343-490a-acc7-05fead85c684`).
> **Không có migration.** Mọi hành động gọi lại RPC đã chạy trên production.

---

## 0. Dành cho người audit — đọc mục này trước

Tài liệu này khẳng định nhiều điều về production. **Mọi khẳng định đều kèm cách đo lại.**
Việc của bạn là chứng minh chúng sai, không phải tin.

Mục [§8](#8-danh-sách-khẳng-định-cần-audit) liệt kê 14 khẳng định đánh số `KD-01`…`KD-14`.
Mục [§7](#7-sổ-xung-đột) là các xung đột tôi đã tìm ra; nếu bạn tìm thêm, ghi vào đó.

Cách đo lại số liệu production (chỉ SELECT):

- Đường đọc: **session pooler**. Host / user / password lấy từ `CLAUDE.local.md`
  (mục "Supabase Database") — file đó gitignore, **không chép giá trị vào đây**.
- Script phải **tự đọc password từ file**; đặt lên dòng lệnh sẽ bị chặn.
- `pg` chỉ có trong `node_modules` của repo → chạy kèm `NODE_PATH` trỏ về repo.
- **PAT Supabase (`sbp_…`) đã chết từ 19/09/2026** — Management API trả 401.
  Mọi hướng dẫn cũ bảo tra dữ liệu qua `POST /v1/projects/{ref}/database/query` đều vô dụng.
- Chỉ `SELECT`, bọc trong `BEGIN READ ONLY` … `ROLLBACK`. Đổi schema vẫn phải đi `migrate:forward`.

SQL của từng số đo nằm ngay cạnh số đó trong [§2](#2-số-đo-production).

---

## 1. Việc cần làm và lý do

### 1.1. Hiện trạng

Trang `/thanh-toan` ("Đóng tiền Tập trung theo Kỳ") có một ô chọn hạng mục phí.
Trong đó **ba hạng mục rời nhau** cùng nói về tiền chi phát sinh từ hợp đồng:

| Key registry | Nhãn | Family | Nơi hiển thị |
|---|---|---|---|
| `hoa_hong` | Hoa hồng môi giới | `COMMISSION` | `PeriodFeePanel.tsx:661`, `PeriodFeeSheet.tsx:496` |
| `chi_thanh_ly` | Chi thanh lý (hoàn cọc) | `TERMINATION_REFUND` | `SettlementPanels.tsx` → `TerminationRefundQueueSection` |
| `thuong_sale` | Thưởng Sale | `SALE_BONUS` | `SettlementPanels.tsx` → `SaleBonusSection` |

Ba mục này dùng ba bảng khác nhau, ba bộ thống kê khác nhau, ba nút "Thao tác" khác nhau.
Người giữ sổ phải vào ba chỗ để biết còn nợ ai bao nhiêu.

### 1.2. Quyết định của chủ (20/09/2026)

Nguyên văn các lựa chọn đã chốt:

1. **Xoá hẳn 3 mục cũ**, làm mới thành **một** khu "Hợp đồng & Quyết toán".
2. **Không viết đường ghi tiền mới** — "các luồng rpc duyệt chi ghi tiền đều đã có sẵn ở thu-chi,
   trang này chỉ là hiển thị lại tổng hợp để thao tác nhanh và rõ ràng hơn".
3. **Chỉ desktop.** Chấp nhận sheet mobile (<1024px) mất luôn 3 sổ này.
4. Nút "Lập phiếu" **đổi tên thành "Chuyển Chờ Duyệt"** cho rõ nghĩa.
5. Điều kiện "cần rà soát" **không định nghĩa cứng** — mỗi điều kiện là một chip bật/tắt.
6. **Không cho gán sổ quỹ ở màn này**; sổ chọn lúc bấm Chi. Và **không lọc theo "thiếu sổ quỹ"** —
   nó không còn là vướng mắc (bổ sung 20/09, sau khi xem lại số đo §2.3).
7. Tab "Biến động" **để đợt sau**; đợt này chỉ tab "Khoản chi".

### 1.3. Ngoài phạm vi đợt này

- Tab "Biến động" (Ký mới · Gia hạn · Thanh lý · Bỏ cọc · Giữ chỗ).
- Mobile.
- Hạng mục `coc_da_thu` (Cọc đã thu) — **giữ nguyên**, không đụng.
- Mọi thay đổi schema.

---

## 2. Số đo production

Đo ngày 2026-09-20, chỉ SELECT, trong `BEGIN READ ONLY` + `ROLLBACK`.

### 2.1. Route Finance V2 — cả ba org đều CANONICAL `[KD-01]`

```sql
SELECT o.ten, f.feature_key, app_private.evaluate_feature_route(f.feature_key, o.id) AS route
FROM (VALUES ('THAT','aaaa0000-0000-4000-8000-000000000001'::uuid),
             ('DEMO','dddd0000-0000-4000-8000-000000000001'::uuid),
             ('TEST','cccc0000-0000-4000-8000-000000000001'::uuid)) AS o(ten,id)
CROSS JOIN (VALUES ('income_expense.workflow.v2'),('income_expense.posting.v2'),
                   ('income_expense.read_semantics.v2'),('cashbook.access.v2')) AS f(feature_key);
```

Kết quả: **12/12 dòng đều `CANONICAL`**. Bốn cờ đều `mode=ON`, `force_freeze=false`.

**Hệ quả thiết kế:** ba nấc Chờ duyệt → Đã duyệt · chờ chi → Đã chi là **có thật**, không phải
nấc vẽ ra cho đẹp. Và đường ghi phải đi RPC V2, không đi legacy.

### 2.2. Tồn đọng org THẬT `[KD-02]`

```sql
SELECT CASE WHEN system_source LIKE 'termination.refund%' THEN 'hoan_thanh_ly'
            WHEN commission_kind='broker' THEN 'hoa_hong'
            WHEN commission_kind='sale' THEN 'thuong_sale' END AS loai,
       approval_status, posting_status, count(*) AS n, sum(total_amount)::bigint AS tong,
       min(voucher_date) AS cu_nhat
FROM public.income_expenses
WHERE deleted_at IS NULL AND organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND approval_status<>'CANCELLED'
  AND (system_source LIKE 'termination.refund%' OR commission_kind IN ('broker','sale'))
  AND NOT (approval_status='APPROVED' AND posting_status IN ('POSTED','NOT_APPLICABLE'))
GROUP BY 1,2,3;
```

| Loại | Chờ duyệt | Số tiền | Phiếu cũ nhất |
|---|---:|---:|---|
| Hoa hồng | 46 | 108.390.000 đ | 28/07/2026 |
| Hoàn thanh lý | 42 | 156.289.834 đ | 29/07/2026 |
| Thưởng sale | 8 | 1.100.000 đ | 15/07/2026 |
| **Tổng** | **96** | **265.779.834 đ** | |

Không có phiếu nào ở trạng thái "Đã duyệt · chờ chi". Tất cả tồn đọng đều đang ở **Chờ duyệt**.

### 2.3. Vướng mắc đo được trên 96 phiếu `[KD-03]`

```sql
SELECT CASE WHEN system_source LIKE 'termination.refund%' THEN 'hoan_thanh_ly'
            WHEN commission_kind='broker' THEN 'hoa_hong'
            WHEN commission_kind='sale' THEN 'thuong_sale' END AS loai,
       (COALESCE(receive_bank_account,'')='') AS thieu_stk,
       (account_id IS NULL) AS thieu_so_quy, count(*)
FROM public.income_expenses
WHERE deleted_at IS NULL AND organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND approval_status='UNAPPROVED'
  AND (system_source LIKE 'termination.refund%' OR commission_kind IN ('broker','sale'))
GROUP BY 1,2,3;
```

| Vướng mắc | Số phiếu |
|---|---:|
| Thiếu số tài khoản người nhận | **90 / 96** |
| Thiếu sổ quỹ | 31 / 96 |

**Đây là lý do chủ chọn chip bật/tắt thay vì định nghĩa cứng:** nếu "thiếu STK" mặc định là
"cần rà soát" thì 90/96 phiếu đổ vào đó, danh sách mất hết tác dụng phân loại.

**"Thiếu sổ quỹ" KHÔNG được coi là vướng mắc** (chủ quyết 20/09). Số 31 ở trên chỉ ghi lại để
tham khảo. Lý do: sổ quỹ chọn trong hộp thoại Chi, mà hộp thoại đó chỉ liệt kê sổ người bấm đang
giữ — nên phiếu chưa gắn sổ **không** cản việc chi. Gắn nhãn đỏ cho nó là báo động giả, và cho
lọc theo nó là mời người dùng đi sửa một thứ họ không có quyền sửa ([§4.2](#42-bổ-sung-tên--stk--ngân-hàng) điều kiện 4).

### 2.4. Sở hữu luồng — quyết định phiếu có sửa tay được không `[KD-04]`

```sql
SELECT COALESCE(o.flow_kind,'(khong co)') AS flow_kind, ie.review_state, ie.review_version, count(*)
FROM public.income_expenses ie
LEFT JOIN app_private.income_expense_flow_ownership o ON o.income_expense_id = ie.id
WHERE ie.deleted_at IS NULL AND ie.organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND ie.approval_status='UNAPPROVED'
  AND (ie.system_source LIKE 'termination.refund%' OR ie.commission_kind IN ('broker','sale'))
GROUP BY 1,2,3;
```

**Kết quả: 0/96 phiếu có dòng sở hữu luồng.** `review_state` đều là `PENDING`
(95 phiếu `review_version=1`, 1 phiếu `review_version=2`).

Phân bố `flow_kind` toàn hệ thống: `INVOICE_COLLECTION_V5` 652 · `CANONICAL_INCOME_EXPENSE` 503 ·
`INVOICE_COLLECTION_REVERSAL_V5` 3 · `INVOICE_REFUND` 3.

**Hệ quả:** phiếu hoàn / hoa hồng / thưởng **không bị writer hệ thống khoá** ⇒ sửa được tên,
số tài khoản, ngân hàng người nhận bằng RPC thủ công. Xem [§4.2](#42-bổ-sung-tên--stk--ngân-hàng).

### 2.5. Dữ liệu cho tab Biến động (đợt sau, ghi lại để khỏi đo lại)

| Bảng | Giá trị |
|---|---|
| `contract_terminations` | `NORMAL/COMPLETED` 76 · `FORFEIT/COMPLETED` 36 |
| `contract_extensions` | `UPDATE_EXISTING/COMPLETED` 109 |
| `room_reservation_holds` | `EXPIRED` 2 · `PENDING_APPROVAL` 1 |
| `reservation_deposit_settlements` | `reason_code=OTHER` 1 |

---

## 3. Vòng đời phiếu — sự thật trong DB

### 3.1. Bốn nấc, giao diện mới dùng ba

```
                 request_income_expense_changes_v2
          ┌──────────────────────────────────────────────┐
          │                                              ▼
   ┌─────────────┐                              ┌──────────────────┐
   │ Chờ duyệt   │                              │ Đã y/c bổ sung   │
   │ UNAPPROVED  │◄─────────────────────────────│ UNAPPROVED       │
   │ PENDING     │   resubmit_income_expense_v2 │ CHANGES_REQUESTED│
   └─────────────┘                              └──────────────────┘
          │  │                                              │
          │  └──────────────┐          (duyệt được từ CẢ HAI)
          ▼                 ▼                               │
   ┌─────────────┐   ┌─────────────┐◄─────────────────────┘
   │ Đã duyệt    │   │   Đã chi    │
   │ chờ chi     │──►│  APPROVED   │
   │ APPROVED    │   │  POSTED     │
   │ UNPOSTED    │   └─────────────┘
   └─────────────┘
          │
          ▼  cancel_income_expense_flex_v1 / reject_invalid_income_expense_v2
   ┌─────────────┐
   │ Đã từ chối  │
   │ CANCELLED   │
   └─────────────┘
```

**Điểm dễ hiểu sai:** phiếu ở `CHANGES_REQUESTED` **vẫn duyệt được**. Writer duyệt chấp nhận
`review_state IN ('PENDING','CHANGES_REQUESTED')`
(`supabase/migrations/20260723050000_finance_v2_writers.sql:842` và `:1131`).
Nên nút "Cần bổ sung" là **gắn cờ nhắc sửa**, không phải khoá phiếu. `[KD-05]`

**Điểm dễ hiểu sai thứ hai:** `request_income_expense_changes_v2` chỉ nhận
`review_state IN ('PENDING','DISPUTED')` — **không** nhận `CHANGES_REQUESTED`
(cùng file, `:1229`). Tức **không bấm "Cần bổ sung" hai lần liên tiếp được**; phải qua
`resubmit` trước. UI phải tắt nút trong trường hợp này thay vì để người dùng ăn lỗi 55000. `[KD-06]`

### 3.2. "Cần rà soát" gồm hai thứ khác hẳn nhau

| | Nguồn | Có đổi DB không |
|---|---|---|
| **(a) Máy tự soi** | thiếu STK · lệch số tiền · tồn kỳ cũ | **Không.** Chỉ là nhãn/chip ở client |
| **(b) Người duyệt bấm "Cần bổ sung"** | `request_income_expense_changes_v2` | **Có.** `review_state → CHANGES_REQUESTED` + lý do |

Trộn hai thứ này vào một khái niệm là lỗi thiết kế dễ mắc nhất ở màn này.

---

## 4. Các RPC sẽ dùng — chữ ký và hàng rào

Toàn bộ đã xác nhận tồn tại trên production bằng `pg_proc`, và
`has_function_privilege('authenticated', oid, 'EXECUTE') = true`. `[KD-07]`

### 4.1. `request_income_expense_changes_v2` — nút "Cần bổ sung"

```sql
request_income_expense_changes_v2(
  p_voucher uuid, p_expected_review_version bigint, p_reason text,
  p_field_mask jsonb, p_idempotency_key text) RETURNS jsonb
```

Hàng rào, theo thứ tự trong thân hàm:

| # | Điều kiện | Lỗi khi trượt |
|---|---|---|
| 1 | `p_reason` không rỗng | `22023` |
| 2 | `p_idempotency_key` không rỗng | `22023` |
| 3 | Phiếu tồn tại, chưa xoá mềm | `P0002` |
| 4 | `assert_income_expense_flow_owner_v2(phiếu,'CANONICAL_INCOME_EXPENSE')` | `42501` |
| 5 | `authorize_tenant_action_v3(uid, org, 'income_expenses.approve', building)` | `42501` |
| 6 | `approval_status='UNAPPROVED'` **và** `review_state IN ('PENDING','DISPUTED')` | `55000` |
| 7 | `review_version` khớp `p_expected_review_version` | `55000` |

Điều kiện 4 qua được vì §2.4 đo 0/96 phiếu có dòng sở hữu (hàm trả `RETURN` sớm khi không có dòng).

Trả về `{voucherId, approvalStatus, reviewState, reviewVersion}`. Đóng luôn
`approval_requests` đang `PENDING_APPROVAL` thành `CHANGES_REQUESTED`.

### 4.2. `ie_compat_update_pending_v2` — bổ sung tên / STK / ngân hàng

```sql
ie_compat_update_pending_v2(p_id uuid, p_patch jsonb, p_items jsonb DEFAULT NULL) 
```

Ba khoá ta cần — `payer_name`, `receive_bank_name`, `receive_bank_account` — nằm trong
**nhóm "trục tiền"** (`v_money_keys`), không phải nhóm metadata. Nhóm metadata chỉ có
`name`, `notes`, `attachments`.

Nhánh trục tiền đòi đủ bốn thứ:

| # | Điều kiện | Với 96 phiếu của ta |
|---|---|---|
| 1 | `approval_status='UNAPPROVED'` và chưa `POSTED` | ✅ qua hết |
| 2 | `NOT app_private.ie_flow_system_owned_v2(p_id)` | ✅ qua hết — §2.4 |
| 3 | `income_expenses.edit` trên **cả toà cũ lẫn toà mới** | Tuỳ người dùng |
| 4 | Đổi `account_id` ⇒ `assert_cashbook_access_v2(..., 'CUSTODIAN', ...)` **hai đầu** | ⚠ xem dưới |

`ie_flow_system_owned_v2(id)` = *tồn tại dòng sở hữu có `flow_kind <> 'CANONICAL_INCOME_EXPENSE'`*
(`supabase/migrations/20260723160000_finance_v2_compat_guard_fix.sql:15`).

**Kết luận: CÓ, bổ sung tên/STK/ngân hàng cho phiếu đang Chờ duyệt là hợp lệ**, và
**không cần là người tạo phiếu** — chỉ cần quyền `income_expenses.edit` trên toà. `[KD-08]`

**Nhưng đổi sổ quỹ thì khác hẳn:** đòi `CUSTODIAN` ở cả sổ đi lẫn sổ đến. Người rà soát
thường không giữ sổ ⇒ 42501. Đây chính là lý do chủ chốt "không gán sổ ở màn này". `[KD-09]`

**Cách gọi bắt buộc:** gọi thẳng RPC với **đúng ba khoá cần sửa** và **bỏ trống `p_items`**.
Tuyệt đối **không** đi qua hook `useUpdateIncomeExpense` hiện có — hook đó dựng `p_patch` đầy đủ
(type, name, building_id, repeat_*, voucher_date…) và `p_items` từ form, nghĩa là nó sẽ **ghi đè**
mọi trường bằng giá trị trong form. Dùng nó cho một ô STK là đường ngắn nhất tới mất dữ liệu. `[KD-10]`

### 4.3. Duyệt và Chi

| Nút | RPC | Hook sẵn có |
|---|---|---|
| Duyệt | `approve_income_expense_v2` | `useApproveIncomeExpenseV2` |
| Duyệt & Chi | `approve_and_post_income_expense_v2(input jsonb)` | `useApproveAndPostIncomeExpenseV2` |
| Chi (phiếu đã duyệt) | `post_approved_income_expense_v2(input jsonb)` | `usePostApprovedIncomeExpenseV2` |

`input` là `PostFinanceExecutionInput` (`src/lib/incomeExpensePostingValidation.ts`): bắt buộc
`cashbookId` (chỉ sổ actor đang giữ), `postedOn`, và `evidenceIds` ≥ 1 với phiếu Thu/Chi thủ công.

Hộp thoại `IncomeExpensePostingDialog` đã lo toàn bộ: chọn sổ từ `useCustodianCashbooksV2`
(chỉ liệt kê sổ mình giữ ⇒ không ai bị 403), dán/tải ảnh chứng từ, validate. **Dùng lại nguyên
hộp thoại này**, đúng như `ApprovalsPage.tsx:340-367` đang làm.

### 4.4. Từ chối

`useCancelIncomeExpense({id, reason})` — đi `cancel_income_expense_flex_v1` khi lý do ≥8 ký tự,
tự rơi xuống thang cũ khi server báo `[STRICT_MODE]` / `[NOT_MANUAL]`.

### 4.5. Lập phiếu lần đầu ("Chuyển Chờ Duyệt")

Với dòng **chưa có phiếu**, mở lại đúng hộp thoại cũ, không viết đường tạo mới:

| Loại | Hộp thoại | Chuỗi RPC bên dưới |
|---|---|---|
| Hoàn thanh lý | `TerminationRefundDialog` | `preview_termination_refund_v1` → `record_termination_refund_obligation_v1` → `create_termination_refund_voucher_v1` |
| Hoa hồng | `PeriodCommissionModal` | `create_commission_voucher` |
| Thưởng sale | `CommissionVoucherModal` / `create_sale_bonus_from_deposit_v1` | như cũ |

Lý do giữ nguyên: mỗi đường có hàng rào riêng đã kiểm (nghĩa vụ bất biến + `force` chỉ chủ tổ chức
kèm lý do ≥8 ký tự cho hoàn; unique index `uq_ie_commission_per_contract` chặn chi hai lần cho
hoa hồng). Chép lại logic đó vào modal mới là nhân đôi hàng rào — và hàng rào nhân đôi thì sớm muộn
lệch nhau.

---

## 5. Thiết kế mã

### 5.1. Registry

`src/lib/feeCategories.ts`:

- Xoá 3 entry `hoa_hong`, `chi_thanh_ly`, `thuong_sale`.
- Thêm 1 entry:

```ts
{
  key: 'hop_dong', label: 'Hợp đồng & quyết toán', group: 'Hợp đồng & quyết toán',
  sub: 'hoa hồng môi giới · thanh lý hoàn khách · thưởng sale',
  family: 'CONTRACT_SETTLEMENT', icon: 'fileSignature', accent: '#1f7a52',
  multiPeriod: false, providerConfig: false, restricted: false, elevatorGated: false,
  serverKey: 'hop_dong', canonicalTypeName: '—', canonicalCategory: '—',
}
```

- `FeeFamily` thêm `'CONTRACT_SETTLEMENT'`, bỏ `'COMMISSION' | 'TERMINATION_REFUND' | 'SALE_BONUS'`.
- `FeeGroup`: `'Hoa hồng'` và `'Thanh lý & Cọc'` → gộp thành `'Hợp đồng & quyết toán'` và `'Cọc'`.
- `LEDGER_FAMILIES` — xem [§5.5](#55-bảng-tổng-quan-kỳ).

### 5.2. Tầng logic thuần — `src/lib/contractSettlement.ts` (mới)

Tách riêng vì đây là chỗ dễ sai nhất và phải kiểm được không cần dựng UI.

```ts
export type SettlementKind = 'refund' | 'commission' | 'bonus';
export type SettlementStatus = 'nodraft' | 'pending' | 'approved' | 'paid' | 'cancelled';
// Cố ý KHÔNG có 'MISSING_CASHBOOK': sổ quỹ chọn lúc bấm Chi, xem §2.3.
export type SettlementIssue =
  | 'MISSING_BANK' | 'AMOUNT_MISMATCH' | 'OLD_PERIOD' | 'CHANGES_REQUESTED';

export interface SettlementRow {
  key: string;                    // ổn định qua refetch: `${kind}:${voucherId ?? sourceId}`
  kind: SettlementKind;
  voucherId: string | null;       // null = chưa lập phiếu
  voucherCode: string | null;
  contractId: string | null;
  contractNumber: string | null;
  terminationId: string | null;   // chỉ refund
  buildingName: string;
  roomName: string | null;
  customerName: string;
  recipientName: string | null;
  amount: number;                 // số trên phiếu; chưa có phiếu thì là số dự kiến
  basisAmount: number | null;     // số theo căn cứ (bậc HH × giá phòng, hoặc số quyết toán hồ sơ)
  status: SettlementStatus;
  eventDate: string | null;
  issues: SettlementIssue[];
  // Khoá phiên bản — BẮT BUỘC cho mọi writer V2
  reviewState: string | null;
  reviewVersion: number;
  approvalVersion: number;
  postingVersion: number;
  bankAccount: string | null;
}

export function detectIssues(row: Omit<SettlementRow,'issues'>, period: string): SettlementIssue[];
export function sumVisible(rows: SettlementRow[]): number;
```

Test đi kèm (`contractSettlement.test.ts`), bất biến phải giữ:

- `AMOUNT_MISMATCH` chỉ xuất hiện khi `basisAmount != null && basisAmount !== amount`.
  `basisAmount === null` (không có căn cứ) **không** phải lệch.
- Dòng `status='paid'` không bao giờ mang `MISSING_BANK` hay `OLD_PERIOD` — đã chi xong thì
  không còn gì để nhắc.
- Không bao giờ sinh vướng mắc về sổ quỹ, kể cả khi `account_id` rỗng (§2.3).
- `detectIssues` thuần: cùng đầu vào ra cùng đầu ra, không đọc `Date.now()`.
- `sumVisible` cộng đúng số trên phiếu, không cộng `basisAmount`.

### 5.3. Tầng đọc — `src/hooks/useContractSettlement.ts` (mới)

Gộp **ba hook đọc đã có**, không viết reader mới:

| Loại | Hook | Cho ta |
|---|---|---|
| Hoa hồng | `usePeriodCommissions` (RPC `get_period_commissions`) | `expectedAmount` **và** `voucherAmount` ⇒ phát hiện lệch |
| Hoàn thanh lý | `useTerminationRefundQueue` | `refundAmount` hồ sơ **và** `refundVoucherAmount` |
| Thưởng sale | `useSaleBonusVouchers` | phiếu `commission_kind='sale'` |

Ba hook trên **không** trả `receive_bank_account`, `account_id`, `review_state`, `review_version`,
`approval_version`, `posting_version`. Thêm **một** truy vấn bù:

```ts
// useSettlementVoucherMeta(voucherIds: string[])
supabase.from('income_expenses')
  .select('id, receive_bank_account, receive_bank_name, payer_name, review_state, review_version, approval_version, posting_version')
  // Cố ý KHÔNG lấy account_id: màn này không hiện, không lọc, không sửa sổ quỹ.
  .in('id', chunk)          // chia lô ≤500
```

**Bắt buộc dùng `fetchAllRows`** như hai hook kia đã làm (vá F8 27/08): không phân trang là dính
cap-1000 của PostgREST, và kỳ nhiều phiếu thì danh sách **im lặng thiếu dòng**. Một lô lỗi = fail
cả query, không được nuốt. `[KD-11]`

### 5.4. Tầng giao diện — `src/components/thu-tien/contract-settlement/` (mới)

| File | Việc |
|---|---|
| `ContractSettlementSection.tsx` | Thống kê + bộ lọc + chip + bảng. Điểm vào duy nhất |
| `SettlementTable.tsx` | Bảng dòng |
| `SettlementLifecycleModal.tsx` | Vòng đời hợp đồng + bảng căn cứ + khối hành động |
| `useSettlementActions.ts` | Bọc các RPC ở §4, quản lý khoá phiên bản |

Bộ lọc vướng mắc = **bốn chip độc lập, không chip nào bật sẵn**:

`Thiếu STK` · `Lệch số tiền` · `Tồn kỳ cũ` · `Đã y/c bổ sung`

Không có chip "Thiếu sổ quỹ" — xem §2.3.

Mỗi dòng vẫn hiện nhãn đỏ tại chỗ **dù chip có bật hay không** — chip chỉ lọc, không phải là
cách duy nhất thấy vấn đề.

### 5.5. Bảng Tổng quan kỳ

Bảng này có một lời hứa: **mọi con số khớp cột "Khoản chi (chưa có phiếu)" của Báo cáo Lợi Nhuận.**
Vì thế mã hiện tại cố ý loại `TERMINATION_REFUND` / `SALE_BONUS` / `DEPOSIT_LEDGER` ra
(`LEDGER_FAMILIES`) — hoàn cọc là trả lại tiền vốn của khách, không phải chi phí; cộng vào là
báo lỗ giả.

**Quyết định:** dòng "Hợp đồng & quyết toán" trong Tổng quan:

- **Số tiền** chỉ tính **hoa hồng** (giữ nguyên parity Lợi Nhuận đang có).
- **Badge** đếm **cả ba loại** đang chờ xử lý (đây là chỉ báo việc, không phải số tiền kế toán).

Cài đặt: `CONTRACT_SETTLEMENT` **không** nằm trong `LEDGER_FAMILIES` (vì có phần tính tiền),
nhưng hàm tính tiền của dòng này phải lọc `kind === 'commission'`. Ghi chú rõ ngay tại chỗ tính,
kèm lý do — nếu không, người sau sẽ "sửa" nó thành cộng cả ba. `[KD-12]`

### 5.6. Các file phải sửa theo

| File | Dòng tham chiếu | Việc |
|---|---|---|
| `PeriodFeePanel.tsx` | `:96` `isComm`, `:142`, `:176`, `:466`, `:656-658`, `:661` | 3 nhánh → 1 nhánh |
| `PeriodFeeSheet.tsx` | `:124`, `:130`, `:134`, `:495-496`, `:524-526`, `:606` | Bỏ 3 nhánh |
| `SettlementPanels.tsx` | — | Bỏ `TerminationRefundQueueSection`, `SaleBonusSection`; **giữ** `DepositLedgerSection` |
| `feeCategories.test.ts` | `:27` | Đang ghim `hoa_hong → COMMISSION`, phải sửa |

⚠ Việc đếm "còn thiếu" của Tổng quan nằm ở **cả hai** `PeriodFeePanel` và `PeriodFeeSheet`,
cùng biểu thức `c.family === 'COMMISSION'`. Sửa sót một chỗ ⇒ hai bề mặt ra hai con số. `[KD-13]`

---

## 6. Ánh xạ thiết kế → hiện thực

Bản `.dc.html` là bản vẽ có dữ liệu mẫu. Những chỗ **cố ý làm khác**:

| Trong bản vẽ | Hiện thực | Lý do |
|---|---|---|
| Nút "Lập phiếu · chuyển chờ duyệt" | **"Chuyển Chờ Duyệt"** | Chủ yêu cầu, rõ nghĩa hơn |
| Ô nhập STK ngay trong modal, tự sửa số về căn cứ | Ô nhập STK **có**; sửa số tiền **không** | Sửa số tiền hoa hồng phải đi lại writer có unique index; nhập tay ở đây là đường ghi thứ hai |
| Nút "Cần bổ sung" (bản vẽ chỉ đổi state cục bộ) | `request_income_expense_changes_v2` thật | Writer có sẵn trên prod |
| Chọn "Sổ chi" trong modal | Bỏ; sổ chọn trong `IncomeExpensePostingDialog` | Đổi sổ đòi CUSTODIAN hai đầu ⇒ 403 với đa số người dùng |
| Tab "Biến động" | Đợt sau | Chủ quyết |
| QR chuyển khoản mô phỏng | Bỏ | Dữ liệu mẫu, chưa có nguồn thật |
| Ba nút Duyệt / Duyệt&Chi / Cần bổ sung luôn hiện | Hiện theo quyền + theo trạng thái | Xem §4 |

---

## 7. Sổ xung đột

| # | Xung đột | Đã kiểm | Cách tránh |
|---|---|---|---|
| X1 | **Cặp bút toán bỏ cọc** — lệch một chân là cặp kẹt vĩnh viễn *và* migration kế tiếp abort | 36 hồ sơ `FORFEIT`. Phiếu của chúng mang `termination.forfeit_revenue` / `_offset`, **không** lọt bộ lọc `termination.refund%` | Giữ nguyên bộ lọc. Org CANONICAL đi `approve_income_expense_v2`, writer này từ migration `20260902092845` đã tự rẽ sang handler cặp ở DB |
| X2 | Phiếu do writer hệ thống sở hữu ⇒ sửa STK trả 42501 | 0/96 phiếu có dòng sở hữu | Vẫn phải bắt 42501 và hiện đúng câu — phiếu sinh sau này có thể khác |
| X3 | Sai khoá phiên bản ⇒ 55000 | `request_changes` và `approve` V2 đều đòi đúng `review_version` / `approval_version` | Lấy từ truy vấn bù §5.3, **không đoán**. Sau mỗi ghi phải refetch trước khi ghi tiếp |
| X4 | Bấm "Cần bổ sung" hai lần | Writer chỉ nhận `PENDING`/`DISPUTED` | Tắt nút khi `review_state='CHANGES_REQUESTED'` |
| X5 | Dùng `useUpdateIncomeExpense` để sửa mỗi ô STK | Hook dựng `p_patch` đầy đủ + `p_items` từ form | Gọi thẳng RPC với 3 khoá, bỏ trống `p_items`. Xem `[KD-10]` |
| X6 | Tổng quan lệch Báo cáo Lợi Nhuận | `LEDGER_FAMILIES` đang loại 3 family | §5.5 — tiền chỉ tính hoa hồng |
| X7 | Hai bề mặt ra hai số | Đếm nằm ở cả Panel lẫn Sheet | `[KD-13]` |
| X8 | E2E gãy | `termination-refund*.spec.ts` chạy ở `/reports/real-estate/terminations` (không đụng). `thanh-toan-page.spec.ts` chỉ assert `.ptt-panel` + "Tổng quan kỳ" + hai bề mặt cùng mount | Giữ `.ptt-panel`, giữ dòng "Tổng quan kỳ", **không** unmount theo breakpoint |
| X9 | `business-performance.spec.ts:2348` đếm chữ "Hoa hồng môi giới" | Chưa xác định đó là tên loại thu chi hay nhãn menu | **Phải kiểm trước khi xoá nhãn** |
| X10 | `refetch` thành công không đổi identity ⇒ effect không chạy lại | `structuralSharing` giữ nguyên object | Đừng dựa vào identity để phát hiện dữ liệu mới; E2E phải đếm số lần gọi |
| X11 | Mobile mất 3 sổ | Chủ đã đồng ý | Ghi vào `docs/he-thong` để người dùng không tưởng là lỗi |
| X12 | `supabase.rpc` **không bao giờ ném** | Lỗi về dưới dạng `{error}` đã fulfil | Mọi chỗ gọi phải kiểm `error`, không bọc `try/catch` rồi tưởng đã xử lý |

### 7.1. Audit độc lập ngày 20/09/2026 — chỉ đọc production

**Phạm vi:** SQL chạy qua session pooler, mỗi phiên bọc `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` và `ROLLBACK`; xác nhận `transaction_read_only=on`. Không gọi writer để thử, không thay đổi production hoặc mã nguồn. Theo xác nhận của chủ, chỉ bổ sung mục §7 này. Source frontend được kiểm tại checkout hiện có; chưa đối chiếu SHA deployment hoặc chạy E2E trên app production.

**Chủ làm rõ trong lần audit:** bỏ hoàn toàn ba mục cũ Hoa hồng môi giới / Hoàn cọc / Thưởng sale trên trang Thanh toán; khu mới phải dùng cùng luồng RPC, quyền và hành vi xử lý phiếu của trang **Thu chi**. Vì vậy “dùng lại nguyên modal tạo phiếu cũ” ở §4.5 không được coi là quyết định đã chốt nếu nó kéo theo luồng tự duyệt/chi khác ý định này. Bỏ các mục giao diện không đồng nghĩa xóa RPC đang được bề mặt khác sử dụng.

**Số đo kiểm lại:** 15:09:58–15:13:16 UTC, tức 22:09:58–22:13:16 UTC+7 ngày 20/09/2026.

| Phép đo | Kết quả lần audit |
|---|---|
| KD-01: route | 12/12 tổ hợp org/cờ đều CANONICAL |
| Hoa hồng chưa xong | 43 phiếu, 100.650.000 đ |
| Hoàn thanh lý chưa xong | 41 phiếu, 154.078.834 đ |
| Thưởng sale chưa xong | 8 phiếu, 1.100.000 đ |
| Tổng KD-02 | **92 phiếu, 255.828.834 đ**; đều UNAPPROVED + UNPOSTED, không có APPROVED + UNPOSTED trong tập đã lọc |
| KD-03 | Thiếu STK **86/92**; thiếu sổ **27/92**. Trim khoảng trắng không làm đổi số thiếu STK |
| KD-04 | **0/92** có flow ownership; 91 phiếu review_version=1, một phiếu=2; tất cả PENDING |
| Khả năng resubmit | **90/92** có maker_user_id NULL; không restricted; không system-owned |
| Ba hoàn NOT_APPLICABLE | PC2606005 = 2.057.834 đ; PC2606011 = 3.300.000 đ; PC2607070 = 4.157.800 đ. Tổng **9.515.634 đ** |
| Bản chất ba phiếu trên | APPROVED + NON_CASH + NOT_APPLICABLE; cùng sổ ảo “CỌC (giữ hộ khách)”; active_posting_id_v2/posting_id NULL; không có income_expense_postings gắn voucher_id. Không thấy phiếu hoàn POSTED khác cùng contract trong tập termination.refund% còn sống |
| Thưởng sale và PNL | 15 phiếu APPROVED + POSTED, tổng item 8.000.000 đ; 8 phiếu UNAPPROVED + UNPOSTED, tổng item 1.100.000 đ; đều accounting_class=PNL |

Các số 96/90/31 trong §2 và §8 không còn khớp snapshot hiện tại. Điều này **không chứng minh số đo trước đó sai tại lúc đo**; không được ghi “production cố định có 96 phiếu”.

### 7.2. Xung đột mới và đính chính sau audit

| # | Xung đột / phản chứng | Bằng chứng đã kiểm | Việc phải làm rõ trước khi thi hành |
|---|---|---|---|
| X13 | **“Chuyển Chờ Duyệt” có thể tự duyệt và ghi chi nếu gọi lại nguyên modal hoa hồng** | `src/components/thu-tien/PeriodCommissionModal.tsx:60` lấy cả defaultBookId, `:77` truyền account_id. Thân `create_commission_voucher` trên production gọi `commission_autopay_check_v1` rồi `special_fee_approve_and_post_v1` khi broker VALID và có sổ thật; adapter đặt APPROVED và POSTED. Source tương ứng: `supabase/migrations/20260902100049_ten_phieu_hoa_hong_theo_phong_va_ghi_chu_luc_xem.sql:542`. Không gọi writer trong audit | Thay chỉ dẫn “dùng nguyên modal cũ” bằng luồng được xác định từ Thu chi. Phân biệt tạo nghĩa vụ/phiếu với duyệt và ghi chi. Nếu còn dùng writer tạo chuyên biệt, phải chứng minh đầu vào không kích hoạt tự chi, kể cả default sổ ngầm; không chỉ đổi nhãn nút |
| X14 | **Ba reader hiện tại không đủ khóa và trạng thái để gộp như §5.3** | `src/hooks/useThanhToanLedgers.ts:81` không lấy voucher id cho hoàn; `:113` gộp mọi non-POSTED thành PENDING. Sale map `:177` không giữ contract_id dù query có. Production `get_period_commissions` gán status=paid chỉ dựa APPROVED, không xét posting_status. Query bù trong §5.3 thiếu approval_status, posting_status, posting_mode và review_reason | Mở rộng read model có voucherId/khóa quan hệ + trạng thái thực trước khi dùng V2 hoặc dựng timeline. Không dùng nhãn paid/draft cũ làm trạng thái thanh toán thật; không hứa chỉ gộp nguyên ba hook |
| X15 | **Reader theo tháng không thể tự hiện tồn đọng xuyên kỳ** | Hoàn lọc termination_date trong tháng tại `useThanhToanLedgers.ts:64`; sale lọc voucher_date tại `:169`; commission nhận một period tại `src/hooks/usePeriodFees.ts:488` | Quy định rõ danh sách mặc định một kỳ hay mọi tồn đọng. Nếu vẫn có tồn cũ xuyên kỳ như UX, phải có chiến lược đọc tương ứng; chip OLD_PERIOD không kéo dòng ngoài query vào |
| X16 | **NOT_APPLICABLE không phải bằng chứng đã trả tiền khách** | Ba phiếu ở §7.1 đều NON_CASH trên sổ ảo, không có posting. Reader hoàn hiện nén thành PENDING rồi `SettlementPanels.tsx:75` hiện CHỜ DUYỆT nếu chúng được đưa vào danh sách | Cần nhãn riêng “Đã duyệt · không ghi quỹ (sổ ảo)”. Không cộng vào đã chi thực tế, không tự sinh chi mới và cũng không suy ra khách chắc chắn chưa được trả ngoài hệ thống. Việc nghĩa vụ hoàn đã tất toán thật chưa cần đối chiếu chứng từ riêng |
| X17 | **Sửa STK không gửi duyệt lại; 90 phiếu hiện không đi được resubmit** | Production `ie_compat_update_pending_v2` không đổi review_state/review_version khi sửa STK. `resubmit_income_expense_v2` chỉ cho original maker_user_id, reject maker NULL; p_patch chỉ tham gia idempotency hash, không áp dụng field. Source: `20260723050000_finance_v2_writers.sql:1545`, `:1565` | Chốt luồng ai sửa, ai gửi lại, và trường hợp maker NULL/không còn hoạt động. Duyệt thẳng CHANGES_REQUESTED vẫn được DB cho phép nhưng phải mô tả rõ là người duyệt chấp nhận sau yêu cầu bổ sung, không giả vờ đã resubmit |
| X18 | **“Chỉ cần edit” và “đổi account luôn cần hai đầu” đều quá rộng** | Production compat còn kiểm membership active, restricted item, quan hệ cuối cùng cùng org, UNAPPROVED/chưa POSTED, system ownership. Khi đổi account: chỉ kiểm từng đầu non-null và chỉ khi giá trị thay đổi. Source: `20260902082004_ie_compat_update_pending_kiem_scope_moi.sql:66`, `:76`, `:103`, `:145` | Giữ edit là quyền cần cho actor thường nhưng không coi là điều kiện đủ. NULL→B chỉ kiểm B; A→NULL chỉ kiểm A; A→B mới kiểm hai đầu. Với cohort hiện tại, 0 restricted/system-owned không bảo đảm mọi actor đều qua guard |
| X19 | **“Sổ mình giữ ⇒ không ai bị 403” không đúng tuyệt đối** | Production `list_cashbooks_for_expense_v2()` lấy mọi ACTIVE membership của auth.uid(), không nhận/lọc org mục tiêu; chỉ trả id/name. Writer post/approve-and-post lại yêu cầu account thuộc org phiếu và giữ quyền CUSTODIAN hiện tại. Source selector: `20260723110000_finance_v2_rls_canary.sql:216` | Scope danh sách theo tổ chức phiếu và xử lý quyền bị thu hồi sau khi mở. Tái sử dụng dialog cần caller cấp cashbookOptions, version, callbacks upload/adopt chứng từ và refetch; dialog không tự làm toàn bộ |
| X20 | **“Chỉ cộng commission bảo đảm parity Lợi Nhuận” không được chứng minh và lý giải về sale là sai** | Giữ commission bảo toàn phép tính Tổng quan cũ tại `PeriodFeePanel.tsx:176`, không chứng minh khớp báo cáo. `ProfitDistributionReport.tsx:600` sinh note phí cố định amount=0, `:631` bỏ note khỏi tổng. `fixedExpenseCategories.ts:63` là luật xếp nhóm; không phải phép tính tiền. Thưởng sale production có accounting_class=PNL như §7.1 | Định nghĩa chính xác cột báo cáo, kỳ, trạng thái, tiền dự kiến/trên phiếu/thực chi cần đối chiếu. Không dùng câu “thưởng sale không thuộc lãi lỗ” làm căn cứ loại tiền |
| X21 | **Cap-1000 không chứng minh query bù bắt buộc fetchAllRows** | Query bù theo primary key id, lô tối đa500, không join ⇒ tối đa500 dòng. Chính query phụ tại `useThanhToanLedgers.ts:77` chỉ chunk, không fetchAllRows. Query tập hợp không giới hạn thì cần phân trang | Chunk/fail-closed là hợp lý. fetchAllRows có thể giữ để phòng cấu hình server nhỏ hơn500 nhưng không viện dẫn cap1000 như phản chứng của query này; nếu dùng helper phải có order ổn định và range |
| X22 | **Chỉ tồn tại RPC không chứng minh không cần migration** | 11 RPC public gọi đích danh trong §4 đều tồn tại và authenticated có EXECUTE; resubmit cũng tồn tại. Nhưng X13–X19 cho thấy chưa mô tả đủ read model, chuyển trạng thái và điều kiện ghi | KD-14 vẫn chưa kiểm được ở mức toàn thiết kế. Chưa có bằng chứng bắt buộc thêm migration; cũng chưa đủ bằng chứng khẳng định không cần. Xác định đường đi thật theo Thu chi và kiểm trên DEMO trong đợt thi hành sau |

**Đính chính các xung đột đã ghi trước:**

- **X9 đã giải đáp:** `.e2e-fleet/specs/business-performance.spec.ts:2348` đếm nhãn trong route `/reports/finance/business-performance`, góc nhìn revenue-cost-structure / tab Chi, để bắt nhãn trùng (`count <= 1`). Không kiểm menu `/thanh-toan`; bỏ key menu không làm assertion này đỏ chỉ vì mất nhãn.
- **Câu hỏi key cũ:** `src/hooks/usePersistedState.ts:18`, `:29` dùng **sessionStorage**, không phải localStorage. Panel `:91–93` và Sheet `:92–94` fallback Tổng quan khi category không còn. Không tìm thấy consumer chọn ba key cũ trong Copilot/report/deep-link khi rà `src`, `supabase/functions` và E2E. Chuyển key cũ→hop_dong giúp giữ ngữ cảnh, không phải cách sửa một lỗi trắng trang đã chứng minh.
- **X8 chưa đủ:** `thanh-toan-page.spec.ts` còn kiểm geometry, back routing, không có scrim, đồng bộ tháng, launcher và console; giữ hai selector không đủ đảm bảo suite xanh. `feeCategories.test.ts:6` còn ghim số category/group, không chỉ mapping dòng 27.
- **X12 cần bỏ chữ “không bao giờ”:** mặc định PostgREST trả lỗi trong `{error}`, nhưng `.throwOnError()` chuyển sang reject (SDK `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:148`). Kiểm `error` và không bỏ xử lý exception ở ranh giới hành động.
- **KD-06 có ngoại lệ retry:** request_changes mới không nhận CHANGES_REQUESTED; retry cùng idempotency key đã hoàn tất trả response cũ trước bước kiểm trạng thái. Không được mô tả mọi lời gọi lần hai đều lỗi.

### 7.3. Cách đo lại các phản chứng mới

Ngoài SQL §2.1–§2.4, dùng các SELECT sau trong transaction READ ONLY, cuối cùng ROLLBACK. Không gọi RPC writer để “thử lỗi” trên production.

```sql
-- Tồn tại/quyền, chữ ký thực và thân hàm hiện chạy.
SELECT n.nspname, p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute,
       md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname = ANY(ARRAY[
  'request_income_expense_changes_v2','ie_compat_update_pending_v2',
  'approve_income_expense_v2','approve_and_post_income_expense_v2',
  'post_approved_income_expense_v2','cancel_income_expense_flex_v1',
  'preview_termination_refund_v1','record_termination_refund_obligation_v1',
  'create_termination_refund_voucher_v1','create_commission_voucher',
  'create_sale_bonus_from_deposit_v1','resubmit_income_expense_v2'
])
ORDER BY p.proname;

SELECT n.nspname, p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','app_private') AND p.proname = ANY(ARRAY[
  'get_period_commissions','create_commission_voucher',
  'commission_autopay_check_v1','special_fee_approve_and_post_v1',
  'request_income_expense_changes_v2','resubmit_income_expense_v2',
  'approve_income_expense_v2','approve_and_post_income_expense_v2',
  'post_approved_income_expense_v2','ie_compat_update_pending_v2',
  'list_cashbooks_for_expense_v2'
]);

-- Phiếu không có maker sẽ không qua guard resubmit hiện tại.
SELECT count(*) AS pending,
       count(*) FILTER (WHERE maker_user_id IS NULL) AS no_maker
FROM public.income_expenses
WHERE deleted_at IS NULL
  AND organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND approval_status='UNAPPROVED'
  AND (system_source LIKE 'termination.refund%' OR commission_kind IN ('broker','sale'));

-- Sổ ảo và bằng chứng posting của ba phiếu NOT_APPLICABLE.
SELECT ie.code, ie.total_amount, ie.approval_status, ie.posting_status,
       ie.posting_mode, a.is_virtual, ie.active_posting_id_v2, ie.posting_id,
       (SELECT count(*) FROM public.income_expense_postings p
        WHERE p.voucher_id=ie.id) AS posting_rows
FROM public.income_expenses ie
LEFT JOIN public.accounts a ON a.id=ie.account_id
WHERE ie.deleted_at IS NULL
  AND ie.organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND ie.system_source LIKE 'termination.refund%'
  AND ie.posting_status='NOT_APPLICABLE';

-- Sale thực tế thuộc lớp kế toán nào.
SELECT ie.approval_status, ie.posting_status, it.accounting_class,
       count(DISTINCT ie.id) AS vouchers, sum(it.amount) AS item_amount
FROM public.income_expenses ie
JOIN public.income_expense_items it ON it.income_expense_id=ie.id
WHERE ie.deleted_at IS NULL
  AND ie.organization_id='aaaa0000-0000-4000-8000-000000000001'
  AND ie.commission_kind='sale'
GROUP BY 1,2,3;
```

Dấu vân tay thân hàm trong lần audit: `create_commission_voucher=c134aa5857144c2b8f66145f0e9feab5`; `ie_compat_update_pending_v2=c6ed1d47823837349c92e8769932053a`; `get_period_commissions=fca572d520ba47377f9d4997f764b406`; `resubmit_income_expense_v2=722dcc99bec52a059f7c45c08d085f80`. Đo lại nếu definition thay đổi; không xem dòng migration cũ là bằng chứng production mãi mãi.


---


### 7.4. Hướng xử lý chi tiết theo yêu cầu chủ — thay luồng cũ bằng máy vận hành Thu chi

**Yêu cầu bổ sung đã xác nhận trong lần audit:** “loại bỏ các flow logic RPC ở bên Thanh toán liên quan đến hoa hồng, hoàn cọc và thưởng sale; tạo khu Hợp đồng & quyết toán mới dùng lại chính machine vận hành ở Thu chi”.

Đây là hướng thi hành ưu tiên hơn chỉ dẫn “giữ nguyên hộp thoại cũ” trong §4.5 và cách tổ chức action riêng ở §5.4 nếu hai phần đó mâu thuẫn. Lần audit này **chỉ ghi phương án**, chưa thực hiện các bước dưới đây.

#### A. Phạm vi loại bỏ

1. Gỡ ba điểm vào `hoa_hong`, `chi_thanh_ly`, `thuong_sale` và các nhánh render/action riêng của chúng trong Panel/Sheet; thay bằng một khu `Hợp đồng & quyết toán`.
2. Gỡ đường gọi từ Thanh toán vào `PeriodCommissionModal`, `TerminationRefundQueueSection`, `SaleBonusSection` và các handler cũ dùng chúng. Rà cả `PeriodFeeSharedModals.tsx`; không chỉ xóa mục registry rồi để effect/modal/handler ẩn vẫn chạy.
3. Khu mới không có một bộ quy tắc duyệt/chi/quyền/RPC độc lập cho ba loại khoản. Modal vòng đời là bề mặt đọc và phát lệnh đến lớp hành động dùng chung với Thu chi.
4. Giữ `coc_da_thu`/`DepositLedgerSection` theo phạm vi đã chốt. “Hoàn cọc” bị thay thế là mục chi hoàn, không phải sổ Cọc đã thu.
5. Chỉ xóa component/hook khi không còn caller. Việc xóa các đường gọi ở Thanh toán không tự cho phép DROP RPC database còn dùng ở Hợp đồng, Thanh lý hoặc giữ chỗ. Nếu muốn retire một RPC toàn hệ thống, phải có inventory callers và kế hoạch migration/review riêng; lần này không làm.

#### B. Một lớp điều phối hành động, dùng ở cả Thu chi và khu mới

Hiện cơ chế của Thu chi phân tán giữa `IncomeExpensePage.tsx`, `IncomeExpenseList.tsx` và hooks; chưa có sẵn một “machine” duy nhất chỉ cần import. Hướng đề xuất là **trích xuất logic đang chạy**, cho Thu chi tiếp tục dùng lớp đó, rồi khu mới dùng cùng lớp — không copy thành phiên bản thứ hai.

Tên gợi ý `useIncomeExpenseActionMachine`/`incomeExpenseActionPolicy` chỉ là tên thiết kế, **chưa có trong repo**. Khu mới có thể có adapter trình bày nhưng không tự rẽ sang writer khác hoặc tự suy quyền từ vai trò.

| Trách nhiệm dùng chung | Nguồn hiện hành để trích xuất/giữ hành vi | Yêu cầu khu mới |
|---|---|---|
| Route theo org, khóa ghi | `src/pages/payments/IncomeExpensePage.tsx:368` dùng useFinanceV2Routes, canWriteWorkflow, canWritePosting | Đánh giá trên org của phiếu; không hardcode CANONICAL chỉ vì snapshot hôm nay |
| Quyền và điều kiện nút | `src/components/income-expenses/IncomeExpenseList.tsx:223`, `:230`, `:416`, `:431` | Cùng capability và trạng thái với Thu chi; chờ tải quyền thì không cho ghi |
| Duyệt không chi | `IncomeExpensePage.tsx:537` → useApproveIncomeExpenseV2; `financeV2Mutations.ts:65` có dispatcher owned | Giữ đường dispatcher của hook, không gọi thẳng approve rồi bỏ mất fallback hợp lệ |
| Duyệt và Chi | `IncomeExpensePage.tsx:1159` → IncomeExpensePostingDialog → useApproveAndPostIncomeExpenseV2 | Hành động riêng, rõ sẽ ghi tiền; cùng quyền và điều kiện CASHBOOK của Thu chi, không tự chạy khi lập phiếu |
| Chi phiếu đã duyệt | `IncomeExpensePage.tsx:1259` → usePostApprovedIncomeExpenseV2 | Thủ quỹ không cần quyền duyệt để thực hiện bước chi đã được duyệt; vẫn cần quyền sổ phù hợp |
| Sổ và chứng từ | `IncomeExpensePage.tsx:363`, `:378`; upload/adopt/remove evidence của Thu chi | Chọn sổ ở bước Chi; scope đúng org, cùng kiểm ngày, chứng từ và quyền; không dựng QR giả hoặc tự coi upload thành thanh toán |
| Hủy/từ chối | `IncomeExpensePage.tsx:392`, `:610` dùng eligibility → useCancelVoucherFlex với hai version; có fallback theo policy | §4.4 chỉ nêu useCancelIncomeExpense là chưa đủ. Phải giữ full decision path, lý do, approval/posting CAS và xử lý posting đã tồn tại |
| Hoàn tác khoản đã ghi sổ | useReversePostingV2 trong `financeV2Mutations.ts:124` | Nếu hiển thị hành động này, lấy đúng policy Thu chi; không đổi cờ POSTED bằng client. Không bắt buộc mở rộng UX ngoài phạm vi đợt này |
| Sửa riêng người nhận/STK | ie_compat_update_pending_v2 với sparse patch | Đưa wrapper typed vào tầng dùng chung; chỉ gửi field đã sửa, không dùng full-form hook, không gán sổ kèm theo |
| Cần bổ sung/gửi lại | request_income_expense_changes_v2 / resubmit_income_expense_v2 | Đây là khả năng RPC có sẵn nhưng không có nghĩa Thu chi đã có UI hoàn chỉnh. Thêm vào lớp chung với policy thật; không làm máy trạng thái riêng trong khu mới |
| Refetch, lỗi và chống lặp | Các hooks hiện tại + version/identity của phiếu | Sau thành công refetch cả detail/list/tổng; stale version thì tải lại và yêu cầu xem lại, không retry thao tác tiền bằng version mới trong im lặng |

**Hợp đồng hành động cần có:** voucherId, organizationId, buildingId, approval_status, posting_status, posting_mode, review_state/reason, các version thật, ownership/ràng buộc nguồn, eligibility hủy và evidence. Không truyền một SettlementRow rút gọn đã mất trạng thái vào writer. Thiếu dữ liệu cần thiết thì khóa hành động và tải detail; không tự dùng version=1 hoặc coi null là đã sẵn sàng.

**Nguồn sự thật:** state backend và guard writer. UI phân loại “thiếu STK/lệch/tồn cũ” chỉ là lớp rà soát; không tự chuyển review_state hoặc chặn quyền trái với Thu chi. Cần bổ sung không phải khóa phê duyệt: DB vẫn cho approver duyệt CHANGES_REQUESTED, phải phản ánh rõ lý do và hành động.

#### C. Dòng chưa có phiếu: không thay mù bằng tạo phiếu thường

Thu chi hiện tạo phiếu qua `IncomeExpenseForm` → `useCreateIncomeExpense` → `create_income_expense_v1` hoặc `ie_compat_insert_v2` (`src/hooks/income-expenses/mutations.ts:58`, `:73`, `:138`). Payload hiện tại không phải hợp đồng tạo phiếu nghiệp vụ hoa hồng/hoàn/thưởng: chưa mang đủ commission_kind, nguồn nghĩa vụ hoàn hoặc claim thưởng từ cọc.

Vì vậy **không dùng tạo phiếu thường để lách bỏ** khóa một hoa hồng/hợp đồng, nghĩa vụ hoàn và chống thưởng trùng. Đồng thời **không gọi lại nguyên modal/flow cũ của Thanh toán** để giải quyết chỗ thiếu đó.

Hướng xử lý đề xuất:

1. Tách rõ `nguồn nghiệp vụ chưa có phiếu` và `voucher đã tồn tại`. Cùng hàng đợi nhưng không giả một voucherId từ contractId hay mã phiếu.
2. “Chuyển Chờ Duyệt” gửi yêu cầu qua **lớp hành động dùng chung** với sourceRef có kiểu rõ: hợp đồng hoa hồng, nghĩa vụ hoàn, nguồn cọc/thưởng. Không để SettlementLifecycleModal tự gọi RPC nghiệp vụ.
3. Rà các writer tạo nghiệp vụ hiện có xem writer nào có thể làm **create-only**, giữ đầy đủ source/claim/unique/force-reason mà không tự duyệt/ghi chi. Đây là tái sử dụng guard domain ở tầng chung, không mang lại bộ điều phối riêng của Thanh toán.
4. Riêng broker: loại bỏ picker và default account của PeriodCommissionModal khỏi đường mới. Nếu chọn sử dụng writer hiện có thông qua lớp chung, phải chứng minh account NULL được giữ tới INSERT và không có autopost ngầm. Không chỉ đổi toast thành “chờ duyệt”.
5. Sau create, refetch phiếu thật để kiểm source, người nhận, số tiền, approval/posting/review và version. Chỉ báo “Chuyển Chờ Duyệt” khi thật sự UNAPPROVED + chưa POSTED; kiểm này là xác nhận kết quả, không phải biện pháp ngăn một writer đã tự chi.
6. Với phiếu đã tồn tại, luôn đưa về máy Thu chi theo voucherId; không tạo phiếu khác để né CHANGES_REQUESTED, ownership hoặc lỗi quyền.
7. **Điểm kiểm tra trước khi triển khai:** nếu không có đường tạo sẵn nào đáp ứng create-only mà vẫn giữ guard domain, phải sửa capability tạo ở tầng dùng chung và đánh giá migration riêng. Ghi lại phạm vi cần duyệt; không giữ câu “chắc chắn không migration” để ép một đường gọi sai. Không tự bỏ chức năng dòng chưa có phiếu khỏi sản phẩm chỉ để tuyên bố hoàn thành.

Như vậy khu mới dùng một máy xử lý phiếu với Thu chi; nghiệp vụ nguồn vẫn có ràng buộc đúng của nó. Các yêu cầu này chưa chứng minh rằng mọi writer tạo hiện tại đã dùng được nguyên trạng.

#### D. Tầng đọc phải phục vụ trạng thái thật và timeline

- Truy vấn danh sách lấy đủ id và khóa nguồn; query bù lấy thêm approval_status, posting_status, posting_mode, review_reason, versions và thông tin người nhận. Dữ liệu ngữ cảnh không được suy từ code hiển thị.
- Phân biệt APPROVED+UNPOSTED (chờ chi), APPROVED+POSTED (đã chi), NON_CASH+NOT_APPLICABLE (không ghi quỹ), CANCELLED và trạng thái đảo posting theo policy Thu chi. Không map mọi APPROVED thành paid.
- Tồn kỳ cũ phải có query tương ứng mọi kỳ hoặc cơ chế phân trang phạm vi được định nghĩa rõ. Không chạy vô hạn từng tháng; không cộng tổng từ trang đầu.
- Hoàn dùng số nghĩa vụ/preview có đối chiếu cọc thực thu làm căn cứ; số generated refund_amount trên hồ sơ chỉ là dữ kiện đối chiếu, không tự dùng làm amount để chi.
- Timeline đọc theo roomId và contractId của phiếu; hợp đồng mới của phòng chỉ để tham khảo. Mọi action giữ voucherId/sourceRef ban đầu.
- Ba phiếu sổ ảo ở X16 cần nhãn riêng và kiểm chứng từ lịch sử; không tự backfill POSTED hoặc tạo phiếu hoàn mới trong việc xây màn hình.
- Tổng quan cần hai thước đo rõ: công việc chưa xử lý và tiền theo cơ sở đã chọn. Chỉ đối chiếu PNL khi cùng phạm vi và ngữ nghĩa; không trộn hoàn vốn với chi phí và không loại thưởng sale bằng giả định sai.

#### E. Các bước thi hành đề xuất

1. **Chốt lại hợp đồng hành động:** lập bảng input/quyền/state/guard/output của Thu chi và các trường hợp nguồn chưa có phiếu; giải X13, X16, X17 trước. Chưa viết UI có nút ghi khi đường đi chưa rõ.
2. **Trích xuất máy dùng chung:** chuyển orchestration/policy từ Thu chi ra lớp dùng chung, cho Thu chi dùng lại và kiểm không đổi hành vi. Không thêm writer tiền chỉ vì layout mới.
3. **Sửa read model:** đủ khóa/trạng thái, phân trang, tồn cũ, source, ngữ nghĩa số tiền; kiểm ledger/PNL riêng.
4. **Xây khu mới:** bảng, lọc, modal timeline và ghi chú; mọi lệnh đi lớp chung. Thêm cần bổ sung/sửa người nhận vào lớp chung nếu giữ trong phạm vi.
5. **Cắt đường cũ:** gỡ ba registry entry, render branch, modal, callback; cập nhật persisted-key fallback/mapping theo hành vi mong muốn và tests liên quan. Không xóa sổ Cọc đã thu.
6. **Kiểm đối chiếu hai bề mặt trên DEMO:** cùng actor/phiếu phải cho cùng hành động, quyền và kết quả khi thao tác từ Thu chi hoặc Hợp đồng & quyết toán.
7. **Review trước tích hợp:** thay đổi tiền/quyền theo risk-map, gate và draft PR của Project Contract. Chỉ kết luận có/không migration sau khi đường tạo nghiệp vụ đã được xác định và kiểm.

#### F. Tiêu chí nghiệm thu không được bỏ

- Không còn entrypoint cho ba mục cũ; từ khu mới không gọi PeriodCommissionModal hoặc handler duyệt/chi riêng của Thanh toán.
- Một phiếu mở ở hai trang có cùng khả năng hành động với cùng actor; không nhân đôi bảng quyền.
- “Chuyển Chờ Duyệt” không tạo posting, không đổi số dư; không gửi sổ mặc định ngầm. Test ca broker đủ điều kiện tự chi trước đây.
- “Duyệt” chỉ đổi approval; “Duyệt & Chi” và “Chi” chỉ ghi qua đúng machine Thu chi và dialog chứng từ.
- Một actor chỉ có quyền duyệt, một actor chỉ giữ sổ và một actor có cả hai cho kết quả phù hợp. Không yêu cầu approve cho bước chi phiếu đã duyệt.
- Multi-org, không giữ sổ, hết quyền sau khi mở dialog, kỳ khóa, source-owned và phiếu đã thay đổi version đều được kiểm.
- Hai cửa sổ cùng xử lý không tạo posting trùng; retry dùng idempotency đúng. Hủy dùng đúng approval/posting CAS.
- Cần bổ sung, sửa STK, resubmit được kiểm riêng; maker NULL không nhận thông báo gửi lại thành công giả.
- APPROVED+UNPOSTED và NOT_APPLICABLE không được cộng “đã chi” như POSTED; phiếu bị đảo không còn hiển thị đã chi đủ theo cờ cũ.
- Hoa hồng/thưởng không tạo hai phiếu sống từ cùng nguồn; hoàn không mất nghĩa vụ, force guard hoặc bị tạo lại chỉ vì reader không tìm được id.
- Sửa STK không thay amount, items, source, bank field không yêu cầu sửa hoặc account; dữ liệu refetch hiển thị đúng ở cả hai trang.
- Các kiểm thử và gate thực hiện ở đợt thi hành, không coi audit chỉ đọc này là bằng chứng chúng đã qua.


---


### 7.5. Kết luận KD-01…KD-14 của lần audit

“Đúng” dưới đây chỉ xác nhận nội dung và phạm vi ghi ở cột bằng chứng, không xác nhận toàn bộ suy luận thiết kế kéo theo.

| ID | Kết luận | Bằng chứng / giới hạn |
|---|---|---|
| KD-01 | **Đúng** | SQL §2.1 chạy lại: 12/12 route CANONICAL |
| KD-02 | **Sai tại lúc kiểm lại** | 92 phiếu, 255.828.834 đ; không có đã duyệt chờ chi trong tập đã lọc. Số 96/265.779.834 là snapshot cũ, chưa chứng minh nó sai ở thời điểm đo trước |
| KD-03 | **Sai tại lúc kiểm lại** | 86/92 thiếu STK, 27/92 thiếu sổ |
| KD-04 | **Đúng về việc không có ownership** | 0 dòng ownership trong cohort hiện tại **92**, không còn 96. Không suy ra mọi actor đều sửa được |
| KD-05 | **Đúng** | Đọc pg_get_functiondef của approve và approve-and-post production: đều nhận PENDING/CHANGES_REQUESTED, cùng các guard khác |
| KD-06 | **Đúng cho thao tác mới** | Request mới chỉ nhận PENDING/DISPUTED. Retry cùng idempotency key đã hoàn tất trả response cũ, không qua lại state guard |
| KD-07 | **Đúng về tồn tại/quyền EXECUTE** | Kiểm cả **11** RPC public được nêu tên trong §4, đều tồn tại/có EXECUTE cho authenticated; con số “8” không khớp danh sách. EXECUTE không thay thế capability/RLS/guard bên trong |
| KD-08 | **Sai nếu hiểu edit là điều kiện đủ** | Có thêm active membership, restricted/scope org, trạng thái, ownership. Ba field được hỗ trợ và không bắt buộc maker đối với phiếu thường là đúng |
| KD-09 | **Sai nếu áp dụng hai đầu cho mọi lần đổi** | A→B non-null kiểm hai sổ; NULL→B chỉ kiểm B; A→NULL chỉ kiểm A; giữ nguyên không vào guard chuyển sổ |
| KD-10 | **Đúng trong phạm vi form** | mutations.ts:215–247 dựng full patch + items, không an toàn cho sparse edit. Không có nghĩa mọi cột DB đều bị ghi |
| KD-11 | **Sai về tính bắt buộc do cap-1000** | Query id tối đa500 cho tối đa500 row. Paginate reader tập hợp vẫn cần; chunk và fail-closed vẫn nên giữ |
| KD-12 | **Sai về bảo đảm parity** | Commission-only giữ cách tính overview cũ; không chứng minh parity báo cáo. Sale có PNL thực tế; luật xếp hạng không phải phép tổng tiền |
| KD-13 | **Đúng** | Đếm còn thiếu nằm ở Panel:142 và Sheet:124; phép cộng cũng lặp ở hai nơi |
| KD-14 | **Chưa kiểm được** | Chưa chứng minh no-migration cho toàn thiết kế, nhất là tạo phiếu create-only/đủ source guards. Cũng chưa chứng minh phải có migration; không gọi writer hoặc chạy E2E ghi trong audit này |

### 7.6. Trả lời bốn câu hỏi mở của §8

1. **X9:** assertion đếm “Hoa hồng môi giới” ở báo cáo tài chính, không ở menu Thanh toán; kiểm chống trùng với count <= 1. Xóa key menu không trực tiếp làm assertion đó thất bại.
2. **Key persisted cũ:** sessionStorage, không phải localStorage; category mất thì cả Panel/Sheet fallback Tổng quan. Không tìm consumer bên ngoài hai bề mặt trên trong phạm vi source đã rà. Mapping key vẫn hữu ích để chuyển người dùng vào khu mới, nhưng lỗi trang trắng nêu trong câu hỏi chưa được chứng minh và có phản chứng fallback.
3. **get_period_commissions:** production không trả review_state/review_version. RETURNS TABLE chỉ có dữ liệu hợp đồng, bậc/số tiền, voucher id/amount/account/status. Cần query bù; đồng thời phải lấy approval/posting status thật vì status của RPC chỉ dựa approval_status.
4. **Ba NOT_APPLICABLE:** đúng là có ba phiếu; phải phân biệt “đã duyệt, không ghi quỹ/sổ ảo” với “đã chi tiền”. Không đưa 9.515.634 đ vào tổng thực chi chỉ vì APPROVED. UI hoàn cũ có thể gắn CHỜ DUYỆT do mapper nén non-POSTED; UI mới phải sửa ánh xạ đọc. Backend NON_CASH không đi đường post CASHBOOK như phiếu thường; cần đối chiếu nghĩa vụ/chứng từ trước khi quyết định xử lý tiền tiếp.


---

### 7.7. Xác nhận mới ngày 21/09/2026 — gửi lại phiếu cần rà soát

Người dùng chốt: **“chuyển từ cần rà soát đưa về lại stat chờ duyệt”**. Vì vậy nút **Chuyển chờ duyệt** thao tác trên phiếu đã tồn tại: giữ nguyên ID, mã phiếu, số tiền, nguồn và liên kết hợp đồng; chuyển review `CHANGES_REQUESTED` → `PENDING`, không tạo mới, không duyệt, không ghi chi. Nhóm Cần rà soát hiển thị review state thật, tách khỏi nguồn chưa lập phiếu và các cảnh báo thiếu thông tin.

**Xung đột cần sửa:** bản HTML trước đây đặt mã mới và tự đưa số hoa hồng về giá phòng × bậc khi gửi lại. Bản plan cũng từng hoãn `request_changes/resubmit` và dùng supplement thay yêu cầu bổ sung. Cả hai mô tả này đã bị xác nhận mới thay thế. Prototype đã sửa và kiểm bằng hành vi: PC-M103 vẫn là PC-M103, 2.640.000đ vẫn giữ nguyên khi chuyển lại Chờ duyệt. Prototype chỉ mô phỏng; chưa chứng minh RPC production.

**Hướng xử lý:** đưa yêu cầu rà soát và gửi lại vào policy/controller Thu chi dùng chung cho cả hai trang. Đo lại quyền người gửi, maker NULL của phiếu cũ, review version, idempotency và trigger freeze trước khi nối action. Không giả người lập phiếu, không dùng tham số patch của resubmit để sửa số tiền. Nếu capability hiện tại thiếu, bổ sung command chung có quyền theo org/toà và audit bằng migration được review theo Project Contract. Supplement vẫn là bổ sung ghi chú/chứng từ độc lập; nguồn chưa có phiếu dùng Lập phiếu chờ duyệt riêng, giữ ràng buộc nguồn và khóa chống trùng.

## 8. Danh sách khẳng định cần audit

Người audit xác nhận **đúng / sai / chưa kiểm được** cho từng dòng.

| # | Khẳng định | Cách kiểm |
|---|---|---|
| KD-01 | Cả 3 org đều `CANONICAL` ở 4 cờ tài chính V2 | SQL §2.1 |
| KD-02 | 96 phiếu chờ duyệt, 265.779.834 đ, không phiếu nào ở "đã duyệt chờ chi" | SQL §2.2 |
| KD-03 | 90/96 thiếu STK (31/96 thiếu sổ quỹ — ghi để tham khảo, KHÔNG dùng làm vướng mắc) | SQL §2.3 |
| KD-04 | 0/96 phiếu có dòng `income_expense_flow_ownership` | SQL §2.4 |
| KD-05 | Writer duyệt chấp nhận cả `CHANGES_REQUESTED` | `20260723050000:842`, `:1131` |
| KD-06 | `request_changes` **không** nhận `CHANGES_REQUESTED` | `20260723050000:1229` |
| KD-07 | 8 RPC ở §4 tồn tại trên prod, `authenticated` có EXECUTE | `pg_proc` + `has_function_privilege` |
| KD-08 | Sửa `payer_name`/`receive_bank_*` phiếu Chờ duyệt là hợp lệ, chỉ cần `income_expenses.edit` | Đọc thân `ie_compat_update_pending_v2` |
| KD-09 | Đổi `account_id` đòi CUSTODIAN **hai đầu** | Cùng hàm, nhánh `v_clean ? 'account_id'` |
| KD-10 | `useUpdateIncomeExpense` ghi đè toàn bộ trường ⇒ không dùng cho sửa lẻ | `src/hooks/income-expenses/mutations.ts:202+` |
| KD-11 | Truy vấn bù phải `fetchAllRows` + chia lô ≤500 | So với `useThanhToanLedgers.ts` |
| KD-12 | Tính tiền Tổng quan chỉ lấy `kind='commission'` mới giữ parity Lợi Nhuận | `LEDGER_FAMILIES` + `fixedExpenseCategories.ts` |
| KD-13 | Đếm "còn thiếu" nằm ở **hai** file | `PeriodFeePanel.tsx` + `PeriodFeeSheet.tsx` |
| KD-14 | Không cần migration nào cho đợt này | Rà lại §4: mọi RPC đã tồn tại |

### Câu hỏi mở cho người audit

1. **X9** — `business-performance.spec.ts:2348` đếm chữ "Hoa hồng môi giới" ở đâu? Nếu là nhãn
   menu của `/thanh-toan` thì xoá `hoa_hong` sẽ làm đỏ spec này.
2. Có bề mặt nào khác (Copilot tool, báo cáo, deep-link) đang trỏ vào
   `flt:thu-tien:fee-cat = 'hoa_hong' | 'chi_thanh_ly' | 'thuong_sale'` không? Khoá này là
   `usePersistedState` ⇒ **người dùng cũ mở trang sẽ có giá trị cũ trong localStorage**.
   Cần đường chuyển đổi, nếu không họ thấy trang trắng. *(Chưa xử lý trong thiết kế này —
   đề nghị người audit xác nhận đây là lỗ thật.)*
3. `get_period_commissions` có trả `review_state` / `review_version` không? Nếu có thì bỏ được
   một phần truy vấn bù.
4. Với 3 phiếu hoàn có `posting_status='NOT_APPLICABLE'` — chúng hiển thị thế nào ở cột trạng thái?
   Thiết kế hiện coi `APPROVED + NOT_APPLICABLE` là "đã xong", cần xác nhận đúng nghiệp vụ.

---

## 9. Kế hoạch kiểm chứng

| Lớp | Nội dung |
|---|---|
| Đơn vị | `contractSettlement.test.ts` — 4 bất biến ở §5.2 |
| Đơn vị | `feeCategories.test.ts` — cập nhật ghim `hop_dong → CONTRACT_SETTLEMENT` |
| Thủ công (DEMO) | Chuyển Chờ Duyệt · Bổ sung STK · Duyệt · Chi · Cần bổ sung · Từ chối, mỗi đường một lần |
| Thủ công (quyền) | Vai không có `income_expenses.approve`: không thấy nút Duyệt / Cần bổ sung |
| Thủ công (quyền) | Vai không giữ sổ: hộp thoại Chi không liệt kê sổ nào, không 403 |
| E2E | `thanh-toan-page.spec.ts` phải giữ xanh không sửa |
| Gate | `npm run gate:truoc-push`; thay đổi đụng tiền ⇒ **draft PR** theo Contract §3 |

**Lưu ý gate:** `gate:truoc-push` **không** phủ `security-gates` (15 gate chỉ chạy ở CI).

---

## 10. Đường lùi

Không có migration ⇒ lùi bằng revert commit là đủ. Dữ liệu không đổi hình dạng: mọi thay đổi
trạng thái phiếu đều là các chuyển trạng thái hợp lệ mà giao diện Thu chi / Phê duyệt đã làm được
từ trước, và đều có dấu vết trong `approval_requests` + audit của writer V2.

Rủi ro còn lại nếu phải lùi giữa chừng: phiếu đã bị bấm "Cần bổ sung" sẽ nằm ở
`review_state='CHANGES_REQUESTED'` mà giao diện cũ **không hiện trạng thái đó** — chúng vẫn duyệt
được bình thường (§3.1), chỉ là không thấy lý do. Chấp nhận được.

---

## 11. Nguồn tra cứu

| Nội dung | Nơi |
|---|---|
| Bản vẽ | `Thanh toan - Hop dong & quyet toan.dc.html` (design project `3990b67f-…`) |
| Writer Finance V2 | `supabase/migrations/20260723050000_finance_v2_writers.sql` |
| Guard sở hữu luồng | `supabase/migrations/20260723160000_finance_v2_compat_guard_fix.sql` |
| RPC sửa phiếu chờ duyệt | `supabase/migrations/20260902082004_ie_compat_update_pending_kiem_scope_moi.sql` |
| Cờ route theo org | `src/lib/financeV2Route.ts` |
| Hộp thoại ghi sổ | `src/components/income-expenses/IncomeExpensePostingDialog.tsx` |
| Mẫu dùng đúng | `src/pages/approvals/ApprovalsPage.tsx:340-367` |
| Luật hạng mục phí | `src/lib/feeCategories.ts` |
| Nghiệp vụ thanh lý | `docs/he-thong/16-thanh-ly-hop-dong.md` |
| Nghiệp vụ thu chi | `docs/he-thong/08-thu-chi-so-quy.md` |
