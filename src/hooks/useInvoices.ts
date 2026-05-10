// =============================================
// Invoice Module Hooks (Reimplemented)
// TanStack Query hooks for invoice CRUD, approval, statistics, and excess amounts.
// Uses new schema with billing_month (YYYY-MM) and building_id on invoices.
// =============================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { PaginatedData } from '@/hooks/usePagination';
import type {
  InvoiceWithRelations,
  InvoiceFilters,
  InvoiceFormData,
  InvoiceFormItem,
  InvoiceStatus,
} from '@/types/invoice';
import { canEditInvoice, canDeleteInvoice } from '@/lib/invoiceUtils';

// Re-export types for backward compatibility
export type { InvoiceWithRelations, InvoiceFilters } from '@/types/invoice';

// Legacy types kept for backward compatibility with existing components
export type InvoiceGenerationType = 'RENT_ONLY' | 'SERVICE_ONLY' | 'RENT_AND_SERVICE';

export interface AutoGenerateInvoicesData {
  billing_period_start: string;
  billing_period_end: string;
  issue_date: string;
  due_date: string;
  contract_ids?: string[];
  building_id?: string;
  invoice_type: InvoiceGenerationType;
}

export interface UpdateInvoiceData {
  id: string;
  formData: InvoiceFormData;
}

// =============================================
// Shared select string for invoice queries
// =============================================

const INVOICE_LIST_SELECT = `
  *,
  contract:contracts!invoices_contract_id_fkey (
    id, contract_number,
    tenant:tenants!contracts_tenant_id_fkey (id, full_name, phone)
  ),
  building:buildings!invoices_building_id_fkey (id, name),
  room:rooms!invoices_room_id_fkey (id, name),
  bed:beds!invoices_bed_id_fkey (id, name),
  invoice_items (id, type, description, unit_price, quantity, coefficient, amount, service_id, previous_reading, current_reading, from_date, to_date, sort_order),
  payments (id, amount, payment_date, payment_method, notes, receipt_image_url)
`;

// =============================================
// Pagination params
// =============================================

export interface InvoicePaginationParams {
  page?: number;
  pageSize?: number;
}

// =============================================
// useInvoices - Query invoices with pagination and filters
// Requirements: 10.2, 10.4, 10.5, 13.7
// =============================================

export const useInvoices = (
  filters?: InvoiceFilters,
  pagination?: InvoicePaginationParams,
) => {
  return useQuery({
    queryKey: ['invoices', filters, pagination],
    queryFn: async (): Promise<PaginatedData<InvoiceWithRelations>> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT, { count: 'exact' }) as any)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.building_id) {
        query = query.eq('building_id', filters.building_id);
      }
      if (filters?.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters?.bed_id) {
        query = query.eq('bed_id', filters.bed_id);
      }
      if (filters?.contract_id) {
        query = query.eq('contract_id', filters.contract_id);
      }
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.billing_month) {
        query = query.eq('billing_month', filters.billing_month);
      }
      if (filters?.date_range?.start) {
        query = query.gte('issue_date', filters.date_range.start);
      }
      if (filters?.date_range?.end) {
        query = query.lte('issue_date', filters.date_range.end);
      }

      // Apply pagination
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error('useInvoices error:', error);
        return { data: [], count: 0 };
      }

      return {
        data: (data || []) as InvoiceWithRelations[],
        count: count || 0,
      };
    },
  });
};

// Legacy hook for backwards compatibility (returns array directly)
export const useInvoicesLegacy = (filters?: {
  status?: string;
  contract_id?: string;
}) => {
  return useQuery({
    queryKey: ['invoices-legacy', filters],
    queryFn: async (): Promise<InvoiceWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT) as any)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.contract_id && filters.contract_id !== 'create') {
        query = query.eq('contract_id', filters.contract_id);
      }

      const { data, error } = await query;
      if (error) {
        console.error('useInvoicesLegacy error:', error);
        return [];
      }
      return (data || []) as InvoiceWithRelations[];
    },
  });
};

// =============================================
// useInvoice - Query single invoice with relations
// Requirements: 1.12, 3.1
// =============================================

export const useInvoice = (invoiceId?: string) => {
  return useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async (): Promise<InvoiceWithRelations | null> => {
      if (!invoiceId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT) as any)
        .eq('id', invoiceId)
        .is('deleted_at', null)
        .single();

      if (error) throw error;
      return data as InvoiceWithRelations;
    },
    enabled: !!invoiceId,
  });
};

// =============================================
// useCreateInvoice - Create invoice + invoice_items, status = APPROVED (mặc định đã duyệt)
// =============================================

export const useCreateInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (formData: InvoiceFormData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { items, ...invoiceFields } = formData;

      // Calculate totals from items
      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
        0,
      );
      const tax_amount = subtotal * (invoiceFields.tax_percent || 0) / 100;
      const total_amount = subtotal - (invoiceFields.discount_amount || 0) + tax_amount;

      // Generate invoice number
      const { generateInvoiceNumber } = await import('@/lib/invoiceUtils');
      const invoice_number = await generateInvoiceNumber(user.id);

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || 'Người dùng';

      // Insert invoice
      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .insert({
          user_id: user.id,
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,
          bed_id: invoiceFields.bed_id || null,
          invoice_number,
          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          tax_percent: invoiceFields.tax_percent || 0,
          tax_amount,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          paid_amount: 0,
          previous_debt: invoiceFields.previous_debt || 0,
          notes: invoiceFields.notes || null,
          template_id: invoiceFields.template_id || null,
          creator_name: creatorName,
        } as any)
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Insert invoice items
      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: invoice.id,
          service_id: item.service_id || null,
          type: item.type as any,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        }));

        const { error: itemsError } = await supabase
          .from('invoice_items')
          .insert(invoiceItems as any);

        if (itemsError) throw itemsError;
      }

      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Dữ liệu đã được TẠO thành công',
        description: 'Hoá đơn mới đã được duyệt và sẵn sàng ghi nhận thanh toán.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useUpdateInvoice - Update invoice (check canEditInvoice first)
// Requirements: 3.1, 3.2
// =============================================

export const useUpdateInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, formData }: UpdateInvoiceData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch current invoice to check status
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;
      if (!canEditInvoice({ status: current.status as InvoiceStatus, paid_amount: current.paid_amount })) {
        throw new Error('Không thể chỉnh sửa hoá đơn ở trạng thái này');
      }

      const { items, ...invoiceFields } = formData;

      // Recalculate totals
      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
        0,
      );
      const tax_amount = subtotal * (invoiceFields.tax_percent || 0) / 100;
      const total_amount = subtotal - (invoiceFields.discount_amount || 0) + tax_amount;

      // Update invoice
      const { data: invoice, error: updateError } = await supabase
        .from('invoices')
        .update({
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,
          bed_id: invoiceFields.bed_id || null,
          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          tax_percent: invoiceFields.tax_percent || 0,
          tax_amount,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          previous_debt: invoiceFields.previous_debt || 0,
          notes: invoiceFields.notes || null,
          template_id: invoiceFields.template_id || null,
        } as any)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Delete old items and insert new ones
      const { error: deleteItemsError } = await supabase
        .from('invoice_items')
        .delete()
        .eq('invoice_id', id);

      if (deleteItemsError) throw deleteItemsError;

      if (items.length > 0) {
        const invoiceItems = items.map((item) => ({
          invoice_id: id,
          service_id: item.service_id || null,
          type: item.type as any,
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          coefficient: item.coefficient,
          amount: item.unit_price * item.quantity * item.coefficient,
          previous_reading: item.previous_reading ?? null,
          current_reading: item.current_reading ?? null,
          from_date: item.from_date || null,
          to_date: item.to_date || null,
          sort_order: item.sort_order,
        }));

        const { error: insertItemsError } = await supabase
          .from('invoice_items')
          .insert(invoiceItems as any);

        if (insertItemsError) throw insertItemsError;
      }

      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: 'Dữ liệu đã được CẬP NHẬT thành công',
        description: 'Hoá đơn đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi cập nhật hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useDeleteInvoice - Soft-delete single invoice
// Requirements: 3.4, 3.5
// =============================================

export const useDeleteInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch current invoice to check status
      const { data: current, error: fetchError } = await supabase
        .from('invoices')
        .select('status, paid_amount')
        .eq('id', invoiceId)
        .single();

      if (fetchError) throw fetchError;
      if (!canDeleteInvoice({ status: current.status as InvoiceStatus, paid_amount: current.paid_amount })) {
        throw new Error('Không thể xoá hoá đơn ở trạng thái này');
      }

      const { error } = await supabase
        .from('invoices')
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq('id', invoiceId)
        ;

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: 'Dữ liệu đã được XOÁ thành công',
        description: 'Hoá đơn đã được xoá.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xoá hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useBulkDeleteInvoices - Soft-delete multiple invoices
// Requirements: 3.5
// =============================================

export const useBulkDeleteInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (invoiceIds.length === 0) return;

      const { error } = await supabase
        .from('invoices')
        .update({ deleted_at: new Date().toISOString() } as any)
        .in('id', invoiceIds)
        .eq('status', 'DRAFT' as any); // Only allow deleting DRAFT invoices

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });

      toast({
        title: 'Dữ liệu đã được XOÁ thành công',
        description: 'Các hoá đơn đã chọn đã được xoá.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xoá hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useApproveInvoice - DRAFT → APPROVED
// Requirements: 4.1, 4.2
// =============================================

export const useApproveInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
        } as any)
        .eq('id', invoiceId)
        .eq('status', 'DRAFT' as any)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Hoá đơn đã được duyệt thành công',
        description: 'Hoá đơn đã chuyển sang trạng thái Đã duyệt.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useUnapproveInvoice - APPROVED → DRAFT
// Requirements: 4.5
// =============================================

export const useUnapproveInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'DRAFT' as any,
          approved_at: null,
          approved_by: null,
        } as any)
        .eq('id', invoiceId)
        .eq('status', 'APPROVED' as any)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Đã bỏ duyệt hoá đơn',
        description: 'Hoá đơn đã chuyển về trạng thái Nháp.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi bỏ duyệt hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useBulkApproveInvoices - Bulk approve DRAFT → APPROVED
// Requirements: 4.3
// =============================================

export const useBulkApproveInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (invoiceIds.length === 0) return;

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
        } as any)
        .in('id', invoiceIds)
        .eq('status', 'DRAFT' as any)
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      const count = data?.length ?? 0;
      toast({
        title: 'Duyệt hàng loạt thành công',
        description: `Đã duyệt ${count} hoá đơn.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi duyệt hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useInvoiceStatistics - Query RPC get_invoice_statistics
// Requirements: 10.1
// =============================================

export interface InvoiceStatisticsFilters {
  building_id?: string;
  room_id?: string;
  status?: InvoiceStatus;
  start_date?: string;
  end_date?: string;
}

export interface InvoiceStatistics {
  total_paid: number;
  total_remaining: number;
  total_count: number;
}

export const useInvoiceStatistics = (filters?: InvoiceStatisticsFilters) => {
  return useQuery({
    queryKey: ['invoice-statistics', filters],
    queryFn: async (): Promise<InvoiceStatistics> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await (supabase.rpc as any)('get_invoice_statistics', {
        p_user_id: user.id,
        p_building_id: filters?.building_id ?? null,
        p_room_id: filters?.room_id ?? null,
        p_status: filters?.status ?? null,
        p_start_date: filters?.start_date ?? null,
        p_end_date: filters?.end_date ?? null,
      });

      if (error) throw error;

      // RPC returns a single row or array with one element
      const result = Array.isArray(data) ? data[0] : data;
      return {
        total_paid: result?.total_paid ?? 0,
        total_remaining: result?.total_remaining ?? 0,
        total_count: result?.total_count ?? 0,
      };
    },
  });
};

// =============================================
// useCheckOverdueInvoices - Auto-update overdue invoices on page load
// Requirements: 7.7, 11.10
// Checks invoices with status APPROVED or PARTIAL_PAID where due_date < today
// and updates their status to OVERDUE.
// =============================================

export const useCheckOverdueInvoices = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const today = new Date().toISOString().split('T')[0];

      // Find all invoices that should be marked as OVERDUE:
      // status IN ('APPROVED', 'PARTIAL_PAID'), due_date < today, not deleted
      const { data: overdueInvoices, error: fetchError } = await supabase
        .from('invoices')
        .select('id')
        .is('deleted_at', null)
        .in('status', ['APPROVED', 'PARTIAL_PAID'] as any)
        .lt('due_date', today);

      if (fetchError) throw fetchError;
      if (!overdueInvoices || overdueInvoices.length === 0) return 0;

      const overdueIds = overdueInvoices.map((inv) => inv.id);

      // Batch update all overdue invoices
      const { error: updateError } = await supabase
        .from('invoices')
        .update({ status: 'OVERDUE' as any } as any)
        .in('id', overdueIds)
        ;

      if (updateError) throw updateError;

      return overdueIds.length;
    },
    onSuccess: (count) => {
      if (count > 0) {
        // Invalidate invoice queries so the list refreshes with updated statuses
        queryClient.invalidateQueries({ queryKey: ['invoices'] });
        queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
        queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      }
    },
    onError: (error: Error) => {
      // Silently log - this is a background check, don't disrupt the user
      console.error('Failed to check overdue invoices:', error.message);
    },
  });
};

// =============================================
// useExcessAmount - Query SUM(amount) from excess_amounts by contract_id
// Requirements: 8.2
// =============================================

export const useExcessAmount = (contractId?: string) => {
  return useQuery({
    queryKey: ['excess-amount', contractId],
    queryFn: async (): Promise<number> => {
      if (!contractId) return 0;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await (supabase
        .from('excess_amounts' as any) as any)
        .select('amount')
        .eq('contract_id', contractId)
        ;

      if (error) throw error;

      // Sum all amounts (positive = credit added, negative = credit used)
      const total = (data || []).reduce((sum: number, row: any) => sum + (row.amount || 0), 0);
      return total;
    },
    enabled: !!contractId,
  });
};


// =============================================
// Legacy hooks kept for backward compatibility
// These are used by existing components that haven't been migrated yet
// =============================================

export interface RecordPaymentData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
  receipt_image_url?: string;
}

export const useRecordPayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RecordPaymentData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert([{
          user_id: user.id,
          invoice_id: data.invoice_id,
          amount: data.amount,
          payment_method: data.payment_method as any,
          payment_date: data.payment_date,
          notes: data.notes,
          receipt_image_url: data.receipt_image_url,
        }])
        .select()
        .single();

      if (paymentError) throw paymentError;

      // Update invoice paid_amount
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
            status: newStatus as any,
            paid_date: newPaidAmount >= invoice.total_amount ? new Date().toISOString().split('T')[0] : null,
          } as any)
          .eq('id', data.invoice_id);
      }

      return payment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Thanh toán đã được ghi nhận thành công',
        description: 'Thanh toán đã được ghi nhận vào hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận thanh toán',
        description: error.message,
      });
    },
  });
};

// =============================================
// Legacy: Meter reading hooks (kept for backward compatibility)
// These will be moved to useInvoicePayments.ts in task 9.3
// =============================================

export interface MeterReadingData {
  contract_id: string;
  service_id: string;
  meter_type: string;
  reading_date: string;
  current_reading: number;
  previous_reading: number;
  notes?: string;
}

export const useRecordMeterReading = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: MeterReadingData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: reading, error } = await supabase
        .from('meter_readings')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          service_id: data.service_id,
          meter_type: data.meter_type as any,
          reading_date: data.reading_date,
          previous_reading: data.previous_reading,
          current_reading: data.current_reading,
          notes: data.notes,
        }])
        .select()
        .single();

      if (error) throw error;
      return reading;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter_readings'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Chỉ số công tơ đã được ghi nhận thành công',
        description: 'Chỉ số công tơ đã được ghi nhận.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận chỉ số',
        description: error.message,
      });
    },
  });
};

export const useMeterReadings = (contractId?: string) => {
  return useQuery({
    queryKey: ['meter_readings', contractId],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('meter_readings')
        .select(`
          *,
          contract:contracts!meter_readings_contract_id_fkey (
            id,
            contract_number,
            tenant:tenants!contracts_tenant_id_fkey (full_name)
          ),
          service:services!meter_readings_service_id_fkey (
            id, name, unit
          )
        `)
        .order('reading_date', { ascending: false });

      if (contractId) {
        query = query.eq('contract_id', contractId);
      }

      const { data, error } = await query;
      if (error) {
        console.error('useMeterReadings error:', error);
        return [];
      }
      return data || [];
    },
    enabled: !!contractId || contractId === undefined,
  });
};

export interface BulkMeterReadingData {
  contract_id: string;
  service_id: string;
  meter_type: 'ELECTRIC' | 'WATER' | 'GAS' | 'OTHER';
  reading_date: string;
  previous_reading: number;
  current_reading: number;
  notes?: string;
}

export const useBulkCreateMeterReadings = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (readings: BulkMeterReadingData[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const readingsToInsert = readings.map((reading) => ({
        user_id: user.id,
        contract_id: reading.contract_id,
        service_id: reading.service_id,
        meter_type: reading.meter_type as any,
        reading_date: reading.reading_date,
        previous_reading: reading.previous_reading,
        current_reading: reading.current_reading,
        notes: reading.notes,
      }));

      const { data, error } = await supabase
        .from('meter_readings')
        .insert(readingsToInsert)
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['meter_readings'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Chỉ số công tơ đã được ghi nhận thành công',
        description: `Đã ghi nhận ${data.length} chỉ số công tơ.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận chỉ số',
        description: error.message,
      });
    },
  });
};

// =============================================
// Legacy: useAutoGenerateInvoices (kept for backward compatibility)
// Will be moved to useInvoicePayments.ts in task 9.3
// =============================================

export const useAutoGenerateInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: AutoGenerateInvoicesData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Map legacy invoice_type to new RPC param
      const typeMap: Record<InvoiceGenerationType, string> = {
        RENT_ONLY: 'rent_only',
        SERVICE_ONLY: 'service_only',
        RENT_AND_SERVICE: 'both',
      };

      // Extract billing_month from billing_period_start (YYYY-MM-DD → YYYY-MM)
      const billingMonth = data.billing_period_start.substring(0, 7);

      const { data: result, error } = await (supabase.rpc as any)('generate_invoices_for_building', {
        p_user_id: user.id,
        p_building_id: data.building_id ?? '',
        p_billing_month: billingMonth,
        p_invoice_type: typeMap[data.invoice_type] ?? 'both',
      });

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Dữ liệu đã được TẠO thành công',
        description: 'Hoá đơn đã được sinh tự động.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi sinh hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// Legacy: useCancelInvoice (kept for backward compatibility)
// =============================================

export const useCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'CANCELLED' as any } as any)
        .eq('id', invoiceId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Hoá đơn đã được huỷ',
        description: 'Hoá đơn đã chuyển sang trạng thái Đã huỷ.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi huỷ hoá đơn',
        description: error.message,
      });
    },
  });
};
