// @vitest-environment jsdom
// Dấu "đã đăng ký tạm trú": hiện lần nộp mới nhất, gấp các lần trước thành lịch sử.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));

import RegistrationHistory from '../RegistrationHistory';
import RegistrationManualEntry from '../RegistrationManualEntry';
import type { ResidenceRegistration } from '@/lib/residenceRegistrations';

const ho = (over: Partial<ResidenceRegistration>): ResidenceRegistration => ({
  id: 'r1', organization_id: 'o', building_id: 'b', customer_id: 'c', contract_id: 'ct',
  subm_code: 'G01.899.909-260916-890028', receive_org: 'Công an Phường Hạnh Thông',
  temp_resident_from: '2026-09-16', temp_resident_to: '2028-09-14',
  submitted_at: '2026-09-16T02:25:16.000Z', created_at: '2026-09-16T02:25:16.000Z', ...over,
});

afterEach(cleanup);

describe('RegistrationHistory', () => {
  it('không có lần nộp nào thì không hiện gì', () => {
    const { container } = render(<RegistrationHistory registrations={[]} />);
    expect(container.textContent).toBe('');
  });

  it('hiện mã và hạn của lần nộp mới nhất', () => {
    render(<RegistrationHistory registrations={[ho({})]} />);
    expect(screen.getByText('G01.899.909-260916-890028')).toBeTruthy();
    expect(screen.getByText(/hạn đến 14\/09\/2028/)).toBeTruthy();
    expect(screen.getByText(/Công an Phường Hạnh Thông/)).toBeTruthy();
    expect(screen.queryByText(/lần nộp trước/)).toBeNull();
  });

  it('gấp các lần nộp cũ lại, mở ra xem được', () => {
    render(<RegistrationHistory registrations={[
      ho({ id: 'moi', subm_code: 'G01.899.909-260916-890028' }),
      ho({ id: 'cu', subm_code: 'G01.899.909-250101-111111', submitted_at: '2025-01-01T00:00:00.000Z', temp_resident_to: '2027-01-01' }),
    ]} />);
    expect(screen.queryByText('G01.899.909-250101-111111')).toBeNull();
    fireEvent.click(screen.getByText(/1 lần nộp trước/));
    expect(screen.getByText('G01.899.909-250101-111111')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Lịch sử đăng ký tạm trú' })).toBeTruthy();
  });
});

describe('RegistrationManualEntry', () => {
  it('chỉ cho lưu khi mã đúng dạng', () => {
    const onGhi = vi.fn();
    render(<RegistrationManualEntry onGhi={onGhi} />);
    fireEvent.click(screen.getByRole('button', { name: /ghi mã hồ sơ đã nộp/i }));
    const o = screen.getByLabelText('Mã hồ sơ đã nộp');
    fireEvent.change(o, { target: { value: 'abc' } });
    expect(screen.getByRole('button', { name: 'Lưu' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/không đúng dạng/i)).toBeTruthy();
    fireEvent.change(o, { target: { value: ' G01.899.909-260916-890028 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(onGhi).toHaveBeenCalledWith('G01.899.909-260916-890028');
  });
});
