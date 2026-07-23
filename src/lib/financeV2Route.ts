// Finance V2 — client feature-route gate (plan §9.6 truth table, §12/§15 compatibility).
//
// UI Thu Chi V2 là MODE-AWARE: mọi hành vi mới (badge composite, posting dialog, RPC v2)
// chỉ bật khi route hiệu lực của org là CANONICAL; ngược lại giữ nguyên hành vi LEGACY
// hiện tại. Nguồn route là RPC read-only `get_finance_v2_client_flags_v1` (Stage-11b).
//
// NGUYÊN TẮC FAIL-SAFE:
//   - RPC chưa tồn tại (schema V2 chưa forward-apply, PostgREST PGRST202) → LEGACY.
//     Đây là tín hiệu "schema-absent" CÓ CHỦ ĐÍCH, không phải fallback quyền (khác 42501).
//   - Mọi lỗi khác → LEGACY + console.warn (không bao giờ đoán CANONICAL).
//   - FROZEN → UI coi như CANONICAL về HIỂN THỊ nhưng mọi action write phải disable
//     (emergency stop); helper `canWrite` phản ánh điều đó.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type FinanceRoute = "LEGACY" | "SHADOW" | "CANONICAL" | "FROZEN";

export interface FinanceV2OrgRoutes {
  readSemantics: FinanceRoute;
  workflow: FinanceRoute;
  posting: FinanceRoute;
  access: FinanceRoute;
}

export const LEGACY_ROUTES: FinanceV2OrgRoutes = Object.freeze({
  readSemantics: "LEGACY",
  workflow: "LEGACY",
  posting: "LEGACY",
  access: "LEGACY",
});

interface ClientFlagsRow {
  organization_id: string;
  read_semantics_route: string;
  workflow_route: string;
  posting_route: string;
  access_route: string;
}

function asRoute(value: string | null | undefined): FinanceRoute {
  return value === "SHADOW" || value === "CANONICAL" || value === "FROZEN"
    ? value
    : "LEGACY";
}

/** Fetch effective routes per org. Absent function / any error ⇒ empty map (LEGACY). */
export async function fetchFinanceV2ClientFlags(): Promise<Map<string, FinanceV2OrgRoutes>> {
  const map = new Map<string, FinanceV2OrgRoutes>();
  // RPC chưa có trong generated types cho tới lần regen sau forward-apply — cast có chủ đích.
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
  ) => PromiseLike<{ data: ClientFlagsRow[] | null; error: { code?: string; message?: string } | null }>)(
    "get_finance_v2_client_flags_v1",
  );
  if (error) {
    // PGRST202 = function not found = schema V2 chưa apply → LEGACY im lặng.
    if (error.code !== "PGRST202") {
      console.warn("[financeV2Route] flags RPC error — falling back to LEGACY:", error.message);
    }
    return map;
  }
  for (const row of data ?? []) {
    map.set(row.organization_id, {
      readSemantics: asRoute(row.read_semantics_route),
      workflow: asRoute(row.workflow_route),
      posting: asRoute(row.posting_route),
      access: asRoute(row.access_route),
    });
  }
  return map;
}

/** React-query hook: route map theo org, mặc định LEGACY. */
export function useFinanceV2Routes() {
  const query = useQuery({
    queryKey: ["finance-v2-routes"],
    queryFn: fetchFinanceV2ClientFlags,
    staleTime: 60_000,
    retry: false,
  });
  const routes = query.data ?? new Map<string, FinanceV2OrgRoutes>();
  return {
    ...query,
    routes,
    /** Route của một org; org lạ/chưa tải ⇒ LEGACY. */
    getOrg(organizationId: string | null | undefined): FinanceV2OrgRoutes {
      return (organizationId && routes.get(organizationId)) || LEGACY_ROUTES;
    },
  };
}

/** UI đọc theo model V2 (badge composite, balance posting-based)? */
export const isCanonicalRead = (r: FinanceV2OrgRoutes): boolean =>
  r.readSemantics === "CANONICAL" || r.readSemantics === "FROZEN";

/** Action write V2 (approve/post qua RPC v2) được phép? FROZEN = emergency stop. */
export const canWriteWorkflow = (r: FinanceV2OrgRoutes): boolean =>
  r.workflow === "CANONICAL";

export const canWritePosting = (r: FinanceV2OrgRoutes): boolean =>
  r.posting === "CANONICAL";

export const isCanonicalAccess = (r: FinanceV2OrgRoutes): boolean =>
  r.access === "CANONICAL";
