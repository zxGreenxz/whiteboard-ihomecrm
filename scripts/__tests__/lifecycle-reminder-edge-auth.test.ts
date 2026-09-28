// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

const source = readFileSync(new URL('../../supabase/functions/lifecycle-reminders/index.ts', import.meta.url), 'utf8');
const executable = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = 'https://test-project.supabase.co';
const internalKey = 'test-only-internal-service-jwt';
const databaseKey = 'different-built-in-database-service-key';

function endpoint(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: databaseKey, LIFECYCLE_REMINDERS_SERVICE_JWT: internalKey, ...overrides };
  const rpc = vi.fn();
  const createClient = vi.fn(() => ({ rpc }));
  const sweep = vi.fn(async () => ({ ok: true }));
  const fetch = vi.fn();
  let handler: ((request: Request) => Promise<Response>) | undefined;
  runInNewContext(executable, {
    exports: {}, Response, console, fetch,
    Deno: { env: { get: (name: string) => env[name] }, serve: (value: typeof handler) => { handler = value; } },
    require: (specifier: string) => {
      if (specifier === 'https://esm.sh/@supabase/supabase-js@2.81.1') return { createClient };
      if (specifier === './runner.ts') return { runLifecycleReminders: sweep };
      throw new Error('Unexpected dependency: ' + specifier);
    },
  });
  if (!handler) throw new Error('Edge handler was not registered');
  return { handler, createClient, rpc, sweep, fetch };
}

const request = (token?: string, method = 'POST') => new Request(url + '/functions/v1/lifecycle-reminders', { method, headers: token ? { Authorization: 'Bearer ' + token } : {} });

describe('lifecycle Edge service authorization', () => {
  test('accepts the exact dedicated JWT while using the distinct built-in key for the DB client', async () => {
    const app = endpoint();
    const response = await app.handler(request(internalKey));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(app.createClient).toHaveBeenCalledWith(url, databaseKey, { auth: { persistSession: false } });
    expect(app.sweep).toHaveBeenCalledWith(expect.any(Function), app.fetch, url, databaseKey);
  });

  test.each([undefined, '', 'wrong-service-key', databaseKey])('rejects missing or nonmatching caller credential %s before accessing DB', async (token) => {
    const app = endpoint();
    expect((await app.handler(request(token))).status).toBe(401);
    expect(app.createClient).not.toHaveBeenCalled();
    expect(app.sweep).not.toHaveBeenCalled();
  });

  test('fails closed when the dedicated credential is not configured', async () => {
    const app = endpoint({ LIFECYCLE_REMINDERS_SERVICE_JWT: undefined });
    expect((await app.handler(request(databaseKey))).status).toBe(401);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('retains POST-only behavior', async () => {
    const app = endpoint();
    expect((await app.handler(request(internalKey, 'GET'))).status).toBe(405);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])('reports missing DB configuration %s only after valid internal authorization', async (name) => {
    const app = endpoint({ [name]: undefined });
    expect((await app.handler(request(internalKey))).status).toBe(500);
    expect(app.createClient).not.toHaveBeenCalled();
  });
});
