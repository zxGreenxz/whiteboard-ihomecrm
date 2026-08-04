import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BackupStatus, FleetFilters as FilterState, IncidentSeverity, NetworkHealth } from "@/lib/network-center/contracts";

interface FleetFiltersProps {
  filters: FilterState;
  resultCount: number;
  totalCount: number;
  onChange: (filters: FilterState) => void;
  onReset: () => void;
}

export function FleetFilters({ filters, resultCount, totalCount, onChange, onReset }: FleetFiltersProps) {
  return (
    <section className="nc-filters" aria-label="Bộ lọc toà nhà">
      <label className="nc-search-field">
        <span className="sr-only">Tìm toà nhà</span>
        <Search aria-hidden="true" />
        <Input
          value={filters.search ?? ""}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Tìm theo tên toà nhà"
        />
      </label>

      <FilterSelect
        label="Sức khoẻ"
        value={filters.health ?? "all"}
        options={[
          ["all", "Mọi sức khoẻ"],
          ["online", "Hoạt động tốt"],
          ["degraded", "Suy giảm"],
          ["offline", "Mất kết nối"],
        ]}
        onChange={(health) => onChange({ ...filters, health: health as NetworkHealth | "all" })}
      />
      <FilterSelect
        label="Mức sự cố"
        value={filters.severity ?? "all"}
        options={[
          ["all", "Mọi mức sự cố"],
          ["critical", "Nghiêm trọng"],
          ["high", "Cao"],
          ["medium", "Trung bình"],
          ["low", "Thấp"],
        ]}
        onChange={(severity) => onChange({ ...filters, severity: severity as IncidentSeverity | "all" })}
      />
      <FilterSelect
        label="Backup"
        value={filters.backup ?? "all"}
        options={[["all", "Mọi trạng thái backup"], ["fresh", "Backup mới"], ["stale", "Backup cũ"]]}
        onChange={(backup) => onChange({ ...filters, backup: backup as BackupStatus | "all" })}
      />
      <FilterSelect
        label="Firmware"
        value={filters.firmware ?? "all"}
        options={[["all", "Mọi firmware"], ["drift", "Sai lệch firmware"]]}
        onChange={(firmware) => onChange({ ...filters, firmware: firmware as "drift" | "all" })}
      />

      <div className="nc-filter-result" aria-live="polite">
        <strong>{resultCount}</strong> / {totalCount} toà nhà
      </div>
      <Button variant="outline" onClick={onReset}>
        <RotateCcw data-icon="inline-start" aria-hidden="true" /> Đặt lại
      </Button>
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent className="network-center nc-select-content">
        <SelectGroup>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
