import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  calculateLeadScore,
  getLeadScoreColor,
  getLeadScoreLabel,
  type LeadScoreBreakdown,
} from "@/lib/leadHelpers";
import { TrendingUp } from "lucide-react";

interface LeadScoreBadgeProps {
  lead: {
    budget_min?: number | null;
    budget_max?: number | null;
    appointment_date?: string | null;
    source?: string | null;
    status?: string | null;
    email?: string | null;
    move_in_date?: string | null;
    lead_score?: number | null;
  };
  showTooltip?: boolean;
}

export function LeadScoreBadge({ lead, showTooltip = true }: LeadScoreBadgeProps) {
  // Use pre-calculated score if available, otherwise calculate
  const breakdown = calculateLeadScore(lead);
  const score = lead.lead_score ?? breakdown.total;
  const colorClass = getLeadScoreColor(score);
  const label = getLeadScoreLabel(score);

  const badge = (
    <Badge className={`${colorClass} font-medium gap-1`}>
      <TrendingUp className="h-3 w-3" />
      {score}
    </Badge>
  );

  if (!showTooltip) {
    return badge;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="w-64">
          <div className="space-y-2">
            <p className="font-semibold">{label}</p>
            <div className="text-xs space-y-1">
              <div className="flex justify-between">
                <span>Ngân sách:</span>
                <span>{breakdown.budgetScore}/30</span>
              </div>
              <div className="flex justify-between">
                <span>Lịch hẹn:</span>
                <span>{breakdown.appointmentScore}/25</span>
              </div>
              <div className="flex justify-between">
                <span>Nguồn khách:</span>
                <span>{breakdown.sourceScore}/20</span>
              </div>
              <div className="flex justify-between">
                <span>Tiến trình:</span>
                <span>{breakdown.statusScore}/15</span>
              </div>
              <div className="flex justify-between">
                <span>Email:</span>
                <span>{breakdown.emailScore}/5</span>
              </div>
              <div className="flex justify-between">
                <span>Ngày chuyển vào:</span>
                <span>{breakdown.moveInScore}/5</span>
              </div>
              <div className="border-t pt-1 mt-1 flex justify-between font-semibold">
                <span>Tổng điểm:</span>
                <span>{score}/100</span>
              </div>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
