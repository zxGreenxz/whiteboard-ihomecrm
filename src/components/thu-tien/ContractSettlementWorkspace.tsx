import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { ContractSettlementCreateForm } from './ContractSettlementCreateForm';
import { ContractSettlementModal } from './ContractSettlementModal';
import { ContractSettlementSaleProposalDialog } from './ContractSettlementSaleProposalDialog';
import { ContractSettlementSection } from './ContractSettlementSection';
import { ReservationRefundCreateForm } from './ReservationRefundCreateForm';
import { useFinanceV2Routes } from '@/lib/financeV2Route';

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
  const financeRoutes = useFinanceV2Routes();
  const buildingIds = useMemo(() => buildings.map(building => building.id), [buildings]);
  const scopeRevision = useMemo(() => JSON.stringify(permissions ?? null), [permissions]);
  const route = financeRoutes.getOrg(selectedOrganizationId);
  const canonicalReady = financeRoutes.isSuccess && route.workflow === 'CANONICAL' && route.posting === 'CANONICAL';

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
    renderPaymentAction={context => <ContractSettlementSaleProposalDialog
      organizationId={selectedOrganizationId ?? ''}
      disabled={!canonicalReady || context.refreshing || !context.paymentsComplete}
      refreshRequired={context.refreshRequired}
      onSelect={context.onSelect}
    />}
    renderDetail={context => <ContractSettlementModal context={context}
      renderCreate={props => <div aria-disabled={!canonicalReady}>
        {!canonicalReady && <p role="alert">Khu Hợp đồng & quyết toán cần quy trình thu chi chuẩn trước khi lập phiếu.</p>}
        {props.sourceRef.kind === 'reservation_refund'
          ? <ReservationRefundCreateForm {...props} sourceRef={props.sourceRef} creationDisabled={!canonicalReady} />
          : <ContractSettlementCreateForm {...props} creationDisabled={!canonicalReady} />}
      </div>} />}
  />;
}

export default ContractSettlementWorkspace;
