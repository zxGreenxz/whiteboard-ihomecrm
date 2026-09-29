import { describe, expect, it, vi } from 'vitest';
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: rpcMock } }));
import { commissionFollowupPageSchema, runTrackedCommissionCreation, prepareCommissionCreations, executeCommissionCreation } from '../contractCommissionFollowup';

describe('commission creation retains a server-side recovery trail', () => {
  const input = { contractId: '11111111-1111-4111-8111-111111111111', kind: 'sale' as const, amount: 500000 };
  it('never starts money creation if the durable attempt cannot be saved', async () => {
    let writes = 0;
    await expect(runTrackedCommissionCreation(input, {
      record: async () => { throw new Error('offline'); },
      create: async () => { writes++; return { id: 'voucher' }; },
    })).rejects.toThrow(/chưa.*ghi nhận/i);
    expect(writes).toBe(0);
  });
  it('records the pending attempt before submitting and returns the created voucher', async () => {
    const order: string[] = [];
    const result = await runTrackedCommissionCreation(input, {
      record: async event => { order.push(event.action); },
      create: async () => { order.push('create'); return { id: 'voucher' }; },
    });
    expect(order).toEqual(['ATTEMPTED', 'create']);
    expect(result).toEqual({ id: 'voucher' });
  });
  it('keeps the same attempt identity when recording failure and never retries the money write', async () => {
    const events: { action: string; requestId: string; reason?: string }[] = [];
    let writes = 0;
    await expect(runTrackedCommissionCreation(input, {
      record: async event => { events.push(event); },
      create: async () => { writes++; throw new Error('Connection lost'); },
    })).rejects.toThrow(/kiểm tra/);
    expect(writes).toBe(1);
    expect(events.map(event => event.action)).toEqual(['ATTEMPTED', 'FAILED']);
    expect(events[0].requestId).toBe(events[1].requestId);
    expect(events[1].reason).toContain('Connection lost');
  });
  it('reports failed error persistence while the previously recorded attempt remains recoverable', async () => {
    const events: string[] = [];
    await expect(runTrackedCommissionCreation(input, {
      record: async event => { if (event.action === 'FAILED') throw new Error('offline'); events.push(event.action); },
      create: async () => { throw new Error('timeout'); },
    })).rejects.toThrow(/chưa lưu được chi tiết lỗi/i);
    expect(events).toEqual(['ATTEMPTED']);
  });
  it('rejects malformed or silently truncated status responses', () => {
    expect(() => commissionFollowupPageSchema.parse({ rows: [], total: -1 })).toThrow();
    expect(() => commissionFollowupPageSchema.parse({ rows: [{ state: 'PAID' }], total: 1 })).toThrow();
  });
});

describe('durable creation boundary',()=>{
 const org='11111111-1111-4111-8111-111111111111', contract='22222222-2222-4222-8222-222222222222';
 const payload={contract_id:contract,kind:'broker' as const,amount:100,voucher_date:'2026-09-29'};
 it('persists both selected intents in a single request before any execute',async()=>{
  rpcMock.mockImplementationOnce(async(_name,args)=>({data:(args as {p_intents:{contract_id:string;kind:string;request_id:string}[]}).p_intents.map(i=>({contract_id:i.contract_id,kind:i.kind,request_id:i.request_id})),error:null}) as never);
  const receipts=await prepareCommissionCreations(org,[payload,{...payload,kind:'sale'}]);
  expect(receipts.map(r=>r.kind).sort()).toEqual(['broker','sale']);
  expect(new Set(receipts.map(r=>r.request_id)).size).toBe(2);
 });
 it('rejects a missing receipt instead of allowing a partial batch',async()=>{
  rpcMock.mockResolvedValueOnce({data:[],error:null} as never);
  await expect(prepareCommissionCreations(org,[payload])).rejects.toThrow();
 });
 it('rejects zero before RPC and a FAILED HTTP200 is not creation success',async()=>{
  const count=rpcMock.mock.calls.length;
  await expect(prepareCommissionCreations(org,[{...payload,amount:0}])).rejects.toThrow();
  expect(rpcMock.mock.calls.length).toBe(count);
  rpcMock.mockResolvedValueOnce({data:{status:'FAILED',id:null,code:null},error:null} as never);
  await expect(executeCommissionCreation(org,{contract_id:contract,kind:'broker',request_id:org})).rejects.toThrow(/chưa tạo/i);
 });
 it('accepts redacted existing receipt without inventing a voucher id',async()=>{
  rpcMock.mockResolvedValueOnce({data:{status:'ALREADY_EXISTS',id:null,code:null},error:null} as never);
  expect(await executeCommissionCreation(org,{contract_id:contract,kind:'sale',request_id:org})).toEqual({status:'ALREADY_EXISTS',id:null,code:null});
 });
});
