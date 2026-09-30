// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
import {renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createElement} from 'react';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc}}));
import {useSalaryCanEditAmounts} from '../useSalaryExtras';
beforeEach(()=>rpc.mockReset());
const run=(data:unknown)=>{rpc.mockResolvedValue({data,error:null});const client=new QueryClient({defaultOptions:{queries:{retry:false}}});return renderHook(()=>useSalaryCanEditAmounts('org'),{wrapper:({children})=>createElement(QueryClientProvider,{client},children)});};
it.each([null,{},'true',0])('malformed permission %j is a source error, not denied',async(data)=>{const h=run(data);await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.data).toBeUndefined();});
it.each([true,false])('confirmed permission %j remains unchanged',async(data)=>{const h=run(data);await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toBe(data);});
