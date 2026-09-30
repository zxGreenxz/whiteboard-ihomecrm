// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const h = vi.hoisted(() => ({ success:vi.fn(), custom:vi.fn(), dismiss:vi.fn() }));
vi.mock('sonner', () => ({toast:h}));
import { copyTextWithFeedback } from '../clipboardFeedback';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('success waits for clipboard confirmation', async () => {
  let complete!: () => void;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{complete=resolve;})}});
  const work = copyTextWithFeedback('nội dung','thông tin khách');
  expect(h.success).not.toHaveBeenCalled();
  complete();
  expect(await work).toBe(true);
  expect(h.success).toHaveBeenCalledWith('Đã sao chép thông tin khách.');
});
it('rejected clipboard offers selectable original text instead of false success', async () => {
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});
  expect(await copyTextWithFeedback('0901234567','số điện thoại')).toBe(false);
  expect(h.success).not.toHaveBeenCalled();
  render(h.custom.mock.calls[0][0]('toast-id'));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('0901234567');
  expect(screen.getByRole('alert').textContent).toContain('Chưa sao chép được');
});
