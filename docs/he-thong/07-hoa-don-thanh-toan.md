# Hoá đơn & Thu tiền hoá đơn (Invoices & Payments)

> Domain quản lý **hoá đơn** phát hành cho từng hợp đồng theo kỳ (billing_month), việc **ghi nhận thanh toán** (payments), và các cơ chế phụ trợ: tiền thừa (credit), tiền thối, làm tròn, lịch sử audit, và trang công khai để khách quét QR xem hoá đơn.

---

## 1. Tổng quan & vai trò nghiệp vụ

Hoá đơn là **mắt xích trung tâm** giữa hợp đồng/chỉ số và dòng tiền thực:

```text
Hợp đồng (rent_price, dịch vụ)  ─┐
Chỉ số điện/nước (meter)        ─┼─►  HOÁ ĐƠN (invoices + invoice_items)
Nợ cũ kỳ trước / cọc / credit   ─┘          │
                                            ▼  ghi nhận thanh toán
                                      PAYMENTS  ──►  income_expenses (phiếu thu)
                                            │              │
                                            ▼              ▼
                                  status PAID/PARTIAL   sổ quỹ / báo cáo
```

Vai trò chính:

- **Phát hành hoá đơn** cho từng hợp đồng theo từng tháng (`billing_month` dạng `YYYY-MM`). Mỗi hợp đồng chỉ có **1 hoá đơn / kỳ** (unique index).
- **Tính tổng tiền** = tạm tính (tiền phòng + điện + nước + dịch vụ + khoản tùy chỉnh) − giảm trừ + nợ cũ kỳ trước.
- **Ghi nhận thanh toán** nhiều phương thức (TM/TK/TT), nhiều phần (partial), tự cập nhật trạng thái và **đẩy sang Thu chi** (mỗi payment ⇒ 1 phiếu thu `income_expenses`). Có 3 luồng thu: dialog đơn (§5.6), thu hàng loạt (§5.1 bước 6) và trang mobile **`/thu-tien`** (§5.9).
- Xử lý **biên ngoài lề**: tiền thừa (excess/credit), tiền thối, làm tròn tiền thiếu < 10K, hoàn trả hoá đơn thanh lý (total âm).
- **Audit log** mọi thao tác trên invoice/item/payment.
- **Trang công khai** cho khách quét QR (`/c/:code`) xem hoá đơn mới nhất mà không cần đăng nhập.

Một điểm thiết kế quan trọng: dù DB còn nguyên trạng thái `DRAFT/PENDING_APPROVAL`, **luồng tạo hoá đơn ở FE mặc định set thẳng `APPROVED`** (xem [useCreateInvoice](src/hooks/useInvoices.ts)). Hoá đơn sinh ra là sẵn sàng thu tiền, không qua bước duyệt thủ công.

---

## 2. Cấu trúc dữ liệu

### 2.1. `invoices` — Hoá đơn

Mục đích: bản ghi hoá đơn của 1 hợp đồng cho 1 kỳ (`billing_month`).

Các cột chủ chốt:

- **Định danh & sở hữu**: `user_id` (owner/chủ tenant — scope RLS), `contract_id`, `building_id`, `room_id` (đều NOT NULL — hoá đơn luôn gắn đủ ngữ cảnh toà/phòng/hợp đồng). `invoice_number` (text, sinh tự động), `creator_name` (snapshot tên người tạo).
- **Kỳ & ngày**: `billing_month` (NOT NULL, regex `^\d{4}-\d{2}$`), `issue_date` (mặc định hôm nay), `due_date` (NOT NULL, ràng buộc `issue_date <= due_date`), `paid_date` (set khi PAID).
- **Trạng thái**: `status` (enum `invoice_status`, mặc định `DRAFT` ở DB nhưng FE set `APPROVED`).
- **Số tiền** (numeric):
  - `subtotal` — tạm tính từ các item (`Σ unit_price·quantity·coefficient`).
  - `discount_amount` — giảm trừ (mình "nợ" khách), kèm `discount_notes`.
  - `previous_debt` — nợ cũ kỳ trước (khách nợ mình) cộng vào tổng, kèm `previous_debt_sources` (jsonb — danh sách nguồn nợ: từ hoá đơn cũ / cọc, mỗi phần tử `{type, id, amount, label}`). Đây không chỉ là metadata truy nguồn: khi HĐ chuyển sang `PAID`, trigger **cascade tất toán** từng nguồn (xem §4.4).
  - `total_amount` = `subtotal − discount_amount + previous_debt` (CHECK `>= 0`).
  - `prepaid_amount` — trả trước (ít dùng trong luồng hiện tại).
  - `paid_amount` — **đã thu net** (đã trừ tiền thối/hoàn trả), do trigger recompute tính lại; CHECK `>= 0`.
  - `remaining_amount` — cột **GENERATED** `total_amount − paid_amount` (FE thường tự tính lại từ 2 cột kia).
- **Cờ & duyệt**: `electricity_prev_overridden` (đánh dấu chỉ số điện đầu kỳ bị nhập tay), `approved_at`/`approved_by`, `template_id` (mẫu in, FK `document_templates`).
- **Soft-delete**: `deleted_at`. Mọi query đều `.is('deleted_at', null)`.

Enum dùng: `invoice_status`.

FK đi ra: `contract_id → contracts`, `building_id → buildings`, `room_id → rooms`, `template_id → document_templates`.
Được tham chiếu bởi: `invoice_items.invoice_id`, `payments.invoice_id`, `invoice_audit_log.invoice_id`, `excess_amounts.source_invoice_id`, **`income_expenses.invoice_id`** (liên kết mạnh sang domain Thu chi).

**Bất biến quan trọng**: unique partial index `idx_invoices_unique_contract_billing (contract_id, billing_month) WHERE deleted_at IS NULL AND status <> 'CANCELLED'` (nới từ migration `20260519000002`) ⇒ không thể có 2 hoá đơn **còn hiệu lực** cho cùng hợp đồng + kỳ; HĐ `CANCELLED` **không chiếm slot** — huỷ HĐ cũ xong vẫn tạo lại được HĐ mới cùng hợp đồng + kỳ. Đây cũng là lý do recompute giữ nguyên `CANCELLED` (§4.3) không gây đụng index. Lỗi vi phạm được FE dịch thành thông báo thân thiện; [GenerateInvoiceDialog](src/components/invoices/GenerateInvoiceDialog.tsx) pre-check theo đúng điều kiện này.

### 2.2. `invoice_items` — Dòng khoản thu

Mục đích: chi tiết từng khoản trong hoá đơn (tiền phòng, điện, nước, dịch vụ, khoản khác).

Cột chủ chốt: `type` (enum `invoice_item_type`), `description`, `unit_price`, `quantity`, `coefficient`, `amount` (= `unit_price·quantity·coefficient`). Với khoản công tơ: `previous_reading`/`current_reading` (chỉ số đầu/cuối) và `from_date`/`to_date` (kỳ áp dụng). `service_id` (FK `services`, nullable — khoản tùy chỉnh không gắn service). `sort_order` để hiển thị.

Enum dùng: `invoice_item_type` (RENT, SERVICE, PENALTY, DISCOUNT, OTHER).

FK: `invoice_id → invoices` (ON DELETE CASCADE), `service_id → services`.

### 2.3. `payments` — Phiếu thanh toán

Mục đích: mỗi lần khách trả tiền cho 1 hoá đơn.

Cột chủ chốt: `invoice_id`, `amount` (CHECK `> 0`), `payment_method` (enum `payment_method`: **TM/TK/TT**), `payment_date` (mặc định hôm nay), `receipt_number`, `receipt_image_url`, `notes`, `user_id` (scope RLS — = owner của invoice).

Về ảnh chứng từ: upload vào bucket **`payment-receipts`**, nếu lỗi (bucket không tồn tại / không có quyền) thì fallback bucket **`documents`** dưới path `receipts/` (xem [RecordPaymentDialog](src/components/invoices/RecordPaymentDialog.tsx), [useUploadPaymentReceipt](src/hooks/useUploadPaymentReceipt.ts)). Giá trị lưu vào `receipt_image_url` là **publicUrl string**; vì bucket private nên khi hiển thị phải parse lại qua `StorageImage`/`openStoredFile` (signed URL), không dùng trực tiếp `<img src>`.

Enum dùng: `payment_method` (TM = tiền mặt, TK = tài khoản/chuyển khoản, TT = thanh toán — **giữ nguyên mã, không dịch**).

FK: `invoice_id → invoices` (ON DELETE **RESTRICT** — không thể xoá hoá đơn còn payment trừ khi hard-delete payment trước).
Được tham chiếu bởi: `excess_amounts.source_payment_id`, **`income_expenses.payment_id`**.

### 2.4. `excess_amounts` — Tiền thừa / credit theo hợp đồng

Mục đích: sổ ledger credit của hợp đồng. **Dương = credit thêm** (khách trả thừa, hoặc giữ tiền thối làm credit). **Âm = credit đã dùng** (áp vào giảm trừ hoá đơn sau).

Cột chủ chốt: `contract_id`, `amount` (có dấu), `description`, `source_invoice_id`, `source_payment_id` (truy nguồn). Tổng credit khả dụng = `Σ amount` (bỏ qua row có `source_invoice` đã soft-delete — auto rollback khi huỷ HĐ, xem [useExcessAmount](src/hooks/useInvoices.ts)).

FK: `contract_id → contracts`, `source_invoice_id → invoices` (ON DELETE SET NULL), `source_payment_id → payments` (ON DELETE SET NULL).

### 2.5. `invoice_audit_log` — Lịch sử thay đổi

Mục đích: nhật ký field-level cho mọi INSERT/UPDATE/DELETE trên `invoices`, `invoice_items`, `payments`.

Cột chủ chốt: `invoice_id` (gom theo hoá đơn), `entity` (`'invoice' | 'item' | 'payment'`), `entity_id`, `action` (`INSERT/UPDATE/DELETE`), `actor_id`/`actor_name` (lấy từ `auth.uid()` + `profiles.full_name`), `before`/`after` (jsonb snapshot), `changed_fields` (mảng tên cột đã đổi).

FK: `invoice_id → invoices` (ON DELETE CASCADE).

### 2.6. `invoice_generation_settings` — Cấu hình sinh hoá đơn tự động

Mục đích: cấu hình per-user cho sinh hoá đơn định kỳ. Cột: `auto_generate_enabled`, `generation_day` (ngày trong tháng), `due_days` (số ngày hạn thanh toán), `include_previous_debt`, `auto_approve`. (Bảng cấu hình, hiện chủ yếu là khung — luồng sinh HĐ thực tế ở FE đi qua [useCreateInvoice](src/hooks/useInvoices.ts) (tạo thủ công 1 HĐ hoặc lặp hàng loạt trong `ExcelInvoiceDialog`); RPC `generate_invoices_for_building_v2` tồn tại nhưng FE chưa gọi.)

---

## 3. Sơ đồ quan hệ dữ liệu

```mermaid
erDiagram
    contracts ||--o{ invoices : "1 HĐ - nhiều kỳ"
    buildings ||--o{ invoices : ""
    rooms ||--o{ invoices : ""
    invoices ||--o{ invoice_items : "chi tiết khoản thu"
    invoices ||--o{ payments : "các lần thu"
    invoices ||--o{ invoice_audit_log : "lịch sử"
    contracts ||--o{ excess_amounts : "credit theo HĐ"
    invoices ||--o{ excess_amounts : "source_invoice_id"
    payments ||--o{ excess_amounts : "source_payment_id"
    invoices ||--o{ income_expenses : "invoice_id (phiếu thu)"
    payments ||--o{ income_expenses : "payment_id"
    services ||--o{ invoice_items : "service_id"

    invoices {
        uuid id PK
        uuid contract_id FK
        text billing_month "YYYY-MM"
        invoice_status status
        numeric subtotal
        numeric discount_amount
        numeric previous_debt
        numeric total_amount
        numeric paid_amount "net (đã trừ thối)"
        numeric remaining_amount "GENERATED"
        jsonb previous_debt_sources
        timestamptz deleted_at
    }
    invoice_items {
        uuid id PK
        invoice_item_type type
        numeric unit_price
        numeric quantity
        numeric coefficient
        numeric amount
        numeric previous_reading
        numeric current_reading
    }
    payments {
        uuid id PK
        payment_method method "TM/TK/TT"
        numeric amount
        date payment_date
        text receipt_image_url
    }
    excess_amounts {
        uuid id PK
        numeric amount "dương=credit, âm=dùng"
        uuid source_invoice_id FK
        uuid source_payment_id FK
    }
```

---

## 4. Quy tắc nghiệp vụ & tự động hoá

### 4.1. Enum trạng thái hoá đơn (`invoice_status`)

`DRAFT → PENDING_APPROVAL → APPROVED → PAID / PARTIAL_PAID / OVERDUE → CANCELLED`

Thực tế vận hành chỉ dùng một tập con:

```mermaid
stateDiagram-v2
    [*] --> APPROVED : useCreateInvoice (FE set thẳng)
    APPROVED --> PARTIAL_PAID : thu 1 phần
    APPROVED --> PAID : thu đủ
    PARTIAL_PAID --> PAID : thu nốt
    APPROVED --> OVERDUE : quá hạn (useCheckOverdueInvoices)
    PARTIAL_PAID --> OVERDUE : quá hạn
    OVERDUE --> PAID : thu đủ
    APPROVED --> CANCELLED : huỷ
    PAID --> CANCELLED : super admin force-cancel
    CANCELLED --> APPROVED : super admin phục hồi
```

- **PAID/PARTIAL_PAID/OVERDUE** do trigger recompute tính từ tổng payments — không set tay.
- **OVERDUE** được set bởi `useCheckOverdueInvoices` (chạy 1 lần khi mở trang `/invoices`): quét các HĐ `APPROVED/PARTIAL_PAID` có `due_date < hôm nay` → set `OVERDUE`. **Giới hạn**: đây là check **client-side** — HĐ quá hạn sẽ không bao giờ chuyển `OVERDUE` nếu không ai mở trang `/invoices`; trang `/thu-tien` (§5.9) **không** chạy check này nên trạng thái giữa 2 trang có thể lệch trong ngày.
- **CANCELLED** là trạng thái "đã huỷ" (soft cancel — vẫn còn trong DB).

### 4.2. Trigger sinh số hoá đơn — `generate_invoice_number_v2`

`BEFORE INSERT ON invoices`: nếu `invoice_number IS NULL`, sinh `<prefix>-<YYYY>-<seq 5 số>` (prefix đọc settings key `invoice_number_format` → field `invoice_prefix`, mặc định `INV`). Seq = đếm số HĐ của user trong năm + 1.

**Lưu ý format FE ≠ format trigger**: FE [generateInvoiceNumber](src/lib/invoiceUtils.ts) sinh `<prefix>-<YYYYMM>-<6 số cuối timestamp>` và đọc settings key **khác** (`invoice_config` → field `invoice_number_prefix`). Vì [useCreateInvoice](src/hooks/useInvoices.ts) **luôn truyền số** vào INSERT nên thực tế mọi HĐ tạo từ UI mang format timestamp của FE; trigger chỉ là fallback (vd insert qua RPC bulk) và khi đó mới ra format seq.

### 4.3. Trigger recompute paid_amount/status — `recompute_invoice_for_id`

Đây là **trái tim** của domain. Phiên bản hiện hành (migration `20260530000002`) tính:

1. `v_paid = Σ payments.amount` của hoá đơn.
2. `v_refunded = Σ (unit_price·quantity)` của các item thuộc **phiếu chi EXPENSE loại "Tiền thối" APPROVED** gắn `invoice_id` này.
3. `paid_amount = v_paid − v_refunded` (net).
4. Suy ra status:
   - Nếu HĐ đang **CANCELLED** → chỉ cập nhật `paid_amount`, **giữ nguyên CANCELLED** (không "hồi sinh" — tránh đụng unique index khi thanh lý bỏ cọc giữ tiền đã thu).
   - **Làm tròn tiền thiếu**: nếu `total > 0`, `paid > 0`, và `(total − paid) < 10.000` → `PAID` (paid_amount giữ đúng số thực thu, KHÔNG bump lên total).
   - `paid >= total` → `PAID`.
   - `0 < paid < total` → `PARTIAL_PAID`.
   - `paid = 0` → `APPROVED`.

Trigger gọi hàm này:

- `trg_payments_recompute_invoice` — AFTER INSERT/UPDATE/DELETE trên `payments`.
- `trg_voucher_recompute_invoice` — AFTER INS/UPD/DEL trên `income_expenses` (để bắt phiếu chi tiền thối / hoàn trả gắn `invoice_id`).
- `trg_voucher_item_recompute_invoice` — AFTER INS/UPD/DEL trên `income_expense_items`.

**Bất biến**: `invoices.paid_amount` luôn = net thu (đã trừ thối/hoàn) — UI không cần tự trừ. `remaining_amount` (generated) = `total − paid`.

### 4.4. Trigger cascade tất toán nợ cũ — `trg_settle_previous_debt`

`AFTER UPDATE OF status ON invoices` (migration `20260527000051`), chạy khi HĐ **vừa chuyển sang `PAID`** (OLD ≠ PAID) và `previous_debt_sources` không rỗng. Hàm `settle_previous_debt_sources` (SECURITY DEFINER) duyệt từng nguồn:

- **`type = 'invoice'`** → tất toán HĐ cũ: set `paid_amount = total_amount`, `status = 'PAID'`, `paid_date` (nếu trống), và **append** vào `notes` dòng `[Tự động tất toán qua HĐ <số HĐ mới>]`. Chỉ áp với HĐ chưa PAID và chưa soft-delete.
- **`type = 'deposit'`** → **cộng vào `contracts.deposit_paid`** số `amount` của nguồn, clamp `≤ total_deposit` (mắt xích chảy sang domain hợp đồng/cọc — kiến trúc theo dõi cọc đọc số này).

Nghĩa là khi khách trả HĐ mới (đã gộp nợ cũ vào `previous_debt`), các HĐ nợ gốc tự đóng và phần cọc thiếu tự được ghi nhận — **không cần thao tác tay**. Nguồn `amount <= 0` bị bỏ qua.

### 4.5. RPC ghi nhận thanh toán — `record_invoice_payment_v2`

Chữ ký: `(p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url) → json`.

- **RBAC**: lookup invoice kèm `can_do_on_building('invoices','edit', building_id)` (không nhận `p_user_id` — quyền theo toà, super_admin thấy đủ).
- INSERT payment (trigger `set_user_id_audit` tự điền `user_id = auth.uid()`).
- Tính `v_new_paid = paid + amount`; nếu `>= total` → status `PAID`, set `paid_date`; nếu thừa (`excess > 0`) → INSERT `excess_amounts` (credit cho contract). Ngược lại `PARTIAL_PAID`.
- Trả `{payment_id, new_paid_amount, new_status, excess_amount}`.

> **Lưu ý song trùng với trigger**: RPC tự UPDATE status, NHƯNG trigger `trg_payments_recompute_invoice` cũng chạy sau INSERT payment và sẽ tính lại theo logic net (gồm tiền thối). Kết quả cuối cùng do trigger quyết định (chạy sau).

Bản v1 `record_invoice_payment(p_user_id, ...)` đã bị **DROP hẳn** ở RBAC batch F (migration `20260528000004` — quyết định "vẫn drop để đơn giản schema, frontend đã switch"). Hiện chỉ còn `record_invoice_payment_v2`. Luồng **bulk** ([useBulkRecordPayment](src/hooks/useBulkRecordPayment.ts)) vẫn **không** dùng RPC mà insert thẳng `payments` + `income_expenses` rồi dựa vào trigger recompute — comment trong hook viện dẫn check `WHERE user_id = p_user_id` của v1 cũ là **comment lịch sử** (v1 không còn tồn tại).

Hai khác biệt đáng chú ý giữa 2 luồng:

- **`user_id` của payment/voucher trong luồng bulk = OWNER của invoice** (không phải staff đang thao tác — `useBulkRecordPayment` đọc `invoices.user_id` rồi insert với user đó, để RLS `staff_can` scope đúng). Luồng single qua RPC v2 thì trigger `set_user_id_audit` điền `user_id = auth.uid()`; voucher INCOME do [useRecordPaymentRPC](src/hooks/useInvoicePayments.ts) insert cũng mang `user_id = auth.uid()`.
- **Ghi nhận thanh toán 2 pha, KHÔNG atomic**: RPC v2 tạo payment xong, client mới fetch invoice + loại thu rồi insert `income_expenses` + items rời. Nếu bước voucher fail (mất mạng / RLS / chưa có loại thu) → payment tồn tại nhưng **không có phiếu thu** → sổ quỹ thiếu tiền so với `invoices.paid_amount`. Bulk hook cùng pattern (insert payment rồi voucher từng dòng). Chưa có job đối soát payments không có `income_expenses.payment_id`.

### 4.6. RPC sinh hoá đơn hàng loạt — `generate_invoices_for_building_v2`

Chữ ký: `(p_building_id, p_billing_month, p_invoice_type='RENT') → json`. Kiểm `can_do_on_building('invoices','create', building_id)` rồi **delegate v1** `generate_invoices_for_building(owner_id, ...)`.

> **Lưu ý lệch tham số**: v1 chỉ chấp nhận `p_invoice_type` thuộc `{rent_only, service_only, both}` và **RAISE EXCEPTION** nếu khác (`20260530000000:175-177`) — item RENT khi `rent_only`/`both`, item SERVICE khi `service_only`/`both`. Trong khi đó v2 mặc định `p_invoice_type='RENT'` (giá trị KHÔNG nằm trong tập hợp lệ của v1) ⇒ gọi v2 với default sẽ làm v1 raise. Cần truyền đúng `rent_only/service_only/both` khi delegate (khả năng lỗi nếu để default).

V1 lặp qua mọi hợp đồng `ACTIVE` của toà, **bỏ qua** hợp đồng đã có HĐ cùng kỳ, tạo HĐ `status='APPROVED'` (set luôn `approved_at = NOW()`, `approved_by = p_user_id` — sửa bởi `20260510000003_invoice_default_approved.sql`) + item RENT (và item SERVICE từ `contract_services` khi `invoice_type` gồm service), cập nhật `subtotal/total_amount`. Trả `{created_count, skipped_contracts[]}`.

### 4.7. RPC thống kê — `get_invoice_statistics_v2`

Trả các tổng (theo filter area/building/room/billing_month/status/payment_status), RBAC qua `can_access_building`:

- `total_amount/total_paid/total_remaining/total_count`, `total_refunded`.
- Bóc tách theo loại: `rent_amount/electric_amount/water_amount/pdv_amount`.
- Thu theo phương thức: `payment_tm/payment_tk/payment_tt`, `total_collected`.
- `change_amount` (tiền thối — từ `income_expenses.change_amount > 0`), `deposit_collected` (cọc đã thu — IE INCOME có item `is_deposit`, tách riêng không trộn TM/TK/TT).

Dùng bởi [useInvoiceStatistics](src/hooks/useInvoices.ts) → component `InvoiceStatsSummary`.

### 4.8. Audit triggers — `_invoice_audit_invoices/_items/_payments`

3 trigger AFTER INS/UPD/DEL ghi vào `invoice_audit_log`. Helper `_diff_changed_fields` so 2 jsonb để liệt kê field đổi. Trên `invoices` **bỏ qua** `updated_at/paid_amount/remaining_amount` (giảm nhiễu từ trigger recompute); chỉ ghi UPDATE khi có field "thật" đổi.

### 4.9. RPC super admin huỷ cưỡng chế — `super_admin_force_cancel_invoice`

Cho super admin huỷ HĐ ở **mọi trạng thái** (kể cả đã thanh toán). Cơ chế: kiểm `is_super_admin()` → DELETE `excess_amounts` nguồn từ HĐ → **hard-delete payments** (trigger recompute chạy AFTER DELETE sẽ reset paid_amount) → UPDATE status = `CANCELLED`. HĐ vẫn trong DB, có thể phục hồi (`CANCELLED → APPROVED` qua [useRestoreInvoice](src/hooks/useInvoices.ts)) nhưng **payments không khôi phục**.

> Lưu ý kỹ thuật (comment trong migration `20260525000002` ghi misleading): FK `payments.invoice_id ON DELETE RESTRICT` chỉ chặn xoá **invoices** khi còn payments — DELETE **payments** không bị FK nào chặn cả. `SECURITY DEFINER` ở đây dùng để **bypass RLS** (xoá payment thuộc owner khác), **không** phải bypass FK.

### 4.10. RPC công khai — `get_public_latest_invoice_by_code` / `_by_contract`

- `_by_code(p_code)`: resolve `contracts.public_code` (mã 6 ký tự base-57, sinh tự động qua trigger `set_contract_public_code`) → `contract_id` → gọi `_by_contract`.
- `_by_contract(p_contract_id)`: trả HĐ mới nhất (`status NOT IN (DRAFT, CANCELLED)`, sort theo `billing_month DESC`) dạng jsonb. Trả **NULL** nếu HĐ không tồn tại / đã xoá / hợp đồng `TERMINATED`. Không expose `notes/contract_id/user_id`.
- Grant `anon, authenticated` cho `_by_code`. **Thiết kế gốc**: `_by_contract` REVOKE khỏi PUBLIC/anon (`20260530000003`), chỉ gọi nội bộ qua `_by_code`.
- ⚠️ **Regression bảo mật còn mở**: migration muộn hơn `20260601000000_remove_tax_fields.sql` khi CREATE OR REPLACE `_by_contract` (để gỡ cột thuế) đã **GRANT EXECUTE ... TO anon, authenticated trở lại** → hiện anon gọi thẳng `get_public_latest_invoice_by_contract(uuid)` được nếu biết contract UUID. Cần migration REVOKE lại (giữ grant cho `_by_code`). **Quy ước rút ra**: mỗi lần `CREATE OR REPLACE` một RPC public phải re-apply đúng bộ GRANT/REVOKE cũ — recreate xong GRANT bừa sẽ mở lại quyền.

### 4.11. Quy ước TÊN sổ quỹ khi thu tiền (match-by-name)

Cả 3 luồng thu ([RecordPaymentDialog](src/components/invoices/RecordPaymentDialog.tsx), [BulkRecordPaymentDialog](src/components/invoices/BulkRecordPaymentDialog.tsx), `/thu-tien` qua [useQuickCollect](src/hooks/useQuickCollect.ts)) + [useUpdatePaymentMethod](src/hooks/useUpdatePaymentMethod.ts) resolve sổ quỹ bằng **match TÊN account** — đổi tên các sổ này bên domain Sổ quỹ sẽ **gãy luồng thu** (chỉ phát hiện lúc runtime). Các convention đang sống:

- **TM**: sổ tên kết thúc bằng `Thu` thuộc user đang đăng nhập (vd "Hiển Thu") → fallback sổ tên `Chung` → fallback sổ trùng **tên toà**. (Riêng `useUpdatePaymentMethod` lấy sổ Thu của **user đã tạo phiếu** và dừng ở fallback `Chung`, không fallback tên toà — xem §5.8.)
- **TT/TK**: ưu tiên cấu hình `buildings.default_account_id_tt/tk` (theo id, an toàn) → fallback sổ trùng **tên toà**.
- **Tiền thối**: sổ `<tên user> Thối` (vd "Hiển Thối"/"Hiệp Thối" — [ownChangeAccountName](src/lib/changeAccounts.ts)).
- **Làm tròn**: sổ tên đúng `Làm tròn tiền thiếu` (audit metadata khi residual < 10K).
- **BulkRecordPaymentDialog** header auto-pick riêng: sổ trùng tên toà (không dùng `default_account_id_tt/tk`), không match thì bật cột chọn tay.

Logic resolution hiện **lặp ở nhiều file** (chưa gom helper chung) nên dễ lệch nhau khi sửa.

### 4.12. RLS

Bản gốc (`20250601`) là policy `auth.uid() = user_id`. Đã được nâng cấp dần sang RBAC (staff theo toà): các RPC `*_v2` chạy SECURITY DEFINER + `can_do_on_building`/`can_access_building`; thống kê thấy đủ data trong scope (kể cả HĐ do staff khác tạo). `invoice_audit_log` dùng policy `invoice_audit_log_select_visible` (migration `20260514000007`): đọc được khi HĐ thoả `i.user_id = auth.uid()` **HOẶC** `is_admin()` **HOẶC** `is_super_admin()` **HOẶC** `i.user_id ∈ current_visible_owner_ids()` (staff theo owner được gán) — không còn giới hạn "chỉ HĐ của mình".

---

## 5. Quy trình theo từng trang (page)

### 5.1. `InvoicesPage` — Danh sách hoá đơn

- **Route**: `/invoices`. File [InvoicesPage.tsx](src/pages/invoices/InvoicesPage.tsx).
- **Mục đích**: liệt kê, lọc, tìm kiếm, và thực hiện các thao tác hàng loạt trên hoá đơn.
- **Dữ liệu hiển thị**:
  - [useInvoices](src/hooks/useInvoices.ts)(filters, pagination) — list + count, select kèm contract/building/room/items/payments. Lọc theo `building_ids[]/building_id/room_ids/contract_id/status/payment_status/view_status/billing_month/date_range`; mặc định `view_status='active'` ẩn HĐ `CANCELLED`. **`building_ids: string[]`** (từ `BuildingMultiSelect`, commit 099102f) lọc thẳng `.in('building_id', ids)`; `area_id` còn lại là **đường legacy** (fetch building id thuộc area rồi `.in(...)` — 2 round-trip) chỉ chạy khi không có `building_id`/`building_ids`.
  - ⚠️ **Ô tìm kiếm trên toolbar hiện là no-op**: `InvoiceFilters` có field `search` và trang merge `searchQuery` vào `effectiveFilters`, nhưng `queryFn` của `useInvoices` **không có nhánh nào xử lý** `filters.search` — user gõ gì danh sách cũng không đổi, chỉ làm đổi queryKey → 1 refetch cùng kết quả. Cần hoặc áp dụng search thật (ilike `invoice_number`/tên phòng) hoặc gỡ ô search khỏi `InvoiceListToolbar`.
  - Ghi chú hiệu năng: `INVOICE_LIST_SELECT` khá nặng — `*` + contract (+contract_customers+customers) + building + room + **toàn bộ** invoice_items + payments cho mọi dòng; cùng select này dùng cho cả `useInvoice` detail lẫn trang `/thu-tien` (§5.9 — nơi thật sự cần items+payments).
  - Bộ lọc [InvoiceListFilters](src/components/invoices/InvoiceListFilters.tsx): cặp ô Khu vực + Toà nhà cũ gộp thành **`BuildingMultiSelect`** (chọn nhiều toà, nhóm theo khu, click tên khu = chọn cả nhóm — set `filters.building_ids`, clear `area_id`); ô **Phòng gộp theo TÊN** phòng (nhiều toà cùng "101" → 1 mục, map ra `room_ids` — query `.in(room_ids)` giao với `building_ids` nên vẫn đúng); status/payment_status/kỳ dùng `SearchableSelect`.
  - [useInvoiceStatistics](src/hooks/useInvoices.ts) → `InvoiceStatsSummary` (tổng tiền, đã thu, TM/TK/TT, thối, cọc...) — gọi RPC `get_invoice_statistics_v2` với **`p_building_ids uuid[]`** (migration [20260610100000](supabase/migrations/20260610100000_invoice_stats_building_ids.sql) — DROP+CREATE tránh PGRST203 ambiguous overload; `p_area_id` giữ lại nhưng **deprecated**); staff bị ẩn hàng tổng doanh thu (`hideAggregateRow`).
  - Phân quyền: `useMyPermissions` (`can(perms,'invoices', create/edit/delete/record_payment)`). Cơ chế **khoá `area_id` theo `ctx.defaultAreaId`** (quy ước ngầm username = tên khu) đã **GỠ** (9ad626d) — scope staff vốn do RLS per-building quyết định, `BuildingMultiSelect` (nguồn `useBuildings` bị RLS cắt) tự nhiên chỉ hiện toà staff quản; `ctx` chỉ còn dùng cho `isSuper` (restore/force-cancel).

- **Thao tác theo bước**:
  1. **Mở trang** → `useCheckOverdueInvoices` chạy 1 lần (ref guard) → set HĐ quá hạn thành `OVERDUE` → invalidate list/stats.
  2. **Lọc / tìm** → cập nhật `filters`, reset về page 1, clear selection.
  3. **Tạo hoá đơn** (nút Add, cần quyền `create`) → mở `GenerateInvoiceDialog` (xem 5.5).
  4. **Excel / hàng loạt** → `ExcelInvoiceDialog`: tạo HĐ hàng loạt bằng cách lặp [useCreateInvoice](src/hooks/useInvoices.ts) (insert từng HĐ + items, đọc/đối chiếu qua `.from('invoices')`) — **không** gọi RPC bulk. RPC `generate_invoices_for_building_v2` hiện không được FE gọi ở đâu (chỉ khai báo trong `types.ts`).
  5. **Ghi nhận thanh toán** từng dòng → `handleRecordPayment` → mở `RecordPaymentDialog` **hoặc** `RecordRefundDialog` (chọn theo dấu: nếu `total < 0` hoặc `paid > total` → refund).
  6. **Thu hàng loạt** → `BulkRecordPaymentDialog` → [useBulkRecordPayment](src/hooks/useBulkRecordPayment.ts). Dialog này **tự-chứa, không liên quan selection của bảng**: chọn toà + kỳ rồi tự load HĐ `status IN (APPROVED, PARTIAL_PAID, OVERDUE)` AND `remaining_amount > 0` — gồm cả HĐ **đã thu 1 phần**. (Quy tắc "chỉ chọn HĐ `paid_amount === 0`" là của **checkbox select-all trên bảng list**, phục vụ bulk DELETE — không phải bulk thu.)
  7. **Sửa** (`canEdit` + `canEditInvoice`) → `EditInvoiceDialog` → [useUpdateInvoice](src/hooks/useInvoices.ts) (chặn nếu trạng thái không cho sửa).
  8. **Xoá** → [useDeleteInvoice](src/hooks/useInvoices.ts) (soft-delete). [canDeleteInvoice](src/lib/invoiceUtils.ts) có 2 nhánh: user thường = giống `canEditInvoice` (`DRAFT/APPROVED` chưa thu tiền); **super admin** (`opts.isSuper`) = xoá được HĐ ở **mọi trạng thái** trừ `CANCELLED` và HĐ đã soft-delete. ⚠️ **Bulk xoá gần như là silent no-op**: [useBulkDeleteInvoices](src/hooks/useInvoices.ts) chỉ update `WHERE status='DRAFT'`, trong khi select-all chọn HĐ `paid_amount === 0` (đa số `APPROVED` vì FE auto-duyệt) → toast "XOÁ thành công" nhưng 0 hoá đơn thực sự bị xoá (hook không đếm row thật sự update).
  9. **Super admin**: `onRestore` (CANCELLED→APPROVED), `onForceCancel` → `SuperAdminForceDeleteDialog` → [useForceCancelInvoice](src/hooks/useInvoices.ts).
  10. **Xem chi tiết / lịch sử / payments** → điều hướng `/invoices/:id` hoặc mở `InvoiceHistoryDialog` / `PaymentsSummaryDialog` (dialog payments **không chỉ xem** — sửa/xoá được, xem §5.8).

- **Edge case**: (đường `area_id` legacy) area không có toà nào → list trả rỗng ngay (không query); lỗi unique `(contract_id, billing_month)` → toast thân thiện; `payment_status='unpaid'` loại cả `PAID` lẫn `PARTIAL_PAID`.

- **Hooks legacy/dead còn nằm trong [useInvoices.ts](src/hooks/useInvoices.ts)** (đọc code đừng tưởng là luồng sống): `useApproveInvoice`/`useUnapproveInvoice`/`useBulkApproveInvoices` (duyệt DRAFT↔APPROVED — vô dụng vì FE auto-APPROVED khi tạo, **không còn caller nào**) và `useRecordPayment` legacy (insert payment + tự cộng `paid_amount` bằng tay, không tạo phiếu thu — **không còn caller nào**; luồng sống là `useRecordPaymentRPC`/`useBulkRecordPayment`).

### 5.2. `InvoiceDetailPage` — Chi tiết hoá đơn

- **Route**: `/invoices/:id`. File [InvoiceDetailPage.tsx](src/pages/invoices/InvoiceDetailPage.tsx).
- **Mục đích**: xem đầy đủ 1 hoá đơn — thông tin, các khoản, lịch sử thanh toán, tóm tắt thu/thối, và các action.
- **Dữ liệu**:
  - [useInvoice](src/hooks/useInvoices.ts)(id) — HĐ + relations.
  - Query phụ `invoice-vouchers`: các `income_expenses` APPROVED gắn `invoice_id` (phiếu thu INCOME / phiếu chi thối EXPENSE) để hiển thị breakdown từng phiếu (tổng thu +, tổng thối −).
- **Thao tác**:
  - **Ghi nhận thanh toán / Hoàn trả khách** (cần `record_payment`, status `APPROVED/PARTIAL_PAID/OVERDUE`): nút đổi nhãn/màu theo `isRefund` (total<0 hoặc paid>total) → mở dialog tương ứng.
  - **In hoá đơn** → `PrintInvoiceDialog` (dẫn sang `InvoicePrintPage`).
  - **QR hợp đồng** → `ContractQRDialog` (dùng `contract.public_code`, ẩn nếu HĐ `TERMINATED`).
  - **Sửa** (nếu `canEditInvoice`), **Huỷ** (`DRAFT/APPROVED`), **Phục hồi** (super admin, `CANCELLED`).
- **Hiển thị tài chính**: "Đã thanh toán net" = `paid_amount`; "Còn lại" = `total − paid`; cảnh báo PAID / quá hạn. Ảnh chứng từ payment qua `StorageImage` (signed URL, bucket private).
- **Edge case**: id rỗng / không tìm thấy → màn lỗi với nút quay lại; HĐ quá hạn highlight đỏ.

### 5.3. `InvoicePrintPage` — Bản in hoá đơn

- **Route**: `/invoices/print/:id` (khai báo trong [App.tsx](src/App.tsx)). File [InvoicePrintPage.tsx](src/pages/invoices/InvoicePrintPage.tsx). (Lưu ý: `PrintInvoiceDialog` render HTML in inline qua `window.open`, **không** điều hướng route này.)
- **Mục đích**: render layout in/PDF theo `template_id` (mẫu `document_templates` loại `INVOICE`). Dữ liệu lấy từ cùng hook invoice + relations.

### 5.4. `PublicContractInvoicePage` — Trang công khai (khách quét QR)

- **Route**: `/c/:code` (mã ngắn). File [PublicContractInvoicePage.tsx](src/pages/public/PublicContractInvoicePage.tsx).
- **Mục đích**: cho khách (không đăng nhập) xem **hoá đơn mới nhất** của hợp đồng.
- **Dữ liệu**: `useQuery` gọi RPC `get_public_latest_invoice_by_code({p_code})`.
- **Luồng hiển thị**:

```mermaid
flowchart TD
    A["Khách quét QR /c/:code"] --> B["RPC get_public_latest_invoice_by_code"]
    B --> C{Mã hợp lệ?}
    C -->|"NULL (sai/đã thanh lý/đã xoá)"| D["Màn 'Mã QR không khả dụng'"]
    C -->|"có data, invoice=NULL"| E["Màn 'Phòng chưa có hoá đơn'"]
    C -->|"có invoice"| F["Render: thông tin + khoản thu + tóm tắt"]
    F --> G["Badge trạng thái, cảnh báo quá hạn"]
```

- **Đặc điểm**: item `RENT` luôn hiển thị "Tiền phòng"; tách phần `(...)` cuối description thành note (vd "Tiền điện (8794 → 9200)"); các dòng điều chỉnh (Giảm trừ, Nợ cũ kỳ trước) chèn trước "Tổng cộng" để cộng khớp. Responsive desktop (grid 4 cột) / mobile (2 cột).
- **Edge case**: error hoặc data null → màn lỗi; HĐ `PAID` → alert xanh; quá hạn + còn nợ → alert đỏ.

### 5.5. Dialog tạo hoá đơn — `GenerateInvoiceDialog` (thao tác cốt lõi của trang list)

File [GenerateInvoiceDialog.tsx](src/components/invoices/GenerateInvoiceDialog.tsx). Đây là luồng **tạo 1 hoá đơn thủ công** (khác RPC bulk).

```mermaid
flowchart TD
    A["Chọn hợp đồng + kỳ"] --> B["Auto-fill: tiền phòng, chỉ số điện/nước, dịch vụ"]
    B --> C["Tính điện = (current-prev)*đơn giá; nước; PDV; khoản tùy chỉnh"]
    C --> D["Nợ cũ kỳ trước (computePreviousDebt) + áp credit (excess) vào giảm trừ"]
    D --> E["total = subtotal − discount + previous_debt"]
    E --> F["useCreateInvoice.mutate → INSERT invoices (status APPROVED) + invoice_items"]
    F --> G{applied_credit>0?}
    G -->|có| H["INSERT excess_amounts âm (tiêu credit)"]
    G -->|không| I[Done]
```

- **Validate (zod)**: `contract_id` bắt buộc, `billing_month` regex `YYYY-MM`, ngày phát hành/hạn bắt buộc, số lượng item > 0, giá `>= 0`.
- **Edge case**: nút Tạo bị **disable** nếu hợp đồng đã có HĐ cùng kỳ (`existingInvoice`); chỉ chọn được hợp đồng đang hiệu lực ([isContractInEffect](src/types/contract.ts) — **chỉ `ACTIVE`**; trạng thái `EXTENDED` đã ngưng dùng từ 2026-06-06, HĐ gia hạn giữ nguyên `ACTIVE`, dấu "đã gia hạn" suy từ bảng `contract_extensions`).

### 5.6. Dialog ghi nhận thanh toán — `RecordPaymentDialog`

File [RecordPaymentDialog.tsx](src/components/invoices/RecordPaymentDialog.tsx) → [useRecordPaymentRPC](src/hooks/useInvoicePayments.ts).

Mỗi sub-line (TM/TK/TT) gọi `record_invoice_payment_v2` rồi insert kèm **1 phiếu thu `income_expenses` INCOME** (gắn `invoice_id`, `payment_id`, `account_id`, `creator_name`). Xử lý 3 cơ chế đặc biệt, tất cả là **metadata audit không trừ số dư**:

- **Tiền thối** (`change_amount` + `change_account_id`): khấu trừ vào line TM (`amount = line − change`), ghi note "Thu X – Thối Y". Validate: chỉ áp TM, `change ≤ tổng TM`.
- **Giữ credit** (`keep_as_credit`): không khấu trừ, insert `excess_amounts` dương cho contract.
- **Làm tròn thiếu** (`rounding_amount` + `rounding_account_id`): residual < 10K, gắn lên line cuối; trigger DB tự mark `PAID`.

`RecordRefundDialog` ([useRecordRefundRPC](src/hooks/useInvoicePayments.ts)) dùng cho HĐ thanh lý **total âm**: tạo phiếu chi EXPENSE loại "Hoàn trả thanh lý" với marker `[Hoàn trả thanh lý]` trong notes.

> **Khác biệt cần lưu ý (có thể là regression)**: bản `recompute_invoice_for_id` hiện hành (`20260530000002:41-50`) chỉ trừ refund qua phiếu chi EXPENSE có `income_expense_type.name = 'Tiền thối'`; nó **KHÔNG còn nhận diện marker `[Hoàn trả thanh lý]`** (logic đọc marker cũ ở `20260510000014` đã bị bỏ ở `20260527000061`). Trong khi đó FE `useRecordRefundRPC` vẫn ghi marker `[Hoàn trả thanh lý]` theo logic cũ (loại phiếu chi tên `'Hoàn trả thanh lý'`, không phải `'Tiền thối'`) ⇒ với recompute hiện tại, refund kiểu này sẽ **không** được cộng/trừ vào `paid_amount`. Chưa rõ là cố ý — cần đối chiếu lại FE/DB.

### 5.7. `InvoiceHistoryDialog` — Lịch sử audit

[useInvoiceHistory](src/hooks/useInvoiceHistory.ts) đọc `invoice_audit_log` theo `invoice_id`, sort mới nhất trước; hiển thị diff `changed_fields` + actor + thời gian.

### 5.8. `PaymentsSummaryDialog` — Xem & SỬA payments sau khi thu

File [PaymentsSummaryDialog.tsx](src/components/invoices/PaymentsSummaryDialog.tsx), mở từ bảng list (bước 10 §5.1). Liệt kê payments của HĐ qua query riêng `invoice-payments-summary` (select có `created_at`, sort cũ → mới). Dialog **không chỉ "xem"** — có 3 thao tác ghi:

1. **Đổi phương thức TM/TT/TK** của payment đã tồn tại → [useUpdatePaymentMethod](src/hooks/useUpdatePaymentMethod.ts): đồng thời **chuyển `account_id` của phiếu thu `income_expenses` liên kết** (tìm qua `payment_id`) sang sổ quỹ mới. Resolution giống `RecordPaymentDialog`: TM = sổ "…Thu" của **user đã tạo phiếu** (`payment.user_id`, không phải user đang thao tác) → fallback sổ "Chung"; TT/TK = `buildings.default_account_id_tt/tk` → fallback sổ trùng tên toà. Không resolve được sổ → throw, không đổi gì. Payment đã đúng phương thức → skip.
2. **Upload / paste ảnh chứng từ** vào payment chưa có ảnh → [useUploadPaymentReceipt](src/hooks/useUploadPaymentReceipt.ts): upload Storage (bucket `payment-receipts` → fallback `documents/receipts/`), set `payments.receipt_image_url`, và **append** URL vào `income_expenses.attachments` của voucher liên kết (chứng từ hiện cả bên Thu chi). Hỗ trợ click chọn file hoặc hover + Ctrl/Cmd+V dán từ clipboard; giới hạn ảnh ≤ 5MB.
3. **Xoá payment** (confirm dialog) → [useDeletePayment](src/hooks/useDeletePayment.ts), 3 bước: (a) **soft-delete** voucher `income_expenses` có `payment_id` match; (b) **hard-delete** `excess_amounts` có `source_payment_id` (credit "Nợ kỳ sau" huỷ theo); (c) **hard-delete** row `payments` → trigger recompute hạ `paid_amount`/status. Delete count = 0 (RLS chặn) → báo lỗi quyền.

### 5.9. `ThuTien` — Trang thu tiền mặt mobile `/thu-tien`

- **Route**: `/thu-tien` (khai báo trong [App.tsx](src/App.tsx) — **lazy-load** + CSS cô lập `thu-tien.css` scope dưới `.tt-page`, font riêng Be Vietnam Pro / Space Mono chỉ nạp khi mở trang, không đụng theme site). Sidebar: mục "Thu tiền" trong nhóm Tài chính.
- **Mục đích**: trang mobile-first thu tiền **MẶT** nhanh theo lưới ô phòng — chọn 1 toà + 1 kỳ, mỗi ô phòng = 1 hoá đơn.
- **Cấu trúc**: [ThuTien.tsx](src/pages/ThuTien.tsx) + 13 component trong [src/components/thu-tien/](src/components/thu-tien/) + helpers thuần ([collect.ts](src/lib/collect.ts) — không side-effect, test dễ):
  - `BuildingPills` chọn toà (từ `useBuildings` — đã scope RLS theo user/staff, auto chọn toà đầu tiên); input kỳ `type="month"`. **Không có lọc khu vực**.
  - `TimeFilter`/`DatePanel` lọc theo **ngày thu** (so `payment_date` của payments, client-side); `StatusFilter` đã thu / chưa thu / tất cả.
  - `RoomCellGrid`/`RoomCell`: ô phòng tô màu theo `collectStatus()` — 3 trạng thái thu suy từ HĐ (`paid` = PAID hoặc remaining ≤ 0; `partial` = PARTIAL_PAID hoặc đã thu > 0; `unpaid` = còn lại). Nút **"Thu đủ"** (qua `ConfirmCollectDialog` chống bấm nhầm) / **"Thu 1P"** (mở keypad); nút **Zalo** khách đại diện (`repCustomer` + `zaloUrl`).
  - `CollectDrawer`: sheet chi tiết HĐ + `CollectKeypad` nhập số tiền theo **nghìn đồng** + nút **Hoàn tác** + `NoteEditor` ghi chú; điều hướng prev/next trong danh sách đã lọc.
  - `CollectionReport`: báo cáo thu theo toà/ngày/kỳ — [useCollectionReport](src/hooks/useCollectionReport.ts) tái dùng `useInvoices({building_id?, billing_month})`; option **"Tất cả tòa"** → `building_id` undefined → mọi toà trong scope RLS, group client-side theo tên toà.
- **Data flow** (phối hợp domain Thu chi — trang này TẠO payments + phiếu thu `income_expenses` THẬT):

```mermaid
flowchart TD
    A["Ô phòng RoomCell"] -->|"Thu đủ"| B["ConfirmCollectDialog"]
    A -->|"Thu 1P"| C["CollectDrawer + CollectKeypad (nhập nghìn đồng)"]
    B --> D["useQuickCollect.collect — cap amount ≤ remaining"]
    C --> D
    D --> E["useBulkRecordPayment với đúng 1 item TM-only"]
    E --> F["INSERT payments + income_expenses (user_id = OWNER của invoice)"]
    F --> G["trigger recompute_invoice_for_id → paid_amount / status"]
    D -.->|"residual sau thu dưới 10K"| H["rounding metadata + sổ 'Làm tròn tiền thiếu' → PAID"]
```

  - [useQuickCollect](src/hooks/useQuickCollect.ts) **bọc** [useBulkRecordPayment](src/hooks/useBulkRecordPayment.ts) (không phát minh lại mutation): cap `amount ≤ remaining`; resolve sổ quỹ TM **theo TÊN** (sổ "…Thu" của user đăng nhập → sổ "Chung" → sổ trùng tên toà — **throw** nếu không có, chặn insert `account_id` rỗng — xem convention §4.11); residual sau thu `0 < x < 10K` → tự đính **rounding metadata** (`rounding_amount` + sổ "Làm tròn tiền thiếu") để trigger DB mark `PAID`.
  - **Hoàn tác** = [useDeletePayment](src/hooks/useDeletePayment.ts) xoá payment "gần nhất". ⚠️ Chọn payment qua `latestPaymentId` ([collect.ts](src/lib/collect.ts)) so sánh `payment_date` (**DATE, không có giờ**) — nhiều payment cùng ngày → lấy phần tử cuối theo thứ tự mảng trả về (không deterministic, vì select `payments` trong `INVOICE_LIST_SELECT` không có `created_at`) ⇒ có thể xoá nhầm phiếu cùng ngày. Fix gợi ý: thêm `created_at` vào select và sort theo nó.
  - **Ghi chú** ghi thẳng vào `invoices.notes` qua [useUpdateInvoiceNote](src/hooks/useUpdateInvoiceNote.ts) (note đứng-một-mình khi phòng chưa thu, không cần payment).
- **Quyền**: nút thu gate bởi `can(perms,'invoices','record_payment')`; RLS cho staff thao tác HĐ trong phạm vi phụ trách.
- **Giới hạn**: không phân trang (kéo toàn bộ HĐ của toà+kỳ — và mọi toà khi báo cáo "Tất cả tòa" — với full relations một phát; chấp nhận được ở quy mô vài trăm phòng); **không chạy** `useCheckOverdueInvoices` → trạng thái `OVERDUE` có thể lệch với `/invoices` trong ngày (xem §4.1).

---

## 6. Liên kết sang domain khác (vào/ra)

**Đi RA (domain này phụ thuộc / ghi sang):**

- → **Thu chi (income_expenses)**: liên kết mạnh nhất. Mỗi payment ⇒ 1 phiếu thu INCOME (`income_expenses.invoice_id` + `payment_id`). Có **3 đường ghi**: `RecordPaymentDialog` (RPC v2 + insert voucher rời), `BulkRecordPaymentDialog` và trang **`/thu-tien`** (§5.9) — 2 đường sau qua `useBulkRecordPayment` insert thẳng payments + voucher (`user_id` = owner của invoice, `approval_status='APPROVED'`). Chiều ngược: **xoá payment** (`PaymentsSummaryDialog` §5.8 / nút Hoàn tác `/thu-tien`) **soft-delete voucher liên kết**. Phiếu chi loại **"Tiền thối"** gắn `invoice_id` được trigger recompute đọc ngược để trừ vào `paid_amount` net (xem §4.3 — bản recompute hiện chỉ đọc loại `'Tiền thối'`; phiếu chi marker `[Hoàn trả thanh lý]` mà FE vẫn ghi thì recompute hiện KHÔNG còn nhận diện — xem ghi chú §5.6). Sổ quỹ (`accounts`) nhận tiền qua `account_id` của phiếu thu.
- → **Hợp đồng (contracts)**: hoá đơn luôn gắn `contract_id`; tạo HĐ chỉ cho hợp đồng đang hiệu lực (`isContractInEffect` — chỉ `ACTIVE`, xem §5.5); `previous_debt_sources` truy nguồn nợ từ HĐ cũ / cọc — khi HĐ mới `PAID`, trigger `trg_settle_previous_debt` (§4.4) tự tất toán HĐ nợ gốc và **cộng `contracts.deposit_paid`** (chảy vào kiến trúc theo dõi cọc). `contracts.public_code` cấp link QR công khai.
- → **Toà nhà / Phòng (buildings/rooms)**: scope RBAC (`can_do_on_building`; bộ lọc nhiều toà `building_ids` từ `BuildingMultiSelect`), `default_account_id_tt/tk` của toà gợi ý sổ quỹ khi thu.
- → **Chỉ số công tơ (meter_readings) & Dịch vụ (services/contract_services)**: nguồn dữ liệu auto-fill khoản điện/nước/dịch vụ khi tạo HĐ; `invoice_items.service_id → services`.
- → **Cọc (deposits / contract_terminations)**: nợ cũ có thể trừ cọc; thanh lý bỏ cọc giữ tiền đã thu khiến HĐ tháng đó CANCELLED nhưng vẫn còn payment (lý do recompute giữ CANCELLED).
- → **Mẫu in (document_templates)**: `template_id` cho bản in.

**Đi VÀO (domain khác đọc/tham chiếu hoá đơn):**

- ← **Thu chi**: phiếu thu/chi tham chiếu `invoice_id`/`payment_id`; báo cáo doanh thu, sổ quỹ cộng dồn từ các phiếu này.
- ← **Báo cáo / Dashboard**: thống kê công nợ, đã thu theo TM/TK/TT, cọc — qua `get_invoice_statistics_v2`.
- ← **Trang công khai**: khách quét QR (`/c/:code`) đọc hoá đơn mới nhất.
- ← **Thông báo (notifications)**: enum `notification_type` có `NEW_INVOICE`, `PAYMENT_REMINDER`, `OVERDUE_INVOICE` — các thông báo này được tạo **client-side** từ FE helpers ([invoiceHelpers.ts](src/lib/invoiceHelpers.ts): `createInvoiceNotification`/`createPaymentReminderNotification`/`createOverdueNotification` + [notificationScheduler.ts](src/lib/notificationScheduler.ts)), **không phải DB trigger** — không ai mở app thì không có thông báo mới sinh ra.
