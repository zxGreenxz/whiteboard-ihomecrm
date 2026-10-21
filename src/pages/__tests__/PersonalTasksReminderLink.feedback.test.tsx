// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter,Route,Routes,useLocation} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor-a'}})}));
vi.mock('@/hooks/usePersonalTasks',()=>({usePersonalTasks:()=>({tasks:[],error:null,loading:false,busy:false,refresh:vi.fn(),add:vi.fn(),change:vi.fn(),remove:vi.fn()})}));
vi.mock('@/hooks/usePersonalTaskReminders',()=>({usePersonalTaskReminders:()=>({settings:{enabled:false},access:'default',error:null})}));
vi.mock('@/components/personal-tasks/ReminderSheet',()=>({ReminderSheet:()=><div role="dialog" aria-label="Nhắc hẹn"/>}));
import PersonalTasksPage from '../PersonalTasksPage';
afterEach(cleanup);
function Search(){return <p data-testid="search">{useLocation().search}</p>;}
const renderAt=(url:string)=>render(<MemoryRouter initialEntries={[url]} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><Routes><Route path="/viec-cua-toi" element={<><PersonalTasksPage/><Search/></>}/></Routes></MemoryRouter>);

it('liên kết từ Cài đặt thông báo mở thẳng ô Nhắc hẹn rồi gỡ tham số khỏi địa chỉ',()=>{
 renderAt('/viec-cua-toi?mo=nhac-hen');
 expect(screen.getByRole('dialog',{name:'Nhắc hẹn'})).toBeTruthy();
 expect(screen.getByTestId('search').textContent).toBe('');
});
it('mở trang bình thường không tự bật ô Nhắc hẹn',()=>{
 renderAt('/viec-cua-toi');
 expect(screen.queryByRole('dialog',{name:'Nhắc hẹn'})).toBeNull();
});
