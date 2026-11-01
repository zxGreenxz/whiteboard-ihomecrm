import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ invoke: vi.fn(), upload: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock('@/lib/storage', () => ({ uploadFileDetailed: io.upload }));
import { submitMeterCapture, meterInvoiceRequestId, readDocumentEvidence } from './service';
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
