// @vitest-environment jsdom
// Nút "Gán QL" trên chi tiết phiếu hoa hồng (20260927155251). Hộp gán render qua portal
// nên fieldset khoá nút của tấm phiếu không chạm tới nó: chi tiết phiếu đọc lại (realtime,
// Thử lại — chủ chốt 30/09/2026 giữ nội dung, khoá nút) thì hộp phải tự đóng.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCommissionManager', () => ({
  useAssignCommissionManager: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../QlManagerSelect', () => ({ QlManagerSelect: () => <div>chon-quan-ly</div> }));

import { CommissionManagerAction } from '../CommissionManagerAction';

const phieuHoaHong = {
  id: 'v1', type: 'EXPENSE', approval_status: 'UNAPPROVED', approval_version: 1, organization_id: 'o1',
  posting_status: 'UNPOSTED', system_source: null, account_name: 'TM', account_is_virtual: false,
  items: [{ type_name: 'Hoa hồng 303/44TL', category: 'HOA HỒNG' }],
};
const khung = (locked: boolean) => (
  <CommissionManagerAction voucher={phieuHoaHong} row={(label, value) => <div><span>{label}</span>{value}</div>} locked={locked} />
);

afterEach(cleanup);

describe('Gán QL nhận hoa hồng khi chi tiết phiếu đang đọc lại', () => {
  it('phiếu đọc lại (locked) ⇒ hộp gán đóng, bản mới về cũng không tự mở lại', () => {
    const view = render(khung(false));
    fireEvent.click(screen.getByTestId('ie-assign-commission-manager'));
    expect(screen.getByText('Gán quản lý nhận hoa hồng')).toBeTruthy();
    view.rerender(khung(true));
    expect(screen.queryByText('Gán quản lý nhận hoa hồng')).toBeNull();
    view.rerender(khung(false));
    expect(screen.queryByText('Gán quản lý nhận hoa hồng')).toBeNull();
  });
});
