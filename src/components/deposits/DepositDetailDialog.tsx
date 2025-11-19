import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  useConfirmDeposit,
  useRefundDeposit,
  useForfeitDeposit,
  useDeleteDeposit,
  type DepositWithRelations,
} from '@/hooks/useDeposits';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { CheckCircle, RefreshCw, X, Trash2, ArrowRight } from 'lucide-react';

// =============================================
// Status Configuration
// =============================================

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  PENDING: { label: 'Chờ xác nhận', color: 'text-yellow-700', bgColor: 'bg-yellow-100' },
  CONFIRMED: { label: 'Đã xác nhận', color: 'text-green-700', bgColor: 'bg-green-100' },
  REFUNDED: { label: 'Đã hoàn', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  FORFEITED: { label: 'Bị phạt', color: 'text-red-700', bgColor: 'bg-red-100' },
};

// =============================================
// Component
// =============================================

interface DepositDetailDialogProps {
  deposit: DepositWithRelations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function DepositDetailDialog({
  deposit,
  open,
  onOpenChange,
}: DepositDetailDialogProps) {
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [forfeitDialogOpen, setForfeitDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Hooks
  const confirmDeposit = useConfirmDeposit();
  const refundDeposit = useRefundDeposit();
  const forfeitDeposit = useForfeitDeposit();
  const deleteDeposit = useDeleteDeposit();

  // =============================================
  // Handlers
  // =============================================

  const handleConfirm = () => {
    confirmDeposit.mutate(deposit.id, {
      onSuccess: () => {
        setConfirmDialogOpen(false);
        onOpenChange(false);
      },
    });
  };

  const handleRefund = () => {
    refundDeposit.mutate(deposit.id, {
      onSuccess: () => {
        setRefundDialogOpen(false);
        onOpenChange(false);
      },
    });
  };

  const handleForfeit = () => {
    forfeitDeposit.mutate(deposit.id, {
      onSuccess: () => {
        setForfeitDialogOpen(false);
        onOpenChange(false);
      },
    });
  };

  const handleDelete = () => {
    deleteDeposit.mutate(deposit.id, {
      onSuccess: () => {
        setDeleteDialogOpen(false);
        onOpenChange(false);
      },
    });
  };

  const statusInfo = STATUS_CONFIG[deposit.status || 'PENDING'];

  // =============================================
  // Render
  // =============================================

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Chi tiết đặt cọc</DialogTitle>
                <DialogDescription>
                  Xem và quản lý thông tin đặt cọc
                </DialogDescription>
              </div>
              <Badge className={`${statusInfo.bgColor} ${statusInfo.color}`}>
                {statusInfo.label}
              </Badge>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            {/* Tenant Info */}
            <Card className="p-4 space-y-3">
              <h3 className="font-semibold">Thông tin khách hàng</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Tên khách hàng:</span>
                  <p className="font-semibold">{deposit.tenant?.full_name}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Số điện thoại:</span>
                  <p className="font-semibold">{deposit.tenant?.phone}</p>
                </div>
                {deposit.tenant?.email && (
                  <div>
                    <span className="text-muted-foreground">Email:</span>
                    <p className="font-semibold">{deposit.tenant.email}</p>
                  </div>
                )}
              </div>
            </Card>

            {/* Room/Bed Info */}
            {(deposit.room || deposit.bed) && (
              <Card className="p-4 space-y-3">
                <h3 className="font-semibold">Phòng/Giường</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {deposit.room && (
                    <>
                      <div>
                        <span className="text-muted-foreground">Tòa nhà:</span>
                        <p className="font-semibold">{deposit.room.building.name}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Phòng:</span>
                        <p className="font-semibold">{deposit.room.name} ({deposit.room.code})</p>
                      </div>
                    </>
                  )}
                  {deposit.bed && (
                    <>
                      <div>
                        <span className="text-muted-foreground">Tòa nhà:</span>
                        <p className="font-semibold">{deposit.bed.room.building.name}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Phòng:</span>
                        <p className="font-semibold">{deposit.bed.room.name}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Giường:</span>
                        <p className="font-semibold">{deposit.bed.name} ({deposit.bed.code})</p>
                      </div>
                    </>
                  )}
                </div>
              </Card>
            )}

            {/* Deposit Info */}
            <Card className="p-4 space-y-3">
              <h3 className="font-semibold">Thông tin đặt cọc</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Số tiền:</span>
                  <p className="font-semibold text-lg">
                    {new Intl.NumberFormat('vi-VN').format(deposit.amount)}₫
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Ngày đặt cọc:</span>
                  <p className="font-semibold">
                    {format(new Date(deposit.deposit_date), 'dd/MM/yyyy', { locale: vi })}
                  </p>
                </div>
                {deposit.hold_until && (
                  <div>
                    <span className="text-muted-foreground">Giữ chỗ đến:</span>
                    <p className="font-semibold">
                      {format(new Date(deposit.hold_until), 'dd/MM/yyyy', { locale: vi })}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            {/* Notes */}
            {deposit.notes && (
              <Card className="p-4 space-y-3">
                <h3 className="font-semibold">Ghi chú</h3>
                <p className="text-sm">{deposit.notes}</p>
              </Card>
            )}

            {/* System Info */}
            <Card className="p-4 space-y-3">
              <h3 className="font-semibold">Thông tin hệ thống</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Ngày tạo:</span>
                  <p>
                    {format(new Date(deposit.created_at || ''), 'dd/MM/yyyy HH:mm', {
                      locale: vi,
                    })}
                  </p>
                </div>
                {deposit.contract_id && (
                  <div>
                    <span className="text-muted-foreground">Đã chuyển thành hợp đồng</span>
                    <Badge variant="secondary" className="ml-2">
                      ✓
                    </Badge>
                  </div>
                )}
              </div>
            </Card>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-4">
              {deposit.status === 'PENDING' && (
                <>
                  <Button onClick={() => setConfirmDialogOpen(true)}>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Xác nhận đặt cọc
                  </Button>
                  <Button variant="outline" onClick={() => setRefundDialogOpen(true)}>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Hoàn cọc
                  </Button>
                  <Button variant="outline" onClick={() => setForfeitDialogOpen(true)}>
                    <X className="h-4 w-4 mr-2" />
                    Phạt cọc
                  </Button>
                </>
              )}
              {(deposit.status === 'PENDING' || deposit.status === 'CONFIRMED') && (
                <Button
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={!!deposit.contract_id}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Xóa đặt cọc
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm Dialog */}
      <AlertDialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận đặt cọc</AlertDialogTitle>
            <AlertDialogDescription>
              Xác nhận đặt cọc cho khách hàng <strong>{deposit.tenant?.full_name}</strong>?
              Phòng/giường sẽ tiếp tục được giữ chỗ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Xác nhận</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Refund Dialog */}
      <AlertDialog open={refundDialogOpen} onOpenChange={setRefundDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hoàn cọc</AlertDialogTitle>
            <AlertDialogDescription>
              Hoàn cọc cho khách hàng <strong>{deposit.tenant?.full_name}</strong>?
              Phòng/giường sẽ được trả về trạng thái "Còn trống".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleRefund}>Hoàn cọc</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Forfeit Dialog */}
      <AlertDialog open={forfeitDialogOpen} onOpenChange={setForfeitDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Phạt cọc</AlertDialogTitle>
            <AlertDialogDescription>
              Tịch thu tiền cọc của khách hàng <strong>{deposit.tenant?.full_name}</strong>?
              Phòng/giường sẽ được trả về trạng thái "Còn trống".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForfeit}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Phạt cọc
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa đặt cọc</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa đặt cọc này? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
