import type { MeterCapture, MeterPanel } from './types';

/** Child captures are reviewed inside their panel card; the flat review list must not show them twice. */
export function panelChildCaptureIds(panels: Array<Pick<MeterPanel, 'detections'>>): Set<string> {
  const ids = new Set<string>();
  for (const panel of panels) for (const detection of panel.detections) if (detection.captureId) ids.add(detection.captureId);
  return ids;
}

export type BulkConfirmableCapture = MeterCapture & { proposedValue: string; previousValue: string };

/**
 * "Xác nhận tất cả" only covers the plain case: a validated reading with evidence that does not go
 * below the stored baseline, is not flagged as an abnormal increase and does not replace an earlier
 * confirmation. Everything else stays a per-row decision in MeterCaptureReview.
 */
export function isBulkConfirmable(capture: MeterCapture): capture is BulkConfirmableCapture {
  const { proposedValue, previousValue } = capture;
  if (capture.status !== 'REVIEW' || capture.mediaValidated !== true || capture.replacement || capture.supersededBy) return false;
  if (proposedValue == null || !/^\d+(\.\d+)?$/.test(proposedValue) || previousValue == null) return false;
  if (!capture.evidenceUrl && !capture.videoUrl && !capture.evidenceFrames.length) return false;
  return Number(proposedValue) >= Number(previousValue) && !capture.issues.includes('ABNORMAL_INCREASE');
}
