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

*(Các phase 8–10 sẽ được ghi tiếp bên dưới sau khi hoàn thành từng subphase.)*
