import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { confirmedRecordId, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type {
  Vehicle,
  VehicleWithRelations,
  VehicleFilters,
  VehicleFormData,
} from "@/types/vehicle";
import type { PaginatedData } from "@/hooks/usePagination";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { friendlyError } from "@/lib/friendlyError";

// Re-export for backward compatibility
export type { VehicleWithRelations } from "@/types/vehicle";

// =============================================
// useVehicles - Query vehicles with filters, joins, and pagination
// Requirements: 8.2, 8.3, 8.5
// =============================================

export const useVehicles = (
  filters?: VehicleFilters,
  pagination?: { page: number; pageSize: number },
  // options.enabled: dialog mounted-sẵn gate fetch khi đóng (default true).
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["vehicles", filters, pagination],
    queryFn: async (): Promise<PaginatedData<VehicleWithRelations>> => {
      const user = await getSessionUser();
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
          const { data: matchedCustomers, error: customerReadError } = await supabase
            .from("customers")
            .select("id")
            .ilike("full_name", `%${search}%`)
            .is("deleted_at", null);

          if(customerReadError)throw customerReadError;
          if(!Array.isArray(matchedCustomers))throw new Error('Chưa tải được khách hàng để tìm phương tiện.');
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

      // Filter by room — hỗ trợ nhiều phòng cùng tên (gộp mọi toà)
      if (filters?.room_ids?.length) {
        query = query.in("room_id", filters.room_ids);
      } else if (filters?.room_id) {
        query = query.eq("room_id", filters.room_id);
      }

      // Filter by customer
      if (filters?.customer_id) {
        query = query.eq("customer_id", filters.customer_id);
      }

      // Filter by contract
      if (filters?.contract_id) {
        query = query.eq("contract_id", filters.contract_id);
      }

      // Filter by vehicle_name (dòng xe)
      if (filters?.vehicle_name) {
        query = query.eq("vehicle_name", filters.vehicle_name);
      }

      // Filter by color
      if (filters?.color) {
        query = query.eq("color", filters.color);
      }

      // Apply pagination
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error("useVehicles error:", error);
        throw error;
      }

      if(!Array.isArray(data))throw new Error('Chưa tải được danh sách phương tiện.');
      return {
        data: data as VehicleWithRelations[],
        count: count || 0,
      };
    },
  });
};

// =============================================
// useDistinctVehicleValues - distinct vehicle_name & color for filter dropdowns
// =============================================

export const useDistinctVehicleValues = (vehicleType?: VehicleFilters["vehicle_type"]) => {
  return useQuery({
    queryKey: ["vehicles", "distinct", vehicleType ?? "ALL"],
    queryFn: async (): Promise<{ vehicleNames: string[]; colors: string[] }> => {
      let q = (supabase
        .from("vehicles")
        .select("vehicle_name, color") as any).is("deleted_at", null);
      if (vehicleType) q = q.eq("vehicle_type", vehicleType);

      const { data, error } = await q;
      if (error) {
        console.error("useDistinctVehicleValues error:", error);
        throw error;
      }

      if(!Array.isArray(data))throw new Error('Chưa tải được bộ lọc phương tiện.');
      const names = new Set<string>();
      const colors = new Set<string>();
      for (const row of (data || []) as Array<{ vehicle_name: string | null; color: string | null }>) {
        if (row.vehicle_name && row.vehicle_name.trim()) names.add(row.vehicle_name.trim());
        if (row.color && row.color.trim()) colors.add(row.color.trim());
      }
      return {
        vehicleNames: Array.from(names).sort((a, b) => a.localeCompare(b, "vi")),
        colors: Array.from(colors).sort((a, b) => a.localeCompare(b, "vi")),
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
      const user = await getSessionUser();
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

      if(!data?.id || data.id!==id)throw new Error('Chưa xác nhận được thông tin phương tiện.');
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
  const guard=persistentFinancialWorkflow('vehicle-create');
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (formData: VehicleFormData) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      return guard.run('create','thêm phương tiện',async(progress)=>{
      const { data, error } = await supabase
        .from("vehicles")
        .insert(withOrg({
          ...formData,
          user_id: user.id,
        } as any, selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      const savedId=confirmedRecordId(data,'thêm phương tiện');
      progress.completed.push({id:savedId,label:'Phương tiện đã nhận mã'});
      return data as unknown as Vehicle;
      },undefined,selectedOrganizationId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Đã thêm phương tiện");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({queryKey:['vehicles']});
      toast.error(recordWriteMessage(error,'thêm phương tiện'));
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
  const guard=persistentFinancialWorkflow('vehicle-update', {scope:'actor'});

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async ({
      id,
      data: formData,
    }: {
      id: string;
      data: Partial<VehicleFormData>;
    }) => {
      return guard.run(id,'cập nhật phương tiện',async(progress)=>{
      const { data, error } = await supabase
        .from("vehicles")
        .update(formData as any)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      const savedId=confirmedRecordId(data,'cập nhật phương tiện',id);
      progress.completed.push({id:savedId,label:'Phương tiện đã nhận mã'});
      return data as unknown as Vehicle;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["vehicles", data.id] });
      }
      toast.success("Đã cập nhật phương tiện");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({queryKey:['vehicles']});
      toast.error(recordWriteMessage(error,'cập nhật phương tiện'));
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
  const guard=persistentFinancialWorkflow('vehicle-delete', {scope:'actor'});

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (id: string) => {
      return guard.run(id,'xoá phương tiện',async(progress)=>{
      const { data, error } = await supabase
        .from("vehicles")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", id).select('id').single();

      if (error) throw error;
      confirmedRecordId(data,'xoá phương tiện',id);
      progress.completed.push({id,label:'Phương tiện đã xoá'});
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      toast.success("Đã xóa phương tiện");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({queryKey:['vehicles']});
      toast.error(recordWriteMessage(error,'xoá phương tiện'));
      console.error("Error deleting vehicle:", error);
    },
  });
};
