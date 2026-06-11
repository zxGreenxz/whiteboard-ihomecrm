import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

type Deposit = Database['public']['Tables']['deposits']['Row'];
type DepositInsert = Database['public']['Tables']['deposits']['Insert'];

export interface DepositWithRelations extends Deposit {
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building?: { id: string; name: string } | null;
  };
}

export interface OrphanDepositVoucher {
  id: string;
  code: string | null;
  name: string;
  total_amount: number;
  voucher_date: string;
  approval_status: 'UNAPPROVED' | 'APPROVED' | 'CANCELLED';
}

/**
 * Phiếu thu CỌC mồ côi (chưa gắn HĐ) của một phòng — cùng predicate với
 * trigger trg_contract_link_orphan_deposits (migration 20260529000003):
 * cùng room, contract_id NULL, type INCOME, có item is_deposit,
 * voucher_date <= start_date + 7 ngày. Khi HĐ được INSERT các phiếu này
 * tự động gắn vào HĐ và recompute deposit_paid = Σ phiếu APPROVED.
 * ContractFormDialog dùng để: (1) báo user số cọc giữ chỗ đã thu,
 * (2) auto-voucher chỉ tạo cho PHẦN CHÊNH — tránh double-count deposit_paid.
 */
export const useOrphanDepositVouchers = (roomId?: string, startDate?: string) => {
  return useQuery({
    queryKey: ['orphan-deposit-vouchers', roomId, startDate],
    enabled: !!roomId,
    queryFn: async (): Promise<OrphanDepositVoucher[]> => {
      if (!roomId) return [];
      let query = (supabase as any)
        .from('income_expenses')
        .select(
          `id, code, name, total_amount, voucher_date, approval_status,
           income_expense_items!inner ( id, income_expense_types!inner ( is_deposit ) )`,
        )
        .is('contract_id', null)
        .is('deleted_at', null)
        .eq('type', 'INCOME')
        .eq('room_id', roomId)
        .in('approval_status', ['APPROVED', 'UNAPPROVED'])
        .eq('income_expense_items.income_expense_types.is_deposit', true);

      if (startDate) {
        const d = new Date(startDate);
        if (!Number.isNaN(d.getTime())) {
          d.setDate(d.getDate() + 7);
          query = query.lte('voucher_date', d.toISOString().split('T')[0]);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      return ((data ?? []) as any[]).map((v) => ({
        id: v.id,
        code: v.code ?? null,
        name: v.name,
        total_amount: Number(v.total_amount) || 0,
        voucher_date: v.voucher_date,
        approval_status: v.approval_status,
      }));
    },
  });
};

export const useDeposits = (filters?: {
  status?: string;
  tenant_id?: string;
}) => {
  return useQuery({
    queryKey: ['deposits', filters],
    queryFn: async (): Promise<DepositWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('deposits')
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey (
            id, full_name, phone
          ),
          room:rooms!deposits_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey ( id, name )
          )
        `)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }
      if (filters?.tenant_id) {
        query = query.eq('tenant_id', filters.tenant_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as DepositWithRelations[];
    },
  });
};

export const useCreateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: DepositInsert) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data: deposit, error } = await supabase
        .from('deposits')
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được tạo thành công',
        description: 'Thông tin đặt cọc đã được lưu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo đặt cọc',
        description: error.message,
      });
    },
  });
};

// Update deposit
export const useUpdateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<Deposit> & { id: string }) => {
      const { data: deposit, error } = await supabase
        .from('deposits')
        .update(data)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được cập nhật thành công',
        description: 'Thông tin đặt cọc đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi cập nhật đặt cọc',
        description: error.message,
      });
    },
  });
};

// Delete deposit
export const useDeleteDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('deposits')
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được xóa thành công',
        description: 'Phiếu đặt cọc đã được xóa.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xóa đặt cọc',
        description: error.message,
      });
    },
  });
};
