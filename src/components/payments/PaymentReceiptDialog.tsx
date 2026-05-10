import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Printer } from "lucide-react";
import type { PaymentWithRelations } from "@/hooks/usePayments";
import { useDocumentTemplates } from "@/hooks/useDocumentTemplates";

interface PaymentReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: PaymentWithRelations;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  TM: "TM",
  TK: "TK",
  TT: "TT",
};

export function PaymentReceiptDialog({
  open,
  onOpenChange,
  payment,
}: PaymentReceiptDialogProps) {
  const receiptRef = useRef<HTMLDivElement>(null);
  const paymentType = (payment as any).type || "income";
  const isIncome = paymentType === "income";

  // Fetch receipt templates for printing
  const { data: templates = [] } = useDocumentTemplates("RECEIPT");

  const handlePrint = () => {
    const printContent = receiptRef.current;
    if (!printContent) return;

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.print();
      return;
    }

    printWindow.document.write(`
      <html>
        <head>
          <title>${isIncome ? "Phiếu thu" : "Phiếu chi"} - ${payment.receipt_number || ""}</title>
          <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; }
            .receipt-content { max-width: 800px; margin: 0 auto; }
            .text-center { text-align: center; }
            .font-bold { font-weight: bold; }
            .font-semibold { font-weight: 600; }
            .font-medium { font-weight: 500; }
            .text-sm { font-size: 0.875rem; }
            .text-xs { font-size: 0.75rem; }
            .text-lg { font-size: 1.125rem; }
            .text-2xl { font-size: 1.5rem; }
            .text-3xl { font-size: 1.875rem; }
            .text-muted { color: #6b7280; }
            .text-green { color: #16a34a; }
            .text-red { color: #dc2626; }
            .text-orange { color: #ea580c; }
            .border-b { border-bottom: 1px solid #e5e7eb; }
            .border-y { border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
            .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
            .col-span-2 { grid-column: span 2; }
            .col-span-3 { grid-column: span 3; }
            .space-y > * + * { margin-top: 0.75rem; }
            .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
            .pb-4 { padding-bottom: 1rem; }
            .pt-8 { padding-top: 2rem; }
            .mb-16 { margin-bottom: 4rem; }
            .mt-1 { margin-top: 0.25rem; }
            .p-4 { padding: 1rem; }
            .bg-muted { background-color: #f9fafb; border-radius: 0.5rem; }
            .italic { font-style: italic; }
            @media print { body { padding: 0; } }
          </style>
        </head>
        <body>
          ${printContent.innerHTML}
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const receiptTitle = isIncome ? "PHIẾU THU TIỀN" : "PHIẾU CHI TIỀN";
  const receiptLabel = isIncome ? "Phiếu thu tiền" : "Phiếu chi tiền";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{receiptLabel}</DialogTitle>
          <DialogDescription>
            Chi tiết {isIncome ? "phiếu thu" : "phiếu chi"} #{payment.receipt_number}
            {templates.length > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                ({templates.length} mẫu biểu có sẵn)
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Receipt Content */}
        <div ref={receiptRef} className="receipt-content border rounded-lg p-6 space-y-6 bg-white">
          {/* Header */}
          <div className="text-center border-b pb-4">
            <h2 className="text-2xl font-bold">{receiptTitle}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Số: {payment.receipt_number || "N/A"}
            </p>
            <p className="text-sm text-muted-foreground">
              Ngày: {payment.payment_date ? formatDate(payment.payment_date) : "-"}
            </p>
          </div>

          {/* Customer Info */}
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-3">
                <span className="text-sm text-muted-foreground">
                  {isIncome ? "Họ tên người nộp tiền:" : "Người nhận tiền:"}
                </span>
                <p className="font-semibold text-lg">
                  {payment.invoice?.contract?.tenant?.full_name || "-"}
                </p>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Số điện thoại:</span>
                <p className="font-medium">
                  {payment.invoice?.contract?.tenant?.phone || "-"}
                </p>
              </div>

              <div className="col-span-2">
                <span className="text-sm text-muted-foreground">Số hợp đồng:</span>
                <p className="font-medium">
                  {payment.invoice?.contract?.contract_number || "-"}
                </p>
              </div>
            </div>
          </div>

          {/* Payment Details */}
          <div className="border-y py-4 space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-sm text-muted-foreground">
                  {isIncome ? "Lý do thu:" : "Lý do chi:"}
                </span>
                <p className="font-medium">
                  {payment.invoice
                    ? `${isIncome ? "Thanh toán" : "Chi phí"} hóa đơn ${payment.invoice.invoice_number || ""}`
                    : payment.notes || "-"}
                </p>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Phương thức:</span>
                <p className="font-medium">
                  {PAYMENT_METHOD_LABELS[payment.payment_method] || payment.payment_method}
                </p>
              </div>
            </div>

            <div>
              <span className="text-sm text-muted-foreground">
                {isIncome ? "Số tiền thu:" : "Số tiền chi:"}
              </span>
              <p className={`text-3xl font-bold mt-1 ${isIncome ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(payment.amount)}
              </p>
              <p className="text-sm text-muted-foreground italic mt-1">
                Bằng chữ: {convertNumberToWords(payment.amount)} đồng
              </p>
            </div>

            {payment.notes && (
              <div>
                <span className="text-sm text-muted-foreground">Ghi chú:</span>
                <p className="font-medium">{payment.notes}</p>
              </div>
            )}
          </div>

          {/* Invoice Summary */}
          {payment.invoice && (
            <div className="bg-muted/30 p-4 rounded space-y-2">
              <h4 className="font-semibold text-sm">Thông tin hóa đơn liên kết</h4>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Tổng tiền:</span>
                  <p className="font-medium">
                    {formatCurrency(payment.invoice.total_amount)}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Đã thu:</span>
                  <p className="font-medium text-green-600">
                    {formatCurrency(payment.invoice.paid_amount)}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Còn lại:</span>
                  <p className="font-medium text-orange-600">
                    {formatCurrency(payment.invoice.remaining_amount)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Signatures */}
          <div className="grid grid-cols-2 gap-8 pt-8">
            <div className="text-center">
              <p className="font-semibold mb-16">
                {isIncome ? "Người nộp tiền" : "Người nhận tiền"}
              </p>
              <p className="text-sm text-muted-foreground">
                {payment.invoice?.contract?.tenant?.full_name || "(Ký và ghi rõ họ tên)"}
              </p>
            </div>
            <div className="text-center">
              <p className="font-semibold mb-16">
                {isIncome ? "Người thu tiền" : "Người chi tiền"}
              </p>
              <p className="text-sm text-muted-foreground">(Ký và ghi rõ họ tên)</p>
            </div>
          </div>
        </div>

        <DialogFooter className="print:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Đóng
          </Button>
          <Button onClick={handlePrint}>
            <Printer className="w-4 h-4 mr-2" />
            In {isIncome ? "phiếu thu" : "phiếu chi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to convert number to Vietnamese words
function convertNumberToWords(num: number): string {
  if (num === 0) return "Không";

  const ones = ["", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];
  const teens = ["mười", "mười một", "mười hai", "mười ba", "mười bốn", "mười lăm", "mười sáu", "mười bảy", "mười tám", "mười chín"];
  const tens = ["", "", "hai mươi", "ba mươi", "bốn mươi", "năm mươi", "sáu mươi", "bảy mươi", "tám mươi", "chín mươi"];
  const thousands = ["", "nghìn", "triệu", "tỷ"];

  function convertChunk(n: number): string {
    if (n === 0) return "";
    if (n < 10) return ones[n];
    if (n < 20) return teens[n - 10];
    if (n < 100) {
      const ten = Math.floor(n / 10);
      const one = n % 10;
      return tens[ten] + (one ? " " + ones[one] : "");
    }
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    return ones[hundred] + " trăm" + (remainder ? " " + convertChunk(remainder) : "");
  }

  let result = "";
  let chunkIndex = 0;

  while (num > 0) {
    const chunk = num % 1000;
    if (chunk !== 0) {
      const chunkWords = convertChunk(chunk);
      result = chunkWords + (thousands[chunkIndex] ? " " + thousands[chunkIndex] : "") + (result ? " " + result : "");
    }
    num = Math.floor(num / 1000);
    chunkIndex++;
  }

  return result.charAt(0).toUpperCase() + result.slice(1);
}
