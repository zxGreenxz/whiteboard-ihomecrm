# Đánh giá lại hai plan `/thu-tien` — bản quyết định production v2 (30/07/2026)

> Tài liệu này **thay thế** `danh-gia-2-plan-thu-tien.md` (29/07/2026, chỉ tồn tại trên nhánh
> `fix/v5-collection-completion-20260722`). Bản 29/07 vẫn là bằng chứng lịch sử; mọi chỗ hai bản
> xung đột thì bản này thắng, vì nó được dựng trên một đợt kiểm toán 10 mảng chạy trên **codebase
> hiện tại + database production sống** ngày 30/07/2026, sau đó bị phản biện đối kháng (63 phán
> quyết: 41 sống, 22 bị bác).
>
> Mọi số liệu hiện trạng được tách riêng sang `2026-07-30-thu-tien-state-of-world.md`. Tài liệu này
> chỉ nêu số khi số đó **là căn cứ của một quyết định**, và luôn ghi rõ khi nó bác một số của bản 29/07.
>
> Đây là **plan**. Không một dòng nào dưới đây được đọc là "đã code", "đã apply", "đã test".

## 1. Kết luận điều hành

Verdict 29/07 là **"đủ điều kiện bắt đầu Slice 0 read-only/prerequisite"**.

**Verdict 30/07: KHÔNG. Chưa đủ điều kiện bắt đầu Slice 0 như đã định nghĩa.** Bốn lý do, theo thứ tự
mức độ:

1. **Có một tầng khuyết tật ĐANG SỐNG trên production, độc lập với cả hai plan, đang làm mất hoặc
   khai sai tiền NGAY LÚC NÀY.** Chín khuyết tật đã được đo tận gốc (§4). Ba trong số đó không chỉ là
   bug: chúng làm **mục tiêu của chính hai plan trở nên bất khả thi** — không thể tạo partial unique
   index trên dữ liệu đã vi phạm nó (22 slot phí cố định × 45 phiếu, 13 slot thuộc tháng 07/2026,
   tức vẫn đang sinh thêm), và không thể "chỉ hiện Đã hoàn khi có phiếu POSTED" khi hàm KPI trên cùng
   trang vẫn cộng công thức tự tính. Vì vậy có một **Slice −1** đứng trước tất cả.
2. **Nhiều điều kiện tiên quyết của bản 29/07 nhắm vào vấn đề KHÔNG TỒN TẠI.** Nặng nhất: forward-correct
   `thu_tien.view` "cần CASHBOOK" (catalog live khai `required_dimensions=[]`,
   `requires_cashbook_possession=false` — CASHBOOK chỉ là một trong bốn `scope_kinds` được chấp nhận;
   làm theo plan sẽ **thu hồi 24 cạnh grant đang chạy**), và digest-check/forward-define
   `ensure_income_expense_type_v1` + `normalize_income_expense_type_name` (cả hai **đã có** defining
   migration tracked tại `20260728180000_income_expense_type_canonicalization.sql:13` và `:792`).
3. **Toàn bộ tiền đề shared-runtime của Plan 2 KHÔNG có trên prod.** Không tồn tại
   `app_private.special_page_submit_context_v1`, không tồn tại `finance_v2_post_voucher_with_source_v1`
   (grep `%with_source%` và `%special%` trên `pg_proc` = rỗng), không tồn tại một object nào tên
   `special_fee*` / `termination_refund*` / `room_residence_segments` / `termination_settlement_snapshots`.
   Nghĩa là **Plan 2 Task 1–5 bị hard-block**: chúng được viết như thể chỉ cần "gọi" shared context, trong
   khi shared context là một hạng mục công việc của Plan 1 chưa từng bắt đầu.
4. **Nhánh làm việc đã hấp thu Đợt 0–6 "thu chi linh hoạt".** 24 migration nằm trong dải
   `20260730100000 → 20260730280000` đã lên prod. Việc này (a) chiếm đúng timestamp `20260730160000`
   mà Plan 2 định dùng, (b) làm mọi `CREATE OR REPLACE` mà Plan 1 đặt ở `202607300000xx` bị khối Đợt
   ghi đè khi rebuild clone, (c) cài thêm bốn tầng khoá mà cả hai plan chưa biết:
   `income_expenses_check_lock` / `income_expense_posting_lines_check_lock` (chốt sổ),
   `a02_ie_profit_lock_*` (chốt lợi nhuận, **18 toà đã chốt tháng 05/2026**), nhánh ANNOTATE của
   `guard_income_expense_owned_payload`, và `DO $guard$` của `20260730280000` — hàng rào quét toàn
   schema, tự `RAISE` nếu còn hàm public khai `STABLE/IMMUTABLE` mà chạm khoá dòng. **Toàn bộ ~8 read
   RPC mà hai plan gọi là "read-only" đều gọi `authorize_tenant_action_v3`, hàm này có `SELECT … FOR
   SHARE`** — khai `STABLE` là vừa ném `25006` qua PostgREST vừa làm migration abort.

Điều **không** đổi: ý định nghiệp vụ của chủ. Bảng luật ở §3 sống gần như trọn vẹn; kiến trúc chốt ở
§6 của bản 29/07 (shared submit context, dedicated posting adapter, obligation ledger + sticky
canonical-subject marker) vẫn là kiến trúc đúng. Cái phải đổi là **thứ tự**, **file đích**, và
**tiền đề kỹ thuật**.

**Verdict thi hành:** được phép bắt đầu **Slice −1** ngay (hotfix production, không schema mới,
không feature surface mới). **Slice 0 chỉ được mở sau khi Slice −1 xanh**, và Slice 0 phải được viết
lại thành "sửa văn bản plan + preflight", không còn migration. Không một money route nào được bật
cho tới khi gate của slice tương ứng xanh theo §7.

## 1bis. QUYẾT ĐỊNH CỦA CHỦ — 30/07/2026 (rằng buộc, thắng mọi mục khác)

> Nguyên văn: **“tất cả khoản tiền đó giữ nguyên đi ghi nhận là được đừng đụng vào”.**

Áp dụng cho toàn bộ dữ liệu tiền đã tồn tại. Diễn giải thi hành:

1. **Không sửa, không huỷ, không đảo, không xoá** bất kỳ dòng `income_expenses` /
   `income_expense_items` / `contract_terminations` / `payments` / posting nào đang có.
2. **Không viết backfill làm đổi số tiền, trạng thái hay posting.** Backfill chỉ được **đọc và ghi nhận**
   sang sổ phụ (claim/conflict ledger), không chạm bản ghi gốc.
3. **22 ô phí cố định / 45 phiếu** (gồm cặp `66.000.000đ` toà 102LVT, và worst-slot 3 phiếu
   `108.400.000đ`), **2 ô công tơ**, **3 ô mức toà**, và **3 phiếu `quan_ly` item NULL-date**:
   **giữ nguyên**, chỉ ghi nhận.
4. Do đó **mọi ràng buộc chống trùng chỉ áp cho phiếu MỚI.**

### 1bis.1 Hệ quả thiết kế bắt buộc — chống trùng KHÔNG đặt trên phiếu lịch sử

Bản 30/07 trước đó coi “dọn 22 ô” là **điều kiện tồn tại** của partial unique BASE index
(§4.1). Quyết định của chủ **bác** cách đó. Thiết kế thay thế — và may mắn là kiến trúc plan
**đã hỗ trợ sẵn**, không phải thiết kế lại:

| Điểm | Bản trước 30/07 | Sau quyết định của chủ |
|---|---|---|
| Nơi đặt uniqueness | Suy ra từ phiếu lịch sử ⇒ `CREATE UNIQUE INDEX` **fail ngay lúc tạo** | Đặt trên **sổ claim mới** (`special_fee_claims`), bảng trống lúc tạo ⇒ index tạo được |
| Ô đang có ≥2 phiếu | Phải dọn trước | Sinh **đúng một claim `CONFLICT`** cho cả ô (đã là luật ở Plan 1 Task 6 Step 6: “một slot legacy duy nhất → `LEGACY`; nhiều voucher → `CONFLICT`”) |
| Phiếu lịch sử | Có thể bị đảo/huỷ để dọn | **Bất biến.** Chỉ được tham chiếu từ claim |
| Chặn trùng mới | Dựa vào index | **Kiểm trong hàm writer** + advisory lock theo slot ⇒ chặn phiếu mới, không hồi tố |
| Gate Slice −1 | “dọn xong 22 slot phí + 2 slot công tơ” | **“ghi nhận đủ 22 + 2 + 3 + 3 ô vào conflict ledger, không sửa phiếu nào”** |

**Vì sao một claim `CONFLICT` cho cả ô, không phải hai claim:** partial unique BASE index phủ
`NORMAL|EXCEPTION|EXTERNAL|LEGACY|CONFLICT`, nên hai claim active trên cùng `base_slot_key` là bất khả.
Ô có n phiếu ⇒ một hàng `CONFLICT` mang mảng n voucher id + lý do. Đó đúng nghĩa “ghi nhận”.

**Cái KHÔNG đổi:** ô đã ghi nhận `CONFLICT` thì **không cho chi mới** trên ô đó cho tới khi chủ giải
quyết — đây là chặn phiếu mới, không phải sửa phiếu cũ, nên hợp với quyết định. Không có nó thì phiếu
thứ 46 vẫn sinh ra được.

### 1bis.2 Việc kế toán, nằm ngoài phạm vi code

Bốn cặp **cùng số tiền** (nghi chi hai lần thật, **tổng phơi nhiễm 164.500.000đ**) vẫn cần người đối
chiếu sao kê/biên nhận chủ toà. Chủ đã quyết **không đụng vào bản ghi**, nên nếu kết luận là chi trùng
thì xử lý bằng **nghiệp vụ ngoài hệ thống** (thu hồi/cấn trừ kỳ sau), hoặc chủ ra quyết định riêng sau.
Code không tự làm gì:

| Toà | Loại | Kỳ | Số tiền | Ghi chú |
|---|---|---|---:|---|
| 102LVT | tiền nhà | 06/2026 | `66.000.000` ×2 | `PC2606046` + `PC2606047`, cùng người tạo, cách **460 ms** — bằng chứng double-submit rõ nhất |
| 405PVB | tiền nhà | 07/2026 | `52.500.000` ×2 | 1 định kỳ + 1 tay |
| 32PVC | tiền nhà | 07/2026 | `26.000.000` ×2 | 1 tay + 1 định kỳ |
| 15KV | tiền nhà | 07/2026 | `20.000.000` ×2 | 1 định kỳ + 1 tay |

Một ô trong 22 ô **không phải trùng thật**: `Kho Văn Phòng Chung / quan_ly / 07/2026` là hai phiếu
**lương** (`13.930.046` + `20.276.698` = `34.206.744đ`) bị matcher `LIKE '%quan ly%'` đọc thành phí
quản lý. Vá §4.3 là ô này tự biến mất — không cần chủ quyết gì.

## 1ter. Ba quyết định của chủ — 30/07/2026 (chốt, thay mọi giả định trước đó)

### 1ter.1 KPI “Đã hoàn cọc” = tiền THẬT đã ra khỏi két

**Chốt: `28.039.100đ / 10 phiếu`** — gồm **cả** phiếu hoàn không nối được hồ sơ thanh lý.

Lý do bác phương án “chỉ lấy phần nối được hồ sơ” (`4.302.000đ / 2`): nó khớp bảng nhưng **khai
thiếu `23.737.100đ`** tiền đã chi thật, tức chỉ đổi lỗi *khai thừa* hôm nay thành lỗi *khai thiếu*.

Đối chiếu bắt buộc (đã đo lại 30/07, khớp tuyệt đối):

```text
refund_linked_total          4.302.000đ   /  2 phiếu   (nối được hồ sơ thanh lý → khớp bảng)
refund_posted_orphan_total  23.737.100đ   /  8 phiếu   (đã ghi sổ, KHÔNG có hồ sơ thanh lý)
──────────────────────────────────────────────────────
refund_total                28.039.100đ   / 10 phiếu   ← KPI
```

**UI bắt buộc** hiện dòng cảnh báo cho phần `orphan`, nếu không KPI lại lệch bảng lần nữa —
lần này theo chiều ngược. Đây là phát hiện MỚI, không có trong bản 29/07: **16/20 phiếu hoàn của org
thật không nối được hồ sơ thanh lý**, 8 trong số đó đã ghi sổ.

### 1ter.2 Ngưỡng tự duyệt: KHÔNG áp cho trang `/thanh-toan`

Nguyên văn chủ: *“với các phiếu chi qua page thanh-toan thì auto duyệt chỉ khoá với các rule kèm theo,
còn các phiếu chi ở bên ngoài page thu-chi giữ nguyên logic hiện tại đang có.”*

Ngữ nghĩa đúng — **bản 30/07 trước đó hiểu sai** và coi ngưỡng `600.000đ` là mâu thuẫn phải hoà giải:

| Đường đi | Cổng chặn tự duyệt | Ngưỡng `ie_auto_approve_config` |
|---|---|---|
| Nút chi đặc biệt trên `/thanh-toan` | **Chỉ các rule của chính hạng mục đó** (đúng giá công bố, ô còn trống, đủ giãn cách, đủ điều kiện hoa hồng…) | **KHÔNG áp** |
| Phiếu tạo tay ở `/thu-chi` và mọi nơi khác | Giữ nguyên hiện trạng | **Vẫn áp** |

**Hệ quả về thứ tự — điều tôi KHÔNG làm ở Đợt −1 và lý do:** hôm nay **chưa có rule engine**. Nếu gỡ
ngưỡng khỏi `pay_utility_bill` ngay bây giờ thì phiếu điện nước sẽ auto-duyệt **không qua bất kỳ cổng
nào** — lỏng hơn hiện tại, và ngược đúng ý chủ (“chỉ khoá với các rule kèm theo”). Vì vậy:

- **Đợt −1 giữ nguyên ngưỡng**, chỉ làm phiếu chờ duyệt **hiện ra** để hết bấm trùng (§−1.1).
- **Đợt 5 mới gỡ ngưỡng cho riêng đường `/thanh-toan`**, đúng lúc rule engine thay thế nó.
- Miễn ngưỡng phải **scope theo đường ghi**, không phải theo tổ chức — `/thu-chi` không được ảnh hưởng.

### 1ter.3 “Chủ sở hữu” = theo TÊN VAI TRÒ (giữ nguyên hiện trạng)

**Chốt: dùng `app_private.is_org_owner_v1`** (nhận diện vai trò tên `Chủ sở hữu tổ chức`).
Không đổi `member_type`, không ai mất quyền, DEMO không phải cấp lại.

**Nợ kỹ thuật bắt buộc trả kèm:** `organization_roles.name` là text tự do, nên **đổi tên vai trò trong
Cài đặt sẽ âm thầm làm sập cửa chủ sở hữu** ở mọi nơi dựng trên helper này. Đợt −1 phải thêm khoá
chống đổi tên/xoá vai trò đó (§−1.10). Không có khoá này thì lựa chọn “theo tên vai trò” là một quả
mìn hẹn giờ, không phải một quyết định ổn định.

## 2. Quan hệ với bản 29/07

Bằng chứng hiện trạng: xem `2026-07-30-thu-tien-state-of-world.md`. Ở đây chỉ ghi **quan hệ**.

### 2.1 Giữ nguyên (carry over unchanged)

- Toàn bộ **§3 Yêu cầu nghiệp vụ đã khóa** — vẫn là ý chủ, xem §3 bản này để biết chướng ngại mới.
- Kiến trúc §6: một shared submit context; writer tạo voucher nội bộ rồi gọi **dedicated** posting
  adapter; Plan 2 dùng obligation ledger + sticky marker; `/thu-chi`, `/income-expense`, contract page,
  import, Copilot giữ nguyên approval/posting.
- Bác bỏ `apply-sql.mjs --dry-run` (script hard-code production ref — đã xác minh lại).
- Ánh xạ `CANONICAL→ON`, `FROZEN→force_freeze`, `CANARY→CANARY + canary org + caps`.
- Bác bỏ `invoice_refund_reservations` cho hoàn cọc (`invoice_id NOT NULL`, cap theo `invoices.paid_amount`).
- Bác bỏ `contract_terminations.refund_amount` làm exact due (GENERATED, có thể âm, min **−10.590.180,64**).
- Bác bỏ amount tolerance cho phí cố định; bác bỏ claim bảo trì lifetime-unique; bác bỏ ordinal tự động `#2/#3`.
- Bác bỏ `CURRENT_DATE` → `app_private.org_today_v1`.
- Bác bỏ backfill bằng matcher tên chung.
- Bác bỏ `public.notifications` cho snapshot nhạy cảm.
- Giữ `public.can_create_restricted_ie()` nguyên vẹn (md5 `90ad1994a07546d11c18c368ab2b3bb8`, là gate
  server thật tại `pay_period_fee:50-52`, nằm trong `scripts/definer-acl-baseline.json:16`).
- Global lock order duy nhất (§6.3) — giữ, có bổ sung một quy tắc chặn trước (§6.2 invariant 8).

### 2.2 BỎ (nhắm vào vấn đề không tồn tại)

| Hạng mục 29/07 | Vì sao bỏ |
|---|---|
| Forward-correct scoped read contract của `thu_tien.view` (§4.1, §5 dòng CRITICAL cuối; Plan 1 Task 0 Step 3d) | Catalog live: `required_dimensions=[]`, `requires_cashbook_possession=false`, `scope_match_mode=ANY_MATCH`. `required_dimensions` trong catalog này chỉ nhận `BUILDING` hoặc `CASHBOOK` ⇒ lệnh "đổi thành organization/area/building" **không biểu diễn được**. Thực thi đúng chữ sẽ vô hiệu **24 cạnh ALLOW** đang sống |
| Digest-check + forward-define `ensure_income_expense_type_v1` / `normalize_income_expense_type_name` (§6; Plan 1 §1.2, Task 0 Step 2) | Cả hai có defining migration tracked `20260728180000:13` và `:792`, signature 12 tham số khớp live. Nhánh "absent trên clone là hợp lệ" **không bao giờ chạy** |
| Registry technical SERVICE membership + `check-technical-membership-isolation.mjs` + sửa hàng loạt selector, như một deliverable của Slice 0 (§5, §6, §8) | Chỉ có **1** superadmin và **2** org; superadmin đó có membership ACTIVE hợp lệ ở **cả hai** org ⇒ nhánh provision **không tới được** trên dữ liệu hiện tại. Giữ lại: một preflight ghi rõ nhánh này là dead-on-current-data, và câu §147 phải viết ở thể điều kiện |
| "Task 0 sửa `ThuTien.tsx` để chỉ mount đúng surface theo breakpoint" (§5 dòng "Không sửa double mount") **như đặc tả** | Hai chuyện: file sai (surface đã chuyển sang `/thanh-toan`), và **thiết kế sản phẩm là chủ ý** — `thu-tien.css:439-444` hiện cả hai cột ở ≥1024px và `.e2e-fleet/specs/thanh-toan-page.spec.ts:20/:27/:32` **assert cả hai cùng render**. Thực thi Step 4 làm spec đó đỏ ⇒ chặn chính gate Slice 0 |
| "Broker phải tạo unique index một-phiếu-một-hợp-đồng" (hàm ý ở §3/§5) | `uq_ie_commission_per_contract` **đã tồn tại** + advisory lock + pre-check `P0001` trong `create_commission_voucher`. **Cấm DROP/REPLACE index này** |

### 2.3 SỬA (ý đúng, đích sai) — retarget

| Hạng mục 29/07 | Đích mới |
|---|---|
| Mọi "Modify `src/pages/ThuTien.tsx`" | **`src/pages/ThanhToan.tsx`**. `ThuTien.tsx` (406 dòng) không còn `PeriodFeePanel/PeriodFeeSheet/usePeriodFees/useUtilityBills/useCommissionVoucher/useMaintenanceBatch`; `:258-259` chỉ `navigate('/thanh-toan')`. `/thanh-toan` gác bằng `thu_tien.**collect**` (`App.tsx:367`), `/thu-tien` bằng `thu_tien.view` (`App.tsx:363`) |
| `UtilityDesktopPanel.tsx`, `UtilityBillSheet.tsx` | **Dead code, 0 importer.** Surface EN thật là `UtilityEnContent.tsx` (import duy nhất tại `PeriodFeePanel.tsx:37`, render `:503-505`) và khối EN inline của `PeriodFeeSheet.tsx` |
| Danh sách defining migration của `resolve_fixed_expense_type/fee_type_matches/get_period_fee_status` | Bản canonical cuối là `20260728180000:944-1025`, **không phải** `20260708130100`. Thêm `20260710120100_pay_update_cancel_v2.sql`. Copy body từ bản 0708 sẽ **revert** canonicalization 28/07 (mất org-scope, mất `p_is_restricted` cho `quan_ly`) |
| Owner helper mới (`special_fee_is_owner_or_superadmin_v1`, `useIsOrgOwner.ts`) | **EXTEND** `app_private.is_org_owner_v1` (đã kiểm cửa sổ hiệu lực của cả membership lẫn role_binding) + thêm `organizations.status='ACTIVE'` mà nó thiếu + bọc nhánh `is_super_admin()`. Và phải **chốt một định nghĩa duy nhất**: hàm live nhận diện owner bằng `organization_roles.name='Chủ sở hữu tổ chức'`, plan đòi `member_type='OWNER'`; ở DEMO hai định nghĩa lệch **2/3 người**, ở org thật trùng nhau |
| `finance_v2_is_cashbook_period_open` là gate kỳ duy nhất (§6 invariant 13) | Dùng `app_private.cashbook_closed_through_v1` cho pre-check trước-khi-có-voucher và `app_private.assert_period_open_for_edit_v1` khi đã có voucher (ba code `[CASHBOOK_CLOSED]/[HANDOVER_LOCKED]/[PROFIT_LOCKED]`). Hàm cũ **chỉ đọc `accounts.lock_date`**, mà **0 account** có `lock_date` ⇒ hôm nay nó là no-op tuyệt đối |
| "DOM dùng Playwright, không thêm testing-library" (§5) | Tiền đề đúng, kết luận sai: repo **đã có** harness render trong environment `node` — `renderToStaticMarkup`, 15 file dùng, mẫu chuẩn `BuildingFilterSelect.test.tsx:19-27`. Playwright chỉ cho luồng đa bước và upload thật |
| Release adapter "bao phủ mọi terminal writer đã xác minh" (§3, §5) | Thêm **hai** writer public mới ship 30/07: `public.cancel_income_expense_flex_v1` (`20260730140000:119`, GRANT authenticated — **đường huỷ mặc định của `/thu-chi` sau Đợt 5**) và `public.reverse_invoice_collection_v5` (`20260730150000:460`). `app_private.cancel_collection_voucher_in_place_v1` là helper private (`postgres=X`) — không nợ coverage. Và **đẩy trigger backstop từ "backstop" lên "cơ chế chính"**, vì mặt cắt này nhận 4 migration huỷ trong một ngày |
| "Seed một dòng `finance_flow_owner_adapters` + test unknown-owner fail-closed là đủ" (§6) | `dispatch_finance_decision_v2` route theo **`adapter_name`**, qua một `CASE` **năm nhánh đóng**, `ELSE` ném `0A000`. Bộ đã nối đúng bằng `{INVOICE_REFUND, PROFIT_PAYOUT, TERMINATION_FORFEIT_PAIR, TERMINATION_MOVE_OUT_PAIR, SALARY_BUNDLE}`. Lỗi này **đã hiện thực hoá trên prod** cho `flow_owner='UTILITY_RECURRING'` (adapter `CANONICAL_INCOME_EXPENSE` → `ELSE` → `0A000`) |
| Bảo trì "101 voucher / 11 tên" (§3, backfill sizing) | **200 voucher / 31 tên / 80.289.556đ** cho cả họ `nrm_vn(category) LIKE 'bao tri%'` (plan 29/07 ghi 101/11 — số đo lại 30/07 là 200/31). 101/11/42.333.000đ chỉ là category "Bảo Trì Máy Lạnh". Ghi rõ Bảo Trì Toà Nhà (85), Tủ Lạnh (6), máy bơm (1) **ngoài phạm vi theo thiết kế** |
| `repeat_due = 77` "recurring children đang due" (§4.3) | 77 dòng đó là **parent schedule**, không phải child (`repeat_parent_id IS NULL` cả 77). 76/77 APPROVED, 76/77 khớp một fixed kind, 64/77 `repeat_auto_approve=true`. Riêng child: **155 child sống, 155/155 đáp xuống một slot fixed-kind** (plan 29/07 ghi 146 child posted — số đo lại 30/07 là 155 child sống). Idempotency key phải là `(parent_id, target_month)`, không phải child id |
| "Hai termination writer" (§5) | **Ba.** `terminate_contract_forfeit_impl` là writer thứ ba tạo dòng `contract_terminations` (26/37 dòng), audit insert bị nuốt tại `:262-263`. Nó **không** sinh phiếu hoàn (chỉ cặp offset EXPENSE + revenue INCOME) nên không nợ obligation — nhưng nợ attribution |
| `/deposits` chỉ sửa `useDepositDashboard.ts` + `DepositsPage.tsx` | Thêm **`public.get_refund_forfeit_summary(uuid[])`** — hàm SQL SECURITY **INVOKER** nuôi ô KPI đầu trang, cộng `GREATEST(0, refund_amount)` trên **mọi** termination non-FORFEIT, không lọc status, không lọc posting (đếm cả DRAFT/PENDING_APPROVAL là "lần") |
| Thứ tự migration canonical (§7) | Đánh số lại toàn bộ 16 file sang `20260731xxxxxx` — xem §8 |
| Bảng gate §8 | Thêm `check-stable-fn-locks.mjs`, `check-permission-catalog.mjs`; bỏ/đổi tên phần không tồn tại — xem §9 |

## 3. Yêu cầu nghiệp vụ đã khóa

Bảng của bản 29/07 giữ nguyên cột luật (vẫn là ý chủ), thêm cột **chướng ngại mới phát hiện 30/07**.

| Phạm vi | Quy tắc cuối cùng (giữ) | Chướng ngại mới đo được 30/07 |
|---|---|---|
| Ranh giới | Chỉ nút check của mục đặc biệt trên trang đóng tiền được auto duyệt/auto chi | Trang đó là **`/thanh-toan`** (gác `thu_tien.collect`), không phải `/thu-tien`. Mọi entry mới thêm vào `FEE_CATEGORIES` chỉ render trong `PeriodFeePanel/PeriodFeeSheet`, tức **sau** `collect` — xung đột với §3.3 Plan 2 đặt queue/lifecycle ở mức `thu_tien.view` |
| Quyền cấu hình/ngoại lệ | Chỉ chủ sở hữu org và superadmin; superadmin cao nhất | Hai định nghĩa "chủ" đang cùng sống: `is_org_owner_v1` (theo **tên vai trò** tiếng Việt) vs plan (`member_type='OWNER'`). DEMO: 3 role-owner vs 1 member_type-owner ⇒ `demo.quanly` (STAFF) hiện được `/thu-chi` coi là chủ nhưng sẽ bị `/thanh-toan` từ chối, và E2E chạy bằng `demo.quanly` sẽ đỏ không rõ nguyên nhân. Đổi tên vai trò trong Cài đặt = tự sập cửa chủ ở nhiều nơi |
| Phí cố định | 7 loại; mỗi toà × loại × tháng một slot; version theo `effective_from_month`; so tiền chính xác sau normalize 2 chữ số | **22 slot đã vi phạm sẵn** (45 phiếu, worst 3 = 108.400.000đ), 13 slot thuộc 07/2026 ⇒ **partial unique index không tạo được** trước khi dọn. Thêm 3 phiếu `quan_ly` toà `cb6592d8…` có item **NULL start/end date** ⇒ vô hình với cả reader lẫn guard. Và `building_fee_accounts.default_amount` **không phải cấu hình**: `pay_period_fee` ghi đè nó bằng `round(p_amount/months)` mỗi lần chi ⇒ import nó thành DRAFT rule là **tự khớp chính mình** |
| Hồi tố | Đổi giá phải chọn "áp dụng từ tháng"; không sửa kỳ/voucher/snapshot cũ | `20260730240000_authz_remaining.sql:429-457` (untracked, chưa apply) mở rộng vị ngữ kỳ sang **kỳ dịch vụ của hạng mục** ⇒ phiếu có item thuộc tháng đã chốt lợi nhuận **không sửa/huỷ được**. 18 toà đã chốt 05/2026 |
| Trả trước | Chỉ Internet, Công an, Rác, Thang máy; một phiếu con mỗi tháng; batch all-or-nothing | Chính vị ngữ trên: một child trả trước cho tháng đã chốt **không huỷ được vĩnh viễn** ⇒ slot bị chiếm mãi, phá đúng lời hứa của Plan 1. Phải quyết một trong ba: child đặt `business_result_accounting=false`, hoặc không đặt item period cho tháng quá khứ, hoặc đường release claim không đi qua vị ngữ đó |
| Điện/nước | Mỗi đồng hồ × loại × tháng một phiếu; cảnh báo theo toà × loại; vượt mốc vẫn `APPROVED + POSTED`, alert snapshot | **Xung đột trực diện với quyết định của chủ ngày 29/07**: `ie_auto_approve_config` của org thật hạ ngưỡng xuống **600.000đ** lúc `2026-07-29T09:39:56Z`, và `pay_utility_bill` **tôn trọng ngưỡng đó** (`pay_period_fee` thì hardcode `'APPROVED'` — bất đối xứng). 64/72 hoá đơn EN sống ≥ 600k. Plan **không có ô trạng thái** "đúng rule nhưng phải chờ duyệt" ⇒ hoặc writer mới phá quy tắc duyệt tay của chủ, hoặc assert `POSTED` in-transaction rollback và nút chết. **Cần chủ quyết lại trước Slice 1** |
| Hoa hồng môi giới | Một lần/HĐ; chỉ hiện check khi HĐ còn hiệu lực, thực thu đủ cọc, đã qua `start_date + 7 ngày`; hard block không proposal | Index một-phiếu-một-HĐ **đã có** ⇒ bỏ task tạo index, chỉ còn dọn **2 HĐ** đang có 2 phiếu broker APPROVED. Bậc hoa hồng: 21/21 toà đã khai và **21/21 đều hở** (chỉ phủ 5–6 và 10–12 tháng). `get_period_commissions` **đã có fallback ngầm 50%** trong khi `useCommissionVoucher.ts:46-48` trả 0đ ⇒ import DRAFT không `fallback_policy` sẽ **âm thầm đổi số đang hiển thị** cho 22 HĐ ở 7–9 tháng. Thêm 48 HĐ ở 13–17 tháng ngoài vùng phủ ⇒ `fallback_policy` là load-bearing, không phải trang trí |
| Thưởng nóng Sale | Phiếu riêng, gộp UI "Hoa Hồng & Thưởng Sale"; chỉ trần + một slot/HĐ | **Không phải "chuyển", mà là làm mới hoàn toàn.** `PeriodCommissionModal.tsx:76` chỉ truyền `kind:'broker'`, không có nhánh Sale; 7 phiếu thưởng Sale hiện có đều sinh từ **trang hợp đồng**. Nguồn dữ liệu, tab, trần, báo cáo đều mới ⇒ phải tính lại effort |
| Bảo trì máy lạnh | Theo phòng, tối đa một lần trong rolling 5 tháng, advisory lock | **Chiều "phòng" chưa tồn tại**: `MaintenanceBatchLine` chỉ có `{buildingId, subtype, amount}`, `get_period_maintenance` trả building/subtype không room. 13/101 phiếu AC không có room (77 phiếu org thật trên cả họ bảo trì không có room). **23 phiếu đã vi phạm chính luật 5 tháng.** Và `useMaintenanceBatch.ts:36-46` **INSERT thẳng vào `income_expense_types` từ browser** — phải bỏ trước |
| Bảo trì máy giặt | Theo toà, tối đa một lần trong rolling 6 tháng | Chỉ **7 phiếu / 2 tên / 2.850.000đ**, 0 ca trùng ⇒ không có dữ liệu thật để hồi quy luật; **hạ ưu tiên** so với máy lạnh |
| Giá bảo trì | ≤ chuẩn bình thường; > chuẩn ≤ trần là warning vẫn post; > trần hoặc vi phạm cadence là exception | Bảng ánh xạ chủ phải duyệt là **200 phiếu / 31 tên**, không phải 101/11 |
| Ngoại lệ | Không phải phiếu chi; chủ/superadmin duyệt mới sinh phiếu posted; proposal immutable, TTL/reason | Cơ chế này chưa có; định nghĩa "chủ" chưa chốt (dòng trên). `[NOT_MANUAL]` của `assert_manual_voucher_v1` sẽ chặn flex-cancel mọi phiếu có `system_source` — đây là **fail-closed mong muốn** nhưng phải assert tường minh |
| Hoàn cọc | Queue chỉ hoàn tất số canonical do settlement emitter sinh; manager không nhập amount | Không có **một** ca "hoàn cọc đúng và đã trả tiền" trên prod để làm mốc: org thật có đúng 3 termination `refund_amount > 0`, **2/3 lệch số** (−978.500 và **+500.000** — ca +500.000 vắng khỏi cả ba plan doc), ca thứ ba khớp nhưng **UNAPPROVED/UNPOSTED**. Gate "exact hash/amount" phải seed từ fixture DEMO tự dựng |
| Hủy/reversal | Giải phóng hoặc chuyển claim đúng trạng thái, mọi terminal writer, không hard delete | Thêm 2 writer (§2.3). Và `cancel_period_fee` hôm nay nhận **mọi** phiếu EXPENSE có item khớp matcher (không chỉ `fixed_fee/utility.bill`) rồi `UPDATE … deleted_at` **không token** ⇒ 9 phiếu flow-owned đang mắc bẫy `55000`, gồm **1 phiếu thật `PC2607096`** đang hiện nút Huỷ bật sáng |
| Chu trình phòng | Read model chỉ đọc; ưu tiên source snapshot; phân đoạn theo move-out/move-in; thiếu/ambiguous không fallback current room | Có **đường đổi phòng thứ hai** chưa ai biết: trigger `apply_contract_transfer` (DRAFT→APPROVED) ghi đè `room_id, rent_price, total_deposit` **và `start_date/end_date`**, đặt `status='TRANSFERRED'`. Plan chỉ đọc transfer `COMPLETED` ⇒ bỏ sạch đường này; và giả định "`contracts.start_date` là mốc đoạn đầu" **sai** vì chính cột đó bị ghi đè. Hiện 0 dòng đi đường này nhưng RLS cho phép |

Ba câu bổ nghĩa của bản 29/07 giữ nguyên: (a) "giữ logic cũ ngoài trang đóng tiền" = không mở
auto-approve/auto-post và không đổi permission của ordinary voucher; (b) refund voucher canonical là
system-owned monetary artifact nên amount/items read-only ở mọi page; (c) với trả trước, **kỳ phí**
và **ngày ghi sổ** là hai khái niệm khác nhau.

Một ngoại lệ **mới** phải ghi vào (b): Đợt 2 đã ship năng lực ANNOTATE. Nhánh ANNOTATE của
`guard_income_expense_owned_payload` fire cho **mọi** `flow_kind` và trả `NEW` khi chỉ
`attachments/notes/updated_at` đổi; `public.annotate_income_expense_v1` là DEFINER, GRANT
`authenticated`, **không đọc** `income_expense_flow_ownership`. Vì vậy một kế toán **vẫn dán được ảnh
chứng từ vào phiếu hoàn cọc system-owned đã POSTED**. Plan 2 `:168` đòi freeze `attachments` ⇒ phải
chọn: loại `attachments/notes` khỏi bộ đông cứng và khỏi header hash, **hoặc** xin chủ carve-out
flow-owned refund voucher khỏi quyết định số 8. Hiện plan không làm gì cả.

## 4. Slice −1 (mới) — tầng khuyết tật đang sống

**Đây là quyết định biên tập không thương lượng.** Chín khuyết tật dưới đây độc lập với cả hai plan,
đang làm mất hoặc khai sai tiền. Chúng đứng **trước** mọi thứ vì (i) tiền đang chảy sai, và (ii) ba
trong số chúng làm gate của chính hai plan bất khả thi.

Không migration nào của Slice −1 được thêm feature surface mới. Mỗi hạng mục có gate riêng.

### −1.1 `pay_utility_bill`: phiếu điện/nước vô hình + không có chống trùng nào

- **Sai gì.** `pay_utility_bill` đọc `app_private.ie_auto_approve_config` và sinh
  `approval_status='UNAPPROVED'` (`approved_by/approved_at` NULL) khi `p_amount >= threshold`. Bảng
  điện/nước lại **chỉ đọc APPROVED** (`useUtilityBills.ts:304 .eq('approval_status','APPROVED')`;
  `:370-371 paidThisKy` chỉ đọc map đó). Ngưỡng org thật đã hạ xuống **600.000đ** lúc
  `2026-07-29T09:39:56Z` (`updated_by 90450d5f`), trong khi **64/72** hoá đơn EN sống ≥ 600k. Và
  `pay_utility_bill` **không có bất kỳ kiểm tra trùng nào** — mỗi lần bấm là một phiếu 6–15 triệu mới.
- **Bằng chứng.** Body `:72-79 → :99`. `pay_period_fee:132` thì hardcode `'APPROVED'` (bất đối xứng).
  Bug **đã lên nòng, chưa nổ ở org thật**: `max(created_at)` của `system_source='utility.bill'` =
  `2026-07-22T09:33:17Z`, tức trước khi hạ ngưỡng; 0 phiếu EN tạo sau `2026-07-29 09:39:56`; 0 phiếu
  EN `UNAPPROVED` sống. Nhánh này **đã nổ một lần ở DEMO**: `PC2607039`, 8.000.000 ≥ ngưỡng DEMO
  5.000.000, `UNAPPROVED`, tạo và soft-delete cùng lúc `2026-07-20T01:29:33/34Z` (fixture E2E).
- **Sửa nhỏ nhất an toàn.** (a) Reader hiện cả `UNAPPROVED`, nhãn **"Chờ duyệt"**, và `paidThisKy`
  coi UNAPPROVED là "đã có phiếu" (không phải "đã đóng"); (b) thêm chốt chống trùng cấp DB theo
  `(utility_account_id, utility_type, billing_month)` cho phiếu non-cancelled, dọn 2 slot đang vi phạm
  trước; (c) **không** đổi hành vi ngưỡng trong Slice −1 — đó là quyết định của chủ, đưa lên §3.
- **Gate.** Query live: 0 phiếu `utility.bill` non-cancelled trùng khoá trên; test hai-session bấm
  check hai lần trên cùng công tơ/tháng ⇒ lần hai bị từ chối bằng lỗi nghiệp vụ (không phải 23505 trần);
  spec Playwright khẳng định dòng có phiếu UNAPPROVED **không** còn hiện "chưa đóng".
- **Chặn gì của plan.** Chặn Plan 1 Task 3–5: không thể xây unique index per-meter khi 2 slot đang
  vi phạm, và không thể assert `VALID → APPROVED+POSTED` khi ngưỡng chủ đang bắt chờ duyệt.

### −1.2 Batch bảo trì: cùng hình dạng "ghi vô hình → mời tạo lại"

- **Sai gì.** `ie_compat_insert_v2` **cưỡng chế** `approval_status='UNAPPROVED'`, bất kể số tiền hay
  ngưỡng; `get_period_maintenance` lọc `approval_status='APPROVED'`. Tạo batch xong, tab Bảo trì vẫn
  render `'Kỳ này chưa có phiếu bảo trì.'` (`PeriodFeeSheet.tsx:525`), mời người dùng tạo lại. **Không
  unique constraint, không cadence, không chiều phòng.**
- **Bằng chứng.** Body `ie_compat_insert_v2` (`v_clean := … 'approval_status','UNAPPROVED' …`, return
  `{'approval_status':'UNAPPROVED'}`); đường insert duy nhất `src/hooks/income-expenses/batch.ts:144-190`,
  không có bước approve trước `:220`. Live: 91 phiếu bảo trì APPROVED+POSTED, 3 CANCELLED,
  **0 UNAPPROVED và 0 batch child UNAPPROVED** ⇒ UI batch chưa được dùng lần nào kể từ khi compat
  writer lên.
- **Sửa nhỏ nhất an toàn.** (a) `get_period_maintenance` trả cả UNAPPROVED với cột trạng thái;
  (b) bỏ `INSERT income_expense_types` phía browser (`useMaintenanceBatch.ts:36-46`) — chuyển vào
  RPC; (c) chưa thêm chiều phòng ở Slice −1, chỉ ghi nợ.
- **Gate.** Vitest: reader trả đúng 1 dòng cho batch UNAPPROVED vừa tạo; grep = 0 lời gọi
  `from('income_expense_types').insert` trong `src/`.
- **Chặn gì.** Chặn Plan 1 Task 1–4 (luật cadence AC/washer) vì chiều phòng và bộ đếm chưa có chỗ neo.

### −1.3 `fee_type_matches` khớp sai: 34.206.744đ tiền lương nằm trong ô "Quản Lý"

- **Sai gì.** `fee_type_matches('quan_ly', …)` là `nrm_vn(name) LIKE '%quan ly%'` ⇒ khớp luôn
  `'Lương quản lý'` và `'Ứng lương quản lý'`. `get_period_fee_status` join **mọi** type khớp, không
  dedupe, không LIMIT ⇒ **2 phiếu lương 34.206.744đ (org thật) được cộng vào ô phí Quản Lý**; DEMO có
  3 phiếu `'Lương quản lý'` 1.100.000đ. Tệ hơn: **DEMO không có type `'Quản Lý'` nào** ⇒
  `resolve_fixed_expense_type('quan_ly')` (order `is_default DESC, created_at, id LIMIT 1`, mọi dòng
  `is_default=false`) sẽ **ghi một khoản chi Quản Lý vào type tiền lương**.
- **Bằng chứng.** CTE `typed` của `get_period_fee_status:41-48`. Cùng lớp lỗi: `dien` khớp
  `'Mua tủ lạnh'` cat `'Điện'` (1 phiếu 3.424.000đ) và `'thanh toán tiền điện lạnh '` cat
  `'Bảo Trì Máy Lạnh'` (chính họ AIR_CONDITIONER của Plan 1); `ve_sinh` khớp `'Vệ Sinh Phòng'`
  (620.000đ) + `'BTaskee'` (300.000đ); `rac` khớp `'Rửa thùng rác'` (60.000đ) + `'Bỏ rác'`
  (3 phiếu 300.000đ). **5 phiếu `system_source='salary.staff'` đang được báo là `quan_ly` đã đóng.**
  ⚠ Số tiền của chính type `'Quản Lý'` (43 phiếu) **chưa hoà giải**: một phép đo cho 18.500.000đ, một
  cho 90.500.000đ — chênh ~5× đúng bằng dấu hiệu của khuyết tật §−1.4. Phải đo lại **một query**
  (`SUM(items.amount)` vs `SUM(ie.total_amount)`) trước khi viết backfill. Con số load-bearing
  34.206.744đ thì **cả hai phép đo đồng ý**.
- **Sửa nhỏ nhất an toàn.** Không sửa `fee_type_matches` (IMMUTABLE, có `=X` cho PUBLIC, nhiều nơi
  dùng). Thay vào đó: bảng ánh xạ `income_expense_type_id → special_fee_kind` **do chủ duyệt** áp cho
  **cả read model**, không chỉ backfill; trong lúc chờ chủ duyệt thì loại tường minh các
  `category IN ('Lương', …)` và `system_source LIKE 'salary.%'` khỏi read model.
- **Gate.** Parity test âm: không type lương/giặt ủi/mua sắm nào vào được slot phí cố định. Báo cáo
  trước/sau theo org cho từng ô, chủ ký nhận **con số giảm** (đừng để chủ đối chiếu "trước/sau khớp
  nhau" rồi hợp thức hoá số sai).
- **Chặn gì.** Chặn Plan 1 Task 6 (backfill claim) và Task 7 (read model): nếu read model mới derive
  từ read model cũ thì 38,6 triệu tiền-không-phải-phí sẽ được đóng dấu canonical.

### −1.4 `get_period_fee_status` cộng cả phiếu cho từng hạng mục ⇒ phiếu đa-hạng-mục đếm hai lần

- **Sai gì.** CTE `vperv` (`:49-79`) chọn `ie.total_amount AS amount` (**tổng cả phiếu**) rồi
  `GROUP BY (building, category, ie.id)`; `:84-85` `SUM(v.amount) FILTER (st='APPROVED')`.
- **Bằng chứng.** Phiếu `5916661a-66c2-4a7c-88f1-b90e27d62564` tên `'Tiền Điện + Tiền nước'`,
  `total_amount = 6.384.000`, hai item khớp `dien` 5.758.000 và `nuoc` 626.000 ⇒ nó góp
  **6.384.000 vào ô Điện VÀ 6.384.000 vào ô Nước**.
- **Sửa nhỏ nhất an toàn.** Cộng theo **tổng item khớp**, không phải `ie.total_amount`. Đồng thời xử
  lý 5 item APPROVED có `start_date/end_date` NULL — trong đó 3 phiếu `quan_ly` cùng toà `cb6592d8…`
  tạo một **slot trùng ba vô hình** với cả reader (`:76`) lẫn guard (`pay_period_fee:74`).
- **Gate.** Test trên đúng phiếu `5916661a`: ô Điện = 5.758.000, ô Nước = 626.000. Query live: 0 item
  APPROVED thuộc 7 kind có `start_date` hoặc `end_date` NULL (sau khi vá dữ liệu).
- **Chặn gì.** Chặn mọi gate "amount đúng tuyệt đối" của Plan 1: hôm nay chính con số đối chiếu đã sai.

### −1.5 Tự tạo công tơ trong im lặng ⇒ dòng đó không bao giờ hiện "đã đóng"

- **Sai gì.** `metersOf()` render một dòng tổng hợp với `accountId=null` cho mọi toà/loại chưa có
  công tơ. Bấm check gửi `p_utility_account_id=null`, nhánh ELSE của `pay_utility_bill`
  **INSERT một dòng `building_utility_accounts` mới**. Vì `paidThisKy` khoá theo meter id và trả
  `undefined` khi null, dòng đó **không bao giờ** hiện "đã đóng" trước refetch.
- **Bằng chứng.** `useUtilityPayState.ts:84-89` (`{key:'syn:…', accountId:null, isSynthetic:true}`),
  `:198 utilityAccountId: row.accountId`, `:370-371`. Live: **0** phiếu `utility.bill` có
  `utility_account_id` NULL ⇒ nhánh này **đã chạy và tự che dấu vết** (`idx_bua_building_type` không
  unique nên bảng cho phép nhiều công tơ).
- **Sửa nhỏ nhất an toàn.** RPC **từ chối** `p_utility_account_id IS NULL` (mã lỗi nghiệp vụ rõ);
  UI đổi dòng tổng hợp thành nút "Tạo công tơ" tường minh.
- **Gate.** Test âm: gọi `pay_utility_bill` với `p_utility_account_id => null` ⇒ raise; đếm
  `building_utility_accounts` trước/sau một lần bấm check = không đổi.

### −1.6 Hai bề mặt cùng hiện, cùng ghi được, cho cùng một slot — và `p_force` cách một cú click

- **Sai gì.** `/thanh-toan` ở ≥1024px mount **đồng thời** `PeriodFeePanel` và `PeriodFeeSheet`
  (`ThanhToan.tsx:53-70`, `thu-tien.css:439-444`), mỗi bên gọi `usePeriodFeeState` **độc lập** nên
  `amounts/bookSel/attach` là hai Record riêng. Chốt chống trùng của `pay_period_fee` chỉ chạy
  `IF NOT p_force`, **chỉ đếm phiếu APPROVED** (draft UNAPPROVED không cảnh báo gì), và nút xác nhận
  ghi thẳng chữ **"Đóng thêm"** (`PeriodFeeVoucherList.tsx:186-189`). Thêm: hai instance
  `usePersistedState` dùng chung một key `sessionStorage` **không sync chéo** ⇒ hai bề mặt trên cùng
  màn hình có thể đang hiện **hai hạng mục khác nhau**; `PeriodFeeSheet.tsx:96` mount
  `useUtilityPayState` **vô điều kiện** nên query + paste listener EN vẫn sống khi đang chọn hạng mục GRID.
- **Bằng chứng.** Đã hiện thực hoá trên prod: **22 slot phí cố định / 45 phiếu** (worst = toà
  `175f4329…`, `tien_nha`, 05/2026, 3 phiếu APPROVED = **108.400.000đ**; 13/22 slot thuộc **07/2026**);
  và các slot điện/nước trùng — ⚠ **cần đo lại một lần**: một phép đo cho **2** slot
  `(công tơ, loại, tháng)` + **3** slot `(toà, loại, tháng)` (toà `d76268b2…`, ELECTRIC, 05/06/07,
  slot tháng 07 nằm trên **hai công tơ khác nhau**), một phép đo khác cho **4 nhóm** (công tơ
  `02660728…`, 07/2026, 4 phiếu, 7.308.077đ). Hai con số chưa hoà giải; **hình dạng backfill phụ
  thuộc vào câu trả lời**.
- **Sửa nhỏ nhất an toàn (KHÔNG phải "bỏ một surface").** Giữ layout hai cột (đó là chủ ý và có spec
  `thanh-toan-page.spec.ts` bảo vệ). Thay vào đó: (a) **hoist state** — `usePeriodFeeState` /
  `useUtilityPayState` gọi **một lần** ở `ThanhToan.tsx` rồi truyền xuống, để `amounts/bookSel/attach`
  và bộ chọn hạng mục là **một nguồn duy nhất**; (b) `p_force` chỉ mở cho chủ/superadmin, và dialog
  phải hiện **danh sách phiếu đang có** kèm số tiền trước khi cho bấm; (c) chốt chống trùng đếm cả
  UNAPPROVED. **Đừng** đụng `useReceiptPasteTarget` — cơ chế arbitration cấp module ở `:27-31/:86-93`
  đã vá đúng bug 28/07 và có spec hồi quy; "sửa double-fire" là sửa một lỗi không tồn tại.
- **Gate.** `thanh-toan-page.spec.ts` và `utility-paste-receipt.spec.ts` **vẫn xanh** (đây là gate,
  không phải tuỳ chọn); test: đổi hạng mục ở một bề mặt ⇒ bề mặt kia đổi theo; hai lần submit cùng
  slot từ hai bề mặt ⇒ đúng một phiếu.
- **Chặn gì.** Chặn Plan 1 Task 2 (partial unique BASE index): index không tạo được trên 22 slot vi phạm.

### −1.7 `/deposits` báo "Đã hoàn" trước khi tiền ra khỏi két, và KPI nói số khác bảng

- **Sai gì.** `useDepositDashboard.ts:282` là nguyên văn
  `refund_done: !!t.refund_date || t.status === 'COMPLETED'`, dùng ở `DepositsPage.tsx:485`. Cả hai cờ
  đều do **cùng một lệnh** đặt: `approve_contract_termination_v1` chạy
  `update … set status='COMPLETED', refund_date = now()` **trước** khi INSERT phiếu, và phiếu đó ra
  `UNAPPROVED` với `account_id` NULL.
- **Bằng chứng.** Trong 11 termination dạng trả phòng, **7 dòng đang hiện tick xanh "Đã hoàn" mà
  KHÔNG có một phiếu chi nào được ghi sổ** (chính xác: phiếu **có** tồn tại nhưng **không POSTED** —
  `PC2607001` 50.000, `PC2607008` 40.000, `PC2607010` 30.000, tất cả UNAPPROVED/UNPOSTED,
  `account_id` NULL, item `accounting_class='PNL'` **xếp sai loại**), và **2 dòng hiện sai số**.
  Áp luật mới thì **9/11 dòng đổi trạng thái hoặc đổi số**. Hai HĐ DEMO `HD-2026-00015/00016` có
  refund **−2.241.000đ** (khách còn nợ) vẫn hiện tick xanh **"Đã hoàn 0đ"**.
  Ô KPI đầu trang: `get_refund_forfeit_summary` (SECURITY **INVOKER**, `STABLE`, không DEFINER) cộng
  `GREATEST(0, refund_amount)` trên **mọi** termination non-FORFEIT, không lọc status/posting, đếm cả
  DRAFT/PENDING_APPROVAL là "lần" ⇒ org thật hiện **8.290.000đ / 3 lần** trên một bảng mà số đúng
  (phiếu POSTED có item cọc) là **4.302.000đ / 2 dòng** ⇒ **thổi phồng 3.988.000đ**.
  (Con số 8.990.000đ / 11 lần là tổng **hai org qua service-role** — không người dùng nào thấy nó;
  phần DEMO là 700.000đ / 8 lần.)
  Thêm: cảnh báo "Phiếu thanh lý chờ xử lý" chỉ nhận ra **4/20** phiếu hoàn vì dò `notes LIKE`; và
  2 HĐ mang **2 phiếu hoàn cùng số tiền** (`2.797.000đ` ×2 trên HĐ `a1584980`, `3.127.400đ` ×2 trên
  HĐ `aa16a805`) ⇒ mọi reader correlate theo `contract_id` trả **2 dòng cho 1 termination**.
- **Sửa nhỏ nhất an toàn.** (a) `refund_done` derive từ **phiếu POSTED + active posting**, bỏ cả
  `refund_date` lẫn `COMPLETED`; (b) sửa **`get_refund_forfeit_summary`** cùng lúc (nếu không, KPI và
  bảng trên cùng một trang nói hai số); (c) số âm hiện **"Khách còn nợ"**, không phải "Đã hoàn 0đ";
  (d) bỏ matcher `notes LIKE` trong `useContractPendingTermination`.
- **Gate.** KPI = tổng cột của bảng, kiểm trên cả hai org; test cặp phiếu-trùng-số trả đúng 1 dòng/termination;
  test dòng refund âm hiện nhãn nợ.
- **Chặn gì.** Chặn Plan 2 Task 4 + Task 7: gate "Đã hoàn chỉ khi POSTED" của plan **pass mà trang
  vẫn sai**, vì Task 7 Step 6 không hề đọc KPI.

### −1.8 `useApproveTermination`: fallback client ghi vào một bảng KHÔNG TỒN TẠI, không transaction

- **Sai gì.** `src/hooks/useContracts.ts:1119` gọi `approve_contract_termination_v1`; `:1124` nếu là
  fallback signal thì **tiếp tục** bằng REST: `:1126-1135` UPDATE `contract_terminations` →
  `'APPROVED'`; `:1137-1145` UPDATE `contracts` → `'TERMINATED'`; `:1147-1155` UPDATE →
  `'COMPLETED'` + `refund_date`; `:1159-1177` **INSERT INTO `public.cash_book`**. `to_regclass('public.cash_book')`
  = **NULL**. Không transaction ⇒ khi bước cuối vỡ, hợp đồng đã TERMINATED và termination đã COMPLETED
  mà **không có phiếu tiền nào**.
- **Bằng chứng.** Hiện **0 call site** (grep chỉ khớp chính định nghĩa `:1101`), nhưng hàm còn export
  và policy còn cho: `contract_terminations_update_rbac` cmd=UPDATE, qual
  `is_super_admin() OR building_of_contract(contract_id) = ANY(app_private.buildings_for_v3('contracts.edit'))`.
  Ba phiếu DEMO ngày 18–19/07 **không truy được ai gọi**.
- **Sửa nhỏ nhất an toàn.** **Xoá** `useApproveTermination` / `usePendingTerminations` /
  `useRejectTermination` (cả ba đã `@deprecated`, 0 call site). Không sửa, không giữ.
- **Gate.** grep = 0 khớp ba identifier + 0 khớp `'cash_book'` trong `src/`; `npm run typecheck:baseline` xanh.

### −1.9 Ai có `contracts.edit` đều UPDATE được `contract_terminations` qua REST

- **Sai gì.** Policy trên cho phép sửa `outstanding_debt / total_deposit / early_termination_fee` ⇒
  đổi luôn `refund_amount` **GENERATED**; hoặc set `status='APPROVED'` để trigger
  `update_contract_on_termination_approved` tự đặt `contracts.status='TERMINATED'` — **không qua
  writer nào**. Không ràng buộc cột, không guard trigger nào chặn sửa input quyết toán sau COMPLETED
  (trigger duy nhất trên UPDATE là `auto_calculate_termination_financials`, chỉ điền khi NULL).
- **Bằng chứng.** `pg_policies` (đã dẫn ở −1.8) + `pg_get_triggerdef`. Đây là lý do "snapshot bất
  biến" của Plan 2 **không bảo vệ hàng nguồn**.
- **Sửa nhỏ nhất an toàn.** REVOKE UPDATE trên `contract_terminations` khỏi `authenticated` (theo
  đúng khuôn `20260730102000_money_tables_revoke_dml.sql`), chuyển mọi lối sửa hợp lệ về RPC. Nếu chủ
  chưa muốn REVOKE thì tối thiểu: guard trigger đông cứng các cột đầu vào quyết toán khi
  `status IN ('APPROVED','COMPLETED')`.
  ⚠ Ghi rõ trong plan: `20260730102000` phủ **bốn** bảng, **không** phủ `invoices`/`payments` — hai
  bảng đó vẫn GRANT `DELETE,INSERT,UPDATE` cho `authenticated`, và lá chắn duy nhất
  (`a00_invoice_derived_guard`) chỉ canh **một** cột `paid_amount`.
- **Gate.** `check-definer-acl.mjs` + một query ACL khẳng định `authenticated` không còn DML trên
  `contract_terminations`; test âm gọi REST UPDATE ⇒ 42501.

### 4.1 Cái gì trong Slice −1 là **điều kiện tồn tại** của plan

| Gate của plan | Bị chặn bởi | Vì sao không thể tồn tại trước |
|---|---|---|
| Partial unique BASE index (toà × kind × tháng) — Plan 1 Task 2 | −1.6 (+ −1.4 cho slot NULL-date) | **ĐÃ GIẢI QUYẾT bằng §1bis.1**: index đặt trên `special_fee_claims` (bảng mới, trống lúc tạo) nên tạo được; ô có ≥2 phiếu vào **một claim `CONFLICT`**. Vẫn phụ thuộc −1.6/−1.4 để **không sinh thêm** ô trùng mới, và để phiếu item NULL-date không vô hình với backfill |
| Unique index theo công tơ × loại × tháng — Plan 1 Task 3 | −1.1, −1.5 | 2 slot công tơ đang vi phạm; và nhánh tự-tạo-công-tơ sinh thêm khoá mới |
| Claim cadence AC/washer — Plan 1 Task 1–4 | −1.2 | Chưa có chiều phòng để neo; 23 phiếu AC đã vi phạm luật 5 tháng |
| "amount đúng tuyệt đối vs giá chủ công bố" — Plan 1 Task 3, 7 | −1.3, −1.4 | Số đối chiếu hôm nay đã sai (38,6tr lệch loại + 6,384tr đếm hai lần) |
| "`VALID → APPROVED + POSTED`" — Plan 1 Task 5 | −1.1 | Ngưỡng 600.000đ của chủ bắt EN chờ duyệt ⇒ assert in-transaction rollback |
| "`/deposits` Đã hoàn chỉ khi POSTED" — Plan 2 Task 4, 7 | −1.7 | KPI ngoài phạm vi plan sẽ tiếp tục nói số khác |
| "Snapshot bất biến" — Plan 2 Task 1–2 | −1.9 | Hàng nguồn sửa được qua REST bởi bất kỳ ai có `contracts.edit` |
| Bất kỳ queue hoàn cọc nào | −1.8 | Còn một writer thứ tư ngoài mô hình, ghi vào bảng không tồn tại |

## 5. Ma trận đánh giá và quyết định sửa

Ba cột verdict: **GIỮ** (quyết định 29/07 vẫn đúng) · **BỎ** (nhắm vào vấn đề không tồn tại) ·
**SỬA** (ý đúng, đích/tiền đề sai). `ID` là mã patch để truy về bằng chứng tổng hợp.

| ID | Quyết định 29/07 | Verdict | Căn cứ 30/07 và hành động |
|---|---|---|---|
| E13 | Forward-correct `thu_tien.view` không cần CASHBOOK (Task 0 Step 3d) | **BỎ** | `required_dimensions=[]`, `requires_cashbook_possession=false`, `ANY_MATCH`; catalog có 223 key, chỉ 9 key có `required_dimensions` khác rỗng và giá trị chỉ nhận `BUILDING|CASHBOOK`. Xoá Step 3d + test kèm, thay bằng **một assertion no-op**. Thêm sự thật quan trọng hơn: **không một trong 13 body legacy nào tham chiếu `thu_tien`** — authz thực tế là `can_access_building` (`buildings.view`) và `ie_all_buildings_scope` (`income_expenses.all_buildings`); và `buildings.view` **không có CASHBOOK** trong `scope_kinds` ⇒ một cạnh CASHBOOK-only thoả `thu_tien.view` nhưng vẫn fail `can_access_building`. Đó mới là lệch scope thật |
| B3 | Digest-check + forward-define `ensure_income_expense_type_v1` / `normalize_income_expense_type_name` | **BỎ** | Defining migration tracked `20260728180000:13` và `:792`, live khớp 12 tham số. Phụ thuộc vào file đó; **cấm** forward-redefine từ snapshot live. (Tác giả plan không cẩu thả: file này vắng trên nhánh `fix/v5-collection-completion-20260722` nơi plan được viết) |
| A-SVC | Registry technical SERVICE membership + `check-technical-membership-isolation.mjs` + sửa loạt selector, như deliverable Slice 0 | **BỎ** (giữ nhánh điều kiện) | 1 superadmin, 2 org, membership ACTIVE hợp lệ ở **cả hai** ⇒ nhánh provision **không tới được**. `member_type='SERVICE'` **đã có** trong CHECK, 0 dòng SERVICE. Giữ: preflight ghi nhánh này là dead-on-current-data; viết lại §147 ở **thể điều kiện**. Chuyển phần thật sự cần sang A-ACTOR |
| A-ACTOR | (mới, tách từ trên) | **SỬA** | `app_private.resolve_finance_actor_v2()` **no-arg** ném `42501 'ambiguous membership'` cho đúng superadmin duy nhất, **chỉ vì** user đó có 2 membership thường. Vị ngữ đếm của nó không có chiều `member_type`/technical ⇒ bản vá plan đề xuất **không** giảm 2 xuống 1. Chỉ thị tuyệt đối: shared context **luôn** gọi overload org-scoped `resolve_finance_actor_v2(p_organization_id)`; thêm fixture actor 2-org |
| E1 | "Task 0 sửa double-mount `ThuTien.tsx`" | **BỎ** như đặc tả · **SỬA** thành hoist-state | Xem §−1.6. Hai bề mặt cùng hiện là chủ ý (`thu-tien.css:439-444`) và **có spec bảo vệ** (`thanh-toan-page.spec.ts:20/:27/:32`, mobile dùng `toBeHidden()` tại `:143` ⇒ cả hai component **luôn** mounted, chỉ CSS ẩn). Thực thi theo breakpoint = **đổi sản phẩm** trá hình sửa bug, và làm đỏ chính gate Slice 0 |
| D-BROKER | Tạo unique index broker | **BỎ** | `uq_ie_commission_per_contract` đã có (partial unique trên `(contract_id, commission_kind)` với `NOT commission_legacy_dup`) + advisory lock `commission:<contract>:<kind>` + pre-check `P0001`. **Cấm DROP/REPLACE.** Việc còn lại thu về **2 HĐ** (`16edb8f0…`, `b543b3cd…`) có 2 phiếu broker APPROVED, cộng 11 phiếu hoa hồng không gắn HĐ và 3 dòng `commission_legacy_dup=true` |
| E-FILE | Mọi "Modify `src/pages/ThuTien.tsx`" | **SỬA** | → `src/pages/ThanhToan.tsx`. Kèm cảnh báo route: entry mới trong `FEE_CATEGORIES` nằm sau `thu_tien.collect`, xung đột §3.3 Plan 2 (queue/lifecycle ở `thu_tien.view`) — Task 7 Step 1 phải nói rõ hai entry mới mount ở đâu |
| E-DEAD | Sửa `UtilityDesktopPanel.tsx` / `UtilityBillSheet.tsx` | **SỬA** | Dead code, 0 importer trong `src/` và `.e2e-fleet/`. ~36 KB sửa đổi sẽ rơi vào file không render, trong khi typecheck và checklist đều xanh. Đích thật: `UtilityEnContent.tsx` + khối EN inline của `PeriodFeeSheet.tsx` |
| E-MIG | Danh sách defining migration của ba SQL surface phí cố định | **SỬA** | Bản canonical cuối `20260728180000:944`; thêm `20260710120100`. Bắt buộc `pg_get_functiondef` live rồi diff trước khi viết wrapper; **cấm** copy body từ `20260708130100` (sẽ revert canonicalization 28/07) |
| D-OWNER | `member_type='OWNER'` OR `is_super_admin()` là định nghĩa "chủ" | **SỬA** | EXTEND `is_org_owner_v1` (+`organizations.status`, +nhánh superadmin, +thay literal `'Chủ sở hữu tổ chức'` bằng khoá bất biến), **không** tạo helper thứ hai. Phải chốt tường minh: DEMO có 3 role-owner vs 1 `member_type='OWNER'`; org thật hai định nghĩa **trùng nhau** (1 và 1) ⇒ lệch **một chiều** và **chỉ ở DEMO**. Test: STAFF-có-vai-trò-chủ **phải** là chủ; OWNER-không-vai-trò **không** phải |
| E4 | `finance_v2_is_cashbook_period_open` là gate kỳ duy nhất | **SỬA** (hạ từ BLOCKER xuống MEDIUM) | Tiền không lọt vào sổ đã chốt: hai trigger cấp bảng **vô điều kiện** đã canh (`income_expenses_check_lock` theo `voucher_date`, `income_expense_posting_lines_check_lock` theo `posted_on`), cộng `income_expenses_check_profit_lock`. Khuyết tật thật là **chất lượng lỗi + vị trí gate**: pre-check báo OPEN rồi transaction chết sâu trong trigger. Dùng `cashbook_closed_through_v1` + `assert_period_open_for_edit_v1`, phát ba code có nhãn |
| B13 | Không testing-library ⇒ mọi DOM assertion về Playwright | **SỬA** | Repo đã có harness `renderToStaticMarkup` (15 file, environment `node`, 12 assertion/4 file trong 1,54 s). Đẩy invariant render về unit test; Playwright chỉ cho luồng đa bước + upload thật |
| E10 | Release adapter "bao phủ mọi terminal writer đã xác minh" | **SỬA** | Thiếu **hai** (không phải bốn): `cancel_income_expense_flex_v1`, `reverse_invoice_collection_v5`. `ie_compat_cancel_v2` **đã** có trong danh sách plan. Nâng trigger backstop lên cơ chế chính |
| E8 | Seed `finance_flow_owner_adapters` + test unknown-owner là đủ | **SỬA** | `dispatch_finance_decision_v2` route theo `adapter_name` qua `CASE` 5 nhánh, `ELSE → 0A000`. Plan phải nói rõ: **reuse** một `adapter_name` đã nối, **hoặc** thêm nhánh CASE. Lỗi đã hiện thực hoá cho `UTILITY_RECURRING` |
| E2 | Đặt `ie_transition_authorization` rồi register ownership, không ràng buộc `purpose` | **SỬA** (BLOCKER, xem §6.2) | `purpose` **không** là metadata tự do mà là kill switch của a85/a85b |
| C-EV-1 | Evidence lineage "cùng hash" | **SỬA** | `finalize_finance_evidence_v2` **không bao giờ ghi `sha256`**: 159 dòng, **0** có `sha256`, **0** có `upload_token_hash`. Mọi guard so "cùng hash" đang so NULL với NULL. Chọn: (A) ghi thật `sha256`, hoặc (B) định nghĩa lại fingerprint = `(organization_id, bucket_id, object_name, byte_size, mime_type)` và **bỏ chữ "hash"**. Riêng `INHERITED_BATCH` thì plan **đúng**: CHECK hiện chỉ `('ORIGINAL','INHERITED_LEGACY_DELTA')`, 142/142 dòng là `ORIGINAL` ⇒ cần forward-update constraint |
| C-EV-2 | Ghi `income_expense_audit_log` với field có cấu trúc | **SỬA** | `log_income_expense_action(p_id uuid, p_action text, p_note text)` — đúng 3 tham số; bảng **không có cột jsonb**, field tự do duy nhất là `note text`. Chọn (A) serialise JSON vào `note`, hoặc (B) thêm cột `details jsonb` **và chứng minh chuỗi `event_hash` của các Đợt trước không đổi** |
| C-INFRA-10 | Auto-approve chỉ cần ghi audit action | **SỬA** | `check-approver-provenance.mjs` (CUTOFF `2026-07-23`) **fail** mọi phiếu `APPROVED` có `approved_by IS NULL AND system_source IS NULL`. Phiếu auto-approve **phải** set `system_source` (vd `special_fee.<route>`) trên chính dòng voucher. Tương tác: điều đó cũng làm `assert_manual_voucher_v1` ném `[NOT_MANUAL]` khi flex-cancel — đúng fail-closed, và **phải assert** |
| C-ROLL-1 | Rollback dùng `force_freeze` | **SỬA** | `set_feature_freeze_v1` không tồn tại, và **không hàm nào trong toàn DB ghi `force_freeze`** (8 hàm chỉ đọc). Freeze hôm nay = UPDATE tay ⇒ **0 dòng `server_feature_flag_events`, không bump `config_version`** (bằng chứng: `income_expense.profit_close.v2` `force_freeze=true`, `config_version=1`, 0 event; 7 cờ đổi version không có event). Chọn: viết `set_feature_freeze_v1` có CAS + event + REVOKE + vào `check-definer-acl`, **hoặc** ghi thẳng rằng freeze là UPDATE tay qua Management API và phải lập biên bản |
| C-ROLL-2 | "prod stored OFF + DEMO stored CANARY" | **SỬA** | `server_feature_flags` **không có `organization_id`** (PK = `feature_key`). Lật SHADOW→CANARY đẩy org thật từ SHADOW về **LEGACY** ⇒ **mất telemetry parity đúng lúc cần nó nhất**. Tiền lệ: `invoice.collection.v5` chỉ có **85 phút** cửa sổ shadow (22/07 05:38:50 → 07:03:53). Viết lại theo cặp stored-vs-evaluated; **thu đủ parity report TRƯỚC khi rời SHADOW**. Nếu cần hành vi per-org lâu dài thì theo tiền lệ `app_private.org_accounting_mode` |
| C-ROLL-3 | Gọi `set_feature_route_v1` | **SỬA** | Đúng thứ tự positional nhưng **sai 3 tên tham số** (gọi named-arg ⇒ `42883`). ON/CANARY đòi `commit_sha` 40-hex, `migration_sha256` 64-hex, `maintenance_window_id`, `approval_reference` khác rỗng, else `22023`. ACL **chỉ `postgres=X`** — `service_role` bị từ chối ⇒ **không có đường nào trong app lật được route**; phải ghi rõ ai chạy và chạy bằng gì |
| C-ROLL-6 | Idempotency "cùng key + hash trả cùng voucher" | **SỬA** (HIGH) | `claim_feature_operation_v1` INSERT trần vào bảng có `UNIQUE (feature_key, config_version, operation_key)` ⇒ replay y hệt ném **`23505` từ TRONG claim**, không phải "trả voucher cũ". Thêm luật vào lock order: **tra bảng idempotency của special-fee/termination TRƯỚC, hit thì trả voucher cũ và KHÔNG gọi claim**; không bao giờ dựa vào `server_feature_flag_operations` làm idempotency (khoá unique có `config_version`) |
| C-DEP-KPI | `/deposits` chỉ sửa 2 file TS | **SỬA** | Thêm `get_refund_forfeit_summary` vào migration read của Task 4 và thêm assertion KPI vào Task 7 Step 6 |
| C-DEP-BASE | Test list `/deposits` chỉ có "chỉ `contracts.view`" và "chỉ `deposits.view`" | **SỬA** | Baseline hôm nay là **`buildings.view` resolve qua PHÒNG HIỆN TẠI** (`contract_terminations_select_rbac` qual `can_access_building(building_of_contract(contract_id))`, join `contracts → rooms`). Thêm hai fixture: thành viên có `buildings.view` mà không có `deposits.view` (**mất** dòng đang thấy) và ngược lại. Ghi thêm: `deposits.refund` **đã tồn tại và chưa dùng** — phải giải thích vì sao không dùng nó làm gate, hoặc dùng |
| C-TERM-1 | "Hai termination writer" | **SỬA** (MEDIUM) | Ba. `terminate_contract_forfeit_impl` (26/37 dòng). Nhưng **không** phải lỗ refund: FORFEIT chỉ sinh cặp offset EXPENSE + revenue INCOME (`:168-184`), và `DEPOSIT_FORFEIT_POSTED` **suy ra được** từ 8+8 phiếu `termination.forfeit_*` (31.000.000đ mỗi bên) mà `statusMutations.ts:39-42` đã đọc. Việc phải làm: đổi "hai" thành "ba", thêm attribution, và **quyết fail-close hay chấp nhận** audit insert bị nuốt `:262-263` |
| C-TERM-METHOD | (không có trong 29/07) | **SỬA** (một câu) | Emitter **phải** set `contract_terminations.refund_method` (giữ `'TM'` parity) khi `refund_amount > 0`, không thì insert fail `23514` (`terminations_refund_method_required_if_refund`) |
| C-ROOM-2 | Residence segment đọc transfer `COMPLETED`, mốc đầu là `contracts.start_date` | **SỬA** | Có **đường đổi phòng thứ hai**: trigger `apply_contract_transfer` (DRAFT→APPROVED) ghi đè `room_id, rent_price, total_deposit, start_date, end_date`, đặt `status='TRANSFERRED'`. `transfer_room` **cố ý né** trigger này. 0 dòng hôm nay, RLS cho phép ⇒ phải phủ, và **bỏ giả định mốc `start_date`** |
| D9 | Bảo trì 101/11 | **SỬA** | 200/31/80.289.556đ cho cả họ (plan 29/07 ghi 101/11 — số đo lại 30/07 là 200/31). `special_fee_type_mappings` + `LEGACY_SCOPE_UNKNOWN` **hấp thụ được 200 dòng như 101**, nên thiết kế không sai — chỉ sai baseline và effort |
| D13 | `repeat_due = 77` children | **SỬA** | 77 **parent** (0 child trong tập đó); 155 child sống, **155/155** đáp xuống slot fixed-kind ⇒ tích hợp external-holder **không phải edge case, là 100%**. Ghi rõ vị ngữ "due": 77 theo `repeat_next_date >= current_date`, 76 theo `add_cycle(...) <= current_date` |
| C-RECUR | Recurring engine giữ approval semantics cũ | **GIỮ** + ghi thêm | Cron `recurring_vouchers_daily` (`0 18 * * *`) gọi `generate_recurring_vouchers(NULL)` = **toàn bộ parent trong DB**; nó **không đọc ngưỡng tự duyệt**, **copy `attachments` của parent cho MỌI child**, **nuốt lỗi từng child** (`EXCEPTION WHEN OTHERS → RAISE NOTICE`), và dùng `CURRENT_DATE` không theo timezone org. 64/77 parent `repeat_auto_approve=true` |
| C-INFRA-4 | (không có trong 29/07) | **GIỮ**, phải ghi | **Cả hai org đang ở flexible mode** (`org_accounting_mode`: `aaaa` id=1 `strict_mode=false` 29/07 11:12; `dddd` id=4 `strict_mode=false` 29/07 11:26) ⇒ đường flex-cancel của Đợt 4/5 **đang sống trên production**, không ngủ |
| C-AUTHZ-7 | Undo đòi exact CUSTODIAN | **SỬA** | Xung đột quyết định 30/07 của chủ ghi tại `20260730240000_authz_remaining.sql:34-38` ("với việc thu chỉ cần biết sổ là được") — chọn `ie_visible_cashbook_ids_v1` (4 cửa) thay vì so khớp `possession_kind`. Undo dùng **"ĐƯỢC NHÌN SỔ"**; exact CUSTODIAN chỉ dành cho submit/collect. ⚠ File đó **untracked và chưa apply** ⇒ phải quyết số phận nó trước (§8) |
| C-INFRA-6 | (không có trong 29/07) | **SỬA** | `useRealtimeDataSync.ts:293 let hubActive = false` là singleton cấp module; instance thứ hai return `undefined` (không cleanup), cleanup của instance đầu `removeChannel` ⇒ **instance sống sót vĩnh viễn không subscribe**. Hôm nay chỉ mount một lần (`App.tsx:236`) nên invariant còn đúng, nhưng bất kỳ refactor mount-topology do plan gây ra là trigger hợp lý. Thêm ref-count + test hai consumer + `subscribe((status)=>…)` log `CHANNEL_ERROR` (hiện `:343` là `channel.subscribe()` trần) |
| C-INFRA-7 | Thêm query key mới cho special-fee/lifecycle | **SỬA** | Phải thêm **4 key ĐANG CÓ mà đang thiếu**: `['period-fee-status']`, `['period-commissions']`, `['period-maintenance']`, `['fee-accounts']`; và `building_fee_accounts`/`building_utility_accounts` **vắng hẳn** khỏi `SYNC_TABLES` ⇒ `/thanh-toan` **không** live-refresh GRID/hoa hồng/bảo trì từ máy khác — **khuếch đại trực tiếp** rủi ro phiếu trùng ở −1.6. Cập nhật cả `docs/he-thong/realtime-sync.md:32-33` (còn ghi `accounts`/`payments` là "chưa có realtime") |
| C-INFRA-8 | Mở rộng `useRealtimeDataSync.test.ts` | **SỬA** | Phải sửa đồng bộ **ba** assertion: `:252-267` `toEqual([11 tên đúng thứ tự])`, `:437-446` `toEqual([8 root])` + `:456 toHaveBeenCalledTimes(8)`, và ma trận `it.each` `:117-143/:271-281`. **KHÔNG** nới `toEqual` thành `toContain` — chính chúng chứng minh không bảng nào đăng ký hai lần. Giới hạn harness: `type RealtimeHandler = () => void`, `triggerTable` gọi **không tham số**, `vi.mock("react")` chỉ cấp `useEffect` ⇒ hook cần `useRef/useCallback/useMemo` sẽ throw |
| C-INFRA-9 | E2E là gate | **SỬA** | `.e2e-fleet` **không có `package.json`, không có `tsconfig.json`** ⇒ 7 spec mới **không được typecheck** trong khi `typecheck:baseline` báo xanh. Thêm `.e2e-fleet/tsconfig.json` + script `typecheck:e2e`, hoặc ghi thẳng rằng lỗi type của spec chỉ hiện lúc runtime |
| C-INFRA-11 | `reconcile-money.mjs` = "zero money drift" | **SỬA** | Script có thể **exit 3 (INCONCLUSIVE)** khi không kỳ nào >1000 phiếu, và cần `signInWithPassword` ⇒ **không headless-CI-safe**. Định nghĩa pass = `exit 0`; `exit 3` **không phải pass** |
| C-INFRA-12 | (không có trong 29/07) | **GIỮ**, phải ghi | `supabase_migrations.schema_migrations`: `count=360`, `max_version='20260716170000'` — **không** dòng nào của 29–30/07 được ghi, dù ≥22 file trong đó đã apply. **"Vắng sổ" ≠ "chưa apply"**; mọi kiểm tra phải dùng catalog (`pg_proc/pg_class/pg_trigger/pg_constraint`) |
| D11 | `income_expenses` ~2.496 dòng | **SỬA** | **2.625** dòng ngày 30/07 (2.276 `aaaa` + 349 `dddd`) — plan 29/07 ghi 2.496/2.528; số đo lại 30/07 là 2.625. Bảng dịch ~130 dòng trong một ngày ⇒ preflight phải so **delta với baseline đã ghi**, không bao giờ so bằng tuyệt đối |
| D4 | KPI `/deposits` | **SỬA** | Số **theo org**: `get_refund_forfeit_summary` là `LANGUAGE sql STABLE`, **không** SECURITY DEFINER, và `relrowsecurity=true` trên `contract_terminations/contracts/rooms` ⇒ RLS scope theo tenant. **8.990.000đ / 11 lần là tổng cross-org qua service-role mà không người dùng nào thấy** |
| C-DEP-7/8 | (không có trong 29/07) | **SỬA** | `TERMINATION_MOVE_OUT_PAIR` chiếm sẵn một slot adapter với 2 bảng **0 dòng** mà `terminate_contract_move_out_impl` không bao giờ ghi ⇒ quyết dọn hay giữ tường minh, để re-point `TERMINATION_REFUND` không đụng nó. Và `reserve_invoice_refund_obligation_v2` (~:80-82) còn **có thể mint hybrid**: `flow_kind='TERMINATION_REFUND'` trong khi `lifecycle_owner` hardcode `'INVOICE_REFUND'` — chặn hoặc xoá nhánh đó trong **cùng** migration re-point |
| D7 | Frontend không đọc được ownership (`app_private` không có USAGE) | **SỬA** thành wording | Ownership của flow này là **hàm thuần của `income_expenses.system_source`**, mà `system_source` đã được client đọc khắp nơi (`statusMutations.ts:48`, `queries.ts:230/240/245/495/996`, `types.ts:147`, `src/lib/voucherSources.ts:1`). Prod có 20 phiếu `system_source='termination.refund'` (53.655.301đ). Viết lại thành "lookup nguồn phiếu đã đông cứng + trạng thái obligation" — **đừng expose `app_private`** |
| D8 | "UI chọn writer theo global route trước khi xem ownership" | **GIỮ** (bản 29/07 đúng) | `IncomeExpensePage.tsx:350-351/:497/:994/:1009/:1056/:1083`, `ApprovalsPage.tsx:80/:86/:90`, `IncomeExpenseMobilePage.tsx:438-439` đều branch theo route flag; **không caller nào tra ownership**. Nhưng phải ghi một dư lượng nguy hiểm: lối tôn trọng ownership duy nhất đang tồn tại là **regex trên message tiếng Anh** — `financeV2Mutations.ts:46-48 /owned by system flow/i` dùng ở `:60`, lặp ở `statusMutations.ts:315/:352`, khớp chuỗi do `assert_income_expense_flow_owner_v2:20` phát. **Mọi adapter mới phải giữ nguyên đúng substring đó** cho tới khi routing ownership-first lên, không thì dispatch chết im sau toast "Duyệt phiếu thất bại" |
| D-STATUS | "`APPROVED` không đủ để kết luận đã chi" | **GIỮ** | Bằng chứng sống: `PC2607005` (`system_source='contract.commission'`, `commission_kind='broker'`) đang `APPROVED` + `posting_status='UNPOSTED'` + `active_posting_id_v2 IS NULL` trên sổ **thật** ('ATam'), **2.730.000đ** — đã hiện "Đã chi" mà không có posting nào |
| E5 | Bảng gate §8 là đủ | **SỬA** | Thiếu `check-stable-fn-locks.mjs` (tự khai "5 lần án lệ", "CHẠY SAU MỌI MIGRATION TẠO/SỬA HÀM", **không có CI coverage**) và `check-permission-catalog.mjs` (**gate CI bắt buộc** `ci-gates.yml:135-138`). Xem §9 |
| E12 | Thứ tự migration canonical | **SỬA** | Xem §8 |

## 6. Kiến trúc production đã chốt

### 6.1 Sơ đồ (cập nhật)

```text
[SLICE −1] Hotfix trên bề mặt ĐANG CHẠY — không object mới
   ├─ /thanh-toan: reader EN + reader bảo trì thấy UNAPPROVED; chống trùng EN;
   │  bỏ tự-tạo-công-tơ; hoist state (một nguồn amounts/bookSel/attach); p_force owner-only
   ├─ read model phí cố định: tổng ITEM KHỚP (không total_amount) + ánh xạ type do chủ duyệt
   └─ /deposits: refund_done từ POSTED+active posting; SỬA get_refund_forfeit_summary;
      xoá useApproveTermination; siết DML contract_terminations
                    │
                    ▼
ThanhToan UI (thu_tien.collect) + ThuTien room surface (thu_tien.view) + Deposits read surface
   ├─ authorized preview/list/status/lifecycle RPCs  ← TẤT CẢ khai VOLATILE
   └─ submit_special_fee_payment_v1 / submit_termination_refund_from_special_page_v1
             │
             └─ app_private.special_page_submit_context_v1        ◀── CHƯA TỒN TẠI TRÊN PROD
                  org/timezone → authz (buildings.view + income_expenses.all_buildings
                  + thu_tien.collect) → idempotency LOOKUP TRƯỚC → feature route (evaluate
                  ĐÚNG MỘT LẦN) → claim cap → domain/obligation → voucher/items
                  → real cashbook (cashbook_closed_through_v1) → evidence
             │
             ├─ Plan 1: rule/claim → voucher nội bộ UNAPPROVED/UNPOSTED → evidence
             └─ Plan 2: sticky subject + frozen birth voucher + obligation → one-shot finalize
                          │
                          └─ finance_v2_post_voucher_with_source_v1  ◀── CHƯA TỒN TẠI TRÊN PROD
                                (MAIN + CHANGE + ROUNDING lines; period backstop bên trong)
                                → assert → audit/alert/ledger
```

Hai hộp gạch `◀──` là lý do **Plan 2 Task 1–5 bị BLOCKED-BY Plan 1 Task 5** (§7).

### 6.2 Invariant không được phá

Mười tám invariant của bản 29/07 giữ nguyên. Bổ sung tám invariant **mới**, tất cả đều là điều kiện
tồn tại chứ không phải khuyến nghị:

1. **Token `purpose` là kill switch, không phải metadata.** `app_private.ie_transition_authorization`
   có **PK trên `income_expense_id` một mình** (một dòng mỗi phiếu) và trigger
   `a00_ie_transition_token_upsert` **ghi lại `purpose` mỗi lần INSERT**. Cầu `a85`/`a85b` chỉ skip
   khi có token `purpose='FINANCE_V2_LIFECYCLE'` **đúng xid hiện tại**. Vì nhánh approve INVOICE_REFUND
   của `dispatch_finance_decision_v2` dùng `finance_v2_transition_owned_approval` (**stamp
   `purpose='APPROVED'`**), adapter nào copy nó sẽ để **cầu còn vũ trang** đúng lúc `approval_status`
   lật sang `APPROVED`; và vì Task 5 Step 3 bắt phải có `account_id`, `total_amount>0`, sổ thật
   không-virtual, `v_should = true` ⇒ `a85` **tự mint posting `source_kind='LEGACY_BRIDGE'`** rồi
   stamp `posting_status='POSTED'` + `active_posting_id_v2` **trước** khi core của adapter chạy ⇒
   **posting tiền trùng**, và assert của Task 5 Step 5 thấy `LEGACY_BRIDGE` thay vì `SPECIAL_PAGE_FEE`.
   Cầu **đang sống**: `evaluate_feature_route('income_expense.posting.v2')` = CANONICAL trên prod ngay
   lúc này. Thêm: cả hai helper **DELETE token ở cuối** nên mọi UPDATE `income_expenses` sau đó trong
   cùng transaction đập vào freeze guard và fail `55000`. ⇒ **Hoặc** writer tự stamp
   `purpose='FINANCE_V2_LIFECYCLE'` và tự quản lý vòng đời token, **hoặc** theo tiền lệ repo đã lập
   tại `20260730120000_ie_annotate_v1.sql:113-116` và mang năng lực trong
   **`app_private.ie_flex_writer_xids`** thay vì đi vay cột `purpose`. Bảng đó có
   `begin_ie_flex_write_v1(p_voucher, p_scope)` / `end_ie_flex_write_v1`, CHECK scope
   `('ANNOTATE','FLEX_EDIT')` — và `'FLEX_EDIT'` **đã được đặt chỗ trong CHECK nhưng chưa hiện thực
   trong body guard**, đó chính là móc treo.
2. **`dispatch_finance_decision_v2` route theo `adapter_name` qua `CASE` năm nhánh đóng.** Bộ đã nối:
   `{INVOICE_REFUND, PROFIT_PAYOUT, TERMINATION_FORFEIT_PAIR, TERMINATION_MOVE_OUT_PAIR,
   SALARY_BUNDLE}`; `ELSE` ném `0A000 'adapter % not wired for decision routing'`. Seed một
   `adapter_name` mới thì migration **apply xanh** rồi **chết ở decision đầu tiên**. Test
   "unknown owner fail closed" chạy đường `42501` và **không bao giờ** chạm `0A000` ⇒ vô dụng ở đây.
3. **Họ trigger PROFIT_LOCKED là một tầng khoá độc lập, đang có hiệu lực.**
   `income_expenses_check_profit_lock` + `income_expense_items_check_profit_lock` +
   `a02_ie_profit_lock_*` + `20260730240000_profit_month_lock_guard.sql` +
   `20260730260000_profit_lock_cover_out_of_pnl.sql`, cửa duy nhất là `is_org_owner_v1`.
   **18 toà đã chốt lợi nhuận tháng 05/2026.** Ngược lại, **0 dòng `cashbook_closures` và 0 account
   có `lock_date`** ⇒ nhánh "kỳ sổ quỹ đã đóng" của cả hai plan **chỉ kiểm được bằng ca dựng**, còn
   nhánh chốt lợi nhuận thì có dữ liệu thật. **7/7 phiên bàn giao tiền mặt đang ở trạng thái đã xác nhận.**
4. **Mọi read RPC phải khai VOLATILE (mặc định).** `20260730280000_stable_fn_row_lock_regression.sql:57-89`
   cài `DO $guard$` đệ quy 4 tầng lời gọi, tự
   `RAISE EXCEPTION 'Còn hàm public khai STABLE/IMMUTABLE mà chạm khoá dòng — sẽ ném 25006 qua PostgREST: %'`.
   `app_private.authorize_tenant_action_v3` có `SELECT … FOR SHARE` (prod: `provolatile='v'`), danh
   sách hàm hở hiện **rỗng (xanh)**. Khai `STABLE` cho bất kỳ read RPC nào của hai plan = vừa `25006`
   qua PostgREST vừa **abort migration**.
5. **Freeze-guard allowlist KHÔNG chứa `account_id` và `voucher_date`.** `guard_income_expense_owned_payload`
   allowlist (`:59-79`) và cửa ANNOTATE (`:29-43`) đều không có hai cột đó ⇒ `pay_draft_fee_voucher:36-39`
   (ghi `account_id`) **fail dù có token**. Đây là lý do 8 draft E2E DEMO không trả được. Mọi one-shot
   finalize token (`TERMINATION_REFUND_FINALIZE`) phải là **mở rộng allowlist tường minh**, không phải
   giả định.
6. **Có một carve-out ANNOTATE hợp pháp làm biến đổi `attachments/notes` trên phiếu POSTED
   system-owned.** Nhánh ANNOTATE của guard fire cho **mọi** `flow_kind` (comment trong body tự nói
   vậy), trả `NEW` khi chỉ `attachments/notes/updated_at` đổi; `'notes'` còn nằm trong allowlist token.
   `public.annotate_income_expense_v1` là DEFINER, GRANT `authenticated`, **không đọc**
   `income_expense_flow_ownership`; theo `20260730270000:24-91` chỉ **xoá** file và **replace** notes
   trên phiếu POSTED mới bị gác bởi chủ. ⇒ Header hash và bộ đông cứng của Plan 2 **phải loại
   `attachments/notes`**, hoặc phải xin chủ carve-out tường minh.
7. **`claim_feature_operation_v1` ném `23505` khi replay y hệt** ⇒ idempotency **phải short-circuit
   TRƯỚC claim**. `operation_key = md5(concat_ws('|', feature_key, org, subject_scope, actor,
   idempotency_key))`, INSERT trần, `UNIQUE (feature_key, config_version, operation_key)`. Và vì
   `config_version` nằm trong khoá unique, **bump version giữa hai lần replay xoá sạch bảo vệ**.
8. **`evaluate_feature_route` chỉ được gọi ĐÚNG MỘT LẦN mỗi transaction.** Nó dùng
   `clock_timestamp()` (không stable theo transaction) nên hai lần evaluate trong một transaction có
   thể vắt qua `starts_at/ends_at` (CANONICAL rồi FROZEN); `claim_feature_operation_v1` lấy
   `clock_timestamp()` **riêng của nó** sau advisory lock, nên một writer có thể qua route rồi fail
   "Canary window is no longer valid" trong cùng transaction. Thêm: `IF f.mode='ON' THEN RETURN
   'CANONICAL'` nằm **trước** cả khối window ⇒ `ends_at` **không** là van tự hết hạn sau ON; và bộ
   đếm cap **không có vị ngữ `organization_id`**. ⇒ Snapshot `(evaluated, stored mode, config_version)`
   vào biến (và vào marker) rồi dùng lại; nếu dùng chung bảng ops để đếm thì thêm vị ngữ org; đặt
   `max_operation_count` rộng tay (tiền lệ prod: `2147483647`).

### 6.3 Primitives phải gọi (cập nhật)

Giữ: `resolve_finance_actor_v2(p_organization_id)` (**bắt buộc overload org-scoped**),
`authorize_tenant_action_v3`, `assert_cashbook_access_v2(...,'CUSTODIAN',...)`,
`create_finance_evidence_upload_intent_v2` / `finalize_finance_evidence_v2`, shared
`resolve_signed_contract_deposit_basis_v1`, `app_private.lock_org_for_decision_v1`.

Thay: `finance_v2_is_cashbook_period_open` → `cashbook_closed_through_v1` (pre-voucher) +
`assert_period_open_for_edit_v1` (khi đã có voucher).
Bỏ khỏi danh sách forward-define: `ensure_income_expense_type_v1`,
`normalize_income_expense_type_name` (chỉ **depend**).
Thêm vào danh sách: `app_private.is_org_owner_v1` (extend), `app_private.ie_flex_writer_xids` +
`begin/end_ie_flex_write_v1`, `app_private.ie_visible_cashbook_ids_v1` (cho undo),
`app_private.income_expense_change_log` + `public.get_voucher_change_log_v1` (**dùng cho value-diff,
đừng dựng ledger thứ ba**; `income_expense_audit_log` chỉ dành cho chuyển trạng thái nghiệp vụ mà
trigger không thấy: proposal decision, claim release, warning).

Ba mẫu phải tái dùng nguyên văn: migration thêm publication (`20260730230000_realtime_money_tables.sql`),
bảng hành vi per-org (`app_private.org_accounting_mode`, sinh ra **chính vì** `server_feature_flags`
không có `organization_id`), và vòng lặp prerequisite-assert
(`20260723010000_finance_v2_semantics_snapshot.sql:69-96` — `to_regclass`/`to_regprocedure` raise
`'Missing Finance V2 prerequisite relation %'`; đây cũng là câu trả lời cho lo ngại "clone chết với
lỗi khó hiểu": nó **loud và tự chẩn đoán**).

Lock order giữ nguyên bản 29/07, **thêm bước 0**: `LOOKUP idempotency record` trước tất cả.

## 7. Thứ tự giao hàng bắt buộc

| Slice | Nội dung | Ghi tiền? | Gate chuyển slice |
|---|---|---:|---|
| **−1** | Hotfix production §4: reader EN/bảo trì thấy UNAPPROVED; chống trùng EN; bỏ tự-tạo-công-tơ; read model phí cố định (tổng item khớp + loại type lương); hoist state `/thanh-toan` + `p_force` owner-only; `/deposits` refund_done + **KPI**; xoá `useApproveTermination`; siết DML `contract_terminations` | **Không phiếu mới**; chỉ sửa reader/guard/ACL | Từng gate ở §4.1–4.9 xanh; `thanh-toan-page.spec.ts` + `utility-paste-receipt.spec.ts` **vẫn xanh**; `reconcile-money.mjs` exit **0** (exit 3 không phải pass); **KHÔNG dọn phiếu nào** (§1bis) — thay vào đó chứng minh guard mới chặn được phiếu thứ 46 trên một ô đã trùng, và tổng/đếm phiếu trước-sau migration **không đổi một đồng** |
| **0** | **Chỉ sửa văn bản plan + preflight, KHÔNG schema.** Áp mọi patch §5. Xoá Step 3d (E13) và forward-define `ensure_income_expense_type_v1` (B3). Đánh số lại 16 migration (E12). Chốt định nghĩa "chủ" (D-OWNER). Quyết số phận WP2 + 2 file untracked (§8). Sửa `AGENTS.md` về `npm run gen:types` không redirect. Thêm 2 gate (E5). **Đo lại 12 hạng mục §11.2** | Không | `typecheck:baseline` xanh; preflight script ghi timestamp/org/query hash/baseline; review worktree; chủ ký quyết định ngưỡng 600.000đ (§3 dòng Điện/nước) và bậc hoa hồng |
| **1** | **Shared runtime (Plan 1), chỉ schema, route OFF.** Hợp đồng token với `purpose='FINANCE_V2_LIFECYCLE'` hoặc `ie_flex_writer_xids` (invariant 1). `finance_v2_post_voucher_with_source_v1` có MAIN+CHANGE+ROUNDING và period backstop bên trong. Ba code kỳ có nhãn (E4). Migration publication + 4 key realtime đang thiếu. Nhánh CASE cho `dispatch_finance_decision_v2` (invariant 2). **Mọi read RPC khai VOLATILE** | Không | `check-stable-fn-locks.mjs` xanh; `check-definer-acl.mjs`; test dispatcher chạy **cả** `42501` **và** `0A000`; test token: không có posting `LEGACY_BRIDGE` nào sinh ra |
| **2** | Fail-closed transfer audit + residence segments (phủ **cả** `apply_contract_transfer`); chưa deploy RPC phụ thuộc obligation | Không | test incomplete/ambiguous/overlap (phải **tự dựng**, không có dữ liệu thật); cross-org segment read bị từ chối; no money drift |
| **3** | Plan 1 rule version / cross-class BASE claim / conflict ở **SHADOW**; map + reconcile full-payload recurring/external holder (**155/155 child**) | Không | backfill report theo org; fan-out nhiều tháng; item delete/reinsert + concurrency preview; owner config DRAFT |
| **4** | Owner config, **chỉ DRAFT**. Fixed rule version, utility ceiling, maintenance standard, `fallback_policy` hoa hồng, trần Sale | Không | Cửa sổ nhập liệu tường minh cho ~35 ô còn thiếu + **toàn bộ 21 ô `quan_ly`** + 109 dòng thiếu sổ + `fallback_policy` mở khoá **70 HĐ** |
| **5** | Shared context + Plan 1 posting adapter, **DEMO/CANARY**. Seed bộ fixture DEMO thành checklist có tên | **Có, DEMO/canary** | evidence-before-post; restricted category; caps/cancel/reversal; E2E headless; **verify cả 5 decision trên owner mới không trả `0A000`** |
| **6** | **Plan 2 adapter + 5 wrapper + routing ownership-first ở frontend — LÀM CÙNG NHAU, TRƯỚC birth CANARY** | Không | Nếu tách như bản 29/07 (birth ở Slice 4, routing ownership-first ở Slice 5) thì trong khoảng giữa, một phiếu hoàn canary mở trên `/thu-chi` vẫn đập vào 11 generic RPC assert `CANONICAL_INCOME_EXPENSE`. Giữ nguyên substring `owned by system flow` (D8) |
| **7** | Plan 2 snapshot + sticky owned obligation birth, route OFF→SHADOW→**CANARY (DEMO)**; queue/preview/lifecycle/`/deposits` read-only | Chỉ termination canary; chưa cho submit | không phiếu hoàn canonical nào unowned; sticky rollback; read authz/chunk/snapshot attribution; **queue org thật ≤ 3 dòng** (lớn hơn = máy đang sinh nghĩa vụ hoàn cho ca khách còn nợ); KPI và bảng khớp nhau |
| **8** | Exact refund writer + lifecycle UI | Có, canary rồi production | exact amount trên **cả hai** ca lệch (−978.500 **và** +500.000); manual race; reversal; room reconciliation; chủ ký |
| **9** | Mở rộng production và theo dõi | Có | 24h không drift/duplicate/orphan; runbook rollback **đã thử**; nhớ rằng freeze hiện **không có đường có kiểm toán** (C-ROLL-1) |

**Plan 2 Task 1–5 là BLOCKED-BY Plan 1 Task 5.** Không có `special_page_submit_context_v1`, không có
`finance_v2_post_voucher_with_source_v1`, không có `special_fee_*`/`termination_refund_*`/
`room_residence_segments`/`termination_settlement_snapshots` trên prod. Plan 2 được viết như thể
shared runtime là tiền đề đã có; nó là **deliverable của Slice 1**. Task 0 và Task 6 của Plan 2
(transfer audit + residence segments + room lifecycle read) **không** phụ thuộc obligation nên chạy
song song được ở Slice 2.

## 8. Đánh số migration

**Luật:** mọi migration mới của hai plan phải sort **SAU** file đã apply cuối cùng
(`20260730280000_stable_fn_row_lock_regression.sql`), tức thuộc dải `20260731xxxxxx`. Luật này chữa
đồng thời hai lỗi: (a) đụng tên trực diện tại `20260730160000`, (b) hiểm hoạ **thứ tự replay** — mọi
`CREATE OR REPLACE` mà Plan 1 đặt ở `202607300000xx` sẽ bị khối `20260730100000–20260730280000` ghi
đè khi rebuild clone, làm clone **không phản ánh production** và gate rehearsal cho kết quả sai lệch.

Thêm một bước preflight: **fail nếu timestamp mới trùng bất kỳ file đã có** trong `supabase/migrations/`.

### 8.1 Thứ tự canonical sau khi đánh số lại (16 file)

```text
# Plan 1 — hạ tầng dùng chung (Slice 1)
20260731010000_special_page_runtime.sql
20260731010500_contract_transfer_audit_hardening.sql
20260731011000_room_residence_segments.sql
# Plan 1 — special fee (Slice 3 → 5)
20260731020000_special_fee_schema.sql
20260731021000_special_fee_rule_rpcs.sql
20260731022000_special_fee_preview.sql
20260731023000_special_fee_writer.sql
20260731024000_special_fee_cancel_repeat.sql
20260731025000_special_fee_read_wrappers.sql
# Plan 2 — termination (Slice 6 → 8)
20260731030000_termination_settlement_snapshot.sql
20260731031000_termination_refund_obligations.sql
20260731031500_termination_writer_canonicalization.sql
20260731032000_termination_refund_read_rpcs.sql
20260731032500_room_lifecycle_read_rpc.sql
20260731033000_termination_lifecycle_backfill.sql
20260731034000_termination_refund_special_writer.sql
```

Slice −1 dùng dải **trước** khối trên (`20260731000000 → 20260731002500`), theo đúng luật
"sau `20260730280000`" — nó phải apply trước mọi file plan.

`special_fee.payment.v1` seed **OFF** trong `20260731020000`; cả hai route termination seed **OFF**
trong `20260731031000`, **trước** các writer migration. Writer chỉ **assert** route; enable theo
slice ở §7, không theo timestamp.

**Cách seed một dòng cờ cho đúng** (C-ROLL-4): bảng là `app_private.server_feature_flags` (không có
bảng `public` cùng tên). NOT NULL có default: `max_operation_count`, `max_single_amount_vnd`,
`max_total_amount_vnd`, `risk_class` (CHECK `IN ('MONEY','NON_MONEY')`). **`domain text NOT NULL`
không có default — bắt buộc truyền.** CHECK `server_feature_flags_canary_limits_check` đòi
`starts_at < ends_at` hữu hạn và **cả ba cap > 0**. Enrollment `server_feature_flag_canary_orgs` PK
`(feature_key, organization_id)` có FK về cờ ⇒ **seed cờ trước**, không thì trigger
`a10_accounting_canary_enrollment_guard` ném `55000 'Accounting feature is not configured'`. Bỏ câu
"cap metadata để NULL". Enrollment chỉ cho **DEMO** (`dddd0000-0000-4000-8000-000000000001`), kèm
DELETE rollback (tiền lệ `20260728150000_enable_non_cash_overpay_credit.sql:1015`).

### 8.2 Hai file untracked phải xử lý TRƯỚC khi viết migration plan nào

Cả hai đang ở trạng thái `??` trong cây làm việc, **trùng timestamp với file tracked đã apply**, và
**chưa lên prod** (xác minh bằng catalog, không bằng `schema_migrations`):

- **`supabase/migrations/20260730230000_annotate_evidence_protection.sql`** — 556 dòng, chưa apply
  (`app_private.ie_evidence_locked_v1`, `ie_notes_append_only_v1`, bảng `ie_annotate_idempotency`
  **không tồn tại** trên prod). `:289` là một `CREATE OR REPLACE FUNCTION public.annotate_income_expense_v1(...)`
  **trần, không có guard "đã vá"** ⇒ apply nó sau file tracked đã apply `20260730270000` (file này vá
  cùng hàm theo mẫu neo và đánh dấu "TIỀN ĐÃ RỜI KÉT") sẽ **xoá sạch lớp bảo vệ bằng chứng**. Cùng
  timestamp còn có `20260730230000_realtime_money_tables.sql` (tracked, đã apply).
- **`supabase/migrations/20260730240000_authz_remaining.sql`** ("WP2") — chưa apply (live
  `assert_period_open_for_edit_v1` md5 `961eb62484c1f14370708e0821135ac3` **thiếu** marker
  `WP2_PERIOD_ALL_THREE`; `app_private.cashbook_closures` **thiếu** `signed_by_super_admin`). Cùng
  timestamp với `20260730240000_profit_month_lock_guard.sql` (tracked, đã apply). WP2 vừa mang quyết
  định "được nhìn sổ" cho undo (C-AUTHZ-7) **vừa** mở rộng vị ngữ kỳ sang kỳ dịch vụ của hạng mục
  (§3 dòng Hồi tố/Trả trước), và nó **viết lại `reverse_invoice_collection_v5` theo mẫu neo**.

**Phải hỏi chủ trước khi apply hoặc đổi tên.** Và phải quyết số phận WP2 **trước** khi đụng
`reverse_invoice_collection_v5`. Ghi chú công bằng: `origin/main` hôm nay **không có** cặp timestamp
trùng nào — sự nhập nhằng chỉ sống trong cây làm việc bẩn này và biến mất nếu hai file `??` được đổi
tên trước khi commit.

### 8.3 Hiểm hoạ anchor-patch của Đợt 0–6 (C-INFRA-1)

Đợt 0–6 vá nhiều hàm dùng chung theo **MẪU NEO**: `pg_get_functiondef → position(anchor) → replace →
EXECUTE`, mỗi chỗ tự `RAISE` **"DỪNG, không vá mù"** khi neo biến mất. Forward-redefine mù một hàm
như thế làm **các migration đó không chạy lại được** và **gãy mọi rehearsal về sau**.

Hàm có nguy cơ mà hai plan định đụng, kèm neo:

| Hàm | Migration:dòng | Neo |
|---|---|---|
| `ie_compat_update_pending_v2` | `20260730190000:36-83` | `v_meta_keys` / `v_money_keys` |
| `update_income_expense_quick` | `20260730190000:91-115` | `notes = p_notes` |
| `assert_period_open_for_edit_v1` | `20260730190000:179-211` (+ WP2 `:355`) | — |
| `assert_manual_voucher_v1` | `20260730190000:213-237` | — |
| `can_reverse_collection_v1` + `reverse_invoice_collection_v5` | `20260730250000:30-104` | `RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn'` |
| `ie_compat_cancel_v2` | `20260730250000:111-174` | `ie_flow_system_owned_v2` |
| `annotate_income_expense_v1` | `20260730270000:24` | — |
| `propose_cashbook_closing_v1` | `20260730210000:348-356` | `  IF p_counted_balance IS NULL THEN` |

**KHÔNG** có nguy cơ (đã xác minh: `CREATE OR REPLACE` trần, không neo):
`confirm_cashbook_closing_v1` (`20260730170000:369`, `20260730210000:173`) và
`cashbook_balance_as_of_v1` (`20260730170000:562`, `20260730210000:63`).

⇒ Thêm **Step 0′ trước mọi `CREATE OR REPLACE`**: *"Kiểm xem hàm đó có đang bị Đợt 0–6 vá theo MẪU NEO
không (danh sách trên). Nếu có, phải cập nhật LUÔN mẫu neo trong migration Đợt tương ứng, hoặc thêm
marker 'đã vá' để DO-block tự bỏ qua."*

### 8.4 Rehearsal

Rehearsal là **clone của production**, nên Đợt 0–6 đã thường trú và mọi guard được luyện. Nếu clone
**không** mang được, phải ghi thẳng vào plan rằng rehearsal **không bao phủ**
`a02_ie_profit_lock_*`, `trg_ie_check_lock_ins`, nhánh ANNOTATE của
`guard_income_expense_owned_payload`, và `DO $guard$` của `20260730280000` — và phải có bộ test
riêng chạy thẳng trên prod trong `BEGIN … ROLLBACK`. Không tài liệu nào được gọi là "dry-run
production".

## 9. Gate production tối thiểu

```bash
npm run typecheck:baseline
npx vitest run scripts/__tests__/gen-supabase-types.test.ts
npx vitest run src/lib/__tests__/feeCategories.test.ts
npx vitest run src/lib/__tests__/specialFeeRules.test.ts src/lib/__tests__/specialFeeRules.property.test.ts
npx vitest run src/lib/__tests__/roomLifecycle.test.ts src/lib/__tests__/roomLifecycle.property.test.ts src/lib/__tests__/terminationRefundStatuses.test.ts
npx vitest run src/hooks/__tests__/specialFeeRouting.test.ts src/hooks/__tests__/terminationRefundRouting.test.ts src/hooks/__tests__/useRealtimeDataSync.test.ts
node scripts/check-stable-fn-locks.mjs          # THÊM — sau MỌI migration tạo/sửa hàm
node scripts/check-permission-catalog.mjs        # THÊM — gate CI bắt buộc, cần PAT
node scripts/check-definer-acl.mjs
node scripts/check-approver-provenance.mjs
node scripts/check-view-invoker.mjs
node scripts/reconcile-money.mjs 2026-07         # pass = exit 0; exit 3 KHÔNG phải pass
node scripts/reconcile-money-v2.mjs 2026-07
```

Bốn thay đổi so với bản 29/07:

1. **THÊM `check-stable-fn-locks.mjs`** — tự khai "GOTCHA đã có án lệ (5 lần)… CHẠY SAU MỌI MIGRATION
   TẠO/SỬA HÀM. Exit 1 nếu có hàm hở". Nó **không có CI coverage** ⇒ vắng nó khỏi §8 là để **zero
   backstop** cho đúng lớp bug đã giết `profit_close_state_v2` mười ngày.
2. **THÊM `check-permission-catalog.mjs`** — đã là gate CI bắt buộc (`ci-gates.yml:135-138`), gác
   permission key vô hình (đo được 11 key thiếu ngày 26/07). Plan 2 tạo permission key mới cho các
   consumer khác nhau ⇒ bắt buộc.
3. **BỎ `node scripts/check-technical-membership-isolation.mjs`** — script này **chưa tồn tại** và
   theo A-SVC thì không còn deliverable để gác.
4. **SỬA cách đọc `reconcile-money.mjs`** — pass = `exit 0`; `exit 3 (INCONCLUSIVE)` **không** phải
   pass; nó cần `signInWithPassword` nên **không headless-CI-safe** như `check-view-invoker.mjs`.
   Fallback: chọn kỳ có >1000 phiếu, hoặc dùng `reconcile-money-v2.mjs`.

**Các script sau PHẢI ĐƯỢC TẠO** (chưa tồn tại — đừng viết chúng vào gate như thể đã có):
`scripts/rehearse-sql.mjs` (refuse khi ref là production), `scripts/audit-special-fee-rollout.mjs`,
`scripts/audit-room-lifecycle-rollout.mjs`, `scripts/test-special-page-runtime.mjs`,
`scripts/test-special-fee-rules.mjs`, `scripts/test-special-fee-writer.mjs`,
`scripts/test-special-fee-concurrency.mjs`, `scripts/test-contract-transfer-segments.mjs`,
`scripts/test-termination-obligations.mjs`, `scripts/test-termination-refund-reads.mjs`,
`scripts/test-termination-refund-special-page.mjs`, `scripts/test-room-lifecycle.mjs`.
Mọi script preflight ghi timestamp, `organization_id`, query hash, và **digest của
`public.fee_type_matches` + `public.nrm_vn`** (mọi đếm fixed-kind và refund-like đều phụ thuộc hai hàm
này), rồi so **delta với baseline đã ghi** — không so bằng tuyệt đối (bảng dịch ~130 dòng/ngày).

Sau deploy mới chạy fleet:

```powershell
Set-Location .e2e-fleet
$env:FLEET_PASS_CHUNHA = '<runtime secret>'
$env:FLEET_PASS_KETOAN = '<runtime secret>'
$env:FLEET_PASS_QUANLY = '<runtime secret>'
$env:FLEET_WORKERS = '8'
npx playwright test specs/thanh-toan-page.spec.ts specs/utility-paste-receipt.spec.ts specs/special-fee-*.spec.ts specs/room-lifecycle.spec.ts
```

Hai spec đầu là **gate hồi quy của Slice −1** (chúng đang xanh và phải giữ xanh) — bản 29/07 không có
`thanh-toan-page.spec.ts` vì file đó chưa tồn tại lúc viết plan. Bảy spec mới mà hai plan đặt tên
**đều chưa tồn tại**. `.e2e-fleet` mặc định headless (`playwright.config.ts:15`), `FLEET_WORKERS`
default 8, `FLEET_BASE_URL` default `https://ptcrm.vercel.app`, `slowMo 350` chỉ khi `FLEET_HEADED`;
mật khẩu chỉ đến từ `FLEET_PASS_*` và thiếu thì throw tiếng Việt rõ ràng (`specs/auth.ts:19-23,:30-39`).
Không commit secret, không dùng `$env:` trong bash fence, không chạy headed nếu chủ không yêu cầu.

Ngoài lệnh tổng, gate bắt buộc phải có two-session test cho: hai slot CANARY cùng vượt daily cap;
special submit vs recurring; traditional item delete/reinsert không để claim stale; refund submit vs
manual edit/approve/post/reversal; canonical subject retry sau route OFF; list/preview/status
cross-org; status chunk 501 và 1201; legacy multi-month fan-out; recurring external occurrence
advance; `/deposits` không báo đã hoàn trước active posting và không dùng phòng hiện tại; **và mới:**
`0A000` của `dispatch_finance_decision_v2`; `25006` của read RPC khai STABLE; replay idempotency **không**
ném `23505`; ANNOTATE trên phiếu hoàn POSTED (quyết định của chủ, dù đường nào cũng phải có test).

Sau khi mở production route theo cohort: giữ canary/monitor ≥ 24 giờ, đối chiếu
duplicate/orphan/money drift **theo organization**. Bất kỳ drift nào ⇒ bật `force_freeze` để dừng
writer mới, **không** tự rơi về legacy. Nhắc lại: hôm nay **không có lệnh có kiểm toán nào** để bật
`force_freeze` (C-ROLL-1) ⇒ phải giải quyết trước khi tuyên bố có runbook rollback.

## 10. Giá trị owner phải cấu hình trước khi bật

Đây là dữ liệu vận hành, **không được đoán trong migration**. Thiếu một giá trị trả
`CONFIG_REQUIRED`, không fail-open, và **không tự lấy số lịch sử làm giá chuẩn** — điều này giờ là
luật cứng, vì `pay_period_fee` đang **ghi đè `building_fee_accounts.default_amount` bằng
`round(p_amount/months)` mỗi lần chi** (toà `1eae0e82…` đang có "giá dự kiến" điện = **9.507.910đ**,
đúng là một hoá đơn cũ, không phải mức phí).

| Hạng mục | Độ trống đo được 30/07 |
|---|---|
| Fixed amount từng toà/kind + tháng hiệu lực | **0/21 toà** khai đủ cả 7 loại. Org thật: 126 ô, 46 ô không có dòng, 1 ô amount NULL, 79 ô có amount ⇒ **~35/126 (28%)** là nợ thật sau khi trừ 12 ô `thang_may` ở toà `has_elevator=false` (cả 6 toà có thang máy đã khai đủ: 600k/500k/500k/650k/600k/500k). DEMO: **21/21 thiếu**. **`quan_ly` thiếu giá ở CẢ 21 ô của cả hai org** — lỗ lớn nhất, và bản 29/07 không nêu |
| Sổ quỹ mặc định | **0/109 dòng** `building_fee_accounts` có `default_account_id`. Ghi rõ: đây **không** gây "100% lỗi thiếu sổ" — 21/21 sổ org thật và 5/6 sổ DEMO có binding CUSTODIAN sống, actor chọn sổ lúc submit; `default_account_id` chỉ là prefill UI |
| ⚠ Chưa đo: `buildings.hidden_fixed_expenses` | Cột `text[]` trên 21 dòng `buildings`, **nội dung chưa đo**, và **không plan nào nhắc**. Đây có thể là cơ chế thật cho "toà này không có loại phí này" thay vì `building_fee_accounts.not_applicable` (**false trên cả 109 dòng**). **Cho tới khi chủ trả lời, 35–46 ô thiếu KHÔNG được gọi là nợ cấu hình** |
| Utility ceiling + max ratio từng toà × loại | Chưa có bảng; và phải chốt trước: ngưỡng tự duyệt **600.000đ** (org thật, đặt 29/07 09:39:56) — chưa rõ là chính sách hay nhầm, `updated_by 90450d5f`; DEMO 5.000.000đ |
| AC/washer standard + ceiling từng toà | Chưa có bảng. Bảng ánh xạ chủ phải duyệt là **200 phiếu / 31 tên**. Máy giặt chỉ **7 phiếu / 2 tên** ⇒ không đủ dữ liệu hồi quy |
| Commission tiers + `fallback_policy` | **21/21 toà đã khai, 21/21 đều hở**: chỉ phủ 5–6 và 10–12 tháng (18 toà dùng `[{5,6,50},{10,12,60}]`, 102LVT 70%, 44TL 80%, 1392QT `max_months` 13). Đã publish thì **152 HĐ** rơi đúng bậc (5th:25, 6th:6, 10th:10, 11th:56, 12th:55). Vùng hở cắn **48 HĐ ở 13–17 tháng** (13th:18, 14th:18, 17th:12) **+ 22 HĐ ở 7–9 tháng** nơi máy chủ suy ra 50%×tiền thuê còn trang hợp đồng trả **0đ** ⇒ `fallback_policy` là **load-bearing**, và import DRAFT không có nó sẽ **âm thầm đổi số đang hiển thị** cho 22 HĐ đó |
| Trần thưởng nóng Sale | Chưa có, và **chưa có bề mặt nào**: `PeriodCommissionModal.tsx:76` chỉ truyền `kind:'broker'`; 7 phiếu Sale hiện có đều từ trang hợp đồng |
| Real cashbook / evidence policy | **0 dòng `cashbook_closures`, 0 account có `lock_date`** ⇒ nhánh "kỳ đã đóng" chỉ kiểm được bằng ca dựng. Đối lại: **18 toà đã chốt lợi nhuận 05/2026** và **7/7 phiên bàn giao đã xác nhận** — hai tầng khoá này có dữ liệu thật và đang có hiệu lực |
| CANARY safety cap (max single, max daily actor/org, max operation count) | Chưa có bucket theo ngày/actor/org: `server_feature_flag_operations` = `{id, feature_key, config_version, operation_key, organization_id, amount_vnd, created_at}`, bộ đếm **không lọc org, không lọc ngày**, `p_actor_id` chỉ được hash vào `operation_key`. Nếu writer mới dùng chung bảng này thì **thêm vị ngữ `organization_id`** (tiền lệ version dùng chung: `income_expense.create_draft.v1` v5 = 14 op DEMO + 2 op org thật) |
| ~~Quyết định của chủ về 45 phiếu trùng cũ~~ — **ĐÃ CÓ 30/07: giữ nguyên, chỉ ghi nhận** (§1bis) | Còn lại là việc kế toán ngoài code: 4 cặp cùng số tiền, phơi nhiễm **164.500.000đ** (§1bis.2) |
| Quyết định của chủ về shortcut "Chi & duyệt" | Plan 1 định đưa hoa hồng về "tự duyệt + vào sổ ngay", **trong khi 23/07/2026 chính chủ đã quyết BỎ shortcut đó** và bắt duyệt tại `/thu-chi`. Cả ba plan doc **0 lần** nhắc `12.7` / `Chi & duyệt` / `create-then-approve` ⇒ **cần chủ ký lại tường minh** |

### 10.1 DEMO không diễn được một họ nào của Plan 1

Điều này không phải lý do chặn (plan đã bắt "owner publish config DRAFT→PUBLISHED và fixture cleanup"
trước DEMO CANARY, và giới hạn mọi fixture write vào `dddd0000-…0001` với org thật read-only), nhưng
**phải thành checklist có tên** ở Slice 5 chứ không nằm trong văn xuôi:

- **0 dòng** `building_fee_accounts` ở DEMO.
- 2 dòng `building_utility_accounts` với `provider_code` **NULL**.
- Không phiếu `utility.bill` sống (chỉ 2 dòng soft-deleted).
- **Không có type `'Quản Lý'`** ⇒ một khoản chi Quản Lý ở DEMO sẽ được ghi vào type **tiền lương**.
- Fixed amount đến từ bảng **mới** `special_fee_fixed_rule_versions`, rỗng ở **cả hai** org cho tới
  khi chủ publish (`building_fee_accounts` chỉ là DRAFT import).
- Đối lại, tiền đề sổ quỹ thì **ổn**: DEMO có **6 sổ sống, 5 sổ có binding CUSTODIAN**.

## 11. Giới hạn và cách báo cáo

### 11.1 Giới hạn của chính đợt kiểm toán này

- **Không có bất kỳ lần chạy browser/E2E nào** trong cả 10 mảng kiểm toán (mandate read-only). Mọi
  khẳng định về UI đều dựa trên dòng source + dữ liệu live + assertion của spec tracked, **không**
  dựa trên một trang đã render được quan sát. Mọi kết luận UI ở §4 phải được xác minh lại bằng
  Playwright trong Slice −1.
- Không có staging clone đầy đủ của production; project authz-staging không đủ dữ liệu tài chính.
- Số liệu live có thể trôi: đã đo `income_expenses` +32 dòng trong ~1 ngày, cộng hai rổ cọc dịch
  giữa 29/07 và 30/07 (org thật null-source POSTED 15→17 dòng / +5.000.000; DEMO null-source virtual
  13→18 dòng / +8.000.000).
- `supabase_migrations.schema_migrations` đã chết (`max_version='20260716170000'`) ⇒ **không** dùng nó
  để kết luận "đã apply chưa"; chỉ dùng catalog.
- Có **2 test `BuildingFilterSelect` đang đỏ** trên nhánh này; **chưa biết** chúng có đỏ trên
  `origin/main` (`31425d3`) hay không — kiểm việc đó cần checkout/diff làm bẩn cây làm việc.

### 11.2 Mười hai hạng mục phải đo lại (một query mỗi hạng mục) trước khi viết backfill/gate

1. **Slot điện/nước trùng** — hoà giải `(công tơ 02660728…, 07/2026, 4 phiếu, 7.308.077đ)` với
   `(công tơ fea1d2f4…, ELECTRIC, 05/2026 và 06/2026, 2 phiếu mỗi slot)` và
   `(toà d76268b2…, ELECTRIC, 05/06/07)`. Chốt khoá canonical **và** số đếm **trước** khi viết unique
   index + conflict backfill.
2. **Số tiền type `'Quản Lý'`** — 18.500.000 vs 90.500.000 trên cùng 43 phiếu. Báo **cả**
   `SUM(items.amount)` **và** `SUM(ie.total_amount)`; chênh lệch **chính là** khuyết tật §−1.4.
3. **Danh sách cột INSERT của `approve_contract_termination_v1`** — chỉ đọc được ~1.400 ký tự sau
   `v_refund`. Xác nhận nó có set `building_id/room_id/contract_id` (writer move-out thì có) và item
   có `accounting_class='PNL'` hay không.
4. **Xuất xứ 3 termination DEMO chỉ có `refund_date`** (`6837641f`, `46b88b9f`, `75debc04`) — cả RPC
   lẫn fallback client đã chết (`useContracts.ts:1147-1155`, 0 call site) đều set `refund_date`.
5. **Toàn bộ body `terminate_contract_forfeit_impl`** (13.983 ký tự) — các nhánh tiền khác (forfeit
   revenue / offset / extra invoice) chưa đọc.
6. **Digest live-vs-migration của `fee_type_matches` và `get_period_fee_status`** — chỉ
   `resolve_fixed_expense_type` được xác nhận khớp `20260728180000:944`. md5 tham chiếu đã có:
   `ensure_income_expense_type_v1 = b1880461933551ccf20011ebec66ddd3`,
   `normalize_income_expense_type_name = 7822a97fcc48128d4fe95d33ab2fb27c`.
7. **Trạng thái `account_id` của 3 phiếu `INVOICE_REFUND`-owned tại thời điểm approve** — giả thuyết
   giải thích vì sao bug posting-trùng qua `finance_v2_transition_owned_approval` **chưa nổ** (nếu
   `account_id` NULL thì `v_should=false` nên cầu a85 không post).
8. **Nội dung `buildings.hidden_fixed_expenses`** — quyết định 35–46 ô thiếu có phải nợ cấu hình hay không.
9. **Bên nào đúng cho 2 phiếu hoàn lệch số** (−978.500 và +500.000) — chứng minh được lệch, **không**
   chứng minh được nghiệp vụ coi số nào đúng; cần đọc dữ liệu invoice/cọc từng HĐ.
10. **2 test `BuildingFilterSelect` có đỏ trên `origin/main` không.**
11. **`role_permissions` của role "Super Admin"** — 18 binding active / 0 permission; chưa rõ 18 là 18
    binding hay 18 scope-edge của một binding, và sự rỗng đó có phải chủ ý.
12. **Revision browser Playwright** — cache có cả `chromium-1217` và `chromium-1228`;
    `@playwright/test 1.61.1` được pin nhưng **không gì** xác minh nó cần revision nào, và không có
    `postinstall`/`playwright install`.

### 11.3 Cách báo cáo

- Mọi count/sum phải phát **theo `organization_id`**, và so **delta với baseline đã ghi**, không so
  bằng tuyệt đối.
- Không `git push --force`, không tự merge remote diverged. Khi triển khai thật, stage **đúng**
  migration/code của slice — cây làm việc repo này thường xuyên có hàng chục file dở dang từ phiên khác.
- Tài liệu này **chưa** thực hiện migration/UI/test nào. "Production-ready plan" ở đây nghĩa là kế
  hoạch đã khớp hiện trạng đo được ngày 30/07 và có gate. Chỉ được tuyên bố feature hoàn tất sau khi
  chạy verification + browser theo `CLAUDE.md`, và với Slice −1 thì **bắt buộc** phải có bằng chứng
  browser vì toàn bộ §4 hiện chỉ được chứng minh bằng source + dữ liệu live.

---

## 12. ĐÃ THỰC HIỆN — Đợt −1 lên production 30/07/2026 (commit `80153a9`)

Mục này viết **sau** khi thi hành, nên nó thắng mọi câu "sẽ làm" ở trên khi hai bên lệch nhau.
§11.1 nói "chưa có lần chạy browser nào" — điều đó **đã hết đúng** cho Đợt −1; bằng chứng ở §12.4.

### 12.1 Đã ship gì, và bằng chứng không mất tiền

Hai migration `20260731010000_slice_minus1_readers.sql` + `20260731011000_slice_minus1_guards.sql`
đã apply lên prod: 14 hàm được định nghĩa, 3 trigger `a00_*` mới, 2 bảng sổ vết trong `app_private`.

**Bằng chứng tuân thủ ràng buộc §1bis ("giữ nguyên tiền, đừng đụng vào"):** chụp 9 bảng tiền
(`income_expenses`, `income_expense_items`, `posting_lines`, `invoices`, `payments`, `accounts`,
`contract_terminations`, ie_POSTED, ie_CANCELLED) ngay trước và ngay sau apply — **khớp tuyệt đối,
0 đồng dịch chuyển**. Baseline còn được chụp hai lần cách nhau 1 giờ để chắc prod đang tĩnh.

Gate: `check-view-invoker` 12/12 · `check-stable-fn-locks` OK · `typecheck:baseline` khớp 30
fingerprint · 27 test xanh · `gen:types` chỉ **8 dòng thêm** (3 khối đúng dự kiến, **không** kéo
theo drift `network_*` như CLAUDE.md cảnh báo).

⚠ `reconcile-money.mjs` trả **INCONCLUSIVE**, không phải pass: **không kỳ nào có >1000 phiếu**
(2026-06 nhiều nhất, 350) nên không kích được trần cap-1000 của PostgREST. Exit 0 nhưng vô nghĩa về
mặt chứng minh. Đừng ghi nhận nó là gate đã đạt.

### 12.2 GIẢI QUYẾT §11.2 hạng mục 1 — chốt phép đo canonical ô trùng

§11.2.1 đòi hoà giải ba con số đá nhau trước khi viết unique index. **Đã hoà giải.**

Nguyên nhân ba số khác nhau là **lưới tháng**, không phải dữ liệu khác nhau. Khoá canonical =
`(org, toà, hạng mục, THÁNG)`, mỗi item mở ra bằng
`generate_series(date_trunc('month', start_date) … end_date)` — đúng khoá mà khoá tư vấn của
`pay_period_fee` dùng. Population: APPROVED, `deleted_at IS NULL`, `type='EXPENSE'`. Tiền tính theo
**phiếu riêng biệt** (phiếu trải nhiều tháng chỉ đếm một lần).

| Phép đo | Ô | Lượt phiếu | Tiền |
|---|---|---|---|
| `quan_ly` CÒN gồm lương (hành vi trước A1) | 25 | 51 | 654.703.469đ |
| **`quan_ly` ĐÃ loại lương (sau A1) — CANONICAL** | **24** | **49** | **620.496.725đ** |

Phân rã: **21 ô `system_source` NULL + 3 ô `utility.bill` + 0 ô `fixed_fee`**.
Chỗ phép đo 23-ô bỏ sót, đã truy đích danh: **405PVB · công an · 07/2026** — `PC2606014`
(1.000.000đ) có item trải 01/06→31/07 nên rơi vào cả hai tháng; đối tác tháng 7 là `PC2607014`
**7.000đ**, đúng bằng chênh lệch 620.496.725 − 620.489.725 = **7.000đ**.

Cả 24 ô ở **org THẬT**, DEMO **không có ô nào**. Một ô 3 phiếu (Kho Văn Phòng Chung · tiền nhà ·
05/2026), 23 ô còn lại 2 phiếu. Ba mã phiếu **trùng nhau giữa các toà** (`PC2607076`, `PC2607006`,
`PC2607096`) — tái xác nhận mã phiếu duy nhất theo **người tạo**, không theo org.

### 12.3 ĐÍNH CHÍNH NẶNG — "2 ô điện trùng" ở 1392QT không phải trùng

§4 và các bản nháp trước gọi hai ô này là trùng lặp, rồi lấy chúng làm bằng chứng cho "cứ bấm lại là
một phiếu 6–15tr mới". **Sai.** Toà 1392QT có **hai hợp đồng điện thật**, cùng chủ hộ
"Hoàng Công Hiệp", hai mã khách hàng khác nhau:

| Công tơ | provider_code | Tạo lúc |
|---|---|---|
| `fea1d2f4` | PE13000241972 | 19/06/2026 08:32 |
| `70b8af72` | PE13000241924 | **08/07/2026 02:55** |
| `97959cff` | **NULL** (chủ hộ NULL) | 08/07/2026 02:43 — **đã xoá mềm** |

| Kỳ | Hoá đơn lớn | Hoá đơn nhỏ | Cách nhau | Công tơ |
|---|---|---|---|---|
| 05/2026 | PC2605090 14.324.839 | PC2605091 46.977 | **134 ms** | cùng `fea1d2f4` |
| 06/2026 | PC2606108 14.391.670 | PC2606107 29.998 | **214 ms** | cùng `fea1d2f4` |
| 07/2026 | PC2607050 12.299.364 | PC2607051 86.277 | 1,27 s | **KHÁC** nhau |

Khuôn hình là **một hoá đơn lớn + một hoá đơn nhỏ mỗi tháng, cùng một cú thao tác**. Tháng 05–06 cả
hai bị dồn vào công tơ duy nhất đang tồn tại; từ 08/07 khi công tơ thứ hai được khai thì hoá đơn nhỏ
đi đúng chỗ (nên 07/2026 **không** vi phạm khoá). Trùng do bấm lại sẽ cho hai số **xấp xỉ bằng nhau**
— không phải 14.324.839 vs 46.977. Đây là **gán sai công tơ trên dữ liệu lịch sử**, không phải tiền
chi hai lần. Công tơ `97959cff` (provider_code NULL, tạo 02:43 rồi xoá mềm) là bằng chứng **trực
tiếp** của lỗi tự-sinh-công-tơ (§−1.2), mạnh hơn suy luận "toà d76268b2 có 2 công tơ ELECTRIC".

**Hệ quả đã xử:** khoá B1 khoá theo `(công tơ, tháng)`, nên nếu người dùng 1392QT giữ tay cũ — đóng
cả hai hoá đơn dưới `fea1d2f4` — phiếu thứ hai bị từ chối `55000`, mà họ **thật sự có** hoá đơn thứ
hai cần trả. Câu lỗi nay **nêu mã khách hàng công tơ** và thêm gợi ý khi toà có nhiều công tơ cùng
loại. Đã render thật:

> `[UTILITY_BILL_DUPLICATE]` Kỳ 08/2026 của công tơ **PE13000241972** ĐÃ CÓ phiếu chi PC… —
> 12.299.364đ (đã duyệt). … **Lưu ý: toà này có 2 công tơ điện.** Nếu hoá đơn bạn đang trả thuộc
> công tơ khác thì hãy chọn đúng công tơ đó rồi đóng lại.

Kết luận "không tạo được UNIQUE INDEX" **vẫn đúng** (2 dòng vi phạm) — chỉ khác lý do.

### 12.4 Bằng chứng browser (bù đúng khoảng trống §11.1 nêu)

Chạy ẩn trên `https://ptcrm.vercel.app`, tài khoản chủ, org THẬT (chỉ đọc):

- **`/deposits`** — KPI **"Đã hoàn cọc (tiền đã ra khỏi két)" = 28.039.100 ₫**, phụ đề "10 phiếu hoàn
  đã duyệt & vào sổ" ⇒ **quyết định D1 của chủ (§1ter.1) đã sống**. Dòng cảnh báo mồ côi hiện đúng:
  *"Trong đó **23.737.100 ₫** (8 phiếu) đã ra khỏi két nhưng **KHÔNG có hồ sơ thanh lý** — bảng
  'Hoàn / Bỏ cọc' bên dưới chỉ liệt kê được 4.302.000 ₫ (2 phiếu · 2 hồ sơ). Ghi nhận để rà tay, hệ
  thống KHÔNG tự sửa."* — đối chiếu đủ **cả hai đơn vị** (phiếu và hồ sơ). **0 lỗi console.**
- **`/thanh-toan`** — spec `thanh-toan-page.spec.ts` **7/7 xanh**. Kỳ 06/2026 render dữ liệu thật
  (185 khoản · 6 toà · 146 khoản đã có phiếu duyệt · 970.779.008đ đã chi). **0 lỗi console.**
- **Cửa thoát B2 đã hiện thật:** nút **"Tạo công tơ"** render trên tab Điện & Nước cho mọi dòng
  "Chưa khai công tơ" (nhiều toà). Trước đây chỉ được kiểm bằng đọc source.
- **Khoảng trống còn lại, nói thẳng:** hiệu ứng số của A2 lên hai ô `dien`/`nuoc` (phiếu
  `5916661a` 6.384.000đ tách thành Điện 5.758.000 + Nước 626.000) **chưa** quan sát được trên UI —
  `/thanh-toan` gộp Điện & Nước thành khối theo công tơ, không có ô phí cố định riêng cho hai hạng
  mục đó. Hiệu ứng này được chứng minh bằng **đo lại SQL độc lập** (đúng 3 ô đổi, đều giảm, khớp số
  ở §−1.4), **không** bằng mắt. `get_period_fee_status` đòi `auth.uid()` nên không gọi được qua
  Management API.
- Kỳ 07/2026 hiện 0 khoản / 0 toà là **đúng**, không phải lỗi: chưa toà nào được khai giá
  (0/21, xem §10) nên không có khoản dự kiến nào để so.

### 12.5 Phân định spec đỏ — không phải hồi quy của Đợt −1

| Spec | Kết quả | Nguyên nhân |
|---|---|---|
| `thanh-toan-page` | **7/7 xanh** | — |
| `finance-v2` ×3 | đỏ | **Pre-existing.** Khớp chính xác bản ghi phiên trước (đã xác minh bằng `git stash` + chạy trên `origin/main` sạch): một `42501 income_expenses.approve required in scope`, hai timeout tìm nút. Không đi qua hàm nào Đợt −1 định nghĩa. |
| `ie-create` (ketoan) | đỏ khi 8 worker, **xanh khi chạy riêng** | **Flaky do song song**, không phải hồi quy. Chạy lại đơn lẻ: `create path = CANONICAL (200)`. |
| `utility-book-menu` ×3 | đỏ | **Spec đã cũ, không phải Đợt −1.** Fixture `seedBooks()` INSERT thẳng REST vào `public.accounts`, mà `20260730102000_money_tables_revoke_dml.sql` (10:20 cùng ngày, **việc khác**) đã REVOKE INSERT/UPDATE/DELETE khỏi `authenticated`. Hiện `authenticated` chỉ còn `SELECT`. Cần sửa fixture sang RPC. |

Đối chiếu để phân định: cả hai migration Đợt −1 **không có** một câu GRANT/REVOKE nào trên bảng
`accounts`, và 14 hàm chúng định nghĩa **không** gồm `approve_income_expense_v2` hay bất kỳ helper RBAC.

### 12.6 HẠNG MỤC MỚI, chưa nằm trong plan nào — chốt trùng cho writer phiếu CHUNG

Đây là lỗ **Đợt −1 không che**, phải nói rõ để không ai ghi nhận nhầm là đã bịt. Writer chung
(`create_income_expense_v1` / `_v2`, `system_source` NULL) **không có bất kỳ chốt slot nào**.

Đã phân loại 24 ô theo *số tiền có bằng nhau không* để thiết kế mà không đoán:

**Nhóm 1 — 4 ô SỐ TIỀN BẰNG NHAU, tất cả `tien_nha`, tất cả `system_source` NULL (164.500.000đ):**

| Toà | Kỳ | Tiền ×2 | Cách nhau | Người tạo |
|---|---|---|---|---|
| 102LVT | 06/2026 | 66.000.000 | **460 ms** | **1 người** |
| 32PVC | 07/2026 | 26.000.000 | ~13,9 giờ | 2 người |
| 405PVB | 07/2026 | 52.500.000 | ~8,4 ngày | 2 người |
| 15KV | 07/2026 | 20.000.000 | ~9,4 ngày | 2 người |

**Hai bệnh khác nhau, đừng chữa bằng một thuốc:** 102LVT là **bấm đôi**; ba ô kia là **hai người
cùng trả một tháng tiền nhà, cách nhau nhiều ngày** — không ai biết đồng nghiệp đã trả.

**Nhóm 2 — 20 ô SỐ TIỀN KHÁC NHAU ⇒ HỢP LỆ, TUYỆT ĐỐI KHÔNG ĐƯỢC CHẶN.** Ví dụ 405PVB công an
07/2026 = 1.000.000đ + **7.000đ**; 15KV rác 06/2026 = 300.000đ + 120.000đ. **Khoá cứng theo ô sẽ chặn
oan 20/24 trường hợp** — đây là lý do không được copy khuôn B1 sang đây.

**Công cụ đã có nhưng đang bỏ không:** cột `income_expenses.idempotency_key` **đã tồn tại**; 42 phiếu
có key và **cả 42 key phân biệt** ⇒ tạo được partial UNIQUE INDEX **ngay, 0 xung đột**. Nhưng hiện
**không có unique index nào** trên cột đó (key chỉ là trang trí), và writer thủ công chỉ gửi key ở
**28/1.239 phiếu (2,3 %)**:

| system_source | phiếu | có key |
|---|---|---|
| **NULL (writer thủ công)** | **1.239** | **28** |
| contract.deposit | 287 | 0 |
| invoice.collection.v5 | 10 | 10 ✅ |
| invoice.collection.reverse.v5 | 3 | 3 ✅ |
| contract.create.v2 | 1 | 1 ✅ |
| 8 nguồn còn lại (`termination.*`, `salary.*`, `handover.*`) | — | **0** |

**Đề xuất 3 bước, không đụng một đồng dữ liệu cũ:**
1. `CREATE UNIQUE INDEX … ON income_expenses (idempotency_key) WHERE idempotency_key IS NOT NULL`
   — thuần bổ sung, 0 xung đột. **Cần nhưng chưa đủ** (97,7 % phiếu thủ công không gửi key).
2. Frontend gửi `p_idempotency_key` dẫn xuất từ nội dung form ⇒ bịt hẳn ca 460 ms.
3. Trong writer: khoá tư vấn theo ô + **cảnh báo mềm** (không chặn) khi ô đã có phiếu APPROVED **cùng
   số tiền** — trả payload để UI hỏi lại *"Toà X đã có phiếu tiền nhà 07/2026 — 26.000.000đ do
   <người> tạo <ngày>. Vẫn tạo phiếu thứ hai?"*. Bắt đúng nhóm 1, **không** đụng nhóm 2.

### 12.7 Còn nợ sau Đợt −1

- **§11.2 hạng mục 1 → ĐÃ XONG** (§12.2). Hạng mục 10 (`BuildingFilterSelect` có đỏ trên `main`?)
  → **đã xong ở phiên trước**: đỏ sẵn trên `main`, không do các đợt này.
- Năm hàm khác **vẫn** so vai trò chủ theo chuỗi `'Chủ sở hữu tổ chức'`
  (`set_ie_auto_approve_threshold_v1`, `get_ie_auto_approve_threshold_v1`,
  `set_ie_accounting_standard_v1`, `set_membership_status_v1`, `_termination_ensure_type`).
  Đợt −1 **chặn đổi tên** ở tầng trigger thay vì neo lại cả năm hàm (đổi thân hàm tiền/authz đang
  drift so với migration là ngoài phạm vi). Rủi ro còn lại là migration/script `service_role` tương
  lai, không phải đường client — `authenticated` chỉ có `SELECT` trên `organization_roles`.
- Đợt 4 vẫn dừng ở chủ: **0/21 toà được khai giá**, 0/109 sổ quỹ mặc định (§10).
- Đợt 9 giữ cửa kiểm "24 giờ không lệch tiền" — không rút ngắn được.

---

## 13. BƯỚC KẾ TIẾP ĐÃ LÀM — Cài đặt phí + cảnh báo trùng ô (30/07/2026)

Mục này ghi hai việc làm sau §12, và **đính chính ba khẳng định sai** của chính tài
liệu này. Chủ đặt đúng câu hỏi khiến chúng lộ ra: *"sao không để mục cài đặt cho tôi
tự cập nhật, còn test thì dùng dữ liệu mẫu?"* và *"sổ quỹ mặc định là gì nữa? mỗi
thanh toán có nút chọn sổ mà"*.

### 13.1 ĐÍNH CHÍNH — ba thứ §10 gọi là "cửa chặn" thì KHÔNG phải

| §10 nói | Đo lại 30/07 | Thực tế |
|---|---|---|
| "0/21 toà được khai giá" | org thật **109/162 ô đã khai, 107 ô CÓ giá** | **SAI HẲN.** Còn `pay_period_fee` **tự học** `default_amount` theo kỳ mỗi lần đóng, nên ô trống tự điền dần |
| "0/109 sổ quỹ mặc định" | `pay_period_fee` **ghi** nó first-write-wins và **KHÔNG BAO GIỜ đọc lại** | **KHÔNG phải cửa chặn.** Mỗi lần thanh toán vẫn là picker sổ người chi thấy được; không truyền thì server lấy sổ "…Thu" của chính họ |
| Đợt 4 "chờ chủ khai giá" | thiếu là **chỗ để xem/sửa gọn**, không phải dữ liệu | Việc thật: 53/162 ô chưa khai + không có trang nào xem toàn cảnh |

⇒ Bài học: đừng gọi "thiếu dữ liệu" khi thật ra là "thiếu màn hình". Và trước khi
liệt kê một thứ vào danh sách chặn, phải kiểm **ai đọc nó** — `default_account_id`
có 4 hàm chạm tới nhưng **không hàm nào đọc để chọn sổ**.

### 13.2 Trang Cài đặt "Phí cố định theo toà" — `/settings/finance/fixed-fees`

Ma trận **toà × 9 hạng mục**, sửa tại chỗ giá / mã khách hàng / chủ hộ, bật-tắt
hạng mục, lọc "chỉ hiện toà còn thiếu giá". Gate `thu_tien/collect` (trùng
`/thanh-toan`); server vẫn kiểm từng toà trong `upsert_building_fee_account`.

Điểm quyết định: `get_fee_config_matrix_v1` trả **CẢ ô CHƯA khai**. Trước đây ô
trống là **vô hình** nên không ai biết mình còn nợ cấu hình — đó là lý do 53 ô kia
nằm im. Kèm `last_voucher_date` / `voucher_count` để phân biệt ô đang chạy thật với
ô khai rồi chưa dùng.

Đọc trên web (org thật + DEMO): **182 ô cần khai · 129 đã có giá · 53 còn thiếu ·
127 đang chạy thật · 7 đã tắt**. Bốn số này khớp chéo: 21 toà × 9 = 189, trừ 7 tắt
= 182; 107 (thật) − 1 (ô vừa tắt) + 23 (DEMO seed) = 129; 182 − 129 = 53. ✅

### 13.3 HAI LỖI THẬT tìm được khi dựng trang

**(a) Cờ "Không áp dụng" ĐỌC MỘT NƠI GHI MỘT NƠI.** RPC ghi vào
`buildings.hidden_fixed_expenses` (tự khai là nguồn duy nhất), giao diện lại đọc cột
`building_fee_accounts.not_applicable` — **0/109 dòng true, không ai ghi vào đó**.
Trong khi `hidden_fixed_expenses` có **6 mục thật ở 4 toà**: 403PVB [nuoc, ve_sinh],
65NTG [cong_an, ve_sinh], 405PVB [nuoc], 1392QT [nuoc]. ⇒ đúng những ô chủ đã tắt
lại hiện "đang áp dụng". Nay đọc từ nguồn duy nhất; migration đồng bộ cột cache
(**1 dòng** đổi — 5/6 ô bị tắt chưa từng khai dòng cấu hình nào), và RPC giữ nó khớp
sau mỗi lần ghi. Đo sau khi test qua UI: **lệch cache = 0** ở cả 3 toà DEMO.

**(b) KHÔNG XOÁ ĐƯỢC giá gõ sai.** Upsert dùng `COALESCE(mới, cũ)` cho cả 4 cột nên
NULL = giữ nguyên. Gõ 1.500.000 thành 15.000.000 là con số đó ở lại **vĩnh viễn** và
mỗi kỳ lưới phí lại mời đóng theo nó. Thêm `p_clear_amount` / `p_clear_provider` /
`p_clear_account` (cờ xoá **thắng** giá trị truyền kèm).
⚠ **KHÔNG** đổi `COALESCE` thành gán thẳng: `pay_period_fee` dùng **cùng khuôn
ON CONFLICT** và chỉ truyền vài cột (mục "Học cấu hình", `20260731011000:761`) —
gán thẳng sẽ khiến **mỗi lần đóng tiền xoá sạch** các cột nó không truyền.

Test đầu-cuối trên web, chỉ ghi org DEMO: nhập `"1.234.000"` (có dấu chấm) → lưu
đúng `1234000`; bấm xoá → giá về `null` mà **mã khách hàng vẫn còn** (đúng ngữ nghĩa
theo cột); tắt rồi bật lại hạng mục → cache khớp. **0 lỗi console.**

### 13.4 ĐÍNH CHÍNH §12.6 — hai đường tôi định bịt thì ĐÃ ĐÓNG SẴN

Trước khi viết một dòng nào, đo lại trên prod:

1. **"Bấm đôi" KHÔNG tái diễn được.** `create_income_expense_v1` **bắt buộc**
   idempotency key (kiểm định dạng 8–200 ký tự ASCII rồi claim vào
   `app_private.canonical_write_operations` bằng `ON CONFLICT` — chính nó gọi đó là
   *linearization point*); `create_income_expense_v2` ném `22023` nếu thiếu
   `idempotencyKey`.
2. **Đường POST THẲNG `/rest/v1/income_expenses`** — thứ **đã** sinh cặp 66.000.000đ
   ở 102LVT cách nhau 460 ms — nay `authenticated` **KHÔNG còn** INSERT/UPDATE/DELETE
   trên `income_expenses` lẫn `income_expense_items`
   (`20260730102000_money_tables_revoke_dml.sql`, 10:20 cùng ngày).

⇒ **BỎ** đề xuất `CREATE UNIQUE INDEX` trên `income_expenses.idempotency_key` ở
§12.6 bước 1: cột đó chỉ là bản sao phi chuẩn hoá (45/45 key phân biệt), còn chốt
thật nằm ở sổ canonical và **mạnh hơn**. Không thêm index nào.

### 13.5 Phần CÒN HỞ thật → cảnh báo "ô này đã có phiếu"

3/4 ô "cùng số tiền" **không phải bấm đôi** mà là **HAI NGƯỜI cùng trả một tháng,
cách nhau nhiều ngày**. Idempotency tuyệt đối không cứu được: khác người, khác phiên,
khác key — mỗi phiếu tự nó hợp lệ. Đây là lỗi **PHỐI HỢP**, thuốc đúng là **cho
người ta THẤY**, không phải chặn.

`get_voucher_slot_warning_v1(toà, loại[], kỳ, INCOME/EXPENSE, trừ-id)`:
- Khoá ô theo **`income_expense_type_id`**, KHÔNG theo 9 hạng mục phí cố định — lỗi
  này xảy ra với bất kỳ khoản định kỳ nào, và form chung không biết khái niệm "phí
  cố định".
- **ĐẾM CẢ `UNAPPROVED`**: phiếu chờ duyệt là phiếu người khác **không thấy** trên
  các bảng lọc APPROVED — chính là nguyên nhân người thứ hai tạo lại.
- Lọc theo quyền toà ⇒ không thành kênh soi phiếu toà mình không được xem.
- `p_exclude_id` để lúc SỬA phiếu không tự cảnh báo về chính nó.
- `VOLATILE` theo án lệ 25006.
- Preflight của migration **RAISE** nếu `authenticated` được cấp lại INSERT thẳng
  bảng — lúc đó cảnh báo mềm không còn đủ và phải biết mà xử.

**KHÔNG chặn nút Lưu**: 20/24 ô trùng trên prod có số tiền **khác nhau** và đều hợp
lệ (405PVB công an 07/2026 = 1.000.000đ + 7.000đ; 15KV rác 06/2026 = 300.000đ +
120.000đ). Chặn cứng là **chặn oan 20/24**.

**Bằng chứng browser trên chính ca thật** (405PVB · Tiền nhà · kỳ 07/2026):

> Toà này đã có 2 phiếu cùng hạng mục cho kỳ đang chọn
> `PC2607063` · 52.500.000đ · Tiền nhà · **NATHAN** · 2026-07-11
> `PC2607077` · 52.500.000đ · Tiền nhà · **NG TÂM** · 2026-07-02
> *Kiểm tra xem khoản này đã được trả chưa. Nếu đây là khoản khác thì cứ tạo bình
> thường — hệ thống không chặn.*

Đúng thông tin NATHAN cần thấy hôm 11/07 để không tạo phiếu thứ hai. Form đã bấm Huỷ,
không lưu gì.

### 13.6 Một lỗi server ĐÃ XÁC NHẬN nhưng CHƯA sửa

`create_cashbook_v1` **deadlock `40P01`** khi nhiều phiên cùng tạo sổ quỹ trong một
org: 3 worker xanh 4/4, **6 worker đỏ đều đặn 1/4** với
*"Process A waits for ShareLock on transaction X; blocked by B. Process B waits …
blocked by A."* Thứ tự khoá trong thân hàm: `SELECT … FOR SHARE` trên `buildings` →
`app_private.lock_org_for_decision_v1(org)` → `INSERT canonical_write_operations
ON CONFLICT DO NOTHING` → `SELECT … FOR UPDATE` chính dòng đó.

Sửa đúng phải nằm **TRONG hàm** (thống nhất thứ tự khoá) — là thay đổi trên writer
đụng tiền nên **tách làm riêng**, không vá vội. Ở E2E thì `40P01` là lỗi tạm thời nên
thử lại là cách xử lý đúng (8 lần, backoff **có jitter** — không jitter thì hai phiên
cùng ngủ rồi cùng thức và deadlock lại y như cũ; `idempotency_key` giữ nguyên nên
không thể sinh sổ thứ hai). Sau vá: **4/4 xanh ba lần liên tiếp ở 6 worker.**
⚠ Người dùng thật vẫn có thể gặp nếu hai người thêm sổ cùng lúc.

### 13.7 Trạng thái sau bước này

Đã lên prod, tiền không đổi ở mọi lần apply (9 bảng khớp tuyệt đối):
`20260731020000_fee_config_clearable.sql` · `20260731030000_voucher_slot_warning.sql`.
Gate: typecheck baseline khớp 30 fingerprint; vitest **2044 xanh / 2 đỏ**
(`BuildingFilterSelect` đỏ sẵn trên `main`); `thanh-toan-page` 7/7;
`utility-book-menu` 4/4.

Còn nợ: (1) sửa thứ tự khoá `create_cashbook_v1`; (2) Đợt 1–2 (nền dùng chung với
công tắc tắt, audit chuyển phòng); (3) Đợt 5/7/8/9 vẫn chờ cửa canary nhiều ngày —
không rút ngắn được.

---

## 14. ĐỢT 1 & ĐỢT 2 — đã lên production 30/07/2026

Tất cả ship ở trạng thái **route OFF / 0 caller** hoặc **chỉ đọc**, nên không cái nào
tự sinh bút toán. Mọi lần apply đều chụp 9 bảng tiền trước/sau: **không đổi**.

| Migration | Nội dung | Kiểm chứng |
|---|---|---|
| `20260731040000_fix_org_lock_upgrade_deadlock` | Khoá org `FOR SHARE` → `FOR NO KEY UPDATE` | 8 worker ×3 → 4/4 xanh, 0 retry |
| `20260731050000_contract_transfer_audit_hardening` | `transfer_room` + `apply_contract_transfer` fail-closed, index composite | 8/8 phép kiểm |
| `20260731051000_room_residence_segments` | Đoạn cư trú + chẩn đoán xung đột | 12/12 phép kiểm |
| `20260731060000_realtime_lifecycle_tables` | 2 bảng vòng đời vào publication | test chốt chặn 23/23 |
| `20260731061000_org_timezone_today` | `organization_timezones` + `org_today_v1` | mô phỏng 18:00 UTC lệch 1 ngày |
| `20260731062000_post_voucher_with_source` | Lõi ghi sổ dùng chung | review 17 agent + 8/8 hành vi |
| `20260731063000_signed_deposit_basis` | Cơ sở cọc dùng chung | chạy trên 321 HĐ thật |
| `20260731064000_special_page_submit_context` | Context submit dùng chung | 8/8 hành vi |

### 14.1 Deadlock 40P01 — bẫy nâng khoá, ảnh hưởng 41 hàm ghi

`lock_org_for_decision_v1` khoá dòng `organizations` bằng `FOR SHARE`, còn trigger
`a10_bump_authz_version` lại `UPDATE organizations` khi writer chạm ba bảng phân
quyền ⇒ hai phiên cùng org đều phải **nâng** khoá lên độc quyền và chờ chéo.

Sửa: `FOR NO KEY UPDATE` — đúng mode câu UPDATE kia cần, lấy sẵn từ đầu là hết phải
nâng. **Không** dùng `FOR UPDATE` (mạnh quá mức, chặn cả FK check `FOR KEY SHARE`).
Thông lượng không xấu đi: các writer này vốn đã tuần tự hoá tại chính câu UPDATE của
trigger; đổi này chỉ dời điểm xếp hàng lên sớm hơn.

**Khuôn lỗi để nhận ra chỗ khác:** thấy `FOR SHARE` rồi sau đó cùng transaction có
UPDATE/DELETE lên **cùng dòng** (kể cả qua trigger). Tái hiện bằng cách tăng luồng —
3 luồng xanh mà 6 luồng đỏ đều đặn, nên **test ít luồng sẽ bỏ sót**.

### 14.2 Đợt 2 Task 0 — audit chuyển phòng từng là "best-effort"

Khối INSERT `contract_transfers` bọc `EXCEPTION WHEN OTHERS THEN NULL` kèm chú thích
"audit best-effort, không chặn nghiệp vụ". Nghĩa là hợp đồng ĐÃ sang phòng mới, phòng
cũ ĐÃ thành trống, phòng mới ĐÃ thành có người — mà **không một dòng nào ghi lại**.

Cùng đó: không `FOR UPDATE` hợp đồng; kiểm phòng đích là SELECT trần nên **hai hợp
đồng cùng vào một phòng đều lọt**; không chặn chuyển chéo toà. Đường duyệt tay còn
**ghi đè `start_date`/`end_date`** và đặt `TRANSFERRED` + `parent_contract_id` cho cả
ROOM_CHANGE — làm một hợp đồng CÒN HIỆU LỰC biến mất khỏi mọi danh sách ACTIVE.

Chọn **phương án (A)** của plan Step 2b: giữ trigger nhưng ép fail-closed và ép cùng
hình dạng dữ liệu với đường A. Không chọn (B) tắt trigger vì nếu có UI nào đang cho
duyệt DRAFT→APPROVED thì tắt biến hành động đó thành **không làm gì trong im lặng**.

⚠ Dấu hiệu nhận đường B mà plan §Step 3 mô tả (`status='TRANSFERRED'` +
`parent_contract_id`) **đã hết đúng** kể từ chính bản vá này. Phân biệt bằng
`contract_transfers.status`: `COMPLETED` = đường A (RPC), `APPROVED` = đường B.

### 14.3 `org_today_v1` — `CURRENT_DATE` sai 7 giờ mỗi ngày

Server chạy **UTC**, Việt Nam UTC+7 ⇒ trong **00:00–07:00 giờ VN**, `CURRENT_DATE`
trả về **ngày hôm qua**. **36 hàm** đang dùng nó. Mô phỏng 18:00 UTC:
`CURRENT_DATE` = 30/07 còn `org_today_v1` = **31/07**.

Bug vô hình nếu chỉ thử vào giờ hành chính — đó là lý do nó sống lâu.
⚠ **Đợt 1 CHỈ dựng primitive.** 36 hàm kia chưa chuyển; đó là đổi hành vi ngày tháng
của nghiệp vụ đang chạy, phải làm theo nhóm có bằng chứng trước/sau.

### 14.4 Lõi ghi sổ dùng chung — review tự chạy bắt 1 BLOCKER + 5 lỗi

Tự chạy review đối kháng (3 lens + phản biện từng phát hiện, **17 agent**) trước khi
apply. Nó bắt được, trong code tôi vừa viết:

1. **BLOCKER** — hai hàm chốt kỳ nằm ở `app_private`, tôi viết `public.` ở **cả bốn
   chỗ**. Preflight sẽ chặn ⇒ file không apply được; nếu ai gỡ preflight thì thân hàm
   ném `42883` ở mọi lời gọi. **Tự kiểm của tôi KHÔNG bắt được** vì so chuỗi trần nên
   khớp luôn tên sai schema — an toàn giả.
2. Lõi chịu ghi sổ cho phiếu **CANCELLED và CHƯA DUYỆT** (chỉ soi `deleted_at`);
   prod có 256 phiếu như vậy.
3. Tự kiểm thứ tự **luôn đỗ** khi cái kim biến mất: `position()` trả 0 và `0 > N`
   luôn sai.
4. Tiền thối ≠ 0 mà thiếu sổ đối ứng ⇒ **rơi khỏi `net_cash_effect` không tiếng động**.
5. `p_amount_basis` tự do trong khi cột có CHECK ba giá trị ⇒ `23514` thô.
6. Mệnh đề "0 caller" quét cả comment ⇒ một dòng TODO cũng abort, và tự khoá đường
   quay lại khi Đợt 5 thêm adapter.

Tự tìm thêm trước review: **1.906 phiếu đã có POSTING gen=1** với
`external_source_kind` NULL nên phép kiểm replay không bắt được ⇒ thiếu chốt chặn thì
chết bằng `23505` thô.

Cũng đính chính: `ux_ie_postings_external_source` **không** gác được khi
`ext_line_id` NULL (btree coi NULL khác NULL) — khoá replay THẬT là
`ux_ie_postings_org_idempotency`.

### 14.5 Cơ sở cọc — và một việc cần rà tay

`resolve_signed_contract_deposit_basis_v1` chạy trên **321 hợp đồng thật**:

| Trạng thái | HĐ | Số tiền |
|---|---|---|
| `RECOGNIZED_ONLY` | **245** | **1.039.109.500đ** chỉ ghi nhận trên sổ ảo, **chưa từng vào két** |
| `OK` | 46 | đang giữ thật 182.037.990đ |
| `NO_SOURCE` | 22 | — |
| `NEGATIVE_HELD` | **8** | **đã chi ra thật 20.104.100đ trong khi thu thật = 0** |

Tám hợp đồng `NEGATIVE_HELD`: 481NVK/09 2.852.000đ `PC2607104` · 481NVK/01
2.090.000đ `PC2606198`+`PC2606199` · 417LVT/L04 1.450.000đ `PC2607119` · 158PVC/MB
1.412.500đ `PC2606201` · 331PHI/402 955.400đ `PC2606062` · và 3 HĐ nữa.
**Chủ đã ghi nhận và tự xử lý.**

Gốc: backfill cọc đầu kỳ 28/07 đưa ~998tr lên **sổ ảo** cho đủ sổ sách, sổ quỹ thật
không đổi. Cọc đến từ **12 nguồn** khác nhau kể cả `system_source` NULL ⇒ nhận diện
theo TÊN LOẠI, khoá theo nguồn là bỏ sót ngay.
`netHeld = realPostedIn − postedReleaseOut`, **cố ý không cộng** rổ ghi nhận;
self-check chặn cứng việc ai đó sau này cộng nhầm.

### 14.6 Context submit — thứ tự là bản thân tính đúng đắn

**Idempotency LOOKUP đứng TRƯỚC MỌI THỨ.** Nếu kiểm quyền/hạn mức/kỳ trước thì một
thao tác ĐÃ hoàn tất hợp lệ khi gọi lại (mạng chập, bấm lại) sẽ ăn lỗi mới — "kỳ đã
khoá", "hết hạn mức canary" — dù chẳng còn gì để làm. Test chứng minh tính chất này
bằng ca khó nhất: **replay thắng cả khi sổ quỹ truyền vào là SỔ ẢO**.

Chặn **sổ ảo** là mắt xích hay quên nhất, và là lý do context tồn tại: năm writer sắp
tới đều phải làm y hệt chuỗi kiểm, mỗi bản chép là một cơ hội quên.

### 14.7 Còn lại — và vì sao

- **Nhánh CASE dispatcher**: thuộc về chính các adapter (Đợt 3/5). Thêm nhánh rỗng bây
  giờ không tăng an toàn — `ELSE` hiện tại đã nêu đúng tên adapter chưa nối.
- **Chuyển 36 hàm sang `org_today_v1`**: đổi hành vi ngày tháng của nghiệp vụ đang
  chạy, phải theo nhóm có bằng chứng trước/sau.
- **Đợt 3–9**: cần chính các adapter, và Đợt 5/7/8/9 có cửa kiểm **24 giờ không lệch
  tiền** trên canary — đây là thiếu THỜI GIAN CHẠY THẬT, không phải thiếu review.

---

## 15. TÁI ĐỊNH PHẠM VI CỬA KIỂM — tôi tự dựng DEMO, tự chạy, không dừng hỏi chủ

Chủ yêu cầu 30/07/2026: *"bạn kiểm tra lại thật kỹ plan, tối ưu lại cho bạn là người
tự bật demo test toàn diện để làm từ đầu đến cuối không dừng lại hỏi tôi nữa"*.

Mục này **thay thế cột "Gate chuyển slice" của §7** cho mọi đợt còn lại.

### 15.1 Ba lỗi định phạm vi của bản cũ

| Bản cũ viết | Sai ở đâu | Bản mới |
|---|---|---|
| "chủ phải khai giá / bậc hoa hồng / trần thưởng" | Lẫn giữa **xây + kiểm** với **bật cho org thật**. Muốn xây và kiểm thì chỉ cần dữ liệu ĐẠI DIỆN, mà DEMO tôi tự seed được | Tôi seed DEMO đủ mọi hình dạng, kể cả ca biên. Số của org THẬT chỉ cần khi BẬT cờ cho org thật |
| "cần người dùng thật bấm" | DEMO là tenant đầy đủ; tôi có 3 tài khoản (`chunha`/`ketoan`/`quanly`) và lái được UI thật | Tôi tự đăng nhập, tự bấm, tự đọc kết quả — như đã làm với Đợt 3 |
| "24 giờ không lệch tiền" | 24 giờ dùng lai rai **YẾU HƠN** một loạt thao tác dồn dập có đối chiếu. Thời gian không phải thứ chứng minh; **số phép toán** mới là | Trên DEMO: chạy **kịch bản dồn** (≥50 thao tác, có song song, có huỷ/đảo) rồi đối chiếu 9 bảng tiền. Chỉ giữ mốc 24 giờ cho lần mở org THẬT |

### 15.2 Cửa kiểm mới — mọi đợt, tôi tự chạy hết

**Áp cho MỌI đợt (không đợt nào miễn):**
1. Chụp 9 bảng tiền trước/sau mỗi lần apply, phải khớp tuyệt đối
2. `check-stable-fn-locks` · `check-view-invoker` · `check-definer-acl` · `typecheck:baseline`
3. Migration **chạy lại được** — apply hai lần liên tiếp
4. Test hành vi SQL trên DEMO, kết thúc bằng `RAISE` để **rollback sạch**
5. **Tự lái UI thật** bằng tài khoản DEMO — không kết luận "xong" khi chưa bấm
6. Dọn fixture, chứng minh bằng truy vấn đếm còn lại = 0
7. Tự chạy **review đối kháng** trước khi apply bất cứ thứ gì đụng đường tiền

**Riêng từng đợt:**

| Đợt | Tôi tự làm gì để chứng minh |
|---|---|
| **4** Cấu hình | Seed DEMO đủ ba hình dạng: có giá / thiếu giá / tắt hạng mục. Số org THẬT **không cần** để xây và kiểm |
| **5** Adapter ghi sổ | Sinh phiếu trên DEMO → duyệt → ghi sổ → đối chiếu `net_cash_effect` = MAIN+CHANGE+ROUNDING; thử huỷ, thử đảo, thử ghi lại |
| **6** Wrapper + định tuyến | Gọi cả 5 quyết định trên DEMO, khẳng định **không** cái nào trả `0A000` |
| **7** Nghĩa vụ hoàn | Dựng thanh lý DEMO đủ ca: hoàn đủ / hoàn một phần / bù trừ hết / **âm** (đã trả nhiều hơn thu). DEMO đang có **9 hồ sơ** làm nền |
| **8** Ghi phiếu hoàn | Chạy trên DEMO **cả hai ca lệch** mà org thật từng gặp (−978.500 và +500.000); thử đua hai phiên; thử đảo |
| **9** Mở rộng | Kịch bản dồn ≥50 thao tác trên DEMO + đối chiếu. Mốc 24 giờ **chỉ** áp cho lần bật org THẬT |

### 15.3 Ranh giới thật — thứ tôi KHÔNG tự quyết

Tôi tự xây, tự kiểm, tự bật **trên DEMO**. Ba thứ vẫn là quyết định của chủ, và tôi
nói rõ thay vì tự làm:

1. **Bật cờ cho org THẬT.** Hệ đòi khai `commit_sha` + `migration_sha256` +
   `maintenance_window_id` + `approval_reference` mới bật được — chốt fail-closed cố
   ý, và `approval_reference` nghĩa là **ai chịu trách nhiệm**. Tôi không tự ký thay.
2. **Số liệu kinh doanh của org thật** — giá 53 ô còn trống, bậc hoa hồng, trần
   thưởng Sale. Tôi seed được DEMO, nhưng không bịa số thật.
3. **Sửa dữ liệu tiền đang lệch** — 8 hợp đồng `NEGATIVE_HELD` (đã chi thật
   20.104.100đ, thu thật 0đ) và 245 hợp đồng `RECOGNIZED_ONLY` (1,04 tỉ trên sổ ảo).
   Chủ đã nói tự xử lý.

Ngoài ba thứ đó: **không dừng hỏi**.

### 15.4 Bài học đã trả giá, ghi lại để không lặp

- **Đợt 3 tôi từng báo "xong" khi mới có phần ruột, chưa có nút.** Chủ mở web không
  thấy gì. ⇒ "Xong" nghĩa là **bấm được trên giao diện thật**, không phải RPC chạy.
- **Nút "Sinh phiếu hàng loạt" hiện ra nhưng BẤM KHÔNG ĐƯỢC** (z-index dưới header
  khung điện thoại). Nhìn ảnh chụp thì thấy nút, tưởng xong. ⇒ Phải **bấm thật**,
  ảnh chụp không thay được.
- **Review đối kháng bắt 1 BLOCKER + 5 lỗi** trong lõi ghi sổ tôi vừa viết, gồm việc
  chính phép tự-kiểm của tôi cho **an toàn giả** (so chuỗi trần khớp cả tên sai
  schema). ⇒ Tự kiểm phải soi **tên có schema** và **khẳng định kim tồn tại** trước
  khi so vị trí.
- **Chạy E2E ≥8 luồng gây `57014` trên prod.** Tôi suýt đổ cho bản vá của mình; hàm
  không liên quan cũng timeout mới lộ ra là do tải. ⇒ Dùng **4 luồng**.

---

## 16. ĐỢT 3/7/8 + BƯỚC 1/2 — ghi sổ ngày 31/07/2026

Mục này viết **sau** khi thi hành nên nó thắng mọi câu "sẽ làm" ở trên khi hai bên lệch.
Nó cũng vá một khoảng trống của chính tài liệu này: **§12–§15 dừng ở Đợt 1/2, trong khi
Đợt 3, 7, 8 đã lên prod mà không có một dòng ghi nhận nào.**

### 16.1 Đính chính tài liệu — ba mục đã lỗi thời

| Chỗ | Tài liệu đang nói | Thực tế 31/07 |
|---|---|---|
| §14.3 + §14.7 | "36 hàm dùng `CURRENT_DATE` **chưa** chuyển" | **ĐÃ chuyển hết** — commit `7f553ac`, 78 chỗ / 36 hàm |
| §4.7 (Đợt −1.7) | "`/deposits` sẽ sửa `refund_done` + `get_refund_forfeit_summary`" | **ĐÃ xong** ở Đợt −1. `refund_done` nay derive từ phiếu POSTED (`useDepositDashboard.ts:483`), hàm KPI đã có đủ `refund_posted_orphan_*`, `customer_debt_*`, `refund_pending_*` |
| §11.2 hạng mục 6 | "digest live-vs-migration của `fee_type_matches`" | Nhánh `quan_ly` trên prod **đã tự loại `%luong%`** ở cả `name` lẫn `category` — kiểm lại: 0/43 dòng `quan_ly` đến từ `salary.*`. Khuyết tật §−1.3 ở phần lương **đã hết** |

### 16.2 Đợt 3/7/8 — đã lên prod trước ngày 31/07

| Đợt | Object | Trạng thái dữ liệu |
|---|---|---|
| 3 — sinh phiếu phí cố định | `preview/generate/cancel_special_fees_v1` + `special_fee_claims`, route `special_fee.generate.v1` **mode=ON** | **0 claim / 0 phiếu** — đã bật, chưa ai dùng thật |
| 7 — nghĩa vụ hoàn cọc | `termination_refund_obligations` + `preview/record_termination_refund_obligation_v1` | **0 nghĩa vụ** |
| 8 — sinh phiếu hoàn | `create_termination_refund_voucher_v1` + `TerminationRefundDialog` trên báo cáo thanh lý | **0 phiếu `termination.refund.v2`** |

**Điểm rẽ kiến trúc, có chủ ý, khác plan gốc:** plan đòi hoàn cọc `APPROVED + POSTED` nguyên
tử qua posting adapter + sticky marker + 5 named wrapper. Thi hành thực tế **giản lược**: phiếu
ra `UNAPPROVED`, self-check **cấm** writer tự ghi sổ (`position('post_voucher_with_source')>0
→ RAISE`), nghĩa vụ lệch phải **chủ ép kèm lý do ≥8 ký tự**, chặn sổ ảo, gọi lại trả phiếu cũ.
Không có đường tiền tự động ⇒ **không cần cờ**; người duyệt là cổng. Chốt của chủ 31/07 xác nhận
hướng này: *"riêng hoàn cọc vẫn chờ duyệt kể cả khi số khớp"*.

### 16.3 Bước 1 — hai file dở dang (commit `4bae1ee`)

`20260730230000_annotate_evidence_protection.sql` và `20260730240000_authz_remaining.sql` nằm
ngoài git suốt, chưa từng apply, trong khi dải `20260730*` đã có 24 migration lên prod sau đó.
Đổi sang dải `20260801*`. Cách rà: **chạy khan từng khối** (`BEGIN` → khối → `ROLLBACK`) trên prod.

- WP2: **5/6 khối còn áp được nguyên**. Khối `ie_compat_cancel_v2` **mất neo** vì một migration
  sau đã làm 2/3 (cổng quyền + sổ dấu vết huỷ). Viết lại thu hẹp còn đúng phần thiếu: **chốt
  hạng mục hạn chế** — người có `income_expenses.cancel` trên toà nhưng không có
  `can_view_restricted_ie` vẫn huỷ được phiếu lương của người khác.
- WP1: chốt digest **đã nổ đúng thiết kế** (prod `a68c8662…`, file chờ `cebb54db…`). Đã diff tay
  đầy đủ: bản sống **không có gì** mà bản mới thiếu; bản mới chặt hơn ở 5 chỗ. Nay nhận cả hai
  digest để chạy được trên prod lẫn clone dựng lại.
- Mốc khoá bằng chứng đổi từ "chưa POSTED" sang "**còn là bản nháp**" — bịt 310 phiếu
  `NOT_APPLICABLE` (sổ ảo) vốn không bao giờ thành POSTED nên cửa gỡ ảnh của chúng mở vĩnh viễn.

### 16.4 Bước 2 — "đúng giá công bố thì tự duyệt" (commit `c0c17be`)

**Gốc vấn đề tìm được khi làm, không có trong plan nào:** `building_fee_accounts.default_amount`
vừa là chỗ trang Cài đặt ghi giá, **vừa bị `pay_period_fee` ghi đè bằng `round(số vừa chi / số
tháng)` sau MỖI lần chi**. Hệ quả đo được:

| Toà · hạng mục | Cột đang lưu | Giá thật (từ phiếu chi) | Sai |
|---|---:|---:|---|
| 405PVB · công an | **7.000đ** | 500.000đ/tháng | **71 lần** |
| 45/3 Trần Thái Tông · rác | 60.000đ | 900.000đ/tháng | 15 lần |
| toà `1eae0e82…` · điện | 9.507.910đ | — (là một hoá đơn cũ) | — |

Mọi phép so "đúng giá chưa" dựng trên cột đó là **tự khớp chính mình**.

Đã ship: bảng giá **có phiên bản theo tháng** trong `app_private` (đường chi không với tới),
máy kiểm rule ba kết quả, adapter ghi sổ có xuất xứ, gỡ mệnh đề ghi đè khỏi `pay_period_fee`,
UI tách bạch "Giá công bố" với "Gợi ý".

**Bảng giá ra đời RỖNG, cố ý.** Không gieo từ dữ liệu bẩn ⇒ hành vi hệ thống không đổi một ly;
luật sáng dần từng ô đúng lúc chủ công bố giá ô đó. Không có "ngày X mọi thứ đổi".

### 16.5 Review đối kháng bắt 2 BLOCKER + 6 lỗi nặng trong code tôi vừa viết

Năm lăng kính độc lập, mỗi phát hiện bị phản biện riêng. **Ghi lại vì đây là các khuôn lỗi sẽ
lặp ở Đợt 5/6:**

1. **BLOCKER** — gọi lại adapter sau khi bút toán đã bị **ĐẢO** ⇒ đóng dấu `POSTED` lên bút
   toán chết. Phiếu nói "đã chi", sổ quỹ nói "chưa" — tiền biến mất khỏi tồn quỹ mà giao diện
   vẫn xanh. Khuôn lỗi: **replay chỉ kiểm "còn con trỏ", không kiểm "bút toán còn sống"**.
2. **NẶNG** — phiếu lệch giá nằm ở `UNAPPROVED`, mà chốt chống trùng của `pay_period_fee`
   **chỉ đếm phiếu `APPROVED`** ⇒ bấm lần hai là đóng tiền hai lần cho cùng một tháng.
   Khuôn lỗi: **thêm một trạng thái mới mà quên rà mọi nơi đang lọc theo trạng thái cũ**.
3. Adapter thiếu chốt loại phiếu ⇒ tự duyệt được cả **phiếu hoàn cọc**, trái thẳng quyết định
   số 6 của chủ.
4. Sổ ảo: bản nháp **ném lỗi**, tức lấy mất một năng lực đang có (hôm nay đóng phí từ sổ ảo vẫn
   chạy). Khuôn lỗi: **"chặt hơn" không phải lúc nào cũng đúng**.
5. Không trả token `FINANCE_V2_LIFECYCLE` ⇒ cầu a85 **câm hết transaction**.
6. Người tạo đã rời tổ chức ⇒ lõi ném `23502` trần.
7. Kỳ lẻ vắt qua mốc tháng bị đòi tiền **gấp đôi** (đếm tháng lịch thay vì độ dài kỳ).
8. Vòng lặp `WHILE` không trần; `to_char` cho ra `9,507,910đ` kiểu Anh (người Việt đọc dấu
   phẩy là dấu thập phân).

### 16.6 GOTCHA hạ tầng mới — Management API trả 201 mà object KHÔNG lên

Lần áp đầu của `20260801010000`: HTTP **201**, nhưng `to_regclass` của bảng giá trả **NULL**
trong khi `special_fee_approve_and_post_v1` (cùng file, nằm SAU bảng) **lại có**. Áp lại lần
hai thì đủ. Chưa truy được nguyên nhân.

⇒ **Luật mới: không tin mã trạng thái HTTP. Sau mỗi lần áp phải kiểm catalog từng object.**
Cộng dồn với §11.2: sổ `schema_migrations` đã chết nên "vắng sổ ≠ chưa apply" — nay thêm
"**HTTP 201 ≠ đã apply**".

### 16.7 Bằng chứng

- 9 bảng tiền trước/sau **khớp tuyệt đối 17/17** ở cả Bước 1 lẫn Bước 2.
- Áp lại 3 lần = no-op. Bước 2 phải sửa một chốt idempotent mới đạt: mệnh đề nhận-đã-vá soi
  nhầm vào bản 3 tham số vốn đã thành vỏ chuyển tiếp sau lần áp đầu.
- 9 phép kiểm hành vi chạy trên bản **đã áp** rồi rollback, gồm ca nặng nhất: tạo phiếu →
  adapter → **đúng 1 bút toán**, `source_kind='SPECIAL_PAGE_FEE'` (không phải `LEGACY_BRIDGE`
  ⇒ cầu đã tắt đúng), tồn quỹ −250.000đ, gọi lại không đẻ thêm; phiếu hoàn cọc và phiếu thu
  bị từ chối `42501`; sổ ảo duyệt nhưng 0 bút toán.
- `thanh-toan-page.spec.ts` **7/7 xanh** sau khi đổi `pay_period_fee`.
- Trình duyệt thật: trang Cài đặt render đúng hai con số, hộp thoại công bố giá mở/đóng được,
  **0 lỗi console**.
- `check-stable-fn-locks` OK · `check-view-invoker` 12/12 · `typecheck:baseline` khớp 30 fingerprint.
- `check-definer-acl` **đỏ 5 hàm `lucky_*`** của trang quay số — endpoint công khai có chủ ý,
  pre-existing, không liên quan hai đợt này.

### 16.8 Còn nợ — và vì sao

- **Đợt 3/4/6 (điện nước, hoa hồng, bảo trì) chờ chủ duyệt bảng số.** Bảng đã dựng lại từ phiếu
  chi thật và **đã qua phản biện bắt 15 lỗi nặng** — nặng nhất: cách chấm độ tin cậy đếm số
  *tháng* thay vì số *phiếu riêng biệt*, làm một phiếu trải 3 tháng cũng được gắn nhãn "chắc chắn".
- **Hoa hồng: không suy ra được từ dữ liệu.** 34/41 phiếu có số tiền bằng đúng số máy điền sẵn
  ⇒ chúng là tiếng vọng của cấu hình cũ, không phải bằng chứng độc lập. 8 phiếu người gõ tay thì
  **đều mâu thuẫn** với bảng bậc hiện có. Đây là quyết định kinh doanh, không phải bài toán số liệu.
- **Bảo trì máy lạnh: bật luật 5 tháng hôm nay là khoá 59/59 phòng đã từng vệ sinh** tới
  15/10–28/12/2026. Phải để chủ biết trước khi bật.
- **Bước 5 (khoá đường thanh lý cũ) — KHUYÊN CHƯA KHOÁ NGAY.** Chủ đã chọn "khoá hẳn ngay",
  nhưng có một dữ kiện chủ chưa có lúc quyết: **đường hoàn cọc mới chưa từng chạy với dữ liệu
  thật — 0 nghĩa vụ trên prod**, và nó **không thử được bằng SQL** (đòi phiên đăng nhập thật;
  `preview_termination_refund_v1` ném `42501 'Bạn không thuộc tổ chức này'` khi gọi qua
  Management API). Khoá đường cũ trước khi đường mới chạy trót lọt một ca thật nghĩa là mọi ca
  thanh lý tiếp theo đều đi qua đường chưa ai kiểm. Việc phải làm trước: dựng spec E2E chạy
  trọn thanh lý → nghĩa vụ → phiếu hoàn trên DEMO, rồi mới khoá.

---

## 17. ĐỢT 31/07 — BỐN HỌ CHI CÒN LẠI, VÀ MỘT VIỆC CỐ Ý CHƯA LÀM

Mục này ghi tiếp §16. Chủ yêu cầu "còn bước nào nữa làm hết" — dưới đây là những
gì đã làm, và **một hạng mục tôi cố ý dừng lại**, kèm lý do và điều kiện để mở.

### 17.1 Khuôn chung: cấu hình ra đời RỖNG

Cả bốn họ dùng lại khuôn đã chứng minh an toàn ở bảng giá phí cố định (§16.4):

> Bảng cấu hình rỗng lúc tạo ⇒ **hành vi hệ thống không đổi một ly**.
> Luật chỉ bật cho đúng ô chủ đã công bố. Không có "ngày X mọi thứ đổi".

Đây là lớp phòng thủ chính của cả đợt: mọi migration dưới đây lên prod mà **không
một phiếu nào đổi trạng thái**, và 9 bảng tiền trước/sau khớp tuyệt đối 17/17 ở
từng lần apply.

### 17.2 Thưởng nóng Sale — tạo từ phiếu cọc (commit `262a5a1`)

Yêu cầu của chủ: thưởng tạo được ngay khi tạo phiếu cọc; ký hợp đồng thì nếu đã
thưởng rồi phải tô xám và báo bao nhiêu, khi nào.

**Lỗ phải vá cùng lúc, không được mở trước vá sau.** Khoá chống chi trùng cũ khoá
theo `(contract_id, commission_kind)` — cả advisory lock, pre-check `P0001` lẫn
unique index đều cần `contract_id NOT NULL`. Phiếu thưởng sinh từ phiếu cọc thì
lúc đó **chưa có hợp đồng** ⇒ `contract_id` NULL ⇒ **vô hình với cả ba lớp**. Ký
hợp đồng xong là chi được lần hai cho cùng thương vụ. Prod đã có ca chi trùng
thật: `HD-2026-00253` nhận **ba** phiếu 500.000đ trong 29 giây, phải huỷ tay cả
ba — lúc khoá còn nguyên vẹn.

- Sổ `app_private.sale_bonus_claims` nối phiếu thưởng ↔ phiếu cọc.
  `sale_bonus_status_v1` trả lời "hợp đồng này thưởng chưa" qua **cả hai đường**.
- `trg_ie_commission_guard` cấm phiếu hoa hồng không gắn hợp đồng — luật đúng,
  **giữ nguyên**. Mở đúng **một cửa hẹp** theo khuôn `LINK_CONTRACT`
  (`20260731130000`): scope `SALE_BONUS_DEPOSIT`, chỉ writer definer mở được,
  đóng ngay sau `INSERT`. **KHÔNG** nới kiểu "cho phép NULL nếu kind='sale'" —
  thế là mở toang đúng cái lỗ trigger sinh ra để bịt.
- Vì trigger chạy **BEFORE INSERT** mà bảng cửa khoá theo id phiếu, writer phải
  **cấp phát UUID trước** rồi mới mở cửa. Ghi lại vì khuôn này sẽ dùng lại.
- Trần thưởng có phiên bản theo tháng, trần riêng-toà thắng trần chung.

### 17.3 Hoa hồng môi giới — bậc có phiên bản + tự duyệt (commit `5254125`)

Quyết định của chủ 31/07 **thay** quyết định 23/07 (vốn bắt duyệt tay mọi phiếu).
Bốn điều kiện: hợp đồng `ACTIVE`, qua `start_date + 7`, **thực thu đủ cọc**, và
đúng bậc đã công bố. Thiếu một điều ⇒ chờ duyệt như cũ.

**Vì sao bảng bậc ra đời rỗng — đây là kết luận đắt nhất của đợt kiểm toán:**
thử suy bậc từ 41 phiếu đã chi thì phương pháp **bị vòng tròn**. Client điền sẵn
số tiền từ chính cấu hình đang chạy rồi người dùng bấm lưu ⇒ **34/41 phiếu có số
tiền bằng đúng số máy tự tính**. Chúng chứng minh "không ai phản đối", không
chứng minh tỉ lệ đúng. Còn 8 phiếu người **gõ tay** — 8 quan sát duy nhất mang
thông tin thật — thì **7/8 không khớp bậc nào** (40%, 55,56%, 56,43%, 58,68%,
66,98%). ⇒ Bậc là quyết định kinh doanh của chủ, không phải bài toán số liệu.

- "Thu đủ cọc" đọc `resolve_signed_contract_deposit_basis_v1`, **không** đọc
  `contracts.deposit_paid` — cột đó gộp cả cọc trên sổ ảo (243/287 phiếu cọc).
- **Cố ý không có fallback "lấy bậc gần nhất".** Fallback ngầm chính là thứ đang
  làm hai màn hình trả hai số khác nhau cho cùng 22 hợp đồng ở mốc 7–9 tháng.
- **Không đụng** `buildings.commission_tiers`: hợp nhất hai nguồn là đổi số đang
  hiển thị của 22 hợp đồng từ 50% xuống 0, tức đổi tiền, phải chủ quyết riêng.
- Adapter ghi sổ nới nhận thêm nguồn `contract.commission`. Tự kiểm **chặn cứng**
  việc nới sang nguồn `termination` — hoàn cọc vẫn phải chờ duyệt, và có ca kiểm
  chứng minh nó vẫn bị từ chối `42501`.

⚠ Rủi ro chủ cần thấy khi công bố bậc: **89 hợp đồng đang sống dài hơn 14 tháng
chưa từng được chi hoa hồng**, nhưng màn hình vẫn điền sẵn tỉ lệ bậc cao nhất cho
từng cái. Bấm chi hết là **202.770.000đ** ra két mà chưa có chính sách nào duyệt.

### 17.4 Trần điện/nước + luật bảo trì (commit `7f4b669`)

**Điện/nước là TRẦN, không phải "đúng giá thì tự duyệt".** Chi phí theo đồng hồ,
đo trên prod lệch 9–59% giữa các tháng nên không so bằng tuyệt đối được. Hai kiểu
trần đặt được đồng thời: trần tiền tuyệt đối, và trần theo **tỉ lệ so với tiền đã
thu của khách** cùng toà × loại × tháng. Thêm cảnh báo riêng cho ca "chưa thu
đồng nào của khách mà đã chi nhà cung cấp".

**Bảo trì có hai thứ chủ phải biết trước khi bật, nên chúng thành CỘT chứ không
phải giả định ngầm:**

| Cột | Mặc định | Vì sao |
|---|---|---|
| `counts_history` | **false** | Bật luật 5 tháng mà tính cả lịch sử sẽ khoá **59/59 phòng** đã từng vệ sinh máy lạnh (69/69 nếu tính cả họ bảo trì) trên tổng 275 phòng — mở sớm nhất 15/10/2026, muộn nhất 28/12/2026. Mặc định chỉ tính từ ngày công bố trở đi. Chủ bật tường minh thì hàm công bố **đếm thật** và trả về `wouldLockNow` để chủ thấy hệ quả bằng con số |
| `enforcement` | **WARN** | Hệ thống **không biết mỗi phòng có mấy máy lạnh** (mọi phiếu ghi số lượng = 1) nên chặn cứng sẽ chặn oan lần vệ sinh máy thứ hai của phòng 2 máy |

Giới hạn dữ liệu ghi thẳng vào file để không ai tưởng luật đã được kiểm chứng:
lịch sử bảo trì máy lạnh chỉ trải **74 ngày** (15/05→28/07/2026), **chưa từng tồn
tại cặp nào cách nhau quá 5 tháng**. "5 tháng" là ý chủ, không phải kết luận rút
từ số liệu.

Máy lạnh tính theo **phòng**, máy giặt theo **toà**. Phiếu máy lạnh không gắn
phòng trả thẳng `NO_ROOM` thay vì âm thầm cho qua (prod có 77 phiếu như vậy).

### 17.5 Hoàn cọc — đã kiểm bằng trình duyệt thật, và một lỗi giao diện bị bắt

Dựng spec `.e2e-fleet/specs/termination-refund.spec.ts`. Nó **bắt ngay một lỗi**:
hồ sơ không có khoản hoàn (khách còn nợ, hoặc hoàn bằng 0) thì nhánh render trả
`null` ⇒ hộp thoại mở ra **trống trơn**, nút "Tạo phiếu hoàn" bị vô hiệu mà không
nói vì sao. Người dùng không phân biệt được "mình sai" với "hệ hỏng". Đã vá
(commit `2271b20`).

Spec cũng ghi lại hai bài học của chính nó:
- Bản đầu **đếm nút ngay sau `goto()`** nên luôn ra 0 và test **tự bỏ qua**.
  "Bỏ qua" trông như xanh mà thật ra chưa kiểm gì — loại lỗi nguy hiểm nhất của
  E2E. Nay chờ bảng render xong mới đếm.
- Assertion không chốt cứng một chuỗi: có khoản hoàn ⇒ phải nhắc CHỜ DUYỆT;
  không có khoản ⇒ phải nói vì sao. **Trống trơn mới là lỗi.**

**Kiểm bằng trình duyệt thật trên org THẬT** (chỉ đọc, không tạo phiếu nào): hồ sơ
`HĐT-074727/01092025` hiện *"Số hoàn trên hồ sơ 3.041.500đ / Cọc THẬT đang giữ
0đ"* kèm cảnh báo *"Cọc chưa từng vào két — chỉ được ghi nhận trên sổ ảo"*, đòi lý
do tối thiểu 8 ký tự và **chỉ chủ tổ chức mới ép được**. Đúng thứ cần chặn.

### 17.6 VIỆC CỐ Ý CHƯA LÀM: khoá đường thanh lý cũ

Chủ chọn "khoá hẳn ngay". Tôi **chưa khoá**, và đây là lý do — không phải ngại
việc, mà vì một dữ kiện chủ chưa có lúc quyết:

1. **Đường mới chưa từng GHI một ca nào.** Prod hôm nay: **0 nghĩa vụ hoàn**,
   **0 phiếu `termination.refund.v2`**. Tôi đã chứng minh nhánh **ĐỌC** chạy đúng
   trên dữ liệu thật (§17.5), nhưng nhánh **GHI** thì chưa ai bấm.
2. **Không thử được bằng SQL.** `preview_termination_refund_v1` đọc `auth.uid()`
   nên gọi qua Management API ném `42501 "Bạn không thuộc tổ chức này"`. Chỉ phiên
   đăng nhập thật mới đi qua.
3. **Và đây là điều đáng cân nhắc nhất:** trên dữ liệu thật, hầu hết hồ sơ sẽ rơi
   vào nhánh cảnh báo "cọc chưa từng vào két" — vì **243/287 phiếu cọc toàn hệ nằm
   trên sổ ảo**. Khoá đường cũ ngay nghĩa là từ mai, **phần lớn ca hoàn cọc đều
   cần chủ đích thân ép kèm lý do**. Đó có thể đúng ý chủ (đang hoàn một khoản
   chưa hề thu thì đúng là chủ nên biết), nhưng nó là thay đổi vận hành lớn mà
   chủ nên quyết khi đã thấy con số này.

**Điều kiện để mở khoá — hai việc, làm xong là khoá được:**
- Chạy nhánh GHI trọn vẹn một lần trên DEMO: `FLEET_REFUND_WRITE=1` với spec đã
  có, hoặc chủ bấm thật một ca trên org thật rồi báo lại.
- Chủ xác nhận đã biết hệ quả ở điểm 3.

Khi hai điều đó xong, việc khoá gồm: gỡ nhánh INSERT phiếu hoàn trực tiếp khỏi
`terminate_contract_move_out_impl` và `approve_contract_termination_v1`, thay bằng
ghi `termination_refund_obligations`; và `REVOKE` route giữa
`public.terminate_contract_move_out` khỏi `authenticated` (nó đang cho client gọi
thẳng, bỏ qua idempotency key và payload hash vốn chỉ nằm ở wrapper). **Tuyệt đối
không đổi chuỗi ghi chú** `'Quyết toán khi thanh lý DD/MM/YYYY'` và không đổi thứ
tự mở/đóng context — `a10_payment_termination_non_cash` nhận diện bằng regex trên
chuỗi đó, đổi là guard rơi vào `RETURN NEW` (không kiểm gì) hoặc ném `55000`.

### 17.7 Tổng kết đợt

| Việc | Trạng thái | Commit |
|---|---|---|
| Thưởng Sale từ phiếu cọc + vá khoá chi trùng | prod | `262a5a1` |
| Bậc hoa hồng có phiên bản + tự duyệt 4 điều kiện | prod | `5254125` |
| Trần điện/nước + luật bảo trì | prod | `7f4b669` |
| Vá hộp thoại hoàn cọc + spec E2E | prod | `2271b20` |
| Khoá đường thanh lý cũ | **chưa** — xem §17.6 | — |

Bốn bảng cấu hình mới đều **rỗng**: `sale_bonus_cap_versions`,
`commission_tier_versions`, `utility_ceiling_versions`,
`maintenance_rule_versions`. Chủ điền số nào thì luật bật cho ô đó.

Bảng số đề xuất (đã qua phản biện bắt 15 lỗi nặng) nằm ở trang riêng đã gửi chủ.
