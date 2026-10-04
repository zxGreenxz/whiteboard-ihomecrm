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
import { BankEmailPanel } from "@/components/bank-email/BankEmailPanel";

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
  const { data, isLoading, error, refetch } = useAutoDebtConfigs();
  const createMutation = useCreateAutoDebtConfig({inlineError:true});
  const updateMutation = useUpdateAutoDebtConfig({inlineError:true});
  const deleteMutation = useDeleteAutoDebtConfig({inlineError:true});

  return (
    <CategoryCrudPage<AutoDebtConfig>
      title="Gạch nợ tự động"
      subtitle="Kết nối thông báo ACB và đối soát hóa đơn"
      icon={RefreshCw}
      beforeContent={<>
        <BankEmailPanel />
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <strong className="text-foreground">Cấu hình gạch nợ khác</strong> bên dưới chưa kết nối với email ACB.
        </div>
      </>}
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
        bank_account: item.bank_account ?? "",
        is_enabled: item.is_enabled ?? false,
      })}
    />
  );
}
