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
import { type InvoiceWithRelations } from '@/hooks/useInvoices';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface PrintInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

type PrintFormat = 'A4' | 'THERMAL';

const PrintInvoiceDialog = ({ open, onOpenChange, invoice }: PrintInvoiceDialogProps) => {
  const [printFormat, setPrintFormat] = useState<PrintFormat>('A4');

  if (!invoice) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Vui lòng cho phép popup để in hóa đơn');
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
  <title>Hóa đơn ${invoice.title}</title>
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

    .invoice-header {
      text-align: center;
      margin-bottom: 30px;
      border-bottom: 3px solid #2563eb;
      padding-bottom: 20px;
    }

    .company-name {
      font-size: 24px;
      font-weight: bold;
      color: #2563eb;
      margin-bottom: 5px;
    }

    .company-info {
      font-size: 12px;
      color: #666;
    }

    .invoice-title {
      font-size: 28px;
      font-weight: bold;
      color: #1e40af;
      margin: 20px 0;
      text-transform: uppercase;
    }

    .invoice-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }

    .meta-group {
      background: #f8fafc;
      padding: 15px;
      border-radius: 8px;
      border-left: 4px solid #2563eb;
    }

    .meta-group h3 {
      font-size: 14px;
      color: #64748b;
      margin: 0 0 10px 0;
      font-weight: 600;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      margin: 5px 0;
      font-size: 13px;
    }

    .meta-label {
      color: #64748b;
    }

    .meta-value {
      font-weight: 600;
      color: #1e293b;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }

    .items-table thead {
      background: #2563eb;
      color: white;
    }

    .items-table th,
    .items-table td {
      padding: 12px;
      text-align: left;
      border: 1px solid #e2e8f0;
    }

    .items-table th {
      font-weight: 600;
      font-size: 13px;
    }

    .items-table td {
      font-size: 13px;
    }

    .items-table tbody tr:nth-child(even) {
      background: #f8fafc;
    }

    .items-table .text-right {
      text-align: right;
    }

    .items-table .item-type {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: #dbeafe;
      color: #1e40af;
    }

    .total-row {
      background: #eff6ff !important;
      font-weight: bold;
      font-size: 15px;
    }

    .total-row td {
      border-top: 2px solid #2563eb;
      padding: 15px 12px;
    }

    .summary-box {
      background: #f8fafc;
      border: 2px solid #2563eb;
      border-radius: 8px;
      padding: 20px;
      margin: 30px 0;
    }

    .summary-row {
      display: flex;
      justify-content: space-between;
      margin: 8px 0;
      font-size: 14px;
    }

    .summary-row.total {
      border-top: 2px solid #2563eb;
      padding-top: 10px;
      margin-top: 10px;
      font-size: 18px;
      font-weight: bold;
      color: #1e40af;
    }

    .notes {
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

    .footer {
      margin-top: 50px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      color: #64748b;
      font-size: 12px;
    }

    .signature-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      margin-top: 50px;
      text-align: center;
    }

    .signature-box {
      padding: 20px;
    }

    .signature-title {
      font-weight: 600;
      margin-bottom: 60px;
      color: #1e293b;
    }

    .signature-line {
      border-top: 1px solid #94a3b8;
      margin-top: 10px;
      padding-top: 5px;
      color: #64748b;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="invoice-header">
    <div class="company-name">iHomeCRM</div>
    <div class="company-info">Hệ thống quản lý bất động sản</div>
  </div>

  <div class="invoice-title">${invoice.title || 'HÓA ĐƠN THANH TOÁN'}</div>

  <div class="invoice-meta">
    <div class="meta-group">
      <h3>Thông tin khách hàng</h3>
      <div class="meta-row">
        <span class="meta-label">Họ tên:</span>
        <span class="meta-value">${invoice.contract?.tenant?.full_name || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Số điện thoại:</span>
        <span class="meta-value">${invoice.contract?.tenant?.phone || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Căn hộ:</span>
        <span class="meta-value">${invoice.contract?.room?.name || invoice.contract?.bed?.name || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Hợp đồng:</span>
        <span class="meta-value">${invoice.contract?.contract_number || 'N/A'}</span>
      </div>
    </div>

    <div class="meta-group">
      <h3>Thông tin hóa đơn</h3>
      <div class="meta-row">
        <span class="meta-label">Số hóa đơn:</span>
        <span class="meta-value">${invoice.id.slice(0, 8).toUpperCase()}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Ngày phát hành:</span>
        <span class="meta-value">${invoice.issue_date ? format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi }) : 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Hạn thanh toán:</span>
        <span class="meta-value">${invoice.due_date ? format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi }) : 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Kỳ thanh toán:</span>
        <span class="meta-value">
          ${
            invoice.billing_period_start && invoice.billing_period_end
              ? `${format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })} - ${format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}`
              : 'N/A'
          }
        </span>
      </div>
    </div>
  </div>

  <table class="items-table">
    <thead>
      <tr>
        <th style="width: 5%;">STT</th>
        <th>Mô tả</th>
        <th style="width: 10%;" class="text-right">Số lượng</th>
        <th style="width: 15%;" class="text-right">Đơn giá</th>
        <th style="width: 18%;" class="text-right">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${
        invoice.invoice_items && invoice.invoice_items.length > 0
          ? invoice.invoice_items
              .map(
                (item, index) => `
        <tr>
          <td class="text-right">${index + 1}</td>
          <td>
            <div style="font-weight: 600;">${item.description}</div>
            <div class="item-type">${item.type}</div>
          </td>
          <td class="text-right">${item.quantity}</td>
          <td class="text-right">${formatCurrency(item.unit_price)}</td>
          <td class="text-right" style="font-weight: 600;">${formatCurrency(item.amount)}</td>
        </tr>
      `
              )
              .join('')
          : '<tr><td colspan="5" style="text-align: center; color: #64748b;">Không có khoản thu nào</td></tr>'
      }
      <tr class="total-row">
        <td colspan="4" class="text-right">TỔNG CỘNG:</td>
        <td class="text-right">${formatCurrency(invoice.total_amount || 0)}</td>
      </tr>
    </tbody>
  </table>

  <div class="summary-box">
    <div class="summary-row">
      <span>Tổng tiền:</span>
      <span>${formatCurrency(invoice.total_amount || 0)}</span>
    </div>
    <div class="summary-row">
      <span>Đã thanh toán:</span>
      <span style="color: #059669;">${formatCurrency(invoice.paid_amount || 0)}</span>
    </div>
    <div class="summary-row total">
      <span>Còn lại:</span>
      <span style="color: #dc2626;">${formatCurrency((invoice.total_amount || 0) - (invoice.paid_amount || 0))}</span>
    </div>
  </div>

  ${
    invoice.notes
      ? `
  <div class="notes">
    <div class="notes-title">Ghi chú:</div>
    <div class="notes-content">${invoice.notes}</div>
  </div>
  `
      : ''
  }

  <div class="signature-section">
    <div class="signature-box">
      <div class="signature-title">Người lập phiếu</div>
      <div class="signature-line">(Ký và ghi rõ họ tên)</div>
    </div>
    <div class="signature-box">
      <div class="signature-title">Khách hàng</div>
      <div class="signature-line">(Ký và ghi rõ họ tên)</div>
    </div>
  </div>

  <div class="footer">
    <div>Cảm ơn quý khách đã sử dụng dịch vụ!</div>
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
  <title>Hóa đơn ${invoice.title}</title>
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
      font-size: 14px;
      font-weight: bold;
      margin: 10px 0;
      text-transform: uppercase;
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

    .items-header {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      font-weight: bold;
      border-bottom: 1px solid #333;
      padding: 5px 0;
      font-size: 11px;
    }

    .item-row {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      padding: 5px 0;
      font-size: 11px;
    }

    .item-desc {
      grid-column: 1 / -1;
      font-weight: bold;
      margin-bottom: 2px;
    }

    .item-type {
      grid-column: 1 / -1;
      font-size: 10px;
      color: #666;
      margin-bottom: 3px;
    }

    .text-right {
      text-align: right;
    }

    .total-section {
      border-top: 2px solid #333;
      margin-top: 10px;
      padding-top: 10px;
    }

    .total-row {
      display: flex;
      justify-content: space-between;
      margin: 5px 0;
      font-size: 12px;
    }

    .total-row.grand {
      font-size: 14px;
      font-weight: bold;
      border-top: 1px dashed #333;
      padding-top: 5px;
      margin-top: 5px;
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
  </style>
</head>
<body>
  <div class="header">
    <div class="store-name">iHomeCRM</div>
    <div class="store-info">Hệ thống quản lý BĐS</div>
  </div>

  <div class="title">${invoice.title || 'HÓA ĐƠN'}</div>

  <div class="info-row">
    <span>Mã HĐ:</span>
    <span>${invoice.id.slice(0, 8).toUpperCase()}</span>
  </div>
  <div class="info-row">
    <span>Ngày:</span>
    <span>${invoice.issue_date ? format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi }) : 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>Hạn TT:</span>
    <span>${invoice.due_date ? format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi }) : 'N/A'}</span>
  </div>

  <div class="section-divider"></div>

  <div class="info-row">
    <span>Khách:</span>
    <span>${invoice.contract?.tenant?.full_name || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>SĐT:</span>
    <span>${invoice.contract?.tenant?.phone || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>Căn hộ:</span>
    <span>${invoice.contract?.room?.name || invoice.contract?.bed?.name || 'N/A'}</span>
  </div>

  <div class="section-divider"></div>

  <div class="items-header">
    <span>Mô tả</span>
    <span class="text-right">SL</span>
    <span class="text-right">Tiền</span>
  </div>

  ${
    invoice.invoice_items && invoice.invoice_items.length > 0
      ? invoice.invoice_items
          .map(
            (item) => `
    <div class="item-row">
      <div class="item-desc">${item.description}</div>
      <div class="item-type">${item.type}</div>
      <span>${item.quantity}</span>
      <span class="text-right">${formatCurrency(item.amount).replace('₫', '').trim()}</span>
    </div>
  `
          )
          .join('')
      : '<div style="text-align: center; color: #666;">Không có khoản thu</div>'
  }

  <div class="total-section">
    <div class="total-row">
      <span>Tổng:</span>
      <span>${formatCurrency(invoice.total_amount || 0)}</span>
    </div>
    <div class="total-row">
      <span>Đã trả:</span>
      <span>${formatCurrency(invoice.paid_amount || 0)}</span>
    </div>
    <div class="total-row grand">
      <span>Còn lại:</span>
      <span>${formatCurrency((invoice.total_amount || 0) - (invoice.paid_amount || 0))}</span>
    </div>
  </div>

  ${
    invoice.notes
      ? `
  <div class="notes">
    <strong>Ghi chú:</strong><br/>
    ${invoice.notes}
  </div>
  `
      : ''
  }

  <div class="footer">
    <div>Cảm ơn quý khách!</div>
    <div>${format(new Date(), 'dd/MM/yyyy HH:mm', { locale: vi })}</div>
  </div>
</body>
</html>
    `;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            In hóa đơn
          </DialogTitle>
          <DialogDescription>
            Chọn định dạng in cho hóa đơn: {invoice.title}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <RadioGroup value={printFormat} onValueChange={(value) => setPrintFormat(value as PrintFormat)}>
            <div className="flex items-center space-x-3 rounded-lg border p-4 hover:bg-gray-50 cursor-pointer">
              <RadioGroupItem value="A4" id="format-a4" />
              <Label
                htmlFor="format-a4"
                className="flex-1 cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-blue-600" />
                  <div>
                    <div className="font-medium">Khổ A4</div>
                    <div className="text-sm text-gray-500">Định dạng tiêu chuẩn, có đầy đủ thông tin</div>
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
                  <Receipt className="h-5 w-5 text-green-600" />
                  <div>
                    <div className="font-medium">Khổ 80mm (Thermal)</div>
                    <div className="text-sm text-gray-500">Phù hợp cho máy in nhiệt, in nhanh</div>
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
            In hóa đơn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PrintInvoiceDialog;
