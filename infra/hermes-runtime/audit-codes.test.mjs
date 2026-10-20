import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ERROR_STATUS } from '../hermes-broker/broker.mjs';
import { AUDIT_CODES, createHostAudit } from './host-ownership.mjs';

// Sự cố production 21/10/2026 03:30 (B5e): broker ném `read_name_unresolved` (ERROR_STATUS) nhưng sổ audit host (CODES
// trong host-ownership.mjs) không nhận ⇒ host_audit_invalid ⇒ broker đóng an toàn ⇒ mọi lỗi tên thành backend_unavailable.
// Broker ghi sổ MỌI lỗi của một lượt gọi với đúng mã của nó (broker.mjs invoke: recordAudit({ outcome: 'denied' |
// 'timeout', code: safe.code })) nên tập mã audit phải phủ trọn ERROR_STATUS. Không loại trừ mã nào: cả mã bất định của
// ghi (MUTATION_UNKNOWN) cũng tới audit — broker chỉ nuốt lỗi audit cho chúng, sổ vẫn phải có dòng.
const BROKER_CODES = Object.freeze(Object.keys(ERROR_STATUS));
const EVENT = { requestId: '10000000-0000-4000-8000-000000000001', operation: 'tools/call', connectionId: '20000000-0000-4000-8000-000000000002' };

test('every broker error code is an audit code the host accepts (ERROR_STATUS ⊆ AUDIT_CODES), and the audit protocol has no other code', () => {
  assert.ok(Object.isFrozen(ERROR_STATUS) && Object.isFrozen(AUDIT_CODES));
  assert.ok(BROKER_CODES.length >= 16 && BROKER_CODES.includes('read_name_unresolved'));
  const missing = BROKER_CODES.filter(code => !AUDIT_CODES.includes(code));
  assert.deepEqual(missing, [], `broker codes the host audit would refuse (host_audit_invalid ⇒ backend_unavailable): ${missing.join(', ')}`);
  // Chiều ngược: sổ audit chỉ nhận mã broker có thể phát — không có mã riêng của host lọt vào giao thức cố định.
  const foreign = AUDIT_CODES.filter(code => !BROKER_CODES.includes(code));
  assert.deepEqual(foreign, [], `audit codes the broker never raises: ${foreign.join(', ')}`);
});

test('the real audit sink appends a denied/timeout tools/call receipt for every broker error code', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-audit-codes-')));
  await fs.chmod(root, 0o700);
  t.after(async () => { t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  // Windows cannot open/fsync a directory (same shim as host-ownership.test.mjs); the event protocol is what is tested.
  if (process.platform === 'win32') {
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (name, flags, mode) => {
      const info = await fs.lstat(name).catch(() => null);
      if (info?.isDirectory() && flags === (constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))) {
        return { stat: () => fs.lstat(name), sync: async () => {}, close: async () => {} };
      }
      return open(name, flags, mode);
    });
  }
  const sink = createHostAudit({ directory: root });
  for (const code of BROKER_CODES) await sink.write({ ...EVENT, outcome: code === 'timeout' ? 'timeout' : 'denied', code });
  await assert.rejects(sink.write({ ...EVENT, outcome: 'denied', code: 'not_a_broker_code' }), /host_audit_invalid/);
  await sink.close();
  const rows = (await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.code), BROKER_CODES);
  assert.deepEqual(rows.map(row => row.outcome), BROKER_CODES.map(code => code === 'timeout' ? 'timeout' : 'denied'));
});
