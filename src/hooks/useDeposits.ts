import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
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
  };
  bed?: {
    id: string;
    name: string;
    code: string | null;
  };
}

export const useDeposits = (filters?: {
  status?: string;
  tenant_id?: string;
}) => {
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
            id, full_name, phone
          ),
          room:rooms!deposits_room_id_fkey (
            id, name, code
          ),
          bed:beds!deposits_bed_id_fkey (
            id, name, code
          )
        `)
        .eq('user_id', user.id)
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
      const { data: { user } } = await supabase.auth.getUser();
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
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Đặt cọc thành công!',
        description: 'Thông tin đặt cọc đã được lưu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Đặt cọc thất bại',
        description: error.message,
      });
    },
  });
};
