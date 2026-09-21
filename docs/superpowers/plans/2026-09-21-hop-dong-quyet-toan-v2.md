# Khu "Hợp đồng & Quyết toán" — Plan thi hành v2

> **Cho agent thi hành:** dùng `superpowers:executing-plans` hoặc
> `superpowers:subagent-driven-development`. Đọc [Project Contract](../../engineering/PROJECT_CONTRACT.md) trước khi sửa.

## Bối cảnh: đây là lần thứ hai

Một phiên khác đã làm tính năng này, **đã phát hành production, rồi bị gỡ ngược lại** ngày
21/09/2026. Chủ cho biết lý do: **agent đó tự ý sửa trang Thu chi**.

| Mốc | Commit |
|---|---|
| Production lúc đợt đó | `718a04b5` (PR #72 `codex/hop-dong-quyet-toan`, PR #73) |
| Đã rollback app về | `d3a83c64` — deployment `dpl_AgeR6A28wvNV9mP4hqCP2ce6vdGM` |
| Database gỡ bằng | migration `20260921085952_restore_before_contract_settlement` |
| Trạng thái hiện tại | `origin/main` = `2a8b9998`, đã khôi phục xong, web chạy bình thường |

Đợt đó dùng **16 migration** (`contract_settlement_*`, `shared_income_expense_*`, `sale_bonus_*`,
`reservation_refund_*`). Plan này **cấm migration** và **cấm chạm mã Thu chi** — xem Phần 0.

Plan của đợt cũ giữ nguyên tại
[`2026-09-20-hop-dong-quyet-toan.md`](2026-09-20-hop-dong-quyet-toan.md) làm lịch sử.
Biên bản phục hồi ở [`docs/audits/2026-09-21-restore-settlement/`](../../audits/2026-09-21-restore-settlement/).

**Base:** `2a8b9998` · **Nhánh:** `feat/hop-dong-quyet-toan-v2` · **Nguồn:** bản vẽ
`Thanh toan - Hop dong & quyet toan.dc.html` (design `3990b67f-b343-490a-acc7-05fead85c684`)

**Audit plan v1:** [`docs/audits/2026-09-21-hop-dong-quyet-toan-plan-audit/README.md`](../../audits/2026-09-21-hop-dong-quyet-toan-plan-audit/README.md)
— 18 phát hiện, plan này viết lại theo cấu trúc §6 của nó.

### Số dòng đã kiểm lại trên base `2a8b9998`

| Tham chiếu | Dòng | Khớp |
|---|---|---|
| `IncomeExpenseList.tsx` nút Duyệt / Chi / Hoàn tác / Huỷ | 416 · 431 · 458 · 315 | ✅ |
| `IncomeExpenseList.tsx` `canApproveVoucher` / `canEditVoucher` | 230 · 232 | ✅ |
| `IncomeExpensePage.tsx` guard NON_CASH | 1123 | ✅ |
| `IncomeExpensePage.tsx` chọn tuyến Huỷ | **616** (plan cũ ghi 610) | ⚠ đã sửa |
| `IncomeExpensePage.tsx` `expectedExecutionRevision={0}` | 1175 · 1278 | ✅ |
| `PeriodFeeSheet.tsx` ba nhánh render | 524 · 525 · **526 = DEPOSIT_LEDGER** | ✅ |
| `PeriodFeePanel.tsx` `isComm` / `dueCountFor` | 96 · 135 | ✅ |
| `types.ts` `ie_compat_update_pending_v2` | có sẵn | ✅ |

---

## Mục tiêu

Một khu mới trên `/thanh-toan` để **rà soát → duyệt → chi** các khoản chi phát sinh từ hợp đồng
(hoa hồng môi giới · hoàn khách thanh lý · hoàn cọc giữ chỗ · thưởng sale), thay ba hạng mục rời
`hoa_hong` / `chi_thanh_ly` / `thuong_sale`.

**Khu này không tạo phiếu.** Phiếu vào từ trang Thu chi.

---

## Phần 0 — Khoá phạm vi

### 0.1. Ranh giới cứng

| | Được | Không được |
|---|---|---|
| **Mã Thu chi** | Gọi hook/RPC hiện có từ adapter riêng | ❌ Sửa `IncomeExpensePage.tsx`, `IncomeExpenseList.tsx`, `VoucherNote.tsx`, `IncomeExpensePostingDialog.tsx`, các hook trong `src/hooks/income-expenses/` |
| **Database** | Đọc qua RLS, ghi qua RPC đã có | ❌ Migration, bảng mới, cột mới, sửa/xoá RPC, sửa trigger, sửa ACL |
| **`review_state`** | Đọc để hiển thị | ❌ Ghi. Xem [§0.3](#03-vì-sao-không-đụng-review_state) |
| **Tạo phiếu** | — | ❌ Không gọi `create_commission_voucher`, `create_termination_refund_voucher_v1`, `create_sale_bonus_from_deposit_v1`, `create_income_expense_v1` |
| **CSS** | Class có tiền tố riêng của khu mới | ❌ Sửa global, sửa class `.ptt-*` / `.ud-*` đang dùng chung |

**Nghiệm thu ranh giới** (Task V1): `git diff c22adb2c --stat` không được chạm file nào trong
danh sách "không được" ở trên.

⚠ **Nhưng dữ liệu thì dùng chung.** Sửa tên/STK, duyệt, chi, ghi chú bổ sung từ khu mới **sẽ hiện
ngay ở Thu chi** — cùng một phiếu. Không được hứa "Thu chi không đổi gì".

### 0.2. Ngoài phạm vi đợt này

- Tab **Biến động** (Ký mới · Gia hạn · Thanh lý · Bỏ cọc · Giữ chỗ) — bản vẽ có, đợt này không làm.
- **Mobile** (`PeriodFeeSheet`, <1024px).
- Điền `maker_user_id` cho ba writer nghiệp vụ.
- Hạng mục `coc_da_thu` / `DepositLedgerSection` — **giữ nguyên, không đụng**.

Bàn giao phải nêu rõ ba mục đầu là **để đợt sau**, không phải đã làm.

### 0.3. Vì sao không đụng `review_state`

`request_income_expense_changes_v2` đẩy phiếu sang `CHANGES_REQUESTED` được, nhưng đường về
(`resubmit_income_expense_v2`) đòi `maker_user_id` khớp người bấm:

```sql
IF v_ie.maker_user_id IS NULL OR v_ie.maker_user_id <> v_uid THEN
  RAISE EXCEPTION 'only the original maker may resubmit' USING ERRCODE = '42501';
```

Đo 21/09: **93/95 phiếu chờ duyệt có `maker_user_id` rỗng** (2 phiếu có — số này **thay đổi theo
thời gian**, đừng hardcode). Chỉ `ie_compat_insert_v2` điền cột đó; ba writer nghiệp vụ không chạm
tới. ⇒ đi đường `review_state` là **cửa một chiều**.

`user_id` thì 95/95 đều có — nhưng đó là cột khác nghĩa ("ai gõ phiếu"), không phải "ai đứng tên
đề nghị", và không có FK sang `organization_memberships`.

---

## Phần 1 — Tiêu chí nhận phiếu

### 1.1. Vấn đề đã đo

Bộ lọc của v1 chỉ nhận `system_source LIKE 'termination.refund%' / 'reservation.refund%'` hoặc
`commission_kind IN ('broker','sale')`. Đo production 21/09, org THẬT:

**Sót 13 phiếu (3 đang chờ duyệt)** — chúng là phiếu **tạo tay ở Thu chi**, nhận diện bằng *loại
thu chi* chứ không phải dấu nguồn:

| Hạng mục | Tên loại | Phiếu | Chờ duyệt |
|---|---|---:|---:|
| *(NULL)* | Hoàn cọc thanh lý | 5 | 1 |
| XỬ LÝ HĐ | Bổ sung hoàn cọc | 4 | 2 |
| HOA HỒNG | HHMG | 2 | 0 |
| XỬ LÝ HĐ | Hoàn cọc / tiền thừa khi thanh lý | 2 | 0 |

Đây chính là đường vào mà chủ chỉ định ("phiếu chi được tạo từ Thu chi") — bỏ sót nó là hỏng tiền đề.

**Và hai dấu là HOẶC, không đi kèm nhau:** 34 phiếu có `commission_kind` mà `system_source` rỗng.

### 1.2. Luật nhận phiếu

Một phiếu thuộc khu này nếu **type = EXPENSE**, chưa xoá mềm, **và** thoả **ít nhất một**:

| # | Dấu | Cách nhận |
|---|---|---|
| D1 | Nguồn hoàn thanh lý | `system_source LIKE 'termination.refund%'` |
| D2 | Nguồn hoàn giữ chỗ | `system_source LIKE 'reservation.refund%'` |
| D3 | Loại hoa hồng/thưởng | `commission_kind IN ('broker','sale')` |
| D4 | **Hạng mục kế toán** | phiếu có ít nhất một `income_expense_items` mà loại của nó khớp `settlementTypeMatches()` |

`settlementTypeMatches` viết theo đúng khuôn `feeTypeMatches` trong `src/lib/feeCategories.ts` —
dùng `nrm()` để bỏ dấu, khớp trên **category ĐÃ chuẩn hoá** có fallback theo **tên**:

```ts
// src/lib/settlementTypes.ts
import { nrm } from '@/lib/fixedExpenseCategories';

export type SettlementKind = 'refund' | 'commission' | 'bonus';

/**
 * Khớp MỘT income_expense_type với ba loại khoản của khu này.
 *
 * Viết theo khuôn `feeTypeMatches` (feeCategories.ts): khớp CATEGORY đã chuẩn hoá
 * trước, fallback theo TÊN — vì `category` là TEXT tự do và có loại để NULL
 * (đo thật: "Hoàn cọc thanh lý" có category NULL).
 *
 * ⚠ Đây là luật production, không phải tìm chuỗi tuỳ ý. Mỗi nhánh phải có test
 * ghim bằng dữ liệu tên loại THẬT đã đo, và phải loại trừ tường minh những tên
 * dễ nuốt nhầm.
 */
export function settlementTypeMatches(
  category: string | null | undefined,
  name: string | null | undefined,
): SettlementKind | null {
  const c = nrm(category);
  const n = nrm(name);

  // Hoàn khách: "hoàn cọc", "hoàn tiền cọc", "tiền thừa khi thanh lý".
  // Loại trừ "thu cọc"/"nhận cọc" — đó là phiếu THU, không thuộc đây.
  if ((c.includes('hoan coc') || n.includes('hoan coc')
    || n.includes('hoan tien coc') || n.includes('tien thua khi thanh ly'))
    && !n.includes('thu coc') && !n.includes('nhan coc')) return 'refund';

  // Thưởng sale: xét TRƯỚC hoa hồng, vì "Thưởng nóng Sale" có category "Hoa hồng".
  if (n.includes('thuong nong') || n.includes('thuong sale')) return 'bonus';

  // Hoa hồng môi giới. "HHMG" là viết tắt đang dùng thật trên production.
  // Loại trừ "hoa hong nhan vien" nếu sau này xuất hiện — không thuộc khu này.
  if ((c === 'hoa hong' || n.includes('hoa hong') || n === 'hhmg')
    && !n.includes('nhan vien')) return 'commission';

  return null;
}
```

**Thứ tự ưu tiên khi một phiếu dính nhiều dấu:** D3 → D1/D2 → D4. Ghi rõ trong mã.

**Khử trùng bằng `voucher.id`** — một phiếu nhiều hạng mục chỉ ra **một** dòng.

### 1.3. Ca biên bắt buộc xử lý

| Ca | Hiển thị |
|---|---|
| Phiếu không có `contract_id` | Cột nguồn hiện **"Chưa xác định liên kết"**. ❌ **Không** tự gán sang hợp đồng hiện tại của phòng |
| Phiếu nhiều hạng mục | Một dòng, `kind` theo thứ tự ưu tiên, nhãn phụ ghi "nhiều hạng mục" |
| Hoàn giữ chỗ (`reservation.refund%`) | `kind='refund'`, nhưng **không có căn cứ hồ sơ thanh lý** — xem [§2.3](#23-trạng-thái-căn-cứ) |
| Loại thu chi không đọc được (RLS) | Không suy ra `kind` — hiện "Chưa phân loại", vẫn cho duyệt/chi bình thường |

### 1.4. Phạm vi org và toà

Truy vấn **phải** lọc `organization_id` và `building_id IN (buildingIds)` cùng phạm vi mà
`useMyPermissions` đang đọc. Cache key gồm cả hai. Người nhiều org đổi org thì query phải chạy lại.

---

## Phần 2 — Nghĩa của "rà soát"

### 2.1. Hai làn là HIỂN THỊ, không phải trạng thái

Phiếu ở làn nào thì với Thu chi vẫn là một phiếu `UNAPPROVED`. Khu này không sở hữu trạng thái nào.

```
Thu chi tạo phiếu ─▶ khu mới hiện phiếu ─▶ soi điều kiện
                                             │
                      ┌──────────────────────┴─────────────┐
                      │ có BLOCKER                   sạch  │
                      ▼                                    ▼
               ╔═══════════════╗                  ╔═══════════════╗
               ║ CẦN RÀ SOÁT   ║ ── sửa xong ──▶  ║  CHỜ DUYỆT    ║
               ╚═══════════════╝                  ╚═══════╤═══════╝
                                                          │ Duyệt · Duyệt & Chi
                                                          ▼
                                            ╔═══════════════════════╗
                                            ║ ĐÃ DUYỆT · CHỜ CHI    ║── Chi ─▶ ĐÃ CHI
                                            ╚═══════════════════════╝
```

### 2.2. Blocker ≠ Cảnh báo

**Đây là chỗ v1 sai nặng nhất.** v1 gộp mọi vướng mắc thành một, khiến phiếu tồn kỳ cũ bị đẩy vào
Cần rà soát rồi **ẩn mất nút Duyệt** — mà cách duy nhất hết vướng lại là duyệt. Vòng kẹt.

| Mã | Loại | Ý nghĩa | Vào làn Cần rà soát? |
|---|---|---|---|
| `MISSING_RECIPIENT` | **Blocker** | Thiếu **tên** người nhận | ✅ |
| `MISSING_BANK` | **Blocker** *(chỉ khi chi chuyển khoản)* | Thiếu số tài khoản | ✅ |
| `AMOUNT_MISMATCH` | **Blocker** | Số phiếu ≠ số căn cứ | ✅ |
| `BASIS_UNAVAILABLE` | **Blocker** | Đã tra căn cứ và **LỖI** / không đủ quyền | ✅ |
| `BASIS_NOT_FOUND` | **Cảnh báo** | **Chưa** tra căn cứ ở mức danh sách (vd hoàn thanh lý chỉ tra bằng `preview_…` khi mở modal) | ❌ |
| `SUPPLEMENT_PENDING` | **Blocker** | Có yêu cầu bổ sung chưa xử lý | ✅ |
| `OLD_PERIOD` | **Cảnh báo** | Phiếu thuộc kỳ trước | ❌ — chỉ hiện nhãn |
| `BASIS_NOT_APPLICABLE` | **Ghi chú** | Loại này không có công thức căn cứ (thưởng sale, hoàn giữ chỗ) | ❌ |

```ts
const BLOCKERS: ReadonlySet<SettlementIssue> = new Set([
  'MISSING_RECIPIENT', 'MISSING_BANK', 'AMOUNT_MISMATCH',
  'BASIS_UNAVAILABLE', 'SUPPLEMENT_PENDING',
]);

export function laneOf(row: Pick<SettlementRow, 'status' | 'issues'>): SettlementLane | null {
  if (row.status !== 'pending') return null;   // đã duyệt/đã chi/đã huỷ không thuộc làn nào
  return row.issues.some(i => BLOCKERS.has(i)) ? 'can-ra-soat' : 'cho-duyet';
}
```

⚠ **`MISSING_BANK` phụ thuộc cách chi.** Phiếu trả tiền mặt không cần STK. Trước khi thi hành,
**đọc `posting_mode` và loại sổ** để biết phiếu đi tiền mặt hay chuyển khoản; nếu không phân biệt
được thì để `MISSING_BANK` là **cảnh báo**, không phải blocker, và ghi rõ giới hạn đó trong bàn giao.

### 2.3. Trạng thái căn cứ

v1 gán `basisAmount = null` cho cả "không đọc được" lẫn "không áp dụng" ⇒ lỗi tải dữ liệu bị coi là
phiếu sạch. Tách năm trạng thái:

```ts
export type BasisState =
  | { kind: 'matched'; amount: number }        // đọc được, dùng để đối chiếu
  | { kind: 'mismatch'; amount: number }       // đọc được, lệch số phiếu
  | { kind: 'unavailable'; reason: string }    // đọc LỖI hoặc không đủ quyền → BLOCKER
  | { kind: 'not-found'; reason: string }      // nguồn tồn tại nhưng không tìm thấy căn cứ → BLOCKER
  | { kind: 'not-applicable' };                // loại không có công thức → không chặn
```

**Nguồn căn cứ theo loại:**

| Loại | Căn cứ | Bẫy đã biết |
|---|---|---|
| Hoa hồng | `get_period_commissions` → `expectedAmount` | ⚠ RPC lọc theo **ngày ký hợp đồng**, danh sách lọc theo **ngày phiếu**. HĐ ký tháng 8, phiếu lập tháng 9 ⇒ gọi kỳ 9 **không tìm thấy**. Phải gọi thêm kỳ của `contracts.signed_date`, hoặc chấp nhận `not-found` và ghi rõ |
| Hoàn thanh lý | `preview_termination_refund_v1` | ⚠ **KHÔNG** dùng `contract_terminations.refund_amount` làm căn cứ chi — đó là cột GENERATED của hồ sơ. RPC preview mới đối chiếu cọc thực thu và trả cảnh báo `CHUA_TUNG_VAO_KET` / `VUOT_COC_THAT` |
| Hoàn giữ chỗ | — | `not-applicable` đợt này |
| Thưởng sale | — | `not-applicable` |

⚠ Căn cứ hoa hồng đọc **bậc hiện tại**, không phải bậc tại ngày ký. Nhãn phải ghi
**"theo bậc hiện hành"**, không ghi "theo hợp đồng".

### 2.4. "Yêu cầu bổ sung" — giới hạn phải nói thật

Ghi bằng `append_income_expense_supplement_v1`, dấu `[CẦN BỔ SUNG]` / `[ĐÃ BỔ SUNG]` ở **đầu** nội
dung; làn đọc theo dấu của dòng **mang dấu mới nhất**.

⚠ **RPC này gác bằng quyền ĐỌC phiếu, không phải `income_expenses.edit`.** Người tạo phiếu, thủ quỹ
giữ sổ, chủ tổ chức đều ghi được. ⇒ **Không được mô tả đây là bước rà soát có server bảo vệ theo
quyền sửa.** Nó là **dấu vết có định danh**: mỗi dòng lưu `actor_name` + `created_at` bất biến.

Giao diện phải:
- Hiện rõ **ai** yêu cầu và **khi nào**, ngay trên dòng.
- Trước khi bấm "Đã bổ sung", **tải lại** danh sách ghi chú và **hiện yêu cầu đang xử lý** — vì
  RPC không có tham số "đang hoàn tất yêu cầu nào", nên hai yêu cầu liên tiếp có thể bị gỡ nhầm.
- Không tuyên bố thao tác này có khoá phiên bản.
- Kiểm lý do rỗng **trước** khi ghép tiền tố; tính **giới hạn 5.000 ký tự** gồm cả tiền tố.
- `idempotencyKey` ổn định theo **nội dung**: đổi nội dung sau một lần ghi thành công là **hành động
  mới**, phải có key mới.

---

## Phần 3 — Kỳ và ngày

### 3.1. Vấn đề đã đo

95 phiếu chờ duyệt phân bố: **45 tháng 9 · 47 tháng 8 · 3 tháng 7**. Lọc một tháng **giấu mất
50/95** việc còn tồn.

### 3.2. Luật

- **Mặc định: "Việc đang mở"** — lấy **mọi** phiếu chưa xử lý xong, không giới hạn kỳ. Đây là chế
  độ người dùng cần hằng ngày.
- Bộ chọn kỳ vẫn có, nhưng là **bộ lọc phụ** với ba lựa chọn: `Việc đang mở (mọi kỳ)` ·
  `Kỳ này` · `Kỳ cụ thể…`.
- Phân trang bằng `fetchAllRows` — đây là truy vấn tập hợp không giới hạn theo id nên **dính
  cap-1000 thật**. Thứ tự ổn định: `voucher_date DESC, id ASC`.

### 3.3. Ba loại ngày, không lẫn

| Ngày | Cột | Dùng cho |
|---|---|---|
| Ngày phiếu | `voucher_date` | Sắp xếp, nhãn `OLD_PERIOD` |
| Ngày nghiệp vụ | `contracts.signed_date` / `contract_terminations.termination_date` | Dòng thời gian trong modal |
| Ngày ghi quỹ | từ posting | Thẻ "Đã chi trong kỳ" |

⚠ Thẻ "Đã chi" **phải theo ngày ghi quỹ**, không theo ngày lập phiếu.

---

## Phần 4 — Bản đồ file

| File | Trách nhiệm |
|---|---|
| `src/lib/settlementTypes.ts` ⭑ | `settlementTypeMatches` — luật nhận phiếu theo hạng mục |
| `src/lib/contractSettlement.ts` ⭑ | Kiểu dữ liệu, `laneOf`, `detectIssues`, `basisStateOf`, `supplementPending`, tổng |
| `src/hooks/useContractSettlement.ts` ⭑ | Reader: phiếu + căn cứ + ghi chú bổ sung |
| `src/hooks/useSettlementActions.ts` ⭑ | **Adapter** gọi hook Thu chi sẵn có. Không sửa Thu chi |
| `src/components/thu-tien/contract-settlement/*` ⭑ | Section · Table · LifecycleModal |
| `src/lib/feeCategories.ts` | **Sửa**: 3 entry → 1 entry `hop_dong` |
| `src/components/thu-tien/PeriodFeePanel.tsx` | **Sửa**: 3 nhánh → 1 nhánh, sửa `dueCountFor` |
| `src/components/thu-tien/PeriodFeeSheet.tsx` | **Sửa**: bỏ 3 nhánh (mobile), **giữ dòng `DEPOSIT_LEDGER`** |
| `src/components/thu-tien/SettlementPanels.tsx` | **Sửa**: bỏ 2 section, giữ `DepositLedgerSection` |

⭑ = file mới. **Không file nào trong `src/pages/payments/` hay `src/components/income-expenses/`.**

---

## Phần 5 — Bảng tuyến hành động

Adapter **đọc** cách Thu chi chọn tuyến rồi làm y hệt, **không sửa** Thu chi.

### 5.1. Duyệt

| Điều kiện | Hành động |
|---|---|
| `UNAPPROVED` + `income_expenses.approve` | Hiện nút Duyệt |
| route `canWriteWorkflow` | `useApproveIncomeExpenseV2({voucherId, expectedApprovalVersion})` |
| route LEGACY | `useApproveVoucher(id)` — thang ba bậc, xem `statusMutations.ts:137` |

⚠ Nút Duyệt của Thu chi **không** phụ thuộc route (`IncomeExpenseList.tsx:416` chỉ xét
`canApproveVoucher && isUnapproved`). Adapter giữ đúng vậy; route chỉ quyết **gọi hook nào**.

### 5.2. Duyệt & Chi

| Điều kiện | Nguồn |
|---|---|
| `UNAPPROVED` + `canApprove` + `canWriteWorkflow` + `canWritePosting` | |
| **+ `!isNonCashVoucher(voucher)`** | ⚠ `IncomeExpensePage.tsx:1123` có guard này, v1 **thiếu**. Phiếu NON_CASH không được hiện Duyệt & Chi |
| Thực thi | `IncomeExpensePostingDialog` mode `APPROVE_AND_POST` → `useApproveAndPostIncomeExpenseV2` |

### 5.3. Chi

| Điều kiện | Ghi chú |
|---|---|
| `APPROVED` + `posting_status ∉ {POSTED, NOT_APPLICABLE}` + `isCanonicalRead(org)` | Thu chi gác bằng `isCanonicalRead` (nhận cả `FROZEN`), **không** bằng `canWritePosting`, **không** xét thủ quỹ |
| `REVERSED` | Vẫn chi lại được |
| Thực thi | `IncomeExpensePostingDialog` mode `POST_APPROVED` → `usePostApprovedIncomeExpenseV2` |

⚠ **Nút Chi phải dùng được với phiếu đã duyệt** — mà phiếu đã duyệt **không thuộc hai làn pending**.
Bố cục bảng phải có khối "Đã duyệt · chờ chi" riêng, có nút Chi.

### 5.4. Huỷ — **ba nhánh, không phải một**

`IncomeExpensePage.tsx:616` chọn tuyến:

```ts
if (cancelTargetGate.useIncomeDoor)      cancelIncomeMutation.mutate({voucherId, reason});
else if (cancelTargetGate.useFlexWriter) flexCancelMutation.mutate({voucherId, reason,
                                            expectedApprovalVersion, expectedPostingVersion});
else                                     cancelMutation.mutate({id, reason});  // thang cũ
```

Adapter **phải** dùng `voucherCancelDecision({type, income, flexGate})` từ
`src/hooks/income-expenses/flexMutations.ts` + `incomeVoucherCancel.ts` để chọn đúng nhánh.
v1 chỉ gọi flex ⇒ phiếu `STRICT_MODE` / `NOT_MANUAL` sẽ lỗi ở khu mới nhưng huỷ được ở Thu chi.

**Nút Huỷ:** gác bằng `canCancel && cancelGate.canCancel`. Gate **mặc định lạc quan** khi chưa có
câu trả lời (`flexMutations.ts:86`) — giữ đúng vậy, không khoá nhầm lúc mạng chậm. Khi gate đóng,
**hiện nút disabled kèm lý do**, giống `IncomeExpenseList.tsx:503`.

### 5.5. Sửa tên / STK / ngân hàng

`ie_compat_update_pending_v2(p_id, p_patch)` — **có sẵn trong generated types tại
`src/integrations/supabase/types.ts:21545`**, gọi bình thường, **không** ép kiểu `as never`.

Patch **thưa**: chỉ gửi khoá đã đổi. **Bỏ trống `p_items`** để server giữ nguyên hạng mục.

⚠ **RPC không có tham số CAS.** Hai người cùng sửa tên/STK sẽ ghi đè nhau im lặng. Ghi rõ giới hạn
này trong bàn giao; **không** hứa khoá phiên bản.

Ba khoá `payer_name`, `receive_bank_name`, `receive_bank_account` thuộc nhóm **trục tiền** ⇒ đòi:
`UNAPPROVED`, chưa `POSTED`, không thuộc writer hệ thống, **và** `income_expenses.edit` trên toà.
Đo 21/09: 95/95 phiếu đạt bốn điều kiện về phía **phiếu**; quyền của **từng actor** chưa kiểm — phải
thử bằng JWT các vai (Task V7).

### 5.6. Chứng từ

`IncomeExpensePostingDialog` cần **đủ** callback, v1 thiếu hai cái cuối:

| Prop | Nguồn |
|---|---|
| `expectedExecutionRevision` | **`{0}`** — Thu chi hardcode 0 ở cả ba chỗ. ⚠ **Không có cột DB nào tên `*execution*`**; v1 bảo "đọc thêm cột ấy" là **sai** |
| `expectedApprovalVersion` / `expectedPostingVersion` | từ phiếu |
| `onUploadEvidence` | như `IncomeExpensePage.tsx:1183` |
| `onAdoptAttachments` | `useAttachPostingEvidence` |
| `onAttachEvidence` | ⚠ **v1 thiếu** — ảnh sẽ không hiện ở dòng Thu chi |
| `onRemoveAttachment` | ⚠ **v1 thiếu** — không gỡ được ảnh |
| `cashbookOptions` | `useCustodianCashbooksV2` **giao với** `useAccounts()` lọc theo `organization_id` của phiếu, loại `is_virtual` |

⚠ `list_cashbooks_for_expense_v2()` **không nhận tham số org** — nó trả mọi sổ CUSTODIAN qua mọi
membership, và chỉ có `id, name`. Người nhiều org sẽ thấy sổ org khác nếu không giao.

---

## Phần 6 — Task thi hành

### T1 — Luật nhận phiếu

**File:** `src/lib/settlementTypes.ts` + test

- [ ] Viết test ghim **tên loại thật đã đo**: `Hoàn cọc thanh lý` (category NULL) · `Bổ sung hoàn cọc` (XỬ LÝ HĐ) · `HHMG` (HOA HỒNG) · `Hoàn cọc / tiền thừa khi thanh lý` · `Thưởng nóng Sale` · `Hoa hồng môi giới`
- [ ] Test loại trừ: `Thu cọc` / `Nhận cọc` **không** khớp `refund`
- [ ] Test thứ tự: `Thưởng nóng Sale` (category *Hoa hồng*) ra `bonus`, **không** ra `commission`
- [ ] Chạy đỏ → viết `settlementTypeMatches` → chạy xanh
- [ ] Commit

### T2 — Logic thuần

**File:** `src/lib/contractSettlement.ts` + test

- [ ] Kiểu: `SettlementRow` (gồm `roomId`, `terminationId`, `postingMode`, `approvalStatus`, `postingStatus` thô, ba version, `basis: BasisState`)
- [ ] `settlementStatusOf(approval, posting)` → `pending | approved | noncash | paid | cancelled`
- [ ] `detectIssues` theo bảng [§2.2](#22-blocker--cảnh-báo) — **`BASIS_UNAVAILABLE` và `MISSING_RECIPIENT` là blocker**
- [ ] `laneOf` chỉ chặn theo `BLOCKERS`, **`OLD_PERIOD` không chặn**
- [ ] `supplementPending` — dấu ở **đầu**, dòng mang dấu mới nhất thắng
- [ ] Test: 3 ca `laneOf` · 7 ca `supplementPending` · ca "tồn kỳ cũ vẫn ở Chờ duyệt" · ca "thiếu tên ⇒ Cần rà soát" · ca "căn cứ lỗi ⇒ Cần rà soát" · ca "thưởng sale không căn cứ ⇒ Chờ duyệt"
- [ ] Commit

### T3 — Reader

**File:** `src/hooks/useContractSettlement.ts`

- [ ] Truy vấn phiếu: D1–D4, lọc org + buildingIds + `type='EXPENSE'`, `fetchAllRows`, khử trùng theo id
- [ ] Chế độ kỳ: `Việc đang mở (mọi kỳ)` mặc định
- [ ] Căn cứ hoa hồng: gọi `usePeriodCommissions` cho **kỳ của `signed_date`**, không phải kỳ phiếu
- [ ] Căn cứ hoàn thanh lý: `preview_termination_refund_v1`, **chỉ khi mở modal** (đắt) — danh sách dùng `not-found` cho tới lúc đó, và `not-found` **không** chặn ở danh sách, chỉ chặn trong modal
- [ ] Ghi chú bổ sung: `hydrateIncomeExpenseSupplements` nguyên trạng, chỉ cho phiếu `UNAPPROVED`
- [ ] Lỗi đọc căn cứ/ghi chú ⇒ `BasisState.unavailable`, **không** ⇒ rỗng
- [ ] Commit

### T4 — Adapter hành động

**File:** `src/hooks/useSettlementActions.ts`

- [ ] `availability` (boolean thuần theo [§5](#phần-5--bảng-tuyến-hành-động)) tách khỏi `commands` (hàm)
- [ ] Duyệt: route → V2 hoặc thang ba bậc
- [ ] Duyệt & Chi: **có guard `!isNonCashVoucher`**
- [ ] Chi: gác `isCanonicalRead`
- [ ] Huỷ: **ba nhánh** qua `voucherCancelDecision`
- [ ] Sửa người nhận: patch thưa, **không** `as never`, dùng generated type
- [ ] Ghi chú: `requestSupplement` / `markSupplementDone`, key theo nội dung
- [ ] `isBusy` gồm **mọi** mutation kể cả sửa người nhận; **await** refetch trước khi mở lại nút
- [ ] Lỗi tách nhóm: quyền · phiên bản · kỳ khoá · thiếu dữ liệu · mạng
- [ ] Commit

### T5 — Bảng và bộ lọc

- [ ] Bốn khối: `Cần rà soát` · `Chờ duyệt` · `Đã duyệt · chờ chi` · `Đã xử lý`. Khối rỗng ẩn hẳn
- [ ] Nút Duyệt / Duyệt & Chi **chỉ** ở khối Chờ duyệt; nút Chi **chỉ** ở khối Đã duyệt · chờ chi
- [ ] Sáu nhãn trạng thái tách bạch, `noncash` = **"Đã duyệt · không ghi quỹ (sổ ảo)"**
- [ ] Chip lọc: `Thiếu tên` · `Thiếu STK` · `Lệch căn cứ` · `Chưa có căn cứ` · `Có yêu cầu bổ sung` · `Tồn kỳ cũ`
- [ ] Thẻ thống kê — **định nghĩa từng thẻ** trong chú thích mã: tập phiếu, loại ngày, có gồm tồn cũ không
- [ ] Commit

### T6 — Modal vòng đời

- [ ] **Bảng ánh xạ từng ô trong HTML → nguồn dữ liệu thật** (viết trước khi code)
- [ ] Dòng thời gian: hợp đồng liền trước → hợp đồng của phiếu → hiện tại. Đọc theo `roomId` + `contractId` **của phiếu**
- [ ] Ngày ký · cọc đã đóng · tiền đã đóng · nợ · thanh lý · hoàn khách
- [ ] Ghi chú gốc: **dùng lại `VoucherNote.tsx` nguyên trạng**, không sửa, không ghi đè `notes`
- [ ] Khối người nhận: sửa tại chỗ khi `availability.editRecipient`
- [ ] Hai nút ghi chú + lịch sử có `actor_name`
- [ ] Chỉ tải chi tiết khi **mở** modal; phân biệt loading / rỗng / lỗi / thiếu quyền
- [ ] ⚠ Mọi nút tiền tác động **`voucherId` đang mở**, không chuyển sang phiếu khác cùng phòng
- [ ] Commit

### T7 — Cắt đường cũ

- [ ] Sửa test `feeCategories.test.ts` **trước** (nó ghim cả số lượng category/group), chạy đỏ
- [ ] Registry: 3 entry → 1 `hop_dong`, family `CONTRACT_SETTLEMENT`
- [ ] `dueCountFor` thêm nhánh family mới ở **cả** Panel lẫn Sheet; thêm `CONTRACT_SETTLEMENT` vào vế loại trừ nhãn "đủ"
- [ ] Sheet: bỏ nhánh `:495-496` và **`:524-525` mà thôi** — ⚠ **giữ `:526`** = `DEPOSIT_LEDGER`
- [ ] Ánh xạ key cũ trong **sessionStorage** (`usePersistedState.ts:18`) → `hop_dong`
- [ ] Rà `PeriodFeeSharedModals.tsx` xem còn modal/handler nào của ba mục cũ còn mount
- [ ] ⚠ **Chỉ cắt sau khi T5 + T6 đã nghiệm thu đủ** — không bỏ lối cũ khi đường mới chưa xong
- [ ] Commit

---

## Phần 7 — Nghiệm thu

### V1 — Ranh giới mã (chạy trước mọi thứ khác)

```bash
git diff c22adb2c --stat -- src/pages/payments src/components/income-expenses \
  src/hooks/income-expenses supabase/migrations
```
**Phải rỗng.** Có dòng nào là sai phạm vi.

### V2 — Nhận phiếu
Mỗi loại hoa hồng/hoàn khách/hoàn giữ chỗ/thưởng · phiếu tạo tay theo hạng mục (dùng đúng 3 phiếu
pending đã đo) · thiếu `contract_id` · nhiều hạng mục · khử trùng theo id.

### V3 — Kỳ và ngày
Phiếu tháng trước chưa duyệt **phải hiện** ở chế độ "Việc đang mở" · đã duyệt chưa chi · lập tháng
trước chi tháng này · cuối tháng theo múi giờ tổ chức.

### V4 — Làn
Thiếu tên · thiếu STK theo cách chi · căn cứ lỗi · lệch tiền · nhiều vướng cùng lúc ·
**tồn kỳ cũ vẫn duyệt được**.

### V5 — Tuyến tiền
CANONICAL/LEGACY/FROZEN · Duyệt không tự chi · chỉ phiếu đã duyệt mới Chi · **NON_CASH không hiện
Duyệt & Chi** · huỷ đúng ba nhánh gồm STRICT_MODE/NOT_MANUAL.

### V6 — Chứng từ và sổ
Sổ đúng org, loại thật/ảo, kỳ đóng, mất quyền giữ sổ · ảnh gốc/mới/bổ sung/gỡ · mở lại phiếu ở Thu
chi thấy **cùng** chứng từ.

### V7 — Quyền (bằng JWT vai thật, không bằng super admin)
Chỉ xem · chỉ duyệt · chỉ sửa · chỉ giữ sổ · nhiều org · quyền theo toà · bị thu quyền khi đang mở modal.

### V8 — Đồng thời
Hai người duyệt/chi/huỷ · version cũ · mất mạng sau khi server ghi · bấm lại cùng key ·
**không phát sinh posting/phiếu ngoài ý định**.

### V9 — Không tạo phiếu
Trên fixture DEMO **được định danh**: không gọi RPC tạo, không thêm id phiếu mới, không đổi `notes`
/ hạng mục ngoài input. ⚠ **Không** dùng `count(*)` toàn bảng làm bằng chứng đơn độc — người khác
ghi song song sẽ làm sai.

### V10 — Hồi quy và gate

```bash
npx tsc -p tsconfig.app.json --noEmit
npx vitest run src/lib src/hooks src/components/thu-tien
cd .e2e-fleet && npx playwright test specs/thanh-toan-page.spec.ts   # Contract §8
npm run gate:reconcile-money && npm run gate:reconcile-money-v2
npm run gate:truoc-push
```

⚠ `gate:truoc-push` **không** phủ `security-gates` (15 gate chỉ chạy ở CI) — chạy tay khối lệnh
trong `.github/workflows/ci-gates.yml` trước khi mở draft PR.
⚠ Gate quét mã phải **bỏ chú thích trước khi so** — tên RPC nằm trong comment không được làm test xanh.
⚠ Vitest đầy tải cho **đỏ giả** ở vài bài DOM nặng; đỏ thì chạy lại riêng từng file trước khi kết luận.

### V11 — Phát hành
Draft PR (đụng hành động tiền, Contract §3) · review độc lập theo `crossReview` của risk-map ·
`npm run promote:production -- --sha <sha đủ 40 ký tự>`.

---

## Phần 8 — Việc đã biết là chưa giải quyết

Ghi ra để bàn giao không hứa quá:

1. **Sửa tên/STK không có CAS** — hai người cùng sửa ghi đè nhau im lặng. RPC không nhận version.
2. **Dấu ghi chú không gác bằng `income_expenses.edit`** — ai đọc được phiếu đều ghi được dấu.
3. **Yêu cầu–hoàn tất không ghép cặp** — hai yêu cầu liên tiếp, một dòng "đã bổ sung" có thể gỡ cả hai.
4. **Căn cứ hoa hồng là bậc hiện hành**, không phải bậc tại ngày ký.
5. **Tab Biến động và mobile** để đợt sau.
6. **`maker_user_id`** vẫn rỗng ở ba writer nghiệp vụ — cơ chế "trả về người đề nghị" của DB vẫn
   không dùng được cho ba loại này.
