import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Asset = Database["public"]["Tables"]["assets"]["Row"];
type AssetInsert = Database["public"]["Tables"]["assets"]["Insert"];
type AssetUpdate = Database["public"]["Tables"]["assets"]["Update"];
type AssetHandover = Database["public"]["Tables"]["asset_handovers"]["Row"];
type AssetHandoverInsert = Database["public"]["Tables"]["asset_handovers"]["Insert"];
type AssetMovement = Database["public"]["Tables"]["asset_movements"]["Row"];
type AssetMovementInsert = Database["public"]["Tables"]["asset_movements"]["Insert"];
type AssetMaintenance = Database["public"]["Tables"]["asset_maintenance"]["Row"];
type AssetMaintenanceInsert = Database["public"]["Tables"]["asset_maintenance"]["Insert"];
type AssetMaintenanceUpdate = Database["public"]["Tables"]["asset_maintenance"]["Update"];

export interface AssetWithRelations extends Asset {
  category?: {
    id: string;
    name: string;
  };
  supplier?: {
    id: string;
    name: string;
  };
  building?: {
    id: string;
    name: string;
  };
  room?: {
    id: string;
    name: string;
  };
}

export interface AssetHandoverWithRelations extends AssetHandover {
  contract?: {
    id: string;
    contract_number: string | null;
    tenant?: {
      id: string;
      full_name: string;
    };
  };
}

export interface AssetMovementWithRelations extends AssetMovement {
  asset?: {
    id: string;
    name: string;
    code: string | null;
  };
  from_room?: {
    id: string;
    name: string;
    building?: {
      id: string;
      name: string;
    };
  };
  to_room?: {
    id: string;
    name: string;
    building?: {
      id: string;
      name: string;
    };
  };
}

export interface AssetMaintenanceWithRelations extends AssetMaintenance {
  asset?: {
    id: string;
    name: string;
    code: string | null;
  };
  assigned_profile?: {
    id: string;
    full_name: string | null;
  };
}

// Fetch all assets
export const useAssets = (filters?: {
  category_id?: string;
  building_id?: string;
  condition?: string;
}) => {
  return useQuery({
    queryKey: ["assets", filters],
    queryFn: async (): Promise<AssetWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("assets")
        .select(`
          *,
          category:asset_categories!assets_category_id_fkey (
            id, name
          ),
          supplier:suppliers!assets_supplier_id_fkey (
            id, name
          ),
          building:buildings!assets_building_id_fkey (
            id, name
          ),
          room:rooms!assets_room_id_fkey (
            id, name
          )
        `)
        .eq('user_id', user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (filters?.category_id) {
        query = query.eq("category_id", filters.category_id);
      }
      if (filters?.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters?.condition) {
        query = query.eq("condition", filters.condition as any);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách tài sản");
        throw error;
      }

      return (data as AssetWithRelations[]) || [];
    },
  });
};

// Fetch single asset
export const useAsset = (id: string) => {
  return useQuery({
    queryKey: ["assets", id],
    queryFn: async (): Promise<AssetWithRelations> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("assets")
        .select(`
          *,
          category:asset_categories!assets_category_id_fkey (
            id, name
          ),
          supplier:suppliers!assets_supplier_id_fkey (
            id, name
          ),
          building:buildings!assets_building_id_fkey (
            id, name
          ),
          room:rooms!assets_room_id_fkey (
            id, name
          )
        `)
        .eq("id", id)
        .eq('user_id', user.id)
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin tài sản");
        throw error;
      }

      return data as AssetWithRelations;
    },
    enabled: !!id,
  });
};

// Create asset
export const useCreateAsset = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: AssetInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: asset, error } = await supabase
        .from("assets")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return asset;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Tài sản đã được tạo thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi tạo tài sản: " + error.message);
    },
  });
};

// Update asset
export const useUpdateAsset = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: AssetUpdate & { id: string }) => {
      const { data: asset, error } = await supabase
        .from("assets")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return asset;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Tài sản đã được cập nhật thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi cập nhật tài sản: " + error.message);
    },
  });
};

// Delete asset (soft delete)
export const useDeleteAsset = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("assets")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Tài sản đã được xóa thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi xóa tài sản: " + error.message);
    },
  });
};

// Fetch asset handovers
export const useAssetHandovers = (contract_id?: string) => {
  return useQuery({
    queryKey: ["asset-handovers", contract_id],
    queryFn: async (): Promise<AssetHandoverWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("asset_handovers")
        .select(`
          *,
          contract:contracts!asset_handovers_contract_id_fkey (
            id, contract_number,
            tenant:tenants!contracts_tenant_id_fkey (
              id, full_name
            )
          )
        `)
        .eq('user_id', user.id)
        .order("handover_date", { ascending: false });

      if (contract_id) {
        query = query.eq("contract_id", contract_id);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách biên bản");
        throw error;
      }

      return (data as AssetHandoverWithRelations[]) || [];
    },
  });
};

// Create asset handover
export const useCreateAssetHandover = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: AssetHandoverInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: handover, error } = await supabase
        .from("asset_handovers")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return handover;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-handovers"] });
      toast.success("Biên bản bàn giao đã được tạo thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi tạo biên bản: " + error.message);
    },
  });
};

// Fetch asset movements
export const useAssetMovements = (asset_id?: string) => {
  return useQuery({
    queryKey: ["asset-movements", asset_id],
    queryFn: async (): Promise<AssetMovementWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("asset_movements")
        .select(`
          *,
          asset:assets!asset_movements_asset_id_fkey (
            id, name, code
          ),
          from_room:rooms!asset_movements_from_room_id_fkey (
            id, name,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          ),
          to_room:rooms!asset_movements_to_room_id_fkey (
            id, name,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          )
        `)
        .eq('user_id', user.id)
        .order("movement_date", { ascending: false });

      if (asset_id) {
        query = query.eq("asset_id", asset_id);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải lịch sử di chuyển");
        throw error;
      }

      return (data as AssetMovementWithRelations[]) || [];
    },
  });
};

// Create asset movement
export const useCreateAssetMovement = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: AssetMovementInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: movement, error } = await supabase
        .from("asset_movements")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return movement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-movements"] });
      toast.success("Di chuyển tài sản đã được ghi nhận thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi ghi nhận di chuyển: " + error.message);
    },
  });
};

// Fetch asset maintenance records
export const useAssetMaintenance = (filters?: {
  asset_id?: string;
  status?: string;
}) => {
  return useQuery({
    queryKey: ["asset-maintenance", filters],
    queryFn: async (): Promise<AssetMaintenanceWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("asset_maintenance")
        .select(`
          *,
          asset:assets!asset_maintenance_asset_id_fkey (
            id, name, code
          ),
          assigned_profile:profiles!asset_maintenance_assigned_to_fkey (
            id, full_name
          )
        `)
        .eq('user_id', user.id)
        .order("maintenance_date", { ascending: false });

      if (filters?.asset_id) {
        query = query.eq("asset_id", filters.asset_id);
      }
      if (filters?.status) {
        query = query.eq("status", filters.status);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải lịch sử bảo trì");
        throw error;
      }

      return (data as AssetMaintenanceWithRelations[]) || [];
    },
  });
};

// Create asset maintenance
export const useCreateAssetMaintenance = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: AssetMaintenanceInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: maintenance, error } = await supabase
        .from("asset_maintenance")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return maintenance;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      toast.success("Phiếu bảo trì đã được tạo thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi tạo phiếu bảo trì: " + error.message);
    },
  });
};

// Update asset maintenance
export const useUpdateAssetMaintenance = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: AssetMaintenanceUpdate & { id: string }) => {
      const { data: maintenance, error } = await supabase
        .from("asset_maintenance")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return maintenance;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      toast.success("Phiếu bảo trì đã được cập nhật thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi cập nhật phiếu bảo trì: " + error.message);
    },
  });
};
