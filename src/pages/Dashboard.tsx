import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Home, TrendingUp, DollarSign, AlertTriangle, FileText, Users2 } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboard';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { OccupancyChart } from '@/components/dashboard/OccupancyChart';
import { DebtChart } from '@/components/dashboard/DebtChart';
import { AlertsList } from '@/components/dashboard/AlertsList';
import { RecentActivities } from '@/components/dashboard/RecentActivities';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

const Dashboard = () => {
  const { data: stats, isLoading } = useDashboardStats();

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
