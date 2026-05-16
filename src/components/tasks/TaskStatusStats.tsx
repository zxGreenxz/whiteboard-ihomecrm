import { Clock, CheckCircle, type LucideIcon } from 'lucide-react';
import { JobWithRelations, JOB_STATUSES, STATUS_LABELS, type JobStatus } from '@/types/jobs';
import { computeTaskStats, getStatusColor } from '@/lib/jobValidation';
import { useIsMobile } from '@/hooks/use-mobile';

const STATUS_ICONS: Record<JobStatus, LucideIcon> = {
  IN_PROGRESS: Clock,
  COMPLETED: CheckCircle,
};

interface TaskStatusStatsProps {
  jobs: JobWithRelations[];
}

export function TaskStatusStats({ jobs }: TaskStatusStatsProps) {
  const stats = computeTaskStats(jobs);
  const isMobile = useIsMobile();

  return (
    <div className={isMobile ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 gap-4"}>
      {JOB_STATUSES.map((status) => {
        const Icon = STATUS_ICONS[status];
        const colorClass = getStatusColor(status);

        return (
          <div
            key={status}
            className={`rounded-lg border ${colorClass} ${
              isMobile ? "px-3 py-2" : "p-4"
            }`}
          >
            <div className={`flex items-center gap-1.5 ${isMobile ? "mb-0.5" : "mb-2"}`}>
              <Icon className={isMobile ? "h-3.5 w-3.5" : "h-4 w-4"} />
              <span className={`font-medium ${isMobile ? "text-[12px]" : "text-sm"}`}>
                {STATUS_LABELS[status]}
              </span>
            </div>
            <div className={`font-bold ${isMobile ? "text-lg" : "text-2xl"}`}>
              {stats[status]}
            </div>
          </div>
        );
      })}
    </div>
  );
}
