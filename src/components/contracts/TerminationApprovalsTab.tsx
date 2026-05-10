import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  ClipboardCheck,
  CheckCircle,
  XCircle,
  Eye,
  AlertCircle,
  DollarSign,
  Calendar,
  User,
  Home,
  FileText,
} from 'lucide-react';
import {
  usePendingTerminations,
  useApproveTermination,
  useRejectTermination,
  TerminationWithRelations,
} from '@/hooks/useContracts';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

const TerminationApprovalsTab = () => {
  const navigate = useNavigate();
  const { data: terminations, isLoading } = usePendingTerminations();
  const approveMutation = useApproveTermination();
  const rejectMutation = useRejectTermination();

  const [selectedTermination, setSelectedTermination] = useState<TerminationWithRelations | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('TM');

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getTerminationTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      NORMAL: 'Hết hạn bình thường',
      EARLY_TENANT: 'Khách rời sớm',
      EARLY_OWNER: 'Chủ nhà chấm dứt',
      BREACH: 'Vi phạm hợp đồng',
      FORFEIT: 'Bỏ cọc',
    };
    return labels[type] || type;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DRAFT':
        return <Badge variant="outline">Nháp</Badge>;
      case 'PENDING_APPROVAL':
        return <Badge variant="secondary" className="bg-orange-100 text-orange-800">Chờ duyệt</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getLocationDisplay = (termination: TerminationWithRelations) => {
    const contract = termination.contract;
    if (!contract) return 'N/A';
    if (contract.bed) {
      return `${contract.bed.name} - ${contract.bed.room.name} - ${contract.bed.room.building.name}`;
    }
    if (contract.room) {
      return `${contract.room.name} - ${contract.room.building.name}`;
    }
    return 'N/A';
  };

  const handleViewDetail = (termination: TerminationWithRelations) => {
    setSelectedTermination(termination);
    setDetailDialogOpen(true);
  };

  const handleApprove = (termination: TerminationWithRelations) => {
    approveMutation.mutate({
      termination_id: termination.id,
      contract_id: termination.contract_id,
      refund_amount: termination.refund_amount || 0,
      payment_method: paymentMethod,
    }, {
      onSuccess: () => {
        setDetailDialogOpen(false);
        setSelectedTermination(null);
      },
    });
  };

  const handleOpenReject = (termination: TerminationWithRelations) => {
    setSelectedTermination(termination);
    setRejectionReason('');
    setRejectDialogOpen(true);
  };

  const handleReject = () => {
    if (!selectedTermination) return;
    rejectMutation.mutate({
      termination_id: selectedTermination.id,
      rejection_reason: rejectionReason,
    }, {
      onSuccess: () => {
        setRejectDialogOpen(false);
        setDetailDialogOpen(false);
        setSelectedTermination(null);
      },
    });
  };

  const pendingCount = terminations?.length || 0;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5" />
                Yêu cầu thanh lý chờ duyệt
              </CardTitle>
              <CardDescription>
                Xem xét và duyệt các yêu cầu thanh lý hợp đồng
              </CardDescription>
            </div>
            {pendingCount > 0 && (
              <Badge variant="destructive" className="text-lg px-3 py-1">
                {pendingCount}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-gray-500">
              Đang tải...
            </div>
          ) : !terminations || terminations.length === 0 ? (
            <div className="text-center py-12">
              <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
              <p className="text-gray-500 text-lg">Không có yêu cầu nào cần duyệt</p>
              <p className="text-gray-400 text-sm mt-1">Tất cả yêu cầu thanh lý đã được xử lý</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày tạo</TableHead>
                  <TableHead>Khách hàng</TableHead>
                  <TableHead>Căn hộ</TableHead>
                  <TableHead>Loại thanh lý</TableHead>
                  <TableHead>Ngày chuyển đi</TableHead>
                  <TableHead className="text-right">Tiền cọc</TableHead>
                  <TableHead className="text-right">Hoàn trả/Thu thêm</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-center">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {terminations.map((term) => (
                  <TableRow key={term.id} className="cursor-pointer hover:bg-gray-50">
                    <TableCell className="text-sm">
                      {format(new Date(term.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })}
                    </TableCell>
                    <TableCell className="font-medium">
                      {term.contract?.tenant?.full_name || 'N/A'}
                    </TableCell>
                    <TableCell>{getLocationDisplay(term)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{getTerminationTypeLabel(term.termination_type)}</Badge>
                    </TableCell>
                    <TableCell>
                      {format(new Date(term.actual_move_out_date), 'dd/MM/yyyy', { locale: vi })}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(term.total_deposit || 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={(term.refund_amount || 0) >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                        {(term.refund_amount || 0) >= 0 ? '+' : ''}{formatCurrency(term.refund_amount || 0)}
                      </span>
                    </TableCell>
                    <TableCell>{getStatusBadge(term.status)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewDetail(term)}
                          title="Xem chi tiết"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={() => {
                            setSelectedTermination(term);
                            setDetailDialogOpen(true);
                          }}
                          title="Duyệt"
                        >
                          <CheckCircle className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleOpenReject(term)}
                          title="Từ chối"
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Detail & Approve Dialog */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-blue-600" />
              Chi tiết yêu cầu thanh lý
            </DialogTitle>
            <DialogDescription>
              Xem xét chi phí và duyệt thanh lý hợp đồng
            </DialogDescription>
          </DialogHeader>

          {selectedTermination && (
            <div className="space-y-4">
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-gray-400" />
                      <div>
                        <div className="text-gray-500">Khách hàng</div>
                        <div className="font-medium">{selectedTermination.contract?.tenant?.full_name || 'N/A'}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Home className="h-4 w-4 text-gray-400" />
                      <div>
                        <div className="text-gray-500">Căn hộ</div>
                        <div className="font-medium">{getLocationDisplay(selectedTermination)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-gray-400" />
                      <div>
                        <div className="text-gray-500">Loại thanh lý</div>
                        <div className="font-medium">{getTerminationTypeLabel(selectedTermination.termination_type)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-gray-400" />
                      <div>
                        <div className="text-gray-500">Ngày chuyển đi</div>
                        <div className="font-medium">
                          {format(new Date(selectedTermination.actual_move_out_date), 'dd/MM/yyyy', { locale: vi })}
                        </div>
                      </div>
                    </div>
                  </div>
                  {selectedTermination.contract && (
                    <div className="pt-2">
                      <Button
                        variant="link"
                        size="sm"
                        className="p-0 h-auto text-blue-600"
                        onClick={() => navigate(`/contracts/${selectedTermination.contract_id}`)}
                      >
                        Xem chi tiết hợp đồng
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Bảng tính chi phí
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tiền cọc ban đầu:</span>
                    <span className="font-medium">{formatCurrency(selectedTermination.total_deposit || 0)}</span>
                  </div>
                  <div className="border-t pt-2 space-y-1">
                    <p className="font-medium text-gray-700">Các khoản trừ:</p>
                    {(selectedTermination.outstanding_debt || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Công nợ cũ:</span>
                        <span>{formatCurrency(selectedTermination.outstanding_debt || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.prorated_rent || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Tiền căn hộ ngày lẻ:</span>
                        <span>{formatCurrency(selectedTermination.prorated_rent || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.prorated_services || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Dịch vụ ngày lẻ:</span>
                        <span>{formatCurrency(selectedTermination.prorated_services || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.early_termination_fee || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Phí chấm dứt sớm:</span>
                        <span>{formatCurrency(selectedTermination.early_termination_fee || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.damage_fee || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Phí hư hỏng:</span>
                        <span>{formatCurrency(selectedTermination.damage_fee || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.cleaning_fee || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Phí vệ sinh:</span>
                        <span>{formatCurrency(selectedTermination.cleaning_fee || 0)}</span>
                      </div>
                    )}
                    {(selectedTermination.other_fees || 0) > 0 && (
                      <div className="flex justify-between pl-4">
                        <span className="text-gray-600">- Phí khác:</span>
                        <span>{formatCurrency(selectedTermination.other_fees || 0)}</span>
                      </div>
                    )}
                    <div className="flex justify-between pl-4 font-medium border-t pt-1">
                      <span className="text-gray-700">Tổng khấu trừ:</span>
                      <span>{formatCurrency(selectedTermination.total_deductions || 0)}</span>
                    </div>
                  </div>
                  <div className="border-t-2 pt-3 flex justify-between font-bold text-lg">
                    <span>
                      {(selectedTermination.refund_amount || 0) >= 0 ? 'Hoàn trả khách:' : 'Khách phải trả thêm:'}
                    </span>
                    <span className={(selectedTermination.refund_amount || 0) >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {formatCurrency(Math.abs(selectedTermination.refund_amount || 0))}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {selectedTermination.damage_description && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Mô tả hư hỏng:</strong> {selectedTermination.damage_description}
                  </AlertDescription>
                </Alert>
              )}

              {selectedTermination.notes && (
                <div className="text-sm bg-gray-50 p-3 rounded-md">
                  <strong>Ghi chú:</strong> {selectedTermination.notes}
                </div>
              )}

              <div className="space-y-2">
                <Label>Phương thức thanh toán</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TM">TM</SelectItem>
                    <SelectItem value="TK">TK</SelectItem>
                    <SelectItem value="TT">TT</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleOpenReject(selectedTermination)}
                  disabled={rejectMutation.isPending}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Từ chối
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700"
                  onClick={() => handleApprove(selectedTermination)}
                  disabled={approveMutation.isPending}
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  {approveMutation.isPending ? 'Đang xử lý...' : 'Duyệt & Hoàn thành thanh lý'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-600" />
              Từ chối yêu cầu thanh lý
            </DialogTitle>
            <DialogDescription>
              Yêu cầu sẽ được trả về trạng thái nháp
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rejection_reason">Lý do từ chối</Label>
              <Textarea
                id="rejection_reason"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Nhập lý do từ chối..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Hủy
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejectMutation.isPending}
            >
              {rejectMutation.isPending ? 'Đang xử lý...' : 'Xác nhận từ chối'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TerminationApprovalsTab;
