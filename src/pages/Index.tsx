import { useDashboardStats, useAlerts, useRecentActivities } from "@/hooks/useDashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Building2, Home, TrendingUp, AlertTriangle, DollarSign, FileText } from "lucide-react";
import RevenueChart from "@/components/dashboard/RevenueChart";
import OccupancyChart from "@/components/dashboard/OccupancyChart";
import DebtChart from "@/components/dashboard/DebtChart";
import AlertsList from "@/components/dashboard/AlertsList";
import RecentActivities from "@/components/dashboard/RecentActivities";

// =============================================
// Dashboard Page - Trang chủ tổng quan
// =============================================

const Index = () => {
  const { data: stats, isLoading: statsLoading } = useDashboardStats();
  const { data: alerts } = useAlerts();
  const { data: activities } = useRecentActivities();

  // Loading state
  if (statsLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            Tổng quan hệ thống quản lý bất động sản
          </p>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" aria-label="Đang tải dữ liệu"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-2">
          Tổng quan hệ thống quản lý bất động sản
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Total Rooms */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Tổng số phòng
            </CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalRooms || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.availableRooms || 0} phòng còn trống
            </p>
          </CardContent>
        </Card>

        {/* Occupancy Rate */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Tỷ lệ lấp đầy
            </CardTitle>
            <Home className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.occupancyRate.toFixed(1) || 0}%
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.occupiedRooms || 0} phòng đã thuê
            </p>
          </CardContent>
        </Card>

        {/* Revenue This Month */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Doanh thu tháng này
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.revenueThisMonth.toLocaleString() || 0}đ
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.newContractsThisMonth || 0} hợp đồng mới
            </p>
          </CardContent>
        </Card>

        {/* Total Debt */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Tổng công nợ
            </CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {stats?.totalDebt.toLocaleString() || 0}đ
            </div>
            <p className="text-xs text-muted-foreground">
              Cần thu từ khách thuê
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Section */}
      <Tabs defaultValue="revenue" className="space-y-4">
        <TabsList>
          <TabsTrigger value="revenue">
            <TrendingUp className="h-4 w-4 mr-2" aria-hidden="true" />
            Doanh thu
          </TabsTrigger>
          <TabsTrigger value="occupancy">
            <Home className="h-4 w-4 mr-2" aria-hidden="true" />
            Lấp đầy
          </TabsTrigger>
          <TabsTrigger value="debt">
            <FileText className="h-4 w-4 mr-2" aria-hidden="true" />
            Công nợ
          </TabsTrigger>
        </TabsList>

        <TabsContent value="revenue" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Biểu đồ doanh thu 12 tháng gần nhất</CardTitle>
              <CardDescription>
                Doanh thu từ thanh toán của khách thuê
              </CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <RevenueChart />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="occupancy" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tỷ lệ lấp đầy phòng</CardTitle>
              <CardDescription>
                Phân bố phòng đã thuê và còn trống
              </CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <OccupancyChart />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="debt" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Phân tích công nợ</CardTitle>
              <CardDescription>
                Công nợ theo độ tuổi (0-30, 31-60, 61-90, >90 ngày)
              </CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <DebtChart />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Alerts & Recent Activities */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Alerts */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Cảnh báo cần xử lý
            </CardTitle>
            <CardDescription>
              Hóa đơn quá hạn, hợp đồng sắp hết hạn, sự cố khẩn cấp
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertsList alerts={alerts || []} />
          </CardContent>
        </Card>

        {/* Recent Activities */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" aria-hidden="true" />
              Hoạt động gần đây
            </CardTitle>
            <CardDescription>
              Hợp đồng mới, thanh toán, sự cố trong 7 ngày qua
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecentActivities activities={activities || []} />
          </CardContent>
        </Card>
      </div>

      {/* Quick Stats Summary */}
      {stats && (
        <Card className="bg-muted/50">
          <CardHeader>
            <CardTitle>Tổng kết nhanh</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Tổng phòng</p>
                <p className="text-2xl font-bold">{stats.totalRooms}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Đã thuê</p>
                <p className="text-2xl font-bold text-green-600">{stats.occupiedRooms}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Còn trống</p>
                <p className="text-2xl font-bold text-blue-600">{stats.availableRooms}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Sự cố chưa giải quyết</p>
                <p className="text-2xl font-bold text-orange-600">{stats.unresolvedIssues}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default Index;
