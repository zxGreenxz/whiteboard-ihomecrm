import { Users, TrendingUp, CheckCircle2, AlertCircle } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useTasksByStaffReport } from "@/hooks/useReports";
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

export default function TasksByStaffReport() {
  const { data: staffData, isLoading } = useTasksByStaffReport();

  const totalTasks = staffData?.reduce((sum, s) => sum + s.total, 0) || 0;
  const totalCompleted = staffData?.reduce((sum, s) => sum + s.completed, 0) || 0;
  const totalOverdue = staffData?.reduce((sum, s) => sum + s.overdue, 0) || 0;
  const avgCompletionRate = staffData && staffData.length > 0
    ? staffData.reduce((sum, s) => sum + s.completionRate, 0) / staffData.length
    : 0;

  const stats = (
    <>
      <ReportCard
        title="Số nhân viên"
        value={staffData?.length || 0}
        icon={Users}
        description="Có công việc"
      />
      <ReportCard
        title="Tổng công việc"
        value={totalTasks}
        icon={CheckCircle2}
        description="Đã phân công"
      />
      <ReportCard
        title="Đã hoàn thành"
        value={totalCompleted}
        icon={TrendingUp}
        description="Tất cả nhân viên"
      />
      <ReportCard
        title="Tỷ lệ TB"
        value={`${avgCompletionRate.toFixed(1)}%`}
        icon={AlertCircle}
        description="Completion rate TB"
      />
    </>
  );

  const exportData = staffData?.map(staff => ({
    "Nhân viên": staff.staffName,
    "Tổng CV": staff.total,
    "Hoàn thành": staff.completed,
    "Đang làm": staff.inProgress,
    "Chưa bắt đầu": staff.pending,
    "Quá hạn": staff.overdue,
    "Tỷ lệ hoàn thành (%)": staff.completionRate,
  })) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Công việc theo Nhân viên"
      description="Phân bổ và hiệu suất công việc theo nhân viên"
      icon={<Users className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-cong-viec-theo-nhan-vien"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Chi tiết theo nhân viên</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : staffData && staffData.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nhân viên</TableHead>
                    <TableHead className="text-center">Tổng</TableHead>
                    <TableHead className="text-center">Hoàn thành</TableHead>
                    <TableHead className="text-center">Đang làm</TableHead>
                    <TableHead className="text-center">Quá hạn</TableHead>
                    <TableHead>Tỷ lệ hoàn thành</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staffData.map((staff, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{staff.staffName}</TableCell>
                      <TableCell className="text-center">{staff.total}</TableCell>
                      <TableCell className="text-center text-green-600 font-semibold">
                        {staff.completed}
                      </TableCell>
                      <TableCell className="text-center text-blue-600">
                        {staff.inProgress}
                      </TableCell>
                      <TableCell className="text-center text-red-600">
                        {staff.overdue}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={staff.completionRate} className="w-24" />
                          <span className="text-sm font-medium">{staff.completionRate}%</span>
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
    </MainLayout>
  );
}
