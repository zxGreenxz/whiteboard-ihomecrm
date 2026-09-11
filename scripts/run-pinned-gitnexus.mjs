#!/usr/bin/env node
// Optional local graph CLI. Source remains the fallback whenever this tool is unavailable.
import {spawn} from 'node:child_process';
import {mkdir, open, readFile, writeFile, rename, unlink, readdir, realpath, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join, resolve, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureSnapshot, inspectIndex, nativeStamp, validateInstallation, normalizedEnvironment, json, digest, fail, checkDeadline} from './lib/gitnexus-state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ANALYZE_ARGS = ['--index-only','--skip-agents-md','--worker-timeout','60'];
const HELP = 'GitNexus local: help | smoke | status | analyze [--timeout-ms 1000..900000] | query <text> | context <symbol> | impact <symbol> | trace <from> <to>\nQuery unavailable: use source search. Analyze is explicit; queries never install or rebuild.\n';
const QUERY_OPTIONS = {
  query: ['--context','--goal','--limit','--content'],
  context: ['--uid','--file','--limit','--content'],
  impact: ['--uid','--file','--kind','--direction','--depth','--limit','--include-tests','--summary-only'],
  trace: ['--from-uid','--from-file','--to-uid','--to-file','--depth','--include-tests'],
};
const FLAGS = new Set(['--content','--include-tests','--summary-only']);
const ALIASES = {'-l':'--limit','-f':'--file','-u':'--uid','-d':'--direction','-c':'--context','-g':'--goal'};
function positive(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw fail('invalid numeric option',64);
  return Number(value);
}
export function parseArgs(argv) {
  const [sub = 'help',...rest] = argv;
  if (sub === 'help' || sub === '--help' || sub === '--version') {
    if(rest.length)throw fail('unexpected arguments',64);
    return {sub:'help',version:sub==='--version'};
  }
  if (!['smoke','status','analyze',...Object.keys(QUERY_OPTIONS)].includes(sub)) throw fail('unsupported command',64);
  let timeoutMs = sub === 'analyze' || sub === 'smoke' ? 120000 : 30000;
  const nativeArgs = [sub],bounds={}, seen=new Set();let positional=0,help=false;
  for(let i=0;i<rest.length;i++) {
    const raw=rest[i];
    if(raw==='--help'||raw==='-h'){help=true;continue;}
    if(raw.startsWith('-')) {
      const equal=raw.indexOf('=');let key=equal<0?raw:raw.slice(0,equal);key=ALIASES[key]??key;
      if(key==='--timeout-ms' && sub==='analyze') {
        const value=equal<0?rest[++i]:raw.slice(equal+1);timeoutMs=positive(value,1000,900000);continue;
      }
      if(!QUERY_OPTIONS[sub]?.includes(key) || seen.has(key)) throw fail('unsupported or duplicate option',64);
      seen.add(key);nativeArgs.push(key);
      if(FLAGS.has(key)){if(equal>=0)throw fail('flag takes no value',64);continue;}
      const value=equal<0?rest[++i]:raw.slice(equal+1);
      if(value===undefined||value.startsWith('--'))throw fail('missing option value',64);
      if(key==='--limit'||key==='--depth')bounds[key.slice(2)]=positive(value);
      if(key==='--direction'&&!['upstream','downstream'].includes(value))throw fail('invalid direction',64);
      nativeArgs.push(value);
    } else {positional++;nativeArgs.push(raw);}
  }
  if (help) return {sub:'help'};
  if (sub==='trace' ? positional!==2 : QUERY_OPTIONS[sub] ? positional!==1 && !(positional===0&&seen.has('--uid')) : positional!==0) throw fail('unexpected positional arguments',64);
  const defaults={query:{limit:5},context:{limit:20},impact:{depth:2,limit:20},trace:{depth:6}}[sub]??{};
  for(const [key,value] of Object.entries(defaults)) if(bounds[key]===undefined){bounds[key]=value;nativeArgs.push(`--${key}`,String(value));}
  return {sub,nativeArgs,bounds,timeoutMs};
}

// One monotonic deadline covers every subprocess and both snapshot passes.
export function runProcess(command,args,{cwd,env,deadline,outputLimit=16*1024*1024}) {
  checkDeadline(deadline);
  return new Promise((resolveResult,reject)=>{
    const child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',failure,killPromise;
    const stop = reason => {
      if(killPromise)return;failure=reason;
      killPromise=(async()=>{
        if(!child.pid)return;
        if(process.platform==='win32') {
          await new Promise((res,rej)=>{
            const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
            killer.on('error',rej);killer.on('close',code=>code===0?res():rej(fail('process tree termination unconfirmed')));
          });
        } else {try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
      })();
      // Handle rejection now; close awaits it before releasing the operation lock.
      killPromise.catch(()=>{});
    };
    const timer=setTimeout(()=>stop(fail('timeout')),Math.max(1,deadline-performance.now()));
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>outputLimit)stop(fail('native output limit exceeded'));});
    child.stderr.on('data',data=>{stderr+=data;if(stderr.length>outputLimit)stop(fail('native output limit exceeded'));});
    child.on('error',e=>{clearTimeout(timer);reject(fail(`process unavailable: ${e.code??'error'}`));});
    child.on('close',async code=>{
      clearTimeout(timer);
      try{if(killPromise)await killPromise;}catch{reject(Object.assign(fail('process tree termination unconfirmed'),{retainLock:true}));return;}
      if(failure)reject(failure);else resolveResult({code,stdout,stderr});
    });
  });
}

async function atomic(path,value) {
  const temp=`${path}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  try{await rename(temp,path);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function lock(repoRoot) {
  const path=join(repoRoot,'.gitnexus/wrapper.lock');await mkdir(dirname(path),{recursive:true});
  const token=randomUUID();let handle;
  try{handle=await open(path,'wx');}catch(e){if(e.code==='EEXIST')throw fail('busy: local graph operation already owns lock');throw e;}
  await handle.writeFile(JSON.stringify({token,pid:process.pid,repoRoot}));await handle.close();
  return async()=>{if((await json(path)).token===token)await unlink(path);};
}
async function locateNpm() {
  const candidates=[process.env.npm_execpath,...(process.env.PATH??'').split(delimiter).flatMap(dir=>[join(dir,'node_modules/npm/bin/npm-cli.js'),join(dir,'npm/node_modules/npm/bin/npm-cli.js')])].filter(Boolean);
  for(const path of candidates){try{if((await stat(path)).isFile())return path;}catch{}}
  throw fail('npm CLI unavailable; run analyze through npm with Node 24');
}
async function installation(repoRoot,version,mayInstall,options) {
  const locator=join(repoRoot,'.gitnexus/tool.json');
  try{const saved=await json(locator);if(saved.version!==version)throw fail('locator pin mismatch');return await validateInstallation(saved.packageRoot,version);}catch{if(!mayInstall)throw fail('tool unavailable; run graph:analyze explicitly');}
  const npm=await locateNpm();
  const cacheResult=await runProcess(process.execPath,[npm,'config','get','cache'],options);
  if(cacheResult.code!==0)throw fail('npm cache unavailable');
  const cache=join(cacheResult.stdout.trim(),'_npx');
  async function scan(){
    const candidates=[join(repoRoot,'node_modules/gitnexus')];
    try{for(const entry of await readdir(cache))candidates.push(join(cache,entry,'node_modules/gitnexus'));}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const candidate of candidates){checkDeadline(options.deadline);try{return await validateInstallation(candidate,version);}catch{}}
  }
  let tool=await scan();
  if(!tool){
    const installed=await runProcess(process.execPath,[npm,'exec','--yes',`--package=gitnexus@${version}`,'--','gitnexus','--version'],options);
    if(installed.code!==0)throw fail('pin installation unavailable');tool=await scan();
  }
  if(!tool)throw fail('installed pin not found');
  await atomic(locator,{packageRoot:tool.packageRoot,version:tool.version});return tool;
}

export async function runCli(argv,{repoRoot=ROOT,stdout=s=>process.stdout.write(s),stderr=s=>process.stderr.write(s)}={}) {
  let release,retainLock=false,command;
  try {
    const parsed=parseArgs(argv);command=parsed.sub;
    if(parsed.sub==='help'){stdout(parsed.version?'project GitNexus wrapper (pin: tooling/agent-tools.json)\n':HELP);return 0;}
    const deadline=performance.now()+parsed.timeoutMs;
    repoRoot=await realpath(repoRoot);
    const env=normalizedEnvironment();
    const pin=(await json(join(repoRoot,'tooling/agent-tools.json'))).gitnexus;
    if(!/^\d+\.\d+\.\d+$/.test(pin?.version??'')||JSON.stringify(pin.analyzeArgs)!==JSON.stringify(ANALYZE_ARGS))throw fail('unsupported pin configuration');
    release=await lock(repoRoot);
    const processOptions={cwd:repoRoot,env,deadline};
    const tool=await installation(repoRoot,pin.version,['analyze','smoke'].includes(parsed.sub),processOptions);
    if(parsed.sub==='smoke'){
      const r=await runProcess(process.execPath,[tool.cliPath,'--version'],processOptions);
      if(r.code!==0||r.stdout.trim()!==tool.version)throw fail('native smoke version mismatch');
      const doctor=await runProcess(process.execPath,[tool.cliPath,'doctor'],processOptions);
      if(doctor.code!==0)throw fail('native doctor unavailable');
      stdout(JSON.stringify({status:'available',version:tool.version})+'\n');return 0;
    }
    const snapshotOptions={...tool,deadline,env};
    const before=await captureSnapshot(repoRoot,snapshotOptions);
    const state=await inspectIndex(repoRoot,{...before,toolVersion:tool.version});
    if(parsed.sub==='status'){
      stdout(JSON.stringify({status:state.status,reason:state.reason,baseCommit:state.baseCommit})+'\n');return state.status==='ready'?0:2;
    }
    if(parsed.sub==='analyze'){
      const manifestPath=join(repoRoot,'.gitnexus/manifest.json');
      let previous;try{previous=await json(manifestPath);}catch{}
      let stamp;try{stamp=await nativeStamp(repoRoot);}catch{}
      const compatible=previous?.schemaVersion===2&&previous.repoPath===repoRoot&&previous.toolVersion===tool.version&&previous.configDigest===before.configDigest&&stamp&&JSON.stringify(previous.nativeStamp)===JSON.stringify(stamp);
      // Invalidate provenance BEFORE starting any native writer, even when it fails.
      await unlink(manifestPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
      const args=[tool.cliPath,'analyze',repoRoot,...ANALYZE_ARGS,'--name',`ihome-${digest(repoRoot).slice(0,20)}`];
      if(!compatible)args.push('--force','--drop-embeddings');
      const r=await runProcess(process.execPath,['--max-old-space-size=8192',...args],processOptions);
      stderr(r.stdout);stderr(r.stderr);
      if(r.code!==0)throw fail('native analyze failed');
      const after=await captureSnapshot(repoRoot,snapshotOptions);
      if(JSON.stringify(before)!==JSON.stringify(after))throw fail('source/config changed during analyze');
      const freshStamp=await nativeStamp(repoRoot);
      // Upstream can report up-to-date based on git status; never bless changed source that it did not index.
      if(previous?.sourceDigest!==before.sourceDigest&&stamp&&JSON.stringify(stamp)===JSON.stringify(freshStamp))throw fail('native analyzer did not update changed source');
      const head=await runProcess('git',['rev-parse','HEAD'],processOptions);
      if(head.code!==0)throw fail('Git base commit unavailable');
      checkDeadline(deadline);
      await atomic(manifestPath,{schemaVersion:2,repoPath:repoRoot,baseCommit:head.stdout.trim(),toolVersion:tool.version,...after,nativeStamp:freshStamp,toolLocator:{packageRoot:tool.packageRoot},completedAt:new Date().toISOString()});
      stdout(JSON.stringify({status:'ready',reason:'snapshot matches local index'})+'\n');return 0;
    }
    if(state.status!=='ready')throw fail(`${state.status}: ${state.reason}`);
    if(parsed.sub==='query'&&state.manifest.nativeStamp.capabilities?.fts?.status!=='available')throw fail('native FTS unavailable');
    const r=await runProcess(process.execPath,[tool.cliPath,...parsed.nativeArgs,'--repo',repoRoot],processOptions);
    if(r.code!==0)throw fail('native query failed');
    let payload;try{payload=JSON.parse(r.stdout);}catch{throw fail('native query did not return JSON');}
    if(!payload||typeof payload!=='object'||payload.error||payload.isError||payload.status==='error')throw fail('native query returned error');
    const after=await captureSnapshot(repoRoot,snapshotOptions);
    const finalState=await inspectIndex(repoRoot,{...after,toolVersion:tool.version});
    if(JSON.stringify(before)!==JSON.stringify(after)||finalState.status!=='ready'||JSON.stringify(finalState.manifest.nativeStamp)!==JSON.stringify(state.manifest.nativeStamp))throw fail('source/index changed during query');
    checkDeadline(deadline);
    stderr(`GitNexus bounds ${JSON.stringify(parsed.bounds)}; limited results do not prove absence of other relations.\n`);
    stdout(JSON.stringify(payload)+'\n');return 0;
  }catch(e){retainLock=!!e.retainLock;if(command==='status')stdout(JSON.stringify({status:e.message?.startsWith('busy:')?'busy':'missing',reason:'local tool/index unavailable'})+'\n');stderr(`GitNexus unavailable: ${typeof e.code==='number'?e.message:'local tool/index read failed'}. Use source fallback.\n`);return e.code===64?64:2;}
  finally{if(release&&!retainLock)await release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runCli(process.argv.slice(2));
