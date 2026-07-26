import {
  DollarSign,
  Book,
  TrendingUp,
  PieChart,
  Calendar,
  Coins,
  Wallet,
  BarChart3,
  HandCoins,
  Repeat,
  type LucideIcon,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBusinessPerformanceOrganizations } from "@/hooks/reports/useBusinessPerformance";

interface FinanceReport {
  title: string;
  description: string;
  icon: LucideIcon;
  path: string;
  color: string;
  bgColor: string;
}

const businessPerformanceReport: FinanceReport = {
  title: "Trung tâm Tài chính & Hiệu quả",
  description: "Tổng hợp doanh thu, chi phí, lợi nhuận và KPI vận hành trong một trung tâm phân tích thống nhất",
  icon: BarChart3,
  path: "/reports/finance/business-performance",
  color: "text-violet-600",
  bgColor: "bg-violet-50",
};

const reports: FinanceReport[] = [
  {
    title: "Phân tích tài chính",
    description: "Doanh thu, chi phí, lợi nhuận, KPI vận hành — biểu đồ & bảng phân tích toàn diện",
    icon: BarChart3,
    path: "/reports/finance/analysis",
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
    title: "Chu kỳ Thu — Bàn giao",
    description: "Theo tòa quản lý: đã thu, đã bàn giao, và CHƯA THU chốt lại ở mỗi mốc bàn giao",
    icon: Repeat,
    path: "/reports/finance/thu-ban-giao",
    color: "text-fuchsia-600",
    bgColor: "bg-fuchsia-50",
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
    title: "Báo cáo Lợi Nhuận",
    description: "Doanh thu, chi phí, lợi nhuận và tỷ lệ margin — kèm phần chia lợi nhuận cổ đông",
    icon: PieChart,
    path: "/reports/finance/profit-distribution",
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
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
  const businessPerformanceOrganizations = useBusinessPerformanceOrganizations();
  const canShowBusinessPerformance =
    businessPerformanceOrganizations.isSuccess &&
    (businessPerformanceOrganizations.data?.length ?? 0) > 0;
  const visibleReports = canShowBusinessPerformance
    ? [businessPerformanceReport, ...reports]
    : reports;

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <DollarSign className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Báo cáo Tài chính</h1>
            <p className="text-muted-foreground">
              {visibleReports.length} loại báo cáo phân tích tài chính và dòng tiền
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleReports.map((report) => {
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
