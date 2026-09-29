import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { commissionFollowupPageSchema, runTrackedCommissionCreation } from '../contractCommissionFollowup';

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
