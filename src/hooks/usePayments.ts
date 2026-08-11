import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import {
  deriveInvoiceDepositDue,
  planInvoiceCollection,
  recordInvoiceCollectionV5,
} from "@/lib/paymentRecordRpc";
import { rpcNullable } from "@/lib/rpcNullable";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

type Payment = Database["public"]["Tables"]["payments"]["Row"];
type PaymentInsert = Database["public"]["Tables"]["payments"]["Insert"];

type CreatePaymentInput = PaymentInsert & {
  account_id?: string | null;
  account_is_virtual?: boolean | null;
  invoice_total_amount?: number;
  expected_paid_amount?: number;
  deposit_due?: number;
  has_contract?: boolean;
  idempotency_key?: string;
};

export interface PaymentWithRelations extends Payment {
  invoice?: {
    id: string;
    invoice_number: string | null;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    contract?: {
      id: string;
      contract_number: string | null;
      tenant?: {
        id: string;
        full_name: string;
        phone: string | null;
      };
    };
  };
}

// Fetch all active payment rows applied to invoices (paged, no cap-1000).
export const usePayments = (filters?: {
  start_date?: string;
  end_date?: string;
  payment_method?: string;
}) => {
  return useQuery({
    queryKey: ["payments", filters],
    queryFn: async (): Promise<PaymentWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const data = await fetchAllRows<PaymentWithRelations>(
        (from, to) => {
          let query = supabase
            .from("payments")
            .select(`
              *,
              invoice:invoices!payments_invoice_id_fkey (
                id, invoice_number, total_amount, paid_amount, remaining_amount,
                contract:contracts!invoices_contract_id_fkey (
                  id, contract_number,
                  tenant:tenants!contracts_tenant_id_fkey (
                    id, full_name, phone
                  )
                )
              )
            `)
            .is("reversed_at" as any, null);
          if (filters?.start_date) query = query.gte("payment_date", filters.start_date);
          if (filters?.end_date) query = query.lte("payment_date", filters.end_date);
          if (filters?.payment_method) {
            query = query.eq("payment_method", filters.payment_method as any);
          }
          return query
            .order("payment_date", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as any;
        },
        { label: "payments.list" },
      );

      if (data === null) {
        toast.error("Không thể tải danh sách thanh toán");
        throw new Error("Không thể tải danh sách thanh toán");
      }

      return data;
    },
  });
};

// Fetch single payment
export const usePayment = (id: string) => {
  return useQuery({
    queryKey: ["payments", id],
    queryFn: async (): Promise<PaymentWithRelations> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("payments")
        .select(`
          *,
          invoice:invoices!payments_invoice_id_fkey (
            id, invoice_number, total_amount, paid_amount, remaining_amount,
            contract:contracts!invoices_contract_id_fkey (
              id, contract_number,
              tenant:tenants!contracts_tenant_id_fkey (
                id, full_name, phone
              )
            )
          )
        `)
        .eq("id", id)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin thanh toán");
        throw error;
      }

      return data as PaymentWithRelations;
    },
    enabled: !!id,
  });
};

// Create payment
export const useCreatePayment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreatePaymentInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Invoice-linked writes are V5-only: one atomic collection, one stable key.
      if (data.invoice_id) {
        if (!data.account_id) throw new Error("Vui lòng chọn sổ quỹ nhận tiền");
        // `payment_date`/`payment_method` là tuỳ chọn trong `payments.Insert` vì
        // bảng có DEFAULT — nhưng đường V5 KHÔNG dùng default của bảng, nó gửi
        // hai giá trị này thẳng xuống RPC. Thiếu thì `normalizeCollectionInput`
        // / `normalizeTender` vẫn ném, chỉ là ném muộn hơn và với thông báo nói
        // về "ngày thu không hợp lệ" thay vì "chưa chọn". Kiểm ngay tại đây để
        // lỗi chỉ đúng ô còn trống, và để kiểu thu hẹp thật thay vì bị ép.
        if (!data.payment_date) throw new Error("Vui lòng chọn ngày thu");
        if (!data.payment_method) throw new Error("Vui lòng chọn phương thức thanh toán");
        let totalAmount = data.invoice_total_amount;
        let paidAmount = data.expected_paid_amount;
        let depositDue = data.deposit_due;
        let hasContract = data.has_contract;

        if (
          totalAmount == null
          || paidAmount == null
          || depositDue == null
          || hasContract == null
        ) {
          const { data: invoice, error: invoiceError } = await (supabase
            .from("invoices")
            .select("total_amount, paid_amount, contract_id, previous_debt_sources, invoice_items(type, description, amount)")
            .eq("id", data.invoice_id)
            .single() as any);
          if (invoiceError || !invoice) throw invoiceError ?? new Error("Không tìm thấy hóa đơn");
          totalAmount = Number(invoice.total_amount) || 0;
          paidAmount = Number(invoice.paid_amount) || 0;
          depositDue = deriveInvoiceDepositDue(invoice);
          hasContract = !!invoice.contract_id;
        }

        let accountIsVirtual = data.account_is_virtual;
        if (accountIsVirtual == null) {
          const { data: account, error: accountError } = await (supabase
            .from("accounts")
            .select("is_virtual") as any)
            .eq("id", data.account_id)
            .single();
          if (accountError || !account) throw accountError ?? new Error("Không tìm thấy sổ quỹ");
          accountIsVirtual = account.is_virtual;
        }
        if (accountIsVirtual !== false) {
          throw new Error("Sổ quỹ nhận tiền phải là sổ thật");
        }

        const request = {
          invoice_id: data.invoice_id,
          collection_date: data.payment_date,
          tenders: [{
            payment_method: data.payment_method,
            gross_amount: data.amount,
            account_id: data.account_id,
            account_is_virtual: accountIsVirtual,
            receipt_number: (data as any).receipt_number ?? null,
          }],
          overpay_action: "REJECT" as const,
          allow_rounding: false,
          notes: data.notes ?? null,
          receipt_image_url: (data as any).receipt_image_url ?? null,
          expected_paid_amount: paidAmount,
          invoice_total_amount: totalAmount,
          deposit_due: depositDue,
          has_contract: hasContract,
        };
        planInvoiceCollection(request);
        return recordInvoiceCollectionV5(
          // `p_notes` và `p_receipt_image_url` khai `text` KHÔNG có DEFAULT nên
          // bộ sinh coi là bắt buộc-và-không-null; thực tế RPC nhận NULL cho cả
          // hai (chú thích trống). `rpcNullable` nới đúng chiều null đó.
          (fn, args) => supabase.rpc(fn, {
            ...args,
            p_notes: rpcNullable(args.p_notes),
            p_receipt_image_url: rpcNullable(args.p_receipt_image_url),
          }),
          request,
          data.idempotency_key ?? `collect-${crypto.randomUUID()}`,
        );
      }

      // Không có invoice → payment độc lập, không update invoice ⇒ không có
      // atomicity issue. Giữ insert trực tiếp.
      const {
        account_id: _accountId,
        account_is_virtual: _accountIsVirtual,
        invoice_total_amount: _invoiceTotal,
        expected_paid_amount: _expectedPaid,
        deposit_due: _depositDue,
        has_contract: _hasContract,
        idempotency_key: _idempotencyKey,
        ...paymentInsert
      } = data;
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .insert({ ...paymentInsert, user_id: user.id })
        .select()
        .single();
      if (paymentError) throw paymentError;
      return payment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra: " + error.message);
    },
  });
};

// Retained cash includes customer credit; CT is a non-cash offset and is excluded.
export const usePaymentsSummary = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["payments-summary", start_date, end_date],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const data = await fetchAllRows<{
        id: string;
        collected_amount: number | null;
        payment_method: string | null;
        payment_date: string;
      }>(
        (from, to) => {
          let query = supabase
            .from("active_payment_receipts")
            .select("id, collected_amount, payment_method, payment_date")
            .neq("payment_method", "CT")
            .gt("collected_amount", 0);
          if (start_date) query = query.gte("payment_date", start_date);
          if (end_date) query = query.lte("payment_date", end_date);
          return query
            .order("payment_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
        },
        { label: "payments.summary" },
      );
      if (data === null) throw new Error("Không thể tải tổng hợp thanh toán");

      const total = data.reduce(
        (sum, receipt) => sum + (Number(receipt.collected_amount) || 0),
        0,
      );
      const byMethod = data.reduce((acc, receipt) => {
        const method = receipt.payment_method || "OTHER";
        acc[method] = (acc[method] || 0) + (Number(receipt.collected_amount) || 0);
        return acc;
      }, {} as Record<string, number>);

      return {
        total,
        count: data.length,
        byMethod,
      };
    },
    enabled: !!start_date && !!end_date,
  });
};
