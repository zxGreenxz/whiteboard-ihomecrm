import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { ClipboardList, Image as ImageIcon } from "lucide-react";
import { format } from "date-fns";
import type { JobWithRelations } from "@/types/jobs";
import { getStatusLabel, getStatusColor } from "@/lib/jobValidation";

interface Props {
  jobs: JobWithRelations[];
  isLoading: boolean;
  onView: (job: JobWithRelations) => void;
}

export function TaskListMobile({ jobs, isLoading, onView }: Props) {
  if (isLoading) {
    return (
      <div className="px-3 py-3 space-y-2.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={ClipboardList}
          title="Chưa có công việc nào"
          description="Hãy tạo công việc mới qua nút (+) bên dưới hoặc nới bộ lọc."
        />
      </div>
    );
  }

  return (
    <ul role="list" className="px-3 py-3 space-y-2.5 pb-24">
      {jobs.map((job) => {
        const isCompleted = job.status === "COMPLETED";
        const accentColor = isCompleted ? "#10b981" : "#3b82f6";
        const firstAttachment = job.attachments?.[0];
        const location = [job.rooms?.name, job.buildings?.name]
          .filter(Boolean)
          .join(" - ");
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
              className="relative bg-white border border-zinc-200 rounded-xl p-3.5 shadow-sm active:scale-[0.985] active:shadow-none transition-transform cursor-pointer"
              style={{
                borderLeft: `3px solid ${accentColor}`,
              }}
            >
              {/* Row 1: title + status chip */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <span className="font-medium text-[15px] text-zinc-900 line-clamp-2 min-w-0">
                  {job.title}
                </span>
                <span
                  className={`shrink-0 px-2 py-0.5 text-[11px] font-medium rounded-full ${getStatusColor(
                    job.status,
                  )}`}
                >
                  {getStatusLabel(job.status)}
                </span>
              </div>

              {/* Row 2: location + job type */}
              <div className="text-[13px] text-zinc-600 mb-1 line-clamp-1">
                {location && <span className="font-medium">{location}</span>}
                {location && job.job_types?.name && (
                  <span className="mx-1.5 text-zinc-300">·</span>
                )}
                {job.job_types?.name && <span>{job.job_types.name}</span>}
              </div>

              {/* Row 3: deadline + assignee + thumb */}
              <div className="flex items-center justify-between gap-2 mt-1">
                <div className="flex items-center gap-1.5 text-[12px] text-zinc-400 min-w-0">
                  {job.deadline && (
                    <span className="truncate">
                      {format(new Date(job.deadline), "dd/MM/yyyy HH:mm")}
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
                  <div className="shrink-0 w-8 h-8 rounded-md border border-zinc-200 bg-zinc-50 overflow-hidden flex items-center justify-center">
                    {/\.pdf(\?|$)/i.test(firstAttachment) ? (
                      <ImageIcon className="h-4 w-4 text-zinc-400" />
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
