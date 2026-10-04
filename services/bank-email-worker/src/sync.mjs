import { open } from './crypto.mjs';
import { simpleParser } from 'mailparser';
import { verifyAcbMessage as defaultVerifyMessage, MessageVerificationError } from './message.mjs';
import { AcbParseError } from './parser.mjs';

const MAX_GMAIL_RAW_BASE64 = 700_000;
const MAX_RAW_BYTES = 512 * 1024;
const LEASE_WORK_MS = 80_000;

function errorCode(error) {
  if (error?.code === 'invalid_grant' || error?.code === 'invalid_token') return 'GOOGLE_AUTH_REVOKED';
  if (error?.status === 401) return 'GOOGLE_AUTH_REVOKED';
  if (error instanceof AcbParseError || error instanceof MessageVerificationError) return error.code;
  if (error?.code === 'WORK_DEADLINE') return 'WORK_DEADLINE';
  return 'SYNC_FAILED';
}

function ensureTime(deadline) {
  if (Date.now() > deadline) {
    const error = new Error('deadline');
    error.code = 'WORK_DEADLINE';
    throw error;
  }
}

async function isAcbCandidate(metadata) {
  const fromHeaders = metadata?.payload?.headers?.filter(header => header?.name?.toLowerCase() === 'from') ?? [];
  if (fromHeaders.length !== 1 || typeof fromHeaders[0].value !== 'string' ||
      fromHeaders[0].value.length > 1000 || /[\r\n]/u.test(fromHeaders[0].value)) return false;
  const parsed = await simpleParser(`From: ${fromHeaders[0].value}\r\n\r\n`, { skipHtmlToText: true, skipTextToHtml: true });
  return parsed.from?.value?.length === 1 && parsed.from.value[0].address?.toLowerCase() === 'mailalert@acb.com.vn';
}

async function ingestMessage(job, id, accessToken, { rpc, google, verifyMessage }, deadline) {
  ensureTime(deadline);
  let metadata;
  try {
    metadata = await google.getMessageMetadata(accessToken, id);
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
  ensureTime(deadline);
  if (!await isAcbCandidate(metadata)) return;
  const estimatedSize = Number(metadata.sizeEstimate);
  const tooLarge = Number.isFinite(estimatedSize) && estimatedSize > MAX_RAW_BYTES;
  let message;
  let unavailableCode = null;
  if (tooLarge) {
    message = { raw: null, internalDate: metadata.internalDate };
    unavailableCode = 'RAW_SIZE_LIMIT';
  } else {
    ensureTime(deadline);
    try {
      message = await google.getMessage(accessToken, id);
    } catch (error) {
      if (error.status === 404) {
        message = { raw: null, internalDate: metadata.internalDate };
        unavailableCode = 'MESSAGE_UNAVAILABLE';
      } else if (error.code === 'GOOGLE_RESPONSE_LIMIT') {
        message = { raw: null, internalDate: metadata.internalDate };
        unavailableCode = 'RAW_SIZE_LIMIT';
      } else throw error;
    }
  }
  ensureTime(deadline);
  const timestamp = Number(message.internalDate ?? metadata.internalDate);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('invalid internal date');
  let parsed = null;
  let verified = false;
  let parseError = null;
  if (message.raw === null) {
    parseError = unavailableCode ?? 'MESSAGE_UNAVAILABLE';
  } else if (typeof message.raw !== 'string' || message.raw.length > MAX_GMAIL_RAW_BASE64) {
    parseError = 'RAW_SIZE_LIMIT';
  } else if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(message.raw)) {
    parseError = 'INVALID_RAW_ENCODING';
  } else {
    try {
      const outcome = await verifyMessage(Buffer.from(message.raw, 'base64url'));
      parsed = outcome.parsed;
      verified = true;
    } catch (error) {
      parseError = errorCode(error);
      verified = error instanceof AcbParseError;
    }
  }
  ensureTime(deadline);
  await rpc('ingest', {
    connectionId: job.connectionId, leaseToken: job.leaseToken,
    messageId: id, internalDate: new Date(timestamp).toISOString(),
    verified, parsed, parseError,
  });
}

async function processPageId(job, id, accessToken, deps, deadline, mode, pageToken, processed) {
  if (processed.has(id)) return;
  ensureTime(deadline);
  await ingestMessage(job, id, accessToken, deps, deadline);
  ensureTime(deadline);
  await deps.rpc('page_progress', { connectionId: job.connectionId, leaseToken: job.leaseToken,
    mode, pageToken, messageId: id });
  processed.add(id);
}

async function processPageIds(job, ids, accessToken, deps, deadline, mode, pageToken) {
  const distinct = [...new Set(ids)];
  for (let offset = 0; offset < distinct.length; offset += 500) {
    ensureTime(deadline);
    const batch = distinct.slice(offset, offset + 500);
    const result = await deps.rpc('page_pending', { connectionId: job.connectionId,
      leaseToken: job.leaseToken, mode, pageToken, messageIds: batch });
    if (!Array.isArray(result?.pendingMessageIds) ||
        result.pendingMessageIds.some(id => !batch.includes(id))) throw new Error('invalid page pending response');
    const processed = new Set(batch.filter(id => !result.pendingMessageIds.includes(id)));
    for (const id of result.pendingMessageIds) {
      await processPageId(job, id, accessToken, deps, deadline, mode, pageToken, processed);
    }
  }
}

async function scan(job, accessToken, deps, deadline) {
  let scanHistoryId = job.scanHistoryId;
  if (!scanHistoryId) {
    const profile = await deps.google.profile(accessToken);
    scanHistoryId = profile.historyId;
    if (!/^\d+$/u.test(scanHistoryId ?? '')) throw new Error('invalid history snapshot');
    await deps.rpc('scan_checkpoint', { connectionId: job.connectionId, leaseToken: job.leaseToken,
      scanHistoryId, pageToken: job.scanPageToken ?? null, complete: false });
  }
  ensureTime(deadline);
  const page = await deps.google.listMessages(accessToken, job.scanPageToken ?? null);
  await processPageIds(job, (page.messages ?? []).map(item => item?.id).filter(Boolean), accessToken,
    deps, deadline, 'scan', job.scanPageToken ?? null);
  await deps.rpc('scan_checkpoint', { connectionId: job.connectionId, leaseToken: job.leaseToken,
    scanHistoryId, pageToken: page.nextPageToken ?? null, complete: !page.nextPageToken });
  return page.nextPageToken ? 'more' : 'complete';
}

async function history(job, accessToken, deps, deadline) {
  const ids = new Set();
  const startHistoryId = job.historyStartId ?? job.historyId;
  if (!job.historyStartId) {
    await deps.rpc('history_checkpoint', { connectionId: job.connectionId, leaseToken: job.leaseToken,
      startHistoryId, pageToken: null, complete: false });
  }
  ensureTime(deadline);
  let page;
  try {
    page = await deps.google.history(accessToken, startHistoryId, job.historyPageToken ?? null);
  } catch (error) {
    if (error.status !== 404) throw error;
    throw Object.assign(new Error('history expired'), { code: 'HISTORY_EXPIRED' });
  }
  for (const entry of page.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.id) ids.add(added.message.id);
    }
  }
  await processPageIds(job, ids, accessToken, deps, deadline, 'history', job.historyPageToken ?? null);
  await deps.rpc('history_checkpoint', { connectionId: job.connectionId, leaseToken: job.leaseToken,
    startHistoryId, pageToken: page.nextPageToken ?? null, complete: !page.nextPageToken,
    ...(page.nextPageToken ? {} : { finalHistoryId: page.historyId ?? startHistoryId }) });
  return page.nextPageToken ? 'more' : 'complete';
}

export async function processJob(job, { rpc, google, key, verifyMessage = defaultVerifyMessage, topic, deadlineMs = LEASE_WORK_MS }) {
  const deadline = Date.now() + deadlineMs;
  try {
    const refreshToken = open(job.encryptedRefreshToken, key, `refresh:${job.connectionId}`);
    if (job.disconnect) {
      await google.revoke(refreshToken);
      await rpc('finish', { connectionId: job.connectionId, leaseToken: job.leaseToken });
      return 'disconnected';
    }
    const tokens = await google.refreshToken(refreshToken);
    if (!tokens.access_token) throw Object.assign(new Error('invalid token'), { code: 'invalid_grant' });
    const accessToken = tokens.access_token;
    if (!job.watchExpiresAt || Date.parse(job.watchExpiresAt) < Date.now() + 6 * 24 * 60 * 60 * 1000) {
      const watch = await google.watch(accessToken, topic);
      // Keep the stored cursor. A watch response only describes a fresh snapshot.
      if (!/^\d+$/u.test(watch.expiration ?? '')) throw new Error('invalid watch expiration');
      await rpc('watch_metadata', { connectionId: job.connectionId, leaseToken: job.leaseToken,
        watchExpiresAt: new Date(Number(watch.expiration)).toISOString() });
    }
    let outcome = 'complete';
    if (job.scanHistoryId || job.scanPageToken || !job.historyId) {
      outcome = await scan(job, accessToken, { rpc, google, verifyMessage }, deadline);
    } else {
      try {
        outcome = await history(job, accessToken, { rpc, google, verifyMessage }, deadline);
      } catch (error) {
        if (error.code !== 'HISTORY_EXPIRED') throw error;
        outcome = await scan(job, accessToken, { rpc, google, verifyMessage }, deadline);
      }
    }
    await rpc('finish', { connectionId: job.connectionId, leaseToken: job.leaseToken });
    return outcome;
  } catch (error) {
    const code = errorCode(error);
    if (error?.code === '42501' || error?.code === '40001') return 'stale';
    try {
      await rpc('fail', { connectionId: job.connectionId, leaseToken: job.leaseToken,
        errorCode: code, reconnect: code === 'GOOGLE_AUTH_REVOKED' });
    } catch {
      // Expired leases are picked up by the next claim cycle.
    }
    return 'retry';
  }
}

export async function runClaimCycle({ rpc, google, key, verifyMessage, topic }) {
  const result = await rpc('claim', {});
  return Promise.allSettled((result.jobs ?? []).map(job => processJob(job, { rpc, google, key, verifyMessage, topic })));
}
