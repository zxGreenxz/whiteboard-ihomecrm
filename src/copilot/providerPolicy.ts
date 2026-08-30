export const PRICING_MODES = ['metered', 'free', 'self_hosted', 'unknown'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export interface ProviderModel {
  id?: unknown;
  pricing_mode?: unknown;
  input_price?: unknown;
  output_price?: unknown;
  [key: string]: unknown;
}

export function validateProviderModels(models: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(models)) return ['models must be an array'];
  const ids = new Set<string>();
  for (const value of models) {
    const model = value && typeof value === 'object' ? value as ProviderModel : null;
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id) {
      problems.push('model requires a non-empty id');
      continue;
    }
    if (ids.has(id)) problems.push(`${id}: duplicate model id`);
    ids.add(id);
    if (!PRICING_MODES.includes(model?.pricing_mode as PricingMode)) {
      problems.push(`${id}: pricing_mode must be explicit`);
    }
    for (const key of ['input_price', 'output_price'] as const) {
      const price = model?.[key];
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
        problems.push(`${id}: ${key} must be a finite non-negative number`);
      }
    }
    if (model?.pricing_mode === 'metered' && ((model.input_price as number) <= 0 || (model.output_price as number) <= 0)) {
      problems.push(`${id}: metered pricing requires positive input_price and output_price`);
    }
  }
  return problems;
}

export function validateDefaultModel(models: unknown, defaultModel: unknown): string[] {
  if (defaultModel === null || defaultModel === undefined || defaultModel === '') return [];
  if (!Array.isArray(models) || !models.some((model) => model && typeof model === 'object' && (model as ProviderModel).id === defaultModel)) {
    return ['default_model must match a model id'];
  }
  return [];
}

export function isUsableProviderModel(model: unknown): boolean {
  const modelProblems = validateProviderModels([model]);
  if (modelProblems.length) return false;
  return (model as ProviderModel).pricing_mode !== 'unknown';
}
