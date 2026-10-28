import type { MeterCapture, MeterPanel } from './types';

/** Child captures are reviewed inside their panel card; the flat review list must not show them twice. */
export function panelChildCaptureIds(panels: Array<Pick<MeterPanel, 'detections'>>): Set<string> {
  const ids = new Set<string>();
  for (const panel of panels) for (const detection of panel.detections) if (detection.captureId) ids.add(detection.captureId);
  return ids;
}

export type BulkConfirmableCapture = MeterCapture & { proposedValue: string; previousValue: string };

/**
 * Issues that keep a row out of "Xác nhận tất cả": an abnormal jump, no history to detect one
 * (e.g. a lost decimal point), a register/decimal mismatch confirmCapture always rejects, and
 * media already used by another capture.
 */
const PER_ROW_ISSUES = ['ABNORMAL_INCREASE', 'BASELINE_UNAVAILABLE', 'WRONG_REGISTER_OR_VALUE', 'DECIMAL_MISMATCH', 'DUPLICATE_MEDIA'];

/**
 * "Xác nhận tất cả" only covers the plain monthly case: a validated reading with evidence that does
 * not go below the stored baseline, carries none of PER_ROW_ISSUES and does not replace an earlier
 * confirmation. Everything else (including move-out readings) stays a per-row decision in MeterCaptureReview.
 */
export function isBulkConfirmable(capture: MeterCapture): capture is BulkConfirmableCapture {
  const { proposedValue, previousValue } = capture;
  if (capture.status !== 'REVIEW' || capture.purpose !== 'MONTHLY' || capture.mediaValidated !== true || capture.replacement || capture.supersededBy) return false;
  if (proposedValue == null || !/^\d+(\.\d+)?$/.test(proposedValue) || previousValue == null) return false;
  if (!capture.evidenceUrl && !capture.videoUrl && !capture.evidenceFrames.length) return false;
  return Number(proposedValue) >= Number(previousValue) && !capture.issues.some(issue => PER_ROW_ISSUES.includes(issue));
}
