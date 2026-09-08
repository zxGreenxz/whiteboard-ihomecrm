import { z } from 'zod';
import { normalizeVietnamese } from './utils';

const conversionSchema = z.object({
  source: z.literal('goong-v2'),
  candidates: z.array(z.object({
    id: z.string().min(1).max(600), formattedAddress: z.string().min(1).max(600),
    province: z.string().min(1).max(150), ward: z.string().min(1).max(150),
    oldAddress: z.string().max(600),
  })).max(5),
});
export type AddressConversion = z.infer<typeof conversionSchema>;

export function assembleLegacyAddress(detail: string, units: string[]): string {
  const normalize = (value: string) => normalizeVietnamese(value).replace(/\./g, ' ')
    .replace(/^(thanh pho|thi tran|thi xa|tinh|tp|quan|huyen|phuong|xa)\s+/, '').replace(/\s+/g, ' ').trim();
  const parts = detail.split(',').map(p => p.trim()).filter(Boolean);
  for (const unit of units.filter(Boolean)) {
    if (!parts.some(part => normalize(part) === normalize(unit))) parts.push(unit);
  }
  return parts.join(', ');
}

const errors: Record<string, string> = {
  NOT_CONFIGURED: 'Dịch vụ chuyển địa chỉ chưa được cấu hình. Vui lòng liên hệ quản trị viên.',
  UNAUTHORIZED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  INVALID_ADDRESS: 'Vui lòng nhập địa chỉ từ 1 đến 600 ký tự.',
  AUTH_UNAVAILABLE: 'Chưa kiểm tra được phiên đăng nhập. Vui lòng thử lại.',
  RATE_LIMITED: 'Bạn đã tra nhiều địa chỉ liên tiếp. Vui lòng chờ một phút rồi thử lại.',
  PROVIDER_UNAVAILABLE: 'Dịch vụ tra địa chỉ đang bận. Vui lòng thử lại.',
};

/** Caller owns cancellation and the complete operation deadline, including session refresh. */
export async function convertCustomerAddress(address: string, signal: AbortSignal): Promise<AddressConversion> {
  const { supabase } = await import('@/integrations/supabase/client');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const { data: { session } } = await supabase.auth.getSession();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!session?.access_token) throw new Error(errors.UNAUTHORIZED);
  const response = await fetch('/api/customer-address-conversion', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ address }), signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = z.object({ code: z.string() }).safeParse(payload);
    throw new Error((code.success && errors[code.data.code]) || errors.PROVIDER_UNAVAILABLE);
  }
  const parsed = conversionSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Phản hồi tra địa chỉ không hợp lệ. Vui lòng thử lại.');
  return parsed.data;
}
