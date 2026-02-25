import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { BuildingServiceWithDetails } from "@/types/building";

// Fetch building services with service details for a building
export const useBuildingServices = (buildingId: string) => {
  return useQuery({
    queryKey: ["building-services", buildingId],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("building_services" as any)
        .select(`
          id,
          building_id,
          service_id,
          is_active,
          unit_price_override,
          created_at,
          updated_at,
          service:services(id, name, unit_price, unit)
        `)
        .eq("building_id", buildingId) as any);

      if (error) {
        console.error("useBuildingServices error:", error);
        return [];
      }

      return (data || []) as BuildingServiceWithDetails[];
    },
    enabled: !!buildingId,
  });
};

// Batch upsert building services: delete all existing, then insert new set
export const useUpsertBuildingServices = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      buildingId,
      services,
    }: {
      buildingId: string;
      services: {
        service_id: string;
        is_active: boolean;
        unit_price_override: number | null;
      }[];
    }) => {
      // Step 1: Delete all existing building_services for this building
      const { error: deleteError } = await (supabase
        .from("building_services" as any)
        .delete()
        .eq("building_id", buildingId) as any);

      if (deleteError) {
        console.error("Delete building services error:", deleteError);
        throw deleteError;
      }

      // Step 2: Insert the new set (skip if empty)
      if (services.length === 0) return;

      const rows = services.map((s) => ({
        building_id: buildingId,
        service_id: s.service_id,
        is_active: s.is_active,
        unit_price_override: s.unit_price_override,
      }));

      const { error: insertError } = await (supabase
        .from("building_services" as any)
        .insert(rows) as any);

      if (insertError) {
        if (insertError.code === "23505") {
          toast.error("Dịch vụ này đã được thêm cho toà nhà");
        } else if (insertError.code === "23503") {
          toast.error("Dữ liệu liên kết không tồn tại");
        } else {
          toast.error("Không thể cập nhật dịch vụ toà nhà");
        }
        throw insertError;
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["building-services", variables.buildingId],
      });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
    },
    onError: (error) => {
      console.error("Error upserting building services:", error);
    },
  });
};
