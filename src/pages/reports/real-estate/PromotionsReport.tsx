import { useState } from "react";
import { Tag, TrendingDown, Gift, DollarSign } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { usePromotionsReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DateRange } from "react-day-picker";

export default function PromotionsReport() {
  const [buildingId, setBuildingId] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<DateRange | undefined>();

  const { data: buildings } = useBuildings();
  const { data: promotions, isLoading } = usePromotionsReport(
    dateRange?.from, dateRange?.to, buildingId
  );

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

  const totalSavings = promotions?.reduce((sum, p) => sum + (p.savings || 0), 0) || 0;
  const activePromotions = promotions?.filter(p => p.status === "ACTIVE").length || 0;

  const stats = promotions && (
    <>
      <ReportCard title="Tổng HĐ có giảm giá" value={promotions.length} icon={Tag} description="Hợp đồng có khuyến mại" />
      <ReportCard title="Đang hoạt động" value={activePromotions} icon={Gift} description="Khuyến mại hiện hành" />
      <ReportCard title="Tổng giảm giá" value={formatCurrency(totalSavings)} icon={TrendingDown} description="Tổng giá trị giảm giá" />
      <ReportCard title="TB mỗi hợp đồng" value={formatCurrency(promotions.length > 0 ? totalSavings / promotions.length : 0)} icon={DollarSign} description="Giảm giá trung bình" />
    </>
  );

  const exportData = promotions?.map(promo => ({
    "Mã HĐ": promo.contract_number || promo.id.slice(0, 8),
    "Khách hàng": promo.tenants?.full_name || "N/A",
    "Căn hộ": `${promo.rooms?.buildings?.name} - ${promo.rooms?.room_number}`,
    "Giá gốc": promo.monthly_rent,
    "Giảm giá": promo.savings,
    "Giá sau giảm": promo.effective_rent,
    "Trạng thái": promo.status === "ACTIVE" ? "Đang áp dụng" : "Đã kết thúc",
  })) || [];

  const filters = (
    <div className="flex flex-wrap gap-4">
      <div className="w-[200px]">
        <Select value={buildingId || "all"} onValueChange={(v) => setBuildingId(v === "all" ? undefined : v)}>
          <SelectTrigger><SelectValue placeholder="Chọn toà nhà" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả toà nhà</SelectItem>
            {buildings?.map((b) => (<SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>
      <DateRangePicker value={dateRange} onChange={setDateRange} />
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Khuyến mại"
        description="Danh sách hợp đồng có giảm giá, khuyến mại"
        icon={<Tag className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="bao-cao-khuyen-mai" />}
        filters={filters}
        stats={stats}
      >
        <Card>
          <CardHeader><CardTitle>Danh sách khuyến mại</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => (<Skeleton key={i} className="h-12 w-full" />))}</div>
            ) : promotions && promotions.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Giá gốc</TableHead>
                      <TableHead>Giảm giá</TableHead>
                      <TableHead>Giá sau giảm</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {promotions.map((promo) => (
                      <TableRow key={promo.id}>
                        <TableCell className="font-medium">{promo.contract_number || promo.id.slice(0, 8)}</TableCell>
                        <TableCell>{promo.tenants?.full_name || "N/A"}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium">{promo.rooms?.buildings?.name}</div>
                            <div className="text-muted-foreground">Căn hộ {promo.rooms?.room_number}</div>
                          </div>
                        </TableCell>
                        <TableCell>{formatCurrency(promo.monthly_rent)}</TableCell>
                        <TableCell className="text-green-600 font-semibold">-{formatCurrency(promo.savings)}</TableCell>
                        <TableCell className="font-semibold">{formatCurrency(promo.effective_rent)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">Không có khuyến mại nào</div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
