import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { parseOrganizations } from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

export function selectOpenClawOrganization(
  organizationIds: readonly string[],
  requestedOrganizationId: string | null,
): string | null {
  if (requestedOrganizationId && organizationIds.includes(requestedOrganizationId)) {
    return requestedOrganizationId;
  }
  return organizationIds.length === 1 ? organizationIds[0] : null;
}

export function useOpenClawOrganization(requestedOrganizationId?: string | null) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlOrganizationId = requestedOrganizationId === undefined ? searchParams.get("org") : requestedOrganizationId;
  const query = useQuery({
    queryKey: openClawQueryKeys.organizations(),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("openclaw_list_my_organizations_v1");
      if (error) throw error;
      return parseOrganizations(data);
    },
  });
  const selectedOrganizationId = useMemo(
    () => selectOpenClawOrganization(query.data?.map(item => item.organizationId) ?? [], urlOrganizationId),
    [query.data, urlOrganizationId],
  );
  const selectOrganization = useCallback((organizationId: string) => {
    if (!query.data?.some(item => item.organizationId === organizationId)) {
      throw new Error("OpenClaw organization is not available to this user");
    }
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set("org", organizationId);
      return next;
    }, { replace: true });
  }, [query.data, setSearchParams]);

  return {
    ...query,
    organizations: query.data ?? [],
    selectedOrganizationId,
    selectedOrganization: query.data?.find(item => item.organizationId === selectedOrganizationId) ?? null,
    needsSelection: (query.data?.length ?? 0) > 1 && selectedOrganizationId === null,
    selectOrganization,
  };
}
