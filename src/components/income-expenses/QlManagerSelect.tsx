// Ô chọn quản lý nhận hoa hồng (ô QL, migration 20260927155251). Chỉ mount khi người
// dùng đã tích QL ⇒ danh sách quản lý tải lười, và form không phụ thuộc
// OrganizationProvider khi không dùng tới ô này.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useCommissionManagerOptions, type CommissionManagerOption } from "@/hooks/useCommissionManager";

interface Props {
  organizationId: string | null | undefined;
  value: string;
  onPick: (m: CommissionManagerOption) => void;
  id?: string;
}

export function QlManagerSelect({ organizationId, value, onPick, id }: Props) {
  const { data: options = [], isLoading, isError } = useCommissionManagerOptions(organizationId);
  const placeholder = !organizationId
    ? "Chưa xác định công ty"
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

/** Như QlManagerSelect, lấy công ty đang chọn (OrganizationProvider). */
export function QlManagerSelectCurrentOrg(props: Omit<Props, "organizationId">) {
  const { selectedOrganizationId } = useOrganization();
  return <QlManagerSelect organizationId={selectedOrganizationId} {...props} />;
}

export default QlManagerSelect;
