// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ query: {} as Record<string,unknown> }));
vi.mock('@/hooks/useRoomPriceHistory',()=>({useRoomPriceHistory:()=>h.query,ROOM_PRICE_SOURCE_LABELS:{ROOM_EDIT:'Sửa phòng'}}));
import { RoomPriceHistorySection } from '../RoomPriceHistorySection';
afterEach(cleanup);
const fixture = (extra: Record<string,unknown>={}) => h.query={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:new Error('Failed to fetch'),refetch:vi.fn(),dataUpdatedAt:0,...extra};
it('read failure cannot be displayed as no recorded price changes and offers retry', () => {
 const q=fixture();render(<RoomPriceHistorySection roomId="room-demo"/>);
 expect(screen.queryByText(/Chưa có thay đổi giá nào/)).toBeNull();
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được lịch sử giá');
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
 return Promise.resolve().then(()=>expect(q.refetch).toHaveBeenCalledOnce());
});
it('a successful empty history retains the empty message',()=>{
 fixture({data:[],status:'success',isError:false,error:null});
 render(<RoomPriceHistorySection roomId="room-demo"/>);
 expect(screen.getByText(/Chưa có thay đổi giá nào/)).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
});
it('refetch failure retains known history with stale warning',()=>{
 fixture({data:[{id:'h1',room_id:'room-demo',source:'ROOM_EDIT',changed_at:'2026-09-30T01:00:00Z',contract_number:null,changed_by_name:'Người kiểm tra',rent_price_before:1000000,rent_price_after:2000000,deposit_before:0,deposit_after:0,note:null}],dataUpdatedAt:1000});
 render(<RoomPriceHistorySection roomId="room-demo"/>);
 expect(screen.getByText(/Người kiểm tra/)).toBeTruthy();
 expect(screen.getByRole('alert').textContent).toContain('Đang hiển thị kết quả tải lúc');
});
