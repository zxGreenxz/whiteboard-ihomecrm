import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Payment = Database["public"]["Tables"]["payments"]["Row"];
type PaymentInsert = Database["public"]["Tables"]["payments"]["Insert"];

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

// Fetch all payments
export const usePayments = (filters?: {
  start_date?: string;
  end_date?: string;
  payment_method?: string;
}) => {
  return useQuery({
    queryKey: ["payments", filters],
    queryFn: async (): Promise<PaymentWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

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
        .eq('user_id', user.id)
        .order("payment_date", { ascending: false });

      if (filters?.start_date) {
        query = query.gte("payment_date", filters.start_date);
      }
      if (filters?.end_date) {
        query = query.lte("payment_date", filters.end_date);
      }
      if (filters?.payment_method) {
        query = query.eq("payment_method", filters.payment_method as any);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách thanh toán");
        throw error;
      }

      return (data as PaymentWithRelations[]) || [];
    },
  });
};

// Fetch single payment
export const usePayment = (id: string) => {
  return useQuery({
    queryKey: ["payments", id],
    queryFn: async (): Promise<PaymentWithRelations> => {
      const { data: { user } } = await supabase.auth.getUser();
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
        .eq('user_id', user.id)
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
    mutationFn: async (data: PaymentInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create payment
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (paymentError) throw paymentError;

      // Update invoice paid_amount
      if (data.invoice_id) {
        const { data: invoice, error: invoiceError } = await supabase
          .from("invoices")
          .select("paid_amount, total_amount")
          .eq("id", data.invoice_id)
          .single();

        if (invoiceError) throw invoiceError;

        const newPaidAmount = (invoice.paid_amount || 0) + (data.amount || 0);
        const status =
          newPaidAmount >= invoice.total_amount ? "PAID" :
          newPaidAmount > 0 ? "PARTIAL_PAID" : "APPROVED";

        await supabase
          .from("invoices")
          .update({
            paid_amount: newPaidAmount,
            status,
          })
          .eq("id", data.invoice_id);
      }

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

// Get payments summary by date range
export const usePaymentsSummary = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["payments-summary", start_date, end_date],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("payments")
        .select("amount, payment_method, payment_date")
        .eq('user_id', user.id);

      if (start_date) {
        query = query.gte("payment_date", start_date);
      }
      if (end_date) {
        query = query.lte("payment_date", end_date);
      }

      const { data, error } = await query;

      if (error) throw error;

      const total = data?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      const byMethod = data?.reduce((acc, p) => {
        const method = p.payment_method || "OTHER";
        acc[method] = (acc[method] || 0) + (p.amount || 0);
        return acc;
      }, {} as Record<string, number>);

      return {
        total,
        count: data?.length || 0,
        byMethod: byMethod || {},
      };
    },
    enabled: !!start_date && !!end_date,
  });
};
