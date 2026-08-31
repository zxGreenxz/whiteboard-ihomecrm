# HỒ SƠ BÀN GIAO AUDIT — Trang `/thanh-toan` (Đóng tiền Tập trung theo Kỳ)

> **Ngày lập:** 2026-08-31 · **Người lập:** Claude Code (khảo sát trực tiếp trên working tree, mọi `file:line` đã kiểm bằng mắt hoặc `wc -l`/`grep -n` — không suy đoán).
>
> **Dành cho:** một agent AI khác thực hiện audit ĐỘC LẬP. File này đủ tự thân — không cần khảo sát lại từ đầu, nhưng **được phép và nên nghi ngờ mọi nhận định trong đây**: đây là bản đồ, không phải kết luận.

---

## 0. Nhiệm vụ và luật chơi

**Nhiệm vụ:** kiểm tra thật kỹ toàn bộ trang `/thanh-toan` — tìm **lỗi**, **chỗ chưa tối ưu**, **sai logic** — trên cả client (React/TS) lẫn server (RPC Postgres). CHỈ ghi nhận finding kèm bằng chứng và đề xuất; **KHÔNG sửa bất kỳ file code/migration nào**, không commit, không đổi dữ liệu ngoài org DEMO.

**Luật môi trường bắt buộc** (rút từ `CLAUDE.md` + `docs/engineering/PROJECT_CONTRACT.md` — đọc cả hai trước khi làm):

1. E2E chạy **headless**, chỉ ghi vào **org DEMO**. Không mở browser hiện hình trừ khi user yêu cầu tường minh.
2. **Không chạy** `npm run gate:truoc-push` trong lúc audit — lệnh này TỰ `git add` artifact máy, làm bẩn staging của phiên khác (máy này thường có nhiều phiên song song). Audit read-only thì không cần gate nào.
3. Thứ tự tin cậy khi mâu thuẫn: **contract manifest + SQL (baseline/harness) > GitNexus graph > tài liệu docs/he-thong > comment trong code**. Muốn dùng GitNexus phải qua wrapper `npm run graph:*` và phải chạy `npm run gate:graph-freshness -- --nhiem-vu domain-review` trước; nếu bỏ qua graph cũng không sao — grep trực tiếp là đủ cho phạm vi này.
4. **Nguồn sự thật cho định nghĩa RPC hiện hành là `supabase/baseline/schema.sql`**, KHÔNG phải migration. Migration là lịch sử; một hàm bị CREATE OR REPLACE nhiều lần thì bản trong migration mới nhất mới là bản chạy — và baseline là ảnh chụp đã tổng hợp. Đối chiếu thêm `contracts/surfaces/rpc-surface.json`.
5. Không đụng vùng OpenClaw (đã xoá/đóng băng). Không sửa `.ua/`.
6. Máy Windows 11, shell PowerShell 5.1 (không có `&&`) — dùng Git Bash cho lệnh POSIX.

**Khuôn kết quả bắt buộc** — ghi vào `docs/audits/AUDIT-THANH-TOAN-<YYYY-MM-DD>.md`, theo đúng khuôn của `docs/audits/AUDIT-TIEN-HOA-DON-THU-CHI-THANH-TOAN-2026-08-13.md`:

- Mở đầu bằng **kết luận điều hành** (verdict tổng, đếm finding theo mức).
- Mỗi finding: mã số (`P1-01`…), **mức** (P0 = sai tiền/ghi trùng/lộ quyền đang xảy ra; P1 = logic sai có kịch bản tái hiện; P2 = chưa tối ưu/hiệu năng/UX sai; P3 = nợ kỹ thuật/dọn dẹp), **trạng thái** (hiện hữu / latent / legacy-hợp-lệ-nhưng-rủi-ro / DEMO-hygiene), `file:line`, kịch bản input→hành-vi-sai, tác động nghiệp vụ, khuyến nghị, effort ước lượng.
- Bắt buộc có mục **"Đã kiểm và SẠCH"** (liệt kê thứ đã soi mà không thấy vấn đề — để lần audit sau khỏi soi lại) và mục **"Khoảng trống xác minh"** (thứ không kiểm được và vì sao).
- Kiểm chứng động phải **dán output thật** (unit/e2e), không tuyên bố suông.

---

## 1. Trang này là gì

`/thanh-toan` = **"Đóng tiền Tập trung theo Kỳ"** — bề mặt **CHI tiền cho nhà cung cấp** theo (hạng mục phí × tòa nhà × kỳ tháng). **Khác hẳn** `/thu-tien` (THU tiền của khách theo phòng) dù dùng chung CSS và một phần component. Đừng lẫn hai luồng khi đọc tài liệu.

Cấu trúc màn hình (xem comment đầu `src/pages/ThanhToan.tsx:1-31` — comment này rất đáng đọc nguyên văn):

- `≥1024px`: grid 2 cột — `PeriodFeePanel` (desktop, `.tt-udesk`) bên trái + "khung điện thoại" chứa `PeriodFeeSheet` bên phải.
- `<1024px`: panel bị **CSS ẩn** (vẫn trong DOM), chỉ còn sheet.
- **HAI BỀ MẶT CÙNG MOUNT LÀ CHỦ Ý** có spec e2e bảo vệ (`.e2e-fleet/specs/thanh-toan-page.spec.ts:27/:32/:143`). Finding kiểu "unmount một bề mặt theo breakpoint" là **finding SAI** — đừng đề xuất.

Ba nhóm nghiệp vụ trên trang:

1. **9 hạng mục phí cố định** (lưới tòa × hạng mục): `tien_nha, dien, nuoc, internet, quan_ly, ve_sinh, cong_an, rac, thang_may` — xem `GRID_SERVER_KEYS` tại `src/lib/feeCategories.ts:155`.
2. **Hoa hồng / Bảo trì / Thanh lý & Cọc** (`FEE_GROUPS` `src/lib/feeCategories.ts:149`, `LEDGER_FAMILIES` `:146`): modal hoa hồng theo kỳ, batch bảo trì, 3 sổ theo dõi (`SettlementPanels`).
3. **Điện & Nước** (tab riêng trong panel): `UtilityEnContent` + `useUtilityBills` — đường RPC khác (`pay_utility_bill`).
4. **Sinh phiếu hàng loạt** phí đặc biệt: `SpecialFeeBatchDialog` → engine `*_special_fees_v1`.

Route gate: `src/app/routes/financeWorkRoutes.tsx:39` — `RequirePermission module="thu_tien" action="collect"`. Lưu ý `collect` KHÔNG kéo theo `view` (comment `ThanhToan.tsx:57-60`).

---

## 2. Bản đồ mã nguồn (số dòng đo bằng `wc -l` ngày 31/08)

### 2.1. Page + components (`src/components/thu-tien/`)

| File | Dòng | Vai trò | Ghi chú |
|---|---|---|---|
| `src/pages/ThanhToan.tsx` | 118 | Shell page | Comment đầu file là tài liệu rủi ro quan trọng nhất |
| `PeriodFeePanel.tsx` | **883** | Panel desktop — lưới phí, tab Điện-Nước, chọn kỳ | File lớn nhất vùng |
| `PeriodFeeSheet.tsx` | **661** | Sheet mobile trong khung điện thoại | Song trùng logic lớn với Panel |
| `UtilityEnContent.tsx` | 420 | Bảng Điện & Nước (trong Panel) | |
| `SettlementPanels.tsx` | 220 | 3 sổ: chi thanh lý / thưởng Sale / cọc đã thu | Consumer duy nhất của `useThanhToanLedgers` |
| `SpecialFeeBatchDialog.tsx` | 217 | Dialog sinh phiếu hàng loạt | Mount ở page, dùng chung 2 bề mặt |
| `PeriodFeeVoucherList.tsx` | 216 | Danh sách phiếu + modal PayDraft + modal DupConfirm | |
| `UtilityBookMenu.tsx` | 183 | Menu chọn sổ quỹ | Có spec e2e riêng |
| `PeriodCommissionModal.tsx` | 180 | Modal trả hoa hồng | |
| `PeriodFeeEditModal.tsx` | 173 | Modal sửa phiếu | |
| `UtilityChart.tsx` | 174 | Biểu đồ tiêu thụ | |
| `UtilityCancelModal.tsx` | 72 | Modal huỷ phiếu (dùng chung với Điện-Nước) | |
| `UtilityReceiptThumb.tsx` / `feeIcons.tsx` / `utilityIcons.tsx` | 38/39/29 | Phụ trợ | |
| **`UtilityDesktopPanel.tsx`** | **436** | **DEAD CODE** — không ai import | Xác nhận lại rồi ghi P3 |
| **`UtilityBillSheet.tsx`** | **322** | **DEAD CODE** — không ai import | Cùng trên |

Các file khác trong cùng thư mục (`ManagePanel` 372, `HandoverSheet` 546, `RoomCell*`, `StatusFilter`, `TimeFilter`, `InvoiceDetailCard`, `NoteEditor`) **thuộc `/thu-tien`**, ngoài phạm vi — chỉ soi nếu finding lan sang.

Ngoài thư mục: `src/components/contracts/TerminationRefundDialog.tsx` (177, mở từ SettlementPanels), `src/components/income-expenses/BankSelect.tsx` (51), `src/components/ui/attachment-lightbox.tsx` (147).

CSS: `src/pages/thu-tien.css` (1349 dòng) — **import bởi CẢ `/thu-tien` lẫn `/thanh-toan`**; mọi nhận xét CSS phải kiểm tác động chéo 2 trang.

### 2.2. Hooks

| File | Dòng | Vai trò |
|---|---|---|
| `src/hooks/usePeriodFeeState.ts` | **652** | **Trái tim trang.** Kho state module-level dùng chung 2 bề mặt, khoá `${categoryKey}|${period}`; chốt in-flight `inflightPays` (Set đồng bộ); cờ `justPaid` che khe refetch; toàn bộ hành động pay/cancel/edit/draft/attach. **KHÔNG có unit test.** |
| `src/hooks/usePeriodFees.ts` | 565 | Query + mutation cho 9 RPC phí kỳ (bảng RPC ở §2.3) |
| `src/hooks/useUtilityBills.ts` | 545 | Data layer Điện & Nước |
| `src/hooks/useUtilityPayState.ts` | 355 | Chốt in-flight cấp module cho Điện & Nước (đối xứng với usePeriodFeeState) |
| `src/hooks/useThanhToanLedgers.ts` | 251 | 3 sổ theo dõi — đọc **thẳng bảng qua RLS** (chủ ý — xem comment trong file; đừng báo "thiếu SECURITY DEFINER" như một lỗi) |
| `src/hooks/useCommissionVoucher.ts` | 281 | Tạo phiếu hoa hồng |
| `src/hooks/useFeeConfigMatrix.ts` | 143 | Ma trận cấu hình phí (dùng chung với FixedFeesPage) |
| `src/hooks/useMaintenanceBatch.ts` | 123 | Batch bảo trì |
| `src/hooks/useSpecialFeePrices.ts` | 109 | Bảng giá phí đặc biệt |
| `src/hooks/useReceiptPasteTarget.ts` | 109 | Trọng tài Ctrl+V ảnh giữa 2 bề mặt (có spec hồi quy riêng — đừng đề xuất đổi kiến trúc) |
| `src/hooks/useSpecialFeeBatch.ts` | 106 | Preview + generate phí đặc biệt |
| `src/hooks/usePersistedState.ts` | 79 | Key kỳ `flt:thu-tien:month` **chia sẻ với `/thu-tien`** |

### 2.3. RPC gọi từ client (đã kiểm từng dòng)

Trong `src/hooks/usePeriodFees.ts`:

| RPC | Dòng gọi | Mutation/Query |
|---|---|---|
| `get_period_fee_status` | :212 | reader chính của lưới |
| `pay_period_fee` | :268 | ghi phiếu chi phí cố định |
| `pay_draft_fee_voucher` | :296 | thanh toán phiếu nháp (recurring) |
| `cancel_period_fee` | :313 | huỷ phiếu |
| `append_fee_attachment` | :325 | đính ảnh server-side |
| `update_period_fee` | :351 | sửa phiếu |
| `upsert_building_fee_account` | :444 | lưu cấu hình mã KH/chủ TK/số dự kiến |
| `get_period_commissions` | :473 | hoa hồng theo kỳ |
| `get_period_maintenance` | :509 | bảo trì theo kỳ |

Nơi khác: `useSpecialFeeBatch.ts` → `preview_special_fees_v1` (:34), `generate_special_fees_v1` (:80); `useSpecialFeePrices.ts` → `get_special_fee_prices_v1` (:42), `set_special_fee_price_v1` (:93); `useFeeConfigMatrix.ts` → `get_fee_config_matrix_v1` (:49), `upsert_building_fee_account` (:119 — **đường ghi thứ hai** vào cùng bảng); `useUtilityBills.ts` → `save_utility_account` (:197,:216), `delete_utility_account` (:236), `pay_utility_bill` (:259), `cancel_utility_bill` (:289), `get_invoice_statistics_v2` (:519).

Bảng đọc trực tiếp (PostgREST): `contract_terminations` (`useThanhToanLedgers.ts:56`), `income_expenses` (`:80/:143/:198`), join `income_expense_items!inner` lọc `accounting_class='DEPOSIT'` (`:205-208`), `building_fee_accounts` (`usePeriodFees.ts:382`), `buildings` (`:386`), `income_expense_types` + `building_utility_accounts` (`useUtilityBills.ts:149/:165`).

### 2.4. Server-side: migration theo dòng thời gian (bản SAU đè bản TRƯỚC)

Đường `pay_period_fee` — **4 đời**, khi audit phải đọc bản CUỐI + baseline:

1. `20260708130200_pay_period_fee.sql` — v1.
2. `20260710120100_pay_update_cancel_v2.sql` (375 dòng) — v2: thêm `p_force`, đổi chữ ký (DROP trước — đúng án lệ "thêm tham số RPC phải DROP rồi CREATE"); `p_force=false` gặp trùng → RETURN `{warning:'duplicate', existing_amount, existing_count}` KHÔNG insert; FE xác nhận rồi gọi lại `p_force=true`. Cancel v2: điều kiện `system_source IN ('utility.bill','fixed_fee')`, giữ permission gate + FOR UPDATE (:239, :327).
3. `20260731011000_slice_minus1_guards.sql:516` — v3 (quan trọng nhất): thêm `pg_advisory_xact_lock` theo org+slot (:597), trả `can_force` trong payload warning (:607-614) tính bằng `is_super_admin() OR app_private.is_org_owner_v1(org, uid)`. **TODO còn treo ghi ngay trong file (:500-515):** "chủ tổ chức" có HAI định nghĩa song song (khớp chuỗi tên vai trò vs `member_type='OWNER'`), lệch nhau 2/3 người ở org DEMO — đối chiếu memory án lệ "Vai Chủ công ty không lọt is_org_owner_v1 (system_key NULL)". **Đây là điểm audit trọng yếu: chủ công ty THẬT có bấm được "Đóng thêm" không?**
4. `20260731070000_current_date_to_org_today.sql:3034` — v4 hiện hành: thay `CURRENT_DATE` bằng `org_today` (múi giờ theo org).

Migration liên quan khác (đọc khi soi trục tương ứng):

- `20260708130000_building_fee_accounts.sql` — bảng cấu hình; `20260710120600_unify_not_applicable.sql`; `20260731020000_fee_config_clearable.sql`.
- `20260708130300_get_period_fee_status.sql` → `20260710120000_period_fee_status_v2.sql` (reader trả vouchers payload).
- `20260710120300_recurring_draft_mode.sql` — phiếu nháp recurring + `pay_draft_fee_voucher`.
- `20260710120500_append_fee_attachment.sql`.
- `20260708130400` / `20260710120200_get_period_commissions_v2.sql`; `20260708130500_get_period_maintenance.sql`.
- `20260731030000_voucher_slot_warning.sql` (189 dòng) — `get_voucher_slot_warning_v1`: cảnh báo MỀM cho form tạo phiếu chung bên Thu chi. Comment đầu file là bản đính chính đầy đủ vụ PC2606046/47 (đọc kỹ trước khi kết luận gì về "ghi trùng").
- `20260731080000_special_fee_engine.sql`, `20260801010000_special_fee_price_and_autopost.sql`, `20260801011000_special_fee_wire_autopost.sql`, `20260801012000_special_fee_dup_and_overload_fix.sql`.
- `20260801030000_commission_tiers_and_autopay.sql` + `20260801110000_fix_commission_autopay_varname.sql`.
- `20260801060000_rpc_respect_org_isolation.sql` — cô lập org cho loạt RPC.
- `20260826170000_thanh_toan_nguoi_co_quyen_duyet_di_thang.sql` (330 dòng) — người có quyền duyệt thì phiếu đi thẳng (bỏ bước chờ duyệt). **Soi kỹ: có đường nào cho người KHÔNG có quyền duyệt lọt qua không, và maker-checker còn giữ không.**
- `20260828130000_realtime_building_fee_tables.sql` — publication cho 2 bảng cấu hình phí.
- Điện & Nước: `20260708100000_pay_utility_bill_account_attachments.sql`, `20260708100001_cancel_utility_bill.sql`, `20260708110000_utility_multi_meter.sql`, `20260801040000_utility_ceiling_and_maintenance_rules.sql`, `20260828150000_utility_ceiling_wired_into_pay_bill.sql` (309 dòng — trần tiền điện/nước nối vào pay_bill).

### 2.5. Realtime & query keys

- `src/hooks/realtime/finance.ts` — invalidate `['period-fee-status']` (:71), `['fee-accounts']` (:74,:135), `['utility-payments']` (:41), `['utility-accounts']` (:42); map bảng `building_fee_accounts` (:133), `building_utility_accounts` (:141). Comment :67 ghi "bốn khoá của /thanh-toan đọc phiếu theo kỳ" — kiểm danh sách invalidate có ĐỦ 4 khoá không (`tt-termination-queue`, `tt-sale-bonus`, `tt-deposit-ledger` của `useThanhToanLedgers` + `period-fee-status`).
- `src/lib/realtime/syncTables.ts:39-42` — hai bảng cấu hình phí trong publication.
- Đối chiếu `src/hooks/__tests__/useRealtimeDataSync.test.ts` (619 dòng, đã có case cho 2 bảng này).

### 2.6. Bán kính ảnh hưởng (đụng đâu phải kiểm đó)

- `src/pages/settings/finance/FixedFeesPage.tsx` (456) — route `/settings/finance/fixed-fees`, **cùng gate `thu_tien.collect`**, dùng chung `feeCategories.ts` + `useFeeConfigMatrix` + RPC `upsert_building_fee_account`.
- `/thu-tien` (`src/pages/ThuTien.tsx` 436) — chung CSS, chung key kỳ `flt:thu-tien:month`, nút Plug navigate sang đây.
- `src/lib/collect.ts` (232) — dùng bởi cả `/thu-tien`; chỉ audit hàm mà `/thanh-toan` thật sự gọi (`fmtFull`…).
- `TerminationRefundDialog` — luồng thanh lý (`docs/he-thong/16`), có spec `termination-refund*.spec.ts`.

---

## 3. Tài liệu đối chiếu (đọc TRƯỚC khi phán logic)

| Tài liệu | Dùng để |
|---|---|
| `docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md` §2.6 (dòng ~143-152) + mục 8 (~:422) | **Đặc tả chính** của trang: 9 hạng mục, phiếu nháp, nhiều voucher/ô, sửa/huỷ/đính ảnh per-voucher |
| `docs/he-thong/08-thu-chi-so-quy.md` | Phiếu chi, duyệt, posting — phiếu của trang này là `income_expenses` type EXPENSE |
| `docs/he-thong/20-phe-duyet-tai-chinh.md` | Luật duyệt; đối chiếu với migration `20260826170000` (duyệt-đi-thẳng) |
| `docs/he-thong/16` + `17` | Nguồn của 3 sổ trong `SettlementPanels` |
| `docs/he-thong/07-hoa-don-thanh-toan.md` | Luồng THU của khách — chỉ để phân biệt, đừng áp luật của nó sang đây |
| `docs/audits/AUDIT-TIEN-HOA-DON-THU-CHI-THANH-TOAN-2026-08-13.md` (605 dòng) | Khuôn báo cáo + 23 finding đã biết (chủ yếu vùng hoá đơn/báo cáo — nếu finding của bạn trùng, ghi "đã biết từ 13/08" thay vì báo mới) |
| `docs/audits/AUDIT-PLAN2-ROOM-LIFECYCLE-REFUND-2026-08-27.md` | Vá F8 phân trang đã ghi ở `useThanhToanLedgers.ts:49` |
| `contracts/surfaces/rpc-surface.json` | Chữ ký RPC hiện hành |

---

## 4. Manh mối rủi ro đã biết — điểm khởi đầu, KÈM ĐÍNH CHÍNH

Những điều dưới đây là **đầu mối**, không phải kết luận. Vài cái đã có đính chính chính thức — trích lại để agent không tái phát hiện nhầm:

1. **Vụ phiếu trùng PC2606046/47 (66.000.000đ ×2, cách 460ms)** — ĐÃ ĐÍNH CHÍNH (đo prod 30/07, ghi tại `ThanhToan.tsx:24-30`, `usePeriodFeeState.ts:26-32`, và đầy đủ nhất ở `20260731030000_voucher_slot_warning.sql:1-42`): cặp đó do **POST thẳng REST** (nay đã REVOKE bởi `20260730102000_money_tables_revoke_dml.sql`) chứ KHÔNG do `pay_period_fee`. 23 slot trùng trên prod = 20 NULL + 3 'utility.bill', **0 'fixed_fee'**. Phần còn hở THẬT là lỗi PHỐI HỢP (hai người trả cùng tháng cách nhau nhiều ngày) — thuốc là cảnh báo mềm `get_voucher_slot_warning_v1`, cố ý KHÔNG chặn cứng (20/24 ô trùng có số tiền khác nhau và hợp lệ). → Việc của bạn: kiểm xem các lớp chống trùng HIỆN TẠI (client 3 lớp + server advisory lock + duplicate warning) có lỗ nào còn lại không, chứ không phải chứng minh lại vụ cũ.
2. **Ba lớp chống trùng client** trong `usePeriodFeeState.ts`: (a) kho slot dùng chung 2 bề mặt (`slotStore`, khoá `${key}|${period}`); (b) chốt đồng bộ `inflightPays` (`:164-165`, `:426-432` — Set module, không qua React state); (c) cờ `justPaid` che khe refetch (`:414-420`), tự tan khi reader thấy `paidAmount>0 || draftAmount>0`. Điểm tinh vi đã biết: `releaseSlot` **cố ý không dọn** `inflightPays` (`:188-196`); `confirmCancel` phải dọn cờ `justPaid` đúng tòa (`:555-580` — đã có; kiểm tính đúng khi huỷ từ bề mặt này trong lúc bề mặt kia đang gõ).
3. **`can_force` server-first**: `doPay` dùng `res.can_force ?? canForce` (`usePeriodFeeState.ts:459` — `??` chứ không `||`, chủ ý ghi rõ comment `:453-458`); `confirmPayDup` dùng lại câu trả lời server đã mở dialog (`:498-511`). Kiểm: (a) UI cờ `canForce` truyền từ đâu xuống (Panel/Sheet lấy `useIsOrgOwner`/`useIsSuperAdmin`?), có lệch với server không; (b) án lệ memory: **vai "Chủ công ty" system_key NULL không lọt `is_org_owner_v1`** — chủ thật có thể bị chặn "Đóng thêm" oan. Đối chiếu TODO trong `slice_minus1_guards.sql:500-515`.
4. **Resolver sổ dựa TÊN**: `thuBookId` chọn sổ có tên kết thúc `'Thu'` (`usePeriodFeeState.ts:276-281`) — trang CHI tiền mà sổ mặc định rơi về sổ "…Thu"; doc 07 §10 cũng ghi resolver tên là điểm giám sát. Kiểm hành vi khi user không có sổ nào tên "…Thu", nhiều sổ cùng tên, sổ của user khác.
5. **`currentMonth()` dùng `new Date()` giờ máy** (`ThanhToan.tsx:45-48`) trong khi server đã chuyển `org_today` (migration `20260731070000`) — lệch múi giờ quanh giao thừa tháng có thể mở sẵn kỳ sai. Có án lệ test riêng `src/lib/__tests__/ngayLocalKhongUTC.test.ts` — đọc để biết chuẩn dự án rồi mới phán.
6. **Dead code**: `UtilityDesktopPanel.tsx` (436) + `UtilityBillSheet.tsx` (322) — grep toàn `src/` không còn import (chỉ còn trong comment `UtilityEnContent.tsx:4` và doc 15:151). Xác nhận lại bằng grep của chính bạn trước khi ghi P3.
7. **Song trùng Panel/Sheet** (~1.544 dòng cùng gọi `usePeriodFeeState` và render logic gần giống): rủi ro sửa-một-quên-một. Đề xuất hợp lý là tách phần chung, nhưng PHẢI tôn trọng ràng buộc "hai bề mặt cùng mount, modal local từng bề mặt là CHỦ Ý" (`usePeriodFeeState.ts:43-44`).
8. **`upsert_building_fee_account` có 2 đường ghi** (usePeriodFees:444 và useFeeConfigMatrix:119) từ 2 trang cùng gate — kiểm khả năng ghi đè chéo (last-write-wins có mất trường không, ví dụ trang này gửi `defaultAmount` còn trang kia gửi `notApplicable`).
9. **Test gap đã đo**: `usePeriodFeeState.ts` 652 dòng — 0 unit test; Panel/Sheet — 0 test render. E2E chỉ phủ layout/điều hướng/đổi kỳ (`thanh-toan-page.spec.ts` 144 dòng), KHÔNG phủ luồng đóng tiền thật.
10. Án lệ hệ thống cần soi lại trên các RPC MỚI của vùng này: (a) **REVOKE PUBLIC không cắt anon** — từng RPC phải REVOKE riêng `anon`; (b) **CREATE OR REPLACE đẻ overload** khi đổi chữ ký — kiểm `rpc-surface.json` xem có overload thừa của `pay_period_fee`/`update_period_fee` không; (c) **PostgREST cap 1000 dòng** — chỗ nào `.select()` bảng lớn không qua `fetchAllRows` (`src/lib/supabaseFetchAll.ts`, fail-closed) — `useThanhToanLedgers` đã vá F8 (:49) nhưng kiểm các query khác (`useUtilityBills.ts:320/:493`, `usePeriodFees.ts:382-386`).

---

## 5. Checklist audit theo 5 trục

> **Audit bổ sung Codex — 31/08/2026:** `[x]` = đã đối chiếu code/SQL/runtime hoặc đã chạy kiểm chứng; `[ ]` = chưa đủ bằng chứng động. `⚠` là finding, `SẠCH` là chưa thấy lỗi trong phạm vi đã kiểm. Kết quả chính: **2 P1** (quyền “Đóng thêm”; voucher Điện-Nước mixed), **5 P2** (realtime, pagination, timezone, CAS/edit) và **3 P3** (dead code, song trùng, test gap). `pay_draft_fee_voucher` là finding boundary **đã biết từ audit 13/08**, được tái xác nhận nhưng không đếm lại.

### Trục A — Logic nghiệp vụ & tiền (client)

- [x] `addMonths`/`rangeLabel` (`usePeriodFeeState.ts:72-81`): **SẠCH** — kỳ `2026-11 + 3 = 2027-02`; focused timezone/date test xanh.
- [x] Đa kỳ = **TỔNG cả khoảng** (chốt V2, `:9`): **SẠCH** — UI không nhân lại; `pay_period_fee` lưu `p_amount` là tổng và item trải `start_date/end_date`.
- [x] `setN` kẹp 1–36 (`:311`): 🟡 **ghi chú, chưa nâng finding** — client kẹp 36 nhưng server chỉ kiểm format/thứ tự, không kẹp khoảng tối đa; caller RPC trực tiếp có thể ghi kỳ rất dài.
- [x] Seed modal Sửa: **SẠCH** — seed bằng `voucherTotal`; `PeriodFeeEditModal` khóa amount/kỳ khi `itemCount > 1`, server cũng chặn.
- [x] `submitPay` và input tiền: **SẠCH trong UI** — parser bỏ ký tự không phải số nên không sinh âm/NaN; client và server đều chặn `<= 0`. Chưa có business ceiling chung cho phí cố định.
- [x] Huỷ phiếu auto: **SẠCH** — cảnh báo recurring có thể sinh lại khớp dedup parent/ngày/phiếu còn sống.
- [x] Luồng nháp `openPayDraft`/`submitPayDraft`: **SẠCH về ảnh** — server dùng `COALESCE(p_attachments, attachments)`, `null` giữ ảnh cũ; preference sổ chỉ ghi sau mutation thành công.
- [x] `update_period_fee` với `attachments=null`: **SẠCH** — server chỉ UPDATE khi tham số khác null, không xóa ảnh cũ.
- [x] Format tiền: **SẠCH về giá trị** — có cả `fmtFull` và `toLocaleString('vi-VN')` nhưng không thấy khác số; chỉ khác cách ghép nhãn.
- [x] `SpecialFeeBatchDialog` + `useSpecialFeeBatch`: **SẠCH** — claim/idempotency và autopost đã được đối chiếu; không thấy đường sinh trùng mới trong scope.
- [x] Reader Điện-Nước đa hạng mục: ⚠ **P1 hiện hữu** — `useUtilityBills.ts:341/:354/:509-511` gán cả voucher thành điện và cộng `total_amount` cho từng item. Runtime có voucher `5916661a-66c2-4a7c-88f1-b90e27d62564`, tổng `6.384.000đ` = điện `5.758.000đ` + nước `626.000đ`, nên list/chart đang sai semantics.

### Trục B — Race condition & state 2 bề mặt (client)

- [x] `useSyncExternalStore` + `writeSlot`: **SẠCH** — writes đi qua `patch`/object mới; không thấy mutate trực tiếp slot.
- [x] `retainSlot`/`releaseSlot` (`:184-196`): **SẠCH theo static review** — refcount chỉ xóa scope khi consumer cuối rời; StrictMode setup/cleanup cân bằng.
- [x] `inflightPays` khoá `${scope}::${bId}`: **SẠCH** — scope chứa hạng mục+kỳ; `releaseSlot` cố ý không dọn khóa trước khi RPC `finally` chạy.
- [x] `justPaidOf`: **SẠCH trong flow nội bộ** — tan khi reader thấy APPROVED/UNAPPROVED; cancel nội bộ dọn cờ. Chưa có test hai-client huỷ đúng khe refetch.
- [x] `confirmCancel`: **SẠCH** — `cancelBId` được seed từ đúng dòng/voucher và chỉ dọn `justPaid` của tòa đó.
- [x] Hai bề mặt sửa cùng phiếu: ⚠ **P2 latent** — `update_period_fee` không nhận expected version/hash; hai modal lưu lần lượt là last-write-wins, không cảnh báo stale write.
- [x] `useUtilityPayState`: **SẠCH** — có khóa module-level, `justPaid`, và dọn cờ khi hủy; không thấy thiếu cơ chế đối xứng quan trọng.
- [x] `useReceiptPasteTarget`: **đã static-review và đã gọi spec**, nhưng E2E dừng trước assertion vì thiếu `FLEET_PASS_CHUNHA`; chưa có bằng chứng browser để kết luận tuyệt đối.
- [ ] `uploadingKey` local giữa hai bề mặt: chưa có E2E hai upload đồng thời; static review cho thấy spinner không đồng bộ, nhưng chưa nâng thành finding nếu chưa tái hiện overwrite.

### Trục C — Server RPC SQL (đọc baseline + migration mới nhất)

- [x] `pay_period_fee` v4: **SẠCH** — advisory lock theo org+building+category+tháng bắt đầu; transaction path bounded, không serialize cả bảng.
- [x] Duplicate check: **SẠCH** — không lọc `system_source`, nên phiếu tay/utility có item khớp và kỳ chồng lấn đều đi vào warning; không tái kết luận nhầm vụ PC2606046/47.
- [x] `can_force`: ⚠ **P1 hiện hữu** — runtime vai `Chủ công ty`, `system_key=NULL`, `member_type=OWNER`: `is_org_owner_v1=false` nhưng helper nhận company owner=true; server và UI đều từ chối chủ thật “Đóng thêm”.
- [x] ACL RPC: **SẠCH** — các RPC chính có authenticated và chặn anon; không thấy anon EXECUTE/overload bất ngờ trong surface đã kiểm.
- [x] Overload: **SẠCH** — một chữ ký runtime cho `pay_period_fee`, `update_period_fee`, `cancel_period_fee`, `pay_draft_fee_voucher`.
- [x] `20260826170000` duyệt-đi-thẳng: **SẠCH trong policy hiện hành** — maker/threshold/autopost là ngoại lệ có chủ ý và có audit/posting; không thấy đường bypass mới.
- [x] `pay_draft_fee_voucher`: ⚠ **finding đã biết, tái xác nhận** — đọc trạng thái trước tenant gate tạo status oracle xuyên org; UPDATE theo id không scope, hiện rollback khi `approve_voucher` từ chối. Posting đúng sổ chỉ xảy ra khi approve thành công.
- [x] `cancel_period_fee`: **không thấy drift runtime** — hàm set `deleted_at`, trigger Finance V2 đảo posting; probe: deleted còn active posting `0`, posted thiếu active posting `0`. Governance vẫn legacy.
- [x] `update_period_fee`: ⚠ **P2 latent** — không có expected version/posted guard rõ; trigger hiện giữ parity (`amount drift=0`, `item sum drift=0`) nên không nâng thành lỗi tiền hiện hữu.
- [x] Special fee engine: **SẠCH** — idempotency/claim, approval và autopost đã được đối chiếu.
- [x] Commission autopay: **SẠCH** — bản vá varname đã hiện hành; không thấy lỗi sinh đôi trong caller của trang.
- [x] Utility ceiling: **SẠCH** — check được enforce trong `pay_utility_bill`; vượt trần không chỉ cảnh báo.
- [x] Org isolation: **SẠCH** cho reader period đã kiểm — lọc building visibility/scope; ba ledger đọc qua RLS.
- [x] `org_today`: **SẠCH ở server**, nhưng ⚠ client `ThanhToan.currentMonth()` vẫn dùng timezone máy (`new Date()`), tạo **P2 latent** quanh giao tháng.

### Trục D — Hiệu năng & realtime

- [x] `get_period_fee_status`: **SẠCH** — một batch theo buildingIds/category/kỳ; hai bề mặt dùng cùng React Query key nên dedup.
- [x] `useThanhToanLedgers`: ⚠ **P2 latent** — termination queue đã `fetchAllRows`; Sale (`:143`) và Cọc (`:198`) chưa phân trang. Runtime khoảng 17/469 dòng, chưa chạm cap.
- [x] `useUtilityBills.ts:320/:493`: ⚠ **P2 latent** — filter kỳ/deleted/status có, nhưng list/chart chưa phân trang; runtime khoảng 108 dòng, chưa chạm cap 1.000.
- [x] Invalidation: ⚠ **P2 hiện hữu khi có client khác** — có bốn key period nhưng thiếu `tt-termination-queue`, `tt-sale-bonus`, `tt-deposit-ledger`; ba sổ cũ tới refetch/F5.
- [x] Re-render: **đã static-review** — mỗi patch slot notify cả hai subscriber, nên hai component lớn cùng re-render; chưa có browser profiler để lượng hóa, ghi nhận cùng P3 song trùng thay vì mở finding hiệu năng riêng.
- [x] `usePersistedState('flt:thu-tien:month')`: **không thấy lỗi refetch riêng**; vấn đề là giá trị khởi tạo theo timezone máy, đã ghi ở Trục C.

### Trục E — Chất lượng mã, test gap, UX & quyền

- [x] Dead code 758 dòng: ⚠ **P3** — `UtilityDesktopPanel.tsx` (436) + `UtilityBillSheet.tsx` (322) không có import sống trong `src`.
- [x] Song trùng Panel/Sheet: ⚠ **P3** — lặp closing form, voucher list, book menu và modal wiring; nên tách block render chung nhưng **giữ cả hai bề mặt cùng mount và modal local**.
- [x] Test gap: ⚠ **P3** — `usePeriodFeeState.ts` không có unit trực tiếp; cần case slot/StrictMode/inflight/justPaid/cancel/two-modal và render hai bề mặt.
- [x] Quyền rút giữa chừng: **an toàn server-side** — RPC recheck; UX vẫn có thể hiện raw `42501` nếu permission đổi giữa phiên.
- [x] Input file dùng chung 4 mode: **static path đúng last-target-wins**; chưa có E2E cho tình huống dialog file + đổi mode đồng thời.
- [x] `validateReceiptFile`/upload: **có chặn image + 5MB**; upload thành công nhưng RPC sau đó fail có thể để ảnh mồ côi, ghi nhận deferred storage hygiene.
- [ ] Nút Copilot đè góc dưới phải: chưa xác minh vì không có screenshot/browser; E2E dừng ở auth credential.
- [ ] A11y cơ bản: static review thấy nhiều icon có title/label nhưng chưa kiểm focus trap/browser hỗ trợ `input type="month"`; chưa đủ bằng chứng để đánh dấu sạch.
- [x] Toast lỗi: 🟡 **ghi chú UX, chưa nâng finding** — nhiều đường đưa thẳng `(ex as Error).message`; phần lớn RPC có tiếng Việt, nhưng lỗi PostgREST/permission nội bộ vẫn có thể lộ thô.

### Verification của audit bổ sung

- Focused unit: `4` file, `84` test **PASS**.
- `npm run typecheck:baseline`: **FAIL 9 lỗi**, đều ở vùng Copilot ngoài phạm vi (`src/copilot/featureFlags.ts`, `src/copilot/tools/nghiepVuTools.ts`, `src/copilot/tools/registry.ts`).
- E2E headless DEMO: `16` test được gọi nhưng đều dừng trước assertion vì thiếu `FLEET_PASS_CHUNHA` tại `.e2e-fleet/specs/auth.ts:39`; không coi đây là lỗi assertion của trang.
- Runtime SQL: read-only; không gọi RPC ghi, không sửa dữ liệu. Consistency snapshot: deleted voucher còn active posting `0`, posted thiếu active posting `0`, amount drift `0`, item-sum drift `0`.

---

## 6. Lệnh kiểm chứng động (copy-paste, Git Bash)

```bash
cd "c:/Users/Nguyen Tam/whiteboard-ihomecrm-main"

# Unit test hiện có của vùng (nhanh, không cần mạng)
npx vitest run src/lib/feeCategories.test.ts "src/lib/__tests__/collect.test.ts" "src/hooks/__tests__/useRealtimeDataSync.test.ts" "src/lib/__tests__/ngayLocalKhongUTC.test.ts"

# Typecheck theo baseline (KHÔNG --write; ts-baseline.json thuộc về CI/Linux)
npm run typecheck:baseline
```

E2E (headless, ghi vào org DEMO trên https://ptcrm.vercel.app — baseURL mặc định của `.e2e-fleet/playwright.config.ts:14`; cần các biến `FLEET_PASS_*` — lấy trong `CLAUDE.local.md` trên máy này, **không chép password vào bất kỳ file/báo cáo nào**):

```bash
cd .e2e-fleet
FLEET_WORKERS=8 npx playwright test specs/thanh-toan-page.spec.ts specs/utility-book-menu.spec.ts specs/utility-paste-receipt.spec.ts
```

Cảnh báo án lệ khi đọc kết quả e2e:
- Spec đỏ chưa chắc app lỗi — có án lệ spec lệch app (`aria-disabled` vs `disabled`); `.e2e-fleet` KHÔNG nằm trong CI gate nên spec có thể đã trôi so với app.
- Org DEMO từng mất fixture giữ sổ (0 binding CUSTODIAN) làm spec posting chết ở bước seed — lỗi seed ≠ lỗi trang.

SQL đối chiếu (READ ONLY qua Management API nếu được cấp; bọc `BEGIN READ ONLY`): tham khảo khuôn ở `scripts/tests/test-matrix-thu-tien.sql`, `test-special-fee-engine.sql`, `test-burst-no-drift.sql`; đối soát tiền: `node scripts/reconcile-money.mjs 2026-08`.

**Không chạy được phần nào → ghi vào "Khoảng trống xác minh", không tuyên bố đã test.**

---

## 7. Định nghĩa "xong"

Audit được coi là hoàn tất khi:

1. Cả 5 trục ở §5 đều có kết luận (finding hoặc "sạch") — không bỏ trống trục nào.
2. Mọi finding P0/P1 có `file:line` + kịch bản tái hiện cụ thể; đã đối chiếu §4 để không báo lại thứ đã có đính chính.
3. Kết quả unit + e2e (hoặc khoảng trống xác minh) được dán nguyên trạng.
4. File kết quả `docs/audits/AUDIT-THANH-TOAN-<ngày>.md` theo đúng khuôn §0, mở đầu bằng kết luận điều hành.
5. Không một file code/migration/dữ liệu nào bị sửa; `git status` sau audit chỉ thêm đúng file báo cáo.
