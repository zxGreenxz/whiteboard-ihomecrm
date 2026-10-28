import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ invoke: vi.fn(), upload: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock('@/lib/storage', () => ({ uploadFileDetailed: io.upload }));
import { submitMeterCapture, meterInvoiceRequestId, readDocumentEvidence, createInvoiceWithMeterSources,
  submitMeterPanel, getMeterPanel, listMeterPanels, assignPanelDetection, getPanelEvidence } from './service';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64);
const input = { clientId: id(1), orgId: id(2), meterId: id(3), qrText: 'ihome-meter:' + id(4), purpose: 'MONTHLY' as const,
  readingDate: '2026-10-22', month: '2026-10', capturedAt: '2026-10-22T10:00:00Z', sha256: hash,
  file: new File(['synthetic bytes'], 'meter.jpg', { type: 'image/jpeg' }) };
const capture = { id: id(5), clientId: input.clientId, orgId: input.orgId, meterId: input.meterId, version: 1, status: 'UPLOADING',
  proposedValue: null, issues: [], serverResult: null, aiResult: null, evidenceUrl: null, videoUrl: null, confirmedReadingId: null,
  readingDate: input.readingDate, month: input.month, purpose: input.purpose, capturedAt: input.capturedAt, sha256: hash, mediaReceived: false };
const reply = (data: unknown) => ({ data, error: null });
beforeEach(() => { vi.resetAllMocks(); });
describe('media receipt boundary', () => {
  it('uses the SQL default for absent rent support without mutating the invoice intent or discarding a real support context', async () => {
    io.invoke.mockResolvedValue(reply({invoice_id:id(8)}));
    const args={p_idempotency_key:'meter-invoice-fixture',p_rent_support_context:null,p_previous_debt_sources:[]};
    await createInvoiceWithMeterSources(id(2),args,[]);
    expect(io.invoke.mock.calls[0][1].body.arguments).toEqual({p_idempotency_key:args.p_idempotency_key,p_previous_debt_sources:[]});
    expect(args).toHaveProperty('p_rent_support_context',null);
    const context={version:1,expected_plan_revision:2,manual_discount_amount:'0',request_id:id(9)};
    await createInvoiceWithMeterSources(id(2),{...args,p_rent_support_context:context},[]);
    expect(io.invoke.mock.calls[1][1].body.arguments.p_rent_support_context).toEqual(context);
  });
  it('explains a staged rollout without uploading or activating a capture', async () => {
    io.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: 'meter_capture_reader_not_enabled' }), { status: 503 }) } });
    await expect(submitMeterCapture(input)).rejects.toThrow('Tiếp tục ghi chỉ số theo cách hiện tại');
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('keeps zero-usage settlement evidence even when no charge line exists on the invoice', async () => {
    io.invoke.mockResolvedValueOnce(reply({ sources: [{ meterId: id(3), meterName: 'Điện phòng A', sortOrder: null,
      startCaptureId: id(4), endCaptureId: id(5), previousReading: '120.25', currentReading: '120.25' }] }));
    const evidence = await readDocumentEvidence(id(2), id(6));
    expect(evidence[0]).toMatchObject({ sortOrder: null, currentReading: '120.25', endCaptureId: id(5) });
  });
  it('reconciles an already uploaded original before attempting storage again', async () => {
    io.invoke.mockResolvedValueOnce(reply({ capture, uploadPath: 'original' }))
      .mockResolvedValueOnce(reply({ capture: { ...capture, mediaReceived: true } }));
    const saved = await submitMeterCapture(input);
    expect(saved.mediaReceived).toBe(true); expect(io.upload).not.toHaveBeenCalled();
    expect(io.invoke.mock.calls[0][1].body).toMatchObject({ rpcAction: 'startCapture', payload: { sha256: hash, sizeBytes: input.file.size } });
  });
  it('sends the original file and waits for a matching server receipt', async () => {
    io.invoke.mockResolvedValueOnce(reply({ capture, uploadPath: 'original' })).mockResolvedValueOnce(reply({ capture: null, needsUpload: true }))
      .mockResolvedValueOnce(reply({ capture: { ...capture, mediaReceived: true } }));
    await submitMeterCapture(input);
    expect(io.upload).toHaveBeenCalledWith('meter-capture-media', 'original', input.file, expect.objectContaining({ imagePolicy: 'meter-original' }));
  });
  it('finishes queuing a received original if the previous finalize request was interrupted', async () => {
    io.invoke.mockResolvedValueOnce(reply({ capture: { ...capture, mediaReceived: true }, uploadPath: 'original' }))
      .mockResolvedValueOnce(reply({ capture: { ...capture, mediaReceived: true, status: 'QUEUED' } }));
    expect((await submitMeterCapture(input)).status).toBe('QUEUED');
    expect(io.invoke).toHaveBeenCalledTimes(2); expect(io.upload).not.toHaveBeenCalled();
  });
  it.each(['sha256', 'orgId', 'meterId', 'clientId'])('does not acknowledge a mismatched reconciliation %s', async key => {
    io.invoke.mockResolvedValueOnce(reply({ capture, uploadPath: 'original' }))
      .mockResolvedValueOnce(reply({ capture: { ...capture, [key]: key === 'sha256' ? 'b'.repeat(64) : id(99), mediaReceived: true } }));
    await expect(submitMeterCapture(input)).rejects.toThrow('không khớp'); expect(io.upload).not.toHaveBeenCalled();
  });
  it('retains uncertainty if upload succeeds but final receipt is lost', async () => {
    io.invoke.mockResolvedValueOnce(reply({ capture, uploadPath: 'original' })).mockResolvedValueOnce(reply({ capture: null, needsUpload: true }))
      .mockResolvedValueOnce({ data: null, error: new TypeError('network') });
    await expect(submitMeterCapture(input)).rejects.toThrow('network'); expect(io.upload).toHaveBeenCalledOnce();
  });
  it('keeps structured server errors available to financial recovery', async () => {
    io.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: 'PT409' }), { status: 409 }) } });
    await expect(submitMeterCapture(input)).rejects.toMatchObject({ code: 'PT409' });
  });
  it('reuses invoice retry keys across mounts but separates organizations and changed sources', async () => {
    const first = await meterInvoiceRequestId(id(2), { reading: id(5) });
    expect(first).toBe(await meterInvoiceRequestId(id(2), { reading: id(5) }));
    expect(first).not.toBe(await meterInvoiceRequestId(id(3), { reading: id(5) }));
    expect(first).not.toBe(await meterInvoiceRequestId(id(2), { reading: id(6) }));
  });
});

const panelFile = new File(['synthetic panel clip'], 'panel.mp4', { type: 'video/mp4' });
const panelInput = { clientId: id(11), orgId: id(2), buildingId: id(12), purpose: 'MONTHLY' as const, readingDate: '2026-10-22',
  month: '2026-10', capturedAt: '2026-10-22T10:00:00Z', sha256: hash, durationSeconds: 12, file: panelFile };
const panel = { id: id(10), clientId: panelInput.clientId, orgId: panelInput.orgId, buildingId: panelInput.buildingId, buildingName: 'Tòa mẫu',
  purpose: 'MONTHLY', readingDate: panelInput.readingDate, month: panelInput.month, capturedAt: panelInput.capturedAt, status: 'UPLOADING',
  version: 1, mimeType: 'video/mp4', sizeBytes: panelFile.size, sha256: hash, durationSeconds: 12, mediaReceived: false, mediaValidated: null,
  issues: [], createdAt: '2026-10-22T10:00:01Z', aiStatus: null, detections: [] };
const panelPath = `${panelInput.orgId}/meter-panels/${panel.id}/original`;
const detection = { index: 0, label: 'P101', registerCode: '1.8.0', display: 'digital', value: '1234.5', clear: true, state: 'MATCHED',
  matchKind: 'QR', meterId: id(3), roomId: id(13), roomName: '101', meterCode: 'E-101', captureId: id(14),
  cropUrl: 'https://example.supabase.co/storage/v1/object/authenticated/meter-capture-media/crop.jpg', timestampSeconds: 3.5 };
describe('panel media receipt boundary', () => {
  it('starts through the panel gateway, uploads the original only after reconciliation finds it missing, then finalizes', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panel, uploadPath: panelPath, bucket: 'meter-capture-media' }))
      .mockResolvedValueOnce(reply({ panel: null, needsUpload: true }))
      .mockResolvedValueOnce(reply({ panel: { ...panel, mediaReceived: true, status: 'QUEUED' } }));
    expect((await submitMeterPanel(panelInput)).status).toBe('QUEUED');
    const bodies = io.invoke.mock.calls.map(call => call[1].body);
    expect(io.invoke.mock.calls[0][0]).toBe('meter-capture-worker');
    expect(bodies[0]).toEqual({ action: 'panelRpc', organizationId: panelInput.orgId, rpcAction: 'startPanel', payload: {
      clientId: panelInput.clientId, buildingId: panelInput.buildingId, purpose: 'MONTHLY', readingDate: '2026-10-22', month: '2026-10',
      capturedAt: panelInput.capturedAt, sha256: hash, mimeType: 'video/mp4', sizeBytes: panelFile.size, durationSeconds: 12 } });
    expect(bodies[1]).toEqual({ action: 'finalizePanel', organizationId: panelInput.orgId, panelId: panel.id, allowMissing: true });
    expect(bodies[2]).toEqual({ action: 'finalizePanel', organizationId: panelInput.orgId, panelId: panel.id });
    expect(io.upload).toHaveBeenCalledExactlyOnceWith('meter-capture-media', panelPath, panelFile, expect.objectContaining({ imagePolicy: 'meter-original' }));
  });
  it('reconciles an already uploaded panel original instead of uploading it again', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panel, uploadPath: panelPath }))
      .mockResolvedValueOnce(reply({ panel: { ...panel, mediaReceived: true, status: 'QUEUED' } }));
    expect((await submitMeterPanel(panelInput)).mediaReceived).toBe(true);
    expect(io.upload).not.toHaveBeenCalled(); expect(io.invoke).toHaveBeenCalledTimes(2);
  });
  it('returns a received and queued panel without another finalize call', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panel: { ...panel, mediaReceived: true, status: 'PROCESSING' }, uploadPath: panelPath }));
    expect((await submitMeterPanel(panelInput)).status).toBe('PROCESSING');
    expect(io.invoke).toHaveBeenCalledOnce(); expect(io.upload).not.toHaveBeenCalled();
  });
  it.each(['sha256', 'orgId', 'clientId', 'buildingId'])('does not accept a mismatched panel reconciliation %s', async key => {
    io.invoke.mockResolvedValueOnce(reply({ panel, uploadPath: panelPath }))
      .mockResolvedValueOnce(reply({ panel: { ...panel, [key]: key === 'sha256' ? 'b'.repeat(64) : id(99), mediaReceived: true, status: 'QUEUED' } }));
    await expect(submitMeterPanel(panelInput)).rejects.toThrow('không khớp'); expect(io.upload).not.toHaveBeenCalled();
  });
  it.each(['sha256', 'orgId', 'clientId', 'buildingId'])('does not upload against a mismatched start receipt %s', async key => {
    io.invoke.mockResolvedValueOnce(reply({ panel: { ...panel, [key]: key === 'sha256' ? 'b'.repeat(64) : id(99) }, uploadPath: panelPath }));
    await expect(submitMeterPanel(panelInput)).rejects.toThrow('không khớp');
    expect(io.invoke).toHaveBeenCalledOnce(); expect(io.upload).not.toHaveBeenCalled();
  });
  it('retains the original when the final receipt after upload names another original', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panel, uploadPath: panelPath })).mockResolvedValueOnce(reply({ panel: null, needsUpload: true }))
      .mockResolvedValueOnce(reply({ panel: { ...panel, sha256: 'c'.repeat(64), mediaReceived: true, status: 'QUEUED' } }));
    await expect(submitMeterPanel(panelInput)).rejects.toThrow('Chưa xác minh được ảnh trên máy chủ'); expect(io.upload).toHaveBeenCalledOnce();
  });
  it('refuses to upload a panel original outside its own server path', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panel, uploadPath: `${panelInput.orgId}/meter-captures/${panel.id}/original` }))
      .mockResolvedValueOnce(reply({ panel: null, needsUpload: true }));
    await expect(submitMeterPanel(panelInput)).rejects.toThrow('Đường dẫn tải lên'); expect(io.upload).not.toHaveBeenCalled();
  });
  it('rejects an invalid original before reserving a panel', async () => {
    await expect(submitMeterPanel({ ...panelInput, sha256: 'not-a-hash' })).rejects.toThrow('Tệp không hợp lệ');
    expect(io.invoke).not.toHaveBeenCalled();
  });
  it('keeps the server code when the gateway does not support panels yet', async () => {
    io.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: 'unsupported_action' }), { status: 400 }) } });
    await expect(listMeterPanels(id(2), '2026-10')).rejects.toMatchObject({ code: 'unsupported_action', message: expect.stringContaining('Máy chủ chưa hỗ trợ') });
  });
  it('reads, lists, assigns and opens panel evidence through typed panel actions', async () => {
    const reviewed = { ...panel, status: 'REVIEW', mediaReceived: true, mediaValidated: true, aiStatus: 'ok', detections: [detection] };
    io.invoke.mockResolvedValueOnce(reply({ panel: null })).mockResolvedValueOnce(reply({ panels: [reviewed] }))
      .mockResolvedValueOnce(reply({ panel: reviewed })).mockResolvedValueOnce(reply({ panel: reviewed }))
      .mockResolvedValueOnce(reply({ evidence: { imageUrl: null, videoUrl: 'https://signed/clip', frames: [{ timestampSeconds: 2, imageUrl: 'https://signed/frame' }] } }));
    expect(await getMeterPanel(id(2), { clientId: panel.clientId })).toBeNull();
    const [listed] = await listMeterPanels(id(2), '2026-10');
    expect(listed.detections[0]).toMatchObject({ state: 'MATCHED', matchKind: 'QR', captureId: id(14), cropUrl: detection.cropUrl, timestampSeconds: 3.5 });
    await assignPanelDetection({ orgId: id(2), panelId: panel.id, detectionIndex: 1, meterId: id(3) });
    await assignPanelDetection({ orgId: id(2), panelId: panel.id, detectionIndex: 2, meterId: id(3), contractId: id(15) });
    expect((await getPanelEvidence(id(2), panel.id)).frames).toEqual([{ timestampSeconds: 2, imageUrl: 'https://signed/frame' }]);
    expect(io.invoke.mock.calls.map(call => [call[1].body.rpcAction, call[1].body.payload])).toEqual([
      ['getPanel', { clientId: panel.clientId }], ['listPanels', { month: '2026-10' }],
      ['assignDetection', { panelId: panel.id, detectionIndex: 1, meterId: id(3) }],
      ['assignDetection', { panelId: panel.id, detectionIndex: 2, meterId: id(3), contractId: id(15) }],
      ['panelEvidence', { panelId: panel.id }]]);
    expect(io.invoke.mock.calls.every(call => call[1].body.action === 'panelRpc' && call[1].body.organizationId === id(2))).toBe(true);
  });
  it('rejects a panel listing whose detection state is outside the contract instead of guessing', async () => {
    io.invoke.mockResolvedValueOnce(reply({ panels: [{ ...panel, status: 'REVIEW', detections: [{ ...detection, state: 'MAYBE' }] }] }));
    await expect(listMeterPanels(id(2), '2026-10')).rejects.toThrow();
  });
});
