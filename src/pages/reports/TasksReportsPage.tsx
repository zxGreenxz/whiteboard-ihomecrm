import { CheckSquare, BarChart3, Users, Home } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const reports = [
  {
    title: "Tổng quan Công việc",
    description: "Thống kê và phân tích tổng quan công việc",
    icon: BarChart3,
    path: "/reports/tasks/overview",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  {
    title: "Công việc theo Nhân viên",
    description: "Phân bổ và hiệu suất công việc theo nhân viên",
    icon: Users,
    path: "/reports/tasks/by-staff",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  {
    title: "Công việc theo Căn hộ",
    description: "Lịch sử bảo trì và sửa chữa theo từng căn hộ",
    icon: Home,
    path: "/reports/tasks/by-apartment",
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
];

const TasksReportsPage = () => {
  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <CheckSquare className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Báo cáo Công việc</h1>
            <p className="text-muted-foreground">
              3 loại báo cáo phân tích và thống kê về công việc
            </p>
          </div>
        </div>

      {/* Reports Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => {
          const Icon = report.icon;
          return (
            <Link key={report.path} to={report.path}>
              <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
                <CardHeader>
                  <div className={`w-12 h-12 rounded-lg ${report.bgColor} flex items-center justify-center mb-2`}>
                    <Icon className={`h-6 w-6 ${report.color}`} />
                  </div>
                  <CardTitle className="text-lg">{report.title}</CardTitle>
                  <CardDescription className="text-sm">
                    {report.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button variant="ghost" className="w-full" asChild>
                    <span>Xem báo cáo →</span>
                  </Button>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

        {/* Info Card */}
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader>
            <CardTitle className="text-base">Hướng dẫn sử dụng</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>• Chọn một trong 3 loại báo cáo công việc ở trên</p>
            <p>• Xem phân tích chi tiết và biểu đồ trực quan</p>
            <p>• Xuất báo cáo dưới định dạng Excel, PDF hoặc CSV</p>
            <p>• Dữ liệu được cập nhật real-time từ hệ thống</p>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

export default TasksReportsPage;
