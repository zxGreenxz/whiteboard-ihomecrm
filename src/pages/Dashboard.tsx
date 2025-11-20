import MainLayout from '@/components/layout/MainLayout';
import { Building2, Home, DollarSign, AlertTriangle } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboard';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { OccupancyChart } from '@/components/dashboard/OccupancyChart';
import { DebtChart } from '@/components/dashboard/DebtChart';
import { AlertsList } from '@/components/dashboard/AlertsList';
import { RecentActivities } from '@/components/dashboard/RecentActivities';
import { formatCurrency } from '@/lib/utils';

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
          <StatsCard
            title="Tổng số phòng"
            value={stats?.totalRooms || 0}
            description={`${stats?.availableRooms || 0} phòng còn trống`}
            icon={Home}
            iconColor="text-blue-600"
            iconBgColor="bg-blue-100"
            isLoading={isLoading}
          />

          <StatsCard
            title="Phòng đã cho thuê"
            value={stats?.occupiedRooms || 0}
            description={`Tỷ lệ lấp đầy ${stats?.occupancyRate.toFixed(1) || 0}%`}
            icon={Building2}
            iconColor="text-green-600"
            iconBgColor="bg-green-100"
            isLoading={isLoading}
          />

          <StatsCard
            title="Doanh thu tháng này"
            value={formatCurrency(stats?.revenueThisMonth || 0)}
            description={`${stats?.newContractsThisMonth || 0} hợp đồng mới`}
            icon={DollarSign}
            iconColor="text-emerald-600"
            iconBgColor="bg-emerald-100"
            isLoading={isLoading}
          />

          <StatsCard
            title="Tổng công nợ"
            value={formatCurrency(stats?.totalDebt || 0)}
            description={`${stats?.unresolvedIssues || 0} sự cố chưa xử lý`}
            icon={AlertTriangle}
            iconColor="text-orange-600"
            iconBgColor="bg-orange-100"
            valueColor="text-orange-600"
            isLoading={isLoading}
          />
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
