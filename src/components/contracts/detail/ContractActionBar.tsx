import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Calendar,
  RefreshCw,
  MoveRight,
  XCircle,
  Printer,
  QrCode,
  Pencil,
  ArrowRightLeft,
  Trash2,
} from 'lucide-react';
import type { ContractWithRelations } from '@/hooks/useContracts';
import { canUse } from '@/lib/permissionPages';

interface ContractActionBarProps {
  contract: ContractWithRelations;
  perms: Parameters<typeof canUse>[0];
  /** HĐ còn hiệu lực (isContractInEffect) — quyết định nhóm nút gia hạn/chuyển/thanh lý. */
  isActive: boolean;
  showBackButton: boolean;
  onBack: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onShowQR: () => void;
  onRenew: () => void;
  onTransferRoom: () => void;
  onTransferContract: () => void;
  onMoveOut: () => void;
  onTerminate: () => void;
  onDelete: () => void;
}

/** Dải nút action đầu trang chi tiết HĐ (desktop) — tách nguyên văn từ
 *  ContractDetailView (Phase 10D). Quyền hiển thị (canUse) GIỮ NGUYÊN. */
export function ContractActionBar({
  contract,
  perms,
  isActive,
  showBackButton,
  onBack,
  onEdit,
  onPrint,
  onShowQR,
  onRenew,
  onTransferRoom,
  onTransferContract,
  onMoveOut,
  onTerminate,
  onDelete,
}: ContractActionBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-6">
      {showBackButton && (
        <Button
          variant="outline"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>
      )}

      <div className="flex-1" />

      {contract.status !== 'TERMINATED' && canUse(perms, 'contracts', 'edit') && (
        <Button
          variant="outline"
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4 mr-2" />
          Cập nhật
        </Button>
      )}

      {canUse(perms, 'contracts', 'print') && (
        <Button
          variant="outline"
          onClick={onPrint}
        >
          <Printer className="h-4 w-4 mr-2" />
          In hợp đồng
        </Button>
      )}

      {contract.status !== 'TERMINATED' && contract.status !== 'DRAFT' && (
        <Button
          variant="outline"
          onClick={onShowQR}
          title="QR hợp đồng (khách quét xem hoá đơn mới nhất)"
        >
          <QrCode className="h-4 w-4 mr-2" />
          QR hợp đồng
        </Button>
      )}

      {isActive && (
        <>
          {canUse(perms, 'contracts', 'renew') && (
            <Button
              variant="outline"
              onClick={onRenew}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Gia hạn
            </Button>
          )}

          {canUse(perms, 'contracts', 'transfer') && (
            <Button
              variant="outline"
              onClick={onTransferRoom}
            >
              <ArrowRightLeft className="h-4 w-4 mr-2" />
              Chuyển phòng
            </Button>
          )}

          {canUse(perms, 'contracts', 'transfer') && (
            <Button
              variant="outline"
              onClick={onTransferContract}
            >
              <MoveRight className="h-4 w-4 mr-2" />
              Nhượng HĐ
            </Button>
          )}

          {canUse(perms, 'contracts', 'terminate') && (
            <Button
              variant="outline"
              onClick={onMoveOut}
            >
              <Calendar className="h-4 w-4 mr-2" />
              Đăng ký chuyển đi
            </Button>
          )}

          {canUse(perms, 'contracts', 'terminate') && (
            <Button
              variant="destructive"
              onClick={onTerminate}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Thanh lý
            </Button>
          )}
        </>
      )}

      {contract.status === 'DRAFT' && canUse(perms, 'contracts', 'delete') && (
        <Button
          variant="destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Xoá
        </Button>
      )}
    </div>
  );
}
