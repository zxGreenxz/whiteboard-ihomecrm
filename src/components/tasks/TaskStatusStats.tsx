import { Clock, CheckCircle, type LucideIcon } from 'lucide-react';
import { JobWithRelations, JOB_STATUSES, STATUS_LABELS, type JobStatus } from '@/types/jobs';
import { computeTaskStats, getStatusColor } from '@/lib/jobValidation';
import { useIsMobile } from '@/hooks/use-mobile';

const STATUS_ICONS: Record<JobStatus, LucideIcon> = {
  IN_PROGRESS: Clock,
  COMPLETED: CheckCircle,
};

const ACTIVE_RING: Record<JobStatus, string> = {
  IN_PROGRESS: 'ring-2 ring-blue-400',
  COMPLETED: 'ring-2 ring-green-500',
};

interface TaskStatusStatsProps {
  jobs: JobWithRelations[];
  activeFilter?: JobStatus | null;
  onFilterChange?: (status: JobStatus) => void;
}

export function TaskStatusStats({
  jobs,
  activeFilter = null,
  onFilterChange,
}: TaskStatusStatsProps) {
  const stats = computeTaskStats(jobs);
  const isMobile = useIsMobile();

  return (
    <div className={isMobile ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 gap-4"}>
      {JOB_STATUSES.map((status) => {
        const Icon = STATUS_ICONS[status];
        const colorClass = getStatusColor(status);
        const isActive = activeFilter === status;
        const clickable = !!onFilterChange;

        return (
          <button
            key={status}
            type="button"
            disabled={!clickable}
            onClick={() => onFilterChange?.(status)}
            className={`text-left rounded-lg border ${colorClass} transition-all ${
              clickable ? "hover:shadow-md active:scale-[0.98] cursor-pointer" : "cursor-default"
            } ${isActive ? ACTIVE_RING[status] : ""} ${
              isMobile ? "px-3 py-2" : "p-4"
            }`}
          >
            <div className={`flex items-center gap-1.5 ${isMobile ? "mb-0.5" : "mb-2"}`}>
              <Icon className={isMobile ? "h-3.5 w-3.5" : "h-4 w-4"} />
              <span className={`font-medium ${isMobile ? "text-[12px]" : "text-sm"}`}>
                {STATUS_LABELS[status]}
              </span>
              {isActive && (
                <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/60 ${isMobile ? "" : "text-[11px]"}`}>
                  Đang lọc
                </span>
              )}
            </div>
            <div className={`font-bold ${isMobile ? "text-lg" : "text-2xl"}`}>
              {stats[status]}
            </div>
          </button>
        );
      })}
    </div>
  );
}
