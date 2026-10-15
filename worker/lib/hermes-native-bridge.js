import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createNativeJournal, nativeDigest } from './hermes-native-journal.js';
import { nativeId, nativeUid, readNativeConfig } from './hermes-native-config.js';
import { nativeReconciliationFile, nativeReconciliationFor, readNativeReconciliations } from './hermes-native-reconciliation.js';
import { isHermesLinkMessage } from './hermes-link.js';
import { describeReceiptShape, providerTextReceipt } from './hermes-native-receipt.js';

const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
};
const references = value => ['quote', 'reference', 'decorLog', 'forward', 'isForward', 'fw'].some(key => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && (!Object.hasOwn(property, 'value') || property.value != null && property.value !== false);
});
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
export function createNativeBridge({ config, reconciliationFile = null, now = Date.now, providerTimeoutMs = 60000, maxProviderPending = 8, onFault = () => {} }) {
  if (!Number.isInteger(maxProviderPending) || maxProviderPending < 1 || maxProviderPending > 32 ||
      !Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1 || providerTimeoutMs > 60000) throw new Error('invalid_native_limits');
  // Operator diagnostics only; a failing logger never changes a send outcome.
  const fault = code => { try { onFault(code); } catch { /* diagnostics only */ } };
  const channels = config.channels.map(channel => ({ channel, pending: new Set(),
    journal: createNativeJournal(config.stateRoot, channel) }));
  const attached = new Map();
  const providers = new Set();
  let closing = null, requests = 0;
  const isPrivateThread = (accountId, threadId) => channels.some(({ channel: c }) =>
    c.accountId === accountId && c.pairedUid === threadId);

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
          if (attached.get(accountId) !== source || !isActive() || own(event, 'isSelf') !== false ||
              own(data, 'uidFrom') !== channel.pairedUid || own(data, 'idTo') !== ownUid ||
              threadId !== channel.pairedUid || own(data, 'msgType') !== 'webchat' ||
              references(event) || references(data)) return true;
          const messageId = own(data, 'msgId'), text = own(data, 'content');
          const timestamp = own(data, 'ts');
          const sentAt = typeof timestamp === 'string' && /^[1-9][0-9]{0,15}$/.test(timestamp) ? Number(timestamp) : timestamp;
          if (!nativeId(messageId) || !validText(text, 8192) || !Number.isSafeInteger(sentAt) ||
              sentAt < Math.max(source.connectedAt - 30000, now() - 300000) || sentAt > now() + 30000) return true;
          const id = nativeDigest([channel.accountId, channel.generation, channel.pairedUid, messageId]);
          journal.admit(id, { id, messageId, text, sentAt, senderUid: channel.pairedUid,
            digest: nativeDigest([messageId, sentAt, text]), status: 'queued' });
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
    if (route === '/v1/receive' && exact(body, ['generation'])) {
      if (!activeSource(channel)) return { status: 'unavailable' };
      const next = journal.values('inbound').find(record => record.status === 'queued');
      if (!next) return { status: 'empty' };
      // Claim-before-delivery: a lost response/crash is ambiguous and is never replayed.
      journal.update('inbound', next.id, { ...next, status: 'dispatch_unknown', dispatchedAt: now() });
      return { status: 'message', ...publicChannel(channel), event: {
        id: next.id, messageId: next.messageId, text: next.text, sentAt: next.sentAt, senderUid: next.senderUid } };
    }
    if (route === '/v1/ack' && exact(body, ['generation', 'eventId', 'status']) &&
        ['accepted', 'rejected', 'dispatch_unknown'].includes(body.status)) {
      const event = journal.get('inbound', body.eventId);
      if (!event || event.status === 'queued') throw new Error('event_not_dispatched');
      // After admission the text lives in Hermes' own profile; keep only the tombstone here.
      const { text: _text, ...receipt } = event;
      journal.update('inbound', event.id, { ...receipt, status: body.status, acknowledgedAt: now() });
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
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch { if (!res.headersSent) res.writeHead(400); res.end('{"error":"native_request_rejected"}'); }
    finally { requests--; }
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
