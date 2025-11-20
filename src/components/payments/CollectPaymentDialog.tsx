import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useCreatePayment } from "@/hooks/usePayments";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { Card } from "@/components/ui/card";

const paymentSchema = z.object({
  invoice_id: z.string().min(1, "Phải chọn hóa đơn"),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "MOMO", "ZALO_PAY", "CREDIT_CARD", "OTHER"]),
  payment_date: z.string().min(1, "Ngày thanh toán là bắt buộc"),
  receipt_number: z.string().optional(),
  notes: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

interface CollectPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preSelectedInvoiceId?: string;
}

export function CollectPaymentDialog({
  open,
  onOpenChange,
  preSelectedInvoiceId,
}: CollectPaymentDialogProps) {
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const createPayment = useCreatePayment();

  // Fetch unpaid/partial paid invoices
  const { data: invoices = [] } = useQuery({
    queryKey: ["unpaid-invoices"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          contract:contracts!invoices_contract_id_fkey (
            contract_number,
            tenant:tenants!contracts_tenant_id_fkey (
              full_name, phone
            )
          )
        `)
        .eq('user_id', user.id)
        .in("status", ["APPROVED", "PARTIAL_PAID"])
        .order("issue_date", { ascending: false });

      if (error) throw error;
      return data;
    },
  });

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      invoice_id: preSelectedInvoiceId || "",
      amount: 0,
      payment_method: "CASH",
      payment_date: new Date().toISOString().split('T')[0],
      receipt_number: "",
      notes: "",
    },
  });

  // Update selected invoice when invoice_id changes
  useEffect(() => {
    const invoiceId = form.watch("invoice_id");
    if (invoiceId) {
      const invoice = invoices.find((inv) => inv.id === invoiceId);
      setSelectedInvoice(invoice);

      // Auto-fill amount with remaining amount
      if (invoice) {
        form.setValue("amount", invoice.remaining_amount || 0);
      }
    }
  }, [form.watch("invoice_id"), invoices]);

  const onSubmit = async (data: PaymentFormValues) => {
    try {
      // Generate receipt number if not provided
      const receiptNumber = data.receipt_number || `PT${Date.now()}`;

      await createPayment.mutateAsync({
        invoice_id: data.invoice_id,
        amount: data.amount,
        payment_method: data.payment_method,
        payment_date: data.payment_date,
        receipt_number: receiptNumber,
        notes: data.notes || null,
      });

      form.reset();
      setSelectedInvoice(null);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create payment:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Thu tiền</DialogTitle>
          <DialogDescription>
            Ghi nhận khoản thanh toán từ khách thuê
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Invoice Selection */}
            <FormField
              control={form.control}
              name="invoice_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hóa đơn *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn hóa đơn cần thu" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {invoices.map((invoice) => (
                        <SelectItem key={invoice.id} value={invoice.id}>
                          {invoice.invoice_number} - {invoice.contract?.tenant?.full_name} -
                          Còn lại: {formatCurrency(invoice.remaining_amount)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Invoice Summary */}
            {selectedInvoice && (
              <Card className="p-4 bg-muted/50">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Khách thuê:</span>
                    <p className="font-medium">{selectedInvoice.contract?.tenant?.full_name}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Số HĐ:</span>
                    <p className="font-medium">{selectedInvoice.contract?.contract_number}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Tổng tiền:</span>
                    <p className="font-medium">{formatCurrency(selectedInvoice.total_amount)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Đã thu:</span>
                    <p className="font-medium text-green-600">
                      {formatCurrency(selectedInvoice.paid_amount)}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Còn lại:</span>
                    <p className="font-bold text-lg text-orange-600">
                      {formatCurrency(selectedInvoice.remaining_amount)}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* Payment Details */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số tiền thu *</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="payment_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày thu *</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="payment_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phương thức *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phương thức" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="CASH">Tiền mặt</SelectItem>
                        <SelectItem value="BANK_TRANSFER">Chuyển khoản</SelectItem>
                        <SelectItem value="MOMO">MoMo</SelectItem>
                        <SelectItem value="ZALO_PAY">ZaloPay</SelectItem>
                        <SelectItem value="CREDIT_CARD">Thẻ tín dụng</SelectItem>
                        <SelectItem value="OTHER">Khác</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="receipt_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số phiếu thu (tùy chọn)</FormLabel>
                    <FormControl>
                      <Input placeholder="Tự động tạo nếu để trống" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea {...field} className="min-h-[60px]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={createPayment.isPending}>
                {createPayment.isPending ? "Đang lưu..." : "Thu tiền"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
