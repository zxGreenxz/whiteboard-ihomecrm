// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ listings: {} as Record<string, unknown>, rooms: {} as Record<string, unknown>, customers: {} as Record<string, unknown>, retry: vi.fn(), remove: vi.fn(), upsert: vi.fn() }));
const mutation = (fn: typeof io.remove) => ({ isPending: false, mutate: (value: unknown, options?: { onSuccess?: () => void }) => { void fn(value).then(options?.onSuccess, () => {}); } });
vi.mock('@/hooks/usePassListings', () => ({
 usePassListings: () => io.listings, usePassListingFormRooms: () => io.rooms, usePassListingRoomCustomers: () => io.customers,
 useUpsertPassListing: () => mutation(io.upsert), useSetPassListingActive: () => mutation(vi.fn()),
 useDeletePassListing: () => mutation(io.remove),
}));
import PassListingsTab from '../PassListingsTab';
import MobilePassListings from '../mobile/MobilePassListings';
const query = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: io.retry, dataUpdatedAt: Date.now() });
const failure = (data: unknown = undefined) => ({ ...query(data), status: 'error', isError: true, error: { code: '42501', message: 'PRIVATE_SQL' } });
beforeEach(() => { vi.clearAllMocks(); io.listings = query([]); io.rooms = query([]); io.customers = query([]); io.remove.mockRejectedValue({ code: '42501' }); io.upsert.mockResolvedValue({}); });
afterEach(cleanup);
const listing = { id: 'pass-a', room_id: 'room-a', active: true, contact_name: 'Draft khách', contact_phone: '', pass_price: null, sale_policy: null, avail_date: null, contact_manager: false };
function open(mobile: boolean) { return render(mobile ? <MobilePassListings onHeaderAction={() => {}} /> : <PassListingsTab />); }
it.each([false, true])('listing error is retryable and never an empty list mobile=%s', async mobile => {
 io.listings = failure(); open(mobile);
 expect(screen.getByText('Chưa tải được phòng khách nhờ sale.')).toBeTruthy();
 expect(screen.queryByText(/Chưa có phòng khách nhờ sale/)).toBeNull();
 expect(document.body.textContent).not.toContain('PRIVATE_SQL');
 fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
 await waitFor(() => expect(io.retry).toHaveBeenCalled());
});
it.each([false, true])('room source failure is explicit, never a deleted-room claim mobile=%s', mobile => {
 io.listings = query([listing]); io.rooms = failure(); open(mobile);
 expect(screen.getByText('Chưa tải được phòng khách nhờ sale.')).toBeTruthy();
 expect(screen.queryByText('Phòng đã xoá')).toBeNull();
});
it.each([false, true])('customer source failure preserves the editing draft and blocks save mobile=%s', async mobile => {
 io.listings = query([listing]); io.customers = failure(); open(mobile);
 fireEvent.click(screen.getByTitle('Sửa'));
 const dialog = await screen.findByRole('dialog');
 expect(within(dialog).getByText('Chưa tải được khách thuê phòng.')).toBeTruthy();
 const input = within(dialog).getByDisplayValue('Draft khách');
 expect(input).toBeTruthy();
 expect(within(dialog).getByRole('button', { name: 'Lưu' })).toHaveProperty('disabled', true);
 expect(io.upsert).not.toHaveBeenCalled();
});
it.each([false, true])('failed deletion keeps the confirmation open mobile=%s', async mobile => {
 io.listings = query([listing]); open(mobile);
 fireEvent.click(screen.getByTitle('Xoá'));
 const dialog = await screen.findByRole(mobile ? 'dialog' : 'alertdialog');
 fireEvent.click(within(dialog).getByRole('button', { name: 'Xoá' }));
 await waitFor(() => expect(io.remove).toHaveBeenCalledWith('pass-a'));
 expect(screen.getByRole(mobile ? 'dialog' : 'alertdialog')).toBe(dialog);
});

it.each([false, true])('raw malformed price remains visible, red and focused without writer mobile=%s', async mobile => {
 io.listings = query([listing]); open(mobile); fireEvent.click(screen.getByTitle('Sửa'));
 const dialog = await screen.findByRole('dialog');
 const price = within(dialog).getByPlaceholderText('Để trống = giá phòng');
 fireEvent.change(price,{target:{value:'abc2'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(document.activeElement).toBe(price));
 expect(price).toHaveProperty('value','abc2');
 expect(price.getAttribute('aria-invalid')).toBe('true');
 const errorId=price.getAttribute('aria-describedby');
 expect(errorId).toBeTruthy();expect(document.getElementById(errorId!)?.textContent).toContain('số');
 expect(io.upsert).not.toHaveBeenCalled();
 expect(within(dialog).getByDisplayValue('Draft khách')).toBeTruthy();
});
it.each([false,true])('preserves signed and decimal SQL numeric prices without silently stripping mobile=%s', async mobile=>{
 for(const [raw,expected] of [['-100',-100],['1.5',1.5],['',null]] as const){
  io.listings=query([listing]);const view=open(mobile);fireEvent.click(screen.getByTitle('Sửa'));
  const dialog=await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByPlaceholderText('Để trống = giá phòng'),{target:{value:raw}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Lưu'}));
  await waitFor(()=>expect(io.upsert).toHaveBeenLastCalledWith(expect.objectContaining({passPrice:expected})));
  view.unmount();
 }
});
it('quick board preselection opens the exact room and defaults new pass contact to the manager', async () => {
 io.rooms=query([{room_id:'room-a',room_name:'101',building_name:'Tòa A',room_code:'101',has_active_contract:true}]);
 render(<PassListingsTab focusRoomId="room-a" />);
 const dialog=await screen.findByRole('dialog');
 expect(within(dialog).getByRole('switch',{name:'Liên hệ quản lý (ẩn SĐT khách)'}).getAttribute('aria-checked')).toBe('true');
 expect(within(dialog).getByRole('combobox')).toHaveProperty('disabled',true);
 fireEvent.click(within(dialog).getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(io.upsert).toHaveBeenCalledWith(expect.objectContaining({roomId:'room-a',id:null,contactManager:true})));
});
it('quick board edits an existing active pass without allowing its source room to be moved', async () => {
 io.listings=query([listing]);
 io.rooms=query([{room_id:'room-a',room_name:'101',building_name:'Tòa A',room_code:'101',has_active_contract:true}]);
 render(<PassListingsTab focusRoomId="room-a" />);
 const dialog=await screen.findByRole('dialog');
 expect(within(dialog).getByText('Sửa phòng khách nhờ sale')).toBeTruthy();
 expect(within(dialog).getByRole('combobox')).toHaveProperty('disabled',true);
 fireEvent.click(within(dialog).getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(io.upsert).toHaveBeenCalledWith(expect.objectContaining({roomId:'room-a',id:'pass-a'})));
});

it('quick board permission withdrawal preserves an open pass draft but prevents submission', async () => {
 io.listings=query([listing]);
 io.rooms=query([{room_id:'room-a',room_name:'101',building_name:'Tòa A',room_code:'101',has_active_contract:true}]);
 const view=render(<PassListingsTab focusRoomId="room-a" />);
 const dialog=await screen.findByRole('dialog');
 fireEvent.change(within(dialog).getByDisplayValue('Draft khách'),{target:{value:'Khách đang nhập'}});
 view.rerender(<PassListingsTab focusRoomId="room-a" blockedReason="Quyền cập nhật phòng vừa bị thu hồi." />);
 expect(within(dialog).getByDisplayValue('Khách đang nhập')).toBeTruthy();
 expect(within(dialog).getByRole('button',{name:'Lưu'})).toHaveProperty('disabled',true);
 fireEvent.click(within(dialog).getByRole('button',{name:'Lưu'}));
 expect(io.upsert).not.toHaveBeenCalled();
 expect(within(dialog).getByRole('alert').textContent).toContain('thu hồi');
});
