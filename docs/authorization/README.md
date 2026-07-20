# Authorization & financial approval

> **Current through:** 2026-07-20  
> **Status:** production, 15/15 canonical writer flags ON; approval inbox live.

## Current truth

- Tổ chức, membership, role/binding/scope và override là ranh giới phân quyền mới; backend `authorize_v2`/RLS/RPC là nơi quyết định cuối.
- Toàn bộ 15 route writer canonical đã bật. Một số UI còn giữ fallback/legacy có chủ đích cho tới khi đủ parity và qua chu kỳ drain.
- Hộp thư [Chờ duyệt](/approvals) dùng `list_my_pending_approvals_v1`, `decide_financial_request_v2` và `withdraw_financial_request_v1`; maker không thể tự duyệt request engine.
- Phiếu thu/chi thường tự duyệt, trừ hạng mục `force_approval` hoặc phiếu chi đạt ngưỡng do owner cấu hình. Không đặt ngưỡng nghĩa là phiếu chi thường tự duyệt không giới hạn.
- P0 và P1 đã đóng ngày 20/07, gồm off-boarding fail-closed, storage cross-org, NULL-org cleanup, utility threshold, emergency break-glass, DR snapshot và R2 Worker hardened.

## Đọc theo thứ tự

1. [STATUS-2026-07-19-GOLIVE-FULL.md](STATUS-2026-07-19-GOLIVE-FULL.md) — biên bản go-live 15/15.
2. [GHI-CHU-SO-VOI-PLAN-2026-07-19.md](GHI-CHU-SO-VOI-PLAN-2026-07-19.md) — cập nhật P0/P1 tới 20/07 và backlog T7–T9.
3. [../AUTHORIZATION-PLAN.md](../AUTHORIZATION-PLAN.md) — thiết kế gốc; dùng để hiểu mục tiêu, không dùng làm status.
4. Các `TRANCHE-*-SURVEY` và finding có ngày — audit evidence được SQL/triage tham chiếu, không xóa khi chưa kiểm tra caller.

## Việc còn lại

- T7 drain legacy DML chỉ thực hiện sau ít nhất một chu kỳ vận hành canonical và có rollback được owner duyệt.
- T9 retention/audit cuối; tiếp tục đóng parity contract-create, opening-adjust và các atomic flow còn lại.
