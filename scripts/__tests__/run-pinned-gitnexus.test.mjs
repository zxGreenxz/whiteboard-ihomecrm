import test from 'node:test';
import assert from 'node:assert/strict';
import * as wrapper from '../run-pinned-gitnexus.mjs';

test('wrapper refuses scope overrides and invalid unbounded numeric options before executing anything', () => {
  assert.equal(typeof wrapper.parseArgs, 'function', 'bounded project CLI parser must exist');
  for (const args of [['analyze', '../other'], ['query', 'x', '--repo=other'], ['query', 'x', '-r', 'other'], ['analyze', '--branch=x'], ['analyze', '--skills'], ['analyze', '--embeddings'], ['analyze', '--max-file-size', '1'], ['query', 'x', '--limit', '0'], ['impact', 'x', '--depth', 'NaN'], ['query', 'x', '--timeout-ms', '900000'], ['mcp']]) {
    assert.throws(() => wrapper.parseArgs(args), e => e.code === 64, JSON.stringify(args));
  }
});

test('query preserves metacharacters as a single argv value and supplies bounded defaults', () => {
  assert.equal(typeof wrapper.parseArgs, 'function');
  const text = 'a & b | $(write) `x` "quoted"';
  const parsed = wrapper.parseArgs(['query', text]);
  assert.deepEqual(parsed.nativeArgs, ['query', text, '--limit', '5']);
  assert.equal(parsed.timeoutMs, 30000);
  assert.deepEqual(wrapper.parseArgs(['impact', 'x']).bounds, {limit:20, depth:2});
  assert.deepEqual(wrapper.parseArgs(['trace', 'a', 'b']).bounds, {depth:6});
});

import {mkdtemp, mkdir, writeFile, readFile, cp, rm, rename, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const project = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitnexus argv & fixture ')));
  t.after(() => rm(root, {recursive:true, force:true}));
  await mkdir(join(root,'scripts/lib'),{recursive:true});
  await mkdir(join(root,'tooling'),{recursive:true});
  for (const file of ['scripts/run-pinned-gitnexus.mjs','scripts/lib/gitnexus-state.mjs','tooling/agent-tools.json']) await cp(join(project,file),join(root,file));
  await writeFile(join(root,'.gitignore'), '.gitnexus/\nnode_modules/\n');
  await writeFile(join(root,'source.ts'), 'export function target() { return 1; }\n');
  await writeFile(join(root,'package.json'), JSON.stringify({type:'module',scripts:{'graph:query':'node scripts/run-pinned-gitnexus.mjs query'}}));
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['-c','core.autocrlf=false','add','source.ts'],{cwd:root});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const tool = join(root,'node_modules/gitnexus');
  await mkdir(join(tool,'dist/config'),{recursive:true});
  await mkdir(join(tool,'dist/cli'),{recursive:true});
  await mkdir(join(tool,'dist/core/ingestion/utils'),{recursive:true});
  await writeFile(join(tool,'package.json'), JSON.stringify({name:'gitnexus',version:'1.6.9',type:'module'}));
  await symlink(join(project,'node_modules'),join(tool,'node_modules'),'junction');
  await writeFile(join(tool,'dist/config/ignore-service.js'), `export async function createIgnoreFilter() {return {childrenIgnored(p){return ['node_modules','.git'].includes(p.name)}, ignored(){return false}}}`);
  await writeFile(join(tool,'dist/cli/analyze-config.js'), `import fs from 'node:fs';import path from 'node:path';export function loadAnalyzeConfig(root){try {const c=JSON.parse(fs.readFileSync(path.join(root,'.gitnexusrc')));return {...c,...c.analyze};}catch(e){if(e.code==='ENOENT')return {};throw e}}`);
  await writeFile(join(tool,'dist/core/ingestion/utils/max-file-size.js'), `export const DEFAULT_MAX_FILE_SIZE_BYTES=524288;export const getMaxFileSizeBytes=()=>524288;`);
  await writeFile(join(tool,'dist/cli/index.js'), `import fs from 'node:fs';import path from 'node:path'; const root=process.cwd();const a=process.argv.slice(2);let control={};try{control=JSON.parse(fs.readFileSync('.fake-control'))}catch{};if(control.sleep){setInterval(()=>{},1000)}else if(a[0]==='analyze'){if(control.fail)process.exit(1); if(!control.noArtifacts){fs.mkdirSync('.gitnexus',{recursive:true});fs.writeFileSync('.gitnexus/lbug','database');fs.writeFileSync('.gitnexus/gitnexus.json',JSON.stringify({repoPath:root,indexedAt:new Date().toISOString(),schemaVersion:5,fileHashes:{'source.ts':'hash'},capabilities:{graph:{status:'available'},fts:{status:'available'}},stats:{embeddings:0}}));}if(control.mutate)fs.appendFileSync('source.ts','// changed');console.log(JSON.stringify({args:a}));}else {if(control.mutate)fs.appendFileSync('source.ts','// changed');if(control.rewriteIndex){let m=JSON.parse(fs.readFileSync('.gitnexus/gitnexus.json'));m.indexedAt='rewritten';fs.writeFileSync('.gitnexus/gitnexus.json',JSON.stringify(m))}console.log(control.error?'{"error":"native failure"}':JSON.stringify({args:a,symbol:'target'}));}`);
  await mkdir(join(root,'.gitnexus'),{recursive:true});
  await writeFile(join(root,'.gitnexus/tool.json'), JSON.stringify({packageRoot:tool,version:'1.6.9'}));
  const execute = async (args) => {let out='',err='';const code=await wrapper.runCli(args,{repoRoot:root,stdout:s=>out+=s,stderr:s=>err+=s});return {code,out,err}};
  const control = v => writeFile(join(root,'.fake-control'),JSON.stringify(v));
  return {root,tool,execute,control};
}

test('unavailable query never installs and help never certifies an index', async t => {
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);
  await rm(join(f.root,'.gitnexus/tool.json'));
  assert.equal((await f.execute(['query','target'])).code,2);
  assert.equal((await f.execute(['analyze','--help'])).code,0);
  await assert.rejects(readFile(join(f.root,'.gitnexus/manifest.json')));
});

test('real argv process preserves shell characters; unchanged index query stays ready', async t => {
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);
  assert.equal((await f.execute(['analyze'])).code,0);
  const text='target & echo hacked | $(x) `z` "quotes"';
  const q=await f.execute(['query',text]);assert.equal(q.code,0,q.err);
  assert.deepEqual(JSON.parse(q.out).args,['query',text,'--limit','5','--repo',f.root]);
  assert.equal((await f.execute(['status'])).code,0);
});

for (const mutation of ['source','untracked','delete','rename','database','metadata','repo','pin','config']) test(`refuses stale or invalid index after ${mutation}`,async t=>{
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);
  if(mutation==='source'){await writeFile(join(f.root,'source.ts'),'first');assert.equal((await f.execute(['query','target'])).code,2);await writeFile(join(f.root,'source.ts'),'second')}
  if(mutation==='untracked')await writeFile(join(f.root,'caller.ts'),'target()');
  if(mutation==='delete')await rm(join(f.root,'source.ts'));
  if(mutation==='rename')await rename(join(f.root,'source.ts'),join(f.root,'renamed.ts'));
  if(mutation==='database')await rm(join(f.root,'.gitnexus/lbug'));
  if(mutation==='metadata')await writeFile(join(f.root,'.gitnexus/gitnexus.json'),'broken');
  if(mutation==='repo'){const p=join(f.root,'.gitnexus/manifest.json');const m=JSON.parse(await readFile(p));m.repoPath=tmpdir();await writeFile(p,JSON.stringify(m))}
  if(mutation==='pin')await writeFile(join(f.tool,'package.json'),'{"name":"gitnexus","version":"9.9.9","type":"module"}');
  if(mutation==='config')await writeFile(join(f.root,'.gitnexusignore'),'caller.ts');
  const q=await f.execute(['query','target']);assert.equal(q.code,2,q.err);assert.equal(q.out,'');
});

for(const control of [{mutate:true},{rewriteIndex:true},{error:true}])test(`query discards results on ${JSON.stringify(control)}`,async t=>{
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);await f.control(control);const q=await f.execute(['query','target']);assert.equal(q.code,2);assert.equal(q.out,'');
});
for(const control of [{mutate:true},{fail:true},{noArtifacts:true},{sleep:true}])test(`analyze cannot certify ${JSON.stringify(control)}`,async t=>{
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);await f.control(control);assert.equal((await f.execute(['analyze','--timeout-ms','1000'])).code,2);await assert.rejects(readFile(join(f.root,'.gitnexus/manifest.json')));await assert.rejects(readFile(join(f.root,'.gitnexus/wrapper.lock')));
});

test('exclusive writer rejects concurrent analyze immediately',async t=>{
  assert.equal(typeof wrapper.runCli,'function');const f=await fixture(t);await f.control({sleep:true});const first=f.execute(['analyze','--timeout-ms','1000']);await new Promise(r=>setTimeout(r,100));const second=await f.execute(['analyze']);assert.equal(second.code,2);assert.match(second.err,/busy/);await first;
});

for(const config of [{embeddings:true},{pdg:true},{maxFileSize:'1024'},{name:'another'}])test(`rejects unsafe repo config ${JSON.stringify(config)}`,async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'.gitnexusrc'),JSON.stringify(config));const q=await f.execute(['analyze']);assert.equal(q.code,64);await assert.rejects(readFile(join(f.root,'.gitnexus/manifest.json')));
});
test('rejects ambient scope and embedding switches without exposing credential values',async t=>{
  const f=await fixture(t);const key='GITNEXUS_EMBEDDING_API_KEY';const old=process.env[key];process.env[key]='secret-fixture-not-for-logs';try{const q=await f.execute(['analyze']);assert.equal(q.code,64);assert.ok(!q.err.includes(process.env[key]));}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
test('initial/config rebuild uses force once; normal source delta keeps incremental',async t=>{
  const f=await fixture(t);const first=await f.execute(['analyze']);assert.equal(first.code,0,first.err);assert.ok(JSON.parse(first.err).args.includes('--force'));
  const second=await f.execute(['analyze']);assert.equal(second.code,0,second.err);assert.ok(!JSON.parse(second.err).args.includes('--force'));
  await writeFile(join(f.root,'source.ts'),'export const updated = 2;');const delta=await f.execute(['analyze']);assert.equal(delta.code,0,delta.err);assert.ok(!JSON.parse(delta.err).args.includes('--force'));
  await writeFile(join(f.root,'.gitnexusignore'),'not-a-runtime-path/');const config=await f.execute(['analyze']);assert.equal(config.code,0,config.err);assert.ok(JSON.parse(config.err).args.includes('--force'));
});
test('file shrinking below upstream size cap invalidates existing snapshot',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'big.ts'),'x'.repeat(524289));assert.equal((await f.execute(['analyze'])).code,0);await writeFile(join(f.root,'big.ts'),'target()');assert.equal((await f.execute(['query','target'])).code,2);
});
test('native pending metadata and missing query capability are refused',async t=>{
  const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);const path=join(f.root,'.gitnexus/gitnexus.json');const m=JSON.parse(await readFile(path));m.incrementalInProgress={startedAt:Date.now()};await writeFile(path,JSON.stringify(m));assert.equal((await f.execute(['query','target'])).code,2);
});
test('direct CLI uses its own repository even when invoked from another cwd',async t=>{
  const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);
  const text='literal & | $(x) `y` "q"';const result=spawnSync(process.execPath,[join(f.root,'scripts/run-pinned-gitnexus.mjs'),'query',text],{cwd:project,encoding:'utf8',shell:false});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).args[1],text);
});
test('npm script invocation preserves spaces and shell metacharacters',async t=>{
  const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);
  const npmCli=process.env.npm_execpath??(process.platform==='win32'?'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js':resolve(process.execPath,'../../lib/node_modules/npm/bin/npm-cli.js'));
  const text='target & echo unexpected | $(x) `z` "quotes"';
  const result=spawnSync(process.execPath,[npmCli,'run','--silent','graph:query','--',text],{cwd:f.root,encoding:'utf8',shell:false,env:{...process.env,PATH:join(process.execPath,'..')+(process.platform==='win32'?';':':')+process.env.PATH}});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).args[1],text);
});
test('status reports unavailable as structured data without a local tool',async t=>{
  const f=await fixture(t);await rm(join(f.root,'.gitnexus/tool.json'));const status=await f.execute(['status']);assert.equal(status.code,2);assert.equal(JSON.parse(status.out).status,'missing');
});
test('snapshot work consumes the same analyze deadline',async t=>{
  const f=await fixture(t);await writeFile(join(f.tool,'dist/config/ignore-service.js'),`export async function createIgnoreFilter(){await new Promise(r=>setTimeout(r,2000));return {ignored(){return false},childrenIgnored(p){return p.name==='node_modules'}}}`);
  const start=performance.now();const result=await f.execute(['analyze','--timeout-ms','1000']);assert.equal(result.code,2);assert.ok(performance.now()-start<1600,'snapshot must not extend the operation deadline');
});
test('timeout terminates native descendants before releasing its lock',async t=>{
  const f=await fixture(t);const cli=join(f.tool,'dist/cli/index.js');let code=await readFile(cli,'utf8');code=code.replace("import fs from 'node:fs';", "import {spawn} from 'node:child_process';import fs from 'node:fs';");code=code.replace('if(control.sleep){setInterval',`if(control.sleep){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync('.fake-childpid',String(child.pid));setInterval`);await writeFile(cli,code);await f.control({sleep:true});const result=await f.execute(['analyze','--timeout-ms','1000']);assert.equal(result.code,2);const pid=Number(await readFile(join(f.root,'.fake-childpid'),'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');await assert.rejects(readFile(join(f.root,'.gitnexus/wrapper.lock')));
});
test('query rejects a locator stamped for another pin even if target package exists',async t=>{
  const f=await fixture(t);assert.equal((await f.execute(['analyze'])).code,0);await writeFile(join(f.root,'.gitnexus/tool.json'),JSON.stringify({packageRoot:f.tool,version:'9.9.9'}));assert.equal((await f.execute(['query','target'])).code,2);
});

import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {captureSnapshot} from '../lib/gitnexus-state.mjs';

test('snapshot rejects Promise lstat failures swallowed by the native glob walker', async t => {
  const f = await fixture(t);
  const baseline = await captureSnapshot(f.root, {packageRoot:f.tool,version:'1.6.9'});
  assert.ok(baseline.sourceDigest);
  const original = fs.promises.lstat;
  let injected = 0;
  fs.promises.lstat = async () => {
    injected++;
    throw Object.assign(new Error('fixture denied'), {code:'EACCES'});
  };
  try {
    await assert.rejects(
      captureSnapshot(f.root, {packageRoot:f.tool,version:'1.6.9'}),
      e => e.code === 2 && /traversal/.test(e.message),
    );
    assert.ok(injected > 0, 'exercise the dependency Promise lstat boundary');
  } finally {
    fs.promises.lstat = original;
  }
});

for (const mode of ['error','nonzero','hang']) {
  test(`failed Windows tree killer ${mode} returns promptly and retains writer lock`, {skip:process.platform !== 'win32'}, async t => {
    const f = await fixture(t);
    await f.control({sleep:true});
    const originalSpawn = childProcess.spawn;
    const children = [];
    childProcess.spawn = (command, args, options) => {
      let child;
      if (command === 'taskkill.exe') {
        child = mode === 'error'
          ? originalSpawn(join(f.root,'missing-taskkill.exe'), [], options)
          : originalSpawn(process.execPath, ['-e', mode === 'nonzero' ? 'process.exit(1)' : 'setInterval(()=>{},1000)'], options);
      } else {
        child = originalSpawn(command, args, options);
      }
      if (child.pid) children.push(child.pid);
      return child;
    };
    syncBuiltinESMExports();
    let result;
    let elapsed;
    let lockExists;
    try {
      const start = performance.now();
      result = await Promise.race([
        f.execute(['analyze','--timeout-ms','1000']),
        new Promise(resolve => setTimeout(() => resolve({pending:true}), 2300)),
      ]);
      elapsed = performance.now() - start;
      lockExists = JSON.parse(await readFile(join(f.root,'.gitnexus/wrapper.lock'),'utf8'));
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      // Only clean up the real processes created by this test, never another run's tree.
      for (const pid of children) spawnSync('taskkill.exe', ['/PID',String(pid),'/T','/F'], {stdio:'ignore',windowsHide:true,shell:false});
    }
    assert.equal(result.code, 2, 'operation must settle without waiting for the live writer to close');
    assert.ok(elapsed < 2100, `termination failure exceeded bounded cleanup: ${elapsed}ms`);
    assert.equal(lockExists.pid, process.pid, 'unconfirmed writer lock must remain owned');
    assert.match(result.err, /termination unconfirmed/);
  });
}
