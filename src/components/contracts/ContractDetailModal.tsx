import { FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DIALOG_CLOSE_RED,
} from '@/components/ui/dialog';
import ContractDetailView from './detail/ContractDetailView';

interface ContractDetailModalProps {
  /** ID hợp đồng cần xem; null khi chưa chọn. */
  contractId: string | null;
  /** Tiêu đề hiển thị trên thanh modal (lấy từ dòng đã bấm để hiện ngay). */
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal full-screen xem chi tiết hợp đồng — mở ngay trên trang danh sách nên
 * KHÔNG rời route → giữ nguyên bộ lọc / tìm kiếm / phân trang đang dò. Đóng bằng
 * nút X đỏ góc phải (Dialog không cho click-ngoài / Esc để tránh đóng nhầm).
 */
export default function ContractDetailModal({
  contractId,
  title,
  open,
  onOpenChange,
}: ContractDetailModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="left-0 top-0 h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex flex-col gap-0 rounded-none border-0 p-0 sm:rounded-none"
        closeClassName={DIALOG_CLOSE_RED}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 space-y-0 border-b bg-white px-4 py-3 pr-12 text-left">
          <FileText className="h-5 w-5 shrink-0 text-slate-600" />
          <DialogTitle className="truncate text-base">
            {title || 'Chi tiết hợp đồng'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto bg-gray-50/60 p-4 md:p-6">
          {open && contractId && (
            <ContractDetailView
              id={contractId}
              onBack={() => onOpenChange(false)}
              showBackButton={false}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
