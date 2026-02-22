import {
  Building2,
  Home,
  Clock,
  RefreshCw,
  BarChart3,
  BarChart,
  Tag,
  PlusCircle,
  XCircle,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const reports = [
  {
    title: "Căn hộ trống",
    description: "Danh sách căn hộ hiện đang trống và sẵn sàng cho thuê",
    icon: Home,
    path: "/reports/real-estate/vacant",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  {
    title: "Căn hộ sắp trống",
    description: "Hợp đồng sẽ hết hạn trong 7, 15, 30 ngày tới",
    icon: Clock,
    path: "/reports/real-estate/expiring",
    color: "text-orange-600",
    bgColor: "bg-orange-50",
  },
  {
    title: "Căn hộ gia hạn, chuyển nhượng",
    description: "Báo cáo các hợp đồng gia hạn và chuyển nhượng",
    icon: RefreshCw,
    path: "/reports/real-estate/renewals-transfers",
    color: "text-teal-600",
    bgColor: "bg-teal-50",
  },
  {
    title: "Tỉ lệ lấp đầy (cũ)",
    description: "Thống kê tỉ lệ lấp đầy phiên bản cũ",
    icon: BarChart3,
    path: "/reports/real-estate/occupancy-old",
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  {
    title: "Tỉ lệ lấp đầy (mới)",
    description: "Thống kê tỉ lệ lấp đầy phiên bản mới với biểu đồ",
    icon: BarChart,
    path: "/reports/real-estate/occupancy-new",
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  {
    title: "Báo cáo khuyến mại",
    description: "Danh sách hợp đồng có giảm giá và tổng khuyến mại",
    icon: Tag,
    path: "/reports/real-estate/promotions",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  {
    title: "Báo cáo cho thuê",
    description: "Hợp đồng cho thuê mới được ký trong kỳ",
    icon: PlusCircle,
    path: "/reports/real-estate/new-leases",
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
  },
  {
    title: "Báo cáo bỏ trả",
    description: "Hợp đồng thanh lý, lý do chấm dứt và tỷ lệ bỏ trả",
    icon: XCircle,
    path: "/reports/real-estate/terminations",
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
];

const RealEstateReportsPage = () => {
  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Building2 className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Báo cáo Bất động sản</h1>
            <p className="text-muted-foreground">
              8 loại báo cáo phân tích và thống kê về bất động sản
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
      </div>
    </MainLayout>
  );
};

export default RealEstateReportsPage;
