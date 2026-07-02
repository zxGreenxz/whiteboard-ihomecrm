import MainLayout from "@/components/layout/MainLayout";
import { Home, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useExpiringContractsReport } from "@/hooks/useReports";
import { useBuildings } from "@/hooks/useBuildings";
import { useFloors } from "@/hooks/useFloors";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { usePersistedState } from "@/hooks/usePersistedState";

export default function ExpiringContractsReport() {
  const [daysFilter, setDaysFilter] = usePersistedState("flt:rpt-expiring:days", 30);
  const [buildingId, setBuildingId] = usePersistedState<string | undefined>("flt:rpt-expiring:buildingId", undefined);
  const [floorId, setFloorId] = usePersistedState<string | undefined>("flt:rpt-expiring:floorId", undefined);

  const { data: buildings } = useBuildings();
  const { data: floors } = useFloors(buildingId);
  const { data: contracts, isLoading } = useExpiringContractsReport(
    daysFilter, buildingId, floorId
  );

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const stats = contracts && (
    <>
      <ReportCard
        title="Tổng căn hộ sắp trống"
        value={contracts.length}
        icon={Home}
        description={`Trong ${daysFilter} ngày tới`}
      />
      <ReportCard
        title="Hết hạn trong 7 ngày"
        value={contracts.filter(c => c.days_left <= 7).length}
        icon={AlertTriangle}
        description="Cần liên hệ khẩn cấp"
      />
      <ReportCard
        title="Hết hạn 8-15 ngày"
        value={contracts.filter(c => c.days_left > 7 && c.days_left <= 15).length}
        icon={Clock}
        description="Cần chuẩn bị gia hạn"
      />
      <ReportCard
        title="Hết hạn 16-30 ngày"
        value={contracts.filter(c => c.days_left > 15 && c.days_left <= 30).length}
        icon={CheckCircle2}
        description="Thời gian đàm phán"
      />
    </>
  );

  const exportData = contracts?.map(contract => ({
    "Mã HĐ": contract.contract_number,
    "Khách hàng": contract.tenants?.full_name || "N/A",
    "Điện thoại": contract.tenants?.phone || "N/A",
    "Tòa nhà": contract.rooms?.buildings?.name || "N/A",
    "Căn hộ": contract.rooms?.name || "N/A",
    "Tầng": contract.rooms?.floor ?? "N/A",
    "Ngày hết hạn": format(new Date(contract.end_date), "dd/MM/yyyy", { locale: vi }),
    "Còn lại (ngày)": contract.days_left,
    "Giá thuê": contract.rent_price,
    "Trạng thái": contract.status,
  })) || [];

  const getUrgencyBadge = (daysLeft: number) => {
    if (daysLeft <= 7) {
      return <Badge variant="destructive">Khẩn cấp</Badge>;
    } else if (daysLeft <= 15) {
      return <Badge variant="default">Quan trọng</Badge>;
    } else {
      return <Badge variant="secondary">Bình thường</Badge>;
    }
  };

  const filters = (
    <div className="flex flex-wrap gap-4">
      <div className="w-[200px]">
        <SearchableSelect
          value={buildingId || "all"}
          onValueChange={(v) => {
            setBuildingId(v === "all" ? undefined : v);
            setFloorId(undefined);
          }}
          placeholder="Chọn toà nhà"
          options={[
            { value: "all", label: "Tất cả toà nhà" },
            ...(buildings?.map((b) => ({ value: b.id, label: b.name })) ?? []),
          ]}
        />
      </div>
      <div className="w-[200px]">
        <SearchableSelect
          value={floorId || "all"}
          onValueChange={(v) => setFloorId(v === "all" ? undefined : v)}
          disabled={!buildingId}
          placeholder="Chọn tầng"
          options={[
            { value: "all", label: "Tất cả tầng" },
            ...(floors?.map((f) => ({
              value: String(f.floor_number),
              label: f.name || `Tầng ${f.floor_number}`,
            })) ?? []),
          ]}
        />
      </div>
      <div>
        <Tabs value={daysFilter.toString()} onValueChange={(v) => setDaysFilter(Number(v))}>
          <TabsList>
            <TabsTrigger value="7">7 ngày</TabsTrigger>
            <TabsTrigger value="15">15 ngày</TabsTrigger>
            <TabsTrigger value="30">30 ngày</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Căn hộ sắp trống"
        description="Danh sách căn hộ có hợp đồng sắp hết hạn, cần chuẩn bị cho thuê lại"
        icon={<Home className="h-8 w-8" />}
        actions={
          <ExportButtons
            data={exportData}
            filename="bao-cao-can-ho-sap-trong"
          />
        }
        stats={stats}
        filters={filters}
      >
        <Card>
          <CardHeader>
            <CardTitle>Danh sách căn hộ sắp trống</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map(i => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : contracts && contracts.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mức độ</TableHead>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Liên hệ</TableHead>
                      <TableHead>Tòa nhà</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Ngày hết hạn</TableHead>
                      <TableHead>Còn lại</TableHead>
                      <TableHead>Giá thuê</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contracts.map((contract) => (
                      <TableRow key={contract.id}>
                        <TableCell>
                          {getUrgencyBadge(contract.days_left)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {contract.contract_number}
                        </TableCell>
                        <TableCell>{contract.tenants?.full_name || "N/A"}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div>{contract.tenants?.phone || "-"}</div>
                            <div className="text-muted-foreground">
                              {contract.tenants?.email || "-"}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {contract.rooms?.buildings?.name || "N/A"}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div>Căn hộ {contract.rooms?.name}</div>
                            {contract.rooms?.floor != null && (
                              <div className="text-muted-foreground">
                                Tầng {contract.rooms.floor}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {format(new Date(contract.end_date), "dd/MM/yyyy", { locale: vi })}
                        </TableCell>
                        <TableCell>
                          <span className={
                            contract.days_left <= 7
                              ? "text-red-600 font-semibold"
                              : contract.days_left <= 15
                              ? "text-yellow-600 font-medium"
                              : "text-green-600"
                          }>
                            {contract.days_left} ngày
                          </span>
                        </TableCell>
                        <TableCell>{formatCurrency(contract.rent_price)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Không có căn hộ nào sắp trống trong {daysFilter} ngày tới
              </div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
