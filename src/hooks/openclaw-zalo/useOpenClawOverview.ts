import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseOverview } from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

export async function fetchOpenClawOverview(organizationId: string) {
  const { data, error } = await supabase.rpc("openclaw_get_overview_v1", {
    p_request: { version: 1, organizationId },
  });
  if (error) throw error;
  return parseOverview(data);
}

export function useOpenClawOverview(organizationId: string | null, accountId: string | null) {
  return useQuery({
    queryKey: openClawQueryKeys.overview(organizationId ?? "", accountId ?? ""),
    enabled: Boolean(organizationId && accountId),
    staleTime: 10_000,
    queryFn: () => fetchOpenClawOverview(organizationId!),
  });
}
