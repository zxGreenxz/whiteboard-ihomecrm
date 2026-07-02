import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, LineChart } from "lucide-react";
import { format } from "date-fns";
import MainLayout from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import { useBuildings } from "@/hooks/useBuildings";
import { monthToEndDate, monthToStartDate } from "@/lib/monthPeriod";
import type { AnalysisFilters } from "@/components/finance-analysis/types";
import { monthsRange, shiftMonth } from "@/components/finance-analysis/utils";
import { OverviewTab } from "@/components/finance-analysis/OverviewTab";
import { RevenueTab } from "@/components/finance-analysis/RevenueTab";
import { ExpenseTab } from "@/components/finance-analysis/ExpenseTab";
import { ProfitTab } from "@/components/finance-analysis/ProfitTab";
import { OperationsTab } from "@/components/finance-analysis/OperationsTab";

/**
 * Trang Phân tích tài chính — 5 tab (Tổng quan / Doanh thu / Chi phí /
 * Lợi nhuận / Vận hành). Chỉ khoản KQKD. Toggle cơ sở ghi nhận:
 *   • DỒN TÍCH (mặc định) — theo kỳ áp dụng / billing_month, ĐỒNG BỘ Phân bổ
 *     lợi nhuận (fa_*_accrual).
 *   • TIỀN MẶT — theo ngày phiếu (fa_monthly_pnl / fa_type_breakdown).
 * Chỉ P&L & cơ cấu hạng mục đổi theo toggle; KPI vận hành không phụ thuộc.
 */
export default function FinancialAnalysisReport() {
  // Kỳ phân tích "MM-yyyy" (convention month picker của ProfitDistributionReport)
  const [monthStr, setMonthStr] = useState<string>(format(new Date(), "MM-yyyy"));
  const [buildingIds, setBuildingIds] = useState<string[]>([]);
  // Mặc định DỒN TÍCH để khớp Phân bổ lợi nhuận (cũng mặc định accrual).
  const [accrual, setAccrual] = useState<boolean>(true);

  // 36 tháng gần nhất — đủ ngữ cảnh YoY khi xem lùi 2 năm.
  const monthOptions = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 36; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push(format(dt, "MM-yyyy"));
    }
    return out;
  }, []);

  // Cần cả toà ảo "Chung" (chi phí chung) → tự fetch includeVirtual và truyền vào.
  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const buildingOptions = useMemo(
    () =>
      (buildings as any[]).map((b) => ({
        id: b.id,
        name: b.name,
        area_ids: b.area_ids ?? [],
      })),
    [buildings],
  );
  const filters: AnalysisFilters = useMemo(() => {
    const [mm, yyyy] = monthStr.split("-");
    const ym = `${yyyy}-${mm}`;
    const yoyYm = shiftMonth(ym, -12);
    return {
      ym,
      periodStart: monthToStartDate(ym),
      periodEnd: monthToEndDate(ym),
      prevYm: shiftMonth(ym, -1),
      yoyYm,
      t13StartYm: yoyYm,
      t13Start: monthToStartDate(yoyYm),
      t13End: monthToEndDate(ym),
      months12: monthsRange(ym, 12),
      buildingIds,
      accrual,
    };
  }, [monthStr, buildingIds, accrual]);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Phân tích tài chính</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-violet-100 flex items-center justify-center">
            <LineChart className="h-6 w-6 text-violet-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Phân tích tài chính</h1>
            <p className="text-sm text-muted-foreground">
              Doanh thu · Chi phí · Lợi nhuận · KPI vận hành (khoản KQKD · ghi nhận theo{" "}
              {accrual ? "kỳ áp dụng — dồn tích" : "ngày phiếu — tiền mặt"})
            </p>
          </div>
        </div>

        {/* Bộ lọc chung — sticky dưới header (h-16) */}
        <div className="sticky top-16 z-30 -mx-4 lg:-mx-6 bg-background/95 backdrop-blur border-b px-4 lg:px-6 py-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Kỳ phân tích</span>
            <SearchableSelect
              value={monthStr}
              onValueChange={setMonthStr}
              className="w-[130px]"
              options={monthOptions.map((m) => ({ value: m, label: m }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Toà nhà</span>
            <BuildingFilterSelect
              value={buildingIds}
              onChange={setBuildingIds}
              buildings={buildingOptions}
              className="w-[260px]"
              placeholder="Tất cả toà nhà"
            />
          </div>
          <div className="flex items-center gap-2 h-9 ml-auto">
            <Switch id="fa-accrual" checked={accrual} onCheckedChange={setAccrual} />
            <Label htmlFor="fa-accrual" className="text-sm text-muted-foreground whitespace-nowrap">
              Dồn tích (theo kỳ áp dụng)
            </Label>
          </div>
        </div>

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="flex w-full h-auto justify-start overflow-x-auto">
            <TabsTrigger value="overview">Tổng quan</TabsTrigger>
            <TabsTrigger value="revenue">Doanh thu</TabsTrigger>
            <TabsTrigger value="expense">Chi phí</TabsTrigger>
            <TabsTrigger value="profit">Lợi nhuận</TabsTrigger>
            <TabsTrigger value="operations">Vận hành</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab filters={filters} />
          </TabsContent>
          <TabsContent value="revenue">
            <RevenueTab filters={filters} />
          </TabsContent>
          <TabsContent value="expense">
            <ExpenseTab filters={filters} />
          </TabsContent>
          <TabsContent value="profit">
            <ProfitTab filters={filters} />
          </TabsContent>
          <TabsContent value="operations">
            <OperationsTab filters={filters} />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
