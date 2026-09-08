// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CustomerAdministrativeAddress from '../CustomerAdministrativeAddress';

vi.mock('@/hooks/useAddressData', () => ({
  useProvinces: () => ({ provinces: [{ code: 1, name: 'Thành phố Hà Nội' }] }),
  useDistricts: () => ({ districts: [{ code: 5, name: 'Quận Cầu Giấy' }] }),
  useWards: () => ({ wards: [{ code: 175, name: 'Phường Trung Hoà' }] }),
}));
vi.mock('../AdministrativeAddressPreview', () => ({
  default: function SourcePreview({ address }: { address: string }) { return <output aria-label="Địa chỉ dùng để tra">{address}</output>; },
}));
beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe('CustomerAdministrativeAddress source selection', () => {
  it('defaults to permanent address and lets the user select the separate legacy address', () => {
    const props = { province: '1', district: '5', ward: '175', detailedAddress: '91 Trung Kính', permanentAddress: 'Địa chỉ thường trú khác' };
    const view = render(<CustomerAdministrativeAddress {...props} />);
    expect(screen.getByLabelText('Địa chỉ dùng để tra').textContent).toBe(props.permanentAddress);
    fireEvent.click(screen.getByRole('combobox', { name: 'Chọn địa chỉ cũ để chuyển đổi' }));
    fireEvent.click(screen.getByRole('option', { name: 'Địa chỉ theo tỉnh / quận / phường đã chọn' }));
    expect(screen.getByLabelText('Địa chỉ dùng để tra').textContent).toBe('91 Trung Kính, Phường Trung Hoà, Quận Cầu Giấy, Thành phố Hà Nội');
    view.rerender(<CustomerAdministrativeAddress {...props} detailedAddress="93 Trung Kính" />);
    expect(screen.getByLabelText('Địa chỉ dùng để tra').textContent).toBe('93 Trung Kính, Phường Trung Hoà, Quận Cầu Giấy, Thành phố Hà Nội');
  });
  it('uses resolved names, not numeric codes, when no permanent address is entered', () => {
    render(<CustomerAdministrativeAddress province="1" district="5" ward="175" detailedAddress="91 Trung Kính" />);
    expect(screen.getByLabelText('Địa chỉ dùng để tra').textContent).toBe('91 Trung Kính, Phường Trung Hoà, Quận Cầu Giấy, Thành phố Hà Nội');
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
