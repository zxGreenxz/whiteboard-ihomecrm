// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
const q=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()});
const h=vi.hoisted(()=>({update:vi.fn()}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:React.ReactNode})=><>{children}</>}));
vi.mock('@/hooks/useSettings',()=>({
 useGeneralSettings:()=>q({contract_show_expiring_status:true}),
 useUpdateGeneralSetting:()=>({mutate:h.update,isPending:false}),
 useCompanyInfo:()=>q({company_name:'A'}),
 useUpdateCompanyInfo:()=>({mutateAsync:vi.fn(),isPending:false}),
 useAcceptanceGeofenceSetting:()=>q({enabled:true,radius_m:70}),
 useUpdateAcceptanceGeofenceSetting:()=>({mutate:vi.fn(),isPending:false}),
}));
vi.mock('@/hooks/useAccountingStandard',()=>({useAccountingStandard:()=>q(null),useSetAccountingStandard:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useIeAutoApproveThreshold',()=>({useIeAutoApproveThreshold:()=>q(null),useSetIeAutoApproveThreshold:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import GeneralSettingsPage from '../GeneralSettingsPage';
beforeEach(()=>vi.clearAllMocks());afterEach(cleanup);
const renderTab=(tab:string)=>render(<MemoryRouter initialEntries={[`/settings/general?tab=${tab}`]} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><GeneralSettingsPage/></MemoryRouter>);

it('tab Thông báo không còn công tắc giả, chỉ dẫn sang trang Cài đặt thông báo',()=>{
 renderTab('notification');
 expect(screen.queryByText('Nhắc ngày lập hóa đơn')).toBeNull();
 expect(screen.queryByText('Nhắc hạn thanh toán')).toBeNull();
 expect(screen.getByRole('link',{name:/Mở Cài đặt thông báo/}).getAttribute('href')).toBe('/account/notifications');
 expect(screen.queryAllByRole('switch')).toHaveLength(0);
});
it('tab Hợp đồng không còn công tắc "Nhận thông báo quá hạn HĐ"',()=>{
 renderTab('contract');
 expect(screen.getByText('Hiển thị trạng thái sắp hết hạn')).toBeTruthy();
 expect(screen.queryByText('Nhận thông báo quá hạn HĐ')).toBeNull();
});
