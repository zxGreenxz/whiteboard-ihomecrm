import CategoryCrudPage, { ColumnDef, FieldDef } from "./CategoryCrudPage";
import { Activity } from "lucide-react";
import {
  useMeters,
  useCreateMeter,
  useUpdateMeter,
  useDeleteMeter,
} from "@/hooks/useMeters";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";

type Meter = Database["public"]["Tables"]["meters"]["Row"];

const columns: ColumnDef<Meter>[] = [
  { key: "meter_code", header: "Mã công tơ" },
  {
    key: "meter_type",
    header: "Loại",
    render: (item) => (
      <Badge variant={item.meter_type === "electricity" ? "default" : "secondary"}>
        {item.meter_type === "electricity" ? "Điện" : "Nước"}
      </Badge>
    ),
  },
  { key: "initial_reading", header: "Chỉ số đầu" },
  { key: "current_reading", header: "Chỉ số hiện tại" },
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
  { key: "meter_code", label: "Mã công tơ", placeholder: "Nhập mã công tơ", required: true },
  {
    key: "meter_type",
    label: "Loại công tơ",
    type: "select",
    required: true,
    options: [
      { value: "electricity", label: "Điện" },
      { value: "water", label: "Nước" },
    ],
  },
  { key: "initial_reading", label: "Chỉ số đầu", type: "number", placeholder: "0" },
  { key: "current_reading", label: "Chỉ số hiện tại", type: "number", placeholder: "0" },
];

export default function MetersPage() {
  const { data, isLoading } = useMeters();
  const createMutation = useCreateMeter();
  const updateMutation = useUpdateMeter();
  const deleteMutation = useDeleteMeter();

  return (
    <CategoryCrudPage<Meter>
      title="Đồng hồ công tơ"
      subtitle="Quản lý đồng hồ công tơ"
      icon={Activity}
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
        meter_code: item.meter_code ?? "",
        meter_type: item.meter_type,
        initial_reading: item.initial_reading ?? 0,
        current_reading: item.current_reading ?? 0,
      })}
    />
  );
}
