import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ERROR_STATUS } from '../hermes-broker/broker.mjs';
import { ACTION_INPUT_REASONS, ACTION_REJECT_REASONS } from '../hermes-broker/action-reasons.mjs';
import { AUDIT_CODES, AUDIT_REASONS, createHostAudit } from './host-ownership.mjs';

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

async function auditRoot(t) {
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
  return root;
}

test('the real audit sink appends a denied/timeout tools/call receipt for every broker error code', async t => {
  const root = await auditRoot(t);
  const sink = createHostAudit({ directory: root });
  for (const code of BROKER_CODES) await sink.write({ ...EVENT, outcome: code === 'timeout' ? 'timeout' : 'denied', code });
  await assert.rejects(sink.write({ ...EVENT, outcome: 'denied', code: 'not_a_broker_code' }), /host_audit_invalid/);
  await sink.close();
  const rows = (await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.code), BROKER_CODES);
  assert.deepEqual(rows.map(row => row.outcome), BROKER_CODES.map(code => code === 'timeout' ? 'timeout' : 'denied'));
});

// Đợt 1 nền chung (D9): action_rejected ghi kèm reason của danh sách đóng infra/hermes-broker/action-reasons.mjs. Thêm lý do
// dạng rejected mà quên REASONS của host-ownership.mjs ⇒ đỏ ngay ở đây (cùng lớp sự cố 21/10 với mã lỗi).
test('audit reasons are exactly the broker rejected-form action reasons (both directions); needs_input reasons never reach audit', () => {
  assert.ok(Object.isFrozen(AUDIT_REASONS));
  const missing = ACTION_REJECT_REASONS.filter(code => !AUDIT_REASONS.includes(code));
  assert.deepEqual(missing, [], `action reasons the host audit would refuse: ${missing.join(', ')}`);
  const foreign = AUDIT_REASONS.filter(code => !ACTION_REJECT_REASONS.includes(code));
  assert.deepEqual(foreign, [], `audit reasons the broker never records: ${foreign.join(', ')}`);
  assert.deepEqual(ACTION_INPUT_REASONS.filter(code => AUDIT_REASONS.includes(code)), []);
});

test('the real audit sink records action_rejected with every reason and refuses a reason anywhere else', async t => {
  const root = await auditRoot(t);
  const sink = createHostAudit({ directory: root });
  for (const reason of ACTION_REJECT_REASONS) await sink.write({ ...EVENT, outcome: 'denied', code: 'action_rejected', reason });
  await sink.write({ ...EVENT, outcome: 'denied', code: 'action_rejected' });
  for (const bad of [{ code: 'action_rejected', reason: 'not_a_reason' }, { code: 'action_rejected', reason: ACTION_INPUT_REASONS[0] },
    { code: 'forbidden', reason: ACTION_REJECT_REASONS[0] }, { code: 'action_rejected', reason: null }])
    await assert.rejects(sink.write({ ...EVENT, outcome: 'denied', ...bad }), /host_audit_invalid/, JSON.stringify(bad));
  await assert.rejects(sink.write({ ...EVENT, outcome: 'prepared', reason: ACTION_REJECT_REASONS[0] }), /host_audit_invalid/);
  await sink.close();
  const rows = (await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.reason ?? null), [...ACTION_REJECT_REASONS, null]);
});

// Lượt 12 Hợp đồng (rào đồng ý, infra/hermes-broker/consent-guard.mjs): dòng prepared của lượt xác nhận một thao tác không lùi được mang
// consent {action, requestId, text}; mọi chỗ khác hay khuôn khác đều bị từ chối (đóng an toàn như mã lỗi).
test('the real audit sink records the consent sentence only on a tools/call prepared row, in its fixed shape', async t => {
  const root = await auditRoot(t);
  const sink = createHostAudit({ directory: root });
  const consent = { action: 'contract.return', requestId: '30000000-0000-4000-8000-000000000003', text: 'Ok em, ghi đi' };
  await sink.write({ ...EVENT, outcome: 'prepared', consent });
  await sink.write({ ...EVENT, outcome: 'prepared', consent: { ...consent, text: 'đ'.repeat(300) } });
  for (const bad of [{ outcome: 'denied', code: 'action_rejected', consent }, { outcome: 'prepared', operation: 'tools/list', consent },
    { outcome: 'prepared', consent: { ...consent, extra: 1 } }, { outcome: 'prepared', consent: { action: consent.action, requestId: consent.requestId } },
    { outcome: 'prepared', consent: { ...consent, text: '' } }, { outcome: 'prepared', consent: { ...consent, text: 'đ'.repeat(301) } },
    { outcome: 'prepared', consent: { ...consent, text: 'ok\nghi' } }, { outcome: 'prepared', consent: { ...consent, text: 'ok ghi' } },
    { outcome: 'prepared', consent: { ...consent, requestId: 'not-a-uuid' } }, { outcome: 'prepared', consent: { ...consent, action: 'Contract Return' } },
    { outcome: 'prepared', consent: 'ok' }, { outcome: 'prepared', consent: null }])
    await assert.rejects(sink.write({ ...EVENT, ...bad }), /host_audit_invalid/, JSON.stringify(bad));
  await sink.close();
  const rows = (await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.consent?.text.length), [consent.text.length, 300]);
  assert.deepEqual(rows[0], { ...EVENT, outcome: 'prepared', consent });
});
