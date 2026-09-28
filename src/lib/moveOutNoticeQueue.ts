import { z } from 'zod';

const dueNoticeSchema = z.object({
  contract_id: z.string().uuid(),
  contract_number: z.string().nullable(),
  building_name: z.string().nullable(),
  room_name: z.string().nullable(),
  expected_move_out_date: z.string().date(),
  updated_at: z.string().min(1),
});
const queueSchema = z.object({
  today: z.string().date(),
  total: z.number().int().nonnegative(),
  items: z.array(dueNoticeSchema),
});

export type MoveOutNoticeQueueData = z.infer<typeof queueSchema>;

export function parseMoveOutNoticeQueue(value: unknown): MoveOutNoticeQueueData {
  return queueSchema.parse(value);
}

export function noticeDueLabel(expectedOn: string, today: string): string {
  return expectedOn < today ? 'Quá ngày dự kiến' : 'Đến ngày dự kiến';
}
