import { describe, expect, it } from 'vitest';
import { FinancialWorkflowError, FinancialWorkflowGuard, workflowFailure, workflowErrorMessage } from '../financialWorkflow';
describe('financial workflow failure', () => {
  it('blocks a gateway error without a timeout message', async () => {
    const guard = new FinancialWorkflowGuard(); let calls = 0;
    const task = async () => { calls++; throw {status:503,message:'Service Unavailable'}; };
    await expect(guard.run('payment','thu tiền',task)).rejects.toBeInstanceOf(FinancialWorkflowError);
    await expect(guard.run('payment','thu tiền',task)).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(calls).toBe(1);
  });
  it('blocks a second financial write after a partial result', async () => {
    const guard = new FinancialWorkflowGuard();
    const task = async (progress: {completed: {id:string;label:string}[]}) => {
      progress.completed.push({id:'p1',label:'Đã lập phiếu PC01'});
      throw new Error('next step failed');
    };
    await expect(guard.run('staff-month','chi lương',task)).rejects.toBeInstanceOf(FinancialWorkflowError);
    let retried = false;
    await expect(guard.run('staff-month','chi lương',async () => { retried = true; })).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(retried).toBe(false);
  });
  it('preserves created identities and reports a partial result without raw SQL', () => {
    const cause = {code: '42501', message: 'SQL table payroll denied'};
    const error = workflowFailure(cause, 'chi lương cho An', [{id: 'voucher-1', label: 'Phiếu chi PC01 đã tạo'}], 'cập nhật bảng lương');
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect((error as FinancialWorkflowError).completed[0].id).toBe('voucher-1');
    expect(workflowErrorMessage(error, 'chi lương')).toContain('Phiếu chi PC01 đã tạo');
    expect(workflowErrorMessage(error, 'chi lương')).not.toContain('SQL');
  });
  it('unknown response without a created ID remains unknown and cannot be blindly retried', () => {
    const error = workflowFailure(new TypeError('Failed to fetch'), 'chi lương', [], 'tạo phiếu');
    expect((error as FinancialWorkflowError).outcome).toBe('unknown');
    expect(workflowErrorMessage(error, 'chi lương')).toContain('đối chiếu');
  });
  it('known rejection before any writes preserves the original code and cause', () => {
    const error = {code:'42501', message:'permission denied'};
    expect(workflowFailure(error, 'chi lương', [], 'tạo phiếu')).toBe(error);
  });
});

import {createFinancialPendingStore} from '../financialPending';
function durableOptions() {
  const values=new Map<string,string>();
  const store=createFinancialPendingStore({storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},removeItem:key=>{values.delete(key);}}});
  return {store,scope:async(key:string)=>({namespace:'payroll',userId:'u',organizationId:'org',businessKey:key})};
}
it('saves pending before write and keeps completed IDs after a fresh guard instance',async()=>{
 const options=durableOptions();let calls=0;
 const first=new FinancialWorkflowGuard(options);
 await expect(first.run('staff-month','chi lương',async progress=>{calls++;expect(options.store.read(await options.scope('staff-month'))).not.toBeNull();progress.completed.push({id:'v1',label:'Phiếu đã tạo'});throw new TypeError('Failed to fetch');})).rejects.toBeInstanceOf(FinancialWorkflowError);
 const second=new FinancialWorkflowGuard(options);
 await expect(second.run('staff-month','chi lương',async()=>{calls++;})).rejects.toMatchObject({completed:[{id:'v1'}]});
 expect(calls).toBe(1);
});
it('never clears an uncertain attempt because an authoritative lookup returned no record',async()=>{
 const options=durableOptions();await options.store.markPending(await options.scope('one'));
 const guard=new FinancialWorkflowGuard(options);let calls=0;
 await expect(guard.run('one','ghi tiền',async()=>{calls++;},async()=>null)).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(calls).toBe(0);expect(options.store.read(await options.scope('one'))).not.toBeNull();
});
it('returns a verified recovered result without repeating the writer',async()=>{
 const options=durableOptions();options.store.markPending(await options.scope('one'));
 const guard=new FinancialWorkflowGuard(options);let calls=0;
 await expect(guard.run('one','ghi tiền',async()=>{calls++;return 'new';},async()=>({result:'confirmed-v1'}))).resolves.toBe('confirmed-v1');
 expect(calls).toBe(0);expect(options.store.read(await options.scope('one'))).toBeNull();
});
it('known rejection before any completed step releases only its own marker',async()=>{
 const options=durableOptions();const guard=new FinancialWorkflowGuard(options);const rejected={code:'42501',message:'permission denied'};
 await expect(guard.run('one','ghi tiền',async()=>{throw rejected;})).rejects.toBe(rejected);
 expect(options.store.read(await options.scope('one'))).toBeNull();
});

it('keeps an unclassified error after the writer starts because it does not prove rollback',async()=>{
 const options=durableOptions();let calls=0;
 await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',async()=>{calls++;throw new Error('Invalid receipt');})).rejects.toMatchObject({outcome:'unknown'});
 await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',async()=>{calls++;})).rejects.toMatchObject({outcome:'unknown'});
 expect(calls).toBe(1);expect(options.store.read(await options.scope('one'))).not.toBeNull();
});

it('a typed failure after a completed step is partial and cannot clear durable state',async()=>{
 const options=durableOptions();let writes=0;
 await expect(new FinancialWorkflowGuard(options).run('typed','chi lương',async progress=>{
  writes++;progress.completed.push({id:'v1',label:'Phiếu v1 đã tạo'});
  throw new FinancialWorkflowError('Bước sau bị từ chối','failure',[]);
 })).rejects.toMatchObject({outcome:'partial',completed:[{id:'v1'}]});
 await expect(new FinancialWorkflowGuard(options).run('typed','chi lương',async()=>{writes++;})).rejects.toMatchObject({outcome:'partial',completed:[{id:'v1'}]});
 expect(writes).toBe(1);
});
it('retains IDs provided by an unconfirmed receipt after remount',async()=>{
 const options=durableOptions();let writes=0;
 await expect(new FinancialWorkflowGuard(options).run('receipt','lập bàn giao',async()=>{
  writes++;throw new FinancialWorkflowError('Chưa xác nhận đủ kết quả','unknown',[{id:'bg1',label:'Phiên cần đối chiếu'}]);
 })).rejects.toMatchObject({completed:[{id:'bg1'}]});
 await expect(new FinancialWorkflowGuard(options).run('receipt','lập bàn giao',async()=>{writes++;})).rejects.toMatchObject({completed:[{id:'bg1'}]});expect(writes).toBe(1);
});

it('makes the durable request key available before the writer and recovery sees the same key',async()=>{
 const options=durableOptions();let sent='';
 await expect(new FinancialWorkflowGuard(options).run('retry-key','thu tiền',async progress=>{
  sent=(progress as typeof progress & {requestKey:string}).requestKey;
  expect(sent).toMatch(/^[a-f0-9-]{36}$/i);
  expect(options.store.read(await options.scope('retry-key'))?.requestKey).toBe(sent);
  throw new TypeError('Failed to fetch');
 })).rejects.toMatchObject({outcome:'unknown'});
 let recoveredKey='';let writerCalls=0;
 await expect(new FinancialWorkflowGuard(options).run('retry-key','thu tiền',async()=>{writerCalls++;return 'unsafe';},async pending=>{recoveredKey=pending.requestKey??pending.attemptId;return {result:'receipt'};})).resolves.toBe('receipt');
 expect(recoveredKey).toBe(sent);expect(writerCalls).toBe(0);
});

it('retains the old attempt when a recovery read fails with a known server rejection',async()=>{
 const options=durableOptions();const scope=await options.scope('recover');const prior=options.store.markPending(scope,{requestKey:'old-key'});let writes=0;
 await expect(new FinancialWorkflowGuard(options).run('recover','thu tiền',async()=>{writes++;},async()=>{throw {code:'42501',message:'denied'};})).rejects.toMatchObject({outcome:'unknown'});
 expect(options.store.read(scope)?.attemptId).toBe(prior.attemptId);expect(writes).toBe(0);
});
it('persists verified recovery steps with the prior request key before a later error or remount',async()=>{
 const options=durableOptions();const scope=await options.scope('resume');const prior=options.store.markPending(scope,{requestKey:'same-request'});
 options.store.recordCompleted(scope,prior.attemptId,['core1']);let writes=0;
 await expect(new FinancialWorkflowGuard(options).run('resume','lưu tòa',async()=>{writes++;},async (_prior,rawProgress)=>{
  const progress=rawProgress as {requestKey:string;completed:{id:string;label:string}[]};
  expect(progress.requestKey).toBe('same-request');progress.completed.push({id:'owner1',label:'Đã lưu chủ sở hữu'});
  expect(options.store.read(scope)?.completedIds).toContain('owner1');throw {code:'42501',message:'next denied'};
 })).rejects.toMatchObject({outcome:'partial',completed:expect.arrayContaining([{id:'owner1',label:'Đã lưu chủ sở hữu'}])});
 await expect(new FinancialWorkflowGuard(options).run('resume','lưu tòa',async()=>{writes++;})).rejects.toMatchObject({completed:expect.arrayContaining([expect.objectContaining({id:'core1'}),expect.objectContaining({id:'owner1'})])});expect(writes).toBe(0);
});

it('shows retained identities to the user after a pending workflow is reopened',async()=>{
 const options=durableOptions();const scope=await options.scope('visible');const p=options.store.markPending(scope);options.store.recordCompleted(scope,p.attemptId,['voucher1']);
 let error:unknown;try{await new FinancialWorkflowGuard(options).run('visible','chi lương',async()=>{});}catch(e){error=e;}
 expect(workflowErrorMessage(error,'chi lương')).toContain('voucher1');
});

it.each(['PT409','PGRST202','42883','P0002','P0001'])('a confirmed server rejection %s retains the original code and permits a corrected request',async code=>{
 const guard=new FinancialWorkflowGuard();const error={code,message:'server rejected'};const writer=async()=>{throw error;};
 await expect(guard.run('voucher','duyệt phiếu',writer)).rejects.toBe(error);
 await expect(guard.run('voucher','duyệt phiếu',async()=>({id:'v'}))).resolves.toEqual({id:'v'});
});

it('a business rejection after a positive receipt remains partial and blocked',async()=>{
 const options=durableOptions();const guard=new FinancialWorkflowGuard(options);let calls=0;
 await expect(guard.run('p0001-partial','lưu chứng từ',async progress=>{calls++;progress.completed.push({id:'v1',label:'Phiếu đã tạo'});throw {code:'P0001',message:'known business rule rejected'};})).rejects.toMatchObject({outcome:'partial',completed:[{id:'v1'}]});
 await expect(new FinancialWorkflowGuard(options).run('p0001-partial','lưu chứng từ',async()=>{calls++;})).rejects.toMatchObject({outcome:'partial'});expect(calls).toBe(1);
});
it('a PostgreSQL business-rule exception rolls back its RPC transaction',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 try{
  await db.exec("CREATE TABLE feedback_probe(id integer); CREATE FUNCTION feedback_rpc() RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO feedback_probe VALUES(1); RAISE EXCEPTION 'verified business rejection'; END $$;");
  await expect(db.query('SELECT feedback_rpc()')).rejects.toMatchObject({code:'P0001'});
  expect((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM feedback_probe')).rows[0].count).toBe(0);
 }finally{await db.close();}
});
