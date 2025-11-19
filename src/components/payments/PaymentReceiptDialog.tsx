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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Printer, FileText, Receipt } from 'lucide-react';
import { type PaymentWithRelations } from '@/hooks/usePayments';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface PaymentReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: PaymentWithRelations | null;
}

type PrintFormat = 'A4' | 'THERMAL';

const PaymentReceiptDialog = ({ open, onOpenChange, payment }: PaymentReceiptDialogProps) => {
  const [printFormat, setPrintFormat] = useState<PrintFormat>('A4');

  if (!payment) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getPaymentMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      CASH: 'Tiền mặt',
      BANK_TRANSFER: 'Chuyển khoản',
      CARD: 'Thẻ ATM/Credit',
      MOMO: 'Ví MoMo',
      ZALO_PAY: 'ZaloPay',
      VNPAY: 'VNPay',
    };
    return labels[method] || method;
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Vui lòng cho phép popup để in phiếu thu');
      return;
    }

    const content = printFormat === 'A4' ? generateA4Content() : generateThermalContent();

    printWindow.document.write(content);
    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);

    onOpenChange(false);
  };

  const generateA4Content = () => {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Phiếu thu ${payment.id.slice(0, 8).toUpperCase()}</title>
  <style>
    @page {
      size: A4;
      margin: 20mm;
    }

    @media print {
      body {
        margin: 0;
        padding: 0;
      }
      .no-print {
        display: none !important;
      }
    }

    body {
      font-family: 'Arial', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 210mm;
      margin: 0 auto;
      padding: 10mm;
    }

    .receipt-header {
      text-align: center;
      margin-bottom: 30px;
      border-bottom: 3px solid #16a34a;
      padding-bottom: 20px;
    }

    .company-name {
      font-size: 24px;
      font-weight: bold;
      color: #16a34a;
      margin-bottom: 5px;
    }

    .company-info {
      font-size: 12px;
      color: #666;
    }

    .receipt-title {
      font-size: 32px;
      font-weight: bold;
      color: #15803d;
      margin: 20px 0;
      text-transform: uppercase;
      text-align: center;
    }

    .receipt-code {
      text-align: center;
      font-size: 16px;
      color: #666;
      margin-bottom: 30px;
    }

    .receipt-info {
      background: #f0fdf4;
      border: 2px solid #16a34a;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      margin: 10px 0;
      font-size: 14px;
    }

    .info-label {
      color: #4b5563;
      font-weight: 500;
    }

    .info-value {
      font-weight: 600;
      color: #1f2937;
    }

    .amount-section {
      background: #dcfce7;
      border: 3px solid #16a34a;
      border-radius: 8px;
      padding: 20px;
      margin: 30px 0;
      text-align: center;
    }

    .amount-label {
      font-size: 16px;
      color: #15803d;
      font-weight: 600;
      margin-bottom: 10px;
    }

    .amount-value {
      font-size: 36px;
      font-weight: bold;
      color: #16a34a;
    }

    .amount-words {
      font-size: 14px;
      color: #15803d;
      margin-top: 10px;
      font-style: italic;
    }

    .notes-section {
      background: #fffbeb;
      border-left: 4px solid #f59e0b;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }

    .notes-title {
      font-weight: 600;
      color: #92400e;
      margin-bottom: 5px;
    }

    .notes-content {
      color: #78350f;
      font-size: 13px;
    }

    .signature-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      margin-top: 60px;
      text-align: center;
    }

    .signature-box {
      padding: 20px;
    }

    .signature-title {
      font-weight: 600;
      margin-bottom: 80px;
      color: #1e293b;
    }

    .signature-line {
      border-top: 1px solid #94a3b8;
      margin-top: 10px;
      padding-top: 5px;
      color: #64748b;
      font-size: 12px;
    }

    .footer {
      margin-top: 50px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      color: #64748b;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="receipt-header">
    <div class="company-name">iHomeCRM</div>
    <div class="company-info">Hệ thống quản lý bất động sản</div>
  </div>

  <div class="receipt-title">PHIẾU THU</div>
  <div class="receipt-code">Số phiếu: <strong>${payment.id.slice(0, 8).toUpperCase()}</strong></div>

  <div class="receipt-info">
    <div class="info-row">
      <span class="info-label">Ngày thu:</span>
      <span class="info-value">${format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Người nộp tiền:</span>
      <span class="info-value">${payment.invoice?.contract?.tenant?.full_name || 'N/A'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Số điện thoại:</span>
      <span class="info-value">${payment.invoice?.contract?.tenant?.phone || 'N/A'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Phòng:</span>
      <span class="info-value">
        ${payment.invoice?.contract?.room?.name || payment.invoice?.contract?.bed?.name || 'N/A'}
      </span>
    </div>
    <div class="info-row">
      <span class="info-label">Hóa đơn liên quan:</span>
      <span class="info-value">${payment.invoice?.title || 'N/A'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Phương thức:</span>
      <span class="info-value">${getPaymentMethodLabel(payment.payment_method)}</span>
    </div>
  </div>

  <div class="amount-section">
    <div class="amount-label">Số tiền đã thu:</div>
    <div class="amount-value">${formatCurrency(payment.amount)}</div>
    <div class="amount-words">(Bằng chữ: ${convertNumberToWords(payment.amount)})</div>
  </div>

  ${
    payment.notes
      ? `
  <div class="notes-section">
    <div class="notes-title">Ghi chú:</div>
    <div class="notes-content">${payment.notes}</div>
  </div>
  `
      : ''
  }

  <div class="signature-section">
    <div class="signature-box">
      <div class="signature-title">Người nộp tiền</div>
      <div class="signature-line">(Ký và ghi rõ họ tên)</div>
    </div>
    <div class="signature-box">
      <div class="signature-title">Người thu tiền</div>
      <div class="signature-line">(Ký và ghi rõ họ tên)</div>
    </div>
  </div>

  <div class="footer">
    <div>Cảm ơn quý khách đã thanh toán!</div>
    <div style="margin-top: 5px;">In lúc: ${format(new Date(), 'dd/MM/yyyy HH:mm:ss', { locale: vi })}</div>
  </div>
</body>
</html>
    `;
  };

  const generateThermalContent = () => {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Phiếu thu ${payment.id.slice(0, 8).toUpperCase()}</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 0;
    }

    @media print {
      body {
        margin: 0;
        padding: 0;
      }
    }

    body {
      font-family: 'Courier New', monospace;
      width: 80mm;
      margin: 0 auto;
      padding: 5mm;
      font-size: 12px;
      line-height: 1.4;
    }

    .header {
      text-align: center;
      border-bottom: 2px dashed #333;
      padding-bottom: 10px;
      margin-bottom: 10px;
    }

    .store-name {
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .store-info {
      font-size: 10px;
    }

    .title {
      text-align: center;
      font-size: 18px;
      font-weight: bold;
      margin: 10px 0;
      text-transform: uppercase;
    }

    .receipt-code {
      text-align: center;
      font-size: 11px;
      margin-bottom: 10px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      margin: 3px 0;
      font-size: 11px;
    }

    .section-divider {
      border-top: 1px dashed #333;
      margin: 10px 0;
    }

    .amount-section {
      text-align: center;
      margin: 15px 0;
      padding: 10px;
      border: 2px solid #333;
    }

    .amount-label {
      font-size: 12px;
      margin-bottom: 5px;
    }

    .amount-value {
      font-size: 20px;
      font-weight: bold;
    }

    .footer {
      text-align: center;
      margin-top: 15px;
      padding-top: 10px;
      border-top: 2px dashed #333;
      font-size: 10px;
    }

    .notes {
      margin: 10px 0;
      padding: 5px;
      background: #f5f5f5;
      font-size: 10px;
    }

    .signature {
      text-align: center;
      margin-top: 20px;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="store-name">iHomeCRM</div>
    <div class="store-info">Hệ thống quản lý BĐS</div>
  </div>

  <div class="title">PHIẾU THU</div>
  <div class="receipt-code">Số: ${payment.id.slice(0, 8).toUpperCase()}</div>

  <div class="info-row">
    <span>Ngày:</span>
    <span>${format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })}</span>
  </div>

  <div class="section-divider"></div>

  <div class="info-row">
    <span>Người nộp:</span>
    <span>${payment.invoice?.contract?.tenant?.full_name || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>SĐT:</span>
    <span>${payment.invoice?.contract?.tenant?.phone || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>Phòng:</span>
    <span>${payment.invoice?.contract?.room?.name || payment.invoice?.contract?.bed?.name || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>HĐ:</span>
    <span>${payment.invoice?.title || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>PT:</span>
    <span>${getPaymentMethodLabel(payment.payment_method)}</span>
  </div>

  <div class="section-divider"></div>

  <div class="amount-section">
    <div class="amount-label">Số tiền thu:</div>
    <div class="amount-value">${formatCurrency(payment.amount)}</div>
  </div>

  ${
    payment.notes
      ? `
  <div class="notes">
    <strong>Ghi chú:</strong><br/>
    ${payment.notes}
  </div>
  `
      : ''
  }

  <div class="signature">
    <div style="margin-bottom: 40px;">Người nộp tiền</div>
    <div>_______________</div>
  </div>

  <div class="footer">
    <div>Cảm ơn!</div>
    <div>${format(new Date(), 'dd/MM/yyyy HH:mm', { locale: vi })}</div>
  </div>
</body>
</html>
    `;
  };

  // Convert number to Vietnamese words (simplified version)
  const convertNumberToWords = (amount: number): string => {
    // This is a simplified version - in production, you'd use a proper library
    const millions = Math.floor(amount / 1000000);
    const thousands = Math.floor((amount % 1000000) / 1000);
    const remainder = amount % 1000;

    let words = '';
    if (millions > 0) words += `${millions} triệu `;
    if (thousands > 0) words += `${thousands} nghìn `;
    if (remainder > 0) words += `${remainder} `;
    words += 'đồng';

    return words.trim();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            In phiếu thu
          </DialogTitle>
          <DialogDescription>
            Chọn định dạng in cho phiếu thu tiền
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm">
            <div className="font-medium text-green-900 mb-2">Thông tin phiếu thu:</div>
            <div className="space-y-1 text-green-800">
              <div>Số phiếu: <strong>{payment.id.slice(0, 8).toUpperCase()}</strong></div>
              <div>Khách hàng: <strong>{payment.invoice?.contract?.tenant?.full_name}</strong></div>
              <div>Số tiền: <strong className="text-lg">{formatCurrency(payment.amount)}</strong></div>
            </div>
          </div>

          <RadioGroup value={printFormat} onValueChange={(value) => setPrintFormat(value as PrintFormat)}>
            <div className="flex items-center space-x-3 rounded-lg border p-4 hover:bg-gray-50 cursor-pointer">
              <RadioGroupItem value="A4" id="format-a4" />
              <Label
                htmlFor="format-a4"
                className="flex-1 cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-green-600" />
                  <div>
                    <div className="font-medium">Khổ A4</div>
                    <div className="text-sm text-gray-500">Phiếu thu chính thức, đầy đủ thông tin</div>
                  </div>
                </div>
              </Label>
            </div>

            <div className="flex items-center space-x-3 rounded-lg border p-4 hover:bg-gray-50 cursor-pointer">
              <RadioGroupItem value="THERMAL" id="format-thermal" />
              <Label
                htmlFor="format-thermal"
                className="flex-1 cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <Receipt className="h-5 w-5 text-blue-600" />
                  <div>
                    <div className="font-medium">Khổ 80mm (Thermal)</div>
                    <div className="text-sm text-gray-500">Phiếu thu nhỏ gọn cho máy in nhiệt</div>
                  </div>
                </div>
              </Label>
            </div>
          </RadioGroup>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-800">
            <strong>Lưu ý:</strong> Sau khi nhấn "In", cửa sổ in sẽ mở ra. Bạn có thể chọn in trực tiếp hoặc lưu thành file PDF.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" />
            In phiếu thu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PaymentReceiptDialog;
