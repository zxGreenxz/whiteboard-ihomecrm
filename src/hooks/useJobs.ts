import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { TaskFilters } from "@/types/jobs";

/** 'YYYY-MM-DD' → ngày kế tiếp, để dựng cận trên nửa mở [start, next). */
const nextDayISO = (d: string): string => {
  const [y, m, day] = d.split("-").map((x) => parseInt(x, 10));
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

// Options factory dùng chung cho hook + prefetch (src/lib/prefetchPages.ts)
// — queryKey/queryFn 1 nguồn duy nhất, prefetch lệch key là vô dụng.
export const jobsQuery = (filters?: TaskFilters) => ({
    queryKey: ["jobs", filters] as const,
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select(`
          *,
          buildings(id, name, latitude, longitude, street_address, ward, district, province),
          rooms(id, name),
          job_types(id, name),
          profiles!jobs_assignee_id_fkey(id, full_name)
        `)
        .order("created_at", { ascending: false });

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
      // Trục ngày: mặc định "ngày tạo" (giữ hành vi cũ), đổi được sang "ngày
      // hoàn thành" để đối chiếu với bảng lương — lương bucket theo
      // completion_time nên lọc theo created_at cho ra danh sách LỆCH.
      const dateCol = filters?.date_field === "completion_time" ? "completion_time" : "created_at";
      // Neo mốc vào +07:00. Trước đây so cột TIMESTAMPTZ với chuỗi 'YYYY-MM-DD'
      // trần → Postgres đọc là UTC midnight: .gte mất 7h đầu ngày, .lte mất 17h
      // cuối ngày (tức cả ngày làm việc cuối kỳ). Dùng .lt ngày-kế-tiếp.
      if (filters?.start_date) {
        query = query.gte(dateCol, `${filters.start_date}T00:00:00+07:00`);
      }
      if (filters?.end_date) {
        query = query.lt(dateCol, `${nextDayISO(filters.end_date)}T00:00:00+07:00`);
      }

      const { data, error } = await query;

      if (error) {
        // KHÔNG nuốt lỗi: throw để vào isError + retry (trước trả [] làm hiện
        // "Chưa có việc" GIẢ khi RLS/timeout/5xx). Giống fix useInvoices.
        console.error("useJobs error:", error);
        throw error;
      }

      return data || [];
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
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, any> }) => {
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
