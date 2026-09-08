// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerFormData } from '@/types/customer';
import CustomerIndividualFields from '../CustomerIndividualFields';
import CustomerVehiclesSection from '../CustomerVehiclesSection';

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { value: () => false });
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => undefined });
});
afterEach(cleanup);

function FieldHarness() {
  const form = useForm<CustomerFormData>({
    defaultValues: {
      full_name: '',
      phone: '',
      gender: '',
      is_foreign: false,
      vehicles: [{ vehicle_type: 'MOTORBIKE', vehicle_name: '', color: '', license_plate: '' }],
    },
  });
  return (
    <FormProvider {...form}>
      <output aria-label="gender-value">{form.watch('gender')}</output>
      <output aria-label="vehicle-value">{form.watch('vehicles.0.vehicle_type')}</output>
      <CustomerIndividualFields />
      <CustomerVehiclesSection />
    </FormProvider>
  );
}

describe('searchable customer fields', () => {
  it('preserves the regular-form gender literal selected through search', () => {
    render(<FieldHarness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Giới tính' }));
    fireEvent.change(screen.getByPlaceholderText('Tìm giới tính...'), { target: { value: 'nu' } });
    fireEvent.click(screen.getByRole('option', { name: 'Nữ' }));
    expect(screen.getByLabelText('gender-value').textContent).toBe('Nữ');
  });

  it('preserves the vehicle enum selected through search', () => {
    render(<FieldHarness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Loại phương tiện 1' }));
    fireEvent.change(screen.getByPlaceholderText('Tìm loại phương tiện...'), { target: { value: 'o to' } });
    expect(screen.queryByRole('option', { name: 'Xe máy' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Ô tô' }));
    expect(screen.getByLabelText('vehicle-value').textContent).toBe('CAR');
  });
});
