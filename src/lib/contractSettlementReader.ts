import { calculateSettlementTotals, filterSettlementRows, getSettlementDisplayState, parseSettlementRow, type SettlementFilters, type SettlementRow, type SettlementTotals, type SettlementSourceRef, type SettlementSelection } from './contractSettlement';
export type SettlementReadScope = { organizationId: string; actorId: string; scopeRevision: string; buildingIds: string[]; period: string; mode: 'all' | 'period' | 'backlog'; dateBasis: 'business' | 'posting'; filters: SettlementFilters };
export type SettlementPage = { rows: SettlementRow[]; nextCursor: string | null; revision: string; asOf: string };
export type SettlementReadResult = { rows: SettlementRow[]; totals: SettlementTotals | null; partial: boolean; error: string | null; revision: string | null; asOf: string | null; pagination: { complete: boolean; pages: number; nextCursor: string | null }; capabilities: { automaticSaleCandidates: false } };
export type SettlementPageReader = (scope: SettlementReadScope, cursor: string | null, revision: string | null) => Promise<unknown>;
export const settlementQueryKey = (scope: SettlementReadScope) => ['contract-settlement', scope.organizationId, scope.actorId, scope.scopeRevision, [...new Set(scope.buildingIds)].sort(), scope.period, scope.mode, scope.dateBasis, scope.filters] as const;
export type SettlementPostingDate = { state: 'known_paid'; postedOn: string } | { state: 'known_none' } | { state: 'unverified' };
/** Shared reader/UI predicate: an inactive header alone never proves absence of cash. */
export function classifySettlementPostingDate(row: SettlementRow): SettlementPostingDate {
 if (row.rowType === 'source') return { state: 'known_none' };
 if (row.snapshot.state !== 'ready') return { state: 'unverified' };
 const snapshot = row.snapshot.value;
 const display = getSettlementDisplayState(row).code;
 if (display === 'PAID' && snapshot.postedOn !== null) return { state: 'known_paid', postedOn: snapshot.postedOn };
 const evidence = snapshot.postingEvidence;
 const verifiedNoCash = snapshot.activePostingId === null && snapshot.effectiveNetPaid === 0 && snapshot.postedOn === null
  && evidence.state === 'ready' && evidence.value.activePostingId === null && evidence.value.effectiveNetPaid === 0 && evidence.value.postedOn === null;
 if (!verifiedNoCash) return { state: 'unverified' };
 if (snapshot.postingMode === 'NON_CASH' && snapshot.postingStatus === 'NOT_APPLICABLE') return { state: 'known_none' };
 if (snapshot.postingMode === 'CASHBOOK' && snapshot.postingStatus === 'UNPOSTED' && snapshot.approvalStatus === 'UNAPPROVED'
  && ['PENDING_APPROVAL', 'NEEDS_REVIEW'].includes(display)) return { state: 'known_none' };
 // An approved gap or a REVERSED header needs provenance for the missing cash
 // or the complete reversal chain. Zero ledger facts alone do not prove either.
 return { state: 'unverified' };
}
export function settlementSourceIdentity(source: SettlementSourceRef): string {
 const id = source.kind === 'broker' || source.kind === 'sale_contract' ? source.contractId : source.kind === 'termination_refund' ? source.terminationId : source.kind === 'reservation_refund' ? source.sourceVoucherId : source.depositVoucherId;
 return `${source.kind}:${source.organizationId}:${id}`;
}
export function findSettlementSelection(rows: readonly SettlementRow[], selection: SettlementSelection | null): SettlementRow | undefined {
 if (!selection) return undefined;
 if (selection.kind === 'voucher') return rows.find(row => row.rowType === 'voucher' && row.voucherId === selection.voucherId);
 const matches = rows.filter(row => {
  const ref = row.rowType === 'source' ? row.sourceRef : row.sourceLink.state === 'verified' ? row.sourceLink.sourceRef : null;
  return ref !== null && settlementSourceIdentity(ref) === settlementSourceIdentity(selection.sourceRef);
 });
 // A source can own several historical vouchers; never silently select the first.
 return matches.length === 1 ? matches[0] : undefined;
}
export function parseSettlementPage(input: unknown): SettlementPage {
 if (!input || typeof input !== 'object') throw Error('INVALID_READER_RESPONSE');
 const page = input as Record<string, unknown>;
 if (!Array.isArray(page.rows) || typeof page.revision !== 'string' || !page.revision || typeof page.asOf !== 'string' || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw Error('INVALID_READER_RESPONSE');
 return { rows: page.rows.map(parseSettlementRow), nextCursor: page.nextCursor as string | null, revision: page.revision, asOf: page.asOf };
}
export async function readContractSettlement(scope: SettlementReadScope, readPage: SettlementPageReader, signal?: AbortSignal): Promise<SettlementReadResult> {
 const collected: SettlementRow[] = []; const keys = new Set<string>(); let cursor: string | null = null; let revision: string | null = null; let asOf: string | null = null; let pages = 0; let error: string | null = null;
 try {
  do {
   signal?.throwIfAborted(); const page = parseSettlementPage(await readPage(scope, cursor, revision)); signal?.throwIfAborted();
   if (revision !== null && page.revision !== revision) throw Error('SETTLEMENT_CHANGED_RELOAD');
   revision = page.revision; asOf ??= page.asOf;
   for (const row of page.rows) {
    if (keys.has(row.rowKey) || (cursor !== null && row.rowKey <= cursor)) throw Error('SETTLEMENT_PAGE_OVERLAP');
    const org = row.rowType === 'source' ? row.organizationId : row.snapshot.state === 'ready' ? row.snapshot.value.organizationId : row.sourceLink.state === 'verified' ? row.sourceLink.sourceRef.organizationId : null;
    const building = row.rowType === 'source' ? row.buildingId : row.snapshot.state === 'ready' ? row.snapshot.value.buildingId : null;
    if ((org !== null && org !== scope.organizationId) || (building !== null && !scope.buildingIds.includes(building))) throw Error('SETTLEMENT_SCOPE_MISMATCH');
    keys.add(row.rowKey); collected.push(row);
   }
   pages++;
   if (page.nextCursor !== null && (page.rows.length === 0 || page.nextCursor !== page.rows.at(-1)?.rowKey || page.nextCursor === cursor)) throw Error('INVALID_SETTLEMENT_CURSOR');
   cursor = page.nextCursor;
  } while (cursor !== null);
 } catch (cause) { if (signal?.aborted) throw cause; error = cause instanceof Error ? cause.message : 'SETTLEMENT_READ_FAILED'; }
 const unknownPostingDates = new Set<string>();
 const inPeriod = collected.filter(row => {
  let date: string | null;
  if (scope.dateBasis === 'posting') {
   const postingDate = classifySettlementPostingDate(row);
   if (postingDate.state === 'known_none') return false;
   if (postingDate.state === 'unverified') { unknownPostingDates.add(row.rowKey); return true; }
   date = postingDate.postedOn;
  } else {
   date = row.rowType === 'source' ? row.eventDate : row.snapshot.state === 'ready' ? row.snapshot.value.sourceEventDate ?? row.snapshot.value.voucherDate : null;
  }
  // Backlog spans every arisen period; header month is only an old-period marker.
  if (scope.mode !== 'period') return true;
  // Unknown dates stay visible; absence is not proof that a row is out of scope.
  if (date === null) return true;
  return date.slice(0,7) === scope.period;
 });
 const rows = filterSettlementRows(inPeriod, scope.filters);
 const unavailable = rows.some(row => (row.rowType === 'voucher' && row.snapshot.state !== 'ready') || unknownPostingDates.has(row.rowKey));
 const partial = error !== null || unavailable;
 const totals = partial ? null : calculateSettlementTotals(rows);
 if (totals && Object.values(totals).some(value => value !== null && !Number.isSafeInteger(value))) throw Error('SETTLEMENT_TOTAL_OVERFLOW');
 return {rows, totals, partial, error: error ?? (unavailable ? 'SETTLEMENT_DETAIL_UNAVAILABLE' : null), revision, asOf, pagination:{complete:error === null,pages,nextCursor:cursor},capabilities:{automaticSaleCandidates:false}};
}
