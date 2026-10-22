import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionOptions } from './connection-options.mjs';
const id=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
const USER=id('1'),ORG=id('2'),MEMBER=id('3'),SCOPE=id('4'),BUILDING=id('5'),OTHER=id('6');
const valid=()=>({userId:USER,organizationId:ORG,membershipId:MEMBER,authorizationVersion:1,isSuperadmin:false,policyVersion:2,enabled:true,
 read:['assistant.context.read','rooms.view'],action:[],scopes:[{scopeId:SCOPE,scopeType:'BUILDING',label:'Nhà A',buildingId:BUILDING,areaId:null,cashbookId:null}]});
test('enrollment options are frozen own-data projections bound to the verified caller',()=>{
 const input=valid(),result=connectionOptions(input,ORG,USER);assert.deepEqual(result,input);
 input.scopes[0].label='changed';input.read.length=0;assert.equal(result.scopes[0].label,'Nhà A');assert.equal(result.read.length,2);
 for(const value of [result,result.scopes,result.scopes[0],result.read,result.action])assert(Object.isFrozen(value));
});
test('options reject foreign identity, unsupported capabilities and malformed scope labels without invoking getters',()=>{
 let invoked=0;
 for(const mutate of [
  x=>x.userId=OTHER,x=>x.organizationId=OTHER,x=>x.read.push('future.unsupported_read'),x=>x.action.push('rooms.delete'),
  x=>x.scopes[0].scopeType='CASHBOOK',x=>x.scopes[0].areaId=OTHER,x=>x.scopes[0].buildingId=null,
  x=>x.scopes[0].label='x'.repeat(1025),x=>x.scopes[0].label='a\0b',x=>x.scopes.push({...x.scopes[0]}),
  x=>x.scopes=[],x=>x.enabled=false,x=>x.policyVersion=-1,x=>x.authorizationVersion=0,
  x=>x.token='secret',x=>Object.defineProperty(x,'read',{get(){invoked++;return []},enumerable:true})
 ]){const input=valid();mutate(input);assert.throws(()=>connectionOptions(input,ORG,USER),/connection_options_invalid/);}
 assert.equal(invoked,0);
});

test('neutral policy version keeps current server choices and does not bypass disabled options',()=>{
 const input={...valid(),policyVersion:0};assert.deepEqual(connectionOptions(input,ORG,USER),input);
 assert.throws(()=>connectionOptions({...input,enabled:false},ORG,USER),/connection_options_invalid/);
});

test('fixed Zalo action remains a detached choice and disabled options cannot carry it',()=>{
 const input=valid();input.action=['chat_zalo.send'];const result=connectionOptions(input,ORG,USER);assert.deepEqual(result.action,['chat_zalo.send']);input.action[0]='rooms.edit';assert.deepEqual(result.action,['chat_zalo.send']);
 for(const change of [x=>x.action=['chat_zalo.send','chat_zalo.send'],x=>x.action=['future.write'],x=>{x.enabled=false;x.read=[];x.scopes=[]}]){const bad=valid();bad.action=['chat_zalo.send'];change(bad);assert.throws(()=>connectionOptions(bad,ORG,USER),/connection_options_invalid/);}
});

test('group read does not imply room scope or action',()=>{
 const input={...valid(),read:['chat_zalo.view'],action:[],scopes:[]};
 assert.deepEqual(connectionOptions(input,ORG,USER),input);
 assert.throws(()=>connectionOptions({...input,read:['chat_zalo.send']},ORG,USER),/connection_options_invalid/);
 assert.throws(()=>connectionOptions({...input,action:['chat_zalo.view']},ORG,USER),/connection_options_invalid/);
});

test('sale action choices preserve only the server projection without inferring receipt approval or read access',()=>{
 const actions=['rooms.edit','sale_phong.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'];
 assert.deepEqual(connectionOptions(valid(),ORG,USER).action,[]);
 for(const action of actions){
  const input={...valid(),read:['assistant.context.read'],action:[action]};
  const result=connectionOptions(input,ORG,USER);
  assert.deepEqual(result.action,[action]);assert.deepEqual(result.read,['assistant.context.read']);
  assert.throws(()=>connectionOptions({...input,scopes:[]},ORG,USER),/connection_options_invalid/);
 }
});

test('domain-only grants use their shared building scope contract without requiring rooms.view',()=>{
 const input={...valid(),read:['contracts.view'],action:['assistant.memory.write','chat_zalo.manage_automation']};
 assert.deepEqual(connectionOptions(input,ORG,USER),input);
 assert.throws(()=>connectionOptions({...input,scopes:[]},ORG,USER),/connection_options_invalid/);
 assert.throws(()=>connectionOptions({...input,action:['assistant.memory.write','assistant.memory.write']},ORG,USER),/connection_options_invalid/);
});
