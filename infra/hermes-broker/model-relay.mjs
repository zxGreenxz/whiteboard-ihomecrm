// Internal transport only. The caller MUST supply a server-verified connection
// context; this module has no HTTP route, token issuer or permission authority.
// llm-proxy remains the only owner of provider credentials and usage settlement.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL = /^mcp__crm__[a-z][a-z0-9_]{0,95}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const SAFE_PROXY_CODES = new Set(['unauthorized', 'organization_required', 'organization_forbidden',
  'copilot_disabled', 'not_entitled', 'not_permitted', 'provider_disabled', 'bad_model',
  'bad_pricing', 'daily_token_quota', 'daily_quota', 'rate_limited', 'busy']);

export class ModelRelayError extends Error {
  constructor(code) { super(code); this.name = 'ModelRelayError'; this.code = code; }
}
const reject = code => { throw new ModelRelayError(code); };

function validateRequest(body, models, maxRequestBytes) {
  if (!exact(body, ['model', 'messages', 'max_tokens', 'temperature', 'tools', 'tool_choice', 'stream']) ||
      !models.has(body.model)) reject('model_not_enabled');
  if (body.stream !== undefined && body.stream !== false) reject('stream_not_enabled');
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64 ||
      !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096) reject('invalid_request');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) reject('invalid_request');
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) reject('invalid_request');
  for (const message of body.messages) {
    if (!exact(message, ['role', 'content', 'tool_calls', 'tool_call_id']) ||
        !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
        !(typeof message.content === 'string' || (message.role === 'assistant' && message.content === null))) reject('invalid_request');
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.tool_call_id)) reject('invalid_request');
    } else if (message.tool_call_id !== undefined) reject('invalid_request');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 32) reject('invalid_request');
      for (const call of message.tool_calls) {
        if (!exact(call, ['id', 'type', 'function']) || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id ?? '') || call.type !== 'function' ||
            !exact(call.function, ['name', 'arguments']) || !TOOL.test(call.function.name ?? '') || typeof call.function.arguments !== 'string') reject('invalid_request');
      }
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 32) reject('invalid_request');
    const names = new Set();
    for (const tool of body.tools) {
      if (!exact(tool, ['type', 'function']) || tool.type !== 'function' ||
          !exact(tool.function, ['name', 'description', 'parameters', 'strict']) || !TOOL.test(tool.function.name ?? '') ||
          names.has(tool.function.name) || typeof tool.function.description !== 'string' ||
          !object(tool.function.parameters) || tool.function.parameters.type !== 'object' ||
          (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean')) reject('invalid_request');
      names.add(tool.function.name);
    }
  }
  let serialized;
  try { serialized = JSON.stringify({ ...body, stream: false }); } catch { reject('invalid_request'); }
  if (Buffer.byteLength(serialized) > maxRequestBytes) reject('request_too_large');
  return serialized;
}

function projectCompletion(value, body) {
  if (!object(value) || Object.hasOwn(value, 'error') || typeof value.id !== 'string' || value.id.length > 256 ||
      value.object !== 'chat.completion' || !Array.isArray(value.choices) || value.choices.length !== 1) reject('invalid_proxy_response');
  const choice = value.choices[0], source = choice?.message;
  if (!object(choice) || choice.index !== 0 || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) ||
      !object(source) || source.role !== 'assistant' || !(typeof source.content === 'string' || source.content === null) ||
      Object.hasOwn(source, 'error')) reject('invalid_proxy_response');
  const message = { role: 'assistant', content: source.content };
  if (source.refusal !== undefined && source.refusal !== null) {
    if (typeof source.refusal !== 'string') reject('invalid_proxy_response');
    message.refusal = source.refusal;
  }
  if (source.tool_calls !== undefined) {
    const names = new Set((body.tools ?? []).map(tool => tool.function.name));
    if (!Array.isArray(source.tool_calls) || source.tool_calls.length < 1 || source.tool_calls.length > 32) reject('invalid_proxy_response');
    message.tool_calls = source.tool_calls.map(call => {
      if (!object(call) || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id ?? '') || call.type !== 'function' ||
          !object(call.function) || !names.has(call.function.name) || typeof call.function.arguments !== 'string') reject('invalid_proxy_response');
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  if (source.content === null && !message.tool_calls && !message.refusal) reject('invalid_proxy_response');
  const result = { id: value.id, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: choice.finish_reason }] };
  if (value.created !== undefined) {
    if (!Number.isSafeInteger(value.created) || value.created < 0) reject('invalid_proxy_response');
    result.created = value.created;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || value.model.length > 256) reject('invalid_proxy_response');
    result.model = value.model;
  }
  if (value.usage !== undefined) {
    if (!object(value.usage)) reject('invalid_proxy_response');
    result.usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (value.usage[key] !== undefined) {
        if (!Number.isSafeInteger(value.usage[key]) || value.usage[key] < 0) reject('invalid_proxy_response');
        result.usage[key] = value.usage[key];
      }
    }
  }
  return result;
}

async function boundedJson(response, maxBytes, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    reject('invalid_proxy_response');
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  let cancellation;
  const cancel = () => cancellation ??= reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) reject('response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { reject('invalid_proxy_response'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    await cancel();
    reader.releaseLock();
  }
}

export function createModelRelay({ supabaseUrl, publishableKey, allowedModels = [], fetch: request = globalThis.fetch,
  timeoutMs = 60_000, maxRequestBytes = 262_144, maxResponseBytes = 131_072 } = {}) {
  const origin = new URL(supabaseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !publishableKey.startsWith('sb_publishable_') ||
      !Array.isArray(allowedModels) || allowedModels.some(model => typeof model !== 'string' || !/^[a-z][a-z0-9_-]*:[A-Za-z0-9_./:-]{1,128}$/.test(model)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000 ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 262_144 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 131_072) throw new TypeError('invalid_model_relay_config');
  const models = new Set(allowedModels);
  const endpoint = new URL('/functions/v1/llm-proxy/chat/completions', origin);
  const beginCompletion = ({ accessToken, organizationId, requestId, body, signal } = {}) => {
    let started = false, settleDrain;
    const drained = new Promise(resolve => { settleDrain = resolve; });
    const result = (async () => {
      if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 16_384 || /[\r\n]/.test(accessToken) ||
          !UUID.test(organizationId ?? '') || !UUID.test(requestId ?? '') || !signal || typeof signal.addEventListener !== 'function') reject('invalid_context');
      const serialized = validateRequest(body, models, maxRequestBytes);
      const requestSnapshot = JSON.parse(serialized);
      if (signal.aborted) reject('cancelled');
      const controller = new AbortController();
      const onAbort = () => controller.abort(new ModelRelayError('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new ModelRelayError('timeout')), timeoutMs);
      let abortListener;
      const aborted = new Promise((_, fail) => {
        abortListener = () => fail(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      try {
        const operation = async () => {
          const response = await request(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
              accept: 'application/json', 'x-organization-id': organizationId, 'x-copilot-feature': 'chat', 'x-task-id': requestId }, body: serialized });
          const value = await boundedJson(response, maxResponseBytes, controller.signal);
          if (!response.ok) {
            const code = value?.error?.code;
            reject(SAFE_PROXY_CODES.has(code) ? code : 'proxy_unavailable');
          }
          return projectCompletion(value, requestSnapshot);
        };
        // No retry or provider fallback: a lost response may already have cost.
        const work = operation();
        started = true;
        // A deadline is a result, not proof that fetch/body cancellation ended.
        // The trusted caller retains its slot/profile until drained resolves.
        void work.then(() => settleDrain(), () => settleDrain());
        const completion = await Promise.race([work, aborted]);
        if (controller.signal.aborted) throw controller.signal.reason;
        return completion;
      } catch (error) {
        if (error instanceof ModelRelayError) throw error;
        reject('proxy_unavailable'); // Never echo a provider error, request or JWT.
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', abortListener);
        controller.abort();
      }
    })();
    void result.then(() => { if (!started) settleDrain(); }, () => { if (!started) settleDrain(); });
    return Object.freeze({ result, drained: drained.then(() => undefined) });
  };
  return Object.freeze({ beginCompletion, complete(input) { return beginCompletion(input).result; } });
}
