import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  User,
  ArrowLeft,
  Phone,
  Mail,
  CreditCard,
  MapPin,
  Calendar,
  FileText,
  Receipt,
  Car,
  ExternalLink,
  Edit,
  AlertTriangle,
} from 'lucide-react';
import { useTenant } from '@/hooks/useTenants';
import { useContractsLegacy } from '@/hooks/useContracts';
import { useInvoicesLegacy } from '@/hooks/useInvoices';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Vehicle type
interface Vehicle {
  id: string;
  vehicle_type: string;
  license_plate: string;
  brand?: string;
  model?: string;
  color?: string;
  parking_fee?: number;
}

const TenantDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Fetch tenant data
  const { data: tenant, isLoading: tenantLoading } = useTenant(id || '');

  // Fetch contracts for this tenant
  const { data: contracts, isLoading: contractsLoading } = useContractsLegacy({
    tenant_id: id
  });

  // Fetch vehicles for this tenant
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);

  // Fetch all invoices related to tenant's contracts
  const [allInvoices, setAllInvoices] = useState<any[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);

  // Fetch vehicles when tenant ID changes
  useEffect(() => {
    const fetchVehicles = async () => {
      if (!id) return;
      setVehiclesLoading(true);
      try {
        const { data, error } = await supabase
          .from('vehicles')
          .select('*')
          .eq('tenant_id', id)
          .is('deleted_at', null);

        if (!error && data) {
          setVehicles(data);
        }
      } catch (e) {
        console.error('Error fetching vehicles:', e);
      } finally {
        setVehiclesLoading(false);
      }
    };

    fetchVehicles();
  }, [id]);

  // Fetch invoices when contracts are loaded
  useEffect(() => {
    const fetchInvoices = async () => {
      if (!contracts || contracts.length === 0) {
        setAllInvoices([]);
        setInvoicesLoading(false);
        return;
      }

      setInvoicesLoading(true);
      try {
        const contractIds = contracts.map(c => c.id);
        const { data, error } = await supabase
          .from('invoices')
          .select(`
            *,
            contract:contracts!invoices_contract_id_fkey (
              id, contract_number
            ),
            payments(*)
          `)
          .in('contract_id', contractIds)
          .is('deleted_at', null)
          .order('created_at', { ascending: false });

        if (!error && data) {
          setAllInvoices(data);
        }
      } catch (e) {
        console.error('Error fetching invoices:', e);
      } finally {
        setInvoicesLoading(false);
      }
    };

    fetchInvoices();
  }, [contracts]);

  // Helper functions
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      ACTIVE: { variant: 'default', label: 'Đang thuê' },
      INACTIVE: { variant: 'outline', label: 'Đã rời đi' },
      PENDING: { variant: 'secondary', label: 'Chờ xử lý' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getContractStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string; className?: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      ACTIVE: { variant: 'default', label: 'Đang hoạt động', className: 'bg-green-500' },
      EXTENDED: { variant: 'secondary', label: 'Đã gia hạn', className: 'bg-blue-500 text-white' },
      TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng', className: 'bg-purple-500 text-white' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      EXPIRED: { variant: 'outline', label: 'Hết hạn' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getInvoiceStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      APPROVED: { variant: 'default', label: 'Đã duyệt' },
      PARTIAL_PAID: { variant: 'secondary', label: 'Trả 1 phần' },
      PAID: { variant: 'default', label: 'Đã thanh toán' },
      OVERDUE: { variant: 'destructive', label: 'Quá hạn' },
      CANCELLED: { variant: 'destructive', label: 'Đã hủy' },
    };
    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getGenderLabel = (gender: string | null) => {
    if (!gender) return 'Không xác định';
    const labels: Record<string, string> = {
      MALE: 'Nam',
      FEMALE: 'Nữ',
      OTHER: 'Khác',
    };
    return labels[gender] || gender;
  };

  const getVehicleTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      MOTORBIKE: 'Xe máy',
      CAR: 'Ô tô',
      BICYCLE: 'Xe đạp',
      ELECTRIC_BIKE: 'Xe điện',
      OTHER: 'Khác',
    };
    return labels[type] || type;
  };

  // Error states
  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy khách thuê" icon={User}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID khách thuê không hợp lệ</p>
          <Button onClick={() => navigate('/tenants')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (tenantLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={User}>
        <div className="text-center py-12 text-gray-500">
          Đang tải thông tin khách thuê...
        </div>
      </MainLayout>
    );
  }

  if (!tenant) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Khách thuê không tồn tại" icon={User}>
        <div className="text-center py-12">
          <p className="text-gray-500">Không tìm thấy khách thuê với ID này</p>
          <Button onClick={() => navigate('/tenants')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  // Calculate financial summary
  const totalInvoiced = allInvoices.reduce((sum, inv) => sum + (inv.total_amount || 0), 0);
  const totalPaid = allInvoices.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0);
  const outstandingAmount = totalInvoiced - totalPaid;

  // Count contracts by status
  const activeContracts = contracts?.filter(c => c.status === 'ACTIVE').length || 0;
  const totalContracts = contracts?.length || 0;

  return (
    <MainLayout
      title={tenant.full_name}
      subtitle="Chi tiết khách thuê"
      icon={User}
    >
      {/* Header Actions */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button
          variant="outline"
          onClick={() => navigate('/tenants')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>

        <div className="flex-1" />

        <Button variant="outline">
          <Edit className="h-4 w-4 mr-2" />
          Chỉnh sửa
        </Button>
      </div>

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="general">Thông tin chung</TabsTrigger>
          <TabsTrigger value="contracts">Hợp đồng ({totalContracts})</TabsTrigger>
          <TabsTrigger value="invoices">Hóa đơn ({allInvoices.length})</TabsTrigger>
          <TabsTrigger value="vehicles">Phương tiện ({vehicles.length})</TabsTrigger>
        </TabsList>

        {/* Tab 1: General Information */}
        <TabsContent value="general" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Personal Info */}
            <div className="lg:col-span-2 space-y-6">
              {/* Personal Information Card */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <User className="h-5 w-5" />
                      Thông tin cá nhân
                    </CardTitle>
                    {getStatusBadge(tenant.status || 'ACTIVE')}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600">Họ và tên</div>
                      <div className="font-medium">{tenant.full_name}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Giới tính</div>
                      <div className="font-medium">{getGenderLabel(tenant.gender)}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Ngày sinh
                      </div>
                      <div className="font-medium">
                        {tenant.date_of_birth
                          ? format(new Date(tenant.date_of_birth), 'dd/MM/yyyy', { locale: vi })
                          : 'N/A'
                        }
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <CreditCard className="h-3 w-3" />
                        Loại giấy tờ
                      </div>
                      <div className="font-medium">
                        {tenant.id_type === 'CCCD' ? 'CCCD' : tenant.id_type === 'CMND' ? 'CMND' : tenant.id_type || 'N/A'}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <CreditCard className="h-3 w-3" />
                        Số CCCD/CMND
                      </div>
                      <div className="font-medium">{tenant.id_number || 'N/A'}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Ngày cấp</div>
                      <div className="font-medium">
                        {tenant.id_issue_date
                          ? format(new Date(tenant.id_issue_date), 'dd/MM/yyyy', { locale: vi })
                          : 'N/A'
                        }
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-gray-600">Nơi cấp</div>
                      <div className="font-medium">{tenant.id_issue_place || 'N/A'}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Contact Information Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Phone className="h-5 w-5" />
                    Thông tin liên hệ
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        Số điện thoại
                      </div>
                      <div className="font-medium">{tenant.phone || 'N/A'}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        Email
                      </div>
                      <div className="font-medium">{tenant.email || 'N/A'}</div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-gray-600 flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        Địa chỉ thường trú
                      </div>
                      <div className="font-medium">{tenant.permanent_address || 'N/A'}</div>
                    </div>
                  </div>

                  {/* Emergency Contact */}
                  {(tenant.emergency_contact_name || tenant.emergency_contact_phone) && (
                    <div className="pt-4 border-t">
                      <div className="text-sm font-medium text-gray-700 mb-2">Liên hệ khẩn cấp</div>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <div className="text-gray-600">Họ tên</div>
                          <div className="font-medium">{tenant.emergency_contact_name || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-gray-600">Số điện thoại</div>
                          <div className="font-medium">{tenant.emergency_contact_phone || 'N/A'}</div>
                        </div>
                        {tenant.emergency_contact_relationship && (
                          <div>
                            <div className="text-gray-600">Mối quan hệ</div>
                            <div className="font-medium">{tenant.emergency_contact_relationship}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Notes Card */}
              {tenant.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle>Ghi chú</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm bg-gray-50 p-3 rounded">{tenant.notes}</div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right Column - Summary */}
            <div className="space-y-6">
              {/* Contract Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Hợp đồng
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tổng số hợp đồng:</span>
                    <span className="font-medium">{totalContracts}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Đang hoạt động:</span>
                    <span className="font-medium text-green-600">{activeContracts}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Financial Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Receipt className="h-5 w-5" />
                    Tài chính
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tổng hóa đơn:</span>
                      <span className="font-medium">{allInvoices.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tổng phát sinh:</span>
                      <span className="font-bold">{formatCurrency(totalInvoiced)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Đã thanh toán:</span>
                      <span className="font-medium text-green-600">{formatCurrency(totalPaid)}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between">
                      <span className="text-gray-900 font-medium">Công nợ:</span>
                      <span className={`font-bold text-lg ${outstandingAmount > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {formatCurrency(outstandingAmount)}
                      </span>
                    </div>
                  </div>

                  {outstandingAmount > 0 && (
                    <div className="flex items-center gap-2 p-3 bg-red-50 rounded-lg text-sm text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      <span>Còn công nợ cần thu</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Vehicles Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Car className="h-5 w-5" />
                    Phương tiện
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Số phương tiện:</span>
                    <span className="font-medium">{vehicles.length}</span>
                  </div>
                  {vehicles.length > 0 && (
                    <div className="pt-2 border-t">
                      {vehicles.slice(0, 3).map(v => (
                        <div key={v.id} className="flex justify-between text-xs py-1">
                          <span>{getVehicleTypeLabel(v.vehicle_type)}</span>
                          <span className="font-medium">{v.license_plate}</span>
                        </div>
                      ))}
                      {vehicles.length > 3 && (
                        <div className="text-xs text-gray-500 mt-1">
                          +{vehicles.length - 3} phương tiện khác
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Created/Updated Info */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Thông tin hệ thống</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-gray-500">
                  <div className="flex justify-between">
                    <span>Ngày tạo:</span>
                    <span>
                      {tenant.created_at
                        ? format(new Date(tenant.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })
                        : 'N/A'
                      }
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Cập nhật:</span>
                    <span>
                      {tenant.updated_at
                        ? format(new Date(tenant.updated_at), 'dd/MM/yyyy HH:mm', { locale: vi })
                        : 'N/A'
                      }
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Tab 2: Contracts */}
        <TabsContent value="contracts">
          <Card>
            <CardHeader>
              <CardTitle>Danh sách hợp đồng</CardTitle>
              <CardDescription>
                Tất cả hợp đồng của khách thuê ({contracts?.length || 0} hợp đồng)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {contractsLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : !contracts || contracts.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có hợp đồng nào
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Số hợp đồng</TableHead>
                      <TableHead>Phòng</TableHead>
                      <TableHead>Ngày bắt đầu</TableHead>
                      <TableHead>Ngày kết thúc</TableHead>
                      <TableHead className="text-right">Giá thuê</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contracts.map((contract) => (
                      <TableRow key={contract.id}>
                        <TableCell className="font-medium">
                          {contract.contract_number || contract.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>
                          {contract.room?.name || contract.bed?.name || 'N/A'}
                        </TableCell>
                        <TableCell>
                          {format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })}
                        </TableCell>
                        <TableCell>
                          {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(contract.rent_price || 0)}
                        </TableCell>
                        <TableCell>
                          {getContractStatusBadge(contract.status)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/contracts/${contract.id}`)}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Invoices */}
        <TabsContent value="invoices">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử hóa đơn</CardTitle>
              <CardDescription>
                Tất cả hóa đơn của khách thuê ({allInvoices.length} hóa đơn)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invoicesLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : allInvoices.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có hóa đơn nào
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Số hóa đơn</TableHead>
                      <TableHead>Hợp đồng</TableHead>
                      <TableHead>Kỳ thanh toán</TableHead>
                      <TableHead className="text-right">Tổng tiền</TableHead>
                      <TableHead className="text-right">Đã thu</TableHead>
                      <TableHead className="text-right">Còn lại</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allInvoices.map((invoice) => {
                      const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
                      return (
                        <TableRow key={invoice.id}>
                          <TableCell className="font-medium">
                            {invoice.title || invoice.invoice_number || invoice.id.slice(0, 8)}
                          </TableCell>
                          <TableCell>
                            {invoice.contract?.contract_number || 'N/A'}
                          </TableCell>
                          <TableCell>
                            {invoice.billing_period_start && invoice.billing_period_end && (
                              <>
                                {format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })}
                                {' - '}
                                {format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(invoice.total_amount || 0)}
                          </TableCell>
                          <TableCell className="text-right text-green-600">
                            {formatCurrency(invoice.paid_amount || 0)}
                          </TableCell>
                          <TableCell className={`text-right ${remaining > 0 ? 'text-orange-600' : ''}`}>
                            {formatCurrency(remaining)}
                          </TableCell>
                          <TableCell>
                            {getInvoiceStatusBadge(invoice.status)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/invoices/${invoice.id}`)}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 4: Vehicles */}
        <TabsContent value="vehicles">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Phương tiện đã đăng ký</CardTitle>
                  <CardDescription>
                    Danh sách phương tiện của khách thuê ({vehicles.length} phương tiện)
                  </CardDescription>
                </div>
                <Button variant="outline" onClick={() => navigate('/vehicles')}>
                  <Car className="h-4 w-4 mr-2" />
                  Quản lý
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {vehiclesLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : vehicles.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa đăng ký phương tiện nào
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Loại xe</TableHead>
                      <TableHead>Biển số</TableHead>
                      <TableHead>Hãng</TableHead>
                      <TableHead>Màu sắc</TableHead>
                      <TableHead className="text-right">Phí gửi xe</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vehicles.map((vehicle) => (
                      <TableRow key={vehicle.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Car className="h-4 w-4 text-gray-500" />
                            {getVehicleTypeLabel(vehicle.vehicle_type)}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {vehicle.license_plate}
                        </TableCell>
                        <TableCell>
                          {vehicle.brand || '-'} {vehicle.model || ''}
                        </TableCell>
                        <TableCell>{vehicle.color || '-'}</TableCell>
                        <TableCell className="text-right">
                          {vehicle.parking_fee ? formatCurrency(vehicle.parking_fee) : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </MainLayout>
  );
};

export default TenantDetailPage;
