# Hiện trạng đã xác minh của hệ thống `/thu-tien` — bản đo ngày 30/07/2026

> **Tài liệu này THAY THẾ toàn bộ mục §4 "Hiện trạng đã xác minh" của bản quyết định 29/07/2026**
> (`danh-gia-2-plan-thu-tien.md` §4.1 Luồng và UI, §4.2 Finance V2, §4.3 Số liệu live, §4.4 Function
> body quan trọng). Ở mọi chỗ tài liệu này và bản 29/07 nói khác nhau, **tài liệu này thắng**.
>
> Tài liệu này **KHÔNG** thay thế §3 (yêu cầu nghiệp vụ đã khóa) và §6 (invariant) của bản 29/07 —
> đó là ý chí nghiệp vụ của chủ, không phải số đo. Mọi thứ dưới đây là **hiện trạng**, không phải
> tuyên bố rằng bất kỳ phần nào của hai plan đã được code, apply hay test.

---

## 1. Mục đích và cách đọc

### 1.1 Đã kiểm cái gì, bằng cách nào

| Hạng mục | Nội dung |
|---|---|
| Phạm vi | 10 vùng: (0) bề mặt đọc `/deposits` + contract detail, (1) realtime hub + hạ tầng test/gate, (2) feature flag routing, (3) phân quyền/authz, (4) số liệu live vs số plan, (5) Finance V2 posting core, (6) UI/hooks `/thu-tien` + `/thanh-toan`, (7) Đợt 0–6 "thu chi linh hoạt" + xung đột migration, (8) legacy fee writer RPC + status reader, (9) dòng tiền thanh lý + hoàn cọc |
| Database | Production Supabase project **`tryymsxyyckgbrmmvozx`**, **chỉ SELECT/catalog** (`pg_proc`, `pg_class`, `pg_policies`, `pg_trigger`, `pg_constraint`, `pg_indexes`, `pg_publication_tables`, `information_schema`, `pg_get_functiondef`, `pg_get_triggerdef`) qua Management API |
| Repo | Branch `feat/thu-chi-dot5-6-20260729`, HEAD `678d4ab`; `git status`/`git log`/grep trên `src/`, `supabase/migrations/`, `scripts/`, `.e2e-fleet/` |
| Chạy thật | `npm run typecheck:baseline`, `node scripts/check-view-invoker.mjs`, `node scripts/check-definer-acl.mjs`, `npx vitest run` (toàn bộ), một vài vitest theo file |
| Cửa sổ đo | Sáng **30/07/2026**: loạt đo chính lúc **03:28 UTC**; các dòng "đo lại" ở §7 chạy **cùng ngày, muộn hơn** (ghi rõ ở từng dòng) |
| KHÔNG làm | Không DDL, không DML, không gọi bất kỳ money RPC, không apply migration, **không mở browser/E2E** |

Sau khi 10 vùng nộp kết quả, **63 phát hiện mức HIGH/BLOCKER được kiểm ngược đối kháng** bằng
truy vấn độc lập: **41 sống, 22 bị bác**. Các phát hiện bị bác nằm ở §9.9 và **không được sống lại**.

### 1.2 Ký hiệu truy vết

Mọi khẳng định trong tài liệu này đều truy được về một trong bốn nguồn:

| Ký hiệu | Nghĩa | Ví dụ |
|---|---|---|
| `[A<vùng>.V<n>]` | `audit-verify.json` → area `<vùng>` → `verified[n-1]` (claim của plan **được xác nhận đúng**) | `[A5.V3]` |
| `[A<vùng>.C<n>]` | `audit-verify.json` → area `<vùng>` → `contradictions[n-1]` (claim của plan **đã sai/cũ**) | `[A6.C1]` |
| `[A<vùng>.R<n>]` | `audit-verify.json` → area `<vùng>` → `newRisks[n-1]` (rủi ro **không plan nào phủ**) | `[A6.R1]` |
| `[X<vùng>.<n>]` | `audit-cross.json` → area `<vùng>` → `verdicts[n-1]` (phán quyết đối kháng; `correctedStatement` là câu chữ chuẩn) | `[X3.3]` |
| `C-*`, `D-REUSE-*`, `D<n>`, `E<n>`, `B<n>` | ID patch ổn định trong `synthesis.md` — dùng để các tài liệu v2 khác trích dẫn lại | `C-INFRA-1`, `D-REUSE-2`, `D9`, `E12` |
| `§7 (đo lại 30/07)` | Truy vấn SELECT do chính tài liệu này chạy lại trên prod, cùng ngày, muộn hơn loạt đo chính | — |

### 1.3 Cách dùng tài liệu này

- **Trước khi viết một task**: tra §3–§6 để biết file/hàm/RPC thật, đừng lấy từ plan 29/07.
- **Trước khi viết một con số vào gate**: tra §7. Nếu §7 ghi số khác plan, dùng số §7 và ghi rõ
  dạng `(plan 29/07 ghi 101/11 — số đo lại 30/07 là 200/31)`.
- **Trước khi viết một gate command**: tra §8. 13 script mà bản 29/07 §8 gọi tên **không tồn tại**.
- **Trước khi tuyên bố "đã phủ hết rủi ro"**: tra §9.

---

## 2. Kết luận một trang

| Chỉ số kiểm chứng | Số |
|---|---:|
| Claim của plan **vẫn đúng** (không cần churn) | **164** |
| Claim của plan **đã chết/đã cũ** (sai so với prod hoặc repo hôm nay) | **108** |
| Rủi ro **chưa có plan nào phủ** | **91** |
| Patch đề xuất từ 10 vùng | **123** |
| Phán quyết đối kháng trên nhóm HIGH/BLOCKER | **63** → 41 sống, 22 bị bác |

### Sự thật cấu trúc quan trọng nhất

**Bề mặt "đóng tiền" đã RỜI khỏi `/thu-tien` sang một route riêng `/thanh-toan`.**

- `src/pages/ThuTien.tsx` (406 dòng) **không còn** state `utility`, không còn import
  `PeriodFeePanel`/`PeriodFeeSheet`/`usePeriodFees`/`useUtilityBills`/`useCommissionVoucher`/
  `useMaintenanceBatch`. Dòng `:258-259` ghi thẳng: *"Đóng tiền" giờ là page riêng `/thanh-toan`
  (không còn overlay tại chỗ)* → `const openUtility = () => navigate('/thanh-toan');`
- Toàn bộ bề mặt phí nằm ở `src/pages/ThanhToan.tsx` (77 dòng): `:19-20` import, `:53`
  `<PeriodFeePanel>`, `:63` `<PeriodFeeSheet>`.
- `src/App.tsx:367` đăng ký `/thanh-toan` **gác bằng `thu_tien.collect`**; `:363` `/thu-tien`
  vẫn gác bằng `thu_tien.view`.

**Hệ quả**: mọi dòng "Modify `src/pages/ThuTien.tsx`" trong cả hai plan + decision record đang
trỏ **sai file**; và bất cứ dialog/panel mới gắn vào `ThuTien.tsx` sẽ nằm sau route gate `view`
thay vì `collect`. Nguồn: `[A6.C1]` (BLOCKER), `[A9.C5]`, `[X5.1]`, `[X9.5]`.

### Chín hệ quả kế tiếp, theo mức nghiêm trọng

1. **Hai bom hẹn giờ "ghi vô hình → bấm lại vô hạn"** đang lên nòng trên `/thanh-toan`: điện/nước
   (`pay_utility_bill` sinh UNAPPROVED khi ≥ ngưỡng 600.000đ của org thật, bảng chỉ đọc APPROVED,
   **không có bất kỳ chốt chống trùng nào**) và bảo trì (`ie_compat_insert_v2` ép UNAPPROVED,
   `get_period_maintenance` lọc APPROVED). `[A6.R1]`, `[A6.R2]`, `[X8.1]` — cả hai là BLOCKER.
2. **"Đã chi" ở khắp trang chỉ dựa `approval_status`**, không đọc `posting_status`/
   `active_posting_id_v2`. Bằng chứng sống: `PC2607005` 2.730.000đ APPROVED + UNPOSTED trên sổ
   thật đã hiện "Đã chi". `[A6.V5]`, `[A8.V9]`.
3. **`purpose` của `ie_transition_authorization` là công tắc tắt cầu a85, không phải metadata.**
   Adapter mới dùng `finance_v2_transition_owned_approval` (helper hiển nhiên nhất) sẽ để cầu a85
   tự sinh posting `LEGACY_BRIDGE` → **chi trùng bút toán**. `[X3.3]` giữ BLOCKER, `[A5.C3]`.
4. **`dispatch_finance_decision_v2` định tuyến theo `adapter_name`, không theo `flow_owner`**, với
   đúng 5 nhánh CASE và `ELSE RAISE 0A000`. Seed một adapter mới mà không sửa thân hàm = apply xanh,
   chết ở runtime. `[X3.4]`, `[A5.C4]`.
5. **Có BỐN writer tạo/đổi hồ sơ thanh lý**, không phải hai: `terminate_contract_move_out_impl`,
   `approve_contract_termination_v1`, `terminate_contract_forfeit_impl` (26/37 dòng), và một
   fallback **phía client** ghi thẳng REST rồi INSERT vào `public.cash_book` (bảng không tồn tại).
   `[X9.4]`, `[A9.R1]`, `C-TERM-1`.
6. **Catalog `thu_tien.view` KHÔNG đòi CASHBOOK** — `required_dimensions = {}`. Task "forward-correct"
   ở Slice 0 nhắm vào một lỗi không tồn tại và nếu làm sai chiều sẽ **thu hồi 24 cạnh ALLOW**.
   `[X4.1]`, `[X5.5]`, `[X6.4]`, `[X8.4]` → `E13`.
7. **Hai định nghĩa "chủ sở hữu" đang chạy song song**: prod dùng `is_org_owner_v1` khớp **chuỗi tên
   vai trò** `'Chủ sở hữu tổ chức'`; plan muốn `member_type='OWNER'`. Ở DEMO hai định nghĩa lệch
   (3 role-owner vs 1 member_type OWNER); ở org thật trùng nhau. `[X4.4]`, `D-REUSE-1`.
8. **Đợt 0–6 đã ship 3 lớp khoá mà cả hai plan không biết** (chốt sổ, bàn giao, chốt lợi nhuận) và
   plan chọn đúng vị ngữ kỳ **yếu nhất** (`finance_v2_is_cashbook_period_open`, hôm nay là no-op vì
   0/28 sổ có `lock_date`). `[X3.2]` hạ BLOCKER→MEDIUM: không rò tiền vì trigger chặn cứng P0001,
   nhưng sai chỗ đặt cổng và sai chất lượng lỗi. `[A7.R1]`, `D-REUSE-2` → `E4`.
9. **Cờ tính năng là toàn cục, không tách theo org**; không có hàm nào ghi `force_freeze`; và
   `set_feature_route_v1` chỉ `postgres` được EXECUTE. `C-ROLL-1`, `C-ROLL-2`, `[A2.C7]`, `[A2.R7]`.

---

## 3. Luồng hiện tại thật sự chạy thế nào

### 3.1 Route và cổng quyền

| Route | Page | Route gate | Bằng chứng |
|---|---|---|---|
| `/thu-tien` | `src/pages/ThuTien.tsx` (406 dòng) — **thu tiền khách theo phòng**: `BuildingPills`, `RoomCellGrid`, `CollectDrawer` (`:376`), `CollectionReport`, `HandoverSheet`, `ManagePanel` | `thu_tien.view` — `App.tsx:363` `<RequirePermission module="thu_tien">` + `RequirePermission.tsx:32` mặc định `action="view"` | `[A6.V12]`, `[X5.1]` |
| `/thanh-toan` | `src/pages/ThanhToan.tsx` (77 dòng) — **đóng tiền cho nhà cung cấp**: `PeriodFeePanel` (`:53`) + `PeriodFeeSheet` (`:63`) mount **đồng thời** | `thu_tien.collect` — `App.tsx:367` | `[A6.C1]`, `[A9.C5]` |
| `/deposits` | `src/pages/deposits/DepositsPage.tsx` | RLS `contract_terminations_select_rbac` → **`buildings.view`** qua `can_access_building(building_of_contract(contract_id))` | `[A0.C5]`, `C-DEP-10` |

`ThuTien.tsx` **không** phải trang chỉ-đọc: nó ghi phiếu thu của khách qua `CollectDrawer`, chỉ là
route gate ở mức `view` với từng nút gác riêng (`canRecordPayment`) — `[X5.1]` sửa lại điểm này.

**Double mount là CHỦ Ý, không phải bug**: `src/pages/thu-tien.css:439-444` cho `≥1024px` hiện grid
2 cột (`.tt-udesk` + `.tt-phone-col`); `<1024px` ẩn `.tt-udesk` bằng CSS nhưng **cả hai component
React vẫn mount** (`.e2e-fleet/specs/thanh-toan-page.spec.ts:143` dùng `toBeHidden()`, không phải
`toHaveCount(0)`). Spec `thanh-toan-page.spec.ts:27` và `:32` **assert cả hai đều visible** ở desktop
— hai plan không biết spec này tồn tại. `[A6.C3]`, `[X5.3]`.

### 3.2 Từng họ phí: route → component → hook → RPC → cách quyết "đã chi"

| Họ phí | Component sống | Hook orchestration | Writer RPC | Reader | "Đã chi" quyết bằng gì |
|---|---|---|---|---|---|
| **7 phí cố định GRID** (tien_nha, internet, quan_ly, ve_sinh, cong_an, rac, thang_may) | `PeriodFeePanel.tsx` (desktop) + `PeriodFeeSheet.tsx` (khung điện thoại) | `usePeriodFeeState.ts` (`doPay/submitPay/confirmPayDup` `:275-315`) → `usePeriodFees.ts:216` | `pay_period_fee` (11 arg, có `p_force`); **hardcode `'APPROVED'`** ở body `:132`, KHÔNG đọc ngưỡng | `get_period_fee_status` (4 arg) | `SUM(v.amount) FILTER (WHERE v.st='APPROVED')` — **không** đọc `posting_status` |
| **Điện / nước** | `UtilityEnContent.tsx` (embed trong `PeriodFeePanel:503-505`) + phần EN inline của `PeriodFeeSheet` (`:96`, `:177-193`) | `useUtilityPayState.ts` (`submitPay` `:189-209`) → `useUtilityBills.ts:238` | `pay_utility_bill` (10 arg); **đọc `app_private.ie_auto_approve_config`** → `UNAPPROVED` khi `p_amount >= threshold`; **0 chốt chống trùng** | `useUtilityBills.ts:304` | `.eq('approval_status','APPROVED')` → phiếu chờ duyệt **vô hình** |
| **Hoa hồng môi giới** | `PeriodCommissionModal.tsx` (`:76` hardcode `kind:'broker'`) | `useCommissionVoucher.ts:183` | `create_commission_voucher` (10 arg) — **luôn `UNAPPROVED`**, duyệt ở `/thu-chi` theo quyết định §12.7 ngày 23/07/2026 | `get_period_commissions` | `CASE WHEN voucher_id IS NULL THEN 'unpaid' WHEN approval_status='APPROVED' THEN 'paid' ELSE 'draft'` |
| **Thưởng nóng Sale** | **KHÔNG có trên trang này**. Chỉ `src/components/contracts/CommissionVoucherModal.tsx:198/:220` phát cả `'broker'` và `'sale'` | — | `create_commission_voucher` từ contract page | `get_period_commissions` **loại sale** (`commission_kind='broker' OR ...LIKE '%hoa hong%'`) | 7 phiếu sale APPROVED+POSTED, tất cả sinh từ contract page |
| **Bảo trì (máy lạnh / máy giặt)** | `PeriodFeePanel`/`PeriodFeeSheet` | `useMaintenanceBatch.ts` — `:36-46` **INSERT thẳng từ browser vào `income_expense_types`**; `:95-114` → `src/hooks/income-expenses/batch.ts:109-232` | `ie_compat_insert_v2` — **ép `approval_status='UNAPPROVED'`** bất kể số tiền | `get_period_maintenance` lọc `approval_status='APPROVED'` | Không bao giờ khớp → tab hiện *"Kỳ này chưa có phiếu bảo trì"* (`PeriodFeeSheet.tsx:525`) |
| **Phiếu nháp định kỳ** | `PeriodFeeVoucherList` trong hai surface | `usePeriodFees.ts:244` | `pay_draft_fee_voucher` (3 arg) — `:36-39` UPDATE `account_id` + `attachments` | `get_period_fee_status` | `approval_status` |
| **Sinh phiếu định kỳ (cron)** | — | `src/hooks/income-expenses/recurring.ts:42` (`generate_recurring_vouchers_v2`) | `generate_recurring_vouchers(NULL)` qua `run_recurring_vouchers_job`, cron `0 18 * * *`; auto-approve theo `repeat_auto_approve`, **bỏ qua ngưỡng tự duyệt**, copy `attachments` của cha, nuốt lỗi từng child | `get_period_fee_status` | `approval_status` |
| **Huỷ** | `PeriodFeeVoucherList` | `usePeriodFees.ts:261` / `useUtilityBills.ts:268` | `cancel_period_fee` / `cancel_utility_bill` — **chỉ soft-delete**, KHÔNG đổi `approval_status` | `get_period_fee_status:97` `cancellable = NOT in_batch` | — |

**Bốn legacy writer** mà nút trên trang gọi trực tiếp: `pay_period_fee`, `pay_utility_bill`,
`create_commission_voucher`, `pay_draft_fee_voucher` (`[A8.V4]`, `[A8.V13]` — cả 13 hàm liên quan
tồn tại live, **mỗi tên đúng một overload**, không ambiguity). Ngoài bốn nút đó còn **hai đường ghi
nữa** mà plan không xếp vào danh sách writer: `ie_compat_insert_v2` (bảo trì) và
`generate_recurring_vouchers` (cron) — `[A6.C12]`, `[A8.R10]`.

### 3.3 Backend nhóm này **không** dùng `thu_tien.*` chút nào

Không một trong 13 body legacy nào tham chiếu `'thu_tien'`. Read/write authz thực tế là:

- `public.can_access_building(building)` = `is_super_admin() OR app_private.can_v3('buildings.view', b)`
  — `get_period_fee_status:27-30`, `pay_period_fee:43-46`, `pay_utility_bill:33-34`,
  `cancel_period_fee:55-59`, `cancel_utility_bill:32-36`;
- `public.ie_all_buildings_scope` = `can_v3('income_expenses.all_buildings', b)`;
- chọn sổ quỹ: `accounts.user_id = auth.uid() OR is_admin() OR is_super_admin()` (**ngoài** mô hình
  CUSTODIAN của Đợt 5–6), và nhánh NULL còn **tự chọn sổ** theo `name LIKE '%Thu'`.

Nguồn: `[A8.V15]`, `[A8.R3]`, `[X8.4]`. Ngược lại `thu_tien.collect` **có** được dùng thật, nhưng ở
writer khác: `record_invoice_collection_v5` gọi 4 lần (building của hoá đơn, rồi từng account);
`thu_tien.undo` dùng bởi `reverse_invoice_collection_v5`, `can_reverse_collection_v1`,
`undo_invoice_payment_compat_v1`. `[A3.V1]`, `[A3.V2]`.

### 3.4 Ba khuyết tật đọc số đang sống trên trang

| ID | Khuyết tật | Bằng chứng |
|---|---|---|
| `C-READ-2` | `get_period_fee_status` lấy **`ie.total_amount` cả phiếu** cho *từng* hạng mục phiếu chạm tới → phiếu đa-hạng-mục cộng hai lần. Phiếu `5916661a-…` *"Tiền Điện + Tiền nước"* `total_amount = 6.384.000` (item dien 5.758.000 + nuoc 626.000) đóng góp **6.384.000 vào ô Điện VÀ 6.384.000 vào ô Nước** | `[A8.R1]` |
| `C-READ-1` | `fee_type_matches` khớp sai loại: `quan_ly` (`LIKE '%quan ly%'`) ăn cả `'Lương quản lý'` (org thật: 2 phiếu, **34.206.744đ**) và `'Ứng lương quản lý'`; `dien` ăn `'Mua tủ lạnh'` cat 'Điện' (3.424.000đ); `ve_sinh` ăn `'Vệ Sinh Phòng'` (620.000đ) + `'BTaskee'` (300.000đ); `rac` ăn `'Rửa thùng rác'` (60.000đ) + `'Bỏ rác'` (300.000đ). Ở DEMO **không có** type `'Quản Lý'` nên `resolve_fixed_expense_type('quan_ly')` sẽ chọn `'Lương quản lý'` | `[A6.R3]`, `[A8.R11]`, `[A8.R2]`, `[A6.R7]` |
| `C-READ-3` | Item thiếu `start_date`/`end_date` làm **cả reader lẫn chốt chống trùng đều mù**: tòa `cb6592d8-…` category `quan_ly` có **3 phiếu APPROVED cùng month = NULL** — một ô trùng ba mà không ai thấy | `[A8.R6]`, `D1` |

### 3.5 Hai chỗ lệch số giữa server và client

| Chỗ | Server | Client | Hệ quả |
|---|---|---|---|
| Bậc hoa hồng cho HĐ 7/8/9 tháng | `get_period_commissions` LATERAL có **fallback tầng trên**: `COALESCE(match trong khoảng, (SELECT rate WHERE months > max_months ORDER BY max_months DESC LIMIT 1))` → với `[{5,6,50},{10,12,60}]` và `months=7` trả **50%** | `useCommissionVoucher.ts:32-49` chỉ fallback khi `months > topTier.max_months` → trả **null → 0đ** | `/thanh-toan` hiện *"dự kiến 50% × tiền thuê"*, contract page prefill **0đ**, cho **22 hợp đồng** đang ở 7–9 tháng. `[A6.C6]`, `[X5.6]` |
| `building_fee_accounts.default_amount` | `pay_period_fee` **GHI ĐÈ** `default_amount = round(p_amount / GREATEST(v_months,1))` sau mỗi lần chi (`ON CONFLICT … DO UPDATE`) | UI hiện nó như "giá dự kiến" | "Giá dự kiến" là **ký ức của lần đóng gần nhất**, không phải cấu hình. Ví dụ tòa `1eae0e82…` `fee_category='dien'` `default_amount = 9.507.910` — một hoá đơn điện cũ. `[A6.C10]` |

### 3.6 Code chết dễ nhận lầm

`src/components/thu-tien/UtilityDesktopPanel.tsx` (21.515 B) và `UtilityBillSheet.tsx` (15.076 B) —
**36,6 KB, ZERO importer** trong `src/` và `.e2e-fleet/`; chỉ `UtilityEnContent.tsx:4` nhắc tên trong
comment. Cả hai plan liệt kê chúng là file cần sửa. `[A6.C4]`, `[A6.R11]`, `[X5.4]`.

Ngoài ra `src/hooks/useContracts.ts` còn export 3 hàm termination `@deprecated` với **zero call site**
(`useApproveTermination:1101`, `usePendingTerminations:1072`, `useRejectTermination:1213`) — xem §5.1
writer thứ tư. `[A0.R7]`.

---

## 4. Finance V2 — hiện trạng

### 4.1 Cầu a85 / a85b / a86 và công tắc token

| Trigger | Thời điểm | Việc | Nguồn |
|---|---|---|---|
| `a85_finance_v2_auto_posting_bridge` | `BEFORE INSERT OR UPDATE OF approval_status, account_id, total_amount, deleted_at ON public.income_expenses` | Tự sinh posting + dòng MAIN/CHANGE/ROUNDING, hoặc REVERSAL | `[A5.V4]`, `[A8.V10]` |
| `a85b_finance_v2_auto_posting_bridge_ins` | `AFTER INSERT ON public.income_expenses` | Post cho phiếu sinh ra đã APPROVED; **cuối thân hàm TỰ INSERT token `purpose='FINANCE_V2_LIFECYCLE'`** rồi UPDATE `active_posting_id_v2/posting_status='POSTED'` | `[A5.C10]`, `C-EV-3` |
| `a86_finance_v2_birth_provenance` | `BEFORE INSERT ON public.income_expenses` | `finance_v2_register_birth_v1(org, id, actor, 'BIRTH_BRIDGE', hash)`, set `birth_operation_id`/`birth_txid`; **`RAISE 23502`** *"Phiếu chờ duyệt thiếu organization (toà/sổ không xác định)"* nếu không suy được org | `[A5.C10]`, `C-EV-3` |

**Công tắc tắt cầu = `purpose` chính xác `'FINANCE_V2_LIFECYCLE'` tại `pg_current_xact_id()`**, và đó
là toàn bộ vấn đề:

- Bảng `app_private.ie_transition_authorization` có **PK là `income_expense_id` một mình** → đúng
  **một row mỗi phiếu**, không thể giữ hai `purpose` song song trong cùng transaction.
- Trigger `a00_ie_transition_token_upsert BEFORE INSERT` biến mọi INSERT thành UPDATE **ghi đè
  `purpose`** rồi `RETURN NULL` (nuốt INSERT, vô hiệu hoá cả `ON CONFLICT DO NOTHING` của caller).
- `finance_v2_transition_owned_approval(p_voucher, p_new_status, p_posting_status)` INSERT token với
  **`purpose = p_new_status`** (tức `'APPROVED'`/`'CANCELLED'`), rồi **DELETE token** ở cuối.
  `finance_v2_stamp_owned_posting_state` ghi `purpose='finance_v2.owned_posting_stamp'` rồi cũng DELETE.
- Chính guard có comment cảnh báo nguyên văn: *"KHÔNG mượn cột purpose của
  `ie_transition_authorization` vì cột đó bị các writer canon ghi đè và purpose FINANCE_V2_LIFECYCLE
  làm tắt cầu a85."*
- Cầu **đang bật thật**: cờ `income_expense.posting.v2` `mode='ON'`, `config_version=3`.
- Rác token: **213 row** còn sót với `xid` đã chết (209 `FINANCE_V2_LIFECYCLE`, 4
  `FINANCE_V2_BIRTH_BACKFILL`), không có job dọn.

Nguồn: `[A5.C3]`, `[X3.3]` (giữ BLOCKER), `[A5.V3]`, `[A5.V18]`, `[A5.R5]`, `[A9.V19]` → `E2`.

### 4.2 `dispatch_finance_decision_v2` — 5 nhánh adapter được nối dây

Đường đi: tra registry theo **`flow_owner`** (`IF NOT FOUND → RAISE 42501` *fail closed*) → kiểm
`supported_decisions` (55000) → kiểm `is_system_owned` (42501) → **`CASE v_adp.adapter_name`**:

```text
WHEN 'INVOICE_REFUND' | 'PROFIT_PAYOUT' | 'TERMINATION_FORFEIT_PAIR'
   | 'TERMINATION_MOVE_OUT_PAIR' | 'SALARY_BUNDLE'
ELSE RAISE EXCEPTION 'dispatch_finance_decision_v2: adapter % not wired for decision routing'
     USING ERRCODE = '0A000'
```

`app_private.finance_flow_owner_adapters` có **10 row**; hai row đã rơi vào `ELSE` **ngay hôm nay**:
`CANONICAL_INCOME_EXPENSE` và `UTILITY_RECURRING` (`is_system_owned=true`,
`adapter_name='CANONICAL_INCOME_EXPENSE'`) → đây là **failure mode đã chứng minh**, không phải giả
thuyết. Cả ba tài liệu plan có **0 lần** nhắc `dispatch_finance_decision_v2` và **0 lần** nhắc
`adapter_name`. `[A5.C4]`, `[X3.4]`, `[A5.V5]`, `[A5.V6]` → `E8`.

`TERMINATION_REFUND` trong registry trỏ `adapter_name='INVOICE_REFUND'`, `is_system_owned=true`,
`decision_scope='RESERVATION'`, đủ 5 decision. `[A5.V5]`, `[A7.V3]`, `[A9.V10]`.

`TERMINATION_MOVE_OUT_PAIR` là **slot adapter đã bị chiếm bởi hạ tầng chết**: hai bảng
`public.termination_move_out_authorizations` (11 cột, `state` default `'PLANNED'`) và
`termination_move_out_settlement_lines` (9 cột) đều **0 row**, và
`terminate_contract_move_out_impl` không bao giờ ghi vào chúng. `[A9.R6]`, `C-DEP-7`.

### 4.3 Freeze guard và allowlist

| Guard | Trigger | Nội dung |
|---|---|---|
| `app_private.guard_income_expense_owned_payload()` | `a00_ie_owned_payload_freeze BEFORE DELETE OR UPDATE ON public.income_expenses` | Allowlist **chỉ** gồm: `approval_status, posting_id, posted_at_v2, reversed_by_posting_id, updated_at, birth_operation_id, birth_txid, source_payload_hash, approved_by, approved_at, verified_at/by/by_name/note, review_state/version/reason, approval_version, posting_version, posting_status, posting_mode, active_posting_id_v2, cancellation_kind, deleted_at, approval_request_id, notes`. **`account_id` và `voucher_date` KHÔNG có trong allowlist** → `RAISE 55000` |
| `app_private.guard_income_expense_owned_items()` | `a00_ie_item_owned_payload_freeze BEFORE INSERT OR DELETE OR UPDATE ON public.income_expense_items` | **Đóng băng tuyệt đối**, không allowlist: mọi INSERT/UPDATE/DELETE trên phiếu flow-owned → `'items of canonical income expense % are frozen'` 55000 |
| Nhánh ngoại lệ **ANNOTATE** | `app_private.ie_flex_writer_xids` scope `'ANNOTATE'` | Cho phép đổi **`attachments` + `notes` + `updated_at`** trên **MỌI `flow_kind`**, kể cả phiếu đã POSTED — đây là quyết định #8 của chủ (Đợt 2). `CHECK ie_flex_writer_xids_scope_chk = ('ANNOTATE','FLEX_EDIT')` nhưng thân guard **chưa có nhánh nào cho `'FLEX_EDIT'`** |

Nguồn: `[A5.V9]`, `[A5.V10]`, `[A5.R6]`, `[A7.C7]`, `[X6.6]`, `D-REUSE-4` → `E9`.

**Census ownership hôm nay (179 row)** — `[A7.C12]`, §7 (đo lại 30/07):

| `flow_kind` | Số row |
|---|---:|
| `CANONICAL_INCOME_EXPENSE` | 164 |
| `INVOICE_COLLECTION_V5` | 9 |
| `INVOICE_COLLECTION_REVERSAL_V5` | 3 |
| `INVOICE_REFUND` | 3 |
| `TERMINATION_REFUND` | **0** |
| `TERMINATION_MOVE_OUT_PAIR` | **0** |

(plan/runbook Đợt 2 ghi *"172 phiếu flow-owned"* — số đo lại 30/07 là **179**, trong đó 164 là
`CANONICAL_INCOME_EXPENSE`.)

### 4.4 Evidence

| Sự thật | Số/bằng chứng |
|---|---|
| `public.finance_evidence_objects` | **159 row**: 142 `ATTACHED`, 11 `FINALIZED`, 6 `UPLOAD_INTENT` |
| `sha256` | **0/159 row có giá trị** |
| `upload_token_hash` | **0/159 row có giá trị** |
| `finalize_finance_evidence_v2` | Chỉ `UPDATE … SET state='FINALIZED', finalized_at=now(), byte_size=NULLIF(v_meta->>'size','')::bigint, mime_type=v_meta->>'mimetype'` — **không đụng `sha256`** |
| `income_expense_posting_evidence_relation_kind_check` | `CHECK (relation_kind = ANY (ARRAY['ORIGINAL','INHERITED_LEGACY_DELTA']))`; **142 row đều `'ORIGINAL'`** → thêm `INHERITED_BATCH` **thật sự cần** forward-update constraint |

Hệ quả `C-EV-1`: mọi guard/FK/so sánh dựa trên *"cùng hash evidence"* đang so **NULL với NULL** —
luôn thoả, tức bảo vệ giả. `[A5.C7]`, `[A5.V15]`, `[A7.V4]`, §7 (đo lại 30/07).

### 4.5 Posting core và posting lines

- `finance_v2_post_voucher_with_source_v1` **KHÔNG tồn tại** (`proname LIKE '%with_source%'` → 0 row;
  `LIKE '%special%'` → 0 row) — plan đúng, phải viết mới. `[A5.V1]`, `[A7.V5]`.
- `app_private.finance_v2_post_manual_voucher(p_ie income_expenses, p_actor_user, p_actor_membership,
  p_cashbook, p_posted_on, p_evidence_ids uuid[], p_idempotency_key) RETURNS uuid` — DEFINER,
  `search_path='pg_catalog, app_private, public'`, ACL `postgres=X/postgres`. Tham số đầu là **ROW**
  nên không dùng được làm public wrapper. `[A5.V2]`, `[A9.R5]`.
- Nó chỉ tạo **một dòng `MAIN`**, không tạo `CHANGE`/`ROUNDING` (cầu a85 thì tạo cả ba), và **không
  kiểm kỳ mở** — cổng kỳ nằm hoàn toàn ở 6 caller public. `[A5.R2]`, `[A5.R3]`, `C-EV-4`.
- `public.income_expense_posting_lines` = `{id, organization_id, posting_id, account_id, line_kind,
  signed_amount, created_at}` — **không có `room_id`/`contract_id`**; `CHECK line_kind IN
  ('MAIN','CHANGE','ROUNDING','REVERSAL')`, `CHECK signed_amount <> 0`. `[A5.V14]`, `[A9.V14]`.
- `income_expense_postings.source_kind` là **text tự do, không CHECK** → thêm `SPECIAL_PAGE_FEE`/
  `TERMINATION_REFUND` không cần đổi constraint. Census: `LEGACY_BACKFILL` **1710**, `MANUAL` **265**,
  `LEGACY_BRIDGE` **73**. `[A5.V20]`, §7 (đo lại 30/07).

### 4.6 Ba lớp khoá kỳ mà Đợt 0–6 đã ship

| Lớp | Cơ chế cưỡng chế | Dữ liệu thật hôm nay |
|---|---|---|
| **1. Chốt sổ quỹ** | `app_private.cashbook_closed_through_v1(cashbook)` = `GREATEST(max(cashbook_closures.closed_through), accounts.lock_date)`; trigger **vô điều kiện** `trg_ie_check_lock_ins/upd/del` → `income_expenses_check_lock()` (lặp mọi `(account, voucher_date)` kể cả sổ thối/làm tròn, `FOR KEY SHARE` trên accounts) và `a01_ie_posting_lines_check_lock` → `income_expense_posting_lines_check_lock()` (theo `posted_on`, hoặc `posted_on` của posting gốc khi `event_kind='REVERSAL'`); cùng ném `[CASHBOOK_CLOSED]` `P0001` | `app_private.cashbook_closures` = **0 row**; `cashbook_closure_requests` = **0 row**; `accounts` có `lock_date IS NOT NULL` = **0/28** ⇒ nhánh này **chỉ kiểm chứng được bằng fixture** |
| **2. Phiên bàn giao tiền mặt** | `trg_ie_handover_guard`; vế `[HANDOVER_LOCKED]` trong `assert_period_open_for_edit_v1` xét `public.cash_handovers` `status <> 'CANCELLED'` theo cả `handover_transfer_id` và `handover_id` | **7 phiên** `status <> 'CANCELLED'` — đang có hiệu lực thật |
| **3. Chốt lợi nhuận theo tháng** | Trigger `a02_ie_profit_lock_ins/upd/del` trên `income_expenses` + `a02_ie_items_profit_lock` trên `income_expense_items` → `public.income_expenses_check_profit_lock()` ném `[PROFIT_LOCKED]` `P0001`; áp cho phiếu TRONG KQKD (bất kể `system_source`) HOẶC phiếu ngoài KQKD do người dùng tạo (`system_source IS NULL`). Miễn trừ: `auth.uid() IS NULL`, `is_super_admin()`, `is_org_owner_v1()` | `public.profit_monthly` có **18 row `locked_at IS NOT NULL`**, **tất cả cùng một tháng `period_month = 2026-05`**, trên 18 toà — đang có hiệu lực thật |

Hai họ vị ngữ kỳ tồn tại **song song và không thay thế nhau được**:

| Vị ngữ | Kiểm gì | Caller |
|---|---|---|
| `app_private.finance_v2_is_cashbook_period_open(org, cashbook, posted_on)` | **CHỈ** `accounts.lock_date` → hôm nay là **no-op** (0 sổ có `lock_date`) | 6: `approve_and_post_income_expense_v2`, `post_approved_income_expense_v2`, `reverse_posted_income_expense_v2`, `post_salary_settlement_tranche_v2`, `finance_v2_reconcile_voucher_posting_v1`, `finance_v2_apply_voucher_delete_v1` |
| `app_private.assert_period_open_for_edit_v1(p_voucher uuid, p_action text)` | Ba nhánh `[CASHBOOK_CLOSED]` / `[HANDOVER_LOCKED]` / `[PROFIT_LOCKED]`; **cần voucher id nên không dùng được trước khi có row** | 4: `cancel_income_expense_flex_v1`, `can_flex_cancel_v1`, `check_voucher_period_open_v1`, `period_block_code_v1` |

Plan chọn cái **yếu**. `[X3.2]` hạ từ BLOCKER xuống MEDIUM với lý do: **không** rò tiền vào sổ đã
chốt/tháng đã chia, vì hai trigger bảng chặn cứng `P0001`; khuyết tật thật là **chỗ đặt cổng + chất
lượng lỗi** (pre-check báo OPEN rồi transaction chết sâu trong trigger). `[A5.C2]`, `[A7.R1]`,
`D-REUSE-2` → `E4`.

Lệch giữa đọc và ghi: trigger `income_expenses_check_profit_lock` **chặn cả** phiếu ngoài KQKD khi
`system_source IS NULL`, nhưng `assert_period_open_for_edit_v1` mục 3 vẫn
`IF COALESCE(v_row.business_result_accounting, true) THEN` → **miễn trừ** phiếu ngoài KQKD.
`[A7.R10]`.

### 4.7 Endpoint owned và guard cấp trên

- `public.decide_owned_income_expense_v2(p_voucher, p_decision, p_reason, p_idempotency_key)` —
  **GRANT EXECUTE cho `authenticated`**; chỉ nhận `approve|cancel` (khác → 22023); whitelist
  `flow IN ('INVOICE_REFUND','TERMINATION_REFUND')` (khác → 42501 *fail closed*); nhánh `cancel`
  **bắt buộc** có row `app_private.invoice_refund_reservations` `reservation_state='HELD'` trỏ đúng
  `refund_voucher_id`, không có → **`P0002`**; và từ chối khi `birth_txid = pg_current_xact_id()`.
  Client đã có đường tới đây: `statusMutations.ts:315-330` và `:352-367`. `[A5.V19]`, `[A5.C5]`, `[X3.5]`.
- `public.approve_and_post_income_expense_v2(input jsonb)` — đòi `income_expenses.approve` +
  `assert_cashbook_access_v2(..., 'CUSTODIAN', ...)`, và `assert_income_expense_flow_owner_v2(v,
  'CANONICAL_INCOME_EXPENSE')`. Sau khi post nó **stamp `account_id = v_cashbook` lên header** — mà
  `account_id` **không** nằm trong allowlist của freeze guard → lỗi 55000 tiềm ẩn, độc lập với hai
  plan. `[A5.V7]`, `[A5.V8]`, `[A5.R1]` → `E9`.
- 9 RPC public khác assert `'CANONICAL_INCOME_EXPENSE'`: `approve_income_expense_v2`,
  `post_approved_income_expense_v2`, `approve_and_post_income_expense_v2`,
  `reject_invalid_income_expense_v2`, `reverse_posted_income_expense_v2`,
  `cancel_unposted_income_expense_v2`, `withdraw_income_expense_v2`, `resubmit_income_expense_v2`,
  `cancel_income_expense_v1`. `[A9.C1]`.
- Frontend **không** đọc route, **không** đọc ownership: nó gọi RPC generic trước rồi bắt lỗi bằng
  **regex tiếng Anh** `/owned by system flow/i` (`financeV2Mutations.ts:46-48` dùng ở `:60`;
  `statusMutations.ts:315`, `:352`) để rơi sang dispatcher. Chuỗi khớp phát ra từ
  `assert_income_expense_flow_owner_v2:20`. `[A9.C3]`, `[X9.3]` (bác phần "chọn theo global route"),
  `D8`.

### 4.8 Terminal writer đã ship sau ngày viết plan

| Writer | ACL | Việc | Fail-closed với phiếu special? |
|---|---|---|---|
| `public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)` | `postgres=X` **+ `authenticated=X`** | set `approval_status='CANCELLED'`, gọi `assert_period_open_for_edit_v1`; định nghĩa `20260730140000_ie_flex_cancel.sql:119`, sau đó bị 4 migration Đợt khác sửa tiếp | Có — `assert_manual_voucher_v1` ném `[NOT_MANUAL]` khi `system_source IS NOT NULL` |
| `app_private.cancel_collection_voucher_in_place_v1(uuid,text,uuid,uuid)` | `postgres=X` **only** — helper riêng, chỉ gọi được từ trong `reverse_invoice_collection_v5` | huỷ tại chỗ phiếu thu; `20260730150000:325` | Không nợ coverage |
| `public.ie_compat_cancel_v2(uuid[],text)` | — | nay có cổng quyền + ghi `income_expense_cancellations`; chặn qua `ie_flow_system_owned_v2` (`20260730250000:111-174`) | Có |
| `public.reverse_invoice_collection_v5(uuid,date,text,text)` | — | đường huỷ-tại-chỗ Đợt 5 | — |

`[X3.6]` giữ HIGH nhưng chốt số là **hai** writer thật sự bị bỏ sót (`cancel_income_expense_flex_v1`
và `cancel_collection_voucher_in_place_v1`), không phải bốn: `ie_compat_cancel_v2` **đã** được plan
nêu tên, và `cancel_collection_voucher_in_place_v1` là private helper. `[A5.C6]`, `[A7.C8]` → `E10`.

Cả **hai org đang ở chế độ linh hoạt**: `app_private.org_accounting_mode` row mới nhất cho
`aaaa0000-…0001` là `id=1 strict_mode=false` (29/07 11:12), cho `dddd0000-…0001` là
`id=4 strict_mode=false` (29/07 11:26) → đường huỷ một-nhát của Đợt 4/5 **đang sống trên
production**. `[A7.R6]`, `C-INFRA-4`.

### 4.9 Migration untracked đang chờ và bẫy mẫu neo

**Hai file untracked TRÙNG timestamp với hai file tracked đã apply, và chưa lên prod:**

| File untracked | Trạng thái | Nguy hiểm |
|---|---|---|
| `supabase/migrations/20260730230000_annotate_evidence_protection.sql` (556 dòng) | **CHƯA apply** (xác minh: `app_private.ie_evidence_locked_v1`, `ie_notes_append_only_v1`, bảng `ie_annotate_idempotency` **không tồn tại** trên prod) | `:289` `CREATE OR REPLACE FUNCTION public.annotate_income_expense_v1(...)` **không có guard "đã vá thì bỏ qua"** → apply sau bản tracked đã chạy `20260730270000` (vá cùng hàm theo mẫu neo, đánh dấu *"TIỀN ĐÃ RỜI KÉT"*) sẽ **XOÁ SẠCH lớp bảo vệ bằng chứng** |
| `supabase/migrations/20260730240000_authz_remaining.sql` (WP2) | **CHƯA apply** (live `assert_period_open_for_edit_v1` md5 `961eb62484c1f14370708e0821135ac3` thiếu marker `WP2_PERIOD_ALL_THREE`; `app_private.cashbook_closures` không có cột `signed_by_super_admin`) | `:429-457` thêm **vế thứ 5 "KỲ DỊCH VỤ CỦA HẠNG MỤC"**: join `profit_monthly` trên `[date_trunc('month', LEAST(start_date,end_date)), date_trunc('month', GREATEST(...))]` với `locked_at IS NOT NULL` và `period_month <> tháng voucher_date` ⇒ `RAISE '[PROFIT_LOCKED] Phiếu có hạng mục thuộc kỳ %'` — **đúng hình dạng thiết kế "trả trước" của Plan 1** |

`C-INFRA-2`, `C-INFRA-3`, `[A7.R3]`, `[A7.R4]`, `[X1.6]`.

**Bẫy mẫu neo (`C-INFRA-1`, HIGH)**: Đợt 0–6 vá nhiều hàm dùng chung bằng mẫu
`pg_get_functiondef → position(neo) → replace → EXECUTE`, mỗi chỗ tự `RAISE 'DỪNG, không vá mù'` khi
mất neo. Hàm **có rủi ro** và nằm trong tầm sửa của hai plan:

| Hàm | Migration + neo |
|---|---|
| `ie_compat_update_pending_v2` | `20260730190000:36-83`, neo `v_meta_keys`/`v_money_keys` |
| `update_income_expense_quick` | `:91-115`, neo `notes = p_notes` |
| `assert_period_open_for_edit_v1` | `:179-211` (+ WP2 `:355`) |
| `assert_manual_voucher_v1` | `:213-237` |
| `can_reverse_collection_v1` + `reverse_invoice_collection_v5` | `20260730250000:30-104`, neo `RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn'` |
| `ie_compat_cancel_v2` | `:111-174`, neo `ie_flow_system_owned_v2` |
| `annotate_income_expense_v1` | `20260730270000:24` |
| `propose_cashbook_closing_v1` | `20260730210000:348-356`, neo `  IF p_counted_balance IS NULL THEN` |

**KHÔNG rủi ro** (đã xác minh là `CREATE OR REPLACE` trơn, không neo): `confirm_cashbook_closing_v1`
(`20260730170000:369`, `20260730210000:173`) và `cashbook_balance_as_of_v1` (`20260730170000:562`,
`20260730210000:63`) — đây là điểm mà một phát hiện HIGH đã **bị bác**, xem §9.9.
`[A7.R5]`, `[A7.C6]`.

---

## 5. Thanh lý / hoàn cọc — hiện trạng

### 5.1 BỐN writer tạo hoặc đổi hồ sơ thanh lý

Cả hai plan mô tả *"hai termination writers"*. Thực tế có bốn.

| # | Writer | Chuỗi gọi | Hành vi đã xác minh |
|---|---|---|---|
| **1** | `public.terminate_contract_move_out_impl(uuid,date,jsonb)` | `useContractOperations.ts:260` → `terminate_contract_move_out_with_credit_v1` (`:92-98`) → `terminate_contract_move_out` (`:155-161`) → `impl` | `:179-183` INSERT phiếu hoàn **RAW**: `account_id = NULL`, **không có cột `invoice_id`** (⇒ NULL), `approval_status='UNAPPROVED'`, `system_source='termination.refund'`, `total = v_refund_dep + v_refund_exc`, kèm `building_id/room_id/contract_id`. `:226-240` INSERT `contract_terminations` với `prorated_rent/prorated_days/prorated_services = 0` **mọi lần** (không phải nhánh) và bọc `EXCEPTION WHEN OTHERS THEN RAISE WARNING` ⇒ **nuốt lỗi audit**. `:235` hardcode `refund_method = 'TM'::payment_method`. |
| **2** | `public.approve_contract_termination_v1(uuid,text)` | Không có UI call site sống (xem #4) | `:65` `v_refund := coalesce(v_term.refund_amount, 0)` — lấy **cột GENERATED**. `:94-105` INSERT phiếu `UNAPPROVED`, `account_id=null`, **KHÔNG có cột `system_source`** ⇒ NULL. Correlation duy nhất là `left(v_term.id::text, 8)` trong description item. `:43-46` trả `noop:true, voucher_id:null` khi đã `COMPLETED`. Cùng UPDATE đặt `status='COMPLETED', refund_date = now()`. **Không có defining migration** dưới `supabase/migrations/` — chỉ `scripts/authz-prepared/t5_10_contract_termination_writers.sql` và `prod-snapshot/PS05_misc_remaining.sql` (body live giống hệt, 99/99 dòng). |
| **3** | `public.terminate_contract_forfeit_impl(uuid,date,jsonb)` | `terminate_contract_forfeit_with_credit_v1` → `terminate_contract_forfeit` → `impl` | INSERT `contract_terminations` với `termination_type='FORFEIT'`, `status='COMPLETED'`, `total_deposit = v_deposit`, `early_termination_fee = v_deposit`. **KHÔNG sinh phiếu hoàn** — chỉ cặp offset `EXPENSE` + revenue `INCOME` (`:168-184`). Audit insert cũng bọc `EXCEPTION WHEN OTHERS` (`:262-263`). Đây là **nhánh chiếm đa số**: 26/37 dòng. |
| **4** | Fallback **phía client** trong `useApproveTermination` | `src/hooks/useContracts.ts:1119` → `:1124` nếu là fallback signal thì tiếp → `:1126-1135` UPDATE `contract_terminations status='APPROVED'` → `:1137-1145` UPDATE `contracts status='TERMINATED'` → `:1147-1155` UPDATE `status='COMPLETED', refund_date=now()` → `:1159-1177` **INSERT INTO `public.cash_book`** | `SELECT to_regclass('public.cash_book')` → **NULL**, bảng không tồn tại. Không transaction ⇒ khi bước cuối vỡ thì termination đã COMPLETED và contract đã TERMINATED **mà không có phiếu tiền nào**. Hôm nay **zero call site** (grep chỉ thấy khai báo `:1101`), nhưng hàm + policy RLS `contract_terminations_update_rbac` vẫn còn sống. |

`[X9.4]` hạ writer #3 từ HIGH xuống **MEDIUM** và **bác 2 trong 3 impact**: FORFEIT không phải đường
hoàn tiền (không sinh refund voucher), và `DEPOSIT_FORFEIT_POSTED` **suy ra được** từ 8+8 phiếu
`termination.forfeit_offset` / `termination.forfeit_revenue` (31.000.000đ mỗi bên) mà
`statusMutations.ts:39-42` đã key sẵn. `[A9.C4]`, `[A9.R1]`, `C-TERM-1`.

`[A9.V11]` **ZERO DRIFT** giữa body live và 5 file baseline (normalized, bỏ comment/whitespace/case):
`with_credit_v1` 113/113, `terminate_contract_move_out` 160/160, `impl` 210/210,
`approve_contract_termination_v1` 99/99 (cả hai file snapshot), `transfer_room` 78/78.

**Đường gọi bỏ qua wrapper**: `public.terminate_contract_move_out` (route giữa) có
`proacl = postgres=X | authenticated=X | service_role=X` → client gọi thẳng được, **bỏ qua
idempotency key, payload hash và guard credit** vốn chỉ nằm ở wrapper (`:84-90`). Ngược lại `impl`
chỉ `postgres=X | service_role=X` — đã đóng đúng. `[A9.C13]`.

### 5.2 `refund_amount` là cột GENERATED

```text
contract_terminations.refund_amount  is_generated = ALWAYS (stored)
  = total_deposit − ( COALESCE(outstanding_debt,0) + COALESCE(prorated_rent,0)
                    + COALESCE(prorated_services,0) + COALESCE(early_termination_fee,0)
                    + COALESCE(notice_violation_fee,0) + COALESCE(damage_fee,0)
                    + COALESCE(cleaning_fee,0) + COALESCE(other_fees,0) )
```

- `total_deductions` **cũng** là GENERATED; `total_deposit` **không**.
- Có thể **ÂM**: min đo được **−10.590.180,64** (termination `2731f528`, HĐ `HD-2026-00257`).
- 18/35 dòng `COMPLETED` là âm; tổng nhóm `COMPLETED` = **−66.207.315,35**.
- `CHECK terminations_refund_method_required_if_refund`: `refund_amount <= 0 OR refund_method IS NOT NULL`
  ⇒ emitter canonical **buộc phải đặt `refund_method` tại birth**, trước khi biết sổ quỹ. Writer hiện
  tại né bằng hardcode `'TM'`. `[X9.6]` **bác** phần "mâu thuẫn lời hứa manager chọn phương thức"
  (không plan nào hứa vậy) nhưng giữ yêu cầu: emitter phải set field này, nếu không **`23514`**.
- **KHÔNG có** cột `building_id`/`room_id` trên `contract_terminations` (33 cột) → "snapshot
  building_id/room_id" không thể lấy từ bảng đó. Nhưng **snapshot theo phiếu ĐÃ tồn tại và đã đầy**:
  `terminate_contract_move_out_impl` INSERT `income_expenses (… building_id, room_id, contract_id …)`
  và **20/20 phiếu hoàn có `building_id`/`room_id` non-null**, `ie.room_id = c.room_id` đúng **20/20**.
- `UNIQUE INDEX idx_terminations_unique_contract ON public.contract_terminations (contract_id)` tồn tại;
  hiện có **2 hợp đồng ACTIVE đã mang dòng termination**: `f81a454c…` `PENDING_APPROVAL` 50.000 trên
  contract `8b564ddf…`, và `369047fe…` `DRAFT` 30.000 trên contract `f7affb2a…` — cả hai đã có
  `refund_method='TM'`.

Nguồn: `[A0.V2]`, `[A0.V5]`, `[A4.V11]`, `[A9.V1]`, `[A9.C6]`, `[A9.C7]`, `[A0.C4]`, `[X7.6]`.

### 5.3 Hai đường đổi phòng

| Đường | Kích hoạt | Ghi gì | Dữ liệu hôm nay |
|---|---|---|---|
| **A — `public.transfer_room`** | Gọi trực tiếp | `:61-70` `UPDATE contracts SET room_id = p_new_room_id`; `:88-100` `BEGIN INSERT INTO contract_transfers (… 'COMPLETED', NOW()); EXCEPTION WHEN OTHERS THEN NULL;` (audit best-effort); `:16-19` SELECT contract **không có `FOR UPDATE`**. Comment `:87` ghi rõ đặt `status='COMPLETED'` để **KHÔNG kích** trigger đường B | **3/3 dòng** `contract_transfers` đi đường này: đều `ROOM_CHANGE` + `COMPLETED`, đủ `old_room_id`, `new_room_id`, `move_out_date`, `move_in_date` |
| **B — trigger `trigger_apply_contract_transfer`** | `BEFORE UPDATE OF status ON public.contract_transfers`, khi `OLD.status='DRAFT' AND NEW.status='APPROVED'` | `apply_contract_transfer():17-27` `UPDATE contracts SET room_id=COALESCE(NEW.new_room_id, room_id), start_date=COALESCE(NEW.new_start_date, start_date), end_date=…, status='TRANSFERRED', parent_contract_id=id` — **ghi đè cả `start_date`/`end_date`** | **0 dòng** ở `status='APPROVED'`, nhưng đường code còn sống và RLS cho UPDATE với `contracts.edit` |

Hệ quả cho Plan 2: Task 0 Step 3 chỉ đọc transfer `status='COMPLETED'` → **bỏ qua hoàn toàn đường B**;
Task 0 Step 4 lại lấy `contracts.start_date` làm mốc segment đầu — **đúng cột trigger B ghi đè**.
`[A9.R3]` (HIGH), `[A9.V8]`, `[A4.C10]`.

**Chưa có lịch sử phòng nào bị mất**: chỉ 2 hợp đồng có hoá đơn trỏ `room_id` khác `contracts.room_id`
và **cả hai đều có** dòng `contract_transfers`; chỉ 1 hợp đồng (`50d8f93a-…`) có hoá đơn trải 2 phòng
và nó **có** dòng transfer. `BOTH_CHANGE` = **0 dòng ở mọi nơi**. `[A4.V23]`, `[A4.C10]`.

### 5.4 Guard regex trên `payments`

`CREATE TRIGGER a10_payment_termination_non_cash BEFORE INSERT ON public.payments FOR EACH ROW
EXECUTE FUNCTION app_private.classify_termination_payment_v1()`:

- `:15-16` nhận diện move-out bằng regex trên `notes`:
  `^Quyết toán khi thanh lý [0-9]{2}/[0-9]{2}/[0-9]{4}( \(cấn cọc\))?$`;
  `:18-23` regex trên `notes` để lấy uuid phiếu forfeit.
- `:27-29` `IF NOT v_is_move_out AND NOT v_is_forfeit THEN RETURN NEW;` — **bỏ qua toàn bộ kiểm tra**.
- `:38-42` `RAISE 55000` nếu khớp mà không phải core writer.
- `:67-105` đòi JOIN `app_private.termination_move_out_writer_context` theo
  `txid_current() + pg_backend_pid()`, `NEW.payment_date = context_row.move_out_date`,
  `NEW.amount <= invoice remaining`.
- `:148-151` zero hoá `received/credit/change/rounding`.
- Chuỗi note được sinh ở `terminate_contract_move_out_impl:148`:
  `'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY')`. Context mở/đóng ở
  `terminate_contract_move_out:139-152` và `:172-174`.

**Cả hai plan không nhắc function này, trigger này, hay bảng context.** Nếu emitter canonical đổi
chuỗi note hoặc tạo `payments` ngoài cửa sổ context thì guard rơi vào `RETURN NEW` (không kiểm gì) hoặc
`55000`. `[A9.R4]` (HIGH), `[A9.C11]`.

### 5.5 Hàng nguồn không được bảo vệ

`pg_policies`: `contract_terminations_update_rbac`, `cmd=UPDATE`, `roles={public}`, `qual` = `with_check`
= `is_super_admin() OR building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.edit'))`
— **không ràng buộc cột, không guard trigger** nào chặn sửa input quyết toán sau `COMPLETED`. Trigger
duy nhất trên UPDATE là `auto_calculate_termination_financials` (chỉ điền khi NULL) và
`update_contract_on_termination_approved:7-18` (tự set `contracts.status='TERMINATED'` khi
`status → 'APPROVED'`).

⇒ Bất kỳ ai có `contracts.edit` trên toà đều đổi được `outstanding_debt`/`total_deposit`/
`early_termination_fee` qua REST và do đó **đổi luôn `refund_amount` GENERATED**. Snapshot "bất biến"
của plan chỉ bảo vệ phiếu, **không** bảo vệ hàng nguồn. `[A9.R2]` (HIGH).

Cửa sổ mutable trước duyệt **đã xảy ra thật**: phiếu `975a5afb-…` (`PC2607153`, `termination.refund`,
UNAPPROVED, 3.509.500) có `created_at = 2026-07-27 05:11:18.077681+00`,
`updated_at = 2026-07-27 05:14:33.929716+00`, `account_id` hiện `df6b5925-…` trong khi writer sinh ra
với NULL. Và 5/20 phiếu hoàn có `invoice_id` **không NULL** dù writer không bao giờ set.
`[A9.V4]`, `[A9.V5]`.

### 5.6 Correlation hồ sơ ↔ phiếu: không có khoá nào

- `income_expenses` **không có** cột `termination_id`; **không có** FK `contract_terminations → voucher`
  ở bất kỳ đâu trong schema.
- **16/20** phiếu `system_source='termination.refund'` không tra được termination nào theo
  `(organization_id, contract_id)`; cùng 4 phiếu đó là 4 phiếu duy nhất mang prefix note
  `[HOÀN KHÁCH THANH LÝ]`.
- **2 hợp đồng mang 2 phiếu hoàn cùng số tiền** (một POSTED, một CANCELLED): contract `a1584980-…`
  có `PC2606049` APPROVED+POSTED 2.797.000 và `PC2606050` CANCELLED 2.797.000; contract `aa16a805-…`
  có `PC2607074` POSTED 3.127.400 và `PC2607073` CANCELLED 3.127.400 ⇒ mọi reader correlate theo
  `contract_id` sẽ trả **2 row cho 1 hồ sơ**.
- `contract_deposit_links` chỉ có **5 dòng** và **không có cột amount** (chỉ
  `id/org/contract/income_expense_id/link_source/linked_by/linked_at`).
- `app_private.invoice_refund_reservations` **không dùng được** cho hoàn cọc: `invoice_id` là
  `NOT NULL`, `reserve_invoice_refund_obligation_v2:38-41` `SELECT … FROM public.invoices … FOR UPDATE`
  + `IF NOT FOUND THEN RAISE P0002`, `:42` `v_refundable := COALESCE(v_inv.paid_amount,0)`,
  `:49-52` `IF v_live + p_amount > v_refundable THEN RAISE 55000`.
- **Nhưng** `reserve_invoice_refund_obligation_v2:80-82` đã có nhánh lai:
  `CASE WHEN COALESCE(p_system_source,'invoice.refund') = 'termination.refund' THEN 'TERMINATION_REFUND'
  ELSE 'INVOICE_REFUND' END` cho `flow_kind`, trong khi `lifecycle_owner` **hardcode `'INVOICE_REFUND'`**
  → đúng loại lai mà Plan 2 muốn cấm; chưa hiện thực hoá (0 row `TERMINATION_REFUND`) và entrypoint
  public duy nhất `create_invoice_refund_obligation_v2` hardcode `p_system_source='invoice.refund'`.

Nguồn: `[A0.V7]`, `[A0.V8]`, `[A0.R3]`, `[A4.V20]`, `[A9.V9]`, `[A9.V13]`, `[A9.R8]`, `C-DEP-8`.

### 5.7 UI đang đọc gì (bốn bề mặt, không phải hai)

| Bề mặt | File:dòng | Quy tắc thật |
|---|---|---|
| Bảng "Hoàn / Bỏ cọc" trên `/deposits` | `useDepositDashboard.ts:244` select, `:280` `refund_amount: Number(t.refund_amount) \|\| 0`, **`:282` `refund_done: !!t.refund_date OR t.status === 'COMPLETED'`**; render `DepositsPage.tsx:485` `) : r.refund_done ? (` → tick xanh, `:488` `formatCurrency(Math.max(0, r.refund_amount))` | Quy tắc **KHÔNG** nằm trong `DepositsPage.tsx` như plan viết, và **KHÔNG** chỉ là `status='COMPLETED'` — nó là OR hai vế; `refund_date` do **cùng một UPDATE** đặt cùng lúc với COMPLETED. `[A0.C1]` (HIGH), `[X0.1]` **bác** phần "single clause, single file" |
| **Ô KPI "Đã hoàn cọc"** đầu trang | `DepositsPage.tsx:272-277` ← `:170-171` ← `:125` `useRefundForfeitSummary(buildingIds)` ← `useDepositDashboard.ts:64` `rpc('get_refund_forfeit_summary')` | Hàm SQL riêng, `LANGUAGE sql STABLE SET search_path TO 'public'`, **KHÔNG SECURITY DEFINER** (⇒ RLS scope theo tenant): `SUM(GREATEST(0, ra)) FILTER (WHERE tt <> 'FORFEIT')` **không lọc status, không lọc posting**, đếm cả DRAFT/PENDING_APPROVAL là "lần". **Cả ba tài liệu plan không nhắc RPC này**. `[A0.C3]`, `[X0.3]` **SỐNG** |
| Ô "Quyết toán thanh lý" trong chi tiết HĐ | `ContractSummary.tsx:100-108` nhãn `'Hoàn lại khách:'` + `Math.max(Number(terminationInfo.refund_amount), 0)`; nguồn `useContractDetailData.ts:93-100` | Trình bày `refund_amount` GENERATED như số phải trả. `[A0.V4]`, `[A9.V15]` |
| Cảnh báo "Phiếu thanh lý chờ xử lý" | `useContractDetailData.ts:57-70` `base().like("notes", "[HOÀN KHÁCH THANH LÝ]%")` + **`:62` `.eq("approval_status","UNAPPROVED")`**; render `ContractSummary.tsx:140-165` | Nhận ra **4/20** phiếu hoàn, và chỉ phiếu chờ duyệt ⇒ phiếu **đã duyệt mà chưa vào sổ không cảnh báo ở đâu cả**. Plan không nêu hook này. `[A0.C6]` |

Thêm: `useContractTerminationInfo` (`useContractDetailData.ts:97-100`) lấy dòng termination **mới nhất
không lọc status** (`.order("created_at", desc).limit(1)`) → một DRAFT sinh sau sẽ ghi đè settlement
đang hiện. Hôm nay latent vì `GROUP BY contract_id HAVING count(*)>1` = 0 row (37 termination / 37 HĐ
khác nhau). `[A0.R5]`.

`useDepositDashboard` **đã** cap-1000-safe (`:239-261` `fetchAllRows` với
`.order('termination_date').order('id').range(from,to)`) và **đã** được realtime wire cho
`["deposit-dashboard"]` dưới cả `income_expenses` (`:127`) và `contracts` (`:170`) ⇒ phần chunking của
plan là **additive, không phải corrective**. `[A0.V13]`.

Nhưng `contract_terminations` và `contract_transfers` **KHÔNG nằm trong publication
`supabase_realtime`** (21 rel, `puballtables=false`) ⇒ đổi trạng thái thanh lý **không** invalidate
dashboard ở session khác. `[A0.R6]`, `[A1.V4]`, `[A9.C12]`, `[A7.C10]` → `B25`.

---

## 6. Phân quyền — hiện trạng

### 6.1 Bốn khoá `thu_tien.*` và hình dạng catalog THẬT

Cả bốn khoá tồn tại, `is_active=true`, và **hình dạng giống nhau đến từng byte**:

| Khoá | `scope_kinds` | `required_dimensions` | `requires_cashbook_possession` | `accepted_possession_kinds` | `scope_match_mode` | `sensitivity` |
|---|---|---|---|---|---|---|
| `thu_tien.view` | `{ORGANIZATION, AREA, BUILDING, CASHBOOK}` | **`{}` (rỗng)** | `false` | `{}` | `ANY_MATCH` | `VIEW` |
| `thu_tien.collect` | y hệt | **`{}`** | `false` | `{}` | `ANY_MATCH` | `MANAGE` |
| `thu_tien.undo` | y hệt | **`{}`** | `false` | `{}` | `ANY_MATCH` | `MANAGE` |
| `thu_tien.report` | y hệt | **`{}`** | `false` | `{}` | `ANY_MATCH` | — |

**`CASHBOOK` chỉ nằm trong `scope_kinds`** — là danh sách LOẠI phạm vi một grant **ĐƯỢC PHÉP** dùng,
không phải chiều **BẮT BUỘC** phải truyền. Plan lẫn hai cột khác nhau của cùng một bảng.

Toàn catalog có **223 khoá**, chỉ **9 khoá** có `required_dimensions` khác rỗng:
`cashbooks.manage_custody`, `cashbooks.post` = `{CASHBOOK}`; `income_expenses.approve/cancel/create/edit`,
`network_center.execute/view`, `reports_finance.analysis` = `{BUILDING}`. Đối chiếu: `cashbooks.post`
**thật sự** có `required_dimensions={CASHBOOK}` + `requires_cashbook_possession=true` + `scope_kinds={CASHBOOK}`.
(bản audit thô ghi 219 khoá — số đo lại là **223**.)

Chứng minh ngược: comment trong `app_private.authorized_scope_v3:209-212` ghi rõ *"quyền khai
`required_dimensions=['CASHBOOK']` (vd `cashbooks.post`) thì MỌI câu hỏi phải kèm sổ quỹ … bản ĐỌC phải
trả rỗng cho trục toà"*, và CTE `eff_b:217` có điều kiện `and not r.needs_cashbook` — nếu `thu_tien.view`
thật sự khai CASHBOOK thì `building_ids` trả **RỖNG** và 18 binding BUILDING của role "Quản Lý Tòa"
(org `aaaa`) đã không đọc được gì trên `/thu-tien` từ lâu.

**Phân bố grant, đo theo hai đơn vị khác nhau (D3 — không phải xung đột, khác đơn vị):**

| Đơn vị đo | Số |
|---|---:|
| Cạnh scope kiểu `CASHBOOK` cho `thu_tien.view` | **24** |
| Binding **chỉ** có scope CASHBOOK (`cashbook_only`) | **0** |
| Binding có CASHBOOK **và** loại khác (`cashbook_and_other`) | **2** |
| Binding scoped **không** CASHBOOK (`scoped_no_cashbook`) | **67** |
| Binding không scope, cấp org (`unscoped_org_wide`) | **4** |
| **Tổng binding** | **73** |

`.collect/.report/.undo` có **cùng** phân bố 24/18/2 ⇒ **giết luôn** giả định bất đối xứng của plan
("view khai sai, collect đúng"). Bỏ `CASHBOOK` khỏi `scope_kinds` là **thu hồi tới 24 cạnh ALLOW**
(`authorize_tenant_action_v3:147/164` đòi `e.scope_type = any(pd.scope_kinds)`;
`authorized_scope_v3` CTE `allow_c:151-152` đòi `'CASHBOOK' = any(pd.scope_kinds)`), **không có upside
nghiệp vụ nào**, và hôm nay **không ai mất quyền** nếu để nguyên.

Nguồn: `[A0.C7]`, `[A3.C1]` (BLOCKER), `[A6.C5]`, `[A7.C4]`, `[A8.C4]`, `[A9.C9]`, `[X4.1]`, `[X5.5]`,
`[X6.4]` (sửa `other_only=62` → `scoped_no_cashbook=67 + unscoped_org_wide=4`), `[X8.4]` → `E13`.

`[X6.4]` lưu thêm một chi tiết quan trọng: `buildings.view` có `scope_kinds = {ORGANIZATION, AREA,
BUILDING}` — **không có CASHBOOK** ⇒ một cạnh chỉ-CASHBOOK **thoả** `thu_tien.view` nhưng vẫn **fail**
`can_access_building`. Lệch scope thật là **giữa `thu_tien.*` và `buildings.view`**, không phải
"thiếu yêu cầu CASHBOOK trên `thu_tien.view`".

### 6.2 Hai định nghĩa "chủ sở hữu" đang chạy song song

| Định nghĩa | Ở đâu | Kiểm gì |
|---|---|---|
| **Prod đang dùng**: `app_private.is_org_owner_v1(p_org, p_user)` | DEFINER/STABLE, md5 `03fcc913c26c18d3f9db0dae3c594bf3`; định nghĩa `20260730190000_plan_hardening_wave1.sql:125-149` | `JOIN public.organization_roles r ON r.id = rb.role_id AND r.name = 'Chủ sở hữu tổ chức'` — **khớp CHUỖI TÊN tiếng Việt**, trong thân hàm **không có chữ `member_type` nào**. Kiểm `m.status='ACTIVE' AND COALESCE(m.valid_from,'-infinity')<=now() AND (m.valid_to IS NULL OR m.valid_to>now())` **và** cửa sổ hiệu lực của **chính binding** (`rb.valid_from/valid_to`, comment: *"đây là cách duy nhất repo thu hồi vai trò"*). **KHÔNG kiểm `organizations.status`** |
| **Plan muốn**: `member_type='OWNER'` | `danh-gia:42`, `special-payment:21`, và operationally `special-payment:169` (`special_fee_is_owner_or_superadmin_v1`) | `organization_memberships.member_type='OWNER'` |

**Kết quả khác nhau trên dữ liệu thật:**

| Org | Role `'Chủ sở hữu tổ chức'` (active binding) | `member_type='OWNER'` | Kết luận |
|---|---|---|---|
| `dddd0000-…0001` (DEMO) | **3 người**: `demo.quanly` (`member_type=STAFF`), `demo.chunha` (`OWNER`), `nguyentamca165` (`STAFF`) | **1** (`demo.chunha`) | **LỆCH**. Oracle call: `is_org_owner_v1('dddd…', demo.quanly) = true` trong khi `member_type='OWNER'` = false ⇒ theo plan, **2/3 "chủ" ở DEMO mất quyền duyệt ngoại lệ** dù `/thu-chi` vẫn coi họ là chủ, và E2E chạy bằng `demo.quanly` sẽ đỏ không rõ nguyên nhân |
| `aaaa0000-…0001` (thật) | **1** binding (`nguyentamca165`) | **1** row (`nguyentamca165`, ACTIVE, `valid_to` NULL) | **TRÙNG NHAU** |

`[X4.4]` **sửa một số liệu của phát hiện gốc**: org `aaaa` có **MỘT** row `member_type='OWNER'`, không
phải hai — con số "2" là **tổng hai org** (mỗi org một row) bị gán nhầm cho `aaaa`. Vậy độ lệch là
**một chiều** (role-owner ⊋ member_type owner) và **chỉ ở DEMO**.

`[A3.R3]` (HIGH): vì nhận diện bằng **chuỗi tên**, đổi tên vai trò trong UI Cài đặt
(`organization_roles.name` là text tự do, không lock theo tên) sẽ **âm thầm tắt cửa chủ sở hữu** trong
`reverse_invoice_collection_v5` và mọi cổng owner mà hai plan định dựng lên nó.

Nguồn: `[A3.C4]`, `[A3.C12]`, `[A7.C5]`, `[X4.4]`, `[X6.5]` (bác phần "helper mới thiếu window"),
`D-REUSE-1`.

### 6.3 `is_super_admin()` bỏ qua `organization_id`

```text
public.is_super_admin()  -- toàn bộ thân hàm
  SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid());
```

- Bảng `public.super_admins` **CÓ** cột `organization_id` (`{user_id, note, created_at, organization_id}`)
  và row hiện tại mang `organization_id='aaaa0000-…0001'` → **trông như đã phân vùng, thực tế không**.
- Hàm được **GRANT EXECUTE cho `anon`** (`proacl: =X/postgres | anon=X/postgres`) và đặt
  `SET search_path TO 'public'` (không đủ schema-qualify, lệch chuẩn `pg_catalog, app_private, public`
  mà chính plan Task 0 Step 3c yêu cầu).
- Lan xuống: `public.has_full_building_scope()` = `SELECT public.is_super_admin();`;
  `public.can_access_building()` = `is_super_admin() OR can_v3('buildings.view', …)`;
  policy `*_super_admin_all` trên **7 bảng** (`invoices`, `income_expenses`, `buildings`, `rooms`,
  `contracts`, `contract_terminations`, `accounts`) với `qual = with_check = (SELECT is_super_admin())`;
  và `app_private.ie_visible_cashbook_ids_v1`.

`[A3.R1]` (HIGH), `[A3.R6]`, `[A3.C9]`.

Câu *"mọi `is_super_admin()` được bypass chỉ trong public special-page RPCs"* của plan là **sai hiện
trạng**: prod đã có nhiều bypass superadmin ngoài special page, kể cả trên đường tiền — ví dụ
`reverse_invoice_collection_v5` có nhánh *"cửa phụ"*
`IF NOT public.is_super_admin() AND NOT app_private.is_org_owner_v1(...) AND NOT EXISTS (... src.user_id = v_actor) THEN RAISE …`.
Plan phải đổi thành *"KHÔNG THÊM bypass mới ngoài special-page RPC; danh sách bypass hiện hữu là …"*.
`[A3.C9]`.

### 6.4 `my_org_ids()` thiếu cửa sổ hiệu lực

```text
public.my_org_ids()  -- STABLE SECURITY DEFINER, search_path 'pg_catalog','public'
  SELECT COALESCE(array_agg(organization_id), '{}'::uuid[])
  FROM public.organization_memberships
  WHERE user_id = auth.uid() AND status = 'ACTIVE';
```

**Không `valid_from`, không `valid_to`** — trong khi đường GHI (`authorize_tenant_action_v3:45-46`)
kiểm cả hai mốc. ⇒ **đường ĐỌC qua RLS rộng hơn đường GHI**. Lan xuống:
`app_private.authorized_scope_all_v3:9` (`from unnest(public.my_org_ids())`),
`app_private.ie_visible_cashbook_ids_v1:10` (`AND a.organization_id = ANY (public.my_org_ids())`),
và **34 policy RLS** tham chiếu `my_org_ids` trong `qual`/`with_check`.

`[X4.6]` **hiệu chỉnh**: lỗ này **latent, chưa bị khai thác** — đo được **0** membership
`status='ACTIVE' AND valid_to <= now()` và **0** với `valid_from > now()`. Nó sống ngay khi ai đó thu
hồi quyền bằng **cửa sổ** thay vì bằng `status` — mà đó chính là cách repo thu hồi vai trò
(comment trong `is_org_owner_v1`). Giữ HIGH như hardening hướng tới tương lai, **không** phải breach
hôm nay. `[A3.C6]`.

### 6.5 `buildings.view` là baseline thật đang gác `/deposits` hôm nay

```text
pg_policies: contract_terminations_select_rbac, cmd=SELECT
  qual = can_access_building(building_of_contract(contract_id))
public.can_access_building(_building_id) = public.is_super_admin() OR app_private.can_v3('buildings.view', _building_id)
public.building_of_contract(...) = JOIN contracts c JOIN rooms r ON r.id = c.room_id   -- PHÒNG HIỆN TẠI
```

⇒ Chuyển `/deposits` sang một RPC SECURITY DEFINER gác bằng `deposits.view` là **đổi quyền theo CẢ HAI
CHIỀU**, không phải "khớp cái đang có":
- ai có `buildings.view` mà không có `deposits.view` trên toà → **mất** dòng đang thấy hôm nay;
- ai có `deposits.view` mà không có `buildings.view` → **được thêm** dòng.

Danh sách test của Plan 2 Task 4 Step 4 phủ "chỉ `contracts.view`" và "chỉ `deposits.view`" nhưng
**không có** thành viên `buildings.view`-only — tức **chính status quo**. `[A0.C5]`, `C-DEP-10`.

Ngoài ra `permission_definitions` có `deposits.view` (BUILDING scope, active) — plan dùng đúng — **và**
có `deposits.refund` (`resource='deposits'`, `action='refund'`, `is_active=true`,
`scope_kinds={ORGANIZATION,AREA,BUILDING}`) mà **cả hai plan không dùng**; hàng đợi hoàn cọc được
thiết kế sau `thu_tien.collect`. Chủ đã cấp/khoá `deposits.refund` cho ai thì việc đó thành vô nghĩa
với luồng mới. `[A0.V11]`, `[A9.R9]`, `C-DEP-9`.

### 6.6 Engine authz: cái gì được bảo đảm, cái gì không

| Sự thật | Bằng chứng |
|---|---|
| `authorize_tenant_action_v3` **KHÔNG có** nhánh bypass `is_super_admin` — thiếu membership là deny (`:273` `when not exists (select 1 from membership) then false`, `:291` `'MEMBERSHIP_INACTIVE_OR_MISSING'`); toàn thân 13.745 ký tự không chứa `is_super_admin` | `[A3.V5]` |
| Nó **ĐÃ** kiểm `organizations.status='ACTIVE'` (`:18`) **và** membership `valid_from/valid_to` (`:44-46`) | `[A3.V6]` |
| Caller contract: `app_private.lock_org_for_decision_v1(uuid)` phải được gọi ở **một statement TRƯỚC** trong cùng transaction (ghi ở comment `:11-13`) | `[A3.V7]` |
| `required_dimensions={}` ⇒ gọi với `p_building_id=NULL` **vẫn pass** nếu tồn tại một cạnh ALLOW cấp ORGANIZATION (`scope_cover` nhánh ALLOW `:152` `e.scope_type='ORGANIZATION'` đúng vô điều kiện) | `[A3.C11]` |
| Truyền `p_cashbook_id` **chỉ kiểm PHẠM VI phủ, KHÔNG kiểm QUAN HỆ giữ sổ** (`requires_cashbook_possession=false`; CTE `possession:193` `when not (select requires_cashbook_possession from permission) then true` → luôn pass) | `[A3.V11]`, `[A3.C11]` |
| Custody thật chỉ do `app_private.assert_cashbook_access_v2(org, cashbook, kind, membership)` cưỡng chế: chỉ nhận `CUSTODIAN\|KNOWER` (khác → 22023), so `possession_kind` **CHÍNH XÁC**, và `finance_v2_has_covering_deny(...)` thắng mọi binding | `[A5.V12]`, `[A3.V11]` |
| `app_private.ie_visible_cashbook_ids_v1()` = `is_super_admin() OR a.user_id = auth.uid() OR is_account_shared_with_me(a.id) OR EXISTS(possession_kind='CUSTODIAN' + window)` — **đã tồn tại trên prod, chưa ai gọi** | `[A3.C7]`, `D-REUSE-5` |
| `app_private.resolve_finance_actor_v2()` (no-arg) **ĐANG raise 42501** *"ambiguous membership; org-scoped resolution required"* cho superadmin **ngay hôm nay** vì người đó có 2 membership ACTIVE; vị ngữ count **không có** chiều `member_type` nào ⇒ bản vá plan đề xuất không giải quyết được ca thật | `[A3.C3]`, `[A5.V13]`, `[X4.3]` |
| Bản `(uuid)` chọn `ORDER BY m.valid_from DESC LIMIT 1`, **không** ưu tiên `member_type` | `[A5.V13]` |

**Lỗ WP2 đang chờ vá** (`[A3.R4]`, HIGH): live `reverse_invoice_collection_v5` vẫn truyền
`v_invoice.building_id` cho **mọi** tender thay vì building của chính phiếu tender, và **chưa có** bậc
"được nhìn sổ" (`prosrc` chứa `'ie_visible_cashbook_ids_v1'` = **FALSE**). Dữ liệu khớp:
`bosshuy@username.ihomecrm.local` là `PARTNER` ở `aaaa` với **3 `member_permission_overrides` ALLOW
`scope_mode='ORGANIZATION'`** cho `thu_tien.view/collect/undo` và **KHÔNG có** một
`cashbook_possession_binding` nào — nhưng hoàn tác được **cả ba sổ**.

Quyết định của chủ ngày **30/07/2026** (ghi ở `20260730240000_authz_remaining.sql:34-41`): hoàn tác chỉ
cần **"ĐƯỢC NHÌN SỔ"** (super admin / người tạo sổ / được chia sẻ / đang giữ), **KHÔNG** phải exact
CUSTODIAN — vì exact CUSTODIAN loại luôn người chỉ được chia sẻ sổ (JOEY/KNOWER trên TK939, migration
ghi là *"đúng ý chủ"*). `[X4.7]` **bác nửa (a)** của phát hiện gốc (`income_expenses.cancel/reverse`
**có** tồn tại và **đúng là** khoá của writer IE truyền thống) và **giữ nửa (b)**: mandating exact
CUSTODIAN cho undo đi ngược quyết định của chủ. `[A3.C7]` → `C-AUTHZ-7`, `D-REUSE-5`.

### 6.7 Superadmin, SERVICE membership và fixture DEMO

| Sự thật | Số |
|---|---|
| `public.super_admins` | **1 row**, `user_id=90450d5f-29b6-4897-bdef-cdb5fb53f339`, note *"Bootstrap super admin: nguyentamca165@gmail.com"* |
| Membership của người đó | **2 row ACTIVE hợp lệ**: `OWNER@aaaa` (valid_from 2026-07-13, valid_to NULL) và `STAFF@DEMO` (valid_from 2026-07-17, valid_to NULL) |
| Custody | **21 binding CUSTODIAN** ở `aaaa` (Hiệp chi, Hiển Thu, Tâm Thu, TK939, Chung, ATam, AG810, AG708, HKDTAM, HKDHUY, HKDHIEN, …) + **1** ở DEMO (`'CANARY renamed'`) |
| Org thiếu membership của superadmin | **0** (chỉ tồn tại 2 org) |
| `member_type='SERVICE'` | **ĐÃ nằm trong** `organization_memberships_member_type_check` (`OWNER\|STAFF\|SHAREHOLDER\|PARTNER\|SERVICE`) ⇒ **không cần** migration đổi constraint; hiện **0 row SERVICE** |
| Phân bố member_type thật | `OWNER` 2, `STAFF` 8, `PARTNER` 1 — tất cả `status='ACTIVE'`, `valid_to` đều NULL |
| Frontend gate của superadmin | Đi bằng **sentinel**, không qua catalog: `public.get_my_permissions()` trả `'{"__superadmin": true}'::jsonb`; `permissionPages.ts:631` `canUse → if (isSuperAdminPerms(p)) return true`. Ngược lại `authorized_scope_v3`/`has_any_scope_v3` **không có** nhánh superadmin |

⇒ `[X4.2]` **BÁC** phát hiện "plan provision SERVICE membership cho một superadmin không có
membership": đo đúng, nhưng plan **đã** gate việc provision trên điều kiện *"chỉ khi hoàn toàn chưa
có"* ở ba chỗ (`P1:126`, `P1:127`, `DR:203`) ⇒ nhánh này **không thể chạy trên dữ liệu hiện tại**;
`DR:147` là **ô kịch bản trong risk register**, không phải khẳng định hiện trạng. Hành động: đổi
`DR:147` sang thể điều kiện + thêm preflight ghi rõ nhánh này chết trên dữ liệu hôm nay; **giữ** Step 3.
Mức LOW. `[A3.C2]`, `[A3.V8]`, `[A3.V9]`, `[A3.V10]`, `[A3.V15]`.

Nhưng bán kính nổ của Step 3 nếu vẫn làm thì **lớn hơn plan tưởng nhiều** (`[X4.5]`, hạ HIGH→MEDIUM
vì điều kiện): **105 function** trong `public`+`app_private` tham chiếu `organization_memberships`; chỉ
**12** lọc `member_type`; **50** lọc **cả `member_type` cả `valid_to` đều KHÔNG**. Danh sách "ít nhất"
của plan phủ **3/50** (không phải 5/50: `list_organization_members_v1` **có** lọc, còn
`authorized_scope_all_v3` **không** chạm bảng đó trực tiếp — nó thừa hưởng qua `my_org_ids()`).
Trong nhóm 50 có **12 hàm TIỀN** đã xác minh: `post_collection_tender_v2`,
`reverse_collection_tender_v2`, `finance_v2_register_birth_v1`, `finance_v2_auto_posting_bridge`,
`ie_approver_ids_v1`, `resolve_approval_actor_v2`, `salary_payout_v1`, `manager_salary_payout_v1`,
`confirm_cashbook_closing_v1`, `cashbook_close_confirmers_v1`, `create_finance_evidence_upload_intent_v2`,
`can_reverse_collection_v1`. `[A3.C5]`.

**Fixture quyền trong DEMO — plan không chạy được như viết** (`[A3.C10]`):

| Tài khoản DEMO | Thực trạng quyền |
|---|---|
| `demo.kythuat`, `demo.sale`, `demo.codong` | Role `'Quản Lý Tòa'` ở DEMO có `thu_tien.view/collect/undo = false` (chỉ `buildings.view`/`contracts.view`/`deposits.view` = true, 12 active binding); role `'Viewer'` cũng false ⇒ **không có `thu_tien.view`, chặn ngay ở route** ⇒ không thể làm fixture "view-only" |
| `demo.chunha`, `demo.quanly` | Đều bound role `'Chủ sở hữu tổ chức'` (đủ 4 khoá + binding CASHBOOK/ORGANIZATION) ⇒ không thể làm fixture scoped |
| `demo.ketoan` | **Ca ngược duy nhất**: override `thu_tien.collect` `scope_mode='ORGANIZATION'` nhưng `thu_tien.view` `scope_mode='SCOPED'` (`scope_type=BUILDING`), và **không có** `thu_tien.undo` ⇒ **quyền GHI rộng hơn quyền ĐỌC** |
| `bosshuy` (org thật) | Có cả 3 khoá ở ORGANIZATION — nhưng org thật **chỉ được đọc** theo `CLAUDE.md` |

⇒ Phải thêm một Step tạo fixture quyền trong DEMO (role/override tạm + cleanup) **TRƯỚC** khi viết test,
và ghi rõ `demo.ketoan` là ca collect-rộng-hơn-view cần test riêng.

### 6.8 Hai gate quyền dễ bỏ sót

| Gate | Sự thật |
|---|---|
| `public.can_create_restricted_ie()` | `= select public.is_super_admin() or app_private.has_any_scope_v3('income_expenses.restricted_create')`, STABLE DEFINER, md5 `90ad1994a07546d11c18c368ab2b3bb8`, nằm trong `scripts/definer-acl-baseline.json:16`. **Là gate server THẬT**: `pay_period_fee:50-52` `IF p_category_key='quan_ly' AND NOT public.can_create_restricted_ie() THEN RAISE 42501`; đối ứng đọc ở `get_period_fee_status:20/47/110`. **KHÔNG ĐƯỢC ĐỤNG.** `[A7.V11]`, `[A8.V8]` |
| Nhưng nó **không có tham số organization** | `has_any_scope_v3(p_permission_key text)` chỉ đòi *bất kỳ* membership ACTIVE ở *bất kỳ* org ACTIVE có cạnh ALLOW ⇒ quyền cấp ở org A thoả gate cho toà của org B. Hiện **chưa khai thác được**: hai quyền này chỉ cấp qua role `'Chủ sở hữu tổ chức'` (thật 1 binding, DEMO 3) và chỉ 1 user đa-org (chính superadmin). `[A8.R5]` |
| Definer CŨ đang mở | `public.can_create_restricted_ie()`, `public.current_visible_owner_ids()`, `public.is_super_admin()` đều `proacl` có `=X/postgres` (**PUBLIC**) + `anon=X`. Đối chiếu: `authorize_tenant_action_v3`, `assert_cashbook_access_v2`, `current_admin_org_v1`, `resolve_finance_actor_v2` chỉ `postgres=X/postgres` (đã siết đúng). Hai plan chỉ đặt lệnh REVOKE cho definer **mới**, không rà definer cũ. `[A3.R5]` |
| Role vỏ rỗng | Role tổ chức tên `'Super Admin'` ở org `aaaa`: **18 role_binding đang hoạt động, 0 dòng `role_permissions`** ⇒ ai chỉ được gán role này (và không có row trong `public.super_admins`) sẽ bị `authorize_tenant_action_v3` deny mọi thứ, trong khi UI/nhân sự tin là đã cấp quyền cao nhất. `[A3.R2]` |
| `current_admin_org_v1` | `order by coalesce(o.is_demo,false), m.organization_id limit 1` ⇒ một row membership mới **có thể** đổi org đang xem (hôm nay luôn trả `aaaa` vì chỉ 2 org). `[A3.V10]` |
| `list_organization_members_v1` | `where m.organization_id = v_org and m.status <> 'REVOKED'` — **không lọc `member_type`**; sort map `OWNER→0, STAFF→1, else→2` ⇒ một row SERVICE **sẽ** hiện trong danh sách thành viên. `[A3.V9]` |

---

## 7. Số liệu sống đo lại 30/07/2026

Tất cả tách theo organization. `aaaa` = `aaaa0000-0000-4000-8000-000000000001` (org thật, **chỉ đọc**);
`dddd` = `dddd0000-0000-4000-8000-000000000001` (DEMO, nơi duy nhất được ghi theo `CLAUDE.md`).

### 7.1 Mọi con số bản 29/07 đã trích — đo lại

| # | Chỉ số | Bản 29/07 ghi | Đo lại 30/07 | `aaaa` | `dddd` | Trạng thái | Nguồn |
|---|---|---|---|---:|---:|---|---|
| 1 | `repeat_due` | **77** "recurring **children** đang due" | **77** — nhưng là **PARENT**, không phải child: 77/77 có `repeat_parent_id IS NULL`, **0 child**; 76/77 `APPROVED`; 77/77 `repeat_cycle<>'NONE'`; 76/77 map được vào 1 trong 7 kind cố định (rac 15, ve_sinh 15, quan_ly 14, tien_nha 13, internet 13, thang_may 5, cong_an 1); 64/77 `repeat_auto_approve=true` | 77 | 0 | **ĐỔI NGHĨA** | `[A4.V1]`, `[A4.C1]`, `[A8.C7]` |
| 2 | Recurring children | 146 posted (966.010.000), 9 cancelled (174.100.000) | **GIỮ NGUYÊN**; tổng child alive = **155** (146 + 9), **155/155** có `system_source IS NULL`, **155/155** rơi vào một kind cố định (ve_sinh 31, quan_ly 30, rac 30, tien_nha 26, internet 26, thang_may 10, cong_an 2) | 155 | 0 | GIỮ + mở rộng | `[A4.V2]`, `[A4.V3]`, `[A4.V4]`, `[A4.R2]` |
| 3 | Số "parent due" theo `add_cycle` | — | **76** (`add_cycle(voucher_date, repeat_cycle, 1) <= current_date`) — khác 77 alive | 76 | 0 | MỚI (D13: báo cả hai, ghi rõ vị ngữ) | `[A8.C7]`, `D13` |
| 4 | `contract_deposit_links` | 5 | **5**, tất cả `link_source='EXPLICIT_V2'`, **không có cột amount** | 5 | 0 | GIỮ | `[A4.V5]`, `[A9.V12]` |
| 5 | Phiếu cọc ảo `NOT_APPLICABLE` | 243 / 1.044.340.000 | **GIỮ NGUYÊN** | 243 | 0 | GIỮ | `[A4.V6]` |
| 6 | Phiếu cọc thật `POSTED` | 33 / 96.900.000 | **GIỮ NGUYÊN** | 33 | 0 | GIỮ | `[A4.V7]` |
| 7 | Termination theo status | 35 `COMPLETED`, 1 `DRAFT`, 1 `PENDING_APPROVAL` | **GIỮ NGUYÊN**; tách theo type: `FORFEIT/COMPLETED` **26**, `NORMAL/COMPLETED` **9**, `NORMAL/DRAFT` 1, `NORMAL/PENDING_APPROVAL` 1 | 28 | 9 | GIỮ + tách mới | `[A4.V8]`, `[A9.C4]`, §7 (đo lại 30/07) |
| 8 | `SUM(refund_amount)` nhóm COMPLETED | −66.207.315,35 | **GIỮ ĐÚNG ĐẾN XU**: `aaaa` −62.345.315,35 (min −10.590.180,64; max 3.509.500) + `dddd` −3.862.000 (min −2.241.000; max 500.000) | — | — | GIỮ — đây **là** một trong rất ít con số thật sự là tổng hai org | `[A4.V9]`, `[X7.1]` |
| 9 | Termination có `refund_amount > 0` | 7 | **7** | 3 | 4 | GIỮ | `[A4.V10]` |
| 10 | `termination.refund` POSTED | 10 / 28.039.100 | **GIỮ NGUYÊN**, `owned_count = 0` | 10 | 0 | GIỮ | `[A4.V12]` |
| 11 | `termination.refund` `NOT_APPLICABLE` | 3 / 9.515.634 | **GIỮ NGUYÊN** | 3 | 0 | GIỮ | `[A4.V13]` |
| 12 | `termination.refund` UNAPPROVED | 1 / 3.509.500 | **GIỮ NGUYÊN** (`PC2607153`, id `975a5afb`) | 1 | 0 | GIỮ | `[A4.V14]` |
| 13 | Phiếu hoàn không correlate được | "16/20" | **16/20** (mẫu số = 20 phiếu `system_source='termination.refund'`, mọi status, alive). Mẫu số khác: 28 refund-like → 21 mồ côi; 19 non-cancelled → 13 | — | — | GIỮ (ghi rõ mẫu số) | `[A4.V20]`, `[A9.V13]` |
| 14 | Audit termination thiếu | **"37/56"** | **KHÔNG TÁI LẬP**. Hai cách hiểu, cả hai đều khác 37/56: (a) **23/56** hợp đồng `TERMINATED` **không có** dòng `contract_terminations` (37 dòng / 37 HĐ khác nhau) — và **14 trong 23 ca đó VẪN CÓ phiếu `termination.refund`**; (b) **37 của 40** dòng `income_expense_audit_log` kỳ vọng cho 20 phiếu refund (20×2 event) bị thiếu, chỉ có **3** row thật | 23 · 14 | — | **SỬA** (plan 29/07 ghi 37/56 — số đo lại 30/07 là **23/56** cho hồ sơ, **37/40** cho audit row) | `[A4.C2]`, `[A9.C8]`, `[A9.R7]`, `D10`, §7 (đo lại 30/07) |
| 15 | `invoice_refund_reservations` | 1 `RELEASED` 7.000, source `invoice.refund` | **GIỮ NGUYÊN** + **sự thật mới**: dòng đó thuộc **DEMO**, org thật **chưa bao giờ** tạo reservation nào | 0 | 1 | GIỮ + org | `[A4.V16]` |
| 16 | `contract_transfers` | 3 `ROOM_CHANGE` completed | **3**, tất cả `ROOM_CHANGE` + `COMPLETED`, `old_room_id`/`new_room_id`/`move_out_date`/`move_in_date` **đều non-null**; `BOTH_CHANGE` = **0 dòng ở mọi nơi**; không có dòng non-COMPLETED | 3 | 0 | GIỮ + `BOTH_CHANGE`=0 | `[A4.V17]`, `[A4.C10]` |
| 17 | `income_expenses` tổng dòng | baseline 29/07 = **2.496** | **2.625 tổng dòng** = 2.276 `aaaa` + 349 `dddd`; **2.528 dòng alive** (`deleted_at IS NULL`) = 2.205 + 323 | — | — | **GIẢI QUYẾT D11**: 2.528 và 2.625 **không xung đột** — khác vị ngữ (alive vs all). Baseline 2.496 là alive ⇒ **+32 dòng alive/ngày** | `[A4.R8]`, `D11`, §7 (đo lại 30/07) |
| 18 | `buildings.commission_tiers` | "có gap" | **21/21 toà đã khai, 21/21 đều có gap**, cùng một hình dạng: chỉ phủ 5–6 tháng và 10–12 tháng ⇒ hở `<5`, `7–9`, `>12`. 18 toà dùng `[{5,6,50},{10,12,60}]`; 102LVT rate **70**; 44TL rate **80**; 1392QT `max_months=13`. **0** toà thiếu mảng | 18 | 3 | **SỬA**: gap là **phổ quát**, không phải edge case (bản audit thô ghi "20 toà dùng bản thường" — số đúng là **18**) | `[A4.V21]`, `[A4.C7]`, `[X7.5]` |
| 19 | Phiếu phí cố định trùng | "duplicate fixed legacy" | **22 ô (toà × kind × tháng) có ≥2 phiếu non-cancelled, tổng 45 phiếu**, tệ nhất **n=3**; tổng số ô = 293. Theo kind: rac 7, tien_nha 7, cong_an 3, ve_sinh 3, internet 1, quan_ly 1. Theo tháng: 2026-05 **4**, 2026-06 **5**, **2026-07: 13**. Ô tệ nhất: toà `175f4329-eff2-4bb3-aee7-474dd2a0c429` / `tien_nha` / 2026-05 / **3 phiếu APPROVED** (=108.400.000đ) | 22 | **0** | GIỮ (khớp baseline 29/07) — nhưng **13/22 ô là tháng 07/2026 ⇒ vẫn đang phát sinh** | `[A4.V22]`, `[A4.R1]`, `D1`, §7 (đo lại 30/07) |
| 20 | Phiếu điện/nước trùng | "2 meter-slot" | **PHỤ THUỘC KHOÁ** — xem §7.3 | — | — | **LÀM RÕ (D2)** | §7.3 |
| 21 | Hoa hồng broker trùng | — | **2 hợp đồng** có 2 phiếu broker APPROVED: `16edb8f0-2469-4682-92c6-b5d415f2de14`, `b543b3cd-0bb0-4a9a-afee-5a5fa7fd59e0` | 2 | 0 | GIỮ | `[A4.V22]`, `[A4.R10]` |
| 22 | Phiếu broker không gắn HĐ | 11 | **11** (10 source NULL = 31.690.000 + 1 `contract.commission` = 2.350.000); 14 nếu tính cả 3 CANCELLED | 11 | 0 | GIỮ | `[A4.V19]` |
| 23 | Bảo trì | **"101 voucher / 11 service name"** | **101/11/42.333.000đ** là **CHỈ** category *"Bảo Trì Máy Lạnh"*. Toàn họ `nrm_vn(category) LIKE 'bao tri%'` = **200 phiếu / 31 tên / 5 category**: Máy Lạnh 101/11/42.333.000; Tòa Nhà 81(`aaaa`)+4(`dddd`) / 12+4 tên / 31.606.556+400.000; Máy Giặt 7/2/2.850.000; Tủ Lạnh 6/1/2.850.000; máy bơm 1/1/250.000 | 196 (27 tên, 177 non-cancelled, 132 có room) | 4 (0 non-cancelled) | **SỬA** (plan 29/07 ghi 101/11 — số đo lại 30/07 là **200/31**) | `[A4.V18]`, `[A4.C6]`, `[X7.4]`, `D9` |
| 24 | `income_expense_audit_log` | "tồn tại, có chain hash" | **357 row / 256 phiếu**, sớm nhất **2026-06-30T12:50:20Z**, muộn nhất 2026-07-29T14:15:34Z. Histogram: `CREATED_DRAFT` 163, `CANCELLED` 110, `CANCELLED_NOTE` 64, **`APPROVED` 8**, `RESTORED` 7, `VERIFIED` 4, `UNVERIFIED` 1. Cột tự do duy nhất là `note text` | 357 | 0 | GIỮ + **baseline chỉ 1 tháng** | `[A4.R7]`, `[A5.C9]`, `C-EV-2` |

### 7.2 Số liệu hai plan **chưa từng đo**

| # | Chỉ số | Số đo 30/07 | Ý nghĩa | Nguồn |
|---|---|---|---|---|
| 25 | Ô cấu hình giá phí cố định | `building_fee_accounts` alive = **109 row, 100% ở `aaaa`, DEMO 0 row**. `default_amount` non-null **107/109**; `default_account_id` non-null **0/109**; `not_applicable=true` **0/109** | **Cả 109 dòng chưa chọn sổ quỹ**; cửa thoát "không áp dụng" **chưa bao giờ được dùng** | `[A4.C5]`, `[A4.R4]`, `[A4.R5]`, §7 (đo lại 30/07) |
| 26 | Toà khai đủ giá cả 7 kind | **0/21** | Không một toà nào đủ | `[A4.C5]` |
| 27 | Ô thiếu giá, org thật | Grid 7 kind × 18 toà = **126 ô**: 46 không có row, 1 có row nhưng `default_amount` NULL, 79 có giá ⇒ **47/126 (37%) `CONFIG_REQUIRED`** theo cách đếm thô. **Hiệu chỉnh `[X7.3]`**: 12 trong 46 ô thiếu là `thang_may` ở toà `has_elevator=false`, và **cả 6 toà có thang máy đều đã khai giá** (600k/500k/500k/650k/600k/500k) ⇒ khoảng trống thật ≈ **35/126 = 28%** | Chủ phải khai ~35 ô trước khi bật | `[A4.C5]`, `[X7.3]` |
| 28 | Kind `quan_ly` trong bảng cấu hình | **0 row trên cả hai org** (109 row chia theo category: cong_an 14, dien 17, internet 15, nuoc 12, rac 16, thang_may 6, tien_nha 15, ve_sinh 14 = 109 — **không có `quan_ly`**) ⇒ **18 ô (`aaaa`) + 3 ô (`dddd`) đều trống** | **Lỗ lớn nhất của phần cấu hình**, và không tài liệu nào nêu | `C-READ-1`, `[X7.3]`, §7 (đo lại 30/07) |
| 29 | `buildings.hidden_fixed_expenses` | **4/21 toà** có mảng non-empty, tổng **6 ô**: `403PVB {nuoc, ve_sinh}`, `65NTG {cong_an, ve_sinh}`, `405PVB {nuoc}`, `1392QT {nuoc}` ⇒ chỉ **3 ô** thuộc 7 kind cố định (403PVB ve_sinh; 65NTG cong_an + ve_sinh), 3 ô còn lại là `nuoc` (ngoài 7 kind) | Cơ chế "toà này không có phí này" **CÓ tồn tại và ĐANG dùng** — nhưng giải thích được **tối đa 3 trong ~35 ô thiếu**, và **KHÔNG** khai 12 ô `thang_may` | `[A4.R5]`, §9 mục 8 của `synthesis` (đã giải quyết một phần), §7 (đo lại 30/07) |
| 30 | Hợp đồng nằm trong / ngoài bậc hoa hồng | **152 HĐ** rơi đúng bậc đã khai (5mo 25, 6mo 6, 10mo 10, 11mo 56, 12mo 55); **22 HĐ** ở 7–9 tháng (server 50% vs client 0đ); **48 HĐ** ở 13–17 tháng (13mo 18, 14mo 18, 17mo 12) + 8mo 9 / 9mo 7 | `fallback_policy` là **load-bearing**: không có nó thì **70 HĐ** không áp được mức nào | `[X7.5]`, `[A6.C6]` |
| 31 | Vi phạm sẵn luật "AC 1 lần / 5 tháng" | **86** phiếu AC non-cancelled, trong đó **23 phiếu đã nằm trong cửa sổ ±5 tháng với một phiếu AC khác CÙNG PHÒNG**; **4** phiếu `room_id` NULL (13/101 nếu tính cả CANCELLED) | 23 ca **vi phạm sẵn** luật Plan 1 muốn cưỡng chế; 77 phiếu bảo trì org thật không có room ⇒ không gắn được luật theo phòng | `[A4.R6]`, `[X7.4]`, §7 (đo lại 30/07) |
| 32 | Máy giặt | **7** phiếu / 2 tên / 2.850.000đ, **0** phiếu thiếu building, **0** ca trùng trong 6 tháng | Luật rolling-6-tháng **hoàn toàn chưa được dữ liệu thật kiểm chứng**; plan đặt máy giặt ngang tầm máy lạnh (101 phiếu) ⇒ nên hạ ưu tiên | `[A4.R6]`, `[X7.4]` |
| 33 | `pay_period_fee` đã từng dùng chưa | **2 phiếu** `system_source='fixed_fee'` trong TOÀN BỘ lịch sử, **cả 2 đã soft-delete**: `PC2607111` 300.000 (08/07) và `PC2607117` 900.000 (09/07) — cả hai vẫn `approval_status='APPROVED'`, `posting_status` NULL | Mọi query backfill keyed on `system_source IN ('fixed_fee')` sẽ trả **0 dòng và báo "sạch" SAI** | `[A8.C8]` |
| 34 | 376 phiếu mà trang phí cố định đang đọc | Nguồn thật: **304 `system_source` NULL**, **67 `utility.bill`**, **5 `salary.staff`** | Claim engine mới phải nhận 304 phiếu null-source làm `EXTERNAL/LEGACY` claim | `[A8.C8]` |
| 35 | Ngưỡng tự duyệt | `app_private.ie_auto_approve_config`: `aaaa` = **600.000đ** (đặt **2026-07-29 09:39:56Z**, tức **sau** ngày viết plan, by `90450d5f`); `dddd` = **5.000.000đ** (19/07) | **64/72** phiếu điện/nước alive ≥ 600.000đ ⇒ từ lần đóng kế tiếp phiếu sẽ ra UNAPPROVED và **vô hình** | `[A6.R1]`, `[X8.1]`, §7 (đo lại 30/07) |
| 36 | Nhánh ngưỡng đã nổ chưa | Ở org thật: **CHƯA** (phiếu `utility.bill` mới nhất tạo 2026-07-22T09:33Z, tức trước khi hạ mức; 0 phiếu tạo sau 29/07 09:39:56; 0 phiếu UNAPPROVED alive). Ở **DEMO đã nổ một lần**: `PC2607039` `utility.bill` **8.000.000** ≥ ngưỡng 5.000.000 → UNAPPROVED, `approved_by/at` NULL, tạo 2026-07-20T01:29:33.958Z, soft-delete 01:29:34.531Z (fixture E2E) | Bom **đã lên nòng**, chưa nổ ở org thật | `[X8.1]` (sửa câu *"nhánh này CHƯA từng chạy"*) |
| 37 | Cờ tính năng | **28 row**: **24 `ON`** (`force_freeze=false`), **2 `OFF`** (`contract.commission.settlement.v2`, `salary.settlement.v2`), **1 `OFF` + `force_freeze=true`** (`income_expense.profit_close.v2`, `config_version=1`, **0 dòng event**), **1 `SHADOW`** (`shareholder_profit.distribute.v2`), **0 `CANARY`** | (bản audit thô cộng 25+2+1+1=29 — bất khả; số đo lại là **24+2+1+1=28**). **Cả 3 khoá hai plan cần đều CHƯA tồn tại**: `special_fee.payment.v1`, `termination_refund.obligation_birth.v1`, `termination_refund.special_page.v1` | `[A2.C11]`, `[A7.V12]`, `[A9.V17]`, §7 (đo lại 30/07) |
| 38 | Sổ nhật ký rollout | `server_feature_flag_events` = **70 row, 100% `event_type='ROUTE_CHANGED'`**; nhưng **7/28 cờ có `config_version > 1` mà ZERO event** (`contract.create.v2` ON@v4, `customer.credit.apply.v1` ON@v4, `customer.credit.reverse.v1` ON@v3, `shareholder_profit.distribute.v2` SHADOW@v3, `income_expense.profit_close.v2` OFF@v1+freeze, `contract.commission.settlement.v2` OFF@v1, `salary.settlement.v2` OFF@v1) | Không được đọc `expected_version` từ sổ event; phải đọc từ **bảng** | `[A2.R2]`, `C-ROLL-1` |
| 39 | `server_feature_flag_operations` | **52 row**, chỉ thuộc 4 khoá, đều ở `config_version` của giai đoạn CANARY. Tiền lệ **hai org dùng chung một version**: `income_expense.create_draft.v1` v5 = 14 op DEMO (633.345đ) + 2 op `aaaa` (2.000đ); `invoice.record_payment.v1` v3 = 11 op DEMO (512.000đ) + 1 op `aaaa` (6.419.500đ) | Cap đếm **CHUNG mọi org** (không có vị ngữ `organization_id`) | `[A2.C4]`, `[A2.R10]`, `C-ROLL-5` |
| 40 | Cửa sổ shadow tiền lệ | `invoice.collection.v5`: event id=64 SHADOW→CANARY **2026-07-22 05:38:50** rồi id=68 CANARY→ON **07:03:53** ⇒ cửa sổ shadow production **chỉ 85 phút**, bị cắt khi canary bật; giữa hai mốc có **16 dòng ops** `config_version=5`, org DEMO, tổng 13.500.000đ | Bằng chứng cứng cho `C-ROLL-2`: flip SHADOW→CANARY **mất telemetry của org thật** | `[A2.V3]`, `[A2.R4]` |
| 41 | Ba lớp khoá kỳ | `app_private.cashbook_closures` **0 row**; `cashbook_closure_requests` **0 row**; `accounts` có `lock_date` **0/28 alive** (bản audit vùng 8 ghi 27 alive — số đo lại **28**, tức đã +1 trong ngày). `cash_handovers` `status<>'CANCELLED'` = **7**. `profit_monthly` `locked_at IS NOT NULL` = **18 row / 18 toà / đúng 1 tháng `2026-05`** | Nhánh "sổ quỹ đã chốt" **chỉ kiểm được bằng fixture**; hai lớp kia có dữ liệu thật | `[A5.C2]`, `[A7.R11]`, §7 (đo lại 30/07) |
| 42 | Evidence | `finance_evidence_objects` **159 row** (142 `ATTACHED`, 11 `FINALIZED`, 6 `UPLOAD_INTENT`); `sha256` non-null **0**; `upload_token_hash` non-null **0** | Mọi guard "cùng hash" so NULL với NULL | `[A5.C7]`, `C-EV-1`, §7 (đo lại 30/07) |
| 43 | Ownership | **179 row** (xem §4.3) — plan/runbook Đợt 2 ghi **172** | Mọi assertion đếm cứng "172" sẽ đỏ | `[A7.C12]`, §7 (đo lại 30/07) |
| 44 | Postings theo `source_kind` | `LEGACY_BACKFILL` **1710**, `MANUAL` **265**, `LEGACY_BRIDGE` **73** | Cầu a85 đã sinh 73 posting thật | `[A5.V18]`, `[A5.V20]`, §7 (đo lại 30/07) |
| 45 | Token rác | `app_private.ie_transition_authorization` **213 row**, **213/213** có `xid <> pg_current_xact_id()` (209 `FINANCE_V2_LIFECYCLE`, 4 `FINANCE_V2_BIRTH_BACKFILL`); PK = `income_expense_id`; **không có job/trigger dọn theo tuổi** | Không thể giữ hai `purpose` song song cho cùng phiếu | `[A5.R5]` |
| 46 | Meter điện/nước | `building_utility_accounts` **33 row / 32 alive**; `idx_bua_building_type` là index **THƯỜNG, không unique** ⇒ nhiều meter cùng `(building, type)` là hợp lệ; **1 cặp** đang có 2 meter; max = 2. DEMO: **2 meter** (1 ELECTRIC + 1 WATER), **cả hai `provider_code` NULL** | Khoá unique phải theo meter, không theo toà | `[A8.V2]`, `[A4.R9]` |
| 47 | Phiếu điện/nước | **67 phiếu non-cancelled / 29 meter / 0 phiếu thiếu `utility_account_id`**, `voucher_date` từ **2026-03-12** tới **2026-07-22**; 78 tổng / 72 alive (5 CANCELLED, 0 UNAPPROVED alive) | — | `[A8.C6]`, §7 (đo lại 30/07) |
| 48 | Item thiếu kỳ dịch vụ | **3 phiếu APPROVED** khớp matcher có hạng mục thiếu `start_date`/`end_date` (bản audit ghi 5 **hạng mục**), trong đó toà `cb6592d8-f91c-469a-96e9-7df22485c6ee` category `quan_ly` có **3 phiếu APPROVED cùng month NULL** = một ô trùng ba **vô hình** | `C-READ-3` | `[A8.R6]`, `D1`, §7 (đo lại 30/07) |
| 49 | `supabase_migrations.schema_migrations` | **360 row**, `max_version = '20260716170000'` — **không một migration nào của 29–30/07 được ghi sổ**, trong khi **22 file `20260730*` đã apply** (xác minh bằng catalog: `cashbook_closures`, `org_accounting_mode`, `income_expense_change_log`, `a02_ie_profit_lock_*`, `ie_annotate_scope_delta_guard` đều tồn tại) | **"Vắng sổ" ≠ "chưa apply"** — mọi kiểm tra "đã apply chưa" phải dùng catalog | `[A7.R8]`, `C-INFRA-12` |

### 7.3 Điện/nước trùng — số phụ thuộc CÁCH KHOÁ (giải quyết D2)

Đo lại 30/07 trên đúng tập 67 phiếu `utility.bill` non-cancelled:

| Cách khoá | Số ô trùng | Chi tiết |
|---|---:|---|
| `(meter, type, **tháng của KỲ DỊCH VỤ** = `date_trunc('month', min(item.start_date))`)` | **2** | meter `fea1d2f4-ef50-4017-8a8d-972df2003189` ELECTRIC **2026-05** (2 phiếu, 14.371.816đ, cùng `voucher_date` 27/05) và **2026-06** (2 phiếu, 14.421.668đ, cùng `voucher_date` 28/06) |
| `(building, type, **tháng kỳ dịch vụ**)` | **3** | toà `d76268b2-9513-460d-bd2d-149e613de1ac` ELECTRIC 2026-05, 2026-06, 2026-07 |
| `(meter, type, **tháng của `voucher_date`**)` | **4** | thêm meter `246ef582-…` WATER 2026-07 (2 phiếu, 11.551.269đ) và meter `89775d46-…` ELECTRIC 2026-07 (2 phiếu, 10.643.000đ) |
| `(building, type, **tháng của `voucher_date`**)` | **5** | thêm toà `407328f0-…` ELECTRIC 2026-07 và `59c6fc2c-…` WATER 2026-07; riêng ô `d76268b2-…` ELECTRIC 2026-07 gồm **2 phiếu trên 2 METER KHÁC NHAU** — hợp lệ dưới unique index theo meter nhưng **phá khoá tổng hợp theo toà** và phá mẫu số của tỉ lệ supplier/tenant |

**`meter 02660728-6325-4f45-b9d4-dc96352d10fb` KHÔNG trùng** — đo lại cho **đúng 1 phiếu mỗi tháng**:
2026-05 = 7.929.684đ, 2026-06 = 8.441.194đ, 2026-07 = **7.305.077đ**. Vậy con số *"4 phiếu /
7.308.077đ trên meter `02660728…`"* của một auditor **KHÔNG tái lập**: 7.308.077 gần như chắc chắn là
lỗi chép của **7.305.077** (một phiếu tháng 07), và "4 nhóm" trùng với **4 ô theo khoá voucher-month**
chứ không phải 4 phiếu trên một meter.

⇒ **Kết luận cho plan**: phải **chốt khoá trước khi viết unique index và conflict backfill**. Nếu khoá
theo **kỳ dịch vụ** thì backfill là **2 ô**; nếu khoá theo **`voucher_date`** thì là **4 ô**. Chênh 2×.
`D2`, `[A4.R3]`, `[A8.C6]`, §7 (đo lại 30/07).

### 7.4 Ba ca hoàn cọc thật của org thật, và độ lệch hai chiều

Org thật có **đúng 3** termination `refund_amount > 0`; **2/3 lệch với phiếu chi thật, theo hai chiều
ngược nhau**:

| Termination | Hợp đồng · phòng | `refund_amount` (GENERATED) | Phiếu chi thật | Lệch | Trạng thái phiếu |
|---|---|---:|---|---:|---|
| `ec0e00e7-35b2-47e3-897e-1e09b745e88c` | `69cdb5dc-886e-43dc-b7b5-b526cf894edb` · 417LVT / **L04** | **2.428.500** | `PC2607119` (`da42f5d6`) **1.450.000** — 1 item `accounting_class='DEPOSIT'` *"Trả lại khách (cọc sau khấu trừ)"* | **−978.500** | APPROVED + POSTED, `active_posting_id_v2 = f6d0de10-…` |
| `a1ee1eb7-a7f8-427b-be5e-c1406e91012c` | `06440526-ccd6-4ea2-a68f-e11625d04990` · 481NVK / **09** | **2.352.000** | `PC2607104` (`c6e42df0`) **2.852.000** — **2 item**: `6dbb6a70` `DEPOSIT` 2.352.000 *"Hoàn cọc thanh lý"* + `2f5c0e23` `PNL` **500.000** *"Hoàn tiền thừa thanh lý"* | **+500.000** | APPROVED + POSTED |
| `c4c69c17-4f34-4f0b-9224-c1fd2e786d8a` | `5f8b433f-8a80-4400-82d6-0e043aabfd73` · 102LVT / **103** | **3.509.500** | `PC2607153` (`975a5afb`) **3.509.500** | **0** | **UNAPPROVED + UNPOSTED** |

**Nguyên nhân cấu trúc của ca −978.500** (`[A0.R1]`, HIGH): cọc duy nhất từng ghi cho HĐ `69cdb5dc` là
phiếu ảo đầu kỳ `PT2607060` (`system_source='contract.deposit'`, APPROVED nhưng
`posting_status='NOT_APPLICABLE'`, 1 item `DEPOSIT` **1.450.000**, description *"Tiền cọc đầu kỳ (khách
đã đóng trước khi dùng phần mềm)"*), trong khi `contracts.total_deposit = 3.500.000`. Phía khấu trừ là
phiếu `PC2607118` *"Cấn cọc chuyển doanh thu"* **1.071.500**, `system_source='termination.offset'`,
**`approval_status='CANCELLED'`, `posting_status='NOT_APPLICABLE'`** — nhưng
`contract_terminations.early_termination_fee = 1.071.500` **vẫn nuôi công thức GENERATED**. Tức
`2.428.500 = 3.500.000 (chưa bao giờ thu) − 1.071.500 (chưa bao giờ vào sổ)`.

**Hệ quả cho gate**: `[X7.6]` chốt — phải thêm ca **+500.000** (2.352.000/2.852.000) vào gate hồi quy
§7.1 bên cạnh ca 2.428.500/1.450.000; và **không có một ca POSTED canonical đúng nào trên production**
để làm mốc ⇒ gate "exact hash/amount" của Slice 5 **phải dựng fixture DEMO**. `[A4.C8]`, `[A0.C2]`
(`[X0.2]` **bác** phần "`canonical_amount = item_sum` làm ca `a1ee1eb7` sai 500.000" vì plan đã giữ
lại canonical amount khỏi subject legacy; residual là khe spec ở Task 4 Step 3 — thiếu subtotal riêng
cho lớp DEPOSIT → `C-DEP-2`).

**Số hoàn đã vào sổ, correlate được với hồ sơ**: chỉ **2 phiếu / 4.302.000đ** (1.450.000 + 2.852.000),
100% ở `aaaa`.

### 7.5 Ô KPI `/deposits` — số theo org (giải quyết D4)

| Đo | `aaaa` | `dddd` | Ghi chú |
|---|---:|---:|---|
| `get_refund_forfeit_summary` (cách tính hiện tại: `SUM(GREATEST(0, refund_amount)) FILTER (tt <> 'FORFEIT')`) | **8.290.000đ / 3 lần** | **700.000đ / 8 lần** | Reproduced đúng số 30/07 |
| Số đúng (phiếu chi **đã vào sổ**, correlate được hồ sơ) | **4.302.000đ / 2 lần** | 0 | |
| **Thổi phồng** | **+3.988.000đ** | +700.000đ | (một auditor ghi 8.990.000 / 11 lần — đó là **tổng xuyên org đọc bằng service-role**, **không người dùng nào thấy**, vì hàm là SECURITY **INVOKER** và `relrowsecurity=true` trên `contract_terminations`/`contracts`/`rooms`) |

`D4`, `[A0.C3]`, `[X0.3]`, §7 (đo lại 30/07).

Ba hợp đồng DEMO `HD-2026-00008 / 00001 / 00002` (50.000 / 40.000 / 30.000đ) đang hiện **"Đã hoàn"** chỉ
vì `refund_date`; phiếu chi **có tồn tại** (`PC2607001` `2be6ee5b`, `PC2607008` `6e84e37f`,
`PC2607010` `f1c6dd9b`) nhưng **UNAPPROVED / UNPOSTED, `account_id` NULL**, và item xếp sai lớp
(`accounting_class='PNL'` thay vì `DEPOSIT`). Hai hợp đồng DEMO `HD-2026-00015` / `HD-2026-00016`
(`ba7e21ea`, `3eb5e759`, Tòa DEMO A / A101, A102) có `refund_amount = −2.241.000` nhưng trang hiện tick
xanh **"Đã hoàn 0 đ"** vì nhánh REFUND clamp `Math.max(0, …)` và chỉ nhánh FORFEIT có hiển thị
"còn nợ" (`DepositsPage.tsx:448` `stillOwed` chỉ dùng trong nhánh `r.kind === "FORFEIT"` `:474-484`).
`[X0.1]`, `[A0.R4]`.

### 7.6 DEMO gần như trống — Slice 3 không chạy được như viết

| Hạng mục | `aaaa` | `dddd` |
|---|---:|---:|
| `building_fee_accounts` | 109 | **0** (21/21 ô toà×kind không có row) |
| `building_utility_accounts` | 30 | **2** (cả hai `provider_code` NULL) |
| Phiếu `utility.bill` | 67 non-cancelled | **0** (2 dòng soft-deleted) |
| Phiếu phí cố định do `pay_period_fee` sinh | 2 (đã xoá) | 0 |
| Toà | 18 | 3 |
| `income_expenses` alive | 2.205 | 323 |
| Sổ quỹ sống | 21 + | **6**, trong đó **5** có binding CUSTODIAN đang mở |
| Termination | 28 | 9 (gồm **cả** 1 DRAFT + 1 PENDING_APPROVAL duy nhất của toàn hệ) |

⇒ `[A4.C4]` xếp BLOCKER: mọi submit trên DEMO trả `CONFIG_REQUIRED` trước khi tới posting adapter.
`[X7.2]` **BÁC kết luận** *"nên money write đầu tiên sẽ âm thầm rơi vào org thật"* — plan đã gate DEMO
CANARY trên *"owner publish config DRAFT→PUBLISHED và fixture cleanup"* (`P1:237`) và giới hạn fixture
trong `dddd0000-…0001` (`:238`, `P2:248/:251`); và tiền đề "DEMO không có sổ quỹ" là **sai** (DEMO có
**6** sổ sống, 5 có CUSTODIAN). Hành động còn lại: **đặt tên bộ fixture DEMO thành một checklist của
Slice 3** (rule version đã publish, cả hai `provider_code`, chuẩn AC/máy giặt, trần điện/nước, cap Sale).
Mức INFO. `[A4.R9]`.

---

## 8. Hạ tầng kiểm thử và gate — hiện trạng

### 8.1 Gate đã tồn tại và trạng thái chạy thật (30/07)

| Script | Trạng thái chạy | Nó thật sự kiểm gì / giới hạn |
|---|---|---|
| `npm run typecheck:baseline` | **XANH** — *"✅ Tập lỗi TS khớp baseline (30 fingerprint). Không có gì thay đổi."* exit 0 | Đọc **`ts-baseline.json`** (tập **fingerprint**, 3.658 B, 30 fingerprint / 25 file), **không** đọc `ts-baseline.txt` (file chết 4 byte, nội dung `"74"` — không khớp cả 72 dòng lỗi thô lẫn 30 fingerprint). `check-ts-baseline.mjs:33` chạy `tsc --noEmit --pretty false -p tsconfig.app.json`. **Cross-check ở `:43`/`:70-76` không bao giờ chạy**: nó chờ regex `/Found (\d+) errors?/` mà toolchain này **không in dòng đó** ⇒ drift định dạng sẽ **âm thầm đếm thiếu** thay vì fail. `[A1.V15]`, `[A1.C12]`, `[A1.R3]` |
| `node scripts/check-view-invoker.mjs` | **XANH** — *"Views public: 12 \| security_invoker=true: 12 ✅"* exit 0 | `:27` `WHERE n.nspname = 'public' AND c.relkind = 'v'` — **chỉ schema `public`**. Hai view trong `app_private` **hiện đều có** `security_invoker=true` ⇒ chưa rò, nhưng gate **không thấy** chúng. `[A1.V16]`, `[A1.C8]`, `[X1.5]` |
| `node scripts/check-definer-acl.mjs` | **XANH** — *"✅ Không có SECURITY DEFINER anon-executable mới ngoài allowlist (56 khớp baseline)"* exit 0 | `:15-18` `WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')` — **chỉ `public`, chỉ role `anon`**. Vùng mù đo được: `app_private` có **236** hàm DEFINER, trong đó **30** `authenticated` EXECUTE được và **19** `anon` EXECUTE được, cộng **287** hàm DEFINER `public` ở dải authenticated-nhưng-không-anon ⇒ **gate không thể chứng minh** bất kỳ REVOKE nào mà Step 6 khẳng định. `[A1.V16]`, `[X1.5]` |
| `node scripts/check-approver-provenance.mjs` | Có file (3.813 B) | **Không phải gate phát hiện object** mà là **truy vấn dữ liệu**: `:41-56` đếm row `income_expenses` có `approval_status='APPROVED' AND approved_by IS NULL AND system_source IS NULL` từ `CUTOFF = '2026-07-23'` (`:25`). Header `:12-14`: *"phiếu do người tạo mà thiếu approver = writer legacy sống lại ⇒ fail"* ⇒ **phiếu auto-approve của Plan 1 PHẢI set `system_source`** trên chính dòng voucher, không chỉ ghi audit action. `[A1.R6]`, `C-INFRA-10` |
| `node scripts/check-permission-catalog.mjs` | Có file; là **CI step bắt buộc** `.github/workflows/ci-gates.yml:135-138` (khi có PAT) | Chống "khoá quyền vô hình với FE" (26/07 đo được 11 khoá thiếu). **Vắng khỏi §8 của bản 29/07**. `[A7.C9]`, `[X6.8]` |
| `node scripts/check-stable-fn-locks.mjs` | Có file; **KHÔNG có CI coverage** | Header `:1-14`: *"GOTCHA đã có án lệ (5 lần)… CHẠY SAU MỌI MIGRATION TẠO/SỬA HÀM. Exit 1 nếu có hàm hở."* Cùng luật với `20260730280000_stable_fn_row_lock_regression.sql:57-89` (DO-block đệ quy 4 tầng, `RAISE EXCEPTION 'Còn hàm public khai STABLE/IMMUTABLE mà chạm khoá dòng — sẽ ném 25006 qua PostgREST: %'`). Danh sách hàm hở hiện tại = `[]` (xanh). **Vắng khỏi §8**. `[A7.C9]`, `[A7.R2]`, `[X6.8]` |
| `node scripts/reconcile-money.mjs` / `-v2.mjs` | Có file (14.089 B / 12.572 B); **SELECT-only** (grep DML = 0 hit; v2 bọc `BEGIN; SET TRANSACTION READ ONLY`) | Header `:29-31`: *"DATASET GUARD: … không có kỳ nào >1000 thì **THOÁT 3 (INCONCLUSIVE)** — KHÔNG báo xanh giả."* `:82-88` đòi `SUPABASE_TEST_EMAIL`/`SUPABASE_TEST_PASSWORD` (fallback: parse từ `CLAUDE.local.md`), `:160` `sb.auth.signInWithPassword` ⇒ **không headless-CI-safe** như `check-view-invoker`. Hai plan phát biểu tuyệt đối (*"zero money drift"*, `P2:183/:217`) ⇒ phải định nghĩa pass = **exit 0**, và **exit 3 KHÔNG phải pass**. `[A1.R4]`, `C-INFRA-11` |
| `scripts/gen-supabase-types.mjs` + `scripts/__tests__/gen-supabase-types.test.ts` | **5 test PASS** | `:9` `GENERATED_TYPES_HEADER`, `:68-79` strip-rồi-prepend header, `:192` `outputPath = src/integrations/supabase/types.ts`, `:228-229` build + `atomicWriteUtf8`, `:166` `await rename(tempPath, targetPath)` ⇒ **tự ghi atomically, tự thêm header**. `AGENTS.md:29-30` **vẫn** ghi lệnh redirect cũ (`npm run gen:types > src/integrations/supabase/types.ts` rồi thêm lại header) — cần sửa. `[A1.V12]`, `[A1.V13]` |
| `scripts/apply-sql.mjs` | Có file, **34 dòng** | `:8` usage **chỉ** có `<file.sql>`; grep `dry-run\|dryRun\|DRY_RUN` = **0 hit** ⇒ **không có thông điệp `--dry-run` nào để bỏ** (task "bỏ usage giả" là **no-op**); khuyết tật thật là `:20` `const ref = 'tryymsxyyckgbrmmvozx';` hard-code production, không confirm, không release metadata. `[A1.V11]`, `[A1.C7]`, `[A7.V1]` |

### 8.2 Mười ba script mà hai plan + decision record gọi tên — KHÔNG tồn tại

Kiểm trực tiếp 30/07 (`[ -f scripts/<name>.mjs ]`): **13/13 ABSENT**

```text
ABSENT  scripts/test-special-page-runtime.mjs
ABSENT  scripts/test-special-fee-rules.mjs
ABSENT  scripts/test-special-fee-writer.mjs
ABSENT  scripts/test-special-fee-concurrency.mjs
ABSENT  scripts/test-contract-transfer-segments.mjs
ABSENT  scripts/test-termination-obligations.mjs
ABSENT  scripts/test-termination-refund-reads.mjs
ABSENT  scripts/test-termination-refund-special-page.mjs
ABSENT  scripts/test-room-lifecycle.mjs
ABSENT  scripts/audit-special-fee-rollout.mjs
ABSENT  scripts/audit-room-lifecycle-rollout.mjs
ABSENT  scripts/check-technical-membership-isolation.mjs
ABSENT  scripts/rehearse-sql.mjs
```

(bản audit vùng 1 ghi *"10 script"* — hợp của toàn bộ 3 tài liệu plan là **13**.) 12 tên đầu đến từ
`danh-gia-2-plan-thu-tien.md` §8; `rehearse-sql.mjs` đến từ danh sách file của Plan 1 §2.1.
⇒ Toàn bộ khối lệnh §8 của bản 29/07 hôm nay **không chạy được**. `[A1.V14]`, `[A1.V17]`, §8 (đo lại 30/07).

### 8.3 Vitest: có harness component, và đang có test ĐỎ sẵn

**Tiền đề của plan ĐÚNG**: `@testing-library/react`, `@testing-library/dom`, `@testing-library/jest-dom`,
`jsdom`, `happy-dom`, `@vitest/browser` **đều vắng** khỏi `package.json` **và** `node_modules`. Không có
file `vitest.config.*`; cấu hình nằm trong `vite.config.ts:49-60` và **chỉ** có `exclude` — **không**
`environment`, **không** `setupFiles`, **không** `globals` ⇒ chạy môi trường `node` mặc định.
`[A1.V7]`, `[A1.V8]`, `[A6.V10]`.

**Nhưng kết luận của plan SAI**: repo **đã có** một harness render component chạy được, dùng bởi
**15 file** (`renderToStaticMarkup` từ `react-dom/server`, khuôn mẫu chuẩn ở
`BuildingFilterSelect.test.tsx:19-27`: `createElement` + `renderToStaticMarkup`, dep stub bằng `vi.mock`):

```text
src/components/auth/__tests__/RequirePermission.test.tsx
src/components/buildings/__tests__/BuildingFilterSelect.test.tsx
src/components/finance-analysis/__tests__/DeltaBadge.test.tsx
src/components/finance-performance/__tests__/  (8 file: BuildingPerformanceTab, BusinessOverviewTab,
   CollectionsDebtTab, DataDefinitionsAndStates, DataDefinitionsTab, OccupancyVacancyTab,
   RevenueCostStructureTab, TrendsComparisonTab)
src/lib/__tests__/businessPerformanceNavigation.test.ts
src/pages/reports/__tests__/FinanceReportsPage.test.tsx
src/pages/reports/finance/__tests__/ProfitHubMobile.test.tsx
src/pages/reports/finance/__tests__/ProfitHubPage.test.tsx
```

Tương phản định lượng: **12 assertion / 4 file trong 1,54 s** ở môi trường `node`, so với việc plan đẩy
cùng những invariant đó sang Playwright chạy **90 giây** trên production. `[A1.C6]` (HIGH), `[X1.4]`
(sửa "7×finance-performance" → **8**), `D-REUSE-9` → `B13`.

**Spec ĐỎ sẵn ở HEAD** (`[A1.C9]`): `npx vitest run` → *"Test Files 1 failed | 165 passed (166) ·
Tests 2 failed | 2021 passed (2023)"*. File đỏ: `src/components/buildings/__tests__/BuildingFilterSelect.test.tsx`
(`:38` và `:45`). Nguyên nhân: component nay truyền thêm field —
`BuildingFilterSelect.tsx:55-57` gọi `useBuildings({ enabled: …, includeVirtual })` (thêm bởi commit
`5b14e9a` *"ô lọc toà nhà chọn được toà ảo"*) trong khi test vẫn assert `toHaveBeenCalledWith({ enabled: false })`
/ `({ enabled: true })`. `git status --porcelain -- src/components/buildings/` **rỗng** ⇒ **đỏ đã được
commit**, không phải artifact local. `[X1.4]` lưu: hai failure này **xác nhận** harness hoạt động
(component đã render, mock đã bắt được call) chứ không phủ định nó.

⇒ Mọi gate viết dạng *"vitest xanh mới apply"* hiện **không thể thoả**. Phải hoặc sửa 2 assertion đó,
hoặc phát biểu gate theo **tập file cụ thể**.

**Gate under-run âm thầm** (`[A1.C11]`): positional của Vitest CLI là **filter tên file, không phải
đường dẫn bắt buộc**. Lệnh ở `danh-gia:242` nêu 3 file, **2 file không tồn tại**
(`src/hooks/__tests__/specialFeeRouting.test.ts`, `terminationRefundRouting.test.ts`) ⇒ lệnh chạy 1/3
file và **vẫn exit 0**. Tương tự `:240`, `:241`, `room-lifecycle-refund.md:262`. File **vắng**:
`src/lib/__tests__/specialFeeRules.test.ts`, `specialFeeRules.property.test.ts`, `roomLifecycle.test.ts`,
`roomLifecycle.property.test.ts`, `terminationRefundStatuses.test.ts`, helper
`src/lib/terminationRefundStatuses.ts`. File **có**: `useRealtimeDataSync.test.ts`,
`src/lib/__tests__/financeV2AdaptersMigration.test.ts`, `src/lib/feeCategories.test.ts`.

### 8.4 `useRealtimeDataSync.test.ts`: mở rộng = viết lại 3 assertion

File **tồn tại (14.920 B), đã tracked (commit `678d4ab`), sạch, 23 test PASS trong 23 ms**. `[A1.V6]`.

| Assertion | Vấn đề khi thêm bảng/key |
|---|---|
| `:252-267` `expect(registeredTables).toEqual([…11 tên chính xác, đúng thứ tự])` | Thêm 3 bảng ⇒ **đỏ** |
| `:437-446` `expect(invalidatedRoots()).toEqual(["contracts","contracts-legacy","deposit-dashboard","unpaid-invoices","dashboard-alerts","recent-activities","dashboard-summary","occupancy-dashboard"])` + `:456` `toHaveBeenCalledTimes(8)` | Thêm key vào entry `contracts` ⇒ **đỏ cả hai** |
| `:117-143` / `:271-281` ma trận `it.each` Business-Performance theo từng tên bảng | Bảng mới phải thêm vào đây, không thì hình `it.each` trôi |

**Giới hạn harness**: `:7` `type RealtimeHandler = () => void;`, `:183-186` `triggerTable` gọi handler
**không tham số**, `:27-29` `vi.mock("react", () => ({ useEffect: harness.useEffect }))` cung cấp **chỉ**
`useEffect` ⇒ hook nào cần `useRef`/`useCallback`/`useMemo` sẽ throw *"does not provide an export named"*,
và mọi hook đọc payload nhận `undefined`. `[A1.C4]`, `[A1.C5]`, `C-INFRA-8`.

Chỉ thị bắt buộc kèm theo: **KHÔNG nới `toEqual` thành `toContain`** — chính chúng là thứ chứng minh
không bảng nào đăng ký hai lần và không key nào bị bỏ sót.

### 8.5 Realtime hub — hiện trạng

| Sự thật | Bằng chứng |
|---|---|
| Hub **cố ý bỏ payload**: callback `postgres_changes` ở `:312` là `() => {` **không tham số**; header `:16-18` *"Payload realtime bị bỏ qua hoàn toàn — event chỉ là tín hiệu invalidate cache"*, `:17-18` *"Không dựa vào payload hoặc việc nhận event DELETE để phân quyền"* | `[A1.V1]`, `[A7.V8]` |
| Invalidate theo **prefix trần, không scope org**: `:277-281` `qc.invalidateQueries({ queryKey: key })` với key kiểu `["income-expenses"]`, `["accounts-with-balance"]`; ngoại lệ duy nhất `["business-performance"]` (`:270-274` predicate theo `queryKey[2]`/`[4]`) — vẫn **không** theo org | `[A1.V2]` |
| `payload.old.organization_id` **KHÔNG THỂ tồn tại**: cả 21 bảng trong publication có `pg_class.relreplident='d'` (DEFAULT) và mọi PK là **một cột, chưa bao giờ là `organization_id`** | `[A1.C2]`, `[X1.2]` |
| Quyết định bỏ payload là **có chủ ý và đã ghi**: `20260730230000_realtime_money_tables.sql:26-28` *"Cố ý KHÔNG đặt REPLICA IDENTITY FULL … phát thêm dữ liệu là rủi ro thuần tuý không đổi lấy gì"* — nhưng **không gate nào** cưỡng chế ⇒ ai flip sang FULL sẽ đảo ngược **âm thầm** | `[X1.2]` |
| Publication `supabase_realtime`: `puballtables=false`, **21 rel** (`accounts, buildings, cash_handovers, contracts, customers, income_expense_items, income_expenses, invoices, jobs, network_command_events, network_device_current, network_incidents, network_interface_current, network_worker_heartbeats, notifications, payments, rooms, zalo_accounts, zalo_conversations, zalo_labels, zalo_messages`) | `[A1.V4]`, `[A1.V5]`, `[X1.3]` |
| **3 bảng plan muốn nghe đều KHÔNG trong publication**: `contract_terminations`, `contract_transfers`, `building_utility_accounts` — cả ba có `relrowsecurity=true`, có PK, có 1/3/3 policy SELECT ⇒ `ALTER PUBLICATION ADD TABLE` khả thi. Gọi `supabase.channel().on()` trên bảng ngoài publication **thành công và không bao giờ fire** — không lỗi, không warning, không assertion đỏ | `[A1.C3]` (HIGH), `[X1.3]`, `[A7.C10]` → `B25` |
| Khuôn mẫu ALTER PUBLICATION idempotent **đã có sẵn**: `20260730230000_realtime_money_tables.sql` loop VALUES, `CONTINUE` khi đã có, `RAISE EXCEPTION` khi `NOT c.relrowsecurity` (*"Bảng public.% chưa bật RLS — KHÔNG đưa vào publication realtime"*), rồi `EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', …)` | `[A1.V18]`, `D-REUSE-6` |
| **4 query key phí kỳ ĐANG TỒN TẠI bị thiếu** khỏi hub: entry `income_expenses` (`:124-161`) có `['utility-payments']` (`:131`) và `['utility-accounts']` (`:132`) nhưng **không** có `['period-fee-status']`, `['period-commissions']`, `['period-maintenance']`, `['fee-accounts']`; `building_fee_accounts` và `building_utility_accounts` **không có** trong `SYNC_TABLES`. Luật của chính file (`:99-101`): màn nào đọc các bảng này dưới first-key khác **phải** được liệt kê, không thì serve stale | `[A6.V11]`, `[A6.C11]`, `C-INFRA-7` |
| `hubActive` là **singleton cấp module**: `:293` `let hubActive = false;`, `:301` `if (!userId \|\| hubActive) return;` — instance thứ hai **return undefined, không đăng ký cleanup**; `:345-351` cleanup của instance thứ nhất set `hubActive=false` + `supabase.removeChannel(channel)` ⇒ instance còn sống **mất subscribe vĩnh viễn**. Hôm nay mount đúng một lần (`src/App.tsx:236 <RealtimeDataSync />`) nên invariant còn giữ, nhưng **không test nào phủ ca hai consumer**. `:343` là `channel.subscribe()` trần **không status callback** ⇒ `CHANNEL_ERROR` không bao giờ nổi lên | `[A1.R2]` (HIGH), `C-INFRA-6` |
| Tài liệu bản đồ **đã cũ**: `docs/he-thong/realtime-sync.md:32-33` vẫn liệt `accounts` và `payments` dưới *"Chưa có realtime"* dù `20260730230000_realtime_money_tables.sql` đã thêm cả hai; mà `useRealtimeDataSync.ts:102` chỉ implementer sang đúng file đó | `[A1.R5]`, `C-INFRA-7` |

### 8.6 `.e2e-fleet` — hợp đồng và vùng mù

| Sự thật | Bằng chứng |
|---|---|
| Headless mặc định; `FLEET_WORKERS` default **8**; `FLEET_BASE_URL` default `https://ptcrm.vercel.app`; `slowMo 350` **chỉ** khi `FLEET_HEADED` | `playwright.config.ts:10/:14/:15/:16`, `[A1.V10]` |
| Password **chỉ** từ `FLEET_PASS_CHUNHA/KETOAN/QUANLY`, throw tiếng Việt tường minh khi thiếu, **không literal trong repo** | `specs/auth.ts:19-23`, `:30-39` |
| **Không có `package.json`, không có `tsconfig.json`** trong `.e2e-fleet` ⇒ **7 spec mới nhận ZERO typecheck** trong khi `npm run typecheck:baseline` vẫn báo xanh. `tsconfig.app.json` `"include": ["src"]` + `"strict": false` + `"noImplicitAny": false`; `tsconfig.node.json` chỉ `["vite.config.ts"]`; `tsconfig.json` là `"files": []` + references | `[A1.R1]`, `C-INFRA-9` |
| Playwright resolve `@playwright/test 1.61.1` từ `node_modules` gốc; browser có sẵn local (`chromium-1217`, `chromium-1228`, `chromium_headless_shell-1217/1228`, `ffmpeg-1011`, `winldd-1007`) nhưng **không gì pin hay verify revision**, và **không có `postinstall`/`playwright install`** | `[A1.R7]` |
| 32 file trong `.e2e-fleet/specs/`. **Cả 7 tên spec mới của plan đều VẮNG**: `room-lifecycle`, `termination-refund-special-page`, `deposit-refund-status`, `special-fee-fixed`, `special-fee-utility-warning`, `special-fee-commission-maintenance`, `special-fee-scope-isolation` | `[A1.V17]` |
| `utility-paste-receipt.spec.ts` (8.443 B) **thật sự phụ thuộc CẢ HAI surface**: `:36-38` comment thứ tự mount; `:151-171` click desktop `.ud-amt` (`:158`) → mở `.tt-phone-col .ptt-go` (`:159`) → paste vào card mobile (`:163-164`) → assert dòng desktop **KHÔNG** nhận (`:169`); `:173-185` `toHaveCount(1)` trên hint toast | `[A1.V9]`, `[A6.C2]` |
| `thanh-toan-page.spec.ts` **tồn tại và assert cả hai surface visible** (`:20` tên test *"deep-link /thanh-toan: panel desktop + sheet mobile cùng render"*, `:27` `.ptt-panel` visible, `:32` `.tt-phone-col .ptt-sheet` visible, `:143` `toBeHidden()` ở mobile) — **hai plan không liệt kê file này** vì nó chưa tồn tại khi viết plan | `[A6.C3]`, `[X5.3]` |
| Arbitration paste **đã được vá 28/07** và **không** double-fire: `useReceiptPasteTarget.ts:5-17` khối GOTCHA, `:27-31` `hoverTarget`/`focusTarget` cấp module, `:86-87` `const t = hoverTarget ?? focusTarget; if (t && t.owner !== owner) return;`, `:91-93` `if (marked.__receiptPasteHinted) return;` ⇒ **"sửa double-fire" là sửa một khuyết tật không tồn tại**, và tháo arbitration sẽ **làm sống lại** bug 28/07 | `[A6.C2]` (HIGH), `[X5.2]` |

### 8.7 Khoảng trống xác minh phải ghi rõ

**KHÔNG có phiên browser/E2E nào được chạy trong cả 10 vùng audit** (mandate read-only). Mọi khẳng
định về UI trong tài liệu này dựa trên **dòng source + dữ liệu live + assertion của spec đã tracked**,
**không** dựa trên một trang đã render được quan sát.

---

## 9. Rủi ro chưa có plan nào phủ

91 hazard, nhóm lại dưới đây. Mức giữ nguyên theo audit, trừ chỗ ghi rõ đã bị `audit-cross` hiệu chỉnh.

### 9.1 Nhóm A — Tiền và số hiển thị trên `/thanh-toan`

| ID | Mức | Rủi ro |
|---|---|---|
| `[A6.R1]` · `E7` | **BLOCKER** | **Điện/nước: phiếu vô hình + bấm lại vô hạn.** `pay_utility_bill` sinh UNAPPROVED khi `p_amount >= threshold` (org thật **600.000đ** từ 29/07 09:39:56Z), bảng EN chỉ đọc APPROVED (`useUtilityBills.ts:304`), và hàm **không có bất kỳ kiểm tra trùng nào**. 64/72 phiếu alive ≥ 600k. Chưa nổ ở org thật vì phiếu cuối tạo 22/07; **đã nổ một lần ở DEMO** (`PC2607039` 8.000.000). |
| `[A6.R2]` · `E7` | **BLOCKER** | **Bảo trì: cùng hình dạng.** `ie_compat_insert_v2` ép `approval_status='UNAPPROVED'` bất kể số tiền; `get_period_maintenance` lọc APPROVED ⇒ tab hiện *"Kỳ này chưa có phiếu bảo trì"* ngay sau khi tạo. Không unique, không cadence, không chiều phòng. Live: 91 phiếu bảo trì APPROVED+POSTED, **0 UNAPPROVED** ⇒ UI batch **chưa từng được dùng** kể từ khi compat writer lên. |
| `[A8.R1]` · `C-READ-2` | HIGH | Phiếu đa-hạng-mục cộng **đủ tổng phiếu** vào **từng** ô category. Ca thật: `5916661a-…` *"Tiền Điện + Tiền nước"* 6.384.000 vào **cả** ô Điện **và** ô Nước. |
| `[A8.R2]` / `[A6.R3]` / `[A6.R7]` · `C-READ-1` | HIGH | `fee_type_matches` khớp sai: `quan_ly` ăn *Lương quản lý* (34.206.744đ, 2 phiếu) và *Ứng lương quản lý*; `dien` ăn *Mua tủ lạnh* (3.424.000đ) và *"thanh toán tiền điện lạnh"* (chính họ AIR_CONDITIONER của plan); `ve_sinh` ăn *Vệ Sinh Phòng* (620.000đ) + *BTaskee* (300.000đ); `rac` ăn *Rửa thùng rác* (60.000đ) + *Bỏ rác* (300.000đ). **5 phiếu `system_source='salary.staff'` đang được báo là `quan_ly` đã đóng.** Ở DEMO không có type *Quản Lý* nên `resolve_fixed_expense_type('quan_ly')` chọn *Lương quản lý* ⇒ một lần đóng Quản Lý sẽ **vào sổ như lương**. |
| `[A8.R6]` · `C-READ-3` | MEDIUM | Item thiếu `start_date`/`end_date` ⇒ **cả reader lẫn chốt chống trùng đều mù**; ô trùng ba vô hình ở toà `cb6592d8-…` `quan_ly`. |
| `[A6.R8]` | MEDIUM | Xoá "số tiền dự kiến" **không thể** nhưng vẫn báo thành công: `saveExpected` truyền `null`, `upsert_building_fee_account` `COALESCE` bỏ null, `onSuccess` toast *"Đã lưu số tiền dự kiến"*. |
| `[A6.R12]` | LOW | `get_period_fee_status` **im lặng bỏ** category key lạ (`WHERE k IN (…9 key)`, không raise) ⇒ typo phía client cho status rỗng, render thành *"chưa đóng"*. `GRID_SERVER_KEYS` còn ship `dien`/`nuoc` mà không registry entry nào dùng làm `serverKey`. |
| `[A8.R12]` | LOW | `get_period_fee_status` quét `income_expense_types` **không có** điều kiện organization (`:41-48`); vô hại với 2 org hiện tại (0 dòng lệch org) nhưng là bẫy khi thêm org. |

### 9.2 Nhóm B — Trùng phiếu và writer legacy

| ID | Mức | Rủi ro |
|---|---|---|
| `[A6.R4]` | HIGH | **Hai surface cùng ghi được một ô** `toà × category × tháng`, mỗi bên giữ `amounts`/`bookSel`/`attach` **riêng** (`PeriodFeePanel.tsx:101` và `PeriodFeeSheet.tsx:98` gọi `usePeriodFeeState` độc lập), cộng nút **"Đóng thêm"** (`PeriodFeeVoucherList.tsx:186-189`) đi thẳng `p_force=true`. Chốt chống trùng của server **chỉ chạy trong `IF NOT p_force`** và **chỉ đếm phiếu APPROVED** (một draft UNAPPROVED không gây cảnh báo). |
| `[A6.R5]` | HIGH | **Tự tạo meter ngầm** từ nút check: `metersOf()` (`useUtilityPayState.ts:84-89`) sinh row tổng hợp `accountId=null`; `:198` truyền `utilityAccountId: null`; nhánh ELSE của `pay_utility_bill` **INSERT `building_utility_accounts` mới**. Vì `paidThisKy` key theo meter id và trả `undefined` với null, dòng đó **không bao giờ** hiện được "đã đóng". Live 0 phiếu có `utility_account_id` NULL ⇒ nhánh này **đã chạy và tự che dấu vết**. |
| `[A8.R4]` / `[A6.R10]` | MEDIUM | `cancel_period_fee` / `cancel_utility_bill` **chỉ soft-delete**, không đổi `approval_status` ⇒ tồn tại row vừa `APPROVED` vừa `deleted_at IS NOT NULL` (live: 5 `utility.bill` + 2 `fixed_fee`); trigger `a75_ie_cancel_close_request` (WHEN `new.approval_status='CANCELLED'`) **không fire**. Mọi adapter release keyed on `CANCELLED` sẽ **bỏ sót**. (Tiền vẫn đảo đúng vì a85 canh cả `deleted_at`.) |
| `[A8.R7]` | MEDIUM | Nút chi tiền **tự sửa danh mục cấp tổ chức**: `pay_period_fee:102-103` và `pay_utility_bill:83` đều `UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE` — không audit, không guard. |
| `[A8.R8]` | MEDIUM | `create_commission_voucher` chèn `p_account_id` **thô**, không một `SELECT … FROM accounts` nào trong 223 dòng body (đối chiếu `pay_period_fee:86-91` có kiểm). Phiếu ra UNAPPROVED nên chưa post ngay, nhưng `account_id` đã được ghi. |
| `[A8.R9]` | MEDIUM | `_termination_ensure_type` (vẫn dùng bởi `pay_utility_bill`) chọn org bằng `min(m.organization_id::text)` rồi một `limit 1` **không ORDER BY** ⇒ có thể gắn type sang **tổ chức khác** tổ chức của phiếu. Chưa hiện thực hoá (0 dòng lệch org). |
| `[A8.R10]` | MEDIUM | **Recurring engine đang chạy cron** `0 18 * * *` (`recurring_vouchers_daily`, active) qua `run_recurring_vouchers_job` → `generate_recurring_vouchers(NULL)` = **toàn bộ parent trong DB**: auto-approve theo `repeat_auto_approve` (64/77), **copy `attachments` của phiếu cha cho MỌI child**, `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` ⇒ **nuốt lỗi từng child**, dùng `CURRENT_DATE` (không timezone org), và **không đọc `ie_auto_approve_config`**. |
| `[A8.R3]` | HIGH | Ba writer legacy chọn sổ theo **chủ sổ** (`accounts.user_id = auth.uid() OR is_admin() OR is_super_admin()`), hoàn toàn **ngoài** mô hình CUSTODIAN của Đợt 5–6; nhánh NULL còn **tự chọn** sổ theo `name LIKE '%Thu'`. Không body nào gọi `assert_cashbook_access_v2`/`authorize_tenant_action_v3`. |
| `[A6.R6]` | MEDIUM | **Ba mô hình custody cùng tồn tại trên một trang**: `pay_period_fee`/`pay_utility_bill` (chủ sổ), `ie_compat_insert_v2` (đòi binding `CUSTODIAN`, hoặc `KNOWER` khi type INCOME), `create_commission_voucher` (sổ optional, duyệt hoãn sang `/thu-chi`). Plan 1 giả định gói cả ba vào một hợp đồng `assert_cashbook_access_v2(...,'CUSTODIAN',...)`. |
| `[A8.C5]` · `E11` | HIGH | **`cancellable` đang nói dối trên một phiếu THẬT.** `cancel_period_fee` nhận **mọi** phiếu chi alive có item khớp một trong 9 key (không chỉ `system_source` fixed/utility) rồi `UPDATE … SET deleted_at = now()` **không token** ⇒ `a00_ie_owned_payload_freeze` chặn `55000` *"canonical income expense … is frozen (update rejected)"*. Live có **9 phiếu** trong bẫy: 8 draft E2E DEMO + **1 phiếu production `PC2607096` "phí bỏ rác"** (org `aaaa`, 512LTT, 100.000, APPROVED, `system_source` NULL, `flow_kind=CANONICAL_INCOME_EXPENSE`, `in_batch=false`). Vì `get_period_fee_status:97` tính `cancellable = NOT in_batch`, UI **đang hiện nút Huỷ** cho phiếu đó. Cùng cơ chế chặn `pay_draft_fee_voucher:36-39` (ghi `account_id`, ngoài allowlist) cho 8 draft. `[X8.5]` **SỐNG**. |
| `[A6.R9]` | MEDIUM | Hai instance `usePersistedState` **chia một key sessionStorage** `'flt:thu-tien:fee-cat'` (`PeriodFeePanel.tsx:71`, `PeriodFeeSheet.tsx:73`) mà **không sync chéo** (`usePersistedState.ts:26-33` chỉ ghi theo state của chính nó) ⇒ panel desktop và sheet điện thoại có thể hiện **hai category khác nhau** cùng lúc. Thêm: `PeriodFeeSheet.tsx:96` mount `useUtilityPayState` **vô điều kiện** (không gate theo `show`/family) ⇒ query + paste listener sống cả khi đang chọn GRID. |
| `[A6.R11]` | LOW | 36,6 KB component chết (`UtilityDesktopPanel.tsx`, `UtilityBillSheet.tsx`) không phân biệt được với component sống bằng tên. |

### 9.3 Nhóm C — Finance V2, posting và adapter

| ID | Mức | Rủi ro |
|---|---|---|
| `E2` · `[A5.C3]` · `[X3.3]` | **BLOCKER** | Hợp đồng token `purpose` — xem §4.1. Adapter mới dùng `finance_v2_transition_owned_approval` ⇒ **posting trùng** `LEGACY_BRIDGE`, và vì helper DELETE token ở cuối, **mọi UPDATE `income_expenses` tiếp theo trong cùng transaction** đâm freeze guard `55000`. |
| `E8` · `[A5.C4]` · `[X3.4]` | HIGH | `dispatch_finance_decision_v2` CASE theo `adapter_name`, `ELSE 0A000`; **đã lỗi thật** cho `CANONICAL_INCOME_EXPENSE` và `UTILITY_RECURRING`. Test *"owner lạ fail-closed"* sẽ **PASS và che mất** lỗi này (nó đi nhánh 42501, không phải 0A000). |
| `E9` · `[A5.R1]` | MEDIUM | `approve_and_post_income_expense_v2` stamp `account_id = v_cashbook` lên header phiếu **có thể đang flow-owned** — `account_id` ngoài allowlist ⇒ `55000`. Bug tiềm ẩn **đang sống, độc lập với hai plan**, và là bằng chứng cứng rằng `account_id` bị guard chặn dù có token. |
| `[A5.R6]` | HIGH | Thiết kế "owned ngay tại birth rồi finalize `account_id`/`voucher_date` sau" của Plan 2 **bất khả thi** nếu không sửa thân `guard_income_expense_owned_payload`: cả hai cột đều ngoài allowlist, nhánh ANNOTATE chỉ cho `attachments/notes/updated_at`, và scope `'FLEX_EDIT'` **có trong CHECK nhưng chưa implement** trong guard. |
| `[A5.R2]` · `C-EV-4` | MEDIUM | `finance_v2_post_manual_voucher` chỉ tạo **một dòng MAIN**; cầu a85 tạo cả `CHANGE`/`ROUNDING`. Nếu core source-aware copy khuôn manual, phiếu có tiền thối/làm tròn **mất bút toán**, mà assert của plan (*"đúng một MAIN line âm cho expense"*) lại chốt cứng đúng biến thể thiếu đó. |
| `[A5.R3]` | MEDIUM | `finance_v2_post_manual_voucher` **không tự kiểm kỳ mở**; cổng kỳ nằm hết ở 6 caller public ⇒ core mới gọi từ nhiều adapter thì **không có backstop ở tầng primitive**. |
| `[A5.R5]` | MEDIUM | 213 token rác `xid` đã chết, PK một-row-một-phiếu, không job dọn ⇒ **không thể** giữ token `TERMINATION_REFUND_FINALIZE` song song token lifecycle như Plan 2 thiết kế. |
| `[A5.R7]` | MEDIUM | Hai plan **không biết** lớp `ie_flex_writer_xids` + `begin_ie_flex_write_v1`/`end_ie_flex_write_v1` (ACL `postgres=X` only) — cửa **duy nhất** để sửa `attachments`/`notes` trên phiếu owned. `D-REUSE-4`. |
| `[A5.R4]` / `[A7.R4]` · `C-INFRA-2` | HIGH | Hai cặp migration **trùng timestamp** (một tracked-đã-apply, một untracked-chưa-apply) + một trùng **tên logic** (`annotate_evidence_protection.sql` ở cả `20260730230000` và `20260730270000`). Apply file untracked `230000` sau bản đã chạy `270000` **xoá sạch lớp bảo vệ bằng chứng**. |
| `[A7.R5]` · `C-INFRA-1` | HIGH | Bẫy mẫu neo — xem §4.9. Forward-redefine mù ⇒ các migration Đợt 0–6 **mất idempotency** và gãy mọi rehearsal về sau. |
| `[A7.R3]` · `C-INFRA-3` | HIGH | WP2 (chưa apply) mở `assert_period_open_for_edit_v1` sang **kỳ dịch vụ của hạng mục** ⇒ **một phiếu trả trước cho tháng đã chốt lợi nhuận sẽ KHÔNG BAO GIỜ huỷ được**, và "chỗ" của tháng đó bị chiếm **vĩnh viễn** — đúng điều Plan 1 hứa không xảy ra. Phải quyết một trong ba: (a) child trả trước set `business_result_accounting=false`, (b) không set item period cho tháng quá khứ, (c) release claim đi đường không qua vị ngữ này. |
| `[A7.R10]` | MEDIUM | Vị ngữ ĐỌC và trigger GHI **lệch nhau** về phiếu ngoài KQKD (trigger chặn, `assert_period_open_for_edit_v1` miễn trừ) — đúng mẫu lỗi *"hàm đọc kiểm ít điều kiện hơn hàm ghi"*. |
| `[A7.R1]` | **BLOCKER** | Union type `SpecialFeeFailureCode` của Plan 1 có `CASHBOOK_PERIOD_LOCKED` nhưng **không có mã nào cho `PROFIT_LOCKED`**, trong khi khoá tháng lợi nhuận là **trigger thật** trên cả `income_expenses` và `income_expense_items`. 20/20 phiếu `termination.refund` có `business_result_accounting=NULL` ⇒ `COALESCE(...,true)` ⇒ **BỊ áp**; trong đó `voucher_date` 2026-04-30 (1 phiếu) và 2026-05-10 (2 phiếu) nằm trong dải tháng đã khoá. → `E4` |
| `[A7.R2]` | **BLOCKER** | ~8 read RPC của hai plan đều gọi `authorize_tenant_action_v3` (**có `SELECT … FOR SHARE`**) trong khi plan gọi chúng là *"read-only"*; khai `STABLE`/`IMMUTABLE` ⇒ **25006 qua PostgREST**, và `20260730280000` cài hàng rào quét toàn schema tự `RAISE`. `authorize_tenant_action_v3` hiện `provolatile='v'`; danh sách hàm hở hiện `[]`. → **mọi read RPC mới phải khai VOLATILE** (`E5`) |
| `[A7.R7]` · `C-INFRA-5` | MEDIUM | `public.invoices` và `public.payments` **vẫn GRANT DELETE/INSERT/UPDATE cho `authenticated`** (chỉ `anon` bị siết còn `REFERENCES,SELECT,TRIGGER`). Bảo vệ duy nhất là `a00_invoice_derived_guard` — canh **một** cột `paid_amount` và chỉ nổ khi `current_user IN ('authenticated','anon')`. ⇒ Sửa mọi câu plan hàm ý *"bảng tiền đã REVOKE DML"*: đúng cho 4 bảng trong `20260730102000_money_tables_revoke_dml.sql`, **không** đúng cho `invoices`/`payments`. |
| `[A7.R6]` · `C-INFRA-4` | MEDIUM | Cả hai org `strict_mode=false` ⇒ đường huỷ Đợt 4/5 **đang sống trên production**; không được giả định nhánh flex-cancel đang ngủ. |
| `[A7.R9]` · `D-REUSE-3` | MEDIUM | Nhật ký giá trị trước/sau **đã có** (`app_private.income_expense_change_log` + `z99_ie_change_log`/`z99_ie_items_change_log` + reader `get_voucher_change_log_v1` GRANT `authenticated`, 0 row vì mới cài) — plan lại định tự ghi state transition vào `income_expense_audit_log` (357 row) ⇒ **hai sổ lệch nhau**. Dùng change_log cho value-diff, audit_log **chỉ** cho chuyển trạng thái nghiệp vụ. |
| `C-EV-1` · `[A5.C7]` | MEDIUM | 0/159 evidence có `sha256`/`upload_token_hash`; `finalize_finance_evidence_v2` không bao giờ ghi chúng ⇒ **không được dùng chữ "hash"** trong bất kỳ guard nào. Hai lựa chọn: (A) ghi `sha256` thật (từ `storage.objects.metadata` eTag/checksum, hoặc client cung cấp + verify `byte_size`), (B) định nghĩa lại "vân tay evidence" = `(organization_id, bucket_id, object_name, byte_size, mime_type)`. |
| `C-EV-2` · `[A5.C9]` | MEDIUM | `log_income_expense_action(p_id uuid, p_action text, p_note text)` — **3 tham số**; `income_expense_audit_log` **không có cột jsonb**, ô tự do duy nhất là `note text`. Phải chọn dứt khoát: (A) serialize claim id / route version / config version / request hash thành JSON **text** trong `note` (mất khả năng query), hoặc (B) thêm cột jsonb + **chứng minh** chain `event_hash` của các Đợt trước không đổi. |
| `C-EV-3` | MEDIUM | Trigger sinh thứ ba `a86_finance_v2_birth_provenance` có thể `RAISE 23502`, và `a85b` **tự** insert token `FINANCE_V2_LIFECYCLE` ⇒ *"không có token sau INSERT"* **không phải trạng thái ổn định**. Phải set `organization_id` **tường minh** khi pre-allocate UUID; và wrapper cancel/reverse của special fee **KHÔNG được** tái dùng `decide_owned_income_expense_v2`. |
| `C-DEP-7` · `[A9.R6]` | MEDIUM | Adapter chết `TERMINATION_MOVE_OUT_PAIR` + 2 bảng 0 row đang **chiếm slot**; phải quyết dọn hay giữ tường minh trước khi re-point `TERMINATION_REFUND`. |
| `C-DEP-8` · `[A9.R8]` | MEDIUM | `reserve_invoice_refund_obligation_v2:80-82` còn nhánh **sinh phiếu lai** (`flow_kind='TERMINATION_REFUND'` + `lifecycle_owner='INVOICE_REFUND'` + gắn reservation theo INVOICE) — chính loại lai Plan 2 muốn cấm. |
| `E10` · `[X3.6]` | HIGH | Release adapter thiếu **2** terminal writer đã ship 30/07 (`cancel_income_expense_flex_v1` client-callable, `cancel_collection_voucher_in_place_v1`) ⇒ slot bị chiếm vĩnh viễn rồi lộ ra dưới dạng `23505` khó hiểu từ partial unique index. Vì bề mặt này **thêm 4 migration huỷ trong đúng một ngày**, trigger backstop AFTER UPDATE phải được **nâng từ backstop thành đường chính**. |

### 9.4 Nhóm D — Thanh lý và hoàn cọc

| ID | Mức | Rủi ro |
|---|---|---|
| `[A9.R1]` | HIGH | **Writer thứ tư, phía client**: `useApproveTermination` (`useContracts.ts:1119-1177`) ghi REST rồi `INSERT INTO public.cash_book` — **bảng không tồn tại** (`to_regclass` → NULL), **không transaction** ⇒ termination đã COMPLETED + contract đã TERMINATED **mà không có phiếu tiền nào**. Zero call site hôm nay, nhưng hàm + policy RLS còn sống. `[A0.R7]` bổ sung: 3 hàm termination `@deprecated` vẫn export, và fallback còn set `refund_date` **phía client** ⇒ tái tạo đúng tín hiệu "Đã hoàn" giả mà plan đang đi bỏ. |
| `[A9.R2]` | HIGH | **Hàng nguồn không được bảo vệ**: ai có `contracts.edit` trên toà đều UPDATE `contract_terminations` qua REST → đổi `outstanding_debt`/`total_deposit`/`early_termination_fee` ⇒ đổi luôn `refund_amount` GENERATED; hoặc set `status='APPROVED'` để trigger tự TERMINATED hợp đồng, **không qua writer nào**. Snapshot "bất biến" của plan chỉ bảo vệ **phiếu**. |
| `[A9.R3]` | HIGH | **Đường đổi phòng thứ hai** (trigger `trigger_apply_contract_transfer`, DRAFT→APPROVED) ghi đè `room_id`, `rent_price`, `total_deposit` **và `start_date`/`end_date`**, đặt `status='TRANSFERRED'`, `parent_contract_id=id`. Plan chỉ đọc transfer `COMPLETED` ⇒ **bỏ qua hoàn toàn**; và Task 0 Step 4 lấy `contracts.start_date` làm mốc segment đầu — **đúng cột trigger này ghi đè**. 0 dòng hôm nay nhưng RLS cho phép. |
| `[A9.R4]` | HIGH | **Guard tiền theo REGEX trên `payments.notes`** (`classify_termination_payment_v1` + trigger `a10_payment_termination_non_cash` + bảng `termination_move_out_writer_context` theo `txid+backend_pid`). Cả hai plan **không nhắc** cái nào. Đổi chuỗi note hoặc tạo `payments` ngoài cửa sổ context ⇒ guard rơi `RETURN NEW` (không kiểm gì) hoặc `55000`. Task 2 rewrite `impl` **KHÔNG được** đổi chuỗi note `'Quyết toán khi thanh lý DD/MM/YYYY'`. |
| `[A9.R5]` | **BLOCKER** | **Toàn bộ prerequisite "shared runtime" của Plan 2 KHÔNG tồn tại**: không có `resolve_signed_contract_deposit_basis_v1` (Task 1 Step 1, Task 2 Step 1, Task 3 Step 3 đều gọi), `special_page_submit_context_v1`, `finance_v2_post_voucher_with_source_v1` (Task 5 Step 5 gọi trực tiếp), `org_today_v1`, `special_page_cashbook_override_v1`, `set_feature_freeze_v1` ⇒ Task 1→5 bị chặn cứng, không chỉ "chờ Plan 1". |
| `[A9.R7]` | MEDIUM | **14/23** hợp đồng `TERMINATED` thiếu hồ sơ **VẪN CÓ** phiếu `termination.refund` ⇒ tiền đã ra mà hồ sơ thì không; `UNIQUE(contract_id)` **cho phép** tạo bổ sung một dòng hồi tố, và **không quy tắc nào** trong plan nói được/không được làm vậy. Vẫn đang phát sinh: tháng 07/2026 còn **2/18** thiếu. |
| `[A0.R1]` | HIGH | Fixture 2.428.500/1.450.000 **không phải** artifact làm tròn/cap: công thức GENERATED trừ một khoản khấu trừ **có phiếu đã CANCELLED** (`PC2607118` 1.071.500, `NOT_APPLICABLE`) trên nền cọc **hợp đồng** (3.500.000) thay vì cọc **thực giữ** (1.450.000). Mọi backfill "đối chiếu" mà tin `total_deductions` sẽ **tái tạo lại số sai**. |
| `[A0.R2]` | HIGH | Chi tiết hợp đồng **đang hiện hai số trái ngược nhau**: HĐ `69cdb5dc` có `deposit_paid = 0` (card *"Đã thu"* `ContractSummary.tsx:174`) và `refund_amount = 2.428.500` (*"Hoàn lại khách"* `:105-109`) trên **cùng một trang**. Cùng mẫu ở HĐ `5f8b433f` (102LVT/103): `total_deposit 4.000.000`, `deposit_paid 0.00`, refund 3.509.500. Task 7 Step 5 chỉ đổi nhãn **một** trong hai. |
| `[A0.R3]` | MEDIUM | Một hợp đồng có thể mang **2 phiếu hoàn cùng số tiền** (1 POSTED + 1 CANCELLED) ⇒ reader correlate theo `contract_id` (cách duy nhất hôm nay) trả **2 row cho 1 hồ sơ**, phá chính hợp đồng *"đúng một row/id"* của plan. |
| `[A0.R4]` | MEDIUM | Hai termination move-out **net âm** (`ba7e21ea`, `3eb5e759`, −2.241.000) render tick xanh **"Đã hoàn 0 đ"** thay vì "khách còn nợ": `stillOwed` chỉ tồn tại trong nhánh `FORFEIT`. Khái niệm `CUSTOMER_OWES` được định nghĩa **phía server** nhưng Task 7 **không** nói nhánh REFUND cần render. |
| `[A0.R5]` | LOW | `useContractTerminationInfo` lấy dòng termination mới nhất **không lọc status** ⇒ một DRAFT/rejected sinh sau **ghi đè** settlement đang hiện. Latent hôm nay (37 termination / 37 HĐ), nhưng chuỗi replacement/correction của Task 5 Step 7 **cố ý tạo thêm row**. |
| `[A0.R6]` | LOW | `contract_terminations` **không** trong realtime list ⇒ thay đổi chỉ chạm bảng đó (vd `approve_contract_termination_v1` flip status→COMPLETED + `refund_date`) **không** invalidate deposit dashboard ở session khác. |
| `C-DEP-9` · `[A9.R9]` | LOW | `deposits.refund` tồn tại, active, **không plan nào dùng** ⇒ phải nói rõ **vì sao** nó không phải cổng của hành động hoàn cọc (chủ có thể đã cấp/khoá nó cho kế toán), hoặc dùng nó. |
| `C-DEP-10` · `[A0.C5]` | MEDIUM | Chuyển `/deposits` sang RPC gác `deposits.view` là **đổi quyền hai chiều** so với baseline `buildings.view`; cần **2 fixture mới**: thành viên có `buildings.view` mà không có `deposits.view` (mất dòng đang thấy) và ngược lại (được thêm dòng). |
| `C-DEP-2` · `[A0.C2]` | MEDIUM | Khe spec ở Task 4 Step 3: thiếu **subtotal riêng cho lớp DEPOSIT** trên phiếu hoàn đa-lớp (ca `PC2607104`: `DEPOSIT` 2.352.000 + `PNL` 500.000 = header 2.852.000). `[X0.2]` **bác** kết luận rằng plan sẽ làm dòng đó sai 500.000 (plan đã giữ canonical amount khỏi subject legacy). |
| `[A9.C13]` | MEDIUM | `terminate_contract_move_out` (route giữa) **GRANT cho `authenticated`** ⇒ client gọi thẳng, **bỏ qua** idempotency key + payload hash + guard credit của wrapper ⇒ double-termination/double-voucher vẫn khả thi sau canonicalize, trừ khi gắn sticky-marker/idempotency vào **chính route giữa** hoặc REVOKE nó. |
| `[A9.C11]` | MEDIUM | Nguyên tắc *"tuyệt đối không recover bằng tên/8 ký tự trong note"* là đúng, nhưng phiếu của **writer #2 có `system_source` NULL** ⇒ cách **DUY NHẤT** nhận ra nó hôm nay **chính là match tên** (`name LIKE 'Hoàn cọc thanh lý hợp đồng%'`). Plan nên nói rõ 3 phiếu đó sẽ vào conflict **có chủ ý**, để không ai coi đó là bug. |

### 9.5 Nhóm E — Phân quyền

| ID | Mức | Rủi ro |
|---|---|---|
| `[A3.R1]` | HIGH | `is_super_admin()` **bỏ qua** `super_admins.organization_id` (cột tồn tại, row mang `aaaa`) ⇒ mở khoá **mọi** tổ chức; hàm còn được GRANT cho `anon`. Lan xuống `has_full_building_scope`, `can_access_building`, 7 policy `*_super_admin_all`, `ie_visible_cashbook_ids_v1`. |
| `[A3.R3]` | HIGH | `is_org_owner_v1` nhận diện chủ bằng **CHUỖI TÊN** `'Chủ sở hữu tổ chức'` (`organization_roles.name` là text tự do) ⇒ đổi tên vai trò trong Cài đặt **âm thầm tắt** cửa chủ sở hữu ở `reverse_invoice_collection_v5` và mọi cổng owner plan định dựng. Cùng lớp rủi ro với việc Task 7 Step 4 chủ động đổi label nhóm — nhưng ở đây **label CHÍNH LÀ key**. |
| `[A3.R4]` | HIGH | WP2 (untracked, chưa apply) vá **đúng hàm** cả hai plan sẽ sửa (`reverse_invoice_collection_v5`). Live vẫn còn nguyên hai lỗ: (a) vòng authz cấp tender truyền building của **HOÁ ĐƠN** cho mọi tender; (b) chưa có bậc "được nhìn sổ" ⇒ `bosshuy` (PARTNER, 3 override ORGANIZATION, **0** cashbook binding) hoàn tác được **cả 3 sổ**. |
| `[A3.C6]` · `[X4.6]` | HIGH (forward-looking) | `my_org_ids()` **thiếu cửa sổ hiệu lực** ⇒ đường ĐỌC rộng hơn đường GHI; lan qua `authorized_scope_all_v3`, `ie_visible_cashbook_ids_v1`, **34 policy RLS**. Latent (0 membership ACTIVE-hết-hạn hôm nay); sống ngay khi ai thu hồi bằng cửa sổ — **cách repo vẫn thu hồi vai trò**. Phải là **Step riêng**, không gộp vào việc ẩn row SERVICE. |
| `[A3.R5]` | MEDIUM | Definer **CŨ** đang mở mà không plan nào rà: `can_create_restricted_ie()`, `current_visible_owner_ids()`, `is_super_admin()` đều có `=X/postgres` (PUBLIC) + `anon=X` — mà Task 0 Step 3b lại **giao cho `can_create_restricted_ie()` vai trò cổng quyền MANAGEMENT**. |
| `[A8.R5]` | MEDIUM | `can_create_restricted_ie()`/`can_view_restricted_ie()` **không có tham số organization** ⇒ quyền cấp ở org A thoả gate cho toà của org B. Chưa khai thác được (chỉ 1 user đa-org = superadmin). |
| `[A3.R2]` | MEDIUM | Role `'Super Admin'` ở `aaaa` là **vỏ rỗng**: 18 binding hoạt động, **0** `role_permissions` ⇒ ai chỉ được gán role này sẽ bị deny mọi thứ trong khi nhân sự tin là đã cấp quyền cao nhất. |
| `[A3.R6]` | LOW | `is_super_admin()` và `has_full_building_scope()` đặt `SET search_path TO 'public'`, lệch chuẩn `pg_catalog, app_private, public` mà chính plan Task 0 Step 3c yêu cầu — và đây là **hai cửa bypass rộng nhất hệ thống**. |
| `[A3.C5]` · `[X4.5]` | MEDIUM | Bán kính nổ của registry SERVICE: **105** hàm tham chiếu `organization_memberships`, **50** hàm không lọc cả `member_type` cả `valid_to`, trong đó **12 hàm TIỀN**. Danh sách "ít nhất" của plan phủ **3/50** ⇒ nếu giữ Step 3, gate script phải liệt kê **50**, không phải 5–6. |
| `[A3.C10]` | MEDIUM | **DEMO không có fixture quyền nào khớp test của plan** (không "view-only", không "chỉ `deposits.view`", không "chỉ `contracts.view`"), và có ca **ngược** (`demo.ketoan`: collect ORGANIZATION > view SCOPED-BUILDING). Phải thêm Step tạo fixture + cleanup **trước** khi viết test. |
| `[A3.C9]` | MEDIUM | Câu *"mọi `is_super_admin()` bypass chỉ trong public special-page RPC"* **sai hiện trạng** ⇒ reviewer sẽ không audit các bypass cũ, và test *"superadmin không có bypass"* sẽ đỏ khi chạy qua RLS. |
| `C-AUTHZ-7` · `[X4.7]` | HIGH | Undo **không được** cưỡng chế exact CUSTODIAN — đi ngược quyết định chủ 30/07 (*"với việc thu chỉ cần biết sổ là được"*) và **đối đầu** WP2 trên cùng thân `reverse_invoice_collection_v5`. Dùng `ie_visible_cashbook_ids_v1` (4 cửa) cho undo; giữ exact CUSTODIAN cho submit/collect. |

### 9.6 Nhóm F — Cờ tính năng và rollout

| ID | Mức | Rủi ro |
|---|---|---|
| `C-ROLL-1` · `[A2.C8]` · `[A2.V5]` | MEDIUM | **Không có đường có kiểm toán nào để bật `force_freeze`.** **Không một function nào trong toàn DB ghi cột đó** (`prosrc ~* 'update\s+app_private.server_feature_flags\|set\s+force_freeze'` → rỗng); 8 hàm chỉ **đọc**. `set_feature_route_v1` UPDATE đúng **13 cột** và **không có** `force_freeze`. ⇒ Freeze hôm nay = **UPDATE tay**, **không sinh** `server_feature_flag_events`, **không bump** `config_version`. Bằng chứng: `income_expense.profit_close.v2` có `force_freeze=true`, `config_version=1`, **0 event**. |
| `C-ROLL-2` · `[A2.C7]` · `[A2.R4]` | MEDIUM | Cờ **toàn cục, không có `organization_id`** (PK = `feature_key`, 18 cột). Phân biệt org **chỉ** xảy ra **SAU** khi `mode` đã là `CANARY` toàn cục (qua `server_feature_flag_canary_orgs`). ⇒ *"prod stored OFF + demo stored CANARY"* là **bất khả**; và flip SHADOW→CANARY đẩy org thật từ SHADOW về **LEGACY**, **mất telemetry parity đúng lúc cần nó nhất**. Tiền lệ: cửa sổ shadow của `invoice.collection.v5` **chỉ 85 phút**. Repo đã ghi nhận lớp giới hạn này ở `20260730110000:8-13` và xây `app_private.org_accounting_mode` để thay thế. |
| `C-ROLL-3` · `[A2.C10]` | MEDIUM | `set_feature_route_v1` — thứ tự 14 vị trí **ĐÚNG** nhưng **3 tên khác** (`p_expected_config_version`, `p_max_single_amount_vnd`, `p_max_total_amount_vnd`) ⇒ gọi bằng named-arg theo chữ plan sẽ **42883**. Ràng buộc cứng plan bỏ sót: khi `mode IN ('ON','CANARY')` thì `p_commit_sha !~ '^[0-9a-f]{40}$'` hoặc `p_migration_sha256 !~ '^[0-9a-f]{64}$'` hoặc thiếu `maintenance_window_id`/`approval_reference` ⇒ **22023** *"ON/CANARY requires full release identity"*. ACL `postgres=X/postgres` **only** — `service_role` bị từ chối ⇒ **không gì trong app flip được route**. |
| `C-ROLL-4` · `[A2.C9]` | MEDIUM | Seed dòng cờ: phải qualify **`app_private.`** (không có bảng cùng tên trong `public`); `max_operation_count`/`max_single_amount_vnd`/`max_total_amount_vnd` là `NOT NULL DEFAULT 0` ⇒ **không thể để NULL**; **`domain text NOT NULL` KHÔNG default** ⇒ phải truyền; `risk_class NOT NULL DEFAULT 'MONEY'` + CHECK `IN ('MONEY','NON_MONEY')`. CANARY CHECK đòi window finite `starts_at < ends_at` + cả 3 cap `> 0`. Enrollment: `server_feature_flag_canary_orgs` PK `(feature_key, organization_id)` + FK ⇒ **seed cờ trước**, không thì trigger `a10_accounting_canary_enrollment_guard` raise `55000` *"Accounting feature is not configured"*. Tiền lệ rollback xoá dòng enrollment: `20260728150000:1015`. |
| `C-ROLL-5` · `[A2.R5]`/`[A2.R6]`/`[A2.R10]` | MEDIUM/LOW | `evaluate_feature_route` dùng **`clock_timestamp()`** (không ổn định trong transaction) ⇒ hai lần evaluate cùng transaction có thể cho `CANONICAL` rồi `FROZEN`; `claim_feature_operation_v1` lấy `clock_timestamp()` **riêng** sau advisory lock ⇒ writer có thể pass route rồi fail *"Canary window is no longer valid"* trong **cùng** transaction. `IF f.mode='ON' THEN RETURN 'CANONICAL'` đứng **TRƯỚC** toàn bộ khối window ⇒ `ends_at` **không** là van tự hết hạn sau ON. Op-counter **không có** vị ngữ `organization_id`. ⇒ **Evaluate route ĐÚNG MỘT LẦN mỗi transaction, snapshot kết quả + stored mode + config_version rồi dùng lại.** |
| `C-ROLL-6` · `[A2.R3]` | HIGH | `operation_key = md5(concat_ws('\|', feature_key, org, subject_scope, actor, idempotency_key))` được INSERT **trơn** (không `ON CONFLICT`) vào bảng có `UNIQUE (feature_key, config_version, operation_key)` ⇒ replay **đúng-hệt-identity** raise **`23505` TỪ BÊN TRONG** claim, không phải "trả về voucher gốc". Và vì `config_version` nằm trong unique key, **bump version giữa hai lần replay xoá sạch bảo vệ**. ⇒ Luật thứ tự bắt buộc: **LOOKUP bản ghi idempotency của special-fee/termination TRƯỚC; nếu hit thì trả voucher đang có và KHÔNG gọi `claim_feature_operation_v1`.** |
| `[A2.R1]` | MEDIUM | **Tồn tại HAI evaluator lệch nhau.** `app_private.finance_v2_route_pure_v1(text,uuid)` yếu hơn nhiều: **không** kiểm release identity, **không** kiểm caps/op-count, coi window NULL là hợp lệ, và window **đã hết hạn trả `LEGACY`** (không `FROZEN`). Nó cũng là hàm **duy nhất** trong `app_private` được GRANT EXECUTE cho `authenticated` (`proacl: postgres=X \| authenticated=X`), dù hiện bị chặn bởi thiếu USAGE trên schema. |
| `[A2.R2]` | HIGH | Sổ nhật ký rollout **không đầy đủ**: 7/28 cờ có `config_version > 1` mà **ZERO event**, vì tiền lệ repo là flip bằng `UPDATE` thẳng trong migration (`20260721150500:59-86`, `:91`, `:126`; `20260728150000:997-1013` + `DELETE FROM server_feature_flag_canary_orgs` ở `:1015`) ⇒ (a) **không đọc `expected_version` từ sổ event**; (b) mọi tuyên bố *"rollback có kiểm toán"* **không có tiền lệ thật**. |
| `[A2.R7]` | MEDIUM | **Không có kill switch dùng được từ trong ứng dụng**: `set_feature_route_v1` chỉ `postgres`; không có RPC freeze ⇒ mọi rollback/freeze trong sự cố tiền đòi Management API/psql với role `postgres` — **không phải thứ chủ/kế toán bấm được**, và không phải owner-approval flow plan mô tả. |
| `[A2.R8]` | LOW | `claim_feature_operation_v1` lấy dòng cờ `FOR SHARE`, `set_feature_route_v1` lấy `FOR UPDATE` ⇒ flip route trong lúc có writer mở transaction sẽ **chặn nhau**. Không chạy `set_feature_route_v1` cùng lúc với batch writer. |
| `[A2.R9]` | LOW | Trigger `a10_accounting_feature_activation_guard` chạy cho **MỌI** key kể cả key mới (không whitelist) và fire cả trên INSERT; với `mode='OFF'` thì assert early-return nên seed vẫn qua, **nhưng** dòng seed **chiếm advisory lock** `'accounting-feature-rollout:<key>'` tới commit. |
| `[A2.C1]` · `[A9.C14]` | HIGH → LOW residual | `evaluate_feature_route` **fail-OPEN** khi thiếu dòng cờ (`IF NOT FOUND THEN RETURN 'LEGACY'`; chạy thật 4 key không tồn tại × 3 org = **12/12 trả LEGACY**) ⇒ fail-closed **phải** do writer tự làm bằng `EXISTS` trên `app_private.server_feature_flags`. `[X2.1]` **bác** phần "plan không có remedy" (plan đã bắt migration abort ở `P1:193`, `P2:164`, `:210`, và có typed `ROUTE_STATE_UNKNOWN` ở `P1:220`); **residual LOW**: assert chạy ở deploy-time nên một dòng bị DELETE lúc runtime vẫn evaluate LEGACY ⇒ thêm `EXISTS` **runtime** trong writer. |

### 9.7 Nhóm G — Hạ tầng, gate, realtime

| ID | Mức | Rủi ro |
|---|---|---|
| `[A1.R2]` · `C-INFRA-6` | HIGH | `hubActive` singleton có thể **giết realtime của cả session** không lỗi: instance thứ hai return sớm **không cleanup**, cleanup của instance thứ nhất `removeChannel` ⇒ instance sống **mất subscribe vĩnh viễn**. Refactor mount-topology do plan gây ra (`E1`/`B7`) là trigger hợp lý; **không test nào phủ**. Thêm `subscribe((status) => …)` log `CHANNEL_ERROR`. |
| `[A1.C3]` · `B25` | HIGH | 3 bảng plan muốn nghe **không trong publication** ⇒ code đúng, test mock xanh, **production im lặng vĩnh viễn**. Cần một migration `ALTER PUBLICATION` **không có trong file list của plan nào**. |
| `C-INFRA-7` · `[A6.C11]` | MEDIUM | **4 query key ĐANG TỒN TẠI** bị thiếu khỏi hub (`period-fee-status`, `period-commissions`, `period-maintenance`, `fee-accounts`) + 2 bảng vắng khỏi `SYNC_TABLES` ⇒ `/thanh-toan` **không bao giờ** live-refresh GRID/hoa hồng/bảo trì từ máy khác — **amplifier trực tiếp** của rủi ro phiếu trùng (hai máy cùng thấy "chưa đóng"). Đồng thời `docs/he-thong/realtime-sync.md:32-33` đã cũ. |
| `C-INFRA-8` · `[A1.C4]`/`[A1.C5]` | MEDIUM | Mở rộng `useRealtimeDataSync.test.ts` = **viết lại 3 assertion**, và harness **không thể biểu diễn payload** (handler 0 tham số; `vi.mock("react")` chỉ có `useEffect`). **KHÔNG nới `toEqual` thành `toContain`.** |
| `C-INFRA-9` · `[A1.R1]` | MEDIUM | `.e2e-fleet` và `scripts/` **không được typecheck**; `src` typecheck yếu (`strict: false`, `noImplicitAny: false`) ⇒ 7 spec mới nhận **zero** type checking trong khi gate báo xanh. Hoặc thêm `.e2e-fleet/tsconfig.json` + script `typecheck:e2e`, hoặc **nói thẳng** rằng lỗi type của spec mới chỉ lộ ở runtime. |
| `C-INFRA-10` · `[A1.R6]` | MEDIUM | `check-approver-provenance.mjs` **sẽ fail** phiếu auto-approve nếu không set `system_source` trên **chính dòng voucher** (`CUTOFF='2026-07-23'`). Lưu ý tương tác: set `system_source` cũng làm `assert_manual_voucher_v1` ném `[NOT_MANUAL]` khi flex-cancel — **đó là fail-closed mong muốn** và phải được assert (`E10`). |
| `C-INFRA-11` · `[A1.R4]` | MEDIUM | `reconcile-money.mjs` có thể **exit 3 (INCONCLUSIVE)** và cần **đăng nhập tương tác** ⇒ định nghĩa pass = **exit 0**; exit 3 **không** phải pass; fallback: chọn kỳ >1000 dòng hoặc chạy `reconcile-money-v2.mjs`. |
| `C-INFRA-12` · `[A7.R8]` | MEDIUM | `schema_migrations` **đã chết** ⇒ mọi kiểm tra "đã apply chưa" phải dùng **catalog** (`pg_proc`/`pg_class`/`pg_trigger`/`pg_constraint`), không dùng sổ; và timestamp plan-reserved **không thể** validate bằng sổ, chỉ bằng catalog **từng object**. |
| `[A1.C8]` · `[X1.5]` | HIGH | Hai gate ACL/view **hard-scope schema `public`** và `check-definer-acl` **chỉ test role `anon`** ⇒ Step 6 **không thể** chứng minh 4 revocation nó khẳng định. Vùng mù: 30 hàm `app_private` DEFINER `authenticated` EXECUTE được, 19 với `anon`, 287 hàm `public` ở dải authenticated-không-anon. |
| `[A1.C9]` | MEDIUM | `npx vitest run` **đỏ sẵn ở HEAD** ⇒ gate *"vitest xanh mới apply"* hoặc **bất khả thi** (rollout tắc), hoặc implementer bắt đầu **bỏ qua gate** *"vì nó đỏ sẵn"* — đúng cách một regression thật lọt qua sau này. |
| `[A1.C11]` | MEDIUM | Gate **under-run âm thầm**: positional Vitest là filter ⇒ slice ship mà chưa tạo file test, lệnh gate **vẫn in xanh**. |
| `[A1.C12]` · `[A1.R3]` | LOW | `ts-baseline.txt` là file chết ("74"), gate đọc `ts-baseline.json` (30 fingerprint); và cross-check *"Found N errors"* **không bao giờ chạy** trên toolchain này ⇒ drift định dạng **đếm thiếu âm thầm**. |
| `[A6.C3]` · `[X5.3]` | HIGH | Task 0 Step 4 (*"chỉ mount đúng một surface theo breakpoint"*) là **thay đổi sản phẩm được ngụy trang thành sửa bug**: nó làm `thanh-toan-page.spec.ts:32` đỏ và phá `utility-paste-receipt.spec.ts:46-49` hoặc `:151-160`. Plan **không liệt kê** `thanh-toan-page.spec.ts` (chưa tồn tại khi viết plan) ⇒ implementer bị chặn ở gate Slice 0 mà không hiểu vì sao. |
| `E12` · `[X1.6]`/`[X6.1]` | MEDIUM-HIGH | **Đúng 1/10** timestamp của Plan 2 xung đột thật: `20260730160000` đã bị `20260730160000_cashbook_closing_permissions.sql` (**tracked, đã apply prod, commit `07ddfca`**) chiếm; 9 slot còn lại (`20260730000000`, `000500`, `001000`, `161000`, `161500`, `162000`, `162500`, `163000`, `164000`) đều **trống**. Việc phải làm là **đổi tên** (vd `20260731xxxxxx`). |

### 9.8 Nhóm H — Dữ liệu và kỳ vọng nghiệp vụ

| ID | Mức | Rủi ro |
|---|---|---|
| `[A4.R1]` | **BLOCKER** | **22 ô đã có ≥2 phiếu non-cancelled (45 phiếu)** ⇒ mọi partial-unique BASE index sẽ **fail ngay khi tạo**. **13/22 ô là tháng 07/2026** ⇒ vẫn đang phát sinh. |
| `[A4.R2]` | HIGH | **155/155** child recurring rơi vào một kind cố định ⇒ tích hợp claim external-holder **không phải edge case có thể hoãn**, nó phủ **100%** dân số recurring. |
| `[A4.R3]` | HIGH | Ô trùng điện/nước tồn tại ở **cả hai độ mịn**, và ô theo **toà** rộng hơn ô theo **meter**; riêng ô tháng 07 của toà `d76268b2-…` gồm 2 phiếu trên **2 meter khác nhau** — hợp lệ dưới unique index theo meter nhưng **phá khoá tổng hợp theo toà** và phá mẫu số tỉ lệ supplier/tenant. Xem §7.3 để chốt khoá. |
| `[A4.R4]` | HIGH | **0/109** dòng cấu hình có sổ quỹ mặc định ⇒ writer **không có gì để preselect**; mọi submit cần chọn sổ tay hoặc fail custody assertion. |
| `[A4.R5]` | MEDIUM | `not_applicable` **chưa bao giờ được dùng** (0/109) ⇒ 46 ô thiếu ở org thật + 21 ô ở DEMO **không phân biệt được** với *"toà này thật sự không có thang máy/phí công an"*. Cột `buildings.hidden_fixed_expenses` là cơ chế **thứ hai, song song, chưa được plan nào đối chiếu** — §7.2 mục 29 đo được nó **đang dùng ở 4/21 toà** nhưng chỉ giải thích **≤3** trong ~35 ô. |
| `[A4.R6]` | HIGH | **23/86** phiếu AC non-cancelled **đã vi phạm sẵn** luật ±5 tháng cùng phòng; **4** phiếu AC không có `room_id` (13/101 nếu tính CANCELLED) ⇒ không gắn được luật theo phòng. Máy giặt: **7 phiếu, 0 conflict** ⇒ luật rolling-6-tháng **hoàn toàn chưa được kiểm chứng**. |
| `[A4.R7]` | MEDIUM | `income_expense_audit_log` **không có** lịch sử trước 2026-06-30 và chỉ có **8** row `APPROVED` trong toàn hệ ⇒ mọi gate phát biểu *"audit completeness"* hoặc *"đối chiếu audit lịch sử"* chỉ có baseline **một tháng**; lịch sử trước tháng 7 là **thiếu về cấu trúc**, không phải "chưa đầy đủ". |
| `[A4.R8]` | MEDIUM | Baseline **trôi đủ nhanh để số tuyệt đối hết giá trị trong vài giờ**: `income_expenses` alive 2.496 (29/07) → **2.528** (30/07) = **+32/ngày**; `accounts` alive 27 → **28** trong cùng ngày; bucket cọc phụ cũng trôi (real-org null-source POSTED 15→17 (+5.000.000đ); DEMO null-source virtual `NOT_APPLICABLE` 13→18 (+8.000.000đ)). ⇒ **Dùng delta so với baseline đã ghi, KHÔNG dùng đẳng thức tuyệt đối.** |
| `[A4.R9]` | HIGH | DEMO **không chạy được đường điện/nước**: 2 meter, cả hai `provider_code` NULL, **0** phiếu `utility.bill` từng có. Cộng 0 dòng `building_fee_accounts` ⇒ DEMO **không có dữ liệu cho họ nào của Plan 1**. |
| `[A4.R10]` | MEDIUM | 2 hợp đồng có **2 phiếu hoa hồng broker APPROVED** ⇒ họ broker **cũng** cần conflict backfill, không chỉ họ phí cố định. Thêm 1 phiếu refund-like non-cancelled có `contract_id` NULL (4.326.400đ, `aaaa`). |
| `[A4.C9]` · `[X7.6]` | MEDIUM | **Hàng đợi hoàn cọc lúc mới bật sẽ gần như RỖNG**, không phải "đầy việc": 25/28 termination COMPLETED của org thật có `refund_amount <= 0`, chỉ **3** dương, và **cả 3 đã có phiếu sống**. ⇒ Plan nên đặt hẳn ngưỡng kiểm: **hàng đợi > 3 dòng nghĩa là emitter đang sinh nghĩa vụ hoàn cho cả những ca khách còn nợ**. |
| `[A4.C3]` · `[X7.1]` | INFO | Gần như **không** con số nào ở §4.3 bản 29/07 là "tổng hai org" — chúng là số **một org**: 100% `aaaa` (`dddd`=0) gồm `repeat_due` 77, 146+9 child, `contract_deposit_links` 5, cọc 243 và 33, **toàn bộ** họ conflict fixed/utility, **toàn bộ** 20 phiếu `termination.refund`, 3 `contract_transfers`, 109 `building_fee_accounts`, 67 `utility.bill`, 101 phiếu AC, 11 phiếu broker không HĐ; 100% **DEMO**: 1 DRAFT + 1 PENDING_APPROVAL termination và dòng `invoice_refund_reservations` duy nhất. `[X7.1]` **bác** mức HIGH: `DR:31` **đã** yêu cầu chạy lại tách org, và dòng nặng nhất (`DR:91`) **là** tổng hai org thật, reproduce đúng đến xu. Hai lỗi liệt kê cần sửa: `termination.refund` là 19 `aaaa` + **1 `dddd`** (`3d98e007…`, 500.000, CANCELLED); và `utility.bill` DEMO là **2 dòng soft-deleted**, không phải "vắng". |

### 9.9 Đã bị BÁC — không được sống lại

**22 trong 63** phát hiện HIGH/BLOCKER **đã chết** trong vòng kiểm ngược đối kháng. Bảng dưới đây liệt kê
26 dòng: 22 claim bị bác hẳn, cộng 4 claim bị **hạ mức hoặc sửa nửa** mà phần bị bác cũng không được
tái sinh (`[X1.1]`/`[X4.8]` hạ HIGH→MEDIUM; `[X4.7]` bác nửa (a) giữ nửa (b); `[X9.4]` bác 2/3 impact).
Tài liệu v2 nào tái sinh phần đã chết là sai.

| Claim bị bác | Câu chữ đúng thay thế | Verdict |
|---|---|---|
| *"`DepositsPage.tsx` coi `COMPLETED` là Đã hoàn — một clause, một file"* | Quy tắc là OR hai vế **trong hook**; bản vá của plan re-derive từ obligation POSTED nên **bao trùm** cả vế `refund_date`. Sửa dữ liệu quan trọng: **3 termination chỉ có `refund_date` VẪN CÓ phiếu** (`PC2607001`, `PC2607008`, `PC2607010`, đều UNAPPROVED/UNPOSTED, `account_id` NULL, item `PNL`) — cái bằng 0 là **POSTED** | `[X0.1]` |
| *"`canonical_amount = item_sum` làm dòng `a1ee1eb7` sai 500.000"* | Plan **giữ** canonical amount khỏi subject legacy (`Task 3 Step 2:190`, `Task 4 Step 3:201`, `Task 8 Step 3:249`, `§2.2:82`) ⇒ `a1ee1eb7` nhận **warning + net lịch sử**. Residual: khe spec ở Task 4 Step 3 (thiếu subtotal lớp DEPOSIT) → `C-DEP-2`, MEDIUM | `[X0.2]` |
| *"missing route là fail-OPEN, trái với plan"* | Fail-open **là thật** nhưng remedy **đã được plan yêu cầu** (`P1:193`, `P2:164`, `:210`, `P1:220`). Residual LOW: thêm `EXISTS` runtime | `[X2.1]` |
| *"Không có bề mặt client đọc route ⇒ Task 7 Step 2 bất khả thi"* | Access facts đúng, nhưng Files của Task 7 **đã mở** bằng `20260730015000_special_fee_read_wrappers.sql` (*"compatibility boundary"*), và khuôn mẫu **đã ship 21 lần** (21 hàm public DEFINER gọi `evaluate_feature_route` nội bộ, `authenticated` EXECUTE được, **không** grant `app_private`). Chỉ cần **đặt tên** RPC đọc. LOW | `[X2.2]` |
| *"Cạn count-cap cho FROZEN, không phải `SAFETY_CAP_EXCEEDED` ⇒ test đỏ"* | `claim_feature_operation_v1` **CÓ** raise `54000` *"Canary operation-count limit is exhausted"* sau advisory lock ⇒ **đúng kịch bản test của plan, và nó PASS**. `FROZEN` chỉ ảnh hưởng lần `evaluate` **kế tiếp**, và production coi đó là **chủ ý** (comment trong `_record_invoice_payment_v4_legacy`). Giữ lại **chỉ** lời khuyên vận hành: đặt `max_operation_count` **rộng tay** (tiền lệ 2147483647) | `[X2.3]` |
| *"Stored ON không ghi gì ⇒ telemetry/idempotency của plan là hư cấu"* | `claim_feature_operation_v1` return sớm ở ON, **nhưng hai hàm production khác VẪN INSERT** vào bảng ops: `public._record_invoice_payment_v4_legacy` và `public.create_income_expense_v1` (khối `if mode='CANARY'` chỉ bọc phần cap; INSERT `on conflict do nothing` nằm **SAU** `end if`). Bằng chứng: `invoice.record_payment.v1` có **12 op ở `config_version=3`** trải 17/07→19/07, **toàn bộ SAU** khi flip ON | `[X2.4]` |
| *"Không có bucket cap theo ngày/actor/org ⇒ plan giả định cơ chế không có"* | Schema facts đúng, nhưng `P1:197` là **to-do chưa tick** trong **Task 5** (bắt đầu `:187`), và Files của Task 5 (`:189`) **đã** có `20260730013000_special_fee_writer.sql` — chỗ tự nhiên cho bảng bucket mới; `P2:118` hedge *"và safety buckets nếu có"*; `DR:275` liệt kê test daily-cap là **việc mới**. Residual: nếu dùng lại bảng ops **chung** thì thêm vị ngữ `organization_id` | `[X2.5]` |
| *"Không migration nào tạo bảng cờ ⇒ clone chết với lỗi khó hiểu"* | Đúng là không migration nào define, nhưng `20260723010000_finance_v2_semantics_snapshot.sql:69-96` là **preflight có chủ ý** loop `to_regclass` + `to_regprocedure` và `RAISE 'Missing Finance V2 prerequisite relation %'` ⇒ **lỗi to, tự chẩn đoán**, ngược hẳn "khó hiểu". Chỉ còn ask tài liệu (MEDIUM): mở rộng kỷ luật forward-define sang control plane, hoặc **nói rõ clone phải là prod restore** | `[X2.6]` |
| *"3 khoá cờ của plan không tồn tại ⇒ bước verify pass sai lý do"* | Khoá vắng **vì migration tạo chúng chưa chạy** — `DR:217` nói rõ; **không dòng plan nào** đề xuất assert bằng `evaluate()='LEGACY'`, tất cả assert `EXISTS` + stored mode. **Strawman.** Census đúng: 28 = 24 ON + 3 OFF (1 `force_freeze`) + 1 SHADOW | `[X2.7]` |
| *"Plan provision SERVICE membership cho superadmin không có membership"* | Số đo đúng, nhưng plan **đã gate** trên điều kiện *"chỉ khi hoàn toàn chưa có"* ở **ba chỗ** ⇒ nhánh **chết trên dữ liệu hiện tại**; `DR:147` là **ô risk-register**, không phải khẳng định hiện trạng. Hành động: đổi `DR:147` sang thể điều kiện, thêm preflight, **giữ** Step 3. LOW | `[X4.2]` |
| *"6 timestamp termination chèn giữa Đợt 6 sẽ phá anchor patch của 170000/210000"* | Chèn là thật, **cơ chế bị bịa**: `20260730170000` có **ZERO** `pg_get_functiondef` và define cả hai hàm bằng `CREATE OR REPLACE` trơn (`:369`, `:562`, `:34`); `20260730210000` cũng vậy (`:63`, `:173`), và **anchor patch DUY NHẤT** của nó (`:348-356`) nhắm `propose_cashbook_closing_v1`. Cộng việc không tool nào replay theo tên file ⇒ **thuần mỹ quan**. Bẫy anchor cho **hàm KHÁC** vẫn thật → `C-INFRA-1` | `[X6.2]` |
| *"9 timestamp Plan 1 sort trước Đợt 0–6 ⇒ rehearsal bỏ qua mọi guard mới"* | Rehearsal là **clone của production** (`P1:81`, `P2:247`) nên Đợt 0–6 **thường trú** và mọi guard được thực thi. Chỉ **1/10** timestamp xung đột thật → `E12`, MEDIUM, chỉ cần **đổi tên** | `[X6.3]`, `[X1.6]` |
| *"Owner helper mới phải kiểm `organization.status` + membership window (helper mới thiếu)"* | `app_private.is_org_owner_v1` **đã** kiểm cửa sổ hiệu lực của **cả** membership **lẫn** role_binding — đúng điều decision record đòi. Cái nó **thiếu** là `organizations.status`. ⇒ **REUSE, đừng CREATE** helper thứ hai | `[X6.5]`, `D-REUSE-1` |
| *"Release adapter thiếu BỐN terminal writer"* | **HAI**: `ie_compat_cancel_v2` **đã** được nêu ở `P1:207`, và `cancel_collection_voucher_in_place_v1` có `proacl = postgres=X` only (comment `20260730150000:323-324`: *"KHÔNG kiểm quyền ở đây: hàm chỉ gọi được từ trong `reverse_invoice_collection_v5`"*) — **private helper, không nợ coverage** → `E10` | `[X6.7]`, `[X3.6]` |
| *"Số liệu §4.3 phần lớn là một org ⇒ disclaimer gây nhầm (HIGH)"* | Split là thật và đáng ghi, nhưng `DR:31` **đã** yêu cầu chạy lại tách org, và dòng nặng nhất `DR:91` **là** tổng hai org, reproduce đúng đến xu. Hạ xuống **INFO**; sửa 2 lỗi liệt kê (xem `[A4.C3]`) | `[X7.1]` |
| *"DEMO không diễn được Slice 3 ⇒ money write đầu tiên âm thầm rơi vào org thật"* | Dữ liệu đúng, **kết luận bị plan loại trừ**: `P1:237` gate DEMO CANARY trên owner publish + fixture cleanup, `:238` giới hạn fixture trong `dddd…0001`, `P2:248/:251` nhắc lại. Cơ chế cũng bị nói sai: số tiền cố định đến từ **bảng mới** `special_fee_fixed_rule_versions`, rỗng ở **cả hai** org tới khi publish. Và tiền đề "DEMO không có sổ quỹ" **sai**: DEMO có **6** sổ sống, **5** có CUSTODIAN. INFO | `[X7.2]` |
| *"47/126 ô CONFIG_REQUIRED và plan không budget nhập liệu"* | Đếm reproduce đúng, nhưng bullet **đầu tiên** của `DR §9` (`:283`) **là** *"fixed amount từng tòa/kind và tháng hiệu lực"*, exit gate của Slice 2 là *"owner config DRAFT"* (`:211`). Hai impact sai: *"100% lỗi thiếu sổ quỹ"* (21/21 sổ `aaaa` và 5/6 sổ DEMO **có** CUSTODIAN; actor chọn sổ lúc submit) và con số 37% (**12/46** ô là `thang_may` ở toà `has_elevator=false`, và **cả 6** toà có thang máy **đã** khai giá) ⇒ khoảng trống thật ≈ **35/126 = 28%**. Điều **chưa ai báo và quan trọng hơn**: `quan_ly` **0 row** trên cả hai org → `C-READ-1` | `[X7.3]` |
| *"Gap bậc hoa hồng làm broker bất khả dụng 100% toà; không có ca VALID nào"* | Tính phổ quát của gap đúng (21/21), nhưng khi `fallback_policy` được ghi thì **152 HĐ org thật** rơi **trong** bậc đã publish ⇒ có ca VALID. Gap **cắn** vào ~**48 HĐ ở 13–17 tháng** + 8mo 9 / 9mo 7. Plan **đã** nêu gap là fact (`P1:46`), **đã** đặt `fallback_policy` là điều kiện publish cứng (`:173`) và liệt kê nó là owner prerequisite (`DR:286`). Bổ sung cần thiết: **nói rõ dải chưa phủ giữ 48 HĐ thật** ⇒ fallback là load-bearing | `[X7.5]` |
| *"`refund_method` NOT NULL CHECK trái với 'manager chọn lúc finalize'"* | Constraint là thật, **nhưng không dòng plan nào hứa** manager chọn phương thức: `P2 §0.2:32` cho manager *"real cashbook, bổ sung evidence và bấm check"*; finalize token (`Task 1 Step 6`, `Task 5 Step 4`) **chỉ** phạm vi `income_expenses.account_id/voucher_date/lifecycle`, còn `refund_method` sống ở `contract_terminations` mà `P2 §0.1:17` **đã** dán nhãn historical-only. Cả hai dòng non-COMPLETED live **đã** mang `refund_method='TM'`. Việc phải làm: **một câu** ở Task 2 Step 2 | `[X9.6]` |
| *"`UNIQUE(contract_id)` + audit insert fail-closed sẽ abort move-out của 2 HĐ ACTIVE"* | Index và dữ liệu là thật, **nhưng `P2 Task 2 Step 2:176` ĐÃ ghi "insert *hoặc lock* dòng `contract_terminations` trước"** — đúng remedy được đòi. Writer hôm nay còn không **surface** được `23505` (bọc `EXCEPTION WHEN OTHERS THEN RAISE WARNING` ở `:226`, `:238-240`) — chính khuyết tật mà luật fail-closed đi chấm dứt. Còn lại: **nghĩa vụ test** (fixture cho HĐ đã có DRAFT/PENDING_APPROVAL, dùng đúng 2 HĐ đó, chứng minh nhánh lock-and-update và **không** `23505`). LOW/MEDIUM | `[X9.7]` |
| *"Đăng ký `TERMINATION_REFUND` tại birth phá toàn bộ lifecycle truyền thống"* | Plan **đã** đóng: `P2:55` ghi nhận adapter mismatch; `Task 1 Step 5` (`:167`) **bắt** forward-update `finance_flow_owner_adapters` khỏi adapter `INVOICE_REFUND` sang adapter termination + **5 wrapper có tên**; `§2.1` xếp migration đó **TRƯỚC** writer migration; `DoD:314` nói owned termination refund đi qua **adapter có tên**. Cơ chế `cancel→P0002` của phát hiện cũng **sai** cho phiếu sinh qua `reserve_invoice_refund_obligation_v2` (nó tạo dòng HELD trong cùng block). **Residual MEDIUM về thứ tự**: `DR §7` xếp birth-CANARY ở **Slice 4** và ownership-first routing ở **Slice 5** ⇒ trong Slice 4 một refund canary mở trên `/thu-chi` vẫn đụng 11 RPC generic assert `CANONICAL_INCOME_EXPENSE`. **Giữ cả hai** vì hazard `E8` vẫn sống cho refund sinh qua emitter của chính Plan 2 (không có dòng HELD) | `[X9.1]`, `D6` |
| *"Frontend không đọc được ownership (`app_private` không có USAGE)"* | Access facts đúng, nhưng ownership của flow này là **hàm thuần của `income_expenses.system_source`** (`reserve_invoice_refund_obligation_v2` set `flow_kind` bằng `CASE` trên `p_system_source`), và `system_source` **đã** được client đọc: `statusMutations.ts:48`, `queries.ts:230/240/245/495/996`, typed `types.ts:147`, tập trung ở `src/lib/voucherSources.ts:1` (*"Bảng quyết định DUY NHẤT cho phiếu thu chi máy-sinh"*). Prod mang **20 phiếu** `system_source='termination.refund'` (53.655.301đ). `P2 Task 1 Step 6` freeze `source`; `Task 4 Step 3` thêm `get_contract_termination_refund_status_v1`. **Patch**: diễn đạt lại `Task 1 Step 5`/`Task 7 Step 5` thành *"tra nguồn phiếu đã freeze + trạng thái obligation"*, **đừng** phơi `app_private`. LOW | `[X9.2]`, `D7` |
| *"UI chọn writer generic-vs-legacy theo global route TRƯỚC ownership"* (bị termination-agent gọi là sai) | **DR ĐÚNG, "reality" của phát hiện mới là sai**: `IncomeExpensePage.tsx:350-351` `const v2ApproveOnly = canWriteWorkflow(approveOrgRoutes); const v2ApproveAndPost = v2ApproveOnly && canWritePosting(approveOrgRoutes);` rồi `:497 if (v2ApproveOnly) {`, phân nhánh tiếp ở `:994/:1009/:1056/:1083`; `ApprovalsPage.tsx:80/:86/:90` và `IncomeExpenseMobilePage.tsx:438-439` y hệt; `financeV2Mutations.ts:3-5` phát biểu hợp đồng tường minh. **Không caller nào tra ownership.** Residual quan trọng: cách honour ownership duy nhất đang tồn tại là **regex thông điệp tiếng Anh** `/owned by system flow/i` — chỉ phủ approve và cancel ⇒ **adapter mới phải giữ NGUYÊN chuỗi đó** tới khi ownership-first routing lên, không thì dispatch **chết âm thầm** sau toast *"Duyệt phiếu thất bại"* | `[X9.3]`, `D8` |
| *"`terminate_contract_forfeit_impl` bị bỏ ⇒ 70% termination không có coverage hoàn cọc"* | Writer thứ ba là thật (26/37, audit insert bị nuốt ở `:262-263`) nhưng **2/3 impact sai**: FORFEIT **không** phát phiếu hoàn (chỉ cặp offset EXPENSE + revenue INCOME `:168-184`), `P2 §0.1:28` **đã** route net ≤ 0 sang `CUSTOMER_OWES`/`DEPOSIT_FORFEIT` **không có queue**, và `DEPOSIT_FORFEIT_POSTED` **suy ra được** từ 8+8 phiếu `termination.forfeit_*` (31.000.000đ mỗi bên) đã được `statusMutations.ts:39-42` key sẵn. Dự đoán *"26 dòng sẽ báo `LEGACY_SOURCE_UNKNOWN`"* là **suy diễn chưa kiểm chứng** → `C-TERM-1`, MEDIUM | `[X9.4]` |
| *"Plan hứa 4 file dirty / hunk-merge là HIGH"* | Hạ **MEDIUM**: `P1:119` kết thúc bằng *"tại thời điểm viết plan"* (tự giới hạn thời gian), và body `678d4ab` ghi việc hấp thu thay đổi của người dùng (*"hai file `useRealtimeDataSync.ts` và test của nó có sẵn thay đổi 'occupancy-dashboard' từ một phiên khác… gom chúng, ghi lại đây để truy được"*) ⇒ `git log -1 --` đưa implementer tới đúng ghi chú. Vẫn cần patch `B14`: **3 file M** (`RequirePermission.tsx`, `useIsAdmin.ts`, `useMyPermissions.ts`) + **3 file test untracked** phải commit riêng (`CLAUDE.md` đã cấm `git add -A`; một `git clean` sẽ **xoá** chúng) | `[X1.1]`, `[X4.8]` |
| *"Cancel truyền thống của IE không dùng `income_expenses.cancel`/`reverse`"* | **SAI.** Cả hai khoá tồn tại và **đang được dùng**: `income_expenses.cancel` bởi `cancel_unposted_income_expense_v2`, `ie_compat_cancel_v2`, `cancel_income_expense_flex_v1`, `can_flex_cancel_v1`; `income_expenses.reverse` bởi `reverse_posted_income_expense_v2`. Bản đồ capability ở `P1:207` **đúng**. Chỉ nửa **exact-CUSTODIAN-cho-undo** còn sống → `C-AUTHZ-7` | `[X4.7]` |

---

## 10. Giới hạn của tài liệu này

### 10.1 Về thời điểm đo

- Mọi số là ảnh chụp **30/07/2026** (loạt chính 03:28 UTC; các dòng ghi *"§7 (đo lại 30/07)"* chạy cùng
  ngày, muộn hơn). Baseline **trôi ~+32 dòng `income_expenses` alive mỗi ngày** và đã trôi **trong
  chính ngày đo** (`accounts` alive 27 → 28) ⇒ **mọi gate phải so DELTA với baseline đã ghi, không dùng
  đẳng thức tuyệt đối** (`[A4.R8]`).
- Chênh 2 → 4 ô trùng điện/nước ở §7.3 **KHÔNG phải drift** mà là **khác cách khoá** (kỳ dịch vụ vs
  `voucher_date`). Đừng đọc nó như "dữ liệu xấu thêm trong ngày".
- Script preflight khi triển khai phải tự ghi **timestamp + organization + query hash + baseline
  count/sum**, đúng như `DR §10` yêu cầu.

### 10.2 Cái KHÔNG được kiểm

**Khoảng trống lớn nhất**: **không có phiên browser/E2E nào được chạy** (mandate read-only). Không một
khẳng định UI nào trong tài liệu này được xác nhận trên một trang đã render.

Ngoài ra chưa kiểm:

| # | Hạng mục chưa kiểm | Vì sao quan trọng |
|---|---|---|
| 1 | **Danh sách cột INSERT đầy đủ của `approve_contract_termination_v1`** — chỉ đọc ~1.400 ký tự sau `v_refund` | Cần biết nó có set `building_id`/`room_id`/`contract_id` hay không (writer move-out thì có), và item có `accounting_class='PNL'` thật không |
| 2 | **Provenance của 3 termination DEMO chỉ có `refund_date`** (`6837641f`, `46b88b9f`, `75debc04`) | RPC set `refund_date` **và** fallback client đã chết cũng set (`useContracts.ts:1147-1155`) ⇒ chưa biết ai đã set; không tra audit trail |
| 3 | **Thân đầy đủ `terminate_contract_forfeit_impl`** (13.983 ký tự) — chỉ xác minh INSERT `contract_terminations`, `EXCEPTION WHEN OTHERS`, vắng `'termination.refund'`, vắng `termination_move_out_authorizations` | Các nhánh tiền khác (forfeit revenue / offset / extra invoice) **chưa đọc** |
| 4 | **Digest live-vs-migration của `fee_type_matches` / `get_period_fee_status`** — chỉ `resolve_fixed_expense_type` được xác nhận khớp `20260728180000:944` | md5 tham chiếu đã có: `ensure_income_expense_type_v1 = b1880461933551ccf20011ebec66ddd3`, `normalize_income_expense_type_name = 7822a97fcc48128d4fe95d33ab2fb27c` |
| 5 | **`account_id` lúc approve của 3 phiếu `INVOICE_REFUND`-owned** | Giả thuyết giải thích **vì sao bug posting trùng (`E9`/`E2`) chưa nổ** qua `finance_v2_transition_owned_approval`: `account_id` NULL ⇒ `v_should=false` ⇒ bridge không post |
| 6 | **Bên nào đúng cho 2 ca hoàn cọc lệch số** (`−978.500` và `+500.000`) | Độ lệch **đã chứng minh**, nhưng **nghiệp vụ coi số nào là đúng** thì chưa; cần đọc dữ liệu hoá đơn/cọc từng hợp đồng |
| 7 | **2 test `BuildingFilterSelect` có đỏ trên `origin/main` (`31425d3`) không** | Cần checkout/diff sẽ **làm bẩn cây làm việc** ⇒ không làm |
| 8 | **`role_permissions` của role `'Super Admin'`**: 18 binding / 0 permission | Chưa rõ 18 là 18 binding hay 18 cạnh scope của một binding, và sự rỗng đó có phải chủ ý |
| 9 | **Revision Playwright** — cả `chromium-1217` và `chromium-1228` đều cached, `@playwright/test 1.61.1` pinned nhưng **không gì verify** revision cần thiết, và **không có `postinstall`** | Máy/CI mới sẽ thiếu browser âm thầm |
| 10 | **Nội dung `buildings.hidden_fixed_expenses` đã đo** (§7.2 mục 29) nhưng **chủ chưa xác nhận** đó có phải cơ chế "toà này không có phí này" chính thức | Tới khi chủ trả lời, ~35 ô thiếu giá **chưa được gọi là nợ cấu hình** |

### 10.3 Phạm vi không phủ

- **Chỉ 2 organization tồn tại** (`aaaa` thật, `dddd` DEMO) ⇒ mọi kết luận về multi-tenant (vd
  `current_admin_org_v1` chọn org, `has_any_scope_v3` không có tham số org) **latent theo cấu hình
  hiện tại**, sẽ đổi khi thêm org thứ ba.
- **Không có clone/staging đầy đủ của production** ⇒ không tài liệu nào ở đây được gọi là "dry-run
  production"; mọi migration mới phải có rehearsal database riêng **hoặc** chỉ static validation
  (giữ nguyên `DR §2`).
- **Không kiểm timezone/DST**, không kiểm tải/hiệu năng, không kiểm giới hạn kích thước array của
  PostgREST bằng thực nghiệm (`/deposits` chunk ≤500 vẫn là con số **thiết kế**, chưa đo).
- **Không đo lại** các con số mà cả hai auditor độc lập đã cho kết quả trùng nhau và đã được
  `audit-cross` xác nhận (ví dụ 24 cạnh CASHBOOK / 73 binding, census 105/12/50 hàm tham chiếu
  `organization_memberships`, 236 hàm DEFINER trong `app_private`) — chúng được trích lại nguyên văn
  với ID nguồn.

### 10.4 Cách trích dẫn tài liệu này

Tài liệu v2 khác **nên trích §-số + ID nguồn** (ví dụ *"xem §7.3 và `[A4.R3]`"*) thay vì suy lại số từ
đầu. Nếu một số ở đây bị nghi sai, cách duy nhất được chấp nhận là **chạy lại đúng truy vấn SELECT** rồi
cập nhật **cả** dòng ở §7 **và** mọi chỗ trích nó — không sửa cục bộ ở một plan.
