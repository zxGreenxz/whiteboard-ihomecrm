import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { toast } from "sonner";
import { TaskFilters, JobWithRelations, OPEN_JOB_STATUSES } from "@/types/jobs";
import type { Database } from "@/integrations/supabase/types";

/**
 * Patch của `useUpdateJob`. Trước 11/08/2026 chỗ này là `Record<string, any>` —
 * tức MỌI tên khoá đều hợp lệ với TypeScript, kể cả tên cột không tồn tại.
 * `.update()` không lọc khoá lạ, nên một tên sai làm hỏng CẢ câu lệnh
 * (PGRST204), không phải bỏ qua một trường.
 */
type JobPatch = Database['public']['Tables']['jobs']['Update'];

/** 'YYYY-MM-DD' → ngày kế tiếp, để dựng cận trên nửa mở [start, next). */
const nextDayISO = (d: string): string => {
  const [y, m, day] = d.split("-").map((x) => parseInt(x, 10));
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

// jobs là bảng nuôi lương, tích luỹ vô hạn — không có cửa sổ mặc định thì list
// kéo trọn bảng (bị prefetchJobs kích lúc idle + realtime re-warm liên tục).
// Cửa sổ CHỈ cắt việc ĐÃ ĐÓNG: việc đang mở luôn hiện dù tạo lâu hơn cửa sổ.
// Muốn xem việc đã đóng cũ hơn: chọn "Toàn bộ lịch sử" (time_range="all") hoặc
// đặt Từ/Đến ngày.
const DEFAULT_WINDOW_DAYS = 90;

/** 'YYYY-MM-DD' theo giờ VN của n ngày trước — cận dưới cửa sổ mặc định. */
const daysAgoISO = (n: number): string => {
  const t = new Date(Date.now() + 7 * 3_600_000 - n * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

// CHỈ select cột UI thật sự đọc (TaskTable/TasksMobilePage/TaskDetail/
// TaskComplete/MyDay). Các cột audit chỉ-để-GHI (user_id, visible_to_customer,
// completion_attachments, completion_lat/lng/…, started_at, updated_at) không
// kéo về theo list. buildings cần latitude/longitude cho geo-fence khi hoàn
// thành (JobCaptureCamera); địa chỉ watermark lấy từ reverse-geocode nên không
// cần cột địa chỉ. Đổi cột ở đây nhớ sửa Job/JobBuildingRef trong types/jobs.ts.
const JOB_LIST_SELECT = `
  id, code, title, description, building_id, room_id, job_type_id, priority,
  assignee_id, assignee_name, deadline, status, attachments,
  completion_time, completion_description, created_at,
  buildings(id, name, latitude, longitude),
  rooms(id, name),
  job_types(id, name),
  profiles!jobs_assignee_id_fkey(id, full_name)
`;

// Options factory dùng chung cho hook + prefetch (src/lib/prefetchPages.ts)
// — queryKey/queryFn 1 nguồn duy nhất, prefetch lệch key là vô dụng.
export const jobsQuery = (filters?: TaskFilters) => ({
    queryKey: ["jobs", filters] as const,
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryFn: async () => {
      // Trục ngày: mặc định "ngày tạo" (giữ hành vi cũ), đổi được sang "ngày
      // hoàn thành" để đối chiếu với bảng lương — lương bucket theo
      // completion_time nên lọc theo created_at cho ra danh sách LỆCH.
      const dateCol = filters?.date_field === "completion_time" ? "completion_time" : "created_at";
      // Cửa sổ mặc định 90 ngày CHỈ áp khi user không đặt Từ/Đến ngày, không
      // chọn "Toàn bộ lịch sử", và trục là created_at — trục completion_time
      // KHÔNG áp vì phiếu đang làm có completion_time NULL, .gte sẽ giấu sạch.
      const useDefaultWindow =
        !filters?.start_date &&
        !filters?.end_date &&
        filters?.time_range !== "all" &&
        dateCol === "created_at";
      // Tính MỘT lần: fetchAllRows gọi build() nhiều lượt, mốc trôi giữa các
      // trang (qua nửa đêm) sẽ làm lệch tập kết quả khi phân trang.
      const windowFrom = `${daysAgoISO(DEFAULT_WINDOW_DAYS)}T00:00:00+07:00`;

      const build = (from: number, to: number) => {
        let query = supabase.from("jobs").select(JOB_LIST_SELECT);

        if (filters?.building_id) {
          query = query.eq("building_id", filters.building_id);
        }
        if (filters?.room_ids?.length) {
          query = query.in("room_id", filters.room_ids);
        } else if (filters?.room_id) {
          query = query.eq("room_id", filters.room_id);
        }
        if (filters?.job_type_id) {
          query = query.eq("job_type_id", filters.job_type_id);
        }
        if (filters?.priority) {
          query = query.eq("priority", filters.priority);
        }
        if (filters?.assignee_id) {
          query = query.eq("assignee_id", filters.assignee_id);
        }
        if (filters?.status) {
          query = query.eq("status", filters.status);
        }
        // Neo mốc vào +07:00. Trước đây so cột TIMESTAMPTZ với chuỗi 'YYYY-MM-DD'
        // trần → Postgres đọc là UTC midnight: .gte mất 7h đầu ngày, .lte mất 17h
        // cuối ngày (tức cả ngày làm việc cuối kỳ). Dùng .lt ngày-kế-tiếp.
        if (filters?.start_date) {
          query = query.gte(dateCol, `${filters.start_date}T00:00:00+07:00`);
        }
        if (filters?.end_date) {
          query = query.lt(dateCol, `${nextDayISO(filters.end_date)}T00:00:00+07:00`);
        }
        if (useDefaultWindow) {
          // Cửa sổ cắt việc ĐÃ ĐÓNG, KHÔNG cắt việc đang mở: .gte(created_at)
          // trần từng giấu âm thầm việc tồn đọng tạo >90 ngày khỏi trang Quản
          // lý công việc (và làm số đếm trên tab thiếu theo) — đúng nhóm cần
          // chú ý nhất. Giá trị enum không có ký tự đặc biệt nên .in.(A,B) là
          // đủ, không cần bọc nháy.
          query = query.or(
            `created_at.gte.${windowFrom},status.in.(${OPEN_JOB_STATUSES.join(",")})`,
          );
        }

        // Order ổn định + tiebreaker duy nhất — giao kèo của fetchAllRows.
        return query
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to);
      };

      // fetchAllRows phân trang tới hết: trong cửa sổ có >1000 job vẫn đủ, và
      // nhánh "Toàn bộ lịch sử" không dính cap 1000 của PostgREST (trước đây
      // vượt cap là job cũ BIẾN MẤT ÂM THẦM khỏi trang Quản lý công việc).
      const rows = await fetchAllRows<any>(build, { label: "jobs.list" });

      if (rows === null) {
        // KHÔNG nuốt lỗi: throw để vào isError + retry (trước trả [] làm hiện
        // "Chưa có việc" GIẢ khi RLS/timeout/5xx). Giống fix useInvoices.
        throw new Error("Không tải được danh sách công việc");
      }

      return rows as JobWithRelations[];
    },
  });

export const useJobs = (filters?: TaskFilters) => {
  return useQuery(jobsQuery(filters));
};

export const useCreateJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (job: any) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("jobs")
        .insert({ ...job, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating job:", error);
    },
  });
};

export const useUpdateJobStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      status,
      extraData,
    }: {
      id: string;
      status: string;
      extraData?: Record<string, any>;
    }) => {
      const { data, error } = await supabase
        .from("jobs")
        .update({ status, ...extraData })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật trạng thái");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Trạng thái đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating job status:", error);
    },
  });
};

export const useUpdateJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: JobPatch }) => {
      const { data, error } = await supabase
        .from("jobs")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating job:", error);
    },
  });
};

export const useCompleteJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      /** Mốc bấm nút chụp trên máy NV — chỉ để đối chiếu, KHÔNG tính lương. */
      completion_captured_at: string;
      completion_attachments: string[] | null;
      completion_lat?: number | null;
      completion_lng?: number | null;
      completion_distance_m?: number | null;
      completion_geofence_status?: string | null;
      completion_address?: string | null;
    }) => {
      // KHÔNG gửi `completion_time`: server đóng dấu now() qua trigger
      // `jobs_stamp_completion_time` (20260720181000). Trước đây FE gửi giá trị
      // từ một ô datetime-local gõ tay → nhân viên tự chọn được kỳ lương.
      // Ảnh ghi CẢ HAI cột: `attachments` (lịch sử) và `completion_attachments`
      // (cột mà cổng requirePhoto của ledger đọc — xem job_photo_ok).
      const { data, error } = await supabase
        .from("jobs")
        .update({
          status: "COMPLETED",
          attachments: input.completion_attachments,
          completion_attachments: input.completion_attachments,
          completion_captured_at: input.completion_captured_at,
          completion_lat: input.completion_lat ?? null,
          completion_lng: input.completion_lng ?? null,
          completion_distance_m: input.completion_distance_m ?? null,
          completion_geofence_status: input.completion_geofence_status ?? null,
          // `completion_captured_at` chưa có trong types.ts sinh tự động
          // (không regen để tránh vỡ build — xem CLAUDE.md).
          completion_address: input.completion_address ?? null,
        } as any)
        .eq("id", input.id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể hoàn thành công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Công việc đã hoàn thành");
    },
    onError: (error) => {
      console.error("Error completing job:", error);
    },
  });
};

export const useDeleteJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("jobs")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xoá công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting job:", error);
    },
  });
};

// useProfiles đã chuyển thành hook canonical useAssignablePeople
// (src/hooks/useAssignablePeople.ts) — key scope-qualify ["profiles","assignable"]
// để không nhiễm chéo cache với các query profiles khác scope. Re-export giữ
// tương thích ngược cho các call site cũ.
export { useAssignablePeople as useProfiles } from "./useAssignablePeople";
