import { z } from 'zod';
import { mapPayloadToBuildings, parseRoomSalePayload, type RpcPayload } from '@/pages/phong-trong/supabaseData';

const timestamp = z.string().datetime({ offset: true });
const timingSchema = z.object({
  server_now: timestamp.optional(), next_policy_boundary_at: timestamp.nullable().optional(),
  rooms: z.array(z.object({ id: z.string(), sale_note_base: z.string().nullable().optional(),
    active_policy_text: z.string().nullable().optional(), active_policy_ends_at: timestamp.nullable().optional() })),
});
export interface TimedRoomSaleRead {
  payload: RpcPayload;
  timing: z.infer<typeof timingSchema>;
  receivedMonotonicMs: number;
  requestDurationMs: number;
  includeInternal: boolean;
}

export function parseTimedRoomSaleRead(value: unknown, includeInternal: boolean, requestStartedMs: number, receivedMs: number): TimedRoomSaleRead {
  const payload = parseRoomSalePayload(value);
  const timing = timingSchema.parse(value);
  if (timing.rooms.some(row => row.active_policy_text != null
    && (row.sale_note_base === undefined || !row.active_policy_ends_at || !timing.server_now))) {
    throw new Error('Thiếu thời hạn để xác minh nội dung chính sách.');
  }
  return { payload, timing, includeInternal, receivedMonotonicMs: receivedMs,
    requestDurationMs: Math.max(0, receivedMs - requestStartedMs) };
}

/** Conservative server-time upper bound: round-trip delay must never postpone
 * expiry. It may hide an offer slightly early on a slow connection. Monotonic
 * elapsed time is independent of browser clock/timezone changes. */
export function policyReadServerNow(read: TimedRoomSaleRead, monotonicNowMs: number): number {
  if (!read.timing.server_now) return Number.NaN;
  return Date.parse(read.timing.server_now) + read.requestDurationMs
    + Math.max(0, monotonicNowMs - read.receivedMonotonicMs);
}

export function projectTimedRoomSaleRead(read: TimedRoomSaleRead, monotonicNowMs: number) {
  const serverNow = policyReadServerNow(read, monotonicNowMs);
  const byId = new Map(read.timing.rooms.map(row => [row.id, row]));
  const rooms = read.payload.rooms.map(room => {
    const timing = byId.get(room.id);
    if (!timing?.active_policy_ends_at || Date.parse(timing.active_policy_ends_at) > serverNow) return room;
    return { ...room, sale_note: timing.sale_note_base ?? null };
  });
  return mapPayloadToBuildings({ ...read.payload, rooms }, { includeInternal: read.includeInternal });
}

export function nextPolicyReadBoundary(read: TimedRoomSaleRead, monotonicNowMs: number): number | null {
  const now = policyReadServerNow(read, monotonicNowMs);
  const boundaries = [read.timing.next_policy_boundary_at, ...read.timing.rooms.map(room => room.active_policy_ends_at)]
    .filter((value): value is string => !!value).map(Date.parse).filter(value => value > now);
  return boundaries.length ? Math.min(...boundaries) - now : null;
}
