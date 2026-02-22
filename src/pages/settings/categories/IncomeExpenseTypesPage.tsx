import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { ArrowUpDown } from "lucide-react";
import {
  useIncomeExpenseTypes,
  useCreateIncomeExpenseType,
  useUpdateIncomeExpenseType,
  useDeleteIncomeExpenseType,
} from "@/hooks/useIncomeExpenseTypes";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";

type IncomeExpenseType = Database["public"]["Tables"]["income_expense_types"]["Row"];

const columns: ColumnDef<IncomeExpenseType>[] = [
  { key: "name", header: "Tên loại" },
  {
    key: "type",
    header: "Loại",
    render: (item) => (
      <Badge variant={item.type === "income" ? "default" : "destructive"}>
        {item.type === "income" ? "Thu" : "Chi"}
      </Badge>
    ),
  },
  { key: "description", header: "Mô tả" },
  {
    key: "is_default",
    header: "Mặc định",
    render: (item) => (item.is_default ? "Có" : ""),
  },
];

const fields: FieldDef[] = [
  { key: "name", label: "Tên loại", placeholder: "Nhập tên loại thu chi", required: true },
  {
    key: "type",
    label: "Loại",
    type: "select",
    required: true,
    options: [
      { value: "income", label: "Thu" },
      { value: "expense", label: "Chi" },
    ],
  },
  { key: "description", label: "Mô tả", type: "textarea", placeholder: "Nhập mô tả" },
  { key: "is_default", label: "Mặc định", type: "checkbox", placeholder: "Đặt làm mặc định" },
];

export default function IncomeExpenseTypesPage() {
  const { data, isLoading } = useIncomeExpenseTypes();
  const createMutation = useCreateIncomeExpenseType();
  const updateMutation = useUpdateIncomeExpenseType();
  const deleteMutation = useDeleteIncomeExpenseType();

  return (
    <CategoryCrudPage<IncomeExpenseType>
      title="Loại thu chi"
      subtitle="Quản lý loại thu chi"
      icon={ArrowUpDown}
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
        type: item.type,
        description: item.description ?? "",
        is_default: item.is_default ?? false,
      })}
    />
  );
}
