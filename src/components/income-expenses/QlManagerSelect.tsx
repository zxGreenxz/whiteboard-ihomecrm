// Ô chọn quản lý nhận hoa hồng (ô QL, migration 20260927155251). Chỉ mount khi người
// dùng đã tích QL ⇒ danh sách quản lý tải lười. Công ty lấy theo TOÀ của phiếu
// (QlManagerSelectForBuilding), không theo công ty đang chọn ở thanh chuyển.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  /** Câu hiện khi chưa có công ty (vd form chưa chọn toà). */
  noOrgHint?: string;
}

export function QlManagerSelect({ organizationId, value, onPick, id, noOrgHint }: Props) {
  const { data: options = [], isLoading, isError } = useCommissionManagerOptions(organizationId);
  const placeholder = !organizationId
    ? noOrgHint || "Chưa xác định công ty"
    : isLoading
      ? "Đang tải…"
      : isError
        ? "Không tải được danh sách quản lý"
        : options.length
          ? "Chọn quản lý..."
          : "Chưa có quản lý hưởng lương";
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const m = options.find((o) => o.staffId === v);
        if (m) onPick(m);
      }}
    >
      <SelectTrigger id={id} aria-label="Chọn quản lý nhận hoa hồng">
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
      noOrgHint={!buildingId ? "Chọn tòa nhà trước" : isLoading ? "Đang tải…" : "Không xác định được công ty của tòa"}
      {...props}
    />
  );
}

export default QlManagerSelect;
