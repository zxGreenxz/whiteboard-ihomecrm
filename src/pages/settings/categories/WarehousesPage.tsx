import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Warehouse } from "lucide-react";
import {
  useAssetWarehouses,
  useCreateAssetWarehouse,
  useUpdateAssetWarehouse,
  useDeleteAssetWarehouse,
} from "@/hooks/useAssetWarehouses";
import type { Database } from "@/integrations/supabase/types";

type AssetWarehouse = Database["public"]["Tables"]["asset_warehouses"]["Row"];

const columns: ColumnDef<AssetWarehouse>[] = [
  { key: "name", header: "Tên kho" },
  { key: "location", header: "Vị trí" },
];

const fields: FieldDef[] = [
  { key: "name", label: "Tên kho", placeholder: "Nhập tên kho tài sản", required: true },
  { key: "location", label: "Vị trí", type: "textarea", placeholder: "Nhập vị trí kho" },
];

export default function WarehousesPage() {
  const { data, isLoading } = useAssetWarehouses();
  const createMutation = useCreateAssetWarehouse();
  const updateMutation = useUpdateAssetWarehouse();
  const deleteMutation = useDeleteAssetWarehouse();

  return (
    <CategoryCrudPage<AssetWarehouse>
      title="Kho tài sản"
      subtitle="Quản lý kho tài sản"
      icon={Warehouse}
      data={data}
      isLoading={isLoading}
      columns={columns}
      fields={fields}
      onCreate={(values) => createMutation.mutate(values as any)}
      onUpdate={(id, values) => updateMutation.mutate({ id, updates: values as any })}
      onDelete={(id) => deleteMutation.mutate(id)}
      isCreating={createMutation.isPending}
      isUpdating={updateMutation.isPending}
      isDeleting={deleteMutation.isPending}
      getId={(item) => item.id}
      getFormValues={(item) => ({
        name: item.name,
        location: item.location ?? "",
      })}
    />
  );
}
