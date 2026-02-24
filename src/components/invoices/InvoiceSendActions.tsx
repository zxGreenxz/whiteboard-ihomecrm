import { useState } from 'react';
import { Copy, Bell, MessageCircle, Mail, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface InvoiceSendActionsProps {
  invoiceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function InvoiceSendActions({
  invoiceId,
  open,
  onOpenChange,
}: InvoiceSendActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/invoices/${invoiceId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Đã sao chép liên kết hoá đơn');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Không thể sao chép liên kết');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gửi hoá đơn</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="justify-start gap-2"
            onClick={handleCopyLink}
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Sao chép liên kết
          </Button>

          <Button variant="outline" className="justify-start gap-2" disabled>
            <Bell className="h-4 w-4" />
            Thông báo qua App
            <Badge variant="secondary" className="ml-auto text-xs">
              Sắp ra mắt
            </Badge>
          </Button>

          <Button variant="outline" className="justify-start gap-2" disabled>
            <MessageCircle className="h-4 w-4" />
            Zalo OA
            <Badge variant="secondary" className="ml-auto text-xs">
              Sắp ra mắt
            </Badge>
          </Button>

          <Button variant="outline" className="justify-start gap-2" disabled>
            <MessageCircle className="h-4 w-4" />
            Zalo Bot
            <Badge variant="secondary" className="ml-auto text-xs">
              Sắp ra mắt
            </Badge>
          </Button>

          <Button variant="outline" className="justify-start gap-2" disabled>
            <Mail className="h-4 w-4" />
            Email
            <Badge variant="secondary" className="ml-auto text-xs">
              Sắp ra mắt
            </Badge>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
