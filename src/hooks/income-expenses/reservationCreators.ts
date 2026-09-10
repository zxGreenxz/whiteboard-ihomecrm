import { supabase } from "@/integrations/supabase/client";

export type CreatorVoucher = { user_id: string; creator_name?: string | null; system_source?: string | null };

/** Legacy settlement legs already retain the actual actor in user_id. Resolve missing names in batches. */
export async function hydrateReservationCreators<T extends CreatorVoucher>(vouchers: T[]): Promise<T[]> {
  const ids = [...new Set(vouchers.filter((v) => v.system_source?.startsWith("reservation.") && !v.creator_name?.trim()).map((v) => v.user_id))];
  if (!ids.length) return vouchers;
  const names = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await supabase.from("profiles").select("id,full_name").in("id", ids.slice(start, start + 100));
    if (error) throw new Error("Không tải được tên người xử lý cọc. Hãy thử lại.");
    for (const row of data ?? []) if (row.full_name) names.set(row.id, row.full_name);
  }
  return vouchers.map((v) => v.system_source?.startsWith("reservation.") && !v.creator_name?.trim()
    ? { ...v, creator_name: names.get(v.user_id) ?? v.creator_name } : v);
}
