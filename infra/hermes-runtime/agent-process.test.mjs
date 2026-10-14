import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { HERMES_COMMIT } from './runtime-contract.mjs';

const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32'
  ? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : 'python3');
const source = path.resolve('infra/hermes-runtime/agent-process.py');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boot = { version: 1, assistantId: id(1), userId: id(2), organizationId: id(3), mcpUrl: 'http://hermes-gateway:8080/mcp',
  modelBaseUrl: 'http://hermes-gateway:8080/v1', model: 'fixture-model', maxTokens: 1024, maxIterations: 4 };
const turn = (n = 1, text = 'Phòng trống?') => ({ op: 'turn', commandId: id(10 + n), bindingId: id(4), bindingEpoch: 1, text });
const support = String.raw`
import json, os, threading
from pathlib import Path
lock = threading.Lock()
wake = threading.Event()
def config(): return json.loads(Path(os.environ['TEST_CONFIG']).read_text(encoding='utf-8'))
def record(event, **values):
    with lock:
        with open(os.environ['TEST_TRACE'], 'a', encoding='utf-8') as stream:
            stream.write(json.dumps({'event':event, **values})+'\n')
def names(): return config().get('tools', ['mcp__crm__crm_auth_context','mcp__crm__crm_available_rooms'])
`;
const agentStub = String.raw`
import os, sys
from support import config, record, names, wake
class AIAgent:
    def __init__(self, **kwargs):
        self.valid_tool_names = names()
        record('init', arguments={k:v for k,v in kwargs.items() if k != 'session_db'})
        print('PRIVATE-UPSTREAM-STDOUT', flush=True)
        print('PRIVATE-UPSTREAM-STDERR', file=sys.stderr, flush=True)
        os.write(1,b'PRIVATE-RAW-STDOUT\n')
    def run_conversation(self, text, system_message=None, conversation_history=None):
        record('run', text=text, system_message=system_message, history=conversation_history)
        if config().get('checkToolWire'):
            # Synthetic shape of the relay request: system + user, then one
            # assistant envelope and both advertised tool results each round.
            wire_count = len(conversation_history or [])+2
            record('wire', messages=wire_count)
            for n in range(config()['checkToolWire']):
                wire_count += 3
                record('wire', messages=wire_count)
                if wire_count > 64: raise RuntimeError('wire message limit')
        mode = config().get('mode','normal')
        if mode == 'hang': wake.wait(30)
        if mode == 'throw': raise RuntimeError('PRIVATE-ERROR-PAYLOAD')
        final = config().get('finalResponse','Echo '+text)
        if mode == 'oversize': final = 'x'*32769
        if mode == 'escaped-frame': final = '\b'*32768
        if mode == 'nul': final = 'x\0y'
        count = config().get('historyCount')
        history = (conversation_history or [])+[{'role':'user','content':text}]
        if count is not None:
            history = []
            for n in range(count//2):
                history.extend([{'role':'assistant','content':None,'tool_calls':[{'id':'call_'+str(n),'type':'function','function':{'name':'mcp__crm__crm_auth_context','arguments':'{}'}}]},
                                {'role':'tool','tool_call_id':'call_'+str(n),'content':'{}'}])
            if count%2: history.append({'role':'assistant','content':'completed'})
        return {'completed': mode != 'incomplete', 'final_response':final,
                'messages': [] if mode == 'no-history' else history}
    def interrupt(self, **kwargs): record('interrupt', arguments=kwargs); wake.set()
    def close(self): record('close')
`;
const launcher = String.raw`
import json, os, runpy, sys, urllib.request
from pathlib import Path
from support import config, record
count = 0
bootstrap_path = sys.argv[2]
class Reply:
    status = 200
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self, cap): return self.value[:cap]
def fake_open(self, request, timeout):
    global count
    cfg=config(); boot=json.loads(Path(bootstrap_path).read_text()); payload=json.loads(request.data)
    if payload['method']=='tools/list':
        record('discovery', payload=payload)
        names=cfg.get('discovery',cfg.get('tools',['mcp__crm__crm_auth_context','mcp__crm__crm_available_rooms']))
        return Reply(json.dumps({'jsonrpc':'2.0','id':payload['id'],'result':{'tools':[{'name':name.removeprefix('mcp__crm__'),'inputSchema':{'type':'object'}} for name in names]}}).encode())
    count += 1
    record('auth', count=count, url=request.full_url, headers=dict(request.header_items()), payload=payload)
    identity={key:boot[key] for key in ['assistantId','userId','organizationId']}
    identity.update(permissions=cfg.get('permissions',{'read':['assistant.context.read','rooms.view'],'action':[]}),
                    contextVersion=cfg.get('contextVersion','a'*64))
    identity.update(cfg.get('identity',{}))
    if cfg.get('changeAt') and count >= cfg['changeAt']: identity['contextVersion']='b'*64
    if cfg.get('deny'): raise RuntimeError('PRIVATE-AUTH-ERROR')
    value={'jsonrpc':'2.0','id':payload['id'],'result':{'isError':False,'content':[{'type':'text','text':json.dumps(identity)}]}}
    return Reply(json.dumps(value).encode())
urllib.request.OpenerDirector.open=fake_open
file=sys.argv[1]; sys.argv=[file,sys.argv[2]]
runpy.run_path(file,run_name='__main__')
`;

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-agent-process-')), home = path.join(root, 'home'), modules = path.join(root, 'modules');
  await mkdir(home); await mkdir(path.join(modules, 'tools'), { recursive: true });
  const configPath = path.join(root, 'config.json'), tracePath = path.join(root, 'trace.jsonl'), bootstrap = path.join(root, 'bootstrap.json');
  await Promise.all([
    writeFile(configPath, JSON.stringify(settings.config ?? {})), writeFile(tracePath, ''),
    writeFile(bootstrap, settings.rawBoot ?? JSON.stringify({ ...boot, ...settings.boot })),
    writeFile(path.join(modules, 'support.py'), support),
    writeFile(path.join(modules, 'run_agent.py'), agentStub), writeFile(path.join(modules, 'tools', '__init__.py'), ''),
    writeFile(path.join(modules, 'hermes_state.py'), "from support import record\nclass SessionDB:\n def __init__(self,path): record('db',path=str(path))\n def create_session(self,sid,source): record('session',sid=sid,source=source)\n def close(self): record('db_close')\n"),
    writeFile(path.join(modules, 'tools', 'mcp_tool_discovery.py'), "from support import record,names\ndef register_mcp_servers(config):\n record('register',config=config)\n return names()\n"),
    writeFile(path.join(modules, 'tools', 'mcp_tool_lifecycle.py'), "from support import record\ndef shutdown_mcp_servers(): record('mcp_shutdown')\n"),
    writeFile(path.join(root, 'launcher.py'), launcher),
  ]);
  if (settings.owner) await writeFile(path.join(home, '.ihome-owner.json'), JSON.stringify(settings.owner));
  await writeFile(path.join(home, 'MEMORY.md'), 'PRIVATE-OLD-MEMORY');
  const child = spawn(python, [path.join(root, 'launcher.py'), source, bootstrap], { windowsHide: true,
    env: { ...process.env, PYTHONPATH: modules, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
      HERMES_HOME: home, TEST_CONFIG: configPath, TEST_TRACE: tracePath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [], waiters = []; let output = '', errorOutput = '', buffer = '';
  child.stdout.on('data', chunk => {
    output += chunk; buffer += chunk;
    while (buffer.includes('\n')) { const pos = buffer.indexOf('\n'), line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      try { frames.push(JSON.parse(line)); } catch { frames.push({ invalidLine: line }); }
      waiters.splice(0).forEach(done => done());
    }
  });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  child.stdin.on('error', () => {}); // Malformed-input exit can close the pipe before a queued write.
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const wait = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!frames.some(predicate)) {
      if (Date.now() >= deadline) throw Error(`Missing process frame; output=${output}; stderr=${errorOutput}`);
      await new Promise(resolve => { const timer = setTimeout(resolve, 30); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    return frames.find(predicate);
  };
  t.after(async () => { if (child.exitCode === null) { child.stdin.end(); const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 1000))]); if (!stopped) { child.kill(); await exited; } }
    await rm(root, { recursive: true, force: true }); });
  const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { home, frames, exited, trace, child, output: () => output, stderr: () => errorOutput,
    configure: config => writeFile(configPath, JSON.stringify(config)), raw: value => child.stdin.write(value),
    ready: () => wait(value => value.event === 'ready' || value.event === 'error'),
    send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }, wait,
    async event(name) { const deadline = Date.now() + 5000; while (!(await trace()).some(row => row.event === name)) {
      if (Date.now() > deadline) throw Error('Missing trace '+name); await new Promise(resolve => setTimeout(resolve, 10)); }
    } };
}

test('real subprocess protocol keeps secrets out of bootstrap and initializes the pinned Hermes API with memory disabled', async t => {
  const f = await fixture(t); assert.deepEqual(await f.ready(), { event: 'ready', version: 1 });
  f.send(turn()); assert.deepEqual(await f.wait(value => value.event === 'result'), { event: 'result', commandId: turn().commandId, text: 'Echo Phòng trống?' });
  f.send({ op: 'shutdown' }); assert.equal((await f.exited).code, 0);
  const trace = await f.trace(), init = trace.find(row => row.event === 'init').arguments;
  assert.equal(init.skip_memory, true); assert.equal(init.skip_context_files, true); assert.equal(init.skip_background_review, true);
  assert.deepEqual(init.enabled_toolsets, ['mcp-crm']); assert(init.disabled_toolsets.includes('terminal')); assert(init.disabled_toolsets.includes('memory'));
  assert.equal(init.api_key, 'gateway-no-credential'); assert.equal(init.base_url, boot.modelBaseUrl);
  assert.deepEqual(init.fallback_model, []);
  const config = JSON.parse(await readFile(path.join(f.home, 'config.yaml'), 'utf8'));
  assert.equal(config.memory.memory_enabled, false); assert.equal(config.memory.user_profile_enabled, false);
  assert.equal(config.model.streaming, false);
  assert.equal(config.agent.api_max_retries, 1); assert.equal(config.agent.auto_recovery_cycles, 0);
  assert.deepEqual(config.fallback_providers, []); assert.deepEqual(config.fallback_model, []);
  assert.equal(config.tools.tool_search.enabled, 'off'); assert.equal(config.security.allow_lazy_installs, false);
  assert(!Object.hasOwn(config.mcp_servers.crm, 'headers'));
  assert.deepEqual(config.mcp_servers.crm.sampling, { enabled: false });
  assert.deepEqual(config.mcp_servers.crm.elicitation, { enabled: false });
  assert(trace.filter(row => row.event === 'auth').every(row => !Object.keys(row.headers).some(key => key.toLowerCase() === 'authorization')));
  assert(trace.some(row => row.event === 'mcp_shutdown')); assert(trace.some(row => row.event === 'db_close'));
  assert(!trace.find(row => row.event === 'db').path.startsWith(f.home));
  assert(!f.output().includes('PRIVATE')); assert.equal(f.stderr(), '');
});

test('history is reused only with the same fingerprint and is discarded on rights or context changes', async t => {
  const f = await fixture(t); await f.ready(); f.send(turn(1, 'first')); await f.wait(value => value.commandId === turn(1).commandId);
  f.send(turn(2, 'second')); await f.wait(value => value.commandId === turn(2).commandId);
  await f.configure({ contextVersion: 'b'.repeat(64) }); f.send(turn(3, 'third')); await f.wait(value => value.commandId === turn(3).commandId);
  const runs = (await f.trace()).filter(row => row.event === 'run');
  assert.equal(runs[0].history, null); assert.deepEqual(runs[1].history, [{ role: 'user', content: 'first' }]); assert.equal(runs[2].history, null);
});

test('optional group tools preserve clarification and confirmation prose while refreshing tools and dropping hidden history', async t => {
  const f = await fixture(t); await f.ready(); f.send(turn(1)); await f.wait(value => value.commandId === turn(1).commandId);
  const tools = ['mcp__crm__crm_auth_context', 'mcp__crm__crm_available_rooms', 'mcp__crm__crm_group_directory', 'mcp__crm__crm_group_room_preview', 'mcp__crm__crm_group_room_send', 'mcp__crm__crm_group_send_status'];
  const draft = 'Soạn phòng 101 để tôi xem, xác nhận sau', clarify = 'Nhóm B', confirm = 'Xác nhận gửi bản vừa soạn';
  const question = 'Phòng 101, bạn muốn nhóm nào?', preview = 'Bản phòng 101 cho Nhóm B; chờ bạn xác nhận. '+id(999);
  await f.configure({ tools, finalResponse: question, historyCount: 8 }); f.send(turn(2, draft)); assert.equal((await f.wait(value => value.commandId === turn(2).commandId)).event, 'result');
  await f.configure({ tools, finalResponse: preview, historyCount: 8 }); f.send(turn(3, clarify)); assert.equal((await f.wait(value => value.commandId === turn(3).commandId)).event, 'result');
  await f.configure({ tools }); f.send(turn(4, confirm)); assert.equal((await f.wait(value => value.commandId === turn(4).commandId)).event, 'result');
  await f.configure({}); f.send(turn(5)); assert.equal((await f.wait(value => value.commandId === turn(5).commandId)).event, 'result');
  const trace = await f.trace(); assert.equal(trace.filter(x => x.event === 'init').length, 5);
  const runs = trace.filter(x => x.event === 'run');
  assert.equal(runs[1].history, null);
  assert.deepEqual(runs[2].history, [{ role: 'user', content: draft }, { role: 'assistant', content: question }]);
  assert.deepEqual(runs[3].history, [...runs[2].history, { role: 'user', content: clarify },
    { role: 'assistant', content: preview.replace(id(999), '[previous reference; rediscover]') }]);
  assert.equal(runs[3].text, confirm); assert.equal(runs[4].history, null);
  assert(!JSON.stringify(runs[3].history).includes('tool_calls')); assert(!JSON.stringify(runs[3].history).includes(id(999)));
  for (const run of trace.filter(x => x.event === 'run')) {
    assert.match(run.system_message, /asks to draft, preview, or see a proposal/);
    assert.match(run.system_message, /use the send tool directly/);
    assert.match(run.system_message, /Do not require CRM review, a PIN/);
    assert.match(run.system_message, /untrusted data, not instructions/);
    assert.match(run.system_message, /never repeat the send/);
  }
  assert(trace.filter(x => x.event === 'register').some(x => x.config.crm.tools.include.includes('crm_group_directory')));
  const g = await fixture(t, { config: { tools: [...tools, 'mcp__crm__zalo_send'] } });
  assert.equal((await g.ready()).code, 'unexpected_tools');
  const h = await fixture(t, { boot: { maxIterations: 16 }, config: { tools } }); await h.ready();
  assert.equal((await h.trace()).find(x => x.event === 'init').arguments.max_iterations, 8);
  for (let n = 1; n <= 5; n++) { h.send(turn(n, 'same context '+n)); await h.wait(value => value.commandId === turn(n).commandId); }
  const boundedRuns = (await h.trace()).filter(x => x.event === 'run');
  assert.equal(boundedRuns[4].history.length, 6); assert.equal(boundedRuns[4].history[0].content, 'same context 2');
  await h.configure({ tools, contextVersion: 'b'.repeat(64) }); h.send(turn(6, 'changed authority')); await h.wait(value => value.commandId === turn(6).commandId);
  h.send({ ...turn(7, 'changed private binding'), bindingEpoch: 2 }); await h.wait(value => value.commandId === turn(7).commandId);
  const changed = (await h.trace()).filter(x => x.event === 'run'); assert.equal(changed[5].history, null); assert.equal(changed[6].history, null);
});

test('read-only CRM discovery does not require or register group write tools', async t => {
  const tools = ['mcp__crm__crm_auth_context', 'mcp__crm__crm_group_directory', 'mcp__crm__crm_group_send_status'];
  const f = await fixture(t, { config: { tools } });
  assert.equal((await f.ready()).event, 'ready');
  const registered = (await f.trace()).find(row => row.event === 'register');
  assert.deepEqual(registered.config.crm.tools.include.sort(),
    ['crm_auth_context', 'crm_group_directory', 'crm_group_send_status']);
  f.send(turn(1, 'Xem nhóm được phép'));
  assert.equal((await f.wait(value => value.commandId === turn(1).commandId)).event, 'result');
  assert(!(await f.trace()).find(row => row.event === 'init').arguments.enabled_toolsets.includes('messaging'));
});

test('permission change with the same context fingerprint still discards history; pre-model revocation never invokes model', async t => {
  const f = await fixture(t); await f.ready(); f.send(turn(1)); await f.wait(value => value.commandId === turn(1).commandId);
  await f.configure({ permissions: { read: ['assistant.context.read'], action: [] } });
  f.send(turn(2)); await f.wait(value => value.commandId === turn(2).commandId);
  assert.equal((await f.trace()).filter(row => row.event === 'run')[1].history, null);
  const g = await fixture(t, { config: { changeAt: 4 } }); await g.ready(); g.send(turn());
  assert.equal((await g.wait(value => value.commandId === turn().commandId)).code, 'authority_changed');
  assert(!(await g.trace()).some(row => row.event === 'run'));
});

test('retained history reserves system, user and configured tool iterations within 64 messages, then resets the whole agent and SessionDB without slicing tool pairs', async t => {
  const f = await fixture(t, { config: { historyCount: 50 } }); await f.ready();
  f.send(turn(1)); assert.equal((await f.wait(value => value.commandId === turn(1).commandId)).event, 'result');
  await f.configure({ checkToolWire: boot.maxIterations }); f.send(turn(2)); assert.equal((await f.wait(value => value.commandId === turn(2).commandId)).event, 'result');
  let trace = await f.trace(); const retained = trace.filter(row => row.event === 'run')[1].history;
  assert.equal(retained.length + 2 + boot.maxIterations * 3, 64); assert.equal(trace.filter(row => row.event === 'init').length, 1);
  assert.deepEqual(trace.filter(row => row.event === 'wire').map(row => row.messages), [52, 55, 58, 61, 64]);
  for (let n = 0; n < 25; n++) assert.equal(retained[n * 2].tool_calls[0].id, retained[n * 2 + 1].tool_call_id);
  // Second result has 51 messages. The next turn must use a new agent, DB and
  // session, not merely pass None to an agent that can reload a durable transcript.
  f.send(turn(3)); assert.equal((await f.wait(value => value.commandId === turn(3).commandId)).event, 'result');
  trace = await f.trace(); assert.equal(trace.filter(row => row.event === 'run')[2].history, null);
  assert.equal(trace.filter(row => row.event === 'init').length, 2);
  assert.equal(new Set(trace.filter(row => row.event === 'db').map(row => row.path)).size, 2);
  assert.equal(new Set(trace.filter(row => row.event === 'session').map(row => row.sid)).size, 2);
  assert(trace.findIndex(row => row.event === 'close') < trace.findLastIndex(row => row.event === 'init'));
  for (const historyCount of [51, 62, 64, 256]) {
    const g = await fixture(t, { config: { historyCount } }); await g.ready(); g.send(turn(1));
    assert.equal((await g.wait(value => value.commandId === turn(1).commandId)).event, 'result');
    await g.configure({}); g.send(turn(2)); assert.equal((await g.wait(value => value.commandId === turn(2).commandId)).event, 'result');
    assert.equal((await g.trace()).filter(row => row.event === 'run')[1].history, null);
    assert.equal((await g.trace()).filter(row => row.event === 'init').length, 2);
  }
  // With the maximum 16 iterations the retained budget becomes 14; the 15th
  // message forces a complete reset rather than leaving no room for tools.
  const h = await fixture(t, { boot: { maxIterations: 16 }, config: { historyCount: 14 } }); await h.ready();
  h.send(turn(1)); await h.wait(value => value.commandId === turn(1).commandId);
  await h.configure({ checkToolWire: 16 }); h.send(turn(2));
  assert.equal((await h.wait(value => value.commandId === turn(2).commandId)).event, 'result');
  assert.equal((await h.trace()).filter(row => row.event === 'wire').at(-1).messages, 64);
  h.send(turn(3)); await h.wait(value => value.commandId === turn(3).commandId);
  assert.equal((await h.trace()).filter(row => row.event === 'run')[2].history, null);
  assert.equal((await h.trace()).filter(row => row.event === 'init').length, 2);
});

test('model output token budget is accepted at 4096 and rejected above the existing relay cap before imports', async t => {
  const allowed = await fixture(t, { boot: { maxTokens: 4096 } });
  assert.equal((await allowed.ready()).event, 'ready');
  assert.equal((await allowed.trace()).find(row => row.event === 'init').arguments.max_tokens, 4096);
  for (const maxTokens of [4097, 8192]) {
    const denied = await fixture(t, { boot: { maxTokens } });
    assert.equal((await denied.ready()).code, 'invalid_bootstrap'); assert.equal((await denied.trace()).length, 0);
  }
});

test('foreign owner or changed authority after model never releases a response', async t => {
  for (const config of [{ identity: { userId: id(99) } }, { changeAt: 5 }]) {
    const f = await fixture(t, { config }); const ready = await f.ready();
    if (ready.event === 'error') { assert.equal(ready.code, 'authority_denied'); assert.equal((await f.trace()).some(row => row.event === 'init'), false); }
    else { f.send(turn()); const result = await f.wait(value => value.commandId === turn().commandId); assert.equal(result.event, 'error'); assert.equal(result.code, 'authority_changed'); }
    assert(!f.frames.some(row => row.event === 'result'));
  }
});

test('duplicate IDs, forged actors, extra shutdown fields, JSON duplicate keys and invalid text cannot invoke the model', async t => {
  const f = await fixture(t); await f.ready(); f.send(turn()); await f.wait(value => value.event === 'result');
  f.send(turn()); assert.equal((await f.wait(value => value.code === 'duplicate_command')).event, 'error');
  for (const value of [{ ...turn(2), userId: id(99) }, { ...turn(3), text: 'x'.repeat(8193) }, { ...turn(4), text: 'a\0b' }, { ...turn(5), bindingEpoch: true }, { op: 'shutdown', userId: id(99) }]) f.send(value);
  f.raw('{"op":"shutdown","op":"turn"}\n'); await f.wait(value => value.code === 'invalid_frame');
  assert.equal((await f.trace()).filter(row => row.event === 'run').length, 1);
});

test('invalid bootstrap URLs, credentials, fields, duplicate keys and existing foreign home owner fail before imports', async t => {
  const cases = [
    { boot: { token: 'hc_private' } }, { boot: { mcpUrl: 'http://user:secret@hermes-gateway/mcp' } },
    { boot: { mcpUrl: 'http://169.254.169.254/mcp' } }, { boot: { mcpUrl: 'http://example.com/mcp' } },
    { boot: { modelBaseUrl: 'https://hermes-gateway/v1' } }, { boot: { modelBaseUrl: 'http://hermes-gateway/v1?secret=x' } },
    { boot: { model: '$(run-untrusted)' } }, { boot: { maxTokens: true } },
    { rawBoot: JSON.stringify(boot).replace('"version":1', '"version":1,"version":1') },
    { owner: { assistantId: id(99), userId: id(99), organizationId: id(99) } },
  ];
  for (const settings of cases) {
    const f = await fixture(t, settings); assert.equal((await f.ready()).code, 'invalid_bootstrap');
    assert.equal((await f.trace()).length, 0); assert.equal((await f.exited).code, 1);
  }
});

test('unexpected advertised tools prevent READY and cannot be hidden by model configuration', async t => {
  const f = await fixture(t, { config: { tools: ['mcp__crm__crm_auth_context', 'terminal'] } });
  assert.equal((await f.ready()).code, 'unexpected_tools'); assert(!(await f.trace()).some(row => row.event === 'run'));
});

test('raw upstream exceptions, incomplete turns and oversized or NUL output become fixed sanitized errors', async t => {
  for (const mode of ['throw', 'incomplete', 'oversize', 'escaped-frame', 'nul']) {
    const f = await fixture(t, { config: { mode } }); await f.ready(); f.send(turn());
    const result = await f.wait(value => value.commandId === turn().commandId);
    assert.deepEqual(result, { event: 'error', commandId: turn().commandId, code: mode === 'throw' ? 'runtime_failed' : 'invalid_result' });
    assert(!f.output().includes('PRIVATE')); assert.equal(f.stderr(), '');
  }
});

test('shutdown interrupts an in-flight turn, withholds its late output and drains before actual exit', async t => {
  const f = await fixture(t, { config: { mode: 'hang' } }); await f.ready(); f.send(turn()); await f.event('run');
  f.send(turn(2)); assert.equal((await f.wait(value => value.commandId === turn(2).commandId)).code, 'busy');
  f.send({ op: 'shutdown' }); assert.equal((await f.exited).code, 0);
  const trace = await f.trace(); assert(trace.some(row => row.event === 'interrupt' && row.arguments.hard_cancel === true));
  assert(trace.some(row => row.event === 'close')); assert(trace.some(row => row.event === 'mcp_shutdown'));
  assert(!f.frames.some(row => row.event === 'result'));
});

test('oversized protocol frame exits without interpreting trailing attacker frames', async t => {
  const f = await fixture(t); await f.ready(); f.raw('x'.repeat(65537) + '\n' + JSON.stringify(turn()) + '\n');
  assert.equal((await f.wait(value => value.code === 'invalid_frame')).commandId, null);
  assert.equal((await f.exited).code, 1); assert(!(await f.trace()).some(row => row.event === 'run'));
});

test('1024 consumed command IDs are never evicted and capacity closes further admission', async t => {
  const f = await fixture(t, { config: { mode: 'no-history' } }); await f.ready();
  for (let n = 1; n <= 1024; n++) {
    f.send(turn(n, 'x')); assert.equal((await f.wait(value => value.commandId === turn(n).commandId)).event, 'result');
  }
  f.send(turn(1025, 'x')); assert.equal((await f.wait(value => value.commandId === turn(1025).commandId)).code, 'command_capacity');
  f.send(turn(1, 'changed text')); assert.equal((await f.wait(value => value.code === 'duplicate_command')).commandId, turn(1).commandId);
  assert.equal((await f.trace()).filter(row => row.event === 'run').length, 1024);
});

test('wrapper pins agree with runtime contract; available pinned upstream signatures accept every used keyword', async () => {
  const content = await readFile(source, 'utf8'); assert(content.includes(`UPSTREAM_COMMIT = '${HERMES_COMMIT}'`));
  const upstream = process.env.HERMES_TEST_UPSTREAM;
  if (upstream) {
    assert(existsSync(path.join(upstream, 'run_agent.py')));
    const revision = spawnSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    assert.equal(revision.status, 0, revision.stderr); assert.equal(revision.stdout.trim(), HERMES_COMMIT);
    const script = String.raw`import ast, pathlib, sys
wrapper=ast.parse(pathlib.Path(sys.argv[1]).read_text()); upstream=pathlib.Path(sys.argv[2])
targets={'AIAgent':('run_agent.py','__init__'),'SessionDB':('hermes_state.py','__init__')}
for name,(file,method) in targets.items():
 tree=ast.parse((upstream/file).read_text(encoding='utf-8')); cls=next(n for n in ast.walk(tree) if isinstance(n,ast.ClassDef) and n.name==name)
 fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name==method); accepted={a.arg for a in fn.args.args+fn.args.kwonlyargs}
 used={k.arg for n in ast.walk(wrapper) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id==name for k in n.keywords}
 assert used<=accepted,(name,used-accepted)
methods={'run_conversation':'agent/turn_facade.py','interrupt':'agent/interrupt_control.py','create_session':'hermes_state_sessions.py'}
for method,file in methods.items():
 tree=ast.parse((upstream/file).read_text(encoding='utf-8')); fn=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==method)
 accepted={a.arg for a in fn.args.args+fn.args.kwonlyargs}
 used={k.arg for n in ast.walk(wrapper) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr==method for k in n.keywords}
 assert used<=accepted,(method,used-accepted)
init_tree=ast.parse((upstream/'agent/agent_init.py').read_text(encoding='utf-8'))
for section,key in [('_model_section','streaming'),('_agent_section','api_max_retries'),('_agent_section','auto_recovery_cycles')]:
 assert any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and isinstance(n.func.value,ast.Name)
  and n.func.value.id==section and n.func.attr=='get' and n.args and isinstance(n.args[0],ast.Constant) and n.args[0].value==key for n in ast.walk(init_tree)),key
# Run only the pinned pure fallback normalizer, not the upstream runtime/imports.
fallback_tree=ast.parse((upstream/'agent/agent_init_fallback.py').read_text(encoding='utf-8'))
fallback_fn=next(n for n in fallback_tree.body if isinstance(n,ast.FunctionDef) and n.name=='_fallback_entries')
from typing import List,Dict,Any
namespace={'List':List,'Dict':Dict,'Any':Any}
exec(compile(ast.Module(body=[fallback_fn],type_ignores=[]),'<pinned-fallback-normalizer>','exec'),namespace)
assert namespace['_fallback_entries']([])==[]
config_tree=ast.parse((upstream/'hermes_cli/fallback_config.py').read_text(encoding='utf-8'))
config_fn=next(n for n in config_tree.body if isinstance(n,ast.FunctionDef) and n.name=='get_fallback_chain')
assert any(isinstance(n,ast.Tuple) and [v.value for v in n.elts if isinstance(v,ast.Constant)]==['fallback_providers','fallback_model'] for n in ast.walk(config_fn))
print('PINNED_API_SIGNATURES_PASS')`;
    const checked = spawnSync(python, ['-c', script, source, upstream], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /PINNED_API_SIGNATURES_PASS/);
  }
});

test('actual pinned Hermes registration advertises no sampling or elicitation to the private gateway', async t => {
  const upstream = process.env.HERMES_TEST_UPSTREAM ?? path.resolve('.cache/hermes-p1/upstream-hermes-agent');
  const mcpPython = process.env.HERMES_TEST_MCP_PYTHON ?? path.resolve('.cache/hermes-p1/transport-venv/Scripts/python.exe');
  if (!existsSync(path.join(upstream, 'tools/mcp_tool_discovery.py')) || !existsSync(mcpPython)) {
    t.skip('Pinned Hermes source/MCP environment unavailable; native product CI verifies the full image'); return;
  }
  const revision = spawnSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.equal(revision.status, 0); assert.equal(revision.stdout.trim(), HERMES_COMMIT);
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-registration-')), home = path.join(root, 'home');
  await mkdir(home);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); requests.push(input);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(body ? JSON.stringify(body) : undefined); };
    let result;
    if (input.method === 'initialize') {
      // The actual gateway deliberately accepts no server-to-client features.
      // A bare SDK session misses the callbacks added by Hermes registration.
      if (Object.keys(input.params.capabilities).length) { send(400, { error: 'invalid_request' }); return; }
      result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (input.method === 'notifications/initialized') { send(202); return; }
    else if (input.method === 'tools/list') result = { tools: [{ name: 'crm_auth_context', description: 'Verified context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    else if (input.method === 'tools/call') result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ assistantId: boot.assistantId,
      userId: boot.userId, organizationId: boot.organizationId, permissions: { read: ['assistant.context.read'], action: [] }, contextVersion: 'a'.repeat(64) }) }] };
    else { send(404, { error: 'not_found' }); return; }
    send(200, { jsonrpc: '2.0', id: input.id, result });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, bootstrap = path.join(root, 'bootstrap.json');
  await writeFile(bootstrap, JSON.stringify({ ...boot, mcpUrl: url + '/mcp', modelBaseUrl: url + '/v1' }));
  const launcher = String.raw`
import sys, types, runpy
from importlib.metadata import version
assert version('mcp') == '2.0.0'
sys.path.insert(0, sys.argv[3])
# Only AIAgent/SQLite are stubbed; use the real pinned Hermes discovery,
# transport, handlers, registration and MCP SDK against the strict HTTP server.
class AIAgent:
 def __init__(self,**kwargs):
  from tools.mcp_tool_common import _core
  servers=list(_core._servers.values())
  assert len(servers)==1
  assert servers[0]._sampling is None and servers[0]._elicitation is None
  self.valid_tool_names=['mcp__crm__crm_auth_context']
 def close(self): pass
class SessionDB:
 def __init__(self,*args): pass
 def create_session(self,*args,**kwargs): pass
 def close(self): pass
sys.modules['run_agent']=types.SimpleNamespace(AIAgent=AIAgent)
sys.modules['hermes_state']=types.SimpleNamespace(SessionDB=SessionDB)
file=sys.argv[1]; sys.argv=[file,sys.argv[2]]
runpy.run_path(file,run_name='__main__')
`;
  const child = spawn(mcpPython, ['-c', launcher, source, bootstrap, upstream], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HERMES_HOME: home, HOME: home,
      PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  let output = '', stderr = '';
  child.stdout.on('data', bytes => { output += bytes; if (output.includes('"ready"')) child.stdin.end('{"op":"shutdown"}\n'); });
  child.stderr.on('data', bytes => { stderr += bytes; }); child.stdin.on('error', () => {});
  const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => child.kill(), 30000);
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await stopped; }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await stopped, { code: 0, signal: null }, output + stderr);
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line)), [{ event: 'ready', version: 1 }]);
  assert.equal(stderr, '');
  const init = requests.filter(value => value.method === 'initialize'); assert.equal(init.length, 1);
  assert.deepEqual(init[0].params.capabilities, {});
  assert(requests.some(value => value.method === 'tools/list'));
});
