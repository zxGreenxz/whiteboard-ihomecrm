import { useRef } from 'react';
import {
  Pencil,
  Printer,
  QrCode,
  RefreshCw,
  ArrowRightLeft,
  Users,
  LogOut,
  Ban,
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

/** Hàng nút hành động (icon vuông + nhãn) cuộn ngang kéo-để-cuộn — theo design
 *  `.cd-acts`/`.cd-act`. Ẩn/hiện từng nút theo quyền + trạng thái như desktop. */
export function ContractMobileActions({
  contract,
  perms,
  ...h
}: { contract: ContractWithRelations; perms: Parameters<typeof canUse>[0] } & ActionHandlers) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref);
  const status = contract.status;
  const isActive = isContractInEffect(status);

  const items: { show: boolean; label: string; icon: LucideIcon; onClick: () => void; danger?: boolean }[] = [
    { show: status !== 'TERMINATED' && canUse(perms, 'contracts', 'edit'), label: 'Cập nhật', icon: Pencil, onClick: h.onEdit },
    { show: canUse(perms, 'contracts', 'print'), label: 'In HĐ', icon: Printer, onClick: h.onPrint },
    { show: status !== 'TERMINATED' && status !== 'DRAFT', label: 'Mã QR', icon: QrCode, onClick: h.onShowQR },
    { show: isActive && canUse(perms, 'contracts', 'renew'), label: 'Gia hạn', icon: RefreshCw, onClick: h.onRenew },
    { show: isActive && canUse(perms, 'contracts', 'transfer'), label: 'Chuyển phòng', icon: ArrowRightLeft, onClick: h.onTransferRoom },
    { show: isActive && canUse(perms, 'contracts', 'transfer'), label: 'Nhượng HĐ', icon: Users, onClick: h.onTransferContract },
    { show: isActive && canUse(perms, 'contracts', 'terminate'), label: 'Chuyển đi', icon: LogOut, onClick: h.onMoveOut },
    { show: isActive && canUse(perms, 'contracts', 'terminate'), label: 'Thanh lý', icon: Ban, onClick: h.onTerminate, danger: true },
    { show: status === 'DRAFT' && canUse(perms, 'contracts', 'delete'), label: 'Xoá', icon: Trash2, onClick: h.onDelete, danger: true },
  ];
  const visible = items.filter((i) => i.show);
  if (!visible.length) return null;

  return (
    <div className="cd-acts" ref={ref}>
      {visible.map((it) => {
        const Icon = it.icon;
        return (
          <button className={'cd-act' + (it.danger ? ' danger' : '')} key={it.label} onClick={it.onClick}>
            <span className="cd-act-ic"><Icon size={18} /></span>
            <span className="cd-act-l">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
