import { ArrowDownAZ, ArrowUpAZ, ArrowUpDown, Check, CalendarClock, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TASK_SORT_OPTIONS,
  TASK_SORT_DIR_LABEL,
  TASK_SORT_FIELD_LABEL,
  defaultTaskSort,
  isSameTaskSort,
  type TaskSort,
} from "@/lib/taskSort";

interface TaskSortMenuProps {
  value: TaskSort;
  onChange: (sort: TaskSort) => void;
}

/** Nút sắp xếp cạnh ô tìm kiếm (desktop). Mobile dùng sheet riêng trong TasksMobilePage. */
export default function TaskSortMenu({ value, onChange }: TaskSortMenuProps) {
  const isDefault = isSameTaskSort(value, defaultTaskSort);
  const DirIcon = value.dir === "asc" ? ArrowUpAZ : ArrowDownAZ;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 gap-2 ${isDefault ? "" : "border-green-600 text-green-700 bg-green-50 hover:bg-green-100"}`}
          title="Sắp xếp danh sách"
        >
          <ArrowUpDown className="h-4 w-4" />
          <span className="hidden lg:inline">Sắp xếp:</span>
          <span className="font-medium">{TASK_SORT_FIELD_LABEL[value.field]}</span>
          <DirIcon className="h-4 w-4 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Sắp xếp theo</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TASK_SORT_OPTIONS.map((opt, i) => {
          const active = isSameTaskSort(opt, value);
          const prev = TASK_SORT_OPTIONS[i - 1];
          const FieldIcon = opt.field === "deadline" ? CalendarClock : CalendarPlus;
          return (
            <div key={`${opt.field}-${opt.dir}`}>
              {prev && prev.field !== opt.field && <DropdownMenuSeparator />}
              <DropdownMenuItem
                className="gap-2 cursor-pointer"
                onSelect={() => onChange(opt)}
              >
                <FieldIcon className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 leading-tight">
                  <div className="text-sm">{TASK_SORT_FIELD_LABEL[opt.field]}</div>
                  <div className="text-xs text-muted-foreground">
                    {TASK_SORT_DIR_LABEL[opt.field][opt.dir]}
                  </div>
                </div>
                {active && <Check className="h-4 w-4 text-green-600" />}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
