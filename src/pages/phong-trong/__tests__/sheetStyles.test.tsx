// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoucherSheetReadState } from '@/components/income-expenses/VoucherReadState';
import { DetailSheet } from '../PhongTrongSheet';
import { SAMPLE_BUILDINGS } from '../sampleData';

const roomCss = readFileSync(resolve(__dirname, '../phongTrong.css'), 'utf8');
const financeCss = readFileSync(resolve(__dirname, '../../../styles/financeMobile.css'), 'utf8');

afterEach(cleanup);

it('keeps the voucher visible when room sheet styles have already loaded', () => {
  const { container } = render(
    <>
      <style>{roomCss + financeCss}</style>
      <div className="cm-app">
        <VoucherSheetReadState title="Phiếu thu" loading message="" onRetry={vi.fn()} onClose={vi.fn()} />
      </div>
    </>,
  );
  const voucher = container.querySelector<HTMLElement>('[aria-busy="true"]')!;
  expect(getComputedStyle(voucher).transform || 'none').toBe('none');
});

it('slides the room sheet into view when opened', () => {
  const room = { ...SAMPLE_BUILDINGS[0].rooms[0], images: [] };
  const roomProps = {
    room, buildings: SAMPLE_BUILDINGS, saved: [],
    onClose: vi.fn(), onToast: vi.fn(), toggleSave: vi.fn(), onGo: vi.fn(),
  };
  const roomView = (show: boolean) => (
    <>
      <style>{roomCss + financeCss}</style>
      <div id="stage"><div className="app"><DetailSheet {...roomProps} show={show} /></div></div>
    </>
  );
  const { container, rerender } = render(roomView(false));
  const sheet = container.querySelector<HTMLButtonElement>('button[aria-label="Đóng"]')!.parentElement!;
  expect(getComputedStyle(sheet).transform).toBe('translateY(101%)');
  rerender(roomView(true));
  expect(getComputedStyle(sheet).transform).toBe('translateY(0)');
});
