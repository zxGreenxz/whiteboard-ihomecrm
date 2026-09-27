import test from 'node:test';
import assert from 'node:assert/strict';

const baseline = await import('../../contract-lifecycle/baseline.mjs').catch(() => ({}));
test('required scenarios cannot become an empty green baseline', () => {
  assert.equal(typeof baseline.assertScenarioSet, 'function');
  assert.throws(() => baseline.assertScenarioSet([]), /scenario/i);
  assert.throws(() => baseline.assertScenarioSet([{ name: 'FORFEIT', status: 'PASS' }]), /scenario/i);
  assert.throws(() => baseline.assertScenarioSet(['FORFEIT','REFUND','DEBT','PAID'].map(name=>({name,status:'PASS'}))), /evidence/i);
});
test('source mutation of cancellation must fail the money oracle', () => {
  assert.equal(typeof baseline.assertForfeitInvoices, 'function');
  const before = [{ id:'u', status:'APPROVED', total_amount:100000, paid_amount:0 },
    { id:'p', status:'PARTIAL_PAID', total_amount:200000, paid_amount:50000 },
    { id:'f', status:'PAID', total_amount:300000, paid_amount:300000 }];
  const after = [{ id:'u', status:'CANCELLED', total_amount:0, paid_amount:0 },
    { id:'p', status:'CANCELLED', total_amount:50000, paid_amount:50000 }, before[2]];
  baseline.assertForfeitInvoices(before, after);
  assert.throws(() => baseline.assertForfeitInvoices(before, [{ ...after[0], status:'APPROVED' }, ...after.slice(1)]), /cancel/i);
  assert.throws(() => baseline.assertForfeitInvoices([], []), /nonzero/i);
  assert.throws(() => baseline.assertForfeitInvoices(before, after.slice(1)), /missing/i);
  assert.throws(() => baseline.assertForfeitInvoices([{...before[0], status:'UNKNOWN'}, ...before.slice(1)], after), /status/i);
});
