import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseBootstrap } from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

export async function fetchOpenClawBootstrap(organizationId: string) {
  const { data, error } = await supabase.rpc("openclaw_get_bootstrap_v1", {
    p_request: { version: 1, organizationId },
  });
  if (error) throw error;
  return parseBootstrap(data);
}

export function useOpenClawBootstrap(organizationId: string | null, accountId?: string | null) {
  return useQuery({
    queryKey: openClawQueryKeys.bootstrap(organizationId, accountId),
    enabled: Boolean(organizationId),
    staleTime: 15_000,
    queryFn: () => fetchOpenClawBootstrap(organizationId!),
  });
}
