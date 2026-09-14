// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildingLegalOwnerFields } from '../BuildingLegalOwnerFields';
import { useBuildingLegalOwnerForm } from '@/hooks/useBuildingLegalOwnerForm';
const backend = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/buildingLegalOwner', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/buildingLegalOwner')>();
  return { ...original, loadBuildingLegalOwner: backend.load, saveBuildingLegalOwner: backend.save };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
function Fixture({ buildingId }: { buildingId?: string }) {
  const owner = useBuildingLegalOwnerForm(buildingId, true);
  return <form onSubmit={async event => { event.preventDefault(); if (await owner.validate()) await owner.save(buildingId ?? 'new').catch(() => {}); }}>
    <BuildingLegalOwnerFields {...owner} /><button type="submit">Lưu thử</button>
  </form>;
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('shared owner form', () => {
  it('saves the validated snapshot if the dialog resets during a delayed building request', async () => {
    backend.save.mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ open }) => useBuildingLegalOwnerForm(undefined, open), { initialProps: { open: true } });
    act(() => { result.current.form.setValue('full_name', 'Chủ đúng', { shouldDirty: true }); });
    const snapshot = result.current.form.getValues();
    const pendingSave = result.current.save;
    rerender({ open: false });
    expect(result.current.form.getValues().full_name).toBe('');
    await act(async () => { await pendingSave('created', snapshot); });
    expect(backend.save).toHaveBeenCalledWith('created', expect.objectContaining({ full_name: 'Chủ đúng' }));
  });
  it('keeps CCCD as text, saves incomplete values and avoids writing an unchanged retry', async () => {
    backend.save.mockResolvedValue(undefined);
    render(<Fixture />);
    fireEvent.change(screen.getByLabelText('CCCD/CMND chủ sở hữu'), { target: { value: '001234567890' } });
    fireEvent.click(screen.getByText('Lưu thử'));
    await waitFor(() => expect(backend.save).toHaveBeenCalledWith('new', expect.objectContaining({ id_number: '001234567890', birth_year: null })));
    await act(async () => { fireEvent.click(screen.getByText('Lưu thử')); });
    expect(backend.save).toHaveBeenCalledTimes(1);
  });
  it('retains user edits after failed save so retry submits them', async () => {
    backend.save.mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined);
    render(<Fixture />);
    fireEvent.change(screen.getByLabelText('Họ tên chủ sở hữu'), { target: { value: 'Chủ hợp pháp' } });
    await act(async () => { fireEvent.click(screen.getByText('Lưu thử')); });
    expect((screen.getByLabelText('Họ tên chủ sở hữu') as HTMLInputElement).value).toBe('Chủ hợp pháp');
    await act(async () => { fireEvent.click(screen.getByText('Lưu thử')); });
    expect(backend.save).toHaveBeenCalledTimes(2);
  });
  it('blocks saving when owner load fails and restores saved identity on retry', async () => {
    backend.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ full_name: 'Nguyễn Chủ', birth_year: 1970, id_number: '0099', id_issue_date: null, id_issue_place: '', permanent_address: '' });
    render(<Fixture buildingId="existing" />);
    await screen.findByRole('alert');
    await act(async () => { fireEvent.click(screen.getByText('Lưu thử')); });
    expect(backend.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Tải lại'));
    await waitFor(() => expect((screen.getByLabelText('Họ tên chủ sở hữu') as HTMLInputElement).value).toBe('Nguyễn Chủ'));
  });
});
