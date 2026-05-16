import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  Vehicle,
  VehicleWithRelations,
  VehicleFilters,
  VehicleFormData,
} from "@/types/vehicle";
import type { PaginatedData } from "@/hooks/usePagination";

// Re-export for backward compatibility
export type { VehicleWithRelations } from "@/types/vehicle";

// =============================================
// useVehicles - Query vehicles with filters, joins, and pagination
// Requirements: 8.2, 8.3, 8.5
// =============================================

export const useVehicles = (
  filters?: VehicleFilters,
  pagination?: { page: number; pageSize: number }
) => {
  return useQuery({
    queryKey: ["vehicles", filters, pagination],
    queryFn: async (): Promise<PaginatedData<VehicleWithRelations>> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      let query = (supabase
        .from("vehicles")
        .select(
          `
          *,
          customer:customers!vehicles_customer_id_fkey (
            id, full_name, phone
          ),
          building:buildings!vehicles_building_id_fkey (
            id, name
          ),
          room:rooms!vehicles_room_id_fkey (
            id, name
          )
        `,
          { count: "exact" }
        ) as any)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      // Search by license_plate, vehicle_name, owner_name, or related customer's full_name
      if (filters?.search) {
        const search = filters.search.trim();
        if (search) {
          // PostgREST .or() can't OR across the parent table and an embedded table directly,
          // so look up matching customer IDs first then include them in the OR clause.
          const { data: matchedCustomers } = await supabase
            .from("customers")
            .select("id")
            .ilike("full_name", `%${search}%`)
            .is("deleted_at", null);

          const orParts = [
            `license_plate.ilike.%${search}%`,
            `vehicle_name.ilike.%${search}%`,
            `owner_name.ilike.%${search}%`,
          ];
          const customerIds = (matchedCustomers || []).map((c: any) => c.id);
          if (customerIds.length > 0) {
            orParts.push(`customer_id.in.(${customerIds.join(",")})`);
          }

          query = query.or(orParts.join(","));
        }
      }

      // Filter by vehicle type
      if (filters?.vehicle_type) {
        query = query.eq("vehicle_type", filters.vehicle_type);
      }

      // Filter by building
      if (filters?.building_id) {
        query = query.eq("building_id", filters.building_id);
      }

      // Filter by customer
      if (filters?.customer_id) {
        query = query.eq("customer_id", filters.customer_id);
      }

      // Apply pagination
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error("useVehicles error:", error);
        return { data: [], count: 0 };
      }

      return {
        data: (data || []) as VehicleWithRelations[],
        count: count || 0,
      };
    },
  });
};

// =============================================
// useVehicle - Single vehicle query with relations
// =============================================

export const useVehicle = (id: string) => {
  return useQuery({
    queryKey: ["vehicles", id],
    queryFn: async (): Promise<VehicleWithRelations | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("vehicles")
        .select(
          `
          *,
          customer:customers!vehicles_customer_id_fkey (
            id, full_name, phone
          ),
          building:buildings!vehicles_building_id_fkey (
            id, name
          ),
          room:rooms!vehicles_room_id_fkey (
            id, name
          )
        `
        )
        .eq("id", id)
        .single();

      if (error) {
        console.error("useVehicle error:", error);
        throw error;
      }

      return data as unknown as VehicleWithRelations;
    },
    enabled: !!id,
  });
};

// =============================================
// useCreateVehicle - Insert mutation
// Requirements: 9.5
// =============================================

export const useCreateVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (formData: VehicleFormData) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("vehicles")
        .insert({
          ...formData,
          user_id: user.id,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as Vehicle;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: any) => {
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      }
      console.error("Error creating vehicle:", error);
    },
  });
};

// =============================================
// useUpdateVehicle - Update mutation
// Requirements: 9.8
// =============================================

export const useUpdateVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      data: formData,
    }: {
      id: string;
      data: Partial<VehicleFormData>;
    }) => {
      const { data, error } = await supabase
        .from("vehicles")
        .update(formData as any)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as Vehicle;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["vehicles", data.id] });
      }
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: any) => {
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      }
      console.error("Error updating vehicle:", error);
    },
  });
};

// =============================================
// useDeleteVehicle - Soft-delete mutation
// Requirements: 12.2
// =============================================

export const useDeleteVehicle = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("vehicles")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error: any) => {
      toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      console.error("Error deleting vehicle:", error);
    },
  });
};
