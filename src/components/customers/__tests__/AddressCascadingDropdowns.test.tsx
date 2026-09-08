// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import AddressCascadingDropdowns from '../AddressCascadingDropdowns';

const hookState = vi.hoisted(() => ({ provinceError: null as Error | null, retry: vi.fn() }));
vi.mock('@/hooks/useAddressData', () => ({
  useProvinces: () => ({ provinces: [{ code: 1, name: 'Thành phố Hà Nội' }, { code: 79, name: 'Thành phố Hồ Chí Minh' }], isLoading: false, error: hookState.provinceError, retry: hookState.retry }),
  useDistricts: () => ({ districts: [{ code: 760, name: 'Quận 1', province_code: 79 }], isLoading: false, error: null, retry: vi.fn() }),
  useWards: () => ({ wards: [{ code: 26734, name: 'Phường Bến Nghé', district_code: 760 }], isLoading: false, error: null, retry: vi.fn() }),
}));

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { value: () => false });
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => undefined });
});
afterEach(() => {
  cleanup();
  hookState.provinceError = null;
  hookState.retry.mockReset();
});

describe('AddressCascadingDropdowns', () => {
  it('searches without Vietnamese accents and resets descendants on province change', () => {
    const onProvinceChange = vi.fn();
    const onDistrictChange = vi.fn();
    const onWardChange = vi.fn();
    render(<AddressCascadingDropdowns provinceValue="79" districtValue="760" wardValue="26734" onProvinceChange={onProvinceChange} onDistrictChange={onDistrictChange} onWardChange={onWardChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Tỉnh/Thành phố' }));
    fireEvent.change(screen.getByPlaceholderText('Tìm tỉnh/thành phố...'), { target: { value: 'ha noi' } });
    fireEvent.click(screen.getByText('Thành phố Hà Nội'));

    expect(onProvinceChange).toHaveBeenCalledWith('1');
    expect(onDistrictChange).toHaveBeenCalledWith('');
    expect(onWardChange).toHaveBeenCalledWith('');
  });

  it('keeps an unknown saved code visible without inventing a label', () => {
    render(<AddressCascadingDropdowns provinceValue="legacy-HN" districtValue={null} wardValue={null} onProvinceChange={vi.fn()} onDistrictChange={vi.fn()} onWardChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Tỉnh/Thành phố' }).textContent).toContain('legacy-HN');
  });

  it('resets only the ward when the district changes', () => {
    const onDistrictChange = vi.fn();
    const onWardChange = vi.fn();
    render(<AddressCascadingDropdowns provinceValue="79" districtValue="760" wardValue="26734" onProvinceChange={vi.fn()} onDistrictChange={onDistrictChange} onWardChange={onWardChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Quận/Huyện' }));
    fireEvent.click(screen.getByRole('option', { name: 'Quận 1' }));

    expect(onDistrictChange).toHaveBeenCalledWith('760');
    expect(onWardChange).toHaveBeenCalledWith('');
  });

  it('announces which address level failed and retries that level', () => {
    hookState.provinceError = new Error('technical upstream detail');
    render(<AddressCascadingDropdowns provinceValue={null} districtValue={null} wardValue={null} onProvinceChange={vi.fn()} onDistrictChange={vi.fn()} onWardChange={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toContain('Không tải được tỉnh/thành phố.');
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tỉnh/thành phố' }));
    expect(hookState.retry).toHaveBeenCalledTimes(1);
  });
});
