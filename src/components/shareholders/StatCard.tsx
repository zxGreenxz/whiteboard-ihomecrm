import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string;
  icon?: LucideIcon;
  sub?: string;
  tone?: "default" | "green" | "red" | "blue" | "amber";
}

const toneMap: Record<string, { text: string; bg: string }> = {
  default: { text: "text-zinc-700", bg: "bg-zinc-100" },
  green: { text: "text-emerald-600", bg: "bg-emerald-50" },
  red: { text: "text-red-600", bg: "bg-red-50" },
  blue: { text: "text-blue-600", bg: "bg-blue-50" },
  amber: { text: "text-amber-600", bg: "bg-amber-50" },
};

export function StatCard({ label, value, icon: Icon, sub, tone = "default" }: StatCardProps) {
  const t = toneMap[tone] ?? toneMap.default;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            <p className={cn("text-xl font-bold tabular-nums mt-1", t.text)}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
          </div>
          {Icon && (
            <div className={cn("rounded-lg p-2 shrink-0", t.bg)}>
              <Icon className={cn("h-5 w-5", t.text)} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
