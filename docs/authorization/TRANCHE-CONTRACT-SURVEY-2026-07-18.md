# Khảo sát domain DEPOSIT-CONTRACT (2026-07-18) — chuẩn bị nhịp build

Verified trực tiếp prod + đọc code. Trạng thái: **SURVEY xong, chưa build.**

## Đã có sẵn trên prod

- `create_contract_v1(10 args)` — flag `contract.create.v1` **OFF**; `deposit.hold.v1` **OFF**.
- **Termination/transfer ĐÃ là RPC server-side** (sprint trước, granted authenticated,
  pattern wrapper+`_impl`): `terminate_contract_forfeit`, `terminate_contract_move_out`,
  `transfer_contract`. Cascade tiền thanh lý phần lớn đã đóng gói — KHÔNG cần viết lại,
  chỉ cần rà authorize bên trong (tranche riêng nếu lỏng).

## Write-site client còn trần (useContracts.ts)

| Hook | Tính chất | Ưu tiên |
|---|---|---|
| `useApproveTermination` (:1373) | **NGUY HIỂM NHẤT**: cascade 5 bước client-side không atomic: terminations→APPROVED → contracts→TERMINATED → terminations→COMPLETED → **insert `cash_book`** (DEPOSIT_REFUND/FORFEIT) → rooms→AVAILABLE. Đứt giữa chừng = trạng thái lửng + sai tiền. | P1 — cần `approve_contract_termination_v1` atomic |
| `useRejectTermination` (:1475) | update terminations REJECTED | P2 (gộp cùng writer P1) |
| `useCreateContract` (:706) | insert contract + contract_customers + contract_services + room OCCUPIED (4 bước) — đã có `create_contract_v1` nhưng cần đối chiếu parity payload như IE/cashbook | P2 |
| `useUpdateContract` / `useSyncContractCustomers` / `useSyncContractServices` | update/delete+insert trần | P3 |
| `useDeleteContract` (:1022) | soft-delete | P3 |
| `useBulkCreateContracts` (:1535) | import loạt | P3 |

Lưu ý: bảng `cash_book` (bảng cũ) ≠ `accounts` — writer termination phải làm rõ nguồn
chuẩn ghi tiền hoàn/thu thanh lý (đối chiếu với luồng thu chi hiện đại trước khi build).

## ⚠️ BẰNG CHỨNG MỚI (cùng ngày, verified prod): luồng duyệt thanh lý CÓ HOÀN TIỀN đang HỎNG THẬT

`public.cash_book` **không tồn tại trên prod** (đã bị drop/thay thế), trong khi
`useApproveTermination` bước 4 insert vào đó khi `refund_amount ≠ 0`. Hệ quả mỗi
lần duyệt thanh lý có hoàn/thu thêm: bước 1-3 ĐÃ commit (terminations
APPROVED→COMPLETED, contracts TERMINATED) rồi throw ở bước 4 → **phòng kẹt
OCCUPIED, không có bút toán tiền hoàn cọc**. Chỉ đường refund_amount=0 chạy trọn.
⇒ Writer `approve_contract_termination_v1` không chỉ là hardening mà là **bug-fix
sản xuất**: ghi tiền qua luồng hiện đại (phiếu income_expenses loại "Hoàn cọc
thanh lý"/"Thu thanh lý (khách trả thêm)" — type đã tồn tại) thay cash_book chết,
atomic cả 5 bước + trả phòng AVAILABLE.

RLS contract_terminations UPDATE: permissive `update_rbac` + super_admin_all,
restrictive org_boundary (mirror như invoice). Cột có đủ organization_id.

## Thứ tự đề xuất nhịp build contract

1. `approve_contract_termination_v1` + `reject_contract_termination_v1` (atomic, permission parity, giữ nguyên side-effect thứ tự hiện tại).
2. Parity-check `create_contract_v1` vs payload client (4 bước) → extend nếu drop field.
3. Wire + REST + browser (Opus 4.8) như các domain trước; flag OFF/parity — activate sau.
