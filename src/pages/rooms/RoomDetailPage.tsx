import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
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
  Home,
  ArrowLeft,
  Pencil,
  Building2,
  FileText,
  Receipt,
  Eye,
  Users,
  Package,
} from 'lucide-react';
import { useRoom } from '@/hooks/useRooms';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { EditRoomDialog } from '@/components/rooms/EditRoomDialog';
import { isContractInEffect } from '@/types/contract';

type Contract = {
  id: string;
  contract_number: string | null;
  start_date: string;
  end_date: string;
  status: string;
  rent_price: number;
  tenant: { id: string; full_name: string; phone: string } | null;
};

type Invoice = {
  id: string;
  invoice_number: string | null;
  due_date: string;
  total_amount: number;
  status: string;
  contract: {
    tenant: { full_name: string } | null;
  } | null;
};

type Tenant = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  status: string;
};

type Asset = {
  id: string;
  name: string;
  asset_code: string | null;
  category: string | null;
  quantity: number;
  condition: string | null;
  value: number | null;
};

const RoomDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [currentTenants, setCurrentTenants] = useState<Tenant[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);

  const { data: room, isLoading: loadingRoom } = useRoom(id || '');

  // Fetch contracts for this room
  useEffect(() => {
    const fetchContracts = async () => {
      if (!id) return;
      setLoadingContracts(true);
      try {
        const { data, error } = await supabase
          .from('contracts')
          .select(`
            id,
            contract_number,
            start_date,
            end_date,
            status,
            rent_price,
            tenant:tenants(id, full_name, phone)
          `)
          .eq('room_id', id)
          .is('deleted_at', null)
          .order('created_at', { ascending: false });

        if (error) throw error;
        setContracts((data || []) as unknown as Contract[]);
      } catch (error) {
        console.error('Error fetching contracts:', error);
      } finally {
        setLoadingContracts(false);
      }
    };

    fetchContracts();
  }, [id]);

  // Fetch current tenants (from active contracts)
  useEffect(() => {
    const fetchTenants = async () => {
      if (!id) return;
      setLoadingTenants(true);
      try {
        const { data, error } = await supabase
          .from('contracts')
          .select(`
            tenant:tenants(id, full_name, phone, email, status)
          `)
          .eq('room_id', id)
          .in('status', ['ACTIVE'])
          .is('deleted_at', null);

        if (error) throw error;
        const tenants = (data || [])
          .map(c => c.tenant)
          .filter(t => t !== null) as Tenant[];
        setCurrentTenants(tenants);
      } catch (error) {
        console.error('Error fetching tenants:', error);
      } finally {
        setLoadingTenants(false);
      }
    };

    fetchTenants();
  }, [id]);

  // Fetch invoices for this room
  useEffect(() => {
    const fetchInvoices = async () => {
      if (!id) return;
      setLoadingInvoices(true);
      try {
        const { data, error } = await supabase
          .from('invoices')
          .select(`
            id,
            invoice_number,
            due_date,
            total_amount,
            status,
            contract:contracts!inner(
              room_id,
              tenant:tenants(full_name)
            )
          `)
          .eq('contract.room_id', id)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        setInvoices((data || []) as unknown as Invoice[]);
      } catch (error) {
        console.error('Error fetching invoices:', error);
      } finally {
        setLoadingInvoices(false);
      }
    };

    fetchInvoices();
  }, [id]);

  // Fetch assets for this room
  useEffect(() => {
    const fetchAssets = async () => {
      if (!id) return;
      setLoadingAssets(true);
      try {
        const { data, error } = await supabase
          .from('assets')
          .select('id, name, code, condition, quantity, purchase_price, category_id')
          .eq('room_id', id)
          .is('deleted_at', null)
          .order('name', { ascending: true });

        if (error) throw error;
        setAssets((data || []).map(a => ({
          id: a.id,
          name: a.name,
          asset_code: a.code,
          category: null,
          quantity: a.quantity || 1,
          condition: a.condition,
          value: a.purchase_price,
        })));
      } catch (error) {
        console.error('Error fetching assets:', error);
      } finally {
        setLoadingAssets(false);
      }
    };

    fetchAssets();
  }, [id]);

  if (loadingRoom) {
    return (
      <MainLayout title="Chi tiết Căn hộ" icon={Home}>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </MainLayout>
    );
  }

  if (!room) {
    return (
      <MainLayout title="Chi tiết Căn hộ" icon={Home}>
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <p className="text-muted-foreground">Không tìm thấy căn hộ</p>
          <Button variant="outline" onClick={() => navigate('/rooms')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      AVAILABLE: 'default',
      OCCUPIED: 'secondary',
      RESERVED: 'outline',
      MAINTENANCE: 'destructive',
      UNAVAILABLE: 'destructive',
    };

    const labels: Record<string, string> = {
      AVAILABLE: 'Trống',
      OCCUPIED: 'Đã thuê',
      RESERVED: 'Đã đặt',
      MAINTENANCE: 'Bảo trì',
      UNAVAILABLE: 'Không khả dụng',
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

  // Get active contract
  const activeContract = contracts.find(c => isContractInEffect(c.status));

  return (
    <MainLayout
      title={`Căn hộ: ${room.name}`}
      subtitle={room.code || undefined}
      icon={Home}
    >
      {/* Header Actions */}
      <div className="flex items-center justify-between mb-6">
        <Button variant="outline" onClick={() => navigate('/rooms')}>
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
            <Home className="h-4 w-4 mr-2" />
            Thông tin chung
          </TabsTrigger>
          <TabsTrigger value="tenants">
            <Users className="h-4 w-4 mr-2" />
            Khách hàng ({currentTenants.length})
          </TabsTrigger>
          <TabsTrigger value="contracts">
            <FileText className="h-4 w-4 mr-2" />
            Hợp đồng ({contracts.length})
          </TabsTrigger>
          <TabsTrigger value="assets">
            <Package className="h-4 w-4 mr-2" />
            Tài sản ({assets.length})
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt className="h-4 w-4 mr-2" />
            Hóa đơn ({invoices.length})
          </TabsTrigger>
        </TabsList>

        {/* General Info Tab */}
        <TabsContent value="general" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Thông tin căn hộ</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tên căn hộ:</span>
                  <span className="font-medium">{room.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mã căn hộ:</span>
                  <span className="font-medium">{room.code || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Trạng thái:</span>
                  {getStatusBadge(room.status)}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tầng:</span>
                  <span className="font-medium">{room.floor || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Diện tích:</span>
                  <span className="font-medium">{room.area ? `${room.area} m²` : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sức chứa:</span>
                  <span className="font-medium">{room.capacity || '-'} người</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Thông tin tài chính</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Giá thuê cơ bản:</span>
                  <span className="font-medium">{room.base_rent ? formatCurrency(room.base_rent) : formatCurrency(room.rent_price)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Giá thuê hiện tại:</span>
                  <span className="font-medium">{formatCurrency(room.rent_price)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tiền cọc:</span>
                  <span className="font-medium">{formatCurrency(room.deposit_amount)}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Amenities */}
          {Array.isArray(room.amenities) && (room.amenities as string[]).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Tiện ích</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {(room.amenities as string[]).map((item: string, idx: number) => (
                    <Badge key={idx} variant="secondary">{item}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Building Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                Thông tin tòa nhà
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tòa nhà:</span>
                <Button
                  variant="link"
                  className="p-0 h-auto font-medium"
                  onClick={() => room.building && navigate(`/buildings/${room.building.id}`)}
                >
                  {(room as any).building?.name || '-'}
                </Button>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mã tòa nhà:</span>
                <span className="font-medium">{(room as any).building?.code || '-'}</span>
              </div>
            </CardContent>
          </Card>

          {/* Current Contract Info */}
          {activeContract && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Hợp đồng hiện tại
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mã hợp đồng:</span>
                  <Button
                    variant="link"
                    className="p-0 h-auto font-medium"
                    onClick={() => navigate(`/contracts/${activeContract.id}`)}
                  >
                    {activeContract.contract_number || activeContract.id.slice(0, 8)}
                  </Button>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Khách hàng:</span>
                  <Button
                    variant="link"
                    className="p-0 h-auto font-medium"
                    onClick={() => activeContract.tenant && navigate(`/tenants/${activeContract.tenant.id}`)}
                  >
                    {activeContract.tenant?.full_name || '-'}
                  </Button>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Thời hạn:</span>
                  <span className="font-medium">
                    {formatDate(activeContract.start_date)} → {formatDate(activeContract.end_date)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Giá thuê:</span>
                  <span className="font-medium">{formatCurrency(activeContract.rent_price)}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Notes */}
          {room.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Ghi chú</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground whitespace-pre-wrap">{room.notes}</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Tenants Tab */}
        <TabsContent value="tenants">
          <Card>
            <CardHeader>
              <CardTitle>Khách hàng hiện tại</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingTenants ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : currentTenants.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Họ tên</TableHead>
                      <TableHead>SĐT</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentTenants.map((tenant) => (
                      <TableRow key={tenant.id}>
                        <TableCell className="font-medium">{tenant.full_name}</TableCell>
                        <TableCell>{tenant.phone}</TableCell>
                        <TableCell>{tenant.email || '-'}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/tenants/${tenant.id}`)}
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
                  Căn hộ chưa có khách hàng
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contracts Tab */}
        <TabsContent value="contracts">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử hợp đồng</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingContracts ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : contracts.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã HĐ</TableHead>
                      <TableHead>Khách hàng</TableHead>
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
                  Chưa có hợp đồng nào cho căn hộ này
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Assets Tab */}
        <TabsContent value="assets">
          <Card>
            <CardHeader>
              <CardTitle>Tài sản trong căn hộ</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingAssets ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : assets.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã tài sản</TableHead>
                      <TableHead>Tên tài sản</TableHead>
                      <TableHead className="text-right">Số lượng</TableHead>
                      <TableHead>Tình trạng</TableHead>
                      <TableHead className="text-right">Giá trị</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assets.map((asset) => (
                      <TableRow key={asset.id}>
                        <TableCell className="font-medium">
                          {asset.asset_code || '-'}
                        </TableCell>
                        <TableCell>{asset.name}</TableCell>
                        <TableCell className="text-right">{asset.quantity}</TableCell>
                        <TableCell>
                          <Badge variant={asset.condition === 'GOOD' ? 'default' : asset.condition === 'DAMAGED' ? 'destructive' : 'secondary'}>
                            {asset.condition === 'GOOD' ? 'Tốt' : asset.condition === 'DAMAGED' ? 'Hỏng' : asset.condition === 'FAIR' ? 'Bình thường' : asset.condition || '-'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {asset.value ? formatCurrency(asset.value) : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  Chưa có tài sản nào trong căn hộ này
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invoices Tab */}
        <TabsContent value="invoices">
          <Card>
            <CardHeader>
              <CardTitle>Hóa đơn của căn hộ</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingInvoices ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : invoices.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã hóa đơn</TableHead>
                      <TableHead>Khách hàng</TableHead>
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
                  Chưa có hóa đơn nào cho căn hộ này
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <EditRoomDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        room={room as any}
      />
    </MainLayout>
  );
};

export default RoomDetailPage;
