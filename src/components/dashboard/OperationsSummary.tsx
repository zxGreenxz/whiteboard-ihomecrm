import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, UserPlus, Wallet, FileSignature } from "lucide-react";
import { Link } from "react-router-dom";
import { useLeads } from "@/hooks/useLeads";
import { useDeposits } from "@/hooks/useDeposits";
import { useContracts } from "@/hooks/useContracts";
import { isContractInEffect } from "@/types/contract";
import { differenceInDays } from "date-fns";

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
  const { data: leads = [], isLoading: leadsLoading } = useLeads();
  const { data: deposits = [], isLoading: depositsLoading } = useDeposits();
  const contractsResult = useContracts();
  const contracts = (contractsResult.data ?? []).filter((c: any) =>
    !buildingId || c.room?.building_id === buildingId,
  );
  const contractsLoading = contractsResult.isLoading;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Leads
  const newLeads = leads.filter((l: any) => {
    const created = l.created_at ? new Date(l.created_at) : null;
    return created && created >= startOfMonth;
  }).length;
  const convertedLeads = leads.filter((l: any) => l.status === "CONVERTED").length;
  const conversionRate = leads.length
    ? `${Math.round((convertedLeads / leads.length) * 100)}%`
    : "0%";

  // Deposits
  const newDeposits = deposits.filter((d: any) => {
    const created = d.created_at ? new Date(d.created_at) : null;
    return created && created >= startOfMonth;
  }).length;
  const movedIn = deposits.filter((d: any) => d.status === "CONVERTED").length;
  const depositConversion = deposits.length
    ? `${Math.round((movedIn / deposits.length) * 100)}%`
    : "0%";

  // Contracts
  const activeContracts = contracts.filter((c: any) => isContractInEffect(c.status)).length;
  const newThisMonth = contracts.filter((c: any) => {
    const start = c.start_date ? new Date(c.start_date) : null;
    return start && start >= startOfMonth;
  }).length;
  const expiringSoon = contracts.filter((c: any) => {
    if (!isContractInEffect(c.status) || !c.end_date) return false;
    const days = differenceInDays(new Date(c.end_date), now);
    return days >= 0 && days <= 30;
  }).length;
  const terminatedThisMonth = contracts.filter((c: any) => {
    if (c.status !== "TERMINATED" && c.status !== "ENDED") return false;
    const ended = c.end_date ? new Date(c.end_date) : null;
    return ended && ended >= startOfMonth;
  }).length;

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
          { label: "Tổng đang theo dõi", value: leads.length },
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
          { label: "Tổng phiếu cọc", value: deposits.length },
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
