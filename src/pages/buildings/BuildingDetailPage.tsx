import {useBuildingDetailContracts,useBuildingDetailInvoices} from '@/hooks/usePropertyDetailQueries';
import { useParams, useNavigate } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Building2,
  ArrowLeft,
  Pencil,
  MapPin,
  Home,
  FileText,
  Receipt,
  Eye,
} from 'lucide-react';
import { useBuilding } from '@/hooks/useBuildings';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { InlineSkeleton, LoadingState } from '@/components/loading/LoadingState';
import { useRooms } from '@/hooks/useRooms';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { EditBuildingDialog } from '@/components/buildings/EditBuildingDialog';

/** Số trên tab: đang chờ thì vạch xám nhỏ (không in 0); nguồn hỏng giữ "…", lỗi hiện trong tab. */
function tabCount(query: { data: unknown; isError: boolean }, count: number, label: string): ReactNode {
  if (query.isError) return '…';
  if (query.data === undefined) return <InlineSkeleton label={label} width="1.25rem" />;
  return count;
}

type RoomStats = { total: number; available: number; occupied: number; reserved: number; maintenance: number };

/** Năm thẻ số phòng; `null` = chưa có số — khung thẻ hiện, ô số là vạch xám. */
function RoomStatsGrid({ stats }: { stats: RoomStats | null }) {
  const items: { key: keyof RoomStats; label: string; cls: string }[] = [
    { key: 'total', label: 'Tổng số căn hộ', cls: '' },
    { key: 'available', label: 'Còn trống', cls: 'text-green-600' },
    { key: 'reserved', label: 'Đã đặt cọc', cls: 'text-orange-500' },
    { key: 'occupied', label: 'Đang thuê', cls: 'text-blue-600' },
    { key: 'maintenance', label: 'Bảo trì', cls: 'text-orange-600' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {items.map(item => (
        <Card key={item.key}>
          <CardContent className="pt-6">
            <div className="text-sm text-muted-foreground">{item.label}</div>
            <div className={`text-2xl font-bold ${item.cls}`}>
              {stats ? stats[item.key] : <InlineSkeleton label={`số ${item.label.toLowerCase()}`} width="2.5rem" />}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const BuildingDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const buildingQuery=useBuilding(id||'');
  const {data:building,isLoading:loadingBuilding}=buildingQuery;
  const roomsQuery=useRooms(id);
  const {data:rooms}=roomsQuery;
  const contractsQuery=useBuildingDetailContracts(id||'');
  const {data:contracts=[]}=contractsQuery;
  const invoicesQuery=useBuildingDetailInvoices(id||'',rooms?.map(room=>room.id));
  const {data:invoices=[]}=invoicesQuery;

  if (loadingBuilding) {
    // Khung trang (quay lại + tiêu đề) hiện ngay, chi tiết là khối xám (chủ chốt 02/10/2026).
    return (
      <MainLayout title="Chi tiết Tòa nhà" icon={Building2}>
        <div className="mb-6">
          <Button variant="outline" onClick={() => navigate('/buildings')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại
          </Button>
        </div>
        <LoadingState label="chi tiết tòa nhà" variant="detail" rows={8} onRetry={() => void buildingQuery.refetch()} />
      </MainLayout>
    );
  }

  if (buildingQuery.isError && !building) {
    return <MainLayout title="Chi tiết Tòa nhà" icon={Building2}>
      <QueryRegion label="chi tiết tòa nhà" queries={[buildingQuery]} skeleton="detail"><></></QueryRegion>
    </MainLayout>;
  }

  if (!building) {
    return (
      <MainLayout title="Chi tiết Tòa nhà" icon={Building2}>
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <p className="text-muted-foreground">Không tìm thấy tòa nhà</p>
          <Button variant="outline" onClick={() => navigate('/buildings')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive'> = {
      ACTIVE: 'default',
      INACTIVE: 'secondary',
      MAINTENANCE: 'destructive',
    };

    const labels: Record<string, string> = {
      ACTIVE: 'Hoạt động',
      INACTIVE: 'Không hoạt động',
      MAINTENANCE: 'Bảo trì',
    };

    return (
      <Badge variant={variants[status] || 'default'}>
        {labels[status] || status}
      </Badge>
    );
  };

  const getTypeBadge = (type: string) => {
    const labels: Record<string, string> = {
      APARTMENT: 'Chung cư',
      DORMITORY: 'Ký túc xá',
      HOUSE: 'Nhà riêng',
      OFFICE: 'Văn phòng',
      SLEEPBOX: 'Sleepbox',
    };

    return <Badge variant="outline">{labels[type] || type}</Badge>;
  };

  const getRoomStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      AVAILABLE: 'default',
      OCCUPIED: 'secondary',
      MAINTENANCE: 'destructive',
      RESERVED: 'outline',
    };

    const labels: Record<string, string> = {
      AVAILABLE: 'Còn trống',
      OCCUPIED: 'Đang thuê',
      MAINTENANCE: 'Bảo trì',
      RESERVED: 'Đã đặt',
    };

    return (
      <Badge variant={variants[status] || 'default'}>
        {labels[status] || status}
      </Badge>
    );
  };

  const getContractStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      DRAFT: 'outline',
      ACTIVE: 'default',
      TRANSFERRED: 'secondary',
      TERMINATED: 'destructive',
      EXPIRED: 'destructive',
    };

    const labels: Record<string, string> = {
      DRAFT: 'Nháp',
      ACTIVE: 'Đang hoạt động',
      TRANSFERRED: 'Đã chuyển nhượng',
      TERMINATED: 'Đã thanh lý',
      EXPIRED: 'Hết hạn',
    };

    return (
      <Badge variant={variants[status] || 'outline'}>
        {labels[status] || status}
      </Badge>
    );
  };

  const getInvoiceStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      DRAFT: 'outline',
      SENT: 'secondary',
      PAID: 'default',
      PARTIAL: 'secondary',
      OVERDUE: 'destructive',
      CANCELLED: 'destructive',
    };

    const labels: Record<string, string> = {
      DRAFT: 'Nháp',
      SENT: 'Đã gửi',
      PAID: 'Đã thanh toán',
      PARTIAL: 'Thanh toán một phần',
      OVERDUE: 'Quá hạn',
      CANCELLED: 'Đã hủy',
    };

    return (
      <Badge variant={variants[status] || 'outline'}>
        {labels[status] || status}
      </Badge>
    );
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return format(new Date(dateString), 'dd/MM/yyyy', { locale: vi });
  };

  // Calculate room stats
  const roomStats = {
    total: rooms?.length || 0,
    available: rooms?.filter(r => r.status === 'AVAILABLE').length || 0,
    occupied: rooms?.filter(r => r.status === 'OCCUPIED').length || 0,
    reserved: rooms?.filter(r => r.status === 'RESERVED').length || 0,
    maintenance: rooms?.filter(r => r.status === 'MAINTENANCE').length || 0,
  };

  return (
    <MainLayout
      title={buildingQuery.isError?"Chi tiết tòa nhà":`Tòa nhà: ${building.name}`}
      subtitle={buildingQuery.isError?undefined:building.code||undefined}
      icon={Building2}
    >
      <QueryRegion label="chi tiết tòa nhà" queries={[buildingQuery]} skeleton="detail">
      {/* Header Actions */}
      <div className="flex items-center justify-between mb-6">
        <Button variant="outline" onClick={() => navigate('/buildings')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditDialogOpen(true)}>
            <Pencil className="h-4 w-4 mr-2" />
            Chỉnh sửa
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="general" className="space-y-4">
        <TabsList>
          <TabsTrigger value="general">
            <Building2 className="h-4 w-4 mr-2" />
            Thông tin chung
          </TabsTrigger>
          <TabsTrigger value="rooms">
            <Home className="h-4 w-4 mr-2" />
            Căn hộ ({tabCount(roomsQuery, roomStats.total, 'số căn hộ')})
          </TabsTrigger>
          <TabsTrigger value="contracts">
            <FileText className="h-4 w-4 mr-2" />
            Hợp đồng ({tabCount(contractsQuery, contracts.length, 'số hợp đồng')})
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt className="h-4 w-4 mr-2" />
            {/* Hoá đơn chờ danh sách phòng: phòng hỏng thì hoá đơn không bao giờ chạy ⇒ coi như hỏng. */}
            Hóa đơn ({tabCount({ data: invoicesQuery.data, isError: invoicesQuery.isError || roomsQuery.isError }, invoices.length, 'số hóa đơn')})
          </TabsTrigger>
        </TabsList>

        {/* General Info Tab */}
        <TabsContent value="general" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Thông tin cơ bản</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tên tòa nhà:</span>
                  <span className="font-medium">{building.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mã tòa nhà:</span>
                  <span className="font-medium">{building.code || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Loại hình:</span>
                  {getTypeBadge(building.type)}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Trạng thái:</span>
                  {getStatusBadge(building.status)}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Khu vực:</span>
                  <span className="font-medium">
                    {((building as any).areas ?? [])
                      .map((a: { name: string }) => a.name)
                      .join(', ') || '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Số tầng:</span>
                  <span className="font-medium">{building.total_floors || '-'}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  Địa chỉ
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Số nhà/Đường:</span>
                  <span className="font-medium">{building.street_address || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Phường/Xã:</span>
                  <span className="font-medium">{building.ward || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Quận/Huyện:</span>
                  <span className="font-medium">{building.district || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tỉnh/Thành phố:</span>
                  <span className="font-medium">{building.province || '-'}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Room Stats — chưa có số thì khung thẻ hiện, ô số là vạch xám. */}
          <QueryRegion label="thống kê phòng của tòa nhà" queries={[roomsQuery]} loading={<RoomStatsGrid stats={null} />}>
            <RoomStatsGrid stats={roomStats} />
          </QueryRegion>
          {/* Ghi chú — đọc `description`, KHÔNG phải `notes`.
              Cùng vết với RoomDetailPage: bảng `buildings` không có cột `notes`,
              nên khối này luôn trống. Cột có thật là `description`. */}
          {building.description && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Ghi chú</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground whitespace-pre-wrap">{building.description}</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Rooms Tab */}
        <TabsContent value="rooms">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Danh sách Căn hộ</CardTitle>
              <Button onClick={() => navigate('/rooms', { state: { buildingId: id } })}>
                Quản lý căn hộ
              </Button>
            </CardHeader>
            <CardContent>
              <QueryRegion label="phòng của tòa nhà" queries={[roomsQuery]} skeleton="table" rows={5}>
              {rooms && rooms.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tên căn hộ</TableHead>
                      <TableHead>Tầng</TableHead>
                      <TableHead>Diện tích</TableHead>
                      <TableHead>Giá thuê</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rooms.map((room) => (
                      <TableRow key={room.id}>
                        <TableCell className="font-medium">{room.name}</TableCell>
                        <TableCell>{room.floor || '-'}</TableCell>
                        <TableCell>{room.area ? `${room.area} m²` : '-'}</TableCell>
                        <TableCell>{room.rent_price ? formatCurrency(room.rent_price) : '-'}</TableCell>
                        <TableCell>{getRoomStatusBadge(room.status)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/rooms/${room.id}`)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  Tòa nhà chưa có căn hộ nào
                </div>
              )}
              </QueryRegion>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contracts Tab */}
        <TabsContent value="contracts">
          <Card>
            <CardHeader>
              <CardTitle>Hợp đồng trong tòa nhà</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryRegion label="hợp đồng của tòa nhà" queries={[contractsQuery]} skeleton="table" rows={5}>
              {contracts.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Thời hạn</TableHead>
                      <TableHead>Giá thuê</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contracts.map((contract) => (
                      <TableRow key={contract.id}>
                        <TableCell className="font-medium">
                          {contract.contract_number || contract.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>{contract.tenant?.full_name || '-'}</TableCell>
                        <TableCell>{contract.room?.name || '-'}</TableCell>
                        <TableCell>
                          {formatDate(contract.start_date)} → {formatDate(contract.end_date)}
                        </TableCell>
                        <TableCell>{formatCurrency(contract.rent_price)}</TableCell>
                        <TableCell>{getContractStatusBadge(contract.status)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/contracts/${contract.id}`)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  Chưa có hợp đồng nào trong tòa nhà này
                </div>
              )}
              </QueryRegion>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invoices Tab */}
        <TabsContent value="invoices">
          <Card>
            <CardHeader>
              <CardTitle>Hóa đơn trong tòa nhà</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryRegion label="hóa đơn của tòa nhà" queries={roomsQuery.data?.length===0?[roomsQuery]:[roomsQuery,invoicesQuery]} skeleton="table" rows={5}>
              {invoices.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã hóa đơn</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Căn hộ</TableHead>
                      <TableHead>Hạn thanh toán</TableHead>
                      <TableHead>Tổng tiền</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell className="font-medium">
                          {invoice.invoice_number || invoice.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>{invoice.contract?.tenant?.full_name || '-'}</TableCell>
                        <TableCell>{invoice.contract?.room?.name || '-'}</TableCell>
                        <TableCell>{formatDate(invoice.due_date)}</TableCell>
                        <TableCell>{formatCurrency(invoice.total_amount)}</TableCell>
                        <TableCell>{getInvoiceStatusBadge(invoice.status)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/invoices/${invoice.id}`)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  Chưa có hóa đơn nào trong tòa nhà này
                </div>
              )}
              </QueryRegion>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <EditBuildingDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        building={building as any}
      />
      </QueryRegion>
    </MainLayout>
  );
};

export default BuildingDetailPage;
