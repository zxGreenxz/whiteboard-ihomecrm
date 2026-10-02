// Ô chọn quản lý nhận hoa hồng (ô QL, migration 20260927155251). Chỉ mount khi người
// dùng đã tích QL ⇒ danh sách quản lý tải lười. Công ty lấy theo TOÀ của phiếu
// (QlManagerSelectForBuilding), không theo công ty đang chọn ở thanh chuyển.
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InlineSkeleton } from "@/components/loading/LoadingState";
import {
  useCommissionManagerOptions,
  useOrganizationOfBuilding,
  type CommissionManagerOption,
} from "@/hooks/useCommissionManager";

interface Props {
  organizationId: string | null | undefined;
  value: string;
  onPick: (m: CommissionManagerOption) => void;
  id?: string;
  name?: string;
  error?: string;
  /** Câu hiện khi chưa có công ty (vd form chưa chọn toà); đang nạp thì là vạch xám. */
  noOrgHint?: ReactNode;
}

export function QlManagerSelect({ organizationId, value, onPick, id, name, error, noOrgHint }: Props) {
  const { data: options = [], isLoading, isError } = useCommissionManagerOptions(organizationId);
  // Đang nạp danh sách: ô chọn để trống kèm vạch xám, không chữ "Đang tải…" (chủ chốt 02/10/2026).
  const placeholder: ReactNode = !organizationId
    ? noOrgHint || "Chưa xác định công ty"
    : isLoading
      ? <InlineSkeleton label="danh sách quản lý" width="8rem" />
      : isError
        ? "Không tải được danh sách quản lý"
        : options.length
          ? "Chọn quản lý..."
          : "Chưa có quản lý hưởng lương";
  return (
    <>
    <Select
      value={value}
      onValueChange={(v) => {
        const m = options.find((o) => o.staffId === v);
        if (m) onPick(m);
      }}
    >
      <SelectTrigger id={id} name={name} data-field-name={name} aria-invalid={!!error} aria-describedby={error?`${id||name}-error`:undefined} aria-label="Chọn quản lý nhận hoa hồng">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.staffId} value={o.staffId}>
            {o.displayName}
            {o.alias && o.alias !== o.displayName ? ` (${o.alias})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {error&&<p id={`${id||name}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </>
  );
}

/** Như QlManagerSelect, công ty suy từ toà của phiếu. */
export function QlManagerSelectForBuilding({
  buildingId,
  ...props
}: Omit<Props, "organizationId" | "noOrgHint"> & { buildingId: string | null | undefined }) {
  const { data: organizationId, isLoading } = useOrganizationOfBuilding(buildingId);
  return (
    <QlManagerSelect
      organizationId={organizationId}
      noOrgHint={!buildingId ? "Chọn tòa nhà trước" : isLoading ? <InlineSkeleton label="công ty của tòa" width="8rem" /> : "Không xác định được công ty của tòa"}
      {...props}
    />
  );
}

export default QlManagerSelect;
