import { AlertTriangle, CheckCircle2, Lightbulb, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Insight } from "./types";

const STYLE: Record<Insight["severity"], { icon: typeof XCircle; box: string; iconCls: string }> = {
  red: { icon: XCircle, box: "border-red-200 bg-red-50", iconCls: "text-red-600" },
  amber: { icon: AlertTriangle, box: "border-amber-200 bg-amber-50", iconCls: "text-amber-600" },
  green: { icon: CheckCircle2, box: "border-emerald-200 bg-emerald-50", iconCls: "text-emerald-600" },
};

interface InsightsPanelProps {
  insights: Insight[];
  loading?: boolean;
}

/** Panel "Nhận định & khuyến nghị" — CFO commentary tự động từ buildInsights. */
export function InsightsPanel({ insights, loading }: InsightsPanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-3">
        <Lightbulb className="h-4 w-4 text-amber-500" />
        <CardTitle className="text-base">Nhận định & khuyến nghị</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : (
          insights.map((ins, i) => {
            const s = STYLE[ins.severity];
            const Icon = s.icon;
            return (
              <div key={i} className={cn("flex items-start gap-2 rounded-md border px-3 py-2", s.box)}>
                <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", s.iconCls)} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{ins.title}</div>
                  {ins.detail && (
                    <div className="text-xs text-muted-foreground mt-0.5">{ins.detail}</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
