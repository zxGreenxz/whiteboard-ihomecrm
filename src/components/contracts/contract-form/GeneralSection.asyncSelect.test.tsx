// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useForm } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import type { ContractFormData } from '@/lib/contractValidation';
import type { ContractFormState } from './useContractFormState';
import { GeneralSection } from './GeneralSection';

const buildingId = '22222222-2222-4222-8222-222222222222';
const roomId = '11111111-1111-4111-8111-111111111111';
const onBuildingChange = vi.fn();
const onRoomChange = vi.fn();
const availableBuilding = [{ id: buildingId, name: 'DEMO Toà A' }] as ContractFormState['buildings'];
const availableRoom = [{ id: roomId, name: 'Owned room', status: 'AVAILABLE' }] as ContractFormState['filteredRooms'];

function Harness({ loaded }: { loaded: boolean }) {
  const form = useForm<ContractFormData>({ defaultValues: { room_id: roomId } });
  return <Form {...form}><GeneralSection form={form}
    buildings={loaded ? availableBuilding : []} selectedBuildingId={buildingId}
    filteredRooms={loaded ? availableRoom : []}
    handleBuildingChange={onBuildingChange} handleRoomChange={onRoomChange}
    buildingDisabled /></Form>;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('keeps a saved draft building and room when Radix options arrive asynchronously', async () => {
  const view = render(<Harness loaded={false} />);
  await act(async () => view.rerender(<Harness loaded />));
  expect(onBuildingChange).not.toHaveBeenCalled();
  expect(onRoomChange).not.toHaveBeenCalledWith('');
  expect(view.getAllByRole('combobox')[0].textContent).toContain('DEMO Toà A');
  expect(view.getAllByRole('combobox')[1].textContent).toContain('Owned room');
});
