import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Home, TrendingUp, DollarSign, AlertTriangle, FileText, Users2, BarChart3, Wallet, CheckSquare, ArrowRight } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboard';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { OccupancyChart } from '@/components/dashboard/OccupancyChart';
import { DebtChart } from '@/components/dashboard/DebtChart';
import { AlertsList } from '@/components/dashboard/AlertsList';
import { RecentActivities } from '@/components/dashboard/RecentActivities';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { useScheduledNotifications } from '@/hooks/useScheduledNotifications';

const Dashboard = () => {
  const { data: stats, isLoading } = useDashboardStats();

  // Run scheduled notification checks
  useScheduledNotifications();

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Chào mừng bạn đến với iHomeCRM - Hệ thống quản lý bất động sản
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Total Rooms */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Tổng số phòng</CardTitle>
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                <Home className="h-5 w-5 text-blue-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{stats?.totalRooms || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stats?.availableRooms || 0} phòng còn trống
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Occupied Rooms */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Phòng đã cho thuê</CardTitle>
              <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-green-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{stats?.occupiedRooms || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Tỷ lệ lấp đầy {stats?.occupancyRate.toFixed(1) || 0}%
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Revenue This Month */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Doanh thu tháng này</CardTitle>
              <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <DollarSign className="h-5 w-5 text-emerald-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">
                    {formatCurrency(stats?.revenueThisMonth || 0)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stats?.newContractsThisMonth || 0} hợp đồng mới
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Total Debt */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Tổng công nợ</CardTitle>
              <div className="h-10 w-10 rounded-full bg-orange-100 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-orange-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-orange-600">
                    {formatCurrency(stats?.totalDebt || 0)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stats?.unresolvedIssues || 0} sự cố chưa xử lý
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <RevenueChart />
          <OccupancyChart />
          <DebtChart />
        </div>

        {/* Reports Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Báo cáo & Phân tích</h2>
              <p className="text-muted-foreground">Truy cập 19 loại báo cáo chuyên sâu</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* Real Estate Reports */}
            <Card className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Building2 className="h-6 w-6 text-blue-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Báo cáo BĐS</CardTitle>
                    <CardDescription>8 loại báo cáo</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Phòng trống, hợp đồng, tỷ lệ lấp đầy, khuyến mại và nhiều hơn nữa
                </p>
                <Button asChild variant="outline" className="w-full group">
                  <Link to="/reports/real-estate" className="flex items-center justify-between">
                    <span>Xem báo cáo</span>
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Finance Reports */}
            <Card className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-lg bg-green-100 flex items-center justify-center">
                    <Wallet className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Báo cáo Tài chính</CardTitle>
                    <CardDescription>8 loại báo cáo</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Sổ quỹ, dòng tiền, công nợ, thanh toán và phân tích lợi nhuận
                </p>
                <Button asChild variant="outline" className="w-full group">
                  <Link to="/reports/finance" className="flex items-center justify-between">
                    <span>Xem báo cáo</span>
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Task Reports */}
            <Card className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-lg bg-purple-100 flex items-center justify-center">
                    <CheckSquare className="h-6 w-6 text-purple-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Báo cáo Công việc</CardTitle>
                    <CardDescription>3 loại báo cáo</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Tổng quan, phân tích theo nhân viên và theo từng phòng
                </p>
                <Button asChild variant="outline" className="w-full group">
                  <Link to="/reports/tasks" className="flex items-center justify-between">
                    <span>Xem báo cáo</span>
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Alerts & Activities Row */}
        <div className="grid gap-4 md:grid-cols-2">
          <AlertsList />
          <RecentActivities />
        </div>
      </div>
    </MainLayout>
  );
};

export default Dashboard;
