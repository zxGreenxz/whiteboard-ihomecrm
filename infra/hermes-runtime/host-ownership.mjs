import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const LOCK = '.hermes-host.lock';
const AUDIT = 'broker-audit.jsonl';
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['authenticate', 'tools/list', 'tools/call', 'private/group-room-preview', 'private/group-directory', 'private/group-room-send', 'private/group-send-status']);
const CODES = new Set(['unauthorized', 'forbidden', 'context_changed', 'invalid_request', 'group_recipient_limit', 'group_room_limit',
  'tool_not_available', 'rate_limited', 'busy', 'timeout', 'backend_unavailable', 'response_too_large', 'send_outcome_unknown',
  // Báo cáo vượt trần trang của PostgREST (PT413, bound-user-rpc.mjs): mô hình cần thu hẹp bộ lọc, không phải thử lại.
  'result_too_large',
  // B5d (infra/hermes-broker/read-name-resolution.mjs): tên toà/phòng không giải được — mô hình phải hỏi lại. Audit
  // không nhận mã này ⇒ audit đỏ ⇒ đóng an toàn thành backend_unavailable cho MỌI tên sai (sự cố 21/10 03:30).
  'read_name_unresolved',
  // Rào chữ công khai (infra/hermes-broker/public-text-guard.mjs): token xác nhận sai/hết hạn/đã dùng.
  'confirmation_invalid',
  // Mã bất định của ghi (broker MUTATION_UNKNOWN): broker vẫn ghi sổ outcome=denied với đúng mã rồi ném cho mô hình đối
  // chiếu bằng *_status; broker nuốt lỗi audit cho riêng các mã này nên thiếu ở đây không đóng broker, nhưng sổ audit sẽ
  // không có dòng cho lượt ghi bất định. Mọi mã ERROR_STATUS của broker phải có mặt (audit-codes.test.mjs).
  'memory_outcome_unknown', 'schedule_outcome_unknown', 'room_pass_outcome_unknown', 'task_outcome_unknown',
  'customer_outcome_unknown', 'expense_outcome_unknown', 'sale_outcome_unknown', 'zalo_broadcast_outcome_unknown',
  // Đợt 1 nền chung thao tác ghi (crm_action_*): lỗi thật mang reason (dưới) và mã bất định của ghi.
  'action_rejected', 'action_outcome_unknown']);
/** Bản sao chỉ đọc của giao thức mã lỗi sổ audit chấp nhận; audit-codes.test.mjs khoá nó bằng ERROR_STATUS của broker. */
export const AUDIT_CODES = Object.freeze([...CODES]);
// Lý do của action_rejected (dạng rejected của danh sách đóng infra/hermes-broker/action-reasons.mjs, D9). Sự kiện
// audit chỉ nhận trường reason khi code = action_rejected và reason thuộc tập này; audit-codes.test.mjs khoá tập bằng
// ACTION_REJECT_REASONS cả hai chiều (thiếu mã ⇒ audit đỏ ⇒ broker đóng an toàn thành backend_unavailable — đúng lớp
// sự cố 21/10). Lý do dạng needs_input là kết quả thường, không bao giờ tới sổ audit như lỗi.
const REASONS = new Set(['action_disabled', 'forbidden', 'not_allowed', 'private_chat_only', 'state_changed', 'request_conflict', 'period_locked',
  'cashbook_not_held', 'not_pending', 'quota_exceeded', 'strict_mode', 'web_only', 'duplicate_request', 'crm_refused',
  // Thu chi (Đợt 2).
  'system_voucher', 'evidence_required',
  // Trang Hợp đồng (Đợt 2).
  'already_returned', 'renew_price_change_web_only', 'no_notice', 'room_not_lockable', 'room_already_locked', 'no_open_lock',
  'cannot_remove_representative', 'room_has_new_contract',
  // Trang Công việc (Đợt 2b).
  'task_quota_user', 'task_quota_pair', 'cancel_blocked', 'task_not_open', 'recurrence_quota',
  // Hoá đơn (Đợt 3 Mốc 3, thu tiền).
  'cash_collection_web_only', 'invoice_not_collectible', 'credit_requires_contract', 'receiving_book_missing', 'receiving_book_not_held', 'reconciliation_required',
  'period_closed',
  // Hoá đơn (Mốc 4, ghi chỉ số).
  'meter_used_by_invoice', 'meter_has_later_reading',
  // Hoá đơn (Mốc 5, điều chỉnh / xác nhận kiểm tra / huỷ / khôi phục).
  'adjust_meter_line_web_only', 'adjust_has_rounding_or_credit', 'adjust_debt_carried', 'adjust_below_collected', 'adjustment_self_check_web_only',
  'cancel_has_payment', 'cancel_overdue_web_only', 'restore_conflict', 'invoice_already_cancelled', 'invoice_not_cancelled',
  // Trang Sale (crm_sale_action: cọc, giữ / bỏ giữ phòng đã rời cầu Sale, 05/11).
  'sale_deposit_web_only', 'sale_lock_via_contract']);
export const AUDIT_REASONS = Object.freeze([...REASONS]);
const AUDIT_OWNERS = new Map();
export class HostOwnershipError extends Error {
  constructor(code) { super(code); this.name = 'HostOwnershipError'; this.code = code; }
}
const fail = code => { throw new HostOwnershipError(code); };
function data(raw, required, optional = []) {
  try {
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('host_invalid_data');
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !keys.includes(key))) fail('host_invalid_data');
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('host_invalid_data');
      result[key] = descriptor.value;
    }
    return result;
  } catch { fail('host_invalid_data'); }
}
function rootOption(options, key) {
  const raw = data(options, [key])[key];
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw !== path.resolve(raw) || /[\0\r\n]/.test(raw)) fail('host_invalid_config');
  return raw;
}
function privateInfo(info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.nlink !== 1n) || (process.platform !== 'win32' &&
      (info.uid !== BigInt(process.getuid()) || info.gid !== BigInt(process.getgid()) ||
        (info.mode & 0o777n) !== (directory ? 0o700n : 0o600n)))) fail('host_path_refused');
}
// File IDs can exceed Number's exact integer range (notably on NTFS).
// Every identity below must originate from a BigInt stat, before any rounding.
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function privateDirectory(root) {
  const observed = await fs.lstat(root, { bigint: true }); privateInfo(observed, true);
  if (await fs.realpath(root) !== root) fail('host_path_refused');
  const handle = await fs.open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat({ bigint: true }); privateInfo(held, true);
    if (!sameFile(observed, held)) fail('host_path_refused');
    const check = async () => {
      const current = await fs.lstat(root, { bigint: true }); privateInfo(current, true);
      if (!sameFile(held, current) || await fs.realpath(root) !== root) fail('host_path_refused');
    };
    await check(); return { handle, check };
  } catch (error) { await handle.close(); throw error; }
}

// Kernel boot identity (Linux procfs). boot_id is a random UUID the kernel draws at every boot and btime that boot's
// wall-clock second. A lock written during another boot cannot have a living owner: every process of that boot died
// with its kernel (sự cố 06/11/2026: VPS reset, the lock of 02/11 kept the unit down ~24 h on host_already_owned).
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_BOOT = Object.freeze({ bootId: null, bootTime: null });
const LOCK_MAX_BYTES = 512;
// A version 1 lock (no bootId: releases before 07/11/2026) is stale only when both its mtime and its ctime precede the
// current btime by more than this, which absorbs clock slew/steps between the old boot's file times and this boot.
const LEGACY_LOCK_MARGIN_NS = 3_600_000_000_000n;
const CREATE = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/** Boot identity from procfs: `sys/kernel/random/boot_id` and the `btime` line of `stat` (as nanoseconds). A missing,
 * unreadable or malformed source is null. `procRoot` is a test seam, never configuration. */
export async function readBootIdentity({ procRoot = '/proc' } = {}) {
  const read = name => fs.readFile(path.join(procRoot, ...name), 'latin1').catch(() => null);
  const [id, stat] = await Promise.all([read(['sys', 'kernel', 'random', 'boot_id']), read(['stat'])]);
  const bootId = typeof id === 'string' && /^[0-9a-f-]{36}\n?$/.test(id) && BOOT_ID.test(id.slice(0, 36)) ? id.slice(0, 36) : null;
  const seconds = typeof stat === 'string' ? /^btime ([1-9]\d{0,14})$/m.exec(stat)?.[1] : undefined;
  return Object.freeze({ bootId, bootTime: seconds ? BigInt(seconds) * 1_000_000_000n : null });
}
const procBoot = () => process.platform === 'linux' ? readBootIdentity() : NO_BOOT;
async function currentBoot(readBoot) {
  try {
    const value = await readBoot();
    if (typeof value?.bootId !== 'string' || !BOOT_ID.test(value.bootId)) return NO_BOOT;
    return { bootId: value.bootId, bootTime: typeof value.bootTime === 'bigint' && value.bootTime > 0n ? value.bootTime : null };
  } catch { return NO_BOOT; }
}
const lockBytes = (lockId, bootId) => Buffer.from(JSON.stringify(bootId ? { version: 2, lockId, bootId } : { version: 1, lockId }) + '\n');
// Only the exact bytes this module writes are recognised: empty, partial, reordered or extended content is never stale.
function parseLock(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.lockId !== 'string' || !UUID.test(value.lockId)) return null;
  const bootId = value.version === 2 && typeof value.bootId === 'string' && BOOT_ID.test(value.bootId) ? value.bootId : null;
  if (value.version !== 1 && !bootId) return null;
  return lockBytes(value.lockId, bootId).equals(bytes) ? { lockId: value.lockId, bootId } : null;
}
async function readLock(filename) {
  const named = await fs.lstat(filename, { bigint: true }); privateInfo(named, false);
  if (named.size < 1n || named.size > BigInt(LOCK_MAX_BYTES)) fail('host_already_owned');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true }), bytes = Buffer.alloc(LOCK_MAX_BYTES + 1); privateInfo(info, false);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (!sameFile(named, info) || info.size !== named.size || BigInt(bytesRead) !== info.size) fail('host_already_owned');
    return { info, bytes: bytes.subarray(0, bytesRead) };
  } finally { await handle.close(); }
}
/** Proof that an existing lock's owner cannot be alive: a version 2 lock of another boot, or a version 1 lock whose
 * mtime and ctime both precede this boot by more than the margin. Anything else (same boot, no boot identity,
 * unknown content, symlink, hard link, other owner/mode, unreadable) is null: the lock stays owned, as before. */
async function staleLock(filename, boot) {
  if (!boot.bootId) return null;
  try {
    const observed = await readLock(filename), record = parseLock(observed.bytes);
    if (!record) return null;
    if (record.bootId) return record.bootId === boot.bootId ? null : { ...observed, lockId: record.lockId, basis: 'boot_id' };
    const changed = observed.info.mtimeNs > observed.info.ctimeNs ? observed.info.mtimeNs : observed.info.ctimeNs;
    return boot.bootTime !== null && changed + LEGACY_LOCK_MARGIN_NS < boot.bootTime ? { ...observed, lockId: record.lockId, basis: 'boot_time' } : null;
  } catch { return null; }
}
async function unchangedLock(filename, stale) {
  try {
    const { info, bytes } = await readLock(filename);
    return sameFile(stale.info, info) && info.mtimeNs === stale.info.mtimeNs && info.ctimeNs === stale.info.ctimeNs && bytes.equals(stale.bytes);
  } catch { return false; }
}
async function withdrawClaim(claim, held) {
  try { if (sameFile(held, await fs.lstat(claim, { bigint: true }))) await fs.unlink(claim); } catch { /* Left for the operator; inert after a reboot. */ }
}
function hostPorts(raw) {
  const ports = data(raw, [], ['readBoot', 'log']);
  if (Object.values(ports).some(port => typeof port !== 'function')) fail('host_invalid_config');
  return ports;
}
const printEvent = record => console.info(JSON.stringify(record));
const emit = (log, record) => { try { void Promise.resolve(log(record)).catch(() => {}); } catch { /* Output never decides ownership. */ } };

/** One writer per canonical, private host state root. Successful acquisition is
 * durable before startup. Existing/crash locks never expire or follow a PID: a lock
 * is replaced only on proof that its owner died with an earlier kernel boot (staleLock),
 * never within the boot that wrote it. Ports (readBoot, log) are a trusted in-process
 * seam, never configuration data.
 * Host must call release only after every runtime/dependency and audit has drained.
 * Same-UID malicious filesystem mutation is outside the trusted-host boundary;
 * observed replacement/tampering is nevertheless denied, never overwritten.
 */
export async function acquireHostOwnership(options, ports = {}) {
  const root = rootOption(options, 'stateRoot'), filename = path.join(root, LOCK);
  const { readBoot = procBoot, log = printEvent } = hostPorts(ports), boot = await currentBoot(readBoot);
  const content = lockBytes(randomUUID(), boot.bootId);
  let directory, handle, held, stale, claim, created = false, published = false;
  try {
    directory = await privateDirectory(root);
    try { handle = await fs.open(filename, CREATE, 0o600); created = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      stale = await staleLock(filename, boot);
      if (!stale) fail('host_already_owned');
      // Starts of this boot meet at one exclusive claim per stale lock; a claim cut short in an earlier boot is inert.
      claim = path.join(root, `${LOCK}.reclaim-${stale.lockId}-${boot.bootId}`);
      try { handle = await fs.open(claim, CREATE, 0o600); }
      catch (claimError) { if (claimError.code === 'EEXIST') fail('host_already_owned'); throw claimError; }
    }
    held = await handle.stat({ bigint: true }); privateInfo(held, false);
    await handle.writeFile(content); await handle.datasync();
    if (stale) {
      // Only the claim holder may replace that stale inode, and only while it is unchanged: a lock that changed
      // since inspection (for instance one recovered by an earlier claim holder) is never overwritten.
      await directory.check();
      if (!await unchangedLock(filename, stale)) fail('host_already_owned');
      published = true; await fs.rename(claim, filename);
      emit(log, { event: 'host_stale_lock_recovered', basis: stale.basis });
    }
    await directory.check(); await directory.handle.sync();
    const named = await fs.lstat(filename, { bigint: true }), opened = await handle.stat({ bigint: true });
    privateInfo(named, false); privateInfo(opened, false);
    if (!sameFile(held, named) || !sameFile(held, opened) || named.size !== BigInt(content.length) || opened.size !== BigInt(content.length)) fail('host_lock_changed');
    await directory.check();
  } catch (error) {
    await Promise.allSettled([handle?.close(), directory?.handle.close()]);
    // An unknown acquire leaves its marker in place. Never remove a possibly
    // durable lock merely because the caller did not receive an acknowledgment.
    if (created || published) fail('host_ownership_unknown');
    // An unpublished claim never conferred ownership: withdraw it while it is still this attempt's own file.
    if (stale && held) await withdrawClaim(claim, held);
    if (error instanceof HostOwnershipError) throw error;
    fail('host_ownership_unavailable');
  }
  let release;
  return Object.freeze({
    release() {
      if (release) return release;
      release = (async () => {
        let removed = false, checkHandle;
        try {
          await directory.check();
          checkHandle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const current = await checkHandle.stat({ bigint: true }); privateInfo(current, false);
          if (!sameFile(held, current) || current.size !== BigInt(content.length) || !(await checkHandle.readFile()).equals(content)) fail('host_lock_changed');
          await checkHandle.close(); checkHandle = undefined;
          await directory.check();
          const final = await fs.lstat(filename, { bigint: true }); privateInfo(final, false);
          if (!sameFile(held, final) || final.size !== BigInt(content.length)) fail('host_lock_changed');
          await fs.unlink(filename); removed = true; await directory.handle.sync();
          await handle.close(); await directory.handle.close();
        } catch {
          await Promise.allSettled([checkHandle?.close(), handle.close(), directory.handle.close()]);
          fail(removed ? 'host_release_unknown' : 'host_lock_retained');
        }
      })();
      return release;
    },
  });
}

// Lượt 12 Hợp đồng (rào đồng ý, infra/hermes-broker/consent-guard.mjs): dòng prepared của lượt xác nhận một thao tác KHÔNG lùi được mang
// consent = {action, requestId, text} — text là câu đồng ý mô hình trích từ người dùng (một dòng, ≤ 300 ký tự), ngoại lệ DUY NHẤT
// của luật "không chữ thô" dưới đây: để lần lại lời đồng ý khi có ghi sai.
const ACTION_ID = /^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$/;
const consentEvent = value => {
  const consent = data(value, ['action', 'requestId', 'text']);
  if (!ACTION_ID.test(consent.action) || typeof consent.requestId !== 'string' || !UUID.test(consent.requestId) || typeof consent.text !== 'string' ||
    !consent.text || [...consent.text].length > 300 || /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u.test(consent.text)) fail('host_audit_invalid');
  return consent;
};
// Thu chi lượt 16 (infra/hermes-broker/action-runtime.mjs): lượt xác nhận dùng requestId của token khi requestId mô hình gửi lệch — dòng
// prepared mang requestIdFix = {action, requestId của token, supplied: different | malformed | missing}; chuỗi mô hình gửi KHÔNG vào sổ.
const REQUEST_ID_FIXES = new Set(['different', 'malformed', 'missing']);
const requestIdFixEvent = value => {
  const fix = data(value, ['action', 'requestId', 'supplied']);
  if (!ACTION_ID.test(fix.action) || typeof fix.requestId !== 'string' || !UUID.test(fix.requestId) || !REQUEST_ID_FIXES.has(fix.supplied)) fail('host_audit_invalid');
  return fix;
};
// C3n (confirm-guard.mjs redeemNear): lượt xác nhận khớp token GẦN ĐÚNG ⇒ dòng prepared mang confirmTokenFix = {action, requestId của
// bản xem trước}; chuỗi token mô hình gửi KHÔNG vào sổ.
const confirmTokenFixEvent = value => {
  const fix = data(value, ['action', 'requestId']);
  if (!ACTION_ID.test(fix.action) || typeof fix.requestId !== 'string' || !UUID.test(fix.requestId)) fail('host_audit_invalid');
  return fix;
};
function auditEvent(raw) {
  const event = data(raw, ['requestId', 'operation', 'connectionId', 'outcome'], ['code', 'reason', 'consent', 'requestIdFix', 'confirmTokenFix']);
  if (['consent', 'requestIdFix', 'confirmTokenFix'].some(key => Object.hasOwn(event, key)) && (event.outcome !== 'prepared' || event.operation !== 'tools/call')) fail('host_audit_invalid');
  if (Object.hasOwn(event, 'consent')) event.consent = consentEvent(event.consent);
  if (Object.hasOwn(event, 'requestIdFix')) event.requestIdFix = requestIdFixEvent(event.requestIdFix);
  if (Object.hasOwn(event, 'confirmTokenFix')) event.confirmTokenFix = confirmTokenFixEvent(event.confirmTokenFix);
  if (typeof event.requestId !== 'string' || !UUID.test(event.requestId) || !OPERATIONS.has(event.operation) ||
    (event.connectionId !== null && (typeof event.connectionId !== 'string' || !UUID.test(event.connectionId)))) fail('host_audit_invalid');
  if (event.outcome === 'prepared') {
    if (event.connectionId === null || Object.hasOwn(event, 'code') || Object.hasOwn(event, 'reason')) fail('host_audit_invalid');
  } else if (!['denied', 'timeout'].includes(event.outcome) || !CODES.has(event.code) ||
      ((event.outcome === 'timeout') !== (event.code === 'timeout'))) fail('host_audit_invalid');
  if (Object.hasOwn(event, 'reason') && (event.code !== 'action_rejected' || !REASONS.has(event.reason))) fail('host_audit_invalid');
  return Buffer.from(JSON.stringify(event) + '\n');
}

/** Host-only bounded append sink for the broker's actual fixed event protocol.
 * No raw request, text, provider error, token or caller-selected filename (sole exception: the bounded
 * consent sentence of an irreversible action's confirmation, consentEvent above).
 * Caller must own the enclosing host lock. Successful write includes fdatasync;
 * close waits actual queued filesystem work even if a broker deadline elapsed.
 * One 16MiB file; reaching capacity requires explicit host maintenance, never
 * silent truncation/rotation. Any storage ambiguity latches failure, no retry.
 */
export function createHostAudit(options) {
  const root = rootOption(options, 'directory'), filename = path.join(root, AUDIT), owner = {};
  let directory, file, held, expectedSize, tail = Promise.resolve(), pending = 0, closing = false, closed, failure, owned = false;
  const initialize = async () => {
    if (file) return;
    directory = await privateDirectory(root);
    if (AUDIT_OWNERS.has(root)) fail('host_audit_in_use');
    AUDIT_OWNERS.set(root, owner); owned = true;
    let created = false;
    try { file = await fs.open(filename, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; file = await fs.open(filename, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)); }
    held = await file.stat({ bigint: true }); privateInfo(held, false);
    if (held.size < 0n || held.size > BigInt(MAX_AUDIT_BYTES)) fail('host_audit_capacity');
    expectedSize = Number(held.size);
    if (expectedSize) {
      const last = Buffer.alloc(1); const { bytesRead } = await file.read(last, 0, 1, expectedSize - 1);
      if (bytesRead !== 1 || last[0] !== 10) fail('host_audit_incomplete');
    }
    await directory.check(); if (created) { await file.datasync(); await directory.handle.sync(); }
  };
  return Object.freeze({
    write(raw) {
      let bytes;
      try { bytes = auditEvent(raw); } catch { return Promise.reject(new HostOwnershipError('host_audit_invalid')); }
      if (closing) return Promise.reject(new HostOwnershipError('host_audit_closed'));
      if (failure) return Promise.reject(failure);
      if (pending >= MAX_PENDING) return Promise.reject(new HostOwnershipError('host_audit_busy'));
      pending++;
      const work = tail.then(async () => {
        if (failure) throw failure;
        let appended = false;
        try {
          await initialize(); await directory.check();
          const current = await fs.lstat(filename, { bigint: true }); privateInfo(current, false);
          const opened = await file.stat({ bigint: true }); privateInfo(opened, false);
          if (!sameFile(held, current) || !sameFile(held, opened) || current.size !== BigInt(expectedSize) || opened.size !== BigInt(expectedSize)) fail('host_audit_changed');
          if (expectedSize + bytes.length > MAX_AUDIT_BYTES) fail('host_audit_capacity');
          appended = true; await file.writeFile(bytes); await file.datasync();
          expectedSize += bytes.length;
          const after = await file.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
          privateInfo(after, false); privateInfo(named, false);
          if (!sameFile(held, after) || !sameFile(held, named) || after.size !== BigInt(expectedSize) || named.size !== BigInt(expectedSize)) fail('host_audit_changed');
          await directory.check();
        } catch (error) {
          failure = new HostOwnershipError(appended ? 'host_audit_unknown' : error instanceof HostOwnershipError ? error.code : 'host_audit_unavailable');
          throw failure;
        }
      });
      tail = work.then(() => { pending--; bytes.fill(0); }, () => { pending--; bytes.fill(0); });
      return work;
    },
    close() {
      if (closed) return closed;
      closing = true;
      closed = tail.then(async () => {
        const results = await Promise.allSettled([file?.close(), directory?.handle.close()]);
        if (results.some(result => result.status === 'rejected')) failure ??= new HostOwnershipError('host_audit_close_failed');
        if (failure) throw failure;
        if (owned && AUDIT_OWNERS.get(root) === owner) AUDIT_OWNERS.delete(root);
      });
      return closed;
    },
  });
}
