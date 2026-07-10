# Risk Register — đợt refactor 2026-07-10

> Bảng này để reviewer **ưu tiên soi đúng chỗ rủi ro** thay vì đọc đều. Xếp theo
> mức độ cần kiểm chứng.
>
> **CẬP NHẬT 2026-07-10 (audit vòng 2 — xem `phase-1b-audit-followup.md`):** đã
> xử lý toàn bộ checkpoint. Các mục P0 mới + đã-vá đánh dấu bên dưới.

## 🔴🔴 P0 — Cách ly tenant (audit vòng 2, ĐÃ VÁ + có test tự động)

| # | Rủi ro | Trạng thái | Cách kiểm chứng |
|---|--------|-----------|-----------------|
| P0-1 | `is_admin()` KHÔNG tenant-aware → 147 policy + 42 RPC bypass xuyên-tenant (1 role 'Admin'/full-scope của owner khác đọc/ghi mọi tenant) | **ĐÃ VÁ** (`20260710150000`): is_admin→is_super_admin; helper can_* owner-join; full-scope theo owner | `node scripts/test-cross-tenant.mjs` — ADMIN + FULL-SCOPE staff của tenant X phải thấy 0 dòng tenant Y (pre=leak, post=PASS) |
| P0-2 | Nhánh full-scope `can_access_building`/`can_do_on_building`/`has_*` không join owner | **ĐÃ VÁ** | như P0-1 (test phủ full-scope staff) |
| P0-3 | **LỖ HỔNG LIVE** `can_access_org_entity` một-mình ở nhánh building NULL của assets/asset_warehouses/auto_debt_config | **ĐÃ VÁ**: +`user_id = ANY(current_visible_owner_ids())` | impersonate staff quyền assets của owner A → 0 dòng org-level owner B |
| P0-4 | Còn `staff_assignments` gán tòa của owner KHÁC (uỷ quyền chéo) — nhánh gán-cụ-thể KHÔNG owner-join là CHỦ Ý | theo dõi | live có NG TÂM/B.Huy quản 1 tòa Nathan; thêm same-owner guard khi INSERT assignment là follow-up |

## 🔴 Cao — thay đổi DB live, đụng bảo mật/RLS

| # | Rủi ro | Ở đâu | Cách kiểm chứng |
|---|--------|-------|-----------------|
| R1 | Policy `income_expense_audit_log_select_parent_visible` chặn xuyên-tenant — **PHẢI test tenant-B Admin + full-scope staff, không chỉ user thường** | Phase 1 + 1b | `node scripts/test-cross-tenant.mjs` (kiểm cả `get_income_expense_history(id-của-Y)` → 0 dòng cho ADMIN/FULL-SCOPE) |
| R2 | 128 policy initplan rewrite có đổi ngữ nghĩa dòng thấy/không-thấy không | Phase 4 | Dump `pg_policies` trước/sau, so từng cặp — chỉ khác lớp `(SELECT ...)` |
| R3 | Write path (WITH CHECK) sau rewrite có chặn nhầm ghi | Phase 4 | Playwright: tạo/sửa/duyệt phiếu + HĐ + xe (CHƯA test — mới test đọc) |
| R4 | REVOKE `generate_recurring_vouchers`/`seed_commission_expense_types` có phá cron/luồng hợp lệ | Phase 1 | Xác nhận job recurring kỳ sau chạy + tạo HĐ vẫn sinh loại chi hoa hồng |
| R5 | `salary_staff_months` fallback `auth.uid()` có rò tenant với user lạ | Phase 1 | Đăng nhập user không thuộc tenant nào → trả rỗng, không phải config tenant khác |

## 🔴 Cao (audit vòng 2) — tính đúng tiền + rebuild

| # | Rủi ro | Trạng thái | Cách kiểm chứng |
|---|--------|-----------|-----------------|
| H1 | Máy đối chiếu CŨ so "1000 dòng đầu" (LIMIT trong SQL) — sai mô hình, không đi qua RLS/JWT, coi 1000-dòng là PASS | **ĐÃ VIẾT LẠI** 3 nguồn A=B=C | `node scripts/reconcile-money.mjs` (INCONCLUSIVE nếu ≤1000 — không xanh giả). Đã chứng minh A=B=C trên **1100 dòng** (seed 2099-01) |
| H2 | TS gate xanh GIẢ (đếm số lỗi: compiler không chạy=0 lỗi→"cải thiện"; sửa-1-thêm-1 cùng count qua được) | **ĐÃ VÁ**: fingerprint SET + fail nếu compiler không chạy/parser drift | `node scripts/check-ts-baseline.mjs` (exit 2 khi tsc không chạy; exit 1 khi tập lỗi mới) |
| H3 | Rebuild MẤT trigger bỏ cọc (`trg_forfeit_settle_on_approve` chỉ ở file archive; archive lại là bản 'TM' lỗi thời) | **ĐÃ VÁ**: `20260710160000` tái tạo từ function LIVE 'CT' | fresh replay assert trigger tồn tại + insert 'CT' (chưa có CI DR — xem follow-up) |
| H4 | `fetchAllRows` chạm hardCap TRẢ MẢNG BỊ CẮT (cộng thiếu âm thầm); suy "trang ngắn=hết" | **ĐÃ VÁ**: throw khi hardCap; tiến theo rows thực | `npx vitest run src/lib/__tests__/supabaseFetchAll.property.test.ts` (9 test, có regression server-max<pageSize) |

## 🟡 Trung bình — đụng số tiền / logic hiển thị

| # | Rủi ro | Ở đâu | Cách kiểm chứng |
|---|--------|-------|-----------------|
| R6 | `fetchAllRows` bọc query THIẾU tiebreaker → sót/trùng dòng ranh giới trang | Phase 3 | Mọi chỗ bọc mới có `.order(cột).order("id")` (deposits/reports/cashbook/assets) |
| R7 | Còn `.reduce()` cộng tiền chưa bọc phân trang | **RÀ ĐỦ** (phase-1b §"Rà TẤT CẢ") | Bảng phân loại VULNERABLE(fixed/Phase7-xoá/hoãn)/PAGED/SQL-AGG/BOUNDED |
| R8 | Formatter consolidation có lỡ đổi text tiền chỗ nào | Phase 6 + 1b | `vitest currencyFormat.test.ts` (formatVND/Currency finite-safe, NaN→'0', hoist) |
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

## ✅ Phase 7–10 ĐÃ XONG (2026-07-10) — xem `phase-7-10.md`

Toàn bộ backlog Phase 7–10 đã hoàn thành + verify production (11 commit
`a9c59e6`…`d1ab038`): dọn route/BC chết, BC Lấp đầy v2 (2 RPC + test 14
assertion), 4 UI hết query trực tiếp, god-hook/monolith đã tách (export parity
+ verbatim check), salary dedup period/format. TS baseline 38→32; vitest
699→726.

### Rủi ro/follow-up MỞ sau đợt này
| # | Việc | Ghi chú |
|---|------|---------|
| F1 | **Fresh rebuild / DR baseline** (Gate 6.5 mục hoãn — user chốt hoãn 10/07) | Chuỗi migration chưa replay sạch từ DB rỗng (bundle hand-apply + archive). Khi làm: `pg_dump` → `supabase/schema/baseline.sql` + CI DR test; cần connection string DB trực tiếp (PAT không đủ). KHÔNG ảnh hưởng production |
| F2 | **Atomicity submit ExcelInvoiceDialog** (ghi ở Phase 9C) | Tạo N hoá đơn = N mutation tuần tự; lỗi giữa chừng → một phần thành công (hành vi cũ giữ nguyên). Nếu cần: RPC transaction — làm phase riêng, ĐỪNG trộn vào refactor |
| F3 | `staff_assignments` same-owner guard khi INSERT (P0-4 cũ) | Nhánh gán-cụ-thể không owner-join là CHỦ Ý (uỷ quyền chéo live) — chỉ cần guard lúc tạo assignment mới |
| F4 | Salary UI Sheet/DRow ×2 biến thể | KHÔNG gộp được (khác hành vi dấu trừ + props). Nếu muốn hợp nhất phải là quyết định UI có chủ ý, không phải refactor |

### Hoãn trong phase 1–6
- **queryKeys registry + rework realtime hub** (Phase 5): rủi ro cache-stale trên
  trang tiền, cần lưới test dày.
- **6 report còn formatCurrency local** component-scoped (Phase 6): cơ học đa dòng.
- **Rà hết `.reduce()` cộng tiền** ngoài 5 hook đã làm (Phase 3).
- Gỡ nốt ~1045 `as any` còn lại (Phase 2).

---

## Cách chạy lại toàn bộ verify (cho reviewer) — THỰC THI ĐƯỢC, không placeholder

```bash
# 0. CÁCH LY TENANT — ma trận âm bản owner/Admin/full-scope staff (P0)
node scripts/test-cross-tenant.mjs    # kỳ vọng: ✅ CÁCH LY TENANT PASS (không rò)
                                      # (tự dựng tenant tổng hợp trong txn ROLLBACK)

# 1. TS không regress (fingerprint SET; exit 2 nếu tsc không chạy)
node scripts/check-ts-baseline.mjs    # kỳ vọng: = baseline (38 fingerprint)

# 2. Test (chạy full-parallel bị OOM trên máy này → dùng --no-file-parallelism)
npx vitest run --no-file-parallelism  # kỳ vọng: 699 pass

# 3. Đối chiếu tiền 3 NGUỒN A=B=C (đọc PAT + tài khoản test từ CLAUDE.local.md)
node scripts/reconcile-money.mjs      # ✅ PASS nếu kỳ >1000 dòng; exit 3 INCONCLUSIVE
                                      # nếu không kỳ nào >1000 (KHÔNG báo xanh giả)
# Chứng minh >1000: seed kỳ tổng hợp 2099-01 (1100 dòng) → A=B=C rồi cleanup.

# 4. View không lộ tenant
node scripts/check-view-invoker.mjs   # kỳ vọng: ✅ 6/6 security_invoker=true

# 5. Build production
npx vite build                        # kỳ vọng: ✓ built

# 6. Đối chiếu định nghĩa hàm/policy LIVE vs migration (nếu cần soi sâu)
node scripts/query-sql.mjs <file.sql> # in FULL JSON kết quả SELECT
```
