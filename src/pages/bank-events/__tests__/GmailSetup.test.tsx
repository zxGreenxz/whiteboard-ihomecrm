// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { GmailSetup } from '../GmailSetup';

const token = 'a'.repeat(64), ingestUrl = 'https://fixture.example.test/functions/v1/bank-event-ingest';
const mount = (url: string | null = ingestUrl, onClose = vi.fn()) => render(
  <Dialog open><DialogContent><GmailSetup name="Gmail chủ" token={token} ingestUrl={url} onClose={onClose} /></DialogContent></Dialog>,
);
const script = () => (screen.queryByLabelText('Script Apps Script') as HTMLTextAreaElement | null)?.value ?? null;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('builds the script with the source key, ingest address and both mail filters', () => {
  mount();
  expect(script()).toContain(`"khoa": "${token}"`);
  expect(script()).toContain(`"diaChiNhan": "${ingestUrl}"`);
  expect(script()).toContain('from:(acb.com.vn OR');
  fireEvent.change(screen.getByLabelText('Nhãn Gmail tự gắn (không bắt buộc)'), { target: { value: 'CRM Ngân hàng' } });
  expect(script()).toMatch(/OR label:crm-ngân-hàng\)/);
  fireEvent.click(screen.getByRole('checkbox', { name: /Email từ các ngân hàng/ }));
  expect(script()).toContain('"truyVan": "label:crm-ngân-hàng"');
});

it('does not offer a script that would read nothing or inject search syntax', () => {
  mount();
  fireEvent.click(screen.getByRole('checkbox', { name: /Email từ các ngân hàng/ }));
  expect(screen.getByRole('alert').textContent).toBe('Chọn email ngân hàng hoặc nhập một nhãn Gmail.');
  expect(script()).toBeNull();
  expect((screen.getByRole('button', { name: 'Sao chép script' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Nhãn Gmail tự gắn (không bắt buộc)'), { target: { value: 'crm" OR in:anywhere' } });
  expect(screen.getByRole('alert').textContent).toContain('Nhãn chỉ gồm chữ, số');
  expect(script()).toBeNull();
});

it('copies the exact script, reports clipboard failure and explains a missing ingest address', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const onClose = vi.fn();
  mount(ingestUrl, onClose);
  fireEvent.click(screen.getByRole('button', { name: 'Sao chép script' }));
  await waitFor(() => screen.getByRole('button', { name: 'Đã sao chép script' }));
  expect(writeText).toHaveBeenCalledWith(script());
  writeText.mockRejectedValueOnce(new Error('denied'));
  fireEvent.change(screen.getByLabelText('Nhãn Gmail tự gắn (không bắt buộc)'), { target: { value: 'CRM' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sao chép script' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không truy cập được clipboard'));
  fireEvent.click(screen.getByRole('button', { name: 'Tôi đã dán script · Đóng' }));
  expect(onClose).toHaveBeenCalledOnce();
  cleanup();
  mount(null);
  screen.getByText('Chưa cấu hình địa chỉ nhận. Kiểm tra tab Vận hành.');
  expect(script()).toBeNull();
});
