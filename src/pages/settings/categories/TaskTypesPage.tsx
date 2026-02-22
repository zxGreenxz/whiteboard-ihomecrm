import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Briefcase } from "lucide-react";
import {
  useTaskTypes,
  useCreateTaskType,
  useUpdateTaskType,
  useDeleteTaskType,
} from "@/hooks/useTaskTypes";
import type { Database } from "@/integrations/supabase/types";

type TaskType = Database["public"]["Tables"]["task_types"]["Row"];

const columns: ColumnDef<TaskType>[] = [
  { key: "name", header: "Tên loại" },
  { key: "description", header: "Mô tả" },
  {
    key: "color",
    header: "Màu",
    render: (item) =>
      item.color ? (
        <div className="flex items-center gap-2">
          <div
            className="h-4 w-4 rounded-full border"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-sm">{item.color}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

const fields: FieldDef[] = [
  { key: "name", label: "Tên loại công việc", placeholder: "Nhập tên loại", required: true },
  { key: "description", label: "Mô tả", type: "textarea", placeholder: "Nhập mô tả" },
  { key: "color", label: "Màu sắc", placeholder: "#3b82f6" },
];

export default function TaskTypesPage() {
  const { data, isLoading } = useTaskTypes();
  const createMutation = useCreateTaskType();
  const updateMutation = useUpdateTaskType();
  const deleteMutation = useDeleteTaskType();

  return (
    <CategoryCrudPage<TaskType>
      title="Loại công việc"
      subtitle="Quản lý loại công việc"
      icon={Briefcase}
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
        description: item.description ?? "",
        color: item.color ?? "",
      })}
    />
  );
}
