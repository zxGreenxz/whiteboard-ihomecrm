import type { BankEvent, BankSource, BankStatus } from '../service';
export const fixtureActor = '11111111-1111-4111-8111-111111111111';
export const fixtureSource: BankSource = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Điện thoại thử nghiệm', kind: 'android', enabled: true,
  revokedAt: null, deviceId: 'fixture-device-one', organizationId: null,
  createdAt: '2026-10-09T01:00:00Z', lastSeenAt: '2026-10-09T02:00:00Z', lastEventAt: '2026-10-09T01:58:00Z',
  credentialFingerprint: 'fixture-fingerprint', credentialCreatedAt: '2026-10-09T01:00:00Z',
  heartbeat: { smsEnabled: true, notificationsEnabled: true, notificationAccess: true, smsPermission: true, appVersion: '0.2.0-fixture', receivedAt: '2026-10-09T02:00:00Z' },
};
export const fixtureEvent: BankEvent = {
  id: '33333333-3333-4333-8333-333333333333', externalId: 'fixture-event-000000001', sourceId: fixtureSource.id,
  sourceName: fixtureSource.name, eventType: 'sms.received', deviceId: 'fixture-device-one',
  occurredAt: '2026-10-09T01:57:58Z', receivedAt: '2026-10-09T01:58:00Z', duplicateCount: 0, organizationId: null,
};
export const fixtureStatus: BankStatus = {
  serverTime: '2026-10-09T02:01:00Z', totalSources: 1, enabledSources: 1, totalEvents: 1,
  lastReceivedAt: fixtureEvent.receivedAt, ingestUrl: 'https://fixture.example.test/webhooks/sms',
};
