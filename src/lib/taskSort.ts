import type { JobWithRelations } from "@/types/jobs";

/**
 * Sắp xếp danh sách công việc — dùng CHUNG cho desktop (TaskManagementPage) và
 * mobile (TasksMobilePage). Tách khỏi UI để kiểm được bằng test: thứ tự là
 * phần "toán", nút bấm chỉ là hình ảnh.
 *
 * Vì sao sort ở client mà không đẩy xuống PostgREST: useJobs kéo HẾT dòng
 * trong cửa sổ (fetchAllRows) rồi lọc/phân trang ở client. Đổi .order() dưới
 * server sẽ làm queryKey đổi theo mỗi lần bấm sort ⇒ mất cache, gọi lại mạng
 * cho một việc thuần trình bày.
 */

export type TaskSortField = "deadline" | "created_at";
export type TaskSortDir = "asc" | "desc";

export interface TaskSort {
  field: TaskSortField;
  dir: TaskSortDir;
}

/** Mặc định giữ đúng hành vi cũ: mới tạo trước (useJobs order created_at desc). */
export const defaultTaskSort: TaskSort = { field: "created_at", dir: "desc" };

export const TASK_SORT_FIELD_LABEL: Record<TaskSortField, string> = {
  deadline: "Hạn hoàn thành",
  created_at: "Ngày tạo",
};

/** Nhãn hướng đọc theo trục — "tăng dần/giảm dần" mơ hồ với người dùng cuối. */
export const TASK_SORT_DIR_LABEL: Record<TaskSortField, Record<TaskSortDir, string>> = {
  deadline: { asc: "Gần hết hạn trước", desc: "Xa hạn nhất trước" },
  created_at: { asc: "Cũ nhất trước", desc: "Mới nhất trước" },
};

/** 4 lựa chọn phẳng cho menu/sheet — desktop và mobile hiển thị y hệt nhau. */
export const TASK_SORT_OPTIONS: TaskSort[] = [
  { field: "deadline", dir: "asc" },
  { field: "deadline", dir: "desc" },
  { field: "created_at", dir: "desc" },
  { field: "created_at", dir: "asc" },
];

export const taskSortLabel = (s: TaskSort): string =>
  `${TASK_SORT_FIELD_LABEL[s.field]} · ${TASK_SORT_DIR_LABEL[s.field][s.dir]}`;

export const isSameTaskSort = (a: TaskSort, b: TaskSort): boolean =>
  a.field === b.field && a.dir === b.dir;

/** Chuỗi ISO → mốc thời gian; giá trị rỗng/hỏng coi như "không có". */
const ts = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Trả về MẢNG MỚI đã sắp xếp (không sửa mảng đầu vào).
 *
 * Hai quy ước cố ý:
 * 1. Việc KHÔNG có hạn (deadline null) luôn nằm CUỐI, bất kể chiều sắp xếp —
 *    đảo chiều để lôi một đống "Không hạn" lên đầu là vô nghĩa với người dùng.
 * 2. Bằng nhau thì phá hoà bằng created_at giảm dần rồi tới id, để thứ tự ổn
 *    định giữa các lần render (rất nhiều phiếu cùng hạn 23:59 cùng ngày).
 */
export function sortJobs<T extends Pick<JobWithRelations, "id" | "deadline" | "created_at">>(
  jobs: T[],
  sort: TaskSort,
): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const av = ts(sort.field === "deadline" ? a.deadline : a.created_at);
    const bv = ts(sort.field === "deadline" ? b.deadline : b.created_at);

    if (av === null && bv === null) return tieBreak(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return (av - bv) * sign;
    return tieBreak(a, b);
  });
}

function tieBreak(
  a: Pick<JobWithRelations, "id" | "created_at">,
  b: Pick<JobWithRelations, "id" | "created_at">,
): number {
  const ac = ts(a.created_at);
  const bc = ts(b.created_at);
  if (ac !== null && bc !== null && ac !== bc) return bc - ac;
  if (ac === null && bc !== null) return 1;
  if (bc === null && ac !== null) return -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
