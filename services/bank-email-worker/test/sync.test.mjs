import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { seal } from '../src/crypto.mjs';
import { createGoogleClient } from '../src/google.mjs';
import { MessageVerificationError } from '../src/message.mjs';
import { processJob, runClaimCycle } from '../src/sync.mjs';

const key = randomBytes(32);
const connectionId = '11111111-1111-4111-8111-111111111111';
const job = { connectionId, leaseToken: 'lease', encryptedRefreshToken: seal('refresh', key, `refresh:${connectionId}`),
  email: 'owner@example.test', historyId: '100', watchExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), disconnect: false,
  scanPageToken: null, scanHistoryId: null };
const message = id => ({ id, raw: Buffer.from('synthetic').toString('base64url'), internalDate: '1791090000000' });
const metadata = (id, from = 'ACB <mailalert@acb.com.vn>') => ({ id, internalDate: '1791090000000', sizeEstimate: 100,
  payload: { headers: [{ name: 'From', value: from }] } });
const rpcAck = (op, payload) => op === 'page_pending' ? { pendingMessageIds: payload.messageIds } : { ok: true };

test('history pages persist all distinct messages before advancing cursor', async () => {
  const events = [];
  const rpc = async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); };
  const google = {
    refreshToken: async () => ({ access_token: 'access' }),
    history: async (_, __, token) => token
      ? { history: [{ messagesAdded: [{ message: { id: 'b' } }] }], historyId: '103' }
      : { history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }], nextPageToken: 'p2', historyId: '103' },
    getMessageMetadata: async (_, id) => metadata(id), getMessage: async (_, id) => message(id),
  };
  const verifyMessage = async () => ({ parsed: { account: '12345678', amount: 1 } });
  assert.equal(await processJob(job, { rpc, google, key, verifyMessage }), 'more');
  assert.deepEqual(events.filter(([op]) => op === 'ingest').map(([, payload]) => payload.messageId).sort(), ['a', 'b']);
  assert.deepEqual(events.filter(([op]) => op === 'page_progress').map(([, payload]) => payload.messageId), ['a', 'b']);
  assert.equal(events.some(([op]) => op === 'checkpoint'), false);
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].pageToken, 'p2');
  events.length = 0;
  assert.equal(await processJob({ ...job, historyStartId: '100', historyPageToken: 'p2' }, { rpc, google, key, verifyMessage }), 'complete');
  assert.deepEqual(events.filter(([op]) => op === 'ingest').map(([, payload]) => payload.messageId), ['b']);
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].finalHistoryId, '103');
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].complete, true);
  assert.equal(events.at(-1)[0], 'finish');
});

test('ingest failure leaves cursor untouched and marks job retryable', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); if (op === 'ingest') throw new Error('storage unavailable'); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ history: [{ messagesAdded: [{ message: { id: 'a' } }] }], historyId: '101' }),
      getMessageMetadata: async () => metadata('a'), getMessage: async () => message('a') },
    key, verifyMessage: async () => ({ parsed: {} }),
  });
  assert.equal(events.some(([op]) => op === 'checkpoint'), false);
  assert.equal(events.at(-1)[0], 'fail');
});

test('expired history scans pages durably and only then advances snapshot cursor', async () => {
  const events = [];
  const result = await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => { const error = new Error('expired'); error.status = 404; throw error; },
      profile: async () => ({ historyId: '200' }),
      listMessages: async () => ({ messages: [{ id: 'old' }], nextPageToken: 'next' }),
      getMessageMetadata: async () => metadata('old'), getMessage: async () => message('old') },
    key, verifyMessage: async () => ({ parsed: {} }),
  });
  assert.equal(result, 'more');
  assert.deepEqual(events.map(([op]) => op), ['history_checkpoint', 'scan_checkpoint', 'page_pending', 'ingest', 'page_progress', 'scan_checkpoint', 'finish']);
  assert.equal(events.some(([op]) => op === 'checkpoint'), false);
  assert.equal(events[5][1].pageToken, 'next');
});

test('invalid grant marks reconnect required without moving cursor', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => { const error = new Error('invalid_grant'); error.code = 'invalid_grant'; throw error; } },
    key,
  });
  assert.deepEqual(events.map(([op]) => op), ['fail']);
  assert.equal(events[0][1].reconnect, true);
});

test('daily watch renewal stores expiration while keeping the old cursor until history is read', async () => {
  const events = [];
  await processJob({ ...job, watchExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      watch: async () => ({ historyId: '999', expiration: String(Date.now() + 7 * 86_400_000) }),
      history: async () => ({ historyId: '101', history: [] }) },
    key, topic: 'projects/synthetic/topics/gmail',
  });
  assert.equal(events[0][0], 'watch_metadata');
  assert.equal(Object.hasOwn(events[0][1], 'historyId'), false);
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].finalHistoryId, '101');
});

test('watch renewal during an initial scan records expiration without creating a cursor', async () => {
  const events = [];
  await processJob({ ...job, historyId: null, watchExpiresAt: new Date(Date.now() + 1 * 86_400_000).toISOString() }, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      watch: async () => ({ historyId: '999', expiration: String(Date.now() + 7 * 86_400_000) }),
      profile: async () => ({ historyId: '200' }), listMessages: async () => ({ messages: [] }) },
    key, topic: 'projects/synthetic/topics/gmail',
  });
  assert.equal(events[0][0], 'watch_metadata');
  assert.equal(Object.hasOwn(events[0][1], 'historyId'), false);
  assert.equal(events.findLast(([op]) => op === 'scan_checkpoint')[1].scanHistoryId, '200');
});

test('oversized raw email is saved as pending and does not permanently block the history cursor', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'large' } }] }] }),
      getMessageMetadata: async () => metadata('large'), getMessage: async () => ({ ...message('large'), raw: 'x'.repeat(700_001) }) },
    key,
  });
  const ingest = events.find(([op]) => op === 'ingest')[1];
  assert.equal(ingest.verified, false);
  assert.equal(ingest.parseError, 'RAW_SIZE_LIMIT');
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].finalHistoryId, '101');
});

test('a deleted Gmail message becomes pending without treating it as expired history', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'gone' } }] }] }),
      getMessageMetadata: async () => metadata('gone'), getMessage: async () => { const error = new Error('missing'); error.status = 404; throw error; },
      profile: async () => { throw new Error('history scan must not start'); } },
    key,
  });
  assert.equal(events.find(([op]) => op === 'ingest')[1].parseError, 'MESSAGE_UNAVAILABLE');
  assert.equal(events.some(([op]) => op === 'scan_checkpoint'), false);
});

test('new connection full scan establishes snapshot before ingesting existing mail', async () => {
  const events = [];
  await processJob({ ...job, historyId: null }, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      profile: async () => ({ historyId: '200' }),
      listMessages: async () => ({ messages: [{ id: 'existing' }] }),
      getMessageMetadata: async () => metadata('existing'), getMessage: async () => message('existing') },
    key, verifyMessage: async () => ({ parsed: {} }),
  });
  assert.deepEqual(events.map(([op]) => op), ['scan_checkpoint', 'page_pending', 'ingest', 'page_progress', 'scan_checkpoint', 'finish']);
  assert.equal(events[0][1].scanHistoryId, '200');
  assert.equal(events[4][1].complete, true);
});

test('claim cycle processes leased jobs concurrently before their shared lease expires', async () => {
  const secondId = '22222222-2222-4222-8222-222222222222';
  const second = { ...job, connectionId: secondId,
    encryptedRefreshToken: seal('refresh-two', key, `refresh:${secondId}`) };
  let active = 0;
  let peak = 0;
  let finished = 0;
  await runClaimCycle({ key,
    rpc: async (op, payload) => {
      if (op === 'claim') return { jobs: [job, second] };
      if (op === 'finish') finished++;
      return rpcAck(op, payload);
    },
    google: { refreshToken: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { access_token: 'access' };
    }, history: async () => ({ historyId: '101', history: [] }) },
  });
  assert.equal(peak, 2);
  assert.equal(finished, 2);
});

test('ordinary Gmail message is marked processed without raw download or ACB inbox row', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'shopping' } }] }] }),
      getMessageMetadata: async () => metadata('shopping', 'Shop <offers@example.test>'),
      getMessage: async () => { throw new Error('ordinary message raw must not be fetched'); } },
    key,
  });
  assert.equal(events.some(([op]) => op === 'ingest'), false);
  assert.deepEqual(events.find(([op]) => op === 'page_progress')[1], {
    connectionId, leaseToken: 'lease', mode: 'history', pageToken: null, messageId: 'shopping',
  });
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].complete, true);
});

test('actual bounded Google raw response overflow becomes durable pending and history advances', async () => {
  const events = [];
  const google = createGoogleClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://worker.example.test/oauth/callback' },
    async url => {
      const path = String(url);
      if (path.endsWith('/token')) return new Response('{"access_token":"access"}', { status: 200 });
      if (path.includes('/history?')) return new Response(JSON.stringify({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'huge' } }] }] }), { status: 200 });
      if (path.includes('format=metadata')) return new Response(JSON.stringify(metadata('huge')), { status: 200 });
      if (path.includes('format=raw')) return new Response(JSON.stringify({ raw: 'x'.repeat(1_100_000), internalDate: '1791090000000' }), { status: 200 });
      throw new Error(`unexpected Google path ${path}`);
    });
  const result = await processJob(job, { key, google,
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    verifyMessage: async () => { throw new Error('oversized raw must not verify'); } });
  assert.equal(result, 'complete');
  assert.equal(events.find(([op]) => op === 'ingest')[1].parseError, 'RAW_SIZE_LIMIT');
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].finalHistoryId, '101');
});

test('Gmail sizeEstimate skips oversized raw fetch and keeps the ACB candidate pending', async () => {
  const events = [];
  await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'estimated-huge' } }] }] }),
      getMessageMetadata: async () => ({ ...metadata('estimated-huge'), sizeEstimate: 600_000 }),
      getMessage: async () => { throw new Error('oversized raw must not be requested'); } },
    key,
  });
  assert.equal(events.find(([op]) => op === 'ingest')[1].parseError, 'RAW_SIZE_LIMIT');
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].complete, true);
});

test('DKIM verification timeout stays unverified pending and advances the history cursor', async () => {
  const events = [];
  assert.equal(await processJob(job, {
    rpc: async (op, payload) => { events.push([op, payload]); return rpcAck(op, payload); },
    google: { refreshToken: async () => ({ access_token: 'access' }),
      history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'slow-signatures' } }] }] }),
      getMessageMetadata: async () => metadata('slow-signatures'),
      getMessage: async () => message('slow-signatures') },
    key, verifyMessage: async () => { throw new MessageVerificationError('DKIM_VERIFY_TIMEOUT'); },
  }), 'complete');
  const ingest = events.find(([op]) => op === 'ingest')[1];
  assert.equal(ingest.verified, false);
  assert.equal(ingest.parseError, 'DKIM_VERIFY_TIMEOUT');
  assert.equal(events.findLast(([op]) => op === 'history_checkpoint')[1].complete, true);
});

test('deadline resumes from durable completed IDs inside one slow history page', async () => {
  const processed = new Set();
  const events = [];
  let slowSecond = true;
  const google = { refreshToken: async () => ({ access_token: 'access' }),
    history: async () => ({ historyId: '101', history: [{ messagesAdded: [
      { message: { id: 'first' } }, { message: { id: 'second' } },
    ] }] }),
    getMessageMetadata: async (_, id) => {
      if (id === 'second' && slowSecond) {
        slowSecond = false;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return metadata(id);
    },
    getMessage: async (_, id) => { events.push(['raw', id]); return message(id); },
  };
  const rpc = async (op, payload) => {
    events.push([op, payload]);
    if (op === 'page_pending') return { pendingMessageIds: payload.messageIds.filter(id => !processed.has(id)) };
    if (op === 'page_progress') processed.add(payload.messageId);
    return rpcAck(op, payload);
  };
  assert.equal(await processJob(job, { key, google, rpc, verifyMessage: async () => ({ parsed: {} }), deadlineMs: 100 }), 'retry');
  assert.deepEqual([...processed], ['first']);
  assert.equal(await processJob({ ...job, historyStartId: '100' },
    { key, google, rpc, verifyMessage: async () => ({ parsed: {} }), deadlineMs: 100 }), 'complete');
  assert.deepEqual(events.filter(([op]) => op === 'raw').map(([, id]) => id), ['first', 'second']);
  assert.deepEqual([...processed], ['first', 'second']);
});

test('large history page queries bounded pending chunks and progresses past 1000 IDs', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `message${index}`);
  const done = new Set();
  const batches = [];
  let metadataReads = 0;
  const rpc = async (op, payload) => {
    if (op === 'page_pending') {
      batches.push(payload.messageIds.length);
      return { pendingMessageIds: payload.messageIds.filter(id => !done.has(id)) };
    }
    if (op === 'page_progress') done.add(payload.messageId);
    return rpcAck(op, payload);
  };
  const google = { refreshToken: async () => ({ access_token: 'access' }),
    history: async () => ({ historyId: '101', history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }] }),
    getMessageMetadata: async (_, id) => { metadataReads++; return metadata(id, 'Shop <offers@example.test>'); },
    getMessage: async () => { throw new Error('ordinary mail raw must not be fetched'); },
  };
  assert.equal(await processJob(job, { key, rpc, google }), 'complete');
  assert.equal(metadataReads, ids.length);
  assert.equal(done.size, ids.length);
  assert.deepEqual(batches, [500, 500, 1]);
});

test('large history page resumes from durable pending lookup without claim cache', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `message${index}`);
  const done = new Set(ids.slice(0, 1000));
  const metadataReads = [];
  const rpc = async (op, payload) => {
    if (op === 'page_pending') return { pendingMessageIds: payload.messageIds.filter(id => !done.has(id)) };
    if (op === 'page_progress') done.add(payload.messageId);
    return rpcAck(op, payload);
  };
  const google = { refreshToken: async () => ({ access_token: 'access' }),
    history: async () => ({ historyId: '101', history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }] }),
    getMessageMetadata: async (_, id) => { metadataReads.push(id); return metadata(id, 'Shop <offers@example.test>'); },
    getMessage: async () => { throw new Error('ordinary mail raw must not be fetched'); },
  };
  assert.equal(await processJob({ ...job, historyStartId: '100' },
    { key, rpc, google }), 'complete');
  assert.deepEqual(metadataReads, ['message1000']);
  assert.equal(done.size, ids.length);
});
