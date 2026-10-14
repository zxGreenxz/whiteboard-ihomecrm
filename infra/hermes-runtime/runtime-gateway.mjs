import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { RuntimeModelServiceError } from '../hermes-broker/runtime-model-service.mjs';
import { GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL, groupPreviewIntent } from '../hermes-broker/group-preview-mount.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const TOOLS = new Set(['crm_auth_context', 'crm_available_rooms']);
const TOOL_NAMES = new Set([...TOOLS].map(name => `mcp__crm__${name}`));
const GROUP_TOOLS = new Set([GROUP_DIRECTORY_TOOL.name, GROUP_PREVIEW_TOOL.name, GROUP_SEND_TOOL.name, GROUP_SEND_STATUS_TOOL.name]);
const OWNER = ['assistantId', 'userId', 'organizationId'];
const IDENTITY = ['connectionId', ...OWNER, 'expiresAt'];
const VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const URLS = Object.freeze({ mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' });
const SAFE = new Set(['invalid_request', 'group_recipient_limit', 'group_room_limit', 'invalid_json', 'forbidden', 'not_found', 'method_not_allowed', 'body_too_large',
  'busy', 'inactive', 'gateway_closed', 'unknown_handle', 'unknown_ticket', 'registration_in_use', 'invalid_binding', 'invalid_identity',
  'profile_in_use', 'invalid_transport', 'transport_unknown', 'drain_failed', 'timeout', 'cancelled', 'replay',
  'model_unknown', 'round_limit', 'unauthorized', 'context_changed', 'tool_not_available', 'rate_limited', 'backend_unavailable', 'send_outcome_unknown']);
export class RuntimeGatewayError extends Error {
  constructor(code) { super(SAFE.has(code) ? code : 'backend_unavailable'); this.name = 'RuntimeGatewayError'; this.code = this.message; }
}
const fail = code => { throw new RuntimeGatewayError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function fields(value, allowed, required = allowed) {
  if (!record(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key))) fail('invalid_request');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value') || d.value === undefined) fail('invalid_request');
    Object.defineProperty(result, key, { value: d.value, enumerable: true, writable: true, configurable: true });
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid_request');
  return result;
}
function text(value, cap = 262144, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || (!empty && !value.trim()) || Buffer.byteLength(value) > cap) fail('invalid_request');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const canonical = value => JSON.stringify(value, function (_key, entry) {
  return record(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry;
});

// Validate duplicate decoded keys before JSON.parse can silently discard them.
// This scanner never evaluates input; JSON.parse supplies the remaining grammar checks.
function parseJson(buffer) {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); let i = 0;
    const space = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
    const string = () => {
      if (source[i] !== '"') throw Error(); const start = i++;
      while (i < source.length) { const c = source[i++]; if (c === '\\') i++; else if (c === '"') return JSON.parse(source.slice(start, i)); }
      throw Error();
    };
    const value = depth => {
      if (depth > 48) throw Error(); space();
      if (source[i] === '"') { string(); return; }
      if (source[i] === '{') {
        i++; space(); const names = new Set(); if (source[i] === '}') { i++; return; }
        for (;;) { space(); const key = string(); if (names.has(key)) throw Error(); names.add(key); space();
          if (source[i++] !== ':') throw Error(); value(depth + 1); space();
          const c = source[i++]; if (c === '}') return; if (c !== ',') throw Error(); }
      }
      if (source[i] === '[') { i++; space(); if (source[i] === ']') { i++; return; }
        for (;;) { value(depth + 1); space(); const c = source[i++]; if (c === ']') return; if (c !== ',') throw Error(); } }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      if (!match) throw Error(); i += match[0].length;
    };
    value(0); space(); if (i !== source.length) throw Error(); return JSON.parse(source);
  } catch { fail('invalid_json'); }
}
function toolArguments(name, input) {
  if (name === 'crm_auth_context' || name === GROUP_DIRECTORY_TOOL.name) return fields(input, []);
  if (name === GROUP_PREVIEW_TOOL.name || name === GROUP_SEND_TOOL.name) return groupPreviewIntent(input);
  if (name === GROUP_SEND_STATUS_TOOL.name) { const result = fields(input, ['dispatchId']); if (!UUID.test(result.dispatchId ?? '')) fail('invalid_request'); return result; }
  const result = fields(input, ['buildingName', 'offset', 'limit'], []);
  if (result.buildingName !== undefined) text(result.buildingName, 480);
  if (result.offset !== undefined && (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > 2000)) fail('invalid_request');
  if (result.limit !== undefined && (!positive(result.limit) || result.limit > 100)) fail('invalid_request');
  return result;
}
function calls(value, allowed = TOOL_NAMES) {
  const cap = [...allowed].some(name => GROUP_TOOLS.has(name.slice('mcp__crm__'.length))) ? 6 : 2;
  if (!Array.isArray(value) || value.length < 1 || value.length > cap) fail('invalid_request');
  const ids = new Set();
  return value.map(raw => {
    const call = fields(raw, ['id', 'type', 'function']);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(call.id ?? '') || ids.has(call.id) || call.type !== 'function') fail('invalid_request');
    ids.add(call.id); const fn = fields(call.function, ['name', 'arguments']);
    if (!allowed.has(fn.name)) fail('invalid_request'); text(fn.arguments, 16384);
    toolArguments(fn.name.slice('mcp__crm__'.length), parseJson(Buffer.from(fn.arguments)));
    return { id: call.id, type: 'function', function: fn };
  });
}
function projectModel(input, allowed = TOOL_NAMES) {
  const body = fields(input, ['model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'tools', 'tool_choice', 'stream'], ['model', 'messages']);
  // Pinned Hermes selects this OpenAI token alias for some model families.
  // Canonicalize before replay hashing; ambiguity cannot change the paid budget.
  if (Object.hasOwn(body, 'max_tokens') === Object.hasOwn(body, 'max_completion_tokens')) fail('invalid_request');
  if (Object.hasOwn(body, 'max_completion_tokens')) { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
  text(body.model, 128);
  if (!/^[a-z][a-z0-9_-]*:[A-Za-z0-9_./:-]{1,128}$/.test(body.model) || !positive(body.max_tokens) || body.max_tokens > 4096 ||
      (body.stream !== undefined && body.stream !== false) || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) fail('invalid_request');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) fail('invalid_request');
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) fail('invalid_request');
  const ids = new Set(), awaiting = new Set();
  body.messages = body.messages.map((raw, index) => {
    const message = fields(raw, ['role', 'content', 'tool_calls', 'tool_call_id'], ['role', 'content']);
    // Hermes rewrites the leading system role for GPT-5/Codex. The content is
    // still untrusted model input; this projection grants no CRM authority.
    if (message.role === 'developer') message.role = 'system';
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role) || (message.role === 'system' && index !== 0)) fail('invalid_request');
    if (!(message.role === 'assistant' && message.content === null)) text(message.content, 262144, true);
    if (message.role === 'tool') {
      if (!awaiting.delete(message.tool_call_id) || message.tool_calls !== undefined) fail('invalid_request');
    } else {
      if (awaiting.size || message.tool_call_id !== undefined) fail('invalid_request');
      if (message.tool_calls !== undefined) {
        if (message.role !== 'assistant') fail('invalid_request'); message.tool_calls = calls(message.tool_calls, allowed);
        for (const call of message.tool_calls) { if (ids.has(call.id)) fail('invalid_request'); ids.add(call.id); awaiting.add(call.id); }
      }
    }
    return message;
  });
  if (awaiting.size) fail('invalid_request');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > allowed.size) fail('invalid_request'); const names = new Set();
    body.tools = body.tools.map(raw => {
      const tool = fields(raw, ['type', 'function']); const fn = fields(tool.function, ['name', 'description', 'parameters', 'strict'], ['name', 'description', 'parameters']);
      if (tool.type !== 'function' || !allowed.has(fn.name) || names.has(fn.name) || (fn.strict !== undefined && typeof fn.strict !== 'boolean')) fail('invalid_request');
      names.add(fn.name); text(fn.description, 4096, true);
      const schema = fields(fn.parameters, ['type', 'properties', 'required', 'additionalProperties'], ['type']);
      if (schema.type !== 'object') fail('invalid_request');
      // Schemas are bounded JSON data, never a source of identity or executable tools.
      fn.parameters = schema; return { type: 'function', function: fn };
    });
  }
  body.stream = false; return freeze(body);
}
function completion(input, request) {
  const out = fields(input, ['id', 'object', 'choices', 'created', 'model', 'usage'], ['id', 'object', 'choices']);
  text(out.id, 256); if (out.object !== 'chat.completion' || !Array.isArray(out.choices) || out.choices.length !== 1) fail('invalid_request');
  const choice = fields(out.choices[0], ['index', 'message', 'finish_reason']);
  if (choice.index !== 0 || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) fail('invalid_request');
  const message = fields(choice.message, ['role', 'content', 'tool_calls', 'refusal'], ['role', 'content']);
  if (message.role !== 'assistant') fail('invalid_request'); if (message.content !== null) text(message.content, 65536, true);
  if (message.refusal !== undefined && message.refusal !== null) text(message.refusal, 32768, true);
  if (message.tool_calls !== undefined) message.tool_calls = calls(message.tool_calls, new Set((request.tools ?? []).map(tool => tool.function.name)));
  if (message.content === null && !message.tool_calls && !message.refusal) fail('invalid_request');
  if (out.model !== undefined) text(out.model, 256);
  if (out.created !== undefined && (!Number.isSafeInteger(out.created) || out.created < 0)) fail('invalid_request');
  if (out.usage !== undefined) { out.usage = fields(out.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens'], []);
    if (Object.values(out.usage).some(value => !Number.isSafeInteger(value) || value < 0)) fail('invalid_request'); }
  out.choices = [{ index: 0, message, finish_reason: choice.finish_reason }]; return freeze(out);
}
function write(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
const statusFor = code => ({ busy: 429, rate_limited: 429, timeout: 504, model_unknown: 503, backend_unavailable: 503, send_outcome_unknown: 503,
  forbidden: 403, inactive: 403, unauthorized: 401, replay: 409, body_too_large: 413, not_found: 404, method_not_allowed: 405 }[code] ?? 400);

/** Host-only per-profile capabilities. No socket, network or filesystem work in
 * register/prepare except register's authority lookup. transport.open owns its
 * resources and may not report cleanup before actual death. dependencyScope must
 * retain nested work hidden behind adapter timeouts; rejected drains retain the
 * profile. Teardown never awaits the driver or supervisor. The optional host
 * context resolver is synchronous and grants no lifecycle ownership. */
export function createRuntimeGateway({ backend, broker, modelService, transport, dependencyScope, clock = Date.now,
  resolvePrivateCommandContext, maxProfiles = 64, maxConcurrentRequests = 8, maxModelRounds = 16, timeoutMs = 30000, maxBodyBytes = 262144 } = {}) {
  if ([backend?.resolveConnection, broker?.authenticate, broker?.listTools, broker?.callTool, modelService?.beginCompletion,
    transport?.open, dependencyScope?.begin, clock].some(fn => typeof fn !== 'function') ||
    (resolvePrivateCommandContext !== undefined && typeof resolvePrivateCommandContext !== 'function') ||
    !positive(maxProfiles) || maxProfiles > 256 || !positive(maxConcurrentRequests) || maxConcurrentRequests > 16 ||
    !positive(maxModelRounds) || maxModelRounds > 16 || !positive(timeoutMs) || timeoutMs > 120000 ||
    !positive(maxBodyBytes) || maxBodyBytes > 262144) throw new TypeError('invalid_runtime_gateway_config');
  const handles = new WeakMap(), tickets = new WeakMap(), retiredTickets = new WeakSet(), entries = new Set(), homes = new Set(), owners = new Set();
  let shutting = false, shutdownWork;
  const now = () => { const time = clock(); if (!positive(time)) fail('backend_unavailable'); return time; };
  const get = handle => { const entry = handles.get(handle); if (!entry) fail('unknown_handle'); return entry; };
  const track = (entry, turn, promise) => {
    entry.pending.add(promise); turn?.pending.add(promise);
    void promise.then(() => { entry.pending.delete(promise); turn?.pending.delete(promise); }, () => { entry.failedDrain = true; });
    return promise;
  };
  const port = result => {
    const pair = fields(result, ['result', 'drained']);
    if (!(pair.result instanceof Promise) || !(pair.drained instanceof Promise)) fail('drain_failed');
    void pair.result.catch(() => {}); void pair.drained.catch(() => {}); return pair;
  };
  const live = entry => !shutting && !entry.closing && !entry.controller.signal.aborted;
  const admitted = (entry, turn) => live(entry) && entry.admission && !entry.quarantined && entry.turn === turn && turn?.active && !turn.controller.signal.aborted;
  const quarantine = entry => { entry.quarantined = true; entry.admission = false; if (entry.turn) { entry.turn.active = false; entry.turn.controller.abort(); } };
  async function bounded(entry, turn, invoke, signal, direct = false) {
    const controller = new AbortController(), combined = AbortSignal.any([entry.controller.signal, ...(signal ? [signal] : []),
      ...(turn ? [turn.controller.signal] : []), controller.signal]);
    const pair = port(direct ? invoke(combined) : dependencyScope.begin(() => invoke(combined)));
    track(entry, turn, pair.drained);
    let timer, listener;
    const interrupted = new Promise((_, reject) => {
      listener = () => reject(new RuntimeGatewayError(controller.signal.aborted ? 'timeout' : 'cancelled'));
      combined.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs); if (combined.aborted) listener();
    });
    try { const result = await Promise.race([pair.result, interrupted]); if (combined.aborted || !live(entry)) fail('cancelled'); return result; }
    finally { clearTimeout(timer); combined.removeEventListener('abort', listener); }
  }
  const drain = async promises => { const results = await Promise.allSettled([...promises]); if (results.some(result => result.status === 'rejected')) fail('drain_failed'); };
  const release = entry => { homes.delete(entry.home); if (entry.owner) owners.delete(entry.owner); entries.delete(entry); entry.token = undefined; entry.released = true; };
  async function closeEntry(entry) {
    if (entry.closeWork) return entry.closeWork;
    entry.closing = true; entry.admission = false; entry.controller.abort(); if (entry.turn) { entry.turn.active = false; entry.turn.controller.abort(); entry.turn.detach?.(); }
    entry.closeWork = (async () => {
      await entry.opening?.catch(() => {});
      // Close listeners first so stalled request bodies cannot keep draining forever.
      let transportError;
      try { if (entry.channel) await entry.channel.close(); else if (entry.openAttempted) fail('transport_unknown'); } catch { transportError = true; }
      await drain(entry.handlers); await drain(entry.pending);
      if (transportError || entry.failedDrain) fail('drain_failed');
      release(entry);
    })();
    void entry.closeWork.catch(() => {}); return entry.closeWork;
  }
  async function register(token, options) {
    const input = fields(options, ['home', 'signal'], ['home']);
    if (shutting) fail('gateway_closed');
    if (typeof token !== 'string' || !TOKEN.test(token) || typeof input.home !== 'string' || !path.isAbsolute(input.home) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) fail('invalid_binding');
    const home = path.resolve(input.home); if (homes.has(home)) fail('profile_in_use'); if (entries.size >= maxProfiles) fail('busy');
    const entry = { token, home, controller: new AbortController(), pending: new Set(), handlers: new Set(), admission: false, commandIds: new Set() };
    entries.add(entry); homes.add(home);
    try {
      const raw = await bounded(entry, null, signal => backend.resolveConnection(token, { signal }), input.signal);
      const identity = fields(raw, IDENTITY);
      if (IDENTITY.slice(0, -1).some(key => !UUID.test(identity[key] ?? '')) || !positive(identity.expiresAt) || identity.expiresAt <= now() || identity.expiresAt > now() + 900000) fail('invalid_identity');
      entry.owner = OWNER.map(key => identity[key]).join(':'); if (owners.has(entry.owner)) { entry.owner = undefined; fail('profile_in_use'); }
      owners.add(entry.owner); entry.identity = freeze(identity); const ticket = Object.freeze({}); tickets.set(ticket, entry); return ticket;
    } catch { await closeEntry(entry); fail('invalid_identity'); }
  }
  function prepare(binding) {
    const value = fields(binding, [...OWNER, 'home']);
    if (shutting || typeof value.home !== 'string' || !path.isAbsolute(value.home)) fail('invalid_binding');
    const home = path.resolve(value.home);
    const entry = [...entries].find(candidate => !candidate.prepared && candidate.identity && candidate.home === home && OWNER.every(key => candidate.identity[key] === value[key]));
    if (!entry || !live(entry) || entry.identity.expiresAt <= now()) fail('invalid_binding');
    entry.prepared = true; const handle = Object.freeze({}); handles.set(handle, entry); entry.handle = handle; return handle;
  }
  async function mcp(entry, turn, input, signal) {
    const message = fields(input, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
    // Pinned MCP 2.0.0's dispatcher stamps an empty _meta on every request,
    // even with tracing/progress disabled. It carries no authority or options.
    if (record(message.params) && Object.hasOwn(message.params, '_meta')) {
      fields(message.params._meta, []);
      message.params = Object.fromEntries(Object.entries(message.params).filter(([key]) => key !== '_meta'));
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.id !== undefined &&
      !(Number.isSafeInteger(message.id) || (typeof message.id === 'string' && message.id.length <= 128)))) fail('invalid_request');
    if (message.method === 'notifications/initialized') {
      if (message.id !== undefined) fail('invalid_request'); if (message.params !== undefined) fields(message.params, []);
      await bounded(entry, turn, () => broker.authenticate(entry.token), signal); return { status: 202 };
    }
    if (message.id === undefined) fail('invalid_request'); let result;
    if (message.method === 'initialize') {
      const params = fields(message.params, ['protocolVersion', 'capabilities', 'clientInfo']);
      if (!VERSIONS.has(params.protocolVersion)) fail('invalid_request'); fields(params.capabilities, []);
      const client = fields(params.clientInfo, ['name', 'version']); text(client.name, 128); text(client.version, 128);
      await bounded(entry, turn, () => broker.authenticate(entry.token), signal);
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ihome-hermes-private', version: '1' } };
    } else if (message.method === 'ping' || message.method === 'tools/list') {
      if (message.params !== undefined) fields(message.params, []);
      if (message.method === 'ping') { await bounded(entry, turn, () => broker.authenticate(entry.token), signal); result = {}; }
      else {
        result = fields(await bounded(entry, turn, () => broker.listTools(entry.token), signal), ['tools']);
        if (!Array.isArray(result.tools) || result.tools.length > 2 || result.tools.some(tool => !TOOLS.has(Object.getOwnPropertyDescriptor(tool, 'name')?.value)) ||
          new Set(result.tools.map(tool => tool.name)).size !== result.tools.length) fail('backend_unavailable');
        const groupDefinitions = await groupToolDefinitions(entry, turn, signal);
        result = { tools: [...result.tools, ...groupDefinitions] };
      }
    } else if (message.method === 'tools/call') {
      const params = fields(message.params, ['name', 'arguments'], ['name']);
      if (!TOOLS.has(params.name) && !GROUP_TOOLS.has(params.name)) fail('tool_not_available');
      if (GROUP_TOOLS.has(params.name)) {
        const method = params.name === GROUP_DIRECTORY_TOOL.name ? 'groupDirectory' : params.name === GROUP_SEND_TOOL.name ? 'sendGroupRooms'
          : params.name === GROUP_SEND_STATUS_TOOL.name ? 'groupSendStatus' : 'previewGroupRooms';
        if (typeof broker[method] !== 'function' || !admitted(entry, turn) || !turn.commandContext) fail('tool_not_available');
      }
      const args = toolArguments(params.name, params.arguments ?? {});
      if (GROUP_TOOLS.has(params.name)) {
        const options = { commandId: turn.commandId, signal };
        const value = params.name === GROUP_DIRECTORY_TOOL.name ? await groupDirectory(entry.handle, options)
          : params.name === GROUP_SEND_TOOL.name ? await sendGroupRooms(entry.handle, options, args)
            : params.name === GROUP_SEND_STATUS_TOOL.name ? await groupSendStatus(entry.handle, options, args.dispatchId)
              : await previewGroupRooms(entry.handle, options, args);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
      } else {
      if (params.name === 'crm_available_rooms' && !admitted(entry, turn)) fail('inactive');
      result = await bounded(entry, turn, () => broker.callTool(entry.token, params.name, freeze(args)), signal);
      if (params.name === 'crm_available_rooms' && !admitted(entry, turn)) fail('inactive');
      }
    } else fail('not_found');
    const encoded = JSON.stringify(result); if (encoded === undefined || Buffer.byteLength(encoded) > 65536) fail('backend_unavailable');
    return { status: 200, body: { jsonrpc: '2.0', id: message.id, result } };
  }
  async function handler(entry, req, res) {
    if (!live(entry) || entry.quarantined) { write(res, 503, { error: 'inactive' }); req.resume(); return; }
    if (entry.handlers.size >= maxConcurrentRequests) { write(res, 429, { error: 'busy' }); req.resume(); return; }
    const turn = entry.turn?.active ? entry.turn : null, requestController = new AbortController(); let ownsModel = false;
    const onClose = () => { if (!res.writableEnded) requestController.abort(); }; res.on('close', onClose);
    const work = (async () => {
      try {
        const headers = new Set();
        for (let i = 0; i < req.rawHeaders.length; i += 2) { const key = req.rawHeaders[i].toLowerCase(); if (headers.has(key)) fail('invalid_request'); headers.add(key); }
        if (headers.size > 32 || req.headers.host !== 'hermes-gateway:8787' || req.headers.origin !== undefined || req.headers.cookie !== undefined ||
          (req.headers.authorization !== undefined && req.headers.authorization !== 'Bearer gateway-no-credential') ||
          [...headers].some(key => /^x-(?:organization|user|assistant|connection|command|request|task)-?id$/.test(key))) fail('forbidden');
        if (!['/mcp', '/v1/chat/completions'].includes(req.url)) fail('not_found'); if (req.method !== 'POST') fail('method_not_allowed');
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] !== undefined ||
          (req.headers['mcp-protocol-version'] !== undefined && !VERSIONS.has(req.headers['mcp-protocol-version']))) fail('invalid_request');
        const cap = req.url === '/mcp' ? Math.min(maxBodyBytes, 16384) : maxBodyBytes;
        if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > cap)) fail('body_too_large');
        const chunks = []; let size = 0; const timer = setTimeout(() => { requestController.abort(); req.destroy(); }, timeoutMs);
        try { for await (const chunk of req) { size += chunk.length; if (size > cap) fail('body_too_large'); chunks.push(chunk); } } finally { clearTimeout(timer); }
        const input = parseJson(Buffer.concat(chunks)); if (!live(entry) || requestController.signal.aborted) fail('inactive');
        if (req.url === '/mcp') {
          const result = await mcp(entry, turn, input, requestController.signal); write(res, result.status, result.body); return;
        }
        if (!admitted(entry, turn)) fail('inactive');
        const groupDefinitions = await groupToolDefinitions(entry, turn, requestController.signal);
        const allowed = new Set([...TOOL_NAMES, ...groupDefinitions.map(tool => `mcp__crm__${tool.name}`)]);
        if (!admitted(entry, turn)) fail('inactive'); const body = projectModel(input, allowed);
        const digest = createHash('sha256').update(canonical(body)).digest('hex');
        if (turn.fingerprints.has(digest)) fail('replay'); if (turn.modelBusy) fail('busy');
        if (turn.fingerprints.size >= maxModelRounds) fail('round_limit'); turn.fingerprints.add(digest); turn.modelBusy = true; ownsModel = true;
        try {
          const result = await bounded(entry, turn, signal => modelService.beginCompletion({ token: entry.token, requestId: randomUUID(), body, signal }), requestController.signal, true);
          if (!admitted(entry, turn)) fail('inactive'); const value = completion(result, body);
          if (Buffer.byteLength(JSON.stringify(value)) > 131072) fail('invalid_request'); write(res, 200, value);
        } catch (error) {
          // Only our trusted service's classified failures prove that no unknown
          // paid operation remains. A third-party error.code is not such proof.
          if (error instanceof RuntimeModelServiceError && ['busy', 'forbidden', 'invalid_request', 'unauthorized', 'context_changed', 'closed'].includes(error.code))
            fail(error.code === 'closed' ? 'inactive' : error.code);
          quarantine(entry); fail('model_unknown');
        }
      } catch (error) {
        const code = SAFE.has(error?.code) ? error.code : 'backend_unavailable'; write(res, statusFor(code), { error: code }); req.resume();
      } finally {
        // Public HTTP response/deadline does not end ownership of nested work.
        await drain(turn ? turn.pending : entry.pending);
        if (ownsModel) turn.modelBusy = false;
        res.off('close', onClose);
      }
    })();
    entry.handlers.add(work); if (turn) turn.handlers.add(work);
    void work.then(() => { entry.handlers.delete(work); turn?.handlers.delete(work); }, () => { entry.failedDrain = true; quarantine(entry); });
    return work;
  }
  function start(handle, options = {}) {
    const entry = get(handle), input = fields(options, ['signal'], []);
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('invalid_request');
    if (!live(entry) || entry.quarantined) fail('inactive'); if (entry.opening) return entry.opening;
    entry.openAttempted = true;
    entry.opening = (async () => {
      // Attach before awaiting, and retain the actual open result even after abort.
      // Persistent server callbacks must not inherit a completed per-request ALS
      // dependency scope. The open promise itself is owned until actual settle.
      const opening = Promise.resolve().then(() => transport.open({ handler: (req, res) => { void handler(entry, req, res).catch(() => {}); },
        signal: AbortSignal.any([entry.controller.signal, ...(input.signal ? [input.signal] : [])]) }));
      const pair = { result: opening, drained: opening.then(() => undefined, () => undefined) };
      track(entry, null, pair.drained);
      const raw = await pair.result; const channel = fields(raw, ['descriptor', 'close']);
      if (typeof channel.close !== 'function') fail('invalid_transport'); entry.channel = channel;
      const descriptor = fields(channel.descriptor, ['networkName', 'networkId', 'mcpUrl', 'modelBaseUrl']);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(descriptor.networkName ?? '') || !/^[a-f0-9]{64}$/.test(descriptor.networkId ?? '') ||
        descriptor.mcpUrl !== URLS.mcpUrl || descriptor.modelBaseUrl !== URLS.modelBaseUrl) fail('invalid_transport');
      if (!live(entry) || input.signal?.aborted) fail('cancelled'); entry.started = true; return freeze(descriptor);
    })();
    void entry.opening.catch(() => { quarantine(entry); }); return entry.opening;
  }
  function endTurn(handle, input) {
    const entry = get(handle), value = fields(input, ['commandId']); const turn = entry.turn;
    if (!turn || turn.commandId !== value.commandId) fail('invalid_request');
    turn.active = false; turn.controller.abort(); turn.detach?.();
    if (!turn.ending) { turn.ending = (async () => { await drain(turn.handlers); await drain(turn.pending); if (entry.failedDrain) fail('drain_failed');
      if (entry.turn === turn) entry.turn = undefined; })(); void turn.ending.catch(() => {}); }
    return turn.ending;
  }
  async function releaseRegistration(ticket) {
    if (retiredTickets.has(ticket)) return;
    const entry = tickets.get(ticket); if (!entry) fail('unknown_ticket');
    // A consumed registration belongs to the runtime. Its supervisor/driver must
    // prove actual stop and call close first; this API cannot stop it indirectly.
    if (entry.prepared && !entry.released) fail('registration_in_use');
    if (!entry.prepared) await closeEntry(entry);
    if (!entry.released) fail('drain_failed');
    tickets.delete(ticket); retiredTickets.add(ticket);
  }
  const contextFor = (entry, turn) => {
    if (!admitted(entry, turn) || !turn.commandContext || !resolvePrivateCommandContext) fail('inactive');
    const value = fields(resolvePrivateCommandContext(turn.commandContext, Object.freeze({ token: entry.token,
      ...Object.fromEntries(['connectionId', ...OWNER].map(key => [key, entry.identity[key]])),
      home: entry.home, commandId: turn.commandId })), ['commandId', 'claimId']);
    if (value.commandId !== turn.commandId || !UUID.test(value.claimId ?? '')) fail('context_changed');
    return freeze(value);
  };
  // Trusted host seam. Private model tools below derive their context here;
  // no request field can provide token, identity or dispatch claim.
  // The callback runs inside the same actual dependency scope as normal tools.
  const withPrivateCommandContext = (handle, raw, invoke) => {
    const entry = get(handle), input = fields(raw, ['commandId', 'signal']), turn = entry.turn;
    if (typeof invoke !== 'function' || !(input.signal instanceof AbortSignal) || input.signal.aborted ||
        !turn || input.commandId !== turn.commandId || !admitted(entry, turn)) fail('inactive');
    if (turn.handlers.size >= maxConcurrentRequests) fail('busy');
    const result = bounded(entry, turn, signal => invoke(Object.freeze({ token: entry.token,
      commandContext: contextFor(entry, turn), signal })), input.signal).then(value => {
      contextFor(entry, turn); return value;
    });
    // An ordinary callback error is not a failed drain. The observer may reject
    // now; the separate owned promise waits for every tracked dependency.
    const owned = result.then(() => undefined, () => undefined).then(() => drain(turn.pending));
    turn.handlers.add(owned); entry.handlers.add(owned);
    void owned.then(() => { turn.handlers.delete(owned); entry.handlers.delete(owned); }, () => {
      entry.failedDrain = true; quarantine(entry);
    });
    return result;
  };
  function groupDirectory(handle, raw) {
    if (typeof broker.groupDirectory !== 'function') fail('tool_not_available');
    return withPrivateCommandContext(handle, raw, ({ token, commandContext, signal }) =>
      broker.groupDirectory(token, commandContext, { signal }));
  }
  function previewGroupRooms(handle, raw, intent) {
    if (typeof broker.previewGroupRooms !== 'function') fail('tool_not_available');
    return withPrivateCommandContext(handle, raw, ({ token, commandContext, signal }) =>
      broker.previewGroupRooms(token, commandContext, intent, { signal }));
  }
  function groupSendStatus(handle, raw, dispatchId) {
    if (typeof broker.groupSendStatus !== 'function') fail('tool_not_available');
    return withPrivateCommandContext(handle, raw, ({ token, commandContext, signal }) =>
      broker.groupSendStatus(token, commandContext, dispatchId, { signal }));
  }
  async function sendGroupRooms(handle, raw, intent) {
    if (typeof broker.sendGroupRooms !== 'function') fail('tool_not_available');
    const entry = get(handle), turn = entry.turn;
    if (!turn || !admitted(entry, turn)) fail('inactive');
    const input = fields(raw, ['commandId', 'signal']);
    if (input.commandId !== turn.commandId || !(input.signal instanceof AbortSignal) || input.signal.aborted) fail('inactive');
    contextFor(entry, turn);
    const savedReceipt = status => {
      contextFor(entry, turn);
      if (!UUID.test(turn.sendDispatchId ?? '')) fail('send_outcome_unknown');
      return freeze({ status, dispatchId: turn.sendDispatchId });
    };
    if (turn.sendUnknown) return savedReceipt('unknown');
    if (turn.sendPending) fail('busy');
    // A successful DB ACK can still be lost on the private MCP response. Keep
    // its opaque correlation without claiming that a changed selection ran.
    // The status tool rechecks current authority before releasing any details.
    if (turn.sendAttempted) return savedReceipt('existing_dispatch');
    let uncertain = false; turn.sendPending = true;
    try { return await withPrivateCommandContext(handle, raw, ({ token, commandContext, signal }) =>
      broker.sendGroupRooms(token, commandContext, intent, { signal,
        onDispatch(dispatchId) { uncertain = true; turn.sendAttempted = true;
          if (!UUID.test(dispatchId ?? '')) fail('backend_unavailable'); turn.sendDispatchId = dispatchId; },
        onRejected() { uncertain = false; if (!turn.sendUnknown) turn.sendAttempted = false; },
      }));
    } catch (error) {
      if (uncertain || error?.code === 'send_outcome_unknown') { turn.sendUnknown = true; return savedReceipt('unknown'); }
      throw error;
    } finally { turn.sendPending = false; }
  }
  async function groupToolDefinitions(entry, turn, signal) {
    if (!admitted(entry, turn) || !turn.commandContext || !resolvePrivateCommandContext ||
        typeof broker.listGroupTools !== 'function') return [];
    try {
      const result = fields(await withPrivateCommandContext(entry.handle, { commandId: turn.commandId, signal },
        ({ token, commandContext, signal: innerSignal }) => broker.listGroupTools(token, commandContext, { signal: innerSignal })), ['tools']);
      if (!Array.isArray(result.tools) || result.tools.length > GROUP_TOOLS.size ||
          result.tools.some(tool => !GROUP_TOOLS.has(Object.getOwnPropertyDescriptor(tool ?? {}, 'name')?.value)) ||
          new Set(result.tools.map(tool => tool.name)).size !== result.tools.length) fail('backend_unavailable');
      return result.tools;
    }
    catch {
      // Optional rollout, capability or RPC failure never enables group tools.
      // A removed trusted turn still fails the request instead of falling back.
      contextFor(entry, turn); return [];
    }
  }
  return Object.freeze({ register, releaseRegistration, prepare, start, endTurn, withPrivateCommandContext,
    // Host-only composition endpoint. It cannot accept a token/claim from model
    // input. Missing service, inactive turn or unacknowledged claim denies.
    previewGroupRooms, groupDirectory, sendGroupRooms, groupSendStatus,
    unregister(ticket) { const entry = tickets.get(ticket); if (!entry || entry.prepared) fail('unknown_ticket'); tickets.delete(ticket); return closeEntry(entry); },
    setAdmission(handle, allowed) {
      const entry = get(handle); if (typeof allowed !== 'boolean') fail('invalid_request');
      if (allowed && (!live(entry) || !entry.started || entry.quarantined)) fail('inactive'); entry.admission = allowed;
      if (!allowed && entry.turn) { entry.turn.active = false; entry.turn.controller.abort(); }
    },
    beginTurn(handle, input) {
      const entry = get(handle), value = fields(input, ['commandId', 'signal', 'commandContext'], ['commandId']);
      if (!UUID.test(value.commandId ?? '') || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) fail('invalid_request');
      if (!live(entry) || !entry.started || !entry.admission || entry.quarantined || value.signal?.aborted) fail('inactive');
      if (entry.turn) fail('busy'); if (entry.commandIds.has(value.commandId)) fail('replay'); if (entry.commandIds.size >= 1024) fail('round_limit');
      if (value.commandContext !== undefined && (!resolvePrivateCommandContext || value.commandContext === null ||
          typeof value.commandContext !== 'object' || !Object.isFrozen(value.commandContext) || Reflect.ownKeys(value.commandContext).length)) fail('invalid_request');
      entry.commandIds.add(value.commandId); const controller = new AbortController();
      const turn = { commandId: value.commandId, commandContext: value.commandContext, controller, active: true, fingerprints: new Set(), pending: new Set(), handlers: new Set(), modelBusy: false };
      if (value.signal) { const abort = () => { turn.active = false; controller.abort(); }; value.signal.addEventListener('abort', abort, { once: true });
        turn.detach = () => value.signal.removeEventListener('abort', abort); }
      entry.turn = turn;
      if (value.commandContext !== undefined) {
        try { contextFor(entry, turn); }
        catch { turn.active = false; controller.abort(); turn.detach?.(); entry.turn = undefined; fail('context_changed'); }
      }
    },
    close(handle) { return closeEntry(get(handle)); },
    shutdown() { if (!shutdownWork) { shutting = true; shutdownWork = Promise.all([...entries].map(closeEntry)).then(() => undefined); void shutdownWork.catch(() => {}); } return shutdownWork; },
  });
}
