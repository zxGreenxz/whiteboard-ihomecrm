import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Home, Users, DollarSign, TrendingUp, AlertCircle } from 'lucide-react';

const Dashboard = () => {
  // Placeholder stats - will be replaced with real data in Phase 18
  const stats = [
    {
      title: 'Tổng số phòng',
      value: '0',
      description: 'Phòng đang quản lý',
      icon: Home,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      title: 'Phòng đã cho thuê',
      value: '0',
      description: 'Tỷ lệ lấp đầy 0%',
      icon: Building2,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
    {
      title: 'Khách thuê',
      value: '0',
      description: 'Khách hàng hiện tại',
      icon: Users,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      title: 'Doanh thu tháng này',
      value: '0 đ',
      description: 'Chưa có dữ liệu',
      icon: DollarSign,
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-100',
    },
  ];

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
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Card key={stat.title}>
                <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                  <CardTitle className="text-sm font-medium">
                    {stat.title}
                  </CardTitle>
                  <div className={`h-10 w-10 rounded-full ${stat.bgColor} flex items-center justify-center`}>
                    <Icon className={`h-5 w-5 ${stat.color}`} />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stat.value}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stat.description}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Welcome Message */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Bắt đầu sử dụng
            </CardTitle>
            <CardDescription>
              Hệ thống đang được phát triển theo 20 phases
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <p className="font-medium">Phase 1: Database Foundation - ✅ Hoàn thành</p>
                <p className="text-sm text-muted-foreground">
                  32 tables, 28 enums, RLS policies, triggers & functions
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <p className="font-medium">Phase 2: Authentication System - ✅ Hoàn thành</p>
                <p className="text-sm text-muted-foreground">
                  Register, Login, Forgot Password, Protected Routes
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-green-600 mt-0.5" />
              <div>
                <p className="font-medium">Phase 3: Main Layout & Navigation - 🚧 Đang thực hiện</p>
                <p className="text-sm text-muted-foreground">
                  Header, Sidebar, MainLayout, Breadcrumbs, Routing
                </p>
              </div>
            </div>

            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm">
                <strong>Tiến độ:</strong> 2/20 phases hoàn thành (10%). Dự kiến hoàn thành trong 10-14 tuần.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

export default Dashboard;
