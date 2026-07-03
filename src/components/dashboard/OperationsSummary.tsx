import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, UserPlus, Wallet, FileSignature } from "lucide-react";
import { Link } from "react-router-dom";
import { useDashboardSummary } from "@/hooks/useDashboard";

interface MiniStat {
  label: string;
  value: number | string;
  tone?: "default" | "blue" | "green" | "amber" | "red";
}

const TONE_CLASS: Record<NonNullable<MiniStat["tone"]>, string> = {
  default: "text-foreground",
  blue: "text-blue-600",
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-600",
};

function StatBlock({
  icon: Icon,
  iconBg,
  title,
  to,
  stats,
  isLoading,
}: {
  icon: typeof UserPlus;
  iconBg: string;
  title: string;
  to: string;
  stats: MiniStat[];
  isLoading?: boolean;
}) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <div
            className={`h-9 w-9 rounded-lg grid place-items-center ${iconBg}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </div>
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <Link to={to}>
            Xem
            <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {stats.map((s, i) => (
            <div key={i} className="space-y-0.5">
              {isLoading ? (
                <Skeleton className="h-7 w-12" />
              ) : (
                <div
                  className={`text-2xl font-bold tabular-nums ${
                    TONE_CLASS[s.tone ?? "default"]
                  }`}
                >
                  {s.value}
                </div>
              )}
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function OperationsSummary({ buildingId }: { buildingId?: string | null }) {
  // Toàn bộ số liệu từ RPC gộp get_dashboard_summary (cùng queryKey với
  // useDashboardStats → 0 request thêm). Trước đây widget này kéo TOÀN BỘ
  // bảng leads + deposits (full row + embed, không limit) chỉ để đếm 6 số.
  const { data: summary, isLoading } = useDashboardSummary(buildingId);
  const leadsLoading = isLoading;
  const depositsLoading = isLoading;
  const contractsLoading = isLoading;

  // Leads
  const leadsTotal = summary?.leads_total ?? 0;
  const newLeads = summary?.leads_new_month ?? 0;
  const convertedLeads = summary?.leads_converted ?? 0;
  const conversionRate = leadsTotal
    ? `${Math.round((convertedLeads / leadsTotal) * 100)}%`
    : "0%";

  // Deposits
  const depositsTotal = summary?.deposits_total ?? 0;
  const newDeposits = summary?.deposits_new_month ?? 0;
  const movedIn = summary?.deposits_moved_in ?? 0;
  const depositConversion = depositsTotal
    ? `${Math.round((movedIn / depositsTotal) * 100)}%`
    : "0%";

  // Contracts
  const activeContracts = summary?.contracts_active ?? 0;
  const newThisMonth = summary?.contracts_new_month ?? 0;
  const expiringSoon = summary?.contracts_expiring_soon ?? 0;
  const terminatedThisMonth = summary?.contracts_terminated_month ?? 0;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <StatBlock
        icon={UserPlus}
        iconBg="bg-blue-100 text-blue-600"
        title="Tổng quan khách hẹn"
        to="/leads"
        isLoading={leadsLoading}
        stats={[
          { label: "Khách hẹn mới", value: newLeads, tone: "blue" },
          { label: "Đã chuyển đổi", value: convertedLeads, tone: "green" },
          { label: "Tỷ lệ chuyển đổi", value: conversionRate },
          { label: "Tổng đang theo dõi", value: leadsTotal },
        ]}
      />
      <StatBlock
        icon={Wallet}
        iconBg="bg-amber-100 text-amber-600"
        title="Tổng quan đặt cọc"
        to="/deposits"
        isLoading={depositsLoading}
        stats={[
          { label: "Cọc mới (tháng)", value: newDeposits, tone: "amber" },
          { label: "Khách vào thuê", value: movedIn, tone: "green" },
          { label: "Tỷ lệ chuyển đổi", value: depositConversion },
          { label: "Tổng phiếu cọc", value: depositsTotal },
        ]}
      />
      <StatBlock
        icon={FileSignature}
        iconBg="bg-emerald-100 text-emerald-600"
        title="Tổng quan hợp đồng"
        to="/contracts"
        isLoading={contractsLoading}
        stats={[
          { label: "Đang thuê", value: activeContracts, tone: "green" },
          { label: "Ký mới (tháng)", value: newThisMonth, tone: "blue" },
          { label: "Sắp hết hạn (≤30 ngày)", value: expiringSoon, tone: "amber" },
          { label: "Thanh lý (tháng)", value: terminatedThisMonth, tone: "red" },
        ]}
      />
    </div>
  );
}

export default OperationsSummary;
