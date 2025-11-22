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

// =============================================
// Bulk Import Contracts from Excel
// =============================================

export interface BulkImportRow {
  building: string;
  room: string;
  bed?: string;
  rent_price: number;
  deposit: number;
  signed_date: string;
  start_date: string;
  billing_start_date: string;
  end_date: string;
  payment_cycle: string;
  notes?: string;
  tenant_name: string;
  tenant_phone: string;
  services: Array<{
    name: string;
    use: boolean;
    has_meter?: boolean;
    initial_reading?: number;
    quantity?: number;
    unit_price: number;
    billing_date: string;
  }>;
  rowIndex: number;
}

export interface BulkImportResult {
  success: number;
  failed: number;
  errors: Array<{
    row: number;
    message: string;
  }>;
}

export const useBulkImportContracts = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (rows: BulkImportRow[]): Promise<BulkImportResult> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const result: BulkImportResult = {
        success: 0,
        failed: 0,
        errors: [],
      };

      // Process each row sequentially to maintain order and error tracking
      for (const row of rows) {
        try {
          // 1. Find or create tenant
          let tenantId: string | null = null;

          // Try to find existing tenant by phone
          const { data: existingTenants } = await supabase
            .from('tenants')
            .select('id')
            .eq('phone', row.tenant_phone)
            .eq('user_id', user.id)
            .limit(1);

          if (existingTenants && existingTenants.length > 0) {
            tenantId = existingTenants[0].id;
          } else {
            // Create new tenant
            const { data: newTenant, error: tenantError } = await supabase
              .from('tenants')
              .insert({
                full_name: row.tenant_name,
                phone: row.tenant_phone,
                user_id: user.id,
              })
              .select('id')
              .single();

            if (tenantError) throw new Error(`Lỗi tạo khách hàng: ${tenantError.message}`);
            tenantId = newTenant.id;
          }

          if (!tenantId) throw new Error('Không thể tạo hoặc tìm khách hàng');

          // 2. Find building by name
          const { data: buildings } = await supabase
            .from('buildings')
            .select('id')
            .eq('user_id', user.id)
            .or(`name.eq.${row.building},code.eq.${row.building}`)
            .limit(1);

          if (!buildings || buildings.length === 0) {
            throw new Error(`Không tìm thấy tòa nhà: ${row.building}`);
          }

          const buildingId = buildings[0].id;

          // 3. Find room or bed
          let roomId: string | null = null;
          let bedId: string | null = null;

          if (row.bed) {
            // Find bed
            const { data: beds } = await supabase
              .from('beds')
              .select('id, room_id')
              .eq('name', row.bed)
              .eq('status', 'AVAILABLE');

            if (!beds || beds.length === 0) {
              throw new Error(`Không tìm thấy giường trống: ${row.bed}`);
            }

            // Find bed in the correct room
            const { data: rooms } = await supabase
              .from('rooms')
              .select('id')
              .eq('building_id', buildingId)
              .or(`name.eq.${row.room},code.eq.${row.room}`);

            const targetRoom = rooms?.find(r => beds.some(b => b.room_id === r.id));
            if (!targetRoom) {
              throw new Error(`Không tìm thấy phòng ${row.room} có giường ${row.bed}`);
            }

            const targetBed = beds.find(b => b.room_id === targetRoom.id);
            bedId = targetBed!.id;
            roomId = null;
          } else {
            // Find room
            const { data: rooms } = await supabase
              .from('rooms')
              .select('id')
              .eq('building_id', buildingId)
              .or(`name.eq.${row.room},code.eq.${row.room}`)
              .eq('status', 'AVAILABLE')
              .limit(1);

            if (!rooms || rooms.length === 0) {
              throw new Error(`Không tìm thấy phòng trống: ${row.room}`);
            }

            roomId = rooms[0].id;
            bedId = null;
          }

          // 4. Create contract
          const { data: contract, error: contractError } = await supabase
            .from('contracts')
            .insert({
              user_id: user.id,
              tenant_id: tenantId,
              room_id: roomId,
              bed_id: bedId,
              signed_date: row.signed_date,
              start_date: row.start_date,
              start_billing_date: row.billing_start_date,
              end_date: row.end_date,
              rent_price: row.rent_price,
              payment_cycle: row.payment_cycle,
              total_deposit: row.deposit,
              deposit_paid: 0,
              status: 'ACTIVE',
              notes: row.notes,
            })
            .select('id')
            .single();

          if (contractError) throw new Error(`Lỗi tạo hợp đồng: ${contractError.message}`);

          // 5. Update room/bed status to OCCUPIED
          if (roomId) {
            await supabase
              .from('rooms')
              .update({ status: 'OCCUPIED' })
              .eq('id', roomId);
          }
          if (bedId) {
            await supabase
              .from('beds')
              .update({ status: 'OCCUPIED' })
              .eq('id', bedId);
          }

          // 6. Create contract services
          if (row.services && row.services.length > 0) {
            for (const svc of row.services) {
              if (!svc.use) continue;

              // Find service by name
              const { data: services } = await supabase
                .from('services')
                .select('id, type')
                .eq('user_id', user.id)
                .ilike('name', `%${svc.name}%`)
                .limit(1);

              if (services && services.length > 0) {
                const serviceId = services[0].id;
                const serviceType = services[0].type;

                await supabase
                  .from('contract_services')
                  .insert({
                    contract_id: contract.id,
                    service_id: serviceId,
                    unit_price: svc.unit_price,
                    initial_reading: svc.has_meter && svc.initial_reading !== undefined
                      ? svc.initial_reading
                      : null,
                  });
              }
            }
          }

          result.success++;
        } catch (error) {
          result.failed++;
          result.errors.push({
            row: row.rowIndex,
            message: error instanceof Error ? error.message : 'Lỗi không xác định',
          });
        }
      }

      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      queryClient.invalidateQueries({ queryKey: ['tenants'] });

      toast({
        title: 'Import hoàn tất',
        description: `Thành công: ${result.success} | Thất bại: ${result.failed}`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Import thất bại',
        description: error.message,
      });
    },
  });
};
