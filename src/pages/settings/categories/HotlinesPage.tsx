import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Phone } from "lucide-react";
import {
  useHotlines,
  useCreateHotline,
  useUpdateHotline,
  useDeleteHotline,
} from "@/hooks/useHotlines";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";

type Hotline = Database["public"]["Tables"]["hotlines"]["Row"];

const columns: ColumnDef<Hotline>[] = [
  { key: "name", header: "Tên" },
  { key: "phone_number", header: "Số điện thoại" },
  { key: "description", header: "Mô tả" },
  {
    key: "is_active",
    header: "Trạng thái",
    render: (item) => (
      <Badge variant={item.is_active ? "default" : "secondary"}>
        {item.is_active ? "Hoạt động" : "Ngừng"}
      </Badge>
    ),
  },
];

const fields: FieldDef[] = [
  { key: "name", label: "Tên hotline", placeholder: "Nhập tên hotline", required: true },
  { key: "phone_number", label: "Số điện thoại", placeholder: "Nhập số điện thoại", required: true },
  { key: "description", label: "Mô tả", type: "textarea", placeholder: "Nhập mô tả" },
  { key: "is_active", label: "Trạng thái", type: "checkbox", placeholder: "Đang hoạt động" },
];

export default function HotlinesPage() {
  const { data, isLoading, error, refetch } = useHotlines();
  const createMutation = useCreateHotline({inlineError:true});
  const updateMutation = useUpdateHotline({inlineError:true});
  const deleteMutation = useDeleteHotline({inlineError:true});

  return (
    <CategoryCrudPage<Hotline>
      title="Quản lý Hotline"
      subtitle="Quản lý danh sách hotline"
      icon={Phone}
      data={data}
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      columns={columns}
      fields={fields}
      onCreate={(values) => createMutation.mutateAsync(values as any)}
      onUpdate={(id, values) => updateMutation.mutateAsync({ id, updates: values as any })}
      onDelete={(id) => deleteMutation.mutateAsync(id)}
      isCreating={createMutation.isPending}
      isUpdating={updateMutation.isPending}
      isDeleting={deleteMutation.isPending}
      getId={(item) => item.id}
      getFormValues={(item) => ({
        name: item.name,
        phone_number: item.phone_number,
        description: item.description ?? "",
        is_active: item.is_active ?? true,
      })}
    />
  );
}
