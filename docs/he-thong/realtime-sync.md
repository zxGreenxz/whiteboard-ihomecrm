# Đồng bộ Realtime (hub trung tâm + Zalo)

> **Phạm vi**: cơ chế đồng bộ dữ liệu thời gian thực giữa các client (nhiều thiết bị,
> nhiều nhân viên cùng lúc). Giải thích *bảng nào phát event → invalidate query key nào →
> màn nào tự làm mới*, và **quy tắc bảo trì** để không tái phát lỗi "màn kẹt dữ liệu cũ".
>
> **Bài học gốc**: 2026-07-07 — xoá 3 phiếu điện T7 bên Thu chi nhưng màn mobile "Đóng
> điện nước" vẫn hiện "Đã đóng". Nguyên nhân: query key `["utility-payments"]` không nằm
> trong danh sách invalidate của hub. Đây là tài liệu hoá cơ chế + bản đồ đầy đủ để tránh
> lặp lại.

---

## 1. Tổng quan — 2 hub độc lập

| Hub | File | Bảng lắng nghe | Dùng cho |
|---|---|---|---|
| **Data sync trung tâm** | [useRealtimeDataSync.ts](src/hooks/useRealtimeDataSync.ts) | `invoices, income_expenses, contracts, jobs, customers` | Mọi màn nghiệp vụ chính |
| **Zalo** | `useZaloRealtime` (domain [18](18-zalo-chat.md)) | `zalo_conversations, zalo_messages, zalo_accounts, zalo_labels` | Chat Zalo |

Cả 2 chỉ dùng event làm **tín hiệu** (bỏ payload) rồi invalidate cache React Query — KHÔNG
đọc dữ liệu từ payload. Tài liệu này tập trung hub data-sync trung tâm.

### Điều kiện chạy (phía DB)

Bảng phải nằm trong publication `supabase_realtime`. Đã bật ở migration
[20260704120000_realtime_business_tables.sql](supabase/migrations/20260704120000_realtime_business_tables.sql)
cho đúng 5 bảng trên (idempotent). Zalo bật riêng ở các migration `20260626000002/03/07`.

> **Chưa có realtime** (mọi thay đổi chỉ thấy khi F5 / hết staleTime): `building_utility_accounts`,
> `accounts`, `payments`, `meter_readings`, `contract_terminations`, các bảng lương v5… Nếu
> một màn đọc CHÍNH từ các bảng này và cần live, phải: (1) ADD bảng vào publication, (2) thêm
> entry vào `SYNC_TABLES`. Hiện các màn đó live *gián tiếp* nhờ dùng chung bảng đã bật (vd số
> dư sổ quỹ derive từ `income_expenses`).

---

## 2. Cơ chế hub trung tâm

Mount **1 lần** ở [App.tsx](src/App.tsx) qua `<RealtimeDataSync/>` — đặt trên `BrowserRouter`,
**độc lập route**, luôn sống khi đã đăng nhập (auth-gated trong hook, guard `hubActive` chống
mở trùng channel). Channel đặt tên theo user: `crm-data-sync-${userId}`.

```mermaid
sequenceDiagram
    participant A as Client A (thao tác)
    participant DB as Supabase (WALRUS/RLS)
    participant B as Client B (đang xem)
    A->>DB: UPDATE/INSERT/DELETE 1 bảng nghiệp vụ
    Note over A: mutation.onSuccess<br/>invalidate key CỦA MÌNH (tức thì)
    DB-->>B: postgres_changes (chỉ dòng B SELECT được — RLS)
    Note over B: hub gộp debounce 800ms/bảng
    B->>B: invalidateQueries(các key của bảng đó)
    B->>B: prefetchDomain (nếu tab visible)
    Note over B: query ĐANG MỞ refetch tại chỗ<br/>(giữ data cũ, không nháy "Đang tải")
```

Điểm mấu chốt:

- **Invalidate theo PREFIX mảng**: key `["income-expenses"]` phủ luôn
  `["income-expenses","stats",…]`, `["income-expenses","accrual-month",…]`… Nhưng key có
  **phần tử đầu khác** (vd `["cash-book"]`, `["invoice"]` số ít) thì **không** được phủ —
  phải liệt kê tường minh. **Đây chính là loại lỗi đã gặp.**
- **Chỉ refetch query đang mounted**; query không mở chỉ bị đánh dấu stale ⇒ thêm nhiều key
  vào danh sách gần như **miễn phí**.
- **Debounce 800ms/bảng**: thao tác bulk (sinh HĐ hàng loạt, import thu chi) bắn 1 event/dòng
  → gộp về 1 lần invalidate.
- **Re-prefetch** trang đầu của domain (`prefetchDomain`) chỉ khi `document.visibilityState
  === "visible"` — tab nền để staleTime tự lo.
- **RLS lọc theo JWT**: mỗi client chỉ nhận event của dòng nó SELECT được. Test cross-client
  phải chạm đúng dòng thuộc user đang quan sát.
- **Xoá = soft delete / đổi status**: thu chi "xoá" thực chất là UPDATE
  `approval_status='CANCELLED'` — vẫn là event trên `income_expenses`, hub vẫn nhận (event
  `*`). Không phụ thuộc hard DELETE (vốn chỉ mang PK).

---

## 3. Bản đồ bảng → query key (nguồn sự thật: `SYNC_TABLES`)

Cập nhật 2026-07-07. Xem trực tiếp [useRealtimeDataSync.ts](src/hooks/useRealtimeDataSync.ts).

### `income_expenses`
| Query key | Màn / hook | Ghi chú |
|---|---|---|
| `["income-expenses"]` | danh sách Thu chi + stats + accrual | prefix phủ nhiều |
| `["deposit-dashboard"]` | dashboard cọc | *cũng* gắn ở `contracts` (xem §4) |
| `["reservation-deposits"]` | cọc giữ chỗ | |
| `["dashboard-summary"]` | KPI màn chính | |
| `["utility-payments"]` | **"Đóng điện nước"** (useUtilityBills) | **fix 07/07** |
| `["utility-accounts"]` | mã PE/nước | |
| `["accounts-with-balance"]` | **số dư sổ quỹ** (useAccounts) | mọi mutation IE tự invalidate; hub trước đây thiếu |
| `["cash-book"] / ["cash-book-summary"] / ["cash-flow-by-day"]` | Sổ quỹ (useCashBook) | |
| `["handover-vouchers"]` | bàn giao tiền | |
| `["invoice-collectors"]` | quy công thu | đọc invoices + income_expenses (gắn cả 2 bảng) |
| `["manager-salary"]` | bảng lương QL | |
| `["voucher-with-batch"]` | chi tiết phiếu | |
| `["orphan-deposit-vouchers"] / ["contract-deposit-vouchers"]` | phiếu cọc | |
| `["shareholder-distributions"] / ["manager-salary-payouts"]` | chia LN / chi lương | |
| `["change-breakdown"]` | sổ thối | |
| `["commission-prefill"]` | prefill form HH | ưu tiên thấp |

### `invoices`
`["invoices"]`, `["invoice"]` (số ít — chi tiết), `["invoices-legacy"]`, `["invoice-statistics"]`,
`["invoice-totals-by-ids"]`, `["first-invoice-details"]`, `["invoice-rent-periods"]`,
`["invoice-collectors"]`, `["unpaid-invoices"]`, `["dashboard-alerts"]`, `["recent-activities"]`,
`["dashboard-summary"]`.

### `contracts`
`["contracts"]` (prefix phủ paged/stats/dashboard-counts), `["contracts-legacy"]`,
**`["deposit-dashboard"]`** (đọc `contracts` + `contract_terminations` — phải gắn ở ĐÂY mới
live theo thay đổi HĐ), `["unpaid-invoices"]`, `["dashboard-alerts"]`, `["recent-activities"]`,
`["dashboard-summary"]`.

### `jobs` / `customers`
`["jobs"]` · `["customers"]`, `["customer-stats"]`.

---

## 4. Lỗ hổng ngược từng gặp — `deposit-dashboard`

`useDepositDashboard` gắn tên "deposit" nên trực giác để ở entry `income_expenses`, **nhưng
queryFn thật sự đọc `contracts` + `contract_terminations`**
([useDepositDashboard.ts:71,159](src/hooks/useDepositDashboard.ts#L71)). Vì vậy trước 07/07,
đổi HĐ **không** làm mới dashboard cọc. Fix: thêm `["deposit-dashboard"]` vào entry `contracts`.

> **Bài học**: gắn key theo **BẢNG mà queryFn thực đọc**, không theo tên tính năng.

---

## 5. Có CHỦ Ý bỏ realtime — báo cáo nặng

Các báo cáo tổng hợp dùng RPC aggregate/per-row nặng, staleTime dài — **không** đưa vào hub để
tránh refetch hàng loạt khi có event (đặc biệt lúc bulk sinh HĐ). Cập nhật theo staleTime / khi
mở lại trang:

`financial-analysis` (fa_*), `reports/*`, `profit-verification`, `settlement-report`,
`collection-cycle`, `monthly-building-profit`, `profit-*`.

Nếu tương lai muốn cho live, cân nhắc kỹ chi phí (xem đợt tối ưu burst request 05/07).

---

## 6. Hai lớp làm mới — mutation vs hub

| Lớp | Ai hưởng | Khi nào |
|---|---|---|
| `mutation.onSuccess` invalidate | **client thao tác** | tức thì, không đợi realtime |
| hub `SYNC_TABLES` invalidate | **mọi client** (kể cả thao tác, có 800ms trễ) | qua postgres_changes |

Nguyên tắc: **mutation lo tức thì cho client hiện tại; hub lo cross-client.** Khi thêm mutation
đụng bảng nghiệp vụ, invalidate đủ key liên quan trong `onSuccess`; đồng thời đảm bảo hub cũng
phủ các key đó cho client khác.

Ví dụ chuẩn: `usePayUtilityBill.onSuccess` invalidate `utility-payments` (đóng tiền cập nhật
ngay). Đối xứng, 07/07 bổ sung `["utility-payments"]` vào `useCancelIncomeExpense` +
`useCancelIncomeExpenseBatch` để **huỷ phiếu điện từ Thu chi** cũng làm mới ngay trên thiết bị
thao tác ([useIncomeExpenses.ts](src/hooks/useIncomeExpenses.ts)).

---

## 7. ✅ Quy tắc bảo trì (đọc trước khi thêm màn mới)

1. Màn mới đọc từ 1 trong 5 bảng realtime bằng query key có **phần tử đầu mới**? → **thêm key
   đó vào entry bảng tương ứng** trong `SYNC_TABLES`, và cập nhật §3 tài liệu này.
2. Key gắn theo **bảng queryFn THỰC ĐỌC**, không theo tên tính năng (bài học §4).
3. Mutation mới đụng bảng nghiệp vụ → invalidate đủ key trong `onSuccess` (client thao tác) +
   xác nhận hub phủ (cross-client).
4. Cần live một bảng CHƯA có realtime → ADD vào publication (migration) TRƯỚC, rồi thêm entry.
5. Báo cáo aggregate nặng → cân nhắc để staleTime, không nhồi vào hub (§5).
6. Test cross-client phải chạm dòng thuộc **đúng user đang quan sát** (RLS lọc event).

---

## 8. Cách kiểm thử realtime

1. Mở màn cần kiểm ở **tab/thiết bị A** (cùng user test).
2. Ở **tab/thiết bị B** thực hiện thay đổi (tạo/xoá/sửa) dòng liên quan.
3. Trong ~1–2s (800ms debounce + latency) màn A **tự làm mới** không cần F5, không nháy "Đang
   tải". Quan sát `mcp__playwright__browser_console_messages` không có lỗi.
4. Chuẩn bị state qua Supabase Management API (PAT trong `CLAUDE.local.md`) nếu cần seed.
