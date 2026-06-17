import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Pencil,
  Printer,
  QrCode,
  RefreshCw,
  ArrowRightLeft,
  MoveRight,
  Calendar,
  XCircle,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { canUse } from '@/lib/permissionPages';
import { isContractInEffect, type ContractWithRelations } from '@/types/contract';
import { useDragScroll } from './useDragScroll';

interface ActionHandlers {
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

/** Hàng nút hành động cuộn ngang (kéo-để-cuộn, không vô tình bấm nút). Ẩn/hiện
 *  từng nút theo quyền + trạng thái — Y HỆT desktop. */
export function ContractMobileActions({
  contract,
  perms,
  ...h
}: { contract: ContractWithRelations; perms: Parameters<typeof canUse>[0] } & ActionHandlers) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref);
  const status = contract.status;
  const isActive = isContractInEffect(status);

  const items: { show: boolean; label: string; icon: LucideIcon; onClick: () => void; destructive?: boolean }[] = [
    { show: status !== 'TERMINATED' && canUse(perms, 'contracts', 'edit'), label: 'Cập nhật', icon: Pencil, onClick: h.onEdit },
    { show: canUse(perms, 'contracts', 'print'), label: 'In HĐ', icon: Printer, onClick: h.onPrint },
    { show: status !== 'TERMINATED' && status !== 'DRAFT', label: 'QR', icon: QrCode, onClick: h.onShowQR },
    { show: isActive && canUse(perms, 'contracts', 'renew'), label: 'Gia hạn', icon: RefreshCw, onClick: h.onRenew },
    { show: isActive && canUse(perms, 'contracts', 'transfer'), label: 'Chuyển phòng', icon: ArrowRightLeft, onClick: h.onTransferRoom },
    { show: isActive && canUse(perms, 'contracts', 'transfer'), label: 'Nhượng HĐ', icon: MoveRight, onClick: h.onTransferContract },
    { show: isActive && canUse(perms, 'contracts', 'terminate'), label: 'Đăng ký trả phòng', icon: Calendar, onClick: h.onMoveOut },
    { show: isActive && canUse(perms, 'contracts', 'terminate'), label: 'Thanh lý', icon: XCircle, onClick: h.onTerminate, destructive: true },
    { show: status === 'DRAFT' && canUse(perms, 'contracts', 'delete'), label: 'Xoá', icon: Trash2, onClick: h.onDelete, destructive: true },
  ];
  const visible = items.filter((i) => i.show);
  if (!visible.length) return null;

  return (
    <div
      ref={ref}
      className="flex gap-2 overflow-x-auto pb-2 mb-4 cursor-grab select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {visible.map((it) => {
        const Icon = it.icon;
        return (
          <Button
            key={it.label}
            variant={it.destructive ? 'destructive' : 'outline'}
            size="sm"
            className="shrink-0 h-9"
            onClick={it.onClick}
          >
            <Icon className="h-4 w-4 mr-1.5" />
            {it.label}
          </Button>
        );
      })}
    </div>
  );
}
