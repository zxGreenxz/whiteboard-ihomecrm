import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useIncomeExpenseActions } from '@/hooks/income-expenses/useIncomeExpenseActions';
import { useIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { useContractSettlementFinancialFacts, type SettlementFinancialTarget } from '@/hooks/useContractSettlementFinancialFacts';
import { IncomeExpenseActionButtons } from '@/components/income-expenses/IncomeExpenseActionButtons';
import { IncomeExpenseActionDialogs } from '@/components/income-expenses/IncomeExpenseActionDialogs';
import { SettlementFinancialNote } from '@/components/income-expenses/SettlementFinancialNote';
import { VoucherSupplementNotes } from '@/components/income-expenses/VoucherNote';
import VoucherHistoryDialog from '@/components/income-expenses/VoucherHistoryDialog';
import { StorageImage } from '@/components/ui/storage-image';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { getSettlementDisplayState, type SettlementRow, type SettlementSourceRef, type SettlementSourceRow, type SettlementVoucherRow, type VoucherSnapshot } from '@/lib/contractSettlement';
import { buildSettlementEventLinks } from '@/lib/contractSettlementEventLinks';
import { settlementSourceIdentity } from '@/lib/contractSettlementReader';
import type { SettlementBusinessEvent } from '@/lib/contractSettlementEventReader';
import { formatVND } from '@/lib/utils';
import type { SettlementDetailContext } from './ContractSettlementSection';
import { ContractSettlementModalLayout } from './ContractSettlementModalLayout';
import { ContractSettlementTimeline } from './ContractSettlementTimeline';
import { ContractSettlementTimelineView } from './ContractSettlementTimelineView';
import { useReservationRefundSource } from '@/hooks/useReservationRefundSource';
import type { ReservationRefundSourceRef } from '@/lib/reservationRefundWorkflow';

export interface SettlementCreateFormProps {
  sourceRef: SettlementSourceRef;
  onCreated: (result: { outcome: 'created' | 'existing'; voucherId: string }) => void;
  refreshRequired: () => Promise<void>;
  onBusyChange?: (blocked: boolean) => void;
}
interface Props {
  context: SettlementDetailContext;
  renderCreate: (props: SettlementCreateFormProps) => ReactNode;
  onEditVoucher?: (voucherId: string) => void;
  onBusyChange?: (blocked: boolean) => void;
}
const names = { commission: 'Hoa hồng', refund: 'Hoàn khách', bonus: 'Thưởng sale' };
const eventNames = { sign: 'Ký mới', renew: 'Gia hạn', terminate: 'Thanh lý', forfeit: 'Bỏ cọc', reserve: 'Giữ chỗ' };
const day = (value: string | null) => value ? value.slice(0, 10).split('-').reverse().join('/') : 'Chưa xác minh ngày';
function sourceFields(source: SettlementSourceRef | null) {
  return { terminationId: source?.kind === 'termination_refund' ? source.terminationId : null,
    sourceReceiptId: source?.kind === 'sale_deposit' ? source.depositVoucherId : source?.kind === 'reservation_refund' ? source.sourceVoucherId : null };
}
function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="cs-block"><h3 className="cs-block-title">{title}</h3><div className="cs-block-content">{children}</div></section>;
}
function ReservationRefundSummary({ sourceRef }: { sourceRef: ReservationRefundSourceRef }) {
  const source = useReservationRefundSource(sourceRef);
  if (source.isPending) return <p role="status">Đang đối chiếu quyết toán giữ chỗ…</p>;
  if (source.isError || !source.data) return <p role="alert">Chưa đọc được quyết toán giữ chỗ. Vui lòng tải lại hồ sơ.</p>;
  const s = source.data;
  return <section aria-label="Đối chiếu hoàn giữ chỗ" className="rounded-lg border p-3 space-y-1">
    <div className="flex justify-between gap-3"><span>Cọc thực nhận</span><strong>{formatVND(s.depositAmount)}</strong></div>
    <div className="flex justify-between gap-3"><span>Giữ lại / khấu trừ</span><strong>{formatVND(s.retainedAmount)}</strong></div>
    <div className="flex justify-between gap-3"><span>Nghĩa vụ hoàn</span><strong>{formatVND(s.refundAmount)}</strong></div>
    <div className="flex justify-between gap-3"><span>Đã hoàn</span><strong>{formatVND(s.paid)}</strong></div>
    <div className="flex justify-between gap-3 border-t pt-2 text-emerald-800"><span>Còn phải hoàn</span><strong>{formatVND(s.remaining)}</strong></div>
  </section>;
}
function FinancialBody({ target, source }: { target: SettlementFinancialTarget; source?: SettlementSourceRef | null }) {
  const facts = useContractSettlementFinancialFacts(target);
  return <Block title="Đối chiếu hợp đồng & dòng tiền">
    {facts.isPending ? <p role="status">Đang đối chiếu số liệu…</p> : facts.isError ? <p role="alert">Chưa đọc được thông tin đối chiếu. Vui lòng tải lại hồ sơ.</p>
      : facts.data ? <SettlementFinancialNote context={facts.data} /> : <p>Chưa có số liệu đã xác minh cho nguồn này.</p>}
    {source?.kind === 'reservation_refund' && <ReservationRefundSummary sourceRef={source} />}
  </Block>;
}
function ReservationRefundTimeline({ sourceRef }: { sourceRef: ReservationRefundSourceRef }) {
  const source = useReservationRefundSource(sourceRef);
  const s = source.data;
  return <ContractSettlementTimelineView
    lanes={s ? [{
      id: s.settlementId,
      role: 'reservation',
      code: s.sourceCode ?? 'Phiếu giữ chỗ',
      customer: s.payerName ?? 'Chưa có tên khách',
      status: s.remaining === 0 ? 'Đã hoàn đủ' : s.existingVoucherId ? 'Đã lập phiếu hoàn' : 'Chờ lập phiếu hoàn',
      steps: [
        { label: 'Giữ chỗ', value: day(s.sourceDate), detail: s.sourceCode ?? 'Phiếu cọc gốc' },
        { label: 'Cọc thực nhận', value: formatVND(s.depositAmount), detail: `Giữ lại / khấu trừ: ${formatVND(s.retainedAmount)}` },
        { label: 'Quyết toán giữ chỗ', value: day(s.settlementDate), detail: `Nghĩa vụ hoàn: ${formatVND(s.refundAmount)}` },
        { label: 'Hoàn khách', value: formatVND(s.paid), detail: `Còn phải hoàn: ${formatVND(s.remaining)}` },
      ],
    }] : []}
    hint="Giữ chỗ → quyết toán → hoàn khách"
    loading={source.isPending}
    error={source.isError || !source.enabled ? 'Chưa đọc được vòng đời hoàn giữ chỗ trong phạm vi hiện tại.' : null}
    onRetry={() => { void source.refetch(); }}
  />;
}
function Timeline({ target, context, source }: { target: SettlementFinancialTarget; context: SettlementDetailContext; source?: SettlementSourceRef | null }) {
  return target.contractId && target.roomId ? <ContractSettlementTimeline target={{ ...target, contractId: target.contractId, roomId: target.roomId }} events={context.events} eventsComplete={context.eventsComplete} />
    : source?.kind === 'reservation_refund' ? <ReservationRefundTimeline sourceRef={source} />
    : <p className="cs-secondary">Nguồn giữ chỗ chưa gắn hợp đồng. Đối chiếu theo phiếu cọc gốc; hợp đồng khác của phòng không thay thế nguồn này.</p>;
}
function Recipient({ name, bank, account }: { name: string | null; bank: string | null; account: string | null }) {
  return <Block title="Người nhận tiền"><dl className="cs-detail-fields"><dt>Người nhận</dt><dd>{name || 'Chưa có thông tin'}</dd><dt>Ngân hàng</dt><dd>{bank || 'Chưa có thông tin'}</dd><dt>Số tài khoản</dt><dd className="cs-mono">{account || 'Chưa có thông tin'}</dd></dl></Block>;
}
function Unavailable({ context }: { context: SettlementDetailContext }) {
  const [failed, setFailed] = useState(false);
  const identity = context.selection.kind === 'voucher' ? context.selection.voucherId : context.selection.kind === 'event' ? context.selection.eventId : settlementSourceIdentity(context.selection.sourceRef);
  return <ContractSettlementModalLayout open onClose={context.onClose} fallbackFocusRef={context.fallbackFocusRef}
    kindLabel="Hồ sơ quyết toán" roomLabel="Chưa xác minh phòng" codeLine={identity} subjectLabel={`Đang xem hồ sơ ${identity}`}
    metadata="Hồ sơ chưa sẵn sàng" timeline={null} aside={<button className="cs-button" onClick={() => { setFailed(false); void context.refreshRequired().catch(() => setFailed(true)); }}>Tải lại hồ sơ</button>}>
    <p role="alert">Không đọc được hồ sơ đang chọn. Hồ sơ có thể đã thay đổi hoặc nằm ngoài phạm vi được xem.</p>
    {failed && <p role="alert">Chưa tải lại được hồ sơ. Vui lòng thử lại.</p>}
  </ContractSettlementModalLayout>;
}

/** Hooks mount only for a verified selected identity; no current-room or first-row fallback. */
export function ContractSettlementModal(props: Props) {
  const selection = props.context.selection;
  const identity = selection.kind === 'voucher' ? `voucher:${selection.voucherId}` : selection.kind === 'event' ? `event:${selection.eventId}` : settlementSourceIdentity(selection.sourceRef);
  return <SelectedModal key={identity} {...props} />;
}
function SelectedModal(props: Props) {
  const [blocked, setBlocked] = useState(false);
  const notifyBusy = props.onBusyChange;
  const onBusyChange = useCallback((next: boolean) => {
    setBlocked(next);
    notifyBusy?.(next);
  }, [notifyBusy]);
  const retained = useRef<SettlementRow | undefined>(undefined);
  const { context } = props;
  if (context.selection.kind === 'event') return context.event ? <EventDetail key={context.event.id} context={context} event={context.event} /> : <Unavailable context={context} />;
  const current = context.row;
  if (!blocked && (current?.rowType === 'source' || current?.rowType === 'voucher' && current.snapshot.state === 'ready')) retained.current = current;
  const row = blocked ? retained.current : current;
  if (!row) return <Unavailable context={context} />;
  if (row.rowType === 'source') return <SourceDetail key={row.rowKey} {...props} onBusyChange={onBusyChange} row={row} />;
  if (row.snapshot.state !== 'ready') return <Unavailable context={context} />;
  return <VoucherDetail key={row.voucherId} {...props} onBusyChange={onBusyChange} row={row} snapshot={row.snapshot.value} />;
}
function SourceDetail({ context, row, renderCreate, onBusyChange }: Props & { row: SettlementSourceRow }) {
  const [blocked, setBlocked] = useState(false);
  const target: SettlementFinancialTarget = { roomId: row.roomId, contractId: row.contractId, ...sourceFields(row.sourceRef) };
  return <ContractSettlementModalLayout open onClose={context.onClose} dismissalBlocked={blocked} fallbackFocusRef={context.fallbackFocusRef}
    kindLabel={names[row.settlementKind]} roomLabel={row.roomName ?? 'Chưa xác minh phòng'} codeLine={row.contractNumber ?? 'Nguồn chưa có hợp đồng'}
    subjectLabel={`Đang xử lý nguồn ${row.contractNumber ?? row.rowKey} · Chưa lập phiếu`} metadata={<><span>{row.customerName ?? 'Chưa có tên khách'}</span><span>{day(row.eventDate)}</span><span className="cs-badge">Chưa lập phiếu</span></>}
    amountSummary={<><small>Căn cứ đề xuất</small><div className="cs-mono">{row.basis.amount === null ? 'Chưa xác minh' : formatVND(row.basis.amount)}</div></>}
    timeline={<Timeline target={target} context={context} source={row.sourceRef} />} aside={<div className="cs-detail-stack">
      <Recipient name={row.recipient.name} bank={row.recipient.bankName} account={row.recipient.bankAccount} />
      <Block title="Lập phiếu chờ duyệt"><fieldset disabled={context.refreshing || !context.paymentsComplete}>
        {renderCreate({ sourceRef: row.sourceRef, refreshRequired: context.refreshRequired, onBusyChange: next => { setBlocked(next); onBusyChange?.(next); },
          onCreated: result => context.onSelect({ kind: 'voucher', voucherId: result.voucherId }) })}
      </fieldset></Block>
    </div>}>
    <div className="cs-detail-stack"><FinancialBody target={target} source={row.sourceRef} />{row.basis.warning && <Block title="Lưu ý cần rà soát"><p>{row.basis.warning}</p></Block>}</div>
  </ContractSettlementModalLayout>;
}
function VoucherDetail({ context, row, snapshot: v, onEditVoucher, onBusyChange }: Props & { row: SettlementVoucherRow; snapshot: VoucherSnapshot }) {
  const { data: actor } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const actions = useIncomeExpenseActions({ scope: { actorId: actor?.id ?? '', organizationId: selectedOrganizationId ?? '' }, voucherIds: [v.id], onEdit: onEditVoucher, refreshRequired: context.refreshRequired, canonicalOnly: true });
  const sessionBlocked = actions.dismissalBlocked || actions.selected !== null;
  useEffect(() => { onBusyChange?.(sessionBlocked); }, [sessionBlocked, onBusyChange]);
  const supplements = useIncomeExpenseSupplements(v.id);
  const [history, setHistory] = useState(false);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const source = row.sourceLink.state === 'verified' ? row.sourceLink.sourceRef : null;
  const target: SettlementFinancialTarget = { roomId: v.roomId, contractId: v.contractId, voucherId: v.id, ...sourceFields(source) };
  const verifiedSupplements = supplements.isError ? [] : supplements.data ?? [];
  const attachments = [...new Set([...v.attachments, ...verifiedSupplements.flatMap(s => s.attachments)])];
  const display = getSettlementDisplayState(row);
  return <>
    <ContractSettlementModalLayout open onClose={context.onClose} dismissalBlocked={sessionBlocked} fallbackFocusRef={context.fallbackFocusRef}
      kindLabel={names[row.settlementKind]} roomLabel={v.roomName ?? 'Chưa xác minh phòng'} codeLine={`${v.code} · ${v.contractNumber ?? 'Nguồn chưa có hợp đồng'}`}
      subjectLabel={`Đang xử lý phiếu ${v.code} · ${v.contractNumber ?? 'Nguồn giữ chỗ'}`} metadata={<><span>{v.customerName ?? 'Chưa có tên khách'}</span><span>{day(v.voucherDate)}</span><span className="cs-badge">{display.label}</span></>}
      amountSummary={<><small>Số trên phiếu</small><div className="cs-mono">{formatVND(v.totalAmount)}</div></>}
      timeline={<Timeline target={target} context={context} source={source} />} aside={<div className="cs-detail-stack">
        <Recipient name={v.payerName} bank={v.receiveBankName} account={v.receiveBankAccount} />
        <Block title="Xử lý phiếu">{context.refreshing && <p role="status">Đang cập nhật điều kiện xử lý…</p>}
          <IncomeExpenseActionButtons controller={actions} id={v.id} layout="labeled" disabled={sessionBlocked || context.refreshing || !context.paymentsComplete} />
          {v.reviewReason && <p className="cs-secondary">Lý do rà soát: {v.reviewReason}</p>}
        </Block>
        <button className="cs-button" onClick={() => setHistory(true)}>Lịch sử phiếu</button>
      </div>}>
      <div className="cs-detail-stack"><FinancialBody target={target} source={source} />
        <Block title="Ghi chú gốc của phiếu"><p className="cs-note">{v.notes || 'Chưa có ghi chú.'}</p></Block>
        <Block title="Chứng từ & bổ sung">
          {supplements.isError ? <p role="alert">Chưa tải được ghi chú và chứng từ bổ sung.</p> : <VoucherSupplementNotes supplements={verifiedSupplements} />}
          <div className="cs-detail-attachments">{attachments.map((url, index) => <button key={url} type="button" onClick={() => setImageIndex(index)} aria-label={`Xem chứng từ ${index + 1}`}><StorageImage value={url} alt={`Chứng từ ${index + 1}`} /></button>)}</div>
          {supplements.isPending && <p role="status" className="cs-secondary">Đang tải ghi chú và chứng từ bổ sung…</p>}
          {attachments.length === 0 && !supplements.isError && !supplements.isPending && <p className="cs-secondary">Chưa có chứng từ đính kèm.</p>}
        </Block>
      </div>
    </ContractSettlementModalLayout>
    <IncomeExpenseActionDialogs controller={actions} />
    <VoucherHistoryDialog open={history} onOpenChange={setHistory} voucher={{ id: v.id, code: v.code, total_amount: v.totalAmount, approval_status: v.approvalStatus }} />
    <AttachmentLightbox attachments={attachments} index={imageIndex} onIndexChange={setImageIndex} />
  </>;
}
function EventDetail({ context, event }: { context: SettlementDetailContext; event: SettlementBusinessEvent }) {
  const target: SettlementFinancialTarget = { roomId: event.roomId, contractId: event.contractId, terminationId: event.sourceKind === 'termination' ? event.sourceId : null, sourceReceiptId: event.sourceVoucherId };
  const links = buildSettlementEventLinks(event, context.rows, context.paymentsComplete);
  return <ContractSettlementModalLayout open onClose={context.onClose} fallbackFocusRef={context.fallbackFocusRef}
    kindLabel={eventNames[event.type]} roomLabel={event.roomName ?? 'Chưa xác minh phòng'} codeLine={event.sourceCode}
    subjectLabel={`Đang xem biến động ${event.sourceCode} · ${day(event.businessDate)}`} metadata={<span>{event.customerName ?? 'Chưa có tên khách'}</span>}
    timeline={<Timeline target={target} context={context} />} aside={<Block title="Khoản chi liên quan">
      {!links.complete && <p role="alert">Chưa đọc đủ khoản chi liên kết.</p>}
      {links.values.map(link => <button key={link.id} type="button" className="cs-linked-payment" onClick={() => context.onSelect(link.selection)}><strong>{link.label}</strong><span>{link.amountLabel} · {link.statusLabel}</span></button>)}
      {links.complete && links.values.length === 0 && <p>Không có khoản chi liên quan trong phạm vi được xem.</p>}
    </Block>}>
    <div className="cs-detail-stack"><FinancialBody target={target} /><Block title="Nội dung biến động"><p>{event.description}</p><p className="cs-note">{event.notes || 'Chưa có ghi chú.'}</p></Block></div>
  </ContractSettlementModalLayout>;
}
