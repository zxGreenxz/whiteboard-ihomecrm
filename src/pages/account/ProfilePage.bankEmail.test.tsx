// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const disconnect = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-mobile', () => ({ usePhoneViewport: () => false }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/account/AccountOrganizationCard', () => ({ default: () => null }));
vi.mock('@/components/notifications/PushNotificationSettings', () => ({ default: () => null }));
vi.mock('@/components/notifications/NotificationPreferencesCard', () => ({ default: () => null }));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { full_name: 'TEST', email: 'test@example.test' }, isLoading: false, isError: false, status: 'success', fetchStatus: 'idle', refetch: vi.fn() }),
  useUpdateProfile: () => ({ mutate: vi.fn() }), useUploadAvatar: () => ({ mutate: vi.fn() }), useChangePassword: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/useBankEmail', () => ({
  useOwnedBankEmailConnections: () => ({ data: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@example.test', status: 'CONNECTED' }], isPending: false, isError: false, refetch: vi.fn() }),
  useDisconnectBankEmail: () => ({ mutateAsync: disconnect, isPending: false }),
}));

import ProfilePage from './ProfilePage';

it('lets the Gmail owner disconnect from their authenticated profile without business permissions', async () => {
  disconnect.mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'DISCONNECTED' });
  render(<ProfilePage />);
  fireEvent.click(screen.getByRole('button', { name: 'Ngắt Gmail ACB' }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
});
