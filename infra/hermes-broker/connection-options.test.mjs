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
  x=>x.userId=OTHER,x=>x.organizationId=OTHER,x=>x.read.push('contracts.view'),x=>x.action.push('rooms.edit'),
  x=>x.scopes[0].scopeType='CASHBOOK',x=>x.scopes[0].areaId=OTHER,x=>x.scopes[0].buildingId=null,
  x=>x.scopes[0].label='x'.repeat(1025),x=>x.scopes[0].label='a\0b',x=>x.scopes.push({...x.scopes[0]}),
  x=>x.scopes=[],x=>x.enabled=false,x=>x.policyVersion=0,x=>x.authorizationVersion=0,
  x=>x.token='secret',x=>Object.defineProperty(x,'read',{get(){invoked++;return []},enumerable:true})
 ]){const input=valid();mutate(input);assert.throws(()=>connectionOptions(input,ORG,USER),/connection_options_invalid/);}
 assert.equal(invoked,0);
});
