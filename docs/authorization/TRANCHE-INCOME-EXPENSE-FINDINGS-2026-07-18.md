# Tranche INCOME-EXPENSE — Findings & design fork (2026-07-18)

> **Lifecycle:** historical build evidence, không phải trạng thái live. Writer đã go-live sau snapshot này; xem [README.md](README.md). File được giữ vì SQL chuẩn bị vẫn tham chiếu các quyết định thiết kế bên dưới.

> Trạng thái: **DESIGN-BLOCKED** — cần 1 quyết định kiến trúc của owner trước khi
> build/activate. KHÁC HẲN 3 domain đã xong (payment/meter/cashbook) vốn chỉ cần
> *wire* writer có sẵn. Domain này phải *author* nhiều writer mới VÀ có 1 xung đột
> thiết kế giữa mô hình canonical (immutable draft) và UX hiện tại (sửa phiếu nháp).
>
> Mọi số/hành vi dưới đây **đã verify trực tiếp trên prod** (read-only) ngày 2026-07-18.
> Flag `income_expense.create_draft.v1` = OFF và `create_income_expense_v1` **không
> grant** cho `anon/authenticated` → writer deployed nhưng **inert**, app chạy 100%
> legacy → 0 regression. Đây là trạng thái an toàn hiện tại; KHÔNG được kích hoạt
> tới khi giải quyết fork bên dưới.

## 1. Cái gì đã có trên prod (verified)

| Object | Vai trò | Ghi chú |
|---|---|---|
| `create_income_expense_v1(16 args)` | tạo phiếu draft canonical | **claim NGAY** sau insert → freeze tức thì; **non-recurring** (không có tham số `repeat_*`) |
| `claim_canonical_income_expense_draft_v1` | đóng dấu canonical-owned | kích hoạt freeze |
| `transition_canonical_income_expense_v1(id, status, posting, reversed_by)` | đổi **chỉ** lifecycle | status ∈ APPROVED/CANCELLED/REVERSED/DENIED/REJECTED; **KHÔNG đụng payments** |
| `append_income_expense_event_v1` / `verify_income_expense_audit_chain_v1` | audit hash-chain | |
| Trigger `a00_ie_owned_payload_freeze` | đóng băng payload | allowlist: chỉ cho đổi `approval_status,posting_id,posted_at_v2,reversed_by_posting_id,updated_at`, và phải có transition-token trong cùng xid |
| Trigger `a00_payment_canonical_link_guard` | chặn mutate payment của voucher canonical | DELETE/UPDATE/INSERT payment link voucher canonical → `55000` |
| `reverse_invoice_payment_v3(payment_id, reason, key)` | hoàn thanh toán = **compensating** (không xoá gốc), cần quyền `thu_tien.undo` | dùng để thay `payments.delete()` |

**Chưa có writer nào cho:** update payload, cancel-kèm-hoàn-payment, batch, profit
distribution, manager salary payout, recurring generate. `update_income_expense_quick`
chỉ sửa `account_id/attachments/notes` — KHÔNG phải payload/items.

## 2. Population thật (verified)

- `income_expenses` type=INCOME có `payment_id` (đối tượng cancel-huỷ hiện tại): **951** phiếu.
- Trong đó canonical-flow-owned: **0** (vì flag OFF). ⇒ **toàn bộ 951** phiếu đang
  chạy đường cancel legacy `payments.delete()` (xoá cứng lịch sử thanh toán).

## 3. Hai vấn đề chốt chặn

### 3a. Freeze ⇒ phiếu canonical KHÔNG sửa được payload — xung đột UX "sửa phiếu nháp"

`create_income_expense_v1` claim ngay khi tạo. Trigger freeze dùng **allowlist**: trên
phiếu canonical, UPDATE chỉ được đổi các cột lifecycle; MỌI cột khác phải NOT DISTINCT
so với giá trị cũ. ⇒ Payload (name, items, số tiền, building…) của phiếu canonical
**không bao giờ sửa được**, kể cả khi còn UNAPPROVED.

Nhưng UX hiện tại (`useUpdateIncomeExpense`, comment "chỉ khi UNAPPROVED") cho phép
nhân viên **sửa phiếu nháp trước khi duyệt**. Plan §J cũng ghi income-expense phải có
"draft/submit/decide/**correction**". ⇒ Nếu bật `create_income_expense_v1` như hiện
tại, tính năng **Sửa phiếu thu/chi biến mất** (nút Sửa sẽ báo lỗi freeze `55000`).
Đây KHÔNG phải bug wiring — là mismatch giữa mô hình canonical (draft bất biến ngay)
và cả UX hiện tại lẫn spec §J của plan.

### 3b. Cancel legacy xoá cứng payment — vi phạm nguyên tắc "không xoá lịch sử tiền"

`useCancelIncomeExpense` với phiếu INCOME mirror payment làm
`payments.delete().eq(id, payment_id)` (statusMutations.ts:85-94), dựa trigger
recompute invoice. Plan cấm xoá lịch sử tiền — phải dùng compensating reversal
(`reverse_invoice_payment_v3`). NHƯNG đổi cancel từ delete→reverse **không phải fix
lẻ**: `useRestoreIncomeExpense` (restore CANCELLED→APPROVED) đang **tạo lại payment**
với giả định payment đã bị xoá. Đổi cancel mà không đổi restore ⇒ desync +
double-payment. ⇒ cancel/restore/reconcile phải redesign **đồng bộ**, không tách lẻ.

## 4. Kết luận

Income-expense là **redesign nhất quán all-or-nothing**, không wire/patch từng mảnh:
create (claim-time), update/correction, approve, cancel (compensating), restore,
batch, profit, salary, recurring phải khớp nhau vì freeze + payment-guard ràng chéo.
Piecemeal activation = vỡ edit/cancel/restore. Việc build các writer còn thiếu là
**author state-machine tài chính mới** (khác 3 domain đã xong), phải test trên DB
disposable/restore theo CLAUDE.md trước mọi canary.

## 5. ✅ QUYẾT ĐỊNH OWNER (2026-07-18, cùng ngày): Phương án A + nút Copy

Owner chốt: **A — immutable-on-create** ("nhân viên gõ đúng rồi duyệt ngay, ít khi
sửa; sai thì huỷ và tạo mới"), kèm yêu cầu UX: **nút Copy ở phiếu huỷ** mở modal
tạo phiếu mới prefill toàn bộ thông tin phiếu cũ **kể cả hình ảnh**.

Đã thực hiện (cùng ngày):
- `t5_08_ie_lifecycle_writers.sql` APPLIED prod: widen freeze-allowlist (thêm
  approved_by/approved_at/verified_*) + 3 writer `approve_income_expense_v1`,
  `cancel_income_expense_v1`, `verify_income_expense_v1` (flow-owned-only, row
  legacy trả marker `chưa thuộc luồng canonical` = tín hiệu fallback; permission
  PARITY legacy: approve mirror approve_voucher, cancel mirror RLS UPDATE
  composite, verify mirror verify_income_expense). Inert khi 0 row flow-owned.
- Frontend (branch release/meter-domain, e54a012): wire create/approve/cancel/
  verify + classifier IE riêng (`isIeCreateFallbackSignal` thêm 0A000;
  `isIeLifecycleFallbackSignal` KHÔNG coi 42501 là fallback); nút "Tạo bản sao"
  ở list + detail (desktop/mobile) qua prop `copyFrom` của IncomeExpenseForm;
  unapprove/restore trên phiếu canonical → toast hướng dẫn "Huỷ + Tạo bản sao".
- Mục 3b (cancel legacy xoá payment cho 951 phiếu mirror): **để nguyên legacy**,
  thuộc domain payment (phiếu mirror sinh bởi record_invoice_payment_v3/v4, chưa
  claim canonical) — xử lý ở tranche payment-mirror riêng, KHÔNG trộn vào đây.

## 6. ✅ EVIDENCE CANARY + BROWSER (2026-07-18, cùng ngày — VERIFIED demo org)

**REST full-cycle (demo.ketoan, org demo, flag v4 CANARY 6h caps 30/20M/100M):**
PT2607001: create 200 → flow-owned=1 + ledger completed → legacy PATCH bị freeze
55000 ✓ → approve 204 (APPROVED + approved_by/at) → verify 204 (verified_by_name)
→ cancel 204 → restore legacy 403 ✓. Audit chain
`CREATED_DRAFT→APPROVED→VERIFIED→CANCELLED`, `verify_..._audit_chain_v1` = (t).
Cross-org item-type bị chặn 42501 ✓ ("không thuộc tổ chức").

**Browser UI (bundle cad322c, demo.ketoan):** PT2607002 (có ảnh, REST) đã huỷ →
nút **Tạo bản sao** hiện đúng chỉ ở phiếu huỷ → form prefill ĐẦY ĐỦ kể cả ảnh →
Lưu → `create_income_expense_v1` **200** (PT2607003 canonical, giữ ảnh) → UI Duyệt
→ `approve_income_expense_v1` **204** → UI Huỷ → `cancel_income_expense_v1`
**204**. 0 console error toàn phiên demo.

**Browser regression org THẬT (user thật, flag OFF — Opus 4.8 agent lái):**
tạo phiếu → rpc 403(42501) → fallback insert legacy **201** + items 201 → toast
success; huỷ → rpc 500(55000 marker) → fallback PATCH **204** → Đã huỷ. Không
app-exception. Phiếu test đã huỷ dọn sạch. Tiền real-org bất biến 3.886.037.563.

### Phát hiện từ browser test + phân tích + xử lý

1. **Real-org create bị 42501 "không có quyền tạo cho toà này" TRƯỚC khi tới flag**
   — xác nhận cảnh báo khảo sát: authority graph canonical (staff_assignment do
   OWNER cấp) **hẹp hơn RLS legacy** với chính super-admin user thật trên toà
   102LVT. Coexistence không sao (42501 là fallback-signal của create). **GATE
   kích hoạt real-org:** audit parity permission-graph (ai đang tạo phiếu qua RLS
   vs ai canonical cho phép) + materialize assignment thiếu, TRƯỚC khi bật CANARY
   org thật. Chưa bật real-org ở tranche này.
2. **Fallback marker 55000 map HTTP 500** (PostgREST) — mỗi thao tác phiếu legacy
   trong coexistence sẽ có 1 dòng 500 noise ở console/log. Classifier client match
   `body.code` nên hoạt động đúng (đã chứng minh PATCH nối tiếp thành công).
   Chấp nhận noise, KHÔNG đổi errcode giữa chừng.
3. **Legacy cancel mất entry nhật ký**: `log_income_expense_action` (T3 audit-
   monopoly) allowlist `NOTE/CANCELLED_NOTE/MANUAL_LOG`, từ chối client tự dập
   `CANCELLED`. ĐÃ FIX frontend 4371f29: legacy cancel ghi `CANCELLED_NOTE`
   (alias T3 dựng sẵn) — verify REST 204 + chain (t).
4. Phiếu legacy có sổ quỹ → auto-APPROVED (hành vi legacy giữ nguyên, không phải bug).

**UX-note Phương án A:** dialog Duyệt cho "đổi sổ quỹ trước khi duyệt" — với phiếu
canonical, ĐỔI sổ tại đó sẽ đụng freeze (quick-update). Giữ nguyên sổ thì không
gọi update (đã chứng minh network). Hướng dẫn nhân viên: muốn đổi sổ → Huỷ + Tạo
bản sao.

**Trạng thái tranche: demo org VERIFIED. Real org: legacy (fallback) — chờ gate
permission-parity trước khi canary.**

## 5-cũ. Fork đã trình owner (giữ để tham chiếu)

**Mô hình vòng đời phiếu income-expense khi lên canonical:**

- **A. Immutable-on-create (giữ nguyên writer hiện tại):** phiếu bất biến ngay khi
  tạo; "sửa" = huỷ + tạo lại. Bỏ nút Sửa phiếu nháp. Ít rework SQL nhất nhưng đổi
  thói quen nhập liệu của nhân viên.
- **B. Editable-draft rồi claim-khi-submit (rework `create_income_expense_v1`):**
  tạo phiếu UNAPPROVED **chưa claim** (còn sửa được), chỉ claim/freeze khi
  submit/approve. Khớp UX hiện tại + spec §J, nhưng phải sửa lại create writer +
  thêm submit writer + luồng claim trễ.
- **C. Hoãn income-expense**, làm domain khác trước (invoice/deposit-contract/salary
  cũng cần author writer mới — cần khảo sát tương tự trước khi cam kết).

Sau khi chốt A/B/C, mới build + test disposable + wire (flag OFF) + xin lệnh canary.
