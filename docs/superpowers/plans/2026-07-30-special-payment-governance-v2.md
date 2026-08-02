# Special Payment Governance Implementation Plan — v2 (30/07/2026)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Các bước dùng checkbox để theo dõi.
>
> Tài liệu này **thay thế** `special-payment-governance.md` (29/07/2026, chỉ tồn tại trên nhánh
> `fix/v5-collection-completion-20260722`). Bản 29/07 được hiệu chỉnh theo codebase/database live ngày
> **29/07**; bản này được hiệu chỉnh lại theo một đợt kiểm toán 10 mảng chạy trên **codebase hiện tại +
> production sống ngày 30/07/2026**, sau đó bị phản biện đối kháng (63 phán quyết: 41 sống, 22 bị bác).
> Mọi chỗ hai bản xung đột thì bản này thắng.
>
> Đọc kèm: `2026-07-30-danh-gia-2-plan-thu-tien-v2.md` (quyết định) và
> `2026-07-30-thu-tien-state-of-world.md` (hiện trạng + số liệu). Plan này **không** lặp lại số liệu ở
> đó; chỗ nào cần số thì trích và ghi rõ nguồn.
>
> **Đây là PLAN.** Không một dòng nào dưới đây được đọc là "đã code", "đã apply", "đã test", "đã chạy".
> Không migration nào được triển khai khi chưa qua gate của slice tương ứng ở
> `danh-gia…-v2.md §7`.

**Ký hiệu sửa đổi so với bản 29/07** — dùng để đọc diff:

| Nhãn | Nghĩa |
|---|---|
| **[GIỮ]** | Bước sống nguyên vẹn (có thể chỉnh câu chữ) |
| **[DELETE]** | Bước nhắm vào vấn đề **không tồn tại** — xoá, thay bằng assertion no-op nếu cần |
| **[RETARGET]** | Ý đúng, **file/function/route sai** — đổi đích |
| **[ADD]** | Bề mặt/hiểm hoạ bản 29/07 chưa phủ |
| **[REORDER]** | Đúng nội dung, **sai thứ tự** thực hiện |
| **[BLOCKED-BY …]** | Không thể bắt đầu trước khi tiền đề nêu tên xanh |

**Goal:** Chuyển riêng các nút thanh toán hạng mục đặc biệt trên **`/thanh-toan`** (`src/pages/ThanhToan.tsx`,
route gác `thu_tien.collect` tại `App.tsx:367`) thành luồng kiểm tra rule, chống chi trùng ở database và
auto `APPROVED + POSTED` nguyên tử khi hợp lệ — **trừ** khi số tiền ≥ ngưỡng tự duyệt của org, lúc đó
kết quả là `VALID_PENDING_APPROVAL` (`UNAPPROVED`, giữ claim, không post); giữ nguyên toàn bộ
writer/approval truyền thống ở `/thu-chi` và các page khác. **[RETARGET]** — bản 29/07 ghi `/thu-tien`
(`src/pages/ThuTien.tsx`), file đó **không còn** một hook/component phí cố định nào (`:258-259` chỉ
`navigate('/thanh-toan')`).

**Architecture:** Rule versions và claim ledger nằm trong `app_private`. Một shared context
`app_private.special_page_submit_context_v1` xác thực tổ chức, timezone, **idempotency LOOKUP trước
mọi thứ**, đúng quyền `thu_tien.collect` **cộng thêm** hai key legacy mà backend nhóm này thật sự dùng
(`buildings.view` qua `can_access_building`, `income_expenses.all_buildings` qua `ie_all_buildings_scope`),
tòa, sổ thật, chứng từ, feature route (**evaluate đúng một lần/transaction**), CANARY safety caps; phần
khóa/ghi luôn theo một global order. Writer tạo voucher `UNAPPROVED + UNPOSTED` bên trong transaction,
gắn evidence đã finalize, rồi **dedicated private posting adapter** mới chuyển `APPROVED` và gọi Finance
V2 posting primitive **dưới token `purpose='FINANCE_V2_LIFECYCLE'`** (hoặc `app_private.ie_flex_writer_xids`)
— nếu không, cầu `a85`/`a85b` **tự mint một posting `LEGACY_BRIDGE` thứ hai**. Fixed/utility/commission/
maintenance của Plan 1 và termination obligation của Plan 2 dùng chung context, signed-deposit resolver và
posting adapter nhưng giữ source/ledger riêng. Ngoại lệ là proposal, không phải voucher; chỉ
owner/superadmin mới quyết định, và **"owner" có đúng một định nghĩa**: `app_private.is_org_owner_v1`
(extend), **không** phải `member_type='OWNER'`.

**Tech Stack:** PostgreSQL/Supabase (`SECURITY DEFINER` **khai VOLATILE**, RLS, advisory locks, partial
unique indexes), Finance V2 postings, React 18 + TypeScript + TanStack Query + shadcn/ui, Vitest/fast-check
(**kể cả harness render `renderToStaticMarkup` đã có sẵn trong repo**), Playwright fleet.

---

## 0. Phạm vi và điều kiện khóa

### 0.1 Hành vi không được thay đổi

| Entry point | Hành vi |
|---|---|
| Check của các mục đặc biệt trên **`/thanh-toan`** | `VALID` → tạo voucher `APPROVED + POSTED`; **`VALID_PENDING_APPROVAL` → `UNAPPROVED`, giữ claim, KHÔNG post, KHÔNG assert POSTED**; `VALID_WITH_WARNING` → post + alert; `EXCEPTION_REQUIRED` → proposal chờ owner/superadmin |
| `/thu-chi`, `/income-expense`, contract page, import, Copilot, recurring page truyền thống | Giữ resolver, quyền, approval, posting và threshold hiện tại. Voucher đã bind special kind chỉ tạo `EXTERNAL` observation/claim để special page thấy slot; không được auto-bypass workflow cũ |
| Quyền cấu hình/duyệt ngoại lệ | `public.is_super_admin()` **OR** `app_private.is_org_owner_v1(org,user)`; không thêm permission delegable. **[RETARGET]** bản 29/07 ghi `organization_memberships.member_type='OWNER'` — xem §0.4 |
| **`/thu-tien`** (`ThuTien.tsx`, 406 dòng, gác `thu_tien.view`) | **Không đụng.** Đây là trang thu tiền khách theo phòng (`CollectDrawer:376`), không phải trang đóng tiền nhà cung cấp |

Mọi writer mới phải ghi `income_expense_audit_log` cho **chuyển trạng thái nghiệp vụ** (proposal decision,
claim release, warning) và **dùng lại** `app_private.income_expense_change_log` (trigger
`z99_ie_change_log`/`z99_ie_items_change_log`, reader `public.get_voucher_change_log_v1`) cho value-diff —
**đừng dựng sổ thứ ba**. Không dùng `public.notifications` làm nơi lưu snapshot nhạy cảm. Alert chính nằm ở
`app_private.special_fee_alerts`/receipts với RLS owner/superadmin.

### 0.2 Rule nghiệp vụ

| Family | Slot normal | Điều kiện `VALID` | Warning vẫn post | Exception |
|---|---|---|---|---|
| `RENT`, `INTERNET`, `MANAGEMENT`, `RECURRING_CLEANING`, `POLICE`, `TRASH`, `ELEVATOR` | org × building × kind × month | amount đúng tuyệt đối rule version | Không | amount khác |
| `ELECTRIC`, `WATER` | org × utility account × type × **tháng theo khoá đã chốt ở Task 4 Step 1** | slot còn trống, sổ/evidence hợp lệ | tổng supplier cost của building/type/month vượt trần tuyệt đối hoặc ratio với tổng tenant billed; mẫu số 0 nhưng chi > 0 | muốn tách phiếu thứ hai; thiếu config trả riêng `CONFIG_REQUIRED`, không tạo proposal |
| `BROKER_COMMISSION` | org × contract | contract hợp lệ, deposit basis đủ 100%, `org_today >= start_date + 7`, **tier hợp lệ HOẶC `fallback_policy` đã publish** | Không | chỉ amount khác **sau khi đã eligible**; status/cọc/7 ngày/basis không được owner override |
| `SALE_HOT_BONUS` | org × contract | amount ≤ cap; có thể chi ngay | Không | vượt cap |
| `AIR_CONDITIONER` | org × room × service kind | rolling window ≥ 5 tháng; amount ≤ standard | standard < amount ≤ ceiling | cadence sớm hoặc amount > ceiling |
| `WASHING_MACHINE` | org × building × service kind | rolling window ≥ 6 tháng; amount ≤ standard | standard < amount ≤ ceiling | cadence sớm hoặc amount > ceiling |

Thiếu config ở bất kỳ family nào luôn `CONFIG_REQUIRED`, không phải exception proposal và không fail-open.
Fixed amount chỉ được so exact sau `numeric(18,2)`; không tolerance. Bảo trì thấp hơn standard bình
thường/no alert. Chỉ Internet, Công an, Rác, Thang máy multi-month; one child/month, all-or-nothing.
Billing/item period là kỳ phí; voucher/posting date là ngày tiền rời sổ (`org_today`), không future-date cash.

**[ADD] Ba bổ nghĩa mới, cả ba là điều kiện tồn tại:**

1. **Ngưỡng tự duyệt phá vỡ "VALID ⇒ APPROVED + POSTED".** `pay_utility_bill` đọc
   `app_private.ie_auto_approve_config` (`:72-79 → :99`) và sinh `UNAPPROVED` khi
   `p_amount >= threshold`; org thật đặt **600.000đ** lúc `2026-07-29T09:39:56Z` và **64/72** hoá đơn
   điện/nước còn sống ≥ 600k; DEMO 5.000.000đ. `pay_period_fee:132` thì **hardcode `'APPROVED'`**, không
   đọc ngưỡng — bất đối xứng. Vì vậy bảng trên có ô `VALID_PENDING_APPROVAL`. **Chủ phải ký quyết định
   trước Slice 1**: (a) giữ bất đối xứng, hay (b) hợp nhất (đây là **đổi hành vi** của `pay_period_fee`).
2. **`PROFIT_LOCKED` là một tầng khoá độc lập đang có hiệu lực.** Trigger
   `a02_ie_profit_lock_ins/upd/del` trên `income_expenses` và `a02_ie_items_profit_lock` trên
   `income_expense_items` `RAISE '[PROFIT_LOCKED] …'` với `P0001`; **18 toà đã chốt lợi nhuận tháng
   05/2026**; cửa duy nhất là `is_org_owner_v1`. Ngược lại `app_private.cashbook_closures` **0 dòng** và
   `accounts.lock_date` **0/28** ⇒ nhánh "sổ quỹ đã chốt" chỉ kiểm được bằng fixture.
3. **Trả trước có thể tự khoá vĩnh viễn chỗ của mình.** File **untracked, chưa apply**
   `20260730240000_authz_remaining.sql:429-457` mở rộng `assert_period_open_for_edit_v1` sang **kỳ dịch vụ
   của hạng mục** — đúng hình dạng của child trả trước (item giữ tháng đã trả, `voucher_date` = hôm nay)
   ⇒ child trả trước cho tháng đã chốt lợi nhuận **không huỷ được**, slot bị chiếm mãi. Xem §0.5.

### 0.3 **[ADD]** Slice −1 — khuyết tật ĐANG SỐNG thuộc đúng mặt cắt này

Chi tiết, bằng chứng và gate: `2026-07-30-danh-gia-2-plan-thu-tien-v2.md §4`. Dưới đây chỉ là **bảng
BLOCKED-BY** cho Plan 1. **Không task nào của plan này được bắt đầu trước khi hàng tương ứng xanh.**

| Khuyết tật Slice −1 | Chặn task nào của Plan 1 | Vì sao không thể tồn tại trước |
|---|---|---|
| −1.1 `pay_utility_bill`: phiếu UNAPPROVED vô hình + **0 chốt chống trùng** | Task 3, Task 5 | Không thể assert `VALID → APPROVED+POSTED` khi ngưỡng chủ bắt chờ duyệt; không thể tạo unique index per-meter khi slot đang vi phạm |
| −1.2 Batch bảo trì: `ie_compat_insert_v2` ép `UNAPPROVED`, `get_period_maintenance` lọc `APPROVED` | Task 1–4 | Chưa có chiều **phòng** để neo cadence; **23/86** phiếu AC đã vi phạm sẵn luật 5 tháng |
| −1.3 `fee_type_matches` khớp sai loại (tiền lương vào ô Quản Lý) | Task 6 Step 6, Task 7 | Read model mới derive từ read model cũ ⇒ đóng dấu canonical lên tiền-không-phải-phí |
| −1.4 `get_period_fee_status` cộng `ie.total_amount` cho **từng** hạng mục | Task 3, Task 7 | Con số đối chiếu "amount đúng tuyệt đối" hôm nay đã sai |
| −1.5 Tự tạo công tơ ngầm khi `p_utility_account_id IS NULL` | Task 3, Task 4 | Nhánh này sinh khoá mới trong lúc ta đang định khoá unique theo meter |
| −1.6 Hai bề mặt cùng ghi được một slot + `p_force` cách một click | **Task 2 Step 3** | `CREATE UNIQUE INDEX` **fail ngay lúc tạo** trên **22 ô / 45 phiếu** đang vi phạm (13/22 thuộc 07/2026 ⇒ vẫn đang sinh thêm) |
| −1.x `cancel_period_fee` bẫy `55000` trên 9 phiếu flow-owned (gồm phiếu thật `PC2607096` *"phí bỏ rác"* 100.000đ) | Task 6 Step 2, Task 7 Step 1 | `cancellable` đang nói dối trên một phiếu production; wrapper mới sẽ thừa hưởng lời nói dối đó |

### 0.4 **[RETARGET]** Định nghĩa "chủ sở hữu" — chốt MỘT nguồn

Hai định nghĩa đang cùng sống:

- **Prod:** `app_private.is_org_owner_v1(p_org,p_user)` (DEFINER/STABLE, định nghĩa
  `20260730190000_plan_hardening_wave1.sql:125-149`) nhận diện chủ bằng **chuỗi tên vai trò**
  `organization_roles.name = 'Chủ sở hữu tổ chức'`, **không** có `member_type`; nó **đã** kiểm cửa sổ hiệu
  lực của cả membership lẫn chính role_binding (comment trong body: *"Cửa sổ hiệu lực của CHÍNH binding:
  đây là cách duy nhất repo thu hồi vai trò"*). Đây là cửa của Đợt 1/2/4:
  `set_ie_accounting_standard_v1`, `annotate_income_expense_v1`, `can_flex_cancel_v1`,
  `cancel_income_expense_flex_v1`, `income_expenses_check_profit_lock`, `can_reverse_collection_v1`,
  `ie_compat_cancel_v2`, `reverse_invoice_collection_v5`.
- **Plan 29/07:** `member_type='OWNER'`.

Đo được: ở **DEMO** vai trò chủ có 3 binding active (`demo.chunha` OWNER, `demo.quanly` **STAFF**,
`nguyentamca165` **STAFF**) nhưng `member_type='OWNER'` chỉ **1** dòng ⇒ làm theo plan sẽ **lật 2/3 "chủ"
thành không-chủ**, trong đó có `demo.quanly` mà E2E fleet đang dùng ⇒ spec đỏ không rõ nguyên nhân. Ở org
thật hai định nghĩa **trùng nhau** (1 và 1) ⇒ lệch **một chiều** và **chỉ ở DEMO**.

**Quyết định:** `special_fee_is_owner_or_superadmin_v1(p_org,p_user) := public.is_super_admin() OR
app_private.is_org_owner_v1(p_org,p_user)`. **Không** định nghĩa lại khái niệm chủ. Cùng migration
forward-harden `is_org_owner_v1` hai điểm nó thiếu: (a) `JOIN organizations o ON o.id=p_org AND
o.status='ACTIVE'`; (b) thay literal tên vai trò bằng khoá bất biến (`organization_roles.is_system` + một
slug ổn định), giữ tương thích ngược — **vì hôm nay đổi tên vai trò trong Cài đặt là tự sập cửa chủ ở
nhiều nơi**. Ghi thêm rủi ro đã đo: `public.is_super_admin()` **bỏ qua** cột
`super_admins.organization_id` (cột tồn tại, dòng mang org thật) và còn được GRANT cho `anon`.

### 0.5 **[ADD]** Bốn tiền đề hạ tầng phải quyết TRƯỚC khi viết migration

1. **Đánh số lại toàn bộ migration sang dải `20260731xxxxxx`** — xem §2.4.
2. **Hai file untracked trùng timestamp với file tracked đã apply, và chưa lên prod**:
   `20260730230000_annotate_evidence_protection.sql` (556 dòng; `:289` là `CREATE OR REPLACE FUNCTION
   public.annotate_income_expense_v1(...)` **trần, không guard "đã vá"** ⇒ apply sau
   `20260730270000` sẽ **xoá lớp bảo vệ bằng chứng**) và `20260730240000_authz_remaining.sql` ("WP2").
   **Phải hỏi chủ trước khi apply hoặc đổi tên**, và phải quyết số phận WP2 **trước** khi đụng
   `reverse_invoice_collection_v5`, vì WP2 viết lại hàm đó theo **mẫu neo**.
3. **`supabase_migrations.schema_migrations` đã chết** (`count=360`, `max_version='20260716170000'`) trong
   khi ≥22 file `20260730*` đã apply ⇒ **"vắng sổ" ≠ "chưa apply"**; mọi kiểm tra phải dùng catalog
   (`pg_proc`/`pg_class`/`pg_trigger`/`pg_constraint`), từng object một.
4. **Cả hai org đang ở flexible mode** (`app_private.org_accounting_mode`: org thật id=1
   `strict_mode=false` 29/07 11:12; DEMO id=4 `strict_mode=false` 29/07 11:26) ⇒ đường flex-cancel của
   Đợt 4/5 **đang sống trên production**, không ngủ.

## 1. Hiện trạng phải dùng làm nền

### 1.1 File và RPC hiện tại — **[RETARGET]**

- **Page/route:** `src/pages/ThanhToan.tsx` (77 dòng) — mount `PeriodFeePanel` (`:53`) **và**
  `PeriodFeeSheet` (`:63`) **đồng thời, không điều kiện**; route gác `thu_tien.collect` (`App.tsx:367`).
  `src/pages/ThuTien.tsx` (406 dòng, gác `thu_tien.view`, `App.tsx:363`) **không còn** liên quan tới phí
  cố định.
- **UI/registry:** `src/lib/feeCategories.ts` (10 category, 4 kind multi-month — `:40-106`,
  `feeCategories.test.ts:6-16` assert `toHaveLength(10)` và `['cong_an','internet','rac','thang_may']`),
  `src/lib/fixedExpenseCategories.ts`, `src/components/thu-tien/PeriodFeePanel.tsx`,
  `PeriodFeeSheet.tsx`, **`UtilityEnContent.tsx`** (import duy nhất `PeriodFeePanel.tsx:37`, render
  `:503-505`), khối EN **inline** của `PeriodFeeSheet.tsx` (`:96`, `:177-193`),
  `PeriodCommissionModal.tsx`, `PeriodFeeVoucherList.tsx`.
- **[DELETE] `UtilityDesktopPanel.tsx` (21.515 B) và `UtilityBillSheet.tsx` (15.076 B) là CODE CHẾT** —
  **0 importer** trong `src/` và `.e2e-fleet/` (36,6 KB). Bản 29/07 liệt kê chúng là file cần sửa ⇒ ~36 KB
  sửa đổi sẽ rơi vào file không render **trong khi typecheck và checklist đều xanh**.
- **Hooks:** `src/hooks/usePeriodFees.ts`, `useUtilityBills.ts`, `useCommissionVoucher.ts`,
  `useMaintenanceBatch.ts`, `usePeriodFeeState.ts`, `useUtilityPayState.ts`,
  `src/hooks/useReceiptPasteTarget.ts`, `src/hooks/income-expenses/batch.ts`.
- **Legacy RPC (4 nút gọi trực tiếp):** `pay_period_fee` (11 arg, có `p_force`), `pay_utility_bill`
  (10 arg), `create_commission_voucher` (10 arg), `pay_draft_fee_voucher` (3 arg). **[ADD] Hai đường ghi
  nữa mà bản 29/07 không xếp vào writer:** `ie_compat_insert_v2` (bảo trì) và `generate_recurring_vouchers`
  (cron `recurring_vouchers_daily` `0 18 * * *`, gọi với `NULL` = **toàn bộ parent trong DB**).
- **[ADD] Backend nhóm này KHÔNG dùng `thu_tien.*` chút nào.** Không một trong 13 body legacy nào tham
  chiếu `'thu_tien'`; authz thật là `public.can_access_building` (= `can_v3('buildings.view', b)`) tại
  `get_period_fee_status:27-30`, `pay_period_fee:43-46`, `pay_utility_bill:33-34`,
  `cancel_period_fee:55-59`, `cancel_utility_bill:32-36`, cộng `public.ie_all_buildings_scope`
  (= `can_v3('income_expenses.all_buildings', b)`). RPC mới **bổ sung** `thu_tien.view`/`thu_tien.collect`
  **LÊN TRÊN** hai key cũ, **không thay thế**, và test phải chứng minh cả bốn tổ hợp.
- **[ADD] Ba mô hình custody cùng tồn tại trên một trang.** `pay_period_fee:85-99`,
  `pay_utility_bill:39-49`, `pay_draft_fee_voucher:29-34` chỉ kiểm
  `accounts.id = p_account_id AND deleted_at IS NULL AND (user_id = auth.uid() OR public.is_admin() OR
  public.is_super_admin())` — hoàn toàn **ngoài** mô hình CUSTODIAN của Đợt 5–6; hai hàm đầu còn **tự
  chọn sổ** khi `p_account_id` NULL (`user_id = auth.uid() AND btrim(name) LIKE '%Thu'`). `ie_compat_insert_v2`
  thì **đòi** binding `CUSTODIAN`. `create_commission_voucher` chèn `p_account_id` **thô** (không một
  `SELECT … FROM accounts` nào trong 223 dòng body). ⇒ Hệ quả phải nêu thành quyết định của chủ: **hôm
  nay CUSTODIAN được giao giữ sổ KHÔNG dùng được các nút này, còn chủ sổ vẫn chi được từ sổ đã bàn giao.**
- `building_utility_accounts` (33 dòng / 32 alive) đã hỗ trợ nhiều meter — `idx_bua_building_type`
  **không unique**; utility voucher phải mang `utility_account_id`, không tạo meter ngầm trong nút check.
- **[RETARGET] `buildings.commission_tiers`**: **21/21** toà đã khai và **21/21 đều hở**, cùng một hình
  dạng chỉ phủ **5–6** và **10–12** tháng (18 toà `[{5,6,50},{10,12,60}]`; 102LVT rate 70; 44TL rate 80;
  1392QT `max_months=13`). Nhưng **một fallback ngầm ĐÃ tồn tại** trong `get_period_commissions`
  (`COALESCE(match trong khoảng, rate của bậc cao nhất có max_months < months)`) và nó **xung đột** với
  `useCommissionVoucher.ts:46-48` (chỉ fallback khi `months > topTier.max_months` ⇒ trả 0đ). Import DRAFT
  **không** `fallback_policy` sẽ **âm thầm đổi số đang hiển thị hôm nay** cho **22 HĐ** ở 7–9 tháng từ
  `50% × rent` xuống `0`. **152 HĐ** rơi đúng bậc; **~200 HĐ** ngoài bậc, trong đó **48 HĐ** ở 13–17 tháng
  ⇒ `fallback_policy` là **load-bearing**, không phải trang trí.
- **[ADD] `building_fee_accounts.default_amount` KHÔNG phải cấu hình.** `pay_period_fee` **ghi đè** nó
  bằng `round(p_amount / GREATEST(v_months,1))` mỗi lần chi (`ON CONFLICT … DO UPDATE`) ⇒ nó là **ký ức
  của lần đóng gần nhất** (toà `1eae0e82…` `fee_category='dien'` đang có `default_amount = 9.507.910` —
  một hoá đơn điện cũ). Import nó thành DRAFT rule là **tự khớp chính mình**.

### 1.2 Finance V2 invariants

- Kết luận "đã chi" cần cả `income_expenses.approval_status='APPROVED'`, `posting_status='POSTED'`,
  `active_posting_id_v2` và một posting active có `MAIN` line đúng account/signed amount. Bằng chứng sống
  vì sao `APPROVED` không đủ: `PC2607005` (`system_source='contract.commission'`,
  `commission_kind='broker'`) đang `APPROVED` + `posting_status='UNPOSTED'` +
  `active_posting_id_v2 IS NULL` trên sổ **thật** ('ATam'), **2.730.000đ** — đã hiện "Đã chi" mà không có
  posting nào.
- **[ADD] BA trigger INSERT-time, không phải hai.** `a85_finance_v2_auto_posting_bridge` (BEFORE),
  `a85b_finance_v2_auto_posting_bridge_ins` (AFTER INSERT) **và**
  `a86_finance_v2_birth_provenance` (BEFORE INSERT → `app_private.finance_v2_register_birth_v1`, `RAISE
  23502` nếu không suy được `organization_id`). Thêm: **`a85b` TỰ INSERT một token
  `FINANCE_V2_LIFECYCLE` ở cuối thân nó** ⇒ *"không có token sau INSERT"* **không phải trạng thái ổn định**.
  Writer phải set `organization_id` **tường minh** khi pre-allocate UUID.
- **[ADD] BLOCKER — `ie_transition_authorization.purpose` là kill switch, không phải metadata.** PK trên
  `income_expense_id` **một mình** (một dòng/phiếu, 213 dòng rác hiện có, 213/213 `xid` đã chết, **không
  job dọn**); trigger `a00_ie_transition_token_upsert` **ghi lại `purpose` mỗi lần INSERT**. Cầu
  `a85`/`a85b` chỉ skip khi có token `purpose='FINANCE_V2_LIFECYCLE'` **đúng xid hiện tại**. Vì nhánh
  approve `INVOICE_REFUND` của `dispatch_finance_decision_v2` dùng
  `app_private.finance_v2_transition_owned_approval` (**stamp `purpose='APPROVED'`**), adapter nào copy nó
  sẽ để **cầu còn vũ trang** đúng lúc `approval_status` lật sang `APPROVED`; và vì Task 5 Step 3 bắt phải
  có `account_id`, `total_amount > 0`, sổ thật không-virtual ⇒ `v_should = true` ⇒ `a85` **tự mint posting
  `source_kind='LEGACY_BRIDGE'`** rồi stamp `posting_status='POSTED'` + `active_posting_id_v2` **TRƯỚC**
  khi core của adapter chạy ⇒ **posting tiền trùng**, và assert của Task 5 Step 5 thấy `LEGACY_BRIDGE` thay
  vì `SPECIAL_PAGE_FEE`. Cầu **đang sống**: `evaluate_feature_route('income_expense.posting.v2')` =
  `CANONICAL` trên prod ngay lúc này (`mode='ON'`, `force_freeze=false`, `config_version=3`). Thêm: cả
  `finance_v2_transition_owned_approval` và `finance_v2_stamp_owned_posting_state` **DELETE token ở cuối**
  ⇒ mọi UPDATE `income_expenses` sau đó trong cùng transaction đập vào freeze guard và fail `55000`.
  ⇒ **Hoặc** writer tự stamp `purpose='FINANCE_V2_LIFECYCLE'` và tự quản lý vòng đời token (vd
  `app_private.finance_v2_begin_canonical_op(...)` với `p_subject_id`, nó upsert đúng purpose đó),
  **hoặc** theo tiền lệ repo đã lập tại `20260730120000_ie_annotate_v1.sql:113-116` và mang năng lực trong
  **`app_private.ie_flex_writer_xids`** (+ `begin_ie_flex_write_v1(p_voucher,p_scope)` /
  `end_ie_flex_write_v1`, CHECK scope `('ANNOTATE','FLEX_EDIT')` — `'FLEX_EDIT'` **đã đặt chỗ trong CHECK
  nhưng chưa hiện thực trong body guard**, đó chính là móc treo).
- **[ADD] BLOCKER — `app_private.dispatch_finance_decision_v2` route theo `adapter_name`, KHÔNG theo
  `flow_owner`**, qua một `CASE` **năm nhánh đóng**: `{INVOICE_REFUND, PROFIT_PAYOUT,
  TERMINATION_FORFEIT_PAIR, TERMINATION_MOVE_OUT_PAIR, SALARY_BUNDLE}`; `ELSE` ném
  `0A000 'adapter % not wired for decision routing'`. Seed một `adapter_name` mới thì migration **apply
  xanh** rồi **chết ở decision đầu tiên**. Lỗi này **đã hiện thực hoá trên prod** cho
  `flow_owner='UTILITY_RECURRING'` (`adapter_name='CANONICAL_INCOME_EXPENSE'` → `ELSE` → `0A000`). Test
  *"unknown owner fail-closed"* đi đường `42501` của bước tra registry và **không bao giờ** chạm `0A000`
  ⇒ vô dụng ở đây. Plan **phải nói rõ**: `SPECIAL_PAGE_FEE` **reuse** một `adapter_name` đã nối, **hoặc**
  thêm một nhánh `CASE` — và test phải chạy **cả** `42501` **và** `0A000`.
- **[ADD] Freeze-guard allowlist KHÔNG chứa `account_id` và `voucher_date`.**
  `app_private.guard_income_expense_owned_payload` allowlist (`:59-79`) và cửa ANNOTATE (`:29-43`) đều
  không có hai cột đó. Đây là lý do `pay_draft_fee_voucher:36-39` (ghi `account_id`) **fail dù có token**,
  và là lý do 8 phiếu nháp E2E DEMO không trả được. ⇒ Owned payload freeze yêu cầu set
  `account_id`/`voucher_date` **TRƯỚC** khi register flow ownership; mọi one-shot finalize token phải là
  **mở rộng allowlist tường minh**, không phải giả định.
- **[ADD] Carve-out ANNOTATE hợp pháp.** Nhánh ANNOTATE của guard fire cho **mọi** `flow_kind`, trả `NEW`
  khi chỉ `attachments/notes/updated_at` đổi; `'notes'` còn nằm trong allowlist token;
  `public.annotate_income_expense_v1` là DEFINER, GRANT `authenticated`, **không đọc**
  `income_expense_flow_ownership`. ⇒ Mọi header hash/bộ đông cứng phải **loại `attachments`/`notes`**.
- **[ADD] `app_private.finance_v2_post_manual_voucher` chỉ tạo MỘT dòng `MAIN` và KHÔNG kiểm kỳ.** Cầu
  a85 thì tạo cả `CHANGE` và `ROUNDING` (CHECK cho phép `MAIN|CHANGE|ROUNDING|REVERSAL`). Nếu core
  source-aware copy khuôn manual thì phiếu có tiền thối/làm tròn **mất bút toán**, mà assert của bản 29/07
  (*"đúng một MAIN line âm cho expense"*) lại chốt cứng đúng biến thể thiếu đó. Core mới **phải** phát
  đủ ba loại line và **phải có period backstop bên trong** (vì nó sẽ được gọi từ nhiều adapter).
- `income_expense_posting_lines` chỉ có `{id, organization_id, posting_id, account_id, line_kind,
  signed_amount, created_at}` — **không** `room_id`/`contract_id`; room-level reconciliation chỉ được đi
  qua voucher/source joins. `income_expense_postings.source_kind` là **text tự do, không CHECK** (mix hiện
  tại: `LEGACY_BACKFILL 1710`, `MANUAL 265`, `LEGACY_BRIDGE 73`) ⇒ thêm `SPECIAL_PAGE_FEE` không cần đổi
  constraint.
- **[ADD] Wrapper cancel/reverse của special fee KHÔNG được tái dùng
  `public.decide_owned_income_expense_v2`** — hàm đó chỉ nhận flow `INVOICE_REFUND|TERMINATION_REFUND` và
  decision `approve|cancel`, và nhánh cancel của nó **đòi** một dòng `invoice_refund_reservations` state
  `HELD` (else `P0002`).
- **[ADD] Lối tôn trọng ownership duy nhất đang tồn tại là một regex trên message tiếng Anh** —
  `financeV2Mutations.ts:46-48 /owned by system flow/i` dùng ở `:60`, lặp ở `statusMutations.ts:315` và
  `:352`, khớp chuỗi do `assert_income_expense_flow_owner_v2:20` phát. **Mọi adapter mới phải giữ nguyên
  đúng substring đó** cho tới khi routing ownership-first lên, không thì dispatch chết im sau toast
  *"Duyệt phiếu thất bại"*.

Các helper live phải được preflight bằng đúng signature trước khi phụ thuộc (cả 7 đã xác minh **khớp
chính xác** trên prod; mọi helper `app_private` đã `REVOKE` về `postgres=X/postgres`):

```text
app_private.ensure_income_expense_type_v1(uuid,uuid,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)
app_private.resolve_finance_actor_v2(uuid)          -- BẮT BUỘC overload org-scoped, xem Task 0 Step 3
app_private.assert_cashbook_access_v2(uuid,uuid,text,uuid)
app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)   -- có SELECT … FOR SHARE ⇒ caller phải VOLATILE
public.create_finance_evidence_upload_intent_v2(uuid)
public.finalize_finance_evidence_v2(uuid)
app_private.cashbook_closed_through_v1(uuid)        -- THAY finance_v2_is_cashbook_period_open
app_private.assert_period_open_for_edit_v1(uuid,text)  -- khi voucher đã tồn tại
```

**[DELETE]** Bản 29/07 viết: *"`ensure_income_expense_type_v1` và dependency
`public.normalize_income_expense_type_name` đang có trên live nhưng không có defining migration hoặc
production snapshot được track […] phải digest-check body hiện có, forward-define đầy đủ cả hai"*. Tiền đề
này **sai**: cả hai **có** defining migration tracked
`supabase/migrations/20260728180000_income_expense_type_canonicalization.sql` — `normalize` tại `:13`
(REVOKE `:23`/GRANT `:25`), `ensure` tại `:792` với **signature 12 tham số byte-identical với chính chuỗi
preflight của plan** (REVOKE `:900`), commit `319c928` ngày 28/07, có trên `origin/main` **một ngày trước
khi plan được viết**; live `pg_proc` khớp file. Nhánh *"absent trên clone là hợp lệ"* **không bao giờ chạy**.
Forward-define từ snapshot live sẽ **revert canonicalization 28/07** về resolver theo creator
(`WHERE t.user_id = p_owner`) và làm mất bộ REVOKE/GRANT. ⇒ **Chỉ assert signature rồi PHỤ THUỘC.**
(Tác giả bản 29/07 không cẩu thả: file này **vắng** trên nhánh `fix/v5-collection-completion-20260722` nơi
plan được viết.)

**[RETARGET]** Toàn bộ ngân sách *"resolver theo organization thay vì creator `user_id`"* chuyển sang **một
việc còn thật**: `pay_utility_bill:82` vẫn gọi `public._termination_ensure_type(v_owner,'expense',v_type_nm)`
— hàm này khoá `WHERE user_id = p_user_id AND lower(name)=lower(p_name) AND lower(type)=lower(p_type)`
(theo **creator**, và dùng `lower()` chứ không `normalize_income_expense_type_name`), rồi chọn org bằng
`min(m.organization_id::text)` + một `limit 1` **không ORDER BY** ⇒ có thể gắn type sang **tổ chức khác**.
Việc cần làm là thay lời gọi đó bằng
`app_private.ensure_income_expense_type_v1(p_organization_id => v_org, …)` với `v_org` =
`buildings.organization_id` **đã có sẵn** ở `pay_utility_bill:72`. Bản 29/07 **không** nhắc tên hàm này.

### 1.3 Data hazards đã xác minh — **[RETARGET] số đo lại 30/07**

- **Recurring:** **77 PARENT schedule** đang due (`repeat_next_date >= org_today`; 77/77
  `repeat_parent_id IS NULL`, **0 child**; 76/77 APPROVED; 76/77 map được vào 1 trong 7 fixed kind; 64/77
  `repeat_auto_approve=true`); theo vị ngữ `add_cycle(voucher_date, repeat_cycle, 1) <= current_date` thì
  là **76** — plan phải **nói rõ dùng vị ngữ nào** cho occurrence ledger. Child sống: **155**
  (146 APPROVED+POSTED = 966.010.000đ + 9 CANCELLED = 174.100.000đ), **155/155** `system_source IS NULL`
  và **155/155 đáp xuống một slot fixed-kind** ⇒ tích hợp external-holder **không phải edge case, là 100%
  dân số recurring**. *(plan 29/07 ghi "77 recurring **children** đang due" và "146 posted children" — số
  đo lại 30/07 là **77 parent** và **155 child sống**.)* Idempotency key của occurrence phải là
  `(parent_id, target_month)`, **không** phải child id.
- **[ADD] Cron đang chạy:** `recurring_vouchers_daily` (`0 18 * * *`, active) → `run_recurring_vouchers_job`
  → `generate_recurring_vouchers(NULL)` = **toàn bộ parent trong DB**; nó **không đọc**
  `ie_auto_approve_config`, **copy `attachments` của phiếu cha cho MỌI child**, dùng `CURRENT_DATE` (không
  timezone org), và **nuốt lỗi từng child** (`EXCEPTION WHEN OTHERS THEN RAISE NOTICE`). ⇒ Mâu thuẫn phải
  ghi vào plan: cùng một số tiền, đường utility mới sẽ ra **NHÁP** còn đường recurring vẫn **tự duyệt +
  tự post**.
- Chỉ **5** `contract_deposit_links` trên toàn database (tất cả `link_source='EXPLICIT_V2'`, **không có
  cột amount**); không được lấy bảng này làm coverage duy nhất.
- **Bảo trì:** họ đầy đủ `nrm_vn(category) LIKE 'bao tri%'` là **200 phiếu / 31 tên type / 5 category /
  80.289.556đ** — Máy Lạnh 101/11/42.333.000; Tòa Nhà 81 (org thật) + 4 (DEMO) / 12+4 tên; Máy Giặt 7/2/
  2.850.000; Tủ Lạnh 6/1; máy bơm 1/1. *(plan 29/07 ghi 101 voucher / 11 service name — đó **chỉ** là
  category "Bảo Trì Máy Lạnh"; số đo lại 30/07 cho cả họ là **200/31**.)* **77 phiếu bảo trì của org thật
  không có `room_id`** ⇒ không gắn được luật theo phòng. **23/86** phiếu AC non-cancelled **đã vi phạm
  sẵn** luật "1 lần / 5 tháng cùng phòng", và **4** phiếu AC có `room_id` NULL (13/101 nếu tính cả
  CANCELLED). Ghi rõ: Bảo Trì Tòa Nhà (85), Tủ Lạnh (6), máy bơm (1) **ngoài phạm vi theo thiết kế** và sẽ
  vào `LEGACY_SCOPE_UNKNOWN`. Máy giặt chỉ **7 phiếu / 2 tên / 0 ca trùng** ⇒ luật rolling-6-tháng
  **không có dữ liệu thật để hồi quy**; **hạ ưu tiên** so với máy lạnh.
- **Trùng slot phí cố định:** **22 ô (toà × kind × tháng) có ≥2 phiếu non-cancelled, tổng 45 phiếu**, tệ
  nhất `n=3` (toà `175f4329-eff2-4bb3-aee7-474dd2a0c429` / `tien_nha` / 2026-05 / 3 phiếu APPROVED =
  **108.400.000đ**); theo kind: rac 7, tien_nha 7, cong_an 3, ve_sinh 3, internet 1, quan_ly 1; theo tháng:
  05/2026 **4**, 06/2026 **5**, **07/2026 13** ⇒ **vẫn đang phát sinh**. ⇒ **Partial unique BASE index
  KHÔNG TẠO ĐƯỢC** trước khi 22 ô này được chủ quyết. **[BLOCKED-BY Slice −1.6]**
- **Trùng slot điện/nước — số phụ thuộc CÁCH KHOÁ:** theo **kỳ dịch vụ** (`date_trunc('month',
  min(item.start_date))`) là **2 ô meter** (meter `fea1d2f4-…` ELECTRIC 05/2026 và 06/2026) và **3 ô toà**
  (toà `d76268b2-…` ELECTRIC 05/06/07 — riêng ô 07/2026 gồm **2 phiếu trên HAI METER KHÁC NHAU**: hợp lệ
  dưới unique index theo meter nhưng **phá khoá tổng hợp theo toà và phá mẫu số của tỉ lệ supplier/tenant**);
  theo `voucher_date` là **4 ô meter / 5 ô toà**. Con số *"4 phiếu / 7.308.077đ trên meter `02660728…`"*
  **không tái lập** (meter đó đúng 1 phiếu mỗi tháng; 7.305.077đ là phiếu tháng 07). ⇒ **Chốt khoá TRƯỚC
  khi viết unique index và conflict backfill** — chênh **2×**.
- **Broker:** **[DELETE]** *"phải tạo unique index một-phiếu-một-hợp-đồng"* — `uq_ie_commission_per_contract`
  **đã tồn tại** (`UNIQUE INDEX ON public.income_expenses (contract_id, commission_kind) WHERE contract_id
  IS NOT NULL AND commission_kind IS NOT NULL AND deleted_at IS NULL AND approval_status <> 'CANCELLED' AND
  NOT commission_legacy_dup`) cùng `pg_advisory_xact_lock(hashtext('commission:'||contract||':'||kind))` ở
  `create_commission_voucher:73` và pre-check `P0001` ở `:77-93`. **CẤM DROP/REPLACE index này** — nó đang
  bảo vệ tiền hoa hồng. Việc còn lại thu về: **2 HĐ** có 2 phiếu broker APPROVED
  (`16edb8f0-2469-4682-92c6-b5d415f2de14`, `b543b3cd-0bb0-4a9a-afee-5a5fa7fd59e0`), **11** phiếu broker
  không gắn HĐ, **3** dòng `commission_legacy_dup=true`.
- **[ADD] `system_source='fixed_fee'` chỉ có 2 dòng trong TOÀN BỘ lịch sử, cả hai đã soft-delete**
  (`PC2607111` 300.000 vd 08/07; `PC2607117` 900.000 vd 09/07; cả hai vẫn `approval_status='APPROVED'`,
  `posting_status` NULL) ⇒ **mọi query backfill keyed on `system_source='fixed_fee'` sẽ trả 0 dòng và báo
  "sạch" SAI**. Nguồn thật của **376 phiếu** mà trang phí cố định đang đọc: **304 `system_source` NULL**,
  **67 `utility.bill`**, **5 `salary.staff`**.
- **[ADD] Cấu hình giá đang trống:** `building_fee_accounts` **109 dòng, 100% ở org thật, DEMO 0 dòng**;
  `default_amount` non-null 107/109; **`default_account_id` non-null 0/109**; `not_applicable=true` 0/109.
  **0/21 toà** khai đủ cả 7 kind; org thật thiếu **~35/126 ô (28%)** sau khi trừ 12 ô `thang_may` ở toà
  `has_elevator=false` (cả 6 toà có thang máy đã khai đủ). **Kind `quan_ly` có 0 dòng trên CẢ HAI org**
  (18 ô org thật + 3 ô DEMO) — **lỗ lớn nhất**, và bản 29/07 không nêu. `buildings.hidden_fixed_expenses`
  (`text[]`) **có tồn tại và đang dùng**: 4/21 toà, 6 ô, nhưng chỉ **3 ô** thuộc 7 kind cố định ⇒ giải
  thích được tối đa 3 trong ~35 ô thiếu.
- **[ADD] 9 phiếu flow-owned đang mắc bẫy `55000` của `cancel_period_fee`** (8 draft E2E DEMO + **1 phiếu
  production `PC2607096` "phí bỏ rác"**, org thật, 512LTT, 100.000đ, APPROVED, `system_source` NULL,
  `flow_kind=CANONICAL_INCOME_EXPENSE`, `in_batch=false`) — chi tiết ở Task 6 Step 2.
- **[ADD] `cancel_period_fee`/`cancel_utility_bill` chỉ soft-delete, KHÔNG đổi `approval_status`** ⇒ tồn
  tại dòng vừa `APPROVED` vừa `deleted_at IS NOT NULL` (live: 5 `utility.bill` + 2 `fixed_fee`) ⇒ **mọi
  adapter release keyed on `approval_status='CANCELLED'` sẽ bỏ sót**. Phải key theo chuyển trạng thái
  `deleted_at IS NULL → NOT NULL`. (Tiền vẫn đảo đúng vì `a85` khai trên `UPDATE OF … deleted_at`.)
- **[ADD] Nút chi tiền đang tự sửa danh mục cấp tổ chức:** `pay_period_fee:102-103` và
  `pay_utility_bill:83` đều `UPDATE income_expense_types SET is_deposit = FALSE …` — không audit, không
  guard. **CẤM writer/adapter mới lặp lại.**
- **[ADD] Evidence không có content hash:** `finance_evidence_objects` **159 dòng** (142 `ATTACHED`, 11
  `FINALIZED`, 6 `UPLOAD_INTENT`), `sha256` non-null **0**, `upload_token_hash` non-null **0**;
  `finalize_finance_evidence_v2` **không bao giờ ghi** hai cột đó ⇒ mọi guard "cùng hash" đang so NULL với
  NULL. Ngược lại, `income_expense_posting_evidence_relation_kind_check` hiện là
  `CHECK (relation_kind = ANY (ARRAY['ORIGINAL','INHERITED_LEGACY_DELTA']))` với **142/142 dòng
  `'ORIGINAL'`** ⇒ `INHERITED_BATCH` **đúng là** cần forward-update constraint.
- **[ADD] `income_expenses` dịch ~130 dòng/ngày:** **2.625 dòng tổng** (2.276 org thật + 349 DEMO) /
  **2.528 dòng alive** ngày 30/07, so với baseline 29/07 là **2.496 alive** *(plan 29/07 ghi ~2.496/2.528)*
  ⇒ mọi preflight phải so **delta với baseline đã ghi**, **không** so bằng tuyệt đối.
- **[ADD] `income_expense_flow_ownership` có 179 dòng** (runbook Đợt 2 ghi 172) ⇒ assertion đếm cứng "172"
  sẽ đỏ.
- **[ADD]** `income_expense_audit_log` chỉ **357 dòng / 256 phiếu**, sớm nhất `2026-06-30T12:50:20Z`;
  histogram `CREATED_DRAFT 163, CANCELLED 110, CANCELLED_NOTE 64, APPROVED 8, RESTORED 7, VERIFIED 4,
  UNVERIFIED 1`. Cột tự do duy nhất là **`note text`** — không có cột jsonb.
- **[ADD] `public.invoices` và `public.payments` vẫn GRANT `DELETE,INSERT,UPDATE` cho `authenticated`**
  (chỉ `anon` bị siết còn `REFERENCES,SELECT,TRIGGER`); lá chắn duy nhất `a00_invoice_derived_guard`
  (`20260730190000:252-273`) canh **một** cột `paid_amount`. ⇒ Sửa mọi câu hàm ý *"bảng tiền đã REVOKE
  DML"*: đúng cho **bốn** bảng trong `20260730102000_money_tables_revoke_dml.sql`, **không** đúng cho
  `invoices`/`payments`.

## 2. File map và migration order

### 2.1 Hạ tầng dùng chung — **[REORDER]** văn bản ở Slice 0, migration ở Slice 1

Theo `danh-gia…-v2.md §7`: **Slice 0 chỉ sửa văn bản plan + preflight, KHÔNG schema**; mọi migration của
Task 0 thuộc **Slice 1**.

- Modify: `scripts/apply-sql.mjs` — **[RETARGET]** bản 29/07 ghi *"bỏ thông điệp/usage `--dry-run` giả"*;
  **không có gì để bỏ**. Khuyết tật thật: `apply-sql.mjs:20` **hard-code** `ref = 'tryymsxyyckgbrmmvozx'`
  và apply thẳng không xác nhận ⇒ đổi sang bắt buộc `--project-ref` tường minh, ghi release metadata,
  refuse nếu ref production mà không có cờ xác nhận rõ ràng.
- Create: `scripts/rehearse-sql.mjs` — chưa tồn tại; chỉ chạy trên `SUPABASE_REHEARSAL_REF`/database clone;
  refuse nếu ref là production; static-only mode **không** được gọi là dry-run.
- Modify: `AGENTS.md` — đồng bộ lệnh type generation: **`npm run gen:types`** tự ghi atomically vào
  `src/integrations/supabase/types.ts` và tự chèn header; **cấm redirect** output. Verify bằng
  `scripts/__tests__/gen-supabase-types.test.ts`.
- Modify gate script — **[RETARGET]** bản 29/07 ghi *"để nhận biết mọi function/view mới"*: hai trong ba
  script **đã tự discover**. Hai lỗ thật: (a) nới `check-definer-acl.mjs:15-18` và
  `check-view-invoker.mjs:27` ra ngoài `n.nspname='public'` để phủ `app_private`; (b) nới
  `check-definer-acl.mjs` từ chỉ `has_function_privilege('anon', …)` sang assert **cả** `authenticated`
  **và** `service_role` không có EXECUTE trên hàm `app_private`. Vùng mù đo được: **30 hàm `app_private`
  DEFINER đang EXECUTE-able bởi `authenticated`**, **19 bởi `anon`**, và **287 hàm `public` DEFINER** nằm
  trong dải authenticated-không-anon mà gate **không bao giờ query** ⇒ *"chạy `check-definer-acl`"* **không
  thể** chứng minh các REVOKE mà plan khẳng định. Regenerate `scripts/definer-acl-baseline.json` **chỉ sau**
  khi đã nới. **Ghi rõ:** `scripts/check-approver-provenance.mjs` **không phải** gate discovery object —
  `:41-56` chỉ là một data query đếm dòng `income_expenses` có `approval_status='APPROVED' AND approved_by
  IS NULL AND system_source IS NULL` từ `CUTOFF='2026-07-23'` (`:25`).
- Create: `supabase/migrations/20260731010000_special_page_runtime.sql` — organization timezone,
  `org_today_v1`, shared submit context/token primitives, **source-aware Finance core (MAIN + CHANGE +
  ROUNDING + period backstop bên trong)**, shared signed-deposit resolver, evidence batch lineage.
  **[DELETE]** phần *"technical-membership isolation"* và *"tracked type-resolver definitions"* — xem
  Task 0 Step 2 và Step 3.
- **[ADD]** Create: `supabase/migrations/20260731012000_realtime_lifecycle_tables.sql` — theo đúng mẫu
  `20260730230000_realtime_money_tables.sql` (`:52-57` **từ chối** bảng có `relrowsecurity=false`):
  `ALTER PUBLICATION supabase_realtime ADD TABLE public.contract_terminations, public.contract_transfers,
  public.building_utility_accounts`. Cả **ba bảng hiện KHÔNG trong publication** ⇒ nghe mà không có
  migration này thì code đúng, test mock xanh, **production im lặng vĩnh viễn**. Verify:
  `select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename in (…)`
  phải trả **3 dòng**.
- Dependency from Plan 2 Slice 2: apply `20260731010500_contract_transfer_audit_hardening.sql` **trước**
  `20260731011000_room_residence_segments.sql`; resolver chỉ được trusted khi future transfer audit đã
  fail-closed. **[ADD]** resolver phải phủ **cả đường đổi phòng thứ hai** (trigger
  `apply_contract_transfer`, DRAFT→APPROVED, ghi đè `room_id, rent_price, total_deposit` **và
  `start_date/end_date`**, đặt `status='TRANSFERRED'`) ⇒ **bỏ giả định "`contracts.start_date` là mốc đoạn
  đầu"**.
- **[RETARGET]** Create `src/hooks/useIsOrgOwner.ts` → hook chỉ được gọi **một public wrapper mỏng** trên
  `app_private.is_org_owner_v1`; **không** định nghĩa lại khái niệm chủ (§0.4). Bỏ hạng mục
  *"update `list_organization_members_v1`/member-count visibility và `current_visible_owner_ids()` cho
  private provenance registry"* — xem Task 0 Step 3.
- **[RETARGET]** Modify: **`src/pages/ThanhToan.tsx`** (không phải `ThuTien.tsx`),
  `src/hooks/useRealtimeDataSync.ts`, và thêm `src/hooks/useReceiptPasteTarget.ts` (**chỉ để BẢO TOÀN**,
  xem Task 0 Step 4), `src/hooks/income-expenses/batch.ts`.
- **[RETARGET] Trạng thái cây làm việc** — bản 29/07 ghi 4 file dirty. Đo lại 30/07: **đúng 3 file dirty**
  — `src/components/auth/RequirePermission.tsx`, `src/hooks/useIsAdmin.ts`, `src/hooks/useMyPermissions.ts`
  (nội dung: chuyển từ fail-silent sang throw + validator + refetch 60s + nhánh `isError` có
  `data-testid="permission-access-error"`). **`src/hooks/useRealtimeDataSync.ts`, test của nó, và
  `src/App.tsx` đang SẠCH** — commit `678d4ab` đã hấp thụ thay đổi đó ⇒ đọc file **tại HEAD, không tìm
  diff**; bốn bảng tiền (`payments`, `income_expense_items`, `accounts`, `cash_handovers`) đã có mặt trong
  `SYNC_TABLES` và trong publication, **KHÔNG thêm lại**. **[ADD] Có 3 file test UNTRACKED của người dùng**
  — `src/components/auth/__tests__/RequirePermission.test.tsx`,
  `src/hooks/__tests__/useIsAdmin.test.ts`, `src/hooks/__tests__/useMyPermissions.test.ts` — **tuyệt đối
  không `git add -A` / `git add .` / `git clean`**; một `git clean` sẽ **xoá mất** chúng.

### 2.2 Plan 1 database — **[REORDER]** đánh số lại, theo đúng thứ tự

1. `supabase/migrations/20260731020000_special_fee_schema.sql` — rule versions, claims, batches, proposals,
   alerts, conflicts, mapping, ACL/guards, **seed cờ `special_fee.payment.v1` mode `OFF`**.
2. `supabase/migrations/20260731021000_special_fee_rule_rpcs.sql` — owner publish/list, effective month,
   utility denominator, commission/maintenance selector.
3. `supabase/migrations/20260731022000_special_fee_preview.sql` — pure server preview và deterministic claim
   evaluation (**mọi read RPC khai VOLATILE**).
4. `supabase/migrations/20260731023000_special_fee_writer.sql` — submit/exception decision/atomic
   posting/audit, **nhánh `CASE` cho `dispatch_finance_decision_v2`**.
5. `supabase/migrations/20260731024000_special_fee_cancel_repeat.sql` — release/reversal adapters,
   **AFTER UPDATE trigger backstop làm cơ chế CHÍNH**, và recurring integration.
6. `supabase/migrations/20260731025000_special_fee_read_wrappers.sql` — read models, compatibility boundary,
   rollout/backfill report, **public route-read RPC** (Task 7 Step 1c).

### 2.3 TypeScript/UI/test files

- Create: `src/lib/specialFeeRules.ts`, `src/lib/__tests__/specialFeeRules.test.ts`,
  `src/lib/__tests__/specialFeeRules.property.test.ts`.
- Create: `src/hooks/useSpecialFeeRules.ts`, `src/hooks/useSpecialFeePayments.ts`.
- Modify after applied schema: `src/integrations/supabase/types.ts` via `npm run gen:types` **không
  redirect**; sau đó verify header và review generated diff. ⚠ Repo **đang có drift sẵn ~92 quan hệ
  `network_*`** (trong đó 65 phân mảnh ngày tự sinh mỗi ngày) — xử riêng, **đừng gộp vào PR tính năng**.
- Create: `src/components/thu-tien/SpecialFeeValidationSummary.tsx`, `SpecialFeeExceptionDialog.tsx`,
  `SpecialFeeExceptionQueue.tsx`, `SpecialFeeAlertsDrawer.tsx`, `SpecialFeeRuleSettingsDialog.tsx`,
  `MaintenanceRulePaymentDialog.tsx`.
- Modify: `src/lib/feeCategories.ts`, `src/lib/fixedExpenseCategories.ts`, `src/lib/feeCategories.test.ts`,
  `src/pages/ThanhToan.tsx`, `src/components/thu-tien/PeriodFeePanel.tsx`, `PeriodFeeSheet.tsx`,
  **`UtilityEnContent.tsx`**, `PeriodFeeVoucherList.tsx`, `PeriodCommissionModal.tsx`,
  `src/hooks/usePeriodFeeState.ts`, `useUtilityPayState.ts`, `usePeriodFees.ts`, `useUtilityBills.ts`,
  `useMaintenanceBatch.ts`, `src/hooks/income-expenses/batch.ts`, và
  `src/hooks/__tests__/useRealtimeDataSync.test.ts`.
  **[DELETE] KHÔNG sửa `UtilityDesktopPanel.tsx` và `UtilityBillSheet.tsx`** (dead code, 0 importer).
  Không sửa mutation contract truyền thống của `src/hooks/useCommissionVoucher.ts`;
  `src/components/contracts/CommissionVoucherModal.tsx` tiếp tục dùng legacy hook.
- **[RETARGET] Defining migration của ba SQL surface phí cố định.** Bản canonical **hiện hành** của
  `public.resolve_fixed_expense_type(uuid,text)` là
  `20260728180000_income_expense_type_canonicalization.sql:944-1025` — **KHÔNG** phải
  `20260708130100_nrm_vn_resolve_fixed_expense_type.sql`. Copy body từ file 0708 (`:45`, với
  `WHERE t.user_id = p_owner` ở `:60` + một raw INSERT) sẽ **âm thầm revert canonicalization 28/07** (mất
  org-scope, mất `p_is_restricted` cho `quan_ly`) **ngay trong migration mà plan hứa là
  behavior-preserving**. Danh sách đúng để tra cứu: `20260708130300_get_period_fee_status.sql:12` (bản gốc
  `get_period_fee_status`, bản 29/07 **bỏ sót**), `20260710120000_period_fee_status_v2.sql`,
  `20260710120100_pay_update_cancel_v2.sql` (định nghĩa `pay_period_fee:27`, `update_period_fee:208`,
  `cancel_period_fee:307` — **liên quan tới wrapper pay/cancel**, không phải read surface),
  `20260728180000:944`. Bỏ `20260710120300_recurring_draft_mode.sql` (không định nghĩa surface nào trong
  ba). **Bắt buộc `pg_get_functiondef` live cho cả ba hàm rồi diff với migration mới nhất trước khi viết
  wrapper.** ⚠ Chỉ `resolve_fixed_expense_type` được xác nhận khớp `20260728180000:944`; digest
  live-vs-migration của `fee_type_matches` và `get_period_fee_status` **chưa đo** (decision record §11.2
  mục 6; md5 tham chiếu đã có: `ensure_income_expense_type_v1 = b1880461933551ccf20011ebec66ddd3`,
  `normalize_income_expense_type_name = 7822a97fcc48128d4fe95d33ab2fb27c`).
- Create DB/scripts: `scripts/audit-special-fee-rollout.mjs`, `scripts/test-special-page-runtime.mjs`,
  `scripts/test-special-fee-rules.mjs`, `scripts/test-special-fee-concurrency.mjs`,
  `scripts/test-special-fee-writer.mjs`; create pure routing test
  `src/hooks/__tests__/specialFeeRouting.test.ts` và extend
  `src/lib/__tests__/financeV2AdaptersMigration.test.ts`.
  **[DELETE] `scripts/check-technical-membership-isolation.mjs`** — không còn deliverable để gác (Task 0
  Step 3).
- Create E2E after deployment: `.e2e-fleet/specs/special-fee-fixed.spec.ts`,
  `special-fee-utility-warning.spec.ts`, `special-fee-commission-maintenance.spec.ts`,
  `special-fee-scope-isolation.spec.ts` (**cả 4 hiện chưa tồn tại**). **[RETARGET]** Bản 29/07 ghi *"modify
  `utility-paste-receipt.spec.ts` vì test hiện dựa vào cả desktop/mobile surface cùng mount và phải được
  đổi sang invariant chỉ một surface"* — **đảo lại**: cả `utility-paste-receipt.spec.ts` **và**
  `.e2e-fleet/specs/thanh-toan-page.spec.ts` (file này **chưa tồn tại** lúc viết plan 29/07) là **gate hồi
  quy phải GIỮ XANH**, không phải file cần viết lại. Xem Task 0 Step 4.
- **[ADD] `.e2e-fleet` không có `package.json`, không có `tsconfig.json`** ⇒ 4 spec mới nhận **zero type
  checking** trong khi `npm run typecheck:baseline` (chỉ `include: ["src"]`, `strict:false`,
  `noImplicitAny:false`) báo xanh. Hoặc thêm `.e2e-fleet/tsconfig.json` + script `typecheck:e2e`, hoặc
  **ghi thẳng** rằng lỗi type của spec mới chỉ lộ ở runtime.

### 2.4 **[ADD]** Đánh số migration — luật và lý do

**Luật:** mọi migration mới phải sort **SAU** file đã apply cuối cùng
(`20260730280000_stable_fn_row_lock_regression.sql`), tức thuộc dải `20260731xxxxxx`. Slice −1 dùng dải
`20260731000000 → 20260731002500` (apply trước mọi file plan).

Lý do có **hai**, không phải một:

1. **Đụng tên trực diện:** `20260730160000` (timestamp Plan 2 định dùng) đã bị
   `20260730160000_cashbook_closing_permissions.sql` chiếm — tracked, **đã apply prod**, commit `07ddfca`.
   Chín timestamp còn lại mà hai plan đặt thì **trống**, nên đây là lỗi *một chỗ*, không phải toàn dải.
2. **Hiểm hoạ thứ tự replay:** mọi `CREATE OR REPLACE` mà bản 29/07 đặt ở `202607300000xx` sẽ **bị khối
   `20260730100000 → 20260730280000` ghi đè** khi rebuild một clone sạch ⇒ clone **không phản ánh
   production** và gate rehearsal cho kết quả sai lệch.

Thêm một bước preflight: **fail nếu timestamp mới trùng bất kỳ file đã có** trong `supabase/migrations/`
(cây làm việc hiện có hai cặp trùng ở `20260730230000` và `20260730240000`, cộng một trùng **tên logic**
`annotate_evidence_protection.sql` ở cả `20260730230000` và `20260730270000`).

## 3. Task-by-task implementation

### Task 0: Đóng cổng an toàn trước khi tạo schema

**Files:**

- Modify `AGENTS.md`, `scripts/apply-sql.mjs`, `scripts/check-definer-acl.mjs`,
  `scripts/check-view-invoker.mjs`, **`src/pages/ThanhToan.tsx`**, `src/hooks/usePeriodFeeState.ts`,
  `src/hooks/useUtilityPayState.ts`, `src/hooks/useRealtimeDataSync.ts`,
  `src/hooks/__tests__/useRealtimeDataSync.test.ts`, `docs/he-thong/realtime-sync.md`.
- Create `scripts/rehearse-sql.mjs`, `src/hooks/useIsOrgOwner.ts`,
  `supabase/migrations/20260731010000_special_page_runtime.sql`,
  `supabase/migrations/20260731012000_realtime_lifecycle_tables.sql`.
- **[DELETE]** khỏi Files: `src/pages/ThuTien.tsx`, `scripts/check-technical-membership-isolation.mjs`.

Trạng thái cây làm việc: xem §2.1 (3 file dirty, 3 file test untracked, `useRealtimeDataSync.ts` **SẠCH**).

- [ ] **Step 0′: [ADD] Kiểm MẪU NEO trước MỌI `CREATE OR REPLACE` lên hàm dùng chung.** Đợt 0–6 vá nhiều
  hàm theo mẫu `pg_get_functiondef → position(anchor) → replace → EXECUTE`, mỗi chỗ tự `RAISE` **"DỪNG,
  không vá mù"** khi neo biến mất ⇒ forward-redefine mù làm **các migration đó không chạy lại được** và
  **gãy mọi rehearsal về sau**. Danh sách hàm có nguy cơ mà plan này (hoặc Plan 2) định đụng, kèm neo:
  `ie_compat_update_pending_v2` (`20260730190000:36-83`, neo `v_meta_keys`/`v_money_keys`),
  `update_income_expense_quick` (`:91-115`, neo `notes = p_notes`),
  `assert_period_open_for_edit_v1` (`:179-211`, cộng WP2 `:355`), `assert_manual_voucher_v1` (`:213-237`),
  `can_reverse_collection_v1` + `reverse_invoice_collection_v5` (`20260730250000:30-104`, neo
  `RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn'`), `ie_compat_cancel_v2` (`:111-174`, neo
  `ie_flow_system_owned_v2`), `annotate_income_expense_v1` (`20260730270000:24`),
  `propose_cashbook_closing_v1` (`20260730210000:348-356`, neo `  IF p_counted_balance IS NULL THEN`).
  **KHÔNG có nguy cơ** (đã xác minh `CREATE OR REPLACE` trần, không neo): `confirm_cashbook_closing_v1`
  (`20260730170000:369`, `20260730210000:173`) và `cashbook_balance_as_of_v1` (`20260730170000:562`,
  `20260730210000:63`). Nếu buộc phải redefine: **cập nhật LUÔN mẫu neo** trong migration Đợt tương ứng,
  hoặc thêm marker "đã vá" để DO-block tự bỏ qua. Ghi kết quả kiểm vào runbook.
- [ ] **Step 0″: [ADD] Chốt số phận hai file untracked TRƯỚC khi viết migration nào** (§0.5 mục 2). Phải
  hỏi chủ. Đặc biệt: quyết WP2 (`20260730240000_authz_remaining.sql`) **trước** khi đụng
  `reverse_invoice_collection_v5`, và biết rằng WP2 mang **hai** thứ plan này cần:
  (a) quyết định "được nhìn sổ" cho undo (`:34-38`), (b) vị ngữ kỳ mở rộng sang **kỳ dịch vụ của hạng mục**
  (`:429-457`) — cái sau là hiểm hoạ trả trước ở §0.2 mục 3. Thứ tự đề xuất: **apply WP2 trước → regen
  types → chạy lại ma trận quyền → rồi mới bắt đầu special-page.**
- [ ] **Step 1: Sửa rehearsal contract.** `rehearse-sql.mjs` nhận `--project-ref` **bắt buộc**; từ chối
  `tryymsxyyckgbrmmvozx`; yêu cầu clone disposable hoặc chạy static SQL parser. `apply-sql.mjs`: bỏ
  hard-code ref ở `:20`, chỉ apply thật với ref tường minh + release metadata; không tài liệu nào được gọi
  là "dry-run production". **[ADD] Step 1.0 bootstrap clone:** clone **PHẢI** dựng từ prod dump (hoặc từ một
  file DDL bootstrap riêng) vì **KHÔNG migration nào trong `supabase/migrations/` tạo**
  `app_private.server_feature_flags` / `…_canary_orgs` / `…_operations` / `…_events` /
  `evaluate_feature_route` / `set_feature_route_v1` / `claim_feature_operation_v1` + 6 trigger guard. Chỗ
  dựa đúng đã có: vòng lặp prerequisite-assert `20260723010000_finance_v2_semantics_snapshot.sql:69-96`
  (`to_regclass`/`to_regprocedure` → `RAISE 'Missing Finance V2 prerequisite relation %'`) — **loud và tự
  chẩn đoán**, không phải "lỗi khó hiểu". Nếu clone không mang được Đợt 0–6, **ghi thẳng vào plan** rằng
  rehearsal **không bao phủ** `a02_ie_profit_lock_*`, `trg_ie_check_lock_ins`, nhánh ANNOTATE của
  `guard_income_expense_owned_payload`, và `DO $guard$` của `20260730280000` — và phải có bộ test riêng chạy
  thẳng trên prod trong `BEGIN … ROLLBACK`.
- [ ] **Step 1b: Sửa type-generation contract.** Đối chiếu `scripts/gen-supabase-types.mjs`: script **tự**
  atomic-write `src/integrations/supabase/types.ts` (outputPath hardcode `:192`) và `buildGeneratedTypesFile`
  **tự** chèn header (`:9`/`:79`). Sửa `AGENTS.md`/runbook thành `npm run gen:types` **không redirect**;
  chạy/mở rộng `scripts/__tests__/gen-supabase-types.test.ts`; scan bảo đảm redirect không còn xuất hiện
  trong tài liệu thực thi. **[ADD]** Ghi rõ drift `network_*` ~92 quan hệ để người sau không tưởng là do
  migration của mình.
- [ ] **Step 2: Tạo tracked runtime primitives.**
  - `organization_timezones` + `org_today_v1` — **không** dùng `CURRENT_DATE`.
  - **[DELETE] Bỏ toàn bộ digest-check allowlist / abort / forward-define cho
    `normalize_income_expense_type_name` và `ensure_income_expense_type_v1`.** Cả hai có defining migration
    tracked `20260728180000:13` và `:792` (12 tham số **byte-identical** với chuỗi preflight của chính
    plan), REVOKE `:23`/`:900`. Slice 1 **chỉ assert signature còn khớp rồi PHỤ THUỘC**; forward-define từ
    snapshot live sẽ **revert canonicalization 28/07** về `WHERE t.user_id = p_owner`. Nhánh *"absent trên
    clone là hợp lệ"* **không bao giờ chạy**.
  - **[RETARGET] Việc còn thật của "org thay vì creator":** thay `pay_utility_bill:82`
    `public._termination_ensure_type(v_owner,'expense',v_type_nm)` bằng
    `app_private.ensure_income_expense_type_v1(p_organization_id => v_org, …)` với `v_org` =
    `buildings.organization_id` đã có ở `:72`. Ghi rõ hàm cũ khoá theo **creator `user_id`**, dùng `lower()`
    thay vì `normalize_income_expense_type_name`, và chọn org bằng `min(organization_id::text)` + `limit 1`
    **không ORDER BY**. Test: hai user cùng org resolve đúng **một** type; một phiếu của org A không bao giờ
    gắn type của org B.
  - **Refactor posting helper** thành `finance_v2_post_voucher_with_source_v1(…, source_kind,
    external_source_kind, external_source_id, source_fingerprint)`: allowlist chỉ
    `SPECIAL_PAGE_FEE/SPECIAL_FEE_CLAIM` và `TERMINATION_REFUND/TERMINATION_REFUND_OBLIGATION`; verify
    source row cùng org/voucher/fingerprint. **[ADD]** Core mới **phải phát đủ `MAIN` + `CHANGE` +
    `ROUNDING`** (khuôn `finance_v2_post_manual_voucher` chỉ có `MAIN`, còn cầu a85 thì có cả ba) và **phải
    có period backstop bên trong** vì nó sẽ được gọi từ nhiều adapter. Existing manual wrapper giữ
    signature/response và delegate `MANUAL` với external fields null.
  - **[RETARGET] Cổng kỳ:** **bỏ** `finance_v2_is_cashbook_period_open` khỏi vai trò "gate kỳ duy nhất" —
    nó **chỉ đọc `accounts.lock_date`**, và **0/28 account** có `lock_date` ⇒ hôm nay nó là **no-op tuyệt
    đối, trả `true` cho mọi sổ**. Cưỡng chế thật đang nằm ở hai trigger cấp bảng **vô điều kiện**
    (`income_expenses_check_lock` theo `voucher_date`, `income_expense_posting_lines_check_lock` theo
    `posted_on`, cả hai gọi `cashbook_closed_through_v1` và ném `[CASHBOOK_CLOSED]` `P0001`) cộng
    `a02_ie_profit_lock_*`. ⇒ Pre-check **trước khi có voucher** gọi
    `app_private.cashbook_closed_through_v1(cashbook)` (= `GREATEST(max(cashbook_closures.closed_through),
    accounts.lock_date)`) để **khớp đúng thứ mà trigger sẽ cưỡng chế**; sau khi voucher tồn tại thì gọi
    `app_private.assert_period_open_for_edit_v1(voucher, action)` (`20260730131000:22`, ba nhánh
    `[CASHBOOK_CLOSED]` `:53` / `[HANDOVER_LOCKED]` `:68` / `[PROFIT_LOCKED]` `:85`). **Hai hàm KHÔNG
    thay thế lẫn nhau** — hàm sau nhận voucher id nên không dùng được trước khi dòng tồn tại. **Ghi rõ mức
    độ:** tiền **không** lọt vào sổ đã chốt hôm nay; khuyết tật là **chất lượng lỗi + vị trí gate**
    (pre-check báo OPEN rồi transaction chết sâu trong trigger với message chung).
  - Money writer luôn dùng full `evaluate_feature_route`, **gọi ĐÚNG MỘT LẦN mỗi transaction** rồi snapshot
    `(evaluated, stored mode, config_version)` vào biến — nó dùng `clock_timestamp()` nên hai lần evaluate
    trong một transaction có thể cho `CANONICAL` rồi `FROZEN`. Pure/read-only resolver chỉ phục vụ UI
    preview; lỗi/unknown **không** được client tự fallback sang writer khác.
  - **[ADD] Fail-closed cho cờ thiếu phải do writer tự làm:** `evaluate_feature_route` **trả `'LEGACY'` khi
    `NOT FOUND`** (chạy thật: 4 key không tồn tại × 3 org = 12/12 `LEGACY`). Writer phải
    `SELECT mode, force_freeze, config_version INTO … FROM app_private.server_feature_flags WHERE
    feature_key = <key> FOR SHARE; IF NOT FOUND THEN RAISE 'ROUTE_NOT_CONFIGURED' USING ERRCODE='55000'`
    — **runtime**, không chỉ deploy-time.
  - **[RETARGET] `set_feature_freeze_v1`:** hôm nay **không một function nào trong toàn DB ghi cột
    `force_freeze`** (8 hàm chỉ đọc; `set_feature_route_v1` UPDATE đúng 13 cột, **không** có nó) ⇒ freeze =
    **UPDATE tay**, **không sinh** `server_feature_flag_events`, **không bump** `config_version` (bằng
    chứng: `income_expense.profit_close.v2` `force_freeze=true`, `config_version=1`, **0 event**). Chọn dứt
    khoát: (A) viết `set_feature_freeze_v1(p_feature_key, p_expected_config_version, p_freeze, p_actor,
    p_reason, p_approval_reference)` có CAS + `INSERT server_feature_flag_events` (`FREEZE_SET`/
    `FREEZE_CLEARED`) + REVOKE khỏi PUBLIC/anon/authenticated/service_role + đưa vào `check-definer-acl`;
    hoặc (B) **ghi thẳng** rằng freeze là UPDATE tay qua Management API và phải lập biên bản. Không được
    viết như thể hàm đó đã có.
- [ ] **Step 2b: Tạo evidence lineage dùng được cho batch.** Forward-update check constraint
  `income_expense_posting_evidence_relation_kind_check` để thêm **`INHERITED_BATCH` riêng**, không overload
  `INHERITED_LEGACY_DELTA` (constraint hiện là `CHECK (relation_kind = ANY (ARRAY['ORIGINAL',
  'INHERITED_LEGACY_DELTA']))`, **142/142 dòng là `'ORIGINAL'`** ⇒ phần này của plan **đúng**); thêm unique
  `(posting_id, evidence_id)` và validate self-FK. Với batch monthly đã sort, child đầu link evidence
  `ORIGINAL` khi object còn `FINALIZED`; các child sau link cùng evidence bằng `INHERITED_BATCH`, bắt buộc
  `inherited_from_link_id` trỏ ORIGINAL cùng org/batch và evidence đang `ATTACHED`. Source-aware core nhận
  explicit lineage, không thử insert ORIGINAL lần hai. Cả batch một transaction nên lỗi child bất kỳ
  rollback posting/link/state của mọi child.
  **[ADD] BỎ CHỮ "HASH" khỏi mọi guard evidence.** `finalize_finance_evidence_v2` **không bao giờ ghi**
  `finance_evidence_objects.sha256` hay `upload_token_hash` (159 dòng, **0** có `sha256`, **0** có
  `upload_token_hash`) ⇒ mọi so sánh "cùng hash" đang so NULL với NULL và **luôn thoả**. Chọn: **(A)** mở
  rộng `finalize_finance_evidence_v2` để ghi `sha256` thật (từ `storage.objects.metadata` eTag/checksum,
  hoặc client cung cấp + verify `byte_size`), hoặc **(B)** định nghĩa lại "vân tay evidence" =
  `(organization_id, bucket_id, object_name, byte_size, mime_type)` và **nói rõ trong plan rằng KHÔNG có
  content hash**.
- [ ] **Step 2c: Tạo một signed-deposit basis dùng chung.** Private helper
  `app_private.resolve_signed_contract_deposit_basis_v1(p_organization_id uuid, p_contract_id uuid,
  p_as_of timestamptz)` trả ordered source rows và các tổng `realPostedIn`, `postedReleaseOut`,
  `recognizedHistoricalIn`, `netHeld`, cùng `basisStatus`/reason/fingerprint. Chỉ active `POSTED` real-cash
  `INCOME + DEPOSIT` được tính thực thu; `EXPENSE + DEPOSIT`, canonical refund/release/offset trừ ra;
  cancelled/deleted/reversed không tính. Virtual `NOT_APPLICABLE` chỉ vào `recognizedHistoricalIn` khi đúng
  một opening-balance source cùng contract đã có immutable owner reconciliation; không đổi thành cash.
  Preview dùng cùng aggregation read-only; submit/birth phải khóa contract và các source rows trước khi gọi
  lại. Broker và Plan 2 **bắt buộc reuse** helper này, không sao chép công thức. **[ADD]** Chỉ có **5**
  `contract_deposit_links` trên toàn DB (không có cột amount) ⇒ bảng đó chỉ là metadata, không phải coverage.
- [ ] **Step 3: [DELETE + RETARGET] Registry technical SERVICE membership → CONDITIONAL, và tách phần thật
  sự cần.** Mở đầu bằng preflight `SELECT` đếm superadmin **không** có membership ACTIVE hợp lệ; **nếu = 0
  (đúng hiện trạng) thì SKIP toàn bộ registry SERVICE** và ghi lý do skip vào runbook. Căn cứ: chỉ có **1**
  superadmin (`90450d5f-…`) và **2** org, và người đó **có membership ACTIVE hợp lệ ở CẢ HAI** (OWNER ở org
  thật từ 13/07, STAFF ở DEMO từ 17/07) ⇒ nhánh provision **không tới được**, **không dòng SERVICE nào được
  tạo**, nên không side effect nào (`my_org_ids` nới rộng, `current_admin_org_v1` trôi, member-list nhiễu)
  có thể xảy ra. `member_type='SERVICE'` **đã có** trong `organization_memberships_member_type_check`
  (`OWNER|STAFF|SHAREHOLDER|PARTNER|SERVICE`), **0 dòng SERVICE** ⇒ không cần migration constraint. Giữ lại
  **hai** việc, tách thành **Step 3-alt bắt buộc chạy**:
  - **(a) [ADD] Shared context BẮT BUỘC gọi overload org-scoped `app_private.resolve_finance_actor_v2(p_organization_id)`
    — CẤM biến thể no-arg.** Biến thể no-arg **đang** ném `42501 'ambiguous membership; org-scoped
    resolution required'` cho đúng superadmin duy nhất, **chỉ vì** người đó có **2 membership thường**. Vị
    ngữ đếm của nó **không có chiều `member_type`/technical** ⇒ bản vá mà plan 29/07 đề xuất
    (*"no-arg variant loại technical rows khỏi default/ambiguity"*) **không thể** giảm 2 xuống 1 và nhắm
    sai nguyên nhân. Thêm fixture actor 2-org.
  - **(b) [ADD] Vá `public.my_org_ids()` thêm cửa sổ hiệu lực.** Nó gate bằng `status='ACTIVE'` **một mình**,
    trong khi đường ghi (`authorize_tenant_action_v3:45-46`) kiểm cả `valid_from` và `valid_to` ⇒ **đường
    ĐỌC rộng hơn đường GHI**, lan qua **34 policy RLS** cộng `authorized_scope_all_v3:9` và
    `ie_visible_cashbook_ids_v1:10`. Hôm nay **latent** (0 membership `ACTIVE` mà `valid_to <= now()`, 0 mà
    `valid_from > now()`) nhưng sống ngay khi ai thu hồi bằng cửa sổ — **đúng cách repo vẫn thu hồi vai
    trò**. Đây là **Step riêng**, **không** gộp vào việc ẩn dòng SERVICE.
  - **[ADD] Nếu chủ vẫn muốn giữ registry SERVICE về sau:** gate script phải liệt kê **50 hàm** không lọc
    cả `member_type` cả `valid_to` (trong **105** hàm tham chiếu `organization_memberships`; chỉ **12** hàm
    lọc `member_type`), trong đó có **12 hàm TIỀN** — gồm `post_collection_tender_v2`,
    `reverse_collection_tender_v2`, `ie_approver_ids_v1`, `resolve_approval_actor_v2`,
    `cashbook_close_confirmers_v1`, `confirm_cashbook_closing_v1`, `finance_v2_register_birth_v1`,
    `create_finance_evidence_upload_intent_v2`, `salary_payout_v1`, `manager_salary_payout_v1`,
    `can_reverse_collection_v1`, `ie_visible_cashbook_ids_v1`. Danh sách *"ít nhất 5–6 hàm"* của bản 29/07
    phủ **3/50** (`my_org_ids`, `current_admin_org_v1`, `current_visible_owner_ids` nằm trong tập; còn
    `list_organization_members_v1` **có** lọc, và `authorized_scope_all_v3` **không** chạm bảng đó trực
    tiếp — nó thừa hưởng qua `unnest(public.my_org_ids())` ở `:9`).
- [ ] **Step 3b: Tách authorization khỏi custody override.** Manager submit/proposal gọi
  `authorize_tenant_action_v3` với đúng consumer key `thu_tien.collect`; **chọn sổ không thay thế
  permission**. **[ADD] Invariant in đậm:** *"`authorize_tenant_action_v3` CHỈ trả lời câu hỏi PHẠM VI. Với
  `thu_tien.*` (`requires_cashbook_possession=false`, `required_dimensions=[]`) việc truyền
  `p_building_id`/`p_cashbook_id` KHÔNG chứng minh giữ sổ, và truyền NULL vẫn pass nếu có cạnh ALLOW cấp
  ORGANIZATION. Mọi cưỡng chế quan hệ với sổ phải là một lời gọi RIÊNG:
  `assert_cashbook_access_v2(...,'CUSTODIAN',...)` cho GHI, `app_private.ie_visible_cashbook_ids_v1()` cho
  HOÀN TÁC."* Test bắt buộc: actor chỉ có một override ORGANIZATION và **không giữ sổ nào** phải bị từ chối
  ở **cả** submit **và** undo.
  Owner/superadmin exception decision đi qua `special_fee_is_owner_or_superadmin_v1` (§0.4) + exact target
  validation/audit, không phụ thuộc permission delegable. Với `MANAGEMENT`, wrapper special gọi
  `can_create_restricted_ie()` cho actor thường (**giữ nguyên hàm này** — md5
  `90ad1994a07546d11c18c368ab2b3bb8`, là gate server thật tại `pay_period_fee:50-52`, có trong
  `scripts/definer-acl-baseline.json:16`) và một nhánh superadmin-only có audit.
  **[RETARGET]** Câu *"Mọi `is_super_admin()` được bypass chỉ trong public special-page RPCs"* **sai hiện
  trạng** ⇒ đổi thành **"KHÔNG THÊM bypass superadmin mới ngoài public special-page RPC"**, kèm inventory
  bypass **hiện hữu** phải giữ nguyên và **không** được test ngược: `reverse_invoice_collection_v5`, 7
  policy `*_super_admin_all` (invoices, income_expenses, buildings, rooms, contracts,
  contract_terminations, accounts), `has_full_building_scope()`, `can_access_building()`,
  `ie_visible_cashbook_ids_v1()`. **[ADD] Một Step riêng:** siết `public.is_super_admin()` để tôn trọng cột
  `super_admins.organization_id` (hoặc DROP cột nếu chủ ý là global), REVOKE EXECUTE khỏi `anon`/PUBLIC cho
  `is_super_admin()`, `can_create_restricted_ie()`, `current_visible_owner_ids()`, và đưa `search_path` của
  `is_super_admin`/`has_full_building_scope` về `pg_catalog, app_private, public` (hiện là `'public'`, lệch
  chuẩn mà chính Step 3c yêu cầu — và đây là **hai cửa bypass rộng nhất hệ thống**).
  **[ADD] Ghi baseline custody của các nút cũ để đo được regression** (§1.1): ba writer legacy chỉ kiểm
  `accounts.user_id = auth.uid() OR is_admin() OR is_super_admin()`, `ie_compat_insert_v2` đòi
  `CUSTODIAN`, `create_commission_voucher` không kiểm gì. Test âm bản bắt buộc: **CUSTODIAN không phải
  `accounts.user_id` PHẢI chi được qua writer mới**, và **`accounts.user_id` đã bàn giao PHẢI bị chặn**.
  Live: 27–28 account alive thuộc 8 `user_id`.
  `special_page_cashbook_override_v1` chỉ phát one-shot token sau real-account/same-org/open-period check,
  với authority mode `SUPERADMIN_CROSS_ORG` (tên mode legacy, áp cho mọi superadmin special-page override)
  hoặc `OWNER_EXCEPTION_APPROVAL`; owner không mang nhãn superadmin và normal valid submit của owner
  **không** bypass custody.
- [ ] **Step 3c: Khóa SECURITY DEFINER và evidence input.** Mọi definer function dùng fixed `search_path`
  (`pg_catalog, app_private, public` theo nhu cầu), schema-qualified objects, revoke PUBLIC/anon/service_role
  và chỉ grant public wrapper tối thiểu cho `authenticated`. **[ADD] Mọi hàm mới — kể cả read RPC — phải
  khai VOLATILE (mặc định), TUYỆT ĐỐI không `STABLE`/`IMMUTABLE`.**
  `20260730280000_stable_fn_row_lock_regression.sql:57-89` cài một `DO $guard$` quét toàn schema (đệ quy 4
  tầng lời gọi) tự `RAISE EXCEPTION 'Còn hàm public khai STABLE/IMMUTABLE mà chạm khoá dòng — sẽ ném 25006
  qua PostgREST: %'`; `app_private.authorize_tenant_action_v3` có `SELECT … FOR SHARE` (prod
  `provolatile='v'`) và **cả ~8 RPC mà plan gọi là "read-only" đều gọi nó** ⇒ khai `STABLE` là **vừa ném
  `25006` qua PostgREST vừa abort migration**. Danh sách hàm hở hiện **rỗng (xanh)** — phải giữ vậy.
  New special UI phải gọi `uploadFinanceEvidence` (`create_finance_evidence_upload_intent_v2` → storage
  upload server-issued path → `finalize_finance_evidence_v2`); money RPC chỉ nhận evidence ids, không raw
  URL. Context verify same org/uploader provenance/object metadata/**fingerprint theo lựa chọn ở Step 2b**;
  owner duyệt proposal có thể attach evidence của manager chỉ khi proposal đã snapshot exact evidence ids.
  Trước posting phải có qualifying `ORIGINAL` hoặc `INHERITED_BATCH` link; empty trả `EVIDENCE_REQUIRED`.
- [ ] **Step 3d: [DELETE] Bỏ hoàn toàn việc "sửa contract read của `thu_tien.view`".** Tiền đề của bản
  29/07 **sai**: catalog live khai `thu_tien.view` với **`required_dimensions = []`** (rỗng),
  **`requires_cashbook_possession = false`**, `scope_match_mode = ANY_MATCH`, và **CASHBOOK chỉ là MỘT
  trong bốn `scope_kinds` được chấp nhận** (`ORGANIZATION, AREA, BUILDING, CASHBOOK`) — `thu_tien.collect`
  **giống hệt**. So sánh: `cashbooks.post` mới thật sự mang `required_dimensions=[CASHBOOK]` +
  `requires_cashbook_possession=true`. Hơn nữa `required_dimensions` trong catalog này **chỉ nhận
  `'BUILDING'` hoặc `'CASHBOOK'`** trên cả 9 key non-empty (tổng 223 key) ⇒ chỉ thị *"đổi thành
  organization/area/building"* **không biểu diễn được**. Thi hành đúng chữ nghĩa là **thu hồi tới 24 cạnh
  ALLOW CASHBOOK-scoped đang sống** (`authorize_tenant_action_v3:147/:164`, `authorized_scope_v3:151`) —
  đúng, hôm nay **không ai mất quyền** (`cashbook_only=0`, `cashbook_and_other=2` trong tổng 73 binding,
  `scoped_no_cashbook=67`, `unscoped_org_wide=4`), nhưng đó là **một cuộc THU HỒI cần chủ duyệt riêng**,
  không phải "sửa contract". **Thay bằng:**
  - **Một assertion no-op** ghi lại hình dạng live của cả bốn key `thu_tien.*` (view/collect/undo/report có
    **scope array và phân bố grant byte-identical** — điều này cũng **giết** giả định *"view khai sai,
    collect khai đúng"* của bản 29/07).
  - **[ADD] Lệch scope THẬT, quan trọng hơn nhiều:** **không một trong 13 body legacy nào tham chiếu
    `thu_tien`**; authz thật đi qua `can_access_building` (**`buildings.view`**) và `ie_all_buildings_scope`
    (`income_expenses.all_buildings`) — và **`buildings.view` có `scope_kinds = [ORGANIZATION, AREA,
    BUILDING]`, KHÔNG có CASHBOOK** ⇒ **một cạnh CASHBOOK-only thoả `thu_tien.view` nhưng vẫn fail
    `can_access_building`**. Vì vậy read RPC mới phải authorize `thu_tien.view` **TỪNG BUILDING** *và*
    preflight cảnh báo nếu có grant `thu_tien.view` mà thiếu `buildings.view`.
  - Route `App.tsx` **giữ nguyên**: `/thu-tien` gác `view` (`:363`), `/thanh-toan` gác `collect` (`:367`).
  - Giữ nguyên bộ test: user view-only đọc đúng building nhưng submit `42501`; user collect đúng scope
    submit được; user thiếu building scope không đọc được; **cộng** ca "collect rộng hơn view".
  - **[ADD] Nếu vẫn muốn siết catalog** thì đó là một đề xuất riêng: thêm `required_dimensions=['BUILDING']`
    cho `thu_tien.collect`/`thu_tien.undo` (đối xứng với `income_expenses.create/edit/approve/cancel`),
    kèm cảnh báo hệ quả ở `authorized_scope_v3` CTE `eff_c` dòng 241 (`not s.needs_building`) sẽ làm **trục
    sổ rỗng** ⇒ phải đo lại **275 ca ma trận quyền** trước khi apply.
  - **[ADD] Dựng fixture quyền trong DEMO TRƯỚC khi viết test ACL:** DEMO hiện **không có** user view-only,
    **không có** user chỉ `deposits.view`, **không có** user chỉ `contracts.view`; role *"Quản Lý Tòa"* ở
    DEMO **không hề có** `thu_tien.*` (chỉ `buildings/contracts/deposits.view`); `demo.chunha` và
    `demo.quanly` đều bound role chủ sở hữu (có tất); `demo.ketoan` là ca **NGƯỢC** (`thu_tien.collect` cấp
    ORGANIZATION + `thu_tien.view` SCOPED/BUILDING, **không** có `thu_tien.undo`). Fixture chỉ tạo trong
    `dddd0000-…0001` và **tự dọn**.
- [ ] **Step 4: [DELETE như đặc tả → REPLACE] "Sửa double mount" ⇒ HOIST STATE, KHÔNG unmount surface
  nào.** Ba lý do bản 29/07 sai:
  1. **Sai file.** Double mount nằm ở `src/pages/ThanhToan.tsx:53-70`, không phải `ThuTien.tsx`.
  2. **Hai bề mặt cùng hiện là CHỦ Ý và CÓ SPEC BẢO VỆ.** `src/pages/thu-tien.css:439-444` hiện grid 2 cột
     ở `≥1024px`; `<1024px` chỉ **ẩn bằng CSS** — `.e2e-fleet/specs/thanh-toan-page.spec.ts:143` dùng
     `toBeHidden()` (**không** `toHaveCount(0)`) ⇒ **cả hai component React luôn mounted ở mọi breakpoint**.
     `thanh-toan-page.spec.ts:27` và `:32` **assert cả hai đều visible** ở desktop. Unmount theo breakpoint
     sẽ làm `:32` **đỏ** và phá **hoặc** `utility-paste-receipt.spec.ts:46-49` (desktop paste) **hoặc**
     `:151-160` (phone-frame paste), tuỳ bỏ bề mặt nào ⇒ **một thay đổi sản phẩm được ngụy trang thành sửa
     bug, và nó chặn đúng gate của slice**.
  3. **Paste arbitration KHÔNG hỏng.** Có tới **4** listener `'paste'` trên `/thanh-toan` (2 hook × 2
     surface) nhưng **không handler nào double-fire**: khi một dòng làm chủ target thì chỉ instance đó hành
     động (`useReceiptPasteTarget.ts:86-87`), khi không ai làm chủ thì hint phát **đúng một lần**
     (`:91-93`, được `utility-paste-receipt.spec.ts:173` assert bằng `toHaveCount(1)`). Submit handler cũng
     không thể double-fire từ một gesture (4 hook instance, DOM rời nhau). Cơ chế arbitration cấp module ở
     `:27-31`/`:86-93` **đã vá đúng bug 28/07** ⇒ **PHẢI BẢO TOÀN**; xé nó ra là **tái sinh** bug cũ
     (desktop paste bị sheet instance nuốt).

  **Khuyết tật THẬT: hai bề mặt cùng GHI ĐƯỢC vào một slot với state độc lập, cộng `p_force` cách một
  click.** `PeriodFeePanel.tsx:101` và `PeriodFeeSheet.tsx:98` gọi `usePeriodFeeState` **độc lập** ⇒
  `amounts`/`bookSel`/`attach` là hai `Record` riêng; hai instance `usePersistedState` **chia một key**
  `sessionStorage` `'flt:thu-tien:fee-cat'` (`PeriodFeePanel.tsx:71`, `PeriodFeeSheet.tsx:73`) mà **không
  sync chéo** (`usePersistedState.ts:26-33`) ⇒ hai bề mặt có thể đang hiện **hai category khác nhau**;
  `PeriodFeeSheet.tsx:96` mount `useUtilityPayState` **vô điều kiện** ⇒ query + paste listener EN vẫn sống
  khi đang chọn GRID. Server: chốt chống trùng của `pay_period_fee` chỉ chạy trong `IF NOT p_force`, **chỉ
  đếm phiếu APPROVED** (draft `UNAPPROVED` **không** cảnh báo gì), và nút xác nhận ghi thẳng chữ **"Đóng
  thêm"** (`PeriodFeeVoucherList.tsx:186-189` → `usePeriodFeeState.ts:310-315 confirmPayDup() → doPay(bId,
  true)` → `usePeriodFees.ts:214 force?: boolean` → `:227 p_force`). Đã hiện thực hoá: **22 ô / 45 phiếu**,
  13 ô thuộc 07/2026.

  **Đặc tả mới:**
  - (a) **Giữ cả hai surface mounted.** Thêm `.e2e-fleet/specs/thanh-toan-page.spec.ts` và
    `utility-paste-receipt.spec.ts` vào danh sách spec **phải giữ xanh** — đây là **gate, không phải tuỳ
    chọn**.
  - (b) **Hoist state:** gọi `usePeriodFeeState` và `useUtilityPayState` **đúng một lần** ở
    `ThanhToan.tsx` rồi truyền xuống (context hoặc props) ⇒ `amounts/bookSel/attach` và bộ chọn category là
    **một nguồn duy nhất**; **một** shared submit-state (in-flight key theo `base_slot_key`) để một slot
    không thể armed/submit hai lần từ hai bề mặt.
  - (c) **Dedupe ở cả hai tầng:** client khoá theo slot đang in-flight; server đếm **cả `UNAPPROVED`**
    trong chốt chống trùng.
  - (d) **`p_force` chỉ mở cho owner/superadmin**, và dialog phải hiện **danh sách phiếu đang có kèm số
    tiền** trước khi cho bấm; đường normal **không còn** `p_force` (chi tiết xoá ở Task 7 Step 5).
  - (e) **BẢO TOÀN `useReceiptPasteTarget.ts:27-31/:86-93`** — ghi rõ trong plan rằng "sửa double-fire" là
    sửa một lỗi **không tồn tại**.
  - **Kỳ vọng mới của hai spec, viết ra tường minh:** `thanh-toan-page.spec.ts` — thêm assertion "đổi
    category ở một bề mặt ⇒ bề mặt kia đổi theo" và "hai lần submit cùng slot từ hai bề mặt ⇒ đúng một
    phiếu"; **giữ nguyên** `:20/:27/:32` (cả hai visible ở desktop) và `:143` (`toBeHidden()` ở mobile).
    `utility-paste-receipt.spec.ts` — **giữ nguyên** `:46-49`, `:151-171` và `toHaveCount(1)` ở
    `:173`/`:183-184`; **chỉ** cập nhật comment `:36-38` nếu state đã hoist (mount order không đổi).
- [ ] **Step 5: [RETARGET + ADD] Realtime.** Bốn sửa đổi:
  - (a) **[DELETE] Bỏ yêu cầu "đọc `payload.new/old.organization_id` rồi invalidate key của đúng org".**
    Handler tại `src/hooks/useRealtimeDataSync.ts:312` **không nhận tham số payload nào**
    (`type RealtimeHandler = () => void`), và hợp đồng bỏ-payload là **quyết định an ninh có chủ ý** (xem
    `20260730230000_realtime_money_tables.sql`). `payload.old` là **bất khả** (cần `REPLICA IDENTITY FULL`
    — lật nó là mở rò rỉ tenant, và **không gate nào canh**); `payload.new` thì lấy được nhưng
    "invalidate key của đúng org" **không biểu diễn được** trên bộ key hiện tại mà không re-key mọi
    consumer. Thay bằng: thêm key mới bằng prefix toàn cục như các key hiện có; nếu cần giảm nhiễu thì dùng
    `predicate` trên `queryKey` như `flushBusinessPerformance` (`:270-274`).
  - (b) **[ADD] Migration publication** (§2.1) — `contract_terminations`, `contract_transfers`,
    `building_utility_accounts` **hiện KHÔNG trong publication**; bản 29/07 chỉ hedge *"nếu publication cho
    phép"* (đúng **một** lần nhắc publication trong cả ba plan doc). Thất bại này **im lặng gấp đôi** vì
    `:343` là `channel.subscribe()` **trần, không status callback** ⇒ `CHANNEL_ERROR` không có chỗ nào để
    hiện. Thêm `subscribe((status) => …)` log `CHANNEL_ERROR`.
  - (c) **[ADD] Thêm BỐN query key ĐANG TỒN TẠI mà đang thiếu**, không chỉ key mới:
    `['period-fee-status']`, `['period-commissions']`, `['period-maintenance']`, `['fee-accounts']` vào
    entry `income_expenses` của `SYNC_TABLES` (`:124-161` hôm nay **chỉ** có `['utility-payments']` `:131`
    và `['utility-accounts']` `:132`); `building_fee_accounts` và `building_utility_accounts` **vắng hẳn**
    khỏi `SYNC_TABLES`. Luật của chính file ở `:99-101` nói bất kỳ màn hình đọc các bảng này dưới first key
    khác **phải** được liệt kê, không thì serve dữ liệu cũ ⇒ hôm nay `/thanh-toan` **không bao giờ**
    live-refresh GRID/hoa hồng/bảo trì từ máy khác — **amplifier trực tiếp** của rủi ro phiếu trùng (hai
    máy cùng thấy "chưa đóng"). Thêm key mới: `special-fee-overview`, `special-fee-alerts`,
    `special-fee-exceptions`, `room-cash-lifecycle`, `termination-refund-queue`, `income-expense-history`.
    Cập nhật `docs/he-thong/realtime-sync.md:32-33` (còn ghi `accounts`/`payments` là *"Chưa có realtime"*
    dù `20260730230000_realtime_money_tables.sql` đã thêm cả hai; `useRealtimeDataSync.ts:102` trỏ
    implementer vào đúng file doc đó).
  - (d) **[ADD] `hubActive` singleton có thể giết realtime cả session, không lỗi.** `:293
    let hubActive = false` là module scope; `:301 if (!userId || hubActive) return;` ⇒ instance thứ hai
    return `undefined`, **không register cleanup**; `:345-351` cleanup của instance đầu đặt
    `hubActive = false` và `supabase.removeChannel(channel)` ⇒ **instance sống sót vĩnh viễn không
    subscribe**. Hôm nay chỉ mount một lần (`src/App.tsx:236 <RealtimeDataSync />`) nên invariant còn đúng,
    **nhưng refactor mount-topology do Step 4 gây ra là trigger hợp lý và không test nào phủ**. Thêm
    ref-count (hoặc `useSyncExternalStore`) + test hai consumer đồng thời.
  - (e) **[RETARGET] "Mở rộng test" thực chất là VIẾT LẠI BA assertion**, phải sửa đồng bộ:
    `useRealtimeDataSync.test.ts:252-267` (`toEqual([11 tên bảng đúng thứ tự])` — append theo đúng thứ tự
    `SYNC_TABLES`), `:437-446` (`toEqual([8 root])`) **cùng** `:456 toHaveBeenCalledTimes(8)`, và ma trận
    `it.each` `:117-143`/`:271-281` (thêm một entry cho mỗi bảng mới, `[]` nếu không có rule BP).
    **KHÔNG nới `toEqual` thành `toContain`** — chính chúng chứng minh không bảng nào đăng ký hai lần và
    không key nào bị bỏ sót. Giới hạn harness phải biết trước: `:7 type RealtimeHandler = () => void`,
    `:183-186 triggerTable` gọi **không tham số**, `:27-29 vi.mock("react", …)` chỉ cấp `useEffect` ⇒ hook
    nào cần `useRef`/`useCallback`/`useMemo` sẽ throw *"does not provide an export named"* (đây là lý do
    (a) bỏ test payload-bearing; nếu vẫn giữ, phải tính ngân sách restructure react-mock).
- [ ] **Step 6: Chạy gate.** Chạy `node scripts/test-special-page-runtime.mjs` cho: two-user org resolver,
  **actor 2-org phải resolve qua overload org-scoped (no-arg raise `42501`)**, signed deposit
  direction/reversal/virtual reconciliation, one `ORIGINAL` + two `INHERITED_BATCH` children, batch
  rollback, superadmin `thu_tien.collect`/restricted-Management/cashbook override end-to-end, và **preflight
  assert `ensure_income_expense_type_v1` 12-arg còn khớp** (không redefine). Snapshot manual posting
  digest/behavior; manual happy/error/idempotency/evidence và `source_kind='MANUAL'` stay baseline;
  source-aware core revoked khỏi public/authenticated.
  Chạy `npx vitest run scripts/__tests__/gen-supabase-types.test.ts
  src/lib/__tests__/financeV2AdaptersMigration.test.ts src/hooks/__tests__/useRealtimeDataSync.test.ts`,
  typecheck, `node scripts/check-stable-fn-locks.mjs`, `node scripts/check-permission-catalog.mjs`,
  `check-definer-acl` (**sau khi đã nới**), `check-approver-provenance`, `check-view-invoker`.
  **[ADD] Ba luật đọc gate:**
  1. **Positional của Vitest là FILTER** ⇒ file thiếu thì lệnh **vẫn exit 0**. Mỗi lệnh `npx vitest run
     <paths>` phải đi kèm một assertion tồn tại file (`node -e` check hoặc `ls` tường minh).
  2. **`npx vitest run` ĐANG ĐỎ SẴN ở HEAD**: 1 file / 2 test —
     `src/components/buildings/__tests__/BuildingFilterSelect.test.tsx:38` và `:45` (assertion đối số cũ:
     expect `{ enabled: false }`/`{ enabled: true }`, nhận thêm `"includeVirtual": false`). ⇒ Điều kiện pass
     là **"không có ĐỎ MỚI so với baseline đã ghi ở HEAD"**, không phải "toàn xanh" — nếu không, gate hoặc
     bất khả thi hoặc bị bỏ qua *"vì nó đỏ sẵn"*. (Chưa đo: hai test đó có đỏ trên `origin/main` `31425d3`
     hay không.)
  3. `node scripts/check-ts-baseline.mjs` đọc **`ts-baseline.json`** (30 fingerprint); `ts-baseline.txt` là
     file chết.
  **[DELETE]** Bỏ khỏi Step 6: `node scripts/check-technical-membership-isolation.mjs` (không tồn tại và
  không còn deliverable để gác), và bộ test *"technical membership không đổi `current_admin_org_v1`,
  no-arg actor resolution, list/count/notification; regular membership mới luôn thắng SERVICE"* — nhánh đó
  dead-on-current-data.

### Task 1: Pure domain contract và classifier

**Files:** `src/lib/specialFeeRules.ts`, hai test pure/property nêu ở §2.3.

- [ ] **Step 1: Khóa type union.** `SpecialFeeOutcome` gồm `VALID`, **`VALID_PENDING_APPROVAL` [ADD]**,
  `VALID_WITH_WARNING`, `EXCEPTION_REQUIRED`, `DUPLICATE`, `CONFLICT`, `CONFIG_REQUIRED`,
  `BROKER_NOT_ELIGIBLE`, `DEPOSIT_BASIS_UNTRUSTED`, `SAFETY_CAP_EXCEEDED`. `BROKER_NOT_ELIGIBLE` và
  `DEPOSIT_BASIS_UNTRUSTED` là hard non-proposable outcomes, khác `EXCEPTION_REQUIRED`.
  `VALID_PENDING_APPROVAL` nghĩa **hợp lệ theo rule nhưng amount ≥ `ie_auto_approve_config.threshold`** ⇒
  voucher `UNAPPROVED`, **giữ claim**, **không** posting, **không** assert POSTED (§0.2 mục 1).
  `SpecialFeeFailureCode` gồm `INVALID_INPUT`, `NOT_AUTHORIZED`, `RESTRICTED_PERMISSION`,
  `PROVENANCE_REQUIRED`, `ROUTE_NOT_WRITABLE`, **`ROUTE_NOT_CONFIGURED` [ADD]**, `ROUTE_STATE_UNKNOWN`,
  `FEATURE_FROZEN`, `IDEMPOTENCY_CONFLICT`, `LEGACY_SCOPE_UNKNOWN`, `EVIDENCE_REQUIRED`, `CASHBOOK_INVALID`,
  **[RETARGET] ba mã kỳ có nhãn thay cho một `CASHBOOK_PERIOD_LOCKED` duy nhất**: `CASHBOOK_CLOSED`,
  `HANDOVER_LOCKED`, **`PROFIT_LOCKED` [ADD — BLOCKER]** (bản 29/07 **không có mã nào** cho khoá tháng lợi
  nhuận, trong khi `a02_ie_profit_lock_ins/upd/del` trên `income_expenses` và `a02_ie_items_profit_lock`
  trên `income_expense_items` là **trigger thật** ném `[PROFIT_LOCKED]` `P0001`, **18 toà đã chốt 05/2026**,
  và miễn trừ **chỉ** cho `is_super_admin()`/`is_org_owner_v1()`), `CONCURRENT_MODIFICATION`,
  `POSTING_INVARIANT_FAILED`. Preview/submit là discriminated union giữa outcome và failure; SQLSTATE + code
  + typed details ổn định, hooks **không** so chuỗi lỗi tự do. Mọi hàm nhận `orgToday`/month rõ ràng.
- [ ] **Step 2: Viết test RED/GREEN cho amount/fixed.** Mọi amount phải hữu hạn và > 0; zero/negative/
  non-finite trả validation error. `amountNormalized === configuredNormalized` mới `VALID`; thấp hoặc cao
  hơn đều `EXCEPTION_REQUIRED`; version tháng sau không đổi kết quả snapshot tháng trước.
- [ ] **Step 3: Viết test utility.** Tính `ratio = supplier/billed` khi denominator > 0; denominator 0 trả
  `ratio:null`, `zeroDenominator:true`, warning; vượt ceiling hoặc ratio là warning vẫn submit được; second
  voucher cùng meter/type/month là `DUPLICATE`. **[ADD]** Thêm ca `VALID_PENDING_APPROVAL`: cùng input hợp
  lệ nhưng `amount >= threshold` ⇒ outcome đổi, `willPost=false`, claim vẫn giữ. Dùng đúng hai giá trị live
  làm fixture: org thật **600.000**, DEMO **5.000.000**.
- [ ] **Step 4: Viết test maintenance/cadence.** AC 5 tháng và washer 6 tháng dùng calendar rolling window;
  amount ≤ standard không warning; standard < amount ≤ ceiling warning; > ceiling/cadence sớm exception.
  **[ADD]** Ghi rõ vào test file rằng **chiều "phòng" chưa tồn tại trong runtime hiện tại**
  (`MaintenanceBatchLine` chỉ có `{buildingId, subtype, amount}`; `get_period_maintenance` không trả room)
  ⇒ classifier nhận `roomId` như tham số bắt buộc và **thiếu `roomId` là `LEGACY_SCOPE_UNKNOWN`, không phải
  fallback theo toà**. Fixture phải có ca "23 phiếu AC đã vi phạm sẵn" và ca "`room_id` NULL".
- [ ] **Step 5: Property tests.** fast-check chứng minh không có `Infinity/NaN`, fixed không có tolerance,
  và normalize `numeric(18,2)` là deterministic. **[ADD]** Thêm property: outcome là **tổng loại đóng** —
  không input nào cho hai outcome, và `VALID_PENDING_APPROVAL` chỉ xuất hiện khi
  `amount >= threshold && ruleValid`.
- [ ] **Step 6: Chạy `npx vitest run src/lib/__tests__/specialFeeRules.test.ts
  src/lib/__tests__/specialFeeRules.property.test.ts` (kèm assertion tồn tại file); commit riêng classifier.**

### Task 2: Schema rule/claim/proposal/alert bất biến

**Files:** `supabase/migrations/20260731020000_special_fee_schema.sql` và DB test script.

**[BLOCKED-BY Slice −1.6 + −1.4]** — Step 3 (partial unique BASE index) **không thể apply** trước khi 22 ô
× 45 phiếu và 3 phiếu `quan_ly` item NULL-date được chủ quyết.

- [ ] **Step 1: Tạo rule-version tables typed.**
  - `special_fee_fixed_rule_versions`: org, building, `fee_kind` trong bảy fixed kinds,
    `effective_from_month` ngày 1, `fixed_amount numeric(18,2)>0`, provider/account metadata,
    `state DRAFT/PUBLISHED/SUPERSEDED`. **[ADD]** Ghi vào comment migration: bảng này **rỗng ở CẢ HAI org**
    cho tới khi chủ publish; `building_fee_accounts` chỉ là **DRAFT import** (xem Step 1c).
  - `special_fee_utility_rule_versions`: org, building, `utility_type`, positive `absolute_ceiling`,
    positive `max_ratio`, effective month. DRAFT import có thể thiếu, nhưng publish bắt buộc đủ cả hai mốc.
  - `special_fee_maintenance_rule_versions`: org/building, `service_kind` AC/washer, standard, ceiling ≥
    standard, cadence bắt buộc 5/6.
  - `special_fee_commission_rule_versions`: org/building, tier JSON `{min_months,max_months,rate_percent}`,
    `rate_basis='RENT_PERCENT'`, **`fallback_policy` NOT NULL khi PUBLISHED [ADD — load-bearing]**; Sale cap
    có thể null ở DRAFT nhưng PUBLISHED bắt buộc positive, chỉ owner/superadmin cấu hình.
  - `special_fee_recurring_occurrences`: org, recurring parent voucher, due month/base slot, state
    `CREATED_CHILD|SATISFIED_EXTERNALLY|BLOCKED_CONFLICT`, child/claim ids và immutable occurrence
    fingerprint; unique `(organization_id, parent_voucher_id, due_month)`. **[ADD]** Ghi rõ vị ngữ "due"
    dùng cái nào: **77** parent theo `repeat_next_date >= org_today` hay **76** theo
    `add_cycle(voucher_date, repeat_cycle, 1) <= current_date`.
  - `special_fee_deposit_basis_reconciliations`: immutable owner/superadmin decision cho một org × contract
    × virtual opening-balance voucher, state `RECOGNIZED|REJECTED`, source/header/items fingerprint, reason,
    actor/time; không thay voucher và không biến virtual thành cash.
  - **[ADD] `special_fee_threshold_snapshots`** (hoặc cột trong batch/receipt): snapshot
    `ie_auto_approve_config.threshold` **đọc dưới cùng lock với claim**, để một phiếu
    `VALID_PENDING_APPROVAL` giải thích được về sau.
- [ ] **Step 1b: Khóa tenant composite.** Mọi rule/claim/batch/proposal/alert FK phải chứng minh
  `(organization_id, building_id)` cùng tenant bằng composite FK/guard; room, utility account và contract
  cũng phải resolve về cùng organization/building. Test org A + building/room/meter của org B trả
  `42501`/`23514` **trước** khi insert.
- [ ] **Step 1c: [ADD] CẤM seed `special_fee_fixed_rule_versions` từ `building_fee_accounts.default_amount`
  khi chưa bỏ vòng tự-học.** `pay_period_fee` **ghi đè** `default_amount = round(p_amount /
  GREATEST(v_months,1))` trên **MỌI** lần chi (`ON CONFLICT … DO UPDATE`) ⇒ cột đó là **ký ức lần đóng gần
  nhất**, không phải cấu hình (ví dụ sống: toà `1eae0e82…` `dien` = **9.507.910đ**). Chọn: **(a)** bỏ nhánh
  `ON CONFLICT DO UPDATE` đó trong **cùng migration** và coi `default_amount` là dữ liệu lịch sử đông cứng;
  hoặc **(b)** mark **mọi** dòng import là `CONFIG_REQUIRED` và buộc chủ nhập lại. Thêm xử lý
  `CONFIG_REQUIRED` cho đường "xoá số tiền dự kiến" — hôm nay **bất khả thi mà vẫn báo thành công**
  (`saveExpected` truyền `null`, `upsert_building_fee_account` `COALESCE` bỏ null, `onSuccess` toast
  *"Đã lưu số tiền dự kiến"*).
- [ ] **Step 2: Tạo owner mapping/time snapshot.** `special_fee_type_mappings` map
  `income_expense_type_id → special_fee_kind` theo organization, do owner publish; backfill **và read
  model** không dùng `fee_type_matches` tên chung. `special_fee_rule_audit` lưu before/after/fingerprint/
  actor/effective month. **[ADD] Bảng false-positive live phải thành fixture test âm** (nguồn: Slice −1.3):
  `quan_ly` khớp `'Lương quản lý'` (org thật **2 phiếu / 34.206.744đ**) + `'Ứng lương quản lý'`, DEMO
  `'Lương quản lý'` 3 phiếu / 1.100.000đ; `dien` khớp `'Mua tủ lạnh'` cat *Điện* (1 phiếu / 3.424.000đ) và
  `'thanh toán tiền điện lạnh '` cat *Bảo Trì Máy Lạnh* (**chính họ AIR_CONDITIONER của plan này**);
  `ve_sinh` khớp `'Vệ Sinh Phòng'` (620.000đ) + `'BTaskee'` (300.000đ); `rac` khớp `'Rửa thùng rác'`
  (60.000đ) + `'Bỏ rác'` (3 phiếu / 300.000đ). **5 phiếu `system_source='salary.staff'` đang được báo là
  `quan_ly` đã đóng.** Và: **DEMO KHÔNG có type `'Quản Lý'`** ⇒ `resolve_fixed_expense_type('quan_ly')`
  (order `is_default DESC, created_at, id LIMIT 1`, mọi dòng `is_default=false`) sẽ **ghi một khoản chi
  Quản Lý vào type tiền lương**. **KHÔNG sửa `fee_type_matches`** (IMMUTABLE, có `=X` cho PUBLIC, nhiều nơi
  dùng) — thay bằng mapping do chủ duyệt.
- [ ] **Step 3: Tạo claim ledger với một invariant cross-class.** `special_fee_claims` có org,
  `base_slot_key`, kind/scope, period/service date, `claim_class NORMAL|EXCEPTION|EXTERNAL|LEGACY|CONFLICT`,
  `occupancy_role BASE|SUPPLEMENTAL|MAINTENANCE_EVENT`, state `ACTIVE|RELEASED`, holder voucher/proposal,
  `base_claim_id`, immutable snapshots và replacement link. Với fixed/utility/commission/Sale, **một partial
  unique BASE index duy nhất** bao phủ active `NORMAL|EXCEPTION|EXTERNAL|LEGACY|CONFLICT`; vì vậy initial
  out-of-rule proposal (`EXCEPTION+BASE`) chiếm đúng slot và không thể race với normal voucher. Check
  constraints bắt `BASE.base_claim_id IS NULL`; `SUPPLEMENTAL` chỉ cho fixed/utility bằng action tường
  minh, bắt buộc `base_claim_id` đang active + posted và có separate unique active index trên base claim;
  broker/Sale **không bao giờ** có supplemental vì one-per-contract tuyệt đối. Khi initial proposal được
  duyệt, cùng claim BASE được chuyển holder từ proposal sang voucher **dưới lock**, không insert một claim
  NORMAL song song. Maintenance dùng `MAINTENANCE_EVENT`, **không** lifetime unique; partial unique proposal
  chỉ giữ một PENDING exception trên cùng maintenance scope, approved event rời pending predicate và trở
  thành cadence anchor. Reversal là `state='RELEASED'` + `released_reason='REVERSED'`, không invent state
  thứ ba.
  **[ADD] Điều kiện tạo index (không thương lượng):** báo cáo conflict phải **rỗng** trước khi
  `CREATE UNIQUE INDEX` chạy. Hôm nay có **22 ô (toà × kind × tháng) / 45 phiếu non-cancelled**, worst
  `n=3` (toà `175f4329-…` / `tien_nha` / 2026-05 = **108.400.000đ**), phân bố 05/2026 **4** · 06/2026 **5**
  · **07/2026 13** ⇒ **đang sinh thêm** ⇒ `CREATE UNIQUE INDEX` **fail ngay lúc tạo**. Cộng **3 phiếu
  `quan_ly` cùng toà `cb6592d8-…` có item NULL `start_date/end_date`** — một ô trùng ba **vô hình với cả
  reader (`get_period_fee_status:76`) lẫn guard (`pay_period_fee:74`)**, phải vá dữ liệu trước.
  **[ADD] Broker: KHÔNG tạo index mới** — `uq_ie_commission_per_contract` đã có; **CẤM DROP/REPLACE** (§1.3).
- [ ] **Step 4: Tạo batch/proposal và normalized evidence refs.** Batch lưu idempotency/fingerprint, actor,
  building, cashbook, map `ORIGINAL` link theo từng evidence, child ids, outcome/tổng. Proposal lưu
  `exception_mode INITIAL_OVERRIDE|SUPPLEMENTAL|MAINTENANCE_OVERRIDE`, base claim khi applicable, reason,
  expected/entered/comparison snapshot, TTL 7 ngày, state `PENDING|APPROVED|REJECTED|CANCELLED|EXPIRED`;
  proposal **không phải** voucher. Evidence không nằm ở raw JSON array:
  `special_fee_batch_evidence`/`special_fee_proposal_evidence` giữ ordinal, composite same-org FK tới
  finalized object, **immutable object fingerprint theo định nghĩa đã chọn ở Task 0 Step 2b** và nullable
  `original_link_id`; unique `(parent_id, evidence_id)` và guard cấm đổi sau submit, ngoại trừ writer token
  set-once original link sau child đầu. Initial proposal giữ BASE claim từ lúc PENDING; supplemental chỉ
  sinh sau posted base; maintenance pending uniqueness như Step 3. Hết TTL chuyển đúng `EXPIRED`, release
  reservation claim bằng transition audited và không dùng `CANCELLED` để che mất nguyên nhân.
  **[ADD] Bảng idempotency riêng của special-fee là BẮT BUỘC** (không dựa vào
  `server_feature_flag_operations`) — xem Task 5 Step 1.
- [ ] **Step 5: Tạo alert/conflict.** `special_fee_alerts` lưu toàn bộ numerator/denominator/ratio/ceiling/
  standard/voucher/actor/cashbook/evidence; `special_fee_alert_receipts` có RLS owner/superadmin.
  `special_fee_migration_conflicts` lưu reason, candidates, resolution audit. Không đưa snapshot vào
  `public.notifications`.
- [ ] **Step 6: ACL/guards.** `REVOKE ALL` private tables/functions khỏi PUBLIC/anon/authenticated/
  service_role; chỉ private SECURITY DEFINER gọi được. Trigger cấm sửa org/slot/snapshot/voucher sau claim
  active; state transition qua private function có token. **[RETARGET]** Chạy `check-definer-acl.mjs`
  **chỉ có ý nghĩa sau khi đã nới scope** (Task 0 §2.1): hiện nó hard-scope `n.nspname='public'` và **chỉ
  test role `anon`** ⇒ không thể chứng minh bốn revocation mà step này khẳng định (vùng mù: 30 hàm
  `app_private` DEFINER `authenticated` EXECUTE được, 19 với `anon`, 287 hàm `public` DEFINER trong dải
  authenticated-không-anon). Thêm `node scripts/check-stable-fn-locks.mjs` vào Step này (mọi hàm mới phải
  VOLATILE).
- [ ] **Step 6b: [RETARGET] Seed route fail-closed — viết INSERT cho đúng.** Bảng là
  **`app_private.server_feature_flags`** (không có bảng `public` cùng tên; 18 cột; **không có
  `organization_id`**; **không** có cột `flag_key`). Hiện có **28 dòng** và **không dòng nào**
  `feature_key='special_fee.payment.v1'` ⇒ migration **phải TỰ TẠO** dòng đó rồi mới assert — *"abort nếu
  thiếu"* sẽ **abort 100%**.
  ```sql
  INSERT INTO app_private.server_feature_flags
    (feature_key, domain, risk_class, mode, force_freeze, reason)
  VALUES ('special_fee.payment.v1', '<domain>', 'MONEY', 'OFF', false, '<reason>')
  ON CONFLICT (feature_key) DO NOTHING;
  ```
  **`domain text NOT NULL` KHÔNG có default ⇒ bắt buộc truyền.** `max_operation_count`,
  `max_single_amount_vnd`, `max_total_amount_vnd` là `NOT NULL DEFAULT 0` ⇒ **bỏ câu "cap metadata để
  NULL"**; chỉ `starts_at, ends_at, commit_sha, migration_sha256, maintenance_window_id,
  approval_reference, reason, updated_by` mới nullable. `risk_class` có CHECK `IN ('MONEY','NON_MONEY')`.
  CHECK `server_feature_flags_canary_limits_check` đòi `starts_at < ends_at` hữu hạn **và cả ba cap > 0**
  (chỉ áp khi CANARY). Enrollment ở Task 8 Step 2 (**seed cờ TRƯỚC, enroll SAU** — trigger
  `a10_accounting_canary_enrollment_guard` ném `55000 'Accounting feature is not configured'`).
  **[ADD]** Ghi phụ thuộc đã xác minh: `income_expense.posting.v2` đang `mode='ON'`, `force_freeze=false`,
  `config_version=3` (updated `2026-07-23T03:44:07Z`) ⇒ **hai cầu a85/a85b ĐANG hoạt động**, writer mới
  **không** được dựa vào việc bridge im lặng. **[ADD]** Trigger
  `a10_accounting_feature_activation_guard` chạy cho **MỌI** key (không whitelist) và fire cả trên INSERT;
  với `mode='OFF'` thì assert early-return nên seed vẫn qua, **nhưng** dòng seed **chiếm advisory lock**
  `'accounting-feature-rollout:<key>'` tới commit.
- [ ] **Step 7: Test transaction rollback và `node scripts/reconcile-money.mjs 2026-07`; KHÔNG tạo unique
  index trên legacy rows trước conflict report.** **[ADD]** Pass là **`exit 0`**; **`exit 3
  (INCONCLUSIVE)` KHÔNG phải pass** (script tự thoát 3 khi không kỳ nào >1000 phiếu) và nó cần
  `signInWithPassword` ⇒ **không headless-CI-safe** như `check-view-invoker.mjs`. Fallback: chọn kỳ >1000
  dòng, hoặc chạy `scripts/reconcile-money-v2.mjs`.

### Task 3: Rule admin, version selection và denominator

**Files:** `supabase/migrations/20260731021000_special_fee_rule_rpcs.sql`, `src/hooks/useIsOrgOwner.ts`,
`src/hooks/useSpecialFeeRules.ts`, `scripts/test-special-fee-rules.mjs`.

- [ ] **Step 1: [RETARGET] Implement owner guard bằng cách EXTEND, không tạo định nghĩa thứ hai.**
  `special_fee_is_owner_or_superadmin_v1(p_org, p_user) := public.is_super_admin() OR
  app_private.is_org_owner_v1(p_org, p_user)`. Cùng migration forward-harden `is_org_owner_v1`
  (`20260730190000:125-149`) hai điểm nó thiếu: (a) `JOIN organizations o ON o.id = p_org AND
  o.status='ACTIVE'`; (b) thay literal `r.name = 'Chủ sở hữu tổ chức'` bằng khoá bất biến
  (`organization_roles.is_system` + slug ổn định), giữ tương thích ngược. **KHÔNG** dùng
  `member_type='OWNER'` — §0.4. Nó **đã** kiểm cửa sổ hiệu lực của cả membership lẫn chính role_binding nên
  **không cần thêm** phần đó. Giữ nguyên `can_create_restricted_ie()` cho Quản lý (md5
  `90ad1994a07546d11c18c368ab2b3bb8`). **Test bắt buộc hai chiều:** người `member_type='STAFF'` nhưng bound
  role chủ sở hữu (`demo.quanly`) **PHẢI** là owner; người `member_type='OWNER'` nhưng **không** bound role
  chủ sở hữu **PHẢI KHÔNG** là owner. **[ADD]** Ghi vào runbook rằng đổi tên vai trò trong Cài đặt hôm nay
  **âm thầm tắt** cửa chủ ở `reverse_invoice_collection_v5`, flex-cancel, ANNOTATE và khoá lợi nhuận —
  đây là lý do (b) là bắt buộc, không phải trang trí. **[ADD]** Ghi rủi ro kèm theo: `is_super_admin()`
  **bỏ qua** `super_admins.organization_id` và còn GRANT cho `anon` (xem Task 0 Step 3b).
- [ ] **Step 2: Implement draft/publish/config.** `upsert_special_fee_rule_draft_v1` và setters
  timezone/safety chỉ cho owner/superadmin; `publish_special_fee_rule_v1` dùng lock org/building/kind, CAS,
  supersede version cùng effective month, từ chối backdate sau activation; **không** update published
  snapshot. `decide_virtual_deposit_basis_v1(contract, voucher, decision, reason)` chỉ owner/superadmin,
  verify same tenant/contract + allowlisted opening-balance source/fingerprint rồi insert immutable
  reconciliation; không sửa posting/cash semantics. Trước route ON, owner được publish đúng một
  `INITIAL_BASELINE` có effective month phủ kỳ/contract legacy còn mở; baseline mang audit flag và không
  sửa voucher/claim cũ. Mỗi publish/config/reconciliation change ghi audit.
  **[ADD] Cửa sổ nhập liệu của chủ là một hạng mục công việc, không phải chú thích** — số đo 30/07:
  **0/21 toà** khai đủ cả 7 kind; org thật thiếu **~35/126 ô (28%)** sau khi trừ 12 ô `thang_may` ở toà
  `has_elevator=false`; **kind `quan_ly` có 0 dòng trên CẢ HAI org (18 + 3 = 21 ô)** — lỗ lớn nhất;
  **0/109** dòng `building_fee_accounts` có `default_account_id` (chỉ là prefill UI — 21/21 sổ org thật và
  5/6 sổ DEMO có binding CUSTODIAN sống nên actor vẫn chọn sổ lúc submit); `not_applicable` **0/109 chưa
  bao giờ dùng**; `buildings.hidden_fixed_expenses` **có** dùng (4/21 toà, 6 ô) nhưng chỉ giải thích **3**
  trong ~35 ô thiếu ⇒ phần còn lại là nợ cấu hình thật.
- [ ] **Step 3: Implement selector.** Fixed/utility chọn version theo billing month; maintenance theo
  service date month; commission theo signed month (hợp đồng thiếu signed date là legacy warning, **không**
  tự fallback im lặng). Rule change không sửa claim/voucher cũ.
- [ ] **Step 4: Implement utility numerator/denominator theo building.** Invoice items không link được
  supplier `utility_account_id`, nên ratio **không** giả vờ là per-meter. Denominator là tổng utility invoice
  items phân loại được của **organization × building × utility type × month** từ invoice
  `APPROVED|PAID|PARTIAL_PAID|OVERDUE`, `deleted_at IS NULL`; khách đã thanh toán hay chưa không ảnh hưởng.
  Submit/exception approval lấy aggregate advisory lock **trước** meter slots rồi recompute
  `aggregateAfter = priorPosted + concurrentReserved + currentMeterAmount`: mỗi claim/voucher đếm một lần,
  idempotent replay tự loại, cancelled/reversed/released và pending exception chưa duyệt không tính.
  Absolute ceiling/max ratio áp trên aggregate; uniqueness vẫn per meter. Snapshot `currentMeterAmount`,
  `priorPostedAggregate`, `reservedAggregate`, `aggregateAfter`, billed total, all meter/voucher/invoice/item
  ids và unmatched items bị loại.
  **[ADD] Mẫu số theo toà đang bị phá bởi dữ liệu thật:** ô `(toà d76268b2-…, ELECTRIC, 2026-07)` gồm **2
  phiếu trên HAI METER KHÁC NHAU** — hợp lệ dưới unique index theo meter nhưng **phá khoá tổng hợp theo toà
  và phá mẫu số của tỉ lệ supplier/tenant**. Phải có fixture cho đúng hình dạng này.
  **[ADD] `building_fee_accounts` còn mang hai category NGOÀI 7 fixed kind**: `dien` (17 dòng) và `nuoc`
  (12 dòng) trong tổng 109 — selector không được nhầm chúng thành fixed rule.
- [ ] **Step 5: [RETARGET] Validate commission tiers — `fallback_policy` là LOAD-BEARING.** Reject
  overlap/negative rate; **gaps chỉ được publish khi `fallback_policy` đã ghi**; import
  `buildings.commission_tiers` thành DRAFT. Không tạo cap Sale từ lịch sử.
  **Sự thật phải viết vào plan (bản 29/07 chỉ ghi "có gap"):** **21/21** toà đã khai và **21/21 đều hở**,
  cùng một hình dạng chỉ phủ **5–6** và **10–12** tháng (18 toà `[{5,6,50},{10,12,60}]`; 102LVT rate 70;
  44TL rate 80; 1392QT `max_months=13`) ⇒ hở `<5`, `7–9`, `>12` **ở mọi toà**. **Một fallback ngầm ĐÃ tồn
  tại** trong `get_period_commissions` (LATERAL `COALESCE(match trong khoảng, rate của bậc cao nhất có
  max_months < months)`) và nó **XUNG ĐỘT** với `useCommissionVoucher.ts:32-49`/`:46-48` (chỉ fallback khi
  `months > topTier.max_months` ⇒ trả `null → 0đ`). ⇒ Với `months = 7..9`: **server nói 50% × rent, client
  nói 0đ**, và **22 HĐ** đang ở dải đó (12 HĐ ký từ 01/2026). Vì vậy **import DRAFT không `fallback_policy`
  sẽ ÂM THẦM ĐỔI SỐ ĐANG HIỂN THỊ HÔM NAY** cho 22 HĐ đó từ `50% × rent` xuống `0`, và luật *"amount khác
  expected ⇒ EXCEPTION_REQUIRED"* sẽ **phân loại lại cả cohort mà không có migration note**. Bắt buộc thêm:
  (a) một **parity test giữa SQL và TS helper**; (b) một **report danh sách HĐ bị ảnh hưởng** trước khi
  publish bất kỳ tier version; (c) **owner sign-off** cho chính sách vùng hở. Quy mô: **152 HĐ** rơi đúng
  bậc (5mo 25, 6mo 6, 10mo 10, 11mo 56, 12mo 55); **48 HĐ ở 13–17 tháng** (13mo 18, 14mo 18, 17mo 12) cộng
  8mo 9 / 9mo 7 ⇒ **70 HĐ** không áp được mức nào nếu thiếu `fallback_policy`.
- [ ] **Step 6: Test manager đọc nhưng không publish, owner publish, superadmin cross-org, retroactive
  reject, snapshot immutability; test `can_create_restricted_ie()` vẫn cho/ẩn hạng mục Quản lý đúng
  baseline; chạy typecheck.** **[DELETE]** phần *"kể cả actor chưa có membership trước khi provision"* —
  nhánh đó dead-on-current-data (Task 0 Step 3). **[ADD]** Test phải dùng **fixture DEMO tự dựng** vì DEMO
  không có user view-only / chỉ-`deposits.view` / chỉ-`contracts.view`, và phải phủ ca **NGƯỢC** của
  `demo.ketoan` (collect ORGANIZATION > view SCOPED-BUILDING).

### Task 4: Preview và claim semantics không lách uniqueness

**Files:** `supabase/migrations/20260731022000_special_fee_preview.sql`,
`scripts/test-special-fee-rules.mjs`, `src/hooks/useSpecialFeePayments.ts`.

- [ ] **Step 1: Khóa base slot keys.** Fixed `FIXED:{building}:{kind}:{YYYY-MM}`; utility
  `UTILITY:{utility_account}:{type}:{YYYY-MM}`; broker/sale `COMMISSION:{contract}:{kind}`; AC
  `MAINTENANCE:{room}:AIR_CONDITIONER`; washer `MAINTENANCE:{building}:WASHING_MACHINE`. Maintenance key
  **không** tự thêm tháng để lách cadence. Utility còn có aggregate domain lock
  `UTILITY_AGG:{building}:{type}:{YYYY-MM}`, luôn lấy **trước** các meter slot đã sort.
  **[ADD — phải quyết trước khi viết index/backfill] `{YYYY-MM}` của utility là tháng NÀO?** Đo lại 30/07
  trên đúng 67 phiếu `utility.bill` non-cancelled cho **hai kết quả khác nhau 2×**:
  - khoá theo **kỳ dịch vụ** (`date_trunc('month', min(item.start_date))`) ⇒ **2 ô meter** trùng (meter
    `fea1d2f4-ef50-4017-8a8d-972df2003189` ELECTRIC 2026-05 = 2 phiếu / 14.371.816đ và 2026-06 = 2 phiếu /
    14.421.668đ) và **3 ô toà** (toà `d76268b2-…` ELECTRIC 05/06/07);
  - khoá theo **`voucher_date`** ⇒ **4 ô meter / 5 ô toà** (thêm meter `246ef582-…` WATER 2026-07 và
    `89775d46-…` ELECTRIC 2026-07).

  Con số *"4 phiếu / 7.308.077đ trên meter `02660728-6325-4f45-b9d4-dc96352d10fb`"* của một auditor **KHÔNG
  tái lập**: meter đó có **đúng 1 phiếu mỗi tháng** (05 = 7.929.684đ, 06 = 8.441.194đ, 07 = **7.305.077đ**)
  ⇒ 7.308.077 gần như chắc chắn là lỗi chép của 7.305.077. ⇒ **Chốt khoá, rồi mới viết unique index và
  conflict backfill.** Ghi lựa chọn vào plan kèm số ô phải dọn (2 hay 4).
- [ ] **Step 2: Implement preview read-only + authz — KHAI VOLATILE.** SECURITY DEFINER preview derive
  target org/buildings, reject mixed/cross-org, require `thu_tien.view` **từng building** **cộng** hai key
  legacy (`buildings.view` qua `can_access_building`, `income_expenses.all_buildings` qua
  `ie_all_buildings_scope` — **bổ sung LÊN TRÊN, không thay thế**; test cả bốn tổ hợp). `canSubmit=true`
  còn cần `thu_tien.collect` trên selected building/cashbook **và** một lời gọi **riêng**
  `assert_cashbook_access_v2(...,'CUSTODIAN',...)` (invariant ở Task 0 Step 3b). Bound tối đa 50 targets và
  24 months. Ngay sau resolve kind, `MANAGEMENT` gọi `can_create_restricted_ie()`; thiếu quyền trả typed
  `RESTRICTED_PERMISSION`, **không** exception. Response có outcome/failure, rule/comparison snapshot,
  existing claim/proposal/voucher. Submit luôn authz/recompute; preview **không** reserve.
  **[ADD — BLOCKER] Hàm này (và mọi read RPC khác của plan) PHẢI khai VOLATILE**: nó gọi
  `authorize_tenant_action_v3`, hàm có `SELECT … FOR SHARE`; khai `STABLE`/`IMMUTABLE` ⇒ `25006` qua
  PostgREST **và** `DO $guard$` của `20260730280000:57-89` abort migration. Thêm
  `node scripts/check-stable-fn-locks.mjs` vào gate của task này.
- [ ] **Step 3: Implement broker eligibility và expected amount.** Yêu cầu read-only residence resolver
  `20260731011000_room_residence_segments.sql` đã applied. Contract phải `ACTIVE`, không có active broker
  claim; building rule resolve theo source/residence snapshot tại signed/start date. Gọi **duy nhất**
  `resolve_signed_contract_deposit_basis_v1`, lưu ordered voucher ids, direction/source/posting/cash flags
  và basis fingerprint; `contract_deposit_links` chỉ metadata (**5 dòng toàn DB**). Contract status không
  hợp lệ, net held < 100% `total_deposit`, hoặc `org_today < start_date + 7` trả `BROKER_NOT_ELIGIBLE` với
  `canSubmit=false, canRequestException=false`. Basis mơ hồ/untrusted, tier/building/residence không resolve
  trả `DEPOSIT_BASIS_UNTRUSTED` hoặc `CONFLICT`, cũng không được proposal/direct override. Chỉ khi các điều
  kiện eligibility đã đạt, expected amount = `round(rent_price × rate_percent / 100, 2)`; exact là normal,
  amount khác mới là `EXCEPTION_REQUIRED`. Snapshot contract months, tier/version, rent, rate, rounding và
  deposit-basis fingerprint. **[ADD]** Nếu months rơi vào vùng hở thì expected amount **phải** đến từ
  `fallback_policy` đã publish; **không** được suy ngầm (nếu không sẽ tái tạo đúng xung đột 50% vs 0đ ở
  Task 3 Step 5).
- [ ] **Step 4: Implement maintenance rolling check.** Dưới `pg_advisory_xact_lock(hash(org, scope,
  service_kind))`, đọc `max(service_date)` từ normal/external và **exception đã owner approve + active
  posted** claims/vouchers AC/washer; pending proposal, cancelled/reversed/released không tính. Như vậy một
  lần owner cho vệ sinh sớm vẫn trở thành mốc cadence mới **sau khi thực chi**. Legacy service name khác
  trả `LEGACY_SCOPE_UNKNOWN`, không tính như AC. Cadence violation trả `EXCEPTION_REQUIRED` và
  `canRequestException=true`.
  **[ADD] Baseline phải đúng: 200 phiếu / 31 tên type / 5 category / 80.289.556đ** cho cả họ
  `nrm_vn(category) LIKE 'bao tri%'` *(plan 29/07 ghi 101/11 — số đo lại 30/07 là 200/31; 101/11/42.333.000đ
  chỉ là category "Bảo Trì Máy Lạnh")*. `special_fee_type_mappings` + `LEGACY_SCOPE_UNKNOWN` **hấp thụ được
  200 dòng như 101** nên thiết kế **không sai** — chỉ sai baseline và effort. Ghi rõ **ngoài phạm vi theo
  thiết kế**: Bảo Trì Tòa Nhà (85), Tủ Lạnh (6), máy bơm (1). **77 phiếu bảo trì org thật không có
  `room_id`** ⇒ không neo được luật theo phòng; **23/86** phiếu AC non-cancelled **đã vi phạm sẵn** luật 5
  tháng và **4** có `room_id` NULL. Máy giặt chỉ **7 phiếu / 2 tên / 0 ca trùng** ⇒ luật rolling-6-tháng
  **hoàn toàn chưa được dữ liệu thật kiểm chứng**, mọi ca test phải tự dựng ⇒ **hạ ưu tiên** so với AC
  (bản 29/07 đặt hai họ ngang nhau).
  **[BLOCKED-BY Slice −1.2]** Chiều "phòng" và bộ đếm chưa có chỗ neo trong runtime hiện tại.
- [ ] **Step 5: Implement duplicate/exception semantics với tên RPC cố định.** Normal slot thứ hai trả
  `DUPLICATE` và link voucher/proposal hiện hữu; normal submit **không** tự chuyển duplicate thành proposal
  và **không** sinh ordinal. `request_special_fee_exception_v1` chỉ tạo initial proposal cho một slot chưa
  có BASE nhưng đang `EXCEPTION_REQUIRED`; nó reserve `EXCEPTION+BASE`.
  `request_supplemental_special_fee_exception_v1` là action riêng cho fixed/utility đã có BASE posted, bắt
  buộc `base_claim_id`, reason và reserve `EXCEPTION+SUPPLEMENTAL`; không áp dụng broker/Sale/maintenance.
  Maintenance cadence/ceiling dùng `request_special_fee_exception_v1` nhưng reserve pending maintenance
  predicate, không BASE monthly. Cả hai **chỉ** tạo proposal; `decide_special_fee_exception_v1` mới cho
  owner/superadmin quyết định.
  **[ADD]** Chốt chống trùng phải đếm **cả `UNAPPROVED`** — hôm nay `pay_period_fee` chỉ đếm `APPROVED` nên
  một draft đang tồn tại **không cảnh báo gì**; và phải nhìn thấy cả item **NULL-dated** (3 phiếu `quan_ly`
  toà `cb6592d8-…` hiện vô hình với cả reader `:76` và guard `:74`).
- [ ] **Step 6: Implement multi-month preview.** Chỉ bốn fixed kinds (`cong_an`, `internet`, `rac`,
  `thang_may` — `feeCategories.ts:40-106`, `feeCategories.test.ts:6-16`) được gửi `children[]`; sort theo
  month, resolve rule/claim riêng. Writer tạo đúng một voucher/claim mỗi tháng, `repeat_cycle='NONE'`, cùng
  batch id; reserve/post all-or-nothing. Outcome precedence của cả batch: auth/failure →
  `CONFIG_REQUIRED` → `DUPLICATE` → `CONFLICT` → `EXCEPTION_REQUIRED` → **`VALID_PENDING_APPROVAL`** →
  warning/valid. Duplicate/conflict hard-block và không tự mở proposal; config thiếu chỉ trả
  `CONFIG_REQUIRED`; chỉ batch structurally resolvable nhưng lệch rule mới cho **một** initial exception
  proposal chứa snapshot/evidence và một BASE reservation cho từng child. Khi duyệt, transaction revalidate
  toàn batch, rebind từng reserved claim sang đúng child voucher, child đầu dùng evidence `ORIGINAL`, các
  child sau `INHERITED_BATCH`; lỗi một child rollback tất cả. Không trường hợp nào tạo child một phần.
  **[ADD — phải quyết, nếu không lời hứa của plan bất khả thi] Trả trước có thể tự khoá vĩnh viễn chỗ của
  mình.** `20260730240000_authz_remaining.sql:429-457` (untracked, chưa apply) thêm nhánh thứ năm *"KỲ DỊCH
  VỤ CỦA HẠNG MỤC"* vào `assert_period_open_for_edit_v1`: join `profit_monthly` trên dải
  `[date_trunc('month', LEAST(start_date,end_date)), date_trunc('month', GREATEST(...))]` với
  `locked_at IS NOT NULL` và `period_month <> tháng voucher_date` ⇒ `RAISE '[PROFIT_LOCKED] Phiếu có hạng
  mục thuộc kỳ %'`. Đó **đúng hình dạng** của child trả trước (item giữ tháng đã trả, `voucher_date` = hôm
  nay) ⇒ child cho tháng đã chốt lợi nhuận **không sửa/huỷ được vĩnh viễn**, và **chỗ của tháng đó bị chiếm
  mãi** — trái ngược chính điều Plan 1 hứa. **18 toà đã chốt 05/2026.** Chọn **một** và ghi vào plan:
  **(a)** child trả trước đặt `business_result_accounting=false` (và biết rằng trigger vẫn chặn nếu
  `system_source IS NULL`, nên `system_source` phải set trong **cùng câu INSERT**); **(b)** không set item
  period cho tháng quá khứ; hoặc **(c)** đường release claim đi riêng, không qua vị ngữ đó. Ghi thêm: vị
  ngữ **ĐỌC** và trigger **GHI** hiện **lệch nhau** về phiếu ngoài KQKD (trigger chặn,
  `assert_period_open_for_edit_v1` miễn trừ) — đúng mẫu lỗi *"hàm đọc kiểm ít điều kiện hơn hàm ghi"*.

### Task 5: Shared context và writer auto-approve/post

**Files:** `supabase/migrations/20260731010000_special_page_runtime.sql`,
`supabase/migrations/20260731023000_special_fee_writer.sql`, `scripts/test-special-fee-writer.mjs`.

- [ ] **Step 1: [REORDER] Khóa authz + global transaction order — idempotency LOOKUP đứng TRƯỚC.** Normal
  submit require consumer capability `thu_tien.collect` cho exact organization/building trước mutation
  (**cộng** hai key legacy, và một lời gọi custody **riêng**); chọn cashbook **không** thay thế permission.
  Exception decision còn require owner/superadmin. Order:
  **(0) [ADD] LOOKUP bản ghi idempotency của chính special-fee** — nếu hit thì **trả voucher đang có và
  KHÔNG gọi `claim_feature_operation_v1`**; (1) org decision (`app_private.lock_org_for_decision_v1` —
  caller contract *"đã gọi ở một statement TRƯỚC trong cùng transaction"* được ghi ở
  `authorize_tenant_action_v3:11-13`); (2) evaluate route **đúng một lần** + CANARY cap bucket; (3) sorted
  domain locks (aggregate `UTILITY_AGG` trước meter slots); (4) claims/obligations; (5) voucher/items;
  (6) cashbooks; (7) evidence; (8) posting/reversal; (9) audit/final. Shared context **không** lock
  cashbook/evidence sớm.
  **[ADD — lý do bước (0) là bắt buộc, HIGH]** `claim_feature_operation_v1` build
  `operation_key = md5(concat_ws('|', feature_key, org, subject_scope, actor, idempotency_key))` rồi INSERT
  **trơn (không `ON CONFLICT`)** vào bảng có `UNIQUE (feature_key, config_version, operation_key)` ⇒ một
  replay **đúng-hệt-identity** ném **`23505` TỪ BÊN TRONG claim**, không phải *"trả voucher gốc"*. Và vì
  `config_version` nằm trong khoá unique, **bump version giữa hai lần replay xoá sạch bảo vệ** ⇒ **tuyệt đối
  không** dùng `server_feature_flag_operations` làm idempotency. Thêm: nếu writer mới dùng chung bảng ops để
  đếm thì **thêm vị ngữ `organization_id`** (bộ đếm hiện **không lọc org, không lọc ngày**; tiền lệ version
  dùng chung: `income_expense.create_draft.v1` v5 = 14 op DEMO + 2 op org thật).
  Viết two-session tests submit-vs-cancel/recurring/exception và refund birth/submit/reversal.
- [ ] **Step 2: [ADD — BLOCKER] Cấp transition token ĐÚNG `purpose`, và đăng ký adapter ĐÚNG `adapter_name`.**
  - **Token:** *"Token PHẢI mang `purpose = 'FINANCE_V2_LIFECYCLE'` và phải TỒN TẠI LIÊN TỤC từ trước lệnh
    `UPDATE approval_status` cho tới sau khi core source-aware post xong."* **TUYỆT ĐỐI KHÔNG** dùng
    `app_private.finance_v2_transition_owned_approval` hay
    `app_private.finance_v2_stamp_owned_posting_state` để chuyển trạng thái phiếu special — hai helper này
    **ghi đè `purpose`** sang `'APPROVED'`/`'finance_v2.owned_posting_stamp'` (làm cầu a85 **KHÔNG skip**)
    rồi **DELETE token ở cuối**. Cách đúng: gọi `app_private.finance_v2_begin_canonical_op(...)` với
    `p_subject_id` (nó upsert đúng `purpose='FINANCE_V2_LIFECYCLE'`), **hoặc** upsert tay đúng purpose đó,
    **hoặc** theo tiền lệ `20260730120000_ie_annotate_v1.sql:113-116` và mang năng lực trong
    `app_private.ie_flex_writer_xids` (`begin_ie_flex_write_v1`/`end_ie_flex_write_v1`; scope `'FLEX_EDIT'`
    đã đặt chỗ trong CHECK nhưng **chưa** hiện thực trong body guard — đó là móc treo, và nếu chọn đường này
    thì phải forward-redefine guard, giữ nguyên nhánh ANNOTATE và nhánh *"unmarked legacy row: unchanged
    behavior"*). **Cơ chế thất bại nếu làm sai:** `approval_status` lật `APPROVED` khi cầu **còn vũ trang**;
    vì Step 3 bắt `account_id` set, `total_amount > 0`, sổ thật không-virtual ⇒ `v_should = true` ⇒ `a85`
    tự mint posting `source_kind='LEGACY_BRIDGE'` + stamp `posting_status='POSTED'` +
    `active_posting_id_v2` **TRƯỚC** khi core adapter chạy ⇒ **posting tiền TRÙNG**. Cầu **đang sống**
    (`income_expense.posting.v2` = `CANONICAL` trên prod). Ghi rõ: `ie_transition_authorization` **PK trên
    `income_expense_id` một mình** ⇒ **không thể** giữ hai `purpose` song song cho cùng phiếu (213 dòng token
    rác, 213/213 `xid` đã chết, **không job dọn**).
  - **Adapter:** seed `finance_flow_owner_adapters` cho `flow_owner='SPECIAL_PAGE_FEE'` với dedicated
    create/post/cancel/reverse decision whitelist; thêm public wrappers có tên ổn định
    `cancel_special_fee_payment_v1` và `reverse_special_fee_payment_v1`.
    **[ADD] `app_private.dispatch_finance_decision_v2` route theo `adapter_name`, KHÔNG theo `flow_owner`**,
    qua `CASE` **năm nhánh đóng** `{INVOICE_REFUND, PROFIT_PAYOUT, TERMINATION_FORFEIT_PAIR,
    TERMINATION_MOVE_OUT_PAIR, SALARY_BUNDLE}`, `ELSE → 0A000 'adapter % not wired for decision routing'` ⇒
    **plan phải nói rõ** `SPECIAL_PAGE_FEE` **reuse** một `adapter_name` đã nối **hay** thêm một nhánh
    `CASE` (thêm `dispatch_finance_decision_v2` vào danh sách hàm forward-redefine ở §2.2 mục 4). Lỗi này
    **đã hiện thực hoá trên prod** cho `flow_owner='UTILITY_RECURRING'` (`adapter_name=
    'CANONICAL_INCOME_EXPENSE'` → `ELSE` → `0A000`). **Test hồi quy phải chạy CẢ HAI đường**: `42501`
    (unknown owner, bước tra registry) **và `0A000`** (adapter chưa nối) — test *"unknown owner fail-closed"*
    một mình sẽ **PASS và che mất** lỗi này. Gate: gọi thật **mỗi decision** trong `supported_decisions` của
    owner mới và assert **không** nhận `0A000`.
  - Trước ownership: set `account_id` và `voucher_date` **TRƯỚC** (chúng **ngoài** allowlist của
    `guard_income_expense_owned_payload:59-79`, nên sau khi owned thì **không** đi qua được **dù có token**),
    rồi register `income_expense_flow_ownership` với `flow_kind/lifecycle_owner='SPECIAL_PAGE_FEE'` và
    payload fingerprint. Token bị xóa/consume trong cùng transaction, **sau** khi core post xong.
  - **[ADD]** Frontend/generic status handler lookup ownership trước global route; ordinary voucher vẫn đi
    RPC cũ. **Mọi adapter mới phải GIỮ NGUYÊN substring `owned by system flow`** (do
    `assert_income_expense_flow_owner_v2:20` phát) vì lối tôn trọng ownership duy nhất đang tồn tại là regex
    `financeV2Mutations.ts:46-48` dùng ở `:60`, lặp ở `statusMutations.ts:315`/`:352` — đổi chuỗi là dispatch
    **chết im** sau toast *"Duyệt phiếu thất bại"*. **[ADD]** Wrapper cancel/reverse **KHÔNG** được tái dùng
    `public.decide_owned_income_expense_v2`.
- [ ] **Step 2b: Assert route còn OFF khi deploy writer.** `20260731023000_special_fee_writer.sql` **không**
  được auto-enable. **[RETARGET]** Assertion hai phần thay cho *"evaluate = LEGACY"*:
  (1) `EXISTS (SELECT 1 FROM app_private.server_feature_flags WHERE feature_key='special_fee.payment.v1')`
  — `RAISE` nếu thiếu; (2) `mode='OFF' AND force_freeze=false`. Chỉ **sau** đó mới dùng `evaluate()` làm
  smoke test. Post-apply smoke test chứng minh: OFF evaluate `LEGACY`; SHADOW chỉ classify; direct special
  submit ở OFF/SHADOW trả typed `ROUTE_NOT_WRITABLE` **không mutation**; `force_freeze=true` evaluate
  `FROZEN` và trả `FEATURE_FROZEN` **trước** mutation; **[ADD]** dòng cờ bị DELETE lúc runtime trả
  `ROUTE_NOT_CONFIGURED` (`55000`), **không** rơi về LEGACY. Legacy fallback chỉ do compatibility wrapper
  chọn sau một **authoritative** LEGACY/SHADOW result; missing/error/unknown là fail-closed. Forward wrappers
  page-only `pay_period_fee`/`pay_draft_fee_voucher`/`pay_utility_bill` phải re-evaluate server route:
  CANONICAL trả typed *"use special writer"*, FROZEN block, chỉ LEGACY/SHADOW chạy old body.
- [ ] **Step 3: Tạo child voucher ở trạng thái nội bộ.** Resolve **org-scoped** type (qua
  `ensure_income_expense_type_v1`, **không** qua `_termination_ensure_type`); preallocate UUID/token, insert
  exact scope/source `UNAPPROVED + UNPOSTED`, real account, `voucher_date = posted_on = org_today`;
  item/billing fields giữ service month/date riêng (future prepay **không** future-date cash). Register
  ownership same transaction. `MANAGEMENT` server check xảy ra **trước** idempotency/claim mutation; thiếu
  quyền không được submit/exception. Không gọi generic approval endpoints như manager.
  **[ADD] Ba trigger INSERT-time, không phải hai:** `a85` (BEFORE), `a85b` (AFTER INSERT, **tự insert một
  token `FINANCE_V2_LIFECYCLE` ở cuối thân** ⇒ *"không có token sau INSERT"* **không phải trạng thái ổn
  định**), và `a86_finance_v2_birth_provenance` (BEFORE INSERT → `finance_v2_register_birth_v1`, set
  `birth_operation_id`/`birth_txid`, **`RAISE 23502`** nếu không suy được org) ⇒ **phải set
  `organization_id` TƯỜNG MINH** khi preallocate UUID (đừng dựa `trg_autofill_org`). Thêm:
  `decide_owned_income_expense_v2` **từ chối** khi `birth_txid = pg_current_xact_id()`.
  **[ADD] CẤM lặp lại `UPDATE income_expense_types SET is_deposit = FALSE`** (`pay_period_fee:102-103`,
  `pay_utility_bill:83`) — nút chi tiền không được sửa danh mục cấp tổ chức; nếu cần thì phải là hành động
  owner có audit.
- [ ] **Step 4: Gắn evidence rồi gọi dedicated posting adapter.** Sau voucher/items, lock/link/adopt
  `FINALIZED` evidence và assert no posting. **[RETARGET] Under cashbook lock, verify kỳ mở bằng
  `app_private.cashbook_closed_through_v1(cashbook)`** (không phải `finance_v2_is_cashbook_period_open` —
  hàm đó chỉ đọc `accounts.lock_date` và **0/28 account** có `lock_date` ⇒ **no-op trả `true` cho mọi sổ**),
  rồi sau khi voucher tồn tại thì `app_private.assert_period_open_for_edit_v1(voucher, action)`; phát đúng
  ba code có nhãn `CASHBOOK_CLOSED`/`HANDOVER_LOCKED`/`PROFIT_LOCKED`. Adapter requires exact CUSTODIAN
  possession, hoặc same-transaction `SUPERADMIN_CROSS_ORG` token, hoặc `OWNER_EXCEPTION_APPROVAL` token chỉ
  cho đúng proposal đang được owner duyệt; token được consume/audit và không dùng lại cho normal submit.
  Then approve **dưới token đúng purpose**, call source-aware core
  `finance_v2_post_voucher_with_source_v1` với claim/obligation provenance, attach evidence and set active
  posting. No direct manual primitive/bridge reliance.
  **[ADD] Nhánh `VALID_PENDING_APPROVAL`:** khi `amount >= ie_auto_approve_config.threshold` (đọc **dưới
  cùng lock với claim**, snapshot vào receipt), writer **giữ voucher `UNAPPROVED`, KHÔNG gọi core, KHÔNG
  assert POSTED**, nhưng **vẫn giữ claim** để slot không bị bấm lại. Test bắt buộc: (a) `amount < threshold`
  ⇒ `APPROVED+POSTED`; (b) `amount >= threshold` ⇒ `UNAPPROVED`, claim ACTIVE, **0 posting**.
- [ ] **Step 5: Assert posting fail-closed.** Adapter reload voucher/posting và kiểm `APPROVED`, `POSTED`,
  active posting, account, gross/net amount, evidence links và operation result. **[RETARGET] Assert về
  posting line:** **KHÔNG** chốt cứng *"đúng một `MAIN` line âm cho expense"* — `finance_v2_post_manual_voucher`
  chỉ phát `MAIN`, còn cầu a85 phát cả `CHANGE` và `ROUNDING` (CHECK cho phép
  `MAIN|CHANGE|ROUNDING|REVERSAL`), nên nếu phiếu special có tiền thối/làm tròn thì assert kiểu cũ **chốt
  cứng đúng biến thể thiếu bút toán**. Assert đúng: **đúng một `MAIN` line âm**, cộng `CHANGE`/`ROUNDING`
  **khi và chỉ khi** `change_amount`/`rounding` khác 0 với account tương ứng.
  **[ADD] Hai assert mới bắt buộc:** (a) `active posting.source_kind = 'SPECIAL_PAGE_FEE'` và **KHÔNG được
  là `'LEGACY_BRIDGE'`**; (b) **đúng một** dòng `income_expense_postings` có `event_kind='POSTING'` cho
  voucher này. (Baseline để so: `source_kind` hiện là **text tự do không CHECK**, mix
  `LEGACY_BACKFILL 1710` / `MANUAL 265` / `LEGACY_BRIDGE 73` ⇒ cầu a85 **đã sinh 73 posting thật**.)
  Sai bất kỳ điều kiện nào `RAISE 55000` để rollback voucher, claim, alert, audit và toàn batch.
- [ ] **Step 6: Áp CANARY safety caps atomically.** Full `evaluate_feature_route` chỉ trả
  `LEGACY|SHADOW|CANONICAL|FROZEN` — **không** có result `CANARY`. Khi result là `CANONICAL`, writer
  lock/read cùng feature-row version để phân biệt stored `mode='CANARY'` với `mode='ON'`.
  **[RETARGET] Bỏ khái niệm "daily actor/org bucket"** — nó **không tồn tại**:
  `app_private.server_feature_flag_operations` = `{id, feature_key, config_version, operation_key,
  organization_id, amount_vnd, created_at}`, bộ đếm **không lọc org, không lọc ngày**, `p_actor_id` chỉ được
  **hash vào `operation_key`**. Nếu vẫn muốn bucket theo ngày/actor thì đó là **schema change tường minh**
  (bảng mới hoặc thêm cột `actor_id` + `bucket_date` + index) và phải vào §Files của Task 2.
  **[RETARGET] Hai loại cap có hành vi KHÁC nhau, phải ghi rõ:** (a) `max_single_amount_vnd` và
  `max_total_amount_vnd` ⇒ `claim_feature_operation_v1` raise **`54000`**, map thành `SAFETY_CAP_EXCEEDED`,
  **route vẫn `CANONICAL`**; (b) `max_operation_count` cạn ⇒ cũng raise `54000` trong claim (dưới advisory
  lock `pg_advisory_xact_lock(hashtextextended(feature_key||':'||config_version, 0))`) **và** làm
  `evaluate_feature_route` lần **SAU** trả **`FROZEN`** cho org đã enroll — tức **chặn cứng cả canonical
  lẫn legacy**, không phải *"chỉ dừng canary"*. Quy tắc vận hành: đặt `max_operation_count` **rộng tay**
  (tiền lệ prod: `2147483647`) và preflight canary phải chứng minh cap-count **không thể** cạn trong cửa sổ.
  Test hai-request-cùng-cap vẫn đúng như bản 29/07 (khi count = M−1, lock serialise, kẻ thua đọc M và raise
  `54000`).
  **[RETARGET] Ở stored `ON`, `claim_feature_operation_v1` chỉ re-verify route rồi RETURN — KHÔNG ghi dòng
  nào.** (Telemetry ở ON mà repo đang có đến từ **hai hàm khác**: `public._record_invoice_payment_v4_legacy`
  và `public.create_income_expense_v1`, chúng tự INSERT vào bảng ops sau khối `if mode='CANARY'`.) ⇒ Nếu
  plan cần telemetry/idempotency sau khi ON thì **phải dùng bảng riêng của special-fee** (Task 2 Step 4),
  tuyệt đối không dựa vào `server_feature_flag_operations`. Stored ON **không** dùng max-single/max-total để
  biến utility warning hoặc owner-approved exception thành approval gate; emergency stop là `force_freeze`
  (xem Task 0 Step 2 về việc **chưa có** đường có kiểm toán).
  **[ADD] `evaluate_feature_route` chỉ được gọi ĐÚNG MỘT LẦN mỗi transaction** rồi snapshot
  `(evaluated, stored mode, config_version)` — nó dùng `clock_timestamp()` (không stable theo transaction)
  nên hai lần evaluate có thể cho `CANONICAL` rồi `FROZEN`; `claim_feature_operation_v1` lấy
  `clock_timestamp()` **riêng của nó** sau advisory lock nên writer có thể pass route rồi fail *"Canary
  window is no longer valid"* trong **cùng** transaction. Và `IF f.mode='ON' THEN RETURN 'CANONICAL'` nằm
  **TRƯỚC** toàn bộ khối window ⇒ `ends_at` **không** là van tự hết hạn sau ON.
- [ ] **Step 7: Ghi audit.** **[RETARGET] Giới hạn thật của helper:**
  `public.log_income_expense_action(p_id uuid, p_action text, p_note text)` — **đúng 3 tham số**; bảng
  `public.income_expense_audit_log` gồm `{id, organization_id, income_expense_id, action, actor_id,
  actor_name, old_status, new_status, note, sequence_no, prev_event_hash, event_hash, hash_scheme,
  created_at}` ⇒ **ô tự do duy nhất là `note text`, không có cột jsonb**. Chốt **một** trong hai:
  **(A)** serialize claim id / route version / config version / request fingerprint thành **JSON text** nhồi
  vào `note` (chấp nhận mất khả năng query); **(B)** thêm cột `details jsonb` ở migration schema **và chứng
  minh chuỗi `event_hash` của các Đợt trước không đổi ý nghĩa**. Viết `SPECIAL_PAGE_CREATED`,
  `AUTO_APPROVED_POSTED`, warning/exception result, claim link, route/config version, request fingerprint.
  Dùng `app_private.income_expense_change_log` (trigger `z99_*`, reader `get_voucher_change_log_v1`) cho
  **value-diff** — **đừng dựng sổ thứ ba**.
  **[ADD — nếu thiếu là gate đỏ] Phiếu auto-approve PHẢI set `system_source` (vd `special_fee.<route>`) trên
  CHÍNH dòng voucher, không chỉ ghi audit action.** `scripts/check-approver-provenance.mjs` (`CUTOFF =
  '2026-07-23'`, body `:41-56`) **fail** mọi phiếu `approval_status='APPROVED' AND approved_by IS NULL AND
  system_source IS NULL`. **Tương tác phải assert tường minh:** set `system_source` cũng làm
  `assert_manual_voucher_v1` ném `[NOT_MANUAL]` khi ai đó thử flex-cancel phiếu đó — **đó là fail-closed
  mong muốn**, và phải có test dương cho nó (xem Task 6 Step 2). Không ghi payload nhạy cảm vào
  `public.notifications`.
- [ ] **Step 8: Warning alert.** Utility ceiling/ratio và maintenance `(standard, ceiling]` vẫn post; cùng
  transaction tạo alert + owner/superadmin receipts với snapshot đầy đủ. Khoản maintenance thấp hơn standard
  **không** alert. **[ADD]** Alert cũng phải ghi khi outcome là `VALID_PENDING_APPROVAL` (để chủ biết có
  phiếu đang chờ tay mình duyệt), nhưng **không** dùng nó thay cho hàng đợi duyệt của `/thu-chi`.
- [ ] **Step 9: Chạy DB tests.** Hai session/idempotency/slot/cap và restricted Management như trên;
  **bridge ON nhưng pre-adapter posting NULL và posting cuối cùng KHÔNG phải `LEGACY_BRIDGE`**; commit có
  evidence link và exact `source_kind`/`source_id`; evidence lỗi hoặc kỳ đã chốt (cả ba nhánh
  `CASHBOOK_CLOSED`/`HANDOVER_LOCKED`/`PROFIT_LOCKED`) rollback voucher/claim/posting; manual wrapper vẫn
  source `MANUAL`; **replay idempotency KHÔNG ném `23505`**; **`dispatch_finance_decision_v2` không trả
  `0A000` cho bất kỳ decision nào của owner mới**; money reconcile không drift (`exit 0`).

### Task 6: Ngoại lệ, hủy/reversal và recurring engine

**Files:** `supabase/migrations/20260731024000_special_fee_cancel_repeat.sql`, `src/hooks/usePeriodFees.ts`,
`src/hooks/useUtilityBills.ts`, `src/hooks/income-expenses/statusMutations.ts`,
`src/hooks/income-expenses/financeV2Mutations.ts`, `src/hooks/income-expenses/batch.ts`,
`scripts/test-special-fee-concurrency.mjs`.

- [ ] **Step 1: Exception decision.** `decide_special_fee_exception_v1` chỉ owner/superadmin (định nghĩa
  §0.4); APPROVE lock/revalidate target/rule/cashbook/evidence, gọi shared context rồi tạo posted voucher/
  batch. Manager tạo initial proposal qua `request_special_fee_exception_v1`, hoặc khoản bổ sung fixed/utility
  qua `request_supplemental_special_fee_exception_v1`; owner/superadmin muốn tự tạo dùng
  `submit_owner_special_fee_exception_v1(p_exception_mode, …)`, bắt buộc reason và trong cùng transaction
  tạo immutable proposal APPROVED rồi đi chung decision path — **không** có writer free-form thứ hai.
  Initial approval rebind đúng BASE reservation; supplemental approval giữ `SUPPLEMENTAL` + `base_claim_id`;
  maintenance approval tạo event/cadence anchor. Active owner không có CUSTODIAN chỉ được dùng token
  `OWNER_EXCEPTION_APPROVAL` scoped đúng proposal; mọi superadmin có thể dùng authority mode
  `SUPERADMIN_CROSS_ORG`; cả hai vẫn kiểm sổ thật/cùng org/kỳ mở và ghi actual actor. `CONFIG_REQUIRED`,
  broker status/deposit/day failures và route FROZEN vẫn hard-block cho mọi actor; CANARY cap có thể dừng
  rollout nhưng production ON không áp amount cap. REJECT reason bắt buộc và release proposal claim; TTL quá
  hạn chuyển `EXPIRED` rồi release. Restricted `MANAGEMENT` permission vẫn là precondition.
  Cashbook/evidence/idempotency luôn bắt buộc.
- [ ] **Step 2: [ADD + REORDER] Release adapter — nâng trigger backstop lên CƠ CHẾ CHÍNH, và bổ sung
  terminal writer.** `cancel_special_fee_payment_v1`/`reverse_special_fee_payment_v1` lấy
  claim→voucher→cashbook locks rồi mới Finance; public wrapper yêu cầu và audit **một** capability hợp lệ
  theo consumer: `/thanh-toan` là scoped `thu_tien.undo`, traditional finance là scoped
  `income_expenses.cancel`/`income_expenses.reverse` (**hai key này tồn tại và ĐÚNG là key các writer
  truyền thống dùng** — `cancel_unposted_income_expense_v2`, `ie_compat_cancel_v2`,
  `cancel_income_expense_flex_v1`, `can_flex_cancel_v1`, `reverse_posted_income_expense_v2`). Không lấy UI
  route làm bằng chứng quyền.
  **[RETARGET] Undo dùng bậc "ĐƯỢC NHÌN SỔ", KHÔNG exact CUSTODIAN.** `app_private.ie_visible_cashbook_ids_v1()`
  (`is_super_admin() OR a.user_id = auth.uid() OR is_account_shared_with_me(a.id) OR EXISTS(possession_kind=
  'CUSTODIAN' AND window)`) là lựa chọn khớp **quyết định của chủ ngày 30/07** ghi tại
  `20260730240000_authz_remaining.sql:34-38` (*"với việc thu chỉ cần biết sổ là được"*) — chủ đã **cố ý**
  chọn nó thay vì so khớp `possession_kind` vì exact matching **loại cả người dùng sổ được chia sẻ**
  (JOEY/KNOWER trên TK939, annotate *"đúng ý chủ"*) và loại cả một CUSTODIAN khi truyền `kind` khác. Exact
  CUSTODIAN **chỉ** dành cho GHI/POST (submit/collect). ⚠ File đó **untracked và chưa apply** ⇒ Task 0 Step
  0″ phải quyết số phận nó trước.
  **[ADD] Bốn sự thật về hình dạng terminal mà bản 29/07 bỏ sót:**
  1. **`public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)`** — định nghĩa
     `20260730140000_ie_flex_cancel.sql:119`, **GRANT `authenticated`** `:298` ⇒ **client-callable**, và là
     **đường huỷ MẶC ĐỊNH của `/thu-chi` sau Đợt 5**; gate bằng `assert_period_open_for_edit_v1`. **Chuỗi
     này không xuất hiện trong bất kỳ plan doc nào.** Vì **cả hai org đang `strict_mode=false`**, đường này
     **đang sống trên production**, không ngủ. Người dùng huỷ một phiếu special ở đó sẽ để claim/slot
     **ACTIVE**, chiếm kỳ vĩnh viễn, rồi lộ ra dưới dạng **`23505` khó hiểu** từ partial unique BASE index.
  2. **`public.reverse_invoice_collection_v5`** (`20260730150000:460`) — cũng phải nằm trong danh sách phủ.
  3. **`app_private.cancel_collection_voucher_in_place_v1(uuid,text,uuid,uuid)`** (`20260730150000:325`) —
     **chuỗi này cũng không xuất hiện trong bất kỳ plan doc nào**. ACL là `postgres=X/postgres` (comment
     `:323-324`: *"KHÔNG kiểm quyền ở đây: hàm chỉ gọi được từ trong `reverse_invoice_collection_v5`"*) ⇒
     nó **không nợ một public wrapper**, **nhưng** nó **ghi trạng thái terminal** nên **trigger backstop
     phải phủ nó**; đừng để danh sách wrapper tạo cảm giác đã kín.
  4. **Phải key theo `deleted_at IS NULL → NOT NULL`, KHÔNG theo `approval_status='CANCELLED'`.**
     `cancel_period_fee`/`cancel_utility_bill` **chỉ soft-delete** (`cancel_period_fee:63-64`
     `UPDATE income_expenses SET deleted_at = now()`) và **không bao giờ** đặt `CANCELLED` ⇒ live có **5
     `utility.bill` + 2 `fixed_fee`** soft-deleted mà vẫn `'APPROVED'`, và trigger
     `a75_ie_cancel_close_request` (WHEN `new.approval_status='CANCELLED'`) **không fire**. (Tiền vẫn đảo
     đúng vì `a85` khai trên `UPDATE OF … deleted_at`.)
  ⇒ **Quyết định thiết kế:** vì mặt cắt này nhận **bốn migration huỷ trong đúng một ngày**, **AFTER UPDATE
  trigger backstop được NÂNG từ "backstop" thành CƠ CHẾ CHÍNH** để release claim (key theo chuyển trạng thái
  terminal, không theo danh sách tên hàm); danh sách writer enumerate còn lại chỉ là **lớp thứ hai** và phải
  ghi *"danh sách tại thời điểm audit 30/07"*, không phải *"mọi terminal writer đã xác minh"*. Thêm một gate
  script quét `pg_proc` tìm mọi hàm public đặt `approval_status IN ('CANCELLED','REJECTED')` **hoặc**
  `deleted_at = now()` trên `income_expenses` rồi **fail nếu có hàm chưa nằm trong allowlist release**.
  Danh sách hiện tại phải phủ: hai named wrapper mới, `cancel_period_fee`, `cancel_utility_bill`,
  `cancel_income_expense_v1`, `cancel_unposted_income_expense_v2`, `reject_invalid_income_expense_v2`,
  `withdraw_income_expense_v2`, `reverse_posted_income_expense_v2`, `ie_compat_cancel_v2`,
  **`cancel_income_expense_flex_v1`**, **`reverse_invoice_collection_v5`**,
  **`app_private.cancel_collection_voucher_in_place_v1`** (qua trigger), và termination-owned
  cancel/reject/reverse adapters. `request_income_expense_changes_v2` **không** release vì chưa terminal.
  **[ADD — BẪY ĐANG SỐNG, phải vá trong chính step này] `cancel_period_fee` nhận MỌI phiếu EXPENSE alive có
  item khớp một trong 9 key** (body `:31-45`, **không** chỉ `system_source` `fixed_fee`/`utility.bill`) rồi
  làm một `UPDATE … SET deleted_at = now()` **không token** ⇒ `a00_ie_owned_payload_freeze` /
  `guard_income_expense_owned_payload:46-54` chặn với **`55000`** *"canonical income expense … is frozen
  (update rejected)"* **bằng tiếng Anh**. **Live có 9 phiếu trong bẫy:** 8 draft E2E DEMO + **1 phiếu
  production `PC2607096` "phí bỏ rác"** (org thật, toà 512LTT/512TT, **100.000đ**, APPROVED,
  `system_source` NULL, `flow_kind=CANONICAL_INCOME_EXPENSE`, `in_batch=false`, type *"Bỏ rác"* không
  restricted). Và vì `get_period_fee_status:97` tính `cancellable = NOT in_batch` **một mình**, UI **đang
  hiện nút Huỷ bật sáng** cho phiếu đó (`PeriodFeePanel.tsx:366 → usePeriodFees.ts:261`) và trả lỗi `55000`
  tiếng Anh **hôm nay**. ⇒ **`cancellable` phải là `NOT in_batch AND NOT is_income_expense_flow_owned(id)`**
  (live: 43 phiếu `in_batch`, 9 phiếu flow-owned), và wrapper mới phải: nếu
  `app_private.is_income_expense_flow_owned(id)` → route sang named owner adapter **hoặc** trả lỗi tiếng
  Việt hành động được — **tuyệt đối không** để lọt xuống body cũ. Cảnh báo song sinh:
  **`pay_draft_fee_voucher:36-39` UPDATE `account_id`**, cột **ngoài** allowlist của guard (`:59-79`) và
  ngoài cửa ANNOTATE (`:29-43`) ⇒ **8 draft flow-owned không thanh toán được dù có token**.
- [ ] **Step 3: Reversal/replacement.** Acquire global locks đến voucher/cashbook; require reversal posting
  date nằm trong open cashbook period (**qua `cashbook_closed_through_v1` + `assert_period_open_for_edit_v1`,
  ba code có nhãn**); sau Finance success chuyển claim `RELEASED` với reason `REVERSED`. Cancel posted phải
  reverse active posting **trước** rồi mới mark voucher CANCELLED/release claim trong cùng transaction.
  Replacement link old claim/voucher + reason; slot chỉ mở sau canonical terminal transition.
- [ ] **Step 4: Tích hợp recurring.** Generator dựng occurrence theo **service/billing month**, không
  `voucher_date`. Mỗi due month ghi một occurrence: child mới `CREATED_CHILD`; slot đã được special prepay
  thỏa là `SATISFIED_EXTERNALLY`, decrement/advance parent **đúng một lần**; ambiguous duplicate
  `BLOCKED_CONFLICT` không spam. `repeat_next_date` tiến tới first uncovered month, finite remaining giảm
  theo satisfied occurrences. Giữ legacy approval semantics; parent **không** còn suy từ child count; dùng
  `org_today_v1`.
  **[RETARGET] Idempotency key là `(parent_id, target_month)`, không phải child id** — vì **77 dòng
  `repeat_due` là PARENT schedule, không phải child** (77/77 `repeat_parent_id IS NULL`; plan 29/07 gọi
  chúng là *"recurring children đang due"*). **155 child sống** (146 APPROVED+POSTED + 9 CANCELLED),
  **155/155 `system_source IS NULL`**, **155/155 đáp xuống một slot fixed-kind** ⇒ tích hợp external-holder
  phủ **100% dân số recurring**, không phải edge case. Ghi rõ vị ngữ "due" dùng cái nào (**77** theo
  `repeat_next_date >= org_today` hay **76** theo `add_cycle(...) <= current_date`).
  **[ADD] Bốn sự thật về engine đang chạy phải nêu trong task này:** cron `recurring_vouchers_daily`
  (`0 18 * * *`, **active**) → `run_recurring_vouchers_job` → `generate_recurring_vouchers(NULL)` = **toàn
  bộ parent trong DB**; nó (a) **không đọc `ie_auto_approve_config`**, (b) **copy `attachments` của phiếu
  cha cho MỌI child** (`:61`), (c) dùng `CURRENT_DATE` (`:28`, không timezone org), (d) **nuốt lỗi từng
  child** (`:78-80 EXCEPTION WHEN OTHERS THEN RAISE NOTICE`); **64/77** parent có
  `repeat_auto_approve=true`. ⇒ **Mâu thuẫn ngưỡng phải ghi thành quyết định:** cùng một số tiền, đường
  utility mới sẽ ra **NHÁP** còn đường recurring vẫn **tự duyệt + tự post**.
- [ ] **Step 5: Quan sát và reconcile toàn payload của writer truyền thống.** Không dùng AFTER INSERT trên
  voucher header vì item chưa tồn tại. Tạo
  `app_private.reconcile_external_special_fee_claims_for_voucher_v1(voucher_id)` đọc lại **toàn bộ header +
  current items**, diff với claims do chính voucher giữ, release claim stale khi item bị DELETE/đổi
  type-period-scope, rồi upsert `EXTERNAL` mới **chỉ** với `special_fee_type_mappings` đã publish. Gọi helper
  ở cuối `ie_compat_insert_v2` và đặc biệt cuối toàn bộ `ie_compat_update_pending_v2` sau chuỗi
  delete/reinsert (**⚠ `ie_compat_update_pending_v2` đang bị Đợt 6 vá theo MẪU NEO
  `20260730190000:36-83`, neo `v_meta_keys`/`v_money_keys` — xem Task 0 Step 0′ trước khi redefine**);
  statement-level/deferred adapter bao phủ direct item INSERT/UPDATE/DELETE và voucher status transition
  nhưng **không** reconcile ở trạng thái item nửa chừng. Voucher `system_source LIKE 'special_fee.%'` chỉ
  attach claim/batch đã reserve, không tạo `EXTERNAL` lần hai. Adapter **không** đổi approval/posting hoặc
  chặn writer cũ: nếu BASE index đã có holder khác, dùng savepoint/conflict-aware insert để **không** ném
  lỗi ra legacy writer, ghi `special_fee_migration_conflicts` + owner alert và giữ holder hiện hữu; **không**
  cố insert claim `CONFLICT` cạnh BASE. Với voucher legacy của đúng bốn loại được trả trước và có range
  tháng parse được, fan-out **một `LEGACY` claim cho từng tháng được phủ**, tất cả cùng trỏ voucher gốc;
  không chia/sửa amount lịch sử. Range hoặc mapping mơ hồ tạo `LEGACY_MULTI_MONTH_AGGREGATE` trong conflict
  ledger và block toàn dải ở read model, không để tháng nào trông như slot trống.
  **[ADD]** Reconciler phải nhận **304 phiếu `system_source` NULL** làm `EXTERNAL/LEGACY` claim (đó là phần
  lớn trong **376 phiếu** mà trang đang đọc: 304 NULL + 67 `utility.bill` + **5 `salary.staff`** — 5 phiếu
  lương này phải bị **loại** theo mapping của chủ, xem Task 2 Step 2).
- [ ] **Step 6: Backfill config/claims trước cutover.** **[RETARGET]** Import
  `buildings.commission_tiers` thành DRAFT per org/building/kind **kèm `fallback_policy` bắt buộc trước
  publish**; **KHÔNG** import `building_fee_accounts.default_amount` trước khi xử vòng tự-học (Task 2 Step
  1c). Missing fixed amount, utility thresholds, maintenance standard/ceiling và Sale cap thành
  `CONFIG_REQUIRED`, **không** suy từ lịch sử và **không** auto-publish.
  Một slot legacy duy nhất → `LEGACY`; nhiều voucher → `CONFLICT`; **2 HĐ** có 2 phiếu broker APPROVED +
  **11** phiếu broker không gắn HĐ → `COMMISSION_WITHOUT_CONTRACT` + **3** dòng `commission_legacy_dup=true`
  phải ghi riêng; **200 phiếu bảo trì / 31 tên** không được chủ map → `LEGACY_SCOPE_UNKNOWN`
  *(plan 29/07 ghi 101 — số đo lại 30/07 là 200)*. Không tự chọn voucher thắng.
  **[ADD] CẤM query backfill keyed on `system_source='fixed_fee'`** — chỉ có **2 dòng trong toàn bộ lịch
  sử, cả hai đã soft-delete** ⇒ query đó trả **0 dòng và báo "sạch" SAI**.
  **[ADD] Báo cáo trước/sau phải theo `organization_id` và so DELTA với baseline đã ghi**, không so bằng
  tuyệt đối (`income_expenses` dịch **+32 dòng alive trong ~1 ngày**; 2.528 alive / 2.625 tổng ngày 30/07 so
  với baseline 2.496 alive ngày 29/07). Preflight cũng phải ghi **digest của `public.fee_type_matches` và
  `public.nrm_vn`** vì mọi đếm fixed-kind phụ thuộc hai hàm đó. Và chủ phải **ký nhận CON SỐ GIẢM** ở ô
  Quản Lý/Điện/Vệ sinh/Rác — đừng để chủ đối chiếu *"trước/sau khớp nhau"* rồi hợp thức hoá số sai.
  ⚠ **Chưa hoà giải, phải đo lại một query trước khi viết backfill:** số tiền của chính type `'Quản Lý'`
  (43 phiếu) — một phép đo cho **18.500.000đ**, một cho **90.500.000đ**; báo **cả** `SUM(items.amount)`
  **và** `SUM(ie.total_amount)`, vì **chênh lệch chính là khuyết tật Slice −1.4**. Con số load-bearing
  **34.206.744đ** (2 phiếu *"Lương quản lý"*) thì **cả hai phép đo đồng ý**.
- [ ] **Step 7: Test concurrency/cancel/repeat/manual observer.** Bắt buộc có fixture legacy Internet/Công
  an/Rác/Thang máy ba tháng tạo đủ ba claims; recurring occurrence đã `SATISFIED_EXTERNALLY` advance parent
  **đúng một lần**; retry không tạo child/alert mới; `EXTERNAL` và `NORMAL` không thể race cùng slot;
  `ie_compat_update_pending_v2` đổi item bằng delete/reinsert không để claim stale và direct DELETE cũng
  release đúng holder; maintenance exception đã post trở thành cadence anchor còn pending/reversed thì
  không; owned special cancel/reverse dispatch đúng dù global Finance route OFF; ordinary voucher vẫn
  generic; replacement chỉ mở sau terminal transition. **[ADD] Bốn test mới bắt buộc:**
  (a) **huỷ qua `cancel_income_expense_flex_v1` trên `/thu-chi` PHẢI release claim** (hoặc fail-closed rõ
  ràng), và `can_flex_cancel_v1` phải trả `reason_code` đúng để nút **không hiện nhầm**;
  (b) **phiếu có `system_source='special_fee.*'` bị flex-cancel PHẢI nhận `[NOT_MANUAL]`** từ
  `assert_manual_voucher_v1` — fail-closed mong muốn;
  (c) **`cancellable = false` cho 9 phiếu flow-owned**, kiểm trên đúng `PC2607096`;
  (d) release keyed theo `deleted_at` (không theo `CANCELLED`) — dựng một phiếu soft-deleted mà vẫn
  `APPROVED` rồi assert claim đã `RELEASED`.
  Chạy `node scripts/reconcile-money.mjs 2026-07` (**pass = `exit 0`**); xác nhận `/thu-chi` vẫn tạo
  workflow cũ.

### Task 7: Read models, hooks và UI `/thanh-toan`

**Files:** `supabase/migrations/20260731025000_special_fee_read_wrappers.sql`; toàn bộ hook/component/test
đã liệt kê tại §2.3; các function SQL `resolve_fixed_expense_type`, `fee_type_matches`,
`get_period_fee_status` được forward-redefine trong migration mới, **không** sửa migration lịch sử — và
**phải `pg_get_functiondef` live rồi diff với `20260728180000:944` trước khi viết** (§2.3).

**[RETARGET] Toàn bộ task này nhắm `src/pages/ThanhToan.tsx`, không phải `ThuTien.tsx`.**

- [ ] **Step 1: Read RPC + auth contract.** `get_special_fee_overview_v1` SECURITY DEFINER **khai VOLATILE**
  nhận 1–50 buildings/range ≤ 24 months, resolve cùng org, reject mixed/cross-org và require
  `thu_tien.view` **từng building** **cộng** `buildings.view` (`can_access_building`) —
  hai key legacy là **bổ sung, không thay thế** (§0.5/Task 0 Step 3d). Trả rule/slot/claim/proposal/voucher/
  active posting/warning/conflict; **"Đã chi" không dựa `APPROVED`**. Rule DRAFT/history, all-org
  alerts/receipts và exception queues chỉ owner/superadmin; staff chỉ thấy scoped payment data.
  Alert/exception history dùng keyset `(created_at, id)`, limit 1–200 và cursor null-pair validation; không
  offset pagination.
  **[ADD] `cancellable` phải là `NOT in_batch AND NOT is_income_expense_flow_owned(id)`** — hôm nay
  `get_period_fee_status:97` chỉ xét `in_batch` (Task 6 Step 2).
  **[ADD] Read model mới KHÔNG được lặp lại hai lỗi của `get_period_fee_status`:**
  (1) **cộng theo TỔNG ITEM KHỚP, không phải `ie.total_amount`** — CTE `vperv` (`:49-79`) chọn
  `ie.total_amount AS amount` rồi `GROUP BY (building, category, ie.id)` và `:84-85`
  `SUM(v.amount) FILTER (st='APPROVED')` ⇒ phiếu `5916661a-66c2-4a7c-88f1-b90e27d62564` *"Tiền Điện + Tiền
  nước"* `total_amount = 6.384.000` (item `dien` 5.758.000 + `nuoc` 626.000) đang góp **6.384.000 vào ô Điện
  VÀ 6.384.000 vào ô Nước**; test phải assert ô Điện = **5.758.000** và ô Nước = **626.000**;
  (2) **dừng dùng matcher tên** — dùng `special_fee_type_mappings` do chủ duyệt cho **cả read model**, với
  bộ fixture false-positive ở Task 2 Step 2;
  (3) **xử lý item NULL-dated** — 3 phiếu APPROVED khớp matcher có item thiếu `start_date`/`end_date`, trong
  đó toà `cb6592d8-…` `quan_ly` có **3 phiếu APPROVED cùng month NULL** = một ô trùng ba **vô hình** với cả
  reader (`:76`) lẫn guard (`pay_period_fee:74`).
  **[ADD] Hai bẫy nhỏ của reader cũ phải không tái diễn:** `get_period_fee_status` **im lặng bỏ** category
  key lạ (`WHERE k IN (…9 key)`, không `RAISE`) ⇒ typo phía client cho status rỗng, render thành *"chưa
  đóng"*; và nó quét `income_expense_types` **không có điều kiện organization** (`:41-48`) — vô hại với 2
  org hiện tại nhưng là bẫy khi thêm org.
- [ ] **Step 1b: Query-plan gate.** Overview nhận mảng building ids và trả một payload, không N+1; chạy
  `EXPLAIN (ANALYZE, BUFFERS)` trên rehearsal data cho rule selection, active slot, maintenance last-service
  và alert queue; thêm composite/partial indexes khi query không dùng index ở phạm vi org/period/scope.
- [ ] **Step 1c: [ADD] Public route-read RPC (nếu chọn phương án A).** Client **không** đọc được
  `app_private` (`nspacl = {postgres=UC/postgres, ie_canonical_writer=U/postgres}`;
  `has_schema_privilege('authenticated','app_private','USAGE') = false`) ⇒ Step 2 cần **một** trong hai:
  **(A)** thêm `public.get_special_page_route_v1(p_feature_key text) RETURNS text` — SECURITY DEFINER
  **VOLATILE**, whitelist đúng các key của plan, resolve org từ JWT (**không** nhận `p_organization_id` từ
  client), `REVOKE FROM PUBLIC/anon/service_role` + `GRANT EXECUTE TO authenticated`, và đưa vào
  `check-definer-acl`; **hoặc (B)** bỏ nhánh route ở client và để writer canonical tự trả typed
  `ROUTE_NOT_WRITABLE`/`FEATURE_FROZEN` — nhưng khi đó **phải xoá câu *"route error không gọi writer nào"***
  khỏi Step 2 vì nó thành bất khả thi. Mẫu (A) **đã ship 21 lần** trong repo (21 hàm `public` DEFINER gọi
  `evaluate_feature_route` nội bộ mà client không có grant `app_private`), nên đây là lối ít rủi ro hơn.
- [ ] **Step 2: Cắt writer ở đúng entrypoint cho đủ family.** Sửa `usePeriodFeeState.ts`/`useUtilityPayState.ts`
  (**sau khi đã hoist ở Task 0 Step 4**) để khi full evaluator trả `CANONICAL` thì gọi
  `submit_special_fee_payment_v1`; `pay_period_fee`, `pay_draft_fee_voucher`, `pay_utility_bill` chỉ legacy
  fallback khi server trả rõ LEGACY/SHADOW và **không** nhận `p_force` từ normal UI. Route query
  loading/error/unknown disable check với typed `ROUTE_STATE_UNKNOWN`, **tuyệt đối không** map sang legacy.
  `PeriodFeePanel.tsx`/`PeriodFeeSheet.tsx` chuyển AC + washer khỏi `useMaintenanceBatch`/
  `useCreateIncomeExpenseBatch` sang special writer; ordinary `IncomeExpenseBatchForm.tsx` vẫn baseline.
  Hook tests cho từng family chứng minh full route `CANONICAL` không chạm legacy RPC/batch writer, route
  error không gọi writer nào, còn explicit OFF/SHADOW và mọi page ngoài `/thanh-toan` vẫn đường cũ.
  **[RETARGET] Hoa hồng: `PeriodCommissionModal` HÔM NAY CHỈ XỬ LÝ BROKER.** `:76` truyền
  `kind: 'broker', amount` và **không có nhánh Sale nào trong file**; `get_period_commissions` cũng **lọc
  `commission_kind='broker'`**. ⇒ *"chuyển broker + Sale sang `useSpecialFeePayments`"* thực chất là **hai
  việc khác nhau**: chuyển broker **và MỞ MỘT BỀ MẶT TIỀN MỚI** (`SALE_HOT_BONUS`) chưa từng tồn tại trên
  trang này. 7 phiếu thưởng Sale hiện có **đều sinh từ trang hợp đồng**
  (`src/components/contracts/CommissionVoucherModal.tsx:198/:220` phát cả `'broker'` và `'sale'`). Nguồn dữ
  liệu, tab, trần, báo cáo **đều mới** ⇒ **phải tính lại effort**, và Sale là **new construction**, không
  phải migration.
  **[ADD — thiếu hẳn trong bản 29/07] Mục "Đảo lại quyết định §12.7 ngày 23/07/2026" cần chủ ký riêng.**
  `PeriodCommissionModal.tsx:4-11` ghi rõ shortcut create-then-approve **đã bị xoá có chủ ý** (*"Phiếu tồn
  tại ≠ đã chi"*; duyệt phải xảy ra ở `/thu-chi`), và `create_commission_voucher` **luôn** ra `UNAPPROVED`.
  Plan 1 định đưa hoa hồng về *"tự duyệt + vào sổ ngay"* ⇒ **đảo ngược quyết định của chính chủ**. Cả ba
  plan doc **0 lần** nhắc `12.7` / *"Chi & duyệt"* / *"create-then-approve"*. ⇒ Thêm một hạng mục
  **owner sign-off tường minh TRƯỚC** khi có dòng code nào chuyển broker sang auto `APPROVED+POSTED`.
- [ ] **Step 3: Hooks và canonical paid-state reads.** `useSpecialFeeRules` query published/DRAFT/history;
  mọi query key chứa organization + building scope + month/kind; `useSpecialFeePayments`
  preview/submit/exception/alerts với discriminated union. Period/utility/commission/maintenance surfaces
  ngừng tự suy "paid" từ `approval_status`; tất cả dùng overview/read wrapper yêu cầu **active POSTED +
  posting line**. Invalidate overview, alerts, exceptions, income-expenses, postings,
  accounts-with-balance và lifecycle keys; **không** dùng `as any` sau type regen.
  **[ADD] Thêm BỐN key ĐANG TỒN TẠI mà hub đang thiếu** — `['period-fee-status']`, `['period-commissions']`,
  `['period-maintenance']`, `['fee-accounts']` (Task 0 Step 5c) — nếu không, `/thanh-toan` vẫn **không**
  live-refresh từ máy khác và rủi ro phiếu trùng vẫn được khuếch đại.
  **[ADD] Bốn nguồn "paid" sai phải sửa cùng lúc, có bằng chứng live:** `get_period_fee_status` dùng
  `SUM(v.amount) FILTER (st='APPROVED')` **không** đọc `posting_status`/`active_posting_id_v2`;
  `get_period_commissions` dùng `CASE WHEN voucher_id IS NULL THEN 'unpaid' WHEN approval_status='APPROVED'
  THEN 'paid' ELSE 'draft'`; `get_period_maintenance` lọc `approval_status='APPROVED'`;
  `useUtilityBills.ts:304 .eq('approval_status','APPROVED')` (và `:370-371 paidThisKy` chỉ đọc map đó).
  Bằng chứng: `PC2607005` đang "Đã chi" mà `posting_status='UNPOSTED'`, `active_posting_id_v2 IS NULL`,
  **2.730.000đ** trên sổ thật.
- [ ] **Step 4: Registry parity.** Đổi label group thành `Hoa Hồng & Thưởng Sale` **nhưng giữ key
  URL/legacy**; cập nhật `feeCategories.ts`, `fixedExpenseCategories.ts`, SQL `resolve_fixed_expense_type`/
  `fee_type_matches`/`get_period_fee_status`, và `src/lib/feeCategories.test.ts` (đang assert
  `toHaveLength(10)` và bốn kind multi-month `['cong_an','internet','rac','thang_may']` tại `:6-16`).
  Backfill/report **không** dùng matcher chung — dùng `special_fee_type_mappings` (Task 2 Step 2).
  **[ADD]** `feeCategories.ts` / `fixedExpenseCategories.ts` / SQL `fee_type_matches` **hiện đang parity**
  cho cả 9 GRID key ⇒ đây là một invariant đang xanh, **phải giữ xanh**, không phải việc phải sửa.
  **[ADD]** `GRID_SERVER_KEYS` còn ship `dien`/`nuoc` mà **không** registry entry nào dùng làm `serverKey`;
  và `building_fee_accounts` mang **17 dòng `dien` + 12 dòng `nuoc`** ngoài 7 fixed kind ⇒ đừng để registry
  parity vô tình kéo hai category đó vào họ fixed.
- [ ] **Step 5: Fixed UI.** Prefill amount/version; chỉ bốn category cho multi-month; check exact mismatch mở
  exception dialog; duplicate link voucher/proposal; **không còn `p_force` trên normal path**.
  **[RETARGET] Viết ra việc xoá, không chỉ ý định:** `usePeriodFees.ts` phải **bỏ `force` khỏi mutation
  args** (`:214 force?: boolean`) và **ngừng gửi `p_force`** (`:227`); `usePeriodFeeState.ts` phải **xoá
  `doPay(force)` / `confirmPayDup` / `dupConfirm`** (`:310-315`);
  `PeriodFeeVoucherList.PeriodFeeDupConfirmModal` (nút **"Đóng thêm"** `:186-189`) cùng **hai mount site**
  `PeriodFeePanel.tsx:812` và `PeriodFeeSheet.tsx:584` phải được **thay** bằng outcome `DUPLICATE` +
  link-to-existing-voucher UI. Ghi rõ: chốt chống trùng của `pay_period_fee` hôm nay **chỉ đếm `APPROVED`**
  nên một draft `UNAPPROVED` **không cảnh báo gì** ⇒ predicate BASE claim mới **phải phủ cả draft**.
  Nếu chủ vẫn muốn giữ đường "đóng thêm" thì nó chỉ mở cho owner/superadmin và dialog phải hiện **danh sách
  phiếu đang có kèm số tiền** (Task 0 Step 4d).
- [ ] **Step 6: Utility UI.** Mỗi row là **utility account id**; hiển thị supplier amount, billed
  denominator, ceiling, ratio, warning snapshot; account id thiếu trả typed validation/config error,
  **tuyệt đối không** gọi nhánh legacy tạo meter ngầm; second same meter/month disable/link. DB/hook/E2E
  test riêng chứng minh `utility_account_id` NULL **không** insert `building_utility_accounts`.
  **[ADD] Bối cảnh: nhánh tự-tạo-meter đã chạy và tự che dấu vết** — `metersOf()`
  (`useUtilityPayState.ts:84-89`) sinh row tổng hợp `{key:'syn:…', accountId:null, isSynthetic:true}`,
  `:198` truyền `utilityAccountId: row.accountId`, nhánh ELSE của `pay_utility_bill` **INSERT một dòng
  `building_utility_accounts` mới**, và vì `paidThisKy` khoá theo meter id (trả `undefined` khi null) dòng
  đó **không bao giờ** hiện "đã đóng"; live **0** phiếu `utility.bill` có `utility_account_id` NULL
  (`idx_bua_building_type` **không unique** nên bảng cho phép nhiều meter — hiện 1 cặp có 2 meter, max 2).
  ⇒ UI phải đổi dòng tổng hợp thành nút **"Tạo công tơ"** tường minh.
  **[ADD] Reader phải hiện `UNAPPROVED` với nhãn "Chờ duyệt"** và `paidThisKy` coi UNAPPROVED là *"đã có
  phiếu"* (không phải *"đã đóng"*) — đây là điều kiện để `VALID_PENDING_APPROVAL` có chỗ hiển thị. DEMO
  có **2 meter, cả hai `provider_code` NULL**.
- [ ] **Step 7: Commission/Sale UI.** Một category chung nhưng **hai tab/voucher/rule**; broker chỉ hiện
  normal check khi server eligibility đủ thực thu cọc + 7 ngày. Khi status/day chưa đạt, hiển thị lý do và
  ngày sớm nhất nhưng **không** hiện đề xuất/direct exception; basis untrusted mở reconciliation queue
  riêng, **không** biến thành proposal hoa hồng. Chỉ sau khi eligible, amount khác expected mới được manager
  đề xuất hoặc owner/superadmin tạo direct exception có audit. Sale hiện ngay và áp cap; amount **không**
  được client tự quyết validity.
  **[ADD] Hai điều kiện trước khi viết một dòng code nào ở step này:** (a) **owner sign-off cho việc đảo
  §12.7** (Step 2); (b) **`fallback_policy` đã publish**, kèm parity test SQL↔TS và report HĐ bị ảnh hưởng
  — nếu không, **22 HĐ** ở 7–9 tháng sẽ thấy số dự kiến nhảy từ `50% × rent` xuống `0` mà không ai giải
  thích được (Task 3 Step 5). **[ADD]** `create_commission_voucher` chèn `p_account_id` **thô** (không một
  `SELECT … FROM accounts` nào trong 223 dòng body) ⇒ wrapper/writer mới **phải** kiểm account cùng org +
  custody trước khi ghi.
- [ ] **Step 8: Maintenance UI.** AC chọn **room** từng line; washer chọn building; hiển thị last service,
  earliest valid date, standard/ceiling; **không** dùng `useCreateIncomeExpenseBatch` để ghi special.
  **[ADD] Ba tiền đề bắt buộc trước Step này:** (a) **bỏ `supabase.from('income_expense_types').insert(...)`
  ở `src/hooks/useMaintenanceBatch.ts:36-46`** — browser đang ghi thẳng vào bảng danh mục cấp tổ chức;
  chuyển vào RPC (gate: `grep` = **0** lời gọi `from('income_expense_types').insert` trong `src/`);
  (b) **thêm chiều "phòng"**, hiện chưa tồn tại (`MaintenanceBatchLine` chỉ `{buildingId, subtype, amount}`;
  `get_period_maintenance` không trả room); (c) reader phải thấy `UNAPPROVED` — hôm nay
  `ie_compat_insert_v2` **ép** `approval_status='UNAPPROVED'` bất kể số tiền còn
  `get_period_maintenance` lọc `APPROVED` ⇒ tab hiện *"Kỳ này chưa có phiếu bảo trì."*
  (`PeriodFeeSheet.tsx:525`) **ngay sau khi tạo thành công**, mời người dùng tạo lại.
  **[ADD] Ghi rõ đây là ĐỔI HÀNH VI về custody**, không phải no-op: maintenance ghi qua
  `ie_compat_insert_v2` (**đòi** binding `CUSTODIAN`, hoặc `KNOWER` khi type INCOME) trong khi
  `pay_period_fee`/`pay_utility_bill` chỉ kiểm `accounts.user_id` ⇒ hợp nhất về **một** hợp đồng
  `assert_cashbook_access_v2(...,'CUSTODIAN',...)` là thay đổi hành vi cho họ fixed/utility.
- [ ] **Step 9: Settings/alerts/exception queue.** Chỉ owner/superadmin thấy settings; effective month bắt
  buộc; history read-only. `SpecialFeeExceptionQueue.tsx` liệt kê PENDING/expired/history theo org/building,
  mở exact snapshot/evidence/cashbook/reason và gọi `decide_special_fee_exception_v1(APPROVE|REJECT)`;
  manager chỉ thấy proposal của scope mình ở trạng thái read-only. Thêm reconciliation queue cho virtual
  opening-balance deposit chưa trusted, hiển thị contract/voucher/source/fingerprint/`cash=false` và bắt
  buộc reason khi recognize/reject. Alert drawer đọc private RPC, **không** lộ comparison cho staff khác
  organization.
  **[ADD]** *"Owner"* ở đây là `special_fee_is_owner_or_superadmin_v1` (§0.4); **không** đọc label UI, và
  **không** dùng `member_type`.
- [ ] **Step 10: Test read ACL + UI.** Direct RPC tests: missing `thu_tien.view`, một building unauthorized,
  mixed org, oversized range/page, staff đọc owner alert, superadmin provenance, **cộng** ca *"có
  `thu_tien.view` nhưng thiếu `buildings.view`"* (Task 0 Step 3d) và ca **NGƯỢC** của `demo.ketoan`.
  **[RETARGET] BỎ câu "Sau đó Playwright DOM; không thêm testing-library".** Tiền đề *"repo không có
  harness"* **sai**: repo **đã có** harness render trong environment `node` — `renderToStaticMarkup`
  (`react-dom/server`), **15 file** dùng, mẫu chuẩn
  `src/components/buildings/__tests__/BuildingFilterSelect.test.tsx:19-27`, chạy **12 assertion / 4 file
  trong 1,54 s**. ⇒ **Invariant render (nhãn "Chờ duyệt", `cancellable` disable nút Huỷ, `DUPLICATE` hiện
  link, hai tab hoa hồng) viết bằng harness đó**; Playwright **chỉ** dành cho luồng đa bước và
  chứng từ/upload thật. Vẫn giữ *"không thêm testing-library/jsdom"*.
  ⚠ **Ghi baseline:** `BuildingFilterSelect.test.tsx` **đang ĐỎ** (2 failure tại `:38` và `:45`, assertion
  đối số cũ) ⇒ điều kiện pass là *"không có đỏ MỚI so với baseline HEAD"* (Task 0 Step 6).

### Task 8: Rollout, E2E và Definition of Done

**Files:** `scripts/audit-special-fee-rollout.mjs`, `.e2e-fleet/specs/special-fee-fixed.spec.ts`,
`special-fee-utility-warning.spec.ts`, `special-fee-commission-maintenance.spec.ts`,
`special-fee-scope-isolation.spec.ts`, **existing `.e2e-fleet/specs/thanh-toan-page.spec.ts` và
`utility-paste-receipt.spec.ts` (GIỮ XANH, không viết lại)**,
`docs/superpowers/runbooks/2026-07-31-special-payment-rollout.md`.

- [ ] **Step 1: Preflight snapshot.** Chạy `node scripts/audit-special-fee-rollout.mjs --mode preflight`;
  ghi count/sum/**digest** per organization, fee kind, month, source, cashbook và report
  duplicate/conflict/recurring external holders. Script **chỉ SELECT**, in timestamp/query hash và fail nếu
  phát hiện production mutation.
  **[ADD] Ba luật của preflight:** (a) **mọi count/sum phát theo `organization_id`** — phần lớn số liệu
  không có tổng cross-org có nghĩa; (b) **so DELTA với baseline đã ghi, không so bằng tuyệt đối** (đo được
  `income_expenses` **+32 dòng alive/ngày**, cộng hai rổ cọc dịch giữa 29/07 và 30/07: org thật null-source
  POSTED 15→17 dòng / +5.000.000đ, DEMO null-source virtual 13→18 dòng / +8.000.000đ); (c) ghi **digest của
  `public.fee_type_matches` và `public.nrm_vn`** vì mọi đếm fixed-kind phụ thuộc hai hàm đó.
  **[ADD] Bốn hạng mục phải đo lại trước khi backfill được viết** (một query mỗi cái): (1) khoá canonical
  của slot điện/nước (kỳ dịch vụ **2 ô** vs `voucher_date` **4 ô** — chênh 2×, Task 4 Step 1); (2) số tiền
  type `'Quản Lý'` (18.500.000 vs 90.500.000 trên cùng 43 phiếu — báo cả `SUM(items.amount)` và
  `SUM(ie.total_amount)`); (3) digest live-vs-migration của `fee_type_matches` và `get_period_fee_status`;
  (4) nội dung `buildings.hidden_fixed_expenses` đã đo (4/21 toà, 6 ô, chỉ 3 ô thuộc 7 kind) — chốt với chủ
  rằng ~32 ô còn lại **là** nợ cấu hình.
- [ ] **Step 2: [RETARGET] Feature route đúng schema — tên tham số thật và định dạng cứng.** Verify route
  `special_fee.payment.v1` đã được seed `OFF` từ Task 2 Step 6b bằng assertion **hai phần** (`EXISTS` +
  `mode='OFF' AND force_freeze=false`), **không** bằng `evaluate() = 'LEGACY'`.
  Chữ ký **thật** (bản 29/07 đúng thứ tự positional nhưng **sai 3 tên** ⇒ gọi named-arg sẽ **`42883`**):
  ```text
  app_private.set_feature_route_v1(
    p_feature_key, p_expected_config_version, p_mode, p_starts_at, p_ends_at,
    p_max_operation_count, p_max_single_amount_vnd, p_max_total_amount_vnd,
    p_commit_sha, p_migration_sha256, p_maintenance_window_id, p_approval_reference,
    p_actor, p_reason
  ) RETURNS bigint   -- = config_version mới
  ```
  **Ràng buộc cứng bản 29/07 bỏ sót:** khi `p_mode IN ('ON','CANARY')` thì
  `p_commit_sha !~ '^[0-9a-f]{40}$'` **hoặc** `p_migration_sha256 !~ '^[0-9a-f]{64}$'` **hoặc** thiếu
  `p_maintenance_window_id`/`p_approval_reference` ⇒ `RAISE … ERRCODE='22023'` *"ON/CANARY requires full
  release identity"* ⇒ **chuẩn bị giá trị thật trước cửa sổ bảo trì**. **ACL là `postgres=X/postgres` only —
  `service_role` bị TỪ CHỐI** ⇒ **không có đường nào trong app lật được route**; plan phải ghi **ai** chạy
  và **chạy bằng gì** (Management API/psql với role `postgres`) — đây **không** phải thứ chủ/kế toán bấm
  được. **`p_expected_config_version` phải đọc từ BẢNG `app_private.server_feature_flags`, KHÔNG từ
  `server_feature_flag_events`** — sổ event thiếu **7/28 cờ** có `config_version > 1` mà **zero event** (vì
  tiền lệ repo là flip bằng `UPDATE` thẳng trong migration).
  **[ADD] Enroll canary tường minh, DEMO only:**
  `INSERT INTO app_private.server_feature_flag_canary_orgs (feature_key, organization_id, added_by) VALUES
  ('special_fee.payment.v1', 'dddd0000-0000-4000-8000-000000000001', <actor>)` — **KHÔNG** enroll
  `aaaa0000-…0001`; rollback canary **phải DELETE** dòng enroll (tiền lệ
  `20260728150000_enable_non_cash_overpay_credit.sql:1015`). **Thứ tự: seed cờ TRƯỚC, enroll SAU.**
  `ON` là `CANONICAL`; `force_freeze=true` là `FROZEN` và phải chặn writer, **không** fallback legacy;
  rollback dùng CAS về `OFF`. `max_operation_count` đặt **rộng tay** (tiền lệ prod `2147483647`), và
  **`ends_at` KHÔNG có tác dụng sau khi ON** (`IF f.mode='ON' THEN RETURN 'CANONICAL'` đứng trước khối
  window) ⇒ phải chỉ định **ai chịu trách nhiệm theo dõi `ends_at`** trong suốt cohort.
- [ ] **Step 2b: [ADD] Freeze — chọn một, viết ra.** Xem Task 0 Step 2: **không hàm nào trong toàn DB ghi
  `force_freeze`**. Hoặc (A) ship `set_feature_freeze_v1` có CAS + `INSERT server_feature_flag_events` +
  REVOKE + vào `check-definer-acl`; hoặc (B) ghi thẳng rằng freeze là **UPDATE tay qua Management API** và
  bổ sung bước **lập biên bản**, vì UPDATE tay **không sinh event** và **không bump `config_version`**.
  **Không được tuyên bố "có runbook rollback" trước khi chọn xong.**
- [ ] **Step 3: [REORDER] Rehearse/apply exact order.** Disposable clone phải là **clone của production**
  (hoặc dựng từ prod dump — xem Task 0 Step 1.0) nên Đợt 0–6 **đã thường trú**. Nếu clone dựng bằng cách
  replay repo migrations thì **phải đưa 22 migration Đợt 0–6 (`20260730100000 → 20260730280000`) vào ĐẦU
  chuỗi**, theo đúng thứ tự đã apply trên prod; nếu không mang được thì **ghi thẳng** rằng rehearsal **không
  bao phủ** `a02_ie_profit_lock_*`, `trg_ie_check_lock_ins`, nhánh ANNOTATE của
  `guard_income_expense_owned_payload`, và `DO $guard$` của `20260730280000` — và phải có bộ test riêng chạy
  trên prod trong `BEGIN … ROLLBACK`.
  Thứ tự file của plan (đã đánh số lại): `20260731010000_special_page_runtime.sql` →
  `20260731010500_contract_transfer_audit_hardening.sql` → `20260731011000_room_residence_segments.sql` →
  `20260731012000_realtime_lifecycle_tables.sql` → `20260731020000_special_fee_schema.sql` → … →
  `20260731025000_special_fee_read_wrappers.sql`; writer route **OFF**. Chỉ sau rehearsal đầy đủ mới apply
  đúng những file đó lên production. Sau đó `npm run gen:types`,
  `node scripts/check-view-invoker.mjs`, `node scripts/check-stable-fn-locks.mjs`,
  `node scripts/check-permission-catalog.mjs`, và money reconcile.
  **[ADD] Preflight bắt buộc:** fail nếu **hai file nào trong `supabase/migrations/` trùng timestamp
  prefix** (cây làm việc hiện có hai cặp trùng ở `20260730230000` và `20260730240000`).
  **[ADD]** Mọi kiểm "đã apply chưa" dùng **catalog**, không dùng `schema_migrations` (§0.5 mục 3).
- [ ] **Step 4: [RETARGET] Shadow/canary — viết theo cặp stored-vs-evaluated.** `app_private.server_feature_flags`
  **không có cột `organization_id`** (PK = `feature_key`, 18 cột) ⇒ **"prod stored OFF + DEMO stored CANARY"
  là BẤT KHẢ**. Ở `CANARY`, stored mode của **MỌI** org đều là `'CANARY'`; org thật (không enroll) chỉ
  **evaluate** `LEGACY`. ⇒ **Xoá mọi assertion dạng "assert stored mode='OFF' cho production" trong lúc
  canary.**
  **Cảnh báo vận hành quan trọng:** flip `SHADOW → CANARY` đẩy org thật từ `SHADOW` về **`LEGACY`** ⇒ **mất
  telemetry shadow/parity của org thật đúng lúc cần nó nhất để quyết ON**. Tiền lệ: `invoice.collection.v5`
  chỉ có **85 phút** cửa sổ shadow production (event id=64 `SHADOW→CANARY` 2026-07-22 05:38:50 → id=68
  `CANARY→ON` 07:03:53; giữa hai mốc có 16 dòng ops `config_version=5`, toàn DEMO, 13.500.000đ). ⇒ **Thu đủ
  parity report TRƯỚC khi rời SHADOW**, hoặc tạo **key riêng** cho DEMO nếu cần shadow prod song song canary
  demo. Nếu cần hành vi per-org **lâu dài** thì theo tiền lệ `app_private.org_accounting_mode` — bảng đó
  sinh ra **chính vì** giới hạn này (`20260730110000_ie_accounting_standard_toggle.sql:8-13`).
  Stored CANARY cho DEMO chỉ bật sau owner publish config DRAFT→PUBLISHED và fixture cleanup.
- [ ] **Step 4b: [ADD] Seed fixture DEMO thành checklist CÓ TÊN — DEMO hiện KHÔNG diễn được họ nào của Plan 1.**
  Đo được: **0 dòng** `building_fee_accounts` ở DEMO; **2** `building_utility_accounts` với `provider_code`
  **NULL**; **0 phiếu `utility.bill` sống** (chỉ 2 dòng soft-deleted, chưa từng có phiếu EN thật);
  **không có type `'Quản Lý'`** ⇒ một khoản chi Quản Lý ở DEMO sẽ được ghi vào type **tiền lương**; và
  `special_fee_fixed_rule_versions` **rỗng ở cả hai org** cho tới khi chủ publish. ⇒ Không seed thì **mọi
  submit DEMO short-circuit ở `CONFIG_REQUIRED` và gate của slice chứng minh ZERO.** Checklist bắt buộc:
  21 dòng `building_fee_accounts` (hoặc rule version publish trực tiếp) + amount; **`provider_code` cho cả
  hai meter DEMO**; AC/washer standard + ceiling; utility ceiling + max ratio; Sale cap; `fallback_policy`
  hoa hồng; ít nhất một type `'Quản Lý'`. Tiền đề sổ quỹ thì **ổn**: DEMO có **6 sổ sống, 5 sổ có binding
  CUSTODIAN**. Mọi fixture chỉ ghi vào `dddd0000-0000-4000-8000-000000000001`, org thật **chỉ đọc**, và
  **tự dọn trong `finally`**.
- [ ] **Step 5: E2E sau deploy.** Chạy đúng URL deployed với env `FLEET_PASS_*`, **headless**; mọi fixture
  write chỉ ở org DEMO, org thật chỉ read, cleanup trong `finally`. Test: view-only vs collect permission
  (**cộng** ca thiếu `buildings.view` và ca **NGƯỢC** `demo.ketoan`), exact fixed, four-category multi-month,
  utility warning/zero denominator/null-meter denial, **utility `VALID_PENDING_APPROVAL` hiện nhãn "Chờ
  duyệt"**, broker day 6/day 7/signed deposit basis, Sale cap, AC/washer cadence, duplicate race, manager
  proposal + owner decision, owner self-created exception with reason, restricted Management denial,
  finalized evidence lineage, cross-org, traditional contract commission/batch `/thu-chi`, console errors.
  **[ADD] Hai spec ĐANG XANH là GATE, phải giữ xanh, KHÔNG viết lại:** `thanh-toan-page.spec.ts` (`:20`,
  `:27`, `:32` assert **cả hai** surface visible ở desktop; `:143` `toBeHidden()` ở mobile) và
  `utility-paste-receipt.spec.ts` (`:46-49` desktop paste, `:151-171` cross-surface, `:173`/`:183-184`
  `toHaveCount(1)`). Hợp đồng fleet đã xác minh: headless mặc định (`playwright.config.ts:15`),
  `FLEET_WORKERS` default 8 (`:10`), `FLEET_BASE_URL` default `https://ptcrm.vercel.app` (`:14`),
  `slowMo 350` **chỉ** khi `FLEET_HEADED` (`:16`); mật khẩu **chỉ** từ `FLEET_PASS_*` với throw tiếng Việt
  rõ ràng khi thiếu (`specs/auth.ts:19-23`, `:30-39`) — **không literal nào trong repo**. Không chạy headed
  nếu chủ không yêu cầu. ⚠ Cache có **cả `chromium-1217` và `chromium-1228`**; `@playwright/test 1.61.1`
  được pin nhưng **không gì xác minh** nó cần revision nào và **không có `postinstall`**.
- [ ] **Step 6: Rollback/freeze rehearsal.** CAS route về `OFF` để quay lại behavior legacy; `SHADOW` chỉ
  classify/compare rồi dùng legacy writer. Bật `force_freeze` **theo phương án đã chọn ở Step 2b** là
  emergency stop fail-closed cho money writer, **tuyệt đối không** rơi về legacy; read/reversal vẫn hoạt
  động. Không drop claim/posting, không sửa voucher đã posted. **[ADD]** Rollback canary phải **DELETE dòng
  enrollment**. **[ADD]** `claim_feature_operation_v1` lấy dòng cờ `FOR SHARE` còn `set_feature_route_v1`
  lấy `FOR UPDATE` ⇒ **không chạy `set_feature_route_v1` cùng lúc với batch writer** (chúng chặn nhau).
  **[ADD]** Ghi thẳng vào runbook: mọi tuyên bố *"rollback có kiểm toán"* hiện **không có tiền lệ thật** —
  7/28 cờ đổi `config_version` mà **zero event**.
- [ ] **Step 7: Final money/security gates.** `npm run typecheck:baseline`; targeted Vitest (**kèm assertion
  tồn tại file**, và điều kiện pass là **không có đỏ MỚI** so với baseline HEAD);
  `node scripts/test-special-page-runtime.mjs`, `test-special-fee-rules.mjs`, `test-special-fee-writer.mjs`,
  `test-special-fee-concurrency.mjs`; **`node scripts/check-stable-fn-locks.mjs` [ADD]**;
  **`node scripts/check-permission-catalog.mjs` [ADD]**; `node scripts/check-definer-acl.mjs` (**sau khi đã
  nới scope**); `node scripts/check-approver-provenance.mjs`; `node scripts/check-view-invoker.mjs`;
  `node scripts/reconcile-money.mjs 2026-07` (**pass = `exit 0`**) và `reconcile-money-v2.mjs 2026-07`;
  report parity `/bao-cao` và `/thu-chi`. **[DELETE] `check-technical-membership-isolation`** — không tồn
  tại và không còn deliverable để gác.
  **[ADD] Vì sao hai gate mới là bắt buộc:** `scripts/check-stable-fn-locks.mjs` tự khai *"GOTCHA đã có án
  lệ (5 lần)… CHẠY SAU MỌI MIGRATION TẠO/SỬA HÀM. Exit 1 nếu có hàm hở"* (`:4`, `:12`) với
  `20260730280000_stable_fn_row_lock_regression.sql` là án lệ sống — và nó **KHÔNG có CI coverage** ⇒ vắng
  nó là **zero backstop** cho đúng lớp bug đã giết `profit_close_state_v2` mười ngày;
  `scripts/check-permission-catalog.mjs` **đã là gate CI bắt buộc** (`.github/workflows/ci-gates.yml:135-138`,
  cần PAT), gác permission key vô hình (đo được **11 key thiếu** ngày 26/07). Cả hai **không xuất hiện** ở
  bất kỳ plan doc nào trong khi bốn gate cùng họ thì có.
  Sau khi mở production route theo cohort: giữ canary/monitor **≥ 24 giờ**, đối chiếu
  duplicate/orphan/money drift **theo `organization_id`**.

### Commit checkpoints

Mỗi task chỉ stage file của **chính task**, **không `git add -A`**, **không `git add .`**, và **không** kéo
theo working-tree changes của người dùng (3 file dirty + **3 file test untracked** — §2.1). Cây làm việc repo
này thường xuyên có hàng chục file dở dang từ phiên khác; gom nhầm chúng là lỗi nặng.

| Sau task | Commit message |
|---|---|
| **−1** | *(thuộc Slice −1, không thuộc plan này — xem `danh-gia…-v2.md §4`; commit riêng, push riêng, gate riêng)* |
| 0 | `chore(thu-tien): harden special-page rollout prerequisites` |
| 1 | `feat(thu-tien): chot typed rule contract cho phi dac biet` |
| 2–3 | `feat(db): add versioned special-fee rules and claims` |
| 4–5 | `feat(thu-tien): auto approve and post rule-valid payments` |
| 6 | `fix(thu-tien): reconcile claims across cancel and recurring writers` |
| 7 | `feat(thu-tien): migrate special fee UI to canonical writer` |
| 8 | `test(thu-tien): cover special payment rollout and isolation` |

**[RETARGET] Trailer:** bản 29/07 ghi `Co-Authored-By: Codex <noreply@openai.com>` (nó được viết bằng
Codex). Trailer phải khớp **công cụ thực thi thật**; `CLAUDE.md` của repo quy định
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Chỉ push sau gate của slice; nếu
remote diverged thì **dừng và báo**, không force-push/merge lịch sử ngoài scope. Push bằng
`git push origin HEAD:main` (nhánh local thường **không** phải `main`), sau khi
`git merge-base --is-ancestor origin/main HEAD` xanh.

### Definition of Done

- **Điều kiện tiên quyết:** mọi hàng **BLOCKED-BY** ở §0.3 đã xanh; hai file untracked ở §0.5 đã có quyết
  định của chủ; mọi migration thuộc dải `20260731xxxxxx`.
- Every normal special-page voucher is `APPROVED + POSTED` in one transaction, only in an open cashbook
  period (verified via `cashbook_closed_through_v1` + `assert_period_open_for_edit_v1`, three labelled
  codes), with audit/claim/evidence and source-aware posting provenance; manual wrapper stays `MANUAL`.
  **[ADD]** A rule-valid voucher at or above `ie_auto_approve_config.threshold` ends as
  `VALID_PENDING_APPROVAL` — `UNAPPROVED`, claim held, **no** posting, and **no** in-transaction assert of
  POSTED. The owner has signed off on this asymmetry (or on unifying `pay_period_fee`).
- **[ADD]** The active posting carries `source_kind='SPECIAL_PAGE_FEE'`, **never `LEGACY_BRIDGE`**, and there
  is exactly **one** `event_kind='POSTING'` row per voucher; the transition token carried
  `purpose='FINANCE_V2_LIFECYCLE'` (or the capability lived in `ie_flex_writer_xids`) for the whole window.
- **[ADD]** `dispatch_finance_decision_v2` returns **no `0A000`** for any decision in the new owner's
  `supported_decisions`; the regression suite exercises **both** the `42501` and the `0A000` path.
- **[ADD]** Every new SQL function of this plan — including every read RPC — is declared **VOLATILE**;
  `check-stable-fn-locks.mjs` is green.
- Fixed fees are exact; no tolerance or client `force` (`p_force` removed from the normal path, its two mount
  sites replaced); maintenance lower-than-standard is normal.
- Utility warnings post and expose complete comparison snapshot to owner/superadmin; no sensitive data leaks
  to staff. **[ADD]** The utility reader shows `UNAPPROVED` rows as **"Chờ duyệt"** and never as "chưa đóng".
- Normal slot uniqueness/cadence survives concurrent requests, cancellation, reversal, traditional item
  delete/reinsert and recurring generation. **[ADD]** Claim release is driven **primarily by the AFTER UPDATE
  trigger keyed on `deleted_at IS NULL → NOT NULL`**, not by an enumerated writer list; the enumeration is a
  second layer and is labelled *"danh sách tại thời điểm audit 30/07"*. `cancel_income_expense_flex_v1` (the
  default `/thu-chi` cancel path, live because both orgs are `strict_mode=false`),
  `reverse_invoice_collection_v5` and `app_private.cancel_collection_voucher_in_place_v1` are all covered.
- **[ADD]** `cancellable = NOT in_batch AND NOT is_income_expense_flow_owned(id)`; the nine trapped
  flow-owned vouchers — including production `PC2607096` — no longer show an enabled Huỷ button that returns
  an English `55000`.
- Exceptions are proposals until owner/superadmin decision; initial proposal occupies the BASE slot,
  supplemental is explicit fixed/utility-only, and broker/Sale never receive a hidden second voucher.
  **[ADD]** "Owner" resolves through exactly one definition — `special_fee_is_owner_or_superadmin_v1` built
  on `app_private.is_org_owner_v1` (hardened with `organizations.status='ACTIVE'` and a stable role key) —
  and the two-way test passes: STAFF-with-owner-role **is** owner, OWNER-without-owner-role **is not**.
- Four and only four fixed categories support advance child split. **[ADD]** The prepay-vs-`PROFIT_LOCKED`
  question is resolved in writing (option a, b or c of Task 4 Step 6) so a prepay child for a
  profit-locked month can still be released and the slot cannot be occupied forever.
- `/thu-chi` and traditional writers retain baseline workflow, proven by DB/E2E regression; the
  `owned by system flow` substring is preserved verbatim.
- Broker status/deposit/day failures are non-proposable hard blocks; only amount mismatch after eligibility
  may enter the exception flow. **[ADD]** `fallback_policy` is published before any tier version, with a
  SQL↔TS parity test and an affected-contract report, so the 22 contracts at 7–9 months do not silently move
  from `50% × rent` to `0`; and the owner has re-signed the reversal of the 2026-07-23 §12.7 decision before
  broker moves to auto `APPROVED+POSTED`.
- **[ADD]** `SALE_HOT_BONUS` is scoped and estimated as **new construction** on `/thanh-toan`, not as a
  migration of an existing surface.
- Preview/overview require `thu_tien.view` **plus** `buildings.view` per building; submit requires
  `thu_tien.collect` **plus** a separate `assert_cashbook_access_v2(...,'CUSTODIAN',...)`; undo requires
  `thu_tien.undo` **plus** `ie_visible_cashbook_ids_v1()` ("được nhìn sổ", per the owner's 30/07 decision) —
  owner-only data and cross-org/mixed arrays are enforced server-side.
- **[ADD]** The realtime prerequisite is met: an `ALTER PUBLICATION` migration published
  `contract_terminations`, `contract_transfers` and `building_utility_accounts` (verified = 3 rows); the four
  **existing** missing keys were added; `hubActive` is ref-counted with a two-consumer regression test;
  `channel.subscribe((status) => …)` logs `CHANNEL_ERROR`; and the three exact `toEqual` assertions were
  updated in lockstep without being loosened to `toContain`.
- **[ADD]** Auto-approved vouchers carry `system_source` on the voucher row itself, so
  `check-approver-provenance.mjs` stays green, and the resulting `[NOT_MANUAL]` on flex-cancel is asserted as
  desired fail-closed behaviour.
- **[ADD]** Evidence guards use the fingerprint definition chosen in Task 0 Step 2b; the word "hash" no
  longer appears where no content hash exists.
- **[ADD]** Idempotency short-circuits **before** `claim_feature_operation_v1`; an identical replay returns
  the existing voucher and never raises `23505`.
- Typecheck, pure + render-level tests, DB/concurrency tests, E2E, and the gate set of
  `danh-gia…-v2.md §9` (including the two added gates) pass before production route changes.
  `reconcile-money.mjs` pass is **`exit 0`**; `exit 3` is not a pass.
- **[ADD]** Nothing above may be reported as done from source reading alone: the audit that produced this
  plan ran **no browser/E2E**, so every UI claim in it rests on source lines + live data + tracked spec
  assertions. Per `CLAUDE.md`, a feature is only "xong" after verification **and** a real (headless) browser
  run.

---

## PHỤ LỤC THI HÀNH — cập nhật 01/08/2026 (đọc kèm `danh-gia…-v2.md §16-§18`)

Plan này là VĂN BẢN THIẾT KẾ; trạng thái thi hành thật ghi ở danh-gia v2. Tóm
tắt phần đã thành hiện thực khác/vượt so với văn bản:

- **Tự duyệt phí cố định ĐÃ CHẠY** theo kiến trúc GIẢN LƯỢC (danh-gia §16.4,
  §17.1): bảng giá `special_fee_price_versions` có phiên bản theo tháng, RỖNG
  lúc ra đời; máy kiểm `special_fee_rule_check_v1` (VALID / AMOUNT_MISMATCH /
  CONFIG_REQUIRED); adapter `special_fee_approve_and_post_v1` với token
  FINANCE_V2_LIFECYCLE. KHÔNG có rule-version/proposal/claim ledger như Task 2
  mô tả — các bảng đó chưa tồn tại và không còn là đường đã chọn.
- **Hoa hồng**: `commission_tier_versions` + `commission_autopay_check_v1`
  (4 điều kiện chủ chốt 31/07). CỐ Ý không fallback bậc gần nhất, không hợp nhất
  với `buildings.commission_tiers` (§17.3).
- **Thưởng Sale từ phiếu cọc**: `sale_bonus_claims` + cửa hẹp
  `SALE_BONUS_DEPOSIT` trên `trg_ie_commission_guard` (§17.2) — thay thế phần
  SALE_HOT_BONUS của Task 6.
- **Trần điện/nước + luật bảo trì**: `utility_ceiling_versions` /
  `maintenance_rule_versions` với `counts_history=false`, `enforcement=WARN`
  mặc định (§17.4).
- **UI /thanh-toan Task 7**: nay có thêm nhóm "Thanh lý & Cọc" — 3 sổ theo dõi
  (§18.2). Bảng Tổng quan LOẠI 3 family này (LEDGER_FAMILIES).
- **⚠ BẮT BUỘC cho mọi RPC mới của plan**: sự cố lẫn tổ chức 01/08 (§18.1) —
  RPC SECURITY DEFINER đi vòng qua RLS. Mọi hàm trả danh sách phải áp
  `app_private.building_org_visible_v1(building_id)` hoặc hai mệnh đề RLS tương
  đương. Đo bằng phép đối chứng "số hàm trả = số đọc thẳng bảng".
