// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateInput } from '../date-input';

afterEach(cleanup);

/** Cha giữ ngày như các màn thật; `accept` cho phép dựng cha từ chối giá trị vừa phát. */
function Controlled({ initial = '', onValue, onLeave, accept = () => true }: {
  initial?: string; onValue: (iso: string) => void; onLeave?: () => void; accept?: (iso: string) => boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DateInput aria-label="Ngày" value={value} onBlur={onLeave} onChange={iso => { onValue(iso); if (accept(iso)) setValue(iso); }} />
      <button type="button" onClick={() => setValue('2026-11-02')}>đổi từ ngoài</button>
      <button type="button" onClick={() => setValue('2026-11-05')}>đổi lại từ ngoài</button>
    </>
  );
}
const field = () => screen.getByLabelText('Ngày') as HTMLInputElement;
const passThrough = () => { fireEvent.focus(field()); fireEvent.blur(field()); };

describe('DateInput: rời ô không phát lại ngày không đổi', () => {
  it('ô đang có ngày, chỉ đi qua (focus rồi blur) thì không gọi onChange nhưng vẫn gọi onBlur', () => {
    const change = vi.fn(); const leave = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} onLeave={leave} />);
    passThrough(); passThrough();
    expect(change).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(2);
    expect(field().value).toBe('04/10/2026');
  });

  it('ô trống đi qua cũng không gọi onChange', () => {
    const change = vi.fn();
    render(<Controlled onValue={change} />);
    passThrough();
    expect(change).not.toHaveBeenCalled();
    expect(field().value).toBe('');
  });

  it('không truyền value (cha không giữ ngày): ô trống đi qua không phát chuỗi rỗng', () => {
    const change = vi.fn();
    render(<DateInput aria-label="Ngày" onChange={change} />);
    passThrough();
    expect(change).not.toHaveBeenCalled();
  });

  it('gõ ngày mới: phát đúng một lần lúc gõ, rời ô không phát lần hai', () => {
    const change = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '05/11/2026' } });
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenLastCalledWith('2026-11-05');
    fireEvent.blur(field());
    expect(change).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('05/11/2026');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cha đổi ngày từ ngoài: ô hiện ngày mới, rời ô không phát lại', () => {
    const change = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'đổi từ ngoài' }));
    expect(field().value).toBe('02/11/2026');
    passThrough();
    expect(change).not.toHaveBeenCalled();
  });

  it('người dùng từng gõ một ngày, cha đổi sang ngày khác rồi đổi lại đúng ngày đó: ô hiện theo cha, rời ô không phát', () => {
    const change = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '05/11/2026' } });
    fireEvent.blur(field());
    fireEvent.click(screen.getByRole('button', { name: 'đổi từ ngoài' }));
    expect(field().value).toBe('02/11/2026');
    passThrough();
    fireEvent.click(screen.getByRole('button', { name: 'đổi lại từ ngoài' }));
    expect(field().value).toBe('05/11/2026');
    passThrough();
    expect(change.mock.calls).toEqual([['2026-11-05']]);
  });

  it.each([['đã từng gõ', true], ['chưa từng gõ', false]])('ô %s, cha đổi sang ngày khác rồi bỏ hẳn value (undefined): ô trống theo cha, rời ô không phát lại ngày cũ', (_label, typedFirst) => {
    const change = vi.fn();
    const view = render(<DateInput aria-label="Ngày" value="2026-10-04" onChange={change} />);
    if (typedFirst) fireEvent.change(field(), { target: { value: '05/11/2026' } });
    change.mockClear();
    view.rerender(<DateInput aria-label="Ngày" value="2026-11-02" onChange={change} />);
    expect(field().value).toBe('02/11/2026');
    view.rerender(<DateInput aria-label="Ngày" onChange={change} />);
    expect(field().value).toBe('');
    passThrough();
    expect(change).not.toHaveBeenCalled();
  });

  it('xoá ngày: phát chuỗi rỗng một lần; cha không nhận thì ô vẫn trống như trước và rời ô không phát lại', () => {
    const change = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} accept={iso => iso !== ''} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '' } });
    expect(change.mock.calls).toEqual([['']]);
    fireEvent.blur(field());
    expect(change.mock.calls).toEqual([['']]);
  });

  it('ngày gõ dở không hợp lệ: rời ô báo lỗi và không phát; gõ lại cho đủ thì phát ngày đó', () => {
    const change = vi.fn();
    render(<Controlled initial="2026-10-04" onValue={change} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '04/10/202' } });
    fireEvent.blur(field());
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('dd/mm/yyyy');
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '04/10/2026' } });
    expect(change.mock.calls).toEqual([['2026-10-04']]);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(field());
    expect(change).toHaveBeenCalledTimes(1);
  });
});
