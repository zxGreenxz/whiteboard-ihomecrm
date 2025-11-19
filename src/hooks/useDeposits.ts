import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

// =============================================
// Types
// =============================================

type Deposit = Database['public']['Tables']['deposits']['Row'];
type DepositInsert = Database['public']['Tables']['deposits']['Insert'];
type DepositUpdate = Database['public']['Tables']['deposits']['Update'];

export interface DepositWithRelations extends Deposit {
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
}

export interface CreateDepositData {
  tenant_id: string;
  room_id?: string;
  bed_id?: string;
  amount: number;
  deposit_date: string;
  hold_until?: string;
  notes?: string;
}

export interface UpdateDepositData {
  status?: string;
  amount?: number;
  hold_until?: string;
  notes?: string;
}

// =============================================
// Get All Deposits
// =============================================

export const useDeposits = (filters?: { status?: string }) => {
  return useQuery({
    queryKey: ['deposits', filters],
    queryFn: async (): Promise<DepositWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('deposits')
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey (
            id, full_name, phone, email
          ),
          room:rooms!deposits_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          ),
          bed:beds!deposits_bed_id_fkey (
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

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as DepositWithRelations[];
    },
  });
};

// =============================================
// Get Single Deposit
// =============================================

export const useDeposit = (depositId?: string) => {
  return useQuery({
    queryKey: ['deposit', depositId],
    queryFn: async (): Promise<DepositWithRelations | null> => {
      if (!depositId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('deposits')
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey (
            id, full_name, phone, email
          ),
          room:rooms!deposits_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          ),
          bed:beds!deposits_bed_id_fkey (
            id, name, code,
            room:rooms!beds_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          )
        `)
        .eq('id', depositId)
        .eq('user_id', user.id)
        .single();

      if (error) throw error;
      return data as DepositWithRelations;
    },
    enabled: !!depositId,
  });
};

// =============================================
// Create Deposit
// =============================================

export const useCreateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateDepositData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create deposit
      const { data: deposit, error: depositError } = await supabase
        .from('deposits')
        .insert({
          ...data,
          user_id: user.id,
          status: 'PENDING',
        })
        .select()
        .single();

      if (depositError) throw depositError;

      // Update room status to RESERVED if room specified
      if (data.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'RESERVED' })
          .eq('id', data.room_id);
      }

      // Update bed status to RESERVED if bed specified
      if (data.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'RESERVED' })
          .eq('id', data.bed_id);
      }

      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Tạo đặt cọc thành công!',
        description: 'Phòng đã được giữ chỗ cho khách hàng.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo đặt cọc thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Update Deposit
// =============================================

export const useUpdateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ depositId, data }: { depositId: string; data: UpdateDepositData }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: deposit, error } = await supabase
        .from('deposits')
        .update(data)
        .eq('id', depositId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['deposit'] });
      toast({
        title: 'Cập nhật thành công!',
        description: 'Thông tin đặt cọc đã được cập nhật.',
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
// Confirm Deposit
// =============================================

export const useConfirmDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (depositId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: deposit, error } = await supabase
        .from('deposits')
        .update({ status: 'CONFIRMED' })
        .eq('id', depositId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      toast({
        title: 'Xác nhận đặt cọc thành công!',
        description: 'Đặt cọc đã được xác nhận.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xác nhận thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Refund Deposit
// =============================================

export const useRefundDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (depositId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get deposit info to release room/bed
      const { data: deposit } = await supabase
        .from('deposits')
        .select('room_id, bed_id')
        .eq('id', depositId)
        .single();

      // Update deposit status
      const { error } = await supabase
        .from('deposits')
        .update({ status: 'REFUNDED' })
        .eq('id', depositId)
        .eq('user_id', user.id);

      if (error) throw error;

      // Release room/bed
      if (deposit?.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.room_id);
      }
      if (deposit?.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.bed_id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Hoàn cọc thành công!',
        description: 'Tiền cọc đã được hoàn trả cho khách.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Hoàn cọc thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Forfeit Deposit
// =============================================

export const useForfeitDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (depositId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get deposit info to release room/bed
      const { data: deposit } = await supabase
        .from('deposits')
        .select('room_id, bed_id')
        .eq('id', depositId)
        .single();

      // Update deposit status
      const { error } = await supabase
        .from('deposits')
        .update({ status: 'FORFEITED' })
        .eq('id', depositId)
        .eq('user_id', user.id);

      if (error) throw error;

      // Release room/bed
      if (deposit?.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.room_id);
      }
      if (deposit?.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.bed_id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Phạt cọc thành công!',
        description: 'Tiền cọc đã bị tịch thu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Phạt cọc thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Delete Deposit
// =============================================

export const useDeleteDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (depositId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get deposit info to release room/bed
      const { data: deposit } = await supabase
        .from('deposits')
        .select('room_id, bed_id')
        .eq('id', depositId)
        .single();

      // Delete deposit
      const { error } = await supabase
        .from('deposits')
        .delete()
        .eq('id', depositId)
        .eq('user_id', user.id);

      if (error) throw error;

      // Release room/bed
      if (deposit?.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.room_id);
      }
      if (deposit?.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'AVAILABLE' })
          .eq('id', deposit.bed_id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Xóa đặt cọc thành công!',
        description: 'Đặt cọc đã được xóa khỏi hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xóa đặt cọc thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Convert Deposit to Contract
// =============================================

export const useConvertDepositToContract = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      depositId,
      contractData
    }: {
      depositId: string;
      contractData: {
        start_date: string;
        end_date: string;
        monthly_rent: number;
        deposit_amount: number;
        payment_day: number;
        contract_type: string;
        notes?: string;
      };
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get deposit details
      const { data: deposit, error: depositError } = await supabase
        .from('deposits')
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey(id, full_name, phone, email),
          room:rooms!deposits_room_id_fkey(id, name, code, building_id),
          bed:beds!deposits_bed_id_fkey(id, name, code, room_id)
        `)
        .eq('id', depositId)
        .eq('user_id', user.id)
        .single();

      if (depositError) throw depositError;
      if (!deposit) throw new Error('Deposit not found');

      // Create contract
      const { data: contract, error: contractError } = await supabase
        .from('contracts')
        .insert({
          user_id: user.id,
          tenant_id: deposit.tenant_id,
          room_id: deposit.room_id,
          bed_id: deposit.bed_id,
          start_date: contractData.start_date,
          end_date: contractData.end_date,
          monthly_rent: contractData.monthly_rent,
          deposit_amount: contractData.deposit_amount,
          payment_day: contractData.payment_day,
          contract_type: contractData.contract_type,
          status: 'ACTIVE',
          notes: contractData.notes,
        })
        .select()
        .single();

      if (contractError) throw contractError;

      // Update deposit status to CONFIRMED and link to contract
      await supabase
        .from('deposits')
        .update({
          status: 'CONFIRMED',
          contract_id: contract.id
        })
        .eq('id', depositId);

      // Update room/bed status to OCCUPIED
      if (deposit.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'OCCUPIED' })
          .eq('id', deposit.room_id);
      }
      if (deposit.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'OCCUPIED' })
          .eq('id', deposit.bed_id);
      }

      return contract;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Chuyển đổi thành công!',
        description: 'Đặt cọc đã được chuyển thành hợp đồng.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Chuyển đổi thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Get Deposits Statistics
// =============================================

export interface DepositStats {
  total: number;
  total_amount: number;
  by_status: Array<{
    status: string;
    count: number;
    amount: number;
  }>;
}

export const useDepositStats = () => {
  return useQuery({
    queryKey: ['deposit_stats'],
    queryFn: async (): Promise<DepositStats> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('deposits')
        .select('status, amount')
        .eq('user_id', user.id);

      if (error) throw error;

      const total = data.length;
      const total_amount = data.reduce((sum, d) => sum + (d.amount || 0), 0);

      // Group by status
      const statusMap = new Map<string, { count: number; amount: number }>();
      data.forEach((deposit) => {
        const status = deposit.status || 'UNKNOWN';
        const existing = statusMap.get(status) || { count: 0, amount: 0 };
        statusMap.set(status, {
          count: existing.count + 1,
          amount: existing.amount + (deposit.amount || 0),
        });
      });

      const by_status = Array.from(statusMap.entries()).map(([status, stats]) => ({
        status,
        ...stats,
      }));

      return { total, total_amount, by_status };
    },
  });
};
