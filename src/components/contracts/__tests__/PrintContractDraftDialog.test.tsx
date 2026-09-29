// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft, type ContractDraftDocument } from '@/lib/contractDrafts';
import { PrintContractDraftDialog } from '../PrintContractDraftDialog';

const org = '11111111-1111-4111-8111-111111111111';
const templateA = '22222222-2222-4222-8222-222222222222';
const templateB = '33333333-3333-4333-8333-333333333333';
const document: ContractDraftDocument = { id: '44444444-4444-4444-8444-444444444444',
  draft_id: '55555555-5555-4555-8555-555555555555', revision: 1, document_path: 'doc', template_path: 'tpl',
  document_sha256: 'a'.repeat(64), template_sha256: 'b'.repeat(64),
  template_snapshot: { id: templateA, name: 'Mẫu A', updated_at: '2026-09-29' }, created_at: '2026-09-29' };
const actions = vi.hoisted(() => ({ save: vi.fn(), export: vi.fn(), download: vi.fn(), official: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: org }) }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: [
  { id: templateA, name: 'Mẫu A', file_name: 'A.docx', is_default: true, is_active: true, organization_id: org },
  { id: templateB, name: 'Mẫu B', file_name: 'B.docx', is_default: false, is_active: true, organization_id: org },
], isLoading: false, isError: false }) }));
vi.mock('@/hooks/useContractDrafts', () => ({
  useSaveContractDraft: () => ({ mutateAsync: actions.save, isPending: false }),
  useExportContractDraft: () => ({ mutateAsync: actions.export, isPending: false }),
  useDownloadContractDraftDocument: () => ({ mutateAsync: actions.download, isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContract: (id?: string) => ({ data: id ? { id } : null, isPending: false, isError: false }) }));
vi.mock('../PrintContractDialog', () => ({ PrintContractDialog: ({ contract }: { contract: { id: string } | null }) => {
  actions.official(contract?.id); return <p>Official print dialog</p>;
} }));

function draft(status: 'EDITABLE' | 'SIGNED' = 'EDITABLE'): ContractDraft {
  return { id: document.draft_id, organization_id: org, building_id: '66666666-6666-4666-8666-666666666666',
    room_id: '77777777-7777-4777-8777-777777777777', template_id: templateA,
    payload: emptyContractDraftPayload(), revision: 1, created_by: '88888888-8888-4888-8888-888888888888',
    created_at: '2026-09-29', updated_at: '2026-09-29', documents: [document], status,
    converted_contract_id: status === 'SIGNED' ? '99999999-9999-4999-8999-999999999999' : null };
}
beforeEach(() => { actions.save.mockReset(); actions.export.mockReset(); actions.download.mockReset().mockResolvedValue(undefined); actions.official.mockReset(); });
afterEach(cleanup);

it('uses the official template picker and downloads an existing current revision without a save', async () => {
  const current = draft();
  const onPrinted = vi.fn();
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={current} canEdit onPrinted={onPrinted} />);
  expect(screen.getByRole('dialog', { name: 'In hợp đồng' })).toBeTruthy();
  expect(screen.getByText('Chọn mẫu hợp đồng')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));
  await waitFor(() => expect(actions.download).toHaveBeenCalledWith(document));
  expect(actions.save).not.toHaveBeenCalled();
  expect(actions.export).not.toHaveBeenCalled();
  expect(onPrinted).toHaveBeenCalledWith(current);
});

it('saves a changed template with CAS, exports the new revision, then returns its document', async () => {
  const current = draft();
  const nextDocument = { ...document, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 2,
    template_snapshot: { id: templateB, name: 'Mẫu B', updated_at: '2026-09-29' } };
  const saved = { ...current, template_id: templateB, revision: 2, documents: [] };
  actions.save.mockResolvedValue(saved);
  actions.export.mockResolvedValue({ document: nextDocument, blob: new Blob() });
  const onPrinted = vi.fn();
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={current} canEdit onPrinted={onPrinted} />);
  fireEvent.click(screen.getByRole('radio', { name: /Mẫu B/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({
    draftId: current.id, expectedRevision: 1, templateId: templateB, payload: current.payload,
  })));
  await waitFor(() => expect(actions.export).toHaveBeenCalledWith(expect.objectContaining({ draft: saved,
    template: expect.objectContaining({ id: templateB }) })));
  expect(actions.download).not.toHaveBeenCalled();
  expect(onPrinted).toHaveBeenCalledWith({ ...saved, documents: [nextDocument] });
});

it('does not mutate a draft without edit permission when the template changes', () => {
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={draft()} canEdit={false} />);
  fireEvent.click(screen.getByRole('radio', { name: /Mẫu B/ }));
  expect(screen.getByRole('button', { name: 'Tải xuống .docx' }).hasAttribute('disabled')).toBe(true);
  expect(actions.save).not.toHaveBeenCalled();
});

it('retries export after a successful template save without incrementing the draft again', async () => {
  const current = draft();
  const nextDocument = { ...document, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 2,
    template_snapshot: { id: templateB, name: 'Mẫu B', updated_at: '2026-09-29' } };
  const saved = { ...current, template_id: templateB, revision: 2, documents: [] };
  actions.save.mockResolvedValue(saved);
  actions.export.mockRejectedValueOnce(new Error('storage unavailable'))
    .mockResolvedValueOnce({ document: nextDocument, blob: new Blob() });
  const onPrinted = vi.fn();
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={current} canEdit onPrinted={onPrinted} />);
  fireEvent.click(screen.getByRole('radio', { name: /Mẫu B/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));
  await waitFor(() => expect(onPrinted).toHaveBeenCalledWith({ ...saved, documents: [nextDocument] }));
  expect(actions.save).toHaveBeenCalledTimes(1);
  expect(actions.export).toHaveBeenCalledTimes(2);
});

it('reports a saved revision before export, even when export fails, without claiming print success', async () => {
  const current = draft();
  const saved = { ...current, template_id: templateB, revision: 2, documents: [] };
  actions.save.mockResolvedValue(saved);
  actions.export.mockRejectedValue(new Error('storage unavailable'));
  const onDraftSaved = vi.fn();
  const onPrinted = vi.fn();
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={current} canEdit
    onDraftSaved={onDraftSaved} onPrinted={onPrinted} />);
  fireEvent.click(screen.getByRole('radio', { name: /Mẫu B/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));
  await waitFor(() => expect(actions.export).toHaveBeenCalled());
  expect(onDraftSaved).toHaveBeenCalledWith(saved);
  expect(onPrinted).not.toHaveBeenCalled();
});

it('delegates signed history to the official contract print dialog', () => {
  render(<PrintContractDraftDialog open onOpenChange={vi.fn()} draft={draft('SIGNED')} canEdit={false} />);
  expect(screen.getByText('Official print dialog')).toBeTruthy();
  expect(actions.official).toHaveBeenCalledWith('99999999-9999-4999-8999-999999999999');
});
