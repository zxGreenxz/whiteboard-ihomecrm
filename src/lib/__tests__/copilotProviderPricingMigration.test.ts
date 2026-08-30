import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260829080000_copilot_provider_pricing_policy_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('Copilot provider pricing migration', () => {
  it('validates explicit pricing metadata and rejects unsafe enabled models', () => {
    expect(migration).toContain("('metered', 'free', 'self_hosted', 'unknown')");
    expect(migration).toContain("jsonb_typeof(model_input) <> 'number'");
    expect(migration).toContain('prices cannot be negative');
    expect(migration).toContain('enabled provider cannot contain unknown pricing');
  });

  it('validates default_model membership and installs a write trigger', () => {
    expect(migration).toContain('default_model must match a model id');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF models, default_model, enabled');
  });

  it('backfills every existing 9Router model as zero-cost self-hosted', () => {
    const start = migration.indexOf("UPDATE public.ai_providers\nSET models", migration.indexOf("WHERE provider = 'openrouter';") + 1);
    const end = migration.indexOf("WHERE provider = '9router';", start);
    const routerBlock = migration.slice(start, end);
    expect(routerBlock).toContain('FROM jsonb_array_elements(models)');
    expect(routerBlock).toContain("to_jsonb('self_hosted'::text)");
    expect(routerBlock).toContain("'{input_price}',\n        to_jsonb(0::numeric)");
    expect(routerBlock).toContain("'{output_price}',\n      to_jsonb(0::numeric)");
  });
});
