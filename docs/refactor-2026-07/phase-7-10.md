# Phase 7–10 — Dọn route/BC chết → BC Lấp đầy mới → tách data layer → mổ monolith

> Tiếp nối phase 1–6 + 1b (xem `README.md`). Plan gốc: `dataexcel/PHASE 7–10.md.txt`,
> plan hoàn thiện đã kiểm chứng code: plan file session 2026-07-10.
> Quyết định chủ hệ thống: TS gate = **ratchet fingerprint** (không đòi tsc=0);
> fresh rebuild/DR = **HOÃN** (ghi Risk register); Phase 7/9/10 **0 thay đổi DB**,
> Phase 8 chỉ **+2 RPC chỉ-đọc**.

## Gate 6.5 (điều chỉnh) — chạy 2026-07-10, TẤT CẢ XANH

| Check | Kết quả |
|---|---|
| `node scripts/test-cross-tenant.mjs` | ✅ PASS (owner/Admin/full-scope staff X thấy 0 dòng Y) |
| `node scripts/check-ts-baseline.mjs` | ✅ = baseline 38 fingerprint (trước Phase 7) |
| `npx vitest run --no-file-parallelism` | ✅ 699 pass / 60 file |
| `node scripts/check-view-invoker.mjs` | ✅ 6/6 security_invoker |
| `npx vite build` | ✅ built |

---

## PHASE 7 — Dọn báo cáo chết + chuẩn hoá URL

**Commit:** `a9c59e6` `refactor(routes): dọn báo cáo chết + chuẩn hoá URL (Phase 7)`
(push main 2026-07-10, deploy Vercel OK). **DB: không đổi.**

### Đã làm
1. **Route canonical `/reports/finance/*`** — 7 route số ít `/report/finance/*`
   (trước đây RENDER component thật) chuyển thành `<Navigate replace>`:
   analysis→analysis, cashbook→daily-cashbook, cash-flow→cash-flow,
   billing-calendar→payment-schedule, prepaid→overpayment, deposit→deposits,
   debt→`/thu-tien`. Sidebar (7 link) + FinanceReportsPage (card analysis) +
   Breadcrumbs đồng bộ; Breadcrumbs thêm label analysis/ban-giao/thu-ban-giao,
   xoá label chết occupancy-old/occupancy-new.
2. **Xoá 2 BC công nợ** `DebtReport.tsx` + `CustomerDebtReport.tsx` +
   `useDebtReport`/`useCustomerDebtReport`. 4 URL debt redirect `/thu-tien`
   (`/report/finance/debt`, `/reports/finance/{debt,new-contract-debt,customer-debt}`).
   Hub tài chính 11 → 9 card.
3. **Xoá 3 hook chết** `useCashBookReport`/`useCashFlowReport`/`useProfitDistributionReport`
   (0 call site — CashFlowReport page dùng `useCashFlowByDay` khác; 2 hook đọc bảng
   `payments`/`expenses` legacy không còn dùng).
4. **Xoá module tenants legacy**: `TenantsPage.tsx` + 3 dialog (0 importer — App.tsx
   không import từ trước, route `/tenants` đã redirect `/customers`).
5. **Hợp nhất BC lấp đầy**: xoá `OccupancyReport.tsx` cũ, `OccupancyNewReport` đổi
   tên thành `OccupancyReport` (component + file), canonical
   `/reports/real-estate/occupancy`, `/occupancy-new` redirect. GIỮ
   `useOccupancyReport`/`useOccupancyTrend` — Phase 8 thay.
6. **Permission**: gỡ `debt`/`customer_debt` khỏi UI cấu hình (permissionPages,
   extra list, MANAGE_ACTIONS); GIỮ union `ActionKey` + nhãn "(đã bỏ)" —
   legacy-tolerant, KHÔNG migration.

### Verify
- `check-ts-baseline`: 3 lỗi baseline được SỬA (2 useReports + 1 TenantsPage) →
  ghi lại baseline **38 → 35 fingerprint** (101 lỗi thô, `ts-baseline.txt` 106→101).
- `vitest --no-file-parallelism`: 699 pass. `vite build`: ✅.
- Browser production (Playwright, đăng nhập test): hub "9 loại báo cáo" ✅;
  redirect `/report/finance/analysis`→analysis ✅, cashbook→daily-cashbook ✅,
  prepaid→overpayment ✅, `/report/finance/debt` + `/reports/finance/debt` +
  new-contract-debt → `/thu-tien` ✅; `/occupancy-new`→`/occupancy` render đủ
  KPI/trend/bảng ✅. Console: **0 error**.

### Rủi ro mở / ghi chú
- Trend chart bản cũ hiển thị đỉnh 105.9% (bug client-side đếm HĐ chồng lấn) —
  đây chính là lý do Phase 8 chuyển tính toán xuống DB.
- Rollback: `git revert a9c59e6` (không có DB).

---

## PHASE 8 — Làm lại báo cáo Lấp đầy

**Commit:** `7d9082f` `feat(reports): làm lại báo cáo lấp đầy (Phase 8)` (push main
2026-07-10, deploy Vercel OK). **DB: +1 migration `20260710180000_occupancy_v2_rpcs.sql`
— CHỈ THÊM 2 hàm RPC chỉ-đọc, không đụng bảng/dữ liệu; áp live qua Management API.**

### Đã làm
1. **2 RPC mới** (`SECURITY INVOKER` + lọc `can_access_building`; `p_building_ids`
   chỉ THU HẸP trong scope — id lạ bị loại im lặng; REVOKE anon):
   - `occupancy_snapshot_v2(p_as_of_date, p_building_ids)` — 5 nhóm phân hoạch đủ
     total (occupied/reserved/maintenance/unavailable/available) + occupancy_pct +
     committed_pct + missed_revenue (chỉ phòng AVAILABLE, `GREATEST(rent,0)`).
     `occupied` = HĐ ACTIVE `start<=as_of` chưa `actual_end_date` — CHỦ Ý không cắt
     `end_date` (HĐ quá hạn chưa thanh lý = khách vẫn ở, khớp hook cũ 264/264).
     Trạng thái lạ (OCCUPIED mồ côi HĐ) → unavailable, KHÔNG vào available.
   - `occupancy_upcoming_vacancy_v2(as_of, window, buildings)` —
     `effective_end = GREATEST(end_date, MAX new_end_date extension APPROVED|COMPLETED)`
     (không dùng status EXTENDED); 1 phòng 1 dòng (end xa nhất); cửa sổ 0..N ngày.
2. **Test tự động `scripts/test-occupancy-v2.mjs`** — 14 assertion PASS, fixture
   tổng hợp trong txn ROLLBACK: cách ly tenant (X truyền building Y → 0 dòng),
   invariant, boundary 0/30/31/60, extension APPROVED/COMPLETED đẩy bucket còn
   DRAFT/CANCELLED thì không, HĐ chồng nhau distinct, toà 0 phòng pct=0,
   **1100 phòng đếm đủ (không cap-1000)**. Gotcha fixture: owner thấy toà qua
   staff_assignments FULL-SCOPE (không có nhánh `b.user_id=auth.uid()` trong helper).
3. **FE mới**: `src/hooks/reports/useOccupancyDashboard.ts` (3 hook + hằng
   `OCCUPANCY_METRIC_DEFINITIONS`) + `OccupancyReport.tsx` viết lại: 8 KPI, trend
   12 tháng (tái dùng `fa_occupancy_monthly`), bar lấp đầy+cam kết, bảng theo toà,
   bảng sắp trống tab 30/60 + badge gia hạn, filter `BuildingFilterSelect` + ngày
   snapshot, loading/error/retry/empty, export kèm ngày + bộ lọc + định nghĩa metric.
4. **Xoá client aggregation**: `useOccupancyReport`/`useOccupancyTrend` gỡ khỏi
   `useReports.ts`. Regen `types.ts` (baseline TS giữ 35, không lỗi mới).

### Verify
- `test-occupancy-v2` 14/14 ✅; `test-cross-tenant` ✅; `check-view-invoker` 6/6 ✅;
  vitest 699 ✅; build ✅; TS baseline 35 không đổi ✅.
- Smoke live (impersonate owner): 17 toà, 273 phòng = 264 occupied + 1 reserved +
  8 available, invariant 0 vi phạm, occupied khớp định nghĩa cũ 264/264,
  vacancy 30/60 = 10/168, missed 31tr.
- Browser production: trang mới render đủ KPI (giữ chỗ/không khai thác), tab 60
  ngày ra 168 dòng khớp RPC, trend hiển thị (hết bug >100%), console 0 lỗi,
  mobile 390px không tràn ngang.

### Ghi chú định nghĩa (tránh hiểu nhầm về sau)
- Snapshot vs trend dùng 2 định nghĩa occupied KHÁC NHAU CÓ CHỦ Ý (hiện tại vs
  lịch sử) — đã ghi trong comment migration + hook + export.
- Rollback: revert commit FE; RPC additive vô hại, cần gỡ thì chạy 2 lệnh DROP
  trong comment `-- ROLLBACK` của migration.

---

## PHASE 9 — Tách query khỏi 4 UI (0 thay đổi DB, mỗi subphase 1 commit + verify riêng)

### 9A — OwnerDashboardV5 → `hooks/salary-v5/useSalaryV5Admin.ts`
**Commit `fee6cda`.** 6 query (building_coverage, salary_attendance_day flagged,
inspection_sessions+profiles map, inspection_photos, v5_lock_assert,
v5_shadow_report, get_salary_v5_config, cron_runs) + 4 mutation (set_salary_v5_config,
v5_verdict, v5_apply_lock_adjustments, run edge-fn job) vào hook. Query key +
invalidation + toast GIỮ NGUYÊN; bỏ hết `as any` theo bảng (types.ts đã regen);
DTO khai báo rõ. **Verify production:** /reports/coverage đủ 6 tab, 17 thẻ
coverage, bảng đối soát 10 NV, console 0 lỗi.

### 9B — ContractDetailView → `hooks/contracts/useContractDetailData.ts`
**Commit `4db880e`.** 6 query phụ vào hook (4 query cũ GIỮ key; services/history
trước là useEffect+state thủ công → useQuery, key mới `contract-services`/
`contract-history`). **Sửa 4 chỗ nuốt lỗi** (console.error → []/null) thành
throw + Alert đỏ gom lỗi. Sửa 1 fingerprint TS: `invoice.title`/`billing_period_*`
là CỘT MA không có trong schema (runtime luôn undefined) — bỏ tham chiếu, giữ
nguyên hiển thị. Baseline 35→34. **Verify production:** mở HĐ thật, 5 tab
render, không Alert lỗi, console 0 lỗi.

### 9C — ExcelInvoiceDialog → `lib/excelInvoiceRows.ts` + `hooks/invoices/useExcelInvoiceData.ts`
**Commit `449fee9`.** Characterization test TRƯỚC khi chuyển: **21 test** chốt
hành vi (dedupe phòng 2 HĐ giữ mới nhất, reading mới nhất, credit bỏ nguồn xoá,
nợ cũ carry-over 2 pass + ngưỡng, promo slot, prorate, items order/điện theo
consumption, applied_credit kẹp min, override nợ → clear sources). Transform
trích NGUYÊN VĂN vào lib; fetch 5 nguồn + submit loop (chốt chỉ số điện + tạo
HĐ qua useCreateInvoice) vào hook. CHỦ Ý không dùng useQuery cho nguồn lập hoá
đơn (số tiền phải TƯƠI lúc bấm Tải — cache stale nguy hiểm). KHÔNG đổi sang RPC
transaction — rủi ro atomicity submit một phần ghi ở Risk register. Dialog
1110→~640 dòng. Vitest 699→**720**. reconcile-money exit 3 INCONCLUSIVE (kỳ
hiện tại ≤1000 phiếu — hành vi đúng, không xanh giả; công thức tiền không đổi).
**Verify production:** mở Mode Excel, tải toà 15KV → đúng 8 phòng, nút "Tạo 8
hoá đơn" (KHÔNG bấm — tránh tạo hoá đơn thật), console 0 lỗi.

### 9D — ExportExcelDialog → `lib/exportDatasetRegistry.ts` + `hooks/exports/useExportDataset.ts`
**Commit `274877a`.** Registry 7 entity, select cột TƯỜNG MINH (hết select('*')).
**FIX bug cap-1000 thật:** bản cũ 1 query không .range → file >1000 dòng bị cắt
ÂM THẦM; nay fetchAllRows phân trang + tiebreaker id, hard cap 50k → chạm trần/
lỗi là THROW + Alert đỏ (hết nuốt lỗi console.error). **FIX 3 cột ma** bản cũ
xuất rỗng/Invalid Date: invoices `billing_period_from/to` (không có trong
schema) → suy từ billing_month + hoist tenant từ contract; payments
`reference_number` → alias `receipt_number`; contracts thiếu tenants.phone.
Sửa 2 fingerprint TS excelHelpers (parseExcelFile thiếu type param phần import).
Baseline 34→**32** (74 lỗi thô). **Verify production:** /leads → Xuất Excel →
file tải về + báo "Đã tải xuống 0 dòng" (danh sách rỗng — đếm đúng), console 0 lỗi.

### Acceptance Phase 9 — ĐẠT
4 UI target 0 `.from(`/0 `.rpc(` (chỉ còn `Array.from` không liên quan); query
key không đổi trừ 2 key mới có ghi chú (9B); loading/error/empty đầy đủ (9B/9D
còn TỐT HƠN cũ — lỗi không còn bị nuốt); công thức tiền/salary không đổi (21
characterization test + suite 720); mỗi subphase 1 commit revert độc lập.

---

*(Phase 10 sẽ được ghi tiếp bên dưới sau khi hoàn thành từng subphase.)*
