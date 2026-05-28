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
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCreatePayment } from "@/hooks/usePayments";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";

const paymentSchema = z.object({
  type: z.enum(["income", "expense"]),
  invoice_id: z.string().optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  payment_method: z.enum(["TM", "TK", "TT"]),
  payment_date: z.string().min(1, "Ngày thanh toán là bắt buộc"),
  receipt_number: z.string().optional(),
  income_expense_type_id: z.string().optional(),
  notes: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

interface CollectPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preSelectedInvoiceId?: string;
  defaultType?: "income" | "expense";
}

export function CollectPaymentDialog({
  open,
  onOpenChange,
  preSelectedInvoiceId,
  defaultType = "income",
}: CollectPaymentDialogProps) {
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const createPayment = useCreatePayment();
  const { data: user } = useAuth();

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      type: defaultType,
      invoice_id: preSelectedInvoiceId || "",
      amount: 0,
      payment_method: "TM",
      payment_date: new Date().toISOString().split('T')[0],
      receipt_number: "",
      income_expense_type_id: "",
      notes: "",
    },
  });

  const watchType = form.watch("type");

  // Fetch income_expense_types based on selected type
  const { data: incomeExpenseTypes = [] } = useIncomeExpenseTypes(watchType);

  // Check auto-approve setting
  const { data: autoApproveSetting } = useQuery({
    queryKey: ["settings", "payment_auto_approve", user?.id],
    queryFn: async () => {
      if (!user?.id) return false;
      const { data, error } = await supabase
        .from("settings")
        .select("value")
        .eq("user_id", user.id)
        .eq("key", "payment_auto_approve")
        .maybeSingle();
      if (error || !data) return false;
      return data.value === true || data.value === "true";
    },
    enabled: !!user?.id,
  });

  // Fetch unpaid/partial paid invoices (for income type)
  const { data: invoices = [] } = useQuery({
    queryKey: ["unpaid-invoices"],
    queryFn: async () => {
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
        .in("status", ["APPROVED", "PARTIAL_PAID"])
        .order("issue_date", { ascending: false });

      if (error) throw error;
      return data;
    },
  });

  // Reset form when dialog opens with new defaultType
  useEffect(() => {
    if (open) {
      form.reset({
        type: defaultType,
        invoice_id: preSelectedInvoiceId || "",
        amount: 0,
        payment_method: "TM",
        payment_date: new Date().toISOString().split('T')[0],
        receipt_number: "",
        income_expense_type_id: "",
        notes: "",
      });
      setSelectedInvoice(null);
    }
  }, [open, defaultType]);

  // Update selected invoice when invoice_id changes
  useEffect(() => {
    const invoiceId = form.watch("invoice_id");
    if (invoiceId) {
      const invoice = invoices.find((inv) => inv.id === invoiceId);
      setSelectedInvoice(invoice);
      if (invoice) {
        form.setValue("amount", invoice.remaining_amount || 0);
      }
    } else {
      setSelectedInvoice(null);
    }
  }, [form.watch("invoice_id"), invoices]);

  const onSubmit = async (data: PaymentFormValues) => {
    try {
      const receiptPrefix = data.type === "income" ? "PT" : "PC";
      const receiptNumber = data.receipt_number || `${receiptPrefix}${Date.now()}`;

      await createPayment.mutateAsync({
        invoice_id: data.invoice_id || null as any,
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

  const isIncome = watchType === "income";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isIncome ? "Tạo phiếu thu" : "Tạo phiếu chi"}</DialogTitle>
          <DialogDescription>
            {isIncome
              ? "Ghi nhận khoản thu từ khách hàng"
              : "Ghi nhận khoản chi phí phát sinh"}
            {autoApproveSetting && (
              <span className="ml-2 text-green-600 font-medium">
                (Tự động duyệt đang bật)
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Type Selection */}
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn loại thu/chi" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="income">Thu</SelectItem>
                      <SelectItem value="expense">Chi</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Income Expense Type from Danh mục khác */}
            <FormField
              control={form.control}
              name="income_expense_type_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại thu chi</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || ""}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn loại thu chi (từ Danh mục khác)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="">Không chọn</SelectItem>
                      {incomeExpenseTypes.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Invoice Selection (only for income) */}
            {isIncome && (
              <FormField
                control={form.control}
                name="invoice_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Liên kết hóa đơn</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn hóa đơn liên kết (tùy chọn)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Không liên kết</SelectItem>
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
            )}

            {/* Invoice Summary */}
            {selectedInvoice && isIncome && (
              <Card className="p-4 bg-muted/50">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Khách hàng:</span>
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
                    <FormLabel>Số tiền *</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        placeholder="Nhập số tiền"
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
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
                    <FormLabel>Ngày *</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
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
                    <FormLabel>Phương thức thanh toán *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phương thức" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="TM">TM</SelectItem>
                        <SelectItem value="TK">TK</SelectItem>
                        <SelectItem value="TT">TT</SelectItem>
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
                    <FormLabel>Số phiếu {isIncome ? "thu" : "chi"} (tùy chọn)</FormLabel>
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
                    <Textarea
                      placeholder="Nhập ghi chú cho phiếu thu/chi..."
                      {...field}
                      className="min-h-[60px]"
                    />
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
                {createPayment.isPending
                  ? "Đang lưu..."
                  : isIncome
                    ? "Tạo phiếu thu"
                    : "Tạo phiếu chi"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
