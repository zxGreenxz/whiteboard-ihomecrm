// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
import {renderHook,act} from '@testing-library/react';
const h=vi.hoisted(()=>({error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{type QueryFixture={update:()=>QueryFixture;eq:()=>QueryFixture;is:()=>QueryFixture;select:()=>Promise<{data:null;error:{code:string;message:string}}>};const b:QueryFixture={update:()=>b,eq:()=>b,is:()=>b,select:async()=>({data:null,error:{code:'42501',message:'SELECT private'}})};return b;}}}));
vi.mock('sonner',()=>({toast:{error:h.error}}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:vi.fn()}));
import {QueryProvider,queryClient} from '@/app/providers/QueryProvider';
import {useUpdateInvoiceNote} from '../useUpdateInvoiceNote';
beforeEach(()=>{queryClient.clear();vi.clearAllMocks();});
it('note form owns exactly one error with the real MutationCache',async()=>{const {result}=renderHook(()=>useUpdateInvoiceNote(),{wrapper:QueryProvider});await act(async()=>{try{await result.current.mutateAsync({invoice_id:'inv',notes:'draft'});}catch{expect(h.error).not.toHaveBeenCalled();h.error('Chưa lưu được ghi chú hóa đơn.');}});expect(h.error).toHaveBeenCalledTimes(1);});
