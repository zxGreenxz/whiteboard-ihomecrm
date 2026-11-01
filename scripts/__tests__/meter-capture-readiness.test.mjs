import test from 'node:test';
import assert from 'node:assert/strict';
import { MeterTestHttpError, safeMeterErrorCode, withMeterReadRetry } from '../test-env/meter-capture-readiness.mjs';

const unavailable=(status=503,code='PGRST002')=>new MeterTestHttpError('Meter gateway catalog',status,{code,message:'private server details',token:'private token'});
function clock(){let time=0;const events=[];return{now:()=>time,advance:ms=>{time+=ms;},sleep:async ms=>{time+=ms;},onRetry:event=>events.push(event),events};}
test('TEST read recovers from exact schema-cache errors without exposing private body',async()=>{
 const timer=clock();let calls=0;
 const result=await withMeterReadRetry('catalog',async timeout=>{assert.equal(timeout,15_000);calls++;if(calls<3)throw unavailable(calls===1?503:502);return{meters:[]};},timer);
 assert.deepEqual(result,{meters:[]});assert.equal(calls,3);assert.equal(timer.now(),6_000);
 assert.deepEqual(timer.events.map(e=>e.code),['PGRST002','PGRST002']);
 assert.equal(unavailable().message,'Meter gateway catalog returned HTTP 503 (PGRST002).');
 assert.equal(safeMeterErrorCode({error:'Bearer private token'}),null);
});
test('TEST writes never retry even for schema-cache unavailability',async()=>{
 for(const action of ['profile','startCapture','confirmCapture','finalizeCapture','invoice','exit','rotateQr','unknown']){
  let calls=0;const timer=clock();await assert.rejects(withMeterReadRetry(action,async timeout=>{calls++;assert.equal(timeout,60_000);throw unavailable();},timer),{code:'PGRST002'});
  assert.equal(calls,1,action);assert.equal(timer.events.length,0,action);
 }
});
test('permission, SQL errors, gateway errors and network timeouts fail immediately',async()=>{
 for(const error of [unavailable(403),unavailable(500),unavailable(502,'42703'),unavailable(503,'PGRST202'),unavailable(502,'meter_capture_gateway_failed'),new DOMException('Timed out','TimeoutError'),new TypeError('Failed to fetch')]){
  let calls=0;const timer=clock();await assert.rejects(withMeterReadRetry('getCapture',async()=>{calls++;throw error;},timer),actual=>actual===error);
  assert.equal(calls,1);assert.equal(timer.events.length,0);
 }
});
test('90 second read deadline includes request time and sleep and clamps final request',async()=>{
 const timer=clock(),timeouts=[];
 await assert.rejects(withMeterReadRetry('getCapture',async timeout=>{timeouts.push(timeout);timer.advance(Math.min(14_000,timeout));throw unavailable();},timer),{code:'PGRST002'});
 assert.deepEqual(timeouts,[15_000,15_000,15_000,15_000,15_000,5_000]);
 assert.equal(timer.now(),90_000);assert.equal(timer.events.length,5);
});
test('read retry remains bounded at 31 attempts even if the injected clock stalls',async()=>{
 let calls=0;await assert.rejects(withMeterReadRetry('restRead',async()=>{calls++;throw unavailable();},{now:()=>0,sleep:async()=>{},onRetry:()=>{}}),{code:'PGRST002'});
 assert.equal(calls,31);
});
