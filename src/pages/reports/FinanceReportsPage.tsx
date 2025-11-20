import { DollarSign, Book, TrendingUp, AlertCircle, Users, Calendar, PlusCircle, Wallet, PieChart } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const reports = [
  {
    title: "Sổ quỹ tiền mặt",
    description: "Sổ quỹ chi tiết theo ngày với số dư tích lũy",
    icon: Book,
    path: "/reports/finance/cash-book",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  {
    title: "Dòng tiền",
    description: "Phân tích dòng tiền vào/ra và xu hướng",
    icon: TrendingUp,
    path: "/reports/finance/cash-flow",
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  {
    title: "Công nợ",
    description: "Phân tích công nợ theo tuổi nợ (0-30, 31-60, 61-90, >90 ngày)",
    icon: AlertCircle,
    path: "/reports/finance/debt",
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
  {
    title: "Khách nợ tiền",
    description: "Danh sách khách hàng có công nợ",
    icon: Users,
    path: "/reports/finance/customer-debt",
    color: "text-orange-600",
    bgColor: "bg-orange-50",
  },
  {
    title: "Lịch thanh toán",
    description: "Lịch hóa đơn đến hạn và quá hạn",
    icon: Calendar,
    path: "/reports/finance/payment-schedule",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  {
    title: "Tiền thừa",
    description: "Danh sách khách hàng thanh toán thừa",
    icon: PlusCircle,
    path: "/reports/finance/overpayment",
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  {
    title: "Tiền cọc",
    description: "Quản lý danh sách tiền cọc khách hàng",
    icon: Wallet,
    path: "/reports/finance/deposits",
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
  },
  {
    title: "Phân bổ lợi nhuận",
    description: "Phân tích cấu trúc doanh thu và lợi nhuận",
    icon: PieChart,
    path: "/reports/finance/profit-distribution",
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
  },
];

const FinanceReportsPage = () => {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <DollarSign className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Báo cáo Tài chính</h1>
          <p className="text-muted-foreground">
            8 loại báo cáo phân tích tài chính và dòng tiền
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
      <Card className="border-green-200 bg-green-50/50">
        <CardHeader>
          <CardTitle className="text-base">Hướng dẫn sử dụng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>• Chọn một trong 8 loại báo cáo tài chính ở trên</p>
          <p>• Sử dụng bộ lọc ngày tháng để phân tích theo kỳ</p>
          <p>• Xem biểu đồ trực quan cho dòng tiền, công nợ, phân bổ lợi nhuận</p>
          <p>• Xuất báo cáo dưới định dạng Excel, PDF hoặc CSV</p>
          <p>• Dữ liệu real-time từ hệ thống thanh toán</p>
        </CardContent>
      </Card>
    </div>
  );
};

export default FinanceReportsPage;
