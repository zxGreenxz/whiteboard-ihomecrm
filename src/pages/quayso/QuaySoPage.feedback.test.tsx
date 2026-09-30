// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ upload: vi.fn(), save: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/luckyDrawApi', () => ({
  uploadLuckyProof: api.upload, luckySavePayout: api.save, fetchLuckyPublicState: api.fetch,
  PROOF_MAX_FILES: 10, PROOF_MAX_BYTES: 10 * 1024 * 1024,
}));
vi.mock('./LuckyWheelCanvas', () => ({ default: () => null, fireConfetti: vi.fn() }));
vi.mock('./AnimalRaceTrack', () => ({ default: () => null }));
vi.mock('./MultiRoundStage', () => ({ default: () => null }));
import { PayoutForm } from './QuaySoPage';
import type { LuckyTeamPublic } from '@/lib/luckyDrawApi';
const team = { id: 'team', name: 'Đội A', proofs: [] } as unknown as LuckyTeamPublic;
beforeAll(() => { URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
describe('proof attachment feedback', () => {
  it('does not claim attachment success without the server returning the saved team', async () => {
    api.upload.mockResolvedValue({ path: 'event/stable.png', name: 'coc.png' });
    api.save.mockResolvedValue({ ok: true, event:{id:'event'}, teams: [] });
    const { container } = render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['image'], 'coc.png')] } });
    await screen.findByText(/Tệp đã tải lên, đang chờ xác nhận: coc.png/);
    expect(screen.queryByText(/Đã nộp 1\/1/)).toBeNull();
  });
  it('keeps uploaded paths when attachment fails and reconciles without uploading again', async () => {
    api.upload.mockResolvedValue({ path: 'event/stable.png', name: 'coc.png' });
    api.save.mockRejectedValueOnce(new Error('SQL internal'));
    const onSaved = vi.fn();
    const { container } = render(<PayoutForm eventId="event" code="123456" team={team} onSaved={onSaved} />);
    const file = new File(['image'], 'coc.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText(/Tệp đã tải lên, đang chờ xác nhận: coc.png/);
    expect(container.textContent).not.toContain('SQL');
    expect(container.querySelector('input[type="file"]')?.hasAttribute('disabled')).toBe(true);
    api.fetch.mockResolvedValue({ ok: true, event:{id:'event'}, teams: [{ id: 'team', isMine: true, proofs: [{ path: 'event/stable.png', name: 'coc.png' }] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra và gắn các tệp đã tải' }));
    await waitFor(() => expect(screen.queryByText(/Tệp đã tải lên, đang chờ xác nhận/)).toBeNull());
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalled();
  });
});

it('retries only the failed proof and retains the first uploaded identity',async()=>{
 const first={path:'event/a.png',name:'a.png'},second={path:'event/b.png',name:'b.png'};
 api.upload.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('failed upload')).mockResolvedValueOnce(second);
 api.save.mockResolvedValueOnce({ok:true,event:{id:'event'},teams:[{id:'team',isMine:true,proofs:[first]}]}).mockResolvedValueOnce({ok:true,event:{id:'event'},teams:[{id:'team',isMine:true,proofs:[first,second]}]});
 const {container}=render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 const files=[new File(['a'],'a.png'),new File(['b'],'b.png')];
 fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files}});
 await screen.findByRole('button',{name:'Thử lại b.png'});
 fireEvent.click(screen.getByRole('button',{name:'Thử lại b.png'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Thử lại b.png'})).toBeNull());
 expect(api.upload.mock.calls.map(call=>call[1].name)).toEqual(['a.png','b.png','b.png']);
 expect(api.save.mock.calls[1][1].proofs.map((proof:{path:string})=>proof.path)).toEqual([first.path,second.path]);
});
it('keeps payout fields open if the response does not confirm those values for this team',async()=>{
 api.save.mockResolvedValue({ok:true,event:{id:'event'},teams:[]});
 render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'Số tài khoản nhận thưởng'}),{target:{value:'0123456789'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Ngân hàng'}),{target:{value:'VCB'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Chủ tài khoản'}),{target:{value:'An'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu số tài khoản'}));
 await screen.findByText(/Chưa xác nhận được tài khoản/);
 expect(screen.getByRole('textbox',{name:'Số tài khoản nhận thưởng'})).toBeTruthy();
 expect(screen.queryByText(/Đã lưu tài khoản/)).toBeNull();
});

it('retains uploaded identities through full unmount/remount before attachment reconciliation', async () => {
 api.upload.mockResolvedValue({path:'event/reload.png',name:'reload.png'});
 api.save.mockRejectedValue(new Error('timeout'));
 const first=render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 fireEvent.change(first.container.querySelector('input[type="file"]')!,{target:{files:[new File(['a'],'reload.png')]}});
 await screen.findByText(/Tệp đã tải lên, đang chờ xác nhận: reload.png/);
 first.unmount();
 const second=render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 expect(screen.getByText(/Tệp đã tải lên, đang chờ xác nhận: reload.png/)).toBeTruthy();
 expect(second.container.querySelector('input[type="file"]')?.hasAttribute('disabled')).toBe(true);
 api.fetch.mockResolvedValue({ok:true,event:{id:'event'},teams:[{id:'team',isMine:true,proofs:[{path:'event/reload.png',name:'reload.png'}]}]});
 fireEvent.click(screen.getByRole('button',{name:'Kiểm tra và gắn các tệp đã tải'}));
 await waitFor(()=>expect(screen.queryByText(/Tệp đã tải lên, đang chờ xác nhận/)).toBeNull());
 expect(api.upload).toHaveBeenCalledTimes(1);expect(api.save).toHaveBeenCalledTimes(1);
});

it('retains an upload with a lost response through remount and never attaches or uploads it blindly',async()=>{
 api.upload.mockImplementationOnce(async(_event:string,file:File,lifecycle:{onPlanned:(proof:{path:string;name:string})=>void})=>{lifecycle.onPlanned({path:'event/uncertain.png',name:file.name});throw new TypeError('Failed to fetch');});
 const first=render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 fireEvent.change(first.container.querySelector('input[type="file"]')!,{target:{files:[new File(['a'],'lost.png')]}});
 await screen.findByText(/Chưa xác nhận được kết quả tải: lost.png/);
 expect(screen.getByRole('button',{name:'Thử lại lost.png'}).hasAttribute('disabled')).toBe(true);
 expect(api.save).not.toHaveBeenCalled();first.unmount();
 const second=render(<PayoutForm eventId="event" code="123456" team={team} onSaved={vi.fn()}/>);
 expect(screen.getByText(/Chưa xác nhận được kết quả tải: lost.png/)).toBeTruthy();
 expect(second.container.querySelector('input[type="file"]')?.hasAttribute('disabled')).toBe(true);
 expect(api.upload).toHaveBeenCalledTimes(1);expect(api.save).not.toHaveBeenCalled();
});
