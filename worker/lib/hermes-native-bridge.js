import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createNativeJournal, nativeDigest } from './hermes-native-journal.js';
import { nativeId, nativeUid, readNativeConfig } from './hermes-native-config.js';
import { nativeReconciliationFile, nativeReconciliationFor, readNativeReconciliations } from './hermes-native-reconciliation.js';
import { isHermesLinkMessage } from './hermes-link.js';
import { describeReceiptShape, providerTextReceipt } from './hermes-native-receipt.js';
import { loadNativePhoto, NATIVE_PHOTO_ERRORS, NATIVE_PHOTO_MAX_BYTES } from './hermes-native-media.js';

const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
};
const QUOTES = ['quote', 'reference', 'decorLog'], FORWARDS = ['forward', 'isForward', 'fw'];
const flagged = (value, keys) => keys.some(key => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && (!Object.hasOwn(property, 'value') || property.value != null && property.value !== false);
});

// Photo channel defaults. Owner questions 41-52 are still open; each value is
// the proposed default and is meant to be changed here, not inferred elsewhere.
export const NATIVE_MEDIA_DEFAULTS = Object.freeze({
  acceptMs: 60000,      // an adapter re-declares `accept` on every poll
  settleMs: 3000,       // album photos arrive as separate events within this gap
  waitMs: 30000,        // photo without caption waits for a typed command (Q43)
  deliveredMs: 120000,  // bytes kept for /v1/media after delivery, until ack
  unclaimedMs: 300000,  // a captured group nobody claims is dropped
  photosPerEvent: 10,
  photosPerChannel: 20, // queued or downloaded and not yet acknowledged
  itemsPerChannel: 100,
  ramBytes: 64 * 1024 * 1024,
  downloads: 2,         // concurrent CDN downloads per worker
});
// Non-text kinds the bot answers with one "not supported yet" line (Q52).
// Stickers and unknown kinds stay silent, as before. `chat.recommended` shares
// its Zalo type code with links, so it is not called a contact card.
const NOTICES = new Map([['share.file', 'file'], ['chat.voice', 'voice'], ['chat.video.msg', 'video'],
  ['chat.gif', 'gif'], ['chat.doodle', 'drawing'], ['chat.location.new', 'location'],
  ['chat.recommended', 'shared'], ['chat.link', 'link']]);
const ACCEPT = ['photo', 'notice'];
// Gateway commands (/stop, /new …) are never held behind or merged into a photo group.
const command = record => record.text.trimStart().startsWith('/');
// Bad input answers 400 `native_request_rejected` (also what an older worker
// answers to `accept`); internal failures such as an unwritable journal answer 503.
const CLIENT_ERRORS = new Set(['invalid_request', 'body_too_large', 'generation_mismatch', 'invalid_native_request',
  'event_not_dispatched', 'request_id_conflict']);
const caption = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 8192
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
const parsed = value => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return JSON.parse(value); } catch { return null; }
};
class MediaUnavailable extends Error {}
const BINARY = Symbol('native_media_bytes');
const exact = (value, keys) => value && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validText = (value, bytes) => typeof value === 'string' && value.trim().length > 0 &&
  !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= bytes;
const publicChannel = c => ({ accountId: c.accountId, ownUid: c.ownUid, pairedUid: c.pairedUid,
  mainUid: c.mainUid, profile: c.profile, generation: c.generation });

// zca-js single-text result (shared parser; no provider SDK import here). The
// existing worker injects its logged-in API.
export const nativeTextReceipt = providerTextReceipt;

/** Shared transport only. It never creates a Zalo login, CRM client or model.
 * Every destination comes from the trusted local grant, never an HTTP body.
 * Without reconciliationFile (the operator ledger of the running config) an
 * outcome_unknown send keeps the channel quarantined permanently. */
export function createNativeBridge({ config, reconciliationFile = null, now = Date.now, providerTimeoutMs = 60000, maxProviderPending = 8,
  onFault = () => {}, fetchMedia = (...args) => fetch(...args), media: mediaOverrides = {} }) {
  if (!Number.isInteger(maxProviderPending) || maxProviderPending < 1 || maxProviderPending > 32 ||
      !Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1 || providerTimeoutMs > 60000) throw new Error('invalid_native_limits');
  const limits = { ...NATIVE_MEDIA_DEFAULTS, ...mediaOverrides };
  // Operator diagnostics only; a failing logger never changes a send outcome.
  const fault = code => { try { onFault(code); } catch { /* diagnostics only */ } };
  const channels = config.channels.map(channel => {
    const journal = createNativeJournal(config.stateRoot, channel);
    // Every claim gets a dispatchedAt no other claim of this journal has, so the
    // records of one media group are found again by it (late ack, restart).
    const lastStamp = journal.values('inbound').reduce((max, record) => Math.max(max, record.dispatchedAt || 0), 0);
    // Media lives only in RAM: captured items wait here (arrival order), then a
    // claimed group keeps its bytes until ack. The journal never sees bytes/URLs.
    return { channel, pending: new Set(), journal, lastStamp, accept: { photo: 0, notice: 0 }, items: [], delivered: new Map() };
  });
  const stamp = entry => (entry.lastStamp = Math.max(now(), entry.lastStamp + 1));
  const attached = new Map();
  const providers = new Set();
  let closing = null, requests = 0;
  const isPrivateThread = (accountId, threadId) => channels.some(({ channel: c }) =>
    c.accountId === accountId && c.pairedUid === threadId);

  // ── Media RAM queue ──
  const downloads = [];
  let downloading = 0, ramBytes = 0, reservedBytes = 0;
  const photosOf = item => item.photos || item.entries;
  const release = item => {
    for (const photo of item.photos || []) {
      photo.dropped = true;
      if (photo.bytes) { ramBytes -= photo.bytes.length; photo.bytes = null; }
    }
  };
  const known = (entry, id) => !!entry.journal.get('inbound', id) ||
    entry.items.some(item => photosOf(item).some(part => part.id === id)) ||
    [...entry.delivered.values()].some(({ item }) => photosOf(item).some(part => part.id === id));
  const accepts = (entry, kind) => entry.accept[kind] > now();
  const discard = (entry, keep, code) => {
    const dropped = entry.items.filter(item => !keep(item));
    if (!dropped.length) return;
    dropped.forEach(release);
    entry.items = entry.items.filter(keep);
    fault(code);
  };
  function sweep() {
    const at = now();
    for (const entry of channels) {
      for (const [eventId, group] of entry.delivered) {
        if (at - group.dispatchedAt > limits.deliveredMs) { release(group.item); entry.delivered.delete(eventId); }
      }
      discard(entry, item => at - item.lastAt <= limits.unclaimedMs, 'native_media_unclaimed');
    }
  }
  const sweeper = setInterval(sweep, 5000);
  sweeper.unref?.();
  function pump() {
    while (!closing && downloading < limits.downloads && downloads.length) {
      const job = downloads.shift();
      downloading++;
      job().finally(() => { downloading--; pump(); });
    }
  }
  function download(photo, urls) {
    downloads.push(async () => {
      if (photo.dropped || closing) return;
      if (ramBytes + reservedBytes + NATIVE_PHOTO_MAX_BYTES > limits.ramBytes) { photo.state = 'error'; photo.error = 'busy'; return; }
      reservedBytes += NATIVE_PHOTO_MAX_BYTES;
      try {
        const result = await loadNativePhoto(urls, { fetchImpl: fetchMedia });
        if (photo.dropped || closing) return;
        Object.assign(photo, result, { state: 'ready' });
        ramBytes += result.bytes.length;
      } catch (error) {
        // Only a closed code leaves the bridge: never a URL or provider text.
        photo.state = 'error';
        photo.error = NATIVE_PHOTO_ERRORS.includes(error?.code) ? error.code : 'download_failed';
      } finally { reservedBytes -= NATIVE_PHOTO_MAX_BYTES; }
    });
    pump();
  }
  const pendingPhotos = entry => [...entry.items, ...[...entry.delivered.values()].map(({ item }) => item)]
    .reduce((count, item) => count + (item.photos ? item.photos.filter(photo => photo.state !== 'error').length : 0), 0);
  function capturePhoto(entry, data, part, forwarded) {
    if (!accepts(entry, 'photo')) { fault('native_photo_dropped:not_declared'); return; }
    if (known(entry, part.id)) { fault('native_photo_dropped:duplicate'); return; }
    const content = own(data, 'content');
    const params = parsed(own(content, 'params'));
    const urls = [own(params, 'hd'), own(params, 'rawUrl'), own(content, 'href')].filter(url => typeof url === 'string');
    // Forwarded photo: keep the image, drop the original sender's caption (Q46).
    const text = forwarded ? '' : caption(own(content, 'title'));
    const layout = own(own(parsed(own(data, 'extraData')), 'groupMediaMsg'), 'groupLayoutId');
    const key = (typeof layout === 'string' || Number.isSafeInteger(layout)) && nativeId(String(layout)) ? String(layout) : null;
    const at = now();
    let group = entry.items.at(-1);
    // Same album, or the open group has no caption yet, or within the album gap.
    const join = group?.photos && group.photos.length < limits.photosPerEvent &&
      (key && group.key === key || !group.caption.length || at - group.lastAt <= limits.settleMs);
    if (!join) {
      if (entry.items.length >= limits.itemsPerChannel) { fault('native_media_busy'); return; }
      group = { startedAt: part.sentAt, lastAt: at, key, caption: [], photos: [] };
      entry.items.push(group);
    }
    group.lastAt = at; group.key ||= key;
    if (text && Buffer.byteLength([...group.caption, text].join('\n'), 'utf8') <= 8192) group.caption.push(text);
    const photo = { ...part, state: 'loading' };
    const busy = pendingPhotos(entry) >= limits.photosPerChannel;
    group.photos.push(photo);
    if (busy) { photo.state = 'error'; photo.error = 'busy'; return; }
    download(photo, urls);
  }
  function captureNotice(entry, notice, part) {
    if (!accepts(entry, 'notice')) { fault('native_notice_dropped:not_declared'); return; }
    if (known(entry, part.id)) { fault('native_notice_dropped:duplicate'); return; }
    const last = entry.items.at(-1), at = now();
    // A burst of the same kind becomes one reply.
    if (last?.notice === notice && last.entries.length < limits.photosPerEvent) { last.entries.push(part); last.lastAt = at; return; }
    if (entry.items.length >= limits.itemsPerChannel) { fault('native_media_busy'); return; }
    entry.items.push({ notice, startedAt: part.sentAt, lastAt: at, entries: [part] });
  }
  // A photo group is ripe when every download settled, the album gap passed,
  // and it has a caption, something followed it, or the command wait elapsed.
  const ripe = (item, followed) => item.notice ? true : item.photos.every(photo => photo.state !== 'loading') &&
    now() - item.lastAt >= limits.settleMs && (item.caption.length > 0 || followed || now() - item.lastAt >= limits.waitMs);
  function claim(entry, item, texts) {
    const { channel, journal } = entry;
    const dispatchedAt = stamp(entry), parts = [...(item.caption || [])], merged = [];
    for (const record of texts) {
      if (Buffer.byteLength([...parts, record.text].join('\n'), 'utf8') > 8192) break;
      parts.push(record.text); merged.push(record);
    }
    const base = part => ({ id: part.id, messageId: part.messageId, sentAt: part.sentAt, senderUid: channel.pairedUid,
      status: 'dispatch_unknown', dispatchedAt });
    // Same durable shape as a claimed text, so an older worker reads this journal.
    const records = [
      ...photosOf(item).map(part => ({ ...base(part), digest: item.notice
        ? nativeDigest([part.messageId, part.sentAt, 'notice', item.notice])
        : nativeDigest([part.messageId, part.sentAt, 'photo', part.sha256 || part.error]) })),
      ...merged.map(record => ({ ...record, status: 'dispatch_unknown', dispatchedAt })),
    ];
    journal.updateMany('inbound', records);
    entry.items.splice(entry.items.indexOf(item), 1);
    const id = records[0].id, text = parts.join('\n');
    entry.delivered.set(id, { item, dispatchedAt });
    return { status: 'message', ...publicChannel(channel), event: {
      id, messageId: records[0].messageId, sentAt: item.startedAt, senderUid: channel.pairedUid,
      ...(text ? { text } : {}), parts: records.length,
      ...(item.notice ? { notice: item.notice } : { media: item.photos.map((photo, index) => photo.state === 'ready'
        ? { index, mime: photo.mime, bytes: photo.bytes.length, width: photo.width, height: photo.height, sha256: photo.sha256 }
        : { index, error: photo.error }) }) } };
  }

  function attach({ accountId, ownUid, api, isActive }) {
    if (closing) throw new Error('native_bridge_closed');
    const candidates = channels.filter(({ channel: c }) => c.accountId === accountId);
    if (!candidates.length) return null;
    if (!nativeUid(ownUid) || candidates.some(({ channel: c }) => c.ownUid !== ownUid)) throw new Error('native_session_identity_mismatch');
    const source = { ownUid, api, isActive, connectedAt: now() };
    attached.set(accountId, source);
    return {
      close() { if (attached.get(accountId) === source) attached.delete(accountId); },
      async capture(event) {
        try {
          if (own(event, 'type') !== 0) return false;
          const data = own(event, 'data');
          const threadId = own(event, 'threadId');
          const entry = candidates.find(({ channel: c }) => c.pairedUid === threadId ||
            c.pairedUid === own(data, 'uidFrom') || c.pairedUid === own(data, 'idTo'));
          if (!entry) return false;
          // Linking remains a separate redacted CRM protocol, including echoes,
          // malformed codes and quoted markers; none enters personal memory.
          if (isHermesLinkMessage(event)) return false;
          // The paired DM remains private even if malformed, stale or an echo.
          const { channel, journal } = entry;
          const msgType = own(data, 'msgType');
          const kind = msgType === 'chat.photo' ? 'photo' : typeof msgType === 'string' && NOTICES.has(msgType) ? 'notice' : null;
          // Every dropped photo/notice leaves a code-only fault (no URL, ID or
          // content), so a provider payload shape that is always filtered shows up.
          const drop = reason => { if (kind) fault(`native_${kind}_dropped:${reason}`); return true; };
          if (attached.get(accountId) !== source || !isActive()) return drop('inactive');
          if (own(event, 'isSelf') !== false) return drop('echo');
          if (own(data, 'uidFrom') !== channel.pairedUid || own(data, 'idTo') !== ownUid ||
              threadId !== channel.pairedUid) return drop('peer');
          if (flagged(event, QUOTES) || flagged(data, QUOTES)) return drop('quoted');
          const forwarded = flagged(event, FORWARDS) || flagged(data, FORWARDS);
          const messageId = own(data, 'msgId');
          const timestamp = own(data, 'ts');
          const sentAt = typeof timestamp === 'string' && /^[1-9][0-9]{0,15}$/.test(timestamp) ? Number(timestamp) : timestamp;
          if (!nativeId(messageId) || !Number.isSafeInteger(sentAt)) return drop('invalid');
          if (sentAt < Math.max(source.connectedAt - 30000, now() - 300000) || sentAt > now() + 30000) return drop('stale');
          const id = nativeDigest([channel.accountId, channel.generation, channel.pairedUid, messageId]);
          if (msgType === 'webchat') {
            const text = own(data, 'content');
            if (forwarded || !validText(text, 8192)) return true;
            journal.admit(id, { id, messageId, text, sentAt, senderUid: channel.pairedUid,
              digest: nativeDigest([messageId, sentAt, text]), status: 'queued' });
          } else if (kind === 'photo') capturePhoto(entry, data, { id, messageId, sentAt }, forwarded);
          else if (kind === 'notice') captureNotice(entry, NOTICES.get(msgType), { id, messageId, sentAt });
          // Stickers and unknown kinds are swallowed: still never CRM inbox.
          return true;
        } catch { onFault('native_capture_failed'); return true; } // Never leak a personal DM into CRM.
      },
    };
  }

  const activeSource = channel => {
    const source = attached.get(channel.accountId);
    return !closing && source?.ownUid === channel.ownUid && source.isActive() ? source : null;
  };
  // A human decision (sent or not_sent) recorded by the operator reconcile
  // command releases quarantine for NEW request IDs only when it matches every
  // unknown record of this channel exactly. Synchronous by design: no await may
  // separate this read from the durable admission that follows it. Never
  // releases while this process still awaits the provider for that record.
  const reconciled = ({ channel, pending }, unknown) => {
    if (!reconciliationFile || unknown.some(record => pending.has(record.id))) return false;
    let entries;
    try { ({ entries } = readNativeReconciliations(reconciliationFile)); }
    catch { onFault('native_reconciliation_unreadable'); return false; }
    return unknown.every(record => nativeReconciliationFor(entries, channel, record) !== null);
  };
  async function dispatch(entry, route, body) {
    const { channel, journal, pending } = entry;
    if (closing) return { status: 'unavailable' };
    if (route === '/v1/channel' && exact(body, [])) return { ...publicChannel(channel), connected: !!activeSource(channel) };
    if (body.generation !== channel.generation) throw new Error('generation_mismatch');
    if (route === '/v1/receive' && (exact(body, ['generation']) || exact(body, ['generation', 'accept']) &&
        Array.isArray(body.accept) && body.accept.length <= ACCEPT.length &&
        new Set(body.accept).size === body.accept.length && body.accept.every(kind => ACCEPT.includes(kind)))) {
      // Handshake: only an adapter that declares a kind on this poll gets it.
      // A poll without `accept` (older adapter) can never take queued media.
      const declared = body.accept || [], until = now() + limits.acceptMs;
      entry.accept = { photo: declared.includes('photo') ? until : 0, notice: declared.includes('notice') ? until : 0 };
      discard(entry, item => declared.includes(item.notice ? 'notice' : 'photo'), 'native_media_not_accepted');
      if (!activeSource(channel)) return { status: 'unavailable' };
      sweep();
      const queued = journal.values('inbound').filter(record => record.status === 'queued');
      const [item, after] = entry.items;
      let next = queued[0];
      if (item && !(next?.sentAt < item.startedAt)) {
        next = queued.find(record => command(record));
        if (!next) {
          // Text typed after a photo joins its event; the text stays durable in
          // the journal while the group settles.
          const texts = item.notice ? [] : queued.filter(record => record.sentAt >= item.startedAt && !(record.sentAt >= after?.startedAt));
          return ripe(item, texts.length > 0 || !!after) ? claim(entry, item, texts) : { status: 'empty' };
        }
      }
      if (!next) return { status: 'empty' };
      // Claim-before-delivery: a lost response/crash is ambiguous and is never replayed.
      journal.update('inbound', next.id, { ...next, status: 'dispatch_unknown', dispatchedAt: stamp(entry) });
      return { status: 'message', ...publicChannel(channel), event: {
        id: next.id, messageId: next.messageId, text: next.text, sentAt: next.sentAt, senderUid: next.senderUid } };
    }
    if (route === '/v1/media' && exact(body, ['generation', 'eventId', 'index']) &&
        Number.isInteger(body.index) && body.index >= 0 && body.index < limits.photosPerEvent) {
      // Only a delivered, unacknowledged group of this channel, for a bounded time.
      const group = typeof body.eventId === 'string' ? entry.delivered.get(body.eventId) : undefined;
      const photo = group && now() - group.dispatchedAt <= limits.deliveredMs ? group.item.photos?.[body.index] : null;
      if (!photo?.bytes) throw new MediaUnavailable();
      return { [BINARY]: photo };
    }
    if (route === '/v1/ack' && exact(body, ['generation', 'eventId', 'status']) &&
        ['accepted', 'rejected', 'dispatch_unknown'].includes(body.status)) {
      const event = journal.get('inbound', body.eventId);
      if (!event || event.status === 'queued') throw new Error('event_not_dispatched');
      // A claim stamps all its records with one dispatchedAt no other claim has, so
      // the whole media group closes even after byte expiry or a worker restart.
      const members = event.status !== 'dispatch_unknown' ? [event] : journal.values('inbound')
        .filter(record => record.status === 'dispatch_unknown' && record.dispatchedAt === event.dispatchedAt);
      // After admission the text lives in Hermes' own profile; keep only the tombstone here.
      journal.updateMany('inbound', members.map(({ text: _text, ...receipt }) =>
        ({ ...receipt, status: body.status, acknowledgedAt: now() })));
      const group = entry.delivered.get(event.id);
      if (group) { entry.delivered.delete(event.id); release(group.item); }
      return { status: body.status };
    }
    if (route === '/v1/send' && exact(body, ['generation', 'requestId', 'text']) &&
        nativeId(body.requestId) && validText(body.text, 32768)) {
      const digest = nativeDigest(body.text);
      const prior = journal.get('outbound', body.requestId);
      if (prior) {
        if (prior.digest !== digest) throw new Error('request_id_conflict');
        return { status: prior.status, messageId: prior.messageId || null };
      }
      const outbound = journal.values('outbound');
      // Upstream callers can retry with a new ID AND transformed text (cron
      // live -> standalone). Without a stable delivery identity, any unresolved
      // provider effect quarantines this channel, including across restart,
      // until a human reconciles every such record. The unknown record itself
      // stays outcome_unknown and is never resent. This check and the durable
      // admission below contain no await.
      const unknown = outbound.filter(record => record.status === 'outcome_unknown');
      if (unknown.length && !reconciled(entry, unknown)) return { status: 'outcome_unknown' };
      if (outbound.length >= 100000) throw new Error('native_journal_capacity');
      const source = activeSource(channel);
      if (!source) return { status: 'unavailable' };
      if (providers.size >= maxProviderPending) return { status: 'busy' };
      const record = { id: body.requestId, digest, status: 'outcome_unknown', startedAt: now() };
      journal.update('outbound', body.requestId, record);
      if (activeSource(channel) !== source) return { status: 'outcome_unknown' };
      let timer;
      try {
        const provider = Promise.resolve().then(() => {
          if (activeSource(channel) !== source) throw new Error('native_session_changed');
          return source.api.sendMessage({ msg: body.text }, channel.pairedUid, 0);
        }).then(result => {
          const messageId = nativeTextReceipt(result);
          // Unrecognized receipt stays outcome_unknown; the operator sees only a
          // redacted shape (key names and kinds), never text or IDs.
          if (!messageId) { fault(`native_receipt_unrecognized ${describeReceiptShape(result)}`); return { status: 'outcome_unknown' }; }
          // Persist terminal proof even when the HTTP observation timed out.
          // Slot release and shutdown drain wait for this write as well.
          try { journal.update('outbound', body.requestId, { ...record, status: 'sent', messageId, finishedAt: now() }); }
          catch (error) { fault('native_receipt_unrecordable'); throw error; }
          return { status: 'sent', messageId };
        });
        providers.add(provider); pending.add(body.requestId);
        // Observation timeout does not release this admission slot, ownership
        // or the in-process hold on reconciliation release for this record.
        const settle = () => { providers.delete(provider); pending.delete(body.requestId); };
        provider.then(settle, settle);
        return await Promise.race([
          provider,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider_timeout')), providerTimeoutMs); }),
        ]);
      } catch { return { status: 'outcome_unknown' }; }
      finally { clearTimeout(timer); }
    }
    throw new Error('invalid_native_request');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    if (closing || requests >= 32) { res.writeHead(503); res.end('{"error":"native_busy"}'); return; }
    requests++;
    try {
      if (req.method !== 'POST' || req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) throw new Error('invalid_request');
      const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      const entry = channels.find(({ channel }) => supplied.length === Buffer.byteLength(channel.token) &&
        timingSafeEqual(supplied, Buffer.from(channel.token)));
      if (!entry) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      const parts = []; let length = 0;
      // A 32 KiB text may expand six-fold when JSON-escaped. Decode once after
      // framing so a UTF-8 character split across TCP chunks stays intact.
      for await (const part of req) {
        length += part.length;
        if (length > 200000) throw new Error('body_too_large');
        parts.push(part);
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      const body = JSON.parse(raw || '{}');
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('invalid_request');
      const result = await dispatch(entry, req.url, body);
      const photo = result?.[BINARY];
      if (photo) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Media-Type', photo.mime); res.setHeader('X-Media-Sha256', photo.sha256);
        res.setHeader('Content-Length', photo.bytes.length);
        res.writeHead(200); res.end(photo.bytes); return;
      }
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      const missing = error instanceof MediaUnavailable;
      const rejected = error instanceof SyntaxError || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ||
        CLIENT_ERRORS.has(error?.message);
      if (!res.headersSent) res.writeHead(missing ? 404 : rejected ? 400 : 503);
      res.end(missing ? '{"error":"media_unavailable"}' : rejected ? '{"error":"native_request_rejected"}' : '{"error":"native_unavailable"}');
    } finally { requests--; }
  });
  server.requestTimeout = 65000; server.headersTimeout = 10000;
  server.maxConnections = 64;
  const bridge = {
    attach, isPrivateThread,
    async listen(port = config.listenPort) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      if (!closing) {
        attached.clear();
        clearInterval(sweeper);
        for (const entry of channels) {
          entry.items.forEach(release); entry.items = [];
          for (const { item } of entry.delivered.values()) release(item);
          entry.delivered.clear();
        }
        closing = (async () => {
          await new Promise(resolve => server.close(resolve));
          await Promise.allSettled([...providers]);
          if (nativeBridge === bridge) nativeBridge = null;
        })();
      }
      return closing;
    },
  };
  return bridge;
}

let nativeBridge = null;
export const getNativeBridge = () => nativeBridge;
export async function startNativeBridge({ onFault } = {}) {
  const configFile = process.env.HERMES_ZALO_NATIVE_CONFIG;
  const config = readNativeConfig(configFile);
  if (!config) return null;
  if (nativeBridge) throw new Error('native_bridge_already_started');
  // The operator ledger beside this exact config is re-read before each new
  // send on a quarantined channel; no restart is needed after reconcile.
  const bridge = createNativeBridge({ config, onFault, reconciliationFile: nativeReconciliationFile(configFile) });
  await bridge.listen(); nativeBridge = bridge;
  return bridge;
}
