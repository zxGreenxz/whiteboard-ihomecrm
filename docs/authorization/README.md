# Authorization & financial approval

> **Current through:** 2026-07-20  
> **Status:** production; 15/15 canonical writer flags ON; approval inbox live.

## Current truth

- Organization, membership, role binding, scope và ALLOW/DENY override là mô hình quyền hiện hành.
- Backend `authorize_v2`, RPC writer và RLS quyết định cuối; UI không được tự chọn canonical/legacy route.
- Hộp thư `/approvals` dùng request/step/decision engine. Maker không tự duyệt request engine của mình.
- Phiếu thu/chi thường sinh `APPROVED`; hạng mục `force_approval`, payout và phiếu chi đạt ngưỡng cấu hình đi qua approval.
- 15/15 writer route đã bật ngày 19/07. T7 drain direct DML/legacy caller vẫn là bước có điều kiện, không đồng nghĩa writer chưa live.

## Mục lục

| Tài liệu | Lifecycle | Dùng khi |
|---|---|---|
| [STATUS-2026-07-19-GOLIVE-FULL.md](STATUS-2026-07-19-GOLIVE-FULL.md) | go-live evidence | Xem quyết định D1–D4, 15/15 flags và test cutover |
| [GHI-CHU-SO-VOI-PLAN-2026-07-19.md](GHI-CHU-SO-VOI-PLAN-2026-07-19.md) | audit evidence | Đối chiếu plan với code/DB sau triển khai |
| [../AUTHORIZATION-PLAN.md](../AUTHORIZATION-PLAN.md) | design baseline | Hiểu mục tiêu và mô hình gốc; không dùng làm status |
| [FINDING-ENGINE-APPROVAL-PAYOUT-BLOCKER-2026-07-18.md](FINDING-ENGINE-APPROVAL-PAYOUT-BLOCKER-2026-07-18.md) | historical evidence | Giải thích blocker payout đã đóng và nền `t5_17`–`t5_19` |
| [TRANCHE-INCOME-EXPENSE-FINDINGS-2026-07-18.md](TRANCHE-INCOME-EXPENSE-FINDINGS-2026-07-18.md) | historical build evidence | Nền thiết kế cho `t5_08` |
| [TRANCHE-INVOICE-N2-SURVEY-2026-07-18.md](TRANCHE-INVOICE-N2-SURVEY-2026-07-18.md) | historical build evidence | Nền thiết kế cho `t5_14`/`t5_15` |
| [TRANCHE-PROFIT-SURVEY-2026-07-18.md](TRANCHE-PROFIT-SURVEY-2026-07-18.md) | historical build evidence | Nền thiết kế cho profit writers |
| [TRANCHE-SALARY-SURVEY-2026-07-18.md](TRANCHE-SALARY-SURVEY-2026-07-18.md) | historical build evidence | Nền thiết kế cho salary writers |

Các file historical cố ý giữ nguyên kết luận OFF/BLOCKED của ngày khảo sát bên dưới banner lifecycle. Không trích các câu đó làm trạng thái production.

## Việc còn lại

- T7 drain legacy chỉ sau đủ chu kỳ vận hành, telemetry và rollback được owner duyệt.
- Hoàn tất parity cho các UI composite còn fallback có chủ đích.
- Đồng bộ `shareholder_profit.pay_manager` vào permission catalog/UI và gate nút chi lương điều hành; backend writer đã yêu cầu operation này nhưng màn Phân quyền hiện chưa expose.
- T9 retention/audit cuối và review emergency/break-glass định kỳ.

## Khi thay đổi authorization

1. Cập nhật writer/RLS/permission catalog và tài liệu domain liên quan.
2. Test ALLOW, DENY, cross-org, offboarding và idempotency.
3. Flow tiền phải test maker/checker/post/reverse và chạy đối chiếu tiền.
4. Ghi evidence có ngày; README này là status duy nhất, không tạo thêm file “current status” song song.
