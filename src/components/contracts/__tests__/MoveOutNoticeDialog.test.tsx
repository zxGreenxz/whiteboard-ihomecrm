// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import RegisterMoveOutDialog from '../RegisterMoveOutDialog';
import { MoveOutDialog } from '../MoveOutDialog';

const actions = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/hooks/useContractMoveOutNotice', () => ({
  useReadContractMoveOutNotice: () => ({ mutateAsync: actions.read }),
  useSaveContractMoveOutNotice: () => ({ mutateAsync: actions.save, isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useUpdateContract: () => ({mutate:vi.fn(),isPending:false}) }));
vi.mock('@/hooks/useContractOperations', () => ({ useRegisterMoveOut: () => ({mutate:vi.fn(),isPending:false}) }));
vi.mock('@/components/ui/date-input', () => ({ DateInput: ({value,onChange,disabled}: {value:string;onChange:(value:string)=>void;disabled?:boolean}) =>
  <input aria-label="Ngày dự kiến trả phòng" value={value} onChange={e=>onChange(e.target.value)} disabled={disabled} /> }));

const contract = { id:'contract', expected_move_out_date:'2026-09-28', updated_at:'old',status:'ACTIVE' } as ContractWithRelations;
const fresh = {contract_id:'contract',organization_id:'org',expected_move_out_date:'2026-09-29',updated_at:'2026-09-28T01:00:00.123456Z',today:'2026-09-30',status:'ACTIVE'};
afterEach(cleanup);
beforeEach(() => {actions.read.mockReset().mockResolvedValue(fresh);actions.save.mockReset().mockResolvedValue(fresh);});

it('both entrypoints use the fresh server date and preserve its exact version on edit', async () => {
  const close = vi.fn();
  const view = render(<RegisterMoveOutDialog open onOpenChange={close} contract={contract} />);
  expect((await screen.findByLabelText('Ngày dự kiến trả phòng') as HTMLInputElement).value).toBe('2026-09-29');
  fireEvent.change(screen.getByLabelText('Ngày dự kiến trả phòng'),{target:{value:'2026-10-01'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu ngày dự kiến'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith({contractId:'contract',expectedUpdatedAt:fresh.updated_at,expectedMoveOutDate:'2026-10-01',reason:''}));
  await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
  view.unmount();
  render(<MoveOutDialog open onOpenChange={close} contract={contract} />);
  expect((await screen.findByLabelText('Ngày dự kiến trả phòng') as HTMLInputElement).value).toBe('2026-09-29');
});

it('requires a reason before cancelling a notice for a tenant who stays', async () => {
  render(<RegisterMoveOutDialog open onOpenChange={()=>{}} contract={contract} />);
  fireEvent.click(await screen.findByRole('button',{name:'Hủy báo trả phòng'}));
  expect(actions.save).not.toHaveBeenCalled();
  await screen.findByText('Vui lòng nhập lý do hủy báo trả phòng');
  fireEvent.change(screen.getByLabelText('Lý do / ghi chú'),{target:{value:'Khách ở tiếp'}});
  fireEvent.click(screen.getByRole('button',{name:'Hủy báo trả phòng'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith({contractId:'contract',expectedUpdatedAt:fresh.updated_at,expectedMoveOutDate:null,reason:'Khách ở tiếp'}));
});

it('displays a read failure without editing a stale cached contract and retries explicitly', async () => {
  actions.read.mockRejectedValueOnce({code:'42501'});
  render(<RegisterMoveOutDialog open onOpenChange={()=>{}} contract={contract} />);
  fireEvent.click(await screen.findByRole('button',{name:'Thử tải lại'}));
  expect(actions.save).not.toHaveBeenCalled();
  expect((await screen.findByLabelText('Ngày dự kiến trả phòng') as HTMLInputElement).value).toBe('2026-09-29');
});

it('keeps dirty fields on a background contract refresh, reloads on reopen and ignores a late read after close', async () => {
  const view = render(<RegisterMoveOutDialog open onOpenChange={()=>{}} contract={contract} />);
  await screen.findByLabelText('Ngày dự kiến trả phòng');
  fireEvent.change(screen.getByLabelText('Ngày dự kiến trả phòng'),{target:{value:'2026-10-01'}});
  const backgroundContract = {...contract,expected_move_out_date:'2026-10-02'};
  view.rerender(<RegisterMoveOutDialog open onOpenChange={()=>{}} contract={backgroundContract} />);
  expect((screen.getByLabelText('Ngày dự kiến trả phòng') as HTMLInputElement).value).toBe('2026-10-01');
  view.rerender(<RegisterMoveOutDialog open={false} onOpenChange={()=>{}} contract={contract} />);
  let finish!: (value:typeof fresh)=>void;
  actions.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  view.rerender(<RegisterMoveOutDialog open onOpenChange={()=>{}} contract={contract} />);
  await waitFor(()=>expect(actions.read).toHaveBeenCalledTimes(2));
  expect(screen.queryByLabelText('Ngày dự kiến trả phòng')).toBeNull();
  view.rerender(<RegisterMoveOutDialog open={false} onOpenChange={()=>{}} contract={contract} />);
  await act(async()=>finish(fresh));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a version conflict keeps the dialog open and offers loading the winning notice', async () => {
  actions.save.mockRejectedValueOnce({code:'PT409'});
  const close = vi.fn();
  render(<RegisterMoveOutDialog open onOpenChange={close} contract={contract} />);
  fireEvent.click(await screen.findByRole('button',{name:'Lưu ngày dự kiến'}));
  await screen.findByRole('button',{name:'Tải lại báo trả phòng'});
  expect(close).not.toHaveBeenCalled();
});
