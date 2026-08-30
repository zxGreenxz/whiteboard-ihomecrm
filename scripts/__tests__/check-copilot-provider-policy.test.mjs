import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProviderModels, validateProviderCatalog, FORBIDDEN_ACTIONS } from '../check-copilot-provider-policy.mjs';

test('provider models require explicit pricing mode and valid prices', () => {
  assert.deepEqual(validateProviderModels([{ id: 'free', pricing_mode: 'free', input_price: 0, output_price: 0 }]), []);
  assert.deepEqual(validateProviderModels([{ id: 'self-hosted', pricing_mode: 'self_hosted', input_price: 0, output_price: 0 }]), []);
  assert.deepEqual(validateProviderModels([{ id: 'unknown', pricing_mode: 'unknown', input_price: 0, output_price: 0 }]), []);
  assert.ok(validateProviderModels([{ id: 'missing', pricing_mode: 'metered', input_price: 1 }]).length > 0);
  assert.ok(validateProviderModels([{ id: 'bad', pricing_mode: 'metered', input_price: -1, output_price: 2 }]).length > 0);
  assert.ok(validateProviderModels([{ id: 'nan', pricing_mode: 'metered', input_price: 'NaN', output_price: 2 }]).length > 0);
  assert.ok(validateProviderModels([{ id: 'infinity', pricing_mode: 'metered', input_price: Infinity, output_price: 2 }]).length > 0);
});

test('provider catalog rejects enabled providers with unknown pricing or invalid default model', () => {
  const problems = validateProviderCatalog({
    providers: [{
      provider: 'cloud',
      enabled: true,
      data_class: 'cloud',
      egress: 'cloud',
      default_model: 'missing',
      models: [{ id: 'known', pricing_mode: 'unknown', input_price: 0, output_price: 0 }],
    }],
  });
  assert.ok(problems.some((problem) => problem.includes('unknown pricing')));
  assert.ok(problems.some((problem) => problem.includes('default_model')));
});

test('forbidden action catalog is non-empty and stable', () => {
  for (const action of ['approve', 'post', 'delete', 'change_permissions', 'deploy', 'run_sql']) {
    assert.ok(FORBIDDEN_ACTIONS.has(action));
  }
});
