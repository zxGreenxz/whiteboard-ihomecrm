import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ responses: [] as Array<{data: unknown; error: unknown} | Promise<{data: unknown; error: unknown}>>,
  started: [] as string[], rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/lib/authSession', () => ({getSessionUserId: async () => 'demo'}));
vi.mock('@/integrations/supabase/client', () => ({supabase: {rpc: h.rpc, from: (table: string) => {
  const value = h.responses.shift() ?? {data: [], error:null};
  const builder: Record<string, unknown> = {};
  for (const method of ['select','in','is','lt','lte','gte','gt','neq','eq','not','or','order','limit']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => void) => { h.started.push(table); return Promise.resolve(value).then(resolve); };
  return builder;
}}}));
import { useAlerts, useRecentActivities, useDashboardSummary } from '../useDashboard';
beforeEach(() => { h.responses = []; h.started = []; });
it('does not turn a malformed summary response into zero totals', async () => {
  h.rpc.mockResolvedValue({ data: {}, error: null });
  const query = useDashboardSummary() as unknown as {queryFn: () => Promise<unknown>};
  await expect(query.queryFn()).rejects.toThrow();
});
it.each([0,1,2,3])('alerts source %s failure must not become an empty or incomplete list', async (index) => {
  const failure = { code:'XX000',message:'database error'};
  h.responses = Array.from({length:index}, () => ({data:[], error:null}));
  h.responses.push({data:null,error:failure});
  const query = useAlerts() as unknown as {queryFn:() => Promise<unknown>};
  await expect(query.queryFn()).rejects.toBe(failure);
});
it('starts all four independent alert reads while the first response is still pending', async () => {
  let release!: (value: {data: unknown; error: unknown}) => void;
  h.responses = [new Promise(resolve => { release = resolve; })];
  const query = useAlerts() as unknown as {queryFn:() => Promise<unknown>};
  const pending = query.queryFn();
  try {
    await vi.waitFor(() => expect(h.started).toEqual(['invoices', 'contracts', 'issues', 'contracts']), {timeout: 250, interval: 5});
  } finally {
    release({data: [], error: null});
    await pending;
  }
});
it.each([0,2])('recent activities source %s failure is propagated', async (index) => {
  const failure = {code:'42501',message:'denied'};
  h.responses = Array.from({length:index}, () => ({data:[], error:null}));
  h.responses.push({data:null,error:failure});
  const query = useRecentActivities() as unknown as {queryFn:() => Promise<unknown>};
  await expect(query.queryFn()).rejects.toBe(failure);
});
it('starts independent activity reads while contracts are pending, then reads only the referenced invoices', async () => {
  let release!: (value: {data: unknown; error: unknown}) => void;
  h.responses = [new Promise(resolve => { release = resolve; }),
    {data: [{id: 'receipt', invoice_id: 'invoice', collected_amount: 20, payment_date: '2026-10-19'}], error: null},
    {data: [], error: null}, {data: [], error: null}];
  const query = useRecentActivities() as unknown as {queryFn:() => Promise<unknown>};
  const pending = query.queryFn();
  try {
    await vi.waitFor(() => expect(h.started).toEqual(['contracts', 'active_payment_receipts', 'issues']), {timeout: 250, interval: 5});
  } finally {
    release({data: [], error: null});
    await pending;
  }
  expect(h.started).toEqual(['contracts', 'active_payment_receipts', 'issues', 'invoices']);
});
