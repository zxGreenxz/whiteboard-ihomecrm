import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

// =============================================
// Types
// =============================================

type Contract = Database['public']['Tables']['contracts']['Row'];
type ContractInsert = Database['public']['Tables']['contracts']['Insert'];
type ContractUpdate = Database['public']['Tables']['contracts']['Update'];

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
// Get All Contracts
// =============================================

export const useContracts = (filters?: {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  bed_id?: string;
}) => {
  return useQuery({
    queryKey: ['contracts', filters],
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
          )
        `)
        .eq('user_id', user.id)
        .is('deleted_at', null)
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
      if (error) throw error;
      return data as ContractWithRelations[];
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
          )
        `)
        .eq('id', contractId)
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .single();

      if (error) throw error;
      return data as ContractWithRelations;
    },
    enabled: !!contractId,
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

      // Extract services before creating contract
      const { services, ...contractData } = data;

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

      const { error } = await supabase
        .from('contracts')
        .update({ deleted_at: new Date().toISOString() })
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

      // Fetch contract to get total_deposit
      const { data: contract, error: contractError } = await supabase
        .from('contracts')
        .select('total_deposit, rent_price, tenant_id')
        .eq('id', data.contract_id)
        .single();

      if (contractError) throw contractError;
      if (!contract) throw new Error('Contract not found');

      // Create termination record
      // Note: The database trigger auto_calculate_termination_financials will
      // calculate outstanding_debt, prorated_rent, prorated_services
      const { data: termination, error } = await supabase
        .from('contract_terminations')
        .insert([{
          user_id: user.id,
          contract_id: data.contract_id,
          termination_type: data.termination_type,
          termination_date: new Date().toISOString().split('T')[0],
          total_deposit: contract.total_deposit || 0,
          actual_move_out_date: data.actual_move_out_date,
          early_termination_fee: data.early_termination_fee || 0,
          damage_fee: data.damage_fee || 0,
          damage_description: data.damage_description,
          cleaning_fee: data.cleaning_fee || 0,
          notes: data.notes,
          status: 'DRAFT',
        }])
        .select(`
          *,
          contract:contracts!contract_terminations_contract_id_fkey(
            contract_number,
            rent_price,
            tenant:tenants!contracts_tenant_id_fkey(full_name)
          )
        `)
        .single();

      if (error) throw error;
      return termination;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contract_terminations'] });

      toast({
        title: 'Tạo yêu cầu thanh lý thành công!',
        description: 'Vui lòng kiểm tra chi phí và duyệt.',
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

export interface TerminationCostEstimate {
  outstanding_debt: number;
  prorated_rent: number;
  prorated_services: number;
  total_fees: number;
  total_deposit: number;
  refund_amount: number;
}

export const useEstimateTerminationCosts = () => {
  return useMutation({
    mutationFn: async (data: {
      contract_id: string;
      move_out_date: string;
      damage_fee?: number;
      cleaning_fee?: number;
      early_termination_fee?: number;
    }): Promise<TerminationCostEstimate[]> => {
      // Call the database function estimate_termination_costs
      const { data: result, error } = await supabase.rpc('estimate_termination_costs', {
        p_contract_id: data.contract_id,
        p_move_out_date: data.move_out_date,
        p_damage_fee: data.damage_fee || 0,
        p_cleaning_fee: data.cleaning_fee || 0,
        p_early_termination_fee: data.early_termination_fee || 0,
      });

      if (error) throw error;

      return result as TerminationCostEstimate[];
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

// =============================================
// Get Contract Termination
// =============================================

export interface ContractTerminationWithRelations {
  id: string;
  user_id: string;
  contract_id: string;
  termination_date: string;
  actual_move_out_date: string;
  notice_date: string | null;
  termination_type: string;
  outstanding_debt: number;
  prorated_days: number;
  prorated_rent: number;
  prorated_services: number;
  early_termination_fee: number;
  notice_violation_fee: number;
  damage_fee: number;
  damage_description: string | null;
  damage_images: string[];
  cleaning_fee: number;
  other_fees: number;
  other_fees_description: string | null;
  total_deposit: number;
  total_deductions: number;
  refund_amount: number;
  refund_method: string | null;
  refund_date: string | null;
  refund_receipt_url: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  internal_notes: string | null;
  created_at: string;
  updated_at: string;
  contract?: {
    contract_number: string | null;
    tenant: { full_name: string } | null;
    room: { name: string; building: { name: string } | null } | null;
  };
}

export const useContractTermination = (contractId?: string) => {
  return useQuery({
    queryKey: ['contract_termination', contractId],
    queryFn: async (): Promise<ContractTerminationWithRelations | null> => {
      if (!contractId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('contract_terminations')
        .select(`
          *,
          contract:contracts!contract_terminations_contract_id_fkey(
            contract_number,
            tenant:tenants!contracts_tenant_id_fkey(full_name),
            room:rooms!contracts_room_id_fkey(
              name,
              building:buildings!rooms_building_id_fkey(name)
            )
          )
        `)
        .eq('contract_id', contractId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      return data as ContractTerminationWithRelations | null;
    },
    enabled: !!contractId,
  });
};

// =============================================
// Approve Contract Termination (Creates Invoice)
// =============================================

export const useApproveTermination = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      create_invoice?: boolean;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch termination details
      const { data: termination, error: termError } = await supabase
        .from('contract_terminations')
        .select(`
          *,
          contract:contracts!contract_terminations_contract_id_fkey(
            id,
            contract_number,
            tenant_id,
            tenant:tenants!contracts_tenant_id_fkey(full_name)
          )
        `)
        .eq('id', data.termination_id)
        .eq('user_id', user.id)
        .single();

      if (termError) throw termError;
      if (!termination) throw new Error('Termination not found');

      // Update termination status to APPROVED
      // The database trigger will update contract status to TERMINATED
      const { error: updateError } = await supabase
        .from('contract_terminations')
        .update({
          status: 'APPROVED',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', data.termination_id);

      if (updateError) throw updateError;

      // Create termination settlement invoice if needed
      if (data.create_invoice !== false && termination.refund_amount < 0) {
        // Tenant owes money - create invoice for the amount owed
        const amountOwed = Math.abs(termination.refund_amount);

        // Fetch invoice config for numbering
        const { data: invoiceSettings } = await supabase
          .from('settings')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', 'invoice_config')
          .maybeSingle();

        const invoiceConfig = invoiceSettings?.value as any;
        let invoiceNumber = null;

        if (invoiceConfig?.auto_generate_invoice_number !== false) {
          const { generateInvoiceNumber } = await import('@/lib/codeGenerator');
          const prefix = invoiceConfig?.invoice_number_prefix || 'INV';
          const format = invoiceConfig?.invoice_number_format || '{prefix}{year}{month}{seq:4}';
          try {
            invoiceNumber = await generateInvoiceNumber(prefix, format, user.id, 'YEARLY');
          } catch (e) {
            console.error('Error generating invoice number:', e);
          }
        }

        // Create termination settlement invoice
        const today = new Date();
        const dueDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const { data: invoice, error: invoiceError } = await supabase
          .from('invoices')
          .insert({
            user_id: user.id,
            contract_id: termination.contract_id,
            invoice_number: invoiceNumber,
            title: `Thanh toán thanh lý hợp đồng - ${termination.contract?.contract_number || ''}`,
            billing_period_start: termination.actual_move_out_date,
            billing_period_end: termination.actual_move_out_date,
            issue_date: today.toISOString().split('T')[0],
            due_date: dueDate.toISOString().split('T')[0],
            status: 'UNPAID',
            subtotal: amountOwed,
            total_amount: amountOwed,
            paid_amount: 0,
            remaining_amount: amountOwed,
          })
          .select('id')
          .single();

        if (invoiceError) {
          console.error('Error creating termination invoice:', invoiceError);
        } else if (invoice) {
          // Create invoice items
          const invoiceItems: Array<{
            invoice_id: string;
            type: string;
            description: string;
            quantity: number;
            unit_price: number;
            amount: number;
          }> = [];

          // Add outstanding debt
          if (termination.outstanding_debt > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'OTHER',
              description: 'Công nợ chưa thanh toán',
              quantity: 1,
              unit_price: termination.outstanding_debt,
              amount: termination.outstanding_debt,
            });
          }

          // Add prorated rent
          if (termination.prorated_rent > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'RENT',
              description: `Tiền phòng ${termination.prorated_days} ngày lẻ`,
              quantity: termination.prorated_days,
              unit_price: termination.prorated_rent / termination.prorated_days,
              amount: termination.prorated_rent,
            });
          }

          // Add prorated services
          if (termination.prorated_services > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'SERVICE',
              description: 'Dịch vụ ngày lẻ',
              quantity: 1,
              unit_price: termination.prorated_services,
              amount: termination.prorated_services,
            });
          }

          // Add fees
          if (termination.early_termination_fee > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'PENALTY',
              description: 'Phí chấm dứt hợp đồng sớm',
              quantity: 1,
              unit_price: termination.early_termination_fee,
              amount: termination.early_termination_fee,
            });
          }

          if (termination.damage_fee > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'PENALTY',
              description: termination.damage_description || 'Phí hư hỏng/sửa chữa',
              quantity: 1,
              unit_price: termination.damage_fee,
              amount: termination.damage_fee,
            });
          }

          if (termination.cleaning_fee > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'OTHER',
              description: 'Phí vệ sinh',
              quantity: 1,
              unit_price: termination.cleaning_fee,
              amount: termination.cleaning_fee,
            });
          }

          // Subtract deposit used
          if (termination.total_deposit > 0) {
            invoiceItems.push({
              invoice_id: invoice.id,
              type: 'DISCOUNT',
              description: 'Trừ tiền cọc',
              quantity: 1,
              unit_price: -termination.total_deposit,
              amount: -termination.total_deposit,
            });
          }

          if (invoiceItems.length > 0) {
            await supabase.from('invoice_items').insert(invoiceItems);
          }
        }
      }

      return termination;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contract_terminations'] });
      queryClient.invalidateQueries({ queryKey: ['contract_termination'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });

      toast({
        title: 'Duyệt thanh lý thành công!',
        description: 'Hợp đồng đã được chấm dứt.',
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
// Complete Termination (Mark Refund Processed)
// =============================================

export const useCompleteTermination = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      refund_method?: string;
      refund_date?: string;
      refund_receipt_url?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('contract_terminations')
        .update({
          status: 'COMPLETED',
          refund_method: data.refund_method,
          refund_date: data.refund_date || new Date().toISOString().split('T')[0],
          refund_receipt_url: data.refund_receipt_url,
        })
        .eq('id', data.termination_id)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contract_terminations'] });
      queryClient.invalidateQueries({ queryKey: ['contract_termination'] });

      toast({
        title: 'Hoàn tất thanh lý!',
        description: 'Đã xác nhận hoàn trả tiền cọc.',
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
