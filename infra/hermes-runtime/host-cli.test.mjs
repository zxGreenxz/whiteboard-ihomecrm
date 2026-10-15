import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { isMainModule, runHermesCli } from './host-cli.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(changes = {}) {
  const signals = new EventEmitter(), events = [], codes = [], config = { dispose() { events.push('dispose'); } };
  const finished = deferred();
  const host = { finished: finished.promise, async start() { events.push('start'); await changes.start?.(); },
    async close() { events.push('close'); try { await changes.close?.(); finished.resolve(); } catch (error) { finished.reject(error); throw error; } } };
  const ports = { signals, emit: event => events.push(event), setExitCode: code => codes.push(code),
    async load() { events.push('load'); assert.equal(signals.listenerCount('SIGTERM'), 1); assert.equal(signals.listenerCount('SIGINT'), 1); await changes.load?.(); return config; },
    async createHost(value) { assert.equal(value, config); events.push('create'); await changes.create?.(); return host; } };
  return { signals, events, codes, config, host, finished, ports, run: () => runHermesCli(['--config', path.resolve('synthetic-private-config.json')], ports) };
}

test('only --config absolute path is accepted; no secret/model/env CLI overrides', async () => {
  for (const args of [[], ['--config'], ['--config', 'relative.json'], ['--config', path.resolve('x'), '--model', 'other'], ['--token', 'PRIVATE']]) {
    const f = fixture(); assert.equal(await runHermesCli(args, f.ports), 1); assert.equal(f.events.includes('load'), false);
    assert.deepEqual(f.codes, [1]); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
    assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false);
  }
});

test('signals exist before config load; early cancellation drains load and avoids constructing a host', async () => {
  const loaded = deferred(), f = fixture({ load: () => loaded.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); f.signals.emit('SIGTERM'); await tick();
  assert.equal(settled, false); assert.equal(f.events.includes('create'), false);
  loaded.resolve(); assert.equal(await run, 0); assert.equal(f.events.includes('create'), false); assert.ok(f.events.includes('dispose'));
});

test('signal during async host creation closes the late host without starting it', async () => {
  const created = deferred(), f = fixture({ create: () => created.promise }); const run = f.run(); await tick();
  f.signals.emit('SIGINT'); created.resolve(); assert.equal(await run, 0);
  assert.equal(f.events.includes('start'), false); assert.equal(f.events.filter(event => event === 'close').length, 1);
});

test('signal while startup is pending starts close immediately and awaits both actual promises', async () => {
  const startup = deferred(), drained = deferred(), f = fixture({ start: () => startup.promise, close: () => drained.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); await tick(); f.signals.emit('SIGTERM'); await tick();
  assert.ok(f.events.includes('close')); assert.equal(settled, false); startup.reject(new Error('PRIVATE startup result')); await tick();
  assert.equal(settled, false); f.signals.emit('SIGINT'); f.signals.emit('SIGTERM');
  assert.equal(f.events.filter(event => event === 'close').length, 1); assert.equal(f.signals.listenerCount('SIGINT'), 1);
  drained.resolve(); assert.equal(await run, 0); assert.equal(f.events.includes('host_ready'), false);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false); assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('running host stays alive until signal and repeated signals never force an incomplete close', async () => {
  const drained = deferred(), f = fixture({ close: () => drained.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); await tick(); assert.ok(f.events.includes('host_ready')); assert.equal(settled, false);
  f.signals.emit('SIGINT'); await tick(); f.signals.emit('SIGTERM'); assert.equal(settled, false); assert.equal(f.codes.length, 0);
  drained.resolve(); assert.equal(await run, 0); assert.equal(f.events.filter(event => event === 'close').length, 1);
});

test('ordinary startup failure is sanitized, awaits cleanup and exits nonzero', async () => {
  const drained = deferred(), f = fixture({ start: () => Promise.reject(new Error('/secret/path PRIVATE_TOKEN')), close: () => drained.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); await tick(); assert.ok(f.events.includes('close')); assert.equal(settled, false);
  drained.resolve(); assert.equal(await run, 1); assert.ok(f.events.includes('host_failed')); assert.equal(JSON.stringify(f.events).includes('PRIVATE_TOKEN'), false);
});

test('retained shutdown exits code2 with fixed metadata and does not retry close', async () => {
  const f = fixture({ close: () => Promise.reject(new Error('PRIVATE details')) }); const run = f.run(); await tick(); f.signals.emit('SIGTERM');
  assert.equal(await run, 2); assert.deepEqual(f.codes, [2]); assert.ok(f.events.includes('host_retained')); assert.equal(f.events.includes('host_stopped'), false);
  assert.equal(f.events.filter(event => event === 'close').length, 1); assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false);
});

test('host fatal completion wakes the running CLI without a signal and waits actual close', async () => {
  const drained = deferred(), f = fixture({ close: () => drained.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); await tick(); assert.ok(f.events.includes('host_ready'));
  f.finished.reject(new Error('PRIVATE listener failure')); await tick();
  assert.ok(f.events.includes('close')); assert.equal(settled, false); assert.equal(f.codes.length, 0);
  drained.resolve(); assert.equal(await run, 1); assert.ok(f.events.includes('host_failed'));
  assert.equal(f.events.filter(event => event === 'close').length, 1); assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false);
});

test('fatal completion during startup is already observed and initiates stop without abandoning pending startup', async () => {
  const starting = deferred(), drained = deferred(), f = fixture({ start: () => starting.promise, close: () => drained.promise }); let settled = false;
  const run = f.run().then(code => { settled = true; return code; }); await tick(); f.finished.reject(new Error('PRIVATE during start')); await tick();
  assert.ok(f.events.includes('close')); assert.equal(settled, false); drained.resolve(); await tick(); assert.equal(settled, false);
  starting.reject(new Error('aborted startup')); assert.equal(await run, 1); assert.equal(f.events.includes('host_ready'), false);
});

test('clean terminal completion without signal closes the CLI once, and a missing lifecycle cannot silently run', async () => {
  const f = fixture(), run = f.run(); await tick(); f.finished.resolve(); assert.equal(await run, 0);
  assert.equal(f.events.filter(event => event === 'close').length, 1);
  const bad = fixture(); delete bad.host.finished; assert.equal(await bad.run(), 1); assert.equal(bad.events.includes('start'), false);
});

test('load/factory failure disposes originals and emitter errors cannot skip cleanup', async () => {
  const f = fixture(); f.ports.createHost = () => { throw new Error('PRIVATE'); }; f.ports.emit = () => { throw new Error('output broken'); };
  assert.equal(await f.run(), 1); assert.ok(f.events.includes('dispose')); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  const other = fixture({ load: () => Promise.reject(new Error('PRIVATE loader')) }); assert.equal(await other.run(), 1);
  assert.equal(other.events.includes('create'), false); assert.equal(JSON.stringify(other.events).includes('PRIVATE'), false);
});

test('actual CLI invalid-argument process emits only fixed lifecycle JSON and exits nonzero', () => {
  const cli = fileURLToPath(new URL('./host-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--token', 'SECRET_DO_NOT_PRINT'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stderr, ''); assert.equal(result.stdout.includes('SECRET_DO_NOT_PRINT'), false);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), [{ event: 'host_failed' }, { event: 'host_stopped' }]);
});

// The VPS unit starts /opt/ihome-hermes/current/... where current/ is a link.
const here = path.dirname(fileURLToPath(import.meta.url));
/** Directory link like a release `current/`; Windows without symlink privilege
 * falls back to a junction. Cleanup removes only the link, never its target. */
function linkedDirectory(t, target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-link-')), link = path.join(root, 'current');
  let kind = null;
  for (const type of ['dir', 'junction']) {
    try { fs.symlinkSync(target, link, type); kind = type; break; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
  }
  t.after(() => {
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.rmdirSync(root);
  });
  return kind && { link, kind };
}
const runThrough = (link, file = 'host-cli.mjs') => spawnSync(process.execPath, [path.join(link, file), '--token', 'SECRET_DO_NOT_PRINT'],
  { encoding: 'utf8', timeout: 5000 });
const ran = result => result.status === 1 && result.stderr === '' &&
  JSON.stringify(result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) === JSON.stringify([{ event: 'host_failed' }, { event: 'host_stopped' }]);

test('actual CLI runs when started through a symlinked release directory', t => {
  const linked = linkedDirectory(t, here);
  if (!linked) { t.skip('neither a directory symlink nor a junction can be created on this host'); return; }
  assert.notEqual(path.join(linked.link, 'host-cli.mjs'), fs.realpathSync(path.join(linked.link, 'host-cli.mjs')));
  const result = runThrough(linked.link);
  assert.equal(ran(result), true, `CLI did not run through ${linked.kind}: status=${result.status} stdout=${JSON.stringify(result.stdout)}`);
  assert.equal(result.stdout.includes('SECRET_DO_NOT_PRINT'), false);
});

test('isMainModule compares realpaths and treats any resolution failure as not main', t => {
  const self = fileURLToPath(new URL('./host-cli.mjs', import.meta.url)), url = pathToFileURL(self).href;
  assert.equal(isMainModule(self, url), true);
  assert.equal(isMainModule(path.join(here, 'host-config.mjs'), url), false);
  for (const argv1 of [undefined, '', path.join(here, 'missing-entry.mjs')]) assert.equal(isMainModule(argv1, url), false);
  assert.equal(isMainModule(self, url, () => { throw new Error('ELOOP'); }), false);
  const linked = linkedDirectory(t, here);
  if (!linked) { t.skip('neither a directory symlink nor a junction can be created on this host'); return; }
  const viaLink = path.join(linked.link, 'host-cli.mjs');
  assert.equal(isMainModule(viaLink, url), true);
  // The previous lexical comparison misses exactly this case.
  assert.notEqual(pathToFileURL(path.resolve(viaLink)).href, url);
});

test('mutation: the previous non-realpath entry check makes the symlinked CLI silently do nothing', t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-mutant-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(here, 'host-cli.mjs'), 'utf8')
    .replace(/(from |import\()'\.\/([^']+)'/g, (_, prefix, name) => `${prefix}'${pathToFileURL(path.join(here, name)).href}'`);
  const anchor = 'if (isMainModule(process.argv[1], import.meta.url)) {';
  assert.equal(source.split(anchor).length, 2, 'mutation anchor must occur exactly once');
  for (const [name, text] of [['fixed', source], ['mutant', source.replace(anchor,
    "if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(path.resolve(process.argv[1])).href) {")]]) {
    fs.mkdirSync(path.join(stage, name)); fs.writeFileSync(path.join(stage, name, 'host-cli.mjs'), text);
  }
  const fixed = linkedDirectory(t, path.join(stage, 'fixed')), mutant = linkedDirectory(t, path.join(stage, 'mutant'));
  if (!fixed || !mutant) { t.skip('neither a directory symlink nor a junction can be created on this host'); return; }
  assert.equal(ran(runThrough(fixed.link)), true, 'staged fixed copy runs through the link');
  const result = runThrough(mutant.link);
  assert.deepEqual([ran(result), result.status, result.stdout], [false, 0, ''], 'old comparison exits 0 without running');
});
