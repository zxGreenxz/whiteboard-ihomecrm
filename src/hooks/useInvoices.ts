import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';
import type { PaginatedData } from '@/hooks/usePagination';

// =============================================
// Types
// =============================================

type Invoice = Database['public']['Tables']['invoices']['Row'];
type InvoiceInsert = Database['public']['Tables']['invoices']['Insert'];
type Payment = Database['public']['Tables']['payments']['Row'];
type MeterReading = Database['public']['Tables']['meter_readings']['Row'];

export interface InvoiceFilters {
  status?: string;
  contract_id?: string;
  search?: string;
}

export interface InvoicePaginationParams {
  page?: number;
  pageSize?: number;
}

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
    notes?: string;
    receipt_image_url?: string;
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
  receipt_image_url?: string;
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
// Get All Invoices (with optional pagination)
// =============================================

export const useInvoices = (
  filters?: InvoiceFilters,
  pagination?: InvoicePaginationParams
) => {
  return useQuery({
    queryKey: ['invoices', filters, pagination],
    queryFn: async (): Promise<PaginatedData<InvoiceWithRelations>> => {
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
            id, amount, payment_date, payment_method, notes, receipt_image_url
          )
        `, { count: 'exact' })
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }
      if (filters?.contract_id) {
        query = query.eq('contract_id', filters.contract_id);
      }

      // Apply pagination if provided
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        data: data as InvoiceWithRelations[],
        count: count || 0
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
            id, amount, payment_date, payment_method, notes, receipt_image_url
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

export type InvoiceGenerationType = 'RENT_ONLY' | 'SERVICE_ONLY' | 'RENT_AND_SERVICE';

export interface AutoGenerateInvoicesData {
  billing_period_start: string;
  billing_period_end: string;
  issue_date: string;
  due_date: string;
  contract_ids?: string[]; // Optional: specific contracts, or all active if not provided
  building_id?: string; // Filter by building
  invoice_type: InvoiceGenerationType; // Type of invoice to generate
}

export const useAutoGenerateInvoices = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: AutoGenerateInvoicesData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { invoice_type = 'RENT_AND_SERVICE' } = data;

      // Get invoice config for settings
      const { data: invoiceSettings } = await supabase
        .from('settings')
        .select('value')
        .eq('user_id', user.id)
        .eq('key', 'invoice_config')
        .maybeSingle();

      const invoiceConfig = invoiceSettings?.value as any;
      const includePreviousDebt = invoiceConfig?.include_previous_debt ?? true;

      // Get active contracts with full details
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
          start_billing_date,
          start_date,
          discounts,
          room:rooms!contracts_room_id_fkey (
            id,
            name,
            building_id
          ),
          bed:beds!contracts_bed_id_fkey (
            id,
            name,
            room:rooms!beds_room_id_fkey (
              id,
              name,
              building_id
            )
          ),
          contract_services (
            id,
            service_id,
            unit_price,
            initial_reading,
            service:services!contract_services_service_id_fkey (
              id,
              name,
              billing_type,
              unit
            )
          )
        `)
        .eq('user_id', user.id)
        .eq('status', 'ACTIVE')
        .is('deleted_at', null);

      if (data.contract_ids && data.contract_ids.length > 0) {
        query = query.in('id', data.contract_ids);
      }

      const { data: contracts, error: contractsError } = await query;
      if (contractsError) throw contractsError;
      if (!contracts || contracts.length === 0) {
        return { created_count: 0, skipped_count: 0 };
      }

      // Filter by building if specified
      let filteredContracts = contracts;
      if (data.building_id) {
        filteredContracts = contracts.filter((contract) => {
          const buildingId = contract.room?.building_id || contract.bed?.room?.building_id;
          return buildingId === data.building_id;
        });
      }

      if (filteredContracts.length === 0) {
        return { created_count: 0, skipped_count: 0 };
      }

      // Check for existing invoices in the same billing period to avoid duplicates
      const contractIds = filteredContracts.map(c => c.id);
      const { data: existingInvoices } = await supabase
        .from('invoices')
        .select('contract_id')
        .in('contract_id', contractIds)
        .gte('billing_period_start', data.billing_period_start)
        .lte('billing_period_end', data.billing_period_end)
        .is('deleted_at', null);

      const existingContractIds = new Set((existingInvoices || []).map(i => i.contract_id));
      const contractsToProcess = filteredContracts.filter(c => !existingContractIds.has(c.id));
      const skippedCount = filteredContracts.length - contractsToProcess.length;

      if (contractsToProcess.length === 0) {
        return { created_count: 0, skipped_count: skippedCount };
      }

      // Get meter readings for utility calculations
      const { data: meterReadings } = await supabase
        .from('meter_readings')
        .select('*')
        .in('contract_id', contractsToProcess.map(c => c.id))
        .order('reading_date', { ascending: false });

      // Group meter readings by contract
      const meterReadingsByContract = new Map<string, any[]>();
      (meterReadings || []).forEach(reading => {
        if (!meterReadingsByContract.has(reading.contract_id)) {
          meterReadingsByContract.set(reading.contract_id, []);
        }
        meterReadingsByContract.get(reading.contract_id)!.push(reading);
      });

      // Get previous debts if enabled
      const previousDebts = new Map<string, number>();
      if (includePreviousDebt) {
        const { data: unpaidInvoices } = await supabase
          .from('invoices')
          .select('contract_id, total_amount, paid_amount')
          .in('contract_id', contractsToProcess.map(c => c.id))
          .in('status', ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'])
          .is('deleted_at', null);

        (unpaidInvoices || []).forEach(invoice => {
          const debt = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
          if (debt > 0) {
            const currentDebt = previousDebts.get(invoice.contract_id) || 0;
            previousDebts.set(invoice.contract_id, currentDebt + debt);
          }
        });
      }

      // Generate invoice numbers
      const { generateInvoiceNumber } = await import('@/lib/codeGenerator');
      const prefix = invoiceConfig?.invoice_number_prefix || 'INV';
      const format = invoiceConfig?.invoice_number_format || '{prefix}{year}{month}{seq:4}';
      const autoGenerateNumber = invoiceConfig?.auto_generate_invoice_number !== false;

      // Create invoices and items
      const createdInvoices: any[] = [];
      const allInvoiceItems: any[] = [];

      for (const contract of contractsToProcess) {
        // Calculate invoice items based on type
        const items: Array<{
          type: string;
          description: string;
          quantity: number;
          unit_price: number;
          amount: number;
          service_id?: string;
          previous_reading?: number;
          current_reading?: number;
        }> = [];

        // Add rent item
        if (invoice_type === 'RENT_ONLY' || invoice_type === 'RENT_AND_SERVICE') {
          const rentPrice = contract.rent_price || 0;
          items.push({
            type: 'RENT',
            description: 'Tiền thuê phòng',
            quantity: 1,
            unit_price: rentPrice,
            amount: rentPrice,
          });
        }

        // Add service items
        if (invoice_type === 'SERVICE_ONLY' || invoice_type === 'RENT_AND_SERVICE') {
          const services = contract.contract_services || [];

          for (const cs of services) {
            const service = cs.service;
            if (!service) continue;

            const billingType = service.billing_type;

            // Fixed services and per-room services
            if (billingType === 'FIXED' || billingType === 'PER_ROOM') {
              items.push({
                type: 'SERVICE',
                description: service.name,
                quantity: 1,
                unit_price: cs.unit_price,
                amount: cs.unit_price,
                service_id: cs.service_id,
              });
            }

            // Per-person services (assumes 1 person if no quantity specified)
            if (billingType === 'PER_PERSON') {
              const quantity = 1; // Default to 1 person per contract
              items.push({
                type: 'SERVICE',
                description: service.name,
                quantity: quantity,
                unit_price: cs.unit_price,
                amount: quantity * cs.unit_price,
                service_id: cs.service_id,
              });
            }

            // Meter reading services (ELECTRIC, WATER)
            if (billingType === 'METER_READING') {
              const contractReadings = meterReadingsByContract.get(contract.id) || [];
              const serviceReadings = contractReadings
                .filter((r: any) => r.service_id === cs.service_id)
                .sort((a: any, b: any) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime());

              if (serviceReadings.length > 0) {
                const latestReading = serviceReadings[0];
                const usage = (latestReading.current_reading || 0) - (latestReading.previous_reading || 0);
                if (usage > 0) {
                  items.push({
                    type: 'SERVICE',
                    description: `${service.name} (${usage} ${service.unit || 'kWh'})`,
                    quantity: usage,
                    unit_price: cs.unit_price,
                    amount: usage * cs.unit_price,
                    service_id: cs.service_id,
                    previous_reading: latestReading.previous_reading,
                    current_reading: latestReading.current_reading,
                  });
                }
              }
            }
          }
        }

        // Calculate subtotal
        const subtotal = items.reduce((sum, item) => sum + item.amount, 0);

        // Calculate contract discount (promotional discounts based on billing month)
        let discountAmount = 0;
        if (contract.discounts && Array.isArray(contract.discounts)) {
          const contractStartDate = new Date(contract.start_billing_date || contract.start_date);
          const billingStartDate = new Date(data.billing_period_start);

          // Calculate which month of the contract this billing period is
          const monthsDiff = (billingStartDate.getFullYear() - contractStartDate.getFullYear()) * 12 +
                            (billingStartDate.getMonth() - contractStartDate.getMonth()) + 1;

          // Find discount for this month
          const discountForMonth = (contract.discounts as Array<{ month: number; amount: number }>)
            .find(d => d.month === monthsDiff);

          if (discountForMonth) {
            discountAmount = discountForMonth.amount || 0;
          }
        }

        // Calculate totals
        const previousDebt = previousDebts.get(contract.id) || 0;
        const totalAmount = Math.max(0, subtotal - discountAmount + previousDebt);

        // Generate invoice number
        let invoiceNumber = null;
        if (autoGenerateNumber) {
          try {
            invoiceNumber = await generateInvoiceNumber(prefix, format, user.id, 'YEARLY');
          } catch (e) {
            console.error('Error generating invoice number:', e);
          }
        }

        // Create invoice title
        const billingMonth = new Date(data.billing_period_start).toLocaleDateString('vi-VN', {
          month: '2-digit',
          year: 'numeric'
        });
        const invoiceTypeLabel = invoice_type === 'RENT_ONLY' ? 'Tiền nhà' :
                                 invoice_type === 'SERVICE_ONLY' ? 'Dịch vụ' :
                                 'Tiền nhà & Dịch vụ';

        // Create invoice
        const { data: invoice, error: invoiceError } = await supabase
          .from('invoices')
          .insert({
            user_id: user.id,
            contract_id: contract.id,
            invoice_number: invoiceNumber,
            title: `${invoiceTypeLabel} - ${billingMonth}`,
            billing_period_start: data.billing_period_start,
            billing_period_end: data.billing_period_end,
            issue_date: data.issue_date,
            due_date: data.due_date,
            status: 'DRAFT',
            subtotal,
            discount_amount: discountAmount > 0 ? discountAmount : null,
            previous_debt: previousDebt > 0 ? previousDebt : null,
            total_amount: totalAmount,
            paid_amount: 0,
            remaining_amount: totalAmount,
          })
          .select()
          .single();

        if (invoiceError) {
          console.error('Error creating invoice:', invoiceError);
          continue;
        }

        createdInvoices.push(invoice);

        // Prepare invoice items
        for (const item of items) {
          allInvoiceItems.push({
            invoice_id: invoice.id,
            type: item.type as any,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: item.amount,
            service_id: item.service_id,
            previous_reading: item.previous_reading,
            current_reading: item.current_reading,
          });
        }

        // Add discount as an item if exists
        if (discountAmount > 0) {
          allInvoiceItems.push({
            invoice_id: invoice.id,
            type: 'DISCOUNT',
            description: 'Giảm giá khuyến mại',
            quantity: 1,
            unit_price: -discountAmount,
            amount: -discountAmount,
          });
        }

        // Add previous debt as an item if exists
        if (previousDebt > 0) {
          allInvoiceItems.push({
            invoice_id: invoice.id,
            type: 'OTHER',
            description: 'Công nợ tồn đọng kỳ trước',
            quantity: 1,
            unit_price: previousDebt,
            amount: previousDebt,
          });
        }
      }

      // Insert all invoice items in batch
      if (allInvoiceItems.length > 0) {
        const { error: itemsError } = await supabase
          .from('invoice_items')
          .insert(allInvoiceItems);

        if (itemsError) {
          console.error('Error creating invoice items:', itemsError);
        }
      }

      return {
        created_count: createdInvoices.length,
        skipped_count: skippedCount
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      const createdCount = result?.created_count || 0;
      const skippedCount = result?.skipped_count || 0;

      let description = `Đã tạo ${createdCount} hóa đơn mới.`;
      if (skippedCount > 0) {
        description += ` Bỏ qua ${skippedCount} hợp đồng đã có hóa đơn trong kỳ.`;
      }

      toast({
        title: createdCount > 0 ? 'Tạo hóa đơn tự động thành công!' : 'Không có hóa đơn mới được tạo',
        description,
        variant: createdCount > 0 ? 'default' : 'destructive',
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
