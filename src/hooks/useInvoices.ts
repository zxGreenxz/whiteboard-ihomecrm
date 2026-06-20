// =============================================
// Invoice Module Hooks (Reimplemented)
// TanStack Query hooks for invoice CRUD, approval, statistics, and excess amounts.
// Uses new schema with billing_month (YYYY-MM) and building_id on invoices.
// =============================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
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
    id, contract_number, status, public_code,
    contract_customers!contract_customers_contract_id_fkey (
      id, is_representative,
      customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
    )
  ),
  building:buildings!invoices_building_id_fkey (id, name, default_account_id_tt, default_account_id_tk),
  room:rooms!invoices_room_id_fkey (id, name),  invoice_items (id, type, description, unit_price, quantity, coefficient, amount, service_id, previous_reading, current_reading, from_date, to_date, sort_order),
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
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      let query = (supabase
        .from('invoices')
        .select(INVOICE_LIST_SELECT, { count: 'exact' }) as any)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.building_ids?.length) {
        query = query.in('building_id', filters.building_ids);
      } else if (filters?.building_id) {
        query = query.eq('building_id', filters.building_id);
      }
      if (filters?.room_ids?.length) {
        query = query.in('room_id', filters.room_ids);
      } else if (filters?.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters?.contract_id) {
        query = query.eq('contract_id', filters.contract_id);
      }
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.payment_status === 'paid') {
        query = query.eq('status', 'PAID');
      } else if (filters?.payment_status === 'partial') {
        query = query.eq('status', 'PARTIAL_PAID');
      } else if (filters?.payment_status === 'unpaid') {
        // Chưa thu đồng nào → loại cả PAID lẫn PARTIAL_PAID.
        query = query.not('status', 'in', '(PAID,PARTIAL_PAID)');
      }
      // Vòng đời HĐ — mặc định 'active': ẩn các HĐ đã huỷ. Đặt SAU các filter
      // status/payment_status để không bị override khi user chọn cụ thể.
      const viewStatus = filters?.view_status ?? 'active';
      if (viewStatus === 'active' && !filters?.status) {
        query = query.neq('status', 'CANCELLED');
      } else if (viewStatus === 'cancelled') {
        query = query.eq('status', 'CANCELLED');
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
      const user = await getSessionUser();
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

      const user = await getSessionUser();
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
// useInvoiceTotalsByIds — lấy GỌN tổng/đã trả/còn lại của nhiều hoá đơn theo id.
// Dùng cho báo cáo gộp khoản thu theo hoá đơn (note thiếu/thừa so với HĐ) —
// chỉ cần vài cột số, không kéo cả quan hệ như useInvoice.
// =============================================

export interface InvoiceTotalLite {
  id: string;
  total_amount: number;
  paid_amount: number;
  remaining_amount: number;
}

export const useInvoiceTotalsByIds = (ids: string[]) => {
  // Dedupe + sort để queryKey ổn định (không refetch oan khi thứ tự đổi).
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['invoice-totals-by-ids', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, InvoiceTotalLite>> => {
      const map = new Map<string, InvoiceTotalLite>();
      // Chunk để tránh URL .in() quá dài (PostgREST 400 khi danh sách id lớn).
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await (supabase as any)
          .from('invoices')
          .select('id, total_amount, paid_amount, remaining_amount')
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const row of (data ?? []) as any[]) {
          map.set(row.id, {
            id: row.id,
            total_amount: Number(row.total_amount) || 0,
            paid_amount: Number(row.paid_amount) || 0,
            remaining_amount: Number(row.remaining_amount) || 0,
          });
        }
      }
      return map;
    },
  });
};

// =============================================
// useFirstInvoiceDetails — chi tiết "hoá đơn tháng đầu" (HĐ tự sinh khi ký HĐ).
// Cho mỗi invoice id, NẾU nó là hoá đơn tháng đầu của hợp đồng — nhận diện theo:
//   • kỳ tiền phòng (item RENT) bắt đầu ĐÚNG contracts.start_billing_date, HOẶC
//   • notes tự động chứa "… tháng đầu" (fallback cho HĐ thiếu start_billing_date)
// thì trả về:
//   • kỳ tiền phòng (from→to của item RENT)
//   • đã thu / tổng của hoá đơn (paid_amount / total_amount)
//   • cọc đã đóng / tổng cọc (contracts.deposit_paid / total_deposit)
// Dùng cho trang Phân bổ lợi nhuận + dialog "Các lần thanh toán".
// Invoice KHÔNG phải tháng đầu sẽ không có trong map.
// =============================================

export interface FirstInvoiceDetail {
  invoiceId: string;
  rentFrom: string | null;
  rentTo: string | null;
  invoicePaid: number;
  invoiceTotal: number;
  depositPaid: number;
  depositTotal: number;
}

export const useFirstInvoiceDetails = (ids: string[]) => {
  const sortedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['first-invoice-details', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async (): Promise<Map<string, FirstInvoiceDetail>> => {
      const map = new Map<string, FirstInvoiceDetail>();
      const CHUNK = 200;
      for (let i = 0; i < sortedIds.length; i += CHUNK) {
        const slice = sortedIds.slice(i, i + CHUNK);
        const { data, error } = await (supabase as any)
          .from('invoices')
          .select(
            `id, total_amount, paid_amount, notes,
             contract:contracts!invoices_contract_id_fkey (start_billing_date, total_deposit, deposit_paid),
             invoice_items (type, from_date, to_date, amount)`,
          )
          .in('id', slice)
          .is('deleted_at', null);
        if (error) throw error;
        for (const inv of (data ?? []) as any[]) {
          const items = (inv.invoice_items ?? []) as any[];
          // Item RENT có from_date sớm nhất là dòng tiền phòng tháng đầu.
          const rent =
            items
              .filter((it) => it.type === 'RENT' && it.from_date)
              .sort((a, b) =>
                String(a.from_date).localeCompare(String(b.from_date)),
              )[0] ??
            items.find((it) => it.type === 'RENT') ??
            null;
          const contract = inv.contract ?? null;
          const startBilling: string | null = contract?.start_billing_date ?? null;
          const sameStart =
            !!rent?.from_date &&
            !!startBilling &&
            String(rent.from_date).slice(0, 10) === String(startBilling).slice(0, 10);
          const byNotes =
            typeof inv.notes === 'string' && /th[aá]ng[\s_]?đầu/i.test(inv.notes);
          if (!sameStart && !byNotes) continue;
          map.set(inv.id, {
            invoiceId: inv.id,
            rentFrom: rent?.from_date ?? null,
            rentTo: rent?.to_date ?? null,
            invoicePaid: Number(inv.paid_amount) || 0,
            invoiceTotal: Number(inv.total_amount) || 0,
            depositPaid: Number(contract?.deposit_paid) || 0,
            depositTotal: Number(contract?.total_deposit) || 0,
          });
        }
      }
      return map;
    },
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
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { items, ...invoiceFields } = formData;

      // Calculate totals from items
      const subtotal = items.reduce(
        (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
        0,
      );
      // total = tạm tính − giảm trừ (mình nợ khách) + nợ cũ (khách nợ mình)
      const total_amount =
        subtotal
        - (invoiceFields.discount_amount || 0)
        + (invoiceFields.previous_debt || 0);

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
          room_id: invoiceFields.room_id,          invoice_number,
          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          discount_notes: invoiceFields.discount_notes || null,
          electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          paid_amount: 0,
          previous_debt: invoiceFields.previous_debt || 0,
          previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
          notes: invoiceFields.notes || null,
          template_id: invoiceFields.template_id || null,
          creator_name: creatorName,
        } as any)
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Tiêu credit khi áp credit vào discount của HĐ này.
      const appliedCredit = invoiceFields.applied_credit ?? 0;
      if (appliedCredit > 0 && invoiceFields.contract_id) {
        const { error: creditErr } = await supabase
          .from('excess_amounts' as any)
          .insert({
            user_id: user.id,
            contract_id: invoiceFields.contract_id,
            amount: -appliedCredit,
            description: `Áp credit vào Giảm trừ HĐ ${invoice_number}`,
            source_invoice_id: invoice.id,
            source_payment_id: null,
          } as any);
        if (creditErr) throw creditErr;
      }

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
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Dữ liệu đã được TẠO thành công',
        description: 'Hoá đơn mới đã được duyệt và sẵn sàng ghi nhận thanh toán.',
      });
    },
    onError: (error: Error) => {
      const msg = error.message || '';
      const friendly = msg.includes('idx_invoices_unique_contract_billing')
        ? 'Hợp đồng này đã có hoá đơn cho kỳ thanh toán đã chọn. Hệ thống chỉ cho phép 1 hoá đơn / hợp đồng / kỳ.'
        : msg;
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo hoá đơn',
        description: friendly,
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
      const user = await getSessionUser();
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
      // total = tạm tính − giảm trừ + nợ cũ
      const total_amount =
        subtotal
        - (invoiceFields.discount_amount || 0)
        + (invoiceFields.previous_debt || 0);

      // Update invoice
      const { data: invoice, error: updateError } = await supabase
        .from('invoices')
        .update({
          contract_id: invoiceFields.contract_id,
          building_id: invoiceFields.building_id,
          room_id: invoiceFields.room_id,          billing_month: invoiceFields.billing_month,
          issue_date: invoiceFields.issue_date,
          due_date: invoiceFields.due_date,
          subtotal,
          discount_amount: invoiceFields.discount_amount || 0,
          discount_notes: invoiceFields.discount_notes || null,
          electricity_prev_overridden: !!invoiceFields.electricity_prev_overridden,
          total_amount,
          prepaid_amount: invoiceFields.prepaid_amount || 0,
          previous_debt: invoiceFields.previous_debt || 0,
          previous_debt_sources: invoiceFields.previous_debt_sources ?? [],
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
  /** Lọc nhiều toà — RPC nhận p_building_ids (migration 20260610100000). */
  building_ids?: string[];
  room_id?: string;
  status?: InvoiceStatus;
  start_date?: string;
  end_date?: string;
  billing_month?: string;
  payment_status?: 'paid' | 'unpaid' | 'partial';
}

export interface InvoiceStatistics {
  total_amount: number;
  total_paid: number;
  total_remaining: number;
  total_refunded: number;
  total_count: number;
  rent_amount: number;
  electric_amount: number;
  water_amount: number;
  pdv_amount: number;
  total_collected: number;
  payment_tm: number;
  payment_tk: number;
  payment_tt: number;
  /** Cấn trừ — payments method='CT' do thanh lý tự sinh (cấn cọc/đối trừ công
   *  nợ), KHÔNG phải tiền mặt. Tách riêng để TM không bị phồng. */
  payment_ct: number;
  change_amount: number;
  /** Cọc đã thu — tổng IE INCOME APPROVED có item is_deposit, filter theo
   *  area/building/room/billing_month tương tự các stat khác. Tách riêng để
   *  không trộn vào TM/TK/TT vì cọc không phải thanh toán hoá đơn. */
  deposit_collected: number;
}

export const useInvoiceStatistics = (filters?: InvoiceStatisticsFilters) => {
  return useQuery({
    queryKey: ['invoice-statistics', filters],
    queryFn: async (): Promise<InvoiceStatistics> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // RBAC v2: không truyền p_user_id; quyền xác định qua can_access_building().
      // Nhờ vậy super_admin thấy đủ data của các building trong scope (kể cả invoice
      // do staff khác tạo), khắc phục lỗi "lệch owner" của bản v1.
      const { data, error } = await (supabase.rpc as any)('get_invoice_statistics_v2', {
        p_building_id: filters?.building_id ?? null,
        p_room_id: filters?.room_id ?? null,
        p_status: filters?.status ?? null,
        p_start_date: filters?.start_date ?? null,
        p_end_date: filters?.end_date ?? null,
        p_billing_month: filters?.billing_month ?? null,
        p_payment_status: filters?.payment_status ?? null,
        p_building_ids: filters?.building_ids?.length ? filters.building_ids : null,
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      return {
        total_amount: Number(result?.total_amount ?? 0),
        total_paid: Number(result?.total_paid ?? 0),
        total_remaining: Number(result?.total_remaining ?? 0),
        total_refunded: Number(result?.total_refunded ?? 0),
        total_count: Number(result?.total_count ?? 0),
        rent_amount: Number(result?.rent_amount ?? 0),
        electric_amount: Number(result?.electric_amount ?? 0),
        water_amount: Number(result?.water_amount ?? 0),
        pdv_amount: Number(result?.pdv_amount ?? 0),
        total_collected: Number(result?.total_collected ?? 0),
        payment_tm: Number(result?.payment_tm ?? 0),
        payment_tk: Number(result?.payment_tk ?? 0),
        payment_tt: Number(result?.payment_tt ?? 0),
        payment_ct: Number(result?.payment_ct ?? 0),
        change_amount: Number(result?.change_amount ?? 0),
        deposit_collected: Number(result?.deposit_collected ?? 0),
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
      const user = await getSessionUser();
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

      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await (supabase
        .from('excess_amounts' as any) as any)
        .select('amount, source_invoice:invoices!source_invoice_id(deleted_at)')
        .eq('contract_id', contractId)
        ;

      if (error) throw error;

      // Sum all amounts (positive = credit added, negative = credit used).
      // Bỏ qua row nếu source_invoice đã soft-delete (auto rollback khi huỷ HĐ).
      const total = (data || []).reduce((sum: number, row: any) => {
        const invDeleted = row.source_invoice?.deleted_at;
        if (invDeleted) return sum;
        return sum + (Number(row.amount) || 0);
      }, 0);
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
      const user = await getSessionUser();
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
// Legacy: useCancelInvoice (kept for backward compatibility)
// =============================================

// =============================================
// useRestoreInvoice - CANCELLED → APPROVED (super admin)
// Khôi phục lại HĐ đã huỷ. RLS đã có policy super_admin bypass nên client
// chỉ cần update; FE chịu trách nhiệm chỉ render nút này cho super admin.
// =============================================

export const useRestoreInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .update({
          status: 'APPROVED' as any,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
        } as any)
        .eq('id', invoiceId)
        .eq('status', 'CANCELLED' as any)
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
        title: 'Đã phục hồi hoá đơn',
        description: 'Hoá đơn đã chuyển về trạng thái Đã duyệt.',
      });
    },
    onError: (error: Error) => {
      const msg = error.message || '';
      const friendly = msg.includes('idx_invoices_unique_contract_billing')
        ? 'Đã có hoá đơn khác cho hợp đồng + kỳ thanh toán này. Hãy huỷ hoá đơn đó trước khi phục hồi.'
        : msg;
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi phục hồi hoá đơn',
        description: friendly,
      });
    },
  });
};

/**
 * Super admin xoá hoá đơn ở mọi trạng thái:
 *   hard-delete payments + excess_amounts liên quan, set status='CANCELLED'.
 * HĐ sau khi xoá xuất hiện trong filter "Đã huỷ", có thể phục hồi qua
 * `useRestoreInvoice` (CANCELLED → APPROVED), nhưng payments KHÔNG khôi phục lại.
 */
export const useForceCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await (supabase.rpc as any)('super_admin_force_cancel_invoice', {
        p_invoice_id: invoiceId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-legacy'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });

      toast({
        title: 'Đã xoá hoá đơn',
        description: 'Hoá đơn và các payment liên quan đã bị xoá. Có thể phục hồi hoá đơn trong filter "Đã huỷ".',
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

export const useCancelInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const user = await getSessionUser();
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
