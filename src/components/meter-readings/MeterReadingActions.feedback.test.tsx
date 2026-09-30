// @vitest-environment jsdom
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import { cleanup, fireEvent, render, screen,waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const actions = vi.hoisted(() => ({ mutate: vi.fn(), clear: vi.fn() }));
vi.mock('@/hooks/useMeterReadings', () => ({ useBulkDeleteMeterReadings: () => ({ mutate: actions.mutate, isPending: false }) }));
import MeterReadingActions from './MeterReadingActions';
afterEach(() => { cleanup(); actions.mutate.mockReset(); actions.clear.mockReset(); });

it('giữ xác nhận và ID đã chọn khi xóa hàng loạt chưa thành công', () => {
  render(<MeterReadingActions selectedIds={['reading-1']} onClearSelection={actions.clear} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xoá hàng loạt' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xoá' }));
  expect(actions.mutate).toHaveBeenCalledOnce();
  expect(actions.clear).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

it('unknown batch deletion displays IDs and blocks a repeated confirmation',async()=>{actions.mutate.mockImplementation((_ids,options)=>{options.onError?.(new FinancialWorkflowError('Chưa xác nhận xoá.','unknown',[{id:'r1',label:'Chỉ số cần đối chiếu'}]));});render(<MeterReadingActions selectedIds={['r1']} onClearSelection={actions.clear}/>);fireEvent.click(screen.getByRole('button',{name:'Xoá hàng loạt'}));fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('r1'));fireEvent.click(screen.getByRole('button',{name:'Xoá'}));expect(actions.mutate).toHaveBeenCalledTimes(1);expect(actions.clear).not.toHaveBeenCalled();});
