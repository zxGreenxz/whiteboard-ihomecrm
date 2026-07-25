import { lazy, Suspense, useEffect, useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { hideAppSplash } from '@/lib/appSplash';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Building2, Home, DollarSign, AlertTriangle, BarChart3, Wallet, CheckSquare, ArrowRight, DoorOpen } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboard';
import { useBuildings } from '@/hooks/useBuildings';
import { useVacantRoomsReport } from '@/hooks/useReports';
import { OperationsSummary } from '@/components/dashboard/OperationsSummary';
// 3 chart kéo theo recharts (~400 kB) — lazy để first paint Dashboard không
// chờ parse recharts; chart hiện sau với skeleton.
const RevenueChart = lazy(() =>
  import('@/components/dashboard/RevenueChart').then((m) => ({ default: m.RevenueChart })),
);
const OccupancyChart = lazy(() =>
  import('@/components/dashboard/OccupancyChart').then((m) => ({ default: m.OccupancyChart })),
);
const DebtChart = lazy(() =>
  import('@/components/dashboard/DebtChart').then((m) => ({ default: m.DebtChart })),
);
import { AlertsList } from '@/components/dashboard/AlertsList';
import { RecentActivities } from '@/components/dashboard/RecentActivities';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Link, useNavigate } from 'react-router-dom';
import { useScheduledNotifications } from '@/hooks/useScheduledNotifications';
import OnboardingWizard, { useOnboardingState } from '@/components/onboarding/OnboardingWizard';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePersistedState } from '@/hooks/usePersistedState';
import { usePrefetchHeavyPages } from '@/hooks/usePrefetchHeavyPages';

const Dashboard = () => {
  const [selectedBuilding, setSelectedBuilding] = usePersistedState<string | null>('flt:dashboard:building', null);
  const [vacantOpen, setVacantOpen] = useState(false);
  const buildingId = selectedBuilding === 'all' ? null : selectedBuilding;
  const navigate = useNavigate();

  // Dashboard là trang chủ desktop → ẩn splash khi mount.
  useEffect(() => {
    hideAppSplash();
  }, []);

  // Tải nền trang đầu Hoá đơn/Thu chi/Hợp đồng/Công việc lúc rảnh — bấm vào
  // là hiện ngay, không "Đang tải".
  usePrefetchHeavyPages();

  const { data: stats, isLoading } = useDashboardStats(buildingId);
  const { data: buildings = [] } = useBuildings();
  // Chỉ fetch khi user MỞ dialog (3 query full-table rooms+contracts×2).
  const { data: vacantRooms, isLoading: vacantLoading } = useVacantRoomsReport(
    buildingId || undefined,
    undefined,
    { enabled: vacantOpen },
  );

  // Run scheduled notification checks
  useScheduledNotifications();

  // Onboarding wizard: chỉ bật ở lần đăng nhập đầu tiên (hook tự latch, chỉ
  // trả true khi chắc chắn user chưa từng onboard).
  const { shouldShow: showOnboarding } = useOnboardingState();

  return (
    <MainLayout>
      {showOnboarding && <OnboardingWizard />}
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Bảng tin</h1>
            <p className="text-muted-foreground mt-1">
              Chào mừng bạn đến với CRM - Hệ thống quản lý bất động sản
            </p>
          </div>
          <div className="flex gap-2 items-center">
            {/* Building Filter */}
            <SearchableSelect
              value={selectedBuilding || 'all'}
              onValueChange={(value) => setSelectedBuilding(value === 'all' ? null : value)}
              className="w-[200px]"
              placeholder="Tất cả toà nhà"
              options={[
                { value: 'all', label: 'Tất cả toà nhà' },
                ...buildings.map((building: any) => ({ value: building.id, label: building.name })),
              ]}
            />
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
          <Card
            role="button"
            tabIndex={0}
            onClick={() => setVacantOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setVacantOpen(true);
              }
            }}
            className="border-l-4 border-l-red-500 hover:shadow-md transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-500/40"
          >
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
                <>
                  <div className="text-3xl font-bold text-red-600">{stats?.availableRooms || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">Bấm để xem chi tiết</p>
                </>
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
          <Suspense
            fallback={
              <>
                <Skeleton className="h-[350px]" />
                <Skeleton className="h-[350px]" />
                <Skeleton className="h-[350px]" />
              </>
            }
          >
            <RevenueChart buildingId={buildingId} />
            <OccupancyChart buildingId={buildingId} />
            <DebtChart />
          </Suspense>
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

      <Dialog open={vacantOpen} onOpenChange={setVacantOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DoorOpen className="h-5 w-5 text-red-600" />
              Danh sách phòng trống
              {!vacantLoading && vacantRooms && (
                <span className="text-sm font-normal text-muted-foreground">
                  ({vacantRooms.length})
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Các căn hộ chưa có hợp đồng đang hoạt động. Bấm vào dòng để xem chi tiết phòng.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            {vacantLoading ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : vacantRooms && vacantRooms.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tòa nhà</TableHead>
                    <TableHead>Căn hộ</TableHead>
                    <TableHead>Tầng</TableHead>
                    <TableHead className="text-right">Giá thuê</TableHead>
                    <TableHead className="text-right">Số ngày trống</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vacantRooms.map((room) => (
                    <TableRow
                      key={room.id}
                      className="cursor-pointer"
                      onClick={() => {
                        setVacantOpen(false);
                        navigate(`/apartments/${room.id}`);
                      }}
                    >
                      <TableCell className="font-medium">
                        {room.buildings?.name || '—'}
                      </TableCell>
                      <TableCell>{room.name}</TableCell>
                      <TableCell>{room.floor ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(room.rent_price || 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {room.days_vacant != null ? (
                          <span
                            className={
                              room.days_vacant <= 7
                                ? 'text-green-600'
                                : room.days_vacant <= 30
                                ? 'text-yellow-600'
                                : 'text-red-600'
                            }
                          >
                            {room.days_vacant} ngày
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Chưa xác định</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                Không có căn hộ trống nào
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link to="/reports/real-estate/vacant-rooms" onClick={() => setVacantOpen(false)}>
                Xem báo cáo đầy đủ
                <ArrowRight className="h-4 w-4 ml-2" />
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default Dashboard;
