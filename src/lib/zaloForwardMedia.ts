import { z } from 'zod';

const uuid = z.string().uuid();
const inputSchema = z.object({
  sourceMessageIds: z.array(uuid).min(1).max(12),
  conversationIds: z.array(uuid).min(1).max(100),
  requestId: uuid,
}).refine(v => new Set(v.sourceMessageIds).size === v.sourceMessageIds.length && new Set(v.conversationIds).size === v.conversationIds.length, 'Danh sách chuyển tiếp bị trùng.');

export type ForwardMediaInput = z.infer<typeof inputSchema>;
const recipientSchema = z.discriminatedUnion('status', [
  z.object({ conversation_id: uuid, status: z.literal('queued'), message_ids: z.array(uuid).min(1).max(13), caption_message_id: uuid.optional(), job_id: uuid, reused: z.boolean() }),
  z.object({ conversation_id: uuid, status: z.literal('rejected'), error: z.string().min(1) }),
]);
const resultSchema = z.object({ recipients: z.array(recipientSchema) });
export type ForwardMediaResult = z.infer<typeof resultSchema>;
export type ForwardMediaRecipient = ForwardMediaResult['recipients'][number];

/** Narrow facade for the additive migration, until the deployed schema includes this RPC. */
export type ForwardMediaRpc = (name: 'zalo_forward_media_v1', args: {
  p_source_message_ids: string[];
  p_conversation_ids: string[];
  p_client_request_id: string;
}) => PromiseLike<{ data: unknown; error: unknown }>;

export async function forwardZaloMedia(rpc: ForwardMediaRpc, input: ForwardMediaInput): Promise<ForwardMediaResult> {
  const value = inputSchema.parse(input);
  const { data, error } = await rpc('zalo_forward_media_v1', {
    p_source_message_ids: value.sourceMessageIds,
    p_conversation_ids: value.conversationIds,
    p_client_request_id: value.requestId,
  });
  if (error) throw error;
  const result = resultSchema.safeParse(data);
  if (!result.success) throw new Error('Chưa xác nhận được kết quả chuyển tiếp.');
  const ids = result.data.recipients.map(recipient => recipient.conversation_id);
  if (ids.length !== value.conversationIds.length || new Set(ids).size !== ids.length || ids.some(id => !value.conversationIds.includes(id))) {
    throw new Error('Chưa xác nhận đủ hội thoại trong yêu cầu chuyển tiếp.');
  }
  const queued = result.data.recipients.filter(recipient => recipient.status === 'queued');
  const messageIds = queued.flatMap(recipient => recipient.message_ids);
  if (queued.some(recipient => recipient.message_ids.length !== value.sourceMessageIds.length + (recipient.caption_message_id ? 1 : 0)
    || (recipient.caption_message_id && !recipient.message_ids.includes(recipient.caption_message_id)))
    || new Set(messageIds).size !== messageIds.length || new Set(queued.map(recipient => recipient.job_id)).size !== queued.length) {
    throw new Error('Chưa xác nhận đủ tệp trong yêu cầu chuyển tiếp.');
  }
  return result.data;
}
