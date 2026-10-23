#!/usr/bin/env node
// Explicit TEST-only live smoke. One parent owns the TEST lease for the entire
// fixture → official fleet receipt → retirement lifecycle. Originals/audit stay
// in TEST; no cloned business subject, trigger bypass or production write.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { credential, ketNoi, lit, psql, psqlJson, repoRoot } from './lib.mjs';
import { matKhauTest } from './hau-ky.mjs';
import { chromeBuildEnv } from './chrome.mjs';
import { probeTarget, verifyTestTarget } from '../lib/e2e-fleet-runner.mjs';
import { assertTestLease, withTestCleanup, withTestLock } from './lock.mjs';
import { inspectFixture, METER_TEST_REF, newFixture, provisionFixture, retireFixture, verifyFixture } from './meter-capture-fixture.mjs';

const exec = promisify(execFile), TEST_ORIGIN=`https://${METER_TEST_REF}.supabase.co`;
const git=(...args)=>execFileSync('git',args,{cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function child(command,args,env,onOutput=chunk=>process.stdout.write(chunk)){
 const processChild=spawn(command,args,{cwd:repoRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 processChild.stdout.on('data',onOutput);processChild.stderr.on('data',onOutput);
 return {child:processChild,done:new Promise((yes,no)=>{processChild.once('error',no);processChild.once('close',code=>yes(code));})};
}
async function stopOwned(run){
 if(!run||run.child.exitCode!==null)return;
 if(process.platform==='win32')await exec('taskkill',['/PID',String(run.child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
 else run.child.kill('SIGTERM');
 await run.done;
}
export async function requestTestJson(url,options,fetcher=fetch){
 assert.equal(new URL(url).origin,TEST_ORIGIN,'Only the fixed TEST endpoint is permitted');
 const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(60_000)});
 if(!response.ok){
  const payload=await response.json().catch(()=>null);
  const safeCode=/^(?:[0-9A-Z]{5}|PGRST[0-9]{3}|(?:meter_capture_|worker_|original_|evidence_|invalid_)[a-z0-9_]{1,48}|unauthorized)$/;
  const code=payload&&typeof payload==='object'?[payload.code,payload.error].find(value=>typeof value==='string'&&value.length<=64&&safeCode.test(value)):null;
  throw new Error(`TEST endpoint ${new URL(url).pathname} returned HTTP ${response.status}${code?` (${code})`:''}.`);
 }
 return response.json();
}
const json=requestTestJson;

export function matchesTestBuild(manifest,index,sha){
 return manifest?.projectRef===METER_TEST_REF&&manifest?.sourceSha===sha&&typeof index==='string'
  &&index.includes(`name="build-sha" content="${sha}"`)
  &&manifest?.indexSha256===createHash('sha256').update(index).digest('hex');
}
async function startTestPreview(cred,sha,base){
 const cache=resolve(repoRoot,'.cache'),output=resolve(cache,'meter-live-web');
 assert(output.startsWith(cache+sep),'Build output must stay in the owned workspace cache');
 const metadata=resolve(cache,'meter-live-web-build.json');
 await mkdir(cache,{recursive:true});
 const prior=await readFile(metadata,'utf8').then(JSON.parse).catch(()=>null);
 const index=await readFile(resolve(output,'index.html'),'utf8').catch(()=>null);
 const env=chromeBuildEnv(cred,sha),viteBin=resolve(repoRoot,'node_modules/vite/bin/vite.js');
 if(!matchesTestBuild(prior,index,sha)){
  console.log(JSON.stringify({event:'meter_test_build_started',sourceSha:sha}));
  let log='';const build=child(process.execPath,[viteBin,'build','--outDir',output,'--emptyOutDir'],env,chunk=>{log+=chunk.toString();});
  const timer=setTimeout(()=>{void stopOwned(build).catch(()=>{});},15*60_000);
  try{assert.equal(await build.done,0,'TEST build failed; inspect ignored meter-live-web-build.log');}
  finally{clearTimeout(timer);await writeFile(resolve(cache,'meter-live-web-build.log'),log);}
  const built=await readFile(resolve(output,'index.html'),'utf8');assert(built.includes(`name="build-sha" content="${sha}"`));
  await writeFile(metadata,JSON.stringify({projectRef:METER_TEST_REF,sourceSha:sha,indexSha256:createHash('sha256').update(built).digest('hex')}));
 }
 // Static preview avoids the reproduced dev-server stall after its first HTML
 // response. No TEST fixture is written until the same target verifier passes.
 const run=child(process.execPath,[viteBin,'preview','--outDir',output,'--host','127.0.0.1','--port',new URL(base).port,'--strictPort'],env,()=>{});
 try{
  let ready=false;for(let i=0;i<60;i++){
   if(run.child.exitCode!==null)throw new Error('TEST preview failed; loopback port may already be occupied');
   try{const response=await fetch(base,{signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.text()).includes(`name="build-sha" content="${sha}"`)){ready=true;break;}}catch{}
   await new Promise(yes=>setTimeout(yes,500));
  }assert(ready,'TEST preview did not become ready');
  const probe=await probeTarget({origin:base,fetchText:async url=>{
   assert.equal(new URL(url).origin,base);const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15_000)});
   if(!response.ok)throw new Error(`TEST preview HTTP ${response.status}`);return response.text();
  }});const verdict=verifyTestTarget(probe);assert.equal(verdict.ok,true,'TEST preview project verification failed');assert.equal(probe.buildSha,sha);
  console.log(JSON.stringify({event:'meter_test_preview_ready',sourceSha:sha,base}));return run;
 }catch(error){await stopOwned(run);throw error;}
}

async function main(){
 assert.deepEqual(process.argv.slice(2),['--run'],'Usage: node scripts/test-env/meter-capture-live.mjs --run');
 assert.equal(git('status','--porcelain'),'', 'Commit reviewed source first; official receipt requires a clean worktree.');
 const sha=git('rev-parse','HEAD');
 if(process.env.EXPECTED_SOURCE_SHA)assert.equal(process.env.EXPECTED_SOURCE_SHA,sha);
 const ffmpeg=process.env.FLEET_METER_FFMPEG,launcher=process.env.METER_LIVE_WORKER_LAUNCHER;
 assert(ffmpeg&&isAbsolute(ffmpeg),'Pinned absolute FLEET_METER_FFMPEG required');
 assert(launcher&&isAbsolute(launcher),'Reviewed absolute METER_LIVE_WORKER_LAUNCHER required');
 await realpath(ffmpeg);await realpath(launcher);
 const cred=credential();assert.equal(cred.testRef,METER_TEST_REF);assert(cred.testPat&&cred.testPublishableKey,'TEST PAT and publishable key required');
 const actorEmail=process.env.METER_TEST_ACTOR_EMAIL;assert(actorEmail,'TEST actor email must be supplied privately through env');
 const base=process.env.FLEET_BASE_URL??'http://127.0.0.1:5199';assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/,'This provisioner launches only its own TEST loopback preview');
 const preview=await startTestPreview(cred,sha,base);
 try{
 assert.equal(git('rev-parse','HEAD'),sha);assert.equal(git('status','--porcelain'),'','Source changed during TEST build');
 const {test}=await ketNoi(cred);
 await withTestLock({cred,test},async lease=>{
  const [actor]=psqlJson(test,`SELECT id FROM auth.users WHERE email=${lit(actorEmail)}`);assert(actor&&uuid.test(actor.id),'TEST actor missing');
  const fixture=newFixture(actor.id,sha,actorEmail),directory=resolve(repoRoot,'.cache',`meter-live-${fixture.fixtureId}`);
  await mkdir(directory,{recursive:true});
  let retired=false,server,activeWorker,inflight=Promise.resolve();
  const created={clientIds:[],captureIds:[]};
  const clean=async()=>{
   if(retired)return {fixtureId:fixture.fixtureId,state:'RETIRED',retainedImmutableAudit:true};
   await inflight;
   const receipt=await withTestCleanup(lease,test,cleanupLease=>retireFixture(cleanupLease,test,fixture,created));retired=true;return receipt;
  };
  try{
   await provisionFixture(lease,test,fixture);
   const password=matKhauTest(cred.passwordSeed,actorEmail);
   const session=await json(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:cred.testPublishableKey,'content-type':'application/json'},body:JSON.stringify({email:actorEmail,password})});
   assert.equal(session.user?.id,fixture.actorId);assert.equal(typeof session.access_token,'string');
   const headers={apikey:cred.testPublishableKey,authorization:`Bearer ${session.access_token}`};
   const reference=resolve(directory,'synthetic-reference.png');
   await exec(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=1280x720',
    '-vf',`drawtext=text='${fixture.currentValue}  kWh  1.8.0':x=140:y=220:fontsize=70:fontcolor=black,drawtext=text='${fixture.serial}':x=100:y=400:fontsize=25:fontcolor=black`,'-frames:v','1',reference],{timeout:30_000,windowsHide:true});
   await assertTestLease(lease,test);
   const referencePath=`${fixture.organizationId}/profiles/${fixture.meterId}/${fixture.actorId}/${randomUUID()}.png`;
   await json(`${TEST_ORIGIN}/storage/v1/object/meter-capture-media/${referencePath}`,{method:'POST',headers:{...headers,'content-type':'image/png','x-upsert':'false'},body:await readFile(reference)});
   const profile=await json(`${TEST_ORIGIN}/functions/v1/meter-capture-worker`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'rpc',organizationId:fixture.organizationId,rpcAction:'profile',payload:{meterId:fixture.meterId,serial:fixture.serial,registerCode:'1.8.0',decimalPlaces:2,displayKind:'DIGITAL',verified:true,expectedVersion:0,referencePath}})});
   assert.match(profile.qrText??'',/^ihome-meter:[0-9a-f-]{36}$/);fixture.qrText=profile.qrText;
   const modulePath=await realpath(resolve(repoRoot,'.e2e-fleet/support/meter-capture-lifecycle.mjs'));
   fixture.lifecycle={modulePath,sha256:createHash('sha256').update(await readFile(modulePath)).digest('hex'),retainImmutableAudit:true};
   await assertTestLease(lease,test);
   psql(test,`UPDATE test_env.meter_capture_fixtures SET manifest=${lit(JSON.stringify(fixture))}::jsonb WHERE fixture_id=${lit(fixture.fixtureId)} AND state='ACTIVE' AND manifest->>'marker'=${lit(fixture.marker)}`);
   const manifest=resolve(directory,'manifest.json');await writeFile(manifest,JSON.stringify(fixture,null,2));
   const token=randomBytes(32).toString('base64url');
   server=createServer(async(req,res)=>{
    const bearer=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);
    const fail=status=>{res.writeHead(status,{'content-type':'application/json'});res.end('{"error":"TEST fixture lifecycle rejected"}');};
    if(req.method!=='POST'||req.url!=='/'||bearer.length!==expected.length||!timingSafeEqual(bearer,expected))return fail(403);
    try{
     let body='';for await(const chunk of req){body+=chunk;if(body.length>16_384)throw new Error('Request too large');}
     const payload=JSON.parse(body);assert.equal(payload.fixtureId,fixture.fixtureId);assert(!retired,'Fixture already retired');
     if(payload.action==='retire'){
      const claimed=payload.created;assert(claimed&&Array.isArray(claimed.clientIds)&&Array.isArray(claimed.captureIds));
      for(const id of [...claimed.clientIds,...claimed.captureIds])assert.match(id,uuid);
      Object.assign(created,claimed);const result=await clean();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
     }
     const work=async()=>{
      await assertTestLease(lease,test);
      if(payload.action==='verify')return verifyFixture(lease,test,fixture);
      assert.equal(payload.action,'process');const id=payload.created?.captureId;assert.match(id??'',uuid);
      const ownership=inspectFixture(test,fixture);assert.equal(ownership?.state,'ACTIVE');assert.equal(ownership?.active,true);
      const [capture]=psqlJson(test,`SELECT id,client_id FROM app_private.meter_captures WHERE id=${lit(id)} AND organization_id=${lit(fixture.organizationId)} AND meter_id=${lit(fixture.meterId)} AND contract_id=${lit(fixture.contractId)} AND actor_id=${lit(fixture.actorId)} AND status='QUEUED' AND media_received`);assert.equal(capture?.id,id,'Worker capture scope mismatch');
      if(!created.captureIds.includes(id))created.captureIds.push(id);if(!created.clientIds.includes(capture.client_id))created.clientIds.push(capture.client_id);
      // Only this exact capture is passed to the reviewed one-job launcher.
      activeWorker=child(process.execPath,[launcher,'--capture',id],process.env);
      assert.equal(await activeWorker.done,0,'TEST worker did not commit and invalidate its temporary token');activeWorker=null;
      await assertTestLease(lease,test);return {captureId:id,completed:true};
     };
     const pending=inflight.then(work);inflight=pending.then(()=>{},()=>{});
     const result=await pending;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){console.error(`Fixture lifecycle rejected: ${error.name}`);fail(500);}
   });
   server.requestTimeout=0;await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
   const address=server.address();assert(address&&typeof address==='object');
   const fleetEnv={...process.env,FLEET_BASE_URL:base,FLEET_TARGET_ENV:'TEST',FLEET_AGENT:'codex',FLEET_WORKERS:'1',FLEET_METER_LIVE:'1',EXPECTED_SOURCE_SHA:sha,
    TEST_SUPABASE_PUBLISHABLE_KEY:cred.testPublishableKey,FLEET_PASS_TEST_CHU:password,FLEET_METER_FIXTURE_MANIFEST:manifest,
    METER_FIXTURE_LIFECYCLE_URL:`http://127.0.0.1:${address.port}`,METER_FIXTURE_LIFECYCLE_TOKEN:token};
   console.log(JSON.stringify({event:'meter_fixture_ready',project:METER_TEST_REF,fixtureId:fixture.fixtureId,sourceSha:sha,base}));
   const runner=child(process.execPath,[resolve(repoRoot,'scripts/e2e-fleet-bien-nhan.mjs'),'--base',process.env.FLEET_RECEIPT_BASE??'origin/main','--spec','.e2e-fleet/specs/meter-capture-live.spec.ts'],fleetEnv);
   const code=await runner.done;assert.equal(code,0,'Official fleet receipt runner failed; retain its red receipt');
  }finally{
   // Wait for worker completion/rotation before cleanup. Losing lease or a still
   // RUNNING job fails closed and leaves active_run for explicit recovery.
   if(activeWorker)await activeWorker.done.catch(()=>{});
   await inflight;
   try{await clean();}finally{if(server)await new Promise(yes=>server.close(yes));}
  }
 });
 }finally{await stopOwned(preview);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(`Meter TEST live smoke stopped: ${error.name}: ${error.message}`);process.exitCode=1;});
}
