import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ persistError: null, result: { ok: true, status: 'sent' }, writes: [] }));
vi.mock('../lib/ctx.js', () => ({
  log: () => {},
  sb: {
    storage: { from: () => ({ download: async () => ({ data: new Blob(['audio']), error: null }) }) },
    rpc: async (name, args) => {
      fixture.writes.push({ name, args });
      return { data: fixture.result, error: fixture.persistError };
    },
  },
}));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: 'instance' }));
import { sendMediaJob } from '../lib/media.js';

const job = { id: 'job', account_id: 'account', message_id: 'message' };
const payload = { type: 'voice', attachments: [{ path: 'account/voice.ogg' }] };
const apiFor = () => ({
  uploadAttachment: vi.fn().mockResolvedValue([{ fileUrl: 'https://example.test/audio' }]),
  sendVoice: vi.fn().mockResolvedValue({ msgId: 'voice-id' }),
  sendMessage: vi.fn().mockResolvedValue({ attachment: [{ msgId: 'file-id' }] }),
});

beforeEach(() => { fixture.persistError = null; fixture.result = { ok: true, status: 'sent' }; fixture.writes.length = 0; });
describe('voice delivery keeps provider effects separate from persistence', () => {
  it.each([5, 8])('sends all %i room images in ONE native album call and maps every receipt in order', async count => {
    const api = apiFor();
    const ids = Array.from({ length: count }, (_, i) => i ? `image-${i}` : job.message_id);
    const attachments = ids.map((_, i) => ({ path: `account/${i}.jpg`, filename: `${i}.jpg`, width: 640, height: 480 }));
    api.sendMessage.mockResolvedValue({ attachment: ids.map((_, i) => ({ msgId: `provider-${i}`, cliMsgId: `client-${i}` })) });
    await sendMediaJob({ api }, job, { type: 'image', body: '', message_ids: ids, attachments }, 'room-group', 1);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0][0].attachments.map(a => a.filename)).toEqual(attachments.map(a => a.filename));
    expect(api.sendMessage.mock.calls[0]).toMatchObject([{ msg: '' }, 'room-group', 1]);
    expect(fixture.writes[0].args.p_receipts).toEqual(ids.map((id, i) => ({ message_id: id, zalo_msg_id: `provider-${i}`, cli_msg_id: `client-${i}` })));
  });
  it('does not send a second file after voice succeeds but DB persistence fails', async () => {
    fixture.persistError = { message: 'database unavailable' };
    const api = apiFor();
    await expect(sendMediaJob({ api }, job, payload, 'thread', 0)).rejects.toThrow('database unavailable');
    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('does not blindly resend an ambiguous provider timeout as a file', async () => {
    const api = apiFor();
    api.sendVoice.mockRejectedValue(new Error('provider timeout'));
    await expect(sendMediaJob({ api }, job, payload, 'thread', 0)).rejects.toThrow('provider timeout');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('records the voice once when provider and persistence succeed', async () => {
    const api = apiFor();
    await sendMediaJob({ api }, job, payload, 'thread', 0);
    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([{ name: 'zalo_worker_finalize_send_v1', args: {
      p_job_id: 'job', p_instance_id: 'instance', p_receipts: [{ message_id: 'message', zalo_msg_id: 'voice-id', cli_msg_id: null }],
    } }]);
  });
  it('does not accept an unsuccessful finalize response as sent', async () => {
    fixture.result = { ok: false, reason: 'claim_changed' };
    const api = apiFor();
    await expect(sendMediaJob({ api }, job, payload, 'thread', 0)).rejects.toThrow('claim_changed');
    expect(api.sendVoice).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('does not map the second album ID onto the first image when its receipt is missing', async () => {
    const api = apiFor();
    api.sendMessage.mockResolvedValue({ attachment: [{}, { msgId: 'second-image' }] });
    await expect(sendMediaJob({ api }, job, { type: 'image', message_ids: ['message', 'message-2'], attachments: [{ path: 'account/1.jpg' }, { path: 'account/2.jpg' }] }, 'thread', 0)).rejects.toThrow('PROVIDER_RECEIPT_MISSING');
    expect(fixture.writes).toEqual([]);
  });
  it('requires reconciliation instead of sent when voice returns no provider ID', async () => {
    const api = apiFor(); api.sendVoice.mockResolvedValue({});
    await expect(sendMediaJob({ api }, job, payload, 'thread', 0)).rejects.toThrow('PROVIDER_RECEIPT_MISSING');
    expect(api.sendVoice).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });
  it('requires reconciliation when album receipt count is ambiguous', async () => {
    const api = apiFor();
    await expect(sendMediaJob({ api }, job, { type: 'image', message_ids: ['message', 'message-2'], attachments: [{ path: 'account/1.jpg' }, { path: 'account/2.jpg' }] }, 'thread', 0)).rejects.toThrow('PROVIDER_RECEIPT_MISMATCH');
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
  });
});
