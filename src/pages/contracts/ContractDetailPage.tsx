import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { FileText, ArrowLeft, Edit, CheckCircle2, XCircle } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { useContract } from '@/hooks/useContracts';
import { useInvoices } from '@/hooks/useInvoices';
import { usePayments } from '@/hooks/usePayments';
import ExtendContractDialog from '@/components/contracts/ExtendContractDialog';
import TransferContractDialog from '@/components/contracts/TransferContractDialog';
import TerminateContractDialog from '@/components/contracts/TerminateContractDialog';

// =============================================
// Contract Detail Page - Chi tiết hợp đồng
// =============================================

const ContractDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);

  const { data: contract, isLoading } = useContract(id || '');
  const { data: invoices = [] } = useInvoices({ contract_id: id });
  const { data: payments = [] } = usePayments({ contract_id: id });

  // Loading state
  if (isLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={FileText}>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </MainLayout>
    );
  }

  // Error state
  if (!id || !contract) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Hợp đồng không tồn tại" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Không tìm thấy hợp đồng với ID này</p>
          <Button onClick={() => navigate('/contracts')} className="mt-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  // Helper functions
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'N/A';
    return format(new Date(date), 'dd/MM/yyyy', { locale: vi });
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      ACTIVE: { variant: 'default', label: 'Đang hiệu lực' },
      EXPIRED: { variant: 'secondary', label: 'Hết hạn' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      CANCELLED: { variant: 'destructive', label: 'Đã hủy' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant as any}>{config.label}</Badge>;
  };

  const getPaymentCycleLabel = (cycle: string) => {
    const labels: Record<string, string> = {
      MONTHLY: 'Hàng tháng',
      QUARTERLY: 'Hàng quý',
      SEMI_ANNUAL: 'Nửa năm',
      ANNUAL: 'Hàng năm',
    };
    return labels[cycle] || cycle;
  };

  // Calculate stats
  const totalInvoiced = invoices.reduce((sum, inv: any) => sum + (inv.total_amount || 0), 0);
  const totalPaid = payments.reduce((sum, pay: any) => sum + (pay.amount || 0), 0);
  const totalDebt = totalInvoiced - totalPaid;

  // Render location
  const location = contract.room
    ? `${contract.room.building?.name} - ${contract.room.name}`
    : contract.bed
    ? `${contract.bed.room?.building?.name} - ${contract.bed.room?.name} - ${contract.bed.name}`
    : 'N/A';

  return (
    <MainLayout
      title={contract.contract_number || 'Chi tiết hợp đồng'}
      subtitle={`Hợp đồng của ${contract.tenant?.full_name || 'N/A'}`}
      icon={FileText}
    >
      <div className="space-y-6">
        {/* Header Actions */}
        <div className="flex items-center justify-between">
          <Button variant="outline" onClick={() => navigate('/contracts')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại
          </Button>

          <div className="flex gap-2">
            {contract.status === 'ACTIVE' && (
              <>
                <Button variant="outline" onClick={() => setExtendDialogOpen(true)}>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Gia hạn
                </Button>
                <Button variant="outline" onClick={() => setTransferDialogOpen(true)}>
                  <Edit className="h-4 w-4 mr-2" />
                  Chuyển nhượng
                </Button>
                <Button variant="destructive" onClick={() => setTerminateDialogOpen(true)}>
                  <XCircle className="h-4 w-4 mr-2" />
                  Thanh lý
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Status Alert */}
        {contract.status === 'TERMINATED' && (
          <Alert>
            <AlertDescription>
              Hợp đồng này đã được thanh lý vào ngày {formatDate(contract.actual_move_out_date)}.
              {contract.termination_reason && ` Lý do: ${contract.termination_reason}`}
            </AlertDescription>
          </Alert>
        )}

        {/* Tabs */}
        <Tabs defaultValue="info" className="space-y-4">
          <TabsList>
            <TabsTrigger value="info">Thông tin chung</TabsTrigger>
            <TabsTrigger value="services">Dịch vụ</TabsTrigger>
            <TabsTrigger value="invoices">Hóa đơn</TabsTrigger>
            <TabsTrigger value="payments">Thanh toán</TabsTrigger>
            <TabsTrigger value="history">Lịch sử</TabsTrigger>
          </TabsList>

          {/* Tab 1: Thông tin chung */}
          <TabsContent value="info" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {/* Contract Info */}
              <Card>
                <CardHeader>
                  <CardTitle>Thông tin hợp đồng</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Số hợp đồng:</span>
                    <span className="text-sm font-medium">{contract.contract_number || 'N/A'}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Trạng thái:</span>
                    <div>{getStatusBadge(contract.status || 'DRAFT')}</div>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Ngày ký:</span>
                    <span className="text-sm">{formatDate(contract.signed_date)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Ngày bắt đầu:</span>
                    <span className="text-sm">{formatDate(contract.start_date)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Ngày kết thúc:</span>
                    <span className="text-sm">{formatDate(contract.end_date)}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Chu kỳ thanh toán:</span>
                    <span className="text-sm">{getPaymentCycleLabel(contract.payment_cycle || 'MONTHLY')}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Tenant & Location Info */}
              <Card>
                <CardHeader>
                  <CardTitle>Khách thuê & Vị trí</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Khách thuê:</span>
                    <span className="text-sm font-medium">{contract.tenant?.full_name || 'N/A'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Số điện thoại:</span>
                    <span className="text-sm">{contract.tenant?.phone || 'N/A'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Email:</span>
                    <span className="text-sm">{contract.tenant?.email || 'N/A'}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Vị trí:</span>
                    <span className="text-sm font-medium">{location}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Financial Info */}
              <Card>
                <CardHeader>
                  <CardTitle>Thông tin tài chính</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Giá thuê:</span>
                    <span className="text-sm font-bold text-primary">{formatCurrency(contract.rent_price || 0)}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Tổng tiền cọc:</span>
                    <span className="text-sm">{formatCurrency(contract.total_deposit || 0)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Đã đóng cọc:</span>
                    <span className="text-sm">{formatCurrency(contract.deposit_paid || 0)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Còn lại cọc:</span>
                    <span className="text-sm text-destructive">
                      {formatCurrency((contract.total_deposit || 0) - (contract.deposit_paid || 0))}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Stats Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Tổng hợp</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Tổng hóa đơn:</span>
                    <span className="text-sm">{formatCurrency(totalInvoiced)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Đã thanh toán:</span>
                    <span className="text-sm text-green-600">{formatCurrency(totalPaid)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Công nợ:</span>
                    <span className="text-sm font-bold text-destructive">{formatCurrency(totalDebt)}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Số hóa đơn:</span>
                    <span className="text-sm">{invoices.length}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="text-sm text-muted-foreground">Số thanh toán:</span>
                    <span className="text-sm">{payments.length}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Notes */}
            {contract.notes && (
              <Card>
                <CardHeader>
                  <CardTitle>Ghi chú</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{contract.notes}</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Tab 2: Dịch vụ */}
          <TabsContent value="services">
            <Card>
              <CardHeader>
                <CardTitle>Dịch vụ trong hợp đồng</CardTitle>
                <CardDescription>
                  Danh sách các dịch vụ áp dụng cho hợp đồng này
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!contract.contract_services || contract.contract_services.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Chưa có dịch vụ nào
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Dịch vụ</TableHead>
                        <TableHead>Loại</TableHead>
                        <TableHead>Đơn vị</TableHead>
                        <TableHead className="text-right">Đơn giá</TableHead>
                        <TableHead className="text-right">Chỉ số ban đầu</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contract.contract_services.map((cs: any) => (
                        <TableRow key={cs.id}>
                          <TableCell className="font-medium">{cs.service?.name || 'N/A'}</TableCell>
                          <TableCell>{cs.service?.type || 'N/A'}</TableCell>
                          <TableCell>{cs.service?.unit || 'N/A'}</TableCell>
                          <TableCell className="text-right">{formatCurrency(cs.unit_price || 0)}</TableCell>
                          <TableCell className="text-right">{cs.initial_reading ?? 'N/A'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 3: Hóa đơn */}
          <TabsContent value="invoices">
            <Card>
              <CardHeader>
                <CardTitle>Hóa đơn ({invoices.length})</CardTitle>
                <CardDescription>
                  Danh sách hóa đơn thuộc hợp đồng này
                </CardDescription>
              </CardHeader>
              <CardContent>
                {invoices.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Chưa có hóa đơn nào
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Số HĐ</TableHead>
                        <TableHead>Tiêu đề</TableHead>
                        <TableHead>Ngày phát hành</TableHead>
                        <TableHead>Hạn thanh toán</TableHead>
                        <TableHead className="text-right">Tổng tiền</TableHead>
                        <TableHead className="text-right">Đã trả</TableHead>
                        <TableHead>Trạng thái</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoices.map((invoice: any) => (
                        <TableRow
                          key={invoice.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => navigate(`/invoices/${invoice.id}`)}
                        >
                          <TableCell className="font-medium">{invoice.invoice_number || 'N/A'}</TableCell>
                          <TableCell>{invoice.title || 'N/A'}</TableCell>
                          <TableCell>{formatDate(invoice.issue_date)}</TableCell>
                          <TableCell>{formatDate(invoice.due_date)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(invoice.total_amount || 0)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(invoice.paid_amount || 0)}</TableCell>
                          <TableCell>
                            <Badge variant={invoice.status === 'PAID' ? 'default' : 'destructive'}>
                              {invoice.status || 'N/A'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 4: Thanh toán */}
          <TabsContent value="payments">
            <Card>
              <CardHeader>
                <CardTitle>Lịch sử thanh toán ({payments.length})</CardTitle>
                <CardDescription>
                  Các khoản thanh toán đã thực hiện
                </CardDescription>
              </CardHeader>
              <CardContent>
                {payments.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Chưa có thanh toán nào
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ngày thanh toán</TableHead>
                        <TableHead>Số phiếu thu</TableHead>
                        <TableHead className="text-right">Số tiền</TableHead>
                        <TableHead>Phương thức</TableHead>
                        <TableHead>Ghi chú</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment: any) => (
                        <TableRow key={payment.id}>
                          <TableCell>{formatDate(payment.payment_date)}</TableCell>
                          <TableCell className="font-medium">{payment.receipt_number || 'N/A'}</TableCell>
                          <TableCell className="text-right font-bold text-green-600">
                            {formatCurrency(payment.amount || 0)}
                          </TableCell>
                          <TableCell>{payment.payment_method || 'N/A'}</TableCell>
                          <TableCell className="max-w-xs truncate">{payment.notes || '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 5: Lịch sử */}
          <TabsContent value="history">
            <Card>
              <CardHeader>
                <CardTitle>Lịch sử thay đổi</CardTitle>
                <CardDescription>
                  Các thay đổi và sự kiện liên quan đến hợp đồng
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* Contract Created */}
                  <div className="flex gap-4">
                    <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary"></div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">Hợp đồng được tạo</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(contract.created_at)} - Trạng thái: {contract.status}
                      </p>
                    </div>
                  </div>

                  {/* Termination (if applicable) */}
                  {contract.status === 'TERMINATED' && contract.actual_move_out_date && (
                    <div className="flex gap-4">
                      <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-destructive"></div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">Hợp đồng thanh lý</p>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(contract.actual_move_out_date)}
                        </p>
                        {contract.termination_reason && (
                          <p className="text-sm text-muted-foreground">
                            Lý do: {contract.termination_reason}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Placeholder for future change logs */}
                  <Alert>
                    <AlertDescription>
                      <strong>Lưu ý:</strong> Chức năng ghi log chi tiết các thay đổi (gia hạn, chuyển nhượng)
                      sẽ được bổ sung trong tương lai.
                    </AlertDescription>
                  </Alert>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
      <ExtendContractDialog
        open={extendDialogOpen}
        onOpenChange={setExtendDialogOpen}
        contractId={contract.id}
        currentEndDate={contract.end_date || ''}
        currentRentPrice={contract.rent_price || 0}
      />

      <TransferContractDialog
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        contractId={contract.id}
      />

      <TerminateContractDialog
        open={terminateDialogOpen}
        onOpenChange={setTerminateDialogOpen}
        contractId={contract.id}
      />
    </MainLayout>
  );
};

export default ContractDetailPage;
