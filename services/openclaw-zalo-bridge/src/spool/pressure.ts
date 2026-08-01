/**
 * Spool back-pressure ladder. The spool never drops the oldest text or event to
 * make room: it degrades what it accepts instead.
 */

export const SPOOL_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export type PressureLevel = "NORMAL" | "PAUSE_NONESSENTIAL" | "MINIMAL_ONLY" | "STOP_INTAKE";

export interface PressureState {
  level: PressureLevel;
  usedRatio: number;
  outboundAllowed: boolean;
  historySyncAllowed: boolean;
  mediaPrefetchAllowed: boolean;
  minimalEnvelopeOnly: boolean;
  intakeStopped: boolean;
  ready: boolean;
  /** Emitted exactly once when intake stops, so the gap is auditable. */
  gapStarted: boolean;
}

export function evaluatePressure(usedBytes: number, maxBytes = SPOOL_MAX_BYTES): PressureState {
  const usedRatio = maxBytes <= 0 ? 1 : usedBytes / maxBytes;

  if (usedRatio >= 1) {
    return {
      level: "STOP_INTAKE",
      usedRatio,
      outboundAllowed: false,
      historySyncAllowed: false,
      mediaPrefetchAllowed: false,
      minimalEnvelopeOnly: true,
      intakeStopped: true,
      ready: false,
      gapStarted: true,
    };
  }
  if (usedRatio >= 0.95) {
    return {
      level: "MINIMAL_ONLY",
      usedRatio,
      outboundAllowed: false,
      historySyncAllowed: false,
      mediaPrefetchAllowed: false,
      minimalEnvelopeOnly: true,
      intakeStopped: false,
      ready: true,
      gapStarted: false,
    };
  }
  if (usedRatio >= 0.8) {
    return {
      level: "PAUSE_NONESSENTIAL",
      usedRatio,
      outboundAllowed: false,
      historySyncAllowed: false,
      mediaPrefetchAllowed: false,
      minimalEnvelopeOnly: false,
      intakeStopped: false,
      ready: true,
      gapStarted: false,
    };
  }
  return {
    level: "NORMAL",
    usedRatio,
    outboundAllowed: true,
    historySyncAllowed: true,
    mediaPrefetchAllowed: true,
    minimalEnvelopeOnly: false,
    intakeStopped: false,
    ready: true,
    gapStarted: false,
  };
}