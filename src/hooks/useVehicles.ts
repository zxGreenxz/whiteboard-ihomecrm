import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Vehicle = Database["public"]["Tables"]["vehicles"]["Row"];
type VehicleInsert = Database["public"]["Tables"]["vehicles"]["Insert"];
type VehicleUpdate = Database["public"]["Tables"]["vehicles"]["Update"];

export interface VehicleWithRelations extends Vehicle {
  tenant?: {
    id: string;
    full_name: string;
    phone: string | null;
  };
  contract?: {
    id: string;
    contract_number: string | null;
    room?: {
      id: string;
      name: string;
      building?: {
        id: string;
        name: string;
      };
    };
  };
}

// Fetch all vehicles
export const useVehicles = (filters?: {
  tenant_id?: string;
  contract_id?: string;
  vehicle_type?: string;
}) => {
  return useQuery({
    queryKey: ["vehicles", filters],
    queryFn: async (): Promise<VehicleWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("vehicles")
        .select(`
          *,
          tenant:tenants!vehicles_tenant_id_fkey (
            id, full_name, phone
          ),
          contract:contracts!vehicles_contract_id_fkey (
            id, contract_number,
            room:rooms!contracts_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          )
        `)
        .eq('user_id', user.id)
        .order("created_at", { ascending: false });

      if (filters?.tenant_id) {
        query = query.eq("tenant_id", filters.tenant_id);
      }
      if (filters?.contract_id) {
        query = query.eq("contract_id", filters.contract_id);
      }
      if (filters?.vehicle_type) {
        query = query.eq("vehicle_type", filters.vehicle_type as any);
      }

      const { data, error } = await query;

      if (error) {
        console.error('useVehicles error:', error);
        return [];
      }

      return (data || []) as VehicleWithRelations[];
    },
  });
};

// Fetch single vehicle
export const useVehicle = (id: string) => {
  return useQuery({
    queryKey: ["vehicles", id],
    queryFn: async (): Promise<VehicleWithRelations> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("vehicles")
        .select(`
          *,
          tenant:tenants!vehicles_tenant_id_fkey (
            id, full_name, phone
          ),
          contract:contracts!vehicles_contract_id_fkey (
            id, contract_number,
            room:rooms!contracts_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          )
        `)
        .eq("id", id)
        .eq('user_id', user.id)
        .single();

      if (error) {
        console.error('useVehicle error:', error);
        return null as any; // Return null for single queries
      }

      return data as VehicleWithRelations;
    },
    enabled: !!id,
  });
};

// Create vehicle
export const useCreateVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: VehicleInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: vehicle, error } = await supabase
        .from("vehicles")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return vehicle;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Phương tiện đã được thêm thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi thêm phương tiện: " + error.message);
    },
  });
};

// Update vehicle
export const useUpdateVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: VehicleUpdate & { id: string }) => {
      const { data: vehicle, error } = await supabase
        .from("vehicles")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return vehicle;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Phương tiện đã được cập nhật thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi cập nhật phương tiện: " + error.message);
    },
  });
};

// Delete vehicle (hard delete since deleted_at column may not exist)
export const useDeleteVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("vehicles")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Phương tiện đã được xóa thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi xóa phương tiện: " + error.message);
    },
  });
};
