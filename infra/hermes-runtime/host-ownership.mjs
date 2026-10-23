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
const REASONS = new Set(['action_disabled', 'not_allowed', 'private_chat_only', 'state_changed', 'request_conflict', 'period_locked',
  'cashbook_not_held', 'not_pending', 'quota_exceeded', 'strict_mode', 'web_only', 'duplicate_request', 'crm_refused',
  // Thu chi (Đợt 2).
  'system_voucher', 'evidence_required',
  // Trang Hợp đồng (Đợt 2).
  'already_returned', 'renew_price_change_web_only', 'no_notice', 'room_not_lockable', 'room_already_locked', 'no_open_lock',
  'cannot_remove_representative',
  // Trang Công việc (Đợt 2b).
  'task_quota_user', 'task_quota_pair', 'cancel_blocked', 'task_not_open',
  // Hoá đơn (Đợt 3 Mốc 3, thu tiền).
  'cash_collection_web_only', 'invoice_not_collectible', 'credit_requires_contract', 'receiving_book_missing', 'reconciliation_required',
  // Hoá đơn (Mốc 4, ghi chỉ số).
  'meter_used_by_invoice', 'meter_has_later_reading']);
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
    (!directory && info.nlink !== 1) || (process.platform !== 'win32' &&
      (info.uid !== process.getuid() || info.gid !== process.getgid() ||
        (info.mode & 0o777) !== (directory ? 0o700 : 0o600)))) fail('host_path_refused');
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function privateDirectory(root) {
  const observed = await fs.lstat(root); privateInfo(observed, true);
  if (await fs.realpath(root) !== root) fail('host_path_refused');
  const handle = await fs.open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat(); privateInfo(held, true);
    if (!sameFile(observed, held)) fail('host_path_refused');
    const check = async () => {
      const current = await fs.lstat(root); privateInfo(current, true);
      if (!sameFile(held, current) || await fs.realpath(root) !== root) fail('host_path_refused');
    };
    await check(); return { handle, check };
  } catch (error) { await handle.close(); throw error; }
}

/** One writer per canonical, private host state root. Successful acquisition is
 * durable before startup. Existing/crash locks never expire or follow a PID.
 * Host must call release only after every runtime/dependency and audit has drained.
 * Same-UID malicious filesystem mutation is outside the trusted-host boundary;
 * observed replacement/tampering is nevertheless denied, never overwritten.
 */
export async function acquireHostOwnership(options) {
  const root = rootOption(options, 'stateRoot'), filename = path.join(root, LOCK);
  const content = Buffer.from(JSON.stringify({ version: 1, lockId: randomUUID() }) + '\n');
  let directory, handle, held, created = false;
  try {
    directory = await privateDirectory(root);
    try { handle = await fs.open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('host_already_owned'); throw error; }
    created = true; held = await handle.stat(); privateInfo(held, false);
    await handle.writeFile(content); await handle.datasync(); await directory.check(); await directory.handle.sync();
    const named = await fs.lstat(filename), opened = await handle.stat();
    privateInfo(named, false); privateInfo(opened, false);
    if (!sameFile(held, named) || !sameFile(held, opened) || named.size !== content.length || opened.size !== content.length) fail('host_lock_changed');
    await directory.check();
  } catch (error) {
    await Promise.allSettled([handle?.close(), directory?.handle.close()]);
    // An unknown acquire leaves its marker in place. Never remove a possibly
    // durable lock merely because the caller did not receive an acknowledgment.
    if (created) fail('host_ownership_unknown');
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
          const current = await checkHandle.stat(); privateInfo(current, false);
          if (!sameFile(held, current) || current.size !== content.length || !(await checkHandle.readFile()).equals(content)) fail('host_lock_changed');
          await checkHandle.close(); checkHandle = undefined;
          await directory.check();
          const final = await fs.lstat(filename); privateInfo(final, false);
          if (!sameFile(held, final) || final.size !== content.length) fail('host_lock_changed');
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

function auditEvent(raw) {
  const event = data(raw, ['requestId', 'operation', 'connectionId', 'outcome'], ['code', 'reason']);
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
 * No raw request, text, provider error, token or caller-selected filename.
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
    held = await file.stat(); privateInfo(held, false);
    if (!Number.isSafeInteger(held.size) || held.size < 0 || held.size > MAX_AUDIT_BYTES) fail('host_audit_capacity');
    expectedSize = held.size;
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
          const current = await fs.lstat(filename); privateInfo(current, false);
          const opened = await file.stat(); privateInfo(opened, false);
          if (!sameFile(held, current) || !sameFile(held, opened) || current.size !== expectedSize || opened.size !== expectedSize) fail('host_audit_changed');
          if (expectedSize + bytes.length > MAX_AUDIT_BYTES) fail('host_audit_capacity');
          appended = true; await file.writeFile(bytes); await file.datasync();
          expectedSize += bytes.length;
          const after = await file.stat(), named = await fs.lstat(filename);
          privateInfo(after, false); privateInfo(named, false);
          if (!sameFile(held, after) || !sameFile(held, named) || after.size !== expectedSize || named.size !== expectedSize) fail('host_audit_changed');
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
