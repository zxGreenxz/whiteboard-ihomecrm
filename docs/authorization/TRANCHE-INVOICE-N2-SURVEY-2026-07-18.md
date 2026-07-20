# Khảo sát INVOICE nhịp 2 (2026-07-18) — create parity + force-cancel

> **Lifecycle:** historical build evidence. Các gap được xử lý trong tranche sau và hệ canonical đã go-live; xem [README.md](README.md). File được giữ vì các SQL `t5_14`/`t5_15` tham chiếu trực tiếp.

Verified prod DDL + client payload (useInvoices.ts + GenerateInvoiceDialog). Nhịp 1 (8 status-writer) đã VERIFIED.

## 1. `create_invoice_v1` — KHÔNG wireable nguyên trạng (drop field lớn)

Writer 13 args: contract/building/room/billing_month/issue/due/kind/subtotal/discount/total/previous_debt/items/idempotency — có ledger `invoice.create.v1` + route flag (OFF) + authorize + auto-approve server.

**Client payload set THÊM (sẽ bị drop nếu wire):** `prepaid_amount`, `discount_notes`, `electricity_prev_overridden`, `previous_debt_sources` (jsonb), `template_id`, `notes`, `creator_name`, và **cả bước tiêu credit** (insert `excess_amounts` âm khi applied_credit>0) + client tự sinh `invoice_number` + client tự làm tròn (`roundInvoiceTotal`: <900 xuống, ≥900 lên bội 1000).

**Việc nhịp 2 (giống cashbook parity-extend):**
1. DROP+recreate `create_invoice_v1` thêm ~7 tham số parity + `p_applied_credit` (writer tự insert excess_amounts âm trong cùng tx) + để trigger `generate_invoice_number_v2` sinh số (bỏ client-gen) + verify công thức làm tròn server-side khớp `roundInvoiceTotal`.
2. Items parity: client gửi service_id/type/description/unit_price/quantity/coefficient/amount/previous_reading/current_reading/from_date/to_date/sort_order — đối chiếu whitelist writer.
3. Wire `useCreateInvoice` + fallback (flag `invoice.create.v1` OFF sẵn); `useUpdateInvoice` cần writer MỚI `update_invoice_v1` (replace items, guard canEditInvoice server-side).
4. GenerateInvoiceDialog:490 (bulk generate) — khảo sát payload riêng khi build.

## 2. `super_admin_force_cancel_invoice` — VI PHẠM "không xoá lịch sử tiền" (FORK owner)

Confirmed DDL: DELETE excess_amounts + **hard-DELETE payments** (comment thừa nhận bypass FK RESTRICT bằng DEFINER) → trigger reset paid=0 rồi CANCELLED. Đề xuất redesign khi owner chốt:
- **(a)** thay bằng vòng lặp `reverse_invoice_payment_v3` (compensating, giữ lịch sử) + `cancel_invoice_v1` — audit đầy đủ, nhưng để lại record hoàn tiền thay vì "sạch";
- **(b)** giữ hard-delete nhưng chỉ sau khi snapshot payments vào bảng audit riêng;
- **(c)** giữ nguyên (chấp nhận rủi ro, super-admin-only).
Khuyến nghị: (a). **DESIGN-BLOCKED chờ owner.**

## 3. Ghi chú tree-shake (đã học từ nhịp 1)

`useApproveInvoice/useUnapproveInvoice/useBulkApproveInvoices` là dead exports (không UI import — hoá đơn sinh ra APPROVED sẵn). Writer server vẫn hữu dụng qua REST/tương lai. Khi build nhịp 2 chọn sentinel string kiểm deploy = tên fn có UI dùng thật.
