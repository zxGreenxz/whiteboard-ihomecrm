import { describe, expect, it } from 'vitest';
import { DemoNetworkCenterRepository } from '@/lib/network-center/demoRepository';
import { actionFieldErrors, maintenanceFieldErrors, settingsFieldErrors, networkFeedback } from '@/lib/network-center/feedback';

const site = new DemoNetworkCenterRepository([{ id: 'a', name: 'Tòa A', roomsCount: 10 }]).getBuilding('a')!;
describe('network feedback', () => {
  it('collects all action errors without guessing a field for server failures', () => {
    expect(actionFieldErrors(site, { type: 'cycle_access_port', fields: { durationSeconds: 2 }, reason: '', confirmation: '' })).toMatchObject({
      'fields.interfaceId': expect.any(String), 'fields.durationSeconds': expect.any(String), reason: expect.any(String), confirmation: expect.any(String),
    });
    expect(networkFeedback(new Error('SQL select secret'), 'sao lưu thiết bị').description).not.toContain('SQL');
  });
  it('checks maintenance duration and reason together', () => {
    expect(Object.keys(maintenanceFieldErrors({ durationMinutes: 0, reason: '' }))).toEqual(['durationMinutes', 'reason']);
    expect(maintenanceFieldErrors({ durationMinutes: 15, reason: 'Bảo trì định kỳ' })).toEqual({});
  });
  it('keeps existing settings limits and flags every invalid field', () => {
    expect(settingsFieldErrors({ ...site.settings!, pollingSeconds: 29, backupHour: '25:00' })).toMatchObject({ pollingSeconds: expect.any(String), backupHour: expect.any(String) });
    expect(settingsFieldErrors({ ...site.settings!, pollingSeconds: 3600, backupHour: '23:59' })).toEqual({});
  });
});
