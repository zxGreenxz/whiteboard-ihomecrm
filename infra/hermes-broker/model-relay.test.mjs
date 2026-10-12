import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRelay } from './model-relay.mjs';

const organizationId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const body = () => ({ model: 'openai:fixture', messages: [{ role: 'user', content: 'Synthetic room question' }], max_tokens: 128 });
const completion = () => ({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0,
  message: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function setup(extra = {}) {
  const calls = [];
  const relay = createModelRelay({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    allowedModels: ['openai:fixture'], fetch: async (url, options) => { calls.push({ url, options }); return response(completion()); }, ...extra });
  const controller = new AbortController();
  const context = { accessToken: 'server-only-jwt', organizationId, requestId, signal: controller.signal };
  return { relay, calls, context, controller };
}
const code = value => error => error.code === value;

test('one fixed llm-proxy request owns both provider access and usage accounting', async () => {
  const { relay, context, calls } = setup();
  assert.deepEqual(await relay.complete({ ...context, body: body() }), completion());
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(String(url), 'https://fixture.supabase.co/functions/v1/llm-proxy/chat/completions');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { apikey: 'sb_publishable_fixture', authorization: 'Bearer server-only-jwt',
    'content-type': 'application/json', accept: 'application/json', 'x-organization-id': organizationId,
    'x-copilot-feature': 'chat', 'x-task-id': requestId });
  assert.equal(JSON.parse(options.body).stream, false);
  assert.ok(!options.body.includes(context.accessToken));
});

test('model allowlist starts closed and rejects a different provider without network access', async () => {
  for (const allowedModels of [[], ['different:fixture']]) {
    const { relay, context, calls } = setup({ allowedModels });
    await assert.rejects(relay.complete({ ...context, body: body() }), code('model_not_enabled'));
    assert.equal(calls.length, 0);
  }
});

test('untrusted request cannot set actor, company, task, endpoint or proxy feature', async () => {
  const { relay, context, calls } = setup();
  for (const key of ['user', 'organizationId', 'requestId', 'headers', 'base_url', 'api_key', 'feature']) {
    await assert.rejects(relay.complete({ ...context, body: { ...body(), [key]: 'attacker' } }));
  }
  for (const field of ['organizationId', 'requestId']) {
    await assert.rejects(relay.complete({ ...context, [field]: 'not-a-server-id', body: body() }), code('invalid_context'));
  }
  assert.equal(calls.length, 0);
});

test('only bounded text and CRM tool messages are admitted; stream and URL images stay closed', async () => {
  const { relay, context, calls } = setup();
  for (const invalid of [
    { ...body(), stream: true }, { ...body(), max_tokens: 999999 }, { ...body(), temperature: NaN },
    { ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://localhost/secret' } }] }] },
    { ...body(), messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) },
    { ...body(), parallel_tool_calls: true },
    { ...body(), messages: [{ role: 'tool', content: 'data' }] },
    { ...body(), tools: [{ type: 'function', function: { name: 'terminal', description: 'shell', parameters: { type: 'object' } } }] },
  ]) await assert.rejects(relay.complete({ ...context, body: invalid }));
  assert.equal(calls.length, 0);
  const tool = { type: 'function', function: { name: 'mcp__crm__crm_auth_context', description: 'Context', parameters: { type: 'object', properties: {} } } };
  await relay.complete({ ...context, body: { ...body(), tools: [tool], messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{}' },
  ] } });
  assert.equal(calls.length, 1);
});

test('request byte cap fails before forwarding any part of context', async () => {
  const { relay, context, calls } = setup({ maxRequestBytes: 100 });
  await assert.rejects(relay.complete({ ...context, body: body() }), code('request_too_large'));
  assert.equal(calls.length, 0);
});

test('quota and authorization rejection propagates safe code once, without retry or upstream details', async () => {
  for (const errorCode of ['daily_quota', 'daily_token_quota', 'not_permitted', 'organization_forbidden', 'rate_limited']) {
    let count = 0;
    const { relay, context } = setup({ fetch: async () => {
      count++;
      return new Response(JSON.stringify({ error: { code: errorCode, message: 'private-provider-detail' } }), { status: 403 });
    } });
    await assert.rejects(relay.complete({ ...context, body: body() }), error => error.code === errorCode && !error.message.includes('private'));
    assert.equal(count, 1);
  }
});

test('unknown upstream failures and lost responses never echo credentials and never retry', async () => {
  for (const fetch of [async () => { throw new Error('server-only-jwt'); },
    async () => new Response(JSON.stringify({ error: { code: 'internal', message: 'server-only-jwt' } }), { status: 500 })]) {
    let count = 0;
    const { relay, context } = setup({ fetch: (...args) => { count++; return fetch(...args); } });
    await assert.rejects(relay.complete({ ...context, body: body() }), code('proxy_unavailable'));
    assert.equal(count, 1);
  }
});

test('pre-cancelled call does not consume a proxy request', async () => {
  const { relay, context, controller, calls } = setup(); controller.abort();
  await assert.rejects(relay.complete({ ...context, body: body() }), code('cancelled'));
  assert.equal(calls.length, 0);
});

test('connection cancellation aborts in-flight transport and suppresses late completion', async () => {
  let finish; let sentSignal;
  const { relay, context, controller } = setup({ fetch: async (_url, options) => {
    sentSignal = options.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = relay.complete({ ...context, body: body() });
  controller.abort();
  await assert.rejects(pending, code('cancelled'));
  assert.equal(sentSignal.aborted, true);
  finish(response(completion()));
  await new Promise(resolve => setImmediate(resolve));
});

test('deadline remains bounded when the injected transport ignores abort', async () => {
  const { relay, context } = setup({ timeoutMs: 5, fetch: () => new Promise(() => {}) });
  await assert.rejects(relay.complete({ ...context, body: body() }), code('timeout'));
});

test('response cap cancels an unbounded stream and malformed completion is rejected', async () => {
  let cancelled = false;
  const { relay, context } = setup({ maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('more than ten bytes')); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(relay.complete({ ...context, body: body() }), code('response_too_large'));
  assert.equal(cancelled, true);
  const invalid = setup({ fetch: async () => response({ choices: [] }) });
  await assert.rejects(invalid.relay.complete({ ...invalid.context, body: body() }), code('invalid_proxy_response'));
});

test('unsafe origins, secret keys and unbounded configuration are refused', () => {
  for (const override of [
    { supabaseUrl: 'http://fixture.supabase.co' }, { supabaseUrl: 'https://user:password@fixture.supabase.co' },
    { supabaseUrl: 'https://fixture.supabase.co/override' }, { publishableKey: 'sb_secret_forbidden' },
    { timeoutMs: 0 }, { timeoutMs: 180001 }, { maxResponseBytes: Infinity },
  ]) assert.throws(() => setup(override));
});

test('HTTP 200 cannot disguise an error or release provider debugging fields', async () => {
  for (const value of [
    { ...completion(), error: { message: 'private-provider-error' } },
    { ...completion(), choices: [{ index: 0, message: { error: 'private', role: 'assistant', content: 'text' }, finish_reason: 'stop' }] },
    { ...completion(), choices: [{ index: 0, message: {}, finish_reason: 'stop' }] },
    { ...completion(), usage: { total_tokens: -1 } },
  ]) {
    const { relay, context } = setup({ fetch: async () => response(value) });
    await assert.rejects(relay.complete({ ...context, body: body() }), error => error.code === 'invalid_proxy_response' && !error.message.includes('private'));
  }
  const value = completion(); value.debug = 'private-debug'; value.usage.debug = 'private-usage'; value.choices[0].message.debug = 'private-message';
  const { relay, context } = setup({ fetch: async () => response(value) });
  assert.deepEqual(await relay.complete({ ...context, body: body() }), completion());
});

test('completion cannot smuggle an unadvertised tool through a successful provider response', async () => {
  const value = completion(); value.choices[0] = { index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }] } };
  const { relay, context } = setup({ fetch: async () => response(value) });
  await assert.rejects(relay.complete({ ...context, body: body() }), code('invalid_proxy_response'));
});

test('response tools are checked against the sent snapshot despite caller mutation', async () => {
  let finish;
  const requestBody = body();
  const { relay, context } = setup({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = relay.complete({ ...context, body: requestBody });
  const name = 'mcp__crm__not_advertised';
  requestBody.tools = [{ type: 'function', function: { name, description: 'Late mutation', parameters: { type: 'object' } } }];
  const value = completion(); value.choices[0] = { index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{}' } }] } };
  finish(response(value));
  await assert.rejects(pending, code('invalid_proxy_response'));
});
