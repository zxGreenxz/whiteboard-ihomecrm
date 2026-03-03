import { z } from 'zod';
import {
  JobStatus,
  JobPriority,
  JobWithRelations,
  TaskFilters,
  JOB_STATUSES,
  VALID_TRANSITIONS,
  STATUS_LABELS,
  PRIORITY_LABELS,
} from '@/types/jobs';

// ─── Zod Schemas ───────────────────────────────────────────────

export const jobCreateSchema = z.object({
  title: z.string().min(1, 'Tiêu đề không được để trống'),
  description: z.string().optional().nullable(),
  building_id: z.string().uuid().optional().nullable(),
  room_id: z.string().uuid().optional().nullable(),
  bed_id: z.string().uuid().optional().nullable(),
  job_group_id: z.string().uuid().optional().nullable(),
  job_type_id: z.string().uuid().optional().nullable(),
  priority: z.enum(['NORMAL', 'LOW', 'URGENT']).default('NORMAL'),
  assignee_id: z.string().uuid().optional().nullable(),
  deadline: z.string().datetime().optional().nullable(),
  visible_to_customer: z.boolean().default(false),
  attachments: z.array(z.string().url()).optional().nullable(),
});

export type JobCreateFormValues = z.infer<typeof jobCreateSchema>;

export const jobCompleteSchema = z.object({
  completion_time: z.string().min(1, 'Thời gian hoàn thành không được để trống'),
  completion_description: z.string().optional().nullable(),
  completion_attachments: z.array(z.string().url()).optional().nullable(),
});

export type JobCompleteFormValues = z.infer<typeof jobCompleteSchema>;

export const jobAcceptanceSchema = z.object({
  acceptance_result: z.string().optional().nullable(),
  customer_evaluation: z.string().optional().nullable(),
  customer_comments: z.string().optional().nullable(),
});

export type JobAcceptanceFormValues = z.infer<typeof jobAcceptanceSchema>;

// ─── Pure Helper Functions ─────────────────────────────────────

export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAvailableActions(status: JobStatus): string[] {
  switch (status) {
    case 'NOT_STARTED':
      return ['accept'];
    case 'IN_PROGRESS':
      return ['complete'];
    case 'PENDING_ACCEPTANCE':
      return ['review'];
    default:
      return [];
  }
}

export function computeTaskStats(jobs: JobWithRelations[]): Record<JobStatus, number> {
  const stats: Record<JobStatus, number> = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    PENDING_ACCEPTANCE: 0,
    ACCEPTED: 0,
    FAILED: 0,
    OVERDUE: 0,
  };
  for (const job of jobs) {
    if (job.status in stats) {
      stats[job.status]++;
    }
  }
  return stats;
}

export function filterJobs(jobs: JobWithRelations[], filters: TaskFilters): JobWithRelations[] {
  return jobs.filter((job) => {
    if (filters.building_id && job.building_id !== filters.building_id) return false;
    if (filters.room_id && job.room_id !== filters.room_id) return false;
    if (filters.job_group_id && job.job_group_id !== filters.job_group_id) return false;
    if (filters.job_type_id && job.job_type_id !== filters.job_type_id) return false;
    if (filters.priority && job.priority !== filters.priority) return false;
    if (filters.assignee_id && job.assignee_id !== filters.assignee_id) return false;
    if (filters.status && job.status !== filters.status) return false;
    if (filters.start_date && job.created_at < filters.start_date) return false;
    if (filters.end_date && job.created_at > filters.end_date) return false;
    return true;
  });
}

export function paginateJobs(
  jobs: JobWithRelations[],
  page: number,
  pageSize: number,
): { data: JobWithRelations[]; total: number } {
  const start = (page - 1) * pageSize;
  return {
    data: jobs.slice(start, start + pageSize),
    total: jobs.length,
  };
}

export function isOverdue(job: { deadline: string | null; status: string }): boolean {
  if (!job.deadline) return false;
  if (job.status === 'ACCEPTED') return false;
  return new Date(job.deadline) < new Date();
}

export function getStatusLabel(status: JobStatus): string {
  return STATUS_LABELS[status];
}

export function getStatusColor(status: JobStatus): string {
  const colors: Record<JobStatus, string> = {
    NOT_STARTED: 'bg-gray-100 text-gray-700',
    IN_PROGRESS: 'bg-blue-100 text-blue-700',
    PENDING_ACCEPTANCE: 'bg-yellow-100 text-yellow-700',
    ACCEPTED: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    OVERDUE: 'bg-orange-100 text-orange-700',
  };
  return colors[status];
}

export function getPriorityLabel(priority: JobPriority): string {
  return PRIORITY_LABELS[priority];
}

export function getPriorityColor(priority: JobPriority): string {
  const colors: Record<JobPriority, string> = {
    NORMAL: 'bg-gray-100 text-gray-700',
    LOW: 'bg-blue-100 text-blue-700',
    URGENT: 'bg-red-100 text-red-700',
  };
  return colors[priority];
}
