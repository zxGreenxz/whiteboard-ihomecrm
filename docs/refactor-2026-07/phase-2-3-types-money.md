# Phase 2 & 3 — Nền móng types + Đúng số tiền

## Phase 2 — Regen types.ts + ratchet TS baseline

**Commit:** `b4a496b` · **Loại:** FE

### Vì sao
`src/integrations/supabase/types.ts` cũ 25 migration (thiếu
`buildings.hidden_fixed_expenses`, `invoices.kind`, `income_expenses.commission_kind`,
`cluster_id`, toàn bộ batch 20260710). Đây là nguồn của ~1.132 `as any` (cast cả tên
bảng). Regen mở khoá gỡ cast cho mọi phase sau.

### Đã làm
- `npx supabase gen types typescript` → ghi đè types.ts (8410 → 10436 dòng), thêm
  lại comment header.
- Gỡ cast tên bảng `.from("x" as any)` → `.from("x")` ở 7 hook (cast NGOÀI giữ
  nguyên, chỉ bỏ cast tên bảng). `as any` giảm: useManagerSalary 106→81,
  useIncomeExpenses 77→40, useShareholderProfit 49→31, useContracts →30,
  useInvoicePayments →36, useSalaryConfig →23. Tổng src 1132→1045.
- Hạ tầng ratchet: `ts-baseline.txt` (106) + `scripts/check-ts-baseline.mjs` +
  `npm run typecheck:baseline` (fail nếu lỗi TĂNG) + `npm run gen:types`.
- Ghi quy trình regen vào CLAUDE.md.

### Verify
- `tsc -p tsconfig.app.json` = 106 SAU regen. **Đã diff bộ lỗi trước/sau**: giống
  hệt baseline, chỉ khác chuỗi mô tả type (schema thêm cột `cluster_id` → "28 more"
  thay "25 more") — cùng 3 lỗi cũ trên BuildingDetailPage, không phát sinh lỗi mới.
- vitest 620 pass; `vite build` xanh.

### Reviewer cần soi
- Việc gỡ cast tên bảng là an toàn (cast ngoài giữ nguyên nên column-access vẫn
  `any`). Nhưng nên spot-check 1-2 hook (vd useManagerSalary) xác nhận không có
  đường nào column-access sai kiểu mà tsc bỏ sót do cast ngoài còn.

---

## Phase 3 — Diệt bug cap-1000 khi cộng tiền + máy đối chiếu

**Commit:** `a050c24` · **Loại:** FE + tool · **File chính:**
`src/lib/supabaseFetchAll.ts`, `scripts/reconcile-money.mjs`

### Vì sao
PostgREST giới hạn 1000 dòng/response. Chỗ nào SELECT list rồi `.reduce()` cộng
tiền mà không phân trang sẽ **âm thầm hụt tổng** khi vượt 1000 dòng — bug class từng
làm mất ~1,5 tỷ (án lệ repo). Đồng thời giải điểm đau #1 của user: "không tin số
liệu phải đối chiếu tay".

### Đã làm
1. **`src/lib/supabaseFetchAll.ts`** — `fetchAllRows(build, opts)`: lặp phân trang
   `.range()` 1000/chunk tới khi trang cuối ngắn hơn PAGE, gộp đủ. Gom convention
   `fetchAll` đã có sẵn trong `useAccrualReport.ts` thành helper tái dùng. Có
   `hardCap` (100k) chống loop vô tận nếu order không ổn định. Property test
   `supabaseFetchAll.property.test.ts` (fast-check 0..3500 dòng, bội số trang, lỗi,
   pageSize nhỏ).
2. **`useReports.useExpenseRatioReport`**: 2 query cộng THU/CHI qua **13 tháng ×
   mọi toà** trước đây KHÔNG phân trang → bọc `fetchAllRows` (thêm order
   `voucher_date desc, id asc` làm tiebreaker phân trang).
3. **`useManagerSalary`**: query hoa hồng (`income_expense_items` cả tháng, không
   chặn per-entity) bọc `fetchAllRows`.
4. **`scripts/reconcile-money.mjs`**: với mỗi chỉ tiêu tiền (tổng THU, tổng CHI, nợ
   hoá đơn, số dư sổ quỹ) tính 2 cách — SUM SQL thật vs tổng-1000-dòng-đầu — in
   PASS/FAIL. Cổng kiểm cho mọi phase đụng tiền về sau.

### Bằng chứng bug là THẬT (không lý thuyết)
Cửa sổ 13 tháng của `useExpenseRatioReport` hiện có **968 phiếu INCOME** — SÁT
ngưỡng 1000. Với đà ~347 phiếu/tháng (tháng 05), trong 1-2 tháng nữa cửa sổ này
vượt 1000 → âm thầm cắt số doanh thu. Fix đúng lúc, chưa kịp sai.

### Verify
- Property test fetchAllRows 4 pass.
- `reconcile-money.mjs`: THU 1.474.943.220 / CHI 1.469.805.951 / nợ HĐ 278.280.423
  — **đều khớp SQL** (tháng 05 có 347/232 dòng, chưa vượt cap nên khớp là đúng).
- tsc baseline=106; vite build xanh.

### Ghi chú quan trọng
Phát hiện **code chết** trong useReports (0 usage, join bảng `tenants`/`expenses`
cũ đã bỏ): `useCashBookReport`, `useCashFlowReport`, `useProfitDistributionReport`,
`useDebtReport`, `useCustomerDebtReport` → sẽ XOÁ ở Phase 7. KHÔNG sửa cap-1000 cho
chúng (vô nghĩa vì sắp xoá).

### Reviewer cần soi
1. **Tiebreaker order**: `fetchAllRows` chỉ đúng nếu query có order ỔN ĐỊNH (cột +
   `id` tiebreaker). Đã thêm `.order("id")` vào 2 query bọc. Xác nhận không query
   nào bọc mà thiếu tiebreaker (sẽ sót/trùng dòng ở ranh giới trang).
2. **Còn reduce cộng tiền nào chưa bọc?** Phase 3 tập trung useReports + salary. Các
   hook khác (useInvoices, useInvoicePayments, useShareholderProfit) phần lớn cộng
   theo entity (per-invoice/per-contract) bị chặn tự nhiên — nhưng NÊN rà lại
   `.reduce(` đụng tiền toàn `src/hooks` và đánh dấu PAGED/BOUNDED (chưa làm hết).
3. **reconcile-money mới có 4 chỉ tiêu.** Thêm chỉ tiêu (vd tổng chia LN, tổng cọc,
   lương từng NV) để phủ rộng hơn.
