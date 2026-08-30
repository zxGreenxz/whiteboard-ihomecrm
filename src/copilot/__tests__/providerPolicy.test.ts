import { describe, expect, it } from 'vitest';
import { validateProviderModels, validateDefaultModel, isUsableProviderModel } from '../providerPolicy';

describe('provider pricing policy', () => {
  it('requires explicit mode and finite non-negative prices', () => {
    expect(validateProviderModels([{ id: 'free', pricing_mode: 'free', input_price: 0, output_price: 0 }])).toEqual([]);
    expect(validateProviderModels([{ id: 'metered', pricing_mode: 'metered', input_price: 0.2, output_price: 0.4 }])).toEqual([]);
    expect(validateProviderModels([{ id: 'unknown', pricing_mode: 'unknown', input_price: 0, output_price: 0 }])).toEqual([]);
    expect(validateProviderModels([{ id: 'missing', pricing_mode: 'free' }])).toContain('missing: input_price must be a finite non-negative number');
    expect(validateProviderModels([{ id: 'bad', pricing_mode: 'free', input_price: Number.NaN, output_price: -1 }])).toHaveLength(2);
  });

  it('rejects unknown pricing and keeps only valid models for enabled user choices', () => {
    expect(isUsableProviderModel({ id: 'free', pricing_mode: 'free', input_price: 0, output_price: 0 })).toBe(true);
    expect(isUsableProviderModel({ id: 'unknown', pricing_mode: 'unknown', input_price: 0, output_price: 0 })).toBe(false);
    expect(isUsableProviderModel({ id: 'invalid', pricing_mode: 'free', input_price: Infinity, output_price: 0 })).toBe(false);
  });

  it('requires default_model to be a member of the provider model list', () => {
    const models = [{ id: 'known', pricing_mode: 'free', input_price: 0, output_price: 0 }];
    expect(validateDefaultModel(models, 'known')).toEqual([]);
    expect(validateDefaultModel(models, 'missing')).toEqual(['default_model must match a model id']);
  });
});
