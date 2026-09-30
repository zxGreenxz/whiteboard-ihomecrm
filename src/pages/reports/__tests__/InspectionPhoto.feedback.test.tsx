// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
const m=vi.hoisted(()=>({failed:true,url:undefined as string|undefined,refetch:vi.fn()}));
vi.mock('@/hooks/useSignedUrl',()=>({useSignedUrlQuery:()=>({data:m.url,status:m.failed?'error':'success',fetchStatus:'idle',isLoading:false,isError:m.failed,error:{message:'private_storage_path'},refetch:m.refetch})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
import {InspPhoto} from '../OwnerDashboardV5';
const photo={id:'p',storage_path:'private/file',slot:'Ảnh mặt trước'} as never;
afterEach(()=>{cleanup();vi.clearAllMocks();m.failed=true;m.url=undefined;});
it('ký ảnh lỗi hiện cảnh báo an toàn và nút đọc lại',()=>{render(<InspPhoto p={photo}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');expect(screen.getByRole('alert').textContent).not.toContain('private_storage_path');fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));return Promise.resolve().then(()=>expect(m.refetch).toHaveBeenCalled());});
it('đường dẫn có nhưng ảnh hỏng không để người dùng chờ mãi',()=>{m.failed=false;m.url='https://example.test/fixture';render(<InspPhoto p={photo}/>);fireEvent.error(screen.getByRole('img'));expect(screen.getByRole('alert').textContent).toContain('Chưa tải được ảnh');fireEvent.click(screen.getByRole('button',{name:'Tải lại ảnh'}));expect(m.refetch).toHaveBeenCalled();});
