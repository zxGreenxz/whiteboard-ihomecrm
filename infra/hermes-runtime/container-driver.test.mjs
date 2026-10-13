import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createContainerRuntime, createDockerEngine } from './container-driver.mjs';
import { GATEWAY_URLS, RUNTIME_ENV, RUNTIME_TMPFS, buildContainerArgs } from './container-contract.mjs';
import { HERMES_IMAGE, HERMES_COMMIT, NO_FORWARDING, PRIVATE_DNS, DNS_OPTIONS, ISOLATED_GATEWAY_OPTIONS, runtimeUser } from './runtime-contract.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wait = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) {
  if (Date.now() >= deadline) throw Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const command = (n = 1) => ({ commandId: id(10 + n), bindingId: id(4), bindingEpoch: 1, text: 'Phòng trống?' });
const childSource = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
if (mode !== 'no-ready') emit({event:'ready',version:1});
readline.createInterface({input:process.stdin}).on('line', line => {
  const value=JSON.parse(line);
  if (value.op==='shutdown') { if (!mode.endsWith('ignore-shutdown')) process.exit(0); return; }
  if (value.op==='turn') {
    if (mode==='hang'||mode==='ignore-shutdown') return;
    if (mode==='duplicate-keys') { process.stdout.write('{"event":"result","event":"result","commandId":"'+value.commandId+'","text":"PRIVATE"}\n'); return; }
    if (mode==='foreign-id'||mode==='foreign-id-ignore-shutdown') { emit({event:'result',commandId:'10000000-0000-4000-8000-999999999999',text:'PRIVATE'}); return; }
    if (mode==='oversize') { process.stdout.write('x'.repeat(65537)); return; }
    if (mode==='extra-field') { emit({event:'result',commandId:value.commandId,text:'PRIVATE',userId:'fake'}); return; }
    emit({event:'result',commandId:value.commandId,text:'Echo '+value.text});
  }
});`;

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-container-driver-'));
  const root = path.join(directory, 'runtime'), logicalHome = path.join(directory, 'legacy-home'), wrapperPath = path.join(directory, 'wrapper.py');
  await mkdir(logicalHome); await writeFile(path.join(logicalHome, '.env'), 'PRIVATE_LEGACY_CREDENTIAL');
  const bytes = Buffer.from('# trusted wrapper fixture\n'); await writeFile(wrapperPath, bytes);
  const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8'));
  const image = { Id: provenance.expectedConfigDigest, RepoDigests: [HERMES_IMAGE], Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': HERMES_COMMIT }, Env: ['PATH=/upstream/bin', 'HERMES_HOME=/opt/data'] } };
  const descriptor = Object.freeze({ networkName: 'ihome-private-test', networkId: 'b'.repeat(64), ...GATEWAY_URLS });
  const binding = Object.freeze({ assistantId: id(1), userId: id(2), organizationId: id(3), ...changes.binding, home: logicalHome });
  const events = [], gates = [], children = []; let child, spec, running = false, created = false, containerId = 'c'.repeat(64), attachCount = 0;
  const expectedInspection = () => ({ Id: containerId, Name: '/'+spec.name, Image: image.Id,
    Config: { Image: HERMES_IMAGE, Labels: { 'ihome.hermes.instance': spec.instanceId, 'ihome.hermes.role': 'runtime' },
      User: spec.user, OpenStdin: true, Tty: false, Entrypoint: ['/opt/hermes/.venv/bin/python'], Cmd: ['/run/agent-process.py', '/run/bootstrap.json'],
      WorkingDir: '/opt/hermes', Env: [...new Map([...image.Config.Env.map(value => value.split(/=(.*)/s).slice(0, 2)), ...Object.entries(RUNTIME_ENV)])].map(([key,value])=>`${key}=${value}`) },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'],
      LogConfig: { Type: 'none' }, NetworkMode: descriptor.networkName, PortBindings: {}, PublishAllPorts: false, Sysctls: NO_FORWARDING,
      Dns: PRIVATE_DNS, DnsOptions: DNS_OPTIONS, Tmpfs: RUNTIME_TMPFS, PidsLimit:256, Memory:1536*1024*1024, NanoCpus:1_000_000_000,
      RestartPolicy: {Name:'no'}, AutoRemove:false, IpcMode:'private', PidMode:'', Devices:[], DeviceRequests:[], ExtraHosts:[] },
    NetworkSettings: { Networks: { [descriptor.networkName]: { NetworkID:descriptor.networkId } } },
    Mounts: [['/opt/data',spec.home,true],['/run/bootstrap.json',spec.bootstrap,false],['/run/agent-process.py',spec.wrapper,false]]
      .map(([Destination,Source,RW]) => ({Type:'bind',Destination,Source,RW,Propagation:'rprivate'})),
    State: {Running:running,Dead:false,Restarting:false,Status:running?'running':attachCount?'exited':'created'},
  });
  const gateway = {
    prepare(value) { events.push('prepare'); assert.deepEqual(value, binding); return Object.freeze({}); },
    async start(_handle,{signal}) { events.push('gateway-start'); assert(signal instanceof AbortSignal); return changes.descriptor ?? descriptor; },
    setAdmission(_handle, value) { gates.push(value); events.push('gate-'+value); if (changes.gateFailure && value===false) throw Error('PRIVATE-GATE'); },
    beginTurn(_handle, value) { events.push('begin'); assert.equal(typeof value.commandId,'string'); assert(value.signal instanceof AbortSignal); },
    async endTurn() { events.push('end'); await changes.endTurnWait?.promise; if (changes.endFailure) throw Error('PRIVATE-END'); events.push('end-drained'); },
    async close() { events.push('gateway-close'); await changes.gatewayCloseWait?.promise; },
  };
  const engine = {
    async preflight() { events.push('preflight'); return changes.host ?? {os:'linux',version:'28.3.0',nativeHost:true}; },
    async inspectImage() { events.push('image'); return changes.image ?? image; },
    async inspectNetwork() { events.push('network'); return {Id:descriptor.networkId,Name:descriptor.networkName,Driver:'bridge',Internal:true,EnableIPv6:true,
      Options:ISOLATED_GATEWAY_OPTIONS,IPAM:{Config:[{Subnet:'172.30.0.0/24'},{Subnet:'fd00:1::/64'}]}}; },
    async create(args) { events.push('create');
      const value = key => args[args.indexOf(key)+1]; const mounts = args.filter((_v,i)=>args[i-1]==='--mount');
      const source = destination => mounts.find(v=>v.includes(`dst=${destination}`)).match(/src=(.*?),dst=/)[1];
      const labels=args.filter((_v,i)=>args[i-1]==='--label');
      spec={name:value('--name'),instanceId:labels.find(v=>v.startsWith('ihome.hermes.instance=')).split('=')[1],user:value('--user'),
        home:source('/opt/data'),bootstrap:source('/run/bootstrap.json'),wrapper:source('/run/agent-process.py'),...descriptor};
      assert.deepEqual(args, buildContainerArgs(spec)); created=true;
      await changes.createWait?.promise; if(changes.createFailure) throw Error('PRIVATE-CREATE'); return containerId; },
    attachStart() { events.push('attach'); attachCount++; running=true;
      child=spawn(process.execPath,['-e',childSource,changes.mode??'normal'],{windowsHide:true,stdio:['pipe','pipe','pipe']}); children.push(child);
      child.once('close',()=>{running=false;events.push('child-close');}); return child; },
    async inspectContainer() { events.push('inspect'); await changes.inspectWait?.promise; const result=structuredClone(expectedInspection()); changes.mutateInspection?.(result); return result; },
    async kill() { events.push('kill'); if(changes.killFailure) throw Error('PRIVATE-KILL'); if(changes.lingeringTransport){running=false;return;} child?.kill(); },
    async wait() { events.push('wait'); if(changes.lingeringTransport)return 137;
      if(child && child.exitCode===null && child.signalCode===null) await once(child,'close'); return child?.exitCode??137; },
    async remove() { events.push('remove'); if(changes.removeFailure) throw Error('PRIVATE-REMOVE'); created=false; },
  };
  const controller = new AbortController();
  const runtime = createContainerRuntime({gateway,engine,runtimeRoot:root,wrapperPath,wrapperSha256:createHash('sha256').update(bytes).digest('hex'),
    model:'fixture:model',user:runtimeUser(),stopGraceMs:25,startupTimeoutMs:changes.startupTimeoutMs??2000,...(changes.timers?{timers:changes.timers}:{})});
  const handle=runtime.prepare({binding,admission:false,signal:controller.signal});
  t.after(async()=>{ changes.createWait?.resolve(); changes.inspectWait?.resolve(); changes.endTurnWait?.resolve(); changes.gatewayCloseWait?.resolve();
    for (const proc of children) if(proc.exitCode===null && proc.signalCode===null) {proc.kill(); await once(proc,'close');}
    await runtime.stop(handle).catch(()=>{}); await rm(directory,{recursive:true,force:true}); });
  return {runtime,handle,events,gates,controller,root,logicalHome,binding,descriptor,engine,gateway,image,
    spec:()=>spec,child:()=>child,created:()=>created,async start(){await runtime.start(handle);runtime.setAdmission(handle,true);},
    send:(value=command(),signal=new AbortController().signal)=>runtime.executePrivateCommand(handle,value,{signal})};
}

test('prepare is inert; actual ready and exact inspection precede admission; bootstrap/home contain no legacy credential', async t => {
  const f=await fixture(t); assert.deepEqual(f.events,['prepare']); await assert.rejects(readFile(f.root),/ENOENT/);
  assert.throws(()=>f.runtime.setAdmission(f.handle,true),/runtime_not_ready/); await f.start();
  assert(f.events.indexOf('inspect')<f.events.lastIndexOf('gate-true'));
  const spec=f.spec(),boot=JSON.parse(await readFile(spec.bootstrap,'utf8'));
  assert.deepEqual(Object.keys(boot).sort(),['version','assistantId','userId','organizationId','mcpUrl','modelBaseUrl','model','maxTokens','maxIterations'].sort());
  assert.equal(boot.userId,f.binding.userId); assert.equal(boot.mcpUrl,GATEWAY_URLS.mcpUrl); assert.notEqual(spec.home,f.logicalHome);
  assert.deepEqual(await readdir(spec.home),[]); assert.equal(await readFile(path.join(f.logicalHome,'.env'),'utf8'),'PRIVATE_LEGACY_CREDENTIAL');
  assert.deepEqual(await f.send(),{text:'Echo Phòng trống?'}); await f.runtime.stop(f.handle);
  assert(f.events.indexOf('child-close')<f.events.indexOf('remove')); assert(f.events.indexOf('remove')<f.events.indexOf('gateway-close'));
  await assert.rejects(readFile(spec.bootstrap),/ENOENT/); assert.equal(await readFile(path.join(f.logicalHome,'.env'),'utf8'),'PRIVATE_LEGACY_CREDENTIAL');
});

test('fabricated handles, foreign fields/getters and duplicate IDs cannot dispatch; mutable input is copied before awaits', async t => {
  const f=await fixture(t); await f.start(); assert.throws(()=>f.runtime.stop({}),/invalid_runtime_handle/);
  assert.throws(()=>f.send({...command(),userId:id(99)}),/invalid_runtime_command/);
  const getter={...command()}; Object.defineProperty(getter,'text',{get(){throw Error('getter evaluated');},enumerable:true});
  assert.throws(()=>f.send(getter),/invalid_runtime_command/);
  const input=command(),result=f.send(input); input.text='changed'; assert.deepEqual(await result,{text:'Echo Phòng trống?'});
  assert.throws(()=>f.send(command()),/runtime_command_duplicate/); assert.equal(f.events.filter(v=>v==='begin').length,1);
});

test('admission false closes both local and gateway gates synchronously', async t => {
  const f=await fixture(t); await f.start(); f.runtime.setAdmission(f.handle,false); assert.equal(f.gates.at(-1),false);
  assert.throws(()=>f.send(),/runtime_command_stopped/); assert(!f.events.includes('begin'));
});

test('A/B runtime handles, bootstrap owners and admission are isolated', async t => {
  const a=await fixture(t),b=await fixture(t,{binding:{assistantId:id(20),userId:id(21),organizationId:id(22)}});
  await a.start(); await b.start();
  assert.throws(()=>a.runtime.executePrivateCommand(b.handle,command(),{signal:new AbortController().signal}),/invalid_runtime_handle/);
  const aBoot=JSON.parse(await readFile(a.spec().bootstrap,'utf8')),bBoot=JSON.parse(await readFile(b.spec().bootstrap,'utf8'));
  assert.equal(aBoot.userId,id(2));assert.equal(bBoot.userId,id(21));assert.notEqual(a.spec().home,b.spec().home);
  await a.runtime.stop(a.handle);assert.equal(b.gates.at(-1),true);assert.deepEqual(await b.send(),{text:'Echo Phòng trống?'});
});

test('READY alone cannot pass a wrong image, mount, network or environment inspection', async t => {
  for(const mutateInspection of [c=>c.Mounts[0].Source='C:/foreign',c=>c.NetworkSettings.Networks.foreign={NetworkID:'d'.repeat(64)},
    c=>c.Image='sha256:'+'e'.repeat(64),c=>c.Config.Env.push('OPENAI_API_KEY=PRIVATE')]) {
    const f=await fixture(t,{mutateInspection}); await assert.rejects(f.runtime.start(f.handle),/runtime_start_failed/);
    assert(!f.gates.includes(true)); await assert.rejects(f.runtime.stop(f.handle),/runtime_stop_unproven/);
  }
});

test('READY received while inspection is pending cannot open admission', async t => {
  const inspectWait=deferred(),f=await fixture(t,{inspectWait});const starting=f.runtime.start(f.handle);
  await wait(()=>f.events.includes('inspect'));assert.throws(()=>f.runtime.setAdmission(f.handle,true),/runtime_not_ready/);
  assert(!f.gates.includes(true));inspectWait.resolve();await starting;f.runtime.setAdmission(f.handle,true);
  assert.deepEqual(await f.send(),{text:'Echo Phòng trống?'});
});

test('invalid gateway URL or unsupported host is rejected before container creation', async t => {
  for(const changes of [{descriptor:{networkName:'x',networkId:'b'.repeat(64),mcpUrl:'https://external/mcp',modelBaseUrl:GATEWAY_URLS.modelBaseUrl}},
    {host:{os:'linux',version:'27.5.0',nativeHost:true}},{host:{os:'linux',version:'28.3.0',nativeHost:false}}]) {
    const f=await fixture(t,changes); await assert.rejects(f.runtime.start(f.handle),/runtime_start_failed/); assert(!f.events.includes('create')); await f.runtime.stop(f.handle);
  }
});

test('duplicate JSON keys, wrong IDs, extra fields and oversized frames stop admission without returning private text', async t => {
  for(const mode of ['duplicate-keys','foreign-id','extra-field','oversize']) {
    const f=await fixture(t,{mode}); await f.start(); await assert.rejects(f.send(),/runtime_command_failed/);
    assert.equal(f.gates.at(-1),false); await f.runtime.stop(f.handle); assert(f.events.includes('child-close'));
  }
});

test('cancel closes admission immediately, interrupts the process and retains the command until gateway drain', async t => {
  const endTurnWait=deferred(),f=await fixture(t,{mode:'hang',endTurnWait}); await f.start();
  const cancel=new AbortController(),pending=f.send(command(),cancel.signal); await wait(()=>f.events.includes('begin'));
  cancel.abort(); assert.equal(f.gates.at(-1),false); await assert.rejects(pending,/runtime_command_cancelled/);
  let stopped=false; const closing=f.runtime.stop(f.handle).then(()=>{stopped=true;}); await wait(()=>f.events.includes('child-close'));
  assert.equal(stopped,false); assert(!f.events.includes('remove')); endTurnWait.resolve(); await closing; assert(f.events.includes('remove'));
});

test('beginExecute exposes actual drain after cancelled observer and child exit', async t => {
  const endTurnWait = deferred(), f = await fixture(t, { mode: 'hang', endTurnWait }); await f.start();
  const cancel = new AbortController();
  const operation = f.runtime.beginExecutePrivateCommand(f.handle, command(), { signal: cancel.signal });
  assert(Object.isFrozen(operation)); assert.deepEqual(Object.keys(operation), ['result', 'drained']);
  let drained = false; void operation.drained.then(() => { drained = true; });
  await wait(() => f.events.includes('begin'));
  cancel.abort(); await assert.rejects(operation.result, /runtime_command_cancelled/);
  await wait(() => f.events.includes('child-close') && f.events.includes('end'));
  assert.equal(drained, false); assert(!f.events.includes('remove'));
  endTurnWait.resolve(); await operation.drained; await f.runtime.stop(f.handle);
  assert.equal(drained, true); assert(f.events.includes('end-drained'));
});

test('beginExecute preserves normal results and rejects an unproven gateway drain', async t => {
  const f = await fixture(t); await f.start();
  const operation = f.runtime.beginExecutePrivateCommand(f.handle, command(), { signal: new AbortController().signal });
  assert.deepEqual(await operation.result, { text: 'Echo Phòng trống?' }); await operation.drained;
  const g = await fixture(t, { endFailure: true }); await g.start();
  const failed = g.runtime.beginExecutePrivateCommand(g.handle, command(), { signal: new AbortController().signal });
  await assert.rejects(failed.result, /runtime_command_failed/);
  await assert.rejects(failed.drained, /runtime_drain_failed|runtime_stop_unproven/);
  await assert.rejects(g.runtime.stop(g.handle), /runtime_stop_unproven/);
});

test('beginExecute protocol failure retains drain until the still-running child stops', async t => {
  let stopGrace;
  const timers = { setTimeout(fn, delay) { if (delay === 25) { stopGrace = fn; return {}; } return setTimeout(fn, delay); },
    clearTimeout(value) { clearTimeout(value); } };
  const f = await fixture(t, { mode: 'foreign-id-ignore-shutdown', timers }); await f.start();
  const operation = f.runtime.beginExecutePrivateCommand(f.handle, command(), { signal: new AbortController().signal });
  let drained = false; void operation.drained.then(() => { drained = true; });
  await assert.rejects(operation.result, /runtime_command_failed/);
  await wait(() => f.events.includes('end-drained') && stopGrace !== undefined);
  assert.equal(f.child().exitCode, null); assert(!f.events.includes('child-close')); assert(!f.events.includes('kill'));
  assert.equal(drained, false);
  stopGrace(); await operation.drained;
  assert(f.events.includes('child-close')); assert(f.events.includes('remove')); assert.equal(drained, true);
});

test('beginExecute failed hard stop rejects drain and keeps its failure latched', async t => {
  const f = await fixture(t, { mode: 'foreign-id-ignore-shutdown', killFailure: true }); await f.start();
  const operation = f.runtime.beginExecutePrivateCommand(f.handle, command(), { signal: new AbortController().signal });
  await assert.rejects(operation.result, /runtime_command_failed/);
  await assert.rejects(operation.drained, /runtime_stop_unproven/);
  assert(!f.events.includes('remove')); assert(!f.events.includes('gateway-close'));
  await assert.rejects(f.runtime.stop(f.handle), /runtime_stop_unproven/);
});

test('ignored shutdown is killed and stop waits for observed engine/child exit; cleanup failure remains latched', async t => {
  const f=await fixture(t,{mode:'ignore-shutdown'}); await f.start(); const pending=f.send(); await wait(()=>f.events.includes('begin'));
  const closing=f.runtime.stop(f.handle); await assert.rejects(pending,/runtime_command_failed/); await closing;
  assert(f.events.includes('kill')); assert(f.events.indexOf('wait')<f.events.indexOf('remove'));
  const g=await fixture(t,{removeFailure:true}); await g.start(); const failed=g.runtime.stop(g.handle);
  await assert.rejects(failed,/runtime_stop_unproven/); assert.equal(g.runtime.stop(g.handle),failed); assert(!g.events.includes('gateway-close'));
});

test('startup timeout rejects promptly, then stop drains and kills a process that never sent READY', async t => {
  let startup;
  const timers={setTimeout(fn,ms){if(ms===2000){startup=fn;return fn;}return setTimeout(fn,ms);},clearTimeout(value){if(typeof value!=='function')clearTimeout(value);}};
  const f=await fixture(t,{mode:'no-ready',timers}),starting=f.runtime.start(f.handle);await wait(()=>f.events.includes('attach'));
  startup();await assert.rejects(starting,/runtime_(start_timeout|stopped)/);
  await f.runtime.stop(f.handle); assert(f.events.includes('child-close')); assert(!f.gates.includes(true));
});

test('unknown create retains failed stop and resources; ignored abort create remains owned until its promise settles', async t => {
  const createWait=deferred(),f=await fixture(t,{createWait,createFailure:true}); const starting=f.runtime.start(f.handle);
  await wait(()=>f.events.includes('create')); f.controller.abort(); await assert.rejects(starting,/runtime_stopped/);
  let settled=false; const stopped=f.runtime.stop(f.handle).finally(()=>{settled=true;}); void stopped.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(settled,false); createWait.resolve();
  await assert.rejects(stopped,/runtime_stop_unproven/); assert(f.created()); assert(!f.events.includes('remove')); assert(!f.events.includes('gateway-close'));
});

test('known create ACK after cancellation is removed as never started, without waiting forever for a created container exit', async t => {
  const createWait=deferred(),f=await fixture(t,{createWait});const starting=f.runtime.start(f.handle);
  await wait(()=>f.events.includes('create'));f.controller.abort();await assert.rejects(starting,/runtime_stopped/);
  const stopped=f.runtime.stop(f.handle);createWait.resolve();await stopped;
  assert(!f.events.includes('attach'));assert(!f.events.includes('wait'));assert(f.events.includes('remove'));
});

test('unknown hard-kill or gateway drain cannot produce a successful stop receipt', async t => {
  const f=await fixture(t,{mode:'ignore-shutdown',killFailure:true});await f.start();
  await assert.rejects(f.runtime.stop(f.handle),/runtime_stop_unproven/);assert(!f.events.includes('remove'));assert(!f.events.includes('gateway-close'));
  const g=await fixture(t,{endFailure:true});await g.start();await assert.rejects(g.send(),/runtime_command_failed/);
  await assert.rejects(g.runtime.stop(g.handle),/runtime_stop_unproven/);
});

test('observed engine exit still retains ownership until attached transport actually closes', async t => {
  const f=await fixture(t,{mode:'ignore-shutdown',lingeringTransport:true});await f.start();
  let settled=false;const closing=f.runtime.stop(f.handle).then(()=>{settled=true;});
  await wait(()=>f.events.filter(value=>value==='inspect').length===3);
  assert.equal(settled,false);assert(!f.events.includes('remove'));assert(!f.events.includes('gateway-close'));
  f.child().kill();await closing;assert(f.events.includes('remove'));
});

test('stop before start consumes only the inert gateway and cannot create a container', async t => {
  const f=await fixture(t); await f.runtime.stop(f.handle); assert(!f.events.includes('create')); assert(f.events.includes('gateway-close'));
  assert.throws(()=>f.runtime.start(f.handle),/runtime_start_invalid/);
});

test('consumed IDs are bounded without eviction, and capacity prevents another dispatch', async t => {
  const f=await fixture(t);await f.start();
  for(let n=1;n<=1024;n++) await f.send(command(n));
  assert.throws(()=>f.send(command(1025)),/runtime_command_capacity/);
  assert.throws(()=>f.send(command(1)),/runtime_command_duplicate/);
  assert.equal(f.events.filter(value=>value==='begin').length,1024);
});

test('native engine adapter is inert and has no shell or automatic image pull/network creation', () => {
  const engine=createDockerEngine({executable:'not-executed-in-this-test'});
  assert.equal(typeof engine.create,'function'); assert.equal(typeof engine.attachStart,'function');
  assert.throws(()=>engine.attachStart('not-an-owned-container-id'),/invalid_container_id/);
  assert.throws(()=>engine.attachStart('c'.repeat(64)),/engine_not_initialized/);
});

// These invoke actual execFile/spawn against a mock CLI executable. The child
// harness deliberately mocks process.platform/UID; this is route/ownership
// regression evidence, not a Linux daemon, namespace, egress or bind-mount proof.
async function nativeHarness(t, scenario, extraEnv = {}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'hermes-engine-route-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const cli=path.join(directory,'mock-cli.cjs'),harness=path.join(directory,'harness.mjs'),log=path.join(directory,'calls.jsonl');
  await writeFile(cli,String.raw`
const fs=require('node:fs');
const args=process.argv.slice(2);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^DOCKER_(?:HOST|CONTEXT|TLS_VERIFY|CERT_PATH|API_VERSION|CUSTOM_HEADERS)$/i.test(key)));
fs.appendFileSync(process.env.TEST_ENGINE_LOG,JSON.stringify({args,env})+'\n');
const command=args[0]==='--host'?args.slice(2):args;
if(command[0]==='context') console.log(JSON.stringify(process.env.TEST_CONTEXT_ENDPOINT));
else if(command[0]==='version') console.log(JSON.stringify({Os:'linux',Version:'28.3.0'}));
else if(command[0]==='wait') console.log('0');
else if(command[0]==='create'||(command[0]==='network'&&command[1]==='create')) console.log('c'.repeat(64));
else if(command.includes('inspect')) console.log(JSON.stringify([{Id:'c'.repeat(64)}]));
else if(command[0]==='start') console.log('attached');
`);
  await writeFile(harness,`
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDockerEngine, createContainerRuntime } from ${JSON.stringify(new URL('./container-driver.mjs',import.meta.url).href)};
import { HERMES_IMAGE } from ${JSON.stringify(new URL('./runtime-contract.mjs',import.meta.url).href)};
Object.defineProperty(process,'platform',{value:'linux'});
Object.defineProperty(process,'getuid',{value:()=>10001});
Object.defineProperty(process,'getgid',{value:()=>10002});
const scenario=process.argv[2];
if (scenario.startsWith('uid-')) {
  const events=[];
  const gateway={prepare:()=>({}),start:()=>{throw Error('unexpected');},setAdmission(){},beginTurn(){},endTurn(){},close(){}};
  const engine={preflight:async()=>({os:'linux',version:'28.3.0',nativeHost:true}),inspectImage:async()=>{events.push('image');throw Error('stop-fixture');}};
  for(const key of ['inspectNetwork','create','attachStart','inspectContainer','kill','wait','remove']) engine[key]=()=>{throw Error('unexpected');};
  const runtime=createContainerRuntime({gateway,engine,runtimeRoot:${JSON.stringify(path.join(directory,'runtime'))},wrapperPath:${JSON.stringify(cli)},
    wrapperSha256:'a'.repeat(64),model:'fixture',...(scenario==='uid-mismatch'?{user:'10000:10000'}:{})});
  const handle=runtime.prepare({binding:{assistantId:'${id(1)}',userId:'${id(2)}',organizationId:'${id(3)}',home:${JSON.stringify(directory)}},admission:false,signal:new AbortController().signal});
  await assert.rejects(runtime.start(handle),/runtime_start_failed/);await runtime.stop(handle);
  console.log(JSON.stringify({events}));
} else {
  const engine=createDockerEngine({executable:process.execPath,argumentsPrefix:[${JSON.stringify(cli)}]});
  if(scenario==='remote') {await assert.rejects(engine.preflight(),/native_linux_engine_required/);await assert.rejects(engine.preflight(),/native_linux_engine_required/);}
  else {
    const id='c'.repeat(64);assert.deepEqual(await engine.preflight(),{os:'linux',version:'28.3.0',nativeHost:true});
    process.env.DOCKER_HOST='ssh://changed';process.env.DOCKER_CONTEXT='changed';
    await engine.preflight();await engine.inspectImage(HERMES_IMAGE);await engine.inspectNetwork(id);
    assert.equal(await engine.createNetwork(['network','create','owned-network']),id);
    assert.equal(await engine.create(['create','owned-container']),id);await engine.inspectContainer(id);
    const child=engine.attachStart(id);child.stdout.resume();child.stderr.resume();await once(child,'close');
    await engine.kill(id);assert.equal(await engine.wait(id),0);await engine.remove(id);await engine.removeNetwork(id);
  }
  console.log(JSON.stringify({done:true}));
}`);
  const child=spawn(process.execPath,[harness,scenario],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    TEST_ENGINE_LOG:log,TEST_CONTEXT_ENDPOINT:'unix:///var/run/pinned-docker.sock',DOCKER_HOST:'unix:///var/run/decoy.sock',
    DOCKER_CONTEXT:'chosen-context',DOCKER_TLS_VERIFY:'1',DOCKER_CERT_PATH:'test-only-cert',DOCKER_API_VERSION:'1.24',
    DOCKER_CUSTOM_HEADERS:'fixture-header',...extraEnv}});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const [code]=await once(child,'close');assert.equal(code,0,stderr);
  let calls=[];try{calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
  return {calls,result:JSON.parse(stdout)};
}

test('native adapter pins the resolved Unix context across exec and attach, strips routing env, and supports owned network lifecycle',async t=>{
  const {calls}=await nativeHarness(t,'happy');
  assert.deepEqual(calls[0].args,['context','inspect','chosen-context','--format','{{json .Endpoints.docker.Host}}']);
  assert.equal(calls.filter(value=>value.args.includes('context')).length,1);
  for(const call of calls) assert.deepEqual(call.env,{});
  for(const call of calls.slice(1)) assert.deepEqual(call.args.slice(0,2),['--host','unix:///var/run/pinned-docker.sock']);
  const operations=calls.slice(1).map(value=>value.args.slice(2));
  assert.equal(operations.filter(value=>value[0]==='version').length,2);
  assert(operations.some(value=>value[0]==='start'&&value[1]==='--attach'));
  assert(operations.some(value=>value[0]==='network'&&value[1]==='create'));
  assert(operations.some(value=>value[0]==='network'&&value[1]==='rm'));
});

test('remote DOCKER_CONTEXT overrides a local DOCKER_HOST and is refused before any daemon command',async t=>{
  const {calls}=await nativeHarness(t,'remote',{TEST_CONTEXT_ENDPOINT:'ssh://remote-host'});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['context','inspect','chosen-context','--format','{{json .Endpoints.docker.Host}}']);
  assert.deepEqual(calls[0].env,{});
});

test('native adapter also pins explicit Unix host when no context is selected',async t=>{
  const {calls}=await nativeHarness(t,'happy',{DOCKER_CONTEXT:''});
  assert(!calls.some(value=>value.args.includes('context')));
  for(const call of calls){assert.deepEqual(call.env,{});assert.deepEqual(call.args.slice(0,2),['--host','unix:///var/run/decoy.sock']);}
});

test('native adapter resolves the current context when neither routing environment variable is set',async t=>{
  const {calls}=await nativeHarness(t,'happy',{DOCKER_CONTEXT:'',DOCKER_HOST:''});
  assert.deepEqual(calls[0].args,['context','inspect','--format','{{json .Endpoints.docker.Host}}']);
  for(const call of calls.slice(1))assert.deepEqual(call.args.slice(0,2),['--host','unix:///var/run/pinned-docker.sock']);
});

test('Linux startup requires the runtime UID/GID to own private bind files; default host UID/GID reaches image inspection',async t=>{
  assert.deepEqual((await nativeHarness(t,'uid-mismatch')).result.events,[]);
  assert.deepEqual((await nativeHarness(t,'uid-default')).result.events,['image']);
});
