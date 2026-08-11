import { supabase } from '@/integrations/supabase/client';
import { jsonProp } from '@/lib/jsonValue';

/**
 * Ghi "ngày công" v5 từ một công việc vừa hoàn tất.
 *
 * Trả `true` khi máy chủ thật sự chấm công lượt này (`ticked`), `false` khi
 * không — ví dụ ngày đó đã được chấm rồi. Người gọi dựa vào đó để quyết định có
 * cần làm mới bảng tổng hợp hay không.
 *
 * Không ném lỗi: chấm công là việc PHỤ của luồng hoàn tất công việc. Để nó làm
 * hỏng lượt đóng công việc thì người dùng mất thao tác chính vì một thứ bên lề.
 */
export async function v5TickFromJob(jobId: string): Promise<boolean> {
  try {
    // `supabase.rpc()` trả PostgrestBuilder — chỉ `implements PromiseLike` nên
    // KHÔNG có `.catch()` theo kiểu; `await` trong try/catch cho ngữ nghĩa y hệt
    // mà không phải bọc `Promise.resolve()`.
    const { data } = await supabase.rpc('v5_tick_from_job', { p_job_id: jobId });
    return Boolean(jsonProp(data, 'ticked'));
  } catch {
    return false;
  }
}
