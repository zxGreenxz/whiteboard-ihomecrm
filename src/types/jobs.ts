// Job status enum
export const JOB_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'FAILED', 'OVERDUE'] as const;
export type JobStatus = typeof JOB_STATUSES[number];

// Job priority enum
export const JOB_PRIORITIES = ['NORMAL', 'LOW', 'URGENT'] as const;
export type JobPriority = typeof JOB_PRIORITIES[number];

// Status labels (Vietnamese)
export const STATUS_LABELS: Record<JobStatus, string> = {
  NOT_STARTED: 'Chưa làm',
  IN_PROGRESS: 'Đang làm',
  PENDING_ACCEPTANCE: 'Chờ nghiệm thu',
  ACCEPTED: 'Đã nghiệm thu',
  FAILED: 'Không đạt',
  OVERDUE: 'Quá hạn',
};

// Priority labels (Vietnamese)
export const PRIORITY_LABELS: Record<JobPriority, string> = {
  NORMAL: 'Bình thường',
  LOW: 'Thấp',
  URGENT: 'Gấp',
};

// Valid status transitions
export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['PENDING_ACCEPTANCE'],
  PENDING_ACCEPTANCE: ['ACCEPTED', 'FAILED'],
  ACCEPTED: [],
  FAILED: [],
  OVERDUE: [],
};

// Job row from database
export interface Job {
  id: string;
  user_id: string;
  code: string;
  title: string;
  description: string | null;
  building_id: string | null;
  room_id: string | null;
  bed_id: string | null;
  job_type_id: string | null;
  priority: JobPriority;
  assignee_id: string | null;
  deadline: string | null;
  status: JobStatus;
  visible_to_customer: boolean;
  attachments: string[] | null;
  completion_time: string | null;
  completion_description: string | null;
  completion_attachments: string[] | null;
  acceptance_result: string | null;
  customer_evaluation: string | null;
  customer_comments: string | null;
  accepted_at: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

// Job with joined relations (for display)
export interface JobWithRelations extends Job {
  buildings: { id: string; name: string } | null;
  rooms: { id: string; name: string } | null;
  beds: { id: string; name: string } | null;
  job_types: { id: string; name: string } | null;
  profiles: { id: string; full_name: string } | null;
}

// Filter state
export interface TaskFilters {
  building_id: string | null;
  room_id: string | null;
  job_type_id: string | null;
  priority: JobPriority | null;
  assignee_id: string | null;
  status: JobStatus | null;
  start_date: string | null;
  end_date: string | null;
}

export const defaultTaskFilters: TaskFilters = {
  building_id: null,
  room_id: null,
  job_type_id: null,
  priority: null,
  assignee_id: null,
  status: null,
  start_date: null,
  end_date: null,
};
