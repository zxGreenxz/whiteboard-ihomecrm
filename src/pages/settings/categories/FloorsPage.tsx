import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Layers } from "lucide-react";
import {
  useFloors,
  useCreateFloor,
  useUpdateFloor,
  useDeleteFloor,
} from "@/hooks/useFloors";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";

type Floor = Database["public"]["Tables"]["floors"]["Row"];

const columns: ColumnDef<Floor>[] = [
  { key: "floor_number", header: "Số tầng" },
  { key: "name", header: "Tên tầng" },
  { key: "description", header: "Mô tả" },
  {
    key: "status",
    header: "Trạng thái",
    render: (item) => (
      <Badge variant={item.status === "active" ? "default" : "secondary"}>
        {item.status === "active" ? "Hoạt động" : "Ngừng"}
      </Badge>
    ),
  },
];

const fields: FieldDef[] = [
  { key: "floor_number", label: "Số tầng", type: "number", placeholder: "Nhập số tầng", required: true },
  { key: "name", label: "Tên tầng", placeholder: "VD: Tầng 1, Tầng trệt" },
  { key: "description", label: "Mô tả", type: "textarea", placeholder: "Nhập mô tả" },
];

export default function FloorsPage() {
  const { data, isLoading } = useFloors();
  const createMutation = useCreateFloor();
  const updateMutation = useUpdateFloor();
  const deleteMutation = useDeleteFloor();

  return (
    <CategoryCrudPage<Floor>
      title="Danh sách tầng"
      subtitle="Quản lý danh sách tầng"
      icon={Layers}
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
        floor_number: item.floor_number,
        name: item.name ?? "",
        description: item.description ?? "",
      })}
    />
  );
}
