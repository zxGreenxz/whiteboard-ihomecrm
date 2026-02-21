import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';
import type { PaginatedData } from '@/hooks/usePagination';

// =============================================
// Types
// =============================================

type Contract = Database['public']['Tables']['contracts']['Row'];
type ContractInsert = Database['public']['Tables']['contracts']['Insert'];
type ContractUpdate = Database['public']['Tables']['contracts']['Update'];

export interface ContractFilters {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  bed_id?: string;
  search?: string;
}

export interface ContractPaginationParams {
  page?: number;
  pageSize?: number;
}

export interface ContractTenantWithRelations {
  id: string;
  tenant_id: string;
  is_representative: boolean;
  move_in_date: string | null;
  tenant: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
}

export interface ContractWithRelations extends Contract {
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building: {
      id: string;
      name: string;
      code: string | null;
    };
  };
  bed?: {
    id: string;
    name: string;
    code: string | null;
    room: {
      id: string;
      name: string;
      building: {
        id: string;
        name: string;
      };
    };
  };
  contract_services?: Array<{
    id: string;
    service_id: string;
    unit_price: number;
    initial_reading: number | null;
    service: {
      id: string;
      name: string;
      type: string;
      unit: string;
    };
  }>;
  contract_tenants?: ContractTenantWithRelations[];
}

export interface ContractTenantData {
  tenant_id: string;
  is_representative: boolean;
  move_in_date?: string;
}

export interface CreateContractData {
  tenant_id: string;
  room_id?: string;
  bed_id?: string;
  signed_date: string;
  start_date: string;
  start_billing_date?: string;
  end_date: string;
  rent_price: number;
  payment_cycle: string;
  total_deposit: number;
  deposit_paid?: number;
  initial_electricity_reading?: number;
  initial_water_reading?: number;
  notes?: string;
  services?: Array<{
    service_id: string;
    unit_price: number;
    initial_reading?: number;
  }>;
  contract_template_id?: string;
  invoice_template_id?: string;
  discounts?: Array<{
    month: number;
    amount: number;
    reason?: string;
  }>;
  contract_file_url?: string;
  // Multiple tenants support
  tenants?: ContractTenantData[];
}

export interface ExtendContractData {
  contract_id: string;
  extension_months: number;
  new_rent_price?: number;
  notes?: string;
}

export interface TransferContractData {
  contract_id: string;
  transfer_type: 'TENANT_CHANGE' | 'ROOM_CHANGE' | 'BOTH_CHANGE';
  new_tenant_id?: string;
  new_room_id?: string;
  new_bed_id?: string;
  new_rent_price?: number;
  transfer_fee?: number;
  reason?: string;
}

export interface TerminateContractData {
  contract_id: string;
  termination_type: 'NORMAL' | 'EARLY_TENANT' | 'EARLY_OWNER' | 'BREACH' | 'FORFEIT';
  actual_move_out_date: string;
  early_termination_fee?: number;
  damage_fee?: number;
  damage_description?: string;
  cleaning_fee?: number;
  notes?: string;
}

// =============================================
// Get All Contracts (with optional pagination)
// =============================================

export const useContracts = (
  filters?: ContractFilters,
  pagination?: ContractPaginationParams
) => {
  return useQuery({
    queryKey: ['contracts', filters, pagination],
    queryFn: async (): Promise<PaginatedData<ContractWithRelations>> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Build the select query with count
      let query = supabase
        .from('contracts')
        .select(`
          *,
          tenant:tenants!contracts_tenant_id_fkey (
            id, full_name, phone, email
          ),
          room:rooms!contracts_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name, code
            )
          ),
          bed:beds!contracts_bed_id_fkey (
            id, name, code,
            room:rooms!beds_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          ),
          contract_tenants (
            id, tenant_id, is_representative, move_in_date,
            tenant:tenants!left (
              id, full_name, phone, email
            )
          )
        `, { count: 'exact' })
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }
      if (filters?.tenant_id) {
        query = query.eq('tenant_id', filters.tenant_id);
      }
      if (filters?.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters?.bed_id) {
        query = query.eq('bed_id', filters.bed_id);
      }

      // Apply pagination if provided
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error('useContracts error:', error);
        // Return empty data instead of throwing to prevent crash
        return { data: [], count: 0 };
      }

      return {
        data: (data || []) as ContractWithRelations[],
        count: count || 0
      };
    },
  });
};

// Legacy hook for backwards compatibility (returns array directly)
export const useContractsLegacy = (filters?: {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  bed_id?: string;
}) => {
  return useQuery({
    queryKey: ['contracts-legacy', filters],
    queryFn: async (): Promise<ContractWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('contracts')
        .select(`
          *,
          tenant:tenants!contracts_tenant_id_fkey (
            id, full_name, phone, email
          ),
          room:rooms!contracts_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name, code
            )
          ),
          bed:beds!contracts_bed_id_fkey (
            id, name, code,
            room:rooms!beds_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          ),
          contract_tenants (
            id, tenant_id, is_representative, move_in_date,
            tenant:tenants!left (
              id, full_name, phone, email
            )
          )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }
      if (filters?.tenant_id) {
        query = query.eq('tenant_id', filters.tenant_id);
      }
      if (filters?.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters?.bed_id) {
        query = query.eq('bed_id', filters.bed_id);
      }

      const { data, error } = await query;
      if (error) {
        console.error('useContractsLegacy error:', error);
        return []; // Return empty array instead of throwing
      }
      return (data || []) as ContractWithRelations[];
    },
  });
};

// =============================================
// Get Single Contract
// =============================================

export const useContract = (contractId?: string) => {
  return useQuery({
    queryKey: ['contract', contractId],
    queryFn: async (): Promise<ContractWithRelations | null> => {
      if (!contractId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('contracts')
        .select(`
          *,
          tenant:tenants!contracts_tenant_id_fkey (
            id, full_name, phone, email, id_number
          ),
          room:rooms!contracts_room_id_fkey (
            id, name, code, rent_price, deposit_amount,
            building:buildings!rooms_building_id_fkey (
              id, name, code
            )
          ),
          bed:beds!contracts_bed_id_fkey (
            id, name, code, rent_price, deposit_amount,
            room:rooms!beds_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          ),
          contract_tenants (
            id, tenant_id, is_representative, move_in_date,
            tenant:tenants!left (
              id, full_name, phone, email
            )
          )
        `)
        .eq('id', contractId)
        .eq('user_id', user.id)
        .single();

      if (error) throw error;
      return data as ContractWithRelations;
    },
    enabled: !!contractId && contractId !== 'create',
  });
};

// =============================================
// Create Contract
// =============================================

export const useCreateContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateContractData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Extract services, start_billing_date, and tenants before creating contract
      const { services, start_billing_date, tenants, ...contractData } = data;

      // Create contract
      // We cast to any to avoid TS errors with new fields until types are regenerated
      const insertData: any = {
        ...contractData,
        user_id: user.id,
        status: 'ACTIVE',
        payment_cycle: contractData.payment_cycle,
      };

      const { data: contract, error: contractError } = await supabase
        .from('contracts')
        .insert([insertData])
        .select()
        .single();

      if (contractError) throw contractError;

      // Add tenants to contract_tenants junction table
      if (tenants && tenants.length > 0) {
        const contractTenants = tenants.map(t => ({
          contract_id: contract.id,
          tenant_id: t.tenant_id,
          is_representative: t.is_representative,
          move_in_date: t.move_in_date,
        }));

        const { error: tenantsError } = await (supabase as any)
          .from('contract_tenants')
          .insert(contractTenants);

        if (tenantsError) {
          console.error('Error inserting contract tenants:', tenantsError);
          toast({
            variant: 'destructive',
            title: 'Cảnh báo: Lỗi lưu khách thuê',
            description: `Hợp đồng đã tạo nhưng có lỗi khi lưu danh sách khách thuê. Vui lòng kiểm tra lại.`,
          });
        }
      }

      // Add services if provided
      if (services && services.length > 0) {
        const contractServices = services.map(service => ({
          contract_id: contract.id,
          service_id: service.service_id,
          unit_price: service.unit_price,
          initial_reading: service.initial_reading,
        }));

        const { error: servicesError } = await supabase
          .from('contract_services')
          .insert(contractServices);

        if (servicesError) throw servicesError;
      }

      // Auto-create invoice if enabled in settings
      try {
        const { autoCreateInvoiceForContract } = await import('@/lib/contractHelpers');
        const invoiceId = await autoCreateInvoiceForContract(contract.id, user.id);
        if (invoiceId) {
          console.log('Auto-created invoice:', invoiceId);
        }
      } catch (e) {
        console.error('Error auto-creating invoice:', e);
        // Don't throw - contract creation was successful
      }

      return contract;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] }); // Also refresh invoices

      toast({
        title: 'Tạo hợp đồng thành công!',
        description: 'Hợp đồng đã được tạo và kích hoạt.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo hợp đồng thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Update Contract
// =============================================

export const useUpdateContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...data }: ContractUpdate & { id: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: contract, error } = await supabase
        .from('contracts')
        .update(data)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return contract;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contract'] });

      toast({
        title: 'Cập nhật thành công!',
        description: 'Thông tin hợp đồng đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Cập nhật thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Delete Contract (Soft Delete)
// =============================================

export const useDeleteContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (contractId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Use hard delete since deleted_at column doesn't exist yet
      const { error } = await supabase
        .from('contracts')
        .delete()
        .eq('id', contractId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Xóa thành công!',
        description: 'Hợp đồng đã được xóa.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xóa thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Extend Contract (Simple Extension)
// =============================================

export const useExtendContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: ExtendContractData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create extension record
      const { data: extension, error } = await supabase
        .from('contract_extensions')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          extension_months: data.extension_months,
          extension_type: 'SIMPLE',
          old_end_date: new Date().toISOString(),
          new_end_date: new Date().toISOString(),
          new_rent_price: data.new_rent_price,
          notes: data.notes,
          status: 'DRAFT',
        }])
        .select()
        .single();

      if (error) throw error;
      return extension;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contract'] });

      toast({
        title: 'Tạo yêu cầu gia hạn thành công!',
        description: 'Vui lòng duyệt yêu cầu để áp dụng.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Gia hạn thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Transfer Contract (Tenant/Room Change)
// =============================================

export const useTransferContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: TransferContractData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create transfer record
      const { data: transfer, error } = await supabase
        .from('contract_transfers')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          transfer_type: data.transfer_type,
          transfer_date: new Date().toISOString(),
          new_tenant_id: data.new_tenant_id,
          new_room_id: data.new_room_id,
          new_bed_id: data.new_bed_id,
          new_rent_price: data.new_rent_price,
          transfer_fee: data.transfer_fee || 0,
          reason: data.reason,
          status: 'DRAFT',
        }])
        .select()
        .single();

      if (error) throw error;
      return transfer;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

      toast({
        title: 'Tạo yêu cầu chuyển đổi thành công!',
        description: 'Vui lòng duyệt để áp dụng thay đổi.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo yêu cầu thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Terminate Contract
// =============================================

export const useTerminateContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: TerminateContractData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create termination record
      const { data: termination, error } = await supabase
        .from('contract_terminations')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          termination_type: data.termination_type,
          termination_date: new Date().toISOString(),
          total_deposit: 0,
          actual_move_out_date: data.actual_move_out_date,
          early_termination_fee: data.early_termination_fee || 0,
          damage_fee: data.damage_fee || 0,
          damage_description: data.damage_description,
          cleaning_fee: data.cleaning_fee || 0,
          notes: data.notes,
          status: 'PENDING_APPROVAL',
        }])
        .select()
        .single();

      if (error) throw error;
      return termination;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['pending-terminations'] });

      toast({
        title: 'Tạo yêu cầu thanh lý thành công!',
        description: 'Yêu cầu đang chờ duyệt tại mục "Duyệt thanh lý".',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo yêu cầu thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Estimate Termination Costs (Preview)
// =============================================

export const useEstimateTerminationCosts = () => {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      contract_id: string;
      move_out_date: string;
      damage_fee?: number;
      cleaning_fee?: number;
      early_termination_fee?: number;
      other_fees?: number;
      final_electricity_reading?: number;
      final_water_reading?: number;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch contract with relations
      const { data: contract, error: contractError } = await supabase
        .from('contracts')
        .select(`
          *,
          tenant:tenants(*),
          room:rooms(*, building:buildings(*)),
          bed:beds(*, room:rooms(*, building:buildings(*))),
          contract_services(*, service:services(*))
        `)
        .eq('id', data.contract_id)
        .eq('user_id', user.id)
        .single();

      if (contractError || !contract) {
        throw new Error('Contract not found');
      }

      // Fetch unpaid invoices
      const { data: unpaidInvoices } = await supabase
        .from('invoices')
        .select('*')
        .eq('contract_id', data.contract_id)
        .eq('user_id', user.id)
        .in('status', ['PENDING', 'OVERDUE', 'PARTIAL']);

      // Calculate dates
      const moveOutDate = new Date(data.move_out_date);
      const contractEndDate = new Date(contract.end_date);

      const isEarlyTermination = moveOutDate < contractEndDate;
      const daysEarly = isEarlyTermination
        ? Math.ceil((contractEndDate.getTime() - moveOutDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      // Calculate prorated rent
      const monthlyRent = contract.rent_price || 0;
      const daysInMonth = new Date(moveOutDate.getFullYear(), moveOutDate.getMonth() + 1, 0).getDate();
      const dailyRentRate = monthlyRent / daysInMonth;
      const dayOfMonth = moveOutDate.getDate();
      const proratedRent = Math.round(dailyRentRate * dayOfMonth);

      // Calculate prorated services
      let proratedServices = 0;
      if (contract.contract_services) {
        for (const cs of contract.contract_services) {
          if (cs.unit_price) {
            const monthlyAmount = cs.unit_price * (cs.quantity || 1);
            const dailyAmount = monthlyAmount / daysInMonth;
            proratedServices += Math.round(dailyAmount * dayOfMonth);
          }
        }
      }

      // Calculate outstanding debt
      let outstandingDebt = 0;
      if (unpaidInvoices) {
        for (const inv of unpaidInvoices) {
          const remaining = inv.total_amount - (inv.paid_amount || 0);
          if (remaining > 0) {
            outstandingDebt += remaining;
          }
        }
      }

      // Calculate fees
      const totalFees = (data.early_termination_fee || 0) +
                        (data.damage_fee || 0) +
                        (data.cleaning_fee || 0) +
                        (data.other_fees || 0);

      // Calculate totals
      const totalDeductions = outstandingDebt + proratedRent + proratedServices + totalFees;
      const totalDeposit = contract.total_deposit || 0;
      const refundAmount = totalDeposit - totalDeductions;

      return [{
        contract_id: contract.id,
        contract_number: contract.contract_number || '',
        total_deposit: totalDeposit,
        outstanding_debt: outstandingDebt,
        prorated_rent: proratedRent,
        prorated_days: dayOfMonth,
        daily_rent_rate: Math.round(dailyRentRate),
        prorated_services: proratedServices,
        total_fees: totalFees,
        total_deductions: totalDeductions,
        refund_amount: refundAmount,
        is_early_termination: isEarlyTermination,
        days_early: daysEarly,
      }];
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Lỗi tính toán',
        description: error.message,
      });
    },
  });
};

// =============================================
// Fetch Pending Terminations (for approval page)
// =============================================

export interface TerminationWithRelations {
  id: string;
  user_id: string;
  contract_id: string;
  termination_type: string;
  termination_date: string;
  actual_move_out_date: string;
  status: string;
  outstanding_debt: number;
  prorated_rent: number;
  prorated_services: number;
  early_termination_fee: number;
  damage_fee: number;
  damage_description: string | null;
  cleaning_fee: number;
  other_fees: number;
  other_fees_description: string | null;
  total_deductions: number;
  refund_amount: number;
  total_deposit: number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  contract?: ContractWithRelations;
}

export const usePendingTerminations = () => {
  return useQuery({
    queryKey: ['pending-terminations'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('contract_terminations')
        .select(`
          *,
          contract:contracts(
            *,
            tenant:tenants(id, full_name, phone, email),
            room:rooms(id, name, code, building:buildings(id, name, code)),
            bed:beds(id, name, code, room:rooms(id, name, building:buildings(id, name)))
          )
        `)
        .eq('user_id', user.id)
        .in('status', ['DRAFT', 'PENDING_APPROVAL'])
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as TerminationWithRelations[];
    },
  });
};

// =============================================
// Approve Termination
// =============================================

export const useApproveTermination = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      contract_id: string;
      refund_amount: number;
      payment_method?: string;
      notes?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // 1. Update termination status to APPROVED
      const { error: termError } = await supabase
        .from('contract_terminations')
        .update({
          status: 'APPROVED',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', data.termination_id)
        .eq('user_id', user.id);

      if (termError) throw termError;

      // 2. Update contract status to TERMINATED
      const { error: contractError } = await supabase
        .from('contracts')
        .update({
          status: 'TERMINATED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', data.contract_id)
        .eq('user_id', user.id);

      if (contractError) throw contractError;

      // 3. Mark termination as COMPLETED
      const { error: completeError } = await supabase
        .from('contract_terminations')
        .update({
          status: 'COMPLETED',
          refund_date: new Date().toISOString(),
        })
        .eq('id', data.termination_id)
        .eq('user_id', user.id);

      if (completeError) throw completeError;

      // 4. Create cash book entry for refund/collection
      if (data.refund_amount !== 0) {
        const isRefund = data.refund_amount > 0;
        const { error: cashError } = await supabase
          .from('cash_book')
          .insert([{
            user_id: user.id,
            transaction_date: new Date().toISOString(),
            transaction_type: isRefund ? 'EXPENSE' : 'INCOME',
            category: isRefund ? 'DEPOSIT_REFUND' : 'DEPOSIT_FORFEIT',
            amount: Math.abs(data.refund_amount),
            description: isRefund
              ? 'Hoàn cọc thanh lý hợp đồng'
              : 'Thu thêm từ thanh lý hợp đồng',
            reference_type: 'CONTRACT_TERMINATION',
            reference_id: data.termination_id,
            payment_method: data.payment_method || 'CASH',
            notes: data.notes,
          }]);

        if (cashError) throw cashError;
      }

      // 5. Update room/bed status to AVAILABLE
      const { data: contract } = await supabase
        .from('contracts')
        .select('room_id, bed_id')
        .eq('id', data.contract_id)
        .single();

      if (contract?.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'AVAILABLE' })
          .eq('id', contract.room_id);
      }

      if (contract?.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'AVAILABLE' })
          .eq('id', contract.bed_id);
      }

      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['pending-terminations'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });

      toast({
        title: 'Duyệt thanh lý thành công!',
        description: 'Hợp đồng đã được thanh lý và phòng/giường đã được giải phóng.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Duyệt thanh lý thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Reject Termination
// =============================================

export const useRejectTermination = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      rejection_reason?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('contract_terminations')
        .update({
          status: 'DRAFT',
          notes: data.rejection_reason
            ? `[Từ chối] ${data.rejection_reason}`
            : undefined,
        })
        .eq('id', data.termination_id)
        .eq('user_id', user.id);

      if (error) throw error;
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['pending-terminations'] });

      toast({
        title: 'Đã từ chối yêu cầu thanh lý',
        description: 'Yêu cầu đã được trả về trạng thái nháp.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Thao tác thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Upload Contract File
// =============================================

export const useUploadContractFile = () => {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ file, contractId }: { file: File; contractId?: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Generate file path: {user_id}/{contract_id || timestamp}_{filename}
      const timestamp = Date.now();
      const fileExt = file.name.split('.').pop();
      const fileName = `${contractId || timestamp}_${file.name}`;
      const filePath = `${user.id}/${fileName}`;

      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from('contract-files')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false,
        });

      if (error) throw error;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('contract-files')
        .getPublicUrl(data.path);

      return {
        path: data.path,
        url: publicUrl,
        fileName: file.name,
        fileSize: file.size,
        fileType: fileExt,
      };
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Upload thất bại',
        description: error.message,
      });
    },
  });
};
