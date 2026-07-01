import {
  DollarSign,
  Book,
  TrendingUp,
  PieChart,
  FileText,
  Users,
  Calendar,
  Coins,
  Wallet,
  BarChart3,
  HandCoins,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const reports = [
  {
    title: "Phân tích tài chính",
    description: "Doanh thu, chi phí, lợi nhuận, KPI vận hành — biểu đồ & bảng phân tích toàn diện",
    icon: BarChart3,
    path: "/report/finance/analysis",
    color: "text-violet-600",
    bgColor: "bg-violet-50",
  },
  {
    title: "Bàn giao tiền & Đối soát sổ",
    description: "Theo từng sổ: đã thu, đã chi, đã bàn giao cho chủ, còn phải nộp — và chốt số sổ chuyển khoản",
    icon: HandCoins,
    path: "/reports/finance/ban-giao",
    color: "text-teal-600",
    bgColor: "bg-teal-50",
  },
  {
    title: "Sổ quỹ theo ngày",
    description: "Thu chi hàng ngày, số dư đầu kỳ, tổng thu, tổng chi, số dư cuối kỳ",
    icon: Book,
    path: "/reports/finance/daily-cashbook",
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  {
    title: "Dòng tiền",
    description: "Phân tích dòng tiền vào/ra và xu hướng theo thời gian",
    icon: TrendingUp,
    path: "/reports/finance/cash-flow",
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  {
    title: "Phân bổ lợi nhuận",
    description: "Doanh thu, chi phí, lợi nhuận và tỷ lệ margin",
    icon: PieChart,
    path: "/reports/finance/profit-distribution",
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
  },
  {
    title: "Chia lợi nhuận cổ đông",
    description: "Lợi nhuận theo nhà/tháng, chia theo tỷ lệ, theo dõi đã ứng & còn lại",
    icon: Users,
    path: "/finance/shareholder-profit",
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  {
    title: "Công nợ hợp đồng mới",
    description: "Công nợ phát sinh từ các hợp đồng mới ký kết",
    icon: FileText,
    path: "/reports/finance/new-contract-debt",
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
  {
    title: "Khách nợ tiền",
    description: "Danh sách khách hàng có công nợ, phân loại theo mức độ",
    icon: Users,
    path: "/reports/finance/customer-debt",
    color: "text-orange-600",
    bgColor: "bg-orange-50",
  },
  {
    title: "Lịch thanh toán",
    description: "Hợp đồng cần thu trong tháng, ngày đáo hạn và số tiền",
    icon: Calendar,
    path: "/reports/finance/payment-schedule",
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  {
    title: "Tiền thừa",
    description: "Danh sách khách trả thừa cần hoàn lại",
    icon: Coins,
    path: "/reports/finance/overpayment",
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  {
    title: "Danh sách tiền cọc",
    description: "Tổng tiền cọc đang giữ, phân theo trạng thái",
    icon: Wallet,
    path: "/reports/finance/deposits",
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
  },
];

const FinanceReportsPage = () => {
  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <DollarSign className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Báo cáo Tài chính</h1>
            <p className="text-muted-foreground">
              11 loại báo cáo phân tích tài chính và dòng tiền
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

export default FinanceReportsPage;
