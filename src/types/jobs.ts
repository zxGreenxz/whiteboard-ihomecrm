// Job status enum
export const JOB_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type JobStatus = typeof JOB_STATUSES[number];

// Job priority enum
export const JOB_PRIORITIES = ['NORMAL', 'LOW', 'URGENT'] as const;
export type JobPriority = typeof JOB_PRIORITIES[number];

// Status labels (Vietnamese)
export const STATUS_LABELS: Record<JobStatus, string> = {
  IN_PROGRESS: 'Đang làm',
  COMPLETED: 'Hoàn thành',
};

// Priority labels (Vietnamese)
export const PRIORITY_LABELS: Record<JobPriority, string> = {
  NORMAL: 'Bình thường',
  LOW: 'Thấp',
  URGENT: 'Gấp',
};

// Valid status transitions
export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
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
  job_type_id: string | null;
  priority: JobPriority;
  assignee_id: string | null;
  assignee_name: string | null;
  deadline: string | null;
  status: JobStatus;
  visible_to_customer: boolean;
  attachments: string[] | null;
  completion_time: string | null;
  completion_description: string | null;
  completion_attachments: string[] | null;
  // Audit geo-fence khi hoàn thành (xem useCompleteJob / JobCaptureCamera)
  completion_lat: number | null;
  completion_lng: number | null;
  completion_distance_m: number | null;
  completion_geofence_status: string | null;
  completion_address: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

// Toà nhà kèm địa chỉ + toạ độ (đủ để vẽ watermark + so geo-fence)
export interface JobBuildingRef {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  street_address: string | null;
  ward: string | null;
  district: string | null;
  province: string | null;
}

// Job with joined relations (for display)
export interface JobWithRelations extends Job {
  buildings: JobBuildingRef | null;
  rooms: { id: string; name: string } | null;
  job_types: { id: string; name: string } | null;
  profiles: { id: string; full_name: string } | null;
}

// Filter state
export interface TaskFilters {
  building_id: string | null;
  room_id: string | null;
  /** Lọc theo nhiều phòng cùng tên (gộp mọi toà). Ưu tiên hơn room_id. */
  room_ids?: string[] | null;
  job_type_id: string | null;
  priority: JobPriority | null;
  assignee_id: string | null;
  status: JobStatus | null;
  start_date: string | null;
  end_date: string | null;
  /**
   * Cột ngày để lọc. Mặc định "created_at" (ngày tạo). Chọn "completion_time"
   * khi cần đối chiếu với bảng lương — lương bucket theo NGÀY HOÀN THÀNH.
   */
  date_field?: "created_at" | "completion_time" | null;
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
  date_field: "created_at",
};
