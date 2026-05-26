import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { ClipboardList, Image as ImageIcon } from "lucide-react";
import { format } from "date-fns";
import type { JobWithRelations } from "@/types/jobs";
import { getStatusLabel, getStatusColor, isOverdue } from "@/lib/jobValidation";

interface Props {
  jobs: JobWithRelations[];
  isLoading: boolean;
  onView: (job: JobWithRelations) => void;
}

export function TaskListMobile({ jobs, isLoading, onView }: Props) {
  if (isLoading) {
    return (
      <div className="px-3 py-2 space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="py-6">
        <EmptyState
          icon={ClipboardList}
          title="Chưa có công việc nào"
          description="Tạo qua nút (+) bên dưới hoặc nới bộ lọc."
        />
      </div>
    );
  }

  return (
    <ul role="list" className="px-3 py-2 space-y-1.5 pb-24">
      {jobs.map((job) => {
        const isCompleted = job.status === "COMPLETED";
        const overdue = isOverdue(job);
        const accentColor = isCompleted
          ? "#10b981"
          : overdue
            ? "#ef4444"
            : "#3b82f6";
        const tintClass = isCompleted
          ? "bg-green-50/50"
          : overdue
            ? "bg-red-50/60"
            : "bg-blue-50/30";
        const firstAttachment = job.attachments?.[0];
        const location = job.buildings?.name
          ? `${job.rooms?.name ?? "Toàn nhà"} - ${job.buildings.name}`
          : (job.rooms?.name ?? "");
        const assignee = job.profiles?.full_name || job.assignee_name;

        return (
          <li key={job.id}>
            <article
              role="button"
              tabIndex={0}
              onClick={() => onView(job)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onView(job);
              }}
              className={`relative border border-zinc-200 rounded-lg p-2.5 shadow-sm active:scale-[0.985] active:shadow-none transition-transform cursor-pointer ${tintClass}`}
              style={{
                borderLeft: `3px solid ${accentColor}`,
              }}
            >
              {/* Row 1: title + status chip */}
              <div className="flex items-start justify-between gap-2 mb-0.5">
                <span className="font-medium text-[14px] text-zinc-900 line-clamp-2 min-w-0 leading-snug">
                  {job.title}
                </span>
                {overdue ? (
                  <span className="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full bg-red-100 text-red-700">
                    Trễ hẹn
                  </span>
                ) : (
                  <span
                    className={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full ${getStatusColor(
                      job.status,
                    )}`}
                  >
                    {getStatusLabel(job.status)}
                  </span>
                )}
              </div>

              {/* Row 2: location + job type */}
              <div className="text-[12px] text-zinc-600 line-clamp-1">
                {location && <span className="font-medium">{location}</span>}
                {location && job.job_types?.name && (
                  <span className="mx-1 text-zinc-300">·</span>
                )}
                {job.job_types?.name && <span>{job.job_types.name}</span>}
              </div>

              {/* Row 3: deadline + assignee + thumb */}
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <div className="flex items-center gap-1 text-[11px] text-zinc-400 min-w-0">
                  {job.deadline && (
                    <span className="truncate">
                      {format(new Date(job.deadline), "dd/MM HH:mm")}
                    </span>
                  )}
                  {assignee && (
                    <>
                      {job.deadline && <span>·</span>}
                      <span className="truncate">{assignee}</span>
                    </>
                  )}
                </div>
                {firstAttachment && (
                  <div className="shrink-0 w-7 h-7 rounded-md border border-zinc-200 bg-zinc-50 overflow-hidden flex items-center justify-center">
                    {/\.pdf(\?|$)/i.test(firstAttachment) ? (
                      <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
                    ) : (
                      <img
                        src={firstAttachment}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                )}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default TaskListMobile;
