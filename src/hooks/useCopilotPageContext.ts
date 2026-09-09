import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useOrganization } from '@/contexts/OrganizationContext';
import { copilotPageByRoute } from '@/app/capabilities/registry';
import { locDangAp } from '@/copilot/banDoHeThong';
import { isContextEntityId, publishActivePageContext } from '@/copilot/activePageContext';

/** Publish the effective query/client filters, never the persisted drafts.
 * Entity objects must carry their data's organization, not just the UI scope.
 * Missing scope or a stale row after organization switch is deliberately omitted.
 */
export function useCopilotPageContext(
  pageKey: string,
  filters: object,
  entity?: { id: string; organization_id?: string | null } | null,
): void {
  const location = useLocation();
  const { selectedOrganizationId } = useOrganization();
  const context = locDangAp(filters);
  const entityId = entity?.organization_id === selectedOrganizationId && isContextEntityId(entity?.id)
    ? entity.id : undefined;
  // Serialize the small, sanitized projection: fresh filter objects with the same
  // values need not republish; private search text never enters this snapshot.
  const serialized = JSON.stringify({ ...context, entityId });
  useLayoutEffect(() => {
    if (!selectedOrganizationId || copilotPageByRoute(location.pathname)?.key !== pageKey) return;
    return publishActivePageContext({ ...location, organizationId: selectedOrganizationId }, JSON.parse(serialized));
  }, [location.pathname, location.search, location.key, pageKey, selectedOrganizationId, serialized]);
}
