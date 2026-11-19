// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NotificationDeliveryHealth } from '@/lib/notifications/settingsRpc';

const m = vi.hoisted(() => ({ health: {} as Record<string, unknown> }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useNotificationSettings', async (original) => ({
  ...(await original<typeof import('@/hooks/useNotificationSettings')>()),
  useNotificationDeliveryHealth: () => m.health,
}));
import NotificationDeliveryHealthCard from './NotificationDeliveryHealthCard';

const base: NotificationDeliveryHealth = {
  generatedAt: '2026-10-21T16:00:00Z', membersTotal: 5, membersWithDevice: 2, activeDevices: 2,
  // Phiếu E1 lúc 21:00 giờ VN (14:00Z) nằm QUEUED vì giờ yên mặc định 21→7: 120 phút.
  queue: { queued: 1, sending: 0, oldestQueuedAt: '2026-10-21T14:00:00Z' },
  last7d: { sent: 3, noDevice: 0, failed: 0, skipped: 1 },
  lifecycle: { pushStates: { SENT: 2, DISABLED: 1 }, lastSuccessAt: null },
  pushLog7d: { SENT: 3, UNKNOWN: 1 },
  noRecipient7d: [{ event: 'E1', reason: 'NO_APPROVER_IN_SCOPE', n: 2 }],
  lastDrainAt: '2026-10-21T15:50:00Z',
  lastDrainOkAt: '2026-10-21T15:50:00Z',
  lastDrainError: null,
};
const dung = (h: NotificationDeliveryHealth) => {
  m.health = { data: h, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  return render(<NotificationDeliveryHealthCard organizationId="org-a" />);
};
beforeEach(() => { m.health = {}; });
afterEach(cleanup);

it('QUEUED cũ (đang hoãn vì giờ yên) + lượt gửi thành công mới ⇒ KHÔNG nói "lượt gửi có thể đang lỗi"', () => {
  dung(base);
  expect(screen.queryByText(/có thể đang lỗi/)).toBeNull();
  expect(screen.getByText(/có thể đang hoãn vì giờ yên/)).toBeTruthy();
});

it('máy chủ trả số hoãn vì giờ yên ⇒ câu trung tính, không cảnh báo', () => {
  dung({ ...base, queue: { ...base.queue, oldestEligibleQueuedAt: null, deferredQuiet: 1 } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/1 thông báo đang hoãn vì giờ yên/)).toBeTruthy();
  expect(screen.queryByText(/có thể đang hoãn vì giờ yên/)).toBeNull();
});

it('lượt thành công gần nhất đã cũ ⇒ cảnh báo lượt gửi có thể đang lỗi', () => {
  dung({ ...base, lastDrainAt: '2026-10-21T15:55:00Z', lastDrainOkAt: '2026-10-21T15:00:00Z' });
  expect(screen.getByRole('alert').textContent).toMatch(/cách đây 60 phút.*có thể đang lỗi/);
  expect(screen.getByText(/lượt này lỗi/)).toBeTruthy();
});

it('nhãn tiếng Việt: tiêu đề nhắc việc máy chủ, DISABLED/UNKNOWN, họ + lý do không có người nhận', () => {
  dung(base);
  expect(screen.getByText('Nhắc việc từ máy chủ')).toBeTruthy();
  expect(screen.getByText('Người nhận đã tắt đẩy về máy')).toBeTruthy();
  expect(screen.getByText('Chưa rõ kết quả')).toBeTruthy();
  expect(screen.getByText('Phiếu chờ tôi duyệt · Không có người duyệt trong phạm vi')).toBeTruthy();
  expect(screen.queryByText(/NO_APPROVER_IN_SCOPE/)).toBeNull();
});
