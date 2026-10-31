#!/usr/bin/env node
// Nạp đề xuất bài học vào CRM. Đọc outbox của learning_audit.py (CHỈ đề xuất, đã che; không đọc báo cáo đủ ở private/, không
// đọc hồ sơ Hermes) rồi gọi app_private.hermes_store_learning_ingest_v1 qua store-transport phạm vi 'learning': login riêng
// thuộc vai NOLOGIN hermes_learning_ingest (chỉ được gọi đúng hàm này, KHÔNG thuộc hermes_store_executor của connector),
// TLS xác minh, không service_role, không JWT người dùng.
//   - Mỗi hồ sơ có ánh xạ: ít nhất một lời gọi mỗi lần chạy — nhịp "lần kiểm cuối" (auditGeneratedAt) kể cả khi không có đề
//     xuất, để trang CRM báo khi job kiểm ngừng chạy.
//   - Gửi lại đề xuất của các outbox trong `replayDays` ngày (SQL bỏ trùng theo công ty + dedupeKey): một lần nạp hỏng không
//     làm mất đề xuất.
//   - Kiểm khuôn ĐÚNG như SQL trước khi gửi (mục lệch bị bỏ và báo dedupeKey); lô bị SQL từ chối (store_rejected) thì thử nhịp
//     riêng rồi gửi lại TỪNG đề xuất, chỉ bỏ đúng mục hỏng và báo dedupeKey của nó.
// Log chỉ có số đếm + dedupeKey (băm), không nội dung đề xuất, không mật khẩu/chuỗi kết nối.
import { constants } from 'node:fs';
import { lstat as fsLstat, open as fsOpen, readdir as fsReaddir } from 'node:fs/promises';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

// Job chỉ chạy trên Linux: đường dẫn cấu hình là POSIX tuyệt đối (giữ nguyên khi chạy test trên Windows).
const path = nodePath.posix;
export const OUTBOX_SCHEMA_VERSION = 1;
const MAX_BATCH = 25;
// Trần payload của store-transport / hermes_request_v1 là 131 072 B; chừa chỗ cho khoá ngoài + mã hoá JSON.
const MAX_BATCH_BYTES = 96 * 1024;
const MAX_OUTBOX_BYTES = 8 * 1024 * 1024;
const MAX_OUTBOX_FILES = 64;
const MAX_LOGGED_KEYS = 20;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/;
const OUTBOX_FILE = /^learning-outbox-(\d{8}T\d{6}Z)\.json$/;
const KINDS = new Set(['skill_crm_write', 'memory_crm_write']);
const RETRYABLE = new Set(['store_outcome_unknown', 'store_unavailable', 'store_conflict', 'store_timeout', 'store_cancelled']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class IngestError extends Error {
  constructor(code) { super(code); this.name = 'IngestError'; this.code = code; }
}
const fail = code => { throw new IngestError(code); };
const exact = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

const defaultIo = () => ({ lstat: fsLstat, open: fsOpen, readdir: fsReaddir, platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : null });

/** Đọc có giới hạn một file thường (không symlink, không bị tráo giữa lstat và open). File bí mật còn phải: của đúng user đang
 * chạy, không mở cho nhóm/người khác (bỏ kiểm quyền/uid trên Windows — chỉ để chạy test). */
async function readChecked(file, maxBytes, io, secret) {
  const invalid = secret ? 'secret_file_invalid' : 'outbox_file_invalid';
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail(secret ? 'secret_path_invalid' : 'outbox_path_invalid');
  const before = await io.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) fail(invalid);
  if (secret && io.platform !== 'win32' && ((before.mode & 0o077) !== 0 || (io.uid !== null && before.uid !== io.uid))) fail('secret_file_too_open');
  const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    if (held.ino !== before.ino || held.dev !== before.dev || held.size > maxBytes) fail(invalid);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail(invalid);
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export const readPrivateFile = (file, maxBytes, io = defaultIo()) => readChecked(file, maxBytes, io, true);

/** Cấu hình job (`/etc/ihome-hermes/learning-audit.json`, 0600): thư mục outbox, ánh xạ hồ sơ Hermes → (công ty, người dùng),
 * và login RIÊNG của job nạp (`store`). Không dùng lại login kho bền của connector. */
export function parseJobConfig(input) {
  if (!exact(input, ['version', 'outboxDir', 'store', 'profiles'], ['staleAfterHours', 'replayDays']) || input.version !== 1) fail('config_invalid');
  if (typeof input.outboxDir !== 'string' || !path.isAbsolute(input.outboxDir)) fail('config_invalid');
  if (input.staleAfterHours !== undefined && (!Number.isSafeInteger(input.staleAfterHours) || input.staleAfterHours < 1 || input.staleAfterHours > 720)) fail('config_invalid');
  if (input.replayDays !== undefined && (!Number.isSafeInteger(input.replayDays) || input.replayDays < 0 || input.replayDays > 30)) fail('config_invalid');
  if (!record(input.profiles) || Object.keys(input.profiles).length < 1 || Object.keys(input.profiles).length > 32) fail('config_invalid');
  const profiles = Object.create(null);
  for (const [name, target] of Object.entries(input.profiles)) {
    if (!PROFILE.test(name) || !exact(target, ['organizationId', 'userId']) || !UUID.test(target.organizationId) || !UUID.test(target.userId)) fail('config_profile_invalid');
    profiles[name] = Object.freeze({ organizationId: target.organizationId.toLowerCase(), userId: target.userId.toLowerCase() });
  }
  return Object.freeze({ outboxDir: input.outboxDir, replayDays: input.replayDays ?? 7, store: validateStoreRef(input.store),
    staleAfterHours: input.staleAfterHours ?? 36, profiles: Object.freeze(profiles) });
}

export function validateStoreRef(store) {
  if (!exact(store, ['projectRef', 'host', 'role', 'passwordFile'], ['caFile'])) fail('store_config_invalid');
  const { projectRef, host, role, passwordFile, caFile } = store;
  if (typeof projectRef !== 'string' || !/^[a-z0-9]{20}$/.test(projectRef)
    || (host !== `db.${projectRef}.supabase.co` && (typeof host !== 'string' || !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)))
    || typeof role !== 'string' || !/^hermes_store_[a-z0-9_]{1,40}$/.test(role) || role === 'hermes_store_executor'
    || typeof passwordFile !== 'string' || !path.isAbsolute(passwordFile)
    || (caFile !== undefined && (typeof caFile !== 'string' || !path.isAbsolute(caFile)))) fail('store_config_invalid');
  return Object.freeze({ projectRef, host, role, passwordFile, ...(caFile === undefined ? {} : { caFile }) });
}

export async function loadStoreCredentials(ref, io) {
  const passwordBytes = await readPrivateFile(ref.passwordFile, 4096, io);
  let password, ca;
  try { password = new TextDecoder('utf-8', { fatal: true }).decode(passwordBytes); } catch { fail('store_secret_invalid'); }
  finally { passwordBytes.fill(0); }
  if (password.length < 16 || password.length > 4096 || /[\r\n\0]/.test(password)) fail('store_secret_invalid');
  if (ref.caFile !== undefined) {
    const caBytes = await readPrivateFile(ref.caFile, 65536, io);
    try { ca = new TextDecoder('utf-8', { fatal: true }).decode(caBytes); } catch { fail('store_ca_invalid'); }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) fail('store_ca_invalid');
  }
  return Object.freeze({ projectRef: ref.projectRef, host: ref.host, role: ref.role, password, ...(ca === undefined ? {} : { ca }) });
}

// ---------------------------------------------------------------- khuôn đề xuất (đúng như SQL)

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = text => (typeof text.isWellFormed === 'function' ? text.isWellFormed() : !LONE_SURROGATE.test(text));
// PostgreSQL: text không chứa NUL (jsonb từ chối \u0000 ⇒ 22P05 cho CẢ lời gọi), UTF-8 không có surrogate lẻ.
const pgText = text => typeof text === 'string' && wellFormed(text) && !text.includes('\u0000');
const codePoints = text => [...text].length;  // char_length của PostgreSQL đếm theo ký tự, không theo UTF-16

/** Dạng chữ jsonb của PostgreSQL (", " và ": " giữa phần tử) — đo đúng CHECK octet_length(source::text) <= 4096. Số chỉ nhận
 * số nguyên an toàn (dạng chữ trùng nhau ở JS và PostgreSQL). */
export function pgJsonText(value, depth = 0) {
  if (depth > 16) fail('source_invalid');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('source_invalid'); return String(value); }
  if (typeof value === 'string') { if (!pgText(value)) fail('source_invalid'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => pgJsonText(item, depth + 1)).join(', ')}]`;
  if (record(value)) return `{${Object.entries(value).map(([k, v]) => `${pgJsonText(k, depth + 1)}: ${pgJsonText(v, depth + 1)}`).join(', ')}}`;
  return fail('source_invalid');
}

/** Lý do đề xuất bị SQL từ chối (null = hợp lệ): khoá, loại, tiêu đề/nội dung (độ dài theo ký tự, có chữ, không ký tự điều
 * khiển, không NUL/surrogate lẻ), nguồn ≤ 4096 B dạng chữ jsonb, detectedAt trong [−400 ngày, +1 ngày] (chừa 1 giờ lệch đồng hồ). */
export function proposalProblem(item, now) {
  if (!exact(item, ['dedupeKey', 'kind', 'title', 'content', 'source', 'detectedAt'])) return 'shape';
  if (typeof item.dedupeKey !== 'string' || !/^[0-9a-f]{64}$/.test(item.dedupeKey)) return 'dedupeKey';
  if (!KINDS.has(item.kind)) return 'kind';
  const { title, content } = item;
  if (!pgText(title) || /[\u0001-\u001f\u007f]/.test(title) || !/\S/u.test(title) || codePoints(title) > 200) return 'title';
  if (!pgText(content) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content) || !/\S/u.test(content)
    || codePoints(content) > 4000) return 'content';
  let source;
  try { source = record(item.source) ? pgJsonText(item.source) : null; } catch { source = null; }
  if (source === null || Buffer.byteLength(source) > 4096) return 'source';
  const at = typeof item.detectedAt === 'string' && ISO.test(item.detectedAt) ? Date.parse(item.detectedAt) : NaN;
  if (!Number.isFinite(at) || at < now - 400 * DAY + HOUR || at > now + DAY - HOUR) return 'detectedAt';
  return null;
}

function validOutbox(box) {
  return record(box) && box.schemaVersion === OUTBOX_SCHEMA_VERSION && box.kind === 'hermes-learning-outbox'
    && typeof box.generatedAt === 'string' && ISO.test(box.generatedAt) && Number.isFinite(Date.parse(box.generatedAt))
    && Array.isArray(box.profiles) && box.profiles.every(profile => record(profile) && typeof profile.profile === 'string'
      && Array.isArray(profile.proposals));
}

/** Outbox (mới nhất trước) + ánh xạ ⇒ các lô gửi đi. Mỗi hồ sơ có ánh xạ ≥ 1 lô (nhịp kiểm, kể cả rỗng); lô ≤ 25 đề xuất và
 * ≤ 96 KiB; đề xuất trùng khoá giữa các outbox chỉ gửi một lần (outbox cũ trước: số thứ tự theo trình tự phát hiện).
 * Hồ sơ có ánh xạ mà không outbox nào trong cửa sổ có ⇒ `missingProfiles` (job kiểm không kiểm được hồ sơ đó). */
export function planBatches(outboxes, config, now = Date.now()) {
  const list = Array.isArray(outboxes) ? outboxes : [outboxes];
  const valid = list.filter(validOutbox);
  const newest = valid[0];
  const generatedAt = newest ? Date.parse(newest.generatedAt) : NaN;
  const perProfile = new Map(), skipped = new Map(), dropped = [], seen = new Set();
  const skip = (profile, reason, count) => {
    const key = `${profile}|${reason}`;
    skipped.set(key, { profile, reason, proposals: (skipped.get(key)?.proposals ?? 0) + count });
  };
  for (const box of [...valid].reverse()) {
    const boxAt = Date.parse(box.generatedAt);
    if (box !== newest && boxAt < now - config.replayDays * DAY) continue;
    for (const profile of box.profiles) {
      if (!Object.hasOwn(config.profiles, profile.profile)) { if (box === newest) skip(profile.profile, 'no_mapping', profile.proposals.length); continue; }
      const slot = perProfile.get(profile.profile) ?? { items: [], auditAt: boxAt };
      slot.auditAt = Math.max(slot.auditAt, boxAt);
      perProfile.set(profile.profile, slot);
      for (const item of profile.proposals) {
        const problem = proposalProblem(item, now);
        const key = record(item) && typeof item.dedupeKey === 'string' && /^[0-9a-f]{64}$/.test(item.dedupeKey) ? item.dedupeKey : null;
        if (problem) { dropped.push({ profile: profile.profile, dedupeKey: key, problem }); continue; }
        if (seen.has(`${profile.profile}|${key}`)) continue;
        seen.add(`${profile.profile}|${key}`);
        slot.items.push({ dedupeKey: item.dedupeKey, kind: item.kind, title: item.title, content: item.content,
          source: item.source, detectedAt: item.detectedAt });
      }
    }
  }
  const batches = [];
  for (const [profile, { items, auditAt }] of perProfile) {
    const target = config.profiles[profile];
    // Đồng hồ host chạy trước: mốc kiểm không được ở tương lai (SQL nhận tới +1 ngày, nhưng "lần kiểm cuối" phải là thật).
    const header = { organizationId: target.organizationId, userId: target.userId, profile,
      auditGeneratedAt: new Date(Math.min(auditAt, now)).toISOString() };
    let current = [];
    for (const item of items) {
      const next = [...current, item];
      if (current.length && (next.length > MAX_BATCH || Buffer.byteLength(JSON.stringify({ ...header, proposals: next })) > MAX_BATCH_BYTES)) {
        batches.push({ ...header, proposals: current });
        current = [];
      }
      current.push(item);
    }
    if (current.length || items.length === 0) batches.push({ ...header, proposals: current });
  }
  const ageHours = newest ? Math.round(((now - generatedAt) / HOUR) * 10) / 10 : null;
  // Hồ sơ có ánh xạ mà lần kiểm MỚI NHẤT không có (job kiểm không kiểm được hồ sơ đó): báo; đề xuất cũ của nó vẫn được gửi bù
  // với mốc kiểm cũ của chính nó (SQL giữ mốc lớn nhất ⇒ trang CRM vẫn thấy hồ sơ này đã lâu không được kiểm).
  const inNewest = new Set(newest ? newest.profiles.map(profile => profile.profile) : []);
  return { batches, skipped: [...skipped.values()], dropped, invalidFiles: list.length - valid.length,
    missingProfiles: Object.keys(config.profiles).filter(name => !inNewest.has(name)).sort(),
    generatedAt: newest?.generatedAt ?? null, ageHours, stale: ageHours === null || ageHours > config.staleAfterHours };
}

function validResult(result, batch) {
  const keys = new Set(batch.proposals.map(item => item.dedupeKey));
  return exact(result, ['organizationId', 'inserted', 'duplicates', 'rejectedDuplicates']) && result.organizationId === batch.organizationId
    && Array.isArray(result.inserted) && Number.isSafeInteger(result.duplicates) && result.duplicates >= 0
    && result.inserted.length + result.duplicates === batch.proposals.length
    && result.inserted.every(item => exact(item, ['id', 'seq']) && UUID.test(item.id) && Number.isSafeInteger(item.seq) && item.seq > 0)
    && Array.isArray(result.rejectedDuplicates) && result.rejectedDuplicates.length <= result.duplicates
    && result.rejectedDuplicates.every(key => typeof key === 'string' && keys.has(key));
}

/** Gửi từng lô. Lỗi tạm/chưa rõ kết cục: thử lại MỘT lần (an toàn — nạp trùng bị bỏ qua). Lô bị SQL từ chối (store_rejected):
 * gửi nhịp riêng (kiểm phần đầu lô), rồi gửi lại từng đề xuất — chỉ đề xuất bị từ chối riêng mới bị bỏ (`rejected`). */
export async function sendBatches(transport, batches, { timeoutMs = 20_000, retryDelayMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const outcome = { batches: batches.length, calls: 0, sent: 0, inserted: 0, duplicates: 0, seqs: [], rejectedDuplicates: [],
    rejected: [], failures: [] };
  const send = async batch => {
    for (let attempt = 1; ; attempt++) {
      outcome.calls++;
      try {
        const result = await transport.call('ingestLearningProposals', batch, { signal: AbortSignal.timeout(timeoutMs) });
        if (!validResult(result, batch)) fail('ingest_response_invalid');
        return { ok: true, result };
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[a-z_]{3,40}$/.test(error.code) ? error.code : 'ingest_failed';
        if (attempt === 1 && RETRYABLE.has(code)) { await sleep(retryDelayMs); continue; }
        return { ok: false, code };
      }
    }
  };
  const tally = (batch, result) => {
    outcome.sent += batch.proposals.length; outcome.inserted += result.inserted.length; outcome.duplicates += result.duplicates;
    outcome.seqs.push(...result.inserted.map(item => item.seq));
    outcome.rejectedDuplicates.push(...result.rejectedDuplicates);
  };
  for (const batch of batches) {
    const first = await send(batch);
    if (first.ok) { tally(batch, first.result); continue; }
    if (first.code !== 'store_rejected' || batch.proposals.length === 0) {
      outcome.failures.push({ profile: batch.profile, proposals: batch.proposals.length, code: first.code });
      continue;
    }
    // SQL từ chối cả lô (vd. một mục lệch khuôn lọt kiểm): tách để một mục hỏng không chặn cả lô và nhịp kiểm.
    const heartbeat = await send({ ...batch, proposals: [] });
    if (!heartbeat.ok) {
      outcome.failures.push({ profile: batch.profile, proposals: batch.proposals.length,
        code: heartbeat.code === 'store_rejected' ? 'batch_header_rejected' : heartbeat.code });
      continue;
    }
    tally({ ...batch, proposals: [] }, heartbeat.result);
    for (const item of batch.proposals) {
      const single = { ...batch, proposals: [item] };
      const sent = await send(single);
      if (sent.ok) tally(single, sent.result);
      else if (sent.code === 'store_rejected') outcome.rejected.push({ profile: batch.profile, dedupeKey: item.dedupeKey });
      else outcome.failures.push({ profile: batch.profile, proposals: 1, code: sent.code });
    }
  }
  return outcome;
}

/** Outbox mới nhất (luôn đọc — để kiểm "quá cũ") + các outbox trong `replayDays` ngày (theo mốc trong tên file), mới trước cũ.
 * File hỏng/không đọc an toàn được ⇒ null (được đếm là file lệch, không làm dừng job). */
async function loadOutboxes(config, io, now) {
  let names = [];
  try { names = await io.readdir(config.outboxDir); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const files = names.map(name => OUTBOX_FILE.exec(name)).filter(Boolean)
    .map(match => ({ name: match[0], at: Date.parse(match[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) }))
    .filter(item => Number.isFinite(item.at)).sort((a, b) => b.at - a.at);
  const chosen = files.filter((item, index) => index === 0 || item.at >= now - config.replayDays * DAY).slice(0, MAX_OUTBOX_FILES);
  const out = [];
  for (const item of chosen) {
    try {
      out.push(JSON.parse(Buffer.from(await readChecked(path.join(config.outboxDir, item.name), MAX_OUTBOX_BYTES, io, false)).toString('utf8')));
    } catch (error) {
      if (!(error instanceof IngestError || error instanceof SyntaxError || error?.code === 'ENOENT')) throw error;
      out.push(null);
    }
  }
  return out;
}

const firstKeys = items => items.map(item => item.dedupeKey ?? item).filter(Boolean).slice(0, MAX_LOGGED_KEYS);

export async function runIngest({ configPath, io = defaultIo(), now = Date.now(), createTransport, log = line => process.stdout.write(`${line}\n`) }) {
  let input;
  try { input = JSON.parse(Buffer.from(await readPrivateFile(configPath, 65536, io)).toString('utf8')); } catch (error) {
    if (error instanceof IngestError) throw error;
    fail('config_invalid');
  }
  const config = parseJobConfig(input);
  const outboxes = await loadOutboxes(config, io, now);
  const plan = planBatches(outboxes, config, now);
  let outcome = { batches: 0, calls: 0, sent: 0, inserted: 0, duplicates: 0, seqs: [], rejectedDuplicates: [], rejected: [], failures: [] };
  if (plan.batches.length) {
    const credentials = await loadStoreCredentials(config.store, io);
    const { transport, close } = await createTransport(credentials);
    try { outcome = await sendBatches(transport, plan.batches); } finally { await close(); }
  }
  log(JSON.stringify({ event: 'learning_ingest', generatedAt: plan.generatedAt, ageHours: plan.ageHours, stale: plan.stale,
    outboxFiles: outboxes.length, invalidFiles: plan.invalidFiles, missingProfiles: plan.missingProfiles, skipped: plan.skipped,
    batches: outcome.batches, calls: outcome.calls, sent: outcome.sent, inserted: outcome.inserted, duplicates: outcome.duplicates,
    seqs: outcome.seqs,
    // Trùng với đề xuất ĐÃ BỎ: trợ lý học lại đúng bài học chủ đã bỏ — báo riêng để gỡ tay (SQL không đưa lại vào hàng chờ).
    rejectedDuplicates: outcome.rejectedDuplicates.length, rejectedDuplicateKeys: firstKeys(outcome.rejectedDuplicates),
    droppedInvalid: plan.dropped.length, droppedInvalidKeys: firstKeys(plan.dropped),
    droppedRejected: outcome.rejected.length, droppedRejectedKeys: firstKeys(outcome.rejected), failures: outcome.failures }));
  // Mục bị bỏ, lô lỗi, outbox hỏng hay hồ sơ thiếu là lỗi phải thấy (mã ≠ 0 ⇒ OnFailure), không âm thầm; outbox quá cũ ⇒ 3.
  const problems = outcome.failures.length || outcome.rejected.length || plan.dropped.length || plan.invalidFiles || plan.missingProfiles.length;
  return problems ? 1 : plan.stale ? 3 : 0;
}

async function defaultTransport(credentials) {
  // Dùng đúng pool/transport của connector cùng bản phát hành, phạm vi 'learning': kiểm login thuộc hermes_learning_ingest và
  // không thuộc hermes_store_executor trước lệnh đầu, chỉ gọi được hàm nạp; TLS xác minh, không thử lại ngầm.
  const { createStorePool } = await import('../hermes-broker/store-pool.mjs');
  const { createStoreTransport } = await import('../hermes-broker/store-transport.mjs');
  const pool = createStorePool(credentials);
  const transport = createStoreTransport({ pool, expectedRole: credentials.role, scope: 'learning' });
  return { transport, close: () => pool.end() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const configPath = args[0] === '--config' && args[1] ? args[1] : '/etc/ihome-hermes/learning-audit.json';
  runIngest({ configPath, createTransport: defaultTransport })
    .then(code => { process.exitCode = code; })
    .catch(error => {
      const code = error instanceof IngestError ? error.code : error?.code === 'ENOENT' ? 'file_missing' : 'ingest_failed';
      process.stderr.write(`${JSON.stringify({ event: 'learning_ingest_failed', code })}\n`);
      process.exitCode = 2;
    });
}
