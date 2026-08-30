#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_ACTIONS } from './check-copilot-forbidden-actions.mjs';

export { FORBIDDEN_ACTIONS };

export const PRICING_MODES = new Set(['metered', 'free', 'self_hosted', 'unknown']);

export function validateProviderModels(models) {
  const problems = [];
  if (!Array.isArray(models)) return ['models must be an array'];
  const ids = new Set();
  for (const model of models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) {
      problems.push('model requires a non-empty id');
      continue;
    }
    if (ids.has(model.id)) problems.push(`${model.id}: duplicate model id`);
    ids.add(model.id);
    if (!PRICING_MODES.has(model.pricing_mode)) {
      problems.push(`${model.id}: pricing_mode must be explicit`);
    }
    for (const key of ['input_price', 'output_price']) {
      if (typeof model[key] !== 'number' || !Number.isFinite(model[key]) || model[key] < 0) {
        problems.push(`${model.id}: ${key} must be a finite non-negative number`);
      }
    }
    if (model.pricing_mode === 'metered' && (model.input_price <= 0 || model.output_price <= 0)) {
      problems.push(`${model.id}: metered pricing requires positive input_price and output_price`);
    }
  }
  return problems;
}

export function validateProviderCatalog(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.providers)) return ['providers must be an array'];
  const names = new Set();
  for (const provider of catalog.providers) {
    if (!provider?.provider || names.has(provider.provider)) problems.push(`duplicate or missing provider: ${provider?.provider ?? '<empty>'}`);
    names.add(provider?.provider);
    problems.push(...validateProviderModels(provider.models).map((problem) => `${provider.provider}: ${problem}`));
    const modelIds = new Set(Array.isArray(provider.models) ? provider.models.map((model) => model?.id) : []);
    if (provider.default_model !== undefined && provider.default_model !== null && provider.default_model !== '') {
      if (!modelIds.has(provider.default_model)) {
        problems.push(`${provider.provider}: default_model must match a model id`);
      }
    }
    if (provider.enabled && Array.isArray(provider.models) && provider.models.some((model) => model?.pricing_mode === 'unknown')) {
      problems.push(`${provider.provider}: enabled provider cannot contain unknown pricing`);
    }
    if (!['cloud', 'local_only'].includes(provider.data_class)) problems.push(`${provider.provider}: invalid data_class`);
    if (provider.data_class === 'local_only' && provider.egress !== 'local') problems.push(`${provider.provider}: local_only must egress local`);
    if (provider.data_class === 'cloud' && provider.egress === 'local') problems.push(`${provider.provider}: cloud cannot egress local`);
  }
  return problems;
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(repoRoot, 'tooling', 'copilot-provider-catalog.json');
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateProviderCatalog(catalog);
  if (problems.length) {
    console.error(`Copilot provider policy: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot provider policy: ${catalog.providers.length} provider(s) validated.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
