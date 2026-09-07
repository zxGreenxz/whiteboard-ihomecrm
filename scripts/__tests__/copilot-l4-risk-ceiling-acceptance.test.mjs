import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runL4RiskCeilingAcceptance, assertRiskRejection } from '../copilot-l4-risk-ceiling-acceptance.mjs';

test('exact source L4 guard rejects L5 and closes disposable engine without writes', { timeout: 30_000 }, async () => {
  const receipt = await runL4RiskCeilingAcceptance();
  assertRiskRejection(receipt);
  assert.equal(receipt.caller.current_user, 'authenticated');
  assert.equal(receipt.prerequisites.role_allowed, true);
  assert.equal(receipt.prerequisites.flag_allowed, true);
  assert.equal(receipt.prerequisites.max_direct_risk, 'L4');
  assert.equal(receipt.cleanup.closed, true);
  assert.equal(receipt.liveHttpVerified, false);
  assert.equal(receipt.fullPlanAccepted, false);
  assert.equal(receipt.sources.functions.length, 5);
  assert.match(receipt.engine.version, /PostgreSQL/);
});

test('disabling only the source risk predicate makes the exact guard assertion fail', { timeout: 30_000 }, async () => {
  const receipt = await runL4RiskCeilingAcceptance({ disableRiskPredicate: true });
  assert.equal(receipt.prerequisites.role_allowed, true);
  assert.equal(receipt.prerequisites.flag_allowed, true);
  assert.notEqual(receipt.sources.executedCreateSha256, receipt.sources.functions[0].sha256);
  assert.equal(receipt.error.code, '42883');
  assert.match(receipt.error.message, /copilot_action_gate_v1/);
  assert.throws(() => assertRiskRejection(receipt), /risk ceiling must raise SQLSTATE 42501/);
  assert.deepEqual(receipt.after, receipt.before);
  assert.equal(receipt.cleanup.closed, true);
});
