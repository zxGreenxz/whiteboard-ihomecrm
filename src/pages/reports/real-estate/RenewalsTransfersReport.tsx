import MainLayout from "@/components/layout/MainLayout";
import { RefreshCw, ArrowRightLeft, FileCheck } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useRenewalsTransfersReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { usePersistedState } from "@/hooks/usePersistedState";

export default function RenewalsTransfersReport() {
  const [buildingId, setBuildingId] = usePersistedState<string | undefined>("flt:rpt-renewals:buildingId", undefined);
  const [startDate, setStartDate] = usePersistedState("flt:rpt-renewals:startDate", "");
  const [endDate, setEndDate] = usePersistedState("flt:rpt-renewals:endDate", "");

  const { data: buildings } = useBuildings();
  const { data: contracts, isLoading } = useRenewalsTransfersReport(
    startDate || undefined, endDate || undefined, buildingId
  );

  const renewals = contracts?.filter((c) => c.type === "RENEWAL") || [];
  const transfers = contracts?.filter((c) => c.type === "TRANSFER") || [];

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

  const stats = contracts && (
    <>
      <ReportCard
        title="Tổng gia hạn"
        value={renewals.length}
        icon={RefreshCw}
        description="Hợp đồng đã gia hạn"
      />
      <ReportCard
        title="Tổng chuyển nhượng"
        value={transfers.length}
        icon={ArrowRightLeft}
        description="Hợp đồng đã chuyển nhượng"
      />
      <ReportCard
        title="Tổng trong kỳ"
        value={contracts.length}
        icon={FileCheck}
        description="Tổng giao dịch trong khoảng thời gian"
      />
    </>
  );

  const exportData = contracts?.map((c) => ({
    "Mã HĐ": c.contract_number,
    "Khách hàng": c.customer,
    "Toà nhà": c.building,
    "Căn hộ": c.room,
    "Loại": c.type === "RENEWAL" ? "Gia hạn" : "Chuyển nhượng",
    "Ngày": format(new Date(c.date), "dd/MM/yyyy", { locale: vi }),
    "Giá thuê mới": c.rent_price,
  })) || [];

  const filters = (
    <div className="flex flex-wrap gap-4 items-end">
      <div className="w-[200px]">
        <SearchableSelect
          value={buildingId || "all"}
          onValueChange={(v) => setBuildingId(v === "all" ? undefined : v)}
          placeholder="Chọn toà nhà"
          options={[
            { value: "all", label: "Tất cả toà nhà" },
            ...(buildings?.map((b) => ({ value: b.id, label: b.name })) ?? []),
          ]}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="startDate">Từ ngày</Label>
        <DateInput
          value={startDate}
          onChange={setStartDate}
          className="w-[180px]"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="endDate">Đến ngày</Label>
        <DateInput
          value={endDate}
          onChange={setEndDate}
          className="w-[180px]"
        />
      </div>
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Gia hạn & Chuyển nhượng"
        description="Danh sách hợp đồng đã gia hạn hoặc chuyển nhượng"
        icon={<RefreshCw className="h-8 w-8" />}
        actions={
          <ExportButtons data={exportData} filename="bao-cao-gia-han-chuyen-nhuong" />
        }
        stats={stats}
        filters={filters}
      >
        <Card>
          <CardHeader>
            <CardTitle>Danh sách hợp đồng</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : contracts && contracts.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Toà nhà</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Ngày</TableHead>
                      <TableHead>Giá thuê mới</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contracts.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          {c.contract_number}
                        </TableCell>
                        <TableCell>{c.customer}</TableCell>
                        <TableCell>{c.building}</TableCell>
                        <TableCell>{c.room}</TableCell>
                        <TableCell>
                          {c.type === "RENEWAL" ? (
                            <Badge variant="default">Gia hạn</Badge>
                          ) : (
                            <Badge variant="secondary">Chuyển nhượng</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {format(new Date(c.date), "dd/MM/yyyy", { locale: vi })}
                        </TableCell>
                        <TableCell>{formatCurrency(c.rent_price)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Không có dữ liệu gia hạn hoặc chuyển nhượng
              </div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
