import { Building2, Home, FileText, TrendingUp, Tag, PlusCircle, XCircle, Activity, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const reports = [
  {
    title: "Phòng trống",
    description: "Danh sách phòng hiện đang trống và sẵn sàng cho thuê",
    icon: Home,
    path: "/reports/real-estate/vacant-rooms",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  {
    title: "Hợp đồng sắp hết hạn",
    description: "Hợp đồng sẽ hết hạn trong 7, 15, 30 ngày tới",
    icon: FileText,
    path: "/reports/real-estate/expiring-contracts",
    color: "text-orange-600",
    bgColor: "bg-orange-50",
  },
  {
    title: "Tỷ lệ lấp đầy",
    description: "Thống kê tỷ lệ lấp đầy và phân tích theo tòa nhà",
    icon: TrendingUp,
    path: "/reports/real-estate/occupancy",
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  {
    title: "Khuyến mại",
    description: "Danh sách khuyến mại và ưu đãi đang áp dụng",
    icon: Tag,
    path: "/reports/real-estate/promotions",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  {
    title: "Cho thuê mới",
    description: "Hợp đồng cho thuê mới được ký trong kỳ",
    icon: PlusCircle,
    path: "/reports/real-estate/new-leases",
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  {
    title: "Hợp đồng kết thúc",
    description: "Danh sách hợp đồng đã kết thúc hoặc bị hủy",
    icon: XCircle,
    path: "/reports/real-estate/terminations",
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
  {
    title: "Lịch sử giá",
    description: "Lịch sử thay đổi giá thuê theo thời gian",
    icon: Activity,
    path: "/reports/real-estate/price-history",
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
  },
  {
    title: "Thay đổi hợp đồng",
    description: "Gia hạn, chuyển nhượng và điều chỉnh hợp đồng",
    icon: RefreshCw,
    path: "/reports/real-estate/contract-changes",
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
  },
];

const RealEstateReportsPage = () => {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Building2 className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Báo cáo Bất động sản</h1>
          <p className="text-muted-foreground">
            8 loại báo cáo phân tích và thống kê về bất động sản
          </p>
        </div>
      </div>

      {/* Reports Grid */}
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

      {/* Info Card */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader>
          <CardTitle className="text-base">Hướng dẫn sử dụng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>• Chọn một trong 8 loại báo cáo bất động sản ở trên</p>
          <p>• Sử dụng bộ lọc để tùy chỉnh dữ liệu báo cáo</p>
          <p>• Xuất báo cáo dưới định dạng Excel, PDF hoặc CSV</p>
          <p>• Dữ liệu được cập nhật real-time từ hệ thống</p>
        </CardContent>
      </Card>
    </div>
  );
};

export default RealEstateReportsPage;
