// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({save:vi.fn(),add:vi.fn(),create:vi.fn(),sourceError:false,rules:{repair:1,weekendRepair:1,afterHourContract:1,afterHourMark:'18:00',weekendDays:[0],requirePhoto:false}}));
const bonusData={rules:m.rules};
const query=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:m.sourceError,error:{message:'private_table'},refetch:vi.fn()});
vi.mock('@tanstack/react-query',()=>({useQuery:(options:{queryKey:string[]})=>query(options.queryKey[0]==='profiles-for-salary'?[{id:'u',full_name:'An'}]:[])}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),info:vi.fn(),error:vi.fn(),warning:vi.fn()}}));
vi.mock('@/hooks/useSalaryConfig',()=>({
 useSalaryConfigList:()=>query([]),useBonusRules:()=>query(bonusData),
 useSaveManagerConfig:()=>({mutateAsync:m.save}),useSaveBonusRules:()=>({mutateAsync:m.save}),useSalaryHolidays:()=>query([]),useAddHoliday:()=>({mutateAsync:m.add}),useDeleteHoliday:()=>({mutate:vi.fn()}),useStaffMonthOverrides:()=>query({}),useSaveStaffMonthOverride:()=>({mutate:vi.fn()}),useSalaryLockedMonths:()=>query(new Set()),
}));
vi.mock('@/hooks/useSalaryExtras',()=>({newSalaryRequestKey:()=> 'key-fixture',useSetLineOverride:()=>({mutateAsync:m.save}),useCreateRecurring:()=>({mutateAsync:m.create}),useAddRecurringVersion:()=>({mutateAsync:m.save}),useDeleteRecurring:()=>({mutateAsync:m.save})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>query([])}));
import SalaryConfig from '../SalaryConfig';
import SalaryAmountEditDialog from '../SalaryAmountEditDialog';
import SalaryRecurringRules from '../SalaryRecurringRules';
afterEach(()=>{cleanup();vi.clearAllMocks();m.sourceError=false;});
it('ngày lễ trống thì đỏ và focus ngày, không gửi',async()=>{
 render(<SalaryConfig/>);fireEvent.click(screen.getByRole('button',{name:'Thêm ngày'}));
 fireEvent.click(within(document.querySelector('.sal-modal')! as HTMLElement).getByRole('button',{name:'Thêm'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('holiday_date'));
 expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');expect(m.add).not.toHaveBeenCalled();
});
it('cấu hình tải lỗi không cho lưu mặc định hoặc nạp lễ',()=>{
 m.sourceError=true;render(<SalaryConfig/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');expect(screen.queryByRole('button',{name:'Lưu'})).toBeNull();
});
it('sửa số tiền cần lý do, focus đúng ô và giữ nội dung khi máy chủ từ chối',async()=>{
 m.save.mockRejectedValue({message:'Phải ghi lý do',code:'22023'});
 render(<SalaryAmountEditDialog m={{id:'u',name:'An'} as never} line={{key:'bonus',label:'Thưởng',computed:100,current:100,ovr:null}} periodMonth="2026-09-01" onClose={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('Số tiền mới'),{target:{value:'200'}});fireEvent.click(screen.getByRole('button',{name:'Lưu số mới'}));
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('Lý do (bắt buộc)')));expect(m.save).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Lý do (bắt buộc)'),{target:{value:'Bổ sung công'}});fireEvent.click(screen.getByRole('button',{name:'Lưu số mới'}));
 await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.getByLabelText('Lý do (bắt buộc)').getAttribute('aria-invalid')).toBe('true'));
 expect((screen.getByLabelText('Số tiền mới') as HTMLInputElement).value).toBe('200');
});
it('khoản định kỳ chưa nhập tên không gửi, đưa focus đúng trường',async()=>{
 render(<SalaryRecurringRules managers={[{id:'u',name:'An',adjustments:[]} as never]} recurring={[]} periodMonth="2026-09-01" canEdit available initialAdd={{staffId:'u'}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Tạo khoản định kỳ'}));
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('Tên khoản')));
 expect(screen.getByLabelText('Tên khoản').getAttribute('aria-invalid')).toBe('true');expect(m.create).not.toHaveBeenCalled();
});

it('lương tháng âm giữ đúng nội dung, đỏ và focus, không gửi số dương',async()=>{render(<SalaryConfig/>);fireEvent.click(screen.getByRole('button',{name:'Thêm'}));fireEvent.change(screen.getByLabelText('Nhân viên'),{target:{value:'u'}});fireEvent.change(screen.getByLabelText('Lương tháng'),{target:{value:'-100'}});fireEvent.click(within(document.querySelector('.sal-modal')! as HTMLElement).getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByLabelText('Lương tháng').getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(screen.getByLabelText('Lương tháng'));expect((screen.getByLabelText('Lương tháng') as HTMLInputElement).value).toBe('-100');expect(m.save).not.toHaveBeenCalled();});
it('quy tắc thưởng có chữ không bị đổi thành số khác',async()=>{render(<SalaryConfig/>);const input=document.querySelector('[name="repair"]')!;fireEvent.change(input,{target:{value:'20abc'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(input.getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(input);expect((input as HTMLInputElement).value).toBe('20abc');expect(m.save).not.toHaveBeenCalled();});
it('sửa tiền khoản không cho phép âm không bỏ dấu trừ khi gửi',async()=>{render(<SalaryAmountEditDialog m={{id:'u',name:'An'} as never} line={{key:'bonus',label:'Thưởng',computed:100,current:100,ovr:null}} periodMonth="2026-09-01" onClose={vi.fn()}/>);fireEvent.change(screen.getByLabelText('Số tiền mới'),{target:{value:'-200'}});fireEvent.change(screen.getByLabelText('Lý do (bắt buộc)'),{target:{value:'Điều chỉnh'}});fireEvent.click(screen.getByRole('button',{name:'Lưu số mới'}));await waitFor(()=>expect(screen.getByLabelText('Số tiền mới').getAttribute('aria-invalid')).toBe('true'));expect(m.save).not.toHaveBeenCalled();});
