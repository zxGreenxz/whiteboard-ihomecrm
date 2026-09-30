import type {ComponentProps} from 'react';
// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import EditInvoiceDialog from '../EditInvoiceDialog';
import type {InvoiceWithRelations} from '@/types/invoice';
const io=vi.hoisted(()=>({meter:vi.fn(), services:{data:[] as unknown[]|undefined,isError:false,isPending:false,refetch:vi.fn()},credit:{data:0 as number|undefined,isError:false,isPending:false,refetch:vi.fn()}}));
vi.mock('@/hooks/useInvoices',()=>({useUpdateInvoice:()=>({mutate:vi.fn(),isPending:false}),useExcessAmount:()=>io.credit,useInvoice:vi.fn()}));
vi.mock('@/hooks/useBuildingServices',()=>({useBuildingServices:()=>io.services}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const q={select:()=>q,eq:()=>q,is:()=>q,limit:()=>io.meter()};return q;}}}));
vi.mock('../invoice-entry/InvoiceEntryShell',()=>({InvoiceEntryShell:(p:ComponentProps<typeof import('../invoice-entry/InvoiceEntryShell')['InvoiceEntryShell']>)=><div>{p.notice}<button disabled={p.submit.disabled}>Lưu</button></div>}));
vi.mock('../IssuedInvoiceEditor',()=>({default:()=>null}));
afterEach(cleanup);
beforeEach(()=>{io.meter.mockResolvedValue({data:[],error:null});io.services={data:[],isError:false,isPending:false,refetch:vi.fn()};io.credit={data:0,isError:false,isPending:false,refetch:vi.fn()};});
const invoice={id:'i1',status:'DRAFT',building_id:'b1',room_id:'r1',contract_id:'c1',invoice_items:[],billing_month:'2026-09',issue_date:'2026-09-01',due_date:'2026-09-10'} as unknown as InvoiceWithRelations;
it('chặn lưu và giải thích khi không đọc được công tơ',async()=>{io.meter.mockResolvedValue({data:null,error:{message:'SQL secret'}});render(<EditInvoiceDialog open onOpenChange={()=>{}} invoice={invoice}/>);await waitFor(()=>expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true));expect(await screen.findByText(/Chưa tải được công tơ/)).toBeTruthy();expect(screen.queryByText(/SQL secret/)).toBeNull();});
it('chặn lưu khi nguồn giá dịch vụ tải lỗi',async()=>{io.services={...io.services,data:undefined,isError:true};render(<EditInvoiceDialog open onOpenChange={()=>{}} invoice={invoice}/>);await waitFor(()=>expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true));expect(screen.getByText(/Chưa tải đủ giá dịch vụ/)).toBeTruthy();});
