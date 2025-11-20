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
        query = query.eq('status', filters.status as any);
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
        type: item.type as any,
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
        .insert([{
          user_id: user.id,
          invoice_id: data.invoice_id,
          amount: data.amount,
          payment_method: data.payment_method as any,
          payment_date: data.payment_date,
          notes: data.notes,
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
// Bulk Create Meter Readings
// =============================================

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
        title: 'Ghi nhận chỉ số thành công!',
        description: `Đã ghi nhận ${data.length} chỉ số công tơ.`,
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

// =============================================
// Auto-Generate Invoices (Bulk)
// =============================================

export interface AutoGenerateInvoicesData {
  billing_period_start: string;
  billing_period_end: string;
  issue_date: string;
  due_date: string;
  contract_ids?: string[]; // Optional: specific contracts, or all active if not provided
}

export const useAutoGenerateInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: AutoGenerateInvoicesData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get active contracts
      let query = supabase
        .from('contracts')
        .select(`
          id,
          contract_number,
          tenant_id,
          room_id,
          bed_id,
          rent_price,
          payment_cycle,
          contract_services (
            service_id,
            unit_price,
            service:services (
              id,
              name,
              billing_type,
              unit
            )
          )
        `)
        .eq('user_id', user.id)
        .eq('status', 'ACTIVE');

      if (data.contract_ids && data.contract_ids.length > 0) {
        query = query.in('id', data.contract_ids);
      }

      const { data: contracts, error: contractsError } = await query;
      if (contractsError) throw contractsError;
      if (!contracts || contracts.length === 0) {
        return { created_count: 0 };
      }

      // Create invoices for each contract
      const invoicesToCreate = contracts.map((contract) => ({
        user_id: user.id,
        contract_id: contract.id,
        title: `Hóa đơn ${contract.contract_number || contract.id.slice(0, 8)} - ${new Date(data.billing_period_start).toLocaleDateString('vi-VN', { month: '2-digit', year: 'numeric' })}`,
        billing_period_start: data.billing_period_start,
        billing_period_end: data.billing_period_end,
        issue_date: data.issue_date,
        due_date: data.due_date,
        status: 'DRAFT',
        total_amount: contract.rent_price, // Will be updated after items are created
        paid_amount: 0,
      }));

      const { data: createdInvoices, error: invoicesError } = await supabase
        .from('invoices')
        .insert(invoicesToCreate)
        .select();

      if (invoicesError) throw invoicesError;

      // Create invoice items for each invoice
      const invoiceItems: any[] = [];

      for (let i = 0; i < createdInvoices.length; i++) {
        const invoice = createdInvoices[i];
        const contract = contracts[i];

        // Add rent item
        invoiceItems.push({
          invoice_id: invoice.id,
          type: 'RENT',
          description: 'Tiền thuê phòng',
          quantity: 1,
          unit_price: contract.rent_price,
          amount: contract.rent_price,
        });

        // Add fixed service items
        if (contract.contract_services) {
          for (const cs of contract.contract_services) {
            if (cs.service?.type === 'FIXED') {
              invoiceItems.push({
                invoice_id: invoice.id,
                type: 'SERVICE',
                description: cs.service.name,
                quantity: 1,
                unit_price: cs.unit_price,
                amount: cs.unit_price,
              });
            }
          }
        }
      }

      if (invoiceItems.length > 0) {
        const { error: itemsError } = await supabase
          .from('invoice_items')
          .insert(invoiceItems);

        if (itemsError) throw itemsError;
      }

      return { created_count: createdInvoices.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Tạo hóa đơn tự động thành công!',
        description: `Đã tạo ${result?.created_count || 0} hóa đơn mới.`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo hóa đơn tự động thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Bulk Approve Invoices
// =============================================

export const useBulkApproveInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'APPROVED' })
        .in('id', invoiceIds)
        .eq('user_id', user.id)
        .eq('status', 'DRAFT')
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });

      toast({
        title: 'Duyệt hóa đơn thành công!',
        description: `Đã duyệt ${data.length} hóa đơn.`,
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
