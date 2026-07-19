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

## ✅ CẬP NHẬT SAU BUILD (cùng ngày): t5_10 APPLIED + phát hiện dead-code

1. **t5_10 đã áp prod + REST verified** (`approve_contract_termination_v1`: atomic 5
   bước, bút toán hoàn cọc = phiếu chi NHÁP, phòng AVAILABLE, idempotent no-op;
   `reject_…`: mirror DRAFT + prefix "[Từ chối]"). Wire hook fb3af43 (main).
   Trong build phát hiện thêm 4 ràng buộc schema: status CHECK
   (DRAFT/PENDING_APPROVAL/APPROVED/COMPLETED — KHÔNG có REJECTED), type CHECK
   (NORMAL/EARLY_TENANT/EARLY_OWNER/BREACH/FORFEIT), refund>0 đòi refund_method,
   UNIQUE 1 termination/hợp đồng, refund_amount + total_deductions là GENERATED.
2. **REFRAME mức độ bug cash_book:** `useApproveTermination`/`useRejectTermination`/
   `usePendingTerminations` là **DEAD CODE** — không màn hình nào import (tree-shaken
   khỏi bundle, giống bộ approve-invoice). Luồng thanh lý THẬT = `useContractOperations.ts`
   → `terminate_contract_forfeit`/`terminate_contract_move_out`/`transfer_contract`
   (RPC server-side, authorize verified: `is_super_admin OR can_do_on_building('contracts','edit',
   building-qua-room)` — parity chuẩn, wrapper+impl). ⇒ bug cash_book là **TIỀM ẨN**
   (không kích hoạt được từ UI hiện tại), t5_10 là hardening cho đường dự phòng —
   nếu UI hàng-chờ-thanh-lý được hồi sinh thì giờ đã an toàn. KHÔNG cần browser smoke.
3. Việc còn lại của domain: parity `create_contract_v1` (P2) + sync customers/services
   (P3) — theo bảng trên.

## Thứ tự đề xuất nhịp build contract

1. `approve_contract_termination_v1` + `reject_contract_termination_v1` (atomic, permission parity, giữ nguyên side-effect thứ tự hiện tại).
2. Parity-check `create_contract_v1` vs payload client (4 bước) → extend nếu drop field.
3. Wire + REST + browser (Opus 4.8) như các domain trước; flag OFF/parity — activate sau.
