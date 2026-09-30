// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
type ReadFixture = { data: unknown; error: unknown };
type ContractFixture = React.ComponentProps<typeof DeleteContractDialog>['contract'];
const h=vi.hoisted(()=>({read:{data:[],error:null} as ReadFixture,write:vi.fn()}));
vi.mock('@/hooks/useContracts',()=>({useDeleteContract:()=>({mutateAsync:h.write,isPending:false})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const b:Record<string,unknown>={};for(const k of ['select','eq'])b[k]=()=>b;b.limit=async()=>h.read;return b;}}}));
import {DeleteContractDialog} from '../DeleteContractDialog';
beforeEach(()=>{h.read={data:[],error:null};h.write.mockReset().mockRejectedValue({code:'XX000',message:'SELECT private'});});afterEach(cleanup);
it('read failure has inline retry, hides delete action and does not conclude no dependencies',async()=>{h.read={data:null,error:{code:'42501',message:'SELECT private'}};render(<DeleteContractDialog open onOpenChange={()=>{}} contract={{id:'c1',contract_number:'HD01'} as ContractFixture}/>);await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Xóa'})).toBeNull();expect(document.body.textContent).not.toContain('SELECT private');h.read={data:[],error:null};fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await screen.findByRole('button',{name:'Xóa'});});
it('write failure retains confirmation dialog and shows safe persistent error',async()=>{const close=vi.fn();render(<DeleteContractDialog open onOpenChange={close} contract={{id:'c1',contract_number:'HD01'} as ContractFixture}/>);fireEvent.click(await screen.findByRole('button',{name:'Xóa'}));await screen.findByRole('alert');expect(close).not.toHaveBeenCalled();expect(screen.getByRole('alertdialog')).toBeTruthy();expect(h.write).toHaveBeenCalledWith('c1');expect(document.body.textContent).not.toContain('SELECT private');});
