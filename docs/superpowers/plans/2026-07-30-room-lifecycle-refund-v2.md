# Room Lifecycle và Hoàn cọc — Implementation Plan v2 (30/07/2026)

> **Tài liệu này THAY THẾ `room-lifecycle-refund.md`** (29/07/2026, chỉ tồn tại trên nhánh
> `fix/v5-collection-completion-20260722`). Bản 29/07 vẫn là bằng chứng lịch sử; mọi chỗ hai bản xung
> đột thì bản này thắng.
>
> Căn cứ: đợt kiểm toán 10 mảng chạy trên **codebase hiện tại + database production sống** ngày
> 30/07/2026, sau đó bị phản biện đối kháng (63 phán quyết: 41 sống, 22 bị bác).
> Hiện trạng số liệu: **`2026-07-30-thu-tien-state-of-world.md`**.
> Quyết định biên tập, thứ tự slice, đánh số migration: **`2026-07-30-danh-gia-2-plan-thu-tien-v2.md`**.
> Plan 1 v2: **`2026-07-30-special-payment-governance-v2.md`**.
> Tài liệu này **không lặp lại** bằng chứng của ba tài liệu trên; nó **trích dẫn**.
>
> **Đây là một PLAN.** Không một dòng nào dưới đây được đọc là "đã code", "đã apply", "đã test".
>
> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (khuyến nghị)
> hoặc `superpowers:executing-plans`. Mọi bước dùng checkbox. Mỗi bước bị chặn đều mang nhãn
> **BLOCKED-BY** và **không được bắt đầu** khi tiền đề chưa xanh.

**Goal:** Cung cấp hàng đợi `Hoàn cọc` (mount trên `/thanh-toan`) và một chu trình dòng tiền liên tục
theo phòng (mount trên `/thu-tien`); check một obligation hoàn cọc hợp lệ sẽ tự `APPROVED + POSTED`
nguyên tử, không tạo phép tính hoàn cọc thứ hai, và không thay đổi quyền/trạng thái của luồng truyền
thống ngoài hai bề mặt này.

**Architecture:** **Bốn** đường hiện đang tạo hoặc đổi hồ sơ thanh lý (§0.4) — ba writer SQL và một
fallback phía client ghi vào một bảng **không tồn tại**. Ba writer SQL phải đi qua một canonical
settlement emitter; đường thứ tư phải bị **xoá** (Slice −1.8). Emitter tạo immutable settlement
snapshot, sticky canonical-subject marker, canonical refund voucher/items và một
`app_private.termination_refund_obligations` trong cùng transaction, rồi đăng ký Finance ownership
**sau khi `account_id`/`voucher_date` đã được ghi** (§3.5 — allowlist của freeze guard không chứa hai
cột đó, nên trật tự cũ "owned tại birth rồi finalize sau" là **bất khả thi**). `/thanh-toan` chỉ hoàn
tất voucher đã tồn tại: chọn sổ thật, link evidence đã finalize, gọi shared dedicated posting adapter
và consume obligation. Room lifecycle là read model theo residence segment, ưu tiên source snapshot của
từng event, phủ **cả hai** đường đổi phòng (§0.3), và trả conflict thay vì gán mù vào
`contracts.room_id` hiện tại.

**Tech Stack:** PostgreSQL/Supabase (`SECURITY DEFINER`, RLS, composite guards, advisory/row locks,
partial unique indexes), Finance V2 postings, React 18 + TypeScript + TanStack Query + shadcn/ui,
Vitest/fast-check, Playwright fleet. **Mọi read RPC khai VOLATILE** (mặc định) — xem §3.3.

---

## 0. Quy tắc đã khóa

### 0.0 CHẶN CỨNG — Task 1→5 không được bắt đầu (mới, thay cho câu "phụ thuộc shared runtime của Plan 1")

Bản 29/07 viết ở dòng 3 rằng "mọi đường ghi tiền **phụ thuộc** shared runtime và posting adapter của
Plan 1". Đó là cách nói nhẹ sai bản chất. Đo trên `pg_proc` / `pg_class` ngày 30/07:
**KHÔNG một tiền đề nào tồn tại trên production.**

| Object mà Plan 2 gọi như thể đã có | Trạng thái prod 30/07 | Ai phải giao | Task/Step gọi nó |
|---|---|---|---|
| `app_private.resolve_signed_contract_deposit_basis_v1` | **KHÔNG TỒN TẠI** | Plan 1 Task 5 (Slice 1) | Task 1 Step 1, Task 2 Step 1, Task 3 Step 3, Task 6 Step 4 |
| `app_private.special_page_submit_context_v1` | **KHÔNG TỒN TẠI** (`proname LIKE '%special%'` = 0 dòng) | Plan 1 Task 5 (Slice 1) | Task 5 Step 2 |
| `finance_v2_post_voucher_with_source_v1` | **KHÔNG TỒN TẠI** (`proname LIKE '%with_source%'` = 0 dòng) | Plan 1 Task 5 (Slice 1) | Task 5 Step 5 |
| `app_private.org_today_v1` | **KHÔNG TỒN TẠI** | Plan 1 Task 5 (Slice 1) | mọi chỗ plan viết `CURRENT_DATE` |
| `app_private.special_page_cashbook_override_v1` | **KHÔNG TỒN TẠI** | Plan 1 Task 5 (Slice 1) | §3.3, Task 5 Step 4 |
| `app_private.set_feature_freeze_v1` | **KHÔNG TỒN TẠI**, và **không hàm nào trong toàn DB ghi `force_freeze`** | Plan 1 Task 8 (C-ROLL-1) | Task 8 Step 6 |
| `special_fee*`, `termination_refund*`, `room_residence_segments`, `termination_settlement_snapshots` | **KHÔNG một object nào tồn tại** | Plan 2, chính tài liệu này | toàn bộ |

**Hệ quả thi hành:**

- **Task 1, 2, 3, 5 — BLOCKED-BY Plan 1 Task 5** (shared runtime, Slice 1). Không được viết một dòng
  migration nào của chúng trước khi `20260731010000_special_page_runtime.sql` đã apply và xanh gate.
- **Task 0 và phần đọc-được-ngay của Task 6 KHÔNG bị chặn** — chúng không phụ thuộc obligation. Theo
  `danh-gia v2 §7` chúng chạy ở **Slice 2**, song song với Plan 1.
- **Task 4 — BLOCKED-BY Task 1** (cần schema obligation) nhưng **không** cần posting adapter.
- **Task 7 — BLOCKED-BY Task 4 + Task 6**, và phần `/thu-chi` dispatch **BLOCKED-BY Task 1 Step 5**.
- **Task 8 — BLOCKED-BY tất cả**, cộng `C-ROLL-1` (chưa có đường có kiểm toán để `force_freeze`).
- **Toàn Plan 2 — BLOCKED-BY Slice −1** (§0.5). `danh-gia v2 §4.1` liệt kê hai gate của Plan 2 không
  thể tồn tại trước Slice −1: *"`/deposits` Đã hoàn chỉ khi POSTED"* (bị chặn bởi −1.7) và
  *"Snapshot bất biến"* (bị chặn bởi −1.9).

### 0.1 Số tiền hoàn canonical (sửa)

`contract_terminations.refund_amount` là net settlement **GENERATED ALWAYS (stored)**, có thể **âm**
(min đo được **−10.590.180,64**, termination `2731f528`, HĐ `HD-2026-00257`; 18/35 dòng `COMPLETED` là
âm; tổng nhóm `COMPLETED` = **−66.207.315,35**). Nó chỉ là dữ liệu lịch sử; `/thanh-toan` **không** dùng
field này để quyết định số tiền chi. Công thức và các cột nuôi nó: xem `state-of-world §5.2`.

Một obligation dương chỉ được phát ra sau khi canonical termination writer đã tạo voucher và toàn bộ
items. Server yêu cầu từng refund item có amount hợp lệ, voucher là `EXPENSE`, và snapshot:

```text
item_sum          = round(SUM(COALESCE(item.amount, item.unit_price * item.quantity)), 2)
canonical_amount  = item_sum, với item_sum > 0 và item_sum = income_expenses.total_amount
deposit_subtotal  = SUM(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT')   ← THÊM
other_subtotal    = canonical_amount - deposit_subtotal                                 ← THÊM
settled_amount    = tổng active posting của canonical payment chain
remaining_amount  = canonical_amount - settled_amount
```

**ADD — `deposit_subtotal` là bắt buộc, không phải tuỳ chọn** (`C-DEP-2`). Ca sống `PC2607104`
(termination `a1ee1eb7`) có `total_amount = 2.852.000` = `DEPOSIT` 2.352.000 *"Hoàn cọc thanh lý"* +
`PNL` **500.000** *"Hoàn tiền thừa thanh lý"*. Nó **thoả mọi kiểm tra** của §0.1 bản 29/07, nên
`canonical_amount` một mình sẽ in **tổng tiền ra két** vào một ô mà tab `/deposits` gọi là "Đã hoàn cọc"
(`DepositsPage.tsx:429` header *"Cọc gốc"*, `:463` badge *"Hoàn cọc"*, `:487-488` *"Đã hoàn {amount}"*).
Thêm một conflict code cho obligation dương mà `deposit_subtotal = 0`.

Client inputs (`p_deposit_refund`, `p_excess_rent`, debt, penalty, extras) chỉ là intent. Emitter lock
contract/termination/invoices/deposit vouchers, gọi shared
`app_private.resolve_signed_contract_deposit_basis_v1` (**BLOCKED-BY Plan 1 Task 5**), derive approved
settlement invoice/items trên server, reject mọi input vượt basis hoặc không khớp source rows, rồi
snapshot requested-vs-verified. Không dùng `contracts.deposit_paid` derived một mình vì nó gồm
virtual/N/A. Không lọc bỏ line âm rồi cộng phần dương. Item/header/source/hash invalid thành
`CONFLICT`; net âm là `CUSTOMER_OWES`/`DEPOSIT_FORFEIT`, zero không có queue.

**ADD — luật chống tái sinh số sai:** một khoản khấu trừ ghi trên `contract_terminations` **chỉ được
tin** sau khi đối chiếu trạng thái sống của **chính phiếu của nó**. Phản ví dụ bắt buộc ghi vào plan:
HĐ `69cdb5dc` có `early_termination_fee = 1.071.500` trong khi phiếu offset của nó `PC2607118`
(`system_source='termination.offset'`) đang **`CANCELLED` + `NOT_APPLICABLE`**. Mọi backfill tin
`total_deductions` (cũng là GENERATED) sẽ **tái tạo lại con số sai** — xem §0.5 và Task 3 Step 3.

**ADD — `refund_method` phải set tại birth** (`C-TERM-METHOD`, `[X9.6]`): CHECK
`terminations_refund_method_required_if_refund` = `refund_amount <= 0 OR refund_method IS NOT NULL`.
Emitter **buộc** set `contract_terminations.refund_method` (giữ parity `'TM'` như
`terminate_contract_move_out_impl:235` đang hardcode) khi `refund_amount > 0`, nếu không insert vỡ
**`23514`**. Không plan nào từng hứa manager chọn phương thức — field này sống ở
`contract_terminations` và đã bị §0.1 dán nhãn historical-only.

### 0.2 Nút check và ranh giới quyền (sửa)

- Manager chỉ chọn real cashbook, bổ sung evidence và bấm check; amount là read-only.
- Exact obligation dùng source-scoped writer, tự `APPROVED + POSTED` và consume obligation trong một
  transaction.
- **Không** gọi public `decide_owned_income_expense_v2` / `approve_and_post_income_expense_v2` dưới
  danh nghĩa manager. **ADD:** câu đó là chỉ thị cho writer của chính plan này; nó **không** đóng được
  lỗ có thật ở §3.6 — endpoint đó đang `GRANT EXECUTE` cho `authenticated` và client đã có đường tới.
- Khác amount hoặc muốn chia đợt không được xử lý trong exact queue. Delivery này **không hỗ trợ split
  refund**. Owner/superadmin chỉ có controlled correction: release PENDING obligation với reason, sửa
  domain settlement inputs qua canonical correction RPC, rồi emitter tạo snapshot/voucher/obligation
  replacement; không nhận free-form replacement amount.
- `/thu-chi`, contract page, invoice refund và writer khác giữ permission/approval/posting hiện tại cho
  **ordinary vouchers**. **SỬA câu hứa cho phiếu hoàn** (patch từ mảng 9): viết chính xác là *"Phiếu
  hoàn cọc canonical **KHÔNG còn** dùng RPC lifecycle chung; toàn bộ Duyệt/Từ chối/Huỷ/Ghi sổ/Hoàn tác
  của nó đi qua 5 named wrapper mới, với **đúng bộ quyền cũ** (`income_expenses.approve` cho duyệt,
  CUSTODIAN cho ghi sổ). Phiếu thường không đổi gì."* Câu 29/07 *"traditional page vẫn approve/reject/
  cancel/reverse theo quyền cũ"* đúng về **quyền** nhưng sai về **đường gọi**: ownership làm 11 RPC
  generic ném `42501` (`state-of-world §4.7`).
- **ADD — chuỗi lỗi là hợp đồng, không phải văn xuôi** (`D8`): lối tôn trọng ownership duy nhất đang
  tồn tại là regex tiếng Anh `/owned by system flow/i` (`financeV2Mutations.ts:46-48` dùng ở `:60`,
  lặp ở `statusMutations.ts:315` và `:352`), khớp chuỗi do `assert_income_expense_flow_owner_v2:20`
  phát. **Mọi adapter/wrapper mới phải giữ NGUYÊN VĂN substring đó** cho tới khi routing ownership-first
  lên, không thì dispatch chết im sau toast *"Duyệt phiếu thất bại"*.

### 0.3 Residence segment và nguồn room (sửa — có HAI đường đổi phòng)

Identity top-level là `organization × room`; một contract có thể chuyển phòng. Projection dùng half-open
ranges:

```text
(organization_id, room_id, contract_id, from_date, to_date_exclusive,
 source_transfer_id, source_path, history_status)
```

**ADD — `source_path` là cột mới bắt buộc**, vì có **hai** đường ghi `contracts.room_id`
(`state-of-world §5.3`):

| Đường | Kích hoạt | Ghi gì | Dữ liệu 30/07 |
|---|---|---|---|
| **A — `public.transfer_room`** | Gọi trực tiếp | `:61-70` `UPDATE contracts SET room_id`; `:88-100` INSERT `contract_transfers (… 'COMPLETED', NOW())` bọc `EXCEPTION WHEN OTHERS THEN NULL`; `:16-19` SELECT contract **không có `FOR UPDATE`**. Comment `:87` ghi rõ đặt `status='COMPLETED'` để **KHÔNG kích** đường B | **3/3 dòng** `contract_transfers`, đều `ROOM_CHANGE` + `COMPLETED`, đủ `old_room_id`/`new_room_id`/`move_out_date`/`move_in_date` |
| **B — trigger `trigger_apply_contract_transfer`** | `BEFORE UPDATE OF status ON public.contract_transfers`, khi `OLD.status='DRAFT' AND NEW.status='APPROVED'` (**không phải `COMPLETED`**) | `apply_contract_transfer():17-27` ghi đè `room_id`, `rent_price`, `total_deposit` **và `start_date`/`end_date`**, đặt `status='TRANSFERRED'`, `parent_contract_id=id` | **0 dòng** hôm nay, nhưng đường code còn sống và RLS cho UPDATE với `contracts.edit` |

⇒ **Task 0 Step 3 (chỉ đọc transfer `status='COMPLETED'`) bỏ sạch đường B**, và **Task 0 Step 4 neo
đoạn đầu vào `contracts.start_date` — đúng cột mà trigger B ghi đè**. `BOTH_CHANGE` = **0 dòng ở mọi
nơi**. Hai giả định đó phải bị **xoá**, không phải nới.

Room attribution ưu tiên source snapshot: invoice room cho invoice/collection; residence segment tại
ngày ký cho broker/Sale; termination settlement snapshot cho refund/forfeit; old/new room của transfer
cho `ROOM_CHANGED`. Residence segment chỉ là fallback/cross-check. Thiếu audit hoặc chain không nối được
phải trả `SEGMENT_HISTORY_INCOMPLETE`/`SEGMENT_HISTORY_AMBIGUOUS`, tuyệt đối không dùng current room như
lịch sử.

**REORDER — snapshot attribution hạ từ điều kiện tiên quyết xuống forward-guard.**
`contract_terminations` có **33 cột và KHÔNG có `building_id`/`room_id`** ⇒ "snapshot building/room" không
thể lấy từ bảng đó. Nhưng snapshot **theo phiếu đã tồn tại và đã đầy**:
`terminate_contract_move_out_impl` INSERT `income_expenses (… building_id, room_id, contract_id …)` và
**20/20 phiếu hoàn có `building_id`/`room_id` non-null**, `ie.room_id = c.room_id` đúng **20/20**; cả 3
transfer `COMPLETED` nằm trên HĐ `ACTIVE` **không có termination** ⇒ **0 dòng đang bị phơi**. Vì vậy bản
sửa số/trạng thái `/deposits` (Slice −1.7 + Task 4) **được phép ship trên snapshot cấp-phiếu hiện có**,
không phải chờ `termination_settlement_snapshots`.

### 0.4 BỐN writer, không phải hai (sửa — `C-TERM-1`, `[A9.R1]`)

Bản 29/07 nói *"Hai termination writers hiện có"*. Đo thật: **bốn** (`state-of-world §5.1`).

| # | Đường | Hành vi đã xác minh | Việc Plan 2 phải làm |
|---|---|---|---|
| **1** | `terminate_contract_move_out_impl` (chuỗi `TerminateDialog.tsx` → `useTerminateMoveOut` → `..._with_credit_v1` → `terminate_contract_move_out` → `impl`) | `:179-183` INSERT phiếu hoàn RAW: `account_id=NULL`, không cột `invoice_id`, `UNAPPROVED`, `system_source='termination.refund'`, kèm `building_id/room_id/contract_id`. `:226-240` INSERT `contract_terminations` với `prorated_* = 0` **mọi lần** và bọc `EXCEPTION WHEN OTHERS THEN RAISE WARNING` ⇒ **nuốt lỗi audit**. `:235` hardcode `refund_method='TM'` | Canonicalize (Task 2 Step 4) |
| **2** | `approve_contract_termination_v1(uuid,text)` | `:65` lấy **cột GENERATED** `refund_amount`. `:94-105` INSERT phiếu `UNAPPROVED`, `account_id=null`, **KHÔNG có cột `system_source`** ⇒ NULL. Correlation duy nhất là `left(termination_id::text,8)` trong description item. `:43-46` trả `noop:true, voucher_id:null` khi đã `COMPLETED`. Cùng UPDATE đặt `status='COMPLETED', refund_date=now()`. **Không có defining migration** dưới `supabase/migrations/` | Canonicalize (Task 2 Step 5) |
| **3** | `terminate_contract_forfeit_impl` | INSERT `contract_terminations` `termination_type='FORFEIT'`, `status='COMPLETED'`, `total_deposit = early_termination_fee = v_deposit`. **KHÔNG sinh phiếu hoàn** — chỉ cặp offset `EXPENSE` + revenue `INCOME` (`:168-184`). Audit insert cũng bọc `EXCEPTION WHEN OTHERS` (`:262-263`). **Nhánh chiếm đa số: 26/37 dòng** | **Attribution + quyết số phận audit bị nuốt** (xem dưới) |
| **4** | Fallback **phía client** `useApproveTermination` (`src/hooks/useContracts.ts:1119-1177`) | `:1126-1135` UPDATE `contract_terminations → 'APPROVED'`; `:1137-1145` UPDATE `contracts → 'TERMINATED'`; `:1147-1155` UPDATE `→ 'COMPLETED'` + `refund_date`; `:1159-1177` **INSERT INTO `public.cash_book`** — `to_regclass('public.cash_book')` = **NULL**, bảng không tồn tại. **Không transaction** ⇒ HĐ có thể kết thúc `COMPLETED`/`TERMINATED` mà **không có phiếu tiền nào**. Hôm nay 0 call site, nhưng hàm còn export và policy RLS còn cho | **XOÁ** ở Slice −1.8 (`useApproveTermination` / `usePendingTerminations` / `useRejectTermination`, cả ba đã `@deprecated`) |

**Chính xác về FORFEIT — đây là chỗ bản kiểm toán thô đã bị bác 2/3** (`[X9.4]`):

- FORFEIT **không phải đường hoàn tiền**: nó **không phát phiếu hoàn**, đúng thiết kế. §0.1 đã route
  net ≤ 0 sang `CUSTOMER_OWES`/`DEPOSIT_FORFEIT` **không có queue** ⇒ **không sinh obligation là ĐÚNG**,
  không phải lỗ coverage. `/deposits` trả "không có obligation" cho 26 dòng này là hành vi đúng.
- `DEPOSIT_FORFEIT_POSTED` **suy ra được** từ **8 phiếu `termination.forfeit_offset` + 8 phiếu
  `termination.forfeit_revenue`, 31.000.000đ mỗi bên**, mà `statusMutations.ts:39-42` **đã key sẵn** ⇒
  Task 6 Step 2 không cần snapshot cho nhánh này.
- Dự đoán *"26 dòng sẽ báo `LEGACY_SOURCE_UNKNOWN`"* là **suy diễn chưa kiểm chứng** — không được viết
  vào plan như sự thật.
- Hai việc **thật sự** còn nợ: (a) **attribution** trong read model Task 6, lấy nguồn từ chính hai họ
  phiếu `termination.forfeit_*`; (b) **một quyết định tường minh** về audit insert bị nuốt tại
  `:262-263` — fail-close (raise) hay chấp nhận có ghi nhận. Bản 29/07 không có cả hai.
- Chuỗi gọi `terminate_contract_forfeit_with_credit_v1 → terminate_contract_forfeit → impl` phải vào
  **preflight digest** của Task 2 Step 4 và vào **sticky routing** Step 3, dù nó không sinh obligation.

### 0.5 Quan hệ với Slice −1 (mới — không được gộp, không được bỏ)

`danh-gia v2 §4` đặt một **Slice −1** đứng trước tất cả: chín khuyết tật đang sống trên production, độc
lập với cả hai plan. Bốn hạng mục của Slice −1 nằm đúng trên mặt cắt của Plan 2 và **Plan 2 không được
tự làm lại chúng**:

| Slice −1 | Nội dung | Ảnh hưởng tới Plan 2 |
|---|---|---|
| **−1.7** | `/deposits`: `refund_done` derive từ **phiếu POSTED + active posting** (bỏ cả `refund_date` lẫn `COMPLETED`); **sửa `get_refund_forfeit_summary`** cùng lúc; số âm hiện "Khách còn nợ"; bỏ matcher `notes LIKE` của `useContractPendingTermination` | Task 4 và Task 7 **xây tiếp trên** reader đã sửa. Task 4 **re-point** KPI sang obligation ledger; Task 7 **thêm assertion KPI**. Nếu Slice −1.7 chưa xanh, gate của Task 7 *"Đã hoàn chỉ khi POSTED"* **pass mà trang vẫn sai** |
| **−1.8** | **Xoá** `useApproveTermination`/`usePendingTerminations`/`useRejectTermination` | Xoá writer thứ tư khỏi mô hình. Task 2 **không** phải canonicalize nó |
| **−1.9** | REVOKE UPDATE `contract_terminations` khỏi `authenticated`, hoặc tối thiểu guard trigger đông cứng input quyết toán khi `status IN ('APPROVED','COMPLETED')` | Đây là **điều kiện tồn tại** của "snapshot bất biến" (§3.5, Task 1 Step 6) |
| **−1.6** | Hoist `usePeriodFeeState`/`useUtilityPayState` lên `ThanhToan.tsx` (một nguồn `amounts/bookSel/attach`) | Task 7 Step 1 **phải tiêu thụ state đã hoist**, không thêm instance thứ ba |

**Luật:** Plan 2 **cross-reference** Slice −1, không sao chép. Nếu Slice −1 bị hoãn thì Task 4/7 của
Plan 2 phải **tự mang** các hạng mục trên, và phải nói rõ điều đó trong PR — không được im lặng ship
một read model canonical bên cạnh một KPI tự tính.

---

## 1. Bằng chứng code/database phải giữ trong đầu

Bản 29/07 có 11 bullet. Dưới đây là bản đã sửa/bổ sung; số nào bị thay thì ghi rõ.

### 1.1 Bốn writer và bốn bề mặt đọc

- **Writer:** xem §0.4. **ZERO DRIFT** giữa body live và 5 file baseline (normalized): `with_credit_v1`
  113/113, `terminate_contract_move_out` 160/160, `impl` 210/210, `approve_contract_termination_v1`
  99/99 (cả hai file snapshot), `transfer_room` 78/78 (`[A9.V11]`). ⇒ Preflight digest của Task 2 là
  **kiểm tra thật, không phải nghi thức**, và hiện nó sẽ **pass**.
- **ADD — đường gọi bỏ qua wrapper:** `public.terminate_contract_move_out` (route giữa) có
  `proacl = postgres=X | authenticated=X | service_role=X` ⇒ client gọi **thẳng** được, **bỏ qua**
  idempotency key, payload hash và guard credit vốn chỉ nằm ở wrapper (`:84-90`). `impl` thì đã đóng
  đúng (`postgres=X | service_role=X`). ⇒ Task 2 Step 4 phải **REVOKE** route giữa khỏi `authenticated`,
  **hoặc** gắn sticky marker + canonical idempotency vào **chính route giữa** (`[A9.C13]`).
- **Bốn bề mặt đọc** (bản 29/07 nêu hai): xem `state-of-world §5.7`. Ngoài `/deposits` và contract
  detail còn có **ô KPI `get_refund_forfeit_summary`** (§1.4) và **cảnh báo
  `useContractPendingTermination`** — hook này dò `notes LIKE '[HOÀN KHÁCH THANH LÝ]%'` + `.eq
  ('approval_status','UNAPPROVED')` ⇒ nhận ra **4/20** phiếu hoàn, và **phiếu đã duyệt mà chưa vào sổ
  không được cảnh báo ở đâu cả**.
- **ADD — `useContractTerminationInfo`** (`useContractDetailData.ts:97-100`) lấy dòng termination mới
  nhất **không lọc status** (`.order("created_at", desc).limit(1)`) ⇒ một DRAFT sinh sau **ghi đè**
  settlement đang hiện. Latent hôm nay (37 termination / 37 HĐ khác nhau) nhưng chuỗi
  replacement/correction của Task 5 Step 7 **cố ý tạo thêm row** ⇒ phải sửa cùng lúc.

### 1.2 Correlation hồ sơ ↔ phiếu: không có khoá nào

- `income_expenses` **không có** cột `termination_id`; **không có** FK `contract_terminations → voucher`
  ở bất kỳ đâu.
- **16/20** phiếu `system_source='termination.refund'` không tra được termination theo
  `(organization_id, contract_id)`; đúng 4 phiếu còn lại là 4 phiếu duy nhất mang prefix note
  `[HOÀN KHÁCH THANH LÝ]`.
- **ADD (đo lại 30/07):** trong org thật có **19 phiếu `termination.refund` sống, 10 POSTED**, và
  **8/10 phiếu POSTED không có một dòng `contract_terminations` nào trên `contract_id` của chúng**
  (2/10 có). ⇒ "tiền đã ra mà hồ sơ thì không" là hình dạng chủ đạo, không phải ngoại lệ.
- **2 hợp đồng mang 2 phiếu hoàn cùng số tiền** (một POSTED, một CANCELLED): contract `a1584980`
  (`PC2606049` POSTED / `PC2606050` CANCELLED, 2.797.000) và `aa16a805` (`PC2607074` POSTED /
  `PC2607073` CANCELLED, 3.127.400) ⇒ mọi reader correlate theo `contract_id` (**cách duy nhất hôm
  nay**) trả **2 row cho 1 hồ sơ**, phá chính hợp đồng *"đúng một row mỗi id"* của §3.3.
- `contract_deposit_links` chỉ **5 dòng** và **không có cột amount**.
- **SỬA con số 29/07:** bản cũ ghi *"35 completed terminations; 37/56 termination audit rows thiếu"*.
  Số đo lại 30/07: `contracts` `TERMINATED` = **56**; `contract_terminations` = **37 dòng / 37 contract
  khác nhau**; **23/56 HĐ không có dòng nào**, trong đó **14 HĐ VẪN có phiếu `termination.refund`**; lỗ
  còn phát sinh (**2/18** ca tháng 07/2026). Thêm conflict code
  **`TERMINATION_ROW_MISSING_BUT_MONEY_EXISTS`**, và **chính sách: KHÔNG tự tạo hồ sơ thanh lý hồi tố —
  chỉ report.**
- **Cửa sổ mutable trước duyệt đã xảy ra thật:** phiếu `975a5afb` (`PC2607153`, UNAPPROVED, 3.509.500)
  `created_at 2026-07-27 05:11:18`, `updated_at 05:14:33`, `account_id` hiện `df6b5925` trong khi writer
  sinh ra với NULL; và **5/20** phiếu hoàn có `invoice_id` non-NULL dù writer không bao giờ set. ⇒
  "snapshot obligation nhưng để voucher mutable tới submit" **đã là race đang xảy ra**, không phải giả
  thuyết.

### 1.3 Hàng nguồn `contract_terminations` KHÔNG được bảo vệ (ADD — `[A9.R2]`, HIGH)

`pg_policies`: `contract_terminations_update_rbac`, `cmd=UPDATE`, `roles={public}`, `qual` = `with_check`
= `is_super_admin() OR building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.edit'))`
— **không ràng buộc cột, không guard trigger nào** chặn sửa input quyết toán sau `COMPLETED`. Trigger duy
nhất trên UPDATE là `auto_calculate_termination_financials` (chỉ điền khi NULL) và
`update_contract_on_termination_approved:7-18` (tự set `contracts.status='TERMINATED'` khi
`status → 'APPROVED'`).

⇒ Bất kỳ ai có `contracts.edit` trên toà đều đổi được `outstanding_debt` / `total_deposit` /
`early_termination_fee` qua REST và do đó **đổi luôn `refund_amount` GENERATED**; hoặc set
`status='APPROVED'` để trigger **tự TERMINATED hợp đồng, không qua writer nào**.

**Một immutable snapshot KHÔNG bảo vệ HÀNG NGUỒN.** Đây là lý do §3.5 và Task 1 Step 6 phải có guard
trigger riêng trên `contract_terminations`, và Task 1 Step 7 phải có ca âm: client có `contracts.edit`
UPDATE trực tiếp ⇒ **55000** (hoặc **42501** nếu Slice −1.9 đã REVOKE).

### 1.4 Ô KPI `/deposits` — hàm SQL mà cả ba plan doc không nhắc (ADD — `C-DEP-KPI`, `[X0.3]` SỐNG)

`public.get_refund_forfeit_summary(uuid[])`: `LANGUAGE sql`, `STABLE`, `SET search_path TO 'public'`,
**SECURITY INVOKER** (không DEFINER) ⇒ RLS scope theo tenant. Nó cộng
`SUM(GREATEST(0, contract_terminations.refund_amount)) FILTER (WHERE termination_type <> 'FORFEIT')`
trên **mọi** termination non-FORFEIT, **không lọc status, không lọc posting**, và **đếm cả `DRAFT` /
`PENDING_APPROVAL` là một "lần"**. Đường dây: `DepositsPage.tsx:272-277` ← `:170-171` ← `:125`
`useRefundForfeitSummary(buildingIds)` ← `useDepositDashboard.ts:64` `rpc('get_refund_forfeit_summary')`.

| Đo | `aaaa` (org thật) | `dddd` (DEMO) |
|---|---:|---:|
| Hàm đang trả hôm nay | **8.290.000đ / 3 lần** | **700.000đ / 8 lần** |
| Số đúng (phiếu chi **đã vào sổ**, correlate được hồ sơ) | **4.302.000đ / 2 dòng** | 0 |
| Thổi phồng | **+3.988.000đ** | +700.000đ |

Con số **8.990.000đ / 11 lần** (mà một auditor báo là "trước") là **tổng xuyên org đọc bằng
service-role** — **không người dùng nào thấy nó**, vì hàm là SECURITY INVOKER và `relrowsecurity=true`
trên `contract_terminations`/`contracts`/`rooms` (`D4`). Khi viết before/after cho chủ, dùng **số theo
org**; nếu vẫn muốn nêu 8.990.000/11 thì phải kèm đúng cái nhãn "cross-org, service-role".

⇒ Thi hành Task 7 Step 5 **theo đúng chữ bản 29/07** sẽ để KPI đọc **8.290.000đ / 3 lần** ngay **phía
trên** một bảng chỉ còn **4.302.000đ / 2 dòng**. Task 7 Step 6 của bản 29/07 **không hề đọc KPI** nên
gate vẫn xanh. Phải: **thêm `get_refund_forfeit_summary` vào migration read của Task 4** và **thêm
assertion KPI vào Task 7**.

### 1.5 Guard tiền theo REGEX trên `payments` (ADD — `[A9.R4]`, HIGH; cả hai plan không nhắc)

`CREATE TRIGGER a10_payment_termination_non_cash BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE
FUNCTION app_private.classify_termination_payment_v1()`:

- `:15-16` nhận diện payment quyết toán move-out bằng **regex trên `payments.notes`**:
  `^Quyết toán khi thanh lý [0-9]{2}/[0-9]{2}/[0-9]{4}( \(cấn cọc\))?$`; `:18-23` regex trên `notes` để
  lấy uuid phiếu forfeit.
- `:27-29` `IF NOT v_is_move_out AND NOT v_is_forfeit THEN RETURN NEW;` — **bỏ qua toàn bộ kiểm tra**.
- `:38-42` `RAISE 55000` nếu khớp mà không phải core writer.
- `:67-105` đòi JOIN `app_private.termination_move_out_writer_context` theo
  `txid_current() + pg_backend_pid()`, `NEW.payment_date = context_row.move_out_date`,
  `NEW.amount <= invoice remaining`.
- `:148-151` zero hoá `received/credit/change/rounding`.
- Chuỗi note sinh ở `terminate_contract_move_out_impl:148`; context mở/đóng ở
  `terminate_contract_move_out:139-152` và `:172-174`.

⇒ **Ràng buộc cứng cho Task 2 Step 4:** **KHÔNG được đổi chuỗi note** `'Quyết toán khi thanh lý
DD/MM/YYYY'`, **KHÔNG được tạo `payments` ngoài cửa sổ context**, và phải **giữ nguyên thứ tự mở/đóng
context**. Nếu buộc phải đổi thì phải redefine `app_private.classify_termination_payment_v1` **trong
cùng migration**. Emitter đổi note mà quên guard ⇒ guard rơi vào `RETURN NEW` (không kiểm gì) hoặc ném
`55000`.

### 1.6 Bốn hàng rào của Đợt 0–6 mà bản 29/07 không biết

Chi tiết ở `state-of-world §4` và `danh-gia v2 §6.2`; **không lặp lại ở đây**, nhưng **không được bỏ**:

| Hàng rào | Điều Plan 2 phải làm | Nguồn |
|---|---|---|
| **`purpose` là kill switch, không phải metadata** — `app_private.ie_transition_authorization` có **PK trên `income_expense_id` một mình**; trigger `a00_ie_transition_token_upsert` **ghi lại `purpose` mỗi lần INSERT**; cầu `a85`/`a85b` chỉ skip khi có token `purpose='FINANCE_V2_LIFECYCLE'` đúng xid. Cầu **đang bật** (`income_expense.posting.v2` `mode='ON'`) | One-shot token `TERMINATION_REFUND_FINALIZE` **không được** đi vay cột `purpose`. Dùng `app_private.ie_flex_writer_xids` + `begin/end_ie_flex_write_v1` (CHECK scope đã đặt chỗ `'FLEX_EDIT'` nhưng thân guard chưa hiện thực — đó là móc treo), **hoặc** tự stamp `FINANCE_V2_LIFECYCLE` và tự quản vòng đời token. Nếu để cầu còn vũ trang đúng lúc `approval_status → APPROVED` mà voucher đã có `account_id` + `total_amount>0` + sổ thật ⇒ `a85` **tự mint posting `source_kind='LEGACY_BRIDGE'`** ⇒ **posting tiền trùng**, và assert của Task 5 Step 5 thấy `LEGACY_BRIDGE` thay vì `TERMINATION_REFUND` | `danh-gia v2 §6.2` inv.1, `E2` |
| **`dispatch_finance_decision_v2` route theo `adapter_name` qua `CASE` NĂM nhánh đóng** `{INVOICE_REFUND, PROFIT_PAYOUT, TERMINATION_FORFEIT_PAIR, TERMINATION_MOVE_OUT_PAIR, SALARY_BUNDLE}`, `ELSE → 0A000`. Lỗi **đã hiện thực hoá trên prod** cho `CANONICAL_INCOME_EXPENSE` và `UTILITY_RECURRING` | Task 1 Step 5 phải **hoặc** reuse một `adapter_name` đã nối, **hoặc** thêm nhánh CASE. Test "unknown owner fail closed" chạy đường `42501` và **không bao giờ** chạm `0A000` ⇒ phải có test riêng cho `0A000` | `danh-gia v2 §6.2` inv.2, `E8` |
| **Ba lớp khoá kỳ**: chốt sổ quỹ (trigger vô điều kiện `[CASHBOOK_CLOSED]`), bàn giao tiền mặt (**7 phiên đang hiệu lực**), **chốt lợi nhuận tháng** (`a02_ie_profit_lock_*`, **18 toà đã chốt 05/2026**). `finance_v2_is_cashbook_period_open` **chỉ đọc `accounts.lock_date`** và **0/28 account có `lock_date`** ⇒ hôm nay là **no-op tuyệt đối** | Dùng `app_private.cashbook_closed_through_v1` cho pre-check trước-khi-có-voucher và `app_private.assert_period_open_for_edit_v1` khi đã có voucher; phát **ba code có nhãn** `[CASHBOOK_CLOSED]` / `[HANDOVER_LOCKED]` / `[PROFIT_LOCKED]`. Nhánh "kỳ sổ quỹ đã đóng" **chỉ kiểm được bằng fixture**; nhánh chốt lợi nhuận **có dữ liệu thật** | `state-of-world §4.6`, `E4` |
| **`DO $guard$` của `20260730280000`** quét toàn schema và tự `RAISE` nếu còn hàm public khai `STABLE/IMMUTABLE` mà chạm khoá dòng. `app_private.authorize_tenant_action_v3` có `SELECT … FOR SHARE` | **Mọi read RPC của Plan 2 khai VOLATILE.** Khai `STABLE` = vừa ném `25006` qua PostgREST vừa **abort migration** | `danh-gia v2 §6.2` inv.4 |
| **Mẫu neo (`C-INFRA-1`)**: Đợt 0–6 vá nhiều hàm dùng chung bằng `pg_get_functiondef → position(neo) → replace → EXECUTE`, tự `RAISE 'DỪNG, không vá mù'` khi mất neo | **Step 0′ trước MỌI `CREATE OR REPLACE`** — xem Task 2 Step 0′. Danh sách hàm có neo: `danh-gia v2 §8.3` | `C-INFRA-1` |
| **`claim_feature_operation_v1` ném `23505` khi replay y hệt** (INSERT trần vào bảng có `UNIQUE (feature_key, config_version, operation_key)`); và vì `config_version` nằm trong khoá unique, **bump version giữa hai lần replay xoá sạch bảo vệ** | Luật thứ tự: **LOOKUP bảng idempotency của chính Plan 2 TRƯỚC; hit thì trả voucher/posting cũ và KHÔNG gọi `claim_feature_operation_v1`.** Không bao giờ dùng `server_feature_flag_operations` làm idempotency | `C-ROLL-6` |
| **Hai terminal writer ship sau ngày viết plan**: `public.cancel_income_expense_flex_v1` (`20260730140000:119`, **GRANT `authenticated`** — đường huỷ mặc định của `/thu-chi` sau Đợt 5) và `public.reverse_invoice_collection_v5` (`20260730150000:460`). `app_private.cancel_collection_voucher_in_place_v1` là private helper (`postgres=X`) — **không nợ coverage** | Task 1 Step 5 phải chứng minh cả hai **fail-closed** trên phiếu hoàn flow-owned (`assert_manual_voucher_v1` ném `[NOT_MANUAL]` khi `system_source IS NOT NULL` — đây là fail-closed **mong muốn** và **phải assert**), và **nâng trigger backstop AFTER UPDATE từ "backstop" lên "cơ chế chính"** để release obligation | `E10`, `[X6.7]` |
| **Cả hai org đang ở flexible mode** (`org_accounting_mode`: `aaaa` id=1, `dddd` id=4, cả hai `strict_mode=false`) ⇒ đường flex-cancel của Đợt 4/5 **đang sống trên production**, không ngủ | Không giả định đường đó dormant | `C-INFRA-4` |

### 1.7 Evidence: chữ "hash" hiện là bảo vệ giả (ADD — `C-EV-1`)

`public.finance_evidence_objects` = **159 dòng** (142 `ATTACHED`, 11 `FINALIZED`, 6 `UPLOAD_INTENT`);
**0/159 có `sha256`**, **0/159 có `upload_token_hash`**. `finalize_finance_evidence_v2` chỉ
`UPDATE … SET state='FINALIZED', finalized_at=now(), byte_size=…, mime_type=…` — **không đụng
`sha256`**. ⇒ Mọi guard so *"cùng hash evidence"* đang so **NULL với NULL**, luôn thoả.

Task 5 Step 4 phải chọn **một** và ghi vào plan: **(A)** mở rộng `finalize_finance_evidence_v2` để ghi
`sha256` thật, **hoặc (B)** định nghĩa lại fingerprint = `(organization_id, bucket_id, object_name,
byte_size, mime_type)` và **bỏ hẳn chữ "hash"** khỏi mọi câu về evidence. Không được để nguyên chữ
"hash".

### 1.8 Bảng nghe realtime thiếu (ADD — `B25`, `[A0.R6]`)

`contract_terminations` và `contract_transfers` **KHÔNG nằm trong publication `supabase_realtime`**
(21 rel, `puballtables=false`; publication hiện chỉ có `contracts`, `income_expenses`,
`income_expense_items` cho nhóm này) ⇒ đổi trạng thái thanh lý **không** invalidate deposit dashboard ở
session khác. `useDepositDashboard` **đã** cap-1000-safe (`:239-261` `fetchAllRows`) và **đã** được wire
`["deposit-dashboard"]` dưới cả `income_expenses` (`:127`) và `contracts` (`:170`) ⇒ phần chunking của
plan là **additive, không corrective**.

⇒ Task 7 Step 2 **không thể chỉ sửa TypeScript**: cần một migration `ALTER PUBLICATION` +
kiểm `REPLICA IDENTITY` (§2.1, file mới `20260731032200`).

---

## 2. File map và migration order

### 2.1 Database migrations

**Luật đánh số (`E12`, `danh-gia v2 §8`):** mọi migration mới phải sort **SAU** file đã apply cuối cùng
(`20260730280000_stable_fn_row_lock_regression.sql`), tức thuộc dải **`20260731xxxxxx`**. Luật này chữa
đồng thời hai lỗi: (a) **đụng tên trực diện** — `20260730160000` **đã bị chiếm** bởi
`20260730160000_cashbook_closing_permissions.sql` (**tracked, đã apply prod, commit `07ddfca`**); (b)
**hiểm hoạ thứ tự replay** — chín slot còn lại của bản 29/07 back-date **trước** khối Đợt 0–6
(`20260730100000 → 20260730280000`, 24 migration đã lên prod), nên khi rebuild clone chúng bị khối đó
ghi đè, làm clone **không phản ánh production**.

Thêm một bước preflight: **fail nếu timestamp mới trùng bất kỳ file đã có** trong `supabase/migrations/`.
Và nhớ: `supabase_migrations.schema_migrations` **đã chết** (`max_version='20260716170000'`) ⇒ **"vắng sổ"
≠ "chưa apply"**; mọi kiểm tra phải dùng **catalog** (`pg_proc`/`pg_class`/`pg_trigger`/`pg_constraint`)
(`C-INFRA-12`).

**Ánh xạ tên cũ → tên mới:**

| Bản 29/07 | Bản v2 | Ghi chú |
|---|---|---|
| `20260730000000_special_page_runtime.sql` | `20260731010000_special_page_runtime.sql` | **Tiền đề Plan 1**, không thuộc Plan 2 |
| `20260730000500_contract_transfer_audit_hardening.sql` | `20260731010500_contract_transfer_audit_hardening.sql` | Task 0 |
| `20260730001000_room_residence_segments.sql` | `20260731011000_room_residence_segments.sql` | Task 0 |
| `20260730160000_termination_settlement_snapshot.sql` | `20260731030000_termination_settlement_snapshot.sql` | **ĐỤNG TÊN** — bắt buộc đổi |
| `20260730161000_termination_refund_obligations.sql` | `20260731031000_termination_refund_obligations.sql` | Task 1 |
| `20260730161500_termination_writer_canonicalization.sql` | `20260731031500_termination_writer_canonicalization.sql` | Task 2 |
| `20260730162000_termination_refund_read_rpcs.sql` | `20260731032000_termination_refund_read_rpcs.sql` | Task 4 (**+ `get_refund_forfeit_summary`**) |
| — | **`20260731032200_realtime_termination_tables.sql`** | **THÊM MỚI** (§1.8) — `ALTER PUBLICATION supabase_realtime ADD TABLE public.contract_terminations` (+ `contract_transfers`), kiểm `REPLICA IDENTITY`, theo đúng mẫu `20260730230000_realtime_money_tables.sql` |
| `20260730162500_room_lifecycle_read_rpc.sql` | `20260731032500_room_lifecycle_read_rpc.sql` | Task 6 |
| `20260730163000_termination_lifecycle_backfill.sql` | `20260731033000_termination_lifecycle_backfill.sql` | Task 3 |
| `20260730164000_termination_refund_special_writer.sql` | `20260731034000_termination_refund_special_writer.sql` | Task 5 |

So với `danh-gia v2 §8.1` (16 file cho cả hai plan), Plan 2 v2 **thêm đúng một file** → **17**.

**Thứ tự triển khai (không đổi timestamp sau khi một migration đã apply):**

0. **Tiền đề Plan 1 (Slice 1):** `20260731010000_special_page_runtime.sql` — shared actor/context,
   source-aware posting core, timezone (`org_today_v1`), caps và provenance. **Phải tồn tại trước mọi
   termination writer/posting adapter.** Slice −1 dùng dải **trước** khối này
   (`20260731000000 → 20260731002500`).
1. `20260731010500_contract_transfer_audit_hardening.sql` — redefinition fail-closed của `transfer_room`
   **và xử lý đường B `apply_contract_transfer`**, composite tenant guards; không backfill tiền.
2. `20260731011000_room_residence_segments.sql` — read-only segment projection/conflict diagnostics
   (Plan 1 dùng cho broker building-at-signing).
3. `20260731030000_termination_settlement_snapshot.sql` — inert settlement snapshot schema/helpers.
4. `20260731031000_termination_refund_obligations.sql` — obligation/conflict ledger, sticky subject
   registry, state guards, **flow adapter + 5 named wrapper**, **guard trigger trên
   `contract_terminations`**, voucher/item freeze contract; seed cả birth/submit routes ở `OFF` trước
   khi writer tồn tại.
5. `20260731031500_termination_writer_canonicalization.sql` — gated rewire của **ba** termination writer
   sau khi snapshot + obligation primitives đã tồn tại; chỉ assert route, không tự enable.
6. `20260731032000_termination_refund_read_rpcs.sql` — authorized queue, preview, `/deposits` status read
   RPCs **và forward-redefine `get_refund_forfeit_summary`**; không có submit.
7. `20260731032200_realtime_termination_tables.sql` — publication + replica identity.
8. `20260731032500_room_lifecycle_read_rpc.sql` — authorized lifecycle JSON read model.
9. `20260731033000_termination_lifecycle_backfill.sql` — safe legacy matching, conflict/baseline report;
   không sửa amount/status legacy.
10. `20260731034000_termination_refund_special_writer.sql` — exact writer/reversal only; assert submit
    route còn `OFF`, không tự enable.

**Hai file untracked phải xử lý TRƯỚC khi viết bất kỳ migration nào** (`C-INFRA-2`, `C-INFRA-3`, chi
tiết ở `danh-gia v2 §8.2`): `20260730230000_annotate_evidence_protection.sql` (556 dòng, chưa apply,
`:289` là `CREATE OR REPLACE FUNCTION public.annotate_income_expense_v1(...)` **trần** ⇒ apply sau
`20260730270000` sẽ **xoá sạch lớp bảo vệ bằng chứng**) và `20260730240000_authz_remaining.sql` ("WP2",
chưa apply, mở rộng vị ngữ kỳ sang **kỳ dịch vụ của hạng mục** và **viết lại
`reverse_invoice_collection_v5` theo mẫu neo**). **Phải hỏi chủ trước khi apply hoặc đổi tên.**

### 2.2 Domain, hooks và UI

- Create `src/lib/roomLifecycle.ts`, `src/lib/__tests__/roomLifecycle.test.ts`,
  `src/lib/__tests__/roomLifecycle.property.test.ts`.
- Create `src/hooks/useRoomCashLifecycle.ts`, `src/hooks/useTerminationRefundQueue.ts`,
  `src/lib/terminationRefundStatuses.ts`, `src/lib/__tests__/terminationRefundStatuses.test.ts`.
- Modify `src/hooks/useDepositDashboard.ts` (**gồm `useRefundForfeitSummary` ở `:60-77`**),
  `src/pages/deposits/DepositsPage.tsx`, `src/hooks/contracts/useContractDetailData.ts` (**gồm
  `useContractPendingTermination` `:52-73` và `useContractTerminationInfo` `:97-100`**),
  `src/components/contracts/detail/ContractSummary.tsx`. `/deposits` và contract detail phải đọc
  canonical obligation + active posting; **không** đọc `refund_amount`/`COMPLETED`/`refund_date` để kết
  luận đã hoàn. Generated net chỉ gắn nhãn historical settlement.
- Create `src/components/thu-tien/room-lifecycle/RoomLifecyclePanel.tsx`, `LifecycleTimeline.tsx`,
  `LifecycleEventDrawer.tsx`, `MonthlyCashflowTable.tsx`, `RefundQueuePanel.tsx`,
  `RefundPaymentDialog.tsx`, `TerminationRefundCorrectionDialog.tsx`, `lifecycleFormatters.ts`.
- **RETARGET — hai bề mặt, hai file, hai cổng quyền** (thay câu 29/07 *"Modify `src/pages/ThuTien.tsx`"*):

  | Entry mới | Mount ở đâu | Cổng route | Vì sao |
  |---|---|---|---|
  | **`Hoàn cọc`** (queue + dialog) | **`src/pages/ThanhToan.tsx`** qua registry `FEE_CATEGORIES` → render bởi `PeriodFeePanel.tsx` / `PeriodFeeSheet.tsx` | **`thu_tien.collect`** (`App.tsx:367`) | Đây là **hành động tiền**; submit đòi `thu_tien.collect` + CUSTODIAN dù sao. `FEE_CATEGORIES` **chỉ** render trong hai component đó, tức **sau** `collect` |
  | **`Chu trình phòng`** (read model) | **`src/pages/ThuTien.tsx`** như một panel theo phòng, **KHÔNG** vào `FEE_CATEGORIES` | **`thu_tien.view`** (`App.tsx:363`) | Read-only; nhét vào registry sẽ **chôn nó sau `collect`** |

  `src/pages/ThuTien.tsx` (406 dòng) **không còn** `PeriodFeePanel/PeriodFeeSheet/usePeriodFees/
  useUtilityBills/useCommissionVoucher/useMaintenanceBatch`; `:258-259` chỉ `navigate('/thanh-toan')`.
  Nó **không** là trang read-only (mount `CollectDrawer` ở `:376`) nhưng route gate của nó là
  `thu_tien.view`.

  **DELETE lời hứa "view-only manager thấy hàng đợi Hoàn cọc".** §3.3 đặt sàn đọc queue ở
  `thu_tien.view`; sau retarget, **bề mặt duy nhất** của queue nằm sau `thu_tien.collect`. Giữ sàn RPC ở
  `thu_tien.view` (để preview và một card read-only trên `/thu-tien` còn khả thi về sau) nhưng **ghi rõ**:
  test *"user chỉ có `thu_tien.view` đọc được queue"* phải viết **ở tầng RPC**, không phải ở tầng UI, và
  plan **không** hứa họ tới được nút Hoàn cọc.

- **DEAD CODE — không sửa:** `src/components/thu-tien/UtilityDesktopPanel.tsx` và `UtilityBillSheet.tsx`
  có **0 importer** trong `src/` và `.e2e-fleet/` (~36 KB). Bề mặt EN thật là `UtilityEnContent.tsx`
  (import duy nhất `PeriodFeePanel.tsx:37`, render `:503-505`) và khối EN inline của `PeriodFeeSheet.tsx`.
- Modify `src/lib/feeCategories.ts`, `src/lib/feeCategories.test.ts`, `src/components/thu-tien/feeIcons.tsx`,
  `src/components/thu-tien/PeriodFeePanel.tsx`, `src/components/thu-tien/PeriodFeeSheet.tsx`,
  `src/hooks/useRealtimeDataSync.ts`, `src/hooks/__tests__/useRealtimeDataSync.test.ts`,
  `src/components/income-expenses/IncomeExpenseForm.tsx`, `src/hooks/income-expenses/mutations.ts`,
  `src/hooks/income-expenses/financeV2Mutations.ts`, `src/hooks/income-expenses/statusMutations.ts`,
  `src/lib/voucherSources.ts`.
- **ADD vào file map — SQL:** `public.decide_owned_income_expense_v2`,
  `app_private.reserve_invoice_refund_obligation_v2`, `public.get_refund_forfeit_summary` (§3.6, §1.4).
- **ADD — `useRealtimeDataSync.test.ts` là viết lại 3 assertion, không phải nới lỏng** (`C-INFRA-8`):
  `:252-267` `toEqual([11 tên đúng thứ tự])`; `:437-446` `toEqual([8 root])` + `:456
  toHaveBeenCalledTimes(8)`; ma trận `it.each` `:117-143`/`:271-281`. **KHÔNG nới `toEqual` thành
  `toContain`.** Giới hạn harness: `type RealtimeHandler = () => void`, `triggerTable` gọi **không tham
  số**, `vi.mock("react")` chỉ cấp `useEffect`.
- Regenerate `src/integrations/supabase/types.ts` **chỉ sau khi** migrations đã apply, bằng
  `npm run gen:types` **không redirect** (generator tự atomic-write vào
  `src/integrations/supabase/types.ts` và tự chèn header). ⚠ Hiện có **drift sẵn ~92 quan hệ**
  (`network_*`, gồm 65 phân mảnh ngày tự sinh) — xử riêng, **đừng gộp** vào PR tính năng.

### 2.3 Test và audit artifacts

- Create `scripts/test-contract-transfer-segments.mjs`, `scripts/test-termination-obligations.mjs`,
  `scripts/test-termination-refund-reads.mjs`, `scripts/test-termination-refund-special-page.mjs`,
  `scripts/test-room-lifecycle.mjs`, `scripts/audit-room-lifecycle-rollout.mjs`, plus
  `src/hooks/__tests__/terminationRefundRouting.test.ts`.
  **Cả sáu script này CHƯA tồn tại** — không được viết chúng vào gate như thể đã có
  (`state-of-world §8.2`).
- Create `.e2e-fleet/specs/room-lifecycle.spec.ts`, `.e2e-fleet/specs/termination-refund-special-page.spec.ts`,
  `.e2e-fleet/specs/deposit-refund-status.spec.ts` **sau deploy**.
- **SỬA câu 29/07 *"Không thêm testing-library/jsdom vì repo hiện không có harness đó"***: tiền đề đúng,
  kết luận sai. Repo **đã có** harness render trong environment `node` — `renderToStaticMarkup`, **15
  file** dùng, mẫu chuẩn `BuildingFilterSelect.test.tsx:19-27`. ⇒ Đẩy invariant render (nhãn "Đã hoàn",
  "Khách còn nợ", disabled amount field) về **unit test**; Playwright chỉ cho luồng đa bước + upload
  thật. **Không** thêm jsdom.
- **ADD — vùng mù typecheck** (`C-INFRA-9`): `.e2e-fleet` **không có `package.json`, không có
  `tsconfig.json`** ⇒ 3 spec mới nhận **zero** type checking trong khi `npm run typecheck:baseline` báo
  xanh. Chọn: thêm `.e2e-fleet/tsconfig.json` + script `typecheck:e2e`, **hoặc** ghi thẳng vào plan rằng
  lỗi type của spec chỉ lộ ở runtime.
- **ADD — có 2 test `BuildingFilterSelect` đang ĐỎ sẵn** trên nhánh này; chưa biết chúng có đỏ trên
  `origin/main` (`31425d3`) hay không. Gate *"vitest xanh mới apply"* phải viết theo **file cụ thể**, không
  phải `npx vitest run` toàn repo, kẻo rollout tắc hoặc implementer học cách bỏ qua gate.

---

## 3. Contracts dùng chung

### 3.1 Obligation state machine

```text
PENDING  --post exact--> POSTED --reverse--> REVERSED
PENDING  --cancel-----> RELEASED
CONFLICT --owner resolves/releases--> RELEASED
RELEASED/REVERSED --owner creates audited replacement--> PENDING(new row)
```

Partial unique active predicate phải giống **nguyên văn** trong DDL, selectors và tests:

```sql
WHERE state IN ('PENDING', 'POSTED', 'CONFLICT')
```

`CONFLICT` cố ý nằm trong active predicate để ambiguity chưa xử lý không thể bị một PENDING mới che mất;
owner phải ghi resolution rồi transition conflict sang `RELEASED`. `RELEASED` và `REVERSED` không chặn
replacement. Canonical voucher id vẫn unique toàn lịch sử; replacement dùng voucher mới và
`replacement_of_id`.

**ADD — release phải có đường máy, không chỉ đường người** (`E10`): vì mặt cắt huỷ nhận **4 migration
trong một ngày**, cơ chế chuyển `PENDING → RELEASED` khi voucher bị terminal hoá **phải là trigger
`AFTER UPDATE` trên `income_expenses`** (cơ chế **chính**), còn lời gọi tường minh trong từng wrapper là
lớp thứ hai. Danh sách terminal writer phải phủ và kết quả mong đợi: xem §1.6 dòng cuối.

### 3.2 Global transaction/lock order

Mọi submit, traditional adapter decision, cancel và reverse dùng **đúng** thứ tự của Plan 1, **cộng
bước 0 mới**:

```text
0. LOOKUP idempotency record của Plan 2  ← MỚI (C-ROLL-6). Hit ⇒ trả voucher/posting cũ, KHÔNG claim
1. organization authorization lock (app_private.lock_org_for_decision_v1)
2. canonical idempotency operation (và safety buckets nếu có)
3. obligation/domain rows, sorted by stable ids
4. voucher header + items
5. cashbook
6. evidence
7. Finance posting/reversal + state transition
```

Không function nào được lock cashbook trong shared context rồi quay lại lock voucher. Reversal phải lấy
obligation/voucher locks trước, sau đó mới gọi Finance V2 reversal.

**ADD:** nếu dùng chung `server_feature_flag_operations` để đếm cap thì **thêm vị ngữ
`organization_id`** — bộ đếm hiện **không lọc org, không lọc ngày** (`C-ROLL-5`).

### 3.3 SECURITY DEFINER read contract

Mọi read RPC revoke public/anon, bound input và authorize **theo consumer permission**, không dùng một
key chung:

- `REVOKE ALL ... FROM PUBLIC, anon`; chỉ `GRANT EXECUTE ... TO authenticated`.
- **Khai VOLATILE** (mặc định). Khai `STABLE` ⇒ `25006` qua PostgREST **và** abort migration vì
  `DO $guard$` của `20260730280000` (§1.6).
- Resolve every requested room/building/termination to exactly one organization; reject mixed/cross-org
  scope.
- Queue/lifecycle require `thu_tien.view` cho từng building. Preview require `thu_tien.view`; chỉ
  `canSubmit=true` khi có `thu_tien.collect` trên building + cashbook. Submit bắt buộc `thu_tien.collect`.
  **Ghi kèm ràng buộc mount ở §2.2** (bề mặt queue nằm sau `collect`).
- Deposit-status RPC require `deposits.view` cho từng termination building.
- **ADD — baseline authz của `/deposits` hôm nay và đây là đổi quyền HAI CHIỀU** (`C-DEP-10`): các dòng
  đó hiện đến từ một **table SELECT thuần** được cho phép bởi `pg_policies.contract_terminations_select_rbac`,
  `qual = can_access_building(building_of_contract(contract_id))`, trong đó `can_access_building` =
  `is_super_admin() OR can_v3('buildings.view', _building_id)` và `building_of_contract` join
  `contracts c JOIN rooms r ON r.id = c.room_id` — tức **`buildings.view`, resolve qua PHÒNG HIỆN TẠI**.
  Chuyển sang RPC gác `deposits.view` **vừa thêm vừa mất** dòng cho thành viên thật. **Bắt buộc hai
  fixture mới**: (i) thành viên có `buildings.view` mà **không** có `deposits.view` trên toà — **mất**
  dòng đang thấy; (ii) ngược lại — **được thêm** dòng.
- **ADD — `deposits.refund` tồn tại, active, chưa dùng** (`C-DEP-9`): `permission_definitions`
  `key='deposits.refund'`, `resource='deposits'`, `action='refund'`, `is_active=true`,
  `scope_kinds={ORGANIZATION,AREA,BUILDING}`. Plan **phải nói rõ vì sao** nó không phải cổng của hành
  động hoàn cọc (chủ có thể đã cấp/khoá nó cho kế toán), **hoặc dùng nó**. Không được im lặng bỏ qua.
  Nếu dùng, nó phải vào `check-permission-catalog.mjs`.
- Contract-detail status RPC riêng chỉ nhận một contract id, trả minimum canonical obligation/posting
  status và require `contracts.view` trên building của contract; không tái dùng `deposits.view`, không
  expose queue/all-tenant data.
- Superadmin bypass chỉ server-side, vẫn audit actual `auth.uid()`. **ADD:** `is_super_admin()` **bỏ qua
  `super_admins.organization_id`** và được GRANT cho `anon` (`[A3.R1]`) ⇒ câu *"mọi bypass chỉ trong
  public special-page RPC"* là **sai hiện trạng**; viết lại ở thể mô tả đúng, kẻo test
  *"superadmin không có bypass"* đỏ khi chạy qua RLS.
- Normal non-superadmin owner/manager submit phải có exact CUSTODIAN binding. Mọi superadmin
  special-page action có thể dùng audited `special_page_cashbook_override_v1` (**BLOCKED-BY Plan 1 Task
  5** — hàm chưa tồn tại): kiểm account thật/cùng org/open period, token
  `authority_mode='SUPERADMIN_CROSS_ORG'`, không bỏ tenant/cashbook checks, vẫn ưu tiên regular
  membership làm provenance.
- **ADD — actor resolution:** shared context **luôn** gọi overload org-scoped
  `app_private.resolve_finance_actor_v2(p_organization_id)`. Bản **no-arg** ném
  `42501 'ambiguous membership'` cho đúng superadmin duy nhất, **chỉ vì** user đó có 2 membership
  thường (`A-ACTOR`). Thêm fixture actor 2-org.
- Bound input: 1–50 buildings, date range tối đa 24 tháng, pagination/limit tối đa 500; null/empty/
  malformed trả `22023`.

### 3.4 Sticky canonical-subject routing

Feature mode chỉ quyết định **lần sinh đầu tiên** của một termination chưa có canonical marker. Khi
stored `CANARY`/`ON` đã evaluate thành `CANONICAL` và tạo
`termination_refund_subject_routes(organization_id, termination_id, route_kind='CANONICAL_OBLIGATION',
birth_config_version, source_hash)`, mọi retry, approval-writer call và correction của chính termination
đó phải vào canonical emitter/adapter **trước khi** đọc global route. `OFF`/`SHADOW` sau rollback chỉ trả
writer legacy cho subject **chưa có marker**; nó không bao giờ được tạo legacy refund cạnh
snapshot/obligation đã tồn tại. `FROZEN` vẫn chặn birth/correction mới, nhưng read, traditional decision
hợp lệ và reversal của tiền đã ghi phải còn hoạt động. Marker insert-only, cùng transaction với
snapshot/voucher/obligation và được khoá theo termination.

**ADD ba luật cứng:**

1. **`evaluate_feature_route` chỉ được gọi ĐÚNG MỘT LẦN mỗi transaction** (`C-ROLL-5`). Nó dùng
   `clock_timestamp()` (không stable theo transaction) nên hai lần evaluate có thể vắt qua
   `starts_at`/`ends_at` (`CANONICAL` rồi `FROZEN`); `claim_feature_operation_v1` lấy `clock_timestamp()`
   **riêng của nó** sau advisory lock. ⇒ Snapshot `(evaluated, stored mode, config_version)` vào biến
   **và vào marker**, rồi dùng lại. Thêm: `IF f.mode='ON' THEN RETURN 'CANONICAL'` nằm **trước** cả khối
   window ⇒ `ends_at` **không** là van tự hết hạn sau ON.
2. **Kiểm "route đã seed và vẫn OFF" phải đọc bảng, không được suy từ evaluator.**
   `app_private.evaluate_feature_route` dòng 14: `IF NOT FOUND THEN RETURN 'LEGACY'` ⇒ key sai chính tả
   hoặc chưa seed trả `LEGACY` (chạy nhánh cũ) chứ **không** fail-closed. Dùng
   `SELECT mode, force_freeze, config_version FROM app_private.server_feature_flags WHERE feature_key = …
   FOR UPDATE` và **abort nếu `NOT FOUND`**. Thêm một `EXISTS` **runtime** trong writer, vì assert ở
   deploy-time không chặn được một dòng bị DELETE lúc runtime (`[A2.C1]`, residual LOW).
3. **`server_feature_flags` KHÔNG có `organization_id`** (PK = `feature_key`) ⇒ *"prod stored OFF + DEMO
   stored CANARY"* là **bất khả**. Phân biệt org chỉ xảy ra **sau** khi `mode` đã `CANARY` toàn cục, qua
   `server_feature_flag_canary_orgs`. Và flip `SHADOW→CANARY` đẩy org thật từ SHADOW về **LEGACY** ⇒
   **mất telemetry parity đúng lúc cần nó nhất** (tiền lệ: `invoice.collection.v5` chỉ có **85 phút** cửa
   sổ shadow). ⇒ Viết mọi câu rollout theo cặp **stored-vs-evaluated**, và **thu đủ parity report TRƯỚC
   khi rời SHADOW** (`C-ROLL-2`).

### 3.5 Hợp đồng đông cứng: allowlist và ANNOTATE (mới — hai điều làm Task 1 Step 6 bản 29/07 bất khả thi)

**(a) Trật tự "owned tại birth rồi finalize account/date bằng one-shot token" KHÔNG chạy được.**
`app_private.guard_income_expense_owned_payload` (trigger `a00_ie_owned_payload_freeze BEFORE DELETE OR
UPDATE ON public.income_expenses`) có allowlist **không chứa `account_id` và không chứa `voucher_date`**
(allowlist `:59-79`; cửa ANNOTATE `:29-43` cũng không có), và nhánh ANNOTATE **chỉ** cho
`attachments`/`notes`/`updated_at`. Bằng chứng đây không phải suy diễn: `pay_draft_fee_voucher:36-39`
(ghi `account_id`) **fail dù có token** — đó là lý do 8 draft E2E DEMO không trả được; và
`approve_and_post_income_expense_v2` cũng **stamp `account_id`** lên header sau khi post, tức đã có
`55000` tiềm ẩn **độc lập với hai plan**.

⇒ Task 1 Step 6 phải chọn **một trong hai**, và viết vào plan:

- **(A) Mở rộng allowlist tường minh** — thêm `account_id`, `voucher_date` vào allowlist **chỉ dưới một
  token có scope**, tức phải **sửa thân guard** trong `20260731031000`, không được "giả định token là
  đủ"; hoặc
- **(B) Đổi trật tự birth** — set `account_id`/`voucher_date` **trước** khi register ownership. Nhưng
  §0.2 nói manager chọn sổ **lúc submit**, sau birth ⇒ nhánh (B) chỉ khả thi nếu birth ghi một sổ
  placeholder rồi submit **thay** sổ, mà điều đó lại đụng đúng allowlist. **Vì vậy (A) là nhánh mặc
  định**, và (B) chỉ được chọn nếu chủ đồng ý đổi trải nghiệm.

Không có nhánh thứ ba. `app_private.guard_income_expense_owned_items` thì **đóng băng tuyệt đối**, không
allowlist: mọi INSERT/UPDATE/DELETE trên items của phiếu flow-owned ném
`'items of canonical income expense % are frozen'` `55000` — điều này **đúng ý plan**, giữ nguyên.

**(b) ANNOTATE là một carve-out HỢP PHÁP của chủ, xung đột trực diện với "freeze attachments".**
Đợt 2 đã ship: nhánh ANNOTATE của guard fire cho **MỌI `flow_kind`** (comment trong thân hàm tự nói
vậy) và trả `NEW` khi **chỉ** `attachments`/`notes`/`updated_at` đổi; `'notes'` còn nằm trong allowlist
token. `public.annotate_income_expense_v1` là **DEFINER**, **GRANT `authenticated`**, và **không đọc**
`income_expense_flow_ownership`. Theo `20260730270000:24-91`, **chỉ** việc **XOÁ** file đính kèm và
**REPLACE** notes trên phiếu `POSTED` mới bị gác bởi chủ ⇒ **một kế toán VẪN dán được ảnh chứng từ vào
phiếu hoàn cọc system-owned đã POSTED**.

Bản 29/07 `:168` đòi freeze `attachments` và hash header. Hai việc đó **không thể cùng đúng với quyết
định số 8 của chủ**. Plan phải chọn **một**:

- **(A) Loại `attachments`/`notes` khỏi bộ đông cứng VÀ khỏi header hash** — hash chỉ phủ
  `{organization_id, building_id, room_id, contract_id, name, type, total_amount, voucher_kind,
  system_source, items(ordered)}`; hoặc
- **(B) Xin chủ carve-out tường minh** cho flow-owned refund voucher khỏi quyết định số 8.

**Hiện plan không làm gì cả** — đó là khuyết tật phải sửa, không phải chi tiết bỏ qua được. Dù chọn
đường nào, **bắt buộc có test** "ANNOTATE trên phiếu hoàn POSTED" (`danh-gia v2 §9`).

**(c) Hàng nguồn cần guard RIÊNG.** Vì §1.3, `20260731031000` phải thêm một guard trigger
`BEFORE UPDATE ON public.contract_terminations`: sau khi đã có snapshot/marker canonical, **cấm** sửa
`outstanding_debt` / `total_deposit` / `prorated_*` / `*_fee` / `other_fees` / `status`, trừ khi có token
của emitter/correction RPC. Nếu Slice −1.9 đã REVOKE UPDATE khỏi `authenticated` thì guard này là lớp
thứ hai (giữ, không bỏ).

### 3.6 Cấm dùng lại reservation, và phải xử lý `decide_owned_income_expense_v2` (mới)

**(a) `invoice_refund_reservations` không dùng được cho hoàn cọc** — giữ kết luận 29/07, có bằng chứng:
`invoice_id` là `NOT NULL`; `reserve_invoice_refund_obligation_v2:38-41` `SELECT … FROM public.invoices …
FOR UPDATE` + `IF NOT FOUND THEN RAISE P0002`; `:42` `v_refundable := COALESCE(v_inv.paid_amount,0)`;
`:49-52` `IF v_live + p_amount > v_refundable THEN RAISE 55000`.

**(b) ADD — `public.decide_owned_income_expense_v2` là một cái bẫy đang sống, phải vào file map.**
Hàm này **GRANT EXECUTE cho `authenticated`**; chỉ nhận `approve|cancel` (khác → `22023`); whitelist
`flow IN ('INVOICE_REFUND','TERMINATION_REFUND')` (khác → `42501` fail-closed); và **nhánh `cancel`
BẮT BUỘC** có một dòng `app_private.invoice_refund_reservations` với `reservation_state='HELD'` trỏ đúng
`refund_voucher_id`, không có thì ném **`P0002`**. Nó còn từ chối khi `birth_txid =
pg_current_xact_id()`.

⇒ Một phiếu hoàn của Plan 2 **chỉ mang obligation ledger mới** (không có dòng HELD) sẽ **KHÔNG HUỶ ĐƯỢC
qua UI đã ship**: `statusMutations.ts:315-330` và `:352-367` bắt lỗi *"owned by system flow"* rồi rơi
xuống đúng RPC này, và `P0002` hiện ra dưới dạng toast rồi rethrow. Câu §0.2 *"không gọi
`decide_owned_income_expense_v2` dưới danh nghĩa manager"* là chỉ thị cho writer của plan — nó **không**
đóng được grant sẵn có lẫn fallback client sẵn có.

**Plan phải chọn một và ghi vào `20260731031000`:**

- **(A)** Dạy nhánh `cancel` của `decide_owned_income_expense_v2` biết obligation ledger mới (nếu
  `flow='TERMINATION_REFUND'` thì tra `termination_refund_obligations`, không tra
  `invoice_refund_reservations`), **và** mở rộng nó cho đủ `reject|post|reverse` **hoặc** thay bằng một
  public router mới; **hoặc**
- **(B)** **Ngừng dùng lại `flow_kind='TERMINATION_REFUND'` trên endpoint đó** — đổi tên `flow_kind` của
  Plan 2 (vd `TERMINATION_REFUND_V2`) và bỏ nó khỏi whitelist, để mọi quyết định đi qua 5 named wrapper.

**(c) ADD — chặn nhánh sinh phiếu LAI trong cùng migration** (`C-DEP-8`):
`app_private.reserve_invoice_refund_obligation_v2:80-82` còn
`CASE WHEN COALESCE(p_system_source,'invoice.refund') = 'termination.refund' THEN 'TERMINATION_REFUND'
ELSE 'INVOICE_REFUND' END` cho `flow_kind` trong khi `lifecycle_owner` **hardcode `'INVOICE_REFUND'`**
và dòng vẫn gắn vào một invoice reservation — **đúng loại lai Plan 2 muốn cấm**. Chưa hiện thực hoá (0
dòng `TERMINATION_REFUND` trong `income_expense_flow_ownership`, census 179 dòng: `CANONICAL_INCOME_EXPENSE`
164, `INVOICE_COLLECTION_V5` 9, `INVOICE_COLLECTION_REVERSAL_V5` 3, `INVOICE_REFUND` 3) và entrypoint
public duy nhất `create_invoice_refund_obligation_v2` hardcode `p_system_source='invoice.refund'` ⇒ **hôm
nay chưa ai mắc bẫy**, nhưng nhánh phải bị **xoá hoặc chặn tường minh** trong **cùng migration
re-point adapter**.

**(d) ADD — quyết số phận adapter chết `TERMINATION_MOVE_OUT_PAIR`** (`C-DEP-7`): registry có
`flow_owner='TERMINATION_MOVE_OUT_PAIR'`, `adapter_name='TERMINATION_MOVE_OUT_PAIR'`,
`decision_scope='PAIR'`, `supported_decisions={approve,cancel,reverse}`; hai bảng
`public.termination_move_out_authorizations` (11 cột, `state` default `'PLANNED'`) và
`public.termination_move_out_settlement_lines` (9 cột) đều **0 dòng**, và
`terminate_contract_move_out_impl` **không bao giờ ghi vào chúng**. Chỉ
`app_private.transition_termination_move_out_pair_v2`, `reverse_termination_move_out_pair_v2` và
`finance_v2_cutover_readiness_v1` tham chiếu. ⇒ **Dọn hay giữ, phải ghi tường minh**, để bộ test
dispatcher đọc được và để việc re-point `TERMINATION_REFUND` không đụng slot này.

**(e)** `TERMINATION_REFUND` trong registry hiện trỏ `adapter_name='INVOICE_REFUND'`,
`is_system_owned=true`, `decision_scope='RESERVATION'`, đủ 5 decision ⇒ Task 1 Step 5 là **forward-update
một dòng đã có**, không phải seed dòng mới.

---

## 4. Task-by-task implementation

Ký hiệu trên từng step: **[GIỮ]** nguyên bản 29/07 · **[SỬA]** đúng ý, sai đích/tiền đề · **[THÊM]** bề
mặt bản 29/07 bỏ sót · **[BỎ]** nhắm vào vấn đề không tồn tại · **[ĐỔI THỨ TỰ]** ·
**BLOCKED-BY** tiền đề cứng.

### Task 0: Khóa audit chuyển phòng và dựng residence segments — Slice 2, KHÔNG bị chặn

**Files:** `supabase/migrations/20260731010500_contract_transfer_audit_hardening.sql`,
`supabase/migrations/20260731011000_room_residence_segments.sql`,
`scripts/test-contract-transfer-segments.mjs`.

**BLOCKED-BY:** không có. Task này **không** phụ thuộc obligation, shared runtime hay posting adapter ⇒
chạy song song với Plan 1 Slice 1. Nhưng nó **phải** dùng dải timestamp `20260731xxxxxx` (§2.1).

- [ ] **Step 0′ [THÊM]: Kiểm mẫu neo trước mọi `CREATE OR REPLACE`.** `transfer_room` **không** nằm
  trong danh sách hàm bị Đợt 0–6 vá theo mẫu neo (`danh-gia v2 §8.3`) ⇒ forward-redefine an toàn. Ghi
  kết luận đó vào migration dưới dạng comment, và kiểm lại bằng một lần grep `pg_get_functiondef` trên
  khối `supabase/migrations/2026073010xxxx → 2026073028xxxx` trước khi viết DDL.
- [ ] **Step 1 [GIỮ]: Viết failing DB tests.** Tạo fixture DEMO chuyển A→B; ép audit insert lỗi phải làm
  toàn RPC rollback, không để contract ở B mà thiếu transfer. Tạo historical chain thiếu first
  `old_room_id`, chain rẽ nhánh và tie date; expected lần lượt `SEGMENT_HISTORY_INCOMPLETE` /
  `SEGMENT_HISTORY_AMBIGUOUS`. **Ghi rõ:** cả ba ca **phải tự dựng** — production **không có** ca
  incomplete/ambiguous/overlap nào (3/3 dòng `contract_transfers` đều đủ `old_room_id`/`new_room_id`/
  `move_out_date`/`move_in_date`; `BOTH_CHANGE` = 0 dòng ở mọi nơi; chỉ 2 HĐ có hoá đơn trỏ `room_id`
  khác `contracts.room_id` và **cả hai đều có** dòng transfer; 1 HĐ (`50d8f93a`) có hoá đơn trải 2 phòng
  và nó **có** dòng transfer).
- [ ] **Step 2 [GIỮ]: Redefine `public.transfer_room`.** Giữ permission/return contract. Lock contract
  `FOR UPDATE` (hiện `:16-19` **không có** `FOR UPDATE`), rồi old/new rooms sorted by id cộng
  target-room active-contract predicate/advisory key trước availability check; validate same
  tenant/building scope. Insert completed `ROOM_CHANGE` audit **trong cùng transaction, KHÔNG swallowed
  exception** (hiện `:88-100` bọc `EXCEPTION WHEN OTHERS THEN NULL`); chỉ sau đó mới update
  contract/room statuses. Concurrent transfers vào một target serialize và chỉ một thành công; bất kỳ
  audit error nào cũng rollback tất cả.
- [ ] **Step 2b [THÊM]: Xử lý ĐƯỜNG B — `trigger_apply_contract_transfer`.** Trigger `BEFORE UPDATE OF
  status ON public.contract_transfers` fire khi `OLD.status='DRAFT' AND NEW.status='APPROVED'` (**không
  phải `COMPLETED`**), và `apply_contract_transfer():17-27` ghi đè `contracts.room_id`, `rent_price`,
  `total_deposit` **và `start_date`/`end_date`**, đặt `status='TRANSFERRED'`, `parent_contract_id=id`.
  Comment `transfer_room:87` cho thấy đường A **cố ý né** trigger này. Chọn **một** và ghi vào migration:
  **(A)** redefine `apply_contract_transfer` để nó cũng ghi audit đầy đủ (`old_room_id`, `move_out_date`,
  `move_in_date`) và **không** ghi đè `start_date`/`end_date`; **hoặc (B)** vô hiệu hoá trigger và bắt mọi
  đổi phòng đi qua `transfer_room`. Hôm nay **0 dòng** đi đường B, nhưng RLS cho UPDATE với
  `contracts.edit` ⇒ đây là forward-guard, không phải dọn dữ liệu.
- [ ] **Step 3 [SỬA]: Xây canonical effective dates trên CẢ HAI đường.** Bản 29/07 chỉ đọc completed
  `ROOM_CHANGE|BOTH_CHANGE` ⇒ **bỏ sạch đường B**. Projection phải nhận diện transfer đã đi qua đường B
  (dấu hiệu: `contracts.status='TRANSFERRED'` + `parent_contract_id` + transfer ở `APPROVED`) và ghi
  `source_path='TRIGGER_APPROVED'`; đường A ghi `source_path='TRANSFER_ROOM_COMPLETED'`.
  `old_effective_end = COALESCE(move_out_date, transfer_date)`;
  `new_effective_start = COALESCE(move_in_date, transfer_date)`. Dùng `[from,to)` và stable order
  `(new_effective_start, transfer_date, id)`. `TENANT_CHANGE`, `DRAFT` và `CANCELLED` không cắt segment
  room.
- [ ] **Step 4 [SỬA]: Không fallback im lặng — và BỎ giả định `contracts.start_date`.** Bản 29/07 neo
  đoạn đầu vào `contracts.start_date`; đó **đúng cột mà trigger đường B ghi đè** ⇒ **xoá giả định đó**.
  Mốc đoạn đầu phải derive từ: (i) `move_in_date`/`transfer_date` của transfer đầu tiên nếu có; (ii)
  `contracts.start_date` **chỉ khi** contract **không có** transfer nào **và** `status <> 'TRANSFERRED'`
  **và** `parent_contract_id IS NULL`. Contract có transfer evidence nhưng first old room thiếu, old/new
  chain không nối, duplicate effective transition, hoặc current `contracts.room_id` không bằng tail room
  ⇒ ghi diagnostic và **không** trả trusted segments.
- [ ] **Step 5 [GIỮ]: Index/query gate.** Thêm index `(contract_id, status, transfer_type, transfer_date,
  id)` và các FK index còn thiếu. Chạy `EXPLAIN (ANALYZE, BUFFERS)` trên contract nhiều transfers; không
  sequential scan toàn bảng. Nếu tạo view, `security_invoker=true` và chạy
  `node scripts/check-view-invoker.mjs` (GOTCHA án lệ: `CREATE OR REPLACE VIEW` làm **rớt**
  `security_invoker`).
- [ ] **Step 6 [GIỮ]: Chạy `node scripts/test-contract-transfer-segments.mjs`** — expected PASS cho
  same-day/no fake vacancy, move gap, missing audit conflict, two-session two-contracts-to-one-room chỉ
  một commit không deadlock, **và (mới) một fixture đi đường B**.
- [ ] **Step 7 [THÊM]: Gate VOLATILE.** Chạy `node scripts/check-stable-fn-locks.mjs` — mọi hàm mới của
  Task 0 phải VOLATILE (§3.3).

### Task 1: Tạo settlement snapshot và obligation ledger bất biến

**Files:** `supabase/migrations/20260731030000_termination_settlement_snapshot.sql`,
`supabase/migrations/20260731031000_termination_refund_obligations.sql`,
`scripts/test-termination-obligations.mjs`.

**BLOCKED-BY:** Plan 1 Task 5 (`special_page_runtime`: `resolve_signed_contract_deposit_basis_v1`,
`org_today_v1`) · Slice −1.9 (siết DML `contract_terminations`) · quyết định §3.5(a) và §3.5(b) ·
quyết định §3.6(A/B).

- [ ] **Step 0′ [THÊM]: Kiểm mẫu neo.** Migration này sẽ đụng `guard_income_expense_owned_payload`
  (§3.5a) và có thể đụng `decide_owned_income_expense_v2` (§3.6b). Kiểm cả hai có đang bị Đợt 0–6 vá
  theo mẫu neo hay không; nếu có thì phải cập nhật LUÔN mẫu neo trong migration Đợt tương ứng, hoặc thêm
  marker "đã vá" để DO-block tự bỏ qua (`C-INFRA-1`).
- [ ] **Step 1 [GIỮ]: Tạo `termination_settlement_snapshots` immutable theo chain.** Có `id`, unique
  `(organization_id, termination_id, version)`, nullable `replaces_snapshot_id` và unique non-null
  successor `(organization_id, replaces_snapshot_id)`; lưu requested input, verified sources, ordered
  breakdown/output, writer/hash/actor/time. Snapshot insert-only; "current" là leaf không có successor và
  phải trùng snapshot của active obligation. Correction lock termination + leaf + obligation rồi insert
  version kế tiếp; **không** dùng mutable `is_current`/`superseded_at` hay partial-current index trái với
  insert-only.
- [ ] **Step 1b [THÊM]: Snapshot phải tự mang `building_id`/`room_id`.** `contract_terminations` có **33
  cột và KHÔNG có** hai cột đó ⇒ nguồn duy nhất tin được hôm nay là **phiếu**:
  `terminate_contract_move_out_impl` INSERT `income_expenses (… building_id, room_id, contract_id …)` và
  **20/20 phiếu hoàn có cả hai non-null**, `ie.room_id = c.room_id` đúng **20/20**. Snapshot copy từ đó
  (hoặc từ residence segment tại `move_out_date` khi có), và ghi `attribution_status`.
- [ ] **Step 2 [GIỮ]: Tạo `termination_refund_obligations`.** Cột tối thiểu: org/building/room/contract/
  termination, `settlement_snapshot_id`/`version`, canonical voucher, canonical/settled amount,
  **`deposit_subtotal`/`other_subtotal` (§0.1)**, state, snapshot/header/items hashes, idempotency,
  posting ids, `replacement_of_id`, state version/timestamps. Composite guards chứng minh mọi entity +
  snapshot cùng tenant/termination.
- [ ] **Step 2b [SỬA]: Sticky subject registry và seed routes — seed cho ĐÚNG schema.**
  `termination_refund_subject_routes` unique `(organization_id, termination_id)`, insert-only,
  composite-linked **birth** snapshot/obligation/source hash, lưu birth route config/version;
  correction/replacement không đổi marker, chỉ nối chain từ birth records.
  Cùng migration seed/verify `termination_refund.obligation_birth.v1` và
  `termination_refund.special_page.v1` với stored `mode='OFF'`, `force_freeze=false`.
  **Cách seed đúng (`C-ROLL-4`):** bảng là **`app_private.server_feature_flags`** (không có bảng `public`
  cùng tên); `max_operation_count` / `max_single_amount_vnd` / `max_total_amount_vnd` là `NOT NULL DEFAULT
  0` ⇒ **không thể để NULL** — **bỏ câu "cap metadata để NULL"** của bản 29/07; **`domain text NOT NULL`
  KHÔNG có default ⇒ bắt buộc truyền**; `risk_class NOT NULL DEFAULT 'MONEY'` + CHECK
  `IN ('MONEY','NON_MONEY')`; dùng `ON CONFLICT (feature_key) DO NOTHING`. CHECK
  `server_feature_flags_canary_limits_check` đòi `starts_at < ends_at` hữu hạn và **cả ba cap > 0** (áp
  khi CANARY). Enrollment `server_feature_flag_canary_orgs` PK `(feature_key, organization_id)` có FK ⇒
  **seed cờ TRƯỚC**, không thì trigger `a10_accounting_canary_enrollment_guard` ném `55000 'Accounting
  feature is not configured'`; enrollment chỉ cho **DEMO** `dddd0000-0000-4000-8000-000000000001`, kèm
  DELETE rollback (tiền lệ `20260728150000:1015`). Hai writer migration sau **abort** nếu route
  thiếu/sai schema hoặc không còn OFF — kiểm bằng `SELECT mode, force_freeze, config_version FROM
  app_private.server_feature_flags WHERE feature_key = … FOR UPDATE` + abort khi `NOT FOUND`, **tuyệt đối
  không** dùng `evaluate_feature_route` để suy ra "thiếu key" (§3.4 luật 2).
- [ ] **Step 3 [GIỮ]: Tạo unique indexes đúng state.** Unique active termination dùng
  `WHERE state IN ('PENDING','POSTED','CONFLICT')`; canonical voucher unique unconditional; idempotency
  unique theo org/operation/key. Index FK và queue `(organization_id, building_id, state, created_at)`.
- [ ] **Step 4 [SỬA]: Tạo conflict ledger.** Codes tối thiểu: `UNLINKED_VOUCHER`, `MULTIPLE_CANDIDATES`,
  `AMOUNT_MISMATCH`, `ITEM_HASH_MISMATCH`, `MISSING_TERMINATION`, `MISSING_SNAPSHOT`, `VIRTUAL_ONLY`,
  `LEGACY_SOURCE_UNKNOWN`, `MULTIPLE_ACTIVE_OBLIGATIONS`, `SEGMENT_HISTORY_INCOMPLETE`,
  `SEGMENT_HISTORY_AMBIGUOUS`, **`TERMINATION_ROW_MISSING_BUT_MONEY_EXISTS` (THÊM — §1.2)**,
  **`DEPOSIT_SUBTOTAL_ZERO` (THÊM — §0.1)**, **`DEDUCTION_VOUCHER_NOT_ALIVE` (THÊM — §0.1)**,
  **`ROOM_SOURCE_MISMATCH`**.
- [ ] **Step 5 [SỬA]: Đăng ký Finance adapter — và ba việc dọn bản 29/07 không có.**
  Forward-update **dòng đã tồn tại** `finance_flow_owner_adapters.flow_owner='TERMINATION_REFUND'`
  (hiện `adapter_name='INVOICE_REFUND'`, `decision_scope='RESERVATION'`, `is_system_owned=true`, đủ 5
  decision) sang termination adapter; dispatcher không còn đọc invoice reservation id cho owner này.
  Supported decisions: special exact post, traditional approve/reject/cancel/reverse và owner
  `REPLACE_SETTLEMENT`; không generic edit. Tạo 5 public wrapper tên ổn định
  `approve_termination_refund_v1`, `reject_termination_refund_v1`, `cancel_termination_refund_v1`,
  `post_termination_refund_v1`, `reverse_termination_refund_v1`.
  **[THÊM] (i) `dispatch_finance_decision_v2` route theo `adapter_name` qua `CASE` NĂM nhánh đóng**
  (`{INVOICE_REFUND, PROFIT_PAYOUT, TERMINATION_FORFEIT_PAIR, TERMINATION_MOVE_OUT_PAIR, SALARY_BUNDLE}`,
  `ELSE → 0A000`) ⇒ phải **hoặc** reuse một `adapter_name` đã nối, **hoặc** thêm nhánh CASE. Seed một
  `adapter_name` mới thì migration **apply xanh** rồi **chết ở decision đầu tiên**; lỗi này **đã hiện
  thực hoá trên prod** cho `CANONICAL_INCOME_EXPENSE` và `UTILITY_RECURRING`.
  **[THÊM] (ii)** Xử lý `decide_owned_income_expense_v2` theo §3.6(A hoặc B) **trong migration này**.
  **[THÊM] (iii)** Chặn/xoá nhánh lai của `reserve_invoice_refund_obligation_v2:80-82`, và **quyết số
  phận adapter chết `TERMINATION_MOVE_OUT_PAIR` + hai bảng 0 dòng** (§3.6c, §3.6d) — **cùng** migration.
  **State coupling bắt buộc:** approve giữ obligation `PENDING`; reject/cancel unposted chỉ RELEASE
  obligation **sau** khi voucher terminal thành công; post chỉ chuyển `POSTED` **sau** active posting
  assertion; reverse chỉ chuyển `REVERSED` **sau** reversal posting thành công. Trigger `AFTER UPDATE`
  trên `income_expenses` là **cơ chế chính** cho release (§3.1), phủ cả
  `cancel_income_expense_flex_v1` (GRANT `authenticated`) và `reverse_invoice_collection_v5`.
  `financeV2Mutations.ts`/`statusMutations.ts` và desktop/mobile/approvals handlers phải **tra nguồn phiếu
  đã đông cứng + trạng thái obligation** (`income_expenses.system_source` — đã đọc sẵn ở
  `statusMutations.ts:48`, `queries.ts:230/240/245/495/996`, tập trung ở `src/lib/voucherSources.ts:1` —
  cộng `get_contract_termination_refund_status_v1`) **trước** global Finance route; **đừng expose
  `app_private`** (schema đó không cấp USAGE cho `authenticated`). Owner `TERMINATION_REFUND` luôn dùng
  named wrapper ngay cả khi org route OFF; ordinary voucher mới dùng route/generic RPC cũ.
  Tests: từng wrapper owned hoạt động đúng quyền/state; invoice refund vẫn dùng invoice adapter; unknown
  owner fails closed **bằng `42501`**; **và một test riêng chạm `0A000`**.
- [ ] **Step 6 [SỬA]: Freeze contract — allowlist và ANNOTATE phải được giải quyết trước.**
  Ownership row được tạo sau khi voucher header + items hoàn chỉnh nhưng trước transaction commit.
  Header/item guard cấm sửa `amount/name/type/org/building/room/contract/source/items`.
  **[SỬA] `attachments` và `notes`: theo §3.5(b) — loại khỏi bộ đông cứng VÀ khỏi header hash, hoặc có
  carve-out của chủ. Không được để nguyên câu 29/07.**
  **[SỬA] One-shot transition purpose `TERMINATION_REFUND_FINALIZE`**: theo §3.5(a) nó **phải là một mở
  rộng allowlist tường minh** cho `account_id` + `voucher_date` (+ lifecycle columns), **không phải giả
  định**. Và **không đi vay cột `purpose`** của `app_private.ie_transition_authorization` (PK một cột, bị
  `a00_ie_transition_token_upsert` ghi đè, và `purpose='FINANCE_V2_LIFECYCLE'` là công tắc tắt cầu
  `a85`) — mang năng lực trong **`app_private.ie_flex_writer_xids`** + `begin/end_ie_flex_write_v1`
  (CHECK scope đã đặt chỗ `'FLEX_EDIT'`, thân guard chưa hiện thực — đó là móc treo). Token gắn
  voucher + xid + obligation + expected hash và consume trong transaction.
  Payout evidence đi qua immutable Finance evidence links, **không** sửa attachment array của voucher.
  **[BỎ]** câu *"`list_organization_members_v1`/member counts và notification expansion phải ẩn provenance
  SERVICE row"* — nhánh technical SERVICE membership là **dead-on-current-data** (1 superadmin, 2 org,
  membership ACTIVE hợp lệ ở **cả hai**; `member_type='SERVICE'` đã có trong CHECK, **0 dòng**) và không
  còn deliverable để gác (`A-SVC`). Nếu vẫn muốn giữ, viết ở **thể điều kiện** và tách thành preflight.
- [ ] **Step 6b [THÊM]: Guard hàng nguồn `contract_terminations`.** Theo §3.5(c).
- [ ] **Step 7 [SỬA]: ACL/state tests.** Direct client INSERT/UPDATE/DELETE private ledgers/subject marker
  bị chặn; `PENDING|POSTED|CONFLICT` không thể coexist cùng termination; `RELEASED/REVERSED` cho audited
  replacement; cross-org composite insert fail; canonical marker không update/delete và không thể trỏ
  sang snapshot/termination khác.
  **[THÊM]** ca âm: client có `contracts.edit` UPDATE trực tiếp `contract_terminations.outstanding_debt`
  ⇒ `55000` (hoặc `42501` nếu Slice −1.9 đã REVOKE).
  **[THÊM]** ca: ANNOTATE (thêm ảnh) trên phiếu hoàn `POSTED` — kết quả phải khớp quyết định §3.5(b).
  **[THÊM]** ca: `cancel_income_expense_flex_v1` trên phiếu hoàn flow-owned ⇒ `[NOT_MANUAL]` (fail-closed
  **mong muốn**, phải assert).
  ⚠ **Giới hạn gate:** `check-definer-acl.mjs` **chỉ test role `anon`** và hai gate ACL/view **hard-scope
  schema `public`** ⇒ chúng **không** chứng minh được revocation trên `app_private`; phải viết query ACL
  riêng cho `authenticated` (`[A1.C8]`).

### Task 2: Canonicalize BA termination writer và freeze voucher tại birth

**Files:** `supabase/migrations/20260731031500_termination_writer_canonicalization.sql`,
`scripts/test-termination-obligations.mjs`.

**BLOCKED-BY:** Task 1 · Plan 1 Task 5 (`resolve_signed_contract_deposit_basis_v1`) · quyết định số phận
`20260730240000_authz_remaining.sql` (WP2) **trước** khi đụng bất cứ hàm nào WP2 viết lại theo mẫu neo.

- [ ] **Step 0′ [THÊM]: Mẫu neo — bắt buộc, trước mọi `CREATE OR REPLACE`.** Kiểm hàm đích có đang bị
  Đợt 0–6 vá theo **MẪU NEO** (`pg_get_functiondef → position(neo) → replace → EXECUTE`, tự
  `RAISE 'DỪNG, không vá mù'`). Danh sách + neo: `danh-gia v2 §8.3`. Nếu có, phải **cập nhật LUÔN mẫu
  neo** trong migration Đợt tương ứng, **hoặc** thêm marker "đã vá" để DO-block tự bỏ qua. Redefine mù
  làm các migration đó **không chạy lại được** và **gãy mọi rehearsal về sau**.
- [ ] **Step 1 [GIỮ, BLOCKED]: Tạo `emit_termination_settlement_v1`.** Helper nhận server-resolved domain
  + client intents nhưng gọi shared `resolve_signed_contract_deposit_basis_v1` **sau khi khoá source
  rows**, derive verified invoice/settlement facts, reject/cap mismatch và tạo breakdown deterministic;
  **không** lấy GENERATED `refund_amount` làm source và **không** duy trì công thức deposit thứ hai.
- [ ] **Step 2 [SỬA]: Đúng thứ tự birth và explicit correlation.** Lock org → contract/domain;
  **`SELECT … FOR UPDATE` dòng `contract_terminations` sẵn có theo `contract_id`; nếu chưa có thì INSERT;
  nếu có thì UPDATE các input quyết toán** (bản 29/07 đã ghi "insert **hoặc lock**" — giữ tinh thần, viết
  rõ thành SQL) và **bắt buộc audit insert thành công**. Lý do cứng: `UNIQUE INDEX
  idx_terminations_unique_contract (contract_id)` tồn tại và **2 hợp đồng ACTIVE đã mang dòng
  termination** — `f81a454c` `PENDING_APPROVAL` 50.000 trên contract `8b564ddf`, `369047fe` `DRAFT`
  30.000 trên contract `f7affb2a` (cả hai đã có `refund_method='TM'`). Sau đó mới derive snapshot, insert
  refund voucher `UNAPPROVED + UNPOSTED`, items, verify sums/hashes, obligation, sticky marker và
  ownership (**thứ tự ownership vs `account_id` theo §3.5a**). **[THÊM]** set
  `contract_terminations.refund_method` khi `refund_amount > 0`, nếu không `23514`. Persist direct
  termination ↔ snapshot ↔ obligation ↔ voucher ids/FKs; **tuyệt đối không** recover bằng voucher name hay
  8 ký tự termination trong note. Termination audit/correlation failure rolls back contract/voucher/
  obligation.
- [ ] **Step 3 [SỬA]: Route lần sinh đầu + sticky routing + evaluate ĐÚNG MỘT LẦN.** Migration chỉ assert
  key `termination_refund.obligation_birth.v1` đã được seed OFF ở Task 1 (đọc bảng, không dùng
  evaluator — §3.4 luật 2). Dưới lock termination, kiểm sticky marker **trước** global route: subject đã
  marked luôn gọi canonical emitter/adapter (trừ `FROZEN` chặn birth/correction), không thể rơi lại body
  legacy. Với subject chưa marked: evaluated `LEGACY` chạy nguyên body legacy và ghi route audit;
  `SHADOW` chạy pure projection/compare rồi vẫn legacy; `CANONICAL` (từ stored `CANARY` hoặc `ON`) insert
  marker + snapshot/voucher/obligation atomically; `FROZEN` raise trước mutation. Marker snapshot stored
  mode/config version để audit, vì evaluator không trả chuỗi `CANARY`.
  **[THÊM] Snapshot `(evaluated, stored mode, config_version)` vào biến ngay lần evaluate đầu và dùng
  lại — KHÔNG evaluate lần hai trong cùng transaction** (`clock_timestamp()` không stable;
  `claim_feature_operation_v1` lấy `clock_timestamp()` riêng sau advisory lock nên writer có thể qua route
  rồi fail *"Canary window is no longer valid"* trong **cùng** transaction). Rollback CAS về OFF chỉ ảnh
  hưởng subject chưa marked. Birth route tách khỏi `termination_refund.special_page.v1`.
- [ ] **Step 4 [SỬA]: Rewire move-out chain — và bốn ràng buộc mới.** Trước DDL, snapshot/compare live
  signatures và `pg_get_functiondef` digests của `terminate_contract_move_out_with_credit_v1`,
  `terminate_contract_move_out`, `terminate_contract_move_out_impl` với ba baseline file nêu ở §1;
  unreviewed drift phải stop migration. **Ghi vào plan: hiện ZERO DRIFT** (113/113, 160/160, 210/210) ⇒
  preflight sẽ **pass**, đây là kiểm tra thật chứ không phải nghi thức. Sau đó forward-redefine cả chain
  để route theo Step 3. Canonical branch **không** ghi prorated fields bằng 0 khi settlement invoice có
  số thật (hiện `:226-240` ghi `prorated_* = 0` **mọi lần**, không phải theo nhánh). Termination id,
  snapshot id, obligation id và voucher id phải được trả/correlate, **không**
  `EXCEPTION WHEN OTHERS THEN WARNING` cho audit canonical.
  **[THÊM] (i) KHÔNG được đổi chuỗi notes của `payments` cấn trừ** (`'Quyết toán khi thanh lý
  DD/MM/YYYY'`, sinh ở `impl:148`), **KHÔNG** tạo `payments` ngoài cửa sổ
  `app_private.termination_move_out_writer_context`, và **giữ nguyên thứ tự mở/đóng context**
  (`terminate_contract_move_out:139-152`, `:172-174`). Nếu buộc phải đổi thì redefine
  `app_private.classify_termination_payment_v1` **trong cùng migration** (§1.5).
  **[THÊM] (ii) ACL route giữa:** `REVOKE EXECUTE ON FUNCTION public.terminate_contract_move_out(...)
  FROM authenticated` (chỉ để `with_credit_v1` gọi), **hoặc** gắn sticky-marker + canonical idempotency
  vào **chính route giữa** — hiện `proacl` cho phép client gọi thẳng, bỏ qua idempotency key/payload
  hash/guard credit của wrapper (`:84-90`) (`[A9.C13]`).
  **[THÊM] (iii) Ba lớp khoá kỳ:** dùng `cashbook_closed_through_v1` (pre-voucher) +
  `assert_period_open_for_edit_v1` (khi đã có voucher), phát ba code có nhãn; **không** dùng
  `finance_v2_is_cashbook_period_open` (chỉ đọc `accounts.lock_date`, **0/28 account có `lock_date`** ⇒
  no-op tuyệt đối) (§1.6).
  **[THÊM] (iv) Cầu `a85`/`a85b`:** assert **không** có posting `source_kind='LEGACY_BRIDGE'` nào sinh ra
  trong transaction birth (§1.6 dòng 1).
- [ ] **Step 5 [SỬA]: Rewire approval writer + idempotent replay.** Preflight live signature/body digest
  của `approve_contract_termination_v1(uuid,text)` với
  `scripts/authz-prepared/t5_10_contract_termination_writers.sql` và
  `scripts/authz-prepared/prod-snapshot/PS05_misc_remaining.sql` — **ghi rõ: hàm này KHÔNG có defining
  migration** dưới `supabase/migrations/`, body live giống hệt cả hai file (99/99). Drift ngoài allowlist
  ⇒ stop rollout. Forward-redefine để dùng cùng route/emitter/source/type mapping; canonical branch không
  tạo voucher thứ hai và **không** tính từ GENERATED `refund_amount` (hiện `:65` lấy đúng cột đó). Nếu
  termination đã `COMPLETED`/marked, trả lại correlation canonical hiện hữu (legacy-compatible response
  kèm termination/snapshot/obligation/voucher ids) thay vì `noop + voucher_id:null` (`:43-46`);
  payload/hash khác ⇒ conflict.
  **[THÊM]** Phiếu do writer này sinh có **`system_source` NULL** (`:94-105` không có cột đó) và
  correlation duy nhất là name + `left(termination_id::text,8)` trong description item ⇒ canonical branch
  **phải** set `system_source`. Đây cũng là điều kiện của gate `check-approver-provenance.mjs`
  (`CUTOFF='2026-07-23'` fail mọi phiếu `APPROVED` có `approved_by IS NULL AND system_source IS NULL`).
  **[THÊM]** Writer này còn đặt `status='COMPLETED', refund_date = now()` **trước** khi INSERT phiếu ⇒
  canonical branch **không được** set `refund_date` như tín hiệu "đã hoàn" (Slice −1.7 đang đi bỏ tín
  hiệu đó).
- [ ] **Step 5b [THÊM]: Nối chuỗi FORFEIT vào preflight + sticky routing.**
  `terminate_contract_forfeit_with_credit_v1 → terminate_contract_forfeit → terminate_contract_forfeit_impl`
  (**26/37 dòng**) phải vào digest preflight và vào sticky routing, **dù nó không sinh obligation**
  (§0.4). Và **quyết tường minh** số phận audit insert bị nuốt tại `:262-263`: fail-close (raise) hay
  chấp nhận có ghi nhận. Không được để trống như bản 29/07.
- [ ] **Step 6 [GIỮ]: Negative/zero paths.** Net < 0 tạo customer-owes/forfeit snapshot/event, **không**
  positive obligation. Net = 0 hoàn thành không queue. Net > 0 nhưng voucher/items invalid tạo conflict và
  rollback canonicalization, không để orphan voucher.
- [ ] **Step 7 [SỬA]: Preserve traditional workflow boundary.** Contract/`/thu-chi` decisions route owned
  termination voucher qua adapter/token. **Viết chính xác lại** (thay câu "permissions + states giữ
  baseline"): *"quyền giữ nguyên (`income_expenses.approve` cho duyệt, CUSTODIAN cho ghi sổ) nhưng đường
  gọi đổi hoàn toàn sang 5 named wrapper"* (§0.2). Generic edit hidden/server-rejected vì canonical
  amount/items immutable. `IncomeExpenseForm` hiển thị reason + owner correction link; ordinary vouchers
  vẫn editable. Chỉ special operation lets manager auto post. **[THÊM]** giữ nguyên substring
  `owned by system flow` (§0.2).
- [ ] **Step 8 [SỬA]: Regression tests.** OFF/SHADOW/CANARY behavior như trên; sau khi một subject sinh
  canonical, CAS global route về OFF rồi retry cả move-out **và** approval writer vẫn reuse canonical
  chain và không tạo legacy voucher. Subject mới ở OFF vẫn baseline legacy. Malicious client
  refund/excess/debt above verified basis bị reject, no committed voucher. Fixture mismatch queue exact
  item sum. Generic termination edit fails/read-only while ordinary pending edit passes. Two-session birth
  vs preview/submit/traditional post không diverge.
  **[THÊM]** fixture "contract đã có dòng termination `DRAFT`/`PENDING_APPROVAL`" dùng **đúng** hai HĐ
  `8b564ddf` và `f7affb2a`, chứng minh emitter đi nhánh lock-and-update, derive snapshot từ dòng đã lock,
  và **không** ném `23505`.
  **[THÊM]** fixture `payments` guard: tạo settlement payment qua canonical emitter ⇒ trigger
  `a10_payment_termination_non_cash` **không** ném `55000` và **không** rơi vào `RETURN NEW`.
- [ ] **Step 9 [SỬA]: Chạy DB gates.** `node scripts/test-termination-obligations.mjs` và
  `node scripts/reconcile-money.mjs 2026-07`. **Pass = `exit 0`**; **`exit 3 (INCONCLUSIVE)` KHÔNG phải
  pass** (script tự thoát 3 khi không kỳ nào >1000 phiếu, và cần `signInWithPassword` nên **không
  headless-CI-safe**). Fallback: chọn kỳ >1000 dòng hoặc dùng `reconcile-money-v2.mjs`.

### Task 3: Legacy correlation và signed deposit basis

**Files:** `supabase/migrations/20260731033000_termination_lifecycle_backfill.sql`,
`scripts/audit-room-lifecycle-rollout.mjs`.

**BLOCKED-BY:** Task 1 · Plan 1 Task 5 (`resolve_signed_contract_deposit_basis_v1`).

- [ ] **Step 1 [SỬA]: Snapshot baseline per organization.** Count/sum/hash terminations, refund
  vouchers/items, obligations, postings, deposit items, reservations và transfer histories; report
  timestamp/query hash. **[THÊM] Bắt buộc:** phát mọi count/sum **theo `organization_id`**, và so **delta
  với baseline đã ghi**, **không** so bằng đẳng thức tuyệt đối — bảng dịch rất nhanh (`income_expenses`
  alive được đo **hai lần trong cùng ngày 30/07**: 2.528 rồi 2.625; `accounts` alive 27 → 28 cùng ngày;
  hai rổ cọc dịch giữa 29 và 30/07). **[THÊM]** preflight phải ghi **digest của
  `public.fee_type_matches` và `public.nrm_vn`** (mọi phép đếm refund-like phụ thuộc chúng).
- [ ] **Step 2 [SỬA]: Match legacy an toàn.** Chỉ `LEGACY_MATCHED` khi có source/termination correlation
  rõ, cùng org/contract, **đúng một** positive voucher candidate, header = item sum và source/evidence
  hợp lệ. Manual/null source, contract null, nhiều candidates hoặc amount mismatch chỉ ghi conflict;
  **không** sửa legacy amount/status.
  **[THÊM] `MULTIPLE_CANDIDATES` fixtures dùng hai cặp sống:** contract `a1584980` (`PC2606049` POSTED /
  `PC2606050` CANCELLED, cả hai 2.797.000) và contract `aa16a805` (`PC2607074` POSTED / `PC2607073`
  CANCELLED, cả hai 3.127.400). Và ghi rõ: **correlation duy nhất hôm nay là `contract_id`** (không có
  cột `termination_id`, không có FK) ⇒ reader tạm phải **dedupe theo active posting**, không được giả
  định một candidate.
  **[THÊM]** Ba phiếu do `approve_contract_termination_v1` sinh (`2be6ee5b` 50.000 ngày 18/07,
  `6e84e37f` 40.000 ngày 19/07, `f1c6dd9b` 30.000 ngày 19/07 — tất cả UNAPPROVED, `account_id` NULL,
  item `accounting_class='PNL'` **xếp sai lớp**) có `system_source` NULL ⇒ chúng **PHẢI** vào
  `LEGACY_SOURCE_UNKNOWN` **có chủ ý** (không match tên), và report **phải liệt kê riêng** ba phiếu này
  để chủ biết chúng **chưa từng được chi**. Ghi câu này vào plan để không ai coi đó là bug.
- [ ] **Step 3 [SỬA, BLOCKED]: Reuse signed deposit basis.** Backfill/emitter/lifecycle gọi
  `app_private.resolve_signed_contract_deposit_basis_v1` của shared runtime và persist returned basis
  hash/ordered rows; **không** copy một câu SQL gần giống vào Plan 2. Report vẫn tách real posted cash,
  owner-recognized historical virtual, releases/refunds/offsets và untrusted legacy, giữ
  direction/reversal semantics giống broker eligibility.
  **[THÊM] Luật chống tái sinh số sai (§0.1):** mọi khoản khấu trừ trên `contract_terminations` phải được
  đối chiếu với **trạng thái sống của phiếu của chính nó** trước khi được tin. Phản ví dụ bắt buộc: HĐ
  `69cdb5dc` có `early_termination_fee = 1.071.500` trong khi phiếu `PC2607118` là **CANCELLED /
  NOT_APPLICABLE**; và cọc duy nhất từng ghi cho HĐ đó là phiếu **ảo đầu kỳ** `PT2607060`
  (`system_source='contract.deposit'`, `APPROVED` nhưng `posting_status='NOT_APPLICABLE'`, 1 item
  `DEPOSIT` **1.450.000**) trong khi `contracts.total_deposit = 3.500.000`. Tức
  `2.428.500 = 3.500.000 (chưa bao giờ thu) − 1.071.500 (chưa bao giờ vào sổ)`. Backfill tin
  `total_deductions` (cũng GENERATED) sẽ **tái tạo lại 2.428.500**.
- [ ] **Step 4 [SỬA]: Không overclaim coverage.** `contract_deposit_links` chỉ metadata ưu tiên (**5
  dòng, không có cột amount**); `contracts.deposit_paid` chỉ derived cross-check.
  **[SỬA số]** không phải "37/56 termination audit rows thiếu" mà: **56 HĐ `TERMINATED`; 37 dòng
  `contract_terminations` trên 37 HĐ khác nhau; 23 HĐ không có dòng nào; 14/23 trong đó VẪN có phiếu
  `termination.refund`; còn phát sinh 2/18 ca tháng 07/2026** (plan 29/07 ghi 37/56 — số đo lại 30/07 là
  **23/56 thiếu**). Cộng: **16/20** phiếu hoàn không correlate được, và **8/10 phiếu POSTED của org thật
  không có dòng `contract_terminations` nào trên `contract_id`**.
  **[GIỮ, và định lượng]** go-live trusted queue **có thể trống** — không phải "đầy việc": org thật có
  **25/28** termination `COMPLETED` với `refund_amount <= 0`, chỉ **3** dương, và **cả 3 đã có phiếu
  sống**. ⇒ Đặt hẳn ngưỡng kiểm: **hàng đợi org thật > 3 dòng nghĩa là emitter đang sinh nghĩa vụ hoàn
  cho cả những ca khách còn nợ.**
  **[THÊM] Chính sách:** KHÔNG tự tạo hồ sơ thanh lý hồi tố cho 23 HĐ thiếu; chỉ report qua
  `TERMINATION_ROW_MISSING_BUT_MONEY_EXISTS`. `UNIQUE(contract_id)` **cho phép** tạo bổ sung, nên phải
  nói rõ là **không làm**.
- [ ] **Step 5 [GIỮ]: Chạy `node scripts/audit-room-lifecycle-rollout.mjs --mode preflight`** — expected
  no production mutation và baseline sums unchanged. **[THÊM]** script này **chưa tồn tại**, phải tạo; và
  **không** dùng `apply-sql.mjs --dry-run` (script hard-code production ref — đã xác minh lại).

### Task 4: Authorized queue, preview, `/deposits` status reads — và ô KPI

**Files:** `supabase/migrations/20260731032000_termination_refund_read_rpcs.sql`,
`scripts/test-termination-refund-reads.mjs`.

**BLOCKED-BY:** Task 1 (schema obligation). **KHÔNG** cần posting adapter ⇒ deploy được trước Task 5.
Xây tiếp trên Slice −1.7 (reader `/deposits` đã sửa).

- [ ] **Step 1 [GIỮ]: Tạo queue RPC.** `list_termination_refund_queue_v1(p_building_ids uuid[], p_from
  date, p_to date, p_cursor_created_at timestamptz, p_cursor_id uuid, p_limit integer)` order/keyset theo
  `(created_at, id)`; trả canonical amount, **`deposit_subtotal`/`other_subtotal`**, settled/remaining,
  snapshot breakdown, deposit basis, voucher/obligation/active posting/evidence state và conflict
  warnings. Cursor null phải null cả cặp; limit 1–500. Không nhận client amount, không offset pagination,
  không chạy lại settlement formula. **Khai VOLATILE.**
- [ ] **Step 2 [GIỮ]: Tạo preview RPC.** `preview_termination_refund_from_special_page_v1(p_termination_id
  uuid, p_cashbook_id uuid, p_evidence_ids uuid[])` là read-only; reload hashes/state/route/cap/cashbook/
  evidence và trả `POSTABLE|ALREADY_POSTED|CONFLICT|CONFIG_REQUIRED|NOT_AUTHORIZED`. Preview không
  reserve và submit luôn revalidate. **[THÊM]** preview **không** được gọi
  `evaluate_feature_route` lần thứ hai trong cùng transaction với submit (§3.4 luật 1).
- [ ] **Step 3 [SỬA]: Hai status RPC theo consumer + subtotal DEPOSIT.**
  `get_termination_refund_statuses_v1(p_termination_ids uuid[])` phục vụ `/deposits`; input unique 1–500
  ids, output **đúng một row/id** theo thứ tự ổn định, gồm canonical amount, **`deposit_subtotal` (bắt
  buộc — §0.1, `C-DEP-2`)**, obligation state, active posting id/status, posted/reversed timestamp,
  **snapshot `building_id`, snapshot `room_id`, `attribution_status`** và legacy warning. Không join
  `contracts.room_id` hiện tại để gán lịch sử.
  `get_contract_termination_refund_status_v1(p_contract_id uuid)` phục vụ contract detail, trả cùng
  minimum status cho đúng một contract, không trả list/queue/deposit ledger rộng.
  `COMPLETED` termination một mình **không bao giờ** map thành `refundDone=true`; **`refund_date` cũng
  không** (Slice −1.7).
  **[THÊM]** Hợp đồng "đúng một row/id" phải chống được ca **2 phiếu hoàn cùng số tiền trên một HĐ** (§1.2)
  ⇒ dedupe theo **active posting**, và trả `MULTIPLE_CANDIDATES` thay vì chọn bừa.
- [ ] **Step 3b [THÊM]: Forward-redefine `public.get_refund_forfeit_summary(uuid[])`** — hàm nuôi ô KPI
  "Đã hoàn cọc" (§1.4). Yêu cầu: tính từ **tiền hoàn đã vào sổ (active posting)**, không phải
  `SUM(GREATEST(0, refund_amount))`; `refund_count` đếm **số lần hoàn thật**, không đếm mọi termination
  non-FORFEIT; **không** đếm `DRAFT`/`PENDING_APPROVAL`. Giữ **SECURITY INVOKER** (nếu chuyển sang
  DEFINER thì phải tự authorize như §3.3 và vào `check-definer-acl`). **Khai VOLATILE** nếu thân hàm chạm
  bất kỳ hàm authz có `FOR SHARE`. Before/after phải ghi **theo org**: `aaaa` **8.290.000đ / 3 lần →
  4.302.000đ / 2 lần**; `dddd` **700.000đ / 8 lần → 0**. (Con số **8.990.000đ / 11 lần** là tổng
  **cross-org đọc bằng service-role** — không người dùng nào thấy; chỉ dùng nó khi kèm đúng nhãn đó.)
- [ ] **Step 4 [SỬA]: Authz từng target — và ghi baseline hai chiều.** Queue/preview dùng `thu_tien.*`;
  deposit status dùng `deposits.view`; contract-detail status dùng `contracts.view`. Mixed-org array, một
  building không được phép, contract/termination khác org, oversized input và superadmin provenance đều có
  fixture.
  **[THÊM] Baseline hôm nay là `buildings.view` resolve qua PHÒNG HIỆN TẠI** (`C-DEP-10`, §3.3) ⇒ **hai
  fixture mới bắt buộc**: (i) thành viên có `buildings.view` mà **không** có `deposits.view` — **mất**
  dòng đang thấy; (ii) ngược lại — **được thêm** dòng. Giữ cả hai fixture cũ ("chỉ `contracts.view`",
  "chỉ `deposits.view`").
  **[THÊM]** Ghi rõ quyết định về **`deposits.refund`** (§3.3): dùng hay không dùng, và vì sao.
  **[THÊM]** DEMO **không có fixture quyền nào khớp** test của plan (không "view-only", không "chỉ
  `deposits.view`", không "chỉ `contracts.view`"), và có ca **ngược** (`demo.ketoan`: collect
  ORGANIZATION > view SCOPED-BUILDING) ⇒ phải có Step tạo fixture + cleanup **trước** khi viết test
  (`[A3.C10]`).
- [ ] **Step 5 [SỬA]: Apply read migration trước writer.** Queue/preview/status phải deploy và test ở
  OFF/SHADOW; `20260731034000` chưa tồn tại vẫn đọc an toàn. DB test xác nhận 500 ids thành công, 501 bị
  `22023`, snapshot room/building không đổi sau transfer, và missing/duplicate result fail closed. Chạy
  `node scripts/test-termination-refund-reads.mjs` — expected unauthorized calls `42501` và không lộ
  tenant/amount.
  **[THÊM]** thêm assertion: **mọi RPC mới khai VOLATILE** (`node scripts/check-stable-fn-locks.mjs`
  xanh) và **`node scripts/check-permission-catalog.mjs`** xanh (gate CI bắt buộc, cần PAT) nếu Task 4
  tạo/dùng permission key mới.
- [ ] **Step 6 [THÊM]: Publication realtime.** Apply `20260731032200_realtime_termination_tables.sql`
  (§1.8, §2.1) và kiểm bằng `pg_publication_tables` rằng `contract_terminations` (+ `contract_transfers`
  nếu cần) đã vào `supabase_realtime`, `REPLICA IDENTITY` đủ. Không có bước này thì Task 7 Step 2 khai
  query key mà **production im lặng vĩnh viễn** trong khi test mock vẫn xanh (`B25`).

### Task 5: Exact refund writer trên trang đóng tiền

**Files:** `supabase/migrations/20260731034000_termination_refund_special_writer.sql`,
`scripts/test-termination-refund-special-page.mjs`.

**BLOCKED-BY:** Plan 1 Task 5 (`special_page_submit_context_v1`, `finance_v2_post_voucher_with_source_v1`,
`special_page_cashbook_override_v1`, `org_today_v1`) · Task 1 · Task 2 · Task 4 · quyết định §3.5(a).

- [ ] **Step 1 [GIỮ]: Signature không có amount/raw attachment.**
  `submit_termination_refund_from_special_page_v1(p_termination_id uuid, p_cashbook_id uuid,
  p_evidence_ids uuid[], p_idempotency_key text)`; server derive organization/building/voucher/amount từ
  active obligation. UI upload theo `create_finance_evidence_upload_intent_v2 → storage server path →
  finalize_finance_evidence_v2`; RPC tiền chỉ nhận finalized evidence ids, không raw URL/path/json
  attachment.
- [ ] **Step 1b [SỬA]: Assert submit route fail-closed — đọc bảng, không dùng evaluator.**
  `20260731034000` verify `termination_refund.special_page.v1` đã được seed ở Task 1 và vẫn stored
  `mode='OFF'` trước khi expose wrapper; thiếu/sai schema/đã enable ⇒ migration abort. Kiểm bằng
  `SELECT … FROM app_private.server_feature_flags … FOR UPDATE` + abort khi `NOT FOUND` (§3.4 luật 2) —
  `evaluate_feature_route` trả `LEGACY` khi thiếu key nên **không** fail-closed. Evaluated
  `LEGACY`/`SHADOW` không cho special submit post; `FROZEN` raise trước mutation; chỉ evaluated
  `CANONICAL` (stored `CANARY` hoặc `ON`) được vào writer. **[THÊM]** thêm một `EXISTS` **runtime** trong
  thân writer.
- [ ] **Step 2 [SỬA]: Dùng shared context + global order — idempotency LOOKUP TRƯỚC.** Evaluate feature
  key **đúng một lần** bằng full server evaluator và authorize permission `thu_tien.collect` cho exact
  snapshot building; đây là **hai** check khác nhau. Sau đó theo §3.2: **(0) LOOKUP bảng idempotency của
  Plan 2 — hit thì trả voucher/posting cũ và KHÔNG gọi `claim_feature_operation_v1`** (hàm này INSERT
  trần vào bảng có `UNIQUE (feature_key, config_version, operation_key)` nên replay y hệt ném **`23505`
  từ TRONG claim**, không phải "trả voucher cũ"; và vì `config_version` nằm trong khoá unique, **bump
  version giữa hai lần replay xoá sạch bảo vệ**) → (1) org lock → (2) claim → (3) obligation/termination
  → (4) voucher + items → (5) cashbook → (6) evidence → (7) posting. Context **không** lock cashbook sớm.
  Replay cùng key + hash trả **cùng** voucher/posting; cùng key khác hash fail; obligation posted khác key
  trả `ALREADY_POSTED`.
- [ ] **Step 3 [GIỮ]: Locked exact recheck + state policy đầy đủ.** Trước mutation, verify
  obligation/voucher/termination ids, explicit correlation (**không** match tên hay 8 ký tự trong note),
  `state='PENDING'`, no active posting, header total, ordered item sum/hash, source, snapshot hash,
  `settled_amount=0`, `remaining=canonical`. Chấp nhận **đúng hai** state owned: lifecycle
  `PENDING|RESOLVED` với `UNAPPROVED + UNPOSTED`, hoặc `APPROVED + UNPOSTED` do named traditional approval
  wrapper tạo ra mà hash/ownership/version vẫn khớp. `APPROVED+POSTED` active ⇒ adapter reconcile
  obligation → `POSTED` rồi trả `ALREADY_POSTED`; `NON_CASH|NOT_APPLICABLE` là `CONFLICT` và **không**
  được trả tiền lần hai; `REVERSED|CANCELLED|CHANGES_REQUESTED|DISPUTED` không post, phải đi
  terminal/replacement/correction flow. Bridge posting xuất hiện sớm là invariant failure, **không** tạo
  posting thứ hai.
  **[THÊM]** Assert cụ thể: **không** có posting nào `source_kind='LEGACY_BRIDGE'` trên voucher này
  (dấu vết cầu `a85` tự mint — §1.6 dòng 1).
- [ ] **Step 4 [SỬA]: Finalize controlled fields/evidence — dựa trên allowlist ĐÃ MỞ RỘNG.** Validate real
  cashbook cùng org và require exact CUSTODIAN possession cho actor thường, hoặc audited
  `special_page_cashbook_override_v1` cho superadmin thiếu custody binding (**hàm chưa tồn tại —
  BLOCKED-BY Plan 1**). Issue one-shot `TERMINATION_REFUND_FINALIZE` **chỉ** để set-once
  `account_id`/`voucher_date`/lifecycle fields — **và điều này chỉ chạy được nếu Task 1 Step 6 đã mở rộng
  allowlist của `guard_income_expense_owned_payload`** (§3.5a). Lock từng finalized evidence id, verify
  org/uploader/server-issued path/object, rồi link trực tiếp vào posting; **không** append/update
  `income_expenses.attachments`, **không** gọi adoption từ raw attachment. Bắt buộc ít nhất một qualifying
  `ORIGINAL` evidence link trước posting; empty/invalid trả `EVIDENCE_REQUIRED` và rollback. Consume
  token; amount/items/contract/source **không** nằm trong allowlist.
  **[SỬA] Bỏ chữ "hash" hoặc làm nó thật** (§1.7, `C-EV-1`): `finance_evidence_objects` có **0/159 dòng có
  `sha256`** và `finalize_finance_evidence_v2` **không bao giờ ghi cột đó** ⇒ mọi so sánh "cùng hash
  evidence" đang so NULL với NULL. Chọn (A) ghi `sha256` thật, hoặc (B) định nghĩa fingerprint =
  `(organization_id, bucket_id, object_name, byte_size, mime_type)` và bỏ chữ "hash".
  **[THÊM]** Nếu cần `relation_kind` mới (vd `INHERITED_BATCH`) thì phải forward-update CHECK
  `income_expense_posting_evidence_relation_kind_check` (hiện chỉ
  `('ORIGINAL','INHERITED_LEGACY_DELTA')`, 142/142 dòng là `ORIGINAL`).
- [ ] **Step 5 [SỬA]: Dedicated post.** Gọi shared adapter; nó check open cashbook period, chuyển
  `UNAPPROVED→APPROVED` khi cần hoặc giữ nguyên valid owned `APPROVED`, gọi
  `finance_v2_post_voucher_with_source_v1` với `source_kind='TERMINATION_REFUND'`,
  `external_source_kind='TERMINATION_REFUND_OBLIGATION'` + obligation id/hash, link evidence, set active
  posting/status/version và assert expense line. Sau assertion mới chuyển obligation `POSTED`. Locked
  period/mis-provenance rollback toàn bộ.
  **[SỬA] Assert dòng posting phải cho phép CHANGE/ROUNDING nếu phiếu có** (`C-EV-4`):
  `app_private.finance_v2_post_manual_voucher` hiện chỉ tạo **một dòng `MAIN`** và **không kiểm kỳ mở**,
  trong khi cầu `a85` tạo cả ba (`CHECK line_kind IN ('MAIN','CHANGE','ROUNDING','REVERSAL')`) ⇒ assert
  "đúng một dòng MAIN" **đóng cứng biến thể thiếu**. Core mới phải phát đủ dòng cần thiết **và có backstop
  kiểm kỳ ở BÊN TRONG** vì nó sẽ được gọi từ nhiều adapter.
  **[THÊM]** `income_expense_postings.source_kind` là **text tự do, không CHECK** ⇒ thêm
  `TERMINATION_REFUND` **không** cần đổi constraint (census: `LEGACY_BACKFILL` 1710, `MANUAL` 265,
  `LEGACY_BRIDGE` 73). Và `income_expense_posting_lines` **không có `room_id`/`contract_id`** ⇒ mọi
  reconciliation theo phòng phải join qua voucher/source, không qua posting lines.
  **[THÊM]** Ba code kỳ có nhãn: `[CASHBOOK_CLOSED]` / `[HANDOVER_LOCKED]` / `[PROFIT_LOCKED]`. Nhớ:
  **18 toà đã chốt lợi nhuận 05/2026** và **7 phiên bàn giao đang hiệu lực** ⇒ hai nhánh này có dữ liệu
  thật; nhánh "kỳ sổ quỹ đã đóng" **chỉ kiểm được bằng fixture** (0 dòng `cashbook_closures`, 0/28
  account có `lock_date`).
- [ ] **Step 6 [SỬA]: Traditional, authority, period và race tests.** Gọi trực tiếp từng named wrapper và
  chứng minh `financeV2Mutations.ts`/`statusMutations.ts` chọn chúng chỉ khi nguồn phiếu là
  `termination.refund`; pure test `terminationRefundRouting.test.ts` bao phủ approve/reject/cancel/post/
  reverse, unknown owner fail-closed và ordinary voucher vẫn đi generic RPC với baseline
  UNAPPROVED/approval-gated. Actor thường thiếu exact CUSTODIAN bị từ chối; superadmin có/không có regular
  membership vẫn post qua audited override với đúng provenance. Cả posting date và reversal date trong kỳ
  đã khoá phải rollback không đổi voucher/obligation/posting. Mọi special post ghi đúng
  `source_kind='TERMINATION_REFUND'`, `external_source_kind='TERMINATION_REFUND_OBLIGATION'`, exact
  obligation id/hash; traditional owned post/reverse giữ provenance adapter và **không** giả `MANUAL`.
  Manual update race bị freeze guard; traditional `APPROVED+UNPOSTED` rồi special check được post **đúng
  một lần**; traditional post race và special submit serialize, loser trả `ALREADY_POSTED`.
  **[THÊM]** test **huỷ**: phiếu hoàn canonical (chỉ có obligation ledger, **không** có dòng
  `invoice_refund_reservations` `HELD`) phải huỷ được qua `cancel_termination_refund_v1`, **và** phải
  chứng minh đường cũ `decide_owned_income_expense_v2` không còn ném `P0002` cho nó (theo nhánh A/B đã
  chọn ở §3.6). Đây là ca đã **verified reachable** ở `statusMutations.ts:315-330` và `:352-367`.
  **[THÊM]** test replay: gọi lại cùng `p_idempotency_key` + cùng hash ⇒ **không** `23505` (§3.2 bước 0).
- [ ] **Step 7 [GIỮ]: Cancel/reverse/replace.** Acquire global locks; reversal date phải ở open cashbook
  period. Sau Finance success transition `PENDING→RELEASED` hoặc `POSTED→REVERSED`.
  `replace_termination_refund_settlement_v1(p_termination_id, p_expected_obligation_id,
  p_expected_state_version, p_corrected_settlement_inputs, p_reason)` chỉ owner/superadmin, không nhận
  free amount/split. Với old state `PENDING|CONFLICT`, function phải terminalize owned old voucher qua
  named cancel/reject adapter nếu voucher tồn tại rồi mới RELEASE obligation; với `RELEASED|REVERSED` xác
  minh voucher/posting đã terminal; `POSTED` phải reverse trước. Sau đó invoke canonical emitter, insert
  successor snapshot leaf + voucher + obligation mới với `replacement_of_id`, trong cùng transaction. Same
  org/contract, new voucher, no active posting, non-empty reason và resolved conflict bắt buộc; failure
  rollback cả cancel/release/replacement.
  **[THÊM] Định nghĩa "chủ" phải chốt trước** (`D-OWNER`): **EXTEND** `app_private.is_org_owner_v1` (đã
  kiểm cửa sổ hiệu lực của cả membership lẫn role_binding) + thêm `organizations.status='ACTIVE'` mà nó
  thiếu + bọc nhánh `is_super_admin()` — **không** tạo helper thứ hai. Và phải chốt **một** định nghĩa:
  hàm live nhận diện chủ bằng `organization_roles.name='Chủ sở hữu tổ chức'` (**chuỗi tên là key** ⇒ đổi
  tên vai trò trong Cài đặt **âm thầm tắt** cửa chủ), plan đòi `member_type='OWNER'`. DEMO có **3
  role-owner vs 1 `member_type='OWNER'`**; org thật hai định nghĩa **trùng nhau (1 và 1)** ⇒ lệch **một
  chiều và chỉ ở DEMO**; E2E chạy bằng `demo.quanly` (STAFF nhưng có vai trò chủ) sẽ đỏ không rõ nguyên
  nhân nếu chọn `member_type`.
  **[THÊM]** Sửa `useContractTerminationInfo` (§1.1) **cùng lúc**: chuỗi replacement cố ý tạo thêm dòng
  termination, mà hook đó lấy dòng mới nhất **không lọc status**.
- [ ] **Step 8 [SỬA]: Chạy DB gates.** `node scripts/test-termination-refund-special-page.mjs`,
  `node scripts/reconcile-money.mjs 2026-07`, `node scripts/reconcile-money-v2.mjs 2026-07`; expected exact
  posting, zero double handling, zero money drift. **Pass = `exit 0`; `exit 3` KHÔNG phải pass.**

### Task 6: Authorized room lifecycle read model

**Files:** `supabase/migrations/20260731032500_room_lifecycle_read_rpc.sql`, `src/lib/roomLifecycle.ts`,
`src/lib/__tests__/roomLifecycle.test.ts`, `src/lib/__tests__/roomLifecycle.property.test.ts`,
`scripts/test-room-lifecycle.mjs`.

**[ĐỔI THỨ TỰ] — Task 6 tách làm hai phần vì tiền đề khác nhau:**

- **6A (Slice 2, KHÔNG bị chặn):** taxonomy + segments + mọi event **suy được từ dữ liệu hôm nay** —
  `CONTRACT_OPENED`, `DEPOSIT_RECEIVED`, `INVOICE_ISSUED`, `INVOICE_COLLECTION_POSTED`, `ROOM_CHANGED`,
  `TERMINATION_REQUESTED`, `SETTLEMENT_OFFSET_POSTED`, `DEPOSIT_FORFEIT_POSTED`, `VACANCY_STARTED`,
  `NEXT_CONTRACT_OPENED`, `CONTRACT_CLOSED`, `BROKER_COMMISSION_PAID`, `SALE_BONUS_PAID`.
- **6B (BLOCKED-BY Task 1 + Plan 1 Task 5):** `DEPOSIT_REFUND_PENDING` / `DEPOSIT_REFUND_POSTED` (cần
  obligation) và ba summary `trustedDepositHeld` / `virtualDepositHeld` / `legacyDepositUnknown` (cần
  `resolve_signed_contract_deposit_basis_v1`). `BROKER_COMMISSION_ELIGIBLE` cần rule của Plan 1.

  Tách như vậy **không giảm phạm vi**: 6B vẫn phải làm, chỉ là không được ship 6A rồi tuyên bố Task 6
  xong.

- [ ] **Step 1 [GIỮ]: Khóa event taxonomy.** `CONTRACT_OPENED`, `DEPOSIT_RECEIVED`, `SALE_BONUS_PAID`,
  `BROKER_COMMISSION_ELIGIBLE`, `BROKER_COMMISSION_PAID`, `INVOICE_ISSUED`, `INVOICE_COLLECTION_POSTED`,
  `ROOM_CHANGED`, `TERMINATION_REQUESTED`, `SETTLEMENT_OFFSET_POSTED`, `DEPOSIT_REFUND_PENDING`,
  `DEPOSIT_REFUND_POSTED`, `DEPOSIT_FORFEIT_POSTED`, `VACANCY_STARTED`, `NEXT_CONTRACT_OPENED`,
  `CONTRACT_CLOSED`. Đánh dấu rõ event nào thuộc 6A, event nào 6B.
- [ ] **Step 2 [SỬA]: Source-first attribution — và FORFEIT lấy nguồn từ PHIẾU.** Invoice/collection dùng
  invoice room snapshot; commission/Sale dùng signing residence segment; refund dùng termination settlement
  snapshot kể cả sau move-out; transfer dùng explicit old/new rooms **của cả hai đường** (§0.3); deposit
  dùng voucher/source snapshot khi trusted.
  **[SỬA] FORFEIT không có snapshot và sẽ không bao giờ có** — `terminate_contract_forfeit_impl`
  **không sinh phiếu hoàn**; `DEPOSIT_FORFEIT_POSTED` phải derive từ **8 phiếu
  `termination.forfeit_offset` + 8 phiếu `termination.forfeit_revenue` (31.000.000đ mỗi bên)** mà
  `statusMutations.ts:39-42` đã key sẵn. Câu 29/07 *"forfeit dùng termination settlement snapshot"* là
  **bất khả thi** cho nhánh chiếm **26/37 dòng** ⇒ phải viết lại.
  Segment-at-event-date chỉ fallback/cross-check. Mismatch emit `ROOM_SOURCE_MISMATCH`; missing chain emit
  segment conflict và loại khỏi trusted room total.
- [ ] **Step 3 [GIỮ]: Cash semantics và month attribution.** `posted_in/out` chỉ active posted real cash.
  Virtual `NOT_APPLICABLE`, pending obligation, internal offset/forfeit và reversal hiển thị riêng với
  `cash=false`; không cộng hai lần invoice payment + Finance posting cho cùng collection. Mỗi event giữ cả
  `eventDate`/`postedAt` và `serviceMonth`; invoice/fixed/commission dùng billing/service source month khi
  chứng minh được, refund/forfeit dùng settlement/posting event month. Monthly grouping không đổi ngày ghi
  sổ; source thiếu month vào warning/unattributed bucket thay vì đoán.
- [ ] **Step 4 [SỬA]: RPC/authz.** `get_room_cash_lifecycle_v1(p_room_id, p_from, p_to)` resolve
  room → building → org và áp §3.3. Return room, segments/cycles (**kèm `source_path`**), events, monthly
  rows (`depositIn`, `chargesCollected`, `commissionOut`, `refundOut`, `netPosted`, warnings), summaries
  `trustedDepositHeld`, `virtualDepositHeld`, `legacyDepositUnknown`; **không** expose một `depositHeld`
  giả như toàn bộ đều trusted. **Khai VOLATILE.** Ba summary thuộc **6B** (BLOCKED).
- [ ] **Step 5 [GIỮ]: Vacancy logic.** Chỉ tạo vacancy khi hai trusted residence ranges của cùng room có
  gap; internal same-day transfer không tạo vacancy. Overlapping contracts/ambiguous segments trả warning
  và không tự chọn winner.
- [ ] **Step 6 [GIỮ]: Query gate.** Một set-based payload, không query từng contract. Index
  `(organization_id, room_id, date)`, transfer composite, obligation active/termination và voucher source
  joins. Chạy `EXPLAIN (ANALYZE, BUFFERS)` trên room nhiều cycles.
- [ ] **Step 7 [SỬA]: Pure/property + DB tests.** Month grouping bảo toàn amounts; pending/noncash không
  vào posted net; sequential contracts/transfer/mismatch/ambiguous fixtures đúng taxonomy; cross-org
  `42501`. Nếu tạo view, `security_invoker=true` và chạy `node scripts/check-view-invoker.mjs`.
  **[SỬA]** Bỏ câu *"no jsdom tests"* như một lệnh cấm mọi DOM assertion: repo **đã có** harness
  `renderToStaticMarkup` trong environment `node` (15 file, mẫu `BuildingFilterSelect.test.tsx:19-27`) ⇒
  đẩy invariant render về unit test; **vẫn không thêm jsdom**.

### Task 7: Hooks và UI — `/thanh-toan` (Hoàn cọc), `/thu-tien` (Chu trình phòng), `/deposits`, contract detail

**Files:** toàn bộ paths ở §2.2, đặc biệt `src/hooks/useRoomCashLifecycle.ts`,
`src/hooks/useTerminationRefundQueue.ts`, `src/components/thu-tien/room-lifecycle/RefundPaymentDialog.tsx`,
`TerminationRefundCorrectionDialog.tsx`, `src/hooks/useDepositDashboard.ts`,
`src/pages/deposits/DepositsPage.tsx`, `src/hooks/contracts/useContractDetailData.ts`,
`src/components/contracts/detail/ContractSummary.tsx`, `src/components/income-expenses/IncomeExpenseForm.tsx`,
`src/hooks/income-expenses/financeV2Mutations.ts`, `src/hooks/income-expenses/statusMutations.ts`,
`src/pages/ThanhToan.tsx`, `src/pages/ThuTien.tsx`.

**BLOCKED-BY:** Task 4 (đọc) · Task 6 (lifecycle) · Task 1 Step 5 (dispatch `/thu-chi`) · Slice −1.6
(hoist state) · Slice −1.7 (`/deposits` reader + KPI).

- [ ] **Step 1 [SỬA]: Registry parity — hai entry, hai bề mặt, hai cổng quyền.** Theo §2.2:
  **`Hoàn cọc`** vào `FeeFamily`/registry/test/icons (`src/lib/feeCategories.ts`,
  `src/lib/feeCategories.test.ts`, `src/components/thu-tien/feeIcons.tsx`) và render bởi
  `PeriodFeePanel.tsx`/`PeriodFeeSheet.tsx` trên **`src/pages/ThanhToan.tsx`** (route gate
  **`thu_tien.collect`**, `App.tsx:367`); **`Chu trình phòng` KHÔNG vào registry** — nó là panel theo
  phòng trên **`src/pages/ThuTien.tsx`** (route gate **`thu_tien.view`**, `App.tsx:363`).
  Desktop/mobile menus đã iterate registry nên `Hoàn cọc` tự hiện ở cả hai. Refund category mở queue (không
  có ô nhập amount); lifecycle mở panel read-only. **Preserve existing ten keys/URLs.**
  **[THÊM]** Ghi tường minh vào plan: **không hứa** một manager chỉ có `thu_tien.view` tới được nút
  Hoàn cọc; test *"view-only đọc được queue"* viết ở **tầng RPC** (§2.2, §3.3).
  **[THÊM]** Tiêu thụ state đã hoist ở Slice −1.6 (`usePeriodFeeState`/`useUtilityPayState` gọi **một
  lần** ở `ThanhToan.tsx`), **không** tạo instance thứ ba. **Đừng** đụng `useReceiptPasteTarget` —
  arbitration cấp module ở `:27-31`/`:86-93` đã vá đúng bug 28/07 và có spec hồi quy.
- [ ] **Step 2 [SỬA]: Hooks một payload và fail-closed status batching.** `useRoomCashLifecycle` key gồm
  org/building/room/range; `useTerminationRefundQueue` gọi authorized list/preview/submit. Refund check chỉ
  enable khi authoritative preview/route trả `POSTABLE`/`CANONICAL`; route loading/error/unknown/OFF/SHADOW/
  FROZEN **không** fallback sang termination legacy writer. `useDepositDashboard` dùng pure helper
  `terminationRefundStatuses.ts` để unique/sort termination ids, chia chunk **≤500**, gọi tất cả chunks,
  rồi **chỉ publish khi mọi chunk thành công** và response có **đúng một row cho mỗi requested id**; một
  chunk lỗi/thiếu/thừa/trùng row làm fail toàn query, **không** render partial "Đã hoàn". Unit fixtures bắt
  buộc 0/1/500/501/1201 ids.
  **[GHI RÕ]** phần chunking là **additive, không corrective**: `useDepositDashboard` **đã** cap-1000-safe
  (`:239-261` `fetchAllRows` với `.order('termination_date').order('id').range(from,to)`).
  **[SỬA] Invalidate**: terminations, contracts, lifecycle, deposit dashboard, income-expenses, postings và
  accounts-with-balance sau success/reversal. **Và phải thêm 4 query key ĐANG CÓ mà hub đang thiếu**
  (`C-INFRA-7`): `['period-fee-status']`, `['period-commissions']`, `['period-maintenance']`,
  `['fee-accounts']`; cộng `building_fee_accounts`/`building_utility_accounts` **vắng hẳn** khỏi
  `SYNC_TABLES`. Cập nhật `docs/he-thong/realtime-sync.md:32-33` (còn ghi `accounts`/`payments` là "chưa có
  realtime").
  **[THÊM]** Sửa `useRealtimeDataSync.test.ts` theo §2.2 (**ba assertion**, **không** nới `toEqual`).
  **[THÊM]** `useRealtimeDataSync.ts:293 let hubActive = false` là singleton cấp module: instance thứ hai
  return `undefined` (không cleanup), cleanup của instance đầu `removeChannel` ⇒ instance sống sót
  **vĩnh viễn không subscribe**. Hôm nay chỉ mount một lần (`App.tsx:236`) nên invariant còn đúng, nhưng
  refactor mount-topology do plan gây ra là trigger hợp lý ⇒ thêm ref-count + test hai consumer +
  `subscribe((status) => …)` log `CHANNEL_ERROR` (hiện `:343` là `channel.subscribe()` trần)
  (`C-INFRA-6`).
- [ ] **Step 3 [SỬA]: Refund queue/dialog.** Group building → room; canonical amount read-only; hiển thị
  breakdown, **`deposit_subtotal` tách riêng khỏi `other_subtotal`**, real/virtual/legacy deposit basis,
  remaining, conflict. Manager chọn sổ thật + evidence + check. Success nói *"Đã duyệt và đã ghi sổ"*;
  không có "duyệt sau" cho exact special action.
- [ ] **Step 4 [GIỮ]: Lifecycle UI.** Building → room → period/current contract; desktop lane/mobile
  sequence; detail source attribution (**kèm `source_path` của segment**) và monthly trusted/virtual table.
- [ ] **Step 5 [SỬA]: `/deposits`, contract detail và traditional edit/decision UI — bốn bề mặt, không
  hai.**
  **(a) `/deposits` bảng:** gọi chunked status RPC có `deposits.view`, group/filter bằng snapshot
  `building_id`/`room_id`; attribution conflict hiển thị warning và **không** fallback room hiện tại.
  Amount canonical, "Đã hoàn" **chỉ khi** POSTED + active posting (bỏ cả `refund_date` lẫn `COMPLETED` —
  quy tắc thật nằm ở `useDepositDashboard.ts:282 refund_done: !!t.refund_date || t.status === 'COMPLETED'`,
  tiêu thụ ở `DepositsPage.tsx:485`, **không** phải một clause trong `DepositsPage.tsx` như bản 29/07
  viết).
  **(b) `/deposits` ô KPI:** đọc `get_refund_forfeit_summary` đã sửa ở Task 4 Step 3b. **Bắt buộc**: KPI và
  tổng cột của bảng **phải khớp**.
  **(c) Số âm:** nhánh REFUND phải render **"Khách còn nợ"**, tái dùng cách xử lý `stillOwed` hiện đang bị
  giới hạn trong nhánh FORFEIT (`DepositsPage.tsx:448`, `:474-484`). Fixture: `ba7e21ea` và `3eb5e759`
  (HĐ DEMO `HD-2026-00015`/`00016`, `refund_amount = −2.241.000`, đang hiện tick xanh **"Đã hoàn 0đ"** vì
  nhánh REFUND clamp `Math.max(0, …)`).
  **(d) Contract detail — PHẢI đổi HAI nhãn, không một:** `useContractDetailData.ts` gọi single-contract
  RPC có `contracts.view`; `ContractSummary.tsx:100-108` đổi nhãn `'Hoàn lại khách:'` +
  `Math.max(refund_amount, 0)` thành **"Net settlement lịch sử"**, và hiển thị canonical obligation riêng.
  **[THÊM]** `ContractSummary.tsx:174` (card *"Đã thu"*) **cũng phải sửa/ghi chú**: HĐ `69cdb5dc` có
  `total_deposit = 3.500.000`, `deposit_paid = 0.00`, `deposit_remaining = 3.500.000` ⇒ trang **đang hiện
  đồng thời** *"Đã thu 0đ"* (`:174`) và *"Hoàn lại khách 2.428.500đ"* (`:105-109`) cho **cùng một hợp
  đồng**. Cùng mẫu ở HĐ `5f8b433f` (102LVT/103): `total_deposit 4.000.000`, `deposit_paid 0.00`, refund
  3.509.500. Task 7 Step 5 bản 29/07 **chỉ đổi một trong hai** ⇒ mâu thuẫn vẫn còn trên trang.
  **(e) Cảnh báo "Phiếu thanh lý chờ xử lý":** thay matcher `notes LIKE '[HOÀN KHÁCH THANH LÝ]%'` +
  `.eq('approval_status','UNAPPROVED')` (`useContractDetailData.ts:52-73`) bằng correlation
  source/obligation tường minh, **và nới** để cảnh báo cả owned `APPROVED + UNPOSTED`. Thêm guard test:
  số cảnh báo **không** âm thầm tụt về 0 sau khi migration canonicalization đổi note. (Hiện nó nhận ra
  **4/20** phiếu hoàn, và phiếu đã duyệt-chưa-vào-sổ **không được cảnh báo ở đâu cả**.)
  **(f) `/thu-chi` + approvals:** desktop/mobile và approvals lookup **nguồn phiếu đã đông cứng +
  trạng thái obligation** trước global route rồi dispatch named termination wrappers; ordinary
  edit/decision unchanged. Owned termination amount/items disabled; owner correction mở controlled
  settlement. **Giữ nguyên substring `owned by system flow`** cho tới khi routing ownership-first lên.
- [ ] **Step 6 [SỬA]: Regression — HAI CA LỆCH, HAI CHIỀU, cộng ba ca đối chứng.** Bản 29/07 chỉ có
  `2.428.500/1.450.000`. Bộ fixture bắt buộc:

  | # | Termination · HĐ · phòng | Generated `refund_amount` | Phiếu chi thật | Lệch | Kỳ vọng UI |
  |---|---|---:|---|---:|---|
  | (a) | `ec0e00e7-35b2-47e3-897e-1e09b745e88c` · `69cdb5dc` · 417LVT / **L04** | **2.428.500** | `PC2607119` (`da42f5d6`) **1.450.000**, 1 item `DEPOSIT`, APPROVED+POSTED, posting `f6d0de10` | **−978.500** | payable **1.450.000**; 2.428.500 chỉ ở nhãn historical/warning |
  | (b) | `a1ee1eb7-a7f8-427b-be5e-c1406e91012c` · `06440526` · 481NVK / **09** | **2.352.000** | `PC2607104` (`c6e42df0`) **2.852.000** = `DEPOSIT` 2.352.000 + `PNL` **500.000**, APPROVED+POSTED | **+500.000** | ô cọc hiện **2.352.000** (deposit subtotal), phần 500.000 hiện riêng; **vắng khỏi cả ba plan doc 29/07** |
  | (c) | `c4c69c17-4f34-4f0b-9224-c1fd2e786d8a` · `5f8b433f` · 102LVT / **103** | **3.509.500** | `PC2607153` (`975a5afb`) **3.509.500** | **0** | **UNAPPROVED + UNPOSTED** ⇒ **KHÔNG** được hiện "Đã hoàn" |
  | (d) | `6837641f`, `46b88b9f`, `75debc04` (DEMO) | — | `PC2607001`/`PC2607008`/`PC2607010` (50.000/40.000/30.000), UNAPPROVED+UNPOSTED, `account_id` NULL, item `PNL` | — | **KHÔNG** hiện "Đã hoàn" dù có `refund_date` |
  | (e) | `ba7e21ea`, `3eb5e759` (DEMO) | **−2.241.000** | không phiếu | — | **"Khách còn nợ"**, không phải "Đã hoàn 0đ" |

  **[THÊM] Vì sao ca (a) là SAI, không phải làm tròn** (`[A0.R1]`): cột GENERATED dùng **cọc HỢP ĐỒNG**
  (`contracts.total_deposit = 3.500.000`) trong khi **cọc duy nhất từng được ghi** là phiếu **ảo đầu kỳ**
  `PT2607060` (`system_source='contract.deposit'`, APPROVED, `posting_status='NOT_APPLICABLE'`, 1 item
  `DEPOSIT` **1.450.000**, description *"Tiền cọc đầu kỳ (khách đã đóng trước khi dùng phần mềm)"*), **và**
  nó trừ tiếp một khấu trừ có phiếu **đã CANCELLED** (`PC2607118` *"Cấn cọc chuyển doanh thu"* 1.071.500,
  `system_source='termination.offset'`, `CANCELLED`/`NOT_APPLICABLE`) mà
  `early_termination_fee = 1.071.500` **vẫn nuôi công thức**. Tức
  `2.428.500 = 3.500.000 (chưa bao giờ thu) − 1.071.500 (chưa bao giờ vào sổ)`.
  **[THÊM] KHÔNG có một ca POSTED canonical ĐÚNG nào trên production** để làm mốc (ca (a) lệch, (b) lệch,
  (c) khớp nhưng chưa post) ⇒ **gate "exact hash/amount" phải seed từ fixture DEMO tự dựng**, không được
  neo vào dữ liệu thật.
  **[THÊM] Assertion KPI (bắt buộc, bản 29/07 không có):** trước/sau theo org —
  `aaaa` **8.290.000đ / 3 lần → 4.302.000đ / 2 lần**; `dddd` **700.000đ / 8 lần → 0**. Nếu ai muốn nêu con
  số **8.990.000đ / 11 lần** thì phải kèm nhãn *"tổng cross-org đọc bằng service-role, không người dùng nào
  thấy"*.
  **[THÊM] Baseline trạng thái `/deposits`:** trong **11 termination dạng trả phòng**, **7 dòng đang hiện
  tick xanh "Đã hoàn" mà không có một phiếu chi nào được ghi sổ** và **2 dòng hiện sai số** ⇒ áp luật mới
  thì **9/11 dòng đổi trạng thái hoặc đổi số**. Và **23/56** HĐ `TERMINATED` không có dòng termination nào
  (14 trong đó **vẫn có** phiếu hoàn) ⇒ **hàng đợi tin cậy lúc go-live có thể RỖNG** — đó là kết quả đúng,
  không phải bug.
- [ ] **Step 7 [SỬA]: Performance/accessibility.** Desktop/mobile **chia sẻ query state** (state đã hoist ở
  Slice −1.6); memoized maps, keyboard/focus/text/console gates. **[BỎ]** câu *"mount one surface"* — hai
  bề mặt cùng mount là **chủ ý sản phẩm** (`thu-tien.css:439-444`) và **có spec bảo vệ**
  (`.e2e-fleet/specs/thanh-toan-page.spec.ts:20`/`:27`/`:32`; mobile dùng `toBeHidden()` ở `:143` ⇒ cả hai
  component **luôn** mounted, chỉ CSS ẩn). Unmount theo breakpoint sẽ làm `:32` **đỏ** và phá
  `utility-paste-receipt.spec.ts:46-49` hoặc `:151-160`. **[BỎ]** *"no jsdom tests"* như lệnh cấm — xem
  §2.3.

### Task 8: Verification, rollout và rollback

**Files:** `scripts/audit-room-lifecycle-rollout.mjs`, `.e2e-fleet/specs/room-lifecycle.spec.ts`,
`.e2e-fleet/specs/termination-refund-special-page.spec.ts`, `.e2e-fleet/specs/deposit-refund-status.spec.ts`,
`docs/superpowers/runbooks/2026-07-31-room-lifecycle-refund-rollout.md`.

**BLOCKED-BY:** tất cả Task trên · `C-ROLL-1` (chưa có đường có kiểm toán để bật `force_freeze`) ·
`C-ROLL-3` (không có gì trong app lật được route).

- [ ] **Step 1 [SỬA]: Rehearse exact full chain — theo tên file MỚI.** Disposable clone chạy đúng thứ tự:
  `20260731010000_special_page_runtime.sql` → `20260731010500_contract_transfer_audit_hardening.sql` →
  `20260731011000_room_residence_segments.sql` → `20260731030000_termination_settlement_snapshot.sql` →
  `20260731031000_termination_refund_obligations.sql` →
  `20260731031500_termination_writer_canonicalization.sql` →
  `20260731032000_termination_refund_read_rpcs.sql` → `20260731032200_realtime_termination_tables.sql` →
  `20260731032500_room_lifecycle_read_rpc.sql` → `20260731033000_termination_lifecycle_backfill.sql` →
  **`20260731034000_termination_refund_special_writer.sql` với mọi route OFF**. Chỉ sau khi toàn bộ
  migration/test pass mới apply production đúng cùng thứ tự. Compare lifecycle/deposit/refund totals.
  **Never call fake `--dry-run`** (`apply-sql.mjs` hard-code production ref).
  **[THÊM] Rehearsal phải là CLONE CỦA PRODUCTION**, vì Đợt 0–6 khi đó đã thường trú và mọi guard được
  luyện. Nếu clone **không** mang được, phải ghi thẳng vào plan rằng rehearsal **không bao phủ**
  `a02_ie_profit_lock_*`, `trg_ie_check_lock_ins`, nhánh ANNOTATE của
  `guard_income_expense_owned_payload`, và `DO $guard$` của `20260730280000` — và phải có bộ test riêng
  chạy thẳng trên prod trong `BEGIN … ROLLBACK`. **Không tài liệu nào được gọi là "dry-run production".**
  **[THÊM]** Preflight: **fail nếu timestamp mới trùng bất kỳ file đã có**; và mọi kiểm "đã apply chưa"
  dùng **catalog**, không dùng `schema_migrations` (đã chết).
- [ ] **Step 2 [SỬA]: Hai feature route — viết theo cặp stored-vs-evaluated.** Bật
  `termination_refund.obligation_birth.v1` `SHADOW → CANARY (DEMO) → ON` trước; chỉ sau khi cohort mới có
  zero orphan/mismatch mới bật `termination_refund.special_page.v1` theo cùng sequence. Stored modes chỉ
  `OFF|SHADOW|CANARY|ON`; `ON → CANONICAL`; `force_freeze=true → FROZEN`.
  **[BỎ]** mọi câu dạng *"assert stored mode='OFF' cho production trong lúc canary"* — `server_feature_flags`
  **không có `organization_id`** (PK = `feature_key`) nên *"prod OFF + DEMO CANARY"* là **bất khả**
  (`C-ROLL-2`).
  **[THÊM]** Flip `SHADOW → CANARY` **đẩy org thật từ SHADOW về LEGACY** ⇒ **thu đủ parity report TRƯỚC khi
  rời SHADOW** (tiền lệ: `invoice.collection.v5` chỉ có **85 phút** cửa sổ shadow, 22/07 05:38:50 →
  07:03:53).
  **[SỬA] `set_feature_route_v1` — tên tham số thật và ràng buộc cứng** (`C-ROLL-3`): signature là
  `(p_feature_key, p_expected_config_version, p_mode, p_starts_at, p_ends_at, p_max_operation_count,
  p_max_single_amount_vnd, p_max_total_amount_vnd, p_commit_sha, p_migration_sha256,
  p_maintenance_window_id, p_approval_reference, p_actor, p_reason) RETURNS bigint`. Bản 29/07 đúng **thứ
  tự** nhưng **sai 3 tên** ⇒ gọi named-arg sẽ `42883`. Khi `mode IN ('ON','CANARY')`: `p_commit_sha` phải
  khớp `^[0-9a-f]{40}$`, `p_migration_sha256` khớp `^[0-9a-f]{64}$`, `maintenance_window_id` và
  `approval_reference` khác rỗng, else `22023`. ACL **chỉ `postgres=X`** — `service_role` bị từ chối ⇒
  **không có đường nào trong app lật được route**; plan **phải ghi rõ ai chạy và chạy bằng gì** (Management
  API với role `postgres`), và chuẩn bị sẵn giá trị 40-hex/64-hex trước maintenance window.
  **[THÊM]** Đặt `max_operation_count` **rộng tay** (tiền lệ prod: `2147483647`) và ghi rằng `ends_at`
  **không làm gì** khi `mode='ON'`. Max-single của submit phải ≥ obligation trusted lớn nhất của cohort.
  **[THÊM]** Không chạy `set_feature_route_v1` cùng lúc với batch writer (`claim_feature_operation_v1` lấy
  dòng cờ `FOR SHARE`, `set_feature_route_v1` lấy `FOR UPDATE` ⇒ chặn nhau).
- [ ] **Step 3 [GIỮ]: Cohort.** Chỉ terminations có sticky canonical marker sinh khi stored birth route
  `CANARY`/`ON` đã evaluate `CANONICAL`, có snapshot + owned canonical voucher + obligation trusted được
  submit. Legacy subject chưa marked ở OFF/SHADOW chỉ read/conflict; **không** auto-fill. Marker đã sinh
  giữ canonical behavior qua mọi CAS rollback của global route. Owner sign-off riêng cho birth route và
  submit route.
  **[THÊM] Ngưỡng kiểm cohort:** hàng đợi org thật **≤ 3 dòng**. Lớn hơn nghĩa là emitter đang sinh nghĩa
  vụ hoàn cho cả những ca khách còn nợ (§Task 3 Step 4).
  **[THÊM] Thứ tự bắt buộc:** **routing ownership-first ở frontend + 5 named wrapper phải ship TRƯỚC khi
  bật birth CANARY.** Nếu tách (birth CANARY trước, routing sau) thì trong khoảng giữa, một phiếu hoàn
  canary mở trên `/thu-chi` vẫn đập vào **11 RPC generic** assert `'CANONICAL_INCOME_EXPENSE'` và ném
  `42501` (`[X9.1]` residual, `danh-gia v2 §7` Slice 6).
- [ ] **Step 4 [SỬA]: Static/type/security gates.** Chạy `npm run gen:types` sau apply (**không redirect**),
  verify generated header/diff, `npm run typecheck:baseline`, targeted Vitest (status chunking + owned
  routing + roomLifecycle), DB/concurrency scripts, `check-definer-acl`, `check-approver-provenance`,
  `check-view-invoker`, hai money reconciliations.
  **[THÊM]** `node scripts/check-stable-fn-locks.mjs` (**sau MỌI migration tạo/sửa hàm**; nó **không có CI
  coverage**) và `node scripts/check-permission-catalog.mjs` (**gate CI bắt buộc**,
  `ci-gates.yml:135-138`, cần PAT).
  **[BỎ]** `node scripts/check-technical-membership-isolation.mjs` — script này **chưa tồn tại** và theo
  `A-SVC` không còn deliverable để gác.
  **[THÊM]** Ghi rõ vùng mù: `check-definer-acl.mjs` chỉ test `anon`, hai gate ACL/view hard-scope schema
  `public`; `.e2e-fleet`/`scripts` không được typecheck; `npx vitest run` toàn repo **đỏ sẵn**.
- [ ] **Step 5 [GIỮ]: Headless E2E sau deploy.** Chỉ write org DEMO
  `dddd0000-0000-4000-8000-000000000001`, org thật read-only, cleanup trong `finally`. Test: two contracts
  same room, completed transfer, **transfer đi ĐƯỜNG B**, incomplete transfer diagnostic, trusted/virtual
  deposit, exact refund, replay, `APPROVED+UNPOSTED` special completion, manual race, reversal/replacement,
  sticky marked subject sau route OFF, `/deposits` snapshot attribution/status **và KPI khớp bảng**,
  cross-org list/preview/submit denial, console clean.
  **[THÊM]** Hai spec **đang xanh phải giữ xanh** như gate: `specs/thanh-toan-page.spec.ts` và
  `specs/utility-paste-receipt.spec.ts`. Ba spec mới của Plan 2 **chưa tồn tại**.
- [ ] **Step 6 [SỬA]: Rollback/freeze — và nói thật về `force_freeze`.** CAS submit route về `OFF` để tắt
  special submit. CAS birth route về `OFF` chỉ đưa **subject chưa có marker** về legacy birth; subject đã
  canonical vẫn đi emitter/owned adapters để không sinh voucher thứ hai. `SHADOW` chỉ projection/compare
  rồi legacy birth cho subject chưa marked. `force_freeze=true` là emergency stop fail-closed cho
  birth/correction/submit mới, **không** fallback legacy; vẫn giữ queue/lifecycle, traditional decisions hợp
  lệ và canonical reversal. Không drop marker/obligation/snapshot/postings và không sửa canonical voucher
  lịch sử.
  **[SỬA] `C-ROLL-1`:** `set_feature_freeze_v1` **không tồn tại**, và **không một function nào trong toàn
  DB ghi cột `force_freeze`** (8 hàm chỉ đọc; `set_feature_route_v1` UPDATE đúng 13 cột và **không có**
  `force_freeze`). ⇒ Freeze hôm nay = **UPDATE tay**, **không sinh** `server_feature_flag_events`, **không
  bump** `config_version` (bằng chứng: `income_expense.profit_close.v2` có `force_freeze=true`,
  `config_version=1`, **0 event**). Chọn **một** và ghi vào plan: **(A)** viết
  `set_feature_freeze_v1(p_feature_key, p_expected_config_version, p_freeze, p_actor, p_reason,
  p_approval_reference)` có CAS + `INSERT server_feature_flag_events` (`FREEZE_SET`/`FREEZE_CLEARED`) +
  REVOKE khỏi PUBLIC/anon/authenticated/service_role + vào `check-definer-acl`; **hoặc (B)** ghi thẳng rằng
  freeze là một UPDATE tay qua Management API và **phải lập biên bản**. **Không được** tuyên bố "có runbook
  rollback đã kiểm toán" trước khi giải quyết việc này.
  **[THÊM]** Sổ nhật ký rollout **không đầy đủ**: 7/28 cờ có `config_version > 1` mà **ZERO event** ⇒
  (a) **không đọc `expected_version` từ sổ event**; (b) mọi tuyên bố *"rollback có kiểm toán"* hiện
  **không có tiền lệ thật**.

---

## 5. Exact commands và expected gates

```bash
node scripts/test-contract-transfer-segments.mjs
node scripts/test-termination-obligations.mjs
node scripts/test-termination-refund-reads.mjs
node scripts/test-termination-refund-special-page.mjs
node scripts/test-room-lifecycle.mjs
npx vitest run src/lib/__tests__/roomLifecycle.test.ts src/lib/__tests__/roomLifecycle.property.test.ts src/lib/__tests__/terminationRefundStatuses.test.ts
npx vitest run src/hooks/__tests__/terminationRefundRouting.test.ts src/hooks/__tests__/useRealtimeDataSync.test.ts
npx vitest run src/lib/__tests__/feeCategories.test.ts
node scripts/audit-room-lifecycle-rollout.mjs --mode preflight
node scripts/check-stable-fn-locks.mjs          # THÊM — sau MỌI migration tạo/sửa hàm; KHÔNG có CI coverage
node scripts/check-permission-catalog.mjs        # THÊM — gate CI bắt buộc (ci-gates.yml:135-138), cần PAT
node scripts/check-definer-acl.mjs
node scripts/check-approver-provenance.mjs
node scripts/check-view-invoker.mjs
node scripts/reconcile-money.mjs 2026-07         # pass = exit 0; exit 3 (INCONCLUSIVE) KHÔNG phải pass
node scripts/reconcile-money-v2.mjs 2026-07
npm run typecheck:baseline
```

**Bốn thay đổi so với bản 29/07:**

1. **THÊM `check-stable-fn-locks.mjs`** — tự khai *"GOTCHA đã có án lệ (5 lần)… CHẠY SAU MỌI MIGRATION
   TẠO/SỬA HÀM. Exit 1 nếu có hàm hở"*. Nó **không có CI coverage** ⇒ vắng nó là **zero backstop** cho đúng
   lớp bug đã giết `profit_close_state_v2` mười ngày.
2. **THÊM `check-permission-catalog.mjs`** — đã là gate CI bắt buộc; Plan 2 chạm permission key
   (`deposits.view`/`deposits.refund`/`thu_tien.*`) ⇒ bắt buộc.
3. **BỎ `check-technical-membership-isolation.mjs`** — script **chưa tồn tại** và không còn deliverable để
   gác (`A-SVC`).
4. **SỬA cách đọc `reconcile-money.mjs`** — pass = `exit 0`; `exit 3 (INCONCLUSIVE)` **không** phải pass;
   nó cần `signInWithPassword` nên **không headless-CI-safe**. Fallback: chọn kỳ >1000 phiếu, hoặc dùng
   `reconcile-money-v2.mjs`.

**Sáu script trong khối trên CHƯA TỒN TẠI và phải được tạo** — đừng viết chúng vào gate như thể đã có:
`test-contract-transfer-segments.mjs`, `test-termination-obligations.mjs`,
`test-termination-refund-reads.mjs`, `test-termination-refund-special-page.mjs`, `test-room-lifecycle.mjs`,
`audit-room-lifecycle-rollout.mjs`. Mọi script preflight phải ghi timestamp, `organization_id`, query hash,
**digest của `public.fee_type_matches` + `public.nrm_vn`**, rồi so **delta với baseline đã ghi** — không so
bằng tuyệt đối.

Expected: exit 0; no new money mismatch; no unowned new termination refund voucher; cross-org reads/writes
`42501`; two-session tests không deadlock/double post.

**Ngoài lệnh tổng, gate bắt buộc phải có two-session/negative test cho:** refund submit vs manual
edit/approve/post/reversal · canonical subject retry sau route OFF · list/preview/status cross-org ·
status chunk 501 và 1201 · `/deposits` không báo đã hoàn trước active posting và không dùng phòng hiện tại ·
**KPI khớp tổng cột bảng** · **`0A000` của `dispatch_finance_decision_v2`** · **`25006` của một read RPC
khai STABLE** · **replay idempotency KHÔNG ném `23505`** · **huỷ phiếu hoàn canonical không có dòng
reservation `HELD`** (§3.6) · **ANNOTATE trên phiếu hoàn POSTED** (quyết định của chủ, dù đường nào cũng
phải có test) · **`cancel_income_expense_flex_v1` trên phiếu flow-owned ⇒ `[NOT_MANUAL]`** · **client có
`contracts.edit` UPDATE `contract_terminations` ⇒ 55000/42501** · **`payments` guard không rơi vào
`RETURN NEW` và không ném `55000`**.

Sau deploy mới chạy fleet:

```powershell
Set-Location .e2e-fleet
$env:FLEET_PASS_CHUNHA = '<runtime secret>'
$env:FLEET_PASS_KETOAN = '<runtime secret>'
$env:FLEET_PASS_QUANLY = '<runtime secret>'
$env:FLEET_WORKERS = '8'
npx playwright test specs/thanh-toan-page.spec.ts specs/utility-paste-receipt.spec.ts specs/room-lifecycle.spec.ts specs/termination-refund-special-page.spec.ts specs/deposit-refund-status.spec.ts
```

Hai spec đầu là **gate hồi quy** (đang xanh, phải giữ xanh) — bản 29/07 không có `thanh-toan-page.spec.ts`
vì file đó chưa tồn tại lúc viết plan. `.e2e-fleet` mặc định **headless** (`playwright.config.ts:15`),
`FLEET_WORKERS` default 8, `FLEET_BASE_URL` default `https://ptcrm.vercel.app`, `slowMo 350` chỉ khi
`FLEET_HEADED`; mật khẩu chỉ đến từ `FLEET_PASS_*` và thiếu thì throw tiếng Việt rõ ràng
(`specs/auth.ts:19-23`, `:30-39`). Passwords lấy runtime từ `CLAUDE.local.md`, **không in, không commit**;
**không** chạy headed nếu chủ không yêu cầu tường minh.

Sau khi mở production route theo cohort: giữ canary/monitor **≥ 24 giờ**, đối chiếu
duplicate/orphan/money drift **theo `organization_id`**. Bất kỳ drift nào ⇒ bật `force_freeze` để dừng
writer mới, **không** tự rơi về legacy — nhắc lại: hôm nay **không có lệnh có kiểm toán nào** để bật
`force_freeze` (Task 8 Step 6).

## 6. Commit checkpoints

| Sau task | Commit message |
|---|---|
| 0 | `fix(hop-dong): make room transfer audit fail closed on both paths` |
| 1 | `feat(db): add immutable termination refund obligations` |
| 2 | `fix(thanh-ly): emit canonical frozen refund vouchers` |
| 3–4 | `feat(db): add authorized refund and lifecycle read models` |
| 5 | `feat(thu-tien): post exact termination refund obligations` |
| 6–7 | `feat(thu-tien): add room lifecycle and canonical refund status` |
| 8 | `test(thu-tien): verify refund lifecycle rollout and reconciliation` |

Stage **đúng file/hunk của task**, liệt kê tên cụ thể — **không** `git add -A`, **không** `git add .`. Cây
làm việc repo này thường xuyên có hàng chục file dở dang từ phiên khác (ảnh chụp `git status` lúc viết bản
này có **7 file M + 20 mục `??`**), gom nhầm chúng vào commit của mình là lỗi nặng. Riêng ba file `M`
`RequirePermission.tsx` / `useIsAdmin.ts` / `useMyPermissions.ts` cộng ba file test untracked của chúng phải
được **commit riêng** (`B14`) — một `git clean` sẽ **xoá** chúng.

Trailer: theo đúng tác nhân chạy phiên. `CLAUDE.md` quy định trailer cho phiên Claude; bản 29/07 ghi
`Co-Authored-By: Codex <noreply@openai.com>`. Nếu remote diverged, dừng sau lần push thường thất bại;
**không** force-push, **không** tự merge unrelated work. Push bằng `git push origin HEAD:main` sau khi
`git merge-base --is-ancestor origin/main HEAD` xác nhận fast-forward.

## 7. Definition of Done

- **Tiền đề:** `20260731010000_special_page_runtime.sql` đã apply và xanh gate **trước** khi bất kỳ Task
  1–5 nào bắt đầu; Slice −1.7/−1.8/−1.9 đã xanh trước khi Task 4/7 tuyên bố xong (§0.0, §0.5).
- New termination không thể commit refund voucher thiếu snapshot, obligation hoặc ownership freeze; và
  emitter set `contract_terminations.refund_method` nên không bao giờ vỡ `23514`.
- Mỗi termination có tối đa một active `PENDING|POSTED|CONFLICT` obligation; `RELEASED|REVERSED` cho audited
  replacement. Release có **đường máy** (trigger `AFTER UPDATE`), không chỉ đường người.
- **Ba** termination writer SQL đi qua canonical emitter; writer **thứ tư phía client đã bị xoá**; chuỗi
  FORFEIT có attribution và có quyết định tường minh về audit insert bị nuốt.
- `contract_terminations` **không** còn sửa được input quyết toán qua REST (REVOKE hoặc guard trigger), nên
  snapshot bất biến bảo vệ **cả** hàng nguồn.
- Queue/preview/status/lifecycle đều authorize từng building và không lộ cross-org data; **mọi read RPC khai
  VOLATILE** và `check-stable-fn-locks.mjs` xanh.
- Exact check trên trang đóng tiền không nhận amount/raw attachment, recheck header/items/hash dưới lock,
  link finalized evidence rồi mới `APPROVED + POSTED`; valid owned `APPROVED + UNPOSTED` cũng hoàn tất được
  đúng một lần; replay cùng key + hash **không** ném `23505`.
- Refund post/reversal dùng ngày trong kỳ mở và provenance `TERMINATION_REFUND + obligation_id`, không bao
  giờ giả `MANUAL`, và **không** có posting `LEGACY_BRIDGE` nào sinh ra.
- Manual edit/post race không thể đổi canonical amount hoặc tạo active posting thứ hai; và
  `guard_income_expense_owned_payload` cho phép set-once `account_id`/`voucher_date` **bằng một allowlist đã
  mở rộng tường minh**, không bằng giả định.
- Vấn đề `attachments`/`notes` vs ANNOTATE **đã được quyết** (loại khỏi frozen set + header hash, **hoặc**
  có carve-out của chủ), và có test cho ANNOTATE trên phiếu hoàn POSTED.
- Phiếu hoàn canonical **huỷ được** qua đường UI đã ship — `decide_owned_income_expense_v2` không còn ném
  `P0002` cho nó (nhánh A hoặc B của §3.6 đã thi hành), nhánh lai của
  `reserve_invoice_refund_obligation_v2` đã bị chặn/xoá, và số phận adapter `TERMINATION_MOVE_OUT_PAIR` đã
  được ghi tường minh.
- `/deposits`: chunk status ids ≤ 500, fail toàn query nếu response thiếu/lỗi, dùng snapshot room/building,
  chỉ ghi "Đã hoàn" khi canonical obligation có active posting, hiện **"Khách còn nợ"** cho net âm, và
  **ô KPI khớp tổng cột bảng** (`aaaa` 8.290.000đ/3 lần → 4.302.000đ/2 lần; `dddd` 700.000đ/8 lần → 0).
  Generated `refund_amount` không còn là payable truth ở bất kỳ đâu.
- Contract detail **không** còn hiện đồng thời *"Đã thu 0đ"* và *"Hoàn lại khách 2.428.500đ"* cho cùng một
  hợp đồng; cảnh báo phiếu thanh lý chờ xử lý nhận cả owned `APPROVED + UNPOSTED` và không dò `notes LIKE`.
- Completed `ROOM_CHANGE|BOTH_CHANGE` dùng move-out/move-in effective dates; **đường trigger
  DRAFT→APPROVED đã được phủ hoặc vô hiệu hoá**; mốc đoạn đầu **không** neo vào `contracts.start_date`;
  audit thiếu/ambiguous không fallback current room.
- Invoice, commission và refund events ưu tiên source snapshot đúng vòng đời; `DEPOSIT_FORFEIT_POSTED`
  derive từ hai họ phiếu `termination.forfeit_*`; room reconciliation chỉ cộng phần chứng minh được.
- Canonical subject marker là sticky: rollback birth route không bao giờ cho cùng termination quay lại sinh
  legacy refund. `evaluate_feature_route` được gọi **đúng một lần** mỗi transaction.
- **Routing ownership-first + 5 named wrapper đã ship TRƯỚC khi bật birth CANARY**; substring
  `owned by system flow` được giữ nguyên; ordinary `/thu-chi`/contract/invoice-refund quyền và approval
  semantics không đổi, còn phiếu hoàn owned đi qua wrapper có tên với **đúng bộ quyền cũ**.
- `contract_terminations` (và `contract_transfers` nếu cần) đã vào publication `supabase_realtime`; 4 query
  key đang thiếu đã được thêm vào hub; `docs/he-thong/realtime-sync.md` đã cập nhật.
- Backfill report theo `organization_id` (so **delta**, không so tuyệt đối), typecheck baseline,
  DB/concurrency/E2E, ACL/provenance/view/permission-catalog/stable-fn-locks và hai money reconciliation
  (**exit 0**) đều xanh trước production ON.
- Bộ fixture hồi quy phủ **cả năm ca** ở Task 7 Step 6, và gate "exact hash/amount" được seed từ **fixture
  DEMO tự dựng** vì production **không có** một ca POSTED canonical đúng nào.
- Đường bật/tắt `force_freeze` đã được quyết (viết `set_feature_freeze_v1` **hoặc** ghi rõ là UPDATE tay có
  biên bản) trước khi tuyên bố có runbook rollback.

## 8. Truy vết: hạng mục bản 29/07 → verdict 30/07

| Hạng mục bản 29/07 | Verdict | Nơi xử lý ở bản này | Mã bằng chứng |
|---|---|---|---|
| "Read-only residence/lifecycle có thể triển khai trước; mọi đường ghi tiền **phụ thuộc** shared runtime" | **SỬA** → hard block có danh sách | §0.0, Task 1/2/3/5 BLOCKED-BY | `[A9.R5]` BLOCKER |
| "Hai termination writers hiện có" | **SỬA** → **bốn** (ba SQL + một client) | §0.4, Task 2 Step 5b | `C-TERM-1`, `[A9.R1]`, `[X9.4]` |
| Task 0 Step 3 chỉ đọc transfer `COMPLETED` | **SỬA** → phủ cả trigger `DRAFT→APPROVED` | §0.3, Task 0 Step 2b/3 | `C-ROOM-2`, `[A9.R3]` |
| Task 0 Step 4 neo `contracts.start_date` | **BỎ giả định** | Task 0 Step 4 | `[A9.R3]` |
| `refund_amount` là exact due | **BỎ** (đã bỏ từ 29/07, giữ) | §0.1 | `[A0.V2]`, `[X7.6]` |
| `canonical_amount = item_sum` là đủ cho ô "Đã hoàn cọc" | **SỬA** → thêm `deposit_subtotal` | §0.1, Task 4 Step 3, Task 7 Step 3 | `C-DEP-2`, `[X0.2]` |
| `invoice_refund_reservations` dùng được cho hoàn cọc | **BỎ** (đã bỏ, giữ) | §3.6a | `[A9.V13]` |
| Không có gì nói về `decide_owned_income_expense_v2` | **THÊM** → phiếu hoàn sẽ **không huỷ được** | §3.6b, Task 1 Step 5(ii), Task 5 Step 6 | `[X3.5]` HIGH (SỐNG) |
| Không có gì nói về nhánh lai `reserve_invoice_refund_obligation_v2` | **THÊM** | §3.6c, Task 1 Step 5(iii) | `C-DEP-8` |
| Không có gì nói về adapter chết `TERMINATION_MOVE_OUT_PAIR` | **THÊM** | §3.6d | `C-DEP-7` |
| "Ownership tại birth rồi finalize `account_id`/`voucher_date` bằng token" | **SỬA** → **bất khả thi** nếu không mở allowlist | §3.5a, Task 1 Step 6, Task 5 Step 4 | `E9`, `[A5.V9]`, `[A5.R1]` |
| Task 1 Step 6 freeze `attachments` + hash header | **SỬA** → xung đột quyết định #8 (ANNOTATE) | §3.5b | `[X6.6]` CONFIRMED |
| "Snapshot bất biến" bảo vệ quyết toán | **SỬA** → không bảo vệ **hàng nguồn** | §1.3, §3.5c, Task 1 Step 6b/7 | `[A9.R2]` HIGH |
| Không có gì nói về guard regex trên `payments` | **THÊM** | §1.5, Task 2 Step 4(i) | `[A9.R4]` HIGH |
| `/deposits` chỉ sửa 2 file TS | **SỬA** → thêm `get_refund_forfeit_summary` + 2 hook nữa | §1.4, Task 4 Step 3b, Task 7 Step 5 | `C-DEP-KPI`, `[X0.3]` SỐNG |
| `deposits.view` "khớp route `/deposits`" | **SỬA** → baseline là `buildings.view` qua phòng hiện tại; đổi quyền **hai chiều** | §3.3, Task 4 Step 4 | `C-DEP-10` |
| `deposits.refund` không được nhắc | **THÊM** → phải giải thích hoặc dùng | §3.3 | `C-DEP-9` |
| Regression chỉ có `2.428.500/1.450.000` | **SỬA** → 5 ca, lệch **hai chiều** | Task 7 Step 6 | `[X7.6]`, `[A0.R1]`, `[A0.R4]` |
| Task 7 Step 5 đổi một nhãn ở contract detail | **SỬA** → phải đổi **hai** | Task 7 Step 5(d) | `[A0.R2]` HIGH |
| "37/56 termination audit rows thiếu" | **SỬA số** → 23/56 thiếu, 14/23 vẫn có phiếu | Task 3 Step 4 | `[A9.R7]` |
| "16/20 refund voucher không correlate" | **GIỮ** + thêm 8/10 POSTED không có dòng hồ sơ | §1.2 | `[A9.V9]`, đo lại 30/07 |
| "go-live trusted queue có thể trống" | **GIỮ** + định lượng ngưỡng ≤ 3 dòng | Task 3 Step 4, Task 8 Step 3 | `[A4.C9]`, `[X7.6]` |
| Mọi "Modify `src/pages/ThuTien.tsx`" cho registry phí | **SỬA** → `ThanhToan.tsx`; `Chu trình phòng` ở `ThuTien.tsx` | §2.2, Task 7 Step 1 | `[X9.4]` (UI), `[A6.C3]` |
| "Desktop/mobile mount one surface" | **BỎ** → hai bề mặt là chủ ý và **có spec bảo vệ** | Task 7 Step 7 | `[X5.3]`, `[A6.C3]` |
| "Không thêm testing-library/jsdom ⇒ DOM về Playwright" | **SỬA** → repo đã có harness `renderToStaticMarkup` | §2.3, Task 6 Step 7 | `B13` |
| Timestamp `20260730*` | **SỬA** → `20260731*`; `20260730160000` **đã bị chiếm** | §2.1, Task 8 Step 1 | `E12`, `[X6.1]`, `[X1.6]` |
| Không có migration publication | **THÊM** một file | §1.8, §2.1, Task 4 Step 6 | `B25`, `[A0.R6]` |
| "Seed một dòng adapter là đủ" | **SỬA** → `CASE` 5 nhánh đóng, `ELSE → 0A000` | §1.6, Task 1 Step 5(i) | `E8`, `[X3.4]` |
| Lock order 6 bước | **SỬA** → thêm **bước 0** LOOKUP idempotency | §3.2, Task 5 Step 2 | `C-ROLL-6` HIGH |
| `finance_v2_is_cashbook_period_open` là gate kỳ | **SỬA** → dùng `cashbook_closed_through_v1` + `assert_period_open_for_edit_v1` | §1.6, Task 2 Step 4(iii), Task 5 Step 5 | `E4`, `[X3.2]` |
| Release adapter "bao phủ mọi terminal writer" | **SỬA** → thiếu **hai**; trigger backstop lên cơ chế chính | §1.6, §3.1, Task 1 Step 5 | `E10`, `[X6.7]` |
| Không có gì nói về mẫu neo Đợt 0–6 | **THÊM** Step 0′ | Task 0/1/2 Step 0′ | `C-INFRA-1` HIGH |
| `set_feature_route_v1` gọi bằng named-arg theo tên plan | **SỬA** → sai 3 tên ⇒ `42883`; ACL chỉ `postgres` | Task 8 Step 2 | `C-ROLL-3` |
| "prod stored OFF + DEMO stored CANARY" | **BỎ** → bất khả (cờ không có `organization_id`) | §3.4 luật 3, Task 8 Step 2 | `C-ROLL-2` |
| "cap metadata để NULL" | **BỎ** → ba cap `NOT NULL DEFAULT 0`, `domain` không default | Task 1 Step 2b | `C-ROLL-4` |
| Rollback dùng `force_freeze` | **SỬA** → chưa có đường có kiểm toán | Task 8 Step 6 | `C-ROLL-1` |
| "evidence cùng hash" | **SỬA** → `sha256` **0/159 dòng**; bỏ chữ "hash" hoặc làm nó thật | §1.7, Task 5 Step 4 | `C-EV-1` |
| Assert "đúng một dòng MAIN" | **SỬA** → phải cho phép CHANGE/ROUNDING + backstop kỳ bên trong core | Task 5 Step 5 | `C-EV-4` |
| "Ẩn provenance SERVICE row khỏi ordinary UI" | **BỎ** (giữ nhánh điều kiện) | Task 1 Step 6 | `A-SVC`, `[X4.2]` |
| Frontend "lookup persisted ownership" | **SỬA cách diễn đạt** → tra `system_source` đã freeze + trạng thái obligation; **đừng** phơi `app_private` | §0.2, Task 1 Step 5, Task 7 Step 5(f) | `D7`, `[X9.2]` |
| Owner helper mới `special_fee_is_owner_or_superadmin_v1` | **SỬA** → EXTEND `is_org_owner_v1`, chốt một định nghĩa | Task 5 Step 7 | `D-OWNER`, `[X6.5]`, `[A3.R3]` |
| Bảng gate §5 bản 29/07 | **SỬA** → +2 gate, −1 gate, sửa cách đọc `reconcile-money` | §5 | `E5`, `C-INFRA-11` |
| `check-technical-membership-isolation.mjs` trong gate | **BỎ** → script chưa tồn tại | §5, Task 8 Step 4 | `E5` |
| "Không nói gì về Slice −1" | **THÊM** cross-reference, không sao chép | §0.5 | `danh-gia v2 §4` |

**Đã bị BÁC — không được tái sinh trong bản này** (`state-of-world §9.9`, 22 claim): "một clause một file"
cho `refund_done`; "`canonical_amount` làm dòng `a1ee1eb7` sai 500.000"; "missing route fail-open trái với
plan"; "không có bề mặt client đọc route"; "cạn count-cap không raise"; "stored ON không ghi gì"; "không có
bucket cap"; "không migration nào tạo bảng cờ ⇒ clone chết với lỗi khó hiểu"; "3 khoá cờ không tồn tại ⇒
verify pass sai lý do"; "plan provision SERVICE membership"; "6 timestamp phá anchor patch của
`170000`/`210000`"; "9 timestamp sort trước Đợt 0–6 ⇒ rehearsal bỏ qua guard"; "owner helper mới thiếu
membership window"; "release adapter thiếu BỐN writer"; "`refund_method` trái lời hứa manager chọn phương
thức"; "`UNIQUE(contract_id)` + fail-closed sẽ abort move-out của 2 HĐ ACTIVE"; "đăng ký
`TERMINATION_REFUND` tại birth phá toàn bộ lifecycle truyền thống"; "frontend không đọc được ownership";
"UI chọn writer theo global route là sai"; "`terminate_contract_forfeit_impl` bị bỏ ⇒ 70% termination không
có coverage hoàn cọc"; "DEMO không diễn được ⇒ money write đầu tiên rơi vào org thật"; "plan hứa 4 file
dirty là HIGH".

**Giới hạn của chính đợt kiểm toán nuôi bản plan này** (`state-of-world §10`, `danh-gia v2 §11`):
**không có bất kỳ lần chạy browser/E2E nào** — mọi khẳng định UI dựa trên dòng source + dữ liệu live +
assertion của spec tracked, **không** dựa trên một trang đã render được quan sát ⇒ mọi kết luận UI ở §1.1,
§1.4, Task 7 **phải được xác minh lại bằng Playwright** trước khi tuyên bố xong. Không có staging clone đầy
đủ của production. Số liệu live trôi trong ngày ⇒ so **delta**. Và mười hai hạng mục còn phải đo lại trước
khi viết backfill/gate được liệt kê ở `danh-gia v2 §11.2` — trong đó bốn hạng mục thuộc trực tiếp Plan 2:
danh sách cột INSERT của `approve_contract_termination_v1`, xuất xứ 3 termination DEMO chỉ có `refund_date`,
toàn bộ body `terminate_contract_forfeit_impl` (13.983 ký tự, các nhánh tiền khác chưa đọc), và **bên nào
đúng cho hai phiếu hoàn lệch số** (−978.500 và +500.000 — chứng minh được **lệch**, **không** chứng minh
được nghiệp vụ coi số nào đúng).
