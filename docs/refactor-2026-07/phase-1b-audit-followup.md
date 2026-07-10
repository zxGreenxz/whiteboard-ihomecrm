# Phase 1b — Vá theo audit vòng 2 (2026-07-10)

> Đợt này xử lý toàn bộ checkpoint audit vòng 2 (P0 xuyên-tenant → P1 tiền/gate →
> P2/P3), **kiểm chứng từng kết luận trên DB live trước khi vá**, và để lại
> **test tự động** cho mỗi lỗ hổng để migration tương lai không tái phát.
> DỪNG Phase 7–10 theo yêu cầu.

## Nguyên tắc đã áp dụng

- Mọi thay đổi DB apply TRỰC TIẾP qua Management API (`scripts/apply-sql.mjs`,
  UTF-8), có migration in-chain + `-- ROLLBACK` an toàn (KHÔNG khôi phục bản dễ
  tổn thương — xem §Rollback).
- Chứng minh trước/sau bằng test tự động, không chỉ suy luận.

---

## P0 — Cách ly tenant (migration `20260710150000_tenant_isolation_hardening.sql`)

### Kiểm chứng (đã xác nhận audit ĐÚNG)

Query live `pg_policies` + `pg_proc`:

- `is_admin()` = "giữ role tên `Admin` hoặc `permissions @> {\"__superadmin\":true}`
  ở **BẤT KỲ** `staff_assignments` nào, KHÔNG kiểm `sa.user_id` (owner)" → **147
  policy PERMISSIVE** nhúng bare `is_admin()` (82 `*_admin_all` cmd=ALL + 65
  compose/misc) + 42 RPC + 4 helper lõi. Đây là **bypass xuyên-tenant**.
- Nhánh full-scope (`building_id IS NULL AND area_id IS NULL`) trong
  `can_access_building`/`can_do_on_building`/`has_full_building_scope`/
  `has_perm_full_scope` **KHÔNG join buildings theo owner** → 1 assignment
  full-scope thấy MỌI tòa MỌI owner.
- **LỖ HỔNG LIVE (không tiềm ẩn)** — audit chưa nêu: `can_access_org_entity()`
  dùng MỘT MÌNH ở nhánh `building_id IS NULL` của `assets`/`asset_warehouses`/
  `auto_debt_config` → staff giữ quyền các bảng đó DƯỚI BẤT KỲ owner đọc/ghi được
  dòng cấp-tổ-chức của MỌI owner.

**Blast radius (đã đo):** hiện chỉ NG TÂM thoả `is_admin()`, mà NG TÂM cũng là
`super_admin` DUY NHẤT; **0 staff full-scope**. ⇒ lỗ hổng phần lớn TIỀM ẨN, kích
hoạt ngay khi 1 owner khác tạo role `Admin`/`__superadmin` hoặc cấp 1 assignment
full-scope.

### Vá (đòn bẩy: sửa HELPER thay vì viết lại 147 policy)

1. `is_admin()` → `is_super_admin()` — no-op với dữ liệu hiện tại (NG TÂM giữ
   nguyên), khoá mọi bypass admin-cấp-tenant trong 147 policy + 42 RPC 1 phát.
2. `can_access_building` / `can_do_on_building`: nhánh full-scope + admin
   **JOIN buildings b ON b.user_id = sa.user_id** (mẫu đúng có sẵn ở
   `ie_all_buildings_scope`). GIỮ nhánh gán-tòa-cụ-thể/khu KHÔNG join owner (live
   có uỷ quyền chéo-owner hợp lệ: NG TÂM/B.Huy quản 1 tòa của Nathan — verify được).
3. `accessible_building_ids` / `permitted_building_ids`: thêm nhánh full-scope
   **theo owner** (chỉ tòa cùng owner); `has_full_building_scope()`/
   `has_perm_full_scope()` rút về `is_super_admin()` (full-scope-staff đi qua tập
   building owner-bounded). No-op hôm nay (0 staff full-scope).
4. `assets`/`asset_warehouses`/`auto_debt_config`: nhánh org-level (building NULL)
   `AND user_id = ANY(current_visible_owner_ids())`.
5. Bổ sung `*_super_admin_all` cho 2 bảng thiếu (`account_shared_users`,
   `push_subscriptions`) rồi **DROP 82 `*_admin_all`** (đã dư sau khi is_admin→super).

### Đối chứng tự động: `node scripts/test-cross-tenant.mjs`

Dựng 2 tenant TỔNG HỢP cô lập trong 1 transaction ROLLBACK, giả dạng qua RLS thật
(SET ROLE authenticated + `request.jwt.claims`) **3 loại principal của tenant X:
OWNER, ADMIN (role 'Admin'), FULL-SCOPE staff** (đúng yêu cầu R1).

- **TRƯỚC vá:** ADMIN + FULL-SCOPE staff của X đọc/ghi được TẤT CẢ dữ liệu tenant
  Y (buildings/rooms/contracts/income_expenses), `get_income_expense_history(Y)`
  lộ, `generate_invoices_for_building_v2(Y)` **KHÔNG bị chặn** (ghi xuyên-tenant).
- **SAU vá:** cả 3 principal thấy 0 dòng tenant Y, generate bị chặn (Access denied);
  VẪN thấy tenant X của mình. ✅ PASS.

**Regression thật:** impersonate NG TÂM (super) vẫn thấy 24 tòa non-demo / 1745 ie;
Nathan giữ 10 tòa (khớp trước vá); Joey 8 tòa; demo staff chỉ thấy tenant demo.
Không mất quyền hợp lệ nào. `check-view-invoker.mjs` 6/6.

---

## P1 — Tính đúng của tiền

### `fetchAllRows` fail-closed (`src/lib/supabaseFetchAll.ts`)

- Chạm `hardCap` → **THROW** (không trả mảng bị cắt).
- Validate `pageSize`/`hardCap`.
- **KHÔNG suy "trang ngắn = hết"** — tiến theo số dòng THỰC nhận, chỉ dừng khi
  trang RỖNG (an toàn khi server max-rows < pageSize). +9 test (regression đủ).

### `useManagerSalary` — `ciRaw === null` phải THROW (không thành hoa hồng 0).

### 5 KPI/tổng tiền → RPC SQL aggregate (migration `20260710170000_money_aggregate_rpcs.sql`)

`get_overpayment_summary`, `get_held_deposit_summary`, `get_reservation_deposit_summary`,
`get_refund_forfeit_summary`, `get_deposits_report_summary` — **TẤT CẢ SECURITY
INVOKER** (mỗi hook hiện là plain select ⇒ INVOKER tái tạo ĐÚNG scope RLS, không
drift; DEFINER sẽ SAI cho reservation vì income_expenses RLS ≠ can_access_building).
+ `cashbook_period_totals`, `cashflow_by_day` (site LIVE nguy hiểm nhất per sweep).
FE: KPI dùng RPC; danh sách chi tiết bọc `fetchAllRows` (bảng không bị cắt).
`AssetsPage`/`useAssets` bọc `fetchAllRows`.

### Rà TẤT CẢ `.reduce()` tiền — phân loại (không backlog chung chung)

| Nhóm | Ví dụ | Xử lý |
|------|-------|-------|
| **VULNERABLE → ĐÃ FIX** | 5 hook trên + `useCashBook` (summary/by-day) + `useAssets` | RPC aggregate / PAGED |
| **VULNERABLE → Phase 7 XOÁ** | `useDebtReport`/`useCustomerDebtReport` (user bảo bỏ), `useCashBookReport`/`useCashFlowReport`/`useProfitDistributionReport` (0 usage, bảng cũ) | KHÔNG fix — sẽ xoá |
| **VULNERABLE → HOÃN (chia LN)** | `useShareholderProfit` (profit_allocations/distributions/monthly) | user HOÃN module chia LN; cross 1000 ~1.5–2 năm; ghi nhận |
| **VULNERABLE → theo dõi** | `PersonalWalletPage`, `ThuTien` (borderline ~700/1000), `usePaymentsSummary` (dead) | ghi nhận; fix khi cần |
| **PAGED (an toàn)** | `useAccrualReport`, `useExpenseRatioReport`, `useManagerSalary` | fetchAll + order + id |
| **SQL-AGGREGATED (an toàn)** | `fa_*`, `get_deposit_breakdown_v2`, `get_period_*` | RPC-sourced |
| **BOUNDED (an toàn)** | per-invoice/contract/voucher item sums | < 1000 by scope |

### Máy đối chiếu viết lại (`scripts/reconcile-money.mjs`) — 3 NGUỒN ĐỘC LẬP

A = SUM SQL (Management API, chân lý, bỏ demo để khớp scope super_admin) ·
B = RPC `get_income_expense_layer_stats` qua **JWT + RLS thật** ·
C = **phân trang FE** (`.range` loop, order + id) — cơ chế cap-1000 THẬT (không
phải `LIMIT 1000` trong SQL). PASS ⟺ **A === B === C**. Có validate `YYYY-MM`
(chống SQL-injection), project ref từ env/config, **DATASET GUARD** (>1000 dòng
mới chứng minh, không thì exit 3 INCONCLUSIVE — không báo xanh giả).

**Chứng minh >1000 dòng:** seed 1100 phiếu THU (2099-01) → `A === B === C ===
1.705.550` (C qua 2 trang đầy + 1 trang rỗng ⇒ vượt cap 1000) → cleanup 0 dòng. ✅

---

## P1 — Gate & khả năng rebuild

### TS gate fingerprint (`scripts/check-ts-baseline.mjs` + `ts-baseline.json`)

Thay đếm số lỗi bằng **fingerprint SET** `relPath|TScode|maskedMsg` (bỏ line/col).
FAIL nếu: compiler không chạy (ENOENT/không có summary → exit 2), parser drift
(số fingerprint ≠ "Found N errors" → exit 2), hoặc **tập lỗi MỚI khác baseline**
(exit 1). Baseline: **38 fingerprint** (từ 106 lỗi thô; đợt này còn GIẢM 1).

### Trigger bỏ cọc — khôi phục khả năng replay (migration `20260710160000_recreate_forfeit_settle_trigger.sql`)

Xác nhận: trigger LIVE **đúng** (bản 'CT', enabled), nhưng `CREATE TRIGGER
trg_forfeit_settle_on_approve` **chỉ nằm ở file archive** `20260617000001` (Phase 4
git-mv) → replay CSDL sạch sẽ MẤT trigger (còn function thì có, qua
`20260619000001`). Migration mới tái tạo trigger từ **function LIVE hiện hành
('CT')** — no-op trên live, restore replay. **KHÔNG** un-archive `20260617` (bản
đó dùng 'TM' đã lỗi thời).

### Schema baseline / DR (follow-up — cần credential DB trực tiếp)

Chuỗi migration hiện KHÔNG replay sạch được (bundle hand-apply + archive). Khuyến
nghị (chưa làm — cần `supabase db dump`/`pg_dump`, PAT không đủ):
`supabase/schema/baseline.sql` (pg_dump --schema-only) + CI DR test (boot Postgres
rỗng, apply baseline + migration mới, assert trigger 'CT' + auth trigger + bảng lõi).

---

## P2/P3

- **profiles query key theo scope**: `useProfiles` → hook canonical
  `useAssignablePeople` key `["profiles","assignable"]`; `AssetMaintenanceDialog`
  self-only → `["profiles","self"]` (hết nhiễm chéo cache). Không đổi rows/RLS.
- **`salary_staff_months`**: bỏ `LIMIT 1 ngẫu nhiên` → resolve owner DETERMINISTIC
  (owner nhiều assignment nhất, tie-break `user_id`). Trong migration money RPCs.
- **`formatVND`/`formatCurrency`**: finite-safe (NaN/±Infinity/null/undefined/
  chuỗi → `0`), làm tròn nhất quán (VND không có phần lẻ), hoist `Intl.NumberFormat`
  singleton. +test.

---

## Rollback an toàn (theo audit)

Mọi migration đợt này có `-- ROLLBACK` **KHÔNG khôi phục bản dễ tổn thương**: nếu
luồng hợp lệ hỏng → FORWARD-FIX (cấp quyền phạm-vi-hẹp: assignment full-scope dưới
owner / role Admin dưới owner / quyền org-level), KHÔNG đảo về `is_admin()` toàn
cục hay helper full-scope không-owner. (Cũng sửa comment ROLLBACK của Phase 1
`salary_staff_months` từng khôi phục bản `LIMIT 1` không lọc.)

## Verify chạy lại (thực thi được, không placeholder)

```bash
node scripts/test-cross-tenant.mjs        # ma trận âm bản owner/Admin/full-scope → PASS
node scripts/check-ts-baseline.mjs        # fingerprint set = baseline (38)
npx vitest run --no-file-parallelism      # 699 pass (chạy full-parallel OOM trên máy này)
node scripts/reconcile-money.mjs          # INCONCLUSIVE nếu không kỳ nào >1000 (đúng)
node scripts/check-view-invoker.mjs       # 6/6 security_invoker
npx vite build                            # ✓ built
```
