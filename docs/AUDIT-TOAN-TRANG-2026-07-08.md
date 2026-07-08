# Báo cáo kiểm tra toàn trang web + Phương án tối ưu

**Ngày:** 2026-07-08 · **Phạm vi:** toàn bộ `src/` (128 page, 392 component, 116 hook, ~181.500 dòng, ~60 route)
**Phương pháp:** đọc code theo 8 nhóm domain (8 agent song song) → xác minh đối kháng 19 finding nghiêm trọng nhất (mỗi finding 1 verifier hoài nghi độc lập đọc lại code + đối chiếu schema) → **đo thực nghiệm trên DB production** để chốt cái nào đang cắn thật.

> ⚠️ **Đọc kỹ mục "Đã hạ mức sau xác minh"**: nhiều finding ban đầu bị gắn CRITICAL đã được hạ xuống HIGH/MEDIUM/LOW sau khi kiểm chứng (fail-closed tự hồi, chỉ hỏng hiển thị, RLS vẫn giới hạn, hoặc dead code). Severity trong báo cáo này là **mức THỰC sau xác minh**, không phải mức thô ban đầu.

---

## 1. Ảnh chụp sức khoẻ hệ thống

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| Lỗi TypeScript (`tsc -p tsconfig.app.json`) | **106** | Build vẫn chạy (Vite/SWC không type-check). 74 lỗi "property không tồn tại". |
| Test suite (Vitest) | **673 test / 57 file — PASS 100%** | Nhưng test không type-check và không phủ các bug đọc-sai-cột. |
| `as any` / `@ts-ignore` (ngoài test) | **1.097** | Che giấu cả một lớp bug đọc sai tên cột (xem §4). |
| `console.*` còn trong production | **281** | Nhiễu log, vài chỗ nuốt lỗi (`console.error` thay vì throw). |
| `select('*')` | 65 | Over-fetch tiềm ẩn (egress). |
| `dangerouslySetInnerHTML` / `.only(` test | 0 / 0 | Tốt — không XSS qua đường này, không skip test. |

### Số liệu thực nghiệm trên DB (project `ihomecrm`, đo 2026-07-08)
Dùng để phân biệt **bug đang cắn** vs **bug tiềm ẩn (latent)**:

| Đo | Kết quả | Ý nghĩa |
|---|---|---|
| `bulk_create_meter_readings` signature | **1 tham số** `p_readings jsonb` | FE gọi **2 tham số** → **import chỉ số Excel HỎNG** (xem P0-5). |
| `meter_readings` theo status | UNAPPROVED=**11**, APPROVED=1039 | 11 chỉ số kẹt UNAPPROVED, không có UI duyệt. |
| contracts ACTIVE | **273** | Cap-1000 ExcelInvoice (INV-C4) **chưa cắn** (273 < 1000). |
| max invoices / contract | **5** (304 HĐ có hoá đơn) | INV-C4 claim khuyến mãi **còn rất xa** ngưỡng 1000. |
| payments (tổng / 12 tháng) | **889 / 889** | Dashboard doanh thu (RPT-C1) **sắp cắn** (~300/tháng → vượt 1000 trong ~1 tháng). |
| invoices nợ chưa thu | **108** | DebtReport cap-1000 **chưa cắn**. |
| invoices `paid_amount>0` | **721** | Overpayment cap **chưa cắn**, nhưng lỗi "gồm HĐ xoá/huỷ" thì **đang xảy ra**. |
| invoices / income_expenses (tổng) | 835 / **1.713** | income_expenses **>1000** → tab "Phiếu tổng" (INV-C3) **có thể** cắn. |

**Kết luận nhanh:** Không có lỗ hổng bảo mật leo thang quyền hay crash toàn app. Trục xương sống (thu tiền RPC, phân bổ cọc, làm tròn, stats aggregate, prefetch/realtime hub, phân quyền registry) được viết **rất tốt**. Rủi ro thật tập trung ở: (a) vài chức năng LIVE hỏng hẳn, (b) một lớp bug "đọc sai tên cột" bị `as any` che, (c) mẫu "SELECT rồi cộng client" dính cap-1000 (phần lớn latent, 1-2 chỗ sắp/đang cắn), (d) vài thao tác tiền không idempotent/không atomic, (e) khối dead code lệch schema.

---

## 2. P0 — Sửa NGAY (chức năng lõi hỏng hoặc rủi ro tiền/dữ liệu thật, đang LIVE)

### P0-1 · Hoàn tác thu tiền có thể xoá NHẦM phiếu → mất dữ liệu + sai tiền
`src/lib/collect.ts:179-185` · **CONFIRMED · HIGH · LIVE**
`latestPaymentId()` chọn phiếu theo `payment_date` (DATE, user tự chọn qua date-picker, backdate được), tie-break theo thứ tự mảng (embed không `.order`). Ghi 1 phiếu backdate trong khi HĐ đã có phiếu ngày sau → "Hoàn tác" **hard-delete** phiếu ngày lớn nhất (không phải phiếu vừa tạo) + soft-delete voucher INCOME sai → trigger recompute `paid_amount`/status HĐ lệch. Kích hoạt khi có ≥2 phiếu + (backdate hoặc cùng ngày).
**Sửa:** chọn phiếu vừa tạo theo `created_at` (đã có sẵn trong embed), hoặc `.order('created_at', {ascending:false})` rồi lấy phần tử đầu.

### P0-2 · Trả lương không idempotent → tạo 2 phiếu chi (chi tiền gấp đôi)
`src/hooks/useManagerSalary.ts:928-931` · **CONFIRMED · HIGH · LIVE**
`useSalaryPayout` đọc `paid` → cộng `amount` → update, client-side, **không transaction/guard**. Mỗi lần gọi INSERT 1 phiếu chi EXPENSE mới vào sổ quỹ. Double-click "Ghi phiếu chi" hoặc bulk + đơn lẻ cùng staff → **2 phiếu chi = tiền thật ra gấp đôi**; `payout_voucher_id` bị ghi đè (phiếu đầu mồ côi). Không kiểm `payout_voucher_id` đã tồn tại, nút không disable theo `isPending`.
**Sửa:** chuyển tăng `paid` + tạo phiếu chi sang **1 RPC atomic** (SECURITY DEFINER) có guard idempotency; disable nút khi mutation pending.

### P0-3 · Cập nhật định mức dịch vụ nuốt lỗi insert bậc giá → mất bậc thang giá âm thầm
`src/hooks/useServices.ts:369-389` (update), `:321-336` (create) · **CONFIRMED · HIGH · LIVE**
`useUpdateServiceQuota` **xoá hết** `service_quota_tiers` cũ rồi insert mới; nếu insert lỗi (RLS/constraint/mạng) chỉ `console.error` **không throw** → `onSuccess` vẫn chạy → toast "Cập nhật thành công" nhưng quota **mất sạch bậc thang giá** (dùng cho tính tiền dịch vụ). Không transaction. Bug latent (chỉ khi insert fail) nhưng hậu quả là mất dữ liệu tính tiền.
**Sửa:** `throw tierError` để mutation reject; gói delete+insert vào 1 RPC transaction; không xoá tiers cũ trước khi insert mới thành công (diff như `useUpdateService`).

### P0-4 · Chuyển lead → cọc luôn LỖI (sai tên cột)
`src/components/leads/ConvertLeadDialog.tsx:106` · **CONFIRMED · HIGH · LIVE**
Insert `deposits` với `hold_until_date` nhưng cột thật là `hold_until` (xác nhận types.ts:2182) → PGRST204 → `createDeposit` throw → `convertLead` **không chạy** → lead không bao giờ đánh dấu CONVERTED. Kép: `useCreateDeposit` ghi vào bảng `deposits` **đã bị bỏ** (DepositsPage đọc `income_expenses`) nên dù sửa key phiếu vẫn không hiện.
**Sửa:** viết lại luồng convert đi qua phiếu `income_expenses` `is_deposit` (giống `CreateDepositDialog`), rồi chỉ đánh dấu lead CONVERTED. Cân nhắc xoá hẳn bảng/hook `deposits` legacy.

### P0-5 · Import chỉ số điện Excel HỎNG + chỉ số UNAPPROVED kẹt → tính dư tiền điện
`src/hooks/useMeterReadings.ts:368-374` + `supabase/migrations/20250130000004…sql:255` · **CONFIRMED · HIGH · LIVE (đo DB)**
Hai vấn đề chồng nhau:
1. **Import đang hỏng:** FE gọi `bulk_create_meter_readings({ p_readings, p_user_id })` (2 tham số) nhưng function deploy chỉ nhận **`p_readings jsonb`** (1 tham số — đã đo pg_proc) → PostgREST không khớp → toast "Không thể nhập dữ liệu từ Excel", **không import được**.
2. **Chỉ số UNAPPROVED kẹt:** 11 chỉ số đang ở UNAPPROVED, RPC hard-code UNAPPROVED, **3 hook duyệt** (`useApproveMeterReading`…) **không được nối vào UI nào**. `TerminationExtraCharges.tsx:116-130` và `GenerateInvoiceDialog.tsx:279` lấy baseline chỉ lọc `status='APPROVED'` → bỏ qua chỉ số UNAPPROVED → previous_reading lùi về mốc thấp hơn → tiêu thụ bị thổi phồng → **khách bị tính dư tiền điện** (cho đúng các meter dính).
**Sửa:** (a) đồng bộ chữ ký RPC (bỏ `p_user_id` ở FE hoặc thêm tham số ở function); (b) auto-approve khi import HOẶC nối nút Duyệt/Duyệt hàng loạt vào `MeterReadingList`; (c) chuẩn hoá 11 chỉ số kẹt hiện tại.

### P0-6 · Dialog chi tiết phòng (Sơ đồ toà nhà) luôn báo "chưa có hợp đồng"
`src/components/building-map/RoomDetailDialog.tsx:54-91,155,206` · **CONFIRMED · HIGH · LIVE**
Query contracts `select(rent_amount)` — cột thật `rent_price`; invoices `select(title)` — cột không tồn tại → PostgREST 400, code **bỏ qua error** (chỉ destructure `data`) → `activeContract`/`latestInvoice` luôn `null` → **mọi phòng, kể cả đang thuê, hiện "Căn hộ chưa có hợp đồng"** + nút "Tạo hợp đồng" sai; diện tích render `room.area_sqm` (thật `area`) → "undefinedm²". Đây là tương tác lõi khi click phòng ở `/building-map`.
**Sửa:** `rent_amount`→`rent_price`, bỏ `title`, `area_sqm`→`area`, dùng `.maybeSingle()`, kiểm `error` thay vì nuốt.

---

## 3. P1 — Sửa SỚM (HIGH sắp/đang cắn hoặc MEDIUM tác động rõ)

### P1-1 · Dashboard "Doanh thu 12 tháng" cap-1000 — SẮP cắn (~08/2026)
`src/hooks/useDashboard.ts:133-162` · **PARTIAL · HIGH · LIVE**
`useRevenueChart` select payments không `.range()/.order()/aggregate` → cắt 1000 dòng. Đo DB: **889 payment** hiện tại (<1000) nên chart **đang đúng**, nhưng ~300 payment/tháng → vượt 1000 trong ~1 tháng → sau đó biểu đồ doanh thu chính (desktop + mobile) **thiếu số, tháng bị cắt ngẫu nhiên** (không order). Sửa TRƯỚC khi cắn.
**Sửa:** RPC aggregate `SUM GROUP BY month` (như `get_dashboard_summary` đã làm) hoặc range-loop.

### P1-2 · ExcelInvoiceDialog cap-1000 → mất phòng + áp khuyến mãi DƯ (latent)
`src/components/invoices/ExcelInvoiceDialog.tsx:150-166,249-261` · **CONFIRMED · HIGH · LATENT**
Query HĐ ACTIVE toàn hệ lọc toà ở client + đếm HĐ tính slot khuyến mãi, đều không limit/range. Đo DB: 273 HĐ ACTIVE, **max 5 hoá đơn/HĐ** → **chưa cắn** (còn xa 1000). Nhưng là mìn: khi vượt 1000, phòng rơi sau dòng 1000 không lập được HĐ + slot khuyến mãi đếm thiếu → **giảm giá dư (sai tiền)**. Query không `.order` nên HĐ mới (đang trong kỳ KM) dễ bị cắt.
**Sửa:** lọc building server-side (join room→building); đếm invoices bằng aggregate/head-count thay vì kéo hàng.

### P1-3 · Báo cáo "Tiền thừa" gồm cả hoá đơn XOÁ/HUỶ — đang sai
`src/hooks/useReports.ts:1098-1140` · **PARTIAL · MEDIUM · LIVE**
`useOverpaymentReport` select mọi invoice `paid_amount>0` **không lọc `deleted_at`, không lọc status** rồi filter overpaid client → danh sách "cần hoàn khách" gồm cả HĐ đã xoá mềm/huỷ (đang xảy ra: 721 HĐ paid>0), cộng thêm cap-1000 (chưa cắn). *(Lưu ý: `useDebtReport` **đã** có lọc `deleted_at`+status, chỉ thiếu `.range()` — finding gốc nói quá.)*
**Sửa:** thêm `.is('deleted_at', null)` + loại CANCELLED; đẩy điều kiện overpaid xuống server hoặc RPC.

### P1-4 · `useMyPermissions` nuốt lỗi RPC → khoá user tạm 5 phút
`src/hooks/useMyPermissions.ts:29` · **PARTIAL · MEDIUM · LIVE**
`if (error || !data) return {}` → React Query cache `{}` như success trong `staleTime` 5' (retry vô hiệu vì không throw) → 1 blip mạng lúc boot làm sidebar rỗng + mọi `RequirePermission` đá về `/`. **Fail-closed** (không cấp quyền thừa, không sai tiền/rò rỉ), tự hồi ≤5' khi điều hướng route mới — nên MEDIUM chứ không CRITICAL. Áp cùng cho `useIsAdmin`.
**Sửa:** `throw error` trong queryFn (để `retry:1` + backoff chạy) thay vì return `{}`.

### P1-5 · Tab "Hoá đơn" trong chi tiết toà hiện hoá đơn TOÀ KHÁC
`src/pages/buildings/BuildingDetailPage.tsx:112-131` · **PARTIAL · MEDIUM · LIVE**
Embed `contract:contracts(...)` không `!inner` + filter `.in('contract.room_id', roomIds)` chỉ null-hoá embed, **không cắt hàng top-level**, và tab invoices **thiếu filter client bù** (khác tab contracts:93) → render hoá đơn không thuộc toà (khách/phòng trống). **Không phải rò rỉ vượt quyền** — RLS vẫn giới hạn trong toà user có quyền → correctness bug, MEDIUM.
**Sửa:** dùng `.eq('building_id', id)` trực tiếp (invoices **có sẵn** cột `building_id` + `room_id`, types.ts:3149/3168) thay vì embed filter — vừa đúng vừa gọn.

### P1-6 · Đổi mật khẩu KHÔNG xác thực mật khẩu cũ (CWE-620)
`src/pages/account/ProfilePage.tsx:66-86` + `src/hooks/useProfile.ts:142-149` (+ `AccountMobilePage.tsx:98-107`) · **CONFIRMED · MEDIUM · LIVE**
Form thu "Mật khẩu hiện tại" nhưng chỉ gọi `updateUser({password})`, không re-auth → trường trang trí, an toàn giả. Ai mượn được phiên đang mở đổi được mật khẩu. Cần phiên sẵn (không remote) nên MEDIUM.
**Sửa:** `signInWithPassword({email, password: currentPassword})` trước `updateUser`; áp cả desktop + mobile.

### P1-7 · Tab "Phiếu tổng" (income-expense batches) cap-1000 — có thể cắn
`src/hooks/useIncomeExpenses.ts:1753-1800,1939-1944` · **PARTIAL · MEDIUM · LIVE**
`batchQuery` không `.range()`; `voucherQuery.in('id', voucherIds)` với `voucherIds` = tất cả phiếu con mọi batch — đo DB **income_expenses=1713 (>1000)** → nếu phần lớn nằm trong batch, phiếu con vượt 1000 bị cắt → `total_amount` cộng thiếu, batch mất hết phiếu con thì biến mất. Chỉ ảnh hưởng **hiển thị list** (thẻ tổng dùng RPC aggregate riêng, không sai). URL `.in()` hàng nghìn UUID còn có thể 400.
**Sửa:** phân trang batch server-side + tổng bằng RPC; chunk `.in()` ≤100.

---

## 4. Nguyên nhân gốc xuyên suốt (fix 1 chỗ, chặn cả lớp bug)

### 4.1 · `as any` che lớp bug "đọc sai tên cột" (1.097 chỗ)
Hàng loạt bug hiển thị/query cùng một bản chất: code đọc field **không tồn tại trong schema**, bị `as any` (hoặc `select('*')`) che nên `tsc` không bắt được, runtime trả `undefined`/400. Đã xác nhận qua schema thật:
- `rooms`: dùng `base_rent/capacity/notes/area_sqm/deposit/max_occupancy` → thật là `rent_price/max_occupants/description/area/deposit_amount`.
- `buildings`: `floors/notes` → thật `total_floors/description`.
- `contracts`: `rent_amount` → thật `rent_price`.
- `invoices`: `title/billing_period_start/end` → thật `invoice_number/billing_month`.
- `deposits`: `hold_until_date` → thật `hold_until`.

Chỗ dính: RoomDetailDialog (P0-6), BuildingDetailPage:365/433/477 & RoomDetailPage:407/520/526 (BLD-H, hiển thị trống, MEDIUM), RoomsMobilePage:226/233, ContractDetailView:1352 ("Kỳ" luôn trống), ConvertLeadDialog (P0-4).
**Phương án gốc:** derive type từ `Database[...]['Row']` cho `Room`/`Building`/`Vehicle`/`Customer`/`Invoice`, mở rộng phần embed; **gỡ `as any`**. Việc này để `tsc` tự bắt cả lớp bug này và gỡ ~15+ lỗi TS. Đây là **ưu tiên nợ-kỹ-thuật số 1**.

### 4.2 · Mẫu "SELECT rồi cộng client" dính cap-1000 PostgREST
Đúng bug-class đã biết (`project_postgrest_cap1000_stats_bug_class`). Tập trung ở **nhánh cũ** `useReports.ts` + 2 chart Dashboard; nhánh mới (`fa_*` RPC, `get_dashboard_summary`, ProfitDistribution) đã làm chuẩn (tổng server-side + `capWarning`). Danh sách (phần lớn **latent** theo số đo hiện tại, nhưng sẽ cắn khi dữ liệu lớn):
- **Đang/sắp cắn:** RPT-C1 doanh thu (P1-1), overpayment gồm HĐ xoá (P1-3), batch phiếu tổng (P1-7).
- **Latent (chưa cắn):** ExpenseRatio (`:680`), Occupancy/trend (`:506,584` — đã có RPC `fa_occupancy_monthly` để thay), CustomerDebt (`:973`), PaymentSchedule (`:1049` + `select('*')`), DebtReport (`:906`, chỉ thiếu range), VacantRooms (`:58`), shareholder allocations/distributions (`useShareholderProfit` — vượt 1000 sau ~2 năm), DashboardMobile kéo full leads/deposits (`DashboardMobilePage.tsx:109`).
**Phương án gốc:** thay bằng RPC aggregate SECURITY INVOKER (giữ RLS) hoặc range-loop; gộp trang Occupancy về `fa_occupancy_monthly`.

### 4.3 · Nuốt lỗi → hiển thị "không có dữ liệu" GIẢ
Nhiều hook `catch → return []/{}/false` khiến RLS/timeout/5xx hiện danh sách trống/quyền rỗng thay vì trạng thái lỗi + retry: `useMyPermissions` (P1-4), `useIncomeExpenses`/`useMeterReadings`/`useMeters`/`useInvoicesLegacy` list, `useAreas`/`useFloors`/`useRoom`, service-quota `console.error` (P0-3).
**Phương án gốc:** thống nhất **throw** để vào `isError` + `retry` (đã có tiền lệ `useInvoices` main:191).

### 4.4 · Thao tác tiền không atomic (nhiều `await` tuần tự)
`useCreateIncomeExpenseBatch`/`useUpdateIncomeExpense`/`useCancelIncomeExpense` (insert/delete nhiều bảng, rollback best-effort), mirror voucher post-RPC trong `useRecordPaymentRPC` (rủi ro payment đôi khi retry), upsert vật tư/nhập kho delete→insert (lệch tồn), trả lương (P0-2), quota (P0-3).
**Phương án gốc:** gói vào RPC transaction (đối xứng `restore_income_expense`).

### 4.5 · Dead code lệch schema (mìn + nhiễu maintenance)
Nên **xoá** để giảm bề mặt bug và tránh nối nhầm bản sai:
- Module payments cũ: `useRecordPayment`/`useCreatePayment`/`usePayment(s)`/`CollectPaymentDialog`/`PaymentReceiptDialog` — **double-count `paid_amount`** nếu nối lại; `CollectPaymentDialog` insert `payments.invoice_id=null` (NOT NULL → lỗi DB).
- `useReports.ts`: `useProfitDistributionReport` (query cột `amount`/bảng `expenses` không tồn tại — hỏng hẳn), `useCashBookReport`/`useCashFlowReport` (expense luôn 0).
- `invoiceHelpers.ts` cụm auto-generation legacy (`generateInvoiceForContract`… cột `billing_period_from/item_type` không tồn tại).
- `ImportExcelDialog` + `excelHelpers.importBuildings/importRooms` (double-parse crash, không insert DB, sai shape — không page nào dùng).
- `TenantsPage` + `Create/EditTenantDialog` (route đã redirect; enum `MOVED_OUT/BLACKLISTED` sai), `EditDepositDialog`, `ConvertToContractDialog`, nhóm termination-approval trong `useContracts.ts` (ghi bảng `cash_book` không tồn tại).
- `Breadcrumbs.tsx` (~229 dòng, không import), `components/invoices/InvoiceDetailPage.tsx` (bản dup), `IncomeExpenseListMobile`, duplicate meter hooks trong `useInvoices.ts`.

---

## 5. P2 — Nên sửa (correctness/UX, bằng chứng rõ từ đọc code)

**Khách hàng / Hợp đồng**
- `ContractDetailView.tsx:1352-1356` — tab Hoá đơn cột "Kỳ" luôn trống (`billing_period_start/end` → dùng `billing_month`). `:1545` nút "Đi đến duyệt thanh lý" là ngõ cụt (ContractsPage không đọc query param; UI duyệt không tồn tại).
- `CreateCustomerDialog` (P2, PARTIAL MEDIUM) — dropdown địa chỉ **mock** (HN/HCM/DN, district1/2, ward1/2) → lưu mã rác vào `province`; nút "+ Thêm xe" no-op; ghi cả `status` lẫn `status_v2` (hook luôn ép `status_v2='RENTING'`). Dùng `AddressCascadingDropdowns` có sẵn.
- `CustomerForm` (form chính) không cho nhập Liên hệ khẩn cấp/Loại giấy tờ dù DB lưu và DetailPage hiển thị → tính năng nửa vời.

**Buildings / Rooms**
- BLD-H (CONFIRMED MEDIUM): `BuildingDetailPage:365/433/477`, `RoomDetailPage:407/520/526` hiển thị trống do đọc sai cột (xem §4.1). *(RoomDetailPage:419 có fallback `rent_price` → vô hại.)*
- `useBuildings.ts:254` optimistic update trỏ sai query key (`["buildings"]` vs `["buildings",{includeVirtual}]`) → no-op, toggle trạng thái toà bị trễ.
- Trùng dialog Edit vs Form (Building/Room) — field set khác nhau gây "sửa mà không thấy field"; hợp nhất về 1 form nguồn-sự-thật.
- Nút Lưới/Danh sách chết (BuildingsPage/RoomsPage); setState-trong-render auto-chọn toà (BuildingMapPage:161).

**Invoices / Meter**
- `EditInvoiceDialog.decomposeItems` (P2, PARTIAL MEDIUM) — chỉ **rớt dòng khi HĐ có ≥2 item cùng khớp 1 keyword** (điện/nước/dịch vụ) → tổng giảm; chỉ HĐ chưa thu (`paid=0`). *(previous_debt chỉ lệch hiển thị — total lưu vẫn đúng; PENALTY→OTHER chỉ đổi nhãn.)*
- Bộ lọc "Phòng" trang Ghi chỉ số hỏng (`room_ids` thiếu trong interface `MeterReadingFilters` + page không map) → chọn phòng không lọc gì.
- `PaymentsSummaryDialog`/`SuperAdminForceDeleteDialog` trùng query-key khác select → hiển thị sai chứng từ ở dialog xoá tiền.
- `InvoiceSummarySection:55` auto-fill discount không clamp `min(excess, subtotal)` → total có thể âm; `prepaidValidation` viết xong nhưng không được gọi. Rounding lệch tạo/sửa HĐ (≤900đ). `MeterReadingStats` thẻ "Công tơ chưa chốt" render tổng chỉ số (sai nhãn).

**Vận hành / Lương**
- `PersonalWalletPage:55` — 3 thẻ tổng tính toàn thời gian nhưng bảng/biểu đồ theo năm lọc → đổi năm không đổi thẻ (gây hiểu nhầm).
- `useManagerSalary:392` — `incomeGoal` mặc định = `base+investment` khiến "% vượt mục tiêu" luôn ≥100% → gamification vô nghĩa (chỉ khi engine v5 bật).
- `useJobs:185` — ghi ảnh nghiệm thu vào cột `attachments`, cột `completion_attachments` luôn NULL (đặt tên gây nhầm).

**Assets / Chat / Notifications**
- Zalo chat (AST-H2, PARTIAL MEDIUM→LOW): invalidate full list mỗi realtime event — **đã mitigate** (chọn cột + limit 5000 + debounce 400ms trailing), chi phí tuyến tính có trần. Tối ưu còn lại: `setQueryData` patch 1 dòng từ `payload.new` thay vì invalidate cả list.
- Notification unread mismatch (AST-H3): **hạ LOW** — IN_APP chỉ ở PENDING/READ nên badge thực tế **không lệch**; chỉ nên nhất quán tiêu chí (`.neq('status','READ')`) phòng hồi quy.
- `useNotifications` không realtime/không polling → chuông chỉ cập nhật khi focus lại.
- `CreateAssetDialog:45` ô "Căn hộ" liệt kê mọi phòng mọi toà, không lọc theo toà đã chọn.
- Upsert vật tư/nhập kho delete→insert không transaction (lệch tồn khi lỗi giữa chừng).

**Settings**
- `useDocumentTemplates:78` — `CATEGORY_TO_TYPE` không map sang `signature`/`deposit_contract` → 2 tab đó không tạo được mẫu; **sửa** mẫu signature/deposit làm nó "nhảy" khỏi tab.
- `GeneralSettingsPage:340` — upload logo lưu `blob:` URL tạm (hỏng sau F5, ghi URL chết vào DB); không kiểm 2MB. Dùng `lib/storage.uploadFile`.
- `useSettings` query thiếu `.eq('user_id')` (dựa hoàn toàn RLS; account-sharing có thể lỗi đa-dòng); settings per-user nhưng trình bày như cấu hình hệ thống.
- SignaturesPage (SET-H1, **hạ LOW**): trang mock (nút không onClick, ảnh 404) nhưng **không có link menu** (chỉ vào bằng URL) → phơi nhiễm thấp; DB có sẵn bảng `signature_templates` chưa dùng.
- `CategoryCrudPage` không validate required client-side; `Number("")→0` biến ô số rỗng thành 0.
- 6 trang "Danh mục khác" là `PlaceholderPage` nhưng vẫn được link + gate quyền "manage".

**Auth / Layout**
- Checkbox "Ghi nhớ đăng nhập" vô tác dụng (`useLogin` không đọc `rememberMe`); redirect `state.from` sau login không nơi nào đọc (luôn về `/`); menu avatar "Tài khoản/Cài đặt" bị `disabled` dù trang tồn tại; `ProtectedRoute` listener trùng + `window.location.href` khi SIGNED_OUT (mất toast, full reload).
- `Header.getUserInitials` ném TypeError với `full_name` toàn khoảng trắng → crash vào ErrorBoundary; Sheet sidebar mobile thiếu `SheetTitle` (a11y); NotFound tiếng Anh + `<a>` full reload.

---

## 6. P3 — Dọn dẹp / nợ nền

1. **Regenerate Supabase types** (`supabase gen types`) — types.ts cập nhật lần cuối 05/07, một số bảng (`shareholders`, `profit_managers`, `salary_monthly`) chưa có trong generated → buộc `as any`. Sau đó chuẩn hoá type theo `Database[...]['Row']` (§4.1) → gỡ phần lớn 106 lỗi TS + hàng loạt `as any`.
2. **Xoá dead code** liệt kê ở §4.5.
3. **Dọn 281 `console.*`** trong production; đổi các list `catch→return []` sang throw (§4.3).
4. `ErrorBoundary` dùng `import.meta.env.DEV` thay `process.env.NODE_ENV`.
5. Đồng nhất mobile-detect về 1 hook (`usePhoneViewport`); gộp 3 `formatCurrency` VND lặp.
6. Rà `select('*')` (65 chỗ) trên bảng lớn/realtime → chọn cột.

---

## 7. Lộ trình đề xuất

| Đợt | Nội dung | Vì sao |
|---|---|---|
| **Sprint 1 (ngay)** | P0-1…P0-6 | Chức năng LIVE hỏng / rủi ro tiền-dữ liệu đang tồn tại. Mỗi cái sửa nhỏ, độc lập. |
| **Sprint 1** | P1-1 (doanh thu), P1-3 (overpayment lọc deleted) | P1-1 sắp cắn trong ~1 tháng; P1-3 đang sai. |
| **Sprint 2** | §4.1 chuẩn hoá type + gỡ `as any` → chặn cả lớp bug đọc-sai-cột; P1-4,5,6,7; regen types | Fix gốc, mở đường cho `tsc` xanh. |
| **Sprint 2** | §4.2 chuyển các báo cáo cap-1000 latent sang RPC aggregate | Trước khi dữ liệu vượt 1000. |
| **Sprint 3** | P2 (correctness/UX) + §4.3/§4.4 (throw + atomic RPC) | Ổn định chất lượng. |
| **Nền (song song)** | P3 dọn dead code + console.* | Giảm nhiễu maintenance. |

**Nguyên tắc khi sửa** (theo CLAUDE.md): mỗi thay đổi phải `npx tsc --noEmit -p tsconfig.app.json` liên quan xanh + test liên quan xanh + **test trực tiếp trên ptcrm.vercel.app bằng Playwright** (happy path + edge case), rồi commit từng file cụ thể (không `git add -A`), push `origin/main`.

---

## Phụ lục — Bảng verdict xác minh (19 finding)

| ID | Finding | Mức thô | **Mức thực** | Verdict | Ghi chú xác minh |
|---|---|---|---|---|---|
| INV-H2 | Hoàn tác xoá nhầm phiếu | HIGH | **HIGH** | CONFIRMED | Hard-delete + sai tiền, cần ≥2 phiếu+backdate |
| SAL-H1 | Trả lương không idempotent | HIGH | **HIGH** | CONFIRMED | 2 phiếu chi = double cash-out |
| AST-C1 | Quota nuốt lỗi tiers | CRIT | **HIGH** | CONFIRMED | Latent (chỉ khi insert fail) |
| CUS-C1 | Lead→cọc luôn lỗi | CRIT | **HIGH** | CONFIRMED | Luồng legacy, không tiền/rò rỉ |
| INV-C1 | Meter import + UNAPPROVED | CRIT | **HIGH** | CONFIRMED | Import hỏng (RPC 1 vs 2 arg); 11 kẹt |
| BLD-C1 | RoomDetailDialog sai cột | CRIT | **HIGH** | CONFIRMED | Chỉ hỏng hiển thị |
| RPT-C1 | Dashboard doanh thu cap | CRIT | **HIGH** | PARTIAL | 889<1000, sắp cắn ~08/2026 |
| INV-C4 | ExcelInvoice cap/KM dư | CRIT | **HIGH** | CONFIRMED | Latent (max 5 inv/HĐ) |
| RPT-C3 | Debt/Overpayment cap | CRIT | **MEDIUM** | PARTIAL | Overpayment gồm HĐ xoá (đang sai); debt đã lọc |
| AUTH-C1 | useMyPermissions nuốt lỗi | CRIT | **MEDIUM** | PARTIAL | Fail-closed, tự hồi ≤5' |
| BLD-C4 | Tab HĐ toà khác | CRIT | **MEDIUM** | PARTIAL | RLS vẫn giới hạn, không rò rỉ vượt quyền |
| SET-M5 | Đổi MK không xác thực | HIGH | **MEDIUM** | CONFIRMED | CWE-620, cần phiên sẵn |
| INV-C3 | Batch phiếu tổng cap | CRIT | **MEDIUM** | PARTIAL | income_expenses 1713>1000, chỉ display |
| BLD-H | Field toà/phòng sai cột | HIGH | **MEDIUM** | CONFIRMED | Hiển thị trống read-only |
| CUS-C2 | Địa chỉ mock | HIGH | **MEDIUM** | PARTIAL | Data-quality trường tùy chọn |
| INV-H3 | EditInvoice decompose | HIGH | **MEDIUM** | PARTIAL | Chỉ rớt dòng trùng keyword |
| AST-H2 | Zalo full-list refetch | HIGH | **MEDIUM/LOW** | PARTIAL | Đã mitigate, tuyến tính có trần |
| AST-H3 | Notification unread lệch | HIGH | **LOW** | PARTIAL | IN_APP luôn PENDING/READ → không lệch thật |
| SET-H1 | SignaturesPage mock | HIGH | **LOW** | PARTIAL | Không có link menu, phơi nhiễm thấp |

---

*Báo cáo dựa trên đọc tĩnh 8 domain + xác minh đối kháng 19 finding + đo thực nghiệm DB. Các finding P2/P3 chưa qua xác minh đối kháng riêng — độ tin cậy cao (bằng chứng file:line) nhưng nên kiểm nhanh khi bắt tay sửa. Chi tiết đầy đủ từng domain lưu ở 8 file `audit-0X-*.md` trong scratchpad phiên làm việc.*
