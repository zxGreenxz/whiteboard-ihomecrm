#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFixtureBroker } from '../hermes-broker/fixture.mjs';
import { createMcpHttpServer } from '../hermes-broker/mcp-http.mjs';
import { startRuntimeFixture } from './fixture-server.mjs';
import { assertHermesDenial, assertInputsUnchanged, assertMcpDenial, HERMES_COMMIT, RESULT_PREFIX, sourceHashes } from './runtime-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--python' || args[2] !== '--upstream') throw new Error('Expected --python <private venv python> --upstream <pinned source>');
const python = path.resolve(args[1]); const upstream = path.resolve(args[3]);
const exec = promisify(execFile);
const out = path.join(root, '.cache', 'hermes-p1', `transport-${Date.now()}-${randomBytes(3).toString('hex')}`);
await mkdir(out, { recursive: true });
const inputFiles = ['infra/hermes-runtime/transport-compat.mjs', 'infra/hermes-runtime/transport-probe.py',
  'infra/hermes-runtime/runtime-contract.mjs', 'infra/hermes-runtime/requirements-transport-win-py312.lock',
  'infra/hermes-runtime/fixture-server.mjs', 'infra/hermes-runtime/fake-model.mjs',
  'infra/hermes-broker/broker.mjs', 'infra/hermes-broker/stores.mjs',
  'infra/hermes-broker/mcp-http.mjs', 'infra/hermes-broker/fixture.mjs'];
const receipt = { schemaVersion: 1, scope: 'Real upstream Hermes MCP client compatibility; synthetic loopback broker only',
  sourceCommit: HERMES_COMMIT, startedAt: new Date().toISOString(), status: 'FAILED', checks: [],
  inputSha256: await sourceHashes(root, inputFiles),
  limitations: ['No AIAgent/model execution, container isolation, TLS/OAuth, live CRM/RLS or Zalo.',
    'Private Python 3.12 compatibility environment differs from the pinned image runtime.'] };
let service;
const clients = [];
const record = (name) => { receipt.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };

class Client {
  constructor(actor, url) {
    this.actor = actor; this.pending = new Map(); this.sequence = 0; this.logs = ''; this.results = [];
    const home = path.join(out, `home-${actor}`);
    // Deliberately do not forward the host's provider credentials or default Hermes home.
    const env = { SYSTEMROOT: process.env.SYSTEMROOT ?? '', SystemRoot: process.env.SystemRoot ?? '',
      WINDIR: process.env.WINDIR ?? '', PATH: path.dirname(python),
      HERMES_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'Local'), TEMP: out, TMP: out,
      PYTHONPATH: upstream, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
      NO_PROXY: '127.0.0.1,localhost', HERMES_INTERACTIVE: '0' };
    this.child = spawn(python, [path.join(root, 'infra/hermes-runtime/transport-probe.py'), path.join(out, `${actor}.json`), url],
      { cwd: upstream, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code) => this.rejectAll(new Error(`Hermes client ${actor} exited (${code})`)));
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'); const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        if (!line.startsWith(RESULT_PREFIX)) { this.logs = (this.logs + line + '\n').slice(-80_000); continue; }
        try {
          const result = JSON.parse(line.slice(RESULT_PREFIX.length));
          const pending = this.pending.get(result.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(result.id); result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error)); }
          else this.results.push(result);
        } catch (error) { this.rejectAll(error); }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.logs = (this.logs + chunk.toString()).slice(-80_000); });
  }
  rejectAll(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  wait(id) {
    const result = this.results.find((value) => value.id === id);
    if (result) return result.ok ? Promise.resolve(result.result) : Promise.reject(new Error(result.error));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes client ${this.actor} response timeout`)); }, 40_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  call(name = 'mcp__crm__crm_auth_context', args = {}) {
    const id = ++this.sequence; const result = this.wait(id);
    this.child.stdin.write(JSON.stringify({ id, name, arguments: args }) + '\n');
    return result;
  }
  async stop() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5_000);
    await this.closed; clearTimeout(timer);
    await writeFile(path.join(out, `${this.actor}.log`), this.logs);
  }
}

try {
  const { stdout: head } = await exec('git', ['-C', upstream, 'rev-parse', 'HEAD'], { windowsHide: true });
  assert.equal(head.trim(), HERMES_COMMIT);
  const { stdout: dirty } = await exec('git', ['-C', upstream, 'status', '--porcelain'], { windowsHide: true });
  assert.equal(dirty.trim(), '', 'Upstream checkout is modified');
  const { stdout: packages } = await exec(python, ['-m', 'pip', '--disable-pip-version-check', 'freeze'], { windowsHide: true });
  receipt.dependencies = packages.trim().split(/\r?\n/);
  assert.ok(receipt.dependencies.includes('mcp==2.0.0'));
  const fixture = await createFixtureBroker();
  service = await startRuntimeFixture({ fixture, createMcpHttpServer, outputDir: out, port: 0, adminPort: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${service.server.address().port}/mcp`;
  const a = new Client('a', url); clients.push(a);
  const b = new Client('b', url); clients.push(b);
  for (const client of clients) assert.deepEqual((await client.wait(0)).tools, ['mcp__crm__crm_auth_context']);
  record('upstream-hermes-mcp-handshake-and-tool-discovery-A-B');
  for (const client of clients) {
    const value = await client.call();
    const own = fixture.connections[client.actor].connection;
    const foreign = fixture.connections[client.actor === 'a' ? 'b' : 'a'].connection;
    assert.ok(String(value).includes(own.userId)); assert.ok(String(value).includes(own.organizationId));
    assert.ok(!String(value).includes(foreign.userId));
  }
  record('actual-hermes-dispatch-preserves-bearer-actor-org');
  assertHermesDenial(await a.call('terminal', { command: 'printf NOT_ALLOWED' }), 'unknown_terminal');
  assertHermesDenial(await a.call('mcp__crm__crm_auth_context', { userId: fixture.connections.b.connection.userId }), 'invalid_request');
  record('unregistered-tool-and-identity-injection-denied');
  await fixture.broker.revokeConnection(fixture.connections.a.connection.id);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${fixture.connections.a.token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'crm_auth_context', arguments: {} } }) });
  assertMcpDenial({ status: response.status, body: await response.json() }, 'unauthorized');
  const beforeRevokedCall = service.stats.mcpCalls.length;
  const revoked = String(await a.call());
  assert.ok(!revoked.includes(fixture.connections.a.connection.userId));
  const observedHttp = service.stats.mcpCalls.slice(beforeRevokedCall);
  assertHermesDenial(revoked, 'unauthorized', observedHttp);
  receipt.revocationTransport = { observedHttp, structuredReauthSignal: JSON.parse(revoked).needs_reauth === true };
  if (!receipt.revocationTransport.structuredReauthSignal) {
    receipt.limitations.push('Pinned MCP 2.0 client flattens HTTP 401 into generic MCPError; denial evidence uses the fixture-observed HTTP responses of that same call.');
  }
  assert.ok(String(await b.call()).includes(fixture.connections.b.connection.userId));
  record('revoked-hermes-client-denied-other-client-still-authorized');
  receipt.status = 'PASSED_TRANSPORT_COMPATIBILITY_ONLY';
} catch (error) {
  receipt.error = error.message; process.exitCode = 1; console.error(error.message);
} finally {
  for (const client of clients) await client.stop();
  if (service) await service.close();
  try {
    receipt.inputSha256After = await sourceHashes(root, inputFiles);
    assertInputsUnchanged(receipt.inputSha256, receipt.inputSha256After);
    const { stdout: head } = await exec('git', ['-C', upstream, 'rev-parse', 'HEAD'], { windowsHide: true });
    const { stdout: dirty } = await exec('git', ['-C', upstream, 'status', '--porcelain'], { windowsHide: true });
    assert.equal(head.trim(), HERMES_COMMIT); assert.equal(dirty.trim(), '');
    receipt.inputsUnchanged = true;
  } catch {
    receipt.inputsUnchanged = false; receipt.status = 'FAILED'; process.exitCode = 1;
    receipt.inputError = 'Fixture or upstream source changed or became unreadable during the run';
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Receipt: ${path.relative(root, path.join(out, 'receipt.json'))}`);
}
