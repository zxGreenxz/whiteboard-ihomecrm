import { useState } from 'react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  FileText,
  ArrowLeft,
  RefreshCw,
  ArrowRightLeft,
  XCircle,
  Info,
  Calendar,
  User,
  Home,
  DollarSign,
  FileCheck,
  Receipt,
  History,
} from 'lucide-react';
import { useContract } from '@/hooks/useContracts';
import { useInvoices } from '@/hooks/useInvoices';
import { usePayments } from '@/hooks/usePayments';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import ExtendContractDialog from '@/components/contracts/ExtendContractDialog';
import TransferContractDialog from '@/components/contracts/TransferContractDialog';
import TerminateContractDialog from '@/components/contracts/TerminateContractDialog';

const ContractDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('general');

  // Dialog states
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);

  const { data: contract, isLoading } = useContract(id || '');

  // Get contract services
  const { data: contractServices } = useQuery({
    queryKey: ['contract_services', id],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await supabase
        .from('contract_services')
        .select(`
          *,
          service:services!contract_services_service_id_fkey (
            id, name, type, unit
          )
        `)
        .eq('contract_id', id);
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Get invoices for this contract
  const { data: allInvoices } = useInvoices();
  const contractInvoices = allInvoices?.filter((inv) => inv.contract_id === id);

  // Get payments for this contract
  const { data: allPayments } = usePayments();
  const contractPayments = allPayments?.filter(
    (payment) => payment.invoice?.contract?.id === id
  );

  // Get contract history (extensions, transfers, etc.)
  const { data: contractHistory } = useQuery({
    queryKey: ['contract_history', id],
    queryFn: async () => {
      if (!id) return [];

      // Get contracts that are related to this one
      const { data, error } = await supabase
        .from('contracts')
        .select(`
          *,
          tenant:tenants!contracts_tenant_id_fkey (full_name),
          room:rooms!contracts_room_id_fkey (name),
          bed:beds!contracts_bed_id_fkey (name)
        `)
        .or(`parent_contract_id.eq.${id},id.eq.${id}`)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy hợp đồng" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID hợp đồng không hợp lệ</p>
          <Button onClick={() => navigate('/contracts')} className="mt-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (isLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={FileText}>
        <div className="text-center py-12 text-gray-500">
          Đang tải thông tin hợp đồng...
        </div>
      </MainLayout>
    );
  }

  if (!contract) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Hợp đồng không tồn tại" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-gray-500">Không tìm thấy hợp đồng với ID này</p>
          <Button onClick={() => navigate('/contracts')} className="mt-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      ACTIVE: { variant: 'default', label: 'Đang hiệu lực' },
      PENDING: { variant: 'outline', label: 'Chờ kích hoạt' },
      EXPIRED: { variant: 'destructive', label: 'Hết hạn' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      EXTENDED: { variant: 'secondary', label: 'Đã gia hạn' },
      TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getPaymentCycleLabel = (cycle: string) => {
    const labels: Record<string, string> = {
      MONTHLY: 'Hàng tháng',
      QUARTERLY: 'Hàng quý (3 tháng)',
      SEMI_ANNUALLY: 'Nửa năm (6 tháng)',
      ANNUALLY: 'Hàng năm',
    };
    return labels[cycle] || cycle;
  };

  const roomOrBed = contract.room?.name || contract.bed?.name || 'N/A';
  const buildingName = contract.room?.building?.name || contract.bed?.room?.building?.name || 'N/A';
  const totalInvoiceAmount = contractInvoices?.reduce((sum, inv) => sum + inv.total_amount, 0) || 0;
  const totalPaidAmount = contractPayments?.reduce((sum, pay) => sum + pay.amount, 0) || 0;

  return (
    <MainLayout
      title={`Hợp đồng: ${contract.contract_number || contract.id.slice(0, 8)}`}
      subtitle={`${contract.tenant?.full_name} - ${roomOrBed}`}
      icon={FileText}
    >
      {/* Header Actions */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Button variant="outline" onClick={() => navigate('/contracts')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>

        {contract.status === 'ACTIVE' && (
          <>
            <Button
              variant="outline"
              onClick={() => setExtendDialogOpen(true)}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Gia hạn
            </Button>
            <Button
              variant="outline"
              onClick={() => setTransferDialogOpen(true)}
            >
              <ArrowRightLeft className="h-4 w-4 mr-2" />
              Chuyển nhượng
            </Button>
            <Button
              variant="destructive"
              onClick={() => setTerminateDialogOpen(true)}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Thanh lý
            </Button>
          </>
        )}
      </div>

      {/* Status Alert */}
      {contract.status !== 'ACTIVE' && (
        <Alert className="mb-6">
          <Info className="h-4 w-4" />
          <AlertDescription>
            Hợp đồng này có trạng thái: {getStatusBadge(contract.status)}.
            {contract.status === 'EXTENDED' && ' Đã được gia hạn sang hợp đồng mới.'}
            {contract.status === 'TERMINATED' && ' Đã bị thanh lý.'}
            {contract.status === 'EXPIRED' && ' Đã hết hạn.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="general">
            <Info className="h-4 w-4 mr-2" />
            Thông tin chung
          </TabsTrigger>
          <TabsTrigger value="services">
            <FileCheck className="h-4 w-4 mr-2" />
            Dịch vụ ({contractServices?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt className="h-4 w-4 mr-2" />
            Hóa đơn ({contractInvoices?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="payments">
            <DollarSign className="h-4 w-4 mr-2" />
            Thanh toán ({contractPayments?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="h-4 w-4 mr-2" />
            Lịch sử
          </TabsTrigger>
        </TabsList>

        {/* Tab: Thông tin chung */}
        <TabsContent value="general" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Thông tin cơ bản */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Thông tin hợp đồng
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Số hợp đồng:</span>
                  <span className="font-semibold">{contract.contract_number || 'Chưa có'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Trạng thái:</span>
                  {getStatusBadge(contract.status)}
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Ngày ký:</span>
                  <span>{format(new Date(contract.signed_date), 'dd/MM/yyyy', { locale: vi })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Ngày bắt đầu:</span>
                  <span>{format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Ngày kết thúc:</span>
                  <span>{format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Chu kỳ thanh toán:</span>
                  <span>{getPaymentCycleLabel(contract.payment_cycle)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Thông tin khách thuê */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Thông tin khách thuê
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Họ tên:</span>
                  <span className="font-semibold">{contract.tenant?.full_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Số điện thoại:</span>
                  <span>{contract.tenant?.phone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Email:</span>
                  <span>{contract.tenant?.email || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">CMND/CCCD:</span>
                  <span>{contract.tenant?.id_number || 'N/A'}</span>
                </div>
              </CardContent>
            </Card>

            {/* Thông tin phòng */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5" />
                  Thông tin phòng
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Tòa nhà:</span>
                  <span className="font-semibold">{buildingName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Phòng/Giường:</span>
                  <span className="font-semibold">{roomOrBed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Giá thuê:</span>
                  <span className="font-semibold text-green-600">{formatCurrency(contract.rent_price)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Thông tin tài chính */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Thông tin tài chính
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Tổng tiền cọc:</span>
                  <span className="font-semibold">{formatCurrency(contract.total_deposit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Đã đặt cọc:</span>
                  <span>{formatCurrency(contract.deposit_paid || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Còn lại:</span>
                  <span className="text-orange-600">
                    {formatCurrency(contract.total_deposit - (contract.deposit_paid || 0))}
                  </span>
                </div>
                <div className="pt-3 border-t">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tổng hóa đơn:</span>
                    <span className="font-semibold">{formatCurrency(totalInvoiceAmount)}</span>
                  </div>
                  <div className="flex justify-between mt-2">
                    <span className="text-gray-600">Đã thanh toán:</span>
                    <span className="text-green-600">{formatCurrency(totalPaidAmount)}</span>
                  </div>
                  <div className="flex justify-between mt-2">
                    <span className="text-gray-600">Công nợ:</span>
                    <span className="text-red-600 font-semibold">
                      {formatCurrency(totalInvoiceAmount - totalPaidAmount)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Ghi chú */}
          {contract.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Ghi chú</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-700 whitespace-pre-wrap">{contract.notes}</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Tab: Dịch vụ */}
        <TabsContent value="services">
          <Card>
            <CardHeader>
              <CardTitle>Dịch vụ đăng ký</CardTitle>
              <CardDescription>
                Danh sách các dịch vụ được sử dụng trong hợp đồng này
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!contractServices || contractServices.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có dịch vụ nào được đăng ký
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tên dịch vụ</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Đơn giá</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>Chỉ số ban đầu</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractServices.map((cs: any) => (
                      <TableRow key={cs.id}>
                        <TableCell className="font-medium">{cs.service?.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {cs.service?.type === 'METER_READING' ? 'Theo chỉ số' :
                             cs.service?.type === 'PER_PERSON' ? 'Theo người' :
                             cs.service?.type === 'PER_ROOM' ? 'Theo phòng' : 'Cố định'}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatCurrency(cs.unit_price)}</TableCell>
                        <TableCell>{cs.service?.unit || '-'}</TableCell>
                        <TableCell>{cs.initial_reading || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Hóa đơn */}
        <TabsContent value="invoices">
          <Card>
            <CardHeader>
              <CardTitle>Hóa đơn</CardTitle>
              <CardDescription>
                Danh sách hóa đơn phát sinh từ hợp đồng này
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!contractInvoices || contractInvoices.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có hóa đơn nào được tạo
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Số HĐ</TableHead>
                      <TableHead>Tiêu đề</TableHead>
                      <TableHead>Kỳ thanh toán</TableHead>
                      <TableHead>Tổng tiền</TableHead>
                      <TableHead>Đã thu</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractInvoices.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell className="font-medium">
                          {invoice.invoice_number || invoice.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>{invoice.title}</TableCell>
                        <TableCell>
                          {invoice.billing_period_start && invoice.billing_period_end
                            ? `${format(new Date(invoice.billing_period_start), 'dd/MM')} - ${format(new Date(invoice.billing_period_end), 'dd/MM/yyyy')}`
                            : '-'}
                        </TableCell>
                        <TableCell>{formatCurrency(invoice.total_amount)}</TableCell>
                        <TableCell className="text-green-600">
                          {formatCurrency(invoice.paid_amount || 0)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              invoice.status === 'PAID'
                                ? 'default'
                                : invoice.status === 'OVERDUE'
                                ? 'destructive'
                                : 'outline'
                            }
                          >
                            {invoice.status === 'PAID' ? 'Đã thanh toán' :
                             invoice.status === 'PARTIAL_PAID' ? 'Trả 1 phần' :
                             invoice.status === 'OVERDUE' ? 'Quá hạn' :
                             invoice.status === 'APPROVED' ? 'Đã duyệt' : 'Nháp'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => navigate(`/invoices/${invoice.id}`)}
                          >
                            Xem chi tiết
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

        {/* Tab: Thanh toán */}
        <TabsContent value="payments">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử thanh toán</CardTitle>
              <CardDescription>
                Danh sách các khoản thanh toán đã nhận từ hợp đồng này
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!contractPayments || contractPayments.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có thanh toán nào
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày thu</TableHead>
                      <TableHead>Số phiếu thu</TableHead>
                      <TableHead>Hóa đơn</TableHead>
                      <TableHead>Số tiền</TableHead>
                      <TableHead>Phương thức</TableHead>
                      <TableHead>Ghi chú</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractPayments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell>
                          {format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })}
                        </TableCell>
                        <TableCell className="font-medium">
                          {payment.receipt_number || payment.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>{payment.invoice?.title || '-'}</TableCell>
                        <TableCell className="text-green-600 font-semibold">
                          {formatCurrency(payment.amount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {payment.payment_method === 'CASH' ? 'Tiền mặt' :
                             payment.payment_method === 'BANK_TRANSFER' ? 'Chuyển khoản' :
                             payment.payment_method === 'CARD' ? 'Thẻ' : payment.payment_method}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-gray-600 text-sm">
                          {payment.notes || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Lịch sử */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử hợp đồng</CardTitle>
              <CardDescription>
                Các thay đổi và phiên bản của hợp đồng này
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!contractHistory || contractHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có lịch sử thay đổi
                </div>
              ) : (
                <div className="space-y-4">
                  {contractHistory.map((item: any) => (
                    <div
                      key={item.id}
                      className={`border-l-4 pl-4 py-3 ${
                        item.id === id ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold">
                          {item.contract_number || item.id.slice(0, 8)}
                          {item.id === id && <Badge className="ml-2">Hiện tại</Badge>}
                        </span>
                        {getStatusBadge(item.status)}
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        <div>Khách thuê: {item.tenant?.full_name}</div>
                        <div>Phòng: {item.room?.name || item.bed?.name}</div>
                        <div>
                          Thời gian: {format(new Date(item.start_date), 'dd/MM/yyyy')} -{' '}
                          {format(new Date(item.end_date), 'dd/MM/yyyy')}
                        </div>
                        <div>Giá thuê: {formatCurrency(item.rent_price)}/tháng</div>
                        {item.notes && (
                          <div className="mt-2 text-gray-500 italic">Ghi chú: {item.notes}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      {contract && (
        <>
          <ExtendContractDialog
            open={extendDialogOpen}
            onOpenChange={setExtendDialogOpen}
            contract={contract}
          />
          <TransferContractDialog
            open={transferDialogOpen}
            onOpenChange={setTransferDialogOpen}
            contract={contract}
          />
          <TerminateContractDialog
            open={terminateDialogOpen}
            onOpenChange={setTerminateDialogOpen}
            contract={contract}
          />
        </>
      )}
    </MainLayout>
  );
};

export default ContractDetailPage;
