# AI Copilot

> **Current through:** 2026-07-20  
> **Status:** đã triển khai chat, UI-control có gate, tool nghiệp vụ đọc và một write tool draft-first.

## Bề mặt đang chạy

- Nút Copilot chỉ hiện khi có session, entitlement và quyền `ai_copilot.view`.
- Chat gọi model qua Edge Function `llm-proxy`; provider/key/quota nằm server-side, trừ provider local được cho phép.
- Tool đọc hiện có: phòng trống, khách hàng, hóa đơn, hợp đồng sắp hết hạn, KQKD tháng và tra cứu `docs/he-thong/*.md`.
- UI-control chỉ chạy khi entitlement + quyền `ai_copilot.ui_control` hợp lệ; route điều hướng nằm trong allowlist.
- Tool ghi `tao_phieu_thu_chi_nhap` bắt buộc xem trước + xác nhận hai bước, idempotency và audit; chỉ tạo phiếu nháp chưa vào sổ để người thật kiểm tra.

## Tài liệu

- [PLAN.md](PLAN.md) — thiết kế v2.1 và rationale; các câu “sẽ làm” cũ phải đọc cùng README này.
- [SPIKE-RESULTS.md](SPIKE-RESULTS.md) — bằng chứng spike ngày 10/07, không phải status vận hành.
- Tham chiếu hệ thống: [../he-thong/21-ai-copilot.md](../he-thong/21-ai-copilot.md).

## Nguồn sự thật

Runtime nằm ở `src/copilot/**`, backend tại `supabase/functions/llm-proxy`, schema/type trong generated types và migrations `20260710*ai_copilot*` + `20260711050000_ai_write_audit.sql`.
