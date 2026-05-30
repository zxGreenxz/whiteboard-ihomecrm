import { useState, useMemo } from "react";
import { Home, Building2, DoorOpen } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { compareBuildingThenRoom } from "@/lib/roomSort";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useVacantRoomsReport } from "@/hooks/useReports";
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
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";

export default function VacantRoomsReport() {
  const [buildingId, setBuildingId] = useState<string | undefined>();
  const [floorId, setFloorId] = useState<string | undefined>();

  const { data: buildings } = useBuildings();
  const { data: floors } = useFloors(buildingId);
  const { data: vacantRooms, isLoading } = useVacantRoomsReport(buildingId, floorId);

  // Sắp xếp theo toà nhà rồi tên phòng (MB* → G* → L* → 1,2,3,4...)
  const sortedRooms = useMemo(
    () =>
      [...(vacantRooms ?? [])].sort((a, b) =>
        compareBuildingThenRoom(
          a.buildings?.name ?? "",
          a.name ?? "",
          b.buildings?.name ?? "",
          b.name ?? "",
        ),
      ),
    [vacantRooms],
  );

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const stats = vacantRooms && (
    <>
      <ReportCard
        title="Tổng số căn hộ trống"
        value={vacantRooms.length}
        icon={Home}
        description="Căn hộ đang sẵn sàng cho thuê"
      />
      <ReportCard
        title="Trống dưới 7 ngày"
        value={vacantRooms.filter(r => r.days_vacant != null && r.days_vacant <= 7).length}
        icon={DoorOpen}
        description="Căn hộ mới trống gần đây"
      />
      <ReportCard
        title="Trống 7-30 ngày"
        value={vacantRooms.filter(r => r.days_vacant != null && r.days_vacant > 7 && r.days_vacant <= 30).length}
        icon={Building2}
        description="Cần ưu tiên cho thuê"
      />
      <ReportCard
        title="Trống trên 30 ngày"
        value={vacantRooms.filter(r => r.days_vacant != null && r.days_vacant > 30).length}
        icon={Home}
        description="Cần xem xét lại giá"
      />
    </>
  );

  const exportData = sortedRooms.map(room => ({
    "Tòa nhà": room.buildings?.name || "N/A",
    "Căn hộ": room.name,
    "Tầng": room.floor ?? "N/A",
    "Diện tích (m²)": room.area,
    "Giá thuê": room.rent_price,
    "Trạng thái": room.status,
    "Số ngày trống": room.days_vacant ?? "Chưa xác định",
    "Ngày trống gần nhất": room.last_end_date || "N/A",
  })) || [];

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
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Báo cáo Căn hộ trống"
        description="Danh sách các căn hộ hiện đang trống và sẵn sàng cho thuê"
        icon={<Home className="h-8 w-8" />}
        actions={
          <ExportButtons
            data={exportData}
            filename="bao-cao-can-ho-trong"
          />
        }
        stats={stats}
        filters={filters}
      >
        <Card>
          <CardHeader>
            <CardTitle>Danh sách căn hộ trống</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map(i => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : vacantRooms && vacantRooms.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tòa nhà</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Tầng</TableHead>
                      <TableHead>Diện tích</TableHead>
                      <TableHead>Giá thuê</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Số ngày trống</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedRooms.map((room) => (
                      <TableRow key={room.id}>
                        <TableCell className="font-medium">
                          {room.buildings?.name || "N/A"}
                        </TableCell>
                        <TableCell>{room.name}</TableCell>
                        <TableCell>{room.floor ?? "-"}</TableCell>
                        <TableCell>{room.area ? `${room.area} m²` : "-"}</TableCell>
                        <TableCell>{formatCurrency(room.rent_price)}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {room.status}
                        </TableCell>
                        <TableCell>
                          {room.days_vacant != null ? (
                            <span className={
                              room.days_vacant <= 7
                                ? "text-green-600"
                                : room.days_vacant <= 30
                                ? "text-yellow-600"
                                : "text-red-600"
                            }>
                              {room.days_vacant} ngày
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Chưa xác định</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Không có căn hộ trống nào
              </div>
            )}
          </CardContent>
        </Card>
      </ReportLayout>
    </MainLayout>
  );
}
