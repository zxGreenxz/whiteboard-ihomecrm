// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ read: vi.fn(), listeners: new Map<string, () => void>(), remove: vi.fn() }));
vi.mock('@/lib/contractSettlementEventRepository', () => ({ readSettlementEventPage: state.read }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  channel: () => { const channel = { on: (_: string, filter: { table: string }, listener: () => void) => { state.listeners.set(filter.table, listener); return channel; }, subscribe: () => channel }; return channel; }, removeChannel: state.remove,
} }));
import { useContractSettlementEvents } from '../useContractSettlementEvents';
const scope = { organizationId: 'dddd0000-0000-4000-8000-000000000001', actorId: 'dddd0000-0000-4000-8000-000000000002', scopeRevision:'v1', buildingIds:['dddd0000-0000-4000-8000-000000000003'] };
const page = { organizationId:scope.organizationId,actorId:scope.actorId,rows:[],nextCursor:null,revision:'v1',asOf:'2026-09-20T20:00:00Z' };
const clients: QueryClient[]=[];
const wrapper=()=>{const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});clients.push(client);return ({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;};
beforeEach(()=>{state.read.mockReset();state.listeners.clear();state.remove.mockClear();});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());});
describe('event live query',()=>{
 it('does not query an absent scope and invalidates on extension/link events',async()=>{
  const hook=renderHook(({enabled})=>useContractSettlementEvents(scope,enabled),{initialProps:{enabled:false},wrapper:wrapper()});
  expect(state.read).not.toHaveBeenCalled();state.read.mockResolvedValue(page);hook.rerender({enabled:true});
  await waitFor(()=>expect(hook.result.current.complete).toBe(true));
  for(const table of ['contract_extensions','contract_terminations','contract_transfers','contract_deposit_links','reservation_deposit_settlements'])expect(state.listeners.has(table)).toBe(true);
  await act(async()=>{state.listeners.get('contract_extensions')!();});
  await waitFor(()=>expect(state.read).toHaveBeenCalledTimes(2));
  hook.unmount();expect(state.remove).toHaveBeenCalled();
 });
 it('rejects a failed refresh, hides raw error and never keeps complete=true',async()=>{
  state.read.mockResolvedValue(page);const hook=renderHook(()=>useContractSettlementEvents(scope),{wrapper:wrapper()});
  await waitFor(()=>expect(hook.result.current.complete).toBe(true));state.read.mockRejectedValue(Error('EVENT_READ_DENIED'));
  await act(async()=>{await expect(hook.result.current.refresh()).rejects.toThrow('Chưa tải lại đủ biến động');});
  await waitFor(()=>expect(hook.result.current.complete).toBe(false));
  expect(hook.result.current.error).toBe('Bạn không có quyền xem biến động trong phạm vi này.');
 });
 it('new actor cannot consume an old actor payload or cache',async()=>{
  state.read.mockResolvedValue(page);const hook=renderHook(({actorId})=>useContractSettlementEvents({...scope,actorId}),{initialProps:{actorId:scope.actorId},wrapper:wrapper()});
  await waitFor(()=>expect(hook.result.current.complete).toBe(true));
  hook.rerender({actorId:scope.buildingIds[0]});expect(hook.result.current.complete).toBe(false);
  await waitFor(()=>expect(hook.result.current.error).not.toBeNull());expect(hook.result.current.rows).toEqual([]);
 });
});
