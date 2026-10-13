#!/usr/bin/env node
// Native Linux synthetic acceptance harness for the PRODUCT wrapper/driver and
// gateway. Auth, fixed SQL RPCs and llm-proxy are in-process synthetic fixtures;
// no network fetch, provider key, service role or Zalo session is accepted.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHermesBackend } from '../infra/hermes-broker/server.mjs';
import { createDockerEngine, createContainerRuntime } from '../infra/hermes-runtime/container-driver.mjs';
import { createGatewayTransport } from '../infra/hermes-runtime/gateway-transport.mjs';
import { HERMES_IMAGE, HERMES_COMMIT, assertInputsUnchanged, assertPinnedImageInspection, runtimeUser, sourceHashes } from '../infra/hermes-runtime/runtime-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'synthetic.hermes.invalid', ORIGIN = 'https://synthetic.crm.invalid';
export const MODEL = 'openai:hermes-product-fixture';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const metadata = row => Object.fromEntries(['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds'].map(key => [key, structuredClone(row[key])]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const toolName = name => `mcp__crm__${name}`;
const FAILURE_CODES = new Set(['runtime_start_failed', 'runtime_start_timeout', 'runtime_stopped', 'runtime_stop_unproven',
  'runtime_command_failed', 'runtime_command_cancelled', 'runtime_drain_failed', 'gateway_open_failed', 'gateway_cleanup_unproven',
  'native_linux_engine_required', 'engine_inspection_failed', 'engine_operation_unknown', 'workspace_socket_path_too_long']);
export const productFailureCode = error => FAILURE_CODES.has(error?.code) ? error.code :
  FAILURE_CODES.has(error?.message) ? error.message : 'synthetic_check_failed';

// Receipt paths may be arbitrarily deep. The actual Unix socket must fit the
// unchanged product transport's 100-byte bound, so allocate its private working
// tree directly below the OS temp directory instead of inside the checkout.
export async function createProductWorkspace({ temporaryRoot = os.tmpdir(), platform = process.platform } = {}) {
  const parent = await realpath(temporaryRoot), prefix = path.join(parent, 'hp-');
  const socketPath = directory => path.join(directory, 'g', '00000000-0000-4000-8000-000000000000', 's', 'gateway.sock');
  if (platform !== 'win32' && Buffer.byteLength(socketPath(prefix + 'XXXXXX')) > 100) throw Error('workspace_socket_path_too_long');
  const directory = await mkdtemp(prefix);
  const gatewayRoot = path.join(directory, 'g'), runtimeRoot = path.join(directory, 'r');
  try {
    await chmod(directory, 0o700);
    await mkdir(gatewayRoot, { mode: 0o700 }); await mkdir(runtimeRoot, { mode: 0o700 });
    return Object.freeze({ directory, gatewayRoot, runtimeRoot });
  } catch (error) {
    // Only empty owned directories can be removed. Never recursively erase an
    // unexpected partial workspace or claim cleanup from a guessed path.
    await rmdir(gatewayRoot).catch(() => {}); await rmdir(runtimeRoot).catch(() => {});
    await rmdir(directory).catch(() => {}); throw error;
  }
}

/** In-memory DB/Auth/model wire fixtures. Real backend adapters validate, encrypt,
 * decrypt and recheck these responses. Deliberately does not claim real SQL/RLS. */
export function createSyntheticFixture() {
  const now = Date.now(), key = randomBytes(32), audits = [], events = [];
  const actors = ['A', 'B'].map((name, i) => {
    const base = (i + 1) * 100;
    const actor = { name, user: id(base + 1), org: id(base + 2), assistant: id(base + 3), connection: id(base + 4), member: id(base + 5),
      browserSession: id(base + 6), assistantSession: id(base + 7), building: id(base + 8), scope: id(base + 9), room: id(base + 10),
      email: `synthetic-${name.toLowerCase()}@example.invalid`, password: `synthetic-password-${name}`, modelCalls: 0, roomReads: 0, toolPairs: 0 };
    const jwt = session => `fixture.${Buffer.from(JSON.stringify({ sub: actor.user, role: 'authenticated', session_id: session, exp: Math.floor((now + 3_600_000) / 1000) })).toString('base64url')}.synthetic`;
    actor.browserJwt = jwt(actor.browserSession); actor.assistantJwt = jwt(actor.assistantSession);
    return actor;
  });
  const principal = { role: 'hermes_store_test', session_role: 'hermes_store_test', scoped: true, privileged_member: false,
    rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false };
  const pool = { async end() {}, async connect() {
    let count = 0;
    return { async query(query) {
      if (++count === 1) return { rows: [principal] };
      assert.equal(query.queryMode, 'extended');
      const operation = /^SELECT app_private\.hermes_store_(\w+)_v1\(\$1::jsonb\) AS result$/.exec(query.text)?.[1];
      assert(operation, 'only fixed product SQL statements');
      const input = JSON.parse(query.values[0]); let result;
      if (operation === 'activate') {
        const actor = actors.find(value => value.connection === input.connectionId); assert(actor); assert.equal(input.userId, actor.user);
        assert.equal(input.providerSessionId, actor.assistantSession); assert(!actor.joined, 'no activation retry');
        const connection = { id: actor.connection, assistantId: actor.assistant, organizationId: actor.org, userId: actor.user,
          state: 'active', epoch: 2, restrictions: limits(), scopeIds: [], tokenDigest: input.tokenDigest,
          credentialRef: input.credentialRef, expiresAt: input.tokenExpiresAt };
        actor.joined = { status: 'active', connection, session: { credentialRef: input.credentialRef, revision: 1,
          envelope: input.sessionEnvelope, expiresAt: input.sessionExpiresAt,
          binding: { assistantId: actor.assistant, organizationId: actor.org, userId: actor.user, sessionId: actor.assistantSession } },
        membership: { membershipId: actor.member, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, ...limits(), scopeIds: [] } };
        result = { ok: true, status: 'activated', connection: metadata(connection), credentialRef: input.credentialRef };
      } else if (operation === 'read_connection') {
        const actor = actors.find(value => value.joined?.connection.tokenDigest === input.tokenDigest);
        result = actor?.joined.connection.state === 'active' ? actor.joined : { status: 'unavailable' };
      } else assert.fail('unsupported fixture SQL operation');
      events.push({ type: 'sql', operation }); return { rows: [{ result: structuredClone(result) }] };
    }, release() {} };
  } };
  const fetch = async (url, options) => {
    const endpoint = new URL(url); assert.equal(endpoint.origin, 'https://synthetic.supabase.invalid');
    assert.equal(options.redirect, 'error'); assert(options.signal instanceof AbortSignal);
    const args = options.body ? JSON.parse(options.body) : undefined;
    const bearer = options.headers.authorization?.replace(/^Bearer /, '');
    if (endpoint.pathname === '/auth/v1/token') {
      assert.equal(endpoint.search, '?grant_type=password');
      const actor = actors.find(value => value.email === args.email); assert(actor); assert.equal(args.password, actor.password);
      return Response.json({ token_type: 'bearer', access_token: actor.assistantJwt,
        refresh_token: `SYNTHETIC-REFRESH-${actor.name}`, user: { id: actor.user } });
    }
    const actor = actors.find(value => bearer === value.browserJwt || bearer === value.assistantJwt);
    if (!actor) return Response.json({ error: 'synthetic unauthorized' }, { status: 401 });
    events.push({ type: 'fetch', actor: actor.name, path: endpoint.pathname });
    if (endpoint.pathname === '/auth/v1/user') return Response.json({ id: actor.user });
    if (endpoint.pathname === '/rest/v1/rpc/get_authorization_context_v1') return Response.json({ organizationId: actor.org,
      membershipId: actor.member, authorizationVersion: 1, isPlatformAdmin: false, isOffboarded: false, permissions: { 'rooms.view': true } });
    if (endpoint.pathname === '/rest/v1/rpc/get_my_organizations') return Response.json({ user_id: actor.user, organizations: [{ id: actor.org }] });
    if (endpoint.pathname === '/rest/v1/rpc/copilot_org_scope_buildings_v1') {
      assert.equal(args.p_organization_id, actor.org); assert.equal(args.p_permission_key, 'rooms.view'); return Response.json([actor.building]);
    }
    if (endpoint.pathname === '/rest/v1/rpc/hermes_prepare_connection_v1') {
      assert.equal(bearer, actor.browserJwt); assert.equal(args.p_org, actor.org);
      return Response.json({ id: actor.connection, assistantId: actor.assistant, userId: actor.user, organizationId: actor.org,
        state: 'pending', epoch: 1, restrictions: limits(), scopeIds: [], intentSecret: (actor.name === 'A' ? 'a' : 'b').repeat(64), intentExpiresAt: now + 300_000 });
    }
    assert.equal(bearer, actor.assistantJwt, 'only isolated assistant session reaches read/model adapters');
    if (endpoint.pathname === '/rest/v1/rpc/hermes_room_scope_map_v1') {
      assert.equal(args.p_organization_id, actor.org); assert.deepEqual(args.p_scope_ids, [actor.scope]);
      assert.equal(args.p_connection_id, actor.connection); assert.equal(args.p_token_digest, actor.joined.connection.tokenDigest);
      assert.equal(args.p_expected_epoch, actor.joined.connection.epoch); assert.equal(args.p_expected_policy_version, actor.joined.policy.version);
      assert.equal(args.p_expected_membership_id, actor.member); assert.equal(args.p_expected_authorization_version, 1); assert.equal(args.p_expected_session_revision, 1);
      return Response.json({ organizationId: actor.org, complete: true,
        scopes: [{ id: actor.scope, scopeType: 'BUILDING', buildingId: actor.building, areaId: null, cashbookId: null }], areaBuildings: [],
        permissionBuildingIds: [actor.building], binding: { connectionId: actor.connection, epoch: actor.joined.connection.epoch,
          policyVersion: actor.joined.policy.version, membershipId: actor.member, authorizationVersion: 1, sessionRevision: 1 } });
    }
    if (endpoint.pathname === '/rest/v1/rpc/copilot_available_rooms_v1') {
      assert.deepEqual(args, { p_organization_id: actor.org }); actor.roomReads++;
      const other = actors.find(value => value !== actor);
      const room = value => ({ id: value.room, building_id: value.building, code: `${value.name}-101`, name: `${value.name}-101`, floor: 1, area: 20,
        rent_price: 3000000, deposit_amount: 3000000, status_public: 'free', sale_state: null, sale_today: '2026-10-13',
        avail_date: null, expected_ready_on: null, contact: 'PRIVATE-CONTACT-MUST-NOT-LEAK', note: 'PRIVATE-NOTE-MUST-NOT-LEAK' });
      // Include an out-of-scope row deliberately; the real room projection must remove it.
      return Response.json({ buildings: [actor, other].map(value => ({ id: value.building, name: `House ${value.name}`, code: value.name })), rooms: [room(actor), room(other)] });
    }
    if (endpoint.pathname === '/functions/v1/llm-proxy/chat/completions') {
      assert.equal(options.headers['x-organization-id'], actor.org); assert.match(options.headers['x-task-id'], /^[a-f0-9-]{36}$/);
      assert.equal(args.model, MODEL); assert.equal(args.stream, false); assert(args.max_tokens <= 4096);
      return Response.json(modelReply(actor, actors, args));
    }
    assert.fail('unsupported synthetic HTTP endpoint');
  };
  const configuration = { supabase: { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic' },
    store: { pool, expectedRole: 'hermes_store_test' }, encryption: { activeKeyVersion: 'synthetic', keys: new Map([['synthetic', key]]) },
    http: { allowedHosts: [HOST], allowedOrigins: [ORIGIN] }, fetch, audit: async event => audits.push(structuredClone(event)) };
  return { actors, configuration, events, audits,
    grantRooms(actor) { actor.joined.connection.restrictions.read.push('rooms.view'); actor.joined.connection.scopeIds = [actor.scope];
      actor.joined.policy.read.push('rooms.view'); actor.joined.policy.scopeIds = [actor.scope]; actor.joined.policy.version++; },
    revoke(actor) { actor.joined.connection.state = 'revoked'; actor.joined.connection.epoch++; },
    dispose() { key.fill(0); } };
}

function modelReply(actor, actors, body) {
  actor.modelCalls++;
  const serialized = JSON.stringify(body), other = actors.find(value => value !== actor);
  for (const value of [other.user, other.org, other.room, other.building, `SYNTHETIC_${other.name}_PROMPT`, 'PRIVATE-CONTACT-MUST-NOT-LEAK', 'PRIVATE-NOTE-MUST-NOT-LEAK']) assert(!serialized.includes(value), 'cross-user/private model payload');
  assert.deepEqual(new Set(body.tools.map(value => value.function.name)), new Set(['crm_auth_context', 'crm_available_rooms'].map(toolName)));
  const lastUser = body.messages.findLastIndex(value => value.role === 'user'); assert(lastUser >= 0);
  assert(body.messages[lastUser].content.includes(`SYNTHETIC_${actor.name}_PROMPT`));
  const tools = body.messages.slice(lastUser + 1).filter(value => value.role === 'tool');
  let message, finish;
  if (tools.length === 0) {
    const names = ['crm_auth_context', 'crm_available_rooms'];
    message = { role: 'assistant', content: null, tool_calls: names.map((name, index) => ({ id: `call_${actor.name}_${actor.modelCalls}_${index}`, type: 'function', function: { name: toolName(name), arguments: '{}' } })) };
    finish = 'tool_calls';
  } else {
    assert.equal(tools.length, 2); const results = JSON.stringify(tools);
    assert(results.includes(actor.user)); assert(results.includes(actor.room)); assert(results.includes(`${actor.name}-101`));
    assert(!results.includes('isError":true')); actor.toolPairs++;
    message = { role: 'assistant', content: `SYNTHETIC_${actor.name}_ROOM_101_VERIFIED` }; finish = 'stop';
  }
  return { id: `synthetic_${actor.name}_${actor.modelCalls}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
    choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
}

export async function connectSynthetic(backend, actor) {
  assert(backend.server.listening);
  const body = { organizationId: actor.org, email: actor.email, password: actor.password, restrictions: limits(), scopeIds: [] };
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: backend.server.address().port, path: '/api/hermes/connections/connect', method: 'POST',
      headers: { host: HOST, origin: ORIGIN, authorization: `Bearer ${actor.browserJwt}`, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { assert.equal(res.statusCode, 200); const value = JSON.parse(Buffer.concat(chunks)); assert.match(value.token, /^hc_[A-Za-z0-9_-]{43}$/); resolve(value.token); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
}

export async function productInputFiles(root = ROOT) {
  const files = new Set(['infra/hermes-runtime/agent-process.py', 'infra/hermes-runtime/gateway-relay.mjs',
    'infra/hermes-runtime/image-provenance.json', '.github/workflows/hermes-runtime.yml', 'scripts/test-hermes-product-runtime.test.mjs']);
  const visit = async relative => {
    if (files.has(relative)) return; files.add(relative);
    const source = await readFile(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+\.(?:mjs|js|ts))['"]/g)) {
      const next = path.relative(root, path.resolve(root, path.dirname(relative), match[1])).replaceAll('\\', '/');
      assert(!next.startsWith('..')); await visit(next);
    }
  };
  await visit('scripts/test-hermes-product-runtime.mjs'); return [...files].sort();
}

function observedEngine(engine, evidence) {
  return Object.freeze(Object.fromEntries(Object.entries(engine).map(([key, method]) => [key, (...args) => {
    const work = method(...args);
    if (key === 'attachStart') { evidence.attaches++; work.once('close', () => { evidence.childCloses++; }); return work; }
    return Promise.resolve(work).then(value => {
      if (key === 'create') evidence.containers.push(value);
      if (key === 'createNetwork') evidence.networks.push(value);
      if (key === 'remove') evidence.removedContainers.push(args[0]);
      if (key === 'removeNetwork') evidence.removedNetworks.push(args[0]);
      return value;
    });
  }])));
}

export async function runProductRuntime({ mode = '--run', root = ROOT } = {}) {
  assert(['--preflight', '--run'].includes(mode));
  const out = path.join(root, '.cache', 'hermes-product', `run-${Date.now()}-${randomUUID()}`); await mkdir(out, { recursive: true, mode: 0o700 }); await chmod(out, 0o700);
  const directory = await realpath(out), receiptPath = path.join(directory, 'receipt.json');
  const inputs = await productInputFiles(root), inputSha256 = await sourceHashes(root, inputs);
  const receipt = { schemaVersion: 1, kind: 'product-runtime-synthetic', startedAt: new Date().toISOString(), mode, status: 'BLOCKED', image: HERMES_IMAGE,
    sourceCommit: HERMES_COMMIT, inputSha256, checks: [], resources: { containers: [], networks: [], removedContainers: [], removedNetworks: [], attaches: 0, childCloses: 0 },
    cleanup: { attempted: false, proven: false }, limitations: ['Synthetic Auth, fixed SQL RPC responses and model; no real CRM/RLS, paid model, provider refresh, Zalo or deployment authority.',
      'Uses actual pinned AIAgent through product wrapper, container driver, private gateway and relay. Persistent user memory and host-service orchestration are outside this check.'] };
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const check = name => { receipt.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
  let fixture, backend, gateway, runtime, workspace; const entries = [];
  // A bounded process failure never claims drain. CI runner resources are
  // disposable; leave exact allocated IDs in the receipt for explicit recovery.
  const watchdog = setTimeout(() => { receipt.status = 'FAIL'; receipt.failure = 'harness_deadline'; receipt.cleanup.proven = false;
    void save().finally(() => process.exit(1)); }, 300_000); watchdog.unref();
  try {
    receipt.stage = 'preflight'; assert.equal(process.platform, 'linux'); assert(process.getuid() > 0 && process.getgid() > 0);
    const engine = observedEngine(createDockerEngine(), receipt.resources);
    receipt.engine = await engine.preflight({ signal: new AbortController().signal }); receipt.user = runtimeUser(); check('native-linux-docker28-nonroot');
    const provenance = JSON.parse(await readFile(path.join(root, 'infra/hermes-runtime/image-provenance.json')));
    receipt.provenance = assertPinnedImageInspection(await engine.inspectImage(HERMES_IMAGE, {}), provenance); check('pinned-image-provenance');
    if (mode === '--preflight') { receipt.status = 'PREFLIGHT_ONLY'; return receipt; }
    receipt.stage = 'factories'; workspace = await createProductWorkspace();
    receipt.resources.workspace = workspace.directory;
    fixture = createSyntheticFixture(); backend = createHermesBackend(fixture.configuration);
    await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
    const { gatewayRoot, runtimeRoot } = workspace;
    const relayPath = path.join(root, 'infra/hermes-runtime/gateway-relay.mjs'), wrapperPath = path.join(root, 'infra/hermes-runtime/agent-process.py');
    const transport = createGatewayTransport({ engine, gatewayRoot, relayPath, relaySha256: hash(await readFile(relayPath)), startupTimeoutMs: 120000 });
    gateway = backend.createRuntimeGateway({ transport, allowedModels: [MODEL] });
    runtime = createContainerRuntime({ gateway, engine, runtimeRoot, wrapperPath, wrapperSha256: hash(await readFile(wrapperPath)), model: MODEL,
      maxTokens: 256, maxIterations: 4, startupTimeoutMs: 120000 });
    for (const actor of fixture.actors) {
      receipt.stage = `start-${actor.name}`; const token = await connectSynthetic(backend, actor); fixture.grantRooms(actor);
      const home = path.join(workspace.directory, `logical-home-${actor.name}`), controller = new AbortController();
      const ticket = await gateway.register(token, { home, signal: controller.signal });
      let handle;
      try { handle = runtime.prepare({ binding: { assistantId: actor.assistant, userId: actor.user, organizationId: actor.org, home }, admission: false, signal: controller.signal }); }
      catch (error) { await gateway.releaseRegistration(ticket); throw error; }
      const entry = { actor, handle, controller }; entries.push(entry); await runtime.start(handle); runtime.setAdmission(handle, true);
      check(`product-runtime-${actor.name}-started`);
    }
    const turn = async entry => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
      const pair = runtime.beginExecutePrivateCommand(entry.handle, { commandId: randomUUID(), bindingId: randomUUID(), bindingEpoch: 1,
        text: `SYNTHETIC_${entry.actor.name}_PROMPT Read my available rooms using CRM tools.` }, { signal: controller.signal });
      try { const result = await pair.result; await pair.drained; return result; }
      finally { clearTimeout(timer); await pair.drained; }
    };
    receipt.stage = 'actual-agent-tools';
    const answers = await Promise.all(entries.map(turn));
    answers.forEach((answer, index) => { assert.equal(answer.text, `SYNTHETIC_${fixture.actors[index].name}_ROOM_101_VERIFIED`); });
    for (const actor of fixture.actors) { assert.equal(actor.modelCalls, 2); assert.equal(actor.toolPairs, 1); assert.equal(actor.roomReads, 1); }
    check('actual-hermes-A-and-B-context-room-tools-answer');
    assert.equal(new Set(receipt.resources.networks).size, 2); assert.equal(new Set(receipt.resources.containers).size, 4); check('distinct-product-networks-and-containers');
    receipt.stage = 'revoke-A'; fixture.revoke(fixture.actors[0]);
    const before = fixture.actors[0].modelCalls; await assert.rejects(turn(entries[0])); assert.equal(fixture.actors[0].modelCalls, before); check('revoked-A-denied-before-model');
    const answer = await turn(entries[1]); assert.equal(answer.text, 'SYNTHETIC_B_ROOM_101_VERIFIED'); assert.equal(fixture.actors[1].modelCalls, 4); assert.equal(fixture.actors[1].toolPairs, 2);
    check('B-remains-usable-after-A-revoked');
    receipt.status = 'PASS';
  } catch (error) { receipt.status = 'FAIL'; receipt.failure = productFailureCode(error); }
  finally {
    if (fixture) {
      receipt.synthetic = fixture.actors.map(actor => ({ actor: actor.name, modelCalls: actor.modelCalls, toolPairs: actor.toolPairs, roomReads: actor.roomReads }));
      receipt.lastFixtureEvents = fixture.events.slice(-24);
      receipt.lastAuditOutcomes = fixture.audits.slice(-12).map(({ operation, outcome, code }) => ({ operation, outcome, ...(code ? { code } : {}) }));
    }
    if (mode === '--run' && backend) {
      receipt.cleanup.attempted = true;
      const stopped = await Promise.allSettled(entries.map(entry => { entry.controller.abort(); return runtime.stop(entry.handle); }));
      if (stopped.every(result => result.status === 'fulfilled')) {
        try {
          await gateway?.shutdown(); await backend.close(); fixture.dispose();
          assert.deepEqual([...receipt.resources.removedContainers].sort(), [...receipt.resources.containers].sort());
          assert.deepEqual([...receipt.resources.removedNetworks].sort(), [...receipt.resources.networks].sort());
          assert.equal(receipt.resources.childCloses, receipt.resources.attaches);
          assert.deepEqual(await readdir(workspace.gatewayRoot), []); assert.deepEqual(await readdir(workspace.runtimeRoot), []);
          await rmdir(workspace.gatewayRoot); await rmdir(workspace.runtimeRoot); await rmdir(workspace.directory);
          receipt.cleanup.proven = true; check('actual-exit-owned-container-network-directory-cleanup');
        } catch { receipt.status = 'FAIL'; receipt.cleanup.failure = 'cleanup_unproven'; }
      } else { receipt.status = 'FAIL'; receipt.cleanup.failure = 'runtime_stop_unproven'; }
    }
    try { receipt.inputSha256After = await sourceHashes(root, inputs); assertInputsUnchanged(inputSha256, receipt.inputSha256After); check('inputs-unchanged'); }
    catch { receipt.status = 'FAIL'; receipt.failure = 'inputs_changed'; }
    receipt.finishedAt = new Date().toISOString(); await save(); clearTimeout(watchdog);
  }
  console.log(`Product runtime receipt: ${path.relative(root, receiptPath)}`); return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || !['--preflight', '--run'].includes(process.argv[2])) { console.error('Usage: node scripts/test-hermes-product-runtime.mjs --preflight|--run'); process.exitCode = 1; }
  else { try { const receipt = await runProductRuntime({ mode: process.argv[2] }); if (!['PASS', 'PREFLIGHT_ONLY'].includes(receipt.status)) {
      // Never hang a failed CI check on a listener whose runtime drain is
      // unproven, and never call destructive cleanup with guessed names.
      if (receipt.cleanup.attempted && !receipt.cleanup.proven) process.exit(1);
      process.exitCode = 1;
    } }
    catch { console.error('Product runtime harness failed before receipt initialization'); process.exitCode = 1; } }
}
