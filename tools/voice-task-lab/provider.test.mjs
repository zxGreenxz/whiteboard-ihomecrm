import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './provider.mjs';
const draft={title:'Sửa vòi',description:'Sửa vòi bị rò',building:'A',room:'101',jobType:'',assignee:'',deadline:'',priority:'NORMAL'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const fixture=(handler)=>createProvider({baseUrl:'http://127.0.0.1:9999/v1',apiKey:'private-key',fetchImpl:async(url,options)=>{
  if(url.endsWith('/models')) return json({data:[{id:'chat-a'}]});
  if(url.endsWith('/models/stt')) return json({data:[{id:'stt-a'}]});
  return handler(url,options);
}});
test('discovery allowlists models and rejects arbitrary upstream routing', async()=>{
  const p=fixture(()=>{throw Error('must not call generation');});
  assert.deepEqual((await p.capabilities()).chatModels,['chat-a']);
  await assert.rejects(p.extract({model:'other-provider',transcript:'abc',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'}),{code:'INVALID_MODEL'});
});
test('extraction returns validated draft with human warnings and no executable tools',async()=>{
  const p=fixture((url,options)=>{
    assert.ok(url.endsWith('/chat/completions')); const body=JSON.parse(options.body);
    assert.equal(body.stream,false); assert.equal(body.tools,undefined);
    assert.ok(body.messages[0].content.includes('Asia/Ho_Chi_Minh'));
    return json({choices:[{message:{content:JSON.stringify({draft,warnings:['Chưa có người nhận.']})}}]});
  });
  const result=await p.extract({model:'chat-a',transcript:'Sửa vòi',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'});
  assert.deepEqual(result.draft,draft); assert.deepEqual(result.warnings,['Chưa có người nhận.']);
});
test('upstream malformed fields and raw error details never become successful drafts or leaked secrets',async()=>{
  const cases=[json({choices:[{message:{content:'not json'}}]}),json({choices:[{message:{content:JSON.stringify({draft:{...draft,deadline:'tomorrow'},warnings:[]})}}]}),json({error:'private-key'},500)];
  for(const response of cases){
    const p=fixture(()=>response);
    await assert.rejects(p.extract({model:'chat-a',transcript:'abc',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'}),error=>{assert.ok(!error.message.includes('private-key'));return true;});
  }
});
test('STT sends Vietnamese language and accepts only a nonempty transcript',async()=>{
  const p=fixture((url,options)=>{assert.ok(url.endsWith('/audio/transcriptions')); assert.equal(options.body.get('language'),'vi'); assert.equal(options.body.get('model'),'stt-a'); return json({text:'Sửa vòi phòng 101'});});
  const result=await p.transcribe({model:'stt-a',audio:Buffer.from('audio'),contentType:'audio/webm'}); assert.equal(result.transcript,'Sửa vòi phòng 101');
});
test('authentication discovery failure reports unavailable and bounded actionable error',async()=>{
  const p=createProvider({baseUrl:'https://router.example',apiKey:'hidden-value',fetchImpl:async()=>json({error:'hidden-value'},401)});
  const status=await p.capabilities();assert.equal(status.providerReady,false);assert.deepEqual(status.chatModels,[]);assert.match(status.capabilityError,/401/);assert.ok(!status.capabilityError.includes('hidden-value'));
});
test('calendar impossible date is rejected rather than silently rolled into next month',async()=>{
  const p=fixture(()=>json({choices:[{message:{content:JSON.stringify({draft:{...draft,deadline:'2026-02-31T10:00:00+07:00'},warnings:[]})}}]}));
  await assert.rejects(p.extract({model:'chat-a',transcript:'abc',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'}),{code:'PROVIDER_RESPONSE'});
});
test('model discovery uses a 10-second budget while generation retains its 60-second budget',async t=>{
  const budgets=new WeakMap(),observed=[];
  t.mock.method(AbortSignal,'timeout',milliseconds=>{const signal=new AbortController().signal;budgets.set(signal,milliseconds);return signal;});
  const provider=createProvider({baseUrl:'https://router.example/v1',apiKey:'test-key',fetchImpl:async(url,options)=>{
    observed.push({path:new URL(url).pathname,budget:budgets.get(options.signal)});
    if(url.endsWith('/models'))return json({data:[{id:'chat-a'}]});
    if(url.endsWith('/models/stt'))return json({data:[{id:'stt-a'}]});
    return json({choices:[{message:{content:JSON.stringify({draft,warnings:[]})}}]});
  }});
  await provider.extract({model:'chat-a',transcript:'Sửa vòi',referenceTime:'2026-09-26T10:00:00+07:00',timeZone:'Asia/Ho_Chi_Minh'});
  assert.deepEqual(observed,[{path:'/v1/models',budget:10000},{path:'/v1/models/stt',budget:10000},{path:'/v1/chat/completions',budget:60000}]);
});
