import type {ReactNode} from 'react';
// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({save:vi.fn(),publish:vi.fn()}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:ReactNode})=><>{children}</>}));
vi.mock('@/components/errors/QueryRegion',()=>({QueryRegion:({children}:{children:ReactNode})=><>{children}</>}));
vi.mock('@/hooks/useFeeConfigMatrix',()=>({FEE_KINDS:[{key:'dien',label:'Tiền điện'}],useSaveFeeConfig:()=>({mutateAsync:h.save,isPending:false}),useFeeConfigMatrix:()=>({data:[],isLoading:false,isError:false,byBuilding:new Map([['b1',{name:'Tòa Demo',cells:new Map([['dien',{buildingId:'b1',feeCategory:'dien',defaultAmount:100000,providerCode:'',accountHolder:'',notApplicable:false,voucherCount:0}]])}]]),summary:{total:1,notApplicable:0,running:0},refetch:vi.fn()})}));
vi.mock('@/hooks/useSpecialFeePrices',()=>({useSetSpecialFeePrice:()=>({mutateAsync:h.publish,isPending:false}),useSpecialFeePrices:()=>({data:[],byCell:new Map([['b1:dien',{amount:null,canEdit:true}]]),publishedCount:0,canEditAny:true,isLoading:false})}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import FixedFeesPage from '../FixedFeesPage';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();h.save.mockResolvedValue('config1');h.publish.mockResolvedValue({effectiveFrom:'2026-09'});});
it.each(['-10','abc2','1.5'])('công bố giá %s không được đổi thành số tiền khác',async raw=>{
 render(<FixedFeesPage/>);fireEvent.click(screen.getByRole('button',{name:'Công bố giá'}));const input=screen.getByRole('textbox',{name:'Mức phí mỗi tháng'});fireEvent.change(input,{target:{value:raw}});fireEvent.click(screen.getByRole('button',{name:/^Công bố$/}));await screen.findByRole('alert');expect(input).toHaveProperty('value',raw);expect(input.getAttribute('aria-invalid')).toBe('true');await waitFor(()=>expect(document.activeElement).toBe(input));expect(h.publish).not.toHaveBeenCalled();
});
it('gợi ý giá invalid giữ bản nháp và focus, không gọi lưu cấu hình',async()=>{
 render(<FixedFeesPage/>);fireEvent.click(screen.getByRole('button',{name:'Sửa gợi ý Tiền điện của Tòa Demo'}));const input=screen.getByPlaceholderText('Giá mỗi kỳ');fireEvent.change(input,{target:{value:'-10'}});fireEvent.keyDown(input,{key:'Enter'});await screen.findByRole('alert');expect(input).toHaveProperty('value','-10');expect(input.getAttribute('aria-invalid')).toBe('true');await waitFor(()=>expect(document.activeElement).toBe(input));expect(h.save).not.toHaveBeenCalled();
});
it('giá nguyên có dấu ngăn nghìn hợp lệ giữ đúng giá trị',async()=>{
 render(<FixedFeesPage/>);fireEvent.click(screen.getByRole('button',{name:'Công bố giá'}));fireEvent.change(screen.getByRole('textbox',{name:'Mức phí mỗi tháng'}),{target:{value:'1.500.000'}});fireEvent.click(screen.getByRole('button',{name:/^Công bố$/}));await waitFor(()=>expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({amount:1500000})));
});
