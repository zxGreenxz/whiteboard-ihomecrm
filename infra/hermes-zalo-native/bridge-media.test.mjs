import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createNativeBridge } from '../../worker/lib/hermes-native-bridge.js';
import { createNativeJournal } from '../../worker/lib/hermes-native-journal.js';
import { exifOrientation, imageDetails, loadNativePhoto, NATIVE_PHOTO_MAX_BYTES, stripImageMetadata } from '../../worker/lib/hermes-native-media.js';

// Synthetic images only: no real photo, customer, phone number or Zalo ID.
const SECRETS = /GPS_SECRET|XMP_SECRET|IPTC_SECRET|COMMENT_SECRET|TRAILER_SECRET|TEXT_SECRET|THUMB_SECRET|UNKNOWN_SECRET/;
function tiff({ orientation = 1, secret = 'GPS_SECRET', le = false } = {}) {
  const w16 = le ? 'writeUInt16LE' : 'writeUInt16BE', w32 = le ? 'writeUInt32LE' : 'writeUInt32BE';
  const text = Buffer.from(secret + '\0', 'latin1');
  const textAt = 8 + 2 + 3 * 12 + 4, gpsAt = textAt + text.length + (text.length & 1);
  const out = Buffer.alloc(gpsAt + 2 + 12 + 4);
  out.write(le ? 'II' : 'MM', 0, 'latin1'); out[w16](42, 2); out[w32](8, 4); out[w16](3, 8);
  const entry = (i, tag, type, count, value) => {
    const at = 10 + i * 12; out[w16](tag, at); out[w16](type, at + 2); out[w32](count, at + 4); value(at + 8);
  };
  entry(0, 0x010e, 2, text.length, at => out[w32](textAt, at));
  entry(1, 0x0112, 3, 1, at => out[w16](orientation, at));
  entry(2, 0x8825, 4, 1, at => out[w32](gpsAt, at));
  text.copy(out, textAt);
  out[w16](1, gpsAt); out[w16](1, gpsAt + 2); out[w16](2, gpsAt + 4); out[w32](2, gpsAt + 6); out.write('N\0', gpsAt + 10, 'latin1');
  return out;
}
const u16 = n => Buffer.from([n >> 8, n & 255]);
const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);
// Stuffed FF00, a restart marker and a fill byte before the next marker.
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78, 0xff]);
function jpeg({ width = 640, height = 480, orientation = 6, progressive = false } = {}) {
  const sof = segment(progressive ? 0xc2 : 0xc0, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]));
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe0, Buffer.from('JFXX\0\x10THUMB_SECRET', 'latin1')),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff({ orientation, secret: 'GPS_SECRET_EXIF' })])),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x>XMP_SECRET</x>', 'latin1')),
    segment(0xed, Buffer.from('Photoshop 3.0\0IPTC_SECRET', 'latin1')),
    segment(0xe2, Buffer.from('MPF\0THUMB_SECRET', 'latin1')),
    segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1')),
    segment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1')),
    segment(0xfe, Buffer.from('COMMENT_SECRET', 'latin1')),
    segment(0xdb, Buffer.alloc(65, 1)), sof, segment(0xc4, Buffer.alloc(20, 2)),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), SCAN,
    ...(progressive ? [segment(0xfe, Buffer.from('COMMENT_SECRET between scans', 'latin1')),
      segment(0xc4, Buffer.alloc(20, 3)), segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), SCAN] : []),
    Buffer.from([0xff, 0xd9]), Buffer.from('TRAILER_SECRET', 'latin1'),
  ]);
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = data => { let c = ~0; for (const byte of data) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (~c) >>> 0; };
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const RAW = Buffer.concat(Array.from({ length: 40 }, (_, y) => Buffer.concat([Buffer.from([0]),
  Buffer.from(Array.from({ length: 40 * 4 }, (_, x) => (x * 7 + y * 13) & 255))])));
function png({ orientation = 3 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(40, 0); header.writeUInt32BE(40, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('eXIf', tiff({ orientation, secret: 'GPS_SECRET_PNG', le: true })),
    pngChunk('tEXt', Buffer.from('Comment\0TEXT_SECRET', 'latin1')), pngChunk('tIME', Buffer.alloc(7, 1)),
    pngChunk('zzZz', Buffer.from('UNKNOWN_SECRET', 'latin1')), pngChunk('IDAT', zlib.deflateSync(RAW)),
    pngChunk('IEND', Buffer.alloc(0)), Buffer.from('TRAILER_SECRET', 'latin1')]);
}
function riff(fourcc, payload) {
  const out = Buffer.alloc(8 + payload.length + (payload.length & 1));
  out.write(fourcc, 0, 'latin1'); out.writeUInt32LE(payload.length, 4); payload.copy(out, 8);
  return out;
}
function webp({ orientation = 8 } = {}) {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x20 | 0x10 | 0x08 | 0x04; vp8x.writeUIntLE(639, 4, 3); vp8x.writeUIntLE(479, 7, 3);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE((639 & 16383) | ((479 & 16383) << 14), 1);
  const body = Buffer.concat([riff('VP8X', vp8x), riff('ICCP', Buffer.from('profile', 'latin1')), riff('VP8L', vp8l),
    riff('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff({ orientation, secret: 'GPS_SECRET_WEBP' })])),
    riff('XMP ', Buffer.from('<x>XMP_SECRET</x>', 'latin1')), riff('ZZZZ', Buffer.from('UNKNOWN_SECRET', 'latin1'))]);
  const header = Buffer.alloc(12); header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
function jpegSegments(data) {
  const found = [];
  for (let offset = 2; offset + 2 <= data.length && data[offset] === 0xff;) {
    const marker = data[offset + 1];
    if (marker === 0xd9) { found.push({ marker }); break; }
    const end = offset + 2 + data.readUInt16BE(offset + 2);
    found.push({ marker, body: data.subarray(offset + 4, end) });
    offset = end;
    if (marker === 0xda) { while (!(data[offset] === 0xff && ![0, 0xff].includes(data[offset + 1]) && !(data[offset + 1] >= 0xd0 && data[offset + 1] <= 0xd7))) offset++; }
  }
  return found;
}
function pngChunks(data) {
  const found = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset), type = data.toString('latin1', offset + 4, offset + 8);
    assert.equal(data.readUInt32BE(offset + 8 + length), crc(data.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    found.push({ type, data: data.subarray(offset + 8, offset + 8 + length) }); offset += 12 + length;
  }
  return found;
}

test('JPEG metadata, thumbnails, comments and trailer are removed; orientation, tables and scans survive', () => {
  for (const progressive of [false, true]) {
    const source = jpeg({ progressive });
    const out = stripImageMetadata(source);
    assert.doesNotMatch(out.toString('latin1'), SECRETS);
    assert.deepEqual(imageDetails(out), { extension: 'jpg', width: 640, height: 480 });
    const kept = jpegSegments(out).map(({ marker }) => marker.toString(16));
    assert.deepEqual(kept, ['e0', 'e1', 'e2', 'ee', 'db', progressive ? 'c2' : 'c0', 'c4', 'da',
      ...(progressive ? ['c4', 'da'] : []), 'd9']);
    const exif = jpegSegments(out).find(({ marker }) => marker === 0xe1).body;
    assert.equal(exif.toString('latin1', 0, 6), 'Exif\0\0');
    assert.equal(exifOrientation(exif.subarray(6)), 6);
    assert.equal(exif.length, 6 + 26, 'only the minimal orientation IFD is carried');
    // Entropy-coded scan bytes (stuffing, restart marker and fill) are byte-identical.
    assert.ok(out.includes(SCAN));
    assert.equal(out.subarray(-2).toString('hex'), 'ffd9');
  }
  const upright = stripImageMetadata(jpeg({ orientation: 1 }));
  assert.equal(jpegSegments(upright).some(({ marker }) => marker === 0xe1), false, 'default orientation needs no EXIF');
  assert.throws(() => stripImageMetadata(Buffer.concat([jpeg().subarray(0, 40), Buffer.from([0x12, 0x34])])), /cấu trúc|định dạng/);
});

test('PNG drops eXIf/text/time/unknown ancillary chunks, keeps decodable pixels and a minimal orientation', () => {
  const out = stripImageMetadata(png());
  assert.doesNotMatch(out.toString('latin1'), SECRETS);
  const chunks = pngChunks(out);
  assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'eXIf', 'IDAT', 'IEND']);
  assert.equal(exifOrientation(chunks[1].data), 3);
  assert.deepEqual(zlib.inflateSync(chunks[2].data), RAW, 'pixels decode to the original scanlines');
  assert.deepEqual(imageDetails(out), { extension: 'png', width: 40, height: 40 });
  assert.deepEqual(pngChunks(stripImageMetadata(png({ orientation: 1 }))).map(({ type }) => type), ['IHDR', 'IDAT', 'IEND']);
});

test('WebP drops EXIF/XMP/unknown chunks, fixes VP8X flags and RIFF size, keeps orientation only', () => {
  const out = stripImageMetadata(webp());
  assert.doesNotMatch(out.toString('latin1'), SECRETS);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  const chunks = [];
  for (let offset = 12; offset < out.length;) {
    const size = out.readUInt32LE(offset + 4);
    chunks.push({ fourcc: out.toString('latin1', offset, offset + 4), payload: out.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size & 1);
  }
  assert.deepEqual(chunks.map(({ fourcc }) => fourcc), ['VP8X', 'ICCP', 'VP8L', 'EXIF']);
  assert.equal(chunks[0].payload[0], 0x20 | 0x10 | 0x08, 'XMP flag cleared, EXIF flag kept for orientation');
  assert.equal(exifOrientation(chunks[3].payload), 8);
  assert.deepEqual(imageDetails(out), { extension: 'webp', width: 640, height: 480 });
  const upright = stripImageMetadata(webp({ orientation: 1 }));
  assert.equal(upright[20] & 0x0c, 0); assert.doesNotMatch(upright.toString('latin1'), /EXIF/);
});

test('photo loader maps failures to closed codes and never contacts a non-CDN host', async () => {
  const calls = [];
  const fetchImpl = respond => async url => { calls.push(url); return respond(url); };
  const image = body => () => new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  const ok = await loadNativePhoto(['https://photo-stal.zdn.vn/a.jpg'], { fetchImpl: fetchImpl(image(jpeg())) });
  assert.equal(ok.mime, 'image/jpeg'); assert.equal(ok.width, 640); assert.equal(ok.height, 480);
  assert.equal(ok.sha256, createHash('sha256').update(ok.bytes).digest('hex'));
  assert.doesNotMatch(ok.bytes.toString('latin1'), SECRETS);
  const cases = [
    ['expired', () => new Response(null, { status: 404 })],
    ['download_failed', () => new Response('<html>', { headers: { 'content-type': 'text/html' } })],
    ['too_large', () => new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } })],
    ['not_image', image(Buffer.from('GIF89a not accepted'))],
    ['bad_dimensions', image(jpeg({ width: 16, height: 16 }))],
    ['download_failed', () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/x' } })],
  ];
  for (const [code, respond] of cases) {
    await assert.rejects(loadNativePhoto(['https://photo-stal.zdn.vn/a.jpg'], { fetchImpl: fetchImpl(respond) }), error => error.code === code, code);
  }
  calls.length = 0;
  await assert.rejects(loadNativePhoto(['https://evil.test/a.jpg', 'http://photo.zdn.vn/a.jpg'], { fetchImpl: fetchImpl(image(jpeg())) }),
    error => error.code === 'download_failed');
  assert.deepEqual(calls, [], 'no request to a host outside the Zalo CDN allowlist');
  // hd → rawUrl → href: the first candidate on the allowlist is the one fetched.
  await loadNativePhoto(['https://evil.test/hd.jpg', 'https://photo-stal.zdn.vn/raw.jpg'], { fetchImpl: fetchImpl(image(jpeg())) });
  assert.deepEqual(calls, ['https://photo-stal.zdn.vn/raw.jpg']);
});

// ── Bridge ──
const channel = { accountId: '11111111-1111-4111-8111-111111111111', ownUid: '100', pairedUid: '200', mainUid: '200',
  profile: 'personal-fixture', generation: '22222222-2222-4222-8222-222222222222', token: 'hzn_' + 'a'.repeat(64) };
const ACCEPT = ['photo', 'notice'];
async function fixture(t, { config: supplied, media: limits, serve } = {}) {
  const root = supplied?.stateRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-media-'));
  const config = supplied || { stateRoot: root, channels: [channel] };
  const clock = { at: Date.now() };
  const calls = [], faults = [];
  const fetchMedia = async url => {
    calls.push(url);
    const respond = serve?.(url);
    return respond ? respond() : new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } });
  };
  const bridge = createNativeBridge({ config, now: () => clock.at, fetchMedia, media: limits, onFault: code => faults.push(code) });
  const session = bridge.attach({ accountId: channel.accountId, ownUid: '100', isActive: () => true,
    api: { sendMessage: async () => ({ message: { msgId: 987654 }, attachment: [] }) } });
  const url = await bridge.listen(0);
  t.after(async () => { await bridge.close(); if (!supplied) fs.rmSync(root, { recursive: true, force: true }); });
  async function raw(route, body, token = channel.token) {
    return fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  }
  async function request(route, body, token) {
    const response = await raw(route, body, token);
    return { status: response.status, data: await response.json() };
  }
  const receive = (accept = ACCEPT) => request('/v1/receive', accept ? { generation: channel.generation, accept } : { generation: channel.generation });
  const ack = (eventId, status = 'accepted') => request('/v1/ack', { generation: channel.generation, eventId, status });
  const media = (eventId, index = 0, token) => raw('/v1/media', { generation: channel.generation, eventId, index }, token);
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advance = ms => { clock.at += ms; };
  const journal = () => createNativeJournal(config.stateRoot, channel).values('inbound');
  return { bridge, config, session, clock, calls, faults, raw, request, receive, ack, media, flush, advance, journal };
}
const base = (f, data) => ({ type: 0, isSelf: false, threadId: '200', data: { uidFrom: '200', idTo: '100', ts: String(f.clock.at), ...data } });
const photo = (f, msgId, { caption = '', layout, url = `https://photo-stal.zdn.vn/${msgId}.jpg`, extra = {} } = {}) => base(f, {
  msgType: 'chat.photo', msgId, ...extra,
  content: { title: caption, description: '', href: url, thumb: url, childnumber: 0, action: 'recommened.link', type: '',
    params: JSON.stringify({ hd: url, rawUrl: url, width: 640, height: 480 }) },
  ...(layout ? { extraData: JSON.stringify({ groupMediaMsg: { groupLayoutId: layout } }) } : {}) });
const text = (f, msgId, content) => base(f, { msgType: 'webchat', msgId, content });
const file = (f, msgId, msgType = 'share.file') => base(f, { msgType, msgId, content: { title: 'private-name.pdf', href: 'https://f.zdn.vn/x' } });

test('photos reach only an adapter that declared them; text-only adapters behave exactly as before', async t => {
  const f = await fixture(t);
  await f.receive(null);
  assert.equal(await f.session.capture(photo(f, 'p0', { caption: 'chi 350k' })), true, 'private photo never reaches the CRM inbox path');
  await f.flush(); f.advance(5000);
  assert.equal((await f.receive(null)).data.status, 'empty');
  assert.deepEqual(f.calls, [], 'undeclared photos are swallowed without any download');
  await f.session.capture(text(f, 't0', 'Phòng trống'));
  const plain = (await f.receive()).data.event;
  assert.deepEqual(Object.keys(plain).sort(), ['id', 'messageId', 'senderUid', 'sentAt', 'text'], 'text envelope is unchanged');
  assert.equal((await f.request('/v1/receive', { generation: channel.generation, accept: ['photo', 'video'] })).status, 400);
  assert.equal((await f.request('/v1/receive', { generation: channel.generation, accept: ['photo', 'photo'] })).status, 400);
});

test('captioned photo becomes one event; bytes are served once, stripped, and journal keeps the old shape', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(photo(f, 'p1', { caption: 'chi 350k sửa vòi\u0007 201' }));
  await f.flush();
  assert.equal((await f.receive()).data.status, 'empty', 'album gap must pass first');
  f.advance(3000);
  const { data } = await f.receive();
  assert.equal(data.status, 'message');
  const { event } = data;
  assert.equal(event.text, 'chi 350k sửa vòi 201');
  assert.equal(event.parts, 1); assert.equal(event.messageId, 'p1'); assert.equal(event.senderUid, '200');
  assert.equal(event.media.length, 1);
  const [item] = event.media;
  assert.deepEqual(Object.keys(item).sort(), ['bytes', 'height', 'index', 'mime', 'sha256', 'width']);
  assert.equal(item.mime, 'image/jpeg'); assert.equal(item.width, 640);
  assert.doesNotMatch(JSON.stringify(data), /zdn\.vn|https?:/, 'no CDN URL leaves the worker');
  const bytes = Buffer.from(await (await f.media(event.id)).arrayBuffer());
  assert.equal(bytes.length, item.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  assert.doesNotMatch(bytes.toString('latin1'), SECRETS, 'EXIF/GPS never leaves the worker');
  const head = await f.media(event.id);
  assert.equal(head.headers.get('x-media-sha256'), item.sha256); assert.equal(head.headers.get('x-media-type'), 'image/jpeg');
  assert.equal(head.headers.get('content-type'), 'application/octet-stream');
  const [record] = f.journal();
  assert.deepEqual(Object.keys(record).sort(), ['digest', 'dispatchedAt', 'id', 'messageId', 'senderUid', 'sentAt', 'status']);
  assert.equal(record.status, 'dispatch_unknown');
  assert.equal((await f.ack(event.id)).data.status, 'accepted');
  assert.equal((await f.media(event.id)).status, 404, 'bytes leave RAM at ack');
  assert.equal(f.journal()[0].status, 'accepted');
  assert.doesNotMatch(fs.readFileSync(path.join(f.config.stateRoot, fs.readdirSync(f.config.stateRoot)[0]), 'latin1'),
    /zdn|chi 350k|SECRET/, 'journal holds no URL, caption or bytes');
  assert.equal((await f.receive()).data.status, 'empty');
});

test('photo without caption waits for the typed command, merges it, and otherwise ripens after 30 seconds', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(photo(f, 'p1'));
  await f.flush(); f.advance(3000);
  assert.equal((await f.receive()).data.status, 'empty');
  f.advance(7000);
  await f.session.capture(text(f, 't1', 'ghi phiếu chi kèm ảnh này'));
  const merged = (await f.receive()).data.event;
  assert.equal(merged.text, 'ghi phiếu chi kèm ảnh này'); assert.equal(merged.parts, 2); assert.equal(merged.media.length, 1);
  assert.deepEqual(f.journal().map(record => [record.messageId, record.status]), [['t1', 'dispatch_unknown'], ['p1', 'dispatch_unknown']]);
  await f.ack(merged.id);
  const records = f.journal();
  assert.ok(records.every(record => record.status === 'accepted' && !('text' in record)), 'group ack covers the merged text');
  assert.equal((await f.receive()).data.status, 'empty');

  await f.session.capture(photo(f, 'p2'));
  await f.flush(); f.advance(29000);
  assert.equal((await f.receive()).data.status, 'empty');
  f.advance(1000);
  const alone = (await f.receive()).data.event;
  assert.equal(alone.text, undefined); assert.equal(alone.parts, 1);
});

test('text before a photo goes first and alone; text never waits for an unrelated later photo', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(text(f, 't1', 'ghi phiếu chi 350k'));
  f.advance(1000);
  await f.session.capture(photo(f, 'p1'));
  const first = (await f.receive()).data.event;
  assert.equal(first.text, 'ghi phiếu chi 350k'); assert.equal(first.media, undefined);
  await f.ack(first.id);
  await f.flush(); f.advance(30000);
  assert.equal((await f.receive()).data.event.messageId, 'p1');
});

test('album photos become one ordered event; separate groups keep their own text', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(photo(f, 'a1', { layout: 'L1' }));
  f.advance(500); await f.session.capture(photo(f, 'a2', { layout: 'L1', caption: 'ghi phiếu chi 1tr2 kèm 3 ảnh' }));
  f.advance(500); await f.session.capture(photo(f, 'a3', { layout: 'L1' }));
  await f.flush(); f.advance(3000);
  const event = (await f.receive()).data.event;
  assert.equal(event.media.length, 3); assert.deepEqual(event.media.map(item => item.index), [0, 1, 2]);
  assert.equal(event.text, 'ghi phiếu chi 1tr2 kèm 3 ảnh'); assert.equal(event.parts, 3);
  const second = Buffer.from(await (await f.media(event.id, 1)).arrayBuffer());
  assert.equal(createHash('sha256').update(second).digest('hex'), event.media[1].sha256);
  await f.ack(event.id);
  // A captioned group closes; a later photo outside the album gap starts a new event.
  await f.session.capture(photo(f, 'b1', { caption: 'phiếu một' }));
  f.advance(4000); await f.session.capture(photo(f, 'b2', { caption: 'phiếu hai' }));
  await f.flush(); f.advance(3000);
  const one = (await f.receive()).data.event; await f.ack(one.id);
  const two = (await f.receive()).data.event;
  assert.deepEqual([one.text, two.text], ['phiếu một', 'phiếu hai']);
  assert.equal(one.media.length + two.media.length, 2);
});

test('forwarded photo drops the original caption; quoted, group, echo, stale and foreign photos never arrive', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(photo(f, 'fw', { caption: 'chú thích của người khác', extra: { fw: true } }));
  for (const alter of [m => { m.data.quote = { msgId: 'x' }; }, m => { m.type = 1; }, m => { m.isSelf = true; },
    m => { m.data.uidFrom = '300'; }, m => { m.threadId = '300'; }, m => { m.data.idTo = '999'; },
    m => { m.data.ts = String(f.clock.at - 400000); }]) {
    const message = photo(f, `x${f.calls.length}${Math.random().toString(36).slice(2, 8)}`); alter(message);
    await f.session.capture(message);
  }
  await f.flush(); f.advance(30000);
  const event = (await f.receive()).data.event;
  assert.equal(event.messageId, 'fw'); assert.equal(event.text, undefined);
  await f.ack(event.id);
  assert.equal((await f.receive()).data.status, 'empty');
  assert.equal(f.calls.length, 1, 'rejected photos are never downloaded');
});

test('download failures arrive as closed error codes without bytes', async t => {
  const f = await fixture(t, { serve: url => url.includes('gone') ? () => new Response(null, { status: 404 })
    : url.includes('page') ? () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) : null });
  await f.receive();
  await f.session.capture(photo(f, 'e1', { url: 'https://photo-stal.zdn.vn/gone.jpg' }));
  await f.session.capture(photo(f, 'e2', { url: 'https://photo-stal.zdn.vn/page.jpg' }));
  await f.session.capture(photo(f, 'e3', { url: 'https://evil.test/x.jpg' }));
  await f.session.capture(photo(f, 'e4'));
  await f.flush(); f.advance(30000);
  const event = (await f.receive()).data.event;
  assert.deepEqual(event.media.map(({ index, error }) => [index, error]),
    [[0, 'expired'], [1, 'download_failed'], [2, 'download_failed'], [3, undefined]]);
  assert.equal((await f.media(event.id, 0)).status, 404);
  assert.equal((await f.media(event.id, 3)).status, 200);
  assert.equal(f.calls.some(url => url.includes('evil')), false);
});

test('files, voice and video get one notice per burst; stickers stay silent; notices need their own declaration', async t => {
  const f = await fixture(t);
  await f.receive(['photo']);
  await f.session.capture(file(f, 'n0'));
  assert.equal((await f.receive(['photo'])).data.status, 'empty', 'notice not declared: swallowed');
  await f.receive();
  await f.session.capture(file(f, 'n1')); await f.session.capture(file(f, 'n2'));
  await f.session.capture(base(f, { msgType: 'chat.sticker', msgId: 's1', content: { id: 1 } }));
  await f.session.capture(file(f, 'v1', 'chat.voice'));
  const notice = (await f.receive()).data.event;
  assert.deepEqual([notice.notice, notice.parts, notice.text, notice.media], ['file', 2, undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(notice), /private-name|zdn/);
  await f.ack(notice.id);
  const voice = (await f.receive()).data.event;
  assert.equal(voice.notice, 'voice'); await f.ack(voice.id);
  assert.equal((await f.receive()).data.status, 'empty', 'sticker produced nothing');
  assert.equal(f.calls.length, 0);
});

test('/v1/media serves only a delivered, unacknowledged event of the same channel within two minutes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-media-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const second = { ...channel, profile: 'second-fixture', pairedUid: '300', mainUid: '300', token: 'hzn_' + 'b'.repeat(64) };
  const f = await fixture(t, { config: { stateRoot: root, channels: [channel, second] } });
  await f.receive();
  await f.session.capture(photo(f, 'p1', { caption: 'bill' }));
  await f.flush(); f.advance(3000);
  assert.equal((await f.media('0'.repeat(64))).status, 404, 'unknown event');
  const event = (await f.receive()).data.event;
  assert.equal((await f.media(event.id, 0, second.token)).status, 404, 'another channel cannot read it');
  assert.equal((await f.media(event.id, 0, 'hzn_' + 'c'.repeat(64))).status, 401);
  assert.equal((await f.media(event.id, 1)).status, 404, 'no such index');
  assert.equal((await f.media(event.id, 10)).status, 400);
  assert.equal((await f.raw('/v1/media', { generation: 'stale', eventId: event.id, index: 0 })).status, 400);
  assert.equal((await f.media(event.id)).status, 200);
  f.advance(120001);
  assert.equal((await f.media(event.id)).status, 404, 'expired after two minutes');
  assert.equal((await f.ack(event.id)).data.status, 'accepted', 'a late ack still records the outcome');
});

test('an older adapter poll drops queued media; RAM and per-channel bounds answer busy', async t => {
  const f = await fixture(t, { media: { photosPerChannel: 2 } });
  await f.receive();
  await f.session.capture(photo(f, 'p1'));
  await f.flush();
  await f.receive(null);
  assert.ok(f.faults.includes('native_media_not_accepted'));
  f.advance(30000);
  assert.equal((await f.receive()).data.status, 'empty');
  for (const id of ['q1', 'q2', 'q3']) await f.session.capture(photo(f, id));
  await f.flush(); f.advance(30000);
  const event = (await f.receive()).data.event;
  assert.deepEqual(event.media.map(item => item.error), [undefined, undefined, 'busy']);
  assert.equal(f.calls.length, 3, 'the busy photo is not downloaded');

  const g = await fixture(t, { media: { ramBytes: 1 } });
  await g.receive();
  await g.session.capture(photo(g, 'r1'));
  await g.flush(); g.advance(30000);
  assert.equal((await g.receive()).data.event.media[0].error, 'busy');
});

test('the worker RAM budget is returned when the adapter acknowledges', async t => {
  // Room for exactly one in-flight download plus less than one stored photo.
  const stored = stripImageMetadata(jpeg()).length;
  const f = await fixture(t, { media: { ramBytes: NATIVE_PHOTO_MAX_BYTES + Math.floor(stored / 2) } });
  await f.receive();
  const take = async id => {
    await f.session.capture(photo(f, id, { caption: id }));
    await f.flush(); f.advance(3000);
    return (await f.receive()).data.event;
  };
  const first = await take('m1');
  assert.equal(first.media[0].error, undefined);
  assert.equal((await take('m2')).media[0].error, 'busy', 'unacknowledged bytes still count');
  await f.ack(first.id);
  assert.equal((await take('m3')).media[0].error, undefined, 'ack released the first photo');
});

test('restart loses unclaimed photos and never re-delivers a claimed one', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.session.capture(photo(f, 'kept', { caption: 'bill' }));
  await f.flush(); f.advance(3000);
  const event = (await f.receive()).data.event;
  await f.session.capture(photo(f, 'lost'));
  await f.flush();
  await f.bridge.close();
  const g = await fixture(t, { config: f.config });
  await g.receive();
  await g.session.capture(photo(g, 'kept', { caption: 'bill' }));
  await g.flush(); g.advance(30000);
  assert.equal((await g.receive()).data.status, 'empty', 'claimed photo is deduplicated by the journal');
  assert.equal((await g.media(event.id)).status, 404, 'bytes did not survive the restart');
  assert.equal((await g.ack(event.id)).data.status, 'accepted');
  assert.deepEqual(g.journal().map(record => [record.messageId, record.status]), [['kept', 'accepted']]);
});
