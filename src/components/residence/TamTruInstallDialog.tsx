// Hướng dẫn cài extension "iHome Tạm trú" (unpacked từ thư mục repo) khi CRM
// không thấy dấu hiệu extension trên trang.
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TAM_TRU_EXT_FOLDER } from '@/lib/tamTruBridge';

export interface TamTruInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}

export default function TamTruInstallDialog({ open, onOpenChange, onRetry }: TamTruInstallDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cài extension iHome Tạm trú</DialogTitle>
          <DialogDescription>
            Chưa thấy extension trên trình duyệt này. Extension là phần điền form trên Cổng DVC; CRM chỉ chuẩn bị dữ liệu.
          </DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Mở Chrome, vào địa chỉ <code className="rounded bg-muted px-1">chrome://extensions</code>.</li>
          <li>Bật <strong>Developer mode</strong> (góc phải trên).</li>
          <li>Bấm <strong>Load unpacked</strong> và chọn thư mục <code className="rounded bg-muted px-1">{TAM_TRU_EXT_FOLDER}</code> trong mã nguồn CRM.</li>
          <li>Tải lại trang CRM này rồi bấm lại nút Đăng ký tạm trú.</li>
        </ol>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" onClick={onRetry}>Tôi đã cài, thử lại</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
