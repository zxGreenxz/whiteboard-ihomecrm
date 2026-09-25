// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const fixture = vi.hoisted(() => ({
  owner: true,
  superAdmin: false,
  settings: {
    data: undefined as unknown,
    isError: false,
    error: null as unknown,
    refetch: () => Promise.resolve(),
  },
  settingsCalls: [] as unknown[][],
  savePersonal: vi.fn(),
  saveBuilding: vi.fn(),
}));

// Radix Select thật; jsdom không có hình học cho Floating UI nên trải danh sách tại chỗ.
vi.mock('@/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return {
    ...actual,
    SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => (
      <actual.SelectContent {...props} position="item-aligned" />
    ),
  };
});
// Popover giả, mở/đóng tại chỗ. Radix Popover thật luôn định vị bằng Floating UI;
// đo 25/09/2026: chỉ cần MỞ nó một lần trong jsdom là luồng test bận thêm ~15 giây
// SAU khi ca kết thúc (các ca kế tiếp, kể cả ca rỗng, chậm theo) — cùng lý do
// SelectContent ở trên phải trải tại chỗ. Thứ cần kiểm ở đây là danh sách sổ phụ
// và dữ liệu gửi đi, không phải cách Radix định vị.
vi.mock('@/components/ui/popover', async () => {
  const { createContext, cloneElement, useContext, useState } = await import('react');
  const Mo = createContext<{ mo: boolean; datMo: (v: boolean) => void }>({ mo: false, datMo: () => {} });
  return {
    Popover: ({ children }: { children: React.ReactNode }) => {
      const [mo, datMo] = useState(false);
      return <Mo.Provider value={{ mo, datMo }}>{children}</Mo.Provider>;
    },
    PopoverTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
      const { mo, datMo } = useContext(Mo);
      return cloneElement(children, { onClick: () => datMo(!mo) });
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const { mo } = useContext(Mo);
      return mo ? <div role="dialog">{children}</div> : null;
    },
  };
});
vi.mock('@/hooks/useIsCompanyOwner', () => ({
  useIsCompanyOwner: () => ({ data: fixture.owner, isLoading: false }),
}));
vi.mock('@/hooks/useIsAdmin', () => ({
  useIsAdmin: () => ({ data: false, isLoading: false }),
  useIsSuperAdmin: () => ({ data: fixture.superAdmin, isLoading: false }),
}));
vi.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganizationId: 'org-demo', isLoading: false, isOrphan: false }),
}));
vi.mock('@/hooks/useReceivingCashbooks', () => ({
  useReceivingCashbookSettings: (...args: unknown[]) => {
    fixture.settingsCalls.push(args);
    return fixture.settings;
  },
  useSetPersonalCashBook: () => ({ mutate: fixture.savePersonal, isPending: false, variables: undefined }),
  useSetBuildingReceivingCashbooks: () => ({ mutate: fixture.saveBuilding, isPending: false }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: new Proxy({}, { get() { throw new Error('Test này không được gọi máy chủ'); } }),
}));

import ReceivingCashbookSettings from '../ReceivingCashbookSettings';
import type { ReceivingSettings } from '@/hooks/useReceivingCashbooks';

const duLieu = (): ReceivingSettings => ({
  members: [
    { membershipId: 'm-nathan', userId: 'u-nathan', name: 'NATHAN', memberType: 'STAFF', personalCashBook: { id: 'acc-hiep-thu', name: 'Hiệp Thu' } },
    { membershipId: 'm-joey', userId: 'u-joey', name: 'JOEY', memberType: 'STAFF', personalCashBook: null },
    { membershipId: 'm-chu', userId: 'u-chu', name: 'Chủ công ty', memberType: 'OWNER', personalCashBook: null },
  ],
  buildings: [
    {
      id: 'b-102',
      name: '102LVT',
      TK: { defaultAccountId: 'acc-mbhiep', extraAccountIds: ['acc-tkhiep'] },
      TT: { defaultAccountId: null, extraAccountIds: [] },
    },
  ],
  accounts: [
    { id: 'acc-cgiang', name: 'CGIANG8818', custodianMembershipIds: ['m-joey'] },
    { id: 'acc-hien-thu', name: 'Hiển Thu', custodianMembershipIds: ['m-joey'] },
    { id: 'acc-hiep-thu', name: 'Hiệp Thu', custodianMembershipIds: ['m-nathan'] },
    { id: 'acc-mbhiep', name: 'MBHIEP', custodianMembershipIds: ['m-nathan'] },
    { id: 'acc-tkhiep', name: 'TKHIEP', custodianMembershipIds: ['m-nathan'] },
  ],
});

const moSelect = (name: string, trong: HTMLElement = document.body) =>
  fireEvent.keyDown(within(trong).getByRole('combobox', { name }), { key: 'ArrowDown' });
const cacLuaChon = () => screen.getAllByRole('option').map((o) => o.textContent);
const chon = (name: string) => fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' });

beforeEach(() => {
  fixture.owner = true;
  fixture.superAdmin = false;
  fixture.settings = { data: duLieu(), isError: false, error: null, refetch: () => Promise.resolve() };
  fixture.settingsCalls = [];
  fixture.savePersonal.mockReset();
  fixture.saveBuilding.mockReset();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Quyền xem màn Sổ nhận tiền', () => {
  it('người không phải chủ công ty chỉ thấy dòng báo không có quyền, và không hỏi máy chủ', () => {
    fixture.owner = false;
    render(<ReceivingCashbookSettings />);
    expect(screen.getByText('Không có quyền cài sổ nhận tiền')).toBeTruthy();
    expect(screen.queryByText('Sổ tiền mặt riêng')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(fixture.settingsCalls.at(-1)).toEqual(['org-demo', false]);
  });

  it('super admin (không phải chủ) vẫn mở được màn cài', () => {
    fixture.owner = false;
    fixture.superAdmin = true;
    render(<ReceivingCashbookSettings />);
    expect(screen.getByText('Sổ tiền mặt riêng')).toBeTruthy();
    expect(fixture.settingsCalls.at(-1)).toEqual(['org-demo', true]);
  });

  it('máy chủ từ chối thì hiện đúng câu lỗi của máy chủ', () => {
    fixture.settings = {
      data: undefined,
      isError: true,
      error: { message: 'Chỉ chủ công ty cài được sổ nhận tiền' },
      refetch: () => Promise.resolve(),
    };
    render(<ReceivingCashbookSettings />);
    expect(screen.getByText('Không tải được sổ nhận tiền')).toBeTruthy();
    expect(screen.getByText('Chỉ chủ công ty cài được sổ nhận tiền')).toBeTruthy();
  });
});

describe('Sổ tiền mặt riêng', () => {
  it('chỉ liệt kê sổ người đó đang giữ, đổi là lưu ngay đúng tham số', () => {
    render(<ReceivingCashbookSettings />);
    moSelect('Sổ tiền mặt riêng của NATHAN');
    expect(cacLuaChon()).toEqual(['Chưa cài', 'Hiệp Thu', 'MBHIEP', 'TKHIEP']);
    chon('TKHIEP');
    expect(fixture.savePersonal).toHaveBeenCalledTimes(1);
    expect(fixture.savePersonal).toHaveBeenCalledWith({ membershipId: 'm-nathan', accountId: 'acc-tkhiep' });

    moSelect('Sổ tiền mặt riêng của JOEY');
    expect(cacLuaChon()).toEqual(['Chưa cài', 'CGIANG8818', 'Hiển Thu']);
  });

  it('"Chưa cài" gỡ sổ (null); người không giữ sổ nào thì khoá ô chọn', () => {
    render(<ReceivingCashbookSettings />);
    moSelect('Sổ tiền mặt riêng của NATHAN');
    chon('Chưa cài');
    expect(fixture.savePersonal).toHaveBeenCalledWith({ membershipId: 'm-nathan', accountId: null });

    const chu = screen.getByRole('combobox', { name: 'Sổ tiền mặt riêng của Chủ công ty' }) as HTMLButtonElement;
    expect(chu.disabled).toBe(true);
    expect(screen.getByText(/Chưa giữ sổ nào/)).toBeTruthy();
  });

  it('sổ đang cài mà người đó không còn giữ thì vẫn hiện và báo phải chọn lại', () => {
    const data = duLieu();
    data.members[0]!.personalCashBook = { id: 'acc-hien-thu', name: 'Hiển Thu' };
    fixture.settings = { ...fixture.settings, data };
    render(<ReceivingCashbookSettings />);
    expect(screen.getByRole('combobox', { name: 'Sổ tiền mặt riêng của NATHAN' }).textContent).toContain('Hiển Thu');
    expect(screen.getByText(/Người này không còn giữ sổ "Hiển Thu"/)).toBeTruthy();
  });
});

describe('Chuyển khoản / Thanh toán theo toà', () => {
  it('sổ phụ không trùng sổ mặc định; Lưu gửi đúng toà + hình thức + danh sách', () => {
    render(<ReceivingCashbookSettings />);
    const toa = screen.getByRole('region', { name: 'Toà 102LVT' });
    const luu = within(toa).getByRole('button', { name: 'Lưu Chuyển khoản — toà 102LVT' }) as HTMLButtonElement;
    const soPhu = within(toa).getByRole('button', { name: 'Sổ phụ Chuyển khoản — toà 102LVT' });
    expect(luu.disabled).toBe(true); // chưa đổi gì thì chưa cho lưu
    expect(soPhu.textContent).toContain('TKHIEP');

    // TKHIEP đang là sổ phụ ⇒ chọn làm mặc định thì tự rời danh sách phụ.
    moSelect('Sổ mặc định Chuyển khoản — toà 102LVT', toa);
    chon('TKHIEP');
    expect(soPhu.textContent).toContain('Chưa có sổ phụ');

    fireEvent.click(soPhu);
    const dsPhu = screen.getAllByRole('checkbox').map((o) => o.closest('label')?.textContent);
    expect(dsPhu).toEqual(['CGIANG8818', 'Hiển Thu', 'Hiệp Thu', 'MBHIEP']); // không có sổ mặc định TKHIEP
    fireEvent.click(screen.getByRole('checkbox', { name: 'CGIANG8818' }));
    fireEvent.click(soPhu); // đóng danh sách
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(soPhu.textContent).toContain('CGIANG8818');

    expect(luu.disabled).toBe(false);
    fireEvent.click(luu);
    expect(fixture.saveBuilding).toHaveBeenCalledTimes(1);
    expect(fixture.saveBuilding).toHaveBeenCalledWith(
      { buildingId: 'b-102', method: 'TK', defaultAccountId: 'acc-tkhiep', extraAccountIds: ['acc-cgiang'] },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('bỏ sổ mặc định (Chưa cài) của Thanh toán gửi null, không đụng Chuyển khoản', () => {
    const data = duLieu();
    data.buildings[0]!.TT = { defaultAccountId: 'acc-mbhiep', extraAccountIds: [] };
    fixture.settings = { ...fixture.settings, data };
    render(<ReceivingCashbookSettings />);
    const toa = screen.getByRole('region', { name: 'Toà 102LVT' });
    moSelect('Sổ mặc định Thanh toán — toà 102LVT', toa);
    chon('Chưa cài');
    fireEvent.click(within(toa).getByRole('button', { name: 'Lưu Thanh toán — toà 102LVT' }));
    expect(fixture.saveBuilding).toHaveBeenCalledTimes(1);
    expect(fixture.saveBuilding.mock.calls[0]![0]).toEqual({
      buildingId: 'b-102',
      method: 'TT',
      defaultAccountId: null,
      extraAccountIds: [],
    });
  });
});
