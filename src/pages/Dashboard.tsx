import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Building2, Home, DollarSign, AlertTriangle, BarChart3, Wallet, CheckSquare, ArrowRight, DoorOpen } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboard';
import { useBuildings } from '@/hooks/useBuildings';
import { OperationsSummary } from '@/components/dashboard/OperationsSummary';
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
import OnboardingWizard, { useOnboardingState } from '@/components/onboarding/OnboardingWizard';

const Dashboard = () => {
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const buildingId = selectedBuilding === 'all' ? null : selectedBuilding;

  const { data: stats, isLoading } = useDashboardStats(buildingId);
  const { data: buildings = [] } = useBuildings();

  // Run scheduled notification checks
  useScheduledNotifications();

  // Onboarding wizard state
  const { isCompleted: onboardingCompleted, isLoading: onboardingLoading } = useOnboardingState();
  const showOnboarding = !onboardingLoading && !onboardingCompleted;

  return (
    <MainLayout>
      {showOnboarding && <OnboardingWizard />}
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Bảng tin</h1>
            <p className="text-muted-foreground mt-1">
              Chào mừng bạn đến với iHomeCRM - Hệ thống quản lý bất động sản
            </p>
          </div>
          <div className="flex gap-2 items-center">
            {/* Building Filter */}
            <Select
              value={selectedBuilding || 'all'}
              onValueChange={(value) => setSelectedBuilding(value === 'all' ? null : value)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Tất cả toà nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả toà nhà</SelectItem>
                {buildings.map((building: any) => (
                  <SelectItem key={building.id} value={building.id}>
                    {building.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" asChild>
              <Link to="/reports/real-estate">
                <BarChart3 className="h-4 w-4 mr-2" />
                Xem báo cáo
              </Link>
            </Button>
          </div>
        </div>

        {/* Stats Grid - 5 cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {/* Total Rooms */}
          <Card className="border-l-4 border-l-primary hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Tổng số căn hộ</CardTitle>
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Home className="h-5 w-5 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-3xl font-bold text-foreground">{stats?.totalRooms || 0}</div>
              )}
            </CardContent>
          </Card>

          {/* Occupied Rooms */}
          <Card className="border-l-4 border-l-emerald-500 hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Đang thuê</CardTitle>
              <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-emerald-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <>
                  <div className="text-3xl font-bold text-foreground">{stats?.occupiedRooms || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Tỷ lệ lấp đầy <span className="text-emerald-600 font-medium">{stats?.occupancyRate.toFixed(1) || 0}%</span>
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Vacant Rooms */}
          <Card className="border-l-4 border-l-red-500 hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Trống</CardTitle>
              <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center">
                <DoorOpen className="h-5 w-5 text-red-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-3xl font-bold text-red-600">{stats?.availableRooms || 0}</div>
              )}
            </CardContent>
          </Card>

          {/* Revenue This Month */}
          <Card className="border-l-4 border-l-blue-500 hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Doanh thu tháng</CardTitle>
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                <DollarSign className="h-5 w-5 text-blue-600" />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-foreground">
                    {formatCurrency(stats?.revenueThisMonth || 0)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="text-blue-600 font-medium">{stats?.newContractsThisMonth || 0}</span> hợp đồng mới
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Total Debt */}
          <Card className="border-l-4 border-l-orange-500 hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Công nợ tổng</CardTitle>
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
                    <span className="text-orange-600 font-medium">{stats?.unresolvedIssues || 0}</span> công việc chưa xử lý
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Operations summary — Resident-style 3 widgets */}
        <OperationsSummary buildingId={buildingId} />

        {/* Charts Row */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <RevenueChart buildingId={buildingId} />
          <OccupancyChart buildingId={buildingId} />
          <DebtChart />
        </div>

        {/* Reports Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-foreground">Báo cáo & Phân tích</h2>
              <p className="text-sm text-muted-foreground">Truy cập 19 loại báo cáo chuyên sâu</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Real Estate Reports */}
            <Card className="group hover:shadow-lg transition-all hover:border-primary/30 cursor-pointer">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Báo cáo BĐS</CardTitle>
                    <CardDescription>8 loại báo cáo</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Căn hộ trống, hợp đồng, tỷ lệ lấp đầy, khuyến mại và nhiều hơn nữa
                </p>
                <Button asChild variant="outline" className="w-full group-hover:bg-primary group-hover:text-white transition-colors">
                  <Link to="/reports/real-estate" className="flex items-center justify-between">
                    <span>Xem báo cáo</span>
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Finance Reports */}
            <Card className="group hover:shadow-lg transition-all hover:border-emerald-500/30 cursor-pointer">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-xl bg-emerald-100 flex items-center justify-center group-hover:bg-emerald-200 transition-colors">
                    <Wallet className="h-6 w-6 text-emerald-600" />
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
                <Button asChild variant="outline" className="w-full group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                  <Link to="/reports/finance" className="flex items-center justify-between">
                    <span>Xem báo cáo</span>
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Task Reports */}
            <Card className="group hover:shadow-lg transition-all hover:border-purple-500/30 cursor-pointer">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-xl bg-purple-100 flex items-center justify-center group-hover:bg-purple-200 transition-colors">
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
                  Tổng quan, phân tích theo nhân viên và theo từng căn hộ
                </p>
                <Button asChild variant="outline" className="w-full group-hover:bg-purple-600 group-hover:text-white transition-colors">
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
          <AlertsList buildingId={buildingId} />
          <RecentActivities buildingId={buildingId} />
        </div>
      </div>
    </MainLayout>
  );
};

export default Dashboard;
