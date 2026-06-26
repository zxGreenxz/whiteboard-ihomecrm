import { useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EMERALD } from './zaloTheme';
import type { ZaloAccount } from './types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: ZaloAccount | null;
  onRetry: () => void;
}

/** Dialog đăng nhập Zalo cá nhân bằng QR (worker zca-js sinh mã + cập nhật trạng thái). */
export default function ConnectZaloDialog({ open, onOpenChange, account, onRetry }: Props) {
  const status = account?.status;
  const qr = account?.qrData;

  // Kết nối xong → tự đóng sau 1.4s
  useEffect(() => {
    if (open && status === 'connected') {
      const t = setTimeout(() => onOpenChange(false), 1400);
      return () => clearTimeout(t);
    }
  }, [open, status, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" style={{ color: EMERALD }} />
            Kết nối Zalo cá nhân
          </DialogTitle>
          <DialogDescription>
            Quét mã QR bằng <b>Zalo trên điện thoại</b> để đăng nhập tài khoản cá nhân cho việc chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center py-2" style={{ minHeight: 280 }}>
          {status === 'connected' ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <CheckCircle2 className="h-14 w-14" style={{ color: 'hsl(142 71% 45%)' }} />
              <div className="font-semibold text-base">Đã kết nối {account?.name}</div>
              <div className="text-sm text-muted-foreground">Bắt đầu nhận và gửi tin nhắn Zalo được rồi.</div>
            </div>
          ) : status === 'error' ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="h-12 w-12" style={{ color: 'hsl(0 84% 60%)' }} />
              <div className="font-semibold">Kết nối thất bại</div>
              <div className="text-sm text-muted-foreground max-w-[320px]">{account?.lastError || 'Có lỗi khi đăng nhập. Hãy thử lại.'}</div>
              <Button onClick={onRetry} style={{ background: EMERALD }}>Thử lại</Button>
            </div>
          ) : qr ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <img src={qr} alt="QR đăng nhập Zalo" width={220} height={220} style={{ borderRadius: 12, border: '1px solid hsl(210 20% 88%)' }} />
              <div className="text-sm font-medium">Mở Zalo → Cá nhân → biểu tượng quét QR</div>
              <div className="text-xs text-muted-foreground">Mã sẽ hết hạn sau ít phút — bấm Thử lại nếu quá hạn.</div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-center">
              <Loader2 className="h-10 w-10 animate-spin" style={{ color: EMERALD }} />
              <div className="text-sm font-medium">Đang tạo mã QR…</div>
              <div className="text-xs text-muted-foreground max-w-[320px] leading-relaxed">
                Cần <b>worker zca-js đang chạy</b> trên máy bạn (local) hoặc VPS để sinh mã.
                Xem hướng dẫn: <code>docs/zalo/ZALO-WORKER-SETUP.md</code>.
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
