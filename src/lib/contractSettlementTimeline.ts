import { z } from 'zod';
import type { LifecycleContract, LifecyclePayload, LifecycleSegment } from './roomLifecycle';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const uuid = z.string().uuid();
const money = z.number().finite().refine(Number.isSafeInteger).nullable();
const contractSchema = z.object({ id: uuid, number: z.string().nullable(), status: z.string(),
  signedDate: day.nullable().optional().transform(value => value ?? null), startDate: day.nullable(), endDate: day.nullable(),
  actualEndDate: day.nullable(), rentPrice: money, totalDeposit: money, tenantName: z.string().nullable() });
const segmentSchema = z.object({ contractId: uuid, contractNumber: z.string().nullable(), segIndex: z.number().int().nonnegative(),
  fromDate: day.nullable(), toDate: day.nullable(), sourcePath: z.string().nullable(), trusted: z.boolean(), diagnostic: z.string().nullable() });
const payloadSchema = z.object({
  room: z.object({ id: uuid, name: z.string(), buildingId: uuid, buildingName: z.string() }),
  range: z.object({ from: day.nullable(), to: day.nullable() }),
  contracts: z.array(contractSchema), segments: z.array(segmentSchema),
  events: z.array(z.object({ type: z.string(), date: day, contractId: uuid.nullable(), amount: money,
    trusted: z.boolean(), meta: z.record(z.unknown()).nullable() })),
  vacancies: z.array(z.object({ fromDate: day, toDate: day.nullable(), days: z.number().int().nonnegative() })),
  generatedAt: z.string().datetime({ offset: true }),
});
export interface SettlementLifecycleContract extends LifecycleContract { signedDate: string | null }
export interface SettlementRoomLifecycle extends LifecyclePayload { contracts: SettlementLifecycleContract[] }

/** Validate the room RPC at its boundary. Legacy events remain reference data, not a cash ledger. */
export function parseSettlementRoomLifecycle(input: unknown, expectedRoomId: string): SettlementRoomLifecycle {
  const value = payloadSchema.parse(input);
  if (value.room.id !== expectedRoomId || (value.range.from && value.range.to && value.range.from > value.range.to)) throw Error('LIFECYCLE_SCOPE');
  const ids = new Set(value.contracts.map(contract => contract.id));
  if (ids.size !== value.contracts.length) throw Error('LIFECYCLE_DUPLICATE_CONTRACT');
  const segments = new Set<string>();
  for (const segment of value.segments) {
    const key = `${segment.contractId}:${segment.segIndex}`;
    if (!ids.has(segment.contractId) || segments.has(key)) throw Error('LIFECYCLE_SEGMENT_IDENTITY');
    segments.add(key);
  }
  if (value.events.some(event => event.contractId !== null && !ids.has(event.contractId))) throw Error('LIFECYCLE_EVENT_IDENTITY');
  // This assertion follows complete schema validation; it is not an unchecked RPC cast.
  return value as SettlementRoomLifecycle;
}

export interface SettlementChronologyLane {
  contract: SettlementLifecycleContract;
  role: 'previous' | 'target' | 'following' | 'current';
  segments: readonly LifecycleSegment[];
}
export interface SettlementChronology {
  targetContractId: string | null;
  lanes: SettlementChronologyLane[];
  warning: 'RESERVATION_SOURCE' | 'TARGET_UNAVAILABLE' | 'CHRONOLOGY_UNVERIFIED' | null;
}

/** The selected voucher owns the target. Residence chronology never switches it to the latest contract. */
export function selectSettlementChronology(
  payload: SettlementRoomLifecycle, targetContractId: string | null, today: string,
): SettlementChronology {
  day.parse(today);
  if (targetContractId === null) return { targetContractId, lanes: [], warning: 'RESERVATION_SOURCE' };
  const target = payload.contracts.find(contract => contract.id === targetContractId);
  if (!target) return { targetContractId, lanes: [], warning: 'TARGET_UNAVAILABLE' };
  const targetSegments = payload.segments.filter(segment => segment.contractId === targetContractId);
  const unverified = (): SettlementChronology => ({ targetContractId, lanes: [{ contract: target, role: 'target', segments: targetSegments }], warning: 'CHRONOLOGY_UNVERIFIED' });
  // Returning to a room creates multiple residence segments. Without selecting a
  // particular historical stay, calling one other contract "liền trước" is ambiguous.
  if (payload.contracts.some(contract => payload.segments.filter(segment => segment.contractId === contract.id).length !== 1)
    || payload.segments.some(segment => !segment.trusted || segment.diagnostic !== null || segment.fromDate === null
      || (segment.toDate !== null && segment.toDate <= segment.fromDate))) return unverified();
  const ordered = [...payload.segments].sort((a, b) => (a.fromDate ?? '').localeCompare(b.fromDate ?? ''));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].toDate === null || ordered[i - 1].toDate! > ordered[i].fromDate!) return unverified();
  }
  const targetIndex = ordered.findIndex(segment => segment.contractId === targetContractId);
  if (targetIndex < 0) return unverified();
  const contracts = new Map(payload.contracts.map(contract => [contract.id, contract]));
  const lanes: SettlementChronologyLane[] = [];
  for (let i = Math.max(0, targetIndex - 1); i < ordered.length; i++) {
    const segment = ordered[i];
    const contract = contracts.get(segment.contractId);
    if (!contract) return unverified();
    const current = segment.fromDate! <= today && (segment.toDate === null || segment.toDate > today);
    lanes.push({ contract, role: i === targetIndex ? 'target' : i < targetIndex ? 'previous' : current ? 'current' : 'following', segments: [segment] });
  }
  return { targetContractId, lanes, warning: null };
}
