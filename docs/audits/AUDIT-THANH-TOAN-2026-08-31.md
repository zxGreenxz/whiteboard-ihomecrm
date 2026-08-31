# Audit trang `/thanh-toan` — Đóng tiền Tập trung theo Kỳ (bản hợp nhất đã kiểm định)

**Ngày chốt:** 2026-08-31

**Nguồn:** hai lượt độc lập trên cùng brief `AUDIT-BRIEF-THANH-TOAN-2026-08-31.md`:
1. **Audit gốc** — agent Codex của chủ dự án, ghi kết quả vào checklist §5 của brief (2 P1 · 5 P2 · 3 P3 + 1 mục "đã biết").
2. **Kiểm định độc lập** — Claude Code đọc lại từng finding trên code/baseline thật, **tự tái đo 2 bằng chứng runtime bằng SQL read-only** qua Management API, chạy lại 84 unit test, và bổ sung 3 finding audit gốc bỏ sót.

**Tính chất:** read-only. Không sửa code/migration/dữ liệu. Mọi `file:line` trong tài liệu này đã được kiểm tận mắt.

---

## 1. Kết luận điều hành

**Trang `/thanh-toan` KHÔNG có lỗi làm sai sổ quỹ.** Toàn bộ đường tiền (advisory lock chống trùng, dup-check không phân biệt nguồn phiếu, trigger đồng bộ `total_amount`, posting) đứng vững qua cả hai lượt soi; probe SQL trên production cho **0 drift** (deleted-còn-posting 0, amount drift 0, item-sum drift 0).

Nhưng có **2 lỗi P1 hiện hữu** ở lớp hiển thị và phân quyền:

- **P1-01 — Tab Điện & Nước hiển thị sai phiếu hỗn hợp**: phiếu có cả dòng điện lẫn nước bị gán toàn bộ là "điện" với số tiền cả phiếu; biểu đồ còn **cộng đôi** (cả nhánh điện lẫn nhánh nước đều cộng nguyên `total_amount`). Đã tái đo trên prod: phiếu `5916661a` tổng 6.384.000đ = điện 5.758.000đ + nước 626.000đ, `system_source='utility.bill'` — lớp lỗi có dữ liệu thật chạm vào ngay hôm nay.
- **P1-02 — Chủ công ty thật không bấm được "Đóng thêm"**: vai "Chủ công ty" (org iHome) có `system_key=NULL` nên trượt cả hai vế của `is_org_owner_v1` (neo `TENANT_OWNER`, fallback đúng tên 'Chủ sở hữu tổ chức'). Đã tái đo trên prod: `member_type='OWNER'` nhưng `is_org_owner_v1=false`. Server và UI **nhất quán** từ chối — lỗi nằm ở dữ liệu vai chưa gắn `system_key`, không nằm ở hàm.

Tổng chốt sau kiểm định: **2 P1 · 7 P2 · 4 P3** (audit gốc đếm 2/5/3; kiểm định nâng thêm 2 P2 + 1 P3 vì: finding `pay_draft_fee_voucher` bị audit gốc gán nhầm "đã biết từ audit 13/08" — **audit 13/08 không hề có finding đó**, phải đếm là mới; resolver sổ theo tên `'%Thu'` phía server bị bỏ qua; và một cụm vệ sinh RPC).

**Độ tin cậy audit gốc: TỐT.** 10/11 kết luận đứng vững khi đối chứng code + runtime; 1 kết luận sai nguồn trích dẫn (không sai bản chất kỹ thuật); 2 điểm brief yêu cầu nhưng chưa chấm.

---

## 2. Kiểm định từng kết luận của audit gốc

| Kết luận audit gốc | Verdict kiểm định | Bằng chứng kiểm định |
|---|---|---|
| P1 — reader Điện-Nước gán cả phiếu thành điện, cộng `total_amount` theo item | **XÁC NHẬN, còn nặng hơn mô tả** | `useUtilityBills.ts:341` (`isElec = items.some(...)`), `:352` (`type: isElec ? 'electric' : 'water'`), `:354` (`amount = total_amount`); chart `:504-512` cộng `v.total_amount` cho **TỪNG item** → phiếu hỗn hợp bị cộng đôi cả hai nhánh. **Tự tái đo prod**: phiếu `5916661a-66c2-4a7c-88f1-b90e27d62564` = 6.384.000 (điện 5.758.000 + nước 626.000) ✓ |
| P1 — `can_force` chặn chủ công ty thật | **XÁC NHẬN** | Thân hàm `is_org_owner_v1` (baseline `:15414-15440`): chỉ nhận `system_key='TENANT_OWNER'` hoặc (`system_key IS NULL AND name='Chủ sở hữu tổ chức'`). **Tự tái đo prod**: user `0520169e…` → `member_type=OWNER`, vai "Chủ công ty", `system_key=NULL`, `is_org_owner_v1=false`. UI dùng `is_org_owner_self_v1` (`useIsOrgOwner.ts:38`) — cùng vị ngữ, nhất quán với server (`PeriodFeePanel.tsx:74`, `PeriodFeeSheet.tsx:76`) |
| P2 — realtime thiếu 3 khoá `tt-*` | **XÁC NHẬN, thêm `utility-chart` cũng thiếu** | `realtime/finance.ts:34-75`: map `income_expenses` có 4 khoá period (`period-fee-status/commissions/maintenance`, `fee-accounts`) nhưng **không có** `tt-termination-queue`/`tt-sale-bonus`/`tt-deposit-ledger` (grep toàn `src/hooks/realtime` + `src/lib/realtime` = 0 match) và không có `utility-chart` |
| P2 — Sale bonus & Deposit ledger chưa phân trang | **XÁC NHẬN (latent)** | `useThanhToanLedgers.ts:142-156` và `:197-213` — không `.limit`/không `fetchAllRows`, trong khi termination queue cùng file đã vá F8 (`:49-52`) |
| P2 — utility list/chart chưa phân trang | **XÁC NHẬN (latent)** | `useUtilityBills.ts:319-335`, `:492-502` |
| P2 — `currentMonth()` timezone máy | **XÁC NHẬN (latent)** | `ThanhToan.tsx:45-48` dùng `new Date()` giờ máy; server đã `org_today_v1` (`pay_period_fee` baseline `:82915`) |
| P2 — hai modal sửa cùng phiếu last-write-wins | **XÁC NHẬN (latent)** | `update_period_fee` (baseline `:95578-95664`) không nhận expected version; hai bề mặt giữ modal local (`usePeriodFeeState.ts:43-44`). Header không drift nhờ trigger `trigger_auto_recalc_total_amount` (baseline `:145625`) — đúng như audit gốc ghi nhận |
| "Đã biết từ 13/08" — `pay_draft_fee_voucher` boundary | **SAI NGUỒN — phải đếm là finding MỚI** | `grep -i "draft\|oracle\|nháp" AUDIT-TIEN-HOA-DON-…-2026-08-13.md` = **0 kết quả**. Bản chất kỹ thuật thì ĐÚNG: baseline `:82681-82688` đọc + tiết lộ trạng thái phiếu ("Không tìm thấy"/"đã bị hủy"/"hiện: %") **trước mọi gate org/toà**; UPDATE `:82697` không scope org; may nhờ `approve_voucher` (`:82703`) RAISE → rollback nên không ghi bẩn xuyên org |
| 3 P3 (dead code / song trùng / test gap) | **XÁC NHẬN cả ba** | Tự grep import: `UtilityDesktopPanel.tsx` (436) + `UtilityBillSheet.tsx` (322) không còn ai import; Panel 883 + Sheet 661 song trùng; `usePeriodFeeState.ts` 652 dòng 0 unit test |
| SẠCH: advisory lock, dup-check không lọc `system_source`, seed modal sửa, attachments NULL giữ ảnh, autopost, ACL, overload | **XÁC NHẬN SẠCH** | Đọc trọn thân `pay_period_fee` baseline `:82721-83013`: lock `:82793-82799` theo org×toà×hạng mục×tháng; dup-check `:82817-82831` join theo `fee_type_matches`, **không lọc** `system_source` (đếm cả phiếu tay bên Thu chi); `COALESCE(p_attachments, attachments)` (`pay_draft` `:82699`), `update_period_fee` chỉ UPDATE khi tham số ≠ NULL (`:95630-95632`); modal khoá amount/kỳ khi `itemCount>1` (`PeriodFeeEditModal.tsx:51-59`) khớp server (`:95641-95644`) |
| Unit 84 test PASS | **XÁC NHẬN — tự chạy lại** | `vitest run` 4 file: 84/84 PASS (637ms) |

**Hai mục brief yêu cầu nhưng audit gốc chưa chấm** → kiểm định bổ sung ở §3: resolver sổ `'%Thu'` (brief §4.4) và vệ sinh RPC (comment drift + `v_months`).

---

## 3. Danh mục finding chuẩn hoá (sau kiểm định)

### P1-01 — Tab Điện & Nước: phiếu hỗn hợp điện+nước hiển thị sai loại, sai tiền, biểu đồ cộng đôi

**Trạng thái:** hiện hữu, có dữ liệu prod chạm vào. **Nơi lỗi:** `src/hooks/useUtilityBills.ts:341,352,354` (list) và `:504-512` (chart).

- List (`useUtilityPayments`): phiếu có ≥1 item điện bị gán `type='electric'` cho **cả phiếu**, `amount = total_amount` cả phiếu. Phiếu `5916661a` hiện thành "điện 6.384.000đ"; đồng hồ nước của phiếu đó không thấy khoản 626.000đ.
- Chart (`useUtilityChart`): vòng `for` từng item cộng `Number(v.total_amount)` — phiếu hỗn hợp cộng 6.384.000 vào **cả** nhánh điện **lẫn** nhánh nước → "Đã chi NCC" phồng gấp đôi giá trị phiếu; phiếu nhiều item cùng loại trải nhiều tháng cũng cộng lặp theo số item.
- **Không ảnh hưởng sổ quỹ/posting** — chỉ sai màn hiển thị + biểu đồ của trang này.

**Khuyến nghị:** select thêm `it.amount`; tính phần điện/nước = Σ item đúng loại; list tách dòng theo loại (hoặc type `mixed` + hai cột tiền); chart cộng `it.amount` thay vì `total_amount`. Unit test với fixture hình dạng phiếu `5916661a`. **Effort:** ~2–3h.

### P1-02 — Chủ công ty thật bị khoá đặc quyền "Đóng thêm" (p_force)

**Trạng thái:** hiện hữu trên org iHome. **Nơi lỗi:** dữ liệu vai — `organization_roles` vai "Chủ công ty" `system_key=NULL`; hàm `is_org_owner_v1` (baseline `:15414`) và UI đều đúng thiết kế.

- Đo prod: user `0520169e…` `member_type='OWNER'` nhưng `is_org_owner_v1=false` → gặp kỳ đã có phiếu, server trả `can_force=false`, UI báo "muốn đóng THÊM phải nhờ chủ tổ chức" — với chính chủ tổ chức. Chỉ super admin (tài khoản hệ thống) bấm được.
- Đây là án lệ "Vai Chủ công ty không lọt `is_org_owner_v1`" tái hiện trên đường `pay_period_fee`; TODO Slice 0 (hai định nghĩa "chủ" song song) ghi ngay trong `20260731011000_slice_minus1_guards.sql:500-515` vẫn treo.

**Khuyến nghị:** data-fix gắn `system_key='TENANT_OWNER'` cho vai "Chủ công ty" của org qua lane `migrate:forward` (kèm guard: mỗi org tối đa 1 vai TENANT_OWNER). **Đây là quyết định phân quyền của chủ — hỏi chủ 1 câu trước khi chạy.** Dài hạn: chốt Slice 0 một định nghĩa "chủ sở hữu" duy nhất. **Effort:** migration ~30' + 1 quyết định.

### P2-01 — Realtime không invalidate 3 sổ theo dõi + biểu đồ Điện-Nước

**Trạng thái:** hiện hữu khi có client thứ hai. **Nơi lỗi:** `src/hooks/realtime/finance.ts:34-75`.

Map `income_expenses` đã có 4 khoá period (vá C-INFRA-7 ngày 28/08) nhưng thiếu `tt-termination-queue`, `tt-sale-bonus`, `tt-deposit-ledger` (3 sổ của `SettlementPanels`) và `utility-chart`. Máy khác tạo/duyệt/huỷ phiếu → 3 sổ + biểu đồ giữ số cũ tới khi đổi kỳ hoặc F5.

**Khuyến nghị:** thêm 4 khoá vào map + cập nhật `useRealtimeDataSync.test.ts`. **Effort:** ~30'.

### P2-02 — Sổ "Thưởng Sale" và "Cọc đã thu" chưa phân trang (cap 1.000 của PostgREST)

**Trạng thái:** latent (runtime hiện ~17/469 dòng). **Nơi lỗi:** `useThanhToanLedgers.ts:142-156`, `:197-213`. Kỳ nào vượt 1.000 phiếu là sổ **im lặng thiếu dòng** — đúng lớp lỗi F8 đã vá cho termination queue ngay cùng file (`:49-52` dùng `fetchAllRows` fail-closed). **Khuyến nghị:** áp cùng khuôn `fetchAllRows` cho 2 query còn lại. **Effort:** ~30'.

### P2-03 — List + chart Điện & Nước chưa phân trang

**Trạng thái:** latent (runtime ~108 dòng/kỳ). **Nơi lỗi:** `useUtilityBills.ts:319-335` (list theo kỳ), `:492-502` (chart 7 kỳ, span càng dài càng dễ chạm cap). **Khuyến nghị:** `fetchAllRows`; làm chung một PR với P1-01 vì đụng cùng hai hàm. **Effort:** gộp vào P1-01.

### P2-04 — Kỳ mặc định lấy theo giờ máy, không theo giờ org

**Trạng thái:** latent. **Nơi lỗi:** `ThanhToan.tsx:45-48` (`new Date()` local). Server đã dùng `org_today_v1` (`:82915` baseline). Máy lệch múi giờ (du lịch, VPS, máy sai giờ) mở trang trong ngày giao tháng sẽ chọn sẵn kỳ sai — phiếu ghi đúng kỳ user NHÌN thấy nên tiền không sai, nhưng người dùng có thể đóng nhầm kỳ. **Khuyến nghị:** helper `currentMonth` theo `Asia/Ho_Chi_Minh` (Intl API) dùng chung với `/thu-tien` (cùng key `flt:thu-tien:month`). **Effort:** ~30'–1h.

### P2-05 — Sửa phiếu không có optimistic concurrency: hai modal đè nhau im lặng

**Trạng thái:** latent. **Nơi lỗi:** `update_period_fee` (baseline `:95578`) không nhận expected version; hai bề mặt của trang giữ modal local (chủ ý — `usePeriodFeeState.ts:43-44`) nên mở được 2 modal Sửa cùng một phiếu; attachments là REPLACE cả mảng (`:95631`) → bản lưu sau nuốt ảnh/sổ bản lưu trước, không cảnh báo. Header `total_amount` không drift nhờ trigger `:145625`. **Khuyến nghị:** thêm `p_expected_updated_at` — đổi chữ ký nên **PHẢI `DROP FUNCTION` rồi `CREATE`** (án lệ overload PostgREST); client seed `updated_at` khi mở modal, conflict thì toast "Phiếu vừa được sửa ở nơi khác — mở lại". **Effort:** ~1–2h.

### P2-06 — `pay_draft_fee_voucher`: lộ trạng thái phiếu xuyên org + UPDATE trước gate (MỚI — audit gốc gán nhầm "đã biết")

**Trạng thái:** latent (cần biết UUID phiếu org khác; UUID không đoán được nhưng có thể rò qua log/export/nhân sự cũ). **Nơi lỗi:** baseline `:82674-82703`.

Thứ tự hiện tại: lock phiếu → tiết lộ tồn tại + trạng thái ("Không tìm thấy phiếu" / "Phiếu đã bị hủy" / "Phiếu không ở trạng thái nháp (hiện: %)") → kiểm sổ CỦA CALLER → **UPDATE phiếu** → `approve_voucher` mới là gate quyền thật (RAISE → rollback toàn bộ). Kết quả: user org B có UUID phiếu org A dùng được hàm này làm **máy dò trạng thái**; không ghi bẩn được nhờ rollback, nhưng đây là oracle + vi phạm defense-in-depth (ghi trước, hỏi quyền sau).

**Khuyến nghị:** đưa gate org/toà (khuôn `can_access_building` như `pay_period_fee:82768-82773`) lên **trước** SELECT trạng thái; mọi ca không-có-quyền và không-tồn-tại trả cùng một thông báo. Không đổi chữ ký → `CREATE OR REPLACE` an toàn. **Effort:** ~1h.

### P2-07 — Sổ quỹ mặc định đoán theo TÊN `'%Thu'` — cả client lẫn server (MỚI — brief §4.4, audit gốc bỏ qua)

**Trạng thái:** latent + nghịch nghĩa. **Nơi lỗi:** client `usePeriodFeeState.ts:276-281`; **server** `pay_period_fee` baseline `:82902-82909` (không truyền `p_account_id` thì tìm sổ `LIKE '%Thu'`, không có thì RAISE `Bạn chưa có sổ quỹ "…Thu" để chi tiền`).

Trang CHI tiền mà mặc định rơi vào sổ tên "…Thu"; user không có sổ tên đó (nhân sự mới, org đặt tên khác) bị chặn với thông báo khó hiểu. Doc 07 §10 đã liệt resolver-theo-tên là điểm giám sát từ trước. Cột `building_fee_accounts.default_account_id` **đã tồn tại và server đã học first-write-wins** (`:82963-82968`) nhưng chưa được dùng làm fallback.

**Khuyến nghị:** thứ tự fallback mới: sổ user chọn → `default_account_id` của (toà × hạng mục) → sổ default của user → mới tới heuristic tên; sửa thông báo lỗi thành hành động được ("Chọn sổ quỹ trước khi đóng"). **Effort:** ~1–2h (client + RPC, không đổi chữ ký).

### P3-01 — 758 dòng dead code

`UtilityDesktopPanel.tsx` (436) + `UtilityBillSheet.tsx` (322): 0 import sống (chỉ còn trong comment `UtilityEnContent.tsx:4` và doc 15). Xoá 2 file + gỡ 2 tham chiếu văn bản. **Effort:** ~15'.

### P3-02 — Song trùng ~1.544 dòng Panel/Sheet

Lặp: form đóng tiền, voucher list wiring, book menu, modal wiring. Tách block render chung nhưng **giữ nguyên hai-bề-mặt-cùng-mount và modal local** (chủ ý có spec bảo vệ `thanh-toan-page.spec.ts:27/:32/:143`). **Effort:** ~1 ngày, làm sau cùng.

### P3-03 — Hook lõi 652 dòng không có unit test

`usePeriodFeeState.ts`: cần tối thiểu case — kho slot per (hạng mục|kỳ) không lây chéo; retain/release + StrictMode double-mount; `inflightPays` sống qua đổi kỳ; vòng đời `justPaid` (tan khi reader thấy phiếu, kẹt khi nào); `confirmCancel` dọn cờ đúng tòa; render đồng thời 2 consumer. **Effort:** ~0,5–1 ngày.

### P3-04 — Vệ sinh `pay_period_fee`

(a) Comment dup-check nói "phiếu APPROVED"/"chưa mở rộng UNAPPROVED" (`:82812-82816`) trong khi code đếm `<> 'CANCELLED'` tức **đã gồm** UNAPPROVED — comment stale dễ dẫn slice sau sửa nhầm; (b) `v_months` tính ra (`:82781-82782`) rồi không dùng; (c) nhân tiện kẹp `v_months <= 36` khớp client (hiện caller RPC trực tiếp ghi được kỳ dài tuỳ ý — ghi chú 🟡 của audit gốc). **Effort:** ~30', đi cùng PR của P2-05.

**Ghi chú không đếm finding:** toast nhiều chỗ đưa thẳng `(ex as Error).message` PostgREST thô (UX); org DEMO cần nạp `FLEET_PASS_*` trước khi chạy e2e.

---

## 4. Đã kiểm và SẠCH (cả hai lượt thống nhất)

1. **Chuỗi chống trùng của chính trang** — 3 lớp client (kho slot chung, `inflightPays` đồng bộ, `justPaid`) + advisory xact lock server theo org×toà×hạng mục×tháng + dup-check chạy cả khi force + sổ vết `period_fee_force_events`.
2. **Dup-check không lọc `system_source`** — phiếu tạo tay bên Thu chi cùng hạng mục/kỳ vẫn được đếm và cảnh báo.
3. **`can_force` server-first** — client dùng `??` đúng chiều; `confirmPayDup` dùng câu trả lời server đã mở dialog.
4. **Attachments**: `COALESCE(p_attachments, attachments)`; NULL không xoá ảnh; append per-voucher có RPC riêng.
5. **Seed modal Sửa** bằng `voucherTotal`; khoá amount/kỳ khi đa hạng mục — client khớp server.
6. **Đồng bộ header/item**: `trigger_auto_recalc_total_amount` giữ `total_amount` = Σ item; probe prod 0 drift.
7. **Huỷ phiếu**: soft-delete + trigger Finance V2 đảo posting; cảnh báo recurring-sinh-lại khớp hành vi generator.
8. **ACL & overload**: các RPC chính chặn anon, 1 chữ ký runtime mỗi hàm.
9. **Org isolation các reader period**; 3 sổ đọc thẳng qua RLS là chủ ý.
10. **`addMonths`/đa kỳ tổng-cả-khoảng/`setN` client 1-36/parser tiền** — đúng.
11. **StrictMode retain/release, `useSyncExternalStore` immutable writes, `useUtilityPayState` đối xứng đủ cơ chế.**
12. **84 unit test** 4 file vùng này pass (2 lượt chạy độc lập).

## 5. Khoảng trống xác minh

- **E2E chưa chạy tới assertion** — cả hai lượt: thiếu biến `FLEET_PASS_*` trong môi trường chạy (specs dừng ở `auth.ts:39`). Muốn đóng: nạp env từ `CLAUDE.local.md` rồi chạy 3 spec (`thanh-toan-page`, `utility-book-menu`, `utility-paste-receipt`).
- **Chưa có browser profiler** cho re-render Panel/Sheet (đã ghi nhận static ở P3-02) và chưa chụp màn kiểm nút Copilot đè góc dưới phải ở mobile.
- **A11y** (focus trap, `input type="month"` fallback) mới static review, chưa kiểm browser.
- `typecheck:baseline` đỏ 9 lỗi **ngoài phạm vi** (vùng `src/copilot/*` — đang có phiên làm việc song song trên vùng đó, xem `git status`); không thuộc trang này.

## 6. Kiểm chứng động (output thật)

```text
vitest run  feeCategories + collect + useRealtimeDataSync + ngayLocalKhongUTC
→ Test Files 4 passed (4) · Tests 84 passed (84) · Duration 637ms   [Claude Code chạy lại 31/08 23:29]

SQL read-only (Management API, BEGIN READ ONLY):
→ Phiếu 5916661a…: total 6.384.000 · items [điện 5.758.000, nước 626.000] · system_source 'utility.bill'
→ Chủ công ty 0520169e…: member_type OWNER · role 'Chủ công ty' · system_key NULL · is_org_owner_v1 FALSE
→ (lượt audit gốc) deleted-còn-active-posting 0 · posted-thiếu-posting 0 · amount drift 0 · item-sum drift 0
```

---

## 7. Kế hoạch khắc phục (3 đợt — chi tiết ở plan riêng)

| Đợt | Việc | Finding | Effort |
|---|---|---|---|
| **1 — tuần này** | Sửa reader+chart Điện-Nước theo `it.amount` (kèm phân trang 2 query đó) | P1-01, P2-03 | ~3h |
| | Data-fix `system_key='TENANT_OWNER'` cho vai "Chủ công ty" — **chờ chủ gật đầu**, đi lane `migrate:forward` | P1-02 | 30' + quyết định |
| | Thêm 4 khoá realtime + test | P2-01 | 30' |
| | `fetchAllRows` cho Sale bonus + Deposit ledger | P2-02 | 30' |
| **2 — kế tiếp** | Gate-trước-đọc cho `pay_draft_fee_voucher` | P2-06 | 1h |
| | CAS `update_period_fee` (`p_expected_updated_at`, DROP+CREATE) + vệ sinh comment/`v_months`/kẹp 36 | P2-05, P3-04 | 2h |
| | `currentMonth` theo giờ VN; fallback sổ mặc định bỏ heuristic tên | P2-04, P2-07 | 2h |
| **3 — nợ kỹ thuật** | Xoá dead code; unit test `usePeriodFeeState`; tách block chung Panel/Sheet | P3-01→03 | ~2 ngày |

Sau mỗi đợt: unit 4 file + e2e 3 spec (nạp FLEET_PASS), `node scripts/reconcile-money.mjs 2026-08`, và `npm run gate:truoc-push` trước push. RPC đổi chữ ký phải DROP rồi CREATE + REVOKE anon + selfcheck (khuôn `20260731030000_voucher_slot_warning.sql`).
