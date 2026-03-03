import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useJobGroups } from "@/hooks/useJobGroups";
import { useJobTypes } from "@/hooks/useJobTypes";
import { useProfiles } from "@/hooks/useJobs";
import {
  TaskFilters,
  JOB_STATUSES,
  STATUS_LABELS,
  JOB_PRIORITIES,
  PRIORITY_LABELS,
} from "@/types/jobs";

interface TaskFiltersPanelProps {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  onApply: () => void;
  onClear: () => void;
}

export function TaskFiltersPanel({
  filters,
  onChange,
  onApply,
  onClear,
}: TaskFiltersPanelProps) {
  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(filters.building_id ?? undefined);
  const { data: jobGroups } = useJobGroups();
  const { data: jobTypes } = useJobTypes();
  const { data: profiles } = useProfiles();

  const handleChange = (patch: Partial<TaskFilters>) => {
    onChange({ ...filters, ...patch });
  };

  const handleBuildingChange = (value: string) => {
    const buildingId = value === "ALL" ? null : value;
    handleChange({
      building_id: buildingId,
      room_id: null,
    });
  };

  const handleRoomChange = (value: string) => {
    handleChange({ room_id: value === "ALL" ? null : value });
  };

  return (
    <div className="border rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Căn hộ */}
        <Select
          value={filters.building_id ?? "ALL"}
          onValueChange={handleBuildingChange}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Chọn căn hộ" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Chọn căn hộ</SelectItem>
            {(buildings || []).map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Phòng */}
        <Select
          value={filters.room_id ?? "ALL"}
          onValueChange={handleRoomChange}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Chọn phòng" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Chọn phòng</SelectItem>
            {(rooms || []).map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Nhóm công việc */}
        <Select
          value={filters.job_group_id ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ job_group_id: v === "ALL" ? null : v })
          }
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Nhóm công việc" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Nhóm công việc</SelectItem>
            {(jobGroups || []).map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Loại công việc */}
        <Select
          value={filters.job_type_id ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ job_type_id: v === "ALL" ? null : v })
          }
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Loại công việc" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Loại công việc</SelectItem>
            {(jobTypes || []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Mức độ ưu tiên */}
        <Select
          value={filters.priority ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ priority: v === "ALL" ? null : (v as any) })
          }
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Mức độ ưu tiên" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Mức độ ưu tiên</SelectItem>
            {JOB_PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Người thực hiện */}
        <Select
          value={filters.assignee_id ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ assignee_id: v === "ALL" ? null : v })
          }
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Người thực hiện" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Người thực hiện</SelectItem>
            {(profiles || []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Trạng thái */}
        <Select
          value={filters.status ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ status: v === "ALL" ? null : (v as any) })
          }
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Trạng thái" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Trạng thái</SelectItem>
            {JOB_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Từ ngày */}
        <Input
          type="date"
          value={filters.start_date ?? ""}
          onChange={(e) =>
            handleChange({ start_date: e.target.value || null })
          }
          className="h-9 text-sm"
          placeholder="Từ ngày"
        />

        {/* Đến ngày */}
        <Input
          type="date"
          value={filters.end_date ?? ""}
          onChange={(e) =>
            handleChange({ end_date: e.target.value || null })
          }
          className="h-9 text-sm"
          placeholder="Đến ngày"
        />
      </div>

      <div className="flex items-center gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onClear}>
          Xoá bộ lọc
        </Button>
        <Button
          size="sm"
          className="bg-green-600 hover:bg-green-700 text-white"
          onClick={onApply}
        >
          Áp dụng
        </Button>
      </div>
    </div>
  );
}
