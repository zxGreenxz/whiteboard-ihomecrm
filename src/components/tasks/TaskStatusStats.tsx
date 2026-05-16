import { Clock, CheckCircle, type LucideIcon } from 'lucide-react';
import { JobWithRelations, JOB_STATUSES, STATUS_LABELS, type JobStatus } from '@/types/jobs';
import { computeTaskStats, getStatusColor } from '@/lib/jobValidation';

const STATUS_ICONS: Record<JobStatus, LucideIcon> = {
  IN_PROGRESS: Clock,
  COMPLETED: CheckCircle,
};

interface TaskStatusStatsProps {
  jobs: JobWithRelations[];
}

export function TaskStatusStats({ jobs }: TaskStatusStatsProps) {
  const stats = computeTaskStats(jobs);

  return (
    <div className="grid grid-cols-2 gap-4">
      {JOB_STATUSES.map((status) => {
        const Icon = STATUS_ICONS[status];
        const colorClass = getStatusColor(status);

        return (
          <div
            key={status}
            className={`rounded-lg border p-4 ${colorClass}`}
          >
            <div className="flex items-center gap-2 mb-2">
              <Icon className="h-4 w-4" />
              <span className="text-sm font-medium">{STATUS_LABELS[status]}</span>
            </div>
            <div className="text-2xl font-bold">{stats[status]}</div>
          </div>
        );
      })}
    </div>
  );
}
