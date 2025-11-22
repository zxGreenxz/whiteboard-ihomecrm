import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import {
  Send,
  Link2,
  Mail,
  MessageSquare,
  Smartphone,
  Copy,
  Check,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';

interface SendInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

type SendMethod = 'copy_link' | 'app' | 'zalo_oa' | 'zalo_bot' | 'email';

const SendInvoiceDialog = ({ open, onOpenChange, invoice }: SendInvoiceDialogProps) => {
  const [selectedMethod, setSelectedMethod] = useState<SendMethod | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [customMessage, setCustomMessage] = useState('');

  const handleClose = () => {
    setSelectedMethod(null);
    setIsSending(false);
    setLinkCopied(false);
    setCustomMessage('');
    onOpenChange(false);
  };

  if (!invoice) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  // Generate invoice link - this would be a real URL in production
  const invoiceLink = `${window.location.origin}/invoices/${invoice.id}/view`;

  const defaultMessage = `Kính gửi ${invoice.contract?.tenant?.full_name || 'Quý khách'},

Hóa đơn tháng ${invoice.billing_period_start ? new Date(invoice.billing_period_start).toLocaleDateString('vi-VN', { month: 'numeric', year: 'numeric' }) : ''} của bạn đã sẵn sàng.

Tổng tiền: ${formatCurrency(invoice.total_amount || 0)}
Hạn thanh toán: ${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('vi-VN') : 'N/A'}

Xem chi tiết hóa đơn: ${invoiceLink}

Trân trọng!`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(invoiceLink);
      setLinkCopied(true);
      toast.success('Đã sao chép liên kết');
      setTimeout(() => setLinkCopied(false), 3000);
    } catch (error) {
      toast.error('Không thể sao chép liên kết');
    }
  };

  const handleSendViaApp = async () => {
    setIsSending(true);
    try {
      // In production, this would call an API to send push notification
      // For now, simulate the action
      await new Promise(resolve => setTimeout(resolve, 1000));
      toast.success('Đã gửi thông báo qua App Resident');
      handleClose();
    } catch (error) {
      toast.error('Gửi thông báo thất bại');
    } finally {
      setIsSending(false);
    }
  };

  const handleSendViaZaloOA = async () => {
    setIsSending(true);
    try {
      // In production, this would call Zalo OA API
      await new Promise(resolve => setTimeout(resolve, 1000));
      toast.success('Đã gửi tin nhắn qua Zalo OA');
      handleClose();
    } catch (error) {
      toast.error('Gửi tin nhắn Zalo thất bại');
    } finally {
      setIsSending(false);
    }
  };

  const handleSendViaZaloBot = async () => {
    setIsSending(true);
    try {
      // In production, this would use Zalo Bot API
      await new Promise(resolve => setTimeout(resolve, 1000));
      toast.success('Đã gửi tin nhắn qua Zalo Bot');
      handleClose();
    } catch (error) {
      toast.error('Gửi tin nhắn Zalo thất bại');
    } finally {
      setIsSending(false);
    }
  };

  const handleSendViaEmail = async () => {
    const email = invoice.contract?.tenant?.email;
    if (!email) {
      toast.error('Khách hàng chưa có địa chỉ email');
      return;
    }

    setIsSending(true);
    try {
      // In production, this would call email API
      await new Promise(resolve => setTimeout(resolve, 1000));
      toast.success(`Đã gửi email đến ${email}`);
      handleClose();
    } catch (error) {
      toast.error('Gửi email thất bại');
    } finally {
      setIsSending(false);
    }
  };

  const tenantPhone = invoice.contract?.tenant?.phone;
  const tenantEmail = invoice.contract?.tenant?.email;

  const sendMethods = [
    {
      id: 'copy_link' as SendMethod,
      name: 'Sao chép liên kết',
      description: 'Sao chép URL hóa đơn để tự gửi qua kênh bất kỳ',
      icon: Link2,
      available: true,
      onClick: handleCopyLink,
    },
    {
      id: 'app' as SendMethod,
      name: 'Thông báo qua App Resident',
      description: 'Gửi push notification (khách cần có tài khoản app)',
      icon: Smartphone,
      available: true, // Would check if tenant has app account
      onClick: handleSendViaApp,
    },
    {
      id: 'zalo_oa' as SendMethod,
      name: 'Zalo OA',
      description: tenantPhone
        ? `Gửi tin qua Zalo của ${tenantPhone}`
        : 'Khách hàng chưa có số điện thoại',
      icon: MessageSquare,
      available: !!tenantPhone,
      onClick: handleSendViaZaloOA,
    },
    {
      id: 'zalo_bot' as SendMethod,
      name: 'Zalo Bot',
      description: tenantPhone
        ? `Tự động kết bạn và gửi tin qua Zalo ${tenantPhone}`
        : 'Khách hàng chưa có số điện thoại',
      icon: MessageSquare,
      available: !!tenantPhone,
      onClick: handleSendViaZaloBot,
    },
    {
      id: 'email' as SendMethod,
      name: 'Email',
      description: tenantEmail
        ? `Gửi đến ${tenantEmail}`
        : 'Khách hàng chưa có địa chỉ email',
      icon: Mail,
      available: !!tenantEmail,
      onClick: handleSendViaEmail,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            Gửi hóa đơn
          </DialogTitle>
          <DialogDescription>
            {invoice.title} - {formatCurrency(invoice.total_amount || 0)}
          </DialogDescription>
        </DialogHeader>

        {/* Invoice Summary */}
        <div className="bg-gray-50 p-4 rounded-lg space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Khách thuê:</span>
            <span className="font-medium">{invoice.contract?.tenant?.full_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Số điện thoại:</span>
            <span className="font-medium">{tenantPhone || 'Chưa có'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Email:</span>
            <span className="font-medium">{tenantEmail || 'Chưa có'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Tổng tiền:</span>
            <span className="font-bold text-lg">{formatCurrency(invoice.total_amount || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Hạn thanh toán:</span>
            <span className="font-medium">
              {invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('vi-VN') : 'N/A'}
            </span>
          </div>
        </div>

        {/* Invoice Link */}
        <div className="space-y-2">
          <Label>Liên kết hóa đơn</Label>
          <div className="flex gap-2">
            <Input value={invoiceLink} readOnly className="flex-1" />
            <Button variant="outline" onClick={handleCopyLink}>
              {linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button variant="outline" asChild>
              <a href={invoiceLink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>

        {/* Send Methods */}
        <div className="space-y-2">
          <Label>Chọn phương thức gửi</Label>
          <div className="grid grid-cols-1 gap-2">
            {sendMethods.map((method) => (
              <button
                key={method.id}
                onClick={method.onClick}
                disabled={!method.available || isSending}
                className={`flex items-center gap-3 p-4 rounded-lg border text-left transition-colors ${
                  method.available
                    ? 'hover:bg-gray-50 hover:border-blue-300 cursor-pointer'
                    : 'opacity-50 cursor-not-allowed bg-gray-50'
                } ${selectedMethod === method.id ? 'border-blue-500 bg-blue-50' : ''}`}
              >
                <div className={`p-2 rounded-full ${method.available ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-400'}`}>
                  <method.icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <div className="font-medium flex items-center gap-2">
                    {method.name}
                    {method.id === 'copy_link' && linkCopied && (
                      <Badge variant="secondary" className="text-green-600">
                        <Check className="h-3 w-3 mr-1" />
                        Đã sao chép
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">{method.description}</div>
                </div>
                {method.available && (
                  <Send className="h-4 w-4 text-gray-400" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Custom Message Preview */}
        <div className="space-y-2">
          <Label>Nội dung tin nhắn</Label>
          <Textarea
            value={customMessage || defaultMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            rows={6}
            className="text-sm"
          />
          <p className="text-xs text-gray-500">
            Nội dung này sẽ được gửi kèm khi sử dụng các phương thức Zalo, Email, App
          </p>
        </div>

        {!tenantPhone && !tenantEmail && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Khách hàng chưa có thông tin liên hệ (SĐT, Email). Vui lòng cập nhật thông tin khách hàng để sử dụng các phương thức gửi tự động.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SendInvoiceDialog;
