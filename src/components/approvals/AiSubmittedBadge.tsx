// Badge "Do AI nộp" trên hộp chờ duyệt — hiện khi yêu cầu do AI Copilot tự nộp
// hộ (approval_requests.system_source = 'AI_COPILOT', xem
// app_private.copilot_plan_submit_voucher_v1 → submit_financial_voucher(...,
// 'AI_COPILOT', ...) trong 20260903100253_copilot_execution_plan_v1.sql).
//
// GHI CHÚ QUAN TRỌNG (G4, 2026-09-03): public.list_my_pending_approvals_v1()
// — RPC mà usePendingApprovals() gọi — CHƯA chiếu cột system_source ra ngoài
// (xem 20260723250000_finance_v2_inbox_org.sql, RETURNS TABLE không có cột
// này). Component này ĐÃ SẴN SÀNG và sẽ tự sáng lên ngay khi RPC được nới
// (thêm một cột, không đổi hành vi cũ) — nhưng việc đó là một migration, nằm
// ngoài phạm vi task G4 (ràng buộc "không sửa RPC/không migration"). Cho tới
// lúc đó, badge này ở trạng thái CODE READY nhưng KHÔNG hiện trên production
// vì `system_source` luôn về null từ RPC. Xem tooling/known-gaps.yaml.
//
// Tương tự, plan_id KHÔNG truy ngược được từ approval_requests: idempotency
// key `copilot_plan:<plan>:<step>` được truyền vào submit_financial_voucher
// nhưng RPC gốc không lưu nó (xem chú thích trong chính migration trên) —
// payload_snapshot chỉ là snapshot của phiếu thu/chi, không có plan_id. Vì
// vậy prop `planId` là optional/tương lai: hiện tại luôn undefined.

import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface AiSubmittedBadgeProps {
  systemSource: string | null | undefined;
  planId?: string | null;
}

export const AI_COPILOT_SYSTEM_SOURCE = "AI_COPILOT";

export const AiSubmittedBadge = ({ systemSource, planId }: AiSubmittedBadgeProps) => {
  if (systemSource !== AI_COPILOT_SYSTEM_SOURCE) return null;

  const tooltipText = planId
    ? `Yêu cầu này do AI Copilot nộp hộ (kế hoạch #${planId})`
    : "Yêu cầu này do AI Copilot nộp hộ — người thật vẫn là bên duyệt cuối cùng";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="border-violet-300 bg-violet-50 text-violet-700 gap-1"
        >
          <Bot className="h-3 w-3" aria-hidden="true" />
          Do AI nộp
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
};

export default AiSubmittedBadge;
