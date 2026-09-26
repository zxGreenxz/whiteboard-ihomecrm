import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabServer } from './server.mjs';
import { request as httpRequest } from 'node:http';

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'voice-server-'));const dist=join(dir,'dist');await mkdir(dist);await writeFile(join(dist,'index.html'),'<html>Lab</html>');
  const server=await createLabServer({accessCode:'test-only-code',publicOrigin:'https://pilot.example',dataDir:join(dir,'private'),distDir:dist,port:0,provider:{capabilities:async()=>({chatModels:['chat-a'],sttModels:['stt-a'],defaultChatModel:'chat-a',defaultSttModel:'stt-a',providerReady:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
  const login=async()=>{const response=await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({code:'test-only-code'})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
  return {server,base,login};
}
test('unauthenticated routes do not disclose provider info or stored records',async t=>{
  const {base}=await setup(t);assert.deepEqual(await(await fetch(`${base}/api/status`)).json(),{authenticated:false});
  assert.equal((await fetch(`${base}/api/evaluations`)).status,401);
  const response=await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({code:'wrong'})});assert.equal(response.status,401);
});
test('exact origin check blocks cross-site mutation and public cookies are Secure HttpOnly Strict',async t=>{
  const {base}=await setup(t);
  for(const origin of ['https://attacker.example','https://pilot.example.attacker']) assert.equal((await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({code:'test-only-code'})})).status,403);
  const response=await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin:'https://pilot.example'},body:JSON.stringify({code:'test-only-code'})});assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
});
test('session rate limit blocks the sixth attempt even with the right code',async t=>{
  const {base}=await setup(t);
  for(let i=0;i<5;i++) assert.equal((await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:'{"code":"bad"}'})).status,401);
  assert.equal((await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:'{"code":"test-only-code"}'})).status,429);
});
test('authenticated status works and oversized audio is rejected before provider call',async t=>{
  const {base,login}=await setup(t);const cookie=await login();const status=await(await fetch(`${base}/api/status`,{headers:{cookie}})).json();assert.equal(status.authenticated,true);
  const response=await fetch(`${base}/api/transcribe?model=stt-a`,{method:'POST',headers:{cookie,origin:base,'content-type':'audio/webm'},body:Buffer.alloc(10*1024*1024+1)});assert.equal(response.status,413);
});
test('static serving blocks source, dotfiles, traversal and unknown files',async t=>{
  const {base}=await setup(t);assert.equal((await fetch(base)).status,200);
  for(const path of ['/server.mjs','/.env','/package.json','/%2e%2e%2fserver.mjs','/missing.js']) assert.equal((await fetch(base+path)).status,404,path);
});
test('streamed audio without Content-Length still receives a structured 413 error',async t=>{
  const {base,login}=await setup(t);const cookie=await login();
  const status=await new Promise((resolve,reject)=>{
    const request=httpRequest(`${base}/api/transcribe?model=stt-a`,{method:'POST',headers:{cookie,origin:base,'content-type':'audio/webm'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);for(let i=0;i<11;i++)request.write(Buffer.alloc(1024*1024));request.end();
  });
  assert.equal(status,413);
});
test('evaluation write, correction and export retain exactly one trial through the HTTP API',async t=>{
  const {base,login}=await setup(t);const cookie=await login();
  const predicted={title:'Sửa vòi',description:'Sửa vòi rò',building:'A',room:'101',jobType:'',assignee:'',deadline:'',priority:'NORMAL'};
  const record={id:'http-trial',transcript:'Sửa vòi',transcriptSource:'manual',sttModel:null,chatModel:'chat-a',predicted,expected:{...predicted},verdicts:{title:'correct',building:'not_applicable',room:'incorrect',jobType:'not_applicable',assignee:'not_applicable',deadline:'not_applicable',priority:'correct'},usefulness:3,notes:'',latencyMs:{transcription:null,extraction:123}};
  for(const usefulness of [3,4]){const response=await fetch(`${base}/api/evaluations`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({...record,usefulness})});assert.equal(response.status,200);assert.equal((await response.json()).summary.totalRecords,1);}
  const exported=await fetch(`${base}/api/export`,{headers:{cookie}});assert.match(exported.headers.get('content-disposition'),/attachment/);const data=await exported.json();assert.equal(data.records.length,1);assert.equal(data.records[0].usefulness,4);assert.equal(data.summary.usefulnessRate,100);
});
