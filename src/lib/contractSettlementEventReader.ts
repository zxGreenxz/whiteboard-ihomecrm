import { z } from 'zod';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const eventSchema = z.object({
  id: z.string(), sourceKind: z.enum(['contract', 'extension', 'termination', 'reservation', 'reservation_settlement']),
  sourceId: uuid, type: z.enum(['sign', 'renew', 'terminate', 'forfeit', 'reserve']), organizationId: uuid,
  buildingId: uuid, roomId: uuid.nullable(), roomName: z.string().nullable(), contractId: uuid.nullable(),
  relatedContractId: uuid.nullable(), sourceVoucherId: uuid.nullable(), customerName: z.string().nullable(),
  staffName: z.string().nullable(), sourceCode: z.string(), businessDate: day.nullable(),
  origin: z.enum(['contract', 'reservation']), description: z.string(), notes: z.string().nullable(), warning: z.string().nullable(),
  links: z.object({ complete: z.boolean(), vouchers: z.array(z.object({
    id: uuid, code: z.string(), amount: z.number().finite().nonnegative().refine(Number.isSafeInteger),
    approvalStatus: z.enum(['UNAPPROVED', 'APPROVED', 'CANCELLED']),
    reviewState: z.enum(['PENDING', 'CHANGES_REQUESTED', 'DISPUTED', 'RESOLVED']),
  })) }),
}).superRefine((event, context) => {
  const allowed = { contract: ['sign'], extension: ['renew'], termination: ['terminate', 'forfeit'],
    reservation: ['reserve'], reservation_settlement: ['terminate', 'forfeit'] };
  const reservation = event.sourceKind === 'reservation' || event.sourceKind === 'reservation_settlement';
  if (event.id !== `${event.sourceKind}:${event.sourceId}` || !allowed[event.sourceKind].includes(event.type)
    || event.origin !== (reservation ? 'reservation' : 'contract') || (!reservation && event.contractId === null)
    || (reservation && event.sourceVoucherId === null) || (event.sourceKind === 'contract' && event.contractId !== event.sourceId)
    || (event.sourceKind === 'reservation' && event.sourceVoucherId !== event.sourceId)
    || new Set(event.links.vouchers.map(voucher => voucher.id)).size !== event.links.vouchers.length) {
    context.addIssue({ code: 'custom', message: 'EVENT_IDENTITY_INVALID' });
  }
});
const pageSchema = z.object({ rows: z.array(eventSchema), nextCursor: z.string().nullable(), revision: z.string().min(1),
  asOf: z.string().datetime({ offset: true }), organizationId: uuid, actorId: uuid });
export type SettlementBusinessEvent = z.infer<typeof eventSchema>;
export type SettlementEventScope = { organizationId: string; actorId: string; scopeRevision: string; buildingIds: string[] };
export type SettlementEventPageReader = (scope: SettlementEventScope, cursor: string | null, revision: string | null, signal?: AbortSignal) => Promise<unknown>;
export const settlementEventQueryKey = (scope: SettlementEventScope) => ['contract-settlement-events', scope.organizationId,
  scope.actorId, scope.scopeRevision, [...new Set(scope.buildingIds)].sort()] as const;
export function parseSettlementEventPage(input: unknown, scope: SettlementEventScope) {
  const page = pageSchema.parse(input);
  if (page.organizationId !== scope.organizationId || page.actorId !== scope.actorId || page.rows.some(row => row.organizationId !== scope.organizationId
    || !scope.buildingIds.includes(row.buildingId))) throw Error('EVENT_SCOPE_MISMATCH');
  return page;
}
/** A consistent complete set feeds counts and display pagination. A truncated set is never called complete. */
export async function readSettlementEvents(scope: SettlementEventScope, readPage: SettlementEventPageReader, signal?: AbortSignal) {
  const rows: SettlementBusinessEvent[] = []; const ids = new Set<string>();
  let cursor: string | null = null; let revision: string | null = null; let asOf: string | null = null; let pages = 0;
  try {
    do {
      signal?.throwIfAborted();
      const page = parseSettlementEventPage(await readPage(scope, cursor, revision, signal), scope);
      signal?.throwIfAborted();
      if (revision !== null && revision !== page.revision) throw Error('EVENT_CHANGED_RELOAD');
      let previous = cursor;
      for (const row of page.rows) {
        if (ids.has(row.id) || (previous !== null && row.id <= previous)) throw Error('EVENT_PAGE_OVERLAP');
        previous = row.id;
      }
      if (page.nextCursor !== null && (page.rows.length === 0 || page.nextCursor !== page.rows.at(-1)?.id || page.nextCursor === cursor)) throw Error('EVENT_CURSOR_INVALID');
      for (const row of page.rows) { ids.add(row.id); rows.push(row); }
      cursor = page.nextCursor; revision = page.revision; asOf ??= page.asOf; pages++;
    } while (cursor !== null);
    return { rows, complete: true, error: null, revision, asOf, pages };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { rows, complete: false, error: error instanceof Error ? error.message : 'EVENT_READ_FAILED', revision, asOf, pages };
  }
}
