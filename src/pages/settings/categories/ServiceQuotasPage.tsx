import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Gauge } from "lucide-react";
import {
  useServiceQuotas,
  useCreateServiceQuota,
  useUpdateServiceQuota,
  useDeleteServiceQuota,
} from "@/hooks/useServiceQuotas";
import type { Database } from "@/integrations/supabase/types";

type ServiceQuota = Database["public"]["Tables"]["service_quotas"]["Row"];

const columns: ColumnDef<ServiceQuota>[] = [
  { key: "quota_value", header: "Giá trị định mức" },
  { key: "unit", header: "Đơn vị" },
  { key: "description", header: "Mô tả" },
];

const fields: FieldDef[] = [
  { key: "quota_value", label: "Giá trị định mức", type: "number", placeholder: "Nhập giá trị", required: true },
  { key: "unit", label: "Đơn vị", placeholder: "VD: kWh, m³" },
  { key: "description", label: "Mô tả", type: "textarea", placeholder: "Nhập mô tả" },
];

export default function ServiceQuotasPage() {
  const { data, isLoading } = useServiceQuotas();
  const createMutation = useCreateServiceQuota();
  const updateMutation = useUpdateServiceQuota();
  const deleteMutation = useDeleteServiceQuota();

  return (
    <CategoryCrudPage<ServiceQuota>
      title="Định mức dịch vụ"
      subtitle="Quản lý định mức dịch vụ"
      icon={Gauge}
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
        quota_value: item.quota_value,
        unit: item.unit ?? "",
        description: item.description ?? "",
      })}
    />
  );
}
