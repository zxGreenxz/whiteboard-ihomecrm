import { Home, Wrench, CheckCircle2, Clock } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useTasksByRoomReport } from "@/hooks/useReports";
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
import { Progress } from "@/components/ui/progress";

export default function TasksByRoomReport() {
  const { data: roomData, isLoading } = useTasksByRoomReport();

  const totalRooms = roomData?.length || 0;
  const totalTasks = roomData?.reduce((sum, r) => sum + r.total, 0) || 0;
  const roomsWithIssues = roomData?.filter(r => r.pending > 0 || r.inProgress > 0).length || 0;
  const avgTasksPerRoom = totalRooms > 0 ? (totalTasks / totalRooms).toFixed(1) : 0;

  const stats = (
    <>
      <ReportCard
        title="Phòng có công việc"
        value={totalRooms}
        icon={Home}
        description="Đã có sự cố/bảo trì"
      />
      <ReportCard
        title="Tổng công việc"
        value={totalTasks}
        icon={Wrench}
        description="Liên quan phòng"
      />
      <ReportCard
        title="Phòng có vấn đề"
        value={roomsWithIssues}
        icon={Clock}
        description="Chưa xử lý xong"
      />
      <ReportCard
        title="TB/phòng"
        value={avgTasksPerRoom}
        icon={CheckCircle2}
        description="Công việc trung bình"
      />
    </>
  );

  const exportData = roomData?.map(room => ({
    "Phòng": room.roomDisplay,
    "Tổng CV": room.total,
    "Hoàn thành": room.completed,
    "Đang làm": room.inProgress,
    "Chưa bắt đầu": room.pending,
    "Tỷ lệ hoàn thành (%)": room.completionRate,
  })) || [];

  return (
    <ReportLayout
      title="Công việc theo Phòng"
      description="Lịch sử bảo trì và sửa chữa theo từng phòng"
      icon={<Home className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-cong-viec-theo-phong"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Chi tiết theo phòng</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : roomData && roomData.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Phòng</TableHead>
                    <TableHead className="text-center">Tổng</TableHead>
                    <TableHead className="text-center">Hoàn thành</TableHead>
                    <TableHead className="text-center">Đang làm</TableHead>
                    <TableHead className="text-center">Chưa bắt đầu</TableHead>
                    <TableHead>Tỷ lệ hoàn thành</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roomData.map((room, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{room.roomDisplay}</TableCell>
                      <TableCell className="text-center">{room.total}</TableCell>
                      <TableCell className="text-center text-green-600 font-semibold">
                        {room.completed}
                      </TableCell>
                      <TableCell className="text-center text-blue-600">
                        {room.inProgress}
                      </TableCell>
                      <TableCell className="text-center text-yellow-600">
                        {room.pending}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={room.completionRate} className="w-24" />
                          <span className="text-sm font-medium">{room.completionRate}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có dữ liệu
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
