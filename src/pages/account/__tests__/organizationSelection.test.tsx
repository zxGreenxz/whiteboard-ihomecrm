// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AccountOrganizationCard from '@/components/account/AccountOrganizationCard';
import { OrganizationProvider, useOrganization } from '@/contexts/OrganizationContext';

const fixture = vi.hoisted(() => ({
  phone: false,
  user: { id: 'demo-user' } as { id: string } | null,
  rpc: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: fixture.rpc } }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ data: fixture.user, isLoading: false, isError: false }),
}));

const storageKey = 'ihomecrm.selectedOrganizationId';
const companyA = { id: 'dddd0000-0000-4000-8000-000000000001', name: 'Công ty DEMO A' };
const companyB = { id: 'dddd0000-0000-4000-8000-000000000002', name: 'Công ty DEMO B' };
const response = (organizations = [companyA, companyB]) => ({ data: { organizations }, error: null });
const clients: QueryClient[] = [];

function ScopeConsumer() {
  const { selectedOrganizationId } = useOrganization();
  return <output data-testid="selected-scope">{selectedOrganizationId ?? 'none'}</output>;
}
function mountAccount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <OrganizationProvider><AccountOrganizationCard variant={fixture.phone ? 'mobile' : 'desktop'} /><ScopeConsumer /></OrganizationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function chooseCompany(company: typeof companyA) {
  const dropdown = await screen.findByTestId('account-organization-select');
  await waitFor(() => expect(dropdown.hasAttribute('disabled')).toBe(false));
  fireEvent.change(dropdown, { target: { value: company.id } });
}

beforeEach(() => {
  localStorage.clear();
  fixture.phone = false;
  fixture.user = { id: 'demo-user' };
  fixture.rpc.mockReset().mockResolvedValue(response());
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

// Browser fixture checks actual dropdown interactions on BOTH account pages.
// Here the native mobile control exercises the shared provider and persistence.
describe('Lưu lựa chọn công ty', () => {
  it('lưu ngay, phục hồi sau khi mở lại và cập nhật cùng phạm vi Copilot khi đổi công ty', async () => {
    fixture.phone = true;
    const first = mountAccount();
    await chooseCompany(companyB);
    expect(localStorage.getItem(storageKey)).toBe(companyB.id);
    expect(screen.getByTestId('selected-scope').textContent).toBe(companyB.id);
    // Chọn công ty không cần ghi hồ sơ lên máy chủ.
    expect(fixture.rpc.mock.calls.every(([name]) => name === 'list_my_copilot_organizations_v1')).toBe(true);

    first.unmount();
    mountAccount(); // QueryClient mới: đọc lại lựa chọn từ trình duyệt
    await waitFor(() => expect(screen.getByTestId('selected-scope').textContent).toBe(companyB.id));
    const dropdown = screen.getByRole('combobox', { name: 'Công ty đang chọn' });
    expect((dropdown as HTMLSelectElement).value).toBe(companyB.id);
    await chooseCompany(companyA);
    expect(screen.getByTestId('selected-scope').textContent).toBe(companyA.id);
    expect(localStorage.getItem(storageKey)).toBe(companyA.id);
  });
});

it('giữ lựa chọn khi tải lỗi, rồi khôi phục sau khi thử lại', async () => {
  localStorage.setItem(storageKey, companyB.id);
  fixture.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });
  mountAccount();
  expect((await screen.findByRole('alert')).textContent).toContain('Lựa chọn đã lưu vẫn được giữ lại');
  expect(localStorage.getItem(storageKey)).toBe(companyB.id);
  expect(screen.getByTestId('selected-scope').textContent).toBe('none');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.getByTestId('selected-scope').textContent).toBe(companyB.id));
});

it('đăng xuất không xoá lựa chọn và không gọi danh bạ chưa đăng nhập', async () => {
  localStorage.setItem(storageKey, companyB.id);
  fixture.user = null;
  mountAccount();
  await screen.findByTestId('account-organization-card');
  expect(localStorage.getItem(storageKey)).toBe(companyB.id);
  expect(fixture.rpc).not.toHaveBeenCalled();
});

it('lưu công ty duy nhất để sau khi có thêm công ty vẫn giữ lựa chọn', async () => {
  fixture.rpc.mockResolvedValueOnce(response([companyB]));
  const first = mountAccount();
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBe(companyB.id));
  first.unmount();
  mountAccount();
  await waitFor(() => expect(screen.getByTestId('selected-scope').textContent).toBe(companyB.id));
});

it('không dùng công ty đã mất quyền và không tự chọn công ty đầu khi có nhiều công ty', async () => {
  localStorage.setItem(storageKey, 'company-removed');
  mountAccount();
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
  expect(screen.getByTestId('selected-scope').textContent).toBe('none');
  expect(screen.getByRole('combobox', { name: 'Công ty đang chọn' }).textContent).toContain('Chọn công ty');
});

it('danh bạ rỗng hiện hướng dẫn cấp quyền, không giả làm lỗi mạng', async () => {
  fixture.rpc.mockResolvedValue(response([]));
  mountAccount();
  await screen.findByText(/Tài khoản chưa có công ty khả dụng/);
  expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Công ty đang chọn' }).hasAttribute('disabled')).toBe(true);
});
