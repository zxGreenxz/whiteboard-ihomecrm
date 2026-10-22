import { z } from 'zod';

const uuid = z.string().uuid();
export const meterValueSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/);
export const meterCaptureProfileSchema = z.object({
  serial: z.string(), displayKind: z.enum(['DIGITAL', 'MECHANICAL']),
  decimalPlaces: z.number().int().min(0).max(2), registerCode: z.string(), version: z.number().int(),
});
export type MeterCaptureProfile = z.infer<typeof meterCaptureProfileSchema>;
export const meterCaptureMeterSchema = z.object({
  id: uuid, orgId: uuid, buildingId: uuid, buildingName: z.string(), roomId: uuid.nullable(),
  roomName: z.string().nullable(), code: z.string(), qrText: z.string().nullable(),
  profile: meterCaptureProfileSchema.nullable(),
});
export type MeterCaptureMeter = z.infer<typeof meterCaptureMeterSchema>;
export const engineResultSchema = z.object({
  value: meterValueSchema.nullable(), registerCode: z.string().nullable(), unit: z.string().nullable(),
  status: z.string(), frames: z.array(z.object({ timestampSeconds: z.number().nonnegative(), objectKey: z.string().optional() })).optional(),
}).passthrough();
export type EngineResult = z.infer<typeof engineResultSchema>;
export const meterCaptureSchema = z.object({
  id: uuid, clientId: uuid, orgId: uuid, meterId: uuid, version: z.number().int(),
  status: z.enum(['UPLOADING', 'QUEUED', 'PROCESSING', 'REVIEW', 'CONFIRMED', 'FAILED']),
  proposedValue: meterValueSchema.nullable(), issues: z.array(z.string()),
  serverResult: engineResultSchema.nullable(), aiResult: engineResultSchema.nullable(),
  evidenceUrl: z.string().nullable(), videoUrl: z.string().nullable(),
  confirmedReadingId: uuid.nullable(), readingDate: z.string(), month: z.string(),
  purpose: z.enum(['MONTHLY', 'MOVE_OUT']), capturedAt: z.string(),
  sha256: z.string(), mediaReceived: z.boolean(), mediaValidated: z.boolean().optional(),
});
export type MeterCapture = z.infer<typeof meterCaptureSchema>;

export const meterEvidenceSchema = z.object({
  captureId: uuid, imageUrl: z.string().nullable(), videoUrl: z.string().nullable(),
  timestampSeconds: z.number().nonnegative().nullable().optional(),
});
export type MeterEvidence = z.infer<typeof meterEvidenceSchema>;
export const meterPointSchema = z.object({
  readingId: uuid.nullable(), value: z.union([meterValueSchema, z.number().finite().nonnegative()]).transform(String),
  version: z.union([z.string(), z.number()]).transform(String), captureId: uuid.nullable(),
  readingDate: z.string(), kind: z.string().optional(),
});
export type MeterPoint = z.infer<typeof meterPointSchema>;
export const meterBillingSourceSchema = z.object({
  meterId: uuid, meterName: z.string(), meterType: z.string(), serviceId: uuid.nullable(),
  decimalPlaces: z.number().int(), registerCode: z.string(),
  start: meterPointSchema.nullable(), end: meterPointSchema.nullable(), issues: z.array(z.string()),
});
export type MeterBillingSource = z.infer<typeof meterBillingSourceSchema>;
export const meterSourceReferenceSchema = z.object({
  meterId: uuid, contractId: uuid, month: z.string(), readingDate: z.string(),
  purpose: z.enum(['MONTHLY', 'MOVE_OUT']), startReadingId: uuid.nullable(), startVersion: z.string(),
  endReadingId: uuid, endVersion: z.string(), previousReading: meterValueSchema,
  currentReading: meterValueSchema, sortOrder: z.number().int().nonnegative(),
});
export type MeterSourceReference = z.infer<typeof meterSourceReferenceSchema>;

export function meterSourceReference(source: MeterBillingSource, context: {
  contractId: string; month: string; readingDate: string; purpose: 'MONTHLY' | 'MOVE_OUT'; sortOrder: number;
}): MeterSourceReference {
  if (!source.start || !source.end?.readingId || source.issues.length) throw new Error('Chỉ số chưa đủ điều kiện lập hóa đơn.');
  return meterSourceReferenceSchema.parse({ ...context, meterId: source.meterId,
    startReadingId: source.start.readingId, startVersion: source.start.version,
    endReadingId: source.end.readingId, endVersion: source.end.version,
    previousReading: source.start.value, currentReading: source.end.value });
}
