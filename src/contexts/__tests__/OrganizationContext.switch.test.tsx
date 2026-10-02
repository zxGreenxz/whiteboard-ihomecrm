// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-demo' }, isLoading: false, isError: false }) }));
import { OrganizationProvider, useOrganization } from '../OrganizationContext';

// Màn đang mở có query mà khoá KHÔNG mang mã công ty (như ['profile', userId]).
// Đo 02/10/2026 trên production: chọn công ty ở /account/profile thì query này bị
// reset về pending/idle và không ai nạp lại ⇒ "Chưa tải được thông tin tài khoản".
function ManDangMo({ docBang }: { docBang: (org: string | null) => void }) {
  const { selectedOrganizationId, selectOrganization } = useOrganization();
  const hoSo = useQuery({
    queryKey: ['profile', 'user-demo'],
    queryFn: async () => { docBang(selectedOrganizationId); return { org: selectedOrganizationId }; },
    // Chỉ để phần dựng test bắt đầu từ "đã có dữ liệu công ty A".
    enabled: selectedOrganizationId !== null,
  });
  const tat = useQuery({ queryKey: ['chi-khi-mo-hop-thoai'], queryFn: async () => 'x', enabled: false });
  return <div>
    <p data-testid="ho-so">{hoSo.data ? `có:${hoSo.data.org}` : `${hoSo.status}/${hoSo.fetchStatus}`}</p>
    <p data-testid="tat">{tat.fetchStatus}</p>
    <button type="button" onClick={() => selectOrganization('org-b')}>Chọn B</button>
  </div>;
}

let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { organizations: [
    { id: 'org-a', name: 'Công ty A', slug: null, member_type: 'OWNER' },
    { id: 'org-b', name: 'Công ty B', slug: null, member_type: 'OWNER' },
  ] }, error: null });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => { cleanup(); client.clear(); });

it('đổi công ty nạp lại query đang hiển thị, và nạp bằng công ty MỚI', async () => {
  const docBang = vi.fn();
  render(<QueryClientProvider client={client}><OrganizationProvider><ManDangMo docBang={docBang} /></OrganizationProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId('ho-so').textContent).toBe('có:org-a'));
  docBang.mockClear();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Chọn B' })); });

  await waitFor(() => expect(screen.getByTestId('ho-so').textContent).toBe('có:org-b'));
  // Một lần nạp, và lần đó đã thấy công ty B: không có lượt nào đọc lại bằng A
  // rồi đặt dữ liệu công ty cũ dưới cùng khoá.
  expect(docBang.mock.calls).toEqual([['org-b']]);
  // Query đang tắt vẫn tắt: nạp lại không được vượt qua `enabled: false`.
  expect(screen.getByTestId('tat').textContent).toBe('idle');
});
