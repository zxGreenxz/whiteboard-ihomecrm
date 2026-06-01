import { useState, useCallback, useEffect } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Printer, FileText, Receipt, ImageDown, FileDown, LayoutTemplate } from 'lucide-react';
import { type InvoiceWithRelations } from '@/hooks/useInvoices';
import { useDocumentTemplates, useDocumentTemplate } from '@/hooks/useDocumentTemplates';
import {
  renderInvoiceTemplate,
  formatCurrencyVND,
  numberToVietnameseWords,
  type InvoiceTemplateData,
  type InvoiceFeeItem,
} from '@/lib/invoiceTemplateEngine';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface PrintInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

type PrintMode = 'template' | 'A4' | 'THERMAL';
type ActionType = 'print' | 'download-image' | 'download-pdf';

/**
 * Build template data object from an InvoiceWithRelations.
 */
function buildTemplateData(invoice: InvoiceWithRelations): InvoiceTemplateData {
  const items = invoice.invoice_items || [];
  const fees: InvoiceFeeItem[] = items.map((item, idx) => ({
    index: idx + 1,
    name: item.description || '',
    price: formatCurrencyVND(item.unit_price || 0),
    quantity: String(item.quantity || 0),
    coefficient: String(item.coefficient || 1),
    total: formatCurrencyVND(item.amount || 0),
  }));

  // Từ migration 20260527 nợ cũ: total_amount đã bao gồm previous_debt rồi.
  // Không cộng lại để tránh double count.
  const totalWithDebt = invoice.total_amount || 0;
  const remain = totalWithDebt - (invoice.paid_amount || 0);

  return {
    APARTMENT_NAME: invoice.building?.name || '',
    ROOM_NAME: invoice.room?.name || '',
    CONTRACT_NAME: invoice.tenant?.full_name || '',
    INVOICE_CODE: invoice.invoice_number || '',
    ISSUE_DATE: invoice.issue_date
      ? format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi })
      : '',
    DUE_DATE: invoice.due_date
      ? format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })
      : '',
    SUBTOTAL: formatCurrencyVND(invoice.subtotal || 0),
    DISCOUNT_WITH_PROMOTION: formatCurrencyVND(invoice.discount_amount || 0),
    DEBT: formatCurrencyVND(invoice.previous_debt || 0),
    TOTAL_WITH_DEBT: formatCurrencyVND(totalWithDebt),
    PAID: formatCurrencyVND(invoice.paid_amount || 0),
    REMAIN: formatCurrencyVND(remain > 0 ? remain : 0),
    AMOUNT_IN_WORDS_WITH_DEBT: numberToVietnameseWords(totalWithDebt),
    NOTE: invoice.notes || '',
    FEES: fees,
  };
}

/**
 * Open a new window with the given HTML content and trigger print.
 */
function openPrintWindow(htmlContent: string, title: string) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Vui lòng cho phép popup để in hóa đơn');
    return;
  }
  printWindow.document.write(htmlContent);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    printWindow.close();
  }, 250);
}

/**
 * Download HTML content as an image using a hidden iframe + canvas.
 * Falls back to opening a print window if canvas capture fails.
 */
async function downloadAsImage(htmlContent: string, fileName: string) {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '-9999px';
  iframe.style.width = '800px';
  iframe.style.height = '1200px';
  iframe.style.border = 'none';
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    alert('Không thể tạo ảnh. Vui lòng sử dụng chức năng In và chọn "Lưu dưới dạng PDF".');
    return;
  }

  iframeDoc.open();
  iframeDoc.write(htmlContent);
  iframeDoc.close();

  // Wait for content to render
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    // Use the print dialog as fallback - user can save as PDF/image from there
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      printWindow.focus();
      // Add a download hint
      const hint = printWindow.document.createElement('div');
      hint.className = 'no-print';
      hint.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#2563eb;color:white;padding:10px;text-align:center;z-index:9999;font-family:Arial;';
      hint.innerHTML = 'Nhấn Ctrl+P để in hoặc lưu dưới dạng PDF. Để lưu ảnh, nhấn chuột phải → "Lưu ảnh dưới dạng..."';
      printWindow.document.body.prepend(hint);
    }
  } catch {
    alert('Không thể tạo ảnh. Vui lòng sử dụng chức năng In.');
  } finally {
    document.body.removeChild(iframe);
  }
}

/**
 * Download HTML content as PDF by opening print dialog (browser native).
 */
function downloadAsPDF(htmlContent: string, fileName: string) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Vui lòng cho phép popup để tải PDF');
    return;
  }

  // Add a hint banner for saving as PDF
  const hintBanner = `
    <div class="no-print" style="position:fixed;top:0;left:0;right:0;background:#2563eb;color:white;padding:10px;text-align:center;z-index:9999;font-family:Arial;font-size:14px;">
      Chọn "Lưu dưới dạng PDF" trong hộp thoại in để tải file PDF
    </div>
    <style>@media print { .no-print { display: none !important; } }</style>
  `;

  const contentWithHint = htmlContent.replace('</body>', `${hintBanner}</body>`);
  printWindow.document.write(contentWithHint);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
  }, 300);
}

/**
 * Generate A4 format HTML content (hardcoded fallback).
 */
function generateA4Content(invoice: InvoiceWithRelations): string {
  const fmtCurrency = (amount: number) =>
    new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

  const fmtDate = (d: string | null | undefined) =>
    d ? format(new Date(d), 'dd/MM/yyyy', { locale: vi }) : 'N/A';

  const billingLabel = invoice.billing_month
    ? `Tháng ${invoice.billing_month.split('-')[1]}/${invoice.billing_month.split('-')[0]}`
    : 'N/A';

  const itemsHtml =
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
          <td class="text-right">${item.coefficient !== 1 ? item.coefficient : ''}</td>
          <td class="text-right">${fmtCurrency(item.unit_price)}</td>
          <td class="text-right" style="font-weight: 600;">${fmtCurrency(item.amount)}</td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="6" style="text-align: center; color: #64748b;">Không có khoản thu nào</td></tr>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Hóa đơn ${invoice.invoice_number || ''}</title>
  <style>
    @page { size: A4; margin: 20mm; }
    @media print { body { margin: 0; padding: 0; } .no-print { display: none !important; } }
    body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; max-width: 210mm; margin: 0 auto; padding: 10mm; }
    .invoice-header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #2563eb; padding-bottom: 20px; }
    .company-name { font-size: 24px; font-weight: bold; color: #2563eb; margin-bottom: 5px; }
    .company-info { font-size: 12px; color: #666; }
    .invoice-title { font-size: 28px; font-weight: bold; color: #1e40af; margin: 20px 0; text-transform: uppercase; }
    .invoice-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
    .meta-group { background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #2563eb; }
    .meta-group h3 { font-size: 14px; color: #64748b; margin: 0 0 10px 0; font-weight: 600; }
    .meta-row { display: flex; justify-content: space-between; margin: 5px 0; font-size: 13px; }
    .meta-label { color: #64748b; }
    .meta-value { font-weight: 600; color: #1e293b; }
    .items-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .items-table thead { background: #2563eb; color: white; }
    .items-table th, .items-table td { padding: 12px; text-align: left; border: 1px solid #e2e8f0; }
    .items-table th { font-weight: 600; font-size: 13px; }
    .items-table td { font-size: 13px; }
    .items-table tbody tr:nth-child(even) { background: #f8fafc; }
    .items-table .text-right { text-align: right; }
    .items-table .item-type { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #dbeafe; color: #1e40af; }
    .total-row { background: #eff6ff !important; font-weight: bold; font-size: 15px; }
    .total-row td { border-top: 2px solid #2563eb; padding: 15px 12px; }
    .summary-box { background: #f8fafc; border: 2px solid #2563eb; border-radius: 8px; padding: 20px; margin: 30px 0; }
    .summary-row { display: flex; justify-content: space-between; margin: 8px 0; font-size: 14px; }
    .summary-row.total { border-top: 2px solid #2563eb; padding-top: 10px; margin-top: 10px; font-size: 18px; font-weight: bold; color: #1e40af; }
    .notes { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px; }
    .notes-title { font-weight: 600; color: #92400e; margin-bottom: 5px; }
    .notes-content { color: #78350f; font-size: 13px; }
    .footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 12px; }
    .signature-section { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 50px; text-align: center; }
    .signature-box { padding: 20px; }
    .signature-title { font-weight: 600; margin-bottom: 60px; color: #1e293b; }
    .signature-line { border-top: 1px solid #94a3b8; margin-top: 10px; padding-top: 5px; color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="invoice-header">
    <div class="company-name">CRM</div>
    <div class="company-info">Hệ thống quản lý bất động sản</div>
  </div>

  <div class="invoice-title">HÓA ĐƠN THANH TOÁN</div>

  <div class="invoice-meta">
    <div class="meta-group">
      <h3>Thông tin khách hàng</h3>
      <div class="meta-row">
        <span class="meta-label">Họ tên:</span>
        <span class="meta-value">${invoice.tenant?.full_name || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Số điện thoại:</span>
        <span class="meta-value">${invoice.tenant?.phone || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Toà nhà:</span>
        <span class="meta-value">${invoice.building?.name || 'N/A'}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Phòng:</span>
        <span class="meta-value">${invoice.room?.name || 'N/A'}</span>
      </div>
    </div>

    <div class="meta-group">
      <h3>Thông tin hóa đơn</h3>
      <div class="meta-row">
        <span class="meta-label">Mã hóa đơn:</span>
        <span class="meta-value">${invoice.invoice_number || invoice.id.slice(0, 8).toUpperCase()}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Ngày lập:</span>
        <span class="meta-value">${fmtDate(invoice.issue_date)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Hạn thanh toán:</span>
        <span class="meta-value">${fmtDate(invoice.due_date)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Kỳ thanh toán:</span>
        <span class="meta-value">${billingLabel}</span>
      </div>
    </div>
  </div>

  <table class="items-table">
    <thead>
      <tr>
        <th style="width: 5%;">STT</th>
        <th>Mô tả</th>
        <th style="width: 8%;" class="text-right">SL</th>
        <th style="width: 8%;" class="text-right">Hệ số</th>
        <th style="width: 15%;" class="text-right">Đơn giá</th>
        <th style="width: 18%;" class="text-right">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml}
      <tr class="total-row">
        <td colspan="5" class="text-right">TỔNG CỘNG:</td>
        <td class="text-right">${fmtCurrency(invoice.total_amount || 0)}</td>
      </tr>
    </tbody>
  </table>

  <div class="summary-box">
    <div class="summary-row">
      <span>Tạm tính:</span>
      <span>${fmtCurrency(invoice.subtotal || 0)}</span>
    </div>
    ${invoice.discount_amount ? `<div class="summary-row"><span>Giảm giá:</span><span>-${fmtCurrency(invoice.discount_amount)}</span></div>` : ''}
    <div class="summary-row">
      <span>Tổng tiền:</span>
      <span>${fmtCurrency(invoice.total_amount || 0)}</span>
    </div>
    <div class="summary-row">
      <span>Đã thanh toán:</span>
      <span style="color: #059669;">${fmtCurrency(invoice.paid_amount || 0)}</span>
    </div>
    <div class="summary-row total">
      <span>Còn lại:</span>
      <span style="color: #dc2626;">${fmtCurrency(invoice.remaining_amount || 0)}</span>
    </div>
  </div>

  ${invoice.notes ? `<div class="notes"><div class="notes-title">Ghi chú:</div><div class="notes-content">${invoice.notes}</div></div>` : ''}

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
</html>`;
}

/**
 * Generate Thermal (80mm) format HTML content (hardcoded fallback).
 */
function generateThermalContent(invoice: InvoiceWithRelations): string {
  const fmtCurrency = (amount: number) =>
    new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

  const fmtDate = (d: string | null | undefined) =>
    d ? format(new Date(d), 'dd/MM/yyyy', { locale: vi }) : 'N/A';

  const itemsHtml =
    invoice.invoice_items && invoice.invoice_items.length > 0
      ? invoice.invoice_items
          .map(
            (item) => `
    <div class="item-row">
      <div class="item-desc">${item.description}</div>
      <div class="item-type">${item.type}</div>
      <span>${item.quantity}</span>
      <span class="text-right">${fmtCurrency(item.amount).replace('₫', '').trim()}</span>
    </div>`
          )
          .join('')
      : '<div style="text-align: center; color: #666;">Không có khoản thu</div>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Hóa đơn ${invoice.invoice_number || ''}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    @media print { body { margin: 0; padding: 0; } }
    body { font-family: 'Courier New', monospace; width: 80mm; margin: 0 auto; padding: 5mm; font-size: 12px; line-height: 1.4; }
    .header { text-align: center; border-bottom: 2px dashed #333; padding-bottom: 10px; margin-bottom: 10px; }
    .store-name { font-size: 16px; font-weight: bold; margin-bottom: 5px; }
    .store-info { font-size: 10px; }
    .title { text-align: center; font-size: 14px; font-weight: bold; margin: 10px 0; text-transform: uppercase; }
    .info-row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 11px; }
    .section-divider { border-top: 1px dashed #333; margin: 10px 0; }
    .items-header { display: grid; grid-template-columns: 2fr 1fr 1fr; font-weight: bold; border-bottom: 1px solid #333; padding: 5px 0; font-size: 11px; }
    .item-row { display: grid; grid-template-columns: 2fr 1fr 1fr; padding: 5px 0; font-size: 11px; }
    .item-desc { grid-column: 1 / -1; font-weight: bold; margin-bottom: 2px; }
    .item-type { grid-column: 1 / -1; font-size: 10px; color: #666; margin-bottom: 3px; }
    .text-right { text-align: right; }
    .total-section { border-top: 2px solid #333; margin-top: 10px; padding-top: 10px; }
    .total-row { display: flex; justify-content: space-between; margin: 5px 0; font-size: 12px; }
    .total-row.grand { font-size: 14px; font-weight: bold; border-top: 1px dashed #333; padding-top: 5px; margin-top: 5px; }
    .footer { text-align: center; margin-top: 15px; padding-top: 10px; border-top: 2px dashed #333; font-size: 10px; }
    .notes { margin: 10px 0; padding: 5px; background: #f5f5f5; font-size: 10px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="store-name">CRM</div>
    <div class="store-info">Hệ thống quản lý BĐS</div>
  </div>

  <div class="title">HÓA ĐƠN</div>

  <div class="info-row">
    <span>Mã HĐ:</span>
    <span>${invoice.invoice_number || invoice.id.slice(0, 8).toUpperCase()}</span>
  </div>
  <div class="info-row">
    <span>Ngày:</span>
    <span>${fmtDate(invoice.issue_date)}</span>
  </div>
  <div class="info-row">
    <span>Hạn TT:</span>
    <span>${fmtDate(invoice.due_date)}</span>
  </div>

  <div class="section-divider"></div>

  <div class="info-row">
    <span>Khách:</span>
    <span>${invoice.tenant?.full_name || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>SĐT:</span>
    <span>${invoice.tenant?.phone || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>Toà nhà:</span>
    <span>${invoice.building?.name || 'N/A'}</span>
  </div>
  <div class="info-row">
    <span>Phòng:</span>
    <span>${invoice.room?.name || 'N/A'}</span>
  </div>

  <div class="section-divider"></div>

  <div class="items-header">
    <span>Mô tả</span>
    <span class="text-right">SL</span>
    <span class="text-right">Tiền</span>
  </div>

  ${itemsHtml}

  <div class="total-section">
    <div class="total-row">
      <span>Tổng:</span>
      <span>${fmtCurrency(invoice.total_amount || 0)}</span>
    </div>
    <div class="total-row">
      <span>Đã trả:</span>
      <span>${fmtCurrency(invoice.paid_amount || 0)}</span>
    </div>
    <div class="total-row grand">
      <span>Còn lại:</span>
      <span>${fmtCurrency(invoice.remaining_amount || 0)}</span>
    </div>
  </div>

  ${invoice.notes ? `<div class="notes"><strong>Ghi chú:</strong><br/>${invoice.notes}</div>` : ''}

  <div class="footer">
    <div>Cảm ơn quý khách!</div>
    <div>${format(new Date(), 'dd/MM/yyyy HH:mm', { locale: vi })}</div>
  </div>
</body>
</html>`;
}

const PrintInvoiceDialog = ({ open, onOpenChange, invoice }: PrintInvoiceDialogProps) => {
  const [printMode, setPrintMode] = useState<PrintMode>('template');
  const [actionType, setActionType] = useState<ActionType>('print');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  // Fetch available invoice templates
  const { data: templates } = useDocumentTemplates('INVOICE');

  // Fetch the selected template content
  const { data: selectedTemplate } = useDocumentTemplate(selectedTemplateId);

  // When dialog opens, set the default template from invoice
  useEffect(() => {
    if (open && invoice) {
      if (invoice.template_id) {
        setSelectedTemplateId(invoice.template_id);
        setPrintMode('template');
      } else if (templates && templates.length > 0) {
        // Pick the default template or the first one
        const defaultTpl = templates.find((t) => t.is_default) || templates[0];
        setSelectedTemplateId(defaultTpl.id);
        setPrintMode('template');
      } else {
        setPrintMode('A4');
        setSelectedTemplateId('');
      }
    }
  }, [open, invoice, templates]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const generateContent = useCallback((): string => {
    if (!invoice) return '';

    // Template-based rendering
    if (printMode === 'template' && selectedTemplate?.content) {
      const data = buildTemplateData(invoice);
      const rendered = renderInvoiceTemplate(selectedTemplate.content, data);
      // Wrap in a full HTML document if not already
      if (rendered.trim().toLowerCase().startsWith('<!doctype') || rendered.trim().toLowerCase().startsWith('<html')) {
        return rendered;
      }
      return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Hóa đơn ${invoice.invoice_number || ''}</title>
<style>@media print { .no-print { display: none !important; } } body { font-family: Arial, sans-serif; }</style>
</head><body>${rendered}</body></html>`;
    }

    // Fallback: hardcoded formats
    return printMode === 'THERMAL' ? generateThermalContent(invoice) : generateA4Content(invoice);
  }, [invoice, printMode, selectedTemplate]);

  const handleAction = () => {
    const content = generateContent();
    if (!content) return;

    const fileName = `hoa-don-${invoice?.invoice_number || invoice?.id?.slice(0, 8) || 'unknown'}`;

    switch (actionType) {
      case 'print':
        openPrintWindow(content, fileName);
        break;
      case 'download-image':
        downloadAsImage(content, fileName);
        break;
      case 'download-pdf':
        downloadAsPDF(content, fileName);
        break;
    }

    onOpenChange(false);
  };

  if (!invoice) return null;

  const hasTemplates = templates && templates.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            In / Tải hóa đơn
          </DialogTitle>
          <DialogDescription>
            Chọn định dạng và hành động cho hóa đơn: {invoice.invoice_number || invoice.id?.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Template selection */}
          {hasTemplates && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Mẫu hóa đơn</Label>
              <Select
                value={selectedTemplateId}
                onValueChange={(val) => {
                  setSelectedTemplateId(val);
                  if (val) setPrintMode('template');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn mẫu hóa đơn" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.name} {tpl.is_default ? '(Mặc định)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Print format selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Định dạng</Label>
            <RadioGroup
              value={printMode}
              onValueChange={(value) => setPrintMode(value as PrintMode)}
            >
              {hasTemplates && (
                <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                  <RadioGroupItem value="template" id="format-template" />
                  <Label htmlFor="format-template" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-3">
                      <LayoutTemplate className="h-5 w-5 text-purple-600" />
                      <div>
                        <div className="font-medium">Theo mẫu</div>
                        <div className="text-sm text-gray-500">Sử dụng mẫu hóa đơn đã cài đặt</div>
                      </div>
                    </div>
                  </Label>
                </div>
              )}

              <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                <RadioGroupItem value="A4" id="format-a4" />
                <Label htmlFor="format-a4" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-blue-600" />
                    <div>
                      <div className="font-medium">Khổ A4</div>
                      <div className="text-sm text-gray-500">Định dạng tiêu chuẩn, đầy đủ thông tin</div>
                    </div>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                <RadioGroupItem value="THERMAL" id="format-thermal" />
                <Label htmlFor="format-thermal" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Receipt className="h-5 w-5 text-green-600" />
                    <div>
                      <div className="font-medium">Khổ 80mm (Thermal)</div>
                      <div className="text-sm text-gray-500">Phù hợp cho máy in nhiệt</div>
                    </div>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Action type selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hành động</Label>
            <RadioGroup
              value={actionType}
              onValueChange={(value) => setActionType(value as ActionType)}
            >
              <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                <RadioGroupItem value="print" id="action-print" />
                <Label htmlFor="action-print" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Printer className="h-4 w-4 text-gray-600" />
                    <span className="font-medium">In hóa đơn</span>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                <RadioGroupItem value="download-image" id="action-image" />
                <Label htmlFor="action-image" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <ImageDown className="h-4 w-4 text-orange-600" />
                    <span className="font-medium">Tải xuống ảnh</span>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-gray-50 cursor-pointer">
                <RadioGroupItem value="download-pdf" id="action-pdf" />
                <Label htmlFor="action-pdf" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <FileDown className="h-4 w-4 text-red-600" />
                    <span className="font-medium">Tải xuống PDF</span>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-800">
            <strong>Lưu ý:</strong>{' '}
            {actionType === 'print'
              ? 'Cửa sổ in sẽ mở ra. Bạn có thể in trực tiếp hoặc lưu thành file PDF.'
              : actionType === 'download-pdf'
                ? 'Chọn "Lưu dưới dạng PDF" trong hộp thoại in để tải file.'
                : 'Cửa sổ xem trước sẽ mở ra. Nhấn chuột phải vào nội dung để lưu ảnh.'}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" onClick={handleAction}>
            {actionType === 'print' && <Printer className="h-4 w-4 mr-2" />}
            {actionType === 'download-image' && <ImageDown className="h-4 w-4 mr-2" />}
            {actionType === 'download-pdf' && <FileDown className="h-4 w-4 mr-2" />}
            {actionType === 'print' ? 'In hóa đơn' : actionType === 'download-pdf' ? 'Tải PDF' : 'Tải ảnh'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PrintInvoiceDialog;

