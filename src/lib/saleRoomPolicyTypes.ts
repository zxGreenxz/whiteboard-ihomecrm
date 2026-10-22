import { z } from 'zod';

const instant = z.string().datetime({ offset: true });
export const saleRoomPolicyInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  starts_at: instant,
  ends_at: instant,
}).strict().refine(value => Date.parse(value.starts_at) < Date.parse(value.ends_at), {
  message: 'Thời điểm kết thúc phải sau thời điểm bắt đầu.', path: ['ends_at'],
});
export type SaleRoomPolicyInput = z.infer<typeof saleRoomPolicyInputSchema>;
export const saleRoomPolicySchema = z.object({
  id: z.string().uuid(), version: z.number().int().positive(),
  title: z.string(), content: z.string(), starts_at: instant, ends_at: instant,
  status: z.enum(['SCHEDULED', 'ACTIVE', 'EXPIRED', 'CANCELLED']),
});
export type SaleRoomPolicy = z.infer<typeof saleRoomPolicySchema>;

/** Form uses Vietnam civil time explicitly, independent of the browser timezone. */
export function salePolicyTimeToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Nhập đủ ngày và giờ.');
  const instant = new Date(`${value}:00+07:00`);
  if (!Number.isFinite(instant.getTime())) throw new Error('Ngày giờ không hợp lệ.');
  const roundTrip = new Date(instant.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
  if (roundTrip !== value) throw new Error('Ngày giờ không hợp lệ.');
  return instant.toISOString();
}

export function salePolicyTimeLabel(value: string): string {
  return new Date(value).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function salePolicyIsActive(policy: SaleRoomPolicy | null | undefined, now: number): boolean {
  return !!policy && policy.status !== 'CANCELLED'
    && Date.parse(policy.starts_at) <= now && now < Date.parse(policy.ends_at);
}
