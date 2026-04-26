/**
 * Helpers for the staff/multi-tenant data model.
 *
 * Rule of thumb:
 *  - Read queries should NOT filter by `user_id = auth.uid()`. Let RLS
 *    decide what's visible. RLS allows the current user to see rows
 *    where `user_id IN (their own uid + every employer they're assigned
 *    to via staff_assignments)`.
 *
 *  - Writes that need to set `user_id` (creating a new building, contract,
 *    etc.) must use `getEffectiveOwnerId(uid)` so staff-created rows are
 *    owned by the staff member's *employer* — keeping data co-tenant.
 */
import { supabase } from "@/integrations/supabase/client";

let _cache: { uid: string; ownerId: string; visibleOwners: string[] } | null = null;

/** Returns the user_id to set on new rows the current user creates.
 *  - Owners (no staff_assignments where they are staff_id) → their own uid
 *  - Staff → their first employer's uid */
export async function getEffectiveOwnerId(currentUid: string): Promise<string> {
  if (_cache && _cache.uid === currentUid) return _cache.ownerId;
  const { data } = await supabase
    .from("staff_assignments")
    .select("user_id")
    .eq("staff_id", currentUid)
    .limit(1)
    .maybeSingle();
  const ownerId = data?.user_id || currentUid;
  _cache = { uid: currentUid, ownerId, visibleOwners: _cache?.visibleOwners || [currentUid] };
  return ownerId;
}

/** Returns all owner ids the current user can see data for: themselves
 *  + every distinct employer in their staff_assignments. */
export async function getVisibleOwnerIds(currentUid: string): Promise<string[]> {
  if (_cache && _cache.uid === currentUid) return _cache.visibleOwners;
  const { data } = await supabase
    .from("staff_assignments")
    .select("user_id")
    .eq("staff_id", currentUid);
  const ids = new Set<string>([currentUid]);
  for (const r of data || []) ids.add((r as any).user_id);
  const arr = Array.from(ids);
  _cache = { uid: currentUid, ownerId: _cache?.ownerId || currentUid, visibleOwners: arr };
  return arr;
}

/** Clear the cache when login state changes (call on auth state change). */
export function clearEffectiveOwnerCache() {
  _cache = null;
}
