import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { ContractSettlementCreateForm } from './ContractSettlementCreateForm';
import { ContractSettlementModal } from './ContractSettlementModal';
import { ContractSettlementSection } from './ContractSettlementSection';

interface Props {
  period: string;
  onPeriodChange: (period: string) => void;
  buildings: readonly { id: string; name: string }[];
}

/** Binds the wide settlement workbench to the same live auth and building scope as Thanh toán. */
export function ContractSettlementWorkspace({ period, onPeriodChange, buildings }: Props) {
  const { data: actor } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const buildingIds = useMemo(() => buildings.map(building => building.id), [buildings]);
  const scopeRevision = useMemo(() => JSON.stringify(permissions ?? null), [permissions]);

  return <ContractSettlementSection
    period={period}
    onPeriodChange={onPeriodChange}
    buildings={buildings}
    scope={{
      actorId: actor?.id ?? '',
      organizationId: selectedOrganizationId ?? '',
      buildingIds,
      scopeRevision,
    }}
    renderDetail={context => <ContractSettlementModal context={context}
      renderCreate={props => <ContractSettlementCreateForm {...props} />} />}
  />;
}

export default ContractSettlementWorkspace;
