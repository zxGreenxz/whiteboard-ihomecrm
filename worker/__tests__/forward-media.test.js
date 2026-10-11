import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ receipts: [], persistError: null }));
vi.mock('../lib/ctx.js', () => ({
  SUPABASE_URL: 'https://storage.example.test', log: () => {},
  sb: { rpc: async (name, args) => { state.receipts.push({ name, args }); return { data: { ok: true, status: 'sent' }, error: state.persistError }; } },
}));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: 'instance' }));
import { downloadForwardUrl, imageDetails, sendForwardMediaJob } from '../lib/forward-media.js';
import { readForwardSources } from '../lib/forward-source.js';
import { validateZaloCommandScope } from '../lib/scope-guard.js';

const png = () => { const data = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(data); data.writeUInt32BE(640,16); data.writeUInt32BE(480,20); return data; };
function fixture(kind = 'image', count = 1) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `source-${index}`, account_id: 'source-account', organization_id: 'org', conversation_id: 'source-conv',
    msg_type: kind, media_url: `https://photo.zdn.vn/${index}`, media_meta: kind === 'video' ? { thumb: 'https://photo.zdn.vn/thumb', duration: 5000 } : null,
    media_label: kind === 'file' ? 'Bang-gia.pdf' : null, body: kind === 'image' ? 'Ảnh phòng' : null, status: 'delivered', hidden_at: null,
  }));
  const job = { id: 'job', account_id: 'target-account', organization_id: 'org', conversation_id: 'target-conv', message_id: 'target-0',
    payload: { kind: 'forward_media', source_message_ids: rows.map(row => row.id), message_ids: rows.map((_, index) => `target-${index}`) } };
  if (kind === 'image' && count > 1) { job.payload.caption_message_id = 'caption'; job.payload.caption = 'Ảnh phòng'; job.payload.message_ids.push('caption'); }
  const tables = {
    zalo_messages: [...rows, ...job.payload.message_ids.map(id => ({ id, account_id: 'target-account', organization_id: 'org', conversation_id: 'target-conv', direction: 'out' }))],
    zalo_accounts: [{ id: 'source-account', organization_id: 'org' }, { id: 'target-account', organization_id: 'org', status: 'connected' }],
    zalo_conversations: [{ id: 'source-conv', account_id: 'source-account', organization_id: 'org' }, { id: 'target-conv', account_id: 'target-account', organization_id: 'org', thread_id: 'recipient', thread_type: 'group' }],
  };
  const db = {
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.example.test/storage/v1/object/sign/zalo-media/source-account/file?token=temporary' }, error: null }) })) },
    from: table => {
      const filters = [];
      const query = { select: () => query, eq: (key, value) => { filters.push([key,value]); return query; },
        maybeSingle: async () => ({ data: tables[table].find(row => filters.every(([key,value]) => row[key] === value)) || null, error: null }) };
      return query;
    },
  };
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message: count > 1 ? { msgId: 'caption-result' } : null, attachment: rows.map((_,index) => ({ msgId: `provider-${index}` })) }),
    uploadAttachment: vi.fn().mockResolvedValue([{ fileUrl: 'https://file.dlfl.vn/upload', normalUrl: 'https://photo.zdn.vn/upload' }]),
    sendVoice: vi.fn().mockResolvedValue({ msgId: 'voice-result' }), sendVideo: vi.fn().mockResolvedValue({ msgId: 'video-result' }),
  };
  const download = vi.fn().mockImplementation(async url => ({ data: kind === 'image' || url.endsWith('/thumb') ? png() : Buffer.from('contents'), mime: 'application/octet-stream' }));
  return { rows, job, tables, db, api, download, send: () => sendForwardMediaJob({ api }, job, 'recipient', 1, { db, download }) };
}
beforeEach(() => { state.receipts.length = 0; state.persistError = null; });

describe('forwarding reads trusted source rows and preserves media', () => {
  it('allows a different source account in the same organization and sends using the checked destination', async () => {
    const f = fixture();
    expect((await validateZaloCommandScope(f.job, f.db)).ok).toBe(true);
    await f.send();
    expect(f.api.sendMessage).toHaveBeenCalledWith({ msg: 'Ảnh phòng', attachments: [expect.objectContaining({ filename: 'anh.png', metadata: { width: 640, height: 480, totalSize: 32 } })] }, 'recipient', 1);
    expect(state.receipts[0].args.p_receipts).toEqual([{ message_id: 'target-0', zalo_msg_id: 'provider-0', cli_msg_id: null }]);
  });
  it('preserves every album image and maps the separate caption receipt explicitly', async () => {
    const f = fixture('image', 3); await f.send();
    expect(f.api.sendMessage).toHaveBeenCalledOnce();
    expect(f.api.sendMessage.mock.calls[0][0].attachments).toHaveLength(3);
    expect(f.api.sendMessage.mock.calls[0][0].msg).toBe('Ảnh phòng');
    expect(state.receipts[0].args.p_receipts.map(row => [row.message_id, row.zalo_msg_id])).toEqual([
      ['target-0','provider-0'], ['target-1','provider-1'], ['target-2','provider-2'], ['caption', 'caption-result'],
    ]);
  });
  it('keeps file names and file delivery without forwarding the source URL as text', async () => {
    const f = fixture('file'); await f.send();
    expect(f.api.sendMessage.mock.calls[0][0]).toMatchObject({ msg: '', attachments: [{ filename: 'Bang-gia.pdf' }] });
  });
  it('retains a real file caption with its own canonical receipt', async () => {
    const f = fixture('file'); f.job.payload.caption_message_id = 'caption'; f.job.payload.caption = 'Bảng giá mới'; f.job.payload.message_ids.push('caption');
    f.api.sendMessage.mockResolvedValue({ message: { msgId: 'file-caption' }, attachment: [{ msgId: 'file-provider' }] });
    await f.send();
    expect(f.api.sendMessage.mock.calls[0][0].msg).toBe('Bảng giá mới');
    expect(state.receipts[0].args.p_receipts.map(row => [row.message_id,row.zalo_msg_id])).toEqual([['target-0','file-provider'],['caption','file-caption']]);
  });
  it('uploads voice bytes and calls sendVoice once, without sendMessage fallback', async () => {
    const f = fixture('voice'); await f.send();
    expect(f.api.uploadAttachment).toHaveBeenCalledOnce();
    expect(f.api.sendVoice).toHaveBeenCalledWith({ voiceUrl: 'https://file.dlfl.vn/upload' }, 'recipient', 1);
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it('uploads video and thumbnail then sends a video, not an mp4 file', async () => {
    const f = fixture('video'); await f.send();
    expect(f.api.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(f.api.sendVideo).toHaveBeenCalledWith({ videoUrl: 'https://file.dlfl.vn/upload', thumbnailUrl: 'https://photo.zdn.vn/upload', duration: 5000, msg: '' }, 'recipient', 1);
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(state.receipts[0].args.p_receipts[0].zalo_msg_id).toBe('video-result');
  });
  it('requires a readable video thumbnail before contacting the provider', async () => {
    const f = fixture('video'); f.rows[0].media_meta = {};
    await expect(f.send()).rejects.toThrow('thiếu ảnh xem trước');
    expect(f.api.uploadAttachment).not.toHaveBeenCalled();
  });
  it('re-signs stored media only after checking its organization ownership', async () => {
    const f = fixture(); f.rows[0].media_meta = { bucket: 'zalo-media', path: 'source-account/image.png' };
    await f.send();
    expect(f.db.rpc).toHaveBeenCalledWith('zalo_worker_attachment_allowed_v1', { p_org: 'org', p_account: 'source-account', p_bucket: 'zalo-media', p_path: 'source-account/image.png' });
    expect(f.download.mock.calls[0][0]).toContain('/storage/v1/object/sign/');
  });
  it('rejects stored media outside the allowed ownership without calling Zalo', async () => {
    const f = fixture(); f.rows[0].media_meta = { path: 'other-account/image.png' }; f.db.rpc.mockResolvedValue({ data: false });
    await expect(f.send()).rejects.toThrow('Không được truy cập');
    expect(f.download).not.toHaveBeenCalled(); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it('does not silently turn an image originally sent as a file into an image bubble', async () => {
    const f = fixture('file'); f.rows[0].media_label = 'scan.jpg';
    await expect(f.send()).rejects.toThrow('giữ nguyên dạng tệp');
    expect(f.download).not.toHaveBeenCalled(); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it.each([
    ['foreign company', row => { row.organization_id = 'other'; }],
    ['recalled', row => { row.msg_type = 'sys'; }],
    ['hidden', row => { row.hidden_at = new Date().toISOString(); }],
    ['not sent', row => { row.status = 'pending'; }],
    ['missing media', row => { row.media_url = null; }],
  ])('rejects a %s source before any download or provider call', async (_label, mutate) => {
    const f = fixture(); mutate(f.rows[0]);
    expect((await validateZaloCommandScope(f.job, f.db)).ok).toBe(false);
    await expect(f.send()).rejects.toThrow('không còn khả dụng');
    expect(f.download).not.toHaveBeenCalled(); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects sources moved to an unrelated account or mixed conversation', async () => {
    const f = fixture('image', 2); f.rows[1].conversation_id = 'another';
    await expect(readForwardSources(f.job, f.db)).rejects.toThrow('cùng hội thoại');
  });
  it('rechecks sources after download so a newly recalled message is not sent', async () => {
    const f = fixture(); f.download.mockImplementation(async () => { f.rows[0].msg_type = 'sys'; return { data: png() }; });
    await expect(f.send()).rejects.toThrow('không còn khả dụng'); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it('does not retry or convert media to text when the provider outcome is unknown', async () => {
    const f = fixture('voice'); f.api.sendVoice.mockRejectedValue(new Error('timeout'));
    await expect(f.send()).rejects.toThrow('timeout');
    expect(f.api.sendVoice).toHaveBeenCalledOnce(); expect(f.api.sendMessage).not.toHaveBeenCalled(); expect(state.receipts).toEqual([]);
  });
  it('keeps missing or partial album receipts for reconciliation rather than assigning the wrong image', async () => {
    const f = fixture('image',2); f.api.sendMessage.mockResolvedValue({ attachment: [{}, { msgId: 'second' }] });
    await expect(f.send()).rejects.toThrow('PROVIDER_RECEIPT_MISSING'); expect(state.receipts).toEqual([]);
    expect(f.api.sendMessage).toHaveBeenCalledOnce();
  });
  it('requires the separate caption receipt before treating an album as sent', async () => {
    const f = fixture('image', 2); f.api.sendMessage.mockResolvedValue({ message: null, attachment: [{ msgId: 'one' }, { msgId: 'two' }] });
    await expect(f.send()).rejects.toThrow('PROVIDER_RECEIPT_MISSING'); expect(state.receipts).toEqual([]);
  });
  it('does not resend after the atomic finalizer fails', async () => {
    const f = fixture('video'); state.persistError = { message: 'database offline' };
    await expect(f.send()).rejects.toThrow('database offline'); expect(f.api.sendVideo).toHaveBeenCalledOnce(); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('bounded media download and content inspection', () => {
  it('follows known Zalo redirects with no browser or account cookies', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://photo.zadn.vn/image' } }))
      .mockResolvedValueOnce(new Response(png(), { headers: { 'content-type': 'image/png' } }));
    expect((await downloadForwardUrl('https://photo.zdn.vn/image', { fetchImpl: request })).data).toEqual(png());
    expect(request.mock.calls[0][1]).toEqual({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });
  it.each(['http://photo.zdn.vn/image','https://127.0.0.1/media','https://photo.zdn.vn.evil.test/image','https://user:pass@photo.zdn.vn/image'])('rejects unsafe URL %s without fetching', async url => {
    const request = vi.fn(); await expect(downloadForwardUrl(url, { fetchImpl: request })).rejects.toThrow('không được phép'); expect(request).not.toHaveBeenCalled();
  });
  it('rejects an unsafe redirect before fetching the redirect target', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    await expect(downloadForwardUrl('https://photo.zdn.vn/image', { fetchImpl: request })).rejects.toThrow('không được phép'); expect(request).toHaveBeenCalledOnce();
  });
  it('rejects an expired media response, not substituting a link', async () => {
    await expect(downloadForwardUrl('https://photo.zdn.vn/image', { fetchImpl: async () => new Response(null, { status: 404 }) })).rejects.toThrow('hết hạn');
  });
  it('rejects HTML and over-limit bytes even without a content-length header', async () => {
    await expect(downloadForwardUrl('https://photo.zdn.vn/image', { fetchImpl: async () => new Response('error', { headers: { 'content-type': 'text/html' } }) })).rejects.toThrow('trang lỗi');
    await expect(downloadForwardUrl('https://photo.zdn.vn/image', { maxBytes: 2, fetchImpl: async () => new Response('large') })).rejects.toThrow('25MB');
  });
  it('stops a stalled media request at its deadline', async () => {
    const request = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(downloadForwardUrl('https://photo.zdn.vn/image', { fetchImpl: request, timeoutMs: 5 })).rejects.toThrow('Tải media quá lâu');
    expect(request).toHaveBeenCalledOnce();
  });
  it('reads real PNG dimensions and rejects non-image bytes', () => {
    expect(imageDetails(png())).toEqual({ extension: 'png', width: 640, height: 480 }); expect(() => imageDetails(Buffer.from('html'))).toThrow('định dạng');
  });
  it('recognizes JPEG and WebP bytes independently of a URL extension', () => {
    const jpeg = Buffer.from([255,216,255,192,0,17,8,1,224,2,128,3,1,17,0,2,17,0,3,17,0,255,217]);
    expect(imageDetails(jpeg)).toEqual({ extension: 'jpg', width: 640, height: 480 });
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP',8); webp.write('VP8X',12); webp.writeUIntLE(639,24,3); webp.writeUIntLE(479,27,3);
    expect(imageDetails(webp)).toEqual({ extension: 'webp', width: 640, height: 480 });
  });
});
