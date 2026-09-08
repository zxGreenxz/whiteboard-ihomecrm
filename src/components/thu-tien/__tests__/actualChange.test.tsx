// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectKeypad } from '../CollectKeypad';
import { CollectPayForm, type PayFormState } from '../CollectPayForm';

afterEach(cleanup);

function Keypad({ remaining = 7_908_000 }: { remaining?: number }) {
  const [change, setChange] = useState<number | null>(null);
  return <CollectKeypad remaining={remaining} entered="8000" onEntered={() => {}}
    changeAmount={change} onChangeAmount={setChange}
    keepAsCredit={false} onKeepAsCreditChange={() => {}} canCredit
    onConfirm={() => {}} />;
}

describe('editable change in Thu tiền', () => {
  it('keeps deposit shortage as debt when rounding is unavailable', () => {
    render(<CollectKeypad remaining={8_000_000} entered="7995" onEntered={() => {}}
      changeAmount={null} onChangeAmount={() => {}} keepAsCredit={false} onKeepAsCreditChange={() => {}}
      canCredit allowRounding={false} onConfirm={() => {}} />);
    expect(screen.queryByText(/Bỏ qua/)).toBeNull();
    expect(screen.getByText('5.000đ')).toBeTruthy();
  });
  it('can enter change even when customer initially gives the exact amount', () => {
    render(<Keypad remaining={8_000_000} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tiền thối thực tế' }), { target: { value: '5.000' } });
    expect(screen.getByText(/Bỏ qua 5.000/)).toBeTruthy();
  });

  it('exposes the form change field at zero without requiring an overpayment first', () => {
    render(<CollectPayForm remaining={8_333_000} methodAvailable={{ TM: true, TK: false, TT: false }} canCredit onChange={() => {}} />);
    expect((screen.getByRole('textbox', { name: 'Tiền thối thực tế' }) as HTMLInputElement).value).toBe('0');
  });
  it('edits keypad change in đồng and shows the waived amount', () => {
    render(<Keypad />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tiền thối thực tế' }), { target: { value: '100.000' } });
    expect(screen.getByText(/Bỏ qua 8.000/)).toBeTruthy();
    expect(screen.getByText(/thối 100k/)).toBeTruthy();
  });

  it('shows exactly 10.000đ as outstanding instead of waived', () => {
    render(<Keypad />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tiền thối thực tế' }), { target: { value: '102.000' } });
    expect(screen.queryByText(/Bỏ qua/)).toBeNull();
    expect(screen.getByText('10.000đ')).toBeTruthy();
  });

  it('form forwards actual change and rounding, resets when customer amount changes', async () => {
    const onChange = vi.fn<(state: PayFormState) => void>();
    render(<CollectPayForm remaining={8_333_000} methodAvailable={{ TM: true, TK: false, TT: false }}
      canCredit onChange={onChange} />);
    const paidInput = screen.getAllByRole('textbox')[0];
    fireEvent.change(paidInput, { target: { value: '8.500.000' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tiền thối thực tế' }), { target: { value: '170.000' } });
    await waitFor(() => expect(onChange.mock.lastCall?.[0].payload).toMatchObject({ changeAmount: 170_000 }));
    expect(screen.getByText(/Bỏ qua 3.000/)).toBeTruthy();
    fireEvent.change(paidInput, { target: { value: '8.600.000' } });
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Tiền thối thực tế' }) as HTMLInputElement).value).toBe('267.000'));
  });

  it('does not send custom cash change after switching to credit', async () => {
    const onChange = vi.fn<(state: PayFormState) => void>();
    render(<CollectPayForm remaining={8_333_000} methodAvailable={{ TM: true, TK: false, TT: false }} canCredit onChange={onChange} />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '8.500.000' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tiền thối thực tế' }), { target: { value: '170.000' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(onChange.mock.lastCall?.[0].payload).toMatchObject({ keepAsCredit: true, changeAmount: undefined }));
    expect(screen.queryByRole('textbox', { name: 'Tiền thối thực tế' })).toBeNull();
  });
});
