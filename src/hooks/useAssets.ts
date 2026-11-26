import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage,repeatableWrite} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { friendlyError } from "@/lib/friendlyError";

function reportAssetFailure(error: unknown, title: string, operation: string) {
  if(error instanceof FinancialWorkflowError){toast.error(title,{description:recordWriteMessage(error,operation)});return;}
  const feedback = friendlyError(error, title, { operation });
  toast.error(feedback.title, { description: feedback.description });
}

// Đợt 9 (plan sửa khoá vĩnh viễn sau rớt mạng, luật 5): TẠO tài sản / biên bản bàn giao / di chuyển / bảo trì không giữ
// dấu «chờ đối chiếu» nữa (trước đây mỗi loại một khoá chung `create`: một lần rớt mạng chặn mọi lần tạo sau). Production
// 26/11/2026: bốn bảng có `id uuid default gen_random_uuid()`, trigger BEFORE INSERT (`set_user_id_from_auth`,
// `autofill_org_strict`) không đụng `new.id`, chỉ mục duy nhất duy nhất là khoá chính; `asset_movements` không có trigger
// AFTER nào (di chuyển không đổi phòng của tài sản, hộp cũng không đổi). Nên mã do trình duyệt sinh (`createRecordOnce`):
// lần bấm lại gửi ĐÚNG mã cũ, khoá chính chặn bản thứ hai, đọc đúng mã cho biết lần trước đã ghi chưa.
type AssetCreateTable = 'assets' | 'asset_handovers' | 'asset_movements' | 'asset_maintenance';
export type CreatedAssetRecord<T> = T & { /** Lần bấm trước đã ghi đúng bản ghi này; lần này không ghi thêm. */ replayed: boolean };

/** Trường người dùng nhập có giống nhau không giữa dòng đọc lại của lần gửi trước và dòng đang tạo (rỗng / null như nhau). */
function sameEnteredFields(stored: Record<string, unknown>, payload: Record<string, unknown>, fields: readonly string[]): boolean {
  const norm = (value: unknown) => value === undefined || value === null || value === '' ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return fields.every(field => norm(stored[field]) === norm(payload[field]));
}

async function createAssetRecordOnce<T extends { id: string }>(input: {
  table: AssetCreateTable; userId: string; organizationId: string | null; operation: string;
  /** Dòng gửi đi, đã bọc `withOrg(...)` ở nơi gọi. */
  payload: Record<string, unknown>;
  /** Các trường người dùng nhập, để nhận ra lần trước đã ghi với thông tin khác. */
  fields: readonly string[];
  /** Khoá nhận ra «cùng bản ghi đang tạo» giữa hai lần bấm trong tab. */
  matchKey: (normalize: (value: unknown) => string) => string;
  describe: (row: Record<string, unknown>) => string;
}): Promise<CreatedAssetRecord<T>> {
  return repeatableWrite(input.operation, async () => {
    const { createRecordOnce, normalizeVietnameseName, pickClientId } = await import('@/lib/clientRecordCreate');
    const organizationId = input.organizationId ?? '';
    const matchKeys = [input.matchKey(normalizeVietnameseName)];
    // Có lần bấm trước còn chưa rõ của cùng bản ghi không: chỉ khi đó «đã có trên máy chủ» mới là do lần bấm trước ghi.
    // Không có thì đó là chính lần gửi này (mất phản hồi nhưng đọc lại thấy), báo tạo xong như thường.
    const prior = pickClientId(input.table, input.userId, organizationId, matchKeys).reused;
    const { row, replayed } = await createRecordOnce<T>({
      table: input.table, userId: input.userId, organizationId, matchKeys,
      payload: input.payload, operation: input.operation, sameAs: stored => sameEnteredFields(stored, input.payload, input.fields), describe: input.describe,
    });
    return { ...row, replayed: replayed && prior };
  });
}
const ASSET_FIELDS = ['name', 'code', 'category_id', 'supplier_id', 'quantity', 'condition', 'purchase_date', 'purchase_price', 'building_id', 'room_id', 'description'] as const;
const HANDOVER_FIELDS = ['contract_id', 'type', 'handover_date', 'items'] as const;
const MOVEMENT_FIELDS = ['asset_id', 'from_room_id', 'to_room_id', 'quantity', 'movement_date', 'from_location', 'to_location', 'reason'] as const;
const MAINTENANCE_FIELDS = ['asset_id', 'issue_description', 'maintenance_date', 'status', 'cost', 'assigned_to', 'notes'] as const;

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

/** Bộ lọc client-side của màn Tài sản (phần không đẩy xuống query: phòng + từ khoá). */
export interface AssetListFilter {
  roomId?: string;
  search?: string;
}

type AssetLikeForFilter = Pick<AssetWithRelations, "room_id" | "name" | "code" | "category">;

// hermes-parity:begin w2d-assets — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
/**
 * Lọc theo phòng và từ khoá (tên / mã / tên loại, không phân biệt hoa thường).
 * Thuần để trang bọc trong `useMemo`: trước đây phép lọc chạy lại mỗi render
 * (kể cả khi mở/đóng dialog) trên toàn bộ danh sách đã `fetchAllRows`.
 */
export function filterAssets<T extends AssetLikeForFilter>(assets: readonly T[], filter: AssetListFilter): T[] {
  const search = filter.search ? filter.search.toLowerCase() : "";
  return assets.filter((asset) => {
    if (filter.roomId && asset.room_id !== filter.roomId) return false;
    if (!search) return true;
    return Boolean(
      asset.name?.toLowerCase().includes(search) ||
        asset.code?.toLowerCase().includes(search) ||
        asset.category?.name?.toLowerCase().includes(search),
    );
  });
}
// hermes-parity:end w2d-assets

// hermes-parity:begin w2d-assets
export interface AssetSummary {
  totalAssets: number;
  /** Σ giá mua × số lượng (giá null tính 0, số lượng null tính 1). */
  totalValue: number;
  /** Đếm theo tình trạng; tình trạng null xếp vào GOOD. */
  byCondition: Record<string, number>;
}

type AssetLikeForSummary = Pick<AssetWithRelations, "purchase_price" | "quantity" | "condition">;

/** Tổng số, tổng giá trị và đếm theo tình trạng — một lượt duyệt thay cho hai `.reduce`. */
export function summarizeAssets(assets: readonly AssetLikeForSummary[]): AssetSummary {
  let totalValue = 0;
  const byCondition: Record<string, number> = {};
  for (const asset of assets) {
    totalValue += (asset.purchase_price || 0) * (asset.quantity || 1);
    const condition = asset.condition || "GOOD";
    byCondition[condition] = (byCondition[condition] || 0) + 1;
  }
  return { totalAssets: assets.length, totalValue, byCondition };
}
// hermes-parity:end w2d-assets

// Fetch all assets
export const useAssets = (filters?: {
  category_id?: string;
  building_id?: string;
  condition?: string;
}) => {
  return useQuery({
    queryKey: ["assets", filters],
    queryFn: async (): Promise<AssetWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // hermes-parity:begin w2d-assets
      // PAGED: 1 portfolio ~700 phòng × nhiều tài sản/phòng dễ vượt 1000 dòng →
      // tổng giá trị tài sản (client-reduce ở AssetsPage) hụt nếu không phân trang.
      const data = await fetchAllRows<any>(
        (from, to) => {
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
            .is("deleted_at", null);
          if (filters?.category_id) query = query.eq("category_id", filters.category_id);
          if (filters?.building_id) query = query.eq("building_id", filters.building_id);
          if (filters?.condition) query = query.eq("condition", filters.condition as any);
          return query
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to);
        },
        { label: "assets.list" },
      );

      if (data === null) {
        toast.error("Không thể tải danh sách tài sản");
        throw new Error("Lỗi tải danh sách tài sản");
      }

      return (data as AssetWithRelations[]) || [];
      // hermes-parity:end w2d-assets
    },
  });
};

// Fetch single asset
export const useAsset = (id: string) => {
  return useQuery({
    queryKey: ["assets", id],
    queryFn: async (): Promise<AssetWithRelations> => {
      const user = await getSessionUser();
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
  // `assets` nằm trong 33 bảng chuyển sang trigger autofill FAIL-CLOSED
  // (migration 20260915144656): không suy được tổ chức thì INSERT nổ 23502
  // thay vì rơi về hằng org THẬT. Client phải tự khai.
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (data: AssetInsert): Promise<CreatedAssetRecord<Asset>> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const payload = withOrg({ ...data, user_id: user.id }, selectedOrganizationId);
      // Cùng tài sản giữa hai lần bấm: cùng mã tài sản, không có mã thì cùng tên chuẩn hoá.
      const asset = await createAssetRecordOnce<Asset>({
        table: 'assets', userId: user.id, organizationId: selectedOrganizationId, operation: 'tạo tài sản', payload, fields: ASSET_FIELDS,
        matchKey: normalize => normalize(data.code) ? `c:${normalize(data.code)}` : `n:${normalize(data.name)}`,
        describe: row => `Tài sản ${String(row.name ?? '')}`,
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'asset-create', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return asset;
    },
    onSuccess: (asset) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success(asset.replayed ? `Tài sản ${asset.name} đã được tạo ở lần bấm trước (mã ${asset.id}); không tạo thêm.` : `Đã tạo tài sản ${asset.name}`);
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      reportAssetFailure(error, "Chưa tạo được tài sản", "tạo tài sản");
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
      confirmedRecordId(asset,'cập nhật tài sản',id);
      return asset;
    },
    onSuccess: (asset) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success(`Đã cập nhật tài sản ${asset.name}`);
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      reportAssetFailure(error, "Chưa cập nhật được tài sản", "cập nhật tài sản");
    },
  });
};

// Delete asset (soft delete)
export const useDeleteAsset = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("assets")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id")
        .single();

      if (error) throw error;
      confirmedRecordId(data,'xóa tài sản',id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast.success("Tài sản đã được xóa thành công");
    },
    onError: (error: unknown) => {
      reportAssetFailure(error, "Chưa xóa được tài sản", "xóa tài sản");
    },
  });
};

// Fetch asset handovers
export const useAssetHandovers = (contract_id?: string) => {
  return useQuery({
    queryKey: ["asset-handovers", contract_id],
    queryFn: async (): Promise<AssetHandoverWithRelations[]> => {
      const user = await getSessionUser();
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
        .order("handover_date", { ascending: false });

      if (contract_id) {
        query = query.eq("contract_id", contract_id);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách biên bản");
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách bàn giao tài sản. Tải lại để kiểm tra.');
      return data as AssetHandoverWithRelations[];
    },
  });
};

// Create asset handover
export const useCreateAssetHandover = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (data: Omit<AssetHandoverInsert, "organization_id">): Promise<CreatedAssetRecord<AssetHandover>> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const payload = withOrg({ ...data, user_id: user.id }, selectedOrganizationId);
      const handover = await createAssetRecordOnce<AssetHandover>({
        table: 'asset_handovers', userId: user.id, organizationId: selectedOrganizationId, operation: 'tạo biên bản bàn giao', payload, fields: HANDOVER_FIELDS,
        matchKey: () => `h:${data.contract_id}|${data.type}`,
        describe: row => `Biên bản ${row.type === 'CHECK_OUT' ? 'trả' : 'nhận'} căn hộ`,
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'asset-handover-create', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return handover;
    },
    onSuccess: (handover) => {
      queryClient.invalidateQueries({ queryKey: ["asset-handovers"] });
      toast.success(handover.replayed ? `Biên bản bàn giao đã được tạo ở lần bấm trước (mã ${handover.id}); không tạo thêm.` : "Biên bản bàn giao đã được tạo thành công");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["asset-handovers"] });
      reportAssetFailure(error, "Chưa tạo được biên bản bàn giao", "tạo biên bản bàn giao");
    },
  });
};

// Fetch asset movements
export const useAssetMovements = (asset_id?: string) => {
  return useQuery({
    queryKey: ["asset-movements", asset_id],
    queryFn: async (): Promise<AssetMovementWithRelations[]> => {
      const user = await getSessionUser();
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
        .order("movement_date", { ascending: false });

      if (asset_id) {
        query = query.eq("asset_id", asset_id);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải lịch sử di chuyển");
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được lịch sử di chuyển tài sản. Tải lại để kiểm tra.');
      return data as AssetMovementWithRelations[];
    },
  });
};

// Create asset movement
export const useCreateAssetMovement = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (data: Omit<AssetMovementInsert, "organization_id">): Promise<CreatedAssetRecord<AssetMovement>> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const payload = withOrg({ ...data, user_id: user.id }, selectedOrganizationId);
      // Chỉ ghi một dòng lịch sử di chuyển: không có bước đổi phòng của tài sản ở trình duyệt hay trigger nào phải lặp lại.
      const movement = await createAssetRecordOnce<AssetMovement>({
        table: 'asset_movements', userId: user.id, organizationId: selectedOrganizationId, operation: 'ghi di chuyển tài sản', payload, fields: MOVEMENT_FIELDS,
        matchKey: () => `m:${data.asset_id}`,
        describe: row => `Di chuyển tài sản ngày ${String(row.movement_date ?? '')}`,
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'asset-movement-create', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */ }
      return movement;
    },
    onSuccess: (movement) => {
      queryClient.invalidateQueries({ queryKey: ["asset-movements"] });
      toast.success(movement.replayed ? `Di chuyển tài sản đã được ghi ở lần bấm trước (mã ${movement.id}); không ghi thêm.` : "Di chuyển tài sản đã được ghi nhận thành công");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["asset-movements"] });
      reportAssetFailure(error, "Chưa ghi nhận được di chuyển tài sản", "ghi nhận di chuyển tài sản");
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
      const user = await getSessionUser();
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

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được lịch sử bảo trì tài sản. Tải lại để kiểm tra.');
      return data as AssetMaintenanceWithRelations[];
    },
  });
};

// Create asset maintenance
export const useCreateAssetMaintenance = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (data: Omit<AssetMaintenanceInsert, "organization_id">): Promise<CreatedAssetRecord<AssetMaintenance>> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const payload = withOrg({ ...data, user_id: user.id }, selectedOrganizationId);
      const maintenance = await createAssetRecordOnce<AssetMaintenance>({
        table: 'asset_maintenance', userId: user.id, organizationId: selectedOrganizationId, operation: 'tạo phiếu bảo trì', payload, fields: MAINTENANCE_FIELDS,
        matchKey: () => `mt:${data.asset_id}`,
        describe: row => `Phiếu bảo trì ngày ${String(row.maintenance_date ?? '')}`,
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'asset-maintenance-create', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return maintenance;
    },
    onSuccess: (maintenance) => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      toast.success(maintenance.replayed ? `Phiếu bảo trì đã được tạo ở lần bấm trước (mã ${maintenance.id}); không tạo thêm.` : "Phiếu bảo trì đã được tạo thành công");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      reportAssetFailure(error, "Chưa tạo được phiếu bảo trì", "tạo phiếu bảo trì");
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
      confirmedRecordId(maintenance,'cập nhật phiếu bảo trì',id);
      return maintenance;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      toast.success("Phiếu bảo trì đã được cập nhật thành công");
    },
    onError: (error: unknown) => {
      queryClient.invalidateQueries({ queryKey: ["asset-maintenance"] });
      reportAssetFailure(error, "Chưa cập nhật được phiếu bảo trì", "cập nhật phiếu bảo trì");
    },
  });
};
