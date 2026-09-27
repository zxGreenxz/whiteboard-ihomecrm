import type { Database } from "@/integrations/supabase/types";

type Args = Database["public"]["Functions"]["reject_contract_termination_v1"]["Args"];
type Invoker = (
  name: "reject_contract_termination_v1",
  args: Args,
) => PromiseLike<{ data: unknown; error: unknown | null }>;

export async function rejectTermination(
  invoke: Invoker,
  input: { termination_id: string; rejection_reason?: string },
): Promise<{ success: true }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.termination_id)) {
    throw new Error("Mã yêu cầu thanh lý không hợp lệ.");
  }
  const { data, error } = await invoke("reject_contract_termination_v1", {
    p_termination_id: input.termination_id,
    p_reason: input.rejection_reason,
  });
  if (error) throw error;
  if (data !== null && data !== undefined) {
    throw new Error("Không xác nhận được phản hồi từ chối thanh lý.");
  }
  return { success: true };
}
