import { describe, expect, it, vi } from 'vitest';
import { FinancialAlreadyRecordedError, FinancialWorkflowError, FinancialWorkflowGuard, isConfirmedFinancialRejection, workflowFailure, workflowErrorMessage } from '../financialWorkflow';
import { createFinancialPendingStore, PENDING_SETTLE_MS, type FinancialPendingRecord } from '../financialPending';
import { createPendingValve } from '../pendingValve';

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

// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0=Date.parse('2026-11-24T02:00:00.000Z');
function durableOptions(namespace='payroll') {
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  let clock=T0;
  const now=()=>new Date(clock);
  const store=createFinancialPendingStore({storage,now});
  const valve=createPendingValve({storage,now});
  return {values,store,valve,now,advance:(ms:number)=>{clock+=ms;},scope:async(key:string)=>({namespace,userId:'u',organizationId:'org',businessKey:key})};
}
const failedFetch=async()=>{throw new TypeError('Failed to fetch');};

it('saves pending before write and keeps completed IDs after a fresh guard instance',async()=>{
 const options=durableOptions();let calls=0;
 const first=new FinancialWorkflowGuard(options);
 await expect(first.run('staff-month','chi lương',async progress=>{calls++;expect(options.store.read(await options.scope('staff-month'))).not.toBeNull();progress.completed.push({id:'v1',label:'Phiếu đã tạo'});throw new TypeError('Failed to fetch');})).rejects.toBeInstanceOf(FinancialWorkflowError);
 const second=new FinancialWorkflowGuard(options);
 await expect(second.run('staff-month','chi lương',async()=>{calls++;})).rejects.toMatchObject({completed:[{id:'v1'}]});
 expect(calls).toBe(1);
});
it('never clears an uncertain attempt because an authoritative lookup returned no record',async()=>{
 const options=durableOptions();const prior=options.store.markPending(await options.scope('one'));
 const guard=new FinancialWorkflowGuard(options);let calls=0;
 await expect(guard.run('one','ghi tiền',async()=>{calls++;},async()=>null)).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(calls).toBe(0);expect(options.store.read(await options.scope('one'))).not.toBeNull();
 // "Chưa kết luận được" không bao giờ tự gỡ, dù dấu đã cũ tới đâu: chỉ còn lối người dùng tự xác nhận.
 options.advance(24*60*60*1000);
 await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',async()=>{calls++;},async()=>null)).rejects.toMatchObject({outcome:'unknown'});
 expect(calls).toBe(0);expect(options.store.read(await options.scope('one'))?.attemptId).toBe(prior.attemptId);
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

it.each(['PT409','PGRST202','42883','P0002','P0001','PGRST116'])('a confirmed server rejection %s retains the original code and permits a corrected request',async code=>{
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
},30000);

describe('bốn kết quả đối chiếu',()=>{
 it('(b) lần trước ĐÃ ghi: gỡ dấu, báo mã bản ghi, không chạy lần mới',async()=>{
  const options=durableOptions();const scope=await options.scope('one');options.store.markPending(scope,{requestKey:'old-key'});
  const task=vi.fn(async()=>'new');
  const run=new FinancialWorkflowGuard(options).run('one','lập phiếu',task,async()=>({outcome:'already-written',message:'Phiếu đã được lập ở lần gửi trước.',recordIds:['pc-01']}));
  const error=await run.then(()=>null,(e:unknown)=>e);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
  expect(error).toMatchObject({outcome:'failure',alreadyRecorded:true,recordIds:['pc-01'],completed:[]});
  expect((error as Error).message).toBe('Phiếu đã được lập ở lần gửi trước. Mã bản ghi: pc-01.');
  expect(task).not.toHaveBeenCalled();
  expect(options.store.read(scope)).toBeNull();
  expect(options.valve.current()).toBeNull();
  // Dấu đã gỡ nên lần bấm sau là một lượt mới bình thường, với mã yêu cầu mới.
  let nextKey='';
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',async progress=>{nextKey=progress.requestKey;return 'second';})).resolves.toBe('second');
  expect(nextKey).not.toBe('old-key');
 });
 it('(b) không lặp lại mã bản ghi đã có trong câu báo',()=>{
  expect(new FinancialAlreadyRecordedError('Đã lập phiếu pc-01.',['pc-01','pc-02','pc-02','']).message).toBe('Đã lập phiếu pc-01. Mã bản ghi: pc-02.');
 });
 it('(c) lần trước CHƯA ghi và dấu đã quá 2 phút: gỡ dấu rồi chạy lại với cùng mã yêu cầu',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const prior=options.store.markPending(scope,{requestKey:'old-key'});
  options.store.recordCompleted(scope,prior.attemptId,['da-don']);options.advance(PENDING_SETTLE_MS);
  let during:FinancialPendingRecord|null=null;let sentKey='';let completedAtStart=-1;
  const task=vi.fn(async(progress:{requestKey:string;completed:unknown[]})=>{sentKey=progress.requestKey;completedAtStart=progress.completed.length;during=options.store.read(scope);return 'written';});
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',task,async()=>({outcome:'not-written'}))).resolves.toBe('written');
  expect(task).toHaveBeenCalledTimes(1);
  expect(sentKey).toBe('old-key');
  expect(completedAtStart).toBe(0);
  expect(during).toMatchObject({requestKey:'old-key',completedIds:[],operation:'lập phiếu',startedAt:options.now().toISOString()});
  expect((during as unknown as FinancialPendingRecord).attemptId).not.toBe(prior.attemptId);
  expect(options.store.read(scope)).toBeNull();
 });
 it('(c) chưa ghi nhưng dấu chưa quá 2 phút: giữ dấu, không chạy; đủ 2 phút mới chạy',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const prior=options.store.markPending(scope,{requestKey:'old-key',operation:'lập phiếu'});
  const task=vi.fn(async()=>'written');const notWritten=async()=>({outcome:'not-written' as const});
  options.advance(PENDING_SETTLE_MS-1);
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',task,notWritten)).rejects.toMatchObject({outcome:'unknown',message:expect.stringContaining('đang chờ kết quả')});
  expect(task).not.toHaveBeenCalled();
  expect(options.store.read(scope)?.attemptId).toBe(prior.attemptId);
  expect(options.valve.current()).toMatchObject({kind:'waiting'});
  options.advance(1);
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',task,notWritten)).resolves.toBe('written');
  expect(task).toHaveBeenCalledTimes(1);
 });
 it('(c) nơi gọi khai máy chủ chống trùng theo mã: gửi lại ngay, không chờ 2 phút',async()=>{
  const options=durableOptions();const scope=await options.scope('one');options.store.markPending(scope,{requestKey:'old-key'});
  let sentKey='';
  await expect(new FinancialWorkflowGuard(options).run('one','thu tiền',async progress=>{sentKey=progress.requestKey;return 'written';},async()=>({outcome:'not-written',serverDedupesRequestKey:true}))).resolves.toBe('written');
  expect(sentKey).toBe('old-key');expect(options.store.read(scope)).toBeNull();
 });
 it('(c) lần chạy lại hỏng vì mất phản hồi: dấu mới giữ đúng mã yêu cầu cũ; bị từ chối rõ thì gỡ',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const prior=options.store.markPending(scope,{requestKey:'old-key'});
  options.advance(PENDING_SETTLE_MS);const notWritten=async()=>({outcome:'not-written' as const});
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',failedFetch,notWritten)).rejects.toMatchObject({outcome:'unknown'});
  const second=options.store.read(scope);
  expect(second?.requestKey).toBe('old-key');expect(second?.attemptId).not.toBe(prior.attemptId);
  options.advance(PENDING_SETTLE_MS);const rejected={code:'P0001',message:'Kỳ đã chốt'};
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu',async()=>{throw rejected;},notWritten)).rejects.toBe(rejected);
  expect(options.store.read(scope)).toBeNull();
 });
 it('phép đối chiếu hỏng giữa chừng là chưa kết luận được: giữ dấu và báo việc đang kẹt',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const prior=options.store.markPending(scope,{operation:'duyệt phiếu'});
  const task=vi.fn();
  await expect(new FinancialWorkflowGuard(options).run('one','huỷ phiếu',task,async()=>{throw new TypeError('Failed to fetch');})).rejects.toMatchObject({outcome:'unknown',message:expect.stringContaining('Yêu cầu duyệt phiếu gửi lúc 09:00 ngày 24/11/2026')});
  expect(task).not.toHaveBeenCalled();expect(options.store.read(scope)?.attemptId).toBe(prior.attemptId);
  expect(options.valve.current()?.pending.attemptId).toBe(prior.attemptId);
 });
});

describe('câu báo và hộp cảnh báo khi bị chặn',()=>{
 it('lưu tên thao tác vào dấu trước khi ghi',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('one','chi lương',failedFetch)).rejects.toMatchObject({outcome:'unknown'});
  expect(options.store.read(await options.scope('one'))).toMatchObject({operation:'chi lương',startedAt:'2026-11-24T02:00:00.000Z'});
 });
 it('gọi đúng thao tác ĐANG KẸT và giờ kẹt, không phải thao tác đang bấm',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('v1','duyệt phiếu',failedFetch)).rejects.toMatchObject({outcome:'unknown'});
  options.advance(60_000);
  const waiting=await new FinancialWorkflowGuard(options).run('v1','huỷ phiếu',async()=>{}).then(()=>null,(e:unknown)=>e as Error);
  expect(waiting?.message).toBe('Yêu cầu duyệt phiếu gửi lúc 09:00 ngày 24/11/2026 đang chờ kết quả nên chưa đối chiếu được. Thử lại sau ít phút.');
  options.advance(60_000);
  const stale=await new FinancialWorkflowGuard(options).run('v1','huỷ phiếu',async()=>{}).then(()=>null,(e:unknown)=>e as Error);
  expect(stale?.message).toContain('Yêu cầu duyệt phiếu gửi lúc 09:00 ngày 24/11/2026 chưa xác nhận xong.');
  expect(stale?.message).not.toContain('huỷ phiếu');
 });
 it('dấu cũ không có tên thao tác: gọi theo nhãn của namespace, không mượn tên thao tác đang bấm',async()=>{
  const options=durableOptions('voucher-lifecycle');const scope=await options.scope('v1');
  // Đúng dạng dấu của bản trước 24/11/2026: không có `operation`, không có `meta`.
  options.values.set('ihome:financial-pending:v1:voucher-lifecycle:u:org:v1',JSON.stringify({...scope,attemptId:'a-old',requestKey:'k-old',completedIds:['pc-07'],startedAt:'2026-11-20T03:30:00.000Z'}));
  const task=vi.fn();
  const error=await new FinancialWorkflowGuard(options).run('v1','đổi kiểm phiếu',task).then(()=>null,(e:unknown)=>e as FinancialWorkflowError);
  expect(task).not.toHaveBeenCalled();
  expect(error).toMatchObject({outcome:'partial',completed:[{id:'pc-07'}]});
  expect(error?.message).toContain('Yêu cầu duyệt, huỷ hoặc khôi phục phiếu thu chi gửi lúc 10:30 ngày 20/11/2026 chưa xác nhận xong.');
  expect(error?.message).not.toContain('đổi kiểm phiếu');
  expect(options.valve.current()).toMatchObject({kind:'stale',blockedOperation:'đổi kiểm phiếu',pending:{attemptId:'a-old',completedIds:['pc-07']}});
 });
 it('namespace ngoài sổ và dấu không có tên thao tác: câu báo vẫn nêu giờ kẹt',async()=>{
  const options=durableOptions('chua-khai');options.store.markPending(await options.scope('one'));
  await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',async()=>{})).rejects.toMatchObject({message:expect.stringContaining('Một yêu cầu trước đó gửi lúc 09:00 ngày 24/11/2026')});
 });
 it('lần hỏng đầu tiên không mở hộp cảnh báo; chỉ lần bị chặn bởi dấu cũ mới báo',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',failedFetch)).rejects.toMatchObject({outcome:'unknown'});
  expect(options.valve.current()).toBeNull();
  await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',async()=>{})).rejects.toMatchObject({outcome:'unknown'});
  expect(options.valve.current()).toMatchObject({kind:'waiting',blockedOperation:'ghi tiền'});
 });
 it('sau khi người dùng tự gỡ qua hộp cảnh báo, chính guard đang bị chặn chạy lại được với mã yêu cầu mới',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const guard=new FinancialWorkflowGuard(options);let firstKey='';
  await expect(guard.run('one','ghi tiền',async progress=>{firstKey=progress.requestKey;throw new TypeError('Failed to fetch');})).rejects.toMatchObject({outcome:'unknown'});
  options.advance(PENDING_SETTLE_MS);
  await expect(guard.run('one','ghi tiền',async()=>'no')).rejects.toMatchObject({outcome:'unknown'});
  const notice=options.valve.current();expect(notice?.kind).toBe('stale');
  options.valve.release(notice!);
  expect(options.store.read(scope)).toBeNull();
  let secondKey='';
  await expect(guard.run('one','ghi tiền',async progress=>{secondKey=progress.requestKey;return 'ok';})).resolves.toBe('ok');
  expect(secondKey).not.toBe(firstKey);
  expect(options.valve.readLog('u')).toHaveLength(1);
 });
 it('khoá trong bộ nhớ không soi theo dấu bền nào (trình duyệt không lưu được dấu) vẫn chặn',async()=>{
  const options=durableOptions();const task=vi.fn(async()=>'ok');let quota=true;
  const store={...options.store,markPending:(...args:Parameters<typeof options.store.markPending>)=>{if(quota)throw new TypeError('quota');return options.store.markPending(...args);}};
  const guard=new FinancialWorkflowGuard({...options,store});
  await expect(guard.run('one','ghi tiền',task)).rejects.toMatchObject({outcome:'unknown'});
  // Kho đã ghi lại được, nhưng lượt trước không để lại dấu nào để ai gỡ: khoá trong bộ nhớ giữ tới khi tải lại trang.
  quota=false;
  await expect(guard.run('one','ghi tiền',task)).rejects.toMatchObject({outcome:'unknown'});
  expect(task).not.toHaveBeenCalled();expect(options.valve.current()).toBeNull();
 });
});

describe('tách khoá theo thao tác (đợt 5)',()=>{
 // Hai guard dùng chung một kho, như hai hook trên cùng một trang.
 const split=()=>{
  const base=durableOptions();
  const of=(namespace:string)=>({...base,scope:async(key:string)=>({namespace,userId:'u',organizationId:'org',businessKey:key})});
  return {base,of};
 };
 it('thao tác kẹt không chặn thao tác khác trên cùng bản ghi, cũng không chặn cùng thao tác trên bản ghi khác',async()=>{
  const {of}=split();
  await expect(new FinancialWorkflowGuard({...of('voucher-approve'),legacyNamespace:'voucher-lifecycle'}).run('v1','duyệt phiếu',failedFetch)).rejects.toMatchObject({outcome:'unknown'});
  await expect(new FinancialWorkflowGuard({...of('voucher-cancel'),legacyNamespace:'voucher-lifecycle'}).run('v1','huỷ phiếu',async()=>'huỷ')).resolves.toBe('huỷ');
  await expect(new FinancialWorkflowGuard({...of('voucher-approve'),legacyNamespace:'voucher-lifecycle'}).run('v2','duyệt phiếu',async()=>'duyệt')).resolves.toBe('duyệt');
 });
 it('dấu khoá chung bản trước chặn đúng bản ghi đó, mở hộp cảnh báo, không gọi đối chiếu, không chạy task, không giữ khoá bộ nhớ',async()=>{
  const {base,of}=split();
  base.values.set('ihome:financial-pending:v1:voucher-lifecycle:u:org:v1',JSON.stringify({namespace:'voucher-lifecycle',userId:'u',organizationId:'org',businessKey:'v1',attemptId:'a-old',requestKey:'k-old',completedIds:[],startedAt:'2026-11-20T03:30:00.000Z'}));
  const guard=new FinancialWorkflowGuard({...of('voucher-cancel'),legacyNamespace:'voucher-lifecycle'});
  const task=vi.fn(async()=>'ok');const reconcile=vi.fn(async()=>({outcome:'not-written' as const,serverDedupesRequestKey:true}));
  const error=await guard.run('v1','huỷ phiếu',task,reconcile).then(()=>null,(e:unknown)=>e as FinancialWorkflowError);
  expect(error?.message).toContain('Yêu cầu duyệt, huỷ hoặc khôi phục phiếu thu chi gửi lúc 10:30 ngày 20/11/2026 chưa xác nhận xong.');
  expect(task).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();
  expect(base.valve.current()).toMatchObject({kind:'stale',blockedOperation:'huỷ phiếu',pending:{namespace:'voucher-lifecycle',attemptId:'a-old'}});
  // Không để lại dấu mới ở namespace mới; bản ghi khác không bị chặn.
  expect(base.store.read(await of('voucher-cancel').scope('v1'))).toBeNull();
  await expect(guard.run('v2','huỷ phiếu',task)).resolves.toBe('ok');
  // Người dùng tự gỡ qua hộp cảnh báo: CHÍNH guard đó chạy được ngay, không còn khoá trong bộ nhớ.
  base.valve.release(base.valve.current()!);
  await expect(guard.run('v1','huỷ phiếu',task)).resolves.toBe('ok');
  expect(task).toHaveBeenCalledTimes(2);
 });
 it('lưu `meta` của lượt ghi vào dấu để hàm đối chiếu đọc lại',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('v1','đổi kiểm phiếu',failedFetch,undefined,undefined,{meta:{before:'chua-kiem'}})).rejects.toMatchObject({outcome:'unknown'});
  const reconcile=vi.fn(async(..._args:unknown[])=>null);
  await expect(new FinancialWorkflowGuard(options).run('v1','đổi kiểm phiếu',async()=>'x',reconcile)).rejects.toMatchObject({outcome:'unknown'});
  expect(reconcile.mock.calls[0][0]).toMatchObject({meta:{before:'chua-kiem'},operation:'đổi kiểm phiếu'});
 });
});

describe('chặn đổi trường máy chủ không so khi đối chiếu (đợt 6, `priorMismatch`)',()=>{
 it('còn dấu mà lượt này đổi trường máy chủ không so: ném đúng câu hướng dẫn, giữ dấu, mở hộp cảnh báo, không đối chiếu, không chạy task',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('staff-month','lập phiếu chi lương',failedFetch,undefined,undefined,{meta:{rest:'so-a'}})).rejects.toMatchObject({outcome:'unknown'});
  const prior=options.store.read(await options.scope('staff-month'));
  const task=vi.fn(async()=>'ok');const reconcile=vi.fn(async()=>({outcome:'not-written' as const,serverDedupesRequestKey:true}));
  const guard=new FinancialWorkflowGuard(options);
  await expect(guard.run('staff-month','lập phiếu chi lương',task,reconcile,undefined,{meta:{rest:'so-b'},priorMismatch:pending=>pending.meta?.rest!=='so-b'?'Giữ nguyên sổ quỹ như lần trước.':null})).rejects.toMatchObject({message:'Giữ nguyên sổ quỹ như lần trước.',outcome:'unknown'});
  expect(task).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();
  expect(options.store.read(await options.scope('staff-month'))?.attemptId).toBe(prior?.attemptId);
  expect(options.valve.current()).toMatchObject({pending:{attemptId:prior?.attemptId}});
  // Trả lại đúng giá trị cũ: CHÍNH guard đó đối chiếu và gửi lại ngay (không giữ khoá trong bộ nhớ vì lần bị chặn).
  await expect(guard.run('staff-month','lập phiếu chi lương',task,reconcile,undefined,{meta:{rest:'so-a'},priorMismatch:pending=>pending.meta?.rest!=='so-a'?'x':null})).resolves.toBe('ok');
  expect(reconcile).toHaveBeenCalledTimes(1);expect(task).toHaveBeenCalledTimes(1);
 });
 it('không có dấu thì không gọi `priorMismatch`',async()=>{
  const options=durableOptions();const priorMismatch=vi.fn(()=>'không được gọi');
  await expect(new FinancialWorkflowGuard(options).run('one','ghi',async()=>'ok',undefined,undefined,{priorMismatch})).resolves.toBe('ok');
  expect(priorMismatch).not.toHaveBeenCalled();
 });
});

describe('mồi khoá chung',()=>{
 it('PGRST116 (lệnh ghi khớp 0 dòng) khi chưa bước nào hoàn tất là từ chối rõ: gỡ dấu, giữ nguyên lỗi',async()=>{
  const options=durableOptions();const rejected={code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned'};
  await expect(new FinancialWorkflowGuard(options).run('one','cập nhật khách hàng',async()=>{throw rejected;})).rejects.toBe(rejected);
  expect(options.store.read(await options.scope('one'))).toBeNull();
  expect(isConfirmedFinancialRejection(rejected)).toBe(true);
 });
 it('PGRST116 sau khi đã có bước hoàn tất vẫn là ghi dở dang: giữ dấu',async()=>{
  const options=durableOptions();const scope=await options.scope('one');
  await expect(new FinancialWorkflowGuard(options).run('one','tạo khách hàng',async progress=>{progress.completed.push({id:'kh-1',label:'Khách đã tạo'});throw {code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned'};})).rejects.toMatchObject({outcome:'partial',completed:[{id:'kh-1'}]});
  expect(options.store.read(scope)?.completedIds).toEqual(['kh-1']);
 });
 it('lời từ chối có mã rõ nhưng câu báo nhúng số tiền chứa 502/503/504 không bị coi là mất phản hồi',async()=>{
  const options=durableOptions();const rejected={code:'P0001',message:'Số tiền 1.502.000 đ vượt số dư 503.000 đ của sổ.'};
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu chi',async()=>{throw rejected;})).rejects.toBe(rejected);
  expect(options.store.read(await options.scope('one'))).toBeNull();
 });
 it('lỗi 5xx thật vẫn giữ dấu dù có kèm mã từ chối',async()=>{
  const options=durableOptions();
  await expect(new FinancialWorkflowGuard(options).run('one','lập phiếu chi',async()=>{throw {code:'P0001',status:503,message:'upstream'};})).rejects.toMatchObject({outcome:'unknown'});
  expect(options.store.read(await options.scope('one'))).not.toBeNull();
 });
});

describe('lượt ghi nhiều bước chạy lâu hơn ngưỡng',()=>{
 it('dấu của lượt còn đang chạy trong tab không được coi là đã kết thúc: không đối chiếu, không chạy lại, không cho tự gỡ',async()=>{
  const options=durableOptions();const scope=await options.scope('import');
  let finish:(error:unknown)=>void=()=>{};
  // Vòng nhập nhiều dòng vẫn đang gửi lệnh ở nền sau khi người dùng đóng hộp nhập.
  const longRun=new FinancialWorkflowGuard(options).run('import','nhập thu chi từ Excel',()=>new Promise<string>((_resolve,reject)=>{finish=reject;}));
  const settledLongRun=longRun.then(()=>null,(error:unknown)=>error);
  await vi.waitFor(()=>expect(options.store.read(scope)).not.toBeNull());
  options.advance(10*60_000);
  const task=vi.fn(async()=>'second');const reconcile=vi.fn(async()=>({outcome:'not-written' as const,serverDedupesRequestKey:true}));
  await expect(new FinancialWorkflowGuard(options).run('import','nhập thu chi từ Excel',task,reconcile)).rejects.toMatchObject({outcome:'unknown',message:expect.stringContaining('đang chờ kết quả')});
  expect(task).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();
  const notice=options.valve.current();
  expect(notice?.kind).toBe('waiting');
  expect(()=>options.valve.release(notice!)).toThrow(/còn đang chạy/);
  expect(options.store.read(scope)).not.toBeNull();expect(options.valve.readLog('u')).toEqual([]);
  // Lượt cũ dừng vì mất phản hồi: từ đây dấu được xét theo giờ như mọi dấu khác.
  finish(new TypeError('Failed to fetch'));
  expect(await settledLongRun).toMatchObject({outcome:'unknown'});
  expect(options.valve.recheck(options.valve.current()!)).toBe('stale');
 });
 it('ngưỡng 2 phút tính từ bước hoàn tất gần nhất, không từ lúc bắt đầu',async()=>{
  const options=durableOptions();const scope=await options.scope('batch');
  await expect(new FinancialWorkflowGuard(options).run('batch','huỷ đợt phiếu',async progress=>{
   options.advance(5*60_000);progress.completed.push({id:'v1',label:'Đã huỷ v1'});
   throw new TypeError('Failed to fetch');
  })).rejects.toMatchObject({outcome:'partial'});
  expect(options.store.read(scope)).toMatchObject({startedAt:'2026-11-24T02:00:00.000Z',activeAt:'2026-11-24T02:05:00.000Z'});
  const notWritten=async()=>({outcome:'not-written' as const});const task=vi.fn(async()=>'again');
  options.advance(PENDING_SETTLE_MS-1);
  await expect(new FinancialWorkflowGuard(options).run('batch','huỷ đợt phiếu',task,notWritten)).rejects.toMatchObject({message:expect.stringContaining('đang chờ kết quả')});
  expect(task).not.toHaveBeenCalled();
  options.advance(1);
  await expect(new FinancialWorkflowGuard(options).run('batch','huỷ đợt phiếu',task,notWritten)).resolves.toBe('again');
 });
 it('kết luận lạ dạng không được coi là "chưa ghi": giữ dấu, không chạy task',async()=>{
  const options=durableOptions();const scope=await options.scope('one');const prior=options.store.markPending(scope);
  options.advance(PENDING_SETTLE_MS*5);const task=vi.fn();
  for(const strange of [{},{outcome:'done'},{outcome:'not-writen'}]){
   await expect(new FinancialWorkflowGuard(options).run('one','ghi tiền',task,async()=>strange as never)).rejects.toMatchObject({outcome:'unknown'});
  }
  expect(task).not.toHaveBeenCalled();expect(options.store.read(scope)?.attemptId).toBe(prior.attemptId);
 });
});
