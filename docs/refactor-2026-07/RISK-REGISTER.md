# Risk Register — đợt refactor 2026-07-10

> Bảng này để reviewer **ưu tiên soi đúng chỗ rủi ro** thay vì đọc đều. Xếp theo
> mức độ cần kiểm chứng.

## 🔴 Cao — thay đổi DB live, đụng bảo mật/RLS

| # | Rủi ro | Ở đâu | Cách kiểm chứng |
|---|--------|-------|-----------------|
| R1 | Policy `income_expense_audit_log_select_parent_visible` có THỰC SỰ chặn xuyên-tenant | Phase 1 | Đăng nhập tenant B, `get_income_expense_history(id-của-A)` → phải rỗng |
| R2 | 128 policy initplan rewrite có đổi ngữ nghĩa dòng thấy/không-thấy không | Phase 4 | Dump `pg_policies` trước/sau, so từng cặp — chỉ khác lớp `(SELECT ...)` |
| R3 | Write path (WITH CHECK) sau rewrite có chặn nhầm ghi | Phase 4 | Playwright: tạo/sửa/duyệt phiếu + HĐ + xe (CHƯA test — mới test đọc) |
| R4 | REVOKE `generate_recurring_vouchers`/`seed_commission_expense_types` có phá cron/luồng hợp lệ | Phase 1 | Xác nhận job recurring kỳ sau chạy + tạo HĐ vẫn sinh loại chi hoa hồng |
| R5 | `salary_staff_months` fallback `auth.uid()` có rò tenant với user lạ | Phase 1 | Đăng nhập user không thuộc tenant nào → trả rỗng, không phải config tenant khác |

## 🟡 Trung bình — đụng số tiền / logic hiển thị

| # | Rủi ro | Ở đâu | Cách kiểm chứng |
|---|--------|-------|-----------------|
| R6 | `fetchAllRows` bọc query THIẾU tiebreaker → sót/trùng dòng ranh giới trang | Phase 3 | Grep các chỗ bọc, xác nhận có `.order(cột).order("id")` |
| R7 | Còn `.reduce()` cộng tiền chưa bọc phân trang (chưa rà HẾT) | Phase 3 | Rà toàn `src/hooks/*.reduce(` đụng tiền, đánh dấu PAGED/BOUNDED |
| R8 | Formatter consolidation có lỡ đổi text tiền chỗ nào | Phase 6 | `vitest currencyFormat.test.ts` + Playwright grep "₫" (không được xuất hiện chỗ cũ dùng "đ") |
| R9 | Gỡ cast tên bảng có che lỗi kiểu column-access | Phase 2 | Spot-check useManagerSalary/useIncomeExpenses |

## 🟢 Thấp — cơ học, verify tự động đủ

- Gate `enabled: open` (Phase 5) — chỉ giảm fetch thừa, không đổi kết quả.
- Dọn console.log (Phase 5).
- Viewport `HomeRoute` dùng `usePhoneViewport` (Phase 6) — logic byte-identical.
- Dọn migration replay sang archive (Phase 4) — chỉ di chuyển file.

---

## Quyết định nghiệp vụ đang TREO (cần chủ hệ thống chốt)

| Vấn đề | Trạng thái | Ghi chú |
|--------|-----------|---------|
| **Chia LN bỏ sót phiếu NV** (`monthly_building_profit` lọc `user_id=owner`, thiếu ~1,8 tỷ thu/1,3 tỷ chi do NV tạo) | **HOÃN** theo yêu cầu user | Khi làm: BẮT BUỘC dry-run diff theo toà/tháng cho user duyệt trước (chốt mềm). Đây là con số ĐÃ báo cho cổ đông → đổi phải có chủ ý. |

---

## Backlog (Phase 7–10 CHƯA làm) + việc hoãn trong phase 1–6

### Phase 7 — Dọn route + xoá page chết (user đã yêu cầu xoá)
- Xoá `DebtReport` + `CustomerDebtReport` (2 BC công nợ — user nói "bỏ, đã làm bên
  /thu-tien") + hook `useDebtReport`/`useCustomerDebtReport`.
- Xoá code chết đã phát hiện: `useCashBookReport`, `useCashFlowReport`,
  `useProfitDistributionReport` (0 usage, join bảng cũ), `pages/tenants/TenantsPage.tsx`
  (0 importer), `OccupancyReport` cũ.
- Dồn 2 scheme URL `/report/finance/*` + `/reports/finance/*` về 1 canonical.

### Phase 8 — Làm lại BC Lấp đầy (user yêu cầu tính năng mới)
Trang mới thay `OccupancyNewReport` gồm: snapshot+trend dễ hiểu, **cột ĐÃ CỌC/giữ
chỗ** (tách `rooms.RESERVED`), **dự báo SẮP TRỐNG** (HĐ hết hạn 30/60 ngày chưa gia
hạn — suy từ `contract_extensions` KHÔNG từ status EXTENDED), **doanh thu tiềm năng
bỏ lỡ** (phòng trống × giá).

### Phase 9–10 — Rút query khỏi component + mổ god-hook/monolith
- Rút `.from()` trực tiếp khỏi OwnerDashboardV5 (10), ExcelInvoiceDialog (9),
  ContractDetailView (8), ExportExcelDialog (7).
- Mổ god-hook: useIncomeExpenses (2178), useReports (1476)... thành shell re-export.
- Mổ monolith: ContractFormDialog (2196), ContractDetailView (1573); dedup salary ×4.

### Hoãn trong phase 1–6
- **queryKeys registry + rework realtime hub** (Phase 5): rủi ro cache-stale trên
  trang tiền, cần lưới test dày.
- **6 report còn formatCurrency local** component-scoped (Phase 6): cơ học đa dòng.
- **Rà hết `.reduce()` cộng tiền** ngoài 5 hook đã làm (Phase 3).
- Gỡ nốt ~1045 `as any` còn lại (Phase 2).

---

## Cách chạy lại toàn bộ verify (cho reviewer)

```bash
# 1. TS không regress
npm run typecheck:baseline           # kỳ vọng: = baseline (106)

# 2. Test
npx vitest run                        # kỳ vọng: all pass

# 3. Đối chiếu tiền (đọc PAT từ CLAUDE.local.md)
node scripts/reconcile-money.mjs      # kỳ vọng: ✅ TẤT CẢ KHỚP
node scripts/reconcile-money.mjs 2026-05

# 4. View không lộ tenant
node scripts/check-view-invoker.mjs   # kỳ vọng: ✅ 6/6 security_invoker=true

# 5. Build production
npx vite build                        # kỳ vọng: ✓ built

# 6. Kiểm grant hàm đã vá (tự viết SQL, chạy qua)
node scripts/query-sql.mjs <file.sql>
```
