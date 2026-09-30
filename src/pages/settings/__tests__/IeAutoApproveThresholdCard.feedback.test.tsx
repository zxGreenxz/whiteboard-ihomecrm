// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({query:{data:100,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()} as {data:number|null|undefined;status:'success'|'pending'|'error';fetchStatus:string;isLoading:boolean;isError:boolean;error:unknown;refetch:ReturnType<typeof vi.fn>},save:vi.fn(),notify:vi.fn()}));
vi.mock('@/hooks/useIeAutoApproveThreshold',()=>({useIeAutoApproveThreshold:()=>h.query,useSetIeAutoApproveThreshold:()=>h.save}));
vi.mock('@/components/layout/MainLayout',()=>({default:()=>null}));
vi.mock('@/components/notifications/NotificationOrgConfigCard',()=>({default:()=>null}));
vi.mock('@/hooks/useSettings',()=>({}));
vi.mock('@/hooks/useAccountingStandard',()=>({}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/actionFeedback',async original=>({...await original<typeof import('@/lib/actionFeedback')>(),notifyActionError:h.notify}));
vi.mock('sonner',()=>({toast:{success:vi.fn()}}));
import {IeAutoApproveThresholdCard} from '../GeneralSettingsPage';
beforeEach(()=>{h.save.mockReset();h.notify.mockReset();h.query={data:100,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()};});
afterEach(cleanup);
it('does not present read failure as no approval threshold',()=>{
 h.query={...h.query,data:undefined,status:'error',isError:true,error:{code:'42501',message:'permission denied'}};
 render(<IeAutoApproveThresholdCard/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được ngưỡng tự duyệt phiếu chi');
 expect(screen.queryByText(/Hiện chưa đặt ngưỡng/)).toBeNull();
 expect(screen.queryByRole('button',{name:'Lưu ngưỡng'})).toBeNull();
});
it('preserves an edited amount when the server value refreshes',()=>{
 const view=render(<IeAutoApproveThresholdCard/>);
 const input=screen.getByRole('textbox',{name:'Ngưỡng tự duyệt phiếu chi'});
 fireEvent.change(input,{target:{value:'200'}});
 h.query={...h.query,data:150};view.rerender(<IeAutoApproveThresholdCard/>);
 expect((input as HTMLInputElement).value).toBe('200');
});
it('keeps the draft and a visible warning after uncertain save and blocks resending',async()=>{
 h.save.mockRejectedValue({status:504,message:'upstream timeout'});
 render(<IeAutoApproveThresholdCard/>);
 const input=screen.getByRole('textbox',{name:'Ngưỡng tự duyệt phiếu chi'});
 fireEvent.change(input,{target:{value:'200'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu ngưỡng'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());
 expect((input as HTMLInputElement).value).toBe('200');
 const save=screen.getByRole('button',{name:'Lưu ngưỡng'}) as HTMLButtonElement;
 expect(save.disabled).toBe(true);
 fireEvent.click(save);expect(h.save).toHaveBeenCalledTimes(1);
 expect(h.notify).toHaveBeenCalledTimes(1);
});
