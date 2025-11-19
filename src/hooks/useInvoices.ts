import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

// =============================================
// Types
// =============================================

type Invoice = Database['public']['Tables']['invoices']['Row'];
type InvoiceInsert = Database['public']['Tables']['invoices']['Insert'];
type Payment = Database['public']['Tables']['payments']['Row'];
type MeterReading = Database['public']['Tables']['meter_readings']['Row'];

export interface InvoiceWithRelations extends Invoice {
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
      building: { name: string };
    };
    bed?: {
      id: string;
      name: string;
    };
  };
  invoice_items?: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
    type: string;
  }>;
  payments?: Array<{
    id: string;
    amount: number;
    payment_date: string;
    payment_method: string;
  }>;
}

export interface CreateInvoiceData {
  contract_id: string;
  billing_period_start: string;
  billing_period_end: string;
  issue_date: string;
  due_date: string;
  title: string;
  items: Array<{
    type: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
    service_id?: string;
  }>;
  notes?: string;
}

export interface RecordPaymentData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
}

export interface MeterReadingData {
  contract_id: string;
  service_id: string;
  meter_type: string;
  reading_date: string;
  current_reading: number;
  previous_reading: number;
  notes?: string;
}

// =============================================
// Get All Invoices
// =============================================

export const useInvoices = (filters?: {
  status?: string;
  contract_id?: string;
}) => {
  return useQuery({
    queryKey: ['invoices', filters],
    queryFn: async (): Promise<InvoiceWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('invoices')
        .select(`
          *,
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_number,
            tenant:tenants!contracts_tenant_id_fkey (
              id, full_name, phone
            ),
            room:rooms!contracts_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (name)
            ),
            bed:beds!contracts_bed_id_fkey (
              id, name
            )
          ),
          invoice_items (
            id, description, quantity, unit_price, amount, type
          ),
          payments (
            id, amount, payment_date, payment_method
          )
        `)
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.contract_id) {
        query = query.eq('contract_id', filters.contract_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as InvoiceWithRelations[];
    },
  });
};

// =============================================
// Get Single Invoice
// =============================================

export const useInvoice = (invoiceId?: string) => {
  return useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async (): Promise<InvoiceWithRelations | null> => {
      if (!invoiceId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .select(`
          *,
          contract:contracts!invoices_contract_id_fkey (
            id, contract_number,
            tenant:tenants!contracts_tenant_id_fkey (
              id, full_name, phone, email
            ),
            room:rooms!contracts_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (name)
            )
          ),
          invoice_items (
            id, description, quantity, unit_price, amount, type, service_id
          ),
          payments (
            id, amount, payment_date, payment_method, notes
          )
        `)
        .eq('id', invoiceId)
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .single();

      if (error) throw error;
      return data as InvoiceWithRelations;
    },
    enabled: !!invoiceId,
  });
};

// =============================================
// Create Invoice
// =============================================

export const useCreateInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateInvoiceData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { items, ...invoiceData } = data;

      // Calculate totals
      const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
      const total_amount = subtotal;

      // Create invoice
      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .insert({
          ...invoiceData,
          user_id: user.id,
          status: 'DRAFT',
          subtotal,
          total_amount,
          paid_amount: 0,
        })
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Add invoice items
      const invoiceItems = items.map(item => ({
        invoice_id: invoice.id,
        type: item.type,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: item.amount,
        service_id: item.service_id,
      }));

      const { error: itemsError } = await supabase
        .from('invoice_items')
        .insert(invoiceItems);

      if (itemsError) throw itemsError;

      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Tạo hóa đơn thành công!',
        description: 'Hóa đơn đã được tạo ở trạng thái nháp.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo hóa đơn thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Approve Invoice
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
        .update({ status: 'APPROVED' })
        .eq('id', invoiceId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });

      toast({
        title: 'Duyệt hóa đơn thành công!',
        description: 'Hóa đơn đã được duyệt và gửi đến khách thuê.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Duyệt hóa đơn thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Record Payment
// =============================================

export const useRecordPayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RecordPaymentData) => {
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
            status: newStatus,
            paid_date: newPaidAmount >= invoice.total_amount ? new Date().toISOString().split('T')[0] : null,
          })
          .eq('id', data.invoice_id);
      }

      return payment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });

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
// Record Meter Reading
// =============================================

export const useRecordMeterReading = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: MeterReadingData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: reading, error } = await supabase
        .from('meter_readings')
        .insert({
          user_id: user.id,
          contract_id: data.contract_id,
          service_id: data.service_id,
          meter_type: data.meter_type,
          reading_date: data.reading_date,
          previous_reading: data.previous_reading,
          current_reading: data.current_reading,
          notes: data.notes,
        })
        .select()
        .single();

      if (error) throw error;
      return reading;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter_readings'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Ghi nhận chỉ số thành công!',
        description: 'Chỉ số công tơ đã được ghi nhận.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Ghi nhận chỉ số thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Get Meter Readings
// =============================================

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
        .eq('user_id', user.id)
        .order('reading_date', { ascending: false });

      if (contractId) {
        query = query.eq('contract_id', contractId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!contractId || contractId === undefined,
  });
};

// =============================================
// Delete Invoice (Soft Delete)
// =============================================

export const useDeleteInvoice = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('invoices')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', invoiceId)
        .eq('user_id', user.id)
        .eq('status', 'DRAFT'); // Only allow deleting draft invoices

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });

      toast({
        title: 'Xóa hóa đơn thành công!',
        description: 'Hóa đơn nháp đã được xóa.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xóa hóa đơn thất bại',
        description: error.message,
      });
    },
  });
};
