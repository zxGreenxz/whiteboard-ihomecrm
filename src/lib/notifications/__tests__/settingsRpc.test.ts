import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc } }));

import {
  NotificationOrgConfigConflictError,
  NotificationSettingsReceiptError,
  fetchDeliveryHealth,
  fetchMyPushLog,
  fetchMyQuietHours,
  fetchOrgConfigV2,
  isMissingRpcError,
  parseDeliveryHealth,
  saveOrgConfigV2,
  saveMyQuietHours,
} from '../settingsRpc';

const LEGACY = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'LIFECYCLE'];
const events = Object.fromEntries(LEGACY.map(k => [k, { enabled: true, min_amount: null }]));
const orgEnvelope = { organization_id: 'org-a', organization_name: 'Công ty A', events, quiet_start: 21, quiet_end: 7, updated_at: '2026-10-21T01:00:00+00:00', updated_by: 'user-a' };
const health = {
  generated_at: '2026-10-21T02:00:00Z', members_total: 10, members_with_device: 2, active_devices: 3,
  queue: { queued: 1, sending: 0, oldest_queued_at: '2026-10-21T01:50:00Z' },
  last_7d: { sent: 5, no_device: 1, failed: 0, skipped: 2 },
  lifecycle: { push_states: { SENT: 3 }, last_success_at: null },
  push_log_7d: { SENT: 5, NO_DEVICE: 1 }, no_recipient_7d: [{ event: 'E1', reason: 'NO_APPROVER_IN_SCOPE', n: 2 }], last_drain_at: '2026-10-21T01:45:00Z',
};

beforeEach(() => { m.rpc.mockReset(); });

describe('wrapper RPC mới theo hợp đồng §4', () => {
  it('giờ yên: gửi đúng tên tham số và kiểm hình dạng', async () => {
    m.rpc.mockResolvedValue({ data: { enabled: true, quiet_start: 22, quiet_end: 6, updated_at: null }, error: null });
    await expect(saveMyQuietHours({ organizationId: 'org-a', enabled: true, quietStart: 22, quietEnd: 6 }))
      .resolves.toEqual({ enabled: true, quietStart: 22, quietEnd: 6, updatedAt: null });
    expect(m.rpc).toHaveBeenCalledWith('set_my_notification_quiet_hours_v1', { p_organization_id: 'org-a', p_enabled: true, p_quiet_start: 22, p_quiet_end: 6 });
  });
  it.each([null, {}, { enabled: 'yes', quiet_start: 21, quiet_end: 7, updated_at: null }, { enabled: true, quiet_start: 24, quiet_end: 7, updated_at: null }])(
    'giờ yên phong bì lệch không thành mặc định: %j', async data => {
      m.rpc.mockResolvedValue({ data, error: null });
      await expect(fetchMyQuietHours('org-a')).rejects.toBeInstanceOf(NotificationSettingsReceiptError);
    });
  it('cấu hình công ty v2: lệch updated_at (PT409) thành lỗi đụng độ riêng', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'stale' } });
    await expect(saveOrgConfigV2({ organizationId: 'org-a', events: { E2: { enabled: false } }, quietStart: 21, quietEnd: 7, expectedUpdatedAt: '2026-10-21T01:00:00Z' }, LEGACY))
      .rejects.toBeInstanceOf(NotificationOrgConfigConflictError);
    expect(m.rpc).toHaveBeenCalledWith('set_notification_org_config_v2', {
      p_organization_id: 'org-a', p_events: { E2: { enabled: false } }, p_quiet_start: 21, p_quiet_end: 7, p_expected_updated_at: '2026-10-21T01:00:00Z',
    });
  });
  it('cấu hình công ty v2: thiếu một khoá cũ là lỗi hợp đồng; khoá mới có thì giữ', async () => {
    m.rpc.mockResolvedValueOnce({ data: { ...orgEnvelope, events: { ...events, E3: undefined } }, error: null });
    await expect(fetchOrgConfigV2('org-a', LEGACY)).rejects.toBeInstanceOf(NotificationSettingsReceiptError);
    m.rpc.mockResolvedValueOnce({ data: { ...orgEnvelope, events: { ...events, BILLING: { enabled: false, min_amount: null } } }, error: null });
    const ok = await fetchOrgConfigV2('org-a', LEGACY);
    expect(ok.events.BILLING).toEqual({ enabled: false, min_amount: null });
    expect(ok.organizationName).toBe('Công ty A');
  });
  it('lỗi quyền đi nguyên, không đổi thành cấu hình rỗng', async () => {
    const failure = { code: '42501', message: 'permission denied' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    await expect(fetchOrgConfigV2('org-a', LEGACY)).rejects.toBe(failure);
  });
  it('RPC chưa có trên máy chủ nhận diện được để hiện "máy chủ chưa hỗ trợ"', () => {
    expect(isMissingRpcError({ code: 'PGRST202' })).toBe(true);
    expect(isMissingRpcError({ code: '42883' })).toBe(true);
    expect(isMissingRpcError({ code: '42501' })).toBe(false);
  });
  it('sức khoẻ: phong bì đủ thì đọc được, thiếu số đếm thì lỗi', async () => {
    m.rpc.mockResolvedValue({ data: health, error: null });
    const ok = await fetchDeliveryHealth('org-a');
    expect(ok.activeDevices).toBe(3);
    expect(ok.noRecipient7d[0]).toEqual({ event: 'E1', reason: 'NO_APPROVER_IN_SCOPE', n: 2 });
    expect(() => parseDeliveryHealth({ ...health, last_7d: { sent: 1 } })).toThrow(NotificationSettingsReceiptError);
    expect(() => parseDeliveryHealth({ ...health, push_log_7d: { SENT: -1 } })).toThrow(NotificationSettingsReceiptError);
  });
  it('nhật ký push: kẹp p_limit 1..50 và kiểm từng dòng', async () => {
    m.rpc.mockResolvedValue({ data: [{ created_at: '2026-10-21T01:00:00Z', outcome: 'SENT', sent: 1 }], error: null });
    await expect(fetchMyPushLog(500)).resolves.toEqual([{ createdAt: '2026-10-21T01:00:00Z', outcome: 'SENT', sent: 1 }]);
    expect(m.rpc).toHaveBeenLastCalledWith('get_my_push_log_v1', { p_limit: 50 });
    await fetchMyPushLog(0);
    expect(m.rpc).toHaveBeenLastCalledWith('get_my_push_log_v1', { p_limit: 1 });
    m.rpc.mockResolvedValue({ data: [{ created_at: 'bad', outcome: 'SENT', sent: 1 }], error: null });
    await expect(fetchMyPushLog(5)).rejects.toBeInstanceOf(NotificationSettingsReceiptError);
  });
});
