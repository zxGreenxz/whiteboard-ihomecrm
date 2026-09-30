// @vitest-environment jsdom
import {cleanup,renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),toast:vi.fn()}));vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));vi.mock('sonner',()=>({toast:{error:m.toast}}));
import {usePraSummary,usePraTimeseries,usePraTopRooms,usePraFunnel,usePraByToken,usePraErrors,usePraErrorGroups} from '../usePublicRoomsAnalytics';
const filters={start:'2026-09-01',end:'2026-09-30'};
const summary={total_sessions:0,total_views:0,room_opens:0,impressions:0,contact_clicks:0,favorites:0,deposit_dialogs:0,errors:0,avg_session_ms:'12.5',unique_rooms_seen:0,errors_external:0,error_hits:0,error_groups:0,error_groups_external:0};
const time={bucket:'2026-09-30T00:00:00Z',sessions:0,events:0,room_opens:0,contact_clicks:0};
const rooms={room_id:null,room_name:null,room_code:null,building_name:null,open_count:0,impression_count:0,total_dwell_ms:0,avg_dwell_ms:0,contact_clicks:0};
const funnel={sessions:0,sessions_impression:0,sessions_opened_room:0,sessions_contacted:0};
const token={token:'room-a',label:null,revoked:false,sessions:0,views:0,room_opens:0,contact_clicks:0,errors:0,avg_session_ms:0};
const errorRow={created_at:'2026-09-30T00:00:00Z',token:'room-a',session_id:'session-a',kind:null,message:null,context:null,user_agent:null,source:'external',line_no:null,col_no:null,stack:null,href:null,viewport:null,build:null,fingerprint:'fp-a',n:1};
const group={fingerprint:'fp-a',kind:null,message:null,source:'app',context:null,total_count:1,sessions:1,first_seen:'2026-09-30T00:00:00Z',last_seen:'2026-09-30T00:00:00Z',sample_stack:null,sample_user_agent:null,sample_href:null,sample_build:null,sample_token:null};
const variants=[{name:'summary',useHook:()=>usePraSummary(filters),valid:summary,bad:{...summary,total_sessions:'BAD'},singleton:true},{name:'timeseries',useHook:()=>usePraTimeseries(filters),valid:time,bad:{...time,bucket:'BAD'},singleton:false},{name:'rooms',useHook:()=>usePraTopRooms(filters),valid:rooms,bad:{...rooms,open_count:null},singleton:false},{name:'funnel',useHook:()=>usePraFunnel(filters),valid:funnel,bad:{...funnel,sessions_contacted:-1},singleton:true},{name:'token',useHook:()=>usePraByToken(filters),valid:token,bad:{...token,revoked:'false'},singleton:false},{name:'errors',useHook:()=>usePraErrors(filters),valid:errorRow,bad:{...errorRow,source:'UNKNOWN'},singleton:false},{name:'groups',useHook:()=>usePraErrorGroups(filters),valid:group,bad:{...group,last_seen:'BAD'},singleton:false}];
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{children}</QueryClientProvider>;
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
for(const v of variants){
 const useHook=()=>{const q=v.useHook();return {isError:q.isError,isSuccess:q.isSuccess,data:q.data,error:q.error};};
 it.each([null,{},[{}],[v.bad]])(v.name+' rejects null/malformed without zero totals %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useHook,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.data).toBeUndefined();});
 it(v.name+' accepts valid nullable SQL fields and real zero values',async()=>{m.rpc.mockResolvedValue({data:[v.valid],error:null});const h=renderHook(useHook,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toBeTruthy();});
 it(v.name+' '+(v.singleton?'rejects absent aggregate row':'accepts legitimate empty list'),async()=>{m.rpc.mockResolvedValue({data:[],error:null});const h=renderHook(useHook,{wrapper});await waitFor(()=>expect(v.singleton?h.result.current.isError:h.result.current.isSuccess).toBe(true));if(!v.singleton)expect(h.result.current.data).toEqual([]);});
}
it('source code remains available; query error feedback is region-owned, not repeated toast',async()=>{const error={code:'42501',message:'SQL_PRIVATE'};m.rpc.mockResolvedValue({data:null,error});const h=renderHook(()=>usePraSummary(filters),{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.error).toBe(error);expect(m.toast).not.toHaveBeenCalled();});
it.each(['', ' ', 'Infinity', 'NaN', null, -1, '1.5'])('summary counter rejects coerced zero or fractional %j',async value=>{m.rpc.mockResolvedValue({data:[{...summary,total_sessions:value}],error:null});const h=renderHook(()=>usePraSummary(filters),{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));});
