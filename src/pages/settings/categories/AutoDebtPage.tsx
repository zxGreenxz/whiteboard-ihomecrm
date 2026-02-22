import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { RefreshCw } from "lucide-react";
import {
  useAutoDebtConfigs,
  useCreateAutoDebtConfig,
  useUpdateAutoDebtConfig,
  useDeleteAutoDebtConfig,
} from "@/hooks/useAutoDebtConfig";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";

type AutoDebtConfig = Database["public"]["Tables"]["auto_debt_config"]["Row"];

const columns: ColumnDef<AutoDebtConfig>[] = [
  { key: "bank_account", header: "Tài khoản ngân hàng" },
  {
    key: "is_enabled",
    header: "Trạng thái",
    render: (item) => (
      <Badge variant={item.is_enabled ? "default" : "secondary"}>
        {item.is_enabled ? "Đang bật" : "Đã tắt"}
      </Badge>
    ),
  },
];

const fields: FieldDef[] = [
  { key: "bank_account", label: "Tài khoản ngân hàng", placeholder: "Nhập số tài khoản", required: true },
  { key: "is_enabled", label: "Kích hoạt", type: "checkbox", placeholder: "Bật gạch nợ tự động" },
];

export default function AutoDebtPage() {
  const { data, isLoading } = useAutoDebtConfigs();
  const createMutation = useCreateAutoDebtConfig();
  const updateMutation = useUpdateAutoDebtConfig();
  const deleteMutation = useDeleteAutoDebtConfig();

  return (
    <CategoryCrudPage<AutoDebtConfig>
      title="Gạch nợ tự động"
      subtitle="Cấu hình gạch nợ tự động"
      icon={RefreshCw}
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
        bank_account: item.bank_account ?? "",
        is_enabled: item.is_enabled ?? false,
      })}
    />
  );
}
