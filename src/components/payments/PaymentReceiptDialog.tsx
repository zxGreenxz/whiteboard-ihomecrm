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

interface PaymentReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: PaymentWithRelations;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  MOMO: "MoMo",
  ZALO_PAY: "ZaloPay",
  CREDIT_CARD: "Thẻ tín dụng",
  OTHER: "Khác",
};

export function PaymentReceiptDialog({
  open,
  onOpenChange,
  payment,
}: PaymentReceiptDialogProps) {
  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Phiếu thu tiền</DialogTitle>
          <DialogDescription>
            Chi tiết phiếu thu #{payment.receipt_number}
          </DialogDescription>
        </DialogHeader>

        {/* Receipt Content */}
        <div className="receipt-content border rounded-lg p-6 space-y-6 bg-white">
          {/* Header */}
          <div className="text-center border-b pb-4">
            <h2 className="text-2xl font-bold">PHIẾU THU TIỀN</h2>
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
                <span className="text-sm text-muted-foreground">Họ tên người nộp tiền:</span>
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
                <span className="text-sm text-muted-foreground">Lý do thu:</span>
                <p className="font-medium">
                  Thanh toán hóa đơn {payment.invoice?.invoice_number || ""}
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
              <span className="text-sm text-muted-foreground">Số tiền thu:</span>
              <p className="text-3xl font-bold text-green-600 mt-1">
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
              <h4 className="font-semibold text-sm">Thông tin hóa đơn</h4>
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
              <p className="font-semibold mb-16">Người nộp tiền</p>
              <p className="text-sm text-muted-foreground">
                {payment.invoice?.contract?.tenant?.full_name}
              </p>
            </div>
            <div className="text-center">
              <p className="font-semibold mb-16">Người thu tiền</p>
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
            In phiếu thu
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
