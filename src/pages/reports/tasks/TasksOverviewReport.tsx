import { CheckSquare, ClipboardCheck, AlertTriangle, Clock, Percent } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useTasksOverviewReport } from "@/hooks/useReports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

const COLORS = {
  completed: "#10B981",
  inProgress: "#3B82F6",
  pending: "#F59E0B",
  overdue: "#EF4444",
};

export default function TasksOverviewReport() {
  const { data: tasksData, isLoading } = useTasksOverviewReport();

  const stats = tasksData && (
    <>
      <ReportCard
        title="Tổng công việc"
        value={tasksData.summary.total}
        icon={CheckSquare}
        description="Tất cả công việc"
      />
      <ReportCard
        title="Hoàn thành"
        value={tasksData.summary.completed}
        icon={ClipboardCheck}
        description={`${tasksData.summary.completionRate}% hoàn thành`}
      />
      <ReportCard
        title="Đang thực hiện"
        value={tasksData.summary.inProgress}
        icon={Clock}
        description="Công việc đang làm"
      />
      <ReportCard
        title="Quá hạn"
        value={tasksData.summary.overdue}
        icon={AlertTriangle}
        description="Cần xử lý khẩn"
      />
    </>
  );

  const statusData = tasksData ? [
    { name: "Hoàn thành", value: tasksData.summary.completed, color: COLORS.completed },
    { name: "Đang làm", value: tasksData.summary.inProgress, color: COLORS.inProgress },
    { name: "Chưa bắt đầu", value: tasksData.summary.pending, color: COLORS.pending },
    { name: "Quá hạn", value: tasksData.summary.overdue, color: COLORS.overdue },
  ].filter(item => item.value > 0) : [];

  const priorityData = tasksData ? [
    { name: "Cao", value: tasksData.byPriority.HIGH },
    { name: "Trung bình", value: tasksData.byPriority.MEDIUM },
    { name: "Thấp", value: tasksData.byPriority.LOW },
  ].filter(item => item.value > 0) : [];

  const exportData = tasksData?.recentTasks.map(task => ({
    "Tiêu đề": task.title,
    "Ưu tiên": task.priority,
    "Trạng thái": task.status,
    "Danh mục": task.category || "N/A",
    "Ngày tạo": task.created_at,
  })) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Tổng quan Công việc"
      description="Thống kê và phân tích tổng quan công việc"
      icon={<CheckSquare className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-tong-quan-cong-viec"
        />
      }
      stats={stats}
    >
      {isLoading ? (
        <Skeleton className="h-[400px] w-full" />
      ) : tasksData ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Phân bố theo trạng thái</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry) => `${entry.name}: ${entry.value}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Phân bố theo ưu tiên</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={priorityData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="value" fill="#3B82F6" name="Số lượng" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          Không có dữ liệu
        </div>
      )}
    </ReportLayout>
    </MainLayout>
  );
}
