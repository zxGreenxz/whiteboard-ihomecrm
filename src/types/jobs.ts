// Job status enum
export const JOB_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type JobStatus = typeof JOB_STATUSES[number];

// Trạng thái ĐÃ ĐÓNG — hết vòng đời, chỉ còn giá trị tra cứu. Thêm trạng thái
// đóng mới (vd huỷ) PHẢI khai ở đây, kẻo nó bị coi là việc còn tồn đọng.
export const CLOSED_JOB_STATUSES: readonly JobStatus[] = ['COMPLETED'];

// Trạng thái ĐANG MỞ (việc còn tồn đọng). useJobs KHÔNG áp cửa sổ thời gian
// mặc định cho nhóm này: việc mở tạo lâu hơn cửa sổ vẫn phải hiện ra.
export const OPEN_JOB_STATUSES: readonly JobStatus[] = JOB_STATUSES.filter(
  (s) => !CLOSED_JOB_STATUSES.includes(s),
);

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

// Job row từ list select — CHỈ các cột JOB_LIST_SELECT trong useJobs kéo về.
// Các cột audit chỉ-để-GHI qua mutation (user_id, visible_to_customer,
// completion_attachments, completion_lat/lng/distance_m/geofence_status/address,
// started_at, updated_at) KHÔNG nằm trong payload list — cần thì query theo id.
export interface Job {
  id: string;
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
  attachments: string[] | null;
  completion_time: string | null;
  completion_description: string | null;
  created_at: string;
}

// Toà nhà kèm toạ độ — đủ để JobCaptureCamera so geo-fence khi hoàn thành
// (địa chỉ trên watermark lấy từ reverse-geocode GPS, không dùng cột địa chỉ).
export interface JobBuildingRef {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
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
  /**
   * Cửa sổ thời gian khi KHÔNG đặt Từ/Đến ngày: null/undefined = 90 ngày gần
   * nhất (jobs tích luỹ vô hạn, không bound thì list kéo trọn bảng), "all" =
   * toàn bộ lịch sử (useJobs phân trang fetchAllRows nên không dính cap 1000).
   * Cửa sổ CHỈ cắt việc đã đóng — việc đang mở (OPEN_JOB_STATUSES) luôn hiện.
   * Đặt Từ/Đến ngày thì cửa sổ này bị bỏ qua.
   */
  time_range?: "90d" | "all" | null;
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
