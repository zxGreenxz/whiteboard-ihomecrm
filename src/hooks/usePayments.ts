import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

// =============================================
// Types
// =============================================

type Payment = Database['public']['Tables']['payments']['Row'];
type PaymentInsert = Database['public']['Tables']['payments']['Insert'];

export interface PaymentWithRelations extends Payment {
  invoice?: {
    id: string;
    title: string | null;
    total_amount: number;
    contract?: {
      id: string;
      contract_number: string | null;
      tenant: {
        id: string;
        full_name: string;
        phone: string;
      };
      room?: {
        id: string;
        name: string;
      };
      bed?: {
        id: string;
        name: string;
      };
    };
  };
}

export interface CreatePaymentData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
}

export interface PaymentFilters {
  start_date?: string;
  end_date?: string;
  payment_method?: string;
  invoice_id?: string;
}

// =============================================
// Get All Payments
// =============================================

export const usePayments = (filters?: PaymentFilters) => {
  return useQuery({
    queryKey: ['payments', filters],
    queryFn: async (): Promise<PaymentWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('payments')
        .select(`
          *,
          invoice:invoices!payments_invoice_id_fkey (
            id,
            title,
            total_amount,
            contract:contracts!invoices_contract_id_fkey (
              id,
              contract_number,
              tenant:tenants!contracts_tenant_id_fkey (
                id, full_name, phone
              ),
              room:rooms!contracts_room_id_fkey (
                id, name
              ),
              bed:beds!contracts_bed_id_fkey (
                id, name
              )
            )
          )
        `)
        .eq('user_id', user.id)
        .order('payment_date', { ascending: false });

      if (filters?.start_date) {
        query = query.gte('payment_date', filters.start_date);
      }
      if (filters?.end_date) {
        query = query.lte('payment_date', filters.end_date);
      }
      if (filters?.payment_method) {
        query = query.eq('payment_method', filters.payment_method);
      }
      if (filters?.invoice_id) {
        query = query.eq('invoice_id', filters.invoice_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as PaymentWithRelations[];
    },
  });
};

// =============================================
// Get Single Payment (for Receipt)
// =============================================

export const usePayment = (paymentId?: string) => {
  return useQuery({
    queryKey: ['payment', paymentId],
    queryFn: async (): Promise<PaymentWithRelations | null> => {
      if (!paymentId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('payments')
        .select(`
          *,
          invoice:invoices!payments_invoice_id_fkey (
            id,
            title,
            total_amount,
            paid_amount,
            contract:contracts!invoices_contract_id_fkey (
              id,
              contract_number,
              tenant:tenants!contracts_tenant_id_fkey (
                id, full_name, phone, email
              ),
              room:rooms!contracts_room_id_fkey (
                id, name,
                building:buildings!rooms_building_id_fkey (name)
              ),
              bed:beds!contracts_bed_id_fkey (
                id, name
              )
            )
          )
        `)
        .eq('id', paymentId)
        .eq('user_id', user.id)
        .single();

      if (error) throw error;
      return data as PaymentWithRelations;
    },
    enabled: !!paymentId,
  });
};

// =============================================
// Create Payment
// =============================================

export const useCreatePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreatePaymentData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create payment record
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert({
          user_id: user.id,
          invoice_id: data.invoice_id,
          amount: data.amount,
          payment_method: data.payment_method,
          payment_date: data.payment_date,
          notes: data.notes,
        })
        .select()
        .single();

      if (paymentError) throw paymentError;

      // Update invoice paid_amount and status
      const { data: invoice } = await supabase
        .from('invoices')
        .select('paid_amount, total_amount')
        .eq('id', data.invoice_id)
        .single();

      if (invoice) {
        const newPaidAmount = (invoice.paid_amount || 0) + data.amount;
        const newStatus =
          newPaidAmount >= invoice.total_amount
            ? 'PAID'
            : newPaidAmount > 0
            ? 'PARTIAL_PAID'
            : 'APPROVED';

        await supabase
          .from('invoices')
          .update({
            paid_amount: newPaidAmount,
            status: newStatus,
            paid_date: newPaidAmount >= invoice.total_amount ? new Date().toISOString().split('T')[0] : null,
          })
          .eq('id', data.invoice_id);
      }

      return payment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['cash_book'] });

      toast({
        title: 'Ghi nhận thanh toán thành công!',
        description: 'Thanh toán đã được ghi nhận vào hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Ghi nhận thanh toán thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Delete Payment
// =============================================

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (paymentId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get payment info before deleting
      const { data: payment } = await supabase
        .from('payments')
        .select('invoice_id, amount')
        .eq('id', paymentId)
        .single();

      if (!payment) throw new Error('Payment not found');

      // Delete payment
      const { error } = await supabase
        .from('payments')
        .delete()
        .eq('id', paymentId)
        .eq('user_id', user.id);

      if (error) throw error;

      // Update invoice paid_amount
      const { data: invoice } = await supabase
        .from('invoices')
        .select('paid_amount, total_amount')
        .eq('id', payment.invoice_id)
        .single();

      if (invoice) {
        const newPaidAmount = Math.max(0, (invoice.paid_amount || 0) - payment.amount);
        const newStatus =
          newPaidAmount >= invoice.total_amount
            ? 'PAID'
            : newPaidAmount > 0
            ? 'PARTIAL_PAID'
            : 'APPROVED';

        await supabase
          .from('invoices')
          .update({
            paid_amount: newPaidAmount,
            status: newStatus,
            paid_date: newPaidAmount >= invoice.total_amount ? new Date().toISOString().split('T')[0] : null,
          })
          .eq('id', payment.invoice_id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['cash_book'] });

      toast({
        title: 'Xóa thanh toán thành công!',
        description: 'Thanh toán đã được xóa khỏi hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xóa thanh toán thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Get Payment Statistics
// =============================================

export interface PaymentStats {
  total_count: number;
  total_amount: number;
  by_method: Array<{
    method: string;
    count: number;
    amount: number;
  }>;
}

export const usePaymentStats = (filters?: PaymentFilters) => {
  return useQuery({
    queryKey: ['payment_stats', filters],
    queryFn: async (): Promise<PaymentStats> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('payments')
        .select('payment_method, amount')
        .eq('user_id', user.id);

      if (filters?.start_date) {
        query = query.gte('payment_date', filters.start_date);
      }
      if (filters?.end_date) {
        query = query.lte('payment_date', filters.end_date);
      }

      const { data, error } = await query;
      if (error) throw error;

      const total_count = data.length;
      const total_amount = data.reduce((sum, p) => sum + p.amount, 0);

      // Group by payment method
      const methodMap = new Map<string, { count: number; amount: number }>();
      data.forEach((payment) => {
        const method = payment.payment_method || 'UNKNOWN';
        const existing = methodMap.get(method) || { count: 0, amount: 0 };
        methodMap.set(method, {
          count: existing.count + 1,
          amount: existing.amount + payment.amount,
        });
      });

      const by_method = Array.from(methodMap.entries()).map(([method, stats]) => ({
        method,
        ...stats,
      }));

      return {
        total_count,
        total_amount,
        by_method,
      };
    },
  });
};
