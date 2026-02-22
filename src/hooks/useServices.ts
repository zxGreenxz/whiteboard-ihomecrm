import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Service = Database["public"]["Tables"]["services"]["Row"];
type ServiceInsert = Database["public"]["Tables"]["services"]["Insert"];
type ServiceUpdate = Database["public"]["Tables"]["services"]["Update"];
type ServiceQuota = Database["public"]["Tables"]["service_quotas"]["Row"];
type ServiceQuotaTier = Database["public"]["Tables"]["service_quota_tiers"]["Row"];

export const FEE_TYPE_LABELS: Record<string, string> = {
  TIEN_PHI_DICH_VU: "Tiền phí dịch vụ",
  TIEN_DIEN: "Tiền điện",
  TIEN_NUOC: "Tiền nước",
  TIEN_PHI_KHAC: "Tiền phí khác",
  TIEN_VE_SINH: "Tiền vệ sinh",
};

export const PRICING_TYPE_LABELS: Record<string, string> = {
  DON_GIA_CO_DINH_THANG: "Đơn giá cố định theo tháng",
  DON_GIA_CO_DINH_DONG_HO: "Đơn giá cố định theo đồng hồ",
  DON_GIA_BIEN_DONG: "Đơn giá biến động",
  DON_GIA_THEO_NGUOI: "Đơn giá theo người",
  DON_GIA_THEO_PHONG: "Đơn giá theo phòng",
};

export const TAX_RATE_OPTIONS = [
  { value: 0, label: "Không thuế" },
  { value: 5, label: "5%" },
  { value: 8, label: "8%" },
  { value: 10, label: "10%" },
];

export const UNIT_OPTIONS = [
  "Phòng", "Người", "Kwh", "m³", "Lượt", "Tháng", "Chiếc",
];

export type ServiceWithBuildings = Service & {
  service_buildings: { building_id: string }[];
};

// Fetch services with building associations, optional filters
export const useServices = (filters?: {
  building_id?: string;
  fee_type?: string;
}) => {
  return useQuery({
    queryKey: ["services", filters],
    queryFn: async () => {
      let query = supabase
        .from("services")
        .select("*, service_buildings(building_id)")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (filters?.fee_type) {
        query = query.eq("fee_type", filters.fee_type as Database["public"]["Enums"]["fee_type"]);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách dịch vụ");
        throw error;
      }

      let result = (data || []) as ServiceWithBuildings[];

      // Client-side filter by building_id through junction table
      if (filters?.building_id) {
        result = result.filter((s) =>
          s.service_buildings.some((sb) => sb.building_id === filters.building_id)
        );
      }

      return result;
    },
  });
};

// Create service + service_buildings
export const useCreateService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      params: Omit<ServiceInsert, "user_id"> & { building_ids?: string[] }
    ) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      const { building_ids, ...serviceData } = params;

      const { data, error } = await supabase
        .from("services")
        .insert({ ...serviceData, user_id: user.id })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã dịch vụ đã tồn tại");
        } else {
          toast.error("Không thể tạo dịch vụ");
        }
        throw error;
      }

      // Insert service_buildings
      if (building_ids && building_ids.length > 0) {
        const { error: sbError } = await supabase
          .from("service_buildings")
          .insert(
            building_ids.map((bid) => ({
              service_id: data.id,
              building_id: bid,
            }))
          );
        if (sbError) {
          console.error("Error inserting service_buildings:", sbError);
        }
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
  });
};

// Update service + manage service_buildings
export const useUpdateService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
      building_ids,
    }: {
      id: string;
      updates: ServiceUpdate;
      building_ids?: string[];
    }) => {
      const { data, error } = await supabase
        .from("services")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã dịch vụ đã tồn tại");
        } else {
          toast.error("Không thể cập nhật dịch vụ");
        }
        throw error;
      }

      // Replace service_buildings
      if (building_ids !== undefined) {
        await supabase
          .from("service_buildings")
          .delete()
          .eq("service_id", id);

        if (building_ids.length > 0) {
          const { error: sbError } = await supabase
            .from("service_buildings")
            .insert(
              building_ids.map((bid) => ({
                service_id: id,
                building_id: bid,
              }))
            );
          if (sbError) {
            console.error("Error updating service_buildings:", sbError);
          }
        }
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
  });
};

// Soft delete service
export const useDeleteService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("services")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa dịch vụ");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Dữ liệu đã được XÓA thành công");
    },
  });
};

// Fetch service quotas with tiers
export type ServiceQuotaWithTiers = ServiceQuota & {
  service_quota_tiers: ServiceQuotaTier[];
};

export const useServiceQuotas = () => {
  return useQuery({
    queryKey: ["service_quotas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("service_quotas")
        .select("*, service_quota_tiers(*)")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (error) {
        toast.error("Không thể tải danh sách định mức");
        throw error;
      }

      return (data || []) as ServiceQuotaWithTiers[];
    },
  });
};

// Create quota + tiers
export const useCreateServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      name: string;
      description?: string | null;
      tiers: { tier_number: number; from_value: number; to_value: number | null; unit_price: number }[];
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("service_quotas")
        .insert({
          name: params.name,
          description: params.description || null,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo định mức");
        throw error;
      }

      if (params.tiers.length > 0) {
        const { error: tierError } = await supabase
          .from("service_quota_tiers")
          .insert(
            params.tiers.map((t) => ({
              quota_id: data.id,
              tier_number: t.tier_number,
              from_value: t.from_value,
              to_value: t.to_value,
              unit_price: t.unit_price,
            }))
          );
        if (tierError) {
          console.error("Error inserting tiers:", tierError);
        }
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức đã được tạo thành công");
    },
  });
};

// Update quota + tiers
export const useUpdateServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      id: string;
      name: string;
      description?: string | null;
      tiers: { tier_number: number; from_value: number; to_value: number | null; unit_price: number }[];
    }) => {
      const { error } = await supabase
        .from("service_quotas")
        .update({ name: params.name, description: params.description || null })
        .eq("id", params.id);

      if (error) {
        toast.error("Không thể cập nhật định mức");
        throw error;
      }

      // Replace tiers
      await supabase
        .from("service_quota_tiers")
        .delete()
        .eq("quota_id", params.id);

      if (params.tiers.length > 0) {
        const { error: tierError } = await supabase
          .from("service_quota_tiers")
          .insert(
            params.tiers.map((t) => ({
              quota_id: params.id,
              tier_number: t.tier_number,
              from_value: t.from_value,
              to_value: t.to_value,
              unit_price: t.unit_price,
            }))
          );
        if (tierError) {
          console.error("Error updating tiers:", tierError);
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức đã được cập nhật thành công");
    },
  });
};

// Soft delete quota
export const useDeleteServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("service_quotas")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa định mức");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức đã được xóa thành công");
    },
  });
};
