import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const timestamp = z.string().datetime({ offset: true });
const nullableTime = timestamp.nullable();
export const eventType = z.enum(['sms.received', 'notification.received', 'gateway.test']);
const sourceSchema = z.object({
  id: z.string(), name: z.string(), enabled: z.boolean(), revokedAt: nullableTime,
  deviceId: z.string().nullable(), organizationId: z.string().nullable(),
  createdAt: timestamp, lastSeenAt: nullableTime, lastEventAt: nullableTime,
  credentialFingerprint: z.string().nullable(), credentialCreatedAt: nullableTime,
  heartbeat: z.object({ smsEnabled: z.boolean(), notificationsEnabled: z.boolean(),
    notificationAccess: z.boolean(), smsPermission: z.boolean(), appVersion: z.string(), receivedAt: timestamp }).nullable(),
});
const eventSchema = z.object({
  id: z.string(), externalId: z.string(), sourceId: z.string(), sourceName: z.string(),
  eventType, deviceId: z.string(), occurredAt: timestamp, receivedAt: timestamp,
  duplicateCount: z.number().int().nonnegative(), organizationId: z.string().nullable(),
});
const statusSchema = z.object({ serverTime: timestamp, totalSources: z.number().int().nonnegative(),
  enabledSources: z.number().int().nonnegative(), totalEvents: z.number().int().nonnegative(),
  lastReceivedAt: nullableTime, ingestUrl: z.string().url().refine(value => value.startsWith('https://')).nullable() });
export type BankSource = z.infer<typeof sourceSchema>;
export type BankEvent = z.infer<typeof eventSchema>;
export type BankStatus = z.infer<typeof statusSchema>;
export interface EventFilters { sourceId?: string; eventType?: z.infer<typeof eventType>; query?: string; from?: string; to?: string; cursor?: string; limit?: number }
export class BankEventError extends Error {
  constructor(message: string, public readonly outcomeUnknown = false) { super(message); this.name = 'BankEventError'; }
}

/** Never expose server exception text: it may include raw messages or credentials. */
export async function invokeBankAdmin<T>(actorId: string, body: Record<string, unknown>, schema: z.ZodType<T>, mutation = false): Promise<T> {
  try {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session || session.user.id !== actorId) throw new BankEventError('Phiên đăng nhập đã thay đổi. Vui lòng mở lại trang.');
  const { data, error } = await supabase.functions.invoke('bank-event-admin', {
    body, headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const current = await supabase.auth.getSession();
  if (current.error || current.data.session?.user.id !== actorId) throw new BankEventError('Phiên đăng nhập đã thay đổi.');
  if (error) throw new BankEventError(mutation
    ? 'Chưa xác định thao tác đã hoàn tất. Hãy tải lại danh sách trước khi thử lại; nếu chưa lưu khóa mới, hãy cấp lại khóa.'
    : 'Không tải được dữ liệu. Kiểm tra phiên đăng nhập, quyền super admin và kết nối rồi thử lại.', mutation);
  const envelope = z.object({ ok: z.literal(true), data: z.unknown() }).safeParse(data);
  const result = schema.safeParse(envelope.success ? envelope.data.data : undefined);
  if (!envelope.success || !result.success) throw new BankEventError(mutation
    ? 'Chưa xác nhận được kết quả thao tác. Tải lại danh sách trước khi thử lại.'
    : 'Máy chủ trả dữ liệu chưa hợp lệ. Vui lòng thử lại.', mutation);
  return result.data;
  } catch (error) {
    if (error instanceof BankEventError) throw error;
    throw new BankEventError(mutation
      ? 'Chưa xác định thao tác đã hoàn tất. Hãy tải lại danh sách trước khi thử lại; nếu chưa lưu khóa mới, hãy cấp lại khóa.'
      : 'Không tải được dữ liệu. Kiểm tra phiên đăng nhập và kết nối rồi thử lại.', mutation);
  }
}

export function bankEventService(actorId: string) {
  return {
    sources: () => invokeBankAdmin(actorId, { action: 'list_sources' }, z.object({ sources: z.array(sourceSchema) })),
    events: (filters: EventFilters) => invokeBankAdmin(actorId, { action: 'list_events', ...filters }, z.object({ events: z.array(eventSchema), nextCursor: z.string().nullable() })),
    detail: (eventId: string) => invokeBankAdmin(actorId, { action: 'get_event', eventId }, z.object({ event: eventSchema, payload: z.record(z.unknown()) })),
    status: () => invokeBankAdmin(actorId, { action: 'status' }, statusSchema),
    create: (name: string) => invokeBankAdmin(actorId, { action: 'create_source', name }, z.object({ source: sourceSchema, token: z.string().min(32) }), true),
    rotate: (sourceId: string) => invokeBankAdmin(actorId, { action: 'rotate_source', sourceId }, z.object({ source: sourceSchema, token: z.string().min(32) }), true),
    enabled: (sourceId: string, enabled: boolean) => invokeBankAdmin(actorId, { action: 'set_source_enabled', sourceId, enabled }, z.object({ source: sourceSchema }), true),
    revoke: (sourceId: string) => invokeBankAdmin(actorId, { action: 'revoke_source', sourceId }, z.object({ source: sourceSchema }), true),
  };
}
