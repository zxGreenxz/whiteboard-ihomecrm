# Phiếu cọc giữ chỗ: ảnh chứng từ, sổ quỹ, và STK người nhận thưởng

**Ngày**: 2026-08-20 · **Trạng thái**: đã chốt với chủ dự án

## Vấn đề

Hộp thoại "Tạo phiếu cọc giữ chỗ" (`/deposits` → nút *Tạo đặt cọc*) thiếu bốn thứ mà người
dùng cần khi thu cọc thật:

1. Phiếu cọc **không chọn được sổ quỹ** — dialog tự chọn ngầm: cọc > 1đ lấy sổ mặc định của
   người tạo, còn lại lấy sổ CỌC ảo qua `get_or_create_deposit_account`.
2. Phiếu cọc **không đính kèm được ảnh** chứng từ.
3. Phiếu thưởng nóng Sale **không chọn được sổ quỹ** và **không đính kèm được ảnh**.
4. STK và ngân hàng người nhận thưởng: RPC có nhận tham số nhưng chỉ **ghép vào `notes`**
   dạng chữ, không vào cột `receive_bank_account` / `receive_bank_name` — nên không hiện ở
   nơi nào đọc theo cột, và không lọc/đối chiếu được.

## Quyết định của chủ dự án (20/08/2026)

| Câu hỏi | Chốt |
|---|---|
| Sổ quỹ phiếu cọc | **Bắt buộc chọn** — không điền sẵn, thiếu thì không lưu được |
| Sổ quỹ phiếu thưởng | **Để trống**, người dùng tự chọn khi cần |
| Đưa migration lên production | **Tự apply** khi gate xanh, không hỏi lại |

Hệ quả đã biết của "bắt buộc chọn": đường tự lấy **sổ CỌC ảo** cho phiếu giữ chỗ 1đ không
còn chạy ngầm. Sổ ảo vẫn nằm trong danh sách nếu tổ chức đã có, người dùng chọn tay.

## Thay đổi

### A. Giao diện `CreateDepositDialog`

Khối *phiếu cọc* thêm:
- **Sổ quỹ** (bắt buộc): `Select` từ `useAccounts`, hiển thị `name` + `code`.
- **Ảnh chứng từ**: `AttachmentUpload` (bucket `income-expense-attachments`, JPG/PNG/PDF ≤ 5MB).

Khối *Thưởng nóng Sale* thêm: **Sổ quỹ** (tuỳ chọn, mặc định trống), **STK người nhận**,
**Ngân hàng**, **Ảnh chứng từ**.

Bố cục bám khuôn mục "Thưởng nóng Sale" của `CommissionVoucherModal` để hai màn hình
nhìn giống nhau.

### B. Migration `create_sale_bonus_from_deposit_v1` (v2)

Theo án lệ `20260806090000` (thêm tham số DEFAULT sinh overload ⇒ PostgREST báo
"function is not unique"): `DROP` chữ ký 6 tham số, tạo lại **chép nguyên thân hàm đang chạy
trên production** rồi thêm:

- `p_account_id uuid DEFAULT NULL` → cột `account_id`. Kiểm quyền ngay trong hàm: sổ phải
  cùng tổ chức với phiếu, và người gọi phải là **chủ sổ** hoặc có
  `cashbook_possession_bindings` còn hiệu lực với `possession_kind IN ('CUSTODIAN','OPERATOR')`.
  `KNOWER` **không** được vì đây là phiếu CHI (đúng §9.2 mà `create_income_expense_v1` áp).
- `p_attachments jsonb DEFAULT '[]'` → cột `attachments`. Validate: phải là mảng, mọi phần tử
  là chuỗi.
- `p_account_number` → cột `receive_bank_account`; `p_bank` → cột `receive_bank_name`.
  **Vẫn giữ nguyên chuỗi `notes` như cũ** — không đổi thứ người dùng đang nhìn thấy.

Giữ nguyên toàn bộ phần còn lại: luôn ra `UNAPPROVED`, chống chi trùng hai hướng, chốt trần
`sale_bonus_cap_for_v1`, cửa hẹp `SALE_BONUS_DEPOSIT`, sổ `sale_bonus_claims`.

Phiếu cọc **không cần migration**: nó đi `create_income_expense_v1`, hàm này đã nhận sẵn
`p_account_id`, `p_attachments`, `p_receive_bank_*` và tự kiểm quyền sổ quỹ.

### C. Kiểm chứng

- Unit test đo **định nghĩa sống** của hàm (khuôn `liveDefinitionOf`, không ghim file
  migration — gate `check-migration-test-liveness`).
- Chạy thật trên org **DEMO**: tạo phiếu cọc có sổ quỹ + ảnh, kèm thưởng đủ STK/ngân
  hàng/ảnh/sổ quỹ, rồi đọc lại DB xác nhận hai phiếu có đúng `account_id`, `attachments`,
  `receive_bank_*`.

## Không làm

Không đổi trạng thái duyệt của phiếu thưởng, không thêm trần, không đụng form Thu-chi,
không đụng `CommissionVoucherModal`.
