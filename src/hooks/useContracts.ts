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

      // Extract services and start_billing_date before creating contract
      // Note: start_billing_date is excluded until migration 024 is run on the database
      const { services, start_billing_date, ...contractData } = data;

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
          status: 'DRAFT',
        }])
        .select()
        .single();

      if (error) throw error;
      return termination;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });

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

export const useEstimateTerminationCosts = () => {
  return useMutation({
    mutationFn: async (data: {
      contract_id: string;
      move_out_date: string;
      damage_fee?: number;
      cleaning_fee?: number;
      early_termination_fee?: number;
    }) => {
      // Return a mock estimation for now
      return {
        total_deductions: (data.damage_fee || 0) + (data.cleaning_fee || 0) + (data.early_termination_fee || 0),
        refund_amount: 0,
      };
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
