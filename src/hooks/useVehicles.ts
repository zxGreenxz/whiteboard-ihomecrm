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
        .is("deleted_at", null)
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
        toast.error("Không thể tải danh sách phương tiện");
        throw error;
      }

      return (data as VehicleWithRelations[]) || [];
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
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin phương tiện");
        throw error;
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
      toast.success("Thêm phương tiện thành công");
    },
    onError: (error: Error) => {
      toast.error("Thêm phương tiện thất bại: " + error.message);
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
      toast.success("Cập nhật phương tiện thành công");
    },
    onError: (error: Error) => {
      toast.error("Cập nhật phương tiện thất bại: " + error.message);
    },
  });
};

// Delete vehicle (soft delete)
export const useDeleteVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("vehicles")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Xóa phương tiện thành công");
    },
    onError: (error: Error) => {
      toast.error("Xóa phương tiện thất bại: " + error.message);
    },
  });
};
