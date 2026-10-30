// =============================================================================
// useSalaryJobPhotos — ảnh công việc cho cột "Ảnh" của Bảng kê lương.
// RPC salary_work_ledger chỉ trả has_photo; ảnh thật nằm ở jobs.attachments /
// jobs.completion_attachments (job_photo_ok chấp nhận cả hai cột) nên đọc riêng
// theo source_id của dòng JOB. Chỉ đọc, RLS của jobs quyết định ai thấy ảnh nào.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Giữ URL GET của PostgREST ngắn khi kỳ lương có nhiều việc.
const ID_CHUNK = 100;

function photoValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

/** Map job id → danh sách ảnh đã lưu (URL public cũ / path Storage); job không ảnh thì vắng. */
export function useSalaryJobPhotos(jobIds: readonly string[]) {
  const ids = [...new Set(jobIds)].sort();
  return useQuery({
    queryKey: ["salary-job-photos", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    meta: { label: "ảnh công việc" },
    queryFn: async () => {
      const photos = new Map<string, string[]>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await supabase
          .from("jobs")
          .select("id, attachments, completion_attachments")
          .in("id", ids.slice(i, i + ID_CHUNK));
        if (error) throw error;
        for (const row of data ?? []) {
          const urls = [...new Set([...photoValues(row.attachments), ...photoValues(row.completion_attachments)])];
          if (urls.length) photos.set(row.id, urls);
        }
      }
      return photos;
    },
  });
}
