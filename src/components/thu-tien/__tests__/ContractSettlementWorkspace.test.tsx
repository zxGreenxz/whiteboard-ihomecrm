// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  actorId: 'aaaaaaaa-0000-4000-8000-000000000001',
  organizationId: 'aaaaaaaa-0000-4000-8000-000000000002',
  sectionProps: null as Record<string, unknown> | null,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: state.actorId } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.organizationId }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { income_expenses: ['view'] } }) }));
vi.mock('@/lib/financeV2Route', () => ({ useFinanceV2Routes: () => ({ isSuccess: true, getOrg: () => ({ workflow: 'CANONICAL', posting: 'CANONICAL' }) }) }));
vi.mock('../ContractSettlementSection', () => ({
  ContractSettlementSection: (props: Record<string, unknown>) => {
    state.sectionProps = props;
    return <div>workbench-section</div>;
  },
}));
vi.mock('../ContractSettlementModal', () => ({ ContractSettlementModal: ({ renderCreate }: { renderCreate: (props: Record<string, unknown>) => JSX.Element }) => <div>
  settlement-modal
  {renderCreate({ sourceRef: { kind: 'reservation_refund', organizationId: state.organizationId, sourceVoucherId: 'source', settlementId: 'settlement', refundVoucherId: null }, onCreated: vi.fn(), refreshRequired: vi.fn() })}
</div> }));
vi.mock('../ContractSettlementCreateForm', () => ({ ContractSettlementCreateForm: () => <div>create-form</div> }));
vi.mock('../ReservationRefundCreateForm', () => ({ ReservationRefundCreateForm: () => <div>reservation-refund-form</div> }));
vi.mock('../ContractSettlementSaleProposalDialog', () => ({ ContractSettlementSaleProposalDialog: () => <div>sale-proposal</div> }));

import { ContractSettlementWorkspace } from '../ContractSettlementWorkspace';

afterEach(cleanup);

it('binds the selected organization, actor, exact building scope and period to the shared workbench', () => {
  const onPeriodChange = vi.fn();
  render(<ContractSettlementWorkspace period="2026-09" onPeriodChange={onPeriodChange}
    buildings={[{ id: 'b2', name: '102LVT' }, { id: 'b1', name: '417LVT' }]} />);
  expect(screen.getByText('workbench-section')).toBeTruthy();
  expect(state.sectionProps).toMatchObject({
    period: '2026-09', onPeriodChange,
    buildings: [{ id: 'b2', name: '102LVT' }, { id: 'b1', name: '417LVT' }],
    scope: {
      actorId: state.actorId,
      organizationId: state.organizationId,
      buildingIds: ['b2', 'b1'],
    },
  });
  expect((state.sectionProps!.scope as { scopeRevision: string }).scopeRevision).toContain('income_expenses');
  expect(typeof state.sectionProps!.renderDetail).toBe('function');
  const detail = (state.sectionProps!.renderDetail as (context: Record<string, unknown>) => JSX.Element)({});
  render(detail);
  expect(screen.getByText('reservation-refund-form')).toBeTruthy();
  expect(typeof state.sectionProps!.renderPaymentAction).toBe('function');
  const action = (state.sectionProps!.renderPaymentAction as (context: Record<string, unknown>) => JSX.Element)({
    onSelect: vi.fn(), refreshRequired: vi.fn(), refreshing: false, paymentsComplete: true,
  });
  render(action);
  expect(screen.getByText('sale-proposal')).toBeTruthy();
});
