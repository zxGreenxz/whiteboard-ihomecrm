import { Home, Building2, DoorOpen } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useVacantRoomsReport } from "@/hooks/useReports";
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

export default function VacantRoomsReport() {
  const { data: vacantRooms, isLoading } = useVacantRoomsReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const stats = vacantRooms && (
    <>
      <ReportCard
        title="Tổng số phòng trống"
        value={vacantRooms.length}
        icon={Home}
        description="Phòng đang sẵn sàng cho thuê"
      />
      <ReportCard
        title="Trống dưới 7 ngày"
        value={vacantRooms.filter(r => r.days_vacant && r.days_vacant <= 7).length}
        icon={DoorOpen}
        description="Phòng mới trống gần đây"
      />
      <ReportCard
        title="Trống 7-30 ngày"
        value={vacantRooms.filter(r => r.days_vacant && r.days_vacant > 7 && r.days_vacant <= 30).length}
        icon={Building2}
        description="Cần ưu tiên cho thuê"
      />
      <ReportCard
        title="Trống trên 30 ngày"
        value={vacantRooms.filter(r => r.days_vacant && r.days_vacant > 30).length}
        icon={Home}
        description="Cần xem xét lại giá"
      />
    </>
  );

  const exportData = vacantRooms?.map(room => ({
    "Tòa nhà": room.buildings?.name || "N/A",
    "Phòng": room.room_number,
    "Diện tích (m²)": room.area,
    "Giá thuê": room.rental_price,
    "Loại phòng": room.room_type,
    "Tình trạng": room.condition,
    "Số ngày trống": room.days_vacant || "Chưa xác định",
    "Ngày trống gần nhất": room.last_end_date || "N/A",
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Phòng trống"
      description="Danh sách các phòng hiện đang trống và sẵn sàng cho thuê"
      icon={<Home className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-phong-trong"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách phòng trống</CardTitle>
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
                    <TableHead>Phòng</TableHead>
                    <TableHead>Diện tích</TableHead>
                    <TableHead>Giá thuê</TableHead>
                    <TableHead>Loại</TableHead>
                    <TableHead>Tình trạng</TableHead>
                    <TableHead>Số ngày trống</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vacantRooms.map((room) => (
                    <TableRow key={room.id}>
                      <TableCell className="font-medium">
                        {room.buildings?.name || "N/A"}
                      </TableCell>
                      <TableCell>{room.room_number}</TableCell>
                      <TableCell>{room.area} m²</TableCell>
                      <TableCell>{formatCurrency(room.rental_price)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{room.room_type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            room.condition === "GOOD"
                              ? "default"
                              : room.condition === "FAIR"
                              ? "secondary"
                              : "destructive"
                          }
                        >
                          {room.condition === "GOOD"
                            ? "Tốt"
                            : room.condition === "FAIR"
                            ? "Trung bình"
                            : "Cần sửa"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {room.days_vacant ? (
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
                      <TableCell className="text-muted-foreground text-sm">
                        {room.notes || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có phòng trống nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
