// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SearchableSelect } from '../searchable-select';
import { DateInput } from '../date-input';
import { MonthInput } from '../month-input';
afterEach(cleanup);
it('forwards error semantics and the actual focus ref to a searchable select', () => {
  const ref = React.createRef<HTMLButtonElement>();
  render(<SearchableSelect ref={ref} value="" onValueChange={() => {}} options={[]} aria-label="Tòa nhà" aria-invalid="true" aria-describedby="building-error" data-field-name="building" />);
  const control = screen.getByRole('combobox');
  expect(control.getAttribute('aria-invalid')).toBe('true');
  expect(control.getAttribute('aria-describedby')).toBe('building-error');
  expect(control.getAttribute('data-field-name')).toBe('building');
  ref.current?.focus();
  expect(document.activeElement).toBe(control);
});
it('forwards linked error props to real date and month inputs', () => {
  render(<><DateInput aria-label="Ngày" aria-invalid="true" aria-describedby="date-error" /><MonthInput aria-label="Tháng" aria-invalid="true" aria-describedby="month-error" /></>);
  expect(screen.getByLabelText('Ngày').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Tháng').getAttribute('aria-describedby')).toBe('month-error');
});
