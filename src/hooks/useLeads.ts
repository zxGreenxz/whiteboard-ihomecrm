import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { Database } from '@/integrations/supabase/types';

// =============================================
// Types
// =============================================

type Lead = Database['public']['Tables']['leads']['Row'];
type LeadInsert = Database['public']['Tables']['leads']['Insert'];
type LeadUpdate = Database['public']['Tables']['leads']['Update'];

export interface LeadWithRelations extends Lead {
  building?: {
    id: string;
    name: string;
    code: string | null;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
  };
  assigned_staff?: {
    id: string;
    full_name: string;
  };
}

export interface CreateLeadData {
  customer_name: string;
  phone: string;
  email?: string;
  source?: string;
  building_id?: string;
  room_id?: string;
  appointment_date?: string;
  assigned_staff_id?: string;
  notes?: string;
}

export interface UpdateLeadData {
  status?: string;
  appointment_date?: string;
  assigned_staff_id?: string;
  notes?: string;
}

// =============================================
// Get All Leads
// =============================================

export const useLeads = (filters?: { status?: string; building_id?: string }) => {
  return useQuery({
    queryKey: ['leads', filters],
    queryFn: async (): Promise<LeadWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('leads')
        .select(`
          *,
          building:buildings!leads_building_id_fkey (
            id, name, code
          ),
          room:rooms!leads_room_id_fkey (
            id, name, code
          ),
          assigned_staff:profiles!leads_assigned_staff_id_fkey (
            id, full_name
          )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.building_id) {
        query = query.eq('building_id', filters.building_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as LeadWithRelations[];
    },
  });
};

// =============================================
// Get Single Lead
// =============================================

export const useLead = (leadId?: string) => {
  return useQuery({
    queryKey: ['lead', leadId],
    queryFn: async (): Promise<LeadWithRelations | null> => {
      if (!leadId) return null;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('leads')
        .select(`
          *,
          building:buildings!leads_building_id_fkey (
            id, name, code
          ),
          room:rooms!leads_room_id_fkey (
            id, name, code
          ),
          assigned_staff:profiles!leads_assigned_staff_id_fkey (
            id, full_name
          )
        `)
        .eq('id', leadId)
        .eq('user_id', user.id)
        .single();

      if (error) throw error;
      return data as LeadWithRelations;
    },
    enabled: !!leadId,
  });
};

// =============================================
// Create Lead
// =============================================

export const useCreateLead = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateLeadData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: lead, error } = await supabase
        .from('leads')
        .insert({
          ...data,
          user_id: user.id,
          status: 'B1_LEAD', // Default status
        })
        .select()
        .single();

      if (error) throw error;
      return lead;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast({
        title: 'Tạo khách hẹn thành công!',
        description: 'Khách hàng tiềm năng đã được thêm vào hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Tạo khách hẹn thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Update Lead
// =============================================

export const useUpdateLead = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ leadId, data }: { leadId: string; data: UpdateLeadData }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: lead, error } = await supabase
        .from('leads')
        .update(data)
        .eq('id', leadId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return lead;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['lead'] });
      toast({
        title: 'Cập nhật thành công!',
        description: 'Thông tin khách hẹn đã được cập nhật.',
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
// Update Lead Status (for Kanban drag & drop)
// =============================================

export const useUpdateLeadStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ leadId, status }: { leadId: string; status: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('leads')
        .update({ status })
        .eq('id', leadId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
};

// =============================================
// Delete Lead
// =============================================

export const useDeleteLead = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (leadId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('leads')
        .delete()
        .eq('id', leadId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast({
        title: 'Xóa khách hẹn thành công!',
        description: 'Khách hàng đã được xóa khỏi hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Xóa khách hẹn thất bại',
        description: error.message,
      });
    },
  });
};

// =============================================
// Convert Lead to Deposit
// =============================================

export const useConvertLeadToDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      leadId,
      depositData,
    }: {
      leadId: string;
      depositData: {
        tenant_id: string;
        room_id?: string;
        bed_id?: string;
        amount: number;
        deposit_date: string;
        hold_until?: string;
        notes?: string;
      };
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Create deposit
      const { data: deposit, error: depositError } = await supabase
        .from('deposits')
        .insert({
          ...depositData,
          user_id: user.id,
          status: 'PENDING',
        })
        .select()
        .single();

      if (depositError) throw depositError;

      // Update lead status and link to deposit
      const { error: leadError } = await supabase
        .from('leads')
        .update({
          status: 'CONVERTED',
          deposit_id: deposit.id,
        })
        .eq('id', leadId)
        .eq('user_id', user.id);

      if (leadError) throw leadError;

      // Update room status to RESERVED if room specified
      if (depositData.room_id) {
        await supabase
          .from('rooms')
          .update({ status: 'RESERVED' })
          .eq('id', depositData.room_id);
      }

      // Update bed status to RESERVED if bed specified
      if (depositData.bed_id) {
        await supabase
          .from('beds')
          .update({ status: 'RESERVED' })
          .eq('id', depositData.bed_id);
      }

      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      queryClient.invalidateQueries({ queryKey: ['beds'] });
      toast({
        title: 'Chuyển đổi thành công!',
        description: 'Khách hẹn đã được chuyển thành đặt cọc.',
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
// Get Leads Statistics
// =============================================

export interface LeadStats {
  total: number;
  by_status: Array<{
    status: string;
    count: number;
  }>;
}

export const useLeadStats = () => {
  return useQuery({
    queryKey: ['lead_stats'],
    queryFn: async (): Promise<LeadStats> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('leads')
        .select('status')
        .eq('user_id', user.id);

      if (error) throw error;

      const total = data.length;

      // Group by status
      const statusMap = new Map<string, number>();
      data.forEach((lead) => {
        const status = lead.status || 'UNKNOWN';
        statusMap.set(status, (statusMap.get(status) || 0) + 1);
      });

      const by_status = Array.from(statusMap.entries()).map(([status, count]) => ({
        status,
        count,
      }));

      return { total, by_status };
    },
  });
};
