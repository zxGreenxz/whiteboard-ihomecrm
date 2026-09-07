import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../specs/copilotApprovalReadback.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { docHoSoChoDuyet, docChiTietHoSo } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('official maker list filters exact voucher and subject type with the same JWT', async () => {
  const row = { id: 'request', subject_type: 'FINANCIAL_VOUCHER', subject_id: 'voucher', state: 'PENDING_APPROVAL' };
  const rpc = async (...args) => {
    assert.deepEqual(args, ['actor-jwt', 'list_my_pending_approvals_compat_v2', {}]);
    return { status: 200, body: [row, { ...row, subject_id: 'other' }, { ...row, subject_type: 'OTHER' }] };
  };
  assert.deepEqual(await docHoSoChoDuyet(rpc, 'actor-jwt', 'voucher'), [row]);
  assert.deepEqual(await docHoSoChoDuyet(rpc, 'actor-jwt', 'absent'), []);
});

test('detail preserves actual POSTED state and maker flags rather than manufacturing pending evidence', async () => {
  const detail = { id: 'request', subject_id: 'voucher', state: 'POSTED', is_maker: true, can_decide: false, rule_effect: 'AUTO_POST' };
  assert.deepEqual(await docChiTietHoSo(async (...args) => {
    assert.deepEqual(args, ['actor-jwt', 'get_approval_request_detail_compat_v2', { p_request_id: 'request' }]);
    return { status: 200, body: detail };
  }, 'actor-jwt', 'request'), detail);
});

test('read failures and malformed responses cannot masquerade as no pending request', async () => {
  for (const response of [{ status: 403, body: [] }, { status: 200, body: null }, { status: 200, body: [null] }]) {
    await assert.rejects(docHoSoChoDuyet(async () => response, 'actor-jwt', 'voucher'));
  }
  await assert.rejects(docChiTietHoSo(async () => ({ status: 200, body: null }), 'actor-jwt', 'request'));
});
