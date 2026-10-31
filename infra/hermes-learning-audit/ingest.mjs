#!/usr/bin/env node
// Nạp đề xuất bài học (báo cáo của learning_audit.py) vào CRM qua cổng kho bền của connector:
// app_private.hermes_store_learning_ingest_v1, chỉ vai hermes_store_executor (login kho bền, TLS xác minh) — cùng đường với mọi
// writer server-side của Hermes, không service_role, không JWT người dùng. Chạy bằng user ihome-hermes (đọc được file bí mật
// của connector), KHÔNG đọc hồ sơ Hermes. Nạp lặp lại an toàn: SQL bỏ qua đề xuất trùng (công ty, dedupeKey) ⇒ mỗi lần chạy
// gửi lại mọi đề xuất của các báo cáo trong `replayDays` ngày gần nhất, nên một lần nạp hỏng không làm mất đề xuất.
// Không in mật khẩu, chuỗi kết nối hay nội dung đề xuất ra log.
import { constants } from 'node:fs';
import { lstat as fsLstat, open as fsOpen, readdir as fsReaddir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

// Job chỉ chạy trên Linux: đường dẫn cấu hình là POSIX tuyệt đối (giữ nguyên khi chạy test trên Windows).
const path = nodePath.posix;
export const REPORT_SCHEMA_VERSION = 1;
const MAX_BATCH = 25;
// Trần payload của store-transport / hermes_request_v1 là 131 072 B; chừa chỗ cho khoá ngoài + mã hoá JSON.
const MAX_BATCH_BYTES = 96 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/;
const REPORT_FILE = /^learning-audit-(\d{8}T\d{6}Z)\.json$/;
const KINDS = new Set(['skill_crm_write', 'memory_crm_write']);
const RETRYABLE = new Set(['store_outcome_unknown', 'store_unavailable', 'store_conflict', 'store_timeout', 'store_cancelled']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class IngestError extends Error {
  constructor(code) { super(code); this.name = 'IngestError'; this.code = code; }
}
const fail = code => { throw new IngestError(code); };
const exact = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

const defaultIo = () => ({ lstat: fsLstat, open: fsOpen, readdir: fsReaddir, read: readFile, platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : null });

/** Đọc file bí mật như connector: đường tuyệt đối, file thường (không symlink), của đúng user đang chạy, không mở cho
 * nhóm/người khác (bỏ kiểm quyền/uid trên Windows — chỉ để chạy test), đọc có giới hạn và kiểm file không bị tráo. */
export async function readPrivateFile(file, maxBytes, io = defaultIo()) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('secret_path_invalid');
  const before = await io.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) fail('secret_file_invalid');
  if (io.platform !== 'win32' && ((before.mode & 0o077) !== 0 || (io.uid !== null && before.uid !== io.uid))) fail('secret_file_too_open');
  const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    if (held.ino !== before.ino || held.dev !== before.dev || held.size > maxBytes) fail('secret_file_invalid');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail('secret_file_invalid');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Cấu hình job (`/etc/ihome-hermes/learning-audit.json`): ánh xạ hồ sơ Hermes → (công ty, người dùng). Store mặc định lấy từ
 * khối `store` của connector.json; có thể khai `store` riêng (login hermes_store_<tên> riêng, cùng vai hermes_store_executor). */
export function parseJobConfig(input) {
  if (!exact(input, ['version', 'report', 'profiles'], ['connectorConfig', 'store', 'staleAfterHours', 'reportsDir', 'replayDays'])
    || input.version !== 1) fail('config_invalid');
  if (typeof input.report !== 'string' || !path.isAbsolute(input.report)) fail('config_invalid');
  if (input.reportsDir !== undefined && (typeof input.reportsDir !== 'string' || !path.isAbsolute(input.reportsDir))) fail('config_invalid');
  if (input.connectorConfig !== undefined && (typeof input.connectorConfig !== 'string' || !path.isAbsolute(input.connectorConfig))) fail('config_invalid');
  if ((input.connectorConfig === undefined) === (input.store === undefined)) fail('config_store_source_ambiguous');
  if (input.staleAfterHours !== undefined && (!Number.isSafeInteger(input.staleAfterHours) || input.staleAfterHours < 1 || input.staleAfterHours > 720)) fail('config_invalid');
  if (input.replayDays !== undefined && (!Number.isSafeInteger(input.replayDays) || input.replayDays < 0 || input.replayDays > 30)) fail('config_invalid');
  if (!record(input.profiles) || Object.keys(input.profiles).length < 1 || Object.keys(input.profiles).length > 32) fail('config_invalid');
  const profiles = Object.create(null);
  for (const [name, target] of Object.entries(input.profiles)) {
    if (!PROFILE.test(name) || !exact(target, ['organizationId', 'userId']) || !UUID.test(target.organizationId) || !UUID.test(target.userId)) fail('config_profile_invalid');
    profiles[name] = Object.freeze({ organizationId: target.organizationId.toLowerCase(), userId: target.userId.toLowerCase() });
  }
  return Object.freeze({ report: input.report, reportsDir: input.reportsDir ?? path.join(path.dirname(input.report), 'reports'),
    replayDays: input.replayDays ?? 7, connectorConfig: input.connectorConfig,
    store: input.store === undefined ? undefined : validateStoreRef(input.store),
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

/** Lấy khối store (chỉ khối này) từ connector.json; không đọc khoá mã hoá hay khoá Supabase của connector. */
export async function storeRefFromConnector(connectorConfig, io) {
  const bytes = await readPrivateFile(connectorConfig, 32768, io);
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('connector_config_invalid'); } finally { bytes.fill(0); }
  if (!record(parsed) || parsed.version !== 2 || parsed.mode !== 'connector') fail('connector_config_invalid');
  return validateStoreRef(parsed.store);
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

function validProposal(item) {
  return exact(item, ['dedupeKey', 'kind', 'title', 'content', 'source', 'detectedAt'])
    && typeof item.dedupeKey === 'string' && /^[0-9a-f]{64}$/.test(item.dedupeKey) && KINDS.has(item.kind)
    && typeof item.title === 'string' && /\S/.test(item.title) && [...item.title].length <= 200 && !/[\u0001-\u001f\u007f]/.test(item.title)
    && typeof item.content === 'string' && /\S/.test(item.content) && [...item.content].length <= 4000
    && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.content)
    && record(item.source) && Buffer.byteLength(JSON.stringify(item.source)) <= 4096
    && typeof item.detectedAt === 'string' && ISO.test(item.detectedAt);
}

function validReport(report) {
  return record(report) && report.schemaVersion === REPORT_SCHEMA_VERSION && Array.isArray(report.profiles)
    && typeof report.generatedAt === 'string' && ISO.test(report.generatedAt)
    && report.profiles.every(profile => record(profile) && typeof profile.profile === 'string' && Array.isArray(profile.proposals));
}

/** Từ các báo cáo (báo cáo mới nhất trước) + ánh xạ ⇒ các lô gửi đi: mỗi lô một hồ sơ, ≤ 25 đề xuất và ≤ 96 KiB. Đề xuất
 * trùng khoá giữa các báo cáo chỉ gửi một lần; hồ sơ không có ánh xạ (vd. hồ sơ nghiệm thu) thì bỏ, có đếm. */
export function planBatches(reports, config, now = Date.now()) {
  const list = Array.isArray(reports) ? reports : [reports];
  if (list.length === 0 || !validReport(list[0])) fail('report_invalid');
  const ageHours = (now - Date.parse(list[0].generatedAt)) / 3_600_000;
  const perProfile = new Map(), skipped = new Map(), seen = new Set();
  const skip = (profile, reason, count) => {
    const key = `${profile}|${reason}`;
    skipped.set(key, { profile, reason, proposals: (skipped.get(key)?.proposals ?? 0) + count });
  };
  let invalidReports = 0;
  for (const report of list) {
    if (!validReport(report)) { invalidReports++; continue; }
    for (const profile of report.profiles) {
      if (!Object.hasOwn(config.profiles, profile.profile)) { if (report === list[0]) skip(profile.profile, 'no_mapping', profile.proposals.length); continue; }
      for (const item of profile.proposals) {
        if (!validProposal(item)) { skip(profile.profile, 'invalid_proposal', 1); continue; }
        if (seen.has(`${profile.profile}|${item.dedupeKey}`)) continue;
        seen.add(`${profile.profile}|${item.dedupeKey}`);
        if (!perProfile.has(profile.profile)) perProfile.set(profile.profile, []);
        perProfile.get(profile.profile).push({ dedupeKey: item.dedupeKey, kind: item.kind, title: item.title, content: item.content,
          source: item.source, detectedAt: item.detectedAt });
      }
    }
  }
  const batches = [];
  for (const [profile, items] of perProfile) {
    const target = config.profiles[profile];
    let current = [];
    const flush = () => { if (current.length) batches.push({ organizationId: target.organizationId, userId: target.userId, profile, proposals: current }); current = []; };
    for (const item of items) {
      const next = [...current, item];
      const bytes = Buffer.byteLength(JSON.stringify({ organizationId: target.organizationId, userId: target.userId, profile, proposals: next }));
      if (current.length && (next.length > MAX_BATCH || bytes > MAX_BATCH_BYTES)) flush();
      current.push(item);
    }
    flush();
  }
  return { batches, skipped: [...skipped.values()], invalidReports, stale: ageHours > config.staleAfterHours, ageHours: Math.round(ageHours * 10) / 10 };
}

function validResult(result, batch) {
  return exact(result, ['organizationId', 'inserted', 'duplicates']) && result.organizationId === batch.organizationId
    && Array.isArray(result.inserted) && Number.isSafeInteger(result.duplicates)
    && result.inserted.length + result.duplicates === batch.proposals.length
    && result.inserted.every(item => exact(item, ['id', 'seq']) && UUID.test(item.id) && Number.isSafeInteger(item.seq) && item.seq > 0);
}

/** Gửi từng lô; lỗi tạm/không rõ kết cục thử lại MỘT lần (an toàn vì nạp trùng bị bỏ qua). */
export async function sendBatches(transport, batches, { timeoutMs = 20_000, retryDelayMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const outcome = { batches: batches.length, sent: 0, inserted: 0, duplicates: 0, seqs: [], failures: [] };
  for (const batch of batches) {
    let attempt = 0, done = false;
    while (!done) {
      attempt++;
      try {
        const result = await transport.call('ingestLearningProposals', batch, { signal: AbortSignal.timeout(timeoutMs) });
        if (!validResult(result, batch)) fail('ingest_response_invalid');
        outcome.sent += batch.proposals.length; outcome.inserted += result.inserted.length; outcome.duplicates += result.duplicates;
        outcome.seqs.push(...result.inserted.map(item => item.seq));
        done = true;
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[a-z_]{3,40}$/.test(error.code) ? error.code : 'ingest_failed';
        if (attempt === 1 && RETRYABLE.has(code)) { await sleep(retryDelayMs); continue; }
        outcome.failures.push({ profile: batch.profile, proposals: batch.proposals.length, code });
        done = true;
      }
    }
  }
  return outcome;
}

/** Báo cáo mới nhất + các báo cáo trong `replayDays` ngày (theo mốc trong tên file), mới trước cũ. */
async function loadReports(config, io, now) {
  const parse = bytes => { try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; } };
  const latest = parse(await io.read(config.report));
  const reports = [latest];
  if (config.replayDays > 0) {
    let names = [];
    try { names = await io.readdir(config.reportsDir); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const floor = now - config.replayDays * 86_400_000;
    const recent = names.map(name => REPORT_FILE.exec(name)).filter(Boolean)
      .map(match => ({ name: match[0], at: Date.parse(match[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) }))
      .filter(item => Number.isFinite(item.at) && item.at >= floor).sort((a, b) => b.at - a.at).slice(0, 64);
    for (const item of recent) {
      const report = parse(await io.read(path.join(config.reportsDir, item.name)));
      if (report?.generatedAt !== latest?.generatedAt) reports.push(report);
    }
  }
  return reports;
}

export async function runIngest({ configPath, io = defaultIo(), now = Date.now(), createTransport, log = line => process.stdout.write(`${line}\n`) }) {
  const config = parseJobConfig(JSON.parse(Buffer.from(await readPrivateFile(configPath, 65536, io)).toString('utf8')));
  const reports = await loadReports(config, io, now);
  const plan = planBatches(reports, config, now);
  const summary = { generatedAt: reports[0].generatedAt, ageHours: plan.ageHours, stale: plan.stale, reports: reports.length,
    invalidReports: plan.invalidReports, skipped: plan.skipped };
  // Đề xuất lệch khuôn bị bỏ là lỗi phải thấy (thoát mã ≠ 0), không âm thầm.
  const invalid = plan.skipped.some(item => item.reason === 'invalid_proposal') || plan.invalidReports > 0;
  if (plan.batches.length === 0) {
    log(JSON.stringify({ event: 'learning_ingest', ...summary, batches: 0, sent: 0, inserted: 0, duplicates: 0, failures: [] }));
    return invalid ? 1 : plan.stale ? 3 : 0;
  }
  const ref = config.store ?? await storeRefFromConnector(config.connectorConfig, io);
  const credentials = await loadStoreCredentials(ref, io);
  const { transport, close } = await createTransport(credentials);
  try {
    const outcome = await sendBatches(transport, plan.batches);
    log(JSON.stringify({ event: 'learning_ingest', ...summary, ...outcome }));
    return outcome.failures.length || invalid ? 1 : plan.stale ? 3 : 0;
  } finally { await close(); }
}

async function defaultTransport(credentials) {
  // Dùng đúng pool/transport của connector cùng bản phát hành: TLS xác minh, kiểm vai đăng nhập, không thử lại ngầm.
  const { createStorePool } = await import('../hermes-broker/store-pool.mjs');
  const { createStoreTransport } = await import('../hermes-broker/store-transport.mjs');
  const pool = createStorePool(credentials);
  const transport = createStoreTransport({ pool, expectedRole: credentials.role });
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
