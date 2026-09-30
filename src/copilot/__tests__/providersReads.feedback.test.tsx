// @vitest-environment jsdom
import {cleanup,renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reply:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUserId:async()=> 'actor-a'}));
vi.mock('@/hooks/useUiPreferences',()=>({useUiPreferences:()=>({data:{}}),useSetUiPreference:()=>({mutate:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const b={select:()=>b,eq:()=>b,maybeSingle:()=>m.reply(),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve().then(()=>m.reply()).then(resolve)};return b;}}}));
import {useAiProviders,useCopilotEntitlement} from '../useAiProviders';
const cloud={provider:'cloud',label:'Cloud A',enabled:true,models:[{id:'m',label:'M',pricing_mode:'free',input_price:0,output_price:0}],default_model:'m',data_class:'cloud'};
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{children}</QueryClientProvider>;
beforeEach(()=>{vi.clearAllMocks();m.reply.mockResolvedValue({data:null,error:null});});afterEach(cleanup);
it.each([null,{},[{}],[{...cloud,models:null}],[{...cloud,enabled:'true'}],[{...cloud,models:[{}]}]])('provider catalog missing/malformed cannot silently become no models %j',async data=>{m.reply.mockResolvedValue({data,error:null});const h=renderHook(useAiProviders,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));});
it('actual priced model and confirmed [] remain usable',async()=>{m.reply.mockResolvedValue({data:[cloud],error:null});const h=renderHook(useAiProviders,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toEqual([{value:'cloud:m',label:'M — Cloud A',provider:'cloud',localOnly:false}]);});
it.each([{}, {chat_enabled:'false',ui_control_enabled:false},[]])('entitlement source malformed cannot be interpreted as denied/allowed %j',async data=>{m.reply.mockResolvedValue({data,error:null});const h=renderHook(useCopilotEntitlement,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));});
it('confirmed missing entitlement is legitimate null',async()=>{const h=renderHook(useCopilotEntitlement,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toBeNull();});
