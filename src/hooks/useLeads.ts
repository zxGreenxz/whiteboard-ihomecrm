import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Lead = Database["public"]["Tables"]["leads"]["Row"];
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

export interface LeadWithRelations extends Lead {
  room?: {
    id: string;
    name: string;
    code: string | null;
    building?: {
      id: string;
      name: string;
    };
  };
  bed?: {
    id: string;
    name: string;
    code: string | null;
  };
}

// Fetch all leads
export const useLeads = (filters?: {
  status?: string;
  source?: string;
}) => {
  return useQuery({
    queryKey: ["leads", filters],
    queryFn: async (): Promise<LeadWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("leads")
        .select(`
          *,
          room:rooms!leads_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          ),
          bed:beds!leads_bed_id_fkey (
            id, name, code
          )
        `)
        .eq('user_id', user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = query.eq("status", filters.status as any);
      }
      if (filters?.source) {
        query = query.eq("source", filters.source as any);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách khách hẹn");
        throw error;
      }

      return (data as LeadWithRelations[]) || [];
    },
  });
};

// Fetch single lead by ID
export const useLead = (id: string) => {
  return useQuery({
    queryKey: ["leads", id],
    queryFn: async (): Promise<LeadWithRelations> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("leads")
        .select(`
          *,
          room:rooms!leads_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          ),
          bed:beds!leads_bed_id_fkey (
            id, name, code
          )
        `)
        .eq("id", id)
        .eq('user_id', user.id)
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin khách hẹn");
        throw error;
      }

      return data as LeadWithRelations;
    },
    enabled: !!id,
  });
};

// Create lead
export const useCreateLead = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: LeadInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: lead, error } = await supabase
        .from("leads")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return lead;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Tạo khách hẹn thành công");
    },
    onError: (error: Error) => {
      toast.error("Tạo khách hẹn thất bại: " + error.message);
    },
  });
};

// Update lead
export const useUpdateLead = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: LeadUpdate & { id: string }) => {
      const { data: lead, error } = await supabase
        .from("leads")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return lead;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Cập nhật khách hẹn thành công");
    },
    onError: (error: Error) => {
      toast.error("Cập nhật khách hẹn thất bại: " + error.message);
    },
  });
};

// Delete lead (soft delete)
export const useDeleteLead = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("leads")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Xóa khách hẹn thành công");
    },
    onError: (error: Error) => {
      toast.error("Xóa khách hẹn thất bại: " + error.message);
    },
  });
};

// Convert lead to deposit
export const useConvertLeadToDeposit = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (leadId: string) => {
      // Get lead data
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .single();

      if (leadError) throw leadError;

      // Mark lead as converted
      const { error: updateError } = await supabase
        .from("leads")
        .update({ status: "CONVERTED" })
        .eq("id", leadId);

      if (updateError) throw updateError;

      return { lead };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Chuyển đổi sang đặt cọc thành công");
    },
    onError: (error: Error) => {
      toast.error("Chuyển đổi thất bại: " + error.message);
    },
  });
};
