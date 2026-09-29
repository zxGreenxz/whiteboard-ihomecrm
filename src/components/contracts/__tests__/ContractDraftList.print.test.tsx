// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft } from '@/lib/contractDrafts';
import { ContractDraftList } from '../ContractDraftList';

const data = vi.hoisted(() => ({ drafts: [] as ContractDraft[], remove: vi.fn() }));
vi.mock('@/hooks/useContractDrafts', () => ({
  useContractDrafts: () => ({ data: data.drafts, isLoading: false, isError: false }),
  useDownloadContractDraftDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteContractDraft: () => ({ mutateAsync: data.remove, isPending: false }),
}));

const org = '11111111-1111-4111-8111-111111111111';
function draft(id: string, status: 'EDITABLE' | 'SIGNED'): ContractDraft {
  return { id, organization_id: org, building_id: '22222222-2222-4222-8222-222222222222',
    room_id: null, template_id: null, payload: emptyContractDraftPayload(), revision: 1,
    created_by: '33333333-3333-4333-8333-333333333333', created_at: '2026-09-29', updated_at: '2026-09-29',
    documents: [{ id: '44444444-4444-4444-8444-444444444444', draft_id: id, revision: 1,
      document_path: 'doc', template_path: 'tpl', document_sha256: 'a'.repeat(64), template_sha256: 'b'.repeat(64),
      template_snapshot: { id: '55555555-5555-4555-8555-555555555555', name: 'Mẫu A', updated_at: '2026-09-29' },
      created_at: '2026-09-29' }], status, converted_contract_id: status === 'SIGNED'
      ? '66666666-6666-4666-8666-666666666666' : null };
}
afterEach(cleanup);

it('shows exactly one In action per printable draft and keeps signing separate', () => {
  data.drafts = [draft('77777777-7777-4777-8777-777777777777', 'EDITABLE'),
    draft('88888888-8888-4888-8888-888888888888', 'SIGNED')];
  const onPrint = vi.fn();
  render(<ContractDraftList canEdit canExport canSign onEdit={vi.fn()} onPrint={onPrint}
    onSign={vi.fn()} onTransfer={vi.fn()} />);
  const print = screen.getAllByRole('button', { name: /^In$/ });
  expect(print).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /Xuất nháp|Tải v\d/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Sửa nháp' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Xác nhận đã ký' })).toBeTruthy();
  print[1].click();
  expect(onPrint).toHaveBeenCalledWith(data.drafts[1]);
});

function renderDeletable(canDelete = (_draft: ContractDraft) => true) {
  data.remove.mockReset().mockResolvedValue(undefined);
  data.drafts = [draft('77777777-7777-4777-8777-777777777777','EDITABLE'),draft('88888888-8888-4888-8888-888888888888','SIGNED')];
  render(<ContractDraftList canEdit canExport canSign canDelete={canDelete} onEdit={vi.fn()} onPrint={vi.fn()} onSign={vi.fn()} onTransfer={vi.fn()}/>);
}
it('offers delete only for unsigned drafts in the authorized building and cancelling does nothing',()=>{
  renderDeletable();
  expect(screen.getAllByRole('button',{name:'Xóa nháp'})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Xóa nháp'}));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Hủy'}));
  expect(data.remove).not.toHaveBeenCalled();
});
it('does not offer delete without building permission',()=>{
  renderDeletable(()=>false);
  expect(screen.queryByRole('button',{name:'Xóa nháp'})).toBeNull();
});
it('deletes the selected exact revision only after confirmation',async()=>{
  renderDeletable();fireEvent.click(screen.getByRole('button',{name:'Xóa nháp'}));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xóa nháp'}));
  await waitFor(()=>expect(data.remove).toHaveBeenCalledWith(data.drafts[0]));
  await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
});
it('retains the confirmation and explains linked drafts when deletion is refused',async()=>{
  renderDeletable();data.remove.mockRejectedValue({code:'55000',message:'Hủy liên kết nhượng trước khi xoá bản nháp'});
  fireEvent.click(screen.getByRole('button',{name:'Xóa nháp'}));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xóa nháp'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Hủy liên kết nhượng'));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});
