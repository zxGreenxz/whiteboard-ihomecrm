import { describe, expect, it } from 'vitest';
import { isBulkConfirmable, panelChildCaptureIds } from './panel';
import { captureIssueLabel } from './feedback';
import type { MeterCapture, MeterPanelDetection } from './types';

const capture: MeterCapture = { id: 'capture-a', clientId: 'client-a', orgId: 'org-a', meterId: 'meter-a', version: 2, status: 'REVIEW',
  proposedValue: '120.25', previousValue: '110.25', issues: ['PANEL_SINGLE_READER', 'IDENTITY_UNVERIFIED'], replacement: null,
  supersedesCaptureId: null, supersededBy: null, serverResult: null, aiResult: null, evidenceUrl: '/private/crop', videoUrl: null,
  evidenceFrames: [], confirmedReadingId: null, readingDate: '2026-10-22', month: '2026-10', purpose: 'MONTHLY',
  capturedAt: '2026-10-22T10:00:00Z', sha256: 'hash', mediaReceived: true, mediaValidated: true };
const detection = (index: number, captureId: string | null): MeterPanelDetection => ({ index, label: null, registerCode: null, display: null,
  value: null, clear: false, state: captureId ? 'MATCHED' : 'UNMATCHED', matchKind: captureId ? 'LABEL' : null, meterId: null, roomId: null,
  roomName: null, meterCode: null, captureId, cropUrl: null, timestampSeconds: null });

describe('panel bulk confirmation eligibility', () => {
  it('accepts a validated single-reader reading that does not go below the baseline, including zero usage', () => {
    expect(isBulkConfirmable(capture)).toBe(true);
    expect(isBulkConfirmable({ ...capture, proposedValue: '110.25' })).toBe(true);
    expect(isBulkConfirmable({ ...capture, proposedValue: '120', previousValue: '119.99' })).toBe(true);
  });
  it.each<[string, Partial<MeterCapture>]>([
    ['not waiting for review', { status: 'CONFIRMED' }],
    ['still queued', { status: 'QUEUED' }],
    ['media not validated', { mediaValidated: false }],
    ['media validation unknown', { mediaValidated: undefined }],
    ['no proposed value', { proposedValue: null }],
    ['no baseline', { previousValue: null }],
    ['a decrease', { proposedValue: '110.24' }],
    ['an abnormal increase', { issues: ['PANEL_SINGLE_READER', 'ABNORMAL_INCREASE'] }],
    ['a replacement of a confirmed reading', { replacement: { id: 'old', version: 4, value: '119' } }],
    ['a superseded reading', { supersededBy: 'newer' }],
    ['no evidence to look at', { evidenceUrl: null, videoUrl: null, evidenceFrames: [] }],
  ])('leaves %s to per-row confirmation', (_case, change) => {
    expect(isBulkConfirmable({ ...capture, ...change })).toBe(false);
  });
  it('accepts clip-only evidence as something the reviewer can look at', () => {
    expect(isBulkConfirmable({ ...capture, evidenceUrl: null, evidenceFrames: [{ imageUrl: '/private/frame', timestampSeconds: 1 }] })).toBe(true);
  });
});

describe('panel child captures', () => {
  it('collects every child capture of every panel and ignores rows without a child', () => {
    const ids = panelChildCaptureIds([{ detections: [detection(0, 'child-a'), detection(1, null)] }, { detections: [detection(0, 'child-b')] }]);
    expect([...ids].sort()).toEqual(['child-a', 'child-b']);
    expect(panelChildCaptureIds([]).size).toBe(0);
  });
});

describe('panel issue labels', () => {
  it('explains panel-level and single-reader issues in Vietnamese and keeps existing labels', () => {
    expect(captureIssueLabel('PANEL_SINGLE_READER')).toBe('Đọc từ clip cả bảng (một bộ đọc AI); cần đối chiếu');
    expect(captureIssueLabel('NO_METERS_DETECTED')).toBe('Không phát hiện đồng hồ nào');
    expect(captureIssueLabel('qr_outside_meters')).toBe('Có tem QR không nằm trên đồng hồ nào');
    expect(captureIssueLabel('WORKER_LEASE_EXHAUSTED')).toBe('Bộ đọc bị gián đoạn nhiều lần; cần kiểm tra hoặc gửi lượt mới');
    expect(captureIssueLabel('MEDIA_VALIDATION_FAILED')).toBe('Ảnh/clip chưa qua kiểm tra định dạng hoặc thời lượng');
  });
});
