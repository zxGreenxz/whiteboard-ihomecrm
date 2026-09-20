import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useContractSettlement } from '@/hooks/useContractSettlement';
import { useContractSettlementEvents } from '@/hooks/useContractSettlementEvents';
import { findSettlementSelection } from '@/lib/contractSettlementReader';
import { settlementEventView } from '@/lib/contractSettlementEventLinks';
import type { SettlementEventScope, SettlementBusinessEvent } from '@/lib/contractSettlementEventReader';
import type { SettlementRow, SettlementSelection } from '@/lib/contractSettlement';
import { ContractSettlementPayments } from './ContractSettlementPayments';
import { ContractSettlementEvents } from './ContractSettlementEvents';

export type SettlementSectionSelection = SettlementSelection | { kind: 'event'; eventId: string };
export interface SettlementDetailContext {
  selection: SettlementSectionSelection;
  row: SettlementRow | undefined;
  event: SettlementBusinessEvent | undefined;
  rows: readonly SettlementRow[];
  paymentsComplete: boolean;
  eventsComplete: boolean;
  error: string | null;
  refreshing: boolean;
  fallbackFocusRef: RefObject<HTMLDivElement>;
  onSelect: (selection: SettlementSectionSelection) => void;
  onClose: () => void;
  /** Rejects on partial/error: an action cannot report completion before required readers settle. */
  refreshRequired: () => Promise<void>;
}
export interface ContractSettlementSectionProps {
  scope: SettlementEventScope;
  period: string;
  onPeriodChange: (period: string) => void;
  buildings: readonly { id: string; name: string }[];
  renderDetail: (context: SettlementDetailContext) => ReactNode;
}

/** Authority changes remount local state; period and realtime updates retain exact selected IDs. */
export function ContractSettlementSection(props: ContractSettlementSectionProps) {
  const { scope } = props;
  const key = JSON.stringify([scope.organizationId, scope.actorId, scope.scopeRevision, [...new Set(scope.buildingIds)].sort()]);
  return <SettlementSectionContent key={key} {...props} />;
}

function SettlementSectionContent({ scope, period, onPeriodChange, buildings, renderDetail }: ContractSettlementSectionProps) {
  const [tab, setTab] = useState<'payments' | 'events'>('payments');
  const [selection, setSelection] = useState<SettlementSectionSelection | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const fallbackFocusRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const active = !!scope.actorId && !!scope.organizationId && scope.buildingIds.length > 0;
  const payments = useContractSettlement({ ...scope, period, mode: 'all', dateBasis: 'business', filters: { period } }, null, active);
  const events = useContractSettlementEvents(scope, active);
  const paymentsComplete = payments.pagination.complete && !payments.partial && !payments.error;
  const refreshRequired = async () => {
    const results = await Promise.allSettled([payments.refresh(), events.refresh()]);
    if (results.some(result => result.status === 'rejected')) throw Error('Chưa tải lại đầy đủ khoản chi và biến động. Vui lòng thử lại.');
  };
  const refresh = () => {
    setRefreshError(null);
    void refreshRequired().catch(() => setRefreshError('Chưa tải lại đầy đủ khoản chi và biến động. Vui lòng thử lại.'));
  };
  const navigation = (panel: 'payments' | 'events') => <div className="cs-tabs" role="tablist" aria-label="Nội dung quyết toán">
    {(['payments', 'events'] as const).map(value => <button key={value} type="button" role="tab"
      id={`${id}-${panel}-${value}-tab`} aria-selected={tab === value} aria-controls={`${id}-${value}-panel`}
      tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'payments' : event.key === 'End' ? 'events' : tab === 'payments' ? 'events' : 'payments';
        setTab(next);
        requestAnimationFrame(() => document.getElementById(`${id}-${next}-${next}-tab`)?.focus());
      }}>{value === 'payments' ? 'Khoản chi' : 'Biến động'}</button>)}
  </div>;
  if (!active) return <div className="contract-settlement cs-empty" role="status">Chọn tổ chức và phạm vi tòa nhà để xem hợp đồng và quyết toán.</div>;
  return <div className="contract-settlement" ref={fallbackFocusRef} tabIndex={-1} aria-label="Hợp đồng và quyết toán">
    {refreshError && <div className="cs-warning" role="alert">{refreshError}</div>}
    <div hidden={tab !== 'payments'} role="tabpanel" id={`${id}-payments-panel`} aria-labelledby={`${id}-payments-payments-tab`}>
      <ContractSettlementPayments rows={payments.rows} period={period} buildings={buildings} complete={paymentsComplete}
        loading={payments.loading} fetching={payments.fetching} error={payments.error} navigation={navigation('payments')}
        onSelect={setSelection} onRefresh={refresh} onPeriodChange={onPeriodChange} />
    </div>
    <div hidden={tab !== 'events'} role="tabpanel" id={`${id}-events-panel`} aria-labelledby={`${id}-events-events-tab`}>
      <ContractSettlementEvents rows={events.rows.map(event => settlementEventView(event, payments.rows, paymentsComplete))}
        period={period} buildings={buildings} complete={events.complete} loading={events.loading} fetching={events.fetching}
        error={events.error} navigation={navigation('events')} onSelect={eventId => setSelection({ kind: 'event', eventId })}
        onRefresh={refresh} onPeriodChange={onPeriodChange} />
    </div>
    {selection && renderDetail({ selection, row: selection.kind === 'event' ? undefined : findSettlementSelection(payments.rows, selection),
      event: selection.kind === 'event' ? events.rows.find(event => event.id === selection.eventId) : undefined,
      rows: payments.rows, paymentsComplete, eventsComplete: events.complete, error: payments.error || events.error,
      refreshing: payments.fetching || events.fetching,
      fallbackFocusRef, onSelect: setSelection, onClose: () => setSelection(null), refreshRequired })}
  </div>;
}
