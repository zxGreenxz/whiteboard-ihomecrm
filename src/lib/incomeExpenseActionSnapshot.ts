import type { ActionReadiness, ActionVoucher } from './incomeExpenseActionPolicy';
import type { FinanceRoute, FinanceV2OrgRoutes } from './financeV2Route';

export interface ActionSnapshotScope { actorId: string; organizationId: string }
export interface ReservationRefundActionCapability { settlementId: string; sourceVoucherId: string; basisFingerprint: string; remaining: number; basisValid: boolean; current: boolean; fullRemaining: boolean }
export interface IncomeExpenseActionSnapshot extends ActionVoucher {
  code: string; name: string; totalAmount: number; roomId: string | null; contractId: string | null; tenantId: string | null;
  payerName: string | null; receiveBankName: string | null; receiveBankAccount: string | null;
  notes: string | null; attachments: string[]; voucherDate: string; reviewReason: string | null; systemSource: string | null;
  /** Private flow_kind, never inferred from system_source or lifecycle_owner. */
  flowKind: string | null;
  /** Owned source chains are not the canonical create chain; UNVERIFIED is not a denial. */
  birthState: 'MISSING' | 'COMMITTED' | 'INVALID' | 'UNVERIFIED';
  capabilities: { reservationRefund?: ReservationRefundActionCapability | null; forfeitPair: boolean; forfeitAllowed: boolean; engineBlocked: boolean; manual: boolean; legacyCancelAllowed: boolean; compatCancelOwner: boolean; birthPrior: boolean; requiresRealAccount: boolean; reservationMoneyBlocked: boolean; reservationRefundReverseAllowed: boolean };
  permissions: { approve: boolean; edit: boolean; cancel: boolean; reverse: boolean };
}
export interface ActionSnapshotBatch extends ActionSnapshotScope {
  isAdmin: boolean; authorizationVersion: number; routes: FinanceV2OrgRoutes;
  rows: Record<string, IncomeExpenseActionSnapshot>; unavailable: Record<string, 'NOT_VISIBLE' | 'INVALID_SNAPSHOT'>;
}
export type ActionSnapshotReader = (scope: ActionSnapshotScope, ids: string[], signal?: AbortSignal) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error('INVALID_SNAPSHOT');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new Error('INVALID_SNAPSHOT'); return value; };
const nullableText = (value: unknown): string | null => value === null ? null : typeof value === 'string' ? value : text(value);
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('INVALID_SNAPSHOT'); return value; };
const version = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_SNAPSHOT'); return value; };
const nullableVersion = (value: unknown): number | null => value === null ? null : version(value);
const enumValue = <T extends string>(value: unknown, values: readonly T[]): T => {
  const parsed = text(value); if (!values.includes(parsed as T)) throw new Error('INVALID_SNAPSHOT'); return parsed as T;
};
const nullableEnum = <T extends string>(value: unknown, values: readonly T[]): T | null => value === null ? null : enumValue(value, values);
const money = (value: unknown): number => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?(0|[1-9]\d*)(?:\.0+)?$/.test(value))) throw new Error('INVALID_SNAPSHOT');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error('INVALID_SNAPSHOT'); return parsed;
};
const route = (value: unknown): FinanceRoute => enumValue(value, ['LEGACY', 'SHADOW', 'CANONICAL', 'FROZEN']);

function reservationCapability(raw: unknown, row: Record<string, unknown>): ReservationRefundActionCapability | null {
  if (raw === undefined || raw === null) return null;
  const r = object(raw), remaining = money(r.remaining), fullRemaining = bool(r.fullRemaining);
  if (row.type !== 'EXPENSE' || row.systemSource !== 'reservation.refund' || remaining < 0 || (fullRemaining && (remaining <= 0 || remaining !== money(row.totalAmount)))) throw new Error('INVALID_SNAPSHOT');
  return { settlementId: text(r.settlementId), sourceVoucherId: text(r.sourceVoucherId), basisFingerprint: text(r.basisFingerprint), remaining, fullRemaining, basisValid: bool(r.basisValid), current: bool(r.current) };
}
function parseRow(value: Record<string, unknown>): IncomeExpenseActionSnapshot {
  const p = object(value.permissions), cap = object(value.capabilities);
  if (!Array.isArray(value.attachments) || !value.attachments.every(item => typeof item === 'string')) throw new Error('INVALID_SNAPSHOT');
  return {
    id: text(value.id), organizationId: text(value.organizationId), buildingId: nullableText(value.buildingId),
    roomId: nullableText(value.roomId), contractId: nullableText(value.contractId), tenantId: nullableText(value.tenantId),
    code: text(value.code), name: text(value.name), type: enumValue(value.type, ['INCOME', 'EXPENSE']), totalAmount: money(value.totalAmount),
    userId: nullableText(value.userId), makerUserId: nullableText(value.makerUserId), payerName: nullableText(value.payerName),
    receiveBankName: nullableText(value.receiveBankName), receiveBankAccount: nullableText(value.receiveBankAccount),
    notes: nullableText(value.notes), attachments: [...value.attachments], voucherDate: text(value.voucherDate),
    accountId: nullableText(value.accountId), activePostingId: nullableText(value.activePostingId),
    approvalStatus: enumValue(value.approvalStatus, ['UNAPPROVED', 'APPROVED', 'CANCELLED']),
    postingStatus: nullableEnum(value.postingStatus, ['UNPOSTED', 'POSTED', 'REVERSED', 'NOT_APPLICABLE']),
    postingMode: nullableEnum(value.postingMode, ['CASHBOOK', 'NON_CASH']),
    reviewState: nullableEnum(value.reviewState, ['PENDING', 'CHANGES_REQUESTED', 'DISPUTED', 'RESOLVED']),
    reviewReason: nullableText(value.reviewReason), approvalVersion: nullableVersion(value.approvalVersion),
    postingVersion: nullableVersion(value.postingVersion), reviewVersion: nullableVersion(value.reviewVersion),
    systemSource: nullableText(value.systemSource), flowKind: nullableText(value.flowKind),
    birthState: enumValue(value.birthState, ['MISSING', 'COMMITTED', 'INVALID', 'UNVERIFIED']),
    capabilities: { reservationRefund: reservationCapability(cap.reservationRefund, value), forfeitPair: bool(cap.forfeitPair), forfeitAllowed: bool(cap.forfeitAllowed), engineBlocked: bool(cap.engineBlocked),
      manual: bool(cap.manual), legacyCancelAllowed: bool(cap.legacyCancelAllowed), compatCancelOwner: bool(cap.compatCancelOwner), birthPrior: bool(cap.birthPrior), requiresRealAccount: bool(cap.requiresRealAccount), reservationMoneyBlocked: bool(cap.reservationMoneyBlocked), reservationRefundReverseAllowed: bool(cap.reservationRefundReverseAllowed) },
    permissions: { approve: bool(p.approve), edit: bool(p.edit), cancel: bool(p.cancel), reverse: bool(p.reverse) },
  };
}

export function parseActionSnapshotBatch(input: unknown, scope: ActionSnapshotScope, requestedIds: readonly string[]): ActionSnapshotBatch {
  const data = object(input), r = object(data.routes);
  if (data.actorId !== scope.actorId || data.organizationId !== scope.organizationId || !Array.isArray(data.rows)) throw new Error('SNAPSHOT_SCOPE');
  const requested = new Set(requestedIds), seen = new Set<string>();
  const result: ActionSnapshotBatch = { ...scope, isAdmin: bool(data.isAdmin), authorizationVersion: version(data.authorizationVersion),
    routes: { readSemantics: route(r.readSemantics), workflow: route(r.workflow), posting: route(r.posting), access: route(r.access), accountingStandardStrict: bool(r.accountingStandardStrict) },
    rows: {}, unavailable: {} };
  for (const item of data.rows) {
    const raw = object(item), id = text(raw.id);
    if (!requested.has(id) || seen.has(id) || raw.organizationId !== scope.organizationId) throw new Error('SNAPSHOT_SCOPE');
    seen.add(id);
    try { result.rows[id] = parseRow(raw); } catch { result.unavailable[id] = 'INVALID_SNAPSHOT'; }
  }
  for (const id of requested) if (!seen.has(id)) result.unavailable[id] = 'NOT_VISIBLE';
  return result;
}

export const actionSnapshotQueryKey = (scope: ActionSnapshotScope, ids: readonly string[]) =>
  ['income-expense-action-snapshots', scope.organizationId, scope.actorId, [...new Set(ids)].sort()] as const;

export async function readActionSnapshotBatches(scope: ActionSnapshotScope, ids: readonly string[], reader: ActionSnapshotReader, signal?: AbortSignal): Promise<ActionSnapshotBatch> {
  const unique = [...new Set(ids)].sort();
  let result: ActionSnapshotBatch | undefined;
  // The empty batch still authenticates scope and loads actual routes; never synthesize legacy.
  for (let offset = 0; offset < Math.max(unique.length, 1); offset += 200) {
    signal?.throwIfAborted(); const requested = unique.slice(offset, offset + 200);
    const batch = parseActionSnapshotBatch(await reader(scope, requested, signal), scope, requested);
    if (!result) result = batch;
    else {
      if (result.authorizationVersion !== batch.authorizationVersion || result.isAdmin !== batch.isAdmin || JSON.stringify(result.routes) !== JSON.stringify(batch.routes)) throw new Error('SNAPSHOT_CHANGED');
      Object.assign(result.rows, batch.rows); Object.assign(result.unavailable, batch.unavailable);
    }
  }
  if (!result) throw new Error('INVALID_SNAPSHOT');
  return result;
}

/** Do not authorize using cached success while a fresh read is pending or has failed. */
export function queryActionReadiness<T>(query: { data: T | undefined; isFetching: boolean; isError: boolean }, enabled: boolean): ActionReadiness<T> {
  if (!enabled || query.isFetching) return { state: 'loading' };
  if (query.isError) return { state: 'error', reason: 'Chưa tải được điều kiện thao tác. Vui lòng tải lại.' };
  return query.data === undefined ? { state: 'loading' } : { state: 'ready', value: query.data };
}
