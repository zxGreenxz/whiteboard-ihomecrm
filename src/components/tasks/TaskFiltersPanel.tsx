import { SearchableSelect } from "@/components/ui/searchable-select";
import { uniqueRoomNames, roomIdsByName, roomNameFromIds } from "@/lib/roomSort";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
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
      room_ids: null,
    });
  };

  // Lọc theo TÊN phòng (gộp phòng cùng tên ở mọi toà nhà → 1 lựa chọn).
  const handleRoomChange = (name: string) => {
    handleChange({
      room_id: null,
      room_ids: name === "ALL" ? null : roomIdsByName(rooms || [], name),
    });
  };

  // Trục "Ngày hoàn thành": useJobs CỐ Ý không áp cửa sổ mặc định (phiếu đang
  // làm có completion_time NULL, cắt cửa sổ là giấu sạch) → dropdown khoảng
  // thời gian không tác dụng, khoá lại kẻo nhãn "90 ngày gần đây" nói dối.
  const byCompletionTime = filters.date_field === "completion_time";

  const roomValue =
    roomNameFromIds(rooms || [], filters.room_ids) ??
    (filters.room_id
      ? (rooms || []).find((r) => r.id === filters.room_id)?.name
      : undefined) ??
    "ALL";

  return (
    <div className="border rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Căn hộ */}
        <SearchableSelect
          value={filters.building_id ?? "ALL"}
          onValueChange={handleBuildingChange}
          className="h-9 text-sm"
          placeholder="Chọn căn hộ"
          options={[
            { value: "ALL", label: "Chọn căn hộ" },
            ...(buildings || []).map((b) => ({ value: b.id, label: b.name })),
          ]}
        />

        {/* Phòng — gộp theo tên (nhiều toà cùng "101" → 1 mục) */}
        <SearchableSelect
          value={roomValue}
          onValueChange={handleRoomChange}
          className="h-9 text-sm"
          placeholder="Chọn phòng"
          options={[
            { value: "ALL", label: "Chọn phòng" },
            ...uniqueRoomNames(rooms || []).map((n) => ({ value: n, label: n })),
          ]}
        />

        {/* Loại công việc */}
        <SearchableSelect
          value={filters.job_type_id ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ job_type_id: v === "ALL" ? null : v })
          }
          className="h-9 text-sm"
          placeholder="Loại công việc"
          options={[
            { value: "ALL", label: "Loại công việc" },
            ...(jobTypes || []).map((t) => ({ value: t.id, label: t.name })),
          ]}
        />

        {/* Mức độ ưu tiên */}
        <SearchableSelect
          value={filters.priority ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ priority: v === "ALL" ? null : (v as any) })
          }
          className="h-9 text-sm"
          placeholder="Mức độ ưu tiên"
          options={[
            { value: "ALL", label: "Mức độ ưu tiên" },
            ...JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
          ]}
        />

        {/* Người thực hiện */}
        <SearchableSelect
          value={filters.assignee_id ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ assignee_id: v === "ALL" ? null : v })
          }
          className="h-9 text-sm"
          placeholder="Người thực hiện"
          options={[
            { value: "ALL", label: "Người thực hiện" },
            ...(profiles || []).map((p) => ({ value: p.id, label: p.full_name })),
          ]}
        />

        {/* Trạng thái */}
        <SearchableSelect
          value={filters.status ?? "ALL"}
          onValueChange={(v) =>
            handleChange({ status: v === "ALL" ? null : (v as any) })
          }
          className="h-9 text-sm"
          placeholder="Trạng thái"
          options={[
            { value: "ALL", label: "Trạng thái" },
            ...JOB_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          ]}
        />

        {/* Trục ngày — lương tính theo NGÀY HOÀN THÀNH, nên muốn đối chiếu
            bảng lương thì phải đổi sang "Ngày hoàn thành". */}
        <SearchableSelect
          value={filters.date_field ?? "created_at"}
          onValueChange={(v) => handleChange({ date_field: v as any })}
          className="h-9 text-sm"
          placeholder="Lọc theo ngày"
          options={[
            { value: "created_at", label: "Theo ngày tạo" },
            { value: "completion_time", label: "Theo ngày hoàn thành" },
          ]}
        />

        {/* Cửa sổ thời gian — jobs tích luỹ vô hạn nên mặc định chỉ tải 90
            ngày gần nhất (việc ĐANG MỞ luôn hiện dù cũ hơn); "Toàn bộ lịch sử"
            để xem cả việc đã đóng cũ hơn. Đặt Từ/Đến ngày thì cửa sổ này bị bỏ
            qua (query theo khoảng đã đặt). */}
        <div className="space-y-1">
          <SearchableSelect
            value={byCompletionTime ? "all" : (filters.time_range ?? "90d")}
            onValueChange={(v) =>
              // "90d" là mặc định → ghi null cho object filter/persisted gọn,
              // và query key khớp với filter cũ đã lưu (không có time_range).
              handleChange({ time_range: v === "all" ? "all" : null })
            }
            disabled={byCompletionTime}
            className="h-9 text-sm"
            placeholder="Khoảng thời gian"
            options={[
              { value: "90d", label: "90 ngày gần đây" },
              { value: "all", label: "Toàn bộ lịch sử" },
            ]}
          />
          {byCompletionTime && (
            <p className="text-[11px] leading-tight text-muted-foreground">
              Trục “Ngày hoàn thành” không áp cửa sổ 90 ngày — giới hạn bằng
              Từ/Đến ngày.
            </p>
          )}
        </div>

        {/* Từ ngày */}
        <DateInput
          value={filters.start_date ?? ""}
          onChange={(v) => handleChange({ start_date: v || null })}
          className="h-9 text-sm"
          placeholder="Từ ngày"
        />

        {/* Đến ngày */}
        <DateInput
          value={filters.end_date ?? ""}
          onChange={(v) => handleChange({ end_date: v || null })}
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
