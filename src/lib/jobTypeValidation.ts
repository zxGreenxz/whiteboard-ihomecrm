import { z } from 'zod';
import type { IssuePriority } from '@/types/jobTypes';

// ============================================================
// Zod Schema
// ============================================================

export const jobTypeFormSchema = z.object({
  name: z.string().min(1, 'Tên loại công việc không được để trống'),
  job_group_id: z.string().min(1, 'Vui lòng chọn nhóm công việc'),
  default_priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  customer_contact_deadline: z.number().int().min(0).default(0),
  acceptance_deadline: z.number().int().min(0).default(0),
  completion_deadline: z.number().int().min(0).default(0),
  business_hours_only: z.boolean().default(false),
  default_department_id: z.string().min(1, 'Vui lòng chọn bộ phận thực hiện'),
  // Bảng lương: thưởng theo loại việc
  bonus_amount: z.number().int().min(0).default(0),
  is_repair: z.boolean().default(false),
  is_contract: z.boolean().default(false),
  counts_for_salary: z.boolean().default(true),
});

export type JobTypeFormValues = z.infer<typeof jobTypeFormSchema>;

// ============================================================
// Priority Labels
// ============================================================

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  URGENT: 'Khẩn cấp',
  HIGH: 'Cao',
  MEDIUM: 'Bình thường',
  LOW: 'Thấp',
};

export const PRIORITY_OPTIONS: { value: IssuePriority; label: string }[] = [
  { value: 'URGENT', label: PRIORITY_LABELS.URGENT },
  { value: 'HIGH', label: PRIORITY_LABELS.HIGH },
  { value: 'MEDIUM', label: PRIORITY_LABELS.MEDIUM },
  { value: 'LOW', label: PRIORITY_LABELS.LOW },
];

export function getPriorityLabel(priority: IssuePriority): string {
  return PRIORITY_LABELS[priority];
}

// ============================================================
// Search & Pagination Helpers
// ============================================================

export function filterJobTypesBySearch<T extends { name: string }>(
  jobTypes: T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return jobTypes;
  return jobTypes.filter((jt) => jt.name.toLowerCase().includes(trimmed));
}

export function paginateJobTypes<T>(
  jobTypes: T[],
  page: number,
  pageSize: number,
): { data: T[]; totalCount: number } {
  const totalCount = jobTypes.length;
  const start = (page - 1) * pageSize;
  const data = jobTypes.slice(start, start + pageSize);
  return { data, totalCount };
}
