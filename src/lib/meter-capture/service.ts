import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { uploadFileDetailed } from '@/lib/storage';
import { confirmedInvoiceReceipt } from '@/lib/invoiceFeedback';
import { meterBillingSourceSchema, meterCaptureMeterSchema, meterCaptureSchema, meterEvidenceSchema,
  meterPanelEvidenceSchema, meterPanelSchema, type MeterCapture, type MeterPanel, type MeterPanelEvidence, type MeterSourceReference } from './types';
export type { MeterCapture, MeterCaptureMeter, MeterCaptureProfile, EngineResult, MeterBillingSource, MeterSourceReference, MeterEvidence,
  MeterPanel, MeterPanelDetection, MeterPanelEvidence } from './types';

const uuid = z.string().uuid();
async function gateway(body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('meter-capture-worker', { body });
  if (error) {
    // Supabase wraps non-2xx responses. Preserve the server code for financial feedback.
    if (error.context instanceof Response) {
      let detail: unknown;
      try {
        detail = await error.context.clone().json();
      } catch {
        // A proxy can return HTML instead of JSON. Keep the original transport error.
        throw error;
      }
      const parsed = z.object({ error: z.string(), code: z.string().optional() }).safeParse(detail);
      if (parsed.success) throw Object.assign(new Error(meterGatewayMessage(parsed.data.error)), { code: parsed.data.code ?? parsed.data.error });
    }
    throw error;
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Không xử lý được chỉ số đồng hồ.');
  }
  return data;
}
function meterGatewayMessage(code: string): string {
  if (code === 'meter_capture_reader_not_enabled') return 'Đọc đồng hồ bằng ảnh/clip chưa được bật. Tiếp tục ghi chỉ số theo cách hiện tại; đăng ký QR sẽ mở khi bộ đọc sẵn sàng.';
  if (code === '42501' || code === 'worker_forbidden') return 'Bạn chưa có quyền thực hiện thao tác này.';
  if (code === 'PT409' || code === '23505') return 'Dữ liệu đã thay đổi hoặc đã được lưu. Tải lại để đối chiếu trước khi tiếp tục.';
  if (code === 'PT422') return 'Chỉ số đã dùng cho thanh lý đã hoàn tất. Cần kế toán và quản lý hợp đồng xử lý điều chỉnh trước; chứng từ cũ được giữ nguyên.';
  if (code === '55000' || code === '22023') return 'Chỉ số hoặc chứng cứ chưa đủ điều kiện. Tải lại và kiểm tra đồng hồ, kỳ chốt.';
  if (code === 'unsupported_action') return 'Máy chủ chưa hỗ trợ thao tác này. Bản trên điện thoại vẫn được giữ; thử lại sau khi hệ thống cập nhật.';
  return 'Chưa xử lý được yêu cầu ghi chỉ số. Giữ bản trên điện thoại và thử lại.';
}
async function call(orgId: string, rpcAction: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  return gateway({ action: 'rpc', organizationId: uuid.parse(orgId), rpcAction, payload });
}
export async function listCaptureCatalog(orgId: string) {
  return z.object({ meters: z.array(meterCaptureMeterSchema) }).parse(await call(orgId, 'catalog')).meters;
}
export async function resolveCaptureQr(orgId: string, qrText: string) {
  return z.object({ meter: meterCaptureMeterSchema }).parse(await call(orgId, 'resolveQr', { qrText })).meter;
}
export async function getMeterCaptureByClientId(clientId: string, orgId: string): Promise<MeterCapture | null> {
  return z.object({ capture: meterCaptureSchema.nullable() }).parse(await call(orgId, 'getCapture', { clientId })).capture;
}
export async function listMeterCaptures(orgId: string, month: string) {
  return z.object({ captures: z.array(meterCaptureSchema) }).parse(await call(orgId, 'listCaptures', { month })).captures;
}
export interface SubmitMeterCaptureInput {
  clientId: string; orgId: string; meterId: string; qrText: string | null; purpose: 'MONTHLY' | 'MOVE_OUT';
  readingDate: string; month: string; contractId?: string | null; capturedAt: string; file: File;
  sha256: string; durationSeconds?: number; onProgress?: (percent: number) => void;
}
export async function submitMeterCapture(input: SubmitMeterCaptureInput): Promise<MeterCapture> {
  const { file, orgId, onProgress } = input;
  const metadata = { clientId: input.clientId, meterId: input.meterId, qrText: input.qrText,
    purpose: input.purpose, readingDate: input.readingDate, month: input.month, contractId: input.contractId ?? null,
    capturedAt: input.capturedAt, sha256: input.sha256, durationSeconds: input.durationSeconds };
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || file.size > 100 * 1024 * 1024 || !file.size) throw new Error('Tệp không hợp lệ hoặc vượt 100 MB.');
  const started = z.object({ capture: meterCaptureSchema, uploadPath: z.string(), bucket: z.string().default('meter-capture-media') })
    .parse(await call(orgId, 'startCapture', { ...metadata, mimeType: file.type, sizeBytes: file.size }));
  const receiptMatches = (capture: MeterCapture) => capture.sha256 === input.sha256 && capture.clientId === input.clientId && capture.orgId === orgId && capture.meterId === input.meterId;
  if (!receiptMatches(started.capture)) throw new Error('Biên nhận không khớp ảnh trên máy.');
  if (started.capture.mediaReceived && started.capture.status !== 'UPLOADING') return started.capture;
  // Reconcile before retry: a previous upload can have succeeded even if its response was lost.
  const reconciled = z.object({ capture: meterCaptureSchema.nullable(), needsUpload: z.boolean().optional() })
    .parse(await gateway({ action: 'finalize', organizationId: orgId, captureId: started.capture.id, allowMissing: true }));
  if (reconciled.capture?.mediaReceived) {
    if (!receiptMatches(reconciled.capture)) throw new Error('Biên nhận tải lại không khớp ảnh trên máy.');
    return reconciled.capture;
  }
  await uploadFileDetailed(started.bucket, started.uploadPath, file, {
    imagePolicy: 'meter-original', maxBytes: 100 * 1024 * 1024,
    resilient: onProgress ? { onProgress: (progress) => onProgress(progress.total ? progress.loaded / progress.total * 100 : 0) } : {},
  });
  const done = z.object({ capture: meterCaptureSchema }).parse(await gateway({ action: 'finalize', organizationId: orgId, captureId: started.capture.id }));
  if (!done.capture.mediaReceived || !receiptMatches(done.capture)) throw new Error('Chưa xác minh được ảnh trên máy chủ; vẫn giữ bản trên điện thoại.');
  return done.capture;
}
export async function confirmMeterCapture(input: { orgId: string; captureId: string; expectedVersion: number; expectedPreviousValue: string | null;
  supersedesCaptureId?: string; expectedSupersededVersion?: number; value: string; reason?: string }) {
  const { orgId, ...payload } = input;
  return z.object({ capture: meterCaptureSchema }).parse(await call(orgId, 'confirmCapture', payload)).capture;
}

type PanelRpcAction = 'startPanel' | 'getPanel' | 'listPanels' | 'assignDetection' | 'panelEvidence';
async function panelCall(orgId: string, rpcAction: PanelRpcAction, payload: Record<string, unknown>): Promise<unknown> {
  return gateway({ action: 'panelRpc', organizationId: uuid.parse(orgId), rpcAction, payload });
}
export interface StartMeterPanelInput {
  clientId: string; buildingId: string; purpose: 'MONTHLY' | 'MOVE_OUT'; readingDate: string; month: string;
  capturedAt: string; sha256: string; mimeType: string; sizeBytes: number; durationSeconds?: number;
}
/** Idempotent per clientId; the same clientId with different facts is rejected by the server. */
export async function startMeterPanel(orgId: string, input: StartMeterPanelInput) {
  return z.object({ panel: meterPanelSchema, uploadPath: z.string(), bucket: z.string().default('meter-capture-media') })
    .parse(await panelCall(orgId, 'startPanel', { ...input }));
}
export async function finalizeMeterPanel(orgId: string, panelId: string, options: { allowMissing?: boolean } = {}) {
  return z.object({ panel: meterPanelSchema.nullable(), needsUpload: z.boolean().optional() })
    .parse(await gateway({ action: 'finalizePanel', organizationId: uuid.parse(orgId), panelId: uuid.parse(panelId), ...(options.allowMissing ? { allowMissing: true } : {}) }));
}
export async function getMeterPanel(orgId: string, ref: { panelId: string } | { clientId: string }): Promise<MeterPanel | null> {
  const payload = 'panelId' in ref ? { panelId: ref.panelId } : { clientId: ref.clientId };
  return z.object({ panel: meterPanelSchema.nullable() }).parse(await panelCall(orgId, 'getPanel', payload)).panel;
}
export async function listMeterPanels(orgId: string, month: string): Promise<MeterPanel[]> {
  return z.object({ panels: z.array(meterPanelSchema) }).parse(await panelCall(orgId, 'listPanels', { month })).panels;
}
/** Creates the child capture for one detection; the reading itself still needs a separate confirmation. */
export async function assignPanelDetection(input: { orgId: string; panelId: string; detectionIndex: number; meterId: string; contractId?: string | null }): Promise<MeterPanel> {
  const { orgId, contractId, ...payload } = input;
  return z.object({ panel: meterPanelSchema }).parse(await panelCall(orgId, 'assignDetection', { ...payload, ...(contractId ? { contractId } : {}) })).panel;
}
export async function getPanelEvidence(orgId: string, panelId: string): Promise<MeterPanelEvidence> {
  return z.object({ evidence: meterPanelEvidenceSchema }).parse(await panelCall(orgId, 'panelEvidence', { panelId })).evidence;
}
export interface SubmitMeterPanelInput {
  clientId: string; orgId: string; buildingId: string; purpose: 'MONTHLY' | 'MOVE_OUT'; readingDate: string; month: string;
  capturedAt: string; file: File; sha256: string; durationSeconds?: number; onProgress?: (percent: number) => void;
}
/** Same receipt boundary as submitMeterCapture: the offline copy is only released for a matching server receipt. */
export async function submitMeterPanel(input: SubmitMeterPanelInput): Promise<MeterPanel> {
  const { file, orgId, onProgress } = input;
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || file.size > 100 * 1024 * 1024 || !file.size) throw new Error('Tệp không hợp lệ hoặc vượt 100 MB.');
  const started = await startMeterPanel(orgId, { clientId: input.clientId, buildingId: input.buildingId, purpose: input.purpose,
    readingDate: input.readingDate, month: input.month, capturedAt: input.capturedAt, sha256: input.sha256,
    mimeType: file.type, sizeBytes: file.size, durationSeconds: input.durationSeconds });
  const receiptMatches = (panel: MeterPanel) => panel.sha256 === input.sha256 && panel.clientId === input.clientId && panel.orgId === orgId && panel.buildingId === input.buildingId;
  if (!receiptMatches(started.panel)) throw new Error('Biên nhận không khớp ảnh trên máy.');
  if (started.panel.mediaReceived && started.panel.status !== 'UPLOADING') return started.panel;
  // Reconcile before retry: a previous upload can have succeeded even if its response was lost.
  const reconciled = await finalizeMeterPanel(orgId, started.panel.id, { allowMissing: true });
  if (reconciled.panel?.mediaReceived) {
    if (!receiptMatches(reconciled.panel)) throw new Error('Biên nhận tải lại không khớp ảnh trên máy.');
    return reconciled.panel;
  }
  if (!started.uploadPath.startsWith(`${orgId}/meter-panels/${started.panel.id}/`)) throw new Error('Đường dẫn tải lên không khớp bảng đồng hồ; vẫn giữ bản trên điện thoại.');
  await uploadFileDetailed(started.bucket, started.uploadPath, file, {
    imagePolicy: 'meter-original', maxBytes: 100 * 1024 * 1024,
    resilient: onProgress ? { onProgress: (progress) => onProgress(progress.total ? progress.loaded / progress.total * 100 : 0) } : {},
  });
  const done = await finalizeMeterPanel(orgId, started.panel.id);
  if (!done.panel?.mediaReceived || !receiptMatches(done.panel)) throw new Error('Chưa xác minh được ảnh trên máy chủ; vẫn giữ bản trên điện thoại.');
  return done.panel;
}
export interface SaveMeterCaptureProfileInput {
  orgId: string; meterId: string; serial: string; displayKind: 'DIGITAL' | 'MECHANICAL'; decimalPlaces: number;
  registerCode: string; referenceFile: File; verified: true; expectedVersion?: number;
}
export async function saveMeterCaptureProfile(input: SaveMeterCaptureProfileInput) {
  const { orgId, referenceFile, ...profile } = input;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw error ?? new Error('Cần đăng nhập.');
  const reference = await uploadFileDetailed('meter-capture-media', `${orgId}/profiles/${input.meterId}/${data.user.id}/${crypto.randomUUID()}`, referenceFile, { imagePolicy: 'meter-original', maxBytes: 20 * 1024 * 1024 });
  return z.object({ qrText: z.string() }).parse(await call(orgId, 'profile', { ...profile, expectedVersion: input.expectedVersion ?? 0, referencePath: reference.path }));
}
export async function revokeMeterCaptureQr(orgId: string, meterId: string, expectedVersion: number, reason = 'Thu hồi tem đồng hồ') {
  return call(orgId, 'revokeQr', { meterId, expectedVersion, reason });
}
export async function rotateMeterCaptureQr(orgId: string, meterId: string, expectedVersion: number, reason = 'Cấp lại tem đồng hồ') {
  return z.object({ qrText: z.string() }).parse(await call(orgId, 'rotateQr', { meterId, expectedVersion, reason }));
}
export async function resolveMeterBilling(orgId: string, input: { contractId: string; month: string; readingDate: string; purpose: 'MONTHLY' | 'MOVE_OUT' }) {
  return z.object({ meters: z.array(meterBillingSourceSchema) }).parse(await call(orgId, 'resolveBilling', input)).meters;
}
export async function readMeterEvidence(orgId: string, captureId: string) {
  return z.object({ evidence: meterEvidenceSchema }).parse(await call(orgId, 'evidence', { captureId })).evidence;
}
export async function readDocumentEvidence(orgId: string, documentId: string, kind: 'INVOICE' | 'EXIT' = 'INVOICE') {
  return z.object({ sources: z.array(z.object({ meterId: uuid, meterName: z.string(), sortOrder: z.number().int().nonnegative().nullable(),
    startCaptureId: uuid.nullable(), endCaptureId: uuid.nullable(), previousReading: z.string(), currentReading: z.string() })) })
    .parse(await call(orgId, 'documentEvidence', { documentId, kind })).sources;
}
export async function createInvoiceWithMeterSources(orgId: string, args: Record<string, unknown>, sources: MeterSourceReference[]) {
  // The JSON document adapter preserves JSON null, whereas the optional writer
  // context uses SQL NULL to mean "no rent support". Omission uses that default.
  const argumentsForWriter = { ...args };
  if (argumentsForWriter.p_rent_support_context == null) delete argumentsForWriter.p_rent_support_context;
  return gateway({ action: 'invoice', organizationId: orgId, arguments: argumentsForWriter, sources });
}
/** Content-derived key survives remounts; a changed intent receives a different key. */
export async function meterInvoiceRequestId(orgId: string, intent: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['meter-invoice-v1', orgId, intent])));
  return 'meter-invoice-' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export async function readSavedMeterInvoiceRequest(orgId: string, idempotencyKey: string) {
  const result = z.object({ receipt: z.unknown().nullable() }).parse(await call(orgId, 'documentReceipt', { kind: 'invoice', idempotencyKey }));
  return result.receipt == null ? null : confirmedInvoiceReceipt(result.receipt);
}
export async function exitWithMeterSources(orgId: string, rpcName: string, args: Record<string, unknown>, sources: MeterSourceReference[]) {
  return gateway({ action: 'exit', organizationId: orgId, rpcName, arguments: args, sources });
}
